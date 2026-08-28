import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as sizeEvidence from "../scripts/size-evidence.mjs";

test("canonical browser-size evidence validates explicit immutable inputs", () => {
  assert.equal(
    typeof sizeEvidence.assertCanonicalSizeToolchain,
    "function",
    "the canonical toolchain guard is missing",
  );
  assert.equal(
    typeof sizeEvidence.canonicalEvidenceMetadataFromRecord,
    "function",
    "the canonical evidence metadata validator is missing",
  );
  assert.equal(
    typeof sizeEvidence.canonicalEvidenceFromRecord,
    "function",
    "the canonical evidence record validator is missing",
  );

  const runtime = Buffer.from("console.log('canonical fixture')");
  const stylesheet = Buffer.from(".peekling{display:block}");
  const measured = sizeEvidence.measureBrowserDelivery(runtime, stylesheet);
  const record = {
    schemaVersion: 1,
    toolchain: {
      node: "22.14.0",
      npm: "11.16.0",
      compression: "node:zlib defaults",
    },
    artifacts: {
      runtimePath: "packages/runtime/dist/peekling.min.js",
      stylesheetPath: "packages/runtime/dist/peekling.css",
      runtimeBytes: runtime.byteLength,
      stylesheetBytes: stylesheet.byteLength,
      runtimeSha256: createHash("sha256").update(runtime).digest("hex"),
      stylesheetSha256: createHash("sha256").update(stylesheet).digest("hex"),
    },
    compressed: {
      gzipBytes: measured.gzipBytes,
      brotliBytes: measured.brotliBytes,
    },
  };
  const canonical = sizeEvidence.canonicalEvidenceFromRecord(
    record,
    runtime,
    stylesheet,
  );

  assert.deepEqual(record.toolchain, {
    node: "22.14.0",
    npm: "11.16.0",
    compression: "node:zlib defaults",
  });
  assert.equal(canonical.gzipBytes, measured.gzipBytes);
  assert.equal(canonical.brotliBytes, measured.brotliBytes);
  assert.equal(canonical.releaseReserveBytes, 256);
  assert.deepEqual(
    sizeEvidence.canonicalEvidenceMetadataFromRecord(record),
    canonical,
  );

  assert.doesNotThrow(() =>
    sizeEvidence.assertCanonicalSizeToolchain("22.14.0", "11.16.0"),
  );
  assert.throws(
    () => sizeEvidence.assertCanonicalSizeToolchain("26.3.0", "11.16.0"),
    /Node 22\.14\.0/,
  );
  assert.throws(
    () => sizeEvidence.assertCanonicalSizeToolchain("22.14.0", "11.19.0"),
    /npm 11\.16\.0/,
  );

  const changed = structuredClone(record);
  changed.artifacts.runtimeSha256 = "0".repeat(64);
  assert.throws(
    () =>
      sizeEvidence.canonicalEvidenceFromRecord(changed, runtime, stylesheet),
    /canonical size evidence/i,
  );
});

test("CI and release workflows require canonical size certification", async () => {
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  const release = await readFile(".github/workflows/release.yml", "utf8");
  const command = "      - run: npm run size:release\n";
  assert.notEqual(ci.replace(command, ""), ci, "CI lacks the canonical gate");
  assert.notEqual(
    release.replace(command, ""),
    release,
    "release workflow lacks the canonical gate",
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "peekling-size-workflow-"));
  try {
    for (const [name, source] of [
      ["ci", ci],
      ["release", release],
    ]) {
      const file = path.join(root, `${name}.yml`);
      const weakened = source.replace(command, "");
      const args =
        name === "ci"
          ? ["--ci", file, "--release", ".github/workflows/release.yml"]
          : ["--ci", ".github/workflows/ci.yml", "--release", file];
      await writeFile(file, weakened);
      const result = spawnSync(
        process.execPath,
        ["scripts/check-release-workflows.mjs", ...args],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, `${name} mutation passed unexpectedly`);
      assert.match(result.stderr, /canonical size|size:release/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary tests stay toolchain-neutral while release size runs provenance tests", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));

  assert.doesNotMatch(root.scripts.test, /test\/release/);
  assert.match(root.scripts["size:release"], /test\/release\/\*\.test\.mjs/);
});
