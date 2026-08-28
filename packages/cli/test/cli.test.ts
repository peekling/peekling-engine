import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  createPack,
  importCodexPet,
  packAuthoringSource,
  validatePackDirectory,
} from "../dist/index.js";
import { atomicDirectory } from "../dist/atomic-directory.js";
import { runDoctor } from "../dist/doctor.js";
import { createFixtureAtlas, inspectPng } from "../dist/png.js";

const execute = promisify(execFile);

async function temporary(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "peekling-cli-test-"));
}

function fakeWebp(): Buffer {
  const value = Buffer.alloc(48);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(40, 4);
  value.write("WEBP", 8, "ascii");
  value.write("VP8X", 12, "ascii");
  value.writeUInt32LE(10, 16);
  value[20] = 0x10;
  value.writeUIntLE(1535, 24, 3);
  value.writeUIntLE(2287, 27, 3);
  value.write("VP8 ", 30, "ascii");
  value.writeUInt32LE(10, 34);
  value.set([0x9d, 0x01, 0x2a], 41);
  value.writeUInt16LE(1536, 44);
  value.writeUInt16LE(2288, 46);
  return value;
}

function zip(entries: Record<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const checksum = crc32(value);
    const fileName = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(value.length, 18);
    header.writeUInt32LE(value.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, value);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(value.length, 20);
    directory.writeUInt32LE(value.length, 24);
    directory.writeUInt16LE(fileName.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, fileName);
    offset += header.length + fileName.length + value.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function incompleteIndexedPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("PLTE", Buffer.from([0, 0, 0])),
    pngChunk("tRNS", Buffer.from([0])),
    pngChunk("IEND"),
  ]);
}

function undecodableIndexedPng(width: number, height: number): Buffer {
  const withoutEnd = incompleteIndexedPng(width, height).subarray(0, -12);
  return Buffer.concat([
    withoutEnd,
    pngChunk("IDAT", Buffer.from([0x78, 0x01, 0xff, 0xff])),
    pngChunk("IEND"),
  ]);
}

function onePixelRgbaPng(imageData: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", imageData),
    pngChunk("IEND"),
  ]);
}

function pngWithExtraDecodedBytes(): Buffer {
  return onePixelRgbaPng(deflateSync(Buffer.alloc(6)));
}

function pngWithTrailingCompressedBytes(): Buffer {
  return onePixelRgbaPng(
    Buffer.concat([deflateSync(Buffer.alloc(5)), Buffer.from([1, 2, 3, 4])]),
  );
}

function withoutPngChunk(buffer: Buffer, excluded: string): Buffer {
  const parts = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + length + 12;
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type !== excluded) parts.push(buffer.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}

function corruptChunkCrc(buffer: Buffer, target: string): Buffer {
  const output = Buffer.from(buffer);
  let offset = 8;
  while (offset + 12 <= output.length) {
    const length = output.readUInt32BE(offset);
    const end = offset + length + 12;
    const type = output.toString("ascii", offset + 4, offset + 8);
    if (type === target) {
      output[end - 1] = output[end - 1]! ^ 1;
      return output;
    }
    offset = end;
  }
  throw new Error(`Missing PNG chunk ${target}`);
}

test("create produces a working native pack and refuses overwrite", async () => {
  const root = await temporary();
  try {
    const target = path.join(root, "fixture");
    await createPack(target, "fixture");
    const result = await validatePackDirectory(target);
    assert.equal(result.name, "fixture");
    assert.equal(result.atlas.width, 512);
    assert.equal(result.states, 17);
    assert.match(
      await readFile(path.join(target, "PROVENANCE.md"), "utf8"),
      /development placeholder/i,
    );
    await assert.rejects(() => createPack(target, "fixture"), /overwrite/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "create refuses a dangling symbolic-link output path",
  { skip: process.platform === "win32" },
  async () => {
    const root = await temporary();
    try {
      const target = path.join(root, "fixture");
      await symlink(path.join(root, "missing"), target);

      await assert.rejects(() => createPack(target, "fixture"), /overwrite/);
      assert.equal((await lstat(target)).isSymbolicLink(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("create rechecks the output path immediately before publication", async () => {
  const root = await temporary();
  const target = path.join(root, "fixture");
  let writerReady!: () => void;
  let releaseWriter!: () => void;
  const ready = new Promise<void>((resolve) => {
    writerReady = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });

  const publication = atomicDirectory(target, async (temp) => {
    await writeFile(path.join(temp, "complete"), "ready");
    writerReady();
    await released;
  });
  try {
    await ready;
    await mkdir(target);
    releaseWriter();
    await assert.rejects(publication, /overwrite/);
    assert.deepEqual(await readdir(target), []);
  } finally {
    releaseWriter();
    await rm(root, { recursive: true, force: true });
  }
});

test("validate rejects executable pack content with an actionable path", async () => {
  const root = await temporary();
  try {
    const target = path.join(root, "fixture");
    await createPack(target, "fixture");
    await writeFile(
      path.join(target, "payload.js"),
      "throw new Error('never run')",
    );
    await assert.rejects(() => validatePackDirectory(target), /payload\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create is byte-reproducible and failed targets leave no temp output", async () => {
  const root = await temporary();
  try {
    const first = path.join(root, "first pack");
    const second = path.join(root, "second pack");
    await createPack(first, "fixture");
    await createPack(second, "fixture");
    for (const name of [
      "character.json",
      "atlas.png",
      "LICENSE",
      "PROVENANCE.md",
    ])
      assert.deepEqual(
        await readFile(path.join(first, name)),
        await readFile(path.join(second, name)),
        name,
      );
    await assert.rejects(
      () => createPack(path.join(root, "bad"), "../bad"),
      /Pack name/,
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith(".peekling-")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation rejects symlinked roots, resources, and overfull packs", async () => {
  const root = await temporary();
  try {
    const target = path.join(root, "fixture");
    await createPack(target, "fixture");
    await symlink(target, path.join(root, "linked"));
    await assert.rejects(
      () => validatePackDirectory(path.join(root, "linked")),
      /not a link/,
    );
    await rm(path.join(target, "atlas.png"));
    await symlink(
      path.join(root, "outside.png"),
      path.join(target, "atlas.png"),
    );
    await writeFile(path.join(root, "outside.png"), Buffer.alloc(32));
    await assert.rejects(() => validatePackDirectory(target), /symbolic links/);
    await rm(path.join(target, "atlas.png"));
    await writeFile(path.join(target, "atlas.png"), Buffer.alloc(32));
    for (let index = 0; index < 30; index++)
      await writeFile(path.join(target, `extra-${index}.txt`), "x");
    await assert.rejects(() => validatePackDirectory(target), /file-count/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex import preserves source data, adds provenance, and skips code", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    await mkdir(source);
    const pet = Buffer.from('{"spriteVersionNumber":2,"name":"fixture"}\n');
    const atlas = fakeWebp();
    await writeFile(path.join(source, "pet.json"), pet);
    await writeFile(path.join(source, "spritesheet.webp"), atlas);
    await writeFile(
      path.join(source, "payload.js"),
      "globalThis.compromised = true",
    );
    await importCodexPet(source, output, {
      license: "CC-BY-4.0",
      author: "Fixture Author",
      source: "Fixture bundle",
      rights: "Original fixture created for tests",
    });
    assert.deepEqual(await readFile(path.join(output, "pet.json")), pet);
    assert.deepEqual(
      await readFile(path.join(output, "spritesheet.webp")),
      atlas,
    );
    await assert.rejects(
      () => readFile(path.join(output, "payload.js")),
      /ENOENT/,
    );
    const sidecar = JSON.parse(
      await readFile(path.join(output, "peekling.json"), "utf8"),
    );
    assert.equal(sidecar.provenance.author, "Fixture Author");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex import rejects pet.json that is not valid UTF-8", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "pet.json"),
      Buffer.concat([
        Buffer.from('{"spriteVersionNumber":2,"ignored":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}\n'),
      ]),
    );
    await writeFile(path.join(source, "spritesheet.webp"), fakeWebp());

    await assert.rejects(
      () =>
        importCodexPet(source, path.join(root, "output"), {
          license: "CC0-1.0",
          author: "Fixture Author",
          source: "Fixture bundle",
          rights: "Original fixture created for tests",
        }),
      /pet\.json must be valid UTF-8/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex archive import preserves the original archive unchanged", async () => {
  const root = await temporary();
  try {
    const input = path.join(root, "fixture.codex-pet");
    const output = path.join(root, "output");
    const archive = zip({
      "pet.json": Buffer.from(
        '{"spriteVersionNumber":2,"name":"archive-fixture"}',
      ),
      "spritesheet.webp": fakeWebp(),
      LICENSE: Buffer.from("CC0-1.0\n"),
      "ignored-script.js": Buffer.from("throw new Error('never extracted')"),
    });
    await writeFile(input, archive);
    await importCodexPet(input, output, {
      license: "CC0-1.0",
      author: "Archive fixture author",
      source: "Generated archive fixture",
      rights: "Original fixture created for tests",
    });
    assert.deepEqual(
      await readFile(path.join(output, "source.codex-pet")),
      archive,
    );
    await assert.rejects(
      () => readFile(path.join(output, "ignored-script.js")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex archives reject duplicate, unsafe, and corrupt entries", async () => {
  const root = await temporary();
  try {
    const metadata = {
      license: "CC0-1.0",
      author: "A",
      source: "S",
      rights: "R",
    };
    for (const [name, archive, expected] of [
      ["unsafe", zip({ "../pet.json": Buffer.from("{}") }), /Unsafe ZIP entry/],
      ["windows", zip({ "C:pet.json": Buffer.from("{}") }), /Unsafe ZIP entry/],
    ] as const) {
      const input = path.join(root, `${name}.codex-pet`);
      await writeFile(input, archive);
      await assert.rejects(
        () => importCodexPet(input, path.join(root, `${name}-out`), metadata),
        expected,
      );
    }
    const corrupt = zip({
      "pet.json": Buffer.from('{"spriteVersionNumber":2}'),
      "spritesheet.webp": fakeWebp(),
    });
    corrupt[corrupt.indexOf(Buffer.from("pet.json")) + "pet.json".length] ^= 1;
    const input = path.join(root, "corrupt.codex-pet");
    await writeFile(input, corrupt);
    await assert.rejects(
      () => importCodexPet(input, path.join(root, "corrupt-out"), metadata),
      /checksum|headers|JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reports actionable missing metadata", async () => {
  await assert.rejects(
    () =>
      execute(
        process.execPath,
        [
          "packages/cli/dist/bin.js",
          "import",
          "codex",
          "missing",
          "--out",
          "out",
        ],
        {
          cwd: new URL("../../..", import.meta.url),
        },
      ),
    /--license/,
  );
});

test("doctor rejects flags whose values are missing or another flag", async () => {
  const root = await temporary();
  try {
    const configuration = path.join(root, "peekling.json");
    await writeFile(configuration, "{}\n");
    for (const suffix of [["--pack"], ["--pack", "--json"]]) {
      await assert.rejects(
        () =>
          execute(
            process.execPath,
            ["packages/cli/dist/bin.js", "doctor", configuration, ...suffix],
            { cwd: new URL("../../..", import.meta.url) },
          ),
        /--pack requires a value/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rejects unknown flags and unexpected positional arguments", async () => {
  const root = await temporary();
  try {
    const configuration = path.join(root, "peekling.json");
    await writeFile(configuration, "{}\n");
    for (const [args, expected] of [
      [["doctor", configuration, "--unknown"], /Unknown option --unknown/],
      [
        ["doctor", configuration, "extra.json"],
        /Unexpected positional argument extra\.json/,
      ],
      [["validate", root, "--json"], /Unknown option --json/],
    ] as const) {
      await assert.rejects(
        () =>
          execute(process.execPath, ["packages/cli/dist/bin.js", ...args], {
            cwd: new URL("../../..", import.meta.url),
          }),
        expected,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor treats __proto__ as own JSON data instead of inherited configuration", async () => {
  const root = await temporary();
  try {
    const configuration = path.join(root, "peekling.json");
    await writeFile(configuration, '{"__proto__":{"scale":9}}\n');

    const result = await runDoctor(configuration, { json: true });

    assert.equal(result.exitCode, 1);
    assert.equal(result.report.valid, false);
    assert.ok(
      result.report.errors.some(
        (issue) =>
          issue.code === "unknown-field" && issue.path === "$.__proto__",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor rejects configuration JSON that is not valid UTF-8", async () => {
  const root = await temporary();
  try {
    const configuration = path.join(root, "peekling.json");
    await writeFile(
      configuration,
      Buffer.concat([
        Buffer.from('{"packUrl":"https://example.com/'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}\n'),
      ]),
    );

    const result = await runDoctor(configuration, { json: true });

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /configuration input must be valid UTF-8/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Doctor rejects a symbolic-link input instead of following it",
  { skip: process.platform === "win32" },
  async () => {
    const root = await temporary();
    try {
      const target = path.join(root, "target.json");
      const linked = path.join(root, "linked.json");
      await writeFile(target, "{}\n");
      await symlink(target, linked);

      const result = await runDoctor(linked, { json: true });

      assert.equal(result.exitCode, 1);
      assert.match(result.output, /symbolic link/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("indexed PNG alpha requires a real tRNS chunk", () => {
  assert.equal(
    inspectPng(withoutPngChunk(createFixtureAtlas(1), "tRNS")).hasAlpha,
    false,
  );
});

test("PNG inspection verifies CRC, complete chunks, and decodability", () => {
  const valid = createFixtureAtlas(1);
  assert.doesNotThrow(() => inspectPng(valid));
  assert.throws(
    () => inspectPng(corruptChunkCrc(valid, "IDAT")),
    /CRC|checksum|decod/i,
  );
  assert.throws(
    () => inspectPng(incompleteIndexedPng(512, 32)),
    /IDAT|complete|decod/i,
  );
  assert.throws(() => inspectPng(undecodableIndexedPng(512, 32)), /decod/i);
  assert.throws(
    () => inspectPng(valid.subarray(0, valid.length - 1)),
    /truncated|IEND|complete/i,
  );
});

test("PNG inspection rejects decompressed bytes beyond the image", () => {
  assert.throws(() => inspectPng(pngWithExtraDecodedBytes()), /decod/i);
});

test("PNG inspection rejects bytes after the compressed stream", () => {
  assert.throws(() => inspectPng(pngWithTrailingCompressedBytes()), /decod/i);
});

test("Pack validation never certifies an incomplete PNG atlas", async () => {
  const root = await temporary();
  try {
    const target = path.join(root, "fixture");
    await createPack(target, "fixture");
    await writeFile(
      path.join(target, "atlas.png"),
      incompleteIndexedPng(512, 96),
    );
    await assert.rejects(
      () => validatePackDirectory(target),
      /IDAT|complete|decod/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pack compiles row-authored named frames into deterministic dense cells", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "compiled");
    await mkdir(source);
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const states = Object.fromEntries([
      [
        "idle",
        {
          row: 0,
          frames: ["idle-a", "idle-b"],
          loop: true,
          durations: [700, 200],
        },
      ],
      ...directions.map((direction, index) => [
        `move:${direction}`,
        {
          row: index + 1,
          frames: [
            `run-${direction.toLowerCase()}-a`,
            `run-${direction.toLowerCase()}-b`,
          ],
          loop: true,
          fps: 6,
        },
      ]),
    ]);
    await writeFile(
      path.join(source, "source.json"),
      JSON.stringify({
        format: 1,
        name: "compiled-fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        metadata: {
          description: "A synthetic compiler test character.",
        },
        logicalCellSize: 32,
        lineage: "compiled-fixture-v1",
        sources: [{ density: 1, sheet: "source-1x.png", columns: 16, rows: 9 }],
        states,
        capabilities: {
          locomotion: {
            directions: Object.fromEntries(
              directions.map((direction) => [direction, `move:${direction}`]),
            ),
            motion: {
              keyframes: [
                { at: 0, advance: 0, lift: 0 },
                { at: 0.5, advance: 0.8, lift: 0.2 },
                { at: 1, advance: 1, lift: 0 },
              ],
            },
          },
        },
      }),
    );
    await writeFile(path.join(source, "source-1x.png"), createFixtureAtlas(9));
    await writeFile(path.join(source, "LICENSE"), "CC0-1.0\n");
    await writeFile(
      path.join(source, "PROVENANCE.md"),
      "# Generated test fixture\n",
    );
    await packAuthoringSource(source, output);
    const manifest = JSON.parse(
      await readFile(path.join(output, "character.json"), "utf8"),
    );
    assert.deepEqual(manifest.states.idle.frames, [0, 1]);
    assert.deepEqual(manifest.states["move:N"].frames, [2, 3]);
    assert.equal(manifest.capabilities.locomotion.directions.N, "move:N");
    assert.equal(manifest.capabilities.locomotion.motion.keyframes.length, 3);
    assert.equal(manifest.assets.atlases.rows, 2);
    assert.deepEqual(manifest.states.idle.durations, [700, 200]);
    assert.equal((await validatePackDirectory(output)).states, 9);
    await assert.rejects(
      () => packAuthoringSource(source, output),
      /overwrite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pack authoring confines source paths and rejects unsafe limits before allocation", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    const base = {
      name: "hostile-fixture",
      version: "0.1.0",
      license: "CC0-1.0",
      logicalCellSize: 32,
      sources: [{ density: 1, sheet: "sheet.png", columns: 16, rows: 3 }],
      states: {
        idle: { row: 0, frames: ["idle"], loop: true, fps: 1 },
      },
    };
    const writeSource = (value: unknown) =>
      writeFile(path.join(source, "source.json"), JSON.stringify(value));

    await writeSource({
      ...base,
      sources: [{ density: 1, sheet: "../escape.png", columns: 16, rows: 3 }],
    });
    await assert.rejects(
      () => packAuthoringSource(source, path.join(root, "traversal")),
      /confined relative path/,
    );

    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "sheet.png"), createFixtureAtlas());
    await symlink(outside, path.join(source, "linked"), "dir");
    await writeSource({
      ...base,
      sources: [
        {
          density: 1,
          sheet: "linked/sheet.png",
          columns: 16,
          rows: 3,
        },
      ],
    });
    await assert.rejects(
      () => packAuthoringSource(source, path.join(root, "symlink")),
      /escapes the source directory/,
    );

    await writeSource({
      ...base,
      states: {
        idle: {
          row: 0,
          frames: Array.from({ length: 65 }, (_, index) => `frame-${index}`),
          loop: true,
          fps: 1,
        },
      },
    });
    await assert.rejects(
      () => packAuthoringSource(source, path.join(root, "overfull")),
      /frames must contain safe stable names/,
    );

    await writeSource({
      ...base,
      sources: [{ density: 1, sheet: "sheet.png", columns: 65, rows: 3 }],
    });
    await assert.rejects(
      () => packAuthoringSource(source, path.join(root, "geometry")),
      /columns and rows must be integers 1-64/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sheet authoring rejects row and column locations outside declared geometry", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "sheet.png"), createFixtureAtlas(1));
    await writeFile(path.join(source, "LICENSE"), "CC0-1.0\n");
    await writeFile(path.join(source, "PROVENANCE.md"), "# Fixture\n");
    const base = {
      format: 1,
      name: "geometry-fixture",
      version: "0.1.0",
      license: "CC0-1.0",
      logicalCellSize: 32,
      sources: [{ density: 1, sheet: "sheet.png", columns: 16, rows: 1 }],
    };
    for (const [name, states] of [
      ["row", { idle: { row: 1, frames: ["idle"], loop: true, fps: 1 } }],
      [
        "column",
        {
          idle: {
            row: 0,
            frames: Array.from({ length: 17 }, (_, index) => `frame-${index}`),
            loop: true,
            fps: 1,
          },
        },
      ],
    ] as const) {
      await writeFile(
        path.join(source, "source.json"),
        JSON.stringify({ ...base, states }),
      );
      await assert.rejects(
        () => packAuthoringSource(source, path.join(root, name)),
        /source location.*outside.*sheet geometry/i,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sheet authoring rejects decoded source allocations before reading pixels", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "source.json"),
      JSON.stringify({
        format: 1,
        name: "allocation-fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        logicalCellSize: 64,
        sources: [{ density: 4, sheet: "missing.png", columns: 64, rows: 64 }],
        states: {
          idle: { row: 0, frames: ["idle"], loop: true, fps: 1 },
        },
      }),
    );

    await assert.rejects(
      () => packAuthoringSource(source, path.join(root, "compiled")),
      /decoded source allocation exceeds 64 MiB/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sheet authoring allows a named source frame to repeat in one animation", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "compiled");
    await mkdir(source);
    await writeFile(
      path.join(source, "source.json"),
      JSON.stringify({
        format: 1,
        name: "repeat-fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        metadata: { description: "Repeated-frame fixture." },
        logicalCellSize: 32,
        sources: [{ density: 1, sheet: "sheet.png", columns: 16, rows: 1 }],
        states: {
          idle: {
            row: 0,
            frames: ["idle-a", "idle-b", "idle-a"],
            loop: true,
            fps: 3,
          },
        },
      }),
    );
    await writeFile(path.join(source, "sheet.png"), createFixtureAtlas(1));
    await writeFile(path.join(source, "LICENSE"), "CC0-1.0\n");
    await writeFile(path.join(source, "PROVENANCE.md"), "# Fixture\n");

    await packAuthoringSource(source, output);

    const manifest = JSON.parse(
      await readFile(path.join(output, "character.json"), "utf8"),
    );
    assert.deepEqual(manifest.states.idle.frames, [0, 1, 0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pack scanning bounds empty directory count and nesting depth", async () => {
  const root = await temporary();
  try {
    const many = path.join(root, "many");
    await createPack(many, "many-directories");
    for (let index = 0; index < 65; index += 1) {
      await mkdir(path.join(many, `empty-${index}`));
    }
    await assert.rejects(
      () => validatePackDirectory(many),
      /directory-count limit/,
    );

    const deep = path.join(root, "deep");
    await createPack(deep, "deep-directories");
    let directory = deep;
    for (let index = 0; index < 9; index += 1) {
      directory = path.join(directory, `level-${index}`);
      await mkdir(directory);
    }
    await assert.rejects(
      () => validatePackDirectory(deep),
      /directory-depth limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid WebP source error is not masked as a missing PNG", async () => {
  const root = await temporary();
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "pet.json"),
      '{"spriteVersionNumber":2,"name":"fixture"}\n',
    );
    await symlink(
      path.join(root, "outside.webp"),
      path.join(source, "spritesheet.webp"),
    );
    await writeFile(path.join(root, "outside.webp"), fakeWebp());

    await assert.rejects(
      () =>
        importCodexPet(source, path.join(root, "output"), {
          license: "CC0-1.0",
          author: "Fixture",
          source: "Fixture",
          rights: "Fixture",
        }),
      /spritesheet\.webp must be a regular file, not a link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
