# Brand artwork

Two files, both COPIED byte for byte out of the Credda brand folder's
`brand-seal/`, where `build-seal.mjs` generates them. Nothing here is drawn,
resized, recolored or composited in this repository.

| File | What it is |
| --- | --- |
| `creddaseallockuplighttransparent.png` | The Seal lockup, orange `#C2410C`, for a light background. |
| `creddaseallockupdarktransparent.png` | The Seal lockup, blue `#5B9BFF`, for a dark background. |

The lockup is the wordmark first and the mark after it, with no rule and no
divider between them. It is the form to reach for anywhere wide and horizontal,
which is what a README header is. The mark never appears on its own here.

The mark is the **Seal**: a thick ring with five short notches cut into one
side, a run down the lower left and the rest of the rim smooth. An append-only
record where every confirmed job is a notch cut into the same seal, and the one
clean gap is where the next one goes.

Its rotational symmetry is broken on purpose. Twelve evenly spaced notches with
one gap is a cog, and a cog is stock engineering iconography; what stops this
being one is that the notches are a run down one side and the rest of the rim is
untouched, because the record is not finished. `build-seal.mjs` measures that run
off the encoded bytes of every file carrying the mark, so an edit that quietly
balances it fails the build rather than shipping.

These replace `creddalockuplong{light,dark}transparent.png`, the retired long
lockup from `collateral/`, which carried the previous three-lobe mark. The
retired standalone C appears nowhere at all.

## Rules

**Never hand-edit these.** They are generated output. To change them, change the
masters in the brand folder, run `node build-seal.mjs`, and copy the result
across again. `build-seal.mjs --check` fails if a file on disk has drifted from
what the generator produces.

**Copy the pixels, do not composite them.** Pasting an RGBA image using itself
as a mask blends every partially transparent pixel toward the empty canvas, so
each antialiased edge darkens. The artwork looks identical and is not. Verify a
copy by hashing the file, not by looking at it.

## Why they are committed here rather than linked from elsewhere

The README is rendered on GitHub and, for the published packages, on the
registry page, where a relative image path does not resolve. So the tags use
absolute `raw.githubusercontent.com` URLs, and the files they point at have to
live in this repository for that URL to exist. They are not shipped to any
registry: `package.json`'s `files` list covers `dist` only, and a registry
tarball carries just the README, the license and the manifest alongside it.
