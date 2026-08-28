# Contributing to Peekling

Peekling `0.1.0` defines its initial public contract. Changes should keep the
supported surface small and should not add pre-`0.1` migration aliases. In
particular, do not add `run`, a public constructor, a default runtime export, or
imports into runtime internals.

## Set up the workspace

Use Node 22.14 or newer and npm 11.16.0. The lockfile is the dependency record.

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium firefox webkit
npm run check:core
npm run test:browser
```

On Linux machines that do not already have the required system libraries, use
`npx --no-install playwright install --with-deps chromium firefox webkit`
instead. This installs the same three browser engines and their operating-system
dependencies before the browser suite starts.

Ordinary `npm test` and `npm run size` use the active supported Node version and
current build artifacts. Canonical size provenance is a release-only gate. Run
`npm run size:release` only with Node 22.14.0 and npm 11.16.0.

## Make a focused change

Start with a failing test for runtime or tooling behavior. Keep Pack inputs
data-only, preserve strict CSP, and avoid HTML parsing sinks. Public behavior
changes need matching types, schema, tests, and documentation. Generated `dist`
folders and package archives stay out of source control.

Before asking for review, run:

```sh
npm run check:core
npm run test:browser
npm run release:verify:packages
```

`release:verify:packages` copies the source to a temporary directory, replays
the lockfile, scans public source, builds twice, compares artifact hashes, packs
every package once, scans packed text and maps, and runs an isolated consumer
smoke test. It removes its temporary files when it exits.

Ordinary changes should arrive through a pull request. Package publication runs
separately through the protected release workflow. Do not publish, tag, or
change package ownership as part of an unrelated contribution.

## Security reports

Never put vulnerability details in a public issue. Follow
[`SECURITY.md`](SECURITY.md) for the private reporting path and the safe
fallback when that path is unavailable.
