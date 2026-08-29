import { animationCycleMs } from "./locomotion.js";
import {
  frameAt,
  snapToDevicePixel,
  type CharacterRenderer,
  type CharacterRendererFactory,
} from "./renderer.js";
import { runtimeMessage } from "./runtime-diagnostics.js";
import {
  connectRuntimeHost,
  ShadowStyleSheet,
  type RuntimeStyleAsset,
} from "./styles.js";
import type { NormalizedPack, Point } from "./types.js";

/** Optional Canvas 2D presentation for the same runtime and Plan evaluator. */
export class CanvasRenderer implements CharacterRenderer {
  readonly host: HTMLElement;
  readonly ready: Promise<void>;
  readonly #document: Document;
  readonly #root: ShadowRoot;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #styles: ShadowStyleSheet;
  #canvasRule: CSSStyleDeclaration | undefined;
  #pack: NormalizedPack;
  #image: HTMLImageElement;
  readonly #scale: number;
  #logicalWidth = 0;
  #logicalHeight = 0;
  #state = "";
  #stateStartedAt = 0;
  #frame = -1;
  #destroyed = false;
  #loadGeneration = 0;

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
    this.host.setAttribute("data-peekling-renderer", "canvas");
    this.#root = this.host.attachShadow({ mode: "closed" });
    this.#styles = new ShadowStyleSheet(document, this.#root, styles);
    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "sprite";
    const context = this.#canvas.getContext("2d", { alpha: true });
    if (!context) {
      throw new Error(
        runtimeMessage("renderer.canvas", "Canvas 2D is unavailable"),
      );
    }
    this.#context = context;
    this.#image = document.createElement("img");
    this.#root.append(this.#canvas);
    this.ready = Promise.all([
      this.#styles.ready.then(() => {
        if (this.#destroyed) return;
        this.#canvasRule = this.#styles.addRule(".sprite");
      }),
      this.#loadAtlas(pack, atlasUrl),
    ]).then(() => {
      if (this.#destroyed) return;
      this.#applyGeometry(pack);
    });
    void this.ready.catch(() => {});
    this.#repair();
  }

  async swapAtlas(pack: NormalizedPack, atlasUrl: string): Promise<void> {
    if (this.#destroyed) return;
    await this.#loadAtlas(pack, atlasUrl);
    if (this.#destroyed || this.#pack !== pack) return;
    this.#applyGeometry(pack);
    this.#frame = -1;
  }

  setHidden(hidden: boolean): void {
    if (!this.#destroyed) this.host.toggleAttribute("hidden", hidden);
  }

  nextFrameIn(now: number): number | undefined {
    if (this.#destroyed) return;
    const state = this.#pack.states[this.#state];
    if (!state || state.frames.length < 2) return;
    const elapsed = Math.max(0, now - this.#stateStartedAt);
    if (state.durations?.length === state.frames.length) {
      const total = animationCycleMs(state);
      if (!state.loop && elapsed >= total - state.durations.at(-1)!) return;
      const active = state.loop ? elapsed % total : elapsed;
      let boundary = 0;
      for (const duration of state.durations) {
        boundary += duration;
        if (boundary > active) return boundary - active;
      }
      return state.loop ? state.durations[0] : undefined;
    }
    const interval = 1000 / (state.fps ?? 1);
    if (!state.loop && elapsed >= interval * (state.frames.length - 1)) return;
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
    const state = this.#pack.states[stateName];
    if (!state) {
      throw new Error(
        runtimeMessage(
          "renderer.state",
          `Renderer received unknown state ${stateName}`,
        ),
      );
    }
    if (stateName !== this.#state) {
      this.#state = stateName;
      this.#stateStartedAt = now;
      this.#frame = -1;
      this.host.setAttribute("data-peekling-state", stateName);
    }
    const frame = frameAt(state, now - this.#stateStartedAt);
    if (frame !== this.#frame && this.#image.complete) {
      const column = frame % this.#pack.atlas.columns;
      const row = Math.floor(frame / this.#pack.atlas.columns);
      const sourceWidth = this.#pack.atlas.cellWidth;
      const sourceHeight = this.#pack.atlas.cellHeight;
      this.#context.clearRect(0, 0, sourceWidth, sourceHeight);
      this.#context.drawImage(
        this.#image,
        column * sourceWidth,
        row * sourceHeight,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight,
      );
      this.#frame = frame;
      this.host.setAttribute("data-peekling-frame", String(frame));
    }
    const width = this.#logicalWidth * this.#scale;
    const height = this.#logicalHeight * this.#scale;
    const x = snapToDevicePixel(position.x - width / 2, devicePixelRatio);
    const y = snapToDevicePixel(
      position.y - height / 2 - lift,
      devicePixelRatio,
    );
    const rule = this.#canvasRule;
    if (!rule) {
      throw new Error(
        runtimeMessage("renderer.styles", "Peekling stylesheet is not ready"),
      );
    }
    const transform = `translate3d(${x}px,${y}px,0) scale(${this.#scale})`;
    if (rule.transform !== transform) rule.transform = transform;
    const xValue = String(x);
    const yValue = String(y);
    if (this.host.getAttribute("data-peekling-x") !== xValue) {
      this.host.setAttribute("data-peekling-x", xValue);
    }
    if (this.host.getAttribute("data-peekling-y") !== yValue) {
      this.host.setAttribute("data-peekling-y", yValue);
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#loadGeneration += 1;
    this.#image.src = "";
    this.#styles.destroy();
    this.host.remove();
  }

  async #loadAtlas(pack: NormalizedPack, atlasUrl: string): Promise<void> {
    const generation = ++this.#loadGeneration;
    const image = this.#document.createElement("img");
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener(
        "error",
        () =>
          reject(
            new Error(
              runtimeMessage("renderer.canvas-atlas", "Canvas atlas failed"),
            ),
          ),
        { once: true },
      );
      image.src = atlasUrl;
    });
    if (this.#destroyed || generation !== this.#loadGeneration) return;
    this.#pack = pack;
    this.#image = image;
  }

  #applyGeometry(pack: NormalizedPack): void {
    const rule = this.#canvasRule;
    if (!rule) {
      throw new Error(
        runtimeMessage("renderer.styles", "Peekling stylesheet is not ready"),
      );
    }
    this.#logicalWidth = pack.atlas.logicalWidth ?? pack.atlas.cellWidth;
    this.#logicalHeight = pack.atlas.logicalHeight ?? pack.atlas.cellHeight;
    this.#canvas.width = pack.atlas.cellWidth;
    this.#canvas.height = pack.atlas.cellHeight;
    rule.width = `${this.#logicalWidth}px`;
    rule.height = `${this.#logicalHeight}px`;
    rule.imageRendering =
      (pack.atlas.density ?? 1) === 1 ? "pixelated" : "auto";
  }

  #repair(): void {
    if (this.#destroyed) return;
    connectRuntimeHost(this.host, this.#document, "data-peekling-host");
    if (
      this.#root.host !== this.host ||
      this.#canvas.getRootNode() !== this.#root
    ) {
      throw new Error(
        runtimeMessage(
          "renderer.root",
          "Peekling character root structure was changed",
        ),
      );
    }
    if (this.host.getAttribute("aria-hidden") !== "true") {
      this.host.setAttribute("aria-hidden", "true");
    }
  }
}

export const createCanvasRenderer: CharacterRendererFactory = (options) =>
  new CanvasRenderer(
    options.document,
    options.pack,
    options.atlasUrl,
    options.scale,
    options.styles,
  );
