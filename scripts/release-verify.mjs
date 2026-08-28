import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseArchives } from "./release-archives.mjs";
import {
  formatReleaseFindings,
  scanReleaseFiles,
} from "./release-security.mjs";
import { atLeastStableNode } from "./release-version.mjs";
import { PUBLISHABLE_PACKAGES } from "./workspace-metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageOrder = PUBLISHABLE_PACKAGES.map(({ name }) => name);
const packageDirectories = new Map(
  PUBLISHABLE_PACKAGES.map(({ name, directory }) => [name, directory]),
);
const requiredRepositoryFiles = [
  "AUTHORS",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "LICENSING.md",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/browser-performance.md",
  "docs/RELEASING.md",
];
const requiredPackageFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "AUTHORS",
  "LICENSING.md",
];
const excludedSourceParts = new Set([
  ".git",
  ".types",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const args = process.argv.slice(2);
const tag = option(args, "--tag");
const archiveDirectory = option(args, "--archive-dir");
const modes = [
  "--metadata-only",
  "--source-only",
  "--packages-only",
  "--local",
].filter((value) => args.includes(value));
if (modes.length > 1) fail(["choose only one release verification mode"]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--tag" || arg === "--archive-dir") {
    index += 1;
    continue;
  }
  if (
    ![
      "--metadata-only",
      "--source-only",
      "--packages-only",
      "--local",
    ].includes(arg)
  ) {
    fail([`unknown release verification option: ${arg}`]);
  }
}

try {
  const metadata = await verifyMetadata();
  if (args.includes("--metadata-only")) {
    console.log("Peekling local release metadata passed.");
  } else if (args.includes("--source-only")) {
    const blockers = await sourceBlockers(metadata, tag);
    if (blockers.length) fail(blockers, "release source is not immutable");
    console.log("Peekling immutable release source checks passed.");
  } else if (args.includes("--packages-only")) {
    await verifyPackages(metadata, archiveDirectory);
    console.log("Peekling clean-source package verification passed.");
  } else {
    await verifyLocalIntegrity(metadata, archiveDirectory);
    if (!args.includes("--local")) {
      const blockers = await sourceBlockers(metadata, tag);
      if (blockers.length) fail(blockers, "release source is not immutable");
      console.log("Peekling immutable release source checks passed.");
    }
    console.log("Peekling local release integrity passed.");
  }
} catch (error) {
  if (error?.releaseFailure) process.exitCode = 1;
  else {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

async function verifyLocalIntegrity(metadata, archiveRoot) {
  run("npm", ["run", "check:core"], root, "core release gates");
  run("npm", ["run", "size:release"], root, "canonical browser-size evidence");
  run("npm", ["run", "test:browser"], root, "three-browser matrix");
  run(
    "npm",
    [
      "run",
      "perf:browser",
      "--",
      "--output",
      "artifacts/browser-performance.json",
    ],
    root,
    "three-browser performance acceptance",
  );
  run(
    "npm",
    ["audit", "--audit-level=high"],
    root,
    "dependency vulnerability audit",
  );
  await verifyPackages(metadata, archiveRoot);
}

async function verifyMetadata() {
  const failures = [];
  const workspace = await json(path.join(root, "package.json"));
  const lock = await json(path.join(root, "package-lock.json"));
  const npmVersion = capture("npm", ["--version"], root).trim();
  const expectedNpm = String(workspace.packageManager ?? "").replace(
    /^npm@/,
    "",
  );

  if (!workspace.private) failures.push("workspace root must stay private");
  if (!semver(workspace.version))
    failures.push("workspace version is not SemVer");
  if (npmVersion !== expectedNpm) {
    failures.push(
      `npm ${npmVersion} does not match packageManager npm@${expectedNpm}`,
    );
  }
  if (workspace.engines?.node !== ">=22.14.0") {
    failures.push("workspace must require Node >=22.14.0");
  }
  if (!atLeastStableNode(process.versions.node, "22.14.0")) {
    failures.push(`Node ${process.versions.node} is older than 22.14.0`);
  }
  if (lock.lockfileVersion !== 3)
    failures.push("package-lock must use version 3");
  if (lock.packages?.[""]?.version !== workspace.version) {
    failures.push("package-lock root version does not match package.json");
  }
  if (lock.packages?.[""]?.engines?.node !== workspace.engines?.node) {
    failures.push("package-lock root Node policy is stale");
  }
  for (const file of requiredRepositoryFiles) {
    if (!(await exists(path.join(root, file))))
      failures.push(`missing ${file}`);
  }

  const packages = new Map();
  for (const name of packageOrder) {
    const directory = packageDirectories.get(name);
    const packageRoot = path.join(root, "packages", directory);
    const manifest = await json(path.join(packageRoot, "package.json"));
    packages.set(name, manifest);
    if (manifest.name !== name)
      failures.push(`${directory} package name is stale`);
    if (manifest.version !== workspace.version) {
      failures.push(`${name} version does not match the workspace`);
    }
    if (manifest.engines?.node !== workspace.engines?.node) {
      failures.push(`${name} Node support does not match the workspace`);
    }
    if (
      manifest.publishConfig?.access !== "public" ||
      manifest.publishConfig?.provenance !== true
    ) {
      failures.push(`${name} lacks public provenance-ready publish metadata`);
    }
    if (manifest.scripts?.prepack !== "npm --prefix ../.. run build") {
      failures.push(`${name} does not build from source before packing`);
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      failures.push(`${name} lacks an explicit package file allowlist`);
    }
    for (const file of requiredPackageFiles) {
      if (!(await exists(path.join(packageRoot, file)))) {
        failures.push(`${name} lacks ${file}`);
      }
    }
    const lockEntry = lock.packages?.[`packages/${directory}`];
    if (!lockEntry || lockEntry.version !== manifest.version) {
      failures.push(`package-lock entry for ${name} is stale`);
    }
    if (lockEntry?.engines?.node !== manifest.engines?.node) {
      failures.push(`package-lock Node policy for ${name} is stale`);
    }
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (
          dependency.startsWith("@peekling/") &&
          range !== workspace.version
        ) {
          failures.push(
            `${name} must pin ${field}.${dependency} to ${workspace.version}, found ${range}`,
          );
        }
      }
    }
  }

  for (let index = 0; index < packageOrder.length; index += 1) {
    const name = packageOrder[index];
    const manifest = packages.get(name);
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (!dependency.startsWith("@peekling/")) continue;
        const dependencyIndex = packageOrder.indexOf(dependency);
        if (dependencyIndex < 0 || dependencyIndex >= index) {
          failures.push(
            `${name} appears before its internal ${field} entry ${dependency} in publish order`,
          );
        }
      }
    }
  }

  if (failures.length) fail(failures, "local release metadata failed");
  return { lock, packages, workspace };
}

async function verifyPackages(metadata, requestedArchiveRoot) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "peekling-release-verify-"),
  );
  const sourceRoot = path.join(temporaryRoot, "source");
  try {
    await cp(root, sourceRoot, {
      recursive: true,
      filter: (source) => includeSource(source),
    });
    const copiedFiles = (await filesWithin(sourceRoot)).map((file) =>
      path.relative(sourceRoot, file).split(path.sep).join("/"),
    );
    const sourceFindings = await scanReleaseFiles(
      sourceRoot,
      copiedFiles,
      "reconstructed-source",
    );
    if (sourceFindings.length) {
      fail([formatReleaseFindings(sourceFindings)]);
    }
    const originalLock = await readFile(
      path.join(sourceRoot, "package-lock.json"),
      "utf8",
    );

    run(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      sourceRoot,
      "clean source dependency install",
    );
    run(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      sourceRoot,
      "lockfile replay",
    );
    const replayedLock = await readFile(
      path.join(sourceRoot, "package-lock.json"),
      "utf8",
    );
    if (replayedLock !== originalLock) {
      fail(["npm changed package-lock.json during clean replay"]);
    }

    run("npm", ["run", "build"], sourceRoot, "first clean source build");
    const firstBuild = await artifactHashes(sourceRoot);
    await removeBuildOutputs(sourceRoot);
    run("npm", ["run", "build"], sourceRoot, "second clean source build");
    const secondBuild = await artifactHashes(sourceRoot);
    if (JSON.stringify(firstBuild) !== JSON.stringify(secondBuild)) {
      fail(["repeated clean builds produced different package artifacts"]);
    }

    const archiveRoot = requestedArchiveRoot
      ? await prepareArchiveRoot(requestedArchiveRoot)
      : path.join(temporaryRoot, "archives");
    if (!requestedArchiveRoot) await mkdir(archiveRoot);
    const archives = [];
    const archiveEntries = [];
    for (const name of packageOrder) {
      const result = JSON.parse(
        capture(
          "npm",
          [
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            archiveRoot,
            "--workspace",
            name,
          ],
          sourceRoot,
        ),
      )[0];
      verifyPackedFiles(
        name,
        result.files.map(({ path: file }) => file),
      );
      const archive = path.join(archiveRoot, result.filename);
      archives.push(archive);
      const bytes = await readFile(archive);
      archiveEntries.push({
        name,
        version: metadata.workspace.version,
        filename: result.filename,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      console.log(
        `[package] ${name}@${metadata.workspace.version}: ${result.entryCount} files, ${result.size} bytes`,
      );
    }
    await writeFile(
      path.join(archiveRoot, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: metadata.workspace.version,
          packages: archiveEntries,
        },
        null,
        2,
      )}\n`,
    );
    await verifyReleaseArchives(archiveRoot);

    const consumerRoot = path.join(temporaryRoot, "consumer");
    await mkdir(consumerRoot);
    await writeFile(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "peekling-release-consumer",
          private: true,
          type: "module",
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...archives,
        "vite@8.2.2",
      ],
      consumerRoot,
      "isolated package consumer install",
    );
    run(
      process.execPath,
      ["--input-type=module", "--eval", consumerSmokeSource()],
      consumerRoot,
      "isolated ESM and Vite consumer smoke",
    );
    await writeFile(
      path.join(consumerRoot, "peekling.json"),
      `${JSON.stringify({ character: "peek" }, null, 2)}\n`,
    );
    const doctor = spawnSync(
      process.execPath,
      [
        "node_modules/@peekling/cli/dist/bin.js",
        "doctor",
        "peekling.json",
        "--json",
      ],
      { cwd: consumerRoot, encoding: "utf8" },
    );
    if (doctor.status !== 0 || JSON.parse(doctor.stdout).valid !== true) {
      fail([
        `isolated peekling doctor failed: ${doctor.stderr || doctor.stdout}`,
      ]);
    }
    await verifyInstalledArtifacts(consumerRoot);
    await verifyInstalledPackageGraph(consumerRoot, metadata.workspace.version);
    await scanInstalledPackages(consumerRoot);
    await verifyReleaseArchives(archiveRoot);
    console.log(
      `[reproducible] ${firstBuild.length} built artifacts were byte-identical across two clean builds`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function sourceBlockers(metadata, requestedTag) {
  const blockers = [];
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const remote = git(["remote", "get-url", "origin"]);
  const expectedTag = requestedTag ?? `v${metadata.workspace.version}`;

  if (!head.ok) blockers.push("HEAD does not resolve to a commit");
  if (!status.ok || status.stdout.trim()) {
    blockers.push("working tree is not clean");
  }
  if (!remote.ok || !remote.stdout.trim()) {
    blockers.push("no git remote is configured");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(expectedTag)) {
    blockers.push(
      `release tag ${expectedTag} is not an exact vMAJOR.MINOR.PATCH tag`,
    );
  } else if (expectedTag !== `v${metadata.workspace.version}`) {
    blockers.push(
      `release tag ${expectedTag} does not match workspace version ${metadata.workspace.version}`,
    );
  }
  if (head.ok) {
    const tagged = git(["rev-parse", `refs/tags/${expectedTag}^{}`]);
    if (!tagged.ok || tagged.stdout.trim() !== head.stdout.trim()) {
      blockers.push(`${expectedTag} does not resolve to HEAD`);
    }
    const trackedFiles = git(["ls-files", "-z"]);
    if (!trackedFiles.ok) {
      blockers.push("tracked source files could not be enumerated");
    } else {
      const files = trackedFiles.stdout.split("\0").filter(Boolean);
      const findings = await scanReleaseFiles(root, files, "tracked-source");
      if (findings.length) blockers.push(formatReleaseFindings(findings));
    }
    for (const tracked of [
      "package.json",
      "package-lock.json",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "scripts/release-verify.mjs",
    ]) {
      if (!git(["ls-files", "--error-unmatch", tracked]).ok) {
        blockers.push(`${tracked} is not tracked in the release source`);
      }
    }
  }

  const canonicalRepository = remote.ok
    ? githubRepository(remote.stdout.trim())
    : undefined;
  if (!canonicalRepository) {
    blockers.push(
      "repository metadata cannot be verified until a GitHub origin exists",
    );
  } else {
    const expectedRepository = `git+https://github.com/${canonicalRepository}.git`;
    const expectedHomepage = `https://github.com/${canonicalRepository}#readme`;
    const expectedBugs = `https://github.com/${canonicalRepository}/issues`;
    for (const [name, manifest] of [
      [metadata.workspace.name, metadata.workspace],
      ...metadata.packages,
    ]) {
      if (manifest.repository?.url !== expectedRepository) {
        blockers.push(`${name} repository.url must be ${expectedRepository}`);
      }
      if (manifest.homepage !== expectedHomepage) {
        blockers.push(`${name} homepage must be ${expectedHomepage}`);
      }
      if (manifest.bugs?.url !== expectedBugs) {
        blockers.push(`${name} bugs.url must be ${expectedBugs}`);
      }
    }
  }
  return blockers;
}

function verifyPackedFiles(name, files) {
  for (const required of requiredPackageFiles) {
    if (!files.includes(required)) fail([`${name} package lacks ${required}`]);
  }
  if (!files.some((file) => file.startsWith("dist/"))) {
    fail([`${name} package contains no built output`]);
  }
  for (const file of files) {
    if (
      /^(?:src|test|private)\//.test(file) ||
      /(?:^|\/)\.(?:env|npmrc)(?:\.|$)/.test(file) ||
      /\.(?:key|p12|pfx|pem)$/.test(file)
    ) {
      fail([`${name} package contains forbidden file ${file}`]);
    }
  }
  if (name === "@peekling/runtime") {
    for (const artifact of [
      "dist/peekling.js",
      "dist/peekling.js.sri",
      "dist/peekling.min.js",
      "dist/peekling.min.js.sri",
      "dist/peekling.css",
      "dist/peekling.css.sri",
    ]) {
      if (!files.includes(artifact))
        fail([`runtime package lacks ${artifact}`]);
    }
  }
}

async function verifyInstalledArtifacts(consumerRoot) {
  const runtimeRoot = path.join(
    consumerRoot,
    "node_modules/@peekling/runtime/dist",
  );
  for (const [file, algorithm] of [
    ["peekling.js", "sha384"],
    ["peekling.min.js", "sha384"],
    ["peekling.css", "sha256"],
  ]) {
    const bytes = await readFile(path.join(runtimeRoot, file));
    const expected = `${algorithm}-${createHash(algorithm)
      .update(bytes)
      .digest("base64")}`;
    const actual = (
      await readFile(path.join(runtimeRoot, `${file}.sri`), "utf8")
    ).trim();
    if (actual !== expected) fail([`${file} SRI does not match packed bytes`]);
  }
}

async function verifyInstalledPackageGraph(consumerRoot, version) {
  for (const packageName of ["preflight", "vite"]) {
    const nestedRuntime = path.join(
      consumerRoot,
      "node_modules/@peekling",
      packageName,
      "node_modules/@peekling/runtime",
    );
    if (await exists(nestedRuntime)) {
      fail([`@peekling/${packageName} installed a second runtime copy`]);
    }
  }
  const runtime = await json(
    path.join(consumerRoot, "node_modules/@peekling/runtime/package.json"),
  );
  const preflight = await json(
    path.join(consumerRoot, "node_modules/@peekling/preflight/package.json"),
  );
  if (
    runtime.version !== version ||
    preflight.peerDependencies?.["@peekling/runtime"] !== version
  ) {
    fail(["installed Preflight and runtime versions are not exactly aligned"]);
  }
}

async function scanInstalledPackages(consumerRoot) {
  for (const name of packageOrder) {
    const packageRoot = path.join(
      consumerRoot,
      "node_modules",
      ...name.split("/"),
    );
    const files = (await filesWithin(packageRoot)).map((file) =>
      path.relative(packageRoot, file).split(path.sep).join("/"),
    );
    const findings = await scanReleaseFiles(packageRoot, files, name);
    if (findings.length) fail([formatReleaseFindings(findings)]);
  }
}

async function prepareArchiveRoot(requested) {
  const expected = path.join(root, "artifacts", "release-packages");
  const resolved = path.resolve(root, requested);
  if (resolved !== expected) {
    fail(["--archive-dir must be artifacts/release-packages"]);
  }
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
  return resolved;
}

async function artifactHashes(sourceRoot) {
  const output = [];
  for (const directory of packageDirectories.values()) {
    const dist = path.join(sourceRoot, "packages", directory, "dist");
    for (const file of await filesWithin(dist)) {
      if (file.endsWith(".tsbuildinfo")) continue;
      const bytes = await readFile(file);
      output.push({
        file: path.relative(sourceRoot, file).split(path.sep).join("/"),
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return output.sort((left, right) => left.file.localeCompare(right.file));
}

async function removeBuildOutputs(sourceRoot) {
  for (const directory of packageDirectories.values()) {
    await rm(path.join(sourceRoot, "packages", directory, "dist"), {
      recursive: true,
      force: true,
    });
  }
}

async function filesWithin(directory) {
  if (!(await exists(directory))) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesWithin(target)));
    else if (entry.isFile() || entry.isSymbolicLink()) output.push(target);
  }
  return output.sort();
}

function includeSource(source) {
  const relative = path.relative(root, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.some((part) => excludedSourceParts.has(part))) return false;
  if (relative.endsWith(".tsbuildinfo")) return false;
  return true;
}

function githubRepository(remote) {
  const match = remote.match(
    /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  return match?.[1];
}

function git(command) {
  const result = spawnSync("git", command, { cwd: root, encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
  };
}

function option(input, name) {
  const index = input.indexOf(name);
  if (index < 0) return undefined;
  const value = input[index + 1];
  if (!value || value.startsWith("--")) fail([`${name} requires a value`]);
  return value;
}

function semver(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

function run(command, commandArgs, cwd, label) {
  console.log(`\n[verify] ${label}`);
  execFileSync(command, commandArgs, { cwd, stdio: "inherit" });
}

function capture(command, commandArgs, cwd) {
  return execFileSync(command, commandArgs, { cwd, encoding: "utf8" });
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function fail(messages, heading = "release verification failed") {
  console.error(`${heading}:`);
  for (const message of messages) console.error(`[blocked] ${message}`);
  const error = new Error(heading);
  error.releaseFailure = true;
  throw error;
}

function consumerSmokeSource() {
  return `
const runtime = await import("@peekling/runtime");
if (typeof runtime.hatch !== "function") throw new Error("runtime hatch missing");
if ("default" in runtime || "Peekling" in runtime || "run" in runtime) {
  throw new Error("runtime root exposes a removed creation surface");
}
const pack = await import("@peekling/runtime/pack");
if (typeof pack.validateNativePack !== "function") throw new Error("Pack gate missing");
const stylesheetUrl = import.meta.resolve("@peekling/runtime/peekling.css");
const stylesheet = await (await import("node:fs/promises")).readFile(new URL(stylesheetUrl), "utf8");
if (!stylesheet.includes("[data-peekling-host]")) {
  throw new Error("runtime stylesheet asset export missing");
}
const { preflight } = await import("@peekling/preflight");
if (!preflight({ character: "peek" }).valid) throw new Error("preflight rejected minimal Configuration");
const runtimePreflight = await import("@peekling/runtime/preflight");
if (runtimePreflight.preflight !== preflight) {
  throw new Error("preflight wrapper does not use the runtime tooling seam");
}
const { peekling } = await import("@peekling/vite");
if (peekling({ config: "peekling.json" }).name !== "peekling:preflight") {
  throw new Error("Vite plugin import failed");
}
const adapter = await import("@peekling/adapter-codex-pet");
if (typeof adapter.adaptCodexPetV2 !== "function") throw new Error("adapter import failed");
`;
}
