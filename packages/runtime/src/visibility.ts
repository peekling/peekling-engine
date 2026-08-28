import {
  connectRuntimeHost,
  ShadowStyleSheet,
  type RuntimeStyleAsset,
} from "./styles.js";
import { runtimeMessage } from "./runtime-diagnostics.js";

export type PeeklingHideDuration =
  "10-minutes" | "1-hour" | "until-tomorrow" | "session" | "forever";

const PREFERENCE_KEY = "peekling:site-preference";
const SESSION_KEY = "peekling:hidden-session";
const CORNER_SIZE = 64;
const HOLD_MS = 1_000;
const HIDE_OPTIONS = [
  ["10 minutes", "10-minutes"],
  ["1 hour", "1-hour"],
  ["Until tomorrow", "until-tomorrow"],
  ["Until I return", "session"],
  ["Forever on this site", "forever"],
] as const;

interface StoredPreference {
  visibility: "hidden";
  until: number | null;
}

type VisibilityState = readonly [hidden: boolean, until?: number];

type VisibilityListener = (hidden: boolean | null) => void;
type ListenerBinding = [EventTarget, string, EventListener];

const controllers = new WeakMap<Document, SiteVisibilityController>();

function readVisibility(window: Window, now = Date.now()): VisibilityState {
  try {
    if (window.sessionStorage.getItem(SESSION_KEY) === "1") return [true];
    const value = JSON.parse(
      window.localStorage.getItem(PREFERENCE_KEY) ?? "null",
    ) as StoredPreference | null;
    if (value?.visibility !== "hidden") return [false];
    if (value.until === null) return [true];
    if (Number.isFinite(value.until) && value.until > now)
      return [true, value.until];
    window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // Storage is optional. Fail open so a broken preference never traps a host.
  }
  return [false];
}

function readHidden(window: Window, now = Date.now()): boolean {
  return readVisibility(window, now)[0];
}

function writeHidden(
  window: Window,
  duration: PeeklingHideDuration,
): number | undefined {
  const option = HIDE_OPTIONS.findIndex((item) => item[1] === duration);
  if (option < 0)
    throw new TypeError(
      runtimeMessage("visibility.duration", "Invalid Peekling hide duration"),
    );
  const now = new Date();
  const until =
    option > 2
      ? undefined
      : option < 2
        ? now.getTime() + (option ? 60 : 10) * 60_000
        : new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + 1,
          ).getTime();
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
    if (option === 3) {
      window.localStorage.removeItem(PREFERENCE_KEY);
      window.sessionStorage.setItem(SESSION_KEY, "1");
      return until;
    }
    window.localStorage.setItem(
      PREFERENCE_KEY,
      JSON.stringify({
        visibility: "hidden",
        until: option === 4 ? null : until,
      }),
    );
  } catch {
    // The current page still hides even when storage is unavailable.
  }
  return until;
}

function clearHidden(window: Window): void {
  try {
    window.localStorage.removeItem(PREFERENCE_KEY);
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // The current page still restores even when storage is unavailable.
  }
}

class SiteVisibilityController {
  readonly ready: Promise<void>;
  readonly #document: Document;
  readonly #window: Window;
  readonly #listeners = new Set<VisibilityListener>();
  readonly #persistentRemovers: ListenerBinding[] = [];
  readonly #interactionRemovers: ListenerBinding[] = [];
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #panel: HTMLElement;
  readonly #keyboardTrigger: HTMLButtonElement;
  readonly #styles: ShadowStyleSheet;
  readonly #styleKey: string;
  readonly #styleIntegrity: string | undefined;
  #hidden: boolean;
  #holdTimer = 0;
  #expiryTimer = 0;
  #open = false;
  #destroyed = false;

  constructor(document: Document, window: Window, styles: RuntimeStyleAsset) {
    this.#document = document;
    this.#window = window;
    const initial = readVisibility(window);
    this.#hidden = initial[0];
    this.#host = document.createElement("div");
    this.#host.dataset.peeklingControls = "";
    this.#root = this.#host.attachShadow({ mode: "closed" });
    this.#styleKey = `${styles.url}\n${styles.integrity ?? ""}`;
    this.#styleIntegrity = styles.integrity;
    this.#styles = new ShadowStyleSheet(document, this.#root, styles);
    this.ready = this.#styles.ready;
    void this.ready.catch(() => {});
    this.#keyboardTrigger = document.createElement("button");
    this.#keyboardTrigger.className = "peekling-visibility-trigger";
    this.#keyboardTrigger.type = "button";
    this.#keyboardTrigger.setAttribute(
      "aria-label",
      "Open Peekling visibility controls",
    );
    this.#keyboardTrigger.textContent = "🐾";
    this.#panel = document.createElement("section");
    this.#panel.className = "peekling-visibility-panel";
    this.#panel.hidden = true;
    this.#panel.setAttribute("role", "dialog");
    this.#panel.setAttribute("aria-label", "Let Peekling rest");
    const heading = document.createElement("h2");
    heading.textContent = "Let Peekling rest?";
    this.#panel.append(heading);
    for (const [label, duration] of HIDE_OPTIONS) {
      const button = document.createElement("button");
      button.className = "peekling-visibility-option";
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => this.hide(duration));
      this.#panel.append(button);
    }
    this.#root.append(this.#keyboardTrigger, this.#panel);
    this.#repair();
    this.#listen(
      window,
      "storage",
      () => this.refresh(),
      this.#persistentRemovers,
    );
    this.#applyHidden(initial[0], false);
    this.#scheduleExpiry(initial[1]);
  }

  #attachInteractions(): void {
    if (this.#interactionRemovers.length) return;
    this.#listen(
      this.#document,
      "pointermove",
      (event) => {
        const pointer = event as PointerEvent;
        if (pointer.pointerType === "touch" || pointer.pointerType === "pen")
          return;
        this.#updateCorner(pointer.clientX, pointer.clientY);
      },
      this.#interactionRemovers,
    );
    this.#listen(
      this.#document,
      "pointerdown",
      (event) => {
        const pointer = event as PointerEvent;
        if (this.#open && !this.#host.contains(event.target as Node))
          this.close();
        if (pointer.pointerType === "touch" || pointer.pointerType === "pen")
          this.#updateCorner(pointer.clientX, pointer.clientY);
      },
      this.#interactionRemovers,
    );
    for (const type of ["pointerup", "pointercancel", "pointerout"])
      this.#listen(
        this.#document,
        type,
        (event) => {
          if (
            type !== "pointerout" ||
            (event as PointerEvent).relatedTarget === null
          )
            this.#cancelHold();
        },
        this.#interactionRemovers,
      );
    this.#listen(
      this.#document,
      "keydown",
      (event) => {
        if ((event as KeyboardEvent).key === "Escape") this.close(true);
      },
      this.#interactionRemovers,
    );
    const open = () => this.open(true);
    this.#listen(
      this.#keyboardTrigger,
      "click",
      open,
      this.#interactionRemovers,
    );
  }

  #detachInteractions(): void {
    this.#cancelHold();
    this.#remove(this.#interactionRemovers);
  }

  register(listener: VisibilityListener): () => void {
    this.#listeners.add(listener);
    listener(this.#hidden);
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) this.destroy();
    };
  }

  assertStyles(styles: RuntimeStyleAsset): void {
    if (`${styles.url}\n${styles.integrity ?? ""}` === this.#styleKey) return;
    if (styles.integrity && styles.integrity === this.#styleIntegrity) return;
    throw new TypeError(
      runtimeMessage(
        "visibility.styles-conflict",
        "Shared visibility stylesheet conflicts with the existing document controller",
      ),
    );
  }

  isHidden(): boolean {
    return this.#hidden;
  }

  hide(duration: PeeklingHideDuration): void {
    const until = writeHidden(this.#window, duration);
    this.#setHidden(true);
    this.#scheduleExpiry(until);
    this.close();
  }

  show(): void {
    clearHidden(this.#window);
    this.refresh();
  }

  refresh(): void {
    try {
      this.#repair();
    } catch {
      const listeners = [...this.#listeners];
      this.destroy();
      for (const listener of listeners) listener(null);
      return;
    }
    const state = readVisibility(this.#window);
    this.#setHidden(state[0]);
    this.#scheduleExpiry(state[1]);
  }

  open(focus = false): void {
    if (this.#hidden) return;
    this.#cancelHold();
    this.#open = true;
    this.#host.setAttribute("data-open", "");
    this.#panel.hidden = false;
    if (focus)
      (
        this.#panel.querySelector("button") as HTMLButtonElement | null
      )?.focus();
  }

  close(returnFocus = false): void {
    if (!this.#open) return;
    this.#open = false;
    this.#host.removeAttribute("data-open");
    this.#panel.hidden = true;
    if (returnFocus) this.#keyboardTrigger.focus();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#detachInteractions();
    this.#scheduleExpiry();
    this.#remove(this.#persistentRemovers);
    this.#styles.destroy();
    this.#host.remove();
    this.#listeners.clear();
    controllers.delete(this.#document);
  }

  #updateCorner(x: number, y: number): void {
    if (
      this.#hidden ||
      this.#open ||
      x < this.#window.innerWidth - CORNER_SIZE ||
      y < this.#window.innerHeight - CORNER_SIZE
    ) {
      this.#cancelHold();
      return;
    }
    if (!this.#holdTimer)
      this.#holdTimer = this.#window.setTimeout(() => this.open(), HOLD_MS);
  }

  #cancelHold(): void {
    if (this.#holdTimer) this.#window.clearTimeout(this.#holdTimer);
    this.#holdTimer = 0;
  }

  #scheduleExpiry(until?: number): void {
    if (this.#expiryTimer) this.#window.clearTimeout(this.#expiryTimer);
    this.#expiryTimer = 0;
    if (until === undefined || this.#destroyed) return;
    const delay = Math.max(0, Math.min(until - Date.now(), 2_147_000_000));
    this.#expiryTimer = this.#window.setTimeout(() => {
      this.#expiryTimer = 0;
      this.refresh();
    }, delay);
  }

  #setHidden(hidden: boolean): void {
    if (hidden === this.#hidden) return;
    this.#applyHidden(hidden, true);
  }

  #applyHidden(hidden: boolean, notify: boolean): void {
    this.#hidden = hidden;
    this.#host.toggleAttribute("data-hidden", hidden);
    this.#keyboardTrigger.hidden = hidden;
    if (hidden) this.#detachInteractions();
    else this.#attachInteractions();
    if (notify) {
      for (const listener of this.#listeners) listener(hidden);
    }
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    removers: ListenerBinding[],
  ): void {
    target.addEventListener(type, listener, { passive: true });
    removers.push([target, type, listener]);
  }

  #remove(bindings: ListenerBinding[]): void {
    for (const [target, type, listener] of bindings.splice(0))
      target.removeEventListener(type, listener);
  }

  #repair(): void {
    connectRuntimeHost(this.#host, this.#document, "data-peekling-controls");
    if (
      this.#root.host !== this.#host ||
      this.#keyboardTrigger.getRootNode() !== this.#root ||
      this.#panel.getRootNode() !== this.#root
    )
      throw new Error(
        runtimeMessage(
          "visibility.root",
          "Peekling visibility root structure was changed",
        ),
      );
  }
}

export function registerSiteVisibility(
  document: Document,
  window: Window,
  listener: VisibilityListener,
  styles: RuntimeStyleAsset,
): { unregister(): void; ready: Promise<void> } {
  let controller = controllers.get(document);
  if (!controller) {
    controller = new SiteVisibilityController(document, window, styles);
    controllers.set(document, controller);
  } else controller.assertStyles(styles);
  return { unregister: controller.register(listener), ready: controller.ready };
}

export function hidePeekling(
  duration: PeeklingHideDuration,
  document: Document = globalThis.document,
  window: Window = globalThis.window,
): void {
  if (!document || !window)
    throw new Error(
      runtimeMessage("browser.context", "Browser document/window required"),
    );
  const controller = controllers.get(document);
  if (controller) controller.hide(duration);
  else writeHidden(window, duration);
}

export function showPeekling(
  document: Document = globalThis.document,
  window: Window = globalThis.window,
): void {
  if (!document || !window)
    throw new Error(
      runtimeMessage("browser.context", "Browser document/window required"),
    );
  const controller = controllers.get(document);
  if (controller) controller.show();
  else clearHidden(window);
}

export function isPeeklingHidden(window: Window = globalThis.window): boolean {
  if (!window)
    throw new Error(
      runtimeMessage("browser.window", "Browser window required"),
    );
  return controllers.get(window.document)?.isHidden() ?? readHidden(window);
}
