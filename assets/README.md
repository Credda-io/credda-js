# Brand artwork

Two files, both COPIED byte for byte out of the Credda brand folder's
`collateral/`, where `build-collateral.mjs` generates them. Nothing here is
drawn, resized, recolored or composited in this repository.

| File | What it is |
| --- | --- |
| `creddalockuplonglighttransparent.png` | The long lockup, orange `#C2410C`, for a light background. |
| `creddalockuplongdarktransparent.png` | The long lockup, blue `#5B9BFF`, for a dark background. |

The LONG lockup is the wordmark first and the three-lobe mark after it, with no
rule between them. It is the form to reach for anywhere wide and horizontal,
which is what a README header is. The mark never appears on its own here, and
the retired standalone C appears nowhere at all.

## Rules

**Never hand-edit these.** They are generated output. To change them, change the
masters in the brand folder, run `node build-collateral.mjs`, and copy the
result across again. `build-collateral.mjs --check` fails if a file on disk has
drifted from what the generator produces.

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
