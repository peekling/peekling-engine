# Configure Peekling

> [!IMPORTANT] This guide describes the implemented public contract for version
> `0.1.2`. The [execution model](execution-model.md) is authoritative for
> scheduling and lifecycle ordering. The [release guide](RELEASING.md) covers
> source provenance and publication.

Peekling supports two integration styles. JavaScript hosts call hatch, while
HTML-first hosts use the Web Component facade:

- `Peekling.hatch(configuration)` from the complete browser bundle.
- `hatch(configuration)` from ESM.
- `<peekling-character>` as the declarative lifecycle facade over hatch.

There is no public constructor and no `run` operation. Loading the browser file
does not create a character by itself.

| You are integrating with      | Use                             | Lifecycle responsibility                      |
| ----------------------------- | ------------------------------- | --------------------------------------------- |
| An ESM application or bundler | `hatch(configuration)`          | Call `destroy()` when the host view ends.     |
| A plain browser script        | `Peekling.hatch(configuration)` | Call `destroy()` from the host teardown path. |
| Declarative HTML              | `<peekling-character>`          | Connection hatches. Disconnection destroys.   |

All three choices enter the same runtime. Choose the surface that matches the
host application. Do not layer one surface over another.

Hatch, the JSON schema, and the public TypeScript declarations accept the Plan
spelling shown below. Hatch loads the Pack first, then compiles exactly one Plan
against its States and Capabilities and the host content registry.

## Quick mental model

```text
Pack           what the character can render
Configuration  what the developer wants on this page
Plan           the immutable baseline policy compiled at hatch
Event          a bounded fact from the browser or application
Rule           a typed condition that can select an Effect
Effect         state, capability, movement, content ID, and safe data to present
Override       temporary direct control that later releases back to the Plan
```

The artist supplies the Pack. The developer supplies authoritative
Configuration. Peekling validates both, compiles one immutable Plan, admits
Events, composes compatible channel-scoped Effects, and renders only States or
Capabilities supported by the Pack.

Simple behavior is a small Plan. It is not a second configuration language or
execution engine.

For a standard companion, start with a named preset. Presets compile into the
same canonical Plan and are mutually exclusive with an explicit `plan`:

```js
const companion = hatch({
  character: "peek",
  preset: "companion",
});
```

The available presets are `companion`, `still`, `bottom-patrol`, and
`viewport-roam`. Direct dragging and throwing are enabled by default. A
character click toggles its owned content bubble when one exists. The
[interaction and motion guide](interaction-and-motion.md) explains those
defaults and the optional fields that change them.

## Happy path

This Vite example emits the required stylesheet and uses the Plan shape accepted
by hatch, the JSON schema, and the public declarations.

```js
import { hatch } from "@peekling/runtime";
import peeklingStyles from "@peekling/runtime/peekling.css?url";

const companion = hatch({
  packUrl: "/peeklings/moss/0.1.1/character.json",
  styles: { url: peeklingStyles },
  plan: {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
    rules: [
      {
        id: "show-saved",
        when: { source: "application", event: "app.saved" },
        effect: {
          channels: ["state", "surface:saved"],
          state: { state: "happy" },
          surfaces: [
            {
              id: "saved",
              contentId: "saved",
              data: "event-payload",
            },
          ],
        },
      },
    ],
  },
  content: {
    saved: {
      bottom: { text: "Saved" },
    },
  },
});

await companion.ready;
companion.emit("app.saved", { documentId: "guide" });

// Call during application teardown.
companion.destroy();
console.log(await companion.finished); // { reason: "destroyed" }
```

Configuration shape and selection faults that do not require Pack bytes throw
before hatch returns. Pack loading, Pack-dependent Plan references, stylesheet
setup, and browser resource failures reject `ready`. Wrap both hatch and
readiness in the same `try` block when one mount failure path is required.

Hatch performs no inline application work when `emit` is called. It validates
and admits the Event, then normal scheduling reevaluates the Plan.

### Strict Configuration boundary

Serializable Configuration uses closed JSON objects. Object-valued fields such
as `content`, `theme`, `accessibility`, and `diagnostics` do not accept `null`
or arrays. Position is `bottom-left`, `bottom-right`, `center`, or a closed
`{ x, y }` object whose finite CSS-pixel values are each from `-100000` through
`100000`. String coordinates are invalid.

Every mount must select `character`, `packUrl`, or inline `pack`. Calling hatch
without one fails admission with `manifest.selection` before any network
request. A Web Component without a selection rejects its current `ready`
promise. Explicit `hatch(null)` and `element.options = null` are invalid. A
failed element mount leaves no runtime root behind, and assigning valid options
later starts a fresh mount.

Configure one Pack source when possible. If merged Configuration contains more
than one, selection follows this fixed order:

| Priority | Field       | Meaning                                                  |
| -------: | ----------- | -------------------------------------------------------- |
|        1 | `pack`      | Use the supplied inline Pack data.                       |
|        2 | `packUrl`   | Fetch the manifest from this explicit URL.               |
|        3 | `character` | Resolve a registered exact-version alias such as `peek`. |

`atlasUrl` does not select a Pack. It replaces the asset location for bytes
already declared by the selected Pack and must satisfy the integrity rules
below.

An explicit `character: "peek"` selection fetches the exact
`@peekling/pack-peek@0.1.1` manifest from its pinned jsDelivr URL and compares
the raw response with an embedded SHA-256 before parsing it. The verified
manifest declares the SHA-256 for every atlas candidate. A changed manifest
fails before an atlas request. Hosts can instead pass an explicit self-hosted
`packUrl` or inline Pack data and an atlas URL.

`atlasUrl` must mirror bytes declared by the selected Pack. Re-encoding or
converting the image changes its required SHA-256 and fails admission. If the
Pack declares density variants, the host must also set `density` to one declared
variant. The runtime fetches and validates only that candidate and does not
perform automatic density upgrades for the mirrored asset.

Manifest and atlas requests each have a 30-second deadline. A stalled manifest
fails with `manifest.timeout`. A stalled atlas candidate fails with
`atlas.timeout`, and another declared candidate may still be tried. Destroying
the instance aborts pending requests sooner.

Configuration resource fields such as `packUrl`, `atlasUrl`, `styles.url`, and
content links may be relative paths or absolute HTTPS URLs. A relative reference
stays on the base origin and can resolve on a local HTTP development page.
Absolute HTTP, protocol-relative references, credentials, other schemes,
backslashes, literal ASCII or Unicode whitespace, controls, malformed percent
escapes, malformed hosts and ports, and browser-coerced IPv4 spellings reject.
Absolute hostnames use valid ASCII DNS, canonical IPv4, valid bracketed IPv6, or
punycode spelling. Browser origin policy, CORS, and CSP still apply.

A Pack's internal atlas `src` is different. It is always a bounded relative
in-Pack path. It cannot be an absolute URL, carry a scheme, or traverse outside
the Pack root.

The JSON Schema is the serializable shape and lexical gate. URL parsing cannot
be expressed completely by a JSON Schema regular expression, so schema success
alone is not final URL admission. The shared semantic validator used by
Preflight, Doctor, Vite, hatch, and the Web Component performs the required
origin, authority, credential, host, and port checks.

Theme colors use one closed grammar: lowercase `transparent`, `#RGB`, `#RGBA`,
`#RRGGBB`, or `#RRGGBBAA`. Named colors, CSS functions, variables, gradients,
images, comments, escapes, declarations, and at-rules reject. This grammar keeps
theme values color-only and prevents them from becoming a resource-loading CSS
surface.

Hatch and Web Component property input is snapshotted through the same bounded
own-data boundary before validation. Inherited fields and accessors are not
accepted as Configuration data. Record objects must use the receiving realm's
ordinary `Object.prototype` or a null prototype. Custom prototypes and ordinary
objects from another realm reject instead of silently dropping inherited data.
JSON parsed in the receiving realm and cross-realm null-prototype records remain
valid when all properties are own data. A throwing Proxy reflection trap becomes
a controlled failure. JavaScript cannot inspect a Proxy without invoking some
reflection traps, so the boundary cannot promise that no trap runs. The
property-only host slots documented below remain trusted code seams and are not
serializable Pack or Plan data.

### CDN delivery

The complete browser bundle exposes the same hatch contract:

```html
<script
  defer
  src="https://cdn.jsdelivr.net/npm/@peekling/runtime@0.1.2/dist/peekling.min.js"
  integrity="sha384-<release-hash>"
  crossorigin="anonymous"
></script>
<script defer src="/assets/peekling-bootstrap.js"></script>
```

The URL shows the required version-pinned release shape. Replace the integrity
placeholder with the value emitted for the selected release. The external
bootstrap calls `Peekling.hatch` with the host Configuration. Declarative hosts
can use external element markup instead and omit the bootstrap.

### Declarative delivery

The Web Component owns one hatch instance per connected mount:

```html
<peekling-character
  id="moss"
  pack-url="/peeklings/moss/0.1.1/character.json"
  styles-url="https://cdn.jsdelivr.net/npm/@peekling/runtime@0.1.2/dist/peekling.css"
  styles-integrity="sha256-<stylesheet-release-hash>"
></peekling-character>
<script type="module" src="/assets/moss-peekling.js"></script>
```

Object Configuration is supplied through JavaScript properties, not serialized
into HTML attributes. The external module assigns `mossPlan` and `mossContent`
through the element's properties. This form needs no inline-script exception.
Disconnect destroys the owned instance. Reconnection creates a new mount,
readiness promise, and instance. The element has no second Plan, renderer,
validator, scheduler, or failure model.

`options` is the base Configuration. Dedicated properties such as `plan`,
`content`, `bindings`, and `styles` override matching base fields. Scalar
attributes are applied last: `character`, `pack-url`, `name`, `styles-url`, and
`styles-integrity`. A `styles-url` attribute replaces the full `styles` field,
with `styles-integrity` added when present.

That order describes how element inputs become one Configuration object. Pack
selection then checks `pack` first, `packUrl` second, and `character` third, as
shown above. Supplying one Pack source avoids hidden fallback assumptions.

Changing `name` on a ready element updates the existing instance and content
surface. It keeps the same `ready` promise, Pack, Plan, and stylesheet
selection, and it does not refetch the Pack or atlas. Removing the attribute
restores the `name` value from `options`. The other observed attributes still
start a fresh mount because they select character or stylesheet identity.

An invalid `name` change does not remount the element. Peekling retains the
current instance and rendered name, performs no network request, and reports
`config.invalid-name` through the configured diagnostic sink.

The element snapshots `options` before this merge. It accepts own data only,
rejects inherited fields and accessors without reading getter values, and
rejects custom prototypes and ordinary objects from another realm. A local
ordinary object or a null-prototype own-data record is accepted. Invalid input
is reported through the current `ready` promise. No failed mount is left
attached. Assigning valid options later starts a fresh mount. JavaScript cannot
detect a Proxy without reflection, so a Proxy trap can run while the runtime
inspects the object. A thrown trap is converted to a controlled `OwnDataError`
rather than leaking an unhandled error into the page.

Never assigning `options` leaves the element without a Pack selection and
rejects its current `ready` promise with `manifest.selection`. Explicitly
assigning `null` is invalid and follows the same failed-mount path.

A `ready` promise read before the element is connected follows its first
connected mount. Disconnecting a completed mount settles that instance. A later
connection exposes a new promise for the fresh mount.

## Vocabulary and ownership

| Term          | Owner                       | Contract                                                                      |
| ------------- | --------------------------- | ----------------------------------------------------------------------------- |
| Pack          | Artist                      | Data-only assets, States, Capabilities, timing, identity, and license.        |
| Configuration | Developer                   | Selected Pack, Plan, presentation, trusted adapters, environment, and policy. |
| Plan          | Developer or engine default | One immutable baseline compiled and validated at hatch.                       |
| Rule          | Developer                   | One declaration-ordered typed condition and Effect.                           |
| Event         | Runtime admission layer     | One bounded immutable browser or application fact.                            |
| Effect        | Plan or Override            | Declarative State or Capability, movement, content ID, and safe data.         |
| Override      | Developer                   | Temporary bounded control with a cancellable completion handle.               |
| State         | Pack                        | Exact named animation with no implicit engine meaning.                        |
| Capability    | Pack                        | Semantic ability mapped to valid Pack States.                                 |
| Control       | Developer                   | Optional interactive content that reports later results as Events.            |

The runtime does not use **action** as a model term. That word is easily
confused with an Effect, a Control, a callback, or application business logic.

Configuration can select only validated Pack States and Capabilities. A typo or
unsupported reference fails readiness and cleans up partial resources. Pack data
cannot define Rules, callbacks, HTML, network hooks, or host policy.

## One immutable Plan

Hatch validates and compiles the baseline Plan once. After readiness:

- Events do not mutate or replace it.
- Overrides do not mutate or replace it.
- Content rendering does not mutate it.
- Host callback completion does not mutate it.
- suspension and resume do not recompile it.

Think of the Plan as a rulebook and runtime state as a scoreboard. The character
can follow the pointer while job progress stays visible because those outputs
own different channels. The Plan declares the boundaries. Runtime state records
what is happening now, including position, character State, the newest accepted
job revision, and any Override ownership. Events update that state through
declared Rules. They never edit or restructure the rulebook.

An idle-only character is a one-Rule Plan. A cursor follower is a small Plan. A
section-aware guide is a larger Plan. All use the same Rule conditions, Effect
selection, declaration priority, lifecycle, and diagnostics.

Rule conditions are closed typed data. Free-form JavaScript predicates,
expressions, `eval`, and callback conditions are not accepted.

The canonical compiler accepts these initial browser Event names:

- `pointer.click`.
- `pointer.move`.
- `document.visibility`.
- `window.focus`.
- `window.scroll`.
- `section.visibility`, with a bounded selector, phase, and optional threshold.
- `page.lifecycle`.

The runtime observes this complete browser set. Pointer movement is continuous
bounded world input. Section `while-visible` is also continuous. Section `enter`
and `leave` observations enter the bounded Event queue with
`{ selector, previousRatio, ratio }`. Matching Rules filter those facts by
selector, phase, and threshold.

When a Plan observes `window.scroll`, each scroll fact also releases the current
continuous pointer target. Active follow-pointer motion stops at its current
position while a matching scroll Rule can select the character's scroll State.
Only the next pointer observation establishes a new follow target. The passive
scroll listener never cancels or replaces native scrolling.

## Application Events

`instance.emit(name, payload)` is Event ingress. It:

1. validates a bounded name and JSON-like payload.
2. assigns an Event ID.
3. admits, coalesces, queues, or rejects under the documented queue policy.
4. schedules normal Plan reevaluation.

It does not render inline, run host code inline, edit the Plan, or bypass
lifecycle and declaration priority.

Payloads are bounded plain data. Functions, DOM values, class instances, cycles,
non-finite numbers, and unbounded collections are rejected. Expected admission
failures return a structured result instead of throwing into the host page.

Browser Events and application Events share one normalized Event shape after
admission. Queue size, coalescing, overflow, and delivery order are stable
contract behavior.

The queue holds 32 Events. Application facts and discrete browser Events remain
FIFO. If the queue is full, `emit` returns
`{ accepted: false, reason: "queue-full" }`. It never evicts an accepted Event.
A paused instance continues to admit bounded facts and evaluates them after
resume. Dismissed, destroyed, invalid, and not-ready instances return the
corresponding rejection reason. In particular, an Event emitted before `ready`
returns `{ accepted: false, reason: "not-ready" }` and is not queued. Await
`ready` before emitting, or inspect the return value and retry from host state.

`when.coalesce: "latest"` opts a stream into coalescing. Application Rules can
use it only for surface-only Effects with one shared `ordering.sessionField` and
`ordering.revisionField`. A strictly newer tail fact for the same session
replaces the prior tail and returns `coalesced: true`. A stale fact remains FIFO
for normal evaluation, where it is diagnosed and ignored. Application Events do
not coalesce by default. `window.scroll` is the only browser Event that can use
this policy.

The ordering ledger keeps the 64 most recently touched sessions for each named
surface. This bounds memory and Event work on long pages. An application that
needs older history keeps it in application state and starts a new correlated
session when it presents that work again.

Event payload is first-class immutable data. A matching Rule can pass its
validated payload to the selected rendered surface. A `job.finished` Event with
`{ changedFiles: 4 }` can therefore render "Four files changed." Peekling uses a
validated snapshot, so later mutation of the caller's object cannot change the
surface.

### Presentation channel ownership

Effects declare the presentation channels they own. The minimum set is motion,
character State, and named surface data. Disjoint ownership composes. For
example, a pointer Rule can own motion while `job.progress` owns only
`surface:job-progress`. Moving the mouse cannot reset the progress surface.

### Motion modes

`motion` is a closed discriminated union. Version `0.1.2` accepts these forms:

| Type                | Purpose                                                      | Main optional fields               |
| ------------------- | ------------------------------------------------------------ | ---------------------------------- |
| `follow-pointer`    | Move toward the latest admitted pointer position.            | `speed`, `arrivalRadius`           |
| `horizontal-patrol` | Move between safe left and right floor targets.              | `speed`, `edgeInset`               |
| `viewport-traverse` | Traverse the safe floor, walls, and ceiling of the viewport. | `speed`, `edgeInset`, `clockwise`  |
| `move-to`           | Move toward one bounded CSS-pixel coordinate.                | `speed`, `arrivalRadius`           |
| `move-to-target`    | Move toward an anchor on one host-approved target.           | `anchor`, `speed`, `arrivalRadius` |
| `jump-to`           | Interpolate to a coordinate with a bounded vertical arc.     | `duration`, `height`               |
| `svg-path`          | Sample bounded SVG path data over time.                      | `duration`, `loop`, `relative`     |

Every distance is measured in CSS pixels. `speed` defaults to 160 pixels per
second. The pointer arrival radius and patrol edge inset default to 0.

When follow-pointer motion has no current target or reaches its arrival radius,
it produces no motion request. A selected `locomotion` Capability is then
cleared from the composed output and the exact baseline State is selected when
one is declared. This remains true when separate Rules own motion and State. An
independently selected exact State is preserved.

A patrol starts by moving toward the right target. It then reverses at each
edge. `edgeInset` measures inward from the left and right character edges. The
runtime keeps both targets on the character-safe bottom edge. Peekling uses the
rendered character width and height when it calculates both targets. It
recalculates them against the current viewport, clamps an oversized inset, and
never lets a movement step pass its target. If the viewport is too narrow for
two distinct targets, both targets safely collapse to the available center.

Patrol and traversal motion do not read the pointer. The most direct patrol
configuration owns motion in the baseline:

```json
{
  "baseline": {
    "channels": ["motion", "state"],
    "motion": {
      "type": "horizontal-patrol",
      "speed": 120,
      "edgeInset": 24
    },
    "state": { "capability": "locomotion" }
  }
}
```

The selected Pack must provide the `locomotion` Capability when State uses that
Capability. `move-to-target` also requires a matching ID in the top-level
`targets` registry. The compiler rejects unknown target IDs. `svg-path` accepts
one bounded path string, validates it with detached browser geometry, and never
inserts it as markup or evaluates it.

Reduced-motion policy suppresses autonomous and release-momentum motion while
preserving direct dragging. It renders the same safe static tableau described in
the lifecycle section.

The [interaction and motion guide](interaction-and-motion.md) documents all
numeric bounds, target anchors, throw ownership, path restart behavior, and the
optional Canvas renderer.

Two Rules that can write the same named surface or data channel need an explicit
conflict policy. Hatch rejects the Configuration if that policy is missing.
Peekling does not silently choose whichever Event arrived last. Authors must
explicitly declare displacement when they intend it.

### Event updates

When an Event can match while an Effect or surface is active, the matching Rule
explicitly chooses one disposition on that surface:

| Disposition         | Result                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Update in place     | Keep the active ownership and apply newer validated data.                                        |
| Replace             | Complete or cancel the active ownership under its documented result, then select the new Effect. |
| Ignore              | Leave the active Effect or surface unchanged and return the documented result.                   |
| Temporary interrupt | Own declared channels until its duration or completion Event ends, then reevaluate the Plan.     |

The compiler accepts `update`, `replace`, `ignore`, and `interrupt`. If two
Rules write the same named surface, each writer must declare its disposition.
The compiler rejects the Plan otherwise and names both Rules and the channel.

An interrupt Rule also declares `effect.until`:

```ts
{
  channels: ["state", "surface:approval"],
  state: { state: "waiting" },
  surfaces: [
    {
      id: "approval",
      contentId: "approval",
      disposition: "interrupt",
    },
  ],
  until: {
    type: "event",
    name: "approval.accepted",
    timeout: 60_000,
  },
}
```

`until` can instead be `{ type: "duration", ms }`. The `ms` value is required,
finite, and between 1 millisecond and the one-hour ceiling. Event waits without
an explicit timeout use the same ceiling. A completion fact releases the
interrupt first and still reaches matching baseline Rules. Overlapping Plan
interrupts selected by later Events replace active overlapping ownership. If one
Event matches several competing Rules, the earlier declared Rule wins that
channel. Disjoint channel ownership continues to compose.

The completion name may be an application Event or a discrete browser Event. The
runtime retains a completion-only browser listener when no baseline Rule uses
that Event. `pointer.move` is continuous and cannot complete an interrupt. The
`section.visibility` name is also invalid because a completion does not declare
the selector, phase, and threshold needed to identify one section edge.

An ordinary Event Effect that owns State or motion stays latched until a later
Event owns that channel. The same rule applies to queued section `enter` and
`leave` facts. Adding `until` makes the Effect temporary. When its duration or
completion ends, the runtime releases its channels to the prior latched owner or
the baseline. A `while-visible` Rule is continuous, so it cannot declare
surfaces or `until`.

For ordered progress, a surface can declare `ordering.sessionField` and
`ordering.revisionField`. A terminal Rule sets `ordering.terminal` and may omit
the revision field. The event-state seam rejects stale revisions and events for
a closed session without changing that surface's revision ledger. The rejection
is scoped to the named surface. Valid effects for other ordered surfaces, plain
surfaces, State, and motion still run. Diagnostics report the rejected channel.

All ordered Rules for one named surface must use the same session field. All of
its non-terminal Rules must also use the same revision field. String and number
session IDs are separate identities. If one Event matches several Rules that
explicitly write that surface, the Event is admitted once and those Rules still
apply in declaration order. Ordering belongs only to application Event Rules, so
it is invalid on baseline surfaces, browser Rules, and Overrides.

## Character interaction

The runtime creates one accessible character control unless `interaction: false`
is set. Drag and throw are enabled by default. Pressing the character toggles
owned content. A host can choose `show-content`, `hide-content`, an application
Event, or no press action without changing the Plan grammar.

```js
const companion = hatch({
  character: "peek",
  plan: reviewPlan,
  content: reviewContent,
  bindings: reviewBindings,
  interaction: {
    contentInitiallyHidden: true,
    clearIndicatorOnPress: true,
    label: "Open Peek's review",
  },
  indicator: {
    kind: "count",
    count: 1,
    label: "One review needs attention",
    color: "#b0004f",
  },
});
```

`instance.setIndicator(next)` replaces the dot or count notification. Passing
`null` clears it. `color` accepts `transparent` or a 3, 4, 6, or 8 digit
hexadecimal color. This is instance presentation state and does not mutate the
Plan.

`instance.setContentVisible(visible)` gives host controls an explicit show or
close action for runtime-owned content. `instance.toggleContent()` uses the same
toggle as the default character press. Both methods return the resulting visible
state and leave the Plan unchanged.

Throw physics are elapsed-time based and bounded by Configuration. During drag
or throw, direct manipulation temporarily owns position and Plan motion is
suppressed. Landing or catching releases position back to the unchanged Plan.
Targets remain host-approved geometry references. The runtime reads their
rectangles and never moves, styles, reparents, or activates host elements.

Read [Character interaction and motion](interaction-and-motion.md) for the
complete default table, target-catching example, custom SVG route, reduced
motion behavior, and DOM or Canvas renderer parity.

## Temporary Overrides

Peekling also needs direct temporary control for cases such as an application
status or an explicit host command. The public method is `override(...)` on the
owned instance returned by hatch or exposed by the Web Component.

An Override:

- selects the same Effect fields as a Rule.
- temporarily takes rendering control ahead of the baseline Plan.
- has a bounded lifetime.
- returns a handle with status, completion, and idempotent cancellation.
- never changes or recompiles the Plan.
- never silently flushes unrelated Events or Overrides.
- releases once, then reevaluates the unchanged Plan using current world state.

Overlapping Overrides reject unless the caller explicitly sets
`mode: "replace"`. Replacement releases only Overrides that own a conflicting
channel. It does not disturb disjoint Overrides or queued Events. An omitted
lifetime uses the bounded runtime maximum. A duration, event timeout, or manual
maximum cannot exceed one hour.

```js
const handle = companion.override({
  effect: {
    channels: ["state", "surface:status"],
    state: { state: "working" },
    surfaces: [
      {
        id: "status",
        contentId: "status-card",
        data: { message: "Preparing files" },
      },
    ],
  },
  until: { type: "event", name: "job.finished", timeout: 30_000 },
});

await handle.finished;
```

## Generic content surfaces

A Rule or Override can select `contentId` and safe structured presentation data.
The engine positions generic content around the character. It does not know
whether the content is onboarding, a save confirmation, a product tour, a game,
or another use case.

Serialized content may contain bounded text, link data, presentation regions,
and a property-only host mount reference. A Control, if used, lives inside that
host mount. Serialized content may not contain raw HTML, inline handlers,
callbacks, DOM nodes, or framework objects. Pack content is never written
through an HTML-parsing sink.

Trusted custom content uses a mount function. Peekling supplies an empty,
engine-owned `root` inside the selected surface. The mount creates its own child
nodes in that root and returns cleanup. Core never adopts, reparents, or takes
ownership of an arbitrary existing host element.

### Advanced host-rendered surface

This example uses the implemented host mount seam.

```js
const companion = hatch({
  packUrl: "/peeklings/moss/0.1.1/character.json",
  plan: guidePlan,
  content: {
    review: {
      "top-center": { mountId: "review-card" },
    },
  },
  bindings: {
    mounts: {
      "review-card": ({ root, data, signal, emit }) => {
        const button = document.createElement("button");
        button.textContent = String(data?.label ?? "Review");
        button.addEventListener(
          "click",
          () => emit("review.requested", { source: "peekling" }),
          { signal },
        );
        root.append(button);

        return {
          update(next) {
            button.textContent = String(next?.label ?? "Review");
          },
          cleanup() {
            root.replaceChildren();
          },
        };
      },
    },
  },
});
```

The returned controller must expose `cleanup` and optional `update` as own data
properties. Peekling reads their descriptors, not their values through normal
property access, so accessors are rejected without being evaluated. A malformed
controller or throwing Proxy reflection trap removes only that surface. Proxy
reflection itself can invoke a trap because JavaScript has no trap-free Proxy
inspection API.

The runtime guards synchronous throws and rejected thenables from mount, update,
and cleanup. It permits one update in flight per surface and keeps one latest
data snapshot while that update is pending. It aborts the mount signal before
cleanup. When surface ownership changes, it replaces the engine-owned mount
root. A late mount or update can then touch only its detached root, not the new
surface. Cleanup runs once for each accepted controller. A failure removes only
that surface and keeps unrelated character and surface work alive. The scheduler
does not await host code. Host code reports later results with `emit`, which
follows normal Event admission.

Controls are examples of content composition, not engine-specific built-ins.
Optional framework packages adapt this same surface. They do not add another
engine or lifecycle.

## Changing content data

There is no direct content-update operation. Emit typed Events instead. For
example, `job.progress` can carry `{ completed: 12, total: 20 }`, while
`job.finished` can carry `{ changedFiles: 4 }`. The matching Rule selects a
surface and that surface receives the immutable payload. The Rule also declares
whether it updates the active surface, replaces it, ignores the Event, or
creates a temporary interrupt.

Progress Events need a bounded correlation or session ID and an ordered
revision. Revisions are monotonic within one session. A late progress revision
cannot roll the display back from 42 to 0. A terminal Event closes that session,
so later progress is ignored or rejected unless the application explicitly
starts a new session. In the usual job flow, `job.finished` replaces and
completes the job-progress Effect. It does not interrupt progress and then
resume the stale progress surface.

High-frequency progress should use eligible `coalesce: "latest"` Rules or be
rate-limited by host code before it calls `emit`. Session IDs and ordered
revisions remain part of admission even when intermediate Events coalesce. This
approach keeps content changes inside one validation, ordering, lifecycle, and
diagnostic model. `0.1.2` has no runtime `rateLimit` Plan field or second direct
content-update interface.

## ESM and browser-bundle delivery

The CDN file is the complete browser distribution. It contains hatch, the Web
Component, and explicitly documented browser helpers. It does not contain the
developer CLI, exhaustive preflight tooling, source-aware build diagnostics, or
framework adapters. Host Configuration is supplied separately when hatch runs or
the element is configured. Configuration supplied after download cannot make the
CDN file smaller.

The build emits a readable `peekling.js`, a production `peekling.min.js`, and
the required `peekling.css`. Package metadata selects the minified file as the
jsDelivr and unpkg default. ESM exports keep normal package entry-point names
and are not renamed to match browser globals.

The minified browser file keeps stable diagnostic codes but omits expanded
message prose. Use the adjacent readable `peekling.js` while debugging, or run
Preflight or Doctor for detailed validation guidance. Configured loggers still
receive structured severity, phase, sequence, metadata, and optional debug
causes from the minified file.

ESM consumers can import only the supported surfaces they use. Bundlers may
tree-shake unused static imports where side effects permit. Runtime
Configuration does not cause tree-shaking. Internal evaluators, queues,
renderers, and schedulers are not automatically public just because ESM uses
them.

The ESM root currently exports named `hatch`, Configuration and data contract
types, site visibility helpers, and explicit Web Component registration through
`definePeeklingElement()`. Importing the root does not create `window.Peekling`
or register `<peekling-character>`. The complete browser file attempts both
browser side effects independently. If either name belongs to the host, it is
left untouched and the other free surface remains available. The runtime
dispatches `peekling:collision` on `globalThis`, with `event.detail` naming the
occupied surface. Pack parsing and validation used by authoring tools lives at
the explicit `@peekling/runtime/pack` subpath, outside the ordinary browser host
surface.

Think of `peekling doctor` as a building inspector and the production runtime as
a smoke detector. The inspector can examine the Configuration and Pack before
deployment. The smoke detector is deliberately smaller, but it still protects
against hazards that appear only after people enter the building.

The current split is:

- `peekling doctor <configuration.json> [--pack character.json]` checks bounded
  JSON Configuration, Plan, and optional Pack data locally or in CI. `--json`
  returns deterministic structured output, and errors produce a nonzero status.
- `@peekling/preflight` exposes the same pure validation for development tools.
  It does not fetch resources, import application modules, execute predicates,
  or call host callbacks.
- `@peekling/vite` validates declared JSON Configuration and optional Pack files
  at startup, on watched input changes, and during builds. It has no client
  transform, module-loading, or HTML-injection hook.
- framework adapters remain optional separate packages.
- `@peekling/runtime` keeps only the bounded validation, normalization, Plan
  compilation, and security gates required at page load.

Source-aware locations inside JSON, bundle and performance checks, and release
orchestration remain future development-tool work. They are not current Doctor
or Vite-plugin features.

For a local or CI check:

```sh
npx peekling doctor ./peekling.json --pack ./character.json
npx peekling doctor ./peekling.json --pack ./character.json --json
```

Build tools can call the same validation without spawning a process. In this
example, `configuration` and `pack` are parsed JSON values from controlled
project files:

```js
import { preflight } from "@peekling/preflight";

const report = preflight(configuration, { pack });
if (!report.valid) {
  console.error(report.errors);
  process.exitCode = 1;
}
```

Both paths inspect data and return diagnostics. They do not replace the compact
runtime gate that checks dynamic input again when the page loads.

For Vite projects, add the validation-only plugin to the Vite configuration:

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

Vite itself executes `vite.config.js`. The Peekling plugin does not import the
two declared inputs as modules. It reads bounded JSON data, passes it to
`@peekling/preflight`, and leaves application imports and assets alone. See the
[`@peekling/vite` guide](../packages/vite/README.md) for watch behavior and base
URL defaults.

The small runtime gate is required even after doctor passes. CDN Configuration,
Web Component properties, and remote Pack bytes may be created or fetched only
at page load. The runtime must validate that dynamic and untrusted input before
readiness. ESM can omit optional imports and adapters where static tree shaking
permits. The complete CDN runtime instead has its own full-runtime size and
performance budget.

## Lifecycle and host isolation

See the [execution model](execution-model.md) for normative ordering and the
full lifecycle sequence. The practical rules are:

- await `ready` before depending on Pack-specific State or Capability
  references.
- call `destroy()` during host teardown.
- treat refresh and document navigation that fires `pagehide` as page teardown.
- destroy or reconnect the instance explicitly when a client-side router changes
  the owning view without ending the document.
- treat pause, hidden-page suspension, and site dismissal as composable reasons.
- do not expect catch-up animation or Event bursts after resume.
- expect reduced motion to replace motion with a safe tableau.
- expect normal CSP, CORS, mixed-content, and browser policy to remain in force.

Ordinary parked instances own no runtime frame, Plan timer, or evaluator work. A
clock-based dismissal keeps one bounded recovery timeout. It is cleared by show,
expiry, or final teardown. Session and forever dismissals keep no recovery
timeout.

Peekling isolates its DOM, state, errors, lifecycle, and scheduling as far as
the browser permits. Closed Shadow DOM is encapsulation, not a security
boundary. Host callbacks are guarded. Runtime faults are diagnosed and cleaned
up without throwing into unrelated host work.

Peekling and the host share the browser main thread for DOM work. Host long
tasks can delay Peekling frames. Peekling therefore promises bounded measured
work and graceful degradation, not independent frame timing.

An instance lasts for one document lifetime unless the host destroys it sooner.
`0.1.2` does not restore Plan state, Event queues, Overrides, position, content
state, or handles after `pagehide`. A `pushState`, hash, or client-side route
change does not end a direct hatch instance by itself. Single-page applications
must call `destroy()` when its owning view ends, or disconnect the Web Component
so its lifecycle facade performs that teardown.

`pagehide` destroys the current instance even when the browser keeps the page in
its back-forward cache. A direct hatch integration must hatch again after a
later `pageshow`. A connected `<peekling-character>` remounts a fresh instance
after a persisted `pageshow`. It does not resume its previous Plan, queue,
Override, position, or surface state.

Each programmatic instance exposes a non-rejecting `finished` promise. It
settles exactly once after cleanup with reason `destroyed`, `pagehide`, or
`failed`. Readiness remains separate and rejects when initialization fails.

## Strict CSP

Strict Content Security Policy compatibility is a `0.1.2` release gate. Peekling
must not require `unsafe-inline` or `unsafe-eval`. It does not inject raw HTML
or inline event attributes.

A page must still permit the runtime, its documented style mechanism, and the
selected Pack resources. Peekling cannot operate on a page that forbids all
scripts or all applicable styles.

Strict-CSP hosts can use:

- a self-hosted ESM bootstrap allowed by `script-src`.
- a self-hosted complete browser file allowed by `script-src`.
- exact version-pinned external script and `peekling.css` assets from allowed
  origins, using release-provided SRI where the delivery mode supports it.
- the Web Component written in external markup and upgraded by the allowed
  browser file.

Manifest and atlas fetch origins are subject to `connect-src`, CORS,
mixed-content, and normal browser policy. The verified atlas is rendered from a
browser-created Blob URL, so `img-src` must allow `blob:`. Each runtime shadow
root loads `peekling.css`. Position and theme changes go through the loaded
stylesheet's CSSOM rather than an element style attribute.

The browser file chooses a sibling `peekling.css` automatically. Use explicit
configuration when the stylesheet is hosted elsewhere:

```js
const companion = Peekling.hatch({
  packUrl: "/packs/moss/character.json",
  styles: {
    url: "https://static.example.com/peekling/0.1.2/peekling.css",
    integrity: "sha256-<stylesheet-release-hash>",
  },
});
```

The same values are available to markup as `styles-url` and `styles-integrity`.
ESM hosts should set them explicitly because bundlers do not all copy package
CSS the same way. The runtime package exposes the required asset at
`@peekling/runtime/peekling.css`. A bundler can emit that asset and pass its
final URL through `styles.url`. Without explicit styles, an HTTP or HTTPS ESM
module resolves the sibling `peekling.css` from its own module URL. A module
location that cannot identify an HTTP or HTTPS asset fails admission with
`styles.default` and asks the host to pass `styles.url`. A stylesheet that
cannot be loaded later reports `config.styles-load-failed`. A cross-origin
stylesheet must support CORS so the runtime can update its CSSOM. Browser gates
cover Chromium, Firefox, and WebKit with `style-src-attr 'none'`.

Instances in one document share one visibility control. They must use the same
stylesheet asset, or assets with the same nonempty SRI value. A conflicting
asset fails with `visibility.styles-conflict` instead of silently reusing the
first instance's stylesheet.

CSP, pinned URLs, origin allowlists, and SRI are defense in depth. They do not
eliminate every supply-chain risk or prove that published bytes came from
reviewed source. Release CI must build from an immutable source revision, verify
package and browser artifacts, generate and retain hashes and SRI values, and
record artifact provenance.

## Verification boundary

The source implements the contract described here through one compiler,
evaluator, Event queue, Override manager, surface manager, and lifecycle owner.
The schema, public declarations, examples, package export snapshot, Node tests,
strict-CSP browser matrix, hostile-host matrix, delivery-size gate, and browser
performance harness exercise those public seams.

Those checks provide bounded evidence for the inspected source and environment.
Real-device accessibility, constrained GPU, extension, fullscreen, cross-origin
iframe, long-soak, and shared-main-thread contention cases remain part of the
manual release matrix or benchmark platform. Source, tag, package, and
publication checks live in the [release guide](RELEASING.md).

## Related documentation

For contract questions, use the public JSON Schema for serializable fields and
bounds, the JavaScript extension declarations for property-only host values, the
package export map for supported imports, and the execution model for Event,
Rule, Override, surface, and lifecycle semantics. Tests and release reports are
evidence for the source and environment they exercised. A guide or example
cannot add a field or API that those contract surfaces do not define.

- [Runnable examples](../examples/README.md)
- [Documentation map](README.md)
- [Troubleshooting](troubleshooting.md)
- [Execution model](execution-model.md)
- [Engine design](../DESIGN.md)
- [Browser compatibility and host constraints](compatibility-and-hosting.md)
- [Schema and type references](schema/README.md)
