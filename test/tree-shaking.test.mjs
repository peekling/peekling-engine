import assert from "node:assert/strict";
import test from "node:test";
import { measureEsmCompositions } from "../scripts/measure-esm.mjs";

test("ESM named imports keep optional integration surfaces separate", async () => {
  const measured = await measureEsmCompositions();
  const modules = (name) => measured[name].modules.join("\n");

  assert.match(modules("hatch"), /runtime\.js/);
  assert.match(modules("hatch"), /plan\.js/);
  assert.doesNotMatch(modules("hatch"), /web-component\.js/);
  assert.doesNotMatch(
    modules("visibility"),
    /(?:runtime|plan|preflight|requests|web-component)\.js/,
  );
  assert.match(modules("webComponent"), /web-component\.js/);
  assert.match(modules("webComponent"), /runtime\.js/);
});
