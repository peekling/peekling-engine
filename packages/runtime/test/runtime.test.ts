import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  hatch,
  hidePeekling,
  isPeeklingHidden,
  showPeekling,
} from "../dist/index.js";
import { directionTo } from "../dist/direction.js";
import { PackValidationError } from "../dist/errors.js";
import { validateEventPayload } from "../dist/events.js";
import { locomotionAdvance, locomotionSample } from "../dist/locomotion.js";
import {
  loadNativePack,
  requiredAtlasDensity,
  resolveManifestUrl,
} from "../dist/loader.js";
import { validateNormalizedPack } from "../dist/normalized.js";
import { snapshotPackData } from "../dist/own-data.js";
import {
  parseManifestText,
  selectNativeDensity,
  validateNativePack,
} from "../dist/pack.js";
import {
  PeeklingRuntime,
  resolveInitialPosition,
  type PeeklingInstance,
  type PeeklingOptions,
} from "../dist/runtime.js";
import { preflight } from "../dist/preflight.js";
import { AtlasRenderer, frameAt, snapToDevicePixel } from "../dist/renderer.js";
import { resolveState } from "../dist/resolver.js";
import type { HostContent, NativeManifest, Plan } from "../dist/types.js";
import {
  definePeeklingElement,
  PEEKLING_ELEMENT_TAG,
} from "../dist/web-component.js";

const manifest: NativeManifest = {
  format: 1,
  name: "engine-fixture",
  version: "0.1.0",
  license: "CC0-1.0",
  metadata: {
    title: "Engine fixture",
    author: "Peekling contributors",
    description: "A synthetic data-only fixture for runtime tests.",
    tags: ["fixture"],
  },
  assets: {
    atlases: {
      columns: 16,
      rows: 3,
      logicalCellSize: 64,
      lineage: "synthetic-runtime-fixture-v1",
      variants: [
        {
          src: "atlas-1x.png",
          density: 1,
          sourceCellSize: 64,
          sha256: "0".repeat(64),
        },
      ],
    },
  },
  states: {
    idle: { frames: [0], fps: 1, loop: true },
    "move:N": { frames: [1, 2], fps: 6, loop: true },
    "move:NE": { frames: [3, 4], fps: 6, loop: true },
    "move:E": { frames: [5, 6], fps: 6, loop: true },
    "move:SE": { frames: [7, 8], fps: 6, loop: true },
    "move:S": { frames: [9, 10], fps: 6, loop: true },
    "move:SW": { frames: [11, 12], fps: 6, loop: true },
    "move:W": { frames: [13, 14], fps: 6, loop: true },
    "move:NW": { frames: [15, 16], fps: 6, loop: true },
    click: { frames: [17], fps: 6, loop: false },
    "double-click": { frames: [18], fps: 6, loop: false },
    "context-click": { frames: [19], fps: 6, loop: false },
    scroll: { frames: [20], fps: 6, loop: false },
    happy: { frames: [21], fps: 6, loop: false },
    success: { frames: [22], fps: 6, loop: false },
    error: { frames: [23], fps: 6, loop: false },
    sleep: { frames: [24], fps: 1, loop: true },
  },
  capabilities: {
    locomotion: {
      directions: {
        N: "move:N",
        NE: "move:NE",
        E: "move:E",
        SE: "move:SE",
        S: "move:S",
        SW: "move:SW",
        W: "move:W",
        NW: "move:NW",
      },
    },
  },
  defaults: { scale: 1 },
};

function copyManifest(): NativeManifest {
  const value = structuredClone(manifest) as unknown as Record<string, unknown>;
  value.assets = {
    atlas: {
      src: "atlas.png",
      sha256: "0".repeat(64),
      columns: 16,
      rows: 3,
      logicalCellSize: 32,
      sourceCellSize: 32,
      density: 1,
    },
  };
  value.defaults = { scale: 2 };
  return value as unknown as NativeManifest;
}

function pngFixture(
  width: number,
  height: number,
  colorType = 6,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(57);
  output.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(output.buffer);
  view.setUint32(8, 13);
  output.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  output[24] = 8;
  output[25] = colorType;
  output.set([0x49, 0x44, 0x41, 0x54], 37);
  output.set([0x49, 0x45, 0x4e, 0x44], 49);
  return output;
}

function pngChunk(name: string, data = new Uint8Array()): Uint8Array {
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength);
  output.set(
    [...name].map((character) => character.charCodeAt(0)),
    4,
  );
  output.set(data, 8);
  return output;
}

function indexedAlphaPngFixture(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 3;
  const chunks = [
    new Uint8Array(PNG_SIGNATURE_FIXTURE),
    pngChunk("IHDR", header),
    pngChunk("PLTE", new Uint8Array([0, 0, 0])),
    pngChunk("tRNS", new Uint8Array([0])),
    pngChunk("IDAT"),
    pngChunk("IEND"),
  ];
  const output = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function webpVp8xFixture(width: number, height: number): Uint8Array {
  const output = new Uint8Array(48);
  const view = new DataView(output.buffer);
  output.set([0x52, 0x49, 0x46, 0x46]);
  view.setUint32(4, 40, true);
  output.set([0x57, 0x45, 0x42, 0x50], 8);
  output.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  const storedWidth = width - 1;
  const storedHeight = height - 1;
  output[24] = storedWidth & 0xff;
  output[25] = (storedWidth >>> 8) & 0xff;
  output[26] = (storedWidth >>> 16) & 0xff;
  output[27] = storedHeight & 0xff;
  output[28] = (storedHeight >>> 8) & 0xff;
  output[29] = (storedHeight >>> 16) & 0xff;
  output.set([0x56, 0x50, 0x38, 0x20], 30);
  view.setUint32(34, 10, true);
  output.set([0x9d, 0x01, 0x2a], 41);
  view.setUint16(44, 1, true);
  view.setUint16(46, 1, true);
  return output;
}

const PNG_SIGNATURE_FIXTURE = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

function loadedImage(width: number, height: number): HTMLImageElement {
  const listeners = new Map<string, EventListener>();
  return {
    naturalWidth: width,
    naturalHeight: height,
    addEventListener: (type: string, listener: EventListener) =>
      listeners.set(type, listener),
    removeEventListener: () => {},
    removeAttribute: () => {},
    set src(_value: string) {
      queueMicrotask(() => listeners.get("load")?.({} as Event));
    },
  } as unknown as HTMLImageElement;
}

async function loadNativeFixture(
  bytes: Uint8Array<ArrayBuffer>,
  overrides: Partial<Parameters<typeof loadNativePack>[0]> = {},
) {
  let objectUrls = 0;
  const revoked: string[] = [];
  const { pack: suppliedPack, ...rest } = overrides;
  const pack = suppliedPack ?? copyManifest();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if ("atlas" in pack && typeof pack.atlas === "object" && pack.atlas) {
    pack.atlas.sha256 = sha256;
  } else if (
    "assets" in pack &&
    typeof pack.assets === "object" &&
    pack.assets &&
    "atlas" in pack.assets &&
    typeof pack.assets.atlas === "object" &&
    pack.assets.atlas
  ) {
    pack.assets.atlas.sha256 = sha256;
  }
  const result = loadNativePack({
    character: "engine-fixture",
    baseUrl: "https://app.example/",
    pack,
    atlasUrl: "https://assets.example/atlas.png",
    fetch: (async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as typeof fetch,
    image: () => loadedImage(512, 96),
    signal: new AbortController().signal,
    createObjectURL: () => `blob:fixture:${++objectUrls}`,
    revokeObjectURL: (value) => revoked.push(value),
    ...rest,
  });
  return { result, objectUrls: () => objectUrls, revoked };
}

test("hatch is the canonical API", () => {
  assert.throws(() => hatch("Not Safe"), /Browser document/);
  assert.throws(
    () => hatch(null as unknown as Record<string, never>),
    /Expected character or options/,
  );
});

test("preflight rejects inherited and accessor configuration without executing it", () => {
  let inheritedReads = 0;
  const inherited = Object.create({
    get character() {
      inheritedReads += 1;
      throw new Error("inherited getter executed");
    },
  }) as PeeklingOptions;
  const inheritedResult = preflight(inherited);
  assert.equal(inheritedResult.valid, false);
  assert.equal(inheritedResult.errors[0]?.code, "invalid-options");
  assert.equal(inheritedReads, 0);

  let ownReads = 0;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "character", {
    enumerable: true,
    get() {
      ownReads += 1;
      throw new Error("own getter executed");
    },
  });
  const accessorResult = preflight(accessor as PeeklingOptions);
  assert.equal(accessorResult.valid, false);
  assert.equal(accessorResult.errors[0]?.code, "invalid-options");
  assert.equal(ownReads, 0);
});

test("own-data boundaries reject custom prototypes and define cross-realm policy", () => {
  const crafted = Object.assign(Object.create(Object.create(null)), {
    position: "bottom-right",
  }) as PeeklingOptions;
  const topLevel = preflight(crafted);
  assert.equal(topLevel.valid, false);
  assert.equal(topLevel.errors[0]?.code, "invalid-options");

  const nestedPlan = Object.assign(Object.create(Object.create(null)), {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
  }) as Plan;
  const nested = preflight({ plan: nestedPlan });
  assert.equal(nested.valid, false);
  assert.equal(nested.errors[0]?.code, "invalid-options");

  const inheritedPack = copyManifest() as unknown as Record<string, unknown>;
  inheritedPack.states = Object.assign(
    Object.create(Object.create(null)),
    inheritedPack.states,
  );
  assert.throws(() => validateNativePack(inheritedPack), PackValidationError);

  const inheritedPayload = Object.assign(Object.create(Object.create(null)), {
    progress: 42,
  });
  assert.throws(() => validateEventPayload(inheritedPayload), TypeError);

  const nullPrototype = Object.assign(Object.create(null), {
    character: "peek",
    position: "bottom-right",
  }) as PeeklingOptions;
  assert.equal(preflight(nullPrototype).valid, true);

  const foreignOrdinary = runInNewContext("({ position: 'bottom-right' })");
  const foreignResult = preflight(foreignOrdinary as PeeklingOptions);
  assert.equal(foreignResult.valid, false);
  assert.equal(foreignResult.errors[0]?.code, "invalid-options");

  const foreignNullPrototype = runInNewContext(
    "Object.assign(Object.create(null), { character: 'peek', position: 'bottom-right' })",
  );
  assert.equal(preflight(foreignNullPrototype as PeeklingOptions).valid, true);
});

test("native pack validation rejects accessors without executing them", () => {
  const pack = copyManifest() as unknown as Record<string, unknown>;
  let formatReads = 0;
  Object.defineProperty(pack, "format", {
    enumerable: true,
    get() {
      formatReads += 1;
      return 1;
    },
  });
  assert.throws(() => validateNativePack(pack), PackValidationError);
  assert.equal(formatReads, 0);

  const frames = [0] as number[];
  let frameReads = 0;
  Object.defineProperty(frames, "0", {
    enumerable: true,
    get() {
      frameReads += 1;
      return 0;
    },
  });
  const nested = copyManifest();
  nested.states.idle.frames = frames;
  assert.throws(() => validateNativePack(nested), PackValidationError);
  assert.equal(frameReads, 0);

  const trapped = new Proxy(copyManifest(), {
    getOwnPropertyDescriptor() {
      throw new Error("descriptor trap failed");
    },
  });
  assert.throws(() => validateNativePack(trapped), PackValidationError);
});

test("inline Pack data is structurally snapshotted once across loader validation", async () => {
  const input = copyManifest();
  const nativeOwnKeys = Reflect.ownKeys;
  let rootInspections = 0;
  Reflect.ownKeys = (target) => {
    if (
      Object.getOwnPropertyDescriptor(target, "format")?.value === 1 &&
      Object.getOwnPropertyDescriptor(target, "name")?.value ===
        "engine-fixture"
    ) {
      rootInspections += 1;
    }
    return nativeOwnKeys(target);
  };
  try {
    const loaded = await loadNativeFixture(pngFixture(512, 96), {
      pack: input,
    });
    const value = await loaded.result;
    value.release();
  } finally {
    Reflect.ownKeys = nativeOwnKeys;
  }

  assert.equal(rootInspections, 1);
  const trusted = snapshotPackData(input);
  assert.strictEqual(snapshotPackData(trusted), trusted);
});

test("event payload validation rejects accessors without executing them", () => {
  let reads = 0;
  const payload: Record<string, unknown> = {};
  Object.defineProperty(payload, "progress", {
    enumerable: true,
    get() {
      reads += 1;
      return 42;
    },
  });
  assert.throws(() => validateEventPayload(payload), TypeError);
  assert.equal(reads, 0);
});

test("native atlas headers are bounded and validated before browser decode", async () => {
  const cases = [
    {
      name: "invalid PNG signature",
      bytes: (() => {
        const bytes = pngFixture(512, 96);
        bytes[0] = 0;
        return bytes;
      })(),
      message: /Invalid PNG signature/,
    },
    {
      name: "truncated PNG",
      bytes: pngFixture(512, 96).slice(0, 32),
      message: /truncated/i,
    },
    {
      name: "oversized native dimensions",
      bytes: pngFixture(1_000_000, 96),
      message: /dimensions|4096/i,
    },
    {
      name: "declared geometry mismatch",
      bytes: pngFixture(4096, 4096),
      message: /512x96/,
    },
    {
      name: "native atlas without alpha",
      bytes: pngFixture(512, 96, 2),
      message: /alpha/i,
    },
  ];

  for (const fixture of cases) {
    const loaded = await loadNativeFixture(fixture.bytes);
    await assert.rejects(loaded.result, fixture.message, fixture.name);
    assert.equal(loaded.objectUrls(), 0, `${fixture.name} reached Blob decode`);
    assert.deepEqual(loaded.revoked, []);
  }
});

test("native indexed PNG alpha matches the pack contract", async () => {
  const loaded = await loadNativeFixture(indexedAlphaPngFixture(512, 96));
  const pack = await loaded.result;
  assert.equal(pack.content.name, "engine-fixture");
  pack.release();
  assert.deepEqual(loaded.revoked, ["blob:fixture:1"]);
});

test("normalized WebP dimensions are bounded before browser decode", async () => {
  const normalized = {
    name: "webp-fixture",
    displayName: "WebP fixture",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: "atlas.webp",
      sha256: "0".repeat(64),
      columns: 1,
      rows: 1,
      cellWidth: 1,
      cellHeight: 1,
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
  const loaded = await loadNativeFixture(webpVp8xFixture(1_000_000, 1), {
    pack: normalized,
    atlasUrl: "https://assets.example/atlas.webp",
    fetch: (async () =>
      new Response(webpVp8xFixture(1_000_000, 1), {
        headers: { "content-type": "image/webp" },
      })) as typeof fetch,
  });
  await assert.rejects(loaded.result, /dimensions|4096/i);
  assert.equal(loaded.objectUrls(), 0);
});

test("atlas decode failure revokes its object URL and emits a bounded category", async () => {
  const diagnostics: Array<{ message: string; category: string | undefined }> =
    [];
  const listeners = new Map<string, EventListener>();
  const loaded = await loadNativeFixture(pngFixture(512, 96), {
    image: () =>
      ({
        addEventListener: (type: string, listener: EventListener) =>
          listeners.set(type, listener),
        removeEventListener: () => {},
        removeAttribute: () => {},
        set src(_value: string) {
          queueMicrotask(() => listeners.get("error")?.({} as Event));
        },
      }) as unknown as HTMLImageElement,
    diagnostic: (message, category?: string) =>
      diagnostics.push({ message, category }),
  });
  await assert.rejects(loaded.result, /Atlas decode failed/);
  assert.deepEqual(loaded.revoked, ["blob:fixture:1"]);
  assert.deepEqual(diagnostics, [
    {
      message: "Atlas 1x failed (decode); no fallback remains.",
      category: "decode",
    },
  ]);
});

test("atlas load faults report stable categories before allocation", async () => {
  const cases: Array<{
    name: string;
    expected: string;
    fetch: typeof fetch;
    pack?: NativeManifest;
    densityOverride?: 1 | 2 | 4;
    signal?: AbortSignal;
  }> = [
    {
      name: "HTTP",
      expected: "http",
      fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
    },
    {
      name: "MIME",
      expected: "mime",
      fetch: (async () =>
        new Response(pngFixture(512, 96), {
          headers: { "content-type": "text/plain" },
        })) as typeof fetch,
    },
    {
      name: "CORS or network",
      expected: "network",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    },
    {
      name: "hash",
      expected: "hash",
      pack: structuredClone(manifest),
      densityOverride: 1,
      fetch: (async () =>
        new Response(pngFixture(1024, 192), {
          headers: { "content-type": "image/png" },
        })) as typeof fetch,
    },
    {
      name: "abort",
      expected: "abort",
      signal: AbortSignal.abort(new DOMException("Stopped", "AbortError")),
      fetch: (async (_input, init) => {
        init?.signal?.throwIfAborted();
        throw new Error("unreachable");
      }) as typeof fetch,
    },
  ];

  for (const fixture of cases) {
    const diagnostics: Array<{
      message: string;
      category: string | undefined;
    }> = [];
    const loaded = await loadNativeFixture(pngFixture(512, 96), {
      ...(fixture.pack ? { pack: fixture.pack } : {}),
      ...(fixture.densityOverride
        ? { densityOverride: fixture.densityOverride }
        : {}),
      fetch: fixture.fetch,
      ...(fixture.signal ? { signal: fixture.signal } : {}),
      diagnostic: (message, category?: string) =>
        diagnostics.push({ message, category }),
    });
    await assert.rejects(loaded.result, undefined, fixture.name);
    assert.equal(loaded.objectUrls(), 0, fixture.name);
    assert.deepEqual(diagnostics, [
      {
        message:
          fixture.expected === "abort"
            ? "Atlas load aborted."
            : `Atlas 1x failed (${fixture.expected}); no fallback remains.`,
        category: fixture.expected,
      },
    ]);
  }
});

test("abort during browser decode detaches the image and revokes the URL", async () => {
  const controller = new AbortController();
  const listeners = new Map<string, EventListener>();
  let removed = 0;
  const diagnostics: string[] = [];
  const loaded = await loadNativeFixture(pngFixture(512, 96), {
    signal: controller.signal,
    image: () =>
      ({
        addEventListener: (type: string, listener: EventListener) =>
          listeners.set(type, listener),
        removeEventListener: () => {},
        removeAttribute: (name: string) => {
          if (name === "src") removed += 1;
        },
        set src(_value: string) {
          queueMicrotask(() => controller.abort());
        },
      }) as unknown as HTMLImageElement,
    diagnostic: (_message, category?: string) =>
      diagnostics.push(category ?? "unknown"),
  });
  await assert.rejects(loaded.result, (error) => {
    return error instanceof DOMException && error.name === "AbortError";
  });
  assert.equal(removed, 1);
  assert.deepEqual(loaded.revoked, ["blob:fixture:1"]);
  assert.deepEqual(diagnostics, ["abort"]);
});

test("Web Component delegates connect, property updates, and disconnect to hatch", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const overrides: unknown[] = [];
  const instances: Array<{ destroyed: boolean }> = [];
  class ElementFixture {
    isConnected = false;
    readonly attributes = new Map<string, string>();
    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }
    dispatchEvent(): boolean {
      return true;
    }
  }
  let ElementClass: CustomElementConstructor | undefined;
  let defineCalls = 0;
  const registry = {
    get: () => ElementClass,
    define: (_name: string, constructor: CustomElementConstructor) => {
      defineCalls += 1;
      ElementClass = constructor;
    },
  } as unknown as CustomElementRegistry;
  const descriptors = {
    customElements: Object.getOwnPropertyDescriptor(
      globalThis,
      "customElements",
    ),
    HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
  };
  const originalHatch = PeeklingRuntime.hatch;
  Object.defineProperty(globalThis, "customElements", {
    configurable: true,
    value: registry,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: ElementFixture,
  });
  PeeklingRuntime.hatch = ((options) => {
    calls.push(options as Record<string, unknown>);
    const state = { destroyed: false };
    instances.push(state);
    return {
      ready: Promise.resolve(),
      override: (value: unknown) => {
        overrides.push(value);
        return {
          id: "override:test",
          status: "active",
          finished: Promise.resolve({
            id: "override:test",
            reason: "cancelled",
          }),
          cancel: () => {},
        };
      },
      destroy: () => {
        state.destroyed = true;
      },
    } as unknown as PeeklingRuntime;
  }) as typeof PeeklingRuntime.hatch;
  try {
    definePeeklingElement();
    assert.ok(ElementClass);
    assert.doesNotThrow(() => definePeeklingElement());
    assert.equal(defineCalls, 1);
    const element = new ElementClass() as HTMLElement & {
      attributes: Map<string, string>;
      options: PeeklingOptions;
      content: HostContent;
      bindings: { mounts: Record<string, () => { cleanup(): void }> };
      accessibility: { announceContent: boolean };
      diagnostics: { console: boolean };
      logger: () => void;
      ready: Promise<PeeklingInstance>;
      isConnected: boolean;
      plan: Plan;
      attributeChangedCallback(
        name: string,
        previous: string | null,
        next: string | null,
      ): void;
      connectedCallback(): void;
      disconnectedCallback(): void;
      override(value: unknown): { id: string };
    };
    element.attributes.set("character", "moss");
    element.attributes.set(
      "pack-url",
      "https://static.example/moss/1/character.json",
    );
    element.attributes.set("name", "");
    element.options = { format: 1, position: "center", scale: 2 };
    element.plan = {
      baseline: { channels: ["state"], state: { state: "idle" } },
    };
    element.content = { greeting: { "top-center": "Hello" } };
    element.bindings = { mounts: { card: () => ({ cleanup: () => {} }) } };
    element.accessibility = { announceContent: true };
    element.diagnostics = { console: false };
    element.logger = () => {};
    element.isConnected = true;
    element.connectedCallback();
    await element.ready;
    assert.equal(
      element.override({
        effect: { channels: ["state"], state: { state: "idle" } },
      }).id,
      "override:test",
    );
    assert.equal(overrides.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
      format: 1,
      position: "center",
      scale: 2,
      character: "moss",
      packUrl: "https://static.example/moss/1/character.json",
      plan: {
        baseline: { channels: ["state"], state: { state: "idle" } },
      },
      content: { greeting: { "top-center": "Hello" } },
      bindings: { mounts: {} },
      accessibility: { announceContent: true },
      diagnostics: { console: false },
      name: true,
    });
    assert.equal(
      (
        calls[0]?.bindings as {
          mounts: { card: () => { cleanup(): void } };
        }
      ).mounts.card,
      element.bindings.mounts.card,
    );
    assert.equal(calls[0]?.logger, element.logger);
    element.attributes.set("character", "fern");
    element.attributeChangedCallback("character", "moss", "fern");
    element.attributes.set(
      "pack-url",
      "https://static.example/fern/1/character.json",
    );
    element.attributeChangedCallback(
      "pack-url",
      "https://static.example/moss/1/character.json",
      "https://static.example/fern/1/character.json",
    );
    await element.ready;
    assert.equal(instances[0]?.destroyed, true);
    assert.equal(calls.length, 2, "same-turn attribute changes mount once");
    assert.equal(calls[1]?.character, "fern");
    assert.equal(
      calls[1]?.packUrl,
      "https://static.example/fern/1/character.json",
    );
    element.disconnectedCallback();
    assert.equal(instances[1]?.destroyed, true);
    element.connectedCallback();
    await element.ready;
    assert.equal(calls.length, 3);
    element.disconnectedCallback();
    assert.equal(instances[2]?.destroyed, true);

    let getterReads = 0;
    const hostile = new ElementClass() as HTMLElement & {
      options: PeeklingOptions;
      ready: Promise<PeeklingInstance>;
      isConnected: boolean;
      connectedCallback(): void;
      disconnectedCallback(): void;
    };
    const hostileOptions = Object.create(null) as PeeklingOptions;
    Object.defineProperty(hostileOptions, "character", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("top-level getter executed");
      },
    });
    assert.doesNotThrow(() => {
      hostile.options = hostileOptions;
    });
    hostile.isConnected = true;
    hostile.connectedCallback();
    await assert.rejects(hostile.ready, { name: "OwnDataError" });
    assert.equal(getterReads, 0);
    assert.equal(hostile.instance, undefined);

    hostile.options = { format: 1, pack: manifest };
    await hostile.ready;
    assert.equal(
      Object.hasOwn(calls.at(-1) ?? {}, "character"),
      false,
      "inline packs do not receive an implicit character selection",
    );
    hostile.disconnectedCallback();
    assert.equal(PEEKLING_ELEMENT_TAG, "peekling-character");
  } finally {
    PeeklingRuntime.hatch = originalHatch;
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("explicit Web Component registration preserves a foreign element and reports the collision", () => {
  class ForeignElement {}
  const collisions: unknown[] = [];
  const descriptors = {
    customElements: Object.getOwnPropertyDescriptor(
      globalThis,
      "customElements",
    ),
    HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
    CustomEvent: Object.getOwnPropertyDescriptor(globalThis, "CustomEvent"),
    dispatchEvent: Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent"),
  };
  Object.defineProperty(globalThis, "customElements", {
    configurable: true,
    value: {
      get: () => ForeignElement,
      define: () => {
        throw new Error("foreign element must not be replaced");
      },
    },
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: class {},
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: class {
      readonly type: string;
      readonly detail: unknown;
      constructor(type: string, init: { detail: unknown }) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  });
  Object.defineProperty(globalThis, "dispatchEvent", {
    configurable: true,
    value: (event: { type: string; detail: unknown }) => {
      collisions.push({ type: event.type, detail: event.detail });
      return true;
    },
  });
  try {
    assert.doesNotThrow(() => definePeeklingElement());
    assert.equal(
      globalThis.customElements.get(PEEKLING_ELEMENT_TAG),
      ForeignElement,
    );
    assert.deepEqual(collisions, [
      {
        type: "peekling:collision",
        detail: "peekling-character",
      },
    ]);
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("initial positions default safely and accept finite CSS coordinates", () => {
  assert.deepEqual(resolveInitialPosition("bottom-right", 800, 600, 64, 64), {
    x: 752,
    y: 552,
  });
  assert.deepEqual(resolveInitialPosition("bottom-left", 800, 600, 64, 64), {
    x: 48,
    y: 552,
  });
  assert.deepEqual(resolveInitialPosition("center", 800, 600, 64, 64), {
    x: 400,
    y: 300,
  });
  assert.deepEqual(resolveInitialPosition("center", 40, 200, 64, 64), {
    x: 32,
    y: 100,
  });
  assert.deepEqual(resolveInitialPosition("bottom-right", 40, 40, 64, 64), {
    x: 32,
    y: 32,
  });
  assert.deepEqual(resolveInitialPosition("bottom-left", 40, 40, 64, 64), {
    x: 32,
    y: 32,
  });
  assert.deepEqual(
    resolveInitialPosition({ x: -10, y: 900 }, 800, 600, 64, 64),
    {
      x: 32,
      y: 568,
    },
  );
  assert.throws(
    () => resolveInitialPosition({ x: Number.NaN, y: 20 }, 800, 600, 64, 64),
    /finite CSS pixels/,
  );
});

test("site visibility durations persist locally, session-only, and fail open", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
  const window = {
    localStorage: storage,
    sessionStorage: storage,
  } as unknown as Window;
  const document = {} as Document;

  hidePeekling("10-minutes", document, window);
  assert.equal(isPeeklingHidden(window), true);
  const preference = JSON.parse(values.get("peekling:site-preference")!);
  assert.equal(preference.visibility, "hidden");
  assert.ok(preference.until > Date.now());

  showPeekling(document, window);
  assert.equal(isPeeklingHidden(window), false);
  hidePeekling("session", document, window);
  assert.equal(values.get("peekling:hidden-session"), "1");
  assert.equal(isPeeklingHidden(window), true);

  values.clear();
  values.set("peekling:site-preference", "not json");
  assert.equal(isPeeklingHidden(window), false);
  assert.throws(
    () => hidePeekling("week" as never, document, window),
    /Invalid Peekling hide duration/,
  );
});

test("retired simple-behavior options are rejected as unknown fields", () => {
  const browser = {
    document: {} as Document,
    window: {} as Window,
  };
  for (const pointerPadding of [-1, 0, 10_001]) {
    assert.throws(
      () => new PeeklingRuntime({ ...browser, pointerPadding }),
      Error,
    );
  }
  assert.throws(
    () =>
      new PeeklingRuntime({
        ...browser,
        touchReactions: { swipe: "happy" } as never,
      }),
    /Unknown field touchReactions/,
  );
  assert.throws(
    () =>
      new PeeklingRuntime({
        ...browser,
        touchReactions: { click: "<script>" },
      }),
    /Unknown field touchReactions/,
  );
});

test("federated pack URLs allow relative paths or absolute HTTPS only", () => {
  assert.equal(
    resolveManifestUrl(
      "https://assets.example/packs/moss/character.json",
      "https://site.example/page",
    ),
    "https://assets.example/packs/moss/character.json",
  );
  assert.equal(
    resolveManifestUrl("./moss/character.json", "http://127.0.0.1:4173/demo"),
    "http://127.0.0.1:4173/moss/character.json",
  );
  assert.throws(
    () =>
      resolveManifestUrl(
        "http://assets.example/pack.json",
        "https://site.example/",
      ),
    /Relative path or HTTPS/,
  );
  assert.throws(
    () =>
      resolveManifestUrl(
        "http://127.0.0.1:4173/moss/character.json",
        "http://127.0.0.1:4173/demo",
      ),
    /Relative path or HTTPS/,
  );
  for (const url of ["data:application/json,{}", "javascript:alert(1)"])
    assert.throws(
      () => resolveManifestUrl(url, "https://site.example/"),
      PackValidationError,
    );
});

test("validates the complete native profile and rejects unknown fields", () => {
  const input = copyManifest() as NativeManifest & { future?: unknown };
  input.future = { rendererCode: "not interpreted" };
  assert.throws(() => validateNativePack(input), /future is not allowed/);
  const pack = validateNativePack(copyManifest(), {
    width: 512,
    height: 96,
    byteLength: 3808,
  });
  assert.equal(pack.atlas.cellWidth, 32);
  assert.equal(pack.atlas.columns, 16);
  assert.equal(pack.defaultScale, 2);
  assert.equal(pack.displayName, "Engine fixture");
  assert.equal(pack.states["move:NW"]?.frames[0], 15);
  assert.equal(pack.directionalStates?.NW, "move:NW");
});

test("normalized adapter IR is closed, timed exactly, and keeps opaque source", () => {
  const value = {
    name: "adapter-pack",
    displayName: "Adapter pack",
    version: "1.2.3",
    license: "CC0-1.0",
    atlas: {
      src: "atlas.webp",
      sha256: "0".repeat(64),
      columns: 2,
      rows: 2,
      cellWidth: 32,
      cellHeight: 32,
    },
    states: { idle: { frames: [0, 1], loop: true, durations: [100, 200] } },
    defaultScale: 1,
    source: { adapter: "fixture", revision: 1 },
  };
  const pack = validateNormalizedPack(value, { width: 64, height: 64 });
  assert.deepEqual(pack.states.idle?.durations, [100, 200]);
  assert.deepEqual(pack.source, { adapter: "fixture", revision: 1 });
  assert.throws(
    () =>
      validateNormalizedPack({
        ...value,
        states: {
          idle: { frames: [0, 1], loop: true, durations: [100] },
        },
      }),
    /durations must match frames/,
  );
  assert.throws(
    () => validateNormalizedPack({ ...value, future: true }),
    /future is not allowed/,
  );
});

test("normalized density selection validates the selected candidate geometry", () => {
  const value = {
    name: "adaptive-pack",
    displayName: "Adaptive pack",
    version: "1.2.3",
    license: "CC0-1.0",
    atlas: {
      src: "atlas-1x.webp",
      columns: 2,
      rows: 2,
      cellWidth: 32,
      cellHeight: 32,
      logicalWidth: 32,
      logicalHeight: 32,
      density: 1,
      variants: [
        {
          src: "atlas-1x.webp",
          density: 1,
          cellWidth: 32,
          cellHeight: 32,
          sha256: "1".repeat(64),
        },
        {
          src: "atlas-2x.webp",
          density: 2,
          cellWidth: 64,
          cellHeight: 64,
          sha256: "2".repeat(64),
        },
      ],
    },
    states: { idle: { frames: [0, 1], loop: true, durations: [100, 200] } },
    defaultScale: 1,
  };
  const selected = validateNormalizedPack(
    value,
    { width: 128, height: 128 },
    2,
  );
  assert.equal(selected.atlas.src, "atlas-2x.webp");
  assert.equal(selected.atlas.density, 2);
  assert.equal(selected.atlas.cellWidth, 64);
  assert.equal(selected.atlas.logicalWidth, 32);
  assert.throws(
    () => validateNormalizedPack(value, { width: 64, height: 64 }, 2),
    /128x128/,
  );
});

test("normalized loader falls back and later upgrades with candidate metadata", async () => {
  const png1x = pngFixture(64, 64);
  const png2x = pngFixture(128, 128);
  const hash1x = createHash("sha256").update(png1x).digest("hex");
  const hash2x = createHash("sha256").update(png2x).digest("hex");
  const raw = {
    name: "adaptive-pack",
    displayName: "Adaptive pack",
    version: "1.2.3",
    license: "CC0-1.0",
    atlas: {
      src: "atlas-1x.png",
      columns: 2,
      rows: 2,
      cellWidth: 32,
      cellHeight: 32,
      logicalWidth: 32,
      logicalHeight: 32,
      density: 1,
      variants: [
        {
          src: "atlas-1x.png",
          density: 1,
          cellWidth: 32,
          cellHeight: 32,
          sha256: hash1x,
        },
        {
          src: "atlas-2x.png",
          density: 2,
          cellWidth: 64,
          cellHeight: 64,
          sha256: hash2x,
        },
      ],
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
  let twoXAttempts = 0;
  let fetched = "";
  let objectId = 0;
  const geometry = new Map<string, { width: number; height: number }>();
  const revoked: string[] = [];
  const loaded = await loadNativePack({
    character: "adaptive-pack",
    baseUrl: "https://app.example/",
    pack: raw,
    packUrl: "https://assets.example/character.json",
    renderScale: 1,
    devicePixelRatio: 2,
    fetch: (async (input: RequestInfo | URL) => {
      fetched = String(input);
      if (fetched.endsWith("atlas-2x.png") && twoXAttempts++ === 0) {
        return new Response(null, { status: 503 });
      }
      return new Response(fetched.endsWith("atlas-2x.png") ? png2x : png1x, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch,
    image: () => {
      const listeners = new Map<string, EventListener>();
      const image = {
        naturalWidth: 0,
        naturalHeight: 0,
        addEventListener: (type: string, listener: EventListener) =>
          listeners.set(type, listener),
        removeEventListener: () => {},
        removeAttribute: () => {},
        set src(value: string) {
          const size = geometry.get(value)!;
          this.naturalWidth = size.width;
          this.naturalHeight = size.height;
          queueMicrotask(() => listeners.get("load")?.({} as Event));
        },
      };
      return image as unknown as HTMLImageElement;
    },
    signal: new AbortController().signal,
    createObjectURL: () => {
      const value = `blob:fixture:${++objectId}`;
      geometry.set(
        value,
        fetched.endsWith("atlas-2x.png")
          ? { width: 128, height: 128 }
          : { width: 64, height: 64 },
      );
      return value;
    },
    revokeObjectURL: (value) => revoked.push(value),
  });
  assert.equal(loaded.loadedDensity, 1);
  assert.equal(loaded.content.atlas.src, "atlas-1x.png");
  assert.equal(await loaded.upgrade(2), true);
  assert.equal(loaded.loadedDensity, 2);
  assert.equal(loaded.content.atlas.src, "atlas-2x.png");
  assert.equal(loaded.content.atlas.logicalWidth, 32);
  loaded.release();
  assert.equal(revoked.length, 2);
});

test("compact browser validator enforces the native security boundary", () => {
  assert.equal(
    validateNativePack(copyManifest(), {
      width: 512,
      height: 96,
      byteLength: 3808,
    }).name,
    "engine-fixture",
  );
  const unsafe = copyManifest();
  unsafe.assets.atlas.src = "../atlas.png";
  assert.throws(() => validateNativePack(unsafe), /assets\.atlas/);
  const incomplete = copyManifest();
  delete incomplete.states["move:SW"];
  assert.throws(
    () => validateNativePack(incomplete),
    /locomotion\.directions\.SW/,
  );
  assert.throws(
    () => validateNativePack(copyManifest(), { width: 512, height: 64 }),
    /atlas must be exactly/,
  );
  const missingDescription = copyManifest() as unknown as Record<
    string,
    unknown
  >;
  delete missingDescription.metadata;
  assert.throws(() => validateNativePack(missingDescription), /metadata/);
});

test("rejects unsafe paths, invalid geometry, scale, bounds, and missing mandatory states", () => {
  const cases: Array<[string, (value: NativeManifest) => void, RegExp]> = [
    [
      "path",
      (value) => (value.assets.atlas.src = "../atlas.png"),
      /relative in-pack PNG/,
    ],
    [
      "scale",
      (value) => (value.defaults!.scale = 1.5),
      /integer from 1 through 4/,
    ],
    [
      "missing",
      (value) => delete value.states["move:NE"],
      /directions\.NE must name a valid state/,
    ],
    ["cycle", (value) => (value.states["move:E"]!.frames = [999]), /in-bounds/],
    ["bounds", (value) => (value.states.idle!.frames = [999]), /in-bounds/],
  ];
  for (const [name, mutate, expected] of cases) {
    const input = copyManifest();
    mutate(input);
    assert.throws(() => validateNativePack(input), expected, name);
  }
  assert.throws(
    () => validateNativePack(copyManifest(), { width: 256, height: 96 }),
    /512x96/,
  );
});

test("declarative locomotion accepts artist-named states and interpolates safely", () => {
  const input = copyManifest();
  const directions = input.capabilities!.locomotion!.directions;
  for (const direction of Object.keys(directions) as Array<
    keyof typeof directions
  >) {
    const previous = directions[direction];
    const next = `glide:${direction}`;
    input.states[next] = input.states[previous]!;
    delete input.states[previous];
    directions[direction] = next;
  }
  input.capabilities!.locomotion!.motion = {
    keyframes: [
      { at: 0, advance: 0, lift: 0 },
      { at: 0.5, advance: 0.8, lift: 0.25 },
      { at: 1, advance: 1, lift: 0 },
    ],
  };
  const pack = validateNativePack(input);
  assert.equal(pack.directionalStates?.SW, "glide:SW");
  assert.deepEqual(locomotionSample(pack.locomotionMotion, 0.25), {
    advance: 0.4,
    lift: 0.125,
  });
  assert.ok(
    Math.abs(locomotionAdvance(pack.locomotionMotion, 0.25, 1.25) - 1) <
      Number.EPSILON,
  );
});

test("locomotion cycle boundaries use the authored cycle distance", () => {
  const motion = [
    { at: 0, advance: 0, lift: 0 },
    { at: 0.5, advance: 0.25, lift: 0.1 },
    { at: 1, advance: 0.5, lift: 0 },
  ];
  assert.ok(locomotionAdvance(motion, 0.9, 1.1) > 0);
  assert.equal(locomotionAdvance(motion, 0, 2), 1);
});

test("locomotion rejects hostile timelines and never infers undeclared capabilities", () => {
  for (const mutate of [
    (value: NativeManifest) =>
      (value.capabilities!.locomotion!.motion = {
        keyframes: [
          { at: 0, advance: 0, lift: 0 },
          { at: 0.6, advance: 0.8, lift: 0.1 },
          { at: 0.5, advance: 1, lift: 0 },
        ],
      }),
    (value: NativeManifest) =>
      (value.capabilities!.locomotion!.motion = {
        keyframes: [
          { at: 0, advance: 0, lift: 0 },
          { at: 1, advance: 1, lift: Number.POSITIVE_INFINITY },
        ],
      }),
    (value: NativeManifest) =>
      (value.capabilities!.locomotion!.motion = {
        keyframes: Array.from({ length: 9 }, (_, index) => ({
          at: index / 8,
          advance: index / 8,
          lift: 0,
        })),
      }),
  ]) {
    const value = copyManifest();
    mutate(value);
    assert.throws(() => validateNativePack(value), PackValidationError);
  }

  const withoutCapability = copyManifest();
  delete withoutCapability.capabilities;
  assert.equal(
    validateNativePack(withoutCapability).directionalStates,
    undefined,
  );
});

test("mixed valid and invalid motion keyframes report pack issues", () => {
  const keyframes = [
    { at: 0, advance: 0, lift: 0 },
    { at: "invalid", advance: 0.5, lift: 0 },
    { at: 1, advance: 1, lift: 0 },
  ];
  const native = copyManifest();
  native.capabilities!.locomotion!.motion = {
    keyframes: keyframes as unknown as NonNullable<
      NonNullable<NativeManifest["capabilities"]>["locomotion"]
    >["motion"]["keyframes"],
  };
  const normalized = {
    name: "mixed-motion-pack",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: "atlas.png",
      sha256: "0".repeat(64),
      columns: 1,
      rows: 1,
      cellWidth: 32,
      cellHeight: 32,
    },
    states: { idle: { frames: [0], loop: true, fps: 1 } },
    defaultScale: 1,
    locomotionMotion: keyframes,
  };

  for (const [label, validate, issuePath] of [
    [
      "native",
      () => validateNativePack(native),
      "capabilities.locomotion.motion.keyframes.1",
    ],
    [
      "normalized",
      () => validateNormalizedPack(normalized),
      "locomotionMotion.1",
    ],
  ] as const) {
    assert.throws(
      validate,
      (error: unknown) => {
        assert.ok(error instanceof PackValidationError, label);
        assert.ok(
          error.issues.some((issue) => issue.includes(issuePath)),
          `${label} did not report ${issuePath}`,
        );
        return true;
      },
      label,
    );
  }
});

test("manifest parsing enforces JSON and byte limits", () => {
  assert.throws(() => parseManifestText("{"), PackValidationError);
  assert.throws(
    () => parseManifestText(`"${"x".repeat(65 * 1024)}"`),
    /exceeds/,
  );
  assert.throws(
    () => parseManifestText('{"format":1,"format":1}'),
    /duplicate object key "format"/,
  );
});

test("validator rejects hostile object shapes, names, paths, and numeric values", () => {
  assert.throws(() => validateNativePack(null), /object/);
  for (const mutate of [
    (value: NativeManifest) => (value.assets.atlas.src = "猫.png"),
    (value: NativeManifest) => (value.states.idle!.fps = Number.NaN),
    (value: NativeManifest) =>
      (value.states.idle!.fps = Number.POSITIVE_INFINITY),
    (value: NativeManifest) =>
      Object.defineProperty(value.states, "__proto__", {
        value: { frames: [0], fps: 1, loop: true },
        enumerable: true,
      }),
  ]) {
    const value = copyManifest();
    mutate(value);
    assert.throws(() => validateNativePack(value), PackValidationError);
  }
  const missingDescription = copyManifest() as unknown as Record<
    string,
    unknown
  >;
  delete missingDescription.metadata;
  assert.throws(
    () => validateNativePack(missingDescription),
    /metadata must be an object with a description/,
  );
  const descriptionUrl = copyManifest();
  descriptionUrl.metadata.description = "Visit https://example.test";
  assert.throws(
    () => validateNativePack(descriptionUrl),
    /metadata\.description must not contain a URL/,
  );
});

test("native packs accept 100 states and reject more than 128", () => {
  const supported = copyManifest();
  for (let index = Object.keys(supported.states).length; index < 100; index++)
    supported.states[`optional-${index}`] = {
      frames: [0],
      fps: 1,
      loop: true,
    };
  assert.equal(Object.keys(validateNativePack(supported).states).length, 100);

  const crowded = copyManifest();
  for (let index = Object.keys(crowded.states).length; index < 129; index++)
    crowded.states[`optional-${index}`] = { frames: [0], fps: 1, loop: true };
  assert.throws(() => validateNativePack(crowded), /1-128 entries/);
});

test("direction resolver covers all eight screen-space octants", () => {
  const origin = { x: 0, y: 0 };
  assert.deepEqual(
    [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ].map(([x, y]) => directionTo(origin, { x: x!, y: y! })),
    ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
  );
});

test("fallback resolution is exact, semantic alias, idle, then lexical", () => {
  const state = (frames: number[]) => ({ frames, fps: 1, loop: true });
  assert.equal(
    resolveState("success", { jumping: state([0]), idle: state([1]) }).name,
    "jumping",
  );
  assert.equal(resolveState("unknown", { idle: state([0]) }).name, "idle");
  assert.equal(resolveState("constructor", { idle: state([0]) }).name, "idle");
  assert.equal(
    resolveState(undefined, { zebra: state([0]), alpha: state([1]) }).name,
    "alpha",
  );
});

test("renderer frame selection supports fps, non-loop hold, and adapter durations", () => {
  assert.equal(frameAt({ frames: [2, 3], fps: 2, loop: true }, 600), 3);
  assert.equal(frameAt({ frames: [2, 3], fps: 2, loop: false }, 10_000), 3);
  assert.equal(
    frameAt({ frames: [4, 5], loop: true, durations: [100, 300] }, 250),
    5,
  );
});

test("renderer skips stable coordinate and transform writes", async () => {
  const attributeWrites = new Map<string, number>();
  let transformWrites = 0;
  let ruleStyle: Record<string, unknown> | undefined;

  class StyleFixture {
    [key: string]: unknown;

    get transform(): string {
      return (this.transformValue as string | undefined) ?? "";
    }

    set transform(value: string) {
      transformWrites++;
      this.transformValue = value;
    }
  }

  class SheetFixture {
    readonly cssRules: Array<{ style: StyleFixture }> = [];

    insertRule(_rule: string, index: number): number {
      const style = new StyleFixture();
      ruleStyle = style;
      this.cssRules.splice(index, 0, { style });
      return index;
    }

    deleteRule(index: number): void {
      this.cssRules.splice(index, 1);
    }
  }

  class ElementFixture {
    readonly tagName: string;
    readonly attributes = new Map<string, string>();
    readonly children: ElementFixture[] = [];
    parentNode: ElementFixture | null = null;
    ownerDocument!: Document;
    host?: ElementFixture;
    className = "";
    readonly sheet: SheetFixture | undefined;

    constructor(tagName: string) {
      this.tagName = tagName;
      this.sheet = tagName === "link" ? new SheetFixture() : undefined;
    }

    append(...children: ElementFixture[]): void {
      for (const child of children) child.parentNode = this;
      this.children.push(...children);
    }

    attachShadow(): ElementFixture {
      const root = new ElementFixture("shadow-root");
      root.ownerDocument = this.ownerDocument;
      root.host = this;
      this.children.push(root);
      return root;
    }

    addEventListener(type: string, listener: EventListener): void {
      if (this.tagName === "link" && type === "load") {
        queueMicrotask(() => listener({} as Event));
      }
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
      attributeWrites.set(name, (attributeWrites.get(name) ?? 0) + 1);
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }

    hasAttribute(name: string): boolean {
      return this.attributes.has(name);
    }

    toggleAttribute(name: string, force: boolean): void {
      if (force) this.attributes.set(name, "");
      else this.attributes.delete(name);
    }

    getRootNode(): ElementFixture {
      let current: ElementFixture = this;
      while (current.parentNode) current = current.parentNode;
      return current;
    }

    remove(): void {
      this.parentNode = null;
    }
  }

  const documentElement = new ElementFixture("html");
  const document = {
    documentElement,
    createElement: (tagName: string) => {
      const element = new ElementFixture(tagName);
      element.ownerDocument = document;
      return element;
    },
  } as unknown as Document;
  documentElement.ownerDocument = document;
  const renderer = new AtlasRenderer(
    document,
    {
      atlas: {
        src: "atlas.png",
        sha256: "0".repeat(64),
        columns: 1,
        rows: 1,
        cellWidth: 32,
        cellHeight: 32,
        density: 1,
      },
      states: { idle: { frames: [0], fps: 1, loop: true } },
    } as never,
    "blob:atlas",
    1,
    { url: "https://site.example/peekling.css" },
  );
  await renderer.ready;
  renderer.render("idle", 0, { x: 100, y: 100 });
  const stableWrites = {
    x: attributeWrites.get("data-peekling-x"),
    y: attributeWrites.get("data-peekling-y"),
    transform: transformWrites,
  };

  renderer.render("idle", 16, { x: 100, y: 100 });

  assert.deepEqual(
    {
      x: attributeWrites.get("data-peekling-x"),
      y: attributeWrites.get("data-peekling-y"),
      transform: transformWrites,
    },
    stableWrites,
  );
  assert.equal(ruleStyle?.transformValue, "translate3d(84px,84px,0) scale(1)");
  renderer.render("idle", 32, { x: 101, y: 100 });
  assert.equal(attributeWrites.get("data-peekling-x"), stableWrites.x! + 1);
  assert.equal(attributeWrites.get("data-peekling-y"), stableWrites.y);
  assert.equal(transformWrites, stableWrites.transform + 1);
  renderer.destroy();
  assert.doesNotThrow(() => renderer.render("idle", 48, { x: 102, y: 100 }));
  assert.equal(
    renderer.host.parentNode,
    null,
    "a destroyed character root cannot reconnect",
  );
});

test("native density variants preserve logical geometry and select the smallest adequate source", () => {
  const input = copyManifest() as unknown as Record<string, unknown>;
  const singleAtlas = (input.assets as { atlas: { rows: number } }).atlas;
  input.assets = {
    atlases: {
      columns: 16,
      rows: singleAtlas.rows,
      logicalCellSize: 64,
      lineage: "peek-hd-source-v1",
      variants: [1, 2, 4].map((density) => ({
        src: `atlas-${density}x.png`,
        density,
        sourceCellSize: 64 * density,
        sha256: String(density).repeat(64),
      })),
    },
  };
  for (const [required, expected] of [
    [1, 1],
    [1.25, 2],
    [2, 2],
    [3, 4],
    [4, 4],
  ] as const) {
    const pack = validateNativePack(input, undefined, required);
    assert.equal(pack.atlas.density, expected);
    assert.equal(pack.atlas.logicalWidth, 64);
    assert.equal(pack.atlas.cellWidth, 64 * expected);
  }
  assert.equal(selectNativeDensity([1, 2, 4], 1.25), 2);
  assert.equal(selectNativeDensity([1, 2], 3), 2);
  assert.throws(
    () =>
      validateNativePack({
        ...input,
        assets: {
          atlases: {
            ...(input.assets as { atlases: Record<string, unknown> }).atlases,
            variants: [
              {
                src: "atlas-4x.png",
                density: 4,
                sourceCellSize: 128,
                sha256: "4".repeat(64),
              },
            ],
          },
        },
      }),
    /sourceCellSize/,
  );
});

test("effective density accounts for DPR and render scale while device-pixel snapping is bounded", () => {
  assert.equal(requiredAtlasDensity(1, 1), 1);
  assert.equal(requiredAtlasDensity(1.25, 1), 1.25);
  assert.equal(requiredAtlasDensity(2, 2), 4);
  assert.equal(requiredAtlasDensity(3, 2), 4);
  assert.equal(requiredAtlasDensity(3, 1, 2), 2);
  for (const dpr of [1, 1.25, 1.5, 2, 3, 4]) {
    const original = 42.37;
    const snapped = snapToDevicePixel(original, dpr);
    assert.equal(Number.isInteger(snapped * dpr), true);
    assert.ok(Math.abs(snapped - original) <= 0.5 / dpr + Number.EPSILON);
    assert.equal(snapToDevicePixel(-original, dpr), -snapped);
  }
});
