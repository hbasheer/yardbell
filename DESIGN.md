---
name: Yardbell
description: One page for a developer's machines, agent sessions and app ports.
colors:
  bg: "#ffffff"
  side: "#f8fafc"
  surface: "#ffffff"
  hover: "#f1f5f9"
  selected: "#eef2ff"
  ink: "#0f172a"
  ink-2: "#334155"
  muted: "#64748b"
  line: "#e2e8f0"
  line-strong: "#cbd5e1"
  accent: "#2563eb"
  accent-hover: "#1d4ed8"
  accent-ink: "#ffffff"
  accent-soft: "#dbeafe"
  accent-text: "#1d4ed8"
  ok: "#16a34a"
  ok-text: "#15803d"
  warn: "#d97706"
  warn-text: "#b45309"
  bad: "#dc2626"
  bad-text: "#b91c1c"
  mem: "#94a3b8"
  mem-track: "#e2e8f0"
  bg-dark: "#0a0a0b"
  side-dark: "#0f1012"
  hover-dark: "#17181b"
  selected-dark: "#172033"
  ink-dark: "#ededef"
  ink-2-dark: "#c4c6cc"
  muted-dark: "#8b8f98"
  line-dark: "#1f2125"
  line-strong-dark: "#2e3137"
  accent-soft-dark: "#172554"
  accent-text-dark: "#93c5fd"
  ok-dark: "#22c55e"
  ok-text-dark: "#4ade80"
  warn-dark: "#f59e0b"
  warn-text-dark: "#fbbf24"
  bad-dark: "#ef4444"
  bad-text-dark: "#f87171"
  mem-dark: "#6b7280"
typography:
  headline:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
  section:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"cv11\", \"ss01\", \"tnum\""
  body-strong:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.5
  label:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  caption:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  mono-block:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  bar: "3px"
  control: "6px"
  container: "8px"
  overlay: "12px"
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
    height: "32px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-quiet:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-quiet-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "36px"
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
    backgroundColor: "{colors.selected}"
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
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.container}"
    padding: "10px 14px"
  tab:
    backgroundColor: "{colors.side}"
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
    backgroundColor: "{colors.side-dark}"
    textColor: "{colors.ink-dark}"
---

# Design System: Yardbell

## Overview

**Creative North Star: "The Instrument Panel"**

Yardbell is a working instrument for one developer watching several machines. It sits in the category of Linear, the Vercel dashboard, Tailscale admin and GitHub on purpose: white and slate in light, near-black in dark, one blue, and state colors that only ever mean state. Craft comes from alignment, a tight type scale, complete states (connected, timed out, last known, outside tmux, tunnel down) and the memory bar drawn to scale, never from ornament.

Density is desk-dense and phone-honest. Work is grouped the way the user thinks about it: by machine. At 1440px a slim 232px sidebar is navigation only (machines with a state dot and a session count, Add machine, VPN, Settings, Log out), and the main column stacks one bordered section per machine: its health in a Rail header, its sessions below, its outside-tmux and ended sessions folded into a footer. Under 760px the sidebar becomes a top bar with a horizontal machine strip, so sessions start on the first screen. Both light and dark follow the system preference; neither is secondary.

Confirmed rejections from the product owner: anything that reads as a generic admin template (cards on gray), and anything playful or decorative (gradients, glows, mascots, motion for its own sake).

**Key Characteristics:**
- Flat surfaces separated by 1px rules; shadows only on overlays.
- One blue accent for the primary action, selection and the agents' share of memory.
- Green, amber and red carry state only, always paired with words.
- Inter for interface text with tabular numerals; JetBrains Mono for branches, ports and code.
- Light and dark are both first-class, switched by `prefers-color-scheme`.

## Colors

A cool slate neutral field with a single saturated blue and a restrained semantic trio.

### Primary
- **Signal Blue** (#2563eb): the primary button (New session, Start and open, Start one), the selected machine's tint and border, focus outlines, the agents' share inside the memory bar, checkbox accents. Hover deepens to **Pressed Blue** (#1d4ed8). The same blue is used in both themes.
- **Blue Wash** (#dbeafe light, #172554 dark) with **Blue Ink** (#1d4ed8 light, #93c5fd dark): the Working badge and the agents figure under the memory bar. This is the only place the accent appears as a tint behind text.

### Neutral
- **Paper** (#ffffff light, #0a0a0b dark): page background and every in-flow surface (table, buttons, inputs, dialog).
- **Rail** (#f8fafc light, #0f1012 dark): sidebar, table header row, top bar on the add page, login backdrop, code blocks. One step off Paper, never a canvas for cards.
- **Hover Slate** (#f1f5f9 light, #17181b dark): hover fill for buttons, machine rows, sidebar links; resting fill of pending checklist marks.
- **Selected Indigo** (#eef2ff light, #172033 dark): the selected machine and the pressed peer choice.
- **Ink** (#0f172a light, #ededef dark): primary text, ticket ids, folder names.
- **Ink 2** (#334155 light, #c4c6cc dark): secondary emphasis such as service names, labels and the "used" figure.
- **Muted Slate** (#64748b light, #8b8f98 dark): metadata, column headers, counts, connection text, branch names, quiet buttons, placeholders.
- **Rule** (#e2e8f0 light, #1f2125 dark): every 1px divider and container border.
- **Strong Rule** (#cbd5e1 light, #2e3137 dark): button and input borders, peer hover border, scrollbar thumb.
- **Memory Gray** (#94a3b8 light, #6b7280 dark) on **Memory Track** (#e2e8f0 light, #1f2125 dark): the non-agent share of used memory.

### Semantic
- **Healthy Green** (#16a34a / #22c55e dark; text #15803d / #4ade80): connected dots, running tunnels, completed checklist steps.
- **Caution Amber** (#d97706 / #f59e0b dark; text #b45309 / #fbbf24): ports whose app is not running, and a memory bar past the 85% rated line.
- **Fault Red** (#dc2626 / #ef4444 dark; text #b91c1c / #f87171): unreachable machines, tunnels down, failed steps, error text, the Stop button on hover.

Each semantic color has a fill value (dots, bars, tinted marks) and a darker text value tuned for contrast on Paper. Use the text value whenever the color sits on words.

### Named Rules
**The One Blue Rule.** Blue means "act here" or "this is selected" or "this is an agent". It never decorates, never fills a section, and is never joined by a second accent hue.

**The State Has Words Rule.** A semantic color never appears alone: every dot or tinted bar is paired with text that names the state (SSH timeout, tunnel down, app not running).

## Typography

**Display Font:** none; the system has no display tier.
**Body Font:** Inter Variable (with Inter, system-ui, Segoe UI, Roboto)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo, Consolas)

**Character:** Inter with `cv11` and `ss01` and tabular numerals throughout, so counts, GB figures and load averages align in columns. JetBrains Mono marks text that came from a machine: branch names, port numbers, commands.

### Hierarchy
- **Headline** (600, 20px, -0.01em): the page title in the main header ("Sessions" or a machine name).
- **Title** (600, 16px): dialog headings. The wordmark uses the same size at 650 weight with -0.01em tracking.
- **Section** (600, 15px): machine section titles on the dashboard and section headings on the settings and add machine pages.
- **Body** (400, 14px, 1.5): table cells, form inputs, step messages. Emphasis inside body uses 550 (machine names, folders, checklist labels) and 600 for ticket ids.
- **Label** (500, 13px): buttons, form labels, sidebar links, notes and toasts.
- **Caption** (400 or 500, 12px): column headers, badges, connection status, memory text, counts.
- **Mono** (400, 12px for branches; 12.5px for port numbers and code blocks at 1.6 line height).

### Named Rules
**The Machine Text Rule.** If the string came from a shell (branch, port, command, path in a code block), it is set in JetBrains Mono. Human labels and names stay in Inter.

**The Tabular Rule.** Numbers are always tabular: counts, memory figures, load, ports and timestamps carry `tabular-nums`. Names and paths stay proportional, because Inter's tabular feature also widens hyphens ("mac-mini", "ENG-158").

## Layout

Every signed-in page shares one shell: a sticky 232px sidebar and a fluid main column (`minmax(0, 1fr)`) padded 20px top, 32px sides, 64px bottom. The main header is a 40px row: title, "Updated" time, a flexible spacer, then actions with the page's one primary button last (on the dashboard: Refresh as a 32px icon button, Add machine, New session). Below it the dashboard has a toolbar row 16px above the sections: a 340px search field (16px icon inside, a `/` key hint that hides on focus or once typed) and an All / Working / Idle segmented control with counts. On the dashboard the main column is a stack of machine sections 20px apart; settings and add machine put their sections in a 760px column with 32px between sections. Login centers a 360px panel on the Rail background.

Spacing is a small, mostly even rhythm: 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 64px. Table cells use 12px by 14px; list rows use 10px by 14px; gaps inside controls are 6 to 8px.

At 760px and below: the sidebar becomes a non-sticky header with the wordmark and compact Settings and Log out at top right, and on the dashboard a horizontally scrolling strip of 34px machine pills (All, each machine with dot and count, Add machine). Machine section headers stack the memory block under the name. Session rows put folder and status on top, branch and agent on their own lines, ports and actions full width with a 40px Open that takes the row and a compact Stop beside it. Two-column forms collapse to one. Safe-area insets are respected at top and bottom.

## Elevation & Depth

Flat. Depth in the page comes from tonal steps (Paper to Rail to Hover Slate) and 1px rules, never from shadow. Shadows exist only on things that float above the page.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 16px 40px rgb(0 0 0 / 0.18)`): modal dialogs, over a backdrop of `rgb(15 23 42 / 0.45)`.
- **Toast** (`box-shadow: 0 8px 24px rgb(0 0 0 / 0.2)`): the bottom-centered status toast.

### Named Rules
**The Overlays Only Rule.** If it scrolls with the page, it has no shadow. Tables, list rows, machine items, panels and buttons are bordered, not lifted.

## Shapes

Corners scale with the size of the thing. Controls (buttons, inputs, code blocks, sidebar links) use 6px; containers (table wrapper, ended list, machine items, peer choices, phone session blocks, toast) use 8px; overlays and standalone panels (dialog, login panel) use 12px. Pills (counts, badges) are fully round, as are status dots (8px) and checklist marks (20px). The memory bar is a 6px track with 3px ends.

Borders are always 1px: Rule for containers and dividers, Strong Rule for interactive controls. Focus is a 2px Signal Blue outline offset 2px; inputs instead switch their border to Signal Blue with no offset.

## Components

### Buttons
Quiet, compact and bordered; the primary is the only filled one on a screen.
- **Shape:** gently rounded (6px), 32px tall, 12px horizontal padding, 6px gap for a leading 16px icon.
- **Default:** Paper fill, Strong Rule border, Ink text. Hover fills Hover Slate.
- **Primary:** Signal Blue fill and border, white text; hover to Pressed Blue. One per view region (the header's New session, a dialog's confirm).
- **Quiet:** transparent with Muted Slate text for low-stakes or destructive-but-recoverable actions (Stop, Forget); hover fills Hover Slate and raises text to Ink. The danger variant turns its text Fault Red on hover only.
- **Wide:** full width at 38px for single-action forms (login).
- **Transitions:** background, border and color at 120ms ease-out. Disabled drops to 55% opacity with a progress cursor.

### Chips (badges and counts)
- **Style:** 12px/500 text in a pill with a 1px Rule border, Ink 2 text, 2px by 8px padding.
- **State:** Working is a Blue Wash pill with Blue Ink text and a 6px pulsing dot (1.6s, disabled under reduced motion). Idle, Outside tmux and Last known are plain outline pills. The header count is a muted 13px outline pill.

### Cards / Containers
- **Corner Style:** 8px for in-flow containers, 12px for panels.
- **Background:** Paper; header rows and code blocks use Rail.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px Rule; internal rows divided by 1px Rule.
- **Internal Padding:** 12px by 14px table cells, 10px by 14px list rows, 24px panels, 20px dialogs.

### Inputs / Fields
- **Style:** 36px tall, 10px horizontal padding, 1px Strong Rule border, 6px radius, Paper fill, 14px Inter. Labels sit above at 13px/500 Ink 2 with a 6px gap; fields stack 14px apart.
- **Focus:** border turns Signal Blue, outline flush (offset 0).
- **Checkboxes:** 16px, tinted with the accent; the label runs inline at 400 weight.
- **Error:** a 13px Fault Red text line below the form, reserved at one line height so the layout does not jump.

### Navigation
- **Sidebar:** Rail background with a 1px right rule, the same on every signed-in page. Wordmark with a muted "n of m connected" summary, a 12px muted "Machines" label, then nav items with 1px gaps and a muted "+ Add machine" link. The footer above a 1px rule holds the VPN line, Settings and Log out. The current page's link fills Selected Indigo.
- **Nav item:** 6px by 8px, 6px radius, 500 weight Ink 2. State dot (green connected, amber memory past the rated line, red down, with the state word for screen readers and in the tooltip), name, running-session count right-aligned and muted. Hover fills Hover Slate; selected fills Selected Indigo with a 25% accent ring. "All machines" has no dot. On the dashboard a click filters in place and updates `?machine=`; on other pages it links to the filtered dashboard.
- **Phone:** the sidebar collapses into a header; nav items become 34px pills in one scrolling row (dashboard only).

### Memory Bar (signature)
The answer to "where is there room" without reading. It sits in the right column (up to 320px) of each machine section header, so every machine's bar lines up. An 8px bar on Memory Track with a 1px Strong Rule inset, drawn to that machine's total RAM: the agents' share fills from the left in Signal Blue, the rest of used memory in Memory Gray. Past the rated line (85%) the used fill and the "% used" figure turn Caution Amber, past 95% Fault Red. Above the bar, "**63% used** of 15.4 GB"; below it a 12px legend with keyed squares and units: "Agents 1.2 GB · Other 8.4 GB · Free 5.7 GB". A machine that is down shows no bar; its header line says why and when it was last seen.

### Machine Sections
The main view: one bordered 8px container per machine, ordered down first, then memory-hot, then the rest in config order, 20px apart. No column headers and no Machine column; the section is the machine.
- **Header** (Rail, 12px by 14px, 1px bottom rule): left, a 22px fold chevron (pointing down when open, right when folded; folded sections keep only the header, remembered per machine; replaced by an empty spacer while searching), the state dot, the machine name (15px/600), a muted "n sessions" count while up, and below it the connection line (12px Muted Slate, Fault Red with the reason and last-seen time when down; a down section's border tints red). Middle, the memory block (see Memory Bar). Right, quiet 30px icon buttons with tooltips: **+** New session here and the terminal glyph Open a shell (only while up), and **⋯** which opens the machine menu.
- **Session row** (12px by 14px, 1px rules between rows): a grid that lines up across sections: session, a 104px status column, a ports column (dropped when no visible session has ports), and right-aligned actions. Line one: folder at 550 and the ticket chip (12px/600 Ink, 1px Strong Rule border, 4px radius). Line two in 12px Muted Slate: the branch in mono and the agent's label, joined by a "·". Status is the Working or Idle chip ("Last known" for stale rows, which dim). Ports list one line per service: state dot, service in Ink 2, mono port (linked with an external icon when tunnelled), state word in the matching text color. Actions: Open (default with a terminal icon), optional Terminal app, and a quiet Stop that appears on row hover or focus with a fine pointer and is always visible on touch. The whole row opens the terminal; hover is a 60% Hover Slate wash; the keyboard row (j/k) fills Selected Indigo with a 2px accent edge.
- **Empty:** "No open sessions" with a quiet Start one button that preselects the machine; a down machine says its sessions reappear when it reconnects.
- **Footer** (1px top rule, 4px by 6px): toggles for "n outside tmux" and "n ended", 30px tall, 12.5px/500 Muted Slate with the count at 600 Ink 2 and a 14px chevron that turns 90 degrees when open (160ms ease-out). Each opens a panel on a light Rail wash: outside tmux shows a one-sentence help line (one Blue Ink link) and a bordered list of rows with **Move to tmux** (a Working chip only when busy); ended shows rows with Resume and a quiet Forget. Open state is remembered per machine and per browser.

### Menu
A fixed popover under its trigger, right-aligned to it and kept 8px inside the viewport: 200px minimum, 4px padding, 1px Rule border, 8px radius, Paper, and the Overlay shadow (it floats). Items are 32px rows of 13px/500 Ink with a Hover Slate fill on hover or focus; a destructive item uses Fault Red text. Arrow keys move between items, Esc closes and returns focus to the trigger, an outside click closes it. The machine menu holds Machine settings (links to that machine's form on Settings), Copy ssh command and Remove machine… (the last two only for machines other than the host; Remove asks first).

### Segmented Control
Inline group in a 1px Strong Rule frame with 2px padding and 8px radius. Buttons are 28px, 13px/500 Muted Slate with a tabular count; the pressed one fills Selected Indigo with a 25% accent ring and Ink text. On a phone it spans the width in three equal parts at 34px.

### Setup Checklist
Add machine steps are a list of 20px round marks with 12px icons: Hover Slate while pending (spinning icon at 0.9s linear while working), green tint (16%) with a check on success, red tint (14%) with a cross on failure. Label at 550, message in Muted Slate, and any follow-up commands in a Rail code block.

### Icons
Inline SVG on a 16px box, no fill, `currentColor` stroke at 1.6, round caps and joins. Smaller contexts (port links 13px, checklist marks 12px at stroke 2) scale the same drawing.

### Terminal
The terminal page is always dark regardless of system theme: a slim top bar with a "Back to Yardbell" button and the session name, xterm.js filling the rest in JetBrains Mono (14px, 13px on touch devices), and on coarse pointers a scrolling row of 40px key buttons (Esc, Tab, Ctrl, arrows, Enter, Ctrl-C) with a lit state for the latched Ctrl. Its colors are currently hard-coded in the page rather than drawn from the token set.

### Tab Bar
The desktop app's one row above the content: 36px tall, full width, on Rail with a 1px Rule along the bottom, light or dark with the system. Tabs are 13px/500, at most 220px wide each, and share the width as more open, never wrapping; a 1px Rule separates them, and a long name ends in an ellipsis with the full name in the tooltip. Dashboard comes first and keeps its natural width; session tabs read "folder · machine". An inactive tab is Muted Slate; hover fills Hover Slate and raises the text to Ink 2. The selected tab has no bottom rule and a 2px Signal Blue top edge, so it joins the page below it and stays marked in both themes: the Dashboard tab is Paper with Ink text, and a session tab takes the terminal's fixed top bar colors in either theme (#0f1012 fill, #ededef text), since the terminal page is always dark. A selected session tab keeps at least 112px so its name stays readable. Session tabs end in a 20px close button (a 12px cross, 6px radius, Rule fill on hover, #2e3137 on the dark selected tab) that shows on the selected tab, on hover and on keyboard focus, and otherwise keeps its space so names do not shift; an inactive tab narrower than 96px gives that space to its name. A click selects; the close button or a middle click closes. Overflowing names are clipped to their tab. No shadow.

### Menu Bar Panel
The macOS app's left click on the menu bar icon: a 340px borderless window under the icon, kept 8px inside the screen, on Paper with a 1px Strong Rule edge and 12px padding, light or dark with the system. The main view stacks three blocks 12px apart. **Machines** (12px/600 Muted Slate title) is a Rail card with a 1px Rule and 8px radius holding one button row per machine: the state dot, the name at 600, "up" or the red down reason on the right, then a Memory line and a CPU line on a 52px label, bar, 96px value grid. Memory uses the Memory Bar drawing; CPU is a single Memory Gray fill of the 1-minute load per core, capped at 100%, with the raw load in its tooltip; both turn Caution Amber at 85% and Fault Red at 95%. **Sessions** lists the openable sessions as 32px rows named like their tabs, with the Working chip on busy ones; the list scrolls past 288px. The bottom row, under a 1px Rule, holds New session, Open Yardbell (primary) and a 32px gear button. The gear swaps in the settings view: a back arrow beside a 14px/600 "Settings" heading, Rail cards of 32px switch rows (28 by 16px, Signal Blue when on) under **Notifications on this Mac** and **Startup**, and a bottom row with Disconnect and Quit Yardbell in Fault Red text. Esc goes back, then closes; the panel closes when it loses focus and reopens on the main view. Linux keeps the native menu, since its tray reports no clicks.

## Do's and Don'ts

### Do:
- **Do** separate regions with 1px Rule borders and the Paper to Rail tonal step.
- **Do** keep exactly one Signal Blue filled button per view region, placed last in its row.
- **Do** pair every status dot or tinted bar with a word naming the state, set in the matching text color.
- **Do** set branches, ports and commands in JetBrains Mono and keep all numbers tabular.
- **Do** draw resource figures to scale (the memory bar) instead of reporting them as percentages alone.
- **Do** design every state a machine or session can be in: connected, timed out, last known, outside tmux, tunnel down, empty.
- **Do** define both light and dark values for any new color token.
- **Do** use inline stroked SVG icons at 16px with stroke 1.6.

### Don't:
- **Don't** put shadows on in-flow surfaces; shadows are for dialogs and toasts only.
- **Don't** introduce a second accent hue, or use green, amber or red for anything but state.
- **Don't** build the page out of cards floating on a gray canvas; the main canvas is Paper and structure comes from rules.
- **Don't** add gradients, glows, mascots or motion for its own sake. The only loops are the Working pulse (stopped under reduced motion) and the setup step spinner, and both report live work.
- **Don't** add a display typeface or a heading larger than 20px; the page title is the top of the scale.
