#!/usr/bin/env python3
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bidi import Browser, Failure, free_port  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PASSCODE = "yardbell-browser-tests"
PASSCODE_HASH = "$argon2id$v=19$m=19456,t=2,p=1$W9HtFU6zAJJHfaLZxyoLZw$CowUQvJ7lk5RORBJ4iV9u9uJi2N9R2CA1dxq3fupAOg"
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
MACHINE = "hp"
SHORT_CHAT = "browsertestshort"
LONG_CHAT = "browsertestlong0"
REVIEW_CHAT = "browserreview001"
SCAN_CHAT = "browserscan00001"
SHOT_FILE = "shotbrowsertest1.png"
PULL_CHAT = "browsertestpull0"
GITLAB_CHAT = "browsergitlab001"
GROUP_CHAT = "browsergroup0001"
RESULTS_CHAT = "browserresults01"
MEMORY_CHAT = "browsermemory001"
MEMORY_OLD = "Run docker on hp"
MEMORY_NEW = "Always use the shared docker stack on hp"
SETTINGS_CHAT = "browsersettings1"
SETTINGS_EDIT_CHAT = "browsersettings2"
TASK_CHAT = "browsersavetask1"
NEW_TASK = "Standup notes"
REFUSED = "the user's Dispatch rule \"deny start_session on pro\" refuses it"
PULL_SESSION = "hp-pull-test"
FAKE_PR = {
    "number": 12,
    "url": "https://github.com/acme/demo-app/pull/12",
    "title": "Fix the login redirect",
    "state": "OPEN",
    "isDraft": False,
    "reviewDecision": "REVIEW_REQUIRED",
    "headRefOid": "abc123",
    "author": {"login": "hb"},
    "statusCheckRollup": [
        {"__typename": "CheckRun", "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE",
         "detailsUrl": "https://github.com/acme/demo-app/actions/runs/111/job/222"},
    ],
    "comments": [],
    "reviews": [],
}
PAGES = ["/", "/workspace", "/dispatch", "/settings", "/add"]
TRIGGER = "Morning summary"
# Dispatch runs this instead of Claude Code: canned stream-json, the shape `claude -p` prints.
FAKE_CLAUDE = """#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"fake-session"}'
case "$*" in
*"Suggest a better prompt"*)
  # printf, since the echo of dash turns \\n into a line break and breaks the JSON.
  printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"It waited for the test command.\\n\\n```prompt\\nFix the login redirect in demo-app. Run npm test before you finish.\\n```"}]}}'
  ;;
*)
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Nothing needs you right now."}]}}'
  ;;
esac
echo '{"type":"result","is_error":false,"result":"done"}'
"""
# Dispatch runs this instead of Codex when it runs on Codex: the JSONL `codex exec --json` prints,
# after it calls Yardbell's own MCP server the way Codex does, with the token from its environment.
FAKE_CODEX = """#!/usr/bin/env python3
import json, os, sys, urllib.request

args = sys.argv[1:]
if args == ["--version"]:
    print("codex-cli 0.165.0")
    sys.exit(0)
conf = dict(args[i + 1].split("=", 1) for i, a in enumerate(args) if a == "-c")
url = json.loads(conf["mcp_servers.yardbell.url"])
conversation = conf["mcp_servers.yardbell.http_headers"].split("=")[-1].strip('"}')
token = os.environ[json.loads(conf["mcp_servers.yardbell.bearer_token_env_var"])]
prompt = sys.stdin.read()
resumed = args[1] == "resume"
thread = args[-2] if resumed else "fake-codex-thread"


def mcp(n, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": n, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token, "x-yardbell-conversation": conversation})
    return json.load(urllib.request.urlopen(req, timeout=10))["result"]


def say(line):
    print(json.dumps(line), flush=True)


mcp(0, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake-codex", "version": "0"}})
say({"type": "thread.started", "thread_id": thread})
say({"type": "turn.started"})
if resumed:
    heard = "rejected" in prompt
    say({"type": "item.completed", "item": {"id": "item_0", "type": "agent_message",
         "text": "Understood, nothing started." if heard else "I did not hear what happened."}})
else:
    calls = [("list_machines", {}), ("start_session", {"machine": "hp", "folder": "demo-app", "prompt": "Fix the login redirect."})]
    for n, (tool, arguments) in enumerate(calls, 1):
        item = {"id": f"item_{n}", "type": "mcp_tool_call", "server": "yardbell", "tool": tool, "arguments": arguments}
        say({"type": "item.started", "item": {**item, "result": None, "error": None, "status": "in_progress"}})
        result = mcp(n, "tools/call", {"name": tool, "arguments": arguments})
        say({"type": "item.completed", "item": {**item, "result": {"content": result["content"]}, "error": None, "status": "completed"}})
    say({"type": "item.completed", "item": {"id": "item_9", "type": "agent_message", "text": "I proposed a session on hp in demo-app."}})
day = os.path.join(os.environ["HOME"], ".codex", "sessions", "2026", "10", "29")
os.makedirs(day, exist_ok=True)
with open(os.path.join(day, f"rollout-2026-10-29T00-00-00-{thread}.jsonl"), "a") as f:
    f.write(json.dumps({"timestamp": "2026-10-29T00:00:00Z", "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
        "primary": {"used_percent": 42.0, "window_minutes": 300, "resets_at": 4102444800},
        "secondary": {"used_percent": 7.0, "window_minutes": 10080, "resets_at": 4102444800},
        "rate_limit_reached_type": None}}}) + "\\n")
say({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}})
"""
INSIGHTS_CHAT = "browserinsight01"
OLD_RUN = "hp-old-run"
OLD_TASK = "Fix the login"
PROMPT = "Fix the login redirect in demo-app. Run npm test before you finish."


def git(*args, cwd):
    subprocess.run(
        ["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def tail(path):
    with open(path) as f:
        return f.read()[-3000:]


def png(width, height):
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            if y < 48:
                pixel = (48, 48, 48)
            elif 300 < y < 344 and 40 < x < 240:
                pixel = (31, 147, 255)
            elif y > height - 60:
                pixel = (220, 38, 38)
            else:
                pixel = (247, 247, 247)
            row += bytes(pixel)
        rows.append(bytes(row))

    def chunk(kind, data):
        body = kind + data
        return len(data).to_bytes(4, "big") + body + zlib.crc32(body).to_bytes(4, "big")

    header = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


# A branch with commits, a rename, a binary, a long file, a change not yet committed and a new
# file, the shapes a review's diff has to show.
def review_branch(repo):
    write(os.path.join(repo, "docs", "old-name.md"), "# Notes\n")
    git("add", ".", cwd=repo)
    git("commit", "-q", "-m", "notes", cwd=repo)
    git("checkout", "-q", "-b", "fix-login", cwd=repo)
    write(os.path.join(repo, "src", "login.js"), "".join(f"const step{i} = {i};\n" for i in range(1, 60)))
    write(os.path.join(repo, "src", "big.txt"), "".join(f"line {i}\n" for i in range(1, 1201)))
    with open(os.path.join(repo, "logo.png"), "wb") as f:
        f.write(png(4, 4))
    git("mv", "docs/old-name.md", "docs/new-name.md", cwd=repo)
    git("add", ".", cwd=repo)
    git("commit", "-q", "-m", "login", cwd=repo)
    with open(os.path.join(repo, "README.md"), "a") as f:
        f.write("Log in with a passkey.\n")
    write(os.path.join(repo, "notes.txt"), "not committed\n")
    out = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
    return {"base": "main", "merge_base": out("merge-base", "HEAD", "main"), "head": out("rev-parse", "HEAD")}


def review_card(repo, anchor):
    return {
        "role": "review",
        "machine": MACHINE,
        "name": "hp-demo-app-2",
        "path": repo,
        "of": {"machine": MACHINE, "name": "hp-demo-app", "path": repo, "branch": "fix-login", "evidence": "browsershots"},
        "at": "2026-01-01T10:05:00+00:00",
        "verdict": "changes",
        "base": "main",
        "summary": "The login button is hidden on a phone, and one step is off by one.",
        "findings": [
            {"severity": "high", "place": "src/login.js:42", "text": "step42 should be 41.", "shots": ["login.png"]},
            {"severity": "medium", "place": "docs/missing.md:3", "text": "This file is not in the change.", "shots": ["gone.png"]},
            {"severity": "low", "place": "", "text": "Mention passkeys in the changelog."},
        ],
        "diff": anchor,
        "evidence": [
            {"finding": 0, "name": "login.png", "file": SHOT_FILE, "bytes": 1, "width": 640, "height": 400, "source": "/x/login.png"},
            {"finding": 1, "name": "gone.png", "error": "not found in the review folder"},
        ],
    }


# A security scan of the whole folder: one finding in a file that is there, one in a file that is
# gone, and one at a path outside the folder that must not become a link.
def scan_card(repo):
    return {
        "role": "review",
        "machine": MACHINE,
        "name": "hp-demo-app-3",
        "path": repo,
        "of": {"machine": MACHINE, "name": "", "path": repo, "branch": "fix-login", "scan": "security"},
        "at": "2026-01-01T10:10:00+00:00",
        "verdict": "issues",
        "summary": "A token in the login script, and two places worth a look.",
        "findings": [
            {"severity": "high", "place": "src/login.js:42", "text": "step42 holds a token. Read it from the environment."},
            {"severity": "medium", "place": "config/missing.yml:3", "text": "This file is gone."},
            {"severity": "low", "place": "/etc/passwd:1", "text": "Not a place in the folder."},
        ],
    }


def child_step(id, group, label, inp, status="pending", result=None):
    step = {"role": "action", "id": id, "tool": "start_session", "input": inp, "by": "dispatch", "status": status,
            "at": "2026-01-01T10:00:00+00:00", "group": group, "label": label}
    if result:
        step["result"] = result
    return step


# A group waiting for approval: two plain-shell children in different checkouts, and one the rules
# refused. A shell takes no task, so the children have none.
def group_chat(root):
    refused = {"label": "Pro", "input": {"machine": "pro", "folder": "demo-app", "prompt": "Fix it on pro."},
               "refused": REFUSED, "rule": {"action": "start_session", "machine": "pro", "approval": "deny"}}
    group = {"role": "group", "id": "grp00001", "title": "Try the login fix in both repos", "gather": "", "minutes": 30,
             "status": "waiting", "by": "dispatch", "at": "2026-01-01T10:00:00+00:00",
             "children": [{"label": "App", "step": "chldapp1"}, {"label": "Api", "step": "chldapi1"}, refused]}
    return conversation(GROUP_CHAT, "Try the login fix in both repos", [
        {"role": "user", "text": "Try the login fix in demo-app and demo-api"},
        group,
        child_step("chldapp1", "grp00001", "App", {"machine": MACHINE, "path": os.path.join(root, "demo-app")}),
        child_step("chldapi1", "grp00001", "Api", {"machine": MACHINE, "path": os.path.join(root, "demo-api")}),
    ])


# A group that timed out: one child reported a result, one waits for an answer, one never started.
def results_chat(root):
    repo = os.path.join(root, "demo-app")
    started = lambda name, branch: {"ok": True, "text": "{}", "at": "2026-01-01T10:01:00+00:00",
                                    "session": {"machine": MACHINE, "name": name, "path": repo}}
    group = {"role": "group", "id": "grp00002", "title": "Three ways to fix the redirect", "gather": "pick the smallest fix",
             "follow": True, "minutes": 30, "status": "gathered", "by": "dispatch", "at": "2026-01-01T10:00:00+00:00",
             "started": "2026-01-01T10:01:00+00:00", "gathered": "2026-01-01T10:31:00+00:00",
             "children": [{"label": "Guard", "step": "chldgrd1", "state": "ended"}, {"label": "Router", "step": "chldrtr1", "state": "ended"},
                          {"label": "Pro", "input": {"machine": "pro", "folder": "demo-app"}, "refused": REFUSED}]}
    results = {"role": "results", "group": "grp00002", "title": "Three ways to fix the redirect", "why": "timeout", "minutes": 30,
               "gather": "pick the smallest fix", "follow": True, "at": "2026-01-01T10:31:00+00:00", "children": [
                   {"label": "Guard", "started": True, "machine": MACHINE, "name": "hp-demo-app-7", "path": repo, "branch": "fix-guard",
                    "state": "finished", "screen": "YARDBELL RESULT\nstatus: done\nEND RESULT",
                    "result": {"status": "done", "summary": "Moved the redirect into the guard.", "branch": "fix-guard",
                               "details": ["12 tests pass", "Touches the session middleware"]}},
                   {"label": "Router", "started": True, "machine": MACHINE, "name": "hp-demo-app-8", "path": repo, "branch": "fix-router",
                    "state": "needs input", "screen": "Run the migration?\n ❯ 1. Yes\n   2. No"},
                   {"label": "Pro", "started": False, "note": f"refused: {REFUSED}"},
               ]}
    return conversation(RESULTS_CHAT, "Three ways to fix the redirect", [
        {"role": "user", "text": "Try three ways to fix the redirect"},
        group,
        child_step("chldgrd1", "grp00002", "Guard", {"machine": MACHINE, "path": repo, "branch": "fix-guard", "prompt": "Fix it in the guard."},
                   "approved", started("hp-demo-app-7", "fix-guard")),
        child_step("chldrtr1", "grp00002", "Router", {"machine": MACHINE, "path": repo, "branch": "fix-router", "prompt": "Fix it in the router."},
                   "approved", started("hp-demo-app-8", "fix-router")),
        results,
        {"role": "user", "text": "pick the smallest fix", "by": "yardbell"},
    ])


# Dispatch proposed to sharpen an entry after a correction; the memory holds the old one.
def memory_chat():
    step = {"role": "action", "id": "memstep1", "tool": "remember", "by": "dispatch", "status": "pending",
            "at": "2026-01-01T10:00:00+00:00",
            "input": {"change": "replace", "old": MEMORY_OLD, "entry": MEMORY_NEW,
                      "reason": "You said to use the shared stack, not a new one."}}
    return conversation(MEMORY_CHAT, "Start the api on hp", [
        {"role": "user", "text": "No, use the shared docker stack on hp, not a new one"},
        {"role": "assistant", "text": "Understood. I proposed keeping that in memory."},
        step,
    ])


# Dispatch proposed changing the phone notifications: the wait goes from 2 minutes to `wait`.
def settings_chat(id, step, wait):
    before = {"agent_waiting": True, "machines": True, "memory": True, "session_ended": True, "wait_minutes": 2}
    head = '{\n  "agent_waiting": true,\n  "machines": true,\n  "memory": true,\n  "session_ended": true,\n  "wait_minutes": '
    change = {"role": "action", "id": step, "tool": "change_settings", "by": "dispatch", "status": "pending",
              "at": "2026-01-01T10:00:00+00:00",
              "input": {"area": "phone", "value": {**before, "wait_minutes": wait}, "before": before,
                        "diff": [{"op": "same", "text": head}, {"op": "del", "text": "2"},
                                 {"op": "add", "text": str(wait)}, {"op": "same", "text": "\n}"}]}}
    return conversation(id, "Wait longer before phoning", [
        {"role": "user", "text": f"Only tell my phone after {wait} minutes"},
        change,
    ])


def task_chat():
    text = "List what changed yesterday and what waits for review."
    step = {"role": "action", "id": "taskstp1", "tool": "save_task", "by": "dispatch", "status": "pending",
            "at": "2026-01-01T10:00:00+00:00",
            "input": {"name": NEW_TASK, "text": text, "before": "", "diff": [{"op": "add", "text": text}]}}
    return conversation(TASK_CHAT, "Keep my standup as a task", [
        {"role": "user", "text": "Save my standup question as a task"},
        step,
    ])


# Linear's GraphQL API as the Pipeline page's ticket picker asks it: my open tickets.
LINEAR_TICKETS = [
    {"id": "u-12", "identifier": "COM-12", "title": "Redirect after login", "url": "https://linear.app/acme/issue/COM-12", "state": {"name": "Todo"}},
    {"id": "u-21", "identifier": "COM-21", "title": "Search by email", "url": "https://linear.app/acme/issue/COM-21", "state": {"name": "Todo"}},
    {"id": "u-22", "identifier": "COM-22", "title": "Export invoices", "url": "https://linear.app/acme/issue/COM-22", "state": {"name": "In Progress"}},
]


class FakeLinear(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = json.dumps({"data": {"viewer": {"assignedIssues": {"nodes": LINEAR_TICKETS}}}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def ago_stamp(minutes):
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - minutes * 60))


def review_pipeline():
    def agent(id, name, x, machine, workspace, nxt, instructions):
        return {"id": id, "name": name, "kind": "agent", "instructions": instructions, "agent": "",
                "machine": machine, "workspace": workspace, "session": "new", "read_only": True,
                "mcp_servers": [], "max_runs": 2, "next": nxt, "x": x, "y": 80}
    same = {"same_as": "understand"}
    return {
        "id": "review", "name": "Review my merge requests", "enabled": False, "version": 1,
        "trigger": {"kind": "gitlab_reviewer", "host": "git.example.com"}, "start": "plan",
        "steps": [
            {"id": "plan", "name": "Plan", "kind": "plan", "machines": [], "max_runs": 2,
             "next": {"pass": "understand", "fail": "wait", "needs_you": "wait"}, "x": -240, "y": 80},
            agent("understand", "Understand", 40, {"name": MACHINE}, {"kind": "new_worktree"},
                  {"pass": "root-cause", "fail": "report", "needs_you": "wait"}, "Read {ticket} and {pr}."),
            agent("root-cause", "Root cause", 320, same, {"kind": "same_as", "step": "understand"},
                  {"pass": "test", "fail": "report", "needs_you": "wait"}, "Does {pr} fix the root cause?"),
            agent("test", "Test", 600, same, {"kind": "copy", "from": "understand"},
                  {"pass": "report", "fail": "root-cause", "needs_you": "wait"}, "Run the specs for {branch}."),
            {"id": "report", "name": "Report to me", "kind": "report", "max_runs": 2,
             "next": {"pass": "end", "fail": "end", "needs_you": "wait"}, "x": 880, "y": 80},
        ],
    }


def pipeline_runs():
    definition = review_pipeline()

    def run(id, number, title, state, step, steps, waiting=None):
        url = f"https://git.example.com/acme/app/-/merge_requests/{number}"
        ticket = f"COM-{1200 + number}"
        return {
            "id": id, "pipeline": "review", "pipeline_name": definition["name"], "version": 1,
            "definition": definition, "key": f"pr:{url}", "started_by": "trigger", "started": ago_stamp(40 - number % 10),
            "subject": {"ticket": {"linear_id": f"u-{number}", "id": ticket, "title": title,
                                   "url": f"https://linear.app/acme/issue/{ticket}"},
                        "pr": {"url": url, "number": number, "branch": f"{ticket.lower()}-fix", "host": "git.example.com",
                               "project": "acme/app", "forge": "gitlab"}},
            # A machine that does not exist keeps the loop from starting real sessions for these runs.
            "place": {"machine": "nowhere", "folder": "demo-app", "branch": f"{ticket.lower()}-fix"},
            "state": state, "step": step, "step_since": ago_stamp(12),
            "steps": {name: {"runs": 1, "machine": "nowhere", "outcome": outcome, "report": report,
                             "started": ago_stamp(30), "ended": ago_stamp(20)}
                      for name, outcome, report in steps},
            "history": [{"step": name, "outcome": outcome, "at": ago_stamp(20)} for name, outcome, _ in steps],
            "waiting": waiting,
        }

    return {
        "run-a": run("run-a", 87, "Fix the webhook dedup", "waiting", "root-cause",
                     [("understand", "pass", "The duplicate check keys on the payload id only."),
                      ("root-cause", "needs_you", "Which window is right?")],
                     {"kind": "needs_you", "step": "root-cause", "reason": "Root cause needs you",
                      "screen": "The ticket says 5 minutes, the MR drops them within 60 seconds. Which window is right?"}),
        "run-b": run("run-b", 91, "Inbox filter", "waiting", "test",
                     [("understand", "pass", "Filters by label."), ("root-cause", "pass", "Fixes it."),
                      ("test", "fail", "The filter spec fails on an empty inbox.")],
                     {"kind": "stopped", "step": "test", "reason": "Test failed"}),
        "run-c": run("run-c", 84, "Login redirect", "done", "",
                     [("understand", "pass", "Clear."), ("root-cause", "pass", "Yes."),
                      ("test", "pass", "Specs pass."), ("report", "pass", "Looks good.")]),
    }


def conversation(id, title, events):
    stamp = "2026-01-01T10:00:00+00:00"
    return {"id": id, "title": title, "created": stamp, "updated": stamp, "events": events}


class Yardbell:
    def __init__(self, binary, tmp):
        self.root = os.path.join(tmp, "root")
        self.state = os.path.join(tmp, "state")
        self.tmux_dir = os.path.join(tmp, "tmux")
        home = os.path.join(tmp, "home")
        for d in (self.root, self.state, self.tmux_dir, home):
            os.makedirs(d)
        os.chmod(self.tmux_dir, 0o700)
        # Under a name of its own, the test shell is the only process the "shell" agent matches.
        self.shell = os.path.join(tmp, "yb-test-shell")
        os.symlink(shutil.which("bash"), self.shell)
        for repo in ("demo-app", "demo-api"):
            path = os.path.join(self.root, repo)
            git("init", "-q", "-b", "main", path, cwd=self.root)
            with open(os.path.join(path, "README.md"), "w") as f:
                f.write(f"# {repo}\n")
            git("add", "README.md", cwd=path)
            git("commit", "-q", "-m", "init", cwd=path)
        self.seed_dispatch()
        os.makedirs(os.path.join(self.state, "pipelines"))
        with open(os.path.join(self.state, "pipelines", "review.json"), "w") as f:
            json.dump({"history": [{"version": 1, "saved": ago_stamp(60), "definition": review_pipeline()}]}, f)
        with open(os.path.join(self.state, "runs.json"), "w") as f:
            json.dump(pipeline_runs(), f)
        self.linear = ThreadingHTTPServer(("127.0.0.1", 0), FakeLinear)
        threading.Thread(target=self.linear.serve_forever, daemon=True).start()
        # gh on the server's PATH answers for every branch with one failing pull request.
        fake_bin = os.path.join(tmp, "bin")
        os.makedirs(fake_bin)
        with open(os.path.join(fake_bin, "gh"), "w") as f:
            f.write(f"#!/bin/sh\nif [ \"$1 $2\" = \"pr view\" ]; then\ncat <<'EOF'\n{json.dumps(FAKE_PR)}\nEOF\nexit 0\nfi\nexit 1\n")
        os.chmod(os.path.join(fake_bin, "gh"), 0o755)
        self.fake_claude = os.path.join(fake_bin, "claude")
        with open(self.fake_claude, "w") as f:
            f.write(FAKE_CLAUDE)
        os.chmod(self.fake_claude, 0o755)
        self.fake_codex = os.path.join(fake_bin, "codex")
        with open(self.fake_codex, "w") as f:
            f.write(FAKE_CODEX)
        os.chmod(self.fake_codex, 0o755)
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.config = os.path.join(tmp, "yardbell.yml")
        with open(self.config, "w") as f:
            f.write(
                f"""port: {self.port}
poll_seconds: 2
host_terminal: none
mesh: none
forward_services: []
workspaces: ['*']
default_agent: shell
agents:
- {{name: shell, label: Shell, command: {self.shell}, resume: {self.shell}}}
machines:
- name: {MACHINE}
  local: true
  root: {self.root}
passcode_hash: {PASSCODE_HASH}
cookie_key: {base64.b64encode(os.urandom(64)).decode()}
"""
            )
        # A clean HOME and the system PATH keep the user's shell setup, and with it any real
        # `claude` or `codex`, out of reach: Dispatch looks them up through a login shell and must
        # find only the fakes.
        self.env = {
            "HOME": home,
            "PATH": f"{fake_bin}:{SYSTEM_PATH}",
            "SHELL": "/bin/bash",
            "LANG": "C.UTF-8",
            "USER": os.environ.get("USER", "runner"),
            "TMUX_TMPDIR": self.tmux_dir,
            "YARDBELL_STATE": self.state,
            "CLAUDE_CONFIG_DIR": os.path.join(home, ".claude"),
            "YARDBELL_LINEAR_URL": f"http://127.0.0.1:{self.linear.server_address[1]}/graphql",
        }
        for agent, fake in (("claude", self.fake_claude), ("codex", self.fake_codex)):
            out = subprocess.run(["bash", "-lic", f"command -v {agent}"], env=self.env, capture_output=True, text=True)
            found = [line for line in out.stdout.splitlines() if line.startswith("/")]
            if found != [fake]:
                raise SystemExit(f"refusing to start: the test server would find {agent} at {found}, not only the fake one")
        self.log = open(os.path.join(tmp, "server.log"), "w")
        self.proc = subprocess.Popen(
            [binary, "serve", "--no-open", "--config", self.config],
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=self.log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.time() + 30
        while True:
            try:
                urllib.request.urlopen(self.base + "/login", timeout=1)
                return
            except OSError:
                if self.proc.poll() is not None or time.time() > deadline:
                    self.stop()
                    raise SystemExit("the Yardbell server did not start:\n" + tail(self.log.name))
                time.sleep(0.1)

    def seed_dispatch(self):
        folder = os.path.join(self.state, "dispatch", "conversations")
        os.makedirs(folder)
        short = conversation(
            SHORT_CHAT,
            "Fix the login redirect",
            [
                {"role": "user", "text": "Fix the login redirect in demo-app"},
                {"role": "assistant", "text": "Started **hp-demo-app** on hp, it has the most free memory."},
            ],
        )
        events = []
        for i in range(1, 25):
            events.append({"role": "user", "text": f"Question {i}: what is running on hp right now?"})
            events.append({"role": "assistant", "text": f"Answer {i}: " + "Nothing new is running on hp. " * 6})
        events.append({"role": "assistant", "text": "The last answer in this conversation."})
        long = conversation(LONG_CHAT, "A long conversation", events)
        repo = os.path.join(self.root, "demo-app")
        review = conversation(
            REVIEW_CHAT,
            "Review the login fix",
            [{"role": "user", "text": "Review the login fix"}, review_card(repo, review_branch(repo))],
        )
        session_card = {
            "role": "session", "machine": MACHINE, "name": "hp-demo-app", "path": repo, "state": "idle",
            "screen": "\n".join(f"step {n}" for n in range(1, 9)), "options": [], "at": "2026-01-01T10:00:00+00:00",
        }
        scan = conversation(
            SCAN_CHAT,
            "Security scan of demo-app",
            [{"role": "user", "text": "Scan demo-app"}, session_card, scan_card(repo)],
        )
        evidence = os.path.join(self.state, "dispatch", "evidence", REVIEW_CHAT)
        os.makedirs(evidence)
        with open(os.path.join(evidence, SHOT_FILE), "wb") as f:
            f.write(png(640, 400))
        card = {
            "role": "pull", "kind": "ci", "key": "ci:browser",
            "machine": MACHINE, "name": PULL_SESSION, "path": os.path.join(self.root, "demo-app"), "branch": "main",
            "pull": {"forge": "github", "number": 12, "url": FAKE_PR["url"], "title": FAKE_PR["title"], "state": "open",
                     "draft": False, "review": "", "ci": "failing", "failed": ["CI / test"]},
            "checks": [{"name": "CI / test", "url": FAKE_PR["statusCheckRollup"][0]["detailsUrl"],
                        "log": "running 3 tests\ntest login::redirects ... FAILED\nerror: test failed"}],
            "notes": [],
            "instruction": "echo pull''-sent",
            "at": "2026-01-01T10:00:00+00:00",
        }
        pull = conversation(PULL_CHAT, "Pull request #12: Fix the login redirect", [card])
        merge_request = conversation(GITLAB_CHAT, "Merge request !12: Fix the login redirect", [{
            "role": "pull", "kind": "review", "key": "review:gitlab",
            "machine": MACHINE, "name": PULL_SESSION, "path": os.path.join(self.root, "demo-app"), "branch": "main",
            "pull": {"forge": "gitlab", "number": 12, "url": "https://git.example.com/acme/app/-/merge_requests/12",
                     "title": "Fix the login redirect", "state": "open", "draft": False, "review": "", "ci": "passing",
                     "failed": []},
            "checks": [],
            "notes": [{"id": "gitlab:301", "kind": "comment", "author": "rev1", "body": "Please add a test.",
                       "url": "https://git.example.com/acme/app/-/merge_requests/12#note_301"}],
            "more": 2,
            "instruction": "echo merge''-sent",
            "at": "2026-01-01T10:00:00+00:00",
        }])
        with open(os.path.join(self.state, "dispatch", "memory.md"), "w") as f:
            f.write(f"# Dispatch memory\n\n- {MEMORY_OLD}\n- Branches are named after the ticket\n")
        insight = conversation(INSIGHTS_CHAT, "Fix the login", [
            {"role": "user", "text": "Fix the login redirect", "task": {"name": OLD_TASK, "version": 1}},
            {"role": "action", "id": "insstart", "tool": "start_session", "by": "dispatch", "status": "approved",
             "at": "2026-01-01T10:00:00+00:00", "input": {"machine": MACHINE, "folder": "demo-app", "prompt": "Fix the login redirect"},
             "result": {"ok": True, "text": "{}", "at": "2026-01-01T10:00:00+00:00",
                        "session": {"machine": MACHINE, "name": OLD_RUN, "path": repo}}},
            {"role": "session", "machine": MACHINE, "name": OLD_RUN, "path": repo, "state": "ended",
             "screen": "Done.", "options": [], "at": "2026-01-01T10:40:00+00:00"},
        ])
        # A tasks file from before versions were kept, and a timeline of a session that ended.
        with open(os.path.join(self.state, "dispatch", "tasks.json"), "w") as f:
            json.dump([{"name": OLD_TASK, "text": "Fix the login redirect", "builtin": False}], f)
        at = lambda m: f"2026-01-01T10:{m:02d}:00+00:00"
        marks = [{"at": at(0), "kind": "started"}, {"at": at(0), "kind": "active"},
                 {"at": at(5), "kind": "test", "text": "Bash: npm test"},
                 {"at": at(6), "kind": "test", "text": "Tests: 1 failed, 4 passed, 5 total", "ok": False},
                 {"at": at(10), "kind": "pull", "text": "Pull request #12 opened: Fix the login redirect", "url": FAKE_PR["url"]},
                 {"at": at(19), "kind": "blocked"}, {"at": at(24), "kind": "active"},
                 {"at": at(26), "kind": "pull", "text": "carol approved", "url": FAKE_PR["url"] + "#review"},
                 {"at": at(30), "kind": "idle"}, {"at": at(40), "kind": "ended"}]
        with open(os.path.join(self.state, "insights.json"), "w") as f:
            json.dump({f"{MACHINE}:{OLD_RUN}": {"machine": MACHINE, "name": OLD_RUN, "agent": "shell", "folder": "demo-app",
                                                "branch": "main", "marks": marks}}, f)
        for chat in (short, long, review, pull, merge_request, scan, group_chat(self.root), results_chat(self.root), memory_chat(), insight,
                     settings_chat(SETTINGS_CHAT, "setstep1", 7), settings_chat(SETTINGS_EDIT_CHAT, "setstep2", 9), task_chat()):
            with open(os.path.join(folder, chat["id"] + ".json"), "w") as f:
                json.dump(chat, f)

    def tmux(self, *args):
        sock = os.path.join(self.tmux_dir, f"tmux-{os.getuid()}", "default")
        return subprocess.run(["tmux", "-S", sock, *args], env=self.env, capture_output=True, text=True)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        self.tmux("kill-server")
        self.log.close()


class Suite:
    def __init__(self, server, browser, shots):
        self.y = server
        self.b = browser
        self.shots = shots
        self.session = None

    def url(self, path):
        return self.y.base + path

    def api(self, method, path, body=None):
        return self.b.js(
            f"""fetch({json.dumps(path)}, {{
              method: {json.dumps(method)},
              headers: {{"Content-Type": "application/json", Accept: "application/json"}},
              body: {json.dumps(json.dumps(body)) if body is not None else "undefined"},
            }}).then(async (r) => {{
              if (!r.ok) throw new Error(`${{r.status}} ${{await r.text()}}`);
              return r.json();
            }})"""
        )

    def test_login(self):
        b = self.b
        b.goto(self.url("/"))
        b.wait("location.pathname === '/login'", "the redirect to /login")
        b.click("input[name=passcode]")
        b.type("wrong-passcode")
        b.key("Enter")
        b.wait("document.getElementById('err').textContent.trim()", "the wrong passcode to be refused")
        b.js("document.querySelector('input[name=passcode]').value = ''")
        b.click("input[name=passcode]")
        b.type(PASSCODE)
        b.key("Enter")
        b.wait("location.pathname === '/' && document.getElementById('title')", "the dashboard after logging in")

    def test_every_page_loads(self):
        for path in PAGES:
            self.b.goto(self.url(path))
            self.b.wait("document.readyState === 'complete' && !location.pathname.startsWith('/login')", f"{path} to load")
            self.b.pump(0.6)
            self.check_errors(path)

    def test_dashboard_shows_the_machine(self):
        self.b.goto(self.url("/"))
        self.b.wait(
            f"[...document.querySelectorAll('#nav-machines li')].some((li) => li.textContent.includes({json.dumps(MACHINE)}))",
            "the machine in the sidebar",
        )
        self.b.wait(
            f"document.querySelector('section.mgroup:not(.down) h2#mg-{MACHINE}')?.textContent === {json.dumps(MACHINE)}",
            "the machine on the dashboard, connected",
        )

    def test_start_a_shell_session(self):
        b = self.b
        b.goto(self.url("/"))
        b.click("#new-btn")
        b.wait("document.getElementById('new-dialog')?.open", "the New session dialog")
        b.wait("document.getElementById('new-agent').value === 'shell'", "the Shell agent to be preselected")
        b.click("#dir-list [data-path$='/demo-app']")
        b.wait("!document.getElementById('start-btn').disabled", "Start and open to be enabled")
        b.click("#start-btn")
        name = b.wait(
            "(async () => (await (await fetch('/state')).json()).sessions.find((s) => s.tmux && s.folder === 'demo-app')?.tmux)()",
            "the new session in /state",
            timeout=15,
        )
        self.session = name
        b.close_other_tabs()
        b.goto(self.url("/"))
        b.wait(
            f"document.querySelector('.s-row [data-act=stop][data-name={json.dumps(name)}]')?.closest('.s-row').innerText.includes('Shell')",
            f"{name} on the dashboard",
        )

    def test_terminal_typing_and_copy(self):
        b = self.b
        if not self.session:
            path = os.path.join(self.y.root, "demo-app")
            self.session = self.api("POST", "/sessions", {"machine": MACHINE, "path": path, "wait": True})["name"]
        b.goto(self.url(f"/term/{MACHINE}/{self.session}"))
        b.wait("typeof term === 'object' && term.element", "the terminal to open")
        b.wait("screenText().length > 0", "the shell prompt", timeout=15)
        b.click("#term")
        b.type("echo o''k")
        b.key("Enter")
        b.wait("screenText().split('\\n').some((l) => l.trim() === 'ok')", "ok on the screen")

        b.click("#text-btn")
        b.wait("document.getElementById('text-view').classList.contains('show')", "the screen text")
        if "ok" not in b.js("document.getElementById('text-body').textContent").split("\n"):
            raise Failure("the screen text does not show ok")

        b.click("#text-copy")
        b.wait("document.getElementById('notice-text').textContent === 'Copied'", "Copy all to copy")
        b.type("echo again''2")
        b.key("Enter")
        b.wait("screenText().split('\\n').some((l) => l.trim() === 'again2')", "typing to reach the terminal after Copy all")

        b.goto(self.url(f"/term/{MACHINE}/{self.session}"))
        b.wait("typeof term === 'object' && screenText().includes('again2')", "the same shell after opening the terminal again")
        b.click("#term")
        b.type("echo back''3")
        b.key("Enter")
        b.wait("screenText().split('\\n').some((l) => l.trim() === 'back3')", "the shell to still answer")

    def test_workspace_tabs_scroll(self):
        b = self.b
        folder = os.path.join(self.y.root, "demo-api")
        for i in range(1, 9):
            r = self.y.tmux("new", "-d", "-s", f"hp-demo-api-{i}", "-c", folder, self.y.shell)
            if r.returncode:
                raise Failure(f"tmux new failed: {r.stderr}")
        b.viewport(1000, 700)
        try:
            b.goto(self.url("/workspace"))
            self.api("POST", "/refresh")
            b.click("#tree [data-space$='demo-api']")
            count = b.wait("document.querySelectorAll('#tabs .ws-tab').length >= 8 && document.querySelectorAll('#tabs .ws-tab').length", "eight tabs", timeout=15)
            b.wait("(() => { const s = document.getElementById('tabs'); return s.scrollWidth > s.clientWidth; })()", "the tab row to overflow")
            b.wait("!document.getElementById('tab-list').hidden", "the All tabs button")
            # Picking from All tabs leaves scrolling the row to the page, unlike clicking a tab.
            for item, tab in (("last-child", count - 1), ("first-child", 0)):
                b.click("#tab-list")
                b.click(f"#ws-menu [role=menuitem]:{item}")
                b.wait(
                    f"""(() => {{
                      const s = document.getElementById('tabs').getBoundingClientRect();
                      const t = document.querySelector('#tabs [data-tab="{tab}"]');
                      const r = t.getBoundingClientRect();
                      return t.classList.contains('current') && r.left >= s.left - 1 && r.right <= s.right + 1;
                    }})()""",
                    f"tab {tab + 1} to be current and fully in view",
                )
        finally:
            b.viewport(1280, 800)

    def menu(self, path):
        self.b.goto(self.url(path))
        self.b.wait("document.querySelector('[data-theme-toggle] .theme-word')", f"the menu on {path}")
        return self.b.js(
            """[...document.querySelectorAll('.side-foot .side-link, .ws-nav .side-link')]
                 .map((el) => el.matches('[data-theme-toggle]') ? 'theme' : el.textContent.trim())"""
        )

    def test_workspace_sidebar_matches_the_other_pages(self):
        b = self.b
        dashboard = self.menu("/")
        workspace = self.menu("/workspace")
        if [w for w in workspace if w != "Keyboard shortcuts"] != dashboard:
            raise Failure(f"the Workspace menu {workspace} is not the dashboard's {dashboard}")
        rows = b.js(
            """(() => {
              const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
              const home = document.querySelector('.ws-home');
              return {
                wordmark: mid(document.querySelector('#ws-side .wordmark')),
                toggle: mid(document.querySelector('#ws-side .side-toggle')),
                home: home && home.getClientRects().length > 0,
              };
            })()"""
        )
        if abs(rows["wordmark"] - rows["toggle"]) > 4:
            raise Failure(f"the collapse button is not on the wordmark's row: {rows}")
        if rows["home"]:
            raise Failure("the Workspace sidebar shows a second Dashboard button next to its menu")

    def test_collapsed_sidebar_draws_icons_only(self):
        b = self.b
        b.goto(self.url("/"))
        b.js("localStorage.setItem('yardbell.side', 'rail')")
        try:
            for path in PAGES[:4]:
                b.goto(self.url(path))
                b.wait("document.documentElement.classList.contains('side-rail') && document.querySelector('.side-toggle')", f"the rail on {path}")
                b.pump(0.3)
                drawn = b.js(
                    """(() => {
                      const side = document.querySelector('.side, .ws-side');
                      const walk = document.createTreeWalker(side, NodeFilter.SHOW_TEXT);
                      const out = [];
                      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                        if (!n.textContent.trim() || n.parentElement.closest('.rail-initial')) continue;
                        const range = document.createRange();
                        range.selectNodeContents(n);
                        if ([...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) out.push(n.textContent.trim().slice(0, 30));
                      }
                      return out;
                    })()"""
                )
                if drawn:
                    raise Failure(f"the collapsed sidebar on {path} still draws words: {drawn}")
        finally:
            b.js("localStorage.removeItem('yardbell.side')")

    def test_narrow_dispatch_has_chat_chats_and_tasks_tabs(self):
        b = self.b
        shown = """(() => {
          const seen = (id) => document.getElementById(id).getClientRects().length > 0;
          return {
            tabs: seen('dispatch-tabs'),
            tab: document.querySelector('#dispatch-tabs [aria-selected=true]')?.dataset.tab,
            chat: seen('dispatch-form'),
            convos: seen('convo-list'),
            tasks: seen('task-list'),
          };
        })()"""
        b.viewport(380, 800)
        try:
            b.goto(self.url(f"/dispatch?c={SHORT_CHAT}"))
            b.wait("document.querySelector('#dispatch-log .msg.user')", "the saved conversation")
            now = b.js(shown)
            if now != {"tabs": True, "tab": "chat", "chat": True, "convos": False, "tasks": False}:
                raise Failure(f"a narrow Dispatch should open on Chat with only the chat showing: {now}")
            b.click("#dispatch-tabs [data-tab=convos]")
            now = b.js(shown)
            if now != {"tabs": True, "tab": "convos", "chat": False, "convos": True, "tasks": False}:
                raise Failure(f"Chats should show only the conversations: {now}")
            if b.js("getComputedStyle(document.getElementById('convo-list')).overflowY") not in ("visible", "clip"):
                raise Failure("the conversation list scrolls on its own inside the page")
            count = b.js("document.querySelector('#dispatch-tabs [data-tab=convos] .seg-count').textContent")
            items = b.js("document.querySelectorAll('#convo-list .convo').length")
            if count != str(items):
                raise Failure(f"the Chats tab counts {count}, the list has {items}")
            b.click("#convo-list .convo:not(.selected) a")
            b.wait("document.querySelector('#dispatch-tabs [aria-selected=true]')?.dataset.tab === 'chat'", "Chat after picking a conversation")
            b.click("#dispatch-tabs [data-tab=tasks]")
            now = b.js(shown)
            if now != {"tabs": True, "tab": "tasks", "chat": False, "convos": False, "tasks": True}:
                raise Failure(f"Tasks should show only the tasks: {now}")
            b.click("#dispatch-tabs [data-tab=chat]")
            b.viewport(1280, 800)
            b.pump(0.3)
            now = b.js(shown)
            if not (now["tabs"] and now["chat"]) or now["convos"] == now["tasks"]:
                raise Failure(f"a wide Dispatch keeps one list beside the chat, picked by its tabs: {now}")
        finally:
            b.viewport(1280, 800)

    def test_wide_dispatch_is_an_app_layout(self):
        b = self.b
        b.viewport(1280, 800)
        try:
            b.goto(self.url(f"/dispatch?c={LONG_CHAT}"))
            b.wait("document.querySelectorAll('#dispatch-log .msg').length >= 49", "the long conversation")
            b.pump(0.3)
            if b.js("document.scrollingElement.scrollHeight > innerHeight + 1"):
                raise Failure("the wide Dispatch page scrolls as a whole")
            b.js("const c = document.getElementById('dispatch-chat'); c.scrollTop = c.scrollHeight")
            b.pump(0.3)
            seen = b.js(
                """(() => {
                  const box = (id) => document.getElementById(id).getBoundingClientRect();
                  const title = box('chat-title');
                  const form = box('dispatch-form');
                  const last = [...document.querySelectorAll('#dispatch-log .msg')].pop().getBoundingClientRect();
                  return {
                    title: document.getElementById('chat-title').textContent.trim(),
                    titleShown: title.top >= 0 && title.bottom <= innerHeight && title.height > 0,
                    formBottom: form.bottom, lastBottom: last.bottom, formTop: form.top, height: innerHeight,
                    back: document.querySelector('.back-link').getClientRects().length > 0,
                    sideScrolls: getComputedStyle(document.getElementById('dispatch-side')).overflowY,
                  };
                })()"""
            )
            if seen["title"] != "A long conversation" or not seen["titleShown"]:
                raise Failure(f"the open conversation's title is not shown above it: {seen}")
            if seen["formBottom"] > seen["height"] + 1 or seen["lastBottom"] > seen["formTop"] + 1:
                raise Failure(f"the message box is not pinned below the last message: {seen}")
            if seen["back"]:
                raise Failure("the wide page still shows a Dashboard back-link")
            if seen["sideScrolls"] != "auto":
                raise Failure(f"the list column does not scroll on its own: {seen}")
            shown = """(() => {
              const seen = (id) => document.getElementById(id).getClientRects().length > 0;
              return [seen('convo-list'), seen('task-list'), seen('dispatch-form'),
                      document.querySelector('#dispatch-tabs [data-tab=chat]').getClientRects().length > 0,
                      document.querySelector('#dispatch-tabs [aria-selected=true]')?.dataset.tab];
            })()"""
            if b.js(shown) != [True, False, True, False, "convos"]:
                raise Failure(f"a wide page shows its conversations beside the chat: {b.js(shown)}")
            b.click("#dispatch-tabs [data-tab=tasks]")
            if b.js(shown) != [False, True, True, False, "tasks"]:
                raise Failure(f"Tasks takes the list column and the chat stays: {b.js(shown)}")
            b.click("#dispatch-tabs [data-tab=convos]")
            b.click("#convo-list .convo:not(.selected) a")
            b.wait("document.getElementById('chat-title').textContent.trim() !== 'A long conversation'", "the title to follow the open conversation")
            if b.js(shown)[4] != "convos":
                raise Failure("opening a conversation moved the list off Chats")
        finally:
            b.viewport(1280, 800)

    def test_dispatch_shows_a_saved_conversation(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={SHORT_CHAT}"))
        b.wait("document.querySelector('#dispatch-log .msg.user')?.textContent.includes('Fix the login redirect')", "the saved user message")
        b.wait("document.querySelector('#dispatch-log .msg.md strong')?.textContent === 'hp-demo-app'", "the saved answer with its markdown")
        b.wait("document.getElementById('convo-list').textContent.includes('A long conversation')", "the conversation list")

    def test_dispatch_on_codex_proposes_a_step_and_resumes(self):
        b = self.b
        before = self.api("GET", "/api/settings")["dispatch"]
        self.api("POST", "/api/settings/dispatch", {**before, "rules": [], "approval": "prompt"})
        write(os.path.join(self.y.env["HOME"], ".codex", "models_cache.json"), json.dumps(
            {"models": [{"slug": "gpt-6.1-sol", "visibility": "list"}, {"slug": "gpt-6.1-mini", "visibility": "list"}]}))
        try:
            b.goto(self.url("/settings#dispatch"))
            b.wait("document.querySelector('#dispatch-form [name=runs_on]').value === 'claude'", "Claude Code, the default")
            b.wait("[...document.querySelectorAll('#dispatch-form [name=runs_on] option')].map((o) => o.textContent).join() === 'Claude Code,Codex'",
                   "only the agents Dispatch can run on, named as sessions name them")
            b.wait("!document.querySelector('[data-runs-on=claude]').hidden && document.querySelector('[data-runs-on=codex]').hidden", "the Claude model")
            b.js("(() => { const s = document.querySelector('#dispatch-form [name=runs_on]'); s.value = 'codex'; s.dispatchEvent(new Event('change')); })()")
            b.wait("document.querySelector('[data-runs-on=claude]').hidden && !document.querySelector('[data-runs-on=codex]').hidden", "the Codex model in its place")
            b.wait("document.getElementById('dispatch-foot').textContent.startsWith('Dispatch runs Codex')", "the footer naming Codex")
            b.wait("[...document.querySelectorAll('#codex-models option')].map((o) => o.value).join() === 'gpt-6.1-sol,gpt-6.1-mini'", "the models Codex lists")
            b.click("#dispatch-form [name=codex_model]")
            b.type("gpt-9-unlisted")
            b.wait("!document.getElementById('codex-model-note').hidden && document.getElementById('codex-model-note').textContent.includes('Codex does not list gpt-9-unlisted')",
                   "the note on a model Codex does not list")
            b.js("(() => { const i = document.querySelector('#dispatch-form [name=codex_model]'); i.value = ''; i.dispatchEvent(new Event('input')); })()")
            b.type("gpt-6.1-sol")
            b.wait("document.getElementById('codex-model-note').hidden", "no note on a listed model")
            b.click("#dispatch-form button[type=submit]")
            b.wait("!document.getElementById('undo-bar').hidden", "the settings to save")
            saved = self.api("GET", "/api/settings")["dispatch"]
            if (saved.get("runs_on"), saved.get("codex_model")) != ("codex", "gpt-6.1-sol"):
                raise Failure(f"saved {saved}")

            b.goto(self.url("/dispatch"))
            b.wait("document.querySelector('.dispatch-intro')?.textContent.includes('Dispatch runs Codex (gpt-6.1-sol) on this machine')", "the intro naming Codex and its model")
            b.wait("document.getElementById('runs-on').textContent === 'Codex · gpt-6.1-sol'", "the label naming Codex and its model")
            b.click("#dispatch-form textarea")
            b.type("Fix the login redirect in demo-app")
            b.click("#dispatch-form button[type=submit]")
            card = "#dispatch-log .step-card.pending"
            b.wait(f"document.querySelector('{card}')?.textContent.includes('Fix the login redirect.')", "the proposed session, waiting for approval", timeout=20)
            b.wait("[...document.querySelectorAll('#dispatch-log .msg')].some((m) => m.textContent.includes('I proposed a session on hp in demo-app.'))", "Codex's reply")
            b.wait("[...document.querySelectorAll('#dispatch-log *')].some((x) => x.textContent === 'Checked machines')", "the tool Codex called")
            b.wait("document.querySelector('#nav-usage')?.textContent.includes('Codex usage') && document.querySelector('#nav-usage')?.textContent.includes('42%')", "Codex's limits in the sidebar")
            id = b.js("new URLSearchParams(location.search).get('c')")
            convo = self.api("GET", f"/dispatch/conversations/{id}")
            if convo["backend"] != "codex" or any(e["role"] == "error" for e in convo["events"]):
                raise Failure(f"the conversation is {convo}")

            b.click(f"{card} .step-card-actions .btn.danger")
            b.wait("document.querySelector('#dispatch-log .step-card.rejected, #dispatch-log .step-card.done')", "the step rejected")
            b.click("#dispatch-form textarea")
            b.type("ok")
            b.click("#dispatch-form button[type=submit]")
            b.wait("[...document.querySelectorAll('#dispatch-log .msg')].some((m) => m.textContent.includes('Understood, nothing started.'))",
                   "a reply from the resumed thread that heard about the rejection", timeout=20)

            self.api("POST", "/api/settings/dispatch", {**before, "rules": [], "approval": "prompt", "model": "haiku", "codex_model": "gpt-6.1-mini"})
            b.goto(self.url(f"/dispatch?c={id}"))
            b.wait("document.querySelector('#dispatch-log .backend-note')?.textContent.includes('This conversation runs on Codex (gpt-6.1-mini), so it carries on there. New conversations start on Claude Code (Haiku).')",
                   "the note that this conversation stays on Codex, with Codex's new model")
            b.wait("document.getElementById('runs-on').textContent === 'Codex · gpt-6.1-mini'", "the label for this conversation")
            b.click("#tab-new")
            b.wait("document.getElementById('runs-on').textContent === 'Claude Code · Haiku'", "the label for a new conversation")
        finally:
            self.api("POST", "/api/settings/dispatch", before)
            os.remove(os.path.join(self.y.env["HOME"], ".codex", "models_cache.json"))

    def test_dispatch_review_card_diff_and_evidence(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={REVIEW_CHAT}"))
        card = "#dispatch-log .step-card.review"
        b.wait(f"document.querySelector('{card}')?.textContent.includes('Review of')", "the seeded review card")
        b.wait(f"(() => {{ const i = document.querySelector('{card} .finding-shots img'); return i && i.complete && i.naturalWidth === 640; }})()", "the screenshot thumbnail")
        b.wait(f"document.querySelector('{card} .finding-shot-error')?.textContent.includes('gone.png was not attached')", "the screenshot that was not kept")
        groups = b.js(f"[...document.querySelectorAll('{card} .finding-group-head')].map((h) => h.textContent.trim().replace(/\\s+/g, ' '))")
        if groups != ["High · 1", "Medium · 1", "Low · 1"]:
            raise Failure(f"the findings are not grouped by severity: {groups}")
        if b.js(f"document.querySelector('{card}').textContent.includes('Mention passkeys')"):
            raise Failure("the low finding is not folded")
        if b.js(f"document.querySelector('{card} .step-card-foot .btn.primary').textContent.trim()") != "Send 2 findings":
            raise Failure("the high and medium findings are not the ones ticked")
        if "/" in b.js(f"document.querySelector('{card} .step-card-where').textContent"):
            raise Failure("the card names the whole path instead of the folder")
        b.click(f"{card} .finding-group.low .finding-group-head")
        b.wait(f"document.querySelector('{card}').textContent.includes('Mention passkeys')", "the low finding once opened")
        if b.js(f"document.querySelector('{card} .finding-group.low input').checked"):
            raise Failure("the low finding starts ticked")
        b.click(f"{card} .finding-group.low .finding")
        b.wait(f"document.querySelector('{card} .step-card-foot .btn.primary').textContent.trim() === 'Send 3 findings'", "the low finding to count once ticked")
        b.click(f"{card} .review-diff-toggle")
        b.wait(
            f"""(() => {{
              const files = [...document.querySelectorAll('{card} .diff-file .diff-path')].map((p) => p.textContent.trim());
              return ['README.md', 'docs/old-name.md → docs/new-name.md', 'logo.png', 'notes.txt', 'src/big.txt', 'src/login.js'].every((f) => files.includes(f));
            }})()""",
            "the changed files: committed, renamed, binary, not committed and new",
        )
        if b.js(f"document.querySelector('{card} .finding-place.link')?.textContent") != "src/login.js:42":
            raise Failure("the finding's place in the diff is not a link")
        if b.js(f"[...document.querySelectorAll('{card} code.finding-place')].map((c) => c.textContent).join()") != "docs/missing.md:3":
            raise Failure("a place outside the diff is still a link")
        b.click(f"{card} .finding-place.link")
        b.wait(
            f"""(() => {{
              const hit = document.querySelector('{card} .diff-table tr.hit');
              return hit && hit.id.endsWith('-L42') && hit.textContent.includes('const step42 = 42;');
            }})()""",
            "the diff opened at src/login.js:42",
        )
        b.click(f"{card} .diff-file-head[id$='logo.png']")
        b.wait(f"document.querySelector('{card} .diff-file.open .diff-file-head[id$=\"logo.png\"]')?.closest('li').textContent.includes('A binary file')", "the binary file's note")
        b.click(f"{card} .diff-file-head[id$='big.txt']")
        rows = "document.querySelectorAll('" + card + " .diff-file-head[id$=\"big.txt\"] + .diff-file-body tr').length"
        b.wait(f"{rows} === 400", "the first page of the long file")
        b.click(f"{card} .diff-file-head[id$='big.txt'] + .diff-file-body .diff-more")
        b.wait(f"{rows} === 800", "Show more to add the next page")
        b.click(f"{card} .shot")
        b.wait("(() => { const i = document.querySelector('dialog.shot-view[open] img'); return i && i.complete && i.naturalWidth === 640; })()", "the screenshot full size")
        b.click("dialog.shot-view .btn")
        b.wait("!document.querySelector('dialog.shot-view[open]')", "the screenshot to close")

    def test_dispatch_scan_card_findings_and_files(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={SCAN_CHAT}"))
        card = "#dispatch-log .step-card.review.scan"
        b.wait(f"document.querySelector('{card}')?.textContent.includes('Security scan of')", "the seeded scan card")
        if b.js(f"document.querySelector('{card} .badge').textContent") != "3 issues found":
            raise Failure("the scan's verdict does not count its issues")
        if b.js(f"document.querySelector('{card}').textContent.includes('Changes')"):
            raise Failure("a scan card has a branch diff")
        links = b.js(f"[...document.querySelectorAll('{card} .finding-place.link')].map((l) => l.textContent).join()")
        if links != "src/login.js:42,config/missing.yml:3":
            raise Failure(f"the finding links are {links!r}")
        b.click(f"{card} .finding-group.low .finding-group-head")
        if b.js(f"[...document.querySelectorAll('{card} code.finding-place')].map((c) => c.textContent).join()") != "/etc/passwd:1":
            raise Failure("a place outside the folder is a link")
        b.click(f"{card} .finding-place.link")
        b.wait(
            f"""(() => {{
              const hit = document.querySelector('{card} .file-table tr.hit');
              return hit && hit.id.endsWith('-L42') && hit.textContent.includes('const step42 = 42;');
            }})()""",
            "the file opened at src/login.js:42",
        )
        if b.js(f"document.querySelector('{card} .review-diff-toggle').textContent.trim()") != "Files2 files":
            raise Failure("the Files panel does not count the files")
        b.click(f"{card} .diff-file-head[id$='missing.yml']")
        b.wait(f"document.querySelector('{card} .diff-msg.error')?.textContent.includes('config/missing.yml is not in the scanned folder')", "the missing file's error")
        b.wait(f"document.querySelector('{card} .step-card-foot .btn.primary')?.textContent.trim() === (document.querySelector('{card} .scan-target') ? 'Send 2 findings' : 'Fix 2 in a new session')", "the send button once the sessions are read")
        if self.session and b.js(f"[...document.querySelectorAll('{card} .scan-target option')].map((o) => o.value).join()") != f"{self.session},":
            raise Failure("the shell session in demo-app is not offered")
        b.js(f"(() => {{ const s = document.querySelector('{card} .scan-target select'); if (s) {{ s.value = ''; s.dispatchEvent(new Event('change')); }} }})()")
        b.wait(f"document.querySelector('{card} .step-card-foot .btn.primary')?.textContent.trim() === 'Fix 2 in a new session'", "the new session choice")
        b.click(f"{card} .step-card-foot .btn.primary")
        b.wait(f"document.querySelector('{card} .step-card-trail')?.textContent.startsWith('Asked for a new session to fix 2 findings')", "the card's outcome")
        b.wait(
            """(() => {
              const step = [...document.querySelectorAll('#dispatch-log .step-card.pending')].at(-1);
              return step && step.textContent.includes('Start a session') && step.textContent.includes('A security scan of') && step.querySelector('.btn.primary')?.textContent.includes('Start session');
            })()""",
            "the session that fixes them, waiting to be started",
        )

    def test_dispatch_scan_starts_from_a_card_or_a_folder(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={SCAN_CHAT}"))
        b.wait("document.querySelector('#dispatch-log .session-card .scan-btn')", "Scan on the session card")
        screen = "document.querySelector('#dispatch-log .session-card .session-screen').textContent.trim()"
        if b.js(screen) != "step 5\nstep 6\nstep 7\nstep 8":
            raise Failure(f"the session card shows more than the end of the screen: {b.js(screen)!r}")
        b.click("#dispatch-log .session-card .session-screen-more")
        b.wait(f"{screen}.startsWith('step 1\\n')", "the whole screen once opened")
        b.click("#dispatch-log .session-card .scan-btn")
        b.wait("!document.getElementById('scan-menu').hidden && document.activeElement?.closest('#scan-menu')", "the Scan menu with focus")
        if b.js("[...document.querySelectorAll('#scan-menu [role=menuitem] .scan-menu-item > span:first-child')].map((s) => s.textContent).join()") != "Dead code,Test gaps,Security":
            raise Failure("the Scan menu does not offer the three kinds")
        b.click("#scan-menu [role=menuitem]:nth-child(3)")
        b.wait(
            """(() => {
              const step = [...document.querySelectorAll('#dispatch-log .step-card.pending')].at(-1);
              return step && step.querySelector('.step-card-title strong').textContent === 'Start a security scan' && step.querySelector('.btn.primary').textContent.includes('Start scan');
            })()""",
            "the scan waiting to be started",
        )
        note = b.js("[...document.querySelectorAll('#dispatch-log .step-card.pending')].at(-1).querySelector('.read-only-note')?.textContent || ''")
        if not note.startswith("Read-only by instruction: Shell cannot be started with file editing turned off"):
            raise Failure(f"the Shell agent's scan does not say it is read-only by instruction: {note!r}")
        b.click("#tab-new")
        b.wait("!new URLSearchParams(location.search).get('c')", "a new conversation")
        b.click("#insert-scan")
        b.wait("document.getElementById('scan-dialog')?.open && document.querySelector('#scan-dialog select option')", "the Scan a folder dialog")
        b.js("(() => { const s = document.querySelector('#scan-dialog select'); s.value = [...s.options].find((o) => o.textContent.startsWith('demo-api')).value; s.dispatchEvent(new Event('change')); })()")
        b.click("#scan-dialog input[value=dead_code]")
        b.click("#scan-dialog button[type=submit]")
        b.wait(
            """!document.getElementById('scan-dialog').open && new URLSearchParams(location.search).get('c')
              && document.querySelector('#dispatch-log .step-card.pending .step-card-title strong')?.textContent === 'Start a dead code scan'
              && document.getElementById('convo-list').textContent.includes('Dead code scan of demo-api')""",
            "a new conversation with the folder's scan",
        )
        # A project's worktree is picked as its branch, not listed as a folder of its own.
        repo = os.path.join(self.y.root, "demo-app")
        tree = os.path.join(self.y.root, "demo-app-worktrees", "scan-wt")
        git("worktree", "add", "-q", "-b", "scan-wt", tree, cwd=repo)
        try:
            b.click("#tab-new")
            b.wait("!new URLSearchParams(location.search).get('c')", "a new conversation")
            b.click("#insert-scan")
            b.wait("document.getElementById('scan-dialog')?.open", "the Scan a folder dialog")
            b.js("(() => { const s = document.querySelector('#scan-dialog select[name=folder]'); s.value = [...s.options].find((o) => o.textContent === 'demo-app').value; s.dispatchEvent(new Event('change')); })()")
            branch = "#scan-dialog select[name=checkout]"
            b.wait(f"[...document.querySelectorAll('{branch} option')].some((o) => o.textContent === 'scan-wt (worktree)')", "the worktree's branch")
            b.js(f"(() => {{ const s = document.querySelector('{branch}'); s.value = {json.dumps(tree)}; s.dispatchEvent(new Event('change')); }})()")
            b.click("#scan-dialog button[type=submit]")
            b.wait("!document.getElementById('scan-dialog').open && new URLSearchParams(location.search).get('c')", "the scan of the worktree")
            convo = self.api("GET", f"/dispatch/conversations/{b.js('new URLSearchParams(location.search).get(\'c\')')}")
            step = [e for e in convo["events"] if e["role"] == "action"][-1]
            if step["input"]["path"] != tree or step["review"]["branch"] != "scan-wt":
                raise Failure(f"the scan reads {step['input']['path']} on {step['review'].get('branch')!r}")
        finally:
            git("worktree", "remove", "--force", tree, cwd=repo)
            git("branch", "-D", "scan-wt", cwd=repo)

    def test_dispatch_composer_on_a_phone(self):
        b = self.b
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url(f"/dispatch?c={LONG_CHAT}"))
            b.wait("document.querySelectorAll('#dispatch-log .msg').length >= 49", "the long conversation")
            b.js("for (const el of [document.scrollingElement, ...document.querySelectorAll('main')]) el.scrollTop = el.scrollHeight")
            b.pump(0.3)
            box = b.js(
                """(() => {
                  const last = [...document.querySelectorAll('#dispatch-log .msg')].pop().getBoundingClientRect();
                  const form = document.getElementById('dispatch-form').getBoundingClientRect();
                  return {last: last.bottom, top: form.top, bottom: form.bottom, height: innerHeight};
                })()"""
            )
            if box["last"] > box["top"] + 1:
                raise Failure(f"the composer (top {box['top']}px) covers the last message (bottom {box['last']}px)")
            if abs(box["bottom"] - box["height"]) > 1:
                raise Failure(f"the composer ends at {box['bottom']}px, not at the bottom of the {box['height']}px screen")
        finally:
            b.viewport(1280, 800)

    def pull_session(self):
        r = self.y.tmux("has-session", "-t", f"={PULL_SESSION}")
        if r.returncode:
            r = self.y.tmux("new", "-d", "-s", PULL_SESSION, "-c", os.path.join(self.y.root, "demo-app"), self.y.shell)
            if r.returncode:
                raise Failure(f"tmux new failed: {r.stderr}")
        self.api("POST", "/refresh")

    def test_pull_request_badges_on_session_rows(self):
        b = self.b
        self.pull_session()
        b.goto(self.url("/"))
        b.wait(
            f"(async () => (await (await fetch('/state')).json()).sessions.find((s) => s.tmux === {json.dumps(PULL_SESSION)})?.pull?.ci === 'failing')()",
            "the failing pull request in /state",
            # The first check follows a snapshot (every 2 s) and a pull round (every 5 s); a busy
            # CI runner can stretch both, so leave room well past the usual 7 s.
            timeout=45,
        )
        badge = b.wait(
            f"document.querySelector('.s-row [data-name={json.dumps(PULL_SESSION)}]')?.closest('.s-row').querySelector('.pr-badge.bad')?.textContent",
            "the CI failing badge on the dashboard row",
        )
        if "#12" not in badge or "CI failing" not in badge:
            raise Failure(f"the dashboard badge says {badge!r}")
        title = b.js(f"document.querySelector('.s-row [data-name={json.dumps(PULL_SESSION)}]').closest('.s-row').querySelector('.pr-badge').title")
        if title != "Pull request #12: Fix the login redirect. CI failing on CI / test. Review required.":
            raise Failure(f"the badge title says {title!r}")
        b.goto(self.url("/workspace"))
        b.wait("document.querySelector('#tree .ws-pr.bad')?.textContent === '#12'", "the pull request mark in the Workspace sidebar")

    def test_pull_request_card_sends_to_the_session(self):
        b = self.b
        self.pull_session()
        b.goto(self.url(f"/dispatch?c={PULL_CHAT}"))
        b.wait("document.querySelector('#dispatch-log .pull-card .badge.failed')?.textContent === 'CI failed'", "the CI failed card")
        text = b.js("document.querySelector('#dispatch-log .pull-card').innerText")
        for expected in ("#12", "Fix the login redirect", "CI / test", "test login::redirects ... FAILED"):
            if expected not in text:
                raise Failure(f"the card does not show {expected!r}:\n{text}")
        for folded in ("error: test failed", "echo pull''-sent"):
            if folded in text:
                raise Failure(f"the card shows {folded!r} before it is opened:\n{text}")
        b.click("#dispatch-log .pull-card .pull-check-head")
        b.click("#dispatch-log .pull-card .pull-sends summary")
        text = b.js("document.querySelector('#dispatch-log .pull-card').innerText")
        for expected in ("error: test failed", "echo pull''-sent"):
            if expected not in text:
                raise Failure(f"the opened card does not show {expected!r}:\n{text}")
        b.click("#dispatch-log .pull-card .btn.primary")
        b.wait("document.querySelector('#dispatch-log article.step-card.pending')", "the send step waiting for approval")
        if b.js("document.querySelector('#dispatch-log article.step-card.pending .btn.primary').textContent.trim()") != "Send":
            raise Failure("the step does not offer Send")
        b.wait("document.querySelector('#dispatch-log .pull-card').innerText.includes('Waiting for your approval below')", "the card to point at the step")
        b.click("#dispatch-log article.step-card.pending .btn.primary")
        deadline = time.time() + 10
        while True:
            screen = self.y.tmux("capture-pane", "-p", "-t", f"={PULL_SESSION}:").stdout
            if any(line.strip() == "pull-sent" for line in screen.splitlines()):
                break
            if time.time() > deadline:
                raise Failure(f"the instruction did not reach the session:\n{screen}")
            b.pump(0.3)
        b.wait("/Sent( at|\\.)/.test(document.querySelector('#dispatch-log .pull-card').innerText)", "the card to say it was sent")

    def test_merge_request_badge_and_card_wording(self):
        b = self.b
        b.goto(self.url("/"))
        b.wait("window.YardbellPull", "the pull request helpers")
        words = b.js(
            """(() => {
              const P = window.YardbellPull;
              const gl = {forge: 'gitlab', number: 12, title: 'Fix', state: 'open', ci: 'failing', failed: ['test / rspec']};
              const gh = {...gl, forge: 'github', failed: ['CI / test']};
              return [P.ref(gl), P.noun(gl), P.describe(gl), P.ref(gh), P.noun(gh), P.describe(gh)];
            })()"""
        )
        want = ["!12", "Merge request", "Merge request !12: Fix. Pipeline failing on test / rspec.",
                "#12", "Pull request", "Pull request #12: Fix. CI failing on CI / test."]
        if words != want:
            raise Failure(f"the badge words are {words}, not {want}")
        b.goto(self.url(f"/dispatch?c={GITLAB_CHAT}"))
        b.wait("document.querySelector('#dispatch-log .pull-card')", "the merge request card")
        text = b.js("document.querySelector('#dispatch-log .pull-card').innerText")
        for expected in ("!12", "Fix the login redirect", "Please add a test.", "2 more on the merge request."):
            if expected not in text:
                raise Failure(f"the card does not show {expected!r}:\n{text}")
        if "#12" in text or "pull request" in text.lower():
            raise Failure(f"the merge request card still says pull request:\n{text}")

    def test_settings_saves_dispatch_rules(self):
        b = self.b
        b.goto(self.url("/settings#dispatch"))
        b.wait("document.querySelector('#rule-rows .rule-empty')", "the empty rule list")
        b.click("#rule-add")
        b.click("#rule-add")
        b.wait("document.querySelectorAll('#rule-rows .rule-row').length === 2", "two new rules")
        b.click("#rule-rows .rule-row:last-child [data-key=folder]")
        b.type("demo-*")
        b.js(
            f"""(() => {{
              const row = document.querySelector('#rule-rows .rule-row:last-child');
              for (const [key, value] of [['action', 'start_session'], ['machine', {json.dumps(MACHINE)}], ['approval', 'allow']]) {{
                const el = row.querySelector(`[data-key=${{key}}]`);
                el.value = value;
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
              }}
            }})()"""
        )
        b.click("#dispatch-form button[type=submit]")
        b.wait("!document.getElementById('undo-bar').hidden", "the rules to save")
        rules = self.api("GET", "/api/settings")["dispatch"]["rules"]
        expected = [
            {"action": "stop_session", "machine": "any", "approval": "deny"},
            {"action": "start_session", "machine": MACHINE, "folder": "demo-*", "approval": "allow"},
        ]
        if rules != expected:
            raise Failure(f"saved {rules}, expected {expected}")
        b.goto(self.url("/settings#dispatch"))
        b.wait("document.querySelector('#rule-rows .rule-row:last-child [data-key=folder]')?.value === 'demo-*'", "the saved rules after a reload")
        b.click("#rule-rows .rule-row:first-child [data-remove-rule]")
        b.click("#dispatch-form button[type=submit]")
        b.wait("(async () => (await (await fetch('/api/settings')).json()).dispatch.rules?.length === 1)()", "one rule saved after removing the other")

    def test_settings_secrets(self):
        b = self.b
        values = ["lin_api_BROWSER1", "ghp_BROWSER2", "ghp_BROWSER3"]
        self.api("POST", "/api/settings/mcp/servers", {"servers": [
            {"name": "linear", "url": "https://mcp.linear.app/mcp", "headers": {"Authorization": f"Bearer {values[0]}"}},
            {"name": "github", "command": "npx gh-mcp", "env": {"GITHUB_TOKEN": "${secret:github}"}},
        ]})
        b.goto(self.url("/settings?secrets#servers"))
        b.wait("!document.getElementById('secrets-missing').hidden", "the warning that github's secret is not set")
        b.wait("!document.getElementById('secrets-inline').hidden", "the offer to move the inline header")
        b.click("#secrets-move")
        b.wait("document.querySelector('#secret-rows [data-replace=linear]')", "linear in the secrets list")

        b.click("#secret-add")
        b.click("#secret-form input[name=name]")
        b.type("github")
        b.click("#secret-form input[name=value]")
        b.type(values[1])
        b.click("#secret-form button[type=submit]")
        b.wait("document.querySelector('#secret-rows [data-replace=github]') && document.getElementById('secrets-missing').hidden", "github set and the warning gone")

        b.click("#secret-rows [data-replace=github]")
        b.wait("document.querySelector('#secret-form input[name=name]').readOnly && !document.querySelector('#secret-form input[name=value]').value", "the replace form, with the name fixed and no value")
        b.click("#secret-form input[name=value]")
        b.type(values[2])
        b.click("#secret-form button[type=submit]")
        b.wait("document.getElementById('secret-form').hidden", "the replaced value to save")

        page = b.js("document.documentElement.outerHTML")
        settings = json.dumps(self.api("GET", "/api/settings"))
        for value in values:
            if value in page or value in settings:
                raise Failure(f"{value} is shown after it was saved")
        with open(self.y.config) as f:
            config = f.read()
        if values[0] in config or "Bearer ${secret:linear}" not in config:
            raise Failure("yardbell.yml still holds the header value, or lost its reference")
        secrets_file = os.path.join(os.path.dirname(self.y.config), "secrets.yml")
        if os.stat(secrets_file).st_mode & 0o777 != 0o600:
            raise Failure("secrets.yml is readable by other accounts")
        with open(secrets_file) as f:
            stored = f.read()
        if values[0] not in stored or values[2] not in stored or values[1] in stored:
            raise Failure("secrets.yml does not hold the moved and the replaced values")

        b.click("#secret-rows [data-delete=github]")
        b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('github uses it')", "the delete confirmation naming its server")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("!document.querySelector('#secret-rows [data-replace=github]') && !document.getElementById('secrets-missing').hidden", "github deleted and missing again")

    def test_settings_trigger_runs_now_and_marks_its_conversation(self):
        b = self.b
        b.goto(self.url("/settings#triggers"))
        # An MCP server whose secret is missing stops a triggered run, as it stops a typed one.
        self.api("POST", "/api/settings/mcp/servers", {"servers": []})
        b.goto(self.url("/settings#triggers"))
        b.wait("!document.getElementById('triggers-empty').hidden", "the empty trigger list")
        b.wait("document.getElementById('trigger-zone').textContent.includes('UTC')", "the server's time zone")
        b.click("#trigger-add")
        b.wait("!document.getElementById('trigger-form').hidden", "the trigger form")
        b.click("#trigger-form input[name=name]")
        b.type(TRIGGER)
        b.js(
            """(() => {
              const f = document.getElementById('trigger-form');
              f.elements.task.value = "What's going on?";
              f.elements.repeat.value = 'weekdays';
              f.elements.repeat.dispatchEvent(new Event('change'));
              f.elements.at.value = '08:30';
            })()"""
        )
        if b.js("document.querySelector('#trigger-form [name=cron]').disabled") is not True:
            raise Failure("the cron field is sent although Weekdays is picked")
        b.click("#trigger-form button[type=submit]")
        b.wait(
            "document.querySelector('#trigger-rows .trigger-row')?.innerText.includes('Weekdays at 08:30') && document.getElementById('trigger-form').hidden",
            "the saved trigger in the list",
        )
        row = b.js("document.querySelector('#trigger-rows .trigger-row').innerText")
        for expected in (TRIGGER, "What's going on?", "Next "):
            if expected not in row:
                raise Failure(f"the trigger row does not show {expected!r}:\n{row}")
        with open(self.y.config) as f:
            config = f.read()
        if f"- name: {TRIGGER}\n  task: What's going on?\n  schedule: weekdays 08:30\n" not in config:
            raise Failure(f"yardbell.yml does not hold the trigger:\n{config}")
        b.click("#trigger-rows [data-run='0']")
        b.wait("document.querySelector('#trigger-rows .trigger-last[data-outcome=started] a')", "the last run with a link to its conversation", timeout=15)
        b.click("#trigger-rows .trigger-last a")
        b.wait("location.pathname === '/dispatch' && new URLSearchParams(location.search).get('c')", "Dispatch with the conversation")
        b.wait(
            f"document.querySelector('#dispatch-log .trigger-head')?.innerText.includes('Started by the trigger {TRIGGER}')",
            "the header that says which trigger started it",
        )
        b.wait("[...document.querySelectorAll('#dispatch-log .msg.md')].some((m) => m.textContent.includes('Nothing needs you right now.'))", "the fake Claude's answer", timeout=15)
        head = b.js("document.querySelector('#dispatch-log .trigger-head').innerText")
        if "Weekdays at 08:30" not in head:
            raise Failure(f"the header does not say the schedule:\n{head}")
        if b.js("document.querySelector('#dispatch-log .msg.user')?.textContent") != "What's going on? Summarise every machine and session.":
            raise Failure("the conversation does not start with the task's text")
        b.wait("document.querySelector('#convo-list .selected .convo-trigger')", "the trigger mark in the conversation list")
        b.click("#dispatch-log .trigger-head .btn:last-child")
        b.wait("document.querySelector('#dispatch-log .trigger-head.off')?.innerText.includes('Turn on')", "the trigger turned off from the conversation")
        with open(self.y.config) as f:
            if "  enabled: false\n" not in f.read():
                raise Failure("turning the trigger off did not reach yardbell.yml")

    def test_remove_worktree_of_an_ended_session(self):
        b = self.b
        repo = os.path.join(self.y.root, "demo-api")
        started = self.api("POST", "/sessions", {
            "machine": MACHINE, "path": repo, "branch": "wt-remove", "new_branch": True, "base": "main", "wait": True,
        })
        worktree = started["path"]
        if worktree != repo + "-worktrees/wt-remove":
            raise Failure(f"the session started in {worktree}, not in its own worktree")
        write(os.path.join(worktree, "notes.txt"), "not committed\n")
        b.goto(self.url("/"))
        b.wait(f"document.querySelector('[data-act=stop][data-name={json.dumps(started['name'])}]')", "the worktree session on the dashboard")
        self.api("POST", f"/sessions/{MACHINE}/{started['name']}/stop")
        b.wait(
            f"(async () => (await (await fetch('/state')).json()).ended.some((e) => e.worktree && e.path === {json.dumps(worktree)}))()",
            "the ended session, known to be in a worktree",
            timeout=20,
        )
        b.wait("document.querySelector('[data-toggle=ended]')", "the ended sessions toggle")
        if b.js("document.querySelector('[data-toggle=ended]').getAttribute('aria-expanded')") != "true":
            b.click("[data-toggle=ended]")
        b.wait(f"document.querySelector('[data-act=remove-worktree][data-path={json.dumps(worktree)}]')", "Remove worktree on the ended row")
        b.click(f"[data-act=remove-worktree][data-path={json.dumps(worktree)}]")
        b.wait("document.querySelector('dialog.wt-dialog [data-wt=remove]')", "what would be lost", timeout=15)
        shown = b.js("document.querySelector('dialog.wt-dialog').innerText")
        for expected in ("1 uncommitted change would be lost", "?? notes.txt", "Remove and lose these"):
            if expected not in shown:
                raise Failure(f"the dialog does not say {expected!r}:\n{shown}")
        if not os.path.isdir(worktree):
            raise Failure("the worktree went before it was confirmed")
        b.click("dialog.wt-dialog [data-wt=remove]")
        b.wait("!document.querySelector('dialog.wt-dialog')", "the dialog to close after removing", timeout=15)
        b.wait("document.getElementById('toast').textContent.includes('Removed')", "the removal toast")
        if os.path.exists(worktree):
            raise Failure("the worktree is still there")
        if not os.path.isfile(os.path.join(repo, "README.md")):
            raise Failure("the main checkout was touched")
        branches = subprocess.run(["git", "branch", "--list", "wt-remove"], cwd=repo, capture_output=True, text=True).stdout
        if "wt-remove" not in branches:
            raise Failure("the unmerged branch was deleted")
        b.wait(
            f"(async () => !(await (await fetch('/state')).json()).ended.some((e) => e.path === {json.dumps(worktree)}))()",
            "the ended row to go with its worktree",
        )

    # Last, since the children it starts are shell sessions in demo-app and demo-api, which the
    # scan test above counts.
    def test_dispatch_results_card_shows_each_child(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={RESULTS_CHAT}"))
        card = "#dispatch-log .results-card"
        b.wait(f"document.querySelector('{card}')?.textContent.includes('Results of Three ways to fix the redirect')", "the seeded results card")
        badges = b.js(f"[...document.querySelectorAll('{card} .group-child .badge')].map((x) => x.textContent).join()")
        if badges != "Done,Needs you,Did not start":
            raise Failure(f"the children's badges are {badges!r}")
        text = b.js(f"document.querySelector('{card}').innerText")
        for expected in ("Timed out", "Gathered after 30 min, 1 of 2 sessions finished", "Moved the redirect into the guard.",
                         "12 tests pass", "fix-guard", "hp-demo-app-8 on hp", "Run the migration?", REFUSED, "pick the smallest fix"):
            if expected not in text:
                raise Failure(f"the results card does not show {expected!r}:\n{text}")
        if b.js(f"document.querySelectorAll('{card} .group-child-actions .btn').length") != 2:
            raise Failure("each child that started has Review branch, and only those")
        if b.js("document.querySelector('#dispatch-log .group-card .step-card-head .badge').textContent") != "Results below":
            raise Failure("the group card does not point at its results")
        if b.js("document.querySelectorAll('#dispatch-log article.step-card:not(.group-card):not(.results-card)').length"):
            raise Failure("a child's step is drawn outside its group's card")
        if not b.js("document.querySelector('#dispatch-log .msg.user.by-yardbell')?.textContent.startsWith('Sent by Yardbell')"):
            raise Failure("the follow-up message does not say Yardbell sent it")
        b.click(f"{card} .group-child:first-child .group-child-actions .btn")
        b.wait(
            """(() => {
              const step = [...document.querySelectorAll('#dispatch-log .step-card.pending')].at(-1);
              return step && step.querySelector('.step-card-title strong').textContent === 'Start a review' && step.textContent.includes('hp-demo-app-7');
            })()""",
            "a review of the child's branch, waiting to be started",
        )

    def test_dispatch_group_card_approves_all_its_children(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={GROUP_CHAT}"))
        card = "#dispatch-log .group-card"
        b.wait(f"document.querySelectorAll('{card} .group-child').length === 3", "the seeded group with three children")
        if b.js(f"document.querySelector('{card} .step-card-head .badge').textContent") != "2 wait for you":
            raise Failure("the group's badge does not count the children waiting")
        if REFUSED not in b.js(f"document.querySelector('{card} .group-child.refused .group-child-note').textContent"):
            raise Failure("the refused child does not say why")
        b.click(f"{card} .group-child.pending:first-child .group-child-actions .btn:nth-child(2)")
        b.wait(f"document.querySelector('{card} .group-child:first-child .step-card-form textarea')", "the child's editor")
        b.click(f"{card} .group-child:first-child .group-child-actions .btn.quiet")
        b.wait(f"!document.querySelector('{card} .step-card-form')", "the editor to close")
        b.click(f"{card} .step-card-foot .btn.primary")
        b.wait(
            f"[...document.querySelectorAll('{card} .group-child-note')].filter((n) => n.textContent.startsWith('Running as')).length === 2",
            "both children running",
            # The children start one after another, each followed by a check of the machine,
            # which the sessions earlier tests left behind make slower.
            timeout=40,
        )
        convo = self.api("GET", f"/dispatch/conversations/{GROUP_CHAT}")
        names = {e["label"]: e["result"]["session"]["name"] for e in convo["events"] if e["role"] == "action"}
        if set(names) != {"App", "Api"}:
            raise Failure(f"the children started as {names}")
        b.wait(
            f"""(async () => {{
              const sessions = (await (await fetch('/state')).json()).sessions;
              return [[{json.dumps(names["App"])}, 'demo-app'], [{json.dumps(names["Api"])}, 'demo-api']]
                .every(([name, folder]) => sessions.some((s) => s.tmux === name && s.folder === folder && s.agent === 'shell'));
            }})()""",
            "both shell sessions in /state, each in its own folder",
            timeout=15,
        )
        if b.js("document.querySelector('#dispatch-log .steps-bar')"):
            raise Failure("a step still waits after Approve all")
        b.wait(f"document.querySelector('{card} .step-card-head .badge').textContent === '0 of 2 done'", "the group running")

    def test_dispatch_memory_step_shows_a_diff_and_updates_settings(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={MEMORY_CHAT}"))
        card = "#dispatch-log .step-card.pending"
        b.wait(f"document.querySelector('{card} .memory-diff')", "the memory step with its diff")
        diff = b.js(f"""(() => {{
          const d = document.querySelector('{card} .memory-diff');
          return {{ del: d.querySelector('del')?.textContent, ins: d.querySelector('ins')?.textContent,
                   title: document.querySelector('{card} .step-card-title strong').textContent }};
        }})()""")
        if diff != {"del": f"-{MEMORY_OLD}", "ins": f"+{MEMORY_NEW}", "title": "Change a memory"}:
            raise Failure(f"the card shows {diff}")
        b.click(f"{card} .step-card-actions .btn.primary")
        b.wait("document.querySelector('#dispatch-log .step-card.done .step-card-outcome a[href=\"/settings#dispatch-memory\"]')", "the step saved, with a link to the memory")
        b.goto(self.url("/settings#dispatch-memory"))
        b.wait("!document.getElementById('dispatch').hidden && document.querySelectorAll('#memory-rows .row').length === 2", "the memory in Settings")
        rows = b.js("[...document.querySelectorAll('#memory-rows .row-title')].map((r) => r.textContent)")
        if rows != [MEMORY_NEW, "Branches are named after the ticket"]:
            raise Failure(f"Settings lists {rows}")
        history = b.js("document.getElementById('memory-history-list').textContent")
        if "proposed by Dispatch, approved by you" not in history or MEMORY_OLD not in history:
            raise Failure(f"the history says {history!r}")

        b.click("#memory-add")
        b.click("#memory-form textarea")
        b.type("Never open PRs on Fridays")
        b.click("#memory-form button[type=submit]")
        b.wait("document.querySelectorAll('#memory-rows .row').length === 3 && document.getElementById('memory-form').hidden", "the new entry")
        b.click("#memory-rows .row:nth-child(2) [data-memory-delete]")
        b.wait("document.querySelector('dialog.confirm[open]')", "the delete confirmation")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("document.querySelectorAll('#memory-rows .row').length === 2", "the entry deleted")
        with open(os.path.join(self.y.state, "dispatch", "memory.md")) as f:
            saved = f.read()
        if saved != f"# Dispatch memory\n\n- {MEMORY_NEW}\n- Never open PRs on Fridays\n":
            raise Failure(f"memory.md holds {saved!r}")
        if os.stat(os.path.join(self.y.state, "dispatch", "memory.md")).st_mode & 0o777 != 0o600:
            raise Failure("memory.md is readable by other accounts")

    def wait_minutes(self):
        with open(self.y.config) as f:
            found = re.search(r"wait_minutes: (\d+)", f.read())
        return int(found.group(1)) if found else None

    def test_dispatch_change_settings_card(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={SETTINGS_CHAT}"))
        card = "#dispatch-log .step-card.pending"
        b.wait(f"document.querySelector('{card} .change-diff')", "the settings step with its diff")
        seen = b.js(f"""(() => {{
          const c = document.querySelector('{card}');
          return {{ title: c.querySelector('.step-card-title strong').textContent,
                   del: c.querySelector('.change-diff del')?.textContent,
                   ins: c.querySelector('.change-diff ins')?.textContent,
                   link: c.querySelector('a[href="/settings#phone"]')?.textContent.trim() }};
        }})()""")
        if seen != {"title": "Change Settings: Phone notifications", "del": "removed 2", "ins": "added 7", "link": "Open in Settings"}:
            raise Failure(f"the card shows {seen}")
        b.click(f"{card} .step-card-actions .btn.primary")
        b.wait("document.querySelector('#dispatch-log .step-card.done .step-card-outcome a[href=\"/settings#phone\"]')", "the change saved, with a link to Settings")
        said = b.js("document.querySelector('#dispatch-log .step-card.done .step-card-outcome').textContent")
        if "Settings, Undo reverses it" not in said:
            raise Failure(f"the outcome says {said!r}")
        if self.wait_minutes() != 7:
            raise Failure(f"yardbell.yml waits {self.wait_minutes()} minutes")
        self.check_errors("the settings card")
        b.click("#dispatch-log .step-card.done .step-card-outcome a")
        b.wait("!document.getElementById('undo-bar').hidden && document.getElementById('undo-text').textContent === 'Dispatch changed the phone settings.'", "Undo for Dispatch's change in Settings")
        b.click("#undo-btn")
        b.wait("document.getElementById('undo-title').textContent === 'Undone.'", "the change undone")
        if self.wait_minutes() == 7:
            raise Failure("Undo left the change in yardbell.yml")

    def test_dispatch_change_settings_edit(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={SETTINGS_EDIT_CHAT}"))
        card = "#dispatch-log .step-card.pending"
        b.wait(f"document.querySelector('{card} .change-diff')", "the settings step")
        b.js(f"[...document.querySelectorAll('{card} .step-card-actions button')].find((x) => x.textContent.trim() === 'Edit').click()")
        area = f"{card} .step-card-form textarea"
        b.wait(f"document.querySelector('{area}')?.value.includes('\"wait_minutes\": 9')", "the value as JSON to edit")

        def put(text):
            b.js(f"""(() => {{ const t = document.querySelector('{area}'); t.value = {json.dumps(text)};
              t.dispatchEvent(new Event('input')); }})()""")

        value = b.js(f"document.querySelector('{area}').value")
        put(value.replace('"wait_minutes": 9', '"wait_minutes": 500'))
        b.click(f"{card} .step-card-actions .btn.primary")
        b.wait(f"document.querySelector('{card} .step-card-form [role=alert]')?.textContent.includes('from 0 to 60')", "the problem on the card")
        put("{ not json")
        b.click(f"{card} .step-card-actions .btn.primary")
        b.wait(f"document.querySelector('{card} .step-card-form [role=alert]')?.textContent.includes('JSON')", "a note that the value is not JSON")
        put(value.replace('"wait_minutes": 9', '"wait_minutes": 12'))
        b.click(f"{card} .step-card-actions .btn.primary")
        b.wait("document.querySelector('#dispatch-log .step-card.done')", "the edited change saved")
        note = b.js("document.querySelector('#dispatch-log .step-card.done .step-card-note').textContent")
        if "you changed the settings" not in note:
            raise Failure(f"the card says {note!r}")
        if self.wait_minutes() != 12:
            raise Failure(f"yardbell.yml waits {self.wait_minutes()} minutes")

    def test_dispatch_save_task_card(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={TASK_CHAT}"))
        card = "#dispatch-log .step-card.pending"
        b.wait(f"document.querySelector('{card} .change-diff ins')", "the task step with its text")
        title = b.js(f"document.querySelector('{card} .step-card-title strong').textContent")
        if title != f"Save the task {NEW_TASK}":
            raise Failure(f"the card is titled {title!r}")
        b.click(f"{card} .step-card-actions .btn.primary")
        b.wait("document.querySelector('#dispatch-log .step-card.done .step-card-outcome')?.textContent.includes('Saved as version 1')", "the task saved")
        b.wait(f"[...document.querySelectorAll('#task-list .task')].some((t) => t.textContent.includes({json.dumps(NEW_TASK)}))", "the task in the list")
        b.click("#dispatch-log .step-card.done .step-card-outcome .btn")
        b.wait("document.querySelectorAll('.th-dialog .th-version').length === 1", "the task's history")
        b.js("document.querySelector('.th-dialog').close()")

    def test_task_history_diff_and_restore(self):
        b = self.b
        b.goto(self.url("/dispatch"))
        item = f"[...document.querySelectorAll('#task-list .task')].find((t) => t.textContent.includes({json.dumps(OLD_TASK)}))"
        b.wait(item, "the task kept from before versions")
        b.js(f"{item}.querySelector('[aria-label^=Edit]').click()")
        b.wait("document.getElementById('task-version-word').textContent === 'Version 1'", "a task from an old file as version 1")
        b.js("document.querySelector('#task-form textarea').value = ''")
        b.click("#task-form textarea")
        b.type("Fix the login redirect and run the tests")
        b.click("#task-form button[type=submit]")
        b.wait(f"{item}?.textContent.includes('run the tests')", "the saved text in the list")
        b.js(f"{item}.querySelector('[aria-label^=Edit]').click()")
        b.wait("document.getElementById('task-version-word').textContent === 'Version 2'", "the save as version 2")
        b.click("#task-history")
        b.wait("document.querySelectorAll('.th-dialog .th-version').length === 2", "both versions in the history")
        b.wait("document.querySelector('.th-diff ins')?.textContent === ' and run the tests'", "the added words in the diff")
        if b.js("document.querySelector('.th-diff del')"):
            raise Failure("nothing was removed, but the diff shows a removal")
        b.click(".th-dialog .th-version:last-child .btn")
        b.wait("document.querySelectorAll('.th-dialog .th-version').length === 3", "the restored text as a new version")
        head = b.js("document.querySelector('.th-dialog .th-version').innerText")
        if "Version 3" not in head or "Restored from version 1" not in head or "Current" not in head:
            raise Failure(f"the newest version reads {head!r}")
        b.wait("document.querySelector('.th-diff del')?.textContent === ' and run the tests'", "the diff of version 2 and the restored one")
        b.click(".th-dialog .dialog-foot .btn.primary")
        b.wait(f"!document.querySelector('.th-dialog') && {item}.querySelector('.convo-meta').textContent === 'Fix the login redirect'", "the restored text in the list")
        tasks = self.api("GET", "/dispatch/tasks")
        mine = next(t for t in tasks if t["name"] == OLD_TASK)
        if mine["version"] != 3:
            raise Failure(f"the task is at version {mine['version']}")

    def test_insights_timeline_and_a_better_prompt(self):
        b = self.b
        if not self.session:
            path = os.path.join(self.y.root, "demo-app")
            self.session = self.api("POST", "/sessions", {"machine": MACHINE, "path": path, "wait": True})["name"]
        row = f".s-row [data-act=insights][data-name={json.dumps(self.session)}]"
        b.goto(self.url("/"))
        b.wait(f"document.querySelector('{row}')", "Insights on a session row", timeout=15)
        b.click(row)
        b.wait("document.querySelector('.ins-dialog .ins-body')", "the Insights of a live session")
        b.click(".ins-dialog [data-ins=close]")
        b.wait("!document.querySelector('.ins-dialog')", "the dialog to close")

        b.goto(self.url(f"/dispatch?c={INSIGHTS_CHAT}"))
        card = "#dispatch-log .session-card"
        b.wait(f"[...document.querySelectorAll('{card} .btn')].find((x) => x.textContent === 'Insights')", "Insights on the session card")
        b.js(f"[...document.querySelectorAll('{card} .btn')].find((x) => x.textContent === 'Insights').click()")
        b.wait("document.querySelector('.ins-dialog .ins-list')", "the seeded timeline")
        text = b.js("document.querySelector('.ins-dialog').innerText")
        for expected in ("Insights for hp-old-run", "Status\nEnded", "Folder\ndemo-app", "Bash: npm test",
                         "Tests: 1 failed, 4 passed, 5 total", "Failed", "Ended", "Fix the login redirect",
                         f"From the task {OLD_TASK}, version 1"):
            if expected not in text:
                raise Failure(f"Insights do not show {expected!r}:\n{text}")
        stats = b.js("[...document.querySelectorAll('.ins-dialog .ins-stat')].map((x) => [...x.children].slice(0, 3).map((c) => c.textContent.trim()).join(' | ')).join('; ')")
        if stats != ("Working | 25 min | 63% of the time; Waiting for you | 5 min | 1 time, 12% of the time; "
                     "Idle | 10 min | 25% of the time; Test results | 1 run | 0 passed, 1 failed"):
            raise Failure(f"the totals read {stats}")
        entries = b.js("[...document.querySelectorAll('.ins-dialog .ins-run.is-pull a')].map((a) => [a.textContent.trim(), a.getAttribute('href')])")
        if entries != [["Pull request #12 opened: Fix the login redirect", FAKE_PR["url"]], ["carol approved", FAKE_PR["url"] + "#review"]]:
            raise Failure(f"the pull request entries read {entries}")
        known = self.api("GET", f"/sessions/{MACHINE}/{OLD_RUN}/insights")["pull"]
        summary = b.js("document.querySelector('.ins-dialog .ins-pull')?.innerText || ''")
        if known and f"#{known['number']}" not in summary:
            raise Failure(f"Insights know pull request #{known['number']} but the summary reads {summary!r}")
        if not known and summary:
            raise Failure(f"a summary without a pull request: {summary!r}")
        if not b.js("document.querySelector('.ins-dialog .ins-list > li.ins-day')"):
            raise Failure("the timeline does not name the day of a session from an earlier day")
        states = b.js("[...document.querySelectorAll('.ins-dialog .ins-period .ins-text')].map((x) => x.textContent).join()")
        if states != "Working,Waiting for you,Working,Idle,Ended":
            raise Failure(f"the timeline's periods are {states!r}")
        if b.js("document.querySelectorAll('.ins-dialog .ins-bar .ins-seg').length") != 4:
            raise Failure("the bar does not draw each period")

        b.click(".ins-dialog [data-ins=suggest]")
        b.wait("[...document.querySelectorAll('#dispatch-log .msg.user.marked .msg-by')].some((x) => x.textContent === 'Suggest a better prompt for hp-old-run on hp')",
               "the request as a message in this conversation")
        save = "[...document.querySelectorAll('#dispatch-log .prompt-actions .btn')]"
        b.wait(f"{save}.length === 2", "the proposed prompt with its two save buttons", timeout=20)
        convo = self.api("GET", f"/dispatch/conversations/{INSIGHTS_CHAT}")
        asked = [e for e in convo["events"] if e["role"] == "user"][-1]
        if asked.get("improve", {}).get("name") != OLD_RUN or asked["improve"].get("task", {}).get("name") != OLD_TASK:
            raise Failure(f"the request is marked {asked.get('improve')}")
        if "It started with this task:" not in asked["text"] or "1 failing test run" not in asked["text"]:
            raise Failure(f"Dispatch was asked:\n{asked['text']}")
        b.js(f"{save}[1].click()")
        b.wait(f"(async () => (await (await fetch('/dispatch/tasks')).json()).find((t) => t.name === {json.dumps(OLD_TASK)})?.text === {json.dumps(PROMPT)})()",
               "the proposal saved as the next version of its task")
        b.js(f"{save}[0].click()")
        b.wait(f"!document.getElementById('task-form').hidden && document.querySelector('#task-form textarea').value === {json.dumps(PROMPT)} && !document.querySelector('#task-form input[name=name]').value",
               "the proposal in a new task's form")
        b.click("#task-cancel")

    def test_pipeline_in_the_sidebar(self):
        for page in ("/", "/workspace", "/dispatch", "/settings", "/pipeline"):
            self.b.goto(self.url(page))
            self.b.wait("document.querySelector('.side-link[href=\"/pipeline\"]')", f"the Pipeline link on {page}")
            order = self.b.js("[...document.querySelectorAll('a.side-link[href]')].map((a) => a.getAttribute('href')).join(' ')")
            if "/workspace /pipeline /dispatch" not in order:
                raise Failure(f"the sidebar on {page} reads {order}")

    def set_field(self, selector, value):
        self.b.js(f"""(() => {{
          const el = document.querySelector({json.dumps(selector)});
          el.value = {json.dumps(value)};
          el.dispatchEvent(new Event("input", {{ bubbles: true }}));
          el.dispatchEvent(new Event("change", {{ bubbles: true }}));
        }})()""")

    def run_of(self, id):
        runs = self.api("GET", "/api/runs")["runs"]
        return next(r for r in runs if r["id"] == id)

    def test_pipelines_list_cards(self):
        b = self.b
        b.goto(self.url("/pipeline"))
        card = '.pl-card[data-id="review"]'
        b.wait(f"document.querySelector('{card}')", "the review pipeline's card")
        text = b.js(f"document.querySelector('{card}').textContent.replace(/\\s+/g, ' ')")
        for want in ("When a GitLab merge request on git.example.com adds me as reviewer",
                     "Understand", "Test ⟲ Root cause", "v1", "2 waiting · 1 done", "Needs you"):
            if want not in text:
                raise Failure(f"the card does not say {want!r}: {text}")
        if b.js(f"document.querySelector('{card} input[type=checkbox]').checked"):
            raise Failure("a pipeline that is off shows as on")
        b.click(f"{card} input[type=checkbox]")
        b.wait("document.getElementById('toast').textContent.includes('gitlab_reviewer names git.example.com')",
               "the checks' problem when switching on")
        b.wait(f"!document.querySelector('{card} input[type=checkbox]').checked", "the switch back off")
        b.click("#pl-waiting-toggle")
        b.wait("document.querySelectorAll('#pl-waiting .pl-wait-item').length === 2", "two runs waiting for me")
        if "!87 COM-1287 Fix the webhook dedup" not in b.js("document.getElementById('pl-waiting').textContent"):
            raise Failure("the waiting list does not name the merge request")
        self.check_errors("the Pipelines list")

    def test_pipeline_new_from_template(self):
        b = self.b
        b.goto(self.url("/pipeline"))
        b.click("#pl-new")
        b.wait("document.querySelector('#pl-templates button')", "the templates")
        b.js("[...document.querySelectorAll('#pl-templates button')].find((x) => x.textContent.includes('Implement my Linear tickets')).click()")
        b.wait("new URLSearchParams(location.search).get('p') === 'implement-my-linear-tickets'", "the new pipeline opened")
        b.wait("document.querySelector('.pl-title-name')?.value === 'Implement my Linear tickets'", "its name")
        b.click("#pl-back")
        b.wait("document.querySelectorAll('.pl-card[data-id]').length === 2", "two pipeline cards")

    def test_builder_opens_full_screen_and_toggles(self):
        b = self.b
        b.js("localStorage.removeItem('yb-pipeline-full')")
        b.goto(self.url("/pipeline?p=review&tab=build"))
        b.wait("document.querySelector('.pl-builder.full .pl-canvas.editable')", "the builder, full screen")
        fills = "(() => { const r = document.querySelector('.pl-builder').getBoundingClientRect(); return Math.round(r.left) === 0 && Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight; })()"
        if not b.js(fills):
            raise Failure("the full-screen builder does not cover the window")
        if b.js("document.querySelector('.pl-canvas').getBoundingClientRect().height") < b.js("innerHeight") * 0.7:
            raise Failure("the canvas does not take the height of the window")
        groups = b.js("[...document.querySelectorAll('.pl-library h3')].map((h) => h.textContent.trim()).join('|')")
        if groups != "Start when|Agent|Yardbell|You":
            raise Failure(f"the library groups read {groups}")
        b.click("#pl-full")
        b.wait("document.querySelector('.pl-builder:not(.full)') && document.querySelector('.side').getBoundingClientRect().width > 0", "the builder back in the page")
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-builder:not(.full) .pl-run-view')", "the Runs tab remembering the choice")
        if b.js("document.querySelector('.pl-canvas').getBoundingClientRect().bottom") < b.js("innerHeight") - 40:
            raise Failure("the Runs canvas does not reach the bottom of the window")
        b.click("#pl-full")
        b.wait("document.querySelector('.pl-builder.full .pl-run-view')", "the Runs tab full screen")
        self.check_errors("the builder shell")

    def test_builder_inspector_edits_and_saves(self):
        b = self.b
        self.open_builder()
        b.wait("document.querySelector('.pl-node[data-step=\"test\"]')", "the Test card")
        if b.js("document.querySelector('#pl-inspector')?.textContent.includes('Click a step')") is not True:
            raise Failure("the inspector does not say what to do with nothing selected")
        b.click('.pl-node[data-step="test"]')
        b.wait("document.querySelector('#pl-inspector .pl-step-form[data-step=\"test\"]')", "the Test step in the inspector")
        if b.js("document.querySelector('.pl-canvas').scrollLeft + document.querySelector('.pl-canvas').scrollTop") != 0:
            raise Failure("selecting a card scrolled the canvas box and hid its controls")
        version = self.api("GET", "/api/pipelines/review")["version"]
        self.set_field('#pl-inspector input[name=name]', "Test on hp")
        b.wait("document.querySelector('.pl-node[data-step=\"test\"] b').textContent === 'Test on hp'", "the card renamed as you type")
        b.click("#pl-save")
        b.wait(f"(async () => (await (await fetch('/api/pipelines/review')).json()).version === {version + 1})()", "the new version saved")
        b.wait("document.getElementById('pl-save').classList.contains('pl-saved')", "Save showing it is saved")
        b.click('.pl-node[data-step="@start"]')
        b.wait("document.querySelector('#pl-inspector select[name=trigger]')", "the trigger in the inspector")
        self.check_errors("the inspector")

    def test_builder_save_problems_ring_the_step(self):
        b = self.b
        self.open_builder()
        b.click('.pl-node[data-step="report"]')
        b.wait("document.querySelector('#pl-inspector input[name=max_runs]')", "Report to me in the inspector")
        self.set_field('#pl-inspector input[name=max_runs]', "0")
        b.click("#pl-save")
        b.wait("document.getElementById('pl-problems')?.textContent.includes('Report to me: max_runs must be from 1 to 10')", "the problem over the canvas")
        if not b.js("document.querySelector('.pl-node[data-step=\"report\"]').classList.contains('problem')"):
            raise Failure("the step the problem names is not ringed")
        if "max_runs must be from 1 to 10" not in b.js("document.querySelector('#pl-inspector .pl-inspector-problems')?.textContent || ''"):
            raise Failure("the inspector does not show the step's problem")
        self.check_errors("save problems")

    def open_builder(self):
        b = self.b
        b.js("localStorage.setItem('yb-pipeline-full', '1')")
        b.goto(self.url("/pipeline?p=review&tab=build"))
        b.wait("document.querySelector('.pl-node[data-step=\"report\"]')", "the builder")
        b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")

    def empty_spot(self):
        return self.b.js("(() => { const r = document.querySelector('.pl-canvas').getBoundingClientRect(); return [r.left + 90, r.bottom - 110]; })()")

    def has_line(self, src, outcome, dst=None):
        sel = f'.pl-edge-hit[data-from="{src}"][data-outcome="{outcome}"]'
        if dst:
            sel += f'[data-to="{dst}"]'
        return self.b.js(f"!!document.querySelector({json.dumps(sel)})")

    def test_builder_drag_from_library_creates_a_step(self):
        b = self.b
        self.open_builder()
        spot = self.empty_spot()
        b.drag('.pl-lib-item[data-kind="wait"]', tuple(spot), steps=10)
        b.wait("document.querySelector('.pl-node.kind-wait')", "a Wait for me card where it was dropped")
        if not b.js("document.querySelector('.pl-node.kind-wait').classList.contains('selected')"):
            raise Failure("the new step is not selected")
        if b.js("document.getElementById('pl-save').classList.contains('pl-saved')"):
            raise Failure("Save stays off after adding a step")
        self.check_errors("dragging from the library")

    def test_builder_connect_ports_and_cut_a_line(self):
        b = self.b
        self.open_builder()
        if self.has_line("understand", "needs_you"):
            raise Failure("the fixture already has the line this test draws")
        b.drag('.pl-node[data-step="understand"] .pl-port.out.needs_you', '.pl-node[data-step="report"]', steps=10)
        b.wait("!!document.querySelector('.pl-edge-hit[data-from=\"understand\"][data-outcome=\"needs_you\"][data-to=\"report\"]')", "the new needs you line")
        b.js("document.querySelector('.pl-edge-hit[data-from=\"understand\"][data-outcome=\"needs_you\"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))")
        b.wait("document.querySelector('.pl-edge.selected')", "the line selected")
        b.key("Delete")
        b.wait("!document.querySelector('.pl-edge-hit[data-from=\"understand\"][data-outcome=\"needs_you\"]')", "the line cut")
        self.check_errors("connecting ports")

    def test_builder_drop_a_line_on_empty_canvas_creates_a_connected_step(self):
        b = self.b
        self.open_builder()
        b.drag('.pl-node[data-step="test"] .pl-port.out.needs_you', tuple(self.empty_spot()), steps=10)
        b.wait("document.querySelector('#pl-add-menu button[data-kind=\"wait\"]')", "the add menu where the line was dropped")
        b.click('#pl-add-menu button[data-kind="wait"]')
        b.wait("document.querySelector('.pl-node.kind-wait')", "the new step")
        new = b.js("document.querySelector('.pl-node.kind-wait').dataset.step")
        if not self.has_line("test", "needs_you", new):
            raise Failure("the new step is not connected to the line that made it")

    def test_builder_delete_step_repoints_lines(self):
        b = self.b
        self.open_builder()
        b.click('.pl-node[data-step="root-cause"]')
        b.key("Delete")
        b.wait("!document.querySelector('.pl-node[data-step=\"root-cause\"]')", "Root cause removed")
        if b.js("!!document.querySelector('.pl-edge-hit[data-to=\"root-cause\"]')"):
            raise Failure("a line still points at the removed step")
        if self.has_line("understand", "pass"):
            raise Failure("Understand's pass line did not go back to End")

    def test_builder_move_undo_redo_and_tidy(self):
        b = self.b
        self.open_builder()
        left = lambda: b.js("parseFloat(document.querySelector('.pl-node[data-step=\"report\"]').style.left)")
        start = left()
        box = b.centre('.pl-node[data-step="report"] .pl-node-head b')
        b.drag((box["x"], box["y"]), (box["x"] + 120, box["y"]), steps=10)
        moved = left()
        if moved <= start + 60:
            raise Failure(f"dragging the card moved it from {start} to {moved}")
        b.key("z", "Control")
        b.wait(f"parseFloat(document.querySelector('.pl-node[data-step=\"report\"]').style.left) === {start}", "undo putting it back")
        b.key("z", "Control", "Shift")
        b.wait(f"parseFloat(document.querySelector('.pl-node[data-step=\"report\"]').style.left) === {moved}", "redo moving it again")
        b.click("#pl-tidy")
        b.wait(f"parseFloat(document.querySelector('.pl-node[data-step=\"report\"]').style.left) !== {moved}", "Tidy laying the steps out")
        b.key("z", "Control")
        b.wait(f"parseFloat(document.querySelector('.pl-node[data-step=\"report\"]').style.left) === {moved}", "one undo for the whole Tidy")

    def test_builder_keyboard_only(self):
        b = self.b
        self.open_builder()
        version = self.api("GET", "/api/pipelines/review")["version"]
        b.click('.pl-node[data-step="understand"]')
        b.js("document.querySelector('.pl-lib-item[data-kind=\"agent\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-agent.selected[data-step=\"agent-step\"]')", "the new agent step after Understand")
        if not self.has_line("understand", "pass", "agent-step") or not self.has_line("agent-step", "pass", "root-cause"):
            raise Failure("the new step was not put on Understand's pass line")
        before = b.js("parseFloat(document.querySelector('.pl-node[data-step=\"agent-step\"]').style.left)")
        b.js("document.activeElement.blur()")
        b.key("ArrowRight")
        if b.js("parseFloat(document.querySelector('.pl-node[data-step=\"agent-step\"]').style.left)") != before + 8:
            raise Failure("the arrow key did not nudge the step 8px")
        self.set_field('#pl-inspector select[name=machine_mode]', "name")
        b.wait("document.querySelector('#pl-inspector select[name=machine]')", "the machine to pick")
        self.set_field('#pl-inspector textarea[name=instructions]', "Check the change is small")
        b.js("document.activeElement.blur()")
        b.key("s", "Control")
        b.wait(f"(async () => (await (await fetch('/api/pipelines/review')).json()).version === {version + 1})()", "Ctrl+S saving")
        self.check_errors("the keyboard path")

    def test_new_empty_pipeline_and_build_it(self):
        b = self.b
        b.js("localStorage.setItem('yb-pipeline-full', '1')")
        b.goto(self.url("/pipeline"))
        b.click("#pl-new")
        b.wait("document.querySelector('#pl-templates button[data-empty]')", "Empty pipeline in the menu")
        if b.js("document.querySelector('#pl-templates button').hasAttribute('data-empty')") is not True:
            raise Failure("Empty pipeline is not the first choice")
        b.click("#pl-templates button[data-empty]")
        b.wait("new URLSearchParams(location.search).get('tab') === 'build' && document.querySelector('.pl-canvas-hint')", "the empty pipeline on the canvas with its hint")
        pid = b.js("new URLSearchParams(location.search).get('p')")
        b.js("document.querySelector('.pl-lib-item[data-kind=\"plan\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-plan.selected')", "Plan as the first step")
        b.js("document.querySelector('.pl-lib-item[data-kind=\"agent\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-agent.selected')", "the agent step after it")
        self.set_field('#pl-inspector select[name=machine_mode]', "name")
        b.wait("document.querySelector('#pl-inspector select[name=machine]')", "the machine to pick")
        self.set_field('#pl-inspector textarea[name=instructions]', "Say hello")
        b.js("document.querySelector('.pl-lib-item[data-kind=\"report\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-report.selected')", "Report to me after it")
        b.js("document.activeElement.blur()")
        b.key("s", "Control")
        b.wait(f"(async () => (await (await fetch('/api/pipelines/{pid}')).json()).steps.length === 3)()", "the new pipeline saved with three steps")
        b.click("#pl-run-now")
        b.wait("document.querySelector('#pl-run-now-panel')", "the Run now panel")
        b.js("[...document.querySelectorAll('#pl-run-now-panel button')].find((x) => x.textContent.trim() === 'Start').click()")
        b.wait(f"(async () => (await (await fetch('/api/pipelines/{pid}/runs')).json()).runs.length === 1)()", "Run now starting a run")
        self.check_errors("building from empty")

    def test_builder_warns_before_losing_changes(self):
        b = self.b
        self.open_builder()
        b.js("document.querySelector('.pl-lib-item[data-kind=\"wait\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-wait')", "an unsaved change")
        b.js("window.__asked = ''; window.confirm = (m) => { window.__asked = m; return false; }")
        b.click("#pl-back")
        if b.js("window.__asked") != "Leave without saving your changes?":
            raise Failure("leaving with unsaved changes did not ask")
        if not b.js("!!document.querySelector('.pl-node.kind-wait')"):
            raise Failure("saying no still threw the change away")
        b.js("window.confirm = () => true")
        b.click("#pl-back")
        b.wait("!new URLSearchParams(location.search).get('p')", "leaving once confirmed")

    def test_history_preview_then_restore(self):
        b = self.b
        definition = self.api("GET", "/api/pipelines/review")
        definition["steps"][0]["name"] = "Read the MR"
        saved = self.api("PUT", "/api/pipelines/review", definition)
        b.goto(self.url("/pipeline?p=review&tab=history"))
        b.wait("document.querySelector('.pl-history-row[data-version=\"1\"]')", "the first version")
        b.click('.pl-history-row[data-version="1"] .pl-history-pick')
        b.wait("document.querySelector('.pl-history-preview')?.textContent.includes('Version 1')", "the preview bar")
        if b.js("document.querySelector('.pl-canvas .pl-node[data-step=\"understand\"] b').textContent") != "Understand":
            raise Failure("the canvas does not show version 1")
        b.js("[...document.querySelectorAll('.pl-history-preview button')].find((x) => x.textContent.trim() === 'Restore').click()")
        b.wait(f"(async () => (await (await fetch('/api/pipelines/review')).json()).version === {saved['version'] + 1})()", "the restore saved")

    def test_builder_on_a_phone(self):
        b = self.b
        b.viewport(390, 844, 3)
        try:
            self.open_builder()
            if b.js("(() => { const l = document.querySelector('.pl-library'); return !!l && l.getBoundingClientRect().width > 0; })()"):
                raise Failure("the library takes room on a phone")
            if b.js("document.querySelector('.pl-canvas').getBoundingClientRect().width") < 380:
                raise Failure("the canvas does not take the width on a phone")
            b.click("#pl-add-step")
            b.wait("document.querySelector('#pl-add-sheet .pl-lib-item[data-kind=\"agent\"]')", "the Add step sheet")
            b.click('#pl-add-sheet .pl-lib-item[data-kind="agent"]')
            b.wait("!document.querySelector('#pl-add-sheet') && document.querySelector('.pl-node.kind-agent.selected')", "the new step, with the sheet closed")
            b.wait("document.querySelector('.pl-inspector.sheet') && document.querySelector('.pl-inspector.sheet').getBoundingClientRect().height > 100", "the step in a bottom sheet")
            b.click("#pl-sheet-done")
            b.wait("!document.querySelector('.pl-inspector.sheet')", "the sheet closed")
            if b.js("document.documentElement.scrollWidth") > b.js("innerWidth"):
                raise Failure("the builder scrolls sideways on a phone")
            self.check_errors("the builder on a phone")
        finally:
            b.viewport(1280, 800)

    def test_builder_a_click_on_a_port_changes_nothing(self):
        b = self.b
        self.open_builder()
        b.click('.pl-node[data-step="understand"] .pl-port.out.pass')
        if not self.has_line("understand", "pass", "root-cause") or self.has_line("understand", "pass", "understand"):
            raise Failure("clicking a port rewired the step")
        b.drag('.pl-node[data-step="understand"] .pl-port.out.fail', '.pl-node[data-step="understand"]', steps=8)
        if self.has_line("understand", "fail", "understand"):
            raise Failure("dragging a port back onto its own card made a loop")

    def test_builder_renaming_a_step_keeps_its_reports(self):
        b = self.b
        self.open_builder()
        b.click('.pl-node[data-step="test"]')
        b.wait("document.querySelector('#pl-inspector textarea[name=instructions]')", "the Test step")
        self.set_field('#pl-inspector textarea[name=instructions]', "Use {report:Understand}")
        b.click('.pl-node[data-step="understand"]')
        b.wait("document.querySelector('#pl-inspector .pl-step-form[data-step=\"understand\"]')", "Understand")
        self.set_field('#pl-inspector input[name=name]', "Understand it")
        b.wait("document.querySelector('.pl-node[data-step=\"test\"] .pl-node-text').textContent.includes('{report:Understand it}')",
               "the other step's {report:...} following the rename")

    def test_builder_switching_on_survives_a_save(self):
        b = self.b
        made = self.api("POST", "/api/pipelines", {"template": "Implement my Linear tickets"})
        b.js("localStorage.setItem('yb-pipeline-full', '1')")
        b.goto(self.url(f"/pipeline?p={made['id']}&tab=build"))
        b.wait("document.querySelector('.pl-node')", "the builder")
        self.set_field(".pl-bar .pl-name", "Implement mine")
        b.click(".pl-bar input.switch")
        b.wait(f"(async () => (await (await fetch('/api/pipelines/{made['id']}')).json()).enabled)()", "the pipeline switched on")
        b.click("#pl-save")
        b.wait(f"(async () => {{ const d = await (await fetch('/api/pipelines/{made['id']}')).json(); return d.enabled && d.version === {made['version'] + 1}; }})()",
               "the save keeping it on")

    def test_builder_browser_back_asks_before_losing_changes(self):
        b = self.b
        b.js("localStorage.setItem('yb-pipeline-full', '1')")
        b.goto(self.url("/pipeline"))
        b.click('.pl-card[data-id="review"]')
        b.wait("document.querySelector('.pl-builder')", "the pipeline")
        b.js("[...document.querySelectorAll('.pl-builder [role=tab]')].find((t) => t.textContent.trim() === 'Build').click()")
        b.wait("document.querySelector('.pl-canvas.editable')", "Build")
        b.js("document.querySelector('.pl-lib-item[data-kind=\"wait\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-wait')", "an unsaved change")
        b.js("window.__asked = ''; window.confirm = (m) => { window.__asked = m; return false; }")
        b.js("history.back()")
        b.wait("window.__asked === 'Leave without saving your changes?'", "the question")
        b.wait("new URLSearchParams(location.search).get('p') === 'review' && document.querySelector('.pl-node.kind-wait')", "the change kept")

    def test_run_now_on_a_manual_pipeline_takes_a_ticket(self):
        b = self.b
        made = self.api("POST", "/api/pipelines", {"empty": True})
        b.js("localStorage.setItem('yb-pipeline-full', '1')")
        b.goto(self.url(f"/pipeline?p={made['id']}&tab=build"))
        b.click("#pl-run-now")
        b.wait("document.querySelector('#pl-run-now-panel textarea')", "the Run now panel")
        if b.js("[...document.querySelectorAll('#pl-run-now-panel button')].find((x) => x.textContent.trim().startsWith('Start')).disabled"):
            raise Failure("a manual pipeline cannot start without a ticket")

    def test_settings_no_longer_offers_the_ticket_pipeline(self):
        b = self.b
        b.goto(self.url("/settings"))
        b.wait("document.querySelector('form')", "the settings page")
        if b.js("!!document.querySelector('option[value=\"pipeline\"], input[name=pl_state]')"):
            raise Failure("Settings still offers the removed ticket pipeline")

    def test_pipeline_run_graph_and_waiting_box(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-node[data-step=\"root-cause\"].waiting')", "Root cause marked waiting")
        for step, cls in (("understand", "done"), ("test", "later"), ("report", "later")):
            if not b.js(f"document.querySelector('.pl-node[data-step=\"{step}\"]').classList.contains('{cls}')"):
                raise Failure(f"the {step} node is not {cls}")
        if b.js("document.querySelectorAll('.pl-canvas svg path').length") < 5:
            raise Failure("the graph does not draw the lines between steps")
        if b.js("getComputedStyle(document.querySelector('.pl-canvas')).overflow") != "clip":
            raise Failure("the graph scrolls instead of panning")
        fitted = b.js("document.querySelector('.pl-pan').style.transform")
        b.js("document.querySelector('.pl-canvas').dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 30, bubbles: true, cancelable: true }))")
        if b.js("document.querySelector('.pl-pan').style.transform") == fitted:
            raise Failure("two-finger scrolling does not pan the graph")
        panned = b.js("document.querySelector('.pl-pan').style.transform")
        b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")
        if b.js("document.querySelector('.pl-pan').style.transform") == panned:
            raise Failure("Fit does not bring the graph back")
        box = "#pl-need"
        b.wait(f"document.querySelector('{box}')?.textContent.includes('Which window is right?')", "the agent's question")
        b.click(f"{box} textarea")
        b.type("Five minutes")
        b.click(f"{box} .btn.primary")
        b.wait("(async () => (await (await fetch('/api/runs')).json()).runs.find((r) => r.id === 'run-a').steps['root-cause'].answer === 'Five minutes')()",
               "the answer kept on the run")
        b.click('.pl-run-item[data-id="run-b"]')
        b.wait(f"document.querySelector('{box}')?.textContent.includes('Test failed')", "run B's waiting box")
        b.js(f"[...document.querySelectorAll('{box} button')].find((x) => x.textContent.trim() === 'Continue on fail').click()")
        b.wait("(async () => (await (await fetch('/api/runs')).json()).runs.find((r) => r.id === 'run-b').step === 'root-cause')()",
               "run B back at Root cause")
        self.check_errors("the Runs tab")

    def test_canvas_zoom_controls(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-c"))
        b.wait("document.querySelector('.pl-zoom-pct')", "the zoom controls")
        pct = lambda: b.js("document.querySelector('.pl-zoom-pct').textContent.trim()")
        b.js("document.querySelector('.pl-zoom-pct').closest('.pl-zoom').querySelector('[aria-label=\"Zoom in\"]').click()")
        first = pct()
        b.js("document.querySelector('[aria-label=\"Zoom out\"]').click()")
        b.js("document.querySelector('[aria-label=\"Zoom in\"]').click()")
        if pct() != first or not first.endswith("%"):
            raise Failure(f"zooming out and in again reads {pct()}, not {first}")
        before = pct()
        b.js("""(() => {
          const c = document.querySelector('.pl-canvas'), r = c.getBoundingClientRect();
          c.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, clientX: r.left + 100, clientY: r.top + 100, bubbles: true, cancelable: true }));
        })()""")
        if int(pct().rstrip("%")) <= int(before.rstrip("%")):
            raise Failure(f"Ctrl and the wheel did not zoom in: {before} then {pct()}")
        b.js("document.querySelector('.pl-zoom-pct').textContent")
        b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")
        if int(pct().rstrip("%")) > 100:
            raise Failure(f"Fit leaves the graph at {pct()}")

    def test_canvas_minimap_moves_the_view(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-c"))
        b.wait("document.querySelector('.pl-minimap .pl-mini-view')", "the minimap")
        if b.js("document.querySelectorAll('.pl-minimap .pl-mini-node').length") != 6:
            raise Failure("the minimap does not show the Start node and the five steps")
        before = b.js("document.querySelector('.pl-pan').style.transform")
        box = b.js("(() => { const r = document.querySelector('.pl-minimap').getBoundingClientRect(); return [r.right - 8, r.bottom - 8]; })()")
        b.drag((box[0] - 1, box[1] - 1), (box[0], box[1]), steps=1)
        if b.js("document.querySelector('.pl-pan').style.transform") == before:
            raise Failure("pressing the minimap does not move the view")
        self.check_errors("the canvas")

    def test_pipeline_history_restore(self):
        b = self.b
        definition = self.api("GET", "/api/pipelines/review")
        first = definition["steps"][0]["name"]
        definition["steps"][0]["name"] = "Read it"
        saved = self.api("PUT", "/api/pipelines/review", definition)
        b.goto(self.url("/pipeline?p=review&tab=history"))
        b.wait(f"document.querySelector('.pl-history-row')?.dataset.version === '{saved['version']}'", "the newest version first")
        b.click('.pl-history-row[data-version="1"] .btn')
        b.wait(f"(async () => (await (await fetch('/api/pipelines/review')).json()).version === {saved['version'] + 1})()", "the restore saved")
        if self.api("GET", "/api/pipelines/review")["steps"][0]["name"] != first:
            raise Failure("restoring version 1 did not bring its step names back")

    def test_pipeline_settings_panel(self):
        b = self.b
        b.goto(self.url("/pipeline"))
        b.click("#pl-settings-open")
        b.wait("document.querySelector('#pl-settings input[name=per_machine]')", "the settings form")
        self.set_field("#pl-settings input[name=per_machine]", "3")
        self.set_field("#pl-settings input[name=minutes]", "90")
        b.click("#pl-note-add")
        self.set_field("#pl-settings .pl-note:last-child input[name=folder]", "demo-app")
        self.set_field("#pl-settings .pl-note:last-child input[name=note]", "Run bin/rspec")
        b.click("#pl-settings-save")
        b.wait("document.getElementById('toast').textContent.includes('Saved')", "the settings saved")
        with open(self.y.config) as f:
            config = f.read()
        for want in ("per_machine: 3", "minutes: 90", "demo-app: Run bin/rspec"):
            if want not in config:
                raise Failure(f"yardbell.yml does not hold {want!r}:\n{config}")

    def check_errors(self, where):
        if self.b.errors:
            errors, self.b.errors = self.b.errors, []
            raise Failure(f"errors on {where}:\n  " + "\n  ".join(errors))

    def run(self, only):
        tests = [n for n in dir(self) if n.startswith("test_")]
        tests.sort(key=lambda n: Suite.__dict__[n].__code__.co_firstlineno)
        failed = []
        for name in tests:
            if only and only not in name and name != "test_login":
                continue
            start = time.time()
            try:
                getattr(self, name)()
                self.b.pump(0.3)
                self.check_errors(name)
                print(f"ok    {name} ({time.time() - start:.1f}s)", flush=True)
            except Exception as e:
                failed.append(name)
                detail = str(e) if isinstance(e, Failure) else traceback.format_exc()
                print(f"FAIL  {name} ({time.time() - start:.1f}s)\n  {detail}", flush=True)
                if self.shots:
                    os.makedirs(self.shots, exist_ok=True)
                    try:
                        self.b.screenshot(os.path.join(self.shots, f"{name}.png"))
                    except Exception:
                        pass
                self.b.errors = []
                if name == "test_login":
                    break
        return failed


def main():
    ap = argparse.ArgumentParser(description="Browser tests for the Yardbell UI, in headless Firefox against a throwaway server.")
    ap.add_argument("--bin", default=os.path.join(REPO, "target", "debug", "yardbell"), help="the yardbell binary to test")
    ap.add_argument("--firefox", default=os.environ.get("FIREFOX") or shutil.which("firefox"), help="the Firefox binary")
    ap.add_argument("--shots", help="save a screenshot of each failing test in this directory")
    ap.add_argument("-k", dest="only", help="run only the tests whose name contains this")
    ap.add_argument("--keep", action="store_true", help="keep the temporary directory (config, state, server log)")
    a = ap.parse_args()
    if not os.access(a.bin, os.X_OK):
        raise SystemExit(f"no yardbell binary at {a.bin}, run `cargo build` first")
    if not a.firefox:
        raise SystemExit("Firefox not found, pass --firefox or set FIREFOX")
    if not shutil.which("tmux"):
        raise SystemExit("tmux not found")

    began = time.time()
    tmp = tempfile.mkdtemp(prefix="yardbell-browser-")
    server = browser = None
    failed = ["setup"]
    try:
        server = Yardbell(a.bin, tmp)
        browser = Browser(a.firefox)
        failed = Suite(server, browser, a.shots).run(a.only)
    finally:
        if browser:
            browser.close()
        if server:
            server.stop()
            if failed:
                print("server log:\n" + tail(server.log.name))
        if a.keep:
            print(f"kept {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"{'FAILED: ' + ', '.join(failed) if failed else 'all passed'} in {time.time() - began:.0f}s")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
