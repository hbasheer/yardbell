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

How often Yardbell checks every machine. Open pages show each check as soon as it finishes, and a
machine is checked again right after you start, stop or answer a session there, so this sets how
soon a change made elsewhere shows. Lower is snappier, higher is quieter. Applies on the next
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
[Mesh VPN support](running.md#mesh-vpn-support) for what each provider can do. Change it on
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
[AI agents](agents.md#ai-agents) for their commands). List agents here to add another
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
  pipeline_waiting: true
  pipeline_finished: true
  proposals: true
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
| `pipeline_waiting` | `true` | Notify when a pipeline run waits for you. |
| `pipeline_finished` | `true` | Notify with the first line of a pipeline run's report. |
| `proposals` | `true` | Notify when a proposal waits in the Proposals inbox. |

### `connectors` (optional)

Outside tools pipelines can take work from and call. **Settings, Connections** edits them, and
[Connectors](automation.md#connectors) explains each key with examples.

```yaml
connectors:
  - id: tracker                       # used in pipelines
    name: Tracker
    enabled: true                     # default true
    base_url: https://api.example.com/1  # https, or http with allow_private
    allow_private: false              # may reach private and mesh addresses
    headers:
      Authorization: 'Bearer ${secret:tracker}'  # a login header must use a secret
    params:
      - { name: board, label: Board, options: boards }  # a choice in the builder
    calls:
      list:
        request: { method: GET, path: /items, query: { open: 'true' } }
        map: { item_id: id, title: name, state: status }
        page: { style: number, param: page, size: 50, max_pages: 20 }
```

Plain header values are allowed only for `accept`, `content-type`, `user-agent` and names ending
`-version`. Paths must start with `/`. A call may have at most 3 `before` requests, and `max_pages` runs
from 1 to 100.

A connector may go through a server under `mcp_servers` instead of an address. It then has `server`
in place of `base_url` and no `headers`, and each call has `tool` and `arguments` in place of
`request`. Mark a call that only reads with `kind: lookup`. A call with no `kind` counts as a change.
`items: lists[].cards` reads rows grouped under a parent, and `_parent.id` in a `map` reads from that
parent.

```yaml
connectors:
  - id: cards
    server: tracker
    calls:
      list:
        tool: readCards
        kind: lookup
        arguments: { board: '{{board}}' }
        items: lists[].cards
        map: { item_id: id, title: name, state: _parent.id }
```

### `mcp_servers` (optional)

Other MCP servers that Claude Code sessions started by Yardbell get, through `--mcp-config`. The
**Connections** section of the Settings page edits this list.

```yaml
mcp_servers:
  - name: github                                       # letters, digits, - and _
    # allow_private: true    only for your own server: lets sign-in and calls reach a private address
    command: npx -y @modelcontextprotocol/server-github  # runs on the machine; split on spaces
    env: {GITHUB_PERSONAL_ACCESS_TOKEN: '${secret:github}'}
  - name: linear
    url: https://mcp.linear.app/mcp                    # or an HTTP server
    headers: {Authorization: 'Bearer ${secret:linear}'}
    machines: [mini]                                   # optional; empty means every machine
```

Each server needs either `command` or `url`. Keep tokens out of `yardbell.yml`: store them as
[secrets](#secrets) and write `${secret:NAME}` where they go, in a header, an `env` value or the
URL. Quote such a value in YAML, since it contains `{` and `}`. Plain values still work.

The values often hold tokens, so they never go on a
command line, where every account on the machine could read them with `ps`. When a Claude Code
session starts, Yardbell sends the machine's servers over ssh's standard input into
`~/.cache/yardbell/mcp/mcp-<hash>.json` on that machine (`$XDG_CACHE_HOME` if it is set), a file
only your account can read in a folder only your account can open, and passes Claude Code that
file's path. Every start and resume writes it again, sessions with the same servers share one file,
and files left by an older list are removed after 30 days.

### Secrets

Named secrets live in `secrets.yml`, in the same folder as `yardbell.yml`
(`~/.config/yardbell/secrets.yml` by default). Yardbell saves it readable only by your account
(mode 600) and makes that folder private (mode 700). The **Secrets** list under **Connections** in
Settings adds, replaces and deletes them. A value is write-only there: once saved it is never
shown again, only its name, the date it was set and the servers that use it.

```yaml
# secrets.yml, written by Yardbell
linear:
  value: lin_api_...
  updated: 2026-10-28T09:30:00Z
github: ghp_...          # a value written by hand needs no date
```

`yardbell.yml` refers to a secret as `${secret:NAME}`, where `NAME` is letters, digits, `-` and
`_`, at most 64 of them. Anything around the reference stays as written, so
`Bearer ${secret:linear}` becomes `Bearer lin_api_...`. References work in the `url`, `headers`
and `env` of an MCP server, and Yardbell uses them for its own `mcp_token` and `cookie_key`. There
is no escape: `${secret:` always starts a reference, and one that is not closed with `}` or has a
bad name stops `yardbell.yml` from loading, with a message that says where.

A reference is filled in only when the value is used: while Yardbell writes a session's MCP config
on its machine, or Dispatch's on the host, and when it checks the MCP token or the login cookie.
The filled-in value never goes back into `yardbell.yml`, the logs, `/state`, the Settings page or
an error message. A session whose servers need a secret that is not set does not start, and the
message names the server and the secret.

**Moving values out of `yardbell.yml`.** When `yardbell.yml` still holds header or `env` values,
the MCP token or the cookie key itself, the Secrets list shows them and offers **Move to
secrets**. Values whose names look secret (`Authorization`, `GITHUB_TOKEN`, `API_KEY` and the like)
start ticked. Nothing moves until you press the button, so a value such as `GITHUB_HOST` is never
moved unless you tick it. Each value goes to a secret named after its server (or the server and
the variable, when one server has several) and an `Authorization` header keeps its scheme, so
`Bearer lin_api_...` becomes `Bearer ${secret:linear}`. Yardbell writes `secrets.yml` first,
reads every moved value back, and only then rewrites `yardbell.yml`, so if any step fails, each
value is still in one file or the other. The move cannot be undone with **Undo**, which would put
the values back, and older `yardbell.yml.bak-` copies still hold them, so delete those once the
move is done.

### `dispatch` (optional)

How the Dispatch page works. The **Dispatch** section of the Settings page edits it. For when to
use instructions, memory or rules, and example rule sets, see
[Dispatch rules, instructions and memory](automation.md#dispatch-rules-instructions-and-memory).

```yaml
dispatch:
  instructions: |                 # added to Dispatch's prompt, followed before its defaults
    acme/web work goes to devbox unless it is down.
    Branch names look like eng-1234-short-name.
  agent: codex                    # agent it starts in new sessions; empty uses default_agent
  runs_on: codex                  # claude (the default) or codex: what Dispatch itself runs on
  model: haiku                    # sonnet, opus or haiku; empty uses Claude Code's default
  codex_model: gpt-6.1-sol        # the Codex model when runs_on is codex; empty uses Codex's default
  approval: prompt                # prompt (the default), allow or deny
  rules:                          # optional, see below
    - action: stop_session
      approval: deny
    - action: start_session
      machine: devbox
      folder: acme/*
      approval: allow
    - action: remember            # changes to Dispatch's memory
      approval: allow
```

`instructions` is at most 4000 characters. `runs_on` chooses the agent Dispatch itself runs on the
host, `claude` or `codex`; `agent` only chooses what it starts on the machines. `model` stays the
Claude Code model whichever `runs_on` says, so switching never leaves an invalid model behind.
`codex_model` is any Codex model name, up to 64 letters, digits, dots, dashes and underscores, and
Settings suggests the ones in Codex's own list and says when the name is not in it. A change to
`runs_on` only applies to new conversations, since a conversation stays on the agent it started on.
A change to either model applies from the next message, in open conversations too. With
`runs_on` and `codex_model` at their defaults neither is written to `yardbell.yml`, so 0.7.5 still
reads it.

`approval` decides what happens when Dispatch starts, stops, types into or reviews a session:
`prompt` makes it a step that waits for you to approve, edit or reject it, `allow` runs it at once
(it still shows up as a card), and `deny` refuses it. `prompt` and `allow` are the names to use.
`ask` and `auto`, the names earlier versions used, mean the same, and Yardbell writes `approval`
with them when it saves, so a config stays readable by Yardbell 0.7.0. Rules use `allow`, `prompt`
and `deny`.

`rules` decide some steps differently from `approval`. Each rule has:

| Key | Required | Meaning |
|---|---|---|
| `action` | no | `start_session`, `stop_session`, `send_to_session`, `review_session`, `scan_folder`, `remove_worktree`, `integrate_branches`, `push_branch`, `move_session`, `remember`, or `any` (the default). |
| `machine` | no | A machine name, or `any` (the default). |
| `folder` | no | A folder pattern. Empty matches every folder. |
| `approval` | yes | `allow`, `prompt` or `deny`. |

A folder pattern is a folder's name as the folder list shows it, relative to the machine's `root`
(like `acme/web`), or an absolute path (like `/srv/apps/**`), and it covers the folders inside it.
`*` matches any part of one folder name, `**` matches across folders and `?` matches one character.
For a new session the folder is the one it starts in, for a review the folder of the session it
reviews, for stopping, typing into or moving a session that session's folder, and for removing a
worktree, integrating or pushing the folder or path the step names.

Which rule decides:

1. A matching rule with `deny` always wins.
2. Otherwise the matching rule that names the most of `action`, `machine` and `folder` wins. Between
   two that name as many, the one with the longer folder pattern wins, and if they still tie,
   `prompt` beats `allow`. The order of the list never matters.
3. When no rule matches, `approval` decides.

`remember` steps, Dispatch's changes to its memory, are decided apart from the others. Only a rule
with `action: remember` decides them, so an `any` rule never does, and a `remember` rule leaves
`machine` and `folder` out, since the memory is on no machine or folder. Without such a rule a
change always waits for you, even with `approval: allow`, and `approval: deny` refuses it. The
memory itself is not in `yardbell.yml`: it is `dispatch/memory.md` in the state folder, with its
history next to it in `dispatch/memory-history.json`, both readable only by your account, see
[Memory](usage.md#memory).

When Yardbell cannot tell which folder a session is in, for example a session it does not see, a
rule with a `folder` only matches it if that rule denies. A refused step never becomes a card:
Dispatch gets an error that names the rule and tells you about it. A step that a rule made wait or
run says which rule on its card. Yardbell refuses to load rules with an unknown action or machine,
a folder starting with `~`, a rule that names nothing (set `approval` instead) or two rules for the
same steps, and says which rule is wrong.

### `worktree_setup` (optional)

Commands that run in a new worktree right after Yardbell creates it, before the agent starts. The
**Worktree setup** section of the Settings page edits it. For when it runs and more examples, see
[Worktree setup](automation.md#worktree-setup).

```yaml
worktree_setup:
  - folder: acme/web               # the repository's main checkout: a label or a path, * allowed
    command: npm ci && cp "$YARDBELL_MAIN_CHECKOUT/.env" .
  - folder: acme/api
    machine: devbox                # optional, default any
    command: bin/setup
    timeout_seconds: 900           # optional, default 300, at most 3600
  - folder: acme/shop
    command: docker compose up -d
    teardown: docker compose down  # optional: when a pipeline run that made the worktree ends
```

An entry needs a `command`, a `teardown` or both. See [Teardown](automation.md#teardown) for where it
runs and where it is skipped.

`folder` is matched like a Dispatch rule's folder, against the main checkout the worktree was made
from. When several entries match, the one that names the machine wins, then the one with the
longer folder pattern. The command runs in the new worktree through your login shell on that
machine, with `$YARDBELL_WORKTREE` and `$YARDBELL_MAIN_CHECKOUT` set. Its output goes to
`yardbell-setup.log` in the worktree's git folder. A command that fails or passes its timeout is
stopped with every process it started, and the agent starts anyway with a note about it; the
session shows the output. Yardbell refuses to load an entry without a folder or command, with a
folder starting with `~`, an unknown machine, a timeout outside 1 to 3600 seconds, or two entries
for the same folder and machine.

Only commands written here run. Yardbell does not look for a setup script in the repository on its
own, because such a script comes from whatever branch the worktree is on, which can be a branch
someone else pushed or an agent wrote, and it would run before anyone looked at it. To use a script
the repository keeps, name it here, like `command: .yardbell/setup`, which says you trust that
repository's branches.

### `pull_requests` (optional)

For each branch a session works on, Yardbell shows its pull request or merge request and its CI on
the dashboard and in the Workspace sidebar, and posts a card in Dispatch when CI starts failing or
a reviewer comments. GitHub is read through `gh`, GitLab through its API.

For GitHub, Yardbell asks the GitHub CLI `gh` on the machine where the session runs, over the same
ssh connection, from that session's folder. Nothing is installed: a machine without `gh`, or with
`gh` not logged in, shows no badge and is asked again after 10 minutes. A branch with no pull
request shows none.

For GitLab, list each GitLab host under `gitlab`, with a personal access token saved as a
[secret](#secrets). Yardbell reads the remote each branch pushes to (its upstream remote, or
`origin`) once every 10 minutes, and asks the API of a listed host from the machine Yardbell runs
on, so only that machine needs to reach GitLab. Any other host goes to `gh` as above, so GitHub
Enterprise keeps working, and a GitLab host that is not listed shows no badge.

```yaml
# github_via: gh or token. token needs github_token, naming a saved secret.
# gitlab_via: token or glab. glab needs no token on its hosts.
pull_requests:
  enabled: true        # false: no badges, no cards, gh and GitLab are never asked
  poll_seconds: 120    # how often each branch is asked, at least 30
  cards: true          # false: badges only, no cards in Dispatch
  use_github: true     # false: gh is never asked for badges and cards
  use_gitlab: true     # false: GitLab hosts are kept but never asked for badges and cards
  gitlab:              # optional
    - host: git.example.com               # the host as the remote URL names it
      token: '${secret:gitlab}'           # a personal access token with read_api
    - host: gitlab.example.org
      url: https://gitlab.example.org:8443  # optional; default https://<host>
      token: '${secret:gitlab-example}'
```

Every key is optional. The values above, without `gitlab`, are the defaults. A branch is asked at
most once every `poll_seconds`, separately from the machine check every `poll_seconds` at the top
level, and the branches of one machine are asked one after another. What has already been posted
is kept in `pulls.json` in the state folder, so a restart never posts a card twice.

A GitLab token needs only the `read_api` scope: Yardbell never writes to GitLab. Make one in GitLab
from your avatar, **Edit profile**, **Access tokens**, and save it under **Secrets** in Settings.
`url` is for an instance whose web address differs from the host in your remote, such as another
port. The token is sent only to that address, in a header, and never goes over ssh, into
`pulls.json` or a log. When GitLab refuses the token, or its secret is missing, that host is asked
again after 10 minutes and Yardbell's log says why; a project the token may not read leaves only
that branch without a badge. `yardbell doctor` signs in to each host and names the account or the
problem. When a pipeline fails without a failed job of its own, for example through a downstream
pipeline, the card names the failed bridge job or the pipeline. A merge request shows as `!12`, its pipeline as CI, and a
reviewer asking for changes or approving as on GitHub. A request for changes without a comment
changes the badge but posts no card, and only the newest 500 comments of
one merge request are watched.

### `pipelines` (optional)

Settings for [pipelines](automation.md#pipelines). The pipelines themselves are made and changed
on the Pipelines page and kept in the state folder, not here. The page's **Settings** button writes
this section.

```yaml
pipelines:
  per_machine: 2      # agent steps at once on each machine, 1 to 6
  minutes: 120        # an agent step running longer waits for you, 10 to 1440; a step can set its own
  qa_notes:           # optional: added to every agent step working in that folder
    acme/web: |
      Run specs with: docker compose exec web bin/rspec <files>
```

### `triggers` (optional)

Start a saved Dispatch task on a schedule, or when a Linear or GitHub ticket comes your way. The
**Triggers** section of the Settings page edits the list. See [Triggers](usage.md#triggers), and
[Triggers](automation.md#triggers) for examples.

```yaml
triggers:
  - name: Morning summary         # shown in Settings and on the conversation, unique
    task: What's going on?        # the name of a task in Dispatch
    schedule: weekdays 08:30
  - name: Every few hours
    task: Who needs me?
    schedule: every 4h
    enabled: false                # off; on is the default
  - name: Linear tickets
    task: Start a ticket
    linear:
      assigned: true              # a ticket is assigned to you
      states: [In Progress]       # or one of your tickets moves into one of these states
  - name: Reviews
    task: Review a pull request
    github:
      assigned: true              # an issue is assigned to you
      review_requested: true      # a pull request asks for your review
```

Each trigger has a `name`, a `task` and exactly one of `schedule`, `linear` or `github`.

A pipeline has a trigger of its own, set on the Pipelines page; see
[Pipelines](automation.md#pipelines).

`schedule` is one of:

| Form | Runs |
|---|---|
| `daily 09:00` | every day at 09:00 |
| `weekdays 08:30` | Monday to Friday at 08:30 |
| `every 4h` | every 4 hours from midnight: 00:00, 04:00, 08:00 and so on (1 to 23) |
| `cron 30 9 * * 1-5` | a five-field cron expression: minute, hour, day of the month, month, day of the week |

Cron fields take numbers, `*`, ranges (`1-5`), lists (`1,15`) and steps (`*/15`, `10-50/20`). Day
of the week runs from 0 to 7, where 0 and 7 are Sunday. Names like `MON` are not read. When both
the day of the month and the day of the week name days, either one is enough, as in cron. A
schedule that can never run, like `cron 0 0 31 2 *`, is refused.

Times are in the local time zone of the machine Yardbell runs on. A time that the clocks skip
(spring forward) runs when they jump, and a time they repeat (fall back) runs the first time only.

**Catch-up:** when Yardbell was not running at one or more scheduled times, the trigger runs once
as soon as it is back, however many times it missed. A new trigger, a changed schedule, or a
trigger turned back on counts from that moment and does not catch up.

**No stacking:** while a trigger's last conversation is still working, its scheduled time is
skipped (and not run later), and new tickets wait for the next check.

`linear` reads the open tickets assigned to you through Linear's GraphQL API, every 3 minutes, with
the API key in the secret named `linear` (see [Secrets](#secrets); make a personal API key under
Linear's Settings, Security & access). It needs `assigned: true`, a list of `states`, or both.
State names are matched without regard to case.

`github` runs `gh search issues --assignee=@me` and `gh search prs --review-requested=@me` with the
GitHub CLI on the machine Yardbell runs on, every 3 minutes, as the account `gh` is logged in with.
It needs `assigned`, `review_requested`, or both.

A ticket trigger starts one conversation per ticket and event: a ticket assigned to you once, and
again only when it moves into a state you named. The tickets that already match when a trigger
starts watching are left alone. What each trigger has seen and done is kept in `triggers.json` in
the state folder, so a restart never starts the same ticket twice. When a check fails, it is tried
again after 10 minutes, and the trigger's row in Settings says why.

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
| `cookie_key` | `yardbell passcode`, Settings, "Log out everywhere" | signs login cookies; changing it signs everyone out. Written as `${secret:yardbell-cookie-key}`, with the key in `secrets.yml` |
| `machines[].recent` | New session | the last 8 folders per machine |
| `phone_notifications.topic` | Settings, "Set up" | a generated name, `yardbell-` and 24 random letters and digits |
| `mcp_token` | Settings, "Agent tools (MCP)" | `yb_` and 40 random letters and digits; absent means the MCP server is off. Written as `${secret:yardbell-mcp-token}`, with the token in `secrets.yml` |

The secrets themselves go in `secrets.yml`, see [Secrets](#secrets). Keep both files private: the
cookie key can forge a login, the MCP token can start sessions, and an older `yardbell.yml` may
still hold the notification topic and token or MCP server tokens. Yardbell saves `yardbell.yml`,
its `.bak-` copies and `secrets.yml` readable only by your account (mode 600). A file you wrote
yourself keeps its mode until Yardbell first saves it, so run `chmod 600` on it.

## 6. What applies when

| Change | Takes effect |
|---|---|
| machines, `mesh`, `agents`, `default_agent`, `ticket_pattern`, `forward_services`, `workspaces`, `poll_seconds`, `phone_notifications`, `pull_requests`, `triggers` | on the next check, a few seconds |
| `worktree_setup` | for the next worktree Yardbell creates |
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
| `pull_requests.poll_seconds must be at least 30` | ask GitHub less often, 120 is the default |
| `pull_requests.gitlab entry 1 needs a host` | add `host:` |
| `pull_requests.gitlab host "https://x/y" must be a host name only, like git.example.com` | drop the scheme and the path |
| `pull_requests.gitlab lists git.example.com twice` | keep one entry per host |
| `pull_requests.github_token is needed to read GitHub with a token` | add one, or set `github_via: gh` |
| `pull_requests.github_token must name a saved secret` | save the token as a secret and write `${secret:NAME}` |
| `pull_requests.gitlab git.example.com needs a token` | add `token: '${secret:NAME}'` |
| `pull_requests.gitlab git.example.com: url must start with https:// or http:// and have no path` | write `url` as `https://host` or `https://host:port` |
| `trigger "x" needs exactly one of schedule, linear or github` | give each trigger one source |
| `trigger "x": schedule "daily 9am" has a time that is not HH:MM...` | write the schedule as `daily 09:00`, `weekdays 09:00`, `every 4h` or `cron 30 9 * * 1-5` |
| `trigger "x" is listed twice` | trigger names must be unique |
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
