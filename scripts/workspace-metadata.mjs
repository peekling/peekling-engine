import { readFile } from "node:fs/promises";

const workspace = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

if (!/^\d+\.\d+\.\d+$/.test(workspace.version)) {
  throw new Error(
    "Workspace package.json must declare a stable SemVer version",
  );
}

export const WORKSPACE_VERSION = workspace.version;

export const PUBLISHABLE_PACKAGES = Object.freeze(
  [
    ["@peekling/runtime", "runtime"],
    ["@peekling/adapter-codex-pet", "adapter-codex-pet"],
    ["@peekling/preflight", "preflight"],
    ["@peekling/vite", "vite"],
    ["@peekling/cli", "cli"],
  ].map(([name, directory]) => Object.freeze({ name, directory })),
);
