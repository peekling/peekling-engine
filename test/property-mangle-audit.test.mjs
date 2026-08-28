import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { minify } from "terser";

import { auditPropertyMangles } from "../scripts/property-mangle-audit.mjs";

test("property mangle audit follows Terser's actual candidate set", () => {
  const candidateCache = { props: { props: { $wake: "o" } } };

  assert.doesNotThrow(() =>
    auditPropertyMangles(
      ["clear"],
      "value.clear()",
      "value.clear()",
      {},
      candidateCache,
    ),
  );
  assert.doesNotThrow(() =>
    auditPropertyMangles(
      ["wake"],
      'value["wake"]()',
      'value["wake"]()',
      {},
      candidateCache,
    ),
  );
  assert.throws(
    () =>
      auditPropertyMangles(
        ["wake"],
        "value.wake()",
        "value.wake()",
        {},
        candidateCache,
      ),
    /was not mapped/,
  );
  assert.throws(
    () =>
      auditPropertyMangles(
        ["wake"],
        "value.wake()",
        "value.wake()",
        { props: { props: { $wake: "o" } } },
        candidateCache,
      ),
    /remains in the minified artifact/,
  );
  assert.throws(
    () =>
      auditPropertyMangles(
        ["wake"],
        "value.wake()",
        'value["wake"]()',
        { props: { props: { $wake: "o" } } },
        candidateCache,
      ),
    /remains in the minified artifact/,
  );
});

test("quoted property access reserves the same unquoted property", async () => {
  const nameCache = {};
  const compact = await minify(
    'const value={peeklingInternal(){return 1}};value.peeklingInternal();value["peeklingInternal"]();',
    {
      compress: false,
      mangle: {
        properties: {
          keep_quoted: true,
          regex: /^peeklingInternal$/,
        },
      },
      nameCache,
    },
  );

  assert.equal(nameCache.props?.props?.$peeklingInternal, undefined);
  assert.match(compact.code ?? "", /\.peeklingInternal\(\)/);
  assert.match(compact.code ?? "", /\["peeklingInternal"\]\(\)/);
});

test("compact browser compression preserves booleans and uses the measured safe profile", async () => {
  const build = await readFile("scripts/build.mjs", "utf8");

  assert.match(build, /inline:\s*1/);
  assert.match(build, /passes:\s*5/);
  assert.match(build, /negate_iife:\s*false/);
  assert.doesNotMatch(build, /booleans_as_integers/);
  assert.match(build, /keep_quoted:\s*true/);
  assert.doesNotMatch(build, /keep_quoted:\s*["']strict["']/);
});
