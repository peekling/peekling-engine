import assert from "node:assert/strict";
import test from "node:test";
import { adaptCodexPetV2 } from "../packages/adapter-codex-pet/dist/index.js";
import { validateNormalizedPack } from "../packages/runtime/dist/pack-api.js";
import { validateEventPayload } from "../packages/runtime/dist/events.js";
import { resolveCapabilityName } from "../packages/runtime/dist/normalized.js";
import { characterManifestUrl } from "../packages/runtime/dist/registry.js";
import { validateRuntimeConfiguration } from "../packages/runtime/dist/runtime-validation.js";

const normalizedFixture = {
  name: "fixture",
  displayName: "Fixture",
  version: "0.1.0",
  license: "CC0-1.0",
  atlas: {
    src: "atlas.webp",
    sha256: "0".repeat(64),
    columns: 2,
    rows: 2,
    cellWidth: 32,
    cellHeight: 32,
  },
  states: { idle: { frames: [0], fps: 1, loop: true } },
  defaultScale: 1,
};

test("optional Codex adapter composes through the runtime's normalized capability boundary", () => {
  const adapted = adaptCodexPetV2({
    pet: { spriteVersionNumber: 2, name: "composition-fixture" },
    sidecar: {
      format: 1,
      adapter: "codex-pet-v2",
      license: "CC0-1.0",
      provenance: {
        author: "Test author",
        source: "Generated test fixture",
        rights: "Original fixture created for this test",
      },
    },
    atlas: {
      fileName: "spritesheet.webp",
      sha256: "0".repeat(64),
      width: 1536,
      height: 2288,
      mimeType: "image/webp",
      hasAlpha: true,
    },
  });
  const normalized = validateNormalizedPack(adapted, {
    width: 1536,
    height: 2288,
  });
  assert.equal(normalized.directionalStates?.NW, "running-left");
  assert.equal(normalized.directionalStates?.SE, "running-right");
  assert.equal(normalized.reactionStates?.success, "jumping");
  assert.equal(normalized.reactionStates?.error, "failed");
});

test("Codex adapter outputs round-trip for bounded and fallback metadata", () => {
  const cases = [
    { spriteVersionNumber: 2, name: "round-trip", version: "1.2.3" },
    {
      spriteVersionNumber: 2,
      name: "n".repeat(121),
      version: "01.2.3",
      notes: "x".repeat(9_000),
    },
  ];

  for (const pet of cases) {
    const adapted = adaptCodexPetV2({
      pet,
      sidecar: {
        format: 1,
        adapter: "codex-pet-v2",
        license: "CC0-1.0",
        provenance: {
          author: "Test author",
          source: "Generated test fixture",
          rights: "Original fixture created for this test",
        },
      },
      atlas: {
        fileName: "spritesheet.webp",
        sha256: "0".repeat(64),
        width: 1536,
        height: 2288,
        mimeType: "image/webp",
        hasAlpha: true,
        byteLength: 4 * 1024 * 1024,
      },
    });
    assert.doesNotThrow(() =>
      validateNormalizedPack(adapted, {
        width: 1536,
        height: 2288,
        byteLength: 4 * 1024 * 1024,
      }),
    );
  }
});

test("normalized packs reject open direction maps", () => {
  assert.throws(
    () =>
      validateNormalizedPack({
        ...normalizedFixture,
        directionalStates: { E: "idle", future: "idle" },
      }),
    /directionalStates\.future/,
  );
});

test("normalized packs reject URL-like display names", () => {
  assert.throws(
    () =>
      validateNormalizedPack({
        ...normalizedFixture,
        displayName: "Visit https://evil.example",
      }),
    /displayName.*URL/i,
  );
});

test("normalized packs reject oversized atlas byte lengths", () => {
  assert.throws(
    () =>
      validateNormalizedPack(normalizedFixture, {
        width: 64,
        height: 64,
        byteLength: 32 * 1024 * 1024 + 1,
      }),
    /atlas.*resource|atlas.*size/i,
  );
});

for (const [name, configuration] of [
  ["null Plan", { plan: null }],
  ["missing stylesheet URL", { styles: { integrity: "sha384-YWJj" } }],
  [
    "cross-origin HTTP stylesheet",
    { styles: { url: "http://assets.example/peekling.css" } },
  ],
  [
    "credential-bearing stylesheet URL",
    { styles: { url: "https://trusted.example@evil.example/peekling.css" } },
  ],
  [
    "missing host mount binding",
    { content: { tip: { bottom: { mountId: "chart" } } } },
  ],
  [
    "inherited host mount binding",
    {
      content: { tip: { bottom: { mountId: "constructor" } } },
      bindings: { mounts: {} },
    },
  ],
  ["coerced character name", { character: ["peek"] }],
  ["incomplete position", { position: { x: 0 } }],
]) {
  test(`runtime validation rejects ${name}`, () => {
    assert.throws(
      () =>
        validateRuntimeConfiguration(configuration, "http://site.example/page"),
      undefined,
      JSON.stringify(configuration),
    );
  });
}

test("event payloads preserve an own __proto__ field without prototype mutation", () => {
  const payload = validateEventPayload(
    JSON.parse('{"__proto__":{"safe":true}}'),
  );

  assert.equal(Object.getPrototypeOf(payload), null);
  assert.equal(Object.hasOwn(payload, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(payload.__proto__), null);
  assert.equal(payload.__proto__.safe, true);
});

test("the character registry cannot resolve inherited Object keys", () => {
  assert.match(characterManifestUrl("peek"), /pack-peek@0\.1\.0/);
  assert.throws(() => characterManifestUrl("constructor"), /Unknown/);
});

test("runtime configuration admits only registered character names", () => {
  assert.doesNotThrow(() =>
    validateRuntimeConfiguration(
      { character: "peek", styles: { url: "./peekling.css" } },
      "https://site.example/page",
    ),
  );
  assert.throws(
    () =>
      validateRuntimeConfiguration(
        {
          character: "unregistered",
          styles: { url: "./peekling.css" },
        },
        "https://site.example/page",
      ),
    (error) => {
      assert.equal(error?.name, "PeeklingPreflightError");
      assert.equal(error?.issues?.[0]?.code, "character.unknown");
      assert.equal(error?.issues?.[0]?.path, "$.character");
      return true;
    },
  );
  assert.doesNotThrow(() =>
    validateRuntimeConfiguration(
      {
        character: "unregistered",
        packUrl: "./character.json",
        styles: { url: "./peekling.css" },
      },
      "https://site.example/page",
    ),
  );
});

test("normalized capability lookup cannot resolve inherited Object keys", () => {
  const pack = validateNormalizedPack({
    ...normalizedFixture,
    reactionStates: { happy: "idle" },
  });
  assert.equal(resolveCapabilityName("constructor", pack), "constructor");
});
