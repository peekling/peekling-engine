import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { preflight } from "../dist/index.js";

function plan(state = "idle") {
  return {
    baseline: {
      channels: ["state"],
      state: { state },
    },
  };
}

function normalizedPack(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function multiDensityPack(densities: readonly (1 | 2 | 4)[] = [1, 2]) {
  const baseDensity = densities[0] ?? 1;
  return normalizedPack({
    atlas: {
      src: `atlas-${baseDensity}x.png`,
      sha256: String(baseDensity).repeat(64),
      columns: 16,
      rows: 1,
      cellWidth: 32 * baseDensity,
      cellHeight: 32 * baseDensity,
      logicalWidth: 32,
      logicalHeight: 32,
      density: baseDensity,
      variants: densities.map((density) => ({
        src: `atlas-${density}x.png`,
        density,
        cellWidth: 32 * density,
        cellHeight: 32 * density,
        sha256: String(density).repeat(64),
      })),
    },
  });
}

test("Configuration requires an explicit Pack selection", () => {
  const report = preflight({ atlasUrl: "./atlas.png" });

  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "manifest.selection");
  assert.equal(report.errors[0]?.path, "$");
  for (const configuration of [
    { character: "peek" },
    { packUrl: "./character.json" },
  ]) {
    assert.equal(preflight(configuration).valid, true);
  }
  assert.equal(preflight({}, { pack: normalizedPack() }).valid, true);
});

test("Configuration character names must exist in the runtime registry", () => {
  assert.equal(preflight({ character: "peek" }).valid, true);

  const report = preflight({ character: "unregistered" });
  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "character.unknown");
  assert.equal(report.errors[0]?.path, "$.character");

  assert.equal(
    preflight({
      character: "unregistered",
      packUrl: "./character.json",
    }).valid,
    true,
  );
});

test("Pack-aware Preflight validates multi-density atlasUrl overrides", () => {
  const pack = multiDensityPack();
  for (const configuration of [
    { atlasUrl: "./atlas.png" },
    { atlasUrl: "./atlas.png", density: 4 },
  ]) {
    const report = preflight(configuration, { pack });
    assert.equal(report.valid, false);
    assert.equal(report.errors[0]?.code, "atlas.override-density");
    assert.equal(report.errors[0]?.path, "$.density");
  }

  assert.equal(
    preflight({ atlasUrl: "./atlas.png", density: 2, maxDensity: 2 }, { pack })
      .valid,
    true,
  );
  assert.equal(preflight({}, { pack }).valid, true);
});

test("Pack-aware Preflight rejects maxDensity below every atlas variant", () => {
  const report = preflight(
    { atlasUrl: "./atlas.png", density: 1, maxDensity: 1 },
    { pack: multiDensityPack([2, 4]) },
  );

  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "atlas.max-density");
  assert.equal(report.errors[0]?.path, "$.maxDensity");
});

test("Pack-aware Preflight does not derive overrides from an invalid atlas URL", () => {
  const report = preflight(
    { atlasUrl: "javascript:alert(1)" },
    { pack: multiDensityPack() },
  );

  assert.deepEqual(
    report.errors.map(({ code }) => code),
    ["invalid-url"],
  );
});

test("Configuration validation collects independent safe faults", () => {
  const report = preflight({ character: "peek", scale: 9, density: 3 });

  assert.deepEqual(
    report.errors.map(({ code }) => code),
    ["out-of-range", "invalid-density"],
  );
});

test("Pack context validates Plan state references", () => {
  const report = preflight(
    { plan: plan("missing") },
    {
      pack: {
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
      },
    },
  );

  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "unknown-state");
  assert.equal(report.errors[0]?.path, "$.plan.baseline.state.state");
});

test("Pack context requires a valid atlas SHA-256 declaration", () => {
  for (const sha256 of [undefined, "not-a-sha256"]) {
    const pack = normalizedPack();
    if (sha256 === undefined) Reflect.deleteProperty(pack.atlas, "sha256");
    else pack.atlas.sha256 = sha256;
    const report = preflight({}, { pack });
    assert.equal(report.valid, false);
    assert.equal(report.errors[0]?.code, "invalid-pack");
    assert.match(report.errors[0]?.message ?? "", /atlas\.sha256/);
  }
});

test("removed creation and behavior fields have specific diagnostics", () => {
  for (const field of ["run", "constructor", "behaviors"]) {
    const report = preflight({ character: "peek", [field]: true });
    assert.equal(report.valid, false);
    assert.equal(report.errors[0]?.code, "removed-api");
    assert.equal(report.errors[0]?.path, `$.${field}`);
  }
});

test("hostile objects are rejected without invoking accessors", () => {
  let reads = 0;
  const input = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(input, "plan", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("must not execute");
    },
  });

  const report = preflight(input);
  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "invalid-options");
  assert.equal(reads, 0);
});

test("Preflight rejects custom and foreign ordinary prototypes", () => {
  const crafted = Object.assign(Object.create(Object.create(null)), {
    position: "bottom-right",
  });
  const nestedPlan = Object.assign(Object.create(Object.create(null)), {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
  });

  for (const configuration of [
    crafted,
    { plan: nestedPlan },
    runInNewContext("({ position: 'bottom-right' })"),
  ]) {
    const report = preflight(configuration);
    assert.equal(report.valid, false);
    assert.equal(report.errors[0]?.code, "invalid-options");
  }

  const nullPrototype = Object.assign(Object.create(null), {
    character: "peek",
    position: "bottom-right",
  });
  assert.equal(preflight(nullPrototype).valid, true);
});

test("Plan diagnostics cover conflicts, conditions, content, and capabilities", () => {
  const pack = {
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
  };
  const conflict = preflight(
    {
      plan: {
        ...plan(),
        rules: ["job.progress", "job.finished"].map((event, index) => ({
          id: index === 0 ? "progress" : "finished",
          when: { source: "application", event },
          effect: {
            channels: ["surface:job"],
            surfaces: [
              {
                id: "job",
                contentId: "job",
                data: "event-payload",
              },
            ],
          },
        })),
      },
      content: { job: { bottom: "Job status" } },
    },
    { pack },
  );
  assert.equal(conflict.errors[0]?.code, "ambiguous-channel");
  assert.match(conflict.errors[0]?.message ?? "", /progress, finished/);

  const invalidCondition = preflight(
    {
      plan: {
        ...plan(),
        rules: [
          {
            id: "bad-browser-event",
            when: { source: "browser", event: "network.online" },
            effect: { channels: ["state"], state: { state: "idle" } },
          },
        ],
      },
    },
    { pack },
  );
  assert.equal(invalidCondition.errors[0]?.code, "invalid-condition");

  const missingContent = preflight(
    {
      plan: {
        ...plan(),
        rules: [
          {
            id: "missing-content",
            when: { source: "application", event: "job.progress" },
            effect: {
              channels: ["surface:job"],
              surfaces: [{ id: "job", contentId: "job" }],
            },
          },
        ],
      },
    },
    { pack },
  );
  assert.equal(missingContent.errors[0]?.code, "unknown-content");

  const missingCapability = preflight(
    {
      plan: {
        baseline: {
          channels: ["state"],
          state: { capability: "locomotion" },
        },
      },
    },
    { pack },
  );
  assert.equal(missingCapability.errors[0]?.code, "unknown-capability");
});

test("Plan data cannot contain host predicates or functions", () => {
  const report = preflight({
    character: "peek",
    plan: {
      ...plan(),
      rules: [
        {
          id: "host-predicate",
          when: {
            source: "application",
            event: "job.progress",
            predicate: () => true,
          },
          effect: { channels: ["state"], state: { state: "idle" } },
        },
      ],
    },
  });

  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "unknown-field");
  assert.equal(report.errors[0]?.path, "$.plan.rules[0].when.predicate");
});

test("malformed external Pack context is an actionable error", () => {
  const report = preflight({ plan: plan() }, { pack: { states: {} } });

  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "invalid-pack");
  assert.equal(report.errors[0]?.path, "$pack");
  assert.ok(report.errors[0]?.fix);
});

test("mixed motion keyframes stay classified as invalid Pack data", () => {
  const report = preflight(
    {},
    {
      pack: normalizedPack({
        locomotionMotion: [
          { at: 0, advance: 0, lift: 0 },
          { at: "invalid", advance: 0.5, lift: 0 },
          { at: 1, advance: 1, lift: 0 },
        ],
      }),
    },
  );

  assert.equal(report.valid, false);
  assert.equal(report.errors[0]?.code, "invalid-pack");
  assert.match(report.errors[0]?.message ?? "", /locomotionMotion\.1/);
  assert.doesNotMatch(report.errors[0]?.message ?? "", /TypeError|undefined/);
});

test("preflight options reject getters and conflicting Pack sources", () => {
  let reads = 0;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "pack", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("must not execute");
    },
  });
  const unsafe = preflight({ plan: plan() }, hostile);
  assert.equal(unsafe.valid, false);
  assert.equal(unsafe.errors[0]?.code, "invalid-preflight-options");
  assert.equal(reads, 0);

  const conflict = preflight(
    { pack: { invalid: "inline" }, plan: plan() },
    { pack: { invalid: "external" } },
  );
  assert.equal(conflict.valid, false);
  assert.ok(
    conflict.errors.some((issue) => issue.code === "pack-context-conflict"),
  );
});

for (const [name, configuration] of [
  ["object rules", { character: "peek", plan: { baseline: {}, rules: {} } }],
  ["null rule", { character: "peek", plan: { baseline: {}, rules: [null] } }],
  ["null content item", { character: "peek", content: { tip: null } }],
] as const) {
  test(`malformed ${name} returns diagnostics instead of throwing`, () => {
    const report = preflight(configuration);
    assert.equal(report.valid, false, JSON.stringify(configuration));
    assert.ok(report.errors.length > 0, JSON.stringify(configuration));
  });
}

for (const [name, configuration] of [
  ["null Plan", { character: "peek", plan: null }],
  [
    "missing stylesheet URL",
    { character: "peek", styles: { integrity: "sha384-YWJj" } },
  ],
  [
    "cross-origin HTTP stylesheet",
    {
      character: "peek",
      styles: { url: "http://assets.example/peekling.css" },
    },
  ],
  [
    "credential-bearing stylesheet URL",
    {
      character: "peek",
      styles: { url: "https://trusted.example@evil.example/peekling.css" },
    },
  ],
  [
    "missing host mount binding",
    {
      character: "peek",
      content: { tip: { bottom: { mountId: "chart" } } },
    },
  ],
  [
    "inherited host mount binding",
    {
      character: "peek",
      content: { tip: { bottom: { mountId: "constructor" } } },
      bindings: { mounts: {} },
    },
  ],
  ["coerced character name", { character: ["peek"] }],
] as const) {
  test(`${name} fails preflight`, () => {
    const report = preflight(configuration, {
      baseUrl: "http://site.example/page",
    });
    assert.equal(report.valid, false, JSON.stringify(configuration));
    assert.ok(report.errors.length > 0, JSON.stringify(configuration));
  });
}

test("partial direction maps do not grant the locomotion capability", () => {
  const report = preflight(
    {
      plan: {
        baseline: {
          channels: ["state"],
          state: { capability: "locomotion" },
        },
      },
    },
    {
      pack: normalizedPack({ directionalStates: { E: "idle" } }),
    },
  );

  assert.equal(report.valid, false);
  assert.ok(report.errors.some((issue) => issue.code === "unknown-capability"));
});
