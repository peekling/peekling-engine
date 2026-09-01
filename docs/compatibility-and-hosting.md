# Browser compatibility and host constraints

> [!IMPORTANT] This document describes the implemented `0.1.5` host contract and
> its required release gates. Strict CSP, parked lifecycle behavior, and the
> common hostile-host cases below have local Chromium, Firefox, and WebKit
> coverage. This is bounded evidence, not a promise that every page, device, or
> browser extension behaves alike. Release certification binds this evidence to
> an immutable source revision and exact browser matrix.

Peekling v0.1 targets current evergreen Chromium, Firefox, and WebKit. The
runtime uses standard ESM, Fetch, AbortController, Shadow DOM, and animation
frame APIs. Browser CI is required for all three engines.

Required platform features include Fetch, AbortController, Web Crypto, Blob and
object URLs, Shadow DOM, CSSOM access, `matchMedia`, and animation frames. The
declarative entry also requires Custom Elements. Section-aware Plans use
Intersection Observer when the browser provides it. Mutation Observer lets the
runtime rediscover a configured section after host code replaces that element.

## Accessibility and host interaction

The sprite host is `aria-hidden`, cannot receive pointer events, and uses a
closed shadow root. Optional host content uses a separate accessible surface.
Default links have visible focus treatment and at least a 44px target.
Host-mounted content owns the accessibility of Controls it adds. Peekling never
focuses those Controls automatically.

Runtime listeners are passive. They do not cancel, stop, synthesize, or replace
host-page events. Peekling never steals focus. Pointer, touch, scroll, and
keyboard interaction remain under host-page control.

## DOM ownership and recovery

Runtime roots are direct children of the document element, not the page body.
This keeps a transformed, contained, or clipped body from becoming their
containing block. Critical layout uses shadow-owned reset rules, fixed
positioning, pointer transparency, and explicit stacking. The browser matrix
applies hostile global resets, `!important` declarations, animations,
transforms, containment, and overflow without moving or suppressing the
character or changing an unrelated page control.

If page code removes a character or content root, or reparents it elsewhere in
the same document, Peekling restores that exact owned node as a direct child of
the document element on its next ordinary render or Event turn. It restores the
ownership markers and accessibility attributes at the same time. Peekling does
not poll the DOM while idle. A visibility-control root repairs when the host
next uses a public visibility helper.

A host mount's nested engine-owned root follows a narrower rule. Deletion or
same-document reparenting repairs on the next render. Cross-document adoption
faults and cleans up only that surface. Other surfaces and the instance keep
running.

A root adopted into another document is not migrated back. A character or
content root ends its instance with `internal.frame-failed`. Adopting the shared
visibility-control root ends every instance registered to that controller.
Critical closed-root structure damage takes the same terminal path. Replacing
the document element, monkey-patching browser DOM primitives, cross-origin
document migration, and interference from privileged browser extensions remain
outside the recovery guarantee.

A top-level embed is fixed to its viewport. Inside an iframe it is confined to
that iframe. When another element enters fullscreen, browsers display only
descendants of the fullscreen element, so Peekling may be hidden until
fullscreen exits. A high stacking value cannot outrank a later top-layer
element, fullscreen element, or browser UI.

## Entry surfaces and collision behavior

The canonical browser-global creation call is `Peekling.hatch(...)`. Its ESM
equivalent is the named `hatch(...)` export. Each call creates one independently
owned instance, and the host calls `destroy()` during teardown.

The browser build also registers `<peekling-character>` as a thin lifecycle
façade. Connect and disconnect map to hatch and destroy. The element shares the
runtime's Plan, security, accessibility, reduced-motion, and visibility
implementation.

The browser build claims `globalThis.Peekling` and `<peekling-character>`
independently. It never overwrites an existing host value or foreign custom
element. A collision dispatches `peekling:collision` on `globalThis`, with
`event.detail` set to `"Peekling"` or `"peekling-character"`. It does not throw
during script evaluation. Listen before loading the browser file when collision
reporting matters. ESM `definePeeklingElement()` follows the same
preserve-and-report rule.

Web Component `options` are snapshotted before property and attribute precedence
is applied. Own data is accepted. Inherited fields and accessors are rejected
without evaluating getter values. Records must use this realm's ordinary
`Object.prototype` or a null prototype. Custom prototypes and ordinary records
from another realm are rejected. A throwing Proxy reflection trap becomes a
controlled readiness failure, although JavaScript cannot inspect a Proxy without
invoking some reflection traps.

## Lifecycle and failure containment

Reduced motion renders the idle tableau, disables Plan motion, and finishes
incompatible Overrides. Background pages suspend Plan, Override, animation, and
movement clocks. Resume rebases those clocks without catch-up bursts. Site
dismissal composes with the other suspension reasons, preserves queued work, and
hides live surfaces until restored.

`Peekling.visibility.show()` in the browser build, or `showPeekling()` in ESM,
gives the host a normal recovery action after any dismissal, including forever.
The quiet corner control is an optional fallback. Session and forever dismissals
schedule no recovery timer. A 10-minute, one-hour, or until-tomorrow dismissal
owns one bounded recovery timeout. Show, expiry, and final teardown remove it,
including when browser storage is unavailable.

`pagehide` ends the current instance. Full-page navigation therefore requires a
fresh hatch on the next page. A same-document route change, such as `pushState`
or a hash change, does not end a direct hatch instance. Single-page applications
call `destroy()` during route teardown, or disconnect their Web Component when a
fresh mount is required.

Uncaught host errors do not share Peekling's state or teardown path. Mount
controller accessors are rejected without being evaluated. Malformed
controllers, throwing Proxy reflection traps, callback failures, rejected
thenables, and never-settling mount thenables remain per-surface faults. At most
one update thenable is in flight per surface. Other surfaces, motion, and
independently hatched instances keep running. The scheduler never waits for a
host promise.

An unrecoverable renderer, geometry, or owned-root integrity failure reports one
controlled diagnostic and destroys only that instance. Repeated pause, resume,
hide, show, dismissal recovery, hatch, destroy, and remount cycles are tested
against listener, observer, animation-frame, timer, blob URL, and owned-root
baselines. These checks use observable browser counters. They do not replace a
long real-device heap soak.

## CSP and resource loading

The runtime loads four resource classes through distinct browser mechanisms:

```text
host document
  `-- loads peekling.min.js -------------------- script-src
        |-- loads peekling.css into shadow roots style-src
        |-- fetches manifest and atlas bytes --- connect-src
        `-- renders the verified atlas blob ---- img-src blob:
```

| Resource                    | Browser mechanism                  | CSP requirement | Cross-origin requirement                      |
| --------------------------- | ---------------------------------- | --------------- | --------------------------------------------- |
| Runtime browser file or ESM | Script or module load              | `script-src`    | CORS for modules and cross-origin SRI         |
| `peekling.css`              | Shadow-root stylesheet link        | `style-src`     | CORS because Peekling reads and updates CSSOM |
| Pack manifest               | Fetch                              | `connect-src`   | CORS                                          |
| Atlas bytes                 | Fetch                              | `connect-src`   | CORS                                          |
| Verified atlas object URL   | CSS background using a `blob:` URL | `img-src blob:` | None                                          |

Cross-origin scripts using SRI include `crossorigin="anonymous"`. Peekling needs
no unsafe eval, inline event handlers, inline style elements, or style
attributes. Initialization can live in a normal external host script, so a
strict `script-src` needs no inline-script exception.

Sites using self-only directives can self-host the exact runtime, stylesheet,
manifest, and atlases. They still add `blob:` to `img-src` for the verified
atlas object URL. This removes third-party origins from the execution and asset
allowlists and is the recommended path for regulated environments.

## Pack selection, URLs, and integrity

New instances default to `bottom-right`. The other presets are `bottom-left` and
`center`. A host may instead supply bounded `{ x, y }` CSS-pixel coordinates,
which clamp to the viewport. String coordinates are not part of the `0.1.5`
contract.

Pack discovery is federated. The runtime has a small exact-version alias set and
accepts explicit immutable manifest URLs. Community packages stay in their
authors' npm scopes or HTTPS, CDN, or GitHub release endpoints. A host may
supply its own resolver by passing the resolved `packUrl`. No central Peekling
service is required.

The built-in `hatch("peek")` alias currently resolves this pinned manifest:

```text
https://cdn.jsdelivr.net/npm/@peekling/pack-peek@0.1.1/character.json
```

The runtime embeds the expected manifest SHA-256 and verifies the raw response
before parsing. That manifest declares the required hash for each atlas
candidate. A changed manifest fails before any atlas request. This alias makes
jsDelivr a runtime request dependency for `hatch("peek")` specifically. It does
not make jsDelivr the only place to load the runtime. Pass an explicit immutable
`packUrl` when all resources must come from a customer-controlled origin.

CDN availability, pricing, caching, and acceptable-use terms belong to the
selected provider. Peekling does not promise a provider SLA or a permanent cost.
Self-hosting remains available under the same static delivery contract.

Configuration URLs and content links may be same-origin relative paths or
absolute HTTPS URLs. Relative references can resolve on a local HTTP development
page. Absolute HTTP, protocol-relative references, credentials, malformed hosts
or ports, whitespace, controls, and backslashes reject. Absolute DNS names use
valid ASCII or punycode labels. IPv4 literals must use canonical dotted decimal.
IPv6 literals must be bracketed and pass URL parsing. The runtime does not
require one particular valid IPv6 compression form.

Pack-internal atlas `src` fields are stricter. They are relative in-Pack paths,
not arbitrary URLs. The loader validates MIME, byte limits, atlas geometry, and
mandatory SHA-256 before it creates rendering resources. Cross-origin resources
still require the CORS and CSP policy shown above. Normal browser caching
applies.

Every atlas candidate requires a 64-character lowercase SHA-256. Verification
uses Web Crypto `crypto.subtle.digest`, which supported browsers normally expose
in secure contexts such as HTTPS and loopback development. A missing or
malformed declaration, unavailable Web Crypto, or mismatch rejects the Pack and
tears down that instance. Verification is never skipped.

## Density and decoded memory

Page zoom, device-pixel-ratio changes, viewport resize, background-tab
throttling, and reduced-motion preferences use browser-standard behavior.
Adaptive Packs load the smallest declared density satisfying DPR multiplied by
render scale, capped by host and save-data policy. Only one atlas is requested
at a time. Bucket increases upgrade in place. A failed higher-density candidate
falls back lower with a diagnostic. Motion time is capped after long scheduling
gaps to prevent position jumps.

Decoded RGBA memory is approximately `width × height × 4` bytes. A 4096 by 4096
atlas is therefore about 64 MiB before any additional browser or GPU copies.
Compressed input limits are separate from decoded memory. Hosts targeting
constrained GPUs should set `maxDensity: 2` and run their own device matrix.

Native format 1 uses PNG so the loader can verify byte signature, dimensions,
alpha, and cell geometry consistently. SVG and vector renderers are outside the
`0.1.5` format. Source raster density and logical frame size are separate.

Normalized WebP input scans a bounded RIFF chunk sequence. ICCP, EXIF, and XMP
metadata may precede VP8X, VP8, or VP8L image data. Truncated chunks, unknown
leading chunks, excessive chunk counts, invalid dimensions, and oversized data
reject before browser decode.

## Diagnostics and privacy

Peekling performs no telemetry and has no required backend. An optional
JavaScript logger receives structured records in process. The runtime does not
transmit those records or select a destination.

Engine-generated metadata excludes Event payloads, content, DOM text, selectors,
and resource URLs. Built-in messages are bounded and redact URL-shaped text and
common secret assignments. Host-supplied `diagnostics.context` is passed through
after shape and size validation. A debug cause can include an application error
message and stack. Do not place secrets or personal data in diagnostic context,
and redact debug records before sending them elsewhere. Host adapters own
routing, sampling, privacy, retention, and correlation policy.

Without a logger or `onDiagnostic` sink, the default console policy reports
errors and keeps routine lifecycle and Event records quiet. Set
`diagnostics.console` to `true` to print every bounded record, or `false` to
disable console output. A configured logger or `onDiagnostic` sink still
receives every admitted record regardless of the console policy.

The production `peekling.min.js` uses stable diagnostic codes as its compact
messages. Use the adjacent readable `peekling.js` during browser debugging, or
run Preflight or Doctor against the same Configuration for detailed validation
guidance. A logger still receives the structured code, severity, phase,
sequence, bounded metadata, and optional debug cause from the compact build.

Diagnostic delivery is bounded to 64 ordinary records per 60-second window. At
the limit, a configured sink receives one `diagnostics.rate-limited` warning for
the window. Up to eight additional error records are retained so routine noise
does not immediately hide failures. Logger reentry is suppressed and cannot
create another diagnostic storm.

## Delivery contract

One `@peekling/runtime` browser file works when installed from npm, loaded from
jsDelivr, loaded from UNPKG, or copied to a customer-controlled static host. The
canonical exact-version examples are:

```text
https://cdn.jsdelivr.net/npm/@peekling/runtime@0.1.5/dist/peekling.min.js
https://unpkg.com/@peekling/runtime@0.1.5/dist/peekling.min.js
https://static.example.com/peekling/0.1.5/peekling.min.js
```

The build emits `peekling.js` for readable debugging, `peekling.min.js` for
production minification, and the required `peekling.css`. Package metadata
selects the minified file as the jsDelivr and unpkg default. ESM entry points
remain separate package exports and do not use browser-global artifact naming.

Cloudflare, Fastly, CloudFront, Akamai, Vercel, and Netlify are ordinary
static-host examples. Peekling does not ship a direct integration for each
vendor. The browser artifact itself has no vendor-specific loader. The built-in
`peek` alias is the documented exception because its pinned manifest currently
uses jsDelivr. An explicit `packUrl` keeps Pack requests under host control.

Production pages pin the full version and use the SRI values emitted as
`dist/peekling.min.js.sri` and `dist/peekling.css.sri`. Cross-origin scripts use
`crossorigin="anonymous"`. A self-hosted pack uses an immutable manifest URL,
for example `https://static.example.com/characters/moss/1.2.0/character.json`.
Every atlas path stays relative to that manifest.

Serve JavaScript as `text/javascript` or `application/javascript`, CSS as
`text/css`, manifests as `application/json`, and PNG atlases as `image/png`.
Cross-origin styles, manifests, and atlases must allow the embedding origin
through CORS. Public assets do not use credentials and may send
`Access-Control-Allow-Origin: *`. Exact-version files should send
`Cache-Control: public, max-age=31536000, immutable`. Byte changes require a new
URL.

Self-hosting is the recommended path for strict CSP allowlists and regulated
environments. A modified fork can use the same static contract. Customers may
add analytics in fork-owned runtime code, but upstream Peekling remains
telemetry-free and packs cannot request or configure analytics.

The runtime does not use unsafe eval, dynamic function construction, inline
event handlers, telemetry beacons, WebSockets, or event-stream connections.
Character packs remain data-only regardless of delivery origin. Release SRI
protects the browser script bytes. Immutable manifest URLs, validated atlas
hashes, CORS, and host allowlists protect the separate asset path. SRI is a
generic browser integrity feature and does not depend on a particular CDN.

The direct browser file is the complete runtime. Its companion stylesheet is a
separate required artifact, and both files have an SRI value. Peekling does not
publish an opinionated reduced-feature browser variant. npm and ESM consumers
may receive smaller output when their production bundler removes unused named
exports. Runtime options do not alter the already downloaded CDN payload and are
not described as tree shaking.

The CDN file is Peekling JS, the production browser runtime. It contains no
doctor, exhaustive preflight, Node or build integration, convenience SDK
meta-package, or framework adapter. Host Configuration is supplied separately at
hatch or Web Component initialization. Optional ESM entry points and adapters
can be omitted through static tree shaking, while the complete CDN file has its
own full-runtime budget.

SRI, CSP, pinned URLs, CORS, and origin allowlists are defense in depth. They do
not eliminate every supply-chain risk or prove that published bytes came from
reviewed source. Release CI must build from immutable source, verify the package
and browser files, retain hashes and SRI, and record artifact provenance.

Doctor, preflight, Vite validation, source package boundaries, the authoritative
contract and specification, and the runtime package are separate delivery
concerns. None is bundled merely because jsDelivr or unpkg serves the browser
runtime.
