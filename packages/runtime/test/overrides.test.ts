import assert from "node:assert/strict";
import test from "node:test";
import { OverrideManager } from "../dist/overrides.js";

const context = {
  states: new Set(["idle", "happy"]),
  capabilities: new Set<"locomotion">(["locomotion"]),
  contentIds: new Set(["approval", "progress"]),
};

test("overrides acquire only declared channels and preserve disjoint Plan work", () => {
  const manager = new OverrideManager(context, () => 10);
  const handle = manager.add({
    effect: {
      channels: ["state", "surface:approval"],
      state: { state: "happy" },
      surfaces: [
        {
          id: "approval",
          contentId: "approval",
          data: { requestId: "r-1" },
        },
      ],
    },
    until: { type: "event", name: "approval.accepted" },
  });

  const composed = manager.compose(
    {
      state: "idle",
      motion: { x: 1, y: 0, speed: 100 },
      surfaces: [
        {
          id: "job-progress",
          channel: "surface:job-progress",
          contentId: "progress",
          data: Object.freeze({ progress: 42 }),
          key: "progress:42",
        },
      ],
    },
    { pointer: { x: 50, y: 20 }, position: { x: 0, y: 0 } },
  );

  assert.equal(handle.status, "active");
  assert.equal(composed.state, "happy");
  assert.deepEqual(composed.motion, { x: 1, y: 0, speed: 100 });
  assert.deepEqual(
    composed.surfaces?.map((surface) => surface.id),
    ["job-progress", "approval"],
  );
  assert.equal(Object.isFrozen(composed.surfaces?.[1]?.data), true);
});

test("follow-pointer uses the same default speed in Plans and Overrides", () => {
  const manager = new OverrideManager(context, () => 0);
  manager.add({
    effect: {
      channels: ["motion"],
      motion: { type: "follow-pointer" },
    },
    until: { type: "manual" },
  });

  assert.equal(
    manager.compose({}, { pointer: { x: 100, y: 0 }, position: { x: 0, y: 0 } })
      .motion?.speed,
    160,
  );
});

test("a completion event ends an override without consuming the Plan event", async () => {
  const manager = new OverrideManager(context, () => 10);
  const handle = manager.add({
    effect: {
      channels: ["surface:approval"],
      surfaces: [{ id: "approval", contentId: "approval" }],
    },
    until: { type: "event", name: "approval.accepted" },
  });

  assert.equal(manager.observeEvent("approval.accepted"), false);
  assert.deepEqual(await handle.finished, {
    id: handle.id,
    reason: "event",
  });
  assert.equal(handle.status, "finished");
  assert.equal(manager.compose({}, {}).surfaces?.length ?? 0, 0);
});

test("browser-named Override completions require the browser observation source", async () => {
  const manager = new OverrideManager(context, () => 10);
  const handle = manager.add({
    effect: {
      channels: ["surface:approval"],
      surfaces: [{ id: "approval", contentId: "approval" }],
    },
    until: { type: "event", name: "pointer.click" },
  });

  manager.observeEvent("pointer.click", "application");
  assert.equal(handle.status, "active");
  manager.observeEvent("pointer.click", "browser");
  assert.equal((await handle.finished).reason, "event");
});

test("continuous browser conditions are rejected as Override completion Events", async () => {
  for (const name of ["pointer.move", "section.visibility"] as const) {
    const manager = new OverrideManager(context, () => 10);
    const handle = manager.add({
      effect: {
        channels: ["state"],
        state: { state: "happy" },
      },
      until: { type: "event", name },
    });

    assert.equal(handle.status, "rejected");
    assert.equal((await handle.finished).reason, "rejected");
  }
});

test("cancel, timeout, replacement, and destroy release exactly their channels", async () => {
  let now = 0;
  const manager = new OverrideManager(context, () => now);
  const motion = manager.add({
    effect: {
      channels: ["motion"],
      motion: { type: "follow-pointer", speed: 80 },
    },
    until: { type: "manual" },
  });
  const approval = manager.add({
    effect: {
      channels: ["surface:approval"],
      surfaces: [{ id: "approval", contentId: "approval" }],
    },
    until: { type: "duration", ms: 50 },
  });
  motion.cancel();
  assert.equal((await motion.finished).reason, "cancelled");

  now = 51;
  manager.compose({}, {});
  assert.equal((await approval.finished).reason, "timeout");

  const first = manager.add({
    effect: {
      channels: ["state"],
      state: { state: "idle" },
    },
    until: { type: "manual" },
  });
  const unrelated = manager.add({
    effect: {
      channels: ["surface:approval"],
      surfaces: [{ id: "approval", contentId: "approval" }],
    },
    until: { type: "manual" },
  });
  const replacement = manager.add({
    effect: {
      channels: ["state"],
      state: { state: "happy" },
    },
    mode: "replace",
    until: { type: "manual" },
  });
  assert.equal((await first.finished).reason, "replaced");
  assert.equal(unrelated.status, "active");
  assert.equal(replacement.status, "active");

  manager.clear("destroyed");
  assert.equal((await unrelated.finished).reason, "destroyed");
  assert.equal((await replacement.finished).reason, "destroyed");
});

test("overlapping overrides require explicit replacement and invalid effects reject", async () => {
  const diagnostics: string[] = [];
  const manager = new OverrideManager(
    context,
    () => 0,
    (message) => diagnostics.push(message),
  );
  manager.add({
    effect: {
      channels: ["surface:approval"],
      surfaces: [{ id: "approval", contentId: "approval" }],
    },
    until: { type: "manual" },
  });
  const conflict = manager.add({
    effect: {
      channels: ["surface:approval"],
      surfaces: [{ id: "approval", contentId: "approval" }],
    },
    until: { type: "manual" },
  });
  assert.equal((await conflict.finished).reason, "conflict");

  const invalid = manager.add({
    effect: {
      channels: ["state"],
      state: { state: "missing" },
    },
    until: { type: "manual" },
  });
  assert.equal((await invalid.finished).reason, "rejected");
  assert.ok(diagnostics.some((message) => message.includes("conflict")));
  assert.ok(diagnostics.some((message) => message.includes("unknown")));
});

test("an explicit null Override lifetime is rejected instead of becoming manual", async () => {
  const manager = new OverrideManager(context, () => 0);
  const handle = manager.add({
    effect: {
      channels: ["state"],
      state: { state: "happy" },
    },
    until: null,
  } as never);

  assert.equal(handle.status, "rejected");
  assert.equal((await handle.finished).reason, "rejected");
  assert.equal(manager.compose({ state: "idle" }, {}).state, "idle");
});

test("Override completion names reject non-string values without coercion", () => {
  const manager = new OverrideManager(context, () => 0);
  const handle = manager.add({
    effect: {
      channels: ["state"],
      state: { state: "happy" },
    },
    until: { type: "event", name: ["approval.accepted"] },
  } as never);

  assert.equal(handle.status, "rejected");
});
