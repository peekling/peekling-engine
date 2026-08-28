import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectImageStructure,
  PackValidationError,
} from "../dist/pack-api.js";

const ASCII = new TextEncoder();

function pngChunk(type: string, data = new Uint8Array()): Uint8Array {
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength);
  output.set(ASCII.encode(type), 4);
  output.set(data, 8);
  return output;
}

function pngFixture(
  colorType = 6,
  extras: readonly Uint8Array[] = [],
  bitDepth = 8,
) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 3);
  header[8] = bitDepth;
  header[9] = colorType;
  return join([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...extras,
    pngChunk("IDAT"),
    pngChunk("IEND"),
  ]);
}

function webpChunk(
  type: string,
  data = new Uint8Array(),
  padded = true,
): Uint8Array {
  const output = new Uint8Array(
    8 + data.byteLength + (padded ? data.byteLength & 1 : 0),
  );
  const view = new DataView(output.buffer);
  output.set(ASCII.encode(type), 0);
  view.setUint32(4, data.byteLength, true);
  output.set(data, 8);
  return output;
}

function webpFixture(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    12 + chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
  );
  const view = new DataView(output.buffer);
  output.set(ASCII.encode("RIFF"), 0);
  view.setUint32(4, output.byteLength - 8, true);
  output.set(ASCII.encode("WEBP"), 8);
  let offset = 12;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function vp8x(width: number, height: number, alpha = false): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = alpha ? 0x10 : 0;
  writeUint24(data, 4, width - 1);
  writeUint24(data, 7, height - 1);
  return webpChunk("VP8X", data);
}

function vp8l(width: number, height: number): Uint8Array {
  const data = new Uint8Array(5);
  const packed = (width - 1) | ((height - 1) << 14);
  data[0] = 0x2f;
  new DataView(data.buffer).setUint32(1, packed, true);
  return webpChunk("VP8L", data);
}

function vp8(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  const view = new DataView(data.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return webpChunk("VP8 ", data);
}

function writeUint24(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((size, part) => size + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

test("the shared PNG inspector reports bounded geometry and alpha", () => {
  assert.deepEqual(inspectImageStructure(pngFixture(), "image/png"), {
    width: 2,
    height: 3,
    hasAlpha: true,
    mimeType: "image/png",
  });
  assert.equal(
    inspectImageStructure(
      pngFixture(3, [
        pngChunk("PLTE", new Uint8Array([0, 0, 0])),
        pngChunk("tRNS", new Uint8Array([0])),
      ]),
      "image/png",
    ).hasAlpha,
    true,
  );
  assert.equal(
    inspectImageStructure(pngFixture(2), "image/png").hasAlpha,
    false,
  );
});

test("the shared PNG inspector preserves the exact color/depth matrix", () => {
  const valid = [
    [0, 1],
    [0, 2],
    [0, 4],
    [0, 8],
    [0, 16],
    [2, 8],
    [2, 16],
    [3, 1],
    [3, 2],
    [3, 4],
    [3, 8],
    [4, 8],
    [4, 16],
    [6, 8],
    [6, 16],
  ] as const;
  for (const [colorType, bitDepth] of valid) {
    const extras =
      colorType === 3 ? [pngChunk("PLTE", new Uint8Array([0, 0, 0]))] : [];
    assert.equal(
      inspectImageStructure(
        pngFixture(colorType, extras, bitDepth),
        "image/png",
      ).width,
      2,
      `${colorType}/${bitDepth}`,
    );
  }
  for (const [colorType, bitDepth] of [
    [1, 8],
    [2, 4],
    [3, 16],
    [6, 1],
    [6, 33],
  ] as const) {
    assert.throws(
      () =>
        inspectImageStructure(pngFixture(colorType, [], bitDepth), "image/png"),
      (error: unknown) =>
        error instanceof PackValidationError &&
        error.issueCodes.includes("png.fields"),
      `${colorType}/${bitDepth}`,
    );
  }
});

test("the shared WebP inspector supports bounded image headers and odd padding", () => {
  const extended = webpFixture([
    webpChunk("EXIF", new Uint8Array([1])),
    vp8x(7, 9, true),
    vp8(3, 4),
    webpChunk("XMP ", new Uint8Array([2])),
  ]);
  assert.deepEqual(inspectImageStructure(extended, "image/webp"), {
    width: 7,
    height: 9,
    hasAlpha: true,
    mimeType: "image/webp",
  });
  assert.deepEqual(
    inspectImageStructure(webpFixture([vp8x(5, 6), vp8l(2, 3)]), "image/webp"),
    { width: 5, height: 6, hasAlpha: false, mimeType: "image/webp" },
  );
  assert.deepEqual(
    inspectImageStructure(webpFixture([vp8l(5, 6)]), "image/webp"),
    { width: 5, height: 6, hasAlpha: true, mimeType: "image/webp" },
  );
  assert.deepEqual(
    inspectImageStructure(webpFixture([vp8(11, 13)]), "image/webp"),
    { width: 11, height: 13, hasAlpha: false, mimeType: "image/webp" },
  );
  assert.equal(
    inspectImageStructure(
      webpFixture([webpChunk("ALPH", new Uint8Array([1])), vp8(11, 13)]),
      "image/webp",
    ).hasAlpha,
    true,
  );
});

test("VP8X canvas metadata without image data is rejected", () => {
  assert.throws(
    () => inspectImageStructure(webpFixture([vp8x(7, 9)]), "image/webp"),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.issueCodes.includes("webp.image"),
  );
});

test("VP8X canvas metadata does not mask a malformed image payload", () => {
  assert.throws(
    () =>
      inspectImageStructure(
        webpFixture([vp8x(7, 9), webpChunk("VP8 ", new Uint8Array(10))]),
        "image/webp",
      ),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.issueCodes.includes("webp.vp8"),
  );
});

test("the shared WebP inspector bounds chunks after image data", () => {
  const missingOddPad = webpFixture([
    vp8x(1, 1),
    vp8(1, 1),
    webpChunk("EXIF", new Uint8Array([1]), false),
  ]);
  assert.throws(
    () => inspectImageStructure(missingOddPad, "image/webp"),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.issueCodes.includes("webp.chunk"),
  );

  const excessive = webpFixture([
    vp8x(1, 1),
    vp8(1, 1),
    ...Array.from({ length: 4_095 }, () => webpChunk("EXIF")),
  ]);
  assert.throws(
    () => inspectImageStructure(excessive, "image/webp"),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.issueCodes.includes("webp.chunks"),
  );
});

test("the shared inspector rejects mismatches, truncation, and chunk abuse", () => {
  const png = pngFixture();
  assert.throws(
    () => inspectImageStructure(png, "image/webp"),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.issueCodes.includes("atlas.mime"),
  );

  const missingOddPad = webpFixture([
    webpChunk("EXIF", new Uint8Array([1]), false),
    vp8x(1, 1),
  ]);
  assert.throws(
    () => inspectImageStructure(missingOddPad, "image/webp"),
    PackValidationError,
  );

  const excessive = webpFixture([
    ...Array.from({ length: 4_097 }, () => webpChunk("EXIF")),
    vp8x(1, 1),
  ]);
  assert.throws(
    () => inspectImageStructure(excessive, "image/webp"),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.issueCodes.includes("webp.chunks"),
  );

  assert.throws(
    () =>
      inspectImageStructure(
        pngFixture(
          6,
          Array.from({ length: 4_097 }, () => pngChunk("tEXt")),
        ),
        "image/png",
      ),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.issueCodes.includes("png.chunks"),
  );

  assert.throws(
    () =>
      inspectImageStructure(
        join([png.subarray(0, -12), pngChunk("ABCD"), pngChunk("IEND")]),
        "image/png",
      ),
    PackValidationError,
  );
  assert.throws(
    () => inspectImageStructure(png.subarray(0, -1), "image/png"),
    PackValidationError,
  );
});
