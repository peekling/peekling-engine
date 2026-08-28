import assert from "node:assert/strict";
import test from "node:test";
import {
  compilePlan,
  createPlanEventState,
  evaluatePlanEvent,
  preflightPlan,
} from "../dist/plan-compiler.js";

const context = {
  states: new Set(["idle", "celebrate"]),
  capabilities: new Set(["locomotion"] as const),
  contentIds: new Set(["job-progress", "job-finished", "status", "toast"]),
};

test("a minimal pointer-follow Plan compiles to immutable channel ownership", () => {
  const compiled = compilePlan(
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
            motion: { type: "follow-pointer", speed: 160 },
            state: { capability: "locomotion" },
          },
        },
      ],
    },
    context,
  );

  assert.deepEqual(compiled.rules[0]?.effect.channels, ["motion", "state"]);
  assert.equal(compiled.rules[0]?.effect.motion?.type, "follow-pointer");
  assert.equal(compiled.rules[0]?.effect.state?.kind, "capability");
  assert.ok(Object.isFrozen(compiled));
  assert.ok(Object.isFrozen(compiled.rules));
  assert.ok(Object.isFrozen(compiled.rules[0]!.effect));
});

test("application coalescing is explicit, ordered, and consistent per Event", () => {
  const compiled = compilePlan(
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "progress",
          when: {
            source: "application",
            event: "job.progress",
            coalesce: "latest",
          },
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
  );
  assert.equal(compiled.rules[0]?.when.coalesce, "latest");

  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "unsafe-progress",
              when: {
                source: "application",
                event: "job.progress",
                coalesce: "latest",
              },
              effect: {
                channels: ["state"],
                state: { state: "celebrate" },
              },
            },
          ],
        },
        context,
      ),
    /coalesc.*ordered surface/i,
  );

  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "latest",
              when: {
                source: "application",
                event: "job.progress",
                coalesce: "latest",
              },
              effect: {
                channels: ["surface:job-progress"],
                surfaces: [
                  {
                    id: "job-progress",
                    contentId: "job-progress",
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
              id: "fifo",
              when: { source: "application", event: "job.progress" },
              effect: {
                channels: ["surface:job-finished"],
                surfaces: [
                  {
                    id: "job-finished",
                    contentId: "job-finished",
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
    /ambiguous.*coalesc/i,
  );
});

test("discrete browser Events cannot opt into latest coalescing", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "click",
              when: {
                source: "browser",
                event: "pointer.click",
                coalesce: "latest",
              },
              effect: {
                channels: ["state"],
                state: { state: "celebrate" },
              },
            },
          ],
        },
        context,
      ),
    /coalesc.*window\.scroll/i,
  );
});

test("section visibility threshold is finite, greater than zero, and at most one", () => {
  const candidate = (threshold: number) => ({
    baseline: {
      channels: ["state" as const],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "visible",
        when: {
          source: "browser" as const,
          event: "section.visibility" as const,
          selector: "#pricing",
          phase: "while-visible" as const,
          threshold,
        },
        effect: {
          channels: ["state" as const],
          state: { state: "celebrate" },
        },
      },
    ],
  });

  for (const threshold of [0, -0.1, Number.NaN, 1.01]) {
    assert.throws(
      () => compilePlan(candidate(threshold), context),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid-threshold");
        assert.equal(
          (error as { path?: string }).path,
          "$plan.rules[0].when.threshold",
        );
        return true;
      },
    );
  }
  for (const threshold of [Number.MIN_VALUE, 1]) {
    assert.doesNotThrow(() => compilePlan(candidate(threshold), context));
  }
});

test("section selector validation rejects a false result at the condition path", () => {
  const candidate = (selector: string) => ({
    baseline: {
      channels: ["state" as const],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "visible",
        when: {
          source: "browser" as const,
          event: "section.visibility" as const,
          selector,
          phase: "while-visible" as const,
        },
        effect: {
          channels: ["state" as const],
          state: { state: "celebrate" },
        },
      },
    ],
  });
  const selectorContext = {
    ...context,
    validateSelector: (selector: string) => selector === "#pricing",
  };

  assert.doesNotThrow(() =>
    compilePlan(candidate("#pricing"), selectorContext),
  );
  assert.throws(
    () => compilePlan(candidate("a >>> b"), selectorContext),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "invalid-selector");
      assert.equal(
        (error as { path?: string }).path,
        "$plan.rules[0].when.selector",
      );
      return true;
    },
  );
});

test("section selector validation converts parser exceptions to invalid-selector", () => {
  assert.throws(
    () =>
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
                selector: ":has(:unknown",
                phase: "enter",
              },
              effect: {
                channels: ["state"],
                state: { state: "celebrate" },
              },
            },
          ],
        },
        {
          ...context,
          validateSelector: () => {
            throw new DOMException("Invalid selector", "SyntaxError");
          },
        },
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "invalid-selector");
      assert.equal(
        (error as { path?: string }).path,
        "$plan.rules[0].when.selector",
      );
      return true;
    },
  );
});

test("continuous-only Rules reject surfaces and interrupt lifetimes they cannot execute", () => {
  const effects = [
    {
      when: { source: "browser", event: "pointer.move" },
      effect: {
        channels: ["state"],
        state: { state: "celebrate" },
        surfaces: [],
      },
    },
    {
      when: { source: "browser", event: "pointer.move" },
      effect: {
        channels: ["state", "surface:job-progress"],
        state: { state: "celebrate" },
        surfaces: [
          {
            id: "job-progress",
            contentId: "job-progress",
            disposition: "replace",
          },
        ],
      },
    },
    {
      when: {
        source: "browser",
        event: "section.visibility",
        selector: "#pricing",
        phase: "while-visible",
      },
      effect: {
        channels: ["state", "surface:job-progress"],
        state: { state: "celebrate" },
        surfaces: [
          {
            id: "job-progress",
            contentId: "job-progress",
            disposition: "replace",
          },
        ],
      },
    },
    {
      when: {
        source: "browser",
        event: "section.visibility",
        selector: "#pricing",
        phase: "while-visible",
      },
      effect: {
        channels: ["state"],
        state: { state: "celebrate" },
        until: { type: "duration", ms: 100 },
      },
    },
  ];

  for (const [index, candidate] of effects.entries()) {
    assert.throws(
      () =>
        compilePlan(
          {
            baseline: {
              channels: ["state"],
              state: { state: "idle" },
            },
            rules: [{ id: `continuous-${index}`, ...candidate }],
          } as never,
          context,
        ),
      /continuous.*surface|continuous.*until|cannot.*continuous/i,
    );
  }
});

test("section enter and leave Rules are discrete and may own surfaces or a bounded lifetime", () => {
  const compiled = compilePlan(
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "pricing-entered",
          when: {
            source: "browser",
            event: "section.visibility",
            selector: "#pricing",
            phase: "enter",
          },
          effect: {
            channels: ["state", "surface:job-progress"],
            state: { state: "celebrate" },
            surfaces: [
              {
                id: "job-progress",
                contentId: "job-progress",
                disposition: "interrupt",
              },
            ],
            until: { type: "duration", ms: 100 },
          },
        },
        {
          id: "pricing-left",
          when: {
            source: "browser",
            event: "section.visibility",
            selector: "#pricing",
            phase: "leave",
          },
          effect: {
            channels: ["state"],
            state: { state: "idle" },
          },
        },
      ],
    },
    context,
  );

  assert.equal(compiled.rules.length, 2);
  assert.deepEqual(compiled.rules[0]?.effect.until, {
    type: "duration",
    ms: 100,
  });
});

test("interrupt Effects require one closed bounded lifetime", () => {
  const compiled = compilePlan(
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
            state: { state: "celebrate" },
            surfaces: [
              {
                id: "approval",
                contentId: "job-progress",
                disposition: "interrupt",
              },
            ],
            until: {
              type: "event",
              name: "approval.accepted",
              timeout: 60_000,
            },
          },
        },
      ],
    },
    context,
  );
  assert.deepEqual(compiled.rules[0]?.effect.until, {
    type: "event",
    name: "approval.accepted",
    timeout: 60_000,
  });

  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "unbounded",
              when: { source: "application", event: "approval.requested" },
              effect: {
                channels: ["surface:approval"],
                surfaces: [
                  {
                    id: "approval",
                    contentId: "job-progress",
                    disposition: "interrupt",
                  },
                ],
              },
            },
          ],
        },
        context,
      ),
    /interrupt.*until/i,
  );
});

test("continuous browser conditions cannot be interrupt completion Events", () => {
  for (const [index, name] of [
    "pointer.move",
    "section.visibility",
  ].entries()) {
    assert.throws(
      () =>
        compilePlan(
          {
            baseline: {
              channels: ["state"],
              state: { state: "idle" },
            },
            rules: [
              {
                id: `unsupported-${index}`,
                when: { source: "application", event: "notice.opened" },
                effect: {
                  channels: ["state"],
                  state: { state: "celebrate" },
                  until: { type: "event", name, timeout: 1_000 },
                },
              },
            ],
          },
          context,
        ),
      /continuous browser Event.*completion/i,
    );
  }
});

test("duration interrupts reject a missing finite millisecond bound", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "unbounded-duration",
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
                until: { type: "duration" },
              },
            },
          ],
        } as never,
        context,
      ),
    /until\.ms.*required|duration.*millisecond/i,
  );
});

test("typed application Events expose immutable payload data to a surface", () => {
  const compiled = compilePlan(
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
      ],
    },
    context,
  );
  const state = createPlanEventState();
  const payload = { sessionId: "build-7", revision: 42, changedFiles: 4 };
  const result = evaluatePlanEvent(compiled, state, {
    source: "application",
    name: "job.progress",
    payload,
  });

  payload.changedFiles = 99;
  assert.equal(result.status, "matched");
  assert.deepEqual(
    { ...result.effects[0]?.surfaces[0]?.data },
    {
      sessionId: "build-7",
      revision: 42,
      changedFiles: 4,
    },
  );
  assert.ok(Object.isFrozen(result.effects[0]?.surfaces[0]?.data));
});

test("disjoint motion and named surface channels compose without a conflict", () => {
  const compiled = compilePlan(
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
              },
            ],
          },
        },
      ],
    },
    context,
  );

  assert.deepEqual(
    compiled.rules.map((rule) => rule.effect.channels),
    [["motion", "state"], ["surface:job-progress"]],
  );
});

test("ambiguous writers to the same named surface fail with rule and channel diagnostics", () => {
  assert.throws(
    () =>
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
                  },
                ],
              },
            },
            {
              id: "show-finished",
              when: { source: "application", event: "job.finished" },
              effect: {
                channels: ["surface:job-progress"],
                surfaces: [
                  {
                    id: "job-progress",
                    contentId: "job-finished",
                    data: "event-payload",
                  },
                ],
              },
            },
          ],
        },
        context,
      ),
    (error: unknown) => {
      assert.match(String(error), /show-progress/);
      assert.match(String(error), /show-finished/);
      assert.match(String(error), /surface:job-progress/);
      return true;
    },
  );
});

test("one Effect cannot declare the same named surface channel twice", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state", "surface:job-progress"],
            state: { state: "idle" },
            surfaces: [
              {
                id: "job-progress",
                contentId: "job-progress",
                disposition: "replace",
              },
              {
                id: "job-progress",
                contentId: "job-finished",
                disposition: "update",
              },
            ],
          },
        },
        context,
      ),
    /duplicate.*surface:job-progress|surface:job-progress.*twice/i,
  );
});

test("a Rule displacing a baseline surface requires an explicit disposition", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state", "surface:job-progress"],
            state: { state: "idle" },
            surfaces: [{ id: "job-progress", contentId: "job-progress" }],
          },
          rules: [
            {
              id: "finish-progress",
              when: { source: "application", event: "job.finished" },
              effect: {
                channels: ["surface:job-progress"],
                surfaces: [
                  {
                    id: "job-progress",
                    contentId: "job-finished",
                  },
                ],
              },
            },
          ],
        },
        context,
      ),
    /baseline.*finish-progress.*surface:job-progress|surface:job-progress.*disposition/i,
  );
});

test("session revisions cannot move backward or reopen a completed session", () => {
  const compiled = compilePlan(
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
          id: "finish-progress",
          when: { source: "application", event: "job.finished" },
          effect: {
            channels: ["surface:job-progress"],
            surfaces: [
              {
                id: "job-progress",
                contentId: "job-finished",
                data: "event-payload",
                disposition: "replace",
                ordering: {
                  sessionField: "sessionId",
                  terminal: true,
                },
              },
            ],
          },
        },
      ],
    },
    context,
  );
  const state = createPlanEventState();

  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: { sessionId: "job-1", revision: 42 },
    }).status,
    "matched",
  );
  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: { sessionId: "job-1", revision: 0 },
    }).status,
    "stale",
  );
  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.finished",
      payload: { sessionId: "job-1", changedFiles: 4 },
    }).status,
    "matched",
  );
  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: { sessionId: "job-1", revision: 43 },
    }).status,
    "closed",
  );
  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: { sessionId: "job-2", revision: 0 },
    }).status,
    "matched",
  );
});

test("ordered surface rejection is isolated from disjoint Event effects", () => {
  const compiled = compilePlan(
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "update-progress",
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
          id: "update-status",
          when: { source: "application", event: "job.progress" },
          effect: {
            channels: ["surface:status"],
            surfaces: [
              {
                id: "status",
                contentId: "status",
                data: "event-payload",
                disposition: "update",
                ordering: {
                  sessionField: "statusSessionId",
                  revisionField: "statusRevision",
                },
              },
            ],
          },
        },
        {
          id: "show-toast",
          when: { source: "application", event: "job.progress" },
          effect: {
            channels: ["surface:toast"],
            surfaces: [
              {
                id: "toast",
                contentId: "toast",
                data: "event-payload",
                disposition: "replace",
              },
            ],
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
  );
  const state = createPlanEventState();

  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: {
        sessionId: "job-1",
        revision: 1,
        statusSessionId: "status-1",
        statusRevision: 1,
      },
    }).status,
    "matched",
  );
  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.finished",
      payload: { sessionId: "job-1" },
    }).status,
    "matched",
  );

  const late = evaluatePlanEvent(compiled, state, {
    source: "application",
    name: "job.progress",
    payload: {
      sessionId: "job-1",
      revision: 2,
      statusSessionId: "status-1",
      statusRevision: 2,
      message: "Still useful",
    },
  });

  assert.equal(late.status, "matched");
  assert.deepEqual(
    late.rules.map((rule) => rule.id),
    ["update-status", "show-toast"],
  );
  assert.deepEqual(
    late.effects.flatMap((effect) => effect.channels),
    ["surface:status", "surface:toast"],
  );
  assert.deepEqual(
    (
      late as unknown as {
        rejectedSurfaces: readonly { channel: string; status: string }[];
      }
    ).rejectedSurfaces,
    [{ channel: "surface:job-progress", status: "closed" }],
  );
  assert.equal(
    state.ordering.get("surface:status\u0000string\u0000status-1"),
    2,
  );
  assert.equal(
    state.ordering.get("surface:job-progress\u0000string\u0000job-1"),
    true,
  );
});

test("ordered session identity preserves the JSON scalar type", () => {
  const compiled = compilePlan(
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
  );
  const state = createPlanEventState();

  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: { sessionId: 1, revision: 5 },
    }).status,
    "matched",
  );
  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: { sessionId: "1", revision: 0 },
    }).status,
    "matched",
  );
  assert.equal(state.ordering.size, 2);
});

test("one Event can select multiple explicit ordered writers for a surface", () => {
  const compiled = compilePlan(
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "update-progress",
          when: { source: "application", event: "job.progress" },
          effect: {
            channels: ["surface:job-progress"],
            surfaces: [
              {
                id: "job-progress",
                contentId: "job-progress",
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
          id: "replace-progress",
          when: { source: "application", event: "job.progress" },
          effect: {
            channels: ["surface:job-progress"],
            surfaces: [
              {
                id: "job-progress",
                contentId: "job-finished",
                disposition: "replace",
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
  );
  const state = createPlanEventState();

  const evaluation = evaluatePlanEvent(compiled, state, {
    source: "application",
    name: "job.progress",
    payload: { sessionId: "job-1", revision: 1 },
  });
  assert.equal(evaluation.status, "matched");
  assert.deepEqual(
    evaluation.rules.map((rule) => rule.id),
    ["update-progress", "replace-progress"],
  );
  assert.equal(evaluation.effects.length, 2);
  assert.equal(state.ordering.size, 1);
  assert.equal(
    state.ordering.get("surface:job-progress\u0000string\u0000job-1"),
    1,
  );

  const stale = evaluatePlanEvent(compiled, state, {
    source: "application",
    name: "job.progress",
    payload: { sessionId: "job-1", revision: 0 },
  });
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.effects, []);
  assert.deepEqual(
    (
      stale as unknown as {
        rejectedSurfaces: readonly { channel: string; status: string }[];
      }
    ).rejectedSurfaces,
    [{ channel: "surface:job-progress", status: "stale" }],
  );
  assert.equal(
    state.ordering.get("surface:job-progress\u0000string\u0000job-1"),
    1,
  );
});

test("one ordered surface uses one session and revision field contract", () => {
  const secondRule = (ordering: {
    sessionField: string;
    revisionField?: string;
    terminal?: boolean;
  }) => ({
    id: "finish-progress",
    when: { source: "application" as const, event: "job.finished" },
    effect: {
      channels: ["surface:job-progress" as const],
      surfaces: [
        {
          id: "job-progress",
          contentId: "job-finished",
          disposition: "replace" as const,
          ordering,
        },
      ],
    },
  });
  const firstRule = {
    id: "show-progress",
    when: { source: "application" as const, event: "job.progress" },
    effect: {
      channels: ["surface:job-progress" as const],
      surfaces: [
        {
          id: "job-progress",
          contentId: "job-progress",
          disposition: "update" as const,
          ordering: {
            sessionField: "sessionId",
            revisionField: "revision",
          },
        },
      ],
    },
  };

  for (const [ordering, message] of [
    [
      { sessionField: "correlationId", terminal: true },
      /surface:job-progress.*one session field|one session field.*surface:job-progress/i,
    ],
    [
      { sessionField: "sessionId", revisionField: "sequence" },
      /surface:job-progress.*one revision field|one revision field.*surface:job-progress/i,
    ],
  ] as const) {
    assert.throws(
      () =>
        compilePlan(
          {
            baseline: {
              channels: ["state"],
              state: { state: "idle" },
            },
            rules: [firstRule, secondRule(ordering)],
          },
          context,
        ),
      message,
    );
  }
});

test("ordered Event history retains only a bounded recent session window per surface", () => {
  const compiled = compilePlan(
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
  );
  const state = createPlanEventState();

  for (let index = 0; index < 256; index++) {
    assert.equal(
      evaluatePlanEvent(compiled, state, {
        source: "application",
        name: "job.progress",
        payload: { sessionId: `job-${index}`, revision: index },
      }).status,
      "matched",
    );
  }

  assert.ok(state.ordering.size <= 64);
  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "job.progress",
      payload: { sessionId: "job-255", revision: 255 },
    }).status,
    "stale",
  );
});

test("unordered Events do not scan or clone ordered session history", () => {
  const compiled = compilePlan(
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
            state: { state: "celebrate" },
          },
        },
      ],
    },
    context,
  );
  const state = createPlanEventState();
  for (const collection of [state.ordering, state.sessions]) {
    Object.defineProperty(collection, Symbol.iterator, {
      value() {
        throw new Error("ordered history was scanned");
      },
    });
  }

  assert.equal(
    evaluatePlanEvent(compiled, state, {
      source: "application",
      name: "app.saved",
      payload: { documentId: "guide" },
    }).status,
    "matched",
  );
});

test("conditions are closed typed data and never accept host predicates", () => {
  const baseline = {
    channels: ["state"],
    state: { state: "idle" },
  } as const;
  for (const when of [
    { source: "browser", event: "made-up.event" },
    { source: "application", event: "job.progress", predicate: "payload.ok" },
    { source: "application", event: "job.progress", predicate: () => true },
  ]) {
    assert.throws(
      () =>
        compilePlan(
          {
            baseline,
            rules: [
              {
                id: "invalid-condition",
                when,
                effect: {
                  channels: ["state"],
                  state: { state: "celebrate" },
                },
              },
            ],
          } as never,
          context,
        ),
      /condition|predicate|function|browser event/i,
    );
  }
});

test("Event, State, and interrupt names reject non-string values without coercion", () => {
  const candidates = [
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "array-event",
          when: { source: "application", event: ["job.progress"] },
          effect: { channels: ["state"], state: { state: "celebrate" } },
        },
      ],
    },
    {
      baseline: {
        channels: ["state"],
        state: { state: ["idle"] },
      },
    },
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "array-completion",
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
            until: { type: "event", name: ["notice.closed"] },
          },
        },
      ],
    },
  ];

  for (const candidate of candidates) {
    assert.throws(
      () => compilePlan(candidate as never, context),
      /Event name|State|interrupt|invalid/i,
    );
  }
});

test("Plan preflight returns bounded structured diagnostics without throwing", () => {
  const checked = preflightPlan(
    {
      baseline: {
        channels: ["state"],
        state: { state: "missing" },
      },
      rules: [],
    },
    context,
  );

  assert.equal(checked.valid, false);
  assert.equal(checked.plan, undefined);
  assert.deepEqual(checked.errors, [
    {
      code: "unknown-state",
      path: "$plan.baseline.state.state",
      message: "references unknown Pack State missing",
    },
  ]);
  assert.ok(Object.isFrozen(checked.errors));
  assert.ok(Object.isFrozen(checked.errors[0]));
});

test("one invalid ordered surface does not roll back a valid disjoint surface", () => {
  const compiled = compilePlan(
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "first-progress-surface",
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
          id: "second-progress-surface",
          when: { source: "application", event: "job.progress" },
          effect: {
            channels: ["surface:job-finished"],
            surfaces: [
              {
                id: "job-finished",
                contentId: "job-finished",
                data: "event-payload",
                ordering: {
                  sessionField: "sessionId",
                  revisionField: "otherRevision",
                },
              },
            ],
          },
        },
      ],
    },
    context,
  );
  const state = createPlanEventState();

  const evaluation = evaluatePlanEvent(compiled, state, {
    source: "application",
    name: "job.progress",
    payload: { sessionId: "job-1", revision: 1 },
  });

  assert.equal(evaluation.status, "matched");
  assert.deepEqual(
    evaluation.rules.map((rule) => rule.id),
    ["first-progress-surface"],
  );
  assert.deepEqual(
    (
      evaluation as unknown as {
        rejectedSurfaces: readonly { channel: string; status: string }[];
      }
    ).rejectedSurfaces,
    [{ channel: "surface:job-finished", status: "invalid" }],
  );
  assert.equal(state.ordering.size, 1);
  assert.equal(
    state.ordering.get("surface:job-progress\u0000string\u0000job-1"),
    1,
  );
});

test("Pack State, Capability, and host content references are checked at compile time", () => {
  const cases = [
    {
      plan: {
        baseline: { channels: ["state"], state: { state: "missing" } },
      },
      message: /unknown Pack State missing/,
    },
    {
      plan: {
        baseline: { channels: ["state"], state: { capability: "locomotion" } },
      },
      compileContext: { ...context, capabilities: new Set() },
      message: /unavailable Pack Capability locomotion/,
    },
    {
      plan: {
        baseline: { channels: ["state"], state: { state: "idle" } },
        rules: [
          {
            id: "missing-content",
            when: { source: "application", event: "job.progress" },
            effect: {
              channels: ["surface:missing"],
              surfaces: [{ id: "missing", contentId: "missing" }],
            },
          },
        ],
      },
      message: /unknown content missing/,
    },
  ];

  for (const candidate of cases) {
    assert.throws(
      () =>
        compilePlan(
          candidate.plan as never,
          candidate.compileContext ?? context,
        ),
      candidate.message,
    );
  }
});

test("present optional Plan fields reject null instead of becoming absent", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: { channels: ["state"], state: { state: "idle" } },
          rules: null,
        } as never,
        context,
      ),
    /rules/,
  );
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
            surfaces: null,
          },
        } as never,
        context,
      ),
    /surfaces/,
  );

  for (const [field, effect] of [
    [
      "state",
      {
        channels: ["surface:job-progress"],
        state: null,
        surfaces: [{ id: "job-progress", contentId: "job-progress" }],
      },
    ],
    ["motion", { channels: ["state"], state: { state: "idle" }, motion: null }],
    [
      "until",
      { channels: ["state"], state: { state: "celebrate" }, until: null },
    ],
    [
      "ordering",
      {
        channels: ["surface:job-progress"],
        surfaces: [
          {
            id: "job-progress",
            contentId: "job-progress",
            ordering: null,
          },
        ],
      },
    ],
  ] as const) {
    assert.throws(
      () =>
        compilePlan(
          {
            baseline: { channels: ["state"], state: { state: "idle" } },
            rules: [
              {
                id: `null-${field}`,
                when: { source: "application", event: "test.null" },
                effect,
              },
            ],
          } as never,
          context,
        ),
      new RegExp(field),
    );
  }
});

test("baseline surfaces cannot declare Event ordering", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: {
            channels: ["state", "surface:job-progress"],
            state: { state: "idle" },
            surfaces: [
              {
                id: "job-progress",
                contentId: "job-progress",
                ordering: {
                  sessionField: "sessionId",
                  revisionField: "revision",
                },
              },
            ],
          },
        },
        context,
      ),
    /baseline.*ordering|ordering.*application Event Rule/i,
  );
});

test("Plan compilation never executes getters and enforces the Rule bound", () => {
  let getterCalls = 0;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "baseline", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { channels: ["state"], state: { state: "idle" } };
    },
  });

  const checked = preflightPlan(hostile as never, context);
  assert.equal(checked.valid, false);
  assert.equal(checked.errors[0]?.code, "invalid-data");
  assert.equal(getterCalls, 0);

  const rules = Array.from({ length: 65 }, (_, index) => ({
    id: `rule-${index}`,
    when: { source: "application" as const, event: `event.${index}` },
    effect: { channels: ["state" as const], state: { state: "idle" } },
  }));
  assert.throws(
    () =>
      compilePlan(
        {
          baseline: { channels: ["state"], state: { state: "idle" } },
          rules,
        },
        context,
      ),
    /at most 64 Rules/,
  );
});
