import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticChannel } from "../dist/diagnostics.js";

test("override diagnostics expose the documented overrideId field", () => {
  const channel = new DiagnosticChannel({
    instanceId: "diagnostic-fixture",
    now: () => 0,
    console: false,
  });

  const record = channel.emit({
    code: "override.fixture",
    severity: "warning",
    message: "Override fixture",
    phase: "override",
    overrideId: "override-7",
  });

  assert.equal(record?.overrideId, "override-7");
  assert.equal(Object.hasOwn(record ?? {}, "requestId"), false);
});

test("default console diagnostics stay quiet for routine records and surface errors", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
  try {
    const channel = new DiagnosticChannel({
      instanceId: "diagnostic-fixture",
      now: () => 0,
    });
    channel.emit({
      code: "lifecycle.paused",
      severity: "info",
      message: "Paused",
      phase: "lifecycle",
    });
    channel.emit({
      code: "event.unmatched",
      severity: "info",
      message: "Event did not match",
      phase: "event",
    });
    assert.deepEqual(warnings, []);

    channel.emit({
      code: "render.failed",
      severity: "error",
      message: "Render failed",
      phase: "render",
    });
    assert.deepEqual(warnings, ["[Peekling] Render failed"]);
  } finally {
    console.warn = original;
  }
});

test("configured diagnostic sinks and console policy receive the selected records", () => {
  const warnings: string[] = [];
  const records: string[] = [];
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
  try {
    const configured = new DiagnosticChannel({
      instanceId: "configured",
      now: () => 0,
      console: true,
    });
    configured.emit({
      code: "lifecycle.resumed",
      severity: "info",
      message: "Resumed",
      phase: "lifecycle",
    });

    const sinks = new DiagnosticChannel({
      instanceId: "sinks",
      now: () => 0,
      logger: (record) => records.push(record.code),
      messageSink: (message) => messages.push(message),
    });
    sinks.emit({
      code: "event.unmatched",
      severity: "info",
      message: "Event did not match",
      phase: "event",
    });

    const disabled = new DiagnosticChannel({
      instanceId: "disabled",
      now: () => 0,
      console: false,
    });
    disabled.emit({
      code: "render.failed",
      severity: "error",
      message: "Hidden render failure",
      phase: "render",
    });

    assert.deepEqual(warnings, ["[Peekling] Resumed"]);
    assert.deepEqual(records, ["event.unmatched"]);
    assert.deepEqual(messages, ["Event did not match"]);
  } finally {
    console.warn = original;
  }
});

test("diagnostic rate limiting signals once, stays nonrecursive, and preserves bounded errors", () => {
  let now = 0;
  const records: string[] = [];
  let channel!: DiagnosticChannel;
  channel = new DiagnosticChannel({
    instanceId: "rate-limit",
    now: () => now,
    console: false,
    logger: (record) => {
      records.push(record.code);
      if (record.code === "diagnostics.rate-limited") {
        channel.emit({
          code: "logger.reentrant",
          severity: "error",
          message: "Logger reentered",
          phase: "internal",
        });
      }
    },
  });

  for (let index = 0; index < 64; index += 1) {
    channel.emit({
      code: `routine.${index}`,
      severity: "info",
      message: "Routine",
      phase: "event",
    });
  }
  assert.equal(
    channel.emit({
      code: "routine.overflow",
      severity: "info",
      message: "Routine overflow",
      phase: "event",
    }),
    undefined,
  );
  for (let index = 0; index < 10; index += 1) {
    channel.emit({
      code: `failure.${index}`,
      severity: "error",
      message: "Failure",
      phase: "render",
    });
  }

  assert.equal(
    records.filter((code) => code === "diagnostics.rate-limited").length,
    1,
  );
  assert.equal(records.filter((code) => code.startsWith("failure.")).length, 8);
  assert.equal(records.includes("logger.reentrant"), false);

  now = 60_001;
  assert.equal(
    channel.emit({
      code: "routine.recovered",
      severity: "info",
      message: "Recovered",
      phase: "event",
    })?.code,
    "routine.recovered",
  );
});
