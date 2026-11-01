# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com)
and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

- **Run a command.** This pipeline step runs a saved shell command in the run's worktree, with no agent
  and no tokens. Exit 0 follows the pass line and anything else follows the fail line, so code rather
  than an agent's word decides. The end of its output is the step's report, so a Fix step can read it
  with `{report}`. A command an agent proposed runs only after you accept its exact text, and the
  Dispatch rule action `run_command` can refuse it by machine or folder. The step can never pass unless its
  command ran in that attempt. After a real failure only a person on the run's page can continue on pass,
  and the run records the override.
- **Sign in to tools.** **Settings, Connections** now connects a tool through its MCP server by signing
  in with your browser. **New connection** has **Sign in**, **MCP server** and **Token** tabs, and lists 23
  common tools. Trello, Jira and Sentry have been tried with real accounts; the list says the rest have
  not. Signing in from a phone works through a box to paste the address into.
- **Use a connected tool.** This pipeline step does one action in any connection with no agent, replacing
  Call API. A step that changes something can be refused by a Dispatch rule, and a run waits if the server
  changed the tool. Trello can also start runs through its sign-in.
- **Tickets from any connection.** **New ticket** starts a run from Linear or any connection, **Update the
  ticket** moves or comments wherever the ticket came from, and the template is now **Implement my
  tickets**. Linear is a row under **Connections**. Saved pipelines keep working.
- **One Connections page.** MCP servers, connectors, GitHub, GitLab and secrets are all on it, and the
  fields in its forms replace YAML. A token you paste is saved as a secret by itself. Removing a
  signed-in tool also removes its connection.
- **GitHub and GitLab connect your way.** GitHub through local `gh` or a token, GitLab through a token or
  local `glab`.
- **Connectors.** Pipelines can now take work from any tool with a web API and a token, set up under the
  new **Settings, Connections** with no new release. **New connection** starts blank or from an example:
  Trello, GitHub Issues, GitLab Issues, Jira or Asana. A connector holds the
  tool's address, the secrets that log in, and its calls, with paging and field mapping. **Test** shows
  what it reads, **Share** and **Import** pass one on without its tokens, and `yardbell doctor` checks each
  one a pipeline uses.
- **A connected tool as a trigger.** A pipeline can start from a new item, or one that reaches a state, and
  **Run now** takes item ids or links. A schedule can read a connected tool too.
- **Call API step.** Reads from or changes a connected tool during a run. Changes are the rule action
  `call_connector`, so your Dispatch rules can refuse them.
- **Webhook trigger.** Another system can start a run by calling an address with its own token. Yardbell
  listens on this machine and your mesh, so an outside service needs a tunnel you set up.
- **Dispatch can propose a connection** with `save_connector`. It always waits for you, arrives switched
  off, and cannot carry a token or turn on private addresses.

## [0.9.2] - 2026-10-30

- Fixed: a Claude Code step could finish with a good result and the run still said it ended without
  one, because only what fit on the terminal's screen was read. Results are now read from the
  transcript too, and a reviewer that goes quiet is asked to print its result rather than stopped and
  started again.
- Fixed: a long summary was cut at its first line, which could lose an agent's question.
- A run with no result no longer says it needs your answer, and says what you can do. A pipeline
  notification now carries a link to its run, though the Android app does not follow it yet: tapping
  a notification opens the app.

## [0.9.1] - 2026-10-30

- **Settings, GitHub and GitLab** replaces Pull requests. GitHub and GitLab each have their own
  switch and say what they need, each GitLab host shows whether its token works, and **Your folders**
  says which service each folder's `origin` uses, with a button to add a GitLab host it is missing.
- **Delete this run** now works on a run in any state: it stops the run, stops its sessions, and then
  removes its record. The worktree, branch and any pull request stay.
- The terminal on the run page is closed until you choose **Show terminal**, so the canvas has room.

## [0.9.0] - 2026-10-30

- **A pipeline run uses one agent session.** Its steps take turns in one session and one worktree,
  so a run holds far less memory. A review step gets its own read-only session, and a step on
  another machine or with another agent gets its own; each stops as soon as nothing needs it. When a
  run ends or is dropped, every session stops and the worktree stays.
- **Teardown command.** Worktree setup can now run a command when a run ends, such as
  `docker compose down`, so containers go too. It only runs in a worktree that run made, and is
  skipped while another session or run uses the folder. Whatever goes wrong, the run still ends and
  the run page says so.
- Pipeline sessions now have the run's id at the end of their names. A step saved as continuing a
  session on another machine now gets its own session there.
- **Stop session** on the run page makes the step wait for you instead of starting the agent again.
- Agents now copy a `step:` line into their result block, so a result is matched to the exact run
  of the step it answers.
- **Terminal on the run page.** The run's live terminal sits under its steps and follows the run you
  pick, with **Stop session**. A finished run can be deleted with **Delete this run**.
- **Pipeline notifications in Settings.** Phone notifications has switches for **Pipeline needs
  you**, **Pipeline finished** and **Proposals**.
- **Pull requests in Settings.** A new section switches badges and Dispatch cards on or off, sets how
  often they are checked, adds GitLab hosts with a token from your saved secrets, and shows whether
  `gh` and each token work. A session with no badge because of a problem now says **No PR info**, with
  the reason.
- **Tab bar on a phone.** The pages sit in a bar along the bottom of the screen, as in a phone's own
  apps, so the header no longer collides with the menu. It hides while the keyboard is open.
- Fixed: the run page could not scroll on a phone or tablet.
- Fixed: Delete on a pipeline did nothing in the desktop app, because the page used a dialog the
  app's webview does not have.

## [0.8.0] - 2026-10-30

- **Pipelines** carry tickets and merge requests through steps you define, and stop only when they
  need you. A pipeline has a trigger (by hand, a schedule, a Linear ticket, a GitHub review request,
  or a GitLab merge request that adds you as reviewer) and steps: agents with your instructions,
  Plan (Dispatch picks the machine, folder and branch), push and draft pull or merge request, move
  or comment in Linear, a report to you, and wait for me. Each step's pass, fail and needs-you lines
  go to another step, so a review can loop back to a fix. Two templates ship: **Implement my Linear
  tickets** and **Review my merge requests**. The new **Pipelines** page lists them with what waits
  for you and opens each one full screen on a canvas: build it from nothing or a template by
  dragging steps from a library and drawing lines between their pass, fail and needs-you dots,
  edit each step beside the canvas, follow every run on the same canvas with its reports, and look
  back through every saved version. Its settings write the new `pipelines` section of
  `yardbell.yml`. `yardbell doctor` checks what each pipeline
  that is on needs.
- **Dispatch can read all of Yardbell.** New read tools on Yardbell's MCP server, for Dispatch and
  any connected client, return each area of Settings (with what it may be set to), Dispatch
  conversations, saved tasks, pipelines and their runs, Insights, pull and merge requests with
  their CI, and usage. They change nothing, and no secret is ever shown: a setting that uses one
  shows its `${secret:NAME}` reference, any other credential shows `(hidden)`.
- **Dispatch can change Yardbell's settings, tasks and triggers.** Ask in plain words and Dispatch
  proposes a card: the settings area before and after as a word diff, a task's new text, or a
  trigger to run now. Settings' own checks run first, so a mistake goes back to Dispatch rather
  than to you. **Edit** changes the value on the card, **Open in Settings** goes to the section,
  and Settings' **Undo** reverses a saved change. Saved credentials stay saved: a `(hidden)` value
  sent back as it is keeps them, and none ever reaches a card or a conversation. Changes to
  Dispatch's own settings always wait for you; a rule can refuse them but never let them run
  alone. Dispatch rules can name the new steps `change_settings`, `save_task` and `run_trigger`.
- **Dispatch builds and runs pipelines.** Ask for a pipeline in plain words and Dispatch proposes it
  drawn small on a card, with the steps, lines and wording that changed. It always waits for you,
  and **Edit in the builder** opens it in the builder, where saving approves it. Dispatch can also
  switch a pipeline on or off, start runs on tickets or pull requests, and answer, retry, continue
  or drop a waiting run, each as a card your rules decide. The builder's **Ask Dispatch to change
  it** starts that conversation for you. A run's own Dispatch turn can never change settings,
  pipelines or runs, so a ticket's text cannot approve its own run.
- **Proposals inbox.** MCP clients other than Dispatch, such as Claude Code with Yardbell added,
  can now ask for the same changes. Each one is checked, then waits on the new **Proposals** page
  (in the sidebar, with a count) until you approve, edit or reject it; your phone says one waits.
  Your rules can refuse them, but never let them run alone. Delete a proposal, or clear the decided
  ones; they are kept in `proposals.json` in the state folder for 30 days after a decision.
- On a phone, Settings and Log out in the header show as their icons, to make room for Pipelines.

## [0.7.10] - 2026-10-29

- Dispatch's cards are shorter and easier to read. A review or scan groups its findings under
  **High**, **Medium** and **Low**, each leading with what is wrong and its `file:line` underneath;
  low findings start folded and unticked, and the button says **Send 4 findings** instead of the
  session's name. A session card shows the last four lines of its screen until you open the rest. A
  CI card folds each failed check to its name and the line that says what broke, with the log one
  click away, and the instruction **Send to session** types sits under **What it sends**. Cards name
  the folder instead of its whole path, which shows on hover.

## [0.7.9] - 2026-10-29

- **Insights** shows a session's pull request or merge request under its facts: the number and
  title as a link, the state the badge shows, and where CI and the review stand. Its timeline says
  what happened to it while the session ran: opened (or already open), marked ready for review,
  approved and by whom, changes asked for, comments (with file and line for a comment on the code),
  merged or closed, each linking to the pull request or the comment.
- GitLab merge requests get what GitHub pull requests get: a badge next to the branch on the
  dashboard and in the Workspace, such as `!12` with its pipeline and review state, and a card in
  Dispatch when the pipeline starts failing (with the failed jobs and the end of their logs) or a
  reviewer comments (with file and line for a comment on the code), with **Send to session**. List
  each GitLab host under `pull_requests.gitlab` with a `read_api` token saved as a secret; Yardbell
  tells GitHub from GitLab by the remote each branch pushes to, and asks GitLab's API from its own
  machine. `yardbell doctor` signs in to each GitLab host and names the account or the problem.

## [0.7.8] - 2026-10-29

- The Dispatch page is laid out like an app on a wide screen: a column beside the chat with
  **Chats** and **Tasks** tabs and **+** for a new conversation, and a header with the open
  conversation's title, the agent and model it runs on, and **Settings**. Only the conversation and
  the list scroll, each on its own, so the header and the message box stay in view. The eight
  default tasks no longer push the conversations aside, and the page no longer repeats the
  Dashboard link the sidebar has.
- The README and the guide show the new Dispatch page and the Workspace with its Dispatch tabs.

## [0.7.7] - 2026-10-29

- The Workspace sidebar matches the other pages: the same header with the collapse button beside
  the name, the theme button and the VPN line in its menu, and no second Dashboard button.
  Collapsed, it shows only icons, where its menu used to show cut-off words.
- Dispatch in the Workspace panel, and on a phone, shows **Chat**, **Chats** and **Tasks** as tabs
  instead of boxed lists stacked above the chat. The tabs stay at the top while a conversation
  scrolls, and say how many conversations and tasks there are.
- **Insights** opens in a larger dialog, up to 880px wide and 920px tall, that scrolls inside and
  fits small windows. Its facts (status, machine, folder, branch, agent) are labelled, **Time
  spent** shows Working, Waiting for you, Idle and Test results as tiles with units, each one's
  share of the time and a line on what it means, and the bar has its start and end times. The
  timeline is grouped under the day, so a session from an earlier day no longer crowds its times
  into the text. A session Yardbell has not recorded yet says so and when its timeline starts.
- Dispatch shows the agent and model it runs on, such as `Codex · gpt-6.1-sol`, beside its heading,
  for the open conversation or for new ones, and its intro and the note on a conversation that
  stays on its agent name the model too. The label leads to the setting.
- **Dispatch runs on** in Settings lists the agents with the names sessions show for them, marked
  when one is not found on the machine Yardbell runs on, with **Model** beside it for that agent.
  A Codex model that Codex does not list for your account gets a note. A new model applies from
  the next message, in open conversations too.
- A new guide, [Triggers, worktree setup and rules](docs/automation.md), explains when to use each,
  how they work together, and gives examples to copy: a trigger for Linear tickets, review requests
  and schedules, setup commands for Rails and Node apps, and Dispatch rule sets from careful to
  hands off.

## [0.7.6] - 2026-10-29

- Dispatch can run on Codex as well as Claude Code. **Dispatch runs on** in Settings, under
  Dispatch, picks one, with a **Codex model** field beside it that suggests the models Codex lists
  for your account. Your approval setting, rules and memory work the same on both, and the agent
  for new sessions is still its own setting. On Codex, Dispatch acts only through Yardbell's tools
  and your MCP servers from Settings, such as Linear: Codex's shell, browser and other tools are
  off, it runs read-only, so its file edits and sub-agents cannot write, and your
  `~/.codex/config.toml` is never read. It needs Codex 0.165.0 or newer and says so when it finds
  an older one, and a message fails with a clear error when Codex cannot reach Yardbell's tools,
  since Codex itself carries on without them.
- A conversation stays on the agent it started on, and says so when **Dispatch runs on** has
  changed since. Start a new conversation to switch. Conversations from before run on Claude Code.
- The usage card in the sidebar adds Codex's 5-hour and weekly limits, as Codex recorded them after
  Dispatch's last reply on it, or says they are not available.

## [0.7.5] - 2026-10-28

- Dispatch has a memory: short entries such as where your repositories live, how you name
  branches, your conventions and your corrections ("always use the shared docker stack on hp").
  It reads them at the start of every turn, in a section of its prompt apart from your own
  instructions, which still win. Dispatch proposes a change with its new `remember` tool, to add,
  replace or forget an entry with the reason, after you correct it or tell it something that
  lasts. Each change is a card with the change as a diff, which you approve, edit or reject, and
  nothing is saved before you decide, even when Dispatch goes ahead without asking. A rule for
  **Change Dispatch's memory** can allow or deny them.
- **Memory**, under Dispatch in Settings, lists the entries to add, edit or delete, shows how much
  of its 8 KB cap is used and keeps the history of changes with dates. A change that would go
  over the cap is refused with a note to forget or shorten an entry. The memory is
  `dispatch/memory.md` in the state folder, readable only by your account.
- Dispatch tasks keep their versions. Every save keeps the text before it with its date, and
  **History** in a task's editor lists the versions, compares any two word by word and restores
  one as a new version, so nothing is lost. A default task is version 1 until you change it and has
  **Reset to the default**. Each task keeps its last 30 versions, and a tasks file from an older
  Yardbell becomes one version per task. Triggers still name the task, so they run its current
  version, and a triggered conversation, like a message sent from the Tasks list, says which
  version ran.
- **Insights** on a session row, an ended session, a Workspace pane's new **⋯** menu and a Dispatch
  session card shows the session's timeline: when it started, how long it worked, waited for you
  and sat idle, and the tool calls and test runs its screen showed, with whether each test run
  passed. Yardbell records the changes from its usual checks, keeps them across restarts and
  needs no AI for it.
- **Suggest a better prompt** asks Dispatch, as a message you send, to read a session's task and
  scrollback and propose a clearer prompt for next time. Save the proposal as a new task, or as the
  next version of the task the session came from.
- **Scan** in the Dispatch message box picks a project and then the branch to scan, from its own
  checkout or one of its worktrees, instead of listing every folder.
- Quitting the desktop app stops the SSH tunnels its server opened. They used to keep running
  after the app quit and held their ports, so the next start could not forward that machine
  (the tunnel log showed "Address already in use"). Signing out no longer lets the next machine
  check start a tunnel again either.

## [0.7.4] - 2026-10-28

- A Mac with a container port bound to a loopback address it does not have, such as `127.0.1.3`,
  no longer stalls each check for 75 seconds per port and shows as down. Each port check now
  gives up after a second.
- Dispatch can start several sessions as one group, for example three approaches to the same bug
  or the same task in two repositories, with its new `start_group` tool. The group is one card with
  a row per child (its label, machine, folder, branch, agent and task) and **Approve all**, and
  each child can be rejected, edited or approved on its own. Your rules decide every child on its
  own: a refused child stays in the card with the rule that refused it while the others go on, and
  two children in the same checkout need their own branches.
- When every child is done, or after the group's time limit (60 minutes unless Dispatch sets
  another), Yardbell reads each child's result and posts one **Results** card with each child's
  status, summary, branch, **Open** and **Review branch**. A child's task asks it to end with a
  `YARDBELL RESULT` block; a child that wrote none shows the end of its screen, and one waiting for
  an answer shows as **Needs you** without holding up the results. Dispatch hears the results with
  your next message, or, when it said what it would do with them, in one turn Yardbell starts for
  it once they are in. Groups carry on after a restart.
- A repository can have a setup command, like `bin/setup`, `npm ci` or copying `.env` from the
  main checkout, that runs in each new worktree Yardbell creates before the agent starts. Set it
  per folder under **Worktree setup** in Settings, or `worktree_setup:` in `yardbell.yml`. Its
  output is saved in the worktree's git folder and shown from the session row, which says **Setup
  ran**, **Setup failed** or **Setup timed out**. A failed or timed-out setup is stopped with
  everything it started, and the agent starts anyway and is told. Only commands saved in Yardbell
  run, never a script found in the branch.
- **Remove worktree** on a session that ended in a worktree, and in the New session dialog's
  folders and branches, runs `git worktree remove` and prunes, and can delete the branch once it
  is merged. It shows the uncommitted changes and the commits no remote has before removing them,
  and asks you to confirm that loss. It never removes a main checkout.
- **Move** on a session moves its branch, uncommitted changes and task to another machine, the one
  with the most free memory by default, as a git bundle and a patch over ssh: nothing is committed
  or pushed. The same agent starts there with a note that it continued from the first machine, and
  Yardbell offers to stop the original.
- Dispatch has four new steps under your approval setting and rules: **Integrate branches** merges
  or rebases several branches onto a new branch one at a time and stops at the first conflict with
  its files, **Push a branch** scans what it would push for keys, tokens and your saved secrets
  first and never forces, **Remove a worktree** and **Move a session**. MCP clients get them as
  `integrate_branches`, `push_branch`, `remove_worktree` and `move_session`.

## [0.7.3] - 2026-10-28

- Triggers start a saved Dispatch task without you typing it: on a schedule (daily or on weekdays
  at a time, every few hours, or a cron expression, in the server's time zone), when a Linear
  ticket is assigned to you or moves into a state you pick, or when a GitHub issue is assigned to
  you or a pull request asks for your review. Linear is read with an API key saved as the secret
  `linear`, GitHub with `gh` on the server's machine, every 3 minutes. A ticket trigger fills the
  ticket into the task with `{ticket}`, `{title}`, `{url}`, `{state}` and `{repo}`, and starts once
  per ticket and event, also after a restart. Tickets that already match when a trigger starts
  watching are left alone.
- A triggered conversation follows your Dispatch rules like any other, and opens with **Started by
  the trigger** and its name, what set it off and when, with **Turn off**. A trigger never runs
  twice at once: a scheduled time is skipped while its last run still works. After Yardbell was
  not running, a missed schedule runs once, not once per missed time.
- Settings has a **Triggers** section to add, edit, turn off and delete triggers, with **Run now**
  or **Check now**, the next run, the last run and what went wrong. Triggers live under
  `triggers:` in `yardbell.yml` and are checked when it loads.
- Dispatch can scan a whole folder, or a folder inside one, for dead code, test gaps or security
  problems. **Scan** on a session card and **Scan** in the message box prepare a scanner, a new
  session in that folder told to change no files, and Dispatch can propose one with its new
  `scan_folder` tool, which your rules decide as **Start a scan**. The findings come back as a scan
  card with the number of issues found, and **Files** shows the files they point at, read-only and
  only those. **Send** types the picked findings into a session in that folder, or prepares a new
  session to fix them. Three new default tasks, **Security scan**, **Dead code scan** and **Test gap
  scan**, scan each repository once.
- Reviewers and scanners start unable to edit files: Claude Code without its file editing tools
  (`--disallowed-tools 'Edit,Write,NotebookEdit'`) and Codex in its read-only sandbox
  (`--sandbox read-only`), also when such a session is resumed. Other agents are read-only by
  instruction, and their card says so.

## [0.7.2] - 2026-10-28

- Dispatch review cards have **Changes**: the reviewed branch's diff against the base the reviewer
  used, with changes not yet committed. It lists each changed file with its added and removed
  lines, loads a file's diff when you open it, shows long diffs 400 lines at a time, and names
  binary files and renames. A finding's `file:line` opens the diff at that line. The diff is read
  with `git` on the session's machine and changes nothing there. The reviewer now also names its
  base in the report.
- A reviewer can attach screenshots to its findings when the reviewed app is running on one of its
  ports. It saves PNG files in a folder inside `.git` and names them in its report; Yardbell copies
  them into the conversation (up to 6 per review, 2 MB each, 24 MB per conversation), shows them
  as thumbnails that open full size, and passes their paths on when you send the findings back.
- Pull requests and CI: a session whose branch has a pull request on GitHub shows it on the
  dashboard and in the Workspace sidebar, with its number and the most urgent of CI failing,
  changes requested, CI running, approved, CI passing, merged or closed. Yardbell asks the GitHub
  CLI `gh` on the session's machine, at most every two minutes per branch and apart from the
  machine check. A machine without `gh`, or with `gh` logged out, and a branch without a pull
  request show nothing.
- Dispatch posts a card when a session's CI starts failing, with the failed checks and the last
  lines of the failed log, or when a reviewer comments or asks for changes, with each comment and
  its file and line. It goes to the conversation that follows the session, or to a new one named
  after the pull request. **Send to session** types a short instruction such as "CI failed on test:
  ... Fix it and push." and follows your Dispatch rules for typing into sessions. Each failure and
  each comment gets one card, also after a restart. Turn it off, or keep only the badges, with
  `pull_requests` in `yardbell.yml`.

## [0.7.1] - 2026-10-28

- Dispatch has rules for what it may do. Each rule matches a step (starting, stopping or typing
  into a session, or starting a review, or any of them), a machine or any, and optionally a folder
  pattern like `acme/*`, and then allows the step, asks you first, or denies it. A deny always
  wins; otherwise the rule that names the most wins, so the order of the list does not matter, and
  steps no rule matches follow the setting you already had. A denied step never becomes a card:
  Dispatch gets an error naming the rule and tells you. A card that a rule decided names the rule.
  Edit them in Settings, under Dispatch, or as `dispatch.rules` in `yardbell.yml`.
- The Dispatch setting can now also refuse every step unless a rule allows it. In `yardbell.yml`
  its values are `prompt`, `allow` and `deny`. `ask` and `auto` still work, and Yardbell keeps
  writing them, so a config saved without rules or a deny is the same as 0.7.0 writes and 0.7.0
  can still read it.
- Security: tokens can live in a secrets file instead of `yardbell.yml`. MCP servers in Settings has
  a **Secrets** list where you add, replace and delete a secret by name; once saved, a value is
  never shown again, only when it was set and which servers use it. Write `${secret:linear}` where
  the token goes, such as `Authorization=Bearer ${secret:linear}`. The values are kept in
  `secrets.yml` next to `yardbell.yml`, readable only by your account, and are filled in only when
  a session's MCP config is written. When `yardbell.yml` still holds tokens, **Move to secrets**
  moves the ones you tick, and Yardbell's own MCP token and login cookie key go there too. A new MCP
  token or cookie key is always saved there.
- Security: text sent to a session, such as Dispatch's replies, review findings and the MCP
  `send_to_session` tool, no longer appears on a command line, where anyone on a shared machine
  could read it with `ps`. It goes over standard input into a tmux buffer that is pasted and
  deleted. A session scrolled back in its history is brought to the bottom first, so the text
  reaches the agent, and several lines arrive as one paste.
- Security: the command Settings shows for adding Yardbell to Claude Code no longer holds the MCP
  token. It asks for the token without showing it, so it stays out of your shell history, and
  **Copy token** copies it.

## [0.7.0] - 2026-10-28

- Security: the tokens of the MCP servers for sessions, such as a Linear API key, no longer appear
  on the agent's command line. On a machine shared with other people, anyone could read them with
  `ps` while a Claude Code session ran. Yardbell now sends the list over ssh's standard input into a
  file only your account can read, `~/.cache/yardbell/mcp/` on that machine, and gives Claude Code
  its path. Sessions that are already running keep the old command line until they are restarted,
  so restart them and replace any token that was exposed.
- Security: `yardbell.yml` and its backups are saved readable only by your account. They were
  readable by every account on the host, and they hold the login cookie key, the MCP token and the
  MCP servers' tokens.
- Desktop app: it takes tokio 1.54.1, which fixes a timer race that could crash it, and
  rustls-webpki 0.103.16, which stops trusting a CA that browsers distrust.
- Settings has an About section: the server's version and build, the machine and system it runs
  on, how long it has been up and where its config and state are, with links to the release notes,
  the changelog and the docs. It checks GitHub for a newer release, at most once an hour, and says
  "Up to date" or "0.7.1 is available" with a link; it never installs anything. In the desktop app
  it also shows the app's version and warns when it differs from the server's. The sidebar's
  "Running on" line now ends with the version, which opens About, and the desktop app's tray menu
  has **About Yardbell**.

## [0.6.9] - 2026-10-28

- The memory bar always shows the whole machine. On a server where your account has its own memory
  limit it showed only that limit (48 GB on a 125 GB machine), all of it as yours. Now a line under
  the bar lists the accounts using the most memory, such as `risal 24.9 GB · hasan (you) 7.3 GB`,
  with rootless containers counted toward the person who runs them instead of an unnamed uid, and
  another shows your account's use of its limit. The memory warning still goes by whichever is
  fuller, and Dispatch still counts only the room your limit leaves when it picks a machine.
- The Claude usage card is live: every 5 minutes Yardbell reads the same figures as Claude Code's
  `/usage` from the Claude account signed in on its machine, so all your sessions count, not only
  Dispatch's. The card says how old its figures are, and a limit past its reset time shows as reset
  instead of the old percentage. The circular arrow on the card checks right away, and when it
  cannot, the card's tooltip says why, such as an expired Claude Code sign-in.

## [0.6.8] - 2026-10-28

- The memory bar splits what is used into your agents, your other processes and other accounts, so
  on a server shared without per-account memory limits you can see that the memory is someone
  else's. The percentage and the memory alert still cover the whole machine.
- Under an account memory limit, file cache and reclaimable kernel memory no longer count as used.
  The kernel drops them when the limit is reached, so a shared dev server showed 40% when your
  processes used 12%.
- Fixed: copying from the terminal could leave it ignoring the keyboard until the session was
  opened again. **Copy all** now copies and goes back to the live terminal, Esc closes the screen
  text, and keys typed while it shows no longer reach the terminal hidden underneath. When the
  browser's own copy has to step in (over plain `http`, in the desktop app's Workspace panes, or for
  a selection tmux copies), the keyboard goes back to the terminal, and a tab or pane you are not
  using no longer takes it. When copying fails, a message says how to copy instead.
- Fixed: closing, reloading or reconnecting a terminal could type a newline and Ctrl-D into its
  session, which ended a plain shell and sent stray keys to an agent.
- Workspace: tabs that do not fit in the row are no longer out of reach. The row scrolls sideways
  with the mouse wheel, a trackpad or a swipe, fades at an edge that has more tabs behind it, and
  gets a button at its end that lists every open tab with its state, so you can jump to any of
  them. The tab you switch to always scrolls into view, whether you click it, pick it from the
  sidebar or the list, start a new session, press Alt+[ or Alt+], or reload the page.
- Workspace: tabs are 140 to 220px wide, and a long name ends in an ellipsis with the full name in
  its tooltip. Enter or Space opens the tab that has keyboard focus.
- Dispatch: the dot and label in the small chips under a message, such as **Checked machines**,
  sit in the middle of the chip again in the desktop app, which drew them 3px too high.
- Dispatch on a phone: the last lines of a conversation are no longer hidden behind the message
  box, which used to sit above its place with an empty strip under it that never scrolled away. The
  box now sits at the bottom of the screen, above the home indicator, and stays above the on-screen
  keyboard while the conversation keeps its newest message in view. It also uses larger text there,
  so an iPhone no longer zooms in when you tap it.
- Dispatch's message box works more like Commslayer's. Type `/` to pick one of your tasks, or `@` to
  name a machine, session or folder; the Tasks and @ buttons in the box open the same lists. A
  picked task's text goes into the box, so you can change it before sending. What you type is kept
  for each conversation until you send it, also after a reload, and Arrow Up in an empty box brings
  back earlier messages.
- Dispatch: Enter still sends and Shift+Enter starts a new line, and Ctrl+Enter (⌘+Enter on a Mac)
  now sends too. In a wide window, click the hint beside the Send button to send with Ctrl+Enter
  instead, so Enter starts a new line. On a phone, Enter starts a new line and the Send button
  sends. While Dispatch is working, Stop takes the place of Send.
- Dispatch asks before it acts. Starting, stopping or typing into a session is now a step in the
  conversation that waits for you: approve it, edit it first (machine, folder, branch, agent, task
  or text), or reject it, and nothing runs until you approve. Several waiting steps can be
  approved or rejected at once. Sending a new message withdraws the steps you have not decided
  on, and Dispatch hears what happened to each step with your next message. To have Dispatch go
  ahead on its own as before, change **Before Dispatch starts, stops or types into a session** in
  Settings, Dispatch.
- Dispatch: **Review branch** prepares a reviewer for the same folder, which you can start as it
  is or with another agent or instructions. When it finishes, its findings come back as a review
  with a verdict, a summary and each problem with its file and severity. Pick the ones that matter
  and send them to the session that did the work, or dismiss the review. Ask Dispatch to review a
  session and it proposes the same reviewer.
- Dispatch keeps a record of every decision in the conversation: which steps you approved, edited
  or rejected and when, what each one did, the answers you picked for a waiting session, and what
  you did with a review. The cards show it after a reload and on another device, and a conversation
  in the sidebar says how many steps wait for you.
- Conversations from earlier versions open as before, with the sessions they started shown as
  steps that ran without asking.
- Open pages update as soon as Yardbell has checked a machine. The server tells each page over a
  websocket when something changed, so a session that starts, ends or waits for you shows within
  a moment of the check, instead of on the page's own 3 to 10 second timer on top of it. A page
  that cannot open the websocket polls as before.
- After you start, stop, answer or move a session, Yardbell checks that machine again right away
  and every open page and device shows the result. A stopped session leaves the dashboard as soon
  as the stop succeeds. Before, each page asked for a check of every machine and waited for the
  slowest one.
- Each machine is shown as soon as its own check finishes, so a slow or unreachable machine no
  longer holds up the others.
- A page in a hidden browser tab, or behind another tab in the desktop app, stops fetching and
  catches up the moment it is shown again.
- The sidebar's machine list, and the Workspace sidebar, are only redrawn when they change, so a
  click or hover there is no longer lost to a refresh every few seconds.

## [0.6.7] - 2026-10-27

- On a machine shared with other people, only your own agent sessions are listed. Other accounts'
  agents showed up as yours, with an error message for a folder, and counted toward agent memory.
- A machine that limits your account's memory (a cgroup limit, as on a shared dev server) shows
  that limit and your account's use of it, instead of the whole machine's RAM, so the memory bar
  and the 95% alert match what you can actually use.
- A session whose Docker Compose file lives outside its checkout, such as one shared
  `session.yaml` started with `docker compose -f` from every worktree, shows its ports under its
  own folder. Give its containers the label `dev.yardbell.workdir` set to the checkout; without
  the label, the compose file's folder is used as before.
- On a machine whose Docker publishes ports on one address (an `"ip"` in `daemon.json`, as on a
  shared server), those ports show as running, and Yardbell's tunnel forwards to that address
  instead of `localhost`, where nothing was listening.

## [0.6.6] - 2026-10-27

- The dashboard updates only what changed on each check instead of redrawing every machine, so
  selected text, keyboard focus and the Working pulse stay put while it refreshes. It is drawn
  with lit-html 3.3.3, which ships inside Yardbell, so the page still loads without a build step.
- Dispatch: a conversation no longer runs off the right side of the window. One session screen
  with a long unbroken line, such as a rule drawn across the terminal, used to widen every message
  in the conversation past the page.
- Dispatch: when an agent asks a question with a preview box beside the choices, the answer
  buttons show only the choice, not the preview text that sat on the same line.
- Dispatch: session cards are easier to read. The session name, its machine and folder, and a
  status badge sit at the top; the screen below wraps long lines, drops the lines drawn only to
  frame the terminal, and is set in larger type on the page's own colours instead of a black box.
- Dispatch is drawn with lit-html too, so a new session card or reply is added without redrawing
  the conversation, and an open step or an answered question stays as it is.

## [0.6.5] - 2026-10-26

- The sidebar has one width on every page, 256px to start. Drag its right edge on any page to make
  it wider or narrower, from 220 to 480px, and every page follows; double-click the edge to reset.
- Workspace: each machine in the sidebar folds with a click on its name, shown by a chevron, and
  stays folded. Long folder names end in an ellipsis instead of scrolling the sidebar sideways.
- Workspace: the Dispatch panel resizes from its right edge too, from 300 to 640px, and its message
  box stays at the bottom of the panel however short or long the conversation is.
- Workspace: Dispatch in the sidebar menu opens the full Dispatch page, and is marked as the
  current page only there; the speech bubble and the panel's own button show and hide the panel.
- On a phone, the header no longer covers the Yardbell name: the Dashboard link added to the menu
  in 0.6.4 stays out of it there, since the name and the back links already lead home.
- The README and the guide show the 0.6.4 look, with Dispatch in the Workspace.

## [0.6.4] - 2026-10-26

- Dispatch is in the Workspace: a panel between the sidebar and the terminals, open until you hide
  it. Sessions it starts or links to open in a Workspace pane. Hide it with Dispatch in the sidebar
  menu, the speech bubble before the tabs, or the button at the top of the panel; the Workspace
  remembers the choice.
- The Workspace sidebar has the same menu as every other page: Dashboard, Workspace, Dispatch,
  Settings and Log out.
- Dashboard, with a home icon, is the first link in the sidebar menu on every page, and the back
  links and the terminal's Dashboard button carry the same icon.
- A quieter look shared with Commslayer: the sidebar sits on a light gray rail, the page is one
  white card, machines are cards, primary buttons are near-black, and controls are 28px with a
  slight bevel. Dark mode follows.
- Fixed: in the desktop app, a terminal opened from the dashboard could lose keyboard focus a few
  seconds later, when the hidden dashboard refreshed.

## [0.6.3] - 2026-10-25

- Workspace keeps one row of tabs for every session on every machine. Clicking a session in the
  sidebar focuses its tab instead of swapping to a separate set of tabs for its folder, and
  clicking a folder jumps to its first tab. Tabs with the same name are numbered. The session
  menu in the sidebar is gone; tabs are split from their right-click menu.
- Claude usage moved from Dispatch to the main sidebar, so it shows on every page.
- Dispatch: Conversations and Tasks fold with a click on their heading, shown by a chevron, and
  stay folded. New conversation is a normal sized button however wide the list is.

## [0.6.2] - 2026-10-25

- Terminals can be light. Settings, Appearance has a Terminal choice: same as the theme, light or
  dark. A light terminal darkens pale text from agents that assume a dark background.
- The sidebar collapses to a rail of icons on every page, with the button next to the wordmark.
  Machines and workspaces show their first letters and state. It is remembered on the device.
- Dispatch: drag the edge of the conversations list to make it wider.
- Workspace opens every running session of a folder in its own tab. Right-click a tab to split it
  into another tab, to the right or below, and use the pane's arrow button to move it back to its
  own tab. A tab or pane closed with its session kept running stays closed until you open the
  session again from the sidebar.
- The desktop app's session tab follows the terminal theme.

## [0.6.1] - 2026-10-25

- Dispatch follows the sessions it starts: a card in the conversation when one finishes, waits for
  an answer or ends, with the agent's choices as buttons and **Review branch** to start a reviewer.
  The conversation lists its sessions and their state.
- Dispatch splits work with independent parts into several sessions, proposes a plan and waits
  for your go-ahead before working through tickets, and can use the MCP servers from Settings,
  such as Linear.
- Dispatch has a second sidebar with conversations and tasks. Tasks of your own are added,
  edited, renamed and deleted there, next to five defaults: **What's going on?**, **Who needs
  me?**, **Plan my Linear tickets**, **Review finished branches** and **Tidy up sessions**.
- A refreshed look across the web pages and the desktop and Android apps: IBM Plex Sans and Plex
  Mono, sentence-case section titles, and one colour per agent state everywhere:
  green while working, amber when it needs you, grey when idle. Red now only means an error or a
  machine that is down.
- Every task can be edited and deleted, the defaults included. An edited default keeps its place,
  and **Restore default tasks** brings the originals back.
- Dispatch shows your Claude plan usage in its sidebar: the 5-hour and weekly limits as progress
  bars with the time each one resets. Claude Code reports them each time Dispatch replies.
- Dispatch shows animated dots under your message until the reply arrives, and the message box
  is redesigned: it grows as you type and keeps Save as task, Stop and Send inside it.
- Workspace: a **⋯** menu on each terminal opens it to the right, below or in a new tab, and tabs
  are renamed in place by double-clicking or from their right-click menu.

## [0.6.0] - 2026-10-25

- The Android app shows Yardbell's phone notifications itself, with no ntfy app or setup: an agent
  waiting, a session ended, a machine down or back, memory running out. It keeps a connection to
  the server over the mesh VPN in the background, also after the phone restarts, and asks once to
  be left out of battery optimization so the connection survives while the phone sleeps.
- ntfy is gone. Its `server`, `topic` and `token` settings are ignored, and the Settings page only
  keeps the switches for which notifications the app shows, and whether the app is connected.
- Servers on the mesh are found for you. The phone app lists them under **On your mesh** and the
  desktop app on its Connect screen, so signing in takes only the passcode. The phone remembers
  every server it has seen, also after you remove one. Servers answer `/app/hello` and list the
  others at `/app/servers`.
- Every page says where the server runs, for example "Running on devbox 100.64.0.10:4000".
- Light and dark theme: a button in every sidebar, and Settings → Appearance, saved per device.
  The desktop app's window and tab bar and the Android app's status bar follow it.
- Workspace: a new tab opens the same New session dialog as the dashboard, closing a tab with
  running sessions asks whether to stop them, and the sidebar is one tree of machine, workspace and
  terminals, with buttons to open any terminal to the right of or below the focused pane. A
  workspace is now a folder on one machine, so the same folder name on two machines no longer
  shares one. On a phone, New session and a new tab are available too.
- Only the terminal in use sets a session's size. A hidden tab, a background pane or a phone in a
  pocket no longer squeezes the agent's screen, which left Claude Code's input box with empty
  lines and the cursor in the wrong place.
- Swiping or scrolling scrolls Claude Code's full-screen mode, which keeps no tmux history, by
  sending it the mouse wheel.
- New session lists only the agents installed on the chosen machine, with the rest under
  **Other agent…** and **Add an agent…** to save a new one. Settings → Dispatch lists the agents
  installed anywhere, with where. Branch choices are clearer option rows.
- Adding a machine lets you pick its project folder from that machine's folders after the check,
  instead of typing it before.
- Settings has its own section list, one section at a time, and explains the port prefix with real
  numbers. Settings, Dispatch and Add machine have a link back to the dashboard.
- Each machine shows its disk use next to memory and CPU: on the dashboard, in the desktop tray
  panel and in the MCP machine list. It is the disk that holds the machine's project folder.
- An empty Workspace pane offers to start your agents in the workspace's folder or to open one of
  its running agents.
- Starting an agent in a folder that already has a session starts a second one (`hp-app-2`) instead
  of failing with "duplicate session".
- Workspace panes load their terminals in the desktop app. Before, the app opened each pane's
  terminal as a tab of its own and left the pane empty.
- The Android app keeps pages clear of the status bar, navigation bar and keyboard, scanning a
  pairing code no longer crashes it, and the APK is smaller (18 MB, was 51 MB).
- On a phone, a dashboard card opens only through its **Open** button, so taps on Stop and the
  other buttons are not taken as opening the session.

## [0.5.0] - 2026-10-24

- **Workspace**, modelled on herdr: a workspace per project with the state of its agents rolled
  up, tabs inside each workspace, and panes you split right or down and resize by dragging the
  border. Agents show as blocked (waiting for your answer or approval), working, done (finished
  while you were looking elsewhere) or idle. Keyboard: Alt+1 to Alt+9 to go to a pane, Alt+\ and
  Alt+- to split, Alt+X to close, Alt+T for a new tab, Alt+[ and Alt+] between tabs, Alt+↑ and
  Alt+↓ between workspaces, also from inside a terminal. On a phone it shows the list, then one
  terminal at a time.
- Agent state comes from what the agent shows on screen, using herdr's detection rules, instead of
  being guessed from CPU use. A permission prompt or question shows as **Needs you** on the
  dashboard and sends the waiting notification at once, without the 20 second wait. Claude Code,
  Codex, Gemini CLI, Qwen Code, opencode, Copilot CLI, Cursor Agent and the other agents herdr
  knows are covered; for the rest, CPU use is still the estimate.
- On a phone, only the page content scrolls and the header stays put.
- The desktop app comes as an `.rpm` for Fedora and openSUSE too, next to the `.AppImage` and the
  `.deb`.
- Swiping a terminal on a phone scrolls back through its history. It did nothing before, because
  agents draw on tmux's alternate screen where the browser terminal keeps no scrollback. The mouse
  wheel does the same on the desktop instead of sending arrow keys to the agent. Typing anything
  returns to the live screen first.
- The Android app reports its real version (0.4.2 showed as 1.0 in Android's app settings). Its
  version now comes from `android/Cargo.toml`, with version code major × 1,000,000 + minor × 1,000
  + patch.

## [0.4.2] - 2026-10-24

- **Android app**: pair a phone by scanning a QR code from **Settings → Connect a phone**, with no
  passcode to type. Each code works once, for five minutes, and the phone keeps a normal login.
  The app lists your servers and shows their dashboard, terminals and Dispatch, opening terminals
  in the same view. Download `Yardbell_<version>_android.apk` from the release.
- Sessions outside tmux have **Stop** next to **Move to tmux**. It ends the agent, also one
  suspended with Ctrl+Z, and gives its terminal the prompt back; the session then shows under
  ended, where **Resume** continues its conversation.
- Move to tmux works on an agent that was suspended with Ctrl+Z in its terminal. It used to fail
  with "the agent is still running after 8 seconds", because a suspended process only acts on the
  stop signal once it is continued.

## [0.4.1] - 2026-10-23

- **Dispatch settings**: your own instructions for Dispatch, the agent it starts in new sessions,
  and the Claude model that runs it (Sonnet, Opus or Haiku), in a new Dispatch section of Settings.
  The Dispatch page links to it.
- README screenshots show the current pages, including Dispatch, and example text uses made-up
  project names.

## [0.4.0] - 2026-10-23

- A Docker that stopped answering no longer marks its machine down. Its port list waits at most
  3 seconds, and the machine stays up without ports until Docker answers again.
- A local machine whose check takes too long is "machine check timed out", not "ssh timeout",
  since no ssh is involved.
- **Dispatch**: a chat page that takes a task, picks the machine that has the repository and the
  most room, and starts an agent there with the task. It runs Claude Code on the host with only
  Yardbell's tools. Conversations are kept in a list beside the chat, and can be reopened, deleted
  or cleared.
- **Agent tools (MCP)**: Yardbell serves MCP at `/mcp`, so Claude Code and other clients can list
  machines, sessions and folders, and start, read, answer and stop sessions. It is off until turned
  on in Settings, which shows the `claude mcp add` command.
- **MCP servers for sessions**: list other MCP servers in Settings and Claude Code sessions get them
  when they start, without writing anything on the machines.
- Agents take a starting task through the new `prompt_arg` setting, set for every built-in agent
  that supports one.
- The desktop app can set up and run a Yardbell server on its own machine from the connect screen.
  It finds the mesh VPN (NordVPN, Tailscale, NetBird or ZeroTier) and this machine's mesh address
  by itself, so phones and other machines can reach the new server.
- The desktop app's tab bar has **Sign out**, and **Disconnect** in the tray and panel is now **Sign
  out**. Signing out also stops a server the app runs itself and stops starting it with the app,
  so the connect screen can switch to another server or set up this machine again.
- When the mesh address is missing at startup, for example because the VPN is off, Yardbell serves
  on localhost and logs a warning instead of refusing to start.
- Add machine reuses an existing `~/.ssh/config` entry with the same name when it points at the same
  address and user, instead of refusing the name.

## [0.3.4] - 2026-10-21

- Move to tmux, New session, Resume, Stop and Forget show their result in the session list right
  away. The list was redrawn from the last machine check, which can be up to `poll_seconds` old,
  so a moved session stayed under "outside tmux" until the next check or a manual refresh.

## [0.3.3] - 2026-10-21

- Starting a session checks that its agent is installed on that machine, and that it is still
  running a second later. If not, New session, Resume and Move to tmux say so ("Codex is not
  installed on studio") instead of opening a tab for a session that already ended.
- Recent folders in New session can be removed with the cross on each one, and show the last two
  parts of the path. "Continue the last conversation" is a switch with a short explanation.
- Open dashboard and settings pages reload themselves when the server restarts with different page
  files, so a browser tab or the desktop app never keeps running outdated page code. A page with a
  dialog open waits until it closes.
- The desktop app's connecting screen has **Use another server**, and after 20 seconds without an
  answer it shows the error with **Retry** and **Change server** instead of waiting forever.

## [0.3.2] - 2026-10-20

- New session and Move to tmux work on the machine running the server when the server was started
  from a terminal. The login shell that starts the session was stopped by that terminal, and the
  request failed with "did not answer in time".

## [0.3.1] - 2026-10-20

- The macOS app shows its tab bar. It sat behind the window's title bar, so new sessions opened in
  tabs you could not see.
- On macOS a left click on the menu bar icon opens a panel: each machine with its memory and CPU,
  the sessions you can open (click one to go to its tab), New session, Open Yardbell, and a gear
  for the notification switches, Start at login, Disconnect and Quit. A right click opens the menu.
- The menu bar menu lists every session you can open under **Sessions**, with "working" after the
  busy ones. Clicking one brings the app forward on that session's tab.
- The menu's machine lines sit under **Machines** with a state dot, a memory bar, and memory and
  CPU percentages, and are readable in a dark menu bar. Clicking one opens the dashboard on that
  machine.
- On Linux the tray icon is the Yardbell mark in the state color instead of a plain dot.

## [0.3.0] - 2026-10-20

- On macOS the desktop app shows the Yardbell mark in the menu bar instead of a colored dot. It
  gets a dot when a machine is down or memory is high, and fades when the server can't be
  reached. A left click on it opens the menu like other menu bar items.
- The desktop app keeps the dashboard and every terminal in one window with a tab bar, instead
  of a window per terminal. Switch with `Ctrl+1` to `Ctrl+9` (`⌘1` to `⌘9` on macOS) or
  `Ctrl+Tab`, and close a terminal tab with `⌘W` on macOS and `Ctrl+Shift+W` inside a Linux
  terminal (plain `Ctrl+W` goes to the shell there).
- A machine is reported down only after it has been unreachable for a minute, in the desktop app
  and in phone notifications. A brief mesh or ssh hiccup no longer sends "down" and "back".
- Phone notifications through ntfy: the server tells your phone when an agent is waiting for you
  (after `wait_minutes`, 2 by default, and only if you have not answered it by then), a session
  ends, a machine goes down or comes back, or memory reaches 95%, with no browser tab or desktop
  app open. Set them up, send a test and choose what to hear about in the new
  **Phone notifications** section of Settings, or under `phone_notifications` in the config.
  Self-hosted ntfy servers work too.
- Terminals on other machines show symbols and other non-ASCII characters. tmux drew `_` for
  them when the ssh session had no locale, which is usual on a Mac.

## [0.2.1] - 2026-10-20

- The macOS app opens the dashboard. macOS blocked plain http:// pages in the app's window, so
  it stayed on Connecting.

## [0.2.0] - 2026-10-20

- Support for AI coding agents besides Claude Code: Codex, Gemini CLI, Qwen Code, opencode, Copilot
  CLI, Cursor Agent, Crush, Goose and Aider are built in, and any other CLI agent can be added with
  `agents` in the config. New session has an agent picker, every session shows its agent, and
  Resume uses that agent's own resume command.
- Add machine reports which agents are installed.
- Sessions started outside tmux are folded under their machine, and **Move to tmux** restarts one
  inside tmux with its agent's resume command so it can be opened.
- The dashboard is grouped by machine: each section shows the machine's health with its sessions.
  The sidebar is slim navigation shared by every page (Settings and Add machine use it too), and on
  a phone machines become a scrolling strip so sessions come first.
- Header actions: search (`/`), All / Working / Idle filter, Refresh now, and per machine a fold
  toggle, New session here, Open a shell, and a menu with Machine settings, Copy ssh command and
  Remove machine.
- `default_agent` config setting.
- Copying from the browser terminal: tmux selections reach the system clipboard (OSC 52), browser
  selections copy on release, and **Copy text** shows the screen as selectable text for phones.
- Desktop app for macOS and Linux: the dashboard in a window of its own, terminals in separate
  windows with a real clipboard and shortcuts, a tray icon with the state of every machine, and
  system notifications when an agent is waiting, a session ends, a machine goes down or comes back,
  or memory passes 95%. When the server can't be reached at launch, the app says so, offers Retry
  and Change server, and tries again every 5 seconds. Releases carry an unsigned `.dmg`, an AppImage
  and a `.deb`. The server gained one-time login codes (`/app/handoff`) so the app can sign its
  window in, with a login that lasts only while the app runs.
- Confirmations (Stop, Move to tmux, Remove machine, Log out everywhere and changing the mesh
  provider) use an in-page dialog instead of the browser's confirm box.
- The terminal page pins every script and stylesheet it loads from the CDN with Subresource
  Integrity, so a changed file is refused.

## [0.1.0] - 2026-10-19

First public release.

- Dashboard of every machine with connection state, memory (with Claude's share), CPU load and mesh VPN status.
- Claude Code sessions per machine with folder, branch, ticket, activity and app ports.
- Automatic ssh tunnels for Docker Compose service ports.
- Browser terminal into any tmux session, from desktop or phone.
- New session flow with a folder browser and per-branch git worktrees.
- Add machine flow: mesh peer discovery, ssh key setup, `~/.ssh/config` entry with backup.
- Mesh VPN support for NordVPN Meshnet, Tailscale, Headscale, NetBird and ZeroTier.
- Settings page: switch VPN with address mapping, edit machines, change passcode, log out everywhere, undo.
- `yardbell doctor`, launchd and systemd service install, Docker image for Linux hosts.
