import type {
  DiagnosticRecord as RuntimeDiagnosticRecord,
  EmitResult as RuntimeEmitResult,
  HostContentItem,
  HostContent,
  HostBindings as RuntimeHostBindings,
  HostContentSurface,
  HostSurfaceMountResult,
  OverrideInput,
  OverrideHandle as RuntimeOverrideHandle,
  Plan as RuntimePlan,
  SurfaceTheme,
} from "../packages/runtime/src/types.js";
import type {
  PeeklingHatchInput,
  PeeklingInstance as RuntimePeeklingInstance,
  PeeklingOptions,
} from "../packages/runtime/src/runtime.js";
import {
  hidePeekling as runtimeHidePeekling,
  isPeeklingHidden as runtimeIsPeeklingHidden,
  showPeekling as runtimeShowPeekling,
} from "../packages/runtime/src/visibility.js";
import type {
  ContentItem,
  ContentSurface,
  Plan as SerializablePlan,
  SerializablePeeklingOptions,
} from "../docs/schema/peekling-options-v0.1.js";
import {
  hidePeekling as referenceHidePeekling,
  isPeeklingHidden as referenceIsPeeklingHidden,
  showPeekling as referenceShowPeekling,
  type JavaScriptPeeklingOptions,
  type PeeklingElement as ReferencePeeklingElement,
  type PeeklingHideDuration as ReferencePeeklingHideDuration,
} from "../docs/schema/peekling-javascript-extensions-v0.1.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

// Importing both Web Component declaration files would merge their ambient DOM
// maps. Mirror the runtime interface here so the standalone reference can still
// prove exact property-name parity without changing either global declaration.
interface RuntimeElementContract extends HTMLElement {
  options: PeeklingOptions;
  plan?: RuntimePlan;
  content?: HostContent;
  bindings?: RuntimeHostBindings;
  theme?: SurfaceTheme;
  styles?: PeeklingOptions["styles"];
  accessibility?: PeeklingOptions["accessibility"];
  diagnostics?: PeeklingOptions["diagnostics"];
  logger?: (record: Readonly<RuntimeDiagnosticRecord>) => void;
  readonly instance?: RuntimePeeklingInstance;
  readonly ready: Promise<RuntimePeeklingInstance>;
  emit(name: string, payload?: unknown): RuntimeEmitResult;
  override(value: OverrideInput): RuntimeOverrideHandle;
  pause(): void;
  resume(): void;
}

type RuntimeElementProperties = Exclude<
  keyof RuntimeElementContract,
  keyof HTMLElement
>;
type ReferenceElementProperties = Exclude<
  keyof ReferencePeeklingElement,
  keyof HTMLElement
>;
type ElementPropertyParity = Assert<
  Equal<RuntimeElementProperties, ReferenceElementProperties>
>;
type HideDurationParity = Assert<
  Equal<
    Parameters<typeof runtimeHidePeekling>[0],
    ReferencePeeklingHideDuration
  >
>;
type HideSignatureParity = Assert<
  Equal<typeof runtimeHidePeekling, typeof referenceHidePeekling>
>;
type ShowSignatureParity = Assert<
  Equal<typeof runtimeShowPeekling, typeof referenceShowPeekling>
>;
type HiddenSignatureParity = Assert<
  Equal<typeof runtimeIsPeeklingHidden, typeof referenceIsPeeklingHidden>
>;

// @ts-expect-error Every JavaScript mount selects a character, pack, or pack URL.
const missingPackSelection: JavaScriptPeeklingOptions = {};
const namedPackSelection: JavaScriptPeeklingOptions = { character: "peek" };
const attributeSelectedElementOptions: ReferencePeeklingElement["options"] = {
  diagnostics: { console: false },
};
// @ts-expect-error Serializable options enforce the Schema Pack selection.
const missingSerializablePackSelection: SerializablePeeklingOptions = {};
// @ts-expect-error A supplied hatch object must select a Pack source.
const missingRuntimePackSelection: PeeklingHatchInput = {};

// @ts-expect-error A content item must own at least one anchored region.
const emptySerializableItem: ContentItem = {};
// @ts-expect-error A serialized surface must contain safe text, a link, or a mount ID.
const emptySerializableSurface: ContentSurface = {};

// @ts-expect-error The JavaScript API also requires a non-empty content item.
const emptyRuntimeItem: HostContentItem = {};
// @ts-expect-error The JavaScript API also requires a non-empty content surface.
const emptyRuntimeSurface: HostContentSurface = {};
// @ts-expect-error Every admitted host mount must provide cleanup.
const mountWithoutCleanup: HostSurfaceMountResult = {};
const queuedOverride: OverrideInput = {
  effect: { channels: ["state"], state: { state: "idle" } },
  // @ts-expect-error Overlap policy is reject or replace, never a queue.
  mode: "queue",
};
const validTheme: SurfaceTheme = {
  background: "transparent",
  color: "#f0f",
  linkColor: "#1234",
  borderColor: "#12345678",
};
const invalidTheme: SurfaceTheme = {
  // @ts-expect-error Theme colors cannot be CSS functions or resource values.
  background: 'image-set("https://theme-probe.test/pixel.png" 1x)',
};

const runtimeBaselineInterrupt: RuntimePlan = {
  baseline: {
    channels: ["state"],
    state: { state: "idle" },
    // @ts-expect-error Baseline Effects cannot own an interrupt lifetime.
    until: { type: "duration", ms: 100 },
  },
};
const runtimeBaselineWithoutState: RuntimePlan = {
  // @ts-expect-error A runtime Plan baseline must select its state.
  baseline: { channels: ["state"] },
};
const runtimeBaselineOrdering: RuntimePlan = {
  baseline: {
    channels: ["state", "surface:status"],
    state: { state: "idle" },
    surfaces: [
      {
        id: "status",
        contentId: "status",
        // @ts-expect-error Baseline surfaces cannot order Event payload revisions.
        ordering: { sessionField: "session", revisionField: "revision" },
      },
    ],
  },
};
const serializableBaselineInterrupt: SerializablePlan = {
  baseline: {
    channels: ["state"],
    state: { state: "idle" },
    // @ts-expect-error The serialized baseline cannot own an interrupt lifetime.
    until: { type: "duration", ms: 100 },
  },
};
const serializableBaselineWithoutState: SerializablePlan = {
  // @ts-expect-error A serialized Plan baseline must select its state.
  baseline: { channels: ["state"] },
};
const serializableBaselineOrdering: SerializablePlan = {
  baseline: {
    channels: ["state", "surface:status"],
    state: { state: "idle" },
    surfaces: [
      {
        id: "status",
        contentId: "status",
        // @ts-expect-error Serialized baseline surfaces cannot order Event revisions.
        ordering: { sessionField: "session", revisionField: "revision" },
      },
    ],
  },
};
const runtimeContinuousSurface: RuntimePlan = {
  baseline: { channels: ["state"], state: { state: "idle" } },
  rules: [
    // @ts-expect-error Continuous pointer Rules cannot own surfaces.
    {
      id: "pointer-status",
      when: { source: "browser", event: "pointer.move" },
      effect: {
        channels: ["surface:status"],
        surfaces: [{ id: "status", contentId: "status" }],
      },
    },
  ],
};
const serializableContinuousLifetime: SerializablePlan = {
  baseline: { channels: ["state"], state: { state: "idle" } },
  rules: [
    // @ts-expect-error Continuous visibility Rules cannot own lifetimes.
    {
      id: "visible-state",
      when: {
        source: "browser",
        event: "section.visibility",
        selector: "#main",
        phase: "while-visible",
      },
      effect: {
        channels: ["state"],
        state: { state: "happy" },
        until: { type: "duration", ms: 100 },
      },
    },
  ],
};

void [
  emptySerializableItem,
  emptySerializableSurface,
  emptyRuntimeItem,
  emptyRuntimeSurface,
  mountWithoutCleanup,
  queuedOverride,
  validTheme,
  invalidTheme,
  runtimeBaselineInterrupt,
  runtimeBaselineWithoutState,
  runtimeBaselineOrdering,
  serializableBaselineInterrupt,
  serializableBaselineWithoutState,
  serializableBaselineOrdering,
  runtimeContinuousSurface,
  serializableContinuousLifetime,
  missingPackSelection,
  namedPackSelection,
  attributeSelectedElementOptions,
  missingSerializablePackSelection,
  missingRuntimePackSelection,
];

export type {
  ElementPropertyParity,
  HiddenSignatureParity,
  HideDurationParity,
  HideSignatureParity,
  ShowSignatureParity,
};
