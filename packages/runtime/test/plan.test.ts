import assert from "node:assert/strict";
import test from "node:test";
import {
  ContentRenderer as RuntimeContentRenderer,
  type ContentRendererOptions,
  placeContentRegion,
  validateContentReferences,
  validateHostContent,
} from "../dist/content.js";
import { preflight } from "../dist/preflight.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class StyleDeclarationFixture {
  [key: string]: unknown;
  leftWrites = 0;
  topWrites = 0;
  #left = "";
  #top = "";

  get left(): string {
    return this.#left;
  }

  set left(value: string) {
    this.leftWrites += 1;
    this.#left = value;
  }

  get top(): string {
    return this.#top;
  }

  set top(value: string) {
    this.topWrites += 1;
    this.#top = value;
  }

  setProperty(name: string, value: string): void {
    this[name] = value;
  }
}

class StyleSheetFixture {
  readonly cssRules: Array<{ style: StyleDeclarationFixture }> = [];

  insertRule(_rule: string, index: number): number {
    this.cssRules.splice(index, 0, { style: new StyleDeclarationFixture() });
    return index;
  }

  deleteRule(index: number): void {
    this.cssRules.splice(index, 1);
  }
}

class ContentRenderer extends RuntimeContentRenderer {
  constructor(document: Document, options: ContentRendererOptions = {}) {
    super(document, {
      styles: { url: "https://site.example/peekling.css" },
      ...options,
    });
  }
}

test("host content is bounded text and safe links, never pack code or HTML", () => {
  const content = validateHostContent(
    {
      greeting: {
        "top-right": {
          title: "Meet Moss",
          text: "Welcome",
          link: { label: "Read more", href: "/about" },
        },
      },
    },
    "https://site.example/page",
  );
  const greeting = content.greeting?.["top-right"];
  assert.equal(
    typeof greeting === "string" ? undefined : greeting?.link?.href,
    "https://site.example/about",
  );
  assert.equal(
    typeof greeting === "string" ? undefined : greeting?.title,
    "Meet Moss",
  );
  validateContentReferences(["greeting"], content);
  assert.throws(
    () =>
      validateHostContent(
        {
          bad: {
            "top-center": {
              text: "No",
              link: { label: "Run", href: "javascript:x" },
            },
          },
        },
        "https://site.example/",
      ),
    /protocol/,
  );
  assert.throws(
    () =>
      validateHostContent(
        {
          bad: {
            bottom: {
              link: {
                label: "Account",
                href: "https://accounts.example@evil.example/login",
              },
            },
          },
        },
        "https://site.example/",
      ),
    /credentials/,
  );
  assert.throws(
    () =>
      validateHostContent(
        {
          bad: {
            bottom: {
              link: { label: "Unsafe\u0007label", href: "/about" },
            },
          },
        },
        "https://site.example/",
      ),
    /content text/,
  );
  assert.throws(
    () =>
      validateHostContent(
        { bad: { bottom: { text: "Notice", announce: "yes" as never } } },
        "https://site.example/",
      ),
    /announce/,
  );
  assert.throws(
    () =>
      validateHostContent(
        {
          bad: {
            bottom: { text: "Notice", mountId: ["coerced"] as never },
          },
        },
        "https://site.example/",
      ),
    /binding/,
  );
  assert.throws(
    () => validateContentReferences(["missing"], content),
    /Unknown contentId/,
  );
  assert.throws(
    () => validateContentReferences(["constructor"], {}),
    /Unknown contentId/,
  );
  const constructorContent = validateHostContent(
    { constructor: { bottom: "Own content" } },
    "https://site.example/",
  );
  assert.doesNotThrow(() =>
    validateContentReferences(["constructor"], constructorContent),
  );
  assert.deepEqual(validateHostContent(undefined, "https://site.example/"), {});
  assert.throws(
    () => validateHostContent({ empty: {} }, "https://site.example/"),
    /empty/,
  );
  assert.throws(
    () =>
      validateHostContent(
        { hostile: { bottom: { text: "Safe", html: "<b>no</b>" } as never } },
        "https://site.example/",
      ),
    /Unknown field/,
  );
});

test("anchored regions flip at edges and stay inside the viewport", () => {
  const center = placeContentRegion(
    "top-right",
    { x: 200, y: 200 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
    { width: 180, height: 80 },
  );
  assert.ok(center.x > 232, "top-right surface clears the character");

  const edge = placeContentRegion(
    "bottom",
    { x: 470, y: 370 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
    { width: 180, height: 80 },
  );
  assert.ok(edge.x >= 8);
  assert.ok(edge.y >= 8);
  assert.ok(edge.x + 180 <= 492);
  assert.ok(edge.y + 80 <= 392);
});

test("content renderer uses accessible text and link nodes, preserves focus, and tears down", async () => {
  class ElementFixture {
    readonly tagName: string;
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    readonly children: ElementFixture[] = [];
    parentNode: ElementFixture | null = null;
    host?: ElementFixture;
    hidden = false;
    removed = false;
    className = "";
    textContent = "";
    href = "";
    isConnected = false;
    nodeType = 1;
    ownerDocument!: Document;
    type = "";
    readonly sheet: StyleSheetFixture | undefined;

    constructor(tagName: string) {
      this.tagName = tagName;
      this.sheet = tagName === "link" ? new StyleSheetFixture() : undefined;
    }

    append(...children: ElementFixture[]): void {
      for (const child of children) {
        child.isConnected = this.isConnected;
        child.parentNode = this;
      }
      this.children.push(...children);
    }

    prepend(...children: ElementFixture[]): void {
      for (const child of children) {
        child.isConnected = this.isConnected;
        child.parentNode = this;
      }
      this.children.unshift(...children);
    }

    replaceChildren(...children: ElementFixture[]): void {
      for (const child of this.children) {
        child.isConnected = false;
        child.parentNode = null;
      }
      for (const child of children) {
        child.isConnected = this.isConnected;
        child.parentNode = this;
      }
      this.children.splice(0, this.children.length, ...children);
    }

    addEventListener(type: string, listener: EventListener): void {
      if (this.tagName === "link" && type === "load") {
        queueMicrotask(() => listener({} as Event));
      }
    }

    attachShadow(): ElementFixture {
      const root = new ElementFixture("shadow-root");
      root.host = this;
      this.children.push(root);
      return root;
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }

    removeAttribute(name: string): void {
      this.attributes.delete(name);
    }

    hasAttribute(name: string): boolean {
      return this.attributes.has(name);
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }

    getRootNode(): ElementFixture {
      let current: ElementFixture = this;
      while (current.parentNode) current = current.parentNode;
      return current;
    }

    getBoundingClientRect(): DOMRect {
      const width = this.className === "callout" ? 180 : 80;
      const height = this.className === "callout" ? 80 : 30;
      return { width, height } as DOMRect;
    }

    remove(): void {
      this.removed = true;
      this.isConnected = false;
    }
  }

  const elements: ElementFixture[] = [];
  const focusOwner = {};
  const body = new ElementFixture("body");
  const diagnostics: string[] = [];
  const document = {
    activeElement: focusOwner,
    baseURI: "https://site.example/page",
    body,
    documentElement: body,
    createElement: (tagName: string) => {
      const element = new ElementFixture(tagName);
      element.ownerDocument = document;
      elements.push(element);
      return element;
    },
  } as unknown as Document;
  body.ownerDocument = document;
  body.isConnected = true;
  const renderer = new ContentRenderer(document, {
    diagnostic: (message) => diagnostics.push(message),
  });
  await renderer.ready;
  renderer.renderSurfaces(
    [{ id: "greeting", contentId: "greeting", key: "greeting" }],
    {
      greeting: {
        "top-right": {
          title: "Meet Moss",
          text: "Welcome",
          link: { label: "Read more", href: "https://site.example/about" },
        },
      },
    },
    { x: 200, y: 200 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
    "Moss",
  );
  assert.equal(
    elements.find(
      (element) => element.tagName === "p" && element.textContent === "Welcome",
    )?.textContent,
    "Welcome",
  );
  assert.equal(
    elements.find(
      (element) =>
        element.tagName === "a" && element.textContent === "Read more",
    )?.textContent,
    "Read more",
  );
  assert.equal(
    elements.find(
      (element) =>
        element.className.includes("surface") &&
        element.className.includes("bottom"),
    )?.children[1]?.textContent,
    "Moss",
  );
  assert.equal(
    document.activeElement,
    focusOwner,
    "rendering never moves focus",
  );
  renderer.renderSurfaces(
    [],
    {},
    { x: 0, y: 0 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  );
  renderer.destroy();
  assert.equal(body.children[0]?.hidden, true);
  assert.equal(body.children[0]?.removed, true);
});

test("host surfaces receive immutable data and update without remounting", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const calls: Array<{ kind: string; data: unknown }> = [];
  const renderer = new ContentRenderer(document, {
    bindings: {
      mounts: {
        card: ({ root, data }) => {
          calls.push({ kind: "mount", data });
          root.append(document.createElement("button"));
          return {
            update(next) {
              calls.push({ kind: "update", data: next });
            },
            cleanup() {
              calls.push({ kind: "cleanup", data: undefined });
            },
          };
        },
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    { card: { "top-center": { mountId: "card" } } },
    "https://site.example/",
  );

  renderer.renderSurfaces(
    [
      {
        id: "job-progress",
        contentId: "card",
        data: { progress: 0 },
        key: "job:0",
      },
    ],
    content,
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  );
  await Promise.resolve();
  renderer.renderSurfaces(
    [
      {
        id: "job-progress",
        contentId: "card",
        data: { progress: 42 },
        key: "job:42",
      },
    ],
    content,
    { x: 200, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  );
  await Promise.resolve();

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["mount", "update"],
  );
  assert.equal(Object.isFrozen(calls[0]?.data), true);
  assert.equal(Object.isFrozen(calls[1]?.data), true);
  renderer.destroy();
  await Promise.resolve();
  assert.equal(calls.at(-1)?.kind, "cleanup");
});

test("an active mount root is restored after deletion or same-document reparenting", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const roots = new Map<string, HTMLElement>();
  const mounts = new Map<string, number>();
  const cleanups = new Map<string, number>();
  const mount =
    (id: string) =>
    ({ root }: { root: HTMLElement }) => {
      roots.set(id, root);
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
      const node = document.createElement("span");
      node.textContent = `${id} survives`;
      root.append(node);
      return {
        cleanup() {
          cleanups.set(id, (cleanups.get(id) ?? 0) + 1);
          root.replaceChildren();
        },
      };
    };
  const renderer = new ContentRenderer(document, {
    bindings: {
      mounts: {
        repairable: mount("repairable"),
        unrelated: mount("unrelated"),
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    {
      repairable: { "top-left": { mountId: "repairable" } },
      unrelated: { "top-right": { mountId: "unrelated" } },
    },
    "https://site.example/",
  );
  const selections = [
    { id: "repairable", contentId: "repairable", key: "stable" },
    { id: "unrelated", contentId: "unrelated", key: "stable" },
  ];
  const geometry = [
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  ] as const;

  renderer.renderSurfaces(selections, content, ...geometry);
  await Promise.resolve();
  const repairableRoot = roots.get("repairable")!;
  const expectedParent = repairableRoot.parentNode;
  const unrelatedRoot = roots.get("unrelated")!;

  repairableRoot.remove();
  renderer.renderSurfaces(selections, content, ...geometry);
  assert.equal(
    repairableRoot.parentNode,
    expectedParent,
    "a deleted active root is restored on the next render",
  );

  const hostileContainer = document.createElement("div");
  body.append(hostileContainer as never);
  hostileContainer.append(repairableRoot);
  renderer.renderSurfaces(selections, content, ...geometry);
  assert.equal(
    repairableRoot.parentNode,
    expectedParent,
    "a same-document reparented root returns to its owned container",
  );
  assert.notEqual(unrelatedRoot.parentNode, null);
  assert.equal(
    body
      .descendants()
      .some((element) => element.textContent === "unrelated survives"),
    true,
  );
  assert.deepEqual(Object.fromEntries(mounts), {
    repairable: 1,
    unrelated: 1,
  });
  assert.deepEqual(Object.fromEntries(cleanups), {});

  renderer.destroy();
  assert.deepEqual(Object.fromEntries(cleanups), {
    repairable: 1,
    unrelated: 1,
  });
});

test("cross-document mount-root adoption faults only that surface and owns late cleanup once", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const foreignBody = new ElementFixtureForMount("body");
  const foreignDocument = createMountDocument(foreignBody);
  const pending = deferred<{ cleanup(): void }>();
  const diagnostics: string[] = [];
  let adoptedRoot!: HTMLElement;
  let unrelatedRoot!: HTMLElement;
  let adoptedMounts = 0;
  let adoptedCleanups = 0;
  let unrelatedCleanups = 0;
  const renderer = new ContentRenderer(document, {
    diagnostic: (message) => diagnostics.push(message),
    bindings: {
      mounts: {
        adopted: ({ root }) => {
          adoptedMounts += 1;
          adoptedRoot = root;
          root.textContent = "pending adopted surface";
          return pending.promise;
        },
        unrelated: ({ root }) => {
          unrelatedRoot = root;
          root.textContent = "unrelated remains active";
          return {
            cleanup() {
              unrelatedCleanups += 1;
            },
          };
        },
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    {
      adopted: { "top-left": { mountId: "adopted" } },
      unrelated: { "top-right": { mountId: "unrelated" } },
    },
    "https://site.example/",
  );
  const selections = [
    { id: "adopted", contentId: "adopted", key: "stable" },
    { id: "unrelated", contentId: "unrelated", key: "stable" },
  ];
  const geometry = [
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  ] as const;

  renderer.renderSurfaces(selections, content, ...geometry);
  const fixtureRoot = adoptedRoot as unknown as ElementFixtureForMount;
  foreignBody.append(fixtureRoot);
  fixtureRoot.ownerDocument = foreignDocument;
  renderer.renderSurfaces(selections, content, ...geometry);

  assert.equal(adoptedMounts, 1, "the failed selection is not retried");
  assert.equal(
    fixtureRoot.parentNode,
    null,
    "the adopted owned root is removed",
  );
  assert.notEqual(unrelatedRoot.parentNode, null);
  assert.equal(unrelatedRoot.textContent, "unrelated remains active");
  assert.ok(
    diagnostics.some((message) => message.includes("adopted")),
    "cross-document adoption produces a controlled surface diagnostic",
  );
  assert.equal(adoptedCleanups, 0, "pending cleanup waits for settlement");

  pending.resolve({
    cleanup() {
      adoptedCleanups += 1;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adoptedCleanups, 1, "late cleanup remains owned exactly once");

  renderer.destroy();
  assert.equal(adoptedCleanups, 1);
  assert.equal(unrelatedCleanups, 1);
});

test("an unchanged mounted surface does not revalidate accepted data", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const diagnostics: string[] = [];
  const original = Object.getOwnPropertyDescriptor(JSON, "stringify")!;
  const nativeStringify = JSON.stringify;
  let serializations = 0;
  let getterReads = 0;
  Object.defineProperty(JSON, "stringify", {
    ...original,
    value: (...args: Parameters<typeof JSON.stringify>) => {
      serializations += 1;
      return Reflect.apply(nativeStringify, JSON, args) as string | undefined;
    },
  });

  try {
    const renderer = new ContentRenderer(document, {
      diagnostic: (message) => diagnostics.push(message),
      bindings: {
        mounts: {
          card: () => ({ cleanup() {} }),
        },
      },
    });
    await renderer.ready;
    const content = validateHostContent(
      { card: { "top-center": { mountId: "card" } } },
      "https://site.example/",
    );
    const data = Object.freeze({ progress: 42 });
    const selection = {
      id: "job-progress",
      contentId: "card",
      data,
      key: "job:42",
    };
    const geometry = [
      { x: 100, y: 100 },
      { width: 500, height: 400 },
      { width: 64, height: 64 },
    ] as const;

    renderer.renderSurfaces([selection], content, ...geometry);
    assert.equal(serializations, 1, "initial data is validated once");
    renderer.renderSurfaces([selection], content, ...geometry);
    assert.equal(
      serializations,
      1,
      "an unchanged render key reuses accepted data",
    );

    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "progress", {
      enumerable: true,
      get() {
        getterReads += 1;
        return 43;
      },
    });
    renderer.renderSurfaces(
      [{ ...selection, data: hostile as never, key: "job:43" }],
      content,
      ...geometry,
    );
    assert.equal(getterReads, 0, "changed ingress never evaluates accessors");
    assert.ok(diagnostics.some((message) => message.includes("data failed")));
    renderer.destroy();
  } finally {
    Object.defineProperty(JSON, "stringify", original);
  }
});

test("stable 30, 60, and 120 Hz-style surface turns reuse geometry and position writes", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const renderer = new ContentRenderer(document);
  await renderer.ready;
  const content = validateHostContent(
    {
      first: { "top-left": "First" },
      second: { "top-right": "Second" },
    },
    "https://site.example/",
  );
  const selections = [
    { id: "first", contentId: "first", key: "first:0" },
    { id: "second", contentId: "second", key: "second:0" },
  ];
  const viewport = { width: 800, height: 600 };
  const character = { width: 64, height: 64 };
  const position = { x: 250, y: 300 };
  const sheet = body
    .descendants()
    .find((element) => element.tagName === "link")!.sheet!;
  const surfaceReads = () =>
    body
      .descendants()
      .filter((element) => element.className.includes("surface"))
      .reduce((sum, element) => sum + element.rectReads, 0);
  const positionWrites = () =>
    sheet.cssRules.reduce(
      (sum, rule) => sum + rule.style.leftWrites + rule.style.topWrites,
      0,
    );

  renderer.renderSurfaces(
    selections,
    content,
    position,
    viewport,
    character,
    "Moss",
  );
  const initialReads = surfaceReads();
  const initialWrites = positionWrites();
  assert.equal(initialReads, 3, "each initial surface is measured once");
  assert.equal(initialWrites, 6, "each initial surface is positioned once");

  for (const turns of [30, 60, 120]) {
    for (let turn = 0; turn < turns; turn++) {
      renderer.renderSurfaces(
        selections,
        content,
        position,
        viewport,
        character,
        "Moss",
      );
    }
    assert.equal(
      surfaceReads(),
      initialReads,
      `${turns} stable turns do not force new geometry reads`,
    );
    assert.equal(
      positionWrites(),
      initialWrites,
      `${turns} stable turns do not rewrite positions`,
    );
  }

  renderer.renderSurfaces(
    selections,
    content,
    { x: 350, y: 300 },
    viewport,
    character,
    "Moss",
  );
  assert.equal(
    surfaceReads(),
    initialReads,
    "character movement reuses unchanged surface dimensions",
  );
  assert.ok(
    positionWrites() > initialWrites,
    "character movement recomputes surface placement",
  );
  const afterPositionWrites = positionWrites();

  renderer.renderSurfaces(
    selections,
    content,
    { x: 350, y: 300 },
    { width: 360, height: 420 },
    character,
    "Moss",
  );
  assert.equal(
    surfaceReads(),
    initialReads + 3,
    "viewport changes remeasure surfaces whose CSS size depends on the viewport",
  );
  assert.ok(
    positionWrites() > afterPositionWrites,
    "viewport changes recompute clamped placement",
  );

  const changedContent = validateHostContent(
    {
      first: { "top-left": "First changed" },
      second: { "top-right": "Second" },
    },
    "https://site.example/",
  );
  renderer.renderSurfaces(
    selections,
    changedContent,
    { x: 350, y: 300 },
    { width: 360, height: 420 },
    character,
    "Moss",
  );
  assert.equal(
    surfaceReads(),
    initialReads + 4,
    "only the changed content surface is remeasured",
  );

  renderer.renderSurfaces(
    selections,
    changedContent,
    { x: 350, y: 300 },
    { width: 360, height: 420 },
    character,
    "Mossy",
  );
  assert.equal(
    surfaceReads(),
    initialReads + 5,
    "a changed name invalidates only its synthetic surface",
  );
  renderer.destroy();
});

test("mount updates and owned-root repair invalidate only affected surface geometry", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const renderer = new ContentRenderer(document, {
    bindings: {
      mounts: {
        card: ({ root }) => {
          root.textContent = "Initial";
          return {
            update(data) {
              root.textContent = String((data as { label?: string })?.label);
            },
            cleanup() {},
          };
        },
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    { card: { "top-center": { mountId: "card" } } },
    "https://site.example/",
  );
  const geometry = [
    { x: 200, y: 200 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  ] as const;

  renderer.renderSurfaces(
    [
      {
        id: "card",
        contentId: "card",
        key: "card:0",
        data: { label: "Initial" },
      },
    ],
    content,
    ...geometry,
  );
  await Promise.resolve();
  const surface = body
    .descendants()
    .find((element) => element.className.includes("surface"))!;
  assert.equal(surface.rectReads, 1);

  renderer.renderSurfaces(
    [
      {
        id: "card",
        contentId: "card",
        key: "card:1",
        data: { label: "Updated" },
      },
    ],
    content,
    ...geometry,
  );
  assert.equal(surface.rectReads, 2, "a mount update remeasures its surface");
  renderer.renderSurfaces(
    [
      {
        id: "card",
        contentId: "card",
        key: "card:1",
        data: { label: "Updated" },
      },
    ],
    content,
    ...geometry,
  );
  assert.equal(surface.rectReads, 2, "a stable mounted surface stays cached");

  surface.remove();
  renderer.renderSurfaces(
    [
      {
        id: "card",
        contentId: "card",
        key: "card:1",
        data: { label: "Updated" },
      },
    ],
    content,
    ...geometry,
  );
  assert.equal(surface.rectReads, 3, "root repair invalidates geometry once");
  renderer.destroy();
});

test("removing a stacked surface repositions the remaining region without remeasurement", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const renderer = new ContentRenderer(document);
  await renderer.ready;
  const content = validateHostContent(
    {
      first: { "top-center": "First" },
      second: { "top-center": "Second" },
    },
    "https://site.example/",
  );
  const first = { id: "first", contentId: "first", key: "first" };
  const second = { id: "second", contentId: "second", key: "second" };
  const geometry = [
    { x: 250, y: 300 },
    { width: 800, height: 600 },
    { width: 64, height: 64 },
  ] as const;
  const sheet = body
    .descendants()
    .find((element) => element.tagName === "link")!.sheet!;

  renderer.renderSurfaces([first, second], content, ...geometry);
  const secondStyle = sheet.cssRules[2]!.style;
  const stackedTop = secondStyle.top;
  const secondSurface = body
    .descendants()
    .find((element) => element.dataset.peeklingSurface === "second")!;
  assert.equal(secondSurface.rectReads, 1);

  renderer.renderSurfaces([second], content, ...geometry);
  assert.notEqual(
    secondStyle.top,
    stackedTop,
    "the remaining surface closes the removed stacking gap",
  );
  assert.equal(
    secondSurface.rectReads,
    1,
    "removal reuses the remaining surface dimensions",
  );
  renderer.destroy();
});

test("named surfaces stack by stable surface identity, not arrival order", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const renderer = new ContentRenderer(document);
  await renderer.ready;
  const content = validateHostContent(
    {
      alpha: { "top-center": "Alpha" },
      zeta: { "top-center": "Zeta" },
    },
    "https://site.example/",
  );
  const alpha = { id: "alpha", contentId: "alpha", key: "alpha" };
  const zeta = { id: "zeta", contentId: "zeta", key: "zeta" };
  const geometry = [
    { x: 250, y: 300 },
    { width: 800, height: 600 },
    { width: 64, height: 64 },
  ] as const;
  const sheet = body
    .descendants()
    .find((element) => element.tagName === "link")!.sheet!;

  renderer.renderSurfaces([zeta, alpha], content, ...geometry);
  const zetaStyle = sheet.cssRules[1]!.style;
  const alphaStyle = sheet.cssRules[2]!.style;
  assert.ok(
    Number.parseFloat(alphaStyle.top) < Number.parseFloat(zetaStyle.top),
    "alpha stacks before zeta even when zeta arrives first",
  );

  const alphaTop = alphaStyle.top;
  const zetaTop = zetaStyle.top;
  renderer.renderSurfaces([alpha, zeta], content, ...geometry);
  assert.equal(alphaStyle.top, alphaTop);
  assert.equal(zetaStyle.top, zetaTop);
  renderer.destroy();
});

test("host mount, update, cleanup, and rejected thenable failures are isolated", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const diagnostics: string[] = [];
  let failUpdate = false;
  let brokenMountCalls = 0;
  const renderer = new ContentRenderer(document, {
    diagnostic: (message) => diagnostics.push(message),
    bindings: {
      mounts: {
        "broken-mount": () => {
          brokenMountCalls += 1;
          throw new Error("mount failure");
        },
        "broken-update": () => ({
          update: () =>
            failUpdate
              ? Promise.reject(new Error("update failure"))
              : undefined,
          cleanup: () => {
            throw new Error("cleanup failure");
          },
        }),
        healthy: ({ root }) => {
          const node = document.createElement("button");
          node.textContent = "Still alive";
          root.append(node);
          return { cleanup: () => {} };
        },
        rejected: () => Promise.reject(new Error("async mount failure")),
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    {
      "broken-mount": { "top-left": { mountId: "broken-mount" } },
      "broken-update": { "top-center": { mountId: "broken-update" } },
      healthy: { "top-right": { mountId: "healthy" } },
      rejected: { bottom: { mountId: "rejected" } },
    },
    "https://site.example/",
  );
  const selections = [
    { id: "one", contentId: "broken-mount", key: "1" },
    { id: "two", contentId: "broken-update", key: "1" },
    { id: "three", contentId: "healthy", key: "1" },
    { id: "four", contentId: "rejected", key: "1" },
  ];
  renderer.renderSurfaces(
    selections,
    content,
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  );
  renderer.renderSurfaces(
    selections,
    content,
    { x: 110, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    brokenMountCalls,
    1,
    "a failed selection is not retried per frame",
  );
  failUpdate = true;
  renderer.renderSurfaces(
    selections.map((selection) => ({ ...selection, key: "2", data: { n: 2 } })),
    content,
    { x: 150, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(
    body.descendants().some((element) => element.textContent === "Still alive"),
    "a failing surface does not remove an unrelated mount",
  );
  renderer.destroy();
  await Promise.resolve();

  assert.ok(diagnostics.some((message) => message.includes("mount failed")));
  assert.ok(diagnostics.some((message) => message.includes("update failed")));
  assert.ok(diagnostics.some((message) => message.includes("cleanup failed")));
});

test("host mount controllers are snapshotted without reading accessors or leaking proxy faults", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const diagnostics: string[] = [];
  let accessorReads = 0;
  let proxyReflections = 0;
  const renderer = new ContentRenderer(document, {
    diagnostic: (message) => diagnostics.push(message),
    bindings: {
      mounts: {
        accessor: () => {
          const controller = Object.create(null) as Record<string, unknown>;
          Object.defineProperty(controller, "cleanup", {
            enumerable: true,
            get() {
              accessorReads += 1;
              throw new Error("controller accessor executed");
            },
          });
          return controller as never;
        },
        proxy: () =>
          new Proxy(
            {},
            {
              ownKeys() {
                proxyReflections += 1;
                throw new Error("controller reflection failed");
              },
            },
          ) as never,
        healthy: ({ root }) => {
          const node = document.createElement("button");
          node.textContent = "Healthy controller";
          root.append(node);
          return { cleanup: () => {} };
        },
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    {
      accessor: { "top-left": { mountId: "accessor" } },
      proxy: { "top-center": { mountId: "proxy" } },
      healthy: { "top-right": { mountId: "healthy" } },
    },
    "https://site.example/",
  );
  renderer.renderSurfaces(
    [
      { id: "accessor", contentId: "accessor", key: "one" },
      { id: "proxy", contentId: "proxy", key: "one" },
      { id: "healthy", contentId: "healthy", key: "one" },
    ],
    content,
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(accessorReads, 0, "controller accessors are never evaluated");
  assert.equal(proxyReflections, 1, "proxy reflection is attempted once");
  assert.equal(
    diagnostics.filter((message) => message.includes("mount failed")).length,
    2,
  );
  assert.ok(
    body
      .descendants()
      .some((element) => element.textContent === "Healthy controller"),
    "a malformed controller does not remove an unrelated surface",
  );
  renderer.destroy();
});

test("late mount settlement cannot overwrite a newer surface and pending data catches up", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const diagnostics: string[] = [];
  let rejectSlow!: (reason: unknown) => void;
  let resolvePending!: (value: {
    update(data: unknown): void;
    cleanup(): void;
  }) => void;
  const updates: unknown[] = [];
  const renderer = new ContentRenderer(document, {
    diagnostic: (message) => diagnostics.push(message),
    bindings: {
      mounts: {
        slow: () =>
          new Promise((_resolve, reject) => {
            rejectSlow = reject;
          }),
        healthy: ({ root }) => {
          const node = document.createElement("button");
          node.textContent = "Newest";
          root.append(node);
          return { cleanup: () => {} };
        },
        pending: () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          }),
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    {
      slow: { "top-center": { mountId: "slow" } },
      healthy: { "top-center": { mountId: "healthy" } },
      pending: { bottom: { mountId: "pending" } },
    },
    "https://site.example/",
  );
  const geometry = [
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  ] as const;
  renderer.renderSurfaces(
    [{ id: "status", contentId: "slow", key: "slow" }],
    content,
    ...geometry,
  );
  renderer.renderSurfaces(
    [{ id: "status", contentId: "healthy", key: "healthy" }],
    content,
    ...geometry,
  );
  rejectSlow(new Error("late failure"));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(
    body.descendants().some((element) => element.textContent === "Newest"),
  );
  assert.equal(
    diagnostics.some((message) => message.includes("slow")),
    false,
  );

  renderer.renderSurfaces(
    [{ id: "progress", contentId: "pending", key: "0", data: { n: 0 } }],
    content,
    ...geometry,
  );
  renderer.renderSurfaces(
    [{ id: "progress", contentId: "pending", key: "1", data: { n: 1 } }],
    content,
    ...geometry,
  );
  resolvePending({
    update(data) {
      updates.push(data);
    },
    cleanup() {},
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((updates[0] as { n: number }).n, 1);
  renderer.destroy();
});

test("late mount cleanup cannot alter a replacement surface", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const slow = deferred<{ cleanup(): void }>();
  let slowRoot!: HTMLElement;
  let slowCleanups = 0;
  let freshCleanups = 0;
  const renderer = new ContentRenderer(document, {
    bindings: {
      mounts: {
        slow: ({ root }) => {
          slowRoot = root;
          const node = document.createElement("span");
          node.textContent = "Slow surface";
          root.append(node);
          return slow.promise;
        },
        fresh: ({ root }) => {
          const node = document.createElement("span");
          node.textContent = "Fresh surface";
          root.append(node);
          return {
            cleanup() {
              freshCleanups += 1;
              root.replaceChildren();
            },
          };
        },
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    {
      slow: { "top-center": { mountId: "slow" } },
      fresh: { "top-center": { mountId: "fresh" } },
    },
    "https://site.example/",
  );
  const geometry = [
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  ] as const;

  renderer.renderSurfaces(
    [{ id: "status", contentId: "slow", key: "slow" }],
    content,
    ...geometry,
  );
  renderer.renderSurfaces(
    [{ id: "status", contentId: "fresh", key: "fresh" }],
    content,
    ...geometry,
  );
  slow.resolve({
    cleanup() {
      slowCleanups += 1;
      slowRoot.replaceChildren();
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(
    body
      .descendants()
      .some((element) => element.textContent === "Fresh surface"),
    "late cleanup is confined to the released mount root",
  );
  assert.equal(slowCleanups, 1);
  assert.equal(freshCleanups, 0);
  renderer.destroy();
  assert.equal(slowCleanups, 1);
  assert.equal(freshCleanups, 1);
});

test("stale async update settlement cannot alter a remounted surface", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const update = deferred<void>();
  let staleCleanups = 0;
  let freshCleanups = 0;
  const renderer = new ContentRenderer(document, {
    bindings: {
      mounts: {
        stale: ({ root }) => ({
          update() {
            return update.promise.then(() => root.replaceChildren());
          },
          cleanup() {
            staleCleanups += 1;
            root.replaceChildren();
          },
        }),
        fresh: ({ root }) => {
          const node = document.createElement("span");
          node.textContent = "Fresh after update";
          root.append(node);
          return {
            cleanup() {
              freshCleanups += 1;
              root.replaceChildren();
            },
          };
        },
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    {
      stale: { "top-center": { mountId: "stale" } },
      fresh: { "top-center": { mountId: "fresh" } },
    },
    "https://site.example/",
  );
  const geometry = [
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  ] as const;

  renderer.renderSurfaces(
    [{ id: "status", contentId: "stale", key: "zero", data: { n: 0 } }],
    content,
    ...geometry,
  );
  await Promise.resolve();
  renderer.renderSurfaces(
    [{ id: "status", contentId: "stale", key: "one", data: { n: 1 } }],
    content,
    ...geometry,
  );
  renderer.renderSurfaces(
    [{ id: "status", contentId: "fresh", key: "fresh" }],
    content,
    ...geometry,
  );
  update.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(
    body
      .descendants()
      .some((element) => element.textContent === "Fresh after update"),
    "a stale update is confined to the released mount root",
  );
  assert.equal(staleCleanups, 1);
  assert.equal(freshCleanups, 0);
  renderer.destroy();
  assert.equal(staleCleanups, 1);
  assert.equal(freshCleanups, 1);
});

test("a rejected update is handled and cleans its surface exactly once", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  const diagnostics: string[] = [];
  const update = deferred<void>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let cleanups = 0;
  try {
    const renderer = new ContentRenderer(document, {
      diagnostic: (message) => diagnostics.push(message),
      bindings: {
        mounts: {
          card: ({ root }) => {
            const node = document.createElement("span");
            node.textContent = "Pending update";
            root.append(node);
            return {
              update: () => update.promise,
              cleanup() {
                cleanups += 1;
                root.replaceChildren();
              },
            };
          },
        },
      },
    });
    await renderer.ready;
    const content = validateHostContent(
      { card: { "top-center": { mountId: "card" } } },
      "https://site.example/",
    );
    const geometry = [
      { x: 100, y: 100 },
      { width: 500, height: 400 },
      { width: 64, height: 64 },
    ] as const;
    renderer.renderSurfaces(
      [{ id: "status", contentId: "card", key: "zero", data: { n: 0 } }],
      content,
      ...geometry,
    );
    await Promise.resolve();
    renderer.renderSurfaces(
      [{ id: "status", contentId: "card", key: "one", data: { n: 1 } }],
      content,
      ...geometry,
    );
    update.reject(new Error("controlled update rejection"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(cleanups, 1);
    assert.ok(diagnostics.some((message) => message.includes("update failed")));
    assert.equal(
      body
        .descendants()
        .some((element) => element.textContent === "Pending update"),
      false,
    );
    assert.deepEqual(unhandled, []);
    renderer.destroy();
    assert.equal(cleanups, 1);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a never-settling host update keeps one bounded call", async () => {
  const body = new ElementFixtureForMount("body");
  const document = createMountDocument(body);
  let updates = 0;
  let cleanups = 0;
  const renderer = new ContentRenderer(document, {
    bindings: {
      mounts: {
        pending: () => ({
          update() {
            updates += 1;
            return new Promise(() => {});
          },
          cleanup() {
            cleanups += 1;
          },
        }),
      },
    },
  });
  await renderer.ready;
  const content = validateHostContent(
    { pending: { bottom: { mountId: "pending" } } },
    "https://site.example/",
  );
  const geometry = [
    { x: 100, y: 100 },
    { width: 500, height: 400 },
    { width: 64, height: 64 },
  ] as const;
  renderer.renderSurfaces(
    [{ id: "progress", contentId: "pending", key: "0", data: { n: 0 } }],
    content,
    ...geometry,
  );
  await Promise.resolve();
  for (let n = 1; n <= 10; n += 1) {
    renderer.renderSurfaces(
      [{ id: "progress", contentId: "pending", key: String(n), data: { n } }],
      content,
      ...geometry,
    );
  }
  assert.equal(updates, 1, "only one host update remains in flight");
  renderer.destroy();
  assert.equal(cleanups, 1);
});

test("content rendering stays terminal when host callbacks destroy it", async (t) => {
  for (const phase of ["mount", "update", "cleanup"] as const) {
    await t.test(phase, async () => {
      const body = new ElementFixtureForMount("body");
      const document = createMountDocument(body);
      let renderer!: ContentRenderer;
      let cleanups = 0;
      let replacementMounts = 0;
      const destroy = () => renderer.destroy();
      renderer = new ContentRenderer(document, {
        bindings: {
          mounts: {
            first: () => {
              if (phase === "mount") destroy();
              return {
                update() {
                  if (phase === "update") destroy();
                },
                cleanup() {
                  cleanups += 1;
                  if (phase === "cleanup") destroy();
                },
              };
            },
            second: () => {
              replacementMounts += 1;
              return { cleanup() {} };
            },
          },
        },
      });
      await renderer.ready;
      const content = validateHostContent(
        {
          first: { "top-center": { mountId: "first" } },
          second: { "top-center": { mountId: "second" } },
        },
        "https://site.example/",
      );
      const geometry = [
        { x: 100, y: 100 },
        { width: 500, height: 400 },
        { width: 64, height: 64 },
      ] as const;
      const first = {
        id: "status",
        contentId: "first",
        key: "first",
        data: { revision: 0 },
      };

      renderer.renderSurfaces([first], content, ...geometry);
      await Promise.resolve();
      await Promise.resolve();
      if (phase === "update") {
        renderer.renderSurfaces(
          [{ ...first, key: "updated", data: { revision: 1 } }],
          content,
          ...geometry,
        );
      } else if (phase === "cleanup") {
        renderer.renderSurfaces(
          [{ id: "status", contentId: "second", key: "second" }],
          content,
          ...geometry,
        );
      }
      await Promise.resolve();
      await Promise.resolve();

      assert.doesNotThrow(() =>
        renderer.renderSurfaces([first], content, ...geometry),
      );
      assert.equal(
        body
          .descendants()
          .some((element) => element.dataset.peeklingContent !== undefined),
        false,
        "a destroyed content root cannot reconnect",
      );
      assert.equal(cleanups, 1, "the owned cleanup runs exactly once");
      assert.equal(
        replacementMounts,
        0,
        "destroy during cleanup stops the replacement mount",
      );
    });
  }
});

class ElementFixtureForMount {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: ElementFixtureForMount[] = [];
  parentNode: ElementFixtureForMount | null = null;
  host?: ElementFixtureForMount;
  hidden = false;
  removed = false;
  className = "";
  textContent = "";
  href = "";
  isConnected = false;
  nodeType = 1;
  ownerDocument!: Document;
  type = "";
  rectReads = 0;
  readonly sheet: StyleSheetFixture | undefined;

  constructor(tagName: string) {
    this.tagName = tagName;
    this.sheet = tagName === "link" ? new StyleSheetFixture() : undefined;
  }
  append(...children: ElementFixtureForMount[]): void {
    for (const child of children) {
      child.detach();
      child.isConnected = this.isConnected;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  prepend(...children: ElementFixtureForMount[]): void {
    for (const child of [...children].reverse()) {
      child.detach();
      child.isConnected = this.isConnected;
      child.parentNode = this;
      this.children.unshift(child);
    }
  }
  replaceChildren(...children: ElementFixtureForMount[]): void {
    for (const child of [...this.children]) {
      child.isConnected = false;
      child.parentNode = null;
    }
    this.children.splice(0, this.children.length);
    this.append(...children);
  }
  addEventListener(type: string, listener: EventListener): void {
    if (this.tagName === "link" && type === "load") {
      queueMicrotask(() => listener({} as Event));
    }
  }
  attachShadow(): ElementFixtureForMount {
    const root = new ElementFixtureForMount("shadow-root");
    root.host = this;
    this.children.push(root);
    return root;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  getRootNode(): ElementFixtureForMount {
    let current: ElementFixtureForMount = this;
    while (current.parentNode) current = current.parentNode;
    return current;
  }
  getBoundingClientRect(): DOMRect {
    this.rectReads += 1;
    return { width: 180, height: 80 } as DOMRect;
  }
  remove(): void {
    this.detach();
    this.removed = true;
    this.isConnected = false;
  }
  descendants(): ElementFixtureForMount[] {
    return [this, ...this.children.flatMap((child) => child.descendants())];
  }

  private detach(): void {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
    this.isConnected = false;
  }
}

function createMountDocument(body: ElementFixtureForMount): Document {
  const document = {
    activeElement: {},
    baseURI: "https://site.example/page",
    body,
    documentElement: body,
    createElement: (tagName: string) => {
      const element = new ElementFixtureForMount(tagName);
      element.ownerDocument = document;
      return element;
    },
  } as unknown as Document;
  body.ownerDocument = document;
  body.isConnected = true;
  return document;
}

test("preflight returns exact errors, warnings, and fixes", () => {
  const report = preflight(
    {
      plan: {
        baseline: { channels: ["state"], state: { state: "idle" } },
        rules: [
          {
            id: "missing-section",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#missing",
              phase: "enter",
            },
            effect: {
              channels: ["state"],
              state: { state: "missing" },
            },
          },
        ],
      },
      behaviors: ["idle"],
      content: {
        custom: { "top-center": { rendererId: "card" } },
      },
    },
    {
      document: { querySelector: () => null } as unknown as Document,
      states: new Set(["idle"]),
    },
  );
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((issue) => issue.path === "$.behaviors"));
  assert.ok(
    report.errors.some(
      (issue) => issue.path === "$.plan.rules[0].effect.state.state",
    ),
  );
  assert.ok(report.errors.every((issue) => issue.fix.length > 0));
  assert.ok(report.warnings.some((issue) => issue.code === "missing-selector"));
  const hostile = preflight({
    diagnostics: {
      console: "yes",
      destination: "https://sink.invalid",
    } as never,
    unknown: true,
  } as never);
  assert.equal(hostile.valid, false);
  assert.ok(hostile.errors.some((issue) => issue.path === "$.unknown"));
  assert.ok(
    hostile.errors.some((issue) => issue.path === "$.diagnostics.console"),
  );
});
