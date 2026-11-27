# Phone app step 3: everything else. Survey

Read-only research for the step 3 plan. Step 3 in the design doc's Delivery order is "Changes and commit, files, pipelines, reviews, usage, settings, voice" (docs/plans/mobile-app-design.md, Delivery order item 3). Step 2 deferred these to it (docs/plans/mobile-app-step2.md, "Not built"): the review diff viewer, the pipeline canvas inside save_pipeline, saved prompt history and diff, the Insights dialog, Dispatch rules, memory and instructions editing, event paging, and the pipeline mark on conversation rows.

Sources: web/src/workspace/*, web/src/pipelines/*, web/src/settings/*, web/src/insights/Insights.tsx, web/src/dispatch/*, the legacy assets the React pages still load (assets/dispatch-review.js, dispatch-tasks.js, term-compose.js, voice.js), src/web/mod.rs and src/web/*_api.rs, src/files.rs, src/changes.rs, src/dispatch/review/*, src/pipeline/*, mobile/ on this branch (0.11.110), and Orca at /home/hbasheer/Projects/orca/mobile (MIT). Tokens, sheets, lists and the Home screen are in docs/plans/mobile-app-orca-survey.md (sections 2, 5, 7, 9) and the Dispatch building blocks in docs/plans/mobile-app-dispatch-survey.md (section D); neither is repeated here.

---------------------------------------------------------------------------
## 0. Read this first

1. **Auth works on every route in this survey.** The guard (src/web/mod.rs:404-469) checks `Authorization: Bearer` first (mod.rs:427-438) and lets a valid device token straight through, before the Origin check that turns away non-GET requests (mod.rs:445). No handler inspects `DeviceAuth` to refuse a phone: grep finds it only in the guard and the two WebSocket handlers (mod.rs:374, 382, 1029, 2774). So changes, files, pipelines, reviews, insights, settings, triggers and voice routes all take the phone's token as they are.
2. **Only two sockets exist: `/state/live` and the terminal.** `state_live` and `term_ws` are the only `WebSocketUpgrade` handlers (mod.rs:1031, 2777). Nothing streams changes, files, pipeline runs or settings. `/state/live` pings on `state.touch()`, which the pipeline engine calls when a tick changes a run (src/pipeline/mod.rs:749-754) and every run action calls (src/web/pipeline_api.rs:676 `acted`). The web polls everything else: Changes every 5 s (web/src/workspace/RightPanel.tsx:72, 786), Pipelines on its own `POLL` timer (web/src/pipelines/PipelinesPage.tsx:581). The phone should poll while a screen is open and refetch on a live ping.
3. **There is no standalone Reviews page.** Reviews and scans live only as Dispatch cards (`role: "review"` events) rendered by the legacy assets/dispatch-review.js. The "diff viewer" step 2 deferred is the Changes panel inside that card (dispatch-review.js:943-962), backed by `/dispatch/conversations/{id}/reviews/{card}/diff`, `/files`, `/commit`, `/evidence/{file}`.
4. **The Workspace changes panel and the review diff use the same line shape** `{k: hunk|meta|ctx|add|del, o, n, t}` (src/dispatch/review/diff.rs:49-55; the web type at web/src/workspace/DiffView.tsx:13). One native diff renderer serves both. The phone already has the colours (mobile/src/ui/theme tokens `diffAddedBg` and friends) and a small `DiffBlock` (mobile/src/steps/DiffBlock.tsx) that draws `{op,text}` rows without line numbers.
5. **Files are text only on the server.** `GET /machines/{m}/file` returns `{path,size,text,hash,editable}` for UTF-8 text up to 1 MB (src/files.rs:8, 32-38); a binary file is refused with 415 and a larger one with 413 (src/web/files_api.rs:40-53). There is no route that returns raw bytes, so image preview needs a server addition (E.2).
6. **Orca's source-control and files code cannot be lifted.** Its source-control folder imports 138 distinct `src/shared` modules and makes about 360 RPC references; files imports 35 and about 145 (counted with grep in orca/mobile/src). Copy the visual values and layouts, write Yardbell's own data layer, as step 2 did for chat.
7. **Several step 3 clients already exist on the phone and are unused.** mobile/src/dispatch/api.ts:308-320 has `promptHistory`, `promptDiff`, `restorePromptVersion`; no screen calls them. `useDictation` and `MicButton` (mobile/src/dispatch/voice/*) are reusable for the terminal. `ApiClient` has `get`, `post`, `delete` but no `put` (mobile/src/api/client.ts:96-104), which matters only if the phone saves pipelines.

---------------------------------------------------------------------------
## A. Changes and commit, and the file viewer

### A.1 Web screens and controls

The Workspace right panel (web/src/workspace/RightPanel.tsx:750-853) has five tabs: Explorer (`files`), Agents (past Claude Code sessions), Source Control (`changes`, with a count badge), Checks (pull request), Ports (RightPanel.tsx:746-799). It works on a **place**: `{machine, path}`, a session's folder or a worktree picked in the sidebar (RightPanel.tsx:836-839 empty state "No folder picked").

**Source Control tab** (`ChangesTab`, RightPanel.tsx:402-744):

| Control | Where | Does |
|---|---|---|
| Branch line: branch, `-> upstream`, ahead and behind arrows | 602-623 | from `GET /changes` |
| Filter files by name (search icon, Escape closes) | 572-600, 624-628 | client-side substring |
| "..." menu: Fetch, Pull, Push, Refresh, Send review notes (N) | 629-655 | `POST /changes/{fetch|pull|push}`; notes are the diff line notes (A.3) |
| Commit message textarea, Ctrl+Enter commits | 662-671 | |
| Sparkles "Draft a message from the changes" | 672-681, 475-483 | `GET /changes/draft`, toast when `from == "files"` |
| Primary button: Commit / Commit All (dirty), Pull N (behind), Push N (ahead), Fetch | 510-519, 684-689 | Commit sends `staged:true` when anything is staged, else `paths` of all files unless the list was truncated (485-508) |
| Split menu: Commit, Commit & Push, Push, Pull, Fetch | 690-714 | |
| Sections "Staged Changes" (Unstage All) and "Changes" (Discard All, Stage All), foldable | 722-738 | |
| File row: status-coloured icon, name, folder, `+a -r` or "binary", status letter M/A/D/R/U | 521-566 | tap opens the diff |
| Row hover actions: Open File, Discard (or Delete untracked file), Stage / Unstage | 560-564 | |
| Row context menu: Open Changes, Open File, Stage/Unstage, Discard/Delete File, Copy path, Copy relative path | 524-532, 89-92 | |
| Discard confirm: "Discard changes in NAME?" / "N files?", body differs for untracked ("deleted. This cannot be undone.") | 464-473 | |
| Empty and truncated notes: "No changes. The working tree matches the last commit.", "Too many changes to list them all here." | 719-720, 739 | |

No branch switch, no branch create, no pull request create or merge in this panel. The **Checks tab** (web/src/workspace/SidePanels.tsx:152-262) shows each branch's PR from `/state` (`session.pull`: number, url, title, state, ci, review, mergeable, draft, failed checks, base) with Refresh (`POST /refresh`) and open-in-browser links. Merge lives on the Dashboard (web/src/dashboard/DashboardPage.tsx:1011, `POST /sessions/{m}/{name}/merge`). The **Agents tab** (SidePanels.tsx:48-132) lists past Claude Code conversations in the folder (`GET /machines/{m}/history?path=`) with Resume (`POST /sessions` with `resume_id`). **Ports** (SidePanels.tsx:265-297) lists forwarded ports with `localhost` links, which mean nothing on a phone.

**Diff view** (web/src/workspace/DiffView.tsx:122-405): Monaco diff editor, Unified/Split toggle (309-321, stored per browser), `+a -r` count, "Staged" or "Working tree", line notes for the agent (a `+` button in the gutter, note cards in view zones, "Send notes to agent (N)"), notes stored in localStorage (web/src/lib/notes.ts:14, 24) and sent with `POST /sessions/{m}/{tmux}/text` (web/src/workspace/SendNotes.tsx:50). It fetches the whole file with `context=100000`, paging up to 20 pages (DiffView.tsx:16-17, 150-166). Messages: binary (348), no line changed (350), "The diff is too large to show here." (352).

**File view** (web/src/workspace/FileView.tsx:29-124): Monaco editor, breadcrumbs, "N lines · size", "read only, not UTF-8" when `editable` is false, Save (Ctrl+S) when dirty, sending `{root,path,hash,text}` (56-80). No image preview, no rendered markdown, no "large file" view: errors (binary, too large) show as a sentence (107-110).

### A.2 Endpoints (src/web/changes_api.rs, files_api.rs)

All take `root` (absolute or `~/`, no `..`, src/files.rs:104-117) and a relative `path` (files.rs:119-136). A root that is not a known folder or session cwd must lie under the machine's root (files_api.rs:55-63, files.rs:146-157).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | /machines/{m}/changes | `?root=` | `{branch, head?, upstream?, ahead?, behind?, files:[{path, old_path?, status: modified|added|deleted|renamed|untracked, staged, added?, removed?, binary}], truncated}` (src/changes.rs:24-44; at most 500 files, 100 untracked, changes.rs:10-11) |
| GET | /machines/{m}/changes/diff | `?root=&path=&staged=&context=&from=` | `{path, old_path?, status, staged, added?, removed?, binary, notes[], lines[], from, next, total, cut}` (changes.rs:55-69), 5000 lines a page (changes.rs:12), 404 "PATH has no staged/unstaged changes to show" (changes_api.rs:83-91) |
| GET | /machines/{m}/changes/draft | `?root=` | `{message, from:"files"}`, built from file names only (changes.rs:468), 422 when nothing changed |
| POST | /machines/{m}/changes/commit | `{root, message, staged?:true, paths?:[...]}` | `{sha, short}`; 400 empty message, over 64 KB or NUL, over 500 paths; 422 "there is nothing to commit" or "git did not commit: ..." (changes_api.rs:128-217). Without `paths` and without `staged` it commits everything (`git add -A -- .`, changes.rs:312-313) |
| POST | /machines/{m}/changes/{stage|unstage|discard} | `{root, paths:[...]}` | `{ok:true}`; 400 when no paths or a path has no changes (changes_api.rs:236-294) |
| POST | /machines/{m}/changes/{push|pull|fetch} | `{root}` | `{ok:true}`; push sets upstream on first push, pull is `--ff-only`, and git never prompts (changes.rs:399-416); 422 "git said: ..." |
| GET | /machines/{m}/files | `?root=&path=` | `{path, entries:[{name, kind: dir|file, size}], more}` (files.rs:17-29, max 2000) |
| GET | /machines/{m}/file | `?root=&path=` | `{path, size, text, hash, editable}`; 413 over 1 MB, 415 binary, 404 missing (files_api.rs:40-53) |
| POST | /machines/{m}/file | `{root, path, hash, text}` | `{path, size, hash}`; 409 "changed on the machine since it was opened" (files.rs:84-86) |
| GET | /machines/{m}/files/search | `?root=&q=&mode=names|contents` | `{matches:[path], more}` (max 200, files.rs:9) |
| GET | /machines/{m}/history | `?path=` or `?scope=all` | `{machine, scope, path, sessions:[{id,folder,title,prompt,summary,updated,messages}], scanned, cut}` (files_api.rs:171-202) |
| POST | /sessions/{m}/{name}/merge | `{head?}` | `{merged, machine, name, branch, method, pull}`; 409 with the forge's reason (src/web/worktrees_api.rs:633-683) |

Live updates: none. Commit and git actions call `app.recheck` (changes_api.rs:154, 215, 292), which refreshes `/state` (branch, PR) on the next check. The changes list itself must be polled.

### A.3 Phone today

Nothing. The session screen menu has Session details, Open PR, Text size, Clear terminal, Stop session (mobile/src/session/SessionScreen.tsx:351-379); the machine row menu has Open, Open PR, Copy branch, Copy path, Stop session (mobile/src/machine/MachineScreen.tsx:167-220). `/state` already gives every session's `path`, `cwd`, `branch`, `worktree`, `pull` (src/state.rs:85-117) and `folders` (label, machine, path, branch), enough to name a place.

### A.4 Orca counterparts

Orca has a full source-control panel per worktree (route app/h/[hostId]/source-control/[worktreeId].tsx; src/source-control/MobileSourceControlPanel.tsx, 398 lines) and a diff review screen (app/h/[hostId]/review/[worktreeId].tsx; src/source-control/review/diff-screen/*).

Copy (visual values):
- File list styles, src/source-control/changes/mobile-source-control-list-styles.ts: `fileRow` minHeight 50, row gap `spacing.sm`, hairline bottom border `borderSubtle`, opaque `bgBase` so a swipe reveals actions (46-56); `fileRowPressed` bgPanel; `statusBadge` width 24, mono `metaSize` 700 (63-71); `fileName` bodySize textPrimary, `fileMeta` metaSize textMuted marginTop 2 (76-84); `iconButton` 32 x 32 radius control (90-96); `branchStateRow` minHeight 44 (31-39); `sectionAction` 13/600 (14-18).
- File row body: name leads, folder under it, then stats and action (changes/MobileSourceControlFileRows.tsx:50-80, `splitGitPath`), swipe actions via `SwipeRowActions` (Stage `Plus`, Unstage `Minus`, Discard `Undo2`).
- Changes header and next-step bar: changes/MobileSourceControlChangesHeader.tsx (192), panel/MobileSourceControlNextStepBar.tsx (395) is the model for the one primary button that changes with state (Commit, Push N, Pull N), matching the web's primary button logic.
- Diff screen: review/diff-screen/MobileDiffReviewLine.tsx (293) and MobileDiffReviewLines.tsx (370): a pinned left gutter with line number and sign, code that scrolls sideways, `addedRow`/`deletedRow` grounds (MobileDiffReviewLine.tsx:66-121); fold rows minHeight 32 on `diffFoldBg` with `diffFoldGutter` icon cell (mobile-diff-review-layout-styles.ts:59-70); files sheet to jump between files (MobileDiffReviewFilesSheet.tsx, 297); file summary with `+a -r` (MobileDiffReviewFileSummary.tsx, exports `MobileDiffLineStats`).
- Empty and error states: changes/mobile-source-control-diff-styles.ts `state`, `stateTitle` 16/700, `retryButton` (5-35).

No counterpart (Orca has, Yardbell server does not): branch picker, commit history list and commit detail (source-control/history/*), conflict resolution (conflicts/*), PR create, reviewers, comments, checks detail (review/pull-request/*). The server has no route for any of them, so they stay out.

---------------------------------------------------------------------------
## B. Files

### B.1 Web

The Explorer tab (`FilesTab`, RightPanel.tsx:96-353): lazy folder tree from `GET /files` (121-127), rows indented 16 px a level, git status colour and letter on files and a dot on folders that hold changes (169-172, 199-237), `.git` always hidden and dotfiles behind a toggle (195, 243-248, stored per browser), Collapse All, Refresh Explorer, "..." with Show Dotfiles and Copy Path (256-286), a Names/Contents segmented control and a search box with 200/400 ms debounce (288-331, 135-151), results with the folder in grey (333-346), file context menu Open, Copy path, Copy relative path (216). Opening a file opens the File view (A.1). No upload, rename, delete or new file anywhere in the web; the only write is the File view's Save.

Browsing a machine outside a session's folder: the Explorer always needs a place. The "Add project" and new-session dialogs use `GET /machines/{m}/browse?path=` (mod.rs:2505-2527), which lists folders only (for picking a directory), plus `recent`.

### B.2 Endpoints

As A.2 (`/files`, `/file`, `/files/search`). Uploading into a session is a different route the phone already uses: `POST /sessions/{m}/{name}/upload?name=` (src/web/term_api.rs:24-28, mobile/src/api/upload.ts:6-8), 10 MB, which drops the file on the machine and returns its path.

### B.3 Orca counterparts

- Explorer: src/files/explorer/MobileFileExplorerPanel.tsx (408) and mobile-file-explorer-row.tsx (360): `paddingLeft = spacing.lg + min(depth * 18, maximumIndentation)` (row.tsx:67), inline status rows for loading, error, "show more" (row.tsx:139-170), a row actions sheet (mobile-file-explorer-row-actions-sheet.tsx, 58). Route app/h/[hostId]/files/[worktreeId].tsx.
- Preview screen: src/files/MobileFilePreviewScreen.tsx (414), body by kind in preview/MobileFilePreviewBody.tsx: media, image, markdown, svg/html, else source text (61-142); source text in preview/MobileFilePreviewSourceText.tsx (80); markdown with a source/preview mode bar (markdown/MobileMarkdownPreviewModeBar.tsx, 77); pan-zoom image (media/presentation/MobilePanZoomImage.tsx, 64; MobileImageViewer.tsx, 203). Route app/h/[hostId]/files/preview/[worktreeId].tsx.
- Editing: preview/MobileFilePreviewEditableSource.tsx (62) with a discard modal (MobileFilePreviewDiscardModal.tsx, 30). Orca does edit on the phone; Yardbell's server supports a hash-guarded save.

What the phone can render without new dependencies: text with a mono font and sideways scroll (like `DiffBlock`), markdown through the existing mobile/src/markdown renderer (step 2), images through `<Image source={{uri, headers}}>` once a bytes route exists. No syntax highlighting (Orca uses lowlight; step 2 skipped it).

---------------------------------------------------------------------------
## C. Pipelines

### C.1 Web screens and controls

**List** (`ListView`, web/src/pipelines/PipelinesPage.tsx:84-257): tabs Pipelines (count), Waiting for me (amber count of runs where `state == waiting` or queued with `held.told`, model.ts:190), Settings (111-122). "New pipeline" menu: Empty pipeline or a template (123-154). Rows (186-237): trigger icon (clock, hand, webhook, PR, ticket), name, `vN`, "N waiting for you", "N running", trigger sentence (`triggerWords`, model.ts:270-291), the pass flow as `A > B > C` with loops (`flow`, model.ts:166-179), problem line, run counts, On/Off switch (`POST /api/pipelines/{id}/enabled`). Waiting view rows: run dot, label, pipeline and reason, age, Open (160-176). Empty states at 177-184 and 239-254.

**Pipeline page** (PipelinesPage.tsx:556-811): header with back, editable name, On switch, `vN`, tabs Build / Runs N / History, Full screen, "Ask Dispatch" (prefills `Change the pipeline "NAME" (id): ` in Dispatch, 768), Delete (refused while runs are live, 700-711), Run now, Save (only when the draft differs, 772-780). Run now (`RunNowPanel`, 259-340): ticket ids or links, PR links, optional diagram for manual pipelines (`GET /api/diagrams`), Start (`POST /api/pipelines/{id}/runs {tickets, prs, diagram?}` -> `{runs}`); schedule pipelines start at once with `{}` (713-719).

**Runs tab** (web/src/pipelines/Runs.tsx:691-776): three columns: run list with "Clear ended" (730-760), the canvas coloured by run state with a terminal or transcript pane under it (762-764), and a side panel with the run Detail or a Step panel (766-768). On narrow screens only the canvas column shows (`max-lg:hidden`).

- **Detail** (Runs.tsx:302-425): status pill, "..." with Delete this run (ended) or Stop this run (live, `drop`), label, "Started TIME by you/a trigger · state", chips for ticket, PR, draft PR, Conversation (`/dispatch?c=`), machine and branch; the NeedBox when waiting; HeldBox when held; token use bar (59-89); steps reached as a timeline with mark, note, "Passed by a person after its command failed", "Passed without a report", read commit, report (383-418); run report; History.
- **NeedBox** (Runs.tsx:91-204), the run's "needs you" card: reason, open questions, help text per waiting kind (`no_result`, `unchanged`, `token_limit`, `token_unknown`, command not run or failed), the screen tail, an answer box for `needs_you|asking|questions|no_result` (model.ts:90), and buttons Drop, Accept and run (`tool_changed`) or Retry step / Start this step anyway / Run it again, Continue on fail, Continue on pass, Send answer, plus Raise the limit with a number.
- **Step panel** (Runs.tsx:436-500): facts, report, details, your answer. **Transcript** (`StepLog`, 520-632): `GET /api/runs/{id}/steps/{step}/transcript`, items prompt / agent markdown / tool calls folded, "Read again". **Terminal** (634-689): iframe of `/term/{m}/{name}?embed=1` for the run's live sessions, a segmented picker when several, Open, Stop session (`POST /api/runs/{id}/stop-session {name}`).

**Build tab** (web/src/pipelines/Build.tsx:222, Canvas.tsx:112, Forms.tsx 998 lines): SVG canvas with pan and wheel zoom (Canvas.tsx:200-216), drag nodes, connect pass/fail/needs-you outcomes, per-kind forms (agent, plan, push, update, checks, call, tool, command, report, wait; model.ts:93-104), trigger forms, validation problems from the server. **History tab** (PipelinesPage.tsx:343-460): versions, preview, Restore, Delete version, Keep only the current. **Settings view** (web/src/pipelines/SettingsView.tsx:25): per machine, minutes, memory limit, token limit, QA notes, `PUT /api/pipelines/settings`. **Proposal view** (PipelinesPage.tsx:492-555) opens a `save_pipeline` step in the builder from Dispatch or the inbox.

### C.2 Endpoints (src/web/pipeline_api.rs:19-48)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/pipelines | | `{pipelines:[{definition, runs:{running, waiting, held, done}, problem}], templates, settings, machines, agents, agents_without_tokens, default_agent, mcp_servers, gitlab_hosts, connectors:[...]}` (94-159) |
| GET | /api/pipelines/{id} | | definition |
| POST | /api/pipelines | `{template}` or `{empty:true}` | `{id,...}` |
| PUT | /api/pipelines/{id} | definition | saved definition; 400 `{error, problems[]}` (67) |
| DELETE | /api/pipelines/{id} | | `{deleted}` |
| POST | /api/pipelines/{id}/enabled | `{enabled}` | saved definition (216-226) |
| GET | /api/pipelines/{id}/history | | `{history:[{version, saved, definition}], current}` (236-244) |
| POST | /api/pipelines/{id}/restore | `{version}` | |
| POST | /api/pipelines/{id}/history/{v}/delete, /history/clear | | |
| GET / POST | /api/pipelines/{id}/runs | POST `{tickets[], prs[], diagram?}` (531-539) | GET `{runs}` for this pipeline; POST `{runs}` |
| POST | /api/pipelines/{id}/clear-runs | | `{deleted:[ids]}` |
| GET | /api/runs | | `{runs:[run + terminals[] + sessions_left[] + tokens_used + tokens_from_cache]}`, newest first, every run of every pipeline (300-362) |
| DELETE | /api/runs/{id} | | `{deleted}` |
| POST | /api/runs/{id}/answer | `{text}` | the run (`acted`, 664-690) |
| POST | /api/runs/{id}/retry, /accept-tool, /drop | `{}` | the run |
| POST | /api/runs/{id}/continue | `{outcome: pass|fail}` | the run (774-789) |
| POST | /api/runs/{id}/token-limit | `{limit}` | the run |
| POST | /api/runs/{id}/stop-session | `{name}` | `{ok:true}` |
| GET | /api/runs/{id}/steps/{step}/transcript | | `{available, why?, path, machine, transcript:{items:[{kind: prompt|agent|tool, text, at, name, input, result, failed}], files[], dropped, skipped, cut}}` (web type at Runs.tsx:502-516) |
| PUT | /api/pipelines/settings | settings | |

A run's shape is the web type at web/src/pipelines/model.ts:60-87 (`state`, `step`, `step_since`, `subject`, `waiting{kind,step,reason,screen}`, `held`, `steps{id: StepState}`, `history`, `questions`, `tokens`, `report`, `pull`, `conversation`, `place`, `terminals`, `sessions_left`). Each run carries its `definition` (src/pipeline/record.rs:271).

Live updates: run actions and engine ticks call `state.touch()` (pipeline_api.rs:676; src/pipeline/mod.rs:754), so `/state/live` pings. `StateView` has **no** pipeline count (src/state.rs:145-162). Pipeline pushes exist (`pipeline_waiting`, `pipeline_finished`) with `click` = `{base}/pipeline?p=ID&run=RUN` (src/pipeline/run.rs:159-161), which the phone router sends to Home (mobile/src/notifications/route.ts:21-36).

### C.3 Phone today and Orca

Phone: the `save_pipeline` step card shows a node list summary (step 2, mobile/src/steps/StepBody.tsx, gallery entry mobile/src/steps/StepGallery.tsx:46); `set_pipeline_enabled`, `run_pipeline`, `answer_run` step cards exist (StepCard.tsx:77-79). No pipelines screen, no `/api/runs` client, so Dispatch rows lack the pipeline mark.

Orca: no pipeline builder. The closest model is Automations (src/automations/*: AutomationList.tsx, AutomationDetail.tsx, AutomationRunList.tsx, AutomationRunDetails.tsx, AutomationControls.tsx with a `MobileSwitch`), already noted in the step 2 survey D.2 item 9: list rows with a switch, a detail page with sections and a "Run now" footer, a run list and a run detail. Steps as a vertical timeline can reuse Orca's tool-run indentation (hairline left border, survey D.2 item 3). There is no Orca canvas.

What a phone can show: a vertical node list in pass order with fail loops named (the web's `flow()`, model.ts:166-179) and per-node run state (`nodeState`, model.ts:219-236) is readable at 360 dp; an SVG canvas with pan/zoom is possible with react-native-svg (installed, mobile/package.json) but the canvas has about 12 node kinds, outcome edges and drag editing (Canvas.tsx 563 lines, Build.tsx 651, Forms.tsx 998), so editing on a phone is a large build for little use.

---------------------------------------------------------------------------
## D. Reviews and scans

### D.1 Web

Reviews start from a session card ("Review branch", `POST /dispatch/conversations/{id}/reviews {card}`), from the Dashboard (`POST /dispatch/reviews {machine,name}`, DashboardPage.tsx:1052) or as pipeline steps. Scans from the session card's Scan menu (DispatchPage.tsx:685-690). Results are `role: review` events. The phone already renders them (mobile/src/dispatch/cards/ReviewCard.tsx: verdict, summary, findings by severity with pick, Send, Start for scans with the session picker from `/reviews/{card}/sessions` at 31 and 93-111, Dismiss). What it lacks, from assets/dispatch-review.js:

| Piece | Legacy code | Endpoint |
|---|---|---|
| Changes panel: "Changes N files +a -r", toggle, note on the base ("Against BASE from SHA, with changes not yet committed. Read from the folder as it is now.", "The branch has new commits since this review."), file rows with status letter, old path, stats | 933-962, 919-931 | `GET .../reviews/{card}/diff` -> `{base, merge_base, head, files:[{path, old_path?, status, added?, removed?, binary, untracked}], truncated, reviewed_head, moved}` (src/web/review_api.rs:70-109; diff.rs:29-47) |
| File diff, paged 400 lines with "Show N more lines (M left)", two line-number columns, hunk rows, notes, binary, "over 2 MB" | 893-917, 788-804 | `GET .../diff?file=&from=&line=` -> `{path, binary, notes, lines, from, next, total, cut}` (diff.rs:57-66, `PAGE_LINES` 400 at diff.rs:8) |
| Finding place as a link that opens the file and scrolls to the line (`src/a.rs:88`, fuzzy path match) | 1035-1043, 822-884 | same, with `line=` |
| Scan "Files" panel: files the findings point at, with finding counts, the file read as it is now | 964-992, 834-841 | `GET .../reviews/{card}/files` -> `{folder, files}`; `?file=&from=&line=` a page (src/web/scan_api.rs:201-247) |
| Commit line: "Read SHA with uncommitted changes.", then "Nothing has changed since." / "The branch has moved on since this review: it is now at SHA..." / uncommitted changed; and the PR head mismatch note | 1158-1201 | `GET .../reviews/{card}/commit` -> `{standing: same|moved|uncommitted|unknown, now}` (review_api.rs:31-49) |
| Evidence screenshots under a finding, tap for full size with fit/actual toggle | 994-1033 | `GET .../reviews/{card}/evidence/{file}` image/png, immutable (review_api.rs:119-141) |

All are GETs under `/dispatch/...`, so the bearer works, and evidence images need the `Authorization` header on `<Image>` like attachments do.

### D.2 Orca

Orca's diff screen (A.4) is the visual model for the file diff. Finding rows and severity groups have no Orca counterpart (step 2 already designed them). Evidence full view: Orca's image viewer (src/files/media/presentation/MobileImageViewer.tsx, 203; MobilePanZoomImage.tsx, 64).

---------------------------------------------------------------------------
## E. Settings

### E.1 Web Settings page

Sections and groups from web/src/settings/SettingsPage.tsx:44-91, rendered at 212-250. "Where it lives" is per browser (localStorage) or per server (config file, `/api/settings`). The phone column says what the phone has today (mobile/app/settings/*: Servers, Appearance, Terminal, Notifications, About, Speak replies switch, Licences; mobile/app/settings/index.tsx:11-43).

| Section | Lives | Endpoints | Phone today | Judgement for step 3 |
|---|---|---|---|---|
| Appearance (General.tsx:98) | browser | none | own Appearance screen | done (phone keeps its own) |
| Terminal (Terminal.tsx:149) | browser | none | own Terminal screen | done |
| Browser (Terminal.tsx:320) | browser | none | n/a | leave out (no browser pane on the phone) |
| Power (General.tsx:240) | server | `POST /api/settings/keep-awake {mode}` | none | small: a three-way choice; optional |
| Notifications (Notifications.tsx:25 desktop, Sections.tsx:85-139 phone) | browser + server | `POST /api/settings/phone {wait_minutes, agent_waiting, session_ended, machines, memory, pipeline_waiting, pipeline_finished, proposals, dispatch, pull_ci_failed, pull_conflicts, pull_ready, pull_merged, pull_closed, limit_reset}` (fields from settings_api.rs:98-114) | phone Notifications screen has only the system permission and the server list (mobile/app/settings/notifications.tsx:38-65), and says "Turning individual servers off ... are not available yet" | **yes**: the server's phone push toggles belong on the phone more than anywhere |
| Security (General.tsx:270) | server | `POST /api/settings/passcode`, `/logout-all` | none | leave out (changing the passcode from a paired phone is odd; revoking this phone is in Servers already via forget) |
| About (General.tsx:400) | server | `GET /app/about`, `/app/about/updates` | phone About shows the app; server version in Servers > server | optional: show server update state |
| Machines (Machines.tsx:59) | server | `POST /api/settings/machines/{name}`, `/machines/{n}/remove`, `/refresh`, onboarding routes | none | leave out (ssh onboarding with a folder picker is a desktop job) |
| Mesh VPN (Sections.tsx:299) | server | `/api/settings/mesh/preview`, `/apply` | none | leave out |
| Connect a phone (Sections.tsx:187) | server | `/api/settings/pair`, `/devices`, `/devices/{id}/revoke` | none | optional: list paired devices read-only |
| Agents (Agents.tsx:23) | server | `/machines/{m}/agents`, `/api/agents/catalog`, `/api/agents/{name}/install` | none | leave out (install runs in a session; could come later) |
| Dispatch (Sections.tsx:964-1260) | server | `GET /api/settings` (`dispatch`), `POST /api/settings/dispatch` (whole object), `GET/POST /dispatch/memory` | approval and model pills in the composer only (mobile/src/dispatch/composer/Composer.tsx:150-161 through `setDispatchSettings`, mobile/src/dispatch/api.ts:334-348) | **yes** (deferred from step 2) |
| Stats & Usage (More.tsx:147) | server | `GET /api/usage/stats?provider=&days=` | Home > Usage shows the limit meters from `/dispatch/usage` and refresh (mobile/src/home/UsageTab.tsx:96, 149) | optional: the daily token chart is not on the phone |
| Voice (Voice.tsx:106) | server | `/api/settings/voice`, `/voice/check`, `/voice/models*`, `/voice/setup` | none; the mic says "set up on the computer" (mobile/src/dispatch/voice/model.ts:13) | small: mode (hold/auto), language, remove fillers are plain fields; model download and the mic test stay on the computer |
| Triggers (More.tsx:376) | server | `GET /api/triggers` -> `{zone, now, triggers:[{trigger:{name, task, schedule, linear?, github?, enabled}, ...next/last}], tasks}`, `POST /api/triggers {triggers}` (whole list), `/enable {name, enabled}`, `/run {name}` -> `{conversation?, text}` (src/web/triggers_api.rs:28-122) | Dispatch trigger header has Turn on/off only | **yes, light**: list with switch and Run now; editing schedules stays on the computer |
| Worktree setup (Sections.tsx:709) | server | `/api/settings/worktree-setup` | none | leave out |
| Diagrams (Sections.tsx:636) | server | `/api/diagrams*` | none | leave out |
| Health checks (Sections.tsx:458) | server | `POST /api/settings/health` | none | optional, small toggles |
| Integrations (Integrations.tsx:1260) | server | secrets, pull requests, Linear, connectors, MCP servers with sign-in | none | leave out (tokens and OAuth flows) |
| Let agents use Yardbell (Sections.tsx:504) | server | `/api/settings/mcp/on|off` | none | leave out |

After any save the web shows a bar with Undo (`POST /api/settings/undo`) and Restart (`/api/settings/restart`) (SettingsPage.tsx:268-318); Dispatch can change settings too and leaves `undo_note`.

### E.2 Dispatch settings in detail (Sections.tsx:964-1260)

- Header card: agent label and model, approval word and detail, rule count, a warning when the agent is not installed where Dispatch runs, Open Dispatch (1045-1067).
- **Agent** group (1069-1136): runs-on choice from `dispatch_runs_on` (claude, codex) with "Installed on HOST" from `GET /machines/{m}/agents`; Model menu with search (`ModelMenu`, 891-956; Claude catalogue from web/src/lib/agent-models.ts, Codex from `codex_models` plus typed values); "Agent for new sessions".
- **Approvals** (1138-1160): Ask first / Go ahead / Refuse cards (APPROVALS at 885).
- **Rules** (1162-1226): "When Dispatch wants to [step] on [machine] in [folder] then [Allow|Ask|Deny]", Add rule, Remove; steps from RULE_STEPS (844-868), steps without a place (UNPLACED, 869-881) hide machine and folder.
- **Instructions** (1228-1243): textarea, 4000 characters, counter.
- **Memory** (1275-1417): size bar (bytes of max, warning at 80 %, over-cap note naming `omitted`), Add entry, Edit and Delete per entry (500 characters), history of changes with add/replace/forget and who. `GET /dispatch/memory` -> `{file, bytes, max_bytes, omitted, entries[], history[{change, old?, entry?, at, by, reason?}], error?}`; `POST /dispatch/memory {change: add|replace|forget, old?, entry?}` -> same shape.
- Sticky "Unsaved changes to Dispatch" bar with Discard and Save (1247-1258); save posts the whole object `{instructions, agent, runs_on, model, codex_model, approval, rules}`.

The phone already posts that whole object from the composer pills by reading `/api/settings` first and merging (mobile/src/dispatch/api.ts:334-348). A phone Dispatch settings screen would do the same. Lost update risk: a web edit between the phone's read and write is overwritten (E.5).

### E.3 Saved prompt history and Insights

- **History** (legacy assets/dispatch-tasks.js:20-128, opened from DispatchPage.tsx:1189-1202): versions newest first with "Restored from version N" or "The default again", a word diff between any two, Restore (saves as a new version), Reset to the default. Endpoints: `GET /dispatch/tasks/history?name=` -> `{name, builtin, current, versions:[{n, text, at, restored?}]}` (src/dispatch/tasks.rs:263-290); `GET /dispatch/tasks/diff?name=&from=&to=` -> `{name, from, to, parts[{op, text}]}`; `POST /dispatch/tasks/versions/restore {name, version}` -> `{tasks, history}` (mod.rs:1344-1382). Phone clients exist, unused (0.7). The step card's diff block (`DiffBlock`) can draw `parts`.
- **Insights** (web/src/insights/Insights.tsx:410-500): a dialog for one session, opened from the Dispatch session card (DispatchPage.tsx:332, 694) and the Dashboard row menu (DashboardPage.tsx:1017, 1056). `GET /sessions/{m}/{name}/insights` -> `{machine, name, live, attachable, activity, work, parts, timeline, earlier[], scrollback_error, task, conversation, pull, suggest, from?:{name, version, current}}` (src/web/insights_api.rs:63-163; reads 2000 lines of scrollback and keeps the last 30, insights_api.rs:14-15). Body sections: facts, timeline of working/waiting/idle stretches with what it did, end of terminal, earlier tool runs from the scrollback, Task and "From the task NAME, version N" (Insights.tsx:158-346). Footer: Close and **Suggest a better prompt**, which asks Dispatch with `improve:{machine,name,task?}` and `text = data.suggest` (DispatchPage.tsx:334-339). The phone's `ask()` already accepts `improve` (mobile/src/dispatch/types.ts:266-272) and the assistant's Save buttons for an improve reply are part of step 2's message rendering (survey A.3).

### E.4 Orca

Orca settings screens (orca/mobile/app/settings.tsx, voice-settings.tsx, notifications.tsx, terminal-settings.tsx) are lists of grouped rows with switches and pickers; the step 1 redesign already copied that pattern (mobile/src/settings/SettingsScreen.tsx, ListGroup, ListRow, SectionHeader). For Dispatch: memory list after Orca's bot memory (src/bots/soul-memory/MobileBotMemory.tsx, 371: entries, add, edit, forget, cap bar; step 2 survey D.2 item 9); rules as rows that open a BottomDrawer form with pickers (Orca `PickerListDrawer`, survey D.2 item 7); segmented control for Allow/Ask/Deny (the phone has mobile/src/inbox/Segmented.tsx). Triggers after Orca Automations list rows with a switch.

### E.5 Settings risks

- Every Dispatch save replaces the whole object, and triggers save the whole list; two editors race. The phone can reduce it by re-reading right before saving and only sending a changed field set merged into the fresh copy (the composer already does this).
- `GET /api/settings` returns more than a phone needs, including the MCP token (`mcp.token`, settings_api.rs:131-132) and the `voice` object, whose `api_key` serialises when set (src/config.rs:562). The phone already calls this route. Not verified whether `api_key` holds a raw key or a secret name.

---------------------------------------------------------------------------
## F. Voice in the terminal

### F.1 Web

The React Workspace shows each terminal as an iframe of the legacy `/term/{m}/{name}?embed=1` page (web/src/workspace/Workspace.tsx:94, 252). That page's compose box (assets/term-compose.js:24-240) opens from the agent key "Type" (assets/term-agent.js:111): a textarea, Close, Attach (uploads with `POST /sessions/{m}/{name}/upload`, inserts the shell-quoted path, 130-171), **Dictate** (37, 203-209, `dictation()` from assets/voice.js, which posts the recording to `POST /dispatch/transcribe`, voice.js:398), and Send. Send pastes the text into the terminal and presses Enter 150 ms later because Claude Code treats text plus Enter in one burst as a pasted line break (8, 98-108). The mic reads `voice_input` and `voice_mode` from `GET /dispatch/runs-on` (177-185); with voice off it says "Voice input is off. Turn it on in Settings, under Voice." (187-201). Dictated words are inserted at the cursor with spaces as needed (68-79), never sent on their own.

### F.2 Phone today

The session dock is the key row, Smart keys, and `LiveInput`: a field where every keystroke goes straight to the terminal, plus an Attach button (photo, long press for a file) (mobile/src/session/SessionScreen.tsx:480-510; mobile/src/terminal/LiveInput.tsx:51-101). There is no compose box. Paste into the terminal already exists through the WebView (`toPage({type:'paste', text})`, SessionScreen.tsx:324-328), which xterm sends as a bracketed paste. Dictation building blocks from step 2: `useDictation(server, {mode, onText, onProblem, onDenied})` (mobile/src/dispatch/voice/useDictation.ts:21-73; records `audio/mp4`, which src/voice.rs:70 maps to m4a), `MicButton({server, runsOn, onText, onProblem})` (mobile/src/dispatch/voice/MicButton.tsx:12-28) with the voice-off and permission-denied sheets.

### F.3 Orca

Orca puts the mic in the terminal's input row next to Attach (src/terminal/session/input-controls/MobileTerminalInputActions.tsx:59-77): while starting, recording or transcribing, Attach steps aside so the field has room; a failed recording shows Retry in the mic's place. Recording state shows as a pill (src/dictation/MobileDictationPill.tsx). The dock is src/session/MobileSessionCommandDock.tsx.

### F.4 What the phone needs

A `MicButton` in the LiveInput row (Orca's placement), `runsOn` from `GET /dispatch/runs-on`, and an `onText` that pastes the words into the terminal through the existing WebView paste, without Enter. No server change. Decide: paste straight into the terminal (simple, matches "live input") or into a short compose sheet that the person sends (matches the web; lets them fix a misheard word first).

---------------------------------------------------------------------------
## G. Everything else the web has that the phone lacks

| Feature | Web | Endpoint | Step 3? |
|---|---|---|---|
| Session row and card actions: Review branch | DashboardPage.tsx:1052, Dispatch session card | `POST /dispatch/reviews {machine,name}` -> `{conversation, step}` | **yes**, one menu row; the phone has the client (`reviewSession`, mobile/src/dispatch/api.ts:266) |
| Insights for a session | E.3 | `/sessions/{m}/{n}/insights` | **yes** (deferred from step 2) |
| Changes and Files from a session or folder | A, B | A.2 | **yes** |
| Merge a ready PR | DashboardPage.tsx:1011 | `POST /sessions/{m}/{n}/merge` | yes, small: one row in the session menu when `pull.mergeable`/ready, with a confirm |
| Past sessions and Resume (Agents tab) | SidePanels.tsx:48-132 | `GET /machines/{m}/history`, `POST /sessions {resume_id}` | optional; the phone resumes ended sessions already (mobile/src/machine/ExtrasSection.tsx:172) but not Claude Code history |
| Move a session to another machine, Remove worktree | DashboardPage.tsx:1057-1058, Dialogs.tsx:77, 270 | `/sessions/{m}/{n}/move`, `/worktrees/{m}/inspect`, `/remove` | no (dialogs with inspection results; Dispatch can do both by asking) |
| Diagrams page | web/src/diagrams/DiagramsPage.tsx | `/api/diagrams*`, `/diagrams/view` (HTML) | no (a viewer is an HTML page; little phone value) |
| Pipelines | C | C.2 | **yes**, runs first |
| Proposals inbox | done in step 2 | | done |
| Usage stats chart | More.tsx:147 | `/api/usage/stats` | optional |
| Health checks settings | Sections.tsx:458 | `/api/settings/health` | optional |
| Machine settings (ssh, prefix, root) and Add machine | Machines.tsx | E.1 | no |
| Ports panel | SidePanels.tsx:265 | `/state` ports | no (`localhost` links are this computer's) |
| Open a shell on a machine | SessionTree.tsx:519 | `POST /machines/{m}/shell` -> `{name}` | optional, small: the phone can open the new tmux session in its terminal |
| Event paging in Dispatch | | none on the server | no (E.2 of the step 2 survey; still optional) |
| Speak replies | done in step 2 | | done |

---------------------------------------------------------------------------
## H. Gaps, server changes and risks

### H.1 Server changes

Needed for a good phone version:
1. **Pipeline count in `StateView`.** Add `runs_waiting: usize` (runs where `asksForYou`: `state == waiting`, or queued with `held.told`; web/src/pipelines/model.ts:190) next to `proposals` and `waiting` (src/state.rs:156-161), so a Home row and badge need no `/api/runs` polling. The engine already touches state on run changes.
2. **A lighter runs list.** `GET /api/runs` returns every run ever kept with its full definition and terminal lookup (pipeline_api.rs:300-362). For the Waiting view and the Dispatch pipeline mark the phone needs only `{id, pipeline, pipeline_name, state, step, step_since, waiting, held, subject, conversation}`. Suggest `?brief=1` (no `definition`, `steps`, `history`) and an optional `?state=waiting`. Size not measured; flagged because a long-lived server can have hundreds of runs.

Optional, decide in the plan:
3. **File bytes route for image preview**: `GET /machines/{m}/file/raw?root=&path=` with the same root checks, a size cap (say 10 MB), a type sniff limited to png/jpeg/gif/webp, `X-Content-Type-Options: nosniff` and CSP none, as `evidence` does (review_api.rs:128-139). Without it the phone shows "binary file" for images, as the web does.
4. **Settings field updates**: a `PATCH`-style `POST /api/settings/dispatch/fields` that changes only the named keys, to remove the lost-update race (E.5). The composer and a settings screen can live without it by re-reading before each save.
5. **Changes summary in `/state`**: a dirty-file count per session would let Home and the session menu show "3 changed" without polling `/changes` per session. Not required.

Not needed: auth (0.1), routing for commit, git actions, files, reviews, insights, triggers, transcribe; recorder format (`audio/mp4` already accepted, src/voice.rs:70).

### H.2 Phone gaps to design (no counterpart in Orca or the web)

1. A **place picker** for Changes and Files when opened from a machine rather than a session: the machine's folders (`state.folders`) and session cwds, grouped like the machine screen.
2. **Native diff renderer with line numbers** shared by Changes, review Changes, scan Files and prompt history; paging for 400-line (review) and 5000-line (changes) pages; per-file "too large" and binary notes.
3. **Text viewer** for up to 1 MB: long files need a virtualised list of lines (a 1 MB file can be 30k lines), not one `<Text>`.
4. **Run detail on a phone**: one column, NeedBox first, then steps timeline, report, history; terminals open the existing session screen instead of an iframe; transcript in a sheet.
5. **Pipeline definition view**: vertical node list with kind icon, name, who/does/tags (`describe`, model.ts:304-335) and run state marks.
6. **Diff line notes to an agent**: the web's per-line notes (DiffView.tsx) are a desktop review flow; a phone version would be long-press a line, type a note, send to the session. Recommended out (H.4).

### H.3 Risks not verified

- `/api/runs` payload size on a real server (H.1 item 2).
- Whether `voice.api_key` in `GET /api/settings` is a raw key (E.5).
- How `git push` behaves on machines whose credentials need an agent: the server forces `GIT_TERMINAL_PROMPT=0` and `BatchMode=yes` (src/changes.rs:409-416), so a push that needs a passphrase fails with "git said: ...". The phone must show that message whole; untested.
- Commit All without staging and with a truncated list commits everything (`git add -A`), which the web allows (RightPanel.tsx:489-491). The phone should keep the same rule and say so in the confirm.
- Rendering a 5000-line diff page or a 1 MB file on a low-end phone; FlatList virtualisation assumed, not measured.
- Pipeline actions are all POSTs that return the run; double taps can retry twice. The web disables buttons while `busy` (Runs.tsx:165-200); the phone must too.
- Orca's visual values were read from source, not seen on a device; light theme values for new tokens (`diffFoldBg` etc.) come from mobile/src/ui/theme, already in the app.

### H.4 Scope advice

Worth doing on the phone:
- **Changes and commit**: list, diff per file, stage/unstage/discard by swipe, commit with Draft, Commit & Push, Push/Pull/Fetch. The server supports all of it, the web has it, and "commit what the agent did" is a real phone task.
- **Read-only file browser and viewer**: tree, name and content search, text with line numbers, markdown rendered, copy path. Reading what an agent wrote is the common need.
- **Review diff viewer** inside the existing review card, with jump-to-finding, commit standing and evidence images.
- **Pipelines, runs first**: list with On/Off, Waiting for me, run detail with every NeedBox action, steps, transcript, Run now, delete and clear ended runs, history read-only. The definition as a node list.
- **Dispatch settings**: approval, model, agent for new sessions, rules, instructions, memory. **Phone push toggles** for the server. **Triggers** list with switch and Run now.
- **Prompt history** with diff and restore, and **Insights** with Suggest a better prompt.
- **Terminal dictation**.

Better left out, with reasons:
- **Pipeline builder and canvas editing**: three files, over 2,200 lines of drag, connect and per-kind forms; "Ask Dispatch" to change a pipeline already works from the phone (Dispatch proposes a `save_pipeline` step the phone can approve).
- **File editing**: the server supports a hash-guarded save, but editing code on a phone keyboard invites broken files; agents edit, people review. Revisit if asked.
- **Diff line notes**: the flow depends on precise line targeting and a desktop review habit; sending a plain message to the session covers it.
- **Machines, Mesh, Integrations, MCP, Agents install, Worktree setup, Diagrams, Security**: ssh onboarding, OAuth sign-ins, secrets and installs are computer tasks, and some (passcode, MCP token) are risky from a lost phone.
- **Branch switching, PR create, commit history**: no server routes.
- **Ports**: `localhost` links point at the computer.

---------------------------------------------------------------------------
## I. Suggested task breakdown and build order for step 3

Server first, then shared phone pieces, then screens. Each is one reviewable unit with tests and screenshots, in the style of docs/plans/mobile-app-step2.md.

1. **Server: pipeline counts and a brief runs list.** `StateView.runs_waiting`; `GET /api/runs?brief=1` (and `state=` filter) without definitions; tests in src/web/tests/pipeline.rs; web type update (web/src/lib/state.ts) and, if wanted, use the count for the web sidebar. Optional in the same task or a second one: the file bytes route (H.1 item 3) with tests for root checks, size cap and type sniff.
2. **Phone: API clients, types and routes.** Clients for changes, files, file search, history, merge, pipelines and runs (including transcript), insights, memory, triggers, phone notification settings, keep-awake, voice settings; `ApiClient.put` if pipelines settings or saves are in scope; notification route `{server}/pipeline?p=&run=` -> the run screen; vitest for each pure mapper (status letters, `flow`, `nodeState`, `asksForYou`, `triggerWords`, `stateWord`, port the web's model.ts logic).
3. **Phone: code viewing primitives.** A diff list (two line-number gutters, sign, sideways scroll, hunk and fold rows, paging "Show N more", binary/cut/notes states) on Orca's diff line values; a virtualised text viewer with line numbers and copy; markdown file preview through mobile/src/markdown; gallery entries in light and dark.
4. **Phone: Changes screen.** Entry from the session menu ("Changes", with count when known), the machine row menu and a folder picker; branch line, Staged and Changes sections, swipe Stage/Unstage/Discard with the web's confirms, row tap -> diff screen (with a files sheet to step through files), commit box with Draft, primary button per the web's rule, split menu Commit, Commit & Push, Push, Pull, Fetch, Refresh; poll every 5 s while focused; 422 messages shown whole.
5. **Phone: Files screen.** Lazy tree with status colours, dotfiles toggle (kept per phone), Names/Contents search, open in the viewer (text, markdown with a source/preview toggle, "binary" and "too large" states; images if task 1 added the route), copy path and relative path. Read-only.
6. **Phone: review and scan viewer.** In ReviewCard: Changes panel (list, file pages of 400 lines, base note, moved warning), finding place links that open the file at the line, scan Files panel, commit standing line, evidence thumbnails with a full-screen pan-zoom view.
7. **Phone: Pipelines list and runs.** Home entry (Feed row with `runs_waiting`, and a place in Home tabs or the Dispatch header menu), list with On/Off and run counts, Waiting for me, pipeline screen with Runs and History (read-only) and the node list, run detail (NeedBox with every action and the token raise, HeldBox, token bar, steps timeline, report, history, chips for ticket, PR, conversation), transcript sheet, terminals open the session screen, Stop session, Drop, Delete run, Clear ended, Run now sheet (tickets, PR links, diagram list for manual pipelines). Dispatch list rows gain the pipeline mark from the brief runs list.
8. **Phone: Dispatch extras.** Saved prompt history screen (versions, word diff with DiffBlock, Restore, Reset to the default); Insights sheet from the Dispatch session card, the session screen menu and the machine row menu, with Suggest a better prompt (asks with `improve`); Review branch in the session and machine row menus.
9. **Phone: server settings.** Settings > per server: Dispatch (agent, model with search, agent for new sessions, approval, rules editor in a BottomDrawer, instructions with counter, memory list with cap bar and history), Phone notifications (the server toggles and the wait minutes), Triggers (switch, Run now, opens the conversation it starts), and optionally Power, Voice basics (mode, language, fillers), Health toggles. Re-read before each save; show what is computer-only as a footer.
10. **Phone: terminal dictation and small session actions.** MicButton in the LiveInput row (Attach steps aside while recording), words pasted through the WebView without Enter (or the compose sheet if the plan picks it); Merge PR row with confirm when the PR is ready; Open a shell (optional).
11. **Build, notices, release prep.** THIRD_PARTY_NOTICES.md for any new package, regenerate notices, `npm run build` in web/ if the web changed, version bump, changelog, apk build, a phone check of the Review Focus items, release with the user's approval.

Order notes: task 3 before 4, 5 and 6 (they all render through it). Task 2 can land with task 1. Tasks 7, 8, 9 and 10 are independent of each other once 2 is in.
