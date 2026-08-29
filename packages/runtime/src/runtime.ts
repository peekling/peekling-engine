import { ContentRenderer, type ContentSelection } from "./content.js";
import { InputCollector } from "./input.js";
import {
  CharacterInteractionController,
  type CharacterIndicator,
} from "./interaction.js";
import { browserCompletionEvent, validateEventPayload } from "./events.js";
import { directionTo } from "./direction.js";
import { DiagnosticChannel } from "./diagnostics.js";
import { EVENT_NAME_PATTERN, isSurfaceColor } from "./contracts.js";
import { DEFAULT_MAX_DENSITY, DEFAULT_POSITION } from "./defaults.js";
import {
  animationCycleMs,
  locomotionAdvance,
  locomotionSample,
} from "./locomotion.js";
import {
  loadNativePack,
  requiredAtlasDensity,
  type LoadedPack,
} from "./loader.js";
import { resolveCapabilityName } from "./normalized.js";
import {
  PlanRuntime,
  compiledPlanSectionRequirements,
  createPresetPlan,
} from "./plan.js";
import { compilePlan } from "./plan-compiler.js";
import {
  validateRuntimeConfiguration,
  validRuntimeName,
} from "./runtime-validation.js";
import { runtimeMessage } from "./runtime-diagnostics.js";
import { OverrideManager, rejectedOverrideHandle } from "./overrides.js";
import {
  createAtlasRenderer,
  type CharacterRenderer,
  type CharacterRendererFactory,
} from "./renderer.js";
import { resolveState } from "./resolver.js";
import { SectionTracker } from "./sections.js";
import { SvgPathSampler } from "./path-sampler.js";
import { TargetTracker } from "./targets.js";
import { registerSiteVisibility } from "./visibility.js";
import { snapshotConfiguration } from "./own-data.js";
import type { RuntimeStyleAsset } from "./styles.js";
import {
  type BehaviorRequest,
  NATIVE_DIRECTIONS,
  type DiagnosticRecord,
  type DiagnosticSeverity,
  type EmitResult,
  type HostContent,
  type HostBindings,
  type NativeManifest,
  type NormalizedPack,
  type Point,
  type PeeklingPreset,
  type Plan,
  type PlanBrowserEvent,
  type OverrideHandle,
  type OverrideInput,
  type SurfaceTheme,
  type TargetAnchor,
  type TargetSnapshot,
  type World,
} from "./types.js";

const SUSPEND_HOST = 1;
const SUSPEND_PAGE = 2;
const SUSPEND_SITE = 4;
const MAX_TIMER_DELAY = 2_147_483_647;
const DEFAULT_GRAVITY = 1_800;
const DEFAULT_THROW_SPEED = 1_800;
const DEFAULT_BOUNCE = 0.35;
const DEFAULT_FLOOR_INSET = 8;
const EMPTY_CONTENT_SELECTIONS: readonly ContentSelection[] = Object.freeze([]);

function browserSelectorIsValid(document: Document, selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function runtimeNoticeDetail(code: string): string {
  switch (code) {
    case "config.invalid-name":
      return "Web Component name was ignored because it must be true, false, or short plain text";
    case "lifecycle.hidden":
      return "Page suspended";
    case "lifecycle.visible":
      return "Page resumed";
    case "event.coalesced":
      return "Host event was coalesced";
    case "event.accepted":
      return "Host event was accepted";
    case "override.not-ready":
      return "Override rejected before ready";
    case "lifecycle.paused":
      return "Instance paused";
    case "lifecycle.resumed":
      return "Instance resumed";
    case "lifecycle.destroyed":
      return "Instance destroyed";
    case "config.pack-load-failed":
      return "Pack load failed";
    case "lifecycle.reduced-motion-enabled":
      return "Reduced motion enabled";
    case "lifecycle.reduced-motion-disabled":
      return "Reduced motion disabled";
    case "config.styles-load-failed":
      return "Runtime stylesheet failed";
    case "lifecycle.dismissed":
      return "Instance dismissed";
    case "lifecycle.shown":
      return "Instance shown";
    case "internal.frame-failed":
      return "Frame failed and the instance was destroyed";
    case "render.atlas-upgrade-failed":
      return "Atlas upgrade failed";
    case "lifecycle.pagehide":
      return "Page lifetime ended";
    default:
      return code;
  }
}

interface ActiveFrame {
  readonly generation: number;
  readonly now: number;
  readonly elapsed: number;
  readonly stepMs: number;
  readonly renderer: CharacterRenderer;
  readonly loaded: LoadedPack;
  readonly input: InputCollector;
  readonly plan: PlanRuntime;
  readonly overrides: OverrideManager;
}

interface FrameSnapshot {
  readonly frame: ActiveFrame;
  readonly devicePixelRatio: number;
  readonly characterSize: Readonly<{ width: number; height: number }>;
  readonly world: World;
  readonly reaction: NonNullable<World["reaction"]> | undefined;
}

interface FrameEventDiagnostic {
  readonly message: string;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly eventId: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

interface FrameEvaluation {
  readonly request: BehaviorRequest;
  readonly diagnostics: readonly FrameEventDiagnostic[];
}

interface FramePresentation {
  readonly state: string;
  readonly lift: number;
}

export type PeeklingPosition =
  "bottom-left" | "bottom-right" | "center" | Readonly<Point>;

export type PeeklingPressAction =
  "toggle-content" | "show-content" | "hide-content" | "emit" | "none";

export interface PeeklingInteractionOptions {
  /** Defaults to toggle-content. Setting pressEvent defaults this to emit. */
  press?: PeeklingPressAction;
  /** Bounded application Event emitted by the emit press action. */
  pressEvent?: string;
  drag?: boolean;
  throw?: boolean;
  dragState?: string;
  riseState?: string;
  fallState?: string;
  landState?: string;
  gravity?: number;
  maxThrowSpeed?: number;
  bounce?: number;
  floorInset?: number;
  label?: string;
  contentInitiallyHidden?: boolean;
  clearIndicatorOnPress?: boolean;
  catchTarget?: string;
  catchAnchor?: TargetAnchor;
  catchMargin?: number;
  catchEvent?: string;
}

export type PeeklingIndicator = CharacterIndicator;

export interface PeeklingOptions {
  /** Serializable options contract version. Defaults to 1. */
  format?: 1;
  /** Explicit registered character selection. character, pack, or packUrl is required. */
  character?: string;
  pack?: NativeManifest | NormalizedPack;
  /** Relative or absolute HTTPS manifest candidate checked semantically. */
  packUrl?: string;
  /** Byte-identical atlas mirror. density is required for variant Packs. */
  atlasUrl?: string;
  /** Relative or absolute HTTPS stylesheet candidate checked semantically. */
  styles?: RuntimeStyleAsset;
  /** Host-owned immutable Plan. Packs remain data-only. */
  plan?: Plan;
  /** Named simple behavior compiled into the same canonical Plan. */
  preset?: PeeklingPreset;
  /** Host-approved element geometry available to target-aware motion. */
  targets?: Readonly<Record<string, string>>;
  /** Direct manipulation is enabled by default. Set false to remove the hit target. */
  interaction?: false | PeeklingInteractionOptions;
  /** Optional notification state rendered on the owned character hit target. */
  indicator?: PeeklingIndicator;
  /** Host-owned accessible text and links referenced by plan contentId values. */
  content?: HostContent;
  /** Property-only host surface mounts. */
  bindings?: HostBindings;
  theme?: SurfaceTheme;
  accessibility?: {
    announceContent?: boolean;
    contentLabel?: string;
  };
  diagnostics?: {
    /** Omit for error-only console output, true for all records, or false for none. */
    console?: boolean;
    debug?: boolean;
    context?: Readonly<Record<string, string | number | boolean>>;
  };
  /** Property-only vendor-neutral structured diagnostic sink. */
  logger?: (record: Readonly<DiagnosticRecord>) => void;
  /** Hidden by default. True uses the validated manifest title. */
  name?: boolean | string;
  scale?: number;
  /** Initial center position. Coordinates are CSS pixels and clamp to the viewport. */
  position?: PeeklingPosition;
  density?: 1 | 2 | 4;
  maxDensity?: 1 | 2 | 4;
  onDiagnostic?: (message: string) => void;
  document?: Document;
  window?: Window;
}

export type PeeklingPackSelection =
  | { character: string }
  | { pack: NativeManifest | NormalizedPack }
  | { packUrl: string };

export type PeeklingHatchInput =
  string | (PeeklingOptions & PeeklingPackSelection);

export type PeeklingFinishReason = "destroyed" | "pagehide" | "failed";

export interface PeeklingFinishResult {
  readonly reason: PeeklingFinishReason;
}

function hatchOptions(input?: PeeklingHatchInput): PeeklingOptions {
  if (input === undefined) return {};
  if (typeof input === "string") {
    return { character: input };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      runtimeMessage("options.input", "Expected character or options"),
    );
  }
  return input;
}

function checkedIndicator(
  input: PeeklingIndicator | null,
): PeeklingIndicator | undefined {
  if (input === null) return;
  const value = snapshotConfiguration(input);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.kind !== undefined &&
      value.kind !== "dot" &&
      value.kind !== "count") ||
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(value.label) ||
    (value.count !== undefined &&
      (!Number.isInteger(value.count) ||
        value.count < 0 ||
        value.count > 999)) ||
    (value.color !== undefined && !isSurfaceColor(value.color)) ||
    (value.visible !== undefined && typeof value.visible !== "boolean")
  ) {
    throw new TypeError(
      runtimeMessage("indicator.invalid", "Indicator is invalid"),
    );
  }
  return value;
}

/** Owned runtime handle returned by hatch and Web Component readiness. */
export interface PeeklingInstance {
  readonly ready: Promise<PeeklingInstance>;
  /** Non-rejecting terminal signal that settles once after cleanup. */
  readonly finished: Promise<PeeklingFinishResult>;
  emit(name: string, payload?: unknown): EmitResult;
  override(value: OverrideInput): OverrideHandle;
  pause(): void;
  resume(): void;
  /** Re-resolve configured target selectors after host layout changes. */
  refreshTargets(): void;
  setIndicator(indicator: PeeklingIndicator | null): void;
  /** Show or hide every content surface owned by this character. */
  setContentVisible(visible: boolean): boolean;
  /** Toggle every content surface owned by this character. */
  toggleContent(): boolean;
  destroy(): void;
}

/** Package-internal implementation. It is not a supported import. */
export class PeeklingRuntime implements PeeklingInstance {
  static hatch(
    input: PeeklingHatchInput | PeeklingOptions,
    rendererFactory: CharacterRendererFactory = createAtlasRenderer,
  ): PeeklingRuntime {
    return new PeeklingRuntime(
      hatchOptions(input as PeeklingHatchInput | undefined),
      rendererFactory,
    );
  }

  /** Package-internal presentation update used only by the Web Component. */
  updateComponentName(value: PeeklingOptions["name"]): boolean {
    if (this.#destroyed) {
      return false;
    }
    if (!validRuntimeName(value)) {
      this.#notice("config.invalid-name", "warning", "config");
      return true;
    }
    this.#displayName =
      typeof value === "string"
        ? value
        : value === true
          ? (this.#loaded?.content.displayName ?? "")
          : undefined;
    if (this.#loaded && this.#displayName && !this.#contentRenderer) {
      const renderer = this.#ensureContentRenderer()!;
      void renderer.ready.then(
        () => this.#wake(),
        () => {
          if (this.#destroyed) return;
          this.#diagnoseStyleFailure();
          this.#destroy("failed");
        },
      );
    } else {
      this.#wake();
    }
    return true;
  }

  readonly ready: Promise<this>;
  readonly finished: Promise<PeeklingFinishResult>;
  #resolveFinished: ((result: PeeklingFinishResult) => void) | undefined;
  #destroyed = false;
  #abort = new AbortController();
  #loaded?: LoadedPack;
  #renderer?: CharacterRenderer;
  #contentRenderer?: ContentRenderer;
  #interactionController?: CharacterInteractionController;
  #sections?: SectionTracker;
  #targets?: TargetTracker;
  #input: InputCollector | undefined;
  #raf = 0;
  #planTimer = 0;
  #frameGeneration = 0;
  #lastTick = 0;
  #animationClock = 0;
  #locomotionElapsed = 0;
  #locomotionState = "";
  #position: Point = { x: 0, y: 0 };
  #seenReaction = 0;
  #reducedMotion = false;
  #media?: MediaQueryList;
  #mediaListener?: (event: MediaQueryListEvent) => void;
  #dprMedia?: MediaQueryList;
  #dprListener?: () => void;
  #densityUpgrade: Promise<void> | undefined;
  #siteHidden = false;
  #suspensions = 0;
  #suspendedAt: number | undefined;
  #unregisterVisibility: (() => void) | undefined;
  #visibilityReady: Promise<void>;
  #pageVisibilityListener: (() => void) | undefined;
  #pageHideListener: (() => void) | undefined;
  #maxDensity: 1 | 2 | 4 = DEFAULT_MAX_DENSITY;
  #displayName: string | undefined;
  readonly #document: Document;
  readonly #window: Window;
  #plan: PlanRuntime | undefined;
  readonly #content: HostContent;
  readonly #options: PeeklingOptions;
  readonly #now: () => number;
  #overrides: OverrideManager | undefined;
  readonly #instanceId: string;
  readonly #diagnostics: DiagnosticChannel;
  readonly #styles: RuntimeStyleAsset;
  readonly #rendererFactory: CharacterRendererFactory;
  #rejectedOverrideId = 0;
  #reportedNotReadyEvent = false;
  #reportedNotReadyOverride = false;
  #trackTargets = false;
  readonly #pathSampler: SvgPathSampler;
  #indicator: PeeklingIndicator | undefined;
  #dragging = false;
  #throwing = false;
  #throwVelocity: Point = { x: 0, y: 0 };
  #landUntil = 0;

  constructor(
    options: PeeklingOptions = {},
    rendererFactory: CharacterRendererFactory = createAtlasRenderer,
  ) {
    options = snapshotConfiguration(options);
    const document = options.document ?? globalThis.document;
    const window = options.window ?? globalThis.window;
    if (!document || !window)
      throw new Error(
        runtimeMessage("browser.context", "Browser document/window required"),
      );
    this.#document = document;
    this.#window = window;
    this.#pathSampler = new SvgPathSampler(document);
    this.#options = options;
    this.#indicator = options.indicator;
    this.#rendererFactory = rendererFactory;
    this.#now = window.performance?.now?.bind(window.performance) ?? Date.now;
    this.#instanceId = `instance:${Math.floor(this.#now())}:${Math.random().toString(36).slice(2, 8)}`;
    this.#diagnostics = new DiagnosticChannel({
      instanceId: this.#instanceId,
      now: this.#now,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.onDiagnostic ? { messageSink: options.onDiagnostic } : {}),
      ...(options.diagnostics?.context
        ? { context: options.diagnostics.context }
        : {}),
      ...(options.diagnostics?.debug ? { debug: true } : {}),
      ...(options.diagnostics?.console === undefined
        ? {}
        : { console: options.diagnostics.console }),
    });
    const [content, styles] = validateRuntimeConfiguration(
      options,
      window.location?.href ?? document.baseURI,
    );
    this.#styles = styles;
    this.finished = new Promise((resolve) => {
      this.#resolveFinished = resolve;
    });
    this.#displayName =
      typeof options.name === "string"
        ? options.name
        : options.name === true
          ? ""
          : undefined;
    this.#content = content;
    const visibility = registerSiteVisibility(
      document,
      window,
      (hidden) => {
        if (hidden !== null) {
          this.#setSiteHidden(hidden);
          return;
        }
        this.#diagnose(
          runtimeMessage(
            "visibility.root-failed",
            "Visibility root failed and the instance was destroyed",
          ),
          "internal.frame-failed",
          "error",
          "internal",
        );
        this.#destroy("failed");
      },
      this.#styles,
    );
    this.#unregisterVisibility = visibility.unregister;
    this.#visibilityReady = visibility.ready;
    this.#pageVisibilityListener = () => {
      if (document.hidden) {
        this.#setSuspended(SUSPEND_PAGE, true);
        this.#notice("lifecycle.hidden", "info", "lifecycle");
      } else {
        this.#setSuspended(SUSPEND_PAGE, false);
        this.#notice("lifecycle.visible", "info", "lifecycle");
      }
    };
    document.addEventListener(
      "visibilitychange",
      this.#pageVisibilityListener,
      { passive: true },
    );
    this.#pageHideListener = () => this.#endPage();
    window.addEventListener("pagehide", this.#pageHideListener, {
      passive: true,
    });
    if (document.hidden) this.#setSuspended(SUSPEND_PAGE, true);
    this.ready = this.#initialize();
    void this.ready.catch(() => {});
  }

  emit(name: string, payload?: unknown): EmitResult {
    if (this.#destroyed) return this.#rejectEvent("destroyed");
    if (this.#siteHidden) return this.#rejectEvent("hidden");
    if (typeof name !== "string" || !EVENT_NAME_PATTERN.test(name)) {
      return this.#rejectEvent("invalid-name");
    }
    if (!this.#input) return this.#rejectEvent("not-ready");
    let checked;
    try {
      checked = validateEventPayload(payload);
    } catch {
      return this.#rejectEvent("invalid-payload");
    }
    const result = this.#input.captureReaction(name, checked, "application");
    if (!result.accepted) return this.#rejectEvent(result.reason);
    this.#notice(
      result.coalesced ? "event.coalesced" : "event.accepted",
      "info",
      "event",
      result.id,
    );
    return result;
  }

  override(value: OverrideInput): OverrideHandle {
    const rejected = (reason: import("./types.js").OverrideCompletionReason) =>
      rejectedOverrideHandle(
        `override:rejected:${++this.#rejectedOverrideId}`,
        reason,
      );
    if (this.#destroyed) return rejected("destroyed");
    if (this.#siteHidden) return rejected("dismissed");
    if (!this.#overrides) {
      if (!this.#reportedNotReadyOverride) {
        this.#reportedNotReadyOverride = true;
        this.#notice("override.not-ready", "warning", "override");
      }
      return rejected("rejected");
    }
    const handle = this.#overrides.add(value);
    const completion = this.#overrides.browserCompletionFor(handle.id);
    const releaseCompletion = completion
      ? this.#input?.retainEvent(completion)
      : undefined;
    void handle.finished.then(() => {
      releaseCompletion?.();
      this.#wake();
    });
    this.#wake();
    return handle;
  }

  pause(): void {
    if (this.#destroyed || this.#suspensions & SUSPEND_HOST) return;
    this.#setSuspended(SUSPEND_HOST, true);
    this.#notice("lifecycle.paused", "info", "lifecycle");
  }

  resume(): void {
    if (this.#destroyed || !(this.#suspensions & SUSPEND_HOST)) return;
    this.#setSuspended(SUSPEND_HOST, false);
    this.#notice("lifecycle.resumed", "info", "lifecycle");
  }

  refreshTargets(): void {
    this.#targets?.refresh();
  }

  setIndicator(indicator: PeeklingIndicator | null): void {
    if (this.#destroyed) return;
    this.#indicator = checkedIndicator(indicator);
    this.#interactionController?.updateIndicator(this.#indicator);
  }

  setContentVisible(visible: boolean): boolean {
    if (this.#destroyed || !this.#contentRenderer) return false;
    const expanded = this.#contentRenderer.setUserHidden(!visible);
    this.#interactionController?.setExpanded(expanded);
    this.#wake();
    return expanded;
  }

  toggleContent(): boolean {
    if (this.#destroyed || !this.#contentRenderer) return false;
    const expanded = this.#contentRenderer.toggleUserHidden();
    this.#interactionController?.setExpanded(expanded);
    this.#wake();
    return expanded;
  }

  destroy(): void {
    this.#destroy("destroyed");
  }

  #destroy(reason: PeeklingFinishReason): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#frameGeneration += 1;
    this.#overrides?.clear("destroyed");
    this.#abort.abort();
    this.#cancelWork();
    this.#input?.destroy();
    this.#plan?.reset();
    this.#sections?.destroy();
    this.#targets?.destroy();
    this.#contentRenderer?.destroy();
    this.#interactionController?.destroy();
    this.#renderer?.destroy();
    this.#unregisterVisibility?.();
    this.#unregisterVisibility = undefined;
    if (this.#pageVisibilityListener) {
      this.#document.removeEventListener(
        "visibilitychange",
        this.#pageVisibilityListener,
      );
      this.#pageVisibilityListener = undefined;
    }
    if (this.#pageHideListener) {
      this.#window.removeEventListener("pagehide", this.#pageHideListener);
      this.#pageHideListener = undefined;
    }
    this.#loaded?.release();
    if (this.#media && this.#mediaListener) {
      this.#media.removeEventListener("change", this.#mediaListener);
    }
    if (this.#dprMedia && this.#dprListener) {
      this.#dprMedia.removeEventListener("change", this.#dprListener);
    }
    this.#notice("lifecycle.destroyed", "info", "lifecycle");
    const resolve = this.#resolveFinished;
    this.#resolveFinished = undefined;
    resolve?.({ reason });
  }

  async #initialize(): Promise<this> {
    try {
      const validateSelector = (selector: string) =>
        browserSelectorIsValid(this.#document, selector);
      const targetIds = new Set(Object.keys(this.#options.targets ?? {}));
      for (const selector of Object.values(this.#options.targets ?? {})) {
        if (!validateSelector(selector)) {
          throw new TypeError(
            runtimeMessage("target.selector", "Target selector is invalid"),
          );
        }
      }
      if (this.#options.plan !== undefined) {
        compilePlan(this.#options.plan, {
          contentIds: new Set(Object.keys(this.#content)),
          targets: targetIds,
          validateSelector,
          validatePath: (path) => this.#pathSampler.validate(path),
        });
      }
      const browserWindow = this.#window as Window & typeof globalThis;
      const connection = (
        browserWindow.navigator as Navigator & {
          connection?: { saveData?: boolean };
        }
      ).connection;
      this.#maxDensity =
        this.#options.maxDensity ?? (connection?.saveData ? 2 : 4);
      let loaded: LoadedPack;
      try {
        loaded = await loadNativePack({
          ...(this.#options.character === undefined
            ? {}
            : { character: this.#options.character }),
          baseUrl: this.#window.location.href,
          ...(this.#options.pack === undefined
            ? {}
            : { pack: this.#options.pack }),
          ...(this.#options.packUrl === undefined
            ? {}
            : { packUrl: this.#options.packUrl }),
          ...(this.#options.atlasUrl === undefined
            ? {}
            : { atlasUrl: this.#options.atlasUrl }),
          ...(this.#options.scale === undefined
            ? {}
            : { renderScale: this.#options.scale }),
          devicePixelRatio: this.#window.devicePixelRatio,
          ...(this.#options.density === undefined
            ? {}
            : { densityOverride: this.#options.density }),
          maxDensity: this.#maxDensity,
          fetch: this.#window.fetch.bind(this.#window),
          image: () => new browserWindow.Image(),
          signal: this.#abort.signal,
          createObjectURL: browserWindow.URL.createObjectURL.bind(
            browserWindow.URL,
          ),
          revokeObjectURL: browserWindow.URL.revokeObjectURL.bind(
            browserWindow.URL,
          ),
          diagnostic: (message, category) => {
            this.#diagnose(
              message,
              category ? `config.pack-load-${category}` : "config.pack-load",
              "warning",
              "config",
            );
          },
        });
      } catch (cause) {
        if (this.#destroyed && this.#abort.signal.aborted) throw cause;
        this.#notice(
          "config.pack-load-failed",
          "error",
          "config",
          undefined,
          undefined,
          cause,
        );
        throw cause;
      }
      if (this.#destroyed) {
        loaded.release();
        throw new DOMException(
          runtimeMessage("lifecycle.destroyed", "Destroyed while initializing"),
          "AbortError",
        );
      }
      const scale = this.#options.scale ?? loaded.content.defaultScale;
      if (!Number.isInteger(scale) || scale < 1 || scale > 4) {
        loaded.release();
        throw new TypeError(
          runtimeMessage("scale.value", "scale must be integer 1-4"),
        );
      }
      this.#loaded = loaded;
      const locomotion = hasLocomotion(loaded.content);
      const capabilities = new Set<"locomotion">(
        locomotion ? ["locomotion"] : [],
      );
      const compiled = compilePlan(
        this.#options.plan ??
          createPresetPlan(this.#options.preset ?? "companion", locomotion),
        {
          states: new Set(Object.keys(loaded.content.states)),
          capabilities,
          contentIds: new Set(Object.keys(this.#content)),
          targets: targetIds,
          validateSelector,
          validatePath: (path) => this.#pathSampler.validate(path),
        },
      );
      this.#plan = new PlanRuntime(compiled);
      this.#overrides = new OverrideManager(
        {
          states: new Set(Object.keys(loaded.content.states)),
          capabilities,
          contentIds: new Set(Object.keys(this.#content)),
          targets: targetIds,
          validatePath: (path) => this.#pathSampler.validate(path),
        },
        this.#now,
        (message) =>
          this.#diagnose(message, "override.rejected", "warning", "override"),
      );
      if (this.#displayName === "") {
        this.#displayName = loaded.content.displayName;
      }
      this.#media = this.#window.matchMedia("(prefers-reduced-motion: reduce)");
      this.#reducedMotion = this.#media.matches;
      this.#mediaListener = (event) => {
        this.#reducedMotion = event.matches;
        this.#notice(
          event.matches
            ? "lifecycle.reduced-motion-enabled"
            : "lifecycle.reduced-motion-disabled",
          "info",
          "lifecycle",
        );
        this.#wake();
      };
      this.#media.addEventListener("change", this.#mediaListener);
      this.#watchDpr();
      this.#position = resolveInitialPosition(
        this.#options.position ?? DEFAULT_POSITION,
        this.#window.innerWidth,
        this.#window.innerHeight,
        (loaded.content.atlas.logicalWidth ?? loaded.content.atlas.cellWidth) *
          scale,
        (loaded.content.atlas.logicalHeight ??
          loaded.content.atlas.cellHeight) * scale,
      );
      this.#renderer = this.#rendererFactory({
        document: this.#document,
        pack: loaded.content,
        atlasUrl: loaded.atlasObjectUrl,
        scale,
        styles: this.#styles,
      });
      if (
        Object.keys(this.#content).length ||
        this.#displayName !== undefined
      ) {
        this.#ensureContentRenderer();
      }
      if (this.#options.interaction !== false) {
        const interaction = this.#options.interaction ?? {};
        const pressAction =
          interaction.press ??
          (interaction.pressEvent ? "emit" : "toggle-content");
        const controlsContent =
          Boolean(this.#contentRenderer) &&
          (pressAction === "toggle-content" ||
            pressAction === "show-content" ||
            pressAction === "hide-content");
        if (interaction.contentInitiallyHidden) {
          this.#contentRenderer?.setUserHidden(true);
        }
        this.#interactionController = new CharacterInteractionController({
          document: this.#document,
          styles: this.#styles,
          label:
            interaction.label ??
            `Interact with ${loaded.content.displayName || "Peekling"}`,
          draggable: interaction.drag !== false,
          ...(controlsContent
            ? { expanded: !interaction.contentInitiallyHidden }
            : {}),
          ...(this.#indicator ? { indicator: this.#indicator } : {}),
          onPress: () => this.#handleCharacterPress(),
          onDragStart: () => this.#startCharacterDrag(),
          onDragMove: (position, velocity) =>
            this.#moveCharacterDrag(position, velocity),
          onDragEnd: (velocity, moved, pointer) =>
            this.#endCharacterDrag(velocity, moved, pointer),
        });
        if (interaction.contentInitiallyHidden) {
          this.#interactionController.setExpanded(false);
        }
      }
      try {
        await Promise.all([
          this.#visibilityReady,
          this.#renderer.ready,
          this.#contentRenderer?.ready,
          this.#interactionController?.ready,
        ]);
      } catch (cause) {
        this.#diagnoseStyleFailure(cause);
        throw cause;
      }
      const requirements = compiledPlanSectionRequirements(compiled);
      this.#createInput();
      if (targetIds.size) {
        this.#targets = new TargetTracker(
          this.#document,
          this.#window,
          this.#options.targets!,
          () => this.#wake(),
        );
      }
      if (requirements.selectors.length) {
        this.#sections = new SectionTracker(
          this.#document,
          this.#window,
          requirements.selectors,
          requirements.thresholds,
          () => this.#wake(),
          (fact) =>
            this.#input?.captureReaction("section.visibility", fact, "browser"),
        );
      }
      this.#renderer.setHidden(this.#siteHidden);
      this.#interactionController?.setHidden(this.#siteHidden);
      if (this.#suspensions) {
        this.#input?.setSuspended(true);
        this.#sections?.setSuspended(true);
      }
      this.#lastTick = this.#now();
      this.#tick(this.#lastTick, true);
      return this;
    } catch (error) {
      this.#destroy("failed");
      throw error;
    }
  }

  #createInput(): void {
    if (this.#destroyed || this.#input || !this.#plan) return;
    const events = new Set<PlanBrowserEvent>();
    const coalesce = new Map<
      string,
      true | { sessionField: string; revisionField: string }
    >();
    for (const rule of this.#plan.plan.rules) {
      const browser = rule.when.source === "browser";
      if (browser) events.add(rule.when.event);
      if (rule.effect.until?.type === "event") {
        const completion = browserCompletionEvent(rule.effect.until.name);
        if (completion) events.add(completion);
      }
      if (rule.when.coalesce !== "latest") continue;
      const key = `${rule.when.source}:${rule.when.event}`;
      if (browser) coalesce.set(key, true);
      else {
        const ordering = rule.effect.surfaces[0]!.ordering!;
        coalesce.set(key, {
          sessionField: ordering.sessionField,
          revisionField: ordering.revisionField!,
        });
      }
    }
    this.#input = new InputCollector(this.#document, this.#window, {
      events,
      coalesce,
      diagnostic: (message) =>
        this.#diagnose(message, "event.queue-overflow", "warning", "event"),
      now: this.#now,
      wake: () => this.#wake(),
    });
    if (events.has("page.lifecycle")) {
      this.#input.captureReaction(
        "page.lifecycle",
        { phase: "show" },
        "browser",
      );
    }
  }

  #ensureContentRenderer(): ContentRenderer | undefined {
    if (this.#contentRenderer || this.#destroyed) return this.#contentRenderer;
    this.#contentRenderer = new ContentRenderer(this.#document, {
      diagnostic: (message) =>
        this.#diagnose(message, "render.host-failed", "error", "render"),
      ...(this.#options.bindings ? { bindings: this.#options.bindings } : {}),
      ...(this.#options.theme ? { theme: this.#options.theme } : {}),
      ...(this.#options.accessibility?.announceContent
        ? { announce: true }
        : {}),
      ...(this.#options.accessibility?.contentLabel
        ? { label: this.#options.accessibility.contentLabel }
        : {}),
      emit: (name, payload) => this.emit(name, payload),
      wake: () => this.#wake(),
      styles: this.#styles,
    });
    return this.#contentRenderer;
  }

  #handleCharacterPress(): void {
    if (this.#destroyed) return;
    const interaction = this.#options.interaction || {};
    if (interaction.clearIndicatorOnPress === true && this.#indicator) {
      this.setIndicator(null);
    }
    const action =
      interaction.press ?? (interaction.pressEvent ? "emit" : "toggle-content");
    if (action === "emit") {
      if (interaction.pressEvent) this.emit(interaction.pressEvent);
      return;
    }
    if (action === "none") return;
    if (action === "show-content") this.setContentVisible(true);
    else if (action === "hide-content") this.setContentVisible(false);
    else this.toggleContent();
  }

  #startCharacterDrag(): void {
    if (this.#destroyed || this.#siteHidden) return;
    this.#dragging = true;
    this.#throwing = false;
    this.#landUntil = 0;
    this.#throwVelocity = { x: 0, y: 0 };
    this.#wake();
  }

  #moveCharacterDrag(
    position: Readonly<Point>,
    velocity: Readonly<Point>,
  ): void {
    if (!this.#dragging || this.#destroyed) return;
    const size = this.#characterSize();
    this.#position = size
      ? clampPosition(
          position,
          { width: this.#window.innerWidth, height: this.#window.innerHeight },
          size.width,
          size.height,
        )
      : { ...position };
    this.#throwVelocity = { ...velocity };
    this.#wake();
  }

  #endCharacterDrag(
    velocity: Readonly<Point>,
    moved: boolean,
    pointer: Readonly<Point>,
  ): void {
    if (!this.#dragging || this.#destroyed) return;
    this.#dragging = false;
    if (!moved) {
      this.#throwVelocity = { x: 0, y: 0 };
      this.#wake();
      return;
    }
    const interaction = this.#options.interaction || {};
    if (
      interaction.catchTarget &&
      this.#targets?.contains(
        interaction.catchTarget,
        pointer,
        interaction.catchMargin ?? 24,
      ) &&
      this.#catchCharacter(interaction.catchTarget)
    ) {
      return;
    }
    if (this.#reducedMotion) {
      this.#landCharacter();
      return;
    }
    if (interaction.throw === false) {
      this.#throwVelocity = { x: 0, y: 0 };
      this.#wake();
      return;
    }
    const maximum = interaction.maxThrowSpeed ?? DEFAULT_THROW_SPEED;
    const magnitude = Math.hypot(velocity.x, velocity.y);
    const factor = magnitude > maximum && magnitude ? maximum / magnitude : 1;
    this.#throwVelocity = {
      x: velocity.x * factor,
      y: velocity.y * factor,
    };
    this.#throwing = true;
    this.#wake();
  }

  #characterSize(): { width: number; height: number } | undefined {
    const loaded = this.#loaded?.content;
    if (!loaded) return;
    const scale = this.#options.scale ?? loaded.defaultScale;
    return {
      width: (loaded.atlas.logicalWidth ?? loaded.atlas.cellWidth) * scale,
      height: (loaded.atlas.logicalHeight ?? loaded.atlas.cellHeight) * scale,
    };
  }

  #landCharacter(): void {
    const size = this.#characterSize();
    if (size) {
      const floorInset =
        (this.#options.interaction || {}).floorInset ?? DEFAULT_FLOOR_INSET;
      this.#position = clampPosition(
        {
          x: this.#position.x,
          y: this.#window.innerHeight - size.height / 2 - floorInset,
        },
        { width: this.#window.innerWidth, height: this.#window.innerHeight },
        size.width,
        size.height,
      );
    }
    this.#dragging = false;
    this.#throwing = false;
    this.#throwVelocity = { x: 0, y: 0 };
    this.#landUntil = this.#now() + 360;
    this.#wake();
  }

  #catchCharacter(targetId: string): boolean {
    const target = this.#targets?.snapshot(true)[targetId];
    const size = this.#characterSize();
    if (!target || !size) return false;
    const interaction = this.#options.interaction || {};
    const point = characterTargetPoint(
      target,
      interaction.catchAnchor ?? "center",
      size,
    );
    this.#position = clampPosition(
      point,
      { width: this.#window.innerWidth, height: this.#window.innerHeight },
      size.width,
      size.height,
    );
    this.#throwing = false;
    this.#throwVelocity = { x: 0, y: 0 };
    this.#landUntil = this.#now() + 360;
    if (interaction.catchEvent) this.emit(interaction.catchEvent);
    this.#wake();
    return true;
  }

  #diagnose(
    message: string,
    code = "runtime.notice",
    severity: DiagnosticSeverity = "warning",
    phase: DiagnosticRecord["phase"] = "internal",
    eventId?: number,
    metadata?: Readonly<Record<string, string | number | boolean>>,
    cause?: unknown,
  ): void {
    this.#diagnostics.emit({
      code,
      severity,
      message,
      phase,
      ...(eventId === undefined ? {} : { eventId }),
      ...(metadata ? { metadata } : {}),
      ...(cause ? { cause } : {}),
    });
  }

  #notice(
    code: string,
    severity: DiagnosticSeverity = "warning",
    phase: DiagnosticRecord["phase"] = "internal",
    eventId?: number,
    metadata?: Readonly<Record<string, string | number | boolean>>,
    cause?: unknown,
  ): void {
    this.#diagnose(
      runtimeMessage(code, () => runtimeNoticeDetail(code)),
      code,
      severity,
      phase,
      eventId,
      metadata,
      cause,
    );
  }

  #diagnoseStyleFailure(cause?: unknown): void {
    this.#notice(
      "config.styles-load-failed",
      "error",
      "config",
      undefined,
      undefined,
      cause,
    );
  }

  #rejectEvent(reason: NonNullable<EmitResult["reason"]>): EmitResult {
    if (reason === "not-ready") {
      if (this.#reportedNotReadyEvent) return { accepted: false, reason };
      this.#reportedNotReadyEvent = true;
    }
    this.#diagnose(
      runtimeMessage("event.rejected", "Host event was rejected"),
      `event.rejected.${reason}`,
      "warning",
      "event",
      undefined,
      { reason },
    );
    return { accepted: false, reason };
  }

  #suspendClock(): void {
    if (this.#suspendedAt !== undefined) return;
    this.#suspendedAt = this.#now();
    this.#cancelWork();
    this.#input?.setSuspended(true);
    this.#sections?.setSuspended(true);
  }

  #cancelWork(): void {
    if (this.#raf) this.#window.cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    if (this.#planTimer) this.#window.clearTimeout(this.#planTimer);
    this.#planTimer = 0;
  }

  #resumeClock(): void {
    if (this.#suspendedAt === undefined || this.#suspensions || this.#destroyed)
      return;
    const now = this.#now();
    const delta = Math.max(0, now - this.#suspendedAt);
    this.#suspendedAt = undefined;
    this.#overrides?.rebase(delta);
    this.#plan?.rebase(delta);
    this.#input?.setSuspended(false);
    this.#sections?.setSuspended(false);
    this.#lastTick = now;
    this.#wake();
  }

  #setSuspended(reason: number, suspended: boolean): void {
    const previous = this.#suspensions;
    if (suspended) this.#suspensions |= reason;
    else this.#suspensions &= ~reason;
    if (previous === this.#suspensions) return;
    this.#frameGeneration += 1;
    if (!previous && this.#suspensions) this.#suspendClock();
    if (previous && !this.#suspensions) this.#resumeClock();
  }

  #setSiteHidden(hidden: boolean): void {
    if (hidden === this.#siteHidden) return;
    this.#siteHidden = hidden;
    this.#renderer?.setHidden(hidden);
    this.#interactionController?.setHidden(hidden);
    if (this.#destroyed) return;
    if (hidden && this.#contentRenderer) {
      this.#contentRenderer.renderSurfaces(
        [],
        {},
        this.#position,
        {
          width: this.#window.innerWidth,
          height: this.#window.innerHeight,
        },
        { width: 0, height: 0 },
      );
      if (this.#destroyed) return;
    }
    if (hidden) {
      this.#dragging = false;
      this.#throwing = false;
      this.#throwVelocity = { x: 0, y: 0 };
      this.#overrides?.clear("dismissed");
      this.#setSuspended(SUSPEND_SITE, true);
      this.#notice("lifecycle.dismissed", "info", "lifecycle");
      return;
    }
    this.#setSuspended(SUSPEND_SITE, false);
    if (!this.#renderer || !this.#loaded || this.#destroyed) return;
    this.#notice("lifecycle.shown", "info", "lifecycle");
    if (!this.#destroyed) this.#wake();
  }

  #wake(): void {
    if (this.#destroyed || this.#suspensions || !this.#renderer || this.#raf)
      return;
    if (this.#planTimer) this.#window.clearTimeout(this.#planTimer);
    this.#planTimer = 0;
    const generation = this.#frameGeneration;
    const frame = this.#window.requestAnimationFrame(() => {
      this.#raf = 0;
      if (
        this.#destroyed ||
        this.#suspensions ||
        generation !== this.#frameGeneration
      )
        return;
      try {
        this.#tick(this.#now());
      } catch (cause) {
        this.#notice(
          "internal.frame-failed",
          "error",
          "internal",
          undefined,
          undefined,
          cause,
        );
        this.#destroy("failed");
      }
    });
    if (
      this.#destroyed ||
      this.#suspensions ||
      generation !== this.#frameGeneration
    ) {
      this.#window.cancelAnimationFrame(frame);
      return;
    }
    this.#raf = frame;
  }

  #schedulePlan(frame: ActiveFrame): void {
    if (!this.#frameActive(frame)) return;
    if (this.#planTimer) this.#window.clearTimeout(this.#planTimer);
    this.#planTimer = 0;
    const overrideCandidate = frame.overrides.nextWakeAt();
    const overrideWake = Number.isFinite(overrideCandidate)
      ? overrideCandidate
      : undefined;
    const interruptCandidate = frame.plan.nextWakeAt();
    const interruptWake = Number.isFinite(interruptCandidate)
      ? interruptCandidate
      : undefined;
    const animationCandidate = this.#reducedMotion
      ? undefined
      : frame.renderer.nextFrameIn(this.#animationClock);
    const animationDelay = Number.isFinite(animationCandidate)
      ? animationCandidate
      : undefined;
    const animationWake =
      animationDelay === undefined ? undefined : frame.now + animationDelay;
    const runtimeWake =
      overrideWake === undefined
        ? interruptWake
        : interruptWake === undefined
          ? overrideWake
          : Math.min(overrideWake, interruptWake);
    const wakeAt =
      runtimeWake === undefined
        ? animationWake
        : animationWake === undefined
          ? runtimeWake
          : Math.min(runtimeWake, animationWake);
    if (
      wakeAt === undefined ||
      !Number.isFinite(wakeAt) ||
      !this.#frameActive(frame)
    )
      return;
    const timer = this.#window.setTimeout(
      () => {
        if (!this.#frameActive(frame)) return;
        this.#planTimer = 0;
        this.#wake();
      },
      Math.min(MAX_TIMER_DELAY, Math.max(0, wakeAt - frame.now)),
    );
    if (!this.#frameActive(frame)) {
      this.#window.clearTimeout(timer);
      return;
    }
    this.#planTimer = timer;
  }

  #watchDpr(): void {
    if (this.#dprMedia && this.#dprListener)
      this.#dprMedia.removeEventListener("change", this.#dprListener);
    this.#dprMedia = this.#window.matchMedia(
      `(resolution: ${this.#window.devicePixelRatio}dppx)`,
    );
    this.#dprListener = () => {
      this.#watchDpr();
      this.#maybeUpgradeDensity();
      this.#wake();
    };
    this.#dprMedia.addEventListener("change", this.#dprListener);
  }

  #maybeUpgradeDensity(): void {
    if (
      this.#destroyed ||
      !this.#loaded ||
      !this.#renderer ||
      this.#densityUpgrade ||
      this.#options.density !== undefined
    )
      return;
    const scale = this.#options.scale ?? this.#loaded.content.defaultScale;
    const required = requiredAtlasDensity(
      this.#window.devicePixelRatio,
      scale,
      this.#maxDensity,
    );
    if (required <= this.#loaded.loadedDensity) return;
    const loaded = this.#loaded;
    this.#densityUpgrade = loaded
      .upgrade(required)
      .then((changed) => {
        if (changed && !this.#destroyed && this.#loaded === loaded) {
          const renderer = this.#renderer;
          if (!renderer) return;
          return Promise.resolve(
            renderer.swapAtlas(loaded.content, loaded.atlasObjectUrl),
          ).then(() => {
            if (!this.#destroyed && this.#loaded === loaded) this.#wake();
          });
        }
      })
      .catch((error) => {
        if (!this.#destroyed)
          this.#notice(
            "render.atlas-upgrade-failed",
            "warning",
            "render",
            undefined,
            undefined,
            error,
          );
      })
      .finally(() => {
        this.#densityUpgrade = undefined;
      });
  }

  #frameActive(frame: ActiveFrame): boolean {
    return (
      !this.#destroyed &&
      !this.#suspensions &&
      frame.generation === this.#frameGeneration &&
      frame.renderer === this.#renderer &&
      frame.loaded === this.#loaded &&
      frame.input === this.#input &&
      frame.plan === this.#plan &&
      frame.overrides === this.#overrides
    );
  }

  #beginFrame(now: number, force: boolean): ActiveFrame | undefined {
    const renderer = this.#renderer;
    const loaded = this.#loaded;
    const input = this.#input;
    const plan = this.#plan;
    const overrides = this.#overrides;
    if (
      this.#destroyed ||
      this.#suspensions ||
      !renderer ||
      !loaded ||
      !input ||
      !plan ||
      !overrides
    )
      return;
    const elapsed = now - this.#lastTick;
    if (!force && elapsed < 1000 / 30) {
      this.#wake();
      return;
    }
    return {
      generation: this.#frameGeneration,
      now,
      elapsed,
      stepMs: Math.min(Math.max(0, elapsed) || 1000 / 30, 100),
      renderer,
      loaded,
      input,
      plan,
      overrides,
    };
  }

  #snapshotFrame(frame: ActiveFrame): FrameSnapshot {
    const loaded = frame.loaded.content;
    const input = frame.input;
    const scale = this.#options.scale ?? loaded.defaultScale;
    const viewport = {
      width: this.#window.innerWidth,
      height: this.#window.innerHeight,
    };
    const characterSize = {
      width: (loaded.atlas.logicalWidth ?? loaded.atlas.cellWidth) * scale,
      height: (loaded.atlas.logicalHeight ?? loaded.atlas.cellHeight) * scale,
    };
    const devicePixelRatio = this.#window.devicePixelRatio;
    this.#maybeUpgradeDensity();
    this.#position = clampPosition(
      this.#position,
      viewport,
      characterSize.width,
      characterSize.height,
    );
    const sections = this.#sections?.snapshot();
    const reactionCandidate = input.reaction;
    const reaction =
      reactionCandidate && reactionCandidate.id > this.#seenReaction
        ? reactionCandidate
        : undefined;
    const world = {
      now: frame.now,
      pointer: input.pointer,
      position: this.#position,
      viewport,
      characterSize,
      lastActivityAt: input.lastActivityAt,
      reducedMotion: this.#reducedMotion,
      pageVisible: !this.#document.hidden,
      sections,
      targets: this.#targets?.snapshot(this.#trackTargets),
      samplePath: (path: string, progress: number) =>
        this.#pathSampler.sample(path, progress),
      reaction,
    } as World;
    return {
      frame,
      devicePixelRatio,
      characterSize,
      world,
      reaction,
    };
  }

  #evaluateFrame(snapshot: FrameSnapshot): FrameEvaluation {
    const { frame, world, reaction } = snapshot;
    const { plan, overrides } = frame;
    const ordinary = plan.evaluate(world);
    const eventStatus = reaction ? plan.lastEventStatus : undefined;
    const eventRejections = reaction ? plan.lastEventRejections : [];
    if (
      reaction &&
      eventStatus !== "invalid" &&
      eventStatus !== "stale" &&
      eventStatus !== "closed"
    ) {
      overrides.observeEvent(reaction.name, reaction.source);
    }
    const request = overrides.compose(ordinary, world);
    this.#trackTargets = request.motion?.trackTarget === true;
    if (this.#reducedMotion) {
      delete request.motion;
      if (request.capability === "locomotion") delete request.capability;
      if (!request.state) request.state = "idle";
    }
    const interaction = this.#options.interaction || {};
    if (this.#dragging) {
      delete request.motion;
      delete request.capability;
      request.state = interaction.dragState ?? "scroll:fly";
    } else if (this.#throwing) {
      delete request.motion;
      delete request.capability;
      request.state =
        this.#throwVelocity.y < 0
          ? (interaction.riseState ?? "scroll:fly")
          : (interaction.fallState ?? "scroll:fall");
    } else if (this.#landUntil > world.now) {
      delete request.motion;
      delete request.capability;
      request.state = interaction.landState ?? "success";
    }
    const diagnostics: FrameEventDiagnostic[] = [];
    if (reaction) {
      this.#seenReaction = reaction.id;
      frame.input.consumeReaction(reaction.id);
      if (eventRejections.length) {
        for (const rejection of eventRejections) {
          diagnostics.push(
            Object.freeze({
              message: runtimeMessage(
                `event.${rejection.status}`,
                () => `Host event ${rejection.status}`,
              ),
              code: `event.${rejection.status}`,
              severity: rejection.status === "invalid" ? "warning" : "info",
              eventId: reaction.id,
              metadata: Object.freeze({ channel: rejection.channel }),
            }),
          );
        }
      } else if (
        eventStatus === "stale" ||
        eventStatus === "closed" ||
        eventStatus === "invalid"
      ) {
        diagnostics.push(
          Object.freeze({
            message: runtimeMessage(
              `event.${eventStatus}`,
              () => `Host event ${eventStatus}`,
            ),
            code: `event.${eventStatus}`,
            severity: eventStatus === "invalid" ? "warning" : "info",
            eventId: reaction.id,
          }),
        );
      } else if (eventStatus !== "matched") {
        diagnostics.push(
          Object.freeze({
            message: runtimeMessage("event.unmatched", "Host event unmatched"),
            code: "event.unmatched",
            severity: "info",
            eventId: reaction.id,
          }),
        );
      }
    }
    return { request, diagnostics };
  }

  #emitFrameDiagnostics(
    frame: ActiveFrame,
    diagnostics: readonly FrameEventDiagnostic[],
  ): boolean {
    for (const diagnostic of diagnostics) {
      if (!this.#frameActive(frame)) return false;
      this.#diagnose(
        diagnostic.message,
        diagnostic.code,
        diagnostic.severity,
        "event",
        diagnostic.eventId,
        diagnostic.metadata,
      );
    }
    return this.#frameActive(frame);
  }

  #advanceThrow(snapshot: FrameSnapshot): void {
    if (!this.#throwing) return;
    const interaction = this.#options.interaction || {};
    const dt = snapshot.frame.stepMs / 1_000;
    const bounce = interaction.bounce ?? DEFAULT_BOUNCE;
    const halfWidth = snapshot.characterSize.width / 2;
    const halfHeight = snapshot.characterSize.height / 2;
    const floor =
      snapshot.world.viewport.height -
      halfHeight -
      (interaction.floorInset ?? DEFAULT_FLOOR_INSET);
    let velocityX = this.#throwVelocity.x;
    let velocityY =
      this.#throwVelocity.y + (interaction.gravity ?? DEFAULT_GRAVITY) * dt;
    let x = this.#position.x + velocityX * dt;
    let y = this.#position.y + velocityY * dt;
    const right = snapshot.world.viewport.width - halfWidth;
    if (x < halfWidth) {
      x = halfWidth;
      velocityX = Math.abs(velocityX) * bounce;
    } else if (x > right) {
      x = right;
      velocityX = -Math.abs(velocityX) * bounce;
    }
    if (y < halfHeight) {
      y = halfHeight;
      velocityY = Math.abs(velocityY) * bounce;
    }
    const next = { x, y };
    if (
      interaction.catchTarget &&
      this.#targets?.contains(
        interaction.catchTarget,
        next,
        interaction.catchMargin ?? 24,
      ) &&
      this.#catchCharacter(interaction.catchTarget)
    ) {
      return;
    }
    if (y >= floor) {
      this.#position = { x, y: floor };
      this.#landCharacter();
      return;
    }
    this.#position = next;
    this.#throwVelocity = { x: velocityX * 0.995, y: velocityY };
  }

  #calculatePresentation(
    snapshot: FrameSnapshot,
    evaluation: FrameEvaluation,
  ): FramePresentation {
    const { frame, characterSize, world } = snapshot;
    const { request } = evaluation;
    const loaded = frame.loaded.content;
    if (!this.#reducedMotion)
      this.#animationClock += Math.max(0, frame.elapsed);
    this.#advanceThrow(snapshot);
    const requested =
      request.capability === "locomotion" && request.motion
        ? loaded.directionalStates?.[
            directionTo(
              { x: 0, y: 0 },
              { x: request.motion.x, y: request.motion.y },
            )
          ]
        : resolveCapabilityName(request.state, loaded);
    const resolved = resolveState(requested, loaded.states);
    let lift = 0;
    if (request.motion?.direct) {
      const distance = request.motion.maxDistance ?? 0;
      this.#position = clampPosition(
        {
          x: this.#position.x + request.motion.x * distance,
          y: this.#position.y + request.motion.y * distance,
        },
        world.viewport,
        characterSize.width,
        characterSize.height,
      );
      lift = request.motion.lift ?? 0;
      this.#locomotionState = "";
      this.#locomotionElapsed = 0;
    } else if (request.motion) {
      if (this.#locomotionState !== resolved.name) {
        this.#locomotionState = resolved.name;
        this.#locomotionElapsed = 0;
      }
      const state = loaded.states[resolved.name]!;
      const cycle = animationCycleMs(state);
      const previousCycles = this.#locomotionElapsed / cycle;
      this.#locomotionElapsed += frame.stepMs;
      const nextCycles = this.#locomotionElapsed / cycle;
      const phaseDistance = nextCycles - previousCycles;
      const authoredDistance = locomotionAdvance(
        loaded.locomotionMotion,
        previousCycles,
        nextCycles,
      );
      const factor = phaseDistance > 0 ? authoredDistance / phaseDistance : 1;
      const requestedDistance =
        request.motion.speed * (frame.stepMs / 1000) * factor;
      const distance = Math.min(
        requestedDistance,
        request.motion.maxDistance ?? requestedDistance,
      );
      this.#position = clampPosition(
        {
          x: this.#position.x + request.motion.x * distance,
          y: this.#position.y + request.motion.y * distance,
        },
        world.viewport,
        characterSize.width,
        characterSize.height,
      );
      lift =
        request.motion.lift ??
        locomotionSample(loaded.locomotionMotion, nextCycles).lift *
          characterSize.height;
    } else {
      this.#locomotionState = "";
      this.#locomotionElapsed = 0;
    }
    return { state: resolved.name, lift };
  }

  #tick(now: number, force = false): void {
    const frame = this.#beginFrame(now, force);
    if (!frame || !this.#frameActive(frame)) return;
    const snapshot = this.#snapshotFrame(frame);
    if (!this.#frameActive(frame)) return;
    const evaluation = this.#evaluateFrame(snapshot);
    if (!this.#frameActive(frame)) return;
    if (!this.#emitFrameDiagnostics(frame, evaluation.diagnostics)) return;
    const presentation = this.#calculatePresentation(snapshot, evaluation);
    if (!this.#frameActive(frame)) return;
    this.#contentRenderer?.renderSurfaces(
      evaluation.request.surfaces ?? EMPTY_CONTENT_SELECTIONS,
      this.#content,
      this.#position,
      snapshot.world.viewport,
      snapshot.characterSize,
      this.#displayName,
    );
    if (!this.#frameActive(frame)) return;
    frame.renderer.render(
      presentation.state,
      this.#animationClock,
      this.#position,
      snapshot.devicePixelRatio,
      presentation.lift,
    );
    if (!this.#frameActive(frame)) return;
    this.#interactionController?.render(
      this.#position,
      snapshot.characterSize,
      presentation.lift,
    );
    if (!this.#frameActive(frame)) return;
    this.#lastTick = frame.now;
    this.#schedulePlan(frame);
    if (
      this.#frameActive(frame) &&
      (evaluation.request.motion ||
        frame.input.reaction ||
        this.#throwing ||
        this.#dragging)
    )
      this.#wake();
  }

  #endPage(): void {
    if (this.#destroyed) return;
    try {
      if (this.#input && this.#plan) {
        this.#drainPlanEvents(this.#now());
        this.#input.captureReaction(
          "page.lifecycle",
          { phase: "hide" },
          "browser",
        );
        this.#drainPlanEvents(this.#now());
      }
      this.#notice("lifecycle.pagehide", "info", "lifecycle");
    } finally {
      this.#destroy("pagehide");
    }
  }

  #drainPlanEvents(now: number): void {
    if (!this.#input || !this.#plan) return;
    let reaction = this.#input.reaction;
    while (reaction) {
      this.#plan.evaluate({
        now,
        position: this.#position,
        viewport: {
          width: this.#window.innerWidth,
          height: this.#window.innerHeight,
        },
        lastActivityAt: this.#input.lastActivityAt,
        reducedMotion: this.#reducedMotion,
        pageVisible: false,
        reaction,
      });
      this.#seenReaction = reaction.id;
      this.#input.consumeReaction(reaction.id);
      reaction = this.#input.reaction;
    }
  }
}

/** Create one independently owned companion instance. */
export function hatch(input: PeeklingHatchInput): PeeklingInstance {
  return PeeklingRuntime.hatch(input);
}

function hasLocomotion(pack: NormalizedPack): boolean {
  return NATIVE_DIRECTIONS.every((direction) =>
    Object.hasOwn(pack.directionalStates ?? {}, direction),
  );
}

export function resolveInitialPosition(
  position: NonNullable<PeeklingOptions["position"]>,
  width: number,
  height: number,
  spriteWidth: number,
  spriteHeight: number,
): Point {
  let point: Point;
  if (position === "center") point = { x: width / 2, y: height / 2 };
  else if (position === "bottom-right" || position === "bottom-left") {
    const margin = 16;
    point = {
      x:
        position === "bottom-right"
          ? width - spriteWidth / 2 - margin
          : spriteWidth / 2 + margin,
      y: height - spriteHeight / 2 - margin,
    };
  } else if (typeof position === "object") {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
      throw new TypeError(
        runtimeMessage(
          "position.coordinates",
          "position coordinates must be finite CSS pixels",
        ),
      );
    point = position;
  } else
    throw new TypeError(
      runtimeMessage(
        "position.value",
        "position must be a preset or a finite {x,y} point",
      ),
    );
  return clampPosition(point, { width, height }, spriteWidth, spriteHeight);
}

function clampPosition(
  point: Point,
  viewport: { width: number; height: number },
  width: number,
  height: number,
): Point {
  return {
    x: Math.max(width / 2, Math.min(viewport.width - width / 2, point.x)),
    y: Math.max(height / 2, Math.min(viewport.height - height / 2, point.y)),
  };
}

function characterTargetPoint(
  target: Readonly<TargetSnapshot>,
  anchor: TargetAnchor,
  character: Readonly<{ width: number; height: number }>,
): Point {
  const center = {
    x: target.left + target.width / 2,
    y: target.top + target.height / 2,
  };
  switch (anchor) {
    case "top":
      return { x: center.x, y: target.top - character.height / 2 };
    case "right":
      return { x: target.right + character.width / 2, y: center.y };
    case "bottom":
      return { x: center.x, y: target.bottom + character.height / 2 };
    case "left":
      return { x: target.left - character.width / 2, y: center.y };
    default:
      return center;
  }
}
