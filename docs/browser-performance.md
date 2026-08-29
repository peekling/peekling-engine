# Browser performance release evidence

Peekling measures its release performance in real browser engines. This harness
is a release acceptance check for promises already made by the runtime. It is
not the separate benchmark platform for comparing versions, devices, or human
experience.

## Evidence pipeline

```text
built peekling.min.js + peekling.css + fixed atlas
                         |
                         v
              loopback strict-CSP server
                         |
                         v
          Chromium + Firefox + WebKit runs
                         |
                         v
             raw samples and provenance
                         |
                         v
               fixed policy evaluator
                         |
                         v
             JSON report and exit status
```

The harness serves the production browser artifacts and a fixed Pack fixture to
each browser engine. It retains the raw scenario samples and environment
context, then evaluates that evidence against constants owned by the harness.
The JSON report records both the measurements and the reasons for any failure.

## Run the gate

Build the browser delivery and run every release browser:

```sh
npm run perf:browser -- --output artifacts/browser-performance.json
```

The command serves the built `peekling.min.js`, required `peekling.css`, and a
fixed 74-byte Pack atlas over a loopback HTTP server. The fixture uses a strict
CSP with external scripts and styles. It runs current Playwright Chromium,
Firefox, and WebKit, then exits nonzero if any threshold or lifecycle invariant
fails.

Run the command from the repository root after installing dependencies and the
three Playwright browser binaries. The npm script builds the browser artifacts
before starting the harness. The report writer creates the selected output
directory when it does not exist.

The browser file and harness module finish loading before a startup sample
begins. Timing starts immediately before the sample calls `Peekling.hatch(...)`.
It includes atlas and stylesheet readiness, engine initialization, the first
runtime render, and the remaining time to the next eligible native animation
frame. It does not include page navigation, browser-file transfer, or
browser-file parsing. Cold and warm startup samples differ in atlas and
stylesheet caching, not in browser-file loading.

A release report has contract `peekling-browser-performance-v0.1`, profile
`release-0.1.1`, and `releaseAcceptance: true`. Acceptance requires exactly one
Chromium, Firefox, and WebKit result, with exactly 40 cold and 40 warm startup
samples from each browser. These requirements are immutable harness constants.
The report's own context cannot lower them. Its `thresholds` object must contain
only four fixed numeric values: 30 and 50 ms for first frame, then 2 and 10 ms
for runtime callbacks. A missing, extra, changed, nonnumeric, or nonfinite value
fails report evaluation.

For a quick local signal while editing the harness, use:

```sh
npm run perf:browser:quick -- --output artifacts/browser-performance-quick.json
```

The quick form runs fewer repetitions in all three release browsers. It uses
contract `peekling-browser-performance-quick-v0.1`, profile `quick-local-v0.1`,
and `releaseAcceptance: false`. It is a faster local signal, not a release
result. Renaming its context cannot turn its five startup samples into the
required 40.

## Release thresholds

These release limits remain in force for 0.1.1:

| Measurement                                        | Gate                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Cold and warm hatch to first eligible visual frame | p50 at most 30 ms, p95 at most 50 ms                                                      |
| Peekling runtime callback duration                 | p95 at most 2 ms, maximum at most 10 ms                                                   |
| Parked interval                                    | 0 runtime rAF callbacks, timer schedules, and timer callbacks                             |
| Timed dismissal recovery                           | exactly 1 bounded recovery timer, cleared by show, expiry, or destroy                     |
| Event burst cadence                                | at most 1 pending runtime rAF                                                             |
| Resume                                             | runtime frame callbacks resume                                                            |
| Repeated destroy                                   | 0 owned roots, runtime rAFs, timers, object URLs, later work, and later resource requests |
| Browser errors                                     | 0 page errors, unhandled rejections, and CSP violations                                   |

The size gate remains separate. `npm run size:release` measures
`peekling.min.js` plus `peekling.css` against the 40 KiB gzip and 40 KiB Brotli
caps, including the required 256-byte release reserve defined in
[`scripts/budgets.mjs`](../scripts/budgets.mjs).

The current 0.1.1 candidate carries canonical size evidence for the artifact
hashes recorded in
[`scripts/browser-size-evidence.json`](../scripts/browser-size-evidence.json).
Publication still requires the clean tagged release verifier.

The first eligible visual frame is a native browser animation-frame boundary,
not the resolution of a Promise or a DOM mutation timestamp. Before selecting
that frame, the harness requires `ready` to resolve and verifies that the owned
root is connected with State, frame, and position output. It then waits for the
next saved native `requestAnimationFrame` callback. The gated hatch time
includes resource readiness, engine startup, and the remaining browser display
cadence. Raw samples keep the ready-to-frame interval separately, so a slower
display cadence is visible rather than relabeled as engine work or paint. Each
startup sample also records one native-frame callback after readiness. The gate
rejects a missing or different count, so a future harness change cannot silently
substitute readiness for the selected frame.

An animation-frame callback is the browser's rendering opportunity before paint.
It does not prove physical pixels appeared on every display. The harness
therefore calls this an eligible visual frame and does not substitute DOM
mutation time for paint time.

Runtime callback duration is measured by a test wrapper around
`requestAnimationFrame`. The wrapper forwards the same callback and timestamp to
the browser. Harness waits use saved native clock functions, so they are not
counted as runtime work.

Frame interval and achieved frame-rate samples are retained but have no new
numeric release threshold. The initial contract did not define one, and this
harness does not invent a product promise.

## Scenarios

| Scenario         | What it measures                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `cold-hatch`     | 40 hatches with uncached atlas and stylesheet loads                                             |
| `warm-hatch`     | 2 warmups followed by 40 cacheable hatch samples                                                |
| `steady-motion`  | 90 native frames while the default Plan follows a pointer target                                |
| `event-burst`    | 1 warmup and 20 measured runs of 250 pointer observations plus 16 Event admissions              |
| `parked`         | 250 ms after session visibility parks the instance                                              |
| `timed-recovery` | the exact clock-based recovery timeout through show, forced expiry, destroy, and denied storage |
| `resume`         | the first runtime and visual frame after visibility is restored                                 |
| `cleanup`        | 10 hatch and destroy cycles followed by pointer, scroll, frame, and timer probes                |

The repeated burst corpus keeps one isolated scheduler outlier from becoming a
false p95 regression. Sustained slow callbacks still fail the unchanged 2 ms
threshold, and any callback above 10 ms still fails the maximum gate. Active
motion, burst, and resume scenarios must contain measured runtime callbacks, so
missing instrumentation cannot become a false pass.

The timed-recovery scenario captures the timer identifier created by each
clock-based dismissal. It requires one active recovery timer while waiting and
requires that exact timer to be gone after explicit show, deterministic expiry,
and destroy. The expiry branch invokes the captured timer callback instead of
waiting ten minutes. Storage methods are denied during the scenario. Other Plan
timers may appear after show and are recorded, but they cannot be mistaken for
recovery-timer residue.

The JSON keeps raw samples before nearest-rank p50 and p95 aggregation. It also
records browser name and version, user agent, operating system, Node version,
viewport, device pixel ratio, cache and network profile, fixture counts,
artifact byte counts and SHA-256 hashes, timestamp, source context, resource
timings, long tasks, and instrumentation details. A browser without Long Tasks
API support records that field as unsupported with `entries: null`.

Acceptance checks the report identity, fixed scenario counts, and raw evidence.
It requires exact counts rather than trusting `startupRepetitions` or other
context fields supplied by the report. It also binds the advertised threshold
metadata to the immutable policy used by the evaluator. Too few or too many
samples fail, as does any threshold metadata mismatch.

CI and the manual release workflow retain `artifacts/browser-performance.json`.
Machine-specific reports stay generated artifacts and are not source baselines.
A report records the available commit and origin, but the release verifier
separately proves clean source, exact tag, and repository provenance.

## What the result means

A pass is evidence for the recorded browser builds, host machine, fixture, and
run. It does not prove performance on every device or host page. Peekling and
the host share a browser main thread, so unrelated host long tasks can delay
frames. Long-task entries describe the whole page and are not automatically
attributed to Peekling.

The loopback network profile makes repeated release checks stable. It is not a
claim about public CDN latency. Real-device, network, GPU, comparative-version,
and HCI work belongs in the future benchmark platform or the manual release
matrix.
