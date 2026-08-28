import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { minify } from "terser";

async function bundleValidation(compact) {
  const result = await build({
    entryPoints: ["packages/runtime/src/configuration-validation.ts"],
    write: false,
    bundle: true,
    define: {
      __PEEKLING_COMPACT_ERRORS__: String(compact),
    },
    format: "esm",
    legalComments: "none",
    minifySyntax: true,
    platform: "browser",
    target: ["es2022"],
  });
  const compacted = await minify(result.outputFiles[0].text, {
    ecma: 2022,
    module: true,
    compress: { passes: 3, toplevel: true },
    mangle: true,
  });
  assert.ok(compacted.code);
  return compacted.code;
}

test("the compact browser validator omits collector recovery branches", async () => {
  const [browser, collector] = await Promise.all([
    bundleValidation(true),
    bundleValidation(false),
  ]);

  assert.ok(
    browser.length <= collector.length - 100,
    `compact validator saved ${collector.length - browser.length} raw bytes`,
  );
});
