import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tag = process.argv[2];
const failures = verifyReleaseContext(tag, process.env, gitHead());
if (failures.length) {
  for (const failure of failures) console.error(`[blocked] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release workflow and checkout are bound to ${tag}.`);
}

export function verifyReleaseContext(tag, environment, head) {
  const failures = [];
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
    failures.push("release tag must be exact vMAJOR.MINOR.PATCH");
    return failures;
  }
  const expectedRef = `refs/tags/${tag}`;
  const repository = environment.GITHUB_REPOSITORY ?? "";
  const expectedWorkflowRef = `${repository}/.github/workflows/release.yml@${expectedRef}`;
  if (environment.GITHUB_REF !== expectedRef) {
    failures.push(`workflow dispatch ref must be ${expectedRef}`);
  }
  if (environment.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) {
    failures.push(`workflow file must execute from ${expectedWorkflowRef}`);
  }
  for (const [label, value] of [
    ["event revision", environment.GITHUB_SHA],
    ["workflow revision", environment.GITHUB_WORKFLOW_SHA],
  ]) {
    if (value !== head) {
      failures.push(`${label} does not match the checked-out tag commit`);
    }
  }
  const tagged = git(["rev-parse", `refs/tags/${tag}^{}`]);
  if (!tagged || tagged !== head) {
    failures.push(`${tag} does not resolve to the checked-out commit`);
  }
  const manifestVersion = packageVersion();
  if (tag !== `v${manifestVersion}`) {
    failures.push(`${tag} does not match package version ${manifestVersion}`);
  }
  return failures;
}

function gitHead() {
  return git(["rev-parse", "HEAD"]);
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).version;
  } catch {
    return undefined;
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
