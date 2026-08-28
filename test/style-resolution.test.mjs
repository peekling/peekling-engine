import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

async function stylesModule({ browserBuild, moduleUrl }) {
  const output = await build({
    entryPoints: ["packages/runtime/src/styles.ts"],
    bundle: true,
    define: {
      __PEEKLING_BROWSER_BUILD__: String(browserBuild),
      __PEEKLING_COMPACT_ERRORS__: "false",
      "import.meta.url": JSON.stringify(moduleUrl),
    },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );
}

test("the ESM stylesheet default resolves beside the runtime module", async () => {
  const { resolveStyleAsset } = await stylesModule({
    browserBuild: false,
    moduleUrl: "https://cdn.example/@peekling/runtime/dist/styles.js",
  });

  assert.deepEqual(
    resolveStyleAsset(undefined, "https://app.example/nested/page/"),
    { url: "https://cdn.example/@peekling/runtime/dist/peekling.css" },
  );
});

test("an unusable ESM module URL asks for an explicit stylesheet", async () => {
  const { resolveStyleAsset } = await stylesModule({
    browserBuild: false,
    moduleUrl: "data:text/javascript,export{}",
  });

  assert.throws(
    () => resolveStyleAsset(undefined, "https://app.example/"),
    /Pass styles\.url pointing to @peekling\/runtime\/peekling\.css/,
  );
});

test("the classic browser build preserves its configured and page fallbacks", async () => {
  const configured = await stylesModule({
    browserBuild: true,
    moduleUrl: "data:text/javascript,unused",
  });
  configured.setBrowserStyleAsset({
    url: "https://static.example/runtime/peekling.css",
    integrity: "sha384-YWJj",
  });
  assert.deepEqual(
    configured.resolveStyleAsset(undefined, "https://app.example/nested/"),
    {
      url: "https://static.example/runtime/peekling.css",
      integrity: "sha384-YWJj",
    },
  );

  const fallback = await stylesModule({
    browserBuild: true,
    moduleUrl: "data:text/javascript,unused-fallback",
  });
  assert.deepEqual(
    fallback.resolveStyleAsset(undefined, "https://app.example/nested/"),
    { url: "https://app.example/nested/peekling.css" },
  );
});
