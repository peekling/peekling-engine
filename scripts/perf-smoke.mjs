import { performance } from "node:perf_hooks";
import { validateNativePack } from "../packages/runtime/dist/pack-api.js";
import { compilePlan } from "../packages/runtime/dist/plan-compiler.js";
import { PlanRuntime } from "../packages/runtime/dist/plan.js";

const manifest = {
  format: 1,
  name: "perf-fixture",
  version: "0.1.0",
  license: "CC0-1.0",
  metadata: {
    title: "Performance fixture",
    author: "Peekling contributors",
    description: "A synthetic data-only fixture for performance checks.",
  },
  assets: {
    atlas: {
      src: "atlas.png",
      sha256: "0".repeat(64),
      columns: 16,
      rows: 3,
      logicalCellSize: 32,
      sourceCellSize: 32,
      density: 1,
    },
  },
  states: Object.fromEntries([
    ["idle", { frames: [0], fps: 1, loop: true }],
    ...["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((direction, index) => [
      `move:${direction}`,
      { frames: [1 + index * 2, 2 + index * 2], fps: 6, loop: true },
    ]),
  ]),
  capabilities: {
    locomotion: {
      directions: Object.fromEntries(
        ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((direction) => [
          direction,
          `move:${direction}`,
        ]),
      ),
    },
  },
  defaults: { scale: 2 },
};
const validation = samples(500, () =>
  validateNativePack(manifest, { width: 512, height: 96 }),
);
const world = {
  now: 1_000,
  pointer: { x: 700, y: 50 },
  position: { x: 50, y: 500 },
  viewport: { width: 800, height: 600 },
  lastActivityAt: 900,
  reducedMotion: false,
};
const plan = compilePlan(
  {
    baseline: { channels: ["state"], state: { state: "idle" } },
    rules: [
      {
        id: "follow-pointer",
        when: { source: "browser", event: "pointer.move" },
        effect: {
          channels: ["motion", "state"],
          motion: { type: "follow-pointer" },
          state: { capability: "locomotion" },
        },
      },
    ],
  },
  {
    states: new Set(Object.keys(manifest.states)),
    capabilities: new Set(["locomotion"]),
  },
);
const runtime = new PlanRuntime(plan);
const tick = samples(10_000, () => runtime.evaluate(world));
console.log(
  JSON.stringify(
    { validationP95Ms: p95(validation), planTickP95Ms: p95(tick) },
    null,
    2,
  ),
);
if (p95(validation) > 2 || p95(tick) > 2) {
  throw new Error("Pure runtime task p95 exceeds 2 ms");
}

function samples(count, operation) {
  const values = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    operation();
    values.push(performance.now() - start);
  }
  return values;
}

function p95(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
}
