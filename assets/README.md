# Brand artwork

Three files, all COPIED byte for byte out of `packages/design/brand/` in the
Credda core repository, where they are generated. Nothing here is drawn,
resized, recolored or composited in this repository.

| File | What it is | Where it is used |
| --- | --- | --- |
| `credda-mark-spectrum.png` | The Seal alone, swept in the six brand colours, transparent, 830x830 | **The README header.** The only referenced file. |
| `credda-lockup-black.png` | The lockup — wordmark then Seal, no rule — in black, 2121x447 | Retired here. Still served; see below. |
| `credda-lockup-white.png` | The same lockup in white | Retired here. Still served; see below. |

## The identity is the spectrum, and it was not always

The two lockups were the header until 2026-08-29, and this file used to say
**"the Credda identity is achromatic"** in bold. That is no longer the rule.
Since `870d264` in `web`, `components/brand/Seal.tsx` makes `spectrum` the
**default** tone rather than an opt-in, and records that the older rule — which
reserved the sweep for four named large marks — is superseded. Every mark on
credda.io carries the sweep, api.credda.io was moved to match on 2026-08-29,
and a monochrome lockup on this page was the last surface showing the retired
mark to a stranger.

**The widening is of where the palette may appear, not of what it may say.** The
sweep is legal here for the one reason it is ever legal: it is a continuous
six-stop field across an identity asset — the brand saying its own name — and
not a swatch, not ink, and never a verdict. Outcomes still come from the state
families (ADR 0011). A README header is the safest place it can possibly sit,
because nothing on this page states a verdict beside it.

## Why the loose mark, and why only one file

credda.io and api.credda.io compose their headers from the **icon** variant —
the seal reversed out of a filled square — as a themed pair, because each tile
carries its own ground and a dark tile on a light page reads as a sticker. This
page does not do that, for two reasons that are specific to a README.

**A README header is large.** `BrandMark.tsx` substitutes the square icon only
below 32px, where the five notches stop resolving; above it the loose ring is
the right form, and the header renders at 96px.

**A README is rendered by strangers' renderers.** GitHub supports `<picture>`
with `prefers-color-scheme`, but the npm registry page renders this same file
and a themed pair there can land the wrong tile on a white page. The loose
spectrum mark has no wrong tile: it is transparent, and it is the one asset that
does not need a pair. `BrandMark.tsx` gives the reason and this repository
re-measured it against the two grounds a README actually lands on, sampling
every fully opaque pixel of the master:

| Ground | Weakest stop | Median |
| --- | --- | --- |
| GitHub light / npm, `#ffffff` | 1.81:1 | 3.28:1 |
| GitHub dark, `#0d1117` | 4.53:1 | 5.77:1 |

The yellow does not read on white — the same fact that made the design package
drop yellow from the wordmark sweep — so the weakest stop on a light page is
below the 3:1 a non-text graphic would owe **if it owed one**. A brand mark does
not: WCAG 1.4.11 exempts a logo. It is recorded here rather than discovered
later. The flat pair it replaced measured 19.13:1 and 19.80:1.

## Where the wordmark went

The header no longer carries one, and nothing was drawn to replace it. A
spectrum **lockup** does not exist in the brand folder — `credda-lockup-mesh.png`
is the older, social-card-only mesh treatment and is not this set — so shipping
one meant image editing nobody could review in a diff. That was the same
decision api.credda.io made hours earlier, and it composed instead. What
composes here is the mark above the `# @credda/js` heading that already names
the brand in selectable, resizable, screen-readable text, which is more than the
wordmark half of a raster ever was. The mark's `alt` is `Credda`.

## The lockups stay on disk

Nothing references them now and they are **not deleted**. That is the reasoning
already recorded in `credda-backend/src/public/router.ts` for the ink icons: an
unreferenced published asset is still somebody's downloaded asset, and their
`raw.githubusercontent.com` URLs have been live on this branch. Removing them
404s somebody else's page rather than ours.

## Rules

**Never hand-edit these.** They are generated output. To change them, change the
masters in `packages/design/brand/` and copy the result across again.

**Do not recolour or re-compose the mark.** The sweep is the shipped one. Do not
add or remove a notch, respace the run, or balance it: five notches down the
lower-left rim with the sixth position left clean, because that absence is the
meaning.

**Copy the pixels, do not composite them.** Pasting an RGBA image using itself
as a mask blends every partially transparent pixel toward the empty canvas, so
each antialiased edge darkens. The artwork looks identical and is not. Verify a
copy by hashing the file, not by looking at it:

```
shasum -a 256 assets/*.png
be33c109f9c375959239a07ac8f03bbef3372692531fdb2b647745cbd742ef04  credda-mark-spectrum.png
3633802f84abf8e694230f91d782e6c60f5d99f88d88f5dc5ba7d0db2ce10f56  credda-lockup-black.png
18b61c8c5563e46cd3acac07124d60f93f3898fbba919cc04fd02968470c175f  credda-lockup-white.png
```

## Why they are committed here rather than linked from elsewhere

The README is rendered on GitHub and, for the published package, on the registry
page, where a relative image path does not resolve. So the header uses an
absolute `raw.githubusercontent.com` URL, and the file it points at has to live
in this repository for that URL to exist. They are not shipped to the registry:
`package.json`'s `files` list covers `dist` only, and the tarball carries just
the README, the license and the manifest alongside it.
