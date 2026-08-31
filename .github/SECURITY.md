# Security

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository: the
Security tab, then "Report a vulnerability". That opens a private advisory
visible to the maintainers and to you, and nowhere else.

Please do not open a public issue for something exploitable, and please do not
wait for us to be ready before you tell us.

What helps, in rough order:

- what an attacker gets, stated first
- the smallest input that demonstrates it
- the version or commit you were on

If you would rather not use GitHub, [credda.io](https://credda.io) has the
contact details.

## What this package is, and therefore what its attack surface is

`@credda/js` is a typed HTTP client. It holds an API key, builds requests,
parses responses and reads a server-sent event stream. It executes nothing it is
sent and it has no engine logic in it.

Three things are worth being precise about.

- **It holds a credential.** The key goes in a request header and nowhere else:
  not in a URL, not in a query string, not in a log line. `baseUrl` has no
  default, so the key is only ever sent to a host the caller named. If you find
  a path where the key reaches a URL, a redirect target or an error message,
  that is a vulnerability and we want to know.
- **Everything it parses is server-controlled.** Response bodies, error shapes
  and stream frames all arrive from a deployment the client trusts by
  configuration, but a client that throws on a malformed frame in a browser tab
  is still a defect. Report one.
- **What it returns is not.** The engine reads issue bodies, logs and diffs out
  of a real repository, so evidence and report text this client hands back is
  attacker-influenced by the time it reaches you. It is data. Rendering it as
  markup, or passing it to a model with authority, is the caller's decision and
  the caller's risk.

## Supported versions

The latest published minor. This package is pre-1.0 in practice — `1.0.0` is
unpublished, and npm still serves `0.8.0`, a different product. Fixes go to
`main` and to a new release rather than to a branch. `0.8.0` and the rest of the
`0.x` line are retired and will not receive fixes.
