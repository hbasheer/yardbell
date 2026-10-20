---
version: 1
slug: "assets-dashboard-html"
primary_target: "assets/dashboard.html"
related_targets: ["assets/dashboard.js","assets/style.css"]
---

# Surface: Yardbell dashboard (assets/dashboard.html, dashboard.js, style.css; also login, add machine, terminal)

Mode: Operate. Used equally at a desk (browser beside terminals on one monitor) and on a phone.

## Direction contract
FORM: the category standard, chosen by the user over the roll (seed:39cb9f81fd5c3768, canon). Bar: Linear, Vercel dashboard, Tailscale admin, GitHub.
THESIS: machine health first, then sessions, then where to test; one glance answers all three.
FIRST VIEWPORT: left sidebar lists every machine with status dot, connection text and a memory bar (used / total GB, Claude share, amber past 85%); main area is a sessions table (machine, folder + branch, ticket, status, ports, actions) with New session and Add machine in its header. Phone: machines become a horizontal strip, the table becomes a stacked list.
SIGNATURE: the memory bar per machine drawn to scale, with the Claude share marked, so "where is there room" is answered without reading.
SYSTEM: white / slate neutrals, one blue accent for primary action and selection, semantic green / amber / red only for state; Inter for UI, JetBrains Mono for branch, ports, numbers; 1px rules, 8px radius, no shadows except overlays; light and dark.
RISK: ends up as an anonymous template; craft must come from alignment, type scale, state completeness and the memory bar, not ornament.
