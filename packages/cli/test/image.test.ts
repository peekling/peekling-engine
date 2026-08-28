import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectImageStructure,
  PackValidationError,
} from "@peekling/runtime/pack";
import { inspectImage } from "../dist/image.js";
import { createFixtureAtlas, inspectPng } from "../dist/png.js";

function webpChunk(type: string, data = Buffer.alloc(0), pad = true): Buffer {
  const output = Buffer.alloc(8 + data.length + (pad ? data.length & 1 : 0));
  output.write(type, 0, "ascii");
  output.writeUInt32LE(data.length, 4);
  data.copy(output, 8);
  return output;
}

function webp(chunks: readonly Buffer[]): Buffer {
  const output = Buffer.concat([Buffer.alloc(12), ...chunks]);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WEBP", 8, "ascii");
  return output;
}

function vp8(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", data);
}

function corruptIdatCrc(input: Buffer): Buffer {
  const output = Buffer.from(input);
  let offset = 8;
  while (offset + 12 <= output.length) {
    const length = output.readUInt32BE(offset);
    const end = offset + length + 12;
    if (output.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      output[end - 1] = output[end - 1]! ^ 1;
      return output;
    }
    offset = end;
  }
  throw new Error("missing IDAT");
}

test("CLI image inspection uses the shared structural result", () => {
  const png = createFixtureAtlas(2);
  for (const fileName of ["atlas.png", "ATLAS.PNG"]) {
    assert.deepEqual(inspectImage(png, fileName), {
      ...inspectImageStructure(png, "image/png"),
    });
  }

  const lossy = webp([vp8(11, 13)]);
  assert.deepEqual(inspectImage(lossy, "atlas.webp"), {
    ...inspectImageStructure(lossy, "image/webp"),
  });
});

test("CLI PNG inspection retains CRC and full-decode verification", () => {
  const corrupt = corruptIdatCrc(createFixtureAtlas(1));
  assert.doesNotThrow(() => inspectImageStructure(corrupt, "image/png"));
  assert.throws(() => inspectPng(corrupt), /CRC|checksum|decod/i);
});

test("runtime and CLI reject malformed WebP padding and chunk abuse", () => {
  const missingPad = webp([
    webpChunk("EXIF", Buffer.from([1]), false),
    vp8(1, 1),
  ]);
  assert.throws(
    () => inspectImageStructure(missingPad, "image/webp"),
    PackValidationError,
  );
  assert.throws(() => inspectImage(missingPad, "atlas.webp"));

  const excessive = webp([
    ...Array.from({ length: 4_097 }, () => webpChunk("EXIF")),
    vp8(1, 1),
  ]);
  assert.throws(
    () => inspectImageStructure(excessive, "image/webp"),
    PackValidationError,
  );
  assert.throws(() => inspectImage(excessive, "atlas.webp"));
});
