import { EVENT_NAME_PATTERN, STATE_NAME_PATTERN } from "./contracts.js";
import { isContinuousBrowserEvent } from "./events.js";
import { DEFAULT_PERSISTENT_REQUEST_LIMIT } from "./defaults.js";
import { validateEventPayload } from "./events.js";
import { OwnDataError, snapshotOwnData } from "./own-data.js";
import {
  PLAN_BROWSER_EVENTS,
  type Plan,
  type JsonValue,
  type PlanCapability,
  type PlanChannel,
  type PlanCondition,
  type PlanDisposition,
  type PlanEffect,
  type PlanInterruptLifetime,
  type PlanMotionEffect,
  type PlanRule,
  type PlanStateSelection,
  type PlanSurfaceEffect,
  type PlanSurfaceOrdering,
} from "./types.js";

import {
  compactRuntimeDiagnostics,
  runtimeMessage,
} from "./runtime-diagnostics.js";

const RULE_LIMIT = 64;
const CHANNEL_LIMIT = 16;
const SURFACE_LIMIT = 8;
const SELECTOR_LIMIT = 256;
const ORDERED_SESSION_LIMIT = 64;
const PLAN_CHANNEL_PATTERN = /^(?:motion|state|surface:[a-z][a-z0-9:-]{0,63})$/;
const PAYLOAD_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export interface PlanCompileContext {
  states?: ReadonlySet<string>;
  capabilities?: ReadonlySet<PlanCapability>;
  contentIds?: ReadonlySet<string>;
  targets?: ReadonlySet<string>;
  validateSelector?: (selector: string) => boolean;
  validatePath?: (path: string) => boolean;
}

export interface CompiledPlanStateSelection {
  readonly kind: "state" | "capability";
  readonly name: string;
}

export interface CompiledPlanSurface {
  readonly id: string;
  readonly channel: `surface:${string}`;
  readonly contentId: string;
  readonly dataSource?: "event-payload";
  readonly disposition?: PlanDisposition;
  readonly ordering?: Readonly<PlanSurfaceOrdering>;
  readonly data?: JsonValue;
}

export interface CompiledPlanEffect {
  readonly channels: readonly PlanChannel[];
  readonly state?: Readonly<CompiledPlanStateSelection>;
  readonly motion?: Readonly<PlanMotionEffect>;
  readonly surfaces: readonly CompiledPlanSurface[];
  readonly until?: Readonly<PlanInterruptLifetime>;
}

export interface CompiledPlanRule {
  readonly id: string;
  readonly when: Readonly<PlanCondition>;
  readonly effect: Readonly<CompiledPlanEffect>;
}

export interface CompiledPlan {
  readonly baseline: Readonly<CompiledPlanEffect>;
  readonly rules: readonly Readonly<CompiledPlanRule>[];
}

export interface PlanEventState {
  readonly ordering: Map<string, number | true>;
  readonly sessions: Map<string, string[]>;
}

interface PlanEventPatch {
  readonly ordering: Map<string, number | true>;
}

export interface PlanEventInput {
  source: "browser" | "application";
  name: string;
  payload?: unknown;
}

export interface PlanEventEvaluation {
  readonly status: "matched" | "unmatched" | "stale" | "closed" | "invalid";
  readonly rules: readonly Readonly<CompiledPlanRule>[];
  readonly effects: readonly Readonly<CompiledPlanEffect>[];
  readonly rejectedSurfaces: readonly Readonly<PlanEventSurfaceRejection>[];
}

export interface PlanEventSurfaceRejection {
  readonly channel: CompiledPlanSurface["channel"];
  readonly status: "stale" | "closed" | "invalid";
}

export interface PlanCompileDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type PlanPreflightResult =
  | {
      readonly valid: true;
      readonly plan: CompiledPlan;
      readonly errors: readonly [];
    }
  | {
      readonly valid: false;
      readonly plan: undefined;
      readonly errors: readonly Readonly<PlanCompileDiagnostic>[];
    };

export class PlanCompileError extends TypeError {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(compactRuntimeDiagnostics ? code : `${path}: ${message}`);
    this.name = "PlanCompileError";
    this.code = code;
    this.path = compactRuntimeDiagnostics ? "" : path;
  }
}

export function compilePlan(
  input: Plan,
  context: PlanCompileContext = {},
): CompiledPlan {
  const plan = snapshotOwnData(input) as Plan;
  object(plan, "$plan");
  closed(plan, ["baseline", "rules"], "$plan");
  if (!plan.baseline) fail("missing-baseline", "$plan.baseline", "is required");
  const baseline = compileEffect(
    plan.baseline,
    "$plan.baseline",
    context,
    false,
  );
  if (baseline.until) {
    fail(
      "invalid-baseline-interrupt",
      "$plan.baseline.until",
      "is available only on a Rule Effect",
    );
  }
  if (!baseline.channels.includes("state")) {
    fail("missing-baseline-state", "$plan.baseline.channels", "must own state");
  }
  if (!baseline.state) {
    fail("missing-baseline-state", "$plan.baseline.state", "is required");
  }
  for (const [index, surface] of effectSurfaces(baseline).entries()) {
    if (surface.ordering) {
      fail(
        "invalid-ordering-source",
        `$plan.baseline.surfaces[${index}].ordering`,
        "session ordering requires an application Event Rule",
      );
    }
  }
  const rules = plan.rules === undefined ? [] : plan.rules;
  if (!Array.isArray(rules) || rules.length > RULE_LIMIT) {
    fail(
      "rule-limit",
      "$plan.rules",
      `must contain at most ${RULE_LIMIT} Rules`,
    );
  }
  const ids = new Set<string>();
  const compiledRules = rules.map((rule, index) => {
    const path = `$plan.rules[${index}]`;
    object(rule, path);
    closed(rule, ["id", "when", "effect"], path);
    id(rule.id, `${path}.id`, "Rule id");
    if (ids.has(rule.id))
      fail("duplicate-rule", `${path}.id`, `duplicates ${rule.id}`);
    ids.add(rule.id);
    const when = compileCondition(
      rule.when as PlanCondition,
      `${path}.when`,
      context,
    );
    const effect = compileEffect(
      rule.effect as PlanEffect,
      `${path}.effect`,
      context,
      true,
    );
    if (
      when.source === "browser" &&
      (when.event === "pointer.move" ||
        (when.event === "section.visibility" &&
          when.phase === "while-visible")) &&
      ((rule.effect as PlanEffect).surfaces !== undefined || effect.until)
    ) {
      fail(
        "invalid-continuous-effect",
        `${path}.effect`,
        "continuous Rules cannot declare surfaces or an until lifetime",
      );
    }
    for (const surface of effectSurfaces(effect)) {
      if (
        surfaceDataSource(surface) === "event-payload" &&
        when.source !== "application"
      ) {
        fail(
          "invalid-payload-source",
          `${path}.effect.surfaces`,
          "event-payload data requires an application Event Rule",
        );
      }
      if (surface.ordering && when.source !== "application") {
        fail(
          "invalid-ordering-source",
          `${path}.effect.surfaces`,
          "session ordering requires an application Event Rule",
        );
      }
    }
    return freeze({ id: rule.id, when, effect });
  });
  validateSurfaceConflicts(baseline, compiledRules);
  validateEventCoalescing(compiledRules);
  return freeze({ baseline, rules: freeze(compiledRules) });
}

/** Compile one temporary Effect without creating a second Plan evaluator. */
export function compileOverrideEffect(
  input: PlanEffect,
  context: PlanCompileContext = {},
): CompiledPlanEffect {
  const effect = snapshotOwnData(input) as PlanEffect;
  const compiled = compileEffect(effect, "$override.effect", context, false);
  if (compiled.until) {
    fail(
      "invalid-override-lifetime",
      "$override.effect.until",
      "belongs on OverrideInput.until, not its Effect",
    );
  }
  for (const [index, surface] of effectSurfaces(effect).entries()) {
    if (surface.disposition !== undefined) {
      fail(
        "invalid-override-disposition",
        `$override.effect.surfaces[${index}].disposition`,
        "belongs to Plan Rule arbitration, not a direct override",
      );
    }
    if (surface.ordering !== undefined) {
      fail(
        "invalid-override-ordering",
        `$override.effect.surfaces[${index}].ordering`,
        "belongs to typed event ingestion, not a direct override",
      );
    }
  }
  return compiled;
}

export function preflightPlan(
  input: Plan,
  context: PlanCompileContext = {},
): PlanPreflightResult {
  try {
    return freeze({
      valid: true,
      plan: compilePlan(input, context),
      errors: freeze([]),
    });
  } catch (cause) {
    const diagnostic =
      cause instanceof PlanCompileError
        ? freeze({
            code: cause.code,
            path: cause.path,
            message: cause.message.slice(cause.message.indexOf(":") + 2),
          })
        : cause instanceof OwnDataError
          ? freeze({
              code: "invalid-data",
              path: "$plan",
              message: cause.message,
            })
          : freeze({
              code: "invalid-plan",
              path: "$plan",
              message: "Plan could not be compiled safely",
            });
    return freeze({
      valid: false,
      plan: undefined,
      errors: freeze([diagnostic]),
    });
  }
}

export function createPlanEventState(): PlanEventState {
  return {
    ordering: new Map(),
    sessions: new Map(),
  };
}

export function evaluatePlanEvent(
  plan: CompiledPlan,
  state: PlanEventState,
  input: PlanEventInput,
): PlanEventEvaluation {
  let payload: JsonValue | undefined;
  try {
    payload = validateEventPayload(input.payload);
  } catch {
    return result("invalid");
  }
  const section =
    input.source === "browser" && input.name === "section.visibility"
      ? sectionVisibilityFact(payload)
      : undefined;
  if (
    input.source === "browser" &&
    input.name === "section.visibility" &&
    !section
  ) {
    return result("invalid");
  }
  const matching = plan.rules.filter(
    (rule) =>
      rule.when.source === input.source &&
      rule.when.event === input.name &&
      (!section || matchesSectionEdge(rule.when, section)),
  );
  if (!matching.length) return result("unmatched");
  if (
    !matching.some((rule) =>
      effectSurfaces(rule.effect).some((surface) => surface.ordering),
    )
  ) {
    return result(
      "matched",
      matching,
      matching.map((rule) => prepareEffect(rule.effect, payload)),
    );
  }
  const orderedSurfaces = new Map<
    CompiledPlanSurface["channel"],
    CompiledPlanSurface[]
  >();
  for (const rule of matching) {
    for (const surface of effectSurfaces(rule.effect)) {
      if (!surface.ordering) continue;
      const channel = surfaceChannel(surface);
      const group = orderedSurfaces.get(channel) ?? [];
      group.push(surface as CompiledPlanSurface);
      orderedSurfaces.set(channel, group);
    }
  }
  const rejectedSurfaces: PlanEventSurfaceRejection[] = [];
  const rejectedChannels = new Set<string>();
  for (const [channel, surfaces] of orderedSurfaces) {
    const surfacePatch: PlanEventPatch = { ordering: new Map() };
    const status = checkOrdering(surfaces, state, surfacePatch, payload);
    if (status === "matched") {
      commitOrdering(state, surfacePatch, channel);
      continue;
    }
    rejectedChannels.add(channel);
    rejectedSurfaces.push({ channel, status });
  }
  const rules: CompiledPlanRule[] = [];
  const effects: CompiledPlanEffect[] = [];
  for (const [index, rule] of matching.entries()) {
    const prepared = prepareEffect(rule.effect, payload);
    const selected = selectCompiledEffectChannels(
      prepared,
      prepared.channels.filter((channel) => !rejectedChannels.has(channel)),
    );
    if (!selected) continue;
    rules.push(rule);
    effects.push(selected);
  }
  const status = effects.length
    ? "matched"
    : (rejectedSurfaces[0]?.status ?? "matched");
  return result(status, rules, effects, rejectedSurfaces);

  function result(
    status: PlanEventEvaluation["status"],
    rules: readonly Readonly<CompiledPlanRule>[] = [],
    selected: readonly CompiledPlanEffect[] = [],
    rejected: readonly PlanEventSurfaceRejection[] = [],
  ): PlanEventEvaluation {
    return {
      status,
      rules,
      effects: selected,
      rejectedSurfaces: freeze([...rejected]),
    };
  }
}

interface SectionVisibilityFact {
  readonly selector: string;
  readonly previousRatio: number;
  readonly ratio: number;
}

function sectionVisibilityFact(
  payload: JsonValue | undefined,
): SectionVisibilityFact | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  const data = payload as { readonly [key: string]: JsonValue };
  if (
    Object.keys(data).length !== 3 ||
    typeof data.selector !== "string" ||
    typeof data.previousRatio !== "number" ||
    typeof data.ratio !== "number" ||
    data.previousRatio < 0 ||
    data.previousRatio > 1 ||
    data.ratio < 0 ||
    data.ratio > 1
  ) {
    return;
  }
  return data as unknown as SectionVisibilityFact;
}

function matchesSectionEdge(
  condition: PlanCondition,
  fact: SectionVisibilityFact,
): boolean {
  if (
    condition.source !== "browser" ||
    condition.event !== "section.visibility" ||
    condition.selector !== fact.selector ||
    condition.phase === "while-visible"
  ) {
    return false;
  }
  const threshold = condition.threshold ?? 0.25;
  return condition.phase === "enter"
    ? fact.previousRatio < threshold && fact.ratio >= threshold
    : fact.previousRatio >= threshold && fact.ratio < threshold;
}

function compileCondition(
  input: PlanCondition,
  path: string,
  context: PlanCompileContext,
): Readonly<PlanCondition> {
  object(input, path);
  if (input.source === "application") {
    closed(input, ["source", "event", "coalesce"], path);
    if (
      typeof input.event !== "string" ||
      !EVENT_NAME_PATTERN.test(input.event)
    ) {
      fail(
        "invalid-condition",
        `${path}.event`,
        "is not a valid application Event name",
      );
    }
    coalescing(input.coalesce, `${path}.coalesce`);
    return freeze({
      source: "application",
      event: input.event,
      ...(input.coalesce ? { coalesce: input.coalesce } : {}),
    });
  }
  if (input.source !== "browser") {
    fail(
      "invalid-condition",
      `${path}.source`,
      "must be browser or application",
    );
  }
  if (!(PLAN_BROWSER_EVENTS as readonly string[]).includes(input.event)) {
    fail(
      "invalid-condition",
      `${path}.event`,
      "is not a supported browser Event",
    );
  }
  if (input.event !== "section.visibility") {
    closed(input, ["source", "event", "coalesce"], path);
    coalescing(input.coalesce, `${path}.coalesce`);
    if (input.event === "window.scroll") {
      return freeze({
        source: "browser",
        event: "window.scroll",
        ...(input.coalesce ? { coalesce: input.coalesce } : {}),
      });
    }
    if (input.coalesce) {
      fail(
        "unsafe-coalescing",
        `${path}.coalesce`,
        "browser coalescing is supported only for window.scroll",
      );
    }
    return freeze({
      source: "browser",
      event: input.event,
    });
  }
  closed(input, ["source", "event", "selector", "phase", "threshold"], path);
  selector(input.selector, `${path}.selector`, context.validateSelector);
  if (
    !(["enter", "while-visible", "leave"] as unknown[]).includes(input.phase)
  ) {
    fail(
      "invalid-condition",
      `${path}.phase`,
      "must be enter, while-visible, or leave",
    );
  }
  if (
    input.threshold !== undefined &&
    (typeof input.threshold !== "number" ||
      !Number.isFinite(input.threshold) ||
      input.threshold <= 0 ||
      input.threshold > 1)
  ) {
    fail(
      "invalid-threshold",
      `${path}.threshold`,
      "must be finite, greater than 0, and at most 1",
    );
  }
  return freeze({
    source: "browser",
    event: "section.visibility",
    selector: input.selector,
    phase: input.phase,
    ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
  });
}

function compileEffect(
  input: PlanEffect,
  path: string,
  context: PlanCompileContext,
  allowPayload: boolean,
): CompiledPlanEffect {
  object(input, path);
  closed(input, ["channels", "state", "motion", "surfaces", "until"], path);
  if (
    !Array.isArray(input.channels) ||
    !input.channels.length ||
    input.channels.length > CHANNEL_LIMIT
  ) {
    fail(
      "invalid-channels",
      `${path}.channels`,
      `needs 1-${CHANNEL_LIMIT} channels`,
    );
  }
  const channels = input.channels.map((channel, index) => {
    if (typeof channel !== "string" || !PLAN_CHANNEL_PATTERN.test(channel)) {
      fail(
        "invalid-channel",
        `${path}.channels[${index}]`,
        "is not a valid Plan channel",
      );
    }
    return channel as PlanChannel;
  });
  if (new Set(channels).size !== channels.length) {
    fail(
      "duplicate-channel",
      `${path}.channels`,
      "contains a duplicate channel",
    );
  }
  const state =
    input.state === undefined
      ? undefined
      : compileState(input.state, `${path}.state`, context);
  const motion =
    input.motion === undefined
      ? undefined
      : compileMotion(input.motion, `${path}.motion`, context);
  const surfaces = input.surfaces === undefined ? [] : input.surfaces;
  if (!Array.isArray(surfaces) || surfaces.length > SURFACE_LIMIT) {
    fail(
      "surface-limit",
      `${path}.surfaces`,
      `must contain at most ${SURFACE_LIMIT} surfaces`,
    );
  }
  const compiledSurfaces = surfaces.map((surface, index) =>
    compileSurface(
      surface,
      `${path}.surfaces[${index}]`,
      context,
      allowPayload,
    ),
  );
  const declaredSurfaceChannels = new Set<string>();
  for (const surface of compiledSurfaces) {
    const channel = surfaceChannel(surface);
    if (declaredSurfaceChannels.has(channel)) {
      fail(
        "duplicate-surface",
        `${path}.surfaces`,
        `declares duplicate ${channel}`,
      );
    }
    declaredSurfaceChannels.add(channel);
  }
  const until =
    input.until === undefined
      ? undefined
      : compileInterruptLifetime(input.until, `${path}.until`);
  const interrupts = compiledSurfaces.filter(
    (surface) => surface.disposition === "interrupt",
  );
  if (interrupts.length && !until) {
    fail(
      "missing-interrupt-lifetime",
      `${path}.until`,
      "interrupt requires an until lifetime",
    );
  }
  if (
    until &&
    compiledSurfaces.some((surface) => surface.disposition !== "interrupt")
  ) {
    fail(
      "mixed-interrupt-effect",
      `${path}.surfaces`,
      "must all use interrupt disposition when Effect.until is present",
    );
  }
  if (state && !channels.includes("state")) {
    fail("undeclared-channel", `${path}.channels`, "must declare state");
  }
  if (!state && channels.includes("state")) {
    fail(
      "missing-channel-output",
      `${path}.state`,
      "is required when state is owned",
    );
  }
  if (motion && !channels.includes("motion")) {
    fail("undeclared-channel", `${path}.channels`, "must declare motion");
  }
  if (!motion && channels.includes("motion")) {
    fail(
      "missing-channel-output",
      `${path}.motion`,
      "is required when motion is owned",
    );
  }
  const surfaceChannels = compiledSurfaces.map(surfaceChannel);
  for (const channel of channels) {
    if (
      channel.startsWith("surface:") &&
      !surfaceChannels.includes(channel as `surface:${string}`)
    ) {
      fail(
        "missing-channel-output",
        `${path}.surfaces`,
        `does not define ${channel}`,
      );
    }
  }
  for (const channel of surfaceChannels) {
    if (!channels.includes(channel)) {
      fail("undeclared-channel", `${path}.channels`, `must declare ${channel}`);
    }
  }
  return freeze({
    channels: freeze(channels),
    ...(state ? { state } : {}),
    ...(motion ? { motion } : {}),
    surfaces: freeze(compiledSurfaces),
    ...(until ? { until } : {}),
  });
}

function compileInterruptLifetime(
  input: PlanInterruptLifetime,
  path: string,
): Readonly<PlanInterruptLifetime> {
  object(input, path);
  if (input.type === "duration") {
    closed(input, ["type", "ms"], path);
    if (input.ms === undefined) {
      fail(
        "missing-interrupt-duration",
        `${path}.ms`,
        "is required for a duration interrupt",
      );
    }
    bounded(input.ms, `${path}.ms`, 1, DEFAULT_PERSISTENT_REQUEST_LIMIT);
    return freeze({ type: "duration", ms: input.ms });
  }
  if (input.type !== "event") {
    fail(
      "invalid-interrupt-lifetime",
      `${path}.type`,
      "must be duration or event",
    );
  }
  closed(input, ["type", "name", "timeout"], path);
  if (typeof input.name !== "string" || !EVENT_NAME_PATTERN.test(input.name)) {
    fail(
      "invalid-interrupt-lifetime",
      `${path}.name`,
      "must be a valid Event name",
    );
  }
  if (isContinuousBrowserEvent(input.name)) {
    fail(
      "invalid-interrupt-lifetime",
      `${path}.name`,
      "continuous browser Events cannot be used as completion Events",
    );
  }
  bounded(
    input.timeout,
    `${path}.timeout`,
    1,
    DEFAULT_PERSISTENT_REQUEST_LIMIT,
  );
  return freeze({
    type: "event",
    name: input.name,
    ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
  });
}

function compileState(
  input: PlanStateSelection,
  path: string,
  context: PlanCompileContext,
): Readonly<CompiledPlanStateSelection> {
  object(input, path);
  if ("state" in input) {
    closed(input, ["state"], path);
    if (
      typeof input.state !== "string" ||
      !STATE_NAME_PATTERN.test(input.state)
    )
      fail("invalid-state", `${path}.state`, "is invalid");
    if (context.states && !context.states.has(input.state)) {
      fail(
        "unknown-state",
        `${path}.state`,
        `references unknown Pack State ${input.state}`,
      );
    }
    return freeze({ kind: "state", name: input.state });
  }
  closed(input, ["capability"], path);
  if (input.capability !== "locomotion") {
    fail(
      "invalid-capability",
      `${path}.capability`,
      "is not a supported Pack Capability",
    );
  }
  if (context.capabilities && !context.capabilities.has(input.capability)) {
    fail(
      "unknown-capability",
      `${path}.capability`,
      `references unavailable Pack Capability ${input.capability}`,
    );
  }
  return freeze({ kind: "capability", name: input.capability });
}

function compileMotion(
  input: PlanMotionEffect,
  path: string,
  context: PlanCompileContext,
): Readonly<PlanMotionEffect> {
  object(input, path);
  switch (input.type) {
    case "follow-pointer":
      closed(input, ["type", "speed", "arrivalRadius"], path);
      bounded(input.speed, `${path}.speed`, 1, 1_000);
      bounded(input.arrivalRadius, `${path}.arrivalRadius`, 0, 1_000);
      break;
    case "horizontal-patrol":
      closed(input, ["type", "speed", "edgeInset"], path);
      bounded(input.speed, `${path}.speed`, 1, 1_000);
      bounded(input.edgeInset, `${path}.edgeInset`, 0, 1_000);
      break;
    case "viewport-traverse":
      closed(input, ["type", "speed", "edgeInset", "clockwise"], path);
      bounded(input.speed, `${path}.speed`, 1, 1_000);
      bounded(input.edgeInset, `${path}.edgeInset`, 0, 1_000);
      if (
        input.clockwise !== undefined &&
        typeof input.clockwise !== "boolean"
      ) {
        fail("invalid-motion", `${path}.clockwise`, "must be boolean");
      }
      break;
    case "move-to":
      closed(input, ["type", "x", "y", "speed", "arrivalRadius"], path);
      bounded(input.x, `${path}.x`, -100_000, 100_000);
      bounded(input.y, `${path}.y`, -100_000, 100_000);
      bounded(input.speed, `${path}.speed`, 1, 1_000);
      bounded(input.arrivalRadius, `${path}.arrivalRadius`, 0, 1_000);
      break;
    case "move-to-target":
      closed(
        input,
        ["type", "target", "anchor", "speed", "arrivalRadius"],
        path,
      );
      id(input.target, `${path}.target`, "Target");
      if (context.targets && !context.targets.has(input.target)) {
        fail(
          "unknown-target",
          `${path}.target`,
          `references unknown target ${input.target}`,
        );
      }
      if (
        input.anchor !== undefined &&
        !["center", "top", "right", "bottom", "left"].includes(input.anchor)
      ) {
        fail("invalid-motion", `${path}.anchor`, "is not supported");
      }
      bounded(input.speed, `${path}.speed`, 1, 1_000);
      bounded(input.arrivalRadius, `${path}.arrivalRadius`, 0, 1_000);
      break;
    case "jump-to":
      closed(input, ["type", "x", "y", "duration", "height"], path);
      bounded(input.x, `${path}.x`, -100_000, 100_000);
      bounded(input.y, `${path}.y`, -100_000, 100_000);
      bounded(input.duration, `${path}.duration`, 100, 10_000);
      bounded(input.height, `${path}.height`, 0, 2_000);
      break;
    case "svg-path": {
      closed(input, ["type", "path", "duration", "loop", "relative"], path);
      if (
        typeof input.path !== "string" ||
        input.path.length < 1 ||
        input.path.length > 4_096 ||
        /[\0\r\n]/.test(input.path)
      ) {
        fail("invalid-path", `${path}.path`, "must be bounded SVG path data");
      }
      if (context.validatePath && !context.validatePath(input.path)) {
        fail("invalid-path", `${path}.path`, "must be valid SVG path data");
      }
      bounded(input.duration, `${path}.duration`, 100, 60_000);
      for (const field of ["loop", "relative"] as const) {
        if (input[field] !== undefined && typeof input[field] !== "boolean") {
          fail("invalid-motion", `${path}.${field}`, "must be boolean");
        }
      }
      break;
    }
    default:
      fail("invalid-motion", `${path}.type`, "is not a supported motion type");
  }
  return freeze({ ...input });
}

function compileSurface(
  input: PlanSurfaceEffect,
  path: string,
  context: PlanCompileContext,
  allowPayload: boolean,
): CompiledPlanSurface {
  object(input, path);
  closed(input, ["id", "contentId", "data", "disposition", "ordering"], path);
  id(input.id, `${path}.id`, "surface id");
  id(input.contentId, `${path}.contentId`, "content id");
  if (context.contentIds && !context.contentIds.has(input.contentId)) {
    fail(
      "unknown-content",
      `${path}.contentId`,
      `references unknown content ${input.contentId}`,
    );
  }
  if (input.data === "event-payload" && !allowPayload) {
    fail(
      "invalid-surface-data",
      `${path}.data`,
      "is not available to the baseline Effect",
    );
  }
  if (
    input.disposition !== undefined &&
    !(["update", "replace", "ignore", "interrupt"] as unknown[]).includes(
      input.disposition,
    )
  ) {
    fail(
      "invalid-disposition",
      `${path}.disposition`,
      "must be update, replace, ignore, or interrupt",
    );
  }
  const ordering =
    input.ordering === undefined
      ? undefined
      : compileOrdering(input.ordering, `${path}.ordering`);
  let data: JsonValue | undefined;
  if (input.data !== undefined && input.data !== "event-payload") {
    try {
      data = validateEventPayload(input.data);
    } catch {
      fail(
        "invalid-surface-data",
        `${path}.data`,
        "must be bounded JSON-like immutable data",
      );
    }
  }
  return freeze({
    id: input.id,
    channel: `surface:${input.id}`,
    contentId: input.contentId,
    ...(input.data === "event-payload"
      ? { dataSource: "event-payload" as const }
      : {}),
    ...(data === undefined ? {} : { data }),
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(ordering ? { ordering } : {}),
  });
}

function compileOrdering(
  input: PlanSurfaceOrdering,
  path: string,
): Readonly<PlanSurfaceOrdering> {
  object(input, path);
  closed(input, ["sessionField", "revisionField", "terminal"], path);
  payloadField(input.sessionField, `${path}.sessionField`);
  if (input.revisionField !== undefined)
    payloadField(input.revisionField, `${path}.revisionField`);
  if (input.terminal !== undefined && typeof input.terminal !== "boolean") {
    fail("invalid-ordering", `${path}.terminal`, "must be boolean");
  }
  if (!input.terminal && !input.revisionField) {
    fail(
      "invalid-ordering",
      path,
      "non-terminal ordering requires revisionField",
    );
  }
  return freeze({
    sessionField: input.sessionField,
    ...(input.revisionField ? { revisionField: input.revisionField } : {}),
    ...(input.terminal ? { terminal: true } : {}),
  });
}

type CheckedSurface = CompiledPlanSurface | PlanSurfaceEffect;

function effectSurfaces(
  effect: CompiledPlanEffect | PlanEffect,
): readonly CheckedSurface[] {
  return effect.surfaces ?? [];
}

function surfaceChannel(surface: CheckedSurface): `surface:${string}` {
  return "channel" in surface ? surface.channel : `surface:${surface.id}`;
}

function surfaceDataSource(
  surface: CheckedSurface,
): "event-payload" | undefined {
  return "dataSource" in surface
    ? surface.dataSource
    : surface.data === "event-payload"
      ? "event-payload"
      : undefined;
}

function validateSurfaceConflicts(
  baseline: CompiledPlanEffect,
  rules: readonly CompiledPlanRule[],
): void {
  const baselineChannels = new Set(
    effectSurfaces(baseline).map(surfaceChannel),
  );
  const owners = new Map<string, CompiledPlanRule[]>();
  const orderingContracts = new Map<
    string,
    { sessionField: string; revisionField?: string }
  >();
  for (const rule of rules) {
    for (const surface of effectSurfaces(rule.effect)) {
      const channel = surfaceChannel(surface);
      if (baselineChannels.has(channel) && !surface.disposition) {
        fail(
          "ambiguous-channel",
          "$plan.rules",
          `Baseline and Rule ${rule.id} write ${channel} without an explicit disposition`,
        );
      }
      const prior = owners.get(channel) ?? [];
      prior.push(rule);
      owners.set(channel, prior);
      const ordering = surface.ordering;
      if (!ordering) continue;
      const contract = orderingContracts.get(channel);
      if (!contract) {
        orderingContracts.set(channel, {
          sessionField: ordering.sessionField,
          ...(ordering.revisionField
            ? { revisionField: ordering.revisionField }
            : {}),
        });
        continue;
      }
      if (contract.sessionField !== ordering.sessionField) {
        fail(
          "ambiguous-ordering",
          "$plan.rules",
          `Ordered surface ${channel} must use one session field`,
        );
      }
      if (
        ordering.revisionField &&
        contract.revisionField &&
        contract.revisionField !== ordering.revisionField
      ) {
        fail(
          "ambiguous-ordering",
          "$plan.rules",
          `Ordered surface ${channel} must use one revision field`,
        );
      }
      if (ordering.revisionField && !contract.revisionField) {
        contract.revisionField = ordering.revisionField;
      }
    }
  }
  for (const [channel, writers] of owners) {
    if (writers.length < 2) continue;
    const ambiguous = writers.filter((rule) =>
      effectSurfaces(rule.effect).some(
        (surface) =>
          surfaceChannel(surface) === channel && !surface.disposition,
      ),
    );
    if (ambiguous.length) {
      fail(
        "ambiguous-channel",
        "$plan.rules",
        () =>
          `Rules ${writers.map((rule) => rule.id).join(", ")} write ${channel} without an explicit disposition`,
      );
    }
  }
}

function validateEventCoalescing(rules: readonly CompiledPlanRule[]): void {
  const groups = new Map<string, CompiledPlanRule[]>();
  for (const rule of rules) {
    const key = `${rule.when.source}:${rule.when.event}`;
    const group = groups.get(key) ?? [];
    group.push(rule);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const policies = new Set(group.map((rule) => rule.when.coalesce ?? "fifo"));
    if (policies.size > 1) {
      fail(
        "ambiguous-coalescing",
        "$plan.rules",
        `Rules for ${key} have ambiguous coalescing policies`,
      );
    }
    if (group[0]?.when.coalesce !== "latest") continue;
    if (group[0].when.source === "application") {
      const safe = group.every(
        (rule) =>
          rule.effect.channels.every((channel) =>
            channel.startsWith("surface:"),
          ) &&
          effectSurfaces(rule.effect).length > 0 &&
          effectSurfaces(rule.effect).every(
            (surface) => surface.ordering?.revisionField,
          ),
      );
      if (!safe) {
        fail(
          "unsafe-coalescing",
          "$plan.rules",
          `Application Event ${group[0].when.event} can coalesce only an ordered surface Effect with revisionField`,
        );
      }
      const orderings = new Set(
        group.flatMap((rule) =>
          effectSurfaces(rule.effect).map(
            (surface) =>
              `${surface.ordering!.sessionField}\u0000${surface.ordering!.revisionField}`,
          ),
        ),
      );
      if (orderings.size !== 1) {
        fail(
          "ambiguous-coalescing",
          "$plan.rules",
          `Application Event ${group[0].when.event} has ambiguous session or revision fields`,
        );
      }
    }
  }
}

function coalescing(value: unknown, path: string): void {
  if (value !== undefined && value !== "latest") {
    fail("invalid-coalescing", path, "must be latest when present");
  }
}

function prepareEffect(
  effect: CompiledPlanEffect,
  payload: JsonValue | undefined,
): CompiledPlanEffect {
  const surfaces = effectSurfaces(effect).map((surface) =>
    freeze({
      ...surface,
      ...(surfaceDataSource(surface) === "event-payload"
        ? { data: payload }
        : {}),
    }),
  );
  return freeze({
    ...effect,
    surfaces: freeze(surfaces) as readonly CompiledPlanSurface[],
  });
}

function checkOrdering(
  surfaces: readonly CompiledPlanSurface[],
  state: PlanEventState,
  patch: PlanEventPatch,
  payload: JsonValue | undefined,
): "matched" | "stale" | "closed" | "invalid" {
  for (const surface of surfaces) {
    const ordering = surface.ordering;
    if (!ordering) continue;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return "invalid";
    const objectPayload = payload as { readonly [key: string]: JsonValue };
    const session = objectPayload[ordering.sessionField];
    if (typeof session !== "string" && typeof session !== "number")
      return "invalid";
    const key = `${surfaceChannel(surface)}\u0000${typeof session}\u0000${String(session)}`;
    const previous = state.ordering.get(key);
    if (previous === true) return "closed";
    const staged = patch.ordering.get(key);
    let next = typeof staged === "number" ? staged : previous;
    if (ordering.revisionField) {
      const revision = objectPayload[ordering.revisionField];
      if (!Number.isSafeInteger(revision) || (revision as number) < 0)
        return "invalid";
      if (typeof previous === "number" && (revision as number) <= previous)
        return "stale";
      if (typeof staged === "number" && (revision as number) < staged)
        return "stale";
      next = revision as number;
    }
    patch.ordering.set(
      key,
      ordering.terminal || staged === true ? true : (next as number),
    );
  }
  return "matched";
}

export function selectCompiledEffectChannels(
  effect: CompiledPlanEffect,
  channels: readonly PlanChannel[],
): CompiledPlanEffect | undefined {
  if (!channels.length) return undefined;
  if (channels.length === effect.channels.length) return effect;
  const selected = new Set(channels);
  return freeze({
    channels: freeze(channels),
    ...(selected.has("state") && effect.state ? { state: effect.state } : {}),
    ...(selected.has("motion") && effect.motion
      ? { motion: effect.motion }
      : {}),
    surfaces: freeze(
      effectSurfaces(effect).filter((surface) =>
        selected.has(surfaceChannel(surface)),
      ) as readonly CompiledPlanSurface[],
    ),
    ...(effect.until ? { until: effect.until } : {}),
  });
}

function commitOrdering(
  state: PlanEventState,
  patch: PlanEventPatch,
  channel: CompiledPlanSurface["channel"],
): void {
  for (const [key, value] of patch.ordering) state.ordering.set(key, value);
  for (const key of patch.ordering.keys()) {
    const sessions = state.sessions.get(channel) ?? [];
    const prior = sessions.indexOf(key);
    if (prior >= 0) sessions.splice(prior, 1);
    sessions.push(key);
    state.sessions.set(channel, sessions);
    while (sessions.length > ORDERED_SESSION_LIMIT) {
      state.ordering.delete(sessions.shift()!);
    }
  }
}

function object(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-object", path, "must be an object");
  }
}

function closed(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      fail("unknown-field", `${path}.${key}`, `unknown field ${key}`);
  }
}

function id(
  value: unknown,
  path: string,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9:-]{0,63}$/.test(value)) {
    fail("invalid-id", path, `${label} must be a bounded lowercase ID`);
  }
}

function selector(
  value: unknown,
  path: string,
  validate?: (selector: string) => boolean,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > SELECTOR_LIMIT ||
    /[\0\r\n]/.test(value)
  ) {
    fail("invalid-selector", path, "must be a bounded selector");
  }
  if (!validate) return;
  let valid = false;
  try {
    valid = validate(value);
  } catch {
    valid = false;
  }
  if (!valid) {
    fail("invalid-selector", path, "must be valid CSS");
  }
}

function payloadField(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !PAYLOAD_FIELD_PATTERN.test(value)) {
    fail("invalid-ordering", path, "must be a bounded payload field name");
  }
}

function bounded(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail("out-of-range", path, `must be ${minimum}-${maximum}`);
  }
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function fail(
  code: string,
  path: string,
  message?: string | (() => string),
): never {
  if (compactRuntimeDiagnostics) throw new PlanCompileError(code, "", code);
  throw new PlanCompileError(code, path, runtimeMessage(code, message ?? code));
}
