import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_REACTION_DEFAULTS,
  adaptCodexPetV2,
  codexLocomotionForDelta,
  lookStateForAngle,
} from "../dist/index.js";

const sidecar = {
  format: 1,
  adapter: "codex-pet-v2",
  license: "CC-BY-4.0",
  provenance: {
    author: "Fixture Author",
    source: "Fixture source bundle",
    rights: "Original fixture created for tests",
  },
};

const atlas = {
  fileName: "spritesheet.webp",
  sha256: "0".repeat(64),
  width: 1536,
  height: 2288,
  mimeType: "image/webp",
  hasAlpha: true,
} as const;

test("normalizes fixed Codex v2 rows, frame counts, timings, and look cells", () => {
  const pet = {
    spriteVersionNumber: 2,
    name: "codex-fixture",
    ignoredScript: "alert(1)",
  };
  const pack = adaptCodexPetV2({ pet, sidecar, atlas });
  assert.deepEqual(pack.states.idle?.frames, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(
    pack.states["running-right"]?.frames,
    [8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.deepEqual(
    pack.states.failed?.durations,
    [140, 140, 140, 140, 140, 140, 140, 240],
  );
  assert.deepEqual(pack.states["look:337.5"]?.frames, [87]);
  assert.equal(pack.source.legacyFlat8Fps, true);
  assert.equal(Object.hasOwn(pack.source.pet, "ignoredScript"), false);
  assert.deepEqual(pack.source.pet, {
    spriteVersionNumber: 2,
    name: "codex-fixture",
  });
  assert.equal(CODEX_REACTION_DEFAULTS.error, "failed");
});

test("preserves runtime-valid explicit source pacing", () => {
  const idle = [20, 20, 30, 40, 50, 60];
  const pack = adaptCodexPetV2({
    pet: {
      spriteVersionNumber: 2,
      animations: { idle: { frameDurations: idle } },
    },
    sidecar,
    atlas,
  });
  assert.deepEqual(pack.states.idle?.durations, idle);
  assert.equal(pack.source.legacyFlat8Fps, false);
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: {
          spriteVersionNumber: 2,
          animations: { idle: { frameDurations: [10, 20, 30, 40, 50, 60] } },
        },
        sidecar,
        atlas,
      }),
    /16-10000/,
  );
});

test("rejects unsupported geometry, missing provenance, versions, and opacity", () => {
  assert.throws(
    () =>
      adaptCodexPetV2({ pet: { spriteVersionNumber: 1 }, sidecar: {}, atlas }),
    /spriteVersionNumber|sidecar/,
  );
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: { spriteVersionNumber: 2 },
        sidecar,
        atlas: { ...atlas, width: 1 },
      }),
    /1536x2288/,
  );
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: { spriteVersionNumber: 2 },
        sidecar,
        atlas: { ...atlas, hasAlpha: false },
      }),
    /transparency/,
  );
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: { spriteVersionNumber: 2 },
        sidecar: { ...sidecar, reactions: { success: "not-a-codex-state" } },
        atlas,
      }),
    /reactions\.success/,
  );
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: { spriteVersionNumber: 2 },
        sidecar,
        atlas: { ...atlas, byteLength: Number.NaN },
      }),
    /byteLength/,
  );
  for (const sha256 of [undefined, "not-a-sha256"]) {
    assert.throws(
      () =>
        adaptCodexPetV2({
          pet: { spriteVersionNumber: 2 },
          sidecar,
          atlas: { ...atlas, sha256: sha256 as never },
        }),
      /atlas\.sha256/,
    );
  }
  const circular: Record<string, unknown> = { spriteVersionNumber: 2 };
  circular.self = circular;
  assert.throws(
    () => adaptCodexPetV2({ pet: circular, sidecar, atlas }),
    /must not contain cycles/,
  );
});

test("sanitizes hostile display metadata without changing fixed capabilities", () => {
  const pack = adaptCodexPetV2({
    pet: { spriteVersionNumber: 2, name: "bad\nname", version: "wat" },
    sidecar,
    atlas,
  });
  assert.equal(pack.name, "codex-pet");
  assert.equal(pack.version, "2.0.0");
  assert.equal(pack.reactionStates.success, "jumping");
});

test("maps horizontal pursuit and clockwise look directions", () => {
  assert.equal(codexLocomotionForDelta(-1), "running-left");
  assert.equal(codexLocomotionForDelta(0), "running-right");
  assert.equal(lookStateForAngle(22.5), "look:022.5");
  assert.equal(lookStateForAngle(-22.5), "look:337.5");
});

test("bounds normalized identity and provenance before returning success", () => {
  const pack = adaptCodexPetV2({
    pet: {
      spriteVersionNumber: 2,
      name: "n".repeat(121),
      version: "01.2.3",
      notes: "x".repeat(9_000),
    },
    sidecar,
    atlas,
  });

  assert.equal(pack.displayName, "codex-pet");
  assert.equal(pack.version, "2.0.0");
  assert.deepEqual(pack.source.pet, { spriteVersionNumber: 2 });
  assert.ok(
    new TextEncoder().encode(JSON.stringify(pack.source)).byteLength <= 8_192,
  );
});

test("rejects license identifiers that the normalized runtime cannot accept", () => {
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: { spriteVersionNumber: 2 },
        sidecar: {
          ...sidecar,
          license: `LicenseRef-${"x".repeat(60)}`,
        },
        atlas,
      }),
    /sidecar\.license/,
  );
});

test("hostile adapter inputs fail closed without invoking getters or toJSON", () => {
  let petReads = 0;
  const pet = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(pet, "spriteVersionNumber", {
    enumerable: true,
    get() {
      petReads += 1;
      return 2;
    },
  });
  assert.throws(
    () => adaptCodexPetV2({ pet, sidecar, atlas }),
    /own data|inspect|descriptor/i,
  );
  assert.equal(petReads, 0);

  let jsonCalls = 0;
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: {
          spriteVersionNumber: 2,
          toJSON() {
            jsonCalls += 1;
            return { spriteVersionNumber: 2 };
          },
        },
        sidecar,
        atlas,
      }),
    /JSON data|unsupported/i,
  );
  assert.equal(jsonCalls, 0);

  const inherited = Object.create({ spriteVersionNumber: 2 });
  assert.throws(
    () => adaptCodexPetV2({ pet: inherited, sidecar, atlas }),
    /plain data object|prototype/i,
  );
});

test("nested and top-level reflection failures become controlled adapter errors", () => {
  let provenanceReads = 0;
  const provenance = Object.assign(
    Object.create(null),
    sidecar.provenance,
  ) as Record<string, unknown>;
  Object.defineProperty(provenance, "author", {
    enumerable: true,
    get() {
      provenanceReads += 1;
      return "Fixture Author";
    },
  });
  const hostileSidecar = {
    ...sidecar,
    provenance,
  };
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: { spriteVersionNumber: 2 },
        sidecar: hostileSidecar,
        atlas,
      }),
    /own data|inspect|descriptor/i,
  );
  assert.equal(provenanceReads, 0);

  let atlasReads = 0;
  const hostileAtlas = Object.assign(Object.create(null), atlas) as Record<
    string,
    unknown
  >;
  Object.defineProperty(hostileAtlas, "width", {
    enumerable: true,
    get() {
      atlasReads += 1;
      return 1536;
    },
  });
  assert.throws(
    () =>
      adaptCodexPetV2({
        pet: { spriteVersionNumber: 2 },
        sidecar,
        atlas: hostileAtlas as never,
      }),
    /own data|inspect|descriptor/i,
  );
  assert.equal(atlasReads, 0);

  let proxyTraps = 0;
  const trapped = new Proxy(
    { pet: { spriteVersionNumber: 2 }, sidecar, atlas },
    {
      ownKeys() {
        proxyTraps += 1;
        throw new Error("host proxy trap");
      },
    },
  );
  assert.throws(() => adaptCodexPetV2(trapped), /cannot be inspected safely/i);
  assert.equal(proxyTraps, 1);
});

test("adapter data traversal is bounded before normalization", () => {
  const deep: Record<string, unknown> = { spriteVersionNumber: 2 };
  let cursor = deep;
  for (let index = 0; index < 40; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  assert.throws(() => adaptCodexPetV2({ pet: deep, sidecar, atlas }), /depth/i);

  const wide = Object.fromEntries(
    Array.from({ length: 1_025 }, (_, index) => [`field${index}`, index]),
  );
  wide.spriteVersionNumber = 2;
  assert.throws(
    () => adaptCodexPetV2({ pet: wide, sidecar, atlas }),
    /propert|keys|fields/i,
  );
});
