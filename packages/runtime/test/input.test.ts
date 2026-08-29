import assert from "node:assert/strict";
import test from "node:test";
import { validateEventPayload } from "../dist/events.js";
import { InputCollector } from "../dist/input.js";

function pointerEvent(type: string, pointerType: string, x = 0, y = 0): Event {
  const event = new Event(type);
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    clientX: { value: x },
    clientY: { value: y },
    relatedTarget: { value: null },
  });
  return event;
}

test("only declared browser Events are observed and normalized", () => {
  const documentTarget = new EventTarget();
  const windowTarget = new EventTarget();
  let wakes = 0;
  const input = new InputCollector(
    documentTarget as unknown as Document,
    windowTarget as unknown as Window,
    {
      events: new Set(["pointer.move", "pointer.click", "window.scroll"]),
      now: () => 10,
      wake: () => wakes++,
    },
  );

  documentTarget.dispatchEvent(pointerEvent("pointermove", "mouse", 40, 80));
  assert.deepEqual(input.pointer, { x: 40, y: 80 });
  documentTarget.dispatchEvent(pointerEvent("click", "mouse", 40, 80));
  windowTarget.dispatchEvent(new Event("scroll"));
  assert.equal(input.pointer, undefined);
  assert.deepEqual(
    input.reactions.map(({ source, name }) => ({ source, name })),
    [
      { source: "browser", name: "pointer.click" },
      { source: "browser", name: "window.scroll" },
    ],
  );
  assert.ok(wakes > 0);

  input.destroy();
  const count = input.reactions.length;
  documentTarget.dispatchEvent(pointerEvent("click", "mouse"));
  assert.equal(input.reactions.length, count);
});

test("window scroll releases pointer motion until the next pointer observation", () => {
  const documentTarget = new EventTarget();
  const windowTarget = new EventTarget();
  const input = new InputCollector(
    documentTarget as unknown as Document,
    windowTarget as unknown as Window,
    {
      events: new Set(["pointer.move", "window.scroll"]),
      now: () => 15,
      wake: () => {},
    },
  );

  documentTarget.dispatchEvent(pointerEvent("pointermove", "mouse", 80, 120));
  assert.deepEqual(input.pointer, { x: 80, y: 120 });

  windowTarget.dispatchEvent(new Event("scroll"));
  assert.equal(input.pointer, undefined);
  assert.equal(input.reaction?.name, "window.scroll");

  documentTarget.dispatchEvent(pointerEvent("pointermove", "mouse", 160, 240));
  assert.deepEqual(input.pointer, { x: 160, y: 240 });
  input.destroy();
});

for (const pointerType of ["touch", "pen"]) {
  test(`${pointerType} pointer tracking ends with the contact`, () => {
    const documentTarget = new EventTarget();
    const input = new InputCollector(
      documentTarget as unknown as Document,
      new EventTarget() as unknown as Window,
      {
        events: new Set(["pointer.move"]),
        now: () => 20,
        wake: () => {},
      },
    );
    documentTarget.dispatchEvent(
      pointerEvent("pointerdown", pointerType, 4, 8),
    );
    assert.deepEqual(input.pointer, { x: 4, y: 8 });
    documentTarget.dispatchEvent(pointerEvent("pointerup", pointerType));
    assert.equal(input.pointer, undefined);
    input.destroy();
  });
}

test("click-only observation never captures a stale touch pointer", () => {
  const documentTarget = new EventTarget();
  const input = new InputCollector(
    documentTarget as unknown as Document,
    new EventTarget() as unknown as Window,
    {
      events: new Set(["pointer.click"]),
      now: () => 20,
      wake: () => {},
    },
  );

  documentTarget.dispatchEvent(pointerEvent("pointerdown", "touch", 4, 8));
  assert.equal(input.pointer, undefined);
  input.destroy();
});

test("visibility observation remains attached while ordinary input is parked", () => {
  const documentTarget = new EventTarget() as EventTarget & {
    hidden: boolean;
  };
  documentTarget.hidden = false;
  const input = new InputCollector(
    documentTarget as unknown as Document,
    new EventTarget() as unknown as Window,
    {
      events: new Set(["document.visibility", "pointer.click"]),
      now: () => 30,
      wake: () => {},
    },
  );
  input.setSuspended(true);
  documentTarget.hidden = true;
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  documentTarget.dispatchEvent(pointerEvent("click", "mouse", 10, 20));
  documentTarget.hidden = false;
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(
    input.reactions.map(({ name, payload }) => ({ name, payload })),
    [
      { name: "document.visibility", payload: { visible: false } },
      { name: "document.visibility", payload: { visible: true } },
    ],
  );
  input.destroy();
});

test("accepted Events stay FIFO and capacity rejects without eviction", () => {
  const diagnostics: string[] = [];
  const input = new InputCollector(
    new EventTarget() as unknown as Document,
    new EventTarget() as unknown as Window,
    {
      events: new Set(),
      now: () => 40,
      wake: () => {},
      diagnostic: (message) => diagnostics.push(message),
    },
  );
  assert.deepEqual(input.captureReaction("app.first"), {
    accepted: true,
    id: 1,
    coalesced: false,
  });
  assert.deepEqual(input.captureReaction("app.first"), {
    accepted: true,
    id: 2,
    coalesced: false,
  });
  input.captureReaction("pointer.click", undefined, "browser");
  for (let index = 3; index < 32; index++) {
    input.captureReaction(`app.event-${index}`);
  }
  assert.equal(input.reactions.length, 32);
  const first = input.reactions[0];
  assert.deepEqual(input.captureReaction("app.overflow"), {
    accepted: false,
    reason: "queue-full",
  });
  assert.equal(input.reactions.length, 32);
  assert.equal(input.reactions[0], first, "accepted work is never evicted");
  assert.deepEqual(
    input.reactions.slice(0, 3).map(({ id, source, name }) => ({
      id,
      source,
      name,
    })),
    [
      { id: 1, source: "application", name: "app.first" },
      { id: 2, source: "application", name: "app.first" },
      { id: 3, source: "browser", name: "pointer.click" },
    ],
  );
  assert.ok(diagnostics.some((message) => message.includes("overflow")));
  input.destroy();
  assert.equal(input.reactions.length, 0);
});

test("captured Event data has no private lock field", () => {
  const input = new InputCollector(
    new EventTarget() as unknown as Document,
    new EventTarget() as unknown as Window,
    {
      events: new Set(),
      now: () => 45,
      wake: () => {},
    },
  );

  input.captureReaction("app.payload", { value: 42 });
  assert.deepEqual(input.reaction?.payload, { value: 42 });
  assert.equal(Object.hasOwn(input.reaction ?? {}, "lock"), false);
  input.destroy();
});

test("only Plan-approved latest streams coalesce at the queue tail", () => {
  const input = new InputCollector(
    new EventTarget() as unknown as Document,
    new EventTarget() as unknown as Window,
    {
      events: new Set(),
      coalesce: new Map([
        [
          "application:sync.progress",
          { sessionField: "sessionId", revisionField: "revision" },
        ],
      ]),
      now: () => 50,
      wake: () => {},
    },
  );
  const first = input.captureReaction("sync.progress", {
    sessionId: "sync-1",
    revision: 1,
  });
  const latest = input.captureReaction("sync.progress", {
    sessionId: "sync-1",
    revision: 2,
  });
  assert.deepEqual(first, { accepted: true, id: 1, coalesced: false });
  assert.deepEqual(latest, { accepted: true, id: 1, coalesced: true });
  assert.equal(input.reactions.length, 1);
  assert.deepEqual(input.reaction?.payload, {
    sessionId: "sync-1",
    revision: 2,
  });

  input.captureReaction("sync.progress", {
    sessionId: "sync-1",
    revision: 1,
  });
  assert.equal(
    input.reactions.length,
    2,
    "a stale arrival remains FIFO for evaluation",
  );

  input.captureReaction("app.discrete");
  input.captureReaction("sync.progress", {
    sessionId: "sync-2",
    revision: 0,
  });
  assert.deepEqual(
    input.reactions.map(({ name }) => name),
    ["sync.progress", "sync.progress", "app.discrete", "sync.progress"],
    "coalescing never moves a newer Event ahead of an intervening fact",
  );
  input.destroy();
});

test("async event payloads are JSON-like and bounded", () => {
  const payload = validateEventPayload({ ok: true, values: [1, "two"] }) as {
    ok: boolean;
    values: readonly unknown[];
  };
  assert.equal(payload.ok, true);
  assert.deepEqual([...payload.values], [1, "two"]);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.values), true);
  assert.throws(() => validateEventPayload({ execute: () => {} }), /JSON-like/);
  assert.throws(
    () => validateEventPayload({ value: "x".repeat(2_049) }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "Event payload string exceeds 2048 characters",
  );
  assert.throws(
    () => validateEventPayload({ value: "x".repeat(9_000) }),
    /2048 characters/,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => validateEventPayload(cyclic), /complex/);
});
