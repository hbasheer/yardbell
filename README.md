# Yardbell

**One page for every AI coding agent session across all your machines.**

Yardbell runs on one machine and watches the others over ssh. It shows which machines are up and how
much memory and disk they have left, which agent session (Claude Code, Codex, Gemini CLI, opencode,
Aider and more) runs where and for which ticket, and which local port opens the app each session is
working on. It opens a full terminal into any session from your desktop or your phone, and puts
several side by side in a Workspace. Nothing is installed on the machines it manages: it is one
Rust binary with a plain HTML UI, plus apps for macOS, Linux and Android.

![Yardbell dashboard](docs/screenshots/dashboard.png)

## Features

- **Machine health first.** Connection state with the reason when something fails, memory drawn to
  scale with the agents' share, CPU load, disk use and mesh VPN status.
- **Every agent session.** Ten agents out of the box and any CLI agent you add. Folder, ticket,
  branch, and whether the agent is working, idle or waiting for you, read from its own screen.
- **A terminal anywhere.** Any tmux session in the browser, the desktop app or the phone, with
  scrollback, a key row on phones, and the screen you use setting the session's size.
- **Workspace.** Every terminal in one sidebar by machine and folder, with tabs and split panes.
- **New sessions where you want them.** Pick a machine, one of its installed agents, a folder and a
  branch; other branches get their own git worktree.
- **Ports, already tunnelled.** Docker Compose ports from each session's folder, forwarded to the
  host with live status.
- **Phone notifications.** The Android app says when an agent waits for you, a session ends, a
  machine goes down or memory runs low, with no other app to install.
- **Dispatch.** Describe a task and Yardbell picks the machine with the repository and the most room,
  then starts an agent there.
- **Add machines from the UI.** Mesh peers, ssh key setup, `~/.ssh/config`, tool checks and a folder
  picker, without editing a file.
- **Mesh VPN aware.** NordVPN Meshnet, Tailscale, Headscale, NetBird and ZeroTier, and the apps
  find the servers on it so signing in takes only the passcode.
- **An MCP server for agents.** Agents can list machines and sessions, start, read and answer them.
- **Light or dark, and small to run.** A theme button in every sidebar; about 9 MB of memory, a
  service in one command and a `doctor` that checks everything.

![Workspace with two terminals side by side](docs/screenshots/workspace.png)

## Download

Get the file for your system from the
[latest release](https://github.com/hbasheer/yardbell/releases/latest):

| System | File |
|---|---|
| macOS, Apple silicon and Intel | `Yardbell_<version>_universal.dmg` |
| Linux | `Yardbell_<version>_amd64.AppImage` |
| Debian and Ubuntu | `Yardbell_<version>_amd64.deb` |
| Fedora and openSUSE | `Yardbell-<version>-1.x86_64.rpm` |
| Android 7 and later | `Yardbell_<version>_android.apk` |

The desktop app can run the Yardbell server itself (**Run one on this machine**) or connect to one
that is already running. The Android app pairs by scanning a code from **Settings → Connect a phone**.
On an iPhone, open the dashboard in the browser. Install steps for each system are in
[the apps](docs/apps.md).

## Quick start

```sh
git clone https://github.com/hbasheer/yardbell && cd yardbell
cargo build --release
install -m 755 target/release/yardbell ~/.local/bin/yardbell

mkdir -p ~/.config/yardbell
cp yardbell.example.yml ~/.config/yardbell/yardbell.yml
$EDITOR ~/.config/yardbell/yardbell.yml     # describe the host as the `local: true` machine

yardbell passcode                        # set the login passcode
yardbell                                 # start, then open http://localhost:4000
yardbell doctor                          # check config, VPN, every machine
yardbell install-agent                   # optional: start at login
```

Then add the other machines from **Add machine** in the UI, or list them in `yardbell.yml`. The
[configuration guide](docs/configuration.md) explains every setting.

## Documentation

- [The apps](docs/apps.md): the desktop app, the Android app and phone notifications.
- [Using Yardbell](docs/usage.md): dashboard, new sessions, Workspace, the terminal, adding
  machines, Settings and Dispatch.
- [AI agents and MCP](docs/agents.md): the agents Yardbell knows, adding your own, and its MCP
  server.
- [Running Yardbell](docs/running.md): how it works, requirements, mesh VPNs, ports, commands,
  Docker and security.
- [Configuration](docs/configuration.md): every setting in `yardbell.yml`.
- [Troubleshooting](docs/troubleshooting.md) and [Development](docs/development.md).

## License

[MIT](LICENSE)
