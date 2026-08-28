import { brotliCompressSync, gzipSync } from "node:zlib";
import { build } from "esbuild";

const compositions = {
  hatch: ["hatch"],
  visibility: ["hidePeekling", "showPeekling", "isPeeklingHidden"],
  webComponent: ["definePeeklingElement"],
};

export async function measureEsmCompositions() {
  const measurements = {};
  for (const [name, imports] of Object.entries(compositions)) {
    const identifiers = imports.join(",");
    const result = await build({
      stdin: {
        contents:
          `import {${identifiers}} from "./packages/runtime/dist/index.js";` +
          `globalThis.__peeklingMeasurement=[${identifiers}];`,
        resolveDir: process.cwd(),
        sourcefile: `${name}.mjs`,
      },
      bundle: true,
      format: "esm",
      metafile: true,
      minify: true,
      platform: "browser",
      target: ["es2022"],
      treeShaking: true,
      write: false,
    });
    const output = result.outputFiles[0].contents;
    const metadata = Object.values(result.metafile.outputs)[0];
    measurements[name] = {
      rawBytes: output.byteLength,
      gzipBytes: gzipSync(output).byteLength,
      brotliBytes: brotliCompressSync(output).byteLength,
      modules: Object.keys(metadata.inputs)
        .filter((path) => path.startsWith("packages/runtime/dist/"))
        .sort(),
    };
  }
  return measurements;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await measureEsmCompositions(), null, 2));
}
