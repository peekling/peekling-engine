import type { ResolvedState, StateDefinition } from "./types.js";
import { runtimeMessage } from "./runtime-diagnostics.js";

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  click: ["waving", "happy", "alert"],
  "double-click": ["jumping", "happy", "waving"],
  "context-click": ["alert", "waving", "idle"],
  scroll: ["alert", "waving", "idle"],
  success: ["success", "happy", "jumping", "waving"],
  happy: ["happy", "success", "waving"],
  error: ["error", "failed", "alert"],
  sleep: ["sleep", "idle"],
};

export function resolveState(
  requested: string | undefined,
  states: Readonly<Record<string, StateDefinition>>,
): ResolvedState {
  const names = Object.keys(states);
  if (names.length === 0)
    throw new Error(
      runtimeMessage(
        "state.empty",
        "Cannot resolve a state from an empty pack",
      ),
    );
  const has = (name: string) => Object.hasOwn(states, name);
  if (requested && has(requested)) return { name: requested };

  if (requested) {
    for (const alias of Object.hasOwn(ALIASES, requested)
      ? ALIASES[requested]!
      : []) {
      if (has(alias)) return { name: alias };
    }
  }

  if (has("idle")) return { name: "idle" };
  return { name: names.sort()[0]! };
}
