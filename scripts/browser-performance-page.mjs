const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);

const telemetry = {
  rafCallbacks: [],
  rafSchedules: 0,
  maximumPendingRaf: 0,
  activeRaf: new Set(),
  timerCallbacks: 0,
  timerSchedules: 0,
  activeTimers: new Map(),
  objectUrls: new Set(),
};
const cspViolations = [];
const unhandledRejections = [];
const longTaskEntries = [];
let nativeFrameWitnesses = 0;

window.requestAnimationFrame = (callback) => {
  telemetry.rafSchedules += 1;
  let id = 0;
  id = nativeRaf((timestamp) => {
    telemetry.activeRaf.delete(id);
    const start = performance.now();
    try {
      callback(timestamp);
    } finally {
      telemetry.rafCallbacks.push({
        startTime: start,
        duration: performance.now() - start,
      });
    }
  });
  telemetry.activeRaf.add(id);
  telemetry.maximumPendingRaf = Math.max(
    telemetry.maximumPendingRaf,
    telemetry.activeRaf.size,
  );
  return id;
};
window.cancelAnimationFrame = (id) => {
  telemetry.activeRaf.delete(id);
  nativeCancelRaf(id);
};
window.setTimeout = (callback, delay = 0, ...args) => {
  telemetry.timerSchedules += 1;
  let id = 0;
  id = nativeSetTimeout(() => {
    telemetry.activeTimers.delete(id);
    telemetry.timerCallbacks += 1;
    if (typeof callback === "function") callback(...args);
  }, delay);
  telemetry.activeTimers.set(id, {
    callback,
    args,
    delay: Number(delay) || 0,
  });
  return id;
};
window.clearTimeout = (id) => {
  telemetry.activeTimers.delete(id);
  nativeClearTimeout(id);
};
URL.createObjectURL = (value) => {
  const url = nativeCreateObjectUrl(value);
  telemetry.objectUrls.add(url);
  return url;
};
URL.revokeObjectURL = (url) => {
  telemetry.objectUrls.delete(url);
  nativeRevokeObjectUrl(url);
};

addEventListener("securitypolicyviolation", (event) => {
  cspViolations.push({
    directive: event.violatedDirective,
    blockedUri: event.blockedURI,
  });
});
addEventListener("unhandledrejection", (event) => {
  unhandledRejections.push(String(event.reason));
  event.preventDefault();
});

const longTasksSupported =
  typeof PerformanceObserver === "function" &&
  PerformanceObserver.supportedEntryTypes?.includes("longtask");
if (longTasksSupported) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTaskEntries.push({
        startTime: entry.startTime,
        duration: entry.duration,
        name: entry.name,
      });
    }
  });
  observer.observe({ type: "longtask", buffered: true });
}

await waitForRuntime();

window.__peeklingPerformance = Object.freeze({
  run,
  instrumentation: Object.freeze({
    rafWrapped: true,
    timersWrapped: true,
    objectUrlsWrapped: true,
    harnessUsesNativeClock: true,
  }),
});

async function run({
  startupRepetitions = 20,
  warmupCount = 2,
  steadyFrameCount = 90,
  eventBurstRepetitions = 20,
  lifecycleRepetitions = 10,
} = {}) {
  const coldSamples = [];
  for (let index = 0; index < startupRepetitions; index += 1) {
    coldSamples.push(await measureHatch("no-store", `cold-${index}`));
  }

  for (let index = 0; index < warmupCount; index += 1) {
    await measureHatch("warm", "shared");
  }
  const warmSamples = [];
  for (let index = 0; index < startupRepetitions; index += 1) {
    warmSamples.push(await measureHatch("warm", "shared"));
  }

  const steady = await measureSteadyMotion(steadyFrameCount);
  await measureEventBurst();
  const burstSamples = [];
  for (let index = 0; index < eventBurstRepetitions; index += 1) {
    burstSamples.push(await measureEventBurst());
  }
  const { parked, resume } = await measureParkAndResume();
  const timedRecovery = await measureTimedRecovery();
  const cleanupSamples = [];
  for (let index = 0; index < lifecycleRepetitions; index += 1) {
    cleanupSamples.push(await measureCleanup(index));
  }

  return {
    instrumentation: window.__peeklingPerformance.instrumentation,
    longTasks: {
      supported: Boolean(longTasksSupported),
      entries: longTasksSupported ? [...longTaskEntries] : null,
    },
    cspViolations: [...cspViolations],
    unhandledRejections: [...unhandledRejections],
    deliveryResources: resourcesSince(0),
    scenarios: {
      "cold-hatch": scenario("loopback-no-store", 0, coldSamples),
      "warm-hatch": scenario("loopback-cacheable", warmupCount, warmSamples),
      "steady-motion": scenario("loopback-cacheable", 1, [steady]),
      "event-burst": scenario("loopback-cacheable", 1, burstSamples),
      parked: scenario("loopback-cacheable", 1, [parked]),
      "timed-recovery": scenario("loopback-cacheable", 1, [timedRecovery]),
      resume: scenario("loopback-cacheable", 1, [resume]),
      cleanup: scenario("loopback-cacheable", 1, cleanupSamples),
    },
  };
}

async function measureHatch(cacheProfile, sampleId) {
  const mark = snapshot();
  const startedAt = performance.now();
  const instance = window.Peekling.hatch(options(cacheProfile, sampleId));
  await instance.ready;
  const readyAt = performance.now();
  const host = document.querySelector("[data-peekling-host]");
  const eligibleVisual = Boolean(
    host?.isConnected &&
    host.hasAttribute("data-peekling-state") &&
    host.hasAttribute("data-peekling-frame") &&
    host.hasAttribute("data-peekling-x") &&
    host.hasAttribute("data-peekling-y"),
  );
  if (!eligibleVisual) {
    throw new Error(
      "Peekling readiness did not produce an eligible visual root",
    );
  }
  const witnessesBeforeVisual = nativeFrameWitnesses;
  const visualAt = await nextNativeFrame();
  const nativeFramesAfterReady = nativeFrameWitnesses - witnessesBeforeVisual;
  const delta = measurement(mark);
  instance.destroy();
  await nextNativeFrame();
  return {
    hatchToVisualFrameMs: visualAt - startedAt,
    readyToVisualFrameMs: visualAt - readyAt,
    readyToNextNativeFrameMs: visualAt - readyAt,
    eligibleVisual,
    nativeFramesAfterReady,
    visualMilestone: "native-animation-frame-after-ready",
    firstRuntimeRafStartMs:
      telemetry.rafCallbacks[mark.rafCallbacks]?.startTime ?? null,
    runtimeTaskDurationsMs: delta.runtimeTaskDurationsMs,
    ...resourceMeasurement(mark.resources),
  };
}

async function measureSteadyMotion(frameCount) {
  const instance = window.Peekling.hatch(options("warm", "shared"));
  await instance.ready;
  dispatchPointer(760, 300);
  const mark = snapshot();
  const timestamps = [];
  for (let index = 0; index < frameCount; index += 1) {
    timestamps.push(await nextNativeFrame());
  }
  const delta = measurement(mark);
  instance.destroy();
  const intervals = timestamps
    .slice(1)
    .map((timestamp, index) => timestamp - timestamps[index]);
  const elapsed = timestamps.at(-1) - timestamps[0];
  return {
    rafIntervalsMs: intervals,
    achievedFps: elapsed > 0 ? ((timestamps.length - 1) * 1_000) / elapsed : 0,
    runtimeTaskDurationsMs: delta.runtimeTaskDurationsMs,
    maximumPendingRuntimeRaf: delta.maximumPendingRuntimeRaf,
  };
}

async function measureEventBurst() {
  const instance = window.Peekling.hatch(options("warm", "shared"));
  await instance.ready;
  const mark = snapshot(true);
  for (let index = 0; index < 250; index += 1) {
    dispatchPointer(100 + (index % 600), 100 + (index % 300));
  }
  let acceptedEvents = 0;
  for (let index = 0; index < 16; index += 1) {
    if (instance.emit(`perf.fact-${index}`, { index }).accepted) {
      acceptedEvents += 1;
    }
  }
  await frames(8);
  const delta = measurement(mark);
  instance.destroy();
  return {
    acceptedEvents,
    runtimeTaskDurationsMs: delta.runtimeTaskDurationsMs,
    maximumPendingRuntimeRaf: delta.maximumPendingRuntimeRaf,
  };
}

async function measureParkAndResume() {
  const instance = window.Peekling.hatch(options("warm", "shared"));
  await instance.ready;
  window.Peekling.visibility.hide("session");
  await frames(2);
  const parkedMark = snapshot(true);
  await sleep(250);
  const parkedDelta = measurement(parkedMark);

  const resumeMark = snapshot(true);
  const resumedAt = performance.now();
  window.Peekling.visibility.show();
  await waitForRuntimeFrame(resumeMark.rafCallbacks);
  const visualAt = await nextNativeFrame();
  const resumeDelta = measurement(resumeMark);
  instance.destroy();
  return {
    parked: {
      runtimeRafCallbacks: parkedDelta.runtimeRafCallbacks,
      runtimeTimerCallbacks: parkedDelta.runtimeTimerCallbacks,
      runtimeTimerSchedules: parkedDelta.runtimeTimerSchedules,
      runtimeTaskDurationsMs: parkedDelta.runtimeTaskDurationsMs,
    },
    resume: {
      hatchToVisualFrameMs: visualAt - resumedAt,
      resumed: resumeDelta.runtimeRafCallbacks > 0,
      runtimeTaskDurationsMs: resumeDelta.runtimeTaskDurationsMs,
    },
  };
}

async function measureTimedRecovery() {
  let instance;
  const storage = denyStorage();
  try {
    instance = window.Peekling.hatch(options("warm", "shared"));
    await instance.ready;

    const beforeShowCase = activeTimerIds();
    const mark = snapshot(true);
    window.Peekling.visibility.hide("10-minutes");
    await frames(2);
    const during = measurement(mark);
    const showRecoveryIds = addedTimerIds(beforeShowCase);
    const recoveryTimersDuring = activeTimerCount(showRecoveryIds);
    const recoveryTimerDelayMs =
      showRecoveryIds.length === 1
        ? (telemetry.activeTimers.get(showRecoveryIds[0])?.delay ?? null)
        : null;
    const activeRuntimeTimersDuring = telemetry.activeTimers.size;
    window.Peekling.visibility.show();
    await frames(1);
    const recoveryTimersAfterShow = activeTimerCount(showRecoveryIds);
    const activeRuntimeTimersAfterShow = telemetry.activeTimers.size;

    const beforeExpiryCase = activeTimerIds();
    window.Peekling.visibility.hide("10-minutes");
    const expiryRecoveryIds = addedTimerIds(beforeExpiryCase);
    const expiryAdvanced =
      expiryRecoveryIds.length === 1 && fireTimer(expiryRecoveryIds[0]);
    await Promise.resolve();
    const recoveryTimersAfterExpiry = activeTimerCount(expiryRecoveryIds);
    const hiddenAfterExpiry = window.Peekling.visibility.isHidden();

    const beforeDestroyCase = activeTimerIds();
    window.Peekling.visibility.hide("10-minutes");
    const destroyRecoveryIds = addedTimerIds(beforeDestroyCase);
    instance.destroy();
    instance = undefined;
    const recoveryTimersAfterDestroy = activeTimerCount(destroyRecoveryIds);

    return {
      runtimeRafCallbacks: during.runtimeRafCallbacks,
      runtimeTimerCallbacks: during.runtimeTimerCallbacks,
      runtimeTimerSchedules: during.runtimeTimerSchedules,
      activeRuntimeTimersDuring,
      activeRuntimeTimersAfterShow,
      recoveryTimersDuring,
      recoveryTimersAfterShow,
      recoveryTimersAfterExpiry,
      recoveryTimersAfterDestroy,
      recoveryTimerDelayMs,
      expiryAdvanced,
      hiddenAfterExpiry,
      storageDenied: true,
      runtimeTaskDurationsMs: during.runtimeTaskDurationsMs,
    };
  } finally {
    instance?.destroy();
    window.Peekling.visibility.show();
    storage.restore();
  }
}

async function measureCleanup(index) {
  const instance = window.Peekling.hatch(options("warm", `cleanup-${index}`));
  await instance.ready;
  dispatchPointer(700, 300);
  await frames(2);
  instance.destroy();
  const mark = snapshot(true);
  dispatchPointer(100, 100);
  window.dispatchEvent(new Event("scroll"));
  await frames(2);
  await sleep(20);
  const delta = measurement(mark);
  return {
    ownedRoots: document.querySelectorAll(
      "[data-peekling-host],[data-peekling-content],[data-peekling-controls]",
    ).length,
    activeRuntimeRaf: telemetry.activeRaf.size,
    activeRuntimeTimers: telemetry.activeTimers.size,
    activeObjectUrls: telemetry.objectUrls.size,
    postDestroyScheduledWork:
      delta.runtimeRafCallbacks +
      delta.runtimeTimerCallbacks +
      delta.runtimeTimerSchedules,
    resourceRequestsAfterDestroy: resourcesSince(mark.resources).length,
    runtimeTaskDurationsMs: delta.runtimeTaskDurationsMs,
  };
}

function options(cacheProfile, sampleId) {
  const cache = cacheProfile === "warm" ? "warm" : "no-store";
  const suffix = cache === "warm" ? "shared" : sampleId;
  return {
    pack: {
      name: "performance-fixture",
      displayName: "Performance fixture",
      version: "0.1.0",
      license: "CC0-1.0",
      atlas: {
        src: "atlas.png",
        sha256:
          "4addc1cb8c5628c4b03381e6a35b8e0ae63b1f12f3fa27ad5cdba0205843cc68",
        columns: 2,
        rows: 1,
        cellWidth: 1,
        cellHeight: 1,
      },
      states: {
        idle: { frames: [0, 1], durations: [80, 80], loop: true },
        move: { frames: [0, 1], durations: [80, 80], loop: true },
      },
      directionalStates: {
        N: "move",
        NE: "move",
        E: "move",
        SE: "move",
        S: "move",
        SW: "move",
        W: "move",
        NW: "move",
      },
      defaultScale: 1,
    },
    atlasUrl: `/atlas.png?cache=${cache}&sample=${suffix}`,
    styles: {
      url: `/peekling.css?cache=${cache}&sample=${suffix}`,
    },
    position: "center",
    diagnostics: { console: false },
  };
}

function snapshot(resetMaximum = false) {
  if (resetMaximum) telemetry.maximumPendingRaf = telemetry.activeRaf.size;
  return {
    rafCallbacks: telemetry.rafCallbacks.length,
    timerCallbacks: telemetry.timerCallbacks,
    timerSchedules: telemetry.timerSchedules,
    maximumPendingRaf: telemetry.maximumPendingRaf,
    resources: performance.getEntriesByType("resource").length,
  };
}

function measurement(mark) {
  return {
    runtimeRafCallbacks: telemetry.rafCallbacks.length - mark.rafCallbacks,
    runtimeTimerCallbacks: telemetry.timerCallbacks - mark.timerCallbacks,
    runtimeTimerSchedules: telemetry.timerSchedules - mark.timerSchedules,
    runtimeTaskDurationsMs: telemetry.rafCallbacks
      .slice(mark.rafCallbacks)
      .map(({ duration }) => duration),
    maximumPendingRuntimeRaf: telemetry.maximumPendingRaf,
  };
}

function activeTimerIds() {
  return new Set(telemetry.activeTimers.keys());
}

function addedTimerIds(previous) {
  return [...telemetry.activeTimers.keys()].filter((id) => !previous.has(id));
}

function activeTimerCount(ids) {
  return ids.filter((id) => telemetry.activeTimers.has(id)).length;
}

function fireTimer(id) {
  const record = telemetry.activeTimers.get(id);
  if (!record) return false;
  telemetry.activeTimers.delete(id);
  nativeClearTimeout(id);
  telemetry.timerCallbacks += 1;
  if (typeof record.callback === "function") {
    record.callback(...record.args);
  }
  return true;
}

function denyStorage() {
  const descriptors = new Map();
  for (const method of ["getItem", "setItem", "removeItem"]) {
    descriptors.set(
      method,
      Object.getOwnPropertyDescriptor(Storage.prototype, method),
    );
    Object.defineProperty(Storage.prototype, method, {
      configurable: true,
      value() {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    });
  }
  return {
    restore() {
      for (const [method, descriptor] of descriptors) {
        if (descriptor)
          Object.defineProperty(Storage.prototype, method, descriptor);
      }
    },
  };
}

function resourceMeasurement(start) {
  const resources = resourcesSince(start);
  return {
    requestCount: resources.length,
    transferBytes: sum(resources, "transferSize"),
    encodedBodyBytes: sum(resources, "encodedBodySize"),
    resourceNames: resources.map(({ name }) => new URL(name).pathname),
  };
}

function resourcesSince(index) {
  return performance
    .getEntriesByType("resource")
    .slice(index)
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      duration: entry.duration,
    }));
}

function scenario(cacheProfile, warmupCount, rawSamples) {
  return { cacheProfile, warmupCount, rawSamples };
}

function sum(entries, field) {
  return entries.reduce((total, entry) => total + (entry[field] || 0), 0);
}

function dispatchPointer(x, y) {
  document.dispatchEvent(
    new PointerEvent("pointermove", {
      clientX: x,
      clientY: y,
      pointerType: "mouse",
      bubbles: true,
    }),
  );
}

async function waitForRuntime() {
  const startedAt = performance.now();
  while (!window.Peekling?.hatch) {
    if (performance.now() - startedAt > 2_000) {
      throw new Error("Shipped Peekling browser artifact did not load");
    }
    await sleep(5);
  }
}

async function waitForRuntimeFrame(index) {
  const startedAt = performance.now();
  while (telemetry.rafCallbacks.length <= index) {
    if (performance.now() - startedAt > 2_000) {
      throw new Error("Peekling did not produce an eligible runtime frame");
    }
    await nextNativeFrame();
  }
  return telemetry.rafCallbacks[index];
}

function nextNativeFrame() {
  return new Promise((resolve) =>
    nativeRaf(() => {
      nativeFrameWitnesses += 1;
      resolve(performance.now());
    }),
  );
}

async function frames(count) {
  for (let index = 0; index < count; index += 1) await nextNativeFrame();
}

function sleep(milliseconds) {
  return new Promise((resolve) => nativeSetTimeout(resolve, milliseconds));
}
