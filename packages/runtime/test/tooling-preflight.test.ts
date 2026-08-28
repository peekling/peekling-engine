import assert from "node:assert/strict";
import test from "node:test";
import { preflight } from "../dist/preflight-api.js";
import type { NativeDensity, NormalizedPack } from "../dist/types.js";

function singleDensityPack(density: NativeDensity = 4): NormalizedPack {
  return {
    name: "single-density",
    displayName: "Single density",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: `atlas-${density}x.png`,
      sha256: "0".repeat(64),
      columns: 1,
      rows: 1,
      cellWidth: density,
      cellHeight: density,
      logicalWidth: 1,
      logicalHeight: 1,
      density,
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
}

test("preflight rejects a density override that cannot apply to a single atlas", () => {
  const report = preflight({
    pack: singleDensityPack(),
    density: 1,
  });

  assert.equal(report.valid, false);
  assert.deepEqual(report.errors, [
    {
      code: "atlas.override-density",
      path: "$.density",
      message: "density must match the single atlas density",
      fix: "Match the Pack atlas density or remove density",
    },
  ]);
  assert.deepEqual(report.warnings, []);
});

test("preflight rejects a single atlas above maxDensity", () => {
  const report = preflight({
    pack: singleDensityPack(),
    maxDensity: 2,
  });

  assert.equal(report.valid, false);
  assert.deepEqual(report.errors, [
    {
      code: "atlas.max-density",
      path: "$.maxDensity",
      message: "Single atlas density exceeds maxDensity",
      fix: "Raise maxDensity or use a lower-density Pack",
    },
  ]);
  assert.deepEqual(report.warnings, []);
});
