# Troubleshooting

Common problems and their fixes, and what Yardbell does not do yet.

## Troubleshooting

Start with `yardbell doctor`. Common cases:

- **A machine shows "SSH refused" or "Host key verification failed".** Yardbell uses ssh in batch mode
  and never answers prompts. Run `ssh <host> true` once from the host to accept the key, or use Add
  machine, which opens a terminal for that.
- **"Not on the mesh (VPN off or asleep)".** The machine is not answering on its mesh address. Wake
  it or turn its VPN on there.
- **"ControlPath too long".** Yardbell keeps one shared ssh connection per machine under its state
  folder and falls back to `/tmp/yardbell-cm-<uid>` when that path is too long for a Unix socket.
- **NordVPN on macOS shows no peers.** The macOS app has no command line. Status still works; type
  addresses by hand.
- **Your phone cannot reach Yardbell or its ports on a Linux host with ufw.** `yardbell doctor` prints the
  `ufw allow` rules for the Yardbell port and the tunnel ranges.
- **Ports of the host's own Docker apps work on the host but not from other devices.** With
  `ufw-docker` installed (check for `BEGIN UFW AND DOCKER` in `/etc/ufw/after.rules`), traffic to
  containers is only allowed from private LAN ranges (`10.x`, `172.16.x`, `192.168.x`). Mesh
  addresses (`100.x`) are dropped, and `ufw allow` rules do not help because container traffic is
  forwarded, not delivered to the host. Allow forwarding from the mesh interface:

  ```sh
  sudo ufw route allow in on nordlynx      # tailscale0 for Tailscale, wt0 for NetBird
  ```

  This lets every device on your mesh reach every published container on the host, including ones
  you start later. To test, run `curl -I http://<host-mesh-ip>:<port>/` from another machine.

- **A session says No PR info, or which service a folder uses is not clear.** Open **Settings, GitHub
  and GitLab**. **Your folders** shows the service each folder's `origin` is on and whether it is
  ready, and offers to add a GitLab host that is missing.
- **A pipeline step says it ended without a result.** The agent went quiet and Yardbell read no result
  block for that try. Press **Show terminal** on the run. If the agent's result is there, press
  **Continue on pass** or **Continue on fail**; otherwise press **Retry step**. Only Claude Code's
  result is read from its transcript, so with other agents make the terminal bigger and keep it
  scrolled to the bottom. A run that was going when you upgraded asks for the new `step:` line, so it
  can stop here once.
- **A connection says its list was cut off.** It reached 20 pages, its `max_pages`, or 5,000 items, or the
  server repeated a page. Raise `max_pages` up to 100, or narrow the `list` call. Items past the limit do
  not start runs.
- **A connection says an address is private.** Its host resolves to a private or mesh address. Tick
  **Allow private addresses** on the connection if that is your own tool.
- **Test says only a call that reads can run.** A POST counts as a change. If `list` only reads, as a
  GraphQL query does, add `kind: lookup` to it.
- **A webhook never arrives.** Yardbell listens on this machine and your mesh, so an outside service needs a
  tunnel you set up. A 404 means the address is wrong or replaced, or the pipeline is not saved and on.
- **A pipeline's teardown did not run.** The run page says why when another session or run was using
  the folder. It also does not run in a worktree the run did not create, see
  [Teardown](automation.md#teardown).
- **A GitLab branch shows no merge request badge.** Run `yardbell doctor`: it signs in to each host
  under `pull_requests.gitlab` and says whether the token's secret is missing, GitLab refused the
  token, or the host did not answer (and why). The host must be the one in the branch's remote
  (letter case does not matter), and the token needs `read_api` and access to the project. After a refusal Yardbell waits
  10 minutes before asking that host again.

### Connections

| What you see | What it means | What to do |
|---|---|---|
| **Sign in again** on a connection | The sign-in expired or was revoked | Press it. Then retry any run that waited |
| A sign-in page refuses Yardbell, or an error about the client | That tool does not accept new apps this way | Use its **Token** example, or an app of your own |
| Yardbell asks for a client ID | The server has no way for Yardbell to register itself, as with Asana | Make an app in its developer console with the redirect address shown, and enter its ID and secret |
| Jira says an admin must allow the app | An Atlassian admin can block new apps for a site | Ask them, or use the **Token** example |
| The page after signing in does not load | You are on another device, and it sent you to `127.0.0.1` | Paste that page's address into the box Yardbell shows |
| `glab is not signed in` | `glab` on that machine has no login for the host | Run `glab auth login` there |
| `GitHub refused the token` | The saved token expired or lacks access | Paste a new one under GitHub's **Edit** |
| A step waits with **Accept and run** | The server changed the tool since the step was saved | Read what it does now, then accept it |

## Limitations

- Only sessions inside tmux can be opened from Yardbell.
- Agent state is read from the screen only for agents herdr has rules for, and only inside tmux.
  Other agents' working or idle is estimated from CPU use.
- Docker on macOS hosts is unverified; the native binary is recommended there.
- One host at a time: two Yardbell hosts would fight over the same local tunnel ports.
