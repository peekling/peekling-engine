import { createCanvasRenderer } from "./canvas-renderer.js";
import {
  PeeklingRuntime,
  type PeeklingHatchInput,
  type PeeklingInstance,
  type PeeklingMotionPreference,
  type PeeklingOptions,
} from "./runtime.js";

/** Hatch with Canvas 2D character pixels and accessible DOM content surfaces. */
export function hatchCanvas(
  input: PeeklingHatchInput | PeeklingOptions,
): PeeklingInstance {
  return PeeklingRuntime.hatch(input, createCanvasRenderer);
}

export type {
  PeeklingHatchInput,
  PeeklingInstance,
  PeeklingMotionPreference,
  PeeklingOptions,
} from "./runtime.js";
