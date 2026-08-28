import { expect, test } from "@playwright/test";
import { startExampleServer } from "../../examples/server.mjs";

let exampleServer;

test.beforeAll(async () => {
  exampleServer = await startExampleServer();
});

test.afterAll(async () => {
  await exampleServer.close();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.exampleCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.exampleCspViolations.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      });
    });
  });
});

test("the pointer-follow example moves one hatch-created character", async ({
  page,
}) => {
  const { failures } = collectFailures(page);
  await page.goto(`${exampleServer.url}/simple-pointer-follow/`);
  await expect(page.locator("[data-example-status]")).toHaveText("Ready");

  const host = page.locator("[data-peekling-host]");
  await expect(host).toHaveCount(1);
  const before = await host.getAttribute("data-peekling-x");
  await page.mouse.move(120, 120);
  await expect(host).toHaveAttribute("data-peekling-state", /move:/);
  await expect
    .poll(() => host.getAttribute("data-peekling-x"))
    .not.toBe(before);

  await expectNoFailures(page, failures);
});

test("job progress stays mounted while pointer motion continues", async ({
  page,
}) => {
  const { failures } = collectFailures(page);
  await page.goto(`${exampleServer.url}/job-progress/`);
  await expect(page.locator("[data-example-status]")).toHaveText("Ready");

  await page.getByRole("button", { name: "Start job" }).click();
  await expect(page.locator("[data-progress-value]")).toHaveText("0 of 4");
  await page.getByRole("button", { name: "Advance job" }).click();
  await expect(page.locator("[data-progress-value]")).toHaveText("1 of 4");
  await page.getByRole("button", { name: "Send stale update" }).click();
  await expect(page.locator("[data-progress-value]")).toHaveText("1 of 4");

  const surface = page.locator("aside[data-peekling-content]");
  await expect(surface).not.toHaveAttribute("hidden", "");
  const host = page.locator("[data-peekling-host]");
  const before = await host.getAttribute("data-peekling-x");
  await page.mouse.move(140, 120);
  await expect
    .poll(() => host.getAttribute("data-peekling-x"))
    .not.toBe(before);
  await expect(page.locator("[data-progress-value]")).toHaveText("1 of 4");
  await expect(surface).not.toHaveAttribute("hidden", "");

  await page.getByRole("button", { name: "Finish job" }).click();
  await expect(page.locator("[data-progress-value]")).toHaveText(
    "Finished: 4 files changed",
  );
  await expectNoFailures(page, failures);
});

test("the generic surface cleans up and its completion Event still reaches the Plan", async ({
  page,
}) => {
  const { failures } = collectFailures(page);
  await page.goto(`${exampleServer.url}/interactive-surface/`);
  await expect(page.locator("[data-example-status]")).toHaveText("Ready");

  await page.getByRole("button", { name: "Open review surface" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-review-surface",
    "mounted",
  );
  const surface = page.locator("aside[data-peekling-content]");
  await expect(surface).not.toHaveAttribute("hidden", "");
  const controlPoint = await page.evaluate(() => {
    let left = window.innerWidth;
    let right = 0;
    let top = window.innerHeight;
    let bottom = 0;
    for (let y = 0; y < window.innerHeight; y += 5) {
      for (let x = 0; x < window.innerWidth; x += 5) {
        if (
          document
            .elementFromPoint(x, y)
            ?.matches("aside[data-peekling-content]")
        ) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    return right > left && bottom > top
      ? { x: left + 20, y: bottom - 25 }
      : undefined;
  });
  expect(controlPoint).toBeDefined();
  await page.mouse.click(controlPoint.x, controlPoint.y);

  await expect(page.locator("[data-review-result]")).toHaveText(
    "Saved draft-17",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-override-reason",
    "event",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-review-cleanups",
    "1",
  );

  await page.getByRole("button", { name: "Destroy instance" }).click();
  await expect(page.locator("[data-peekling-host]")).toHaveCount(0);
  await expect(page.locator("aside[data-peekling-content]")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-review-cleanups",
    "2",
  );
  await expectNoFailures(page, failures);
});

test("the declarative element destroys and recreates its owned hatch instance", async ({
  page,
}) => {
  const { failures } = collectFailures(page);
  await page.goto(`${exampleServer.url}/web-component/`);
  await expect(page.locator("[data-example-status]")).toHaveText("Ready");
  await expect(page.locator("[data-peekling-host]")).toHaveCount(1);

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator("[data-peekling-host]")).toHaveCount(0);
  await expect(page.locator("[data-example-status]")).toHaveText(
    "Disconnected",
  );

  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.locator("[data-example-status]")).toHaveText("Ready again");
  await expect(page.locator("[data-peekling-host]")).toHaveCount(1);
  await expectNoFailures(page, failures);
});

function collectFailures(page) {
  const failures = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (isExpectedFixtureCancellation(request)) return;
    failures.push(`request: ${request.url()} ${request.failure()?.errorText}`);
  });
  return { failures };
}

function isExpectedFixtureCancellation(request) {
  if (request.failure()?.errorText !== "net::ERR_ABORTED") return false;
  return [
    `${exampleServer.url}/fixture/character.json`,
    `${exampleServer.url}/fixture/atlas.png`,
  ].includes(request.url());
}

async function expectNoFailures(page, failures) {
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => window.exampleCspViolations)).toEqual([]);
}
