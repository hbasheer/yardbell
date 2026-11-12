# Yardbell and another agent app compared

This compares Yardbell, as it is on `main` at 0.10.414, with
another open-source desktop app for coding agents ("the other app"), read at commit `d1466f60` on
2026-11-10. The other app is MIT. Nothing below copies its code, which is Electron, React and React Native
and would not fit Yardbell's Rust server and lit-html pages anyway; where an idea is worth taking,
the note says how it would be built from Yardbell's own parts.

## What the other app is

The other app is a desktop IDE for coding agents (Electron and React, macOS, Windows and Linux). Every task
is a git worktree with its own branch, shown in one sidebar of hosts, projects, worktrees and the
agents in them. A worktree owns its own tabs and split panes, and a tab holds a terminal, a chat
view of an agent, a diff, an editor or an embedded Chromium browser. A background daemon owns the
terminals, so agents outlive the window. Agents run as their own CLIs; the other app learns their state from
terminal titles and from status hooks it installs into each agent, and can show any agent as a
structured chat instead of a terminal. Around that: a diff viewer where notes on lines go back to
the agent, commit and pull request drafting, GitHub, GitLab, Linear and Jira tasks, a Cmd-J jump
palette, an activity feed and notification bell, session history with Resume, idle agent
hibernation, a usage strip for each provider's limits, scheduled automations, an its CLI CLI that
agents use to start workers, and SSH hosts or a headless `app serve` for remote machines. The
iOS and Android app (React Native) pairs with the desktop through the other app's hosted relay or directly
over LAN or Tailscale, end-to-end encrypted, and gets push notifications through the other app's push
gateway. The UI is "monochrome and quiet": neutral greys, colour only for state, dense 13px rows.

The main difference in shape: the other app is one app on one computer that reaches other machines by
installing itself on them. Yardbell is one server that watches many machines over ssh and installs
nothing on them, reads agent state from the screen, and adds pipelines and Dispatch on top. The other app's
desktop-only parts (an editor, an embedded browser, computer use) need a native app around the UI;
Yardbell's UI is plain HTML for any browser, the desktop apps and the phone.

## Legend

- **Has**: Yardbell already does this, perhaps in its own way.
- **Partly**: some of it is there.
- **Lacks**: not there. Gaps get a value and an effort rating.
- **N/A**: does not fit Yardbell, with the reason.

Effort: **S** is a day or less, **M** a few days, **L** a week or more.

## Layout and look

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| One sidebar of machines, repos, worktrees and agents | Host, project, worktree, agent rows with state glyph, model and age; unread in bold; pin, rename, archive | **Partly** | The dashboard groups by machine; the Workspace sidebar is machine, folder, session. Each page has its own sidebar. Part of the [UI redesign](#1-ui-redesign-shell-workspace-and-phone): one tree on every page, worktrees under their repo, each row with its state, agent and how long ago it last changed. |
| Quiet look with dark and light parity | Neutral greys, colour only for state, three elevation levels, dense rows | **Partly** | Light and dark themes exist (`DESIGN.md`), but pages differ in density and chrome. The redesign sets one set of tokens and row sizes for every page. |
| Jump palette | Cmd-J over worktrees and tabs, needs-you first, matches `#123` and `!123`, offers to create a worktree | **Lacks** | Value **high**, effort **M**. `/` searches the dashboard and `j`/`k` move, but nothing jumps across pages. A palette on every page over sessions, folders, pipelines, runs and conversations, from data the pages already load. |
| Status strip | Usage per provider, keep-awake, a resource manager | **Partly** | The Claude and Codex usage card sits in the sidebar; memory, disk and load are on the dashboard. The redesign moves usage and machine health into one strip along the bottom. |
| Settings search and remappable keys | Cmd-, searches settings; every shortcut remappable | **Lacks** | Value **low**, effort **S to M**. |
| Accent, density, fonts, app icons | Yes | **Lacks** | Value **low**. Light and dark only. |

## Workspace

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| Tabs and split panes | A tab holds a terminal, chat, diff, editor or browser; drag to a pane edge to split; splits nest | **Partly** | Tabs, split right and down, an even grid, drag to move and move to its own tab. A pane holds a terminal only, and Dispatch is a panel beside them. The redesign lets a pane hold a terminal, a [chat view](#agents-and-sessions), a [diff](#review-and-git) or Dispatch. |
| A layout per worktree | Switching worktrees swaps the whole pane tree | **Partly** | A workspace (folder) has its tabs. Same idea; kept. |
| Layout survives closing the app | A daemon owns the terminals; layout and scrollback return | **Has** | tmux keeps every session running when the browser or app closes, and each browser keeps its Workspace layout. |
| Floating terminal | A global terminal not tied to a repo | **Lacks** | Value **low**. A machine's plain shell already opens from its row. |
| Workspace on a phone | The mobile app's session screen | **Partly** | One terminal at a time with a key row and tabs; it reads as a shrunk desktop page. Part of the redesign. |

## Agents and sessions

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| Many agent CLIs | About 40 preconfigured | **Has** | Ten built in, any CLI added by name and command. |
| Agents start with permission checks off | `--dangerously-skip-permissions`, `--yolo` and the like by default, "the worktree itself is the sandbox" | **N/A** | Deliberately not. Yardbell starts agents as their command line says, and Dispatch rules decide what may go ahead. |
| State from the agent | Terminal titles plus status hooks the other app installs into each agent | **Has** (differently) | Read from the screen through manifests, with needs you and error stops. Hooks would mean installing on every machine. |
| Subagents as child rows | Claude and Codex subagents listed under their agent | **Lacks** | Value **low**. |
| Chat view of an agent | Structured chat beside or instead of the terminal, move a conversation between them | **Partly** | Dispatch is a chat, and a pipeline step shows its finished Claude Code transcript as a read-only conversation. Value **high**, effort **L**: a chat view of any live Claude Code session, read from its transcript over ssh as the step view does, with replies typed into the session through the existing send path and attachments as file paths. The terminal stays the source of truth, so no agent protocol is needed. Codex later. |
| Hand off to another agent | New session, maybe another CLI, primed from the transcript | **Partly** | **Move** carries a session to another machine; not to another agent. Value **low to medium**. |
| Session history with Resume | Lists each CLI's past conversations by workspace or project; Resume, copy the command, open the log | **Partly** | New session can continue the last conversation in a folder. Value **medium**, effort **M**: list past Claude Code and Codex conversations per folder from the files Yardbell already reads for tokens, and resume one in a new session. |
| Hibernation of idle agents | Stops an agent idle past a window (30 minutes by default), relaunches with resume flags when you return | **Lacks** | Value **medium**, effort **M**. Fits Yardbell's memory focus: an idle agent with nothing waiting is stopped over ssh and resumed on Open. Off by default, per machine. |
| Several accounts per agent | Isolated homes per account, switch from the status bar | **Lacks** | Value **low**. |
| Usage and limits | Status-bar usage for about ten providers, warning at 80% | **Partly** | Claude and Codex in the sidebar card. Moves into the status strip; other providers only if they publish limits. |

## Orchestration and automation

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| Coordinator that starts workers | `app orchestration` with tasks, mail and decision gates (experimental) | **Has** | Dispatch starts sessions and groups and collects their results; pipelines carry a ticket through steps. |
| CLI for agents | its CLI scripts worktrees, terminals, the browser | **Has** (differently) | Yardbell's MCP server covers machines, sessions, pipelines and settings. |
| Scheduled prompts | Automations with cron or RRULE, a precheck command, run history | **Has** | Triggers and scheduled pipelines. |
| Agent status comments on a worktree | `app worktree set --comment` | **Lacks** | Value **low**. |
| Computer use | Drives desktop apps through accessibility trees | **N/A** | Needs a native helper on each machine. |

## Worktrees and remote

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| A worktree per task | Create dialog with base ref, agent, linked issue or pull request | **Has** | A new branch gets `<repo>-worktrees/<branch>`, with setup and teardown commands, and removal checks what would be lost. |
| Shared folders and copied ignored files | `worktree.sharedDirectories`, `.worktreeinclude` | **Partly** | A folder's setup command can link or copy them. Value **low**. |
| SSH hosts | Installs the other app on the host on first connect | **Has** | The core of Yardbell, and nothing is installed. |
| A server with thin clients | `app serve` and paired clients (beta) | **Has** | Yardbell is that server; the desktop apps connect to it or run it. |
| Ports | Scans and forwards | **Has** | Docker Compose ports, forwarded with live status. |
| Keep the machine awake | Caffeinate while agents work | **Lacks** | Value **medium**, effort **M**. `caffeinate -i` or `systemd-inhibit` over ssh while a machine has a working agent. |
| Cloud VMs per worktree | Bring-your-own provider recipes | **N/A** | Yardbell's point is your own machines. |

## Review and git

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| Diff viewer for a worktree | Staged, unstaged and untracked against the start ref; file tree; image diffs; conflicts | **Lacks** | Value **high**, effort **L**. Review cards show findings, but nothing shows what a session changed. `git diff` against the base over ssh, in a Workspace pane or the session page, with the diff rendering the review cards already use. |
| Notes on lines sent to the agent | Gutter notes, batched into one prompt with file and line | **Lacks** | Value **high**, effort **M** after the diff viewer. Typed into the session through the same send path as **Send to session**. |
| AI-written lines marked | Local attribution | **N/A** | Low value. |
| Commit and push from the UI | Source control panel, AI commit messages and pull request text | **Partly** | Pipelines push and open draft pull requests; Dispatch can push a branch. Value **medium**, effort **M** for a commit box beside the diff. |
| Pull request state, CI, merge, review | PR tab with checks, comments, fix broken checks, auto-merge, stacks | **Has** | Badges, CI, conflicts, Merge, reviews, cards that send failures to the session. Stacked pull requests and auto-merge are missing; low value. |
| A tasks page of issues | GitHub, Linear and Jira issues; start a worktree from one | **Partly** | Linear and GitHub start pipeline runs, and **Run now** picks tickets. Value **medium**, effort **M**: a Tasks page listing your issues with **Start session** and **Run pipeline**. |

## Editing, viewers and browser

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| Code editor | Monaco with autosave | **N/A** | Agents edit; an editor needs an app around the UI. |
| File explorer | Live tree, drag files into a prompt | **Lacks** | Value **low to medium**, effort **M**. |
| Previews of images, PDF, Markdown | Yes | **Partly** | Dispatch files open in a viewer. |
| Embedded browser and design mode | Chromium in a pane, pick an element and send it to the agent | **N/A** | Yardbell tunnels a session's ports to your own browser. |

## Notifications and activity

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| System notifications | Agent finished, PR checks, with sounds | **Has** | Desktop and phone, for waits, errors, ends, machines, memory, pipelines, proposals and pull requests. |
| Notification bell and activity feed | Unread across worktrees; a feed of turns, questions and new worktrees | **Lacks** | Value **medium**, effort **M**. Yardbell keeps the last 50 notifications in memory for a reconnecting phone. Persist them in the state folder and show a bell in the shell, each item linking to its session or run. |

## Mobile app

| Feature | Other app | Yardbell | Notes |
|---|---|---|---|
| Platforms | iOS (App Store) and Android, React Native | **Partly** | Android only (Tauri, the web UI in a WebView). On an iPhone, the browser. |
| Pairing | QR or link; the other app's relay, or direct over LAN or Tailscale; end-to-end encrypted | **Has** | QR from Settings, Connect a phone, over the mesh. No relay. |
| Notifications | Push through the other app's push gateway to APNs and FCM | **Has** (differently) | The app holds a connection over the mesh, with no third-party service. iOS does not allow that in the background, so an iPhone app would need APNs. |
| Sessions from every machine | One list with state | **Has** | The dashboard and Board on a phone. |
| Reply in chat with attachments and dictation | Chat or terminal per session | **Partly** | The terminal with a key row; Dispatch takes files and dictation. A session chat view comes with the [chat view](#agents-and-sessions). |
| Notification opens the session | Yes | **Partly** | Tapping opens the app. |
| Start work from the phone | Create a workspace from GitHub, Linear or a branch | **Has** | New session and Dispatch work on a phone. |
| Phone-first layout | Native screens for home, hosts, session, files, review, tasks | **Partly** | The same pages as the desktop, narrowed. Part of the redesign and of [the mobile app project](#3-mobile-app). |

## Not worth taking

Plugins and a plugin catalogue, public share links (its hosted Artifacts), telemetry, cloud VMs,
the embedded browser and editor, computer use, and agents with permission checks off by default.

## Recommended, as three projects

Each is its own spec, plan and build, in this order, so features land in the new layout once.

### 1. UI redesign: shell, Workspace and phone

Value **high**, effort **L**.

- One shell on every page: a single sidebar tree of machine, repo, worktree and session, each row
  with its state, agent and age, unread in bold, plus the pages (Dashboard, Workspace, Pipelines,
  Dispatch, Settings).
- A quiet look: one set of tokens for dark and light, colour only for state, one row height and
  type scale across pages.
- The Workspace as the main surface: tabs per worktree, panes that hold a terminal, Dispatch, and
  later a chat view or a diff.
- A jump palette (Cmd-J or Ctrl-J) over sessions, folders, pipelines, runs and conversations.
- A status strip with usage and machine health.
- A phone layout designed for the phone: a session list, one session full screen with its key row,
  bottom tabs.

### 2. Features, in order

1. **Chat view of a live session** (high, L), from its transcript, replies typed into tmux.
2. **Diff viewer** (high, L), then **notes on lines sent to the agent** (high, M).
3. **Notification bell and activity feed** (medium, M).
4. **Session history with Resume** (medium, M).
5. **Hibernation of idle agents** (medium, M).
6. **Tasks page** of Linear and GitHub issues (medium, M).
7. **Keep-awake** while agents work (medium, M).

### 3. Mobile app

Value **high**, effort **L**. A remote control rather than a shrunk desktop: the session list, a
session as chat or terminal, replies with photos and dictation, a notification that opens the
session it is about. The open question for its spec is iOS: an App Store app needs an Apple
developer account and APNs for background notifications, which means Yardbell's server sending
pushes through Apple; a home-screen web app can get Web Push on iOS 16.4 and later, but only over
`https`.
