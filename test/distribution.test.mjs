import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { build } from "esbuild";
import test from "node:test";

test("readable and minified browser builds publish the same façade with matching SRI", async () => {
  const artifacts = await Promise.all(
    ["peekling.js", "peekling.min.js"].map(async (name) => {
      const browser = await readFile(`packages/runtime/dist/${name}`);
      const integrity = (
        await readFile(`packages/runtime/dist/${name}.sri`, "utf8")
      ).trim();
      assert.equal(
        integrity,
        `sha384-${createHash("sha384").update(browser).digest("base64")}`,
      );
      return browser.toString("utf8");
    }),
  );
  const source = artifacts[1];
  for (const artifact of artifacts) {
    assert.match(artifact, /peekling-character/);
    assert.match(artifact, /Peekling/);
    assert.doesNotMatch(artifact, /^\s*(?:import|export)\s/m);
  }
  for (const publicKey of [
    "plan",
    "content",
    "bindings",
    "theme",
    "diagnostics",
    "accessibility",
    "until",
    "effect",
    "contentId",
    "mode",
    "mountId",
    "surfaceId",
    "update",
    "cleanup",
  ]) {
    assert.ok(
      source.includes(publicKey),
      `browser keeps public key ${publicKey}`,
    );
  }
  assert.equal(source.includes("moveTo"), false);
  assert.equal(source.includes("rendererId"), false);
  assert.equal(source.includes("nodeId"), false);

  const stylesheet = await readFile("packages/runtime/dist/peekling.css");
  const stylesheetIntegrity = (
    await readFile("packages/runtime/dist/peekling.css.sri", "utf8")
  ).trim();
  assert.equal(
    stylesheetIntegrity,
    `sha256-${createHash("sha256").update(stylesheet).digest("base64")}`,
  );
  const css = stylesheet.toString("utf8");
  assert.doesNotMatch(css, /url\s*\(/i);
  assert.match(
    css,
    /\.peekling-character-hit\{[^}]*-webkit-tap-highlight-color:transparent[^}]*backface-visibility:hidden/,
  );
});

test("a bundled bare browser import executes registration side effects", async () => {
  const output = await build({
    stdin: {
      contents:
        'import "@peekling/runtime/browser";globalThis.result=[typeof globalThis.Peekling?.hatch,Boolean(customElements.get("peekling-character"))]',
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    minify: true,
  });
  const definitions = new Map();
  const context = {
    customElements: {
      get: (name) => definitions.get(name),
      define: (name, value) => definitions.set(name, value),
    },
    HTMLElement: class {},
  };
  context.globalThis = context;
  vm.runInNewContext(output.outputFiles[0].text, context);
  assert.deepEqual([...context.result], ["function", true]);
});

test("a bundled ESM root import has no browser-global registration side effects", async () => {
  const output = await build({
    stdin: {
      contents:
        'import { hatch, definePeeklingElement } from "@peekling/runtime";globalThis.result=[typeof hatch,typeof definePeeklingElement,typeof globalThis.Peekling,Boolean(customElements.get("peekling-character"))]',
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    minify: true,
  });
  const definitions = new Map();
  const context = {
    customElements: {
      get: (name) => definitions.get(name),
      define: (name, value) => definitions.set(name, value),
    },
    HTMLElement: class {},
  };
  context.globalThis = context;
  vm.runInNewContext(output.outputFiles[0].text, context);
  assert.deepEqual(
    [...context.result],
    ["function", "function", "undefined", false],
  );
});

test("package CDN defaults select the production browser artifact", async () => {
  const metadata = JSON.parse(
    await readFile("packages/runtime/package.json", "utf8"),
  );
  assert.equal(metadata.jsdelivr, "./dist/peekling.min.js");
  assert.equal(metadata.unpkg, "./dist/peekling.min.js");
});

test("distribution audit derives pinned URLs from the workspace version", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "peekling-distribution-version-"),
  );
  try {
    const files = [
      "README.md",
      "docs/compatibility-and-hosting.md",
      "packages/runtime/src/registry.ts",
      "packages/runtime/package.json",
      "packages/runtime/dist/peekling.js",
      "packages/runtime/dist/peekling.js.sri",
      "packages/runtime/dist/peekling.min.js",
      "packages/runtime/dist/peekling.min.js.sri",
      "packages/runtime/dist/peekling.css",
      "packages/runtime/dist/peekling.css.sri",
      "scripts/build.mjs",
      "scripts/check-default-character.mjs",
    ];
    for (const file of files) {
      const target = path.join(temporaryRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file, target);
    }
    const workspace = JSON.parse(await readFile("package.json", "utf8"));
    const [major, minor, patchVersion] = workspace.version
      .split(".")
      .map(Number);
    const changedVersion = `${major}.${minor}.${patchVersion + 1}`;
    workspace.version = changedVersion;
    await writeFile(
      path.join(temporaryRoot, "package.json"),
      `${JSON.stringify(workspace)}\n`,
    );
    const runtime = JSON.parse(
      await readFile("packages/runtime/package.json", "utf8"),
    );
    runtime.version = changedVersion;
    await writeFile(
      path.join(temporaryRoot, "packages/runtime/package.json"),
      `${JSON.stringify(runtime)}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/audit-distribution.mjs")],
      { cwd: temporaryRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /workspace-version URL|workspace version/i);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
