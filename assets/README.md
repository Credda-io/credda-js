# Brand artwork

Two files, both COPIED byte for byte out of `packages/design/brand/` in the
Credda core repository, where they are generated. Nothing here is drawn,
resized, recolored or composited in this repository.

| File | What it is | Use it on |
| --- | --- | --- |
| `credda-lockup-black.png` | The lockup — wordmark then Seal, no rule — in black, 2121x447 | **Light backgrounds** |
| `credda-lockup-white.png` | The same lockup in white | **Dark backgrounds only.** Invisible on light ones. |

The pair is named for the job — black-on-light, white-on-dark — and not for a
hue. The brand README gives the reason: the hue has changed three times, and a
filename carrying a colour has to be rewritten each time. **The Credda identity
is achromatic.** Black, white and grey say "this is Credda"; colour on a Credda
surface belongs to an outcome and comes from the state tokens. That is why the
orange and blue seal lockups these two replaced are gone: their filenames named
a hue, and the hue was never the brand.

The mark is the **Seal**: a thick ring with five short notches cut down one side
and the rest of the rim smooth. An append-only record where every job that held
is a notch and the one clean gap is where the next one goes. Its rotational
symmetry is broken deliberately — twelve even notches with one gap is a cog, and
a cog is stock engineering iconography that says "machinery", which is the
opposite of the claim. Credda adds a notch only when the thing underneath it
holds: reproduced, diagnosed, patched, and proven by a test that fails before
and passes after.

The lockup is the form to reach for anywhere wide and horizontal, which is what
a README header is. The mark never appears on its own here.

## Rules

**Never hand-edit these.** They are generated output. To change them, change the
masters in `packages/design/brand/` and copy the result across again.

**The lockup has no rule and must not be re-composed.** The wordmark ends on the
terminal `a` and the Seal sits after it, two shapes at the same ink height
meeting at a single pinch, with a gap of 0.26 of the mark's ink width measured
ink edge to ink edge. That spacing is baked into the PNG. Rebuilding it from the
wordmark and the mark gets it wrong.

**Copy the pixels, do not composite them.** Pasting an RGBA image using itself
as a mask blends every partially transparent pixel toward the empty canvas, so
each antialiased edge darkens. The artwork looks identical and is not. Verify a
copy by hashing the file, not by looking at it:

```
shasum -a 256 credda-lockup-black.png
3633802f84abf8e694230f91d782e6c60f5d99f88d88f5dc5ba7d0db2ce10f56
shasum -a 256 credda-lockup-white.png
18b61c8c5563e46cd3acac07124d60f93f3898fbba919cc04fd02968470c175f
```

## Why they are committed here rather than linked from elsewhere

The README is rendered on GitHub and, for the published package, on the registry
page, where a relative image path does not resolve. So the `<picture>` tags use
absolute `raw.githubusercontent.com` URLs, and the files they point at have to
live in this repository for that URL to exist. They are not shipped to the
registry: `package.json`'s `files` list covers `dist` only, and the tarball
carries just the README, the license and the manifest alongside it.
