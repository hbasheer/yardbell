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

## Browser tests

`tests/browser/` drives headless Firefox against a real Yardbell server, with only Python's standard
library (WebDriver BiDi). It needs `firefox`, `tmux` and a debug build:

```sh
cargo build
python3 tests/browser/run.py                 # the whole suite, about 30 seconds
python3 tests/browser/run.py -k workspace    # only the tests whose name contains "workspace"
python3 tests/browser/run.py --shots shots   # a screenshot of each failing test
```

Each run makes a temporary directory with a config, a state dir, two git repos for the machine's
root, its own tmux server and a clean `HOME`, and removes it afterwards (`--keep` leaves it, with
the server log). It logs in, opens every page, starts a plain shell session, types into the
terminal and uses Copy text and Copy all, checks that overflowing Workspace tabs keep the current
one in view, and shows saved Dispatch conversations at desktop and phone width. Any page error or
`console.error` fails the test it happened in. Dispatch is never asked anything, and the server
cannot find a real `claude`. Set `FIREFOX` or pass `--firefox` when Firefox is not on the `PATH`.
CI runs it on Linux.

## Dependency audit

`cargo audit` runs in CI for `Cargo.lock`, `desktop/Cargo.lock` and `android/Cargo.lock`. Any
advisory it is told to ignore is listed with its reason in `.github/workflows/ci.yml`.
