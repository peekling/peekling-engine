import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { preflight, type PreflightResult } from "@peekling/preflight";
import { parseDataText } from "@peekling/preflight/json";
import type { Plugin, ResolvedConfig } from "vite";

const MAX_INPUT_BYTES = 64 * 1024;

export interface PeeklingViteOptions {
  readonly config: string;
  readonly pack?: string;
  readonly baseUrl?: string;
}

/** Validate data-only Peekling inputs during Vite development and builds. */
export function peekling(input: PeeklingViteOptions): Plugin {
  const options = snapshotOptions(input);
  let viteConfig: ResolvedConfig | undefined;
  let viteRoot = "";
  let configPath = "";
  let packPath: string | undefined;
  let configWatchPath = "";
  let packWatchPath: string | undefined;
  return {
    name: "peekling:preflight",
    enforce: "pre",
    configResolved(config) {
      viteConfig = config;
      viteRoot = realpathSync(path.resolve(config.root));
      configWatchPath = path.resolve(config.root, options.config);
      packWatchPath = options.pack
        ? path.resolve(config.root, options.pack)
        : undefined;
      configPath = resolveInput(viteRoot, options.config, "config");
      packPath = options.pack
        ? resolveInput(viteRoot, options.pack, "pack")
        : undefined;
    },
    async buildStart() {
      const report = await validateFiles();
      for (const warning of report.warnings) {
        this.warn(formatIssue("warning", warning));
      }
      if (!report.valid) this.error(formatReport(report));
    },
    async configureServer(server) {
      await Promise.all([
        readJsonInput(configPath, viteRoot),
        ...(packPath ? [readJsonInput(packPath, viteRoot)] : []),
      ]);
      server.watcher.add([configPath, ...(packPath ? [packPath] : [])]);
    },
    async handleHotUpdate(context) {
      const candidate = path.resolve(context.file);
      if (
        candidate !== configPath &&
        candidate !== packPath &&
        candidate !== configWatchPath &&
        candidate !== packWatchPath
      ) {
        return;
      }
      let changed: string;
      try {
        changed = await canonicalCandidate(context.file, viteRoot);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        const label =
          candidate === configPath || candidate === configWatchPath
            ? "config"
            : "pack";
        throw new Error(
          `Peekling ${label} input was removed during a hot update`,
        );
      }
      const expected =
        candidate === packPath || candidate === packWatchPath
          ? packPath
          : configPath;
      if (changed !== expected) {
        throw new Error("Peekling input has a symbolic path component");
      }
      const report = await validateFiles();
      for (const warning of report.warnings) {
        viteConfig?.logger?.warn(formatIssue("warning", warning));
      }
      if (!report.valid) throw new Error(formatReport(report));
    },
  };

  async function validateFiles(): Promise<PreflightResult> {
    if (!viteConfig) throw new Error("Peekling Vite plugin is not configured");
    const configuration = await readJsonInput(configPath, viteRoot);
    const pack = packPath ? await readJsonInput(packPath, viteRoot) : undefined;
    return preflight(configuration, {
      ...(pack !== undefined ? { pack } : {}),
      baseUrl:
        options.baseUrl ??
        new URL(viteConfig.base, "https://peekling.invalid/").href,
    });
  }

  function formatReport(report: PreflightResult): string {
    return [
      `Peekling validation failed for ${path.relative(viteConfig!.root, configPath)}`,
      ...report.errors.map((issue) => formatIssue("error", issue)),
    ].join("\n");
  }
}

async function readJsonInput(target: string, root: string): Promise<unknown> {
  const label = path.basename(target);
  const canonical = await canonicalCandidate(target, root);
  if (canonical !== target) {
    throw new Error(`${label} has a symbolic path component`);
  }
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} exceeds 65536 bytes`);
  }
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed before it could be read`);
    }
    if (opened.size > MAX_INPUT_BYTES) {
      throw new Error(`${label} exceeds 65536 bytes`);
    }
    const confirmed = await canonicalCandidate(target, root);
    const current = await lstat(target);
    if (
      confirmed !== target ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new Error(`${label} changed before it could be read`);
    }
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_INPUT_BYTES) {
      throw new Error(`${label} exceeds 65536 bytes`);
    }
    const after = await canonicalCandidate(target, root);
    const final = await lstat(target);
    if (
      after !== target ||
      final.isSymbolicLink() ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch (cause) {
      throw new Error(`${label} must be valid UTF-8`, { cause });
    }
    return parseDataText(text, label);
  } finally {
    await handle.close();
  }
}

async function canonicalCandidate(
  target: string,
  root: string,
): Promise<string> {
  const canonical = await realpath(path.resolve(target));
  const relative = path.relative(root, canonical);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Peekling input must stay inside the real Vite root");
  }
  return canonical;
}

function snapshotOptions(input: PeeklingViteOptions): PeeklingViteOptions {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.getOwnPropertySymbols(input).length > 0) throw new TypeError();
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) throw new TypeError();
      output[key] = descriptor.value;
    }
    for (const key of Object.keys(output)) {
      if (key !== "config" && key !== "pack" && key !== "baseUrl") {
        throw new TypeError(`Unknown Peekling Vite option ${key}`);
      }
    }
    for (const key of ["config", "pack"] as const) {
      const value = output[key];
      if (
        (key === "config" || value !== undefined) &&
        (typeof value !== "string" ||
          value.length < 1 ||
          value.length > 4_096 ||
          /[\0\r\n]/.test(value))
      ) {
        throw new TypeError(`Peekling Vite ${key} must be a bounded path`);
      }
    }
    if (
      output.baseUrl !== undefined &&
      (typeof output.baseUrl !== "string" || !absoluteHttpUrl(output.baseUrl))
    ) {
      throw new TypeError(
        "Peekling Vite baseUrl must be an absolute HTTP or HTTPS URL",
      );
    }
    return output as unknown as PeeklingViteOptions;
  } catch (cause) {
    if (cause instanceof TypeError && cause.message.includes("Peekling Vite"))
      throw cause;
    throw new TypeError(
      "Peekling Vite options must be a plain object with own data properties",
    );
  }
}

function absoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveInput(root: string, input: string, label: string): string {
  const resolved = path.resolve(root, input);
  const relative = path.relative(path.resolve(root), resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Peekling ${label} input must stay inside the Vite root`);
  }
  if (path.extname(resolved).toLowerCase() !== ".json") {
    throw new Error(`Peekling ${label} input must be a JSON data file`);
  }
  const canonical = realpathSync(resolved);
  const canonicalRelative = path.relative(root, canonical);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(
      `Peekling ${label} input must stay inside the real Vite root`,
    );
  }
  if (canonical !== resolved) {
    throw new Error(`Peekling ${label} input has a symbolic path component`);
  }
  return canonical;
}

function formatIssue(
  severity: "error" | "warning",
  issue: { code: string; path: string; message: string; fix: string },
): string {
  return `${severity.toUpperCase()} ${issue.code} at ${issue.path}\n  ${issue.message}\n  Fix: ${issue.fix}`;
}
