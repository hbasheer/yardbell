# Development

Building, testing and changing Yardbell.

## Development

```sh
cargo test                                    # unit and route tests, no network needed
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo run -- serve --config yardbell.example.yml # after `cargo run -- passcode --config ...`
```

The desktop app is a separate Cargo package: run the same three checks in `desktop/`. On Debian and
Ubuntu that needs `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`libssl-dev` and `libxdo-dev`. `cargo tauri build` (from `cargo install tauri-cli`) makes the
installers.

To release, set the same version in `Cargo.toml` and `desktop/Cargo.toml`, move the changes under
that version in `CHANGELOG.md`, and push a `v<version>` tag. The Desktop release workflow builds the
installers into a draft release on GitHub; try them, then publish it.

| Path | What lives there |
|---|---|
| `src/snapshot.sh` | Read-only script run on every machine (bash 3.2 compatible) |
| `src/probe.rs`, `src/poller.rs`, `src/state.rs` | Checking machines and keeping the current picture |
| `src/tunnels.rs` | One `ssh -N -L` per machine with backoff |
| `src/sessions.rs`, `src/folders.rs` | Starting, stopping and attaching sessions; folders, branches, worktrees |
| `src/term.rs` | Websocket to pty bridge for the browser terminal |
| `src/mesh.rs` | Mesh VPN providers |
| `src/onboarding/`, `src/settings.rs` | Add machine and Settings |
| `src/web/` | HTTP routes and auth |
| `assets/` | The UI: plain HTML, CSS and JavaScript (embedded in release builds) |
| `desktop/` | The desktop app (Tauri 2), see [Apps](apps.md#apps) |
| `DESIGN.md` | The design system the UI follows |

Everything that runs a command goes through the `Runner` trait, so tests use a fake instead of real
machines. See [CONTRIBUTING.md](../CONTRIBUTING.md).
