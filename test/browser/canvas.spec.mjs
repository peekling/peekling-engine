import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const runtimeDist = path.resolve("packages/runtime/dist");
const runtimeFiles = new Map(
  await Promise.all(
    (await readdir(runtimeDist))
      .filter((name) => name.endsWith(".js"))
      .map(async (name) => [
        name,
        await readFile(path.join(runtimeDist, name)),
      ]),
  ),
);
const runtimeCss = await readFile(path.join(runtimeDist, "peekling.css"));
const runtimeCssIntegrity = (
  await readFile(path.join(runtimeDist, "peekling.css.sri"), "utf8")
).trim();
const atlas = PNG.sync.write(new PNG({ width: 2, height: 1 }));
const atlasSha256 = createHash("sha256").update(atlas).digest("hex");

test("Canvas hatch draws through the shared runtime and cleans up", async ({
  page,
}) => {
  await page.route("https://canvas.peekling.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><body></body>",
      contentType: "text/html",
    }),
  );
  await page.route("https://canvas.peekling.test/runtime/**", (route) => {
    const name = path.posix.basename(new URL(route.request().url()).pathname);
    if (name === "peekling.css") {
      return route.fulfill({ body: runtimeCss, contentType: "text/css" });
    }
    const body = runtimeFiles.get(name);
    if (!body) return route.fulfill({ status: 404, body: "Not found" });
    return route.fulfill({ body, contentType: "text/javascript" });
  });
  await page.route("https://canvas.peekling.test/atlas.png", (route) =>
    route.fulfill({ body: atlas, contentType: "image/png" }),
  );
  await page.goto("https://canvas.peekling.test/");

  const ready = await page.evaluate(
    async ({ atlasSha256, runtimeCssIntegrity }) => {
      const { hatchCanvas } = await import("/runtime/canvas.js");
      window.canvasPeekling = hatchCanvas({
        pack: {
          name: "canvas-fixture",
          displayName: "Canvas fixture",
          version: "0.1.1",
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
          },
          defaultScale: 4,
        },
        atlasUrl: "/atlas.png",
        styles: {
          url: "/runtime/peekling.css",
          integrity: runtimeCssIntegrity,
        },
        plan: {
          baseline: {
            channels: ["state", "surface:controls"],
            state: { state: "idle" },
            surfaces: [{ id: "controls", contentId: "controls" }],
          },
        },
        content: { controls: { "top-center": { mountId: "controls" } } },
        bindings: {
          mounts: {
            controls({ root }) {
              root.append(document.createTextNode("Canvas controls"));
              return {
                cleanup() {
                  root.replaceChildren();
                },
              };
            },
          },
        },
        diagnostics: { console: false },
      });
      await window.canvasPeekling.ready;
      return true;
    },
    { atlasSha256, runtimeCssIntegrity },
  );

  expect(ready).toBe(true);
  const host = page.locator('[data-peekling-renderer="canvas"]');
  await expect(host).toHaveCount(1);
  await expect(host).toHaveAttribute("data-peekling-state", "idle");
  await expect(host).toHaveAttribute("data-peekling-frame", /[01]/);
  await expect(host).toHaveAttribute("data-peekling-x", /-?\d+(?:\.\d+)?/);
  await expect(host).toHaveAttribute("data-peekling-y", /-?\d+(?:\.\d+)?/);
  await expect(page.locator("[data-peekling-content]")).not.toHaveAttribute(
    "hidden",
    "",
  );

  const contentVisibility = await page.evaluate(() => {
    const content = document.querySelector("[data-peekling-content]");
    const hidden = window.canvasPeekling.setContentVisible(false);
    const hiddenAttribute = content?.hidden;
    const hiddenDisplay = content ? getComputedStyle(content).display : null;
    const shown = window.canvasPeekling.setContentVisible(true);
    const shownAttribute = content?.hidden;
    const toggled = window.canvasPeekling.toggleContent();
    return {
      hidden,
      hiddenAttribute,
      hiddenDisplay,
      shown,
      shownAttribute,
      toggled,
    };
  });
  expect(contentVisibility).toEqual({
    hidden: false,
    hiddenAttribute: true,
    hiddenDisplay: "none",
    shown: true,
    shownAttribute: false,
    toggled: false,
  });

  const roots = await page.evaluate(() => {
    window.canvasPeekling.destroy();
    return document.querySelectorAll(
      "[data-peekling-host], [data-peekling-interaction]",
    ).length;
  });
  expect(roots).toBe(0);
});
