# `@peekling/preflight`

Use Preflight to check Peekling Configuration, Plan, and optional Pack data in
Node without opening a browser, fetching resources, or executing application
code. It is intended for development tools, tests, and CI.

## Prerequisites and installation

- Node.js 22.14.0 or newer
- The exact matching `@peekling/runtime` version

Install the runtime for the application and Preflight for development:

```sh
npm install @peekling/runtime@0.1.1
npm install --save-dev @peekling/preflight@0.1.1
```

`@peekling/preflight` declares the exact runtime version as a peer dependency.
That keeps development validation aligned with the runtime used by the
application.

## Run a complete check

This example is self-contained. The all-zero SHA-256 is valid test metadata for
Preflight, which does not fetch the atlas. Replace it with the hash of the real
atlas bytes before passing the Pack to the browser runtime.

```js
import { preflight } from "@peekling/preflight";

const configuration = {
  packUrl: "./character.json",
  plan: {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
  },
};

const pack = {
  name: "preflight-example",
  displayName: "Preflight example",
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
  states: {
    idle: { frames: [0], fps: 1, loop: true },
  },
  defaultScale: 1,
};

const report = preflight(configuration, {
  pack,
  baseUrl: "https://example.com/app/",
});

console.log(report);
```

Expected result:

```js
{
  valid: true,
  errors: [],
  warnings: [],
}
```

Passing the Pack through the second argument supplies explicit Pack context for
authoring tools. Preflight can then check every Plan State and Capability
reference instead of reporting that Pack context is missing.

## API

```ts
preflight(configuration, options?): PreflightResult
```

| Argument          | Type      | Required | Meaning                                                                  |
| ----------------- | --------- | -------- | ------------------------------------------------------------------------ |
| `configuration`   | `unknown` | Yes      | Configuration data to snapshot and validate                              |
| `options.pack`    | `unknown` | No       | Native or normalized Pack data used to check Plan references             |
| `options.baseUrl` | `string`  | No       | Absolute HTTP or HTTPS page URL used only to resolve relative references |

Configuration must select `character`, `packUrl`, or inline `pack`. Supplying
`options.pack` also counts as explicit selection for an authoring tool. Do not
pass both an inline Configuration Pack and `options.pack`.

The result is deterministic:

```ts
interface PreflightResult {
  readonly valid: boolean;
  readonly errors: readonly PreflightDiagnostic[];
  readonly warnings: readonly PreflightDiagnostic[];
}

interface PreflightDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}
```

`valid` is `true` only when `errors` is empty. Warnings still need review, but
they do not change `valid` by themselves.

## Handle diagnostics

```js
const report = preflight(configuration, { pack });

for (const warning of report.warnings) {
  console.warn(`${warning.code} at ${warning.path}: ${warning.message}`);
}

if (!report.valid) {
  for (const error of report.errors) {
    console.error(`${error.code} at ${error.path}: ${error.message}`);
    console.error(`Fix: ${error.fix}`);
  }
  process.exitCode = 1;
}
```

Expected result: valid input leaves the process exit code unchanged. Invalid
input prints stable field paths and sets exit status `1` for CI.

## What Preflight checks

- Configuration uses the closed public shape and selects a Pack.
- Plan Rules, Effects, channel ownership, and lifetimes are valid.
- Pack context supports every referenced State and Capability.
- Relative resource and content-link paths resolve against `baseUrl`.
- Absolute serialized resource URLs use canonical HTTPS.
- Theme colors use lowercase `transparent` or exact 3, 4, 6, or 8 digit hex.
- JavaScript records contain own data properties instead of inherited fields or
  accessors.
- Atlas mirror and density choices agree with the supplied Pack.

Preflight rejects credentials, malformed hosts or ports, protocol-relative and
absolute HTTP resource URLs, Unicode whitespace, control characters,
backslashes, and noncanonical IP spelling. An HTTP `baseUrl` is allowed for
local development, but serialized absolute resource URLs still require HTTPS.

Preflight does not fetch manifests, read atlas bytes, decode images, import
application modules, run predicates, or call host callbacks. Runtime admission
still validates data and resources that exist only in the browser.

## Data boundary

JavaScript records must use the current realm's ordinary `Object.prototype` or a
null prototype. Custom prototypes, inherited fields, ordinary objects from
another realm, and accessors reject. Parse cross-realm JSON in the receiving
realm before checking it.

Pack and Configuration snapshots are bounded. This prevents an authoring tool
from handing unrestricted object graphs to the shared validators.

## Choose the right integration

| Need                                                     | Use                                    |
| -------------------------------------------------------- | -------------------------------------- |
| Call validation from JavaScript                          | `@peekling/preflight`                  |
| Check JSON files from a terminal or CI job               | `peekling doctor` from `@peekling/cli` |
| Check declared JSON files during Vite startup and builds | `@peekling/vite`                       |
| Validate live browser Configuration and fetched bytes    | `@peekling/runtime`                    |

Doctor applies the same semantic checks, then adds bounded JSON file reading and
command-line output. Vite adds root-confined file handling and watched-input
behavior. The browser runtime uses the same semantic kernel with a compact
fail-fast diagnostic sink.

## Related documentation

- [Configure Peekling](../../docs/configuration.md)
- [`@peekling/cli`](../cli/README.md)
- [`@peekling/vite`](../vite/README.md)
- [`@peekling/runtime`](../runtime/README.md)

## License

Apache-2.0. See [licensing and attribution](LICENSING.md) for notice retention,
authorship, and brand boundaries.
