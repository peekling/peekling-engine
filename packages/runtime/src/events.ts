import type { JsonValue, PlanBrowserEvent } from "./types.js";
import { OwnDataError, snapshotOwnData } from "./own-data.js";
import { runtimeMessage } from "./runtime-diagnostics.js";

const EVENT_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const EVENT_PAYLOAD_POLICY = Object.freeze({
  json: true,
  key: (value: string) => EVENT_KEY.test(value),
  maxArrayLength: 64,
  maxDepth: 6,
  maxObjectKeys: 64,
  maxStringLength: 2_048,
  maxValues: 256,
});
let eventPayloadEncoder: TextEncoder | undefined;

export function browserCompletionEvent(
  name: string,
): PlanBrowserEvent | undefined {
  switch (name) {
    case "pointer.click":
    case "document.visibility":
    case "window.focus":
    case "window.scroll":
    case "page.lifecycle":
      return name;
    default:
      return undefined;
  }
}

export function isContinuousBrowserEvent(name: string): boolean {
  return name === "pointer.move" || name === "section.visibility";
}

export function validateEventPayload(input: unknown): JsonValue | undefined {
  if (input === undefined) return undefined;
  let result: JsonValue;
  try {
    result = snapshotOwnData(input, EVENT_PAYLOAD_POLICY) as JsonValue;
  } catch (cause) {
    if (cause instanceof OwnDataError) {
      switch (cause.issueCode) {
        case "data.array":
          throw new TypeError(
            runtimeMessage("event.array-limit", "Event array exceeds 64 items"),
          );
        case "data.cycle":
        case "data.depth":
        case "data.nodes":
          throw new TypeError(
            runtimeMessage("event.complexity", "Event payload is too complex"),
          );
        case "data.key":
          throw new TypeError(
            runtimeMessage("event.key", "Event payload key is invalid"),
          );
        case "data.keys":
          throw new TypeError(
            runtimeMessage("event.key-limit", "Event object exceeds 64 keys"),
          );
        case "data.string":
          throw new TypeError(
            runtimeMessage(
              "event.string-limit",
              "Event payload string exceeds 2048 characters",
            ),
          );
      }
    }
    throw new TypeError(
      runtimeMessage("event.payload", "Event payload must be JSON-like data"),
    );
  }
  if (
    (eventPayloadEncoder ??= new TextEncoder()).encode(JSON.stringify(result))
      .byteLength > 8_192
  ) {
    throw new TypeError(
      runtimeMessage("event.size", "Event payload exceeds 8 KiB"),
    );
  }
  return result;
}
