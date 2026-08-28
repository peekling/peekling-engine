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
  type Plan,
  type PlanCapability,
  type PlanEventSource,
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
    const motion = channels.get("motion")?.motion;
    if (motion && world.pointer) {
      const dx = world.pointer.x - world.position.x;
      const dy = world.pointer.y - world.position.y;
      const distance = Math.hypot(dx, dy);
      const arrivalRadius = motion.arrivalRadius ?? 0;
      if (distance > arrivalRadius) {
        output.motion = {
          x: dx / distance,
          y: dy / distance,
          speed: motion.speed ?? DEFAULT_SPEED,
          maxDistance: distance - arrivalRadius,
        };
      } else if (channels.get("motion") === channels.get("state")) {
        delete output.capability;
        const baseline = this.#baselineState();
        if (!output.state && baseline) output.state = baseline;
      }
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

  #isContinuous(
    rule: CompiledPlan["rules"][number],
    world: Readonly<World>,
  ): boolean {
    const condition = rule.when;
    if (condition.source !== "browser") return false;
    if (condition.event === "pointer.move") {
      if (!world.pointer) return false;
      const motion = rule.effect.motion;
      if (!motion) return true;
      return (
        Math.hypot(
          world.pointer.x - world.position.x,
          world.pointer.y - world.position.y,
        ) > (motion.arrivalRadius ?? 0)
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
