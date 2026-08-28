import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PUBLISHABLE_PACKAGES,
  WORKSPACE_VERSION,
} from "../scripts/workspace-metadata.mjs";

const publishablePackages = PUBLISHABLE_PACKAGES.map(
  ({ directory }) => directory,
);
const author = {
  name: "Prajwal S. Venkateshmurthy",
  url: "https://prajwal.me",
};

test("the workspace root cannot be published as a package", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(root.name, "@peekling/engine-workspace");
  assert.equal(root.private, true);
  assert.equal(root.license, "Apache-2.0");
  assert.deepEqual(root.author, author);
  assert.equal(
    root.scripts?.prepublishOnly,
    "node scripts/refuse-root-publish.mjs",
  );
});

for (const directory of publishablePackages) {
  test(`${directory} has a public package boundary`, async () => {
    const manifestPath = `packages/${directory}/package.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.match(manifest.name, /^@peekling\/[a-z0-9-]+$/);
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.license, "Apache-2.0");
    assert.deepEqual(manifest.author, author);
    const notice = await readFile(`packages/${directory}/NOTICE`, "utf8");
    assert.match(notice, /Prajwal S\. Venkateshmurthy/);
    assert.match(notice, /Contact: https:\/\/prajwal\.me/);
    assert.ok(manifest.files?.length > 0);
    assert.ok(manifest.exports || manifest.bin);

    const packed = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--dry-run",
          "--json",
          "--ignore-scripts",
          "--workspace",
          manifest.name,
        ],
        { encoding: "utf8" },
      ),
    );
    const files = packed[0].files.map(({ path }) => path);

    assert.ok(files.includes("package.json"));
    assert.ok(files.includes("README.md"));
    for (const legalFile of ["LICENSE", "NOTICE", "AUTHORS", "LICENSING.md"])
      assert.ok(
        files.includes(legalFile),
        `packed ${manifest.name} lacks ${legalFile}`,
      );
    assert.ok(files.some((path) => path.startsWith("dist/")));
    assert.equal(
      files.some((path) =>
        /^(?:src|test|private)\/|(?:^|\/)\.env(?:\.|$)/.test(path),
      ),
      false,
      `packed ${manifest.name} contains source, tests, or private material`,
    );
  });
}

test("runtime owns the browser and Web Component delivery", async () => {
  const runtime = JSON.parse(
    await readFile("packages/runtime/package.json", "utf8"),
  );
  const root = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(runtime.name, "@peekling/runtime");
  assert.equal(runtime.exports?.["./browser"], "./dist/peekling.min.js");
  assert.equal(runtime.exports?.["./peekling.css"], "./dist/peekling.css");
  assert.deepEqual(runtime.exports?.["./preflight"], {
    types: "./dist/preflight-api.d.ts",
    import: "./dist/preflight-api.js",
  });
  assert.equal(root.exports, undefined);
  assert.equal(root.main, undefined);
  assert.equal(root.bin, undefined);
});

test("preflight is a thin exact-version consumer of runtime tooling seams", async () => {
  const manifest = JSON.parse(
    await readFile("packages/preflight/package.json", "utf8"),
  );
  const artifact = await readFile("packages/preflight/dist/index.js", "utf8");
  const jsonArtifact = await readFile(
    "packages/preflight/dist/json.js",
    "utf8",
  );

  assert.deepEqual(Object.keys(manifest.exports), [".", "./json"]);
  assert.deepEqual(manifest.dependencies, {});
  assert.equal(
    manifest.peerDependencies?.["@peekling/runtime"],
    WORKSPACE_VERSION,
  );
  assert.equal(
    manifest.devDependencies?.["@peekling/runtime"],
    WORKSPACE_VERSION,
  );
  assert.match(artifact, /@peekling\/runtime\/preflight/);
  assert.match(jsonArtifact, /@peekling\/runtime\/pack/);
  assert.doesNotMatch(
    artifact,
    /\.\.\/runtime|snapshotConfiguration|preflightPlan/,
  );
  assert.doesNotMatch(jsonArtifact, /firstDuplicateKey|JSON\.parse/);
});

test("runtime and tooling validation share one semantic kernel", async () => {
  const runtimeValidation = await readFile(
    "packages/runtime/dist/runtime-validation.js",
    "utf8",
  );
  const toolingValidation = await readFile(
    "packages/runtime/dist/preflight.js",
    "utf8",
  );
  const browser = await readFile(
    "packages/runtime/dist/peekling.min.js",
    "utf8",
  );

  assert.match(runtimeValidation, /\.\/configuration-validation\.js/);
  assert.match(toolingValidation, /\.\/configuration-validation\.js/);
  assert.doesNotMatch(browser, /Fix the Plan field|Preflight cannot prove/);
});

test("browser build explicitly selects the IIFE stylesheet path", async () => {
  const build = await readFile("scripts/build.mjs", "utf8");

  assert.match(
    build,
    /__PEEKLING_BROWSER_BUILD__:\s*"true"[\s\S]*__PEEKLING_COMPACT_ERRORS__/,
  );
});

test("browser build reads the default character pin from the registry", async () => {
  const build = await readFile("scripts/build.mjs", "utf8");

  assert.match(build, /packages\/runtime\/dist\/registry\.js/);
  assert.match(build, /characterPackReference\("peek"\)/);
  assert.doesNotMatch(build, /cdn\.jsdelivr\.net\/npm\/@peekling\/pack-peek/);
  assert.doesNotMatch(build, /["'][0-9a-f]{64}["']/);
});

test("browser build audits every configured property mangle", async () => {
  const build = await readFile("scripts/build.mjs", "utf8");
  const audit = await readFile("scripts/property-mangle-audit.mjs", "utf8");

  assert.match(build, /MANGLED_RUNTIME_PROPERTIES/);
  assert.match(build, /propertyCandidateCache/);
  assert.match(build, /nameCache:\s*propertyNameCache/);
  assert.match(audit, /was not mapped|remains in the minified artifact/);
});

test("the Codex adapter uses only the deliberate runtime Pack seam", async () => {
  const manifest = JSON.parse(
    await readFile("packages/adapter-codex-pet/package.json", "utf8"),
  );
  const artifact = await readFile(
    "packages/adapter-codex-pet/dist/index.js",
    "utf8",
  );

  assert.equal(manifest.dependencies?.["@peekling/runtime"], WORKSPACE_VERSION);
  assert.match(artifact, /@peekling\/runtime\/pack/);
  assert.doesNotMatch(artifact, /runtime\/(?:src|dist|own-data)/);
});

test("Vite integration stays in the development graph", async () => {
  const manifest = JSON.parse(
    await readFile("packages/vite/package.json", "utf8"),
  );
  const artifact = await readFile("packages/vite/dist/index.js", "utf8");

  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.equal(
    manifest.dependencies?.["@peekling/preflight"],
    WORKSPACE_VERSION,
  );
  assert.equal(manifest.dependencies?.["@peekling/runtime"], undefined);
  assert.equal(manifest.dependencies?.vite, undefined);
  assert.match(manifest.peerDependencies?.vite, /\^8\.0\.0/);
  assert.match(artifact, /@peekling\/preflight\/json/);
  assert.doesNotMatch(
    artifact,
    /@peekling\/runtime|\.\.\/runtime|function firstDuplicateKey/,
  );
});
