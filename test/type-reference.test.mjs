import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the human TypeScript references compile without runtime dependencies", () => {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--lib",
      "ES2022,DOM",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "docs/schema/peekling-options-v0.1.d.ts",
      "docs/schema/peekling-javascript-extensions-v0.1.d.ts",
      "test/type-contract.assert.ts",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
