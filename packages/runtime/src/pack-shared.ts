import { ASSET_PATH_PATTERN, STATE_NAME_PATTERN } from "./contracts.js";
import { addPackIssue, throwPackIssue } from "./errors.js";
import type { NormalizedPack, StateDefinition } from "./types.js";

const MIN_STATE_FPS = 0.1;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type AtlasVariant = NonNullable<NormalizedPack["atlas"]["variants"]>[number];

export function validateSha256(
  value: unknown,
  path: string,
  issues: string[],
): value is string {
  if (typeof value === "string" && SHA256_PATTERN.test(value)) return true;
  addPackIssue(
    issues,
    path,
    `${path} must be 64 lowercase hexadecimal characters`,
  );
  return false;
}

export function validateDensityVariants(
  input: unknown,
  options: {
    path: string;
    logicalWidth?: number;
    logicalHeight?: number;
    native?: boolean;
  },
  issues: string[],
): AtlasVariant[] {
  const result: AtlasVariant[] = [];
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) {
    addPackIssue(
      issues,
      `${options.path}.limit`,
      `${options.path} must contain 1-3 variants`,
    );
    return result;
  }
  const seen = new Set<number>();
  for (const [index, value] of input.entries()) {
    const path = `${options.path}.${index}`;
    if (!record(value)) {
      addPackIssue(issues, path, `${path} must be an object`);
      continue;
    }
    closed(
      value,
      options.native
        ? ["src", "density", "sourceCellSize", "sha256"]
        : ["src", "density", "cellWidth", "cellHeight", "sha256"],
      path,
      issues,
    );
    const density = value.density;
    const validDensity =
      (density === 1 || density === 2 || density === 4) && !seen.has(density);
    const src = value.src;
    const validSource =
      typeof src === "string" &&
      ASSET_PATH_PATTERN.test(src) &&
      (options.native ? /\.png$/i : /\.(?:png|webp)$/i).test(src);
    const sha256 = value.sha256;
    const validHash = validateSha256(sha256, `${path}.sha256`, issues);
    const cellWidth = options.native
      ? Number(options.logicalWidth) * Number(density)
      : value.cellWidth;
    const cellHeight = options.native
      ? Number(options.logicalHeight) * Number(density)
      : value.cellHeight;
    const validDimensions = options.native
      ? value.sourceCellSize === cellWidth && cellWidth === cellHeight
      : Number.isInteger(cellWidth) &&
        (cellWidth as number) >= 1 &&
        (cellWidth as number) <= 1_024 &&
        Number.isInteger(cellHeight) &&
        (cellHeight as number) >= 1 &&
        (cellHeight as number) <= 1_024;
    if (!validDimensions) {
      addPackIssue(
        issues,
        `${path}.dimensions`,
        options.native
          ? `${path}.sourceCellSize does not match density`
          : `${path} has invalid cell dimensions`,
      );
      continue;
    }
    if (!validDensity || !validSource) {
      addPackIssue(
        issues,
        `${path}.density`,
        `${path} has invalid or duplicate density data`,
      );
      continue;
    }
    if (!validHash) continue;
    seen.add(density);
    result.push({
      src,
      density,
      cellWidth: cellWidth as number,
      cellHeight: cellHeight as number,
      sha256,
    });
  }
  return result.sort((left, right) => left.density - right.density);
}

export function validateStateMap(
  input: unknown,
  cellCount: number,
  issues: string[],
): Record<string, StateDefinition> {
  const states: Record<string, StateDefinition> = Object.create(null) as Record<
    string,
    StateDefinition
  >;
  if (!record(input)) {
    addPackIssue(issues, "states", "states must be an object");
    return states;
  }
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > 64) {
    addPackIssue(issues, "states.limit", "states must contain 1-64 entries");
  }
  for (const [name, value] of entries) {
    const path = `states.${name}`;
    if (
      !STATE_NAME_PATTERN.test(name) ||
      ["constructor", "prototype", "__proto__"].includes(name) ||
      !record(value)
    ) {
      addPackIssue(issues, path, `${path} is invalid`);
      continue;
    }
    closed(value, ["frames", "fps", "loop", "durations"], path, issues);
    const frames = value.frames;
    const durations = value.durations;
    if (
      !Array.isArray(frames) ||
      frames.length === 0 ||
      frames.length > 64 ||
      frames.some(
        (frame) => !Number.isInteger(frame) || frame < 0 || frame >= cellCount,
      )
    ) {
      addPackIssue(
        issues,
        `${path}.frames`,
        `${path}.frames must contain 1-64 in-bounds integers`,
      );
      continue;
    }
    const hasFps = value.fps !== undefined;
    const hasDurations = durations !== undefined;
    const fpsValid =
      typeof value.fps === "number" &&
      Number.isFinite(value.fps) &&
      value.fps >= MIN_STATE_FPS &&
      value.fps <= 60;
    const durationsValid =
      Array.isArray(durations) &&
      durations.length === frames.length &&
      durations.every(
        (duration) =>
          typeof duration === "number" &&
          Number.isFinite(duration) &&
          duration >= 16 &&
          duration <= 10_000,
      ) &&
      durations.reduce((sum: number, duration: number) => sum + duration, 0) <=
        60_000;
    if (
      hasFps === hasDurations ||
      typeof value.loop !== "boolean" ||
      (hasFps && !fpsValid) ||
      (hasDurations && !durationsValid)
    ) {
      addPackIssue(
        issues,
        `${path}.timing`,
        hasDurations && !durationsValid
          ? `${path}.durations must match frames and be bounded`
          : hasFps && !fpsValid
            ? `${path}.fps must be >=${MIN_STATE_FPS} and <=60`
            : `${path} needs boolean loop and one of fps or durations`,
      );
      continue;
    }
    states[name] = hasFps
      ? {
          frames: [...frames] as number[],
          loop: value.loop,
          fps: value.fps as number,
        }
      : {
          frames: [...frames] as number[],
          loop: value.loop,
          durations: [...(durations as number[])],
        };
  }
  if (!states.idle) {
    addPackIssue(issues, "states.idle", "states.idle is required");
  }
  return states;
}

export function validateMotionKeyframes(
  input: unknown,
  path: string,
  issues: string[],
): Array<{ at: number; advance: number; lift: number }> {
  const result: Array<{ at: number; advance: number; lift: number }> = [];
  if (!Array.isArray(input) || input.length < 2 || input.length > 8) {
    addPackIssue(issues, `${path}.limit`, `${path} needs 2-8 keyframes`);
    return result;
  }
  for (const [index, value] of input.entries()) {
    const itemPath = `${path}.${index}`;
    const previous = result.at(-1);
    if (record(value)) {
      closed(value, ["at", "advance", "lift"], itemPath, issues);
    }
    if (
      !record(value) ||
      !Number.isFinite(value.at) ||
      !Number.isFinite(value.advance) ||
      !Number.isFinite(value.lift) ||
      (value.at as number) < 0 ||
      (value.at as number) > 1 ||
      (value.advance as number) < 0 ||
      (value.advance as number) > 1 ||
      (value.lift as number) < 0 ||
      (value.lift as number) > 0.5 ||
      (previous !== undefined &&
        ((value.at as number) <= previous.at ||
          (value.advance as number) < previous.advance))
    ) {
      addPackIssue(
        issues,
        itemPath,
        `${itemPath} needs increasing at and bounded motion values`,
      );
      continue;
    }
    result.push({
      at: value.at as number,
      advance: value.advance as number,
      lift: value.lift as number,
    });
  }
  if (
    result.length === input.length &&
    (result[0]!.at !== 0 ||
      result[0]!.advance !== 0 ||
      result[0]!.lift !== 0 ||
      result.at(-1)!.at !== 1 ||
      result.at(-1)!.advance !== 1 ||
      result.at(-1)!.lift !== 0)
  ) {
    addPackIssue(
      issues,
      `${path}.endpoints`,
      `${path} endpoints must be 0/0/0 and 1/1/0`,
    );
  }
  return result;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function closed(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      addPackIssue(issues, `${path}.${key}`, `${path}.${key} is not allowed`);
    }
  }
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_SIDE = 4_096;
const MAX_IMAGE_CHUNKS = 4_096;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type ImageMimeType = "image/png" | "image/webp";

export interface ImageStructure {
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly mimeType: ImageMimeType;
}

export function inspectImageStructure(
  bytes: Uint8Array,
  mimeType: ImageMimeType,
): ImageStructure {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throwPackIssue("resource.size", "Image exceeds 32 MiB");
  }
  const png = hasPngSignature(bytes);
  const webp = hasWebpSignature(bytes);
  if (
    (mimeType === "image/png" && webp) ||
    (mimeType === "image/webp" && png)
  ) {
    throwPackIssue("atlas.mime", "Content-Type does not match atlas bytes");
  }
  return mimeType === "image/png" ? inspectPng(bytes) : inspectWebp(bytes);
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    chunkName(bytes, 0) === "RIFF" &&
    chunkName(bytes, 8) === "WEBP"
  );
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function inspectPng(bytes: Uint8Array): ImageStructure {
  if (!hasPngSignature(bytes)) {
    throwPackIssue("png.signature", "Invalid PNG signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let chunks = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawTransparency = false;
  let sawData = false;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) {
      throwPackIssue("png.truncated", "PNG is truncated");
    }
    const length = view.getUint32(offset);
    const dataOffset = offset + 8;
    const next = dataOffset + length + 4;
    if (next > bytes.byteLength || next < dataOffset) {
      throwPackIssue("png.chunk", "PNG chunk is truncated");
    }
    const type = chunkName(bytes, offset + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throwPackIssue("png.chunk-type", "PNG chunk type is invalid");
    }
    chunks += 1;
    if (chunks > MAX_IMAGE_CHUNKS) {
      throwPackIssue("png.chunks", "PNG has too many chunks");
    }
    if (!sawHeader && (type !== "IHDR" || length !== 13)) {
      throwPackIssue("png.ihdr-first", "PNG must start with a 13-byte IHDR");
    }
    if (type === "IHDR") {
      if (sawHeader || length !== 13) {
        throwPackIssue("png.ihdr", "PNG has an invalid IHDR");
      }
      sawHeader = true;
      width = view.getUint32(dataOffset);
      height = view.getUint32(dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8]!;
      colorType = bytes[dataOffset + 9]!;
      const allowedDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_IMAGE_SIDE ||
        height > MAX_IMAGE_SIDE
      ) {
        throwPackIssue(
          "png.dimensions",
          `PNG dimensions must be 1-${MAX_IMAGE_SIDE} per side`,
        );
      }
      if (
        !allowedDepths[colorType]?.includes(bitDepth) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1)
      ) {
        throwPackIssue("png.fields", "PNG IHDR fields are invalid");
      }
    } else if (type === "PLTE") {
      if (sawData) {
        throwPackIssue("png.palette-order", "PNG palette is misplaced");
      }
      sawPalette = true;
    } else if (type === "tRNS") {
      if (sawData) {
        throwPackIssue("png.alpha-order", "PNG transparency is misplaced");
      }
      sawTransparency = true;
    } else if (type === "IDAT") {
      if (colorType === 3 && !sawPalette) {
        throwPackIssue("png.palette", "Indexed PNG requires a palette");
      }
      sawData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawData) {
        throwPackIssue("png.iend", "PNG has an invalid IEND");
      }
      if (next !== bytes.byteLength) {
        throwPackIssue("png.trailing", "PNG has trailing bytes");
      }
      return {
        width,
        height,
        hasAlpha:
          colorType === 4 ||
          colorType === 6 ||
          (colorType === 3 && sawTransparency),
        mimeType: "image/png",
      };
    } else if (type.charCodeAt(0) <= 0x5a) {
      throwPackIssue(
        "png.critical",
        `PNG contains unsupported critical chunk ${type}`,
      );
    }
    offset = next;
  }
  throwPackIssue("png.truncated", "PNG is truncated");
}

function inspectWebp(bytes: Uint8Array): ImageStructure {
  if (bytes.byteLength < 20 || !hasWebpSignature(bytes)) {
    throwPackIssue("webp.header", "Invalid WebP header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throwPackIssue("webp.size", "WebP size header is invalid");
  }
  let offset = 12;
  let chunks = 0;
  let alphaChunk = false;
  let canvas: ImageStructure | undefined;
  let image: ImageStructure | undefined;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) {
      throwPackIssue("webp.chunk", "WebP chunk is truncated");
    }
    const type = chunkName(bytes, offset);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const next = dataOffset + length + (length & 1);
    if (next < dataOffset || next > bytes.byteLength) {
      throwPackIssue("webp.chunk", "WebP chunk is truncated");
    }
    chunks += 1;
    if (chunks > MAX_IMAGE_CHUNKS) {
      throwPackIssue("webp.chunks", "WebP has too many chunks");
    }
    if (type === "ALPH") {
      alphaChunk = true;
    } else if (type === "VP8X") {
      if (length < 10) {
        throwPackIssue("webp.vp8x", "WebP VP8X header is truncated");
      }
      canvas = webpResult(
        1 + uint24(bytes, dataOffset + 4),
        1 + uint24(bytes, dataOffset + 7),
        (bytes[dataOffset]! & 0x10) !== 0 || alphaChunk,
      );
    } else if (type === "VP8L") {
      if (length < 5 || bytes[dataOffset] !== 0x2f) {
        throwPackIssue("webp.vp8l", "WebP VP8L header is invalid");
      }
      const packed = view.getUint32(dataOffset + 1, true);
      const payload = webpResult(
        1 + (packed & 0x3fff),
        1 + ((packed >>> 14) & 0x3fff),
        true,
      );
      image ??= canvas ?? payload;
    } else if (type === "VP8 ") {
      if (
        length < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        throwPackIssue("webp.vp8", "WebP VP8 header is invalid");
      }
      const payload = webpResult(
        view.getUint16(dataOffset + 6, true) & 0x3fff,
        view.getUint16(dataOffset + 8, true) & 0x3fff,
        alphaChunk,
      );
      image ??= canvas ?? payload;
    } else if (
      !canvas &&
      !image &&
      type !== "ICCP" &&
      type !== "EXIF" &&
      type !== "XMP "
    ) {
      throwPackIssue(
        "webp.chunk-type",
        "WebP has an unsupported leading chunk",
      );
    }
    offset = next;
  }
  if (image) return image;
  throwPackIssue("webp.image", "WebP image chunk is missing");
}

function uint24(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function webpResult(
  width: number,
  height: number,
  hasAlpha: boolean,
): ImageStructure {
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE
  ) {
    throwPackIssue(
      "webp.dimensions",
      `WebP dimensions must be 1-${MAX_IMAGE_SIDE} per side`,
    );
  }
  return { width, height, hasAlpha, mimeType: "image/webp" };
}
