# Peekling engine repository instructions

This folder is the public Peekling engine monorepo. Keep it independent from the
private parent workspace and from sibling public repositories. Do not read,
import, package, or link parent documents or assets.

- Visual product surfaces belong in `peekling-web` and reusable visual
  primitives belong in `peekling-design-system`. The engine owns no website.
- Reader-facing website and documentation prose must not use em dashes or
  semicolons. Rewrite with a comma, colon, or period. Required programming
  syntax inside code blocks and code examples is exempt.
- Read `DESIGN.md` and the relevant contracts under `docs/` before changing a
  public API, runtime behavior, security limit, hosting requirement, or release
  gate. Update the affected contract documentation when a behavior change is
  intentional.
- Native packs are data only. Never evaluate pack content or use HTML-parsing
  sinks for pack strings.
- Treat runtime security limits and bundle budgets as release gates.
- Keep `@peekling/runtime` production dependency-free.
- Keep character packs, art, website code, and agent skills outside this repo.
- Do not publish, push, create remotes, or commit unless explicitly requested.
