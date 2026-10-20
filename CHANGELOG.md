# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com)
and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

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
