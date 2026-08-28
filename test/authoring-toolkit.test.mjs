import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  invalidSerializableConfigurationCases,
  invalidSerializableUrlCases,
  invalidSurfaceColorCases,
  nullSerializableConfigurationCase,
  validSerializableUrlCases,
  validSurfaceColorCases,
} from "./fixtures/configuration-parity.mjs";

const execute = promisify(execFile);

function minimalPlan(state = "idle") {
  return {
    baseline: {
      channels: ["state"],
      state: { state },
    },
  };
}

test("preflight exposes one deliberate pure API", async () => {
  const api = await import("@peekling/preflight");

  assert.deepEqual(Object.keys(api), ["preflight"]);
  assert.deepEqual(api.preflight({ character: "peek", plan: minimalPlan() }), {
    valid: true,
    errors: [],
    warnings: [
      {
        code: "pack-context-missing",
        path: "$.plan",
        message: "Plan references cannot be checked without Pack context",
        fix: "Pass the Pack with the preflight options or peekling doctor --pack",
      },
    ],
  });
});

test("peekling doctor provides deterministic JSON and status codes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-test-"));
  try {
    const configPath = path.join(root, "peekling.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ character: "peek", plan: minimalPlan() }, null, 2)}\n`,
    );
    const first = await execute(
      process.execPath,
      ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
      { cwd: process.cwd() },
    );
    const second = await execute(
      process.execPath,
      ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
      { cwd: process.cwd() },
    );

    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(JSON.parse(first.stdout), {
      valid: true,
      errors: [],
      warnings: [
        {
          code: "pack-context-missing",
          path: "$.plan",
          message: "Plan references cannot be checked without Pack context",
          fix: "Pass the Pack with the preflight options or peekling doctor --pack",
        },
      ],
    });

    await writeFile(configPath, '{"run":true}\n');
    await assert.rejects(
      execute(
        process.execPath,
        ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
        { cwd: process.cwd() },
      ),
      (error) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stdout);
        assert.equal(report.valid, false);
        assert.equal(report.errors[0].code, "removed-api");
        assert.equal(report.errors[0].path, "$.run");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peekling doctor rejects the shared malformed configuration corpus", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-parity-"));
  try {
    const configPath = path.join(root, "peekling.json");
    for (const { name, configuration } of [
      nullSerializableConfigurationCase,
      ...invalidSerializableConfigurationCases,
    ]) {
      await writeFile(configPath, `${JSON.stringify(configuration)}\n`);
      await assert.rejects(
        execute(
          process.execPath,
          ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
          { cwd: process.cwd() },
        ),
        (error) => {
          assert.equal(error.code, 1, name);
          const report = JSON.parse(error.stdout);
          assert.equal(report.valid, false, name);
          assert.ok(report.errors.length > 0, name);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peekling doctor enforces the closed surface color grammar", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-theme-"));
  try {
    const configPath = path.join(root, "peekling.json");
    for (const value of validSurfaceColorCases) {
      await writeFile(
        configPath,
        `${JSON.stringify({
          character: "peek",
          theme: { background: value },
        })}\n`,
      );
      const result = await execute(
        process.execPath,
        ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
        { cwd: process.cwd() },
      );
      assert.equal(JSON.parse(result.stdout).valid, true, value);
    }
    for (const value of invalidSurfaceColorCases) {
      await writeFile(
        configPath,
        `${JSON.stringify({
          character: "peek",
          theme: { background: value },
        })}\n`,
      );
      await assert.rejects(
        execute(
          process.execPath,
          ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
          { cwd: process.cwd() },
        ),
        (error) => {
          assert.equal(error.code, 1, value);
          const report = JSON.parse(error.stdout);
          assert.equal(report.valid, false, value);
          assert.equal(report.errors[0].path, "$.theme.background", value);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peekling doctor applies the shared semantic URL policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-url-"));
  try {
    const configPath = path.join(root, "peekling.json");
    for (const { name, value } of validSerializableUrlCases) {
      await writeFile(configPath, `${JSON.stringify({ packUrl: value })}\n`);
      const result = await execute(
        process.execPath,
        ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
        { cwd: process.cwd() },
      );
      assert.equal(JSON.parse(result.stdout).valid, true, name);
    }
    for (const { name, value } of invalidSerializableUrlCases) {
      await writeFile(configPath, `${JSON.stringify({ packUrl: value })}\n`);
      await assert.rejects(
        execute(
          process.execPath,
          ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
          { cwd: process.cwd() },
        ),
        (error) => {
          assert.equal(error.code, 1, name);
          const report = JSON.parse(error.stdout);
          assert.equal(report.valid, false, name);
          assert.equal(report.errors[0].path, "$.packUrl", name);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor inputs are data, never executable project code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-data-"));
  try {
    const marker = path.join(root, "executed.txt");
    const modulePath = path.join(root, "peekling.mjs");
    await writeFile(
      modulePath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad"); export default {};\n`,
    );

    await assert.rejects(
      execute(
        process.execPath,
        ["packages/cli/dist/bin.js", "doctor", modulePath, "--json"],
        { cwd: process.cwd() },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stderr, "");
        const report = JSON.parse(error.stdout);
        assert.equal(report.valid, false);
        assert.equal(report.errors[0].code, "invalid-input");
        assert.equal(report.errors[0].path, "$input.configuration");
        return true;
      },
    );
    await assert.rejects(readFile(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "doctor rejects an oversized unreadable file from metadata before reading",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-size-"));
    const configPath = path.join(root, "peekling.json");
    try {
      await writeFile(configPath, Buffer.alloc(65_537, 0x20));
      await chmod(configPath, 0o000);

      await assert.rejects(
        execute(
          process.execPath,
          ["packages/cli/dist/bin.js", "doctor", configPath, "--json"],
          { cwd: process.cwd() },
        ),
        (error) => {
          assert.equal(error.code, 1);
          const report = JSON.parse(error.stdout);
          assert.match(report.errors[0].message, /exceeds 65536 bytes/);
          return true;
        },
      );
    } finally {
      await chmod(configPath, 0o600).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("the production browser artifact contains no authoring toolkit", async () => {
  const browser = await readFile(
    "packages/runtime/dist/peekling.min.js",
    "utf8",
  );

  assert.doesNotMatch(
    browser,
    /Peekling Doctor|pack-context-missing|removed-api|@peekling\/(?:preflight|vite)|peekling:preflight/,
  );
});

test("doctor uses optional Pack data and never fetches resource URLs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-pack-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const port = address.port;
    const configPath = path.join(root, "peekling.json");
    const packPath = path.join(root, "character.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        packUrl: "./character.json",
        plan: minimalPlan(),
      })}\n`,
    );
    await writeFile(
      packPath,
      `${JSON.stringify({
        name: "fixture",
        displayName: "Fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "atlas.png",
          sha256: "0".repeat(64),
          columns: 16,
          rows: 1,
          cellWidth: 32,
          cellHeight: 32,
        },
        states: { idle: { frames: [0], fps: 1, loop: true } },
        defaultScale: 1,
      })}\n`,
    );

    const result = await execute(
      process.execPath,
      [
        "packages/cli/dist/bin.js",
        "doctor",
        configPath,
        "--pack",
        packPath,
        "--base-url",
        `http://127.0.0.1:${port}/`,
        "--json",
      ],
      { cwd: process.cwd() },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      valid: true,
      errors: [],
      warnings: [],
    });
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor classifies mixed motion keyframes as invalid Pack data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-doctor-motion-"));
  try {
    const configPath = path.join(root, "peekling.json");
    const packPath = path.join(root, "character.json");
    await writeFile(configPath, "{}\n");
    await writeFile(
      packPath,
      `${JSON.stringify({
        name: "fixture",
        displayName: "Fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "atlas.png",
          sha256: "0".repeat(64),
          columns: 16,
          rows: 1,
          cellWidth: 32,
          cellHeight: 32,
        },
        states: { idle: { frames: [0], fps: 1, loop: true } },
        defaultScale: 1,
        locomotionMotion: [
          { at: 0, advance: 0, lift: 0 },
          { at: "invalid", advance: 0.5, lift: 0 },
          { at: 1, advance: 1, lift: 0 },
        ],
      })}\n`,
    );

    await assert.rejects(
      execute(
        process.execPath,
        [
          "packages/cli/dist/bin.js",
          "doctor",
          configPath,
          "--pack",
          packPath,
          "--json",
        ],
        { cwd: process.cwd() },
      ),
      (error) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stdout);
        assert.equal(report.errors[0]?.code, "invalid-pack");
        assert.match(report.errors[0]?.message ?? "", /locomotionMotion\.1/);
        assert.doesNotMatch(
          report.errors[0]?.message ?? "",
          /TypeError|undefined/,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
