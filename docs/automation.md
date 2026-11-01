# Triggers, worktree setup, rules, pipelines and connectors

How to let Yardbell start work for you, prepare and clear every worktree, decide what Dispatch may do
without asking, and carry tickets and merge requests through pipelines of steps you define. Each part has
what it is, when it helps, and examples you can copy.

The settings themselves are listed in [Configuration](configuration.md): see
[`triggers`](configuration.md#triggers-optional),
[`worktree_setup`](configuration.md#worktree_setup-optional) and
[`dispatch`](configuration.md#dispatch-optional),
[`pipelines`](configuration.md#pipelines-optional) and
[`connectors`](configuration.md#connectors-optional).

## How they fit together

```
 trigger fires            a schedule time, a Linear ticket, a GitHub issue or review request
      |
      v
 Dispatch conversation    reads its built-in guidance, then your memory, then your instructions
      |
      v
 a step it proposes       start, stop or type into a session, review, scan, push, ...
      |
      v
 your rules decide        run at once, wait for you, or refuse
      |
      v
 new worktree?            the branch is not checked out yet: Yardbell creates a worktree
      |
      v
 worktree setup           your command for that repository: copy .env, install, ...
      |
      v
 agent starts             with its task, and a note when the setup did not finish
```

The three work on their own too. A session you start by hand on a new branch runs the worktree
setup, and a conversation you type follows the same rules as a triggered one.

## Triggers

### What a trigger does

A trigger starts a Dispatch conversation from one of your saved tasks without you typing it. It
watches one of three things:

| Source | Fires when | How Yardbell checks |
|---|---|---|
| A schedule | a time comes round: daily, on weekdays, every few hours, or a cron expression | on its own clock, in the time zone of the machine Yardbell runs on |
| Linear | a ticket is assigned to you, or one of your tickets moves into a state you name | Linear's API every 3 minutes, with your key saved as the secret `linear` |
| GitHub | an issue is assigned to you, or a pull request asks for your review | the GitHub CLI `gh` on Yardbell's own machine every 3 minutes, as the account it is logged in with |

The conversation then runs like one you typed. Dispatch reads the task, picks a machine and folder,
and proposes its steps. Your approval setting and rules decide each step, so a trigger that fires at
night leaves its proposals waiting for you unless a rule lets them run. The conversation is named
after the task, marked with a clock in the list, and opens with **Started by the trigger**, what set
it off and when, and **Turn off**.

A trigger runs the task's current version. Change the task, and the next run uses the new text.

### When a trigger helps

- You start the same kind of work for every ticket that lands on you, and want the plan ready when
  you sit down instead of typing it.
- You want a regular look at your machines and sessions without asking for it.
- You review pull requests often and want a reviewer session proposed as soon as one is requested.

A trigger is not worth it for work you start once, or for a task that needs you to pick details
each time. Keep that one as a saved task and send it from the **Tasks** list.

### Set one up

1. In Dispatch, add a task with **New task** in the **Tasks** list. For a ticket trigger, write
   `{ticket}`, `{title}`, `{url}`, `{state}` or `{repo}` where each goes. Without any of
   `{ticket}` or `{url}`, the ticket is added at the end of the task. `{repo}` is only filled for
   GitHub; Linear tickets leave it empty.
2. For Linear, make a personal API key under Linear's Settings, Security & access, and save it in
   Yardbell under **Settings**, **Connections**, **Secrets** with the name `linear`. For GitHub,
   run `gh auth login` on the machine Yardbell runs on.
3. In **Settings**, **Triggers**, press **Add trigger**: a name, the task, and when it starts.
4. Press **Run now** (a schedule) or **Check now** (a ticket trigger) to try it at once. The row
   shows the next run, the last run with a link to its conversation, and anything wrong.

A new ticket trigger first notes which tickets already match and leaves them alone, so turning one
on never floods you with old tickets. Only tickets that come your way after that start a
conversation. The same happens when you change what it watches or turn it back on.

### Examples

**Start work on each Linear ticket assigned to you.** The task, named "Start a ticket":

```
Read {ticket} ({title}) at {url}. Find the repository it is about, and start a session there on a
new branch named after the ticket, like eng-1234-short-title. Give the agent the ticket's
description and acceptance criteria as its task, and ask it to open a draft pull request when the
tests pass.
```

```yaml
triggers:
  - name: My Linear tickets
    task: Start a ticket
    linear:
      assigned: true
```

When ENG-1234 is assigned to you, a conversation starts, and with the default approval setting you
find a **Start a session** card waiting: approve it, edit the branch or machine, or reject it. For
Dispatch to read the ticket's description, add Linear under **Connections** in Settings as well;
the trigger itself only passes the ticket's number, title, state and link.

**Pick up a ticket when it moves to a state.** Use `states` to start only when a ticket is ready,
for example when your team moves tickets to "Ready for dev" after grooming:

```yaml
  - name: Ready tickets
    task: Start a ticket
    linear:
      states: [Ready for dev]
```

Only tickets assigned to you are seen, and only open ones (not done or canceled). State names are
matched without regard to case.

**Review a pull request when you are asked to.** The task, named "Review a pull request":

```
A review of {url} in {repo} was requested from me. Start a session in that repository on the pull
request's branch, read the change, run the tests and list the problems with file and line. Change
no files and push nothing.
```

```yaml
  - name: Review requests
    task: Review a pull request
    github:
      review_requested: true
```

**A morning summary on weekdays.** No task to write: **What's going on?** comes with Yardbell.

```yaml
  - name: Morning summary
    task: What's going on?
    schedule: weekdays 08:30
```

Other schedules: `daily 18:00`, `every 4h` (00:00, 04:00, 08:00 and so on), or `cron 0 9 * * 1`
for Mondays at 09:00. A task for a schedule should not use `{ticket}` and the others, since there
is no ticket to fill them with and they stay as written.

### What triggers do not do

- **GitLab** issues and merge requests do not start triggers.
- **A failing CI run** is not a trigger. Yardbell watches the pull requests and GitLab merge
  requests of the sessions it started on its own: when CI goes from passing or running to failing,
  or a reviewer comments, a card appears in Dispatch with **Send to session**. That is set under
  [`pull_requests`](configuration.md#pull_requests-optional), see the end of
  [Dispatch](usage.md#dispatch).
- **Linear filters** on these triggers go no further than "assigned to me" and states. Every ticket
  assigned to you starts a conversation, but the task can tell Dispatch to stop there ("if the ticket
  is not in the Web team, start nothing and say so"). A [pipeline trigger can filter](#filter-which-tickets-start-a-run)
  by label, team or project.
- **Stacking.** While a trigger's last conversation is still working, a scheduled time is skipped
  and new tickets wait. Tickets start one at a time, one per check.

### When a trigger does not start

The trigger's row in Settings says why. The usual reasons:

| The row says | Do this |
|---|---|
| the secret `linear` is not set | save your Linear API key as the secret `linear` |
| Linear refused the API key | make a new key and replace the secret |
| gh is not installed or not logged in | install `gh` on Yardbell's machine and run `gh auth login` there |
| the task no longer exists | the task was renamed or deleted (deleting a default hides it): pick another |
| Started watching, nothing matched yet | it works: it waits for the next ticket that comes your way |

## Worktree setup

### What it is

A worktree is a second checkout of a repository on another branch, in
`<repo>-worktrees/<branch>`. It has only the files git tracks: no `.env`, no `node_modules`, no
installed gems, no build output. Worktree setup is a command you save for a repository that runs in
each new worktree right after Yardbell creates it and before the agent starts, so the agent finds a
folder it can run the app and the tests in.

Without it, the agent's first test run fails on a missing `.env` or a missing package, and it
spends its first minutes, and your tokens, installing things or guessing at config.

### When it runs

| What happens | Setup runs? |
|---|---|
| New session on a branch other than the current one, when Yardbell creates its worktree | yes |
| A session Dispatch starts on a new branch, on its own or in a group | yes |
| **Move** a session to another machine, when that creates a worktree there | yes |
| A branch that already has a worktree (it is reused) | no |
| A session in the main checkout, on its current branch | no |
| **Integrate branches** making its own worktree | no |

It runs once per worktree. To run it again, run the command yourself in that folder.

### What the command can do

It is a shell command, so anything you would type in the new folder: copy files from the main
checkout, install dependencies, build assets, prepare a database, or start background services.
It runs:

- on the machine where the worktree is, through your login shell, so your PATH and tools apply;
- in the new worktree, with `$YARDBELL_WORKTREE` (that folder) and `$YARDBELL_MAIN_CHECKOUT` (the
  repository's main checkout) set;
- with no keyboard: a command that asks a question gets no answer, and waits until its timeout;
- for up to 5 minutes, or the `timeout_seconds` you set, up to an hour.

Yardbell waits for the command to finish. A command that keeps running, like `bin/rails server`,
is stopped at its timeout with every process it started, so start services in a way that returns,
like `docker compose up -d`.

When the command fails or runs past its timeout, the agent starts anyway, and its task gets a note
that the setup did not finish and where the log is. The session row says **Setup ran**, or in amber
**Setup failed** or **Setup timed out**; click it for the output. The full output is in
`yardbell-setup.log` in the worktree's git folder (run `git rev-parse --git-dir` in the worktree to
find it). It is removed with the worktree.

### Where to set it

In **Settings**, **Worktree setup**, press **Add command**: the repository's folder (its main
checkout, as the folder list shows it, or a path, with `*` for any part of a name), the command,
and optionally a machine and a timeout. Or under `worktree_setup:` in `yardbell.yml`. A change
applies to the next worktree Yardbell creates.

When several entries match a repository, the one that names the machine wins, then the one with
the longer folder. So you can keep one command for every machine, and another where a machine
differs.

Only commands saved here run. Yardbell never runs a setup script it finds in the branch by itself,
because a branch can come from anyone, and that script would run before anyone read it. To use a
script the repository keeps, name it, like `command: bin/setup`.

### Examples

**A Rails app that needs `.env` and its gems:**

```yaml
worktree_setup:
  - folder: acme/storefront
    command: cp "$YARDBELL_MAIN_CHECKOUT/.env" . && bundle install
    timeout_seconds: 600
```

With JavaScript too, and a database per branch:

```yaml
  - folder: acme/storefront
    command: >-
      cp "$YARDBELL_MAIN_CHECKOUT/.env" . &&
      bundle install &&
      yarn install --frozen-lockfile &&
      bin/rails db:prepare
    timeout_seconds: 900
```

Only add `db:prepare` when each worktree has its own database (for example a `DATABASE_URL` that
names the branch); otherwise every worktree migrates the same one.

**A Node app, and several `.env` files:**

```yaml
  - folder: acme/web
    command: >-
      for f in .env .env.local; do [ -f "$YARDBELL_MAIN_CHECKOUT/$f" ] && cp "$YARDBELL_MAIN_CHECKOUT/$f" .; done;
      npm ci
```

The `[ -f ... ]` check skips a file the main checkout does not have, instead of failing.

**Services in Docker, on one machine only:**

```yaml
  - folder: acme/api
    machine: devbox
    command: cp "$YARDBELL_MAIN_CHECKOUT/.env" . && docker compose up -d db redis
```

**The repository's own script, for every repository in a folder:**

```yaml
  - folder: acme/*
    command: bin/setup
    timeout_seconds: 1200
```

`acme/*` covers each repository directly in `acme`. A more exact entry, like `acme/storefront`
above, still wins for that one.

### Teardown

A worktree's setup may start things that outlive the agent, such as containers. A teardown command,
set on the same entry as the setup, clears them when a [pipeline run](#pipelines) ends or is dropped:

```yaml
worktree_setup:
  - folder: acme/web
    command: docker compose up -d && bin/setup
    teardown: docker compose down
```

An entry needs a command, a teardown or both. Yardbell looks for each separately, so a teardown on
`acme/*` still applies when a more exact entry for `acme/web` only has a setup command. It runs like
the setup, with the same variables, timeout and log. The worktree itself stays.

Teardown runs only where it is safe:

| The run's folder | Teardown runs? |
|---|---|
| A worktree this run created | yes, once per folder |
| A worktree that already existed, or the main checkout | no |
| Another session is working in the folder | no, and the run page says so |
| Another active run uses the folder | no, and the run page says so |

If it fails, the run still ends and the run page shows why. A later run that reuses a torn-down
worktree does not run the setup again, because the worktree already exists, so its agent may find
the containers down.

## Dispatch rules, instructions and memory

Three things shape what Dispatch does. They are easy to mix up, and they work differently:

| | Instructions | Memory | Rules |
|---|---|---|---|
| What | your own text added to Dispatch's prompt | short facts Dispatch keeps across conversations | allow, ask or refuse each kind of step |
| Who writes it | you | Dispatch proposes, you approve; or you edit it | you |
| Where | **Settings**, **Dispatch** (`dispatch.instructions`) | **Settings**, **Dispatch**, **Memory** (`dispatch/memory.md` in the state folder) | **Settings**, **Dispatch**, under the approval setting (`dispatch.rules`) |
| Enforced | no: the model follows it | no: the model follows it | yes: Yardbell checks every step |
| Use it for | where repositories live, which machine suits which work, branch names, how to write tasks | what Dispatch learned from your corrections | what must never happen, or never without you |

### How Dispatch reads them

Every turn, Dispatch's prompt is put together in this order:

1. Yardbell's built-in guidance: how to pick a machine (up, has the repository, most free memory,
   lowest load, fewest agents), how to use each tool, how to plan tickets.
2. What your approval setting means for it, and a note that rules exist when you have any.
3. The memory, as a list between tags.
4. Your instructions, introduced as taking precedence over everything above them.

So when they disagree, your instructions win over the memory, and both win over the built-in
guidance. "Use devbox for acme/web" in your instructions beats the usual choice of the machine with
the most free memory.

Rules are not part of that order. They are not advice to the model: whatever Dispatch decides,
Yardbell checks each step against them before it runs. A refused step never runs and never becomes
a card; Dispatch is told which rule refused it and tells you. This also holds for triggered
conversations, which is what makes it safe to let a trigger fire while you are away.

### How a rule decides

Each rule names a step, and optionally a machine and a folder, and says **Allow** (run at once),
**Ask me** (wait for you) or **Deny** (refuse). The steps are: **Start a session**, **Stop a
session**, **Type into a session**, **Start a review**, **Start a scan**, **Remove a worktree**,
**Integrate branches**, **Push a branch**, **Move a session**, **Change Dispatch's memory**, or
**Any step**.

When several rules match one step:

1. A **Deny** always wins.
2. Otherwise the rule that names the most of step, machine and folder wins.
3. Then the one with the longer folder, then the more careful one (**Ask me** over **Allow**).
4. When no rule matches, the general setting (**Before Dispatch starts, stops or types into a
   session**) decides.

The order of the list never matters. Changes to the memory are decided apart from the rest: only a
**Change Dispatch's memory** rule decides them, and without one they always wait for you, even when
Dispatch goes ahead without asking. Each child of a group is decided on its own.

### Writing good rules

- **Put limits in rules, not in instructions.** "Never push without me" in your instructions is a
  request the model can get wrong. As a rule, **Push a branch, Any machine, Ask me**, it cannot.
- **Allow narrowly.** Allow by machine and folder ("start sessions on devbox in acme/*"), not
  **Any step** on **Any machine**. Yardbell refuses a rule that names nothing; set the general
  setting instead.
- **Deny sparingly.** A deny wins over every allow, however exact, so a broad deny cannot be
  opened up again for one folder. When you want "no, except here", use **Ask me** for the broad
  case and **Allow** for the exception.
- **Think of unattended runs.** A trigger that fires at night acts on what your rules allow. Allow
  what you are happy to find done in the morning, and leave the rest asking.
- **Keep reviews and scans easy.** Reviewers and scanners change no files when their agent allows
  it, so allowing **Start a review** and **Start a scan** costs little.
- **Write instructions as facts and preferences.** Where repositories are, which machine has the
  shared Docker stack, how branches are named, what every task should end with. Keep them short:
  they are read on every turn, and the limit is 4000 characters.

### Examples

**Careful: everything asks, a few things never happen.**

```yaml
dispatch:
  approval: prompt
  rules:
    - action: stop_session
      approval: deny
    - action: push_branch
      approval: deny
```

**Trusted machine: work starts there by itself, pushes always wait.**

```yaml
dispatch:
  approval: prompt
  instructions: |
    acme/web and acme/api live on devbox. Use pro only when devbox is down.
    Branch names look like eng-1234-short-name, from the Linear ticket.
    Every task ends with: run the tests, and open a draft pull request when they pass.
  rules:
    - action: start_session
      machine: devbox
      folder: acme/*
      approval: allow
    - action: review_session
      approval: allow
    - action: scan_folder
      approval: allow
    - action: push_branch
      approval: prompt
    - action: stop_session
      approval: deny
```

With a Linear trigger, a ticket assigned to you at night starts its session on devbox right away,
in a worktree prepared by your setup command. Anything else it proposes waits for you, it can never
stop a session, and every push waits.

**Hands off, with a floor:** Dispatch goes ahead without asking, except where it matters.

```yaml
dispatch:
  approval: allow
  rules:
    - action: send_to_session
      approval: prompt
    - action: push_branch
      approval: prompt
    - action: remove_worktree
      machine: pro
      approval: deny
    - action: remember
      approval: allow
```

**Instructions that pair well with memory.** Your instructions hold what you decided up front;
memory collects what came up later, like "the shared docker stack is on hp" after you corrected
Dispatch once. When an entry in memory goes out of date, edit or delete it under **Memory**, or
tell Dispatch, which proposes replacing it. Since your instructions win, a lasting rule of thumb
belongs there rather than in memory.

## Pipelines

### What a pipeline is

A pipeline is a set of steps that Yardbell carries a ticket, a pull or merge request, or nothing at
all through on its own, stopping only when it needs you. You build one on the
**Pipelines** page's canvas, from nothing or from a template. Each pipeline has:

- a **trigger** that starts runs: by hand, a schedule, a Linear ticket, a [connected tool](#connectors),
  a [webhook](#webhooks), a GitHub review request, or a GitLab merge request that adds you as reviewer;
- **steps**, each with three lines out of it: where to go when it **passed**, **failed** or **needs
  you**. A line goes to another step, to **End the run**, or to **Wait for me**. A line back to an
  earlier step makes a loop, such as Review failing back to Fix;
- a **version**: every save keeps the one before, and **History** restores any of the last 30.

Two templates ship, both saved switched off so you can look at them first:

| Template | Trigger | Steps |
|---|---|---|
| Implement my tickets | a Linear ticket assigned to you | Plan, Implement in a new worktree, Review (a fail goes to Fix and back, up to 3 times), QA on devbox (a fail goes to Fix after QA), Push and draft PR, Move in Linear to In Review, Report to me |
| Review my merge requests | a GitLab merge request adds you as reviewer | Plan, Understand, Root cause, Security, Test on devbox, Report to me. Any fail goes straight to the report. |

Without a machine named `devbox`, a copied template tests where the code already is.

### How a run works

```
 trigger or Run now
      |
      v
 Plan                     Dispatch picks the machine, folder and branch (optional step)
      |
      v
 agent step               starts a session in a new worktree, or types into the run's session
      |
      v
 YARDBELL RESULT          the agent says pass, fail or needs you
      |
      v
 the line for that word   another step, End the run, or Wait for me
      |
      v
 end of the run           every session stops, teardown runs, the worktree and branch stay
```

**Sessions.** A run keeps as few agents alive as it can. A step reuses one of the run's live sessions
when all three of these match; otherwise it starts its own, in the same folder:

| Must match | Why |
|---|---|
| Machine | A session runs on one machine. |
| Agent | The step's agent field, as written. |
| Read-only | An agent's read-only setting is fixed when it starts. |

So with the usual steps:

| Step | Session |
|---|---|
| Implement, then Fix | One session. Fix is typed into Implement's session. |
| Review (**Review: new read-only session** on) | Its own read-only session, which cannot edit files and did not write the code. It shares the worktree, so no setup runs and no containers start. |
| Another read-only step on the same machine after Review | Shares the reviewer's session. |
| A step on another machine, or naming another agent | Its own session. |

To run a review in the main session and use one session in all, untick **Review: new read-only
session** on that step in **Build**. The review can then edit files, and it reviews work it wrote
itself.

A task is typed in only when the session is idle. If the agent is asking something, the run waits for
you; if it is busy, the task goes in once it is quiet. A session nothing needs any more stops by
itself: everything but the current step's and the newest writer's. So a reviewer stops when Fix
starts, and a Review run again starts a new one that reads the code afresh.

**A review reached again with nothing new.** A read-only step notes the commit and uncommitted changes it
read, and the run's page shows the commit. If the step is reached again and the code is exactly what its
last result was about, as when Fix made no new commit and changed no files, Yardbell does not start a
reviewer and does not reuse the old verdict. A second read of the same code could only repeat itself, or
pass by chance. The run waits and says so. **Run it again** reads the same code anyway, and **Continue on
pass** or **Continue on fail** takes that line. This try does not count towards the step's limit. New
commits or new uncommitted changes run the step as usual, and so does a folder whose code cannot be read.

**Session names.** A run's sessions end with the end of its id, like `hp-com-1-ab12cd`, so a run can
never stop or type into a session someone else started under a name it remembers.

**Results.** The task tells the agent to end its reply with this block:

```
YARDBELL RESULT
step: review-1-ab12cd
status: pass
summary: Reviewed the three commits. No blocking problems.
- 323 examples, 0 failures
END RESULT
```

The `step:` line names the step, its run count and the run, so a result is matched to the exact try
it answers, even in a shared session. Yardbell reads the block from the terminal's screen. For Claude
Code it also reads the session's transcript in `~/.claude/projects`, because agents draw on tmux's
alternate screen, where only what fits in the pane can be seen. A long result, a small terminal or a
view scrolled up cannot hide it there.

**Result files.** So a result never has to fit on the screen, the task also asks the agent to save the
same block with a shell command to the file that `git rev-parse --git-path yardbell-result/<step line>`
prints. That is inside the worktree's git folder, so the branch does not change. When the agent goes
quiet, Yardbell reads the file first, then the screen, then the transcript. The `step:` line must still
match, so an old file or another try's file is never accepted. The file is read the same way as the
screen and trusted no more: it is limited to 64 KB, a symbolic link is refused, and one that does not
hold up is ignored. An agent that does not write it reports as it always did. When the run ends, its
own files are removed, and the folder too once it is empty, whoever else works in that worktree.

Whether the task asks for the file depends on the agent, since asking must not stop a step at a prompt
or take an agent past its read-only limit:

| Agent | Asked for the file? |
|---|---|
| Claude Code | Only when its command turns permissions off, with `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`. In every other mode it prompts before any write to `.git`, whatever your allow rules say, and the transcript already has its result. A reviewer's `--disallowed-tools` does not block shell commands, so a reviewer can write it. |
| Codex | Only when not read only and its command has `--sandbox danger-full-access`, `--yolo` or `--dangerously-bypass-approvals-and-sandbox`. Its result is otherwise read from the screen. `--sandbox read-only` blocks the write, so a read-only Codex is never asked. |
| Any other agent | Always, also when read only, since those are read only by instruction. An agent that asks before running a shell command will ask here too, and the run waits for you as it does for any other prompt. |

A permission mode set in a settings file rather than in the command cannot be seen, so that agent is not
asked and reports as before.

If a step goes quiet with no result, it gets one more try after a 2 minute wait: a reviewer is asked to
print its result again, and a writer gets its task again. After that the run waits and says **ended
without a result**, and **Show terminal** shows what the agent did. Your **Retry step** starts a
reviewer afresh.

### Steps

| Step | What it does |
|---|---|
| Agent | Starts an agent with your instructions. It works in a new worktree on the run's branch, in another step's folder, or in a copy of another step's branch on another machine; in a new session or by continuing another step's session; optionally read only. Its machine is a fixed one, the machine of another step, or one Dispatch picks. It ends with a result block saying pass, fail or needs you. |
| Plan | Dispatch reads the ticket and its comments and picks the machine, folder and branch, from all machines or the ones you tick. Unclear tickets come back to you as questions. |
| Push and draft PR | Pushes the run's branch (with the secret check, never forced) and opens a draft pull or merge request. |
| Wait for CI and reviews | Waits for the run's pull or merge request without an agent, then follows pass or fail. See [below](#wait-for-ci-and-reviews). |
| Linear | Moves the ticket to a state, or drafts a comment that you post yourself. |
| Use a connected tool | Does one action in a [connection](#connectors): reads from or changes an outside tool. Its reply goes on the pass line and an error on the fail line. |
| Run a command | Runs a saved shell command in the run's worktree, with no agent. Exit 0 goes on the pass line and anything else on the fail line. See [Run a command](#run-a-command). |
| Report to me | Dispatch writes what the run did and found, and your phone gets the first line. |
| Wait for me | Stops with your message until you continue it. |

An agent step's instructions can use `{ticket}`, `{title}`, `{url}`, `{description}`, `{branch}`,
`{pr}`, `{report}` (the report of the step that led here) and `{report:Step name}`. Reports from
other steps arrive quoted, so an agent reads them as data rather than as orders.

A step runs at most `max_runs` times in one run (2 unless you change it, up to 10), and an agent
step may run for its `minutes`, or the `minutes` setting, before it waits for you. At most
`per_machine` agent steps run at once on each machine; the rest queue.

New agent steps can also wait while a machine is short of memory. This is off unless you set a
`memory_limit`. With a limit set, from that percent of memory in use, steps on that machine are held, and
they are released only once it has stayed under the limit for two minutes. At most one step then starts
a minute on each machine. This counts every start from the queue, including a step's second try and
**Retry step**. A step already running is never stopped. The reading is the fuller of the machine's memory
and the account's own limit, the same figure as the high memory notification. A machine that answers but
gives no memory reading is not held, because a figure that may never come would stop its work for good,
and `yardbell doctor` flags it.

No single limit suits every machine. On a Mac the figure can read well above what macOS itself reports,
so look at each machine's figure when it is idle before you choose.

The run's page says it is held and why. A run held for 30 minutes also shows under **Waiting for me**
and sends one phone notification. It stays queued and still starts by itself when the machine recovers.

A pipeline can also limit how many tokens one run may use, set under **Token limit** in its builder or
as a default in **Settings**. See [Token limits](#token-limits).

Each run gets one Dispatch conversation, where every step shows as a card marked **Ran as part of
the pipeline run started at 09:40**. Starting a run is the one approval: your Dispatch rules still
refuse what they refuse, and a refused step waits for you with the rule's reason.

### Run a command

An agent's pass is its own word. A **Run a command** step lets code decide instead: it runs a command such
as `make test` and follows its exit code. It starts no agent and spends no tokens, so it suits a loop like
this:

```text
Implement  pass  Test
Test       pass  Push and draft PR
Test       fail  Fix
Fix        pass  Test
```

- It runs through your login shell, as an agent does, in the worktree of the first step that made one, on
  that machine. Save refuses a command with no such step before it on every path.
- The shell's exit code is the last command's, so on several lines an earlier failure does not count. Join
  them with `&&`, as in `make test && make lint`.
- Exit 0 goes down the pass line. Any other exit, or running past its **Stop after minutes** (10 unless you
  change it, 1 to 1440), goes down the fail line. At the limit the machine stops the command and everything
  it started.
- The last 20,000 bytes of its output, with saved secrets and known token shapes hidden, are the step's
  report. A Fix step reads them with `{report}`, quoted as data.
- If Yardbell cannot tell how it ended, such as when ssh dropped, that is not a fail. It tries once more,
  then waits for you with **Retry step**, and neither try counts against `max_runs`.
- `max_runs` counts as for any step, so a Test and Fix loop stops and waits when either reaches its limit.
- If Yardbell restarts during a command, the step runs again from the start and tells the copy left behind
  to stop. Choose commands that are safe to run twice. Dropping the run stops the command too.
- A command takes no placeholders. `{branch}` or `{report}` would be refused on save, because text from a
  ticket must never reach a shell. It can read `YARDBELL_WORKTREE` and `YARDBELL_MAIN_CHECKOUT`.

**A command step never passes without running.** **Continue on pass** on this step depends on what happened
in this attempt, which starts each time a run enters the step:

- If the exact approved command has not run, as when it waits to be accepted, a rule refused it, ssh dropped
  or the run limit stopped the loop, nobody can continue on pass, including through `answer_run` under an
  `allow` rule. The button is hidden. **Accept and run** or **Retry step** is the way forward.
- If it ran and failed, you can still press **Continue on pass** on the run's page. The run keeps a note
  that you overrode it, the step's row says so, and the final report lists it. `answer_run` is refused here
  too, even with an `allow` rule or a card you approve, so this takes the run's page.
- If it ran and passed, anyone can continue on pass.

**Continue on fail** and **Drop** always work. Continue on fail follows the fail line as if the step failed,
so it runs nothing, and a later step that reads `{report}` finds no output if the command never ran.

**Who approves a command.** Only text a person has accepted runs:

- A command you type in the builder counts as approved when you save it.
- A pipeline Dispatch or an MCP client proposes always waits for you, and its card shows each command.
  Approving the card saves the pipeline but does not approve the commands. The first time a run reaches one,
  it waits and shows the whole command, and **Accept and run** goes on and remembers it. You can also press
  **Approve this command** in the builder.
- If an agent changes a command, the approval is gone and the run waits again. What an agent sends in the
  `approved` field is ignored.

**Dispatch rules.** A rule on the action `run_command` matches the machine, and the folder either as its name
such as `acme/web` or as the worktree's path. A `deny` rule makes the run wait with the rule's reason. As with
the other steps of a run, starting the run is the one approval, so `prompt` does not stop it.
### Wait for CI and reviews

Put this step after **Push and draft PR**, with its fail line going to a Fix step, and Fix's pass line
going back to Push:

```
 Push and draft PR --> Wait for CI and reviews --pass--> Report to me
        ^                      |
        |                     fail
        |                      v
        +------- pass ------- Fix    "Fix what this found: {report}"
```

Every `poll_seconds` (Settings, Connections, GitHub and GitLab) it reads the branch's pull or merge
request the same way badges and cards do, through `gh`, a GitHub token, a GitLab token or `glab`. The
switches for badges and cards do not turn it off, since you put the step there.

| What it reads | What it does |
|---|---|
| CI green on the same commit at two reads in a row | Follows **pass**. The second read catches a check that registers late. |
| CI green, **Also wait for an approval** on, and no approval yet | Keeps waiting. |
| A failed check, or a reviewer asking for changes | Follows **fail**, once per set of failures. |
| A check that was cancelled, went stale or waits for someone, with nothing failing and nothing still running | Waits for you and names the check. See below. |
| CI still running | Keeps waiting. |
| No checks at all after 10 minutes | Waits for you, because nothing says it passed. **Continue on pass** carries on. |
| The pull or merge request was merged | Follows **pass**. |
| It was closed, `gh` is logged out, or GitLab refused the token | Waits for you. |

Plain comments do not fail the step. They come along in its report, so a pass can show them too.

**Checks that ended with no result.** A check that was cancelled, went stale or waits for someone to act
on it is not green, and it gives an agent nothing to fix, so it sends no Fix. This covers a GitHub check run
that ended `CANCELLED`, `STALE` or `ACTION_REQUIRED`, and a GitLab pipeline that is `canceled` or `canceling`.
The run waits for you with **Retry step** and **Continue on pass** or **Continue on fail**, and says what
happened to each check. You do not have to answer if the check is run again or someone deals with it: until
the step's time limit the wait keeps reading, without telling you again, and a later read with the check
running or green carries on as usual with a fresh time limit. Green still takes two reads, and a read from
before does not count. A check that was run again under the same name goes by its other result. After the
limit the wait stops reading and only you can move it on. If a check failed as well, the failure takes the
fail line, and the others are listed in the report. These checks neither pass nor add to the count of
failing commits. Badges and cards do not treat them differently.

Other results keep their meaning. On GitHub, `SUCCESS`, `SKIPPED` and `NEUTRAL` count as green, and `FAILURE`,
`TIMED_OUT` and `STARTUP_FAILURE` as failed. So a pull request whose checks were all skipped passes. On
GitLab, a pipeline that is `skipped` or waiting on a `manual` job counts as no checks, so the run waits for
you after 10 minutes.

**Its report** starts with what failed, then lists the unresolved comments with who said them and
where, then each failed check with its link and the last lines of its log, for up to 4 checks. Yardbell
leaves out GitHub review threads and GitLab comments that are marked resolved. Use `{report}` in the Fix
step's instructions. It arrives quoted, because logs and comments are written by others.

**No agent waits.** The step takes no slot on any machine, and while it waits the run's sessions stop.
The worktree stays. The Fix step then starts a new session in the same folder, so it works from the
report and the code, without its earlier conversation.

**Its time limit** is the step's `minutes`, or the `minutes` setting. When it runs out, the run waits for
you and says what it last saw. A wait that may need a person's approval usually wants a longer one, up
to 1440. Pending runs and their counts are kept in `runs.json`, so a restart carries on.

**Stopping loops.** A failure is sent down the fail line only when it holds something not sent before:
a check that fails in a new way, or a new review or comment while changes are requested. A Fix that
pushes nothing, or a reviewer who has not looked again, leaves the step waiting. The run waits for you
when:

- the same check fails the same way on two commits. "The same way" compares the log's lines that mention
  an error or failure, with ids, times and numbers taken out. A log that could not be read never counts
  as a repeat;
- any check fails on four commits in a row, whichever check it is. CI passing starts this count again.

**Continue on fail**, **Continue on pass** and **Retry step** start the counts again, so the step can go
round once more if you say so. A step also still has its **Runs at most**, on this step and on Fix, Push
and anything else in the loop, so raise those for a longer loop. A new one of these steps allows 5.

**Dispatch cards.** While a run with this step is going, its pull or merge request posts no CI or review
cards, so one failure never becomes both a card and a Fix step. It counts as the run's when its address is
the run's, or when it is on a folder a step of the run works in. Badges stay. What happened during the run
does not turn into cards later; a new failure or comment after the run ended does. A pipeline without this
step keeps its cards as before.

While a run is at this step, the **CI is still pending** health check leaves that pull or merge request
alone, because the step has its own time limit and tells you itself. **A run is waiting** still counts it.

The step uses no tokens and is not held for memory, so it goes on past a run's token limit and does not
count towards the one start a minute. A Fix it sends is an ordinary agent step, so past the limit the run
waits at Fix instead of spending.

Reading CI and reviews changes nothing, so no Dispatch rule decides it. The Fix step and the Push after
it are still put to your rules, and this step never merges.

### When a run waits for you

A run waits under **Waiting for me**, with a phone notification, when:

- a step's line goes to Wait for me, such as a step that says it needs you;
- Plan has questions, or an agent asks something or waits on a prompt (its screen is shown);
- a step reached its `max_runs`, ran past its minutes, or ended without a result;
- the run passed its token limit, or cannot tell what a step used;
- a wait for CI ran out of time, saw the same failure on two commits or failures on four in a row,
  found no checks at all, or found a check that was cancelled, went stale or waits for someone to act;
- the push or a step was refused, by the secret check or a rule;
- its machine stayed offline for 30 minutes, or the ticket was closed meanwhile.

Tapping the notification opens the app. **Waiting for me** on the Pipelines page lists every run that
waits, and clicking one opens it.

On the run you can **Send answer** (the step runs again with it, the waiting agent gets it typed in,
or Plan gets your answers), **Retry step**, **Continue on pass** or **Continue on fail** (follow that
line as if the step had ended so), or **Drop** (stops its sessions and leaves the worktree and
branch). **Stop session** stops one session and makes its step wait, and **Delete this run** stops
the run first if it is still going, then removes it.

When a run ends or is dropped, every session stops and [teardown](#teardown) runs. Deleting a whole
pipeline stops its runs' sessions but runs no teardown, so stop a run first if its containers should go.

### Set one up

1. Save your Linear API key as the secret `linear` (Settings, Connections, Secrets), for Linear
   triggers, Plan and Update the ticket steps.
2. Log in `gh` on the machines that push, for draft pull requests. For GitLab, add the host under
   [Settings, Connections, GitHub and GitLab](usage.md#linear-github-and-gitlab); its token needs the `api` scope to open
   merge requests and to list the ones you review.
3. On the **Pipelines** page, **New pipeline**, start an **Empty pipeline** or pick a template.
   On the **Build** canvas, set the trigger on **Start when**, drag in the steps you want, and draw
   their pass, fail and needs-you lines from each card's dots. **Save** checks it: every line goes
   somewhere, every step can be reached, a step that continues or copies another comes after it on
   every path, and the machines and MCP servers exist.
4. Switch it on. Switching on checks the trigger too, such as a GitLab host you have not added.
5. Run `yardbell doctor`. For each pipeline that is on, it says whether Linear answers, the GitLab
   host signs you in, `gh` is logged in where it pushes or waits for CI, and its machines are reachable.

### Start a run

- **By hand:** **Run now** on the pipeline. A pipeline whose trigger needs a ticket or a link asks
  for ticket ids (`COM-1234`) or pull and merge request links, one run each.
- **From its trigger:** Linear and review triggers are checked every 3 minutes. The first check
  only notes what is already there, so switching a pipeline on does not start a run for every old
  ticket. A schedule with a state, such as `weekdays 02:00` with `Todo`, starts one run for each of
  your open tickets in that state; without a state it starts one run with no ticket.

A ticket or link that is already in a run of the same pipeline is not started twice. Pipelines are
kept in `pipelines/` and runs in `runs.json` in the state folder, so a restart carries on where each
run was. A run keeps the version it started with, so saving a pipeline never changes a run halfway.

### Filter which tickets start a run

A **New ticket** trigger can narrow which tickets start a run, on the **Build** tab under **Start when**.
What you can filter on depends on where the tickets come from:

| From | Filter on | Who filters |
|---|---|---|
| Linear | labels, teams (key or name), projects | Linear |
| GitHub Issues | label | GitHub |
| GitLab Issues | label | GitLab |
| Trello with a token | label | Yardbell, on the board's cards it reads |
| Jira | label, project key | Yardbell, on what your search returns |
| Asana | tag, project | Yardbell, on your tasks it reads |
| Trello by sign-in, and any other connection | what its **Choices** offer, often nothing | as the choice is set up |

Under Linear, names in one box mean any of them, and a ticket must match every box. Names ignore case.
A connection's filter takes one value.

**See what matches now** reads the tickets, shows how many match with the first few, and says who did
the filtering. It changes nothing and starts nothing.

```yaml
trigger:
  kind: linear
  assigned: true
  filter:
    labels: [agent-ready, bug]
    teams: [ENG]
    projects: [Billing]
```

**A filter never floods you.** The first check after you switch a pipeline on, or change its filter, only
notes what matches and starts nothing. A ticket that comes to match later starts one run, such as one
that gets the label today. That holds when you widen or remove a filter too.

Limits:

- Linear only shows Yardbell open tickets assigned to you, the 100 most recently updated, so a team
  filter narrows those. It does not bring in your teammates' tickets.
- Yardbell filtering needs the whole list read first, up to the [paging limits](#paging). To have Jira
  filter, write it into the `jql` of the connection's `list` action instead.
- A name with a typo matches nothing, and the tool does not say so. **See what matches now** tells you
  when nothing matches, and so does `yardbell doctor` for Linear.
- A connection saved before filters existed has none until you add them. The builder says so.
- A schedule reading a connection uses its filters. A schedule reading Linear and the GitHub and GitLab
  review triggers have none.
- **Run now** with a ticket you name ignores the filter, since you picked that ticket.

### Token limits

A run's page shows what it has used. Each agent session's figures come from its Claude Code transcript
on its machine, and Plan and Report come from what Dispatch reports for its own turn. Yardbell reads the
transcripts about once a minute and when a step ends. It counts input, output and cache writes. Cache
reads are shown apart and left out, because every turn of a long session reads its whole conversation
again. These are tokens, not money: Yardbell has no price list.

Each transcript is counted once however many steps share its session, and subagents' transcripts are
included. The figures are saved with the run, so a restart loses nothing and adds nothing.

Once a run with a limit has used it:

- it starts no new step that uses tokens and waits for you, with a phone notification, showing what it
  used and the limit;
- steps that use no tokens go through, and the run waits at the next step that does. If none is left, the
  run ends, and your phone has still been told it passed its limit;
- a step already going finishes first, and your phone hears when the limit is passed while it runs;
- **Raise the limit** sets a new limit for this run and goes on, and **Start this step anyway** runs one
  step, after which the run waits again.

| Step | Past the limit | Why |
|---|---|---|
| Agent | waits | an agent session uses tokens |
| Plan, Report | wait | each is a Dispatch turn |
| Push and draft PR | goes through | git and the forge, with no model |
| Update the ticket | goes through | a call to Linear or a connection, and its comment is built from reports |
| Call, Use a connected tool | go through | Yardbell calls them with no model. If the far side runs a model of its own, that is not counted |
| Wait for me | is its own wait | it already asks you |

Unknown is never counted as zero. Only Claude Code reports tokens, so:

- a pipeline with a limit and a step on another agent says so in the builder and in `yardbell doctor`;
- a limited run waits before starting that step. **Start this step anyway** goes on, leaves that step out
  of the total and does not ask again in that run. The run's page then says "at least" and names the step;
- if a Claude Code step ends and its transcript cannot be read, or a Dispatch turn reports nothing, the run
  waits the same way before its next step that uses tokens;
- if `/clear` is run in one of the run's sessions, the same happens, and the page says the session moved to
  a new transcript.

`/clear` needs that care because it gives the session a new transcript with nothing in it that names the
old one. Yardbell finds a run's transcripts by the step markers in them, so it cannot find that one by
itself. It asks Claude Code's own record of each live session, `sessions/<pid>.json` in its config folder,
which transcript the session is on now. If that transcript holds no marker from this run, the session has
moved.

Yardbell warns and does not count that transcript, since the record cannot tell `/clear` from `/resume`, and
a resumed transcript holds tokens from another session. If the session later gets a step of this run, its
marker is in that transcript, so the transcript is counted and the warning goes.

This has limits, and a move can still be missed when:

- the session ends before the next read, about a minute at most, since the record goes with the process;
- the session's Claude Code keeps no such record, or Yardbell's process id for it is not the one the record
  is named after;
- the session started a new transcript in another folder.

This was read from Claude Code 2.1.316 and tested with files shaped like its own. It has not been seen
working on a real `/clear`.

A run without a limit never waits for this, and its page still shows what is known.

### Settings

The **Settings** button on the Pipelines page writes the `pipelines` section of `yardbell.yml`:

```yaml
pipelines:
  per_machine: 2      # agent steps at once on each machine, 1 to 6
  minutes: 120        # an agent step or a wait for CI running longer waits for you, 10 to 1440
  memory_limit: 0     # off; or the percent of memory in use that holds new agent steps, 50 to 99
  token_limit: 500000 # optional: tokens one run may use, 0 for no limit; a pipeline can set its own
  qa_notes:           # added to every agent step working in that folder
    acme/web: |
      Run specs with: docker compose exec web bin/rspec <files>
      Rails console:  docker compose exec web bin/rails console
```

### Limits

- Plan can only pick a folder a machine already has; otherwise it says so and waits.
- An agent step reports through its result block. One that ends without it gets one more try, then
  waits for you. Only Claude Code's result is also read from its transcript. An agent that is not asked
  for a result file, or does not write one, and has no transcript must fit its result on the terminal's
  screen. **Result files** under [How a run works](#how-a-run-works) says which agents are asked.

## Health checks

Health checks are plain tests of what Yardbell already reads from its machines, pipelines, triggers and
pull requests. They use no tokens and run no commands of their own. A check starts no agent, types into
nothing and changes nothing. It only tells you.

They cover what the other notifications do not. An agent waiting, a session ended, a machine down or back,
memory at 95%, a pipeline run that starts waiting or finishes, and a proposal already have a
[phone notification](apps.md#phone-notifications), so these checks do not repeat them.

| Check | Speaks when | Default |
|---|---|---|
| A run stays queued | A run has waited that long for a free slot on a machine that is up | 120 minutes |
| A run stays waiting for you | A run has waited that long at the same step for the same reason. It was told once when it started waiting, and this is the one reminder | 240 minutes |
| A step near its limit has an unchanged screen | An agent step's session has shown exactly the same screen that long, and the step is past three quarters of its minutes | 30 minutes |
| CI stays pending | The same commit of an open pull or merge request has been pending that long. Yardbell reads only branches with a live session | 120 minutes |
| A trigger keeps failing | A trigger or a pipeline's trigger cannot read what it watches for that long, or a trigger's last start failed. A failure that stands until the next scheduled try, meaning a failed start or a failed read by a pipeline's schedule, stops counting 24 hours after it happened, or sooner if a later try works. The trigger's own row in Settings or on the Pipelines page still shows it | 60 minutes |
| A machine stays short of memory | A machine has stayed at 90% memory or more that long | 60 minutes |

Current problems show at the top of the dashboard, with a count on **Dashboard** in the sidebar. Each one
links to the run, pull request, trigger or machine it is about, and leaves as soon as it clears.

Each problem notifies your phone once. It notifies again only after it has been clear for 5 minutes and then
comes back, and a restart does not change that, since Yardbell keeps what it told you in `health.json` in its
state folder. More than 3 new problems at once arrive as one notification. While a machine is down, or a
pull request cannot be read, what is known about it stays as it is rather than counting as cleared. A failed
start or scheduled read that has passed its 24 hours does not come back, also after a restart, and only
another failure is a new problem. A schedule that fails at every try, such as every hour, moves that time on
at each try, so it stays one open problem. With this check's time set to 24 hours or more, one such failure
never shows here.

**Settings, Health checks** has an on or off and a time for each. `yardbell doctor` lists problems you have
been told about that are still open.

## Connectors

### What a connector is

A connector tells Yardbell how to talk to one outside tool, saved as data rather than code, so
adding a tool needs no new release. It holds the tool's address, which saved secrets log in, and its
calls: how to list items, read one, move one, or anything else its API does. Examples for Trello, GitHub Issues, GitLab Issues, Jira and Asana are ready to start from.

With a connector, a pipeline can:

- start a run when a new item appears, or one reaches a state;
- give the agent the item's title and description;
- change the tool during a run with a **Use a connected tool** step, such as moving a card or adding a comment.

### What a connector can reach

It needs a web API that takes a token you can paste in and replies in JSON. Most ticket tools do.

| Works | Does not work |
|---|---|
| REST and GraphQL APIs | A service that only signs in through a browser (OAuth) |
| A token in a header | Requests that must be cryptographically signed, like AWS |
| Paged lists | Replies that are not JSON, such as XML |
| A tool on your mesh, with **Allow private addresses** | A tool with no web API |

Comments on an item are not read, only its title and description.

### One way to start and update

- **New ticket** under **Start when** takes its work from any connection, Linear or Trello or a tool you
  added. Pick which under **From**.
- **Update the ticket** moves the ticket or comments on it, using the connection that started the run.
  A connection needs a `move` or `comment` action for this, and **Save** says if it has none. In Linear,
  a comment is still drafted for you to post. A webhook's item has nowhere to update.
- **Implement my tickets** is the template, and pipelines saved before this keep working unchanged.

### Connect by signing in

The simplest way to connect a tool needs no token. Under **Settings, Connections**, press **New
connection**, stay on the **Sign in** tab, and pick the tool. Yardbell names the site you will sign in
at, your browser opens that site, and you approve what Yardbell may do. When you finish, the page moves
on by itself and lists what the tool offers. Yardbell keeps the tokens in its secrets store, hidden
from the **Secrets** list, and refreshes them by itself. **Sign out** on the row forgets them, and
removing the connection does too.

| Tool | Sign-in | In pipelines |
|---|---|---|
| Trello | Tested with a real account | Starts runs by itself. It can also read, move and comment on cards. Reading the card list is tested with a real account; the others are not yet |
| Jira | Tested with a real account | **Use a connected tool** steps. Starting runs waits until its issue search has been read from a real site |
| Sentry | Tested with a real account | **Use a connected tool** steps |
| GitHub, Slack, Asana, PagerDuty, HubSpot | Not tried. Each needs an app you make in its developer console, and Yardbell asks for the client ID and shows the redirect address to register | **Use a connected tool** steps |
| Linear, GitLab, Notion, ClickUp, monday.com, Datadog, PostHog, Vercel, Supabase, Stripe, Figma, Intercom, Airtable, Zapier, Dropbox | Not tried. Each answers as an MCP server wanting a sign-in, but may still refuse Yardbell | **Use a connected tool** steps |

**Not listed?** Use the **MCP server** tab, paste the address from the tool's docs, and press
**Continue**. Yardbell takes the name from the address, signs in if the server asks for it, and lists
its tools. If the tool gave you a token instead, open **More options** and paste it under **Token**.

**On another device.** A sign-in sends your browser back to `127.0.0.1` on the machine running
Yardbell, which on a phone is the phone itself, so that page will not load. Yardbell says so first and
shows a box. Copy the address of the page that did not load, paste it there, and press **Finish signing
in**.

**Sign in again.** A sign-in can expire or be revoked on the tool's side. The row then says **Sign in
again**, a trigger starts nothing, and a step that needs it waits and tells you once. No run ever opens
a browser by itself. Sign in, then retry the run.

**Agents sign in separately.** An agent session gets the connection's address, but not Yardbell's
sign-in, and signs in by itself on its own machine.

### Use a connected tool

A **Use a connected tool** step does one action in a tool, with no agent and no model. Pick the
connection and the action. On a signed-in server you can pick any of its tools, and fill in the fields drawn from what the tool accepts. A value such as
`{{ticket}}` fills in from the run. A field Yardbell cannot draw takes JSON.

- The reply is the step's report, up to 20,000 characters, and later agents read it as quoted data.
- An error from the tool, or no answer within 60 seconds, goes down the fail line.
- A step counts as changing something unless you tick **Only reads**. A tool's own label is only a hint,
  and only pre-ticks the box. A step that changes something can be refused by a Dispatch rule on
  `call_tool`.
- Yardbell remembers each tool as it was when you saved the step. If the server changes its name,
  description or inputs, the run waits and shows the tool as it is now, and **Accept and run** goes on.
  A step Dispatch proposed waits this way the first time too.
- A step cannot call Yardbell's own MCP server. That is refused on save and when it runs.

### Connect Trello with a token

1. In Trello, make an API key and a token: [Trello's guide](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/).
2. In Yardbell, save them as the secrets `trello_key` and `trello_token`, under **Settings, Connections,
   Secrets**.
3. Under **Settings, Connections**, press **New connection**, pick **Trello**, then **Save**.
4. Press **Test**. It reads your first board, and shows its cards and every field you could map.
5. On a pipeline's **Build** tab, pick **A connected tool** under **Start when**, then the board and lists.
   A trigger sees every open card on that board, assigned to you or not. Pick the lists work starts from.

An **Update the ticket** step moves or comments on a Trello card the same way it does a Linear ticket.

### Add another tool

For a tool with no MCP server, press **New connection** under **Settings, Connections**, open the
**Token** tab and pick an example (Trello, GitHub Issues, GitLab Issues, Jira or Asana, which you check with **Test** on your own account) or **Start blank**, or ask Dispatch: "connect my Jira". Dispatch's version
waits for you as a proposal and arrives switched off. A connector looks like this:

```yaml
connectors:
  - id: jira
    name: Jira
    base_url: https://acme.atlassian.net/rest/api/3
    headers:
      Authorization: 'Basic ${secret:jira_basic}'
    calls:
      list:
        request: { method: GET, path: /search, query: { jql: 'assignee = currentUser()' } }
        items: issues
        map: { item_id: id, id: key, title: fields.summary, url: self, state: fields.status.name }
        page: { style: offset, param: startAt, size: 50 }
      read:
        request: { method: GET, path: '/issue/{{item_id}}' }
        map: { title: fields.summary, description: fields.description, state: fields.status.name }
      comment:
        request: { method: POST, path: '/issue/{{item_id}}/comment', body: { body: '{{value}}' } }
```

This example has not been run against Jira, so press **Test** and adjust it to your API. **Share** copies
a connector as text with its secret names but no values, and **Import** adds one switched off, naming
the host it can reach and the secrets it needs.

Each call has:

| Key | What it does |
|---|---|
| `request` | `method`, `path`, and optional `query` and `body`. `{{name}}` fills in a value |
| `items` | Where the list is in the reply, when it is not the top level |
| `map` | Which reply field is the `item_id`, `id`, `title`, `url`, `description`, `state` and `closed` |
| `before` | Up to 3 requests to run first, used as `{{steps.name.path}}` |
| `error` | A field that means failure even in a 200 reply, as GraphQL's `errors` does |
| `kind` | `lookup` or `change`. GET is `lookup` and the rest `change` unless you say so. A POST that only reads, like a GraphQL list, needs `kind: lookup` |
| `page` | How to read the next page, see below |

`list` and `read` make a connector a source of work. `states` and any call named by `params` fill the
builder's lists with names. Only mapped fields are kept: the rest of a reply is never stored.

### Add a filter to a connection

A choice marked as a filter is optional, and narrows which items [start a run](#filter-which-tickets-start-a-run).
In the form it is the **Filter** box under **Choices**. There are two ways to apply one:

```yaml
params:
  - { name: repo, label: Repository, options: repos }
  - { name: label, label: Label, options: labels, filter: true }   # the tool filters
  - { name: team, label: Team, filter: true }                      # Yardbell filters
calls:
  labels:
    request: { method: GET, path: '/repos/{{repo}}/labels' }
    map: { id: name, name: name }
  list:
    request: { method: GET, path: '/repos/{{repo}}/issues', query: { labels: '{{label}}' } }
    map: { item_id: number, title: title, team: 'assignee.team' }
```

Use the tool's own filter when it has one, because it reads less. The slot must be the whole value of a
query field or tool argument, and it is left out when no filter is picked. Otherwise map a field with the
filter's name, and Yardbell keeps the items whose field matches, ignoring case. The field can be a list,
like `labels[].name`, and an item without it does not match. **Save** refuses a filter that does neither.

### Paging

```yaml
page:
  style: cursor                    # cursor, number, offset or link
  param: after                     # the query field to send; a GraphQL body uses {{cursor}}
  next: pageInfo.endCursor         # cursor only: where the next value is
  has_more: pageInfo.hasNextPage   # optional: stop when this is false
  size: 100                        # number and offset: stop on a page shorter than this
```

At most 20 pages, or `max_pages` up to 100, and 5,000 items. Reaching a limit keeps what was read, and
the connection's status says the list was cut off. A page that fails fails the whole check, and the next
check starts again. Nothing already seen starts a second run.

### Safety

- Tokens stay in Secrets. A header holding a literal credential is refused.
- Every request stays on the connector's host, and redirects are not followed.
- Private addresses are refused unless you tick **Allow private addresses** in Settings. An agent, a
  proposal or an import cannot turn that on, and a connector proposed with a new host loses it.
- Item text reaches agents quoted as data, so a card cannot give an agent orders. A title stays one line.
- A call that changes something is the Dispatch rule action `call_connector`, so a rule can refuse it.
  Rules match the action, not one connector. Starting a run is the approval, so add a **Wait for me** step
  before a change you want to check.
- A connector is added only by you, or by a proposal you approve.

### Webhooks

A pipeline whose trigger is **A webhook** starts a run when something POSTs to its address.

**Yardbell listens on this machine and your mesh, so an outside service such as Trello cannot reach it
without a tunnel you set up.** This is why connectors poll every 3 minutes by default. Webhooks suit
systems on your mesh.

Press **New address** in the builder. It is shown once, works when the pipeline is saved and switched on,
and replaces any earlier one. The body is JSON:

```json
{ "id": "T-9", "title": "Fix the export", "url": "https://...", "description": "..." }
```

`id` and `title` are required. If yours differs, name where each one is, like `action.data.card.id`. An
`id` that already has a run starts nothing. A body is limited to 1 MB, and a pipeline to 30 requests a
minute. `HEAD` answers 200 for tools that check an address first. A vendor's own signature is not
checked: the address's token is the check.
