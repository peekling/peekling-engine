export const NATIVE_CELL_SIZE = 32;
export const NATIVE_LOGICAL_SIZES = [32, 64] as const;
export type NativeLogicalSize = (typeof NATIVE_LOGICAL_SIZES)[number];
export const NATIVE_COLUMNS = 16;
export const NATIVE_DENSITIES = [1, 2, 4] as const;
export type NativeDensity = (typeof NATIVE_DENSITIES)[number];
export const NATIVE_DIRECTIONS = [
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
] as const;

export type Direction = (typeof NATIVE_DIRECTIONS)[number];

interface StateDefinitionBase {
  frames: number[];
  loop: boolean;
}

export type StateDefinition =
  | (StateDefinitionBase & { fps: number; durations?: never })
  | (StateDefinitionBase & { durations: number[]; fps?: never });

export interface NativeManifest {
  format: 1;
  name: string;
  version: string;
  license: string;
  metadata: {
    title?: string;
    author?: string;
    description: string;
    tags?: string[];
  };
  assets:
    | {
        atlas: {
          src: string;
          sha256: string;
          columns: 16;
          rows: number;
          density?: NativeDensity;
          logicalCellSize?: NativeLogicalSize;
          sourceCellSize?: number;
        };
      }
    | {
        atlases: {
          columns: 16;
          rows: number;
          logicalCellSize: NativeLogicalSize;
          lineage: string;
          variants: Array<{
            src: string;
            density: NativeDensity;
            sourceCellSize: number;
            sha256: string;
          }>;
        };
      };
  states: Record<string, StateDefinition>;
  capabilities?: {
    locomotion?: LocomotionCapability;
  };
  defaults?: {
    scale?: number;
  };
}

export interface LocomotionKeyframe {
  at: number;
  advance: number;
  lift: number;
}

export interface LocomotionCapability {
  directions: Record<Direction, string>;
  motion?: {
    keyframes: LocomotionKeyframe[];
  };
}

export interface AtlasGeometry {
  width: number;
  height: number;
  byteLength?: number;
}

/**
 * Stable, serializable adapter IR. This is an adapter output contract, not a
 * character authoring format. Validation is mandatory at the runtime boundary.
 */
export interface NormalizedPack {
  name: string;
  displayName: string;
  version: string;
  license: string;
  atlas: {
    src: string;
    sha256?: string;
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    logicalWidth?: number;
    logicalHeight?: number;
    density?: NativeDensity;
    lineage?: string;
    variants?: ReadonlyArray<{
      src: string;
      density: NativeDensity;
      cellWidth: number;
      cellHeight: number;
      sha256: string;
    }>;
  };
  states: Record<string, StateDefinition>;
  defaultScale: number;
  directionalStates?: Partial<Record<Direction, string>>;
  locomotionMotion?: ReadonlyArray<Readonly<LocomotionKeyframe>>;
  reactionStates?: Readonly<Record<string, string>>;
  /** Opaque JSON provenance. The engine never interprets this field. */
  source?: Readonly<Record<string, JsonValue>>;
}

export interface Point {
  x: number;
  y: number;
}

export const PLAN_BROWSER_EVENTS = [
  "pointer.click",
  "pointer.move",
  "document.visibility",
  "window.focus",
  "window.scroll",
  "section.visibility",
  "page.lifecycle",
] as const;
export type PlanBrowserEvent = (typeof PLAN_BROWSER_EVENTS)[number];
export type PlanEventSource = "browser" | "application";
export type PlanDisposition = "update" | "replace" | "ignore" | "interrupt";
export type PlanCapability = "locomotion";
export type PlanChannel = "motion" | "state" | `surface:${string}`;

export type PlanEventCoalescing = "latest";
export type PeeklingPreset =
  "companion" | "still" | "bottom-patrol" | "viewport-roam";

export type PlanInterruptLifetime =
  | { type: "duration"; ms: number }
  | {
      type: "event";
      /** Application Event or discrete browser Event. Continuous observations are rejected. */
      name: string;
      timeout?: number;
    };

type PlanDiscreteCondition =
  | {
      source: "application";
      event: string;
      coalesce?: PlanEventCoalescing;
    }
  | {
      source: "browser";
      event: Exclude<
        PlanBrowserEvent,
        "pointer.move" | "section.visibility" | "window.scroll"
      >;
      coalesce?: never;
    }
  | {
      source: "browser";
      event: "window.scroll";
      coalesce?: PlanEventCoalescing;
    }
  | {
      source: "browser";
      event: "section.visibility";
      selector: string;
      phase: "enter" | "leave";
      threshold?: number;
      coalesce?: never;
    };

type PlanContinuousCondition =
  | {
      source: "browser";
      event: "pointer.move";
      coalesce?: never;
    }
  | {
      source: "browser";
      event: "section.visibility";
      selector: string;
      phase: "while-visible";
      threshold?: number;
      coalesce?: never;
    };

export type PlanCondition = PlanDiscreteCondition | PlanContinuousCondition;

export type PlanStateSelection =
  { state: string } | { capability: PlanCapability };

export interface FollowPointerMotionEffect {
  type: "follow-pointer";
  speed?: number;
  arrivalRadius?: number;
}

export interface HorizontalPatrolMotionEffect {
  type: "horizontal-patrol";
  speed?: number;
  edgeInset?: number;
}

export interface ViewportTraverseMotionEffect {
  type: "viewport-traverse";
  speed?: number;
  edgeInset?: number;
  clockwise?: boolean;
}

export interface MoveToMotionEffect {
  type: "move-to";
  x: number;
  y: number;
  speed?: number;
  arrivalRadius?: number;
}

export type TargetAnchor = "center" | "top" | "right" | "bottom" | "left";

export interface MoveToTargetMotionEffect {
  type: "move-to-target";
  target: string;
  anchor?: TargetAnchor;
  speed?: number;
  arrivalRadius?: number;
}

export interface JumpToMotionEffect {
  type: "jump-to";
  x: number;
  y: number;
  duration?: number;
  height?: number;
}

export interface SvgPathMotionEffect {
  type: "svg-path";
  /** SVG path data sampled by the browser. It is data and is never evaluated. */
  path: string;
  duration?: number;
  loop?: boolean;
  relative?: boolean;
}

export type PlanMotionEffect =
  | FollowPointerMotionEffect
  | HorizontalPatrolMotionEffect
  | ViewportTraverseMotionEffect
  | MoveToMotionEffect
  | MoveToTargetMotionEffect
  | JumpToMotionEffect
  | SvgPathMotionEffect;

export interface PlanSurfaceOrdering {
  sessionField: string;
  revisionField?: string;
  terminal?: boolean;
}

export interface PlanSurfaceEffect {
  id: string;
  contentId: string;
  data?: JsonValue | "event-payload";
  disposition?: PlanDisposition;
  ordering?: PlanSurfaceOrdering;
}

export interface PlanEffect {
  channels: readonly PlanChannel[];
  state?: PlanStateSelection;
  motion?: PlanMotionEffect;
  surfaces?: readonly PlanSurfaceEffect[];
  /** Required bounded ending behavior for a declarative interrupt Effect. */
  until?: PlanInterruptLifetime;
}

interface PlanContinuousEffect {
  channels: readonly PlanChannel[];
  state?: PlanStateSelection;
  motion?: PlanMotionEffect;
  surfaces?: never;
  until?: never;
}

export interface PlanBaselineSurfaceEffect {
  id: string;
  contentId: string;
  data?: JsonValue;
  disposition?: Exclude<PlanDisposition, "interrupt">;
  ordering?: never;
}

export interface PlanBaselineEffect {
  channels: readonly PlanChannel[];
  state: PlanStateSelection;
  motion?: PlanMotionEffect;
  surfaces?: readonly PlanBaselineSurfaceEffect[];
  until?: never;
}

export type PlanRule =
  | {
      id: string;
      when: PlanDiscreteCondition;
      effect: PlanEffect;
    }
  | {
      id: string;
      when: PlanContinuousCondition;
      effect: PlanContinuousEffect;
    };

/** Canonical 0.1 Plan input compiled by the bounded runtime compiler. */
export interface Plan {
  baseline: PlanBaselineEffect;
  rules?: readonly PlanRule[];
}

export const CONTENT_REGIONS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom",
] as const;
export type ContentRegion = (typeof CONTENT_REGIONS)[number];

export interface HostSurfaceMountContext {
  surfaceId: string;
  contentId: string;
  region: ContentRegion;
  root: HTMLElement;
  data?: JsonValue;
  signal: AbortSignal;
  emit(name: string, payload?: unknown): EmitResult;
}

export interface HostSurfaceMountResult {
  /** Optional own data function. Accessor properties are rejected. */
  update?(data: JsonValue | undefined): void | PromiseLike<void>;
  /** Required own data function. Accessor properties are rejected. */
  cleanup(): void | PromiseLike<void>;
}

export type HostSurfaceMount = (
  context: Readonly<HostSurfaceMountContext>,
) => HostSurfaceMountResult | PromiseLike<HostSurfaceMountResult>;

export interface HostContentSurfaceFields {
  title?: string;
  text?: string;
  /** Safe label with a semantically validated relative or HTTPS destination. */
  link?: { label: string; href: string };
  mountId?: string;
  announce?: boolean;
}

export type HostContentSurface = HostContentSurfaceFields &
  (
    | { title: string }
    | { text: string }
    | { link: { label: string; href: string } }
    | { mountId: string }
  );

export interface HostBindings {
  mounts?: Readonly<Record<string, HostSurfaceMount>>;
}

export interface SurfaceTheme {
  /** Lowercase `transparent` or a 3, 4, 6, or 8 digit hex color. */
  background?: "transparent" | `#${string}`;
  color?: "transparent" | `#${string}`;
  linkColor?: "transparent" | `#${string}`;
  borderColor?: "transparent" | `#${string}`;
  radius?: number;
  width?: number;
  padding?: number;
}

export type DiagnosticSeverity = "debug" | "info" | "warning" | "error";

export interface DiagnosticRecord {
  code: string;
  severity: DiagnosticSeverity;
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

export type OverrideLifetime =
  | { type: "duration"; ms: number }
  | { type: "event"; name: string; timeout?: number }
  | { type: "manual"; maxMs?: number };

export interface OverrideInput {
  effect: PlanEffect;
  until?: OverrideLifetime;
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

export type OverrideStatus = "active" | "finished" | "rejected";

export interface OverrideResult {
  id: string;
  reason: OverrideCompletionReason;
}

export interface OverrideHandle {
  id: string;
  readonly status: OverrideStatus;
  finished: Promise<OverrideResult>;
  cancel(): void;
}

export type HostContentPrimitive = string | HostContentSurface;
type HostContentRegionMap = Readonly<
  Partial<Record<ContentRegion, HostContentPrimitive>>
>;
export type HostContentItem = HostContentRegionMap &
  {
    [Region in ContentRegion]: Readonly<Record<Region, HostContentPrimitive>>;
  }[ContentRegion];
export type HostContent = Readonly<Record<string, HostContentItem>>;

export interface SectionSnapshot {
  ratio: number;
  previousRatio: number;
}

export interface ReactionEvent {
  id: number;
  source: PlanEventSource;
  name: string;
  at: number;
  payload?: JsonValue;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface World {
  now: number;
  pointer?: Point;
  position: Point;
  viewport: { width: number; height: number };
  characterSize?: { width: number; height: number };
  lastActivityAt: number;
  reaction?: ReactionEvent;
  reducedMotion: boolean;
  pageVisible?: boolean;
  sections?: Readonly<Record<string, SectionSnapshot>>;
  targets?: Readonly<Record<string, TargetSnapshot>>;
  samplePath?: (path: string, progress: number) => Point | undefined;
}

export interface TargetSnapshot {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface MotionRequest {
  x: number;
  y: number;
  speed: number;
  maxDistance?: number;
  lift?: number;
  direct?: boolean;
  trackTarget?: boolean;
}

export interface BehaviorRequest {
  state?: string;
  capability?: PlanCapability;
  motion?: MotionRequest;
  lock?: number;
  reactionId?: number;
  contentId?: string;
  content?: HostContentItem;
  contentKey?: string;
  contentData?: JsonValue;
  surfaces?: readonly SurfacePresentation[];
}

export interface SurfacePresentation {
  id: string;
  channel: `surface:${string}`;
  contentId: string;
  data?: JsonValue;
  key: string;
}

export interface ResolvedState {
  name: string;
}
