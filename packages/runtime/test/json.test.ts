import assert from "node:assert/strict";
import test from "node:test";
import { PackValidationError } from "../dist/errors.js";
import { parseDataText } from "../dist/pack-api.js";

test("deep JSON returns a bounded validation error instead of overflowing", () => {
  const text = `${"[".repeat(128)}0${"]".repeat(128)}`;

  assert.throws(
    () => parseDataText(text, "configuration"),
    (error) => {
      assert.ok(error instanceof PackValidationError);
      assert.match(error.message, /nesting exceeds 64 levels/);
      assert.doesNotMatch(
        error.stack ?? "",
        /Maximum call stack size exceeded/,
      );
      return true;
    },
  );
});

test("invalid JSON retains a stable structured issue code", () => {
  assert.throws(
    () => parseDataText("{", "configuration"),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["configuration.json"]);
      assert.deepEqual(error.issues, ["configuration is not valid JSON"]);
      return true;
    },
  );
});
