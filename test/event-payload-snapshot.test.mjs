import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

test("the events module does not require TextEncoder until payload admission", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/events.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "false" },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const OriginalTextEncoder = globalThis.TextEncoder;
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  let events;
  try {
    events = await import(
      `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}#without-encoder`
    );
  } finally {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: OriginalTextEncoder,
      writable: true,
    });
  }
  const accepted = events.validateEventPayload({ ok: true });
  assert.equal(accepted.ok, true);
  assert.equal(Object.isFrozen(accepted), true);
});

test("event payloads use one own-data pass and one cached size encoder", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/events.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "false" },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const OriginalTextEncoder = globalThis.TextEncoder;
  let encoderConstructions = 0;
  class CountingTextEncoder extends OriginalTextEncoder {
    constructor() {
      super();
      encoderConstructions += 1;
    }
  }
  const originalEntries = Object.entries;
  const originalStringify = JSON.stringify;
  let entriesCalls = 0;
  let stringifyCalls = 0;
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: CountingTextEncoder,
    writable: true,
  });
  try {
    const { validateEventPayload } = await import(
      `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
    );
    Object.entries = (...values) => {
      entriesCalls += 1;
      return originalEntries(...values);
    };
    JSON.stringify = (...values) => {
      stringifyCalls += 1;
      return originalStringify(...values);
    };

    const first = validateEventPayload({
      session: { id: "build-7", revision: 1 },
      values: [1, 2, 3],
    });
    const second = validateEventPayload({ ok: true });
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.session), true);
    assert.equal(Object.isFrozen(first.values), true);
    assert.equal(Object.getPrototypeOf(first), null);
    assert.equal(Object.getPrototypeOf(first.session), null);
    assert.equal(Object.isFrozen(second), true);
  } finally {
    Object.entries = originalEntries;
    JSON.stringify = originalStringify;
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: OriginalTextEncoder,
      writable: true,
    });
  }

  assert.equal(
    entriesCalls,
    0,
    "snapshot must not rebuild through Object.entries",
  );
  assert.equal(stringifyCalls, 2, "size is measured once for each payload");
  assert.equal(encoderConstructions, 1, "TextEncoder is cached per module");
});

test("compact event payload failures preserve bounded safety categories", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/events.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "true" },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const { validateEventPayload } = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );
  const cyclic = Object.create(null);
  cyclic.self = cyclic;
  const deep = Object.create(null);
  let cursor = deep;
  for (let index = 0; index < 7; index += 1) {
    cursor.next = Object.create(null);
    cursor = cursor.next;
  }
  let accessorReads = 0;
  const accessor = Object.create(null);
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return true;
    },
  });
  const cases = [
    [cyclic, "event.complexity"],
    [deep, "event.complexity"],
    [accessor, "event.payload"],
    [Object.create(Object.create(null)), "event.payload"],
    [{ value: "x".repeat(2_049) }, "event.string-limit"],
    [{ values: Array.from({ length: 65 }, () => null) }, "event.array-limit"],
    [{ "not allowed": true }, "event.key"],
    [
      Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `part${index}`,
          "x".repeat(2_000),
        ]),
      ),
      "event.size",
    ],
  ];

  for (const [input, code] of cases) {
    assert.throws(
      () => validateEventPayload(input),
      (error) => error instanceof TypeError && error.message === code,
      code,
    );
  }
  assert.equal(accessorReads, 0);
});
