import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const failures = [];
for await (const path of glob(
  "{packages,test,examples}/**/*.{ts,mjs,js,html}",
)) {
  const source = await readFile(path, "utf8");
  for (const sink of [
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "eval(",
    "new Function(",
  ]) {
    if (source.includes(sink)) failures.push(`${path}: forbidden sink ${sink}`);
  }
  // Production packages are embedded into other sites and may never cancel host
  // events. Demo-owned controls may consume their own keyboard navigation.
  if (
    path.startsWith("packages/") &&
    (/preventDefault\s*\(/.test(source) || /stopPropagation\s*\(/.test(source))
  ) {
    failures.push(`${path}: host-page event cancellation is forbidden`);
  }
  if (
    path.startsWith("packages/") &&
    (/setAttribute\(\s*["']on/i.test(source) || /\.on[a-z]+\s*=/.test(source))
  ) {
    failures.push(`${path}: inline event handlers are forbidden`);
  }
  if (
    path.startsWith("packages/runtime/src/") &&
    /\b(?:sendBeacon|XMLHttpRequest|WebSocket|EventSource)\b/.test(source)
  ) {
    failures.push(`${path}: telemetry-capable network API is forbidden`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
