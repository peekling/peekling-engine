# `@peekling/runtime`

The dependency-free browser engine for data-only Peekling character Packs.
Developers choose a Pack and describe page behavior with one Configuration and
one immutable Plan. Peekling validates both before it renders.

The runtime performs no telemetry and requires no Peekling backend. Character
data cannot contain code, callbacks, DOM nodes, or raw HTML.

## Install

```sh
npm install @peekling/runtime@0.1.5
```

The runtime supports modern ESM applications and the complete browser bundle.
Tooling and server-side imports require Node 22.14 or newer.

## First character with ESM

This Vite example emits the package stylesheet as an asset, selects the pinned
`peek` Pack, waits for the first valid runtime state, and owns teardown:

```js
import { hatch } from "@peekling/runtime";
import peeklingStyles from "@peekling/runtime/peekling.css?url";

let companion;

try {
  companion = hatch({
    character: "peek",
    styles: { url: peeklingStyles },
  });

  await companion.ready;
} catch (error) {
  console.error("Peekling did not start", error);
}

// Call this from the owning view's teardown hook.
export function destroyPeekling() {
  companion?.destroy();
}
```

After `ready` resolves, the Pack, stylesheet, initial State, and owned DOM are
ready. `character: "peek"` is a networked selection. It resolves an exact pinned
manifest and verifies the manifest and selected atlas before browser decoding.

The default `companion` behavior follows the pointer when the Pack provides
locomotion. The character can also be dragged and thrown. Clicking the character
shows or hides its owned content bubble. Set `interaction: false` only when the
host needs a pointer-transparent character with no direct control.

Other bundlers can copy `@peekling/runtime/peekling.css` to a public asset and
pass its final URL through `styles.url`. An HTTP or HTTPS ESM module can omit
`styles` when a usable `peekling.css` sits beside the module. A module location
that cannot identify an HTTP or HTTPS stylesheet fails with `styles.default`
instead of silently rendering without styles.

## Choose a Pack

Configure one source when possible:

| Source            | Example                                            | Network behavior                                              |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Registered alias  | `{ character: "peek" }`                            | Fetches the alias's pinned manifest and one atlas.            |
| Explicit manifest | `{ packUrl: "/characters/moss/character.json" }`   | Fetches that manifest and one declared atlas.                 |
| Inline Pack       | `{ pack, atlasUrl: "/characters/moss/atlas.png" }` | Uses supplied Pack data and fetches the declared atlas bytes. |

If merged Configuration contains several sources, the runtime uses `pack` first,
then `packUrl`, then `character`. `atlasUrl` changes only the asset location for
bytes already declared by the selected Pack. It is not an image conversion hook.

Every atlas candidate needs a 64-character lowercase SHA-256. For an adaptive
Pack used with `atlasUrl`, set `density` to one declared variant. The runtime
loads that candidate once and disables automatic density upgrades for the
mirrored asset.

## Public instance API

`hatch` returns one independently owned instance:

| Member                | Purpose                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ready`               | Rejecting startup promise. Await it before relying on Pack-specific behavior.                               |
| `finished`            | Non-rejecting terminal promise. Settles after cleanup with `destroyed`, `pagehide`, or `failed`.            |
| `emit(name, payload)` | Admit one bounded application Event and return its admission result.                                        |
| `override(input)`     | Request temporary ownership of declared presentation channels.                                              |
| `pause()`             | Add the host pause reason and park runtime work.                                                            |
| `resume()`            | Remove the host pause reason. Work resumes after every suspension reason clears.                            |
| `refreshTargets()`    | Refresh host-approved target geometry after an application-specific layout change.                          |
| `setIndicator(value)` | Replace the accessible dot or count notification, including its optional color. Pass `null` to clear it.    |
| `destroy()`           | Abort pending work and release the instance's listeners, observers, frames, timers, roots, and object URLs. |

Configuration failures that can be decided without Pack bytes throw before
`hatch` returns. Pack loading, Pack-dependent references, stylesheet setup, and
browser resource failures reject `ready`. Wrap both stages in the same `try`
block when the host needs one startup error path.

`finished` never rejects and settles once. Cleanup is idempotent, so calling
`destroy()` again is safe.

## Events and temporary control

Application Events are bounded immutable facts:

```js
await companion.ready;

const result = companion.emit("job.progress", {
  session: "build-42",
  revision: 3,
  completed: 12,
  total: 20,
});

if (!result.accepted) {
  console.warn("Event was not admitted", result.reason);
}
```

`emit` does not mutate the Plan, render inline, or run host code inline. It
validates and snapshots the payload, then schedules ordinary Plan evaluation.
The queue holds 32 Events. A full queue rejects the new Event without evicting
accepted work. Eligible streams can opt into `coalesce: "latest"`. Other rate
limits belong in host code before `emit`.

An Override uses the same Effect and channel model as the Plan:

```js
const handle = companion.override({
  effect: {
    channels: ["state"],
    state: { state: "happy" },
  },
  until: { type: "duration", ms: 2000 },
});

console.log(await handle.finished);
```

The selected State must exist in the Pack. An Override never edits the Plan.
When its lifetime ends, the runtime reevaluates the unchanged Plan from current
world state.

## Drag, throw, click, and custom routes

Direct manipulation is enabled without adding Plan rules:

```js
const companion = hatch({
  character: "peek",
  interaction: {
    gravity: 1800,
    maxThrowSpeed: 1800,
    bounce: 0.35,
    label: "Open controls or drag Peek",
  },
});
```

Press actions can toggle, show, or hide content. They can also emit one bounded
application Event. A drag suppresses its trailing click. Throw integration is
time based, bounded to the viewport, and releases ownership back to the Plan
after landing.

Targets connect motion or catching to host-approved geometry. Custom SVG paths
remain data and are sampled with detached browser geometry. See
[Character interaction and motion](../../docs/interaction-and-motion.md) for a
complete sunlit nook, viewport traversal, target catching, notification badge,
and custom path examples.

## Optional Canvas renderer

Use the Canvas entry point when character frame presentation should use Canvas
2D:

```js
import { hatchCanvas as hatch } from "@peekling/runtime/canvas";
```

Canvas uses the same Configuration, Pack, Plan, Event queue, interaction,
physics, targets, and lifecycle as the default DOM renderer. Content bubbles
remain DOM surfaces so native controls and accessibility keep working.

See the repository [configuration guide](../../docs/configuration.md) for Plan
syntax and recipes. The [execution model](../../docs/execution-model.md) defines
Event ordering, channel ownership, Override conflicts, and cleanup.

## Web Component

The complete browser file registers `<peekling-character>` when that name is
free. The element is a lifecycle facade over hatch, not a second engine.

```html
<script
  defer
  src="https://cdn.jsdelivr.net/npm/@peekling/runtime@0.1.5/dist/peekling.min.js"
  integrity="sha384-<runtime-release-hash>"
  crossorigin="anonymous"
></script>

<peekling-character
  character="peek"
  styles-url="https://cdn.jsdelivr.net/npm/@peekling/runtime@0.1.5/dist/peekling.css"
  styles-integrity="sha256-<stylesheet-release-hash>"
></peekling-character>
```

Replace both integrity placeholders with the values emitted by the selected
release. Cross-origin JavaScript and CSS need CORS. The page must allow the
runtime, stylesheet, manifest, atlas fetch, and verified Blob atlas through its
CSP.

Connection hatches one instance. Disconnection destroys it. Reconnection gets a
new `ready` promise and a fresh instance. Object values such as `plan`,
`content`, `bindings`, `theme`, `styles`, `accessibility`, `diagnostics`, and
`logger` are JavaScript properties. Scalar Pack and stylesheet selections also
have documented attributes.

Importing the ESM root does not register the element or create a browser global.
Call `definePeeklingElement()` explicitly when an ESM application wants the
declarative facade.

The browser file claims `globalThis.Peekling` and `<peekling-character>`
independently. It never overwrites a host value or foreign custom element. A
collision dispatches `peekling:collision` on `globalThis` and names the occupied
surface in `event.detail`.

## Content and trusted host code

Packs and serialized Configuration remain data only. A Plan Effect may select a
named content item and immutable data. Built-in text and links render through
safe DOM operations.

Trusted JavaScript Configuration may register a mount function for custom host
content. Peekling supplies an empty engine-owned root, immutable data, an
`AbortSignal`, and an `emit` helper. The host creates nodes with DOM APIs and
returns cleanup. Peekling contains mount, update, cleanup, and rejected-promise
failures to that surface. The scheduler never waits for host code.

Framework adapters, if used, belong above this mount seam. They do not become
runtime dependencies or introduce another scheduler.

## Lifecycle and visibility

Host pause, hidden-page suspension, page lifecycle, and site dismissal are
composable reasons. The instance resumes only after every active reason clears.
Ordinary parked instances own no runtime animation frame, Plan timer, or
evaluator work. A clock-based dismissal owns one recovery timeout until show,
expiry, or teardown.

Reduced motion is a rendering policy, not another Plan. It shows a validated
static tableau and suppresses incompatible motion while preserving host-page
interaction. `motionPreference` defaults to `"system"`. Choose `"full"` when
direct manipulation and physics are essential, or `"reduce"` for an explicitly
static instance.

Direct hatch integrations in single-page applications must call `destroy()` when
the owning view unmounts. `pushState`, hash changes, and client-side route
changes do not end the document. A disconnected Web Component performs its own
teardown.

The public visibility helpers let a host provide a normal recovery action after
site dismissal:

```js
import {
  hidePeekling,
  isPeeklingHidden,
  showPeekling,
} from "@peekling/runtime";

hidePeekling("1-hour");
console.log(isPeeklingHidden());
showPeekling();
```

## Browser and security boundary

- Pack data is schema-validated, bounded, and never evaluated.
- Pack strings never enter HTML-parsing sinks.
- The character root is `aria-hidden` and pointer-transparent.
- Browser listeners are passive and never cancel host interaction.
- Strict CSP needs no `unsafe-inline` or `unsafe-eval` exception.
- The runtime sends no telemetry and opens no WebSocket or event stream.
- Closed Shadow DOM provides encapsulation, not a security boundary.
- Host code and Peekling still share the browser main thread.

Manifest and atlas origins belong in `connect-src`. The verified atlas renders
from a browser-created Blob URL, so `img-src` must allow `blob:`. The runtime
script uses `script-src`, and `peekling.css` uses `style-src`. See
[compatibility and hosting](../../docs/compatibility-and-hosting.md) for CORS,
SRI, MIME, caching, self-hosting, diagnostics, and browser limits.

For symptom-to-action help with startup, Pack loading, CSP, lifecycle, and Event
admission, use the repository
[troubleshooting guide](../../docs/troubleshooting.md).

## Package entry points

| Import                           | Contents                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@peekling/runtime`              | Side-effect-free ESM hatch API, public types, visibility helpers, and explicit Web Component registration. |
| `@peekling/runtime/canvas`       | Optional Canvas 2D character renderer using the same runtime contract.                                     |
| `@peekling/runtime/browser`      | Complete browser-global artifact.                                                                          |
| `@peekling/runtime/peekling.css` | Required runtime stylesheet asset.                                                                         |
| `@peekling/runtime/pack`         | Supported Pack parsing and validation surface for authoring tools.                                         |
| `@peekling/runtime/preflight`    | Node-safe validation tooling used by developer packages.                                                   |

Internal compilers, evaluators, queues, renderers, schedulers, and browser host
classes are package-private. `@peekling/preflight`, `@peekling/vite`,
`@peekling/cli`, and `@peekling/adapter-codex-pet` are separate packages. They
do not enter the complete browser JavaScript artifact.

## Verification and size

Browser tests cover strict CSP, ESM and browser hatch, Web Component lifecycle,
host surfaces, blocked stylesheets, suspension, dismissal recovery, remount
cleanup, hostile host layout, root repair, and contained failures in Chromium,
Firefox, and WebKit.

The 0.1.5 record below measures the interaction and renderer release with the
exact release toolchain and required reserve.

<!-- peekling-size-evidence:start -->

The recorded canonical delivery measurement is 38,428 bytes gzip and 33,684
bytes Brotli. Against the 40 KiB gzip and 40 KiB Brotli caps, that recorded
build leaves 2,532 bytes of gzip headroom and 7,276 bytes of Brotli headroom.
After the required 256-byte reserve, 2,276 gzip bytes and 7,020 Brotli bytes
remain for that build.
<!-- peekling-size-evidence:end -->

The record is bound to artifact hashes. Node 22.14.0, npm 11.16.0, and Node's
default zlib compression certify those recorded values. Other supported Node
versions still enforce their local size cap and reserve.

The [browser performance guide](../../docs/browser-performance.md) explains the
three-browser release harness and what its result can and cannot prove.

## License

Apache-2.0. Character artwork keeps its own Pack license. See
[licensing and attribution](LICENSING.md).
