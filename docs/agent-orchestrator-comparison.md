# Yardbell and Agent Orchestrator compared

This compares Yardbell, as it is on `main` at 0.10.404, with
[OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator)
("AO"), read at commit `449b6fe` on 2026-11-08. AO is Apache-2.0. Nothing below copies its code;
where an idea is worth taking, the note says how it would be built from Yardbell's own parts.
Releases 0.10.405 to 0.10.410, merged in after it was written, added a viewer for Dispatch files, the
Workspace grid and voice in Dispatch; none of them changes a row below. The four features built from
it (merge conflicts, pull request notifications, the board and error stops) are in 0.10.411.

## What AO is

AO is a desktop app (Electron and React) over a local Go daemon with a SQLite store. A project has
an orchestrator agent that plans work and spawns workers, each in its own worktree and branch. The
daemon polls GitHub and GitLab every 30 seconds and feeds pull request facts into a lifecycle
manager, which types CI failures, review comments and merge conflicts back into the worker that
owns the branch. Sessions sort into Kanban lanes (Working, Needs you, In review, Ready to merge)
derived from the agent's activity and its pull request. It installs hooks into each agent (Claude
Code's `SessionStart`, `Stop`, `PermissionRequest` and so on) to know exactly when an agent works or
waits. It also has a structured chat mode beside the terminal, a per-worker embedded browser that
the agent can drive, an automatic reviewer agent, recurring automations, saved prompts ("Cues"),
a notification feed, iOS and Android apps, and hosted cloud workers.

The main difference in shape: AO runs everything on one machine (or a cloud), installs hooks into
agents and owns their lifecycle. Yardbell watches many machines over ssh, installs nothing on them,
reads agent state from the screen, and adds pipelines and Dispatch on top. Several AO features are
answers to problems Yardbell solves another way, and those are marked as such.

## Legend

- **Has**: Yardbell already does this, perhaps in its own way.
- **Partly**: some of it is there.
- **Lacks**: not there. Gaps get a value and an effort rating.
- **N/A**: does not fit Yardbell, with the reason.

Effort: **S** is a day or less, **M** a few days, **L** a week or more.

## Orchestration

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Orchestrator agent that plans and spawns workers | Project orchestrator spawns workers with `ao spawn` | **Has** | Dispatch picks the machine and starts sessions; groups start several at once and collect results. |
| One worktree and branch per task | Yes | **Has** | `<repo>-worktrees/<branch>`, with setup and teardown commands. |
| Workers without a project | Standalone workers | **Has** | Any folder on any machine. |
| Worker reports to the orchestrator (done, needs input, stuck) | `ao report`, batched and routed to the orchestrator | **Partly** | Group children end with a `YARDBELL RESULT` block, and Dispatch follows every session it starts. There is no mid-task "stuck" channel. Low value: Dispatch already sees waits from the screen. |
| Many agent CLIs | About 40 | **Has** | Ten built in plus any CLI agent added by name and command. |
| Model chosen per task | `--model` on spawn | **Partly** | Dispatch has a model setting; a session's model is whatever its command line says. Low value. |

## Status and the board

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Status derived from activity and pull request (CI failed, changes requested, conflict, mergeable) | One display status with fixed precedence | **Partly** | Activity and the PR badge are shown side by side, not combined into one state. |
| Board with lanes across all projects | Kanban: Working, Needs you, In review, Ready to merge | **Lacks** | Value **high**, effort **M**. The dashboard groups by machine with an All, Working, Idle filter. A **Board** view would lay every session across all machines into lanes from data the page already has: activity from the snapshot and the PR state from the pulls cache. No new polling; `dashboard.js` gains a layout toggle. |
| Exact activity from agent hooks | Installs hooks into each agent's settings | **N/A** | Yardbell installs nothing on the machines it manages and reads state from the screen through its manifests. Hooks would break that promise and need a callback path from every machine. |
| Turn that ended on an error | Detects a failed or interrupted turn from the transcript and marks it | **Lacks** | Value **medium**, effort **S to M**. An agent that stopped on "API Error", an overload or a rate limit shows as idle. Manifest rules can match those lines and report a new `error` state (or Blocked with a reason), so the badge, phone and Dispatch say the agent stopped on an error rather than finished. |
| Guard against marking a whole board dead | Circuit breaker in the reaper | **Has** | Yardbell never ends a session because a probe failed; an unreachable machine shows as such and its sessions stay. |

## Pull request feedback loop

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| CI failure sent to the owning agent | Automatic nudge with the failed checks | **Has** | Dispatch posts a card with the failed checks and **Send to session**; a rule that allows typing into sessions makes it automatic. A pipeline's **Wait for CI and reviews** loops into a Fix step. |
| Review comments sent to the owning agent | Per comment, at most 3 attempts | **Has** | One card per comment, and the pipeline loop. |
| Merge conflict detection and a rebase nudge | Reads mergeability, nudges "rebase onto the base branch", skips PRs stacked on an open parent | **Lacks** | Value **high**, effort **S to M**. Yardbell never reads mergeability, so a conflicted PR looks green. Add `mergeable` and `mergeStateStatus` to the `gh pr view` fields (GitLab: `has_conflicts` / `detailed_merge_status`), show a **Conflicts** badge, post a conflict card with **Send to session** ("rebase onto main and resolve"), let **Wait for CI and reviews** follow fail with the conflict in its report, and record it in Insights. Same dedup as CI: one card per head commit. |
| Per-PR switch for automatic sending | `auto_inject_ci`, `auto_inject_review` per PR | **Has** | Dispatch rules decide per machine and folder, which covers it. |
| Merge from the app | `POST /prs/{id}/merge` | **Lacks** | Value **medium**, effort **S to M**. A **Merge** button on an approved, green, conflict-free PR, run as a Dispatch step like **Push a branch** so rules apply and it asks by default. `gh pr merge` on the session's machine or the GitLab API. |
| End the session when its PR merges | Terminates the session once every PR it owns is merged or closed and the agent is quiet | **Lacks** | Value **medium**, effort **M**. Off by default. When a session's PR merges and the agent is idle, stop the session and, when the worktree would lose nothing (the existing `at_risk` check), remove it and its merged branch. |
| Resolve review threads from the app | `resolve-comments` route | **N/A** | Low value; the agent or the reviewer resolves them on the forge. |

## Review

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Reviewer agent that did not write the code | Separate reviewer harness, read-only by prompt, posts inline comments | **Has** | **Review branch** and pipeline review steps start a read-only session. |
| Automatic review of every PR a worker opens | `autoReview` per project: once the worker has been idle a minute, review each new head commit, retry at most 3 times | **Partly** | Pipelines can review, and a review request on GitHub or GitLab can start one, but nothing starts a review because one of your own sessions opened or pushed to a PR. Value **medium to high**, effort **M**. A pipeline trigger **When a session's pull request opens or gets new commits** fits the existing trigger list and reuses the review templates; it starts once per head commit. |

## Notifications

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Push to a phone | iOS and Android apps | **Has** | Android app over the mesh, no third-party push service. |
| Notifications for PR events | Ready to merge, merged, closed without merge | **Lacks** | Value **high**, effort **S**. Phone and desktop notify on agent waits, session ends, machines and memory, pipelines and proposals, but not on PRs. Add events for CI failed, conflicts, ready to merge (approved, green, no conflict), merged and closed, each with its own switch, from the PR checks Yardbell already makes. |
| Notification feed in the UI | Newest-first feed with read state, clear one or all | **Lacks** | Value **medium**, effort **M**. Yardbell keeps the last 50 for a reconnecting phone, in memory. A bell in the sidebar listing recent notifications with links would help when the phone was not looking. Persist in the state folder like `insights.json`. |

## Automation

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Recurring automations | Cron or RRULE with time zones and catch-up | **Has** | Triggers: daily, weekdays, every few hours, cron, with a late run after downtime. |
| Start work from tracker issues | GitHub and GitLab intake, opt-in | **Partly** | Linear and GitHub issues and review requests. GitLab issues are missing. Value **low to medium**, effort **M**. |
| Saved prompts and commands ("Cues") | Per-project prompt sent to a session, or a shell command run in its worktree | **Partly** | Saved tasks feed Dispatch and triggers, but nothing types a saved prompt straight into a running session. Value **medium**, effort **S**. A **Quick sends** list in Settings, offered in the Workspace pane's ⋯ menu and the terminal key row, typing the text through the existing send path. |

## Sessions

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Exit and resume the agent, separate from kill | Yes | **Has** | Resume, Continue the last conversation, Move to tmux. |
| Worktree setup and cleanup scripts | Yes | **Has** | Setup command and teardown. |
| Move a session elsewhere | Move between terminal and chat UI | **Has** (differently) | **Move** carries a session's work to another machine. |
| Structured chat mode for agents | Chat timeline beside the terminal, with handoff | **N/A** | Large and tied to each agent's protocol (ACP, Codex app-server). Yardbell's terminal works on every agent, and Dispatch is its chat. |
| Several accounts per agent | Claude and Codex config folders, switch a session between them | **Lacks** | Value **low**, effort **M**. |
| Tokens used per session | Usage pipeline parses transcripts, with a pricing catalog | **Partly** | The Claude plan card, and pipeline token limits from transcripts (`pipeline/tokens.rs`). Insights does not show a session's tokens. Value **medium**, effort **M**: reuse the pipeline's transcript reading in Insights. |
| Name a session from its task with a model | One cheap model call to name the branch | **N/A** | Yardbell names by folder, ticket and branch, which is what users scan for. |

## Preview and browser

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Embedded browser per worker that the agent drives, with DevTools | Electron `WebContentsView` over CDP | **N/A** | Yardbell's UI is plain HTML in any browser and phone; it tunnels the session's ports instead. Agents that need a browser can use a Playwright MCP server. |
| Preview a file the agent made (HTML, Markdown, PDF) | `ao preview` | **Lacks** | Value **low**, effort **M**. |
| Supervised dev server per worktree | `.ao/launch.json` | **Partly** | Docker Compose ports are found and forwarded; worktree setup can start things. |

## Machines, remote and platform

| Feature | AO | Yardbell | Notes |
|---|---|---|---|
| Reach the host from a phone | LAN listener, Cloudflare tunnel, Tailscale pairing | **Has** | Mesh VPN aware, QR pairing. |
| Keep the machine awake while agents work | `caffeinate` on macOS while work runs | **Lacks** | Value **medium**, effort **M**. A laptop that sleeps stops its agents. While a machine has a working agent, Yardbell could hold `caffeinate -i` (macOS) or `systemd-inhibit` (Linux) over ssh, both built in, so nothing is installed. A per-machine switch. |
| Cloud workers | Hosted workspaces | **N/A** | Yardbell's point is your own machines. |
| CLI for agents inside sessions | `ao spawn`, `ao send`, `ao session` | **Has** | The MCP server covers list, start, read and answer. |
| Product telemetry | PostHog | **N/A** | Deliberately not. |

## Recommended, in order

1. **Merge conflicts end to end** (high, S to M). A conflicted PR is the one failure Yardbell cannot
   see today, and every piece it needs (badge, card, Send to session, pipeline wait, Insights)
   already exists for CI.
2. **PR notifications** (high, S). CI failed, conflict, ready to merge, merged, closed, each with a
   switch, on phone and desktop. Small, and it closes the loop when you are away.
3. **Board view** (high, M). Lanes across every machine: Working, Needs you, CI or review,
   Ready to merge, Done. Built in the browser from data the dashboard already has.
4. **Agent stopped on an error** (medium, S to M). Manifest rules for API errors and rate limits,
   shown as their own state and notified like a wait.
5. **Automatic review of your sessions' PRs** (medium to high, M). A pipeline trigger on a
   session's PR opening or getting new commits, once per head commit.
6. **Merge from Yardbell** (medium, S to M). A rule-gated Dispatch step that asks by default.
7. **Quick sends** (medium, S). Saved prompts typed into a session from the pane menu.

Worth doing later: tokens per session in Insights, keep-awake, a notification feed, end the
session when its PR merges, GitLab issue triggers.
