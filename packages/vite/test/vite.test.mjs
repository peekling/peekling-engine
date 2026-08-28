import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("@peekling/vite exposes one validation-only plugin factory", async () => {
  const api = await import("@peekling/vite");

  assert.deepEqual(Object.keys(api), ["peekling"]);
  const plugin = api.peekling({ config: "peekling.json" });
  assert.equal(plugin.name, "peekling:preflight");
  assert.equal(plugin.enforce, "pre");
  assert.equal(typeof plugin.configResolved, "function");
  assert.equal(typeof plugin.buildStart, "function");
  assert.equal(typeof plugin.configureServer, "function");
  assert.equal(typeof plugin.handleHotUpdate, "function");
  assert.equal(plugin.transform, undefined);
  assert.equal(plugin.resolveId, undefined);
  assert.equal(plugin.load, undefined);
  assert.equal(plugin.transformIndexHtml, undefined);
});

test("invalid Pack references stop Vite startup with actionable context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-invalid-"));
  try {
    await writeFile(
      path.join(root, "peekling.json"),
      `${JSON.stringify({
        plan: {
          baseline: {
            channels: ["state"],
            state: { state: "missing" },
          },
        },
      })}\n`,
    );
    await writeFile(
      path.join(root, "character.json"),
      `${JSON.stringify(normalizedPack())}\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({
      config: "peekling.json",
      pack: "character.json",
    });
    await plugin.configResolved({ root, base: "/", command: "serve" });

    await assert.rejects(
      async () => plugin.buildStart.call(viteContext()),
      (error) => {
        assert.match(error.message, /peekling\.json/);
        assert.match(error.message, /unknown-state/);
        assert.match(error.message, /\$\.plan\.baseline\.state\.state/);
        assert.match(error.message, /Fix:/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev startup watches both inputs and invalid changes stop that update", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-watch-"));
  try {
    const configPath = path.join(root, "peekling.json");
    const packPath = path.join(root, "character.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
    );
    await writeFile(packPath, `${JSON.stringify(normalizedPack())}\n`);
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({
      config: "peekling.json",
      pack: "character.json",
    });
    await plugin.configResolved({ root, base: "/app/", command: "serve" });
    const added = [];
    await plugin.configureServer({
      watcher: {
        add(files) {
          added.push(...files);
        },
      },
    });
    const realRoot = await realpath(root);
    assert.deepEqual(added, [
      path.join(realRoot, "peekling.json"),
      path.join(realRoot, "character.json"),
    ]);
    await plugin.buildStart.call(viteContext());

    const changed = `${JSON.stringify({ plan: minimalPlan("missing") })}\n`;
    await writeFile(configPath, changed);
    await assert.rejects(
      async () =>
        plugin.handleHotUpdate({
          file: configPath,
          read: async () => changed,
          modules: [],
          server: {},
          timestamp: 1,
        }),
      /unknown-state.*\$\.plan\.baseline\.state\.state/s,
    );
    await writeFile(
      configPath,
      `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
    );
    await plugin.handleHotUpdate({
      file: configPath,
      read: async () => `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
      modules: [],
      server: {},
      timestamp: 2,
    });
    const changedPack = normalizedPack();
    changedPack.states = {
      other: { frames: [0], fps: 1, loop: true },
    };
    await writeFile(packPath, `${JSON.stringify(changedPack)}\n`);
    await assert.rejects(
      async () =>
        plugin.handleHotUpdate({
          file: packPath,
          read: async () => `${JSON.stringify(changedPack)}\n`,
          modules: [],
          server: {},
          timestamp: 3,
        }),
      /invalid-pack.*states\.idle is required/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized inputs fail before Vite watches or reads them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-bounded-"));
  try {
    const configPath = path.join(root, "peekling.json");
    await writeFile(configPath, `${" ".repeat(65_537)}\n`);
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "peekling.json" });
    await plugin.configResolved({ root, base: "/", command: "serve" });
    const watched = [];

    await assert.rejects(
      async () =>
        plugin.configureServer({
          watcher: {
            add(files) {
              watched.push(...files);
            },
          },
        }),
      /exceeds 65536 bytes/,
    );
    assert.deepEqual(watched, []);

    await writeFile(configPath, `${" ".repeat(65_537)}\n`);
    let viteRead = false;
    await assert.rejects(
      async () =>
        plugin.handleHotUpdate({
          file: configPath,
          read: async () => {
            viteRead = true;
            return `${" ".repeat(65_537)}\n`;
          },
          modules: [],
          server: {},
          timestamp: 1,
        }),
      /exceeds 65536 bytes/,
    );
    assert.equal(viteRead, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration JSON that is not valid UTF-8 stops Vite startup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-utf8-"));
  try {
    await writeFile(
      path.join(root, "peekling.json"),
      Buffer.concat([
        Buffer.from('{"packUrl":"https://example.com/'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}\n'),
      ]),
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "peekling.json" });
    await plugin.configResolved({ root, base: "/", command: "build" });

    await assert.rejects(
      async () => plugin.buildStart.call(viteContext()),
      /peekling\.json must be valid UTF-8/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a configured parent swapped for a symlink fails before watch registration",
  { skip: process.platform === "win32" },
  async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "peekling-vite-watch-race-"),
    );
    const root = path.join(parent, "app");
    const input = path.join(root, "input");
    const saved = path.join(root, "saved-input");
    const outside = path.join(parent, "outside");
    try {
      await mkdir(input, { recursive: true });
      await mkdir(outside);
      const configuration = `${JSON.stringify({ plan: minimalPlan("idle") })}\n`;
      await writeFile(path.join(input, "peekling.json"), configuration);
      await writeFile(path.join(outside, "peekling.json"), configuration);
      const { peekling } = await import("@peekling/vite");
      const plugin = peekling({ config: "input/peekling.json" });
      await plugin.configResolved({ root, base: "/", command: "serve" });
      await rename(input, saved);
      await symlink(outside, input, "dir");
      const watched = [];

      await assert.rejects(
        async () =>
          plugin.configureServer({
            watcher: {
              add(files) {
                watched.push(...files);
              },
            },
          }),
        /real Vite root|symbolic path component/,
      );
      assert.deepEqual(watched, []);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("the package advertises only the Vite major exercised by its real build test", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.peerDependencies.vite, "^8.0.0");
});

test("hot updates ignore unrelated files outside the Vite root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "peekling-vite-hot-root-"));
  const root = path.join(parent, "app");
  try {
    await mkdir(root);
    await writeFile(
      path.join(root, "peekling.json"),
      `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
    );
    await writeFile(path.join(parent, "linked-package.ts"), "export {};\n");
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "peekling.json" });
    await plugin.configResolved({ root, base: "/", command: "serve" });

    assert.equal(
      await plugin.handleHotUpdate({
        file: path.join(parent, "linked-package.ts"),
        read: async () => "export const value = 1;\n",
        modules: [],
        server: {},
        timestamp: 1,
      }),
      undefined,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("hot updates ignore unrelated deleted files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-hot-delete-"));
  try {
    await writeFile(
      path.join(root, "peekling.json"),
      `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "peekling.json" });
    await plugin.configResolved({ root, base: "/", command: "serve" });

    assert.equal(
      await plugin.handleHotUpdate({
        file: path.join(root, "deleted.ts"),
        read: async () => {
          throw new Error("deleted file was read");
        },
        modules: [],
        server: {},
        timestamp: 1,
      }),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted configured input produces a controlled hot-update error", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "peekling-vite-config-delete-"),
  );
  try {
    const configPath = path.join(root, "peekling.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "peekling.json" });
    await plugin.configResolved({ root, base: "/", command: "serve" });
    await rm(configPath);

    await assert.rejects(
      async () =>
        plugin.handleHotUpdate({
          file: configPath,
          read: async () => {
            throw new Error("configured file was removed");
          },
          modules: [],
          server: {},
          timestamp: 1,
        }),
      /Peekling config input was removed during a hot update/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deep JSON is rejected with a bounded diagnostic instead of overflowing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-depth-"));
  try {
    await writeFile(
      path.join(root, "peekling.json"),
      `${"[".repeat(30_000)}0${"]".repeat(30_000)}\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "peekling.json" });
    await plugin.configResolved({ root, base: "/", command: "build" });

    await assert.rejects(
      async () => plugin.buildStart.call(viteContext()),
      /nesting exceeds 64 levels/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin options reject accessors without executing them", async () => {
  const { peekling } = await import("@peekling/vite");
  let reads = 0;
  const hostile = Object.create(null);
  Object.defineProperty(hostile, "config", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("getter executed");
    },
  });

  assert.throws(
    () => peekling(hostile),
    /plain object with own data properties/,
  );
  assert.equal(reads, 0);
});

test("plugin options are closed and require bounded path strings", async () => {
  const { peekling } = await import("@peekling/vite");

  assert.throws(
    () => peekling({ config: "peekling.json", inject: true }),
    /Unknown Peekling Vite option inject/,
  );
  assert.throws(
    () => peekling({ config: "" }),
    /config must be a bounded path/,
  );
  assert.throws(
    () => peekling({ config: "peekling.json", pack: 42 }),
    /pack must be a bounded path/,
  );
  assert.throws(
    () => peekling({ config: "peekling.json", baseUrl: "/relative/" }),
    /baseUrl must be an absolute HTTP or HTTPS URL/,
  );
});

test("ambiguous duplicate JSON keys stop validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-json-"));
  try {
    await writeFile(
      path.join(root, "peekling.json"),
      `{"plan":${JSON.stringify(minimalPlan("missing"))},"plan":${JSON.stringify(minimalPlan("idle"))}}\n`,
    );
    await writeFile(
      path.join(root, "character.json"),
      `${JSON.stringify(normalizedPack())}\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({
      config: "peekling.json",
      pack: "character.json",
    });
    await plugin.configResolved({ root, base: "/", command: "build" });

    await assert.rejects(
      async () => plugin.buildStart.call(viteContext()),
      /peekling\.json contains duplicate object key "plan"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("input paths cannot escape the resolved Vite root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "peekling-vite-root-"));
  const root = path.join(parent, "app");
  try {
    await mkdir(root);
    await writeFile(
      path.join(parent, "outside.json"),
      `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "../outside.json" });

    assert.throws(
      () => plugin.configResolved({ root, base: "/", command: "serve" }),
      /must stay inside the Vite root/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the default Vite base validates relative resource URLs deterministically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-base-"));
  try {
    await writeFile(
      path.join(root, "peekling.json"),
      `${JSON.stringify({
        packUrl: "./character.json",
        plan: minimalPlan("idle"),
      })}\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const plugin = peekling({ config: "peekling.json" });
    await plugin.configResolved({ root, base: "/docs/", command: "build" });

    await plugin.buildStart.call(viteContext());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "symlinked inputs cannot bypass the Vite root boundary",
  { skip: process.platform === "win32" },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "peekling-vite-link-"));
    const root = path.join(parent, "app");
    try {
      await mkdir(root);
      await writeFile(
        path.join(parent, "outside.json"),
        `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
      );
      await symlink(
        path.join(parent, "outside.json"),
        path.join(root, "peekling.json"),
      );
      const { peekling } = await import("@peekling/vite");
      const plugin = peekling({ config: "peekling.json" });
      assert.throws(
        () => plugin.configResolved({ root, base: "/", command: "build" }),
        /must stay inside the real Vite root|symbolic path component/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "a symlinked parent directory cannot escape the Vite root",
  { skip: process.platform === "win32" },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "peekling-vite-parent-"));
    const root = path.join(parent, "app");
    const outside = path.join(parent, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      await writeFile(
        path.join(outside, "peekling.json"),
        `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
      );
      await symlink(outside, path.join(root, "linked"));
      const { peekling } = await import("@peekling/vite");
      const plugin = peekling({ config: "linked/peekling.json" });
      assert.throws(
        () => plugin.configResolved({ root, base: "/", command: "build" }),
        /must stay inside the real Vite root|symbolic path component/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("a real Vite build validates inputs without adding dev tools to the client", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-build-"));
  const resolve = {
    alias: {
      "@peekling/runtime": path.resolve("packages/runtime/dist/index.js"),
    },
  };
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await writeFile(
      path.join(root, "src/main.js"),
      'import { hatch } from "@peekling/runtime"; console.log(typeof hatch);\n',
    );
    await writeFile(
      path.join(root, "peekling.json"),
      `${JSON.stringify({ plan: minimalPlan("idle") })}\n`,
    );
    await writeFile(
      path.join(root, "character.json"),
      `${JSON.stringify(normalizedPack())}\n`,
    );
    const [{ build }, { peekling }] = await Promise.all([
      import("vite"),
      import("@peekling/vite"),
    ]);
    await build({
      root,
      logLevel: "silent",
      resolve,
      plugins: [
        peekling({
          config: "peekling.json",
          pack: "character.json",
        }),
      ],
      build: { minify: false },
    });

    const assetDirectory = path.join(root, "dist/assets");
    const scriptName = (await readdir(assetDirectory)).find((name) =>
      name.endsWith(".js"),
    );
    assert.ok(scriptName);
    const client = await readFile(
      path.join(assetDirectory, scriptName),
      "utf8",
    );
    assert.doesNotMatch(
      client,
      /@peekling\/preflight|@peekling\/vite|Peekling Doctor|peekling:preflight|node:fs/,
    );
    const html = await readFile(path.join(root, "dist/index.html"), "utf8");
    assert.doesNotMatch(html, /peekling\.css|cdn\.jsdelivr|unpkg/);

    await writeFile(
      path.join(root, "peekling.json"),
      `${JSON.stringify({ plan: minimalPlan("missing") })}\n`,
    );
    await assert.rejects(
      build({
        root,
        logLevel: "silent",
        resolve,
        plugins: [
          peekling({
            config: "peekling.json",
            pack: "character.json",
          }),
        ],
        build: { outDir: "invalid-dist" },
      }),
      /unknown-state.*\$\.plan\.baseline\.state\.state/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the plugin reads JSON data without importing modules or fetching URLs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peekling-vite-data-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}/app/`;
    const marker = path.join(root, "executed.txt");
    await writeFile(
      path.join(root, "peekling.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad"); export default {};\n`,
    );
    const { peekling } = await import("@peekling/vite");
    const executable = peekling({ config: "peekling.mjs" });
    assert.throws(
      () => executable.configResolved({ root, base: "/", command: "build" }),
      /JSON data file/,
    );
    await assert.rejects(access(marker));

    await writeFile(
      path.join(root, "peekling.json"),
      `${JSON.stringify({
        packUrl: "./character.json",
        plan: minimalPlan("idle"),
      })}\n`,
    );
    await writeFile(
      path.join(root, "character.json"),
      `${JSON.stringify(normalizedPack())}\n`,
    );
    const dataOnly = peekling({
      config: "peekling.json",
      pack: "character.json",
      baseUrl,
    });
    await dataOnly.configResolved({ root, base: "/", command: "build" });
    await dataOnly.buildStart.call(viteContext());
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

function normalizedPack() {
  return {
    name: "fixture",
    displayName: "Fixture",
    version: "0.1.0",
    license: "CC0-1.0",
    atlas: {
      src: "atlas.png",
      sha256: "0".repeat(64),
      columns: 16,
      rows: 1,
      cellWidth: 32,
      cellHeight: 32,
    },
    states: { idle: { frames: [0], fps: 1, loop: true } },
    defaultScale: 1,
  };
}

function minimalPlan(state) {
  return {
    baseline: {
      channels: ["state"],
      state: { state },
    },
  };
}

function viteContext() {
  return {
    error(message) {
      throw new Error(String(message));
    },
    warn() {},
  };
}
