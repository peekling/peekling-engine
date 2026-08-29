import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  aggregateMetric,
  evaluatePerformanceReport,
  evaluateQuickPerformanceReport,
  finalizePerformanceReport,
  PERFORMANCE_CONTRACT,
  QUICK_PERFORMANCE_PROFILE,
  RELEASE_PERFORMANCE_PROFILE,
} from "../scripts/browser-performance-core.mjs";

const passingBrowser = {
  name: "chromium",
  version: "fixture",
  userAgent: "fixture",
  longTasks: { supported: false, entries: null },
  scenarios: {
    "cold-hatch": {
      cacheProfile: "loopback-no-store",
      warmupCount: 0,
      rawSamples: Array.from({ length: 40 }, (_, index) => ({
        hatchToVisualFrameMs: 10 + index / 2,
        readyToVisualFrameMs: 4,
        readyToNextNativeFrameMs: 16,
        eligibleVisual: true,
        nativeFramesAfterReady: 1,
        visualMilestone: "native-animation-frame-after-ready",
        runtimeTaskDurationsMs: [0.2, 0.4],
        requestCount: 3,
        transferBytes: 100,
        encodedBodyBytes: 100,
      })),
    },
    "warm-hatch": {
      cacheProfile: "loopback-cacheable",
      warmupCount: 2,
      rawSamples: Array.from({ length: 40 }, () => ({
        hatchToVisualFrameMs: 12,
        readyToVisualFrameMs: 3,
        readyToNextNativeFrameMs: 16,
        eligibleVisual: true,
        nativeFramesAfterReady: 1,
        visualMilestone: "native-animation-frame-after-ready",
        runtimeTaskDurationsMs: [0.1],
        requestCount: 3,
        transferBytes: 0,
        encodedBodyBytes: 100,
      })),
    },
    "steady-motion": {
      cacheProfile: "loopback-cacheable",
      warmupCount: 1,
      rawSamples: [
        {
          rafIntervalsMs: [16, 17, 16],
          achievedFps: 61.22,
          runtimeTaskDurationsMs: [0.3, 0.4],
          maximumPendingRuntimeRaf: 1,
        },
      ],
    },
    "event-burst": {
      cacheProfile: "loopback-cacheable",
      warmupCount: 1,
      rawSamples: Array.from({ length: 20 }, () => ({
        runtimeTaskDurationsMs: [0.4],
        maximumPendingRuntimeRaf: 1,
        acceptedEvents: 16,
      })),
    },
    parked: {
      cacheProfile: "loopback-cacheable",
      warmupCount: 1,
      rawSamples: [
        {
          runtimeRafCallbacks: 0,
          runtimeTimerCallbacks: 0,
          runtimeTimerSchedules: 0,
          runtimeTaskDurationsMs: [],
        },
      ],
    },
    "timed-recovery": {
      cacheProfile: "loopback-cacheable",
      warmupCount: 1,
      rawSamples: [
        {
          runtimeRafCallbacks: 0,
          runtimeTimerCallbacks: 0,
          runtimeTimerSchedules: 1,
          activeRuntimeTimersDuring: 1,
          activeRuntimeTimersAfterShow: 0,
          recoveryTimersDuring: 1,
          recoveryTimersAfterShow: 0,
          recoveryTimersAfterExpiry: 0,
          recoveryTimersAfterDestroy: 0,
          recoveryTimerDelayMs: 600_000,
          expiryAdvanced: true,
          hiddenAfterExpiry: false,
          storageDenied: true,
          runtimeTaskDurationsMs: [],
        },
      ],
    },
    resume: {
      cacheProfile: "loopback-cacheable",
      warmupCount: 1,
      rawSamples: [
        {
          hatchToVisualFrameMs: 15,
          runtimeTaskDurationsMs: [0.2],
          resumed: true,
        },
      ],
    },
    cleanup: {
      cacheProfile: "loopback-cacheable",
      warmupCount: 1,
      rawSamples: Array.from({ length: 10 }, () => ({
        ownedRoots: 0,
        activeRuntimeRaf: 0,
        activeRuntimeTimers: 0,
        activeObjectUrls: 0,
        postDestroyScheduledWork: 0,
        resourceRequestsAfterDestroy: 0,
        runtimeTaskDurationsMs: [],
      })),
    },
  },
  pageErrors: [],
  unhandledRejections: [],
  cspViolations: [],
};

function browserMatrix(chromium = passingBrowser) {
  const firefox = structuredClone(passingBrowser);
  firefox.name = "firefox";
  const webkit = structuredClone(passingBrowser);
  webkit.name = "webkit";
  return [chromium, firefox, webkit];
}

function releaseReport(browsers = browserMatrix()) {
  return {
    schemaVersion: 1,
    contract: RELEASE_PERFORMANCE_PROFILE.contract,
    profile: RELEASE_PERFORMANCE_PROFILE.id,
    context: {
      purpose: RELEASE_PERFORMANCE_PROFILE.purpose,
      startupRepetitions: RELEASE_PERFORMANCE_PROFILE.startupRepetitions,
      warmupCount: RELEASE_PERFORMANCE_PROFILE.warmupCount,
      steadyFrameCount: RELEASE_PERFORMANCE_PROFILE.steadyFrameCount,
      eventBurstRepetitions: RELEASE_PERFORMANCE_PROFILE.eventBurstRepetitions,
      lifecycleRepetitions: RELEASE_PERFORMANCE_PROFILE.lifecycleRepetitions,
    },
    thresholds: { ...PERFORMANCE_CONTRACT },
    browsers,
  };
}

function quickBrowser(name) {
  const browser = structuredClone(passingBrowser);
  browser.name = name;
  browser.scenarios["cold-hatch"].rawSamples.length =
    QUICK_PERFORMANCE_PROFILE.startupRepetitions;
  browser.scenarios["warm-hatch"].rawSamples.length =
    QUICK_PERFORMANCE_PROFILE.startupRepetitions;
  browser.scenarios["event-burst"].rawSamples.length =
    QUICK_PERFORMANCE_PROFILE.eventBurstRepetitions;
  browser.scenarios.cleanup.rawSamples.length =
    QUICK_PERFORMANCE_PROFILE.lifecycleRepetitions;
  return browser;
}

test("metric aggregation retains literal samples and uses nearest-rank percentiles", () => {
  const raw = Array.from({ length: 20 }, (_, index) => ({ value: index + 1 }));
  const result = aggregateMetric(raw, "value");
  assert.deepEqual(result, {
    count: 20,
    minimum: 1,
    p50: 10,
    p95: 19,
    maximum: 20,
  });
  assert.deepEqual(
    raw.map(({ value }) => value),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
});

test("the release gate reports exact threshold and lifecycle failures", () => {
  const browser = structuredClone(passingBrowser);
  browser.scenarios["cold-hatch"].rawSamples[37].hatchToVisualFrameMs = 51;
  browser.scenarios["cold-hatch"].rawSamples[38].hatchToVisualFrameMs = 60;
  browser.scenarios["cold-hatch"].rawSamples[39].hatchToVisualFrameMs = 70;
  browser.scenarios["steady-motion"].rawSamples[0].runtimeTaskDurationsMs = [
    1, 3, 11,
  ];
  browser.scenarios.parked.rawSamples[0].runtimeTimerSchedules = 1;
  browser.scenarios.cleanup.rawSamples[0].ownedRoots = 1;

  assert.deepEqual(
    evaluatePerformanceReport(releaseReport(browserMatrix(browser))).map(
      ({ code }) => code,
    ),
    [
      "first-frame-p95",
      "runtime-task-p95",
      "runtime-task-max",
      "parked-work",
      "cleanup-residue",
    ],
  );
});

test("the release gate permits only one bounded timed-recovery wake", () => {
  const missingWake = structuredClone(passingBrowser);
  missingWake.scenarios["timed-recovery"].rawSamples[0].recoveryTimersDuring =
    0;
  const leakedWake = structuredClone(passingBrowser);
  leakedWake.scenarios["timed-recovery"].rawSamples[0].recoveryTimersAfterShow =
    1;
  const unrelatedTimer = structuredClone(passingBrowser);
  unrelatedTimer.scenarios[
    "timed-recovery"
  ].rawSamples[0].activeRuntimeTimersAfterShow = 1;

  assert.deepEqual(
    evaluatePerformanceReport(releaseReport(browserMatrix(missingWake))).map(
      ({ code }) => code,
    ),
    ["timed-recovery"],
  );
  assert.deepEqual(
    evaluatePerformanceReport(releaseReport(browserMatrix(leakedWake))).map(
      ({ code }) => code,
    ),
    ["timed-recovery"],
  );
  assert.deepEqual(
    evaluatePerformanceReport(releaseReport(browserMatrix(unrelatedTimer))),
    [],
  );
});

test("the release gate requires exactly Chromium, Firefox, and WebKit", () => {
  const firefox = structuredClone(passingBrowser);
  firefox.name = "firefox";
  const webkit = structuredClone(passingBrowser);
  webkit.name = "webkit";

  assert.deepEqual(evaluatePerformanceReport(releaseReport([])), [
    {
      code: "browser-matrix",
      browser: "release",
      scenario: "browser-matrix",
      measured: [],
      required: ["chromium", "firefox", "webkit"],
    },
  ]);
  assert.deepEqual(
    evaluatePerformanceReport(releaseReport([passingBrowser]))[0],
    {
      code: "browser-matrix",
      browser: "release",
      scenario: "browser-matrix",
      measured: ["chromium"],
      required: ["chromium", "firefox", "webkit"],
    },
  );
  assert.deepEqual(
    evaluatePerformanceReport(
      releaseReport([passingBrowser, structuredClone(passingBrowser), webkit]),
    )[0],
    {
      code: "browser-matrix",
      browser: "release",
      scenario: "browser-matrix",
      measured: ["chromium", "chromium", "webkit"],
      required: ["chromium", "firefox", "webkit"],
    },
  );
  assert.equal(
    evaluatePerformanceReport(releaseReport([passingBrowser, firefox, webkit]))
      .length,
    0,
  );
});

test("the release gate rejects missing required raw metrics", () => {
  const browser = structuredClone(passingBrowser);
  delete browser.scenarios["cold-hatch"].rawSamples[0].hatchToVisualFrameMs;
  delete browser.scenarios["warm-hatch"].rawSamples[0].nativeFramesAfterReady;
  delete browser.scenarios["steady-motion"].rawSamples[0].rafIntervalsMs;

  const failures = evaluatePerformanceReport(
    releaseReport(browserMatrix(browser)),
  );

  assert.deepEqual(
    failures
      .filter(({ code }) => code === "missing-metric")
      .map(({ scenario, metric }) => [scenario, metric]),
    [
      ["cold-hatch", "hatchToVisualFrameMs"],
      ["warm-hatch", "nativeFramesAfterReady"],
      ["steady-motion", "rafIntervalsMs"],
    ],
  );
});

test("active scenarios cannot pass without measured runtime callbacks", () => {
  const browser = structuredClone(passingBrowser);
  for (const name of ["steady-motion", "event-burst", "resume"]) {
    browser.scenarios[name].rawSamples[0].runtimeTaskDurationsMs = [];
  }

  assert.deepEqual(
    evaluatePerformanceReport(releaseReport(browserMatrix(browser)))
      .filter(
        ({ code, metric }) =>
          code === "missing-metric" && metric === "runtimeTaskDurationsMs",
      )
      .map(({ scenario }) => scenario),
    ["steady-motion", "event-burst", "resume"],
  );
});

test("the release gate enforces immutable exact raw sample counts", () => {
  const browser = structuredClone(passingBrowser);
  browser.scenarios["cold-hatch"].rawSamples.pop();
  browser.scenarios["warm-hatch"].rawSamples.push(
    structuredClone(browser.scenarios["warm-hatch"].rawSamples[0]),
  );
  browser.scenarios["event-burst"].rawSamples.pop();
  browser.scenarios.cleanup.rawSamples.pop();
  const failures = evaluatePerformanceReport(
    releaseReport(browserMatrix(browser)),
  );

  assert.deepEqual(
    failures
      .filter(({ code }) => code === "sample-count")
      .filter(({ browser: name }) => name === "chromium")
      .map(({ scenario, measured, required }) => [
        scenario,
        measured,
        required,
      ]),
    [
      ["cold-hatch", 39, 40],
      ["warm-hatch", 41, 40],
      ["event-burst", 19, 20],
      ["cleanup", 9, 10],
    ],
  );
});

test("release acceptance ignores tampered report sample claims", () => {
  const browser = structuredClone(passingBrowser);
  browser.scenarios["cold-hatch"].rawSamples = browser.scenarios[
    "cold-hatch"
  ].rawSamples.slice(0, 5);
  browser.scenarios["warm-hatch"].rawSamples = browser.scenarios[
    "warm-hatch"
  ].rawSamples.slice(0, 5);
  const failures = evaluatePerformanceReport({
    schemaVersion: 1,
    contract: "peekling-browser-performance-v0.1",
    profile: "release-0.1.1",
    context: {
      purpose: "0.1.1 release acceptance",
      startupRepetitions: 5,
      warmupCount: 1,
      steadyFrameCount: 30,
      eventBurstRepetitions: 1,
      lifecycleRepetitions: 1,
    },
    browsers: ["chromium", "firefox", "webkit"].map((name) => ({
      ...structuredClone(browser),
      name,
    })),
  });

  assert.equal(
    failures.some(({ code }) => code === "report-profile"),
    true,
  );
  assert.deepEqual(
    failures
      .filter(
        ({ code, scenario }) =>
          code === "sample-count" &&
          (scenario === "cold-hatch" || scenario === "warm-hatch"),
      )
      .map(({ browser, scenario, measured, required }) => [
        browser,
        scenario,
        measured,
        required,
      ]),
    [
      ["chromium", "cold-hatch", 5, 40],
      ["chromium", "warm-hatch", 5, 40],
      ["firefox", "cold-hatch", 5, 40],
      ["firefox", "warm-hatch", 5, 40],
      ["webkit", "cold-hatch", 5, 40],
      ["webkit", "warm-hatch", 5, 40],
    ],
  );
});

test("release acceptance rejects threshold metadata that differs from policy", () => {
  const cases = [
    ["missing thresholds", (report) => delete report.thresholds],
    ["missing key", (report) => delete report.thresholds.firstFrameP50Ms],
    ["extra key", (report) => (report.thresholds.futureGateMs = 1)],
    ["changed value", (report) => (report.thresholds.firstFrameP50Ms = 999)],
    ["string value", (report) => (report.thresholds.firstFrameP50Ms = "30")],
    [
      "nonfinite value",
      (report) => (report.thresholds.firstFrameP50Ms = Infinity),
    ],
    ["NaN value", (report) => (report.thresholds.firstFrameP50Ms = Number.NaN)],
    ["null metadata", (report) => (report.thresholds = null)],
  ];

  assert.equal(
    evaluatePerformanceReport(releaseReport()).some(
      ({ code }) => code === "report-thresholds",
    ),
    false,
  );

  for (const [label, tamper] of cases) {
    const report = releaseReport();
    tamper(report);
    assert.equal(
      evaluatePerformanceReport(report).some(
        ({ code }) => code === "report-thresholds",
      ),
      true,
      label,
    );
  }
});

test("runtime task p95 uses a repeated burst corpus", () => {
  const browser = structuredClone(passingBrowser);
  browser.scenarios["event-burst"].rawSamples = Array.from(
    { length: 20 },
    () => ({
      runtimeTaskDurationsMs: [1],
      maximumPendingRuntimeRaf: 1,
      acceptedEvents: 16,
    }),
  );
  browser.scenarios["event-burst"].rawSamples[19].runtimeTaskDurationsMs = [3];

  assert.equal(
    evaluatePerformanceReport(releaseReport(browserMatrix(browser))).some(
      ({ code }) => code === "runtime-task-p95",
    ),
    false,
  );

  browser.scenarios["event-burst"].rawSamples[18].runtimeTaskDurationsMs = [3];
  assert.deepEqual(
    evaluatePerformanceReport(releaseReport(browserMatrix(browser))).filter(
      ({ code }) => code === "runtime-task-p95",
    ),
    [
      {
        code: "runtime-task-p95",
        browser: "chromium",
        scenario: "event-burst",
        measured: 3,
        threshold: 2,
      },
    ],
  );
});

test("the event-burst gate requires every declared fact to be admitted", () => {
  const browser = structuredClone(passingBrowser);
  browser.scenarios["event-burst"].rawSamples[0].acceptedEvents = 15;

  assert.deepEqual(
    evaluatePerformanceReport(releaseReport(browserMatrix(browser))).filter(
      ({ code }) => code === "event-admission",
    ),
    [
      {
        code: "event-admission",
        browser: "chromium",
        scenario: "event-burst",
        measured: 15,
        required: 16,
      },
    ],
  );
});

test("finalization keeps every raw sample and records unsupported long-task data", () => {
  const context = {
    generatedAt: "2026-08-27T00:00:00.000Z",
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  };
  const report = finalizePerformanceReport(context, browserMatrix());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.contract, "peekling-browser-performance-v0.1");
  assert.equal(report.profile, "release-0.1.1");
  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.releaseAcceptance, true);
  assert.equal(
    report.browsers[0].scenarios["cold-hatch"].rawSamples.length,
    40,
  );
  assert.equal(
    report.browsers[0].scenarios["warm-hatch"].rawSamples.length,
    40,
  );
  assert.deepEqual(
    report.browsers[0].scenarios["cold-hatch"].rawSamples,
    passingBrowser.scenarios["cold-hatch"].rawSamples,
  );
  assert.deepEqual(report.browsers[0].longTasks, {
    supported: false,
    entries: null,
  });
});

test("quick reports are distinct and cannot become release acceptance by relabeling", () => {
  const browsers = ["chromium", "firefox", "webkit"].map(quickBrowser);
  const quick = finalizePerformanceReport(
    { generatedAt: "2026-08-27T00:00:00.000Z" },
    browsers,
    "quick",
  );
  assert.equal(quick.contract, QUICK_PERFORMANCE_PROFILE.contract);
  assert.equal(quick.profile, QUICK_PERFORMANCE_PROFILE.id);
  assert.equal(quick.gate.passed, true);
  assert.equal(quick.gate.releaseAcceptance, false);
  assert.deepEqual(evaluateQuickPerformanceReport(quick), []);
  assert.equal(
    evaluatePerformanceReport(quick).some(
      ({ code }) => code === "report-profile",
    ),
    true,
  );

  const relabeled = structuredClone(quick);
  relabeled.contract = RELEASE_PERFORMANCE_PROFILE.contract;
  relabeled.profile = RELEASE_PERFORMANCE_PROFILE.id;
  Object.assign(relabeled.context, {
    purpose: RELEASE_PERFORMANCE_PROFILE.purpose,
    startupRepetitions: RELEASE_PERFORMANCE_PROFILE.startupRepetitions,
    warmupCount: RELEASE_PERFORMANCE_PROFILE.warmupCount,
    steadyFrameCount: RELEASE_PERFORMANCE_PROFILE.steadyFrameCount,
    eventBurstRepetitions: RELEASE_PERFORMANCE_PROFILE.eventBurstRepetitions,
    lifecycleRepetitions: RELEASE_PERFORMANCE_PROFILE.lifecycleRepetitions,
  });
  assert.deepEqual(
    evaluatePerformanceReport(relabeled)
      .filter(
        ({ code, scenario }) =>
          code === "sample-count" &&
          (scenario === "cold-hatch" || scenario === "warm-hatch"),
      )
      .map(({ browser, measured, required }) => [browser, measured, required]),
    [
      ["chromium", 5, 40],
      ["chromium", 5, 40],
      ["firefox", 5, 40],
      ["firefox", 5, 40],
      ["webkit", 5, 40],
      ["webkit", 5, 40],
    ],
  );
});

test("the production browser artifact excludes the release harness", async () => {
  const artifact = await readFile(
    new URL("../packages/runtime/dist/peekling.min.js", import.meta.url),
    "utf8",
  );
  assert.equal(artifact.includes("peekling-browser-performance-v0.1"), false);
  assert.equal(artifact.includes("hatchToVisualFrameMs"), false);
});
