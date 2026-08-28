import assert from "node:assert/strict";
import test from "node:test";
import { compilePlan } from "../dist/plan-compiler.js";
import {
  PlanRuntime,
  compiledPlanSectionRequirements,
  createDefaultPlan,
} from "../dist/plan.js";
import type { Plan, World } from "../dist/types.js";

const context = {
  states: new Set(["idle", "happy", "calm", "sad"]),
  capabilities: new Set(["locomotion"] as const),
  contentIds: new Set([
    "job-progress",
    "job-finished",
    "approval",
    "notice",
    "status",
  ]),
};

function world(overrides: Partial<World> = {}): World {
  return {
    now: 0,
    position: { x: 0, y: 0 },
    viewport: { width: 800, height: 600 },
    lastActivityAt: 0,
    reducedMotion: false,
    ...overrides,
  };
}

test("the engine default is one canonical Plan with an idle baseline", () => {
  const mobile = compilePlan(createDefaultPlan(false), {
    ...context,
    capabilities: new Set(),
  });
  const mobileFrame = new PlanRuntime(mobile).evaluate(world());
  assert.equal(mobileFrame.state, "idle");
  assert.equal(mobileFrame.motion, undefined);

  const locomoting = compilePlan(createDefaultPlan(true), context);
  const frame = new PlanRuntime(locomoting).evaluate(
    world({ pointer: { x: 100, y: 0 } }),
  );
  assert.equal(frame.capability, "locomotion");
  assert.deepEqual(frame.motion, {
    x: 1,
    y: 0,
    speed: 160,
    maxDistance: 100,
  });
});

test("a minimal pointer Rule drives motion through the compiled Plan", () => {
  const plan: Plan = {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "follow-pointer",
        when: { source: "browser", event: "pointer.move" },
        effect: {
          channels: ["motion", "state"],
          motion: {
            type: "follow-pointer",
            speed: 80,
            arrivalRadius: 10,
          },
          state: { capability: "locomotion" },
        },
      },
    ],
  };
  const runtime = new PlanRuntime(compilePlan(plan, context));

  assert.deepEqual(runtime.evaluate(world({ pointer: { x: 25, y: 0 } })), {
    capability: "locomotion",
    motion: { x: 1, y: 0, speed: 80, maxDistance: 15 },
  });
});

test("section observer thresholds are sorted numerically", () => {
  const compiled = compilePlan(
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "ordinary-threshold",
          when: {
            source: "browser",
            event: "section.visibility",
            selector: "#ordinary",
            phase: "while-visible",
            threshold: 0.25,
          },
          effect: { channels: ["state"], state: { state: "happy" } },
        },
        {
          id: "small-threshold",
          when: {
            source: "browser",
            event: "section.visibility",
            selector: "#small",
            phase: "while-visible",
            threshold: 1e-7,
          },
          effect: { channels: ["state"], state: { state: "calm" } },
        },
      ],
    },
    context,
  );

  assert.deepEqual(
    compiledPlanSectionRequirements(compiled).thresholds,
    [0, 1e-7, 0.25, 1],
  );
});

test("section edge facts match selector, phase, and threshold then latch state", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "other-section",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#other",
              phase: "enter",
              threshold: 0.25,
            },
            effect: { channels: ["state"], state: { state: "sad" } },
          },
          {
            id: "pricing-left",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#pricing",
              phase: "leave",
              threshold: 0.25,
            },
            effect: { channels: ["state"], state: { state: "calm" } },
          },
          {
            id: "pricing-entered",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#pricing",
              phase: "enter",
              threshold: 0.25,
            },
            effect: { channels: ["state"], state: { state: "happy" } },
          },
        ],
      },
      context,
    ),
  );

  assert.equal(
    runtime.evaluate(
      world({
        reaction: {
          id: 1,
          source: "browser",
          name: "section.visibility",
          at: 0,
          payload: {
            selector: "#pricing",
            previousRatio: 0.1,
            ratio: 0.5,
          },
        },
      }),
    ).state,
    "happy",
  );
  assert.equal(runtime.evaluate(world({ now: 16 })).state, "happy");
});

test("section enter and leave facts remain FIFO across evaluator turns", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "entered",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#target",
              phase: "enter",
              threshold: 0.25,
            },
            effect: { channels: ["state"], state: { state: "happy" } },
          },
          {
            id: "left",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#target",
              phase: "leave",
              threshold: 0.25,
            },
            effect: { channels: ["state"], state: { state: "calm" } },
          },
        ],
      },
      context,
    ),
  );
  const facts = [
    { id: 1, previousRatio: 0, ratio: 0.5, expected: "happy" },
    { id: 2, previousRatio: 0.5, ratio: 0, expected: "calm" },
  ] as const;

  for (const fact of facts) {
    assert.equal(
      runtime.evaluate(
        world({
          now: fact.id * 16,
          reaction: {
            id: fact.id,
            source: "browser",
            name: "section.visibility",
            at: fact.id * 16,
            payload: {
              selector: "#target",
              previousRatio: fact.previousRatio,
              ratio: fact.ratio,
            },
          },
        }),
      ).state,
      fact.expected,
    );
  }
});

test("a state-only lifetime releases to the previous latched state", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "status",
            when: { source: "application", event: "status.changed" },
            effect: { channels: ["state"], state: { state: "calm" } },
          },
          {
            id: "temporary-edge",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#target",
              phase: "enter",
            },
            effect: {
              channels: ["state"],
              state: { state: "happy" },
              until: { type: "duration", ms: 100 },
            },
          },
        ],
      },
      context,
    ),
  );
  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "status.changed",
        at: 0,
      },
    }),
  );
  assert.equal(
    runtime.evaluate(
      world({
        now: 10,
        reaction: {
          id: 2,
          source: "browser",
          name: "section.visibility",
          at: 10,
          payload: {
            selector: "#target",
            previousRatio: 0,
            ratio: 0.5,
          },
        },
      }),
    ).state,
    "happy",
  );
  assert.equal(runtime.evaluate(world({ now: 111 })).state, "calm");
});

test("while-visible remains continuous and releases when visibility falls", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "visible",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#target",
              phase: "while-visible",
              threshold: 0.25,
            },
            effect: { channels: ["state"], state: { state: "happy" } },
          },
        ],
      },
      context,
    ),
  );

  for (const now of [0, 16]) {
    assert.equal(
      runtime.evaluate(
        world({
          now,
          sections: {
            "#target": { previousRatio: 0.5, ratio: 0.5 },
          },
        }),
      ).state,
      "happy",
    );
  }
  assert.equal(
    runtime.evaluate(
      world({
        now: 32,
        sections: { "#target": { previousRatio: 0.5, ratio: 0 } },
      }),
    ).state,
    "idle",
  );
});

test("an application Event selects its canonical Rule on a safe evaluator turn", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "saved",
            when: { source: "application", event: "app.saved" },
            effect: {
              channels: ["state"],
              state: { state: "happy" },
            },
          },
        ],
      },
      context,
    ),
  );

  assert.equal(runtime.evaluate(world()).state, "idle");
  const selected = runtime.evaluate(
    world({
      now: 16,
      reaction: {
        id: 1,
        source: "application",
        name: "app.saved",
        at: 15,
        payload: { documentId: "guide" },
      },
    }),
  );
  assert.equal(selected.state, "happy");
  assert.equal(selected.reactionId, 1);
  assert.equal(runtime.lastEventStatus, "matched");
});

test("later Events replace latched state owners while same-Event declaration priority stays stable", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "first-status",
            when: { source: "application", event: "status.first" },
            effect: {
              channels: ["state"],
              state: { state: "happy" },
            },
          },
          {
            id: "second-status-primary",
            when: { source: "application", event: "status.second" },
            effect: {
              channels: ["state"],
              state: { state: "calm" },
            },
          },
          {
            id: "second-status-lower-priority",
            when: { source: "application", event: "status.second" },
            effect: {
              channels: ["state"],
              state: { state: "sad" },
            },
          },
        ],
      },
      context,
    ),
  );

  assert.equal(
    runtime.evaluate(
      world({
        reaction: {
          id: 1,
          source: "application",
          name: "status.first",
          at: 0,
        },
      }),
    ).state,
    "happy",
  );
  assert.equal(
    runtime.evaluate(
      world({
        now: 10,
        reaction: {
          id: 2,
          source: "application",
          name: "status.second",
          at: 10,
        },
      }),
    ).state,
    "calm",
  );
  assert.equal(runtime.evaluate(world({ now: 20 })).state, "calm");
});

test("same-Event declaration priority owns ordinary state and surface channels", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "first-owner",
            when: { source: "application", event: "notice.updated" },
            effect: {
              channels: ["state", "surface:notice"],
              state: { state: "happy" },
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "replace",
                  data: { owner: "first" },
                },
              ],
            },
          },
          {
            id: "second-owner",
            when: { source: "application", event: "notice.updated" },
            effect: {
              channels: ["state", "surface:notice"],
              state: { state: "calm" },
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "replace",
                  data: { owner: "second" },
                },
              ],
            },
          },
          {
            id: "disjoint-owner",
            when: { source: "application", event: "notice.updated" },
            effect: {
              channels: ["surface:job-progress"],
              surfaces: [
                {
                  id: "job-progress",
                  contentId: "job-progress",
                  disposition: "replace",
                },
              ],
            },
          },
        ],
      },
      context,
    ),
  );

  const request = runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "notice.updated",
        at: 0,
      },
    }),
  );
  assert.equal(request.state, "happy");
  assert.deepEqual(
    request.surfaces?.map((surface) => surface.id),
    ["notice", "job-progress"],
  );
  assert.deepEqual({ ...request.surfaces?.[0]?.data }, { owner: "first" });
});

test("same-Event declaration priority owns overlapping interrupt channels", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "first-interrupt",
            when: { source: "application", event: "notice.opened" },
            effect: {
              channels: ["state", "surface:notice"],
              state: { state: "happy" },
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "interrupt",
                  data: { owner: "first" },
                },
              ],
              until: { type: "duration", ms: 1_000 },
            },
          },
          {
            id: "second-interrupt",
            when: { source: "application", event: "notice.opened" },
            effect: {
              channels: ["state", "surface:notice"],
              state: { state: "calm" },
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "interrupt",
                  data: { owner: "second" },
                },
              ],
              until: { type: "duration", ms: 1_000 },
            },
          },
          {
            id: "disjoint-interrupt",
            when: { source: "application", event: "notice.opened" },
            effect: {
              channels: ["surface:job-progress"],
              surfaces: [
                {
                  id: "job-progress",
                  contentId: "job-progress",
                  disposition: "interrupt",
                },
              ],
              until: { type: "duration", ms: 1_000 },
            },
          },
        ],
      },
      context,
    ),
  );

  const request = runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "notice.opened",
        at: 0,
      },
    }),
  );
  assert.equal(request.state, "happy");
  assert.deepEqual(
    request.surfaces?.map((surface) => surface.id),
    ["notice", "job-progress"],
  );
  assert.deepEqual({ ...request.surfaces?.[0]?.data }, { owner: "first" });
});

test("pointer motion composes with persistent progress surface data", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "follow-pointer",
            when: { source: "browser", event: "pointer.move" },
            effect: {
              channels: ["motion", "state"],
              motion: { type: "follow-pointer" },
              state: { capability: "locomotion" },
            },
          },
          {
            id: "show-progress",
            when: { source: "application", event: "job.progress" },
            effect: {
              channels: ["surface:job-progress"],
              surfaces: [
                {
                  id: "job-progress",
                  contentId: "job-progress",
                  data: "event-payload",
                  disposition: "update",
                  ordering: {
                    sessionField: "sessionId",
                    revisionField: "revision",
                  },
                },
              ],
            },
          },
        ],
      },
      context,
    ),
  );

  const progress = runtime.evaluate(
    world({
      pointer: { x: 40, y: 0 },
      reaction: {
        id: 1,
        source: "application",
        name: "job.progress",
        at: 0,
        payload: { sessionId: "job-1", revision: 42, completed: 4 },
      },
    }),
  );
  assert.equal(progress.capability, "locomotion");
  assert.equal(progress.surfaces?.[0]?.contentId, "job-progress");
  assert.deepEqual(
    { ...progress.surfaces?.[0]?.data },
    {
      sessionId: "job-1",
      revision: 42,
      completed: 4,
    },
  );

  const movedAgain = runtime.evaluate(
    world({ now: 32, pointer: { x: 0, y: 50 } }),
  );
  assert.equal(movedAgain.motion?.y, 1);
  assert.equal(movedAgain.surfaces?.[0]?.contentId, "job-progress");
  assert.deepEqual(
    { ...movedAgain.surfaces?.[0]?.data },
    {
      sessionId: "job-1",
      revision: 42,
      completed: 4,
    },
  );
});

test("late terminal progress preserves disjoint status and state effects", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "show-progress",
            when: { source: "application", event: "job.progress" },
            effect: {
              channels: ["surface:job-progress"],
              surfaces: [
                {
                  id: "job-progress",
                  contentId: "job-progress",
                  data: "event-payload",
                  disposition: "update",
                  ordering: {
                    sessionField: "sessionId",
                    revisionField: "revision",
                  },
                },
              ],
            },
          },
          {
            id: "show-status",
            when: { source: "application", event: "job.progress" },
            effect: {
              channels: ["surface:status"],
              surfaces: [
                {
                  id: "status",
                  contentId: "status",
                  data: "event-payload",
                  disposition: "replace",
                },
              ],
            },
          },
          {
            id: "mark-late-fact",
            when: { source: "application", event: "job.progress" },
            effect: {
              channels: ["state"],
              state: { state: "happy" },
            },
          },
          {
            id: "finish-progress",
            when: { source: "application", event: "job.finished" },
            effect: {
              channels: ["surface:job-progress"],
              surfaces: [
                {
                  id: "job-progress",
                  contentId: "job-finished",
                  disposition: "replace",
                  ordering: { sessionField: "sessionId", terminal: true },
                },
              ],
            },
          },
        ],
      },
      context,
    ),
  );

  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "job.progress",
        at: 0,
        payload: { sessionId: "job-1", revision: 1, progress: 10 },
      },
    }),
  );
  runtime.evaluate(
    world({
      now: 10,
      reaction: {
        id: 2,
        source: "application",
        name: "job.finished",
        at: 10,
        payload: { sessionId: "job-1" },
      },
    }),
  );
  const late = runtime.evaluate(
    world({
      now: 20,
      reaction: {
        id: 3,
        source: "application",
        name: "job.progress",
        at: 20,
        payload: { sessionId: "job-1", revision: 2, progress: 20 },
      },
    }),
  );

  assert.equal(runtime.lastEventStatus, "matched");
  assert.deepEqual(
    (
      runtime as unknown as {
        lastEventRejections: readonly { channel: string; status: string }[];
      }
    ).lastEventRejections,
    [{ channel: "surface:job-progress", status: "closed" }],
  );
  assert.equal(late.state, "happy");
  assert.equal(late.reactionId, 3);
  assert.equal(
    late.surfaces?.find((surface) => surface.id === "job-progress")?.contentId,
    "job-finished",
  );
  assert.equal(
    late.surfaces?.find((surface) => surface.id === "status")?.data?.[
      "progress"
    ],
    20,
  );
});

test("a motion owner arriving at its target does not delete another Rule's state channel", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "locomotion-state",
            when: { source: "application", event: "mode.locomotion" },
            effect: {
              channels: ["state"],
              state: { capability: "locomotion" },
            },
          },
          {
            id: "move-on-click",
            when: { source: "browser", event: "pointer.click" },
            effect: {
              channels: ["motion"],
              motion: { type: "follow-pointer", arrivalRadius: 10 },
            },
          },
        ],
      },
      context,
    ),
  );

  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "mode.locomotion",
        at: 0,
      },
    }),
  );
  const request = runtime.evaluate(
    world({
      now: 10,
      pointer: { x: 5, y: 0 },
      reaction: {
        id: 2,
        source: "browser",
        name: "pointer.click",
        at: 10,
      },
    }),
  );
  assert.equal(request.capability, "locomotion");
  assert.equal(request.motion, undefined);
  assert.equal(request.state, undefined);
});

test("a Plan interrupt persists, releases on its Event, and still matches that Event", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state", "surface:job-progress"],
          state: { state: "idle" },
          surfaces: [{ id: "job-progress", contentId: "job-progress" }],
        },
        rules: [
          {
            id: "request-approval",
            when: { source: "application", event: "approval.requested" },
            effect: {
              channels: ["state", "surface:approval"],
              state: { state: "happy" },
              surfaces: [
                {
                  id: "approval",
                  contentId: "approval",
                  disposition: "interrupt",
                },
              ],
              until: {
                type: "event",
                name: "approval.accepted",
                timeout: 1_000,
              },
            },
          },
          {
            id: "accepted-notice",
            when: { source: "application", event: "approval.accepted" },
            effect: {
              channels: ["surface:notice"],
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "replace",
                },
              ],
            },
          },
        ],
      },
      context,
    ),
  );

  const started = runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "approval.requested",
        at: 0,
      },
    }),
  );
  assert.equal(started.state, "happy");
  assert.deepEqual(
    started.surfaces?.map((surface) => surface.id),
    ["job-progress", "approval"],
  );
  assert.equal(runtime.evaluate(world({ now: 500 })).state, "happy");

  const completed = runtime.evaluate(
    world({
      now: 600,
      reaction: {
        id: 2,
        source: "application",
        name: "approval.accepted",
        at: 600,
      },
    }),
  );
  assert.equal(completed.state, "idle");
  assert.equal(completed.reactionId, 2);
  assert.equal(runtime.lastEventStatus, "matched");
  assert.deepEqual(
    completed.surfaces?.map((surface) => surface.id),
    ["job-progress", "notice"],
  );
});

test("a stale ordered fact cannot release a Plan interrupt", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "progress",
            when: { source: "application", event: "job.progress" },
            effect: {
              channels: ["surface:job-progress"],
              surfaces: [
                {
                  id: "job-progress",
                  contentId: "job-progress",
                  data: "event-payload",
                  disposition: "update",
                  ordering: {
                    sessionField: "sessionId",
                    revisionField: "revision",
                  },
                },
              ],
            },
          },
          {
            id: "approval",
            when: { source: "application", event: "approval.requested" },
            effect: {
              channels: ["state", "surface:approval"],
              state: { state: "happy" },
              surfaces: [
                {
                  id: "approval",
                  contentId: "approval",
                  disposition: "interrupt",
                },
              ],
              until: { type: "event", name: "job.progress", timeout: 1_000 },
            },
          },
        ],
      },
      context,
    ),
  );

  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "job.progress",
        at: 0,
        payload: { sessionId: "job-1", revision: 2 },
      },
    }),
  );
  runtime.evaluate(
    world({
      now: 10,
      reaction: {
        id: 2,
        source: "application",
        name: "approval.requested",
        at: 10,
      },
    }),
  );
  const stale = runtime.evaluate(
    world({
      now: 20,
      reaction: {
        id: 3,
        source: "application",
        name: "job.progress",
        at: 20,
        payload: { sessionId: "job-1", revision: 1 },
      },
    }),
  );

  assert.equal(runtime.lastEventStatus, "stale");
  assert.equal(stale.state, "happy");
  assert.equal(
    stale.surfaces?.some((surface) => surface.id === "approval"),
    true,
  );
});

test("an invalid completion payload cannot release a Plan interrupt", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "approval",
            when: { source: "application", event: "approval.requested" },
            effect: {
              channels: ["state", "surface:approval"],
              state: { state: "happy" },
              surfaces: [
                {
                  id: "approval",
                  contentId: "approval",
                  disposition: "interrupt",
                },
              ],
              until: { type: "event", name: "approval.accepted" },
            },
          },
        ],
      },
      context,
    ),
  );
  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "approval.requested",
        at: 0,
      },
    }),
  );

  const invalid = runtime.evaluate(
    world({
      now: 10,
      reaction: {
        id: 2,
        source: "application",
        name: "approval.accepted",
        at: 10,
        payload: { execute: () => {} } as never,
      },
    }),
  );

  assert.equal(runtime.lastEventStatus, "invalid");
  assert.equal(invalid.state, "happy");
});

test("a browser-named completion requires the browser observation source", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "approval",
            when: { source: "application", event: "approval.requested" },
            effect: {
              channels: ["state", "surface:approval"],
              state: { state: "happy" },
              surfaces: [
                {
                  id: "approval",
                  contentId: "approval",
                  disposition: "interrupt",
                },
              ],
              until: { type: "event", name: "pointer.click" },
            },
          },
        ],
      },
      context,
    ),
  );
  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "approval.requested",
        at: 0,
      },
    }),
  );

  const applicationCollision = runtime.evaluate(
    world({
      now: 10,
      reaction: {
        id: 2,
        source: "application",
        name: "pointer.click",
        at: 10,
      },
    }),
  );
  assert.equal(applicationCollision.state, "happy");

  const browserCompletion = runtime.evaluate(
    world({
      now: 20,
      reaction: {
        id: 3,
        source: "browser",
        name: "pointer.click",
        at: 20,
      },
    }),
  );
  assert.equal(browserCompletion.state, "idle");
});

test("new interrupts replace channel conflicts and reset releases page state", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "first",
            when: { source: "application", event: "notice.first" },
            effect: {
              channels: ["surface:notice"],
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "interrupt",
                  data: { version: 1 },
                },
              ],
              until: { type: "event", name: "notice.first.done" },
            },
          },
          {
            id: "second",
            when: { source: "application", event: "notice.second" },
            effect: {
              channels: ["surface:notice"],
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "interrupt",
                  data: { version: 2 },
                },
              ],
              until: { type: "event", name: "notice.second.done" },
            },
          },
        ],
      },
      context,
    ),
  );
  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "notice.first",
        at: 0,
      },
    }),
  );
  const second = runtime.evaluate(
    world({
      now: 10,
      reaction: {
        id: 2,
        source: "application",
        name: "notice.second",
        at: 10,
      },
    }),
  );
  assert.deepEqual({ ...second.surfaces?.[0]?.data }, { version: 2 });

  const oldCompletion = runtime.evaluate(
    world({
      now: 20,
      reaction: {
        id: 3,
        source: "application",
        name: "notice.first.done",
        at: 20,
      },
    }),
  );
  assert.deepEqual({ ...oldCompletion.surfaces?.[0]?.data }, { version: 2 });

  runtime.reset();
  assert.equal(runtime.evaluate(world({ now: 30 })).surfaces, undefined);
  assert.equal(runtime.nextWakeAt(), undefined);
});

test("an interrupt timeout releases only its owned channels", () => {
  const runtime = new PlanRuntime(
    compilePlan(
      {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "timed",
            when: { source: "application", event: "notice.timed" },
            effect: {
              channels: ["surface:notice"],
              surfaces: [
                {
                  id: "notice",
                  contentId: "notice",
                  disposition: "interrupt",
                },
              ],
              until: { type: "duration", ms: 50 },
            },
          },
        ],
      },
      context,
    ),
  );
  runtime.evaluate(
    world({
      now: 10,
      reaction: {
        id: 1,
        source: "application",
        name: "notice.timed",
        at: 10,
      },
    }),
  );
  assert.equal(runtime.nextWakeAt(), 60);
  assert.equal(
    runtime.evaluate(world({ now: 59 })).surfaces?.[0]?.id,
    "notice",
  );
  assert.equal(runtime.evaluate(world({ now: 60 })).surfaces, undefined);
});

test("a non-finite forged interrupt deadline cannot schedule runtime work", () => {
  const runtime = new PlanRuntime({
    baseline: {
      channels: ["state"],
      state: { kind: "state", name: "idle" },
      surfaces: [],
    },
    rules: [
      {
        id: "forged",
        when: { source: "application", event: "notice.opened" },
        effect: {
          channels: ["surface:notice"],
          surfaces: [
            {
              id: "notice",
              channel: "surface:notice",
              contentId: "notice",
              disposition: "interrupt",
            },
          ],
          until: { type: "duration", ms: Number.NaN },
        },
      },
    ],
  } as never);

  runtime.evaluate(
    world({
      reaction: {
        id: 1,
        source: "application",
        name: "notice.opened",
        at: 0,
      },
    }),
  );

  assert.equal(runtime.nextWakeAt(), undefined);
  assert.equal(runtime.evaluate(world({ now: 10 })).surfaces, undefined);
});
