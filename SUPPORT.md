# Support policy

This policy defines the support boundary for the Peekling `0.1.x` engine line.

## Runtime and tool support

| Package or surface                            | Supported environment                                                        | Boundary                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@peekling/runtime` browser and Web Component | Current evergreen Chromium, Firefox, and WebKit                              | The release matrix records the exact tested engine versions. Older or embedded browsers are not implied. |
| `@peekling/runtime` ESM                       | Modern ESM bundlers and Node 22.14+ for tooling or server-side import checks | Hatch still needs browser APIs when an instance starts.                                                  |
| `@peekling/preflight` and `@peekling/cli`     | Node 22.14+                                                                  | Data-only local and CI authoring tools.                                                                  |
| `@peekling/vite`                              | Node 22.14+ and Vite 8.x                                                     | Development-time validation only.                                                                        |
| `@peekling/adapter-codex-pet`                 | Node 22.14+ or a compatible ESM build environment                            | Optional data conversion, never part of the browser runtime by default.                                  |

The browser runtime requires the standard APIs listed in
[`docs/compatibility-and-hosting.md`](docs/compatibility-and-hosting.md). Strict
CSP, CORS, resource limits, and page lifecycle behavior remain part of the
runtime contract. A host main-thread long task can still delay rendering.

## Getting help

For a usage question or reproducible nonsecurity bug, use the repository issue
tracker. Include the affected package and version, the browser or Node version,
the entry surface you used, and a minimal reproduction. Describe what you
expected and what happened instead.

Diagnostics can help with runtime reports, but review them before sharing. Do
not include credentials, private URLs, personal data, or sensitive host context.
Report suspected vulnerabilities through [`SECURITY.md`](SECURITY.md), not a
regular public issue.

## Version line

`0.1.0` defines the initial contract. Compatible fixes land in later `0.1.x`
versions unless a documented support decision creates another maintained line.
No pre-`0.1` compatibility alias is supported.

Package bugs belong to the package that owns the behavior. Character art and
Pack licensing belong to their Pack repositories. Framework adapters, the
website, and the benchmark platform have separate release cycles.

Security reports follow [`SECURITY.md`](SECURITY.md). This policy does not
define response-time guarantees, end-of-life dates, or commercial support.
