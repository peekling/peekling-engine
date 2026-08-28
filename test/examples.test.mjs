import assert from "node:assert/strict";
import test from "node:test";
import { startExampleServer } from "../examples/server.mjs";

const pages = [
  "/",
  "/simple-pointer-follow/",
  "/job-progress/",
  "/interactive-surface/",
  "/web-component/",
];

test("the local example server delivers every page under strict CSP", async () => {
  const server = await startExampleServer();
  try {
    for (const pathname of pages) {
      const response = await fetch(`${server.url}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const policy = response.headers.get("content-security-policy") ?? "";
      assert.match(policy, /script-src 'self'/);
      assert.match(policy, /style-src 'self'/);
      assert.match(policy, /style-src-attr 'none'/);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);

      const html = await response.text();
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, pathname);
      assert.doesNotMatch(html, /<style\b/i, pathname);
      assert.doesNotMatch(html, /\sstyle\s*=/i, pathname);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, pathname);
    }
  } finally {
    await server.close();
  }
});

test("the examples index names the complete learning path", async () => {
  const server = await startExampleServer();
  try {
    const html = await fetch(server.url).then((response) => response.text());
    for (const pathname of pages.slice(1)) {
      assert.match(html, new RegExp(`href=["']${pathname}["']`));
    }
  } finally {
    await server.close();
  }
});
