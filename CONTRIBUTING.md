# Contributing to Yardbell

Thanks for helping. Yardbell is small on purpose: one Rust binary, plain HTML, CSS and JavaScript,
nothing installed on the machines it manages. Changes that keep it that way are the easiest to
merge.

## Getting started

```sh
git clone <your fork>
cd yardbell
cargo test
cargo run -- serve --config yardbell.example.yml   # after `yardbell passcode`, see README
```

Rust stable is pinned in `rust-toolchain.toml`. The UI lives in `assets/` and is embedded into the
binary at build time (in debug builds it is read from disk, so a page reload picks up edits).

## Before you open a pull request

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` all pass.
  CI runs the same three on Linux and macOS.
- New behavior comes with a test. Anything that runs a command goes through the `Runner` trait so
  tests can use `FakeRunner` instead of a real machine.
- `src/snapshot.sh` must keep working on bash 3.2 (the macOS default). If you touch it, try
  `docker run --rm -v $PWD/src/snapshot.sh:/s.sh:ro bash:3.2 bash /s.sh /tmp -- web`.
- User-facing text: plain sentences, no em dashes.
- UI changes follow `DESIGN.md` (tokens, type scale, components). Attach before and after
  screenshots in light and dark, desktop and phone width.
- Keep comments for non-obvious reasons only; the code should say what it does.

## Reporting bugs

Open an issue with your OS, mesh VPN, Yardbell version, what you expected and what happened.
`yardbell doctor` output is very helpful. Remove IP addresses and hostnames you consider private.

Security problems: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
