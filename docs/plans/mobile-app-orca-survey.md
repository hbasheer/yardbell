# Orca mobile app: design inventory and Yardbell gap analysis

Source surveyed: /home/hbasheer/Projects/orca/mobile (app/, src/). Yardbell side: /home/hbasheer/Projects/yardbell-worktrees/orca-style-ui/mobile.

Line-number convention: file:line is exact where I printed a file on its own. Where I printed several files in one command I give the file plus the style key name instead. All values are quoted from the code.

---------------------------------------------------------------------------
## 0. Read this first (things that change how to copy it)

1. **Orca's host screen and session screen are plain React Native components, but in the shipped app they are rendered inside a WebView.** app/h/[hostId]/index.tsx and app/h/[hostId]/session/[worktreeId].tsx mount `MobileWebShellScreen` (a native WebView shell that downloads the desktop's web build and runs the same RN components through react-native-web). The `*.web.tsx` files (app/h/[hostId]/index.web.tsx, session/[worktreeId].web.tsx) just import `HostScreen` and `MobileSessionRouteScreen`. So the look is fully defined by the RN source in src/host-screen and src/session. **Do not copy the shell.** Copy the components. Home, pairing, settings, about, connection-log are true native routes.
2. **There is no bundled UI font.** All UI text uses the platform system font (Roboto on Android). No `expo-font`, no `useFonts`. `typography.monoFamily` is `'monospace'` on Android (src/theme/mobile-code-font.ts:2). The woff2 fonts in assets/fonts (Geist Mono, JetBrains Mono, Fira Code, Symbols Nerd Font Mono, Noto Sans Symbols2) are loaded **only inside the terminal WebView** (src/terminal/fonts/terminal-font-face-css.mjs, terminal-web-document-mount.ts). Geist Mono is one of the terminal font choices, not the app font.
3. **Icons are `lucide-react-native` everywhere** (^1.14.0) plus a few react-native-svg marks (OrcaLogo, GitHub, X in About). Agent logos are PNGs from src/shared/agent-icons. No Ionicons, no Material icons.
4. **Sheets are not a library.** Orca wrote its own `BottomDrawer` (reanimated + react-native-gesture-handler), a `PullDownMenu` (RN Modal + Animated) and `ActionSheetModal`. No @gorhom/bottom-sheet. No expo-router `Tabs`: Home's tab bar is a hand-built component driven by `useState`.
5. **Orca's design language in one line:** near-black neutral palette (#0a0a0a/#171717/#262626), hairline borders, system font at 13/14/15/16 sizes, rounded inset groups (radius 16) on the page, round 36 px nav buttons (grey disc, icon 18), blue (#3276f2) accent only for the create FAB, links and primary CTA, amber for "needs you"/unread badge, orange (#f97316) question mark icon for "waiting on you", spinner ring in yellow (#eab308) for working, green dot (#10b981) for done.

---------------------------------------------------------------------------
## 1. Packages the UI relies on (mobile/package.json)

Runtime: expo ~58.0.22, react-native 0.88.1, react 19.3.0, expo-router ^58.0.29, react-native-reanimated 4.7.1, react-native-worklets 0.13.0, react-native-gesture-handler ^3.3.0, react-native-safe-area-context ^5.10.1, react-native-screens ^4.30.1, react-native-svg 15.16.0, react-native-webview 14.0.1, lucide-react-native ^1.14.0, @tanstack/react-query 5.107.1, @xterm/xterm 6.1.0-beta.336 (+ addon-unicode11, addon-webgl), expo-camera ^58.0.14, expo-clipboard, expo-haptics ^58.0.7, expo-secure-store, expo-notifications, expo-keep-awake, expo-image-picker, expo-document-picker, expo-constants, expo-linking, expo-localization, expo-splash-screen, expo-status-bar, expo-build-properties, react-native-web ^0.21.4 (for the page build), @react-native-async-storage/async-storage ^2.2.0, markdown-it (+footnote, cjk-friendly), lowlight, katex, mermaid, i18next 26.7.2, zod ~4.6.7, tweetnacl, @noble/hashes, react-native-libsodium 1.7.0.

Not used by UI: @gorhom/bottom-sheet, react-native-paper, nativewind, expo-font, expo-blur, FlashList (lists are RN `SectionList`/`ScrollView`/`FlatList`).

Yardbell today has none of: reanimated, gesture-handler, lucide, svg, haptics, async-storage. It has expo-router, screens, safe-area-context, webview, camera, secure-store, react-query, xterm.

---------------------------------------------------------------------------
## 2. Theme tokens (src/theme/mobile-theme.ts)

Single live `colors` object rewritten on scheme change; styles built with `themedStyleSheet`. Comment at :3 says tokens mirror desktop main.css.

### 2.1 Dark palette (mobile-theme.ts:7-102)
| token | value | notes |
|---|---|---|
| bgBase | #0a0a0a | screen background (--background) |
| bgPanel | #171717 | grouped list surface, session chrome (--sidebar) |
| bgRaised | #262626 | nav buttons, chips, pressed rows (--secondary) |
| borderSubtle | rgba(255,255,255,0.07) | all hairlines |
| editorSurface | #1e1e1e | |
| sheetSurface | #171717 | bottom sheet background |
| sheetGroup | #262626 | rows inside a sheet |
| translucentFill | rgba(120,120,128,0.36) | pressed wash, off switch, tile fill on sheet |
| composerSurface | #1f1f1f | text fields, composer, smart key group |
| composerBorder | rgba(250,250,250,0.09) | |
| composerControl | #262626 | round composer buttons |
| floatingCardBorder | rgba(250,250,250,0.16) | |
| choiceBorder | rgba(255,255,255,0.34) | |
| choiceSelectedFill | rgba(134,239,172,0.08) | |
| cardPillFill | #262626 | nav button on a sheet |
| inputBorder | #737373 | text field edge (3:1) |
| chatUserSurface/Border | #262626 / rgba(250,250,250,0.06) | |
| chatForegroundStrong | #e3e3e3 | |
| textPrimary | #fafafa | |
| textSecondary | #acacac | |
| textMuted | #898989 | |
| surfaceBright | #e5e5e5 | filled primary surface, active nav button, send button |
| createActionFill | #3276f2 | floating + button, bottom-bar primary |
| onCreateActionFill / onAccent | #ffffff | |
| accentBlue | #3276f2 | links, selection ring, primary CTA, caret |
| statusGreen | #86efac | connected dot |
| statusAmber | #eab308 | connecting/warning dot, badges, unread bell |
| agentQuestion | #f97316 | "waiting on you" icon |
| agentQuestionText | #fdba74 | "Needs you" word |
| agentQuestionTint | rgba(249,115,22,0.12) | |
| statusRed | #ff6568 | error, unreachable, destructive |
| onStatusRed | #450a0a | dark ink on red fill |
| mergeGreen / onMergeGreen | #16a34a / #fff | |
| statusPurple | #d8b4fe | merged PR |
| gitDecoration Added/Deleted/Modified | #81b88b / #c74e39 / #e2c08d | |
| diff* | GitHub Primer (diffAddedBg rgba(46,160,67,0.15) etc.) | not needed for MVP |
| syntax* | Primer dark | |
| terminalBg | #1a1b26 | Tokyonight, terminal only |

### 2.2 Light palette (mobile-theme.ts:106-180)
bgBase #ffffff, bgPanel #fafafa, bgRaised #f5f5f5, borderSubtle #e5e5e5, sheetSurface #f5f5f5, sheetGroup #ffffff, translucentFill rgba(120,120,128,0.16), composerSurface #ffffff, composerBorder rgba(10,10,10,0.11), composerControl #f5f5f5, inputBorder #737373, textPrimary #0a0a0a, textSecondary #696969, textMuted #696969, surfaceBright #171717, createActionFill #171717 (**the FAB is near-black in light**), accentBlue #225be3, statusGreen #147638, statusAmber #ca8a04, agentQuestion #ea580c, agentQuestionText #c2410c, statusRed #e40014, onStatusRed #ffffff, statusPurple #9333ea, terminalBg #1a1b26 (same in both).

### 2.3 Spacing / radii / type / feedback
- spacing (216-224): xxs 2, xs 4, sm 8, md 12, lg 16, xl 24.
- radii (227-240): control 12 (buttons, fields, key caps), pill 999 (badges, chips, dots, round buttons), surface 16 (cards, groups, menus, sheets contents), floating 24 (composer box, sheet top corners, dialogs), tile 10 (square icon tiles), mark 4.
- typography (247-252): titleSize 18, bodySize 14, metaSize 12, monoFamily.
- feedback (255-258): pressedOpacity 0.7, disabledOpacity 0.4. Row press = background `bgRaised` (grouped rows) or `translucentFill` (sheet rows, menu items).
- hairline = `StyleSheet.hairlineWidth` everywhere except the session chrome and tab strip (1 px).

### 2.4 Status colours that rows use
- Agent glyph slot 12 px (AgentSpinner.tsx, STATUS_SLOT_SIZE): working = 8 px ring, borderWidth 2, colour #eab308, top segment transparent and rotating (WorkingRing in AgentStateDot.tsx:43); done/active = 8 px dot #10b981; failed = #ef4444 dot; interrupted = textMuted; unconfirmed = 8 px dashed ring 1.5, statusAmber; inactive/idle = dot rgba(115,115,115,0.4); monitoring = lucide `Activity` icon #eab308; blocked/waiting/permission = lucide `MessageCircleQuestion` colour agentQuestion (12 px in lists, 10 px in tabs). Smaller variant in AgentStateDot (wrapper 10, dot 6, ring 6 with borderWidth 1.5).
- Connection dot (components/feedback/StatusDot.tsx, 8x8 round): connected statusGreen; connecting/handshaking/reconnecting statusAmber; disconnected textMuted; auth-failed/unreachable statusRed; warning amber.
- PR state colour: merged purple, open green, closed red, draft/unknown muted (WorktreeMetaGlyphs.prStateColor).

---------------------------------------------------------------------------
## 3. Navigation model

- **Root: expo-router `Stack`** (app/_layout.tsx:159-205 region). screenOptions: `headerStyle bgPanel`, `headerTintColor textPrimary`, `headerTitleStyle {fontSize 16, fontWeight 600}`, `contentStyle bgBase`, `headerShadowVisible false`. But **every screen sets `headerShown:false`** and draws its own NavBar. Screens: index (Home), pair-scan, pair, pair-confirm, mobile-onboarding (modal, gestureEnabled false), settings, appearance-settings, terminal-settings, native-chat-settings, browser-settings, voice-settings, notifications, troubleshoot, connection-log, about, h (host group), new-workspace (`presentation:'transparentModal'`, `animation:'none'`, transparent: its drawer is drawn over Home).
- Providers wrap the Stack: RpcClientProvider, OrcaQueryProvider, SideRailProvider, SideSafeArea; StatusBar style flips light/dark from scheme; splash hidden after first Stack layout.
- **Home is one screen with five state-driven tabs** (feed, bots, agents, usage, automations), custom bottom bar; each tab mounts on first visit then stays mounted (display:none when inactive, MobileHomeScreen.tsx:215-267). Android Back from any tab returns to Feed first (:84-95).
- **Host group `/h/[hostId]`** (app/h/_layout.tsx): a nested Stack (HostStack, headerShown false, contentStyle bgBase). On phones the index route is the workspace list, other routes push over it with native slide. On wide layout (width >= 700 and short side >= 600) it becomes a **resizable sidebar (HostScreen embedded) + detail pane**, sidebar width persisted, min detail 320, drag handle 24 px wide. Not needed for a phone-only Android build.
- **Session screen** is a pushed route `/h/:hostId/session/:worktreeId`; Back chevron leaves (after closing the title card if open). Tab switching inside the session is a swipe on the tab cell (not a navigator).
- Sheets: BottomDrawer (modal-like, drag handle, drag to dismiss), PullDownMenu anchored under the `⋯` button, ConfirmModal/ActionSheetModal are BottomDrawers. Transitions: default platform stack animation; Reduce Motion swaps slides for cross-fades.
- Gestures: horizontal pan on session tab cell (activeOffsetX ±12, failOffsetY ±10, flick velocity 600, edge resistance 0.25, settle 250 ms, curve [0.32,0.72,0,1]); swipe rows (SwipeRowActions, action width 84, settle 250 ms); pull-to-refresh on host list; long-press (delay 400 ms) on host rows, workspace rows, agent rows, key-row custom keys, tab cell.
- Orientation: unset ("default"); landscape phone (>=568 wide, short side < 600) moves the session tab strip into the top bar.

---------------------------------------------------------------------------
## 4. Screen: Home (app/index.tsx -> src/home/MobileHomeScreen.tsx)

### 4.1 Frame
`GestureHandlerRootView` > `SafeAreaView edges=['top']` (bgBase) > tab content > FAB > tab bar > sheets. No stack header.

### 4.2 Tab bar (src/home/tabs/MobileHomeTabBar.tsx)
- Always visible at the bottom. `bar`: row, paddingTop 6, paddingHorizontal 4, bg bgBase, top hairline borderSubtle, paddingBottom `max(inset.bottom, 16)`. HOME_TAB_BAR_HEIGHT const 52.
- 5 equal cells: Feed (`LayoutList`), Bots (`Bot`), Agents (`SquareTerminal`), Usage (`Gauge`), Automations (`CalendarClock`). Icon 25 px, strokeWidth 2.2 selected / 1.8 not; colour textPrimary selected, textMuted otherwise. Label fontSize 10.5, weight 500, letterSpacing 0.1, `gap 3`, cell minHeight 44. Press scales the glyph to 0.88 (90 ms in, 160 ms out).
- Badge on Agents (agents needing you) and Bots: absolute top -4, left 20, minWidth 17, height 17, radius pill, bg statusAmber, border 1.5 bgBase, text 11/700 colour #000, "99+" cap, pops in with scale 0.6 -> 1.18 -> 1.

### 4.3 Tab header (MobileHomeTabHeader.tsx)
Row, minHeight 44, paddingLeft 20 (lg+xs), paddingRight 8, title fontSize **22**, weight 700, letterSpacing -0.4, textPrimary. Trailing icon buttons 44x44, radius control 12, icon 21 px colour textSecondary, pressed/active bg bgRaised. Feed has one: Settings (`Settings` icon). Agents tab has search (`Search`), options (`SlidersHorizontal`) etc. A refresh icon spins at 900 ms linear.

### 4.4 Feed tab (MobileHomeFeedTab.tsx)
Order top to bottom inside a ScrollView with paddingHorizontal 16 and bottom padding = 24 + FAB clearance (56 + 16):
1. (Update/move banners, app-update card at the end)
2. **Bots** section (not mappable)
3. **Active** section: heading "Active" + muted count, right-aligned link "See all agents" (blue, weight 500, 14 px); up to 3 agent rows (needs-you first), only when any agent is needs-you or working.
4. **Desktops** section heading + one inset group: one row per paired desktop, then row "+ Pair a desktop" (Plus 18 px accentBlue, label 16 px accentBlue, minHeight 44).
5. **Tasks** section (not mappable)
Loading (host catalog not yet read): only the title row. Empty (no hosts): title row + centred empty state (below).

### 4.5 Section heading (home-list-styles.ts:17-34)
Row baseline-aligned, space-between, gap 12, paddingHorizontal 4, marginTop 20 (first: 4), marginBottom 7. Title fontSize **15**, weight 600, textPrimary. Count: weight 500, textMuted, tabular nums. Aside text 14 textMuted; as link accentBlue weight 500.

### 4.6 Grouped list ("inset group") (home-list-styles.ts)
- `group`: bg **bgPanel (#171717)**, radius **16**, overflow hidden. No outer border.
- `row`: flexDirection row, alignItems flex-start, paddingLeft 16. Pressed bg bgRaised. Disabled opacity 0.45.
- `separator`: hairline, borderSubtle, marginLeft = HOME_ROW_TEXT_INSET (16 + 24 = 40); host rows use tileSeparator marginLeft 16+30+11 = 57; last separator full (marginLeft 16).
- `status` column width 24, height 20, marginTop 9.
- `text`: flex 1, paddingVertical 9. `title` 16/20 textPrimary; `subtitle` 14/18 textSecondary marginTop 1; `detail` 14/18 textMuted marginTop 2.
- `trailing`: row, centred on the row, gap 6, paddingLeft 10, paddingRight 14.
- `countPill`: minWidth 20, height 20, paddingH 6, pill, bg statusAmber, text 12/700 #000.

### 4.7 Desktop (host) row (MobileHomeDesktopRow.tsx)
- Leading **30x30 tile**, radius 10, bg bgRaised, marginTop 9, marginRight 11, containing a lucide machine glyph 17 px strokeWidth 1.8 textPrimary (`Laptop` / `Monitor` / `Server`; default Monitor). **Connection dot on the tile's bottom-right corner**: 10 px dot with 2 px ring in bgPanel, offset -5, colour from statusDotColor.
- Title: host name, 16 px, 1 line.
- Subtitle (14 px textSecondary, 1 line if connected else 2): `<state word> · <machine line>`; state word coloured by severity only when a problem (warning/unreachable/auth-failed), else textMuted. When connected and worktree summary exists, the summary replaces the state word ("3 workspaces, 1 active" style).
- Extra detail lines (14 px textMuted, up to 3 lines): same-network hint, re-pair hint, verdict detail.
- Trailing: amber count pill if agents need you, then `ChevronRight` 16 textMuted.
- Tap: open `/h/:id` (or `/pair-scan` if credential missing; reload if temporarily unavailable). Long-press 400 ms: haptic medium impact + **action sheet**.

### 4.8 Host action sheet (ActionSheetModal in MobileHomeScreen.tsx:294-330; host-list-action-sheet-actions.ts)
Title = host name, message = `<connection path> · <endpoint>`. Actions with lucide icons: **Connect/Reconnect (`RefreshCw`)**, **Disconnect (`PowerOff`, only when live)**, **Network diagnostics (`Activity`)** -> /connection-log, **Edit host (`Edit3`)**, **Remove (destructive, trash)** -> ConfirmModal "Remove Host" / `Remove "{{name}}"? You can re-pair later.` with Cancel + red Remove.

### 4.9 Agent rows (Active section and Agents tab) (src/agents/MobileAgentListRows.tsx, single-file lines accurate)
Row layout (styles 345-370): `text` paddingTop 9, paddingBottom 10, paddingRight 14, gap 3.
1. Left status column (24 wide): AgentSpinner glyph (see 2.4).
2. Title line: title 15/20 textPrimary (600 if unread), baseline row with time-ago text 12 textMuted tabular (right).
3. Preview line (14/19 textSecondary, max 2 lines): optional state word first ("Needs you"-style words in agentQuestionText weight 600, "Failed" in statusRed weight 600) then " · " then tool/last message.
4. Footer line (gap 6): agent logo 13 px (PNG) + `place` text 12 textMuted ("workspace · desktop name") ; right side: unread `Bell` 12 amber filled, workers toggle (chevron + "N workers", 12/500 textSecondary).
- Separator marginLeft 40 + depth*22. An "N idle" fold row (chevron, 14 textSecondary, minHeight 44).
- **Swipe right**: Read/Unread (accentBlue bg, `Eye`/`EyeOff`). **Swipe left**: Clear (textMuted bg, `X`). Action width 84, label 12/600.
- Long-press: agent action sheet (src/agents/use-agent-list-row-actions.tsx).
- Offline desktop tap -> Alert "{{desktop}} is offline / Reconnect it to open this agent."

### 4.10 Agents tab (MobileHomeAgentsTab.tsx)
Header "Agents" with search, host filter pill, options menu (PullDownMenu): Group by (Status / Workspace / Project / Agent / Desktop), Unread only (check), Show worker agents (check), Mark all read (`CheckCheck`), Clear finished (`Trash2`). Search field (MobileSearchField). Sections by group with MobileHomeSectionHeading, per-section Clear. Empty states: "No agents running" + "Start an agent in any workspace and it shows up here." / "Pair a desktop to see its agents here." / "No desktop connected" (`WifiOff`) / `No agents match "query"`; connecting = centred ActivityIndicator small textSecondary.

### 4.11 FAB (MobileHomeFab.tsx)
56x56 round, bg accentBlue (the Home FAB uses accentBlue in both schemes; only the bottom-bar primary button uses createActionFill, near-black in light), `Plus` 26 px strokeWidth 2.4 colour onAccent. Absolute right 18, bottom = tabBarHeight + 16. Shadow black 0.3, radius 10, offset (0,5), elevation 6. Fades/scales in (0.9->1, 220 ms) on Feed only. Disabled (no connected desktop): opacity 0.4 and a hint pill to its left ("Connect a desktop to start new work.", max width 220, 13 px textSecondary on bgRaised, radius pill). Press scales 0.92. Action: new-workspace overlay.

### 4.12 Empty state (no hosts) (MobileHomeEmptyState.tsx)
Centred hero in scroll view (padding 16): OrcaLogo 44 px; title **28/700**, letterSpacing -0.4, centred, marginTop 26, marginBottom 10 ("Connect your desktop"); body 17/24 textSecondary centred; hero marginBottom 34; **NumberedStepsPanel** (3 steps: Open Orca desktop / Scan the code / You're connected); CTA button centred: minHeight 48, paddingH 22, radius 12, bg accentBlue, row with `QrCode` 18 (strokeWidth 2.2) + label 16/600 onAccent, press = scale 0.97 + opacity 0.85. Tap -> /pair-scan.

### 4.13 Usage / Automations / Bots tabs
Usage = per-account usage bars; Automations = host picker pill + scheduled runs + FAB "New automation"; Bots = chat bots. See section 11 for backing.

---------------------------------------------------------------------------
## 5. Screen: Host screen = workspace list (src/host-screen/*)

Layout top to bottom (host-screen-view.tsx, single file, accurate):
1. `SafeAreaView edges=['top']` bg bgBase containing the **NavBar** (below).
2. Banners (animated in/out, `Presence`): AuthFailedBanner (re-pair/retry/remove), diagnostics link after >=3 reconnect attempts, route notice, server notice, action error (failure tone). Offline banner in the list header.
3. **PageTitle** inside the list (scrolls away): host name 24/30, weight 700, letterSpacing -0.3, paddingH 16, paddingTop 4, paddingBottom 12; subtitle row (gap 5): StatusDot + machine line ("Connected" fallback) 12 px textSecondary; a "Reconnect" text button (12/600 textPrimary) appears on outage.
4. **SectionList** of workspace rows grouped into sections (by repo/status/etc.), pull-to-refresh, no sticky headers, hairline separators, bottom padding = bar height + 8.
5. **BottomSearchBar** floating over the list end.
6. Overlays (workspace menus, filter sheet, delete confirm, rename, status picker).
States: loading -> `MobileStateView loading` "Loading workspaces…" (small spinner textSecondary + 14 px message); offline empty -> `WifiOff` icon (24 px, textMuted, strokeWidth 1.75), title "Waiting for {host}", message "Check that the host is awake and Orca is running.", button Reconnect; load error -> `CircleAlert` "Unable to Load" + Retry (+ Details disclosure); empty -> `FolderTree` "No workspaces" or "No workspaces match filters"; search miss -> `SearchX` "No matches" + Clear search.

### 5.1 NavBar (components/nav-bar/NavBar.tsx:1-275, NavBarButton.tsx)
- `chrome`: bg bgBase, bottom hairline borderSubtle. `bar`: height **52**, row, centred, gap 8, paddingH 12.
- Three slots: left `side` (flex 1, flexBasis 0, minWidth 36*2+8) with leading buttons; centre (`maxWidth 62%`, alignItems center) with title (**16/600** textPrimary, 1 line) and subtitle (12 textSecondary, with optional StatusDot, gap 5); right `side` with trailing buttons, justified end. Title is **centred**, not left-aligned.
- Title fades in as the page title scrolls under (`barTitleOpacity` interpolates scrollY over 0.35..0.7 of title height); divider fades in 0.7..1; a 2 px refresh sweep line (segment 28% wide, textSecondary) on the bar's bottom edge while revalidating.
- **NavBarButton**: **36x36 round (radius pill)**, bg **bgRaised**, icon **18 px, strokeWidth 2.1**, colour textPrimary; active = bg surfaceBright with icon colour bgBase; pressed opacity 0.7; disabled 0.4; hitSlop 4; badge top/right -3, 16 high, border 2 bgBase, text 10/700 white. On a sheet it uses cardPillFill.
- Host screen: leading `ChevronLeft` ("Back to hosts") (+ `PanelLeftClose` only in tablet sidebar); trailing `MoreHorizontal` (⋯).

### 5.2 Host ⋯ menu (host-screen-header.tsx, PullDownMenu)
Group 1 (disabled when not connected): Tasks (`List`), Automations (`CalendarClock`), Accounts (`UserCircle`), Shared links (`Link`, bots only), Floating Workspace (`SquareTerminal`, optional). Group 2 (works offline): Edit host (`Edit3`), Network diagnostics (`Activity`).

### 5.3 PullDownMenu (components/nav-bar/PullDownMenu.tsx:1-... single file accurate)
Width **252**, radius **16**, bg **bgRaised**, hairline border borderSubtle, shadow black 0.45 radius 24 offset (0,12), elevation 12; anchored under the button (right-aligned to it, gap 6, edge inset 8; flips above if the button is in the lower half); spring open (stiffness 420, damping 32), scale 0.9->1 from the button's corner, fade-out 150 ms. Items minHeight 44, paddingH 16, gap 12, label **15.5** (tint textPrimary or statusRed), trailing icon 17 px strokeWidth 2 (or `Check` 17 for the checked item, or a status string 12 textSecondary), hairline between items, groups separated by a 6 px bgBase band, pressed = translucentFill.

### 5.4 Workspace row (worktree/row-presentation/WorktreeListRow.tsx + worktree-list-row-styles.ts)
Layout (all from styles file, single-file accurate):
- Row: flexDirection row, flex-start, paddingVertical 12, paddingLeft/Right 16, **borderLeftWidth 2** (transparent; active workspace gets bgPanel + borderLeftColor textSecondary). Pressed bg bgRaised. Dimmed rows opacity 0.6. **No card, no radius: full-width rows with hairline separators inset to text (marginLeft 2+16+20+8 = 46).**
- Left indicator column width 20, paddingTop 6, marginRight 8, gap 4: AgentSpinner (12 px slot) and, if unread, `Bell` 10 px amber filled below.
- Main column: 
  - Name row (gap 8): optional repo chip (16x16, radius 4, hairline border, bgRaised, repo icon 11 px in repo colour), **name 14/600 textPrimary** (700 if unread, flexShrink 1), PR badge (row, gap 3, bg bgRaised, paddingH 5, paddingV 1, pill: PR state icon 10 px + `#123` 10 px in PR state colour), Folder badge (10 px textSecondary on bgRaised pill), meta glyphs (11 px textMuted: `StickyNote`, `CalendarClock`, `SquareTerminal`, `CircleDot` issue, Jira logo, "L" for Linear, `GitMerge`; gap 5), then right-aligned live terminal count (12 textMuted).
  - Meta row (marginTop 2, gap 4): host pill, repo icon + repo name (11 textSecondary, max 100), **branch name 11 px textMuted in monospace, flex 1, ellipsised**.
  - Agent list under the row (marginTop 3): one line per agent: marginTop 3, gap 4, label **11 px textMuted** (textPrimary/600 when workspace unvisited), time-ago 10 px textMuted, small state dot; collapsible summary when >1 agent; lineage children toggle pill (bgRaised, radius 12, 11/600 textSecondary, chevron 12 + `GitBranch` 12).
- Tap opens the session; agent line tap opens that agent's tab; long-press (400 ms, haptic) opens workspace menu.

### 5.5 Section header (host-section-header.tsx, host-screen-secondary-styles.ts:15-47)
Row, paddingLeft 18 (accent 2 + 16), paddingRight 16, paddingTop 16, paddingBottom 6; chevron (`ChevronRight` 12 px textMuted, rotates 0->90deg, in a 20 px column, marginRight 8); optional `Pin` 12 / repo icon 14 / `FolderTree` 12; title **13/500 textSecondary**; count 13 textMuted marginLeft 6; spinner when a collapse is pending. Tap toggles collapse (persisted on the desktop).

### 5.6 BottomSearchBar (components/nav-bar/BottomSearchBar.tsx, single file accurate)
Absolute bottom bar over the list: paddingTop 36, paddingH 12, paddingBottom max(inset,16); **vertical gradient fade** (react-native-svg LinearGradient, transparent at 0 -> opaque bgBase at 0.45) so rows fade under it. Row gap 8: [leading round button] [search field flex 1] [primary round button].
- Round buttons **44x44 pill**, bg bgRaised, hairline border composerBorder, icon 20 px strokeWidth 2.2 textPrimary, shadow black 0.35 r12 offset(0,6) elevation 6; primary is emphasis: bg createActionFill (#3276f2 dark / #171717 light), icon white. Lit (filter active) = border textSecondary + 18 px accentBlue count badge top/right -3 (11/700 onAccent).
- Host list: leading `SlidersHorizontal` (Workspace options, badge = active filters), primary `Plus` (New workspace, disabled unless connected).
- Search field: TextField with leading `Search` 16 textMuted, min height 44, radius pill, same shadow; placeholder "Search"; while searching/keyboard up the leading button slides away (220 ms) and the primary becomes `X` (Close search); bar rides above the keyboard (`bottom: keyboardHeight`, paddingBottom 8).

### 5.7 Workspace row menu (use-workspace-row-menu-actions.ts) - ActionSheet, lucide icons
Source Control (`GitBranch`), Agent Session History (custom icon), Hand off to agent (`MessageSquarePlus`), Rename (`Edit3`), Sleep (`Moon`), Mark Read/Unread (`BellOff`/`Bell`), Mute/Unmute Notifications (`BellMinus`/`BellRing`), Pin/Unpin (`Pin`/`PinOff`), Move to Status (`Kanban`), Hand to bot (`Bot`), Delete / Remove Workspace (destructive; disabled with hint for primary worktree). Delete opens a confirm sheet listing what is lost.

### 5.8 Workspace options sheet
Opened by SlidersHorizontal: group by, sort, filters, card properties (what to show on rows), compact cards, etc. (host-screen/workspace-options/*).

---------------------------------------------------------------------------
## 6. Screen: Session (src/session/*)

Frame (mobile-session-frame-styles.ts:container etc.): container bgBase; `kavInner` flex 1: header chrome, optional warning strip, content row (terminal + dock). Loading state: centred small spinner + "Opening workspace" (14 px).

### 6.1 Header chrome (MobileSessionHeader.tsx, mobile-session-frame-styles.ts)
- `sessionChrome`: **bg bgPanel (#171717)**, bottom border **1 px** borderSubtle, top safe area inside it. (Different from other screens whose bar is bgBase.)
- Row 1 = NavBar (transparent, no border), height 52: leading `ChevronLeft` NavBarButton ("Back to worktrees"; first closes the title card); centre = **title block**; trailing = [Source control button (`MobileSourceControlButton`, PR-state tinted icon)] + `MoreHorizontal` (⋯, active when a panel is open).
- Title block (MobileSessionTitleBlock.tsx): title **16/600 textPrimary** centred (14/600 beside tabs in landscape), under it a meta row (gap 8, marginTop 2) = **StatusDot (8 px, connection state) + 12 px textSecondary line** (terminal summary such as agent/branch status; or bot status). Tapping it opens an anchored **detail card** (full workspace name, path, host with StatusDot). If connection retry is offered, tapping the meta row reconnects.
- Row 2 = **session tab bar** (below), height 44, top border 1 px borderSubtle.
- Refresh line on the chrome's bottom edge while a switched-back terminal catches up.

### 6.2 Tab bar (tabs/MobileSessionTabBar.tsx, single-file accurate)
One row, **height 44**, borderTop 1 px borderSubtle; three cells:
1. **Current tab cell** (flex 1): bg **bgRaised**, bottom border **2 px textSecondary**, right border 1 px borderSubtle; content: agent state dot (AgentStateDot, only when not idle) + tab mark (14 px: agent logo PNG, or lucide `SquareTerminal`/`Globe`/`FileText`/`File` in textSecondary strokeWidth 2.1) + title **14/600 textPrimary**, gap 6, paddingLeft 16, paddingRight 8. **Swipe horizontally to step to previous/next tab** (content slides, fades to 40% opacity at full width). Tap or long-press (haptic) opens the tab action sheet.
2. **Count cell** (width 46): a 19x19 rounded square (radius 6, border 1.8 textPrimary) with the tab count (11/700 tabular); red 9 px dot with 2 px bgPanel ring at its top-right if another tab needs you; amber `Bell` 12 if any unread. Tap opens the **Tabs sheet**.
3. **+ cell** (width 46): `Plus` 18 strokeWidth 2.2 textPrimary; opens the New Tab sheet; disabled when disconnected.
Cells separated by 1 px right borders; pressed bg translucentFill.

### 6.3 Tabs sheet (MobileSessionTabsSheet.tsx)
BottomDrawer. SheetHeader: title "N tabs", subtitle workspace name, trailing `Plus` NavBarButton. Sections "Needs you" / "Working" / "Everything else" (13/500 SectionHeader, shown only if >1 section) each in a ListGroup (bg sheetGroup radius 16, separator inset 16+34+12). Row: minHeight 52, paddingH 16, paddingV 8, gap 12, bg sheetGroup; **34x34 tile** (radius 10, bg translucentFill) holding the tab mark (17 px) with a state dot or amber bell badge at top/right -4 (2 px ring in sheetGroup); title 15/500; detail line 13 textSecondary (state word coloured agentQuestionText or statusRed, then " · " then content); time-ago 12 textMuted; current tab = `Check` 18 accentBlue strokeWidth 2.6. **Swipe left = Close (statusRed bg, `X`)**. Split panes nest with a `CornerDownRight` 14.

### 6.4 Tab action sheet (terminal) (terminal/session/tab-actions/mobile-terminal-action-sheet-actions.ts)
Header with tab mark tile + kind label. Actions: chat view toggle, **Switch to Desktop/Phone** (`Monitor`/`Smartphone`), **Rename** (`Pencil`), **Clear Terminal** (`Eraser`), worker auto-close options, **Close Tab** (`X`, destructive group), bulk close options.

### 6.5 New Tab sheet (MobileNewTabSheet.tsx)
SheetHeader "New Tab" + workspace subtitle + close X. "Agents" section: Chat/CLI segmented control + a **grid of agent tiles** (logo + name) -> starts that agent; then a ListGroup "Terminal" (`SquareTerminal` 16), "Browser" (`Globe`), "Note" etc.

### 6.6 Header ⋯ menu (MobileSessionHeaderMoreMenu.tsx) - PullDownMenu with 3 groups
Group 1: File explorer (`Folder`), Source control (`GitBranch`, only when the bar collapses), Checks (`ListChecks`), Agent History, Quick commands (`SquareChevronRight`). Group 2: Terminal layout (`Columns2`), Text size (`ALargeSmall`). Group 3: fork actions, New tab (`Plus`, collapsed bar only).

### 6.7 Terminal pane
WebView xterm (`terminalFrame` flex 1, overflow hidden). Theme = Tokyonight: background #1a1b26, foreground #c0caf5, cursor #c0caf5 (bar cursor, no blink, inactive block), selection #33467c, black #15161e, red #f7768e, green #9ece6a, yellow #e0af68, blue #7aa2f7, magenta #bb9af7, cyan #7dcfff, white #a9b1d6, brightBlack #414868, brightWhite #c0caf5 (terminal/terminal-webview-html/theme.ts). Default font 13 px phone / 15 tablet (terminal-font-defaults.ts), choosable family (Geist Mono, JetBrains Mono, Fira Code, system).
(Yardbell's terminal colours differ: it follows the app scheme and light/dark ANSI sets. Orca uses one fixed dark Tokyonight terminal in both schemes.)

### 6.8 Command dock (MobileSessionCommandDock.tsx, terminal-dock-styles.ts:1-180 accurate)
Bottom, above keyboard (translateY -keyboardLift), **bg bgPanel**, paddingBottom insets.bottom. Two rows:
1. **Key row**: height **46**, row, gap 8, paddingH 8, top hairline borderSubtle, bg bgPanel. Left: a "Dismiss keyboard" key (keyboard icon 15 + `ChevronDown` 10) only while the keyboard is up (pinned, outside the scroller). Then a horizontally scrolling row (gap 8, `keyboardShouldPersistTaps always`):
   - **Key cap**: height **32**, minWidth 34, paddingH 9, **radius 12**, bg **bgRaised**, gap 5, label **13/500 monospace textPrimary**; pressed opacity 0.7; hit slop to 46 tall.
   - Order: (smart-agent group if enabled) display-mode toggle (`Smartphone`/`Monitor` 15), `Paste`, built-ins in order: Esc, Tab, [Shift/Ctrl/Alt latch keys after Tab], Enter, Shift+Tab, Space, ⌫ (repeatable on hold), Del, ↑ ↓ ← → (hidden when a D-pad device), Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+Z, Ctrl+R, Ctrl+A, Ctrl+E, Ctrl+W, Ctrl+U (terminal-key-definitions.ts:111-228), then user custom keys (hairline border composerBorder; long-press deletes), then a `Plus` 15 key "Add custom shortcut". Visible/ordered set is user-configurable (terminal-accessory-layout.ts).
   - **Latch keys** (Shift/Ctrl/Alt): 1 px transparent border; armed = border textPrimary; locked = bg textPrimary with bgBase text. Smart group: pill-ish container (height 40, radius 16, hairline composerBorder, bg composerSurface) with agent words (12/600) and combo (10 mono); primary accept key bg surfaceBright with bgBase text.
2. **Input bar**: row, gap 8, paddingH 12, paddingV 8: a **monospace TextField "Live input"** (min height 44, radius 12, bg composerSurface, 1 px inputBorder #737373, focused = accentBlue border + 1 px outline; leading `Keyboard` icon 17 textSecondary; label 12/600 "Live input" above the text; text 16; placeholder "Tap to show keyboard"), then 38x38 round **attach** button (`ImagePlus` 17, strokeWidth 2.4, bg composerControl; tap = photo library, long-press 350 ms = file picker), then 38x38 round **mic** (dictation, hold or toggle mode). Typed characters are sent straight to the terminal.
   (Orca also has a native-chat composer for agent chat tabs: box radius 24, bg composerSurface, 1 px composerBorder, padding 12, 16/22 text, round 38 px action buttons, send = surfaceBright disc with `ArrowUp` 19. Yardbell has no chat view.)

### 6.9 Other bits
- Warning strip under header (create warning): `AlertTriangle` 16 amber, text, dismiss `X` 16.
- Worker auto-close strip, dictation pill layer, anchored detail card, bot panels (not mappable).
- Right dock panels for File explorer / Source control / Checks: pushed as pages on phone.

---------------------------------------------------------------------------
## 7. Shared sheet components

### 7.1 BottomDrawer (components/bottom-drawer/bottom-drawer-styles.ts, single file accurate)
Backdrop rgba(0,0,0,0.55); drawer bg **sheetSurface**, top radius **24**, paddingHorizontal 12, elevation 8; **grabber 36x5 pill, textMuted at 0.5 opacity**, hit area paddingTop 8, paddingBottom 12; show 480 ms / hide 300 ms on curve [0.32,0.72,0,1]; drag handle (and content when `dragContentToDismiss`) to dismiss; bottom extension of 500 px in sheet colour hides overscroll gaps.
### 7.2 SheetHeader (nav-bar/SheetHeader.tsx)
Height 52, paddingH 4; centred title + subtitle; sides 84 wide (36+8 when a single round button); leading text action (Cancel/Reset) or back chevron; trailing bold text action ("Done") or up to two round NavBarButtons, or `X` close.
### 7.3 ActionSheetModal / ListGroup / ListRow (sheets/ActionSheetModal.tsx, list/ListGroup.tsx single-file accurate)
- Header: title 13/500 textSecondary, message 12 textMuted; or "subject header": 34x34 tile (radius 10, translucentFill) + title 16/600 + message 13.
- `ListGroup`: bg sheetGroup, radius 16, hairline separators from LIST_LEADING_INSET = 16 + 24 + 12 = 52 (or 16 without icons); destructive actions optionally in a second group (marginTop 12).
- `ListRow`: **minHeight 48 (60 with subtitle)**, paddingH 16, paddingV 8, gap 12; leading slot 24 wide; title 15 (500 when subtitle), subtitle 13 textSecondary, value 15 textSecondary (max 180), trailing `ChevronRight` 15 textMuted or `Check` 17 textPrimary; destructive title statusRed; accent title accentBlue; pressed bg translucentFill; disabled 0.4.
- `SectionHeader`: 13/500 textSecondary, paddingH 16, paddingTop 16, paddingBottom 6 (first: paddingTop 4); collapsible with `ChevronDown` 15.
### 7.4 ConfirmModal (sheets/ConfirmModal.tsx)
In a BottomDrawer: title 16/700, message 14 textSecondary lineHeight 20; two flex-1 buttons (paddingV 10, radius 12): Cancel bg sheetGroup text textSecondary 14/600; Confirm bg textPrimary with bgBase text; destructive bg statusRed with onStatusRed text.
### 7.5 Inputs / chips / segmented
FilterChip: 32 high pill in a 44 touch box, bg bgRaised, label 14/500, active = 1 px textSecondary border, optional chevron. MobileSegmentedControl, MobileSwitch, MobileSlider exist in components/controls.

---------------------------------------------------------------------------
## 8. Screen: Pairing

### 8.1 pair-scan (app/pair-scan.tsx + src/pair-scan-styles.ts, accurate)
Plain View, bg bgBase, padding 16 plus safe-area top/bottom + 8. Layout:
1. 36x36 back button (radius 12, `ChevronLeft` 22 textSecondary), marginBottom 8.
2. **3 numbered steps** (marginLeft 7, gap 8, marginBottom 16): 22x22 round badge bgRaised with 12/700 textSecondary number + 14 px textSecondary text ("Open Orca on your computer", "Go to Settings → Mobile", "Scan the QR code").
3. **Camera card** flex 1, radius 16, overflow hidden; reticle = four 28x28 corner brackets, 2.5 px, rgba(255,255,255,0.7), radius 4, square size = min(side*0.62, 360); squeezes 6% on decode (SCAN_DECODE_BEAT_MS in pairing-visuals.tsx); Reduce Motion dims.
4. Ghost button "Paste pairing code" (`Clipboard` 16, 14/500 textSecondary, paddingV 8, marginTop 12) -> TextInputModal.
States: no permission -> centred: title 18/600, subtitle 14 textSecondary (max 310), **primary button** (bg textPrimary, text bgBase 14/600, paddingH 24, paddingV 10, radius 12, optional `QrCode` 16), paste link; connecting -> `ActivityIndicator large` then a green 36 px check disc (statusGreen with bgBase `Check` 22) and "Connected"; a `ConnectionLog` card below ("Pairing log"); error -> red 14 px text, Try Again primary + "Paste code instead" secondary.
### 8.2 pair-confirm (app/pair-confirm.tsx, accurate)
Back chevron top-left; centred content (paddingH 8, bottom 48): title 18/600 "Pair with this desktop?", subtitle 14/20 textSecondary max 520, action stack max 360: primary "Pair" (full width, bg textPrimary, 14/600 bgBase, paddingV 10, radius 12) and plain "Cancel". Connecting/error states as above. Android hardware back cancels.
### 8.3 Onboarding (mobile-onboarding, modal) after first pair: notification opt-in etc.

---------------------------------------------------------------------------
## 9. Screen: Settings and About

- settings route -> SettingsMenuScreen (src/settings): `SettingsScreen` = SafeAreaView(top) + **NavBar** (back chevron, centred 16/600 title) + ScrollView (paddingH 16, paddingTop 8, bottom inset+24). Sections are **ListGroups on bgBase pages** (group bg sheetGroup = #262626 in dark, #ffffff in light on a #fff page? see note) with ListRow rows: leading icon 18 px textSecondary, title 15, trailing `ChevronRight`; external links without chevron.
  - Note: on page screens the group uses `sheetGroup` (dark #262626 / light #ffffff) and the page is bgBase (#0a0a0a / #ffffff), so in light mode groups are white on white and rely on separators only.
- Menu items in order (mobile-settings-menu-items.ts): Appearance (`SunMoon`), Terminal (`Terminal`), Chat UI (`MessageSquare`), Browser (`Globe`), Voice (`Mic`), Notifications (`Bell`), Troubleshooting (`Wrench`), About (`Info`). Then app-update section + pending-credential card; then second group: Privacy Policy (`Shield`), Support (`LifeBuoy`).
- Sub screens: Appearance = THEME radio (System/Light/Dark, `selected` check) + USAGE PERCENTAGES radio + language; section titles are uppercase 13/500 textSecondary; footers 13/18 textSecondary paddingH 16 paddingTop 8. Terminal = font family/size/preview, "WHEN YOU LEAVE THE APP" restore options, reset. Notifications, Voice, Browser, Chat UI similar.
- About (settings/about-screen.tsx): centred brand block (OrcaLogo 28, name 22/800, tagline 13 textMuted), one ListGroup with Globe/GitHub/X rows (leading 18), version text 12 textMuted centred, error 12 statusRed.
- Connection log (app/connection-log.tsx): "Network diagnostics" for a host.

---------------------------------------------------------------------------
## 10. Assets bundled
assets/icon.png, adaptive-icon.png, favicon.png, notification-icon.png, splash-icon.png (splash bg #111111, resizeMode contain, app.json:21-24), bot-mascots/*.webp (20), fonts/ (terminal only). Shared agent icon PNGs at ../src/shared/agent-icons. OrcaLogo is an inline SVG path (react-native-svg).

---------------------------------------------------------------------------
## 11. Yardbell's current app (as read)

### 11.1 Structure
- Stack (headerShown false) with: `(tabs)` group, `session/[server]/[machine]/[name]`, pair, sign-in, signed-out, licences. Route guard sends to /pair when no servers.
- **expo-router `Tabs`** with two tabs "Home" and "More"; header **shown by default** (default navigation header with title "Home"/"More"); tabBarIconStyle display none (text-only tabs), labels 14 px with paddingBottom 12, colours from theme. There is no title row of its own and no icons.
- Theme (src/theme/colors.ts): one flat set `background/foreground/muted/mutedForeground/border/accent/accentForeground/idle/busy/waiting/down`. Dark: background #0a0a0a, foreground #f0f0f0, muted #262626, mutedForeground #acacac, border rgba(255,255,255,0.07), accent #404040, busy #eab308, waiting #f97316, down #ff6568. Light: #ffffff/#0a0a0a/#f5f5f5/#696969/#e5e5e5. **No bgPanel, no sheet tokens, no accent blue, no radii/spacing tokens; all styles are inline literals; no shared components.**
- Home (app/(tabs)/index.tsx): ScrollView; one `ServerFeed` per server; ConnectionBanner per server (muted bg, radius 10, 3 px left border down/busy, 14 px text: "Can't reach X. Is Meshnet on?" / "Reconnecting to X..."); sections from `homeSections` = "Needs you" first, then one section per machine; `MachineHeader` (8 px dot, 15/600 title, 13 note); `SessionRow` (full-width flat row, 10 px dot, 16 px folder, 13 px detail "agent · branch · machine", no chevron, no time, no swipe, no long-press). Empty section text "No sessions". No search, no FAB, no pull-to-refresh, no page title, no unread, no PR badge, no ticket.
- More (app/(tabs)/more.tsx): headings uppercase 13/600 mutedForeground; server rows (name, address, red text "Forget" with Alert confirm); "Pair another server" link; About rows (app version, server versions); Licences link.
- Session screen (app/session/...): custom header (View with bottom border 1 px, bg background): text chevron "‹" 18, title 16/600 folder, subtitle 13 "agent · machine", red text "Stop" button (muted bg, radius 8); banner strip (Connecting/Reconnecting/ended) bg muted; WebView xterm; **QuickReplies** chip row (radius 18 pills, 1 px border, primary = foreground fill; words Yes/Always/No or numbered choices + Cancel); **KeyBar** (horizontal scroll, gap 6, paddingH 8, paddingV 6, top border; keys minWidth 44, radius 8, bg muted, 15 px label; Esc Tab Ctrl Alt ← ↓ ↑ → Home End PgUp PgDn; Ctrl/Alt toggle latch inverts colours). No native text input: typing happens inside the xterm WebView. No tab strip, no ⋯ menu, no source control, no details card.
- Pair (app/pair.tsx): left-aligned centred-vertically page padding 24, one line instruction, **square CameraView radius 12**, red error text, accent buttons (radius 8, bg accent #404040, 16 px), underlined "Sign in with the passcode instead" link; confirm view for deep links ("Pair with {address}?"). sign-in and signed-out similar plain forms.
- Terminal colours: follow scheme (dark ANSI set with bg #0a0a0a, cursor white; light set).

### 11.2 Where it differs from Orca (concrete)
Navigation / chrome
1. Orca: no default headers anywhere; every screen has its own NavBar (52 px, centred 16/600 title, 36 px round grey icon buttons). Yardbell: default Tabs header on Home/More, a hand-rolled inline header on the session screen, no header on pair.
2. Orca Home has a 22/700 left-aligned title row with a Settings gear (44 px icon button) and an **icon tab bar** (5 icons with labels 10.5 px, active = white, badge dots) at the bottom. Yardbell has text-only 2-tab bar (Home/More). Orca puts Settings behind the gear, not a tab.
3. Orca has a floating **+ FAB** (56 px blue disc) for new work. Yardbell has none (server supports POST /sessions but the app has no new-session UI).
4. Orca hierarchy is Home -> Host screen (workspace list) -> Session. Yardbell is Home (sessions across all machines, flat) -> Session, with no per-machine screen.
5. Orca uses a bottom drawer/sheet system and pull-down menus; Yardbell uses only `Alert.alert`.

Home list
6. Orca rows sit in **inset rounded groups** (bgPanel #171717, radius 16) with a section heading above each (15/600 + muted count + blue "See all" link), hairline separators inset to the text. Yardbell rows are flat edge-to-edge on the page background with a section header made of a dot + title + note.
7. Orca row: status glyph column (spinner ring for working, orange question icon for waiting, green dot done, grey dot idle), 15 px title, time-ago, 14 px preview line (what the agent is doing/asking, "Needs you" word coloured), footer with agent logo + place; swipe actions; long-press sheet; unread bell. Yardbell row: 10 px dot only (yellow/orange/grey/red), 16 px folder + 13 px "agent · branch · machine", nothing else.
8. Orca machine rows: 30 px tile with machine icon + corner connection dot, 2-line status text, chevron, needs-you pill; long-press sheet (Reconnect, Disconnect, Diagnostics, Edit, Remove). Yardbell: MachineHeader without chevron or actions; servers managed only on More.
9. Orca empty/loading/offline states are centred icon + title + one sentence + one button (`MobileStateView`). Yardbell: bare spinner, "No sessions" text, a banner, and a redirect to /pair.
10. Orca has pull-to-refresh and a persisted search/filter bar at the bottom of the list screens. Yardbell has neither.

Session
11. Header: Orca chrome is bgPanel with centred title + dot + status line, ⋯ menu and source-control button; Yardbell left-aligned text with a red "Stop" text button and no menu. (Stop belongs in a ⋯ menu / tab action sheet as destructive "Close Tab" style.)
12. Orca has a 44 px **tab strip** (current tab cell with swipe, count box, +) directly below the header; Yardbell has nothing.
13. Orca has a **live-input TextField** with keyboard icon, attach and mic buttons below the key row; Yardbell has none (xterm input only).
14. Key row: Orca 46 px row, key caps 32 px high, radius 12, monospace 13/500, bg bgRaised, gap 8, plus Paste, display-mode toggle, latch keys with border/lock states, Ctrl+X shortcuts, custom keys, + button, dismiss-keyboard key. Yardbell: 44 px min-width keys, radius 8, 15 px proportional font, gap 6, fewer keys, no Enter/Space/Backspace/Ctrl+C, no custom keys, no dismiss-keyboard key.
15. Quick replies: Orca puts them in its smart key group (inside the key row, label + combo, primary accept filled with surfaceBright). Yardbell shows a separate chip row above the KeyBar with different shape (pills radius 18, 15 px).
16. Terminal theme: Orca fixed Tokyonight (#1a1b26) for both schemes with 13 px mono (user choice of Geist Mono/JetBrains/Fira/system); Yardbell uses app background and a plain ANSI set.

Pairing
17. Orca scan screen shows 3 numbered steps, a rounded camera card with corner-bracket reticle, "Paste pairing code" ghost button, success check disc and a pairing log; Yardbell shows one text line over a square camera view with no reticle.
18. Orca confirm screen is centred with big primary/secondary buttons; Yardbell similar but with radius 8 accent buttons and no icons.

Theme / components
19. No design tokens for bgPanel (#171717), sheet surfaces, radii (12/16/24/pill), spacing, translucent pressed fill, accentBlue (#3276f2 dark / #225be3 light), statusGreen, hairline. Yardbell `accent` (#404040) as a button colour is not an Orca colour at all; Orca's primary button is `textPrimary` background with `bgBase` text, and CTAs use accentBlue.
20. No icon library; Yardbell uses text glyphs ("‹", arrows). Orca uses lucide stroke icons 15-26 px.
21. No reanimated/gesture-handler, so no swipe rows, sheets, pull-down menus, tab swipe.
22. No haptics.

---------------------------------------------------------------------------
## 12. Yardbell data model limits and the honest mapping

Yardbell data (src/state.rs, mobile/src/state/types.ts): **Server** (paired by address; `ServerView {machine, address, version}`) -> **Machines** (`MachineView {name, up, reason, local}`) -> **Sessions** (tmux). Server `SessionView` also carries `ticket`, `pull` (PullView: forge, number, url, title, state, draft, review, ci, failed[], head, base, mergeable), `pull_why`, `path`, `cwd`, `worktree`, `ports`, `setup`, `stopped`, `review`, `resets`; `StateView` also has `folders` (FolderView machine/label/path/branch/worktree), `ended` sessions, `agents` catalogue, `proposals` count. **The phone's `SessionView` type currently drops ticket, pull, path, cwd, worktree, ports, stopped detail beyond a string, so the app must widen its types before it can show PR badges.** Activity is only `active | idle | blocked`. Per-session extra via GET `/sessions/{machine}/{name}/agent` (agent, state: working/idle/permission/question/blocked/unknown, choices, screen) and POST `keys`, `text`, `stop`, `upload`, plus `move`, `merge`, `task`, `insights`; list sessions via `/state` + live `/state/live`.

### 12.1 Mapping Orca element -> Yardbell
| Orca | Yardbell backing | Notes |
|---|---|---|
| Host (desktop) row on Home | **Machine** (and its owning server) | A paired server may expose several machines. Show machines as the "Desktops" rows (tile icon + dot from `up`/connection); show server address in the long-press sheet header. If one server only, hide the server layer. |
| Host connection dot/verdict | `Connection` (connected/reconnecting/unreachable) + `machine.up/reason` | Reuse words: "Connected", "Reconnecting…", "Can't reach X. Is Meshnet on?". |
| Host long-press sheet (Reconnect/Disconnect/Diagnostics/Edit/Remove) | Reconnect (restart live socket), Forget (existing `forgetServer`), maybe Copy address | No diagnostics log, no edit host. Orca "Remove" = Yardbell "Forget" (destructive, ConfirmModal text). |
| Pair a desktop row + empty state hero | existing /pair flow | Reuse hero + 3 steps ("Open Yardbell on your computer", "Settings > Connect a phone", "Scan the code"). |
| Active section / Agents tab (agent rows) | **Sessions** where `activity` is blocked then active | Row: spinner ring = `active`, orange `MessageCircleQuestion` = `blocked`, grey dot = `idle`, red = `stopped/stale`, green dot only if we add "done". Title = folder, preview line = `/agent` state text or "Needs permission"/"Has a question" (needs a per-session fetch or extend /state), footer = agent name + machine, time-ago not available. "Needs you" = blocked. |
| Host screen (workspace list) | **Machine screen**: sessions on that machine | Sections: group by project/folder (use `folders`, `cwd`, `worktree`), or Needs you / Working / Idle. Row title = folder/branch; PR badge from `pull` (state colour + `#number`), ticket as meta glyph/chip, branch in mono 11 px. Search + filters in BottomSearchBar (client-side). "+" = new session (POST /sessions) pending a UI. |
| Workspace row long-press menu | Stop (POST stop), Move (POST move), Merge (POST merge) for worktree sessions, Open PR (Linking `pull.url`), Copy branch | No Rename/Pin/Sleep/Mute/Mark read/Hand to bot/Move to Status. |
| Session screen | existing session route | Keep xterm WebView, key row, quick replies. |
| Session header title + status line | folder + `agent · branch` with StatusDot from `Connection`/term status | Details card: full path (`path`/`cwd`), machine, server address, PR title. |
| Session tab strip | **One tab only per route.** Optionally treat other sessions of the same machine/folder as tabs (swipe between, count cell, + = new session) | This is a design choice, not existing data. Without it, show a single cell (agent mark + folder) and omit the swipe; count box = number of sessions in this project. |
| ⋯ menu | Stop session, Open PR, Files/Changes (if wired), Text size, Quick commands | Quick commands/Terminal layout/Checks have no backing; Checks could map to `pull.ci`/`failed`. |
| Smart keys / agent keys in key row | `/agent` choices (QuickReplies) | Move into the key row's smart group look (Yes primary filled, Always, No) to match. |
| Live input field + attach + mic | xterm text goes through WebView today; a native TextField can call `term.send`; attach -> POST `/upload` exists; mic -> server has voice, mobile has no dictation | Field and attach are feasible; mic needs work. |
| Settings (8 menu items) | Servers (list, Forget, Pair another), About (versions, licences), Appearance (system/light/dark: not implemented), Notifications (yardbell-notify module exists) | Build SettingsScreen frame; menu = Servers, Appearance, Notifications, About, Licences. |
| About | app version + each server version (already fetched) | |
| Usage tab | server has `/api/usage/stats`, `/dispatch/usage` | Possible later; not in mobile client now. |
| Automations tab | server has pipelines API (`/api/pipelines`, runs) | Possible later; not exposed to the phone client today. |
| Tasks section | tickets (`/api/pipelines/tickets`) and `SessionView.ticket` | Ticket string only today. |

### 12.2 Orca features Yardbell cannot back yet (and why)
- **Bots, bot chat, groups, items, connectors (Slack/Linear/Google/GitHub), Hand to bot**: no such concept server side.
- **Accounts / per-account usage windows and Codex reset credits**: Yardbell has aggregate usage stats, not Orca's account model.
- **Repos/projects as first-class, workspace grouping persisted on desktop, pin, status columns (Move to Status), card property settings, mute list, sleep, mark unread, rename**: no write API; `sessions` are tmux-derived. Folder/project grouping is read-only inference from `folders`/`cwd`.
- **Multiple terminal tabs, browser tabs, markdown note tabs, file tabs, split panes, terminal layout, per-tab phone/desktop display mode**: a Yardbell route is exactly one tmux session. (Phone display mode: the app already sends resize; there is no server-side desktop-size toggle.)
- **Native chat view / transcript UI / chat composer / agent session history / fork / handoff**: server has `transcript_api.rs`, but the phone client has no chat renderer and no resume/handoff API shape; treat as out of scope.
- **File explorer, source control, checks, review, diff panels**: server has files/changes/review/pulls APIs, but none are consumed by the mobile app; would be new work (not blocked by data).
- **Dictation / voice keyboard**: server voice exists; phone has no capture pipeline.
- **Notifications deep policy (viewing suppression, channels)**: yardbell-notify exists but is simpler.
- **Tablet sidebar split, fold support, side-rail D-pad**: out of scope for a phone app.
- **Per-agent time-ago, unread bell, read/unread, Clear finished, workers/lineage**: no per-session timestamps or read state in `SessionView`.
- **Relay / remote pairing, QR with relay offers, credential status states (missing/temporarily-unavailable)**: Yardbell pairs by address only (Meshnet), so "Pairing invalid / unlock phone" row states do not exist; `signed-out` is the only auth failure state.
- **Orca-specific**: app-move screen, GitHub update source, RPC recording, i18n catalogs (11 locales).

### 12.3 Suggested build order to look like Orca (no new product features required)
1. Tokens: port `mobile-theme.ts` palette (dark + light), radii, spacing, typography, feedback; add `themedStyleSheet`-like helper (or a `useTheme()` returning the same keys). Add bgPanel/bgRaised/sheetSurface/sheetGroup/translucentFill/accentBlue/statusGreen.
2. Deps to add: lucide-react-native, react-native-svg, react-native-reanimated (+ worklets), react-native-gesture-handler, expo-haptics (all versions in section 1), set up babel plugin for reanimated.
3. Components to copy near-verbatim: NavBar, NavBarButton, PageTitle (collapsing), PullDownMenu, BottomDrawer, ActionSheetModal, ConfirmModal, ListGroup/ListRow/SectionHeader, SheetHeader, SwipeRowActions, MobileStateView, StatusDot, BottomSearchBar, MobileSearchField/TextField, MobileHomeFab, MobileHomeTabBar, home-list-styles, AgentSpinner/AgentStateDot.
4. Screens: Home (tab bar of Feed + Sessions + Settings; title row 22/700 with gear), Machine screen (NavBar + PageTitle + sectioned list + BottomSearchBar), Session (bgPanel chrome, NavBar with ⋯, 44 px tab strip with one cell, terminal, key row in Orca look + live input), Pair (steps + camera card + reticle), Settings (NavBar + ListGroups), About.
5. Replace `Alert.alert` confirms with ConfirmModal/ActionSheet.
