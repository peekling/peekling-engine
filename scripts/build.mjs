import { rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { minify } from "terser";
import { auditPropertyMangles } from "./property-mangle-audit.mjs";
import {
  PUBLISHABLE_PACKAGES,
  WORKSPACE_VERSION,
} from "./workspace-metadata.mjs";

const MANGLED_RUNTIME_PROPERTIES = Object.freeze([
  "atlasObjectUrl",
  "captureReaction",
  "characterSize",
  "choose",
  "clear",
  "closedSessions",
  "complete",
  "consumeReaction",
  "current",
  "currentId",
  "custom",
  "deadline",
  "densityOverride",
  "diagnostic",
  "failedKey",
  "generation",
  "geometry",
  "image",
  "lastActivityAt",
  "loadedDensity",
  "lockedRequest",
  "maxDistance",
  "mirrored",
  "mounted",
  "nextFrameIn",
  "nextWakeAt",
  "objectUrl",
  "observeEvent",
  "pendingUpdate",
  "patrolDirection",
  "positionStyle",
  "previousRatio",
  "ratio",
  "reactionId",
  "reactions",
  "rebase",
  "release",
  "render",
  "renderKey",
  "renderScale",
  "renderSurfaces",
  "reset",
  "revisions",
  "setHidden",
  "setSuspended",
  "snapshot",
  "startedAt",
  "swapAtlas",
  "updateComponentName",
  "upgrade",
  "wake",
]);
const mangledRuntimePropertyPattern = new RegExp(
  `^(?:${MANGLED_RUNTIME_PROPERTIES.join("|")})$`,
);

for (const { directory: name } of PUBLISHABLE_PACKAGES) {
  await rm(new URL(`../packages/${name}/dist`, import.meta.url), {
    recursive: true,
    force: true,
  });
  execFileSync(
    process.execPath,
    [
      new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
      "-b",
      `packages/${name}`,
    ],
    { stdio: "inherit" },
  );
}

const { characterPackReference } =
  await import("../packages/runtime/dist/registry.js");
const peekReference = characterPackReference("peek");

const cssBuild = await build({
  entryPoints: ["packages/runtime/src/peekling.css"],
  write: false,
  minify: true,
});
const browserCss = cssBuild.outputFiles[0].text;
await writeFile("packages/runtime/dist/peekling.css", browserCss);
const cssIntegrity = `sha256-${createHash("sha256").update(browserCss).digest("base64")}`;
await writeFile("packages/runtime/dist/peekling.css.sri", `${cssIntegrity}\n`);

const browserOptions = {
  entryPoints: ["packages/runtime/src/browser.ts"],
  write: false,
  bundle: true,
  define: {
    __PEEKLING_BROWSER_BUILD__: "true",
    __PEEKLING_COMPACT_ERRORS__: "true",
    __PEEK_PACK_URL__: JSON.stringify(peekReference.url),
    __PEEK_PACK_SHA256__: JSON.stringify(peekReference.sha256),
    __PEEKLING_CSS_INTEGRITY__: JSON.stringify(cssIntegrity),
  },
  format: "iife",
  legalComments: "eof",
  platform: "browser",
  target: ["es2022"],
};
const readableBuild = await build(browserOptions);
const readableBanner = `/*! @peekling/runtime ${WORKSPACE_VERSION} | Copyright 2026 Prajwal S. Venkateshmurthy | Apache-2.0 */\n`;
const readableArtifact = `${readableBanner}${readableBuild.outputFiles[0].text}`;
await writeFile("packages/runtime/dist/peekling.js", readableArtifact);
const readableIntegrity = `sha384-${createHash("sha384").update(readableArtifact).digest("base64")}`;
await writeFile(
  "packages/runtime/dist/peekling.js.sri",
  `${readableIntegrity}\n`,
);

const browserBuild = await build({ ...browserOptions, minify: true });
const propertyCandidateCache = {};
await minify(
  `function peeklingPropertyCandidates(value){return [${MANGLED_RUNTIME_PROPERTIES.map(
    (property) => `value.${property}`,
  ).join(",")}]}`,
  {
    ecma: 2022,
    module: true,
    compress: false,
    mangle: {
      eval: true,
      toplevel: true,
      properties: {
        keep_quoted: true,
        regex: mangledRuntimePropertyPattern,
      },
    },
    nameCache: propertyCandidateCache,
  },
);
const propertyNameCache = {};
const compact = await minify(browserBuild.outputFiles[0].text, {
  ecma: 2022,
  module: true,
  compress: {
    ecma: 2022,
    hoist_funs: true,
    inline: 1,
    negate_iife: false,
    passes: 5,
    pure_getters: true,
    sequences: false,
    toplevel: true,
    unsafe: true,
    unsafe_arrows: true,
    unsafe_math: true,
    unsafe_methods: true,
    unsafe_undefined: true,
  },
  mangle: {
    eval: true,
    toplevel: true,
    properties: {
      keep_quoted: true,
      regex: mangledRuntimePropertyPattern,
    },
  },
  nameCache: propertyNameCache,
});
if (!compact.code) throw new Error("Browser minifier returned no output");
auditPropertyMangles(
  MANGLED_RUNTIME_PROPERTIES,
  browserBuild.outputFiles[0].text,
  compact.code,
  propertyNameCache,
  propertyCandidateCache,
);
const browserArtifact = `/*!Apache-2.0*/\n${compact.code}`;
await writeFile("packages/runtime/dist/peekling.min.js", browserArtifact);
const integrity = `sha384-${createHash("sha384").update(browserArtifact).digest("base64")}`;
await writeFile("packages/runtime/dist/peekling.min.js.sri", `${integrity}\n`);
