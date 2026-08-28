import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adaptCodexPetV2 } from "../packages/adapter-codex-pet/dist/index.js";
import { runDoctor } from "../packages/cli/dist/doctor.js";
import { preflight } from "../packages/preflight/dist/index.js";
import * as ownData from "../packages/runtime/dist/own-data.js";
import * as packApi from "../packages/runtime/dist/pack-api.js";

const adapterSidecar = {
  format: 1,
  adapter: "codex-pet-v2",
  license: "CC0-1.0",
  provenance: {
    author: "Fixture Author",
    source: "Fixture source bundle",
    rights: "Original fixture created for tests",
  },
};

const adapterAtlas = {
  fileName: "spritesheet.webp",
  sha256: "0".repeat(64),
  width: 1536,
  height: 2288,
  mimeType: "image/webp",
  hasAlpha: true,
};

test("engine-produced snapshots reuse identity without trusting arbitrary frozen objects", () => {
  const snapshotPackData = Reflect.get(ownData, "snapshotPackData");
  assert.equal(
    typeof snapshotPackData,
    "function",
    "the Pack subpath needs one shared structural snapshot seam",
  );

  const source = {
    plan: {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
    },
    pack: { format: 1, name: "fixture" },
  };
  const configuration = ownData.snapshotConfiguration(source);

  assert.notStrictEqual(configuration, source);
  assert.strictEqual(
    ownData.snapshotConfiguration(configuration),
    configuration,
    "a trusted Configuration must not be cloned again",
  );
  assert.strictEqual(
    ownData.snapshotOwnData(configuration.plan),
    configuration.plan,
    "the compiler must reuse the trusted nested Plan",
  );
  assert.strictEqual(
    snapshotPackData(configuration.pack),
    configuration.pack,
    "the loader must reuse the trusted nested Pack",
  );

  const merelyFrozen = Object.freeze({ format: 1 });
  assert.notStrictEqual(
    ownData.snapshotOwnData(merelyFrozen),
    merelyFrozen,
    "Object.freeze alone must not forge engine trust",
  );
  assert.notStrictEqual(
    snapshotPackData(merelyFrozen),
    merelyFrozen,
    "Pack trust must also be non-forgeable",
  );

  const configurationWithFunction = ownData.snapshotConfiguration({
    pack: { format: 1, executable() {} },
  });
  assert.throws(
    () => snapshotPackData(configurationWithFunction.pack),
    /\$\.executable contains unsupported data/,
    "a configuration snapshot must not bypass the stricter Pack boundary",
  );
});

test("all object-data consumers share structural limits and diagnostics", () => {
  const snapshotPackData = Reflect.get(ownData, "snapshotPackData");
  assert.equal(typeof snapshotPackData, "function");

  const cases = [
    {
      name: "accessor",
      expected: "$.value must be an own data property",
      create() {
        let reads = 0;
        const input = Object.create(null);
        Object.defineProperty(input, "value", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("accessor executed");
          },
        });
        return { input, assertContained: () => assert.equal(reads, 0) };
      },
    },
    {
      name: "proxy",
      expected: "$ cannot be inspected safely",
      create() {
        let reflections = 0;
        const input = new Proxy(
          {},
          {
            ownKeys() {
              reflections += 1;
              throw new Error("reflection failed");
            },
          },
        );
        return {
          input,
          assertContained: () => assert.equal(reflections, 1),
        };
      },
    },
    {
      name: "custom prototype",
      expected: "$ must use this realm's Object prototype or a null prototype",
      create() {
        return {
          input: Object.create(Object.create(null)),
          assertContained() {},
        };
      },
    },
    {
      name: "cycle",
      expected: "$.self must not contain cycles",
      create() {
        const input = Object.create(null);
        input.self = input;
        return { input, assertContained() {} };
      },
    },
    {
      name: "depth",
      expected: `${"$"}${".next".repeat(33)} exceeds maximum depth`,
      create() {
        const input = Object.create(null);
        let cursor = input;
        for (let index = 0; index < 33; index += 1) {
          cursor.next = Object.create(null);
          cursor = cursor.next;
        }
        return { input, assertContained() {} };
      },
    },
    {
      name: "node count",
      expected: "$.groups[4][3993] exceeds maximum object count",
      create() {
        const input = Object.create(null);
        input.groups = Array.from({ length: 5 }, () =>
          Array.from({ length: 4_000 }, () => Object.create(null)),
        );
        return { input, assertContained() {} };
      },
    },
  ];

  const consumers = [
    {
      name: "Pack snapshot",
      run: (input) => snapshotPackData(input),
      message: (error) => error.message,
    },
    {
      name: "native Pack",
      run: (input) => packApi.validateNativePack(input),
      message: (error) => error.issues?.[0],
    },
    {
      name: "normalized Pack",
      run: (input) => packApi.validateNormalizedPack(input),
      message: (error) => error.issues?.[0],
    },
    {
      name: "public Preflight",
      run(input) {
        const report = preflight(input);
        if (report.valid)
          throw new Error("Preflight unexpectedly accepted input");
        throw new Error(report.errors[0]?.message);
      },
      message: (error) => error.message,
    },
    {
      name: "Codex adapter",
      run: (input) => adaptCodexPetV2(input),
      message: (error) =>
        error.message.replace(/^Invalid Codex Pet v2 bundle:\n- /, ""),
    },
  ];

  for (const entry of cases) {
    for (const consumer of consumers) {
      const fixture = entry.create();
      assert.throws(
        () => consumer.run(fixture.input),
        (error) => {
          assert.equal(
            consumer.message(error),
            entry.expected,
            `${consumer.name} drifted for ${entry.name}`,
          );
          return true;
        },
      );
      fixture.assertContained();
    }
  }
});

test("null-prototype Pack data stays supported across the shared seam and adapter", () => {
  const snapshotPackData = Reflect.get(ownData, "snapshotPackData");
  assert.equal(typeof snapshotPackData, "function");

  const source = toNullPrototype({
    pet: { spriteVersionNumber: 2, name: "null-prototype-fixture" },
    sidecar: adapterSidecar,
    atlas: adapterAtlas,
  });
  const snapshot = snapshotPackData(source);
  assert.equal(Object.getPrototypeOf(snapshot), null);
  assert.strictEqual(snapshotPackData(snapshot), snapshot);
  assert.doesNotThrow(() => adaptCodexPetV2(source));
  assert.equal(
    preflight(
      Object.assign(Object.create(null), {
        character: "peek",
        position: "center",
      }),
    ).valid,
    true,
  );
});

test("Doctor applies the same depth and node limits to JSON-representable input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-own-data-doctor-"));
  try {
    const deep = {};
    let cursor = deep;
    for (let index = 0; index < 33; index += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    const wide = {
      groups: Array.from({ length: 5 }, () =>
        Array.from({ length: 4_000 }, () => ({})),
      ),
    };
    const fixtures = [
      {
        file: "deep.json",
        value: deep,
        expected: `${"$"}${".next".repeat(33)} exceeds maximum depth`,
      },
      {
        file: "wide.json",
        value: wide,
        expected: "$.groups[4][3993] exceeds maximum object count",
      },
    ];

    for (const fixture of fixtures) {
      const target = path.join(root, fixture.file);
      await writeFile(target, JSON.stringify(fixture.value));
      const result = await runDoctor(target, { json: true });
      assert.equal(result.exitCode, 1);
      assert.equal(result.report.errors[0]?.code, "invalid-options");
      assert.equal(result.report.errors[0]?.message, fixture.expected);
      assert.equal(
        preflight(fixture.value).errors[0]?.message,
        fixture.expected,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function toNullPrototype(value) {
  if (Array.isArray(value)) return value.map(toNullPrototype);
  if (!value || typeof value !== "object") return value;
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    output[key] = toNullPrototype(item);
  }
  return output;
}
