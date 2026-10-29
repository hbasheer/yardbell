# Triggers, worktree setup, rules and the ticket pipeline

How to let Yardbell start work for you, prepare every new worktree, decide what Dispatch may do
without asking, and carry Linear tickets from implementation to a draft pull request. Each part has
what it is, when it helps, and examples you can copy.

The settings themselves are listed in [Configuration](configuration.md): see
[`triggers`](configuration.md#triggers-optional),
[`worktree_setup`](configuration.md#worktree_setup-optional) and
[`dispatch`](configuration.md#dispatch-optional) and
[`pipeline`](configuration.md#pipeline-optional).

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
   Yardbell under **Settings**, **MCP servers**, **Secrets** with the name `linear`. For GitHub,
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
Dispatch to read the ticket's description, add Linear under **MCP servers** in Settings as well;
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
- **Linear filters** beyond "assigned to me" and states, such as a team, a label or a project, are
  not available. Every ticket assigned to you starts a conversation, but the task can tell
  Dispatch to stop there ("if the ticket is not in the Web team, start nothing and say so").
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

## The ticket pipeline

### What it does

The pipeline takes Linear tickets and carries each one through the same stages you would, on its
own, and stops only when it needs you:

| Stage | What happens |
|---|---|
| Triage | Dispatch reads the ticket and its comments. Clear enough: it picks one of your pipeline machines, the folder and a branch named after the ticket (`com-1234-fix-webhook-dedup`), and says why. Not clear: it asks you, and the ticket waits under **Needs you**. |
| Implement | A new worktree on that branch, with your worktree setup, and an agent that makes the change, adds tests, runs them and commits. Nothing is pushed. |
| Review and fix | The **Review branch** reviewer reads the branch and runs the tests. High and medium findings go back to the implementer, then the reviewer looks again, up to `review_rounds` times. Low findings do not hold the ticket. |
| QA | The branch and its uncommitted changes are copied to your test machine, where a QA agent that cannot edit files runs the specs for the changed code and checks the ticket's behaviour in the Rails console, and reports pass or fail with what it ran. A fail goes back to the implementer once (`qa_retries`). |
| Finish | The branch is pushed (with the secret check, never forced), a draft pull request or merge request is opened with a summary, the Linear ticket moves to `linear_state`, and a Linear comment is drafted for you to post. |

Each ticket gets its own Dispatch conversation, where every step shows as a card marked **Ran as
part of the pipeline**. Starting a run is the one approval: your Dispatch rules still refuse what
they refuse, and a step a rule refuses stops its ticket with the rule's reason.

### When it stops for you

A ticket parks under **Needs you** on the Pipeline page, and your phone gets a notification, when:

- triage has questions;
- an agent asks something or waits on a prompt (its screen is shown);
- the review still finds high or medium problems after the last round, or QA still fails;
- the push is refused, by the secret check or a rule;
- its machine stays offline for 30 minutes, or a stage runs longer than `stage_minutes`;
- the ticket was closed in Linear meanwhile.

Answer in the box, and the answer goes where the ticket stopped: back to triage, typed into the
waiting agent, or sent to the implementer with the open findings. **Retry** runs the stage again,
and **Drop** stops the ticket's sessions and leaves its worktree and branch.

### Set it up

1. Save your Linear API key as the secret `linear` (Settings, MCP servers, Secrets).
2. Log in `gh` on the machines that implement tickets, for draft pull requests. For GitLab, the
   host's token under `pull_requests.gitlab` needs the `api` scope to open merge requests.
3. Add a `pipeline` section to `yardbell.yml`:

```yaml
pipeline:
  machines: [hp, mini]        # where tickets are implemented; Dispatch picks among these
  test_machine: devbox        # where QA runs
  per_machine: 2              # tickets at once per machine
  review_rounds: 2
  qa_retries: 1
  stage_minutes: 120
  linear_state: In Review     # where finished tickets move; leave out to not move them
  qa_instructions: |
    Run specs with: docker compose exec web bin/rspec <files>
    Rails console:  docker compose exec web bin/rails console
```

4. Run `yardbell doctor`. Its `pipeline` lines say whether Linear answers and `gh` is logged in.

### Start a run

- **By hand:** on the Pipeline page, **Show my open tickets**, tick some and **Start**, or pick a
  state and **Start all in Todo**.
- **As tickets arrive:** a Linear trigger with `start: pipeline` puts each ticket it fires for into
  the pipeline.
- **On a schedule:** a schedule trigger with `start: pipeline` and `state: Todo` starts all your
  open tickets in Todo at its time.

```yaml
triggers:
  - name: Nightly tickets
    start: pipeline
    state: Todo
    schedule: weekdays 02:00
  - name: New tickets
    start: pipeline
    linear:
      assigned: true
```

A ticket that is already in a run is never started twice. Records are kept in `pipeline.json` in
the state folder, so a restart carries on where each ticket was.

### Limits

- Dispatch can only pick a folder a pipeline machine already has; otherwise triage says so.
- QA follows `qa_instructions` for how a repository runs its specs and console. Without them the QA
  agent finds out from the repository, which takes longer.
- GitHub issues cannot start the pipeline; it reads Linear tickets only.

