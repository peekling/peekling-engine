import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateNativePack } from "../packages/runtime/dist/pack-api.js";
import { characterPackReference } from "../packages/runtime/dist/registry.js";

const canonical =
  "https://cdn.jsdelivr.net/npm/@peekling/pack-peek@0.1.1/character.json";
const mode = process.argv[2];
const localRoot = process.argv[3];
const reference = characterPackReference("peek");
if (reference.url !== canonical)
  throw new Error("Zero-config Peek registry URL is not the pinned package");

let manifest;
let readAsset;
let manifestBytes;
if (mode === "--local") {
  if (!localRoot) throw new Error("Pass the @peekling/pack-peek package root");
  const root = path.resolve(localRoot);
  const packageManifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (
    packageManifest.name !== "@peekling/pack-peek" ||
    packageManifest.version !== "0.1.1" ||
    packageManifest.private === true ||
    packageManifest.license !== "Apache-2.0"
  ) {
    throw new Error("Local Peek package is not release-shaped");
  }
  for (const file of ["LICENSE", "NOTICE", "PROVENANCE.md", "RIGHTS.json"])
    await readFile(path.join(root, file));
  manifestBytes = await readFile(path.join(root, "character.json"));
  manifest = JSON.parse(manifestBytes.toString("utf8"));
  readAsset = (src) => readFile(path.join(root, src));
} else if (mode === "--published") {
  const response = await fetch(canonical);
  if (!response.ok)
    throw new Error(`Pinned Peek manifest HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("Pinned Peek manifest has the wrong Content-Type");
  manifestBytes = Buffer.from(await response.arrayBuffer());
  manifest = JSON.parse(manifestBytes.toString("utf8"));
  readAsset = async (src) => {
    const response = await fetch(new URL(src, canonical));
    if (!response.ok)
      throw new Error(`Pinned Peek atlas HTTP ${response.status}`);
    if (!response.headers.get("content-type")?.startsWith("image/png"))
      throw new Error("Pinned Peek atlas has the wrong Content-Type");
    return Buffer.from(await response.arrayBuffer());
  };
} else {
  throw new Error(
    "Use --local <package-root> before publication or --published after publication",
  );
}

if (
  createHash("sha256").update(manifestBytes).digest("hex") !== reference.sha256
)
  throw new Error("Zero-config Peek manifest hash mismatch");

const pack = validateNativePack(manifest);
if (
  pack.name !== "peek" ||
  pack.version !== "0.1.1" ||
  pack.license !== "Apache-2.0"
)
  throw new Error("Pinned Peek manifest identity is invalid");
for (const variant of manifest.assets.atlases.variants) {
  const bytes = await readAsset(variant.src);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== variant.sha256)
    throw new Error(`Peek ${variant.density}x atlas hash mismatch`);
}
console.log(
  `${mode === "--local" ? "Local" : "Published"} explicit Peek registry dependency passed manifest and atlas integrity checks.`,
);
