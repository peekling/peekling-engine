import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const atlas = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4AWPUSNnyn4WBgQEADVECRYmBs0MAAAAASUVORK5CYII=",
  "base64",
);
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
const browserTypes = { chromium, firefox, webkit };

export async function runBrowserPerformance({
  browserNames = ["chromium", "firefox", "webkit"],
  startupRepetitions = 20,
  warmupCount = 2,
  steadyFrameCount = 90,
  eventBurstRepetitions = 20,
  lifecycleRepetitions = 10,
  viewport = { width: 800, height: 600 },
  deviceScaleFactor = 1,
} = {}) {
  const server = await startPerformanceServer();
  const results = [];
  try {
    for (const name of browserNames) {
      const browserType = browserTypes[name];
      if (!browserType) throw new Error(`Unsupported browser: ${name}`);
      const browser = await browserType.launch({ headless: true });
      try {
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor,
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        await page.goto(`${server.origin}/?cache=no-store`);
        await page.waitForFunction(() => Boolean(window.__peeklingPerformance));
        const measured = await page.evaluate(
          (options) => window.__peeklingPerformance.run(options),
          {
            startupRepetitions,
            warmupCount,
            steadyFrameCount,
            eventBurstRepetitions,
            lifecycleRepetitions,
          },
        );
        const provenance = await page.evaluate(() => ({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          viewport: { width: innerWidth, height: innerHeight },
          deviceScaleFactor: devicePixelRatio,
        }));
        results.push({
          name,
          version: browser.version(),
          ...provenance,
          instrumentation: measured.instrumentation,
          longTasks: measured.longTasks,
          deliveryResources: measured.deliveryResources,
          scenarios: measured.scenarios,
          pageErrors,
          unhandledRejections: measured.unhandledRejections,
          cspViolations: measured.cspViolations,
        });
        await context.close();
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  return results;
}

export async function startPerformanceServer() {
  const files = new Map([
    [
      "/peekling.min.js",
      {
        body: await readFile("packages/runtime/dist/peekling.min.js"),
        type: "text/javascript; charset=utf-8",
      },
    ],
    [
      "/peekling.css",
      {
        body: await readFile("packages/runtime/dist/peekling.css"),
        type: "text/css; charset=utf-8",
      },
    ],
    [
      "/browser-performance-page.mjs",
      {
        body: await readFile(
          path.join(root, "scripts/browser-performance-page.mjs"),
        ),
        type: "text/javascript; charset=utf-8",
      },
    ],
    ["/atlas.png", { body: atlas, type: "image/png" }],
  ]);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const profile = url.searchParams.get("cache") ?? "no-store";
    const headers = {
      "cache-control":
        profile === "warm" ? "public, max-age=3600, immutable" : "no-store",
      "cross-origin-resource-policy": "same-origin",
    };
    if (url.pathname === "/") {
      response.writeHead(200, {
        ...headers,
        "content-security-policy": csp,
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
<meta charset="utf-8">
<title>Peekling browser performance</title>
<script defer src="/peekling.min.js?cache=${profile}"></script>
<script type="module" src="/browser-performance-page.mjs?cache=${profile}"></script>`);
      return;
    }
    const file = files.get(url.pathname);
    if (!file) {
      response.writeHead(404, headers);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { ...headers, "content-type": file.type });
    response.end(file.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
