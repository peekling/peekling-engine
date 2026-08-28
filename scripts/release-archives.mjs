import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyReleaseArchives(directory) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length === 0
  ) {
    throw new Error("Release archive manifest is malformed");
  }
  const names = new Set();
  const filenames = new Set();
  for (const entry of manifest.packages) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      entry.version !== manifest.version ||
      typeof entry.filename !== "string" ||
      path.basename(entry.filename) !== entry.filename ||
      !entry.filename.endsWith(".tgz") ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Release archive manifest has an invalid package entry");
    }
    if (names.has(entry.name) || filenames.has(entry.filename)) {
      throw new Error("Release archive manifest contains a duplicate entry");
    }
    names.add(entry.name);
    filenames.add(entry.filename);
    const archivePath = path.join(root, entry.filename);
    const metadata = await stat(archivePath);
    const bytes = await readFile(archivePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      !metadata.isFile() ||
      bytes.byteLength !== entry.bytes ||
      sha256 !== entry.sha256
    ) {
      throw new Error(
        `${entry.name} archive hash or size does not match manifest`,
      );
    }
  }
  return manifest;
}

async function main(args) {
  const command = args[0];
  const directory = option(args, "--directory");
  if (!directory) throw new Error("--directory is required");
  const manifest = await verifyReleaseArchives(directory);
  if (command === "verify") {
    console.log(
      `Verified ${manifest.packages.length} retained release archives.`,
    );
    return;
  }
  if (command !== "publish") throw new Error("Expected verify or publish");
  const packageName = option(args, "--package");
  const entry = manifest.packages.find(({ name }) => name === packageName);
  if (!entry)
    throw new Error(
      `Package ${packageName ?? ""} is absent from the archive manifest`,
    );
  const archive = `./${path
    .relative(process.cwd(), path.join(path.resolve(directory), entry.filename))
    .split(path.sep)
    .join("/")}`;
  execFileSync(
    "npm",
    [
      "publish",
      archive,
      "--ignore-scripts",
      "--access",
      "public",
      "--provenance",
    ],
    { stdio: "inherit" },
  );
}

function option(args, name) {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (!value || value.startsWith("--"))) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
