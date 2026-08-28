# Peekling engine

Add a small animated companion to a website without adding a backend or
telemetry service. Peekling runs in the browser, keeps character Packs as data,
and gives the host application control through one documented runtime API.

This monorepo contains the dependency-free browser runtime and separate tools
for validating Configuration, Plans, and Packs before they reach a page.

## Start with the runnable examples

Prerequisites:

- Node.js 22.14.0 or newer
- npm 11.16.0

From the repository root:

```sh
npm ci
npm run examples
```

Open `http://127.0.0.1:4174`. You should see four local examples, beginning with
a character that follows the pointer. The example server builds the exact
runtime in this checkout and generates a synthetic Pack in memory. It does not
need an external character package or network service.

See the [example learning path](examples/README.md) for what to try on each
page.

## Add Peekling to an application

Install the runtime as an application dependency:

```sh
npm install @peekling/runtime
```

Every instance needs a character selection. The example below selects a Pack
served by the application and tells Vite to emit the required runtime
stylesheet. Replace the Pack path with a valid `character.json` whose States
include `idle`.

```js
import { hatch } from "@peekling/runtime";
import peeklingStyles from "@peekling/runtime/peekling.css?url";

const companion = hatch({
  packUrl: "/peeklings/my-character/character.json",
  styles: { url: peeklingStyles },
  plan: {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
  },
});

try {
  await companion.ready;
  console.log("Peekling is ready");
} catch (error) {
  console.error("Peekling could not start", error);
}

window.addEventListener("pagehide", () => companion.destroy(), { once: true });
```

Expected result: `ready` resolves after the Pack, atlas, and stylesheet have
been validated and loaded. The instance renders the Pack's `idle` State until
the Plan or a temporary Override selects another supported State.

For the complete Configuration shape, error behavior, Events, Effects, and
content surfaces, read [Configure Peekling](docs/configuration.md).

## How the engine fits together

```text
Pack data --------+
                  +--> validate --> compile Plan --> evaluate --> Effects
Configuration ----+                           ^                     |     |
                                              |                     |     +--> host surfaces
Browser and application Events --> admission-+                     +--------> atlas renderer
```

Artists provide a data-only Pack. Developers provide Configuration, including
one immutable baseline Plan. Peekling validates both, admits bounded browser and
application Events, evaluates matching Rules, and composes Effects only when
their presentation channels are compatible. Effects can update the character
renderer or a trusted host-mounted surface.

This separation keeps character data away from executable host code. The
[execution model](docs/execution-model.md) defines ordering, channel ownership,
temporary Overrides, lifecycle behavior, and cleanup.

## Choose an integration surface

| Need                                 | Surface                         | What it does                                                                 |
| ------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------- |
| JavaScript or TypeScript application | `hatch(configuration)`          | Creates one owned runtime instance                                           |
| Browser-global script                | `Peekling.hatch(configuration)` | Exposes the same hatch contract from the complete browser artifact           |
| HTML-first page                      | `<peekling-character>`          | Owns one hatch instance for each connected mount                             |
| Programmatic validation              | `@peekling/preflight`           | Checks bounded Configuration, Plan, and optional Pack data                   |
| Vite validation                      | `@peekling/vite`                | Runs Preflight at startup, on watched JSON changes, and before builds        |
| Command line and Pack authoring      | `peekling`                      | Runs Doctor and the Pack creation, compilation, import, and validation tools |

The ESM root has no registration side effects. Call `definePeeklingElement()`
when an ESM application wants the Web Component. The complete browser artifact
registers the component automatically when the name is free. Neither surface
replaces an unrelated browser global or custom element.

### Browser script and Web Component

Use exact version pins for external delivery. Replace both integrity
placeholders with the values emitted by the release build, and replace the Pack
path with a valid manifest hosted by the application:

```html
<script
  defer
  src="https://cdn.jsdelivr.net/npm/@peekling/runtime@0.1.1/dist/peekling.min.js"
  integrity="sha384-<runtime-sri-from-build>"
  crossorigin="anonymous"
></script>
<peekling-character
  pack-url="/peeklings/my-character/character.json"
  styles-url="https://cdn.jsdelivr.net/npm/@peekling/runtime@0.1.1/dist/peekling.css"
  styles-integrity="sha256-<stylesheet-sri-from-build>"
></peekling-character>
```

Expected result: the complete browser artifact claims `globalThis.Peekling` and
registers `<peekling-character>` when those names are free. The element creates
one hatch-owned instance after the pinned runtime, stylesheet, and selected Pack
pass their loading and integrity checks.

## Character selection

Each mount must provide one of these inputs:

- `character`, for a name in the runtime's pinned registry
- `packUrl`, for a validated manifest URL
- `pack`, for inline Native or normalized Pack data

`hatch("peek")` is shorthand for the pinned `peek` registry entry. It performs a
network request for the manifest and selected atlas. Self-hosted applications
can use `packUrl` or inline Pack data instead.

The runtime verifies manifest and atlas integrity before decoding character art.
An `atlasUrl` may point to a byte-identical mirror. It is not an image
conversion hook. Density-variant Packs also require an explicit `density` when
an atlas mirror is supplied.

## Runtime safety

- Packs are data, never code. Pack strings do not enter HTML-parsing sinks.
- The runtime does not send telemetry and owns no network service.
- Strict Content Security Policy support does not require `unsafe-inline` or
  `unsafe-eval`.
- Closed Shadow DOM contains runtime presentation without pretending to be a
  security boundary.
- Paused, backgrounded, and dismissed instances stop ordinary animation,
  evaluation, and collection work.
- `destroy()` releases listeners, observers, timers, roots, and object URLs
  owned by that instance.
- Host mount functions remain trusted application code. Their failures are
  contained at the surface boundary where the browser permits it.

The detailed browser, CSP, CORS, iframe, top-layer, and host-layout boundaries
are documented in
[Browser compatibility and hosting](docs/compatibility-and-hosting.md).

## Packages

| Package                       | Install role                                | Browser runtime graph                         |
| ----------------------------- | ------------------------------------------- | --------------------------------------------- |
| `@peekling/runtime`           | Application dependency                      | Required when the application uses Peekling   |
| `@peekling/preflight`         | Development dependency                      | Excluded                                      |
| `@peekling/vite`              | Development dependency                      | Excluded                                      |
| `@peekling/cli`               | Development dependency or command-line tool | Excluded                                      |
| `@peekling/adapter-codex-pet` | Optional interoperability dependency        | Included only when the application imports it |

Character artwork, website code, design-system sources, and framework-specific
adapters are outside this repository. Nothing in those products is silently
bundled into the runtime.

## Validate a project before it runs

Doctor checks JSON Configuration and optional Pack data without importing
application modules or contacting the network:

```sh
npm install --save-dev @peekling/cli @peekling/preflight
npx peekling doctor ./peekling.json --pack ./character.json
npx peekling doctor ./peekling.json --pack ./character.json --json
```

Vite applications can run the same semantic validation at startup, during
watched JSON changes, and before production builds:

```sh
npm install --save-dev @peekling/vite
```

Read the [`@peekling/cli`](packages/cli/README.md),
[`@peekling/preflight`](packages/preflight/README.md), and
[`@peekling/vite`](packages/vite/README.md) guides for complete examples.

## Bundle budget

The complete browser artifact has separate gzip and Brotli release gates. The
record below is generated from canonical artifact evidence and is tied to its
recorded hashes.

<!-- peekling-size-evidence:start -->

The recorded canonical delivery measurement is 32,287 bytes gzip and 28,635
bytes Brotli. Against the 32 KiB gzip and 32 KiB Brotli caps, that recorded
build leaves 481 bytes of gzip headroom and 4,133 bytes of Brotli headroom.
After the required 256-byte reserve, 225 gzip bytes and 3,877 Brotli bytes
remain for that build.
<!-- peekling-size-evidence:end -->

Node 22.14.0, npm 11.16.0, and Node's default zlib compression define the exact
release-size measurement environment. Other supported Node versions can run a
local size check, but they do not certify the recorded figures.

## Develop and verify

Run the core repository gate:

```sh
npm ci
npm run check
```

`npm run check` maps to `check:core`. It covers formatting, build, lint,
boundaries, workflow safety, package metadata, distribution contents, types,
unit tests, bundle size, and the runtime performance smoke test.

Run browser behavior separately:

```sh
npm run test:browser
```

That Playwright command exercises Chromium, Firefox, and WebKit. The canonical
browser performance gate is a separate release workflow described in
[Browser performance release evidence](docs/browser-performance.md).

Useful focused commands:

| Command                           | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `npm run examples`                | Build and serve the local learning examples            |
| `npm run test:examples`           | Test example structure and Chromium behavior           |
| `npm run release:verify:packages` | Build clean package archives and test consumer imports |
| `npm run release:verify:local`    | Rehearse local release gates without remote assertions |
| `npm run size`                    | Check compressed runtime and ESM measurements          |

The [release guide](docs/RELEASING.md) owns tagging, provenance, CI, and package
publication procedure.

## Documentation

Use the [documentation map](docs/README.md) when you are not sure which guide
owns a question.

Start here:

- [Configure Peekling](docs/configuration.md)
- [Runnable examples](examples/README.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Browser compatibility and hosting](docs/compatibility-and-hosting.md)

Understand the engine:

- [Execution model](docs/execution-model.md)
- [Engine design](DESIGN.md)
- [Schema and type references](docs/schema/README.md)
- [Browser performance release evidence](docs/browser-performance.md)

Work on the repository:

- [Contributing](CONTRIBUTING.md)
- [Support policy](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Release guide](docs/RELEASING.md)
- [Changelog](CHANGELOG.md)
- [Licensing and attribution](LICENSING.md)

## License

The engine and its original tooling are Apache-2.0. Character artwork keeps its
own Pack license. See [licensing and attribution](LICENSING.md) and
[`NOTICE`](NOTICE) for the repository boundary.
