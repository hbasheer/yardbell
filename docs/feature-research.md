# Feature research: what to take, what to improve, what to keep

Read 2026-11-11. The other app's paths are relative to the local clone
(a local clone of it) and written `ref:src/...`. Yardbell paths are relative to this
worktree. Builds on `docs/agent-app-comparison.md` (the earlier table) and `docs/ui-redesign-design.md`
(shell, tree, palette, Dispatch as a pane); this file only adds what those miss and grounds it in
code. Sizes: **S** a day or less, **M** a few days, **L** a week or more.

The one constraint that shapes everything below: Yardbell watches machines over ssh and installs
nothing on them. Writing a temp file into `~/.cache/yardbell/` on a machine, or reading an agent's
own transcript files, is fine. Installing a daemon, hooks or a runtime is not.

---

## 1. Improve what Yardbell already has

### 1.1 Voice and dictation

**The other app.** `ref:src/renderer/src/components/dictation/` plus `ref:src/main/speech/`.
- One global shortcut, `voice.dictation`, default `Mod+E` (`ref:src/shared/keybindings/definitions-core-1.ts`), remappable.
- Three modes in `ref:src/shared/dictation-shortcut-mode.ts`: `toggle`, `hold`, and `auto`
  (tap toggles, a press held over 300 ms records until release; `AUTO_HOLD_THRESHOLD_MS` in
  `use-hold-dictation-gesture.ts`).
- Text lands wherever focus is. `dictation-insertion-target.ts` defines targets `composer`,
  `terminal`, `browser`, `text`, `contentEditable`; the terminal target pastes into the pane it
  started in even if the user switched tabs (`terminal-pane/input/paste/use-terminal-dictation-insert-event.ts`).
- Live text: the engine emits `partial` and `final` events (`use-dictation-speech-events.ts`);
  offline models commit a chunk at each pause using a Silero VAD model (`main/speech/stt-recognizer.ts`).
- Silence auto-stop in toggle mode (`use-dictation-silence-stop.ts`), a queued "send when it
  lands" that presses Enter after the text arrives (`use-dictation-queued-send.ts`), a floating
  pill with a level meter (`DictationPillShell.tsx`, `dictation-meter-store.ts`), a microphone
  picker (`microphone-devices.ts`).
- Engines (`main/speech/model-catalog.ts`): local Parakeet, Whisper tiny and large-v3-turbo,
  streaming Zipformer and Nemotron, SenseVoice, via transcribe-cpp; cloud OpenAI
  gpt-4o(-mini)-transcribe and any OpenAI-compatible endpoint.

**Yardbell.** `assets/voice.js` `dictation({ button, input, toast })`, wired only in
`assets/dispatch.js:989`.
- A button only, no shortcut. Tap toggles, holding over `HOLD_MS` (600 ms) is push-to-talk, Esc
  discards, 5 minute cap.
- MediaRecorder with a WAV fallback (`wavCapture`) because WebKitGTK's MediaRecorder lies.
- No live text: the whole clip is POSTed to `/dispatch/transcribe` after stop.
- Engine on the server (`src/voice.rs`): local `whisper-cli` with the model downloaded on first
  use (`ModelStore::ensure`), or an OpenAI-compatible API (`api_url`, `api_model`, `language` in
  `src/config.rs`). Works from a phone because the browser only records.
- Spoken replies: `speaker()` and `spoken()` read Dispatch replies aloud. The other app has nothing like it.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| Move `dictation` into `shell.js` with one target resolver: the focused textarea, the Dispatch composer, or the focused terminal pane (insert as a bracketed paste over the pane's websocket, no Enter) | Talk to any agent, not only Dispatch | M |
| Global shortcut routed through `term.js` `appKey()` the way Cmd/Ctrl+K is, with hold, toggle and auto modes in Settings. Do not copy `Mod+E`: Ctrl+E is end-of-line in shells and Claude Code. Ctrl+Shift+Space or Alt+Space are free | Dictate without reaching for the mouse | S |
| A recording pill in the shell (level meter, elapsed time, Esc to discard), shown wherever the recording started | You can see it is listening while looking at a terminal | S |
| Stop after N seconds of silence in toggle mode (energy threshold on the existing Web Audio graph) | Hands-free dictation ends itself | S |
| "Send after dictation" option: press Enter once the text lands | Speak a reply to a waiting agent in one gesture, also on the phone | S |
| Live text: cut the recording at pauses in the browser and POST each chunk, append as each returns. whisper.cpp is not streaming, but pause chunks give text every few seconds | You see words while you talk and can stop early | M |
| Mic in the phone's full-screen session key row (from `docs/ui-redesign-design.md` section 3), using the same target resolver | Reply to an agent from the phone by voice | S |
| Microphone picker in Settings, Voice | Pick the headset over the laptop mic | S |

### 1.2 Attachments

**The other app.** `ref:src/renderer/src/components/native-chat/attachments/` (`chips`, `intake`, `uploads`)
and `native-chat/paste/`.
- Images appear as pills inside the prompt text (`composer/editor/NativeChatImageReferencePill.tsx`)
  with a preview (`attachments/chips/NativeChatImageAttachmentPreview.tsx`).
- A long paste collapses into a `[Pasted text](app-paste:<uuid>)` token shown as a pill and
  expanded on send (`paste/native-chat-pasted-text-reference.ts`, 16 MB cap in
  `native-chat-context-paste-limit.ts`).
- Clipboard images are saved to a file first (`paste/native-chat-clipboard-image-save.ts`).
- For a remote session the file is uploaded to the host and the agent gets a host path
  (`attachments/uploads/native-chat-session-attachment-upload.ts`). That needs the other app's runtime on the
  host ("older hosts need an update").
- In a terminal pane, a pasted clipboard image is saved as a temp file and its path is typed
  (`terminal-pane/input/paste/terminal-pane-paste-execution.ts`, `saveClipboardImageAsTempFile`).
- Browser screenshots and markup can be attached (`components/browser-pane/annotate/`).

**Yardbell.** `assets/attachments.js` `admit()` and `src/dispatch/attachments.rs` `check()`:
- Images (PNG, JPEG, GIF, WebP) 5 MB, PDF 32 MB, UTF-8 text 256 KB, 10 files, 40 MB total, sniffed
  by first bytes on both client and server. Codex refuses PDFs with a clear message.
- Chips with thumbnails in `composer.js` `drawFiles()`; paste, drop on `#dispatch-chat`, picker.
- Dispatch only. Files are stored on the Yardbell server (`attachments::folder`), which is where
  Dispatch runs. A terminal session on another machine cannot be given a file at all.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| `POST /sessions/{machine}/{name}/files`: stream each file over ssh stdin into `~/.cache/yardbell/drop/<id>/<name>` on the session's machine (the same stdin pattern as `send_script`'s `tmux load-buffer -` in `src/sessions.rs`), return the remote paths; remove the folder when the session ends | A screenshot reaches Claude Code on a remote box; nothing installed | M |
| Type the returned paths into the pane, backslash-escaped. The other app learned that Claude strips only one pair of quotes (`ref:src/shared/image-path-paste.ts` `formatImageDropPasteText`), so escape rather than quote | The agent opens the image instead of failing on a quoted path | S |
| Image paste into a terminal pane (Ctrl+V with an image on the clipboard) uses the same endpoint | Paste a screenshot straight into a session | S |
| Long text paste into the composer becomes a chip ("Pasted text, 412 lines"), expandable, expanded on send | The prompt stays readable | S |
| Click a chip to preview: image lightbox, PDF in the browser's viewer, text in a `<pre>` | Check what you are about to send | S |
| Text over 256 KB, or CSV, JSON, logs, goes as a file reference rather than inline | Attach a big log without hitting the limit | S |

### 1.3 Drag and drop

**The other app.**
- OS files dropped on a terminal pane: paths typed, shell-escaped, into that pane
  (`terminal-pane/input/file-drop/terminal-drop-path-writer.ts`). On an SSH host they are
  uploaded first with a toast "Uploading N files to remote" (`terminal-native-file-drop.ts`
  `uploadRemoteDropPaths`). Symlinks are skipped and reported (`terminal-drop-upload-report.ts`).
- Files dragged from the other app's file explorer insert workspace paths, and a drag from one host onto a
  pane of another is refused (`terminal-drop-handler.ts`, `source-host-mismatch`).
- A drop on the pane header counts too (`TerminalPaneHeaderDropSurface.tsx`).
- In chat, OS files become attachments; files from the explorer become `@file` pills
  (`native-chat/attachments/intake/use-native-chat-workspace-file-drop.ts`).

**Yardbell.** Drop works on the Dispatch chat only (`composer.js` drop listener on
`dropZone`). `workspace.js` uses drag only to move panes. A browser cannot see OS paths, so a drop
must always upload.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| Drop files on a terminal pane: upload with the 1.2 endpoint, type the paths | Drag a screenshot from Finder onto the agent that needs it | S after 1.2 |
| Drop overlay that names the target: "Upload to devbox, ~/proj/foo" | No file lands on the wrong machine | S |
| Drag a session or folder row from `tree.js` onto the Dispatch composer to insert its @name, onto a pane to type its path | Point Dispatch at a session without typing | S |
| Drag a file row from a diff or review card into a composer to insert `path:line` | Refer to code precisely | S |

### 1.4 The prompt composer

**The other app.** A Tiptap 3 editor: `@tiptap/react`, `starter-kit`, `placeholder`, `markdown`,
`code-block-lowlight` in `ref:package.json`; editor in
`native-chat/composer/editor/NativeChatPromptEditor.tsx`.
- Inline pills for files, images, agents, skills and saved prompts (`NativeChatFileReferencePill.tsx`,
  `NativeChatSkillPill.tsx`, `NativeChatPromptPill.tsx`, `native-chat-agent-reference.tsx`).
- `@` lists up to 20 files in the worktree (`pickers/use-native-chat-mention-files.ts`).
- `/` lists the agent's own slash commands and skills plus the other app's `/resume` and `/btw` side chat
  (`pickers/use-native-chat-composer-catalog.ts`, `native-chat-slash-command-descriptions.ts`).
- Drafts per session in IndexedDB with a journal (`native-chat/drafts/`); sent-prompt recall
  (`native-chat-sent-prompt-history.ts`).
- A queue: messages sent while the agent works wait as cards that can be edited and reordered
  (`native-chat/queue/`, `queue/editing/`).
- Select text in a terminal or editor and "Add to chat" as a quote (`native-chat/selection-quotes/AddToChatMenu.tsx`).
- Approval and question cards answered in place (`native-chat/prompts/`).

**Yardbell.** `assets/composer.js` `composer(form, hooks)` on a plain textarea:
- Auto-grow, `@` menu of Machines, Sessions and Folders from `/state` (`nameList`), `/` menu of
  saved tasks (with versions, diff and restore in `dispatch-tasks.js`), triggers only at the start
  of a word (`TRIGGER`).
- Up arrow recalls the last 50 sent messages, drafts per conversation in `localStorage`,
  Enter or Mod+Enter send mode, phone viewport fitting.
- Sending while Dispatch works is refused with a toast (`dispatch.js:972`).

A Tiptap editor is not worth it: no build step, lit-html pages, and the textarea plus a chip row
already gives atomic attachments. What is worth taking is behaviour, not the editor.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| Queue messages while Dispatch works: show them as cards under the last turn, edit or remove, send in order when the turn ends | No waiting to type the next thing | S |
| Make `composer()` take its elements and hooks rather than fixed ids (`compose-menu`, `dispatch-send`, `attach-input`), so the same composer serves Dispatch, the session chat view (section 2.1) and a prompt bar under a terminal pane | One composer with voice, files, history and @ everywhere | M |
| `@` files when the target is a session or folder: `git ls-files` over ssh, cached per folder, insert the relative path | Mention files the way the other app does, on any machine | M |
| `/` for a session lists Claude Code's commands: built-ins plus `~/.claude/commands` and `<folder>/.claude/commands` read over ssh | Run `/review` or a project command from the composer | M |
| Select text in a terminal pane, "Add to Dispatch" or "Add to prompt" as a quote | Quote an error into the conversation in one move | S |
| Saved tasks (`/`) in a pane header menu, typed into the session through `send_script` (the other app has `terminal-quick-commands/`) | Reuse prompts on terminal sessions too | S |

### 1.5 Usage and limits

**The other app.** Status bar: `status-bar/InlineProviderUsage.tsx`, `ProviderDetailsMenu.tsx`,
`CodexResetCredits.tsx`, account switchers `ClaudeSwitcherMenu.tsx` and `CodexSwitcherMenu.tsx`;
providers in `main/claude-usage`, `codex-usage`, `opencode-usage`, `muse-usage`. Claude accounts
are separate profile homes (`main/claude-accounts/claude-profile-homes.ts`).

**Yardbell.** `src/dispatch/usage.rs` `from_stream` reads the 5-hour and weekly windows from
Claude Code's `rate_limit_event` on every Dispatch turn, plus Codex usage (`turn.rs`
`codex_usage`); shown in `strip.js`, refreshed with `/dispatch/usage/refresh`.
`src/web/limits.rs` types `continue` into sessions that stopped at a limit once it resets
(`STALE_AFTER_HOURS` = 6). The other app has no auto-resume.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| Amber at 80% and a notification once per window | You hear about the limit before agents stall | S |
| Show which account the figure is for. Today it is the account Dispatch uses on the server; sessions on other machines may use other accounts. Reading per-machine usage needs research (Claude Code writes no usage file), so say so in the UI rather than imply it covers every session | No false confidence | S |
| Account at session start: list `CLAUDE_CONFIG_DIR` folders that already exist on the machine and start the agent with that env. Do not create or log in accounts from Yardbell | Spread work over two plans | M |

### 1.6 Notifications

**The other app.** An activity feed of threads with unread counts, filters, hover cards and actions
(`components/activity/`, `useActivityUnreadCount.ts`), in-app cards
(`NotificationCardStack.tsx`), sounds (`notification-sound-options.ts`), phone push through
The other app's relay.

**Yardbell.** `src/events.rs` `Event`: `AgentIdle`, `SessionEnded`, `MachineDown`/`Up`,
`MemoryHigh`, `Pull` (`CiFailed`, `Conflicts`, `Ready`, `Merged`, `Closed`), `LimitReset`,
`Message`. Desktop and phone delivery; `src/phone/inbox.rs` keeps the last `KEPT` = 50 in memory
for a reconnecting phone (`/app/notifications`). `Note.click` exists, but a tap opens the app, not
the session. No feed or bell; the strip has a reserved place for it.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| Persist notes in the state folder; a bell in the strip with unread count and a feed, each item linking with the redesign's deep links (`/workspace?open=`, `/pipeline?...run=`) | See what happened while you were away, one click to it | M |
| Mark an item read when its session or run is viewed | The count means something | S |
| Phone: a tap opens the session the note is about, using `click` | From notification to reply in one tap | S |
| Answer from the notification: Android direct reply typed into the session through `send_script` | Unblock an agent without opening the app | M |

### 1.7 Pipelines and scheduled work

**The other app.** Automations (`ref:src/main/automations/`): a prompt on a schedule, a precheck command
that can skip the run (`precheck-runner`), run history, run now, coalesced skips, launch into a
chat or a terminal, optional new workspace per run.

**Yardbell.** `src/pipeline/` (steps, checks, forge draft PRs, Linear, tokens, transcripts),
`src/triggers/` (schedule, feeds), canvas in `assets/pipeline-canvas.js`, answers and approvals.
Well ahead of the other app here.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| A precheck command on scheduled triggers: run it over ssh, skip the run on a non-zero exit, record "skipped" | Nightly jobs that cost nothing when there is nothing to do | S |
| "Schedule" on a saved Dispatch task, creating a one-step pipeline | Scheduled prompts without opening the pipeline editor | S |

### 1.8 Worktrees

**The other app.** Create dialog with base ref, agent and a linked issue or PR (`components/worktree-creation/`),
`app worktree create` CLI, base-ref fallback (`WorktreeBaseFallbackDialog.tsx`), shared folders
and `.worktreeinclude`, cleanup (`workspace-cleanup/`).

**Yardbell.** `src/worktrees/` (`setup`, `cleanup`, `integrate`, `handoff`, `scan`), branch step in
`assets/newsession.js`, removal that checks what would be lost, moving a session to another machine
(`handoff.rs`), MCP tools.

**Take:**
| Change | Benefit | Size |
|---|---|---|
| New session from a Linear or GitHub issue: branch name from the ticket, issue text as the first prompt | Start a ticket in one step | M |
| A per-repo list of files to copy into new worktrees (`.env` and friends), applied by `setup.rs` | New worktrees run without hand-copying secrets | S |
| Worktree rows in `tree.js` show dirty, ahead/behind and PR, from data `scan.rs` already reads | Know which worktree needs attention | S |

### 1.9 Pull requests and CI

**The other app.** Checks panel with log tails positioned at the first error
(`right-sidebar/checks-panel/logs/check-log-initial-diagnostic-position.ts`), review threads and
resolution, a PR page, merge state, AI-drafted PR bodies (`github-body-draft-state.ts`).

**Yardbell.** `src/pulls/` (GitHub via `gh` and the API, GitLab), CI log excerpts
(`github.rs` `log_command`, `excerpt`, `telling_line`), merge with refusals (`merge_refusal`),
review comments to the session (`review_instruction`), Dispatch cards (`assets/dispatch-pull.js`).
PR creation exists only in pipelines (`src/pipeline/forge.rs` `open_draft`).

**Take:**
| Change | Benefit | Size |
|---|---|---|
| "Open pull request" in the pane header's menu: push, then `gh pr create --draft` with a title and body the session's agent drafts | Ship a worktree without leaving Yardbell | M |
| CI log view in the pane opens scrolled to the line `telling_line` picks | Find the failure without scrolling a 5,000 line log | S |

---

## 2. Features Yardbell lacks, ranked

Ranked for a developer running many agents across machines over ssh.

**1. Chat view of a live session.** High value, **L**.
The other app: `native-chat/NativeChatView.tsx`; for terminal agents it reads the transcript, including over
SSH (`ref:src/main/native-chat/ssh-transcript-path.ts`, `session-file-resolver.ts`), and sends
replies into the PTY (`composer/submit/use-native-chat-pty-composer-send.ts`). So the other app itself
proves the shape Yardbell can use.
Yardbell has the parts: `src/pipeline/transcript.rs` `read()` turns a Claude Code JSONL into
turns and tool calls; `src/sessions.rs` `transcript_lines_command` reads it over ssh;
`send_script` types into tmux. New: map a session to its transcript (newest
`~/.claude/projects/<encoded cwd>/*.jsonl` for the folder, checked against the session's start
time), tail it by byte offset on each poll, render with `markdown.js`, add Chat to the pane view
switch already reserved in the redesign. Questions and permission prompts stay answered from the
terminal at first. Codex later. Installs nothing.

**2. Diff of any worktree, with notes on lines sent to the agent.** High value, **M** (not L).
The other app: `components/diff-comments/`, notes formatted by `ref:src/shared/diff-comments-format.ts`
`formatDiffComments` as `File:`, `Line:` or `Lines: a-b`, `User comment: "..."`, sent with a scope
menu "All unsent notes" or "This file" (`editor/diff/review/DiffNotesSendMenu.tsx`).
Yardbell already renders diffs for review cards: `src/web/review_api.rs` `diff()` lists files
and pages a file, `src/dispatch/review/diff.rs`, `assets/dispatch-review.js` `loadList`,
`loadFile`, `fileBody`. Generalise it to `GET /worktrees/{machine}/diff?path=&base=` with the base
from the branch's merge-base, show it as a Diff pane view, click a line to add a note, send the
batch through `send_script`.

**3. Send files and voice into terminal sessions.** High value, **M**. Sections 1.1 to 1.3. This is
the user's named pain and the cheapest big win.

**4. Notification feed and bell.** Medium to high, **M**. Section 1.6.

**5. Session history with Resume.** Medium to high, **M**.
The other app: "AI Vault" (`right-sidebar/ai-vault/`, `ref:src/main/ai-vault/runtime-session-scanner.ts`),
continuation (`components/agent-session-continuation/`).
Yardbell: list `~/.claude/projects/<folder>/*.jsonl` and `~/.codex/sessions` over ssh, show the
first user prompt, time and size; Resume starts `claude --resume <id>` in a new tmux session via
`Sessions::create`. Fits in the palette and on a worktree's empty pane.

**6. Per-session model choice.** Medium, **S**.
The other app: `ref:src/main/native-chat/agent-model-catalog/`, a model chip in the composer.
Yardbell: a model field in `newsession.js` that adds `--model` for Claude Code and Codex, shown in
the pane header. Changing model mid-session is typing `/model` into the session, which the `/`
menu above covers.

**7. File browser and previews.** Medium, **M**.
The other app: `right-sidebar/file-explorer/`, Monaco editor. Yardbell has `/machines/{m}/browse` for
folders. Add file reads over ssh with a size cap, render Markdown with `markdown.js`, images,
text with line numbers; drag a file into a composer. No editor: agents edit.

**8. Hibernation of idle agents.** Medium, **M**. From `docs/agent-app-comparison.md`; fits Yardbell's
memory focus. Stop an idle agent with nothing waiting, resume with its resume command on Open.

**9. Tasks page of issues.** Medium, **M**. The other app `components/task-page/`. Yardbell's Linear and
GitHub feeds (`src/triggers/feeds.rs`, `/api/pipelines/tickets`) already fetch them; a page with
Start session and Run pipeline.

**10. Account switching.** Low to medium, **M**. Section 1.5. Only pick existing config folders.

**11. Notes per worktree.** Low to medium, **S**. The other app's site lists Notes. A text field per
worktree stored on the server, insertable into a prompt with `@notes`.

**12. Keep-awake while agents work.** Medium, **M**. `systemd-inhibit` or `caffeinate -i` over
ssh while a machine has a working agent; the other app has `status-bar/CaffeinateStatusSegment.tsx`.

**13. Browser context.** Low for Yardbell. The other app embeds Chromium with element grab and markup
(`browser-pane/annotate/`, `browser-page-grab-action.ts`). Yardbell runs in a browser and tunnels
ports to it, so it cannot reach into another tab. Screenshot paste (1.2) covers most of the need.
A browser extension would be a separate product.

**Not taking:** embedded editor, emulator panes, computer use, cloud VMs, plugins, a hosted relay.
Each needs a native app or software on the machines. Subagent child rows stay low value.

---

## 3. Where Yardbell is already ahead

Keep these; the plan should not trade any of them for parity.

- **Installs nothing on the machines.** the other app installs its runtime on SSH hosts and status hooks
  into agents; its remote attachments fail on "older hosts" until the host is updated
  (`native-chat-session-attachment-upload.ts`). Yardbell reads the screen and files over ssh.
- **Any browser, any device.** The UI is plain HTML served by one Rust server, including the
  phone. The other app needs its Electron app or its mobile app paired through a relay.
- **Pipelines.** Multi-step runs with Linear and GitHub triggers, approvals, answers, checks,
  token budgets (`src/pipeline/tokens.rs`), per-step transcripts and a canvas. The other app's automations
  are one prompt on a schedule.
- **Dispatch as an orchestrator.** Rules for what may go ahead (`src/dispatch/rules.rs`), memory,
  groups, review and scan cards with parsed findings and evidence screenshots
  (`src/dispatch/review/`), saved tasks with version history.
- **Limits handled for you.** Sessions stopped at a usage limit are resumed when it resets
  (`src/web/limits.rs`).
- **Sessions move.** To another machine (`src/worktrees/handoff.rs`), or a stray process into tmux
  (`/sessions/{m}/{pid}/move-to-tmux`).
- **Machine health.** Memory, disk, load, memory alerts, doctor and health pages.
- **Voice done on the server.** whisper.cpp with automatic model download or an API, so the
  phone and WebKitGTK record and nothing else; spoken replies (`voice.js` `speaker`, `spoken`).
- **Attachments checked on both sides** by first bytes, with clear per-file errors.
- **PR handling depth.** CI log excerpts, merge refusals, review comments turned into instructions
  and sent to the session.
- **An MCP server for agents, proposals, insights, diagrams, connectors, mesh pairing** with no
  third-party service.

---

## 4. Recommended order

Ten changes in four shippable projects. Each lands in the redesigned shell and pane header.

**Project A: input everywhere** (the user's named pain; no new views)
1. `POST /sessions/{m}/{n}/files`: upload over ssh into `~/.cache/yardbell/drop/`, return escaped paths. M
2. Drop files and paste images onto a terminal pane, typing the uploaded paths, with a target-naming overlay. S
3. Dictation in `shell.js`: one shortcut (hold, toggle, auto), lands in the focused input or pane, recording pill, silence stop, optional send. M
4. Dispatch composer: queue while busy, long paste as a chip, chip previews. S

**Project B: talk to a session like a chat**
5. Chat view of a live Claude Code session from its transcript over ssh, as a pane view and on the phone. L
6. `composer()` made reusable and placed under the chat view and as a pane prompt bar, with `@` files from `git ls-files` and `/` commands from `.claude/commands`. M

**Project C: review loop**
7. Diff view of any worktree against its base, generalising `review_api.rs` `diff()` and `dispatch-review.js`. M
8. Notes on lines, batched in the other app's `File:` / `Line:` / `User comment:` shape and sent through `send_script`. M

**Project D: attention and history**
9. Persistent notification feed and bell in the strip with deep links; phone taps open the session. M
10. Session history per folder with Resume (`claude --resume <id>`), in the palette and on empty worktree panes. M

Next after these: per-session model (S), Open pull request from the pane header (M), hibernation
(M), Tasks page (M).
