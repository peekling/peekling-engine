import {
  packIssue,
  PackLoadError,
  PackValidationError,
  throwPackIssue,
} from "./errors.js";
import type { PackLoadFailureCategory } from "./errors.js";
import { isNormalizedPack, validateNormalizedPack } from "./normalized.js";
import {
  parseManifestText,
  selectNativeDensity,
  validateNativePack,
} from "./pack.js";
import { inspectImageStructure, SHA256_PATTERN } from "./pack-shared.js";
import type { ImageMimeType } from "./pack-shared.js";
import { characterPackReference } from "./registry.js";
import type { NativeDensity, NormalizedPack } from "./types.js";
import { OwnDataError, snapshotPackData } from "./own-data.js";
import {
  compactRuntimeDiagnostics,
  runtimeMessage,
} from "./runtime-diagnostics.js";
import { isHttpPath } from "./contracts.js";

const DEFAULT_RESOURCE_TIMEOUT_MS = 30_000;

export interface LoadPackOptions {
  character?: string;
  baseUrl: string;
  pack?: unknown;
  packUrl?: string;
  atlasUrl?: string;
  renderScale?: number;
  devicePixelRatio?: number;
  densityOverride?: NativeDensity;
  maxDensity?: NativeDensity;
  fetch: typeof globalThis.fetch;
  image: () => HTMLImageElement;
  signal: AbortSignal;
  /** Package-internal override used by deterministic loader tests. */
  resourceTimeoutMs?: number;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  diagnostic?: (message: string, category?: PackLoadFailureCategory) => void;
}

export type { PackLoadFailureCategory } from "./errors.js";

export interface LoadedPack {
  readonly content: NormalizedPack;
  readonly atlasObjectUrl: string;
  readonly loadedDensity: number;
  upgrade(requiredDensity: number): Promise<boolean>;
  release(): void;
}

export function resolveManifestUrl(input: string, base: string): string {
  if (!isHttpPath(input, base))
    throwPackIssue("url.protocol", "Relative path or HTTPS required");
  try {
    return new URL(input, base).href;
  } catch {
    throwPackIssue("url.invalid", "Invalid pack URL");
  }
}

function requireMime(response: Response, allowed: readonly string[]): string {
  const mime = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!mime || !allowed.includes(mime)) {
    throwPackIssue("mime.invalid", "Invalid Content-Type");
  }
  return mime;
}

function failureCategory(error: unknown): PackLoadFailureCategory {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "abort";
  }
  if (error instanceof PackLoadError) return error.category;
  if (error instanceof PackValidationError) {
    for (const code of error.issueCodes) {
      const suffix = code.slice(code.indexOf(".") + 1);
      if (suffix === "hash") return "hash";
      if (code === "mime.invalid" || suffix === "mime") return "mime";
      if (
        code.startsWith("png.") ||
        code.startsWith("webp.") ||
        (code.startsWith("atlas.") &&
          ["dimensions", "pixels", "alpha", "size"].includes(suffix))
      ) {
        return "image";
      }
      if (suffix === "size") return "size";
      if (suffix.startsWith("integrity-")) return "integrity";
    }
  }
  return "validation";
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

const packLoadMessage: (code: string, value?: number) => string =
  compactRuntimeDiagnostics
    ? (code) => code
    : (code, value) => {
        switch (code) {
          case "manifest.network":
            return value === 1
              ? "Manifest response failed"
              : "Manifest network request failed";
          case "atlas.network":
            return value === 1
              ? "Atlas response failed"
              : "Atlas network request failed";
          case "manifest.timeout":
            return "Manifest request timed out";
          case "atlas.timeout":
            return "Atlas request timed out";
          case "manifest.http":
            return `Manifest HTTP ${value}`;
          case "atlas.http":
            return `Atlas HTTP ${value}`;
          case "atlas.decode":
            return "Atlas decode failed";
          case "atlas.unusable":
            return "No usable atlas";
          default:
            return code;
        }
      };

interface ResourceDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  close(): void;
}

function resourceDeadline(
  parent: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
): ResourceDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(
      new DOMException(packLoadMessage(timeoutCode), "TimeoutError"),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    close() {
      globalThis.clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

async function withResourceDeadline<T>(
  parent: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = resourceDeadline(parent, timeoutMs, timeoutCode);
  try {
    return await operation(deadline.signal);
  } catch (error) {
    if (
      deadline.timedOut &&
      (error === deadline.signal.reason ||
        (error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError")))
    ) {
      throw new PackLoadError(
        timeoutCode,
        "timeout",
        packLoadMessage(timeoutCode),
        error,
      );
    }
    throw error;
  } finally {
    deadline.close();
  }
}

async function fetchResource(
  fetcher: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal,
  code: string,
): Promise<Response> {
  try {
    return await fetcher(url, { signal });
  } catch (error) {
    if (isAbortFailure(error, signal)) throw error;
    throw new PackLoadError(code, "network", packLoadMessage(code), error);
  }
}

async function readResponseBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
  code: string,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await responseBytes(response, limit, signal);
  } catch (error) {
    if (
      isAbortFailure(error, signal) ||
      error instanceof PackLoadError ||
      error instanceof PackValidationError
    ) {
      throw error;
    }
    throw new PackLoadError(code, "network", packLoadMessage(code, 1), error);
  }
}

function inspectAtlasBytes(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  normalized: boolean,
  expected: { width: number; height: number },
): void {
  const geometry = inspectImageStructure(bytes, mime as ImageMimeType);
  if (
    geometry.width !== expected.width ||
    geometry.height !== expected.height
  ) {
    throwPackIssue(
      "atlas.dimensions",
      `Atlas must be exactly ${expected.width}x${expected.height}`,
    );
  }
  if (!normalized && !geometry.hasAlpha) {
    throwPackIssue("atlas.alpha", "Native PNG atlas requires alpha");
  }
}

async function matchesSha256(
  bytes: Uint8Array<ArrayBuffer>,
  expected: string,
  manifest = false,
): Promise<boolean> {
  const subject = manifest ? "Selected character manifest" : "Atlas";
  const codePrefix = manifest ? "manifest" : "atlas";
  if (!SHA256_PATTERN.test(expected)) {
    throwPackIssue(
      `${codePrefix}.integrity-declaration`,
      `${subject} SHA-256 declaration is invalid`,
    );
  }
  let digest: SubtleCrypto["digest"] | undefined;
  try {
    const subtle = globalThis.crypto?.subtle;
    digest = subtle?.digest.bind(subtle);
  } catch {}
  if (!digest) {
    throwPackIssue(
      `${codePrefix}.integrity-unavailable`,
      `${subject} SHA-256 integrity verification is unavailable`,
    );
  }
  try {
    const computed = new Uint8Array(await digest("SHA-256", bytes));
    return !computed.some(
      (byte, index) =>
        byte !== Number.parseInt(expected.slice(index * 2, index * 2 + 2), 16),
    );
  } catch {
    throwPackIssue(
      `${codePrefix}.integrity-failed`,
      `${subject} SHA-256 integrity verification failed`,
    );
  }
}

async function imageGeometry(
  image: HTMLImageElement,
  objectUrl: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number }> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      image.removeEventListener("load", load);
      image.removeEventListener("error", error);
      signal.removeEventListener("abort", abort);
    };
    const load = () => {
      cleanup();
      resolve();
    };
    const error = () => {
      cleanup();
      reject(
        new PackLoadError(
          "atlas.decode",
          "decode",
          packLoadMessage("atlas.decode"),
        ),
      );
    };
    const abort = () => {
      cleanup();
      image.removeAttribute("src");
      reject(signal.reason);
    };
    image.addEventListener("load", load, { once: true });
    image.addEventListener("error", error, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    image.src = objectUrl;
  });
  return { width: image.naturalWidth, height: image.naturalHeight };
}

async function responseBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throwPackIssue("resource.size", "Resource too large");
  if (!response.body) {
    const value = new Uint8Array(await response.arrayBuffer());
    if (value.byteLength > limit)
      throwPackIssue("resource.size", "Resource too large");
    return value;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throwPackIssue("resource.size", "Resource too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The original transport or abort failure is the useful diagnostic.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function requiredAtlasDensity(
  devicePixelRatio: number,
  renderScale: number,
  maxDensity: NativeDensity = 4,
): number {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.min(dpr * renderScale, maxDensity);
}

export async function loadNativePack(
  options: LoadPackOptions,
): Promise<LoadedPack> {
  const resourceTimeoutMs =
    options.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
  if (
    options.pack === undefined &&
    options.packUrl === undefined &&
    options.character === undefined
  ) {
    throwPackIssue(
      "manifest.selection",
      "Select an explicit character, packUrl, or pack",
    );
  }
  let raw: unknown;
  let manifestUrl = options.packUrl;
  let manifestSha256: string | undefined;
  if (options.pack !== undefined) raw = options.pack;
  else {
    if (manifestUrl === undefined) {
      const reference = characterPackReference(options.character!);
      manifestUrl = reference.url;
      manifestSha256 = reference.sha256;
    }
    const requestedManifestUrl = resolveManifestUrl(
      manifestUrl,
      options.baseUrl,
    );
    manifestUrl = requestedManifestUrl;
    const bytes = await withResourceDeadline(
      options.signal,
      resourceTimeoutMs,
      "manifest.timeout",
      async (signal) => {
        const response = await fetchResource(
          options.fetch,
          requestedManifestUrl,
          signal,
          "manifest.network",
        );
        if (!response.ok)
          throw new PackLoadError(
            "manifest.http",
            "http",
            packLoadMessage("manifest.http", response.status),
          );
        requireMime(response, ["application/json"]);
        return readResponseBytes(
          response,
          64 * 1024,
          signal,
          "manifest.network",
        );
      },
    );
    if (manifestSha256 && !(await matchesSha256(bytes, manifestSha256, true))) {
      throwPackIssue("manifest.hash", "Registered Peek manifest hash mismatch");
    }
    try {
      raw = parseManifestText(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      if (error instanceof PackValidationError) throw error;
      throwPackIssue("manifest.utf8", "Invalid manifest UTF-8");
    }
  }
  try {
    raw = snapshotPackData(raw);
  } catch (error) {
    if (error instanceof OwnDataError) {
      throw new PackValidationError(
        [error.message],
        error.issueCode ? [error.issueCode] : [],
      );
    }
    throw error;
  }

  const normalized = isNormalizedPack(raw);
  const validate = normalized ? validateNormalizedPack : validateNativePack;
  const first = validate(raw);
  const preferred =
    options.densityOverride ??
    requiredAtlasDensity(
      options.devicePixelRatio ?? 1,
      options.renderScale ?? first.defaultScale,
      options.maxDensity,
    );
  let selected = validate(raw, undefined, preferred);
  let released = false;
  let currentObjectUrl = "";

  const resolveUrl = (src: string) =>
    options.atlasUrl ??
    (manifestUrl
      ? new URL(src, new URL(manifestUrl, options.baseUrl)).href
      : undefined);

  const candidates = (
    required: number,
  ): Array<{ src: string; density: number; sha256: string }> => {
    const variants = first.atlas.variants;
    if (!variants?.length) {
      const density = selected.atlas.density ?? 1;
      if (
        options.densityOverride !== undefined &&
        options.densityOverride !== density
      ) {
        throwPackIssue(
          "atlas.override-density",
          "density must match the single atlas density",
        );
      }
      if (density > (options.maxDensity ?? 4)) {
        throwPackIssue(
          "atlas.max-density",
          "Single atlas density exceeds maxDensity",
        );
      }
      if (!selected.atlas.sha256) {
        throwPackIssue(
          "atlas.integrity-declaration",
          "Atlas SHA-256 declaration is missing",
        );
      }
      return [
        {
          src: selected.atlas.src,
          density,
          sha256: selected.atlas.sha256,
        },
      ];
    }
    const available = variants.filter(
      (item) => item.density <= (options.maxDensity ?? 4),
    );
    if (!available.length)
      throwPackIssue(
        "atlas.max-density",
        "No atlas variant at or below maxDensity",
      );
    if (options.atlasUrl !== undefined) {
      if (options.densityOverride === undefined) {
        throwPackIssue(
          "atlas.override-density",
          "atlasUrl with variants requires an explicit density",
        );
      }
      const overridden = available.find(
        (item) => item.density === options.densityOverride,
      );
      if (!overridden) {
        throwPackIssue(
          "atlas.override-density",
          "atlasUrl density must name a declared variant at or below maxDensity",
        );
      }
      return [overridden];
    }
    const target = selectNativeDensity(
      available.map((item) => item.density),
      required,
    );
    return available
      .filter((item) => item.density <= target)
      .sort((a, b) => b.density - a.density);
  };

  const fetchCandidate = async (candidate: {
    src: string;
    density: number;
    sha256: string;
  }) => {
    const assetUrl = resolveUrl(candidate.src);
    if (!assetUrl) throwPackIssue("atlas.url", "atlasUrl required");
    const [mime, bytes] = await withResourceDeadline(
      options.signal,
      resourceTimeoutMs,
      "atlas.timeout",
      async (signal) => {
        const response = await fetchResource(
          options.fetch,
          assetUrl,
          signal,
          "atlas.network",
        );
        if (!response.ok)
          throw new PackLoadError(
            "atlas.http",
            "http",
            packLoadMessage("atlas.http", response.status),
          );
        const mime = requireMime(
          response,
          normalized ? ["image/png", "image/webp"] : ["image/png"],
        );
        const bytes = await readResponseBytes(
          response,
          normalized ? 32 * 1024 * 1024 : 4 * 1024 * 1024,
          signal,
          "atlas.network",
        );
        return [mime, bytes] as const;
      },
    );
    if (!(await matchesSha256(bytes, candidate.sha256))) {
      throwPackIssue("atlas.hash", "Atlas hash mismatch");
    }
    const candidatePack = validate(raw, undefined, candidate.density);
    inspectAtlasBytes(bytes, mime, normalized, {
      width: candidatePack.atlas.columns * candidatePack.atlas.cellWidth,
      height: candidatePack.atlas.rows * candidatePack.atlas.cellHeight,
    });
    const objectUrl = options.createObjectURL(new Blob([bytes]));
    try {
      const geometry = await imageGeometry(
        options.image(),
        objectUrl,
        options.signal,
      );
      const pack = validate(
        raw,
        { ...geometry, byteLength: bytes.byteLength },
        candidate.density,
      );
      return { pack, objectUrl };
    } catch (error) {
      options.revokeObjectURL(objectUrl);
      throw error;
    }
  };

  const loadWithFallback = async (required: number, upgrading: boolean) => {
    let lastError: unknown;
    const available = candidates(required);
    for (const [index, candidate] of available.entries()) {
      if (upgrading && candidate.density <= (selected.atlas.density ?? 1))
        return undefined;
      try {
        return await fetchCandidate(candidate);
      } catch (error) {
        if (options.signal.aborted) {
          options.diagnostic?.(
            runtimeMessage("atlas.abort", "Atlas load aborted."),
            "abort",
          );
          throw error;
        }
        lastError = error;
        const category = failureCategory(error);
        const fallback = index < available.length - 1;
        options.diagnostic?.(
          runtimeMessage(
            `atlas.${category}.${fallback ? "fallback" : "exhausted"}`,
            () =>
              `Atlas ${candidate.density}x failed (${category}); ${fallback ? "falling back" : "no fallback remains"}.`,
          ),
          category,
        );
      }
    }
    if (upgrading) return undefined;
    throw (
      lastError ??
      new PackLoadError(
        "atlas.unusable",
        "validation",
        packLoadMessage("atlas.unusable"),
      )
    );
  };

  const initial = await loadWithFallback(preferred, false);
  if (!initial)
    throw new PackLoadError(
      "atlas.unusable",
      "validation",
      packLoadMessage("atlas.unusable"),
    );
  selected = initial.pack;
  currentObjectUrl = initial.objectUrl;
  let desiredDensity: number = selected.atlas.density ?? 1;
  let upgradeGeneration = 0;
  const loaded: LoadedPack = {
    get content() {
      return selected;
    },
    get atlasObjectUrl() {
      return currentObjectUrl;
    },
    get loadedDensity() {
      return selected.atlas.density ?? 1;
    },
    async upgrade(requiredDensity) {
      if (
        released ||
        options.atlasUrl !== undefined ||
        requiredDensity <= loaded.loadedDensity
      )
        return false;
      desiredDensity = Math.max(desiredDensity, requiredDensity);
      const generation = ++upgradeGeneration;
      const next = await loadWithFallback(desiredDensity, true);
      const nextDensity = next?.pack.atlas.density ?? 1;
      if (
        !next ||
        released ||
        nextDensity <= loaded.loadedDensity ||
        (generation !== upgradeGeneration && nextDensity < desiredDensity)
      ) {
        if (next) options.revokeObjectURL(next.objectUrl);
        return false;
      }
      const previous = currentObjectUrl;
      selected = next.pack;
      currentObjectUrl = next.objectUrl;
      options.revokeObjectURL(previous);
      return true;
    },
    release() {
      if (released) return;
      released = true;
      if (currentObjectUrl) options.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = "";
    },
  };
  return loaded;
}
