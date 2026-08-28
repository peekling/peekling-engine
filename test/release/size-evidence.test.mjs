import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCanonicalSizeMeasurement,
  assertSizeEvidence,
  CANONICAL_SIZE_NODE_VERSION,
  CANONICAL_SIZE_NPM_VERSION,
  formatSizeEvidenceSummary,
  measureBrowserDelivery,
  SIZE_EVIDENCE_END,
  SIZE_EVIDENCE_START,
} from "../../scripts/size-evidence.mjs";

test("release size verification rejects the toolchain before stale provenance", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "peekling-release-size-order-"),
  );
  try {
    const runtime = Buffer.from("console.log('current')");
    const stylesheet = Buffer.from(".current{display:block}");
    const recordedRuntime = Buffer.from("console.log('recorded')");
    const recordedStylesheet = Buffer.from(".recorded{display:block}");
    const record = canonicalRecord(recordedRuntime, recordedStylesheet);
    await mkdir(path.join(root, "packages/runtime/dist"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "packages/runtime/dist/peekling.min.js"),
      runtime,
    );
    await writeFile(
      path.join(root, "packages/runtime/dist/peekling.css"),
      stylesheet,
    );
    await writeFile(
      path.join(root, "packages/runtime/package.json"),
      '{"dependencies":{}}\n',
    );
    await writeFile(
      path.join(root, "scripts/browser-size-evidence.json"),
      `${JSON.stringify(record)}\n`,
    );
    await writeFile(path.join(root, "README.md"), "stale evidence\n");
    await writeFile(
      path.join(root, "packages/runtime/README.md"),
      "stale evidence\n",
    );

    const result = spawnSync(
      process.execPath,
      [
        new URL("../../scripts/check-size.mjs", import.meta.url).pathname,
        "--canonical",
      ],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    const npmVersion = execFileSync("npm", ["--version"], {
      encoding: "utf8",
    }).trim();
    if (process.versions.node !== CANONICAL_SIZE_NODE_VERSION) {
      assert.match(result.stderr, /requires Node 22\.14\.0/);
      assert.doesNotMatch(result.stderr, /artifact identity/);
    } else if (npmVersion !== CANONICAL_SIZE_NPM_VERSION) {
      assert.match(result.stderr, /requires npm 11\.16\.0/);
      assert.doesNotMatch(result.stderr, /artifact identity/);
    } else {
      assert.match(result.stderr, /artifact identity/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release provenance binds canonical artifacts and controlled documentation", () => {
  const runtime = Buffer.from("console.log('release')");
  const stylesheet = Buffer.from(".release{display:block}");
  const record = canonicalRecord(runtime, stylesheet);
  const evidence = assertCanonicalSizeMeasurement(
    record,
    runtime,
    stylesheet,
    CANONICAL_SIZE_NODE_VERSION,
    CANONICAL_SIZE_NPM_VERSION,
  );
  const documented = `${SIZE_EVIDENCE_START}\n${formatSizeEvidenceSummary(evidence)}\n${SIZE_EVIDENCE_END}`;

  assert.match(documented, /recorded canonical delivery measurement/);
  assert.doesNotMatch(documented, /current measured delivery/);
  assert.doesNotThrow(() =>
    assertSizeEvidence(documented, evidence, "summary", "fixture.md"),
  );
  assert.throws(
    () =>
      assertSizeEvidence(
        documented.replace(String(evidence.gzipBytes), "1"),
        evidence,
        "summary",
        "fixture.md",
      ),
    /does not match the measured browser delivery/,
  );
});

function canonicalRecord(runtime, stylesheet) {
  const measured = measureBrowserDelivery(runtime, stylesheet);
  return {
    schemaVersion: 1,
    toolchain: {
      node: CANONICAL_SIZE_NODE_VERSION,
      npm: CANONICAL_SIZE_NPM_VERSION,
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
}
