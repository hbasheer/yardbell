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
claude mcp add --transport http --scope user yardbell http://100.64.0.10:4000/mcp \
  --header "Authorization: Bearer yb_..."
```

| Tool | What it does |
|---|---|
| `list_machines` | up or down and why, memory total and free, agents' share, load, CPUs, session count |
| `list_sessions` | agent, folder, ticket, branch, working or idle, tmux name |
| `list_folders` | git checkouts per machine with their branch, and recent folders |
| `start_session` | start an agent in a folder, on a branch (new ones get a worktree), with a task |
| `read_session` | what the session's terminal shows, with scrollback |
| `send_to_session` | type a reply and press Enter |
| `stop_session` | end the session |

**MCP servers for sessions** in Settings lists other MCP servers (a command such as
`npx -y @modelcontextprotocol/server-github`, or a URL) and the machines they are for. Claude Code
sessions that Yardbell starts get them through `--mcp-config`, so nothing is written on the
machines. Other agents configure MCP their own way and do not get them.

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
