import type { NormalizedPack, Point, StateDefinition } from "./types.js";
import { animationCycleMs } from "./locomotion.js";
import { runtimeMessage } from "./runtime-diagnostics.js";
import {
  connectRuntimeHost,
  ShadowStyleSheet,
  type RuntimeStyleAsset,
} from "./styles.js";

export interface CharacterRenderer {
  readonly ready: Promise<void>;
  swapAtlas(pack: NormalizedPack, atlasUrl: string): void | Promise<void>;
  setHidden(hidden: boolean): void;
  nextFrameIn(now: number): number | undefined;
  render(
    stateName: string,
    now: number,
    position: Point,
    devicePixelRatio?: number,
    lift?: number,
  ): void;
  destroy(): void;
}

export interface CharacterRendererOptions {
  document: Document;
  pack: NormalizedPack;
  atlasUrl: string;
  scale: number;
  styles: RuntimeStyleAsset;
}

export type CharacterRendererFactory = (
  options: Readonly<CharacterRendererOptions>,
) => CharacterRenderer;

export function frameAt(state: StateDefinition, elapsed: number): number {
  if (state.frames.length === 1) return state.frames[0]!;
  if (state.durations?.length === state.frames.length) {
    const total = animationCycleMs(state);
    const time = state.loop ? elapsed % total : Math.min(elapsed, total - 1);
    let cursor = 0;
    for (let index = 0; index < state.frames.length; index++) {
      cursor += state.durations[index]!;
      if (time < cursor) return state.frames[index]!;
    }
    return state.frames.at(-1)!;
  }
  const index = Math.floor((elapsed * (state.fps ?? 1)) / 1000);
  return state.frames[
    state.loop
      ? index % state.frames.length
      : Math.min(index, state.frames.length - 1)
  ]!;
}

export function snapToDevicePixel(value: number, devicePixelRatio = 1): number {
  const safeDpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.round(value * safeDpr) / safeDpr;
}

export class AtlasRenderer implements CharacterRenderer {
  readonly host: HTMLElement;
  readonly ready: Promise<void>;
  readonly #document: Document;
  readonly #root: ShadowRoot;
  readonly #sprite: HTMLElement;
  readonly #styles: ShadowStyleSheet;
  #spriteRule: CSSStyleDeclaration | undefined;
  #pack: NormalizedPack;
  readonly #scale: number;
  #width = 0;
  #height = 0;
  #state = "";
  #stateStartedAt = 0;
  #frame = -1;
  #destroyed = false;

  constructor(
    document: Document,
    pack: NormalizedPack,
    atlasUrl: string,
    scale: number,
    styles: RuntimeStyleAsset,
  ) {
    this.#document = document;
    this.#pack = pack;
    this.#scale = scale;
    this.host = document.createElement("div");
    this.host.setAttribute("aria-hidden", "true");
    this.host.setAttribute("data-peekling-host", "");
    this.#root = this.host.attachShadow({ mode: "closed" });
    this.#styles = new ShadowStyleSheet(document, this.#root, styles);
    this.#sprite = document.createElement("i");
    this.#sprite.className = "sprite";
    this.#root.append(this.#sprite);
    this.ready = this.#styles.ready.then(() => {
      if (this.#destroyed) return;
      this.#spriteRule = this.#styles.addRule(".sprite");
      this.#applyAtlas(pack, atlasUrl);
    });
    void this.ready.catch(() => {});
    this.#repair();
  }

  swapAtlas(pack: NormalizedPack, atlasUrl: string): void {
    if (this.#destroyed) return;
    this.#applyAtlas(pack, atlasUrl);
  }

  #applyAtlas(pack: NormalizedPack, atlasUrl: string): void {
    this.#pack = pack;
    const rule = this.#spriteRule;
    if (!rule)
      throw new Error(
        runtimeMessage("renderer.styles", "Peekling stylesheet is not ready"),
      );
    this.#width = pack.atlas.logicalWidth ?? pack.atlas.cellWidth;
    this.#height = pack.atlas.logicalHeight ?? pack.atlas.cellHeight;
    rule.width = `${this.#width}px`;
    rule.height = `${this.#height}px`;
    rule.backgroundSize = `${pack.atlas.columns * this.#width}px ${pack.atlas.rows * this.#height}px`;
    rule.backgroundImage = `url(${JSON.stringify(atlasUrl)})`;
    rule.imageRendering =
      (pack.atlas.density ?? 1) === 1 ? "pixelated" : "auto";
    this.#frame = -1;
  }

  setHidden(hidden: boolean): void {
    if (this.#destroyed) return;
    this.host.toggleAttribute("hidden", hidden);
  }

  nextFrameIn(now: number): number | undefined {
    if (this.#destroyed) return undefined;
    const state = this.#pack.states[this.#state];
    if (!state || state.frames.length < 2) return undefined;
    const elapsed = Math.max(0, now - this.#stateStartedAt);
    if (state.durations?.length === state.frames.length) {
      const total = animationCycleMs(state);
      if (!state.loop && elapsed >= total - state.durations.at(-1)!) {
        return undefined;
      }
      const active = state.loop ? elapsed % total : elapsed;
      let boundary = 0;
      for (const duration of state.durations) {
        boundary += duration;
        if (boundary > active) return boundary - active;
      }
      return state.loop ? state.durations[0] : undefined;
    }
    const interval = 1000 / (state.fps ?? 1);
    if (!state.loop && elapsed >= interval * (state.frames.length - 1)) {
      return undefined;
    }
    return interval - (elapsed % interval || 0);
  }

  render(
    stateName: string,
    now: number,
    position: Point,
    devicePixelRatio = 1,
    lift = 0,
  ): void {
    if (this.#destroyed) return;
    this.#repair();
    if (this.#destroyed) return;
    const state = this.#pack.states[stateName];
    if (!state)
      throw new Error(
        runtimeMessage(
          "renderer.state",
          `Renderer received unknown state ${stateName}`,
        ),
      );
    if (stateName !== this.#state) {
      this.#state = stateName;
      this.#stateStartedAt = now;
      this.#frame = -1;
      this.host.setAttribute("data-peekling-state", stateName);
    }
    const frame = frameAt(state, now - this.#stateStartedAt);
    if (frame !== this.#frame) {
      const column = frame % this.#pack.atlas.columns;
      const row = Math.floor(frame / this.#pack.atlas.columns);
      if (!this.#spriteRule)
        throw new Error(
          runtimeMessage("renderer.styles", "Peekling stylesheet is not ready"),
        );
      this.#spriteRule.backgroundPosition = `${-column * this.#width}px ${-row * this.#height}px`;
      this.#frame = frame;
      this.host.setAttribute("data-peekling-frame", String(frame));
    }
    const width = this.#width * this.#scale;
    const height = this.#height * this.#scale;
    const x = snapToDevicePixel(position.x - width / 2, devicePixelRatio);
    const y = snapToDevicePixel(
      position.y - height / 2 - lift,
      devicePixelRatio,
    );
    const xValue = String(x);
    const yValue = String(y);
    if (this.host.getAttribute("data-peekling-x") !== xValue)
      this.host.setAttribute("data-peekling-x", xValue);
    if (this.host.getAttribute("data-peekling-y") !== yValue)
      this.host.setAttribute("data-peekling-y", yValue);
    if (!this.#spriteRule)
      throw new Error(
        runtimeMessage("renderer.styles", "Peekling stylesheet is not ready"),
      );
    const transform = `translate3d(${x}px,${y}px,0) scale(${this.#scale})`;
    if (this.#spriteRule.transform !== transform)
      this.#spriteRule.transform = transform;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#styles.destroy();
    this.host.remove();
  }

  #repair(): void {
    if (this.#destroyed) return;
    connectRuntimeHost(this.host, this.#document, "data-peekling-host");
    if (
      this.#root.host !== this.host ||
      this.#sprite.getRootNode() !== this.#root
    )
      throw new Error(
        runtimeMessage(
          "renderer.root",
          "Peekling character root structure was changed",
        ),
      );
    if (this.host.getAttribute("aria-hidden") !== "true")
      this.host.setAttribute("aria-hidden", "true");
  }
}

export const createAtlasRenderer: CharacterRendererFactory = (options) =>
  new AtlasRenderer(
    options.document,
    options.pack,
    options.atlasUrl,
    options.scale,
    options.styles,
  );
