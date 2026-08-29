import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PUBLIC_RUNTIME_VALUES = [
  "PEEKLING_ELEMENT_TAG",
  "definePeeklingElement",
  "hatch",
  "hidePeekling",
  "isPeeklingHidden",
  "showPeekling",
];

const PUBLIC_RUNTIME_TYPES = [
  "ContentRegion",
  "DiagnosticRecord",
  "DiagnosticSeverity",
  "Direction",
  "EmitResult",
  "HostBindings",
  "HostContent",
  "HostContentItem",
  "HostContentPrimitive",
  "HostContentSurface",
  "HostSurfaceMount",
  "HostSurfaceMountContext",
  "HostSurfaceMountResult",
  "JsonValue",
  "NativeDensity",
  "NativeManifest",
  "NormalizedPack",
  "OverrideCompletionReason",
  "OverrideHandle",
  "OverrideInput",
  "OverrideLifetime",
  "OverrideResult",
  "OverrideStatus",
  "PeeklingElement",
  "PeeklingFinishReason",
  "PeeklingFinishResult",
  "PeeklingHatchInput",
  "PeeklingHideDuration",
  "PeeklingIndicator",
  "PeeklingInstance",
  "PeeklingInteractionOptions",
  "PeeklingMotionPreference",
  "PeeklingOptions",
  "PeeklingPackSelection",
  "PeeklingPosition",
  "PeeklingPreset",
  "PeeklingPressAction",
  "Plan",
  "PlanBrowserEvent",
  "PlanCapability",
  "PlanChannel",
  "PlanCondition",
  "PlanDisposition",
  "PlanEffect",
  "PlanEventSource",
  "PlanMotionEffect",
  "PlanRule",
  "PlanStateSelection",
  "PlanSurfaceEffect",
  "PlanSurfaceOrdering",
  "RuntimeStyleAsset",
  "StateDefinition",
  "SurfaceTheme",
  "TargetAnchor",
  "TargetSnapshot",
];

test("the ESM root exposes only the supported hatch integration surface", async () => {
  const runtime = await import("../packages/runtime/dist/index.js");
  assert.deepEqual(Object.keys(runtime).sort(), PUBLIC_RUNTIME_VALUES);
  assert.equal("default" in runtime, false);
  assert.equal("Peekling" in runtime, false);
  assert.equal("preflight" in runtime, false);
  assert.equal("PlanRuntime" in runtime, false);
  assert.equal("ContentRenderer" in runtime, false);
});

test("supported package imports block implementation modules", async () => {
  await assert.rejects(
    import("@peekling/runtime/peekling"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  await assert.rejects(
    import("@peekling/runtime/plan"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

test("the pack subpath contains only the deliberate shared Pack gate", async () => {
  const pack = await import("@peekling/runtime/pack");
  assert.deepEqual(Object.keys(pack).sort(), [
    "PackValidationError",
    "inspectImageStructure",
    "parseDataText",
    "parseManifestText",
    "snapshotPackData",
    "validateNativePack",
    "validateNormalizedPack",
  ]);
});

test("the Canvas subpath exposes only the renderer-selecting hatch helper", async () => {
  const canvas = await import("@peekling/runtime/canvas");
  assert.deepEqual(Object.keys(canvas), ["hatchCanvas"]);
});

test("the ESM package exposes its required stylesheet as a stable asset", async () => {
  const stylesheetUrl = import.meta.resolve("@peekling/runtime/peekling.css");
  const stylesheet = await readFile(new URL(stylesheetUrl), "utf8");
  assert.match(stylesheet, /data-peekling-host/);
});

test("package exports separate the runtime root, browser side effects, and pack tools", async () => {
  const metadata = JSON.parse(
    await readFile("packages/runtime/package.json", "utf8"),
  );
  assert.deepEqual(Object.keys(metadata.exports).sort(), [
    ".",
    "./browser",
    "./canvas",
    "./pack",
    "./peekling.css",
    "./preflight",
  ]);
  assert.equal(metadata.exports["."].import, "./dist/index.js");
  assert.equal(metadata.exports["./canvas"].import, "./dist/canvas.js");
  assert.equal(metadata.exports["./pack"].import, "./dist/pack-api.js");
  assert.equal(
    metadata.exports["./preflight"].import,
    "./dist/preflight-api.js",
  );
  assert.equal(metadata.exports["./browser"], "./dist/peekling.min.js");
  assert.equal(metadata.exports["./peekling.css"], "./dist/peekling.css");
});

test("generated root declarations contain no constructor or default export", async () => {
  const declarations = await readFile(
    "packages/runtime/dist/index.d.ts",
    "utf8",
  );
  assert.doesNotMatch(declarations, /\bclass\s+Peekling\b/);
  assert.doesNotMatch(declarations, /\bdefault\b/);
  assert.doesNotMatch(declarations, /\bpreflight\b/);
  assert.match(declarations, /\bhatch\b/);
  assert.match(declarations, /\bPeeklingInstance\b/);
  assert.deepEqual(exportedTypes(declarations), PUBLIC_RUNTIME_TYPES);
});

function exportedTypes(declarations) {
  const types = [];
  for (const statement of declarations.matchAll(
    /export( type)? \{([^}]+)\}/g,
  )) {
    for (const raw of statement[2].split(",")) {
      const specifier = raw.trim();
      if (!specifier) continue;
      if (statement[1] || specifier.startsWith("type ")) {
        types.push(
          specifier.replace(/^type\s+/, "").split(/\s+as\s+/)[1] ??
            specifier.replace(/^type\s+/, ""),
        );
      }
    }
  }
  return types.sort();
}
