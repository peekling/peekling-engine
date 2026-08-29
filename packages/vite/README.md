# `@peekling/vite`

Use the Peekling Vite plugin to validate declared Configuration and Pack JSON
when Vite starts, when either file changes, and before a production build. The
plugin runs in Node and does not add code or assets to the browser bundle.

## Prerequisites and installation

- Node.js 22.14.0 or newer
- Vite 8
- `@peekling/runtime` 0.1.4 in the application

Install the runtime and the development plugin:

```sh
npm install @peekling/runtime@0.1.4
npm install --save-dev @peekling/vite@0.1.4
```

Vite is a peer dependency. `@peekling/vite` depends on `@peekling/preflight`,
which uses the exact matching runtime version for shared validation.

## Configure the plugin

This framework-neutral example validates two JSON files inside the Vite root:

```js
// vite.config.js
import { defineConfig } from "vite";
import { peekling } from "@peekling/vite";

export default defineConfig({
  plugins: [
    peekling({
      config: "src/peekling.json",
      pack: "public/peekling/character.json",
      baseUrl: "https://example.com/app/",
    }),
  ],
});
```

One matching project layout is:

```text
project/
  vite.config.js
  src/
    peekling.json
  public/
    peekling/
      character.json
      atlas.png
```

Expected result: Vite starts normally when both files pass Preflight. An invalid
file reports the diagnostic code, data path, explanation, and suggested fix.
During development, that invalid edit stops the affected hot update. During a
production build, it fails through Vite's plugin error channel.

Framework plugins can stay in the same `plugins` array. Peekling does not
require React, Vue, or another framework plugin.

## Options

| Option    | Required | Meaning                                                                        |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `config`  | Yes      | Configuration JSON path relative to the resolved Vite root                     |
| `pack`    | No       | Pack JSON path relative to the resolved Vite root                              |
| `baseUrl` | No       | Absolute HTTP or HTTPS page URL used to resolve relative serialized references |

Pass `pack` whenever the Plan names Pack States or Capabilities. Without Pack
context, Preflight cannot prove that those references exist.

When `baseUrl` is omitted, the plugin resolves Vite's configured `base` against
`https://peekling.invalid/`. That placeholder checks relative URL syntax without
claiming a deployment origin. Pass the real page URL when validation should
model an actual development or deployment path.

`baseUrl` may use HTTP for local development. Absolute resource URLs stored in
Configuration or Pack data must still use HTTPS.

## When validation runs

| Vite phase               | Plugin behavior                                           |
| ------------------------ | --------------------------------------------------------- |
| Configuration resolved   | Resolves the real Vite root and confined input paths      |
| Build start              | Reads both files and fails the build on validation errors |
| Development server start | Confirms both inputs and registers them with the watcher  |
| Hot update               | Rechecks both inputs when either declared file changes    |

A valid edit returns control to normal Vite hot module replacement. The plugin
does not transform the JSON into a client module or fetch the resource URLs it
contains.

## Node and browser graphs stay separate

```mermaid
flowchart TD
  subgraph node[Node and Vite process]
    data[Configuration and Pack JSON] --> plugin[@peekling/vite]
    plugin --> preflight[@peekling/preflight]
    preflight --> tooling[@peekling/runtime tooling subpaths]
  end

  subgraph browser[Application browser graph]
    app[Application code] --> runtime[@peekling/runtime]
  end
```

In prose, the plugin and Preflight run only in Vite's Node process. Application
code imports the runtime separately. There is no client edge from the plugin to
the runtime, so the plugin does not inject Peekling JavaScript, CSS, CDN URLs,
or framework adapters.

Vite executes `vite.config.js` through its normal configuration boundary. Once
Vite calls `peekling(...)`, this plugin treats the supplied paths as data
locations and does not execute application source.

## File safety

Every declared input must resolve to a regular file inside the real Vite root.
The plugin rejects:

- symbolic links in the file or any parent path
- paths that resolve outside the root
- duplicate JSON object keys
- invalid UTF-8 or non-data input
- files larger than 64 KiB
- files whose identity changes around the bounded read

Watch registration applies the same path boundary before adding a file. Hot
updates read through the bounded path instead of Vite's unrestricted convenience
read.

## Troubleshooting

### Plan references cannot be checked

Add the Pack file to the plugin options:

```js
peekling({
  config: "src/peekling.json",
  pack: "public/peekling/character.json",
});
```

### A relative URL resolves against the wrong page

Set `baseUrl` to the full page URL that will host the runtime:

```js
peekling({
  config: "src/peekling.json",
  pack: "public/peekling/character.json",
  baseUrl: "https://example.com/docs/guide/",
});
```

### A symlinked input is rejected

Move or copy the JSON data into the real Vite root. The plugin deliberately does
not follow a symbolic path outside that boundary.

## Related documentation

- [Configure Peekling](../../docs/configuration.md)
- [`@peekling/preflight`](../preflight/README.md)
- [`@peekling/cli`](../cli/README.md)
- [`@peekling/runtime`](../runtime/README.md)

## License

Apache-2.0. See [licensing and attribution](LICENSING.md) for notice retention,
authorship, and brand boundaries.
