# Mobile app step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React Native (Expo) Android app in `mobile/` that pairs with a Yardbell server over the mesh, shows machines and sessions live, drives a session's terminal, and shows notifications, installing over the current Tauri app.

**Architecture:** The server gains per-device bearer tokens (issued at pairing or passcode sign-in, revocable in Settings) that the auth guard and both WebSockets accept without an `Origin`. The app talks to the existing JSON and WebSocket routes with that token. The terminal is xterm.js in a WebView fed by a WebSocket the React Native side owns, and notifications come from a Kotlin foreground service, ported from the Tauri app, that long-polls `/app/notifications`.

**Tech Stack:** Rust/axum (server), React 19 + Vite (Settings page), Expo SDK 58, React Native 0.88, Expo Router, TypeScript, `@tanstack/react-query`, `react-native-webview`, `expo-camera`, `expo-secure-store`, `expo-device`, `@xterm/xterm`, Vitest, Kotlin (Expo local module).

**Spec:** `docs/plans/mobile-app-design.md`

## Global Constraints

- Application id `dev.yardbell.android`; signed with `~/.local/android/release/yardbell-release.jks` (properties in `~/.local/android/release/keystore.properties`: storeFile, password, keyAlias).
- `versionCode = major * 1000000 + minor * 1000 + patch` of the Yardbell version (0.11.107 gives 11107; must exceed the Tauri app's 11106).
- App version equals the Yardbell version in `Cargo.toml`; the apk is named `Yardbell_<version>_android.apk`.
- Server reached only at the mesh address from the pairing QR; no relay, no cloud push, no Firebase.
- Device tokens never expire; they end only when revoked. Stored server-side as SHA-256 hex, never in plain text.
- The cookie path (`/login`, `/app/pair/{code}` cookie, `/app/handoff`) keeps working unchanged for the Tauri app.
- No Orca name, logo, icons, sounds or bot art. Files copied mostly as-is from `~/Projects/orca` get a one-line provenance header; Orca's MIT notice goes in `THIRD_PARTY_NOTICES.md`.
- No em dashes in any user-facing text, commit message or doc. No "Orca" in commit messages. No comments that explain what code does.
- Node-free `cargo build`: nothing in the Rust build may depend on `mobile/`.

## Review Focus

1. Meshnet drops while a terminal is open: the screen shows "Reconnecting" over the terminal, keys typed meanwhile are not sent to a dead socket, and it resumes on its own when the server answers. (Task 9 test `reconnects_and_drops_input_while_down`.)
2. The server restarts: `/state/live` closes, the app reconnects and refetches; the notification service sees a new `boot` and starts from the server's cursor without replaying old notes. (Task 8 test `refetches_after_live_socket_reopens`; Task 10 keeps the Tauri service's boot logic.)
3. A device is revoked while the app is open: every request gets 401, the app shows "This phone was signed out" with Pair again, and the service posts one notification and stops polling that server. (Task 2 test `revoked_token_is_refused`; Task 6 test `signed_out_on_401`; Task 10.)
4. The session ends while its terminal is open: the server's `{"t":"exit","msg":...}` frame shows the message and a Back button instead of a frozen screen. (Task 9 test `exit_frame_shows_message`.)
5. A server older than this release: pairing gets no `token` in the reply, or `/app/about` has no `api` field; the app says "Update Yardbell on <machine> to 0.11.107 or later" instead of failing silently. (Task 6 test `old_server_is_reported`.)

---

### Task 1: Device token store

**Files:**
- Create: `src/phone/devices.rs`
- Modify: `src/phone/mod.rs` (add `pub mod devices;`)

**Interfaces:**
- Produces:
  - `pub struct Devices` (interior `Mutex`), `pub fn Devices::load(path: PathBuf) -> Devices` (missing or unreadable file gives an empty list, logged).
  - `pub fn issue(&self, name: &str, now: u64) -> Result<(DeviceView, String), String>`: returns the view and the plain token `ybd_` + 40 alphanumeric chars (`rand`), persists immediately.
  - `pub fn check(&self, token: &str, now: u64) -> Option<String>`: device id when the SHA-256 of `token` matches; updates `last_seen` in memory and persists at most once per hour per device.
  - `pub fn list(&self) -> Vec<DeviceView>` newest first; `pub fn revoke(&self, id: &str) -> Result<bool, String>`.
  - `#[derive(Serialize, Clone, PartialEq, Debug)] pub struct DeviceView { pub id: String, pub name: String, pub paired_at: u64, pub last_seen: Option<u64> }`.
- File: `devices.json` written atomically (temp file + rename), mode 0600 on unix. Stored fields: id (16 hex), name (trimmed, max 60 chars, empty becomes "Phone"), token_sha256, paired_at, last_seen.

- [ ] **Step 1: Write the failing tests** in `src/phone/devices.rs` `#[cfg(test)]`:

```rust
#[test] fn issued_token_checks_and_survives_reload()   // issue, check == Some(id), load again from same path, check still Some(id)
#[test] fn wrong_token_is_refused()                    // check("ybd_nope") == None
#[test] fn revoke_ends_the_token()                     // revoke(id) == Ok(true); check(token) == None; revoke(id) == Ok(false)
#[test] fn file_holds_no_plain_token()                 // fs::read_to_string(path) does not contain token
#[test] fn names_are_trimmed_and_capped()              // issue("  ", ..).name == "Phone"; 100-char name gives 60 chars
#[test] fn last_seen_is_written_at_most_hourly()       // check at t, t+10 -> file last_seen == t; check at t+3601 -> file last_seen == t+3601
```

- [ ] **Step 2: Run** `cargo test phone::devices` and see them fail to compile.
- [ ] **Step 3: Implement** `Devices` as above with `sha2::Sha256` and a constant-time comparison over the hex digests.
- [ ] **Step 4: Run** `cargo test phone::devices`. Expected: 6 passed.
- [ ] **Step 5: Commit** `git commit -m "Device tokens for the phone app, stored hashed"`

### Task 2: Accept device tokens in the guard and WebSockets

**Files:**
- Modify: `src/web/mod.rs` (`AppState` and `AppState::new`: field `pub devices: Arc<crate::phone::devices::Devices>` loaded from `cfg_path.with_file_name("devices.json")`; `guard`; `state_live`; `term_ws`)
- Test: `src/web/tests.rs`

**Interfaces:**
- Consumes: `Devices::check` (Task 1).
- Produces: request extension `#[derive(Clone)] pub struct DeviceAuth(pub String)` (device id) inserted by `guard` when `Authorization: Bearer <token>` checks; `fn bearer(headers: &HeaderMap) -> Option<&str>`.
- Rule in `guard`, placed after the `/mcp`, webhook and OAuth early returns and before the Origin check: a valid device bearer skips the Origin check and the cookie check. An invalid bearer on a request with no cookie gets 401 `{"error":"this phone was signed out, pair it again"}`. `state_live` and `term_ws` skip `origin_ok` when `DeviceAuth` is present.

- [ ] **Step 1: Write the failing tests** in `src/web/tests.rs` (use `rig()`, issue a token with `r.app.devices.issue("Pixel", 0)`):

```rust
#[tokio::test] async fn device_token_reads_state_without_cookie_or_origin()   // GET /state with Bearer -> 200
#[tokio::test] async fn device_token_posts_without_origin()                    // POST /sessions/hp/x/keys {"keys":"y"} with Bearer, no Origin -> not 403
#[tokio::test] async fn revoked_token_is_refused()                             // revoke, GET /state with Bearer -> 401, body error == "this phone was signed out, pair it again"
#[tokio::test] async fn cookie_post_still_needs_origin()                       // POST with cookie, no Origin -> 403 (unchanged)
#[tokio::test] async fn live_socket_accepts_device_token_without_origin()      // WebSocket upgrade on /state/live with Bearer and no Origin -> 101
```

- [ ] **Step 2: Run** `cargo test --lib web::tests::device_ web::tests::revoked_ web::tests::cookie_post web::tests::live_socket`. Expected: fail.
- [ ] **Step 3: Implement** the field, `bearer`, `DeviceAuth` and the guard/WebSocket rules.
- [ ] **Step 4: Run** the same tests, then `cargo test --lib web::tests`. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "Server accepts phone device tokens without a cookie or Origin"`

### Task 3: Issue tokens at pairing and sign-in, list and revoke, API level

**Files:**
- Modify: `src/web/mod.rs` (`pair_redeem`, new `app_sign_in`, route table, `guard` public paths, `app_about`)
- Modify: `src/web/settings_api.rs` (routes `GET /api/settings/devices`, `POST /api/settings/devices/{id}/revoke`)
- Test: `src/web/tests.rs`

**Interfaces:**
- Consumes: `Devices::issue`, `list`, `revoke` (Task 1).
- Produces (HTTP):
  - `POST /app/pair/{code}` with optional JSON body `{"device": "<name>"}`: unchanged cookie plus `{"ok":true}`; when `device` is given, also `"token"` and `"device": DeviceView`. No body keeps today's reply exactly (Tauri app).
  - `POST /app/sign-in` JSON `{"passcode": "...", "device": "<name>"}`: uses `app.auth.verify` (same 429 and 401 messages as `/login`), on success `{"ok":true,"token":...,"device":DeviceView}`, no cookie.
  - `GET /app/about` adds `"api": 1` (const `APP_API: u32 = 1` in `src/web/mod.rs`).
  - `GET /api/settings/devices` -> `{"devices":[DeviceView...]}`; `POST /api/settings/devices/{id}/revoke` -> `{"ok":true}` or 404 `"no paired phone with that id"`.
- `guard`: `/app/sign-in` POST is public. For POST `/app/pair/` and `/app/sign-in`, reject only when an `Origin` header is present and does not match (same rule as `/mcp`), so a native client with no Origin passes.

- [ ] **Step 1: Write the failing tests:**

```rust
#[tokio::test] async fn pairing_with_a_device_name_returns_a_token()      // new_pairing(&r.app); POST /app/pair/{code} {"device":"Pixel 8"} no Origin -> 200, body.token starts "ybd_", body.device.name == "Pixel 8"
#[tokio::test] async fn pairing_without_a_body_is_unchanged()             // body == {"ok":true}, Set-Cookie present
#[tokio::test] async fn sign_in_with_passcode_returns_a_token()           // {"passcode":"pw","device":"Pixel"} -> 200 token; wrong passcode -> 401 "wrong passcode"
#[tokio::test] async fn devices_are_listed_and_revoked_from_settings()    // cookie GET /api/settings/devices has 1; revoke -> ok; list empty; revoke again -> 404
#[tokio::test] async fn about_reports_the_app_api_level()                 // GET /app/about body.api == 1
```

- [ ] **Step 2: Run** `cargo test --lib web::tests::pairing_ web::tests::sign_in_ web::tests::devices_are web::tests::about_reports`. Expected: fail.
- [ ] **Step 3: Implement** the routes and guard rule.
- [ ] **Step 4: Run** `cargo test` (whole crate) and `cargo clippy --all-targets -- -D warnings`. Expected: pass, no warnings.
- [ ] **Step 5: Commit** `git commit -m "Pairing and passcode sign-in issue phone tokens, Settings lists and revokes them"`

### Task 4: Paired phones in Settings

**Files:**
- Modify: `web/src/settings/Sections.tsx` (`PairSection`)
- Modify: `assets/app/**` (rebuilt output)
- Test: `tests/browser/run.py`

**Interfaces:**
- Consumes: `GET /api/settings/devices`, `POST /api/settings/devices/{id}/revoke` (Task 3).
- UI: under the QR in "Connect a phone", a "Paired phones" list: name, "Paired <date>", "Last seen <relative>" or "Not seen yet", and a Remove button that confirms with "Remove <name>? It will need to pair again." The list refreshes after a QR code is shown and every 5 s while the QR is visible, so a phone that just paired appears. Empty state: "No phone is paired with this server."

- [ ] **Step 1: Write the failing browser test** `test_paired_phones_list_and_remove` in `tests/browser/run.py`: seed a device through `POST /app/sign-in`, open `/ui/settings` Connect a phone, assert the name shows, click Remove, confirm, assert the empty-state text.
- [ ] **Step 2: Run** `python tests/browser/run.py -k paired_phones`. Expected: fail.
- [ ] **Step 3: Implement** the list in `PairSection`, following the section's existing `Section`/`Button` components.
- [ ] **Step 4: Run** `cd web && npm run build`, then the browser test. Expected: pass.
- [ ] **Step 5: Commit** `git add web assets/app tests/browser/run.py && git commit -m "Settings lists paired phones and can remove one"`

### Task 5: Scaffold the Expo app, build a signed apk

**Files:**
- Create: `mobile/package.json`, `mobile/app.config.ts`, `mobile/tsconfig.json`, `mobile/vitest.config.ts`, `mobile/babel.config.js`, `mobile/metro.config.js`, `mobile/.gitignore` (ignores `android/`, `ios/`, `node_modules/`, `*.apk`), `mobile/app/_layout.tsx`, `mobile/app/index.tsx`, `mobile/src/theme/colors.ts`, `mobile/src/version.ts`, `mobile/src/version.test.ts`, `mobile/assets/icon.png`, `mobile/assets/adaptive-icon.png`, `mobile/assets/notification-icon.png`, `mobile/scripts/build-apk.sh`
- Modify: `THIRD_PARTY_NOTICES.md`, `.github/workflows/ci.yml` (job `mobile`: Node 24, `npm ci`, `npm run typecheck`, `npm test` in `mobile/`)

**Interfaces:**
- Produces:
  - `export function versionCode(version: string): number` in `mobile/src/version.ts` (throws on a non `x.y.z` string).
  - `app.config.ts`: name "Yardbell", slug "yardbell", scheme "yardbell", `android.package` "dev.yardbell.android", `version` read from `../Cargo.toml` `[package] version`, `android.versionCode = versionCode(version)`, icons from the existing Android icon set (`android/icons/`, background `#18181B`), `userInterfaceStyle: "automatic"`, plugins: `expo-router`, `expo-camera` (camera permission text "Scan the pairing code shown in Yardbell's Settings"), `expo-secure-store`, `expo-build-properties` (minSdk 26, targetSdk 35), `./modules/yardbell-notify` (Task 10).
  - `mobile/src/theme/colors.ts`: `export const colors = { light: {...}, dark: {...} }` with the web app's tokens from `web/src/main.css` (background, foreground, muted, border, accent, and the state colours idle/busy/waiting/down).
  - `mobile/scripts/build-apk.sh [--upload]`: sets `JAVA_HOME=$HOME/.local/android/jdk`, `ANDROID_HOME=$HOME/.local/android/sdk`, runs `npx expo prebuild --platform android --clean`, writes signing config from `keystore.properties` into the generated Gradle project (through a small config plugin `mobile/plugins/withReleaseSigning.js` rather than editing generated files), runs `./gradlew assembleRelease`, copies the apk to `mobile/Yardbell_<version>_android.apk`, and with `--upload` runs `gh release upload v<version> <apk> --clobber`.
- Versions: match `~/Projects/orca/mobile/package.json` for `expo`, `react`, `react-native`, `expo-router`, `react-native-webview`, `@tanstack/react-query`, `@xterm/xterm`, `expo-camera`.

- [ ] **Step 1: Write the failing test** `mobile/src/version.test.ts`:

```ts
expect(versionCode('0.11.107')).toBe(11107)
expect(versionCode('1.2.3')).toBe(1002003)
expect(() => versionCode('0.11')).toThrow()
```

- [ ] **Step 2: Run** `cd mobile && npm install && npm test`. Expected: fail (no module).
- [ ] **Step 3: Implement** the files above. `app/index.tsx` renders the Yardbell icon and "Yardbell" centred, in theme colours.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Run** `mobile/scripts/build-apk.sh`, then `$ANDROID_HOME/build-tools/*/apksigner verify --print-certs mobile/Yardbell_*_android.apk` and compare the SHA-256 with `apksigner verify --print-certs` of the 0.11.106 release apk. Expected: same certificate digest; `aapt dump badging` shows `package: name='dev.yardbell.android' versionCode='11107'` (after the version bump in Task 11, or the current version's code before it).
- [ ] **Step 6: Commit** `git add mobile THIRD_PARTY_NOTICES.md .github/workflows/ci.yml && git commit -m "Expo phone app skeleton with a signed release build"`

### Task 6: Servers, API client and pairing links

**Files:**
- Create: `mobile/src/servers/store.ts`, `mobile/src/servers/store.test.ts`, `mobile/src/api/client.ts`, `mobile/src/api/client.test.ts`, `mobile/src/pairing/link.ts`, `mobile/src/pairing/link.test.ts`

**Interfaces:**
- Produces:
  - `type PairedServer = { id: string; address: string; token: string; machine: string; deviceId: string }` (`id` = address).
  - `store.ts`: `listServers(): Promise<PairedServer[]>`, `saveServer(s: PairedServer): Promise<void>`, `forgetServer(id: string): Promise<void>`, `onServersChanged(fn: (s: PairedServer[]) => void): () => void`. Backed by `expo-secure-store` under key `servers` (JSON). After every change it calls `YardbellNotify.setServers(...)` (Task 10) with `{address, token}` pairs; tests mock that module.
  - `link.ts`: `parsePairingLink(link: string): { address: string; code: string }`, throwing `Error("That is not a Yardbell pairing code")` for anything the Rust `parse_pairing` in `android/src/client.rs` rejects (same cases: scheme must be `yardbell`, host `pair`, `server` must be http(s), code alphanumeric).
  - `client.ts`: `class ApiClient { constructor(server: PairedServer | { address: string }, fetchImpl?: typeof fetch); get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T> }` sending `Authorization: Bearer <token>`, `Accept: application/json`, 15 s timeout. Errors: `class SignedOutError` (401 on a request that carried a token), `class UnreachableError` (network error or timeout; message "Can't reach <address>. Is Meshnet on?"), `class ServerError` (other non-2xx, message from body `error`).
  - `pair(link: string, deviceName: string): Promise<PairedServer>` and `signIn(address: string, passcode: string, deviceName: string): Promise<PairedServer>` in `client.ts`: POST without Origin, then `GET /app/about` with the new token for `machine` and the `api` check. Missing `token` in the reply or missing/lower `api` throws `class ServerTooOldError` with message "Update Yardbell on <machine or address> to 0.11.107 or later".

- [ ] **Step 1: Write the failing tests** (fake `fetch`, mocked secure store):

```ts
// link.test.ts
parsePairingLink('yardbell://pair?server=http%3A%2F%2F100.64.0.10%3A4000&code=Ab12') -> { address: 'http://100.64.0.10:4000', code: 'Ab12' }
each of 'yardbell://pair?code=abc', 'yardbell://pair?server=http%3A%2F%2F1.2.3.4&code=../x', 'yardbell://pair?server=ftp%3A%2F%2F1.2.3.4&code=abc', 'https://x' throws
// client.test.ts
test('sends the bearer token')
test('signed_out_on_401')          // 401 -> SignedOutError
test('unreachable_on_network_error') // fetch rejects -> UnreachableError, message contains 'Is Meshnet on?'
test('old_server_is_reported')     // pair reply {"ok":true} without token -> ServerTooOldError
test('pair_saves_machine_from_about')
// store.test.ts
test('save, list, forget round trip and notify setServers each time')
```

- [ ] **Step 2: Run** `npm test`. Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `git commit -m "Phone app pairs, signs in and keeps its servers"`

### Task 7: Pairing screens

**Files:**
- Create: `mobile/app/pair.tsx` (camera scanner), `mobile/app/sign-in.tsx` (address and passcode), `mobile/app/signed-out.tsx`
- Modify: `mobile/app/_layout.tsx` (React Query provider, theme, route guard), `mobile/app/index.tsx`

**Interfaces:**
- Consumes: `parsePairingLink`, `pair`, `signIn`, `listServers`, `onServersChanged`, error classes (Task 6).
- Behaviour:
  - No servers saved: `index` redirects to `/pair`. `/pair` shows the camera with "Point at the code in Yardbell > Settings > Connect a phone", and a "Sign in with the passcode instead" link to `/sign-in`.
  - A `yardbell://pair?...` deep link opens `/pair?link=...` and pairs without the camera.
  - Device name: `expo-device` `deviceName ?? modelName ?? "Android phone"`.
  - Errors show their message under the scanner with Try again; the camera pauses while a pair request is in flight.
  - Any `SignedOutError` from any screen routes to `/signed-out?server=<id>`: "This phone was signed out of <machine>." with "Pair again" (forgets the server, goes to `/pair`).
  - Camera permission denied: text "Yardbell needs the camera to scan the pairing code" with Open settings and the passcode link.

- [ ] **Step 1: Write the failing test** `mobile/app/pair.test.tsx` with `@testing-library/react-native`: a `link` param calls `pair` with that link and the device name, then navigates to `/`; a `ServerTooOldError` shows its message.
- [ ] **Step 2: Run** `npm test`. Expected: fail.
- [ ] **Step 3: Implement** the screens.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `git commit -m "Pairing, passcode sign-in and signed-out screens"`

### Task 8: Live state and Home

**Files:**
- Create: `mobile/src/state/types.ts`, `mobile/src/state/useServerState.ts`, `mobile/src/state/useServerState.test.ts`, `mobile/src/state/home.ts`, `mobile/src/state/home.test.ts`, `mobile/app/(tabs)/_layout.tsx`, `mobile/app/(tabs)/index.tsx` (Home), `mobile/app/(tabs)/more.tsx`, `mobile/src/home/SessionRow.tsx`, `mobile/src/home/MachineHeader.tsx`, `mobile/src/home/ConnectionBanner.tsx`

**Interfaces:**
- Consumes: `ApiClient`, `listServers` (Task 6).
- Produces:
  - `types.ts`: TypeScript mirrors of `StateView`, `MachineView`, `SessionView` from `src/state.rs`, only the fields used: machines `{name, up, reason, local}`, sessions `{id, machine, agent, folder, branch, activity: 'active'|'idle'|'blocked', attachable, tmux, stale, stopped}`, `server {machine, address, version}`.
  - `useServerState(server: PairedServer): { state: StateView | undefined; connection: 'connected' | 'reconnecting' | 'unreachable' }`: React Query `GET /state`; a WebSocket to `/state/live` (RN `WebSocket` with `{ headers: { Authorization } }`) refetches on every message; on close it reconnects with backoff 1, 2, 4, ... 30 s, refetching on reopen; reconnects at once on `AppState` "active". After 3 failed attempts the connection is `unreachable`.
  - `homeSections(input: { server: PairedServer; state: StateView }[]): HomeSection[]` where `type HomeSection = { kind: 'needs-you' | 'machine'; title: string; server?: string; sessions: SessionView[]; machine?: MachineView }`. Rules: sessions with `activity === 'blocked'` and not `stopped` go to one "Needs you" section first (across servers, newest server order kept); then one section per machine in the server's order with its remaining sessions, attachable first then by folder; a machine with no sessions still shows with "No sessions"; `server` is set on machine sections only when more than one server is paired.
  - Tabs: Home and More only in this step (Dispatch and Inbox arrive in step 2). More holds: paired servers (name, address, Forget), "Pair another server", About (app version, server versions, link to licences screen rendering `THIRD_PARTY_NOTICES.md` bundled at build).
  - Row: status dot in the state colour, folder (or tmux name), agent, branch, machine; tapping opens `/session/<server>/<machine>/<tmux>` (Task 9) when `attachable`.

- [ ] **Step 1: Write the failing tests:**

```ts
// home.test.ts
test('waiting sessions lead in needs you, across servers')
test('machines keep server order and show when empty')
test('server title only when more than one server')
// useServerState.test.ts (fake WebSocket and fetch)
test('refetches_after_live_socket_reopens')
test('marks unreachable after three failed reconnects')
```

- [ ] **Step 2: Run** `npm test`. Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `git commit -m "Home lists machines and sessions live"`

### Task 9: Session terminal with key bar

**Files:**
- Create: `mobile/terminal/index.html`, `mobile/terminal/main.ts`, `mobile/scripts/build-terminal.mjs` (bundles `mobile/terminal` with esbuild into `mobile/src/terminal/terminalHtml.ts` exporting `terminalHtml: string`; run from `postinstall` and before `build-apk.sh`), `mobile/src/terminal/protocol.ts`, `mobile/src/terminal/protocol.test.ts`, `mobile/src/terminal/useTerminalSocket.ts`, `mobile/src/terminal/useTerminalSocket.test.ts`, `mobile/src/terminal/keys.ts`, `mobile/src/terminal/keys.test.ts`, `mobile/src/terminal/KeyBar.tsx`, `mobile/src/terminal/QuickReplies.tsx`, `mobile/app/session/[server]/[machine]/[name].tsx`

**Interfaces:**
- Consumes: `ApiClient` (Task 6), server routes `GET /term/{machine}/{name}/ws`, `GET /sessions/{machine}/{name}/agent`, `POST /sessions/{machine}/{name}/keys`.
- Wire (from `src/term.rs`): client sends text `{"t":"in","d":string}`, `{"t":"resize","rows":n,"cols":n}`, `{"t":"scroll","lines":n}`, `{"t":"focus"}`; server sends binary terminal output and text `{"t":"exit","msg":string}`.
- Produces:
  - `protocol.ts`: `encodeInput(d: string): string`, `encodeResize(rows: number, cols: number): string`, `encodeScroll(lines: number): string`, `decodeServer(data: string | ArrayBuffer): { kind: 'output'; bytes: Uint8Array } | { kind: 'exit'; msg: string }`.
  - WebView bridge messages (JSON via `postMessage`): RN to page `{type:'output', b64}`, `{type:'theme', colors}`, `{type:'reset'}`; page to RN `{type:'input', d}`, `{type:'resize', rows, cols}`, `{type:'scroll', lines}`, `{type:'ready'}`.
  - `useTerminalSocket(server, machine, name, onOutput, onExit): { send(d: string): void; resize(rows, cols): void; scroll(lines): void; status: 'connecting' | 'open' | 'reconnecting' | 'ended' }`: owns the RN WebSocket with the bearer header; on unexpected close reconnects with the same backoff as Task 8 and re-sends the last size; `send` while not `open` drops the input and returns, and the screen shows "Reconnecting".
  - `keys.ts`: `keyBytes(key: KeyName, mods: { ctrl: boolean; alt: boolean }): string` for `KeyName = 'esc'|'tab'|'up'|'down'|'left'|'right'|'home'|'end'|'pgup'|'pgdn'|'enter'` and Ctrl+letter, with xterm's modifier parameter for cursor keys (port the table and the rule in `assets/term.js` around lines 677 to 720).
  - Key bar: Esc, Tab, Ctrl (sticky toggle), Alt (sticky), arrows, Home/End, PgUp/PgDn; sits above the keyboard (`KeyboardAvoidingView`).
  - Quick replies: poll `GET /sessions/{m}/{n}/agent` every 3 s while the screen is visible; when `state` is `permission` or `question`, show its choices (as `assets/term-agent.js` does) and send them with `POST /keys`.
  - xterm page: port touch scrolling and font sizing from `assets/term.js` (swipe sends `scroll`, pinch changes font size and resends size), theme colours from `colors.ts`, Nerd font optional.
  - Header: session folder and agent, a Stop action that confirms then `POST /sessions/{m}/{n}/stop`.

- [ ] **Step 1: Write the failing tests:**

```ts
// protocol.test.ts
encodeInput('ls\r') === '{"t":"in","d":"ls\\r"}'
decodeServer('{"t":"exit","msg":"session ended"}') -> { kind: 'exit', msg: 'session ended' }
decodeServer(new Uint8Array([104,105]).buffer) -> output bytes [104,105]
// keys.test.ts
keyBytes('up', {ctrl:false,alt:false}) === '\x1b[A'
keyBytes('up', {ctrl:true,alt:false}) === '\x1b[1;5A'
keyBytes('esc', ...) === '\x1b'; Ctrl+'c' === '\x03'
// useTerminalSocket.test.ts (fake WebSocket)
test('reconnects_and_drops_input_while_down')   // close socket, send('x') sends nothing, reopen -> status open and last resize re-sent
test('exit_frame_shows_message')                // server text exit -> status 'ended', onExit('session ended')
```

- [ ] **Step 2: Run** `npm test`. Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`, then `node scripts/build-terminal.mjs` and check `src/terminal/terminalHtml.ts` is produced.
- [ ] **Step 5: Commit** `git commit -m "Session terminal with a key bar and quick replies"`

### Task 10: Notification service module

**Files:**
- Create: `mobile/modules/yardbell-notify/expo-module.config.json`, `mobile/modules/yardbell-notify/index.ts`, `mobile/modules/yardbell-notify/android/build.gradle`, `mobile/modules/yardbell-notify/android/src/main/AndroidManifest.xml`, `.../android/src/main/java/dev/yardbell/notify/YardbellNotifyModule.kt`, `.../NotifyService.kt`, `.../BootReceiver.kt`, `.../res/drawable/ic_notify.xml`, `mobile/modules/yardbell-notify/app.plugin.js`
- Create: `mobile/src/notifications/route.ts`, `mobile/src/notifications/route.test.ts`
- Modify: `mobile/app/_layout.tsx` (start service, request `POST_NOTIFICATIONS`, handle open intents)

**Interfaces:**
- Consumes: `setServers` is called by `store.ts` (Task 6).
- Produces (JS, `index.ts`):
  - `setServers(list: { address: string; token: string }[]): void`: stores the list in the module's private `SharedPreferences` ("notify-servers") and starts or stops the service.
  - `start(): void`; `addOpenListener(fn: (link: string) => void): Subscription`; `getInitialLink(): string | null` (the `click` of the notification that launched the app).
- Kotlin: port `android/gen/android/app/src/main/java/dev/yardbell/android/NotifyService.kt` and `BootReceiver.kt` with these changes only: servers come from "notify-servers" instead of `servers.json`; the poll sends `Authorization: Bearer <token>` instead of the cookie; on 401 it removes that server from the list, posts one notification "Yardbell: this phone was signed out of <address>. Open the app to pair again.", and ends that watch; tapping a notification opens the app with the note's `click` as an intent extra. Keep the channels ("Agents and machines", "Watching in the background"), boot/cursor handling, backoff and Android 14 `specialUse` foreground type exactly as they are.
- `route.ts`: `routeForLink(link: string, servers: PairedServer[]): string`: `<address>/term/<m>/<n>` for a paired address -> `/session/<serverId>/<m>/<n>` (decode segments); anything else -> `/`.

- [ ] **Step 1: Write the failing test** `route.test.ts`:

```ts
routeForLink('http://100.64.0.10:4000/term/hp/yb-fix%20it', [s]) === '/session/http%3A%2F%2F100.64.0.10%3A4000/hp/yb-fix%20it'
routeForLink('http://100.64.0.10:4000/', [s]) === '/'
routeForLink('http://10.0.0.9:4000/term/hp/x', [s]) === '/'   // not a paired server
```

- [ ] **Step 2: Run** `npm test`. Expected: fail.
- [ ] **Step 3: Implement** the module, plugin (adds the service, receiver, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`) and `route.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck && scripts/build-apk.sh`. Expected: tests pass, apk builds.
- [ ] **Step 5: Commit** `git commit -m "Background notifications for the phone app"`

### Task 11: Release wiring and on-device check

**Files:**
- Modify: `CHANGELOG.md`, `Cargo.toml`, `desktop/Cargo.toml`, `android/Cargo.toml` and the three lockfiles (version 0.11.107), `mobile/package.json` version
- Modify: `README.md` (phone app section: install, pair, Meshnet)
- Modify: memory note `android-apk-build` (new build command), outside the repo

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Bump** to 0.11.107 everywhere listed; add the CHANGELOG entry ("New phone app", pairing again after updating, paired phones in Settings).
- [ ] **Step 2: Run** `cargo test`, `cd web && npm run build`, `cd mobile && npm test && npm run typecheck`, `mobile/scripts/build-apk.sh`. Expected: all pass; apk `mobile/Yardbell_0.11.107_android.apk` with versionCode 11107.
- [ ] **Step 3: Install on the phone over the 0.11.106 Tauri app** (`adb install -r` or download) with the hp server running this branch. Check by hand and record results in the PR:
  1. The app installs as an update (no uninstall prompt) and opens on the pairing screen.
  2. Scanning the QR in Settings > Connect a phone pairs; the phone appears under Paired phones.
  3. Home shows hp's and mini's sessions; starting a session on the desktop makes it appear within a few seconds.
  4. Opening a session shows the terminal; typing, Ctrl-C, arrows and swipe scrolling work; quick replies appear for a waiting agent.
  5. With the app closed, an agent finishing produces a notification; tapping it opens that session.
  6. Turning Meshnet off shows "Can't reach ... Is Meshnet on?"; turning it on recovers without restarting the app.
  7. Removing the phone in Settings shows "This phone was signed out" in the app and one notification.
- [ ] **Step 4: Commit** `git commit -m "Yardbell 0.11.107"` (only with the person's approval, as for every commit), then follow the normal release steps, uploading the apk with `mobile/scripts/build-apk.sh --upload`.

The Tauri `android/` app is removed in a follow-up once the person confirms 0.11.107 works on their phone.
