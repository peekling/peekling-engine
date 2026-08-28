import { readFile } from "node:fs/promises";

const workspace = JSON.parse(await readFile("package.json", "utf8"));
const runtimePackage = JSON.parse(
  await readFile("packages/runtime/package.json", "utf8"),
);
const version = workspace.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Workspace version must be stable SemVer");
}
if (runtimePackage.version !== version) {
  throw new Error("Runtime package version does not match workspace version");
}

const runtimeUrl = `https://cdn.jsdelivr.net/npm/@peekling/runtime@${version}/dist/peekling.min.js`;
const unpkgRuntimeUrl = `https://unpkg.com/@peekling/runtime@${version}/dist/peekling.min.js`;
const stylesheetUrl = `https://cdn.jsdelivr.net/npm/@peekling/runtime@${version}/dist/peekling.css`;
const selfHostedRuntimeUrl = `https://static.example.com/peekling/${version}/peekling.min.js`;
const [
  readme,
  hosting,
  registry,
  defaultCharacterCheck,
  readableBrowser,
  compactBrowser,
] = await Promise.all([
  readFile("README.md", "utf8"),
  readFile("docs/compatibility-and-hosting.md", "utf8"),
  readFile("packages/runtime/src/registry.ts", "utf8"),
  readFile("scripts/check-default-character.mjs", "utf8"),
  readFile("packages/runtime/dist/peekling.js", "utf8"),
  readFile("packages/runtime/dist/peekling.min.js", "utf8"),
]);
const characterUrl = registry.match(
  /https:\/\/cdn\.jsdelivr\.net\/npm\/@peekling\/pack-peek@\d+\.\d+\.\d+\/character\.json/,
)?.[0];
if (!characterUrl) {
  throw new Error(
    "Official registry is missing an exact-version Peek manifest URL",
  );
}

for (const [label, source, urls] of [
  ["README", readme, [runtimeUrl, stylesheetUrl]],
  [
    "hosting guide",
    hosting,
    [runtimeUrl, unpkgRuntimeUrl, selfHostedRuntimeUrl, characterUrl],
  ],
  ["official registry", registry, [characterUrl]],
  ["readable browser artifact", readableBrowser, [characterUrl]],
  ["minified browser artifact", compactBrowser, [characterUrl]],
]) {
  for (const url of urls) {
    if (!source.includes(url)) {
      throw new Error(`${label} is missing workspace-version URL ${url}`);
    }
  }
}
if (!defaultCharacterCheck.includes(characterUrl)) {
  throw new Error(
    "Published default-character check does not match the official registry",
  );
}
if (!readableBrowser.startsWith(`/*! @peekling/runtime ${version} |`)) {
  throw new Error("Readable browser banner does not match workspace version");
}
if (
  !readme.includes('styles-integrity="sha256-') ||
  !readme.includes('crossorigin="anonymous"')
) {
  throw new Error(
    "Landing install snippet must use stylesheet SHA-256 SRI and anonymous CORS",
  );
}
if (/\.\/characters\/peek\/character\.json/.test(registry)) {
  throw new Error("Production registry points at a demo-relative character");
}
const manifestHash = registry.match(
  /PEEK_REFERENCE_SHA256[\s\S]*?"([a-f0-9]{64})"/,
)?.[1];
if (!manifestHash) {
  throw new Error("Official registry is missing the pinned manifest SHA-256");
}
for (const [label, source] of [
  ["readable browser artifact", readableBrowser],
  ["minified browser artifact", compactBrowser],
]) {
  if (!source.includes(manifestHash)) {
    throw new Error(`${label} is missing the pinned manifest SHA-256`);
  }
}

const combined = [readme, hosting, registry].join("\n");
for (const match of combined.matchAll(/@peekling\/runtime@(\d+\.\d+\.\d+)/g)) {
  if (match[1] !== version) {
    throw new Error(
      `Public distribution URL still pins stale version ${match[1]}`,
    );
  }
}
const paidHostPattern =
  /https:\/\/[^\s"']*(?:vercel\.(?:app|com)|cloudinary\.com|amazonaws\.com|bunny\.(?:net|cdn)|fastly\.(?:net|com)|cloudflare\.(?:com|net)|gcore\.(?:com|labs))/i;
const paidHostMatch = combined.match(paidHostPattern);
if (paidHostMatch) {
  throw new Error(
    `Production config directly references a paid host: ${paidHostMatch[0]}`,
  );
}
for (const field of ["jsdelivr", "unpkg"]) {
  if (runtimePackage[field] !== "./dist/peekling.min.js") {
    throw new Error(`${field} must default to dist/peekling.min.js`);
  }
}
for (const artifact of [
  "peekling.js.sri",
  "peekling.min.js.sri",
  "peekling.css",
  "peekling.css.sri",
]) {
  await readFile(`packages/runtime/dist/${artifact}`);
}

console.log("Pinned runtime, stylesheet, SRI, and CDN metadata audit passed.");
