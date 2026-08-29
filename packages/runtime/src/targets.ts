import type { Point, TargetSnapshot } from "./types.js";

type TargetElement = Element & { getBoundingClientRect(): DOMRect };

/** Tracks host-approved geometry without moving, styling, or reparenting host DOM. */
export class TargetTracker {
  readonly #document: Document;
  readonly #window: Window;
  readonly #selectors: Readonly<Record<string, string>>;
  readonly #elements = new Map<string, TargetElement>();
  readonly #wake: () => void;
  readonly #resizeObserver: ResizeObserver | undefined;
  readonly #mutationObserver: MutationObserver | undefined;
  #snapshot: Readonly<Record<string, TargetSnapshot>> = Object.freeze({});
  #dirty = true;
  #destroyed = false;

  constructor(
    document: Document,
    window: Window,
    selectors: Readonly<Record<string, string>>,
    wake: () => void,
  ) {
    this.#document = document;
    this.#window = window;
    this.#selectors = selectors;
    this.#wake = wake;
    const browserWindow = window as Window & typeof globalThis;
    this.#resizeObserver = browserWindow.ResizeObserver
      ? new browserWindow.ResizeObserver(() => this.refresh())
      : undefined;
    this.#mutationObserver = browserWindow.MutationObserver
      ? new browserWindow.MutationObserver(() => this.refresh())
      : undefined;
    this.#mutationObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "id"],
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", this.#markDirty, { passive: true });
    window.addEventListener("scroll", this.#markDirty, {
      capture: true,
      passive: true,
    });
  }

  snapshot(force = false): Readonly<Record<string, TargetSnapshot>> {
    if (this.#destroyed) return Object.freeze({});
    if (force) this.#dirty = true;
    if (!this.#dirty) return this.#snapshot;
    const output: Record<string, TargetSnapshot> = Object.create(null);
    for (const [id, selector] of Object.entries(this.#selectors)) {
      let element: TargetElement | null | undefined = this.#elements.get(id);
      if (!element?.isConnected) {
        if (element) this.#resizeObserver?.unobserve(element);
        element = this.#document.querySelector(selector) as
          TargetElement | null | undefined;
        if (element) {
          this.#elements.set(id, element);
          this.#resizeObserver?.observe(element);
        } else {
          this.#elements.delete(id);
        }
      }
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height)
      ) {
        continue;
      }
      output[id] = Object.freeze({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
    }
    this.#snapshot = Object.freeze(output);
    this.#dirty = false;
    return this.#snapshot;
  }

  contains(id: string, point: Readonly<Point>, margin = 0): boolean {
    const target = this.snapshot(true)[id];
    return Boolean(
      target &&
      point.x >= target.left - margin &&
      point.x <= target.right + margin &&
      point.y >= target.top - margin &&
      point.y <= target.bottom + margin,
    );
  }

  refresh = (): void => {
    if (this.#destroyed) return;
    this.#dirty = true;
    this.#wake();
  };

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#resizeObserver?.disconnect();
    this.#mutationObserver?.disconnect();
    this.#window.removeEventListener("resize", this.#markDirty);
    this.#window.removeEventListener("scroll", this.#markDirty, true);
    this.#elements.clear();
  }

  #markDirty = (): void => this.refresh();
}
