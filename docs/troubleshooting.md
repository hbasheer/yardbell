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

- **A GitLab branch shows no merge request badge.** Run `yardbell doctor`: it signs in to each host
  under `pull_requests.gitlab` and says whether the token's secret is missing, GitLab refused the
  token, or the host did not answer (and why). The host must match the one in the branch's remote
  exactly, and the token needs `read_api` and access to the project. After a refusal Yardbell waits
  10 minutes before asking that host again.

## Limitations

- Only sessions inside tmux can be opened from Yardbell.
- Agent state is read from the screen only for agents herdr has rules for, and only inside tmux.
  Other agents' working or idle is estimated from CPU use.
- Docker on macOS hosts is unverified; the native binary is recommended there.
- One host at a time: two Yardbell hosts would fight over the same local tunnel ports.
