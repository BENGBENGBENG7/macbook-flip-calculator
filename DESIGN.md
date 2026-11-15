# Macbook flip design system

This is a refinement of the existing green identity. Product behavior is recorded in PRODUCT.md.

## Direction

A calm procurement workspace. Real photos identify the machine; typography separates identity, asking/target price, reference evidence and profit. Brand expression lives in a green action, precise alignment and the rounded white MacBook mark.

## Tokens

| Role | Value |
|---|---|
| Canvas / paper / secondary surface | #f4f6f5 / #ffffff / #edf1ef |
| Primary ink / secondary ink | #1a2922 / #5f6e66 |
| Action and positive result | #166c49 |
| Negative / caution / secondary evidence | #b33b40 / #875d21 / #285b9b |
| Border / strong control border | #dce3df / #becbc3 |
| Small / medium / large radius | 8 / 12 / 16 px |
| Spacing rhythm | 4, 8, 12, 16, 20, 24, 32, 40 px |

Use semantic CSS variables from styles.css. Bright #25D366 belongs to the approved app icon; use the darker green for readable UI text/actions. Platform badges pair text with color, so color is never the only identifier. Caution is amber even when its numerical ranking is high; the ranking is not a probability.

## Typography

Use the native system sans stack with PingFang SC fallback for Chinese. This operational UI benefits from offline availability and platform familiarity. Main text 15–16 px; financial labels/reference 12–14 px; card prices 20 px; card profit 18 px; detail prices 24–26 px; detail heading 22–24 px. Use tabular numerals for amounts. Titles occupy two lines on cards; complete original text is retained in detail. Small status text remains visible on phones.

## Layout

- Main content has equal responsive gutters and a maximum 1840 px width.
- Grid uses `repeat(auto-fill, minmax(min(100%, 300px), 1fr))`; narrow phones show one readable column. No fixed card width or fixed column count.
- Cards share a whole-image 4:3 inspection area, platform/rank row, two-line title, paired prices, full-width reference and aligned profit footer.
- Header and toolbar stay sticky, using the measured header height, so multi-line status never collides with sorting/filtering.
- Desktop detail places full-width uncropped media beside the decision panel. Narrow detail stacks them. Photos retain aspect ratio with a 70vh desktop / 60vh phone ceiling.
- Editing leads with resale assumptions and fees; machine metadata and raw image links remain in a disclosure.

## Components and interaction

Primary actions are solid green, secondary actions outlined, contextual actions quiet, destructive actions red and confirmed in a titled native dialog with cancel focused by default. Most actions use 44 px hit areas. Native select, dialog and details behavior is retained. Use visible keyboard focus, labels/titles, inline errors linked to fields, and status announcements. Dialog messages must live inside the modal top layer.

Amounts are buttons with a drawn exchange icon. Platform badges remain distinct from recommendation badges. Failed images display a usable fallback. Empty states offer sync/retry or clear-filter actions; first load uses static skeletons, not an indefinite blank page.

Motion is short (150–180 ms), limited to color feedback and a dialog opening. Sync rotation expresses work in progress. Honor reduced motion; no looping decorative motion, hover zoom/cropping or scroll choreography.

## Logo and delivery

`logo.svg` is the source of truth. Export every PNG alias with `scripts/export-logo.swift`; home-screen assets use an opaque square background for OS masking. The desktop export adds optical padding before building the ICNS. Update asset query versions in index.html and manifest.webmanifest together. Existing iOS shortcuts may require removal and re-addition because iOS caches installed icons independently of page assets.

## Review standards

Adapted from Taste Skill, Impeccable and shadcn/ui. This remains plain HTML/CSS/JavaScript; no React/Tailwind migration is implied. Preserve the user-pinned utility grid, live data and green identity when marketing-oriented style guidance conflicts with them. Check real data at 320, 390, 768, 1024, 1440 and 1920 px, not only placeholder content.
