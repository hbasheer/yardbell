# Configuring Yardbell

Yardbell reads one YAML file: `~/.config/yardbell/yardbell.yml`. You can point it elsewhere with
`--config <path>` or the `YARDBELL_CONFIG` environment variable.

Most settings can also be changed on the **Settings** page and machines can be added with
**Add machine**, so you rarely need to edit the file by hand after the first setup. This guide
explains every setting so you know what the UI is doing.

## 1. First setup in five steps

1. **Copy the example.**

   ```sh
   mkdir -p ~/.config/yardbell
   cp yardbell.example.yml ~/.config/yardbell/yardbell.yml
   ```

2. **Describe the machine Yardbell runs on** (the host). Keep exactly one machine with `local: true`
   and set its `mesh_ip` to the host's address on your mesh VPN (how to find it is below). Your
   phone will reach Yardbell at `http://<that address>:<port>`.

3. **Pick your mesh VPN** with `mesh:` (`tailscale`, `nordvpn`, `headscale`, `netbird`, `zerotier`
   or `none`).

4. **Set the passcode.** This also writes the cookie signing key into the file.

   ```sh
   yardbell passcode
   ```

5. **Start and check.**

   ```sh
   yardbell          # opens http://localhost:4000
   yardbell doctor   # checks config, VPN, and every machine
   ```

Add the other machines from **Add machine** in the UI. It finds them on your mesh, sets up ssh, and
writes them into this file for you.

## 2. A complete example

```yaml
port: 4000
poll_seconds: 5
host_terminal: iterm2
mesh: tailscale

ticket_pattern: '^[a-z]+-\d+'
forward_services: [web, api, mailpit]
workspaces: ['*', '*/*']

machines:
  - name: studio            # the Mac you sit at; Yardbell runs here
    local: true
    mesh_ip: 100.101.7.20
    root: ~/code

  - name: devbox            # a Linux box with lots of RAM
    ssh: devbox
    mesh_ip: 100.101.7.31
    port_prefix: 1
    root: ~/code

  - name: laptop
    mesh_ip: 100.101.7.44
    port_prefix: 2
    root: ~/Projects
    workspaces: ['*']       # this machine keeps repos one level deep only
```

## 3. Top-level settings

### `port` (default `4000`)

The port of the web UI on the host. Change it if 4000 is taken. Needs a restart.

### `poll_seconds` (default `5`)

How often Yardbell checks every machine. Lower is snappier, higher is quieter. Applies on the next
check, no restart needed.

### `host_terminal` (default `none`)

What the **Terminal app** button does when you open Yardbell on the host itself:

| Value | Effect |
|---|---|
| `iterm2` | opens a new iTerm2 window attached to the session (macOS) |
| `terminal` | opens Terminal.app (macOS) |
| `none` | hides the button; use **Open** (the browser terminal) instead |

### `mesh` (default `none`)

The mesh VPN your machines share. Yardbell uses it to show VPN status, explain why a machine is
unreachable, list peers in Add machine, and offer **Turn on**. See
[README: Mesh VPN support](../README.md#mesh-vpn-support) for what each provider can do. Change it on
the Settings page, which also updates every machine's address for you.

### `ticket_pattern` (default empty)

A regular expression matched against branch names to show a ticket id. The match is uppercased.
Matching is case-insensitive. Leave it empty to hide tickets.

| Tracker | Branch example | Pattern |
|---|---|---|
| Linear or Jira, any team key | `eng-142-fix-login` | `'^[a-z]+-\d+'` |
| Only specific keys | `ops-31-rotate-certs` | `'^(eng\|ops)-\d+'` |
| GitHub issue number in front | `142-fix-login` | `'^\d+'` |
| Prefix style | `feature/ENG-142-login` | `'[a-z]+-\d+'` (no `^`) |

Always single-quote the pattern in YAML.

### `forward_services` (default empty)

Docker Compose service names whose published ports are tunnelled to the host. Only services listed
here are forwarded. To see your service names, run this in a project folder on that machine:

```sh
docker compose ps --format '{{.Service}}  {{.Ports}}'
```

Pick the ones you open in a browser (web apps, APIs, Mailpit, Storybook). Databases usually do not
need to be forwarded.

### `workspaces` (default empty)

Folder patterns, relative to each machine's `root`, where Yardbell looks for git checkouts. They feed
the folder list, branches, tickets and port detection. A folder only counts if it contains `.git`.

| Your layout | `workspaces` |
|---|---|
| `~/code/api`, `~/code/web` | `['*']` |
| `~/code/acme/api`, `~/code/acme/web` | `['*/*']` |
| both of the above | `['*', '*/*']` |
| one repo plus numbered copies `~/code/app`, `~/code/slots/slot1` | `['app', 'slots/slot*']` |

Sessions running in any other git folder (for example a worktree Yardbell created) are detected
anyway; `workspaces` only decides which folders are listed up front.

### `default_agent` (default `claude`)

The agent preselected in New session until you pick another one; after that, the browser
remembers your last pick. Must be a built-in agent or one listed under `agents`.

### `agents` (optional)

Yardbell knows Claude Code, Codex, Gemini CLI, Qwen Code, opencode, Copilot CLI, Cursor Agent,
Crush, Goose and Aider without any config (see
[README: AI agents](../README.md#ai-agents) for their commands). List agents here to add another
one or to change how a built-in one starts:

```yaml
agents:
  - name: amp                     # lowercase letters, digits and -
    label: Amp                    # optional, shown in the UI
    command: amp                  # run in a new tmux session, through your login shell
    resume: amp threads continue  # used by "Continue the last conversation" and Resume
  - name: codex                   # a built-in name replaces that agent's commands
    command: codex --full-auto
    resume: codex resume --last --full-auto
  - name: my-agent
    command: npx my-agent
    resume: npx my-agent --continue
    process: my-agent             # optional: the process name to look for
    prompt_arg: --task            # optional: how it takes a starting task, "" for an argument
```

`prompt_arg` lets Dispatch and the MCP `start_session` tool start the agent with a task. Empty
(`""`) passes the task as the last argument (`claude 'fix the login bug'`); a flag passes it after
that flag (`gemini -i 'fix the login bug'`). Built-in agents already have it, except Crush, Goose
and Aider, whose interactive modes take no starting task. Without it, starting that agent with a
task fails with a message saying so.

Yardbell finds running sessions by process name: the `process` value, or else the program in
`command` (`goose session` looks for `goose`). Check the name with `pgrep -fl <name>` on that
machine while the agent runs. The agent must be installed on each machine where you use it; Add
machine lists which ones it finds.

### `phone_notifications` (optional)

Which notifications the Yardbell app for Android shows: an agent waiting for you, a session ended,
a machine down or back, or a machine's memory at 95%. The app gets them over its own connection
to the server, so there is nothing to set up. The **Phone notifications** section of the Settings
page edits these switches.

```yaml
phone_notifications:
  wait_minutes: 2           # agent waiting; 0 = right away
  agent_waiting: true
  session_ended: true
  machines: true            # down and back
  memory: true
```

Every key is optional. The values above are the defaults. Older configs may still have `server`,
`topic` and `token` from when notifications went through ntfy; they are ignored.

| Key | Default | Meaning |
|---|---|---|
| `wait_minutes` | `2` | How long an agent must stay waiting before the phone is told. If you answer it sooner, nothing is sent. `0` sends right away. From 0 to 60. |
| `agent_waiting` | `true` | Notify when an agent is waiting for you. |
| `session_ended` | `true` | Notify when a session ends. |
| `machines` | `true` | Notify when a machine has been down for a minute and when it comes back. |
| `memory` | `true` | Notify when a machine's memory reaches 95%. |

### `mcp_servers` (optional)

Other MCP servers that Claude Code sessions started by Yardbell get, through `--mcp-config`.
Nothing is written on the machines. The **MCP servers for sessions** section of the Settings page
edits this list.

```yaml
mcp_servers:
  - name: github                                       # letters, digits, - and _
    command: npx -y @modelcontextprotocol/server-github  # runs on the machine; split on spaces
    env: {GITHUB_PERSONAL_ACCESS_TOKEN: ghp_...}
  - name: linear
    url: https://mcp.linear.app/mcp                    # or an HTTP server
    headers: {Authorization: Bearer lin_...}
    machines: [mini]                                   # optional; empty means every machine
```

Each server needs either `command` or `url`. The values, tokens included, are on the agent's
command line, so other users of that machine can see them in its process list while the session
runs.

### `dispatch` (optional)

How the Dispatch page works. The **Dispatch** section of the Settings page edits it.

```yaml
dispatch:
  instructions: |                 # added to Dispatch's prompt, followed before its defaults
    acme/web work goes to devbox unless it is down.
    Branch names look like eng-1234-short-name.
  agent: codex                    # agent it starts in new sessions; empty uses default_agent
  model: haiku                    # sonnet, opus or haiku; empty uses Claude Code's default
```

`instructions` is at most 4000 characters. Dispatch itself always runs Claude Code on the host;
`agent` only chooses what it starts on the machines.

### `listen_ip` (optional)

The address Yardbell listens on besides `127.0.0.1`. By default it uses the `mesh_ip` of the
`local: true` machine. Set it in Docker mode, where there is no local machine. Needs a restart.

## 4. Machine settings

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Short name shown everywhere. Lowercase letters, digits and `-`. Used in tmux session names. |
| `local` | host only | `true` for the machine Yardbell runs on. At most one. Not used in Docker mode. |
| `ssh` | no | The ssh host to connect to, usually a `Host` alias from `~/.ssh/config`. Defaults to `name`. |
| `mesh_ip` | recommended | The machine's address on the mesh VPN. Used for the reachability check and, for the host, for listening. |
| `port_prefix` | remote machines | A digit from 1 to 6, unique per machine. Port `3000` on that machine opens on the host as `prefix * 10000 + 3000`, so prefix 1 gives `13000`. |
| `root` | yes | The project folder on that machine. `~` is allowed. |
| `workspaces` | no | Overrides the top-level `workspaces` for this machine. |
| `mesh` | no | Overrides the top-level `mesh` for this machine. |
| `recent` | written by Yardbell | Folders you recently started sessions in. |

### Finding a machine's mesh address

| VPN | Command on that machine | Or |
|---|---|---|
| Tailscale, Headscale | `tailscale ip -4` | the Tailscale admin console |
| NordVPN Meshnet (Linux) | `nordvpn meshnet peer list` (look under "This device") | the Meshnet tab in the app |
| NordVPN Meshnet (macOS, Windows) | none, the app has no CLI | the Meshnet tab in the app |
| NetBird | `netbird status` (NetBird IP) | the NetBird dashboard |
| ZeroTier | `zerotier-cli listnetworks` | ZeroTier Central |
| none | `ip -4 addr` (Linux) or `ipconfig getifaddr en0` (macOS) | your router |

### How ssh is used

Yardbell runs the system `ssh`, so everything in your `~/.ssh/config` applies: users, keys, ports,
jump hosts. Each machine needs key-based login from the host without a password prompt. Add machine
sets this up and appends an entry like this (after backing up the file):

```
Host devbox
  HostName 100.101.7.31
  User alex
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

If you write entries yourself, test them from the host with `ssh -o BatchMode=yes devbox true`.

## 5. Values Yardbell writes itself

| Key | Written by | Notes |
|---|---|---|
| `passcode_hash` | `yardbell passcode`, Settings | argon2id hash, never the passcode itself |
| `cookie_key` | `yardbell passcode`, Settings, "Log out everywhere" | signs login cookies; changing it signs everyone out |
| `machines[].recent` | New session | the last 8 folders per machine |
| `phone_notifications.topic` | Settings, "Set up" | a generated name, `yardbell-` and 24 random letters and digits |
| `mcp_token` | Settings, "Agent tools (MCP)" | `yb_` and 40 random letters and digits; absent means the MCP server is off |

Keep `yardbell.yml` private (`chmod 600`): the cookie key can forge a login, the MCP token can
start sessions, and the notification topic and token are secrets too.

## 6. What applies when

| Change | Takes effect |
|---|---|
| machines, `mesh`, `agents`, `default_agent`, `ticket_pattern`, `forward_services`, `workspaces`, `poll_seconds`, `phone_notifications` | on the next check, a few seconds |
| passcode, "Log out everywhere" (from Settings) | immediately |
| `port`, `listen_ip`, the host machine's `mesh_ip` | after restarting Yardbell |

Settings that need a restart are flagged on the Settings page, which also offers a **Restart Yardbell**
button when Yardbell runs as a service (`yardbell install-agent`).

## 7. Validation errors

Yardbell refuses to start or save an invalid file and says why:

| Message | Fix |
|---|---|
| `machine name "Hp!" must match [a-z0-9-]+` | use lowercase letters, digits and `-` |
| `machine name "hp" is used twice` | names must be unique |
| `machine "hp" needs a port_prefix from 1 to 6` | add `port_prefix` to every remote machine |
| `port_prefix 2 is used twice` | give each remote machine its own prefix |
| `only one machine can be local: true` | keep `local: true` on the host only |
| `ticket_pattern does not compile` | check the regex and the YAML quoting |
| `agent "x" needs a command and a resume` | give every entry under `agents` both commands |
| `agent "x" process "a b" must be a plain program name` | set `process` to the program name only |
| `default_agent "x" is not a known agent` | use a built-in name or add the agent under `agents` |
| `phone_notifications.topic may only use letters, digits, - and _ (at most 64)` | rename the topic, or leave it empty to turn notifications off |
| `phone_notifications.wait_minutes must be from 0 to 60` | use a whole number of minutes from 0 to 60 |
| `phone_notifications.token must be at most 200 characters without spaces` | paste the token again, with no spaces or line breaks |
| `cannot read ...yardbell.yml` | the file is missing; Yardbell prints an example to start from |

## 8. Common setups

**One Mac running Yardbell, one Linux box, Tailscale.** Use the example in section 2 without the
laptop. Install Yardbell on the Mac with `yardbell install-agent` so it starts at login, and keep the Mac
awake (`sudo pmset -a sleep 0`); `yardbell doctor` checks both.

**Linux host in Docker.** Remove `local: true`, add the host as a normal machine (with sshd running
and its own `port_prefix`), set `listen_ip` to its mesh address, and use
`docker-compose.example.yml`.

**No mesh VPN, all machines on one LAN.** Set `mesh: none` and use LAN addresses as `mesh_ip`. Do
not expose Yardbell beyond a network you trust.

**Several repos per machine with different layouts.** Keep a broad top-level `workspaces` and override
it per machine where the layout differs.
