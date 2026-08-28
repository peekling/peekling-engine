import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const examplesRoot = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(examplesRoot, "../packages/runtime/dist");
const fixtureAtlas = createFixtureAtlas();
const fixtureManifest = JSON.stringify({
  format: 1,
  name: "example-fixture",
  version: "0.1.0",
  license: "CC0-1.0",
  metadata: {
    title: "Example fixture",
    description:
      "A synthetic local character used only by the runnable examples.",
  },
  assets: {
    atlas: {
      src: "atlas.png",
      sha256: createHash("sha256").update(fixtureAtlas).digest("hex"),
      columns: 16,
      rows: 2,
      density: 1,
      logicalCellSize: 32,
      sourceCellSize: 32,
    },
  },
  states: {
    idle: { frames: [0], fps: 1, loop: true },
    "move:N": { frames: [1], fps: 1, loop: true },
    "move:NE": { frames: [2], fps: 1, loop: true },
    "move:E": { frames: [3], fps: 1, loop: true },
    "move:SE": { frames: [4], fps: 1, loop: true },
    "move:S": { frames: [5], fps: 1, loop: true },
    "move:SW": { frames: [6], fps: 1, loop: true },
    "move:W": { frames: [7], fps: 1, loop: true },
    "move:NW": { frames: [8], fps: 1, loop: true },
    alert: { frames: [9], fps: 1, loop: true },
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
  defaults: { scale: 2 },
});

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "connect-src 'self'",
  "img-src 'self' blob:",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export async function startExampleServer({
  hostname = "127.0.0.1",
  port = 0,
} = {}) {
  const server = createServer((request, response) => {
    void serve(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Example server did not receive a TCP address");
  }
  return {
    url: `http://${hostname}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function serve(request, response) {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === "/fixture/character.json") {
      return send(
        response,
        200,
        "application/json; charset=utf-8",
        fixtureManifest,
      );
    }
    if (pathname === "/fixture/atlas.png") {
      return send(response, 200, "image/png", fixtureAtlas);
    }
    if (pathname === "/runtime/peekling.js") {
      return await sendFile(
        response,
        path.join(runtimeRoot, "peekling.js"),
        "text/javascript; charset=utf-8",
      );
    }
    if (pathname === "/runtime/peekling.css") {
      return await sendFile(
        response,
        path.join(runtimeRoot, "peekling.css"),
        "text/css; charset=utf-8",
      );
    }
    const relative =
      pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const candidate = path.resolve(
      examplesRoot,
      relative.endsWith("/") ? `${relative}index.html` : relative,
    );
    const confined = path.relative(examplesRoot, candidate);
    if (confined.startsWith("..") || path.isAbsolute(confined)) {
      return send(response, 404, "text/plain; charset=utf-8", "Not found\n");
    }
    const type = contentType(candidate);
    if (!type)
      return send(response, 404, "text/plain; charset=utf-8", "Not found\n");
    return await sendFile(response, candidate, type);
  } catch {
    return send(response, 404, "text/plain; charset=utf-8", "Not found\n");
  }
}

async function sendFile(response, target, type) {
  const body = await readFile(target);
  send(response, 200, type, body);
}

function send(response, status, type, body) {
  response.writeHead(status, {
    "content-type": type,
    "content-security-policy": csp,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  response.end(body);
}

function contentType(target) {
  if (target.endsWith(".html")) return "text/html; charset=utf-8";
  if (target.endsWith(".js") || target.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (target.endsWith(".css")) return "text/css; charset=utf-8";
  return undefined;
}

function createFixtureAtlas() {
  const width = 16 * 32;
  const height = 64;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  const colors = [
    [244, 188, 62],
    [133, 141, 232],
    [255, 159, 189],
  ];
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const cell = Math.floor(x / 32);
      const localX = x % 32;
      const dx = localX - 16;
      const localY = y % 32;
      const dy = localY - 17;
      const body = dx * dx + dy * dy < 11 * 11;
      const ear =
        localY >= 4 &&
        localY <= 12 &&
        (localX === Math.floor(9 + localY / 4) ||
          localX === Math.ceil(23 - localY / 4));
      const eye =
        localY >= 14 && localY <= 16 && (localX === 13 || localX === 19);
      if (!body && !ear) continue;
      const offset = row + 1 + x * 4;
      const color = colors[cell % colors.length];
      raw[offset] = eye ? 38 : color[0];
      raw[offset + 1] = eye ? 38 : color[1];
      raw[offset + 2] = eye ? 38 : color[2];
      raw[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk(
      "IHDR",
      Buffer.from([...uint32(width), ...uint32(height), 8, 6, 0, 0, 0]),
    ),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  return Buffer.concat([
    Buffer.from(uint32(data.length)),
    name,
    data,
    Buffer.from(uint32(crc32(Buffer.concat([name, data])))),
  ]);
}

function uint32(value) {
  return [value >>> 24, value >>> 16, value >>> 8, value].map(
    (byte) => byte & 255,
  );
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const configuredPort = Number.parseInt(
    process.env.PEEKLING_EXAMPLES_PORT ?? "4174",
    10,
  );
  const server = await startExampleServer({ port: configuredPort });
  console.log(`Peekling examples: ${server.url}`);
  const stop = async () => {
    await server.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
