# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com)
and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

- Dispatch follows the sessions it starts: a card in the conversation when one finishes, waits for
  an answer or ends, with the agent's choices as buttons and **Review branch** to start a reviewer.
  The conversation lists its sessions and their state.
- Dispatch splits work with independent parts into several sessions, proposes a plan and waits
  for your go-ahead before working through tickets, and can use the MCP servers from Settings,
  such as Linear.
- Saved tasks above Dispatch's message box, with **What's going on?** and **Plan my Linear
  tickets** built in.
- Workspace: a **⋯** menu on each terminal opens it to the right, below or in a new tab, and tabs
  are renamed in place by double-clicking or from their right-click menu.

## [0.6.0] - 2026-10-25

- The Android app shows Yardbell's phone notifications itself, with no ntfy app or setup: an agent
  waiting, a session ended, a machine down or back, memory running out. It keeps a connection to
  the server over the mesh VPN in the background, also after the phone restarts, and asks once to
  be left out of battery optimization so the connection survives while the phone sleeps.
- ntfy is gone. Its `server`, `topic` and `token` settings are ignored, and the Settings page only
  keeps the switches for which notifications the app shows, and whether the app is connected.
- Servers on the mesh are found for you. The phone app lists them under **On your mesh** and the
  desktop app on its Connect screen, so signing in takes only the passcode. The phone remembers
  every server it has seen, also after you remove one. Servers answer `/app/hello` and list the
  others at `/app/servers`.
- Every page says where the server runs, for example "Running on hp 100.120.226.174:4000".
- Light and dark theme: a button in every sidebar, and Settings → Appearance, saved per device.
  The desktop app's window and tab bar and the Android app's status bar follow it.
- Workspace: a new tab opens the same New session dialog as the dashboard, closing a tab with
  running sessions asks whether to stop them, and the sidebar is one tree of machine, workspace and
  terminals, with buttons to open any terminal to the right of or below the focused pane. A
  workspace is now a folder on one machine, so the same folder name on two machines no longer
  shares one. On a phone, New session and a new tab are available too.
- Only the terminal in use sets a session's size. A hidden tab, a background pane or a phone in a
  pocket no longer squeezes the agent's screen, which left Claude Code's input box with empty
  lines and the cursor in the wrong place.
- Swiping or scrolling scrolls Claude Code's full-screen mode, which keeps no tmux history, by
  sending it the mouse wheel.
- New session lists only the agents installed on the chosen machine, with the rest under
  **Other agent…** and **Add an agent…** to save a new one. Settings → Dispatch lists the agents
  installed anywhere, with where. Branch choices are clearer option rows.
- Adding a machine lets you pick its project folder from that machine's folders after the check,
  instead of typing it before.
- Settings has its own section list, one section at a time, and explains the port prefix with real
  numbers. Settings, Dispatch and Add machine have a link back to the dashboard.
- Each machine shows its disk use next to memory and CPU: on the dashboard, in the desktop tray
  panel and in the MCP machine list. It is the disk that holds the machine's project folder.
- An empty Workspace pane offers to start your agents in the workspace's folder or to open one of
  its running agents.
- Starting an agent in a folder that already has a session starts a second one (`hp-app-2`) instead
  of failing with "duplicate session".
- Workspace panes load their terminals in the desktop app. Before, the app opened each pane's
  terminal as a tab of its own and left the pane empty.
- The Android app keeps pages clear of the status bar, navigation bar and keyboard, scanning a
  pairing code no longer crashes it, and the APK is smaller (18 MB, was 51 MB).
- On a phone, a dashboard card opens only through its **Open** button, so taps on Stop and the
  other buttons are not taken as opening the session.

## [0.5.0] - 2026-10-24

- **Workspace**, modelled on herdr: a workspace per project with the state of its agents rolled
  up, tabs inside each workspace, and panes you split right or down and resize by dragging the
  border. Agents show as blocked (waiting for your answer or approval), working, done (finished
  while you were looking elsewhere) or idle. Keyboard: Alt+1 to Alt+9 to go to a pane, Alt+\ and
  Alt+- to split, Alt+X to close, Alt+T for a new tab, Alt+[ and Alt+] between tabs, Alt+↑ and
  Alt+↓ between workspaces, also from inside a terminal. On a phone it shows the list, then one
  terminal at a time.
- Agent state comes from what the agent shows on screen, using herdr's detection rules, instead of
  being guessed from CPU use. A permission prompt or question shows as **Needs you** on the
  dashboard and sends the waiting notification at once, without the 20 second wait. Claude Code,
  Codex, Gemini CLI, Qwen Code, opencode, Copilot CLI, Cursor Agent and the other agents herdr
  knows are covered; for the rest, CPU use is still the estimate.
- On a phone, only the page content scrolls and the header stays put.
- The desktop app comes as an `.rpm` for Fedora and openSUSE too, next to the `.AppImage` and the
  `.deb`.
- Swiping a terminal on a phone scrolls back through its history. It did nothing before, because
  agents draw on tmux's alternate screen where the browser terminal keeps no scrollback. The mouse
  wheel does the same on the desktop instead of sending arrow keys to the agent. Typing anything
  returns to the live screen first.
- The Android app reports its real version (0.4.2 showed as 1.0 in Android's app settings). Its
  version now comes from `android/Cargo.toml`, with version code major × 1,000,000 + minor × 1,000
  + patch.

## [0.4.2] - 2026-10-24

- **Android app**: pair a phone by scanning a QR code from **Settings → Connect a phone**, with no
  passcode to type. Each code works once, for five minutes, and the phone keeps a normal login.
  The app lists your servers and shows their dashboard, terminals and Dispatch, opening terminals
  in the same view. Download `Yardbell_<version>_android.apk` from the release.
- Sessions outside tmux have **Stop** next to **Move to tmux**. It ends the agent, also one
  suspended with Ctrl+Z, and gives its terminal the prompt back; the session then shows under
  ended, where **Resume** continues its conversation.
- Move to tmux works on an agent that was suspended with Ctrl+Z in its terminal. It used to fail
  with "the agent is still running after 8 seconds", because a suspended process only acts on the
  stop signal once it is continued.

## [0.4.1] - 2026-10-23

- **Dispatch settings**: your own instructions for Dispatch, the agent it starts in new sessions,
  and the Claude model that runs it (Sonnet, Opus or Haiku), in a new Dispatch section of Settings.
  The Dispatch page links to it.
- README screenshots show the current pages, including Dispatch, and example text uses made-up
  project names.

## [0.4.0] - 2026-10-23

- A Docker that stopped answering no longer marks its machine down. Its port list waits at most
  3 seconds, and the machine stays up without ports until Docker answers again.
- A local machine whose check takes too long is "machine check timed out", not "ssh timeout",
  since no ssh is involved.
- **Dispatch**: a chat page that takes a task, picks the machine that has the repository and the
  most room, and starts an agent there with the task. It runs Claude Code on the host with only
  Yardbell's tools. Conversations are kept in a list beside the chat, and can be reopened, deleted
  or cleared.
- **Agent tools (MCP)**: Yardbell serves MCP at `/mcp`, so Claude Code and other clients can list
  machines, sessions and folders, and start, read, answer and stop sessions. It is off until turned
  on in Settings, which shows the `claude mcp add` command.
- **MCP servers for sessions**: list other MCP servers in Settings and Claude Code sessions get them
  when they start, without writing anything on the machines.
- Agents take a starting task through the new `prompt_arg` setting, set for every built-in agent
  that supports one.
- The desktop app can set up and run a Yardbell server on its own machine from the connect screen.
  It finds the mesh VPN (NordVPN, Tailscale, NetBird or ZeroTier) and this machine's mesh address
  by itself, so phones and other machines can reach the new server.
- The desktop app's tab bar has **Sign out**, and **Disconnect** in the tray and panel is now **Sign
  out**. Signing out also stops a server the app runs itself and stops starting it with the app,
  so the connect screen can switch to another server or set up this machine again.
- When the mesh address is missing at startup, for example because the VPN is off, Yardbell serves
  on localhost and logs a warning instead of refusing to start.
- Add machine reuses an existing `~/.ssh/config` entry with the same name when it points at the same
  address and user, instead of refusing the name.

## [0.3.4] - 2026-10-21

- Move to tmux, New session, Resume, Stop and Forget show their result in the session list right
  away. The list was redrawn from the last machine check, which can be up to `poll_seconds` old,
  so a moved session stayed under "outside tmux" until the next check or a manual refresh.

## [0.3.3] - 2026-10-21

- Starting a session checks that its agent is installed on that machine, and that it is still
  running a second later. If not, New session, Resume and Move to tmux say so ("Codex is not
  installed on studio") instead of opening a tab for a session that already ended.
- Recent folders in New session can be removed with the cross on each one, and show the last two
  parts of the path. "Continue the last conversation" is a switch with a short explanation.
- Open dashboard and settings pages reload themselves when the server restarts with different page
  files, so a browser tab or the desktop app never keeps running outdated page code. A page with a
  dialog open waits until it closes.
- The desktop app's connecting screen has **Use another server**, and after 20 seconds without an
  answer it shows the error with **Retry** and **Change server** instead of waiting forever.

## [0.3.2] - 2026-10-20

- New session and Move to tmux work on the machine running the server when the server was started
  from a terminal. The login shell that starts the session was stopped by that terminal, and the
  request failed with "did not answer in time".

## [0.3.1] - 2026-10-20

- The macOS app shows its tab bar. It sat behind the window's title bar, so new sessions opened in
  tabs you could not see.
- On macOS a left click on the menu bar icon opens a panel: each machine with its memory and CPU,
  the sessions you can open (click one to go to its tab), New session, Open Yardbell, and a gear
  for the notification switches, Start at login, Disconnect and Quit. A right click opens the menu.
- The menu bar menu lists every session you can open under **Sessions**, with "working" after the
  busy ones. Clicking one brings the app forward on that session's tab.
- The menu's machine lines sit under **Machines** with a state dot, a memory bar, and memory and
  CPU percentages, and are readable in a dark menu bar. Clicking one opens the dashboard on that
  machine.
- On Linux the tray icon is the Yardbell mark in the state color instead of a plain dot.

## [0.3.0] - 2026-10-20

- On macOS the desktop app shows the Yardbell mark in the menu bar instead of a colored dot. It
  gets a dot when a machine is down or memory is high, and fades when the server can't be
  reached. A left click on it opens the menu like other menu bar items.
- The desktop app keeps the dashboard and every terminal in one window with a tab bar, instead
  of a window per terminal. Switch with `Ctrl+1` to `Ctrl+9` (`⌘1` to `⌘9` on macOS) or
  `Ctrl+Tab`, and close a terminal tab with `⌘W` on macOS and `Ctrl+Shift+W` inside a Linux
  terminal (plain `Ctrl+W` goes to the shell there).
- A machine is reported down only after it has been unreachable for a minute, in the desktop app
  and in phone notifications. A brief mesh or ssh hiccup no longer sends "down" and "back".
- Phone notifications through ntfy: the server tells your phone when an agent is waiting for you
  (after `wait_minutes`, 2 by default, and only if you have not answered it by then), a session
  ends, a machine goes down or comes back, or memory reaches 95%, with no browser tab or desktop
  app open. Set them up, send a test and choose what to hear about in the new
  **Phone notifications** section of Settings, or under `phone_notifications` in the config.
  Self-hosted ntfy servers work too.
- Terminals on other machines show symbols and other non-ASCII characters. tmux drew `_` for
  them when the ssh session had no locale, which is usual on a Mac.

## [0.2.1] - 2026-10-20

- The macOS app opens the dashboard. macOS blocked plain http:// pages in the app's window, so
  it stayed on Connecting.

## [0.2.0] - 2026-10-20

- Support for AI coding agents besides Claude Code: Codex, Gemini CLI, Qwen Code, opencode, Copilot
  CLI, Cursor Agent, Crush, Goose and Aider are built in, and any other CLI agent can be added with
  `agents` in the config. New session has an agent picker, every session shows its agent, and
  Resume uses that agent's own resume command.
- Add machine reports which agents are installed.
- Sessions started outside tmux are folded under their machine, and **Move to tmux** restarts one
  inside tmux with its agent's resume command so it can be opened.
- The dashboard is grouped by machine: each section shows the machine's health with its sessions.
  The sidebar is slim navigation shared by every page (Settings and Add machine use it too), and on
  a phone machines become a scrolling strip so sessions come first.
- Header actions: search (`/`), All / Working / Idle filter, Refresh now, and per machine a fold
  toggle, New session here, Open a shell, and a menu with Machine settings, Copy ssh command and
  Remove machine.
- `default_agent` config setting.
- Copying from the browser terminal: tmux selections reach the system clipboard (OSC 52), browser
  selections copy on release, and **Copy text** shows the screen as selectable text for phones.
- Desktop app for macOS and Linux: the dashboard in a window of its own, terminals in separate
  windows with a real clipboard and shortcuts, a tray icon with the state of every machine, and
  system notifications when an agent is waiting, a session ends, a machine goes down or comes back,
  or memory passes 95%. When the server can't be reached at launch, the app says so, offers Retry
  and Change server, and tries again every 5 seconds. Releases carry an unsigned `.dmg`, an AppImage
  and a `.deb`. The server gained one-time login codes (`/app/handoff`) so the app can sign its
  window in, with a login that lasts only while the app runs.
- Confirmations (Stop, Move to tmux, Remove machine, Log out everywhere and changing the mesh
  provider) use an in-page dialog instead of the browser's confirm box.
- The terminal page pins every script and stylesheet it loads from the CDN with Subresource
  Integrity, so a changed file is refused.

## [0.1.0] - 2026-10-19

First public release.

- Dashboard of every machine with connection state, memory (with Claude's share), CPU load and mesh VPN status.
- Claude Code sessions per machine with folder, branch, ticket, activity and app ports.
- Automatic ssh tunnels for Docker Compose service ports.
- Browser terminal into any tmux session, from desktop or phone.
- New session flow with a folder browser and per-branch git worktrees.
- Add machine flow: mesh peer discovery, ssh key setup, `~/.ssh/config` entry with backup.
- Mesh VPN support for NordVPN Meshnet, Tailscale, Headscale, NetBird and ZeroTier.
- Settings page: switch VPN with address mapping, edit machines, change passcode, log out everywhere, undo.
- `yardbell doctor`, launchd and systemd service install, Docker image for Linux hosts.
