const listenerEntries = [];
const nativeAdd = EventTarget.prototype.addEventListener;
const nativeRemove = EventTarget.prototype.removeEventListener;
EventTarget.prototype.addEventListener = function (type, listener, options) {
  if ((this === document || this === window) && listener) {
    const present = listenerEntries.some(
      (entry) =>
        entry.target === this &&
        entry.type === type &&
        entry.listener === listener,
    );
    if (!present) listenerEntries.push({ target: this, type, listener });
  }
  return nativeAdd.call(this, type, listener, options);
};
EventTarget.prototype.removeEventListener = function (type, listener, options) {
  const index = listenerEntries.findIndex(
    (entry) =>
      entry.target === this &&
      entry.type === type &&
      entry.listener === listener,
  );
  if (index >= 0) listenerEntries.splice(index, 1);
  return nativeRemove.call(this, type, listener, options);
};

const NativeIntersectionObserver = window.IntersectionObserver;
const NativeMutationObserver = window.MutationObserver;
let activeIntersections = 0;
let activeMutations = 0;
window.IntersectionObserver = class {
  #active = true;
  #inner;
  constructor(callback, options) {
    activeIntersections += 1;
    this.#inner = new NativeIntersectionObserver(callback, options);
  }
  observe(target) {
    if (!this.#active) activeIntersections += 1;
    this.#active = true;
    this.#inner.observe(target);
  }
  unobserve(target) {
    this.#inner.unobserve(target);
  }
  disconnect() {
    if (this.#active) activeIntersections -= 1;
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
    if (!this.#active) activeMutations += 1;
    this.#active = true;
    this.#inner.observe(target, options);
  }
  disconnect() {
    if (this.#active) activeMutations -= 1;
    this.#active = false;
    this.#inner.disconnect();
  }
  takeRecords() {
    return this.#inner.takeRecords();
  }
};

const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
const activeFrames = new Set();
window.requestAnimationFrame = (callback) => {
  let id = 0;
  id = nativeRaf((time) => {
    activeFrames.delete(id);
    callback(time);
  });
  activeFrames.add(id);
  return id;
};
window.cancelAnimationFrame = (id) => {
  activeFrames.delete(id);
  nativeCancelRaf(id);
};

const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const activeTimers = new Set();
window.setTimeout = (callback, delay, ...args) => {
  let id = 0;
  id = nativeSetTimeout(() => {
    activeTimers.delete(id);
    callback(...args);
  }, delay);
  activeTimers.add(id);
  return id;
};
window.clearTimeout = (id) => {
  activeTimers.delete(id);
  nativeClearTimeout(id);
};

const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
const activeObjectUrls = new Set();
URL.createObjectURL = (value) => {
  const url = nativeCreateObjectURL(value);
  activeObjectUrls.add(url);
  return url;
};
URL.revokeObjectURL = (url) => {
  activeObjectUrls.delete(url);
  nativeRevokeObjectURL(url);
};

const diagnostics = [];
const mountState = {
  goodCleanups: 0,
  goodUpdates: 0,
  pendingAborted: false,
  controllerAccessorReads: 0,
  controllerProxyReflections: 0,
};

const pack = {
  name: "hostile-fixture",
  displayName: "Hostile fixture",
  version: "0.1.0",
  license: "CC0-1.0",
  atlas: {
    src: "atlas.png",
    sha256: "__PEEKLING_FIXTURE_ATLAS_SHA256__",
    columns: 2,
    rows: 1,
    cellWidth: 1,
    cellHeight: 1,
  },
  states: {
    idle: { frames: [0], fps: 1, loop: true },
    move: { frames: [1], fps: 1, loop: true },
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
};

const plan = {
  baseline: {
    channels: [
      "state",
      "surface:good",
      "surface:bad",
      "surface:pending",
      "surface:accessor",
      "surface:proxy",
    ],
    state: { state: "idle" },
    surfaces: [
      { id: "good", contentId: "good" },
      { id: "bad", contentId: "bad" },
      { id: "pending", contentId: "pending" },
      { id: "accessor", contentId: "accessor" },
      { id: "proxy", contentId: "proxy" },
    ],
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
      id: "watch-main",
      when: {
        source: "browser",
        event: "section.visibility",
        selector: "#main",
        phase: "while-visible",
      },
      effect: { channels: ["state"], state: { state: "idle" } },
    },
  ],
};

const baseOptions = {
  format: 1,
  pack,
  atlasUrl: "/atlas.png",
  position: "bottom-left",
  styles: { url: "/peekling.css" },
  plan,
  content: {
    good: { "top-center": { mountId: "good" } },
    bad: { "top-left": { mountId: "bad" } },
    pending: { "top-right": { mountId: "pending" } },
    accessor: { "top-left": { mountId: "accessor" } },
    proxy: { bottom: { mountId: "proxy" } },
  },
  bindings: {
    mounts: {
      good({ root }) {
        const output = document.createElement("output");
        output.textContent = "Good surface";
        root.append(output);
        return {
          update() {
            mountState.goodUpdates += 1;
          },
          cleanup() {
            mountState.goodCleanups += 1;
          },
        };
      },
      bad() {
        throw new Error("fixture mount failure");
      },
      pending({ signal }) {
        signal.addEventListener(
          "abort",
          () => {
            mountState.pendingAborted = true;
          },
          { once: true },
        );
        return new Promise(() => {});
      },
      accessor() {
        const controller = Object.create(null);
        Object.defineProperty(controller, "cleanup", {
          enumerable: true,
          get() {
            mountState.controllerAccessorReads += 1;
            throw new Error("fixture controller accessor executed");
          },
        });
        return controller;
      },
      proxy() {
        return new Proxy(
          {},
          {
            ownKeys() {
              mountState.controllerProxyReflections += 1;
              throw new Error("fixture controller reflection failed");
            },
          },
        );
      },
    },
  },
  logger(record) {
    diagnostics.push({ code: record.code, severity: record.severity });
  },
  diagnostics: { console: false },
};

const primary = Peekling.hatch(baseOptions);
const secondary = Peekling.hatch({
  format: 1,
  pack,
  atlasUrl: "/atlas.png",
  styles: { url: "/peekling.css" },
  plan: {
    baseline: { channels: ["state"], state: { state: "idle" } },
    rules: [plan.rules[0]],
  },
  diagnostics: { console: false },
});

const ready = Promise.all([primary.ready, secondary.ready]);

function snapshot() {
  return {
    listeners: listenerEntries.length,
    pointerListeners: listenerEntries.filter(
      (entry) => entry.type === "pointermove",
    ).length,
    intersections: activeIntersections,
    mutations: activeMutations,
    frames: activeFrames.size,
    timers: activeTimers.size,
    objectUrls: activeObjectUrls.size,
    characters: document.querySelectorAll("[data-peekling-host]").length,
    contentHosts: document.querySelectorAll("[data-peekling-content]").length,
    controls: document.querySelectorAll("[data-peekling-controls]").length,
    diagnostics: [...diagnostics],
    mountState: { ...mountState },
  };
}

async function storm(count = 500) {
  for (let index = 0; index < count; index += 1) {
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 40 + (index % 700),
        clientY: 40 + (index % 500),
        pointerType: "mouse",
      }),
    );
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event(index % 2 ? "focus" : "blur"));
    if (index % 20 === 0) {
      const node = document.createElement("span");
      node.textContent = "mutation";
      document.querySelector("#mutation-target").replaceChildren(node);
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function cycle(count = 20) {
  await settleRuntime();
  const before = snapshot();
  for (let index = 0; index < count; index += 1) {
    primary.pause();
    primary.pause();
    primary.resume();
    primary.resume();
    Peekling.visibility.hide("session");
    Peekling.visibility.show();
    const temporary = Peekling.hatch({
      format: 1,
      pack,
      atlasUrl: "/atlas.png",
      styles: { url: "/peekling.css" },
      diagnostics: { console: false },
    });
    await temporary.ready;
    temporary.destroy();
    temporary.destroy();
  }
  await settleRuntime();
  return { before, after: snapshot() };
}

async function settleRuntime() {
  await new Promise((resolve) => nativeSetTimeout(resolve, 100));
}

function removeOwnedRoots() {
  const selector =
    "[data-peekling-host],[data-peekling-content],[data-peekling-controls]";
  const roots = [...document.querySelectorAll(selector)];
  const removed = {
    characters: roots.filter((node) => node.hasAttribute("data-peekling-host"))
      .length,
    contentHosts: roots.filter((node) =>
      node.hasAttribute("data-peekling-content"),
    ).length,
    controls: roots.filter((node) =>
      node.hasAttribute("data-peekling-controls"),
    ).length,
  };
  roots.forEach((node) => node.remove());
  return {
    removed,
    remaining: document.querySelectorAll(selector).length,
  };
}

function reparentAndStripOwnedRoots() {
  const container = document.querySelector("#main");
  const roots = [
    ...document.querySelectorAll(
      "[data-peekling-host],[data-peekling-content],[data-peekling-controls]",
    ),
  ];
  for (const root of roots) {
    if (root.hasAttribute("data-peekling-host"))
      root.removeAttribute("data-peekling-host");
    root.removeAttribute("aria-hidden");
    if (root.hasAttribute("data-peekling-content"))
      root.removeAttribute("data-peekling-content");
    root.removeAttribute("aria-label");
    if (root.hasAttribute("data-peekling-controls"))
      root.removeAttribute("data-peekling-controls");
    container.append(root);
  }
  return roots.length;
}

function adoptPrimaryContentRoot() {
  const root = document.querySelector("[data-peekling-content]");
  const foreignDocument = document.implementation.createHTMLDocument("foreign");
  foreignDocument.body.append(foreignDocument.adoptNode(root));
  return root.ownerDocument === foreignDocument;
}

function adoptVisibilityRoot() {
  const root = document.querySelector("[data-peekling-controls]");
  const foreignDocument = document.implementation.createHTMLDocument("foreign");
  foreignDocument.body.append(foreignDocument.adoptNode(root));
  return root.ownerDocument === foreignDocument;
}

function breakPrimaryFrame() {
  const root = [...document.querySelectorAll("[data-peekling-host]")].sort(
    (left, right) =>
      Number(left.dataset.peeklingX) - Number(right.dataset.peeklingX),
  )[0];
  const original = root.setAttribute.bind(root);
  Object.defineProperty(root, "setAttribute", {
    configurable: true,
    value(name, value) {
      if (name === "data-peekling-x") throw new Error("fixture frame failure");
      return original(name, value);
    },
  });
}

function openDialog() {
  document.querySelector("#host-dialog").showModal();
}

function closeDialog() {
  document.querySelector("#host-dialog").close();
}

function destroy() {
  primary.destroy();
  secondary.destroy();
}

window.hostileHarness = Object.freeze({
  ready,
  primary,
  secondary,
  snapshot,
  storm,
  cycle,
  removeOwnedRoots,
  reparentAndStripOwnedRoots,
  adoptPrimaryContentRoot,
  adoptVisibilityRoot,
  breakPrimaryFrame,
  openDialog,
  closeDialog,
  destroy,
});
