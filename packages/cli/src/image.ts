import { inspectImageStructure } from "@peekling/runtime/pack";
import type { ImageStructure } from "@peekling/runtime/pack";
import { inspectPng } from "./png.js";

export type ImageInfo = ImageStructure;

export function inspectImage(buffer: Buffer, fileName: string): ImageInfo {
  if (fileName.toLowerCase().endsWith(".png"))
    return { ...inspectPng(buffer), mimeType: "image/png" };
  return inspectImageStructure(buffer, "image/webp");
}
