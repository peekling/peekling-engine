import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanReleaseFiles } from "../scripts/release-security.mjs";

test("release scan normalizes paths before containment checks", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "peekling-scan-path-"));
  const root = path.join(parent, "root");
  try {
    await mkdir(path.join(root, "safe"), { recursive: true });
    await writeFile(path.join(parent, "outside.md"), "ordinary text\n");
    for (const input of [
      "safe/../../outside.md",
      "..\\outside.md",
      "C:\\outside.md",
      "//server/share.md",
    ]) {
      await assert.rejects(
        () => scanReleaseFiles(root, [input]),
        /must stay relative/,
        input,
      );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("source scanning fails on tracked private paths and secrets in maps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "peekling-source-scan-"));
  try {
    await mkdir(path.join(root, "private"));
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "private/notes.md"), "release notes\n");
    await writeFile(
      path.join(root, "dist/index.js.map"),
      `${JSON.stringify({ token: `npm_${"a".repeat(36)}` })}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-security.mjs",
        "scan",
        "--root",
        root,
        "--scope",
        "source",
        "--file",
        "private/notes.md",
        "--file",
        "dist/index.js.map",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden-private-path.*private\/notes\.md/s);
    assert.match(result.stderr, /npm-token.*dist\/index\.js\.map/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner accepts normal public documentation placeholders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "peekling-source-safe-"));
  try {
    await writeFile(
      path.join(root, "README.md"),
      "Set NPM_TOKEN to <token>. A private package needs separate access.\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-security.mjs",
        "scan",
        "--root",
        root,
        "--scope",
        "source",
        "--file",
        "README.md",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no forbidden material/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release context guard binds workflow, checkout, and exact tag commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "peekling-tag-context-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "release@example.invalid"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Release Test"], {
      cwd: root,
    });
    await writeFile(path.join(root, "package.json"), '{"version":"0.1.0"}\n');
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    execFileSync("git", ["-c", "tag.gpgSign=false", "tag", "v0.1.0"], {
      cwd: root,
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const environment = {
      ...process.env,
      GITHUB_REF: "refs/tags/v0.1.0",
      GITHUB_SHA: head,
      GITHUB_WORKFLOW_SHA: head,
      GITHUB_WORKFLOW_REF:
        "peekling/engine/.github/workflows/release.yml@refs/tags/v0.1.0",
      GITHUB_REPOSITORY: "peekling/engine",
    };
    const guard = path.resolve("scripts/verify-release-context.mjs");

    const accepted = spawnSync(process.execPath, [guard, "v0.1.0"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(accepted.status, 0, accepted.stderr);

    const rejected = spawnSync(process.execPath, [guard, "v0.1.0"], {
      cwd: root,
      env: { ...environment, GITHUB_WORKFLOW_SHA: "f".repeat(40) },
      encoding: "utf8",
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /workflow revision.*checked-out tag/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime pack contains only the intended runtime and declaration graph", () => {
  const result = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--dry-run",
        "--json",
        "--workspace",
        "@peekling/runtime",
      ],
      { encoding: "utf8" },
    ),
  )[0];
  const files = result.files.map(({ path: file }) => file).sort();
  const runtimeModules = [
    "configuration-validation",
    "content",
    "contracts",
    "defaults",
    "diagnostics",
    "direction",
    "errors",
    "events",
    "index",
    "input",
    "json",
    "loader",
    "locomotion",
    "normalized",
    "overrides",
    "own-data",
    "pack-api",
    "pack-shared",
    "pack",
    "plan-compiler",
    "plan",
    "preflight-api",
    "preflight",
    "registry",
    "renderer",
    "resolver",
    "runtime-diagnostics",
    "runtime-validation",
    "runtime",
    "sections",
    "styles",
    "tooling-preflight",
    "tooling-validation",
    "types",
    "visibility",
    "web-component",
  ];
  const expected = [
    "AUTHORS",
    "LICENSE",
    "LICENSING.md",
    "NOTICE",
    "README.md",
    ...runtimeModules.flatMap((module) => [
      `dist/${module}.d.ts`,
      `dist/${module}.d.ts.map`,
      `dist/${module}.js`,
    ]),
    "dist/peekling.css",
    "dist/peekling.css.sri",
    "dist/peekling.js",
    "dist/peekling.js.sri",
    "dist/peekling.min.js",
    "dist/peekling.min.js.sri",
    "package.json",
  ].sort();

  assert.deepEqual(files, expected);
});

test("archive manifest verification detects any post-pack byte change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "peekling-archives-"));
  try {
    const filename = "peekling-runtime-0.1.0.tgz";
    const archive = Buffer.from("verified archive bytes");
    await writeFile(path.join(root, filename), archive);
    await writeFile(
      path.join(root, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        version: "0.1.0",
        packages: [
          {
            name: "@peekling/runtime",
            version: "0.1.0",
            filename,
            bytes: archive.byteLength,
            sha256: createHash("sha256").update(archive).digest("hex"),
          },
        ],
      })}\n`,
    );
    const script = path.resolve("scripts/release-archives.mjs");
    const accepted = spawnSync(
      process.execPath,
      [script, "verify", "--directory", root],
      { encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr);

    await writeFile(path.join(root, filename), "changed");
    const rejected = spawnSync(
      process.execPath,
      [script, "verify", "--directory", root],
      { encoding: "utf8" },
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /hash or size does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release workflow audit rejects missing tag binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "peekling-workflow-bind-"));
  try {
    const current = await readFile(".github/workflows/release.yml", "utf8");
    const weakened = current.replace(
      /^\s*- run: node scripts\/verify-release-context\.mjs.*\n/m,
      "",
    );
    const release = path.join(root, "release.yml");
    await writeFile(release, weakened);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-release-workflows.mjs",
        "--ci",
        ".github/workflows/ci.yml",
        "--release",
        release,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release context/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release workflow audit rejects workspace rebuild publication", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "peekling-workflow-archive-"),
  );
  try {
    const current = await readFile(".github/workflows/release.yml", "utf8");
    const weakened = current.replace(
      /node scripts\/release-archives\.mjs publish --directory\s+artifacts\/release-packages --package @peekling\/runtime/,
      "npm publish --workspace @peekling/runtime --provenance",
    );
    const release = path.join(root, "release.yml");
    await writeFile(release, weakened);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-release-workflows.mjs",
        "--ci",
        ".github/workflows/ci.yml",
        "--release",
        release,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /archive|rebuild/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release workflow audit rejects reordered or disabled critical steps", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "peekling-workflow-order-"),
  );
  try {
    const current = await readFile(".github/workflows/release.yml", "utf8");
    const guard =
      '      - run: node scripts/verify-release-context.mjs "${{ inputs.tag }}"\n';
    const verifier =
      "      - run:\n" +
      '          npm run release:verify -- --tag "${{ inputs.tag }}" --archive-dir\n' +
      "          artifacts/release-packages\n";
    const publishedPeekGate = "      - run: npm run test:peek:published\n";
    const sizeGate = "      - run: npm run size:release\n";
    const mutations = [
      current.replace(guard, "") + guard,
      current.replace(guard, `${guard}        if: \${{ false }}\n`),
      current.replace(verifier, `${verifier}        continue-on-error: true\n`),
      current.replace(publishedPeekGate, ""),
      current.replace(
        `${publishedPeekGate}${sizeGate}`,
        `${sizeGate}${publishedPeekGate}`,
      ),
      current.replace(
        "      - run:\n          node scripts/release-archives.mjs publish --directory\n          artifacts/release-packages --package @peekling/runtime\n",
        "      - run:\n          node scripts/release-archives.mjs publish --directory\n          artifacts/release-packages --package @peekling/runtime\n        if: \${{ false }}\n",
      ),
    ];
    for (const [index, source] of mutations.entries()) {
      const release = path.join(root, `release-${index}.yml`);
      await writeFile(release, source);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/check-release-workflows.mjs",
          "--ci",
          ".github/workflows/ci.yml",
          "--release",
          release,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, `mutation ${index} passed unexpectedly`);
      assert.match(result.stderr, /order|disabled|continue-on-error/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI workflow audit rejects missing, duplicate, reordered, or disabled critical gates", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "peekling-ci-workflow-order-"),
  );
  try {
    const current = await readFile(".github/workflows/ci.yml", "utf8");
    const coreGate = "      - run: npm run check:core\n";
    const sizeGate = "      - run: npm run size:release\n";
    const mutations = [
      [
        "echo-only",
        current.replace(sizeGate, "      - run: echo 'npm run size:release'\n"),
      ],
      [
        "multiple-in-one-step",
        current.replace(
          sizeGate,
          "      - run: |\n          npm run size:release\n          npm run size:release\n",
        ),
      ],
      [
        "conditional",
        current.replace(sizeGate, `${sizeGate}        if: \${{ false }}\n`),
      ],
      [
        "continue-on-error",
        current.replace(
          sizeGate,
          `${sizeGate}        continue-on-error: true\n`,
        ),
      ],
      ["duplicate", current.replace(sizeGate, `${sizeGate}${sizeGate}`)],
      ["missing", current.replace(sizeGate, "")],
      [
        "reordered",
        current.replace(`${coreGate}${sizeGate}`, `${sizeGate}${coreGate}`),
      ],
    ];
    for (const [label, source] of mutations) {
      assert.notEqual(source, current, `${label} fixture did not mutate CI`);
      const ci = path.join(root, `ci-${label}.yml`);
      await writeFile(ci, source);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/check-release-workflows.mjs",
          "--ci",
          ci,
          "--release",
          ".github/workflows/release.yml",
        ],
        { encoding: "utf8" },
      );
      assert.equal(
        result.status,
        1,
        `${label} CI mutation passed unexpectedly`,
      );
      assert.match(
        result.stderr,
        /actionable|order|disabled|continue-on-error|size:release/i,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow audit rejects any continue-on-error key on critical jobs and steps", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "peekling-workflow-continue-"),
  );
  try {
    const ciSource = await readFile(".github/workflows/ci.yml", "utf8");
    const releaseSource = await readFile(
      ".github/workflows/release.yml",
      "utf8",
    );
    const values = [
      ["literal-false", "false"],
      ["literal-true", "true"],
      ["expression-true", "${{ true }}"],
      ["expression-false", "${{ false }}"],
      ["quoted-false", '"false"'],
      ["quoted-expression", "'${{ false }}'"],
      ["whitespace", "   ${{ false }}   "],
      ["numeric", "0"],
      ["empty", ""],
    ];
    const ciSteps = [
      ["core", "      - run: npm run check:core\n"],
      ["size", "      - run: npm run size:release\n"],
      ["packages", "      - run: npm run release:verify:packages\n"],
      [
        "browser-install",
        "      - run:\n" +
          "          npx --no-install playwright install --with-deps chromium firefox\n" +
          "          webkit\n",
      ],
      ["browser", "      - run: npm run test:browser\n"],
      [
        "browser-performance",
        "      - run: npm run perf:browser -- --output artifacts/browser-performance.json\n",
      ],
    ];
    const releaseSteps = [
      [
        "checkout",
        "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2\n",
      ],
      [
        "context",
        '      - run: node scripts/verify-release-context.mjs "${{ inputs.tag }}"\n',
      ],
      ["npm", "      - run: npm install --global npm@11.16.0\n"],
      ["install", "      - run: npm ci --ignore-scripts\n"],
      [
        "browser-install",
        "      - run:\n" +
          "          npx --no-install playwright install --with-deps chromium firefox\n" +
          "          webkit\n",
      ],
      ["published-peek", "      - run: npm run test:peek:published\n"],
      ["size", "      - run: npm run size:release\n"],
      [
        "verify",
        "      - run:\n" +
          '          npm run release:verify -- --tag "${{ inputs.tag }}" --archive-dir\n' +
          "          artifacts/release-packages\n",
      ],
      ...[
        "@peekling/runtime",
        "@peekling/adapter-codex-pet",
        "@peekling/preflight",
        "@peekling/vite",
        "@peekling/cli",
      ].map((packageName) => [
        `publish-${packageName}`,
        "      - run:\n" +
          "          node scripts/release-archives.mjs publish --directory\n" +
          `          artifacts/release-packages --package ${packageName}\n`,
      ]),
    ];
    const unexpectedlyAccepted = [];

    for (const [workflow, source, steps] of [
      ["ci", ciSource, ciSteps],
      ["release", releaseSource, releaseSteps],
    ]) {
      for (const [stepName, stepSource] of steps) {
        for (const [valueName, value] of values) {
          const property = `        continue-on-error:${value ? ` ${value}` : ""}\n`;
          const mutated = replaceOnce(
            source,
            stepSource,
            `${stepSource}${property}`,
          );
          const result = await auditWorkflowMutation(
            root,
            `${workflow}-step-${stepName}-${valueName}`,
            workflow,
            mutated,
          );
          if (result.status === 0) {
            unexpectedlyAccepted.push(
              `${workflow} step ${stepName}: ${valueName}`,
            );
          }
        }
      }
    }

    for (const [workflow, source, jobs] of [
      [
        "ci",
        ciSource,
        [
          ["verify", "  verify:\n"],
          ["packages", "  packages:\n"],
          ["browsers", "  browsers:\n"],
        ],
      ],
      ["release", releaseSource, [["publish", "  publish:\n"]]],
    ]) {
      for (const [jobName, jobSource] of jobs) {
        for (const [valueName, value] of values) {
          const property = `    continue-on-error:${value ? ` ${value}` : ""}\n`;
          const mutated = replaceOnce(
            source,
            jobSource,
            `${jobSource}${property}`,
          );
          const result = await auditWorkflowMutation(
            root,
            `${workflow}-job-${jobName}-${valueName}`,
            workflow,
            mutated,
          );
          if (result.status === 0) {
            unexpectedlyAccepted.push(
              `${workflow} job ${jobName}: ${valueName}`,
            );
          }
        }
      }
    }

    assert.deepEqual(unexpectedlyAccepted, []);

    const nestedEnv = replaceOnce(
      ciSource,
      "      - run: npm run size:release\n",
      "      - run: npm run size:release\n" +
        "        env:\n" +
        '          PEEKLING_GUARD_NOTE: "continue-on-error is forbidden"\n',
    );
    const nestedEnvResult = await auditWorkflowMutation(
      root,
      "ci-nested-env",
      "ci",
      nestedEnv,
    );
    assert.equal(nestedEnvResult.status, 0, nestedEnvResult.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow audit follows direct keys across valid YAML indentation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "peekling-workflow-indentation-"),
  );
  try {
    const ciSource = await readFile(".github/workflows/ci.yml", "utf8");
    const releaseSource = await readFile(
      ".github/workflows/release.yml",
      "utf8",
    );
    const mutations = [
      [
        "ci-wide-step",
        "ci",
        replaceOnce(
          ciSource,
          "      - run: npm run size:release\n",
          "      -   run: npm run size:release\n" +
            "          continue-on-error: false\n",
        ),
        /actionable|continue-on-error/i,
      ],
      [
        "release-wide-step",
        "release",
        replaceOnce(
          releaseSource,
          "      - run: npm run size:release\n",
          "      -   run: npm run size:release\n" +
            "          continue-on-error: false\n",
        ),
        /actionable|continue-on-error/i,
      ],
      [
        "ci-wide-job",
        "ci",
        replaceOnce(
          indentJobs(ciSource),
          "    verify:\n",
          "    verify:\n      continue-on-error: false\n",
        ),
        /continue-on-error/i,
      ],
      [
        "release-wide-job",
        "release",
        replaceOnce(
          indentJobs(releaseSource),
          "    publish:\n",
          "    publish:\n      continue-on-error: false\n",
        ),
        /continue-on-error/i,
      ],
    ];

    for (const [label, workflow, source, expectedFailure] of mutations) {
      const result = await auditWorkflowMutation(root, label, workflow, source);
      assert.equal(
        result.status,
        1,
        `${label} passed unexpectedly\n${result.stdout}`,
      );
      assert.match(result.stderr, expectedFailure);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function auditWorkflowMutation(root, label, workflow, source) {
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "_");
  const file = path.join(root, `${safeLabel}.yml`);
  await writeFile(file, source);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-release-workflows.mjs",
      "--ci",
      workflow === "ci" ? file : ".github/workflows/ci.yml",
      "--release",
      workflow === "release" ? file : ".github/workflows/release.yml",
    ],
    { encoding: "utf8" },
  );
  return result;
}

function replaceOnce(source, before, after) {
  assert.equal(
    source.split(before).length - 1,
    1,
    `workflow fixture must contain one ${JSON.stringify(before)}`,
  );
  return source.replace(before, after);
}

function indentJobs(source) {
  let inJobs = false;
  return source
    .split("\n")
    .map((line) => {
      if (line === "jobs:") {
        inJobs = true;
        return line;
      }
      return inJobs && line ? `  ${line}` : line;
    })
    .join("\n");
}
