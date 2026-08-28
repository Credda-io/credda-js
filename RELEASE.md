# Releasing `@credda/js`

## The deprecation of 0.x — run this, and know why

```bash
npm deprecate @credda/js@"<1.0.0" "Credda's reliability-score API is being retired and 0.x is its client. This package is being redefined for Credda's bug-and-vulnerability engine. Pin @credda/js@0.8.0 to stay on 0.x."
```

**Why the message does not say "upgrade to 1.0.0".** It is written to be true
whether or not 1.0.0 exists yet. A deprecation notice that points at a version
nobody can install is worse than none: it reads as a broken release rather than
a retirement, and it is the first thing a user sees on an install that still
works fine.

**Deprecation is reversible.** `npm deprecate @credda/js@"<1.0.0" ""` clears it.
That is the one thing in this file that can be undone; publishing cannot.

**What it does not do.** It unpublishes nothing. Every 0.x version stays on the
registry forever and every existing lockfile keeps resolving. A pinned build
does not break — it prints a warning. That is the point: the API behind 0.x is
what will stop answering, and the warning is the only notice a pinned consumer
will get before it does.

## Order

1. Merge `pivot/credda` to the default branch.
2. `npm deprecate` as above. Safe at any time, and honest today: the product
   0.x speaks to is retired regardless of when 1.0.0 ships.
3. Publish 1.0.0 only after a human has read `CHANGELOG.md` and agreed that
   redefining a live name is the right call rather than taking a fresh one.
   1.0.0 is a client for Credda's engine API and shares no surface with 0.x.

## Authentication

These commands need an npm account with publish rights on the `@credda` scope.
Run `npm login` first; `npm whoami` should print your username.
