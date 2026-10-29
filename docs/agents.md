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
| `list_conversations`, `read_conversation` | Dispatch conversations and who started each; one conversation's newest 20 turns, long text clipped |
| `list_tasks`, `read_task` | saved Dispatch tasks and their versions |
| `list_pipelines`, `read_pipeline` | pipelines with their run counts; one definition and its versions |
| `list_runs`, `read_run` | pipeline runs as summaries, newest first; one run in full |
| `read_insights` | a session's working, waiting and idle time and its commands, or every session seen on a machine |
| `list_pulls` | pull and merge requests for watched branches, with review state, CI and failing jobs |
| `read_usage` | Claude and Codex usage as the sidebar shows it |

Dispatch also has `remember`, which proposes a change to its own [memory](usage.md#memory). Other
clients do not see it, and calling it from one is refused.

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
