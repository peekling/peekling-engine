import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  BROWSER_BROTLI_LIMIT,
  BROWSER_GZIP_LIMIT,
  BROWSER_RELEASE_HEADROOM,
} from "../scripts/budgets.mjs";

test("the complete measured browser delivery stays within its release budget", async () => {
  const runtime = await readFile("packages/runtime/dist/peekling.min.js");
  const stylesheet = await readFile("packages/runtime/dist/peekling.css");
  const completeRuntime = Buffer.concat([runtime, stylesheet]);

  assert.ok(
    gzipSync(completeRuntime).byteLength <=
      BROWSER_GZIP_LIMIT - BROWSER_RELEASE_HEADROOM,
  );
  assert.ok(
    brotliCompressSync(completeRuntime).byteLength <=
      BROWSER_BROTLI_LIMIT - BROWSER_RELEASE_HEADROOM,
  );
  assert.equal(BROWSER_RELEASE_HEADROOM, 256);
  assert.deepEqual(Object.keys(await import("../scripts/budgets.mjs")).sort(), [
    "BROWSER_BROTLI_LIMIT",
    "BROWSER_GZIP_LIMIT",
    "BROWSER_RELEASE_HEADROOM",
  ]);
});

test("the local size verifier measures current artifacts without release provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "peekling-size-evidence-"));
  try {
    await mkdir(path.join(root, "packages/runtime/dist"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    const runtime = Buffer.from("console.log('local fixture')");
    const stylesheet = Buffer.from(".peekling-local{display:block}");
    await writeFile(
      path.join(root, "packages/runtime/dist/peekling.min.js"),
      runtime,
    );
    await writeFile(
      path.join(root, "packages/runtime/dist/peekling.css"),
      stylesheet,
    );
    const recordedRuntime = Buffer.from("console.log('recorded fixture')");
    const recordedStylesheet = Buffer.from(".peekling-recorded{display:block}");
    const completeRuntime = Buffer.concat([
      recordedRuntime,
      recordedStylesheet,
    ]);
    await writeFile(
      path.join(root, "scripts/browser-size-evidence.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        toolchain: {
          node: "22.14.0",
          npm: "11.16.0",
          compression: "node:zlib defaults",
        },
        artifacts: {
          runtimePath: "packages/runtime/dist/peekling.min.js",
          stylesheetPath: "packages/runtime/dist/peekling.css",
          runtimeBytes: recordedRuntime.byteLength,
          stylesheetBytes: recordedStylesheet.byteLength,
          runtimeSha256: createHash("sha256")
            .update(recordedRuntime)
            .digest("hex"),
          stylesheetSha256: createHash("sha256")
            .update(recordedStylesheet)
            .digest("hex"),
        },
        compressed: {
          gzipBytes: gzipSync(completeRuntime).byteLength,
          brotliBytes: brotliCompressSync(completeRuntime).byteLength,
        },
      })}\n`,
    );
    await writeFile(
      path.join(root, "packages/runtime/package.json"),
      '{"dependencies":{}}\n',
    );
    await writeFile(
      path.join(root, "README.md"),
      "Current measured delivery is 1 byte gzip and 1 byte Brotli.\n",
    );
    await writeFile(
      path.join(root, "packages/runtime/README.md"),
      "Current measured delivery is 1 byte gzip and 1 byte Brotli.\n",
    );

    const result = spawnSync(
      process.execPath,
      [new URL("../scripts/check-size.mjs", import.meta.url).pathname],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /localCompleteRuntimeGzipBytes/);
    assert.doesNotMatch(result.stdout, /canonicalMeasurement": true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
