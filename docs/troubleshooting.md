# Troubleshoot Peekling

Most integration failures happen at one of three boundaries: synchronous
Configuration admission, asynchronous readiness, or later Event admission.
Identify the boundary first. It narrows the search quickly.

```text
hatch throws
  -> Configuration shape, Pack selection, or own-data boundary

hatch returns, ready rejects
  -> stylesheet, manifest, atlas, integrity, CORS, CSP, or Plan reference

ready resolves, later operation is rejected
  -> lifecycle state, Event queue, channel policy, or host integration
```

## Capture the failure once

Wrap both `hatch` and `ready` because either stage can fail:

```js
import { hatch } from "@peekling/runtime";

let companion;

try {
  companion = hatch({
    packUrl: "/characters/peek/character.json",
    diagnostics: { console: true },
    logger(record) {
      console.log(record.code, record.phase, record.metadata);
    },
  });

  await companion.ready;
} catch (error) {
  console.error("Peekling did not start", error);
}
```

Use `diagnostics.debug: true` only during controlled development. Do not place
secrets, personal data, private URLs, or user content in `diagnostics.context`.
A host that exports records owns its own redaction, retention, and transport
policy.

The readable `peekling.js` build includes expanded messages. The production
`peekling.min.js` build keeps compact stable codes. Run `peekling doctor` or
`@peekling/preflight` against the same Configuration when you need a field path
and suggested fix.

## Common failures

| Symptom or code                                            | What it means                                                | What to check                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Hatch throws before returning                              | The input failed synchronous admission.                      | Confirm the top-level value is a valid Configuration object, uses own data properties, and selects a Pack.                          |
| `manifest.selection`                                       | No usable Pack source was selected.                          | Set exactly one of `pack`, `packUrl`, or `character`. See [Pack-source precedence](configuration.md#strict-configuration-boundary). |
| `manifest.network`, `manifest.http`, or `manifest.timeout` | The manifest could not be fetched in time.                   | Check the URL, server response, `connect-src`, mixed-content policy, and CORS.                                                      |
| `manifest.hash`                                            | A registered manifest did not match its embedded SHA-256.    | Do not bypass verification. Restore the expected exact-version bytes or publish a new version and registry entry.                   |
| `atlas.network`, `atlas.http`, or `atlas.timeout`          | An atlas candidate could not be fetched.                     | Check the relative path, manifest base URL, `connect-src`, CORS, response status, and request deadline.                             |
| `atlas.hash`, `atlas.dimensions`, or `atlas.alpha`         | Downloaded bytes do not match the Pack contract.             | Verify the declared SHA-256, PNG dimensions, logical cell geometry, density, and alpha channel.                                     |
| `atlas.unusable`                                           | No declared candidate could be loaded safely.                | Inspect earlier atlas diagnostics. A lower-density fallback may also have failed.                                                   |
| `styles.default`                                           | ESM could not infer an HTTP or HTTPS stylesheet location.    | Emit `@peekling/runtime/peekling.css` with the bundler and pass its final URL through `styles.url`.                                 |
| Stylesheet load or CORS failure                            | The shadow-root stylesheet did not become usable.            | Check `style-src`, MIME type, CORS, SRI, and whether the response exposes a readable CSSOM.                                         |
| `peekling:collision`                                       | The browser file found an existing global or custom element. | Listen before loading the script, inspect `event.detail`, and use the remaining free surface or rename the host-owned value.        |
| `emit` returns `not-ready`                                 | The Event arrived before initialization completed.           | Await `ready`, then emit from current host state. The rejected Event was not queued.                                                |
| `emit` returns `queue-full`                                | The bounded 32-Event queue is full.                          | Use eligible `coalesce: "latest"` Rules or rate-limit in host code before calling `emit`.                                           |
| Character is static                                        | Motion may be parked or reduced.                             | Check document visibility, explicit pause, site dismissal, and `prefers-reduced-motion`. A reduced-motion tableau is expected.      |
| Character stays hidden                                     | A site visibility preference may be active.                  | Call `isPeeklingHidden()` and expose a host action that calls `showPeekling()`.                                                     |
| Direct hatch survives an SPA route change                  | Client-side routing did not end the document.                | Call `destroy()` when the owning view unmounts. A Web Component does this when disconnected.                                        |

## CSP and CORS checklist

For an external browser build, check each resource separately:

```text
runtime JavaScript      script-src
peekling.css            style-src
manifest and atlas      connect-src
verified Blob atlas     img-src blob:
```

Cross-origin JavaScript and CSS need CORS when loaded with integrity or when the
runtime must read the stylesheet CSSOM. Manifest and atlas fetches also need
CORS. Serve JavaScript, CSS, JSON, and PNG with their correct MIME types. See
[compatibility and hosting](compatibility-and-hosting.md) for the complete
delivery contract.

## Pack and density checks

An `atlasUrl` is a mirror override for declared bytes. It is not an image
conversion hook. For a Pack with density variants, set `density` to one declared
variant when using `atlasUrl`. The runtime verifies the candidate hash and
geometry and disables automatic density upgrades for that mirrored asset.

Run the authoring tools before debugging in a browser:

```sh
peekling validate ./my-character
peekling doctor ./peekling.json --pack ./my-character/character.json
```

These commands provide detailed paths and fixes. Browser admission remains
necessary because a remote response can differ from local source.

## Lifecycle cleanup

Call `destroy()` once from the host teardown path. Cleanup is idempotent, so a
repeated call is safe. The non-rejecting `finished` promise settles after owned
resources are released with `destroyed`, `pagehide`, or `failed`.

If a custom content mount fails, Peekling removes that surface while unrelated
motion and surfaces continue. A terminal renderer, geometry, or owned-root fault
destroys the affected instance. Use the diagnostic code to distinguish a surface
fault from an instance failure.

## Reproduce with the local examples

The [runtime examples](../examples/README.md) use a synthetic Pack, a
restrictive CSP, and the built browser files. If an integration fails in an
application but the matching example passes, compare Pack URLs, stylesheet
delivery, CSP, CORS, host lifecycle, and Configuration values before changing
runtime code.
