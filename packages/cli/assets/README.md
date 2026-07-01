# Brand assets

`brand.svg` is the **single source of truth** for the CLD CTRL app mark (the
orange rounded tile + dark up-caret). Everything icon-shaped derives from it.

## When the branding changes
1. Edit `brand.svg`.
2. Keep the inline favicon SVG in `src/serve.ts` (the `/favicon.svg` handler) in
   sync with it.
3. Run `npm run gen-icons` (needs `$CHROME` set to a Chromium path) to
   regenerate `../cldctrl.ico` (multi-size 16–256, used by the Windows app
   shortcut via `core/setup-windows.ts`).

## Outputs / consumers
- `../cldctrl.ico` — Windows `.lnk` shortcut icon (shipped in `package.json`
  `files`). Generated; do not hand-edit.
- `src/serve.ts` `/favicon.svg` — the running dashboard's tab/taskbar favicon.

## Legacy (pre-launch, NOT the current mark)
The `docs/variant_*.png`, `docs/icon*.png` files (and the old root `cldctrl.ico`)
are the earlier "pixel sword" logo experiments. The marketing site (`docs/`) may
still reference one of them; they're kept for now and should be revisited /
regenerated from `brand.svg` when the branding is finalized before launch.
