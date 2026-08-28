# Changelog

This file records changes by version.

## 0.1.0

Initial package set:

- `@peekling/runtime`, the hatch-only browser and ESM runtime.
- `@peekling/preflight`, the pure development-time Configuration and Pack gate.
- `@peekling/cli`, including `peekling doctor` and Pack authoring commands.
- `@peekling/vite`, the validation-only Vite integration.
- `@peekling/adapter-codex-pet`, the optional data-format adapter.
- A strict-CSP browser performance release gate with raw Chromium, Firefox, and
  WebKit evidence for startup, frame callbacks, parked work, timed recovery, and
  cleanup.
- Closed Configuration, CLI, Vite filesystem, adapter, Pack-image, and release
  workflow boundaries with adversarial regression coverage.

No migration aliases are part of the `0.1.0` contract.
