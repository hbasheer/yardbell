# UI redesign PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Workspace on a new shared shell (rail, page column, status strip, jump palette) with the quiet dense tokens, Dispatch as a pane, a quieter pane header, deep links, and a phone layout built for it.

**Architecture:** Shared plain-script IIFEs (`window.YardbellX`, like `live.js` and `pull.js`) loaded by the page in a fixed order: `machines.js`, `shell.js`, `tree.js`, `strip.js`, `palette.js`, then `workspace.js`. `shell.js` wraps the page's `<main>` in the shell grid; the others fill parts of it. `workspace.js` keeps its layout engine and drops its own sidebar, Dispatch panel and page links. Other pages keep their sidebar in this PR and only pick up the new tokens.

Two refinements of the spec: the strip and the palette live in their own files (`strip.js`, `palette.js`) instead of inside `shell.js`, and the machine maths move to `machines.js` (shared by `nav.js` and the shell) rather than onto `YardbellShell`, so pages not yet on the shell use the same code. `confirm`, `appKey`, `tabKey` and `checkBuild` stay in `nav.js` until PR 5, since the Workspace does not use them.

**Tech Stack:** Rust axum server with embedded assets (`src/web/mod.rs`), plain ES5+ browser scripts and CSS, Rust tests in `src/web/tests.rs`, browser tests in `tests/browser/run.py` (headless Firefox over BiDi).

**Spec:** `docs/ui-redesign-design.md`

## Global Constraints

- No em dashes anywhere: copy, CHANGELOG, commit messages.
- No comments unless they explain a non-obvious why. No JSDoc.
- Shared scripts are IIFEs that set one `window.Yardbell*` object. `workspace.js` stays a classic script.
- Every new asset gets a `.route("/<name>", get(|| async { asset("<name>") }))` line in `src/web/mod.rs` and a check in a Rust test.
- Every `localStorage` read and write is wrapped in try/catch, and the page works without it.
- Phone breakpoint: `(max-width: 760px)`, the same `matchMedia` string `workspace.js` already uses.
- List text 13px, secondary 11.5px, group headers 11px uppercase. Desktop rows 26px tall, phone rows at least 44px. Strip 22px.
- Palette key: Cmd-K on macOS (`/Mac/.test(navigator.platform)`), Ctrl-K elsewhere. Ctrl-J is never taken.
- Never run against the live server on :4000. Browser tests: `~/.cargo/bin/cargo build && python3 tests/browser/run.py -k <name>`. Rust tests: `~/.cargo/bin/cargo test`. `cargo` is not on the Bash tool's PATH.
- Commit steps: show `git status` and `git diff --stat`, then commit only once the user approves. Never stage `.impeccable/config.json`.

## Review Focus

- **Ctrl/Cmd-K while typing in a Dispatch pane.** The Dispatch pane is its own document, so the key must be forwarded from it just like from a terminal. Test in Task 9.
- **A tab holding only a Dispatch pane.** `sync()` treats a tab with no session key as blank and drops a new session into it, which would overwrite the Dispatch leaf. Test in Task 6.
- **The Dispatch icon pressed twice, or after migration.** It must focus the existing Dispatch pane, never open a second one. Test in Task 6.
- **Deep links with encoded names.** `?open=hp%2Fdemo-api-1` and folders with spaces must resolve. Test in Task 8.
- **Phone to desktop width while a session is full screen.** Resizing past 760px must show the desktop layout with that session's pane focused, and back again must show the full-screen session, not the list. Test in Task 10.

---

### Task 1: Shared machine maths and merge readiness

**Files:**
- Create: `assets/machines.js`
- Modify: `assets/nav.js:1-35` (use `YardbellMachines`, keep re-exports on `YardbellNav`)
- Modify: `assets/pull.js` (add `ready`, `mergeText`, `merge`)
- Modify: `assets/board.js:16-18,32` (use `YardbellPull.ready`)
- Modify: `assets/dashboard.js:718-737` (use `YardbellPull.mergeText` and `YardbellPull.merge`)
- Modify: every HTML page that loads `nav.js` (load `machines.js` right before it): `dashboard.html`, `dispatch.html`, `settings.html`, `add.html`, `pipeline.html`, `proposals.html`, `diagrams.html`
- Modify: `src/web/mod.rs` (route `/machines.js`)
- Test: `src/web/tests.rs`

**Interfaces:**
- Produces: `window.YardbellMachines = { RATED, memPct(m) -> number|null, limitPct(m) -> number|null, tone(m) -> "ok"|"warn"|"bad", word(m) -> string, order(machines) -> machines }`, moved unchanged from `nav.js`.
- Produces: `YardbellPull.ready(p) -> boolean` (moved from `board.js`), `YardbellPull.mergeText(p) -> { title, body }` (the dashboard's current confirm copy), `YardbellPull.merge(s) -> Promise<string>` (POSTs `/sessions/{machine}/{tmux}/merge` with `{ head: s.pull.head }`, resolves with the ref, rejects with the server's error message).

- [ ] **Step 1: Write the failing Rust test** `shared_machine_maths_load_before_nav`: GET `/machines.js` with a cookie returns 200, `text/javascript; charset=utf-8`, and a body containing `YardbellMachines`; for each of the seven pages, `<script src="/machines.js"></script>` appears before `<script src="/nav.js"></script>`.
- [ ] **Step 2: Run it**: `~/.cargo/bin/cargo test shared_machine_maths_load_before_nav`. Expected: FAIL, 404.
- [ ] **Step 3: Implement** `machines.js`, the route, the script tags, and the `nav.js`, `pull.js`, `board.js`, `dashboard.js` changes. `YardbellNav` keeps `memPct`, `limitPct`, `RATED` and `order` as references to the `YardbellMachines` functions so existing callers do not change.
- [ ] **Step 4: Run** the Rust test (PASS), then `python3 tests/browser/run.py -k dashboard` and `-k merge` (all ok).
- [ ] **Step 5: Commit** "Share the machine maths and merge check between pages".

### Task 2: Quiet dense tokens

**Files:**
- Modify: `assets/style.css:1-115` (the three token blocks)
- Modify: `DESIGN.md` (front-matter colours and the type and spacing sections)

**Interfaces:**
- Produces new tokens used by later tasks: `--rail` (rail background), `--col` (column background), `--text-row: 13px`, `--text-small: 11.5px`, `--text-label: 11px`, `--row-h: 26px`, `--row-h-touch: 44px`, `--strip-h: 22px`.

Values. Light, the `:root` block:

| Token | Value |
|---|---|
| `--bg`, `--surface` | `#ffffff` |
| `--col` | `#fafafa` |
| `--rail`, `--side` | `#f2f2f2` |
| `--hover` | `#f2f2f2` |
| `--selected` | `#ececec` |
| `--ink` | `#2a2a2a` |
| `--muted` | `#6b6b6b` |
| `--line` | `#e6e6e6` |
| `--ok` | `#16a34a` |
| `--warn` | `#d97706` |
| `--bad` | `#dc2626` |

Dark, both the `prefers-color-scheme` block and `[data-theme="dark"]`:

| Token | Value |
|---|---|
| `--bg`, `--surface`, `--col` | `#18191b` |
| `--rail`, `--side` | `#121314` |
| `--hover` | `#202124` |
| `--selected` | `#26282b` |
| `--ink` | `#dcdcdc` |
| `--muted` | `#8e9196` |
| `--line` | `#27292c` |
| `--line-strong` | `#2e3034` |
| `--ok` | `#22c55e` |
| `--warn` | `#f59e0b` |
| `--bad` | `#ef4444` |

`--accent` stays for focus rings and links only. No selected or current state uses it.

- [ ] **Step 1: Change the values** in all three blocks and add the new tokens. Keep every existing token name.
- [ ] **Step 2: Grep for one-off selection colours**: `grep -n "accent-soft" assets/style.css`. Every rule that marks something as selected or current switches to `var(--selected)` and `var(--ink)`.
- [ ] **Step 3: Update `DESIGN.md`** to the same values and add the type sizes and row heights.
- [ ] **Step 4: Run** the full browser suite: `python3 tests/browser/run.py`. Expected: all pass. A test that asserts an old colour is updated to the new token.
- [ ] **Step 5: Screenshot pass** of `/`, `/workspace`, `/pipeline`, `/dispatch` and `/settings` in light and dark at 1280x800 in a dev slot (see the `yardbell-dev-harness` memory). Check that the contrast of muted text on `--col` stays at 4.5:1 or above.
- [ ] **Step 6: Commit** "Quieter, denser colour and type tokens".

### Task 3: The shell: rail, column, phone tabs

**Files:**
- Create: `assets/shell.js`
- Modify: `assets/live.js` (connection state)
- Modify: `assets/workspace.html` (drop the `ws-side` aside, the Dispatch aside and toggle; wrap `#ws` in `<main class="shell-main" id="main">`; load the new scripts)
- Modify: `assets/workspace.js` (`renderSide` writes into `YardbellShell.column`; remove `#server`, `#nav-vpn`, `#logout` and the `dispatch-toggle` handlers; the `#side-new` and `#keys-btn` buttons move into the column header)
- Modify: `assets/style.css` (new `.shell`, `.rail`, `.col`, `.tabbar` rules; remove `.ws-side` and `.ws-dispatch` rules)
- Modify: `src/web/mod.rs` (route `/shell.js`)
- Test: `src/web/tests.rs`, `tests/browser/run.py`

**Interfaces:**
- Consumes: `YardbellMachines` (Task 1), the theme toggle wiring in `theme.js`, which binds `[data-theme-toggle]` on `DOMContentLoaded`. `shell.js` runs at the end of `<body>`, before that event, so the rail's toggle gets bound.
- Produces `window.YardbellShell`:
  - `column: HTMLElement`, the `#col-body` element.
  - `head: HTMLElement`, the `#col-head` element, so a page can add buttons after the title.
  - `update(state)`. Called by the page after each `/state` load. It sets the proposals badge from `state.proposals` and the Dashboard badge from `state.problems.length`, then calls `YardbellStrip.update(state)` if present.
  - `badge(name, count)` with `name` in `"proposals" | "pipelines" | "dashboard"`.
  - `onRail(handler)`. `handler(page, event)` returns true to take over a rail click. The Workspace takes `"dispatch"`.
- Produces `YardbellLive.connected() -> boolean`, and a `yardbell-live` window event with `detail: { open }` fired whenever the socket opens or closes.

Markup `shell.js` builds around `<main id="main">`:

```html
<div class="shell" id="shell">
  <nav class="rail" id="rail" aria-label="Pages">
    <!-- for each page: a.rail-link[data-page][href][title][aria-current] > svg.icon + span.rail-count -->
    <!-- bottom: button.rail-link[data-theme-toggle], button.rail-link#logout (hidden in Tauri) -->
  </nav>
  <aside class="col" id="col" aria-label="...">
    <header class="col-head" id="col-head">
      <h1 class="col-title"></h1>
      <button class="btn quiet icon-btn" id="col-search" type="button" aria-label="Jump to (Ctrl+K)"></button>
    </header>
    <div class="col-body" id="col-body"></div>
  </aside>
  <!-- main moved here -->
  <footer class="strip" id="strip" aria-label="Status"></footer>
</div>
<nav class="tabbar" id="tabbar" aria-label="Pages"></nav>
```

Pages in the rail, in order, with the SVGs copied from today's `workspace.html` side links: Dashboard `/`, Workspace `/workspace`, Pipelines `/pipeline`, Diagrams `/diagrams`, Dispatch `/dispatch`, Proposals `/proposals`, Settings `/settings`. The column title is the current page's name, from `document.body.dataset.page`.

Phone tabs: Sessions `/workspace`, Board `/?view=board`, Pipelines `/pipeline`, Dispatch `/dispatch`, More. More opens a menu with Diagrams, Proposals, Settings, the theme toggle and Log out. Under 760px, `.rail` and `.strip` are hidden and `.tabbar` is shown. The tabbar hides while `html.keyboard` is set, as `.side-foot` does today.

- [ ] **Step 1: Write the failing browser test** `test_workspace_uses_the_shell`. At 1280x800, `/workspace` has `#rail .rail-link` with the texts from `title` equal to `["Dashboard", "Workspace", "Pipelines", "Diagrams", "Dispatch", "Proposals", "Settings"]`. The Workspace link has `aria-current="page"`. `#col-body #tree` exists. `document.querySelector('.ws-side')` is null. At 390x844, `#tabbar` is visible, its labels are `["Sessions", "Board", "Pipelines", "Dispatch", "More"]`, its bottom equals `innerHeight`, and there is no sideways scroll.
- [ ] **Step 2: Run it**: `-k test_workspace_uses_the_shell`. Expected: FAIL.
- [ ] **Step 3: Implement** `shell.js`, the `live.js` additions, the HTML, the CSS and the `workspace.js` wiring. Keep the old tree markup for now; Task 4 replaces it.
- [ ] **Step 4: Update the existing tests that read the old Workspace sidebar.** `test_workspace_sidebar_matches_the_other_pages` becomes a check that the rail's links match the dashboard sidebar's links (same pages, same order, ignoring Keyboard shortcuts). `test_phone_menu_is_a_bottom_tab_bar` checks `#tabbar` with the five labels on `/workspace`, and `.side-foot` with today's seven on the other pages. `test_collapsed_sidebar_draws_icons_only` skips `/workspace`. `menu()` reads `#rail .rail-link` titles on a shell page.
- [ ] **Step 5: Add the Rust check**: `/shell.js` is served and has `YardbellShell`, and `workspace.html` loads `/live.js`, `/machines.js` and `/shell.js` before `/workspace.js`. Extend `pages_that_show_the_state_load_the_live_script_first` for the ordering.
- [ ] **Step 6: Run** `~/.cargo/bin/cargo test` and `python3 tests/browser/run.py -k workspace`, then `-k phone` and `-k sidebar`. Expected: all ok.
- [ ] **Step 7: Commit** "Put the Workspace on a shared shell".

### Task 4: The tree

**Files:**
- Create: `assets/tree.js`
- Modify: `assets/workspace.js` (delete `renderSide`, `foldedMachines`, `fold` and the `#tree` click handlers; render with `YardbellTree`)
- Modify: `assets/style.css` (`.tree-*` rules; remove `.ws-space`, `.ws-item`, `.ws-machine` rules that nothing uses any more)
- Modify: `src/web/mod.rs` (route `/tree.js`)
- Test: `tests/browser/run.py`, `src/web/tests.rs`

**Interfaces:**
- Consumes: `YardbellMachines.memPct`, `limitPct`, `tone` (Task 1), `YardbellPull.ref` and `status`.
- Produces `window.YardbellTree`:
  - `build(state, { stateOf, keep }) -> Machine[]`, where
    - `Machine = { name, up, reason, mem: number|null, tone, repos: Repo[] }`
    - `Repo = { path, label, worktrees: Worktree[] }`
    - `Worktree = { machine, path, label, branch, pull, state, sessions: Session[] }`
    - `keep` is an array of `{ machine, folder }` to show even with no sessions (the Workspace passes the folder last picked).
  - `render(el, state, { stateOf, selected, onSession(key), onFolder({ machine, folder }), keep })`. `selected` is `{ key }` or `{ machine, folder }`.
  - `repoOf(path) -> string`.
  - `look(key, st)` records that the person saw session `key` in state `st`.
  - `unseen(key, st) -> boolean`.

Rules:
- `repoOf(path)`: if `path` matches `/^(.*)-worktrees\/[^/]+$/`, return the first group; otherwise return `path`.
- Folders come from the sessions' `folder` fields plus `keep`. Their `branch` and `worktree` flag come from the matching `state.folders` entry. Folders with no sessions and not in `keep` are left out, as the sidebar does today.
- Machines appear in `YardbellMachines.order` order. Every machine in `state.machines` appears, even with no sessions. A machine that is down shows `offline` (or `unreachable` when `reason` is set) with `reason` as the header's `title`.
- A worktree's `state` is the worst of its sessions' states, using the rank `blocked`/`error` 0, `done` 1, `working` 2, `idle` 3 (move `RANK` and `worst` from `workspace.js`).
- A row shows the dot, the label (`ticket · folder` as `title()` does today), then on the right: the pull request ref, and the age from the session's last activity. A row is bold when `unseen(key, st)` is true.
- "Seen" storage: `localStorage["yardbell.tree.seen"]` holds `{ [key]: state }`. On the first load with no stored map, every current session is recorded as seen. `look()` is called when a session's pane is focused or opened. A session with no entry, or whose state differs from its entry, is unseen.
- Folded machines keep using `localStorage["yardbell.ws.folded"]`, so people keep their folds.
- Rows use `data-key` for sessions and `data-machine` plus `data-folder` for worktrees. Clicking calls `onSession` or `onFolder`. Writing the same markup again is skipped, using the `paint` pattern from `workspace.js`.

- [ ] **Step 1: Write the failing browser test** `test_tree_groups_worktrees_under_their_repo`. On `/workspace`, run `YardbellTree.build(...)` against a synthetic state, with `stateOf: () => 'idle'`:
  - machines: `hp` up, and `box` down with reason "ssh: timed out"
  - sessions on hp in `~/code/app`, `~/code/app-worktrees/eng-1-a` and `~/notes`

  Assert:
  - `hp` has repos with labels `["~/code/app", "~/notes"]`.
  - The app repo has worktrees `["~/code/app", "~/code/app-worktrees/eng-1-a"]`.
  - `box` has `up: false` and no repos.
  - `YardbellTree.repoOf("/r/app-worktrees/x") === "/r/app"`.
  - `YardbellTree.repoOf("/r/app") === "/r/app"`.
- [ ] **Step 2: Write the failing browser test** `test_tree_marks_changes_until_looked_at`. Clear `yardbell.tree.seen` and load `/workspace` with a tmux session `hp-demo-api-1` in `demo-api`. The row `#col-body [data-key="hp/hp-demo-api-1"]` is not bold. Write `{"hp/hp-demo-api-1": "working"}` into the stored map and wait for a repaint: the row is bold. Click it: the row is not bold and the stored state equals the row's state.
- [ ] **Step 3: Run both**: `-k test_tree_`. Expected: FAIL.
- [ ] **Step 4: Implement** `tree.js` and switch `workspace.js` to it. Clicking a session calls the existing `open(key)` path. Clicking a worktree sets `saved.folder` and focuses that folder's tab, or an empty pane with the start picker, as clicking `[data-space]` does today.
- [ ] **Step 5: Update the tests that click `#tree [data-space$='demo-api']`** or read `.ws-item`, so they use `#col-body [data-folder$='demo-api']` and `[data-key]`. Find them with `grep -n "data-space\|ws-item\|#tree" tests/browser/run.py`.
- [ ] **Step 6: Add the Rust check**: `/tree.js` is served with `YardbellTree`.
- [ ] **Step 7: Run** `-k workspace` and `-k tree`, then `~/.cargo/bin/cargo test`. Expected: all ok.
- [ ] **Step 8: Commit** "One machine, repo and worktree tree for the Workspace".

### Task 5: Status strip

**Files:**
- Create: `assets/strip.js`
- Modify: `assets/workspace.html` (load it after `shell.js`)
- Modify: `assets/workspace.js` (call `YardbellShell.update(state)` in `load()`, replacing its own proposals badge code)
- Modify: `assets/style.css` (`.strip` rules)
- Modify: `src/web/mod.rs` (route `/strip.js`)
- Test: `tests/browser/run.py`, `src/web/tests.rs`

**Interfaces:**
- Consumes: `YardbellShell.update` (Task 3) calls `YardbellStrip.update(state)`. Also `YardbellMachines`, `YardbellLive.connected()` and the `yardbell-live` event.
- Produces `window.YardbellStrip = { update(state), loadUsage() }`.

Contents, left to right, inside `#strip`:
1. `span.strip-usage` holds one button per provider with windows: `Claude 42% · 2h` and `Codex 18%`.
   - The figure is the highest `used` among windows not past `resets_at`. The time is that window's reset, in `nav.js`'s `resetsIn` wording shortened to its number and unit.
   - Tone: amber at 70% or more, red at 90% or more or when `status !== "allowed"`, the same as `usageRows`.
   - Clicking Claude POSTs `/dispatch/usage/refresh` and re-renders. While it runs, the button is disabled. When it fails, the button's title is `Couldn't check Claude usage: <message>`.
   - Fetched from `/dispatch/usage` on load and every 5 minutes while the page is visible.
2. `span.strip-mem` holds one item per machine: `hp 43%`, amber when `tone(m) === "warn"`, and `box offline` when it is down. The title is `word(m)`.
3. `span.strip-live`, pushed right with `margin-left: auto`, reads `live` or `reconnecting`.
4. An empty `span.strip-bell`.

- [ ] **Step 1: Write the failing browser test** `test_status_strip_shows_usage_memory_and_connection`.
  - Seed usage the way `test_a_usage_limit_card_offers_to_resume` and the Codex test at line 1379 do.
  - Load `/workspace` at 1280x800.
  - Wait for `#strip .strip-usage` to include `Codex` and `42%`.
  - `#strip .strip-mem` includes `hp` and a `%`.
  - `#strip .strip-live` reads `live`.
  - The strip's height is 22.
  - At 390x844 the strip is not displayed.
- [ ] **Step 2: Run it**: `-k test_status_strip`. Expected: FAIL.
- [ ] **Step 3: Implement** `strip.js` and the wiring.
- [ ] **Step 4: Add the Rust check**: `/strip.js` is served with `YardbellStrip`.
- [ ] **Step 5: Run** the test and `~/.cargo/bin/cargo test`. Expected: PASS.
- [ ] **Step 6: Commit** "A status strip with usage, memory and the connection".

### Task 6: Dispatch as a pane, and v5 storage

**Files:**
- Modify: `assets/workspace.js`. Change `STORE`, `restore`, `sync`, `fillPane`, `paneEl`, `reviewPull` and `askDispatch`. Remove `showDispatch`, `toggleDispatch`, `dispatchShown`, `DISPATCH_KEY`, the resize call and the `dispatch` action `hide`.
- Modify: `assets/dispatch.js:1136-1150`. In the embedded branch, stop sending `hide`, since a pane closes from its own header.
- Test: `tests/browser/run.py`

**Interfaces:**
- Consumes: `YardbellShell.onRail` (Task 3).
- Produces a leaf shape that later tasks rely on: `{ pane, key }` for a session (`key` may be null for an empty pane), or `{ pane, kind: "dispatch", conversation }`. Helpers in `workspace.js`:
  - `isDispatch(leaf) -> boolean`
  - `isEmpty(leaf) -> boolean`, true when the leaf is not a Dispatch pane and has no `key`
  - `openDispatch(conversation = "") -> leaf`, which focuses an existing Dispatch leaf in any tab, or splits one in to the right of the focused pane in the current tab
  - `dispatchFrame() -> HTMLIFrameElement|null`

Rules:
- `STORE = "workspace.v5"`. `restore()` reads v5. If v5 is missing, it reads `workspace.v4` and converts it: leaves keep their shape. If `localStorage["yardbell.dispatch"] !== "closed"`, `openDispatch()` runs once after the first `sync()`. Then it saves v5. v4 is left in place, so a rollback still has it.
- Everywhere a leaf is tested for emptiness with `!leaf.key`, use `isEmpty(leaf)`: in `sync()`'s blank-tab check, `fillPane`, `visibleKeys` and the tab naming.
- `fillPane` for a Dispatch leaf:
  - The title is the conversation's title from `/dispatch/conversations`, fetched when the pane is created, or `Dispatch` until it arrives.
  - The body is one iframe with `src = /dispatch${conversation ? "?c=" + encodeURIComponent(conversation) : ""}`, with `data-dispatch` set.
  - The iframe is created once and never reloaded on re-render.
- The embedded Dispatch page sends `{ yardbell: "dispatch", action: "open", key }` today, and that still opens the session. Add `action: "conversation", id`, which the Workspace stores on the leaf, so a reload reopens the same conversation. `dispatch.js` sends it whenever its current conversation changes.
- `reviewPull` and `askDispatch` use `openDispatch()` and post into `dispatchFrame()`, keeping today's `load`-event fallback. On a phone they keep today's behaviour.
- The rail's Dispatch click on the Workspace, at desktop width, calls `openDispatch()` and returns true.
- Closing a Dispatch pane removes the leaf. It never asks about stopping sessions.

- [ ] **Step 1: Write the failing browser test** `test_dispatch_opens_as_a_pane_and_survives_a_reload`.
  - Load `/workspace` at 1280x800 with `workspace.v5` cleared and `yardbell.dispatch` set to `closed`.
  - Click `#rail [data-page=dispatch]`. Wait for `.ws-pane iframe[data-dispatch]`.
  - Click it again: the count of `iframe[data-dispatch]` is still 1.
  - Reload: the Dispatch pane is still there and the URL is still `/workspace`.
- [ ] **Step 2: Write the failing browser test** `test_v4_layout_moves_to_v5`. For each case, clear `workspace.v5` and set `workspace.v4` to a layout with one tab holding session `hp/hp-demo-api-1`.
  - With `yardbell.dispatch` removed, there are 2 panes, one with `iframe[data-dispatch]`.
  - With `yardbell.dispatch` set to `closed`, there is 1 pane and no Dispatch iframe.
  - With `workspace.v4` set to `"{not json"`, the page loads with one empty pane and no console errors.
- [ ] **Step 3: Write the failing browser test** `test_a_dispatch_only_tab_is_not_taken_by_a_new_session`.
  - Set `workspace.v5` to one tab whose root is `{ pane: "d1", kind: "dispatch", conversation: "" }`.
  - Start tmux session `hp-demo-api-2`, then POST `/refresh`.
  - Wait for a tab for `hp-demo-api-2`.
  - The first tab still holds `iframe[data-dispatch]`.
- [ ] **Step 4: Run the three**: `-k dispatch_opens -k v4_layout -k dispatch_only`, one at a time. Expected: FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Update the tests that click `#dispatch-toggle` or read `#ws-dispatch`.** Find them with `grep -n "dispatch-toggle\|ws-dispatch" tests/browser/run.py`. They open Dispatch with the rail and read `iframe[data-dispatch]`.
- [ ] **Step 7: Run** `-k dispatch` and `-k workspace`. Expected: all ok.
- [ ] **Step 8: Commit** "Dispatch opens as a Workspace pane".

### Task 7: Quiet pane header

**Files:**
- Modify: `assets/workspace.js` (`paneEl`, `fillPane`, the more-menu builder near line 1100, and the pane click handler)
- Modify: `assets/style.css` (`.ws-pane-head` rules)
- Test: `tests/browser/run.py`

**Interfaces:**
- Consumes: `YardbellPull.ready`, `mergeText` and `merge` (Task 1), `YardbellPull.reviewMark` and `status`, and the Dispatch helpers (Task 6).
- Produces header markup that later tests rely on:
  - `.ws-pane-head > .ws-state` (the dot), `strong.ws-pane-title`, `span.ws-pane-sub`
  - `span.ws-views[hidden]` (the view switch slot)
  - `span.ws-pane-pr`
  - `button[data-act="main"]` (hidden when there is no main action)
  - `button[data-act="more"]`

Rules:
- `ws-pane-sub`: `${agentLabel(s.agent)} · ${WORD[st]}${age}` for a session, where `age` is ` ${n}m` or ` ${n}h` since the last activity change for idle, done and blocked sessions. For a Dispatch pane it is empty.
- `ws-pane-pr`: `${ref} ${status(p).word}` with the status tone class, when `s.pull` is set.
- The main action:
  - **Merge `${ref}`** when `s.pull?.state === "open" && YardbellPull.ready(s.pull) && !s.stale`. It confirms with `mergeText` in a new `<dialog class="confirm" id="merge-confirm">` in `workspace.html`, then calls `YardbellPull.merge(s)`, then `toast("Merged " + ref)` and `load()`.
  - Otherwise, **Open review** when `s.review?.state === "asking"`. It calls `openDispatch(s.review.conversation)`.
  - Otherwise the button is hidden.
- The ⋯ menu lists, in order: Copy text, Open in its own tab, Split right, Split down, Move to its own tab, the existing session items (Review, Suggest a better prompt, the swaps and the rest), then Close. Move to its own tab is left out when the pane is alone in its tab. A Dispatch pane's menu has Open in its own tab (links `/dispatch?c=…`), the two splits, Move to its own tab and Close.
- The separate Copy text, Open, split, own-tab and close buttons are removed from the header. The Alt shortcuts still call the same functions.

- [ ] **Step 1: Write the failing browser test** `test_pane_header_is_one_quiet_line`.
  - With session `hp-demo-api-1` open, the header's buttons are exactly `[data-act="more"]` plus a hidden `[data-act="main"]`.
  - `.ws-views` is hidden.
  - The ⋯ menu's item texts start with `["Copy text", "Open in its own tab", "Split right", "Split down"]` and end with `"Close"`.
  - Alt+\ still splits the pane.
- [ ] **Step 2: Write the failing browser test** `test_pane_header_offers_merge_when_ready`. Fake a ready pull request on the session the way `merge_on_a_session_merges_its_pull_request_at_the_commit_shown` and the dashboard merge browser test seed one (`grep -n "def test_.*merge" tests/browser/run.py`).
  - `[data-act="main"]` reads `Merge #<n>`.
  - Clicking it opens `#merge-confirm` with the dashboard's wording.
  - Cancel leaves it unmerged.
- [ ] **Step 3: Run both**: `-k test_pane_header`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Update the tests that click `[data-act=split-row]`, `[data-act=text]`, `[data-act=own-tab]` or `[data-act=close]` in a pane header** so they go through the ⋯ menu or the Alt shortcut. Find them with `grep -n 'data-act=' tests/browser/run.py`.
- [ ] **Step 6: Run** `-k workspace` and `-k pane`. Expected: all ok.
- [ ] **Step 7: Commit** "A quieter Workspace pane header".

### Task 8: Workspace deep links

**Files:**
- Modify: `assets/workspace.js` (read the query once after the first `/state` load)
- Test: `tests/browser/run.py`

**Interfaces:**
- Consumes: `open(key)`, the folder selection from Task 4, `isEmpty` (Task 6).
- Produces the URLs the palette uses (Task 9):
  - `/workspace?open=<machine>/<tmux>`
  - `/workspace?folder=<machine>/<folder label>`

  Both values are URI-encoded as a whole.

Rules:
- `?open=`:
  - If the session exists, open and focus it.
  - If it does not, select its folder: the session's folder when it is in `state.ended`, otherwise nothing.
  - Then focus an empty pane whose body shows `That session has ended.` above the start picker.
  - The note is kept on the leaf as `ended: true` until the pane is used.
- `?folder=`: select that folder as clicking it in the tree does.
- After handling either, `history.replaceState(null, "", "/workspace")`.
- On a phone, `?open=` goes straight to the full-screen session (Task 10).

- [ ] **Step 1: Write the failing browser test** `test_workspace_deep_links`. Start session `hp-demo-api-1` in `demo-api`.
  - Go to `/workspace?open=` + `encodeURIComponent("hp/hp-demo-api-1")`. The focused pane's iframe `data-key` is `hp/hp-demo-api-1`, and `location.search` is `""`.
  - Go to `/workspace?open=hp%2Fno-such-session`. A pane shows `That session has ended.`.
  - Go to `/workspace?folder=` + the encoded `hp/<demo-api label>`. The tree's `[data-folder$='demo-api']` row has `aria-current="true"`.
- [ ] **Step 2: Run it**. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it**. Expected: PASS.
- [ ] **Step 5: Commit** "Link straight to a Workspace session or folder".

### Task 9: Jump palette

**Files:**
- Create: `assets/palette.js`
- Modify: `assets/term.js:408-420` (forward Ctrl/Cmd-K when embedded)
- Modify: `assets/dispatch.js:1136` embedded branch (forward Ctrl/Cmd-K)
- Modify: `assets/workspace.js` (route `{ yardbell: "palette" }` messages to `YardbellPalette.open()`)
- Modify: `assets/workspace.html` (load `palette.js` after `strip.js`)
- Modify: `assets/style.css` (`.palette` rules; a full-screen sheet under 760px)
- Modify: `src/web/mod.rs` (route `/palette.js`)
- Test: `tests/browser/run.py`, `src/web/tests.rs`

**Interfaces:**
- Consumes: `YardbellTree.unseen` (Task 4), the deep links (Task 8), the `#col-search` button (Task 3).
- Produces `window.YardbellPalette = { open(), close(), isOpen() }`, plus the message `{ yardbell: "palette" }`, which embedded pages post to their parent.

Rules:
- **Key:**
  - `(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyK"` opens it, with `preventDefault`.
  - In `term.js` and `dispatch.js`, the same test in a capture-phase `keydown` posts `{ yardbell: "palette" }` to `parent` with `location.origin`, and stops the event so it never reaches the shell.
  - Ctrl-J is not touched.
- **Markup:** `<dialog class="palette" id="palette">` with `input#palette-q` (placeholder `Jump to a session, folder, pipeline, run or page`), `ul#palette-list[role=listbox]` with `li[role=option][data-href]`, and `p.palette-note` for failed sources.
- **Sources,** fetched in parallel on each open and kept until close:
  - `/state`: sessions and folders. Use the page's own state through `YardbellShell.lastState` when it is set, so the Workspace does not fetch twice. Add `lastState` to `YardbellShell.update`.
  - `/api/pipelines`: `pipelines[].definition.id` and `.definition.name`, plus `pipelines[].runs.waiting`.
  - `/api/runs`: `runs[]` with `id`, `pipeline`, `pipeline_name`, `state`, `subject` (the subject's title for the label), `started`.
  - `/dispatch/conversations`: `id`, `title`, `updated`, `waiting`.
  - Pages: the seven rail pages.
- **Items:**

| Kind | Label | Detail | Href |
|---|---|---|---|
| session | `title()` | `agent · machine` | `/workspace?open=<key>` |
| folder | the folder label | `machine` | `/workspace?folder=<machine>/<label>` |
| pipeline | the name | `<n> waiting` when waiting | `/pipeline?p=<id>` |
| run | `<pipeline_name>: <subject>` | the state | `/pipeline?p=<pipeline>&tab=runs&run=<id>` |
| conversation | the title | `waiting` when waiting > 0 | `/dispatch?c=<id>` |
| page | the name | | the path |

  On the Workspace, a conversation item calls `openDispatch(id)` instead of navigating, and a session or folder item is handled in place without a reload.
- **Order with no query:** sessions whose state is `blocked`, then runs with `state === "waiting"`, then conversations with `waiting > 0`, then sessions where `unseen` is true, then everything else by most recent (session activity, run `started`, conversation `updated`), then pages.
- **With a query:** keep items where the query, lowercased, is a substring of the label, detail, machine, folder or pull ref. `#150` matches a session whose `pull.number` is 150. Label matches sort before detail matches, and within each group the earlier match position comes first.
- **Keys:** ArrowUp and ArrowDown move the selection (`aria-selected`), Enter opens, Esc closes. On close, focus goes back to the element focused before opening, or to the focused pane's iframe.
- **Failures:** a source that fails adds `Couldn't load <runs|pipelines|conversations>` to `.palette-note`. The other sources still list.

- [ ] **Step 1: Write the failing browser test** `test_palette_lists_what_needs_you_first_and_jumps`.
  - Start sessions `hp-demo-api-1` and `hp-demo-api-2`.
  - Mark `hp-demo-api-2` unseen through `yardbell.tree.seen`, as in Task 4.
  - On `/workspace`, `b.key("k", "Control")`.
  - `#palette` is open. The first `li[data-href*="open="]` is for `hp-demo-api-2`.
  - Type `demo-api-1` and press Enter. The focused pane's iframe `data-key` is `hp/hp-demo-api-1`, and `#palette` is closed.
- [ ] **Step 2: Write the failing browser test** `test_ctrl_k_in_a_terminal_opens_the_palette_and_ctrl_j_still_reaches_it`.
  - Focus the `hp-demo-api-1` terminal iframe and press Ctrl-K. `#palette` opens.
  - Close it with Esc.
  - Focus the terminal and type `printf 'a'`, then press Ctrl-J. A Ctrl-J reaches the shell as a newline, so the command runs.
  - Then type `printf 'b'`, press Ctrl-J, and wait for the screen to show `ab` across the two outputs. Use the `screenText()` helper the terminal tests use (line 960).
- [ ] **Step 3: Write the failing browser test** `test_ctrl_k_in_a_dispatch_pane_opens_the_palette`. Open Dispatch as a pane (Task 6), focus its composer inside the iframe, press Ctrl-K, and `#palette` opens on the parent.
- [ ] **Step 4: Write the failing browser test** `test_palette_says_which_source_failed`. Override `window.fetch` on the page so `/api/runs` rejects, then open the palette. `.palette-note` reads `Couldn't load runs`, and session items still list.
- [ ] **Step 5: Run the four**: `-k palette` and `-k ctrl_k`. Expected: FAIL.
- [ ] **Step 6: Implement.**
- [ ] **Step 7: Add the Rust check**: `/palette.js` is served with `YardbellPalette`, and `workspace.html` loads it before `workspace.js`.
- [ ] **Step 8: Run** `-k palette`, `-k ctrl_k` and `-k terminal`, then `~/.cargo/bin/cargo test`. Expected: all ok.
- [ ] **Step 9: Commit** "A jump palette on Cmd or Ctrl+K".

### Task 10: Phone Sessions list and full-screen session

**Files:**
- Modify: `assets/workspace.js` (replace the `ws-picking` mode with the Sessions list and the full-screen session; add the PR strip)
- Modify: `assets/workspace.html` (the session top bar: `#back`, the title, ⋯)
- Modify: `assets/tree.js` (a `phone` option that adds the one-fact rule and 44px rows)
- Modify: `assets/strip.js` (also render the usage figures into `#col-body .col-usage` when that element exists)
- Modify: `assets/style.css` (phone rules under `@media (max-width: 760px)`)
- Test: `tests/browser/run.py`

**Interfaces:**
- Consumes: `YardbellTree.render` (Task 4), the pane header pieces (Task 7), the deep links (Task 8), `YardbellPalette.open` (Task 9).
- Produces `document.body.classList` states `ws-list` (the Sessions list showing) and `ws-session` (one session full screen). They replace `ws-picking`. Also update the Rust test at `src/web/tests.rs:580`, which looks for `ws-picking` in `workspace.js`.

Rules:
- Under 760px:
  - `ws-list` shows the column full width, with the tree, the usage line (`#col-body .col-usage`, filled by `YardbellStrip`) and the search icon. The main area is hidden.
  - Tapping a session row sets `ws-session` and shows only its pane.
- The one fact on the right of a phone row is the first that applies: `needs you` (blocked), `limit <resets>` (when `s.resets` is set), the pull ref, the age.
- A machine header on the phone reads `<name> · <mem>%`, or `<name> · offline`.
- `ws-session` shows a top bar (`#back`, the title, ⋯ with the same items as the desktop pane minus the splits), the terminal, and a `.ws-pr-strip` under it when `s.pull` is set: `<ref> <status word>`, with Merge (same rule and dialog as Task 7) and Open review when there is one.
- `#back` goes back to `ws-list`. The phone never changes the saved tabs or splits. It only sets `saved.focus` to the session's pane, as today.
- Crossing 760px in either direction keeps the focused pane: going to desktop drops both classes, and going to phone with a focused session pane sets `ws-session`.
- On a phone, `?open=` sets `ws-session` directly.

- [ ] **Step 1: Write the failing browser test** `test_phone_sessions_list_opens_a_session_and_back`.
  - At 390x844 on `/workspace`, `body.ws-list` is set and `#col-body [data-key="hp/hp-demo-api-1"]` has a height of at least 44.
  - Tap it. `body.ws-session` is set, and the pane with `iframe[data-key="hp/hp-demo-api-1"]` fills the width.
  - Tap `#back`. `body.ws-list` is set again.
  - There is no sideways scroll at any point.
- [ ] **Step 2: Write the failing browser test** `test_phone_session_keeps_its_place_across_widths`.
  - At 390x844, open `hp-demo-api-1` full screen.
  - Resize to 1280x800. Neither `ws-list` nor `ws-session` is set, and the focused pane is that session's.
  - Resize back to 390x844. `body.ws-session` is set with the same session.
- [ ] **Step 3: Run both**: `-k test_phone_s`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Update the tests that use `ws-picking`.** Find them with `grep -n "ws-picking" tests/browser/run.py src/web/tests.rs`.
- [ ] **Step 6: Run** `-k phone` and `-k workspace`, then `~/.cargo/bin/cargo test`. Expected: all ok.
- [ ] **Step 7: Screenshot pass** of `/workspace` in light and dark at 1280x800 and 390x844, in a dev slot: the list, a session, a split with Dispatch, and the palette open.
- [ ] **Step 8: Commit** "Sessions list and full-screen sessions on a phone".

### Task 11: Changelog and the full run

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Add a CHANGELOG entry** in the file's bold-lead style:
  - **A new Workspace.** Pages switch from a rail on the left, the machine tree sits in the column next to it, and a strip along the bottom shows usage, each machine's memory and the connection. Dispatch opens as a pane you can split, move or give its own tab. Each pane's header is one line, with Merge when its pull request is ready.
  - **Jump anywhere with Cmd+K or Ctrl+K.** Sessions, folders, pipelines, runs, Dispatch conversations and pages, with what needs you first. It works from inside a terminal too, and Ctrl+J still adds a new line.
  - **Workspace on a phone.** Sessions is a list of every machine's sessions, and tapping one opens it full screen with its pull request and the key row.
  - **Quieter colours.** Denser rows and grey selection on every page, in light and dark.
- [ ] **Step 2: Run everything**: `~/.cargo/bin/cargo test`, then `python3 tests/browser/run.py`. Expected: all pass. If a browser test fails under load, re-run it alone before treating it as real (see the `cargo-not-on-path` memory).
- [ ] **Step 3: Commit** "Changelog for the new Workspace".
