# Peekling schema and type references

This directory documents the complete `0.1` Configuration boundary. It keeps
JSON-safe input separate from JavaScript-only callbacks and browser objects so a
Pack remains data, never executable code.

## Choose the right reference

| File                                                                                   | Use it for                                                                                          | Authority                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`peekling-options.schema.json`](peekling-options.schema.json)                         | JSON editors, CI validators, stored Configuration, inline native Packs, and normalized adapter data | Authoritative serializable shape, lexical grammar, defaults, and numeric or collection bounds |
| [`peekling-options-v0.1.d.ts`](peekling-options-v0.1.d.ts)                             | Reading the JSON-safe contract as TypeScript                                                        | Human-readable mirror of the JSON Schema                                                      |
| [`peekling-javascript-extensions-v0.1.d.ts`](peekling-javascript-extensions-v0.1.d.ts) | Hatch, Web Component properties, host mounts, diagnostics, Overrides, and site visibility helpers   | Human-readable mirror of the public JavaScript surface                                        |

Applications written in TypeScript should import supported types from
`@peekling/runtime`. The declarations in this directory explain the contract and
are checked against the runtime source, but they are not a second package entry
point.

## How validation fits together

```text
JSON-safe options --------> JSON Schema --+
                                           +--> Preflight --> hatch
DOM values and callbacks --> JS types -----+
```

The same path in prose:

1. JSON Schema closes the serializable object shape and checks lexical rules,
   required fields, ranges, and collection limits.
2. The JavaScript reference adds values that JSON cannot represent, such as
   mount functions, `Document`, `Window`, and diagnostic callbacks.
3. Preflight performs semantic checks that static types and regular expressions
   cannot complete. This includes URL parsing, cross-references, channel
   ownership, Pack capabilities, and State availability.
4. Hatch repeats the bounded checks needed for values or remote bytes that exist
   only when the page runs.

Passing TypeScript or JSON Schema validation alone does not prove that a remote
manifest, atlas, stylesheet, or Plan is usable. Run Preflight before deployment
and keep runtime rejection handling in place.

## Using the JSON Schema

Load the checked-in schema file directly in an editor or validator. Its `$id`
identifies this versioned contract and provides the reference base for its
definitions. Validation should not require a network request for that
identifier.

Do not add a `$schema` property to Peekling Configuration itself. The top-level
Configuration object is closed, so undeclared fields are rejected. Configure the
schema association in the editor, validator, or build tool instead.

The schema describes only JSON-safe values. It deliberately excludes:

- functions and promises
- DOM objects
- host mount registries
- log sinks and diagnostic callbacks
- injected `Document` or `Window` objects

Use the JavaScript extension reference for those property-only values. HTML
attributes accept only the documented scalar attribute surface. Objects and
callbacks belong on element properties.

## Configuration and Pack boundaries

A Configuration must select at least one Pack source through `character`,
`pack`, or `packUrl`. When more than one source is present, runtime precedence
is defined by the [configuration guide](../configuration.md).

Inline `pack` accepts either a native format-1 manifest or stable normalized
adapter data. Native Packs remain data-only. Asset paths, hashes, dimensions,
State timing, density variants, and locomotion mappings are all bounded by the
schema and semantic validators.

For complete examples and operational behavior, read:

- [Configure Peekling](../configuration.md)
- [Execution model](../execution-model.md)
- [Runtime package reference](../../packages/runtime/README.md)

## Updating the contract

A public contract change is complete only when all affected layers agree:

1. Update the JSON Schema for serializable shape or lexical constraints.
2. Update the readable TypeScript references.
3. Update runtime and Preflight types or validation when behavior changes.
4. Add parity, rejection, and positive-path tests.
5. Update the configuration or execution guide with one complete example.
6. Run the focused schema and type checks, then the repository core checks.

Use the workflow in [CONTRIBUTING.md](../../CONTRIBUTING.md). Do not loosen a
closed object, URL rule, resource bound, or data-only boundary only to make one
input pass.
