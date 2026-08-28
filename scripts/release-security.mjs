import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const textBasenames = new Set([
  ".gitignore",
  ".npmignore",
  ".prettierignore",
  ".prettierrc",
  "AUTHORS",
  "LICENSE",
  "NOTICE",
]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".map",
  ".md",
  ".mjs",
  ".mts",
  ".properties",
  ".sh",
  ".sri",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export async function scanReleaseFiles(root, files, scope = "source") {
  const resolvedRoot = path.resolve(root);
  const findings = [];
  for (const input of files) {
    const relative = normalizeRelative(input);
    const pathFinding = forbiddenPath(relative);
    if (pathFinding) {
      findings.push({ ...pathFinding, file: relative, scope });
    }
    const target = path.resolve(resolvedRoot, ...relative.split("/"));
    const containment = path.relative(resolvedRoot, target);
    if (
      containment === ".." ||
      containment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containment)
    ) {
      throw new Error(`Release scan path must stay relative: ${input}`);
    }
    let content;
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) {
        findings.push({
          code: "symbolic-link",
          file: relative,
          scope,
          message:
            "release source and packages must not contain symbolic links",
        });
        continue;
      }
      const knownText = isTextLike(relative);
      if (metadata.size > MAX_TEXT_BYTES) {
        if (knownText || (await sampleLooksTextual(target))) {
          findings.push({
            code: "oversized-text",
            file: relative,
            scope,
            message: `text file exceeds ${MAX_TEXT_BYTES} bytes`,
          });
        }
        continue;
      }
      const bytes = await readFile(target);
      if (!knownText && !looksTextual(bytes)) continue;
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      findings.push({
        code: "unreadable-text",
        file: relative,
        scope,
        message: cause instanceof Error ? cause.message : "file is unreadable",
      });
      continue;
    }
    for (const finding of sensitiveContent(content)) {
      findings.push({ ...finding, file: relative, scope });
    }
  }
  return findings;
}

async function sampleLooksTextual(file) {
  const handle = await open(file, "r");
  try {
    const sample = Buffer.allocUnsafe(8192);
    const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0);
    return looksTextual(sample.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function looksTextual(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function formatReleaseFindings(findings) {
  return findings
    .map(
      ({ code, file, scope, message }) =>
        `[${scope}:${code}] ${file}: ${message}`,
    )
    .join("\n");
}

function normalizeRelative(input) {
  if (typeof input !== "string" || input.includes("\0")) {
    throw new Error(`Release scan path must stay relative: ${String(input)}`);
  }
  const portable = input.replaceAll("\\", "/");
  if (/^[A-Za-z]:/.test(portable) || portable.startsWith("//")) {
    throw new Error(`Release scan path must stay relative: ${input}`);
  }
  const normalized = path.posix.normalize(portable.replace(/^\.\//, ""));
  if (
    !normalized ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Release scan path must stay relative: ${input}`);
  }
  return normalized;
}

function forbiddenPath(relative) {
  if (/(?:^|\/)private(?:\/|$)/i.test(relative)) {
    return {
      code: "forbidden-private-path",
      message: "public release source must not contain a private path",
    };
  }
  if (/(?:^|\/)\.(?:env|npmrc)(?:\.|$)/i.test(relative)) {
    return {
      code: "sensitive-file-name",
      message: "environment and npm credential files are forbidden",
    };
  }
  if (/\.(?:key|p12|pfx|pem)$/i.test(relative)) {
    return {
      code: "sensitive-file-name",
      message: "key and certificate containers are forbidden",
    };
  }
}

function isTextLike(relative) {
  const basename = path.posix.basename(relative);
  if (textBasenames.has(basename)) return true;
  if (/\.(?:d\.)?ts\.map$/i.test(basename)) return true;
  return textExtensions.has(path.posix.extname(basename).toLowerCase());
}

function sensitiveContent(content) {
  const patterns = [
    [
      "private-key",
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      "private key material is forbidden",
    ],
    [
      "npm-token",
      /\bnpm_[A-Za-z0-9]{36,}\b/,
      "an npm access token pattern was found",
    ],
    [
      "npm-auth-token",
      /(?:^|\n)\s*(?:\/\/[^\n=]+\/:)?_authToken\s*=\s*(?!<|\$\{)[^\s#]{8,}/,
      "an npm auth token assignment was found",
    ],
    [
      "github-token",
      /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/,
      "a GitHub token pattern was found",
    ],
    [
      "aws-access-key",
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
      "an AWS access key pattern was found",
    ],
    [
      "local-home-path",
      /(?:\/Users\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/,
      "an absolute user home path was found",
    ],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([code, , message]) => ({ code, message }));
}

async function main(args) {
  if (args[0] !== "scan") throw new Error("Expected the scan command");
  const root = option(args, "--root");
  const scope = option(args, "--scope") ?? "source";
  const files = repeated(args, "--file");
  if (!root || files.length === 0) {
    throw new Error("scan requires --root and at least one --file");
  }
  const findings = await scanReleaseFiles(path.resolve(root), files, scope);
  if (findings.length) {
    console.error(formatReleaseFindings(findings));
    process.exitCode = 1;
  } else {
    console.log(`Release ${scope} scan found no forbidden material.`);
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function repeated(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
