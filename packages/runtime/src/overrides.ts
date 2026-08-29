import { EVENT_NAME_PATTERN } from "./contracts.js";
import { browserCompletionEvent, isContinuousBrowserEvent } from "./events.js";
import { DEFAULT_PERSISTENT_REQUEST_LIMIT } from "./defaults.js";
import {
  compileOverrideEffect,
  type CompiledPlanEffect,
  type PlanCompileContext,
} from "./plan-compiler.js";
import { snapshotOwnData } from "./own-data.js";
import {
  evaluateHorizontalPatrol,
  motionToward,
  type PatrolDirection,
} from "./plan.js";
import type {
  BehaviorRequest,
  OverrideCompletionReason,
  OverrideHandle,
  OverrideInput,
  OverrideResult,
  OverrideStatus,
  PlanCapability,
  PlanBrowserEvent,
  PlanEventSource,
  SurfacePresentation,
} from "./types.js";
import { runtimeMessage } from "./runtime-diagnostics.js";

const OVERRIDE_LIMIT = 8;
const MAX_LIFETIME = DEFAULT_PERSISTENT_REQUEST_LIMIT;

interface ActiveOverride {
  id: string;
  effect: CompiledPlanEffect;
  input: OverrideInput;
  startedAt: number;
  deadline: number;
  status: OverrideStatus;
  patrolDirection: PatrolDirection;
  handle: OverrideHandle;
  finish(reason: OverrideCompletionReason): void;
}

interface OverrideWorld {
  pointer?: { x: number; y: number };
  position?: { x: number; y: number };
  viewport?: { width: number; height: number };
  characterSize?: { width: number; height: number };
}

/** Instance-owned temporary channel controller. It never mutates the Plan. */
export class OverrideManager {
  readonly #context: PlanCompileContext;
  readonly #now: () => number;
  readonly #diagnostic: (message: string) => void;
  readonly #active: ActiveOverride[] = [];
  #nextId = 1;

  constructor(
    context: PlanCompileContext,
    now: () => number,
    diagnostic: (message: string) => void = () => {},
  ) {
    this.#context = context;
    this.#now = now;
    this.#diagnostic = diagnostic;
  }

  add(input: OverrideInput): OverrideHandle {
    const item = this.#create();
    let checked: OverrideInput;
    let effect: CompiledPlanEffect;
    try {
      checked = validateOverride(input);
      effect = compileOverrideEffect(checked.effect, this.#context);
    } catch (cause) {
      this.#diagnostic(
        runtimeMessage(
          "override.invalid",
          () => `Override ${item.id} rejected: ${errorMessage(cause)}`,
        ),
      );
      item.finish("rejected");
      return item.handle;
    }

    const conflicts = this.#active.filter((active) =>
      active.effect.channels.some((channel) =>
        effect.channels.includes(channel),
      ),
    );
    if (conflicts.length && checked.mode !== "replace") {
      this.#diagnostic(
        runtimeMessage(
          "override.conflict",
          () =>
            `Override ${item.id} conflict on ${conflictingChannels(conflicts, effect).join(", ")}`,
        ),
      );
      item.finish("conflict");
      return item.handle;
    }
    for (const conflict of conflicts) this.#finish(conflict, "replaced");
    if (this.#active.length >= OVERRIDE_LIMIT) {
      this.#diagnostic(
        runtimeMessage(
          "override.limit",
          () =>
            `Override ${item.id} rejected at the ${OVERRIDE_LIMIT}-override limit`,
        ),
      );
      item.finish("overflow");
      return item.handle;
    }

    const startedAt = this.#now();
    Object.assign(item, {
      input: checked,
      effect,
      startedAt,
      deadline: startedAt + lifetimeMs(checked),
      status: "active" as const,
    });
    this.#active.push(item);
    return item.handle;
  }

  reject(reason: OverrideCompletionReason = "rejected"): OverrideHandle {
    const item = this.#create();
    item.finish(reason);
    return item.handle;
  }

  browserCompletionFor(id: string): PlanBrowserEvent | undefined {
    const until = this.#active.find((item) => item.id === id)?.input.until;
    return until?.type === "event"
      ? browserCompletionEvent(until.name)
      : undefined;
  }

  /** Complete matching waits but never consume the event from the Plan stream. */
  observeEvent(name: string, source: PlanEventSource = "application"): false {
    for (const item of [...this.#active]) {
      if (
        item.input.until?.type === "event" &&
        item.input.until.name === name &&
        completionSource(item.input.until.name) === source
      ) {
        this.#finish(item, "event");
      }
    }
    return false;
  }

  compose(
    base: Readonly<BehaviorRequest>,
    world: Readonly<OverrideWorld>,
  ): BehaviorRequest {
    const now = this.#now();
    for (const item of [...this.#active]) {
      if (now >= item.deadline) this.#finish(item, "timeout");
    }
    const output: BehaviorRequest = { ...base };
    const surfaces = new Map<string, SurfacePresentation>();
    for (const surface of base.surfaces ?? []) {
      surfaces.set(surface.channel, surface);
    }
    for (const item of this.#active) {
      const state = item.effect.state;
      if (state?.kind === "state") {
        output.state = state.name;
        delete output.capability;
      } else if (state?.kind === "capability") {
        output.capability = state.name as PlanCapability;
        delete output.state;
      }
      const motion = item.effect.motion;
      if (motion?.type === "horizontal-patrol") {
        const [direction, request] = evaluateHorizontalPatrol(
          motion,
          world as Required<OverrideWorld>,
          item.patrolDirection,
        );
        item.patrolDirection = direction;
        if (request) output.motion = request;
        else delete output.motion;
      } else if (
        motion?.type === "follow-pointer" &&
        world.pointer &&
        world.position
      ) {
        const request = motionToward(
          motion,
          world.position,
          world.pointer.x,
          world.pointer.y,
          motion.arrivalRadius,
          world,
        );
        if (request) output.motion = request;
        else delete output.motion;
      }
      for (const surface of item.effect.surfaces) {
        surfaces.set(
          surface.channel,
          Object.freeze({
            id: surface.id,
            channel: surface.channel,
            contentId: surface.contentId,
            ...(surface.data === undefined ? {} : { data: surface.data }),
            key: item.id,
          }),
        );
      }
    }
    output.surfaces = Object.freeze([...surfaces.values()]);
    return output;
  }

  nextWakeAt(): number | undefined {
    return this.#active.reduce<number | undefined>(
      (earliest, item) =>
        earliest === undefined
          ? item.deadline
          : Math.min(earliest, item.deadline),
      undefined,
    );
  }

  rebase(delta: number): void {
    for (const item of this.#active) {
      item.startedAt += delta;
      item.deadline += delta;
    }
  }

  clear(reason: OverrideCompletionReason): void {
    for (const item of [...this.#active]) this.#finish(item, reason);
  }

  #create(): ActiveOverride {
    const id = `override:${this.#nextId++}`;
    let resolve!: (result: OverrideResult) => void;
    let done = false;
    const finished = new Promise<OverrideResult>((accept) => {
      resolve = accept;
    });
    const item = {} as ActiveOverride;
    const finish = (reason: OverrideCompletionReason) => {
      if (done) return;
      done = true;
      item.status = rejectedReason(reason) ? "rejected" : "finished";
      resolve({ id, reason });
    };
    const handle: OverrideHandle = Object.freeze({
      id,
      get status() {
        return item.status;
      },
      finished,
      cancel: () => {
        if (item.status === "active") this.#finish(item, "cancelled");
      },
    });
    Object.assign(item, {
      id,
      effect: Object.freeze({ channels: [], surfaces: [] }),
      input: Object.freeze({
        effect: Object.freeze({ channels: [] }),
        until: Object.freeze({ type: "manual" }),
      }),
      startedAt: 0,
      deadline: 0,
      status: "rejected" as const,
      patrolDirection: true,
      handle,
      finish,
    });
    return item;
  }

  #finish(item: ActiveOverride, reason: OverrideCompletionReason): void {
    const index = this.#active.indexOf(item);
    if (index >= 0) this.#active.splice(index, 1);
    item.finish(reason);
  }
}

function completionSource(name: string): PlanEventSource {
  return browserCompletionEvent(name) ? "browser" : "application";
}

export function rejectedOverrideHandle(
  id: string,
  reason: OverrideCompletionReason,
): OverrideHandle {
  return Object.freeze({
    id,
    status: "rejected" as const,
    finished: Promise.resolve({ id, reason }),
    cancel: () => {},
  });
}

function validateOverride(input: OverrideInput): OverrideInput {
  const value = snapshotOwnData(input) as OverrideInput;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      runtimeMessage("override.object", "override must be an object"),
    );
  }
  closed(value, ["effect", "until", "mode"], "override");
  if (!value.effect)
    throw new TypeError(
      runtimeMessage("override.effect", "override.effect is required"),
    );
  if (
    value.mode !== undefined &&
    value.mode !== "reject" &&
    value.mode !== "replace"
  ) {
    throw new TypeError(
      runtimeMessage(
        "override.mode",
        "override.mode must be reject or replace",
      ),
    );
  }
  const until: NonNullable<OverrideInput["until"]> =
    value.until === undefined
      ? Object.freeze({ type: "manual" as const })
      : value.until;
  if (!until || typeof until !== "object" || Array.isArray(until)) {
    throw new TypeError(
      runtimeMessage("override.until", "override.until must be an object"),
    );
  }
  if (until.type === "duration") {
    closed(until, ["type", "ms"], "override.until");
    boundedLifetime(until.ms, "override.until.ms");
  } else if (until.type === "event") {
    closed(until, ["type", "name", "timeout"], "override.until");
    if (
      typeof until.name !== "string" ||
      !EVENT_NAME_PATTERN.test(until.name)
    ) {
      throw new TypeError(
        runtimeMessage("override.until.name", "override.until.name is invalid"),
      );
    }
    if (isContinuousBrowserEvent(until.name)) {
      throw new TypeError(
        runtimeMessage(
          "override.until.name",
          "continuous browser Events cannot be completion Events",
        ),
      );
    }
    if (until.timeout !== undefined) {
      boundedLifetime(until.timeout, "override.until.timeout");
    }
  } else if (until.type === "manual") {
    closed(until, ["type", "maxMs"], "override.until");
    if (until.maxMs !== undefined) {
      boundedLifetime(until.maxMs, "override.until.maxMs");
    }
  } else {
    throw new TypeError(
      runtimeMessage("override.until.type", "override.until.type is invalid"),
    );
  }
  return Object.freeze({
    effect: value.effect,
    until,
    ...(value.mode === undefined ? {} : { mode: value.mode }),
  });
}

function lifetimeMs(input: OverrideInput): number {
  const until = input.until;
  if (until?.type === "duration") return until.ms;
  if (until?.type === "event" && until.timeout !== undefined)
    return until.timeout;
  if (until?.type === "manual" && until.maxMs !== undefined) return until.maxMs;
  return MAX_LIFETIME;
}

function boundedLifetime(value: unknown, path: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > MAX_LIFETIME
  ) {
    throw new TypeError(
      runtimeMessage(
        "override.lifetime",
        () => `${path} must be 1-${MAX_LIFETIME}`,
      ),
    );
  }
}

function closed(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new TypeError(
        runtimeMessage(
          "override.unknown-field",
          () => `${path}.${key} is unknown`,
        ),
      );
  }
}

function conflictingChannels(
  active: readonly ActiveOverride[],
  effect: CompiledPlanEffect,
): string[] {
  const channels = new Set<string>();
  for (const item of active) {
    for (const channel of item.effect.channels) {
      if (effect.channels.includes(channel)) channels.add(channel);
    }
  }
  return [...channels];
}

function rejectedReason(reason: OverrideCompletionReason): boolean {
  return (
    reason === "rejected" || reason === "conflict" || reason === "overflow"
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "invalid input";
}
