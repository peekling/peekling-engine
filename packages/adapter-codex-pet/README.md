# `@peekling/adapter-codex-pet`

Use this optional adapter when an application already has an unchanged Codex Pet
v2 bundle and documented rights to use its character artwork. Native Peekling
Packs do not need this package.

The adapter converts `pet.json`, its fixed atlas, and a Peekling licensing
sidecar into Peekling's normalized Pack shape. It does not repack source files,
evaluate bundled scripts, or grant redistribution rights.

## Prerequisites and installation

- Node.js 22.14.0 or newer for package installation and tooling
- A Codex Pet v2 `pet.json`
- A 1536×2288 atlas with transparency
- A valid SHA-256 for the exact atlas bytes
- A sidecar that records license and provenance

Install the adapter with the runtime that will consume its output:

```sh
npm install @peekling/runtime @peekling/adapter-codex-pet
```

## Inputs

| Input                | Required shape                                               | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `pet`                | Parsed Codex Pet v2 `pet.json` with `spriteVersionNumber: 2` | Supplies the source character name and supported timing metadata          |
| `sidecar`            | Peekling format 1 licensing record                           | Supplies the license, author, source, and redistribution-rights statement |
| `atlas`              | Metadata for the exact 1536×2288 source atlas                | Supplies filename, MIME type, geometry, transparency, and SHA-256         |
| `allowSelfHostedPng` | Optional boolean                                             | Allows `spritesheet.png` instead of the default `spritesheet.webp` path   |

WebP is the default Codex Pet v2 path. PNG is accepted only when the host sets
`allowSelfHostedPng: true`, uses the exact `spritesheet.png` filename, and
declares `image/png`. The adapter does not convert between those formats.

## Adapt a bundle

This example defines every input. Replace the all-zero digest with the SHA-256
of the atlas bytes before using the result at runtime.

```js
import { adaptCodexPetV2 } from "@peekling/adapter-codex-pet";

const pet = {
  spriteVersionNumber: 2,
  name: "review-companion",
};

const sidecar = {
  format: 1,
  adapter: "codex-pet-v2",
  license: "CC-BY-4.0",
  provenance: {
    author: "Artist name",
    source: "Original Codex Pet v2 bundle",
    rights: "Licensed by the named author for redistribution",
  },
};

const atlas = {
  fileName: "spritesheet.webp",
  sha256: "0".repeat(64), // Placeholder. Hash the exact atlas bytes.
  width: 1536,
  height: 2288,
  mimeType: "image/webp",
  hasAlpha: true,
};

const normalized = adaptCodexPetV2({ pet, sidecar, atlas });
console.log(normalized.displayName, Object.keys(normalized.states).length);
```

Expected result: `normalized` contains the fixed Codex v2 States, directional
mapping, source timing, atlas metadata, and provenance needed by Peekling's
normalized Pack contract. Invalid geometry, missing transparency, unsafe data,
or incomplete licensing metadata throws a `TypeError` with a field-specific
message.

## Pass the result to the runtime

The normalized Pack is valid runtime input. When it is inline, use `atlasUrl` to
tell the runtime where the byte-identical source atlas is hosted. This Vite
example also emits the required runtime stylesheet.

```js
import { hatch } from "@peekling/runtime";
import peeklingStyles from "@peekling/runtime/peekling.css?url";

const companion = hatch({
  pack: normalized,
  atlasUrl: "/peeklings/review-companion/spritesheet.webp",
  styles: { url: peeklingStyles },
  plan: {
    baseline: {
      channels: ["state"],
      state: { state: "idle" },
    },
  },
});

await companion.ready;
```

The atlas served at `atlasUrl` must match the SHA-256 supplied to the adapter.
The runtime verifies those bytes before decoding the image.

## Use a self-hosted PNG

Set the opt-in flag and keep the filename and MIME type aligned:

```js
const normalizedPng = adaptCodexPetV2({
  pet,
  sidecar,
  allowSelfHostedPng: true,
  atlas: {
    fileName: "spritesheet.png",
    sha256: "0".repeat(64), // Placeholder. Hash the exact PNG bytes.
    width: 1536,
    height: 2288,
    mimeType: "image/png",
    hasAlpha: true,
  },
});
```

Expected result: the adapter accepts the PNG metadata but still leaves hosting,
delivery, and byte verification to the application and runtime.

## Data and trust boundary

```text
pet.json + atlas metadata + licensing sidecar
                       |
               adaptCodexPetV2
                       |
                normalized Pack
                       |
                     hatch
```

In prose, the adapter snapshots the three data inputs, validates the fixed Codex
v2 contract, and returns a serializable normalized Pack. The host then passes
that Pack through the ordinary runtime boundary.

Inherited fields, accessors, `toJSON`, cycles, excessive depth or keys, and
throwing Proxy reflection fail during adaptation. Records must use the current
realm's ordinary `Object.prototype` or a null prototype. JavaScript cannot
inspect a Proxy without invoking reflection traps, so the adapter contains a
throwing trap but cannot promise that no trap runs.

Interoperability is best-effort because an external source format can change.
The adapter supports the fixed Codex Pet v2 geometry and row model documented
here. It does not infer support for later source versions.

## Related documentation

- [Configure Peekling](../../docs/configuration.md)
- [`@peekling/runtime`](../runtime/README.md)
- [`@peekling/cli` Codex import](../cli/README.md)

## License

Apache-2.0. Source character artwork retains its source license. See
[licensing and attribution](LICENSING.md) for notice retention, authorship, and
brand boundaries.
