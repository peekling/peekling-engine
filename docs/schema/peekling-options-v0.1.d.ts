/**
 * Human-readable TypeScript reference for the JSON-safe Peekling v0.1 options.
 * The adjacent Draft 2020-12 JSON Schema is authoritative for serializable
 * shape and lexical constraints. Shared Preflight performs semantic URL
 * parsing that TypeScript and JSON Schema cannot express completely.
 * Numeric and collection bounds in JSDoc are inclusive unless stated otherwise.
 */

/** Lowercase, case-sensitive identifier. 1 through 64 characters. `peekling:` is reserved. */
export type Name = string;
/** Case-sensitive state identifier. 1 through 64 characters. */
export type StateName = string;
/** Semantic Versioning 2.0 value without a `v` prefix. */
export type SemVer = string;
/** SPDX identifier or SPDX LicenseRef form. Compound expressions are not accepted in v0.1. */
export type SpdxLicense = string;
export type Density = 1 | 2 | 4;
export type Direction = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/** Closed serializable options fields. */
export interface SerializablePeeklingOptionFields {
  /** Serializable contract version. Default `1`. Persisted configurations should include it. */
  format?: 1;
  /** Explicit registered character selection. JSON-safe. */
  character?: Name;
  /** Inline native manifest or stable normalized adapter IR. JSON-safe and data-only. */
  pack?: NativeManifest | NormalizedPack;
  /** Relative or absolute HTTPS manifest candidate. Semantic Preflight is required. */
  packUrl?: string;
  /** Byte-identical atlas mirror. Density is required when the Pack declares variants. */
  atlasUrl?: string;
  /** External runtime stylesheet candidate. Semantic Preflight is required. */
  styles?: RuntimeStyleAsset;
  /** Exact atlas density override. JSON-safe. */
  density?: Density;
  /** Highest atlas density the runtime may load. Default `4`. JSON-safe. */
  maxDensity?: Density;
  /** Logical sprite scale, integer 1 through 4. The validated pack default applies when omitted. */
  scale?: number;
  /** Initial viewport center. Default `bottom-right`. Coordinates are CSS pixels. JSON-safe. */
  position?: InitialPosition;
  /** Hidden by default. `true` uses the pack display name. A string is a host override. JSON-safe. */
  name?: boolean | PlainText80;
  /** Host-owned declarative behavior and content-selection plan. JSON-safe. */
  plan?: Plan;
  /** Named starting behavior compiled into the same canonical Plan. Mutually exclusive with plan. */
  preset?: PeeklingPreset;
  /** Host-approved target IDs mapped to bounded CSS selectors, at most 16 entries. */
  targets?: TargetRegistry;
  /** Character press, drag, throw, landing, and target-catch behavior. Enabled by default. */
  interaction?: false | CharacterInteractionOptions;
  /** Optional notification badge on the accessible character control. */
  indicator?: CharacterIndicator;
  /** Host-owned generic anchored content registry, at most 32 entries. JSON-safe registry references only. */
  content?: ContentRegistry;
  /** Bounded engine-owned surface theme tokens. JSON-safe. */
  theme?: SurfaceTheme;
  /** Opt-in accessible announcement and labeling policy. JSON-safe. */
  accessibility?: AccessibilityOptions;
  /** Serializable diagnostic policy. The logger callback is JavaScript-only. JSON-safe. */
  diagnostics?: DiagnosticOptions;
}

/** At least one Pack source is required. Multiple fields retain runtime precedence. */
export type PeeklingPackSelection =
  | { character: Name }
  | { pack: NativeManifest | NormalizedPack }
  | { packUrl: string };

/** Closed serializable options with at least one explicit Pack source. */
export type SerializablePeeklingOptions = SerializablePeeklingOptionFields &
  PeeklingPackSelection;

export interface RuntimeStyleAsset {
  /** Relative or absolute HTTPS candidate checked by semantic Preflight. */
  url: string;
  /** Optional release-provided SRI hash. */
  integrity?: string;
}

export type InitialPosition =
  "bottom-left" | "bottom-right" | "center" | PixelPoint;

export interface PixelPoint {
  /** CSS pixels, -100,000 through 100,000. */
  x: number;
  /** CSS pixels, -100,000 through 100,000. */
  y: number;
}

export interface Point {
  /** Normalized coordinate, 0 through 1. */
  x: number;
  /** Normalized coordinate, 0 through 1. */
  y: number;
}

export type PlanCapability = "locomotion";
export type PeeklingPreset =
  "companion" | "still" | "bottom-patrol" | "viewport-roam";
export type PlanEventSource = "browser" | "application";
export type PlanBrowserEvent =
  | "pointer.click"
  | "pointer.move"
  | "document.visibility"
  | "window.focus"
  | "window.scroll"
  | "section.visibility"
  | "page.lifecycle";
export type PlanChannel = "motion" | "state" | `surface:${string}`;
export type PlanDisposition = "update" | "replace" | "ignore" | "interrupt";
export type PlanEventCoalescing = "latest";
export type PlanInterruptLifetime =
  | { type: "duration"; ms: number }
  | {
      type: "event";
      /** Application Event or discrete browser Event. pointer.move and the unqualified section.visibility name are rejected. */
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
      /** enter and leave are queued edges. */
      phase: "enter" | "leave";
      /** Visibility ratio greater than 0 and at most 1. Defaults to 0.25. */
      threshold?: number;
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
      /** while-visible is sampled continuously. */
      phase: "while-visible";
      /** Visibility ratio greater than 0 and at most 1. Defaults to 0.25. */
      threshold?: number;
    };

export type PlanCondition = PlanDiscreteCondition | PlanContinuousCondition;

export type PlanStateSelection =
  { state: StateName } | { capability: PlanCapability };

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
  /** CSS pixels, -100,000 through 100,000. */
  x: number;
  /** CSS pixels, -100,000 through 100,000. */
  y: number;
  speed?: number;
  arrivalRadius?: number;
}

export type TargetAnchor = "center" | "top" | "right" | "bottom" | "left";

export interface MoveToTargetMotionEffect {
  type: "move-to-target";
  target: Name;
  anchor?: TargetAnchor;
  speed?: number;
  arrivalRadius?: number;
}

export interface JumpToMotionEffect {
  type: "jump-to";
  /** CSS pixels, -100,000 through 100,000. */
  x: number;
  /** CSS pixels, -100,000 through 100,000. */
  y: number;
  /** 100 through 10,000 milliseconds. */
  duration?: number;
  /** Arc height in CSS pixels, 0 through 2,000. */
  height?: number;
}

export interface SvgPathMotionEffect {
  type: "svg-path";
  /** SVG path data, 1 through 4,096 characters. It is sampled as data and never evaluated. */
  path: string;
  /** 100 through 60,000 milliseconds. */
  duration?: number;
  loop?: boolean;
  /** Default true. Relative paths begin at the character's current position. */
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

export type TargetRegistry = Record<Name, string>;

export type CharacterPressAction =
  "toggle-content" | "show-content" | "hide-content" | "emit" | "none";

export interface CharacterInteractionOptions {
  /** Defaults to toggle-content, or emit when pressEvent is present. */
  press?: CharacterPressAction;
  /** Application Event emitted when press resolves to emit. */
  pressEvent?: string;
  /** Default true. */
  drag?: boolean;
  /** Default true. */
  throw?: boolean;
  dragState?: StateName;
  riseState?: StateName;
  fallState?: StateName;
  landState?: StateName;
  /** CSS pixels per second squared, 0 through 10,000. */
  gravity?: number;
  /** CSS pixels per second, 0 through 10,000. */
  maxThrowSpeed?: number;
  /** Collision energy retained, 0 through 1. */
  bounce?: number;
  /** Floor inset in CSS pixels, 0 through 1,000. */
  floorInset?: number;
  label?: PlainText120;
  contentInitiallyHidden?: boolean;
  clearIndicatorOnPress?: boolean;
  catchTarget?: Name;
  catchAnchor?: TargetAnchor;
  /** Catch margin in CSS pixels, 0 through 1,000. */
  catchMargin?: number;
  catchEvent?: string;
}

export interface CharacterIndicator {
  /** Default dot. */
  kind?: "dot" | "count";
  /** Integer 0 through 999. The rendered badge caps visible text at 99. */
  count?: number;
  label: PlainText120;
  /** Optional badge color using the closed Peekling color grammar. */
  color?: ColorToken;
  /** Default true. */
  visible?: boolean;
}

export interface PlanSurfaceOrdering {
  sessionField: string;
  revisionField?: string;
  terminal?: boolean;
}

export interface PlanSurfaceEffect {
  id: Name;
  contentId: Name;
  data?: JsonValue | "event-payload";
  disposition?: PlanDisposition;
  ordering?: PlanSurfaceOrdering;
}

export interface PlanEffect {
  channels: PlanChannel[];
  state?: PlanStateSelection;
  motion?: PlanMotionEffect;
  surfaces?: PlanSurfaceEffect[];
  until?: PlanInterruptLifetime;
}

interface PlanContinuousEffect {
  channels: PlanChannel[];
  state?: PlanStateSelection;
  motion?: PlanMotionEffect;
  surfaces?: never;
  until?: never;
}

export interface PlanBaselineSurfaceEffect {
  id: Name;
  contentId: Name;
  /** Static JSON data. The Event payload marker is available only to Rule Effects. */
  data?: JsonValue;
  disposition?: Exclude<PlanDisposition, "interrupt">;
  ordering?: never;
}

export interface PlanBaselineEffect {
  channels: PlanChannel[];
  state: PlanStateSelection;
  motion?: PlanMotionEffect;
  surfaces?: PlanBaselineSurfaceEffect[];
  until?: never;
}

interface PlanRuleFields {
  id: Name;
  when: PlanCondition;
  effect: PlanEffect;
}

export type PlanRule =
  | {
      id: Name;
      when: PlanDiscreteCondition;
      effect: PlanEffect;
    }
  | {
      id: Name;
      when: PlanContinuousCondition;
      effect: PlanContinuousEffect;
    };

export interface Plan {
  baseline: PlanBaselineEffect;
  rules?: PlanRule[];
}

export type ContentRegion = "top-left" | "top-center" | "top-right" | "bottom";
export type ContentRegistry = Record<Name, ContentItem>;
type ContentRegionMap = Partial<Record<ContentRegion, ContentPrimitive>>;
export type ContentItem = ContentRegionMap &
  {
    [Region in ContentRegion]: Record<Region, ContentPrimitive>;
  }[ContentRegion];
export type ContentPrimitive = PlainText500 | ContentSurface;

export interface ContentSurfaceFields {
  /** Plain title, 1 through 120 characters. */
  title?: PlainText120;
  /** Plain body text, 1 through 500 characters. */
  text?: PlainText500;
  /** Engine-owned safe anchor. */
  link?: ContentLink;
  /** Property-only host mount registry reference. */
  mountId?: Name;
  /** Opt into polite live-region announcements. Default `false`. */
  announce?: boolean;
}

/** At least one safe payload or registry reference is required. */
export type ContentSurface = ContentSurfaceFields &
  (
    | { title: PlainText120 }
    | { text: PlainText500 }
    | { link: ContentLink }
    | { mountId: Name }
  );

export interface ContentLink {
  /** Accessible link label, 1 through 120 characters. */
  label: PlainText120;
  /** Relative or absolute HTTPS candidate checked by semantic Preflight. */
  href: string;
}

export type ColorToken = "transparent" | `#${string}`;

export interface SurfaceTheme {
  /** Lowercase `transparent` or a 3, 4, 6, or 8 digit hex color. */
  background?: ColorToken;
  color?: ColorToken;
  linkColor?: ColorToken;
  borderColor?: ColorToken;
  /** CSS pixels, 0 through 64. Default `14`. */
  radius?: number;
  /** CSS pixels, 120 through 640. Default `320`. */
  width?: number;
  /** CSS pixels, 0 through 48. Default `12`. */
  padding?: number;
}

export interface AccessibilityOptions {
  /** Opt into content announcements. Default `false`. */
  announceContent?: boolean;
  /** Accessible surface group label, 1 through 120 characters. Default `Peekling content`. */
  contentLabel?: PlainText120;
}

export interface DiagnosticOptions {
  /** Console policy when no host sink exists. Omit for errors only, use `true` for all records, or `false` for none. */
  console?: boolean;
  /** Include bounded error causes and stacks. Default `false`, intended for development only. */
  debug?: boolean;
  /** Up to 16 bounded scalar host correlation or variant fields. */
  context?: Record<string, string | number | boolean>;
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface NativeManifest {
  format: 1;
  name: Name;
  version: SemVer;
  license: SpdxLicense;
  metadata: PackMetadata;
  assets: { atlas: NativeAtlas } | { atlases: AdaptiveAtlases };
  states: StateRegistry;
  capabilities?: { locomotion?: LocomotionCapability };
  defaults?: { /** Integer 1 through 4. Default `2`. */ scale?: number };
}

export interface PackMetadata {
  title?: PlainText120;
  author?: PlainText120;
  description: PlainText500;
  /** Up to 16 unique bounded names. */
  tags?: Name[];
}

export interface NativeAtlas {
  src: AssetPath;
  sha256: Sha256;
  columns: 16;
  /** 1 through 4,096. */
  rows: number;
  /** Default `1`. */
  density?: Density;
  /** Default `32`. */
  logicalCellSize?: 32 | 64;
  /** 32 through 256. */
  sourceCellSize?: number;
}

export interface AdaptiveAtlases {
  columns: 16;
  /** 1 through 4,096. */
  rows: number;
  logicalCellSize: 32 | 64;
  lineage: string;
  /** 1 through 3 variants. */
  variants: AtlasVariant[];
}

export interface AtlasVariant {
  src: AssetPath;
  density: Density;
  /** 32 through 256. */
  sourceCellSize: number;
  sha256: Sha256;
}

export interface NormalizedPack {
  /** Stable adapter IR identifier. This type is not a pack authoring format. */
  name: Name;
  displayName: PlainText120;
  version: SemVer;
  license: SpdxLicense;
  atlas: NormalizedAtlas;
  states: StateRegistry;
  /** Integer 1 through 4. */
  defaultScale: number;
  directionalStates?: Partial<Record<Direction, StateName>>;
  locomotionMotion?: LocomotionKeyframe[];
  reactionStates?: Record<Name, StateName>;
  /** Opaque bounded JSON provenance. The engine never interprets it. */
  source?: { [key: string]: JsonValue };
}

export interface NormalizedAtlas {
  src: AssetPath;
  /** Required when variants are omitted. */
  sha256?: Sha256;
  /** 1 through 256. */
  columns: number;
  /** 1 through 4,096. */
  rows: number;
  /** Source pixels, 1 through 1,024. */
  cellWidth: number;
  cellHeight: number;
  /** Logical pixels, 1 through 256. */
  logicalWidth?: number;
  logicalHeight?: number;
  density?: Density;
  lineage?: string;
  /** 1 through 3 variants. */
  variants?: NormalizedAtlasVariant[];
}

export interface NormalizedAtlasVariant {
  src: AssetPath;
  density: Density;
  /** Source pixels, 1 through 1,024. */
  cellWidth: number;
  cellHeight: number;
  sha256: Sha256;
}

export type StateRegistry = Record<StateName, StateDefinition>;

interface StateDefinitionBase {
  /** Atlas frame indexes, 1 through 64 values, each 0 through 65,535. */
  frames: number[];
  loop: boolean;
}

export type StateDefinition =
  | (StateDefinitionBase & {
      /** Frames per second, 0.1 through 60. */
      fps: number;
      durations?: never;
    })
  | (StateDefinitionBase & {
      fps?: never;
      /** Exactly one value per frame, 16 through 10,000 ms each, at most 60,000 ms total. */
      durations: number[];
    });

export interface LocomotionCapability {
  directions: Record<Direction, StateName>;
  motion?: { keyframes: LocomotionKeyframe[] };
}

export interface LocomotionKeyframe {
  /** Normalized cycle position, 0 through 1. */
  at: number;
  /** Monotonic cell-relative advance, 0 through 1. */
  advance: number;
  /** Cell-relative lift, 0 through 0.5. */
  lift: number;
}

/** Relative in-pack path, 1 through 256 safe characters. No schemes, traversal, query, fragment, or backslash. */
export type AssetPath = string;
/** Exactly 64 lowercase hexadecimal characters. */
export type Sha256 = string;
export type PlainText80 = string;
export type PlainText120 = string;
export type PlainText500 = string;
