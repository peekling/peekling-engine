import type { SectionSnapshot } from "./types.js";
import { runtimeMessage } from "./runtime-diagnostics.js";

const RUNTIME_ROOTS =
  "[data-peekling-host],[data-peekling-content],[data-peekling-controls]";
const REFRESH_CADENCE_MS = 250;

type SectionState = [
  element: Element | undefined,
  previousRatio: number,
  ratio: number,
];

export interface SectionVisibilityFact {
  readonly [key: string]: string | number;
  readonly selector: string;
  readonly previousRatio: number;
  readonly ratio: number;
}

export class SectionTracker {
  readonly #document: Document;
  readonly #window: Window;
  readonly #states = new Map<string, SectionState>();
  readonly #elements = new Map<Element, Set<string>>();
  readonly #observer: IntersectionObserver | undefined;
  readonly #mutations: MutationObserver | undefined;
  readonly #wake: () => void;
  readonly #capture: ((fact: SectionVisibilityFact) => void) | undefined;
  #suspended = false;
  #destroyed = false;
  #dirty = false;
  #failure: Error | undefined;
  #refreshTimer = 0;

  constructor(
    document: Document,
    window: Window,
    selectors: readonly string[],
    thresholds: readonly number[],
    wake: () => void,
    capture?: (fact: SectionVisibilityFact) => void,
  ) {
    this.#document = document;
    this.#window = window;
    this.#wake = wake;
    this.#capture = capture;
    const initial = selectors.map(
      (selector) => [selector, this.#select(selector)] as const,
    );
    const BrowserIntersectionObserver = (window as Window & typeof globalThis)
      .IntersectionObserver;
    if (BrowserIntersectionObserver) {
      this.#observer = new BrowserIntersectionObserver(
        (entries) => {
          let changed = false;
          for (const entry of entries) {
            for (const selector of this.#elements.get(entry.target) ?? []) {
              const state = this.#states.get(selector);
              if (!state) continue;
              const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
              changed = this.#change(selector, state, ratio) || changed;
            }
          }
          if (changed) wake();
        },
        { threshold: [...thresholds] },
      );
    }
    const BrowserMutationObserver = (window as Window & typeof globalThis)
      .MutationObserver;
    if (BrowserMutationObserver) {
      this.#mutations = new BrowserMutationObserver((records) => {
        if (
          this.#suspended ||
          this.#destroyed ||
          this.#refreshTimer ||
          this.#dirty ||
          (records.length > 0 && records.every(runtimeOwnedMutation))
        ) {
          return;
        }
        let needsRefresh = false;
        for (const state of this.#states.values()) {
          if (!state[0]?.isConnected) {
            needsRefresh = true;
            break;
          }
        }
        if (!needsRefresh) return;
        this.#scheduleRefresh();
      });
      this.#mutations.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
    for (const [selector, element] of initial) {
      this.#states.set(selector, [undefined, 0, 0]);
      this.#observe(selector, element);
    }
  }

  snapshot(): Readonly<Record<string, SectionSnapshot>> {
    if (this.#failure) throw this.#failure;
    if (this.#dirty) {
      this.#dirty = false;
      this.#refreshGuarded();
      if (this.#failure) throw this.#failure;
    }
    const result: Record<string, SectionSnapshot> = Object.create(
      null,
    ) as Record<string, SectionSnapshot>;
    for (const [selector, state] of this.#states) {
      result[selector] = {
        ratio: state[2],
        previousRatio: state[1],
      };
    }
    return result;
  }

  setSuspended(value: boolean): void {
    if (this.#destroyed || value === this.#suspended) return;
    this.#suspended = value;
    if (value) {
      this.#cancelRefresh();
      this.#dirty = false;
      this.#observer?.disconnect();
      this.#mutations?.disconnect();
      return;
    }
    this.#mutations?.observe(this.#document.documentElement, {
      childList: true,
      subtree: true,
    });
    this.#dirty = false;
    if (!this.#refreshGuarded()) return;
    for (const element of this.#elements.keys()) {
      this.#observer?.observe(element);
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cancelRefresh();
    this.#dirty = false;
    this.#observer?.disconnect();
    this.#mutations?.disconnect();
    this.#elements.clear();
    this.#states.clear();
  }

  #observe(selector: string, element = this.#select(selector)): void {
    const state = this.#states.get(selector)!;
    if (!element) {
      this.#detach(selector, state);
      this.#change(selector, state, 0);
      return;
    }
    if (element === state[0] && element.isConnected) return;
    this.#detach(selector, state);
    state[0] = element;
    const selectors = this.#elements.get(element) ?? new Set<string>();
    if (!selectors.size) this.#observer?.observe(element);
    selectors.add(selector);
    this.#elements.set(element, selectors);
  }

  #select(selector: string): Element | null {
    try {
      return this.#document.querySelector(selector);
    } catch {
      throw new TypeError(
        runtimeMessage(
          "section.selector",
          `Invalid section selector: ${selector}`,
        ),
      );
    }
  }

  #detach(selector: string, state: SectionState): void {
    const previous = state[0];
    state[0] = undefined;
    if (!previous) return;
    const selectors = this.#elements.get(previous);
    selectors?.delete(selector);
    if (!selectors?.size) {
      this.#observer?.unobserve(previous);
      this.#elements.delete(previous);
    }
  }

  #change(selector: string, state: SectionState, ratio: number): boolean {
    const previousRatio = state[2];
    if (ratio === previousRatio) return false;
    state[1] = previousRatio;
    state[2] = ratio;
    this.#capture?.({ selector, previousRatio, ratio });
    return true;
  }

  #refresh(): void {
    for (const [selector, state] of this.#states) {
      if (!state[0]?.isConnected) this.#observe(selector);
    }
  }

  #scheduleRefresh(): void {
    if (this.#refreshTimer || this.#suspended || this.#destroyed) return;
    this.#refreshTimer = this.#window.setTimeout(() => {
      this.#refreshTimer = 0;
      if (this.#suspended || this.#destroyed || this.#failure || this.#dirty)
        return;
      this.#dirty = true;
      this.#wake();
    }, REFRESH_CADENCE_MS);
  }

  #cancelRefresh(): void {
    if (this.#refreshTimer) this.#window.clearTimeout(this.#refreshTimer);
    this.#refreshTimer = 0;
  }

  #refreshGuarded(): boolean {
    if (this.#failure) return false;
    try {
      this.#refresh();
      return true;
    } catch (cause) {
      this.#failure =
        cause instanceof Error
          ? cause
          : new Error(
              runtimeMessage(
                "section.refresh",
                "Section tracking failed while the host document changed",
              ),
            );
      this.#observer?.disconnect();
      this.#mutations?.disconnect();
      this.#wake();
      return false;
    }
  }
}

function runtimeOwnedMutation(record: MutationRecord): boolean {
  const target = record.target as Node & {
    closest?: (selector: string) => Element | null;
  };
  const element =
    typeof target.closest === "function" ? target : target.parentElement;
  try {
    return Boolean(element?.closest?.(RUNTIME_ROOTS));
  } catch {
    return false;
  }
}
