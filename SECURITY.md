# Security policy

## Reporting a vulnerability

Use the repository's **Report a vulnerability** form when it is available. The
form creates a private report for the maintainers.

If the form is unavailable, open a public issue that asks only for a private
reporting channel. Do not include exploit details, reproduction steps, private
host data, credentials, or affected URLs in that issue. Continue the report only
after a maintainer provides a private channel.

## What to include

Give the affected package and version, the browser or Node version, a minimal
reproduction, and the practical impact. For Pack or loading issues, say whether
the input was trusted host Configuration, untrusted Pack data, or a remote
resource response. Remove tokens, private URLs, and user content.

The maintainer will confirm scope and coordinate a fix through the private
report. This project does not promise a response or repair time.

## Supported code

Versions listed as supported in [`SUPPORT.md`](SUPPORT.md) can receive a
security release. Development branches and local examples are useful for review,
but they are not shipped versions.

Release verification fails when tracked or reconstructed public source contains
a `private/` path, credential file, private key, or a supported token pattern.
It applies the same checks to packed text, source maps, and declaration maps.
Input paths are normalized before containment checks, and traversal or portable
absolute forms fail before scanning a file. These checks catch known mistakes.
They do not prove that every possible secret or sensitive detail has been
removed, so human review remains required.
