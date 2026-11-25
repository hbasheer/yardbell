# Orca-style UI for Yardbell

Status: approved 2026-11-25, revised the same day after main reached 0.11.104. Work runs on branch `ui-foundation`.

Sources read: Orca at `~/Projects/orca` (commit `0cd805faaa5`, cloned 2026-11-25) and Yardbell at
branch `orca-style-ui` (from `d4effb4`).

## 1. Licenses

| What | License | Terms for Yardbell |
|---|---|---|
| Orca source (UI code, `main.css`, components, editor setup) | MIT, "Copyright (c) 2026 Lovecast Inc." | Copy and change freely. Keep the copyright and permission notice with any substantial copied portion. |
| shadcn/ui primitives (Orca's `components/ui/`) | MIT (shadcn) | Same: keep the notice. |
| Radix UI, Tailwind CSS, tw-animate-css, tailwind-merge, clsx, cmdk, sonner | MIT | Notice. |
| class-variance-authority | Apache-2.0 | Notice. Apache-2.0 adds a patent grant and asks you to keep any NOTICE file. |
| lucide-react (all of Orca's icons) | ISC | Notice. ISC works the same way as MIT. |
| monaco-editor, @monaco-editor/react, vscode-oniguruma, shiki | MIT | Notice. |
| TipTap (`@tiptap/*`), lowlight | MIT | Notice. |
| highlight.js, diff (jsdiff) | BSD-3-Clause | Notice, and don't use their authors' names to promote Yardbell. |
| @xterm/xterm and addons | MIT | Notice (Yardbell already uses xterm). |
| DOMPurify | MPL-2.0 or Apache-2.0, your choice | Pick Apache-2.0 and treat it like the others. |
| @sanity/diff-match-patch, pdfjs-dist | Apache-2.0 | Notice. |
| Geist font | SIL Open Font License 1.1 | Bundling is fine. Ship the OFL text with it. Don't sell the font by itself, and don't keep the name "Geist" if you modify the font files. |
| Symbols Nerd Font | SIL OFL 1.1 (Orca includes the OFL text) | Same as Geist. |
| VS Code default themes, GitHub VS Code theme (bundled as Orca plugins) | MIT (Microsoft, Primer) | Notice. |

**Allowed.** Everything above is permissive. Yardbell can copy Orca's UI code, styles, icons and
editor setup and keep its own MIT license. It does not have to adopt another license.

**Required:**
- Add `THIRD_PARTY_NOTICES.md` (plus a `licenses/` folder with the full texts) listing Orca's MIT
  notice, shadcn's MIT notice, the Apache-2.0 packages, the BSD-3 packages, and the OFL text for each
  bundled font. Link it from the About page (`src/about.rs` already exists).
- Put a one-line provenance header in any file copied mostly as-is from Orca, for example
  `// Adapted from Orca (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md`. The project's no-comment
  rule doesn't apply here, because the license requires the notice.

**Not covered by the license, so don't copy:**
- The Orca name, logo and app icons (`resources/icon*.png`, `resources/app-icons/*`,
  `resources/logo.svg`), and the bot avatar artwork. MIT grants copyright permission, not trademark
  rights. Yardbell keeps its own name and wordmark, and the UI must not look like Orca's branding.
- Notification sounds (`resources/notification-sounds/*.mp3`). No license or source is recorded for
  them in the repository.
- Docs media (`docs/assets/*`, `docs/site/public/*`): marketing gifs and screenshots.
- Third-party agent logos in `resources/` (Claude, opencode and others): each belongs to its own
  company.

## 2. Orca's UI

### Stack
Electron, React 19, TypeScript, Vite (`electron-vite`), Tailwind CSS v4 (`@import 'tailwindcss'`,
`@theme inline`), shadcn/ui "new-york-v4" primitives built on Radix, `lucide-react` icons, `zustand`
store, `cmdk` command palette, `sonner` toasts, `@tanstack/react-virtual` for long lists, xterm.js
with the WebGL renderer for terminals.

### Layout shell (`src/renderer/src/app-shell/AppWorkspaceShell.tsx`)
From left to right:
1. **App rail** (`components/app-rail/`): a narrow column of icon buttons for the main destinations
   (Tasks, Automations, Artifacts, Skills, Mobile), with a "More" overflow menu and roving keyboard
   focus.
2. **Worktree sidebar** (`components/sidebar/`): projects, then worktree cards, each showing branch,
   agent status (working, question, done), PR and CI chips, and unread dot. Sections fold, rows drag,
   and the sidebar resizes. A bots split can sit above the list.
3. **Main column:** a 36px titlebar strip (`--app-header-height`), a 32px tab row
   (`--workspace-tab-row-height`), then the terminal workbench or an editor, with splits and drag
   dividers (`components/pane-resize/`).
4. **Right sidebar** (`components/right-sidebar/`): an activity bar switching between File explorer,
   Source control, Checks, Hosted review, Ports and plugin panels.

Full pages (Settings, Tasks, Automations, Activity) replace the main column. They do not open in a
new window.

### Theme tokens (`src/renderer/src/assets/main.css`, rules in `docs/STYLEGUIDE.md`)
- Identity: monochrome and quiet. Neutral greys carry the chrome. Colour only for state (focus ring,
  destructive, git decorations, agent working or question).
- Light: background `#fff`, foreground `#0a0a0a`, primary `#171717`, secondary, muted and accent
  `#f5f5f5`, muted-foreground `#696969`, border and input `#e5e5e5`, ring `#a1a1a1`, worktree sidebar
  `#f5f5f5` with accent `#eaeaea`.
- Dark: background `#0a0a0a`, card and popover `#171717`, foreground `#f0f0f0`, secondary and muted
  `#262626`, accent `#404040`, muted-foreground `#acacac`, border `rgb(255 255 255 / .07)`, input
  `rgb(255 255 255 / .15)`, editor surface `#1e1e1e`, worktree sidebar `#2a2a2a`.
- State: agent-working yellow-500, agent-question orange-600 (orange-500 dark), unread blue-500,
  status success `#16a34a`, workspace progress `#d4a300`.
- Type: Geist variable font for sans, a system mono stack (SF Mono, Cascadia Code, Menlo, Consolas),
  14px body, 13px sidebar and dense rows, 12px sub-text, `text-2xs` 11px, `text-3xs` 10px, category
  labels 11px semibold uppercase with 0.05em tracking, Settings headings 15px and help text 12.5px.
- Radius: `--radius: 0.625rem`. The scale runs from sm (0.6x) to 4xl (2.6x). Buttons and inputs use
  `rounded-md`, cards `rounded-xl`, badges `rounded-full`.
- Elevation: three levels only. Hairline border, `shadow-xs` with a border, and `shadow-floating`
  (`0 10px 24px rgb(0 0 0 / .18)`) for popovers. Toasts use a "notice" surface.
- Rules worth keeping: one primary button per flow; Cancel and Close are quiet ghosts; tooltips only
  name controls; lucide icons at `size-4`; fold chevrons sit before section titles; loading feedback
  matched to duration (none under 100ms, spinner after 1s).

### Editor
- **Monaco** (`monaco-editor` 0.55 through `@monaco-editor/react`) for code files and diffs. Setup is
  in `src/renderer/src/lib/editor/monaco/monaco-setup.ts`: local ESM workers for editor, JSON, CSS,
  HTML and TS, TS diagnostics turned off (it can't resolve project imports), JSX preserved, extra
  Monarch languages (Vue, Svelte, Astro, Zig, Swift, dotenv and more), and guards for diff disposal
  and tokenization. Per editor (`components/editor/monaco/MonacoEditor.tsx`): line numbers on,
  `renderLineHighlight: 'line'`, `scrollBeyondLastLine: false`, `automaticLayout`, `tabSize: 2`,
  smooth scrolling, minimap per setting, typography from settings, themes derived from VS Code theme
  JSON (`lib/editor/appearance/use-monaco-theme.ts`).
- **TipTap** (ProseMirror) for rich Markdown editing (`components/editor/rich-markdown/`) with tables,
  code blocks (lowlight), images, math (KaTeX) and Mermaid.

## 3. Yardbell's current frontend (main at 0.11.104)

- One Rust binary (axum). `rust-embed` serves `assets/`; a debug build reads `assets/` from disk, so
  frontend edits show on reload without rebuilding.
- About 28,000 lines of plain HTML, CSS and JavaScript, no build step.
- **0.11.0 already moved the UI towards Orca:** Orca's neutral palette and Geist, one shared shell
  (sidebar with search, pages, machine and project groups, usage card, rail mode, phone tab bar), a
  jump palette, Workspace tabs and split panes, and a right panel with Files (read-only), History
  and Changes (diff tabs, line notes sent to the agent, a commit box).

### Stack decision (revised)

Stay on the current stack. The earlier recommendation (rewrite the frontend in React) assumed the
pre-0.11 UI. The shell and tokens already match Orca, so a rewrite would cost months for little
visible change. The gaps left are components and the editor, and both can be added without a
build step:
- **Monaco** vendored from the `monaco-editor` npm package's prebuilt `min/vs` files into
  `assets/vendor/monaco/` (MIT), loaded with its own AMD loader, workers served same-origin.
- Orca's component specs (rows, tabs, menus, tooltips, dialogs) copied as CSS values from
  `main.css` and the shadcn primitives, with attribution.

Revisit React only if a feature can't be built well without it.

## 4. The six features

### 4.1 Design Mode
**Orca:** an embedded Electron browser with a toolbar toggle. Hovering highlights elements. A click
captures the element's HTML (and some surrounding markup), computed CSS, a cropped screenshot, and
the source file and line when a dev source map has them. It sends that as one attachment to the
active agent, and you type what to change.

**Yardbell has:** forwarded app ports per session (`src/tunnels.rs`), with links on the dashboard.
There is no in-app browser.

**Yardbell's version:** a **Preview** tab in the Workspace that shows a session's forwarded app port.
It has an address bar, reload, a device-width toggle and a Design Mode toggle. A pick captures the
same things Orca captures and is offered three ways: **Send to session** (writes the capture to
`.yardbell/picks/<id>.md` plus a PNG in the session's worktree over ssh, then types one short line
into the tmux pane pointing at it), **Send to Dispatch** (as an attachment, reusing
`assets/attachments.js` and `src/dispatch/attachments.rs`), and **Copy**.

**Where Yardbell differs:**
- A browser page can't inspect a cross-origin iframe, and Yardbell can't run Electron. Yardbell
  serves the preview through its own proxy that injects a small picker script, and the picker talks
  to the parent page with `postMessage`.
- **Security:** the proxied app must never share Yardbell's origin, or its scripts could call
  Yardbell's API with the user's cookie. The proxy listens on a separate port (one per preview, or
  one port with a per-preview subdomain), checks a short-lived token, and never forwards Yardbell's
  cookie.
- Agents in Yardbell are terminal CLIs on other machines, so a pick becomes a file in the worktree
  rather than a chat attachment.
- Desktop and tablet only. On a phone, the Preview tab opens without Design Mode.

### 4.2 GitHub and Linear, native
**Orca:** a Tasks drawer and page combining GitHub, GitLab, Linear and Jira issues, with list or
board, group-by and filters saved per workspace. You can edit status, assignee, priority and labels;
create issues; start a workspace from an issue (with Linear's suggested branch name); link an issue
to a worktree; and pass issue images to the agent. A PR view shows checks, job logs, threads,
reactions, merge and auto-merge, and **Fix broken checks** hands the failure to an agent.

**Yardbell has:** credentials already (`linear` secret, GitHub through local `gh` or a token, GitLab
tokens), PR and MR badges with CI per session (`src/pulls/`), Dispatch cards for CI failures and
review comments, triggers on Linear tickets and GitHub assignments (`src/triggers/feeds.rs`), the
pipeline's Linear client (`src/pipeline/linear.rs`), and connectors (Jira, Trello, Asana).

**Yardbell's version:** a **Tasks** page and a right-sidebar **Pull request** panel.
- Tasks lists Linear, GitHub and GitLab issues (Jira through the existing connector later), with
  filters, list or board, and an issue detail sheet for status, assignee and labels.
- **Start session** on an issue opens Yardbell's existing New session flow, pre-filled: the
  suggested machine (the most free memory, as Dispatch picks today), the folder whose remote matches
  the repo, Linear's `branchName` or a slug, the agent, and a task built from the issue body and
  images. **Run pipeline** starts a pipeline on it. **Ask Dispatch** opens a conversation about it.
- The issue's link is stored with the session and worktree and shows on its sidebar card.
- The PR panel on a session shows checks with failing job logs, review threads, and **Send to
  session** for a failing check or a comment. It reuses the text the Dispatch cards already build.

**Where Yardbell differs:** pick a machine as well as a folder; no new sign-in flow (the existing
credentials and the Settings Connections section, per the "settings in the UI" rule); GitLab gets
the same treatment as GitHub; writes (status changes, comments) go through Yardbell's existing
approval rules when Dispatch makes them, and are direct when you click them.

### 4.3 Review AI output
**Orca:** a Monaco diff of the worktree. Hover a line, press **+** or `c`, and write a Markdown note.
Notes stay attached to their line as the diff changes. **Send to agent** batches every unresolved
note into one prompt and lets you pick an agent (or start one). Notes can be resolved and stay to
check the fix.

**Yardbell has:** **Review branch** (a read-only reviewer session whose findings return as a review
card with a verdict, tied to the commit and an uncommitted-changes hash, never reviewing the same
code twice), and diff and evidence endpoints (`src/web/review_api.rs`, `src/dispatch/review/`,
`assets/dispatch-review.js`).

**Yardbell's version:** a **Changes** tab per session. It shows a Monaco diff against the branch's
base, read on the session's machine. You can add line notes, and the reviewer's findings appear as
notes in the same diff (marked as from the reviewer), so AI and human review share one place. **Send
notes** batches the unresolved notes into one prompt and delivers it to the session, to a new
session, or to the pipeline's Fix step. Long prompts go by tmux paste-buffer (`src/sessions.rs:303`).
Notes are stored on the host per worktree and anchored to commit, file and line, then re-anchored by
content when the code moves.

**Where Yardbell differs:** the diff runs on a remote machine over ssh; notes live on the host, so
they survive a machine reboot and show on a phone (read and resolve there, write on desktop); the
reviewer agent's findings and your own notes merge in one view.

### 4.4 Orchestrate agents

> Revised: steps 4.4 and 4.5 are now one Dispatch track (section 5, track D).

**Orca:** a coordinator agent uses the `orca orchestration` CLI. A **Run** has **Tasks** (with
dependencies), a **Dispatch** is one attempt of a task on a terminal, and workers report `worker_done`
and `ask` questions by mail. Decision gates block a task until answered. Workers can start on other
machines. The coordinator is woken when mail arrives.

**Yardbell has:** Dispatch groups (`start_group`: several sessions as one card with per-child rules
and a Results card), pipelines, and Yardbell's MCP server with tools such as `start_session`,
`send_to_session`, `read_session`, `integrate_branches` and `push_branch` (`src/mcp.rs`,
`src/mcp_change.rs`).

**Yardbell's version:** any agent session can become a **coordinator** through new MCP tools on
Yardbell's existing server: `run_create`, `task_create`, `worker_start` (machine, folder, new
worktree or current, agent), `check` (read mail), `send`, `ask` (for workers), `gate_create` and
`gate_resolve`, `worker_done`. In the UI, a **Run** view shows the coordinator and its workers as a
tree in the sidebar and as a board (task, worker, machine, state, last message). Questions and gates
appear as cards you can answer, and **Open** jumps to any worker's terminal.

**Where Yardbell differs:**
- Placement: `worker_start` without a machine uses Dispatch's existing choice (free memory, load,
  running agents), which is Yardbell's strength.
- Every `worker_start` goes through Dispatch rules (allow, ask, deny), so a coordinator can't start
  ten sessions on a machine you've reserved.
- Wake-ups: Yardbell types a one-line "mail waiting, call check" into the coordinator's tmux pane only
  when it's idle. The mail itself is read through `check`, never typed.
- Reuse the group machinery (`src/dispatch/group.rs`) for worker state and the result block rather
  than building a second tracker.

### 4.5 Bots (Yardbell's version of Orca Bots)
**Orca:** a bot is a named teammate with an avatar, a "soul" (instructions), a memory folder (with a
nightly tidy-up), automations (schedules), its own MCP tools, and connectors. People ask it from
Slack, Linear or GitHub, and it runs your own Claude Code or Codex, starts workers, and returns a
tested PR. Those three connectors go through **Orca's hosted connector service**, which is not open
source.

**Yardbell has:** Dispatch (one assistant with instructions, memory, rules and approval cards),
triggers (schedules, Linear tickets, GitHub assignments and review requests), connector webhooks,
groups, pipelines and phone notifications.

**Yardbell's version:** **Bots** are named Dispatch personas. Each has a name and avatar (initials
or an uploaded picture), its own instructions and memory file (`dispatch/bots/<id>/memory.md`, same
format and caps as today), its own rules on top of the global ones, its own triggers, and a default
machine or folder. A bot is reached by:
- a mention in a Linear comment or a GitHub issue or PR comment (`@yardbell-<name>`), picked up by
  polling with the credentials Yardbell already has (the same loop triggers use);
- a webhook, for servers that can be reached from the internet (the existing webhook path);
- Yardbell's own UI and phone.

It replies in the same place: a comment with a status, then the PR link and summary when its session
or group finishes.

**Where Yardbell differs:** self-hosted, with no relay or hosted connector. Polling is the default,
because a server on a mesh VPN can't receive webhooks. Every action still goes through approval
cards and rules, so a stranger's comment can only propose work. Only bots set to "allow" act alone.
Slack stays out of the first version (it would need a Slack app in Socket Mode). The memory tidy-up
can come later as a trigger template.

### 4.6 Text and code editor
**Orca:** Monaco for code and diffs, TipTap for rich Markdown, VS Code themes, and a file explorer in
the right sidebar.

**Yardbell has:** no editor. Prompts and instructions are textareas, and Settings and Dispatch cards
edit JSON in a textarea.

**Yardbell's version:**
- Monaco (set up as Orca does, see section 2) used for: a **Files** panel in the right sidebar that
  browses and edits files in a session's worktree on its machine; the diff in 4.3; and every JSON,
  YAML and prompt field (Settings JSON edit, Dispatch card **Edit**, pipeline step prompts, the
  worktree setup command).
- TipTap for Markdown: Dispatch instructions and memory, bot instructions, and `.md` files in Files
  (with a source and rich toggle).

**Where Yardbell differs:** files live on remote machines. A host file API
(`list`, `read`, `write`) works over ssh with the checks `valid_review_path` already does: stays
inside the worktree, no symlink escape, a size cap (2 MB by default), and binary detection. A save
sends the hash it read and is refused if the file changed since (no silent overwrite of an agent's
edit). Writes are switched off from the phone by default.

## 5. Work order

UI first, then the phone, then Dispatch and pipelines. Each item is one PR from its own branch.

### Track U: UI (now)
- **U1. Shell polish to Orca's specs.** Sidebar rows, tab bar, pane titles, menus, tooltips,
  dialogs and buttons measured against Orca's `main.css` and `components/ui/` and matched. Files:
  `assets/style.css`, small markup changes in `assets/*.html`. Test: browser screenshots light,
  dark, phone; `cargo test`.
- **U2. Monaco editor.** Vendor Monaco; a small `assets/editor.js` wrapper (theme from the tokens,
  Orca's options); Files opens files in Monaco and can save (host API with path, symlink, size and
  hash checks); Changes diff tabs use Monaco's diff editor with the existing line notes as view
  zones. Files: `assets/vendor/monaco/`, `assets/editor.js`, `assets/workspace-side.js`,
  `assets/workspace-changes.js`, `src/web/` files API. Test: `cargo test` for path traversal,
  symlinks, size cap, hash conflict; browser run opening, editing and saving a file.
- **U3. Tasks page** (feature 4.2): Linear, GitHub and GitLab issues, Start session pre-filled.
- **U4. Design Mode** (feature 4.1): Preview tab through a proxy on its own port.
- **U5. Licence notices:** `THIRD_PARTY_NOTICES.md`, `licenses/`, linked from About.

### Track M: phone (after U)
Phone home screen (sessions across machines, Needs you first), chat view of a session from its
transcript, Quick Commands (renamed Recipes, see D3), commit from the phone, Start session from an
issue. All as phone layouts of the server's pages; no native app.

### Track D: Dispatch and pipelines (after M)
- **D1. Report and ask tools.** Every session Yardbell starts (pipeline step, group child, worker)
  gets Yardbell MCP tools `report_step(status, summary, details)` and `ask(question)`. The
  `YARDBELL RESULT` block stays as a fallback. Evidence: in the three real runs on hp, implement
  passed with an empty report 3 of 3 times, qa 2 of 3.
- **D2. Run file and fact checks.** One `run.md` per run that each step reads; Yardbell records
  commits, files changed and command exit codes, and a step can require them to pass. A step with
  no report shows a warning; the record keeps who pressed Continue.
- **D3. Tasks as work items, saved prompts become Recipes.** To do, Working, Needs you, In review,
  Done; linked to issue, sessions, branch, PR, run.
- **D4. Dispatch looks before acting:** read-only file, search and git tools on the machines.
- **D5. Plan cards:** approve a multi-step plan once; push, stop, settings and memory still ask.
- **D6. Bots:** several named Dispatches with their own instructions, memory, rules and triggers,
  reachable by @mention in Linear and GitHub (polling).
- **D7. Default pipeline template:** Implement, Review (read-only), Fix loop, Open MR and report,
  with tests as a command step.

## 6. Checks for every PR
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`,
`python3 tests/browser/run.py --shots browser-shots`, light and dark, phone width, and a look on the
dev server (`ui-foundation` worktree, port 4110).

## 7. Status (kept current; read this before starting any session on this branch)

The frontend moved to React in `web/` (Vite, React 19, Tailwind v4, Radix), page by page. The
stack decision in section 3 is superseded: the user chose React on 2026-11-25.

### Done on `ui-foundation` (not committed yet)
- Shell: sidebar with Orca's nav, a "Sessions" section where **machines are the top parent**, then
  projects, then worktree cards and agent rows; session options (group by Machine or Status, sort,
  machine filter, filters, compact cards); resizable; Add project dialog.
- Status bar: usage chips with their own panel (works on every page), keep awake, resources,
  ports, machines, right-click to choose segments.
- Workspace: tabs and splits, New session (Orca's form, agent then model then effort, live model
  list from Claude Code), New terminal with a machine picker, browser tab (toolbar, history,
  new-tab page, zoom, viewport sizes).
- Right panel: Explorer, Agents (past sessions), Source Control (stage, unstage, discard, commit
  staged or all, commit and push, pull, fetch), Checks, Ports.

### Still to do in Track U
- [x] **Pipelines in React** (`web/src/pipelines/`): list, Waiting for me, Settings, runs with
      run detail, answers, overrides, transcripts and live terminals, the builder (library, canvas,
      inspector, every step and trigger form, undo, Tidy, save problems), History, Dispatch
      proposals. Still on the old page: the phone "Add step" sheet.
- [x] **Diagrams in React:** list per machine, Archify install, the New diagram form (from code or
      from an idea, with the New session form's pickers), Build from this, and the viewer inside the
      app with no outside link.
- [x] **Settings frame in React:** its own sidebar (Back to app, search, grouped sections). Appearance
      (theme, terminal theme, interface size, reduce motion, workspace and sidebar, status bar),
      Power, Security, About and Integrations (GitHub, GitLab, Linear, connected tools with sign-in,
      pull request settings, folders, secrets) are native.
- [x] **Every Settings section in React:** Notifications, Connect a phone, Machines, Mesh VPN,
      Dispatch with its rules and memory, Stats & Usage, Voice, Triggers, Worktree setup, Diagrams,
      Health checks and Let agents use Yardbell, with the Saved bar's Undo and Restart.
- [ ] **Settings leftovers:** connections with a token still open the old editor in a dialog; an MCP
      server cannot be edited yet (only tested, signed in or out and removed); moving values typed
      into yardbell.yml into secrets is not offered yet.
- [x] **Dispatch in React** (`web/src/dispatch/`): Chats and Tasks lists (task form, history, restore,
      delete, clear all), the conversation with replies, tool chips, session cards, trigger header,
      tracked sessions, read aloud, and the message box laid out as Orca's chat composer (@ and /
      menus, attachments by button, paste and drop, drafts per conversation, sent history, send key,
      scan, model picker, dictation, stop).
- [ ] **Dispatch cards still from the old code:** approval, review, pull request, group and results
      cards, the scan dialog and menu, task history, dictation and Insights run their old modules
      inside the React page, with the old stylesheet narrowed to them. Port each to React.
- [ ] **Dispatch on a phone:** the Chats and Tasks lists are hidden below the md width.
- [x] **Dashboard in React:** machine groups with memory and disk, session rows with Open, Merge and a menu (new window, terminal app, Review, Insights, Move, Remove worktree, Copy name, Stop), outside-tmux and ended lists, banners, machine chips, status and view toggles, search, Filter by project and pull request with chips, and a Board of lanes whose cards open a terminal preview. Move, Remove worktree and Setup are React dialogs.
- [x] **Insights in React:** status, facts, time spent with a bar and stat cards, a timeline rail, terminal end, scrollback and task; Suggest a better prompt hands over to the React Dispatch page.
- [x] **Dispatch composer on TipTap:** @ and / picks become pills, menu above the box, attachment previews, attach, approval picker, more menu, model picker, mic and round Send or Stop.
- [x] **Dispatch lists in a right sidebar:** Chats and Saved tasks tabs with search and New, the open chat's sessions nested under it, and a hide button.
- [x] **Settings round 2:** Machines as host rows with a React Add machine dialog (every onboarding step); Integrations with Review and Task providers, per-machine gh rows and a Linear account check (`/api/settings/linear/check`); Voice grouped as Orca's with a microphone test, spoken replies removed; new Terminal and Browser pages; Appearance regrouped; desktop notifications with sound per device.
- [ ] **Logo drafts:** Codex could not run inside the sandbox; brief saved for a manual run.
- [ ] **Dispatch in the main sidebar:** Orca lists bots and their open chats as a section of the main sidebar; ours does not yet.
- [ ] **Chat view** of a session from its transcript.
- [ ] **Agent rows:** task title and "22m ago" need the server to send them.
- [ ] **Checks:** every check with its time, not only the failed names (server change).
- [ ] **U3 Tasks page** (Linear, GitHub, GitLab issues; Start session pre-filled).
- [ ] **U4 Design Mode / Annotate** in the browser tab: needs Yardbell to serve app ports through
      its own proxy so it can inject the element picker.
- [ ] **U5 Licence notices:** `THIRD_PARTY_NOTICES.md`, `licenses/`, link from About.
- [ ] **Production build:** serve `web/dist` from the binary; until then only the Vite dev server
      shows the React UI.
- [ ] Tests and the section 6 checks, then PRs.

### Track M (phone) and Track D (Dispatch and pipelines)
- D2 started: a person's Continue is written in the run history ("continued by you"), and an
  agent or plan step that passed with no report is flagged on the canvas and in the run detail.
- D1 note: agents already write a result file in the repo's git folder, read in place of the
  screen, so the report and ask tools are a smaller change than planned. Still to do.
- Not started: Track M, D3 to D7.
