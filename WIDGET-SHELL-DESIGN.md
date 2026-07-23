# Sidebar-as-widget + desktop spatial layout — scoping

**Status:** design note, nothing built. Captured 2026-07-22 from the owner's steer,
then revised after an adversarial review by Codex (which corrected several claims
in the first draft — see *Corrections* below).
Related: `REMOTE-WORKER-DESIGN.md`, ROADMAP #4 (PWA + Window Controls Overlay).

## The vision

1. The **left panel becomes a standalone widget** — its own small always-available
   OS window, movable and dockable anywhere on the desktop.
2. Conversations become **independent windows on the desktop**.
3. The widget becomes a **spatial manager** for them: grids/columns across
   monitors, like Windows Snap Assist.

## What already exists that fits this

| Piece | State |
|---|---|
| Conversations in their own chromeless windows | **Built** — pop-out (`?widget=1`), same server PTY, docks back |
| Surviving restarts / reopening | **Built** — pop-out registry + restore chooser |
| Sidebar as where conversations live when off screen | **Built** — minimize-to-sidebar (2026-07-22) |
| Server as a multi-client PTY host | **Built** — `serve.ts` terminals map, N clients per PTY |

The conversation-per-window model is real. The gap is OS-level window management
**and** — the first draft missed this — client-side state ownership.

## Corrections from the Codex review

The first draft was wrong or overconfident in four places. These are the load-bearing corrections.

### ❌ "Phase 1 is low risk because the PTY survives"

The PTY survives; **the view does not**, and the view holds unsaved state:

- **Compose draft** lives only in a textarea closure, cleared only on send
  (`cockpit.ts` ~529) — closing a pop-out loses unsent text.
- **Scrollback is client-side.** The server keeps only the last **256 KiB of raw
  bytes** (`serve.ts` ~871) and reattach does clear-then-replay (`serve.ts` ~1144).
  That is *not* xterm state restoration: older scrollback is gone, the viewport
  snaps to the bottom, and replay can begin **mid-escape-sequence** — which
  matters because the thing being replayed is a full-screen TUI.
- **Notepad** had a dirty-buffer flush bug on dispose (**found and fixed
  2026-07-22** as a result of this review — it was losing edits on tile close).
- **PTY geometry is global to the PTY** (`serve.ts` ~1153): while old and new
  windows overlap, the last client to fit wins and both reflow.
- **No readiness handshake**: `/api/popout` returns success when the browser
  process was *spawned*, not when the widget attached (`serve.ts` ~1625). Closing
  the old window first can leave you with no window at all.

→ Phase 1 is **medium/high risk** and needs a *view-handoff protocol*: flush
client state, launch the replacement, wait for a heartbeat + PTY attach, only
then retire the old view.

### ❌ "We cannot reposition an existing window"

True only for windows we spawn via the browser CLI. Cheaper routes exist:

- A **script-opened same-origin popup** can be driven with `moveTo`/`resizeTo`.
  The pop-out fallback path already creates one and **discards the handle**
  (`main.ts` ~752) — retaining it is close to free.
- A Chrome extension (`chrome.windows`) can rearrange windows.
- A small **native Windows helper** (`SetWindowPos` over tagged HWNDs) is far less
  than a shell swap.

### ❌ "Chrome placement flags make grid layouts achievable"

`--window-position`/`--window-size` are honoured, but they are **hints, not a
window-manager API**. Unaddressed: mixed-DPI multi-monitor coordinate conversion,
window bounds ≠ client area, WM clamping, **Wayland refuses global positioning**,
macOS safe areas — and, because all windows share one persistent
`--user-data-dir` (`app-launch.ts` ~252), the invocation may be handed to the
*already-running* Chrome process, so a successful `spawn()` proves nothing about
whether the bounds were accepted. Any layout feature needs **post-launch geometry
verification** and a manual fallback.

### ❌ "Tauri unless we need deep Node integration"

We *already have* deep Node integration: `node-pty`, an HTTP/WS server, fs and
process APIs. **Electron is the lower-risk baseline** — it hosts the existing
server largely as-is (cost: bundle size, native-module rebuild via
`@electron/rebuild`). Tauri forces a choice between a Node sidecar (two runtimes
to supervise and package) or porting the whole backend to Rust. Note also that
**neither** shell gives Windows AppBar docking or Snap-Layout integration for
free; both still need platform-specific native code.

## Also missing from the first draft

- **Pop-out registry is not safe for coordinated respawn.** It's a `localStorage`
  read-modify-write map with 5s heartbeats from multiple windows (`store.ts` ~227,
  `main.ts` ~1290); old and replacement windows share a tile ID, so a stale window
  can clobber or delete its replacement's entry. Liveness is inferred from a 20s
  heartbeat, not window identity. Needs a **server-owned registry with unique
  view-instance IDs** and compare-and-delete.
- **Dock-back needs a listening main window** (`main.ts` ~1245). If Phase 2 makes
  the cockpit optional, the widget must take over as that listener or dock-back
  silently dies.
- **Security must be redesigned before, not after.** Today: a loopback `Host`
  check plus a fixed `X-CLDCTRL: 1` header — a CSRF obstacle, *not* authentication.
  Any local process can attach to a PTY. Before multiplying windows (or adopting a
  shell that can navigate anywhere), add a **per-instance capability token** bound
  to the launched UI, authenticate HTTP + WS, and lock down navigation.
- **`getScreenDetails()` permission story**: origin/profile-scoped, so it breaks
  on profile reset, browser change, port change, or `localhost` vs `127.0.0.1`.
  Request it from an explicit gesture, handle denial and `screenschange`, and
  never send screen topology in telemetry.
- **Virtual desktops**: the per-virtual-desktop guard is **TUI-only**
  (`index.ts` ~177, `instance-guard.ts`) and is *not* reusable here. One server
  with views across desktops, or one per desktop, is an open decision.

## Revised sequencing

1. **Server-owned window/view lifecycle** — unique view-instance IDs, launch →
   readiness → retire transactions, desired-vs-actual geometry, draft/notepad
   flush semantics, behaviour when a controller window vanishes. *Everything else
   depends on this; it is the real Phase 1.*
2. **Capability-token auth** on HTTP + WS.
3. **Placement prototype** on the actual supported matrix (Windows mixed-DPI
   first), with verification and graceful degradation to manual layout.
4. **Decide** whether a separate sidebar window is worth building on Chrome at
   all, given it can't be docked/always-on-top/transparent — it may be throwaway
   work better deferred until a native shell exists.
5. **If native is required**: Electron as the baseline; justify Tauri only with an
   explicit decision to accept a sidecar or a Rust backend port.

## Recommendation

Do **not** start with the visible feature. Steps 1–2 are unglamorous but they are
what makes any of the rest safe, and step 1 pays for itself immediately: it is the
same machinery that would stop pop-outs from losing drafts today.
