export const PERFORMANCE_CONTRACT = Object.freeze({
  firstFrameP50Ms: 30,
  firstFrameP95Ms: 50,
  runtimeTaskP95Ms: 2,
  runtimeTaskMaxMs: 10,
});

export const REQUIRED_PERFORMANCE_SCENARIOS = Object.freeze([
  "cold-hatch",
  "warm-hatch",
  "steady-motion",
  "event-burst",
  "parked",
  "timed-recovery",
  "resume",
  "cleanup",
]);

const EVENT_BURST_FACTS = 16;
const REQUIRED_BROWSERS = Object.freeze(["chromium", "firefox", "webkit"]);
export const RELEASE_PERFORMANCE_PROFILE = Object.freeze({
  id: "release-0.1.0",
  contract: "peekling-browser-performance-v0.1",
  purpose: "0.1.0 release acceptance",
  startupRepetitions: 40,
  warmupCount: 2,
  steadyFrameCount: 90,
  eventBurstRepetitions: 20,
  lifecycleRepetitions: 10,
  sampleCounts: Object.freeze({
    "cold-hatch": 40,
    "warm-hatch": 40,
    "steady-motion": 1,
    "event-burst": 20,
    parked: 1,
    "timed-recovery": 1,
    resume: 1,
    cleanup: 10,
  }),
});
export const QUICK_PERFORMANCE_PROFILE = Object.freeze({
  id: "quick-local-v0.1",
  contract: "peekling-browser-performance-quick-v0.1",
  purpose: "local performance signal, not release acceptance",
  startupRepetitions: 5,
  warmupCount: 1,
  steadyFrameCount: 30,
  eventBurstRepetitions: 5,
  lifecycleRepetitions: 3,
  sampleCounts: Object.freeze({
    "cold-hatch": 5,
    "warm-hatch": 5,
    "steady-motion": 1,
    "event-burst": 5,
    parked: 1,
    "timed-recovery": 1,
    resume: 1,
    cleanup: 3,
  }),
});

export function aggregateMetric(samples, field) {
  return aggregateValues(
    samples.map((sample) => sample[field]).filter(Number.isFinite),
  );
}

export function aggregateValues(input) {
  const values = [...input]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!values.length) return null;
  return {
    count: values.length,
    minimum: values[0],
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    maximum: values.at(-1),
  };
}

export function summarizeScenario(scenario) {
  const rawSamples = scenario.rawSamples ?? [];
  const runtimeTasks = rawSamples.flatMap(
    (sample) => sample.runtimeTaskDurationsMs ?? [],
  );
  const frameIntervals = rawSamples.flatMap(
    (sample) => sample.rafIntervalsMs ?? [],
  );
  return {
    hatchToVisualFrameMs: aggregateMetric(rawSamples, "hatchToVisualFrameMs"),
    readyToVisualFrameMs: aggregateMetric(rawSamples, "readyToVisualFrameMs"),
    readyToNextNativeFrameMs: aggregateMetric(
      rawSamples,
      "readyToNextNativeFrameMs",
    ),
    achievedFps: aggregateMetric(rawSamples, "achievedFps"),
    rafIntervalsMs: aggregateValues(frameIntervals),
    runtimeTaskDurationsMs: aggregateValues(runtimeTasks),
    requestCount: aggregateMetric(rawSamples, "requestCount"),
    transferBytes: aggregateMetric(rawSamples, "transferBytes"),
    encodedBodyBytes: aggregateMetric(rawSamples, "encodedBodyBytes"),
  };
}

export function evaluatePerformanceReport(report) {
  return evaluateReport(report, RELEASE_PERFORMANCE_PROFILE);
}

export function evaluateQuickPerformanceReport(report) {
  return evaluateReport(report, QUICK_PERFORMANCE_PROFILE);
}

function evaluateReport(report, profile) {
  const failures = [];
  if (
    report?.schemaVersion !== 1 ||
    report?.contract !== profile.contract ||
    report?.profile !== profile.id ||
    report?.context?.purpose !== profile.purpose ||
    [
      "startupRepetitions",
      "warmupCount",
      "steadyFrameCount",
      "eventBurstRepetitions",
      "lifecycleRepetitions",
    ].some((field) => report?.context?.[field] !== profile[field])
  ) {
    add(failures, "report-profile", "release", "profile", {
      measured: {
        contract: report?.contract,
        profile: report?.profile,
        purpose: report?.context?.purpose,
      },
      required: {
        contract: profile.contract,
        profile: profile.id,
        purpose: profile.purpose,
      },
    });
  }
  if (!matchesExactNumberRecord(report?.thresholds, PERFORMANCE_CONTRACT)) {
    add(failures, "report-thresholds", "release", "thresholds", {
      measured: report?.thresholds ?? null,
      required: { ...PERFORMANCE_CONTRACT },
    });
  }
  const browsers = Array.isArray(report.browsers) ? report.browsers : [];
  const measuredBrowsers = browsers.map((browser) => browser?.name);
  if (
    measuredBrowsers.length !== REQUIRED_BROWSERS.length ||
    REQUIRED_BROWSERS.some(
      (name) => measuredBrowsers.filter((value) => value === name).length !== 1,
    )
  ) {
    add(failures, "browser-matrix", "release", "browser-matrix", {
      measured: measuredBrowsers,
      required: [...REQUIRED_BROWSERS],
    });
  }
  for (const browser of browsers) {
    const scenarios = browser.scenarios ?? {};
    for (const name of REQUIRED_PERFORMANCE_SCENARIOS) {
      const samples = Array.isArray(scenarios[name]?.rawSamples)
        ? scenarios[name].rawSamples
        : [];
      if (!samples.length) {
        add(failures, "missing-scenario", browser.name, name);
        continue;
      }
      const required = profile.sampleCounts[name];
      if (samples.length !== required) {
        add(failures, "sample-count", browser.name, name, {
          measured: samples.length,
          required,
        });
      }
      for (const metric of missingScenarioMetrics(name, samples)) {
        add(failures, "missing-metric", browser.name, name, { metric });
      }
    }

    for (const name of ["cold-hatch", "warm-hatch"]) {
      const summary = summarizeScenario(scenarios[name] ?? {});
      if (
        summary.hatchToVisualFrameMs?.p50 > PERFORMANCE_CONTRACT.firstFrameP50Ms
      ) {
        add(failures, "first-frame-p50", browser.name, name, {
          measured: summary.hatchToVisualFrameMs.p50,
          threshold: PERFORMANCE_CONTRACT.firstFrameP50Ms,
        });
      }
      if (
        summary.hatchToVisualFrameMs?.p95 > PERFORMANCE_CONTRACT.firstFrameP95Ms
      ) {
        add(failures, "first-frame-p95", browser.name, name, {
          measured: summary.hatchToVisualFrameMs.p95,
          threshold: PERFORMANCE_CONTRACT.firstFrameP95Ms,
        });
      }
      if (
        scenarios[name]?.rawSamples?.some(
          (sample) =>
            sample.eligibleVisual !== true ||
            sample.nativeFramesAfterReady !== 1 ||
            sample.visualMilestone !== "native-animation-frame-after-ready",
        )
      ) {
        add(failures, "first-frame-evidence", browser.name, name);
      }
    }

    let taskP95Failed = false;
    let taskMaxFailed = false;
    for (const [name, scenario] of Object.entries(scenarios)) {
      const tasks = summarizeScenario(scenario).runtimeTaskDurationsMs;
      if (
        tasks?.p95 > PERFORMANCE_CONTRACT.runtimeTaskP95Ms &&
        !taskP95Failed
      ) {
        taskP95Failed = true;
        add(failures, "runtime-task-p95", browser.name, name, {
          measured: tasks.p95,
          threshold: PERFORMANCE_CONTRACT.runtimeTaskP95Ms,
        });
      }
      if (
        tasks?.maximum > PERFORMANCE_CONTRACT.runtimeTaskMaxMs &&
        !taskMaxFailed
      ) {
        taskMaxFailed = true;
        add(failures, "runtime-task-max", browser.name, name, {
          measured: tasks.maximum,
          threshold: PERFORMANCE_CONTRACT.runtimeTaskMaxMs,
        });
      }
    }

    if (
      scenarios["event-burst"]?.rawSamples?.some(
        (sample) => sample.maximumPendingRuntimeRaf > 1,
      )
    ) {
      add(failures, "event-cadence", browser.name, "event-burst");
    }
    const rejectedBurst = scenarios["event-burst"]?.rawSamples?.find(
      (sample) =>
        Number.isFinite(sample.acceptedEvents) &&
        sample.acceptedEvents !== EVENT_BURST_FACTS,
    );
    if (rejectedBurst) {
      add(failures, "event-admission", browser.name, "event-burst", {
        measured: rejectedBurst.acceptedEvents,
        required: EVENT_BURST_FACTS,
      });
    }
    if (
      scenarios.parked?.rawSamples?.some(
        (sample) =>
          sample.runtimeRafCallbacks !== 0 ||
          sample.runtimeTimerCallbacks !== 0 ||
          sample.runtimeTimerSchedules !== 0,
      )
    ) {
      add(failures, "parked-work", browser.name, "parked");
    }
    if (
      scenarios["timed-recovery"]?.rawSamples?.some(
        (sample) =>
          sample.runtimeRafCallbacks !== 0 ||
          sample.runtimeTimerCallbacks !== 0 ||
          sample.runtimeTimerSchedules !== 1 ||
          sample.recoveryTimersDuring !== 1 ||
          sample.recoveryTimersAfterShow !== 0 ||
          sample.recoveryTimersAfterExpiry !== 0 ||
          sample.recoveryTimersAfterDestroy !== 0 ||
          !Number.isFinite(sample.recoveryTimerDelayMs) ||
          sample.recoveryTimerDelayMs <= 0 ||
          sample.expiryAdvanced !== true ||
          sample.hiddenAfterExpiry !== false ||
          sample.storageDenied !== true,
      )
    ) {
      add(failures, "timed-recovery", browser.name, "timed-recovery");
    }
    if (
      scenarios.resume?.rawSamples?.some((sample) => sample.resumed !== true)
    ) {
      add(failures, "resume-failed", browser.name, "resume");
    }
    if (
      scenarios.cleanup?.rawSamples?.some(
        (sample) =>
          sample.ownedRoots !== 0 ||
          sample.activeRuntimeRaf !== 0 ||
          sample.activeRuntimeTimers !== 0 ||
          sample.activeObjectUrls !== 0 ||
          sample.postDestroyScheduledWork !== 0 ||
          sample.resourceRequestsAfterDestroy !== 0,
      )
    ) {
      add(failures, "cleanup-residue", browser.name, "cleanup");
    }
    if (browser.pageErrors?.length || browser.unhandledRejections?.length) {
      add(failures, "page-error", browser.name, "browser");
    }
    if (browser.cspViolations?.length) {
      add(failures, "csp-violation", browser.name, "browser");
    }
  }
  return failures;
}

function missingScenarioMetrics(name, samples) {
  const runtimeTasks = ["steady-motion", "event-burst", "resume"].includes(name)
    ? nonEmptyFiniteArray
    : finiteArray;
  const checks = [
    ["runtimeTaskDurationsMs", runtimeTasks],
    ...(name === "cold-hatch" || name === "warm-hatch"
      ? [
          ["hatchToVisualFrameMs", finiteNumber],
          ["readyToVisualFrameMs", finiteNumber],
          ["readyToNextNativeFrameMs", finiteNumber],
          ["eligibleVisual", trueValue],
          ["nativeFramesAfterReady", oneNativeFrame],
          ["visualMilestone", nativeFrameMilestone],
          ["requestCount", finiteNumber],
          ["transferBytes", finiteNumber],
          ["encodedBodyBytes", finiteNumber],
        ]
      : []),
    ...(name === "steady-motion"
      ? [
          ["rafIntervalsMs", nonEmptyFiniteArray],
          ["achievedFps", finiteNumber],
          ["maximumPendingRuntimeRaf", finiteNumber],
        ]
      : []),
    ...(name === "event-burst"
      ? [
          ["acceptedEvents", finiteNumber],
          ["maximumPendingRuntimeRaf", finiteNumber],
        ]
      : []),
    ...(name === "parked"
      ? [
          ["runtimeRafCallbacks", finiteNumber],
          ["runtimeTimerCallbacks", finiteNumber],
          ["runtimeTimerSchedules", finiteNumber],
        ]
      : []),
    ...(name === "timed-recovery"
      ? [
          ["runtimeRafCallbacks", finiteNumber],
          ["runtimeTimerCallbacks", finiteNumber],
          ["runtimeTimerSchedules", finiteNumber],
          ["recoveryTimersDuring", finiteNumber],
          ["recoveryTimersAfterShow", finiteNumber],
          ["recoveryTimersAfterExpiry", finiteNumber],
          ["recoveryTimersAfterDestroy", finiteNumber],
          ["recoveryTimerDelayMs", finiteNumber],
          ["expiryAdvanced", trueValue],
          ["hiddenAfterExpiry", falseValue],
          ["storageDenied", trueValue],
        ]
      : []),
    ...(name === "resume"
      ? [
          ["hatchToVisualFrameMs", finiteNumber],
          ["resumed", booleanValue],
        ]
      : []),
    ...(name === "cleanup"
      ? [
          ["ownedRoots", finiteNumber],
          ["activeRuntimeRaf", finiteNumber],
          ["activeRuntimeTimers", finiteNumber],
          ["activeObjectUrls", finiteNumber],
          ["postDestroyScheduledWork", finiteNumber],
          ["resourceRequestsAfterDestroy", finiteNumber],
        ]
      : []),
  ];
  return checks
    .filter(([field, valid]) =>
      samples.some((sample) => !valid(sample?.[field])),
    )
    .map(([field]) => field);
}

function finiteNumber(value) {
  return Number.isFinite(value);
}

function matchesExactNumberRecord(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    const expectedKeys = Object.keys(expected);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return false;
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor?.enumerable === true &&
        "value" in descriptor &&
        typeof descriptor.value === "number" &&
        Number.isFinite(descriptor.value) &&
        descriptor.value === expected[key]
      );
    });
  } catch {
    return false;
  }
}

function oneNativeFrame(value) {
  return value === 1;
}

function finiteArray(value) {
  return Array.isArray(value) && value.every(Number.isFinite);
}

function nonEmptyFiniteArray(value) {
  return finiteArray(value) && value.length > 0;
}

function booleanValue(value) {
  return typeof value === "boolean";
}

function trueValue(value) {
  return value === true;
}

function falseValue(value) {
  return value === false;
}

function nativeFrameMilestone(value) {
  return value === "native-animation-frame-after-ready";
}

export function finalizePerformanceReport(context, browsers, mode = "release") {
  const profile =
    mode === "release"
      ? RELEASE_PERFORMANCE_PROFILE
      : mode === "quick"
        ? QUICK_PERFORMANCE_PROFILE
        : undefined;
  if (!profile) throw new TypeError(`Unknown performance profile: ${mode}`);
  const measuredBrowsers = browsers.map((browser) => ({
    ...browser,
    scenarios: Object.fromEntries(
      Object.entries(browser.scenarios).map(([name, scenario]) => [
        name,
        { ...scenario, summary: summarizeScenario(scenario) },
      ]),
    ),
  }));
  const report = {
    ...context,
    schemaVersion: 1,
    contract: profile.contract,
    profile: profile.id,
    context: {
      ...(context.context ?? {}),
      purpose: profile.purpose,
      startupRepetitions: profile.startupRepetitions,
      warmupCount: profile.warmupCount,
      steadyFrameCount: profile.steadyFrameCount,
      eventBurstRepetitions: profile.eventBurstRepetitions,
      lifecycleRepetitions: profile.lifecycleRepetitions,
    },
    thresholds: PERFORMANCE_CONTRACT,
    browsers: measuredBrowsers,
  };
  const failures =
    mode === "release"
      ? evaluatePerformanceReport(report)
      : evaluateQuickPerformanceReport(report);
  return {
    ...report,
    gate: {
      passed: failures.length === 0,
      releaseAcceptance: mode === "release",
      failures,
    },
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function add(failures, code, browser, scenario, detail = {}) {
  failures.push({ code, browser, scenario, ...detail });
}
