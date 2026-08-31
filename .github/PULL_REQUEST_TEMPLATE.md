<!--
Read this first, because it decides whether the pull request can land at all.

THIS REPOSITORY IS A SOURCE MIRROR AND AN ISSUE TRACKER. Canonical development
of the engine happens elsewhere, and the surface of this client is not a design
decision made here: `src/lib/surface.test.ts` asserts that the client's method
list equals the engine's route list exactly, and that no trust-era name has come
back. A pull request that adds a method for a route that does not exist fails
that test, and the fix is a route, which is not in this repository.

So the changes that land here are the ones that are genuinely about this client:
a wrong type, a mis-parsed response, a stream frame that throws, an error that
loses its cause, a README that says something untrue. Those are welcome.

There is one maintainer. Review is not fast and it is not a queue; if a change
matters to you, say in the description what breaks without it.
-->

**What is wrong today.** <!-- The behaviour, not the change. -->

**What this changes.**

**How you know it works.** <!-- Name the test. `npm run typecheck && npm test`. -->

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] This does not add or rename a client method. <!-- If it does, say which engine route it corresponds to; surface.test.ts is the gate. -->
- [ ] Comments added here explain *why*, not *what*.
