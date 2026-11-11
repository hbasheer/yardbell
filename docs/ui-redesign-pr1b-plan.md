# UI redesign PR 1, part 2: every page on the shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every other page (Add, Diagrams, Proposals, Dashboard, Pipelines, Dispatch, Settings) onto the shared shell the Workspace now uses, so the rail, column, status strip, palette, collapse and phone tabs are the same everywhere, then delete the old sidebar, `nav.js` and `side.js`.

**Architecture:** Each page's HTML keeps only its main area, wrapped as `<main class="shell-main" id="main">`, and loads `machines.js`, `shell.js`, `strip.js` and `palette.js` (and `tree.js` where its column shows the tree). Each page fills `YardbellShell.column` with its own list. The helpers pages still call on `YardbellNav` move onto `YardbellShell` first, so `nav.js` can go last.

**Tech Stack:** as in `docs/ui-redesign-pr1-plan.md`.

**Spec:** `docs/ui-redesign-design.md`. This plan carries out section 5's PRs 2 to 6 for the shell itself, inside PR 1, after the user asked for every page to match now. Deeper per-page redesigns are out of scope here (see the end).

## Global Constraints

Every constraint in `docs/ui-redesign-pr1-plan.md` applies, plus these:

- The Dispatch page embedded in a Workspace pane (`window.top !== window.self`) draws no shell. Only the standalone page gets the rail, column and strip.
- No page loses a feature or a link it has today. A page's old sidebar content either moves into its column, the strip or the rail, or is listed in the task as dropped, with the reason.
- `#col-search` opens the palette on every page.
- On phones every page shows `#tabbar` and no sideways scroll.

## Review Focus

- **The Dispatch page inside a Workspace pane** must not draw a second rail or strip. Test in Task 15.
- **Pages that call `YardbellNav.confirm`** (settings.js, dispatch.js, pipeline.js, proposals.js, diagrams.js) keep working after `nav.js` is deleted. Test in Task 12 and Task 17.
- **The Settings section nav** keeps highlighting the section in view after moving into the column. Test in Task 16.
- **The Dashboard machine filter** (`?machine=`) keeps working from the column. Test in Task 13.
- **A collapsed column** (`yardbell.side = "rail"`) applies on every page, with no flash. Test in Task 17.

---

### Task 12: Shell groundwork, then Add, Diagrams and Proposals

**Files:**
- Modify: `assets/shell.js`: move in `confirm` (nav.js `ask`), `appKey`, `tabKey`, `checkBuild`; add a no-column mode.
- Modify: `assets/nav.js`: delegate those four to `YardbellShell` when it is loaded, so pages not yet moved keep working.
- Modify: `assets/add.html`, `assets/diagrams.html`, `assets/proposals.html`, and their scripts as needed.
- Modify: `assets/style.css`.
- Test: `tests/browser/run.py`, `src/web/tests.rs`.

**Interfaces:**
- Produces:
  - `YardbellShell.confirm(title, body, { confirm, danger }) -> Promise<boolean>`
  - `YardbellShell.appKey(e)`, `YardbellShell.tabKey(e)`
  - `YardbellShell.checkBuild(res)`

  All four behave exactly as the nav.js versions do today, which you move, not copy.
- Produces the no-column mode: `<body data-column="none">` makes the shell skip the column (rail, main and strip only) and hide `#col-toggle`.
- Columns:
  - **Add:** no column (`data-column="none"`), since it has no list.
  - **Diagrams:** one row per machine, linking to that machine's section on the page (anchors), using the same dot and offline wording as the tree's machine headers.
  - **Proposals:** two rows, "Waiting" and "Decided", with counts. Each filters or scrolls the page the way the page's own sections are grouped today. If the page has no such grouping, list the proposals' titles linking to their cards. Say which in the report.
- Each moved page drops its `.side` markup and the `side.js` and `nav.js` script tags, and switches `Nav.confirm` and `Nav.refresh` to `YardbellShell.confirm` and its own reload.

- [ ] **Step 1: Write the failing browser test** `test_every_moved_page_uses_the_shell`. For `/add`, `/diagrams` and `/proposals` at 1280x800:
  - `#rail .rail-link` titles equal the Workspace's.
  - `.side` is absent.
  - `#strip` is shown.
  - `#col-search` opens `#palette`.
  - `/add` has no `#col`.
  - At 390x844 each shows `#tabbar` and has no sideways scroll.
- [ ] **Step 2: Write the failing test** `test_shell_confirm_replaces_nav_confirm`. On `/diagrams`, `YardbellShell.confirm("T", "B", { confirm: "Go" })` opens the confirm dialog with those strings, and Cancel resolves false.
- [ ] **Step 3: Run** both and see them fail.
- [ ] **Step 4: Implement.** Update existing tests for these three pages that read `.side`, `.side-foot`, `#nav-machines` or `.side-link` (`grep -n` them).
- [ ] **Step 5: Add the Rust checks** that the three pages load `/shell.js` after `/live.js` and `/machines.js` and no longer load `/nav.js`.
- [ ] **Step 6: Run** the new tests, then `-k diagrams`, `-k proposals`, `-k add`, `-k phone`, `cargo test`, fmt, clippy, then the full suite once.
- [ ] **Step 7: Commit** "Add, Diagrams and Proposals on the shared shell".

### Task 13: Dashboard on the shell

**Files:** `assets/dashboard.html`, `assets/dashboard.js`, `assets/tree.js`, `assets/style.css`, tests.

**Interfaces:**
- Consumes: `YardbellTree.render` and the shell.
- Produces a `tree.js` option `onMachine(name)`. When it is given, the machine header's name is its own button that calls it, and it is marked `aria-current="true"` when `selected.machine` matches. The chevron still folds. Without the option, the header is unchanged.
- The Dashboard column shows the tree:
  - A session row goes to `/workspace?open=<key>`.
  - A folder row goes to `/workspace?folder=<machine>/<label>`.
  - A machine name sets the existing `?machine=` filter (the same code path the old sidebar items used).
  - An "All machines" row above the tree clears the filter.
- The usage card and the machine list leave the old sidebar. Usage is in the strip, machines are in the tree.
- The main area (sessions, Board, filters, keyboard hints) is unchanged.

- [ ] **Step 1: Write the failing test** `test_dashboard_column_filters_by_machine`:
  - `/` shows the tree in `#col-body`.
  - Clicking the `hp` machine name sets `?machine=hp` and marks it current.
  - "All machines" clears it.
  - Clicking a session row lands on `/workspace` with that session's pane focused.
- [ ] **Step 2: Run** and see it fail. **Step 3: Implement.** Update the dashboard tests that read the old sidebar.
- [ ] **Step 4: Run** `-k dashboard`, `-k board`, `-k tree`, `-k phone`, `cargo test`, then the full suite once.
- [ ] **Step 5: Commit** "Dashboard on the shared shell".

### Task 14: Pipelines on the shell

**Files:** `assets/pipeline.html`, `assets/pipeline.js`, `assets/style.css`, tests.

**Interfaces:**
- The column lists pipelines from `/api/pipelines`.
  - Each row shows the name, plus a count of waiting runs when it is more than 0.
  - Order: pipelines with waiting runs first, then by name.
  - A row links to `/pipeline?p=<id>`, using pipeline.js's own navigation (`go()`) so the page does not reload, and is `aria-current` for the open pipeline.
  - A "New pipeline" icon button sits in the column head and does what the page's New pipeline button does.
- The full-screen canvas (builder) still gets the whole main area. When the builder is open, the column may collapse automatically. If it does, say so in the report.
- `pipeline.js`'s `Nav.confirm` uses `YardbellShell.confirm`.

- [ ] **Step 1: Write the failing test** `test_pipelines_column_lists_waiting_first`. With the suite's seeded pipelines and a waiting run:
  - The first column row is the pipeline with the waiting run, and shows its count.
  - Clicking a row opens it and marks it current without a page load (check `performance.getEntriesByType("navigation").length` stays the same, or that a window marker set before the click survives).
- [ ] **Step 2: Run, fail, implement.** Update pipeline tests that read the old sidebar.
- [ ] **Step 3: Run** `-k pipeline`, `-k builder`, `-k run`, `-k phone`, `cargo test`, then the full suite once.
- [ ] **Step 4: Commit** "Pipelines on the shared shell".

### Task 15: Dispatch on the shell

**Files:** `assets/dispatch.html`, `assets/dispatch.js`, `assets/style.css`, tests.

**Interfaces:**
- Standalone (`window.top === window.self`):
  - The page draws the shell.
  - The column lists conversations from `/dispatch/conversations`, newest first. Each row shows the title, a dot (amber when `waiting > 0`, green when `busy`), and the age.
  - Clicking a row opens that conversation the way the page's own Chats list does, with no reload. The open conversation is `aria-current`.
  - A "New chat" icon button sits in the column head.
  - The page's internal Chats tab may stay. If the column makes it redundant on the standalone page, hide it there and keep it embedded. Say which in the report.
- Embedded (`window.top !== window.self`): no shell, unchanged from today. Do not load `shell.js` behaviour there: either guard at the top of `shell.js` (`if (window.top !== window.self && document.body.dataset.page === "dispatch") return;`) or skip it in the page. Pick one and test it.
- `Nav.confirm` and `Nav.loadUsage` switch to `YardbellShell.confirm` and `YardbellStrip.loadUsage`.

- [ ] **Step 1: Write the failing test** `test_dispatch_page_column_lists_conversations`. Standalone `/dispatch` shows the saved conversations in `#col-body`, and clicking one opens it with `?c=` in the URL and no reload.
- [ ] **Step 2: Write the failing test** `test_embedded_dispatch_draws_no_shell`. In a Workspace Dispatch pane, the iframe document has no `#rail`, `#strip` or `#tabbar`.
- [ ] **Step 3: Run, fail, implement.** Update dispatch tests that read the old sidebar. Never send a Dispatch message in any test.
- [ ] **Step 4: Run** `-k dispatch`, `-k workspace`, `-k phone`, `cargo test`, then the full suite once.
- [ ] **Step 5: Commit** "Dispatch on the shared shell".

### Task 16: Settings on the shell

**Files:** `assets/settings.html`, `assets/settings.js`, `assets/style.css`, tests.

**Interfaces:**
- The Settings section nav (`nav.settings-nav`, its group labels and links) moves into the column, keeping the class `settings-nav` and its markup. `settings.js` code that queries `.settings-nav a` (around lines 2531-2539) keeps working, and the link for the section in view stays `aria-current`.
- The page's `.settings-layout` drops its inner nav column, so the sections take the main area's width up to the page's existing max width.
- The "Dashboard" back link at the top of Settings goes, since the rail replaces it.
- Every `Nav.confirm` switches to `YardbellShell.confirm`.

- [ ] **Step 1: Write the failing test** `test_settings_nav_lives_in_the_column`:
  - `#col-body .settings-nav a[href="#machines"]` exists.
  - Scrolling `#about` into view makes the About link `aria-current`.
  - Clicking "Voice" scrolls to `#voice`.
- [ ] **Step 2: Run, fail, implement.** Update settings tests that read the old sidebar or the inner nav.
- [ ] **Step 3: Run** `-k settings`, `-k connection`, `-k mcp`, `-k phone`, `cargo test`, then the full suite once.
- [ ] **Step 4: Commit** "Settings on the shared shell".

### Task 17: Retire the old sidebar, and a phone pass

**Files:**
- Delete: `assets/nav.js`, `assets/side.js`, their routes in `src/web/mod.rs`, and the Rust tests that only check them (update the ones that check script order).
- Modify: `assets/style.css`: remove every `.side*`, `.nav-*`, `.usage-card` and `.side-rail` rule nothing uses. Check with grep before deleting each one.
- Modify: any page or test still mentioning the removed pieces.
- Test: `tests/browser/run.py`.

**Rules:**
- `grep -rn "YardbellNav\|YardbellSide\|side-foot\|nav-machines\|side-rail\|/nav.js\|/side.js" assets src tests` returns nothing at the end.
- The collapsed column (`yardbell.side = "rail"`) is applied by `shell.js` before first paint on every page.

- [ ] **Step 1: Write the failing test** `test_every_page_shares_one_shell`. For every page in `["/", "/workspace", "/pipeline", "/dispatch", "/proposals", "/diagrams", "/settings", "/add"]`:
  - At 1280x800: the same rail titles, `#strip` shown, `#col-search` opens the palette, and the collapsed state from `yardbell.side` applies on load.
  - At 390x844: `#tabbar` with Sessions, Board, Pipelines, Dispatch, More, and no sideways scroll.
- [ ] **Step 2: Run, fail, implement.** Fold the old per-page sidebar tests into this one or delete them, listing each deleted test and why in the report.
- [ ] **Step 3: Run** `cargo test`, fmt, clippy and the full browser suite. Re-run any failure alone with `-k` before calling it real.
- [ ] **Step 4: Commit** "Retire the old sidebar".

## Out of scope (follow-up PRs)

- Settings laid out as cards: a searchable section list, a title and description per section, and grouped rows of label, description and control.
- A rich Dispatch composer (Tiptap-style editing with Markdown, code blocks and pasted images).
- Pipelines and Dispatch main-area redesigns, the notification bell, Chat and Diff views (project 2).
