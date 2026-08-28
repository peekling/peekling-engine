import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PUBLISHABLE_PACKAGES } from "../scripts/workspace-metadata.mjs";

const packageDirectories = PUBLISHABLE_PACKAGES.map(
  ({ directory }) => directory,
);

test("publishable packages declare the supported release lifecycle", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(root.packageManager, "npm@11.16.0");
  assert.equal(root.engines.node, ">=22.14.0");
  assert.equal(
    root.devDependencies.terser,
    "5.50.0",
    "release minification must use the reviewed exact Terser version",
  );

  for (const directory of packageDirectories) {
    const manifest = JSON.parse(
      await readFile(`packages/${directory}/package.json`, "utf8"),
    );
    assert.equal(manifest.version, root.version);
    assert.equal(manifest.engines?.node, root.engines.node);
    assert.deepEqual(manifest.publishConfig, {
      access: "public",
      provenance: true,
    });
    assert.equal(
      manifest.scripts?.prepack,
      "npm --prefix ../.. run build",
      `${manifest.name} must build from source before packing`,
    );
  }
});

test("internal package dependencies use the exact workspace release version", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(
      await readFile(`packages/${directory}/package.json`, "utf8"),
    );
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith("@peekling/")) {
          assert.equal(
            range,
            root.version,
            `${manifest.name} must pin ${field}.${name}`,
          );
        }
      }
    }
  }
});

test("release metadata checker accepts the current package graph", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/release-verify.mjs", "--metadata-only"],
    { encoding: "utf8" },
  );
  assert.match(output, /local release metadata passed/);
});

test("release source check reports blockers in an uncommitted fixture", async () => {
  const fixture = await releaseFixture();
  try {
    const tag = await workspaceTag();
    execFileSync("git", ["init", "-q"], { cwd: fixture.root });
    const result = spawnSync(
      process.execPath,
      ["scripts/release-verify.mjs", "--source-only", "--tag", tag],
      { cwd: fixture.root, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HEAD does not resolve to a commit/);
    assert.match(result.stderr, /working tree is not clean/);
    assert.match(result.stderr, /no git remote is configured/);
    assert.match(result.stderr, /repository metadata cannot be verified/);
    assert.doesNotMatch(result.stderr, /local release metadata failed/);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("release source check accepts an exact clean tagged fixture", async () => {
  const fixture = await releaseFixture();
  try {
    const tag = await workspaceTag();
    for (const directory of [
      ".",
      ...(await readdir(path.join(fixture.root, "packages"))),
    ]) {
      const manifestPath =
        directory === "."
          ? path.join(fixture.root, "package.json")
          : path.join(fixture.root, "packages", directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.repository = {
        type: "git",
        url: "git+https://github.com/peekling/engine.git",
      };
      manifest.homepage = "https://github.com/peekling/engine#readme";
      manifest.bugs = { url: "https://github.com/peekling/engine/issues" };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    execFileSync("git", ["init", "-q"], { cwd: fixture.root });
    execFileSync("git", ["config", "user.email", "release@example.invalid"], {
      cwd: fixture.root,
    });
    execFileSync("git", ["config", "user.name", "Release Fixture"], {
      cwd: fixture.root,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/peekling/engine.git"],
      {
        cwd: fixture.root,
      },
    );
    execFileSync("git", ["add", "."], { cwd: fixture.root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: fixture.root });
    execFileSync("git", ["-c", "tag.gpgSign=false", "tag", tag], {
      cwd: fixture.root,
    });

    const result = spawnSync(
      process.execPath,
      ["scripts/release-verify.mjs", "--source-only", "--tag", tag],
      { cwd: fixture.root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /immutable release source checks passed/);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("release Node comparison rejects prerelease and malformed versions", async () => {
  const { atLeastStableNode } = await import("../scripts/release-version.mjs");

  assert.equal(atLeastStableNode("22.14.0", "22.14.0"), true);
  assert.equal(atLeastStableNode("23.0.0", "22.14.0"), true);
  assert.equal(atLeastStableNode("22.14.0-rc.1", "22.14.0"), false);
  assert.equal(atLeastStableNode("22.14", "22.14.0"), false);
  assert.equal(atLeastStableNode("not-a-version", "22.14.0"), false);
});

test("one package roster covers every publishable workspace", async () => {
  const { PUBLISHABLE_PACKAGES, WORKSPACE_VERSION } =
    await import("../scripts/workspace-metadata.mjs");
  const packageNames = [];
  for (const directory of await readdir("packages")) {
    const manifest = JSON.parse(
      await readFile(`packages/${directory}/package.json`, "utf8"),
    );
    if (manifest.private !== true) packageNames.push(manifest.name);
  }
  assert.deepEqual(
    PUBLISHABLE_PACKAGES.map(({ name }) => name).sort(),
    packageNames.sort(),
  );
  const workspace = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(WORKSPACE_VERSION, workspace.version);
});

test("CI and manual release workflows satisfy the local safety audit", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/check-release-workflows.mjs"],
    { encoding: "utf8" },
  );
  assert.match(output, /workflow safety audit passed/);
});

test("workflow audit requires browser performance evidence before release", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "peekling-performance-workflow-test-"),
  );
  try {
    const current = await readFile(".github/workflows/ci.yml", "utf8");
    const withoutPerformance = current.replace(
      /\n\s*- run: npm run perf:browser -- --output artifacts\/browser-performance\.json\n/m,
      "",
    );
    const ciPath = path.join(temporaryRoot, "ci.yml");
    await writeFile(ciPath, withoutPerformance);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-release-workflows.mjs",
        "--ci",
        ciPath,
        "--release",
        ".github/workflows/release.yml",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm run perf:browser/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("workflow audit rejects quick performance in an acceptance step", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "peekling-quick-workflow-test-"),
  );
  try {
    const current = await readFile(".github/workflows/ci.yml", "utf8");
    const unsafe = current.replace(
      "- run: npm run perf:browser -- --output artifacts/browser-performance.json",
      "- run: npm run perf:browser:quick -- --output artifacts/browser-performance.json\n      # npm run perf:browser -- --output artifacts/browser-performance.json",
    );
    const ciPath = path.join(temporaryRoot, "ci.yml");
    await writeFile(ciPath, unsafe);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-release-workflows.mjs",
        "--ci",
        ciPath,
        "--release",
        ".github/workflows/release.yml",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /quick performance/i);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("workflow audit rejects an automatic release with a movable action", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "peekling-workflow-test-"),
  );
  try {
    const current = await readFile(".github/workflows/release.yml", "utf8");
    const unsafe = current
      .replace(
        /on:\n[\s\S]*?\npermissions:/,
        "on:\n  push:\n    tags: ['v*']\n\npermissions:",
      )
      .replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v6");
    const releasePath = path.join(temporaryRoot, "release.yml");
    await writeFile(releasePath, unsafe);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-release-workflows.mjs",
        "--ci",
        ".github/workflows/ci.yml",
        "--release",
        releasePath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manual workflow_dispatch only/);
    assert.match(result.stderr, /not pinned to a full SHA/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("workflow audit ignores SHA-looking action references in comments", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "peekling-workflow-comment-sha-"),
  );
  try {
    const current = await readFile(".github/workflows/ci.yml", "utf8");
    const unsafe = current.replace(
      /uses: actions\/checkout@[0-9a-f]{40}[^\n]*/,
      `uses: actions/checkout@v6 # expected actions/checkout@${"a".repeat(40)}`,
    );
    const ciPath = path.join(temporaryRoot, "ci.yml");
    await writeFile(ciPath, unsafe);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-release-workflows.mjs",
        "--ci",
        ciPath,
        "--release",
        ".github/workflows/release.yml",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not pinned to a full SHA/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function releaseFixture() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "peekling-release-source-fixture-"),
  );
  const root = path.join(temporaryRoot, "engine");
  const excluded = new Set([
    ".git",
    ".types",
    "artifacts",
    "dist",
    "node_modules",
    "playwright-report",
    "test-results",
  ]);
  await cp(process.cwd(), root, {
    recursive: true,
    filter(source) {
      const relative = path.relative(process.cwd(), source);
      return !relative.split(path.sep).some((part) => excluded.has(part));
    },
  });
  return { temporaryRoot, root };
}

async function workspaceTag() {
  const workspace = JSON.parse(await readFile("package.json", "utf8"));
  return `v${workspace.version}`;
}
