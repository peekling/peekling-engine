import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

test("the browser entry remains loadable when no CSS integrity define is injected", async () => {
  const result = await build({
    entryPoints: ["packages/runtime/src/browser.ts"],
    bundle: true,
    define: {
      __PEEKLING_COMPACT_ERRORS__: "false",
      __PEEK_PACK_URL__: JSON.stringify(
        "https://example.test/@peekling/pack-peek/character.json",
      ),
    },
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const context = vm.createContext({
    URL,
    document: {
      currentScript: { src: "https://example.test/peekling.js" },
    },
  });
  Object.assign(context, {
    globalThis: context,
    window: context,
  });

  assert.doesNotThrow(() =>
    vm.runInContext(result.outputFiles[0].text, context),
  );
  assert.equal(typeof context.Peekling?.hatch, "function");
});
