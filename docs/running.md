# Running Yardbell

How Yardbell works, what it needs, and how to run it as a service, with its ports, commands and security.

## How it works

```
                 your phone / tablet / laptop (browser or desktop app, on the mesh VPN)
                                         │
                                         ▼
┌──────────────── host (runs yardbell) ───────────────────────────┐
│  web UI :4000  ·  poller  ·  ssh tunnels  ·  pty for terminals  │
└───────┬──────────────────────────┬──────────────────────────────┘
        │ ssh (one shared           │ ssh -L (one tunnel per
        │ connection per machine)   │ machine for app ports)
        ▼                           ▼
   devbox, laptop, ...  tmux sessions running agents, git checkouts, docker compose
```

Every few seconds Yardbell pipes a small read-only shell script (`src/snapshot.sh`) over ssh to each
machine. It reports agent processes and their folders, tmux sessions, git branches, Docker Compose
ports, memory, load and mesh addresses as JSON. Everything Yardbell changes on another machine is
limited to `tmux new`, `tmux kill-session` and `git worktree add`.

## Requirements

- **Host** (where Yardbell runs): macOS or Linux, Rust stable to build, `ssh`.
- **Managed machines:** `sshd`, `tmux`, `git`, at least one AI coding agent, and optionally Docker Compose for port
  forwarding. Any bash works, including the macOS default bash 3.2.
- **Network:** every machine reachable over ssh from the host, usually through a mesh VPN. Only port
  22 needs to be open on managed machines.

## Mesh VPN support

Set `mesh` in `yardbell.yml` or on the Settings page. A machine can override it with its own `mesh:`.

| Provider | Status | Peers for Add machine | Turn on |
|---|---|---|---|
| `nordvpn` (Linux CLI) | `nordvpn settings` | `nordvpn meshnet peer list` | `nordvpn set meshnet on` |
| `nordvpn` (macOS app) | mesh address on an interface | type the IP from the app | open the app |
| `tailscale`, `headscale` | `tailscale status --json` | same | `tailscale up` |
| `netbird` | `netbird status --json` | same | `netbird up` |
| `zerotier` | `zerotier-cli info` | type the IP from ZeroTier Central | `zerotier-cli join` yourself |
| `none` | mesh address on an interface | type the IP | |

Turn on only works on the host: a remote machine whose VPN is off cannot be reached to fix it.

## Ports

A session's app port on a remote machine opens on the host at `port_prefix * 10000 + port`. With
`port_prefix: 1`, port `3001` on that machine is `localhost:13001` on the host, or
`<host-mesh-ip>:13001` from a phone. Ports of 10000 and above are not forwarded. Which Docker
Compose services are forwarded is set by `forward_services`.

Ports of apps running on the host itself are not tunnelled. They open at their own port, for
example `<host-mesh-ip>:3100` from a phone. On a Linux host with a firewall, other devices can
only reach them if the firewall lets mesh traffic through to Docker (see
[Troubleshooting](troubleshooting.md#troubleshooting)).

## Configuration

`~/.config/yardbell/yardbell.yml` (or `--config <path>`, or `YARDBELL_CONFIG`). **Start with the
step-by-step guide: [docs/configuration.md](configuration.md)**. It covers first setup, how to
find each value (mesh addresses, Docker service names, ticket patterns), what applies without a
restart, validation errors and common setups. A commented example is
[yardbell.example.yml](../yardbell.example.yml).

Quick reference:

| Key | Meaning |
|---|---|
| `port` | Web UI port on the host (default 4000) |
| `poll_seconds` | How often every machine is checked (default 5) |
| `host_terminal` | `iterm2`, `terminal` or `none`: the "Terminal app" button on a macOS host |
| `mesh` | Mesh VPN provider, see above |
| `ticket_pattern` | Regex that finds a ticket id in branch names; empty disables tickets |
| `forward_services` | Docker Compose service names whose ports are tunnelled |
| `workspaces` | Folder globs under each machine's root that hold git checkouts |
| `default_agent` | Agent preselected in New session (default `claude`) |
| `agents` | Extra agents, or changed commands for built-in ones, see [AI agents](agents.md#ai-agents) |
| `phone_notifications` | Which notifications the Android app shows, see [Phone notifications](apps.md#phone-notifications); keys in the [configuration guide](configuration.md#phone_notifications-optional) |
| `listen_ip` | Address to listen on besides 127.0.0.1; defaults to the local machine's `mesh_ip` |
| `machines[].name` | Short name, `[a-z0-9-]+` |
| `machines[].local` | `true` for the machine Yardbell runs on (native mode only) |
| `machines[].ssh` | ssh host alias (defaults to the name) |
| `machines[].mesh_ip` | Address on the mesh VPN |
| `machines[].port_prefix` | 1 to 6, unique; required for remote machines |
| `machines[].root` | Project folder on that machine |
| `machines[].workspaces`, `machines[].mesh` | Per-machine overrides |

`passcode_hash`, `cookie_key` and `recent` folders are written by Yardbell itself.

## Commands

```
yardbell [serve] [--no-open]   start the web UI (the default)
yardbell passcode              set or change the login passcode
yardbell doctor                check config, passcode, mesh VPN, every machine, sleep and firewall
yardbell install-agent         start at login (launchd on macOS, systemd user unit on Linux)
yardbell uninstall-agent       remove that service
yardbell --version
```

## Docker (Linux hosts)

```sh
UID=$(id -u) GID=$(id -g) docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml run --rm yardbell passcode
```

The container runs as your user so ssh accepts the mounted `~/.ssh`, and uses host networking so
tunnels and the mesh address work. Inside Docker, Yardbell cannot see the host's own processes: leave
out `local: true`, add the host like any other machine (it needs sshd), and set `listen_ip` to the
host's mesh address. Docker on macOS is unverified, see
[docker-on-macos.md](docker-on-macos.md); use the native binary on macOS.

## Security

Anyone who logs in to Yardbell gets a full shell on every machine it manages. Treat the passcode like an
ssh key.

- Yardbell listens only on `127.0.0.1` and the host's mesh address, never on all interfaces.
- Every page, API call and terminal websocket requires the login cookie (signed, `HttpOnly`,
  `SameSite=Strict`, 30 days). Five wrong passcodes in a minute lock that address out for five
  minutes.
- Requests that change anything must come from Yardbell's own page (Origin check). The one
  exception is `/mcp`, which takes a bearer token instead of the cookie and still turns away any
  request whose Origin is another site.
- The MCP token can start and type into sessions on every machine, like a login. It is off until
  you turn it on in Settings, and making a new one stops the old one at once. Dispatch uses its own
  token, made fresh each time Yardbell starts and never written to disk.
- The desktop app signs its window in with a one-time code. Making a code needs a login, and the code
  works once, within 30 seconds. The window's login ends when the app quits; the app keeps its own
  login in the system keychain.
- Input that reaches a shell, ssh or `~/.ssh/config` (hostnames, usernames, branch names) is
  validated first, and every value passed to a shell is quoted.
- Do not put Yardbell on the public internet.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.
