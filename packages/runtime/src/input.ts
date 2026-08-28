import type {
  JsonValue,
  PlanBrowserEvent,
  PlanEventSource,
  Point,
  ReactionEvent,
} from "./types.js";
import { runtimeMessage } from "./runtime-diagnostics.js";

type ListenerBinding = [
  target: EventTarget,
  type: string,
  listener: EventListener,
  active: boolean,
  persistent: boolean,
];

export class InputCollector {
  pointer: Point | undefined;
  readonly reactions: ReactionEvent[] = [];
  lastActivityAt: number;
  #nextReactionId = 1;
  readonly #listeners: ListenerBinding[] = [];
  readonly #events = new Map<
    PlanBrowserEvent,
    [references: number, bindings: ListenerBinding[]]
  >();
  readonly #document: Document;
  readonly #window: Window;
  readonly #now: () => number;
  readonly #wake: () => void;
  readonly #diagnostic: (message: string) => void;
  readonly #coalesce: ReadonlyMap<
    string,
    true | { sessionField: string; revisionField: string }
  >;
  #suspended = false;

  constructor(
    document: Document,
    window: Window,
    options: {
      events: ReadonlySet<PlanBrowserEvent>;
      coalesce?: ReadonlyMap<
        string,
        true | { sessionField: string; revisionField: string }
      >;
      diagnostic?: (message: string) => void;
      now: () => number;
      wake: () => void;
    },
  ) {
    this.#document = document;
    this.#window = window;
    this.#now = options.now;
    this.#wake = options.wake;
    this.#diagnostic = options.diagnostic ?? (() => {});
    this.lastActivityAt = options.now();

    this.#listen(window, "resize", () => this.#wake());
    for (const event of options.events) this.#retainEvent(event);
    this.#coalesce = options.coalesce ?? new Map();
  }

  get reaction(): ReactionEvent | undefined {
    return this.reactions[0];
  }

  captureReaction(
    name: string,
    payload?: JsonValue,
    source: PlanEventSource = "application",
  ):
    | { accepted: true; id: number; coalesced: boolean }
    | { accepted: false; reason: "queue-full" } {
    const at = this.#now();
    const last = this.reactions.at(-1);
    const policy = this.#coalesce.get(`${source}:${name}`);
    const coalesced = Boolean(
      last?.name === name &&
      last.source === source &&
      (policy === true ||
        (policy !== undefined && newerRevision(last.payload, payload, policy))),
    );
    if (!coalesced && this.reactions.length >= 32) {
      this.#diagnostic(
        runtimeMessage(
          "event.queue-full",
          "Event queue overflow rejected the newest event",
        ),
      );
      return { accepted: false, reason: "queue-full" };
    }
    // A coalesced queue tail keeps its original ID so acceptance and
    // consumption continue to refer to the same logical event.
    const reaction = {
      id: coalesced ? last!.id : this.#nextReactionId++,
      source,
      name,
      at,
      ...(payload === undefined ? {} : { payload }),
    };
    if (coalesced) this.reactions[this.reactions.length - 1] = reaction;
    else this.reactions.push(reaction);
    this.lastActivityAt = at;
    this.#wake();
    return { accepted: true, id: reaction.id, coalesced };
  }

  consumeReaction(id: number): void {
    if (this.reactions[0]?.id === id) this.reactions.shift();
  }

  retainEvent(event: PlanBrowserEvent): () => void {
    this.#retainEvent(event);
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      this.#releaseEvent(event);
    };
  }

  setSuspended(value: boolean): void {
    if (value === this.#suspended) return;
    this.#suspended = value;
    for (const binding of this.#listeners) {
      if (value && binding[3] && !binding[4]) {
        binding[0].removeEventListener(binding[1], binding[2]);
        binding[3] = false;
      } else if (!value && !binding[3]) {
        binding[0].addEventListener(binding[1], binding[2], { passive: true });
        binding[3] = true;
      }
    }
    if (value) this.pointer = undefined;
  }

  destroy(): void {
    for (const binding of this.#listeners.splice(0)) {
      if (binding[3]) binding[0].removeEventListener(binding[1], binding[2]);
    }
    this.pointer = undefined;
    this.reactions.length = 0;
    this.#events.clear();
  }

  #retainEvent(event: PlanBrowserEvent): void {
    const retained = this.#events.get(event);
    if (retained) {
      retained[0] += 1;
      return;
    }
    const bindings: ListenerBinding[] = [];
    this.#events.set(event, [1, bindings]);
    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListener,
      persistent = false,
    ) => bindings.push(this.#listen(target, type, listener, persistent));
    if (event === "pointer.move") {
      listen(this.#document, "pointerdown", (input) => {
        const pointer = input as PointerEvent;
        if (pointer.pointerType === "touch" || pointer.pointerType === "pen") {
          this.#capturePointer(pointer);
        }
      });
      listen(this.#document, "pointermove", (input) =>
        this.#capturePointer(input as PointerEvent),
      );
      const clearTouch = (input: Event) => {
        const type = (input as PointerEvent).pointerType;
        if (type === "touch" || type === "pen") this.#clearPointer();
      };
      listen(this.#document, "pointerup", clearTouch);
      listen(this.#document, "pointercancel", clearTouch);
      listen(this.#document, "pointerout", (input) => {
        if ((input as PointerEvent).relatedTarget === null)
          this.#clearPointer();
      });
      listen(this.#window, "blur", () => this.#clearPointer());
    } else if (event === "pointer.click") {
      listen(this.#document, "click", (input) =>
        this.#captureObserved("pointer.click", input),
      );
    } else if (event === "document.visibility") {
      listen(
        this.#document,
        "visibilitychange",
        () =>
          this.captureReaction(
            "document.visibility",
            { visible: !this.#document.hidden },
            "browser",
          ),
        true,
      );
    } else if (event === "window.scroll") {
      listen(this.#window, "scroll", (input) =>
        this.#captureObserved("window.scroll", input),
      );
    } else if (event === "window.focus") {
      listen(this.#window, "focus", () =>
        this.captureReaction("window.focus", { focused: true }, "browser"),
      );
      listen(this.#window, "blur", () =>
        this.captureReaction("window.focus", { focused: false }, "browser"),
      );
    }
  }

  #releaseEvent(event: PlanBrowserEvent): void {
    const retained = this.#events.get(event);
    if (!retained) return;
    if (retained[0] > 1) {
      retained[0] -= 1;
      return;
    }
    this.#events.delete(event);
    for (const binding of retained[1]) {
      if (binding[3]) binding[0].removeEventListener(binding[1], binding[2]);
      const index = this.#listeners.indexOf(binding);
      if (index >= 0) this.#listeners.splice(index, 1);
    }
  }

  #clearPointer(): void {
    if (this.#suspended) return;
    if (!this.pointer) return;
    this.pointer = undefined;
    this.lastActivityAt = this.#now();
    this.#wake();
  }

  #capturePointer(pointer: PointerEvent): void {
    if (this.#suspended) return;
    this.pointer = { x: pointer.clientX, y: pointer.clientY };
    this.lastActivityAt = this.#now();
    this.#wake();
  }

  #captureObserved(name: PlanBrowserEvent, event: Event): void {
    if (this.#suspended) return;
    if (
      event
        .composedPath()
        .some(
          (target) =>
            "hasAttribute" in target &&
            typeof target.hasAttribute === "function" &&
            target.hasAttribute("data-peekling-controls"),
        )
    )
      return;
    const pointer = event as PointerEvent;
    const payload =
      Number.isFinite(pointer.clientX) && Number.isFinite(pointer.clientY)
        ? { x: pointer.clientX, y: pointer.clientY }
        : undefined;
    this.captureReaction(name, payload, "browser");
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    persistent = false,
  ): ListenerBinding {
    const options: AddEventListenerOptions = { passive: true };
    target.addEventListener(type, listener, options);
    const binding: ListenerBinding = [target, type, listener, true, persistent];
    this.#listeners.push(binding);
    return binding;
  }
}

function newerRevision(
  previous: JsonValue | undefined,
  next: JsonValue | undefined,
  policy: { sessionField: string; revisionField: string },
): boolean {
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object" ||
    Array.isArray(previous) ||
    Array.isArray(next)
  )
    return false;
  const prior = previous as Readonly<Record<string, JsonValue>>;
  const incoming = next as Readonly<Record<string, JsonValue>>;
  return (
    incoming[policy.sessionField] === prior[policy.sessionField] &&
    Number.isSafeInteger(incoming[policy.revisionField]) &&
    Number.isSafeInteger(prior[policy.revisionField]) &&
    (incoming[policy.revisionField] as number) >
      (prior[policy.revisionField] as number)
  );
}
