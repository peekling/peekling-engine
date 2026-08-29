import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import {
  invalidSerializableConfigurationCases,
  invalidSerializableUrlCases,
  invalidSurfaceColorCases,
} from "../fixtures/configuration-parity.mjs";

const bundle = path.resolve("packages/runtime/dist/peekling.min.js");
const bundleSource = await readFile(bundle, "utf8");
const runtimeCss = await readFile(
  path.resolve("packages/runtime/dist/peekling.css"),
  "utf8",
).catch(() => "");
const runtimeCssIntegrity = (
  await readFile(path.resolve("packages/runtime/dist/peekling.css.sri"), "utf8")
).trim();
const transparentPng = PNG.sync.write(new PNG({ width: 2, height: 1 }));
const transparentPngSha256 = createHash("sha256")
  .update(transparentPng)
  .digest("hex");
const cspHatchPng = PNG.sync.write(new PNG({ width: 512, height: 32 }));
const cspPng = PNG.sync.write(new PNG({ width: 512, height: 64 }));
const cspHatchPngSha256 = createHash("sha256")
  .update(cspHatchPng)
  .digest("hex");
const cspPngSha256 = createHash("sha256").update(cspPng).digest("hex");
const peekRoot = process.env.PEEKLING_PEEK_ROOT;
const statusPlan = {
  baseline: {
    channels: ["state", "surface:status"],
    state: { state: "idle" },
    surfaces: [{ id: "status", contentId: "status" }],
  },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (hashes) => {
      window.__peeklingFixtureHashes = hashes;
    },
    {
      transparent: transparentPngSha256,
      cspHatch: cspHatchPngSha256,
      csp: cspPngSha256,
    },
  );
  await page.route("**/peekling.css", (route) =>
    route.fulfill({ body: runtimeCss, contentType: "text/css" }),
  );
});

test("browser hatch rejects the shared malformed configuration corpus", async ({
  page,
}) => {
  await page.route("https://configuration.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.goto("https://configuration.peekling.test/");
  await page.addScriptTag({ content: bundleSource });
  const outcomes = await page.evaluate((cases) => {
    return cases.map(({ name, configuration }) => {
      try {
        window.Peekling.hatch(configuration);
        return { name, outcome: "accepted" };
      } catch (error) {
        return { name, outcome: error.name };
      }
    });
  }, invalidSerializableConfigurationCases);

  expect(outcomes).toEqual(
    invalidSerializableConfigurationCases.map(({ name }) => ({
      name,
      outcome: "PeeklingPreflightError",
    })),
  );
});

test("browser hatch and Web Component reject absolute HTTP on an HTTP host", async ({
  page,
}) => {
  await page.route("http://site.example/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.goto("http://site.example/");
  await page.addScriptTag({ content: bundleSource });

  const result = await page.evaluate(async () => {
    let hatch = "resolved";
    try {
      window.Peekling.hatch({
        packUrl: "http://site.example/character.json",
      });
    } catch (error) {
      hatch = error.name;
    }

    const element = document.createElement("peekling-character");
    element.setAttribute("pack-url", "http://site.example/character.json");
    document.body.append(element);
    let component = "resolved";
    try {
      await element.ready;
    } catch (error) {
      component = error.name;
    }
    element.remove();
    return {
      hatch,
      component,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  });

  expect(result).toEqual({
    hatch: "PeeklingPreflightError",
    component: "PeeklingPreflightError",
    roots: 0,
  });
});

test("strict CSP theme rejection cannot create resource requests", async ({
  page,
}) => {
  let probeRequests = 0;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("https://theme-security.peekling.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self' https://theme-probe.test; connect-src 'self' https://theme-probe.test; object-src 'none'; base-uri 'none'">
<script src="/peekling.min.js"></script>`,
    }),
  );
  await page.route(
    "https://theme-security.peekling.test/peekling.min.js",
    (route) =>
      route.fulfill({ body: bundleSource, contentType: "text/javascript" }),
  );
  await page.route("https://theme-probe.test/**", (route) => {
    probeRequests += 1;
    return route.fulfill({ body: transparentPng, contentType: "image/png" });
  });
  await page.goto("https://theme-security.peekling.test/");

  const result = await page.evaluate(async (values) => {
    const violations = [];
    const unhandled = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(event.violatedDirective),
    );
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const direct = [];
    const component = [];
    for (const value of values) {
      try {
        window.Peekling.hatch({
          character: "peek",
          theme: { background: value },
        });
        direct.push("resolved");
      } catch (error) {
        direct.push(error.name);
      }
      const element = document.createElement("peekling-character");
      element.options = {
        character: "peek",
        theme: { background: value },
      };
      document.body.append(element);
      try {
        await element.ready;
        component.push("resolved");
      } catch (error) {
        component.push(error.name);
      }
      element.remove();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      direct,
      component,
      violations,
      unhandled,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  }, invalidSurfaceColorCases);

  expect(result).toEqual({
    direct: invalidSurfaceColorCases.map(() => "PeeklingPreflightError"),
    component: invalidSurfaceColorCases.map(() => "PeeklingPreflightError"),
    violations: [],
    unhandled: [],
    roots: 0,
  });
  expect(probeRequests).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("browser hatch and Web Component reject the shared semantic URL corpus", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page);
  const result = await page.evaluate(async (cases) => {
    const original = document.querySelector("peekling-character");
    original.remove();
    await Promise.resolve();
    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const hatch = [];
    const component = [];
    const configurations = (value) => [
      { packUrl: value },
      { character: "peek", atlasUrl: value },
      { character: "peek", styles: { url: value } },
      {
        character: "peek",
        content: {
          status: {
            bottom: { link: { label: "Details", href: value } },
          },
        },
      },
    ];
    for (const { value } of cases) {
      for (const options of configurations(value)) {
        try {
          window.Peekling.hatch(options);
          hatch.push("resolved");
        } catch (error) {
          hatch.push(error.name);
        }
        const element = document.createElement("peekling-character");
        element.options = options;
        document.body.append(element);
        try {
          await element.ready;
          component.push("resolved");
        } catch (error) {
          component.push(error.name);
        }
        element.remove();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      hatch,
      component,
      unhandled,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  }, invalidSerializableUrlCases);

  const expected = invalidSerializableUrlCases.flatMap(() =>
    Array.from({ length: 4 }, () => "PeeklingPreflightError"),
  );
  expect(result).toEqual({
    hatch: expected,
    component: expected,
    unhandled: [],
    roots: 0,
  });
  expect(pageErrors).toEqual([]);
});

test("browser hatch and Web Component load relative and absolute HTTPS resources", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("https://url-policy.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  for (const url of [
    "https://url-policy.peekling.test/url-atlas.png",
    "https://url-assets.peekling.test/url-atlas.png",
  ]) {
    await page.route(url, (route) =>
      route.fulfill({
        body: transparentPng,
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
      }),
    );
  }
  for (const url of [
    "https://url-policy.peekling.test/peekling.css",
    "https://url-assets.peekling.test/peekling.css",
  ]) {
    await page.route(url, (route) =>
      route.fulfill({
        body: runtimeCss,
        contentType: "text/css",
        headers: { "access-control-allow-origin": "*" },
      }),
    );
  }
  await page.goto("https://url-policy.peekling.test/");
  await page.addScriptTag({ content: bundleSource });

  const result = await page.evaluate(async () => {
    const pack = {
      name: "url-policy-fixture",
      displayName: "URL policy fixture",
      version: "0.1.0",
      license: "CC0-1.0",
      atlas: {
        src: "url-atlas.png",
        sha256: window.__peeklingFixtureHashes.transparent,
        columns: 2,
        rows: 1,
        cellWidth: 1,
        cellHeight: 1,
      },
      states: { idle: { frames: [0], fps: 1, loop: true } },
      defaultScale: 1,
    };
    const plan = {
      baseline: {
        channels: ["state", "surface:status"],
        state: { state: "idle" },
        surfaces: [{ id: "status", contentId: "status" }],
      },
    };
    const variants = [
      {
        atlasUrl: "/url-atlas.png",
        styles: { url: "/peekling.css" },
        href: "#details",
      },
      {
        atlasUrl: "https://url-assets.peekling.test/url-atlas.png",
        styles: { url: "https://url-assets.peekling.test/peekling.css" },
        href: "https://url-assets.peekling.test/details",
      },
    ];
    const outcomes = [];
    for (const variant of variants) {
      const options = {
        pack,
        atlasUrl: variant.atlasUrl,
        styles: variant.styles,
        plan,
        content: {
          status: {
            bottom: { link: { label: "Details", href: variant.href } },
          },
        },
        diagnostics: { console: false },
      };
      const direct = window.Peekling.hatch(options);
      await direct.ready;
      outcomes.push("hatch-ready");
      direct.destroy();

      const element = document.createElement("peekling-character");
      element.options = options;
      document.body.append(element);
      await element.ready;
      outcomes.push("component-ready");
      element.remove();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      outcomes,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  });

  expect(result).toEqual({
    outcomes: [
      "hatch-ready",
      "component-ready",
      "hatch-ready",
      "component-ready",
    ],
    roots: 0,
  });
  expect(pageErrors).toEqual([]);
});

async function loadBrowserCollisionFixture(page, setup = "") {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("https://collision.peekling.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self'; object-src 'none'; base-uri 'none'">
<script src="/observer.js"></script>
<script src="/peekling.min.js"></script>
<script src="/after.js"></script>`,
    }),
  );
  await page.route("https://collision.peekling.test/observer.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.collisions=[];window.unhandled=[];window.cspViolations=[];addEventListener("peekling:collision",event=>window.collisions.push(event.detail));addEventListener("unhandledrejection",event=>{window.unhandled.push(String(event.reason));event.preventDefault()});document.addEventListener("securitypolicyviolation",event=>window.cspViolations.push(event.violatedDirective));${setup}`,
    }),
  );
  await page.route("https://collision.peekling.test/peekling.min.js", (route) =>
    route.fulfill({ body: bundleSource, contentType: "text/javascript" }),
  );
  await page.route("https://collision.peekling.test/after.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.collisionResult={collisions:window.collisions,unhandled:window.unhandled,cspViolations:window.cspViolations,globalSame:window.hostPeekling?window.Peekling===window.hostPeekling:null,globalHatch:typeof window.Peekling?.hatch,element:customElements.get("peekling-character"),elementSame:window.hostElement?customElements.get("peekling-character")===window.hostElement:null};`,
    }),
  );
  await page.goto("https://collision.peekling.test/");
  await page.waitForFunction(() => Boolean(window.collisionResult));
  const result = await page.evaluate(() => ({
    ...window.collisionResult,
    element: Boolean(window.collisionResult.element),
  }));
  return { result, pageErrors };
}

async function mount(page, plan = statusPlan, beforeBundle) {
  await page.route("https://assets.peekling.test/atlas.png", (route) =>
    route.fulfill({
      body: transparentPng,
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.route("https://app.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.goto("https://app.peekling.test/");
  await beforeBundle?.(page);
  await page.addScriptTag({ content: bundleSource });
  return page.evaluate(
    async ({ plan, atlasSha256 }) => {
      const element = document.createElement("peekling-character");
      element.options = {
        format: 1,
        pack: {
          name: "browser-fixture",
          displayName: "Browser fixture",
          version: "0.1.0",
          license: "CC0-1.0",
          atlas: {
            src: "atlas.png",
            sha256: atlasSha256,
            columns: 2,
            rows: 1,
            cellWidth: 1,
            cellHeight: 1,
          },
          states: {
            idle: { frames: [0, 1], durations: [80, 80], loop: true },
            move: { frames: [0, 1], durations: [80, 80], loop: true },
            happy: { frames: [0, 1], durations: [60, 60], loop: false },
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
        atlasUrl: "https://assets.peekling.test/atlas.png",
        ...(plan === null ? {} : { plan }),
        content: {
          status: { "top-center": "Ready" },
          "job-progress": { "top-center": "Working" },
        },
        diagnostics: { console: false },
        logger: (record) => {
          (window.peeklingDiagnostics ??= []).push(record);
        },
      };
      document.body.append(element);
      await element.ready;
      const instance = element.instance;
      return {
        api: typeof window.Peekling?.hatch,
        apiKeys: Object.keys(window.Peekling).sort(),
        apiFrozen: Object.isFrozen(window.Peekling),
        publicConstructor: typeof window.Peekling.Peekling,
        tag: Boolean(customElements.get("peekling-character")),
        invalidEvent: element.emit("Not valid"),
        invalidEventType: element.emit(["app.saved"]),
        instanceMethods: {
          emit: typeof instance.emit,
          override: typeof instance.override,
          pause: typeof instance.pause,
          resume: typeof instance.resume,
          destroy: typeof instance.destroy,
          request: typeof instance.request,
          play: typeof instance.play,
          react: typeof instance.react,
          availableStates: typeof instance.availableStates,
        },
      };
    },
    { plan, atlasSha256: transparentPngSha256 },
  );
}

async function runDestroyReentrancyCase(page, mode) {
  await page.route("https://reentrant.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.route("https://reentrant.peekling.test/atlas.png", (route) =>
    route.fulfill({
      body: transparentPng,
      contentType: "image/png",
    }),
  );
  await page.goto("https://reentrant.peekling.test/");
  await page.evaluate(() => {
    const listeners = [];
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      if ((this === document || this === window) && listener) {
        listeners.push({ target: this, type, listener });
      }
      return nativeAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      listener,
      options,
    ) {
      const index = listeners.findIndex(
        (entry) =>
          entry.target === this &&
          entry.type === type &&
          entry.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
      return nativeRemove.call(this, type, listener, options);
    };

    const NativeIntersectionObserver = window.IntersectionObserver;
    const NativeMutationObserver = window.MutationObserver;
    let intersections = 0;
    let mutations = 0;
    window.IntersectionObserver = class {
      #active = false;
      #inner;
      constructor(callback, options) {
        this.#inner = new NativeIntersectionObserver(callback, options);
      }
      observe(target) {
        if (!this.#active) intersections += 1;
        this.#active = true;
        this.#inner.observe(target);
      }
      unobserve(target) {
        this.#inner.unobserve(target);
      }
      disconnect() {
        if (this.#active) intersections -= 1;
        this.#active = false;
        this.#inner.disconnect();
      }
      takeRecords() {
        return this.#inner.takeRecords();
      }
    };
    window.MutationObserver = class {
      #active = false;
      #inner;
      constructor(callback) {
        this.#inner = new NativeMutationObserver(callback);
      }
      observe(target, options) {
        if (!this.#active) mutations += 1;
        this.#active = true;
        this.#inner.observe(target, options);
      }
      disconnect() {
        if (this.#active) mutations -= 1;
        this.#active = false;
        this.#inner.disconnect();
      }
      takeRecords() {
        return this.#inner.takeRecords();
      }
    };

    const nativeRaf = window.requestAnimationFrame.bind(window);
    const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
    const frames = new Set();
    let postDestroyFrames = 0;
    window.requestAnimationFrame = (callback) => {
      if (window.reentrancyDestroyed) postDestroyFrames += 1;
      let id = 0;
      id = nativeRaf((time) => {
        frames.delete(id);
        callback(time);
      });
      frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      frames.delete(id);
      nativeCancelRaf(id);
    };

    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const timers = new Set();
    let postDestroyTimers = 0;
    window.setTimeout = (callback, delay, ...args) => {
      if (window.reentrancyDestroyed) postDestroyTimers += 1;
      let id = 0;
      id = nativeSetTimeout(() => {
        timers.delete(id);
        callback(...args);
      }, delay);
      timers.add(id);
      return id;
    };
    window.clearTimeout = (id) => {
      timers.delete(id);
      nativeClearTimeout(id);
    };
    window.reentrancyWait = (delay) =>
      new Promise((resolve) => nativeSetTimeout(resolve, delay));

    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const objectUrls = new Set();
    URL.createObjectURL = (value) => {
      const url = nativeCreateObjectURL(value);
      objectUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      objectUrls.delete(url);
      nativeRevokeObjectURL(url);
    };

    window.reentrancyResources = () => ({
      listeners: listeners.length,
      intersections,
      mutations,
      frames: frames.size,
      timers: timers.size,
      postDestroyFrames,
      postDestroyTimers,
      objectUrls: objectUrls.size,
      hosts: document.querySelectorAll("[data-peekling-host]").length,
      content: document.querySelectorAll("aside[data-peekling-content]").length,
      controls: document.querySelectorAll("[data-peekling-controls]").length,
    });
  });
  await page.addScriptTag({ content: bundleSource });
  return page.evaluate(async (phase) => {
    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const settle = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    const waitFor = async (predicate) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await window.reentrancyWait(10);
      }
    };
    const pack = (animated) => ({
      name: `reentrant-${animated ? "animated" : "stable"}`,
      displayName: "Reentrant fixture",
      version: "0.1.0",
      license: "CC0-1.0",
      atlas: {
        src: "atlas.png",
        sha256: window.__peeklingFixtureHashes.transparent,
        columns: 2,
        rows: 1,
        cellWidth: 1,
        cellHeight: 1,
      },
      states: {
        idle: animated
          ? { frames: [0, 1], durations: [100, 100], loop: true }
          : { frames: [0], fps: 1, loop: true },
      },
      defaultScale: 1,
    });
    const survivor = window.Peekling.hatch({
      pack: pack(false),
      atlasUrl: "/atlas.png",
      diagnostics: { console: false },
    });
    await survivor.ready;
    await settle();
    const baseline = window.reentrancyResources();
    const calls = { logger: 0, diagnostic: 0, mount: 0, update: 0 };
    let cleanups = 0;
    let replacementMounts = 0;
    let armed = false;
    let target;
    const options = {
      pack: pack(true),
      atlasUrl: "/atlas.png",
      diagnostics: { console: false },
      plan:
        phase === "update"
          ? {
              baseline: { channels: ["state"], state: { state: "idle" } },
              rules: [
                {
                  id: "progress",
                  when: {
                    source: "application",
                    event: "job.progress",
                    coalesce: "latest",
                  },
                  effect: {
                    channels: ["surface:status"],
                    surfaces: [
                      {
                        id: "status",
                        contentId: "first",
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
            }
          : phase === "cleanup"
            ? {
                baseline: {
                  channels: ["state"],
                  state: { state: "idle" },
                },
                rules: [
                  {
                    id: "first",
                    when: { source: "application", event: "surface.first" },
                    effect: {
                      channels: ["surface:status"],
                      surfaces: [
                        {
                          id: "status",
                          contentId: "first",
                          disposition: "replace",
                        },
                      ],
                    },
                  },
                  {
                    id: "second",
                    when: { source: "application", event: "surface.second" },
                    effect: {
                      channels: ["surface:status"],
                      surfaces: [
                        {
                          id: "status",
                          contentId: "second",
                          disposition: "replace",
                        },
                      ],
                    },
                  },
                ],
              }
            : phase === "mount"
              ? {
                  baseline: {
                    channels: ["state"],
                    state: { state: "idle" },
                  },
                  rules: [
                    {
                      id: "mount",
                      when: { source: "application", event: "surface.open" },
                      effect: {
                        channels: ["surface:status"],
                        surfaces: [
                          {
                            id: "status",
                            contentId: "first",
                            disposition: "replace",
                          },
                        ],
                      },
                    },
                  ],
                }
              : {
                  baseline: {
                    channels: ["state"],
                    state: { state: "idle" },
                  },
                },
      content: {
        first: { "top-center": { mountId: "first" } },
        second: { "top-center": { mountId: "second" } },
      },
      bindings: {
        mounts: {
          first() {
            calls.mount += 1;
            if (phase === "mount") {
              window.reentrancyDestroyed = true;
              target.destroy();
            }
            return {
              update() {
                calls.update += 1;
                if (phase === "update") {
                  window.reentrancyDestroyed = true;
                  target.destroy();
                }
              },
              cleanup() {
                cleanups += 1;
                if (phase === "cleanup") {
                  window.reentrancyDestroyed = true;
                  target.destroy();
                }
              },
            };
          },
          second() {
            replacementMounts += 1;
            return { cleanup() {} };
          },
        },
      },
      logger(record) {
        if (phase === "logger" && armed && record.code === "event.unmatched") {
          armed = false;
          calls.logger += 1;
          window.reentrancyDestroyed = true;
          target.destroy();
        }
      },
      onDiagnostic(message) {
        if (
          phase === "onDiagnostic" &&
          armed &&
          (message === "event.unmatched" || message === "Host event unmatched")
        ) {
          armed = false;
          calls.diagnostic += 1;
          window.reentrancyDestroyed = true;
          target.destroy();
        }
      },
    };
    target = window.Peekling.hatch(options);
    await target.ready;
    if (phase === "logger" || phase === "onDiagnostic") {
      armed = true;
      target.emit("app.unmatched");
    } else if (phase === "mount") {
      target.emit("surface.open");
    } else if (phase === "update") {
      target.emit("job.progress", { sessionId: "job-1", revision: 0 });
      await waitFor(() => calls.mount === 1);
      target.emit("job.progress", { sessionId: "job-1", revision: 1 });
    } else {
      target.emit("surface.first");
      await waitFor(() => calls.mount === 1);
      target.emit("surface.second");
    }
    await waitFor(() =>
      phase === "logger"
        ? calls.logger === 1
        : phase === "onDiagnostic"
          ? calls.diagnostic === 1
          : phase === "mount"
            ? calls.mount === 1
            : phase === "update"
              ? calls.update === 1
              : cleanups === 1,
    );
    await window.reentrancyWait(50);
    await Promise.resolve();
    const after = window.reentrancyResources();
    window.reentrancyDestroyed = false;
    const survivorAccepted = survivor.emit("app.alive").accepted;
    await window.reentrancyWait(50);
    return {
      baseline,
      after,
      calls,
      cleanups,
      replacementMounts,
      survivorAccepted,
      unhandled,
    };
  }, mode);
}

for (const mode of ["logger", "onDiagnostic", "mount", "update", "cleanup"]) {
  test(`destroy from ${mode} during a frame leaves no owned work`, async ({
    page,
  }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const result = await runDestroyReentrancyCase(page, mode);
    if (mode === "logger") expect(result.calls.logger).toBe(1);
    if (mode === "onDiagnostic") expect(result.calls.diagnostic).toBe(1);
    if (mode === "mount") expect(result.calls.mount).toBe(1);
    if (mode === "update") expect(result.calls.update).toBe(1);
    if (mode === "cleanup") {
      expect(result.cleanups).toBe(1);
      expect(result.replacementMounts).toBe(0);
    }
    expect(result.after).toEqual(result.baseline);
    expect(result.survivorAccepted).toBe(true);
    expect(result.unhandled).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

async function runPauseReentrancyCase(page, resumeInsideMount) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page);
  const result = await page.evaluate(async (resumeInsideMount) => {
    const previous = document.querySelector("peekling-character");
    const source = previous.options;
    previous.remove();
    await Promise.resolve();

    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    let resolveMounted;
    const mounted = new Promise((resolve) => {
      resolveMounted = resolve;
    });
    let target;
    const element = document.createElement("peekling-character");
    element.options = {
      ...source,
      plan: {
        baseline: { channels: ["state"], state: { state: "idle" } },
        rules: [
          {
            id: "pause-on-mount",
            when: { source: "application", event: "surface.open" },
            effect: {
              channels: ["state", "surface:status"],
              state: { state: "happy" },
              surfaces: [
                {
                  id: "status",
                  contentId: "status",
                  disposition: "replace",
                },
              ],
            },
          },
        ],
      },
      content: {
        status: { "top-center": { mountId: "pause" } },
      },
      bindings: {
        mounts: {
          pause() {
            target.pause();
            if (resumeInsideMount) target.resume();
            resolveMounted();
            return { cleanup() {} };
          },
        },
      },
    };
    document.body.append(element);
    await element.ready;
    target = element.instance;
    const before = document
      .querySelector("[data-peekling-host]")
      ?.getAttribute("data-peekling-state");
    const admitted = element.emit("surface.open");
    await mounted;
    const whilePaused = document
      .querySelector("[data-peekling-host]")
      ?.getAttribute("data-peekling-state");
    let afterResume = whilePaused;
    if (resumeInsideMount) {
      for (let frame = 0; frame < 6 && afterResume !== "happy"; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        afterResume = document
          .querySelector("[data-peekling-host]")
          ?.getAttribute("data-peekling-state");
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    element.remove();
    await Promise.resolve();
    return {
      admitted,
      before,
      whilePaused,
      afterResume,
      roots: document.querySelectorAll("[data-peekling-host]").length,
      unhandled,
    };
  }, resumeInsideMount);
  return { result, pageErrors };
}

test("pausing from a host mount stops the active frame before the character sink", async ({
  page,
}) => {
  const { result, pageErrors } = await runPauseReentrancyCase(page, false);

  expect(result).toEqual({
    admitted: { accepted: true, coalesced: false, id: 1 },
    before: "idle",
    whilePaused: "idle",
    afterResume: "idle",
    roots: 0,
    unhandled: [],
  });
  expect(pageErrors).toEqual([]);
});

test("a pause-resume host callback invalidates its active frame generation", async ({
  page,
}) => {
  const { result, pageErrors } = await runPauseReentrancyCase(page, true);

  expect(result).toEqual({
    admitted: { accepted: true, coalesced: false, id: 1 },
    before: "idle",
    whilePaused: "idle",
    afterResume: "happy",
    roots: 0,
    unhandled: [],
  });
  expect(pageErrors).toEqual([]);
});

test("the fallback clock shares one time domain with animation frames", async ({
  page,
}) => {
  await page.route("https://fallback-clock.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.route("https://fallback-clock.peekling.test/atlas.png", (route) =>
    route.fulfill({ body: transparentPng, contentType: "image/png" }),
  );
  await page.goto("https://fallback-clock.peekling.test/");
  const patched = await page.evaluate(() => {
    try {
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: undefined,
      });
      return typeof performance.now === "undefined";
    } catch {
      return false;
    }
  });
  expect(patched).toBe(true);
  await page.addScriptTag({ content: bundleSource });
  const result = await page.evaluate(async () => {
    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const instance = window.Peekling.hatch({
      pack: {
        name: "fallback-clock",
        displayName: "Fallback clock",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "atlas.png",
          sha256: window.__peeklingFixtureHashes.transparent,
          columns: 2,
          rows: 1,
          cellWidth: 1,
          cellHeight: 1,
        },
        states: {
          idle: { frames: [0], fps: 1, loop: true },
          happy: { frames: [1], fps: 1, loop: true },
        },
        defaultScale: 1,
      },
      atlasUrl: "/atlas.png",
      plan: {
        baseline: { channels: ["state"], state: { state: "idle" } },
        rules: [
          {
            id: "show-happy",
            when: { source: "application", event: "app.ready" },
            effect: { channels: ["state"], state: { state: "happy" } },
          },
        ],
      },
      diagnostics: { console: false },
    });
    await instance.ready;
    const admitted = instance.emit("app.ready").accepted;
    let state;
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      state = document
        .querySelector("[data-peekling-host]")
        ?.getAttribute("data-peekling-state");
      if (state === "happy") break;
    }
    instance.destroy();
    await Promise.resolve();
    return {
      admitted,
      state,
      roots: document.querySelectorAll("[data-peekling-host]").length,
      unhandled,
    };
  });
  expect(result).toEqual({
    admitted: true,
    state: "happy",
    roots: 0,
    unhandled: [],
  });
});

test("default diagnostics keep routine browser activity quiet and report errors", async ({
  page,
}) => {
  const warnings = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.route("https://assets.peekling.test/atlas.png", (route) =>
    route.fulfill({
      body: transparentPng,
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.route("https://diagnostics.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.goto("https://diagnostics.peekling.test/");
  await page.addScriptTag({ content: bundleSource });

  const result = await page.evaluate(async () => {
    const pack = {
      name: "diagnostics-fixture",
      displayName: "Diagnostics fixture",
      version: "0.1.0",
      license: "CC0-1.0",
      atlas: {
        src: "atlas.png",
        sha256: window.__peeklingFixtureHashes.transparent,
        columns: 2,
        rows: 1,
        cellWidth: 1,
        cellHeight: 1,
      },
      states: { idle: { frames: [0], durations: [100], loop: true } },
      defaultScale: 1,
    };
    const normal = window.Peekling.hatch({
      pack,
      atlasUrl: "https://assets.peekling.test/atlas.png",
    });
    await normal.ready;
    const emitted = normal.emit("app.unmatched", { value: 1 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    window.Peekling.visibility.hide("session");
    window.Peekling.visibility.show();
    normal.pause();
    normal.resume();
    normal.destroy();

    const broken = window.Peekling.hatch({
      pack,
      atlasUrl: "https://assets.peekling.test/atlas.png",
      plan: {
        baseline: {
          channels: ["state", "surface:broken"],
          state: { state: "idle" },
          surfaces: [{ id: "broken", contentId: "broken" }],
        },
      },
      content: { broken: { bottom: { mountId: "broken" } } },
      bindings: {
        mounts: {
          broken() {
            throw new Error("host mount failed");
          },
        },
      },
    });
    await broken.ready;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    broken.destroy();
    return {
      emitAccepted: emitted.accepted,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  });
  await page.waitForTimeout(10);

  expect(result).toEqual({ emitAccepted: true, roots: 0 });
  expect(warnings).toEqual([
    "[Peekling] content.mount-failed (use peekling.js for details)",
  ]);
});

test("explicit Peek selection rejects manifest bytes that differ from the embedded pin", async ({
  page,
}) => {
  const canonical =
    "https://cdn.jsdelivr.net/npm/@peekling/pack-peek@0.1.1/character.json";
  let atlasRequests = 0;
  await page.route(canonical, (route) =>
    route.fulfill({
      body: "{}\n",
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  page.on("request", (request) => {
    if (request.url().includes("atlas")) atlasRequests += 1;
  });
  await page.route("https://pin.peekling.test/", (route) =>
    route.fulfill({ body: "<!doctype html><body></body>" }),
  );
  await page.goto("https://pin.peekling.test/");
  await page.addScriptTag({ content: bundleSource });

  const result = await page.evaluate(async () => {
    const diagnostics = [];
    const instance = window.Peekling.hatch({
      character: "peek",
      diagnostics: { console: false },
      logger: (record) => diagnostics.push(record.code),
    });
    try {
      await instance.ready;
      return { resolved: true };
    } catch (error) {
      return {
        name: error.name,
        issues: error.issues,
        diagnostics,
        roots: document.querySelectorAll("[data-peekling-host]").length,
      };
    }
  });

  expect(result).toEqual({
    name: "PackValidationError",
    issues: ["manifest.hash"],
    diagnostics: ["config.pack-load-failed", "lifecycle.destroyed"],
    roots: 0,
  });
  expect(atlasRequests).toBe(0);
});

test("explicit Peek selection loads the pinned starter package", async ({
  page,
}) => {
  test.skip(
    !peekRoot,
    "Set PEEKLING_PEEK_ROOT for honest prepublication smoke",
  );
  const manifestBytes = await readFile(path.join(peekRoot, "character.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const canonical =
    "https://cdn.jsdelivr.net/npm/@peekling/pack-peek@0.1.1/character.json";
  await page.route(canonical, (route) =>
    route.fulfill({
      body: manifestBytes,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  for (const variant of manifest.assets.atlases.variants) {
    await page.route(new URL(variant.src, canonical).href, async (route) =>
      route.fulfill({
        body: await readFile(path.join(peekRoot, variant.src)),
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
      }),
    );
  }
  await page.route("https://app.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.goto("https://app.peekling.test/");
  await page.addScriptTag({ content: bundleSource });
  const result = await page.evaluate(async () => {
    const instance = window.Peekling.hatch("peek");
    await instance.ready;
    const state = document
      .querySelector("[data-peekling-host]")
      ?.getAttribute("data-peekling-state");
    instance.destroy();
    return state;
  });
  expect(result).toBe("idle");
});

test("DPR2 explicit Peek selection loads its matching immutable atlas", async ({
  browser,
}) => {
  test.skip(
    !peekRoot,
    "Set PEEKLING_PEEK_ROOT for honest prepublication smoke",
  );
  const manifestBytes = await readFile(path.join(peekRoot, "character.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const canonical =
    "https://cdn.jsdelivr.net/npm/@peekling/pack-peek@0.1.1/character.json";
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const requested = [];
  await page.route(canonical, (route) =>
    route.fulfill({
      body: manifestBytes,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  for (const variant of manifest.assets.atlases.variants) {
    const url = new URL(variant.src, canonical).href;
    await page.route(url, async (route) => {
      requested.push(url);
      await route.fulfill({
        body: await readFile(path.join(peekRoot, variant.src)),
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
      });
    });
  }
  await page.route("https://app.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.goto("https://app.peekling.test/");
  await page.addScriptTag({ content: bundleSource });
  await page.evaluate(async () => {
    const instance = window.Peekling.hatch("peek");
    await instance.ready;
    instance.destroy();
  });
  expect(requested).toEqual([
    "https://cdn.jsdelivr.net/npm/@peekling/pack-peek@0.1.1/atlas-2x.png",
  ]);
  await context.close();
});

test("browser file defines one API and Web Component lifecycle", async ({
  page,
}) => {
  const result = await mount(page);
  expect(result.api).toBe("function");
  expect(result.apiKeys).toEqual(["hatch", "visibility"]);
  expect(result.apiFrozen).toBe(true);
  expect(result.publicConstructor).toBe("undefined");
  expect(result.tag).toBe(true);
  expect(result.invalidEvent).toEqual({
    accepted: false,
    reason: "invalid-name",
  });
  expect(result.invalidEventType).toEqual({
    accepted: false,
    reason: "invalid-name",
  });
  expect(result.instanceMethods).toEqual({
    emit: "function",
    override: "function",
    pause: "function",
    resume: "function",
    destroy: "function",
    request: "undefined",
    play: "undefined",
    react: "undefined",
    availableStates: "undefined",
  });
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "idle",
  );
  await expect(
    page.locator("aside[data-peekling-content]"),
  ).not.toHaveAttribute("hidden", "");

  await page.evaluate(() => {
    const element = document.querySelector("peekling-character");
    element.pause();
    element.resume();
    element.remove();
  });
  await expect(page.locator("[data-peekling-host]")).toHaveCount(0);
  await expect(page.locator("aside[data-peekling-content]")).toHaveCount(0);
});

test("changing the Web Component name updates the mounted instance in place", async ({
  page,
}) => {
  let atlasRequests = 0;
  page.on("request", (request) => {
    if (request.url() === "https://assets.peekling.test/atlas.png") {
      atlasRequests += 1;
    }
  });
  await page.addInitScript(() => {
    const attachShadow = Element.prototype.attachShadow;
    window.peeklingContentRoots = [];
    Element.prototype.attachShadow = function (options) {
      const root = attachShadow.call(this, options);
      if (this.matches("aside[data-peekling-content]")) {
        window.peeklingContentRoots.push(root);
      }
      return root;
    };
  });
  await mount(page);
  const requestsBeforeChange = atlasRequests;

  const result = await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    const ready = element.ready;
    const instance = element.instance;
    element.setAttribute("name", "Moss renamed");
    const readyStayedStable = element.ready === ready;
    await element.ready;
    return {
      readyStayedStable,
      instanceStayedStable: element.instance === instance,
      contentRootCount: window.peeklingContentRoots.length,
    };
  });

  expect(result).toEqual({
    readyStayedStable: true,
    instanceStayedStable: true,
    contentRootCount: 1,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.peeklingContentRoots.at(-1)?.textContent ?? "",
      ),
    )
    .toContain("Moss renamed");
  expect(atlasRequests).toBe(requestsBeforeChange);
});

test("an invalid Web Component name is contained without remounting", async ({
  page,
}) => {
  let atlasRequests = 0;
  page.on("request", (request) => {
    if (request.url() === "https://assets.peekling.test/atlas.png") {
      atlasRequests += 1;
    }
  });
  await mount(page);
  const requestsBeforeChange = atlasRequests;

  const result = await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    const ready = element.ready;
    const instance = element.instance;
    const host = document.querySelector("[data-peekling-host]");
    window.peeklingDiagnostics.length = 0;
    element.setAttribute("name", "x".repeat(81));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      readyStayedStable: element.ready === ready,
      instanceStayedStable: element.instance === instance,
      hostStayedStable: document.querySelector("[data-peekling-host]") === host,
      diagnosticCodes: (window.peeklingDiagnostics ?? []).map(
        (record) => record.code,
      ),
    };
  });

  expect(result).toEqual({
    readyStayedStable: true,
    instanceStayedStable: true,
    hostStayedStable: true,
    diagnosticCodes: ["config.invalid-name"],
  });
  expect(atlasRequests).toBe(requestsBeforeChange);
});

for (const configurable of [false, true]) {
  test(`browser file preserves a ${configurable ? "configurable" : "non-configurable"} host Peekling global`, async ({
    page,
  }) => {
    const { result, pageErrors } = await loadBrowserCollisionFixture(
      page,
      `window.hostPeekling=Object.freeze({owner:"host"});Object.defineProperty(window,"Peekling",{configurable:${configurable},value:window.hostPeekling,writable:false});`,
    );
    expect(result).toEqual({
      collisions: ["Peekling"],
      unhandled: [],
      cspViolations: [],
      globalSame: true,
      globalHatch: "undefined",
      element: true,
      elementSame: null,
    });
    expect(pageErrors).toEqual([]);
  });
}

test("browser file preserves a foreign custom element and reports the collision", async ({
  page,
}) => {
  const { result, pageErrors } = await loadBrowserCollisionFixture(
    page,
    `window.hostElement=class extends HTMLElement{};customElements.define("peekling-character",window.hostElement);`,
  );
  expect(result).toEqual({
    collisions: ["peekling-character"],
    unhandled: [],
    cspViolations: [],
    globalSame: null,
    globalHatch: "function",
    element: true,
    elementSame: true,
  });
  expect(pageErrors).toEqual([]);
});

test("browser file installs both facades without a collision diagnostic when names are free", async ({
  page,
}) => {
  const { result, pageErrors } = await loadBrowserCollisionFixture(page);
  expect(result).toEqual({
    collisions: [],
    unhandled: [],
    cspViolations: [],
    globalSame: null,
    globalHatch: "function",
    element: true,
    elementSame: null,
  });
  expect(pageErrors).toEqual([]);
});

test("emit reports paused queue capacity without evicting accepted facts", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    element.pause();
    const admitted = Array.from({ length: 33 }, (_, index) =>
      element.emit(`app.fact-${index}`),
    );
    element.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    element.remove();
    return admitted;
  });
  expect(result.slice(0, 32).every((entry) => entry.accepted)).toBe(true);
  expect(result.every((entry) => typeof entry.accepted === "boolean")).toBe(
    true,
  );
  expect(result[32]).toEqual({ accepted: false, reason: "queue-full" });
});

test("browser validation keeps compact structured diagnostics", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundleSource });
  const result = await page.evaluate(() => {
    try {
      window.Peekling.hatch({ character: "peek", behaviors: ["idle"] });
      return { resolved: true };
    } catch (error) {
      return {
        name: error.name,
        message: error.message,
        issue: error.issues?.[0],
      };
    }
  });
  expect(result).toEqual({
    name: "PeeklingPreflightError",
    message: "$.behaviors: unknown-field",
    issue: {
      code: "unknown-field",
      path: "$.behaviors",
      message: "unknown-field",
    },
  });
});

test("browser pack failures keep compact stable issue codes", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundleSource });
  const result = await page.evaluate(async () => {
    const instance = window.Peekling.hatch({
      pack: {},
      styles: { url: "https://peekling.invalid/peekling.css" },
    });
    try {
      await instance.ready;
      return { resolved: true };
    } catch (error) {
      return {
        name: error.name,
        message: error.message,
        issues: error.issues,
      };
    } finally {
      instance.destroy();
    }
  });
  expect(result).toEqual({
    name: "PackValidationError",
    message: "pack:format,name,version,license,assets,states,metadata",
    issues: [
      "format",
      "name",
      "version",
      "license",
      "assets",
      "states",
      "metadata",
    ],
  });
});

test("browser Pack validation requires a valid atlas SHA-256 declaration", async ({
  page,
}) => {
  let atlasRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/atlas.png")) atlasRequests += 1;
  });
  await page.route("https://hash.peekling.test/", (route) =>
    route.fulfill({ body: "<!doctype html><body></body>" }),
  );
  await page.goto("https://hash.peekling.test/");
  await page.addScriptTag({ content: bundleSource });

  const result = await page.evaluate(async () => {
    const outcomes = [];
    for (const sha256 of [undefined, "not-a-sha256"]) {
      const instance = window.Peekling.hatch({
        pack: {
          name: "hash-fixture",
          displayName: "Hash fixture",
          version: "0.1.0",
          license: "CC0-1.0",
          atlas: {
            src: "atlas.png",
            ...(sha256 === undefined ? {} : { sha256 }),
            columns: 2,
            rows: 1,
            cellWidth: 1,
            cellHeight: 1,
          },
          states: { idle: { frames: [0], fps: 1, loop: true } },
          defaultScale: 1,
        },
        atlasUrl: "/atlas.png",
        diagnostics: { console: false },
      });
      try {
        await instance.ready;
        outcomes.push({ resolved: true });
      } catch (error) {
        outcomes.push({ name: error.name, issues: error.issues });
      }
    }
    return {
      outcomes,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  });

  expect(result).toEqual({
    outcomes: [
      { name: "PackValidationError", issues: ["atlas.sha256"] },
      { name: "PackValidationError", issues: ["atlas.sha256"] },
    ],
    roots: 0,
  });
  expect(atlasRequests).toBe(0);
});

test("engine-default Plan runs when an explicit Pack omits plan", async ({
  page,
}) => {
  await mount(page, null);
  const host = page.locator("[data-peekling-host]");
  const before = await host.getAttribute("data-peekling-x");
  await page.mouse.move(100, 100);
  await expect(host).toHaveAttribute("data-peekling-state", "move");
  await expect
    .poll(() => host.getAttribute("data-peekling-x"))
    .not.toBe(before);
});

test("window scroll stops pointer motion until the next pointer observation", async ({
  page,
}) => {
  await mount(page, {
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
        id: "window-scroll",
        when: {
          source: "browser",
          event: "window.scroll",
          coalesce: "latest",
        },
        effect: {
          channels: ["state"],
          state: { state: "happy" },
          until: { type: "duration", ms: 600 },
        },
      },
    ],
  });
  const host = page.locator("[data-peekling-host]");
  const initial = await host.getAttribute("data-peekling-x");

  await page.mouse.move(10, 10);
  await expect
    .poll(() => host.getAttribute("data-peekling-x"))
    .not.toBe(initial);

  await page.evaluate(() => dispatchEvent(new Event("scroll")));
  await expect(host).toHaveAttribute("data-peekling-state", "happy");
  const stopped = await host.getAttribute("data-peekling-x");
  await page.waitForTimeout(180);
  await expect(host).toHaveAttribute("data-peekling-x", stopped);

  await page.mouse.move(1_200, 700);
  await expect
    .poll(() => host.getAttribute("data-peekling-x"))
    .not.toBe(stopped);
});

test("renderer keeps DPR snapping, lift, and a positive scale transform aligned", async ({
  page,
}) => {
  await page.route("https://renderer.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.route("https://renderer.peekling.test/atlas.png", (route) =>
    route.fulfill({ body: transparentPng, contentType: "image/png" }),
  );
  await page.goto("https://renderer.peekling.test/");
  await page.evaluate(() => {
    window.peeklingRuleStyles = [];
    const insertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      const inserted = insertRule.call(this, rule, index);
      const style = this.cssRules[inserted]?.style;
      if (style) window.peeklingRuleStyles.push(style);
      return inserted;
    };
  });
  await page.addScriptTag({ content: bundleSource });
  const initial = await page.evaluate(async () => {
    window.rendererInstance = window.Peekling.hatch({
      position: "center",
      pack: {
        name: "renderer-fixture",
        displayName: "Renderer fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "atlas.png",
          sha256: window.__peeklingFixtureHashes.transparent,
          columns: 2,
          rows: 1,
          cellWidth: 1,
          cellHeight: 1,
        },
        states: {
          idle: { frames: [0], fps: 1, loop: true },
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
        locomotionMotion: [
          { at: 0, advance: 0, lift: 0 },
          { at: 0.5, advance: 0.5, lift: 0.5 },
          { at: 1, advance: 1, lift: 0 },
        ],
        defaultScale: 1,
      },
      atlasUrl: "/atlas.png",
      plan: {
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
        ],
      },
      diagnostics: { console: false },
    });
    await window.rendererInstance.ready;
    const host = document.querySelector("[data-peekling-host]");
    return {
      x: Number(host.getAttribute("data-peekling-x")),
      y: Number(host.getAttribute("data-peekling-y")),
      transform: window.peeklingRuleStyles.find((style) => style.transform)
        ?.transform,
    };
  });
  expect(Number.isFinite(initial.x)).toBe(true);
  expect(Number.isFinite(initial.y)).toBe(true);
  expect(initial.transform).toMatch(/translate3d\([^)]*\) scale\(1\)$/);
  await page.mouse.move(1_000, initial.y + 0.5);
  await expect
    .poll(() =>
      page
        .locator("[data-peekling-host]")
        .getAttribute("data-peekling-y")
        .then(Number),
    )
    .toBeLessThan(initial.y);
  await page.evaluate(() => window.rendererInstance.destroy());
});

test("canonical application Events compose a progress surface with pointer motion", async ({
  page,
}) => {
  await mount(page, {
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
  });
  const result = await page.evaluate(() => {
    const element = document.querySelector("peekling-character");
    return {
      saved: element.emit("app.saved", { documentId: "guide" }),
      progress: element.emit("job.progress", {
        sessionId: "job-1",
        revision: 42,
        completed: 4,
      }),
    };
  });
  expect(result.saved.accepted).toBe(true);
  expect(result.progress.accepted).toBe(true);
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "happy",
  );
  await expect(
    page.locator("aside[data-peekling-content]"),
  ).not.toHaveAttribute("hidden", "");
  const before = await page
    .locator("[data-peekling-host]")
    .getAttribute("data-peekling-x");
  await page.mouse.move(100, 100);
  await expect
    .poll(() =>
      page.locator("[data-peekling-host]").getAttribute("data-peekling-x"),
    )
    .not.toBe(before);
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "happy",
  );
  await expect(
    page.locator("aside[data-peekling-content]"),
  ).not.toHaveAttribute("hidden", "");
});

test("late ordered progress preserves disjoint browser effects", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page);

  const result = await page.evaluate(async () => {
    const previous = document.querySelector("peekling-character");
    const source = previous.options;
    previous.remove();
    const records = {
      progress: [],
      progressCleanups: 0,
      finishedMounts: 0,
      finishedCleanups: 0,
      status: [],
      statusCleanups: 0,
      diagnostics: [],
      unhandled: [],
    };
    addEventListener("unhandledrejection", (event) => {
      records.unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const element = document.createElement("peekling-character");
    element.options = {
      ...source,
      plan: {
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
      content: {
        "job-progress": { "top-left": { mountId: "progress" } },
        "job-finished": { "top-left": { mountId: "finished" } },
        status: { "top-right": { mountId: "status" } },
      },
      bindings: {
        mounts: {
          progress: ({ data }) => {
            records.progress.push(data.revision);
            return {
              update(next) {
                records.progress.push(next.revision);
              },
              cleanup() {
                records.progressCleanups += 1;
              },
            };
          },
          finished: () => {
            records.finishedMounts += 1;
            return {
              cleanup() {
                records.finishedCleanups += 1;
              },
            };
          },
          status: ({ data }) => {
            records.status.push(data.progress);
            return {
              update(next) {
                records.status.push(next.progress);
              },
              cleanup() {
                records.statusCleanups += 1;
              },
            };
          },
        },
      },
      logger: (record) => {
        if (
          ["event.closed", "event.stale", "event.invalid"].includes(record.code)
        ) {
          records.diagnostics.push({
            code: record.code,
            metadata: record.metadata,
          });
        }
      },
    };
    document.body.append(element);
    await element.ready;
    const settle = async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 80));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    };

    const initial = element.emit("job.progress", {
      sessionId: "job-1",
      revision: 1,
      progress: 10,
    });
    await settle();
    const finished = element.emit("job.finished", { sessionId: "job-1" });
    await settle();
    const late = element.emit("job.progress", {
      sessionId: "job-1",
      revision: 2,
      progress: 20,
    });
    await settle();
    const state = document
      .querySelector("[data-peekling-host]")
      ?.getAttribute("data-peekling-state");
    element.remove();
    await settle();
    return {
      admission: [initial, finished, late],
      records,
      state,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  });

  expect(result.admission.every((entry) => entry.accepted)).toBe(true);
  expect(result.records.progress).toEqual([1]);
  expect(result.records.progressCleanups).toBe(1);
  expect(result.records.finishedMounts).toBe(1);
  expect(result.records.finishedCleanups).toBe(1);
  expect(result.records.status).toEqual([10, 20]);
  expect(result.records.statusCleanups).toBe(1);
  expect(result.records.diagnostics).toEqual([
    {
      code: "event.closed",
      metadata: { channel: "surface:job-progress" },
    },
  ]);
  expect(result.records.unhandled).toEqual([]);
  expect(result.state).toBe("happy");
  expect(result.roots).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("a mounted progress surface updates while pointer motion keeps running", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const previous = document.querySelector("peekling-character");
    const source = previous.options;
    previous.remove();
    window.surfaceCalls = [];
    const element = document.createElement("peekling-character");
    element.options = {
      ...source,
      plan: {
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
      content: {
        "job-progress": { "top-center": { mountId: "progress" } },
      },
      bindings: {
        mounts: {
          progress: ({ root, data }) => {
            window.surfaceCalls.push({
              type: "mount",
              data,
              frozen: Object.isFrozen(data),
            });
            root.append(document.createElement("progress"));
            return {
              update(next) {
                window.surfaceCalls.push({
                  type: "update",
                  data: next,
                  frozen: Object.isFrozen(next),
                });
              },
              cleanup() {
                window.surfaceCalls.push({ type: "cleanup" });
              },
            };
          },
        },
      },
    };
    document.body.append(element);
    await element.ready;
    element.emit("job.progress", {
      sessionId: "job-1",
      revision: 0,
      progress: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    element.emit("job.progress", {
      sessionId: "job-1",
      revision: 1,
      progress: 42,
    });
  });
  await page.mouse.move(120, 100);
  await page.waitForTimeout(100);
  const beforeDestroy = await page.evaluate(() => ({
    calls: window.surfaceCalls,
    state: document
      .querySelector("[data-peekling-host]")
      ?.getAttribute("data-peekling-state"),
  }));
  expect(beforeDestroy.calls.map((call) => call.type)).toEqual([
    "mount",
    "update",
  ]);
  expect(beforeDestroy.calls.every((call) => call.frozen !== false)).toBe(true);
  expect(beforeDestroy.calls[1].data.progress).toBe(42);
  expect(beforeDestroy.state).toBe("move");
  await page.evaluate(() =>
    document.querySelector("peekling-character").remove(),
  );
  expect(await page.evaluate(() => window.surfaceCalls.at(-1).type)).toBe(
    "cleanup",
  );
});

test("mounted roots repair same-document damage and isolate foreign adoption", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page);
  const result = await page.evaluate(async () => {
    const previous = document.querySelector("peekling-character");
    const source = previous.options;
    previous.remove();
    const diagnostics = [];
    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    let repairableRoot;
    let unrelatedRoot;
    let settleRepairable;
    let repairableMounts = 0;
    let repairableCleanups = 0;
    let unrelatedCleanups = 0;
    const element = document.createElement("peekling-character");
    element.options = {
      ...source,
      plan: {
        baseline: {
          channels: ["state", "surface:repairable", "surface:unrelated"],
          state: { state: "idle" },
          surfaces: [
            { id: "repairable", contentId: "repairable" },
            { id: "unrelated", contentId: "unrelated" },
          ],
        },
      },
      content: {
        repairable: { "top-left": { mountId: "repairable" } },
        unrelated: { "top-right": { mountId: "unrelated" } },
      },
      bindings: {
        mounts: {
          repairable: ({ root }) => {
            repairableMounts += 1;
            repairableRoot = root;
            root.textContent = "repairable surface";
            return new Promise((resolve) => {
              settleRepairable = resolve;
            });
          },
          unrelated: ({ root }) => {
            unrelatedRoot = root;
            root.textContent = "unrelated surface";
            return {
              cleanup() {
                unrelatedCleanups += 1;
              },
            };
          },
        },
      },
      diagnostics: { console: false },
      onDiagnostic: (message) => diagnostics.push(message),
    };
    document.body.append(element);
    await element.ready;
    for (let attempt = 0; !repairableRoot && attempt < 10; attempt += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const expectedParent = repairableRoot.parentNode;
    const settle = async (name, repaired) => {
      element.emit(name);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (repaired()) return true;
      }
      return repaired();
    };

    repairableRoot.remove();
    const deletionRepaired = await settle(
      "repair.deleted",
      () => repairableRoot.parentNode === expectedParent,
    );

    const hostile = document.createElement("div");
    document.body.append(hostile);
    hostile.append(repairableRoot);
    const reparentingRepaired = await settle(
      "repair.reparented",
      () => repairableRoot.parentNode === expectedParent,
    );

    const frame = document.createElement("iframe");
    frame.srcdoc = "<!doctype html><body></body>";
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener("load", resolve));
    frame.contentDocument.body.append(
      frame.contentDocument.adoptNode(repairableRoot),
    );
    const adoptedRootRemoved = await settle(
      "repair.adopted",
      () => repairableRoot.parentNode === null,
    );
    const unrelatedSurvives =
      unrelatedRoot.parentNode !== null &&
      unrelatedRoot.textContent === "unrelated surface";

    settleRepairable({
      cleanup() {
        repairableCleanups += 1;
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    const cleanupAfterSettlement = repairableCleanups;
    element.instance.destroy();

    return {
      deletionRepaired,
      reparentingRepaired,
      adoptedRootRemoved,
      unrelatedSurvives,
      repairableMounts,
      cleanupAfterSettlement,
      repairableCleanups,
      unrelatedCleanups,
      adoptedDiagnostic: diagnostics.some((message) =>
        message.includes("adopted"),
      ),
      unhandled,
    };
  });

  expect(result).toEqual({
    deletionRepaired: true,
    reparentingRepaired: true,
    adoptedRootRemoved: true,
    unrelatedSurvives: true,
    repairableMounts: 1,
    cleanupAfterSettlement: 1,
    repairableCleanups: 1,
    unrelatedCleanups: 1,
    adoptedDiagnostic: true,
    unhandled: [],
  });
  expect(pageErrors).toEqual([]);
});

test("accepted synchronous Events keep progressing under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "first",
        when: { source: "application", event: "notice.first" },
        effect: {
          channels: ["state"],
          state: { state: "happy" },
        },
      },
      {
        id: "second",
        when: { source: "application", event: "notice.second" },
        effect: {
          channels: ["state"],
          state: { state: "move" },
        },
      },
    ],
  });

  const admission = await page.evaluate(() => {
    const element = document.querySelector("peekling-character");
    return [element.emit("notice.first"), element.emit("notice.second")];
  });
  expect(admission.every((result) => result.accepted)).toBe(true);
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "move",
  );
});

test("the first same-Event interrupt keeps its declared state channel", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "first-interrupt",
        when: { source: "application", event: "notice.opened" },
        effect: {
          channels: ["state"],
          state: { state: "happy" },
          until: { type: "duration", ms: 1_000 },
        },
      },
      {
        id: "second-interrupt",
        when: { source: "application", event: "notice.opened" },
        effect: {
          channels: ["state"],
          state: { state: "move" },
          until: { type: "duration", ms: 1_000 },
        },
      },
    ],
  });

  await page.evaluate(() =>
    document.querySelector("peekling-character").emit("notice.opened"),
  );
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "happy",
  );
});

test("an override completion event also reaches its matching Plan Rule", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const previous = document.querySelector("peekling-character");
    const source = previous.options;
    previous.remove();
    let cleanups = 0;
    const element = document.createElement("peekling-character");
    element.options = {
      ...source,
      plan: {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "accepted",
            when: { source: "application", event: "approval.accepted" },
            effect: {
              channels: ["state"],
              state: { state: "happy" },
            },
          },
        ],
      },
      content: {
        approval: { "top-center": { mountId: "approval" } },
      },
      bindings: {
        mounts: {
          approval: ({ root, emit }) => {
            const button = document.createElement("button");
            button.textContent = "Accept";
            button.addEventListener("click", () =>
              emit("approval.accepted", { requestId: "r-1" }),
            );
            root.append(button);
            window.acceptApproval = () => button.click();
            return Promise.resolve({
              cleanup() {
                cleanups += 1;
              },
            });
          },
        },
      },
    };
    document.body.append(element);
    await element.ready;
    const handle = element.override({
      effect: {
        channels: ["surface:approval"],
        surfaces: [
          {
            id: "approval",
            contentId: "approval",
            data: { requestId: "r-1" },
          },
        ],
      },
      until: { type: "event", name: "approval.accepted", timeout: 2_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    window.acceptApproval();
    const completion = await handle.finished;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return {
      reason: completion.reason,
      state: document
        .querySelector("[data-peekling-host]")
        ?.getAttribute("data-peekling-state"),
      cleanups,
    };
  });
  expect(result).toEqual({ reason: "event", state: "happy", cleanups: 1 });
});

test("browser completion names release Overrides only from browser observations", async ({
  page,
}) => {
  await mount(page, {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "clicked",
        when: { source: "browser", event: "pointer.click" },
        effect: {
          channels: ["state"],
          state: { state: "happy" },
        },
      },
    ],
  });
  const result = await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    const handle = element.override({
      effect: {
        channels: ["surface:status"],
        surfaces: [{ id: "status", contentId: "status" }],
      },
      until: { type: "event", name: "pointer.click", timeout: 500 },
    });
    element.emit("pointer.click", { source: "application" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterApplication = handle.status;
    document.body.dispatchEvent(
      new PointerEvent("click", {
        bubbles: true,
        clientX: 20,
        clientY: 20,
        pointerType: "mouse",
      }),
    );
    return {
      afterApplication,
      reason: (await handle.finished).reason,
    };
  });

  expect(result).toEqual({ afterApplication: "active", reason: "event" });
});

test("a completion-only browser click releases a Plan interrupt", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "open-notice",
        when: { source: "application", event: "notice.opened" },
        effect: {
          channels: ["state"],
          state: { state: "happy" },
          until: { type: "event", name: "pointer.click", timeout: 2_000 },
        },
      },
    ],
  });

  await page.evaluate(() =>
    document.querySelector("peekling-character").emit("notice.opened"),
  );
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "happy",
  );
  await page.mouse.click(20, 20);
  await page.waitForTimeout(150);
  expect(
    await page
      .locator("[data-peekling-host]")
      .getAttribute("data-peekling-state"),
  ).toBe("idle");
});

test("a completion-only browser click releases an Override", async ({
  page,
}) => {
  await mount(page, {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
  });

  const reason = await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    const handle = element.override({
      effect: { channels: ["state"], state: { state: "happy" } },
      until: { type: "event", name: "pointer.click", timeout: 250 },
    });
    document.body.dispatchEvent(
      new PointerEvent("click", {
        bubbles: true,
        clientX: 20,
        clientY: 20,
        pointerType: "mouse",
      }),
    );
    return (await handle.finished).reason;
  });

  expect(reason).toBe("event");
});

test("queued section enter and leave facts are both delivered between ticks", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(
    page,
    {
      baseline: {
        channels: ["state"],
        state: { state: "idle" },
      },
      rules: [
        {
          id: "section-entered",
          when: {
            source: "browser",
            event: "section.visibility",
            selector: "#edge-target",
            phase: "enter",
            threshold: 0.25,
          },
          effect: {
            channels: ["state"],
            state: { state: "happy" },
          },
        },
        {
          id: "section-left",
          when: {
            source: "browser",
            event: "section.visibility",
            selector: "#edge-target",
            phase: "leave",
            threshold: 0.25,
          },
          effect: {
            channels: ["state"],
            state: { state: "idle" },
          },
        },
      ],
    },
    async (fixturePage) => {
      await fixturePage.evaluate(() => {
        const target = document.createElement("section");
        target.id = "edge-target";
        document.body.append(target);
        window.sectionObservers = [];
        window.IntersectionObserver = class {
          constructor(callback) {
            this.callback = callback;
            window.sectionObservers.push(this);
          }
          observe(target) {
            this.target = target;
          }
          unobserve() {}
          disconnect() {}
        };
      });
    },
  );
  await page.evaluate(() => {
    const host = document.querySelector("[data-peekling-host]");
    window.edgeStates = [];
    new MutationObserver(() => {
      window.edgeStates.push(host.getAttribute("data-peekling-state"));
    }).observe(host, {
      attributes: true,
      attributeFilter: ["data-peekling-state"],
    });
    const observer = window.sectionObservers[0];
    const target = document.querySelector("#edge-target");
    observer.callback([
      { target, isIntersecting: true, intersectionRatio: 0.5 },
    ]);
    observer.callback([
      { target, isIntersecting: false, intersectionRatio: 0 },
    ]);
  });

  await expect
    .poll(() => page.evaluate(() => window.edgeStates.includes("happy")))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.edgeStates.at(-1)))
    .toBe("idle");
});

test("obsolete behaviors input and Plan compile failures reject without leaking", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const source = document.querySelector("peekling-character").options;
    const cases = [
      { ...source, plan: undefined, behaviors: ["idle"] },
      {
        ...source,
        plan: {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "first",
              when: { source: "application", event: "job.progress" },
              effect: {
                channels: ["surface:job-progress"],
                surfaces: [{ id: "job-progress", contentId: "job-progress" }],
              },
            },
            {
              id: "second",
              when: { source: "application", event: "job.finished" },
              effect: {
                channels: ["surface:job-progress"],
                surfaces: [{ id: "job-progress", contentId: "job-progress" }],
              },
            },
          ],
        },
      },
    ];
    const errors = [];
    for (const options of cases) {
      const element = document.createElement("peekling-character");
      element.options = options;
      document.body.append(element);
      try {
        await element.ready;
        errors.push("resolved");
      } catch (error) {
        errors.push(error.name);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      errors,
      unhandled,
      hosts: document.querySelectorAll("[data-peekling-host]").length,
      contents: document.querySelectorAll("aside[data-peekling-content]")
        .length,
    };
  });
  expect(result).toEqual({
    errors: ["PeeklingPreflightError", "PeeklingPreflightError"],
    unhandled: [],
    hosts: 1,
    contents: 1,
  });
});

test("non-motion loops and one-shot overrides schedule only their frame boundaries", async ({
  page,
}) => {
  await mount(page);
  const host = page.locator("[data-peekling-host]");
  await expect(host).toHaveAttribute("data-peekling-frame", "0");
  await page.waitForTimeout(100);
  await expect(host).toHaveAttribute("data-peekling-frame", "1");
  await page.evaluate(() => {
    const handle = document.querySelector("peekling-character").override({
      effect: { channels: ["state"], state: { state: "happy" } },
      until: { type: "duration", ms: 300 },
    });
    window.oneShotOverrideFinished = handle.finished;
  });
  await expect(host).toHaveAttribute("data-peekling-state", "happy");
  await page.waitForTimeout(80);
  await expect(host).toHaveAttribute("data-peekling-frame", "1");
  await page.evaluate(() => window.oneShotOverrideFinished);
  await expect(host).toHaveAttribute("data-peekling-state", "idle");
});

test("pause does not consume override clocks", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const element = document.querySelector("peekling-character");
    const handle = element.override({
      effect: { channels: ["state"], state: { state: "happy" } },
      until: { type: "duration", ms: 100 },
    });
    window.pausedOverride = handle;
    window.pausedOverrideResult = undefined;
    void handle.finished.then((result) => {
      window.pausedOverrideResult = result.reason;
    });
    element.pause();
  });
  await page.waitForTimeout(250);
  await expect
    .poll(() => page.evaluate(() => window.pausedOverride.status))
    .toBe("active");
  await page.evaluate(() =>
    document.querySelector("peekling-character").resume(),
  );
  await expect
    .poll(() => page.evaluate(() => window.pausedOverrideResult))
    .toBe("timeout");
});

test("pause, dismissal, recovery, and remount release parked collectors and work", async ({
  page,
}) => {
  const lifecyclePlan = {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "follow-pointer",
        when: { source: "browser", event: "pointer.move" },
        effect: {
          channels: ["motion"],
          motion: { type: "follow-pointer" },
        },
      },
      {
        id: "watch-main",
        when: {
          source: "browser",
          event: "section.visibility",
          selector: "#main",
          phase: "while-visible",
        },
        effect: {
          channels: ["state"],
          state: { state: "happy" },
        },
      },
    ],
  };
  await mount(page, lifecyclePlan, async (instrumentedPage) => {
    await instrumentedPage.evaluate(() => {
      window.unhandled = [];
      window.addEventListener("unhandledrejection", (event) => {
        window.unhandled.push(String(event.reason));
        event.preventDefault();
      });
      const main = document.createElement("main");
      main.id = "main";
      document.body.append(main);
      const listeners = [];
      const nativeAdd = EventTarget.prototype.addEventListener;
      const nativeRemove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (
        type,
        listener,
        options,
      ) {
        if ((this === document || this === window) && listener) {
          const exists = listeners.some(
            (entry) =>
              entry.target === this &&
              entry.type === type &&
              entry.listener === listener,
          );
          if (!exists) listeners.push({ target: this, type, listener });
        }
        return nativeAdd.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function (
        type,
        listener,
        options,
      ) {
        const index = listeners.findIndex(
          (entry) =>
            entry.target === this &&
            entry.type === type &&
            entry.listener === listener,
        );
        if (index >= 0) listeners.splice(index, 1);
        return nativeRemove.call(this, type, listener, options);
      };

      const NativeIntersectionObserver = window.IntersectionObserver;
      const NativeMutationObserver = window.MutationObserver;
      let intersections = 0;
      let mutations = 0;
      window.IntersectionObserver = class {
        #active = true;
        #inner;
        constructor(callback, options) {
          intersections += 1;
          this.#inner = new NativeIntersectionObserver(callback, options);
        }
        observe(target) {
          if (!this.#active) intersections += 1;
          this.#active = true;
          this.#inner.observe(target);
        }
        unobserve(target) {
          this.#inner.unobserve(target);
        }
        disconnect() {
          if (this.#active) intersections -= 1;
          this.#active = false;
          this.#inner.disconnect();
        }
        takeRecords() {
          return this.#inner.takeRecords();
        }
      };
      window.MutationObserver = class {
        #active = false;
        #inner;
        constructor(callback) {
          this.#inner = new NativeMutationObserver(callback);
        }
        observe(target, options) {
          if (!this.#active) mutations += 1;
          this.#active = true;
          this.#inner.observe(target, options);
        }
        disconnect() {
          if (this.#active) mutations -= 1;
          this.#active = false;
          this.#inner.disconnect();
        }
        takeRecords() {
          return this.#inner.takeRecords();
        }
      };

      const nativeRaf = window.requestAnimationFrame.bind(window);
      const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
      const frames = new Set();
      window.requestAnimationFrame = (callback) => {
        let id = 0;
        id = nativeRaf((time) => {
          frames.delete(id);
          callback(time);
        });
        frames.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        frames.delete(id);
        nativeCancelRaf(id);
      };

      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeClearTimeout = window.clearTimeout.bind(window);
      const timers = new Set();
      window.setTimeout = (callback, delay, ...args) => {
        let id = 0;
        id = nativeSetTimeout(() => {
          timers.delete(id);
          callback(...args);
        }, delay);
        timers.add(id);
        return id;
      };
      window.clearTimeout = (id) => {
        timers.delete(id);
        nativeClearTimeout(id);
      };

      const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
      const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
      let objectUrls = 0;
      URL.createObjectURL = (value) => {
        objectUrls += 1;
        return nativeCreateObjectURL(value);
      };
      URL.revokeObjectURL = (value) => {
        objectUrls -= 1;
        return nativeRevokeObjectURL(value);
      };

      window.lifecycleSnapshot = () => ({
        pointermove: listeners.filter((entry) => entry.type === "pointermove")
          .length,
        intersections,
        mutations,
        frames: frames.size,
        timers: timers.size,
        objectUrls,
        hosts: document.querySelectorAll("[data-peekling-host]").length,
        controls: document.querySelectorAll("[data-peekling-controls]").length,
      });
    });
  });

  await expect
    .poll(() => page.evaluate(() => window.lifecycleSnapshot()))
    .toMatchObject({
      pointermove: 2,
      intersections: 1,
      mutations: 2,
      hosts: 1,
    });

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => page.evaluate(() => window.lifecycleSnapshot()))
    .toMatchObject({
      pointermove: 1,
      intersections: 0,
      mutations: 1,
      frames: 0,
      timers: 0,
    });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => page.evaluate(() => window.lifecycleSnapshot()))
    .toMatchObject({ pointermove: 2, intersections: 1, mutations: 2 });

  await page.evaluate(() =>
    document.querySelector("peekling-character").pause(),
  );
  await expect
    .poll(() => page.evaluate(() => window.lifecycleSnapshot()))
    .toMatchObject({
      pointermove: 1,
      intersections: 0,
      mutations: 1,
      frames: 0,
      timers: 0,
    });

  await page.evaluate(() => {
    const element = document.querySelector("peekling-character");
    element.resume();
    element.resume();
  });
  await expect
    .poll(() => page.evaluate(() => window.lifecycleSnapshot()))
    .toMatchObject({ pointermove: 2, intersections: 1, mutations: 2 });

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.evaluate(() => window.Peekling.visibility.hide("forever"));
    await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
      "hidden",
      "",
    );
    await expect(page.locator("[data-peekling-host]")).toBeHidden();
    expect(
      await page.evaluate(() =>
        document.querySelector("peekling-character").emit("app.parked"),
      ),
    ).toEqual({ accepted: false, reason: "hidden" });
    await expect
      .poll(() => page.evaluate(() => window.lifecycleSnapshot()))
      .toMatchObject({
        pointermove: 0,
        intersections: 0,
        mutations: 1,
        frames: 0,
        timers: 0,
      });
    await page.evaluate(() => window.Peekling.visibility.show());
    await expect(page.locator("[data-peekling-host]")).not.toHaveAttribute(
      "hidden",
      "",
    );
    await expect(page.locator("[data-peekling-host]")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.lifecycleSnapshot()))
      .toMatchObject({ pointermove: 2, intersections: 1, mutations: 2 });
  }

  const remounted = await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    element.remove();
    const afterRemove = window.lifecycleSnapshot();
    document.body.append(element);
    await element.ready;
    const afterRemount = window.lifecycleSnapshot();
    element.remove();
    await Promise.resolve();
    return {
      afterRemove,
      afterRemount,
      afterFinalRemove: window.lifecycleSnapshot(),
      unhandled: window.unhandled ?? [],
    };
  });
  expect(remounted.afterRemove).toMatchObject({
    pointermove: 0,
    intersections: 0,
    mutations: 1,
    frames: 0,
    timers: 0,
    objectUrls: 0,
    hosts: 0,
    controls: 0,
  });
  expect(remounted.afterRemount).toMatchObject({
    pointermove: 2,
    intersections: 1,
    mutations: 2,
    objectUrls: 1,
    hosts: 1,
    controls: 1,
  });
  expect(remounted.afterFinalRemove).toMatchObject({
    pointermove: 0,
    intersections: 0,
    mutations: 1,
    frames: 0,
    timers: 0,
    objectUrls: 0,
    hosts: 0,
    controls: 0,
  });
  expect(remounted.unhandled).toEqual([]);
});

test("active override cancellation releases its state channel", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    const handle = element.override({
      effect: { channels: ["state"], state: { state: "happy" } },
      until: { type: "manual", maxMs: 2_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.cancel();
    await handle.finished;
  });
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "idle",
  );
});

test("Web Component ready rejects initialization failure and cleans up", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundleSource });
  const result = await page.evaluate(async () => {
    const element = document.createElement("peekling-character");
    element.options = { format: 1, pack: { executable: true } };
    document.body.append(element);
    let name = "";
    try {
      await element.ready;
    } catch (error) {
      name = error.name;
    }
    return {
      name,
      instance: Boolean(element.instance),
      hosts: document.querySelectorAll("[data-peekling-host]").length,
      contents: document.querySelectorAll("aside[data-peekling-content]")
        .length,
    };
  });
  expect(result).toEqual({
    name: "PeeklingPreflightError",
    instance: false,
    hosts: 0,
    contents: 0,
  });
});

test("Web Component hostile options match hatch safety and recover on remount", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page);
  const result = await page.evaluate(async () => {
    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const original = document.querySelector("peekling-character");
    const valid = original.options;
    original.remove();
    await Promise.resolve();

    let topReads = 0;
    const topLevel = { ...valid };
    Object.defineProperty(topLevel, "plan", {
      enumerable: true,
      get() {
        topReads += 1;
        throw new Error("top-level getter executed");
      },
    });

    let nestedReads = 0;
    const nestedPlan = Object.create(null);
    Object.defineProperty(nestedPlan, "baseline", {
      enumerable: true,
      get() {
        nestedReads += 1;
        throw new Error("nested getter executed");
      },
    });
    const nested = { ...valid, plan: nestedPlan };
    const trapped = new Proxy(
      { ...valid },
      {
        ownKeys() {
          throw new Error("proxy ownKeys trap failed");
        },
      },
    );
    const inherited = Object.assign(Object.create({ scale: 9 }), valid);
    const crafted = Object.assign(Object.create(Object.create(null)), valid);
    const craftedPlan = Object.assign(
      Object.create(Object.create(null)),
      valid.plan,
    );
    const nestedCrafted = { ...valid, plan: craftedPlan };
    const malformed = [valid];
    const cases = [
      topLevel,
      nested,
      trapped,
      inherited,
      crafted,
      nestedCrafted,
      malformed,
    ];
    const hatchOutcomes = cases.slice(0, 6).map((options) => {
      try {
        window.Peekling.hatch(options);
        return "resolved";
      } catch (error) {
        return error.name;
      }
    });
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignOrdinary = frame.contentWindow.Object.create(
      frame.contentWindow.Object.prototype,
    );
    const foreignNull = frame.contentWindow.Object.create(null);
    Object.defineProperties(
      foreignOrdinary,
      Object.getOwnPropertyDescriptors(valid),
    );
    Object.defineProperties(
      foreignNull,
      Object.getOwnPropertyDescriptors(valid),
    );
    let foreignOrdinaryOutcome = "resolved";
    try {
      window.Peekling.hatch(foreignOrdinary);
    } catch (error) {
      foreignOrdinaryOutcome = error.name;
    }
    const foreignNullInstance = window.Peekling.hatch(foreignNull);
    await foreignNullInstance.ready;
    foreignNullInstance.destroy();
    frame.remove();
    const outcomes = [];

    for (const options of cases) {
      const element = document.createElement("peekling-character");
      let assignment = "accepted";
      try {
        element.options = options;
      } catch (error) {
        assignment = error.name;
      }
      document.body.append(element);
      let readiness = "resolved";
      try {
        await element.ready;
      } catch (error) {
        readiness = error.name;
      }
      const leakedAfterFailure = document.querySelectorAll(
        "[data-peekling-host]",
      ).length;
      element.options = valid;
      await element.ready;
      const recovered = Boolean(element.instance);
      element.remove();
      await Promise.resolve();
      outcomes.push({
        assignment,
        readiness,
        leakedAfterFailure,
        recovered,
        leakedAfterRemove: document.querySelectorAll("[data-peekling-host]")
          .length,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      hatchOutcomes,
      outcomes,
      crossRealm: {
        foreignOrdinaryOutcome,
        foreignNullAccepted: true,
      },
      topReads,
      nestedReads,
      unhandled,
    };
  });
  expect(result).toEqual({
    hatchOutcomes: Array.from({ length: 6 }, () => "OwnDataError"),
    outcomes: Array.from({ length: 7 }, () => ({
      assignment: "accepted",
      readiness: "OwnDataError",
      leakedAfterFailure: 0,
      recovered: true,
      leakedAfterRemove: 0,
    })),
    crossRealm: {
      foreignOrdinaryOutcome: "OwnDataError",
      foreignNullAccepted: true,
    },
    topReads: 0,
    nestedReads: 0,
    unhandled: [],
  });
  expect(pageErrors).toEqual([]);
});

test("built hatch and Web Component share bounded own-data failures", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page);

  const result = await page.evaluate(async () => {
    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const original = document.querySelector("peekling-character");
    const valid = original.options;
    original.remove();
    await Promise.resolve();

    let accessorReads = 0;
    let proxyReflections = 0;
    const create = (name) => {
      if (name === "accessor") {
        const input = { ...valid };
        Object.defineProperty(input, "extra", {
          enumerable: true,
          get() {
            accessorReads += 1;
            throw new Error("accessor executed");
          },
        });
        return input;
      }
      if (name === "proxy") {
        return new Proxy(
          { ...valid },
          {
            ownKeys() {
              proxyReflections += 1;
              throw new Error("reflection failed");
            },
          },
        );
      }
      if (name === "prototype") {
        return Object.assign(Object.create(Object.create(null)), valid);
      }
      if (name === "cycle") {
        const input = { ...valid };
        input.self = input;
        return input;
      }
      const input = { ...valid };
      let cursor = input;
      for (let index = 0; index < 33; index += 1) {
        cursor.next = {};
        cursor = cursor.next;
      }
      return input;
    };

    const outcomes = [];
    for (const name of ["accessor", "proxy", "prototype", "cycle", "depth"]) {
      let direct;
      try {
        window.Peekling.hatch(create(name));
        direct = { name: "resolved", message: "" };
      } catch (error) {
        direct = { name: error.name, message: error.message };
      }

      const element = document.createElement("peekling-character");
      element.options = create(name);
      document.body.append(element);
      let component;
      try {
        await element.ready;
        component = { name: "resolved", message: "" };
      } catch (error) {
        component = { name: error.name, message: error.message };
      }
      const rootsAfterFailure = document.querySelectorAll(
        "[data-peekling-host]",
      ).length;
      element.options = valid;
      await element.ready;
      const recovered = Boolean(element.instance);
      element.remove();
      await Promise.resolve();
      outcomes.push({
        name,
        direct,
        component,
        rootsAfterFailure,
        recovered,
      });
    }

    const nullPrototype = Object.assign(Object.create(null), valid);
    const safe = window.Peekling.hatch(nullPrototype);
    await safe.ready;
    safe.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      outcomes,
      accessorReads,
      proxyReflections,
      unhandled,
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
  });

  for (const outcome of result.outcomes) {
    expect(outcome.direct.name).toBe("OwnDataError");
    expect(outcome.component).toEqual(outcome.direct);
    expect(outcome.rootsAfterFailure).toBe(0);
    expect(outcome.recovered).toBe(true);
  }
  expect(result.accessorReads).toBe(0);
  expect(result.proxyReflections).toBe(2);
  expect(result.unhandled).toEqual([]);
  expect(result.roots).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("Web Component rejects explicit null options and recovers after valid reassignment", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("https://app.peekling.test/null-character.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        format: 1,
        name: "null-options-fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        metadata: { description: "Null options fixture" },
        assets: {
          atlas: {
            src: "null-atlas.png",
            sha256: cspPngSha256,
            columns: 16,
            rows: 2,
            logicalCellSize: 32,
            sourceCellSize: 32,
            density: 1,
          },
        },
        states: { idle: { frames: [1], fps: 1, loop: true } },
        defaults: { scale: 1 },
      }),
    }),
  );
  await page.route("https://app.peekling.test/null-atlas.png", (route) =>
    route.fulfill({ body: cspPng, contentType: "image/png" }),
  );
  await mount(page);

  const result = await page.evaluate(async () => {
    const original = document.querySelector("peekling-character");
    const valid = original.options;
    original.remove();
    await Promise.resolve();

    let hatch = "resolved";
    try {
      window.Peekling.hatch(null);
    } catch (error) {
      hatch = error.name;
    }

    const unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const element = document.createElement("peekling-character");
    element.setAttribute("pack-url", "/null-character.json");
    element.options = null;
    document.body.append(element);
    let readiness = "resolved";
    try {
      await element.ready;
    } catch (error) {
      readiness = error.name;
    }
    const rootsAfterFailure = document.querySelectorAll(
      "[data-peekling-host]",
    ).length;

    element.removeAttribute("pack-url");
    element.options = valid;
    await element.ready;
    const recovered = Boolean(element.instance);
    element.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      hatch,
      readiness,
      rootsAfterFailure,
      recovered,
      rootsAfterRemove: document.querySelectorAll("[data-peekling-host]")
        .length,
      unhandled,
    };
  });

  expect(result).toEqual({
    hatch: "TypeError",
    readiness: "OwnDataError",
    rootsAfterFailure: 0,
    recovered: true,
    rootsAfterRemove: 0,
    unhandled: [],
  });
  expect(pageErrors).toEqual([]);
});

test("pagehide ends direct hatch and persisted pageshow creates only fresh instances", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page, {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "page-start",
        when: { source: "browser", event: "page.lifecycle" },
        effect: {
          channels: ["state"],
          state: { state: "happy" },
        },
      },
    ],
  });
  const result = await page.evaluate(async () => {
    const transition = (type, persisted) => {
      const event = new Event(type);
      Object.defineProperty(event, "persisted", { value: persisted });
      return event;
    };
    const firstElement = document.querySelector("peekling-character");
    const options = firstElement.options;
    firstElement.remove();
    await Promise.resolve();

    const direct = window.Peekling.hatch(options);
    let pagehideSettlements = 0;
    void direct.finished.then(() => {
      pagehideSettlements += 1;
    });
    await direct.ready;
    const initialState = document
      .querySelector("[data-peekling-host]")
      ?.getAttribute("data-peekling-state");
    dispatchEvent(transition("pagehide", true));
    dispatchEvent(transition("pagehide", true));
    direct.destroy();
    const pagehideFinished = await direct.finished;
    await Promise.resolve();
    const afterHide = {
      emit: direct.emit("app.after-hide"),
      roots: document.querySelectorAll("[data-peekling-host]").length,
    };
    dispatchEvent(transition("pageshow", true));
    await Promise.resolve();
    const afterShowRoots = document.querySelectorAll(
      "[data-peekling-host]",
    ).length;

    const fresh = window.Peekling.hatch(options);
    let destroySettlements = 0;
    void fresh.finished.then(() => {
      destroySettlements += 1;
    });
    await fresh.ready;
    const freshState = document
      .querySelector("[data-peekling-host]")
      ?.getAttribute("data-peekling-state");
    fresh.destroy();
    fresh.destroy();
    const destroyFinished = await fresh.finished;
    await Promise.resolve();
    return {
      initialState,
      afterHide,
      afterShowRoots,
      freshState,
      pagehideFinished,
      pagehideSettlements,
      destroyFinished,
      destroySettlements,
    };
  });
  expect(result).toEqual({
    initialState: "happy",
    afterHide: {
      emit: { accepted: false, reason: "destroyed" },
      roots: 0,
    },
    afterShowRoots: 0,
    freshState: "happy",
    pagehideFinished: { reason: "pagehide" },
    pagehideSettlements: 1,
    destroyFinished: { reason: "destroyed" },
    destroySettlements: 1,
  });
  expect(pageErrors).toEqual([]);
});

test("a declarative element hatches a fresh instance after bfcache pageshow", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await mount(page);
  const result = await page.evaluate(async () => {
    const transition = (type, persisted) => {
      const event = new Event(type);
      Object.defineProperty(event, "persisted", { value: persisted });
      return event;
    };
    const element = document.querySelector("peekling-character");
    const first = element.instance;
    dispatchEvent(transition("pagehide", true));
    await Promise.resolve();
    const firstEnded = first.emit("app.after-hide");
    dispatchEvent(transition("pageshow", true));
    const second = await element.ready;
    const roots = document.querySelectorAll("[data-peekling-host]").length;
    element.remove();
    await Promise.resolve();
    return {
      firstEnded,
      fresh: second !== first,
      roots,
      rootsAfterRemove: document.querySelectorAll("[data-peekling-host]")
        .length,
    };
  });
  expect(result).toEqual({
    firstEnded: { accepted: false, reason: "destroyed" },
    fresh: true,
    roots: 1,
    rootsAfterRemove: 0,
  });
  expect(pageErrors).toEqual([]);
});

test("direct hatch contains asynchronous load failures and reports cleanup", async ({
  page,
}) => {
  await page.route("https://assets.peekling.test/missing.png", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.route("https://app.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.goto("https://app.peekling.test/");
  await page.addScriptTag({ content: bundleSource });
  const result = await page.evaluate(async () => {
    const unhandled = [];
    const diagnostics = [];
    window.addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const instance = window.Peekling.hatch({
      pack: {
        name: "failure-fixture",
        displayName: "Failure fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "missing.png",
          sha256: window.__peeklingFixtureHashes.transparent,
          columns: 1,
          rows: 1,
          cellWidth: 1,
          cellHeight: 1,
        },
        states: { idle: { frames: [0], fps: 1, loop: true } },
        defaultScale: 1,
      },
      atlasUrl: "https://assets.peekling.test/missing.png",
      diagnostics: { console: false },
      logger: (record) => {
        if (
          record.code === "config.pack-load-failed" ||
          record.code === "lifecycle.destroyed"
        ) {
          diagnostics.push(record.code);
        }
      },
    });
    let settlements = 0;
    void instance.finished.then(() => {
      settlements += 1;
    });
    await instance.ready.catch(() => {});
    const finished = await instance.finished;
    instance.destroy();
    await Promise.resolve();
    return {
      unhandled,
      diagnostics,
      finished,
      settlements,
      hosts: document.querySelectorAll("[data-peekling-host]").length,
      contents: document.querySelectorAll("aside[data-peekling-content]")
        .length,
    };
  });
  expect(result).toEqual({
    unhandled: [],
    diagnostics: ["config.pack-load-failed", "lifecycle.destroyed"],
    finished: { reason: "failed" },
    settlements: 1,
    hosts: 0,
    contents: 0,
  });
});

test("browser hatch reports unavailable Web Crypto as an integrity failure", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("https://crypto-unavailable.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.route(
    "https://crypto-unavailable.peekling.test/atlas.png",
    (route) =>
      route.fulfill({ body: transparentPng, contentType: "image/png" }),
  );
  await page.goto("https://crypto-unavailable.peekling.test/");
  await page.evaluate(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
  });
  await page.addScriptTag({ content: bundleSource });

  const result = await page.evaluate(async () => {
    const diagnostics = [];
    const unhandled = [];
    window.addEventListener("unhandledrejection", (event) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    });
    const instance = window.Peekling.hatch({
      pack: {
        name: "crypto-unavailable-fixture",
        displayName: "Crypto unavailable fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "atlas.png",
          sha256: window.__peeklingFixtureHashes.transparent,
          columns: 2,
          rows: 1,
          cellWidth: 1,
          cellHeight: 1,
          logicalWidth: 1,
          logicalHeight: 1,
          density: 1,
          variants: [
            {
              src: "atlas.png",
              density: 1,
              cellWidth: 1,
              cellHeight: 1,
              sha256: "0".repeat(64),
            },
          ],
        },
        states: { idle: { frames: [0], fps: 1, loop: true } },
        defaultScale: 1,
      },
      atlasUrl: "/atlas.png",
      density: 1,
      diagnostics: { console: false },
      logger: (record) => diagnostics.push(record.code),
    });
    let failure;
    try {
      await instance.ready;
    } catch (error) {
      failure = { name: error.name, message: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      failure,
      diagnostics,
      unhandled,
      hosts: document.querySelectorAll("[data-peekling-host]").length,
    };
  });

  expect(result.failure).toEqual({
    name: "PackValidationError",
    message: "pack:atlas.integrity-unavailable",
  });
  expect(result.diagnostics).toContain("config.pack-load-integrity");
  expect(result.diagnostics).toContain("config.pack-load-failed");
  expect(result.diagnostics).toContain("lifecycle.destroyed");
  expect(result.unhandled).toEqual([]);
  expect(result.hosts).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("destroy during pack loading treats the abort as lifecycle cleanup", async ({
  page,
}) => {
  let atlasRequested = false;
  await page.route("https://destroy-load.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.route(
    "https://destroy-load.peekling.test/atlas.png",
    async (route) => {
      atlasRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route
        .fulfill({ body: transparentPng, contentType: "image/png" })
        .catch(() => {});
    },
  );
  await page.goto("https://destroy-load.peekling.test/");
  await page.addScriptTag({ content: bundleSource });
  await page.evaluate(() => {
    window.destroyLoadDiagnostics = [];
    window.destroyLoadUnhandled = [];
    addEventListener("unhandledrejection", (event) => {
      window.destroyLoadUnhandled.push(String(event.reason));
      event.preventDefault();
    });
    window.destroyLoadInstance = window.Peekling.hatch({
      pack: {
        name: "destroy-load",
        displayName: "Destroy load",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "atlas.png",
          sha256: window.__peeklingFixtureHashes.transparent,
          columns: 2,
          rows: 1,
          cellWidth: 1,
          cellHeight: 1,
        },
        states: { idle: { frames: [0], fps: 1, loop: true } },
        defaultScale: 1,
      },
      atlasUrl: "/atlas.png",
      diagnostics: { console: false },
      logger: (record) => {
        window.destroyLoadDiagnostics.push({
          code: record.code,
          severity: record.severity,
        });
      },
    });
  });
  await expect.poll(() => atlasRequested).toBe(true);
  const result = await page.evaluate(async () => {
    const instance = window.destroyLoadInstance;
    instance.destroy();
    const outcome = await instance.ready.then(
      () => "resolved",
      (error) => error.name,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      outcome,
      diagnostics: window.destroyLoadDiagnostics,
      unhandled: window.destroyLoadUnhandled,
      hosts: document.querySelectorAll("[data-peekling-host]").length,
    };
  });
  expect(result.outcome).toBe("AbortError");
  expect(result.diagnostics).not.toContainEqual({
    code: "config.pack-load-failed",
    severity: "error",
  });
  expect(result.unhandled).toEqual([]);
  expect(result.hosts).toBe(0);
});

test("strict CSP supports browser hatch, declarative use, and host surfaces without inline script or style", async ({
  page,
}) => {
  let stylesheetRequests = 0;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("https://csp.peekling.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' https://styles.peekling.test; style-src-attr 'none'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'">
<script src="/observer.js"></script>
<script src="/peekling.min.js"></script>
<script src="/bootstrap.js" defer></script>
<body><peekling-character id="declarative" pack-url="/character.json" styles-url="/peekling.css" styles-integrity="${runtimeCssIntegrity}"></peekling-character></body>`,
    }),
  );
  await page.route("https://csp.peekling.test/observer.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.cspViolations=[];window.unhandled=[];document.addEventListener("securitypolicyviolation",event=>window.cspViolations.push({directive:event.violatedDirective,blocked:event.blockedURI}));window.addEventListener("unhandledrejection",event=>{window.unhandled.push(String(event.reason));event.preventDefault()});`,
    }),
  );
  await page.route("https://csp.peekling.test/peekling.min.js", (route) =>
    route.fulfill({ body: bundleSource, contentType: "text/javascript" }),
  );
  await page.route("https://csp.peekling.test/peekling.css", (route) => {
    stylesheetRequests += 1;
    return route.fulfill({ body: runtimeCss, contentType: "text/css" });
  });
  await page.route("https://styles.peekling.test/peekling.css", (route) => {
    stylesheetRequests += 1;
    return route.fulfill({
      body: runtimeCss,
      contentType: "text/css",
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.route("https://csp.peekling.test/bootstrap.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.cleanups=0;window.surfaceMounted=false;window.hatchInstance=Peekling.hatch({styles:{url:"https://styles.peekling.test/peekling.css",integrity:${JSON.stringify(runtimeCssIntegrity)}},pack:{name:"csp-hatch",displayName:"CSP hatch",version:"0.1.0",license:"CC0-1.0",atlas:{src:"atlas-hatch.png",sha256:${JSON.stringify(cspHatchPngSha256)},columns:16,rows:1,cellWidth:32,cellHeight:32},states:{idle:{frames:[0],fps:1,loop:true}},defaultScale:1},atlasUrl:"/atlas-hatch.png",plan:{baseline:{channels:["state","surface:status"],state:{state:"idle"},surfaces:[{id:"status",contentId:"status"}]}},content:{status:{"top-center":{mountId:"status"}}},bindings:{mounts:{status:({root})=>{const output=document.createElement("output");output.textContent="Strict CSP surface";root.append(output);window.surfaceMounted=output.textContent==="Strict CSP surface";return{cleanup(){window.cleanups+=1}}}}},diagnostics:{console:false}});window.hatchReady=Promise.all([window.hatchInstance.ready,document.querySelector("#declarative").ready]);`,
    }),
  );
  await page.route("https://csp.peekling.test/character.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        format: 1,
        name: "csp-declarative",
        version: "0.1.0",
        license: "CC0-1.0",
        metadata: { description: "Strict CSP declarative fixture" },
        assets: {
          atlas: {
            src: "atlas.png",
            sha256: cspPngSha256,
            columns: 16,
            rows: 2,
            logicalCellSize: 32,
            sourceCellSize: 32,
            density: 1,
          },
        },
        states: { idle: { frames: [1], fps: 1, loop: true } },
        defaults: { scale: 1 },
      }),
    }),
  );
  await page.route("https://csp.peekling.test/atlas.png", (route) =>
    route.fulfill({ body: cspPng, contentType: "image/png" }),
  );
  await page.route("https://csp.peekling.test/atlas-hatch.png", (route) =>
    route.fulfill({ body: cspHatchPng, contentType: "image/png" }),
  );
  await page.goto("https://csp.peekling.test/");
  await expect
    .poll(async () => ({
      ready: await page.evaluate(() => Boolean(window.hatchReady)),
      pageErrors,
    }))
    .toEqual({ ready: true, pageErrors: [] });
  await page.evaluate(() => window.hatchReady);
  await expect(page.locator("[data-peekling-host]")).toHaveCount(2);
  const result = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const host = document.querySelector("[data-peekling-host]");
    const hostPosition = getComputedStyle(host).position;
    window.hatchInstance.destroy();
    document.querySelector("#declarative").remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      violations: window.cspViolations,
      unhandled: window.unhandled,
      surfaceMounted: window.surfaceMounted,
      hostPosition,
      cleanups: window.cleanups,
      remainingHosts: document.querySelectorAll("[data-peekling-host]").length,
    };
  });
  expect(stylesheetRequests).toBeGreaterThanOrEqual(1);
  expect(result).toEqual({
    violations: [],
    unhandled: [],
    surfaceMounted: true,
    hostPosition: "fixed",
    cleanups: 1,
    remainingHosts: 0,
  });
});

test("a blocked external stylesheet rejects readiness with cleanup and no unhandled rejection", async ({
  page,
}) => {
  await page.route("https://csp-failure.peekling.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; connect-src 'self'; img-src 'self' blob:; object-src 'none'">
<script src="/observer.js"></script>
<script src="/peekling.min.js"></script>
<script src="/bootstrap.js" defer></script>
<body></body>`,
    }),
  );
  await page.route("https://csp-failure.peekling.test/observer.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.unhandled=[];addEventListener("unhandledrejection",event=>{window.unhandled.push(String(event.reason));event.preventDefault()});`,
    }),
  );
  await page.route(
    "https://csp-failure.peekling.test/peekling.min.js",
    (route) =>
      route.fulfill({ body: bundleSource, contentType: "text/javascript" }),
  );
  await page.route("https://csp-failure.peekling.test/peekling.css", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await page.route("https://csp-failure.peekling.test/atlas.png", (route) =>
    route.fulfill({ body: transparentPng, contentType: "image/png" }),
  );
  await page.route("https://csp-failure.peekling.test/bootstrap.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.diagnostics=[];const instance=Peekling.hatch({pack:{name:"style-failure",displayName:"Style failure",version:"0.1.0",license:"CC0-1.0",atlas:{src:"atlas.png",sha256:${JSON.stringify(transparentPngSha256)},columns:2,rows:1,cellWidth:1,cellHeight:1},states:{idle:{frames:[0],fps:1,loop:true}},defaultScale:1},atlasUrl:"/atlas.png",diagnostics:{console:false},logger:record=>window.diagnostics.push(record.code)});window.styleFailure=instance.ready.then(()=>"resolved",error=>error.name);`,
    }),
  );
  await page.goto("https://csp-failure.peekling.test/");
  await page.waitForFunction(() => Boolean(window.styleFailure));
  const result = await page.evaluate(async () => {
    const name = await window.styleFailure;
    await Promise.resolve();
    return {
      name,
      diagnostics: window.diagnostics,
      unhandled: window.unhandled,
      hosts: document.querySelectorAll("[data-peekling-host]").length,
      controls: document.querySelectorAll("[data-peekling-controls]").length,
    };
  });
  expect(result.name).toBe("Error");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      "config.styles-load-failed",
      "lifecycle.destroyed",
    ]),
  );
  expect(result.unhandled).toEqual([]);
  expect(result.hosts).toBe(0);
  expect(result.controls).toBe(0);
});

test("destroy while an external stylesheet is pending settles readiness and cleans up", async ({
  page,
}) => {
  let styleRequested = false;
  await page.route("https://style-pending.peekling.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.route(
    "https://style-pending.peekling.test/pending.css",
    async (route) => {
      styleRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ body: runtimeCss, contentType: "text/css" });
    },
  );
  await page.route("https://style-pending.peekling.test/atlas.png", (route) =>
    route.fulfill({ body: transparentPng, contentType: "image/png" }),
  );
  await page.goto("https://style-pending.peekling.test/");
  await page.addScriptTag({ content: bundleSource });
  await page.evaluate(() => {
    window.unhandled = [];
    addEventListener("unhandledrejection", (event) => {
      window.unhandled.push(String(event.reason));
      event.preventDefault();
    });
    window.pendingStyleInstance = window.Peekling.hatch({
      styles: { url: "/pending.css" },
      pack: {
        name: "pending-style",
        displayName: "Pending style",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: "atlas.png",
          sha256: window.__peeklingFixtureHashes.transparent,
          columns: 2,
          rows: 1,
          cellWidth: 1,
          cellHeight: 1,
        },
        states: { idle: { frames: [0], fps: 1, loop: true } },
        defaultScale: 1,
      },
      atlasUrl: "/atlas.png",
      diagnostics: { console: false },
    });
  });
  await expect.poll(() => styleRequested).toBe(true);
  await page.waitForTimeout(100);
  const result = await page.evaluate(async () => {
    const instance = window.pendingStyleInstance;
    instance.destroy();
    const outcome = await Promise.race([
      instance.ready.then(
        () => "resolved",
        (error) => error.name,
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);
    return {
      outcome,
      unhandled: window.unhandled,
      hosts: document.querySelectorAll("[data-peekling-host]").length,
      controls: document.querySelectorAll("[data-peekling-controls]").length,
    };
  });
  expect(result).toEqual({
    outcome: "AbortError",
    unhandled: [],
    hosts: 0,
    controls: 0,
  });
});

test("reduced motion keeps the tableau while a motion override expires", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, {
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
    ],
  });
  const reason = await page.evaluate(async () => {
    const element = document.querySelector("peekling-character");
    const handle = element.override({
      effect: {
        channels: ["motion"],
        motion: { type: "follow-pointer", speed: 100 },
      },
      until: { type: "duration", ms: 100 },
    });
    return (await handle.finished).reason;
  });
  expect(reason).toBe("timeout");
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-state",
    "idle",
  );
  const frame = await page
    .locator("[data-peekling-host]")
    .getAttribute("data-peekling-frame");
  const observedFrames = await page.evaluate(async () => {
    const frames = [];
    for (let index = 0; index < 10; index++) {
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 100 + index,
          clientY: 100,
          pointerType: "mouse",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      frames.push(
        document
          .querySelector("[data-peekling-host]")
          ?.getAttribute("data-peekling-frame"),
      );
    }
    return [...new Set(frames)];
  });
  expect(observedFrames).toEqual([frame]);
  await expect(page.locator("[data-peekling-host]")).toHaveAttribute(
    "data-peekling-frame",
    frame,
  );
});
