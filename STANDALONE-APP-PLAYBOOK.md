# Standalone App Playbook — turning a local web app into a "real app"

How to make a localhost web app *feel* like an installed desktop application —
its own window, its own taskbar icon, launched from a shortcut, no browser
chrome, no "click this URL" step. Learned building CLD CTRL's `cc web --app`;
written to be reused for **PhysioMetrics, CageMetrics, and other local web apps**.

The spectrum, cheapest → most native:

1. **Browser tab** — `open http://localhost:PORT`. Works, but feels like a website.
2. **App mode (`--app=`)** — chromeless Chromium window. *90% of the feel, ~1 day of work.* ← this playbook's sweet spot.
3. **PWA install** — browser-installed app; real Start-Menu/taskbar identity, pinnable.
4. **Tauri / Electron** — a true native shell. Most work, most control, biggest binary.

You can ship #2 now and add #3/#4 later without rewriting the web app.

---

## 1. Chromeless window: the `--app=` flag

Any Chromium browser opens a URL as a standalone, chromeless window:

```
chrome --app=http://127.0.0.1:PORT   # no tabs, no address bar, own window
```

- **Prefer Chrome over Edge.** Chrome gives the `--app` window its **own taskbar
  entry showing the site favicon**. Edge aggressively groups it under Edge's own
  identity (you'll see the Edge logo). This was a real, visible bug for us — the
  fix was literally "use Chrome first." Locate the browser: known install paths →
  Windows registry `App Paths` → PATH. Fall back to Edge if Chrome is absent.
- **Use an isolated profile:** add `--user-data-dir=<some app-specific dir>`. This
  gives the window a separate identity/taskbar grouping and avoids hijacking the
  user's main browser session. Trade-off: no shared logins/extensions (offer a
  `--shared-profile` escape hatch if the app needs the user's cookies).
- **Linux browser detection gotcha:** `command` is a *shell builtin*, not an
  executable — `execFileSync('command', ['-v', x])` **always fails**. Run it via
  `sh -c 'command -v <x>'` (or use `which`). Getting this wrong silently forces
  the "no browser" fallback on every Linux GUI machine.

## 2. Detecting "am I in app mode?" on the client

You often want the UI to differ in app mode (e.g. hide the in-page logo/title
because the OS window already shows it).

- **`display-mode: standalone` is UNRELIABLE for `--app=` windows.** Don't trust it.
- **Tag the URL instead:** launch `...?app=1` and read it on the client:
  ```js
  const IS_APP = new URLSearchParams(location.search).has('app')
    || (matchMedia && !matchMedia('(display-mode: browser)').matches); // installed PWA
  ```
  The URL tag is deterministic; the media query is a bonus for real PWA installs.

## 3. No "click the URL" step: launch the window for them

The whole point is that typing the command *opens the app*. Pattern:

1. **Probe** the port first (`GET /api/health`): if the server is already up, just
   open another window against it — don't try to re-bind the port.
   - **Validate the probe:** require `200` **and** your own JSON/response shape.
     A foreign service on the same port returning `404`/`401`/HTML must NOT be
     mistaken for your server (or you'll open a window to the wrong app).
2. If not running, **start the server detached in the background** and let the
   launcher process exit so the **terminal is freed** (don't block the shell on a
   foreground server for the default launch):
   ```js
   spawn(process.execPath, [entry, 'serve', '--app', '--port', PORT],
     { detached: true, stdio: 'ignore', windowsHide: true }).unref();
   ```
   The detached child serves *and* opens the app window; the parent prints one
   line and returns. `windowsHide: true` prevents a stray console window.
3. **Resolve `entry` robustly:** prefer the module's own location
   (`new URL('./index.js', import.meta.url)`) over `process.argv[1]`, so it works
   no matter how the process was launched (bin shim, `node dist/…`, symlink).
4. **Headless / no-GUI fallback** (SSH/CI, or Linux with no `DISPLAY`/`WAYLAND_DISPLAY`,
   or no Chromium found): don't try to open a window — serve in the foreground and
   **print the URL**. Keep the contract "the command shows me the app" even when a
   window is impossible.

## 4. Window + taskbar identity (icon)

A raw `--app=` window is still a *browser process*, so the OS's sense of its
identity is limited. To get your icon to show up:

- **Serve a real `favicon.ico`** (a raster `.ico`, multi-size). An SVG favicon is
  NOT enough for the window/taskbar icon — Windows wants the `.ico`.
- **Serve a web manifest** (`/manifest.webmanifest`) with `name`, `display:
  standalone`, `theme_color`, and **192px + 512px PNG icons**, and link it:
  `<link rel="manifest" href="/manifest.webmanifest">`. This is what makes the app
  **installable** (see §6) and improves identity.
- **Single-source your brand mark.** Keep ONE canonical `brand.svg` and rasterize
  everything (`.ico`, 192/512 PNGs) from it with a script, so a branding change is
  one edit + one command. (We used a headless Chromium via playwright-core to
  rasterize; any SVG→PNG rasterizer works.)

## 5. Desktop / Start-Menu shortcut

Give them something to double-click:

- Create a `.lnk` (Windows) whose target is a **hidden VBS launcher** that runs
  your `--app` command with **no console window**:
  ```vbs
  Set s = CreateObject("WScript.Shell")
  s.Run "cmd /c yourapp web --app", 0, False   ' 0 = hidden
  ```
  Set the `.lnk`'s `IconLocation` to your `.ico`. (COM `WScript.Shell.CreateShortcut`
  via a one-shot PowerShell call is the least-dependency way to author a `.lnk`.)
- **First-run silent setup:** on first launch, best-effort install the shortcut,
  then write a marker file (e.g. `setup.json {version, done}`) so it never runs
  again. **Never block or fail the launch on setup errors** — swallow them and, if
  the shortcut couldn't be created, print a one-line "run `yourapp shortcut`" hint
  rather than failing silently.

## 6. Taskbar *pinning* (quick launch) — the honest state on Windows

Users want it pinned to the taskbar like Chrome. Reality:

- **Windows 10 (1809+) and Windows 11 deliberately block programmatic taskbar
  pinning** for third-party apps. The "Pin to taskbar" shell verb was hidden/removed;
  on Win11 it's typically **absent entirely** (we verified this at runtime). Dropping
  a `.lnk` into the `User Pinned\TaskBar` folder doesn't work either — Explorer
  hash-validates that folder.
- **Best-effort attempt** (works on some Win10): resolve the *localized* verb name
  from `shell32.dll,-5386`, find the matching verb on the `.lnk` via
  `Shell.Application` COM, and `DoIt()`. If the verb is gone, **fall back to a
  one-click instruction**: "Right-click the Start-Menu tile → Pin to taskbar."
- **The genuinely native route is a PWA install (§7)** — an installed PWA gets a
  real Start-Menu entry with *your* icon that the user can pin, and it shows your
  icon (not the browser's).

Bottom line: you can create the shortcut automatically; the *pin* is a one-time
right-click on modern Windows. Don't over-promise auto-pin.

## 7. PWA install — the most native option without Tauri

With a manifest + icons (§4) served over `http://127.0.0.1` (treated as a secure
context), Chrome/Edge will offer **Install**. An installed PWA:

- gets its own window, Start-Menu entry, and **your** taskbar icon (pinnable),
- launches without any browser UI,
- updates when your served assets change.

Catch: the **Install** affordance lives in the browser's address-bar/menu, which a
chromeless `--app` window hides. Flow to expose it: open the app as a **normal tab**
once (or add an in-app "Install" button that calls the `beforeinstallprompt` event),
let the user install, and thereafter launch the installed app. This is the
recommended path for "feels exactly like Chrome" without shipping a native binary.

## 8. Cross-platform shortcut notes

- **macOS:** a tiny `.app` bundle under `~/Applications` (an `Info.plist` + a shell
  script that runs your `--app` command + an `.icns` icon). Or `open -a "Google Chrome" --args --app=URL`.
- **Linux:** a `~/.local/share/applications/yourapp.desktop` file
  (`Exec=<abs path> web --app`, `Terminal=false`, `Icon=<abs png>`), which lets it
  appear in the launcher and be pinned to most docks.
- **`command`/PATH resolution** for GUI launchers: a bare command name may not be on
  the GUI's PATH — resolve the absolute node/binary path at setup time.

## 9. Dev-loop + rendering gotchas (bit us; will bite any web app)

- **`Cache-Control: no-cache` on your JS/CSS bundle during dev.** Otherwise the app
  window serves a *cached* bundle and "none of my changes show up" (the classic
  Ctrl+Shift+R red herring). Cache immutable hashed assets; never cache the entry
  bundle you're iterating on.
- **Native `<select>` dropdowns collapse if you re-render the tree beneath them.**
  If you have a polling re-render, **skip the render tick while a `<select>` is
  focused/open** (`document.activeElement.tagName === 'SELECT'`).
- **(µhtml/lit-html specific) a template hole inside a quoted attribute string**
  (`class="foo ${x}"`) mis-parses and dumps attributes as visible text. Use a
  whole-value hole: ``class=${'foo ' + x}``.
- **Demo/synthetic mode must be inert vs the real machine** — a `--demo` instance
  should refuse to launch/mutate/reveal anything real, so screenshots are safe.

## 10. Entry-point contract (make the app the default)

When the web app becomes the product, make the bare command open it:

- `yourapp` → open the app (this playbook).
- `yourapp --tui` / `--legacy` → the old interface, if any.
- Non-TTY / piped → machine-readable output (e.g. `list --json`).
- Strip your routing flag (`--tui`) from **both** your arg array **and**
  `process.argv` so the CLI framework (Commander/yargs) doesn't choke on it.

---

### CLD CTRL reference implementation

- `src/core/app-launch.ts` — `findChromiumBrowser` (Chrome-first), `probeServer`
  (200 + JSON), `launchAppWindow` (isolated profile, `?app=1`), `launchDashboardApp`
  (probe → detached serve → window; headless fallback).
- `src/index.ts` — entry routing (`cc` → app, `cc --tui` → TUI) + `maybeFirstRunSetup`.
- `src/core/setup-windows.ts` — `installAppShortcut` (.lnk → VBS), `pinAppToTaskbar`
  (best-effort verb), `removeAppShortcut`.
- `src/web/views.ts` — `IS_APP_MODE` detection, app-mode brand suppression.
- `assets/brand.svg` + `scripts/gen-icons.mjs` — single-source icon pipeline.
- `serve.ts` — favicon.ico / manifest / icon handlers, `no-cache` on web assets.
