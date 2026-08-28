import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";

import {
  BROWSER_BROTLI_LIMIT,
  BROWSER_GZIP_LIMIT,
  BROWSER_RELEASE_HEADROOM,
} from "./budgets.mjs";

export const PUBLIC_SIZE_EVIDENCE_LOCATIONS = Object.freeze([
  Object.freeze({ path: "README.md", format: "summary" }),
  Object.freeze({ path: "packages/runtime/README.md", format: "summary" }),
]);
export const SIZE_EVIDENCE_START = "<!-- peekling-size-evidence:start -->";
export const SIZE_EVIDENCE_END = "<!-- peekling-size-evidence:end -->";
export const CANONICAL_SIZE_NODE_VERSION = "22.14.0";
export const CANONICAL_SIZE_NPM_VERSION = "11.16.0";
export const CANONICAL_SIZE_COMPRESSION = "node:zlib defaults";

export function measureBrowserDelivery(runtime, stylesheet) {
  const completeRuntime = Buffer.concat([runtime, stylesheet]);
  return evidenceFromMeasurements(
    runtime.byteLength,
    stylesheet.byteLength,
    gzipSync(completeRuntime).byteLength,
    brotliCompressSync(completeRuntime).byteLength,
  );
}

export function canonicalEvidenceFromRecord(record, runtime, stylesheet) {
  const evidence = canonicalEvidenceMetadataFromRecord(record);
  if (
    record.artifacts.runtimeBytes !== runtime.byteLength ||
    record.artifacts.stylesheetBytes !== stylesheet.byteLength ||
    record.artifacts.runtimeSha256 !== sha256(runtime) ||
    record.artifacts.stylesheetSha256 !== sha256(stylesheet)
  ) {
    invalidCanonicalRecord("artifact identity");
  }
  return evidence;
}

export function canonicalEvidenceMetadataFromRecord(record) {
  exactKeys(record, ["artifacts", "compressed", "schemaVersion", "toolchain"]);
  if (record.schemaVersion !== 1) invalidCanonicalRecord("schemaVersion");
  exactKeys(record.toolchain, ["compression", "node", "npm"]);
  if (
    record.toolchain.node !== CANONICAL_SIZE_NODE_VERSION ||
    record.toolchain.npm !== CANONICAL_SIZE_NPM_VERSION ||
    record.toolchain.compression !== CANONICAL_SIZE_COMPRESSION
  ) {
    invalidCanonicalRecord("toolchain");
  }
  exactKeys(record.artifacts, [
    "runtimeBytes",
    "runtimePath",
    "runtimeSha256",
    "stylesheetBytes",
    "stylesheetPath",
    "stylesheetSha256",
  ]);
  if (
    record.artifacts.runtimePath !== "packages/runtime/dist/peekling.min.js" ||
    record.artifacts.stylesheetPath !== "packages/runtime/dist/peekling.css"
  ) {
    invalidCanonicalRecord("artifact paths");
  }
  for (const field of ["runtimeBytes", "stylesheetBytes"]) {
    if (
      !Number.isSafeInteger(record.artifacts[field]) ||
      record.artifacts[field] <= 0
    ) {
      invalidCanonicalRecord(`artifacts.${field}`);
    }
  }
  for (const field of ["runtimeSha256", "stylesheetSha256"]) {
    if (!/^[0-9a-f]{64}$/.test(record.artifacts[field])) {
      invalidCanonicalRecord(`artifacts.${field}`);
    }
  }
  exactKeys(record.compressed, ["brotliBytes", "gzipBytes"]);
  for (const field of ["gzipBytes", "brotliBytes"]) {
    if (
      !Number.isSafeInteger(record.compressed[field]) ||
      record.compressed[field] <= 0
    ) {
      invalidCanonicalRecord(`compressed.${field}`);
    }
  }
  const evidence = evidenceFromMeasurements(
    record.artifacts.runtimeBytes,
    record.artifacts.stylesheetBytes,
    record.compressed.gzipBytes,
    record.compressed.brotliBytes,
  );
  if (
    evidence.gzipReserveSurplusBytes < 0 ||
    evidence.brotliReserveSurplusBytes < 0
  ) {
    invalidCanonicalRecord("release reserve");
  }
  return evidence;
}

export function assertCanonicalSizeToolchain(nodeVersion, npmVersion) {
  if (nodeVersion !== CANONICAL_SIZE_NODE_VERSION) {
    throw new Error(
      `Canonical browser-size certification requires Node ${CANONICAL_SIZE_NODE_VERSION}, found ${nodeVersion}`,
    );
  }
  if (npmVersion !== CANONICAL_SIZE_NPM_VERSION) {
    throw new Error(
      `Canonical browser-size certification requires npm ${CANONICAL_SIZE_NPM_VERSION}, found ${npmVersion}`,
    );
  }
}

export function assertCanonicalSizeMeasurement(
  record,
  runtime,
  stylesheet,
  nodeVersion,
  npmVersion,
) {
  assertCanonicalSizeToolchain(nodeVersion, npmVersion);
  const recorded = canonicalEvidenceFromRecord(record, runtime, stylesheet);
  const measured = measureBrowserDelivery(runtime, stylesheet);
  if (
    measured.gzipBytes !== recorded.gzipBytes ||
    measured.brotliBytes !== recorded.brotliBytes
  ) {
    throw new Error(
      "Canonical size evidence does not match the current browser delivery",
    );
  }
  return recorded;
}

function evidenceFromMeasurements(
  runtimeBytes,
  stylesheetBytes,
  gzipBytes,
  brotliBytes,
) {
  const gzipHeadroomBytes = BROWSER_GZIP_LIMIT - gzipBytes;
  const brotliHeadroomBytes = BROWSER_BROTLI_LIMIT - brotliBytes;
  return Object.freeze({
    runtimeBytes,
    stylesheetBytes,
    gzipBytes,
    brotliBytes,
    gzipLimitBytes: BROWSER_GZIP_LIMIT,
    brotliLimitBytes: BROWSER_BROTLI_LIMIT,
    releaseReserveBytes: BROWSER_RELEASE_HEADROOM,
    gzipHeadroomBytes,
    brotliHeadroomBytes,
    gzipReserveSurplusBytes: gzipHeadroomBytes - BROWSER_RELEASE_HEADROOM,
    brotliReserveSurplusBytes: brotliHeadroomBytes - BROWSER_RELEASE_HEADROOM,
  });
}

export function formatSizeEvidenceSummary(evidence) {
  return `The recorded canonical delivery measurement is ${number(evidence.gzipBytes)} bytes gzip and ${number(evidence.brotliBytes)} bytes Brotli. Against the ${kib(evidence.gzipLimitBytes)} gzip and ${kib(evidence.brotliLimitBytes)} Brotli caps, that recorded build leaves ${number(evidence.gzipHeadroomBytes)} bytes of gzip headroom and ${number(evidence.brotliHeadroomBytes)} bytes of Brotli headroom. After the required ${number(evidence.releaseReserveBytes)}-byte reserve, ${number(evidence.gzipReserveSurplusBytes)} gzip bytes and ${number(evidence.brotliReserveSurplusBytes)} Brotli bytes remain for that build.`;
}

export function formatSizeEvidenceTable(evidence) {
  return [
    `| Format | Measured total | Hard cap | Cap headroom | Reserve beyond required ${number(evidence.releaseReserveBytes)} bytes |`,
    "| ------ | -------------: | -------: | -----------: | --------------------------------: |",
    `| gzip   |       ${number(evidence.gzipBytes)} B |   ${kib(evidence.gzipLimitBytes)} |        ${number(evidence.gzipHeadroomBytes)} B |                              ${number(evidence.gzipReserveSurplusBytes)} B |`,
    `| Brotli |       ${number(evidence.brotliBytes)} B |   ${kib(evidence.brotliLimitBytes)} |        ${number(evidence.brotliHeadroomBytes)} B |                             ${number(evidence.brotliReserveSurplusBytes)} B |`,
  ].join("\n");
}

export function assertSizeEvidence(text, evidence, format, label) {
  if (format !== "summary" && format !== "table") {
    throw new Error(`Unknown size evidence format for ${label}`);
  }
  const starts = indexesOf(text, SIZE_EVIDENCE_START);
  const ends = indexesOf(text, SIZE_EVIDENCE_END);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error(
      `Published size evidence in ${label} must contain one controlled marker block`,
    );
  }

  const expected =
    format === "table"
      ? formatSizeEvidenceTable(evidence)
      : formatSizeEvidenceSummary(evidence);
  const body = text.slice(starts[0] + SIZE_EVIDENCE_START.length, ends[0]);
  if (normalize(body) !== normalize(expected)) {
    throw new Error(
      `Published size evidence in ${label} does not match the measured browser delivery`,
    );
  }

  const unmarked = `${text.slice(0, starts[0])}${text.slice(
    ends[0] + SIZE_EVIDENCE_END.length,
  )}`;
  const uncontrolled = currentDeliverySizeClaims(unmarked);
  if (uncontrolled.length > 0) {
    throw new Error(
      `Published size evidence in ${label} has uncontrolled current byte-size claims: ${uncontrolled.join(", ")}`,
    );
  }
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function kib(value) {
  if (value % 1024 !== 0) return `${number(value)} bytes`;
  return `${value / 1024} KiB`;
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

function indexesOf(source, needle) {
  const result = [];
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    result.push(offset);
    offset += needle.length;
  }
  return result;
}

function currentDeliverySizeClaims(source) {
  const claims = [];
  const blocks = markdownBlocks(source);
  let activeHeading = "";
  for (const [index, block] of blocks.entries()) {
    if (block.kind === "heading") activeHeading = block.text;
    const values = [...block.text.matchAll(BYTE_VALUE_PATTERN)];
    if (values.length === 0) continue;

    const previous = blocks[index - 1]?.text ?? "";
    const context = normalize(
      [activeHeading, previous, block.text].filter(Boolean).join(" "),
    );
    if (!isCurrentDeliveryContext(context)) continue;
    for (const match of values) {
      claims.push(normalize(match[0]));
    }
  }
  return claims;
}

const BYTE_VALUE_PATTERN =
  /\b(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.\d+)?\s*(?:-\s*)?(?:(?:gzip|brotli)\s+)?(?:bytes?|KiB|B)\b/gi;

function markdownBlocks(source) {
  const blocks = [];
  let paragraph = [];
  let fence;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: markdownText(paragraph.join(" ")) });
    paragraph = [];
  };

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    let line = rawLine.replace(/^\s{0,3}(?:>\s?)+/, "");
    if (fence) {
      const closing = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      ) {
        blocks.push({
          kind: "fence",
          text: markdownText(fence.lines.join(" ")),
        });
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})(?:\s*.*)?$/);
    if (opening) {
      flushParagraph();
      fence = {
        marker: opening[1][0],
        length: opening[1].length,
        lines: [],
      };
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", text: markdownText(heading[1]) });
      continue;
    }
    if (/^\s{0,3}(?:=+|-+)\s*$/.test(line) && paragraph.length > 0) {
      blocks.push({ kind: "heading", text: markdownText(paragraph.join(" ")) });
      paragraph = [];
      continue;
    }

    line = line.replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "");
    paragraph.push(line);
  }

  if (fence) {
    blocks.push({ kind: "fence", text: markdownText(fence.lines.join(" ")) });
  }
  flushParagraph();
  return blocks;
}

function markdownText(value) {
  let result = value;
  for (let pass = 0; pass < 3; pass += 1) {
    result = result
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  }
  return normalize(
    result
      .replace(/(`+)([\s\S]*?)\1/g, "$2")
      .replace(/<[^>]+>/g, " ")
      .replace(/\\([\\`*_[\]{}()#+.!>~-])/g, "$1")
      .replace(/[\*_~]+/g, " "),
  );
}

function isCurrentDeliveryContext(context) {
  if (
    !/\b(?:runtime|stylesheet|artifact|delivery|browser|bundle|css|javascript|gzip|brotli|size|compressed|compression)\b/i.test(
      context,
    )
  ) {
    return false;
  }
  if (/\bcurrent(?:ly)?\b/i.test(context)) return true;
  if (
    /\b(?:historical|formerly|previous(?:ly)?|prior|old|prototype|superseded|earlier)\b/i.test(
      context,
    )
  ) {
    return false;
  }
  return (
    /\b(?:validated|measured|certified)\b[\s\S]{0,160}\b(?:runtime|stylesheet|artifact|delivery|browser|bundle|gzip|brotli|result|size)\b/i.test(
      context,
    ) ||
    /\b(?:runtime|stylesheet|artifact|delivery|browser|bundle|gzip|brotli|result|size)\b[\s\S]{0,120}\b(?:is|are|measures?|totals?|weighs?|uses)\b/i.test(
      context,
    )
  );
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidCanonicalRecord("shape");
  }
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidCanonicalRecord("keys");
  }
}

function invalidCanonicalRecord(field) {
  throw new Error(`Canonical size evidence record has invalid ${field}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
