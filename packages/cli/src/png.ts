import { inspectImageStructure } from "@peekling/runtime/pack";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
const COLOR_CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

export function createFixtureAtlas(rows = 3): Buffer {
  const width = 512;
  const height = rows * 32;
  const stride = width / 4 + 1;
  const pixels = Buffer.alloc(stride * height);

  const pixel = (x: number, y: number, value: number) => {
    const offset = y * stride + 1 + (x >> 2);
    pixels[offset] = pixels[offset]! | (value << (6 - (x & 3) * 2));
  };

  const usedCells = Math.min(rows * 16, 48);
  for (let cell = 0; cell < usedCells; cell++) {
    const originX = (cell % 16) * 32;
    const originY = Math.floor(cell / 16) * 32;
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const edge = x < 10 || x > 21 || y < 10 || y > 21;
        if (!edge && !((x + y + cell) % 11 === 0)) continue;
        pixel(originX + x, originY + y, 1 + (cell % 2));
      }
    }
    const markerX = 11 + (cell % 2) * 8;
    const markerY = 13 + (Math.floor(cell / 2) % 2) * 6;
    for (let y = markerY; y < markerY + 3; y++) {
      for (let x = markerX; x < markerX + 3; x++) {
        pixel(originX + x, originY + y, 3);
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([2, 3, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk(
      "PLTE",
      Buffer.from([0, 0, 0, 74, 144, 226, 226, 130, 74, 255, 255, 255]),
    ),
    chunk("tRNS", Buffer.from([0, 255, 255, 255])),
    chunk("IDAT", storedDeflate(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function inspectPng(buffer: Buffer): {
  width: number;
  height: number;
  hasAlpha: boolean;
} {
  const structure = inspectImageStructure(buffer, "image/png");
  const imageData: Buffer[] = [];
  let cursor = 8;
  while (cursor + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const end = cursor + 12 + length;
    const type = buffer.toString("ascii", cursor + 4, cursor + 8);
    const expectedCrc = buffer.readUInt32BE(end - 4);
    const actualCrc = crc32(buffer.subarray(cursor + 4, end - 4));
    if (actualCrc !== expectedCrc)
      throw new Error(`PNG ${type} chunk CRC is invalid`);
    if (type === "IDAT") imageData.push(buffer.subarray(cursor + 8, end - 4));
    cursor = end;
    if (type === "IEND") break;
  }
  const expectedInflatedBytes = inflatedPngByteLength(
    buffer,
    structure.width,
    structure.height,
  );
  const compressedBytes = Buffer.concat(imageData);
  let inflatedBytes: Buffer;
  let consumedBytes: number;
  try {
    const result = inflateSync(compressedBytes, {
      info: true,
      maxOutputLength: expectedInflatedBytes,
    }) as unknown as {
      readonly buffer: Buffer;
      readonly engine: { readonly bytesWritten: number };
    };
    inflatedBytes = result.buffer;
    consumedBytes = result.engine.bytesWritten;
  } catch {
    throw new Error("atlas is not a decodable PNG file");
  }
  if (
    inflatedBytes.length !== expectedInflatedBytes ||
    consumedBytes !== compressedBytes.length
  )
    throw new Error("atlas is not a decodable PNG file");
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(buffer, { checkCRC: true });
  } catch {
    throw new Error("atlas is not a decodable PNG file");
  }
  if (
    decoded.width !== structure.width ||
    decoded.height !== structure.height ||
    decoded.data.length !== structure.width * structure.height * 4
  )
    throw new Error("decoded PNG geometry does not match IHDR");
  return {
    width: structure.width,
    height: structure.height,
    hasAlpha: structure.hasAlpha,
  };
}

function inflatedPngByteLength(
  buffer: Buffer,
  width: number,
  height: number,
): number {
  const bitsPerPixel = COLOR_CHANNELS[buffer[25]!]! * buffer[24]!;
  if (buffer[28] === 0)
    return filteredPassByteLength(width, height, bitsPerPixel);
  return ADAM7_PASSES.reduce(
    (total, [startX, startY, stepX, stepY]) =>
      total +
      filteredPassByteLength(
        passLength(width, startX, stepX),
        passLength(height, startY, stepY),
        bitsPerPixel,
      ),
    0,
  );
}

function passLength(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function filteredPassByteLength(
  width: number,
  height: number,
  bitsPerPixel: number,
): number {
  return width === 0 || height === 0
    ? 0
    : height * (Math.ceil((width * bitsPerPixel) / 8) + 1);
}

function storedDeflate(data: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < data.length; offset += 65_535) {
    const length = Math.min(65_535, data.length - offset);
    const header = Buffer.alloc(5);
    header[0] = offset + length === data.length ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(~length & 0xffff, 3);
    parts.push(header, data.subarray(offset, offset + length));
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(((b << 16) | a) >>> 0);
  parts.push(checksum);
  return Buffer.concat(parts);
}
