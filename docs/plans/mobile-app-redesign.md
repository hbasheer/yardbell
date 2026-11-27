# Phone app redesign: copy Orca's mobile look

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the phone app built in step 1 works, but it does not look or feel like Orca's mobile app. Rebuild every
screen with Orca's components, tokens, icons, sheets and menus, so it reads as the same app family.

**Architecture:** port Orca's theme and shared components into `mobile/src/ui/` (adapted from
`~/Projects/orca/mobile/src`, MIT, notice already in `THIRD_PARTY_NOTICES.md`), then rebuild each screen on top of
them. The data layer from step 1 (API client, live socket, terminal socket, notifications module) stays.

**Tech stack:** Expo SDK 58, RN 0.88.1, Expo Router, plus Orca's UI deps: lucide-react-native, react-native-svg,
react-native-reanimated 4.7.1 + react-native-worklets 0.13.0, react-native-gesture-handler ^3.3.0, expo-haptics,
expo-image-picker, @react-native-async-storage/async-storage.

**Spec:** `docs/plans/mobile-app-design.md` (the app), and `docs/plans/mobile-app-orca-survey.md` (every Orca
screen, control and value, with file paths). The survey is the visual authority: when a task says "as Orca", the
survey section it names and the Orca file it cites decide the exact values.

## Global Constraints

- Copy, don't reinterpret. Each component starts from the Orca file the survey names, trimmed of features Yardbell
  cannot back (survey 12.2). Keep Orca's values: palette (survey 2.1, 2.2), radii 12/16/24/pill, spacing 2/4/8/12/16/24,
  NavBar 52, round nav buttons 36 with 18 px icons, key caps 32 high radius 12 mono 13/500.
- Every control in an Orca surface is either built or listed under "Not built" in that task's report with the
  reason. No silently dropped menus, sheets or empty states.
- System font for UI, as Orca. Icons only from lucide-react-native. No `Alert.alert` for confirms: ConfirmModal or
  ActionSheet.
- Dark and light both work, following the system or the choice in Settings > Appearance.
- Machines stay the top parent: Home lists machines, a machine screen lists its sessions grouped by project.
  With several servers, a machine row says which server it is on in its subtitle.
- Android only. Phone layout only (no tablet split).
- No em dashes in any user-visible text. Never write "Orca" in commit messages. No co-authored or generated-by
  lines in commits.
- Unit tests in Vitest for every pure module (grouping, mapping, key definitions, stores). Screens are checked by
  the web preview (Task 1) and on the phone.
- Version stays 0.11.107 (not yet released).

## Review Focus

1. Several servers paired, one unreachable: Home shows its machines as unreachable with the server's address, and
   the others keep updating.
2. A machine with 0 sessions, and a machine that is down: machine screen shows Orca's empty and offline states,
   not a blank list.
3. Keyboard up on the session screen: key row and live input ride above the keyboard, the terminal shrinks, and
   the dismiss-keyboard key appears.
4. Light mode on every screen: no dark-only literal colours left (grep for `#` literals outside `src/ui/theme`).
5. Long names (folder, branch, machine) truncate with an ellipsis and never push buttons off screen.

---

## Mapping (decided)

| Orca | Yardbell |
|---|---|
| Home > Feed tab | Feed: **Needs you / Working** section (up to 3 rows, "See all"), **Machines** group (one row per machine across all servers, plus "Pair a server" row), empty hero when nothing is paired |
| Home > Agents tab | **Sessions** tab: every session, search, group by Status / Machine / Project / Agent |
| Home > Usage tab | **Usage** tab: `/api/usage/stats` per agent limit meters, as the web Usage card |
| Bots, Automations tabs | not built (no backing; Automations may come with pipelines in step 3) |
| Home gear | Settings |
| Home FAB | New session sheet |
| Host row long-press | Reconnect, Copy address, Forget server (ConfirmModal) |
| Host screen | **Machine screen**: PageTitle (machine name, dot, server), sections by project folder, session rows as Orca workspace rows (state glyph, folder name, PR badge from `pull`, ticket chip, branch mono 11, agent line), BottomSearchBar with options (group by, show stopped) and + (new session on this machine) |
| Workspace row long-press | Open, Open PR (if any), Copy branch, Copy path, Stop session (destructive, ConfirmModal) |
| Session screen | bgPanel chrome, NavBar (back, centred title + status line, ⋯), tab strip where **tabs are the sessions on the same machine** (swipe to step, count cell opens the Tabs sheet, + opens New session on this machine), terminal, command dock |
| Session ⋯ menu | Session details (card), Open PR, Text size, Stop session |
| Tab action sheet | Rename not built; Clear terminal (sends Ctrl+L), Stop session |
| Smart keys | Yardbell's quick replies (Yes / Always / No, numbered choices) in Orca's smart key group look |
| Live input + attach + mic | Live input sends typed text to the terminal; attach uploads a photo through `POST /sessions/{m}/{n}/upload` and types its path; mic not built (no capture pipeline) |
| Settings | Servers (list, Forget, Pair another), Appearance (System / Light / Dark), Terminal (font size, font family), Notifications (on/off per server, test), About (versions, links), Licences |

Not built, with reasons (survey 12.2): bots, accounts, rename/pin/sleep/mute/status columns, read/unread and
time-ago (no timestamps or read state in `SessionView`), browser/note/file tabs, split panes, chat view, file
explorer and source control panels (step 3), dictation, relay pairing states, tablet layout.

---

### Task 1: Tokens, dependencies and a web preview

**Files:** `mobile/package.json`, `mobile/babel.config.js`, `mobile/src/ui/theme/*` (palette, radii, spacing,
typography, feedback, `useTheme()`, `themedStyles()` helper), replace `mobile/src/theme/colors.ts` users,
`mobile/scripts/preview-server.mjs` (mock Yardbell API: two servers, three machines incl. one down, sessions in
every state with PR, ticket and branch), `mobile/package.json` script `preview`.

- [ ] Add the UI deps at the survey section 1 versions; reanimated babel plugin; react-native-web + react-dom for
      the preview only.
- [ ] Port `src/theme/mobile-theme.ts` (both palettes, radii, spacing, typography, feedback) and its scheme
      switching, plus an Appearance override read from async storage.
- [ ] Test: palette has the same keys in dark and light; `resolveScheme('system'|'light'|'dark', systemScheme)`.
- [ ] `npm run preview` serves the app on web against the mock API so each later task can screenshot its screen
      in headless Firefox at 400x860 (the terminal WebView shows a placeholder on web).
- [ ] Commit.

### Task 2: Shared components

**Files:** `mobile/src/ui/` : `NavBar`, `NavBarButton`, `PageTitle` (scroll-linked title fade), `StatusDot`,
`AgentGlyph` (working ring, needs-you question icon, idle dot, stopped red; survey 2.4), `ListGroup`, `ListRow`,
`SectionHeader`, `BottomDrawer`, `SheetHeader`, `ActionSheet`, `ConfirmModal`, `PullDownMenu`, `StateView`
(loading, offline, error, empty, no matches), `BottomSearchBar`, `SearchField`, `Fab`, `TabBar`, `SwipeCell`,
`haptics.ts`.

- [ ] Each component is adapted from the Orca file named in survey sections 4 to 7, keeping values and animation
      timings; strip i18n, RPC and features in 12.2.
- [ ] Tests for pure parts: PullDownMenu placement (flips above in the lower half, edge inset 8), tab-bar badge cap
      "99+", agent glyph choice from activity.
- [ ] A preview page `/_gallery` (dev only) renders every component in both schemes; screenshot both.
- [ ] Commit.

### Task 3: Data shapes and grouping

**Files:** `mobile/src/state/types.ts`, `mobile/src/state/views.ts` (new), tests.

- [ ] Widen `SessionView` with `ticket`, `pull` (forge, number, url, title, state, draft, ci, mergeable), `path`,
      `cwd`, `worktree`, `stopped`; keep unknown fields tolerated.
- [ ] `feedSections(servers)`, `machineRows(servers)` (server label only when more than one server),
      `machineSections(machine, groupBy, query)` (by project folder, then Needs you / Working / Idle order inside),
      `sessionsTab(servers, groupBy, query)`, `siblingTabs(server, machine, current)` (same order as the machine
      screen), `prBadge(pull)` (state colour key + `#number`).
- [ ] Tests for each, including two servers with the same machine name, empty machine, down machine, search
      matching folder, branch, ticket and agent.
- [ ] Commit.

### Task 4: Home

**Files:** `mobile/app/index.tsx` (Home host), `mobile/src/home/*`, remove `app/(tabs)`.

- [ ] Home as Orca survey section 4: SafeArea top, tab content, Fab, TabBar with Feed (`LayoutList`), Sessions
      (`SquareTerminal`, badge = sessions needing you), Usage (`Gauge`). Tabs mount on first visit and stay
      mounted; Back returns to Feed first.
- [ ] Tab header 22/700 with Settings gear (and search plus options on Sessions).
- [ ] Feed: Needs you / Working section with "See all", Machines inset group with machine rows (30 px tile with
      `Monitor`/`Server` icon, corner connection dot, subtitle "Connected · 3 sessions, 1 needs you" or the
      problem, amber count pill, chevron), "Pair a server" row, empty hero with 3 numbered steps and the blue
      Scan button. Pull to refresh.
- [ ] Machine row long-press: haptic plus ActionSheet (Reconnect, Copy address, Forget server with ConfirmModal).
- [ ] Session rows as Orca agent rows: glyph column, folder title 15, preview line (state word coloured, then
      branch or ticket), footer with agent name and machine.
- [ ] Sessions tab: SearchField, group-by PullDownMenu (Status, Machine, Project, Agent), sections, empty states.
- [ ] Usage tab: per agent tightest limit meter and reset time from `/api/usage/stats`, per machine memory; empty
      and offline states.
- [ ] Screenshots of Feed, Sessions, Usage, empty hero, in both schemes.
- [ ] Commit.

### Task 5: Machine screen

**Files:** `mobile/app/machine/[server]/[machine].tsx`, `mobile/src/machine/*`.

- [ ] NavBar (back, ⋯ with Reconnect, Copy address, Forget server), PageTitle (machine name 24/700, StatusDot +
      server and state line, Reconnect text button on outage), banners, SectionList by project with Orca section
      headers (collapsible, count), workspace-style rows (survey 5.4), BottomSearchBar (`SlidersHorizontal`
      options sheet: group by Project / Status / Agent, show stopped; `Plus` new session on this machine).
- [ ] Row long-press ActionSheet: Open, Open PR, Copy branch, Copy path, Stop session (ConfirmModal).
- [ ] States: loading, machine down ("Waiting for hp", reason, Reconnect), no sessions, no matches.
- [ ] Home machine rows open this screen. Screenshots.
- [ ] Commit.

### Task 6: Session chrome, tabs and menus

**Files:** `mobile/app/session/[server]/[machine]/[name].tsx`, `mobile/src/session/*`.

- [ ] bgPanel chrome with NavBar: back, centred title (folder) with StatusDot + "agent · branch" line that opens
      the details card (path, machine, server, PR title and link, ticket), ⋯ PullDownMenu (Session details, Open
      PR, Text size, Stop session).
- [ ] 44 px tab strip: current cell (glyph, agent mark, folder), swipe left and right to the sibling sessions with
      Orca's pan values, count cell with needs-you dot opening the Tabs sheet (sections Needs you / Working /
      Everything else, current marked with a blue check), + cell opening New session on this machine.
- [ ] Tab long-press ActionSheet: Clear terminal, Stop session.
- [ ] Swapping tabs reuses the terminal WebView and switches its socket (no remount flash).
- [ ] Screenshots (terminal placeholder on web).
- [ ] Commit.

### Task 7: Command dock and terminal look

**Files:** `mobile/src/terminal/keys.ts`, `KeyRow.tsx` (replaces `KeyBar.tsx`), `SmartKeys.tsx` (replaces
`QuickReplies.tsx`), `LiveInput.tsx`, `customKeys.ts` (async storage), `mobile/terminal/main.ts`.

- [ ] Key row as survey 6.8: dismiss-keyboard key while the keyboard is up, Paste, Esc, Tab, Shift/Ctrl/Alt latch
      (armed, locked), Enter, Shift+Tab, Space, Backspace (repeat on hold), Del, arrows, Ctrl+C, Ctrl+D, Ctrl+L,
      Ctrl+Z, Ctrl+R, Ctrl+A, Ctrl+E, Ctrl+W, Ctrl+U, custom keys (long-press deletes), + to add a custom key.
- [ ] Smart group with the quick replies when the agent asks; accept key filled surfaceBright.
- [ ] Live input row: mono field "Live input" sending text straight to the terminal, attach button (photo library;
      long-press file picker) uploading and typing the path, no mic.
- [ ] Terminal: Tokyonight theme in both schemes, 13 px, font family from Settings > Terminal (bundle Geist Mono
      and JetBrains Mono woff2 into the terminal page as Orca does).
- [ ] Tests: key definitions to bytes (latch combos, Ctrl letters, arrows), custom key store.
- [ ] Commit.

### Task 8: New session sheet

**Files:** `mobile/src/new-session/*`, `mobile/src/api/client.ts` (`newSession`).

- [ ] BottomDrawer as Orca's New Tab and new workspace sheets: machine (preset when opened from a machine or
      tab), folder from the machine's recent and project folders, branch (stay, pick, or new branch which makes a
      worktree), agent tiles grid from the server's agents list, Start. `POST /sessions` with the existing
      `NewSession` body.
- [ ] Opens from Home FAB, machine screen +, and session tab +. On success, opens the new session.
- [ ] Errors shown inline in the sheet. Tests for the request body built from choices.
- [ ] Commit.

### Task 9: Pairing, sign-in and Settings

**Files:** `mobile/app/pair.tsx`, `sign-in.tsx`, `signed-out.tsx`, `mobile/app/settings/*`, `licences.tsx`.

- [ ] Pair as survey 8.1: back button, 3 numbered steps ("Open Yardbell on your computer", "Go to Settings >
      Connect a phone", "Scan the code"), rounded camera card with corner reticle and decode squeeze, "Sign in
      with the passcode instead" ghost button, connecting spinner then green check, errors with Try again.
      Confirm view as survey 8.2.
- [ ] Sign-in and signed-out in the same frame and button styles.
- [ ] Settings as survey 9: NavBar + ListGroups. Servers, Appearance, Terminal, Notifications, About, Licences.
- [ ] Screenshots. Commit.

### Task 10: Build, device check, notices

- [ ] `THIRD_PARTY_NOTICES.md`: add the new deps and their licences; keep the Orca notice.
- [ ] Rebuild the apk with `mobile/scripts/build-apk.sh`, serve it over Meshnet, user installs over 0.11.107 test
      build and checks every screen in both schemes, plus the 7 step 1 checks again.
- [ ] Commit.
