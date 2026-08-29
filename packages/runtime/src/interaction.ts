import { runtimeMessage } from "./runtime-diagnostics.js";
import {
  connectRuntimeHost,
  ShadowStyleSheet,
  type RuntimeStyleAsset,
} from "./styles.js";
import type { Point } from "./types.js";

export interface CharacterIndicator {
  kind?: "dot" | "count";
  count?: number;
  label: string;
  color?: "transparent" | `#${string}`;
  visible?: boolean;
}

export interface CharacterInteractionControllerOptions {
  document: Document;
  styles: RuntimeStyleAsset;
  label: string;
  draggable: boolean;
  /** Present only when the character button controls an owned content surface. */
  expanded?: boolean;
  indicator?: CharacterIndicator;
  onPress(): void;
  onDragStart(): void;
  onDragMove(position: Readonly<Point>, velocity: Readonly<Point>): void;
  onDragEnd(
    velocity: Readonly<Point>,
    moved: boolean,
    pointer: Readonly<Point>,
  ): void;
}

/** Accessible owned hit target layered above either character renderer. */
export class CharacterInteractionController {
  readonly ready: Promise<void>;
  readonly #document: Document;
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #button: HTMLButtonElement;
  readonly #badge: HTMLSpanElement;
  readonly #styles: ShadowStyleSheet;
  readonly #options: CharacterInteractionControllerOptions;
  #buttonRule: CSSStyleDeclaration | undefined;
  #badgeRule: CSSStyleDeclaration | undefined;
  #indicator: CharacterIndicator | undefined;
  #label: string;
  #position: Point = { x: 0, y: 0 };
  #pointerId: number | undefined;
  #startPointer: Point = { x: 0, y: 0 };
  #lastPointer: Point = { x: 0, y: 0 };
  #startPosition: Point = { x: 0, y: 0 };
  #velocity: Point = { x: 0, y: 0 };
  #lastTime = 0;
  #moved = false;
  #suppressClick = false;
  #destroyed = false;

  constructor(options: CharacterInteractionControllerOptions) {
    this.#options = options;
    this.#document = options.document;
    this.#label = options.label;
    this.#host = options.document.createElement("div");
    this.#host.setAttribute("data-peekling-interaction", "");
    this.#root = this.#host.attachShadow({ mode: "closed" });
    this.#styles = new ShadowStyleSheet(
      options.document,
      this.#root,
      options.styles,
    );
    this.#button = options.document.createElement("button");
    this.#button.type = "button";
    this.#button.className = "peekling-character-hit";
    this.#button.setAttribute("aria-label", options.label);
    if (options.expanded !== undefined) {
      this.#button.setAttribute("aria-expanded", String(options.expanded));
    }
    this.#button.toggleAttribute("data-peekling-draggable", options.draggable);
    this.#badge = options.document.createElement("span");
    this.#badge.className = "peekling-character-indicator";
    this.#badge.setAttribute("aria-hidden", "true");
    this.#button.append(this.#badge);
    this.#root.append(this.#button);
    this.ready = this.#styles.ready.then(() => {
      if (this.#destroyed) return;
      this.#buttonRule = this.#styles.addRule(".peekling-character-hit");
      this.#badgeRule = this.#styles.addRule(".peekling-character-indicator");
      this.#syncIndicatorColor();
    });
    void this.ready.catch(() => {});
    this.#button.addEventListener("click", this.#click);
    if (options.draggable) {
      this.#button.addEventListener("pointerdown", this.#pointerDown);
      this.#button.addEventListener("pointermove", this.#pointerMove);
      this.#button.addEventListener("pointerup", this.#pointerUp);
      this.#button.addEventListener("pointercancel", this.#pointerCancel);
    }
    this.updateIndicator(options.indicator);
    this.#repair();
  }

  render(
    position: Readonly<Point>,
    character: Readonly<{ width: number; height: number }>,
    lift = 0,
  ): void {
    if (this.#destroyed) return;
    this.#repair();
    this.#position = { x: position.x, y: position.y - lift };
    const rule = this.#buttonRule;
    if (!rule) return;
    const left = position.x - character.width / 2;
    const top = position.y - character.height / 2 - lift;
    rule.width = `${character.width}px`;
    rule.height = `${character.height}px`;
    rule.transform = `translate3d(${left}px,${top}px,0)`;
  }

  setHidden(hidden: boolean): void {
    if (!this.#destroyed) this.#host.toggleAttribute("hidden", hidden);
  }

  setExpanded(expanded: boolean): void {
    if (!this.#destroyed && this.#button.hasAttribute("aria-expanded")) {
      this.#button.setAttribute("aria-expanded", String(expanded));
    }
  }

  updateIndicator(indicator?: CharacterIndicator | null): void {
    if (this.#destroyed) return;
    this.#indicator = indicator ?? undefined;
    this.#syncIndicatorColor();
    const visible = Boolean(
      indicator &&
      indicator.visible !== false &&
      (indicator.kind !== "count" || (indicator.count ?? 0) > 0),
    );
    this.#badge.hidden = !visible;
    if (!visible || !indicator) {
      this.#badge.textContent = "";
      this.#button.setAttribute("aria-label", this.#label);
      return;
    }
    const kind = indicator.kind ?? "dot";
    this.#badge.dataset.kind = kind;
    this.#badge.textContent =
      kind === "count" ? String(Math.min(99, indicator.count ?? 0)) : "";
    this.#button.setAttribute(
      "aria-label",
      `${this.#label}. ${indicator.label}`,
    );
  }

  #syncIndicatorColor(): void {
    if (this.#badgeRule) {
      this.#badgeRule.backgroundColor = this.#indicator?.color ?? "";
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#styles.destroy();
    this.#host.remove();
  }

  #click = (): void => {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      return;
    }
    this.#options.onPress();
  };

  #pointerDown = (event: PointerEvent): void => {
    if (
      this.#destroyed ||
      this.#pointerId !== undefined ||
      (!event.isPrimary && event.pointerType !== "mouse") ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    this.#pointerId = event.pointerId;
    this.#startPointer = { x: event.clientX, y: event.clientY };
    this.#lastPointer = { ...this.#startPointer };
    this.#startPosition = { ...this.#position };
    this.#velocity = { x: 0, y: 0 };
    this.#lastTime = event.timeStamp;
    this.#moved = false;
    try {
      this.#button.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an optimization. Owned pointer listeners still work.
    }
    this.#options.onDragStart();
  };

  #pointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    const dx = event.clientX - this.#startPointer.x;
    const dy = event.clientY - this.#startPointer.y;
    if (!this.#moved && Math.hypot(dx, dy) >= 4) this.#moved = true;
    const elapsed = Math.max(
      8,
      Math.min(100, event.timeStamp - this.#lastTime),
    );
    const sampleX = ((event.clientX - this.#lastPointer.x) * 1_000) / elapsed;
    const sampleY = ((event.clientY - this.#lastPointer.y) * 1_000) / elapsed;
    this.#velocity = {
      x: sampleX * 0.65 + this.#velocity.x * 0.35,
      y: sampleY * 0.65 + this.#velocity.y * 0.35,
    };
    this.#lastPointer = { x: event.clientX, y: event.clientY };
    this.#lastTime = event.timeStamp;
    this.#options.onDragMove(
      {
        x: this.#startPosition.x + dx,
        y: this.#startPosition.y + dy,
      },
      this.#velocity,
    );
  };

  #pointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.#finishPointer(event, this.#moved, this.#velocity);
  };

  #pointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.#finishPointer(event, this.#moved, { x: 0, y: 0 }, this.#lastPointer);
  };

  #finishPointer(
    event: PointerEvent,
    moved: boolean,
    velocity: Readonly<Point>,
    pointer: Readonly<Point> = { x: event.clientX, y: event.clientY },
  ): void {
    const pointerId = this.#pointerId;
    this.#pointerId = undefined;
    if (pointerId !== undefined) {
      try {
        this.#button.releasePointerCapture(pointerId);
      } catch {
        // Capture may already have been released by the browser.
      }
    }
    this.#suppressClick = moved;
    this.#options.onDragEnd(velocity, moved, pointer);
  }

  #repair(): void {
    if (this.#destroyed) return;
    connectRuntimeHost(this.#host, this.#document, "data-peekling-interaction");
    if (
      this.#root.host !== this.#host ||
      this.#button.getRootNode() !== this.#root
    ) {
      throw new Error(
        runtimeMessage(
          "interaction.root",
          "Peekling interaction root structure was changed",
        ),
      );
    }
  }
}
