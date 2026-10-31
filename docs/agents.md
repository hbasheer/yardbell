# AI agents and MCP

The agents Yardbell knows, how to add your own, its MCP server for agents, and how to make every session openable.

## AI agents

Yardbell finds sessions by process name and starts them with the agent's own command. These work
without any config:

| Agent | Starts with | Resumes with | Free option |
|---|---|---|---|
| Claude Code | `claude` | `claude --continue` | |
| Codex | `codex` | `codex resume --last` | |
| Gemini CLI | `gemini` | `gemini --resume` | free tier with a Google account |
| Qwen Code | `qwen` | `qwen --continue` | free tier with a Qwen account |
| opencode | `opencode` | `opencode --continue` | free models, or your own key |
| Copilot CLI | `copilot` | `copilot --continue` | free GitHub Copilot plan |
| Cursor Agent | `cursor-agent` | `cursor-agent resume` | |
| Crush | `crush` | `crush --continue` | your own key or a local model |
| Goose | `goose session` | `goose session --resume` | your own key or a local model |
| Aider | `aider` | `aider --restore-chat-history` | your own key or a local model |

Free tiers and plans change, so check each agent's site. Agents that take your own key also work
with local models through Ollama or LM Studio at no cost.

Add any other CLI agent, or change the commands of a built-in one, under `agents:` in the config:

```yaml
default_agent: codex              # preselected in New session the first time
agents:
  - name: amp                     # [a-z0-9-]+
    label: Amp                    # shown in the UI (optional)
    command: amp
    resume: amp threads continue
  - name: codex                   # same name as a built-in: replaces its commands
    command: codex --full-auto
    resume: codex resume --last --full-auto
  - name: my-agent
    command: npx my-agent
    resume: npx my-agent --continue
    process: my-agent             # process name to look for, when it differs from the command
```

Ended sessions resume with the agent they ran. Memory used by every agent process counts toward the
blue share of the memory bar.

## Agent tools (MCP)

Turn on **Agent tools (MCP)** in Settings to let any MCP client use Yardbell. Settings shows the
command for Claude Code, for example:

```sh
printf 'Yardbell token: ' && read -rs YB_TOKEN && echo && claude mcp add --transport http \
  --scope user yardbell http://100.64.0.10:4000/mcp --header "Authorization: Bearer $YB_TOKEN"; unset YB_TOKEN
```

Run it, then paste the token (**Copy token** in Settings) when it asks. `read -s` takes the token
without showing it, so it never appears in the line you type or in your shell history, and
`unset` drops it afterwards. Claude Code stores it in its own config, `~/.claude.json`. The command
works in bash and zsh. The token is still an argument of `claude mcp add` for the second it runs;
on a machine shared with people you do not trust, run it where you are the only user, or add the
server to `~/.claude.json` by hand.

| Tool | What it does |
|---|---|
| `list_machines` | up or down and why, memory total and free, agents' share, load, CPUs, session count |
| `list_sessions` | agent, folder, ticket, branch, working or idle, tmux name |
| `list_folders` | git checkouts per machine with their branch, and recent folders |
| `start_session` | start an agent in a folder, on a branch (new ones get a worktree), with a task |
| `read_session` | what the session's terminal shows, with scrollback |
| `send_to_session` | type a reply and press Enter; the text goes over standard input, never on a command line |
| `stop_session` | end the session |
| `review_session` | start a read-only reviewer for a session's branch |
| `scan_folder` | start a read-only scan of a folder for dead code, test gaps or security problems |
| `remove_worktree` | remove a worktree that would lose nothing; never a main checkout, never forced |
| `integrate_branches` | merge or rebase several branches, in order, onto a new branch in its own worktree; stops at the first conflict |
| `push_branch` | push a branch, never forced, after a scan for keys, tokens and saved secret values |
| `move_session` | move a session's branch, uncommitted changes and task to another machine, without committing or pushing |

These read Yardbell's own settings and data, change nothing, and never show a secret: a setting
that uses one shows its `${secret:NAME}` reference, and any other credential shows `(hidden)`.

| Tool | What it does |
|---|---|
| `read_settings` | one area of Settings with what it may be set to: `dispatch`, `triggers`, `worktree_setup`, `agents`, `session_mcp_servers`, `phone`, `machines`, `pipelines`, `pull_requests`, `security` or `about` |
| `list_conversations`, `read_conversation` | Dispatch conversations and who started each; one conversation's newest 20 events, long text clipped, under about 30 000 characters |
| `list_tasks`, `read_task` | saved Dispatch tasks and their versions |
| `list_pipelines`, `read_pipeline` | pipelines with their run counts; one definition and its versions |
| `list_runs`, `read_run` | pipeline runs as summaries, newest first; one run in full |
| `read_insights` | a session's working, waiting and idle time and its commands, or every session seen on a machine |
| `list_pulls` | pull and merge requests for watched branches, with review state, CI and failing jobs |
| `read_usage` | Claude and Codex usage as the sidebar shows it |

Dispatch also has tools that change things, each a step its approval setting and rules decide:

| Tool | What it does |
|---|---|
| `remember` | proposes a change to its own [memory](usage.md#memory) |
| `change_settings` | replaces one changeable area (every `read_settings` area except `security` and `about`) with an edited copy, checked as Settings checks it and saved so Settings' Undo reverses it; a `(hidden)` left as it is keeps the saved value; machines are never added or removed; text around a `(hidden)` cannot be edited, and an entry whose url, host or command changes loses its kept credentials; the `dispatch` area, and any change that adds a `${secret:NAME}` reference, always wait for you |
| `save_task` | saves a new task, or a new version of one |
| `run_trigger` | runs a trigger now, as Settings' Run now does |
| `save_connector` | saves a connection to an outside tool, checked as Settings checks it; it always waits for you, a new one arrives switched off, tokens can only be named as secrets, and `allow_private` can only be set in Settings |
| `save_pipeline` | saves a new pipeline (switched off) or a new version of one, checked as the builder checks it; it always waits for you, and its card opens in the builder |
| `set_pipeline_enabled` | switches a pipeline on or off, after checking that its trigger can run |
| `run_pipeline` | starts runs of a pipeline on Linear tickets or pull and merge request links |
| `answer_run` | answers a waiting run, retries its step, continues it as passed or failed, or drops it |

Other clients, such as Claude Code with Yardbell added, can call every one of these except
`remember`. Each call is checked as it is for Dispatch, and a problem goes back to the client; a
change that passes waits in the **Proposals** inbox, and nothing changes until you approve it
there, whatever your approval setting or allow rules say (a rule that refuses the action still
refuses it). The client's answer names the proposal. A pipeline run's own Dispatch turn cannot call
any of them, whatever the rules say, so text in a ticket cannot answer the run it belongs to.

**MCP servers for sessions** in Settings lists other MCP servers (a command such as
`npx -y @modelcontextprotocol/server-github`, or a URL) and the machines they are for. Claude Code
sessions that Yardbell starts get them through `--mcp-config`, without touching the agent's own
settings. Keep their tokens in the **Secrets** list below them and write `${secret:NAME}` in the
header or variable, for example `Authorization=Bearer ${secret:linear}`, see
[Secrets](configuration.md#secrets). Their tokens never appear on a command line: Yardbell writes the
list to a file only your account can read on that machine and gives Claude Code its path, see
[`mcp_servers`](configuration.md#mcp_servers-optional). Other agents configure MCP their own way
and do not get them.

## Making every session openable

Yardbell can only open sessions that run inside tmux. Sessions you start from Yardbell always do, and
**Move to tmux** brings one that doesn't over. To make
sessions you start in a terminal openable too, add this to your shell config on each machine. List
the agents you use:

```sh
for agent in claude codex gemini opencode aider; do
  eval "$agent() {
    if [ -n \"\$TMUX\" ]; then command $agent \"\$@\"; return; fi
    tmux new -A -s \"\$(basename \"\$PWD\" | tr . -)\" \"command $agent \$*\"
  }"
done
```
