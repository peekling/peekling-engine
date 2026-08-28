import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const fixtureRoot = path.resolve("test/browser/fixtures");
const fixtureHtml = await readFile(
  path.join(fixtureRoot, "adversarial-host.html"),
  "utf8",
);
const fixtureCss = await readFile(
  path.join(fixtureRoot, "adversarial-host.css"),
  "utf8",
);
const fixtureScriptTemplate = await readFile(
  path.join(fixtureRoot, "adversarial-host.js"),
  "utf8",
);
const bundle = await readFile(
  path.resolve("packages/runtime/dist/peekling.min.js"),
  "utf8",
);
const runtimeCss = await readFile(
  path.resolve("packages/runtime/dist/peekling.css"),
  "utf8",
);
const atlas = PNG.sync.write(new PNG({ width: 2, height: 1 }));
const fixtureScript = fixtureScriptTemplate.replace(
  "__PEEKLING_FIXTURE_ATLAS_SHA256__",
  createHash("sha256").update(atlas).digest("hex"),
);
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

test.beforeEach(async ({ page }) => {
  await page.route("https://hostile.peekling.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const headers = { "content-security-policy": csp };
    if (pathname === "/adversarial-host.html" || pathname === "/") {
      await route.fulfill({
        body: fixtureHtml,
        contentType: "text/html",
        headers,
      });
      return;
    }
    if (pathname === "/frame-shell.html") {
      await route.fulfill({
        body: '<!doctype html><iframe title="host frame" src="/adversarial-host.html"></iframe>',
        contentType: "text/html",
        headers,
      });
      return;
    }
    const resources = {
      "/hostile-host.css": [fixtureCss, "text/css"],
      "/hostile-host.js": [fixtureScript, "text/javascript"],
      "/runtime.js": [bundle, "text/javascript"],
      "/peekling.css": [runtimeCss, "text/css"],
      "/atlas.png": [atlas, "image/png"],
    };
    const resource = resources[pathname];
    if (!resource) {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    await route.fulfill({ body: resource[0], contentType: resource[1] });
  });
});

test("closed roots retain critical layout under hostile page CSS", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);

  const result = await page.evaluate(() => {
    const character = document.querySelector("[data-peekling-host]");
    const content = document.querySelector("[data-peekling-content]");
    const controls = document.querySelector("[data-peekling-controls]");
    const inspect = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        display: style.display,
        position: style.position,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        animationName: style.animationName,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      };
    };
    return {
      character: inspect(character),
      content: inspect(content),
      controls: inspect(controls),
      viewport: { width: innerWidth, height: innerHeight },
      hostButtonText: document.querySelector("#host-button").textContent,
    };
  });

  expect(result.character).toMatchObject({
    display: "block",
    position: "fixed",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "none",
    animationName: "none",
  });
  expect(result.content).toMatchObject({
    display: "block",
    position: "fixed",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "none",
    animationName: "none",
  });
  expect(result.controls).toMatchObject({
    display: "block",
    position: "fixed",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "none",
    animationName: "none",
  });
  for (const root of [result.character, result.content, result.controls]) {
    expect(root.rect).toEqual({ left: 0, top: 0, ...result.viewport });
  }
  expect(result.hostButtonText).toBe("Host control");
  expect(failures).toEqual([]);
});

test("owned roots recover on the next runtime turn after external deletion", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  const before = await page.evaluate(() => window.hostileHarness.snapshot());

  expect(
    await page.evaluate(() => window.hostileHarness.removeOwnedRoots()),
  ).toEqual({
    removed: { characters: 2, contentHosts: 1, controls: 1 },
    remaining: 0,
  });
  await page.evaluate(() => window.hostileHarness.storm(20));

  await expect(page.locator("[data-peekling-host]")).toHaveCount(2);
  await expect(page.locator("[data-peekling-content]")).toHaveCount(1);
  await expect(page.locator("[data-peekling-controls]")).toHaveCount(0);
  await page.evaluate(() => window.Peekling.visibility.show());
  await expect(page.locator("[data-peekling-controls]")).toHaveCount(1);
  const after = await page.evaluate(() => window.hostileHarness.snapshot());
  expect(after.objectUrls).toBe(before.objectUrls);
  expect(after.mountState.goodCleanups).toBe(before.mountState.goodCleanups);
  expect(after.characters).toBe(2);
  expect(failures).toEqual([]);
});

test("owned roots recover direct document ownership and required markers without polling", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  const before = await page.evaluate(() => window.hostileHarness.snapshot());
  expect(
    await page.evaluate(() =>
      window.hostileHarness.reparentAndStripOwnedRoots(),
    ),
  ).toBe(4);

  await page.evaluate(() => window.hostileHarness.storm(20));
  await expect(page.locator("[data-peekling-host]")).toHaveCount(2);
  await expect(page.locator("[data-peekling-content]")).toHaveCount(1);
  await page.evaluate(() => window.Peekling.visibility.show());
  await expect(page.locator("[data-peekling-controls]")).toHaveCount(1);
  const repaired = await page.evaluate(() => ({
    characters: [...document.querySelectorAll("[data-peekling-host]")].map(
      (root) => ({
        direct: root.parentNode === document.documentElement,
        hidden: root.getAttribute("aria-hidden"),
      }),
    ),
    content: [...document.querySelectorAll("[data-peekling-content]")].map(
      (root) => ({
        direct: root.parentNode === document.documentElement,
        label: root.getAttribute("aria-label"),
      }),
    ),
    controls: [...document.querySelectorAll("[data-peekling-controls]")].map(
      (root) => root.parentNode === document.documentElement,
    ),
    snapshot: window.hostileHarness.snapshot(),
  }));
  expect(repaired.characters).toEqual([
    { direct: true, hidden: "true" },
    { direct: true, hidden: "true" },
  ]);
  expect(repaired.content).toEqual([
    { direct: true, label: "Peekling content" },
  ]);
  expect(repaired.controls).toEqual([true]);
  expect(repaired.snapshot.mutations).toBe(before.mutations);
  expect(failures).toEqual([]);
});

test("a core frame failure diagnoses once and terminally cleans only that instance", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  const before = await page.evaluate(() => window.hostileHarness.snapshot());
  await page.evaluate(() => {
    window.hostileHarness.breakPrimaryFrame();
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 300,
        clientY: 200,
        pointerType: "mouse",
      }),
    );
  });

  await expect(page.locator("[data-peekling-host]")).toHaveCount(1);
  await expect(page.locator("[data-peekling-content]")).toHaveCount(0);
  const after = await page.evaluate(() => window.hostileHarness.snapshot());
  expect(after.objectUrls).toBe(before.objectUrls - 1);
  expect(
    after.diagnostics.filter(
      (diagnostic) => diagnostic.code === "internal.frame-failed",
    ),
  ).toHaveLength(1);
  expect(
    after.diagnostics.filter(
      (diagnostic) => diagnostic.code === "lifecycle.destroyed",
    ),
  ).toHaveLength(1);
  await page.mouse.move(450, 250);
  await expect(page.locator("[data-peekling-host]")).toHaveCount(1);
  expect(failures).toEqual([]);
});

test("critical closed-root damage terminally cleans the affected instance", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    window.capturedPeeklingRoots = [];
    Element.prototype.attachShadow = function (options) {
      const root = nativeAttachShadow.call(this, options);
      if (this.hasAttribute("data-peekling-host"))
        window.capturedPeeklingRoots.push(root);
      return root;
    };
  });
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  expect(await page.evaluate(() => window.capturedPeeklingRoots.length)).toBe(
    2,
  );
  await page.evaluate(() => {
    const primaryRoot = window.capturedPeeklingRoots.sort(
      (left, right) =>
        Number(left.host.dataset.peeklingX) -
        Number(right.host.dataset.peeklingX),
    )[0];
    primaryRoot.replaceChildren();
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 325,
        clientY: 225,
        pointerType: "mouse",
      }),
    );
  });

  await expect(page.locator("[data-peekling-host]")).toHaveCount(1);
  const diagnostics = await page.evaluate(
    () => window.hostileHarness.snapshot().diagnostics,
  );
  expect(
    diagnostics.filter(
      (diagnostic) => diagnostic.code === "internal.frame-failed",
    ),
  ).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("adoption into another document terminally cleans the affected instance", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  const before = await page.evaluate(() => window.hostileHarness.snapshot());
  expect(
    await page.evaluate(() => window.hostileHarness.adoptPrimaryContentRoot()),
  ).toBe(true);
  await page.evaluate(() => window.hostileHarness.storm(20));

  await expect(page.locator("[data-peekling-host]")).toHaveCount(1);
  await expect(page.locator("[data-peekling-content]")).toHaveCount(0);
  const after = await page.evaluate(() => window.hostileHarness.snapshot());
  expect(after.objectUrls).toBe(before.objectUrls - 1);
  expect(
    after.diagnostics.filter(
      (diagnostic) => diagnostic.code === "internal.frame-failed",
    ),
  ).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("adopting the shared visibility root terminally cleans its registered instances", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  expect(
    await page.evaluate(() => window.hostileHarness.adoptVisibilityRoot()),
  ).toBe(true);
  await page.evaluate(() => window.Peekling.visibility.show());

  await expect(page.locator("[data-peekling-host]")).toHaveCount(0);
  await expect(page.locator("[data-peekling-content]")).toHaveCount(0);
  const after = await page.evaluate(() => window.hostileHarness.snapshot());
  expect(after.objectUrls).toBe(0);
  expect(
    after.diagnostics.filter(
      (diagnostic) => diagnostic.code === "internal.frame-failed",
    ),
  ).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("host errors and bad mounts do not stop other surfaces or instances", async ({
  page,
}) => {
  const hostErrors = [];
  const failures = collectUnexpectedFailures(page, (error) => {
    if (error.message === "expected host fixture error") {
      hostErrors.push(error.message);
      return true;
    }
    return false;
  });
  await loadFixture(page);
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("expected host fixture error");
    });
  });
  await page.evaluate(() => window.hostileHarness.storm(500));
  const beforePositions = await page.evaluate(() =>
    [...document.querySelectorAll("[data-peekling-host]")].map(
      (host) => host.dataset.peeklingX,
    ),
  );
  await page.mouse.move(100, 100);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-peekling-host]")].map(
          (host) => host.dataset.peeklingX,
        ),
      ),
    )
    .not.toEqual(beforePositions);

  await expect(page.locator("[data-peekling-host]")).toHaveCount(2);
  await expect(page.locator("[data-peekling-content]")).toHaveCount(1);
  const result = await page.evaluate(() => ({
    positions: [...document.querySelectorAll("[data-peekling-host]")].map(
      (host) => host.dataset.peeklingX,
    ),
    snapshot: window.hostileHarness.snapshot(),
  }));
  expect(result.positions).not.toEqual(beforePositions);
  expect(result.snapshot.diagnostics).toContainEqual({
    code: "render.host-failed",
    severity: "error",
  });
  expect(result.snapshot.mountState.goodCleanups).toBe(0);
  expect(hostErrors).toEqual(["expected host fixture error"]);
  expect(failures).toEqual([]);
});

test("host controller accessors and proxy reflection faults stay per-surface", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  const beforePositions = await page.evaluate(() =>
    [...document.querySelectorAll("[data-peekling-host]")].map(
      (host) => host.dataset.peeklingX,
    ),
  );
  await page.mouse.move(225, 175);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-peekling-host]")].map(
          (host) => host.dataset.peeklingX,
        ),
      ),
    )
    .not.toEqual(beforePositions);
  const result = await page.evaluate(() => window.hostileHarness.snapshot());
  expect(result.mountState.controllerAccessorReads).toBe(0);
  expect(result.mountState.controllerProxyReflections).toBe(1);
  expect(
    result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "render.host-failed",
    ).length,
  ).toBeGreaterThanOrEqual(3);
  expect(result.characters).toBe(2);
  expect(result.contentHosts).toBe(1);
  expect(failures).toEqual([]);
});

test("repeated suspension and instance teardown return to the same resource baseline", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await loadFixture(page);
  const result = await page.evaluate(() => window.hostileHarness.cycle(20));

  expect(result.after).toMatchObject({
    listeners: result.before.listeners,
    pointerListeners: result.before.pointerListeners,
    intersections: result.before.intersections,
    mutations: result.before.mutations,
    objectUrls: result.before.objectUrls,
    characters: result.before.characters,
    contentHosts: result.before.contentHosts,
    controls: result.before.controls,
  });
  expect(result.after.frames).toBeLessThanOrEqual(result.before.frames);
  expect(result.after.timers).toBeLessThanOrEqual(result.before.timers);

  const destroyed = await page.evaluate(() => {
    window.hostileHarness.destroy();
    return window.hostileHarness.snapshot();
  });
  expect(destroyed).toMatchObject({
    intersections: result.after.intersections - 1,
    mutations: result.after.mutations - 1,
    frames: 0,
    timers: 0,
    objectUrls: 0,
    characters: 0,
    contentHosts: 0,
    controls: 0,
    mountState: {
      goodCleanups: result.after.mountState.goodCleanups + 1,
      pendingAborted: true,
    },
  });
  expect(failures).toEqual([]);
});

test("iframe and top-layer behavior stays within the browser boundary", async ({
  page,
}) => {
  const failures = collectUnexpectedFailures(page);
  await page.goto("https://hostile.peekling.test/frame-shell.html");
  const frame = page.frame({ url: /adversarial-host\.html/ });
  await frame.waitForFunction(() => window.hostileHarness !== undefined);
  await frame.evaluate(() => window.hostileHarness.ready);

  expect(await page.locator("[data-peekling-host]").count()).toBe(0);
  await expect(frame.locator("[data-peekling-host]")).toHaveCount(2);
  await frame.evaluate(() => window.hostileHarness.openDialog());
  await expect(frame.locator("#host-dialog")).toHaveAttribute("open", "");
  await frame.evaluate(() => window.hostileHarness.storm(50));
  await expect(frame.locator("[data-peekling-host]")).toHaveCount(2);
  await frame.evaluate(() => window.hostileHarness.closeDialog());
  await expect(frame.locator("#host-dialog")).not.toHaveAttribute("open", "");
  expect(failures).toEqual([]);
});

async function loadFixture(page) {
  await page.goto("https://hostile.peekling.test/adversarial-host.html");
  await page.waitForFunction(() => window.hostileHarness !== undefined);
  await page.evaluate(() => window.hostileHarness.ready);
}

function collectUnexpectedFailures(page, allowPageError) {
  const failures = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    if (!allowPageError?.(error)) failures.push(`page: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    failures.push(
      `request: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  return failures;
}
