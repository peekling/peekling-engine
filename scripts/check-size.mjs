import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  BROWSER_BROTLI_LIMIT,
  BROWSER_GZIP_LIMIT,
  BROWSER_RELEASE_HEADROOM,
} from "./budgets.mjs";
import {
  assertCanonicalSizeToolchain,
  assertCanonicalSizeMeasurement,
  assertSizeEvidence,
  CANONICAL_SIZE_NODE_VERSION,
  CANONICAL_SIZE_NPM_VERSION,
  measureBrowserDelivery,
  PUBLIC_SIZE_EVIDENCE_LOCATIONS,
} from "./size-evidence.mjs";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--canonical") || args.length > 1) {
  throw new Error(`Unknown browser-size option: ${args.join(" ")}`);
}
const requireCanonical = args.includes("--canonical");
const npmVersion = execFileSync("npm", ["--version"], {
  encoding: "utf8",
}).trim();
if (requireCanonical) {
  assertCanonicalSizeToolchain(process.versions.node, npmVersion);
}
const runtime = await readFile("packages/runtime/dist/peekling.min.js");
const stylesheet = await readFile("packages/runtime/dist/peekling.css");
const localEvidence = measureBrowserDelivery(runtime, stylesheet);
let canonicalEvidence;
if (requireCanonical) {
  const record = JSON.parse(
    await readFile("scripts/browser-size-evidence.json", "utf8"),
  );
  canonicalEvidence = assertCanonicalSizeMeasurement(
    record,
    runtime,
    stylesheet,
    process.versions.node,
    npmVersion,
  );
  for (const { path, format } of PUBLIC_SIZE_EVIDENCE_LOCATIONS) {
    assertSizeEvidence(
      await readFile(path, "utf8"),
      canonicalEvidence,
      format,
      path,
    );
  }
}

console.log(
  JSON.stringify(
    {
      mode: requireCanonical ? "canonical" : "local",
      canonicalMeasurement: requireCanonical,
      canonicalToolchain: {
        node: CANONICAL_SIZE_NODE_VERSION,
        npm: CANONICAL_SIZE_NPM_VERSION,
      },
      localToolchain: { node: process.versions.node, npm: npmVersion },
      runtimeBytes: localEvidence.runtimeBytes,
      stylesheetBytes: localEvidence.stylesheetBytes,
      completeRuntimeGzipBytes: localEvidence.gzipBytes,
      completeRuntimeBrotliBytes: localEvidence.brotliBytes,
      gzipHeadroomBytes: localEvidence.gzipHeadroomBytes,
      brotliHeadroomBytes: localEvidence.brotliHeadroomBytes,
      gzipReserveSurplusBytes: localEvidence.gzipReserveSurplusBytes,
      brotliReserveSurplusBytes: localEvidence.brotliReserveSurplusBytes,
      localCompleteRuntimeGzipBytes: localEvidence.gzipBytes,
      localCompleteRuntimeBrotliBytes: localEvidence.brotliBytes,
    },
    null,
    2,
  ),
);

if (localEvidence.gzipBytes > BROWSER_GZIP_LIMIT)
  throw new Error(
    `Runtime plus CSS gzip ${localEvidence.gzipBytes} exceeds ${formatBytes(BROWSER_GZIP_LIMIT)}`,
  );
if (localEvidence.brotliBytes > BROWSER_BROTLI_LIMIT)
  throw new Error(
    `Runtime plus CSS brotli ${localEvidence.brotliBytes} exceeds ${formatBytes(BROWSER_BROTLI_LIMIT)}`,
  );
if (localEvidence.gzipBytes > BROWSER_GZIP_LIMIT - BROWSER_RELEASE_HEADROOM)
  throw new Error(
    `Runtime plus CSS gzip ${localEvidence.gzipBytes} leaves less than ${BROWSER_RELEASE_HEADROOM} bytes of release headroom`,
  );
if (localEvidence.brotliBytes > BROWSER_BROTLI_LIMIT - BROWSER_RELEASE_HEADROOM)
  throw new Error(
    `Runtime plus CSS brotli ${localEvidence.brotliBytes} leaves less than ${BROWSER_RELEASE_HEADROOM} bytes of release headroom`,
  );

const runtimePackage = JSON.parse(
  await readFile("packages/runtime/package.json", "utf8"),
);
if (Object.keys(runtimePackage.dependencies ?? {}).length > 0)
  throw new Error("@peekling/runtime must have zero production dependencies");

function formatBytes(value) {
  return value % 1024 === 0 ? `${value / 1024} KiB` : `${value} bytes`;
}
