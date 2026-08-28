import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  finalizePerformanceReport,
  QUICK_PERFORMANCE_PROFILE,
  RELEASE_PERFORMANCE_PROFILE,
} from "./browser-performance-core.mjs";
import { runBrowserPerformance } from "./browser-performance-runner.mjs";

const options = parseArguments(process.argv.slice(2));
const runtime = await readFile("packages/runtime/dist/peekling.min.js");
const stylesheet = await readFile("packages/runtime/dist/peekling.css");
const browsers = await runBrowserPerformance(options);
const report = finalizePerformanceReport(
  {
    generatedAt: new Date().toISOString(),
    context: {
      host: {
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        node: process.version,
      },
      source: sourceContext(),
      viewport: options.viewport,
      deviceScaleFactor: options.deviceScaleFactor,
      startupRepetitions: options.startupRepetitions,
      warmupCount: options.warmupCount,
      steadyFrameCount: options.steadyFrameCount,
      eventBurstRepetitions: options.eventBurstRepetitions,
      lifecycleRepetitions: options.lifecycleRepetitions,
      cacheProfiles: ["loopback-no-store", "loopback-cacheable"],
      networkProfile: "local loopback HTTP with fixed response bytes",
      artifact: {
        runtimeBytes: runtime.byteLength,
        stylesheetBytes: stylesheet.byteLength,
        runtimeSha256: sha256(runtime),
        stylesheetSha256: sha256(stylesheet),
      },
    },
  },
  browsers,
  options.profile,
);
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(options.output, serialized);
}
process.stdout.write(serialized);
if (!report.gate.passed) process.exitCode = 1;

function parseArguments(args) {
  const quick = args.includes("--quick");
  const browser = value(args, "--browser") ?? "all";
  const output = value(args, "--output");
  const allowed = new Set(["--quick", "--browser", "--output"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) {
      throw new Error(`Unknown browser performance option: ${argument}`);
    }
    if (argument === "--browser" || argument === "--output") index += 1;
  }
  const browserNames =
    browser === "all" ? ["chromium", "firefox", "webkit"] : [browser];
  const selected = quick
    ? QUICK_PERFORMANCE_PROFILE
    : RELEASE_PERFORMANCE_PROFILE;
  return {
    profile: quick ? "quick" : "release",
    browserNames,
    output,
    startupRepetitions: selected.startupRepetitions,
    warmupCount: selected.warmupCount,
    steadyFrameCount: selected.steadyFrameCount,
    eventBurstRepetitions: selected.eventBurstRepetitions,
    lifecycleRepetitions: selected.lifecycleRepetitions,
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  };
}

function value(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceContext() {
  const commit = capture("git", ["rev-parse", "HEAD"]);
  const origin = capture("git", ["remote", "get-url", "origin"]);
  return {
    commit: commit || null,
    origin: origin || null,
    immutableProvenance: false,
    note:
      commit && origin
        ? "Commit and origin are recorded, but tag and clean-source verification remain release-verifier responsibilities."
        : "No immutable source provenance is available in this local checkout.",
  };
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
