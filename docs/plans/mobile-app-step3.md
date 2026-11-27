# Phone app step 3: Changes, files, pipelines, reviews and settings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** finish "everything in Yardbell from the phone": commit what an agent did, read the files it
wrote, follow and answer pipeline runs, read a review's diff, change Dispatch and notification
settings, and dictate into a terminal, with the same look as the rest of the app.

**Architecture:** the server already accepts the phone's bearer token on every route in scope. Two
small server additions (a waiting-runs count in `/state` and a brief runs list) avoid polling the
full runs payload. The phone gets API clients for changes, files, pipelines, triggers, insights,
memory and prompt history, one shared code-viewing layer (diff list and text viewer) used by
Changes, Files, reviews and prompt history, and new screens built from `mobile/src/ui`.

**Tech stack:** as step 2. No new native modules expected; any new package goes into
THIRD_PARTY_NOTICES.md.

**Spec:** `docs/plans/mobile-app-design.md` (step 3 in Delivery order). Survey with every web control,
endpoint, shape and reference component: `docs/plans/mobile-app-step3-survey.md` (sections A to I).
The redesign survey `docs/plans/mobile-app-orca-survey.md` stays the visual authority for tokens,
sheets and lists.

## Global Constraints

- Match the web's behaviour (survey A to F) and Orca's look. Orca's source-control and files code
  depends on shared modules outside its MIT mobile folder: copy its visual values and layout, write
  Yardbell's own components.
- Every control the web offers on a surface in scope is either built or listed under "Not built" in
  the task report with the reason.
- Read-only files: no file editing, no upload from the Files screen, no image preview route.
- Pipelines: runs and the definition as a list; no canvas and no pipeline editing.
- Every action button is disabled while its request is in flight; a git or pipeline error shows the
  server's message whole.
- Multiple servers: every list and screen is per server; with more than one server, lists say which.
- Theme tokens only, light and dark; lucide icons; no `Alert.alert`; long text truncates; code and
  diffs scroll sideways.
- Every configurable feature gets a Settings control.
- No em dashes in user-visible text. Never write "Orca" in commit messages. No co-authored or
  generated-by lines.
- Vitest for pure modules; Rust tests for server changes; the web preview and the phone for screens.
- Before the release PR: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and the
  `desktop/` crate's tests, as CI runs them.
- Version: this ships as the next release after 0.11.110.

## Review Focus

1. A push that needs a passphrase or a credential helper: the phone shows git's message whole and
   the Changes screen is usable again, never a spinner that stays.
2. Commit with nothing staged commits every change (as the web does): the confirm says so in words
   before anything runs.
3. A 5000-line diff page or a 1 MB file on a low-end phone: the list is virtualised, scrolling stays
   smooth, nothing runs out of memory.
4. A double tap on Commit, Push, a pipeline action or Run now: one request reaches the server.
5. A Dispatch setting saved on the phone while the web changed another one: the phone re-reads before
   saving, so the web's change survives, and the screen shows the server's values after the save.

---

## Decided

| Area | Decision |
|---|---|
| Changes | Entry from the session menu, the machine row menu and a folder picker. Branch line, Staged and Changes sections, swipe Stage / Unstage / Discard with the web's confirms, tap opens the file's diff (a files sheet steps through files), commit box with Draft, Commit, Commit and Push, Push, Pull, Fetch, Refresh. Polls every 5 s while focused and the app is active. Branch switching, opening a PR and commit history are not built (no server routes). |
| Files | Lazy tree with change colours, dotfiles toggle (kept per phone), Names and Contents search, a text viewer with line numbers, markdown with a source and preview toggle, "binary file" and "too large" states, copy path and relative path. Read-only. |
| Code viewing | One diff list (two line-number gutters, signs, hunk and fold rows, sideways scroll, "Show N more" paging, binary and cut notes) and one virtualised text viewer, shared by Changes, Files, review panels and prompt history. |
| Reviews | Inside the existing ReviewCard: Changes panel (file list, 400-line pages, base note, moved warning), finding places that open the file at the line, scan Files panel, commit standing line, evidence thumbnails with a full-screen pan and zoom view. Diff line notes to an agent are not built. |
| Pipelines | Home Feed row with `runs_waiting` and a Pipelines entry in the Dispatch header menu. List with On/Off and counts, Waiting for me, pipeline screen with Runs, History (read-only) and the definition as a vertical node list, run detail (needs-you box with every action, held box, token bar, steps timeline, report, history, chips), transcript sheet, terminals open the session screen, Stop session, Drop, Delete run, Clear ended, Run now sheet. Dispatch conversation rows gain the pipeline mark from the brief runs list. |
| Dispatch extras | Saved prompt history (versions, word diff, Restore, Reset to the default), Insights sheet with Suggest a better prompt (from the session card, session menu and machine row menu), Review branch in the session and machine row menus. |
| Server settings | Settings > per server: Dispatch (agent, model with search, agent for new sessions, approval, rules, instructions with counter, memory list with cap bar and history), Phone notifications (the server's switches and wait minutes), Triggers (switch, Run now, open the conversation it starts). Re-read just before each save. A footer names what stays on the computer. Power, voice, health, Machines, Mesh, Integrations, MCP, agent installs and Security are not built. |
| Terminal dictation | Mic beside Attach in the live input row, reusing Task 10 of step 2 (MicButton and useDictation). The words are pasted into the terminal without Enter. |
| Server | `StateView.runs_waiting`; `GET /api/runs?brief=1` (no definition, steps or history) with an optional `state=` filter; web sidebar uses the count. No file bytes route, no settings field route. |

Not built, with reasons: pipeline canvas and editing (over 2,200 lines of desktop drag and form code,
and Dispatch can already change a pipeline), file editing and image preview (agents edit, people
review; images would need a new route), diff line notes (a desktop review flow), branch switching,
PR creation and commit history (no server routes), Ports (localhost links point at the computer),
Machines, Mesh, Integrations, MCP, agent installs, Worktree setup, Diagrams and Security (computer
tasks, some risky from a lost phone), Dispatch event paging (whole list still fine).

---

### Task 1: Server: waiting runs count and a brief runs list

**Files:** `src/state.rs` (StateView), `src/web/mod.rs` (state fill), `src/web/pipeline_api.rs`
(runs list), `src/web/tests/pipeline.rs`, `web/src/lib/state.ts` and the sidebar, `desktop/src/*`
test views.

- [ ] `StateView.runs_waiting: usize` = runs that ask for the person (`state == waiting`, or queued
      with `held.told`), the same rule as web/src/pipelines/model.ts `asksForYou`.
- [ ] State is touched when that count can change (check the engine already does; add where not).
- [ ] `GET /api/runs?brief=1` returns `{id, pipeline, pipeline_name, state, step, step_since,
      waiting, held, subject, conversation}` per run; `state=<word>` filters. The full list is unchanged.
- [ ] Web sidebar Pipelines badge reads `runs_waiting`.
- [ ] Desktop crate test views set the new field.
- [ ] Tests: count for waiting and held runs, brief shape has no definition, state filter, `/state`
      includes the count.
- [ ] `cargo test`, `cargo fmt --check`, clippy, `desktop/` tests, web `tsc`, `npm run build` in web/
      and commit assets/app. Commit.

### Task 2: Phone API clients, types and routes

**Files:** `mobile/src/changes/api.ts`, `mobile/src/files/api.ts`, `mobile/src/pipelines/api.ts`,
`mobile/src/pipelines/model.ts`, `mobile/src/settings/serverApi.ts`, `mobile/src/state/types.ts`,
`mobile/src/notifications/route.ts`, tests.

- [ ] Clients for every endpoint in survey A.2, B.2, C.2, D, E.2, E.3 used by later tasks, matched
      against the Rust handlers' routes and serde shapes.
- [ ] Pure ports of the web's pipeline model (`asksForYou`, `flow`, `nodeState`, `describe`,
      `stateWord`, `triggerWords`) and change status letters, with Vitest.
- [ ] Route `{server}/pipeline?p=<pipeline>&run=<id>` to the run screen.
- [ ] Extend the preview mock server with fixtures for changes (staged, unstaged, binary, a long
      diff), files (tree, markdown, a large file), pipelines and runs in every state, triggers,
      memory, insights and prompt history.
- [ ] Commit.

### Task 3: Code viewing

**Files:** `mobile/src/code/DiffList.tsx`, `mobile/src/code/TextViewer.tsx`, `mobile/src/code/model.ts`.

- [ ] Diff list per Decided, built on FlatList, with paging and the binary, cut and too-large notes.
- [ ] Text viewer: virtualised lines with numbers, copy, jump to a line, markdown preview through
      mobile/src/markdown.
- [ ] Tests for hunk parsing, line numbering and paging. Gallery entries and screenshots, dark and
      light, including a 5000-line diff (Review Focus 3).
- [ ] Commit.

### Task 4: Changes

**Files:** `mobile/app/changes/...`, `mobile/src/changes/*`, session and machine menus.

- [ ] Screen per Decided; confirms with the web's wording; the commit-everything confirm (Review
      Focus 2); busy states (Review Focus 4); errors shown whole (Review Focus 1).
- [ ] Polling gated on focus and AppState active.
- [ ] Screenshots, every state and sheet. Commit.

### Task 5: Files

**Files:** `mobile/app/files/...`, `mobile/src/files/*`.

- [ ] Screen per Decided, opened from the session menu, machine row menu and the folder picker
      shared with Task 4; viewer through Task 3.
- [ ] Screenshots. Commit.

### Task 6: Review and scan viewer

**Files:** `mobile/src/dispatch/cards/ReviewCard.tsx` and new panels.

- [ ] Panels per Decided; finding places open Files at the line; evidence viewer.
- [ ] Screenshots. Commit.

### Task 7: Pipelines and runs

**Files:** `mobile/app/pipelines/...`, `mobile/src/pipelines/*`, Home Feed, Dispatch list rows.

- [ ] Screens per Decided; every needs-you action from the web run page; Run now sheet; busy guards.
- [ ] Feed row from `runs_waiting`; pipeline mark on Dispatch rows from the brief list.
- [ ] Screenshots. Commit.

### Task 8: Dispatch extras

**Files:** `mobile/src/dispatch/prompts/History*`, `mobile/src/dispatch/insights/*`, menus.

- [ ] Prompt history, Insights with Suggest a better prompt, Review branch entries per Decided.
- [ ] Screenshots. Commit.

### Task 9: Server settings

**Files:** `mobile/app/settings/server/...`, `mobile/src/settings/server/*`.

- [ ] Sections per Decided; re-read before save (Review Focus 5); rules editor in a BottomDrawer;
      memory with history; triggers with Run now.
- [ ] Tests for the save merge. Screenshots. Commit.

### Task 10: Terminal dictation

**Files:** `mobile/src/terminal/LiveInput.tsx`, session screen.

- [ ] Mic per Decided; text pasted without Enter through the session's existing paste path; the
      same permission and background rules as the composer mic.
- [ ] Commit.

### Task 11: Build, notices, release prep

- [ ] THIRD_PARTY_NOTICES.md for any new package; regenerate notices.ts.
- [ ] CI's checks locally (Global Constraints), version bump, changelog, apk build, phone check of
      the Review Focus items, then release with the user's approval.
