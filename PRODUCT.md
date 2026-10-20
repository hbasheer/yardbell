# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who run AI coding agent sessions (Claude Code, Codex, Gemini CLI, opencode, Aider and others) across several of their own machines (for example a desktop, a laptop and a Linux box) to spread memory-heavy work such as Docker stacks. They drive everything from one screen and also check in from a phone. They are comfortable with ssh, tmux and git.

## Product Purpose

Yardbell answers at a glance whether each machine is connected and healthy, which agent session runs where and for which ticket, and which local port opens the app that session is working on. It starts, opens (a full terminal, also from a phone), stops and resumes sessions, creates git worktrees per branch, and adds machines without hand-editing ssh config. Success: nobody has to open an ssh session or remember a port to know what is going on.

## Positioning

One self-hosted page for all your machines with nothing installed on the other machines: it uses the existing ssh and mesh VPN, tunnels each session's app ports automatically, and works from any device on the mesh.

## Operating Context

- Machines connected by a mesh VPN (NordVPN Meshnet, Tailscale, Headscale, NetBird, ZeroTier) or a plain network; ssh between them.
- Work happens in tmux sessions running a CLI coding agent inside git checkouts; branch names often carry ticket ids.
- Apps run in Docker Compose stacks whose ports Yardbell forwards to the host.
- First-glance priority: machine health, then sessions, then ports. Desktop and phone are both first-class.

## Capabilities and Constraints

- Single Rust binary serving plain HTML, CSS and JavaScript, no build step; xterm.js for the terminal.
- Polls every few seconds; machines can be unreachable at any time and must degrade gracefully.

## Brand Commitments

Name: Yardbell. The UI follows the category standard for developer infrastructure tools (Linear, Vercel, Tailscale, GitHub). Avoid generic admin-template looks and anything playful or decorative.
