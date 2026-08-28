import { expect, test } from "@playwright/test";

import { startPerformanceServer } from "../../scripts/browser-performance-runner.mjs";

let server;

test.beforeAll(async () => {
  server = await startPerformanceServer();
});

test.afterAll(async () => {
  await server.close();
});

test("the release fixture measures every scenario through the shipped strict-CSP artifact", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${server.origin}/?cache=no-store`);
  await page.waitForFunction(() => Boolean(window.__peeklingPerformance));
  const result = await page.evaluate(() =>
    window.__peeklingPerformance.run({
      startupRepetitions: 2,
      warmupCount: 1,
      steadyFrameCount: 12,
      eventBurstRepetitions: 3,
      lifecycleRepetitions: 2,
    }),
  );

  expect(Object.keys(result.scenarios)).toEqual([
    "cold-hatch",
    "warm-hatch",
    "steady-motion",
    "event-burst",
    "parked",
    "timed-recovery",
    "resume",
    "cleanup",
  ]);
  expect(result.scenarios["cold-hatch"].rawSamples).toHaveLength(2);
  expect(result.scenarios["warm-hatch"].rawSamples).toHaveLength(2);
  expect(result.scenarios["event-burst"].rawSamples).toHaveLength(3);
  expect(result.scenarios.cleanup.rawSamples).toHaveLength(2);
  for (const name of ["cold-hatch", "warm-hatch"]) {
    for (const sample of result.scenarios[name].rawSamples) {
      expect(sample.hatchToVisualFrameMs).toBeGreaterThanOrEqual(0);
      expect(sample.readyToVisualFrameMs).toBeGreaterThanOrEqual(0);
      expect(sample.eligibleVisual).toBe(true);
      expect(sample.nativeFramesAfterReady).toBe(1);
      expect(sample.readyToNextNativeFrameMs).toBe(sample.readyToVisualFrameMs);
      expect(sample.visualMilestone).toBe("native-animation-frame-after-ready");
    }
  }
  expect(
    result.scenarios.resume.rawSamples[0].hatchToVisualFrameMs,
  ).toBeGreaterThanOrEqual(0);
  expect(result.scenarios["cold-hatch"].rawSamples[0].resourceNames).toEqual(
    expect.arrayContaining(["/atlas.png", "/peekling.css"]),
  );
  expect(result.instrumentation).toEqual({
    rafWrapped: true,
    timersWrapped: true,
    objectUrlsWrapped: true,
    harnessUsesNativeClock: true,
  });
  expect(result.cspViolations).toEqual([]);
  expect(result.unhandledRejections).toEqual([]);
  expect(result.scenarios["timed-recovery"].rawSamples[0]).toMatchObject({
    recoveryTimersDuring: 1,
    recoveryTimersAfterShow: 0,
    recoveryTimersAfterExpiry: 0,
    recoveryTimersAfterDestroy: 0,
    hiddenAfterExpiry: false,
    storageDenied: true,
  });
  expect(pageErrors).toEqual([]);
});
