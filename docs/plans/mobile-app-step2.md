# Phone app step 2: Dispatch and the Inbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** act from the phone. Talk to Dispatch (conversations, streaming replies, approving its steps,
answering sessions, attachments, `@` and `/`, model and approval mode, dictation) and decide the Inbox
(proposals from MCP clients), with the same look as the rest of the redesigned app.

**Architecture:** the server already accepts the phone's bearer token on every Dispatch and Proposals
route. The phone adds a Dispatch API module (NDJSON streaming over `expo/fetch`, polling while a turn is
busy), one shared step card used by both Dispatch and the Inbox, and new screens built from the
existing `mobile/src/ui` components. Small server additions make Home badges live and add a Dispatch
push.

**Tech stack:** as step 1 and the redesign, plus markdown-it ^14.3.3, remend 1.4.0, expo-speech,
expo-audio (recording). `expo/fetch` ships with Expo.

**Spec:** `docs/plans/mobile-app-design.md` (step 2 in Delivery order). Survey with every endpoint,
event shape, web behaviour and the Orca components to copy: `docs/plans/mobile-app-dispatch-survey.md`
(sections A to F). The redesign survey `docs/plans/mobile-app-orca-survey.md` stays the visual
authority for tokens, sheets and lists.

## Global Constraints

- Match the web's behaviour (survey A and B) and Orca's look (survey D). Orca's chat code depends on
  files outside its MIT mobile folder: copy its visual values and layout, write Yardbell's own data layer.
- Every control the web Dispatch and Proposals pages offer is either built or listed under "Not built"
  in the task report with the reason.
- Event indexes are stable: never filter or reorder the stored event list before using an index in a
  request (`answers`, `reviews/{card}`, `pulls`). Filter only for display.
- A turn keeps running on the server if the phone drops: after a stream error or end, poll
  `GET /dispatch/conversations/{id}` every 2 s until `busy` is false.
- Multiple servers: Dispatch and the Inbox are per server; with more than one server, lists say which.
- Theme tokens only, light and dark; lucide icons; no `Alert.alert`; long text truncates.
- Every configurable feature gets a Settings control (the Dispatch push toggle).
- No em dashes in user-visible text. Never write "Orca" in commit messages. No co-authored or
  generated-by lines.
- Vitest for pure modules; Rust tests for server changes; the web preview and the phone for screens.
- Version: this ships as the next release after 0.11.109.

## Review Focus

1. The phone backgrounds mid-reply: on return the chat shows the finished reply (polling), never a
   half message or a duplicate.
2. Two steps pending, then the person sends a new message: both show as withdrawn, the pending card
   disappears, nothing runs.
3. A proposal or a Dispatch step decided on the computer while the phone shows it: the phone updates
   and an Approve tap gets the server's 409 shown as "already decided", not a crash.
4. A 40 MB attachment set on a phone with little memory: limits are checked before reading files, and
   the error names the file and the limit.
5. Light mode and long titles, long tool names and wide code blocks: nothing pushes buttons off
   screen; code scrolls sideways.

---

## Decided

| Area | Decision |
|---|---|
| Navigation | Home tab bar becomes **Feed, Sessions, Dispatch, Usage**. Feed gains a **Dispatch** section (up to 3 chats that wait for you or are working, "See all") and an **Inbox** row with the amber count when proposals wait. Inbox also opens from the Dispatch tab header. |
| Conversation list | Orca Agents-tab rows: title, state word ("Needs you" with N waiting, "Working", or time ago), trigger name, pipeline mark; search; swipe to delete (ConfirmModal; 409 when busy shown as such); Clear all in the header menu. No rename or archive (the web has none). |
| Chat | Inverted list, scroll-to-bottom button; user bubble, assistant markdown, error banner, tool runs, step receipts, session cards, PR, group, results, review summary and trigger header cards; tracked-sessions strip; Working line with elapsed time. |
| Pending steps | Orca's prompt card rises over the composer for the first pending step, "1 of N", Approve, Edit, Reject, plus Approve all / Reject all when N > 1. Decided steps stay in the transcript as receipts. |
| Step card edits | start_session (machine, agent, folder or path, branch, new branch from, task) and send_to_session (text) edit in a BottomDrawer form; save_task and remember edit as text; change_settings shows the before/after diff with Approve and Reject, editing it is "Edit on the computer". save_pipeline shows a node list summary. |
| Composer | Orca box (radius 24, 16/22 text, 7 lines max), round 38 px controls, Send/Stop swap, attach sheet (Photos, Files), attachment strip, `@` and `/` menus from `/state` and `/dispatch/tasks`, model pill and approval pill (global settings, saved through `/api/settings/dispatch`, a note that it applies from the next message), mic, drafts per chat, restore text on a failed send. |
| Review and scan cards | Verdict, summary, findings by severity with pick, Send to session, Start a new session (scans), Dismiss. The diff viewer is not built (open on the computer). |
| Saved prompts | A screen from the Dispatch header: list, tap runs it, create, edit, delete, restore defaults. Version history is not built. |
| Speak replies | A switch in Settings > Dispatch on the phone (local, as the web keeps it per browser), reads replies, errors and blocked sessions with expo-speech, as assets/voice.js does. |
| Server | `touch()` after a proposal is added and after a conversation gains a pending step; `waiting` (pending Dispatch steps across chats) in `StateView`; a Dispatch push when a conversation first gets a pending step (once per conversation until opened), behind `phone_notifications.dispatch` with a Settings toggle; fix the web proposals badge (`proposals` is a number). |

Not built, with reasons: diff viewer for reviews (needs a file viewer, step 3), pipeline canvas inside
save_pipeline (desktop builder), saved prompt history and diff, Insights dialog, Dispatch rules, memory
and instructions editing (Settings, step 3), event paging (start with the whole list).

---

### Task 1: Server: live counts, Dispatch push, web badge

**Files:** `src/web/mod.rs` (StateView fill), `src/state.rs`, `src/mcp.rs` (`client_proposal`),
`src/dispatch*` (where a step is proposed or a group opens), `src/proposals.rs`, `src/config.rs`
(`phone_notifications.dispatch`), the phone push producer, `web/src/settings/Sections.tsx` (toggle),
`web/src/lib/state.ts` + `web/src/shell/Sidebar.tsx` (badge), tests in `src/web/tests/`.

- [ ] `state.touch()` after `proposals.add` and after a conversation gains a pending step or group.
- [ ] `StateView.waiting: usize` = pending Dispatch steps across conversations.
- [ ] Push `{title: "Dispatch", message: "N steps wait for you in <title>", click: "{base}/dispatch?c=<id>"}`
      when a conversation first gets a pending step; at most once per conversation until it is opened
      (`GET /dispatch/conversations/{id}` re-arms); off when `phone_notifications.dispatch` is false
      (default true); Settings control next to the other phone notification switches.
- [ ] Web: `proposals?: number`; the sidebar badge reads the number.
- [ ] Tests: touch fires on proposal and on step; waiting counts; push once per conversation and re-armed;
      toggle off sends nothing; `/state` includes both counts.
- [ ] `cargo test`, web `tsc`, `npm run build` in web/ and commit assets/app. Commit.

### Task 2: Phone types, Dispatch API and routes

**Files:** `mobile/src/state/types.ts` (`proposals`, `waiting`, `folders`, `agents`), `mobile/src/dispatch/api.ts`,
`mobile/src/dispatch/stream.ts` (NDJSON parser), `mobile/src/dispatch/types.ts` (every event role in
survey A.3), `mobile/src/inbox/api.ts`, `mobile/src/notifications/route.ts`, tests.

- [ ] Client functions for every endpoint in survey A.11 and B.2 used by later tasks.
- [ ] `ask()` streams with `expo/fetch`: line-buffered parse (keep the tail), first line gives the new
      conversation id, abort on unmount; `followTurn(id)` polls every 2 s until `busy` is false.
- [ ] Attachment pre-check (10 files, image 5 MB, PDF 32 MB, text 256 KB, 40 MB total, kinds by magic
      bytes, no PDF on Codex) before reading files; base64 encode.
- [ ] Routes: `{server}/proposals` -> Inbox, `{server}/dispatch?c=<id>` -> that chat.
- [ ] Tests: parser (split lines, partial chunks, bad line), pre-check limits and messages, route mapping.
- [ ] Commit.

### Task 3: Step card

**Files:** `mobile/src/steps/*` (StepCard, titles, bodies, diff block, edit drawer, receipt).

- [ ] Titles, badges, bodies, trail and outcome lines per survey A.5, for every tool listed there and in
      B.1; diff block with Orca's diff colours; pending variant (Orca prompt card chrome) and receipt
      variant (Orca resolution receipt).
- [ ] Actions: Approve (with the per-tool labels), Reject or Cancel, Edit for the tools in Decided;
      409 already decided shown in place; errors surfaced.
- [ ] One component used with a decide callback, so Dispatch and the Inbox share it.
- [ ] Tests for titles, which tools can edit, edited-input building, diff rendering data.
- [ ] Gallery entries and screenshots of each state, dark and light. Commit.

### Task 4: Inbox

**Files:** `mobile/app/inbox/[server].tsx`, `mobile/src/inbox/*`, Home Feed row.

- [ ] Screen: Waiting / Decided segmented control, sections, step cards, Delete per card (copy differs
      when waiting), Clear decided, empty states from survey B.3; `GET ?opened=1` on focus; refresh on
      live state and every 5 s while open.
- [ ] Home Feed Inbox row with the amber count from `StateView.proposals`.
- [ ] Screenshots. Commit.

### Task 5: Chat building blocks

**Files:** `mobile/src/markdown/*` (markdown-it tree walker: paragraph, heading, list, code with copy
and sideways scroll, blockquote, table, link, inline code, hr; remend for partial text),
`mobile/src/dispatch/cards/*` (tool run, session card, PR, group, results, review summary, trigger
header, error).

- [ ] Markdown per survey D.2 item 2 at 16/24 body.
- [ ] Tool runs per survey D.2 item 3 with the web's LABELS and pairing from web model.ts `blocks()`.
- [ ] Session card: tail of the screen (4 lines, Show all), numbered choices as buttons (answer once,
      409 handled), Open (session route), Review branch.
- [ ] PR card (Send to session), group card (Approve all / Reject all), results card, review summary
      (Send, Start, Dismiss), trigger header (Turn on/off).
- [ ] Tests for the block pairing and markdown tree. Gallery screenshots. Commit.

### Task 6: Dispatch list and Home

**Files:** `mobile/src/dispatch/ListScreen.tsx`, Home tab bar and Feed section.

- [ ] List per Decided, per server, search, swipe delete, header menu (New chat, Saved prompts, Inbox,
      Clear all); refresh every 5 s while open and on live state.
- [ ] Tab bar adds Dispatch (badge = `waiting`), Feed Dispatch section.
- [ ] Screenshots. Commit.

### Task 7: Chat screen

**Files:** `mobile/app/dispatch/[server]/[id].tsx`, `mobile/src/dispatch/ChatScreen.tsx`.

- [ ] NavBar with title and menu (New chat, Saved prompts, Delete), intro for a new chat with starters,
      backend note, tracked-sessions strip, transcript from tasks 3 and 5, Working line, pending card
      region with Approve all, waiting bar text.
- [ ] Follows a busy turn by streaming or polling (Review Focus 1); withdrawn steps (Review Focus 2).
- [ ] Screenshots. Commit.

### Task 8: Composer

**Files:** `mobile/src/dispatch/composer/*`.

- [ ] Box, Send/Stop, drafts, restore on failure (the web's Arrow Up history is not built: no arrow key),
      busy refusal text, attach sheet and strip, `@` and `/` menus (survey A.4 ranking, 40 items),
      model pill with picker drawer (search), approval pill.
- [ ] Tests for the trigger regex, ranking and token text. Screenshots. Commit.

### Task 9: Saved prompts

**Files:** `mobile/src/dispatch/prompts/*`.

- [ ] List, tap runs, create and edit (name 60 chars), delete, restore defaults, hidden defaults.
- [ ] Screenshots. Commit.

### Task 10: Dictation and speak replies

- [ ] First check that `POST /dispatch/transcribe` accepts Android's recorder format (`audio/mp4` or
      `audio/3gpp`) in src/voice.rs; if not, fix it on the server with a test.
- [ ] Mic with hold or toggle per `runs-on.voice_mode`, "Set up voice" when voice input is off,
      RECORD_AUDIO permission flow; inserts the text at the cursor.
- [ ] Speak replies switch and expo-speech reading per assets/voice.js.
- [ ] Commit.

### Task 11: Build, notices, release prep

- [ ] THIRD_PARTY_NOTICES.md for the new packages; regenerate notices.ts.
- [ ] Version bump, changelog, apk build, phone check of the Review Focus items, then release with the
      user's approval.
