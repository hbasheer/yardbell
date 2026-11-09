# Yardbell and PR Lens compared

This compares Yardbell, as it is on `main` at 0.10.411, with
[coldteadotai/pr-lens](https://github.com/coldteadotai/pr-lens) ("PR Lens"), read at commit
`7d7042c` on 2026-11-09. PR Lens is MIT. Nothing below copies its code; where an idea is worth
taking, the note says how it would be built from Yardbell's own parts. Recommendations 1 to 4
below are now built (marked **Has, built from this**); posting to GitHub or GitLab is not.

The question behind it: what would it take for Yardbell to review the pull request or merge request
of every session that has one, on GitHub and on GitLab, and show that review on the session.

## What PR Lens is

PR Lens is not a code reviewer. Its model prompt says so in its second paragraph: it "never
reports bugs, risks, style or security findings", and its schema has no field for them. It reads a
pull request's diff and asks a model (Gemini by default, or anything that speaks
`/chat/completions`) for one JSON "graph document": lanes, components and the calls between them,
each marked new, changed, removed or unchanged, plus optional data flows and a data model. A
deterministic renderer turns that into animated SVG diagrams, and the result is posted as one
comment on the pull request, which is updated in place on every push.

It runs as a hosted GitHub App, a GitHub Action, a GitLab CI/CD component, a Bitbucket pipe, a CLI
and an agent skill. The parts that matter for Yardbell are not the diagrams but the plumbing around
them: how it takes the diff, how it keeps the model's facts honest, how it keeps exactly one
comment per pull request, and how it avoids posting something stale.

## How PR Lens does each part

- **Diff and context.** `git merge-base base head`, then `git diff --numstat --find-renames` for
  the file list and `git diff --unified=3` for the patch. The patch is cut at 400,000 bytes and the
  prompt says where it was cut. On GitLab it uses `CI_MERGE_REQUEST_DIFF_BASE_SHA` as the base and
  `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` as the head, because in a merged-results pipeline
  `CI_COMMIT_SHA` is a throwaway merge commit that the merge request never names.
- **Prompt and structure.** A long system prompt, the JSON Schema of the document, the file list
  with line counts, then the patch. The answer is parsed, validated against the schema, and on
  failure the exact validation errors go back for one repair round (two attempts in all).
- **Facts the model does not get to state.** Commit shas, file and line counts, the time and the
  lenses asked for are written over whatever the model returned, "because a fact the model is free
  to restate is a fact that eventually disagrees with itself".
- **Showing it.** Headline, number chips, one diagram per lens, and folding `<details>` sections
  for narrower views. No findings, no severity, no inline comments.
- **Posting back.** One comment per pull request, found again by a hidden marker
  (`<!-- pr-lens -->`) **and** by its author being the token's own user, since anyone can paste the
  marker. Found: edit it. Not found: post a new one. On GitLab this is the notes API with a project
  access token that has the `api` scope, because `CI_JOB_TOKEN` cannot post notes.
- **Not posting something stale.** Before uploading and again right before writing, it asks the
  forge for the pull request's current head. If that is no longer the commit it drew, it exits
  without touching the comment, so an older run never overwrites a newer one. A failed lookup is a
  failure, not a reason to post. CI concurrency also cancels superseded runs.
- **Re-review after new commits.** Every push runs again (`synchronize` on GitHub, merge request
  pipelines on GitLab). The hosted App can instead draw only on request, after someone comments
  `@pr-lens draw`, and leaves a one-line notice saying so.
- **Model text is untrusted.** Every model-written string is HTML-escaped, kept on one line inside
  an HTML element so markdown is not parsed, and has a zero-width space put after reference sigils
  (`@` and `#` on GitHub; also `!`, `~`, `%`, `$`, `&` on GitLab), so a diff cannot ping a person,
  link an issue or plant a link that looks like the tool's own.
- **Config.** `.github/pr-lens.yml` (or `.gitlab/pr-lens.yml`, or `pr-lens.yml`): which lenses, a
  corrections overlay (rename, exclude by path glob, pin to a lane, group) applied after every run
  so it survives the model renaming things, a glossary file, footer branding, and for the App,
  auto or on-demand drawing.
- **Never blocks a merge.** The GitLab job is `allow_failure: true` and `interruptible: true` by
  default, with a short timeout.

## What Yardbell already has

- **Review branch** (`review_session`): a read-only agent in the session's own folder that reads
  the commits not on the branch it was made from plus uncommitted changes, runs the tests and
  linters, and ends with a `YARDBELL REVIEW` block: verdict, base, summary, and findings with
  severity and `file:line`. Optional screenshots when the folder runs an app.
- **Pinned to the code it read**: the commit plus a hash of the uncommitted changes. A second
  request for the same code says a review is already running or already done. The card can say
  whether the code has since moved.
- **Findings go back to the session**: pick findings on the card and **Send to session**, or start
  a new session with them.
- **Review card with a diff viewer** anchored to the base and head the review used.
- **Scans** (`scan_folder`): dead code, test gaps, security, over a whole folder.
- **Pull and merge requests for every session's branch**, GitHub through `gh` or a token and GitLab
  through a token or `glab`: CI, failed checks with log excerpts, review state, comments, conflicts.
  Cards for CI failures, review comments and conflicts, each with **Send to session**.
- **PR notifications** (0.10.411): CI failed, conflicts, ready to merge, merged, closed.
- **Pipelines** that review: **Review my merge requests** (others' merge requests where you are the
  reviewer, on GitLab) and review steps inside **Implement** pipelines.
- **Diagrams**: Dispatch can draw a diagram of a folder or a description with archify, shown in a
  sandboxed frame.

## Legend

- **Has**: Yardbell already does this, perhaps in its own way.
- **Partly**: some of it is there.
- **Lacks**: not there. Gaps get a value and an effort rating.
- **N/A**: does not fit Yardbell, with the reason.

Effort: **S** is a day or less, **M** a few days, **L** a week or more.

## Per-session pull and merge request review

This is the part that matters most. PR Lens itself has no findings, so the comparison here is
between what PR Lens does around its output and what Yardbell does around its reviews.

| Feature | PR Lens | Yardbell | Notes |
|---|---|---|---|
| Review on demand | CLI run, or `@pr-lens draw` on the App | **Has, built from this** | **Review branch** exists, but only on a session card inside a Dispatch conversation. The dashboard row and the Workspace pane, where a session's PR badge already shows, have no way to start one. Value **high**, effort **S**. Add **Review pull request** to the dashboard row's actions and the Workspace pane's ⋯ menu when the session has a PR; it calls the same endpoint as **Review branch**, posting into the conversation that follows the session (the same rule `post_pull` uses for PR cards). |
| Review against the PR's real base | Merge base of the PR's base and head; GitLab's own diff base sha | **Has, built from this** | Value **high**, effort **S**. The review prompt tells the agent to compare with "the branch it was made from (usually main)", so a merge request into `develop` or a release branch is reviewed against the wrong base. The pulls cache already knows `Pull.base`. When the session has a PR, the prompt names `origin/<base>` and the merge base, and the review card says which PR it reviewed. |
| Review tied to the PR's head commit | Every run records base and head sha | **Has, built from this** | Reviews are pinned to the local commit and uncommitted changes. They do not know which PR or which PR head they covered, and nothing says when the folder is ahead of what was pushed. Value **high**, effort **S**. Record `pull: {forge, number, url, head, base}` on the review (`ReviewOf`), and when the pin's commit is not the PR's head, say so on the card ("reviewed local work that is not pushed yet"). |
| Re-review when new commits are pushed | Runs on every push; superseded runs are cancelled | **Has, built from this** | Value **high**, effort **M**. The pulls poller already reads every session PR's head on each round. Add a `Change::Pushed` in `pulls::observe` when an open PR's head differs from the one last reviewed, kept in `Seen` so a restart does not repeat it. A new Settings choice under **Pull requests**, **Review my sessions' pull requests: Off / Ask / Automatically**. It proposes a `review_session` in the conversation that follows the session, so Dispatch rules decide: Ask shows an Approve card, and a rule that allows `review_session` makes it automatic. Start only when the session is idle and its folder's commit equals the PR head, so the reviewer reads what was pushed, not half-done work. One review per head commit; the existing pin check stops duplicates. Off by default, since each review spends the agent's tokens. |
| Review when a PR first opens | Runs when the PR opens | **Has, built from this** | Same mechanism as the row above: the first sighting of an open PR counts as a push when the switch is on. Today a first sighting is deliberately silent, which stays true when the switch is off. |
| On-demand only, with a notice | `draw: on-demand`, a short notice on the PR | **N/A** | **Ask** covers it inside Yardbell. A notice on the forge would be noise on your own PR. |
| Show the review on the session | The comment sits on the PR | **Has, built from this** | Value **high**, effort **S to M**. A review lives only as a card in a Dispatch conversation. Next to the PR badge on the dashboard row, Board card and Workspace pane, show a review mark: **Reviewing**, **Ready**, **3 findings** (with the highest severity as its tone), or **Reviewed an older commit** when the PR head has moved past it. It links to the review card. The server keeps the newest review per machine, folder and branch from the Dispatch store, and the snapshot's session JSON carries it next to `pull`. |
| Review stays honest about staleness | Re-reads the PR head right before writing | **Has, built from this** | The review card can check whether the code moved (`/reviews/{card}/commit`). Nothing compares against the PR head. Covered by the two rows above. |
| Post the review to GitHub or GitLab | One comment per PR, found by marker and author, edited in place | **Lacks** | Value **medium**, effort **M**. A **Post to pull request** button on a finished review card, and a new Dispatch action `post_review` so rules apply and it asks by default. One summary comment per PR with a hidden marker, edited on later reviews instead of adding a comment per push. Find it by marker and by author being the user whose credentials post it. Before posting, read the PR head again and refuse if the review read a different commit. GitHub: `gh api` on the session's machine (issue comments `POST` or `PATCH`), or the configured token. GitLab: the notes API with the saved token, or `glab api`. This needs the `api` scope; today's docs promise `read_api` is enough because Yardbell never writes to GitLab, so posting must say clearly that it needs `api`, and fail with that message when the token lacks it. Escape findings like PR Lens does: no raw HTML, no markdown links from model text, and a zero-width space after `@`, `#` (and on GitLab `!`, `~`, `%`, `$`, `&`). |
| Inline comments on lines | None | **Lacks** | Value **low to medium**, effort **L**. GitHub review comments and GitLab diff discussions need a line that is inside the diff and, on GitLab, the base, start and head shas. Findings often name lines outside the diff, so many would have to fall back to the summary anyway. Worth doing only after summary posting has been used for a while. |
| Post automatically after an automatic review | Always posts | **N/A** | Posting under your own name on every push should stay a decision. A Dispatch rule that allows `post_review` can make it automatic for those who want it. |

## Review quality and safety

| Feature | PR Lens | Yardbell | Notes |
|---|---|---|---|
| Findings with severity and place | None, by design | **Has** | Yardbell is ahead here: high, medium, low with `file:line`, screenshots, sent back to fix. |
| Reviewer runs the tests | No, it reads the diff only | **Has** | The reviewer runs in the session's checkout. |
| Structured output with a schema and a repair round | JSON Schema, validated, errors sent back once | **Partly** | Yardbell reads a text block leniently from the screen, which works across every agent CLI. A report that never parses just leaves the card waiting. Value **low**, effort **S**: when a reviewer goes idle with no readable report, send one nudge asking for the block again. |
| Facts stamped from the repo, not the model | Shas, counts and lenses overwritten | **Has** | The pin is read by Yardbell, not reported by the agent. The `base:` line is the only model-stated fact, and it is checked with `valid_base` before use. |
| Diff size budget | 400 KB, and the prompt says where it was cut | **N/A** | The reviewer is an agent reading files in its own folder, so nothing is pasted into a prompt. |
| Model text escaped before it reaches a forge | Yes, per forge | **N/A** today | Yardbell posts nothing yet. Required if posting is built (see above). |
| Never block a merge | `allow_failure`, short timeout | **Has** | Reviews are advisory and never gate CI. |

## Configuration

| Feature | PR Lens | Yardbell | Notes |
|---|---|---|---|
| Per-repo config file | `.github/pr-lens.yml`, `.gitlab/pr-lens.yml` | **Lacks** | Value **low to medium**, effort **S**. Reviewers already read the repo's `CLAUDE.md` or `AGENTS.md`, which covers house rules. A default review focus per folder in Settings (for example "ignore `db/schema.rb` and lockfiles") would cover the rest without a new file format. |
| Exclude files by glob | `map.exclude` | **Lacks** | Part of the row above; as focus text the agent follows it. |
| Glossary of the team's terms | `glossary: docs/CONTEXT.md#Language` | **N/A** | The reviewer reads the repo and its docs itself. |
| Choice of model provider | Gemini, OpenAI, any compatible endpoint | **Has** (differently) | Yardbell runs whichever agent CLI you set for Dispatch, with its own login. |
| Auto or on-demand | `draw: auto` or `on-demand` | **Has, built from this** | The Off / Ask / Automatically switch above. |

## Integrations and output

| Feature | PR Lens | Yardbell | Notes |
|---|---|---|---|
| GitHub | App, Action | **Has** | Through `gh` on the session's machine, or a token. |
| GitLab | CI/CD component, notes API, uploads | **Has** for reading | Token or `glab`. Writing is the posting row above. |
| Bitbucket | Pipe | **N/A** | No user asking for it; Yardbell reads no Bitbucket PRs today. |
| Runs in CI | Action, component, pipe | **N/A** | Yardbell's point is running on your own machines, in the session's checkout, with your agent. |
| Architecture and data-flow diagrams of a PR | The whole product | **Partly** | Dispatch can draw a diagram of a folder or a description with archify. Value **low to medium**, effort **S**: a **Draw this change** button on a review card that asks for a diagram of the reviewed diff. Not on the path to reviewing every session's PR. |
| Interactive canvas, walkthroughs, live agent on the canvas | Hosted canvas | **N/A** | A hosted service; Yardbell's diagrams open locally. |
| Agent skill | `npx skills add` | **N/A** | Dispatch and the MCP server already give agents Yardbell's tools. |

## Recommended, in order

1. **Review against the PR and record it** (high, S). When a session has a PR, the review prompt
   names the PR's base, the review records the PR number, URL and head, and the card says when it
   read local work that is not pushed. Everything else builds on this.
2. **Review pull request from the session** (high, S). A button among the dashboard row's actions and an
   item in the Workspace pane's ⋯ menu when the session has a PR, posting into the conversation that follows the
   session.
3. **Show the review on the session** (high, S to M). A review mark next to the PR badge: reviewing,
   ready, N findings, or reviewed an older commit, linking to the card.
4. **Review when a session's PR opens or gets new commits** (high, M). Off, Ask or Automatically in
   Settings, through Dispatch rules, once per head commit, only when the session is idle and its
   folder matches the PR head.
5. **Post the review to GitHub or GitLab** (medium, M). One summary comment per PR, edited in place,
   on a button and a rule-gated `post_review`, with the head re-checked before writing and model
   text escaped. GitLab needs a token with the `api` scope.

Worth doing later: inline comments on lines, a nudge when a reviewer ends without a readable report,
a default review focus per folder, and **Draw this change** from a review card.
