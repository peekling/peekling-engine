# Peekling engine documentation

Use this page to choose the shortest path to the information you need. The root
[README](../README.md) gets a character running. These guides explain the
contract behind that first result.

## Start with your task

| Goal                                  | Read                                                      | What you will learn                                                                                 |
| ------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Add Peekling to a page                | [Configure Peekling](configuration.md)                    | ESM, browser script, Web Component, Pack selection, Plans, Events, Overrides, and content surfaces. |
| Add drag, throw, targets, or routes   | [Interaction and motion](interaction-and-motion.md)       | Default direct manipulation, target catching, motion types, SVG paths, and Canvas rendering.        |
| Run working code locally              | [Runtime examples](../examples/README.md)                 | Four small integrations using the built runtime and a synthetic Pack.                               |
| Understand the architecture           | [Engine design](../DESIGN.md)                             | Entry surfaces, trust boundaries, runtime pipeline, and package boundaries.                         |
| Reason about ordering and cleanup     | [Execution model](execution-model.md)                     | Event admission, channel ownership, lifecycle, suspension, failure, and teardown.                   |
| Set CSP, CORS, or self-hosting policy | [Compatibility and hosting](compatibility-and-hosting.md) | Browser support, host isolation, resource directives, integrity, diagnostics, and delivery.         |
| Diagnose an integration               | [Troubleshooting](troubleshooting.md)                     | Common readiness, Pack, stylesheet, lifecycle, and Event failures.                                  |
| Interpret performance evidence        | [Browser performance](browser-performance.md)             | What the release harness measures, its fixed thresholds, and the limits of a pass.                  |
| Prepare packages for release          | [Release guide](RELEASING.md)                             | Local verification, immutable source, package archives, publication, and post-release checks.       |
| Read machine-facing contracts         | [Schema reference](schema/README.md)                      | Serialized JSON, JavaScript-only extensions, and validation layers.                                 |

## How the documents fit together

```text
Get started
  README.md
      |
      +--> examples/README.md       runnable learning path
      +--> docs/configuration.md    task-oriented public API guide
                 |
                 +--> DESIGN.md                       architecture and boundaries
                 +--> docs/execution-model.md         normative runtime ordering
                 +--> docs/interaction-and-motion.md  direct manipulation and motion
                 +--> docs/compatibility-and-hosting.md browser and delivery policy
                 +--> docs/troubleshooting.md         symptom-to-action help
                 +--> docs/schema/                    machine-facing contracts
      |
      +--> CONTRIBUTING.md          contributor workflow
      +--> docs/RELEASING.md        release workflow
```

The configuration guide answers "how do I use this?" The execution model and
schema answer "what exactly does this mean?" Design and compatibility documents
explain why the boundaries exist and what the browser can still control.

## Package guides

| Package                       | Purpose                                   | Guide                                                      |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `@peekling/runtime`           | Browser and ESM runtime                   | [Runtime package](../packages/runtime/README.md)           |
| `@peekling/preflight`         | Programmatic developer-time validation    | [Preflight package](../packages/preflight/README.md)       |
| `@peekling/vite`              | Vite startup, watch, and build validation | [Vite package](../packages/vite/README.md)                 |
| `@peekling/cli`               | Doctor and Pack authoring commands        | [CLI package](../packages/cli/README.md)                   |
| `@peekling/adapter-codex-pet` | Optional Codex Pet v2 data adapter        | [Adapter package](../packages/adapter-codex-pet/README.md) |

Developer tools inspect source data before deployment. The production runtime
still validates Configuration and Pack bytes because browser-only values can
arrive after a build finishes.

## Sources of truth

The documents have different jobs:

1. Package exports define supported import paths.
2. JSON Schema and public TypeScript declarations define accepted shapes.
3. The execution model defines ordering and lifecycle behavior.
4. Tests and release evidence show what was verified in a recorded environment.
5. Guides and examples explain those contracts but cannot add a field or API.

If a prose example conflicts with the schema, declarations, or package exports,
treat the machine-facing contract as authoritative and report the mismatch.
