import type { LocomotionKeyframe, StateDefinition } from "./types.js";

export function animationCycleMs(state: StateDefinition): number {
  if (state.durations)
    return state.durations.reduce((sum, value) => sum + value, 0);
  return (state.frames.length / (state.fps ?? 1)) * 1000;
}

export function locomotionSample(
  keyframes: readonly Readonly<LocomotionKeyframe>[] | undefined,
  phase: number,
): { advance: number; lift: number } {
  const normalized = ((phase % 1) + 1) % 1;
  if (!keyframes?.length) return { advance: normalized, lift: 0 };
  const nextIndex = keyframes.findIndex((item) => item.at >= normalized);
  const next = keyframes[nextIndex < 0 ? keyframes.length - 1 : nextIndex]!;
  const previous =
    keyframes[
      Math.max(0, (nextIndex < 0 ? keyframes.length - 1 : nextIndex) - 1)
    ]!;
  if (next.at === previous.at)
    return { advance: next.advance, lift: next.lift };
  const amount = (normalized - previous.at) / (next.at - previous.at);
  return {
    advance: previous.advance + (next.advance - previous.advance) * amount,
    lift: previous.lift + (next.lift - previous.lift) * amount,
  };
}

export function locomotionAdvance(
  keyframes: readonly Readonly<LocomotionKeyframe>[] | undefined,
  fromCycles: number,
  toCycles: number,
): number {
  const whole = Math.floor(toCycles) - Math.floor(fromCycles);
  const cycleAdvance = keyframes?.length
    ? keyframes.at(-1)!.advance - keyframes[0]!.advance
    : 1;
  return (
    whole * cycleAdvance +
    locomotionSample(keyframes, toCycles).advance -
    locomotionSample(keyframes, fromCycles).advance
  );
}
