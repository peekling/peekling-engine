import { DEFAULT_PERSISTENT_REQUEST_LIMIT, DEFAULT_SPEED } from "./defaults.js";
import {
  createPlanEventState,
  evaluatePlanEvent,
  selectCompiledEffectChannels,
  type CompiledPlan,
  type CompiledPlanEffect,
  type CompiledPlanSurface,
  type PlanEventEvaluation,
} from "./plan-compiler.js";
import { browserCompletionEvent } from "./events.js";
import {
  type BehaviorRequest,
  type HorizontalPatrolMotionEffect,
  type JumpToMotionEffect,
  type MotionRequest,
  type Plan,
  type PlanCapability,
  type PlanEventSource,
  type PeeklingPreset,
  type SvgPathMotionEffect,
  type TargetAnchor,
  type TargetSnapshot,
  type ViewportTraverseMotionEffect,
  type World,
} from "./types.js";

export function compiledPlanSectionRequirements(plan: CompiledPlan): {
  selectors: readonly string[];
  thresholds: readonly number[];
} {
  const selectors = new Set<string>();
  const thresholds = new Set<number>([0, 1]);
  for (const rule of plan.rules) {
    if (
      rule.when.source === "browser" &&
      rule.when.event === "section.visibility"
    ) {
      selectors.add(rule.when.selector);
      thresholds.add(rule.when.threshold ?? 0.25);
    }
  }
  return {
    selectors: [...selectors],
    thresholds: [...thresholds].sort((left, right) => left - right),
  };
}

/** The engine-owned default Plan policy. It uses the public Plan shape. */
export function createDefaultPlan(locomotion: boolean): Plan {
  return createPresetPlan("companion", locomotion);
}

/** Small named starting points that compile into the canonical Plan. */
export function createPresetPlan(
  preset: PeeklingPreset,
  locomotion: boolean,
): Plan {
  const state = locomotion
    ? ({ capability: "locomotion" } as const)
    : ({ state: "idle" } as const);
  if (preset === "still") {
    return {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
    };
  }
  if (preset === "bottom-patrol" || preset === "viewport-roam") {
    return {
      baseline: {
        channels: ["motion", "state"],
        state,
        motion:
          preset === "bottom-patrol"
            ? { type: "horizontal-patrol", speed: DEFAULT_SPEED }
            : { type: "viewport-traverse", speed: DEFAULT_SPEED },
      },
    };
  }
  return {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    ...(locomotion
      ? {
          rules: [
            {
              id: "follow-pointer",
              when: { source: "browser", event: "pointer.move" },
              effect: {
                channels: ["motion", "state"],
                motion: { type: "follow-pointer", speed: DEFAULT_SPEED },
                state: { capability: "locomotion" },
              },
            },
          ],
        }
      : {}),
  };
}

interface ActiveSurface {
  surface: CompiledPlanSurface;
  version: number;
}

interface ActiveInterrupt {
  effect: CompiledPlanEffect;
  deadline: number;
  version: number;
}

/** Instance-owned evaluator for one immutable compiled Plan. */
export class PlanRuntime {
  readonly #plan: CompiledPlan;
  readonly #eventState = createPlanEventState();
  readonly #activeChannels = new Map<
    "motion" | "state",
    readonly [CompiledPlanEffect, CompiledPlanEffect]
  >();
  readonly #activeSurfaces = new Map<string, ActiveSurface>();
  #patrolDirections = new WeakMap<CompiledPlanEffect, PatrolDirection>();
  #traversePhases = new WeakMap<CompiledPlanEffect, number>();
  #jumpOwner: CompiledPlanEffect | undefined;
  #jumpState: JumpState | undefined;
  #pathOwner: CompiledPlanEffect | undefined;
  #pathState: PathState | undefined;
  #activeInterrupts: ActiveInterrupt[] = [];
  #surfaceVersion = 0;
  #lastEventStatus: PlanEventEvaluation["status"] | undefined;
  #lastEventRejections: PlanEventEvaluation["rejectedSurfaces"] = [];

  constructor(plan: CompiledPlan) {
    this.#plan = plan;
  }

  get plan(): CompiledPlan {
    return this.#plan;
  }

  get lastEventStatus(): PlanEventEvaluation["status"] | undefined {
    return this.#lastEventStatus;
  }

  get lastEventRejections(): PlanEventEvaluation["rejectedSurfaces"] {
    return this.#lastEventRejections;
  }

  evaluate(world: Readonly<World>): BehaviorRequest {
    this.#lastEventStatus = undefined;
    this.#lastEventRejections = [];
    const reaction = world.reaction;
    this.#expireInterrupts(world.now);
    if (reaction) {
      const selected = evaluatePlanEvent(this.#plan, this.#eventState, {
        source: reaction.source,
        name: reaction.name,
        ...(reaction.payload === undefined
          ? {}
          : { payload: reaction.payload }),
      });
      this.#lastEventStatus = selected.status;
      this.#lastEventRejections = selected.rejectedSurfaces;
      if (
        selected.status !== "invalid" &&
        selected.status !== "stale" &&
        selected.status !== "closed"
      ) {
        this.#expireInterrupts(world.now, reaction.source, reaction.name);
      }
      if (selected.status === "matched") {
        const claimed = new Set<string>();
        selected.effects.forEach((effect, index) => {
          const available = effect.channels.filter(
            (channel) => !claimed.has(channel),
          );
          if (!available.length) return;
          for (const channel of available) claimed.add(channel);
          if (effect.until) {
            this.#startInterrupt(
              selectCompiledEffectChannels(effect, available)!,
              world.now,
            );
          } else {
            for (const channel of available) {
              if (channel === "motion" || channel === "state") {
                this.#activeChannels.set(channel, [
                  selected.rules[index]!.effect,
                  effect,
                ]);
              }
            }
            for (const surface of effect.surfaces) {
              if (available.includes(surface.channel)) {
                this.#applySurface(surface);
              }
            }
          }
        });
      }
    }

    const channels = new Map<string, CompiledPlanEffect>();
    for (const interrupt of this.#activeInterrupts) {
      for (const channel of interrupt.effect.channels) {
        channels.set(channel, interrupt.effect);
      }
    }
    for (const rule of this.#plan.rules) {
      const continuous = this.#isContinuous(rule, world);
      for (const channel of ["motion", "state"] as const) {
        if (channels.has(channel)) continue;
        const latched = this.#activeChannels.get(channel);
        const effect =
          continuous && rule.effect.channels.includes(channel)
            ? rule.effect
            : latched?.[0] === rule.effect
              ? latched[1]
              : undefined;
        if (effect) channels.set(channel, effect);
      }
    }
    for (const channel of this.#plan.baseline.channels) {
      if (!channels.has(channel)) channels.set(channel, this.#plan.baseline);
    }

    const output: BehaviorRequest = {};
    const state = channels.get("state")?.state;
    if (state?.kind === "state") output.state = state.name;
    if (state?.kind === "capability") {
      output.capability = state.name as PlanCapability;
    }
    const motionOwner = channels.get("motion");
    const motion = motionOwner?.motion;
    const settleCapability = () => {
      if (output.capability !== "locomotion") return;
      delete output.capability;
      const baseline = this.#baselineState();
      if (!output.state && baseline) output.state = baseline;
    };
    if (motion?.type !== "jump-to") {
      this.#jumpOwner = undefined;
      this.#jumpState = undefined;
    }
    if (motion?.type !== "svg-path") {
      this.#pathOwner = undefined;
      this.#pathState = undefined;
    }
    if (motion?.type === "horizontal-patrol" && world.characterSize) {
      const [direction, request] = evaluateHorizontalPatrol(
        motion,
        world as PatrolWorld,
        this.#patrolDirections.get(motionOwner!) ?? true,
      );
      this.#patrolDirections.set(motionOwner!, direction);
      if (request) output.motion = request;
    } else if (motion?.type === "viewport-traverse" && world.characterSize) {
      const [phase, request] = evaluateViewportTraverse(
        motion,
        world as PatrolWorld,
        this.#traversePhases.get(motionOwner!),
      );
      this.#traversePhases.set(motionOwner!, phase);
      if (request) output.motion = request;
    } else if (motion?.type === "follow-pointer") {
      const request = world.pointer
        ? motionToward(
            motion,
            world.position,
            world.pointer.x,
            world.pointer.y,
            motion.arrivalRadius,
            world,
          )
        : undefined;
      if (request) output.motion = request;
      else settleCapability();
    } else if (motion?.type === "move-to") {
      const request = motionToward(
        motion,
        world.position,
        motion.x,
        motion.y,
        motion.arrivalRadius,
        world,
      );
      if (request) output.motion = request;
      else settleCapability();
    } else if (motion?.type === "move-to-target") {
      const target = world.targets?.[motion.target];
      const point =
        target && world.characterSize
          ? targetPoint(target, motion.anchor, world.characterSize)
          : undefined;
      const request = point
        ? motionToward(
            motion,
            world.position,
            point.x,
            point.y,
            motion.arrivalRadius,
            world,
          )
        : undefined;
      if (request) output.motion = { ...request, trackTarget: true };
      else settleCapability();
    } else if (motion?.type === "jump-to") {
      const request = this.#evaluateJump(motionOwner!, motion, world);
      if (request) output.motion = request;
      else settleCapability();
    } else if (motion?.type === "svg-path") {
      const request = this.#evaluatePath(motionOwner!, motion, world);
      if (request) output.motion = request;
      else settleCapability();
    }

    const selected = new Map<string, ActiveSurface>();
    for (const surface of this.#plan.baseline.surfaces) {
      selected.set(surface.channel, { surface, version: 0 });
    }
    for (const active of this.#activeSurfaces.values()) {
      selected.set(active.surface.channel, active);
    }
    for (const interrupt of this.#activeInterrupts) {
      for (const surface of interrupt.effect.surfaces) {
        selected.set(surface.channel, {
          surface,
          version: interrupt.version,
        });
      }
    }
    if (selected.size) {
      output.surfaces = Object.freeze(
        [...selected.values()].map(({ surface, version }) =>
          Object.freeze({
            id: surface.id,
            channel: surface.channel,
            contentId: surface.contentId,
            ...(surface.data === undefined ? {} : { data: surface.data }),
            key: `${surface.channel}:${version}`,
          }),
        ),
      );
    }
    if (reaction && this.#lastEventStatus === "matched") {
      output.reactionId = reaction.id;
    }
    return output;
  }

  reset(): void {
    this.#activeChannels.clear();
    this.#activeSurfaces.clear();
    this.#activeInterrupts = [];
    this.#patrolDirections = new WeakMap();
    this.#traversePhases = new WeakMap();
    this.#jumpOwner = undefined;
    this.#jumpState = undefined;
    this.#pathOwner = undefined;
    this.#pathState = undefined;
    this.#eventState.ordering.clear();
    this.#eventState.sessions.clear();
    this.#lastEventStatus = undefined;
    this.#lastEventRejections = [];
  }

  nextWakeAt(): number | undefined {
    return this.#activeInterrupts.reduce<number | undefined>(
      (earliest, interrupt) => {
        if (!Number.isFinite(interrupt.deadline)) return earliest;
        return earliest === undefined
          ? interrupt.deadline
          : Math.min(earliest, interrupt.deadline);
      },
      undefined,
    );
  }

  rebase(delta: number): void {
    if (!delta) return;
    this.#activeInterrupts = this.#activeInterrupts.map((interrupt) => ({
      ...interrupt,
      deadline: interrupt.deadline + delta,
    }));
  }

  #baselineState(): string | undefined {
    const state = this.#plan.baseline.state;
    return state?.kind === "state" ? state.name : undefined;
  }

  #evaluateJump(
    owner: CompiledPlanEffect,
    effect: Readonly<JumpToMotionEffect>,
    world: Readonly<World>,
  ): MotionRequest | undefined {
    if (this.#jumpOwner !== owner || !this.#jumpState) {
      this.#jumpOwner = owner;
      this.#jumpState = {
        startedAt: world.now,
        from: { ...world.position },
      };
    }
    const duration = effect.duration ?? 800;
    const progress = Math.max(
      0,
      Math.min(1, (world.now - this.#jumpState.startedAt) / duration),
    );
    const target = boundedPoint(effect, world);
    const desired = {
      x:
        this.#jumpState.from.x + (target.x - this.#jumpState.from.x) * progress,
      y:
        this.#jumpState.from.y + (target.y - this.#jumpState.from.y) * progress,
    };
    const lift =
      progress === 0 || progress === 1
        ? 0
        : Math.sin(Math.PI * progress) *
          (effect.height ?? world.characterSize?.height ?? 32);
    const request = directMotion(world.position, desired, lift);
    if (progress < 1 || request.maxDistance) return request;
    return;
  }

  #evaluatePath(
    owner: CompiledPlanEffect,
    effect: Readonly<SvgPathMotionEffect>,
    world: Readonly<World>,
  ): MotionRequest | undefined {
    const sample = world.samplePath;
    if (!sample) return;
    const first = sample(effect.path, 0);
    if (!first) return;
    if (this.#pathOwner !== owner || !this.#pathState) {
      this.#pathOwner = owner;
      this.#pathState = {
        startedAt: world.now,
        offset:
          effect.relative === false
            ? { x: 0, y: 0 }
            : {
                x: world.position.x - first.x,
                y: world.position.y - first.y,
              },
      };
    }
    const duration = effect.duration ?? 4_000;
    const elapsed = Math.max(0, world.now - this.#pathState.startedAt);
    const complete = effect.loop !== true && elapsed >= duration;
    const progress = effect.loop
      ? (elapsed % duration) / duration
      : Math.min(1, elapsed / duration);
    const point = sample(effect.path, progress);
    if (!point) return;
    const desired = {
      x: point.x + this.#pathState.offset.x,
      y: point.y + this.#pathState.offset.y,
    };
    const request = directMotion(world.position, boundedPoint(desired, world));
    if (!complete || request.maxDistance) return request;
    return;
  }

  #isContinuous(
    rule: CompiledPlan["rules"][number],
    world: Readonly<World>,
  ): boolean {
    const condition = rule.when;
    if (condition.source !== "browser") return false;
    if (condition.event === "pointer.move") {
      if (!world.pointer) return false;
      const motion = rule.effect.motion;
      if (!motion || motion.type !== "follow-pointer") return true;
      return Boolean(
        motionToward(
          motion,
          world.position,
          world.pointer.x,
          world.pointer.y,
          motion.arrivalRadius,
          world,
        ),
      );
    }
    if (condition.event !== "section.visibility") return false;
    const section = world.sections?.[condition.selector];
    const threshold = condition.threshold ?? 0.25;
    return (
      condition.phase === "while-visible" && (section?.ratio ?? 0) >= threshold
    );
  }

  #applySurface(surface: CompiledPlanSurface): void {
    const current = this.#activeSurfaces.get(surface.channel);
    if (surface.disposition === "ignore") return;
    const next =
      surface.disposition === "update" && current
        ? { ...surface, contentId: current.surface.contentId }
        : surface;
    this.#activeSurfaces.set(surface.channel, {
      surface: Object.freeze(next),
      version: ++this.#surfaceVersion,
    });
  }

  #startInterrupt(effect: CompiledPlanEffect, now: number): void {
    const lifetime = effect.until!;
    const duration =
      lifetime.type === "duration"
        ? lifetime.ms
        : (lifetime.timeout ?? DEFAULT_PERSISTENT_REQUEST_LIMIT);
    const deadline = now + duration;
    if (!Number.isFinite(deadline)) return;
    this.#activeInterrupts = this.#activeInterrupts.filter(
      (active) =>
        !active.effect.channels.some((channel) =>
          effect.channels.includes(channel),
        ),
    );
    this.#activeInterrupts.push({
      effect,
      deadline,
      version: ++this.#surfaceVersion,
    });
  }

  #expireInterrupts(
    now: number,
    eventSource?: PlanEventSource,
    eventName?: string,
  ): void {
    this.#activeInterrupts = this.#activeInterrupts.filter((active) => {
      if (now >= active.deadline) return false;
      const until = active.effect.until!;
      return !(
        eventSource !== undefined &&
        eventName !== undefined &&
        until.type === "event" &&
        completionSource(until.name) === eventSource &&
        until.name === eventName
      );
    });
  }
}

function completionSource(name: string): PlanEventSource {
  return browserCompletionEvent(name) ? "browser" : "application";
}

interface JumpState {
  readonly startedAt: number;
  readonly from: Readonly<{ x: number; y: number }>;
}

interface PathState {
  readonly startedAt: number;
  readonly offset: Readonly<{ x: number; y: number }>;
}

export type PatrolDirection = boolean;

interface PatrolWorld {
  readonly position: Readonly<{ x: number; y: number }>;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly characterSize: Readonly<{ width: number; height: number }>;
}

export function evaluateHorizontalPatrol(
  effect: Readonly<HorizontalPatrolMotionEffect>,
  world: Readonly<PatrolWorld>,
  direction: PatrolDirection,
): readonly [PatrolDirection, MotionRequest | undefined] {
  const halfWidth = world.characterSize.width / 2;
  const inset = effect.edgeInset ?? 0;
  const left = Math.min(world.viewport.width / 2, halfWidth + inset);
  const right = world.viewport.width - left;
  const halfHeight = world.characterSize.height / 2;
  const y = Math.max(halfHeight, world.viewport.height - halfHeight);
  let request = motionToward(
    effect,
    world.position,
    direction ? right : left,
    y,
  );
  if (!request) {
    direction = !direction;
    request = motionToward(effect, world.position, direction ? right : left, y);
  }
  return [direction, request];
}

export function evaluateViewportTraverse(
  effect: Readonly<ViewportTraverseMotionEffect>,
  world: Readonly<PatrolWorld>,
  phase?: number,
): readonly [number, MotionRequest | undefined] {
  const inset = effect.edgeInset ?? 0;
  const halfWidth = world.characterSize.width / 2;
  const halfHeight = world.characterSize.height / 2;
  const left = Math.min(world.viewport.width / 2, halfWidth + inset);
  const right = Math.max(left, world.viewport.width - left);
  const top = Math.min(world.viewport.height / 2, halfHeight + inset);
  const bottom = Math.max(top, world.viewport.height - halfHeight - inset);
  const points = [
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: right, y: top },
    { x: left, y: top },
  ] as const;
  if (phase === undefined) {
    phase = points.reduce(
      (nearest, point, index) =>
        Math.hypot(point.x - world.position.x, point.y - world.position.y) <
        Math.hypot(
          points[nearest]!.x - world.position.x,
          points[nearest]!.y - world.position.y,
        )
          ? index
          : nearest,
      0,
    );
  }
  let target = points[phase]!;
  let request = motionToward(effect, world.position, target.x, target.y);
  if (!request) {
    const direction = effect.clockwise === false ? -1 : 1;
    phase = (phase + direction + points.length) % points.length;
    target = points[phase]!;
    request = motionToward(effect, world.position, target.x, target.y);
  }
  return [phase, request];
}

function targetPoint(
  target: Readonly<TargetSnapshot>,
  anchor: TargetAnchor = "center",
  character: Readonly<{ width: number; height: number }>,
): { x: number; y: number } {
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

function boundedPoint(
  point: Readonly<{ x: number; y: number }>,
  world: Readonly<Pick<World, "viewport" | "characterSize">>,
): { x: number; y: number } {
  const size = world.characterSize;
  if (!size) return { x: point.x, y: point.y };
  return {
    x: Math.max(
      size.width / 2,
      Math.min(world.viewport.width - size.width / 2, point.x),
    ),
    y: Math.max(
      size.height / 2,
      Math.min(world.viewport.height - size.height / 2, point.y),
    ),
  };
}

function directMotion(
  position: Readonly<{ x: number; y: number }>,
  target: Readonly<{ x: number; y: number }>,
  lift = 0,
): MotionRequest {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distance = Math.hypot(dx, dy);
  return {
    x: distance ? dx / distance : 0,
    y: distance ? dy / distance : 0,
    speed: 0,
    maxDistance: distance,
    lift,
    direct: true,
  };
}

export function motionToward(
  effect: Readonly<{ speed?: number }>,
  position: Readonly<{ x: number; y: number }>,
  x: number,
  y: number,
  arrivalRadius = 0,
  bounds?: Readonly<Partial<Pick<World, "viewport" | "characterSize">>>,
): MotionRequest | undefined {
  const size = bounds?.characterSize;
  const viewport = bounds?.viewport;
  if (size && viewport) {
    const pointerX = x;
    const pointerY = y;
    x = Math.max(size.width / 2, Math.min(viewport.width - size.width / 2, x));
    y = Math.max(
      size.height / 2,
      Math.min(viewport.height - size.height / 2, y),
    );
    if (x !== pointerX || y !== pointerY) arrivalRadius = 0;
  }
  const dx = x - position.x;
  const dy = y - position.y;
  const distance = Math.hypot(dx, dy);
  const maxDistance = distance - arrivalRadius;
  if (maxDistance <= 4) return;
  return {
    x: dx / distance,
    y: dy / distance,
    speed: effect.speed ?? DEFAULT_SPEED,
    maxDistance,
  };
}
