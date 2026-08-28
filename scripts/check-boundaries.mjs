import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  PUBLISHABLE_PACKAGES,
  WORKSPACE_VERSION,
} from "./workspace-metadata.mjs";

const packageNames = PUBLISHABLE_PACKAGES.map(({ directory }) => directory);
const failures = [];

for (const name of packageNames) {
  const root = path.join("packages", name);
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "test",
    "src",
  ])
    await access(path.join(root, required)).catch(() =>
      failures.push(`${name} lacks ${required}`),
    );

  const metadata = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (!metadata.name?.startsWith("@peekling/"))
    failures.push(`${name} lacks a public package identity`);
  if (!metadata.scripts?.build || !metadata.scripts?.test)
    failures.push(`${name} lacks independent build or test commands`);

  const publicText = await publicFiles(root);
  if (/\/Users\/|CONTEXT\.md|private\//.test(publicText))
    failures.push(`${name} reaches outside the engine repository`);
}

const runtime = JSON.parse(
  await readFile("packages/runtime/package.json", "utf8"),
);
if (Object.keys(runtime.dependencies ?? {}).length)
  failures.push("runtime has production dependencies");

const preflight = JSON.parse(
  await readFile("packages/preflight/package.json", "utf8"),
);
if (Object.keys(preflight.dependencies ?? {}).length)
  failures.push("preflight must keep ordinary dependencies empty");
if (
  preflight.peerDependencies?.["@peekling/runtime"] !== WORKSPACE_VERSION ||
  preflight.devDependencies?.["@peekling/runtime"] !== WORKSPACE_VERSION
) {
  failures.push("preflight must align exactly with the runtime tooling seam");
}
const preflightSource = await publicFiles("packages/preflight/src");
if (/\.\.\/runtime|runtime\/src|runtime\/dist/.test(preflightSource)) {
  failures.push("preflight reaches through the runtime package boundary");
}

const vite = JSON.parse(await readFile("packages/vite/package.json", "utf8"));
if (vite.dependencies?.["@peekling/runtime"])
  failures.push("vite integration must not depend on the browser runtime");
if (vite.dependencies?.vite || !vite.peerDependencies?.vite)
  failures.push("vite integration must keep Vite as a peer dependency");

for (const forbidden of ["demo", "skills", "packages/pack-peek"])
  if (await exists(forbidden))
    failures.push(`engine still owns extracted surface: ${forbidden}`);

if (await exists("packages/react"))
  failures.push("deferred React package must not exist in v0.1");

if (failures.length) throw new Error(failures.join("\n"));
console.log("Engine boundaries are narrow and independently extractable.");

async function exists(target) {
  return access(target).then(
    () => true,
    () => false,
  );
}

async function publicFiles(root) {
  let output = "";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output += await publicFiles(target);
    else if (/\.(?:md|json|ts|mjs|js)$/.test(entry.name))
      output += await readFile(target, "utf8");
  }
  return output;
}
