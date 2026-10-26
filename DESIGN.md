---
name: Yardbell
description: One page for a developer's machines, agent sessions and app ports.
colors:
  app: "#f1f1f1"
  bg: "#ffffff"
  side: "#f7f7f7"
  surface: "#ffffff"
  hover: "#f4f4f4"
  selected: "#ebebeb"
  ink: "#303030"
  ink-2: "#4a4a4a"
  muted: "#616161"
  line: "#e3e3e3"
  line-strong: "#cccccc"
  field-line: "#b5b5b5"
  brand: "#303030"
  brand-hover: "#1a1a1a"
  brand-ink: "#ffffff"
  accent: "#1f93ff"
  accent-soft: "#e0f0ff"
  accent-text: "#0e5399"
  ok: "#16a34a"
  ok-text: "#15803d"
  warn: "#d97706"
  warn-text: "#b45309"
  bad: "#dc2626"
  bad-text: "#b91c1c"
  mem: "#8a8a8a"
  mem-track: "#ffffff"
  app-dark: "#151718"
  bg-dark: "#1c1f21"
  side-dark: "#212426"
  hover-dark: "#26292c"
  selected-dark: "#2c3033"
  ink-dark: "#e3e3e3"
  ink-2-dark: "#c4c4c4"
  muted-dark: "#a0a0a0"
  line-dark: "#2c3033"
  line-strong-dark: "#3d4246"
  field-line-dark: "#4a4a4a"
  brand-dark: "#e3e3e3"
  brand-ink-dark: "#1c1f21"
  accent-soft-dark: "#0f2a44"
  accent-text-dark: "#7cc0ff"
  ok-dark: "#22c55e"
  ok-text-dark: "#4ade80"
  warn-dark: "#f59e0b"
  warn-text-dark: "#fbbf24"
  bad-dark: "#ef4444"
  bad-text-dark: "#f87171"
  mem-dark: "#8a8a8a"
  terminal: "#0a0a0b"
  terminal-bar: "#151718"
typography:
  headline:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
  section:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"cv11\", \"ss01\", \"tnum\""
  body-strong:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  caption:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  mono-block:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  bar: "4px"
  control: "8px"
  container: "12px"
  overlay: "16px"
  pill: "999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  row: "10px"
  lg: "12px"
  cell: "14px"
  xl: "16px"
  2xl: "20px"
  3xl: "24px"
  4xl: "32px"
  page-end: "64px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "28px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
  button-quiet:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "28px"
  button-quiet-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  badge:
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  badge-busy:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  machine-item:
    textColor: "{colors.ink}"
    rounded: "{rounded.container}"
    padding: "8px"
  machine-item-hover:
    backgroundColor: "{colors.hover}"
  machine-item-selected:
    backgroundColor: "{colors.surface}"
  table-head:
    backgroundColor: "{colors.side}"
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
    padding: "9px 14px"
  table-cell:
    typography: "{typography.body}"
    padding: "12px 14px"
  mem-bar:
    backgroundColor: "{colors.mem-track}"
    rounded: "{rounded.bar}"
    height: "6px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.overlay}"
    padding: "20px"
    width: "min(440px, calc(100% - 32px))"
  toast:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.container}"
    padding: "10px 14px"
  tab:
    backgroundColor: "{colors.app}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "0 12px"
    height: "36px"
  tab-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink-2}"
  tab-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  tab-selected-session:
    backgroundColor: "{colors.terminal-bar}"
    textColor: "{colors.ink-dark}"
---

# Design System: Yardbell

## Overview

**Creative North Star: "The Instrument Panel"**

Yardbell is a working instrument for one developer watching several machines. Its shell follows the Commslayer app (itself Polaris-like) so the two read as one family: a soft gray rail that the sidebar sits on flush, one white canvas that holds the page, near-black primary buttons with a bevel, and 28px controls with 8px corners. Craft comes from alignment, a tight type scale, complete states (connected, timed out, last known, outside tmux, tunnel down) and the memory bar drawn to scale, never from ornament.

Density is desk-dense and phone-honest. Work is grouped the way the user thinks about it: by machine. At 1440px a 256px sidebar on the gray rail holds the machine list, Claude usage, and the page menu (Dashboard, Workspace, Dispatch, Settings, theme, Log out); the main column is a white canvas with a 12px radius and a hairline ring, inset 8px from the window, and stacks one card per machine. The Workspace keeps the same rail and menu, with Dispatch docked beside its terminals. Under 760px the sidebar becomes a top bar with a horizontal machine strip, and the canvas goes flush. Light and dark follow the system preference; neither is secondary.

In October 2026 the product owner asked for this Commslayer-style shell, which replaces an earlier rejection of "cards on gray". Still rejected: anything playful or decorative (gradients, glows, mascots, motion for its own sake).

**Key Characteristics:**
- Gray rail (App) behind a white canvas (Paper); machine sections, peers and lists are cards with a hairline ring and a very soft stacked shadow.
- Primary actions are near-black (Brand) with a bevel; blue is for focus, links, selection edges and the agents' share of memory.
- Green, amber and red carry state only, always paired with words.
- IBM Plex Sans for interface text with tabular numerals; IBM Plex Mono for branches, ports and code.
- Light and dark are both first-class, switched by `prefers-color-scheme`.

## Colors

A neutral gray field (no blue cast), a near-black brand fill for primary actions, one blue for focus and selection, and a restrained semantic trio.

### Primary
- **Brand** (#303030 light, #e3e3e3 dark, text #ffffff / #1c1f21): primary buttons (New session, Start and open, Send, Log in), the toast and the wordmark's mark. Hover to #1a1a1a (light) or #ffffff (dark).
- **Signal Blue** (#1f93ff): focus outlines, the keyboard row's left edge, the pressed peer's ring, switches when on, the agents' share inside the memory bar, checkbox accents.
- **Blue Wash** (#e0f0ff light, #0f2a44 dark) with **Blue Ink** (#0e5399 light, #7cc0ff dark): the Working badge, the pressed peer and links in help text.

### Neutral
- **App** (#f1f1f1 light, #151718 dark): the rail. The page background, the sidebar (flush, no border), the tab bar, the login backdrop, the inside of segmented controls.
- **Paper** (#ffffff light, #1c1f21 dark): the main canvas, cards, buttons, inputs, dialogs, the selected nav pill.
- **Side** (#f7f7f7 light, #212426 dark): card header rows, dialog footers, code blocks, tool steps in Dispatch.
- **Hover** (#f4f4f4 light, #26292c dark) on Paper, and **Rail Hover** (5% black, 6% white) on the rail.
- **Ink** (#303030 / #e3e3e3), **Ink 2** (#4a4a4a / #c4c4c4), **Muted** (#616161 / #a0a0a0): text tiers.
- **Rule** (#e3e3e3 / #2c3033): dividers. **Strong Rule** (#cccccc / #3d4246): scrollbars and frames. **Field Line** (#b5b5b5 / #4a4a4a): input borders, darkening to Muted on hover.
- **Memory Gray** (#8a8a8a) on **Memory Track** (Paper): the non-agent share of used memory.
- **Terminal** (#0a0a0b) and **Terminal Bar** (#151718): the always-dark terminal page and the selected session tab.

### Semantic
- **Healthy Green** (#16a34a / #22c55e dark; text #15803d / #4ade80): connected dots, running tunnels, completed checklist steps.
- **Caution Amber** (#d97706 / #f59e0b dark; text #b45309 / #fbbf24): ports whose app is not running, and a memory bar past the 85% rated line.
- **Fault Red** (#dc2626 / #ef4444 dark; text #b91c1c / #f87171): unreachable machines, tunnels down, failed steps, error text, the Stop button on hover.

Each semantic color has a fill value (dots, bars, tinted marks) and a darker text value tuned for contrast. Use the text value whenever the color sits on words.

### Named Rules
**The Brand Acts Rule.** Near-black means "the main action here". One per view region, placed last in its row.

**The One Blue Rule.** Blue means focus, selection or an agent. It never fills a button or a section, and no second accent hue joins it.

**The State Has Words Rule.** A semantic color never appears alone: every dot or tinted bar is paired with text that names the state (SSH timeout, tunnel down, app not running).

## Typography

**Display Font:** none; the system has no display tier.
**Body Font:** IBM Plex Sans (with system-ui, Segoe UI, Roboto)
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, SF Mono, Menlo, Consolas)

**Character:** IBM Plex Sans with tabular numerals for figures, so counts, GB figures and load averages align in columns. IBM Plex Mono marks text that came from a machine: branch names, port numbers, commands.

### Hierarchy
- **Headline** (600, 18px, -0.01em): the page title in the main header ("Sessions" or a machine name).
- **Title** (600, 16px): dialog headings. The wordmark uses the same size at 650 weight with -0.01em tracking.
- **Section** (600, 14 to 15px): machine section titles on the dashboard and section headings on the settings and add machine pages.
- **Body** (400, 13px, 1.5): table cells, form inputs, step messages. Emphasis inside body uses 550 (machine names, folders, checklist labels) and 600 for ticket ids.
- **Label** (500, 13px): form labels, sidebar links, notes and toasts. Buttons are 500 at 12px.
- **Caption** (400 or 500, 12px): column headers, badges, connection status, memory text, counts.
- **Mono** (400, 12px for branches; 12.5px for port numbers and code blocks at 1.6 line height).

### Named Rules
**The Machine Text Rule.** If the string came from a shell (branch, port, command, path in a code block), it is set in IBM Plex Mono. Human labels and names stay in IBM Plex Sans.

**The Tabular Rule.** Numbers are always tabular: counts, memory figures, load, ports and timestamps carry `tabular-nums`. Names and paths stay proportional, because the tabular feature also widens hyphens ("mac-mini", "ENG-158").

## Layout

Every signed-in page shares one shell: a sticky sidebar on the App rail, 256px by default and the same width on every page: its right edge drags it from 220 to 480px, and it folds to a 60px icon rail and a fluid main column (`minmax(0, 1fr)`). The main column is a Paper canvas inset 8px from the top, right and bottom, with a 12px radius and the card ring, padded 20px top, 32px sides, 64px bottom. The main header is a row at least 36px tall: title, "Updated" time, a flexible spacer, then actions with the page's one Brand button last (on the dashboard: Refresh as a 28px icon button, Add machine, New session). Below it the dashboard has a toolbar row 16px above the sections: a 340px search field (16px icon inside, a `/` key hint that hides on focus or once typed) and an All / Working / Idle segmented control with counts. The dashboard stacks machine cards 16px apart; settings and add machine put their sections in a 760px column with 32px between sections. Login centers a 360px panel on the App rail.

Spacing is a small, mostly even rhythm: 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 64px. Table cells use 12px by 14 to 16px; list rows use 10px by 14px; gaps inside controls are 6 to 8px.

At 760px and below: the sidebar becomes a non-sticky header with the wordmark and compact Settings and Log out at top right, and on the dashboard a horizontally scrolling strip of 34px machine pills (All, each machine with dot and count, Add machine). The canvas goes flush with no radius or ring. Machine section headers stack the memory block under the name. Session rows put folder and status on top, branch and agent on their own lines, ports and actions full width with a wide Open and a compact Stop beside it. Two-column forms collapse to one. Safe-area insets are respected at top and bottom.

The Workspace (see Workspace and Dispatch) fills the window: the same sidebar, then Dispatch, then the tabs and panes.

## Elevation & Depth

Low and quiet. The canvas and in-flow cards sit on a hairline ring with a barely visible stacked shadow; controls carry an inset bevel; only overlays float.

### Shadow Vocabulary
- **Card** (`0 0 0 1px rgb(0 0 0 / 0.07), 0 1px 1px -0.5px rgb(0 0 0 / 0.03), 0 5px 5px -2.5px rgb(0 0 0 / 0.03)`; dark: a 1px #2c3033 ring only): the main canvas, machine sections, peers, lists, panels, tool steps.
- **Pill** (`0 0 0 1px rgb(0 0 0 / 0.06), 0 1px 0 rgb(0 0 0 / 0.07)`): the selected nav item, segmented button and conversation.
- **Button bevel** (`inset 0 -1px 0 #b5b5b5, inset 0 0 0 1px rgb(0 0 0 / 0.1)`; pressed adds `inset 0 2px 1px rgb(26 26 26 / 0.2)`; dark: a 1px #3d4246 inset ring): default buttons. Brand buttons have their own darker bevel with a light top highlight.
- **Popover** (`0 0 0 1px rgb(0 0 0 / 0.06), 0 8px 16px -4px rgb(26 26 26 / 0.22)`): menus and dialogs, over a backdrop of `rgb(0 0 0 / 0.4)`.

### Named Rules
**The Hairline Rule.** In-flow surfaces are separated by a 1px ring, never by a heavy shadow. If a shadow is visible at a glance, it belongs to something floating.

## Shapes

Corners scale with the size of the thing. Controls (buttons, inputs, nav items, menu items, conversation rows) use 8px; cards and the canvas use 12px; dialogs use 16px. Pills (counts, badges) are fully round, as are status dots (8px) and checklist marks (20px). The memory bar is an 8px track with 4px ends.

Input borders are 1px Field Line. Focus is a 2px Signal Blue outline (offset 2px on buttons and links, drawn inside the border on inputs).

## Components

### Buttons
Compact and bevelled; the Brand button is the only filled one in a region.
- **Shape:** 8px radius, 28px tall, 12px horizontal padding, 12.5px/500 text, 6px gap for a leading 16px icon.
- **Default:** Paper fill with the button bevel, Ink text. Hover fills Hover; pressed sinks with the inner shadow.
- **Primary:** Brand fill with its bevel, Brand Ink text; hover to Brand Hover.
- **Quiet:** transparent with Muted text for low-stakes or destructive-but-recoverable actions (Stop, Forget); hover fills Rail Hover and raises text to Ink. The danger variant turns its text Fault Red on hover only.
- **Wide:** full width at 36px for single-action forms (login).
- **Transitions:** background, color and shadow at 120ms ease-out. Disabled drops to 55% opacity with a progress cursor.

### Chips (badges and counts)
- **Style:** 12px/500 text in a pill with a 1px Rule border, Ink 2 text, 2px by 8px padding.
- **State:** Working is a Blue Wash pill with Blue Ink text and a 6px pulsing dot (1.6s, disabled under reduced motion). Idle, Outside tmux and Last known are plain outline pills. The header count is a muted 13px outline pill.

### Cards / Containers
- **Corner Style:** 12px; 8px for nested lists inside a card.
- **Background:** Paper; header rows and code blocks use Side.
- **Shadow Strategy:** the Card ring (see Elevation & Depth).
- **Internal Padding:** 12px by 16px headers, 12px by 14px rows, 20px panels, 20px dialogs.

### Inputs / Fields
- **Style:** 36px tall, 10px horizontal padding, 1px Strong Rule border, 6px radius, Paper fill, 14px IBM Plex Sans. Labels sit above at 13px/500 Ink 2 with a 6px gap; fields stack 14px apart.
- **Focus:** border turns Signal Blue, outline flush (offset 0).
- **Checkboxes:** 16px, tinted with the accent; the label runs inline at 400 weight.
- **Error:** a 13px Fault Red text line below the form, reserved at one line height so the layout does not jump.

### Navigation
- **Sidebar:** flush on the App rail with no border, the same on every signed-in page. Wordmark, a muted "n of m connected" summary and the fold button; a 12px muted "Machines" label, the machine items and a muted "+ Add machine"; the Claude usage card; then, above a hairline, the VPN line and the page menu: **Dashboard** (home icon, always first, so the way back is in the same place on every page), Workspace, Dispatch, Settings, the theme switch and Log out. The current page's link is a white pill with the Pill shadow. Pages without the sidebar (Settings, Add machine, Dispatch on a phone) also keep a "Dashboard" back link with the home icon above their title.
- **Nav item:** 28px, 4px by 8px, 8px radius, 500 weight Ink 2. State dot (green connected, amber memory past the rated line, red down, with the state word for screen readers and in the tooltip), name, running-session count right-aligned and muted. Hover fills Rail Hover; selected is the white pill. "All machines" has no dot. On the dashboard a click filters in place and updates `?machine=`; on other pages it links to the filtered dashboard.
- **Phone:** the sidebar collapses into a header; page links and machine items become pills in scrolling rows.

### Memory Bar (signature)
The answer to "where is there room" without reading. It sits in the right column (up to 320px) of each machine section header, so every machine's bar lines up. An 8px bar on Memory Track with a 1px Strong Rule inset, drawn to that machine's total RAM: the agents' share fills from the left in Signal Blue, the rest of used memory in Memory Gray. Past the rated line (85%) the used fill and the "% used" figure turn Caution Amber, past 95% Fault Red. Above the bar, "**63% used** of 15.4 GB"; below it a 12px legend with keyed squares and units: "Agents 1.2 GB · Other 8.4 GB · Free 5.7 GB". A machine that is down shows no bar; its header line says why and when it was last seen.

### Machine Sections
The main view: one 12px card per machine with the Card ring, ordered down first, then memory-hot, then the rest in config order, 16px apart. No column headers and no Machine column; the section is the machine.
- **Header** (Side, 12px by 16px, 1px bottom rule): left, a 22px fold chevron (pointing down when open, right when folded; folded sections keep only the header, remembered per machine; replaced by an empty spacer while searching), the state dot, the machine name (14px/600), a muted "n sessions" count while up, and below it the connection line (12px Muted, Fault Red with the reason and last-seen time when down; a down section's ring tints red). Middle, the memory block (see Memory Bar). Right, quiet 28px icon buttons with tooltips: **+** New session here and the terminal glyph Open a shell (only while up), and **⋯** which opens the machine menu.
- **Session row** (12px by 14px, 1px rules between rows): a grid that lines up across sections: session, a 104px status column, a ports column (dropped when no visible session has ports), and right-aligned actions. Line one: folder at 550 and the ticket chip (12px/600 Ink, 1px Strong Rule border, 4px radius). Line two in 12px Muted: the branch in mono and the agent's label, joined by a "·". Status is the Working or Idle chip ("Last known" for stale rows, which dim). Ports list one line per service: state dot, service in Ink 2, mono port (linked with an external icon when tunnelled), state word in the matching text color. Actions: Open (default with a terminal icon), optional Terminal app, and a quiet Stop that appears on row hover or focus with a fine pointer and is always visible on touch. The whole row opens the terminal; hover fills Hover; the keyboard row (j/k) fills Hover with a 2px Signal Blue edge.
- **Empty:** "No open sessions" with a quiet Start one button that preselects the machine; a down machine says its sessions reappear when it reconnects.
- **Footer** (1px top rule, 4px by 6px): toggles for "n outside tmux" and "n ended", 30px tall, 12.5px/500 Muted with the count at 600 Ink 2 and a 14px chevron that turns 90 degrees when open (160ms ease-out). Each opens a panel on a light Side wash: outside tmux shows a one-sentence help line (one Blue Ink link) and a bordered list of rows with **Move to tmux** (a Working chip only when busy); ended shows rows with Resume and a quiet Forget. Open state is remembered per machine and per browser.

### Menu
A fixed popover under its trigger, right-aligned to it and kept 8px inside the viewport: 200px minimum, 4px padding, 12px radius, Paper, and the Popover shadow (it floats). Items are 30px rows of 13px/500 Ink with an 8px radius and a Hover fill on hover or focus; a destructive item uses Fault Red text. Arrow keys move between items, Esc closes and returns focus to the trigger, an outside click closes it. The machine menu holds Machine settings (links to that machine's form on Settings), Copy ssh command and Remove machine… (the last two only for machines other than the host; Remove asks first).

### Segmented Control
An App-filled track with 2px padding and 8px radius. Buttons are 28px, 13px/500 Muted with a tabular count; the pressed one is a white pill with the Pill shadow and Ink text. On a phone it spans the width in three equal parts at 34px.

### Setup Checklist
Add machine steps are a list of 20px round marks with 12px icons: Hover while pending (spinning icon at 0.9s linear while working), green tint (16%) with a check on success, red tint (14%) with a cross on failure. Label at 550, message in Muted, and any follow-up commands in a Side code block.

### Icons
Inline SVG on a 16px box, no fill, `currentColor` stroke at 1.6, round caps and joins. Smaller contexts (port links 13px, checklist marks 12px at stroke 2) scale the same drawing.

### Terminal
The terminal page draws its own light or dark theme (Settings, Appearance): a slim bar with a **Dashboard** button (home icon) first, the session name and a Copy text button; xterm.js fills the rest, and on coarse pointers a scrolling row of 40px key buttons (Esc, Tab, Ctrl, arrows, Enter, Ctrl-C). Inside a Workspace pane the page drops its bar and the pane head takes its place.

### Tab Bar
The desktop app's one row above the content: 36px tall, full width, on Rail with a 1px Rule along the bottom, light or dark with the system. Tabs are 13px/500, at most 220px wide each, and share the width as more open, never wrapping; a 1px Rule separates them, and a long name ends in an ellipsis with the full name in the tooltip. Dashboard comes first and keeps its natural width; session tabs read "folder · machine". An inactive tab is Muted Slate; hover fills Hover Slate and raises the text to Ink 2. The selected tab has no bottom rule and a 2px Signal Blue top edge, so it joins the page below it and stays marked in both themes: the Dashboard tab is Paper with Ink text, and a session tab takes the terminal's fixed top bar colors in either theme (#0f1012 fill, #ededef text), since the terminal page is always dark. A selected session tab keeps at least 112px so its name stays readable. Session tabs end in a 20px close button (a 12px cross, 6px radius, Rule fill on hover, #2e3137 on the dark selected tab) that shows on the selected tab, on hover and on keyboard focus, and otherwise keeps its space so names do not shift; an inactive tab narrower than 96px gives that space to its name. A click selects; the close button or a middle click closes. Overflowing names are clipped to their tab. No shadow.

### Workspace and Dispatch
The Workspace fills the window with three columns: the sidebar (the shared sidebar width, folding to the 60px rail) holding the session tree and the page menu, a Dispatch panel, and the tab row with its panes taking the rest. In the tree each machine is a 28px fold button (chevron, monitor glyph, name, session count) that hides its folders and sessions, remembered per browser; long names end in an ellipsis and the tree only scrolls vertically. Dispatch is 380px wide by default (300 to 640px from its right edge, remembered) on Paper with a 1px Rule on its right edge, open unless it was closed. It is the regular Dispatch page in an embedded mode: no sidebar or back link, a 15px "Dispatch" title with Settings and a Hide button, its conversations and tasks, and the composer pinned to the panel's bottom while the conversation scrolls above it. The speech bubble button at the start of the tab row shows and hides it, with a white pill when pressed. **Dispatch** in the sidebar menu always opens the full Dispatch page, and is marked current only there. Sessions Dispatch links to open as Workspace panes; other links open in the whole window. On a phone the panel is not shown and Dispatch opens as its own page. The panel never calls `focus()` while it does not have focus, so typing in a terminal is not interrupted. Resize edges are 8px wide with a 2px accent line on hover, focus or drag, and take arrow keys and a double-click to reset.

### Menu Bar Panel
The macOS app's left click on the menu bar icon: a 340px borderless window under the icon, kept 8px inside the screen, on Paper with a 1px Strong Rule edge and 12px padding, light or dark with the system. The main view stacks three blocks 12px apart. **Machines** (12px/600 Muted title) is a Side card with a 1px Rule and 8px radius holding one button row per machine: the state dot, the name at 600, "up" or the red down reason on the right, then a Memory line and a CPU line on a 52px label, bar, 96px value grid. Memory uses the Memory Bar drawing; CPU is a single Memory Gray fill of the 1-minute load per core, capped at 100%, with the raw load in its tooltip; both turn Caution Amber at 85% and Fault Red at 95%. **Sessions** lists the openable sessions as 32px rows named like their tabs, with the Working chip on busy ones; the list scrolls past 288px. The bottom row, under a 1px Rule, holds New session, Open Yardbell (primary) and a 32px gear button. The gear swaps in the settings view: a back arrow beside a 14px/600 "Settings" heading, Side cards of 32px switch rows (28 by 16px, Brand when on) under **Notifications on this Mac** and **Startup**, and a bottom row with Disconnect and Quit Yardbell in Fault Red text. Esc goes back, then closes; the panel closes when it loses focus and reopens on the main view. Linux keeps the native menu, since its tray reports no clicks.

## Do's and Don'ts

### Do:
- **Do** put every signed-in page on the App rail with the Paper canvas, and keep Dashboard as the first link in the page menu.
- **Do** use cards with the hairline Card ring for machines, peers, lists and panels.
- **Do** keep exactly one Brand button per view region, placed last in its row.
- **Do** pair every status dot or tinted bar with a word naming the state, set in the matching text color.
- **Do** set branches, ports and commands in IBM Plex Mono and keep all numbers tabular.
- **Do** draw resource figures to scale (the memory bar) instead of reporting them as percentages alone.
- **Do** design every state a machine or session can be in: connected, timed out, last known, outside tmux, tunnel down, empty.
- **Do** define both light and dark values for any new color token, in all three theme blocks of `style.css`.
- **Do** use inline stroked SVG icons at 16px with stroke 1.6.

### Don't:
- **Don't** use heavy or colored shadows on in-flow surfaces; the ring and the bevel are the only depth there.
- **Don't** fill a button with blue, introduce a second accent hue, or use green, amber or red for anything but state.
- **Don't** add gradients, glows, mascots or motion for its own sake. The only loops are the Working pulse (stopped under reduced motion) and the setup step spinner, and both report live work.
- **Don't** add a display typeface or a heading larger than 18px; the page title is the top of the scale.
- **Don't** call `focus()` from a page that can be hidden behind another tab or panel without checking `document.hasFocus()` first; in the desktop app it takes the keyboard from the terminal.
