import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PackLoadError, PackValidationError } from "../dist/errors.js";
import { loadNativePack } from "../dist/loader.js";
import { validateNormalizedPack } from "../dist/normalized.js";
import { validateNativePack } from "../dist/pack.js";
import type { NativeManifest } from "../dist/types.js";

function nativeManifest(): NativeManifest {
  return {
    format: 1,
    name: "loader-fixture",
    version: "0.1.0",
    license: "CC0-1.0",
    metadata: {
      description: "A synthetic data-only loader fixture.",
    },
    assets: {
      atlas: {
        src: "atlas.png",
        sha256: createHash("sha256").update(pngFixture(512, 64)).digest("hex"),
        columns: 16,
        rows: 2,
        density: 1,
        logicalCellSize: 32,
        sourceCellSize: 32,
      },
    },
    states: {
      idle: { frames: [0], fps: 1, loop: true },
    },
    defaults: { scale: 1 },
  };
}

function adaptiveNormalizedFixture() {
  const oneX = pngFixture(64, 64, 1);
  const twoX = pngFixture(128, 128, 2);
  const fourX = pngFixture(256, 256, 4);
  const hash = (bytes: Uint8Array<ArrayBuffer>) =>
    createHash("sha256").update(bytes).digest("hex");
  return {
    oneX,
    twoX,
    fourX,
    pack: {
      name: "adaptive-override",
      displayName: "Adaptive override",
      version: "0.1.0",
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
            sha256: hash(oneX),
          },
          {
            src: "atlas-2x.png",
            density: 2,
            cellWidth: 64,
            cellHeight: 64,
            sha256: hash(twoX),
          },
          {
            src: "atlas-4x.png",
            density: 4,
            cellWidth: 128,
            cellHeight: 128,
            sha256: hash(fourX),
          },
        ],
      },
      states: { idle: { frames: [0], fps: 1, loop: true } },
      defaultScale: 1,
    },
  };
}

function singleDensityNormalizedFixture(density: 1 | 2 | 4 = 4) {
  return {
    name: "single-density",
    displayName: "Single density",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: `atlas-${density}x.png`,
      sha256: "0".repeat(64),
      columns: 1,
      rows: 1,
      cellWidth: density,
      cellHeight: density,
      logicalWidth: 1,
      logicalHeight: 1,
      density,
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
}

function pngFixture(
  width: number,
  height: number,
  payloadLength = 0,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(57 + payloadLength);
  const view = new DataView(output.buffer);
  output.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  output.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  output[24] = 8;
  output[25] = 6;
  view.setUint32(33, payloadLength);
  output.set([0x49, 0x44, 0x41, 0x54], 37);
  output.set([0x49, 0x45, 0x4e, 0x44], 49 + payloadLength);
  return output;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function pendingUntilAbort(
  signal: AbortSignal | null | undefined,
  failure: string,
): Promise<never> {
  return new Promise((_, reject) => {
    const failSafe = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(failure));
    }, 100);
    const abort = () => {
      clearTimeout(failSafe);
      reject(
        signal?.reason ?? new DOMException("Request aborted", "AbortError"),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function webpFixture(width: number, height: number): Uint8Array<ArrayBuffer> {
  const canvas = new Uint8Array(10);
  const storedWidth = width - 1;
  const storedHeight = height - 1;
  canvas[4] = storedWidth & 0xff;
  canvas[5] = (storedWidth >>> 8) & 0xff;
  canvas[6] = (storedWidth >>> 16) & 0xff;
  canvas[7] = storedHeight & 0xff;
  canvas[8] = (storedHeight >>> 8) & 0xff;
  canvas[9] = (storedHeight >>> 16) & 0xff;
  const image = new Uint8Array(10);
  image.set([0x9d, 0x01, 0x2a], 3);
  const view = new DataView(image.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return webpContainer([webpChunk("VP8X", canvas), webpChunk("VP8 ", image)]);
}

function webpChunk(
  type: string,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(
    8 + payload.byteLength + (payload.byteLength & 1),
  );
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode(type), 0);
  view.setUint32(4, payload.byteLength, true);
  output.set(payload, 8);
  return output;
}

function webpContainer(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size =
    12 + chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, size - 8, true);
  output.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

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

test("loader rejects an omitted pack selection before network access", async () => {
  let fetches = 0;

  await assert.rejects(
    () =>
      loadNativePack({
        baseUrl: "https://app.example/",
        fetch: (async () => {
          fetches += 1;
          throw new Error("fetch must not run");
        }) as typeof fetch,
        image: () => loadedImage(1, 1),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:unexpected",
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["manifest.selection"]);
      assert.match(
        error.issues[0] ?? "",
        /explicit character, packUrl, or pack/i,
      );
      return true;
    },
  );
  assert.equal(fetches, 0);
});

test("a stalled manifest request rejects with a bounded timeout", async () => {
  let objectUrls = 0;

  await assert.rejects(
    () =>
      loadNativePack({
        character: "manifest-timeout",
        baseUrl: "https://app.example/",
        packUrl: "https://assets.example/character.json",
        resourceTimeoutMs: 5,
        fetch: ((_input, init) =>
          pendingUntilAbort(
            init?.signal,
            "manifest request did not receive a timeout signal",
          )) as typeof fetch,
        image: () => loadedImage(1, 1),
        signal: new AbortController().signal,
        createObjectURL: () => `blob:unexpected:${++objectUrls}`,
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackLoadError);
      assert.equal(error.code, "manifest.timeout");
      assert.equal(error.category, "timeout");
      assert.match(error.message, /manifest request timed out/i);
      return true;
    },
  );
  assert.equal(objectUrls, 0);
});

test("a stalled manifest response body uses the same request deadline", async () => {
  await assert.rejects(
    () =>
      loadNativePack({
        character: "manifest-body-timeout",
        baseUrl: "https://app.example/",
        packUrl: "https://assets.example/character.json",
        resourceTimeoutMs: 5,
        fetch: (async (_input, init) =>
          new Response(
            new ReadableStream({
              pull: () =>
                pendingUntilAbort(
                  init?.signal,
                  "manifest body did not retain its timeout signal",
                ),
            }),
            { headers: { "content-type": "application/json" } },
          )) as typeof fetch,
        image: () => loadedImage(1, 1),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:unexpected",
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackLoadError);
      assert.equal(error.code, "manifest.timeout");
      assert.equal(error.category, "timeout");
      return true;
    },
  );
});

test("a parent abort remains an AbortError instead of becoming a timeout", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Host destroyed", "AbortError");
  const result = loadNativePack({
    character: "parent-abort",
    baseUrl: "https://app.example/",
    packUrl: "https://assets.example/character.json",
    resourceTimeoutMs: 100,
    fetch: ((_input, init) =>
      pendingUntilAbort(
        init?.signal,
        "parent abort was not forwarded",
      )) as typeof fetch,
    image: () => loadedImage(1, 1),
    signal: controller.signal,
    createObjectURL: () => "blob:unexpected",
    revokeObjectURL: () => {},
  });

  controller.abort(reason);
  await assert.rejects(result, (error: unknown) => {
    assert.equal(error, reason);
    assert.ok(!(error instanceof PackLoadError));
    return true;
  });
});

test("an atlas timeout retains lower-density fallback", async () => {
  const { oneX, pack } = adaptiveNormalizedFixture();
  const requests: string[] = [];
  const diagnostics: Array<{ message: string; category?: string }> = [];
  const loaded = await loadNativePack({
    character: "adaptive-timeout",
    baseUrl: "https://app.example/",
    pack,
    packUrl: "https://assets.example/character.json",
    densityOverride: 2,
    resourceTimeoutMs: 5,
    fetch: ((input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("atlas-2x.png")) {
        return pendingUntilAbort(
          init?.signal,
          "atlas request did not receive a timeout signal",
        );
      }
      return Promise.resolve(
        new Response(oneX, { headers: { "content-type": "image/png" } }),
      );
    }) as typeof fetch,
    image: () => loadedImage(64, 64),
    signal: new AbortController().signal,
    createObjectURL: () => "blob:adaptive-timeout",
    revokeObjectURL: () => {},
    diagnostic: (message, category) => diagnostics.push({ message, category }),
  });

  assert.equal(loaded.loadedDensity, 1);
  assert.deepEqual(requests, [
    "https://assets.example/atlas-2x.png",
    "https://assets.example/atlas-1x.png",
  ]);
  assert.deepEqual(diagnostics, [
    {
      message: "Atlas 2x failed (timeout); falling back.",
      category: "timeout",
    },
  ]);
  loaded.release();
});

test("an exhausted atlas timeout keeps its resource-specific error code", async () => {
  const { pack } = adaptiveNormalizedFixture();
  const diagnostics: Array<{ message: string; category?: string }> = [];
  let objectUrls = 0;

  await assert.rejects(
    () =>
      loadNativePack({
        character: "atlas-timeout",
        baseUrl: "https://app.example/",
        pack,
        atlasUrl: "https://assets.example/atlas.png",
        densityOverride: 1,
        resourceTimeoutMs: 5,
        fetch: ((_input, init) =>
          pendingUntilAbort(
            init?.signal,
            "atlas request did not receive a timeout signal",
          )) as typeof fetch,
        image: () => loadedImage(64, 64),
        signal: new AbortController().signal,
        createObjectURL: () => `blob:unexpected:${++objectUrls}`,
        revokeObjectURL: () => {},
        diagnostic: (message, category) =>
          diagnostics.push({ message, category }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackLoadError);
      assert.equal(error.code, "atlas.timeout");
      assert.equal(error.category, "timeout");
      assert.match(error.message, /atlas request timed out/i);
      return true;
    },
  );
  assert.equal(objectUrls, 0);
  assert.deepEqual(diagnostics, [
    {
      message: "Atlas 1x failed (timeout); no fallback remains.",
      category: "timeout",
    },
  ]);
});

test("hostile own-data failures retain a stable structured issue code", async () => {
  let reads = 0;
  let fetches = 0;
  const pack: Record<string, unknown> = {};
  Object.defineProperty(pack, "format", {
    enumerable: true,
    get() {
      reads += 1;
      return 1;
    },
  });

  await assert.rejects(
    () =>
      loadNativePack({
        character: "hostile-data",
        baseUrl: "https://app.example/",
        pack,
        fetch: (async () => {
          fetches += 1;
          throw new Error("fetch must not run");
        }) as typeof fetch,
        image: () => loadedImage(1, 1),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:unexpected",
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["data.descriptor"]);
      return true;
    },
  );
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
});

test("aggregated atlas validation keeps its structured code and category", async () => {
  const bytes = pngFixture(1, 1);
  const diagnostics: Array<{ message: string; category?: string }> = [];
  const pack = {
    name: "aggregate-category",
    displayName: "Aggregate category",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: "atlas.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      columns: 1,
      rows: 1,
      cellWidth: 1,
      cellHeight: 1,
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };

  await assert.rejects(
    () =>
      loadNativePack({
        character: pack.name,
        baseUrl: "https://app.example/",
        pack,
        atlasUrl: "https://assets.example/atlas.png",
        fetch: (async () =>
          new Response(bytes, {
            headers: { "content-type": "image/png" },
          })) as typeof fetch,
        image: () => loadedImage(2, 1),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:aggregate-category",
        revokeObjectURL: () => {},
        diagnostic: (message, category) =>
          diagnostics.push({ message, category }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.ok(error.issueCodes.includes("atlas.pixels"));
      assert.ok(error.issues.every((issue) => !issue.includes("\0")));
      return true;
    },
  );
  assert.equal(diagnostics.at(-1)?.category, "image");
});

test("a malformed WebP container size is categorized as an image failure", async () => {
  const bytes = webpFixture(1, 1);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    4,
    bytes.byteLength - 9,
    true,
  );
  const diagnostics: Array<{ message: string; category?: string }> = [];

  await assert.rejects(
    () =>
      loadNativePack({
        character: "webp-size-category",
        baseUrl: "https://app.example/",
        pack: {
          name: "webp-size-category",
          displayName: "WebP size category",
          version: "0.1.0",
          license: "CC0-1.0",
          atlas: {
            src: "atlas.webp",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            columns: 1,
            rows: 1,
            cellWidth: 1,
            cellHeight: 1,
          },
          states: { idle: { frames: [0], fps: 1, loop: true } },
          defaultScale: 1,
        },
        atlasUrl: "https://assets.example/atlas.webp",
        fetch: (async () =>
          new Response(bytes, {
            headers: { "content-type": "image/webp" },
          })) as typeof fetch,
        image: () => loadedImage(1, 1),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:unexpected",
        revokeObjectURL: () => {},
        diagnostic: (message, category) =>
          diagnostics.push({ message, category }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["webp.size"]);
      return true;
    },
  );
  assert.equal(diagnostics.at(-1)?.category, "image");
});

test("a multi-density atlasUrl requires an explicit density before fetching", async () => {
  const { pack } = adaptiveNormalizedFixture();
  let fetches = 0;

  await assert.rejects(
    () =>
      loadNativePack({
        character: "adaptive-override",
        baseUrl: "https://app.example/",
        pack,
        atlasUrl: "https://assets.example/atlas.png",
        fetch: (async () => {
          fetches += 1;
          throw new Error("fetch must not run");
        }) as typeof fetch,
        image: () => loadedImage(64, 64),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:unexpected",
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["atlas.override-density"]);
      assert.match(error.issues[0] ?? "", /explicit density/i);
      return true;
    },
  );
  assert.equal(fetches, 0);
});

test("an atlasUrl validates only the explicitly selected density", async () => {
  const { oneX, pack } = adaptiveNormalizedFixture();
  let fetches = 0;
  let objectUrls = 0;

  await assert.rejects(
    () =>
      loadNativePack({
        character: "adaptive-override",
        baseUrl: "https://app.example/",
        pack,
        atlasUrl: "https://assets.example/atlas.png",
        densityOverride: 2,
        fetch: (async () => {
          fetches += 1;
          return new Response(oneX, {
            headers: { "content-type": "image/png" },
          });
        }) as typeof fetch,
        image: () => loadedImage(64, 64),
        signal: new AbortController().signal,
        createObjectURL: () => `blob:unexpected:${++objectUrls}`,
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["atlas.hash"]);
      return true;
    },
  );
  assert.equal(fetches, 1);
  assert.equal(objectUrls, 0);
});

test("an atlasUrl loads its explicit density once and disables upgrades", async () => {
  const { twoX, pack } = adaptiveNormalizedFixture();
  let fetches = 0;
  const loaded = await loadNativePack({
    character: "adaptive-override",
    baseUrl: "https://app.example/",
    pack,
    atlasUrl: "https://assets.example/atlas.png",
    densityOverride: 2,
    fetch: (async () => {
      fetches += 1;
      return new Response(twoX, {
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch,
    image: () => loadedImage(128, 128),
    signal: new AbortController().signal,
    createObjectURL: () => "blob:adaptive-override",
    revokeObjectURL: () => {},
  });

  assert.equal(loaded.loadedDensity, 2);
  assert.equal(fetches, 1);
  assert.equal(await loaded.upgrade(4), false);
  assert.equal(fetches, 1);
  loaded.release();
});

test("loader compares declared media types case-insensitively", async () => {
  const manifest = nativeManifest();
  const png = pngFixture(512, 64);
  const revoked: string[] = [];
  const loaded = await loadNativePack({
    character: "loader-fixture",
    baseUrl: "https://app.example/",
    packUrl: "https://assets.example/character.json",
    fetch: (async (input: RequestInfo | URL) =>
      String(input).endsWith("character.json")
        ? new Response(JSON.stringify(manifest), {
            headers: { "content-type": "APPLICATION/JSON; CHARSET=UTF-8" },
          })
        : new Response(png, {
            headers: { "content-type": "IMAGE/PNG" },
          })) as typeof fetch,
    image: () => loadedImage(512, 64),
    signal: new AbortController().signal,
    createObjectURL: () => "blob:loader-fixture",
    revokeObjectURL: (url) => revoked.push(url),
  });

  assert.equal(loaded.content.name, "loader-fixture");
  loaded.release();
  assert.deepEqual(revoked, ["blob:loader-fixture"]);
});

test("the registered Peek selection rejects a changed manifest before atlas fetch", async () => {
  const atlas = pngFixture(512, 64);
  const manifest = nativeManifest();
  manifest.assets = {
    atlases: {
      columns: 16,
      rows: 2,
      logicalCellSize: 32,
      lineage: "loader-default-integrity-v1",
      variants: [
        {
          src: "atlas.png",
          density: 1,
          sourceCellSize: 32,
          sha256: createHash("sha256").update(atlas).digest("hex"),
        },
      ],
    },
  };
  let atlasFetches = 0;

  await assert.rejects(
    () =>
      loadNativePack({
        character: "peek",
        baseUrl: "https://app.example/",
        fetch: (async (input: RequestInfo | URL) => {
          if (String(input).endsWith("character.json")) {
            return new Response(JSON.stringify(manifest), {
              headers: { "content-type": "application/json" },
            });
          }
          atlasFetches += 1;
          return new Response(atlas, {
            headers: { "content-type": "image/png" },
          });
        }) as typeof fetch,
        image: () => loadedImage(512, 64),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:changed-default",
        revokeObjectURL: () => {},
      }),
    /registered Peek manifest hash mismatch/i,
  );
  assert.equal(atlasFetches, 0);
});

test("native and normalized atlas candidates require valid SHA-256", () => {
  const missingNative = structuredClone(nativeManifest()) as unknown as {
    assets: { atlas: Record<string, unknown> };
  };
  delete missingNative.assets.atlas.sha256;
  assert.throws(
    () => validateNativePack(missingNative),
    /assets\.atlas\.sha256.*64 lowercase hexadecimal/i,
  );

  const malformedNative = structuredClone(nativeManifest()) as unknown as {
    assets: { atlas: Record<string, unknown> };
  };
  malformedNative.assets.atlas.sha256 = "not-a-sha256";
  assert.throws(
    () => validateNativePack(malformedNative),
    /assets\.atlas\.sha256.*64 lowercase hexadecimal/i,
  );

  const normalized = {
    name: "normalized-integrity-fixture",
    displayName: "Normalized integrity fixture",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: "atlas.webp",
      columns: 1,
      rows: 1,
      cellWidth: 1,
      cellHeight: 1,
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
  assert.throws(
    () => validateNormalizedPack(normalized),
    /atlas\.sha256.*64 lowercase hexadecimal/i,
  );
  assert.throws(
    () =>
      validateNormalizedPack({
        ...normalized,
        atlas: { ...normalized.atlas, sha256: "ABC" },
      }),
    /atlas\.sha256.*64 lowercase hexadecimal/i,
  );
});

test("normalized atlas bytes must match the declared image media type", async () => {
  for (const fixture of [
    {
      name: "PNG bytes declared as WebP",
      src: "atlas.webp",
      contentType: "image/webp",
      bytes: pngFixture(1, 1),
    },
    {
      name: "WebP bytes declared as PNG",
      src: "atlas.png",
      contentType: "image/png",
      bytes: webpFixture(1, 1),
    },
  ]) {
    let objectUrls = 0;
    const diagnostics: Array<{ message: string; category?: string }> = [];
    const result = loadNativePack({
      character: "normalized-fixture",
      baseUrl: "https://app.example/",
      pack: {
        name: "normalized-fixture",
        displayName: "Normalized fixture",
        version: "0.1.0",
        license: "CC0-1.0",
        atlas: {
          src: fixture.src,
          sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
          columns: 1,
          rows: 1,
          cellWidth: 1,
          cellHeight: 1,
        },
        states: { idle: { frames: [0], fps: 1, loop: true } },
        defaultScale: 1,
      },
      atlasUrl: `https://assets.example/${fixture.src}`,
      fetch: (async () =>
        new Response(fixture.bytes, {
          headers: { "content-type": fixture.contentType },
        })) as typeof fetch,
      image: () => loadedImage(1, 1),
      signal: new AbortController().signal,
      createObjectURL: () => `blob:mismatch:${++objectUrls}`,
      revokeObjectURL: () => {},
      diagnostic: (message, category) =>
        diagnostics.push({ message, category }),
    });

    await assert.rejects(result, /Content-Type.*atlas bytes/i, fixture.name);
    assert.equal(objectUrls, 0, `${fixture.name} reached browser decode`);
    assert.equal(diagnostics.at(-1)?.category, "mime", fixture.name);
  }
});

test("WebP inspection scans bounded leading metadata before the image chunk", async () => {
  const imageChunk = webpFixture(2, 3).slice(12);
  const bytes = webpContainer([
    webpChunk("ICCP", new Uint8Array([1, 2, 3])),
    webpChunk("EXIF", new Uint8Array([4, 5])),
    webpChunk("XMP ", new Uint8Array([6])),
    imageChunk,
  ]);
  const loaded = await loadNativePack({
    character: "metadata-webp",
    baseUrl: "https://app.example/",
    pack: {
      name: "metadata-webp",
      displayName: "Metadata WebP",
      version: "0.1.0",
      license: "CC0-1.0",
      atlas: {
        src: "atlas.webp",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        columns: 2,
        rows: 3,
        cellWidth: 1,
        cellHeight: 1,
      },
      states: { idle: { frames: [0], fps: 1, loop: true } },
      defaultScale: 1,
    },
    atlasUrl: "https://assets.example/atlas.webp",
    fetch: (async () =>
      new Response(bytes, {
        headers: { "content-type": "image/webp" },
      })) as typeof fetch,
    image: () => loadedImage(2, 3),
    signal: new AbortController().signal,
    createObjectURL: () => "blob:metadata-webp",
    revokeObjectURL: () => {},
  });

  assert.equal(loaded.content.atlas.src, "atlas.webp");
  loaded.release();
});

test("WebP inspection rejects truncated metadata and excessive chunk counts", async () => {
  const validImage = webpFixture(1, 1).slice(12);
  const truncated = webpContainer([
    webpChunk("ICCP", new Uint8Array([1])),
    validImage,
  ]);
  new DataView(truncated.buffer).setUint32(16, 4_096, true);
  const excessive = webpContainer([
    ...Array.from({ length: 4_097 }, () => webpChunk("ICCP")),
    validImage,
  ]);

  for (const [name, bytes, expected] of [
    ["truncated", truncated, /WebP chunk is truncated/],
    ["excessive", excessive, /WebP has too many chunks/],
  ] as const) {
    let objectUrls = 0;
    await assert.rejects(
      () =>
        loadNativePack({
          character: `${name}-webp`,
          baseUrl: "https://app.example/",
          pack: {
            name: `${name}-webp`,
            displayName: `${name} WebP`,
            version: "0.1.0",
            license: "CC0-1.0",
            atlas: {
              src: "atlas.webp",
              sha256: createHash("sha256").update(bytes).digest("hex"),
              columns: 1,
              rows: 1,
              cellWidth: 1,
              cellHeight: 1,
            },
            states: { idle: { frames: [0], fps: 1, loop: true } },
            defaultScale: 1,
          },
          atlasUrl: "https://assets.example/atlas.webp",
          fetch: (async () =>
            new Response(bytes, {
              headers: { "content-type": "image/webp" },
            })) as typeof fetch,
          image: () => loadedImage(1, 1),
          signal: new AbortController().signal,
          createObjectURL: () => `blob:${++objectUrls}`,
          revokeObjectURL: () => {},
        }),
      expected,
    );
    assert.equal(objectUrls, 0);
  }
});

test("missing Web Crypto reports an explicit atlas integrity failure", async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const bytes = pngFixture(1, 1);
  const diagnostics: Array<{ message: string; category?: string }> = [];
  let objectUrls = 0;
  try {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
    await assert.rejects(
      () =>
        loadNativePack({
          character: "integrity-fixture",
          baseUrl: "https://app.example/",
          pack: {
            name: "integrity-fixture",
            displayName: "Integrity fixture",
            version: "0.1.0",
            license: "CC0-1.0",
            atlas: {
              src: "atlas.png",
              columns: 1,
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
          atlasUrl: "https://assets.example/atlas.png",
          densityOverride: 1,
          fetch: (async () =>
            new Response(bytes, {
              headers: { "content-type": "image/png" },
            })) as typeof fetch,
          image: () => loadedImage(1, 1),
          signal: new AbortController().signal,
          createObjectURL: () => `blob:integrity:${++objectUrls}`,
          revokeObjectURL: () => {},
          diagnostic: (message, category) =>
            diagnostics.push({ message, category }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /SHA-256 integrity verification.*unavailable/i,
        );
        assert.doesNotMatch(error.message, /TypeError|undefined/);
        return true;
      },
    );
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, "crypto", originalCrypto);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
  }

  assert.equal(objectUrls, 0);
  assert.equal(diagnostics.at(-1)?.category, "integrity");
});

test("registered manifest crypto failures keep manifest issue codes", async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    for (const fixture of [
      {
        name: "unavailable",
        crypto: {},
        code: "manifest.integrity-unavailable",
      },
      {
        name: "failed",
        crypto: {
          subtle: {
            digest: async () => {
              throw new Error("digest failed");
            },
          },
        },
        code: "manifest.integrity-failed",
      },
    ]) {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: fixture.crypto,
      });
      let fetches = 0;
      await assert.rejects(
        () =>
          loadNativePack({
            character: "peek",
            baseUrl: "https://app.example/",
            fetch: (async () => {
              fetches += 1;
              return new Response("{}", {
                headers: { "content-type": "application/json" },
              });
            }) as typeof fetch,
            image: () => loadedImage(1, 1),
            signal: new AbortController().signal,
            createObjectURL: () => "blob:unexpected",
            revokeObjectURL: () => {},
          }),
        (error: unknown) => {
          assert.ok(error instanceof PackValidationError, fixture.name);
          assert.deepEqual(error.issueCodes, [fixture.code], fixture.name);
          return true;
        },
      );
      assert.equal(fetches, 1, fixture.name);
    }
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, "crypto", originalCrypto);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
  }
});

test("maxDensity reports when it filters out every declared atlas variant", async () => {
  let fetches = 0;
  await assert.rejects(
    () =>
      loadNativePack({
        character: "density-fixture",
        baseUrl: "https://app.example/",
        pack: {
          name: "density-fixture",
          displayName: "Density fixture",
          version: "0.1.0",
          license: "CC0-1.0",
          atlas: {
            src: "atlas-2x.png",
            columns: 1,
            rows: 1,
            cellWidth: 2,
            cellHeight: 2,
            logicalWidth: 1,
            logicalHeight: 1,
            density: 2,
            variants: [
              {
                src: "atlas-2x.png",
                density: 2,
                cellWidth: 2,
                cellHeight: 2,
                sha256: "0".repeat(64),
              },
            ],
          },
          states: { idle: { frames: [0], fps: 1, loop: true } },
          defaultScale: 1,
        },
        maxDensity: 1,
        fetch: (async () => {
          fetches += 1;
          throw new Error("fetch should not run");
        }) as typeof fetch,
        image: () => loadedImage(2, 2),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:density-fixture",
        revokeObjectURL: () => {},
      }),
    /no atlas variant at or below maxDensity/i,
  );
  assert.equal(fetches, 0);
});

test("a single atlas rejects a mismatched explicit density before fetching", async () => {
  let fetches = 0;
  await assert.rejects(
    () =>
      loadNativePack({
        character: "single-density",
        baseUrl: "https://app.example/",
        pack: singleDensityNormalizedFixture(),
        atlasUrl: "https://assets.example/atlas.png",
        densityOverride: 1,
        fetch: (async () => {
          fetches += 1;
          throw new Error("fetch should not run");
        }) as typeof fetch,
        image: () => loadedImage(4, 4),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:single-density",
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["atlas.override-density"]);
      return true;
    },
  );
  assert.equal(fetches, 0);
});

test("a single atlas rejects density above maxDensity before fetching", async () => {
  let fetches = 0;
  await assert.rejects(
    () =>
      loadNativePack({
        character: "single-density",
        baseUrl: "https://app.example/",
        pack: singleDensityNormalizedFixture(),
        atlasUrl: "https://assets.example/atlas.png",
        maxDensity: 2,
        fetch: (async () => {
          fetches += 1;
          throw new Error("fetch should not run");
        }) as typeof fetch,
        image: () => loadedImage(4, 4),
        signal: new AbortController().signal,
        createObjectURL: () => "blob:single-density",
        revokeObjectURL: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof PackValidationError);
      assert.deepEqual(error.issueCodes, ["atlas.max-density"]);
      return true;
    },
  );
  assert.equal(fetches, 0);
});

test("a slower lower-density upgrade cannot replace a completed higher-density upgrade", async () => {
  const oneX = pngFixture(64, 64, 1);
  const twoX = pngFixture(128, 128, 2);
  const fourX = pngFixture(256, 256, 4);
  const hash = (bytes: Uint8Array<ArrayBuffer>) =>
    createHash("sha256").update(bytes).digest("hex");
  const pack = {
    name: "adaptive-fixture",
    displayName: "Adaptive fixture",
    version: "0.1.0",
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
          sha256: hash(oneX),
        },
        {
          src: "atlas-2x.png",
          density: 2,
          cellWidth: 64,
          cellHeight: 64,
          sha256: hash(twoX),
        },
        {
          src: "atlas-4x.png",
          density: 4,
          cellWidth: 128,
          cellHeight: 128,
          sha256: hash(fourX),
        },
      ],
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
  const twoXResponse = deferred<Response>();
  const fourXResponse = deferred<Response>();
  const requests: string[] = [];
  const geometryBySize = new Map([
    [oneX.byteLength, { width: 64, height: 64 }],
    [twoX.byteLength, { width: 128, height: 128 }],
    [fourX.byteLength, { width: 256, height: 256 }],
  ]);
  const geometryByUrl = new Map<string, { width: number; height: number }>();
  const revoked: string[] = [];
  let objectUrlId = 0;
  const loaded = await loadNativePack({
    character: "adaptive-fixture",
    baseUrl: "https://app.example/",
    pack,
    packUrl: "https://assets.example/character.json",
    densityOverride: 1,
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("atlas-2x.png")) return twoXResponse.promise;
      if (url.endsWith("atlas-4x.png")) return fourXResponse.promise;
      return Promise.resolve(
        new Response(oneX, { headers: { "content-type": "image/png" } }),
      );
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
        set src(url: string) {
          const geometry = geometryByUrl.get(url)!;
          this.naturalWidth = geometry.width;
          this.naturalHeight = geometry.height;
          queueMicrotask(() => listeners.get("load")?.({} as Event));
        },
      };
      return image as unknown as HTMLImageElement;
    },
    signal: new AbortController().signal,
    createObjectURL: (blob) => {
      const url = `blob:upgrade:${++objectUrlId}`;
      geometryByUrl.set(url, geometryBySize.get(blob.size)!);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
  });

  const lowerUpgrade = loaded.upgrade(2);
  const higherUpgrade = loaded.upgrade(4);
  assert.deepEqual(requests.slice(-2), [
    "https://assets.example/atlas-2x.png",
    "https://assets.example/atlas-4x.png",
  ]);

  fourXResponse.resolve(
    new Response(fourX, { headers: { "content-type": "image/png" } }),
  );
  assert.equal(await higherUpgrade, true);
  assert.equal(loaded.loadedDensity, 4);
  const activeObjectUrl = loaded.atlasObjectUrl;
  assert.deepEqual(revoked, ["blob:upgrade:1"]);

  twoXResponse.resolve(
    new Response(twoX, { headers: { "content-type": "image/png" } }),
  );
  assert.equal(await lowerUpgrade, false);
  assert.equal(loaded.loadedDensity, 4);
  assert.equal(loaded.atlasObjectUrl, activeObjectUrl);
  assert.deepEqual(revoked, ["blob:upgrade:1", "blob:upgrade:3"]);

  loaded.release();
  assert.deepEqual(revoked, [
    "blob:upgrade:1",
    "blob:upgrade:3",
    "blob:upgrade:2",
  ]);
});

test("native and normalized state timing enforce the 0.1 FPS floor", () => {
  const nativeAtFloor = nativeManifest();
  nativeAtFloor.states.idle!.fps = 0.1;
  assert.equal(validateNativePack(nativeAtFloor).states.idle!.fps, 0.1);

  const nativeBelowFloor = nativeManifest();
  nativeBelowFloor.states.idle!.fps = 0.099;
  assert.throws(
    () => validateNativePack(nativeBelowFloor),
    /fps must be >=0\.1 and <=60/,
  );

  const normalized = (fps: number) => ({
    name: "normalized-timing-fixture",
    displayName: "Normalized timing fixture",
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
    states: { idle: { frames: [0], fps, loop: true } },
    defaultScale: 1,
  });
  assert.equal(validateNormalizedPack(normalized(0.1)).states.idle!.fps, 0.1);
  assert.throws(
    () => validateNormalizedPack(normalized(0.099)),
    /fps must be >=0\.1 and <=60/,
  );
});
