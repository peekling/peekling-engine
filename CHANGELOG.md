# Changelog

This file records changes by version.

## 0.1.5

- Raised the validated native Pack state limit from 64 to 128.
- Added runtime and authoring coverage for 100-state character Packs.
- Kept Pack validation bounded and rejected manifests above 128 states.

## 0.1.4

- Ended direct drag ownership when pointer capture is lost or the browser window
  loses focus.
- Added document-level release and zero-buttons fallbacks for fast mouse
  movement across a moving character hit target.
- Preserved sampled throw velocity for valid releases and used a safe
  zero-impulse fall for canceled interactions.
- Kept the Plan contract, Configuration schema, and public API unchanged.

## 0.1.3

- Added `motionPreference` with `system`, `full`, and `reduce` policies.
- Kept the default browser preference behavior unchanged.
- Let hosts keep direct touch manipulation and gravity active when full motion
  is essential to the experience.

## 0.1.2

- Removed the native mobile tap flash from the character interaction control.
- Made canceled touch drags release into gravity without carrying an accidental
  throw impulse.
- Preserved the existing reduced-motion behavior and interaction defaults.
- Kept the Plan contract, configuration schema, and public API unchanged.

## 0.1.1

- Enabled accessible character press, drag, and throw interaction by default.
- Added configurable bubble actions, custom press Events, notification dots and
  counts, target catching, landing States, and elapsed-time throw physics.
- Added `viewport-traverse`, `move-to`, `move-to-target`, `jump-to`, and
  `svg-path` motion to the canonical JSON Plan contract.
- Added bounded host target geometry with explicit selectors and manual refresh.
- Added named `companion`, `still`, `bottom-patrol`, and `viewport-roam` presets
  that compile into the same Plan evaluator.
- Added the optional `@peekling/runtime/canvas` entry point. Canvas changes only
  character frame presentation. Content controls remain accessible DOM.
- Kept Pack content data only. SVG path strings are sampled as detached browser
  geometry and never evaluated or inserted as markup.
- Added a detailed sunlit nook, viewport traversal, custom path, interaction,
  and renderer documentation.
- Set the complete browser delivery ceiling to 40 KiB gzip and Brotli while
  retaining the 256-byte release reserve and exact-toolchain certification.

The 0.1.1 contract replaces the unreleased 0.1 development surface. No migration
aliases are included.

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
- Hardened CLI PNG validation against incomplete compressed streams, trailing
  streams, and invalid decompressed scanline lengths.
- Kept Chromium example checks strict while recognizing exact fixture resource
  cancellations after the asserted runtime behavior succeeds.
- Pinned the default character Pack independently from engine package versions.

No migration aliases are part of the `0.1.0` contract.
