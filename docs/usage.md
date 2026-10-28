# Using Yardbell

A tour of the pages: dashboard, new sessions, Workspace, the terminal, adding machines, Settings and Dispatch.

## Using Yardbell

### Dashboard

The page is grouped by machine. Each machine gets a section: its health on top (connection, load,
memory drawn to scale, amber from 85% and red from 95%), its sessions below. The memory bar covers
the whole machine, split into your agents (blue), your other processes (light blue), other accounts
and free. On a machine shared with other people, a line under it lists the accounts using the most
memory, yours included, and when your account has its own memory limit another line shows how much
of it you use. The memory warning goes by whichever is fuller, the machine or your limit, and
Dispatch counts only the room your limit leaves when it picks a machine.
The sidebar lists the machines, problems first, with a session count; click one to show only that
machine. Every page updates by itself as soon as Yardbell has checked a machine, and a session you
stop leaves the list at once.

- **Top bar:** search sessions by folder, branch, ticket or agent (press `/`), show All, Working or
  Idle sessions (an agent waiting for you shows **Needs you** and counts as idle), **Refresh** to check every machine right away, Add machine and New session.
- **Machine header:** fold the section away, **+** starts a new session on that machine, the terminal
  button opens a plain shell there (no agent, in its own tmux session), and the **⋯** menu has
  Machine settings, Copy ssh command and Remove machine.
- **Sessions** show folder, ticket, branch, agent, status and ports. Click a row (or press `Enter`) to
  open its terminal, use `j` and `k` to move, and `n` to start a new session. On a phone, a card
  opens only with its **Open** button, so Stop and the other buttons are easy to hit.
- **Pull requests:** a session whose branch has a pull request on GitHub shows its number and state
  next to the branch: CI failing, changes requested, CI running, approved, CI passing, merged or
  closed. Hover it for the title and the checks that failed, click it to open the pull request.
  Yardbell asks `gh` on the session's machine every two minutes or so; without `gh`, or without a
  pull request, there is simply no badge. See [`pull_requests`](configuration.md#pull_requests-optional).

Sessions started outside tmux, and sessions that ended, fold into the footer of their machine's
section, since Yardbell can see them but cannot attach to them. Open the list and press **Move to
tmux** on one: Yardbell stops that agent (it asks first) and starts it again in tmux with its resume
command, so the conversation continues, then opens its terminal. The terminal it ran in before gets
its prompt back.

### New session

![New session dialog with branch picker](screenshots/new-session.png)

1. Pick a machine and an agent. The list holds the agents installed on that machine, and the one you
   used last is preselected. **Other agent…** shows the rest, marked as not found there, and
   **Add an agent…** saves a new one by its name and command.
2. Pick a folder from **Recent** or browse the machine. Git repositories show their branch.
3. For a git repository, stay on the current branch, pick another branch, or create a new one from
   a base. Any branch other than the current one opens in its own worktree at
   `<repo>-worktrees/<branch>`; an existing worktree for that branch is reused.

The footer always says where the session will start. Yardbell starts the agent inside a new tmux
session through your login shell, so your PATH and environment apply, then opens its terminal.
**Continue the last conversation** and **Resume** on an ended session use the agent's own resume
command, listed below. Starting an agent in a folder that already has a session starts a second
one, named like the first with `-2` after it.

### Workspace

The **Workspace** page shows terminals side by side. Its sidebar lists every terminal as a tree:
machine, then folder (a workspace), then the sessions in it, each with its state. A session with a pull request shows its number, colored by its state, and
the full state on hover. Click a workspace
to switch to it and a session to open it in the focused pane. Hover a session for its **⋯** menu,
which opens it to the right of or below the focused pane, or in a new tab. Each workspace has tabs: **+** opens the New
session dialog in that folder and the new session in a tab of its own, and closing a tab with
sessions in it asks whether to stop them or keep them running. Double-click a tab to rename it, or
right-click it for Rename tab and Close tab. When the tabs do not fit, scroll the row with the mouse
wheel, a trackpad or a swipe, or click the arrow button at its end for a list of every tab. The tab
you switch to always scrolls into view, and a tab's tooltip shows its full name.
An empty pane offers to start an
agent there or to open one of the workspace's sessions. Panes split right or down and resize by
dragging the border between them; **Keyboard shortcuts** in the sidebar lists the keys. On a phone
the sidebar comes first and a session opens full screen.

**Dispatch** sits in the Workspace too, as a panel between the sidebar and the terminals. Sessions
it starts or links to open in a pane. Hide or show it with the speech bubble before the tabs or the
button at the top of the panel; the Workspace remembers whether it was open. **Dispatch** in the
sidebar menu opens the full Dispatch page. The sidebar menu is the same as on every other page,
with **Dashboard** first.

Click a machine's name in the sidebar to fold its folders and sessions away. Drag the right edge of
the sidebar or of the Dispatch panel to resize it, and double-click the edge to reset it. The
sidebar keeps the same width on every page.

### Terminal and phone

<img src="screenshots/phone.png" alt="Yardbell on a phone" width="320" align="right">

Turn on the mesh VPN on your phone and open `http://<host-mesh-ip>:4000`. Everything works the same,
including the terminal. Several devices can attach to one session. The one you are using sets the
session's size: opening it, clicking in it or typing takes over, and a tab you cannot see or a
phone in the background never does.

On a phone the machines stay on top, sessions become cards, and the terminal gets a key row for Esc,
Tab, Ctrl, the arrows and Ctrl-C. Yardbell follows the system light or dark setting, or the theme
you pick with the button in the sidebar, on each device.

<br clear="right">

**Copying from the terminal.**

- **Drag to select.** With tmux mouse mode on (`set -g mouse on`), tmux makes the selection and
  sends it to your clipboard when you let go. Yardbell asks tmux to do this for its terminal.
- **Shift-drag** (Option-drag on a Mac) selects in the browser instead, and copies when you let go.
- **Copy text** in the header shows the screen as plain text. Select any part of it, or press
  **Copy all**, which copies everything and takes you back to the terminal. **Close** or Esc goes
  back too. On a phone, this is the way to copy.

Browsers only allow automatic clipboard access on `https` pages or `localhost`. Over
`http://<host-mesh-ip>` Yardbell copies straight away when it can. If the browser blocks it, a
**Copy** button appears for a few seconds; tap it to finish copying. If the browser refuses that
too, a message points you to **Copy text**.

### Add machine

![Add machine flow](screenshots/add-machine.png)

Pick a peer from your mesh (phones and tablets are hidden) or type an IP or hostname, then enter the
username and a short name. Yardbell checks each step and stops with the reason when one fails:
reachable, ssh key login, the `~/.ssh/config` entry (shown before it is written, backed up first,
never overwriting an existing `Host`) and installed tools. Then it lists that machine's folders,
starting from the usual project folder when it finds one: click through to the folder that holds
your projects and press **Use this folder and save**. The new machine gets a port prefix, and the
last step says which port its apps open at on the host.

### Settings

![Settings page](screenshots/settings.png)

Settings shows one section at a time; pick it from the section list (a row of buttons on a phone).

- **Machines:** edit ssh host, mesh address, port prefix, project folder and VPN override, or remove
  a machine. Each remote machine says what its port prefix means in real ports, for example port
  3000 opening on the host at 13000, see [Ports](running.md#ports).
- **Mesh VPN:** choose a provider and press **Check addresses**. Yardbell reads the new VPN's peer list
  and proposes each machine's new address. **Switch VPN** saves `yardbell.yml` and updates the matching
  `HostName` lines in `~/.ssh/config`, with backups of both. If the host's own address changes,
  restart Yardbell (a button does it when Yardbell runs as a service).
- **Connect a phone:** shows a pairing code for the Android app.
- **Notifications:** which notifications the Android app shows, and whether it is connected, see
  [Phone notifications](apps.md#phone-notifications).
- **Dispatch:** your own instructions for Dispatch, the agent it starts, the model it runs on and
  whether it asks before each step, see [Dispatch](#dispatch).
- **Triggers:** start a saved task on a schedule, or for a Linear or GitHub ticket that comes your
  way, see [Triggers](#triggers).
- **Agent tools (MCP)** and **MCP servers:** turn on Yardbell's MCP server and list other MCP
  servers for the sessions it starts, see [Agent tools (MCP)](agents.md#agent-tools-mcp). Their
  tokens go in **Secrets** under the list: add, replace or delete one by name, and refer to it as
  `${secret:NAME}`. A saved value is never shown again. When `yardbell.yml` still holds tokens
  itself, **Move to secrets** moves them, see [Secrets](configuration.md#secrets).
- **Appearance:** same as the device, light or dark, like the theme button in the sidebar.
  **Terminal** picks light or dark for terminals on its own, or follows the theme.
- **Security:** change the passcode (takes effect immediately) and log out every other device.
- **About:** which Yardbell the server runs: its version and build, the machine, system and
  architecture it runs on, how long it has been running, and where its config and state live, with
  links to this version's release notes, the changelog and the docs. Opening it asks GitHub for the
  latest release (at most once an hour) and says **Up to date** or which version is available.
  Nothing is installed for you. In the desktop app it also shows the app's own version, with a
  warning when the app and the server it is connected to run different releases. The version next
  to "Running on" at the bottom of the sidebar opens this section, and so does **About Yardbell**
  in the desktop app's tray menu.
- **Undo** restores the previous `yardbell.yml` and `~/.ssh/config` after any change.

### Dispatch

![Dispatch page with a conversation](screenshots/dispatch.png)

The **Dispatch** page takes a task in plain words, like "fix the flaky checkout test in acme/web on a
new branch eng-1234-checkout-flake". It runs Claude Code on the host (`claude -p`) with only
Yardbell's own tools, so it can look at machines, folders and sessions and start, read and answer
sessions, but cannot change files itself. It picks a machine that is up and has the repository,
preferring the most free memory, the lowest load and the fewest running agents, then proposes
starting the default agent there with your task. Follow-up messages continue the same
conversation, for example "what is that session doing now?" or "tell it yes".

Dispatch asks before it acts. Each step that starts, stops or types into a session appears as a
card with the machine, folder, branch, agent and task (or the text to type), and waits for you:

- **Approve** runs it. The card then says what happened, with **Open** for a session it started.
- **Edit** lets you change the machine, folder, branch, agent and task, or the text, and then
  approve it with your changes. The card keeps what Dispatch proposed.
- **Reject** drops it.

With several steps waiting, **Approve all** and **Reject all** decide them together, one after
another. Sending a new message withdraws the steps you have not decided on, so Dispatch can
propose again with what you wrote, and every message tells Dispatch what happened to its steps
since its last reply. A conversation in the list says how many steps wait for you. To let Dispatch
go ahead without asking, as earlier versions did, change **Before Dispatch starts, stops or types
into a session** in Settings; its steps still show up as cards, marked as run without asking. The
same setting can refuse every step unless a rule allows it.

**Rules** under that setting decide some steps differently, for example "Stop a session, Any
machine, Deny" or "Start a session, devbox, acme/*, Allow". Each rule picks a step, a machine and
optionally a folder (a name from the folder list or a path, with `*` for any part of a name), and
then allows it, asks you, or denies it. Deny always wins. Otherwise the rule that names the most of
step, machine and folder wins, so the order of the list does not matter. A card that a rule
decided says so at the bottom, like "Your rule: start sessions on devbox in acme/*". A denied step
never becomes a card: Dispatch is told which rule refused it and says so in its reply.
**Groups** start several sessions as one step, for example "try three approaches to this bug" or
"run the same task in api and web". Dispatch proposes them with its `start_group` tool, and they
appear as one card: each child has its own label, machine, folder, branch, agent and task. Your
rules decide each child on its own, so one can start at once, another wait for you and a third be
refused, with the rule that refused it shown in its row while the others go on. Each waiting child
has its own **Reject**, **Edit** and **Approve**, and **Approve all** or **Reject all** at the
bottom of the card decide every child still waiting. Two children in the same checkout must work
on different branches.

Each child's task ends with a request for a short result block (`YARDBELL RESULT`, then `status:`
done, partial or failed, `summary:`, `branch:` and a line per detail, then `END RESULT`). The card
shows each child's state as it runs: working, needs you, done or ended. A child that asks a
question also gets a session card, so you can answer it from Dispatch. When every child that
started is done (it went quiet after working, or it ended), or when the group's time is up (60
minutes by default, counted from when the last child was decided), Yardbell reads each child's
screen and posts one **Results** card: per child the status, summary, details and branch, the end
of its screen when it wrote no result block, and **Open** and **Review branch**. A child still
waiting for an answer shows as **Needs you** and does not hold the results past the time limit.
Dispatch hears the results with your next message. When Dispatch said what it will do with them
(say, compare them and recommend one), Yardbell starts that one turn as soon as the results are
in, shown as a message sent by Yardbell, unless the conversation is answering or has steps waiting
for you. A group started in such a turn never starts another turn on its own. Groups keep going
after a restart.

Every conversation is kept in a list beside the chat, also after a restart, so you can go back to
one or delete it; **Clear all** deletes every conversation that is not still working. Deleting a
conversation never stops the sessions it started. Claude Code must be installed and signed in on
the host.

Dispatch also watches the pull requests of your sessions. When a session's CI goes from passing or
running to failing, or a reviewer leaves a comment, a review or asks for changes, a card appears in
the conversation that follows that session, or in a new conversation named after the pull request,
which then follows the session. A CI card lists the failed checks, with a link and the last lines
of the failed log when GitHub Actions has them. A review card shows each comment, with its file and
line for a comment on the code. **Send to session** types a short instruction into the session,
like "CI failed on test for pull request #12: error: test failed. Fix it and push.", shown on the
card before you send it. It is a step like Dispatch's own, so your rules for typing into sessions
apply: it is sent at once, waits below for you to approve or edit it, or is refused. Each failure
(one commit) and each comment gets one card, also after a restart, and a pull request seen for the
first time only sets what is known, so old comments never turn into cards.

#### Triggers

A trigger starts a Dispatch conversation from one of your saved tasks without you typing it. Add
one under **Triggers** in Settings: give it a name, pick the task, and pick when it starts.

- **On a schedule:** every day or on weekdays at a time, every few hours (counted from midnight,
  so every 4 hours runs at 00:00, 04:00, 08:00 and so on), or a cron expression. Times are in the
  time zone of the machine Yardbell runs on, which the section names. A time the clocks skip in
  spring runs when they jump, and a time they repeat in autumn runs once.
- **For Linear tickets:** when a ticket is assigned to you, or one of your tickets moves into a
  state you name, like In Progress. Yardbell reads your open tickets every 3 minutes through
  Linear's API, with your API key saved as the secret `linear`.
- **For GitHub issues and reviews:** when an issue is assigned to you, or a pull request asks for
  your review. Yardbell asks the GitHub CLI `gh` on its own machine every 3 minutes, as the
  account `gh` is logged in with.

A ticket trigger fills the ticket into the task: write `{ticket}`, `{title}`, `{url}`, `{state}`
or `{repo}` where each goes, for example "Start a session for {ticket} ({title}) on a branch named
after it. {url}". A task without them gets the ticket added at the end. Each ticket starts one
conversation per event, also after a restart, and the tickets that already match when a trigger
starts watching (when you add it, change what it watches, or turn it back on) are left alone.

A triggered conversation runs like one you typed: each step follows your Dispatch rules, so nothing
starts, stops or types into a session unless the rules allow it, and steps that ask wait for you.
It is named after the task, marked with a clock in the list, and opens with **Started by the
trigger** and its name, what set it off and when, with **Turn off** to stop the trigger from there.

A trigger never stacks runs: while its last conversation is still working, a scheduled time is
skipped and new tickets wait for the next check after it finishes, one ticket at a time. When
Yardbell was not running at one or more scheduled times, it runs the task once when it is back,
and the conversation says which time it is late for. Each trigger's row in Settings shows the next
run, the last run with a link to its conversation, and anything wrong, such as a missing secret or
`gh` not logged in. **Run now** starts a scheduled task at once, and **Check now** asks Linear or
GitHub at once. The switch turns a trigger off or on.

Dispatch follows the sessions it starts. When one finishes, stops to wait for an answer, or ends,
the conversation gets a card with the last lines of its screen. A waiting agent's choices, such as
Yes and No on a permission prompt, become buttons that answer it, and the card keeps the answer you
picked. A finished or ended one has **Review branch**, which prepares a reviewer: a new session in
the same folder that reviews the branch against the one it was made from, runs the tests and
changes no files. Start it as it is, or edit its agent or instructions first. When the reviewer
finishes, its findings come back as a review card with a verdict (ready, or changes needed), a
summary, and each problem with its file and severity. Tick the ones that matter and **Send** them
to the session that did the work, which gets them as one request to fix them and run the tests, or
**Dismiss** the review. Asking Dispatch to review a session proposes the same reviewer. A list at
the top of the conversation shows every session it started and what each is doing now.

A review card also has **Changes**, the branch's diff against the base the reviewer compared with.
The reviewer names that base in its report; when it does not, Yardbell uses the same rule the
reviewer is given (the branch it was made from, usually `main`, or `origin/main` on `main` itself)
and diffs from the commit the branch shares with it. Changes not yet committed and new files are
included, because the reviewer sees them too. Open it for the list of changed files with their
added and removed lines, and open a file to read its diff, loaded one file at a time. Long diffs
show 400 lines at a time with **Show more**, a diff over 2 MB is cut, binary files and renames are
named rather than drawn, and at most 500 files (100 of them new) are listed. A finding's
`file:line` is a link that opens that file at that line. The diff is read with `git` on the
session's machine when you open it, never changes anything there, and shows the folder as it is
now: when the branch has new commits since the review, it says so.

When the reviewed folder has an app running on one of its ports, the reviewer is told where it is
and that it may attach screenshots: it saves PNG files in a folder inside `.git` (so the branch does
not change) and names them on a finding's line. When the review finishes, Yardbell copies them
into its own state, at most 6 per review, 2 MB each and 24 MB per conversation, and the finding
shows a thumbnail that opens full size. A screenshot that could not be kept says why. The copies
stay with the conversation after a restart, or after the worktree is gone, and are deleted with
it. Findings you send back carry the screenshot's path, so the session can open the same file.

**Scan** looks through a whole folder instead of a branch's changes, for one kind of problem:
**Dead code** (functions, modules, routes, assets and config nothing uses), **Test gaps** (important
code without tests; the scanner finds the project's test command and runs it) or **Security**
(secrets committed to the repository, injection, unsafe deserialization, routes without auth
checks, and dependency advisories from the ecosystem's audit tool when it is installed). Start one
from **Scan** on a finished or ended session's card, which scans that session's folder, or from
**Scan** in the message box, which asks for a folder Yardbell knows, optionally a folder inside it,
and the kind. Asking Dispatch to scan a folder proposes the same scanner through its `scan_folder`
tool, and your Dispatch rules decide it like a review (the rules call it **Start a scan**). Each way,
the scanner is a new session in that folder that you start from its card, told to change no files,
install nothing and run nothing that writes to the folder. Its findings come back as a scan card
with the count of issues found (or **Clean**), a summary and each finding with its severity and
`file:line`. Instead of **Changes**, a scan card has **Files**: the files its findings point at,
read from the folder as it is now, 400 lines at a time, and a finding's `file:line` opens its file
at that line. Only those files can be read, and never through a symbolic link or outside the
folder. Pick the findings that matter and **Send** them to a session working in that folder, or
pick **A new session** to prepare one with the findings as its task.

Reviewers and scanners cannot edit files when their agent has a way to stop it: Claude Code starts
with `--disallowed-tools 'Edit,Write,NotebookEdit'`, and Codex with `--sandbox read-only`. Resuming
in a folder whose last session Yardbell started was a reviewer or scanner adds the same flags, and
starting a normal session there ends that. Claude Code can still run commands, so its prompt still
asks it to change nothing. Other agents are read-only by instruction only, and the step's card says
so before you start it.

A task with independent parts, such as two repositories or several tickets, gets one session per
part. Ask it to work through tickets and it reads them first, proposes a numbered plan (machine,
folder, agent and branch for each) and starts nothing until you agree. Dispatch can use the MCP
servers listed under **MCP servers** in Settings, so with Linear added there,
**Plan my Linear tickets** reads your open tickets and plans them.

The **Claude usage** card at the bottom of the main sidebar shows how much of your Claude plan's
5-hour and weekly limits is used, and when each resets. Every 5 minutes Yardbell asks Anthropic for
the same figures Claude Code's `/usage` shows, using the Claude Code sign-in on the machine running
Yardbell (`~/.claude/.credentials.json`, or the Keychain on macOS), so every session on that account
counts. It only reads the sign-in and never renews it; when the sign-in has expired because Claude
Code has not run for a while, the card keeps the figures from Dispatch's last reply and says how old
they are. A limit whose reset time has passed shows as reset until the next check. The circular
arrow on the card checks right away; when it cannot, the card's tooltip says why.

The **Tasks** list in Dispatch's sidebar sends a task in one click. Eight come with Yardbell:
**What's going on?** summarises every machine and session, **Who needs me?** lists the sessions
waiting for an answer, **Plan my Linear tickets** plans your open tickets, **Review finished
branches** proposes a reviewer for each branch of an idle or ended session, **Tidy up
sessions** suggests which sessions to stop, and **Security scan**, **Dead code scan** and **Test
gap scan** propose a scan of each repository, once per repository. Name folders in the same message
to scan only those. **New task** adds one of your own, which you can edit, rename or delete;
the copy button next to a default starts a task of your own from its text. Deleting a default
only hides it, and **Restore default tasks** brings the defaults back. **Save as task** in the
message box keeps whatever you typed.

In the message box, **Enter** sends and **Shift+Enter** starts a new line; **Ctrl+Enter**
(**⌘+Enter** on a Mac) sends too. In a wide window, click the hint beside the Send button to send
with Ctrl+Enter instead, so Enter starts a new line; the browser remembers the choice. On a phone,
Enter starts a new line and the Send button sends. Type **/** to pick one of your tasks, or **@** to
name a machine, session or folder, or use the **Tasks** and **@** buttons in the box: the arrow keys
move through the list, **Enter** or **Tab** picks, and **Esc** closes it. A picked task's text goes
into the box, so you can change it before sending. What you type is kept for each conversation
until you send it, also after a reload, and **Arrow Up** in an empty box brings back your earlier
messages. While Dispatch is working, **Stop** takes the place of Send; it stops Dispatch's reply,
and the sessions it started keep running.

The **Dispatch** section of Settings adds your own instructions to its prompt (where your
repositories live, which machine suits which work, how you name branches), picks the agent it
starts in new sessions from the ones installed on your machines, picks the Claude model that
runs Dispatch itself (Haiku is the fastest), and chooses whether Dispatch asks you to approve each
step, goes ahead without asking or is refused, with rules for the steps that should be decided
differently.
