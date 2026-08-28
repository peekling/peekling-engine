/**
 * JavaScript-only Peekling v0.1 extension surface.
 * Functions and DOM values are host configuration. They never belong in Packs,
 * attributes, or the serializable options schema.
 * Record input uses this realm's ordinary Object prototype or a null prototype.
 * Custom prototypes and ordinary objects from another realm are rejected.
 */

import type {
  AccessibilityOptions,
  ContentItem,
  ContentRegion,
  DiagnosticOptions,
  JsonValue,
  PeeklingPackSelection,
  PlanEffect,
  SerializablePeeklingOptionFields,
  SerializablePeeklingOptions,
  SurfaceTheme,
} from "./peekling-options-v0.1";

export interface EmitResult {
  accepted: boolean;
  id?: number;
  coalesced?: boolean;
  reason?:
    | "invalid-name"
    | "invalid-payload"
    | "queue-full"
    | "hidden"
    | "destroyed"
    | "not-ready";
}

export interface HostSurfaceMountContext {
  surfaceId: string;
  contentId: string;
  region: ContentRegion;
  /** Empty engine-owned mount point. Append only nodes created for this mount. */
  root: HTMLElement;
  /** Immutable bounded data selected by the Plan Rule or Override. */
  data?: JsonValue;
  /** Aborted before cleanup when the surface loses ownership. */
  signal: AbortSignal;
  /** Typed Event ingress. It does not execute a Rule inline. */
  emit(name: string, payload?: unknown): EmitResult;
}

export interface HostSurfaceMountResult {
  /** Optional own data update function. Accessor properties are rejected. */
  update?(data: JsonValue | undefined): void | PromiseLike<void>;
  /** Required own data teardown function. Accessor properties are rejected. */
  cleanup(): void | PromiseLike<void>;
}

export type HostSurfaceMount = (
  context: Readonly<HostSurfaceMountContext>,
) => HostSurfaceMountResult | PromiseLike<HostSurfaceMountResult>;

export interface HostBindings {
  mounts?: Readonly<Record<string, HostSurfaceMount>>;
}

export interface DiagnosticRecord {
  code: string;
  severity: "debug" | "info" | "warning" | "error";
  message: string;
  phase:
    | "config"
    | "event"
    | "override"
    | "trigger"
    | "render"
    | "lifecycle"
    | "internal";
  sequence: number;
  timestamp: number;
  instanceId: string;
  overrideId?: string;
  eventId?: number;
  metadata?: Readonly<Record<string, string | number | boolean>>;
  context?: Readonly<Record<string, string | number | boolean>>;
  cause?: { name: string; message: string; stack?: string };
}

/** JavaScript configuration fields before hatch enforces a Pack selection. */
export type JavaScriptPeeklingOptionFields =
  SerializablePeeklingOptionFields & {
    /** Property-only mount registry for content entries that select mountId. */
    bindings?: HostBindings;
    /** Vendor-neutral in-process sink. Peekling never transmits records. */
    logger?: (record: Readonly<DiagnosticRecord>) => void;
    /** Bounded string diagnostic observer. */
    onDiagnostic?: (message: string) => void;
    /** Injected browser objects for controlled environments and tests. */
    document?: Document;
    window?: Window;
    diagnostics?: DiagnosticOptions;
  };

/** JavaScript hatch options with at least one explicit Pack source. */
export type JavaScriptPeeklingOptions = JavaScriptPeeklingOptionFields &
  PeeklingPackSelection;

export type OverrideLifetime =
  | { type: "duration"; ms: number }
  | { type: "event"; name: string; timeout?: number }
  | { type: "manual"; maxMs?: number };

export interface OverrideInput {
  effect: PlanEffect;
  until?: OverrideLifetime;
  /** Overlap rejects by default. Replace releases only conflicting channels. */
  mode?: "reject" | "replace";
}

export type OverrideCompletionReason =
  | "event"
  | "timeout"
  | "cancelled"
  | "replaced"
  | "rejected"
  | "conflict"
  | "overflow"
  | "dismissed"
  | "destroyed";

export interface OverrideHandle {
  id: string;
  readonly status: "active" | "finished" | "rejected";
  finished: Promise<{ id: string; reason: OverrideCompletionReason }>;
  cancel(): void;
}

export type PeeklingFinishReason = "destroyed" | "pagehide" | "failed";

export interface PeeklingFinishResult {
  reason: PeeklingFinishReason;
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
  destroy(): void;
}

/** One-engine Web Component facade. Object values and callbacks are property-only. */
export interface PeeklingElement extends HTMLElement {
  /** Full property configuration. Attributes may provide the Pack selection. */
  options: JavaScriptPeeklingOptionFields;
  plan?: SerializablePeeklingOptions["plan"];
  content?: Readonly<Record<string, ContentItem>>;
  bindings?: HostBindings;
  theme?: SurfaceTheme;
  /** External stylesheet asset. Markup mirrors it with styles-url and styles-integrity. */
  styles?: SerializablePeeklingOptions["styles"];
  accessibility?: AccessibilityOptions;
  diagnostics?: DiagnosticOptions;
  /** Property-only vendor-neutral structured diagnostic sink. */
  logger?: (record: Readonly<DiagnosticRecord>) => void;
  readonly instance?: PeeklingInstance;
  readonly ready: Promise<PeeklingInstance>;
  emit(name: string, payload?: unknown): EmitResult;
  override(value: OverrideInput): OverrideHandle;
  pause(): void;
  resume(): void;
}

export declare function hatch(
  input: string | JavaScriptPeeklingOptions,
): PeeklingInstance;

export declare const PEEKLING_ELEMENT_TAG: "peekling-character";

/**
 * Explicit ESM registration. Importing the ESM root does not call it.
 * A foreign registration is preserved and reported through peekling:collision.
 */
export declare function definePeeklingElement(): void;

export type PeeklingHideDuration =
  "10-minutes" | "1-hour" | "until-tomorrow" | "session" | "forever";

/** Hide every Peekling in one document according to the site-local preference. */
export declare function hidePeekling(
  duration: PeeklingHideDuration,
  document?: Document,
  window?: Window,
): void;

/** Clear the site-local preference and show every Peekling in one document. */
export declare function showPeekling(
  document?: Document,
  window?: Window,
): void;

/** Read the effective site-local visibility preference. */
export declare function isPeeklingHidden(window?: Window): boolean;

export interface PeeklingBrowserGlobal {
  readonly hatch: typeof hatch;
  readonly visibility: {
    hide(duration: PeeklingHideDuration): void;
    show(): void;
    isHidden(): boolean;
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "peekling-character": PeeklingElement;
  }
  interface WindowEventMap {
    "peekling:collision": CustomEvent<"Peekling" | "peekling-character">;
  }
}
