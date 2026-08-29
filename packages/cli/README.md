# `@peekling/cli`

Use the Peekling command line to check Configuration before deployment, create
and validate native Packs, compile artist-friendly source files, or import a
supported Codex Pet v2 bundle with explicit licensing metadata.

These commands run in Node and stay out of the browser runtime.

## Prerequisites and installation

- Node.js 22.14.0 or newer
- JSON Configuration and Pack files for Doctor
- Original or properly licensed source art for Pack authoring

Install the CLI as a development dependency:

```sh
npm install --save-dev @peekling/cli@0.1.4
```

Run it through `npx` so the project-local version is used:

```sh
npx peekling doctor ./peekling.json --pack ./my-character/character.json
```

Expected result for valid inputs:

```text
Peekling Doctor found no configuration errors.
```

Doctor exits with status `0` when the report is valid and status `1` when it
finds errors.

## Command reference

| Command                                              | Use it for                                              | Main output                                     |
| ---------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `peekling doctor <configuration.json>`               | Check Configuration, Plan, and optional Pack references | Human or JSON diagnostics                       |
| `peekling create <directory> --name <name>`          | Create a working synthetic native Pack scaffold         | New Pack directory                              |
| `peekling validate <directory>`                      | Verify a compiled Pack and its assets                   | Pack identity, State count, geometry, and bytes |
| `peekling pack <source-directory> --out <directory>` | Compile named source frames into dense runtime atlases  | Runtime-ready Pack directory                    |
| `peekling import codex <input> --out <directory>`    | Wrap a Codex Pet v2 bundle with provenance              | Imported adapter bundle                         |

The command grammar is closed. Unknown options, duplicate options, missing
values, and extra positional arguments fail before command work begins.

## Check Configuration with Doctor

Use `--pack` when the Plan refers to Pack States or Capabilities. Use
`--base-url` when relative resource URLs should be checked against a deployment
page.

```sh
npx peekling doctor ./peekling.json \
  --pack ./my-character/character.json \
  --base-url https://example.com/app/
```

Add `--json` for deterministic machine-readable output:

```sh
npx peekling doctor ./peekling.json \
  --pack ./my-character/character.json \
  --base-url https://example.com/app/ \
  --json
```

A successful JSON report has this shape:

```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

Each diagnostic contains a code, data path, explanation, and suggested fix.
Doctor reads JSON data only. It does not import project modules, evaluate
Configuration code, call host callbacks, fetch resources, or contact a network
service.

Relative resource and content-link references may resolve against an HTTP
development base URL. Serialized absolute resource URLs must use canonical HTTPS
without credentials, malformed hosts or ports, whitespace, control characters,
backslashes, or noncanonical IP spelling. Theme colors accept only lowercase
`transparent` or exact 3, 4, 6, or 8 digit hex values.

## Create a Pack scaffold

```sh
npx peekling create ./my-character --name my-character
```

Expected result:

```text
Created native Peekling pack at ./my-character
```

The directory contains a visibly synthetic geometric atlas so validation can run
immediately. Replace that fixture with original, properly licensed art. Update
the Pack license, provenance, and `metadata.description` before using the Pack
outside local development.

Commands refuse to overwrite an existing output directory.

## Compile artist source into a runtime Pack

`peekling pack` accepts a source directory containing `source.json`, license and
provenance files, and either row-based sheets or named frame directories.

```text
my-character-source/
  source.json
  source-1x.png
  LICENSE
  PROVENANCE.md
          |
          |  peekling pack
          v
my-character/
  character.json
  atlas-1x.png
  LICENSE
  PROVENANCE.md
```

In other words, author stable frame names and source locations. The compiler
then assigns dense numeric runtime frame IDs and writes the validated manifest.

A minimal row-sheet `source.json` looks like this:

```json
{
  "format": 1,
  "name": "my-character",
  "version": "0.1.1",
  "license": "CC-BY-4.0",
  "metadata": {
    "description": "A small companion for the example application."
  },
  "logicalCellSize": 32,
  "sources": [
    {
      "density": 1,
      "sheet": "source-1x.png",
      "columns": 16,
      "rows": 1
    }
  ],
  "states": {
    "idle": {
      "row": 0,
      "frames": ["idle-a", "idle-b"],
      "loop": true,
      "fps": 4
    }
  }
}
```

For that example, `source-1x.png` is a 16-column sheet with 32×32 source cells
and at least the two named frames in row `0`. Each State must choose either
uniform `fps` or one duration per frame.

Compile it:

```sh
npx peekling pack ./my-character-source --out ./my-character
```

Expected result:

```text
Compiled dense native pack to ./my-character
```

The compiler emits a deterministic 16-column atlas, removes unused source cells,
preserves the logical canvas, keeps frame order identical across declared
densities, and hashes each output atlas. A source may declare one through three
unique densities from `1`, `2`, and `4`.

## Validate a compiled Pack

```sh
npx peekling validate ./my-character
```

A successful result reports the exact Pack identity and measured atlas:

```text
Valid my-character@0.1.1: 1 states, 512x64 atlas (1234 bytes)
```

The dimensions and byte count above are illustrative. The command prints the
values measured from your files. Validation checks paths, hashes, geometry,
alpha, required Capabilities, timing, density variants, PNG chunk order, CRC
values, and a bounded image decode.

## Import a Codex Pet v2 bundle

The import command requires an output path plus explicit license, author,
source, and rights text:

```sh
npx peekling import codex ./pet.codex-pet --out ./imported \
  --license CC-BY-4.0 \
  --author "Artist name" \
  --source "Original Codex Pet v2 bundle" \
  --rights "Licensed by the named author for redistribution"
```

Expected result:

```text
Imported Codex Pet v2 bundle to ./imported
```

The command copies `pet.json` and the atlas byte-for-byte, writes
`peekling.json`, and preserves an input `.codex-pet` archive as
`source.codex-pet`. It never evaluates or copies bundled executable files.

The default supported atlas is `spritesheet.webp`. A self-hosted
`spritesheet.png` requires the explicit `--allow-png` flag:

```sh
npx peekling import codex ./png-pet-directory --out ./imported-png \
  --allow-png \
  --license CC-BY-4.0 \
  --author "Artist name" \
  --source "Original Codex Pet v2 directory" \
  --rights "Licensed by the named author for redistribution"
```

The flag allows the existing PNG bytes. It does not convert the image or grant
rights to redistribute it.

## File and write safety

Doctor rejects non-JSON files, symbolic links, invalid UTF-8, duplicate object
keys, and inputs over 64 KiB. It confirms file identity before and during a
bounded read. Run it against project inputs that another user cannot rewrite at
the same time.

Pack-writing commands stage output in a temporary sibling directory and finish
with an atomic rename. They do not overwrite an existing destination. Source
paths must remain inside the declared source directory, and source allocations
are bounded before image pixels are decoded.

## Related documentation

- [Configure Peekling](../../docs/configuration.md)
- [`@peekling/preflight`](../preflight/README.md)
- [`@peekling/vite`](../vite/README.md)
- [`@peekling/adapter-codex-pet`](../adapter-codex-pet/README.md)

## License

Apache-2.0. Imported and generated character assets retain their separately
declared licenses. See [licensing and attribution](LICENSING.md) for notice
retention, authorship, and brand boundaries.
