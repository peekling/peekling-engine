import { readFile } from "node:fs/promises";
import { PUBLISHABLE_PACKAGES } from "./workspace-metadata.mjs";

const args = process.argv.slice(2);
const ciPath = option(args, "--ci") ?? ".github/workflows/ci.yml";
const releasePath =
  option(args, "--release") ?? ".github/workflows/release.yml";
const ci = await readFile(ciPath, "utf8");
const release = await readFile(releasePath, "utf8");
const normalizedCi = ci.replace(/\s+/g, " ");
const failures = [];
const packageOrder = PUBLISHABLE_PACKAGES.map(({ name }) => name);

for (const [name, source] of [
  ["ci.yml", ci],
  ["release.yml", release],
]) {
  for (const line of source.match(/^\s*- uses:\s*.+$/gm) ?? []) {
    if (!/^\s*- uses:\s*[^@\s]+@[0-9a-f]{40}(?:\s*#.*)?\s*$/.test(line)) {
      failures.push(`${name} has an action that is not pinned to a full SHA`);
    }
  }
  if (
    name === "ci.yml" &&
    /secrets\.|NODE_AUTH_TOKEN|npm_[A-Za-z0-9_-]*token/i.test(source)
  ) {
    failures.push(`${name} references a long-lived publish credential`);
  }
  if (
    workflowSteps(source).some((step) =>
      /(?:perf:browser:quick|browser-performance\.mjs\s+--quick)/.test(
        step.normalized,
      ),
    )
  ) {
    failures.push(
      `${name} uses quick performance in a release acceptance step`,
    );
  }
}
const releaseSecrets = [
  ...release.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g),
].map((match) => match[1]);
if (
  releaseSecrets.length !== packageOrder.length ||
  releaseSecrets.some((name) => name !== "NPM_TOKEN")
) {
  failures.push(
    `release.yml may expose only the npm-production NPM_TOKEN to its ${packageOrder.length} publish steps`,
  );
}

for (const required of [
  "node-version: 22.14.0",
  "npm@11.16.0",
  "npx --no-install playwright install --with-deps chromium firefox webkit",
  "npm run check:core",
  "npm run size:release",
  "npm run test:browser",
  "npm run perf:browser -- --output artifacts/browser-performance.json",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "if: ${{ always() }}",
  "path: artifacts/browser-performance.json",
  "retention-days: 30",
  "npm run release:verify:packages",
]) {
  if (!normalizedCi.includes(required))
    failures.push(`ci.yml lacks ${required}`);
}
const ciSteps = workflowSteps(ci);
validateCriticalStepSequence(
  "ci.yml",
  ciSteps,
  [
    ["npm run check:core", "core verification"],
    ["npm run size:release", "canonical size certification"],
    ["npm run release:verify:packages", "package verification"],
    [
      "npx --no-install playwright install --with-deps chromium firefox webkit",
      "browser install",
    ],
    ["npm run test:browser", "browser verification"],
    [
      "npm run perf:browser -- --output artifacts/browser-performance.json",
      "browser performance verification",
    ],
  ],
  "ci.yml critical gates must appear once and in verification order",
  failures,
);
if (workflowJobsHaveProperty(ci, "if")) {
  failures.push("ci.yml critical jobs cannot be conditionally disabled");
}
if (workflowJobsHaveProperty(ci, "continue-on-error")) {
  failures.push("ci.yml critical jobs cannot continue-on-error");
}
if (!/permissions:\n\s+contents: read/.test(ci)) {
  failures.push("ci.yml must default to contents: read");
}
if (/id-token:\s*write/.test(ci)) {
  failures.push("ci.yml must not mint publication identity tokens");
}

const releaseTriggers = release.slice(
  release.indexOf("on:"),
  release.indexOf("\npermissions:"),
);
const normalizedRelease = release.replace(/\s+/g, " ");
const releaseSteps = workflowSteps(release);
if (
  !normalizedRelease.includes(
    'node scripts/verify-release-context.mjs "${{ inputs.tag }}"',
  )
) {
  failures.push("release context is not bound to the reviewed tag workflow");
}

const criticalSteps = [
  ["actions/checkout@", "checkout"],
  [
    'node scripts/verify-release-context.mjs "${{ inputs.tag }}"',
    "release context guard",
  ],
  ["npm install --global npm@11.16.0", "pinned npm install"],
  ["npm ci --ignore-scripts", "dependency install"],
  [
    "npx --no-install playwright install --with-deps chromium firefox webkit",
    "browser install",
  ],
  ["npm run test:peek:published", "published default character verification"],
  ["npm run size:release", "canonical size certification"],
  [
    'npm run release:verify -- --tag "${{ inputs.tag }}" --archive-dir artifacts/release-packages',
    "release verifier",
  ],
  ...packageOrder.map((name) => [
    `node scripts/release-archives.mjs publish --directory artifacts/release-packages --package ${name}`,
    `publish ${name}`,
  ]),
];
validateCriticalStepSequence(
  "release.yml",
  releaseSteps,
  criticalSteps,
  "release.yml critical steps must run in checkout, verification, and dependency publish order",
  failures,
);
if (workflowJobsHaveProperty(release, "if")) {
  failures.push("release.yml publish job cannot be conditionally disabled");
}
if (workflowJobsHaveProperty(release, "continue-on-error")) {
  failures.push("release.yml publish job cannot continue-on-error");
}
if (!/^on:\n\s+workflow_dispatch:/m.test(releaseTriggers)) {
  failures.push("release.yml must be manual workflow_dispatch only");
}
for (const forbidden of [
  /^\s{2}push:/m,
  /^\s{2}release:/m,
  /^\s{2}pull_request:/m,
]) {
  if (forbidden.test(releaseTriggers)) {
    failures.push("release.yml must not publish from an automatic event");
  }
}
for (const required of [
  "contents: read",
  "id-token: write",
  "environment: npm-production",
  "registry-url: https://registry.npmjs.org",
  "node-version: 22.14.0",
  "npm@11.16.0",
  "npx --no-install playwright install --with-deps chromium firefox webkit",
  "npm run test:peek:published",
  "npm run size:release",
  "fetch-depth: 0",
  "ref: ${{ inputs.tag }}",
  'npm run release:verify -- --tag "${{ inputs.tag }}" --archive-dir artifacts/release-packages',
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "if: ${{ always() }}",
  "artifacts/browser-performance.json",
  "artifacts/release-packages/manifest.json",
  "artifacts/release-packages/*.tgz",
  "retention-days: 90",
  ...packageOrder.map(
    (name) =>
      `node scripts/release-archives.mjs publish --directory artifacts/release-packages --package ${name}`,
  ),
]) {
  if (!normalizedRelease.includes(required))
    failures.push(`release.yml lacks ${required}`);
}
const publishOffsets = packageOrder.map((name) =>
  normalizedRelease.indexOf(`--package ${name}`),
);
if (publishOffsets.some((offset) => offset < 0)) {
  failures.push("release.yml has an incomplete package publish order");
} else if (
  publishOffsets.some(
    (offset, index) => index > 0 && offset <= publishOffsets[index - 1],
  )
) {
  failures.push("release.yml publishes packages before their dependencies");
}
if (/npm publish\s+--workspace/.test(normalizedRelease)) {
  failures.push(
    "release.yml must publish verified archives, not rebuild workspaces",
  );
}
if (
  !/concurrency:\n\s+group: peekling-npm-release\n\s+cancel-in-progress: false/.test(
    release,
  )
) {
  failures.push("release.yml must serialize publication attempts");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Peekling workflow safety audit passed.");
}

function option(input, name) {
  const index = input.indexOf(name);
  if (index < 0) return undefined;
  const value = input[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a file path`);
  }
  return value;
}

function workflowSteps(source) {
  const steps = [];
  let current;
  for (const line of source.split(/\r?\n/)) {
    const start = /^(\s*)-\s+(uses|run):/.exec(line);
    if (start) {
      if (current) steps.push(finalizeStep(current));
      current = {
        indentation: start[1].length,
        kind: start[2],
        lines: [line],
      };
      continue;
    }
    if (!current) continue;
    const indentation = /^\s*/.exec(line)[0].length;
    if (line.trim() && indentation <= current.indentation) {
      steps.push(finalizeStep(current));
      current = undefined;
      continue;
    }
    current.lines.push(line);
  }
  if (current) steps.push(finalizeStep(current));
  return steps;
}

function finalizeStep(step) {
  const source = step.lines.join("\n");
  return {
    source,
    normalized: source.replace(/\s+/g, " ").trim(),
    kind: step.kind,
    action: stepAction(step),
  };
}

function stepAction(step) {
  const first = /^\s*-\s+(?:uses|run):\s*(.*)$/.exec(step.lines[0]);
  const initial = stripComment(first?.[1] ?? "");
  if (step.kind === "uses") return initial;

  const parts = [];
  const propertyIndentation = stepPropertyIndentation(step.lines[0]);
  if (initial && initial !== "|" && initial !== ">") parts.push(initial);
  for (const line of step.lines.slice(1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indentation = /^\s*/.exec(line)[0].length;
    if (indentation <= propertyIndentation) break;
    const content = stripComment(line.trim());
    if (content) parts.push(content);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function stripComment(value) {
  return value.replace(/\s+#.*$/, "").trim();
}

function isActionableStep(step, token) {
  if (token.endsWith("@")) {
    return step.kind === "uses" && step.action.startsWith(token);
  }
  return step.kind === "run" && step.action === token;
}

function validateCriticalStepSequence(
  workflowName,
  steps,
  definitions,
  orderFailure,
  output,
) {
  const indexes = definitions.map(([token, label]) => {
    const matches = steps.flatMap((step, index) =>
      isActionableStep(step, token) ? [index] : [],
    );
    if (matches.length !== 1) {
      output.push(`${workflowName} must contain one actionable ${label} step`);
      return -1;
    }
    const step = steps[matches[0]];
    if (stepHasProperty(step, "continue-on-error")) {
      output.push(`${workflowName} ${label} step cannot continue-on-error`);
    }
    if (stepHasProperty(step, "if")) {
      output.push(
        `${workflowName} ${label} step cannot be conditionally disabled`,
      );
    }
    return matches[0];
  });
  if (
    indexes.some((index) => index < 0) ||
    indexes.some(
      (index, position) => position > 0 && index <= indexes[position - 1],
    )
  ) {
    output.push(orderFailure);
  }
}

function workflowJobsHaveProperty(source, property) {
  const lines = source.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsIndex < 0) return false;

  let blockEnd = lines.length;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (contentLine(lines[index]) && lineIndentation(lines[index]) === 0) {
      blockEnd = index;
      break;
    }
  }
  const jobIndentation = minimumIndentation(lines, jobsIndex + 1, blockEnd, 0);
  if (!Number.isFinite(jobIndentation)) return false;

  const jobStarts = [];
  for (let index = jobsIndex + 1; index < blockEnd; index += 1) {
    if (
      contentLine(lines[index]) &&
      lineIndentation(lines[index]) === jobIndentation
    ) {
      jobStarts.push(index);
    }
  }
  for (const [position, start] of jobStarts.entries()) {
    const end = jobStarts[position + 1] ?? blockEnd;
    const propertyIndentation = minimumIndentation(
      lines,
      start + 1,
      end,
      jobIndentation,
    );
    if (
      Number.isFinite(propertyIndentation) &&
      lines
        .slice(start + 1, end)
        .some((line) => directProperty(line, propertyIndentation, property))
    ) {
      return true;
    }
  }
  return false;
}

function stepHasProperty(step, property) {
  const lines = step.source.split("\n");
  const indentation = stepPropertyIndentation(lines[0]);
  return lines
    .slice(1)
    .some((line) => directProperty(line, indentation, property));
}

function stepPropertyIndentation(line) {
  return /^\s*-\s+/.exec(line)?.[0].length ?? lineIndentation(line) + 2;
}

function minimumIndentation(lines, start, end, greaterThan) {
  let result = Number.POSITIVE_INFINITY;
  for (let index = start; index < end; index += 1) {
    if (!contentLine(lines[index])) continue;
    const indentation = lineIndentation(lines[index]);
    if (indentation > greaterThan && indentation < result) {
      result = indentation;
    }
  }
  return result;
}

function contentLine(line) {
  return Boolean(line.trim()) && !/^\s*#/.test(line);
}

function lineIndentation(line) {
  return /^\s*/.exec(line)[0].length;
}

function directProperty(line, indentation, property) {
  if (line.slice(0, indentation) !== " ".repeat(indentation)) return false;
  if (/^\s/.test(line.slice(indentation))) return false;
  const key = line
    .slice(indentation)
    .match(/^(?:"([^"]+)"|'([^']+)'|([^\s:]+))\s*:/);
  return (key?.[1] ?? key?.[2] ?? key?.[3]) === property;
}
