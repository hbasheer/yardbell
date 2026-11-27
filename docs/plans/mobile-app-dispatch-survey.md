# Phone app step 2: Dispatch and the Inbox (Proposals). Survey

Read-only research. Sources: web/src/dispatch/*, assets/dispatch*.js (the legacy cards the React page still renders), src/web/mod.rs and src/web/*_api.rs, src/dispatch*, src/proposals.rs, src/phone/*, mobile/ (this branch), and Orca at /home/hbasheer/Projects/orca/mobile (MIT). Line numbers for Orca are in the files named. Theme tokens, sheets and the Home screen are already covered in docs/plans/mobile-app-orca-survey.md (sections 2, 6.8, 7) and are not repeated except where a value is new.

---------------------------------------------------------------------------
## 0. Read this first

1. **Auth already works for every route.** The guard (src/web/mod.rs, around line 387) accepts `Authorization: Bearer <device token>` on any path and skips the Origin check for non-GET requests when the bearer is valid. So every endpoint below can be called from the phone as is. No cookie, no Origin header.
2. **Dispatch streams a turn over a plain POST, as NDJSON, not SSE or WebSocket.** `POST /dispatch/ask` returns `application/x-ndjson`, one JSON object per line, until the turn ends. The phone needs a streaming `fetch`. React Native's built-in fetch does not expose a body stream. Expo SDK 58 ships `expo/fetch` (present in mobile/node_modules/expo/fetch.js, `FetchResponse.stream` is a `ReadableStream`), which does. The mobile app does not use it yet (grep finds no `expo/fetch`).
3. **A turn survives the phone going away.** The server runs each conversation on its own task (`Dispatch::turn`, `live` channel is `try_send`). If the stream drops, the conversation keeps going and `GET /dispatch/conversations/{id}` shows `busy: true` then the finished events. The web page already polls every 2 s while busy (`watch()` in DispatchPage.tsx). The phone should do the same, so a backgrounded app never loses a reply.
4. **Dispatch's approval cards are not a separate API.** They are `role: "action"` events inside the conversation, decided with `POST /dispatch/conversations/{id}/actions/{action}`. The Proposals inbox reuses the identical card and the identical decision body, only against `/api/proposals/{id}`. One native "step card" component serves both screens.
5. **Orca's chat cannot be copied file for file.** Its native chat imports 385 distinct modules from the Orca desktop repo (`../../../../../../src/shared/...`, for example native-chat types, tool fold, row projection, markdown math rules). Those are not in the MIT mobile folder. Copy the visual values and layout, and rebuild the data layer around Yardbell's event list. Section D lists what is safe to lift.
6. **Two small server/web findings** (section E): `StateView.proposals` is a number but the web type says `unknown[]` so the web sidebar badge reads `.length` of a number and shows nothing; and neither a new proposal nor a new Dispatch step calls `state.touch()`, so `/state/live` does not ping for them.

---------------------------------------------------------------------------
## A. Yardbell web Dispatch (what the phone has to match)

Files: web/src/dispatch/DispatchPage.tsx (1274 lines), Composer.tsx (890), model.ts (122), legacy.ts (204, loads lit-html cards from assets/dispatch-review.js, dispatch-group.js, dispatch-pull.js, dispatch-scan.js, dispatch-tasks.js, voice.js, attachments.js). Approval/review/PR/group/scan cards, dictation and the scan dialog are the legacy JS, so their exact behaviour lives in assets/.

### A.1 Screen layout (DispatchPage.tsx)

- Two columns. Main (header 48 px high, scrolling transcript `max-w-3xl`, composer) and a right sidebar `w-72` that holds two tabs, **Chats** and **Saved prompts**, a search box, a "New chat"/"New prompt" button and a footer ("Clear all" / "Restore default prompts"). Sidebar is hidden on phones (`max-md:hidden`), so the phone design replaces it with a list screen.
- Header: conversation title (or "New conversation"), a trigger alarm icon when the chat was started by a trigger, "New" (small screens), "Settings" (opens Settings, Dispatch section), toggle for the sidebar.
- When the open chat tracks sessions and the sidebar is hidden, a strip lists "Sessions" with a coloured dot (red stopped on an error, amber needs you, green working, grey idle/ended), the session name (tap opens it in the Workspace) and "machine · word". With the sidebar shown, the same list nests under the open chat row.
- Empty conversation ("intro"): icon tile, "What should your agents work on?", one explanatory paragraph, up to 6 saved-prompt "starters" (two-column grid, name + 2-line text, tap puts the text in the composer, does not send), and a footer "Runs <Agent> (<Model>) with Yardbell's own tools; it starts, reads and answers sessions, never edits files itself. Type / for a saved prompt, @ to name a machine, session or folder."
- A note appears when an open chat's backend differs from the current default ("This conversation runs on Codex (...), so it carries on there. New conversations start on ...").
- "Working" indicator at the end of the transcript while `busy`: three bouncing dots (150 ms stagger) + the word Working.

### A.2 Conversations list (sidebar, Chats tab)

- Source: `GET /dispatch/conversations` returns an array, newest `updated` first: `{id, title, updated (RFC3339), busy, waiting (count of pending steps), trigger (name or null), backend}` (src/dispatch.rs:168). Title is the first line of the first user message, cut at 80 characters with an ellipsis (store.rs `title_of`).
- Extra: `GET /api/runs` -> `{runs:[{conversation?...}]}` marks chats that belong to a pipeline run (Workflow icon).
- Row: title (13 px, 500), sub-line: pipeline icon, trigger icon, then "working" (pulsing green dot) or "N waiting for you" (amber dot) or "x min ago". The tab icon carries an amber count of chats with waiting steps.
- Search: client-side, title substring, case-insensitive. No server search.
- Delete: X button on hover -> confirm "Delete this conversation?" -> `POST /dispatch/conversations/{id}/delete` body `{}`. Refused with 409 "this conversation is still answering, stop it first" if busy.
- Clear all: confirm -> `POST /dispatch/clear` body `{}` -> `{kept}` (busy conversations are kept; toast says how many).
- **No rename, no archive, no grouping, no pinning.** Titles are fixed. Order is only by `updated`.
- Refresh: every 5 s (`loadList`) when not busy, and after each turn.

### A.3 A conversation (transcript)

`GET /dispatch/conversations/{id}` -> `{id, title, updated, events[], sessions[], busy, trigger, backend}` (dispatch.rs:190). `sessions` is the tracked list `[{machine, name}]` the chat follows. `trigger` is `{name, task?, version?, what?, at?, slot?, url?}`. The whole event list is returned each time (no paging, no cursor). The page keeps `shown = {count, updated}` and replaces the list when `updated` changes or it grew. Invalid id -> 404 "no such conversation" (ids are 16 chars `[a-z0-9]`).

Event roles (all in `events[]`, and also streamed live):

| role | fields | web rendering |
|---|---|---|
| `user` | `text`, optional `attachments[{file,name,kind,size}]`, `by:"yardbell"`, `task:{name,version}`, `improve:{machine,name,task?}` | right-aligned grey bubble (`max-w-[85%] rounded-2xl bg-muted px-4 py-2 text-sm`), caption above it when `by`/`task`/`improve` is set ("Sent by Yardbell once the results were in", "Saved prompt X · version N", "Suggest a better prompt for NAME on MACHINE"); `improve` messages fold behind "What Dispatch was asked". Attachments as chips under the bubble (image thumbnail 56 px high or file icon + name). |
| `assistant` | `text` (markdown) | full-width markdown, `text-sm leading-relaxed`. If the previous user event had `improve` and the text holds a proposed prompt, two buttons: "Save as a new saved prompt", "Save as version N+1 of X". |
| `tool` / `tool_result` | `name`, `input` / `text`, `is_error` | read-only tools shown as one row of small chips (`LABELS`: list_machines "Checked machines", list_sessions "Checked sessions", list_folders "Looked for the repository", read_session "Read a session"; other names shown raw), each chip a `<details>` with a status dot (pulsing while running, green ok, red error) and the result in a mono box (max 256 px). Consecutive tool events share one row (`blocks()` in model.ts pairs a result with the first chip of its name still waiting). Tools in the CHANGING set are not chips, they become action cards (legacy path for old saved chats). |
| `action` | `id`, `tool`, `input`, `status` (pending, approved, edited, auto, rejected, withdrawn), `by` (dispatch, you, pipeline, yardbell, client), `at`, `decided`, `rule`, `original`, `result {ok,text,session?,at}`, `review`, `group`, `label`, `already`, `told` | the **step card** (A.5) |
| `group` | `id,title,gather,minutes,children[{label,step|refused,rule}],status (waiting, running, gathering, gathered, dropped),follow` | group card with approve/reject all |
| `results` | `group,title,why,children[{label,started,name,machine,path,branch,state,screen,result{status,summary,details[]}}],gather,follow` | results card with per-child badge and Review button |
| `session` | `machine,name,path,state (blocked, idle, ended),screen,options[{key,label}],answer{key,label,at},review` | session card (A.6) |
| `review` | `machine,name,of{...},verdict,summary,findings[{severity,place,text}],outcome` | review/scan result card (A.7) |
| `pull` | `kind (ci, conflict, comments), key, machine,name,path,branch, pull{number,url,title}, checks[], notes[], instruction` | pull request card with "Send to session" |
| `error` | `text` | red bordered banner with an alert icon |
| `done` | none | stream terminator, never stored |
| `conversation` | `id` | first streamed line only, tells the page the id of a new chat |

### A.4 Composer (Composer.tsx, tiptap based)

- Rich text box, one line min (`min-h-12`), max 8 lines. Placeholder "Ask Dispatch anything. @ names a machine, session or folder, / inserts a saved prompt".
- **`@` menu** (only at the start of a word): groups Machines (name, "up"/"down"), Sessions (tmux name; detail "agent on machine · folder · branch"), Folders (label; "on machine · branch"). Data comes from `GET /state` (`machines`, `sessions` with `tmux` and not `stale`, `folders[{label,machine,path,branch}]`), cached 15 s. Ranking: prefix 0, word prefix 1, contains 2, other fields 3. Max 40 items. A picked item becomes an atomic **pill**; the sent text carries the token (`token`, with " on <machine>" appended when the same name exists twice).
- **`/` menu**: saved prompts from `GET /dispatch/tasks`, ranked on name then text. Picking one inserts a pill that expands to the prompt text on send.
- **Attach**: `+` button, paste and drag-drop. Allowed: images (png, jpeg, gif, webp, detected by magic bytes), PDFs (`%PDF-`), text (valid UTF-8, no NUL). Limits (assets/attachments.js, mirrored in src/dispatch/attachments.rs:6-13): max 10 files, image 5 MB, PDF 32 MB, text 256 KB, 40 MB total, name 80 chars, no empty file, **PDF refused when the conversation's backend is Codex**. Thumbnails: image preview or file icon, index badge, name, size, remove X.
- **Approval chip** (shield icon + "Ask first" / "Go ahead" / "Refuse"): dropdown with the three modes and a link to Settings. Reads `GET /api/settings` (`dispatch.approval`, legacy names `ask`/`auto` map to prompt/allow) and writes via `POST /api/settings/dispatch` with the full settings object plus the change.
- **"..." menu**: Insert a saved prompt, Name a machine/session/folder, **Scan a folder** (legacy dialog), **Save as prompt**, Send with Enter / Ctrl+Enter (stored in localStorage `yardbell.dispatch.send`, default Ctrl+Enter on touch devices).
- **Model picker** (pill, right side): popover with search, list of models with description. Claude catalogue is hard-coded in web/src/lib/agent-models.ts (fable "Fable 5.2", opus "Opus 5.5", sonnet "Sonnet 5.5", haiku "Haiku 5.5", plus "Default"); Codex list is `GET /api/settings` -> `codex_models` plus a live list from `GET /machines/{host}/models?agent=...`. Choosing writes `{model}` or `{codex_model}` through `POST /api/settings/dispatch`. It is a **global Dispatch setting, not per conversation** (the conversation keeps its backend, takes that agent's model each turn). No effort control.
- **Mic**: shown always, enabled when `runs-on.voice_input`. Dictation records audio chunks and `POST /dispatch/transcribe` (raw audio body, `Content-Type` is the recorder's mime, default audio/webm, limit 25 MB) -> `{text}`, inserted at the cursor. `voice_mode` is hold or auto/toggle. If voice is off, a banner offers "Set up voice" (Settings).
- **Send / Stop**: round arrow-up when idle (disabled when empty and no files), round stop square while busy. Escape also stops. `POST /dispatch/conversations/{id}/stop` body `{}` -> `{ok:true}` (cancels the agent turn; sessions it started keep running).
- **History**: Arrow Up in an empty box walks back through the last 50 sent texts (localStorage). **Drafts** saved per conversation in localStorage (`yardbell.dispatch.drafts`).
- Send is refused with a toast while busy: "Dispatch is still working on the last message. Stop it or wait, then send." Server also answers 409 "this conversation is still answering".

### A.5 Step card (approval) behaviour (assets/dispatch-review.js)

States: pending, running, done, failed, rejected, withdrawn. Badge text: "Waiting for you", "Running", "Done", "Failed", "Rejected" ("Cancelled" when `by` is you), "Withdrawn". Titles (`stepTitle`): Start a session, Type into a session, Stop a session, Remove a worktree, Integrate branches, Push a branch, Move a session, Call a connected tool, Save a connection, Remember this / Change a memory / Forget a memory, Change Settings: AREA, Save the task NAME, Run the trigger NAME, New pipeline: NAME / Change the pipeline, Turn on/off NAME, Run NAME, Draw a diagram in FOLDER, Answer/Retry/Continue/Drop SUBJECT, Start a review, Start a scan.

Body per tool: start_session shows the task text with Show all/less (long when over 420 chars or 6 lines); send_to_session shows the text in mono; others show a one-line effect description. Reviews and scans add "Instructions for the reviewer/scanner" folded, and a read-only note. `change_settings`/`save_task`/`run_trigger` show a diff of before/after (`parts[]` with op add/del/same). `save_pipeline` draws a pipeline canvas (SVG, pan/zoom) and an "Edit in the builder" link. `save_connector` shows the connector JSON. Footer: outcome line, trail ("Proposed by Dispatch 14:02 · Your rule: start sessions on any machine · Approved 14:03"; "Proposed by NAME" for `by:"client"`; "Withdrawn ... when you sent a new message"), and actions.

Actions: **Reject** (Cancel when `by` is you), **Edit** (only start_session, send_to_session, change_settings, save_task, remember except forget), **Approve** ("Start session", "Send", "Start review", "Start scan" for steps the user asked for). "Open in Settings" link for change_settings. Editing form fields: start_session = Machine select, Agent select, Folder or Path text, Branch text, "Create the branch" checkbox plus From, Task textarea; send_to_session = Text textarea; change_settings = JSON textarea; save_task = textarea; remember = textarea (500 chars). After an edit the card says "Edited before it ran: you changed the machine and the task" and folds "What Dispatch proposed".

Waiting bar under the transcript: "N steps wait for your approval. Sending a new message withdraws them, so Dispatch can propose again." with **Approve all / Reject all** when more than one.

Outcome lines after running: start_session -> "Started NAME on MACHINE" + Open (terminal); worktree tools summarise from the JSON result; integrate_branches that stops at a conflict shows "Stopped at a conflict".

Steps are **withdrawn** by the server when the person sends the next message (`actions::withdraw`), and steps interrupted by a restart are marked ("Check the session list to see whether it ran").

### A.6 Session card

Header: terminal icon tile (amber when blocked), name, "on MACHINE · folder", badge (Waiting for you / Stopped / Ended / Answered). Body: last screen lines (`readable()` strips box-drawing rules and the left margin; only the last 4 lines unless "Show all N lines"). Footer: the agent's numbered **choices as buttons** (option "1" is primary, labels cut at the preview box by `optionLabel`), then **Review branch**, **Scan** menu (dead_code, test_gaps, security) when idle or ended, **Insights**, **Open**. After answering: "You answered X at HH:MM". Answering = `POST /dispatch/conversations/{id}/answers` body `{card: index, key: "1"}` (card is the event index). 400 "not one of its choices"; 409 "it was already answered with X" (page then re-fetches).

### A.7 Other cards

- **Review / scan result card** (`role: review`): verdict, summary, findings by severity (High/Medium/Low, low ones unticked by default), pick findings, then **Send to session** (`POST .../reviews/{index}` `{decision:"send", findings:[i...], to?}`), **Start a new session** for scans (`decision:"start"`, returns `{card, step}`), or **Dismiss** (`decision:"dismiss"`). A diff viewer lazy-loads `GET .../reviews/{index}/diff` (and `/files` for scans) with `?file=&from=&line=`. Also `GET .../reviews/{card}/commit` (does the code still match) and `.../evidence/{file}`. Phone can start with the list of findings and defer the diff viewer.
- **Review request** from a session card: `POST /dispatch/conversations/{id}/reviews` `{card}` or `{card, child}` -> a pending action event (waits for approval). From session lists elsewhere: `POST /dispatch/reviews` `{machine,name}` -> `{conversation, step}` and starts at once.
- **Scan request**: `POST /dispatch/scans` `{conversation?, card?, machine, folder, inside, path, branch, kind}` -> `{conversation, step}`.
- **Pull request card**: "Send to session" -> `POST /dispatch/conversations/{id}/pulls` `{card, text?}` -> `{card, step}` (rules apply, may refuse with a message that names the rule).
- **Group card**: children list with per-child step state; "Approve all / Reject all" -> `POST .../groups/{group}` `{decision}` returns the decided events. Results card: summary and details per child, Review button per child (`POST .../reviews` `{card, child}`).
- **Trigger header**: card "Started by the trigger NAME" with saved prompt/version, what, time (server time), "late for HH:MM" when 2+ minutes behind slot, buttons Open ticket, Triggers (Settings), Turn on/off (`POST /api/triggers/enable` `{name, enabled}`; `GET /api/triggers` -> `{triggers:[{trigger:{name,enabled}}]}`).

### A.8 Saved prompts ("tasks" in the server, "Saved prompts" in the UI)

- `GET /dispatch/tasks` -> `[{name,text,version,builtin?,customised?,hidden?}]`. Hidden ones are the deleted defaults.
- Tap a prompt in the sidebar = **runs it** (`ask(text, {task:{name,version}})`). A starter on the intro screen only fills the composer.
- Create/edit: name (max 60), text. `POST /dispatch/tasks` `{name, text, replacing}` -> full list. Delete: `POST /dispatch/tasks/delete` `{name}` -> list (defaults go hidden). `POST /dispatch/tasks/restore` `{}` -> list.
- Versioning: each save of changed text makes version N+1. `GET /dispatch/tasks/history?name=` -> history; `GET /dispatch/tasks/diff?name=&from=&to=` -> `{name,from,to,parts[]}`; `POST /dispatch/tasks/versions/restore` `{name, version}` -> `{tasks, history}`. The history dialog is legacy JS (dispatch-tasks.js).
- "Improve prompt" flow: Insights on a session asks Dispatch to suggest a better prompt (`improve` mark), the assistant reply gets Save buttons.
- These are **not scheduled work**. Scheduled and event work is **Triggers** (`/api/triggers`, `/api/triggers/run`, `/api/triggers/enable`) and **Pipelines** (`/api/runs`, pipeline_api.rs). The web Dispatch page has no triggers list; it links to Settings.

### A.9 Settings that touch Dispatch (Settings page, Sections.tsx 963 onward, not the Dispatch page)

- `GET /api/settings` -> includes `dispatch` (DispatchSettings: `instructions`, `agent`, `runs_on` claude|codex, `model`, `codex_model`, `approval` prompt|allow|deny (legacy "ask"/"auto" on disk), `rules[]`), `codex_models`, `dispatch_runs_on`.
- `POST /api/settings/dispatch` takes the full object (server replaces it): `{instructions, agent, runs_on, model, codex_model, approval?, rules:[{action, machine, folder, approval}]}`.
- **Rules UI**: "When Dispatch wants to [step] on [machine or any] in [folder] then [allow/ask/deny]". Deny always wins, otherwise the most specific rule wins. Steps and wording: RULE_STEPS in Sections.tsx. Steps without a place (UNPLACED): save_connector, call_connector, remember, change_settings, save_task, run_trigger, save_pipeline, set_pipeline_enabled, run_pipeline, answer_run.
- **Instructions**: textarea added to Dispatch's prompt.
- **Memory**: `GET/POST /dispatch/memory` (entries up to 500 chars, size cap bar, add/replace/forget).
- **Usage**: `GET /dispatch/usage`, `POST /dispatch/usage/refresh`, `GET /api/usage/stats` (not on the Dispatch page itself).
- `GET /dispatch/runs-on` -> `{runs_on, label, model, agents:{claude:{label,model},codex:{...}}, voice_input, voice_mode}` (the composer's source for pickers and the mic).

### A.10 Speak replies toggle

Only in the legacy page (assets/dispatch.js:556-590, `speaker()` and `spoken()` in assets/voice.js). It uses the browser's `speechSynthesis`, stored per browser in localStorage (SPEAK_KEY "1"), and reads: each assistant message (markdown stripped to prose, code blocks and tables summarised), each error ("Dispatch hit an error. ..."), and a blocked session ("Session NAME on MACHINE is waiting for an answer."). **The React page does not have the toggle at all** (grep for speak in web/src finds only a Settings sentence about languages). It is purely client side, so nothing on the server backs it. A phone version needs `expo-speech` (not installed) and its own persisted switch.

### A.11 Endpoint table (everything the phone Dispatch screens would call)

Streaming and conversation:

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /dispatch/ask | `{conversation?: id, text, task?:{name,version}, improve?:{machine,name,task?}, attachments?:[{name, data: base64}]}` (limit 56 MB after base64, `ASK_LIMIT`) | 200 `application/x-ndjson`, `Cache-Control: no-store`; line 1 `{"role":"conversation","id"}`, then events (`assistant`, `tool`, `tool_result`, `action`, `group`, `session`, `error` ...), last `{"role":"done"}`. 400 on bad attachment, 409 "this conversation is still answering", 409/400 "type a task first" if no text and no files. |
| GET | /dispatch/conversations | | list (A.2) |
| GET | /dispatch/conversations/{id} | | conversation (A.3) |
| GET | /dispatch/conversations/{id}/attachments/{file} | | the bytes, correct `Content-Type`, `immutable` cache, CSP none except PDF |
| POST | /dispatch/conversations/{id}/stop | `{}` | `{ok:true}` |
| POST | /dispatch/conversations/{id}/delete | `{}` | `{ok:true}` or 409 |
| POST | /dispatch/clear | `{}` | `{kept}` |
| POST | /dispatch/transcribe | raw audio, `Content-Type` = mime | `{text}` (25 MB) |
| GET | /dispatch/runs-on | | picker and voice flags |

Decisions on cards:

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /dispatch/conversations/{id}/actions/{action} | `{decision:"approve"|"reject", input?: edited input, again?: bool}` | the updated action event (`status`, `result`). Approve runs the tool detached, so a dropped connection still records the result. |
| POST | /dispatch/conversations/{id}/actions | `{decision}` (no `input`) | array of decided events, one at a time in order |
| POST | /dispatch/conversations/{id}/groups/{group} | `{decision}` | array |
| POST | /dispatch/conversations/{id}/answers | `{card: index, key}` | updated session event |
| POST | /dispatch/conversations/{id}/reviews | `{card, child?}` | pending action event |
| POST | /dispatch/conversations/{id}/reviews/{card} | `{decision: send|start|dismiss, findings?:[i], to?}` | updated review event (or `{card, step}` for start) |
| POST | /dispatch/conversations/{id}/pulls | `{card, text?}` | `{card, step}` |
| POST | /dispatch/reviews | `{machine,name}` | `{conversation, step}` |
| POST | /dispatch/scans | see A.7 | `{conversation, step}` |

Saved prompts, memory, settings: GET/POST /dispatch/tasks, POST /dispatch/tasks/delete, /restore, GET /dispatch/tasks/history, /diff, POST /dispatch/tasks/versions/restore, GET/POST /dispatch/memory, GET /api/settings, POST /api/settings/dispatch, GET /machines/{m}/models?agent=, GET /api/triggers, POST /api/triggers/enable.

Composer data: `GET /state` (machines, sessions, folders), `GET /api/runs`.

Errors are `{error: "message"}` with a status code. The existing mobile client (mobile/src/api/client.ts `send`) already reads `error`. A 401 with a bearer means signed out.

---------------------------------------------------------------------------
## B. Proposals (the Inbox)

Server: src/proposals.rs (store), src/web/proposals_api.rs (routes), src/mcp.rs `client_proposal` (producer). Web: assets/proposals.js (legacy lit page at `/proposals`, shown in the React shell through `pages.ts` `legacy: '/proposals'`; the sidebar item is hidden unless the count is above 0). There is **no React proposals page**.

### B.1 What a proposal is

A change an **outside MCP client** (Claude Code, Codex, Cursor and so on, connected to Yardbell's `/mcp`) asked for, kept until the person decides. It is shaped exactly like a Dispatch action event:

```
{ role:"action", id (8 chars), tool, input, status:"pending", by:"client", from:"<client name from its User-Agent>", at, decided?, original?, result?{ok,text,at,session?} }
```

Only these tools wait as proposals (`WAIT_FOR_PROPOSALS`, mcp.rs): save_connector, change_settings, save_task, run_trigger, save_pipeline, set_pipeline_enabled, run_pipeline, answer_run. So an inbox card is one of: a connection to save, a Settings change, a saved prompt, a trigger run, a pipeline definition (with canvas), a pipeline enable toggle, a pipeline run, or an answer to a waiting pipeline run. start_session and the other session tools are never proposed this way. Limits: at most 100 waiting (429 for the 101st), 256 KB per proposal (413). The approval setting `deny` or a refusing rule rejects at proposal time (403); nothing ever auto-runs, whatever the settings.

Retention: decided proposals are pruned 30 days after the decision; a waiting one stays until decided. File is mode 0600.

### B.2 Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/proposals | optional `?opened=1` | `{proposals:[...newest first], waiting:n}`. `opened=1` marks "the person has seen what waits" and re-arms the phone push (see C). The page's own periodic refreshes omit it. |
| GET | /api/proposals/{id} | | one proposal, 404 "there is no such proposal" |
| POST | /api/proposals/{id} | `{decision:"approve"|"reject", input?: edited}` | the updated event. Approve with `input` first validates it (`mcp::check`, 400 with a readable reason), records `status:"edited"` + `original`, then runs the tool detached and stores `result`. 409 "this proposal was already approved" if decided. |
| DELETE | /api/proposals/{id} | | `{deleted:id}` (a waiting proposal is discarded and nothing runs) |
| POST | /api/proposals/clear | `{}` | `{cleared:n}` (decided ones only) |

No Approve-all endpoint for the inbox (the web page has none either).

### B.3 Web page behaviour

Segmented tabs All / Waiting (count) / Decided (count); column list "Waiting n / Decided n" with anchors; sections "Waiting for you" and "Decided" (with "Clear" in its header); each item is a step card plus a "Delete" button (confirm "Delete this proposal?", copy differs when waiting: "It has not run, and it will not."). Empty text: "Nothing waits for you. Changes that MCP clients ask for land here." / "Nothing waits for you." / "Nothing decided yet." Refresh: every 5 s while no card is being edited, and on `visibilitychange` (with `opened=1`). Trail on a card reads "Proposed by <from> <time>". Editing is allowed for save_task, change_settings, remember; save_pipeline offers "Edit in the builder" (`/pipeline?proposal=inbox.<id>`), which the phone cannot offer.

### B.4 How the count reaches the UI

`GET /state` sets `view.proposals = app.proposals.waiting()` (mod.rs:961). It is a **number**, `StateView.proposals: usize` (src/state.rs:158), asserted as `state["proposals"] == 2` in src/web/tests/proposals.rs:458. The mobile `StateView` type (mobile/src/state/types.ts) does not declare it yet, so step 2 adds `proposals?: number`. Note the web bug: web/src/lib/state.ts types it `proposals?: unknown[]` and Sidebar.tsx:236 reads `state?.proposals?.length ?? 0`, which is `undefined` for a number, so the web badge shows 0. Not the phone's problem, but the phone must read it as a number.

---------------------------------------------------------------------------
## C. Notifications today

Mechanism: `NotifyService.kt` (mobile/modules/yardbell-notify/android) holds a long poll on `GET /app/notifications?boot=&after=` per paired server (server holds it up to 50 s, `APP_POLL`), posts one Android notification per item `{title, message, priority, tags, click}`, and the tap carries `click` as an extra to the launch intent. JS side: `addOpenListener` and `getInitialLink` (modules/.../index.ts) deliver the link, then `mobile/src/notifications/route.ts` `routeForLink(link, servers)` maps it.

What the server pushes today (inbox.add callers: src/cli.rs:185 for session events, src/mcp.rs:515, src/pipeline/run.rs:1852):

| Source | Title / message | `click` link | Toggle (cfg.phone_notifications) |
|---|---|---|---|
| Session events (idle/waiting, ended, machine down/up, memory, PR CI failed/conflicts/ready/merged/closed, limit reset) | per event | `{base}/term/{machine}/{tmux}` when the event has a tmux name, else `{base}/` | agent_waiting, session_ended, machines, memory, pull_*, limit_reset |
| New MCP proposal | "Yardbell proposals" / "A proposal from {client} waits for you" | `{base}/proposals` | `proposals` (rate limited: one push per 5 minutes until the person opens the inbox, `Proposals::should_push`, re-armed by `GET /api/proposals?opened=1`) |
| Pipeline notes | "Yardbell pipelines" / text | `run_link(base, run)` | pipeline_waiting, pipeline_finished |

**Dispatch has no notification of its own.** A step waiting for approval in a conversation does not push. The nearest thing is the session event "agent waiting" (a session started by Dispatch that is blocked) and the `session` card the chat gets. A Dispatch reply finishing does not push either.

Routing today: `routeForLink` only understands `{server}/term/{machine}/{tmux}` and sends everything else, including `/proposals`, to `/` (Home). Step 2 should add:

- `{server}/proposals` -> inbox route, for example `/inbox/{serverId}` (and a bare `/inbox` when only one server is paired).
- `{server}/dispatch?c={conversationId}` -> `/dispatch/{serverId}/{conversationId}` if a Dispatch push is added. The link format already exists on the web (`/dispatch?c=ID`, `/ui/dispatch`).
- `{server}/pipeline?p=ID&tab=...` stays on Home until pipelines are on the phone.

Server work for Dispatch pushes (optional, see E): add a `Push` with `click: {base}/dispatch?c={id}` when a conversation gets its first pending step, and perhaps when a busy conversation finishes while the phone has been away. Config would need a new `phone_notifications.dispatch` boolean, which needs a Settings control (memory rule: every configurable feature needs a Settings section).

---------------------------------------------------------------------------
## D. Orca mobile: what to copy for these screens

Orca root: /home/hbasheer/Projects/orca/mobile/src. Orca's chat is an in-session screen for coding agents (and "bots"). Yardbell Dispatch is a chat with a coordinator, so the **transcript, composer, prompt cards, sheets and list rows map well; the data layer does not**.

### D.1 Dependencies (Orca mobile/package.json) vs Yardbell's mobile/package.json

Already in Yardbell: expo ~58.0.22, expo-router, react 19.3.0, react-native 0.88.1, reanimated 4.7.1, gesture-handler ~3.3.0, safe-area-context, screens, svg 15.16.0, expo-image-picker ~58.0.10, expo-document-picker ~58.0.5, expo-clipboard ~58.0.4, expo-haptics, lucide-react-native ^1.14.0, @tanstack/react-query 5.107.1, webview 14.0.1.

To add for Dispatch:

| Package | Orca version | Needed for | Notes |
|---|---|---|---|
| markdown-it | ^14.3.3 | assistant message markdown | Orca parses with markdown-it into a tree (components/markdown/parsing/mobile-markdown-tree.ts) and renders native Text/View, no WebView. |
| @types/markdown-it | 14.1.2 (dev) | types | |
| markdown-it-footnote | ^4.0.0 | footnotes (skip) | optional |
| markdown-it-cjk-friendly | ^2.0.3 | emphasis next to CJK (skip) | optional |
| remend | 1.4.0 | closes unfinished markdown while streaming | useful for partial assistant text |
| lowlight | ^3.3.0 | code block highlighting | used by files/session-documents/mobile-file-syntax.ts (`common, createLowlight`), imported by MobileMarkdownCodeBlock. Skip in v1 and show plain mono if size matters. |
| katex 0.18.10, mermaid 11.17.2 | | math and diagrams | **skip**, they feed WebView page builders in postinstall |
| expo-speech | not in Orca | Speak replies | Orca has no TTS; needed for A.10 |
| expo-audio (or expo-av) | Orca uses its own `@orca/expo-two-way-audio` | dictation | not installed in Yardbell. Yardbell dictation is record, upload, `POST /dispatch/transcribe`, so a plain recorder plus the existing permission flow is enough. Needs RECORD_AUDIO in app.config.ts. |
| expo/fetch | part of expo | streaming `/dispatch/ask` | no install |

Not needed: i18next (Orca strings go through `t('key','English')`; Yardbell mobile has no i18n, inline the English), zod, expo-notifications (Yardbell has its own notify module), @noble/hashes, libsodium, xterm (already via terminal).

### D.2 Component inventory

All paths under /home/hbasheer/Projects/orca/mobile/src. Colour names are tokens from theme/mobile-theme.ts (values in the earlier survey section 2); new ones here: dark `chatUserSurface #262626`, `chatUserBorder rgba(250,250,250,0.06)` (mobile-theme.ts:35-36); light `#f5f5f5`, `rgba(10,10,10,0.07)` (127-128); `composerSurface` dark `#1f1f1f`, light `#ffffff`; `composerBorder` dark `rgba(250,250,250,0.09)`, light `rgba(10,10,10,0.11)`; `composerControl` dark `#262626`, light `#f5f5f5`; diff colours `chatDiffAdded/Removed`, `diffAddedBg` (rgba(46,160,67,0.15) dark, #dafbe1 light).

**1. Transcript list and message rows**

- Row frame: session/native-chat/transcript/messages/mobile-native-chat-message-styles.ts. `row` paddingHorizontal 16, paddingVertical 8 (lines 17-20); `rowUser` alignItems flex-end (21); `content` gap 8; **`userBubble`**: maxWidth 88%, bg chatUserSurface, borderWidth 1, borderColor chatUserBorder, radius 16 (`radii.surface`), padding 12 x 8 (28-36); assistant text has **no bubble**, full width, `agentMessage` variant (left border 2 px borderSubtle, paddingLeft 12, lines 53-57) is only for messages from another agent. `TEXT_SIZE = 17`, `CHAT_PROSE_SCALE = 1.25` (lines 5-6), `MONO_SIZE = 12`. `scaledType(size, fontScale, leading=6)` gives `lineHeight = size + 6` (lines 9-11). `unsentNotice` 12 px statusRed. `imageThumb` 200 x 150, radius 16, hairline border (lines 97-103). Reasoning row: opacity 0.7, `reasoningBody` maxHeight 240.
- Row assembly: transcript/messages/MobileNativeChatMessage.tsx (416 lines). Entry point `MobileNativeChatMessageImpl`; its props and projection types come from `src/shared/native-chat/*`. **Do not copy the file**, copy the visual rules. Inline text selection and long-press actions: MobileNativeChatMessageActionsSheet.tsx (158 lines): "Copy message", "Select text", "Close".
- Prose: transcript/message-content/MobileNativeChatProse.tsx and MobileNativeChatMarkdown.tsx (11 lines, a thin wrapper over components/markdown/MobileMarkdown).
- Message time + copy: MobileNativeChatMessageMeta.tsx (35), MobileNativeChatMessageTime.tsx (49).
- Scroll viewport (long, 18 files): transcript/viewport/*, tail follow in use-mobile-native-chat-tail-follow.ts (295), place keeper, pinch zoom. For Yardbell a plain inverted `FlatList` with a "scroll to bottom" floating button is enough. The floating button is `fab` in mobile-native-chat-view-styles.ts: 38 x 38, pill, bg bgRaised, hairline borderSubtle, right 12, bottom 12 (`floatingControls`). `listContent` paddingVertical 8. Empty state: `emptyTitle` bodySize 600 textSecondary, `emptySubtitle` metaSize textMuted, centred, padding 24.
- Maps to: Yardbell `user`, `assistant`, `error` events.

**2. Markdown renderer** (components/markdown, 4795 lines total with blocks, parsing, math, links)

- Entry: components/markdown/MobileMarkdown.tsx; tree builder parsing/mobile-markdown-tree.ts (markdown-it + cjk-friendly + footnote + remend); blocks in blocks/mobile-markdown-blocks.tsx (395 lines); styles components/markdown/mobile-markdown-styles.ts: `root` gap 12 (md); `paragraph` 13/21; `heading` 14/21 weight 700; `headingLarge` 16/23; `headingTitle` 18/25; `bold` 700; `link` accentBlue underlined; `inlineCode` mono 12, bg bgRaised, hairline border (lines 8-50). Note this is a **13 px base used in file previews; the chat scales it** via `useNativeChatProseText` (preferences/native-chat-text-settings) with `TEXT_SIZE 17` and a 1.25 prose scale. For Dispatch use 16/24 body.
- Code block: blocks/MobileMarkdownCodeBlock.tsx, with copy button (components/code-presentation/MobileSourceCopyButton.tsx), word-wrap toggle (`TextWrap` icon), language label, horizontal ScrollView, highlighting through `highlightMobileCode` (lowlight).
- Dependencies on Orca's `src/shared`: about 20 modules (markdown-math-rules, github-callouts, github-reference-links, prose-url-boundary, bot-card kind, file-link existence/routing...). A Yardbell port should write a **small markdown-it tree walker** (paragraph, heading, list, code, blockquote, table, link, inline code, hr) and drop math, callouts, mermaid, footnotes, bot cards, Slack tokens.
- Maps to: `assistant` events and plan/summary text in cards.

**3. Tool-call rows**

- transcript/tool-results/MobileNativeChatToolLine.tsx (290): a line `minHeight 26`, gap 8, icon slot, verb in textMuted, target in textPrimary, trailing meta + `ChevronRight 14` (caret rotates 90 deg when open). Icons: MobileNativeChatToolIcon.tsx (44) maps names to lucide `Eye, Search, Folder, SquareTerminal, Pencil, Globe, Plug, Bot, ListChecks, Wrench, MessageSquareMore, Brain`, size from `iconSize`, strokeWidth 2. Group header: `MobileNativeChatToolRun.tsx` (365) with `header` row gap 6, paddingVertical 3, members indented `marginLeft 7, paddingLeft 13` with a hairline left border (mobile-native-chat-tool-styles.ts:20-45); detail pane `marginLeft 24`; `codeBox` radius 16, hairline border, bg bgPanel, padding 8; `codeScroll` maxHeight 256; error text statusRed (lines in mobile-native-chat-tool-styles.ts, 22-250).
- Maps to: Yardbell's read-only tool chips (`tool`/`tool_result`, LABELS). Use one collapsible run "Checked machines, read a session" with per-tool lines (list_machines -> Server icon, list_sessions -> SquareTerminal, list_folders -> Folder, read_session -> Eye) and the result in a codeBox (max 256). Status: pending spinner, ok, red on `is_error`.
- Diff card for turn changes (MobileNativeChatDiffCard.tsx, MobileNativeChatTurnDiffRollup.tsx): **no counterpart**, Dispatch never edits files.

**4. Turn status and live line**

- transcript/messages/MobileNativeChatTurnStatus.tsx (143) and MobileNativeChatLiveLine.tsx (107): while the agent works, a line with `LoadingSpinner` 15 px textMuted, a sentence ("Working", elapsed) and `ChevronRight 14`; after the turn "Worked for 1m 12s". Maps to Yardbell's "Working" indicator with the three bouncing dots; use the spinner version and the elapsed time (client side timer from send).

**5. Prompt cards: permission and ask** (map to Yardbell **step cards** and **session choices**)

- Container: session/native-chat/input/prompts/MobileNativeChatPromptCard.tsx (279). Slot rules: `shown` flexShrink 1, **maxHeight 60%** of the lower region, `answering` 100% when the keyboard is up; the card **rises from the composer's edge** (translateY from its own height to 0, duration `SHEET_HEIGHT_DURATION_MS`, easing bezier `SHEET_CURVE`; reduced motion = 200 ms fade). This is Orca's mechanism: the card **replaces the composer's position** while a question is pending.
- Card chrome: MobileNativeChatAsk.styles.ts (134 lines). `card`: marginHorizontal 8, marginBottom 6, bg composerSurface, radius 24 (floating), hairline border `floatingCardBorder`, overflow hidden (lines 17-27). `ASK_CARD_PADDING` 12; `ASK_CHOICE_RADIUS = concentricRadius(24, 12)` = 12. `questionText` marginVertical 10. Footer: row, space-between, paddingTop 8, paddingHorizontal and paddingBottom 12, gap 8. Buttons `next`: minHeight 44, paddingHorizontal 16, radius 12, **solid textPrimary fill with bgBase text 16/700**; `nextSkip`: transparent with `choiceBorder` outline and textPrimary text. `notice` statusRed 12 centred. Tabs for multi-question asks: `tab` minHeight 36, active underline 2 px statusGreen.
- Permission card: MobileNativeChatPermission.tsx (383). Title (body size, weight 500) with a `ICON_SIZE 16` icon at marginTop 13; header actions (collapse chevron-down 16, cancel X 16, each 28 x 28; MobileNativeChatCardHeaderAction.tsx); context lines `line` 13/18 textSecondary with bold labels ("Reason: ", "Needs access to: "); `codeBox` paddingV 10, paddingH 12, radius 12, hairline border, bg bgRaised; "Details" row with `ChevronDown 14` that reveals the rest; options rendered as the footer buttons (first = primary unless `neutralOptions`), declines styled as `declineText`. Its **options scroll separately** (`answersScroll`) so many choices stay reachable.
- Collapsed strip: MobileNativeChatPromptStrip.tsx (58) when the user collapses a pending prompt.
- Maps to: Yardbell step card (Approve / Edit / Reject, plus Approve all for N pending) and session card choices (numbered options as buttons). **Differences to design**: Yardbell can have several pending steps in a transcript at once and they stay in the history with outcome, while Orca resolves one blocking prompt at a time. Use Orca's card chrome and footer buttons for the **pending** state in the lower region (one at a time, with "1 of N" and Approve all/Reject all when N greater than 1), and an inline, collapsed **receipt row** in the transcript afterwards (Orca's MobileNativeChatResolutionReceipt.tsx, 362 lines, and MobileNativeChatAwaitingInputRow.tsx, 128, are the model for "waiting" and "answered" rows).
- Edit mode (Machine/Agent/Folder/Branch/Task) has no Orca counterpart as a card. Use Orca's text field styles (`field` minHeight 44, radius 12, border inputBorder) inside a BottomDrawer (see sheets).

**6. Composer**

- Group: session/native-chat/composer/MobileNativeChatComposer.tsx (405). Structure (lines 250-400): menu layer above, `composerInset` (paddingHorizontal 12, paddingTop 6, paddingBottom 8; composer/field/mobile-native-chat-composer-styles.ts:12-16), the **box** `composerInputStyles.box` (components/composer-input/composer-input-styles.ts:68-72): bg composerSurface, borderWidth 1, borderColor composerBorder, padding 12, **radius 24**. Inside: attachments strip, the text field, then `actionRow` (marginTop 8, row, gap 8, line 130-134).
- Text: `messageText` 16/22, minHeight 30, **maxHeight 7 lines = 154**, paddingHorizontal 6, paddingVertical 2 (composer-input-styles.ts:107-117). `COMPOSER_TEXT_SIZE 16` (keeps the keyboard from zooming on web). Focus ring `focused`: accentBlue 1 px outline.
- Controls (all round, 38 x 38, hit slop 3): `controlButton` bg composerControl; `ghostButton` no fill; `sendButton` bg `surfaceBright` (#171717 in light, light grey in dark; the survey has the exact pair), disabled bg composerControl. Send icon `ArrowUp` 19, strokeWidth 2.4, colour bgBase (components/composer-input/ComposerSendButton.tsx:35-38); Stop `Square` 13 filled textPrimary (session/native-chat/input/MobileNativeChatStopButton.tsx:31); the send slot swaps Send and Stop with an animation (input/mobile-native-chat-control-swap.tsx, 89 lines). Which one shows: `mobileNativeChatComposerShowsStop` (composer/field/mobile-native-chat-composer-layout.ts): Stop when the agent can be stopped and nothing is typed.
- Attach: composer/attachments/MobileNativeChatComposerAttachButton.tsx: `Plus 19` strokeWidth 2 in a ghost round button; tap opens an **ActionSheet** built by mobile-native-chat-attach-actions.ts with rows Photos (Image icon), Files (Paperclip, hint "PDF, text, code..."), Workspace file (AtSign), Skills (Package, "N available"), Commands (Terminal). Yardbell version: Photos (expo-image-picker), Files (expo-document-picker, PDF and text), and the `@` and `/` entries.
- Attachment strip: MobileNativeChatComposerAttachments.tsx (271): `THUMB_SIZE 58`, `ITEM_RADIUS = concentricRadius(24, 12)` = 12, strip marginBottom 10, content gap 8 and paddingTop 5 for the overhanging remove badge; image thumb bg composerControl; **file card** height 58, minWidth 140, maxWidth 220, gap 9, paddingLeft 10, paddingRight 12, file icon tile 32 x 36 bg bgRaised, name 13/500 textPrimary, meta 11.5 textMuted; remove badge is an `X 11` strokeWidth 3 on a small round badge top-right; uploading state overlays a spinner (lines 174-235).
- Mic: composer/dictation/MobileNativeChatComposerMic.tsx (89) beside Send; MobileNativeChatDictationLeading.tsx (66) swaps the leading controls for a one-line preview while recording.
- **Mode/model pill**: input/session-options/MobileNativeChatSessionOptionRows.tsx:268-282: `pill` row, gap 6, **height 38**, paddingHorizontal 14, radius pill, bg composerControl, text bodySize (primary 500 textPrimary, secondary textMuted); `pillSlot` is the only shrinkable item so a long label truncates before pushing Send off (mobile-native-chat-session-option-picker-styles.ts:6-9). Tapping opens a BottomDrawer picker (MobileNativeChatSessionOptionPickers.tsx, 383 lines; rows `value` 15 px, maxWidth 180; caption metaSize textMuted). Maps to Yardbell's model picker (Default, Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5, Codex list) and the approval chip (Ask first / Go ahead / Refuse). Orca's pill also hosts effort and permission mode, which Yardbell does not have for Dispatch.
- **`@` / `/` suggestions**: composer/menus/MobileNativeChatComposerMenu.tsx (254), size cap `COMPOSER_MENU_MAX_HEIGHT = 300` (mobile-native-chat-composer-menu-size.ts:3). Card: marginHorizontal 10, marginBottom 8, paddingVertical 6, radius 24, hairline composerBorder, bg bgPanel (lines 180-192); `heading` 11/600 uppercase letterSpacing 0.5 textMuted, padding 16/8/4; **row** minHeight 44, paddingH 16, paddingV 8, gap 10, pressed bg bgRaised, icon 16 textSecondary marginTop 2, name 13.5 mono (14 for member rows), hint metaSize mono textMuted, description 12.5/17 textMuted (lines 193-253). Trigger logic in menus/use-mobile-native-chat-composer-menu.ts (326) and mobile-native-chat-composer-menu.ts (195) uses `src/shared/native-chat/input/composer/native-chat-composer-autocomplete`; **rewrite** the trigger as Yardbell's own `/(?:^|\s)(?:\/([^\s/]*)|@([^\s@]*))$/` (Composer.tsx:81). The pill-in-text behaviour (Orca keeps the token atomic in draft text, composer/field/mobile-native-chat-composer-field-skill.ts) can be approximated by inserting the plain token text, since Dispatch only needs the token string.
- Draft persistence per chat: composer/drafts/* (about 1900 lines across 8 files). Use a single AsyncStorage map keyed by conversation id.
- Offline send queue and in-flight sends (composer/delivery/*, input/queued-messages/*): **skip**. Yardbell rejects sends while busy; restore the text on failure like the web does (`composer.restore`).
- Pasted images and quotes, goal mode, plan chip, MCP tray, context-usage ring, Slack mirror: **skip**.

**7. Sheets and menus these screens use** (see the earlier survey section 7 for exact values): `components/sheets/ActionSheetModal.tsx` (attach, row actions), `ConfirmModal.tsx` (delete conversation, delete prompt, reject), `PickerListDrawer.tsx` and `PickerModal.tsx` (model picker, machine/agent pickers inside the edit form), `TextInputModal.tsx` (saved prompt name), `components/bottom-drawer/BottomDrawer` (edit form, finding picker, history), `components/nav-bar/PullDownMenu.tsx` (header "..." menu), `components/list/ListGroup.tsx` and `SwipeRowActions.tsx` (conversation list rows with swipe to delete), `components/controls/MobileSwitch.tsx` and `MobileSegmentedControl.tsx` (trigger on/off, Waiting/Decided tabs, rule "then"). Yardbell's mobile/src/ui already has ActionSheet, BottomDrawer, ConfirmModal, PullDownMenu, ListGroup, ListRow, SwipeCell, NavBar, SearchField, BottomSearchBar, SheetHeader, StateView, TabBar and ActionButton, so most are present; **missing**: a picker drawer with search, a segmented control, a switch, a text-input modal.

**8. Lists**

- Conversation list rows: Orca's **Agents tab rows** (src/agents/MobileAgentListRows.tsx, details in survey 4.9: status glyph column 24, title 15/20, preview 14/19 two lines, footer 12, swipe right/left actions width 84) fit Dispatch chats: title = first line of the first message, preview = state word ("Needs you" amber for `waiting`, "Working" for `busy`, otherwise time ago), footer = backend glyph + "trigger NAME". The Bots home row (bots/MobileBotHomeRow.tsx:385-428: row gap 12, padding 16/8, title 15/500, count 13 textMuted, preview 13 textMuted, age 11) is the closest "named agent with last message" row, but it carries bot avatars and "up next"; use the Agents row.
- Search: Yardbell's BottomSearchBar (survey 5.6).
- Home placement: Orca's Feed has a Bots section and an Active section; Yardbell's Home gets a **Dispatch** section ("Dispatch" heading with count, up to 3 chats needing you or working, "See all") and an **Inbox** row with the amber count pill, plus bottom-tab entries (Orca tab bar: 5 cells, icon 25 px, label 10.5, badge 17 px amber `statusAmber`, survey 4.2). Suggested icons: Dispatch = `MessagesSquare` or `Bot`, Inbox = `Inbox` (the web uses `Inbox` for Proposals, pages.ts).

**9. Automations and tasks screens**

- src/automations/* (AutomationList.tsx, AutomationDetail.tsx, AutomationEditor.tsx, AutomationRunList.tsx, MobileAutomationsScreen.tsx; home tab home/tabs/MobileHomeAutomationsTab.tsx, 292 lines): list rows with agent icon and a `MobileSwitch`, detail sections "Schedule / Repeats / Agent / Project / Workspace / Instructions", footer "Run now", "..." menu Edit / All runs / Delete; editor with schedule fields; run list. They depend on `src/shared/automations/*` for scheduling and ownership.
- This is the right model for **Yardbell Triggers** (name, schedule or Linear/GitHub source, saved prompt, enabled switch, Run now = `POST /api/triggers/run`, enable = `POST /api/triggers/enable`) and the "Started by the trigger" header, **not** for Dispatch saved prompts. It is a later step (Triggers on the phone) and is not required for Dispatch v1; keep the "Started by the trigger" card and the on/off button only.
- src/tasks/* is Orca's GitHub/Linear issue board (project board, providers, workspace creation). **No Yardbell counterpart** (Yardbell has no issue tracker UI). Saved prompts map to Orca's **skills and commands menu** (the `/` menu above) plus a simple list screen using ListGroup rows (name + 1 line text, tap = run, swipe = edit/delete), nothing from tasks/.
- Orca Bots (src/bots/*, about 100 files: bot panel, group room, soul/memory, connectors, sharing) has **no Yardbell counterpart** except loosely `Dispatch memory` (bots/soul-memory/MobileBotMemory.tsx, 371 lines, is a model for the memory list: entries, add, edit, forget, cap bar) and the `MobileBotNeedsYouGroup` idea (items needing you) for the Inbox.

### D.3 Mapping table

| Yardbell Dispatch / Inbox feature | Orca component to copy | Notes |
|---|---|---|
| Conversation list | Agents-tab row + SwipeRowActions + BottomSearchBar | no groups, no rename, no archive |
| Chat header and "..." menu | NavBar + PullDownMenu (survey 5.1, 6.6) | menu: New chat, Settings, Clear all |
| User bubble | userBubble (message-styles.ts:28-36) | caption line for `by`/`task`/`improve` |
| Assistant markdown | MobileMarkdown (simplified) | needs markdown-it, remend |
| Tool chips | ToolLine / ToolRun | pairing logic from web model.ts `blocks()` |
| Step card pending | PromptCard + Permission chrome (lower region) | Approve / Edit / Reject, N of M |
| Step card receipt | ResolutionReceipt + AwaitingInputRow | status, trail, outcome, "Open session" |
| Session card choices | MobileNativeChatAsk options | numbered options as buttons, answer once |
| Session card screen tail | `codeBox` (tool-styles.ts:96-104) | last 4 lines, "Show all N lines" |
| Composer | MobileNativeChatComposer box, field, action row | 24 radius box, 16/22 text, 38 round controls |
| Attach | AttachButton + attach-actions ActionSheet + Attachments strip | Photos, Files |
| `@` and `/` | ComposerMenu card | own data source, own trigger regex |
| Model picker | SessionOptionRows pill + PickerListDrawer | global setting, show a toast that it applies from the next message |
| Approval chip | same pill, shield icon | writes `/api/settings/dispatch` |
| Dictation | ComposerMic + DictationLeading | recorder + `/dispatch/transcribe` |
| Send / Stop | ComposerSendButton / StopButton + control-swap | |
| Working line | TurnStatus / LiveLine | |
| Saved prompts | `/` menu + ListGroup screen | versioning/history = list of versions, optional |
| Inbox | Home section + a list screen of step cards | Waiting / Decided segmented control |
| Trigger header | none (use a card) | |
| Rules, memory, instructions | Settings screen rows (survey 9) | later |
| Speak replies | none | expo-speech |
| Review/scan findings, PR card, group card, results card | none | design needed |
| Pipeline canvas inside save_pipeline | none | show a text summary + "Open on the computer" |

---------------------------------------------------------------------------
## E. Gaps and server changes

### E.1 Dispatch features with no Orca counterpart (design needed)

1. **Step cards with edit forms** (start_session machine/agent/folder/branch/new branch/task; send_to_session text; change_settings JSON; save_task; remember). Orca has no editable approval. Design: card with "Edit" opening a BottomDrawer form. For `change_settings` JSON, offer read-only diff plus Approve/Reject on the phone and send the editing to the web ("Edit on the computer").
2. **Diff and text-change blocks** (`change_settings`, `save_task` before/after parts; memory diff). Use Orca's diff row colours (`diffAddedBg`, `chatDiffAdded`, `diffGutter`) from mobile-native-chat-tool-styles.ts:150-248.
3. **Pipeline definition card** (SVG canvas). No phone version; show node list and an "Open in web" link.
4. **Group card and Results card** (parallel sessions with per-child badge, Approve all, Review button).
5. **Review and scan result cards** (verdict, severity-grouped findings, pick, Send to session / Start new session / Dismiss, lazy diff viewer with jump to place). Biggest design piece; v1 can show verdict, summary and findings with the three actions, and defer the diff viewer.
6. **Pull request card** (CI failed, conflicts, comments, "Send to session").
7. **Session card** (blocked tail + numbered choices + Review branch + Scan menu + Insights + Open). Insights is a separate dialog (`openInsights`, `/api/insights...`) and can wait.
8. **Tracked-sessions strip** per conversation (dot + name + state word, tap opens the terminal route the app already has: `/session/{serverId}/{machine}/{name}`).
9. **Saved prompt versioning and history** (history dialog, diff, restore).
10. **Trigger header** and the Settings areas (Dispatch rules, memory, instructions) that the web links to.
11. **Speak replies** (client-only), including what is read and when.
12. **Approval mode change from the composer** (a global setting changed in the middle of a chat; the web saves the whole settings object).

### E.2 What the server needs (or should get) for the phone

Needed:
1. **Nothing for auth or routing.** All routes accept the bearer.
2. **Streaming**: works over a bearer POST with `expo/fetch`. Handle: line-buffered NDJSON parse (split on `\n`, keep the tail), abort on unmount, and on error or stream end poll `GET /dispatch/conversations/{id}` until `busy` is false. Mind that Android may close the socket when the app backgrounds. No server change.
3. **Upload limits**: body limit is 56 MB for `/dispatch/ask` (base64 inflates 4/3, so 40 MB of files). The phone must read files, base64 them in memory (`expo-file-system` is not in Yardbell's package.json; use `fetch(uri).then(blob)` plus a `FileReader`, as upload.ts already does for another route) and pre-check the same limits (10 files, 5/32/0.25/40 MB, magic-byte kind, no PDF on Codex). A 40 MB base64 string in the JS heap is heavy on a phone: cap images at 5 MB (already the rule) and warn on big PDFs. A multipart or raw-body upload route would be a server improvement but is not required.
4. **Attachment images**: `GET /dispatch/conversations/{id}/attachments/{file}` needs the bearer header, so use `<Image source={{uri, headers:{Authorization}}}>`. Works; no server change.
5. **Dictation upload**: raw body up to 25 MB with the recorder's mime. Android's recorders give m4a/aac (`audio/mp4`) or 3gp, not webm. The server passes the mime to `crate::voice::transcribe` which uses whisper.cpp; **verify** it accepts audio/mp4 (src/voice.rs) or add an ffmpeg-free conversion path. Unverified here: flag before building the mic.
6. **`GET /state` gives the `@` data** (machines, sessions, `folders`). The mobile `StateView` type must grow `folders`, `agents`, `proposals` (number), and `SessionView.tmux`/`stale` are already there.

Recommended (small):
7. **Live pings for Dispatch and the Inbox.** `/state/live` only fires on `state.touch()`. `client_proposal` (mcp.rs:480) and `Dispatch` step proposals (`propose`, group open) do not call `touch()`, so the phone would not learn of a new proposal or a new waiting step until its next poll. Add `app.state.touch()` after `proposals.add` and after a conversation gains a pending step, and add `waiting` (sum of pending steps across chats) to `StateView` next to `proposals`, so the Home badge, the tab badge and the Inbox need no per-chat polling. Alternative without server work: poll `/dispatch/conversations` every 5 s while a Dispatch screen is open (what the web does) and `/state` for `proposals`.
8. **Dispatch push notification** (see C): `Push{ title:"Dispatch", message:"N steps wait for you in <title>", click: "{base}/dispatch?c=<id>"}` when a conversation first gets a pending step, with a once-per-conversation limit like the proposals limiter, and a config toggle plus a Settings control. Also `click` for the proposals push is already `{base}/proposals`; the app only needs the route mapping.
9. **Fix the web badge** (`web/src/lib/state.ts` `proposals?: number`, `Sidebar.tsx:236`), small and independent.
10. **Conversation list could carry a preview** (last assistant text, first 120 chars) to make list rows informative; today the list has only title and counts. Optional.
11. **Event paging**: `GET /dispatch/conversations/{id}` returns every event with full `screen` strings, which can be hundreds of KB for long chats. A phone on a bad link would benefit from `?after=<index>` (events since index N). The web's 5 s catch-up refetches the whole list. Optional; start with the whole list and cap transcript drawing to the last N rows.

### E.3 Risks and things not verified here

- Orca's chat code depends on Orca desktop's `src/shared` tree (not in the MIT folder I read). Treat Orca as a visual spec, not as a library.
- I did not run the app, so the visual values are quoted from source. Light-theme values for tokens not listed in the earlier survey (`floatingCardBorder`, `choiceBorder`, `inputBorder`) should be read from theme/mobile-theme.ts when building.
- The audio mime question in E.2 item 5 is untested.
- The web `ASK` flow sets `conversation` from the stream's first line; the phone must do the same for new chats (first send creates the id).
- `answers` and review endpoints address cards by **event index**, so the phone must keep indexes stable (never filter or reorder the stored list before using an index; filter only for display).

---------------------------------------------------------------------------
## F. Suggested build order for step 2

1. Types and client: widen `StateView` (`proposals`, `folders`, `agents`), add a Dispatch API module (list, get, ask stream parser with `expo/fetch`, stop, delete, decisions, tasks, runs-on, settings) with unit tests in the style of client.test.ts. Route mapping for `/proposals` and `/dispatch?c=` links.
2. Inbox first (smallest, no streaming): Home row with count, Inbox screen with Waiting/Decided, one native step card (view, Approve, Reject, Delete, Clear, plus edit for save_task/remember/change_settings later), `GET ?opened=1` on focus. This also builds the step card Dispatch needs.
3. Conversation list screen and an open-chat screen that renders `user`, `assistant`, `error`, tool chips, `session` and `action` cards from `GET`, with 2 s polling while busy.
4. Composer: text, send, stop, streaming, drafts, restore on failure. Then attach (Photos, Files), `@` and `/` menus, model and approval pills.
5. Lower-region pending card with Approve all, group, session choices, waiting bar.
6. Dictation, speak replies, saved prompt screen, review/scan/PR/group cards, trigger header.
7. Server: touch on proposal/step, `waiting` in state, Dispatch push and Settings toggle.
