import type { Point } from "./types.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

interface PathGeometry {
  readonly element: SVGPathElement;
  readonly length: number;
}

/** Bounded browser-native SVG path geometry. Path data is never inserted as HTML. */
export class SvgPathSampler {
  readonly #document: Document;
  readonly #cache = new Map<string, PathGeometry>();

  constructor(document: Document) {
    this.#document = document;
  }

  validate(path: string): boolean {
    return this.#geometry(path) !== undefined;
  }

  sample(path: string, progress: number): Point | undefined {
    const geometry = this.#geometry(path);
    if (!geometry) return;
    const bounded = Math.max(0, Math.min(1, progress));
    try {
      const point = geometry.element.getPointAtLength(
        geometry.length * bounded,
      );
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      return { x: point.x, y: point.y };
    } catch {
      return;
    }
  }

  #geometry(path: string): PathGeometry | undefined {
    const cached = this.#cache.get(path);
    if (cached) return cached;
    if (this.#cache.size >= 16) return;
    const element = this.#document.createElementNS(
      SVG_NAMESPACE,
      "path",
    ) as SVGPathElement;
    element.setAttribute("d", path);
    try {
      const length = element.getTotalLength();
      if (!Number.isFinite(length) || length <= 0) return;
      const geometry = Object.freeze({ element, length });
      this.#cache.set(path, geometry);
      return geometry;
    } catch {
      return;
    }
  }
}
