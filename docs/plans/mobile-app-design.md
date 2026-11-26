# Yardbell mobile app: native React Native app modelled on Orca's

Status: design, awaiting approval. Date: 2026-11-26.

## Intent

Replace the current Android app with a separate native phone app, modelled on Orca's phone app
(`~/Projects/orca/mobile`), so the person can do everything in Yardbell from their phone, not
only watch it.

Today's app (`android/`) is a Tauri shell of about 1,000 lines. It pairs by QR, signs in, and then
loads the server's own web pages in one WebView. Since 0.11.105 those pages are the desktop React
app (`/ui/`), which was never laid out for a phone. Orca's phone app is a real React Native app with
screens built for touch, and that is the experience wanted here.

## Goals

- A native Android app in React Native (Expo) with phone screens of its own.
- Everything the person does in Yardbell can be done from the phone: see machines and sessions,
  drive a session's terminal, answer waiting agents, start sessions, use Dispatch, read the inbox,
  review changes, browse files, pipelines, reviews, usage, settings, voice dictation.
- Look and feel follow Orca's phone app, adapted to Yardbell's features and brand.
- It replaces the Tauri Android app and installs over it as an update.

## Non-goals

- iOS. Android only for now. The project should not do anything that blocks an iOS build later
  (no Android-only libraries where a cross-platform one exists, native code kept in Expo modules).
- Reaching the server without the mesh VPN. No relay, no tunnel service, no cloud push.
- Orca features with no Yardbell counterpart (bots, browser pane, accounts, automations, app move).
- Rewriting the desktop web app.

## Anti-goals (fails even if it works)

- The desktop web pages shown in a WebView with a phone skin. That is today's app.
- Orca's name, logo, icons, notification sounds or other branding in the app.
- Anything that needs a cloud service run by us or a third party for the app to work.
- A first release that does less than today's app: pairing, seeing sessions, typing into a
  terminal and notifications must all work in step 1.

## Constraints

- **Network:** the server is reached over the mesh VPN (NordVPN Meshnet), the same as today. The
  pairing QR carries the server's mesh address (`src/web/settings_api.rs`, `pair`). All the
  person's devices are on that network.
- **Licence:** Orca is MIT (`docs/plans/orca-style-ui.md`, section 1). Code may be copied and
  adapted. Keep Orca's copyright and permission notice with substantial copied portions, add the
  app's dependencies to `THIRD_PARTY_NOTICES.md`, and put a one-line provenance header in files
  copied mostly as-is. Do not copy Orca's name, logo, icons, notification sounds or bot artwork.
- **Upgrade in place:** the new apk must keep the application id `dev.yardbell.android`, be
  signed with the existing release keystore (`~/.local/android/release/yardbell-release.jks`),
  and have a `versionCode` higher than the Tauri app's last one (Tauri derives it from the
  version: 0.11.106 gives 11106). Otherwise Android refuses the update and the person must
  uninstall first.
- **Pairing after the update:** the person scans the pairing code once more after the new app
  installs ("pair again is fine"). The new app does not read the Tauri app's saved cookies, and
  the server needs no route to swap a cookie for a token. On first launch with no paired server,
  the app opens straight to pairing.
- **Build:** apks are built locally on hp, not in CI (see `~/.local/android/build-apk.sh`). The
  toolchain there has JDK 17, Android SDK 35 to 37 and NDK 27. Node 26 is installed.
- **Releases:** the app version follows the Yardbell version (0.11.x), and the apk is attached
  to the GitHub release as today (`Yardbell_<version>_android.apk`).
- **Server compatibility:** a phone may talk to a server one release older or newer. New server
  routes must not break the current Tauri app until it is retired, and the new app must say
  plainly when a server is too old for it.
- House rules: no em dashes in any text, no "Orca" in commit messages, settings for every new
  option live in the Settings UI, not only in yml.

## Approaches considered

| | Approach | Trade-offs | |
|---|---|---|---|
| A | React Native (Expo) in a new `mobile/` folder, structured like Orca's app | Native feel (gestures, sheets, keyboard). Can adapt Orca's screens and its terminal setup directly. Can ship iOS later. Costs a new Node and Expo toolchain and a new apk build step, and retires the Tauri app. | **Chosen** |
| B | Keep the Tauri Android shell, write new phone screens in React inside it, sharing code with `web/` | Least new tooling, release flow unchanged. Still a WebView, so gestures, keyboard and notifications stay weaker. Does not match what was asked. | Rejected |
| C | Fully native, Kotlin (and Swift later) | Two codebases eventually, nothing copied from Orca. | Rejected |

The person chose A: "go with react native like orca".

For reaching the server from another network, three options were weighed: keep the mesh
requirement, run our own relay like Orca's (`orca/cloud`), or use a tunnel service. The person
chose the mesh: "keep mobile works on mesh like the old one since all my devise on that network".

## What the server already has

The app can start on routes that exist today:

- `GET /state`: JSON snapshot (`StateView` in `src/state.rs`: agents, machines, folders, sessions,
  ended sessions, server, proposals count).
- `GET /state/live`: WebSocket that signals state changes.
- `GET /term/{machine}/{name}/ws`: terminal stream for a session. Frames: `in`, `resize`,
  `scroll` from the client (`src/term.rs`).
- `POST /sessions`, `POST /sessions/{machine}/{name}/stop`, `/sessions/{machine}/{name}/keys`.
- Dispatch: `/dispatch/conversations`, `/dispatch/conversations/{id}`, stop, delete, tasks,
  reviews, usage.
- Changes, files, pipelines, reviews, insights and settings APIs under `src/web/*_api.rs`.
- Pairing: `POST /api/settings/pair` makes a QR with `yardbell://pair?server=...&code=...`, and
  `POST /app/pair/{code}` redeems it for a login cookie (`src/web/mod.rs`, `pair_redeem`).
- Notifications: the server keeps a phone inbox (`src/phone/`), and the app long-polls
  `GET /app/notifications`. Today a Kotlin foreground service in the Tauri app
  (`android/gen/android/app/src/main/java/dev/yardbell/android/NotifyService.kt`) keeps that
  poll open per signed-in server and shows Android notifications. There is no push service, by
  design, because the server is only reachable over the mesh.

## Server gaps to fill

1. **Device sign-in.** Pairing returns a browser cookie today. Add a device token: redeeming a
   pairing code returns a long-lived bearer token tied to a named device, accepted by the API and
   WebSocket routes in an `Authorization` header. Settings lists paired devices and can revoke
   one. The cookie path stays for the Tauri app until it is retired. Passcode sign-in from the
   app also returns a device token. Tokens do not expire; they end only when revoked (builder's
   call, made so the notification service never has to refresh one). When a revoked token is
   used, the server answers 401, the app shows "this phone was signed out" with a Pair again
   button, and the notification service stops polling that server and posts one notification
   saying so.
2. **WebSocket origin check.** `term::origin_ok` rejects a request without an `Origin` header that
   matches `Host`. A native client sends none. Requests that carry a valid device token must be
   accepted without an Origin; cookie requests keep the check (it protects against cross-site
   WebSocket hijacking, which a bearer token is not exposed to).
3. **JSON for page-only actions.** Audit what the desktop app does through form posts or HTML and
   add JSON routes where the phone needs them. Done per screen as each step needs it.
4. **Version handshake.** A small route (or a field on an existing one) giving the server version
   and an API level, so the app can tell the person to update the server, or itself.

## The app

### Stack (builder may adjust within these)

- Expo with Expo Router, React Native, TypeScript, matching Orca's choices and versions where
  practical (`orca/mobile/package.json`): `react-native-webview` for the terminal,
  `@tanstack/react-query` for server data, `expo-camera` for QR scanning, `expo-notifications`
  for showing notifications, `expo-secure-store` for device tokens.
- Built with `expo prebuild` plus Gradle on hp (no EAS, no cloud build).
- Native code (the notification service) as a local Expo module, not hand-edited generated files.

### Connection

- One host for now in practice, but the data model keeps a list of paired servers, as today's app
  does (`android/src/store.rs`). Home merges them (builder's call): one connection and state store
  per server, combined into one list, with "Needs you" gathered from every server. A server
  heading appears above its machines only when more than one server is paired.
- Each server has a list of candidate addresses. Step 1 has one: the mesh address from the QR.
  The connection layer tries candidates and keeps the first that answers, like Orca's
  `pairing-candidate-race.ts`, so a relay or LAN address can be added later without changing
  screens.
- Reconnects on its own when the app returns to the foreground or the network changes, and shows a
  calm connection state (connected, reconnecting, unreachable with "is Meshnet on?").

### Notifications

- Keep the long-poll model. Port `NotifyService.kt` into a local Expo module that runs the same
  foreground service, polling `/app/notifications` per paired server with the device token.
- Tapping a notification opens the session or screen its `click` link names.
- Firebase push is out of scope (it would need a cloud path the mesh-only design avoids).

### Screens

Modelled on Orca's phone app (`orca/mobile/app`, `orca/mobile/src/home`, `src/session`,
`src/terminal`). Navigation: a bottom tab bar (Home, Dispatch, Inbox, More) and stack screens.

```
┌ Yardbell ──────────── ⚙ ┐
│ Needs you (2)            │
│  ● fix-webhooks  hp  ⏳  │
│  ● api-tests     mini ⏳ │
│ hp                       │
│  ● orca-style-ui  busy   │
│  ○ yardbell       idle   │
│ mini                     │
│  ○ notes          idle   │
├──────────────────────────┤
│ Home Dispatch Inbox More │
└──────────────────────────┘
```

1. **Pairing and onboarding.** Scan the QR from Settings > Connect a phone, or enter a server
   address and passcode. Also opens from a `yardbell://pair` link.
2. **Home.** Machines as parents with their sessions under them, a "Needs you" group at the top
   for sessions waiting on the person, live status from `/state/live`.
3. **Session.** Full-screen terminal in a WebView running xterm.js, following Orca's terminal
   setup (`orca/mobile/src/terminal`). A key bar (Esc, Tab, arrows, Ctrl, common shortcuts), quick
   replies for a waiting agent, stop, and session details.
4. **New session.** Machine, folder, agent, branch, the same choices as the desktop dialog.
5. **Dispatch.** Conversations list, conversation view with the composer, tasks and runs.
6. **Inbox.** The server's notifications, newest first, each opening its target.
7. **More.** Changes and diffs with commit, file browser and preview, pipelines, reviews, usage,
   settings (appearance, terminal, notifications, paired servers, about with licence notices).
8. **Voice dictation** in the composer and the terminal, using the server's voice route as the
   desktop app does.

Theme: Yardbell's own colours and the "yard of machines" icon, in Orca's layout and spacing.
Light and dark, following the system.

## Delivery order

Each step ships in a Yardbell release.

1. **Replace the current app.** Server: device tokens, origin rule, version handshake. App:
   pairing, Home, Session terminal with key bar, notifications service, connection handling.
   Release build installs over the Tauri app and keeps working. The Tauri app's source stays in
   the repo until this step is released and confirmed on the phone, then is removed.
2. **Act from the phone.** New session, Dispatch (conversations, composer, tasks), Inbox.
3. **Everything else.** Changes and commit, files, pipelines, reviews, usage, settings, voice.

## Testing

- Server: Rust tests for device tokens (issue, use, revoke, revoked token refused), the origin rule with and
  without a token, and the version route, alongside the existing tests in `src/web/tests.rs`.
- App: unit tests with Vitest for the connection layer, state mapping and stores, as Orca does.
  A mock server script for screens, as Orca's `scripts/mock-server.ts`.
- On device: each step is installed on the person's phone against the real server on hp before
  release. Pairing, typing in a terminal, a notification arriving while the app is closed, and
  reconnect after toggling Meshnet are checked by hand.

## Left to the builder

- Exact library versions, folder layout inside `mobile/`, state management details.
- Which Orca files to adapt and which to rewrite, as long as the notices are kept.
- The token format and storage on the server, as long as tokens can be revoked and are not stored
  in plain text.
- The key bar's exact keys and the quick reply set.
- How the release workflow and `build-apk.sh` change to build the Expo app.
