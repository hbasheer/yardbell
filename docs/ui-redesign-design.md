# UI redesign: shared shell, Workspace and phone

Project 1 of the three in [agent-app-comparison.md](agent-app-comparison.md). Projects 2 (feature gaps) and
3 (mobile app) get their own specs.

## Goal

Every page shares one quiet, dense shell, the Workspace becomes the place where sessions and
Dispatch live side by side, and the phone gets a layout built for it instead of a squeezed
desktop. Nothing the user can do today goes away.

Done means:

- Every page uses the same rail, page column, status strip and jump palette.
- The Workspace opens Dispatch as a pane, and saved v4 layouts carry over.
- On a phone, Sessions is a list, and a session opens full screen with its key row.
- Light and dark look the same in quality, at desktop and phone widths.
- The browser suite passes with the new selectors and the new tests listed below.

## Decisions already made

| Question | Choice |
|---|---|
| Shell | An icon rail for pages, then a column that each page fills |
| Look | Quiet and dense: 13px rows, grey selection, colour only on state dots, IBM Plex, light and dark parity |
| Workspace | Everything is a pane. Dispatch is a pane, and the pane header carries state, the view switch, the pull request and actions |
| Phone | The tree as a list; a session full screen with the switch, pull request actions and key row; bottom tabs |
| Dashboard | Stays an overview page: machine health plus the session list or Board |
| Palette key | Cmd-K on macOS, Ctrl-K elsewhere. Ctrl-J is Claude Code's newline key, so it stays with the terminal |
| Themes | Light, dark and Auto stay. Auto is the default |

## 1. Architecture

Pages stay separate HTML documents served by the Rust server. There is no single-page app and no
build step.

### `assets/shell.js`

A shared script that every page loads. It draws:

- **The rail.** Icons for Dashboard, Workspace, Pipelines, Diagrams, Dispatch, Proposals and
  Settings, with a count badge where something waits: open proposals from `/api/proposals`, and
  pipeline runs waiting on an answer or approval from `/api/runs`. Theme and log out sit at the bottom. The current page's icon is selected.
- **The page column.** An empty slot with a header (the page name and the search button). Each
  page fills the slot with its own list.
- **The status strip.** See section 4.
- **The jump palette.** See section 4.

Each page's HTML shrinks to its main area. The sidebar markup now repeated across seven HTML
files and the Workspace's own `ws-side` aside are removed.

The helpers in `nav.js` that are still needed move into the shell and keep their names on a
`window.YardbellShell` object: `confirm`, `memPct`, `limitPct`, `RATED`, `appKey`, `tabKey`,
`checkBuild`. `nav.js` keeps working for pages not yet moved and is deleted in the last PR.

### `assets/tree.js`

One component used in the Dashboard and Workspace columns and as the phone's Sessions screen.

- It builds machine, repo, worktree, session from the `/state` data pages already poll and follow
  through `live.js`.
- A folder named `<repo>-worktrees/<branch>` sits under `<repo>`, matching how Yardbell creates
  worktrees (`src/folders.rs`). A folder that does not follow that naming is its own repo with no
  worktrees under it. The snapshot has no repo field, and none is added in this project.
- Each row shows a state dot, the name, the pull request number and the age. Rows that changed
  since the user last looked at them are bold. "Last looked" is kept per browser in
  `localStorage`, guarded with try/catch.
- A machine header shows the machine name and its memory figure. A machine that is down shows
  "offline" or "unreachable" with the reason in its tooltip, as the sidebar does today. Machines
  fold, and the folded set is remembered per browser, as today.
- The component takes a click handler, so each page decides what a click does.

### Tokens

The colour and size variables in `assets/style.css` are rewritten for the quiet dense look:

- Neutral greys for surfaces, lines and selection. Selection is grey, not blue.
- Colour only for state: working green, needs-you amber, stopped red, idle grey. The existing
  `ok`, `warn` and `bad` tokens keep their names.
- 13px body text in lists, 11.5px for secondary text, 11px uppercase for group headers.
- Three levels of elevation: the rail, the column, the main area.
- IBM Plex Sans and Mono stay.
- Every token is defined for light and dark, and the dark values are tuned on their own rather
  than inverted.

`DESIGN.md` is updated to the same values. Pages drop their one-off sizes in favour of the
tokens as each page moves to the shell.

### Server changes

None for the shell. The only new URLs are the Workspace deep links in section 2, which the
Workspace page reads on the client.

## 2. Workspace

The layout engine in `assets/workspace.js` stays: one layout tree per tab (a leaf is a pane, a
split is `{ split, ratio, a, b }`), tabs per worktree, drag to split, merging tabs, the attention
ordering of tabs, panes that keep their terminal connected while they move, and every Alt
shortcut.

### Dispatch is a pane

- A leaf gains a kind: `{ pane, kind: "session", key }` or
  `{ pane, kind: "dispatch", conversation }`. `conversation` is empty for a new chat.
- The Dispatch side panel, its toggle and its resize handle are removed.
- The rail's Dispatch icon on the Workspace page, and "Dispatch" in the palette, open Dispatch as
  a pane split to the right of the focused pane in the current tab. If a Dispatch pane is already
  open in any tab, that pane is focused instead.
- On every other page, the Dispatch icon opens the Dispatch page.
- The pane holds the Dispatch page in its embedded mode, through the same iframe and
  `postMessage` hook used by the panel today. The existing flows that send a review or a request
  to Dispatch from the Workspace now target the Dispatch pane, opening one if needed.
- A Dispatch pane can be split, moved, dragged into its own tab and closed like a session pane.

### Saved layouts

The storage key moves from `workspace.v4` to `workspace.v5`. On first load, a v4 layout is
converted: every leaf becomes a session leaf with the same pane id and key. If the v4 Dispatch
panel was showing (`yardbell.dispatch`), a Dispatch pane is added to the right of the focused
pane in the current tab. A v4 layout that does not parse falls back to fresh tabs, as v4 does.

### Pane header

One line, from left to right:

1. The state dot and the title.
2. The agent and its state, for example "Claude · idle 2m". For a Dispatch pane, the
   conversation's title.
3. The view switch (Terminal, Chat, Diff). Hidden while a pane has only one view, which is every
   pane in this project. Project 2 adds Chat and Diff.
4. The pull request mark, for example "#150 approved".
5. One main action when there is one: Merge when the pull request is approved and CI passed,
   Review when a review is waiting. Both call the actions that exist today.
6. ⋯ with everything else: Copy text, Open in its own tab, Split right, Split down, Move to its
   own tab, Close.

### The column drives the panes

- Clicking a session in the tree focuses its pane, or opens it in its worktree's tab.
- Clicking a worktree opens that tab, or an empty pane with today's start picker for that folder.
- `renderSide`, the folded-machine code and the page links inside `workspace.js` are removed in
  favour of `tree.js`.

### Deep links

- `/workspace?open=<machine>/<session>` focuses that session's pane, opening it in its
  worktree's tab if needed.
- `/workspace?folder=<machine>/<path>` opens that worktree's tab, or an empty pane with the start
  picker.
- If the session no longer exists, the worktree's tab opens with a note in the empty pane saying
  the session ended. The page never shows a blank pane.
- The query is removed from the address bar after it is handled, so a reload does not repeat it.

## 3. Phone (under 760px)

### Bottom tabs

The shell draws five bottom tabs in place of the rail: Sessions, Board, Pipelines, Dispatch,
More. More holds Diagrams, Proposals, Settings, theme and log out. Badges match the rail's. This
takes over the existing phone tab bar, so `test_phone_menu_is_a_bottom_tab_bar` is updated, not
deleted.

### Sessions

The home screen is the tree as a list:

- Machine headers with the memory figure ("devbox · 43%"). An offline machine stays as a dimmed
  header.
- Each row shows the dot, the worktree or session name, and one fact on the right, the first of:
  "needs you", a limit reset time, the pull request number, the age.
- Rows are at least 44px tall. Text stays 13px.
- A line above the list shows the Claude and Codex usage, standing in for the status strip.
- A search icon at the top opens the palette as a full-screen sheet.

### A session

Tapping a row opens it full screen:

- A top bar with ‹ back, the name and ⋯ (the same menu as the desktop pane, minus the split
  items).
- The view switch under it, hidden in this project as on desktop.
- The terminal.
- A pull request strip when there is one, for example "#150 approved · CI passed", with Merge and
  Review.
- The existing key row from `term.js`: esc, tab, arrows, enter, ctrl-c.

Back returns to the list. The phone never changes the saved desktop layout; it reads it only to
find a session's pane.

### Other pages

Board, Pipelines and Dispatch are their own pages, restyled in their own PRs. The Dispatch tab
opens the Dispatch page, as today.

## 4. Jump palette and status strip

### Palette

- Opened with Cmd-K on macOS and Ctrl-K elsewhere, or the search button in any page column.
- `term.js` treats that key as an app key, so it reaches the page and never the shell. Ctrl-J is
  left alone and still reaches the agent. On Linux, Ctrl-K no longer deletes to the end of the
  line inside Yardbell terminals.
- What Enter opens:

| Item | Destination |
|---|---|
| Session | `/workspace?open=…` |
| Worktree or folder | `/workspace?folder=…` |
| Pipeline | `/pipeline?p=<id>` |
| Run | `/pipeline?p=<id>&tab=runs&run=<id>` |
| Dispatch conversation | `/dispatch?c=…`, or the Dispatch pane on the Workspace |
| Page | the page |

- Sources: `/state`, `/api/pipelines`, `/api/runs`, `/dispatch/conversations`, and the fixed
  page list. Fetched when the palette opens and cached while it stays open.
- With no query, the order is: blocked sessions, runs waiting on an answer or approval, sessions
  changed since last looked, then the most recent items.
- A query matches names, folders, machines and pull request numbers (`#150`). Name matches rank
  first.
- Arrows move, Enter opens, Esc closes. Focus returns to where it was on close.
- A source that fails to load shows one quiet line ("Couldn't load runs") and the other sources
  still work.

### Status strip

One 22px line along the bottom of every page on desktop:

- **Usage:** Claude and Codex percentages with their reset times, from `/dispatch/usage`.
  Clicking it calls `/dispatch/usage/refresh`, replacing the usage card's refresh button.
- **Memory:** each machine's figure, amber at the existing `RATED` level, using the memory and
  limit maths from `nav.js`. A machine that is down shows "offline".
- **Connection, on the right:** "live" while the `live.js` socket is up, "reconnecting"
  otherwise. Pages keep their last data while reconnecting.
- **The bell's place** is held for project 2 and stays empty.

## 5. Order, errors and testing

### Pull requests

Each one is released on its own.

1. **Shell plus Workspace.** Tokens, `shell.js`, `tree.js`, the Workspace on the shell, Dispatch
   as a pane, the pane header, v4 to v5 storage, deep links, the palette, the strip, the phone
   Sessions list and full-screen session. Pages not yet moved keep their sidebar but pick up the
   new tokens.
2. **Dashboard.** The tree in the column, the session list or Board in the main area.
3. **Pipelines.** The column lists pipelines, with those that have waiting runs on top.
4. **Dispatch.** The column lists conversations. The page works the same embedded in a pane.
5. **Settings, Proposals, Diagrams and Add.** The old sidebar markup and `nav.js` are deleted.
6. **Phone polish** across all pages, `DESIGN.md`, README screenshots.

Update, 2026-11-11: the user asked for every page to match now. PR 1 also moves Dashboard,
Pipelines, Dispatch, Settings, Proposals, Diagrams and Add onto the shell and retires the old
sidebar (`docs/ui-redesign-pr1b-plan.md`). PRs 2 to 6 now cover only those pages' deeper
redesigns, such as Settings laid out as cards of rows and a richer Dispatch composer.

### Errors

- Partial data: the tree and palette show what they have; a machine that fails shows its reason.
- A broken saved layout falls back to fresh tabs.
- A deep link to a missing session opens its worktree with a note.
- A dropped socket shows "reconnecting" and keeps the last data.

### Tests

Each PR updates the browser tests in `tests/browser/run.py` for the selectors it changes, in the
same PR. New tests in PR 1:

- Dispatch opens as a pane, and is still there after a reload.
- A stored v4 layout, with and without the Dispatch panel showing, converts to v5.
- Cmd/Ctrl-K opens the palette, lists what needs you first, and Enter focuses the right pane.
- Ctrl-K with a terminal focused opens the palette, and Ctrl-J still reaches the session.
- `?open=` for a missing session shows the ended note.
- The status strip shows usage and memory.
- On a phone, Sessions opens a full-screen session and Back returns to the list.

Every PR also gets a screenshot pass in light and dark, at desktop and phone widths, in a dev
slot. Never against the live server on :4000.

## Out of scope

- Chat and Diff views, the notification bell and feed, session history, hibernation, Tasks,
  keep-awake: project 2.
- Push notifications, a relay and app packaging: project 3.
- A repo field in the snapshot, or grouping worktrees made outside Yardbell's naming under their
  repo.
- Changing what any existing action does.
