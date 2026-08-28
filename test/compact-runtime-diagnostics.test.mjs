import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { minify } from "terser";

test("the compact browser runtime excludes expanded diagnostic prose", async () => {
  const browser = await readFile(
    "packages/runtime/dist/peekling.min.js",
    "utf8",
  );
  for (const detail of [
    "source must be a JSON object",
    "must be a plain data object",
    "must use this realm's Object prototype or a null prototype",
    "Page suspended",
    "Page resumed",
    "Instance paused",
    "Instance shown",
    "Host event ",
    "mount binding is missing",
    "Atlas decode failed",
    "Atlas load aborted.",
    "No usable atlas",
    "falling back",
    "no fallback remains",
    "Manifest HTTP ",
    "Atlas HTTP ",
    "Manifest request timed out",
    "Atlas request timed out",
    'join("\\n- ")',
  ]) {
    assert.equal(browser.includes(detail), false, detail);
  }
});

test("compact Plan failures retain the code without path prose", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/plan-compiler.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "true" },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const { compilePlan } = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );

  assert.throws(
    () => compilePlan({}),
    (error) => {
      assert.equal(error.name, "PlanCompileError");
      assert.equal(error.code, "missing-baseline");
      assert.equal(error.path, "");
      assert.equal(error.message, "missing-baseline");
      return true;
    },
  );
});

test("noncompact Plan failures preserve structured diagnostics", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/plan-compiler.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "false" },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const { compilePlan } = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );

  assert.throws(
    () => compilePlan({}),
    (error) => {
      assert.equal(error.name, "PlanCompileError");
      assert.equal(error.code, "missing-baseline");
      assert.equal(error.path, "$plan.baseline");
      assert.equal(error.message, "$plan.baseline: is required");
      return true;
    },
  );
});

test("compact diagnostics do not change canonical compiled Plan records", async () => {
  const [compactOutput, fullOutput] = await Promise.all(
    [true, false].map((compact) =>
      build({
        entryPoints: ["packages/runtime/src/plan-compiler.ts"],
        bundle: true,
        define: { __PEEKLING_COMPACT_ERRORS__: String(compact) },
        format: "esm",
        platform: "browser",
        target: ["es2022"],
        write: false,
      }),
    ),
  );
  const [compactCompiler, fullCompiler] = await Promise.all(
    [compactOutput, fullOutput].map(
      (output) =>
        import(
          `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
        ),
    ),
  );
  const plan = {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "click",
        when: { source: "browser", event: "pointer.click" },
        effect: {
          channels: ["state", "surface:toast"],
          state: { capability: "locomotion" },
          surfaces: [
            {
              id: "toast",
              contentId: "toast",
              data: { text: "Hello" },
              disposition: "interrupt",
            },
          ],
          until: { type: "duration", ms: 500 },
        },
      },
      {
        id: "visible",
        when: {
          source: "browser",
          event: "section.visibility",
          selector: "#pricing",
          phase: "enter",
          threshold: 0.5,
        },
        effect: {
          channels: ["state"],
          state: { state: "celebrate" },
          until: {
            type: "event",
            name: "animation.complete",
            timeout: 1_000,
          },
        },
      },
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
              contentId: "status",
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
        id: "scroll",
        when: {
          source: "browser",
          event: "window.scroll",
          coalesce: "latest",
        },
        effect: {
          channels: ["state"],
          state: { state: "celebrate" },
        },
      },
      {
        id: "move",
        when: { source: "browser", event: "pointer.move" },
        effect: {
          channels: ["motion", "state"],
          motion: {
            type: "follow-pointer",
            speed: 160,
            arrivalRadius: 8,
          },
          state: { capability: "locomotion" },
        },
      },
    ],
  };
  const context = {
    states: new Set(["idle", "celebrate"]),
    capabilities: new Set(["locomotion"]),
    contentIds: new Set(["toast", "status"]),
  };
  const compact = compactCompiler.compilePlan(plan, context);
  const full = fullCompiler.compilePlan(plan, context);
  const data = (value) => JSON.parse(JSON.stringify(value));

  assert.deepEqual(data(compact), data(full));
  assert.deepEqual(data(compact), {
    baseline: {
      channels: ["state"],
      state: { kind: "state", name: "idle" },
      surfaces: [],
    },
    rules: [
      {
        id: "click",
        when: { source: "browser", event: "pointer.click" },
        effect: {
          channels: ["state", "surface:toast"],
          state: { kind: "capability", name: "locomotion" },
          surfaces: [
            {
              id: "toast",
              channel: "surface:toast",
              contentId: "toast",
              data: { text: "Hello" },
              disposition: "interrupt",
            },
          ],
          until: { type: "duration", ms: 500 },
        },
      },
      {
        id: "visible",
        when: {
          source: "browser",
          event: "section.visibility",
          selector: "#pricing",
          phase: "enter",
          threshold: 0.5,
        },
        effect: {
          channels: ["state"],
          state: { kind: "state", name: "celebrate" },
          surfaces: [],
          until: {
            type: "event",
            name: "animation.complete",
            timeout: 1_000,
          },
        },
      },
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
              channel: "surface:status",
              contentId: "status",
              dataSource: "event-payload",
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
        id: "scroll",
        when: {
          source: "browser",
          event: "window.scroll",
          coalesce: "latest",
        },
        effect: {
          channels: ["state"],
          state: { kind: "state", name: "celebrate" },
          surfaces: [],
        },
      },
      {
        id: "move",
        when: { source: "browser", event: "pointer.move" },
        effect: {
          channels: ["motion", "state"],
          state: { kind: "capability", name: "locomotion" },
          motion: {
            type: "follow-pointer",
            speed: 160,
            arrivalRadius: 8,
          },
          surfaces: [],
        },
      },
    ],
  });
});

test("compact content failures exclude validation and repair prose", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/content.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "true" },
    format: "esm",
    minify: true,
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const compact = await minify(output.outputFiles[0].text, {
    ecma: 2022,
    module: true,
    compress: { passes: 3, toplevel: true },
    mangle: { toplevel: true },
  });
  assert.ok(compact.code);
  const source = compact.code;
  for (const detail of [
    "content must be an object",
    "Invalid content id:",
    "Use a relative path or absolute HTTPS URL",
    "Peekling surface was adopted into another document",
  ]) {
    assert.equal(source.includes(detail), false, detail);
  }
  const { validateHostContent } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  assert.throws(
    () => validateHostContent(null, "https://site.example/"),
    (error) => error instanceof TypeError && error.message === "content.object",
  );
});

test("noncompact content failures preserve detailed prose", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/content.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "false" },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const { validateHostContent } = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );
  assert.throws(
    () => validateHostContent(null, "https://site.example/"),
    (error) =>
      error instanceof TypeError &&
      error.message === "content must be an object",
  );
});

test("compact atlas failures retain machine-readable categories", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/loader.ts"],
    bundle: true,
    define: {
      __PEEKLING_COMPACT_ERRORS__: "true",
      __PEEK_PACK_URL__: JSON.stringify(
        "https://unused.example/character.json",
      ),
      __PEEK_PACK_SHA256__: JSON.stringify("0".repeat(64)),
    },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const loader = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );
  const png = pngFixture(1, 1);
  const sha256 = createHash("sha256").update(png).digest("hex");
  const pack = {
    name: "compact-category",
    displayName: "Compact category",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: "atlas.png",
      sha256,
      columns: 1,
      rows: 1,
      cellWidth: 1,
      cellHeight: 1,
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
  const cases = [
    {
      name: "hash",
      expected: "hash",
      pack: {
        ...pack,
        atlas: { ...pack.atlas, sha256: "0".repeat(64) },
      },
      fetch: async () =>
        new Response(png, { headers: { "content-type": "image/png" } }),
    },
    {
      name: "mime",
      expected: "mime",
      pack,
      fetch: async () =>
        new Response(png, { headers: { "content-type": "text/plain" } }),
    },
    {
      name: "size",
      expected: "size",
      pack,
      fetch: async () =>
        new Response(png, {
          headers: {
            "content-length": String(32 * 1024 * 1024 + 1),
            "content-type": "image/png",
          },
        }),
    },
    {
      name: "network",
      expected: "network",
      pack,
      fetch: async () => {
        throw new TypeError("socket closed");
      },
    },
    {
      name: "timeout",
      expected: "timeout",
      pack,
      resourceTimeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise((_, reject) => {
          const failSafe = setTimeout(
            () => reject(new Error("timeout signal was not forwarded")),
            100,
          );
          init.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(failSafe);
              reject(init.signal.reason);
            },
            { once: true },
          );
        }),
    },
  ];

  for (const fixture of cases) {
    const diagnostics = [];
    await assert.rejects(() =>
      loader.loadNativePack({
        character: "compact-category",
        baseUrl: "https://app.example/",
        pack: fixture.pack,
        atlasUrl: "https://assets.example/atlas.png",
        ...(fixture.resourceTimeoutMs === undefined
          ? {}
          : { resourceTimeoutMs: fixture.resourceTimeoutMs }),
        fetch: fixture.fetch,
        image: () => {
          throw new Error("image decode must not run");
        },
        signal: new AbortController().signal,
        createObjectURL: () => "blob:unexpected",
        revokeObjectURL: () => {},
        diagnostic: (message, category) =>
          diagnostics.push({ message, category }),
      }),
    );
    assert.deepEqual(
      diagnostics,
      [
        {
          message: `atlas.${fixture.expected}.exhausted`,
          category: fixture.expected,
        },
      ],
      fixture.name,
    );
  }
});

test("compact pack issues omit the verbose issue-decoding traversal", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/errors.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "true" },
    format: "esm",
    minify: true,
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const compact = await minify(output.outputFiles[0].text, {
    compress: { inline: 0, passes: 2 },
    module: true,
  });
  assert.ok(compact.code);
  assert.equal(compact.code.includes("lastIndexOf"), false);
  const { packIssue, PackValidationError } = await import(
    `data:text/javascript;base64,${Buffer.from(compact.code).toString("base64")}`
  );
  const error = new PackValidationError([
    packIssue("atlas.hash", "Atlas hash mismatch"),
  ]);
  assert.deepEqual(error.issues, ["atlas.hash"]);
  assert.deepEqual(error.issueCodes, ["atlas.hash"]);
});

test("compact default console errors include a terse debugging hint", async () => {
  const output = await build({
    entryPoints: ["packages/runtime/src/diagnostics.ts"],
    bundle: true,
    define: { __PEEKLING_COMPACT_ERRORS__: "true" },
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const { DiagnosticChannel } = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );
  const warnings = [];
  const records = [];
  const original = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    new DiagnosticChannel({ instanceId: "compact", now: () => 0 }).emit({
      code: "config.styles-load-failed",
      severity: "error",
      message: "config.styles-load-failed",
      phase: "configuration",
    });
    new DiagnosticChannel({
      instanceId: "sink",
      now: () => 0,
      logger: (record) => records.push(record),
    }).emit({
      code: "config.pack-load-failed",
      severity: "error",
      message: "config.pack-load-failed",
      phase: "configuration",
    });
  } finally {
    console.warn = original;
  }

  assert.deepEqual(warnings, [
    "[Peekling] config.styles-load-failed (use peekling.js for details)",
  ]);
  assert.equal(records[0].message, "config.pack-load-failed");
});

function pngFixture(width, height) {
  const output = new Uint8Array(57);
  const view = new DataView(output.buffer);
  output.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  output.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  output[24] = 8;
  output[25] = 6;
  output.set([0x49, 0x44, 0x41, 0x54], 37);
  output.set([0x49, 0x45, 0x4e, 0x44], 49);
  return output;
}
