import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const bundleSource = await readFile(
  process.env.PEEKLING_REVIEW_BUNDLE ??
    path.resolve("packages/runtime/dist/peekling.min.js"),
  "utf8",
);
const runtimeCss = await readFile(
  process.env.PEEKLING_REVIEW_CSS ??
    path.resolve("packages/runtime/dist/peekling.css"),
  "utf8",
).catch(() =>
  readFile(path.resolve("packages/runtime/src/peekling.css"), "utf8"),
);
const runtimeCssIntegrity = `sha256-${createHash("sha256").update(runtimeCss).digest("base64")}`;
const atlas = PNG.sync.write(new PNG({ width: 1, height: 1 }));
const atlasSha256 = createHash("sha256").update(atlas).digest("hex");

test.beforeEach(async ({ page }) => {
  await page.route("https://review.peekling.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.route("**/peekling.css", (route) =>
    route.fulfill({ body: runtimeCss, contentType: "text/css" }),
  );
  await page.route("**/peekling-alt.css", (route) =>
    route.fulfill({ body: runtimeCss, contentType: "text/css" }),
  );
  await page.route("**/atlas.png", (route) =>
    route.fulfill({
      body: atlas,
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.goto("https://review.peekling.test/");
  await page.addScriptTag({ content: bundleSource });
});

function hatchInput() {
  return {
    format: 1,
    pack: {
      name: "review-host",
      displayName: "Review host",
      version: "0.1.0",
      license: "CC0-1.0",
      atlas: {
        src: "atlas.png",
        sha256: atlasSha256,
        columns: 1,
        rows: 1,
        cellWidth: 1,
        cellHeight: 1,
      },
      states: { idle: { frames: [0], fps: 1, loop: true } },
      defaultScale: 1,
    },
    atlasUrl: "https://review.peekling.test/atlas.png",
    styles: { url: "https://review.peekling.test/peekling.css" },
    plan: {
      baseline: { channels: ["state"], state: { state: "idle" } },
    },
    diagnostics: { console: false },
  };
}

test("invalid section selectors reject readiness before Pack network work", async ({
  page,
}) => {
  let atlasRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/atlas.png")) atlasRequests++;
  });

  const result = await page.evaluate(async (input) => {
    let instance;
    let synchronous = false;
    try {
      instance = Peekling.hatch({
        ...input,
        plan: {
          ...input.plan,
          rules: [
            {
              id: "invalid-section-selector",
              when: {
                source: "browser",
                event: "section.visibility",
                selector: "foo>>>",
                phase: "enter",
              },
              effect: {
                channels: ["state"],
                state: { state: "idle" },
              },
            },
          ],
        },
      });
    } catch {
      synchronous = true;
    }
    if (!instance) return { synchronous };
    const failure = await instance.ready.then(
      () => ({ resolved: true }),
      (error) => ({
        resolved: false,
        name: error?.name,
        code: error?.code,
        message: String(error),
      }),
    );
    return {
      synchronous,
      failure,
      finished: await instance.finished,
    };
  }, hatchInput());

  expect(result.synchronous).toBe(false);
  expect(result.failure).toMatchObject({
    resolved: false,
    name: "PlanCompileError",
    code: "invalid-selector",
  });
  expect(result.failure.message).toContain("invalid-selector");
  expect(result.finished).toEqual({ reason: "failed" });
  expect(atlasRequests).toBe(0);
});

test("pre-ready event and override warnings are latched per instance", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const codes = [];
    const instance = Peekling.hatch({
      ...input,
      logger: (record) => codes.push(record.code),
    });
    const events = Array.from({ length: 20 }, (_, index) =>
      instance.emit("review.pending", { index }),
    );
    const overrides = Array.from({ length: 20 }, () =>
      instance.override({
        effect: { channels: ["state"], state: { state: "idle" } },
      }),
    );
    instance.destroy();
    await instance.ready.catch(() => {});
    await instance.finished;
    return {
      codes,
      events,
      overrideReasons: (
        await Promise.all(overrides.map((override) => override.finished))
      ).map((completion) => completion.reason),
    };
  }, hatchInput());

  expect(result.events).toEqual(
    Array.from({ length: 20 }, () => ({
      accepted: false,
      reason: "not-ready",
    })),
  );
  expect(result.overrideReasons).toEqual(
    Array.from({ length: 20 }, () => "rejected"),
  );
  expect(
    result.codes.filter((code) => code === "event.rejected.not-ready"),
  ).toHaveLength(1);
  expect(
    result.codes.filter((code) => code === "override.not-ready"),
  ).toHaveLength(1);
});

test("visibility interactions stay on the configured document", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const targetDocument = frame.contentDocument;
    const targetWindow = frame.contentWindow;
    const tracked = new Set([
      "pointermove",
      "pointerdown",
      "pointerup",
      "pointercancel",
      "pointerout",
      "keydown",
    ]);
    const seen = { host: [], target: [] };
    const capture = (owner, documentTarget) => {
      const original = documentTarget.addEventListener.bind(documentTarget);
      documentTarget.addEventListener = (type, listener, options) => {
        if (tracked.has(type)) seen[owner].push(type);
        return original(type, listener, options);
      };
    };
    capture("host", document);
    capture("target", targetDocument);
    const instance = Peekling.hatch({
      ...input,
      document: targetDocument,
      window: targetWindow,
    });
    await instance.ready;
    instance.destroy();
    frame.remove();
    return seen;
  }, hatchInput());

  expect(result.host).toEqual([]);
  expect(result.target.sort()).toEqual(
    [
      "keydown",
      "pointercancel",
      "pointerdown",
      "pointermove",
      "pointerout",
      "pointerup",
    ].sort(),
  );
});

test("a canceled touch drag falls instead of remaining suspended", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const roots = [];
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = attachShadow.call(this, options);
      roots.push(root);
      return root;
    };
    const state = { frames: [0], fps: 1, loop: true };
    const instance = Peekling.hatch({
      ...input,
      position: { x: 80, y: 80 },
      pack: {
        ...input.pack,
        states: {
          idle: state,
          "scroll:fly": state,
          "scroll:fall": state,
          success: state,
        },
      },
      interaction: { drag: true, throw: true, gravity: 1_600 },
    });
    await instance.ready;
    const control = roots
      .map((root) => root.querySelector(".peekling-character-hit"))
      .find(Boolean);
    if (!control)
      throw new Error("Character interaction control was not mounted");
    const pointer = (type, x, y) =>
      control.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
          clientX: x,
          clientY: y,
          isPrimary: true,
          pointerId: 7,
          pointerType: "touch",
        }),
      );
    pointer("pointerdown", 80, 80);
    pointer("pointermove", 120, 140);
    pointer("pointercancel", 120, 140);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const host = document.querySelector("[data-peekling-host]");
    const first = {
      state: host.getAttribute("data-peekling-state"),
      y: Number(host.getAttribute("data-peekling-y")),
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = {
      state: host.getAttribute("data-peekling-state"),
      y: Number(host.getAttribute("data-peekling-y")),
    };
    instance.destroy();
    return { first, second };
  }, hatchInput());

  expect(result.second.state).toBe("scroll:fall");
  expect(result.second.y).toBeGreaterThan(result.first.y);
});

test("a timed dismissal refreshes when its stored deadline expires", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const scheduled = [];
    window.setTimeout = (callback, delay = 0, ...args) => {
      if (Number(delay) >= 60_000) {
        const id = 90_000 + scheduled.length;
        scheduled.push({ callback, delay: Number(delay), id, args });
        return id;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    const instance = Peekling.hatch(input);
    await instance.ready;
    Peekling.visibility.hide("10-minutes");
    const hiddenBefore = Peekling.visibility.isHidden();
    const stored = JSON.parse(localStorage.getItem("peekling:site-preference"));
    stored.until = Date.now() - 1;
    localStorage.setItem("peekling:site-preference", JSON.stringify(stored));
    scheduled[0]?.callback(...scheduled[0].args);
    await Promise.resolve();
    const hiddenAfter = Peekling.visibility.isHidden();
    instance.destroy();
    return {
      delays: scheduled.map(({ delay }) => delay),
      hiddenBefore,
      hiddenAfter,
    };
  }, hatchInput());

  expect(result.hiddenBefore).toBe(true);
  expect(result.delays).toHaveLength(1);
  expect(result.delays[0]).toBeGreaterThan(0);
  expect(result.hiddenAfter).toBe(false);
});

test("a timed dismissal owns one recovery wake when storage is unavailable", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const longTimers = new Map();
    let nextTimer = 90_000;
    window.setTimeout = (callback, delay = 0, ...args) => {
      if (Number(delay) >= 60_000) {
        const id = nextTimer++;
        longTimers.set(id, { callback, args });
        return id;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = (id) => {
      if (!longTimers.delete(id)) nativeClearTimeout(id);
    };
    for (const method of ["getItem", "setItem", "removeItem"]) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value() {
          throw new DOMException("Storage unavailable", "SecurityError");
        },
      });
    }

    const instance = Peekling.hatch(input);
    await instance.ready;
    Peekling.visibility.hide("10-minutes");
    const hidden = {
      activeTimers: longTimers.size,
      helper: Peekling.visibility.isHidden(),
      admission: instance.emit("review.while-hidden", {}).reason,
    };

    Peekling.visibility.show();
    const shown = {
      activeTimers: longTimers.size,
      helper: Peekling.visibility.isHidden(),
    };

    Peekling.visibility.hide("10-minutes");
    const [timerId, timer] = longTimers.entries().next().value;
    longTimers.delete(timerId);
    timer.callback(...timer.args);
    await Promise.resolve();
    const expired = {
      activeTimers: longTimers.size,
      helper: Peekling.visibility.isHidden(),
      admission: instance.emit("review.after-expiry", {}).accepted,
    };

    Peekling.visibility.hide("10-minutes");
    instance.destroy();
    return {
      hidden,
      shown,
      expired,
      activeTimersAfterDestroy: longTimers.size,
    };
  }, hatchInput());

  expect(result).toEqual({
    hidden: {
      activeTimers: 1,
      helper: true,
      admission: "hidden",
    },
    shown: { activeTimers: 0, helper: false },
    expired: { activeTimers: 0, helper: false, admission: true },
    activeTimersAfterDestroy: 0,
  });
});

test("shared visibility controls reject a conflicting stylesheet asset", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const first = Peekling.hatch(input);
    await first.ready;
    let message = "";
    try {
      Peekling.hatch({
        ...input,
        styles: { url: "https://review.peekling.test/peekling-alt.css" },
      });
    } catch (error) {
      message = String(error);
    }
    const accepted = first.emit("review.still-alive", { value: 1 });
    first.destroy();
    return { message, accepted };
  }, hatchInput());

  expect(result.message).toContain("visibility.styles-conflict");
  expect(result.accepted.accepted).toBe(true);
});

test("shared visibility controls accept alternate URLs with identical SRI", async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ input, integrity }) => {
      const first = Peekling.hatch({
        ...input,
        styles: { ...input.styles, integrity },
      });
      await first.ready;
      const second = Peekling.hatch({
        ...input,
        styles: {
          url: "https://review.peekling.test/peekling-alt.css",
          integrity,
        },
      });
      await second.ready;
      const accepted = second.emit("review.still-alive", { value: 1 });
      first.destroy();
      second.destroy();
      return accepted;
    },
    { input: hatchInput(), integrity: runtimeCssIntegrity },
  );

  expect(result.accepted).toBe(true);
});

test("removed content surfaces release their dynamic CSS rules", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const originalInsert = CSSStyleSheet.prototype.insertRule;
    const originalDelete = CSSStyleSheet.prototype.deleteRule;
    let inserted = 0;
    let deleted = 0;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      if (String(rule).includes("peekling-position-")) inserted++;
      return originalInsert.call(this, rule, index);
    };
    CSSStyleSheet.prototype.deleteRule = function (index) {
      const rule = this.cssRules[index];
      if (rule?.cssText.includes("peekling-position-")) deleted++;
      return originalDelete.call(this, index);
    };
    const instance = Peekling.hatch({
      ...input,
      content: { notice: { "top-center": "Working" } },
      plan: {
        baseline: {
          channels: ["state", "surface:notice"],
          state: { state: "idle" },
          surfaces: [{ id: "notice", contentId: "notice" }],
        },
      },
    });
    await instance.ready;
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    instance.destroy();
    return { inserted, deleted };
  }, hatchInput());

  expect(result.inserted).toBeGreaterThanOrEqual(1);
  expect(result.deleted).toBe(result.inserted);
});

test("surface geometry reads precede character writes and stable frames reuse layout", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const rect = Element.prototype.getBoundingClientRect;
    const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (!text?.set) return { supported: false };
    const setAttribute = Element.prototype.setAttribute;
    const trace = [];
    let rectReads = 0;
    let textWrites = 0;
    Element.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute?.("data-peekling-surface")) {
        rectReads++;
        trace.push("surface-read");
      }
      return rect.call(this);
    };
    Element.prototype.setAttribute = function (name, value) {
      if (
        this.hasAttribute?.("data-peekling-host") &&
        (name === "data-peekling-x" || name === "data-peekling-y")
      ) {
        trace.push("character-write");
      }
      return setAttribute.call(this, name, value);
    };
    Object.defineProperty(Node.prototype, "textContent", {
      ...text,
      set(value) {
        if (this instanceof HTMLElement && this.closest?.(".surface")) {
          textWrites++;
        }
        return text.set.call(this, value);
      },
    });
    const instance = Peekling.hatch({
      ...input,
      pack: {
        ...input.pack,
        states: {
          idle: { frames: [0, 0], fps: 60, loop: true },
        },
      },
      content: {
        first: { "top-left": "First" },
        second: { "top-right": "Second" },
        changed: { "top-left": "Changed" },
      },
      plan: {
        baseline: {
          channels: ["state", "surface:first", "surface:second"],
          state: { state: "idle" },
          surfaces: [
            { id: "first", contentId: "first" },
            { id: "second", contentId: "second" },
          ],
        },
        rules: [
          {
            id: "refresh-first",
            when: { source: "application", event: "review.tick" },
            effect: {
              channels: ["surface:first"],
              surfaces: [
                {
                  id: "first",
                  contentId: "changed",
                  disposition: "replace",
                },
              ],
            },
          },
        ],
      },
    });
    await instance.ready;
    for (let turn = 0; turn < 10 && rectReads === 0; turn++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    const firstRead = trace.indexOf("surface-read");
    const firstWrite = trace.indexOf("character-write");
    rectReads = 0;
    textWrites = 0;
    for (let turn = 0; turn < 12; turn++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    const stableRectReads = rectReads;
    const stableTextWrites = textWrites;
    rectReads = 0;
    instance.emit("review.tick");
    for (let turn = 0; turn < 10 && rectReads === 0; turn++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    for (let turn = 0; turn < 4; turn++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    const changedRectReads = rectReads;
    instance.destroy();
    return {
      supported: true,
      firstRead,
      firstWrite,
      stableRectReads,
      stableTextWrites,
      changedRectReads,
    };
  }, hatchInput());

  expect(result.supported).toBe(true);
  expect(result.firstRead).toBeGreaterThanOrEqual(0);
  expect(result.firstWrite).toBeGreaterThanOrEqual(0);
  expect(result.firstRead).toBeLessThan(result.firstWrite);
  expect(result.stableRectReads).toBe(0);
  expect(result.stableTextWrites).toBe(0);
  expect(result.changedRectReads).toBe(1);
});

test("the internal name surface cannot shadow a host content id", async ({
  page,
}) => {
  const mounts = await page.evaluate(async (input) => {
    let mounted = 0;
    const instance = Peekling.hatch({
      ...input,
      name: "Moss",
      content: {
        "peekling-name": {
          "top-center": { mountId: "host-name" },
        },
      },
      bindings: {
        mounts: {
          "host-name": ({ root }) => {
            mounted++;
            const output = document.createElement("output");
            output.textContent = "Host-owned content";
            root.append(output);
            return { cleanup: () => output.remove() };
          },
        },
      },
      plan: {
        baseline: {
          channels: ["state", "surface:host-name"],
          state: { state: "idle" },
          surfaces: [{ id: "host-name", contentId: "peekling-name" }],
        },
      },
    });
    await instance.ready;
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    instance.destroy();
    return mounted;
  }, hatchInput());

  expect(mounts).toBe(1);
});

test("Web Component ready captured before connection follows the first mount", async ({
  page,
}) => {
  const result = await page.evaluate(async (input) => {
    const element = document.createElement("peekling-character");
    element.options = input;
    const beforeConnection = element.ready;
    document.body.append(element);
    const first = await beforeConnection.then(
      (instance) => ({ resolved: true, instance }),
      (error) => ({ resolved: false, message: String(error) }),
    );
    const current = await element.ready;
    const same = first.resolved && first.instance === current;
    element.remove();
    return {
      resolved: first.resolved,
      message: first.resolved ? "" : first.message,
      same,
    };
  }, hatchInput());

  expect(result).toEqual({ resolved: true, message: "", same: true });
});
