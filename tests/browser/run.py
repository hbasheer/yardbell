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
import urllib.parse
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
FAKE_DICTATION = "Fix the flaky checkout test, please."

# A tone that can be switched on and off stands in for the microphone, and /dispatch/transcribe
# answers from window.__said in order, so a test can speak phrases with pauses between them.
TONE_MICROPHONE = """(() => {
              const ctx = new AudioContext();
              const tone = ctx.createOscillator();
              const gain = ctx.createGain();
              gain.gain.value = 0;
              const out = ctx.createMediaStreamDestination();
              tone.connect(gain).connect(out);
              tone.start();
              ctx.resume();
              window.__speak = (on) => { gain.gain.value = on ? 0.4 : 0; };
              navigator.mediaDevices.getUserMedia = async () => out.stream;
              const said = window.__said || [];
              window.__sent = [];
              const real = window.fetch;
              window.fetch = async (url, init) => {
                if (String(url) !== "/dispatch/transcribe") return real(url, init);
                window.__sent.push(init.body.size);
                await new Promise((r) => setTimeout(r, 150));
                const text = said[window.__sent.length - 1] || "";
                return new Response(JSON.stringify({ text }), { status: 200, headers: { "Content-Type": "application/json" } });
              };
              return 0;
            })()"""
SHORT_CHAT = "browsertestshort"
LONG_CHAT = "browsertestlong0"
REVIEW_CHAT = "browserreview001"
REVIEW_AGAIN_CHAT = "browserreagain01"
SCAN_CHAT = "browserscan00001"
SHOT_FILE = "shotbrowsertest1.png"
PULL_CHAT = "browsertestpull0"
GITLAB_CHAT = "browsergitlab001"
LIMIT_CHAT = "browserlimit0001"
GROUP_CHAT = "browsergroup0001"
RESULTS_CHAT = "browserresults01"
MEMORY_CHAT = "browsermemory001"
MEMORY_OLD = "Run docker on hp"
MEMORY_NEW = "Always use the shared docker stack on hp"
SETTINGS_CHAT = "browsersettings1"
SETTINGS_EDIT_CHAT = "browsersettings2"
TASK_CHAT = "browsersavetask1"
NEW_TASK = "Standup notes"
PIPE_CHAT = "browserpipeline1"
COMMAND_CHAT = "browsercommands1"
RUNS_CHAT = "browserpiperuns1"
PROPOSAL_CHAT = "browserproposal1"
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
MERGE_SESSION = "hp-merge-test"
MERGE_BRANCH = "ready-to-merge"
READY_PR = {
    **FAKE_PR,
    "number": 34,
    "url": "https://github.com/acme/demo-app/pull/34",
    "title": "Add the merge button",
    "reviewDecision": "APPROVED",
    "headRefOid": "def456",
    "mergeable": "MERGEABLE",
    "baseRefName": "main",
    "statusCheckRollup": [
        {"__typename": "CheckRun", "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS",
         "detailsUrl": "https://github.com/acme/demo-app/actions/runs/333/job/444"},
    ],
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
if "-i" in args or "<file name=" in prompt:
    images, texts = args.count("-i"), prompt.count("<file name=")
    say({"type": "item.completed", "item": {"id": "item_0", "type": "agent_message",
         "text": f"I saw {images} image and {texts} text file."}})
elif resumed:
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
        "of": {"machine": MACHINE, "name": "hp-demo-app", "path": repo, "branch": "fix-login", "evidence": "browsershots",
               "pin": {"head": anchor["merge_base"], "top": repo}},
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


# Dispatch proposed new pipelines: ask the person, then fix.
def proposed_pipeline(chat, names):
    def define(name):
        return {
            "id": "", "name": name, "enabled": False, "version": 1,
            "trigger": {"kind": "manual"}, "start": "plan",
            "steps": [
                {"id": "plan", "name": "Plan", "kind": "plan", "machines": [], "max_runs": 2,
                 "next": {"pass": "ask", "fail": "wait", "needs_you": "wait"}, "x": -240, "y": 80},
                {"id": "ask", "name": "Ask me", "kind": "wait", "message": "Go ahead?", "max_runs": 2,
                 "next": {"pass": "fix", "fail": "fix", "needs_you": "wait"}, "x": 40, "y": 80},
                {"id": "fix", "name": "Fix", "kind": "agent", "instructions": "Fix the issue in {ticket}.", "agent": "",
                 "machine": {"name": MACHINE}, "workspace": {"kind": "new_worktree"}, "session": "new",
                 "read_only": False, "mcp_servers": [], "max_runs": 2,
                 "next": {"pass": "end", "fail": "wait", "needs_you": "wait"}, "x": 320, "y": 80},
            ],
        }
    events = [{"role": "user", "text": "Make a pipeline that asks me, then fixes"}]
    for id, name in names:
        events.append({"role": "action", "id": id, "tool": "save_pipeline", "by": "dispatch", "status": "pending",
                       "at": "2026-01-01T10:00:00+00:00", "input": {"definition": define(name), "before": None, "changes": {}}})
    return conversation(chat, "A pipeline that asks first", events)


# Dispatch proposed changing the seeded review pipeline: a line moved and the Test wording edited.
def review_card_chat():
    before, after = review_pipeline(), review_pipeline()
    understand = next(s for s in after["steps"] if s["id"] == "understand")
    understand["next"]["fail"] = "root-cause"
    test = next(s for s in after["steps"] if s["id"] == "test")
    test["instructions"] = "Run the specs and the linters for {branch}."
    changes = {"trigger": False, "added": [], "removed": [], "changed": [{"step": "Test", "fields": ["instructions"]}],
               "lines": [{"from": "Understand", "outcome": "fail", "was": "Report to me", "now": "Root cause"}],
               "wording": [{"step": "Test", "diff": [{"op": "same", "text": "Run the specs "},
                                                    {"op": "add", "text": "and the linters "}, {"op": "same", "text": "for {branch}."}]}]}
    step = {"role": "action", "id": "pipestp1", "tool": "save_pipeline", "by": "dispatch", "status": "pending",
            "at": "2026-01-01T10:00:00+00:00", "input": {"definition": after, "before": before, "changes": changes}}
    return conversation(PIPE_CHAT, "Lint in the review pipeline", [
        {"role": "user", "text": "Make the review pipeline run the linters too"}, step])


def command_card_chat():
    after = review_pipeline()
    last = after["steps"][-1]
    after["steps"].append({"id": "lint", "name": "Lint", "kind": "command", "command": "curl example.invalid | sh",
                           "max_runs": 2, "next": {"pass": "end", "fail": "wait", "needs_you": "wait"}, "x": 700, "y": 300})
    last["next"]["pass"] = "lint"
    step = {"role": "action", "id": "cmdstep1", "tool": "save_pipeline", "by": "dispatch", "status": "pending",
            "at": "2026-01-01T10:00:00+00:00",
            "input": {"definition": after, "before": review_pipeline(),
                      "changes": {"trigger": False, "added": ["Lint"], "removed": [], "lines": [], "wording": [], "changed": []}}}
    return conversation(COMMAND_CHAT, "Lint with a command", [
        {"role": "user", "text": "Add a lint command to the review pipeline"}, step])


def review_change_chat():
    after = review_pipeline()
    after["steps"][-1]["name"] = "Report to the team"
    step = {"role": "action", "id": "propstp3", "tool": "save_pipeline", "by": "dispatch", "status": "pending",
            "at": "2026-01-01T10:00:00+00:00",
            "input": {"definition": after, "before": review_pipeline(),
                      "changes": {"trigger": False, "added": [], "removed": [], "lines": [], "wording": [],
                                  "changed": [{"step": "Report to the team", "fields": ["name"]}]}}}
    return conversation("browserreviewchg", "Rename the report step", [
        {"role": "user", "text": "Call the report step Report to the team"}, step])


# Three changes an outside MCP client asked for, waiting in the Proposals inbox.
def inbox_proposals():
    before = {"agent_waiting": True, "machines": True, "memory": True, "session_ended": True, "wait_minutes": 2}
    head = '{\n  "agent_waiting": true,\n  "machines": true,\n  "memory": true,\n  "session_ended": true,\n  "wait_minutes": '
    def proposal(id, tool, input):
        return {"role": "action", "id": id, "tool": tool, "input": input, "status": "pending", "by": "client",
                "from": "claude-code", "at": "2026-01-01T10:00:00+00:00"}
    pipeline = proposed_pipeline("unused0000000000", (("x", "From the inbox"),))["events"][1]["input"]
    return [
        proposal("inbxphn1", "change_settings", {"area": "phone", "value": {**before, "wait_minutes": 15}, "before": before,
                                                 "diff": [{"op": "same", "text": head}, {"op": "del", "text": "2"},
                                                          {"op": "add", "text": "15"}, {"op": "same", "text": "\n}"}]}),
        proposal("inbxtsk1", "save_task", {"name": "Inbox task", "text": "Sum up my day.", "before": "",
                                           "diff": [{"op": "add", "text": "Sum up my day."}]}),
        proposal("inbxpip1", "save_pipeline", pipeline),
    ]


def run_steps_chat():
    def step(id, tool, input):
        return {"role": "action", "id": id, "tool": tool, "by": "dispatch", "status": "pending",
                "at": "2026-01-01T10:00:00+00:00", "input": input}
    return conversation(RUNS_CHAT, "Runs of the review pipeline", [
        {"role": "user", "text": "Run the review on !87 and clear the old run"},
        step("runstp01", "run_pipeline", {"id": "review", "name": "Review my merge requests", "tickets": [],
                                          "prs": ["https://git.example.com/acme/app/-/merge_requests/87"]}),
        step("ansstp01", "answer_run", {"id": "run-c", "action": "drop", "text": "",
                                        "pipeline": "Review my merge requests", "subject": "COM-1284 Login redirect",
                                        "waiting": {"kind": "needs_you", "step": "test", "reason": "Test needs you",
                                                    "screen": "rspec: 3 examples, 1 failure"}}),
    ])


# Linear's GraphQL API as the Pipeline page's ticket picker asks it: my open tickets.
LINEAR_TICKETS = [
    {"id": "u-12", "identifier": "COM-12", "title": "Redirect after login", "url": "https://linear.app/acme/issue/COM-12", "state": {"name": "Todo"}},
    {"id": "u-21", "identifier": "COM-21", "title": "Search by email", "url": "https://linear.app/acme/issue/COM-21", "state": {"name": "Todo"}},
    {"id": "u-22", "identifier": "COM-22", "title": "Export invoices", "url": "https://linear.app/acme/issue/COM-22", "state": {"name": "In Progress"}},
]


class FakeLinear(BaseHTTPRequestHandler):
    filters = []

    def do_POST(self):
        asked = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        wanted = asked.get("variables", {}).get("filter", {})
        FakeLinear.filters.append(wanted)
        nodes = LINEAR_TICKETS[:1] if wanted.get("labels") else LINEAR_TICKETS
        body = json.dumps({"data": {"viewer": {"assignedIssues": {"nodes": nodes}}}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


# Stands in for Hugging Face: no model is ever there, so Set up's download fails at once and the
# suite never fetches a real model.
class FakeModels(BaseHTTPRequestHandler):
    asked = []

    def do_GET(self):
        FakeModels.asked.append(self.path)
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

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


def pipeline_runs(root):
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
        "run-held": {**run("run-held", 80, "Slow export", "queued", "test",
                           [("understand", "pass", "Clear."), ("root-cause", "pass", "Yes.")]),
                     "slot": "nowhere",
                     "held": {"kind": "memory", "machine": "nowhere", "since": ago_stamp(45), "told": True,
                              "reason": "nowhere is short of memory: 93% is in use and the limit is 90%. This step starts once nowhere has stayed under the limit for two minutes."}},
        "run-d": {**run("run-d", 93, "Tokens spent", "waiting", "test",
                        [("understand", "pass", "Clear."), ("root-cause", "pass", "Yes.")],
                        {"kind": "token_limit", "step": "test",
                         "reason": "This run used 612,400 tokens, and its limit is 500,000"}),
                  "tokens": {"sources": {"nowhere:a.jsonl": {"input": 12400, "output": 100000, "cache_write": 500000,
                                                              "cache_read": 3000000}},
                             "limit": 500000, "raised": True}},
        # Finished on this machine, with a transcript the test writes, and a test that failed once.
        "run-f": {**run("run-f", 76, "Export timeout", "done", "",
                        [("understand", "pass", "The export times out after 30 seconds."),
                         ("root-cause", "pass", "The query loads every row."),
                         ("test", "pass", "Specs pass after the batch fix."),
                         ("report", "pass", "Ready to merge.")]),
                  "steps": {
                      "understand": {"runs": 1, "machine": MACHINE, "path": os.path.join(root, "demo-app"),
                                     "session": "hp-com-1276-run-f", "made": os.path.join(root, "demo-app"), "outcome": "pass",
                                     "report": "The export times out after 30 seconds.",
                                     "details": ["Repro: export 50k rows", "Risk: low"], "answer": "Use the staging data",
                                     "started": "2026-01-05T10:00:00+00:00", "ended": "2026-01-05T10:12:30+00:00"},
                      "root-cause": {"runs": 1, "machine": "nowhere", "outcome": "pass", "report": "The query loads every row.",
                                     "started": "2026-01-05T10:13:00+00:00", "ended": "2026-01-05T10:20:00+00:00"},
                      "test": {"runs": 2, "machine": "nowhere", "outcome": "pass", "report": "Specs pass after the batch fix.",
                               "started": "2026-01-05T10:40:00+00:00", "ended": "2026-01-05T10:50:00+00:00"},
                      "report": {"runs": 1, "outcome": "pass", "report": "Ready to merge.",
                                 "started": "2026-01-05T10:51:00+00:00", "ended": "2026-01-05T10:52:00+00:00"},
                  },
                  "history": [{"step": "", "at": "2026-01-05T09:59:00+00:00", "note": "started by a trigger"},
                              {"step": "understand", "outcome": "pass", "at": "2026-01-05T10:00:00+00:00"},
                              {"step": "root-cause", "outcome": "pass", "at": "2026-01-05T10:13:00+00:00"},
                              {"step": "test", "outcome": "fail", "at": "2026-01-05T10:21:00+00:00"},
                              {"step": "root-cause", "outcome": "pass", "at": "2026-01-05T10:30:00+00:00"},
                              {"step": "test", "outcome": "pass", "at": "2026-01-05T10:40:00+00:00"},
                              {"step": "report", "outcome": "pass", "at": "2026-01-05T10:51:00+00:00"}],
                  "definition": {**definition, "steps": [{**st, "agent": "claude"} if st["id"] == "understand" else st
                                                         for st in definition["steps"]]},
                  "report": "Export timeout: the batch fix is ready to merge.",
                  "tokens": {"sources": {f"{MACHINE}:t1.jsonl": {"input": 10, "output": 20}}}},
        "run-e": {**run("run-e", 94, "Tokens unknown", "waiting", "test",
                        [("understand", "pass", "Clear."), ("root-cause", "pass", "Yes.")],
                        {"kind": "token_unknown", "step": "test",
                         "reason": "Test runs on codex, which does not report tokens, so the limit of 500,000 tokens cannot be checked"}),
                  "tokens": {"sources": {"nowhere:a.jsonl": {"input": 1000, "output": 2000}},
                             "unknown": {"test": "Test runs on codex, which does not report tokens"},
                             "limit": 500000, "raised": True}},
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
        self.home = home
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
            json.dump(pipeline_runs(self.root), f)
        with open(os.path.join(self.state, "health.json"), "w") as f:
            json.dump({"run_waiting:run-a:root-cause:NeedsYou": {
                "check": "run_waiting", "title": "", "detail": "", "link": "", "since": ago_stamp(300), "notified": True,
            }}, f)
        with open(os.path.join(self.state, "proposals.json"), "w") as f:
            json.dump(inbox_proposals(), f)
        self.linear = ThreadingHTTPServer(("127.0.0.1", 0), FakeLinear)
        threading.Thread(target=self.linear.serve_forever, daemon=True).start()
        self.model_host = ThreadingHTTPServer(("127.0.0.1", 0), FakeModels)
        threading.Thread(target=self.model_host.serve_forever, daemon=True).start()
        self.models = os.path.join(home, ".local", "share", "yardbell", "models")
        # gh on the server's PATH answers for every branch with one failing pull request, except
        # one branch whose pull request is ready to merge; a merge is written down, not done.
        fake_bin = os.path.join(tmp, "bin")
        os.makedirs(fake_bin)
        self.fake_bin = fake_bin
        self.merges = os.path.join(tmp, "gh-merges.log")
        with open(os.path.join(fake_bin, "gh"), "w") as f:
            f.write(
                "#!/bin/sh\n"
                f"if [ \"$1 $2 $3\" = \"pr view {MERGE_BRANCH}\" ]; then\ncat <<'EOF'\n{json.dumps(READY_PR)}\nEOF\nexit 0\nfi\n"
                f"if [ \"$1 $2\" = \"pr view\" ]; then\ncat <<'EOF'\n{json.dumps(FAKE_PR)}\nEOF\nexit 0\nfi\n"
                f"if [ \"$1 $2\" = \"pr merge\" ]; then\necho \"$*\" >> {self.merges}\nexit 0\nfi\n"
                "exit 1\n"
            )
        os.chmod(os.path.join(fake_bin, "gh"), 0o755)
        # Voice input shells out to ffmpeg and whisper-cli; the fakes skip the conversion and
        # answer with a fixed transcription, so no real model or ffmpeg is needed.
        with open(os.path.join(fake_bin, "ffmpeg"), "w") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(fake_bin, "ffmpeg"), 0o755)
        with open(os.path.join(fake_bin, "whisper-cli"), "w") as f:
            f.write(f'#!/bin/sh\necho {json.dumps(FAKE_DICTATION)}\n')
        os.chmod(os.path.join(fake_bin, "whisper-cli"), 0o755)
        self.fake_claude = os.path.join(fake_bin, "claude")
        with open(self.fake_claude, "w") as f:
            f.write(FAKE_CLAUDE)
        os.chmod(self.fake_claude, 0o755)
        self.fake_codex = os.path.join(fake_bin, "codex")
        with open(self.fake_codex, "w") as f:
            f.write(FAKE_CODEX)
        os.chmod(self.fake_codex, 0o755)
        # Keep computer awake holds systemd-inhibit; the fake writes down how it was called and its
        # pid, then holds the command it was given, as the real one does.
        self.inhibits = os.path.join(tmp, "inhibit.log")
        with open(os.path.join(fake_bin, "systemd-inhibit"), "w") as f:
            f.write(
                "#!/bin/sh\n"
                f"echo \"$$ $*\" >> {self.inhibits}\n"
                "while [ \"${1#--}\" != \"$1\" ]; do shift; done\n"
                "exec \"$@\"\n"
            )
        os.chmod(os.path.join(fake_bin, "systemd-inhibit"), 0o755)
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
            "YARDBELL_MODELS_URL": f"http://127.0.0.1:{self.model_host.server_address[1]}",
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
        limit = conversation(LIMIT_CHAT, "Usage limit: demo-app", [{
            "role": "pull", "kind": "limit", "key": "limit:browser",
            "machine": MACHINE, "name": PULL_SESSION, "path": os.path.join(self.root, "demo-app"), "branch": "main",
            "folder": "demo-app", "error": "You've hit your limit · resets 3pm", "resets": "2026-01-01T15:00:00+00:00",
            "instruction": "continue", "at": "2026-01-01T15:00:30+00:00",
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
        review_again = conversation(REVIEW_AGAIN_CHAT, "Review the login fix again", [
            {"role": "user", "text": "Review the login fix"},
            {"role": "action", "id": "reagain1", "tool": "start_session", "by": "you", "status": "pending", "at": "2026-01-01T10:06:00+00:00",
             "input": {"machine": MACHINE, "path": repo, "prompt": "Review it.", "read_only": True},
             "review": {"machine": MACHINE, "name": "hp-demo-app", "path": repo, "branch": "fix-login"},
             "already": {"text": "Commit ab12cd3 already has a finished review, which said ready, by hp-demo-app-2.", "conversation": REVIEW_CHAT}},
        ])
        for chat in (short, long, review, review_again, pull, merge_request, limit, scan, group_chat(self.root), results_chat(self.root), memory_chat(), insight,
                     settings_chat(SETTINGS_CHAT, "setstep1", 7), settings_chat(SETTINGS_EDIT_CHAT, "setstep2", 9), task_chat(),
                     review_card_chat(), run_steps_chat(),
                     proposed_pipeline(PROPOSAL_CHAT, (("propstp1", "Built in the builder"),
                                                       ("propstp2", "Broken in the builder"))),
                     review_change_chat(), command_card_chat()):
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
            f"document.querySelector('#col-body .tree-machine [data-pick={json.dumps(MACHINE)}]')?.textContent.includes({json.dumps(MACHINE)})",
            "the machine in the column",
        )
        self.b.wait(
            f"document.querySelector('section.mgroup:not(.down) h2#mg-{MACHINE}')?.textContent === {json.dumps(MACHINE)}",
            "the machine on the dashboard, connected",
        )

    def test_dashboard_shows_what_looks_stuck(self):
        b = self.b
        b.goto(self.url("/"))
        b.wait(
            "document.querySelector('#health-banner:not([hidden]) .health-list a')?.getAttribute('href').includes('run=run-a')",
            "the stuck run on the dashboard",
        )
        said = b.js("document.getElementById('health-banner').textContent")
        for want in ("1 thing looks stuck", "is still waiting for you", "Root cause needs you", "5 h"):
            if want not in said:
                raise Failure(f"the banner does not say {want!r}: {said}")
        b.wait("document.querySelector('#rail [data-count=dashboard]')?.textContent === '1'", "the count on the rail")

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

    TERM_STORE = ("yardbell.term.keys", "yardbell.term.fontSize")

    # Opens the session's terminal at phone size. With record, input frames are kept in __in and
    # never reach the shell, so Ctrl-D and friends cannot end it.
    def phone_term(self, record=False):
        b = self.b
        if not self.session:
            path = os.path.join(self.y.root, "demo-app")
            self.session = self.api("POST", "/sessions", {"machine": MACHINE, "path": path, "wait": True})["name"]
        b.viewport(390, 844, 3)
        b.goto(self.url(f"/term/{MACHINE}/{self.session}"))
        b.wait("typeof term === 'object' && term.element && socket?.readyState === 1 && screenText().length > 0", "the phone terminal", timeout=15)
        b.wait("document.documentElement.classList.contains('touch-ui') && getComputedStyle(document.getElementById('keys')).display === 'flex'", "the key bar")
        if record:
            b.js("""(() => {
              window.__in = [];
              const s = socket;
              s.send = (d) => { const f = JSON.parse(d); if (f.t === 'in') window.__in.push(f.d); else WebSocket.prototype.send.call(s, d); };
              return true;
            })()""")
        b.click("#term")

    def leave_phone_term(self, before):
        self.b.viewport(1280, 800)
        self.put_storage(before)

    def sent(self, clear=True):
        got = self.b.js("window.__in.slice()")
        if clear:
            self.b.js("window.__in.length = 0")
        return got

    def test_phone_term_key_bar_sends_the_right_bytes(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        try:
            self.phone_term(record=True)
            want = {"esc": "\x1b", "tab": "\t", "stab": "\x1b[Z", "up": "\x1b[A", "down": "\x1b[B", "left": "\x1b[D",
                    "right": "\x1b[C", "slash": "/", "pipe": "|", "tilde": "~", "dash": "-", "enter": "\r",
                    "ctrlc": "\x03", "ctrld": "\x04"}
            for key, data in want.items():
                b.click(f"#keys-row [data-key={key}]")
                got = self.sent()
                if got != [data]:
                    raise Failure(f"the {key} key sent {got!r}, wanted {[data]!r}")
            if not b.js("document.activeElement === term.textarea"):
                raise Failure(f"pressing keys took the focus from the terminal: {b.js('document.activeElement.outerHTML.slice(0, 80)')}")
            b.click("#keys-more")
            b.wait("!document.getElementById('more-sheet').hidden", "the More keys sheet")
            for key, data in {"home": "\x1b[H", "pgdn": "\x1b[6~", "f1": "\x1bOP", "f5": "\x1b[15~", "ctrlr": "\x12", "del": "\x1b[3~"}.items():
                b.click(f"#more-keys [data-key={key}]")
                got = self.sent()
                if got != [data]:
                    raise Failure(f"the {key} key in More keys sent {got!r}, wanted {[data]!r}")
            b.click("#more-close")
            b.wait("document.getElementById('more-sheet').hidden", "the sheet to close")
            if not b.js("document.activeElement === term.textarea"):
                raise Failure("the More keys sheet took the focus from the terminal")
        finally:
            self.leave_phone_term(before)

    def double_tap(self, selector):
        p = self.b.centre(selector)
        tap = [{"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]
        self.b._actions({"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(p["x"]), "y": int(p["y"]), "origin": "viewport"}, *tap,
            {"type": "pause", "duration": 60}, *tap]})
        self.b.pump(0.2)

    def test_phone_term_sticky_and_locked_modifiers(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        latch = lambda key: b.js(f"document.querySelector('#keys-row [data-key={key}]').dataset.latch")
        try:
            self.phone_term(record=True)
            b.click("#keys-row [data-key=ctrl]")
            if latch("ctrl") != "once" or b.js("document.querySelector('#keys-row [data-key=ctrl]').getAttribute('aria-pressed')") != "true":
                raise Failure(f"one tap on Ctrl should arm it, it is {latch('ctrl')}")
            b.type("c")
            b.type("c")
            got = self.sent()
            if got != ["\x03", "c"]:
                raise Failure(f"an armed Ctrl with c typed twice sent {got!r}, wanted Ctrl-C then c")
            if latch("ctrl") != "off":
                raise Failure("Ctrl should release after one key")
            for keys, then, data in ((["ctrl"], "up", "\x1b[1;5A"), (["shift"], "tab", "\x1b[Z"), (["alt"], "left", "\x1b[1;3D"),
                                     (["ctrl", "alt"], "right", "\x1b[1;7C"), (["shift"], "slash", "/"), (["ctrl"], "pipe", "\x1c")):
                for k in keys:
                    b.click(f"#keys-row [data-key={k}]")
                b.click(f"#keys-row [data-key={then}]")
                got = self.sent()
                if got != [data]:
                    raise Failure(f"{'+'.join(keys)} then {then} sent {got!r}, wanted {[data]!r}")
            b.click("#keys-row [data-key=alt]")
            b.type("b")
            b.key("ArrowUp")
            got = self.sent()
            if got not in (["\x1bb", "\x1b[A"], ["\x1bb", "\x1bOA"]):
                raise Failure(f"Alt then a typed b and an arrow sent {got!r}")
            b.click("#keys-row [data-key=ctrl]")
            b.key("ArrowRight")
            if self.sent() != ["\x1b[1;5C"]:
                raise Failure("Ctrl then a typed arrow should send Ctrl-Right")
            b.click("#keys-row [data-key=shift]")
            b.type("q")
            if self.sent() != ["Q"]:
                raise Failure("Shift then a typed q should send Q")
            self.double_tap("#keys-row [data-key=ctrl]")
            if latch("ctrl") != "locked":
                raise Failure(f"a double tap on Ctrl should lock it, it is {latch('ctrl')}")
            b.type("ab")
            b.click("#keys-row [data-key=down]")
            got = self.sent()
            if got != ["\x01", "\x02", "\x1b[1;5B"]:
                raise Failure(f"a locked Ctrl sent {got!r}, wanted Ctrl-A, Ctrl-B and Ctrl-Down")
            if latch("ctrl") != "locked":
                raise Failure("a locked Ctrl released by itself")
            b.click("#keys-row [data-key=ctrl]")
            b.type("a")
            if latch("ctrl") != "off" or self.sent() != ["a"]:
                raise Failure("a tap on a locked Ctrl should release it")
        finally:
            self.leave_phone_term(before)

    def key_centre(self, key):
        self.b.js(f"document.querySelector('#keys-row [data-key={key}]').scrollIntoView({{ inline: 'center' }})")
        return self.b.centre(f"#keys-row [data-key={key}]")

    def test_phone_term_held_keys_repeat(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        try:
            self.phone_term(record=True)
            p = self.key_centre("up")
            b.drag_path([(p["x"], p["y"]), (p["x"], p["y"], 1000)])
            held = self.sent()
            if len(held) < 6 or set(held) != {"\x1b[A"}:
                raise Failure(f"holding the up arrow for a second sent {held!r}")
            b.click("#keys-row [data-key=up]")
            if self.sent() != ["\x1b[A"]:
                raise Failure("a quick tap on the up arrow should send it once")
            p = self.key_centre("enter")
            b.drag_path([(p["x"], p["y"]), (p["x"], p["y"], 900)])
            if self.sent() != ["\r"]:
                raise Failure("holding Enter should not repeat it")
        finally:
            self.leave_phone_term(before)

    def test_phone_term_more_sheet_edits_the_bar_and_remembers(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        bar = "[...document.querySelectorAll('#keys-row [data-key]')].map((k) => k.dataset.key)"
        try:
            self.put_storage({k: None for k in self.TERM_STORE})
            self.phone_term()
            default = b.js(bar)
            if default[:6] != ["esc", "tab", "stab", "ctrl", "alt", "shift"] or default[-3:] != ["ctrlc", "ctrld", "paste"]:
                raise Failure(f"the key bar starts as {default}")
            b.click("#keys-more")
            b.click("#more-edit")
            b.wait("!document.getElementById('more-editor').hidden && document.getElementById('more-body').hidden", "the bar editor")
            b.click('#edit-list li[data-id="paste"] [data-edit="up"]')
            b.click('#edit-list li[data-id="paste"] [data-edit="up"]')
            b.click('#edit-list li[data-id="alt"] input')
            b.click('#edit-list li[data-id="home"] input')
            want = [k for k in default if k not in ("alt", "paste")]
            want.insert(want.index("ctrlc"), "paste")
            want.append("home")
            if b.js(bar) != want:
                raise Failure(f"after editing, the bar is {b.js(bar)}, wanted {want}")
            if not b.js("Boolean(document.querySelector('#more-keys [data-key=alt]'))"):
                raise Failure("a key hidden from the bar should still be in More keys")
            b.goto(self.url(f"/term/{MACHINE}/{self.session}"))
            b.wait("document.querySelector('#keys-row [data-key]')", "the key bar again")
            if b.js(bar) != want:
                raise Failure(f"the edited bar was not remembered: {b.js(bar)}")
            b.click("#keys-more")
            b.click("#more-edit")
            b.click("#edit-reset")
            if b.js(bar) != default or b.js("localStorage.getItem('yardbell.term.keys')") is not None:
                raise Failure("Reset to default should bring the bar back and forget the edit")
        finally:
            self.leave_phone_term(before)

    # Firefox here has no touch input, so the pinch is driven through the calls the touch handler
    # makes: pinchStart, pinchMove with the fingers' scale, and pinchEnd on release.
    def test_phone_term_pinch_commits_to_a_text_size(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        try:
            self.put_storage({k: None for k in self.TERM_STORE})
            self.phone_term()
            start = b.js("({ size: term.options.fontSize, cols: term.cols, rows: term.rows })")
            b.js("(() => { const r = termEl.getBoundingClientRect(); pinchStart(r.left + 100, r.top + 200); pinchMove(1.37); return true; })()")
            live = b.js("({ transform: term.element.style.transform, size: term.options.fontSize })")
            if "scale(1.37)" not in live["transform"] or live["size"] != start["size"]:
                raise Failure(f"a pinch should scale the terminal live without changing the size yet: {live}")
            size = b.js("pinchEnd()")
            want = min([10, 11, 12, 13, 14, 16, 18, 20], key=lambda s: abs(s - start["size"] * 1.37))
            b.wait(f"term.options.fontSize === {want} && term.cols < {start['cols']} && term.rows < {start['rows']}", f"the grid to refit at {want}px")
            if size != want or b.js("term.element.style.transform") or b.js("localStorage.getItem('yardbell.term.fontSize')") != str(want):
                raise Failure(f"the pinch settled on {size}, wanted {want} saved with no scale left")
            b.click("#keys-more")
            b.click("#font-down")
            smaller = b.js("term.options.fontSize")
            if smaller >= want or b.js("document.getElementById('font-size').textContent") != f"{smaller} px":
                raise Failure(f"A- should step down from {want}px, it shows {smaller}")
            b.goto(self.url(f"/term/{MACHINE}/{self.session}"))
            b.wait(f"typeof term === 'object' && term.options.fontSize === {smaller}", "the text size to be remembered")
            b.js("(() => { pinchStart(100, 100); pinchMove(40); return true; })()")
            if b.js("pinchEnd()") != 20:
                raise Failure("a huge pinch should stop at the largest size")
        finally:
            self.leave_phone_term(before)

    def row_of(self, text):
        return self.b.wait(f"""(() => {{
          const buf = term.buffer.active;
          for (let y = buf.length - 1; y >= 0; y--) if (buf.getLine(y).translateToString(true).trim() === {json.dumps(text)}) return {{ y }};
          return null;
        }})()""", f"{text!r} on the screen", timeout=10)["y"]

    def cell_centre(self, col, row):
        return self.b.js(f"(() => {{ const s = screenBox(); return {{ x: s.left + ({col} + 0.5) * s.w, y: s.top + ({row} - term.buffer.active.viewportY + 0.5) * s.h }}; }})()")

    def test_phone_term_selection_mode_copies(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        try:
            self.phone_term()
            b.type("clear; echo sel''word another")
            b.key("Enter")
            y = self.row_of("selword another")
            p = self.cell_centre(2, y)
            b.js(f"startSelection({p['x']}, {p['y']})")
            if b.js("term.getSelection()") != "selword":
                raise Failure(f"a long press should select the word under it, got {b.js('term.getSelection()')!r}")
            shown = b.js("({ layer: !document.getElementById('sel-layer').hidden, menu: document.getElementById('sel-menu').checkVisibility(), handles: [...document.querySelectorAll('.sel-handle')].filter((h) => !h.hidden).length })")
            if shown != {"layer": True, "menu": True, "handles": 2}:
                raise Failure(f"selection mode should show both handles and the menu: {shown}")
            end = b.centre('.sel-handle[data-end="end"]')
            to = self.cell_centre(14, y)
            b.drag((end["x"], end["y"]), (to["x"] + 2, end["y"]))
            if b.js("term.getSelection()") != "selword another":
                raise Failure(f"dragging the end handle should extend the selection, got {b.js('term.getSelection()')!r}")
            b.js("window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; true")
            b.click('#sel-menu [data-sel="copy"]')
            b.wait("window.__copied.length === 1", "Copy to copy")
            if b.js("window.__copied[0]") != "selword another":
                raise Failure(f"Copy copied {b.js('window.__copied[0]')!r}")
            if not b.js("document.getElementById('sel-layer').hidden && !term.hasSelection()"):
                raise Failure("Copy should leave selection mode")
            b.click("#keys-more")
            b.click("#more-select")
            b.wait("sel.on && term.getSelection().trim().length > 0 && document.getElementById('more-sheet').hidden", "Select text to start selection mode")
            b.click('#sel-menu [data-sel="all"]')
            if "selword another" not in b.js("term.getSelection()"):
                raise Failure("Select all should take the whole screen")
            b.click('#sel-menu [data-sel="done"]')
            b.wait("!sel.on && !term.hasSelection()", "Done to leave selection mode")
            b.click("#keys-more")
            b.click("#more-text")
            b.wait("document.getElementById('text-view').classList.contains('show')", "the plain Copy text view from More keys")
            b.click("#text-close")
        finally:
            self.leave_phone_term(before)

    def test_phone_term_links_are_tappable(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        try:
            self.phone_term()
            b.type("clear; echo see https://example.com/a?b''=1. now")
            b.key("Enter")
            y = self.row_of("see https://example.com/a?b=1. now")
            links = b.js(f"linksOn({y}).map((l) => [l.url, l.start.x, l.end.x])")
            if links != [["https://example.com/a?b=1", 4, 28]]:
                raise Failure(f"the link on the line was found as {links}")
            b.js("window.__opened = []; window.open = (url, target) => { window.__opened.push([url, target]); return null; }; true")
            on, off = self.cell_centre(10, y), self.cell_centre(1, y)
            if b.js(f"tapAt({off['x']}, {off['y']})") or b.js("window.__opened.length"):
                raise Failure("a tap beside the link should not open anything")
            if not b.js(f"tapAt({on['x']}, {on['y']})"):
                raise Failure("a tap on the link should open it")
            if b.js("window.__opened") != [["https://example.com/a?b=1", "_blank"]]:
                raise Failure(f"the tap opened {b.js('window.__opened')}")
        finally:
            self.leave_phone_term(before)

    def test_phone_term_keyboard_keeps_the_grid(self):
        b = self.b
        before = self.storage(self.TERM_STORE)
        try:
            self.phone_term()
            b.type("clear; seq 1 80")
            b.key("Enter")
            self.row_of("80")
            b.pump(0.5)
            start = b.js("({ rows: term.rows, cols: term.cols })")
            # Android Chrome makes the page shorter when the keyboard opens.
            b.viewport(390, 520, 3)
            b.wait("kept && lift > 0", "the grid kept and lifted while typing", timeout=5)
            seen = b.js("""({ rows: term.rows, cols: term.cols, kbOpen: document.documentElement.classList.contains('kb-open'),
              keys: Math.round(document.getElementById('keys').getBoundingClientRect().bottom), height: innerHeight,
              cursor: Math.round(document.querySelector('.xterm-screen').getBoundingClientRect().top + (term.buffer.active.cursorY + 1) * screenBox().h),
              above: Math.round(document.getElementById('term-bottom').getBoundingClientRect().top) })""")
            if seen["rows"] != start["rows"] or seen["cols"] != start["cols"] or not seen["kbOpen"]:
                raise Failure(f"the keyboard should not resize the grid: {start} then {seen}")
            if seen["keys"] != seen["height"] or seen["cursor"] > seen["above"]:
                raise Failure(f"the key bar should sit on the keyboard with the cursor row above it: {seen}")
            b.viewport(390, 844, 3)
            b.wait(f"!kept && lift === 0 && term.rows === {start['rows']}", "the keyboard closing to put the terminal back", timeout=5)
            b.viewport(700, 390, 3)
            b.wait(f"!kept && term.cols > {start['cols']} && term.rows < {start['rows']}", "turning the phone to refit the grid", timeout=5)
        finally:
            self.leave_phone_term(before)

    def test_term_desktop_has_no_key_bar(self):
        b = self.b
        if not self.session:
            path = os.path.join(self.y.root, "demo-app")
            self.session = self.api("POST", "/sessions", {"machine": MACHINE, "path": path, "wait": True})["name"]
        b.goto(self.url(f"/term/{MACHINE}/{self.session}"))
        b.wait("typeof term === 'object' && term.element", "the terminal")
        if b.js("document.documentElement.classList.contains('touch-ui') || getComputedStyle(document.getElementById('keys')).display !== 'none'"):
            raise Failure("a desktop terminal shows the key bar")

    def test_tree_groups_worktrees_under_their_repo(self):
        b = self.b
        b.goto(self.url("/workspace"))
        b.wait("typeof YardbellTree === 'object'", "the tree script")
        got = b.js("""(() => {
          const s = (tmux, folder) => ({ machine: 'hp', tmux, folder, attachable: true });
          const state = {
            machines: [{ name: 'hp', up: true }, { name: 'box', up: false, reason: 'ssh: timed out' }],
            folders: [],
            sessions: [
              s('a', '/home/u/code/app'),
              s('b', '/home/u/code/app-worktrees/eng-1-a'),
              s('c', '/home/u/notes'),
            ],
          };
          const tree = YardbellTree.build(state, { stateOf: () => 'idle' });
          const hp = tree.find((m) => m.name === 'hp');
          const box = tree.find((m) => m.name === 'box');
          return {
            repos: hp.repos.map((r) => r.label),
            worktrees: hp.repos[0].worktrees.map((w) => w.label),
            boxUp: box.up, boxRepos: box.repos.length,
            reason: box.reason,
            wt: YardbellTree.repoOf('/r/app-worktrees/x'),
            plain: YardbellTree.repoOf('/r/app'),
          };
        })()""")
        want = {
            "repos": ["~/code/app", "~/notes"],
            "worktrees": ["~/code/app", "~/code/app-worktrees/eng-1-a"],
            "boxUp": False, "boxRepos": 0, "reason": "ssh: timed out",
            "wt": "/r/app", "plain": "/r/app",
        }
        if got != want:
            raise Failure(f"the tree built {got}, wanted {want}")
        rows = b.js("""(() => {
          const hour = 3600 * 1000;
          const s = (tmux, extra) => ({ machine: 'hp', tmux, folder: '/home/u/code/app', attachable: true, agent: 'claude', ...extra });
          const state = {
            machines: [{ name: 'hp', up: true }],
            folders: [],
            agents: [{ name: 'claude', label: 'Claude Code' }],
            sessions: [
              s('a', { ticket: 'ENG-142' }),
              s('b', { ticket: '-', resets: new Date(Date.now() + hour).toISOString() }),
              s('c', { agent: 'aider', resets: new Date(Date.now() - hour).toISOString() }),
              s('d', { activity: 'blocked' }),
            ],
          };
          const facts = (phone) => {
            const el = document.createElement('div');
            YardbellTree.render(el, state, { stateOf: (x) => x.activity || 'idle', phone });
            return [...el.querySelectorAll('.tree-session')].map((r) => ({
              name: r.querySelector('.tree-name').textContent,
              end: [...r.querySelectorAll('.tree-fact, .tree-age, .tree-pr')].map((f) => f.className.split(' ')[0] + ':' + f.textContent),
            }));
          };
          return { phone: facts(true), desk: facts(false) };
        })()""")
        names = [r["name"] for r in rows["phone"]]
        if names != ["ENG-142 · Claude Code", "Claude Code", "aider", "Claude Code"] or names != [r["name"] for r in rows["desk"]]:
            raise Failure(f"session rows should read the agent with the ticket in front: {rows}")
        ends = [r["end"] for r in rows["phone"]]
        if ends[0] != ["tree-age:"] or len(ends[1]) != 1 or not ends[1][0].startswith("tree-fact:limit ") or ends[2] != ["tree-age:"] or ends[3] != ["tree-fact:needs you"]:
            raise Failure(f"the phone's one fact is wrong, a past reset must not show as a limit: {ends}")
        if any(f.startswith("tree-fact") for r in rows["desk"] for f in r["end"]):
            raise Failure(f"the desktop rows grew a phone fact: {rows['desk']}")

    def test_tree_marks_changes_until_looked_at(self):
        b = self.b
        keys = [f"{MACHINE}/hp-demo-api-{i}" for i in (1, 2)]
        row = lambda key: f"document.querySelector('#col-body [data-key={json.dumps(key)}]')"
        bold = lambda key: f"{row(key)} && getComputedStyle({row(key)}).fontWeight >= 600"
        for key in keys:
            r = self.y.tmux("new", "-d", "-s", key.split("/", 1)[1], "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
            if r.returncode:
                raise Failure(f"tmux new failed: {r.stderr}")
        try:
            self.api("POST", "/refresh")
            b.goto(self.url("/workspace"))
            b.js("localStorage.removeItem('yardbell.tree.seen')")
            b.goto(self.url("/workspace"))
            for key in keys:
                b.wait(row(key), "the session in the tree", timeout=15)
            b.wait("localStorage.getItem('yardbell.tree.seen') !== null", "the seen map")
            if any(b.js(bold(key)) for key in keys):
                raise Failure("a session that was there on first load is bold")
            ages = b.js("[...document.querySelectorAll('#col-body .tree-session .tree-age')].map((e) => e.textContent)")
            if any(ages):
                raise Failure(f"a freshly loaded session shows an age: {ages}")
            b.js(f"localStorage.setItem('yardbell.tree.seen', JSON.stringify({{{json.dumps(keys[0])}: 'working', {json.dumps(keys[1])}: 'working'}}))")
            shown = b.js("[...visibleKeys()]")
            hidden = [k for k in keys if k not in shown]
            if not shown or not hidden:
                raise Failure(f"expected one visible and one hidden session, got {shown}")
            watched, away = shown[0], hidden[0]
            b.wait(bold(away), "the row of a session out of sight to turn bold", timeout=15)
            b.wait(f"!({bold(watched)})", "the row of a session in view to stay plain", timeout=15)
            b.click(f"#col-body [data-key={json.dumps(away)}]")
            b.wait(f"!({bold(away)})", "the row to stop being bold once opened")
            same = b.js(f"JSON.parse(localStorage.getItem('yardbell.tree.seen'))[{json.dumps(away)}] === {row(away)}.dataset.state")
            if not same:
                raise Failure("the stored state is not the row's state")
        finally:
            self.drop_grid_tab(keys)

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
            b.click("#col-body [data-folder$='demo-api']")
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

    # Four shell sessions, each in its own tab, with the saved layout wiped so earlier tests
    # cannot shape it. Returns their keys.
    def grid_tab(self):
        b = self.b
        folder = os.path.join(self.y.root, "demo-app")
        keys = [f"{MACHINE}/hp-grid-{i}" for i in range(1, 5)]
        for key in keys:
            self.y.tmux("new", "-d", "-s", key.split("/", 1)[1], "-c", folder, self.y.shell)
        b.goto(self.url("/workspace"))
        self.api("POST", "/refresh")
        b.wait(
            f"typeof leaves === 'function' && {json.dumps(keys)}.every((k) => (state?.sessions || []).some((s) => s.machine + '/' + s.tmux === k))",
            "the workspace to see the grid sessions", timeout=15,
        )
        b.js("(() => { saved.tabs = []; saved.hidden = []; saved.tab = 0; render(); })()")
        b.wait(
            f"{json.dumps(keys)}.every((k) => saved.tabs.some((t) => leaves(t.root).some((l) => l.key === k)))",
            "a tab per grid session",
        )
        return keys

    # Later tests count the sessions in demo-app and revisit the Workspace, so the grid sessions
    # cannot outlive their test, in tmux or in the saved layout.
    def drop_grid_tab(self, keys):
        if self.b.js("location.pathname === '/workspace' && typeof detach === 'function'"):
            self.b.js(f"""(() => {{
              for (const k of {json.dumps(keys)}) {{
                saved.hidden.push(k);
                detach(saved, k);
              }}
              save();
              render();
            }})()""")
        self.b.goto(self.url("/"))
        for key in keys:
            self.y.tmux("kill-session", "-t", f"={key.split('/', 1)[1]}")
        self.api("POST", "/refresh")
        self.b.wait(
            f"fetch('/state', {{headers: {{Accept: 'application/json'}}}}).then((r) => r.json()).then((s) => !s.sessions.some((x) => {json.dumps(keys)}.includes(x.machine + '/' + x.tmux)))",
            "the grid sessions to be gone",
        )

    def merge_grid_tabs(self, keys, total=None):
        self.b.js(f"""(() => {{
          const at = (k) => saved.tabs.findIndex((t) => leaves(t.root).some((l) => l.key === k));
          for (const k of {json.dumps(keys[1:])}) mergeTab(at(k), at({json.dumps(keys[0])}));
        }})()""")
        self.b.wait(f"leaves(tab().root).length === {total or len(keys)}", "the merged tab to show every pane")

    def pane_boxes(self):
        return self.b.js("""(() => {
          const area = document.getElementById('panes').getBoundingClientRect();
          return [...document.querySelectorAll('.ws-pane:not([hidden])')].map((el) => {
            const r = el.getBoundingClientRect();
            return {key: el.querySelector('iframe')?.dataset.key || null,
                    x: (r.left - area.left) / area.width, y: (r.top - area.top) / area.height,
                    w: r.width / area.width, h: r.height / area.height};
          });
        })()""")

    def pane_point(self, key, selector=".ws-pane-title"):
        p = self.b.wait(
            f"""(() => {{
              const f = document.querySelector('iframe[data-key="{key}"]');
              const el = f && f.closest('.ws-pane').querySelector({json.dumps(selector)});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return r.width ? {{x: r.left + r.width / 2, y: r.top + r.height / 2}} : null;
            }})()""",
            f"the pane for {key}",
        )
        return (p["x"], p["y"])

    def test_workspace_panes_balance_into_a_grid(self):
        b = self.b
        keys = self.grid_tab()
        try:
            self.balance_into_a_grid(keys)
        finally:
            self.drop_grid_tab(keys)

    def balance_into_a_grid(self, keys):
        b = self.b
        # The first merge goes through the tab's right-click menu; the rest call it directly.
        b.js(f"""(() => {{
          const at = (k) => saved.tabs.findIndex((t) => leaves(t.root).some((l) => l.key === k));
          const t = document.querySelector(`#tabs [data-tab="${{at({json.dumps(keys[1])})}}"]`);
          const r = t.getBoundingClientRect();
          t.dispatchEvent(new MouseEvent("contextmenu", {{bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.bottom - 4}}));
        }})()""")
        b.wait("document.getElementById('ws-menu') && !document.getElementById('ws-menu').hidden", "the tab menu")
        moved = b.js(f"""(() => {{
          const at = (k) => saved.tabs.findIndex((t) => leaves(t.root).some((l) => l.key === k));
          const name = saved.tabs[at({json.dumps(keys[0])})].name;
          const hit = [...document.querySelectorAll('#ws-menu [role=menuitem]')].find((m) => m.textContent.trim() === 'Move into ' + name);
          if (hit) hit.click();
          return Boolean(hit);
        }})()""")
        if not moved:
            raise Failure("the tab menu has no Move into item")
        b.wait("leaves(tab().root).length === 2", "two panes after the merge")
        self.merge_grid_tabs([keys[0], *keys[2:]], total=4)
        boxes = {p["key"]: p for p in self.pane_boxes()}
        if len(boxes) != 4:
            raise Failure(f"four visible panes expected: {sorted(boxes)}")
        want = dict(zip(keys, ((0, 0), (1, 0), (0, 1), (1, 1))))
        for key, p in boxes.items():
            if abs(p["w"] - 0.5) > 0.02 or abs(p["h"] - 0.5) > 0.02:
                raise Failure(f"a 2x2 grid should give {key} half the area: {p}")
            if (round(p["x"] * 2), round(p["y"] * 2)) != want[key]:
                raise Failure(f"{key} should sit at {want[key]} of the 2x2 grid: {p}")
        pane = b.js(f"leaves(tab().root).find((l) => l.key === {json.dumps(keys[3])}).pane")
        self.pane_menu_pick(f'.ws-pane[data-pane="{pane}"]', "Close")
        b.wait("leaves(tab().root).length === 3", "three panes after closing one")
        boxes = {p["key"]: p for p in self.pane_boxes()}
        for key, (x, w) in ((keys[0], (0, 0.5)), (keys[1], (0.5, 0.5))):
            p = boxes[key]
            if abs(p["x"] - x) > 0.02 or abs(p["w"] - w) > 0.02 or round(p["y"] * 2) != 0:
                raise Failure(f"{key} should keep half of the top row: {p}")
        p = boxes[keys[2]]
        if abs(p["w"] - 1) > 0.02 or abs(p["h"] - 0.5) > 0.02 or round(p["y"] * 2) != 1:
            raise Failure(f"{keys[2]} should take the whole bottom row: {p}")

    def test_workspace_panes_move_by_drag_and_swap_menu(self):
        b = self.b
        keys = self.grid_tab()
        try:
            self.move_by_drag_and_swap_menu(keys)
        finally:
            self.drop_grid_tab(keys)

    def move_by_drag_and_swap_menu(self, keys):
        b = self.b
        self.merge_grid_tabs(keys)
        b.drag(self.pane_point(keys[0]), self.pane_point(keys[3]))
        order = b.js("leaves(tab().root).map((l) => l.key)")
        if order != [keys[3], keys[1], keys[2], keys[0]]:
            raise Failure(f"dragging pane 1 onto pane 4 should swap their places: {order}")
        pane = b.js(f"leaves(tab().root).find((l) => l.key === {json.dumps(keys[0])}).pane")
        b.click(f'.ws-pane[data-pane="{pane}"] [data-act="more"]')
        b.wait("document.getElementById('ws-menu') && !document.getElementById('ws-menu').hidden", "the pane menu")
        swapped = b.js("""(() => {
          const hit = [...document.querySelectorAll('#ws-menu [role=menuitem]')].find((m) => m.textContent.includes('Swap with 1'));
          if (hit) hit.click();
          return Boolean(hit);
        })()""")
        if not swapped:
            raise Failure("the pane menu has no Swap with item")
        order = b.js("leaves(tab().root).map((l) => l.key)")
        if order != keys:
            raise Failure(f"Swap with 1 should put the panes back in reading order: {order}")

    # Every grid session back in a tab of its own, with the tab of the first one showing. Other
    # sessions earlier tests left running are hidden, so the counts below are the grid's alone.
    def own_tabs(self, keys):
        self.b.js(f"(() => {{ saved.tabs = []; saved.hidden = sessions().map(keyOf).filter((k) => !{json.dumps(keys)}.includes(k)); saved.tab = 0; render(); }})()")
        self.b.wait(
            f"saved.tabs.length === {len(keys)} && {json.dumps(keys)}.every((k) => saved.tabs.some((t) => leaves(t.root).length === 1 && leaves(t.root)[0].key === k))",
            "a tab per grid session",
        )
        self.b.js(f"switchTab(saved.tabs.findIndex((t) => leaves(t.root)[0].key === {json.dumps(keys[0])}))")
        self.b.wait(f"leaves(tab().root)[0].key === {json.dumps(keys[0])} && !document.querySelector('.ws-pane[data-pane=\"' + tab().root.pane + '\"]').hidden", "the first grid tab")

    def tab_point(self, key, at="centre"):
        p = self.b.wait(
            f"""(() => {{
              const i = saved.tabs.findIndex((t) => leaves(t.root).some((l) => l.key === {json.dumps(key)}));
              const el = document.querySelector(`#tabs .ws-tab[data-tab="${{i}}"]`);
              if (!el) return null;
              el.scrollIntoView({{block: "nearest", inline: "nearest"}});
              const r = el.getBoundingClientRect();
              return r.width ? {{x: {"r.left + 6" if at == "start" else "r.left + r.width / 2"}, y: r.top + r.height / 2}} : null;
            }})()""",
            f"the tab holding {key}",
        )
        return (p["x"], p["y"])

    # A point in a pane's body: near one edge, or in the middle for "centre".
    def zone_point(self, key, zone):
        p = self.b.wait(
            f"""(() => {{
              const leaf = leaves(tab().root).find((l) => l.key === {json.dumps(key)});
              const el = leaf && document.querySelector(`.ws-pane[data-pane="${{leaf.pane}}"]`);
              if (!el || el.hidden) return null;
              const r = el.getBoundingClientRect();
              const top = el.querySelector('.ws-pane-head').getBoundingClientRect().bottom;
              const mid = {{x: (r.left + r.right) / 2, y: (top + r.bottom) / 2}};
              return {{left: {{x: r.left + 12, y: mid.y}}, right: {{x: r.right - 12, y: mid.y}},
                       top: {{x: mid.x, y: top + 12}}, bottom: {{x: mid.x, y: r.bottom - 12}}, centre: mid}}[{json.dumps(zone)}];
            }})()""",
            f"the pane for {key} in the shown tab",
        )
        return (p["x"], p["y"])

    def tab_keys(self):
        return self.b.js("saved.tabs.map((t) => leaves(t.root).map((l) => l.key))")

    def end_docking(self, keys):
        if self.b.js("location.pathname === '/workspace' && typeof saved === 'object'"):
            self.b.js("(() => { saved.hidden = []; save(); })()")
        self.drop_grid_tab(keys)

    def test_workspace_tab_docks_by_drag(self):
        keys = self.grid_tab()
        try:
            self.tab_docks_by_drag(keys)
        finally:
            self.end_docking(keys)

    def tab_docks_by_drag(self, keys):
        b = self.b
        k1, k2, k3, k4 = keys
        self.own_tabs(keys)
        shown = b.js("tab().id")
        before = self.tab_keys()
        last = before[-1][0]
        b.drag_path([self.tab_point(last), self.tab_point(before[0][0], at="start")])
        after = self.tab_keys()
        if after != [before[-1], *before[:-1]]:
            raise Failure(f"dropping the last tab before the first should move it there: {before} -> {after}")
        if b.js("tab().id") != shown:
            raise Failure("reordering the tabs changed which tab is shown")

        want = {"left": ("row", [k2, k1]), "right": ("row", [k1, k2]), "top": ("col", [k2, k1]), "bottom": ("col", [k1, k2])}
        for zone, (split, order) in want.items():
            self.own_tabs(keys)
            b.drag_path([self.tab_point(k2), self.zone_point(k1, zone)])
            got = b.js("({split: tab().root.split, ratio: tab().root.ratio, order: leaves(tab().root).map((l) => l.key), tabs: saved.tabs.length, focus: focusedLeaf().key})")
            if got != {"split": split, "ratio": 0.5, "order": order, "tabs": 3, "focus": k2}:
                raise Failure(f"a tab dropped on the {zone} edge should split {split} as {order}, focused, its own tab gone: {got}")

        self.own_tabs(keys)
        b.drag_path([self.tab_point(k2), self.zone_point(k1, "centre")])
        if b.js("leaves(tab().root).map((l) => l.key)") != [k2] or [k1] not in self.tab_keys() or len(self.tab_keys()) != 4:
            raise Failure(f"a one-pane tab dropped on a pane's centre should swap with it: {self.tab_keys()}")

        self.own_tabs(keys)
        b.drag_path([self.tab_point(k3), (*self.tab_point(k2), 900), self.zone_point(k1, "right")])
        got = b.js("({split: tab().root.split, order: leaves(tab().root).map((l) => l.key)})")
        if got != {"split": "row", "order": [k2, k3]}:
            raise Failure(f"hovering a tab should switch to it, and the drop should land in its panes: {got} {self.tab_keys()}")
        b.js(f"switchTab(saved.tabs.findIndex((t) => leaves(t.root)[0].key === {json.dumps(k4)}))")
        b.drag_path([self.tab_point(k2), self.zone_point(k4, "centre")])
        if b.js("leaves(tab().root).map((l) => l.key)") != [k4, k2, k3] or len(self.tab_keys()) != 2:
            raise Failure(f"a tab of several panes dropped on a centre should merge into the tab: {self.tab_keys()}")

        self.own_tabs(keys)
        b.drag_path([self.tab_point(k2), self.zone_point(k1, "left"), {"key": "Escape"}])
        left = b.js("({tabs: saved.tabs.length, root: tab().root.key, ghost: document.querySelectorAll('.ws-dock-ghost, .ws-dock-preview, .ws-dock-mark').length, docking: document.body.classList.contains('ws-docking')})")
        if left != {"tabs": 4, "root": k1, "ghost": 0, "docking": False}:
            raise Failure(f"Esc should cancel the drag and leave the layout alone: {left}")

        b.drag_path([self.tab_point(k2), self.zone_point(k1, "bottom")])
        b.goto(self.url("/workspace"))
        b.wait(f"typeof leaves === 'function' && saved.tabs.some((t) => leaves(t.root).length === 2) && (state?.sessions || []).length > 0", "the workspace after a reload")
        kept = b.js(f"""(() => {{
          const t = saved.tabs.find((x) => leaves(x.root).some((l) => l.key === {json.dumps(k1)}));
          return {{split: t.root.split, order: leaves(t.root).map((l) => l.key), stored: JSON.parse(localStorage.getItem('workspace.v5')).tabs.length}};
        }})()""")
        if kept != {"split": "col", "order": [k1, k2], "stored": 3}:
            raise Failure(f"the docked layout should survive a reload: {kept}")

    def test_workspace_pane_docks_by_drag(self):
        keys = self.grid_tab()
        try:
            self.pane_docks_by_drag(keys)
        finally:
            self.end_docking(keys)

    def pane_docks_by_drag(self, keys):
        b = self.b
        k1, k2, k3, k4 = keys
        self.own_tabs(keys)
        self.merge_grid_tabs(keys)
        b.drag_path([self.pane_point(k4), self.zone_point(k1, "left")])
        got = b.js(f"""(() => {{
          const leaf = leaves(tab().root).find((l) => l.key === {json.dumps(k1)});
          const p = parentOf(tab().root, leaf);
          return {{order: leaves(tab().root).map((l) => l.key), split: p.split, ratio: p.ratio, first: p.a.key, focus: focusedLeaf().key}};
        }})()""")
        if got != {"order": [k4, k1, k2, k3], "split": "row", "ratio": 0.5, "first": k4, "focus": k4}:
            raise Failure(f"a pane dropped on the left edge of another should sit to its left: {got}")

        strip = b.js("""(() => {
          const s = document.getElementById('tabs').getBoundingClientRect();
          const last = [...document.querySelectorAll('#tabs .ws-tab')].pop().getBoundingClientRect();
          return {x: last.right + 12, y: s.top + s.height / 2};
        })()""")
        b.drag_path([self.pane_point(k2), (strip["x"], strip["y"])])
        got = {"tabs": self.tab_keys(), "shown": b.js("leaves(tab().root).map((l) => l.key)")}
        if got != {"tabs": [[k4, k1, k3], [k2]], "shown": [k2]}:
            raise Failure(f"a pane dropped on the tab strip should become a tab of its own there: {got}")

    def test_workspace_tree_session_docks_by_drag(self):
        keys = self.grid_tab()
        try:
            self.tree_session_docks_by_drag(keys)
        finally:
            self.end_docking(keys)

    def tree_row(self, key):
        p = self.b.wait(
            f"""(() => {{
              const el = document.querySelector('#col-body .tree-session[data-key={json.dumps(key)}]');
              if (!el) return null;
              el.scrollIntoView({{block: "nearest"}});
              const r = el.getBoundingClientRect();
              return r.width ? {{x: r.left + r.width / 2, y: r.top + r.height / 2}} : null;
            }})()""",
            f"the tree row for {key}",
        )
        return (p["x"], p["y"])

    def tree_session_docks_by_drag(self, keys):
        b = self.b
        k1, k2, k3, k4 = keys
        self.own_tabs(keys)
        b.drag_path([self.tree_row(k2), self.zone_point(k1, "bottom")])
        got = b.js("({split: tab().root.split, order: leaves(tab().root).map((l) => l.key), tabs: saved.tabs.length, focus: focusedLeaf().key})")
        if got != {"split": "col", "order": [k1, k2], "tabs": 3, "focus": k2}:
            raise Failure(f"a session dragged from the tree onto a bottom edge should open below it: {got}")

        b.drag_path([self.tree_row(k1), self.zone_point(k2, "right")])
        got = b.js(f"({{split: tab().root.split, order: leaves(tab().root).map((l) => l.key), copies: saved.tabs.flatMap((t) => leaves(t.root)).filter((l) => l.key === {json.dumps(k1)}).length}})")
        if got != {"split": "row", "order": [k2, k1], "copies": 1}:
            raise Failure(f"a session already open in the tab should move, not open twice: {got}")

        b.drag_path([self.tree_row(k3), self.tab_point(self.tab_keys()[0][0], at="start")])
        got = {"first": self.tab_keys()[0], "shown": b.js("leaves(tab().root).map((l) => l.key)")}
        if got != {"first": [k3], "shown": [k3]}:
            raise Failure(f"a session dropped on the tab strip should show in a tab there: {got}")

    def menu(self, path):
        self.b.goto(self.url(path))
        self.b.wait("document.querySelector('[data-theme-toggle] .theme-word')", f"the menu on {path}")
        return self.b.js(
            """document.getElementById('rail')
                 ? [...document.querySelectorAll('#rail .rail-link')].map((el) => el.matches('[data-theme-toggle]') ? 'theme' : el.title)
                 : [...document.querySelectorAll('.side-foot .side-link')]
                     .map((el) => el.matches('[data-theme-toggle]') ? 'theme'
                       : [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim())"""
        )

    def test_workspace_uses_the_shell(self):
        b = self.b
        b.goto(self.url("/workspace"))
        b.wait("document.querySelector('#col-body .tree')", "the tree in the shell's column")
        rail = b.js("""(() => ({
          pages: [...document.querySelectorAll('#rail a.rail-link')].map((a) => a.title),
          current: document.querySelector('#rail [aria-current=page]')?.title,
          side: document.querySelector('.ws-side') !== null,
        }))()""")
        want = ["Dashboard", "Workspace", "Pipelines", "Diagrams", "Dispatch", "Proposals", "Settings"]
        if rail["pages"] != want:
            raise Failure(f"the rail reads {rail['pages']}")
        if rail["current"] != "Workspace":
            raise Failure(f"the rail marks {rail['current']!r} as the current page")
        if rail["side"]:
            raise Failure("the old Workspace sidebar is still on the page")
        if b.js("document.getElementById('ws-dispatch') || document.getElementById('dispatch-toggle')"):
            raise Failure("the old Dispatch panel is still on the page")
        b.click(".col-nav [data-page=dispatch]")
        b.wait("document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')", "the rail's Dispatch to open a Dispatch pane")
        if b.js("location.pathname") != "/workspace":
            raise Failure("the rail's Dispatch left the Workspace")
        self.pane_menu_pick(".ws-pane:has(iframe[data-dispatch])", "Close")
        b.wait("!document.querySelector('iframe[data-dispatch]')", "the Dispatch pane to close")
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('#tabbar .tab')", "the phone tabs")
            b.pump(0.4)
            seen = b.js("""(() => {
              const bar = document.getElementById('tabbar');
              return {
                shown: bar.getClientRects().length > 0,
                labels: [...bar.querySelectorAll('.tab')].map((t) => t.querySelector('.tab-label').textContent),
                bottom: Math.round(bar.getBoundingClientRect().bottom), height: innerHeight,
                sideways: document.documentElement.scrollWidth > innerWidth,
              };
            })()""")
            if not seen["shown"]:
                raise Failure("the phone tabs are hidden")
            if seen["labels"] != ["Sessions", "Board", "Pipelines", "Dispatch", "More"]:
                raise Failure(f"the phone tabs read {seen['labels']}")
            if abs(seen["bottom"] - seen["height"]) > 1:
                raise Failure(f"the phone tabs are not along the bottom: {seen}")
            if seen["sideways"]:
                raise Failure("the Workspace scrolls sideways on a phone")
            key = f"{MACHINE}/hp-shell-phone"
            self.y.tmux("new", "-d", "-s", key.split("/", 1)[1], "-c", os.path.join(self.y.root, "demo-app"), self.y.shell)
            try:
                self.api("POST", "/refresh")
                b.wait(f"document.querySelector('#col-body .tree-session[data-key={json.dumps(key)}]')", "the session in the column", timeout=15)
                b.click(f"#col-body .tree-session[data-key={json.dumps(key)}]")
                b.wait("document.body.classList.contains('ws-session')", "the session to open")
                b.pump(0.3)
                open_ = b.js("""(() => {
                  const pane = [...document.querySelectorAll('.ws-pane')].find((p) => !p.hidden);
                  const strip = document.getElementById('pr-strip');
                  const last = strip.hidden ? pane : strip;
                  return { bar: document.getElementById('tabbar').getClientRects().length, paneEnd: Math.round(last.getBoundingClientRect().bottom), height: innerHeight };
                })()""")
                if open_["bar"]:
                    raise Failure("the phone tabs stay up over an open session")
                if abs(open_["paneEnd"] - open_["height"]) > 1:
                    raise Failure(f"the open session does not reach the bottom of the screen: {open_}")
                b.click("#back")
                b.wait("document.body.classList.contains('ws-list') && document.getElementById('tabbar').getClientRects().length > 0", "the phone tabs back with the column")
            finally:
                self.drop_grid_tab([key])
        finally:
            b.viewport(1280, 800)

    # The saved layout and the old panel's flag, read and written from the dashboard so the
    # Workspace page cannot save over them in between.
    LAYOUT = ("workspace.v5", "workspace.v4", "yardbell.dispatch")

    # Leaving a page while it, or its Dispatch frame, is still opening /state/live logs a failed
    # connection, and Firefox then holds back the next page's socket.
    def settle(self):
        try:
            self.b.wait("""(() => {
              const up = (w) => !w.YardbellLive || w.YardbellLive.connected();
              const f = document.querySelector('iframe[data-dispatch]');
              return document.readyState === 'complete' && up(window)
                && (!f || (f.contentDocument?.readyState === 'complete' && up(f.contentWindow)));
            })()""", "the page to finish connecting")
        except Failure:
            return
        self.b.pump(0.3)

    def storage(self, keys):
        self.settle()
        self.b.goto(self.url("/"))
        self.settle()
        return self.b.js(f"Object.fromEntries({json.dumps(list(keys))}.map((k) => [k, localStorage.getItem(k)]))")

    def put_storage(self, values):
        self.settle()
        self.b.goto(self.url("/"))
        self.b.js(f"""(() => {{
          for (const [k, v] of Object.entries({json.dumps(values)})) {{
            if (v === null) localStorage.removeItem(k);
            else localStorage.setItem(k, v);
          }}
        }})()""")
        self.settle()

    def test_shell_column_collapses_and_remembers(self):
        b = self.b
        before = self.storage(["yardbell.side"])
        b.viewport(1280, 800, 1)
        try:
            self.put_storage({"yardbell.side": None})
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('#col-toggle')", "the column toggle")
            b.click("#col-toggle")
            b.pump(0.3)
            if not b.js("document.activeElement === document.getElementById('col-toggle')"):
                raise Failure("the toggle lost focus when it moved into the rail")
            seen = b.js("""(() => ({
              col: getComputedStyle(document.getElementById('col')).display,
              rail: document.getElementById('rail').getBoundingClientRect().right,
              main: document.getElementById('main').getBoundingClientRect().left,
              stored: localStorage.getItem('yardbell.side'),
            }))()""")
            if seen["col"] != "none":
                raise Failure("the column is still shown after collapsing")
            if abs(seen["rail"] - seen["main"]) > 1:
                raise Failure(f"the main area starts at {seen['main']}, not at the rail's edge {seen['rail']}")
            if seen["stored"] != "rail":
                raise Failure(f"collapsing stored {seen['stored']!r}")
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('#col-toggle')", "the column toggle after a reload")
            if b.js("getComputedStyle(document.getElementById('col')).display") != "none":
                raise Failure("the column came back after a reload")
            b.goto(self.url("/"))
            if not b.js("document.documentElement.classList.contains('side-rail')"):
                raise Failure("the dashboard's sidebar is not collapsed after collapsing the Workspace's")
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('#col-toggle')", "the column toggle again")
            b.click("#col-toggle")
            b.pump(0.3)
            if not b.js("document.activeElement === document.getElementById('col-toggle')"):
                raise Failure("the toggle lost focus when it moved back into the column")
            seen = b.js("""(() => ({
              col: getComputedStyle(document.getElementById('col')).display,
              stored: localStorage.getItem('yardbell.side'),
            }))()""")
            if seen["col"] == "none" or seen["stored"] is not None:
                raise Failure(f"expanding left the column {seen['col']} with {seen['stored']!r} stored")
        finally:
            self.put_storage(before)

    def test_stored_collapse_leaves_the_phone_sessions_list_alone(self):
        b = self.b
        before = self.storage(["yardbell.side"])
        b.viewport(390, 844, 3)
        try:
            self.put_storage({"yardbell.side": "rail"})
            b.goto(self.url("/workspace"))
            b.wait("state !== null && document.body.classList.contains('ws-list')", "the Sessions list on a phone", timeout=15)
            seen = b.js("""(() => ({
              col: getComputedStyle(document.getElementById('col')).display,
              width: document.getElementById('col').getBoundingClientRect().width,
              rows: document.querySelectorAll('#col-body [data-key]').length,
              toggle: getComputedStyle(document.getElementById('col-toggle')).display,
            }))()""")
            if seen["col"] == "none" or seen["width"] < 300:
                raise Failure(f"a stored collapse hid the phone's sessions list: {seen}")
            if seen["toggle"] != "none":
                raise Failure("the collapse toggle shows on a phone")
        finally:
            self.put_storage(before)
            b.viewport(1280, 800)

    def test_every_moved_page_uses_the_shell(self):
        b = self.b
        b.viewport(1280, 800, 1)
        try:
            workspace = self.menu("/workspace")
            for path in ("/add", "/diagrams", "/proposals", "/pipeline"):
                rail = self.menu(path)
                if rail != workspace:
                    raise Failure(f"the rail on {path} reads {rail}, not the Workspace's {workspace}")
                b.pump(0.4)
                seen = b.js("""(() => ({
                  side: document.querySelector('.side') !== null,
                  bar: Boolean(document.getElementById('strip') || document.querySelector('.strip')),
                  col: document.getElementById('col') !== null,
                  toggle: Boolean(document.getElementById('col-toggle')?.getClientRects().length),
                  sideways: document.documentElement.scrollWidth > innerWidth,
                  tall: document.documentElement.scrollHeight > innerHeight + 1,
                }))()""")
                if seen["side"]:
                    raise Failure(f"{path} still has the old sidebar")
                if seen["bar"]:
                    raise Failure(f"{path} still has a bottom bar")
                if path == "/add" and (seen["col"] or seen["toggle"]):
                    raise Failure(f"/add draws a column or its toggle: {seen}")
                if path != "/add" and not seen["col"]:
                    raise Failure(f"{path} has no column")
                if seen["sideways"] or seen["tall"]:
                    raise Failure(f"{path} scrolls the whole page instead of its main area: {seen}")
                b.click("#col-search")
                b.wait("document.getElementById('palette')?.open", f"the search button on {path} to open the palette")
                b.key("Escape")
                b.wait("!document.getElementById('palette').open", f"Esc to close the palette on {path}")

            b.goto(self.url("/diagrams"))
            row = f"#col-body a.col-row[href='#dg-machine-{MACHINE}']"
            b.wait(f"document.querySelector(\"{row} .dot\") && document.getElementById('dg-machine-{MACHINE}')", "the machine's row and section")
            b.click(row)
            b.wait(f"document.querySelector(\"{row}\").getAttribute('aria-current') === 'true'", "the machine's row marked current")
            names = b.js("[...document.querySelectorAll('#col-body .col-row .col-row-name')].map((n) => n.textContent)")
            machines = [m["name"] for m in self.api("GET", "/state")["machines"]]
            if sorted(names) != sorted(machines):
                raise Failure(f"the Diagrams column lists {names}, not the machines {machines}")

            proposals = self.api("GET", "/api/proposals")["proposals"]
            waiting = len([p for p in proposals if p["status"] == "pending"])
            b.goto(self.url("/proposals"))
            b.wait("document.querySelectorAll('#col-body .col-row').length === 2 && document.querySelector('.pr-section')", "the Proposals column")
            rows = b.js("[...document.querySelectorAll('#col-body .col-row')].map((r) => [r.querySelector('.col-row-name').textContent, r.querySelector('.col-row-meta').textContent])")
            if rows != [["Waiting", str(waiting)], ["Decided", str(len(proposals) - waiting)]]:
                raise Failure(f"the Proposals column reads {rows}")
            if b.js("[...document.querySelectorAll('#main h1')].some((h) => h.getClientRects().length && h.textContent.trim() === 'Proposals')"):
                raise Failure("the Proposals page repeats the column's title")

            b.viewport(390, 844, 3)
            for path in ("/add", "/diagrams", "/proposals", "/pipeline"):
                b.goto(self.url(path))
                b.wait("document.querySelector('#tabbar .tab')", f"the phone tabs on {path}")
                b.pump(0.4)
                seen = b.js("""(() => ({
                  shown: document.getElementById('tabbar').getClientRects().length > 0,
                  sideways: document.documentElement.scrollWidth > innerWidth,
                  tall: document.documentElement.scrollHeight > innerHeight + 1,
                }))()""")
                if not seen["shown"] or seen["sideways"] or seen["tall"]:
                    raise Failure(f"{path} on a phone: {seen}")
        finally:
            b.viewport(1280, 800)
        self.check_errors("the moved pages")

    def test_shell_confirm_replaces_nav_confirm(self):
        b = self.b
        b.goto(self.url("/diagrams"))
        b.wait("window.YardbellShell?.confirm", "the shell on Diagrams")
        if b.js("Boolean(window.YardbellNav)"):
            raise Failure("Diagrams still loads nav.js")
        b.js("window.__answer = undefined; YardbellShell.confirm('T', 'B', { confirm: 'Go' }).then((yes) => { window.__answer = yes; }); null")
        b.wait("document.querySelector('dialog.confirm[open]')", "the confirm dialog")
        seen = b.js("""(() => {
          const d = document.querySelector('dialog.confirm[open]');
          return {
            title: d.querySelector('h2').textContent, body: d.querySelector('p').textContent,
            yes: d.querySelector('[data-answer=yes]').textContent.trim(), no: d.querySelector('[data-answer=no]').textContent.trim(),
            focused: document.activeElement === d.querySelector('[data-answer=no]'),
          };
        })()""")
        if seen != {"title": "T", "body": "B", "yes": "Go", "no": "Cancel", "focused": True}:
            raise Failure(f"the confirm dialog reads {seen}")
        b.click("dialog.confirm[open] [data-answer=no]")
        b.wait("window.__answer === false && !document.querySelector('dialog.confirm')", "Cancel to answer no")
        b.goto(self.url("/settings"))
        b.wait("window.YardbellShell?.confirm && document.getElementById('rail')", "Settings on the shell")
        if b.js("Boolean(window.YardbellNav)"):
            raise Failure("Settings still loads nav.js")
        self.check_errors("the shell's confirm")

    def test_dashboard_column_filters_by_machine(self):
        b = self.b
        key = f"{MACHINE}/hp-dash-col"
        all_row = "#col-body a.col-row[data-all]"
        pick = f"#col-body [data-pick={json.dumps(MACHINE)}]"
        before = self.storage(self.LAYOUT + ("yardbell.tree.seen",))
        self.y.tmux("new", "-d", "-s", key.split("/", 1)[1], "-c", os.path.join(self.y.root, "demo-app"), self.y.shell)
        try:
            self.api("POST", "/refresh")
            self.put_storage({"yardbell.tree.seen": json.dumps({key: "done"})})
            b.goto(self.url("/"))
            b.wait(f"document.querySelector('#col-body .tree') && document.querySelector({json.dumps(pick)})", "the tree in the Dashboard's column")
            if b.js("Boolean(window.YardbellNav) || document.querySelector('.side') !== null"):
                raise Failure("the Dashboard still draws the old sidebar")
            state = """(() => ({
              all: document.querySelector('#col-body a.col-row[data-all]').getAttribute('aria-current'),
              pick: document.querySelector('#col-body [data-pick="hp"]').getAttribute('aria-current'),
              machine: new URLSearchParams(location.search).get('machine'),
              title: document.getElementById('title').textContent,
            }))()"""
            seen = b.js(state)
            if seen != {"all": "true", "pick": None, "machine": None, "title": "Sessions"}:
                raise Failure(f"with no filter the column reads {seen}")
            b.click(pick)
            b.wait(f"new URLSearchParams(location.search).get('machine') === {json.dumps(MACHINE)}", "the machine name to set the filter")
            b.wait(f"document.querySelector({json.dumps(pick)}).getAttribute('aria-current') === 'true'", "the machine marked current")
            seen = b.js(state)
            if seen != {"all": None, "pick": "true", "machine": MACHINE, "title": MACHINE}:
                raise Failure(f"filtered to {MACHINE} the column reads {seen}")
            if b.js(f"document.querySelector('#col-body [data-fold={json.dumps(MACHINE)}]')?.getAttribute('aria-expanded')") != "true":
                raise Failure("picking the machine folded it")
            b.click(all_row)
            b.wait("!new URLSearchParams(location.search).has('machine')", "All machines to clear the filter")
            seen = b.js(state)
            if seen != {"all": "true", "pick": None, "machine": None, "title": "Sessions"}:
                raise Failure(f"after All machines the column reads {seen}")

            row = f"#col-body .tree-session[data-key={json.dumps(key)}]"
            b.wait(f"document.querySelector({json.dumps(row)})?.dataset.state === 'idle'", "the idle session in the Dashboard's column", timeout=15)
            if b.js(f"document.querySelector({json.dumps(row)}).classList.contains('unseen')"):
                raise Failure("an idle session the Workspace last saw as done is bold on the Dashboard")
            folder = b.js(f"(() => {{ let el = document.querySelector({json.dumps(row)}); while (el && !el.matches('.tree-folder')) el = el.previousElementSibling; return el?.dataset.folder; }})()")
            b.click(f"#col-body .tree-folder[data-machine={json.dumps(MACHINE)}][data-folder={json.dumps(folder)}]")
            b.wait(f"location.pathname === '/workspace' && typeof project === 'function' && state !== null && project() === {json.dumps(MACHINE + chr(9) + folder)}",
                   "a folder row to open its folder in the Workspace", timeout=15)
            self.settle()
            b.goto(self.url("/"))
            b.wait(f"document.querySelector({json.dumps(row)})", "the session row again")
            b.click(row)
            b.wait(f"location.pathname === '/workspace' && state !== null && focusedLeaf()?.key === {json.dumps(key)} && document.querySelector('.ws-pane:not([hidden]) iframe[data-key={json.dumps(key)}]')",
                   "a session row to focus its pane in the Workspace", timeout=15)
        finally:
            self.drop_grid_tab([key])
            self.put_storage(before)
        self.check_errors("the Dashboard's column")

    def test_dashboard_phone_chips_filter_by_machine(self):
        b = self.b
        chip = f".dash-chips [data-chip={json.dumps(MACHINE)}]"
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/"))
            b.wait(f"document.querySelector({json.dumps(chip)})", "the machine chips on a phone")
            b.pump(0.3)
            seen = b.js("""(() => {
              const row = document.querySelector('.dash-chips');
              const chips = [...row.querySelectorAll('.dash-chip')];
              return {
                shown: row.getClientRects().length > 0,
                labels: chips.map((c) => c.textContent.trim()),
                pressed: chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent.trim()),
                short: chips.filter((c) => c.getBoundingClientRect().height < 44).length,
                lines: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size,
                add: row.querySelector('a.dash-chip:last-child')?.getAttribute('href'),
                beforeGroups: Boolean(row.compareDocumentPosition(document.getElementById('groups')) & Node.DOCUMENT_POSITION_FOLLOWING),
                sideways: document.documentElement.scrollWidth > innerWidth,
              };
            })()""")
            want_labels = ["All machines"] + [m["name"] for m in self.api("GET", "/state")["machines"]] + ["Add machine"]
            if not seen["shown"] or sorted(seen["labels"]) != sorted(want_labels) or seen["labels"][0] != "All machines":
                raise Failure(f"the phone's chips read {seen}")
            if seen["pressed"] != ["All machines"] or seen["short"] or seen["lines"] != 1 or seen["add"] != "/add" or not seen["beforeGroups"] or seen["sideways"]:
                raise Failure(f"the phone's chip row is wrong: {seen}")
            b.click(chip)
            b.wait(f"new URLSearchParams(location.search).get('machine') === {json.dumps(MACHINE)} && document.querySelector({json.dumps(chip)}).getAttribute('aria-pressed') === 'true'",
                   "the machine chip to set the filter")
            if b.js("document.querySelector('.dash-chips [data-chip=\"\"]').getAttribute('aria-pressed')") != "false":
                raise Failure("All machines stays pressed while filtered")
            b.click(".dash-chips [data-chip='']")
            b.wait("!new URLSearchParams(location.search).has('machine')", "All machines to clear the filter")
            b.viewport(1280, 800)
            b.pump(0.3)
            if b.js("document.querySelector('.dash-chips').getClientRects().length"):
                raise Failure("the chip row shows on the desktop, where the column filters")
        finally:
            b.viewport(1280, 800)
        self.check_errors("the Dashboard's phone chips")

    def test_desktop_close_key_skips_the_workspace(self):
        b = self.b
        stub = """() => {
          window.__emitted = [];
          window.__TAURI__ = {
            event: { emit: (name, value) => { window.__emitted.push([name, value]); return Promise.resolve(); }, listen: () => Promise.resolve(() => {}) },
            app: {},
          };
        }"""
        press = """((key) => {
          const mac = /Mac/.test(navigator.platform);
          window.__emitted.length = 0;
          document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }));
          return window.__emitted.filter((e) => e[0] === 'shortcut').map((e) => e[1]);
        })"""
        script = b.call("script.addPreloadScript", functionDeclaration=stub)["script"]
        try:
            b.goto(self.url("/workspace"))
            b.wait("window.YardbellShell?.column && window.__TAURI__", "the Workspace in the desktop app")
            if b.js(f"{press}('w')"):
                raise Failure(f"Ctrl-W on the Workspace sent {b.js('window.__emitted')}")
            if b.js(f"{press}('q')") != ["quit"]:
                raise Failure(f"Ctrl-Q on the Workspace sent {b.js('window.__emitted')}")
            b.goto(self.url("/diagrams"))
            b.wait("window.YardbellShell?.column && window.__TAURI__", "Diagrams in the desktop app")
            if b.js(f"{press}('w')") != ["close"]:
                raise Failure(f"Ctrl-W on Diagrams sent {b.js('window.__emitted')}")
        finally:
            b.call("script.removePreloadScript", script=script)
            b.goto(self.url("/diagrams"))

    def test_phone_more_menu_search_opens_the_palette(self):
        b = self.b
        b.viewport(390, 844, 3)
        try:
            for path in ("/", "/workspace"):
                b.goto(self.url(path))
                b.wait("document.querySelector('#tabbar #tab-more') && window.YardbellPalette", f"the phone tabs on {path}")
                b.click("#tab-more")
                b.wait("!document.getElementById('tab-menu').hidden", f"the More menu on {path}")
                first = b.js("document.querySelector('#tab-menu [role=menuitem]')?.querySelector('.menu-label')?.textContent")
                if first != "Search":
                    raise Failure(f"the More menu on {path} starts with {first!r}, not Search")
                b.click("#tab-menu [data-search]")
                b.wait("document.getElementById('palette')?.open && document.getElementById('tab-menu').hidden", f"Search in More to open the palette on {path}")
                b.click("#palette .palette-close")
                b.wait("!document.getElementById('palette').open", f"the palette to close on {path}")
        finally:
            b.viewport(1280, 800)
        self.check_errors("Search in the phone's More menu")

    def test_collapsed_column_keeps_the_palette_button_in_the_rail(self):
        b = self.b
        before = self.storage(["yardbell.side"])
        b.viewport(1280, 800, 1)
        try:
            self.put_storage({"yardbell.side": None})
            b.goto(self.url("/diagrams"))
            b.wait("document.querySelector('#col-search-row #col-search')", "the search button in the column head")
            b.click("#col-toggle")
            b.wait("document.querySelector('#rail #col-search') && document.querySelector('#rail #col-toggle')", "the search button in the rail beside the toggle")
            order = b.js("[...document.getElementById('rail').children].slice(0, 2).map((el) => el.id)")
            if order != ["col-toggle", "col-search"]:
                raise Failure(f"the rail starts with {order}")
            b.click("#rail #col-search")
            b.wait("document.getElementById('palette')?.open", "the rail's search button to open the palette")
            b.key("Escape")
            b.wait("!document.getElementById('palette').open", "Esc to close the palette")
            b.goto(self.url("/diagrams"))
            b.wait("document.querySelector('#rail #col-search')", "the search button in the rail after a reload")
            b.js("document.getElementById('col-search').focus()")
            b.click("#col-toggle")
            b.wait("document.querySelector('#col-search-row #col-search')", "the search button back in the column head")
            last = b.js("document.getElementById('col-search-row').lastElementChild.id")
            if last != "col-search":
                raise Failure(f"the search row ends with {last!r}, not the search button")
        finally:
            self.put_storage(before)
        self.check_errors("the collapsed column's search button")

    def test_rail_dispatch_icon_toggles_the_pane(self):
        b = self.b
        before = self.storage(self.LAYOUT)
        b.viewport(1280, 800, 1)
        try:
            self.put_storage({"workspace.v5": None, "yardbell.dispatch": "closed"})
            b.goto(self.url("/workspace"))
            b.wait("typeof leaves === 'function' && state !== null", "the Workspace to load")
            icon = "document.querySelector('.col-nav [data-page=dispatch]')"
            b.click(".col-nav [data-page=dispatch]")
            b.wait("document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')", "the Dispatch pane")
            if b.js("document.querySelectorAll('iframe[data-dispatch]').length") != 1:
                raise Failure("the icon made more than one Dispatch pane")
            if b.js(f"{icon}.getAttribute('aria-pressed')") != "true":
                raise Failure("the Dispatch icon is not pressed while its pane shows")
            looks = b.js(f"""(() => {{
              const bg = (el) => getComputedStyle(el).backgroundColor;
              const here = document.querySelector('.col-nav [aria-current=page]');
              const open = {icon};
              return {{ here: bg(here), open: bg(open), dot: getComputedStyle(open, '::after').content, title: open.title }};
            }})()""")
            if looks["open"] == looks["here"]:
                raise Failure(f"an open Dispatch pane makes its link look like a second current page: {looks}")
            if looks["dot"] in ("none", "normal", "") or "close" not in looks["title"].lower():
                raise Failure(f"the open Dispatch link shows no dot or says nothing about closing: {looks}")
            b.click(".col-nav [data-page=dispatch]")
            b.wait("!document.querySelector('iframe[data-dispatch]')", "the Dispatch pane to close")
            if b.js(f"{icon}.getAttribute('aria-pressed')") != "false":
                raise Failure("the Dispatch icon is still pressed after closing the pane")
        finally:
            self.put_storage(before)

    def test_sidebar_machine_rows_are_quiet_unless_picked(self):
        b = self.b
        b.goto(self.url("/"))
        b.wait("document.querySelector('#col-body .tree-machine')", "the machines in the sidebar")
        seen = b.js("""(() => {
          const rows = [...document.querySelectorAll('#col-body .tree-machine')].filter((r) => !r.classList.contains('current'));
          return rows.map((r) => [getComputedStyle(r).backgroundColor, getComputedStyle(r).borderTopColor]);
        })()""")
        clear = ("rgba(0, 0, 0, 0)", "transparent")
        if not seen or any(bg not in clear or line not in clear for bg, line in seen):
            raise Failure(f"machine rows that are not picked still look picked: {seen}")

    def test_dispatch_opens_as_a_pane_and_survives_a_reload(self):
        b = self.b
        before = self.storage(self.LAYOUT)
        try:
            self.put_storage({"workspace.v5": None, "yardbell.dispatch": "closed"})
            b.goto(self.url("/workspace"))
            b.wait("typeof leaves === 'function' && state !== null", "the Workspace to load")
            b.click(".col-nav [data-page=dispatch]")
            b.wait("document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')", "the Dispatch pane")
            self.settle()
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')", "the Dispatch pane after a reload")
            if b.js("location.pathname") != "/workspace":
                raise Failure("the reload left the Workspace")
        finally:
            self.put_storage(before)

    # The request names a session Yardbell has never seen, so Dispatch shows the insights error
    # and never sends a message, which would run claude.
    def test_dispatch_pane_takes_requests_and_keeps_its_conversation(self):
        b = self.b
        frame = "document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')"
        loaded = f"{frame}?.contentDocument?.readyState === 'complete' && {frame}.contentWindow.location.pathname === '/dispatch'"
        told = f"{frame}?.contentDocument?.getElementById('toast')?.textContent.includes('seen no session yb-nowhere')"
        before = self.storage(self.LAYOUT)
        try:
            self.put_storage({"workspace.v5": None, "yardbell.dispatch": "closed"})
            b.goto(self.url("/workspace"))
            b.wait("typeof leaves === 'function' && state !== null", "the Workspace to load")
            b.js("openDispatch()")
            b.wait(loaded, "Dispatch to load in its pane")
            b.js("askDispatch({ machine: 'hp', name: 'yb-nowhere' })")
            b.wait(told, "the request to reach the open Dispatch pane")
            b.js("closePane(findDispatch().leaf.pane)")
            b.wait("!document.querySelector('iframe[data-dispatch]')", "the Dispatch pane to close")
            b.js("askDispatch({ machine: 'hp', name: 'yb-nowhere' })")
            b.wait(told, "the request to reach a Dispatch pane opened for it")
            b.js(f"openDispatch({json.dumps(SHORT_CHAT)})")
            b.wait(f"{frame}.contentWindow.location.search === '?c={SHORT_CHAT}'", "the pane to show the conversation")
            b.wait("document.querySelector('.ws-pane:has(iframe[data-dispatch]) .ws-pane-title')?.textContent === 'Fix the login redirect'",
                   "the conversation's title on the pane")
            self.settle()
            b.goto(self.url("/workspace"))
            b.wait(f"{frame}?.getAttribute('src') === '/dispatch?c={SHORT_CHAT}'", "the same conversation after a reload")
            b.wait(loaded, "Dispatch to load again")
            b.wait(f"{frame}.contentDocument.querySelector('#dispatch-log .msg.user')", "the conversation inside Dispatch")
            b.js(f"{frame}.contentDocument.getElementById('new-chat').click()")
            b.wait("findDispatch()?.leaf.conversation === '' && JSON.parse(localStorage.getItem('workspace.v5')).tabs.some((t) => leaves(t.root).some((l) => l.kind === 'dispatch' && l.conversation === ''))",
                   "a new chat in Dispatch to be stored on the pane")
        finally:
            self.put_storage(before)

    def test_v4_layout_moves_to_v5(self):
        b = self.b
        name = "hp-demo-api-1"
        key = f"{MACHINE}/{name}"
        made = self.y.tmux("has-session", "-t", f"={name}").returncode != 0
        if made:
            self.y.tmux("new", "-d", "-s", name, "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
        v4 = json.dumps({"folder": "", "tabs": [{"id": "t1", "name": name, "root": {"pane": "p1", "key": key}}],
                         "tab": 0, "focus": "p1", "hidden": []})
        seen = """(() => ({
          panes: document.querySelectorAll('.ws-pane:not([hidden])').length,
          dispatch: Boolean(document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')),
          empty: Boolean(document.querySelector('.ws-pane:not([hidden]) .ws-pane-empty')),
          v5: (() => { try { return JSON.parse(localStorage.getItem('workspace.v5')).tabs.length; } catch { return 0; } })(),
          v4: localStorage.getItem('workspace.v4'),
          running: sessions().filter((s) => !s.stale).length,
        }))()"""
        before = self.storage(self.LAYOUT)
        try:
            self.api("POST", "/refresh")
            for flag, panes, dispatch in ((None, 2, True), ("closed", 1, False)):
                self.put_storage({"workspace.v5": None, "workspace.v4": v4, "yardbell.dispatch": flag})
                b.goto(self.url("/workspace"))
                b.wait(f"typeof leaves === 'function' && state !== null && leaves(tab().root).some((l) => l.key === {json.dumps(key)})",
                       f"the v4 tab with {name}", timeout=15)
                b.pump(0.5)
                got = b.js(seen)
                if got["panes"] != panes or got["dispatch"] != dispatch:
                    raise Failure(f"with yardbell.dispatch {flag!r}, wanted {panes} panes and Dispatch {dispatch}: {got}")
                if not got["v5"]:
                    raise Failure(f"the converted layout was not saved as workspace.v5: {got}")
                if got["v4"] != v4:
                    raise Failure(f"workspace.v4 changed: {got['v4']!r}")
            if made:
                self.y.tmux("kill-session", "-t", f"={name}")
                self.api("POST", "/refresh")
            self.put_storage({"workspace.v5": None, "workspace.v4": "{not json", "yardbell.dispatch": None})
            b.errors = []
            b.goto(self.url("/workspace"))
            b.wait("typeof leaves === 'function' && state !== null && localStorage.getItem('workspace.v5') !== null", "the page to load on bad v4")
            b.pump(0.5)
            got = b.js(seen)
            if got["panes"] != 1 or got["dispatch"]:
                raise Failure(f"a v4 layout that does not parse should give one pane and no Dispatch: {got}")
            if not got["running"] and not got["empty"]:
                raise Failure(f"with nothing running, the one pane should be empty: {got}")
            self.check_errors("a v4 layout that does not parse")
        finally:
            if made:
                self.settle()
                self.drop_grid_tab([key])
            self.put_storage(before)

    def test_a_dispatch_only_tab_is_not_taken_by_a_new_session(self):
        b = self.b
        name = "hp-demo-api-2"
        key = f"{MACHINE}/{name}"
        self.y.tmux("kill-session", "-t", f"={name}")
        v5 = json.dumps({"folder": "", "tabs": [{"id": "t1", "name": "Dispatch", "root": {"pane": "d1", "kind": "dispatch", "conversation": ""}}],
                         "tab": 0, "focus": "d1", "hidden": []})
        before = self.storage(self.LAYOUT)
        try:
            self.api("POST", "/refresh")
            self.put_storage({"workspace.v5": v5, "yardbell.dispatch": "closed"})
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('.ws-pane[data-pane=d1] iframe[data-dispatch]')", "the Dispatch-only tab")
            r = self.y.tmux("new", "-d", "-s", name, "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
            if r.returncode:
                raise Failure(f"tmux new failed: {r.stderr}")
            self.api("POST", "/refresh")
            b.wait(f"saved.tabs.some((t) => leaves(t.root).some((l) => l.key === {json.dumps(key)}))", f"a tab for {name}", timeout=15)
            first = b.js("""(() => ({
              leaves: leaves(saved.tabs[0].root).map((l) => ({kind: l.kind || null, key: l.key || null})),
              frame: Boolean(document.querySelector('.ws-pane[data-pane=d1] iframe[data-dispatch]')),
            }))()""")
            if first["leaves"] != [{"kind": "dispatch", "key": None}] or not first["frame"]:
                raise Failure(f"the first tab should still hold only Dispatch: {first}")
        finally:
            self.settle()
            self.drop_grid_tab([key])
            self.put_storage(before)

    def pane_menu_pick(self, pane, label):
        b = self.b
        b.click(f"{pane} [data-act=more]")
        b.wait("document.getElementById('ws-menu') && !document.getElementById('ws-menu').hidden", "the pane menu")
        picked = b.js(f"""(() => {{
          const hit = [...document.querySelectorAll('#ws-menu [role=menuitem]')].find((m) => m.textContent.trim() === {json.dumps(label)});
          if (hit) hit.click();
          return Boolean(hit);
        }})()""")
        if not picked:
            raise Failure(f"the pane menu has no {label} item")

    def menu_items(self):
        return self.b.js("[...document.querySelectorAll('#ws-menu [role=menuitem]')].map((m) => m.textContent.trim())")

    def test_pane_header_is_one_quiet_line(self):
        b = self.b
        name = "hp-demo-api-1"
        key = f"{MACHINE}/{name}"
        made = self.y.tmux("has-session", "-t", f"={name}").returncode != 0
        if made:
            self.y.tmux("new", "-d", "-s", name, "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
        before = self.storage(self.LAYOUT)
        try:
            self.api("POST", "/refresh")
            b.goto(self.url("/workspace"))
            b.wait(f"typeof sessionFor === 'function' && sessionFor({json.dumps(key)})", f"{name} in the Workspace", timeout=15)
            b.js(f"open({json.dumps(key)})")
            pane = b.wait(f"leaves(tab().root).length === 1 && leaves(tab().root)[0].key === {json.dumps(key)} && leaves(tab().root)[0].pane",
                          f"{name} alone in its tab")
            sel = f'.ws-pane[data-pane="{pane}"]'
            seen = b.js(f"""(() => {{
              const pane = document.querySelector({json.dumps(sel)});
              const head = pane.querySelector('.ws-pane-head');
              return {{
                buttons: [...head.querySelectorAll('button')].map((x) => x.dataset.act + (x.hidden ? ' hidden' : '')).sort(),
                links: head.querySelectorAll('a').length,
                views: head.querySelector('.ws-views')?.hidden,
                dot: Boolean(head.querySelector(':scope > .ws-state')),
                title: head.querySelector('strong.ws-pane-title')?.textContent,
                sub: head.querySelector('span.ws-pane-sub')?.textContent,
                pr: Boolean(head.querySelector('span.ws-pane-pr')),
                radius: getComputedStyle(pane).borderTopLeftRadius,
                frame: getComputedStyle(pane, '::after').content,
              }};
            }})()""")
            if seen["buttons"] != ["main hidden", "more"]:
                raise Failure(f"the header's buttons are {seen['buttons']}, not ⋯ and a hidden main action")
            if seen["links"]:
                raise Failure("the header still carries a link")
            if seen["views"] is not True:
                raise Failure(f"the view switch should be there and hidden: {seen}")
            if not seen["dot"] or not seen["title"] or not seen["pr"]:
                raise Failure(f"the header misses its dot, title or pull request slot: {seen}")
            if not re.fullmatch(r".+ · (idle|working|done|blocked|stopped on an error)( \d+[mh])?", seen["sub"] or ""):
                raise Failure(f"the header's second part reads {seen['sub']!r}")
            if seen["radius"] != "0px" or seen["frame"] not in ("none", "normal"):
                raise Failure(f"the pane still has a rounded frame: {seen}")
            b.click(f"{sel} [data-act=more]")
            b.wait("document.getElementById('ws-menu') && !document.getElementById('ws-menu').hidden", "the pane menu")
            items = self.menu_items()
            if items[:4] != ["Copy text", "Open in its own tab", "Split right", "Split down"] or items[-1] != "Close":
                raise Failure(f"the pane menu reads {items}")
            if "Move to its own tab" in items:
                raise Failure(f"a pane alone in its tab offers Move to its own tab: {items}")
            b.key("Escape")
            b.wait("document.getElementById('ws-menu').hidden", "the menu to close")
            b.js(f"focusPane({json.dumps(pane)})")
            b.key("\\", "Alt")
            b.wait("leaves(tab().root).length === 2", "Alt+\\ to split the pane")
            split = b.js(f"""(() => {{
              const probe = document.createElement('div');
              probe.style.background = 'var(--selected)';
              document.body.append(probe);
              const selected = getComputedStyle(probe).backgroundColor;
              probe.remove();
              const [a, b] = leaves(tab().root).map((l) => document.querySelector(`.ws-pane[data-pane="${{l.pane}}"]`));
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              const head = (el) => getComputedStyle(el.querySelector('.ws-pane-head')).backgroundColor;
              return {{
                focusedNew: space().focus === leaves(tab().root)[1].pane,
                newHead: head(b) === selected, oldHead: head(a) === selected,
                seam: Math.abs(ra.right - rb.left) < 1,
                line: [getComputedStyle(a).borderRightWidth, getComputedStyle(b).borderLeftWidth, getComputedStyle(b).borderRightWidth],
              }};
            }})()""")
            if not split["focusedNew"] or not split["newHead"] or split["oldHead"]:
                raise Failure(f"only the focused pane's header should be grey: {split}")
            if not split["seam"] or split["line"] != ["1px", "0px", "0px"]:
                raise Failure(f"two panes side by side should share one 1px line: {split}")
            grey = """(() => {
              const probe = document.createElement('div');
              probe.style.background = 'var(--selected)';
              document.body.append(probe);
              const selected = getComputedStyle(probe).backgroundColor;
              probe.remove();
              const shown = [...document.querySelectorAll('.ws-pane:not([hidden])')];
              return shown.map((el) => getComputedStyle(el.querySelector('.ws-pane-head')).backgroundColor === selected);
            })()"""
            b.viewport(390, 844, 3)
            try:
                b.wait("phone.matches && document.querySelectorAll('.ws-pane:not([hidden])').length === 1", "one pane on a phone")
                b.pump(0.3)
                if b.js(grey) != [False]:
                    raise Failure("the one pane on a phone has a grey focused header")
            finally:
                b.viewport(1280, 800)
            b.wait("!phone.matches && document.querySelectorAll('.ws-pane:not([hidden])').length === 2", "both panes back on a wide screen")
            b.pump(0.3)
            if b.js(grey) != [False, True]:
                raise Failure(f"back on a wide screen only the focused pane's header should be grey: {b.js(grey)}")
            b.click(f"{sel} [data-act=more]")
            b.wait("document.getElementById('ws-menu') && !document.getElementById('ws-menu').hidden", "the pane menu in a split")
            if "Move to its own tab" not in self.menu_items():
                raise Failure(f"a pane beside another lacks Move to its own tab: {self.menu_items()}")
            b.key("Escape")
        finally:
            self.settle()
            if made:
                self.drop_grid_tab([key])
            self.put_storage(before)

    def test_pane_header_offers_merge_when_ready(self):
        b = self.b
        key = f"{MACHINE}/{MERGE_SESSION}"
        worktree = os.path.join(os.path.dirname(self.y.root), "merge-wt")
        if not os.path.exists(worktree):
            git("worktree", "add", "-q", "-b", MERGE_BRANCH, worktree, cwd=os.path.join(self.y.root, "demo-app"))
        r = self.y.tmux("new", "-d", "-s", MERGE_SESSION, "-c", worktree, self.y.shell)
        if r.returncode:
            raise Failure(f"tmux new failed: {r.stderr}")
        main = f'.ws-pane:has(iframe[data-key="{key}"]) [data-act=main]'
        before = self.storage(self.LAYOUT)
        try:
            self.api("POST", "/refresh")
            b.goto(self.url("/workspace"))
            b.wait(f"typeof sessionFor === 'function' && sessionFor({json.dumps(key)})?.pull?.review === 'approved'",
                   "the ready pull request in the Workspace", timeout=45)
            b.js(f"open({json.dumps(key)})")
            b.wait(f"document.querySelector({json.dumps(main)})?.textContent.trim() === 'Merge #34' && !document.querySelector({json.dumps(main)}).hidden",
                   "Merge #34 as the pane's main action")
            pr = b.js(f"document.querySelector('.ws-pane:has(iframe[data-key=\"{key}\"]) .ws-pane-pr')?.textContent")
            if pr != "#34 approved":
                raise Failure(f"the pull request mark reads {pr!r}")
            b.click(main)
            b.wait("document.getElementById('merge-confirm')?.open", "the question before merging")
            want = b.js(f"YardbellPull.mergeText(sessionFor({json.dumps(key)}).pull)")
            said = b.js("(() => { const d = document.getElementById('merge-confirm'); return { title: d.querySelector('h2').textContent, body: d.querySelector('p').textContent }; })()")
            if said != want or said["title"] != "Merge #34?" or "Add the merge button." not in said["body"]:
                raise Failure(f"the question reads {said}, not the dashboard's {want}")
            b.click("#merge-confirm [value=cancel]")
            b.wait("!document.getElementById('merge-confirm').open", "the question to close")
            b.pump(0.5)
            if os.path.exists(self.y.merges):
                raise Failure("Cancel merged the pull request")
            b.viewport(390, 844, 3)
            try:
                b.wait("document.body.classList.contains('ws-session') && !document.getElementById('pr-strip').hidden",
                       "the pull request strip under the session on a phone")
                strip = b.js("""(() => {
                  const el = document.getElementById('pr-strip');
                  return {
                    ref: el.querySelector('.ws-pr-ref').textContent,
                    merge: el.querySelector('[data-pr=merge]').getClientRects().length > 0,
                    review: el.querySelector('[data-pr=review]').getClientRects().length > 0,
                    below: Math.round(el.getBoundingClientRect().top) >= Math.round(document.querySelector('.ws-pane:not([hidden])').getBoundingClientRect().bottom),
                  };
                })()""")
                if strip != {"ref": "#34 approved", "merge": True, "review": False, "below": True}:
                    raise Failure(f"the phone's pull request strip reads {strip}")
                b.click("#pr-strip [data-pr=merge]")
                b.wait("document.getElementById('merge-confirm')?.open", "the same question before merging on a phone")
                b.click("#merge-confirm [value=cancel]")
                b.wait("!document.getElementById('merge-confirm').open", "the question to close on a phone")
            finally:
                b.viewport(1280, 800)
        finally:
            self.settle()
            self.drop_grid_tab([key])
            self.put_storage(before)

    # The seeded review of fix-login, the branch hp-pull-test sits on, waits for approval.
    def test_pane_header_opens_a_waiting_review(self):
        b = self.b
        made = self.y.tmux("has-session", "-t", f"={PULL_SESSION}").returncode != 0
        self.pull_session()
        key = f"{MACHINE}/{PULL_SESSION}"
        main = f'.ws-pane:has(iframe[data-key="{key}"]) [data-act=main]'
        before = self.storage(self.LAYOUT)
        try:
            b.goto(self.url("/workspace"))
            b.wait(f"typeof sessionFor === 'function' && sessionFor({json.dumps(key)})?.review?.state === 'asking'",
                   "the waiting review in the Workspace", timeout=45)
            b.js(f"open({json.dumps(key)})")
            b.wait(f"document.querySelector({json.dumps(main)})?.textContent.trim() === 'Open review' && !document.querySelector({json.dumps(main)}).hidden",
                   "Open review as the pane's main action")
            conversation = b.js(f"sessionFor({json.dumps(key)}).review.conversation")
            b.click(main)
            b.wait(f"findDispatch()?.leaf.conversation === {json.dumps(conversation)} && document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')",
                   "the review's conversation in a Dispatch pane")
        finally:
            self.settle()
            if made:
                self.drop_grid_tab([key])
            self.put_storage(before)

    def test_dispatch_pane_takes_clicks_and_new_titles(self):
        b = self.b
        frame = "document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')"
        loaded = f"{frame}?.contentDocument?.readyState === 'complete' && {frame}.contentWindow.location.pathname === '/dispatch'"
        before = self.storage(self.LAYOUT)
        try:
            self.put_storage({"workspace.v5": None, "yardbell.dispatch": "closed"})
            b.goto(self.url("/workspace"))
            b.wait("typeof leaves === 'function' && state !== null", "the Workspace to load")
            b.js("openDispatch()")
            b.wait(loaded, "Dispatch to load in its pane")
            b.js("split('row')")
            b.wait("isEmpty(focusedLeaf()) && leaves(tab().root).some(isDispatch)", "the new pane beside Dispatch to take the focus")
            b.click("iframe[data-dispatch]")
            b.wait("isDispatch(focusedLeaf())", "a click inside Dispatch to focus its pane")
            b.js("focusPane(leaves(tab().root).find(isEmpty).pane)")
            b.js("focusPane(findDispatch().leaf.pane)")
            b.wait(f"{frame}.contentDocument.activeElement === {frame}.contentDocument.querySelector('#dispatch-input')",
                   "focusing the Dispatch pane to put the cursor in its composer")
            b.js(f"dispatchTitles.clear(); openDispatch({json.dumps(SHORT_CHAT)})")
            b.wait("document.querySelector('.ws-pane:has(iframe[data-dispatch]) .ws-pane-title')?.textContent === 'Fix the login redirect'",
                   "the title of a conversation the pane had not seen")
        finally:
            self.settle()
            self.put_storage(before)

    def test_workspace_deep_links(self):
        b = self.b
        name = "hp-demo-api-1"
        key = f"{MACHINE}/{name}"
        made = self.y.tmux("has-session", "-t", f"={name}").returncode != 0
        if made:
            self.y.tmux("new", "-d", "-s", name, "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
        before = self.storage(self.LAYOUT)
        try:
            self.api("POST", "/refresh")
            b.goto(self.url("/workspace?open=" + urllib.parse.quote(key, safe="")))
            b.wait(f"state !== null && document.querySelector('.ws-pane:not([hidden]) iframe[data-key=\"{key}\"]') && location.search === ''",
                   "the deep link to open the session", timeout=15)
            focused = b.js("focusedLeaf().key")
            if focused != key:
                raise Failure(f"the focused pane holds {focused!r}")
            b.goto(self.url("/workspace?open=" + urllib.parse.quote(f"{MACHINE}/no-such-session", safe="")))
            b.wait("state !== null && location.search === '' && document.querySelector('.ws-pane-empty')?.textContent.includes('That session has ended.')",
                   "the note for a session that has ended", timeout=15)
            self.put_storage({"workspace.v5": None})
            self.y.tmux("kill-session", "-t", f"={name}")
            self.api("POST", "/refresh")
            b.goto(self.url("/workspace"))
            b.wait(f"state !== null && !sessions().some((s) => keyOf(s) === {json.dumps(key)})", "the session to be gone")
            label = b.js(f"state.folders.find((f) => f.machine === {json.dumps(MACHINE)} && f.label.endsWith('demo-api')).label")
            b.goto(self.url("/workspace?folder=" + urllib.parse.quote(f"{MACHINE}/{label}", safe="")))
            b.wait(f"state !== null && location.search === '' && project() === {json.dumps(MACHINE + chr(9) + label)}",
                   "the deep link to select the folder", timeout=15)
        finally:
            self.settle()
            self.put_storage(before)
            self.y.tmux("kill-session", "-t", f"={name}")
            self.api("POST", "/refresh")

    def test_workspace_falls_back_on_a_layout_of_the_wrong_type(self):
        b = self.b
        good = {"tabs": [{"id": "t1", "name": "Agents", "root": {"pane": "p1", "key": None}}], "tab": 0, "focus": "p1", "hidden": []}
        before = self.storage(self.LAYOUT)
        try:
            for wrong in ({"tab": "x"}, {"hidden": {}}):
                self.put_storage({"workspace.v5": json.dumps({**good, **wrong}), "yardbell.dispatch": "closed"})
                b.errors = []
                b.goto(self.url("/workspace"))
                b.wait("typeof leaves === 'function' && state !== null && document.querySelector('.ws-pane:not([hidden])')",
                       f"the Workspace to load with {wrong}")
                b.pump(0.5)
                self.check_errors(f"a stored layout with {wrong}")
                if b.js(f"parseLayout({json.dumps(json.dumps({**good, **wrong}))})") is not None:
                    raise Failure(f"parseLayout took a layout with {wrong}")
            if not b.js(f"parseLayout({json.dumps(json.dumps(good))})"):
                raise Failure("parseLayout refused a good layout")
        finally:
            self.put_storage(before)

    USAGE_FIXTURE = """(() => {
          const soon = Math.floor(Date.now() / 1000);
          const win = (name, label, short, used, hours, extra = {}) => ({ name, label, short, used, resets_at: soon + hours * 3600, status: "allowed", ...extra });
          return { windows: [], codex: null, runs_on: "claude", providers: [
            { id: "claude", name: "Claude", plan: "Max 20x", status: "ok", source: "account", seen: new Date().toISOString(),
              windows: [win("seven_day", "Weekly limit", "wk", 0.16, 120), win("seven_day_fable", "Weekly Fable", "Fable wk", 0.3, 120, { model: "Fable" })] },
            { id: "codex", name: "Codex", plan: "Team", status: "ok", source: "account", seen: new Date().toISOString(), credits: "12.5 credits left",
              error: "ChatGPT answered 429 Too Many Requests",
              windows: [win("session", "5-hour limit", "5h", 0.75, 4), win("weekly", "Weekly limit", "wk", 0.01, 160)] },
            { id: "gemini", name: "Gemini", plan: null, status: "error", message: "Google answered 403 Forbidden", windows: [] },
          ] };
        })()"""

    def mock_usage(self, body_js=None):
        return self.b.js(f"""(() => {{
          const body = {body_js or self.USAGE_FIXTURE};
          const real = window.__realFetch || window.fetch;
          window.__realFetch = real;
          window.fetch = (url, init) => String(url).startsWith("/dispatch/usage") ? Promise.resolve(new Response(JSON.stringify(body), {{ status: 200 }})) : real(url, init);
          return window.YardbellUsage.load();
        }})()""")

    def test_usage_card_and_sheet_list_every_window(self):
        b = self.b
        b.goto(self.url("/workspace"))
        b.wait("window.YardbellUsage && document.getElementById('usage-card')", "the usage card")
        self.mock_usage()
        b.wait("!document.getElementById('usage-card').hidden && document.querySelectorAll('#usage-card .usage-row').length === 2", "a row per agent with figures")
        card = b.js("""(() => {
          const card = document.getElementById('usage-card');
          const rows = [...card.querySelectorAll('.usage-row')];
          return {
            inColumn: card.parentElement.id === 'col' && card.nextElementSibling?.classList.contains('col-foot'),
            rows: rows.map((r) => [...r.querySelector('.usage-row-line').children].map((c) => c.textContent.trim()).filter(Boolean).join(' ')),
            tones: rows.map((r) => r.querySelector('.usage-meter').className.split(' ').pop()),
            lit: rows.map((r) => r.querySelectorAll('.usage-meter i.on').length),
            cells: rows.map((r) => r.querySelectorAll('.usage-meter i').length),
            resets: rows.map((r) => r.querySelector('.usage-row-reset').textContent),
          };
        })()""")
        if not card["inColumn"]:
            raise Failure("the usage card should sit just above the sidebar's foot")
        if card["rows"] != ["Claude Fable wk 30%", "Codex 5h 75%"]:
            raise Failure(f"each row should show the tightest existing window, with five_hour missing: {card['rows']}")
        if card["tones"] != ["ok", "warn"] or card["lit"] != [3, 8] or card["cells"] != [10, 10]:
            raise Failure(f"the meters read {card}")
        if not all(card["resets"]):
            raise Failure(f"every row should say when it resets: {card['resets']}")
        if b.js("document.getElementById('strip') || document.getElementById('usage-pop')"):
            raise Failure("the status bar still shows usage")
        b.click("#usage-card")
        b.wait("!document.getElementById('usage-sheet').hidden && document.activeElement?.matches('#usage-sheet [data-usage-close]')", "the sheet with focus in it")
        sheet = b.js("""(() => {
          const sheet = document.getElementById('usage-sheet');
          const col = document.getElementById('col').getBoundingClientRect();
          const box = sheet.getBoundingClientRect();
          return {
            left: Math.round(box.left), edge: Math.round(col.right), width: Math.round(box.width), height: Math.round(box.height), tall: innerHeight,
            sections: [...sheet.querySelectorAll('.usage-sect:not(.usage-machines)')].map((s) => ({
              head: [...s.querySelector('.usage-sect-head').children].map((c) => c.textContent.trim()).filter(Boolean).join(' '),
              wins: [...s.querySelectorAll('.usage-win-label')].map((w) => w.textContent),
              resets: [...s.querySelectorAll('.usage-win-reset')].filter((r) => r.textContent.startsWith('Resets in')).length,
              meters: s.querySelectorAll('.usage-meter').length,
              text: s.textContent.replace(/\\s+/g, ' ').trim(),
            })),
            link: sheet.querySelector('.usage-sheet-link')?.getAttribute('href'),
          };
        })()""")
        if sheet["left"] != sheet["edge"] or not 340 <= sheet["width"] <= 380 or sheet["height"] != sheet["tall"]:
            raise Failure(f"the sheet should slide out full height from the sidebar's edge: {sheet}")
        names = [s["head"] for s in sheet["sections"]]
        if len(names) != 3 or not names[0].startswith("Claude Max 20x") or not names[1].startswith("Codex Team"):
            raise Failure(f"the sheet's sections read {names}")
        if sheet["sections"][0]["wins"] != ["Weekly limit", "Weekly Fable"] or sheet["sections"][1]["wins"] != ["5-hour limit", "Weekly limit"]:
            raise Failure(f"every window should be listed: {sheet['sections']}")
        if [s["resets"] for s in sheet["sections"]] != [2, 2, 0] or [s["meters"] for s in sheet["sections"]] != [2, 2, 0]:
            raise Failure(f"every window should have a meter and its reset: {sheet['sections']}")
        codex, gemini = sheet["sections"][1]["text"], sheet["sections"][2]["text"]
        if "12.5 credits left" not in codex or "429 Too Many Requests" not in codex or "403 Forbidden" not in gemini:
            raise Failure(f"credits and errors should show: {codex!r} {gemini!r}")
        if sheet["link"] != "/settings#stats-usage":
            raise Failure(f"the Stats & Usage link goes to {sheet['link']}")
        b.key("Escape")
        b.wait("document.getElementById('usage-sheet').hidden && document.activeElement?.id === 'usage-card'", "Escape to close the sheet and return focus")
        b.click("#usage-card")
        b.wait("!document.getElementById('usage-sheet').hidden", "the sheet again")
        b.js("document.querySelector('.usage-scrim').click()")
        b.wait("document.getElementById('usage-sheet').hidden", "a click outside to close the sheet")
        self.mock_usage("{ windows: [], codex: null, providers: [{ id: 'codex', name: 'Codex', status: 'signed_out', message: 'Not signed in', windows: [] }] }")
        b.wait("document.getElementById('usage-card').hidden", "the card hidden when no agent has figures")
        self.check_errors("the usage card and sheet")

    def test_usage_rail_button_and_phone_more_row(self):
        b = self.b
        b.goto(self.url("/workspace"))
        b.wait("window.YardbellUsage && window.YardbellShell", "the shell")
        try:
            b.js("window.YardbellShell.collapse(true)")
            self.mock_usage()
            b.wait("!document.getElementById('rail-usage').hidden && getComputedStyle(document.getElementById('rail')).display !== 'none'", "the usage ring in the folded rail")
            ring = b.js("""(() => {
              const fill = document.querySelector('#rail-usage .usage-ring-fill');
              return { label: document.getElementById('rail-usage').getAttribute('aria-label'), tone: document.querySelector('#rail-usage .usage-ring').classList.contains('warn'),
                       dash: parseFloat(fill.getAttribute('stroke-dasharray')) };
            })()""")
            if "Codex 5h 75%" not in ring["label"] or not ring["tone"] or not 30 < ring["dash"] < 31:
                raise Failure(f"the rail ring should show the tightest 75%: {ring}")
            b.click("#rail-usage")
            b.wait("!document.getElementById('usage-sheet').hidden", "the sheet from the rail")
            left = b.js("Math.round(document.getElementById('usage-sheet').getBoundingClientRect().left) === Math.round(document.getElementById('rail').getBoundingClientRect().right)")
            if not left:
                raise Failure("the sheet should open from the rail's edge")
            b.key("Escape")
            b.wait("document.getElementById('usage-sheet').hidden && document.activeElement?.id === 'rail-usage'", "focus back on the rail button")
        finally:
            b.js("window.YardbellShell.collapse(false)")
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/"))
            b.wait("window.YardbellUsage && document.getElementById('tab-more')", "the tab bar on a phone")
            self.mock_usage()
            b.click("#tab-more")
            b.wait("!document.getElementById('tab-menu').hidden", "the More menu")
            row = b.js("document.querySelector('#tab-menu [data-usage-open]')?.textContent.trim()")
            if row != "Usage":
                raise Failure(f"the More menu's usage row reads {row!r}")
            b.click("#tab-menu [data-usage-open]")
            b.wait("!document.getElementById('usage-sheet').hidden && document.getElementById('tab-menu').hidden", "the sheet from More")
            phone = b.js("""(() => {
              const box = document.getElementById('usage-sheet').getBoundingClientRect();
              return { left: Math.round(box.left), width: Math.round(box.width), sideways: document.documentElement.scrollWidth > innerWidth,
                       close: Math.round(document.querySelector('#usage-sheet [data-usage-close]').getBoundingClientRect().height) };
            })()""")
            if phone["left"] != 0 or phone["width"] != 390 or phone["sideways"] or phone["close"] < 40:
                raise Failure(f"the sheet should fill the phone's width: {phone}")
            b.key("Escape")
            b.wait("document.getElementById('usage-sheet').hidden", "Escape to close it on a phone")
        finally:
            b.viewport(1280, 800)

    def write_usage_transcripts(self):
        home = self.y.env["HOME"]
        now = time.time()
        stamp = lambda hours: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - hours * 3600))
        folder = os.path.join(home, ".claude", "projects", "-work-stats-demo")
        os.makedirs(folder, exist_ok=True)
        def reply(n, hours, usage):
            return {"type": "assistant", "sessionId": "stats-session-1", "cwd": "/work/stats-demo", "timestamp": stamp(hours),
                    "requestId": f"req-{n}", "uuid": f"stats-{n}",
                    "message": {"id": f"msg-stats-{n}", "model": "claude-statsfixture-1", "role": "assistant", "usage": usage,
                                "content": [{"type": "text", "text": "done"}]}}
        lines = [reply(1, 50, {"input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 20000, "cache_creation_input_tokens": 0}),
                 reply(1, 50, {"input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 20000, "cache_creation_input_tokens": 0}),
                 reply(2, 2, {"input_tokens": 2000, "output_tokens": 1500, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})]
        with open(os.path.join(folder, "stats-session-1.jsonl"), "w") as f:
            f.write("".join(json.dumps(line) + "\n" for line in lines))
        day = os.path.join(home, ".codex", "sessions", "2026", "11", "12")
        os.makedirs(day, exist_ok=True)
        usage = {"input_tokens": 4000, "cached_input_tokens": 1000, "output_tokens": 600, "reasoning_output_tokens": 0, "total_tokens": 4600}
        with open(os.path.join(day, "rollout-2026-11-12T00-00-00-0199stat-0000-0000-0000-000000000001.jsonl"), "w") as f:
            for line in (
                {"timestamp": stamp(3), "type": "session_meta", "payload": {"id": "0199stat-0000-0000-0000-000000000001", "cwd": "/work/stats-api"}},
                {"timestamp": stamp(3), "type": "turn_context", "payload": {"turn_id": "t1", "model": "gpt-statsfixture"}},
                {"timestamp": stamp(3), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": usage, "last_token_usage": usage}}},
            ):
                f.write(json.dumps(line) + "\n")

    def test_settings_stats_usage_cards_chart_and_tables(self):
        b = self.b
        self.write_usage_transcripts()
        b.goto(self.url("/settings"))
        b.wait("document.querySelector('#col-body .settings-nav a[href=\"#stats-usage\"]')", "Stats & Usage in the section list")
        b.js("localStorage.removeItem('yardbell.stats.tab'); localStorage.removeItem('yardbell.stats.days')")
        b.click('#col-body .settings-nav a[href="#stats-usage"]')
        try:
            b.wait("!document.getElementById('stats-usage').hidden && document.querySelector('#stats-body .stats-cards') && document.querySelector('#stats-body .stats-models')",
                   "the Overview with cards", timeout=20)
            seen = b.js("""(() => ({
              crumb: document.getElementById('settings-crumb').textContent,
              cards: [...document.querySelectorAll('#stats-body .stats-card-label')].map((c) => c.textContent),
              days: document.querySelectorAll('#stats-body .stats-day').length,
              bars: document.querySelectorAll('#stats-body .stats-day :is(.stats-io, .stats-cache)').length,
              models: [...document.querySelectorAll('#stats-body .stats-models tbody tr')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
              sessions: [...document.querySelectorAll('#stats-body .stats-sessions tbody tr')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
            }))()""")
            if seen["crumb"] != "Stats & Usage" or seen["cards"] != ["Total tokens", "Input and output", "Sessions", "Active days"]:
                raise Failure(f"the section reads {seen}")
            if seen["days"] != 30 or seen["bars"] < 2:
                raise Failure(f"the chart should have 30 days with bars on the used ones: {seen}")
            claude = next((m for m in seen["models"] if m.startswith("claude-statsfixture-1")), "")
            codex = next((m for m in seen["models"] if m.startswith("gpt-statsfixture")), "")
            if "Claude" not in claude or "25.0k" not in claude or "Codex" not in codex or "4.6k" not in codex:
                raise Failure(f"the models read {seen['models']}")
            if not any(s.startswith("stats-demo") and "claude-statsfixture-1" in s for s in seen["sessions"]) or not any(s.startswith("stats-api") for s in seen["sessions"]):
                raise Failure(f"the sessions read {seen['sessions']}")
            b.click('#stats-usage [data-stats-tab="codex"]')
            b.wait("document.querySelector('[data-stats-tab=\"codex\"]').getAttribute('aria-selected') === 'true' && ![...document.querySelectorAll('#stats-body .stats-models tbody tr')].some((r) => r.textContent.includes('claude-'))",
                   "only Codex in its tab")
            if b.js("document.querySelector('#stats-body .stats-agent')"):
                raise Failure("one agent's tab should not label rows with the agent")
            b.click('#stats-usage [data-stats-days="7"]')
            b.wait("document.querySelectorAll('#stats-body .stats-day').length === 7", "a 7-day chart")
            self.check_errors("Stats & Usage")
            b.viewport(390, 844, 3)
            try:
                b.goto(self.url("/settings#stats-usage"))
                b.wait("document.querySelector('#stats-body .stats-cards')", "Stats & Usage on a phone", timeout=20)
                phone = b.js("""(() => ({
                  sideways: document.documentElement.scrollWidth > innerWidth,
                  tab: Math.round(document.querySelector('[data-stats-tab]').getBoundingClientRect().height),
                }))()""")
                if phone["sideways"] or phone["tab"] < 36:
                    raise Failure(f"Stats & Usage on a phone: {phone}")
            finally:
                b.viewport(1280, 800)
        finally:
            b.js("localStorage.removeItem('yardbell.stats.days'); localStorage.removeItem('yardbell.stats.tab')")

    def drop_live(self, up):
        self.b.js(f"""(() => {{
          window.__liveConnected = window.__liveConnected || window.YardbellLive.connected;
          window.YardbellLive.connected = {'window.__liveConnected' if up else '() => false'};
          dispatchEvent(new CustomEvent('yardbell-live', {{ detail: {{ open: {'true' if up else 'false'} }} }}));
        }})()""")

    def test_sidebar_foot_has_the_status_and_no_page_has_a_bottom_bar(self):
        b = self.b
        b.goto(self.url("/workspace"))
        b.wait("document.querySelector('#col .col-foot #status-group #status-live.up')", "the connection dot in the sidebar's foot")
        self.mock_usage("""{ windows: [{ label: "5 hour", used: 0.42, resets_at: Math.floor(Date.now() / 1000) + 7200, status: "allowed" }],
          codex: { seen: new Date().toISOString(), windows: [{ label: "5 hour", used: 0.42, resets_at: 4102444800, status: "allowed" }] }, runs_on: "codex" }""")
        b.wait("document.querySelector('#usage-card')?.textContent.includes('Codex') && document.querySelector('#usage-card').textContent.includes('42%')",
               "an older server's figures in the usage card")
        seen = b.js("""(() => {
          const foot = document.querySelector('#col .col-foot');
          const group = document.getElementById('status-group');
          return {
            bar: Boolean(document.getElementById('strip') || document.querySelector('.strip')),
            rows: getComputedStyle(document.getElementById('shell')).gridTemplateRows.split(' ').length,
            mainBottom: Math.round(document.getElementById('main').getBoundingClientRect().bottom),
            tall: innerHeight,
            footText: foot.textContent,
            right: Math.round(group.getBoundingClientRect().right) > Math.round(foot.getBoundingClientRect().right) - 20,
            live: document.getElementById('status-live').title,
            ports: document.getElementById('status-ports'),
          };
        })()""")
        if seen["bar"] or seen["rows"] != 1 or seen["mainBottom"] != seen["tall"]:
            raise Failure(f"the page should have no bottom bar and fill the window: {seen}")
        if "%" in seen["footText"] or "hp" in seen["footText"]:
            raise Failure(f"the foot should not repeat machine memory: {seen['footText']!r}")
        if not seen["right"] or seen["live"] != "Live" or seen["ports"]:
            raise Failure(f"the foot's status reads {seen}")
        self.drop_live(False)
        b.wait("document.getElementById('status-live').classList.contains('down') && document.getElementById('status-live').title === 'Reconnecting'", "the dot to say Reconnecting")
        if not b.js("document.getElementById('conn-banner').hidden"):
            raise Failure("the banner should wait 3 seconds before it shows")
        b.wait("!document.getElementById('conn-banner').hidden", "the reconnecting banner after the delay", timeout=6)
        banner = b.js("""(() => {
          const box = document.getElementById('conn-banner').getBoundingClientRect();
          const main = document.getElementById('main').getBoundingClientRect();
          return { text: document.getElementById('conn-banner').textContent, inside: box.left >= main.left && box.right <= main.right && box.top < main.top + 60 };
        })()""")
        if banner["text"] != "Reconnecting to Yardbell…" or not banner["inside"]:
            raise Failure(f"the banner reads {banner}")
        self.drop_live(True)
        b.wait("document.getElementById('conn-banner').hidden && document.getElementById('status-live').classList.contains('up')", "the banner gone when live again")
        for path in ("/", "/dispatch", "/pipeline", "/settings", "/add", "/diagrams", "/proposals"):
            b.goto(self.url(path))
            b.wait("document.getElementById('shell') && document.getElementById('status-group')", f"the shell on {path}")
            if b.js("Boolean(document.getElementById('strip') || document.querySelector('.strip'))"):
                raise Failure(f"{path} still renders a bottom bar")
        visible = b.js("document.getElementById('status-group').checkVisibility() || document.getElementById('usage-card').checkVisibility()")
        b.goto(self.url("/settings"))
        b.wait("document.querySelector('#col-body .settings-back')", "Settings")
        if b.js("document.getElementById('status-group').checkVisibility() || document.getElementById('usage-card').checkVisibility()"):
            raise Failure("Settings' column should show no status or usage")
        if not visible:
            raise Failure("the status should show on a page with the sidebar")
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            b.wait("document.getElementById('tab-more')", "the tab bar on a phone")
            if b.js("document.getElementById('status-group').checkVisibility()"):
                raise Failure("the foot's status should not show on a phone")
        finally:
            b.viewport(1280, 800)
        self.check_errors("the sidebar foot")

    def test_rail_stacks_the_status_and_machine_trouble_shows_in_the_card(self):
        b = self.b
        b.goto(self.url("/workspace"))
        b.wait("window.YardbellShell?.lastState && document.getElementById('status-live')", "the shell with its state")
        try:
            b.js("window.YardbellShell.collapse(true)")
            self.mock_usage()
            b.wait("document.querySelector('#rail #status-group.in-rail #status-live') && !document.getElementById('rail-usage').hidden", "the status in the rail")
            order = b.js("""[...document.getElementById('rail').children].filter((el) => el.checkVisibility())
              .map((el) => el.id || (el.hasAttribute('data-theme-toggle') ? 'theme' : el.className)).slice(-4)""")
            if order != ["rail-usage", "status-group", "theme", "logout"]:
                raise Failure(f"the rail's bottom group reads {order}")
            b.js(f"""(() => {{
              const s = structuredClone(window.YardbellShell.lastState);
              s.machines = [{{ name: {json.dumps(MACHINE)}, up: true, health: {{ mem_total_kb: 100, mem_used_kb: 30 }} }}, {{ name: 'pro', up: false, health: null }},
                            {{ name: 'mini', up: true, health: {{ mem_total_kb: 100, mem_used_kb: 93 }} }}];
              const update = window.YardbellStrip.update;
              window.YardbellStrip.update = () => update(s);
              window.YardbellStrip.update();
            }})()""")
            b.js("window.YardbellShell.collapse(false)")
            b.wait("document.querySelectorAll('#usage-card .usage-trouble').length === 2", "a warning line for each machine in trouble")
            trouble = b.js("[...document.querySelectorAll('#usage-card .usage-trouble')].map((t) => [t.dataset.machine, t.classList.contains('bad'), t.textContent.trim()])")
            if trouble != [["pro", True, "pro: offline"], ["mini", False, "mini: memory at 93%"]]:
                raise Failure(f"the card's machine lines read {trouble}")
            b.click("#usage-card")
            b.wait("document.querySelectorAll('#usage-sheet .usage-machines .usage-win').length === 3", "the Machines section in the sheet")
            rows = b.js("""[...document.querySelectorAll('#usage-sheet .usage-machines .usage-win')].map((r) => [r.dataset.machine,
              r.querySelector('.usage-win-pct').textContent, r.querySelector('.usage-meter').classList.contains('warn') ? 'warn' : r.querySelector('.usage-meter').classList.contains('bad') ? 'bad' : 'ok'])""")
            if rows != [["pro", "offline", "bad"], ["mini", "93%", "warn"], [MACHINE, "30%", "ok"]]:
                raise Failure(f"the sheet's machines read {rows}")
            b.key("Escape")
        finally:
            b.js("window.YardbellShell.collapse(false)")
            b.goto(self.url("/workspace"))

    def test_phone_more_has_keep_awake_and_ports(self):
        b = self.b
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/"))
            b.wait("window.YardbellShell?.lastState && document.getElementById('tab-more')", "the tab bar on a phone")
            b.js(f"""(() => {{
              const s = structuredClone(window.YardbellShell.lastState);
              s.sessions = [{{ machine: {json.dumps(MACHINE)}, ports: [{{ service: 'rails', remote: 3000, local: 13000, status: 'tunnel up', url: 'http://127.0.0.1:13000' }}] }}];
              const update = window.YardbellStrip.update;
              window.YardbellStrip.update = () => update(s);
              window.YardbellStrip.update();
            }})()""")
            b.click("#tab-more")
            b.wait("!document.getElementById('tab-menu').hidden", "the More menu")
            rows = b.js("""[...document.querySelectorAll('#tab-menu [data-status-open]')].map((r) => [r.dataset.statusOpen,
              r.querySelector('.menu-label').textContent, r.querySelector('.menu-note').textContent])""")
            if [r[:2] for r in rows] != [["awake", "Keep computer awake"], ["ports", "Live ports"]] or rows[1][2] != "1" or " · " not in rows[0][2]:
                raise Failure(f"the More menu's status rows read {rows}")
            b.click("#tab-menu [data-status-open=ports]")
            b.wait("!document.getElementById('ports-pop').hidden && document.getElementById('tab-menu').hidden", "the ports popover from More")
            box = b.js("(() => { const r = document.getElementById('ports-pop').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, tall: innerHeight, wide: innerWidth }; })()")
            if box["left"] < 0 or box["right"] > box["wide"] or box["bottom"] > box["tall"]:
                raise Failure(f"the ports popover leaves the screen: {box}")
            b.key("Escape")
            b.wait("document.getElementById('ports-pop').hidden", "Escape to close it")
            b.click("#tab-more")
            b.click("#tab-menu [data-status-open=awake]")
            b.wait("!document.getElementById('awake-pop').hidden", "the Keep computer awake popover from More")
            b.key("Escape")
        finally:
            b.viewport(1280, 800)

    def open_new_session(self, path):
        self.b.wait("window.YardbellShell.lastState", "the state on the page")
        self.b.js(f"""(() => {{
          window.__started = null;
          const s = window.YardbellShell.lastState;
          window.YardbellNewSession.open({{ machines: [{json.dumps(MACHINE)}], machine: {json.dumps(MACHINE)}, agents: s.agents,
            defaultAgent: s.default_agent, path: {json.dumps(path)}, onStart: (body) => {{ window.__started = body; }}, onError: () => {{}} }});
        }})()""")
        self.b.wait("document.getElementById('new-dialog')?.open", "the New session dialog")

    def test_newsession_dialog_layout(self):
        b = self.b
        b.goto(self.url("/workspace"))
        self.open_new_session(os.path.join(self.y.root, "demo-app"))
        b.wait("!document.getElementById('branch-step').hidden && document.getElementById('nd-project-name').textContent.endsWith('demo-app')",
               "demo-app as the project, with Create from")
        seen = b.js("""(() => ({
          title: document.getElementById('new-title').textContent,
          labels: [...document.querySelectorAll('#new-dialog .nd-label')].map((l) => l.textContent.trim()),
          tabs: [...document.querySelectorAll('#new-dialog .nd-tab')].map((t) => t.textContent.trim()),
          checked: document.querySelector('#new-form input[name=mode]:checked').value,
          start: document.getElementById('start-btn').textContent.replace(/\\s+/g, ' ').trim(),
          advanced: document.getElementById('nd-advanced').open,
          resume: Boolean(document.querySelector('#nd-advanced input[name=resume]')),
          machine: document.getElementById('new-machine').value,
        }))()""")
        if seen["title"] != "New session":
            raise Failure(f"the dialog is titled {seen['title']!r}")
        if seen["labels"] != ["Project", "Run on", "Create from [Optional]", "Agent [Optional]"]:
            raise Failure(f"the fields read {seen['labels']}")
        if seen["tabs"] != ["Current", "Branch", "Name"] or seen["checked"] != "stay":
            raise Failure(f"the Create from tabs read {seen['tabs']} with {seen['checked']} picked")
        if not seen["start"].startswith("Start session"):
            raise Failure(f"the start button reads {seen['start']!r}")
        if seen["advanced"] or not seen["resume"]:
            raise Failure(f"Advanced should start closed and hold the resume switch: {seen}")
        if seen["machine"] != MACHINE:
            raise Failure(f"Run on reads {seen['machine']!r}")
        b.click("#nd-project")
        b.wait("document.getElementById('nd-browser').hidden && document.getElementById('nd-project').getAttribute('aria-expanded') === 'false'",
               "Project to fold the folder browser away")
        b.click("#nd-project")
        b.wait("!document.getElementById('nd-browser').hidden", "Project to show the folder browser again")
        b.click("#new-form .nd-tab:has(input[value=new])")
        b.wait("!document.getElementById('new-body').hidden && document.getElementById('stay-body').hidden && document.getElementById('start-btn').disabled",
               "the Name tab to ask for a branch name")
        b.click("#new-branch")
        b.type("eng-1-try")
        b.wait("!document.getElementById('start-btn').disabled", "a valid name to enable Start session")
        b.key("Enter", "Control")
        started = b.wait("window.__started", "Ctrl+Enter to start the session")
        if started.get("branch") != "eng-1-try" or not started.get("new_branch") or not started.get("path", "").endswith("demo-app"):
            raise Failure(f"Ctrl+Enter started {started}")
        if b.js("document.getElementById('new-dialog').open"):
            raise Failure("the dialog stayed open after starting")
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            self.open_new_session(os.path.join(self.y.root, "demo-app"))
            b.wait("!document.getElementById('branch-step').hidden", "Create from on a phone")
            fit = b.js("""(() => {
              const d = document.getElementById('new-dialog').getBoundingClientRect();
              const body = document.querySelector('#new-dialog .nd-body');
              return { width: Math.round(d.width), page: document.documentElement.scrollWidth, sideways: body.scrollWidth > body.clientWidth };
            })()""")
            if fit["width"] != 390 or fit["page"] > 390 or fit["sideways"]:
                raise Failure(f"the dialog does not fit a phone: {fit}")
            b.key("Escape")
        finally:
            b.viewport(1280, 800)
        self.check_errors("the New session dialog")

    def test_workspace_add_project_keeps_the_folder(self):
        b = self.b
        lab = os.path.join(self.y.root, "lab")
        os.makedirs(os.path.join(lab, "kept-proj"), exist_ok=True)
        before = self.storage(["yardbell.ws.kept"])
        try:
            self.put_storage({"yardbell.ws.kept": None})
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('#col-body .tree') && window.YardbellShell.lastState", "the tree")
            b.click("#side-add-project")
            b.wait("document.getElementById('add-project')?.open", "the Add a project dialog")
            ways = b.js("document.getElementById('ap-choices').textContent.replace(/\\s+/g, ' ')")
            if "Browse folder" not in ways or "Clone" in ways:
                raise Failure(f"the dialog offers {ways!r}")
            b.click("#ap-browse")
            b.click("#ap-list [data-ap-path$='/lab']")
            b.click("#ap-list [data-ap-path$='/lab/kept-proj']")
            b.wait("document.getElementById('ap-where').textContent.includes('kept-proj') && !document.getElementById('ap-add').disabled",
                   "kept-proj ready to add")
            b.click("#ap-add")
            b.wait("!document.getElementById('add-project').open && (localStorage.getItem('yardbell.ws.kept') || '').includes('/lab/kept-proj')",
                   "the folder kept in this browser")
            kept = b.js("JSON.parse(localStorage.getItem('yardbell.ws.kept'))")
            if len(kept) != 1 or kept[0]["machine"] != MACHINE or not kept[0]["path"].endswith("/lab/kept-proj"):
                raise Failure(f"the browser keeps {kept}")
            folder = kept[0]["folder"]
            row = f"#col-body .tree-card.current .tree-folder[data-folder={json.dumps(folder)}]"
            b.wait(f"document.querySelector({json.dumps(row)}) && project() === {json.dumps(MACHINE + chr(9) + folder)}",
                   f"the kept folder {folder} in the tree, selected")
            self.settle()
            b.goto(self.url("/workspace"))
            b.wait(f"document.querySelector({json.dumps(f'#col-body .tree-folder[data-folder={json.dumps(folder)}]')})", "the kept folder after a reload")
            self.check_errors("adding a project")
        finally:
            self.put_storage(before)
            shutil.rmtree(lab, ignore_errors=True)

    def test_sidebar_foot_ports_popover(self):
        b = self.b
        b.goto(self.url("/workspace"))
        b.wait("window.YardbellShell.lastState && document.getElementById('status-group')", "the status in the sidebar's foot")
        b.js(f"""(() => {{
          const s = structuredClone(window.YardbellShell.lastState);
          const rails = {{ service: 'rails', remote: 3000, local: 13000, status: 'tunnel up', url: 'http://127.0.0.1:13000' }};
          const mail = {{ service: 'mailpit', remote: 8025, local: null, status: 'not forwardable', url: null }};
          s.sessions = [
            {{ machine: {json.dumps(MACHINE)}, ports: [rails, mail] }},
            {{ machine: {json.dumps(MACHINE)}, ports: [rails] }},
            {{ machine: 'pro', ports: [{{ service: 'vite', remote: 5173, local: 25173, status: 'tunnel up', url: 'http://127.0.0.1:25173' }}] }},
          ];
          const update = window.YardbellStrip.update;
          window.YardbellStrip.update = () => update(s);
          window.YardbellStrip.update();
        }})()""")
        b.wait("document.querySelector('#status-ports .status-count')?.textContent === '3'", "three live ports in the foot")
        b.click("#status-ports")
        b.wait("!document.getElementById('ports-pop').hidden", "the ports popover")
        seen = b.js("""(() => {
          const pop = document.getElementById('ports-pop');
          return {
            title: pop.querySelector('.strip-pop-title').textContent.replace(/\\s+/g, ' ').trim(),
            machines: [...pop.querySelectorAll('.ports-machine span:first-of-type')].map((s) => s.textContent),
            links: [...pop.querySelectorAll('a.ports-row')].map((a) => [a.querySelector('.ports-num').textContent, a.getAttribute('href'), a.target]),
            idle: [...pop.querySelectorAll('div.ports-row')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim()),
            expanded: document.getElementById('status-ports').getAttribute('aria-expanded'),
            inFoot: Boolean(document.querySelector('#col .col-foot #status-ports')),
            above: (() => {
              const p = pop.getBoundingClientRect();
              const btn = document.getElementById('status-ports').getBoundingClientRect();
              return p.bottom <= btn.top && p.left >= 0 && p.right <= innerWidth && p.top >= 0;
            })(),
          };
        })()""")
        if not seen["inFoot"] or not seen["above"]:
            raise Failure(f"the ports popover should open above its button in the foot, inside the window: {seen}")
        if seen["title"] != "Live ports (3)":
            raise Failure(f"the popover is titled {seen['title']!r}")
        if seen["machines"] != [MACHINE, "pro"]:
            raise Failure(f"the ports are grouped as {seen['machines']}")
        if seen["links"] != [["13000", "http://127.0.0.1:13000", "_blank"], ["25173", "http://127.0.0.1:25173", "_blank"]]:
            raise Failure(f"the forwarded ports link to {seen['links']}")
        if len(seen["idle"]) != 1 or "8025" not in seen["idle"][0] or "not forwardable" not in seen["idle"][0]:
            raise Failure(f"the port that is not forwarded reads {seen['idle']}")
        if seen["expanded"] != "true":
            raise Failure("the ports button does not say its popover is open")
        b.key("Escape")
        b.wait("document.getElementById('ports-pop').hidden && document.activeElement?.id === 'status-ports'", "Escape to close the popover")
        self.check_errors("the ports popover")

    def inhibitor_pids(self):
        try:
            with open(self.y.inhibits) as f:
                return [int(line.split()[0]) for line in f if line.strip()]
        except FileNotFoundError:
            return []

    def test_keep_awake_popover_and_setting(self):
        b = self.b
        self.api("POST", "/api/settings/keep-awake", {"mode": "off"})
        try:
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('#status-awake[data-mode=off]')", "Off in the foot")
            b.click("#status-awake")
            b.wait("!document.getElementById('awake-pop').hidden", "the Keep computer awake popover")
            seen = b.js("""(() => {
              const pop = document.getElementById('awake-pop');
              return {
                options: [...pop.querySelectorAll('.awake-label')].map((l) => l.textContent),
                checked: pop.querySelector('[aria-checked=true]')?.dataset.awake,
                note: pop.querySelector('.strip-pop-note').textContent,
              };
            })()""")
            if seen["options"] != ["On", "While agents work", "Off"] or seen["checked"] != "off" or seen["note"] != "Off · Inactive":
                raise Failure(f"the popover reads {seen}")
            b.click("#awake-pop [data-awake=agent]")
            note = b.wait("(document.querySelector('#awake-pop .strip-pop-note')?.textContent || '').startsWith('Agent · ')"
                          " && document.querySelector('#awake-pop .strip-pop-note').textContent", "While agents work in the popover")
            # The machine is this computer, so an agent working outside the suite counts too.
            working = b.js("(async () => (await (await fetch('/state')).json()).keep_awake.working)()")
            if note != ("Agent · Active" if working else "Agent · Inactive"):
                raise Failure(f"While agents work reads {note!r} with an agent {'working' if working else 'idle'}")
            if not working and self.inhibitor_pids():
                raise Failure("While agents work took the inhibitor with no agent working")
            b.click("#awake-pop [data-awake=on]")
            b.wait("document.querySelector('#awake-pop .strip-pop-note')?.textContent === 'On · Active'"
                   " && document.querySelector('#status-awake.holding')", "On to hold the computer awake")
            pids = self.inhibitor_pids()
            if len(pids) != 1:
                raise Failure(f"systemd-inhibit was started {len(pids)} times")
            with open(self.y.inhibits) as f:
                if "--what=idle:sleep" not in f.read():
                    raise Failure("systemd-inhibit was not asked to hold idle and sleep")
            os.kill(pids[0], 0)
            with open(self.y.config) as f:
                if "keep_awake: on" not in f.read():
                    raise Failure("On was not saved in yardbell.yml")
            b.goto(self.url("/settings#power"))
            b.wait("document.querySelector('#power input[value=on]')?.checked"
                   " && document.getElementById('awake-desc').textContent.includes('Holding it awake now with systemd-inhibit')",
                   "On in Settings, holding")
            b.click("#power .set-seg label:has(input[value=off])")
            deadline = time.time() + 10
            while True:
                try:
                    os.kill(pids[0], 0)
                except ProcessLookupError:
                    break
                if time.time() > deadline:
                    raise Failure("the inhibitor is still running after Off")
                b.pump(0.2)
            with open(self.y.config) as f:
                if "keep_awake" in f.read():
                    raise Failure("Off left keep_awake in yardbell.yml")
            self.check_errors("keep computer awake")
        finally:
            self.api("POST", "/api/settings/keep-awake", {"mode": "off"})

    def palette_sessions(self, names):
        made = []
        for name in names:
            if self.y.tmux("has-session", "-t", f"={name}").returncode == 0:
                continue
            r = self.y.tmux("new", "-d", "-s", name, "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
            if r.returncode:
                raise Failure(f"tmux new failed: {r.stderr}")
            made.append(name)
        self.api("POST", "/refresh")
        return made

    def drop_palette_sessions(self, made):
        for name in made:
            self.y.tmux("kill-session", "-t", f"={name}")
        if made:
            self.api("POST", "/refresh")

    def workspace_with(self, keys):
        self.put_storage({"workspace.v5": None, "yardbell.dispatch": "closed"})
        self.b.goto(self.url("/workspace"))
        self.b.wait(f"typeof sessionFor === 'function' && {json.dumps(keys)}.every((k) => sessionFor(k))",
                    "the sessions in the Workspace", timeout=15)

    def test_palette_lists_what_needs_you_first_and_jumps(self):
        b = self.b
        keys = [f"{MACHINE}/hp-demo-api-{i}" for i in (1, 2)]
        before = self.storage(self.LAYOUT + ("yardbell.tree.seen",))
        made = self.palette_sessions([k.split("/", 1)[1] for k in keys])
        try:
            self.workspace_with(keys)
            b.js(f"""(() => {{
              const seen = Object.fromEntries(sessions().map((s) => [keyOf(s), stateOf(s)]));
              seen[{json.dumps(keys[1])}] = 'working';
              localStorage.setItem('yardbell.tree.seen', JSON.stringify(seen));
            }})()""")
            b.key("k", "Control")
            b.wait("document.getElementById('palette')?.open", "Ctrl+K to open the palette")
            first = b.wait("document.querySelector('#palette-list li[data-href*=\"open=\"]')?.dataset.href", "a session in the palette")
            if first != "/workspace?open=" + urllib.parse.quote(keys[1], safe=""):
                raise Failure(f"the first session in the palette is {first}, not the one changed since it was looked at")
            b.type("#84")
            b.wait("document.querySelector('#palette-list li[aria-selected=true]')?.dataset.href === '/pipeline?p=review&tab=runs&run=run-c'",
                   "#84 to find the run on merge request 84")
            b.key("ArrowDown")
            b.key("ArrowUp")
            b.wait("document.querySelector('#palette-list li[aria-selected=true]')?.dataset.href.endsWith('run=run-c')", "the arrows to move the selection")
            for _ in "#84":
                b.key("Backspace")
            b.type("demo-api-1")
            b.wait(f"document.querySelector('#palette-list li[aria-selected=true]')?.dataset.href === {json.dumps('/workspace?open=' + urllib.parse.quote(keys[0], safe=''))}",
                   "the typed session to be selected")
            b.key("Enter")
            b.wait(f"!document.getElementById('palette').open && focusedLeaf()?.key === {json.dumps(keys[0])}"
                   f" && document.querySelector('.ws-pane:not([hidden]) iframe[data-key=\"{keys[0]}\"]') && location.pathname === '/workspace'",
                   "Enter to open the session in a pane and close the palette", timeout=15)
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_palette_sessions(made)

    def test_ctrl_k_in_a_terminal_opens_the_palette_and_ctrl_j_still_reaches_it(self):
        b = self.b
        key = f"{MACHINE}/hp-demo-api-1"
        frame = f'iframe[data-key="{key}"]'
        el = f"document.querySelector({json.dumps(frame)})"
        inside = lambda expr: f"{el}?.contentWindow?.eval({json.dumps(expr)})"
        before = self.storage(self.LAYOUT)
        made = self.palette_sessions([key.split("/", 1)[1]])
        try:
            self.workspace_with([key])
            b.js(f"open({json.dumps(key)})")
            b.wait(inside("typeof term === 'object' && Boolean(term.element) && screenText().length > 0"), "the terminal's prompt", timeout=15)
            b.click(frame)
            b.wait(f"document.activeElement === {el}", "the terminal to take the focus")
            # With the cursor at the start of the line, a Ctrl+K that reached the shell would kill it.
            b.type("echo ke''ep")
            b.key("\ue011")
            b.key("k", "Control")
            b.wait("document.getElementById('palette')?.open", "Ctrl+K in the terminal to open the palette")
            b.key("Escape")
            b.wait("!document.getElementById('palette').open", "Esc to close the palette")
            b.wait(f"document.activeElement === {el}", "the focus to go back to the terminal")
            b.key("\ue010")
            b.key("Enter")
            b.wait(inside("screenText().split('\\n').some((l) => l.trim() === 'keep')"), "the line typed before Ctrl+K to run whole", timeout=15)
            b.click(frame)
            b.type("printf 'a'")
            b.key("j", "Control")
            b.type("printf 'b'")
            b.key("j", "Control")
            # printf leaves no newline, so each output starts the line of the prompt after it.
            b.wait(inside("""(() => {
              const lines = screenText().split('\\n');
              const at = lines.findIndex((l) => l.startsWith('a') && l.includes("printf 'b'"));
              return at >= 0 && (lines[at + 1] || '').startsWith('b');
            })()"""), "Ctrl+J to run both commands", timeout=15)
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_palette_sessions(made)

    def test_ctrl_k_in_a_dispatch_pane_opens_the_palette(self):
        b = self.b
        frame = "document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]')"
        composer = f"{frame}.contentDocument.querySelector('#dispatch-input')"
        before = self.storage(self.LAYOUT)
        try:
            self.put_storage({"workspace.v5": None, "yardbell.dispatch": "closed"})
            b.goto(self.url("/workspace"))
            b.wait("typeof leaves === 'function' && state !== null", "the Workspace to load")
            b.js("openDispatch()")
            b.wait(f"{frame}?.contentDocument?.readyState === 'complete' && {frame}.contentWindow.location.pathname === '/dispatch'",
                   "Dispatch to load in its pane")
            b.js("focusPane(findDispatch().leaf.pane)")
            b.wait(f"document.activeElement === {frame} && {frame}.contentDocument.activeElement === {composer}", "the cursor in the composer")
            b.key("k", "Control")
            b.wait("document.getElementById('palette')?.open", "Ctrl+K in Dispatch to open the palette")
            if b.js(f"{composer}.value"):
                raise Failure("Ctrl+K reached the composer")
            b.key("Escape")
            b.wait("!document.getElementById('palette').open", "Esc to close the palette")
        finally:
            self.settle()
            self.put_storage(before)

    def test_palette_says_which_source_failed(self):
        b = self.b
        key = f"{MACHINE}/hp-demo-api-1"
        before = self.storage(self.LAYOUT)
        made = self.palette_sessions([key.split("/", 1)[1]])
        try:
            self.workspace_with([key])
            b.js("""(() => {
              const real = window.fetch;
              window.fetch = (url, opts) => String(url).startsWith('/api/runs') ? Promise.reject(new TypeError('offline')) : real(url, opts);
            })()""")
            b.js("document.activeElement?.blur()")
            b.key("k", "Control")
            b.wait("document.getElementById('palette')?.open", "Ctrl+K to open the palette")
            b.wait("document.querySelector('#palette .palette-note')?.textContent.trim() === \"Couldn't load runs\"", "the note for runs")
            b.wait(f"document.querySelector('#palette-list li[data-href=\"/workspace?open={urllib.parse.quote(key, safe='')}\"]')",
                   "the session to still list")
            b.wait("document.querySelector('#palette-list li[data-href=\"/settings\"]')", "the pages to still list")
            if b.js("document.querySelector('#palette-list li[data-href*=\"tab=runs\"]')"):
                raise Failure("a run listed although runs failed to load")
            b.key("Escape")
            b.wait("!document.getElementById('palette').open", "Esc to close the palette")
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_palette_sessions(made)

    def test_palette_closes_on_a_phone(self):
        b = self.b
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            b.wait("typeof leaves === 'function' && state !== null && document.body.classList.contains('ws-list')", "the Workspace on a phone")
            b.click("#col-search")
            b.wait("document.getElementById('palette')?.open", "the search button to open the palette")
            sheet = b.js("(() => { const r = document.getElementById('palette').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()")
            if sheet != [390, 844]:
                raise Failure(f"the palette on a phone is {sheet}, not a full-screen sheet")
            b.click("#palette .palette-close")
            b.wait("!document.getElementById('palette').open", "the close button to close the palette")
        finally:
            b.viewport(1280, 800)

    def demo_api_session(self):
        name = "hp-demo-api-1"
        made = self.y.tmux("has-session", "-t", f"={name}").returncode != 0
        if made:
            self.y.tmux("new", "-d", "-s", name, "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
        self.api("POST", "/refresh")
        return f"{MACHINE}/{name}", made

    def drop_demo_api_session(self, key, made):
        if not made:
            return
        self.y.tmux("kill-session", "-t", f"={key.split('/', 1)[1]}")
        self.api("POST", "/refresh")

    def test_workspace_terminal_fills_its_pane(self):
        b = self.b
        key, made = self.demo_api_session()
        frame = f"document.querySelector('.ws-pane:not([hidden]) iframe[data-key={json.dumps(key)}]')"
        before = self.storage(self.LAYOUT)
        try:
            b.goto(self.url("/workspace"))
            b.wait(f"state !== null && sessionFor({json.dumps(key)})", "the session in the Workspace", timeout=15)
            b.js(f"open({json.dumps(key)}); openDispatch()")
            b.wait(f"document.querySelector('.ws-pane:not([hidden]) iframe[data-dispatch]') && {frame}?.contentDocument?.querySelector('.xterm-screen')",
                   "the terminal beside a Dispatch pane", timeout=15)
            b.pump(0.5)
            got = b.js(f"""(() => {{
              const f = {frame};
              const doc = f.contentDocument.documentElement;
              return {{
                frame: Math.round(f.getBoundingClientRect().bottom),
                pane: Math.round(f.closest('.ws-pane').getBoundingClientRect().bottom),
                height: Math.round(f.getBoundingClientRect().height),
                inside: doc.clientHeight,
              }};
            }})()""")
            if abs(got["frame"] - got["pane"]) > 1:
                raise Failure(f"the terminal stops short of its pane: {got}")
            if abs(got["inside"] - got["height"]) > 1:
                raise Failure(f"the terminal page does not fill its frame, a scrollbar takes the bottom: {got}")
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_demo_api_session(key, made)

    PANEL = ("workspace.v5", "workspace.side")
    PAST_ID = "5f0c9a1e-0000-4000-8000-00000000beef"

    # Files of their own in demo-api, the Workspace on that folder with no session in focus, and
    # the right panel open on the tab asked for.
    def panel_on_demo_api(self, tab="files"):
        b = self.b
        folder = os.path.join(self.y.root, "demo-api")
        stuff = os.path.join(folder, "panel-demo")
        write(os.path.join(stuff, "app.js"), "// greets\nexport function greet(name) {\n  return `hi ${name}`;\n}\nconst answer = 42;\n")
        write(os.path.join(stuff, "notes.txt"), "a needle in the haystack\n")
        with open(os.path.join(stuff, "logo.bin"), "wb") as f:
            f.write(b"\x89PNG\x00\x00\x01binary")
        self.put_storage({"workspace.side": json.dumps({"open": False, "tab": tab, "width": 320})})
        b.goto(self.url("/workspace"))
        b.wait(f"state !== null && (state.folders || []).some((f) => f.path === {json.dumps(folder)})", "demo-api in the Workspace", timeout=15)
        b.js(f"""(() => {{
          const f = state.folders.find((f) => f.path === {json.dumps(folder)});
          saved.tabs = [];
          saved.hidden = sessions().map(keyOf);
          saved.folder = f.machine + SEP + f.label;
          save();
          render();
        }})()""")
        b.click("#panel-toggle")
        b.wait("!document.getElementById('ws-right').hidden", "the right panel to open")
        return folder

    def drop_panel_files(self):
        shutil.rmtree(os.path.join(self.y.root, "demo-api", "panel-demo"), ignore_errors=True)

    def set_input(self, selector, text):
        self.b.js(f"""(() => {{
          const i = document.querySelector({json.dumps(selector)});
          i.value = {json.dumps(text)};
          i.dispatchEvent(new Event('input'));
        }})()""")

    def test_workspace_panel_opens_resizes_and_remembers(self):
        b = self.b
        before = self.storage(self.PANEL)
        try:
            self.panel_on_demo_api()
            b.wait("""document.querySelector('#side-tree [data-dir="panel-demo"]') && document.querySelector('#side-tree [data-file="README.md"]')""",
                   "demo-api's folders and files in the tree")
            if b.js("document.getElementById('panel-toggle').getAttribute('aria-pressed')") != "true":
                raise Failure("the toggle does not show the panel as open")
            width = b.js("document.getElementById('ws-right').getBoundingClientRect().width")
            if abs(width - 320) > 2:
                raise Failure(f"the panel is {width}px wide, not the 320px it was given")
            grip = b.centre("#ws-right-grip")
            b.drag((grip["x"], grip["y"]), (grip["x"] - 100, grip["y"]))
            wider = b.js("document.getElementById('ws-right').getBoundingClientRect().width")
            if not 410 <= wider <= 430:
                raise Failure(f"dragging the edge 100px left made the panel {wider}px wide")
            b.goto(self.url("/workspace"))
            b.wait(f"!document.getElementById('ws-right').hidden && Math.abs(document.getElementById('ws-right').getBoundingClientRect().width - {round(wider)}) < 3",
                   "the panel open at its width after a reload")
            b.click("[data-side-tab=history]")
            b.wait("!document.querySelector('[data-side=history]').hidden && document.querySelector('[data-side=files]').hidden", "the History tab")
            b.click("#panel-toggle")
            b.wait("document.getElementById('ws-right').hidden && document.getElementById('panel-toggle').getAttribute('aria-pressed') === 'false'", "the panel to close")
            stored = json.loads(b.js("localStorage.getItem('workspace.side')"))
            if stored.get("open") or stored.get("tab") != "history":
                raise Failure(f"the panel stored {stored}")
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_panel_files()

    def test_workspace_panel_finds_files_by_name_and_contents(self):
        b = self.b
        before = self.storage(self.PANEL)
        found = "[...document.querySelectorAll('#side-tree .side-row')].map((r) => r.dataset.file).join()"
        try:
            self.panel_on_demo_api()
            b.wait("""document.querySelector('#side-tree [data-dir="panel-demo"]')""", "the tree")
            b.click("#side-find")
            b.type("APP")
            b.wait(f"{found} === 'panel-demo/app.js'", "only app.js found by name")
            b.click("[data-find=contents]")
            b.wait("document.querySelector('[data-find=contents]').getAttribute('aria-selected') === 'true'", "Contents to be picked")
            self.set_input("#side-find", "needle")
            b.wait(f"{found} === 'panel-demo/notes.txt'", "only notes.txt found by its contents")
            self.set_input("#side-find", "nothing-has-this")
            b.wait("document.getElementById('side-tree').textContent.includes('No file contains')", "a note that nothing matched")
            self.set_input("#side-find", "")
            b.wait("""document.querySelector('#side-tree [data-dir="panel-demo"]')""", "the tree again once the box is empty")
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_panel_files()

    def test_workspace_panel_opens_a_file_tab(self):
        b = self.b
        before = self.storage(self.PANEL)
        try:
            folder = self.panel_on_demo_api()
            b.click('#side-tree [data-dir="panel-demo"]')
            b.click('#side-tree [data-file="panel-demo/app.js"]')
            b.wait("document.querySelector('.ws-pane:not([hidden]) .ws-file-text .hl-keyword')", "app.js shown with colours")
            seen = b.js("""(() => {
              const pane = document.querySelector('.ws-pane:not([hidden])');
              return {
                tab: document.querySelector('#tabs .ws-tab.current .ws-tab-name').textContent,
                lines: pane.querySelector('.ws-file-gutter').textContent.split(String.fromCharCode(10)).length,
                keywords: [...pane.querySelectorAll('.hl-keyword')].map((k) => k.textContent),
                comment: pane.querySelector('.hl-comment')?.textContent,
                meta: pane.querySelector('.ws-file-meta').textContent,
                leaf: focusedLeaf(),
              };
            })()""")
            if seen["tab"] != "app.js" or seen["lines"] != 5:
                raise Failure(f"the file tab is wrong: {seen}")
            if not {"export", "function", "return", "const"} <= set(seen["keywords"]) or seen["comment"] != "// greets":
                raise Failure(f"the file is not coloured as JavaScript: {seen}")
            if "read only" not in seen["meta"]:
                raise Failure(f"the file tab does not say it is read only: {seen['meta']}")
            leaf = seen["leaf"]
            if (leaf.get("kind"), leaf.get("machine"), leaf.get("root"), leaf.get("path")) != ("file", MACHINE, folder, "panel-demo/app.js"):
                raise Failure(f"the file leaf is {leaf}")
            tabs = b.js("document.querySelectorAll('#tabs .ws-tab').length")
            b.click('#side-tree [data-file="panel-demo/app.js"]')
            b.pump(0.3)
            if b.js("document.querySelectorAll('#tabs .ws-tab').length") != tabs:
                raise Failure("opening the same file again made another tab")
            b.goto(self.url("/workspace"))
            b.wait("document.querySelector('#tabs .ws-tab.current')?.textContent.includes('app.js') && document.querySelector('.ws-pane:not([hidden]) .ws-file-text .hl-keyword')",
                   "the file tab back after a reload")
            b.click('#side-tree [data-dir="panel-demo"]')
            b.click('#side-tree [data-file="panel-demo/logo.bin"]')
            b.wait("document.querySelector('.ws-pane:not([hidden]) .ws-file-error')?.textContent.includes('is a binary file')", "a binary file refused with a reason")
            b.click(".ws-pane:not([hidden]) [data-act=more]")
            b.click("#ws-menu [role=menuitem]:last-child")
            b.wait("![...document.querySelectorAll('#tabs .ws-tab-name')].some((t) => t.textContent === 'logo.bin')", "the file tab closed")
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_panel_files()

    def past_session(self, folder):
        d = os.path.join(self.y.home, ".claude", "projects", re.sub(r"[^a-zA-Z0-9]", "-", folder))
        lines = [
            {"type": "user", "cwd": folder, "sessionId": self.PAST_ID, "message": {"role": "user", "content": "Add a health check to demo-api"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Added GET /health with a test. All tests pass."}]}},
            {"type": "ai-title", "aiTitle": "Health check for demo-api", "sessionId": self.PAST_ID},
        ]
        path = os.path.join(d, self.PAST_ID + ".jsonl")
        write(path, "".join(json.dumps(x, separators=(",", ":")) + "\n" for x in lines))
        return path

    def test_workspace_panel_lists_history_and_resumes(self):
        b = self.b
        before = self.storage(self.PANEL)
        transcript = self.past_session(os.path.join(self.y.root, "demo-api"))
        item = f".side-past[data-id='{self.PAST_ID}']"
        shown = f"document.querySelector({json.dumps(item)})"
        try:
            folder = self.panel_on_demo_api(tab="history")
            b.wait(shown, "the past session in History", timeout=15)
            seen = b.js(f"""(() => {{
              const el = {shown};
              return {{
                title: el.querySelector('.side-past-title').textContent,
                summary: el.querySelector('.side-past-sum').textContent,
                meta: el.querySelector('.side-past-meta').textContent,
              }};
            }})()""")
            if seen["title"] != "Health check for demo-api" or "Added GET /health" not in seen["summary"] or "2 msgs" not in seen["meta"]:
                raise Failure(f"the past session reads wrong: {seen}")
            b.click("#side-hist-find")
            b.type("zebra")
            b.wait(f"!{shown} && document.getElementById('side-hist-list').textContent.includes('No session matches')", "the search to hide it")
            self.set_input("#side-hist-find", "health")
            b.wait(shown, "the search to find it")
            b.click("[data-scope=all]")
            b.wait(f"document.querySelector({json.dumps(item + ' .side-past-folder')})", "All to name the folder of each session")
            # The real server would run claude here, so the test holds the request and reads it.
            b.js("""(() => {
              window.resumeAsked = null;
              const real = window.fetch;
              window.fetch = (url, init) => {
                if (String(url) === '/sessions' && init?.method === 'POST') {
                  window.resumeAsked = JSON.parse(init.body);
                  return Promise.resolve(new Response(JSON.stringify({ error: 'held by the test' }), { status: 409 }));
                }
                return real(url, init);
              };
            })()""")
            b.click(f"{item} [data-resume]")
            b.wait("document.getElementById('toast').textContent.includes('held by the test')", "the resume answer shown")
            asked = b.js("window.resumeAsked")
            want = {"machine": MACHINE, "path": folder, "agent": "claude", "resume_id": self.PAST_ID, "wait": True}
            if asked != want:
                raise Failure(f"Resume asked for {asked}, not {want}")
        finally:
            self.settle()
            self.put_storage(before)
            self.drop_panel_files()
            os.remove(transcript)

    def test_workspace_panel_is_hidden_on_a_phone(self):
        b = self.b
        before = self.storage(self.PANEL)
        self.put_storage({"workspace.side": json.dumps({"open": True, "tab": "files", "width": 320})})
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            b.wait("state !== null", "the Workspace on a phone", timeout=15)
            seen = b.js("""({
              panel: getComputedStyle(document.getElementById('ws-right')).display,
              toggle: getComputedStyle(document.getElementById('panel-toggle')).display,
              sideways: document.documentElement.scrollWidth > innerWidth,
            })""")
            if seen != {"panel": "none", "toggle": "none", "sideways": False}:
                raise Failure(f"the right panel shows on a phone: {seen}")
        finally:
            b.viewport(1280, 800, 1)
            self.put_storage(before)

    CHANGES = ("workspace.v5", "workspace.side", "workspace.notes", "workspace.diff.view")
    LONG = "".join(f"line {i}\n" for i in range(1, 41))

    # demo-api with a staged edit, an unstaged one in a long file and an untracked file, on top of
    # a fixture commit; the Workspace on that folder with the right panel open on Changes.
    def changes_on_demo_api(self, tab="changes"):
        b = self.b
        repo = os.path.join(self.y.root, "demo-api")
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        write(os.path.join(repo, "long.txt"), self.LONG)
        write(os.path.join(repo, "src", "app.js"), "export const answer = 1;\n")
        git("add", "long.txt", "src/app.js", cwd=repo)
        git("commit", "-q", "-m", "fixture", cwd=repo)
        git("config", "user.name", "Changes Test", cwd=repo)
        git("config", "user.email", "changes@example.invalid", cwd=repo)
        write(os.path.join(repo, "long.txt"), self.LONG.replace("line 20\n", "line twenty\n"))
        write(os.path.join(repo, "src", "app.js"), "export const answer = 2;\n// asked twice\n")
        git("add", "src/app.js", cwd=repo)
        write(os.path.join(repo, "notes.txt"), "a new note\n")
        self.put_storage({"workspace.side": json.dumps({"open": False, "tab": tab, "width": 360}), "workspace.notes": None, "workspace.diff.view": None})
        b.goto(self.url("/workspace"))
        b.wait(f"state !== null && (state.folders || []).some((f) => f.path === {json.dumps(repo)})", "demo-api in the Workspace", timeout=15)
        b.js(f"""(() => {{
          const f = state.folders.find((f) => f.path === {json.dumps(repo)});
          saved.tabs = [];
          saved.hidden = sessions().map(keyOf);
          saved.folder = f.machine + SEP + f.label;
          save();
          render();
        }})()""")
        b.click("#panel-toggle")
        b.wait("!document.getElementById('ws-right').hidden", "the right panel to open")
        return repo, head

    def drop_changes(self, repo, head):
        git("reset", "-q", "--hard", head, cwd=repo)
        git("clean", "-fdq", cwd=repo)
        git("config", "--remove-section", "user", cwd=repo)

    def changed_rows(self):
        return self.b.js("""[...document.querySelectorAll('#chg-list .chg-group, #chg-list .chg-row')].map((el) => el.classList.contains('chg-group')
          ? [...el.children].map((c) => c.textContent).join(' ')
          : [el.querySelector('.chg-st').textContent, el.dataset.path, el.dataset.staged, el.querySelector('.chg-stats').textContent].join(' '))""")

    def open_long_diff(self):
        b = self.b
        b.click('#chg-list [data-path="long.txt"]')
        b.wait("document.querySelector('.ws-pane:not([hidden]) .ws-diff-table')", "the diff of long.txt")

    def test_workspace_changes_lists_a_repo_with_counts(self):
        b = self.b
        before = self.storage(self.CHANGES)
        repo = head = None
        try:
            repo, head = self.changes_on_demo_api()
            b.wait("document.querySelector('#chg-list [data-path=\"notes.txt\"]')", "the changes listed", timeout=15)
            rows = self.changed_rows()
            want = ["Staged 1", "M src/app.js true +2-1", "Changes 1", "M long.txt false +1-1", "Untracked 1", "U notes.txt false +1-0"]
            if rows != want:
                raise Failure(f"the Changes tab lists {rows}, not {want}")
            seen = b.js("""({
              badge: document.getElementById('side-changes-count').textContent,
              hidden: document.getElementById('side-changes-count').hidden,
              branch: document.querySelector('#chg-branch .chg-branch-name')?.textContent,
              dir: document.querySelector('#chg-list [data-path="src/app.js"] .side-dir')?.textContent.replace(/\\u200e/g, ''),
              commit: document.getElementById('chg-commit-go').textContent,
              disabled: document.getElementById('chg-commit-go').disabled,
            })""")
            if seen != {"badge": "3", "hidden": False, "branch": "main", "dir": "src", "commit": "Commit 3 files", "disabled": True}:
                raise Failure(f"the Changes tab reads wrong: {seen}")
            write(os.path.join(repo, "later.txt"), "made while the tab is open\n")
            b.wait("document.querySelector('#chg-list [data-path=\"later.txt\"]') && document.getElementById('side-changes-count').textContent === '4'",
                   "a new file to show up on its own within a few seconds", timeout=12)
            b.click("[data-side-tab=files]")
            b.wait("document.querySelector('[data-side=changes]').hidden", "the Files tab")
            if b.js("document.getElementById('side-changes-count').hidden"):
                raise Failure("the count went away with the tab")
        finally:
            self.settle()
            self.put_storage(before)
            if repo:
                self.drop_changes(repo, head)

    def test_workspace_files_tree_marks_changed_files_and_folders(self):
        b = self.b
        before = self.storage(self.CHANGES)
        repo = head = None
        try:
            repo, head = self.changes_on_demo_api(tab="files")
            b.wait("document.querySelector('#side-tree [data-file=\"long.txt\"].chg-modified')", "long.txt marked as changed in the file tree", timeout=15)
            marks = b.js("""(() => {
              const row = (sel) => document.querySelector('#side-tree ' + sel);
              const mark = (sel) => { const r = row(sel); return r ? [[...r.classList].filter((c) => c.startsWith('chg-')).join(' '), r.querySelector('.side-mark')?.textContent || ''] : null; };
              return { long: mark('[data-file="long.txt"]'), notes: mark('[data-file="notes.txt"]'), src: mark('[data-dir="src"]') };
            })()""")
            want = {"long": ["chg-modified", "M"], "notes": ["chg-untracked", "U"], "src": ["chg-inside", ""]}
            if marks != want:
                raise Failure(f"the file tree marks changes as {marks}, not {want}")
            b.click("#side-tree [data-dir=\"src\"]")
            b.wait("document.querySelector('#side-tree [data-file=\"src/app.js\"].chg-modified .side-mark')?.textContent === 'M'", "src/app.js marked inside its folder")
            write(os.path.join(repo, "later.txt"), "made while the tree is open\n")
            b.wait("document.querySelector('#side-tree [data-file=\"later.txt\"].chg-untracked')", "a new file to appear, marked, without a refresh", timeout=15)
            if b.js("document.querySelector('#side-tree [data-file=\"README.md\"]')?.className.includes('chg-')"):
                raise Failure("an unchanged file is marked")
        finally:
            self.settle()
            self.put_storage(before)
            if repo:
                self.drop_changes(repo, head)

    def test_workspace_changes_diff_tab_unified_split_survives_reload(self):
        b = self.b
        before = self.storage(self.CHANGES)
        repo = head = None
        pane = ".ws-pane:not([hidden])"
        try:
            repo, head = self.changes_on_demo_api()
            self.open_long_diff()
            seen = b.js(f"""(() => {{
              const pane = document.querySelector('{pane}');
              const rows = [...pane.querySelectorAll('tr.dl.add, tr.dl.del')].map((r) => [r.className.replace('dl ', ''), r.querySelector('.dn.o').textContent, r.querySelector('.dn.n').textContent, r.querySelector('.dc').textContent.slice(1)]);
              return {{
                tab: document.querySelector('#tabs .ws-tab.current .ws-tab-name').textContent,
                rows,
                folds: [...pane.querySelectorAll('tr.dfold button')].map((b) => b.textContent),
                counts: pane.querySelector('.ws-diff-counts').textContent,
                leaf: focusedLeaf(),
              }};
            }})()""")
            if seen["tab"] != "long.txt" or seen["rows"] != [["del", "20", "", "line 20"], ["add", "", "20", "line twenty"]]:
                raise Failure(f"the unified diff is wrong: {seen}")
            if seen["folds"] != ["Show 16 lines", "Show 17 lines"] or seen["counts"] != "+1-1":
                raise Failure(f"the unchanged lines do not fold as they should: {seen}")
            leaf = seen["leaf"]
            if (leaf.get("kind"), leaf.get("machine"), leaf.get("root"), leaf.get("path"), leaf.get("staged")) != ("diff", MACHINE, repo, "long.txt", False):
                raise Failure(f"the diff leaf is {leaf}")
            b.click(f"{pane} tr.dfold button")
            b.wait(f"document.querySelectorAll('{pane} tr.dfold').length === 1 && [...document.querySelectorAll('{pane} tr.dl .dn.n')].some((n) => n.textContent === '1')",
                   "the first 16 lines shown")
            b.click(f"{pane} [data-view=split]")
            b.wait(f"document.querySelector('{pane} .ws-diff-table.split')", "the split view")
            pair = b.js(f"""(() => {{
              const r = document.querySelector('{pane} tr.pair');
              return [r.className, r.querySelector('.dc.left').textContent.slice(1), r.querySelector('.dc.right').textContent.slice(1), r.querySelector('.dn.o').textContent, r.querySelector('.dn.n').textContent];
            }})()""")
            if pair != ["dl pair has-del has-add", "line 20", "line twenty", "20", "20"]:
                raise Failure(f"the split view pairs the lines wrong: {pair}")
            if json.loads(b.js("localStorage.getItem('workspace.diff.view')")) != "split":
                raise Failure("the split view is not remembered")
            tabs = b.js("document.querySelectorAll('#tabs .ws-tab').length")
            self.open_long_diff()
            b.pump(0.3)
            if b.js("document.querySelectorAll('#tabs .ws-tab').length") != tabs:
                raise Failure("opening the same diff again made another tab")
            b.goto(self.url("/workspace"))
            b.wait(f"document.querySelector('#tabs .ws-tab.current')?.textContent.includes('long.txt') && document.querySelector('{pane} .ws-diff-table.split tr.pair')",
                   "the diff tab back in the split view after a reload", timeout=15)
            b.click('#chg-list [data-path="src/app.js"]')
            b.wait(f"document.querySelector('#tabs .ws-tab.current')?.textContent.includes('app.js (staged)') && document.querySelector('{pane} .ws-diff-table .hl-keyword')",
                   "the staged diff of app.js coloured as JavaScript")
            got = b.js(f"""(() => {{
              const pane = document.querySelector('{pane}');
              return {{
                side: pane.querySelector('.ws-diff-side').textContent,
                left: [...pane.querySelectorAll('tr.pair .dc.left:not(.dvoid)')].map((c) => c.textContent.slice(1)),
                right: [...pane.querySelectorAll('tr.pair .dc.right:not(.dvoid)')].map((c) => c.textContent.slice(1)),
                keywords: [...pane.querySelectorAll('.hl-keyword')].map((k) => k.textContent),
              }};
            }})()""")
            if got["side"] != "Staged" or got["left"] != ["export const answer = 1;"] or got["right"] != ["export const answer = 2;", "// asked twice"]:
                raise Failure(f"the staged diff is wrong: {got}")
            if not {"export", "const"} <= set(got["keywords"]):
                raise Failure(f"the staged diff is not coloured: {got}")
            b.click(f"{pane} [data-view=unified]")
            b.wait(f"document.querySelector('{pane} .ws-diff-table.unified')", "the unified view again")
        finally:
            self.settle()
            self.put_storage(before)
            if repo:
                self.drop_changes(repo, head)

    def notes_stored(self):
        return json.loads(self.b.js("localStorage.getItem('workspace.notes') || '{}'"))

    def test_workspace_diff_line_notes_add_edit_remove(self):
        b = self.b
        before = self.storage(self.CHANGES)
        repo = head = None
        pane = ".ws-pane:not([hidden])"
        try:
            repo, head = self.changes_on_demo_api()
            self.open_long_diff()
            b.click(f'{pane} .dplus[data-at="new:20"]')
            b.wait(f"document.activeElement?.matches('{pane} .dnote-box')", "a note box under the line, focused")
            b.type("Use a word here")
            b.click(f"{pane} [data-act=save-note]")
            b.wait(f"document.querySelector('{pane} .dnote .dnote-text')?.textContent === 'Use a word here'", "the note under its line")
            stored = self.notes_stored()
            key = "\n".join([MACHINE, repo, "long.txt", "worktree"])
            notes = stored.get(key, [])
            if len(notes) != 1 or (notes[0]["side"], notes[0]["line"], notes[0]["code"], notes[0]["text"]) != ("new", 20, "line twenty", "Use a word here"):
                raise Failure(f"the note is stored as {stored}")
            row = b.js(f"document.querySelector('{pane} tr.dnote-row').previousElementSibling.querySelector('.dc').textContent")
            if row != "+line twenty":
                raise Failure(f"the note is not under its line but under {row!r}")
            b.wait("document.querySelector('#chg-list [data-path=\"long.txt\"] .chg-noted')?.textContent === '1' && document.getElementById('chg-send-all').textContent === 'Send notes (1)' && !document.getElementById('chg-send-all').hidden",
                   "the Changes tab to count the note")
            if b.js(f"document.querySelector('{pane} [data-act=send-notes]').textContent") != "Send notes to agent (1)":
                raise Failure("the diff header does not offer to send the note")
            b.click(f"{pane} [data-act=edit-note]")
            b.wait(f"document.querySelector('{pane} .dnote.editing textarea')?.value === 'Use a word here'", "the note open for editing")
            self.set_input(f"{pane} .dnote.editing textarea", "Spell the number out")
            b.click(f"{pane} .dnote.editing [data-act=save-note]")
            b.wait(f"document.querySelector('{pane} .dnote .dnote-text')?.textContent === 'Spell the number out'", "the edited note")
            b.click(f'{pane} .dplus[data-at="old:20"]')
            b.wait(f"document.querySelector('{pane} .dnote.editing textarea')", "a second note box")
            self.set_input(f"{pane} .dnote.editing textarea", "Why remove it?")
            b.click(f"{pane} .dnote.editing textarea")
            b.key("Enter", "Control")
            b.wait(f"document.querySelectorAll('{pane} .dnote:not(.editing)').length === 2", "two notes")
            b.goto(self.url("/workspace"))
            b.wait(f"document.querySelectorAll('{pane} .dnote').length === 2", "the notes back after a reload", timeout=15)
            b.click(f"{pane} .dnote [data-act=remove-note]")
            b.wait(f"document.querySelectorAll('{pane} .dnote').length === 1", "one note removed")
            left = [n["text"] for n in self.notes_stored().get(key, [])]
            if left != ["Spell the number out"]:
                raise Failure(f"the notes left are {left}")
            b.click(f"{pane} .dnote [data-act=remove-note]")
            b.wait(f"!document.querySelector('{pane} .dnote') && document.getElementById('chg-send-all').hidden", "the last note removed")
            if self.notes_stored():
                raise Failure(f"removed notes are still stored: {self.notes_stored()}")
        finally:
            self.settle()
            self.put_storage(before)
            if repo:
                self.drop_changes(repo, head)

    def test_workspace_diff_notes_send_to_the_session(self):
        b = self.b
        before = self.storage(self.CHANGES)
        repo = head = None
        pane = ".ws-pane:not([hidden])"
        key, made = self.demo_api_session()
        second = "hp-demo-api-2"
        self.y.tmux("new", "-d", "-s", second, "-c", os.path.join(self.y.root, "demo-api"), self.y.shell)
        self.api("POST", "/refresh")
        try:
            repo, head = self.changes_on_demo_api()
            notes = {
                "\n".join([MACHINE, repo, "long.txt", "worktree"]): [{"id": "n1", "side": "new", "line": 20, "code": "line twenty", "text": "Use a word here", "at": 1}],
                "\n".join([MACHINE, repo, "src/app.js", "staged"]): [{"id": "n2", "side": "old", "line": 1, "code": "export const answer = 1;", "text": "Keep the old answer?\nIt was right.", "at": 2}],
            }
            self.put_storage({"workspace.notes": json.dumps(notes)})
            b.goto(self.url("/workspace"))
            b.wait(f"state !== null && sessionFor({json.dumps(key)}) && sessionFor({json.dumps(MACHINE + '/' + second)})", "both demo-api sessions", timeout=20)
            b.wait("document.getElementById('chg-send-all').textContent === 'Send notes (2)'", "both notes counted in the Changes tab", timeout=15)
            # The real server would type into the session, so the test holds the request and reads it.
            b.js("""(() => {
              window.sentNotes = [];
              const real = window.fetch;
              window.fetch = (url, init) => {
                if (/^\\/sessions\\/[^/]+\\/[^/]+\\/text$/.test(String(url)) && init?.method === 'POST') {
                  window.sentNotes.push({ url: String(url), body: JSON.parse(init.body) });
                  return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
                }
                return real(url, init);
              };
            })()""")
            self.open_long_diff()
            b.click(f"{pane} [data-act=send-notes]")
            b.wait(f"document.getElementById('chg-send').open && document.querySelector('#chg-send input[data-tmux={json.dumps(second)}]') && document.querySelector('#chg-send input[data-tmux={json.dumps(key.split('/', 1)[1])}]')",
                   "a choice of the sessions in demo-api")
            preview = b.js("document.getElementById('chg-send-text').textContent")
            if preview != "long.txt:20\n> line twenty\nUse a word here":
                raise Failure(f"the composed notes read {preview!r}")
            b.click(f"#chg-send input[data-tmux={json.dumps(second)}]")
            b.click("#chg-send button[value=send]")
            b.wait("window.sentNotes.length === 1 && !document.getElementById('chg-send').open", "the notes sent")
            sent = b.js("window.sentNotes[0]")
            want_url = f"/sessions/{MACHINE}/{second}/text"
            if sent != {"url": want_url, "body": {"text": "long.txt:20\n> line twenty\nUse a word here", "enter": False}}:
                raise Failure(f"sent {sent}, not to {want_url}")
            b.wait(f"!document.querySelector('{pane} .dnote') && document.getElementById('chg-send-all').textContent === 'Send notes (1)'", "the sent note cleared")
            b.click("#chg-send-all")
            b.wait("document.getElementById('chg-send').open", "the dialog for every note in the folder")
            b.click("#chg-send-now")
            b.click("#chg-send button[value=send]")
            b.wait("window.sentNotes.length === 2", "the second send")
            body = b.js("window.sentNotes[1].body")
            want = {"text": "src/app.js:1 (removed line)\n> export const answer = 1;\nKeep the old answer?\nIt was right.", "enter": True}
            if body != want:
                raise Failure(f"sent {body}, not {want}")
            b.wait("document.getElementById('chg-send-all').hidden", "no notes left")
            if self.notes_stored():
                raise Failure(f"sent notes are still stored: {self.notes_stored()}")
        finally:
            self.settle()
            self.put_storage(before)
            self.y.tmux("kill-session", "-t", f"={second}")
            self.drop_demo_api_session(key, made)
            if repo:
                self.drop_changes(repo, head)

    def test_workspace_changes_commit_refreshes_the_list(self):
        b = self.b
        before = self.storage(self.CHANGES)
        repo = head = None
        try:
            repo, head = self.changes_on_demo_api()
            b.wait("document.getElementById('chg-commit-go').textContent === 'Commit 3 files'", "the changes listed", timeout=15)
            b.click("#chg-draft")
            b.wait("document.getElementById('chg-message').value !== ''", "a drafted message")
            drafted = b.js("document.getElementById('chg-message').value")
            if drafted != "Update long.txt and app.js, add notes.txt":
                raise Failure(f"the draft reads {drafted!r}")
            message = 'Fixture "commit" from the box\n\nWith a body line.'
            self.set_input("#chg-message", message)
            b.click("#chg-message")
            b.key("Enter", "Control")
            b.wait("document.getElementById('toast').classList.contains('show')", "the commit toast", timeout=15)
            said = b.js("document.getElementById('toast').textContent")
            if not said.startswith("Committed "):
                raise Failure(f"the commit toast says {said!r}")
            short = said.split(" ")[1]
            got = subprocess.run(["git", "log", "-1", "--format=%h%n%B"], cwd=repo, capture_output=True, text=True, check=True).stdout
            if not got.startswith(short) or got.split("\n", 1)[1] != message + "\n\n":
                raise Failure(f"git has {got!r} after the toast said {short}")
            b.wait("document.getElementById('chg-list').textContent.includes('No changes') && document.getElementById('side-changes-count').hidden && document.getElementById('chg-message').value === ''",
                   "the list empty after the commit")
        finally:
            self.settle()
            self.put_storage(before)
            if repo:
                self.drop_changes(repo, head)

    def test_phone_sessions_list_opens_a_session_and_back(self):
        b = self.b
        key, made = self.demo_api_session()
        row = f"#col-body [data-key={json.dumps(key)}]"
        sideways = "document.documentElement.scrollWidth > innerWidth"
        before = self.storage(self.LAYOUT)
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            b.wait(f"state !== null && document.body.classList.contains('ws-list') && document.querySelector({json.dumps(row)})",
                   "the Sessions list on a phone", timeout=15)
            self.mock_usage('{ windows: [{ label: "5 hour", used: 0.42, resets_at: Math.floor(Date.now() / 1000) + 7200, status: "allowed" }] }')
            b.pump(0.3)
            seen = b.js(f"""(() => {{
              const row = document.querySelector({json.dumps(row)});
              const head = document.querySelector('#col-body .tree-head[data-fold={json.dumps(MACHINE)}] .tree-name');
              return {{
                height: row.getBoundingClientRect().height,
                facts: row.querySelectorAll('.tree-pr, .tree-age, .tree-fact').length,
                head: head?.textContent || '',
                usage: document.getElementById('usage-card')?.checkVisibility() ? document.getElementById('usage-card').textContent.replace(/\\s+/g, ' ') : '',
                main: getComputedStyle(document.getElementById('main')).display,
                col: Math.round(document.getElementById('col').getBoundingClientRect().width),
                sideways: {sideways},
              }};
            }})()""")
            if seen["height"] < 44:
                raise Failure(f"a session row on a phone is {seen['height']}px tall")
            if seen["facts"] != 1:
                raise Failure(f"a session row on a phone shows {seen['facts']} facts, not one")
            if not re.fullmatch(rf"{MACHINE} · (\d+%|offline)", seen["head"]):
                raise Failure(f"the machine header reads {seen['head']!r}")
            if "Claude" not in seen["usage"] or "42%" not in seen["usage"]:
                raise Failure(f"the usage card under the list reads {seen['usage']!r}")
            if seen["main"] != "none" or seen["col"] != 390:
                raise Failure(f"the list should fill the screen with the main area hidden: {seen}")
            if seen["sideways"]:
                raise Failure("the Sessions list scrolls sideways")
            b.click(row)
            b.wait(f"document.body.classList.contains('ws-session') && !document.body.classList.contains('ws-list') && document.querySelector('.ws-pane:not([hidden]) iframe[data-key={json.dumps(key)}]')",
                   "the session full screen")
            b.pump(0.3)
            shown = b.js(f"""(() => {{
              const pane = document.querySelector('.ws-pane:has(iframe[data-key={json.dumps(key)}])');
              const back = document.getElementById('back');
              return {{
                width: Math.round(pane.getBoundingClientRect().width),
                panes: document.querySelectorAll('.ws-pane:not([hidden])').length,
                back: back.getClientRects().length > 0 && back.getAttribute('aria-label'),
                title: document.getElementById('ws-title').textContent,
                more: document.getElementById('ws-more').getClientRects().length > 0,
                tabs: document.getElementById('tabs').getClientRects().length,
                sideways: {sideways},
              }};
            }})()""")
            if shown["width"] != 390 or shown["panes"] != 1:
                raise Failure(f"the session should fill the width alone: {shown}")
            if shown["back"] != "Sessions" or not shown["more"] or shown["tabs"]:
                raise Failure(f"the top bar should have back, the title and the menu, and no tabs: {shown}")
            if "demo-api" not in shown["title"]:
                raise Failure(f"the top bar title reads {shown['title']!r}")
            if shown["sideways"]:
                raise Failure("the full-screen session scrolls sideways")
            b.click("#back")
            b.wait("document.body.classList.contains('ws-list') && !document.body.classList.contains('ws-session')", "back to the Sessions list")
            b.pump(0.3)
            if b.js(sideways):
                raise Failure("the Sessions list scrolls sideways after going back")
        finally:
            b.viewport(1280, 800)
            self.settle()
            self.put_storage(before)
            self.drop_demo_api_session(key, made)

    def test_phone_session_keeps_its_place_across_widths(self):
        b = self.b
        key, made = self.demo_api_session()
        row = f"#col-body [data-key={json.dumps(key)}]"
        before = self.storage(self.LAYOUT)
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            b.wait(f"state !== null && document.querySelector({json.dumps(row)})", "the session in the Sessions list", timeout=15)
            b.click(row)
            b.wait(f"document.body.classList.contains('ws-session') && focusedLeaf().key === {json.dumps(key)}", "the session full screen")
            b.viewport(1280, 800)
            b.wait(f"!phone.matches && !document.body.classList.contains('ws-list') && !document.body.classList.contains('ws-session') && focusedLeaf().key === {json.dumps(key)}",
                   "the desktop with the same pane focused")
            b.viewport(390, 844, 3)
            b.wait(f"phone.matches && document.body.classList.contains('ws-session') && focusedLeaf().key === {json.dumps(key)} && document.querySelector('.ws-pane:not([hidden]) iframe[data-key={json.dumps(key)}]')",
                   "the same session full screen again")
        finally:
            b.viewport(1280, 800)
            self.settle()
            self.put_storage(before)
            self.drop_demo_api_session(key, made)

    PERMISSION_STATE = {"agent": "claude", "state": "permission", "screen": "aaaa", "choices": [
        {"number": 1, "label": "Yes", "keys": "1", "role": "yes"},
        {"number": 2, "label": "Yes, and don't ask again for rm commands in /r/app", "keys": "2", "role": "always"},
        {"number": 3, "label": "No, and tell Claude what to do differently (esc)", "keys": "3", "role": "no"},
    ]}
    QUESTION_STATE = {"agent": "claude", "state": "question", "screen": "bbbb", "choices": [
        {"number": 1, "label": "Postgres", "keys": "1"},
        {"number": 2, "label": "SQLite", "keys": "2"},
        {"number": 3, "label": "Type something.", "keys": "3"},
    ]}

    def term_session(self):
        if not self.session:
            path = os.path.join(self.y.root, "demo-app")
            self.session = self.api("POST", "/sessions", {"machine": MACHINE, "path": path, "wait": True})["name"]
        return self.session

    # The page's own /agent reads answer from window.__agent, and every frame the terminal's socket
    # sends is kept in window.__frames. Typing still reaches the shell unless swallow is set, since
    # keys meant for an agent, like Ctrl-S, would stop the shell's output.
    def open_phone_term(self, swallow=False):
        b = self.b
        name = self.term_session()
        b.viewport(390, 844, 3)
        b.goto(self.url(f"/term/{MACHINE}/{name}"))
        b.wait("typeof term === 'object' && term.element && window.YardbellAgentKeys && window.YardbellCompose", "the phone terminal and its dock")
        b.wait("screenText().length > 0", "the shell prompt", timeout=15)
        b.js("""(() => {
          window.__frames = [];
          const swallow = SWALLOW;
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            let frame = null;
            try { frame = JSON.parse(data); window.__frames.push(frame); } catch {}
            if (swallow && frame?.t === 'in') return;
            return send.call(this, data);
          };
          const real = window.fetch;
          window.fetch = (url, init) => {
            if (window.__agent && String(url).endsWith('/agent') && !(init && init.method === 'POST')) {
              return Promise.resolve(new Response(JSON.stringify(window.__agent), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            return real(url, init);
          };
          return 0;
        })()""".replace("SWALLOW", "true" if swallow else "false"))
        return name

    def agent_keys(self, state):
        b = self.b
        b.js(f"window.__agent = {json.dumps(state)}; YardbellAgentKeys.load().then(() => 0)")
        return b.js("""[...document.querySelectorAll('#term-dock .agent-keys .agent-key')].map((k) => k.getAttribute('aria-label'))""")

    def test_phone_term_agent_keys_follow_the_prompt(self):
        b = self.b
        try:
            self.open_phone_term(swallow=True)
            shown = b.js("""(() => {
              const dock = document.getElementById('term-dock');
              const keys = document.getElementById('keys');
              return { on: dock.classList.contains('on'), above: dock.getBoundingClientRect().bottom <= keys.getBoundingClientRect().top + 1 && dock.getBoundingClientRect().height > 0,
                       type: Boolean(dock.querySelector('[data-compose]')), sideways: Math.round(dock.querySelector('.agent-row').getBoundingClientRect().right) > innerWidth };
            })()""")
            if not shown["on"] or not shown["above"] or not shown["type"] or shown["sideways"]:
                raise Failure(f"the agent row should show above the key bar with a Type key: {shown}")
            got = self.agent_keys(self.PERMISSION_STATE)
            if got != ["Yes, sends 1", "Always, sends 2", "No, sends 3"]:
                raise Failure(f"a permission prompt shows {got}")
            if not b.js("document.querySelector('#term-dock .agent-key.primary')?.getAttribute('aria-label') === 'Yes, sends 1'"):
                raise Failure("Yes is not the primary key")
            b.js("window.__frames.length = 0")
            b.click('#term-dock [aria-label="Always, sends 2"]')
            b.wait("window.__frames.some((f) => f.t === 'in' && f.d === '2')", "Always to send 2 on the terminal's socket")
            if b.js("window.__frames.filter((f) => f.t === 'in').map((f) => f.d).join('|')") != "2":
                raise Failure(f"Always sent more than its key: {b.js('JSON.stringify(window.__frames)')}")
            got = b.js("[...document.querySelectorAll('#term-dock .agent-keys .agent-key')].map((k) => k.getAttribute('aria-label'))")
            if got != ["Stop, sends Esc"]:
                raise Failure(f"right after answering, only Stop should show until the screen is read again: {got}")
            got = self.agent_keys(self.QUESTION_STATE)
            if got != ["1. Postgres, sends 1", "2. SQLite, sends 2", "3. Type something., sends 3", "Cancel, sends Esc"]:
                raise Failure(f"a numbered question shows {got}")
            got = self.agent_keys({"agent": "claude", "state": "working", "screen": "cccc", "choices": []})
            if got != ["Stop, sends Esc", "Send now, sends ⌃X ⌃S"]:
                raise Failure(f"a working agent shows {got}")
            b.js("window.__frames.length = 0")
            b.click('#term-dock [aria-label="Send now, sends ⌃X ⌃S"]')
            b.wait("window.__frames.some((f) => f.t === 'in' && f.d === '\\x18\\x13')", "Send now to send Ctrl-X Ctrl-S")
            got = self.agent_keys({"agent": "claude", "state": "idle", "screen": "dddd", "choices": []})
            if got != ["Mode, sends ⇧Tab", "History, sends ↑", "Clear line, sends ⌃U"]:
                raise Failure(f"an idle agent shows {got}")
            got = self.agent_keys({"agent": "claude", "state": "blocked", "screen": "eeee", "choices": []})
            if got != ["Stop, sends Esc"]:
                raise Failure(f"a wait the screen does not explain should show only Stop: {got}")
            got = self.agent_keys({"agent": "aider", "state": "working", "screen": "ffff", "choices": []})
            if got != [] or not b.js("Boolean(document.querySelector('#term-dock [data-compose]'))"):
                raise Failure(f"an agent without a key map should show only Type: {got}")
        finally:
            b.viewport(1280, 800)

    def test_phone_term_agent_row_reads_the_server(self):
        b = self.b
        name = self.term_session()
        b.goto(self.url("/"))
        got = self.api("GET", f"/sessions/{MACHINE}/{name}/agent")
        if got.get("agent") != "shell" or got.get("state") not in ("idle", "working"):
            raise Failure(f"the agent state of a shell session reads {got}")
        b.viewport(1280, 800)
        b.goto(self.url(f"/term/{MACHINE}/{name}"))
        b.wait("typeof term === 'object' && term.element && window.YardbellAgentKeys", "the desktop terminal")
        if b.js("document.getElementById('term-dock').classList.contains('on')"):
            raise Failure("the agent row shows on a desktop-sized terminal")

    def test_phone_term_compose_sends_text_and_enter(self):
        b = self.b
        try:
            self.open_phone_term()
            b.click("#term-dock [data-compose]")
            b.wait("!document.querySelector('.term-compose').hidden && document.activeElement?.classList.contains('term-compose-text')", "the message box, focused")
            mic = b.js("(() => { const m = document.querySelector('.term-compose .mic'); return Boolean(m) && !m.hidden && Boolean(document.querySelector('.term-compose .dictation-pill')); })()")
            if not mic:
                raise Failure("the message box has no dictation button and pill")
            b.type("echo composed''-ok")
            b.js("window.__frames.length = 0")
            b.click(".term-compose .compose-send")
            b.wait("window.__frames.some((f) => f.t === 'in' && f.d === '\\r')", "Enter after the text")
            sent = b.js("window.__frames.filter((f) => f.t === 'in').map((f) => f.d)")
            if len(sent) != 2 or "echo composed''-ok" not in sent[0] or sent[1] != "\r":
                raise Failure(f"the message box should type the text, then Enter: {sent}")
            b.wait("screenText().split('\\n').some((l) => l.trim() === 'composed-ok')", "the shell to run the message")
            if not b.js("document.querySelector('.term-compose').hidden"):
                raise Failure("the message box stays open after sending")
            b.click("#term-dock [data-compose]")
            b.js("""(() => { const t = document.querySelector('.term-compose-text'); t.value = 'one\\ntwo'; t.dispatchEvent(new Event('input')); return 0; })()""")
            b.js("window.__frames.length = 0")
            b.js("""(() => { window.__pasted = []; term.paste = (t) => { window.__pasted.push(t); }; return 0; })()""")
            b.click(".term-compose .compose-send")
            b.wait("window.__frames.some((f) => f.t === 'in' && f.d === '\\r')", "Enter after a two-line message")
            if b.js("window.__pasted") != ["one\ntwo"]:
                raise Failure(f"a two-line message should go as one paste: {b.js('window.__pasted')}")
        finally:
            b.viewport(1280, 800)

    def test_phone_term_attach_uploads_a_file(self):
        b = self.b
        made = None
        try:
            name = self.open_phone_term()
            b.click("#term-dock [data-compose]")
            b.js("YardbellCompose.attach([new File(['hello from the phone\\n'], 'phone notes.txt', { type: 'text/plain' })]); 0")
            path = b.wait(f"""(() => {{
              const m = document.querySelector('.term-compose-text').value.match(/\\/tmp\\/yardbell-uploads\\/{re.escape(name)}\\/\\d+-phone_notes\\.txt/);
              return m && m[0];
            }})()""", "the uploaded file's path in the message", timeout=15)
            made = path
            with open(path) as f:
                if f.read() != "hello from the phone\n":
                    raise Failure(f"{path} does not hold the attached file")
            chip = b.js("(() => { const c = document.querySelector('.term-file'); return c && [c.dataset.state, c.textContent]; })()")
            if not chip or chip[0] != "done":
                raise Failure(f"the file chip does not say it was added: {chip}")
            b.js("YardbellCompose.attach([new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.png')]); 0")
            b.wait("[...document.querySelectorAll('.term-file')].some((c) => c.dataset.state === 'failed' && c.textContent.includes('over 10 MB'))", "a file over the cap refused")
            b.js("YardbellCompose.attach([new File([new Uint8Array([0, 1, 2, 3, 255])], 'blob.bin')]); 0")
            b.wait("document.querySelector('.term-compose-status').textContent.includes('only images, PDFs and text files')", "a binary file refused with the reason")
        finally:
            if made and os.path.exists(made):
                os.remove(made)
                for folder in (os.path.dirname(made), os.path.dirname(os.path.dirname(made))):
                    try:
                        os.rmdir(folder)
                    except OSError:
                        break
            b.viewport(1280, 800)

    def test_phone_session_switcher_picks_and_swipes(self):
        b = self.b
        self.term_session()
        key, made = self.demo_api_session()
        first = f"{MACHINE}/{self.session}"
        before = self.storage(self.LAYOUT)
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/workspace"))
            row = f"#col-body [data-key={json.dumps(key)}]"
            b.wait(f"state !== null && document.querySelector({json.dumps(row)}) && document.querySelector('#col-body [data-key={json.dumps(first)}]')", "both sessions in the list", timeout=15)
            b.click(row)
            b.wait(f"document.body.classList.contains('ws-session') && focusedLeaf().key === {json.dumps(key)}", "the session full screen")
            shown = b.js("""(() => {
              const s = document.getElementById('ws-switch');
              return { visible: s.getClientRects().length > 0, state: Boolean(s.querySelector('.ws-tab-state')), label: s.getAttribute('aria-label') };
            })()""")
            if not shown["visible"] or not shown["state"] or "demo-api" not in shown["label"]:
                raise Failure(f"the switcher should name the session with its state: {shown}")
            b.click("#ws-switch")
            b.wait("!document.getElementById('ws-switcher').hidden", "the session picker")
            rows = b.js("[...document.querySelectorAll('#ws-switcher .ws-switch-row')].map((r) => [r.dataset.switch, r.hasAttribute('aria-current'), Boolean(r.querySelector('.ws-tab-state svg'))])")
            if [r[0] for r in rows if r[1]] != [key] or first not in [r[0] for r in rows] or not all(r[2] for r in rows):
                raise Failure(f"the picker should list the sessions with state icons and mark this one: {rows}")
            b.click(f"#ws-switcher [data-switch={json.dumps(first)}]")
            b.wait(f"document.getElementById('ws-switcher').hidden && focusedLeaf().key === {json.dumps(first)} && document.querySelector('.ws-pane:not([hidden]) iframe[data-key={json.dumps(first)}]')",
                   "the picked session full screen")
            order = b.js("switchList().map(keyOf)")
            at = order.index(first)
            swipe = """((dx) => {
              const s = document.getElementById('ws-switch');
              const box = s.getBoundingClientRect();
              const y = box.top + box.height / 2;
              const x = box.left + box.width / 2;
              s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: x, clientY: y }));
              s.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: x + dx, clientY: y + 4 }));
              s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x + dx, clientY: y + 4 }));
              return 0;
            })"""
            b.js(f"{swipe}(-120)")
            want = order[(at + 1) % len(order)]
            b.wait(f"focusedLeaf().key === {json.dumps(want)} && document.getElementById('ws-switcher').hidden", "a swipe left to open the next session")
            b.js(f"{swipe}(120)")
            b.wait(f"focusedLeaf().key === {json.dumps(first)}", "a swipe right to come back")
            b.click("#back")
            b.wait("document.body.classList.contains('ws-list')", "Back to still return to the list")
        finally:
            b.viewport(1280, 800)
            self.settle()
            self.put_storage(before)
            self.drop_demo_api_session(key, made)

    def test_workspace_sidebar_matches_the_other_pages(self):
        dashboard = self.menu("/")
        workspace = self.menu("/workspace")
        if workspace != [d for d in dashboard if d != "Keyboard shortcuts"]:
            raise Failure(f"the Workspace rail {workspace} is not the dashboard's menu {dashboard}")

    def test_settings_nav_lives_in_the_column(self):
        b = self.b
        b.goto(self.url("/settings"))
        b.wait("document.querySelector('#col-body .settings-nav a[href=\"#machines\"]')", "the Settings sections in the column")
        if b.js("document.querySelector('.side, .page-body .settings-nav')"):
            raise Failure("Settings still draws its own sidebar or inner section list")
        b.click('#col-body .settings-nav a[href="#voice"]')
        b.wait("location.hash === '#voice' && !document.getElementById('voice').hidden", "the Voice section")
        b.wait("document.querySelector('#col-body .settings-nav a[href=\"#voice\"]').getAttribute('aria-current') === 'page'", "Voice marked current")
        b.click("#settings-search")
        b.type("whisper")
        b.wait("[...document.querySelectorAll('#col-body .settings-nav a')].filter((a) => !a.hidden).map((a) => a.hash).join() === '#voice'", "only Voice matching whisper")
        b.key("Enter")
        b.wait("location.hash === '#voice'", "Enter to open the first match")

    def test_settings_column_is_only_back_search_and_sections(self):
        b = self.b
        b.goto(self.url("/settings"))
        b.wait("document.querySelector('#col-body .settings-back')", "the Back to app row")
        if not b.js("document.querySelector('#col-body .settings-back').getAttribute('href') === '/workspace'"):
            raise Failure("Back to app should go to Workspace when Settings was opened directly")
        shown = b.js("""JSON.stringify(Object.fromEntries(['.col-brand', '#col-search-row', '.col-nav', '#col-head', '.col-foot', '.rail']
          .map((sel) => [sel, getComputedStyle(document.querySelector(sel)).display !== 'none'])))""")
        if any(json.loads(shown).values()):
            raise Failure(f"the shell's own column parts still show on Settings: {shown}")
        if not b.js("document.getElementById('col-search') && getComputedStyle(document.querySelector('#col-body .settings-nav')).display !== 'none'"):
            raise Failure("the jump button should stay in the page and the section list should show")
        b.key("k", "Control")
        b.wait("document.getElementById('palette')?.open", "Ctrl+K to still open the palette on Settings")
        b.key("Escape")
        b.goto(self.url("/pipeline"))
        b.wait("document.getElementById('col-body')", "the Pipelines page")
        b.js("location.href = '/settings#voice'")
        b.wait("location.pathname === '/settings' && document.querySelector('#col-body .settings-back')", "Settings opened from Pipelines")
        if not b.js("document.querySelector('#col-body .settings-back').getAttribute('href') === '/pipeline'"):
            raise Failure("Back to app should return to the page Settings was opened from")
        b.click("#col-body .settings-back")
        b.wait("location.pathname === '/pipeline'", "Back to app to leave Settings")

    def test_every_page_shares_one_shell(self):
        b = self.b
        pages = ["/", "/workspace", "/pipeline", "/dispatch", "/proposals", "/diagrams", "/settings", "/add"]
        b.goto(self.url("/workspace"))
        b.wait("document.querySelector('#rail .rail-link')", "the rail on the Workspace")
        want = b.js("[...document.querySelectorAll('#rail .rail-link[data-page]')].map((a) => a.dataset.page)")
        b.js("localStorage.setItem('yardbell.side', 'rail')")
        try:
            for path in pages:
                b.goto(self.url(path))
                b.wait("document.querySelector('#rail .rail-link') && document.getElementById('status-group')", f"the shell on {path}")
                seen = b.js("""(() => ({
                  rail: [...document.querySelectorAll('#rail .rail-link[data-page]')].map((a) => a.dataset.page),
                  old: Boolean(document.querySelector('.side, .side-foot, #nav-machines')),
                  collapsed: document.documentElement.classList.contains('side-rail'),
                  col: (() => { const c = document.getElementById('col'); return c ? getComputedStyle(c).display : 'none'; })(),
                  search: Boolean(document.querySelector('#col-search')) && document.querySelector('#col-search').getClientRects().length > 0,
                }))()""")
                if seen["rail"] != want or seen["old"]:
                    raise Failure(f"{path} does not share the shell: {seen}")
                if path == "/settings":
                    if seen["col"] == "none":
                        raise Failure(f"Settings should keep its own column even when the others are collapsed: {seen}")
                    b.key("k", "Control")
                    b.wait("document.getElementById('palette')?.open", "Ctrl+K to open the palette on /settings")
                    b.key("Escape")
                    continue
                if not seen["collapsed"] or seen["col"] != "none" or not seen["search"]:
                    raise Failure(f"{path} ignores the collapsed column or hides search: {seen}")
                b.click("#col-search")
                b.wait("document.getElementById('palette')?.open", f"the palette on {path}")
                b.key("Escape")
            b.js("localStorage.removeItem('yardbell.side')")
            b.viewport(390, 844, 3)
            for path in pages:
                b.goto(self.url(path))
                b.wait("document.getElementById('tabbar')", f"the phone tabs on {path}")
                b.pump(0.3)
                seen = b.js("""(() => ({
                  tabs: [...document.querySelectorAll('#tabbar > a, #tabbar > button')].map((t) => t.textContent.trim().replace(/\\s*[0-9]+$/, '')),
                  sideways: document.documentElement.scrollWidth > innerWidth,
                }))()""")
                if seen["tabs"] != ["Sessions", "Board", "Pipelines", "Dispatch", "More"] or seen["sideways"]:
                    raise Failure(f"{path} on a phone: {seen}")
        finally:
            b.js("localStorage.removeItem('yardbell.side')")
            b.viewport(1280, 800)

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

    def test_dispatch_lists_sit_in_the_shared_sidebar_and_it_resizes(self):
        b = self.b
        b.viewport(1280, 800)
        b.goto(self.url("/dispatch"))
        b.wait("document.querySelector('#col-body #dispatch-side')?.getBoundingClientRect().width > 0", "the conversation list in the sidebar")
        if b.js("document.querySelector('#col .col-title')?.textContent") != "Dispatch":
            raise Failure("the sidebar is not headed Dispatch")
        before = b.js("document.getElementById('col').getBoundingClientRect().width")
        try:
            b.js("document.getElementById('col-edge').focus()")
            b.key("ArrowRight")
            b.key("ArrowRight")
            b.wait(f"document.getElementById('col').getBoundingClientRect().width >= {before} + 30", "the sidebar to widen")
            b.goto(self.url("/pipeline"))
            b.wait(f"document.getElementById('col')?.getBoundingClientRect().width >= {before} + 30", "the same width on Pipelines")
            b.goto(self.url("/dispatch"))
            b.wait("document.querySelector('#col-body #dispatch-side')", "the list back in the sidebar")
            b.click("#col-toggle")
            b.wait("document.querySelector('#dispatch #dispatch-side')?.getBoundingClientRect().width > 0", "the list beside the chat with the sidebar folded")
            b.click("#col-toggle")
            b.wait("document.querySelector('#col-body #dispatch-side')", "the list back in the sidebar when it opens")
        finally:
            b.js("localStorage.removeItem('yardbell.side.width'); localStorage.removeItem('yardbell.side')")

    def test_dispatch_model_picker_changes_the_model(self):
        b = self.b
        before = self.api("GET", "/api/settings")["dispatch"]
        try:
            b.goto(self.url("/dispatch"))
            b.wait("document.querySelector('#runs-on .runs-on-label')?.textContent.includes('·')", "the runs-on chip")
            b.click("#runs-on")
            b.wait("!document.getElementById('model-menu').hidden", "the model picker")
            names = b.js("[...document.querySelectorAll('#model-menu [data-model]')].map((x) => x.textContent.trim())")
            if "Sonnet" not in names or "Opus" not in names:
                raise Failure(f"the picker offers {names}")
            b.click('#model-menu [data-model="sonnet"]')
            b.wait("document.querySelector('#runs-on .runs-on-label').textContent.includes('Sonnet')", "the chip to show Sonnet")
            if self.api("GET", "/api/settings")["dispatch"].get("model") != "sonnet":
                raise Failure("the picked model was not saved")
        finally:
            restore = {k: before.get(k, d) for k, d in (("instructions", ""), ("agent", ""), ("runs_on", "claude"), ("model", ""), ("codex_model", ""), ("approval", None), ("rules", []))}
            self.api("POST", "/api/settings/dispatch", {k: v for k, v in restore.items() if v is not None})

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
                    back: (document.querySelector('.back-link')?.getClientRects().length || 0) > 0,
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
            b.click("#dispatch-input")
            b.type("Fix the login redirect in demo-app")
            b.click("#dispatch-form button[type=submit]")
            card = "#dispatch-log .step-card.pending"
            b.wait(f"document.querySelector('{card}')?.textContent.includes('Fix the login redirect.')", "the proposed session, waiting for approval", timeout=20)
            b.wait("[...document.querySelectorAll('#dispatch-log .msg')].some((m) => m.textContent.includes('I proposed a session on hp in demo-app.'))", "Codex's reply")
            b.wait("[...document.querySelectorAll('#dispatch-log *')].some((x) => x.textContent === 'Checked machines')", "the tool Codex called")
            b.wait("document.getElementById('usage-card')?.getClientRects().length > 0 && document.getElementById('usage-card').getAttribute('aria-label').includes('Codex 5h 42%')",
                   "Codex's limits on the sidebar's usage card")
            id = b.js("new URLSearchParams(location.search).get('c')")
            convo = self.api("GET", f"/dispatch/conversations/{id}")
            if convo["backend"] != "codex" or any(e["role"] == "error" for e in convo["events"]):
                raise Failure(f"the conversation is {convo}")

            b.click(f"{card} .step-card-actions .btn.danger")
            b.wait("document.querySelector('#dispatch-log .step-card.rejected, #dispatch-log .step-card.done')", "the step rejected")
            b.click("#dispatch-input")
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

    def test_dispatch_attaches_files_on_codex(self):
        b = self.b
        before = self.api("GET", "/api/settings")["dispatch"]
        self.api("POST", "/api/settings/dispatch", {**before, "rules": [], "approval": "prompt", "runs_on": "codex"})
        files = """
          const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
          const make = (name, bytes) => new File([bytes], name, { lastModified: 1 });
          const files = { png: make('shot.png', png), log: make('notes.log', 'hello'), fake: make('fake.png', new Uint8Array([80, 75, 3, 4, 20, 0, 0, 0])), pdf: make('a.pdf', '%PDF-1.4') };
          const carry = (...list) => { const dt = new DataTransfer(); for (const f of list) dt.items.add(f); return dt; };
          const drop = (...list) => { const dt = carry(...list); const target = document.getElementById('dispatch-chat');
            target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); };
        """
        chips = "document.querySelectorAll('#compose-files .compose-file').length"
        toast = "document.getElementById('toast').textContent"
        try:
            b.goto(self.url("/dispatch"))
            b.wait("document.getElementById('runs-on').textContent.startsWith('Codex')", "a new conversation on Codex")
            b.js(f"(() => {{ {files} const paste = new Event('paste', {{ bubbles: true, cancelable: true }}); Object.defineProperty(paste, 'clipboardData', {{ value: carry(files.png) }}); document.querySelector('#dispatch-input').dispatchEvent(paste); }})()")
            b.wait(f"{chips} === 1 && document.querySelector('#compose-files .compose-file img')", "the pasted image as a chip with a thumbnail")
            b.js(f"(() => {{ {files} drop(files.log); }})()")
            b.wait(f"{chips} === 2", "the dropped text file")
            b.js(f"(() => {{ {files} drop(files.log); }})()")
            b.pump(0.3)
            if b.js(chips) != 2:
                raise Failure("the same file dropped twice made two chips")
            b.js(f"(() => {{ {files} drop(files.fake); }})()")
            b.wait(f"{toast} === 'fake.png is not an image, a PDF or a text file'", "the refusal of a renamed zip")
            b.js(f"(() => {{ {files} drop(files.pdf); }})()")
            b.wait(f"{toast} === 'Codex cannot read PDFs, so a.pdf cannot be sent in this conversation'", "the refusal of a PDF on Codex")
            if b.js(chips) != 2:
                raise Failure("a refused file became a chip")
            b.click("#dispatch-input")
            b.type("what is in these?")
            b.click("#dispatch-send")
            b.wait("[...document.querySelectorAll('#dispatch-log .msg')].some((m) => m.textContent.includes('I saw 1 image and 1 text file.'))", "Codex's reply", timeout=20)
            b.wait(f"{chips} === 0", "the chips cleared once sent")
            id = b.js("new URLSearchParams(location.search).get('c')")
            b.goto(self.url(f"/dispatch?c={id}"))
            b.wait("document.querySelectorAll('#dispatch-log .msg.user .msg-file').length === 2", "the files on the saved message")
            b.wait("(() => { const i = document.querySelector('#dispatch-log .msg.user .msg-file img'); return i && i.complete && i.naturalWidth === 1; })()", "the saved image's thumbnail")
            text = b.js(f"fetch('/dispatch/conversations/{id}/attachments/1-notes.log').then((r) => r.text())")
            if text != "hello":
                raise Failure(f"the saved text file reads {text!r}")
            page = b.js("location.href")
            viewer = "document.getElementById('shot-view')"
            b.click("#dispatch-log .msg.user .msg-file.image")
            b.wait(f"{viewer}?.open && (() => {{ const i = {viewer}.querySelector('img'); return i && i.complete && i.naturalWidth === 1; }})()", "the image in the viewer")
            b.click("#shot-view .shot-view-head button")
            b.wait(f"!{viewer}.open", "the viewer closed by its Close button")
            b.click("#dispatch-log .msg.user .msg-file.text")
            b.wait(f"{viewer}.open && {viewer}.querySelector('pre')?.textContent === 'hello'", "the text file in the viewer")
            b.js(f"{viewer}.close()")
            if b.js("location.href") != page or b.js("document.querySelector('#dispatch-log .msg.user .msg-file[target]')"):
                raise Failure("opening a file left the conversation or would open a new window")
        finally:
            self.api("POST", "/api/settings/dispatch", before)

    def test_dispatch_keeps_files_when_a_send_is_refused(self):
        b = self.b
        b.goto(self.url("/dispatch"))
        b.wait("document.getElementById('dispatch-form')", "the composer")
        drop = """(() => { const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'notes.log'));
          document.getElementById('dispatch-chat').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()"""
        kept = ("document.querySelectorAll('#compose-files .compose-file').length === 1"
                " && document.querySelector('#dispatch-input').value === 'read this'"
                " && !document.querySelector('#dispatch-log .msg.user')")
        b.js("""(() => { const real = window.fetch; window.fetch = (url, options) => String(url) === '/dispatch/ask'
          ? Promise.resolve(new Response(JSON.stringify({ error: 'could not save notes.log: disk full' }), { status: 409 }))
          : real(url, options); })()""")
        b.js(drop)
        b.wait("document.querySelectorAll('#compose-files .compose-file').length === 1", "the dropped file")
        b.click("#dispatch-input")
        b.type("read this")
        b.click("#dispatch-send")
        b.wait("document.querySelector('#dispatch-log .msg.error')?.textContent.includes('disk full')", "the server's refusal")
        b.wait(kept, "the file and the text back in the composer after a 409")

        b.js("localStorage.removeItem('yardbell.dispatch.drafts')")
        b.goto(self.url("/dispatch"))
        b.wait("document.getElementById('dispatch-form')", "the composer again")
        b.js("FileReader.prototype.readAsDataURL = function () { setTimeout(() => this.onerror?.(new ProgressEvent('error'))); }")
        b.js(drop)
        b.wait("document.querySelectorAll('#compose-files .compose-file').length === 1", "the dropped file")
        b.click("#dispatch-input")
        b.type("read this")
        b.click("#dispatch-send")
        b.wait("document.querySelector('#dispatch-log .msg.error')?.textContent.includes('could not read notes.log')", "the read failure")
        b.wait(kept, "the file and the text back in the composer after a failed read")
        b.js("localStorage.removeItem('yardbell.dispatch.drafts')")

    def test_a_review_of_reviewed_code_offers_review_again(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={REVIEW_AGAIN_CHAT}"))
        card = "#dispatch-log .step-card.pending"
        b.wait(f"document.querySelector('{card} .review-commit')?.textContent.includes('already has a finished review')", "the note that this code has a review")
        if b.js(f"document.querySelector('{card} .step-card-actions .btn.primary').textContent.trim()") != "Review again":
            raise Failure("the button does not say Review again")

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
        b.wait(f"document.querySelector('{card} .review-commit')?.textContent.includes('The branch has moved on since this review')", "the card saying the branch moved on")
        if not b.js(f"document.querySelector('{card} .review-commit').textContent.startsWith('Read ')"):
            raise Failure("the card does not name the commit it read")
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
                  const bar = document.getElementById('tabbar').getBoundingClientRect();
                  return {last: last.bottom, top: form.top, bottom: form.bottom, bar: bar.top};
                })()"""
            )
            if box["last"] > box["top"] + 1:
                raise Failure(f"the composer (top {box['top']}px) covers the last message (bottom {box['last']}px)")
            if abs(box["bottom"] - box["bar"]) > 1:
                raise Failure(f"the composer ends at {box['bottom']}px, not on the tab bar at {box['bar']}px")
        finally:
            b.viewport(1280, 800)

    def test_dispatch_composer_pills_and_pasted_text(self):
        b = self.b
        editor = "document.getElementById('dispatch-input')"
        paste = """(() => { const dt = new DataTransfer(); dt.setData('text/plain', Array.from({length: 20}, (_, i) => 'log line ' + i).join('\\n'));
          const e = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'clipboardData', { value: dt });
          document.getElementById('dispatch-input').dispatchEvent(e); })()"""
        b.js("localStorage.removeItem('yardbell.dispatch.drafts')")
        b.goto(self.url("/dispatch"))
        b.wait(f"{editor}?.classList.contains('is-empty')", "the empty composer with its placeholder")
        b.click("#dispatch-input")
        b.type("Fix ")
        b.type("@")
        b.wait("!document.getElementById('compose-menu').hidden && document.querySelector('#compose-menu .compose-option')", "the @ menu")
        b.type(MACHINE)
        b.wait(f"document.querySelector('#compose-menu .compose-option.active .compose-option-label')?.textContent === {json.dumps(MACHINE)}", "the machine first in the menu")
        b.key("Enter")
        b.wait(f"{editor}.querySelector('.compose-pill.name')?.textContent.trim() === {json.dumps(MACHINE)}", "the machine as a pill")
        if b.js(f"{editor}.value") != f"Fix {MACHINE} ":
            raise Failure(f"the message reads {b.js(f'{editor}.value')!r}")
        b.key("Backspace")
        b.key("Backspace")
        b.wait(f"!{editor}.querySelector('.compose-pill') && {editor}.value === 'Fix '", "Backspace to take the pill away whole")
        b.type("`npm test` ")
        b.wait(f"{editor}.querySelector('.compose-code')?.textContent === '`npm test`'", "the backticks drawn as code")
        b.js(paste)
        b.wait(f"{editor}.querySelector('.compose-pill.paste')?.textContent.trim() === 'Pasted text · 20 lines'", "the long paste as a pill")
        if not b.js(f"{editor}.value.includes('log line 0\\nlog line 1') && {editor}.value.includes('log line 19')"):
            raise Failure("the pasted text is not in the message")
        b.goto(self.url("/dispatch"))
        b.wait(f"{editor}.querySelector('.compose-pill.paste') && {editor}.value.startsWith('Fix `npm test` log line 0')", "the draft and its pill after a reload")
        b.click("#dispatch-input .compose-pill.paste")
        b.wait(f"!{editor}.querySelector('.compose-pill') && {editor}.textContent.includes('log line 19')", "a click to put the paste back as text")
        b.key("z", "Control")
        b.wait(f"{editor}.querySelector('.compose-pill.paste')", "Ctrl+Z to bring the pill back")
        self.set_field("#dispatch-input", "")
        b.js("localStorage.removeItem('yardbell.dispatch.drafts')")

    def test_settings_voice_input_and_dispatch_dictation(self):
        b = self.b
        b.goto(self.url("/settings#voice"))
        b.wait("document.querySelector('#voice-form select[name=input]')?.value === 'off'", "voice input off by default")
        b.wait("document.getElementById('mic') === null", "no microphone on the Settings page")
        self.set_field("#voice-form select[name=input]", "local")
        b.wait("!document.querySelector('#voice-form [data-input=local]').hidden", "the local Whisper fields")
        self.set_field("#voice-form input[name=whisper_model]", self.y.config)
        b.click("#voice-check")
        b.wait("document.getElementById('voice-status').classList.contains('ok')", "the Test to find ffmpeg, whisper-cli and the model")
        b.click("#voice-form button[type=submit]")
        b.wait("!document.getElementById('undo-bar').hidden", "the voice settings to save")
        with open(self.y.config) as f:
            config = f.read()
        if "input: local" not in config:
            raise Failure(f"yardbell.yml does not hold the voice input:\n{config}")
        try:
            b.goto(self.url("/dispatch"))
            b.wait("!document.getElementById('mic').hidden", "the microphone button in the composer")
            b.click("#mic")
            b.wait("document.getElementById('mic').classList.contains('recording')", "recording to start on the fake microphone")
            b.wait("!document.getElementById('dictation-pill').hidden && document.querySelectorAll('#dictation-pill .dict-grape').length === 9 && document.querySelector('#dictation-pill .dict-btn.finish')",
                   "the dictation pill with its meter and Finish")
            b.pump(0.5)
            b.click("#mic")
            b.wait(
                f"document.querySelector('#dispatch-input').value.includes({json.dumps(FAKE_DICTATION)})",
                "the dictation to land in the message box",
            )
            b.wait("document.getElementById('dictation-pill').hidden", "the pill gone once the words are in")
            self.set_field("#dispatch-input", "")
            b.click("#dispatch-input")
            b.key(" ", "Control", "Shift")
            b.wait("document.getElementById('mic').classList.contains('recording')", "Ctrl+Shift+Space to start recording")
            b.wait("!document.getElementById('dictation-pill').hidden", "the dictation pill")
            b.click("#dictation-pill .dict-btn")
            b.wait("!document.getElementById('mic').classList.contains('recording') && document.getElementById('dictation-pill').hidden", "Cancel to discard the recording")
            b.pump(0.5)
            if b.js("document.querySelector('#dispatch-input').value"):
                raise Failure("a cancelled recording typed something")
        finally:
            self.api("POST", "/api/settings/voice", {"input": "off"})

    def test_dictation_falls_back_without_mediarecorder(self):
        # WebKitGTK's MediaRecorder accepts a mime type and then refuses to start, so the
        # desktop app records through the Web Audio fallback. Taking MediaRecorder away
        # entirely walks the same path.
        b = self.b
        b.goto(self.url("/dispatch"))
        b.js("window.__clock = new AudioContext(); window.__clock.resume().catch(() => {}); 0")
        b.pump(0.5)
        able = b.js("window.__clock.state === 'running'")
        b.js("window.__clock.close().catch(() => {}); delete window.__clock; 0")
        if not able:
            # Without an audio server, as on a CI runner, Web Audio has no clock
            # and nothing can capture; the speak test skips the same way.
            return
        self.api(
            "POST",
            "/api/settings/voice",
            {"input": "local", "whisper_model": self.y.config},
        )
        try:
            b.goto(self.url("/dispatch"))
            b.wait("!document.getElementById('mic').hidden", "the microphone button in the composer")
            b.js("window.MediaRecorder = undefined")
            b.click("#mic")
            b.wait("document.getElementById('mic').classList.contains('recording')", "the fallback recorder to start")
            b.pump(1.0)
            b.click("#mic")
            b.wait(
                f"document.querySelector('#dispatch-input').value.includes({json.dumps(FAKE_DICTATION)})",
                "the fallback dictation to land in the message box",
            )
            self.set_field("#dispatch-input", "")
        finally:
            self.api("POST", "/api/settings/voice", {"input": "off"})

    def test_settings_voice_setup_card_models_and_mode(self):
        b = self.b
        models = self.y.models
        model = os.path.join(models, "ggml-tiny.en.bin")
        tiny = "#voice-models [data-model='tiny.en']"
        b.goto(self.url("/settings#voice"))
        b.wait("!document.getElementById('voice-setup-card').hidden && document.querySelectorAll('#voice-models .voice-model').length === 6",
               "the Set up dictation card and the six speech models")
        card = b.js("document.getElementById('voice-setup-model').textContent")
        if "Whisper Base (English)" not in card or "148 MB" not in card or "Good" not in card:
            raise Failure(f"the setup card recommends {card!r}")
        base = "#voice-models [data-model='base.en']"
        if not b.js(f"document.querySelector({json.dumps(base + ' .voice-badge')})?.textContent === 'Recommended' && document.querySelectorAll({json.dumps(base + ' .voice-dot.on')}).length === 3"):
            raise Failure("the recommended row lacks its badge or its three quality dots")
        if b.js("document.querySelectorAll('#voice-models [data-voice-act=download]').length") != 6:
            raise Failure("not every model offers Download")
        b.click("#voice-setup-btn")
        b.wait("document.getElementById('voice-setup-note').classList.contains('voice-error') && document.getElementById('voice-setup-note').textContent.includes('404')",
               "Set up to say the download failed")
        if FakeModels.asked[-1:] != ["/ggml-base.en.bin"]:
            raise Failure(f"Set up asked the model host for {FakeModels.asked}")
        if os.path.isdir(models) and os.listdir(models):
            raise Failure(f"a failed download left {os.listdir(models)} behind")
        os.makedirs(models, exist_ok=True)
        with open(model, "wb") as f:
            f.write(b"lmgg" + bytes(64))
        try:
            b.goto(self.url("/settings?seeded#voice"))
            b.wait(f"document.querySelector({json.dumps(tiny + ' [data-voice-act=use]')})", "Use on the downloaded model")
            b.click(f"{tiny} [data-voice-act=use]")
            b.wait(f"document.querySelector({json.dumps(tiny)})?.dataset.current === 'true' && document.getElementById('voice-setup-card').hidden",
                   "the model in use and the setup card gone")
            if b.js(f"document.querySelector({json.dumps(tiny + ' .voice-delete')})"):
                raise Failure("the model in use offers Delete")
            if "Ready with Whisper Tiny" not in b.js("document.getElementById('voice-state').textContent"):
                raise Failure("the Dictation row does not say it is ready")
            with open(self.y.config) as f:
                config = f.read()
            if "input: local" not in config or "whisper_model: tiny.en" not in config or os.path.join(self.y.fake_bin, "whisper-cli") not in config:
                raise Failure(f"Use did not switch to the model and the fake whisper-cli:\n{config}")
            b.wait("document.getElementById('voice-mode-desc').textContent.startsWith('Tap')", "Auto described")
            b.click("#voice-mode label:nth-child(2)")
            b.wait("document.getElementById('voice-mode-desc').textContent.startsWith('Talk while you hold')", "Hold described")
            b.click("#voice-fillers")
            self.set_field("#voice-vocabulary", "Yardbell, Dispatch")
            b.click("#voice-form button[type=submit]")
            b.wait("!document.getElementById('undo-bar').hidden", "the voice settings to save")
            with open(self.y.config) as f:
                config = f.read()
            for line in ("mode: hold", "remove_fillers: true", "vocabulary: Yardbell, Dispatch"):
                if line not in config:
                    raise Failure(f"yardbell.yml lacks {line!r}:\n{config}")
            if self.api("GET", "/dispatch/runs-on")["voice_mode"] != "hold":
                raise Failure("Dispatch is not told the dictation mode")
            self.api("POST", "/api/settings/voice", {"input": "off"})
            b.goto(self.url("/settings?off#voice"))
            b.wait(f"document.querySelector({json.dumps(tiny + ' .voice-delete')})", "Delete once the model is not in use")
            b.click(f"{tiny} .voice-delete")
            b.wait(f"document.querySelector({json.dumps(tiny + ' [data-voice-act=download]')})", "the model back to Download")
            if os.path.exists(model):
                raise Failure("Delete left the model file")
        finally:
            self.api("POST", "/api/settings/voice", {"input": "off"})
            if os.path.exists(model):
                os.remove(model)

    def test_dictation_types_each_pause_as_it_comes(self):
        # A tone that can be switched on and off stands in for the microphone, and the
        # transcription answers from a list, so the test speaks two phrases with a pause between.
        b = self.b
        b.goto(self.url("/dispatch"))
        b.js("window.__clock = new AudioContext(); window.__clock.resume().catch(() => {}); 0")
        b.pump(0.5)
        able = b.js("window.__clock.state === 'running'")
        b.js("window.__clock.close().catch(() => {}); delete window.__clock; 0")
        if not able:
            return
        self.api("POST", "/api/settings/voice", {"input": "local", "whisper_model": self.y.config})
        try:
            b.goto(self.url("/dispatch"))
            b.wait("!document.getElementById('mic').hidden && !document.getElementById('mic').classList.contains('voice-off')", "the microphone button, voice on")
            b.js("window.__said = [\"Fix the login test.\", \"Then run it again.\"]; 0")
            b.js(TONE_MICROPHONE)
            self.set_field("#dispatch-input", "")
            b.click("#mic")
            b.wait("document.getElementById('mic').classList.contains('recording')", "recording to start")
            b.js("window.__speak(true)")
            b.pump(0.8)
            b.js("window.__speak(false)")
            b.wait("document.querySelector('#dispatch-input').value.includes('Fix the login test.')",
                   "the first phrase typed in at the pause")
            if not b.js("document.getElementById('mic').classList.contains('recording')"):
                raise Failure("recording stopped when the first phrase landed")
            if b.js("window.__sent.length") != 1:
                raise Failure(f"{b.js('window.__sent.length')} pieces were sent after one phrase")
            b.js("window.__speak(true)")
            b.pump(0.8)
            b.click("#dictation-pill .dict-btn.finish")
            b.wait("document.querySelector('#dispatch-input').value.trim() === 'Fix the login test. Then run it again.'",
                   "the second phrase after the first, once Finish is pressed")
            b.wait("document.getElementById('dictation-pill').hidden && !document.getElementById('mic').classList.contains('recording')",
                   "the pill gone once every piece landed")
            if b.js("window.__sent.length") != 2:
                raise Failure(f"{b.js('window.__sent.length')} pieces were sent for two phrases")
            self.set_field("#dispatch-input", "")
        finally:
            self.api("POST", "/api/settings/voice", {"input": "off"})

    def test_dictation_stops_on_quiet_only_in_auto(self):
        b = self.b
        b.goto(self.url("/dispatch"))
        b.js("window.__clock = new AudioContext(); window.__clock.resume().catch(() => {}); 0")
        b.pump(0.5)
        able = b.js("window.__clock.state === 'running'")
        b.js("window.__clock.close().catch(() => {}); delete window.__clock; 0")
        if not able:
            return
        recording = "document.getElementById('mic').classList.contains('recording')"
        press = "document.getElementById('mic').dispatchEvent(new PointerEvent('%s', { bubbles: true, button: 0, pointerId: 1, isPrimary: true })); 0"
        try:
            for mode in ("toggle", "hold", "auto"):
                self.api("POST", "/api/settings/voice", {"input": "local", "whisper_model": self.y.config, "mode": mode})
                b.goto(self.url("/dispatch"))
                b.wait("!document.getElementById('mic').hidden && !document.getElementById('mic').classList.contains('voice-off')", "the microphone button, voice on")
                b.js('window.__said = ["One.", "Two.", "Three."]; 0')
                b.js(TONE_MICROPHONE)
                b.js(press % "pointerdown")
                if mode != "hold":
                    b.js(press % "pointerup")
                b.wait(recording, f"recording to start in {mode}")
                b.js("window.__speak(true)")
                b.pump(0.6)
                b.js("window.__speak(false)")
                b.pump(3.8)
                if mode == "auto":
                    if b.js(recording):
                        raise Failure("Auto kept recording through a long quiet")
                    continue
                if not b.js(recording):
                    raise Failure(f"{mode} stopped by itself in a quiet, before the user stopped it")
                if mode == "hold":
                    b.js(press % "pointerup")
                else:
                    b.js(press % "pointerdown")
                    b.js(press % "pointerup")
                b.wait(f"!({recording})", f"{mode} to stop when the user stops it")
                self.set_field("#dispatch-input", "")
        finally:
            self.api("POST", "/api/settings/voice", {"input": "off", "mode": "auto"})

    def test_settings_voice_choices_save_at_once(self):
        b = self.b
        try:
            b.goto(self.url("/settings#voice"))
            b.wait("document.querySelector('#voice-form input[name=mode][value=hold]')", "the dictation mode choices")
            b.click("#voice-form input[name=mode][value=hold]")
            deadline = time.time() + 5
            while self.api("GET", "/api/settings")["voice"].get("mode") != "hold":
                if time.time() > deadline:
                    raise Failure("picking Hold was not saved without pressing Save")
                b.pump(0.2)
            b.click("#voice-fillers")
            b.js("const v = document.getElementById('voice-vocabulary'); v.value = 'Yardbell'; v.dispatchEvent(new Event('change', { bubbles: true })); 0")
            deadline = time.time() + 5
            while True:
                v = self.api("GET", "/api/settings")["voice"]
                if v.get("remove_fillers") and v.get("vocabulary") == "Yardbell":
                    break
                if time.time() > deadline:
                    raise Failure(f"Remove filler words and Vocabulary were not saved at once: {v}")
                b.pump(0.2)
        finally:
            self.api("POST", "/api/settings/voice", {"input": "off", "mode": "auto", "remove_fillers": False, "vocabulary": ""})

    def test_dictation_shortcut_defaults_per_platform_and_can_be_changed(self):
        b = self.b
        recording = "document.getElementById('mic').classList.contains('recording')"
        b.goto(self.url("/settings#voice"))
        b.wait("window.YardbellVoiceKeys && document.getElementById('voice-shortcut')", "the dictation shortcut row")
        mac = b.js("JSON.stringify(YardbellVoiceKeys.defaults(true))")
        other = b.js("JSON.stringify(YardbellVoiceKeys.defaults(false))")
        if json.loads(mac) != {"code": "KeyE", "ctrl": False, "shift": False, "alt": False, "meta": True}:
            raise Failure(f"a Mac's default dictation shortcut is {mac}, not Command+E")
        if json.loads(other) != {"code": "Space", "ctrl": True, "shift": True, "alt": False, "meta": False}:
            raise Failure(f"the default elsewhere is {other}, not Ctrl+Shift+Space")
        if b.js("YardbellVoiceKeys.label(YardbellVoiceKeys.defaults(true), true)") != "\u2318E":
            raise Failure("the Mac shortcut is not written as \u2318E")
        try:
            b.click("#voice-shortcut-change")
            b.wait("document.getElementById('voice-shortcut').classList.contains('listening')", "the shortcut row to listen for keys")
            b.key("d", "Alt")
            b.wait("!document.getElementById('voice-shortcut').classList.contains('listening')", "the new shortcut to be taken")
            kept = json.loads(b.js("localStorage.getItem('yardbell.voice.shortcut')") or "null")
            if not kept or kept.get("code") != "KeyD" or not kept.get("alt") or kept.get("ctrl"):
                raise Failure(f"Alt+D was stored as {kept}")
            if "D" not in b.js("document.getElementById('voice-shortcut').textContent"):
                raise Failure("the row does not show the new shortcut")
            self.api("POST", "/api/settings/voice", {"input": "local", "whisper_model": self.y.config})
            b.goto(self.url("/dispatch"))
            b.wait("!document.getElementById('mic').hidden && !document.getElementById('mic').classList.contains('voice-off')", "the microphone button, voice on")
            b.js("document.getElementById('mic').dispatchEvent(new PointerEvent('pointerenter')); 0")
            title = b.js("document.getElementById('mic').title")
            if "Alt+D" not in title:
                raise Failure(f"the microphone's hint does not name the new shortcut: {title!r}")
            b.click("#dispatch-input")
            b.key(" ", "Control", "Shift")
            b.pump(0.6)
            if b.js(recording):
                raise Failure("the old Ctrl+Shift+Space still starts dictation after the shortcut changed")
            b.key("d", "Alt")
            b.wait(recording, "Alt+D to start recording")
            b.click("#dictation-pill .dict-btn")
            b.wait(f"!({recording})", "Cancel to stop it")
            b.goto(self.url("/settings#voice"))
            b.wait("document.getElementById('voice-shortcut-reset')", "the reset button")
            b.click("#voice-shortcut-reset")
            if b.js("localStorage.getItem('yardbell.voice.shortcut')") is not None:
                raise Failure("Reset did not go back to the default shortcut")
        finally:
            b.js("localStorage.removeItem('yardbell.voice.shortcut')")
            self.api("POST", "/api/settings/voice", {"input": "off"})

    def test_dispatch_speak_toggle_mutes_at_once(self):
        b = self.b
        b.goto(self.url("/dispatch"))
        b.wait("document.getElementById('dispatch-send')", "the Dispatch page")
        able = b.js("'speechSynthesis' in window")
        if not able:
            if not b.js("document.getElementById('speak-toggle').hidden"):
                raise Failure("the speak toggle shows although the browser cannot speak")
            return
        b.wait("!document.getElementById('speak-toggle').hidden", "the speak toggle")
        if b.js("document.getElementById('speak-toggle').getAttribute('aria-pressed')") != "false":
            raise Failure("speaking is not off by default")
        b.click("#speak-toggle")
        b.wait("document.getElementById('speak-toggle').getAttribute('aria-pressed') === 'true'", "speaking turned on")
        if b.js("localStorage.getItem('yardbell.dispatch.speak')") != "1":
            raise Failure("the choice is not kept on this device")
        b.goto(self.url("/settings#voice"))
        b.wait("document.getElementById('speak-enable').checked", "the same switch on in Settings")
        b.click("#speak-enable")
        b.goto(self.url("/dispatch"))
        b.wait("document.getElementById('speak-toggle').getAttribute('aria-pressed') === 'false'", "Settings turned it off")

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
        row = f"document.querySelector('.s-row [data-name={json.dumps(PULL_SESSION)}]').closest('.s-row')"
        review = b.js(f"{row}.querySelector('[data-act=review-pull]')?.textContent.trim()")
        if review != "Review #12":
            raise Failure(f"the row offers {review!r} instead of Review #12")
        # The newest seeded review of fix-login is a step still waiting for approval.
        mark = b.wait(f"{row}.querySelector('.review-mark')?.textContent", "the review mark beside the badge")
        if mark != "review waiting":
            raise Failure(f"the review mark says {mark!r}")
        href = b.js(f"{row}.querySelector('.review-mark').getAttribute('href')")
        if not href.startswith("/dispatch?c="):
            raise Failure(f"the review mark links to {href!r}")
        b.goto(self.url("/workspace"))
        b.wait("document.querySelector('#col-body .tree-pr.bad')?.textContent === '#12'", "the pull request mark in the Workspace tree")

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

    def test_a_usage_limit_card_offers_to_resume(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={LIMIT_CHAT}"))
        b.wait("document.querySelector('#dispatch-log .pull-card .badge')?.textContent === 'Limit reset'", "the limit reset card")
        text = b.js("document.querySelector('#dispatch-log .pull-card').innerText")
        for expected in ("demo-app", "You've hit your limit · resets 3pm", "so it can go on", "Send to session"):
            if expected not in text:
                raise Failure(f"the card does not show {expected!r}:\n{text}")
        if "#" in text.split("\n")[0]:
            raise Failure(f"the limit card names a pull request:\n{text}")
        b.click("#dispatch-log .pull-card .pull-sends summary")
        if "continue" not in b.js("document.querySelector('#dispatch-log .pull-card .pull-sends').innerText"):
            raise Failure("the card does not say it sends continue")

    def test_merge_on_the_board_merges_a_ready_pull_request(self):
        b = self.b
        worktree = os.path.join(os.path.dirname(self.y.root), "merge-wt")
        if not os.path.exists(worktree):
            git("worktree", "add", "-q", "-b", MERGE_BRANCH, worktree, cwd=os.path.join(self.y.root, "demo-app"))
        r = self.y.tmux("new", "-d", "-s", MERGE_SESSION, "-c", worktree, self.y.shell)
        if r.returncode:
            raise Failure(f"tmux new failed: {r.stderr}")
        try:
            self.api("POST", "/refresh")
            b.js("localStorage.removeItem('yardbell.dashboard.view')")
            b.goto(self.url("/?view=board"))
            b.wait(
                f"(async () => (await (await fetch('/state')).json()).sessions.find((s) => s.tmux === {json.dumps(MERGE_SESSION)})?.pull?.review === 'approved')()",
                "the ready pull request in /state",
                timeout=45,
            )
            button = f"document.querySelector('.b-lane[data-lane=ready] .b-card[data-name={json.dumps(MERGE_SESSION)}] [data-act=merge]')"
            b.wait(button, "the Merge button on the Ready to merge card")
            if b.js(f"{button}.textContent.trim()") != "Merge #34":
                raise Failure(f"the button says {b.js(f'{button}.textContent')!r}")
            if b.js("!!document.querySelector('.b-lane[data-lane=needs] [data-act=merge]')"):
                raise Failure("a session that is not ready offers Merge")
            b.click(f".b-lane[data-lane=ready] .b-card[data-name={json.dumps(MERGE_SESSION)}] [data-act=merge]")
            b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('Merge #34?')", "the question before merging")
            if os.path.exists(self.y.merges):
                raise Failure("it merged before it was confirmed")
            b.click("dialog.confirm[open] [data-answer=yes]")
            b.wait("document.getElementById('toast').textContent === 'Merged #34'", "the merged toast")
            with open(self.y.merges) as f:
                said = f.read().strip()
            if said != "pr merge 34 --merge --match-head-commit def456":
                raise Failure(f"gh was asked to {said!r}")
            b.goto(self.url("/?view=machines"))
            b.wait(f"document.querySelector('.s-row [data-name={json.dumps(MERGE_SESSION)}]')?.closest('.s-row').querySelector('[data-act=merge]')", "Merge on the session's row too")
        finally:
            self.y.tmux("kill-session", "-t", f"={MERGE_SESSION}")
            b.js("localStorage.removeItem('yardbell.dashboard.view')")

    def test_board_lays_sessions_into_lanes(self):
        b = self.b
        b.goto(self.url("/"))
        b.wait("window.YardbellBoard", "the board helpers")
        lanes = b.js(
            """(() => {
              const B = window.YardbellBoard;
              const pr = (more) => ({forge: 'github', number: 1, state: 'open', ci: 'passing', review: '', draft: false, mergeable: 'clean', ...more});
              const s = (activity, pull) => ({activity, pull});
              return [
                s('blocked', pr({ci: 'failing'})),
                s('active', pr({ci: 'failing'})),
                s('idle', pr({ci: 'failing'})),
                s('idle', pr({mergeable: 'conflicting', review: 'approved'})),
                s('idle', pr({review: 'changes_requested'})),
                s('idle', pr({review: 'approved'})),
                s('idle', pr({review: 'approved', ci: 'none', mergeable: 'unknown'})),
                s('idle', pr({review: 'approved', draft: true})),
                s('idle', pr({ci: 'pending'})),
                s('idle', pr({})),
                s('idle', pr({state: 'merged'})),
                s('idle', undefined),
                {activity: 'idle', stopped: 'API Error: 529', pull: pr({review: 'approved'})},
              ].map(B.lane);
            })()"""
        )
        want = ["needs", "working", "needs", "needs", "needs", "ready", "ready", "review", "review", "review", "idle", "idle", "needs"]
        if lanes != want:
            raise Failure(f"the lanes are {lanes}, not {want}")
        self.pull_session()
        b.js("localStorage.removeItem('yardbell.dashboard.view')")
        b.goto(self.url("/"))
        b.wait(
            f"(async () => (await (await fetch('/state')).json()).sessions.find((s) => s.tmux === {json.dumps(PULL_SESSION)})?.pull?.ci === 'failing')()",
            "the failing pull request in /state",
            timeout=45,
        )
        b.click("[data-view=board]")
        card = f"document.querySelector('.b-lane[data-lane=needs] .b-card[data-name={json.dumps(PULL_SESSION)}]')"
        b.wait(card, "the session with failing CI under Needs you")
        text = b.js(f"{card}.innerText")
        for expected in ("demo-app", "CI failing", "#12"):
            if expected not in text:
                raise Failure(f"the card does not show {expected!r}:\n{text}")
        titles = b.js("[...document.querySelectorAll('.b-lane h2 .b-title')].map((t) => t.textContent)")
        if titles != ["Needs you", "Working", "In review", "Ready to merge", "Idle"]:
            raise Failure(f"the lanes are titled {titles}")
        if "view=board" not in b.js("location.search"):
            raise Failure("the address does not keep the board")
        b.goto(self.url("/"))
        b.wait(card, "the board again after a reload")
        b.js("document.getElementById('search').value = 'no-such-session'; document.getElementById('search').dispatchEvent(new Event('input'))")
        b.wait("document.querySelector('#groups .empty')?.innerText.includes('No sessions match')", "the empty board while nothing matches")
        b.viewport(380, 800)
        try:
            b.goto(self.url("/?view=board"))
            b.wait(card, "the board at phone width")
            wide = b.js("document.documentElement.scrollWidth > document.documentElement.clientWidth")
            if wide:
                raise Failure("the board scrolls sideways at phone width")
        finally:
            b.viewport(1280, 800)
        b.click("[data-view=machines]")
        b.wait(f"document.querySelector('.s-row [data-name={json.dumps(PULL_SESSION)}]')", "the machine sections again")
        b.js("localStorage.removeItem('yardbell.dashboard.view')")

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

    def test_settings_saves_health_checks(self):
        b = self.b
        b.goto(self.url("/settings#health"))
        b.wait("document.querySelector('#health-form input[name=ci_pending_minutes]')?.value === '120'", "the defaults")
        b.wait("document.querySelector('#health-form input[name=ci_pending]').checked", "the check on")
        b.click("#health-form input[name=memory_short]")
        self.set_field("#health-form input[name=ci_pending_minutes]", "45")
        b.click("#health-form button[type=submit]")
        b.wait("document.getElementById('undo-text').textContent.includes('Health checks updated')", "the checks saved")
        with open(self.y.config) as f:
            config = f.read()
        for want in ("ci_pending_minutes: 45", "memory_short: false"):
            if want not in config:
                raise Failure(f"yardbell.yml does not hold {want!r}:\n{config}")
        b.wait("document.querySelector('#health-form input[name=ci_pending_minutes]').value === '45'", "the saved time shown")

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

        self.row_action("[data-secret-row=github]", "[data-replace=github]")
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

        self.row_action("[data-secret-row=github]", "[data-delete=github]")
        b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('github uses it')", "the delete confirmation naming its server")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("!document.querySelector('#secret-rows [data-replace=github]') && !document.getElementById('secrets-missing').hidden", "github deleted and missing again")

    def test_settings_trigger_runs_now_and_marks_its_conversation(self):
        b = self.b
        b.goto(self.url("/settings#triggers"))
        # An MCP server whose secret is missing stops a triggered run, as it stops a typed one.
        self.b.js("if (window.__real) { window.fetch = window.__real; delete window.__real; }")
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

    def test_a_long_dispatch_conversation_never_moves_the_page(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={TASK_CHAT}"))
        b.wait("document.querySelector('#dispatch-log .step-card .visually-hidden')", "a card with a hidden label")
        seen = b.js("""(() => {
          const log = document.getElementById('dispatch-log');
          for (let i = 0; i < 60; i++) { const p = document.createElement('p'); p.textContent = 'line ' + i; log.prepend(p); }
          const chat = document.querySelector('.dispatch-chat');
          chat.scrollTo({ top: chat.scrollHeight });
          window.scrollTo({ top: document.body.scrollHeight });
          return { page: document.documentElement.scrollHeight - innerHeight, moved: scrollY };
        })()""")
        if seen["page"] > 0 or seen["moved"] > 0:
            raise Failure(f"the conversation stretched the page: {seen}")

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

    def test_each_part_of_the_timeline_says_what_happened(self):
        b = self.b
        if not self.session:
            path = os.path.join(self.y.root, "demo-app")
            self.session = self.api("POST", "/sessions", {"machine": MACHINE, "path": path, "wait": True})["name"]
        row = f".s-row [data-act=insights][data-name={json.dumps(self.session)}]"
        b.goto(self.url("/"))
        b.wait(f"document.querySelector('{row}')", "Insights on a session row", timeout=15)
        none = {"asked": [], "question": "", "stopped_at": "", "summary": "", "did": [], "more": 0, "files": [], "said": ""}
        working = {**none, "asked": ["Now add a test <img src=x onerror=window.__bad=1>"], "summary": "Edited 1 file, ran 1 command",
                   "did": [{"tool": "Bash", "what": "Ran the tests"}, {"tool": "Edit", "what": "Edited src/login.rs"}],
                   "files": ["src/login.rs"], "said": "The tests pass now."}
        waiting = {**none, "question": "Which database?"}
        now = "new Date().toISOString()"
        b.js("""window.__ins_real = window.fetch; window.fetch = (u, o) => String(u).endsWith('/insights')
          ? window.__ins_real(u, o).then((r) => r.json()).then((d) => {
              const at = %s;
              d.task = '';
              d.work = window.__work;
              d.parts = window.__parts;
              d.timeline = { ...(d.timeline || {}), since: at, started: true, ended: null, dropped: 0, totals: { working: 60, waiting: 60, idle: 0 },
                runs: [{ at, kind: 'tool', text: 'Bash: from the screen' }], folder: '', branch: '', agent: 'claude',
                periods: [{ state: 'working', from: at, to: at, seconds: 60 }, { state: 'waiting', from: at, to: null, seconds: 60 }] };
              return new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
            })
          : window.__ins_real(u, o);
          window.__work = %s; window.__parts = %s;""" % (now, json.dumps({"title": "Fix the login", "first_prompt": "Fix the login bug", "partial": True, "shared": True, "screen": ""}),
                                                        json.dumps({"before": none, "periods": [working, waiting]})))
        try:
            b.click(row)
            b.wait("document.querySelector('.ins-dialog .ins-part')", "the detail of a part")
            first = b.js("document.querySelector('.ins-period.working').innerText")
            for want in ("You said", "Now add a test <img", "Edited 1 file, ran 1 command", "The tests pass now.", "Show 2 steps"):
                if want not in first:
                    raise Failure(f"the working part does not say {want!r}: {first}")
            if "Which database?" not in b.js("document.querySelector('.ins-period.waiting').innerText"):
                raise Failure("the wait does not say what the agent asked")
            if b.js("window.__bad || document.querySelector('.ins-part img')"):
                raise Failure("text from the transcript was not escaped")
            if b.js("document.querySelector('.ins-dialog .ins-run.is-tool')"):
                raise Failure("a tool call from the screen repeats what the part already says")
            if b.js("document.querySelector('.ins-about').textContent") != "Fix the login":
                raise Failure("the dialog does not open with what the session is about")
            heads = b.js("[...document.querySelectorAll('.ins-body h3')].map((h) => h.textContent)")
            if heads[0] != "Time spent" or "Timeline" not in heads:
                raise Failure(f"the sections read {heads}")
            note = b.js("[...document.querySelectorAll('.ins-note')].map((n) => n.textContent).join(' ')")
            for want in ("Another session runs in this folder", "older stretches may have no detail"):
                if want not in note:
                    raise Failure(f"the timeline does not warn {want!r}: {note}")
            b.js("document.querySelector('.ins-steps summary').click()")
            b.wait("document.querySelector('.ins-steps[open] li')?.textContent === 'Ran the tests'", "the steps to open")
            b.click(".ins-dialog [data-ins=close]")
            b.wait("!document.querySelector('.ins-dialog')", "the dialog to close")
            b.js("window.__work = { title: '', first_prompt: '', screen: 'last line on screen' }; window.__parts = null")
            b.click(row)
            b.wait("document.querySelector('.ins-work pre')?.textContent.includes('last line on screen')", "the end of the terminal")
            if not b.js("document.querySelector('.ins-dialog .ins-run.is-tool')"):
                raise Failure("with no transcript, tool calls from the screen should stay")
            b.click(".ins-dialog [data-ins=close]")
            self.check_errors("the parts of the timeline")
        finally:
            b.js("window.fetch = window.__ins_real")

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
            self.b.wait("document.querySelector(':is(.side-link, .rail-link)[href=\"/pipeline\"]')", f"the Pipeline link on {page}")
            order = self.b.js("[...document.querySelectorAll('a:is(.side-link, .rail-link)[href]')].map((a) => a.getAttribute('href')).join(' ')")
            if "/workspace /pipeline /diagrams /dispatch" not in order:
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
                     "Understand", "Test ⟲ Root cause", "v1", "1 running · 4 waiting · 1 held a long time · 2 done", "Needs you"):
            if want not in text:
                raise Failure(f"the card does not say {want!r}: {text}")
        if b.js(f"document.querySelector('{card} input[type=checkbox]').checked"):
            raise Failure("a pipeline that is off shows as on")
        b.click(f"{card} input[type=checkbox]")
        b.wait("document.getElementById('toast').textContent.includes('gitlab_reviewer names git.example.com')",
               "the checks' problem when switching on")
        b.wait(f"!document.querySelector('{card} input[type=checkbox]').checked", "the switch back off")
        b.click("#pl-waiting-toggle")
        b.wait("document.querySelectorAll('#pl-waiting .pl-wait-item').length === 5", "four waiting runs and one held too long")
        if "!87 COM-1287 Fix the webhook dedup" not in b.js("document.getElementById('pl-waiting').textContent"):
            raise Failure("the waiting list does not name the merge request")
        self.check_errors("the Pipelines list")

    def test_pipelines_column_lists_waiting_first(self):
        b = self.b
        before = self.storage(["yardbell.side", "yb-pipeline-full"])
        made = self.api("POST", "/api/pipelines", {"empty": True})["id"]
        try:
            self.put_storage({"yardbell.side": None, "yb-pipeline-full": "0"})
            pipelines = self.api("GET", "/api/pipelines")["pipelines"]
            want = [p["definition"]["id"] for p in sorted(pipelines, key=lambda p: (p["runs"]["waiting"] == 0, p["definition"]["name"].lower()))]
            review = next(p for p in pipelines if p["definition"]["id"] == "review")["runs"]["waiting"]
            if want[0] != "review" or not review or len(want) < 2:
                raise Failure(f"the test needs the review pipeline waiting and another one after it: {want}")
            b.goto(self.url("/pipeline"))
            rows = "#col-body a.col-row"
            b.wait(f"document.querySelectorAll('{rows}').length === {len(want)}", "every pipeline in the column")
            if b.js("Boolean(window.YardbellNav) || document.querySelector('.side') !== null"):
                raise Failure("the Pipelines page still draws the old sidebar")
            b.wait("window.YardbellShell.lastState !== null", "the state for the strip")
            listed = b.js(f"""[...document.querySelectorAll('{rows}')].map((r) => ({{
              href: r.getAttribute('href'),
              meta: r.querySelector('.col-row-meta')?.textContent || '',
              warn: Boolean(r.querySelector('.col-row-meta.warn')),
              current: r.getAttribute('aria-current'),
            }}))""")
            if [r["href"] for r in listed] != [f"/pipeline?p={id}" for id in want]:
                raise Failure(f"the column lists {[r['href'] for r in listed]}, not waiting first then by name {want}")
            if listed[0]["meta"] != str(review) or not listed[0]["warn"]:
                raise Failure(f"the review row does not show its {review} waiting runs in the warn tone: {listed[0]}")
            if any(r["meta"] for r in listed[1:] if r["href"] == f"/pipeline?p={made}"):
                raise Failure(f"a pipeline with no waiting runs shows a count: {listed}")
            if any(r["current"] for r in listed):
                raise Failure(f"a row is current on the list: {listed}")
            badge = b.js("document.querySelector('#rail [data-count=pipelines]')?.textContent")
            if badge != str(sum(p["runs"]["waiting"] for p in pipelines)):
                raise Failure(f"the rail's Pipelines badge reads {badge!r}")

            b.js(f"""(() => {{
              window.__stayed = true;
              const real = window.fetch;
              window.fetch = async (url, init) => {{
                const res = await real(url, init);
                if (String(url) !== '/api/pipelines') return res;
                const body = await res.json();
                for (const p of body.pipelines) if (p.definition.id === {json.dumps(made)}) p.problem = 'The trigger needs a connector';
                return new Response(JSON.stringify(body), {{ status: 200, headers: {{ 'Content-Type': 'application/json' }} }});
              }};
            }})()""")
            b.click(f"{rows}[href='/pipeline?p=review']")
            b.wait("new URLSearchParams(location.search).get('p') === 'review' && document.querySelector('.pl-builder .pl-run-view')", "the review pipeline's runs")
            b.wait(f"document.querySelector(\"{rows}[href='/pipeline?p=review']\").getAttribute('aria-current') === 'page'", "its row marked current")
            if not b.js("window.__stayed === true"):
                raise Failure("opening a pipeline from the column reloaded the page")
            if b.js(f"[...document.querySelectorAll('{rows}[aria-current]')].length") != 1:
                raise Failure("more than one row is current")
            b.wait(f"document.querySelector(\"{rows}[href='/pipeline?p={made}'] .dot.bad\")", "the problem pipeline's dot")
            if b.js("document.documentElement.classList.contains('side-rail')"):
                raise Failure("the Runs tab collapsed the column")

            b.click(f"{rows}[href='/pipeline?p={made}']")
            b.wait(f"new URLSearchParams(location.search).get('p') === {json.dumps(made)} && document.querySelector('.pl-builder:not(.full) .pl-canvas')", "the empty pipeline's builder")
            b.wait("document.documentElement.classList.contains('side-rail')", "the builder to collapse the column")
            seen = b.js("""(() => ({
              stored: localStorage.getItem('yardbell.side'),
              left: Math.round(document.querySelector('.pl-builder').getBoundingClientRect().left),
              rail: Math.round(document.getElementById('rail').getBoundingClientRect().right),
              stayed: window.__stayed === true,
            }))()""")
            if seen["stored"] is not None or not seen["stayed"] or seen["left"] - seen["rail"] > 40:
                raise Failure(f"the builder's collapse is stored, reloads or leaves the column's room empty: {seen}")
            b.click("#pl-back")
            b.wait("!new URLSearchParams(location.search).get('p') && !document.documentElement.classList.contains('side-rail')", "the column back on the list")

            b.click("#col-new")
            b.wait("document.getElementById('pl-templates')", "the column's New pipeline to open the templates")
            if b.js("document.getElementById('col-new').getAttribute('aria-expanded')") != "true":
                raise Failure("the column's New pipeline does not say the templates are open")
        finally:
            self.api("DELETE", f"/api/pipelines/{made}")
            self.put_storage(before)
        self.check_errors("the Pipelines column")

    def test_pipeline_new_from_template(self):
        b = self.b
        b.goto(self.url("/pipeline"))
        b.click("#pl-new")
        b.wait("document.querySelector('#pl-templates button')", "the templates")
        b.js("[...document.querySelectorAll('#pl-templates button')].find((x) => x.textContent.includes('Implement my tickets')).click()")
        b.wait("new URLSearchParams(location.search).get('p') === 'implement-my-tickets'", "the new pipeline opened")
        b.wait("document.querySelector('.pl-title-name')?.value === 'Implement my tickets'", "its name")
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
        b.wait("document.querySelector('.pl-builder:not(.full)') && document.getElementById('rail').getBoundingClientRect().width > 0", "the builder back in the page")
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-builder:not(.full) .pl-run-view')", "the Runs tab remembering the choice")
        if b.js("document.querySelector('.pl-run-main').getBoundingClientRect().bottom") < b.js("innerHeight") - 40:
            raise Failure("the Runs view does not reach the bottom of the window")
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
        b.js("document.querySelector('.pl-lib-item[data-kind=\"wait\"]').scrollIntoView({ block: 'center' })")
        b.drag('.pl-lib-item[data-kind="wait"]', tuple(spot), steps=10)
        b.wait("document.querySelector('.pl-node.kind-wait')", "a Wait for me card where it was dropped")
        if not b.js("document.querySelector('.pl-node.kind-wait').classList.contains('selected')"):
            raise Failure("the new step is not selected")
        if b.js("document.getElementById('pl-save').classList.contains('pl-saved')"):
            raise Failure("Save stays off after adding a step")
        self.check_errors("dragging from the library")

    def test_builder_wait_for_ci_step_saves_its_approval_and_minutes(self):
        b = self.b
        original = self.api("GET", "/api/pipelines/review")
        self.open_builder()
        b.click('.pl-node[data-step="test"]')
        b.wait("document.querySelector('#pl-inspector .pl-step-form[data-step=\"test\"]')", "the Test step in the inspector")
        b.js("document.querySelector('.pl-lib-item[data-kind=\"checks\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-checks.selected')", "the new wait on Test's pass line")
        if b.js("document.querySelector('#pl-inspector input[name=max_runs]').value") != "5":
            raise Failure("a new wait should allow a Fix loop, with 5 runs")
        b.click("#pl-inspector input[name=require_approval]")
        b.wait("document.querySelector('.pl-node.kind-checks').textContent.includes('an approval')", "the card saying it waits for an approval")
        self.set_field('#pl-inspector input[name=minutes]', "240")
        b.click("#pl-save")
        b.wait(f"(async () => (await (await fetch('/api/pipelines/review')).json()).version === {original['version'] + 1})()", "the pipeline saved")
        saved = self.api("GET", "/api/pipelines/review")
        step = next(s for s in saved["steps"] if s["kind"] == "checks")
        if (step["require_approval"], step["minutes"]) != (True, 240):
            raise Failure(f"the wait was saved as {step}")
        self.check_errors("the wait for CI step")
        self.api("PUT", "/api/pipelines/review", original)

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
        b.click("#pl-back")
        b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('Leave without saving your changes?')", "the question")
        b.click("dialog.confirm[open] [data-answer=no]")
        b.wait("!document.querySelector('dialog.confirm[open]')", "the dialog closed")
        if not b.js("!!document.querySelector('.pl-node.kind-wait')"):
            raise Failure("saying no still threw the change away")
        b.click("#pl-back")
        b.wait("document.querySelector('dialog.confirm[open]')", "the question again")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("!new URLSearchParams(location.search).get('p')", "leaving once confirmed")

    def test_back_while_editing_asks_once_and_keeps_the_draft(self):
        b = self.b
        self.open_builder()
        b.js("document.querySelector('.pl-lib-item[data-kind=\"wait\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-wait')", "an unsaved change")
        builder = b.js("location.href")
        b.js("history.replaceState(null, '', '/pipeline'); history.pushState(null, '', " + repr(builder) + ")")
        b.js("history.back()")
        b.wait("document.querySelector('dialog.confirm[open]')", "the question")
        b.wait("new URLSearchParams(location.search).get('p')", "the address still on the pipeline while it asks")
        b.js("history.back()")
        b.pump(6)
        if b.js("document.querySelectorAll('dialog.confirm[open]').length") != 1:
            raise Failure("a second Back stacked another question")
        if not b.js("!!document.querySelector('.pl-node.kind-wait')"):
            raise Failure("the page reloaded behind the question and lost the change")
        b.click("dialog.confirm[open] [data-answer=no]")
        b.wait("!document.querySelector('dialog.confirm[open]')", "the dialog closed")
        if not b.js("!!document.querySelector('.pl-node.kind-wait')"):
            raise Failure("saying no still threw the change away")
        b.js("history.back()")
        b.wait("document.querySelector('dialog.confirm[open]')", "the question again")
        b.click("dialog.confirm[open] [data-answer=yes]")
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
        b.wait("(async () => (await (await fetch('/api/pipelines/review')).json()).version === 1)()", "version 1 made current")
        if len(self.api("GET", "/api/pipelines/review/history")["history"]) < saved["version"]:
            raise Failure("restoring added or dropped a version")

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
        made = self.api("POST", "/api/pipelines", {"template": "Implement my tickets"})
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
        b.js("history.back()")
        b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('Leave without saving your changes?')", "the question")
        b.click("dialog.confirm[open] [data-answer=no]")
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

    def test_a_run_past_its_token_limit_shows_it_and_can_be_raised(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-d"))
        b.wait("document.querySelector('#pl-need')?.textContent.includes('612,400 tokens')", "what it used and the limit")
        use = b.js("document.getElementById('pl-tokens').textContent")
        for want in ("612,400 tokens", "Limit 500,000", "3,000,000 more were read from cache"):
            if want not in use:
                raise Failure(f"the run's use does not say {want!r}: {use}")
        words = b.js("document.getElementById('pl-need').textContent")
        if "Continue on pass" in words or "Start this step anyway" not in words:
            raise Failure(f"the waiting box offers the wrong choices: {words}")
        self.set_field("#pl-raise", "100")
        b.js("document.querySelector('.pl-raise button').click()")
        b.wait("document.getElementById('toast').textContent.includes('Set a limit above the 612,400 tokens')", "a limit below the use refused")
        self.set_field("#pl-raise", "900000")
        b.js("document.querySelector('.pl-raise button').click()")
        b.wait("(async () => { const r = (await (await fetch('/api/runs')).json()).runs.find((r) => r.id === 'run-d'); return r.tokens.limit === 900000 && r.state !== 'waiting'; })()",
               "the limit raised and the run going on")
        self.check_errors("the raised limit")

    def test_a_run_that_cannot_measure_says_so(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-e"))
        b.wait("document.getElementById('pl-tokens')?.textContent.includes('At least 3,000 tokens')", "the partial total")
        use = b.js("document.getElementById('pl-tokens').textContent")
        if "does not report tokens" not in use:
            raise Failure(f"the run does not name the unknown step: {use}")
        if not b.js("document.getElementById('pl-need').textContent.includes('Start this step anyway')"):
            raise Failure("the waiting box does not offer to go on")
        self.check_errors("the unknown use")

    def test_a_limit_with_an_agent_that_cannot_report_warns_in_the_builder(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&tab=build"))
        b.wait("document.querySelector('#pl-inspector input[name=token_limit]')", "the token limit in the builder")
        if b.js("document.getElementById('pl-token-blind')"):
            raise Failure("no limit is set, and the builder warns anyway")
        self.set_field("#pl-inspector input[name=token_limit]", "500000")
        b.wait("document.getElementById('pl-token-blind')?.textContent.includes('cannot report tokens')", "the warning about the agents")
        self.set_field("#pl-inspector input[name=token_limit]", "")
        self.check_errors("the builder's token limit")

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

    def test_pipeline_history_restore_delete_and_clear(self):
        b = self.b
        definition = self.api("GET", "/api/pipelines/review")
        first = definition["steps"][0]["name"]
        definition["steps"][0]["name"] = "Read it"
        saved = self.api("PUT", "/api/pipelines/review", definition)
        newest = saved["version"]
        count = len(self.api("GET", "/api/pipelines/review/history")["history"])
        b.goto(self.url("/pipeline?p=review&tab=history"))
        b.wait(f"document.querySelector('.pl-history-row')?.dataset.version === '{newest}'", "the newest version first")
        b.click('.pl-history-row[data-version="1"] .pl-history-restore')
        b.wait("(async () => (await (await fetch('/api/pipelines/review')).json()).version === 1)()", "version 1 made current")
        if self.api("GET", "/api/pipelines/review")["steps"][0]["name"] != first:
            raise Failure("restoring version 1 did not bring its step names back")
        history = self.api("GET", "/api/pipelines/review/history")
        if len(history["history"]) != count or history["current"] != 1:
            raise Failure(f"a restore should add no version and make v1 current: {len(history['history'])} versions, current {history['current']}")
        b.wait("document.querySelector('.pl-history-row[data-version=\"1\"] .pl-current')", "v1 marked Current")
        if b.js(f"!!document.querySelector('.pl-history-row[data-version=\"{newest}\"] .pl-history-restore')") is not True:
            raise Failure("the newer version cannot be restored again")
        b.click(f'.pl-history-row[data-version="{newest}"] .pl-history-delete')
        b.wait("document.querySelector('dialog.confirm[open]')", "the delete question")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait(f"!document.querySelector('.pl-history-row[data-version=\"{newest}\"]')", "the deleted version gone")
        if b.js("!!document.querySelector('.pl-history-row[data-version=\"1\"] .pl-history-delete')"):
            raise Failure("the current version offers Delete")
        if count > 2:
            b.click("#pl-history-clear")
            b.wait("document.querySelector('dialog.confirm[open]')", "the clear question")
            b.click("dialog.confirm[open] [data-answer=yes]")
            b.wait("document.querySelectorAll('.pl-history-row').length === 1", "only the current version left")
            if self.api("GET", "/api/pipelines/review/history")["history"][0]["version"] != 1:
                raise Failure("Clear history did not keep the current version")

    def test_pipeline_run_held_for_memory(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-held"))
        b.wait("document.querySelector('#pl-held')?.textContent.includes('short of memory: 93%')", "why the run is held")
        text = b.js("document.getElementById('pl-held').textContent")
        if "still starts by itself" not in text:
            raise Failure(f"a run held too long does not say what happens next: {text}")
        if "held" not in b.js("document.querySelector('.pl-run-item[data-id=\"run-held\"] small').textContent"):
            raise Failure("the run list does not say the run is held")
        if "held" not in b.js("document.querySelector('.pl-node[data-step=\"test\"]').textContent"):
            raise Failure("the step on the graph does not say held")
        b.goto(self.url("/pipeline"))
        b.click("#pl-waiting-toggle")
        b.wait("[...document.querySelectorAll('#pl-waiting .pl-wait-why')].some((x) => x.textContent.includes('short of memory'))", "the held run under Waiting for me")

    def test_pipeline_settings_panel(self):
        b = self.b
        b.goto(self.url("/pipeline"))
        b.click("#pl-settings-open")
        b.wait("document.querySelector('#pl-settings input[name=per_machine]')", "the settings form")
        self.set_field("#pl-settings input[name=per_machine]", "3")
        self.set_field("#pl-settings input[name=minutes]", "90")
        off = b.js("""(() => {
          const limit = document.querySelector('#pl-settings input[name=memory_limit]');
          return { on: document.querySelector('#pl-settings input[name=memory_on]').checked, disabled: limit.disabled, value: limit.value };
        })()""")
        if off != {"on": False, "disabled": True, "value": ""}:
            raise Failure(f"the memory limit is not off with no number by default: {off}")
        help_text = b.js("document.querySelector('#pl-settings input[name=memory_limit]').parentElement.textContent")
        if "switch it on and enter" not in help_text or "On a Mac" not in help_text:
            raise Failure(f"the settings do not say how to turn the hold on: {help_text}")
        b.click("#pl-settings input[name=memory_on]")
        b.wait("!document.querySelector('#pl-settings input[name=memory_limit]').disabled", "the limit enabled")
        if not b.js("document.querySelector('#pl-settings input[name=memory_limit]').validity.valueMissing"):
            raise Failure("the hold can be switched on with no limit")
        self.set_field("#pl-settings input[name=memory_limit]", "85")
        self.set_field("#pl-settings input[name=token_limit]", "400000")
        b.click("#pl-note-add")
        self.set_field("#pl-settings .pl-note:last-child input[name=folder]", "demo-app")
        self.set_field("#pl-settings .pl-note:last-child input[name=note]", "Run bin/rspec")
        b.click("#pl-settings-save")
        b.wait("document.getElementById('toast').textContent.includes('Saved')", "the settings saved")
        with open(self.y.config) as f:
            config = f.read()
        for want in ("per_machine: 3", "minutes: 90", "memory_limit: 85", "token_limit: 400000", "demo-app: Run bin/rspec"):
            if want not in config:
                raise Failure(f"yardbell.yml does not hold {want!r}:\n{config}")
        b.click("#pl-settings-open")
        b.wait("document.querySelector('#pl-settings input[name=memory_on]')?.checked", "the hold switched on")
        if b.js("document.querySelector('#pl-settings input[name=memory_limit]').value") != "85":
            raise Failure("the saved memory limit is not shown again")
        b.click("#pl-settings input[name=memory_on]")
        b.wait("document.querySelector('#pl-settings input[name=memory_limit]').disabled", "the limit disabled while off")
        b.click("#pl-settings-save")
        b.wait("document.getElementById('pl-settings') === null", "the settings saved again")
        with open(self.y.config) as f:
            if "memory_limit: 0" not in f.read():
                raise Failure("turning the hold off did not write memory_limit: 0")

    # Last, so the change it saves to the review pipeline comes after the Pipelines tests.
    def test_dispatch_save_pipeline_card(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={PIPE_CHAT}"))
        card = "#dispatch-log .step-card.pending"
        b.wait(f"document.querySelector('{card} .pl-canvas .pl-node[data-step=\"test\"]')", "the proposed pipeline drawn on the card")
        seen = b.js(f"""(() => {{
          const c = document.querySelector('{card}');
          return {{ title: c.querySelector('.step-card-title strong').textContent,
                   lines: c.querySelector('.pipeline-lines')?.textContent.replace(/\\s+/g, ' ').trim(),
                   ins: c.querySelector('.change-diff ins')?.textContent,
                   waits: c.textContent.includes('A new or changed pipeline always waits for you.') }};
        }})()""")
        if seen != {"title": "Change the pipeline Review my merge requests", "lines": "On fail, Understand went to Report to me, now goes to Root cause",
                    "ins": "added and the linters ", "waits": True}:
            raise Failure(f"the card shows {seen}")
        self.check_errors("the pipeline card")
        b.click(f"{card} .step-card-actions .btn.primary")
        b.wait("document.querySelector('#dispatch-log .step-card.done .step-card-outcome')?.textContent.includes('Saved as version')", "the pipeline saved")
        href = b.js("document.querySelector('#dispatch-log .step-card.done .step-card-outcome a').getAttribute('href')")
        if href != "/pipeline?p=review&tab=build":
            raise Failure(f"Open pipeline goes to {href}")

    def test_dispatch_run_cards(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={RUNS_CHAT}"))
        b.wait("document.querySelectorAll('#dispatch-log .step-card.pending').length === 2", "both run cards")
        titles = b.js("[...document.querySelectorAll('#dispatch-log .step-card .step-card-title strong')].map((t) => t.textContent)")
        if titles != ["Run Review my merge requests", "Drop COM-1284 Login redirect"]:
            raise Failure(f"the cards are titled {titles}")
        reason = b.js("document.querySelector('[aria-label=\"Drop COM-1284 Login redirect\"] .run-waiting')?.textContent || ''")
        if "Test needs you" not in reason:
            raise Failure(f"the answer card shows {reason!r}")
        b.click("[aria-label=\"Run Review my merge requests\"] .step-card-actions .btn.danger")
        b.wait("document.querySelector('[aria-label=\"Run Review my merge requests\"].rejected')", "the run card rejected")
        b.click("[aria-label=\"Drop COM-1284 Login redirect\"] .step-card-actions .btn.primary")
        b.wait("document.querySelector('[aria-label=\"Drop COM-1284 Login redirect\"].failed .step-card-outcome')?.textContent.includes('has already ended')", "the drop refused, on the card")
        self.check_errors("the run cards")

    def step_status(self, chat, step):
        return self.b.js(f"(async () => (await (await fetch('/dispatch/conversations/{chat}')).json()).events.find((e) => e.id === '{step}').status)()")

    def test_builder_edits_a_proposal(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={PROPOSAL_CHAT}"))
        card = '[aria-label="New pipeline: Built in the builder"]'
        b.wait(f"document.querySelector('{card} .step-card-actions a')", "the proposal with Edit in the builder")
        b.js(f"[...document.querySelectorAll('{card} .step-card-actions a')].find((a) => a.textContent.trim() === 'Edit in the builder').click()")
        b.wait("document.querySelector('.pl-proposal')?.textContent.includes('Proposed by Dispatch. Saving approves it.')", "the builder holding the proposal")
        if b.js("document.querySelector('.pl-tabs')"):
            raise Failure("the builder shows its tabs for a proposal")
        b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")
        b.click('.pl-node[data-step="fix"]')
        b.wait("document.querySelector('#pl-inspector input[name=name]')", "the Fix step in the inspector")
        self.set_field("#pl-inspector input[name=name]", "Fix it")
        if b.js("document.getElementById('pl-save').textContent.trim()") != "Approve and save":
            raise Failure("Save does not say it approves")
        b.click("#pl-save")
        b.wait("new URLSearchParams(location.search).get('p') === 'built-in-the-builder'", "the saved pipeline opened")
        saved = b.js("(async () => (await (await fetch('/api/pipelines/built-in-the-builder')).json()))()")
        if [s["name"] for s in saved["steps"]] != ["Plan", "Ask me", "Fix it"] or saved["enabled"]:
            raise Failure(f"the library holds {saved}")
        if self.step_status(PROPOSAL_CHAT, "propstp1") != "edited":
            raise Failure("the proposal is not marked edited")
        self.check_errors("the builder with a proposal")

    def test_builder_proposal_with_problems_keeps_waiting(self):
        b = self.b
        b.goto(self.url(f"/pipeline?proposal={PROPOSAL_CHAT}.propstp2"))
        b.wait("document.querySelector('.pl-proposal')", "the builder holding the proposal")
        b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")
        b.click('.pl-node[data-step="fix"]')
        b.wait("document.querySelector('#pl-inspector input[name=max_runs]')", "the Fix step in the inspector")
        self.set_field("#pl-inspector input[name=max_runs]", "0")
        b.click("#pl-save")
        b.wait("(document.querySelector('#pl-inspector .pl-inspector-problems')?.textContent || '').includes('max_runs must be from 1 to 10')", "the problem in the builder")
        if self.step_status(PROPOSAL_CHAT, "propstp2") != "pending":
            raise Failure("a refused save decided the proposal")
        self.set_field("#pl-inspector input[name=max_runs]", "2")
        b.click("#pl-save")
        b.wait("new URLSearchParams(location.search).get('p') === 'broken-in-the-builder'", "the corrected pipeline saved")
        b.goto(self.url(f"/pipeline?proposal={PROPOSAL_CHAT}.propstp2"))
        b.wait("document.querySelector('.pl-proposal')?.textContent.includes('This proposal was already decided')", "a decided proposal said so")
        if b.js("document.getElementById('pl-save')") or b.js("document.querySelector('.pl-canvas.editable')"):
            raise Failure("a decided proposal can still be edited or saved")

    def test_builder_save_key_approves_a_proposal(self):
        b = self.b
        b.goto(self.url("/pipeline?proposal=browserreviewchg.propstp3"))
        b.wait("document.querySelector('.pl-proposal') && document.querySelector('.pl-canvas.editable')", "the change in the builder")
        self.set_field(".pl-title-name", "Review my merge requests, renamed")
        b.click(".pl-canvas")
        b.key("s", "Control")
        b.wait("new URLSearchParams(location.search).get('p') === 'review'", "the change approved and opened")
        if self.step_status("browserreviewchg", "propstp3") != "edited":
            raise Failure("Ctrl+S saved around the proposal instead of approving it")

    def test_builder_asks_dispatch(self):
        b = self.b
        name = b.js("(async () => (await (await fetch('/api/pipelines/review')).json()).name)()")
        b.goto(self.url("/pipeline?p=review&tab=build"))
        b.wait("document.getElementById('pl-ask')", "Ask Dispatch in the builder")
        b.click("#pl-ask")
        want = f'Change the pipeline "{name}" (review): '
        b.wait(f"location.pathname === '/dispatch' && document.querySelector('#dispatch-input')?.value === {json.dumps(want)}", "Dispatch with the request started")
        if "ask=" in b.js("location.search"):
            raise Failure("the ask parameter stayed in the address")

    def test_sidebar_has_proposals_on_every_page(self):
        b = self.b
        for path in PAGES + ["/pipeline", "/proposals"]:
            b.goto(self.url(path))
            b.wait("document.querySelector(':is(.side-link, .rail-link)[href=\"/proposals\"]')", f"Proposals in the menu on {path}")

    def test_proposals_only_shows_in_the_menu_when_something_waits(self):
        b = self.b
        link = """document.querySelector(':is(.side-link, .rail-link, .col-nav-link)[href="/proposals"]')"""
        shown = """[...document.querySelectorAll(':is(.side-link, .rail-link, .col-nav-link)[href="/proposals"]')].some((a) => a.getClientRects().length > 0)"""
        b.goto(self.url("/"))
        b.wait(f"{link}", "the menu")
        waiting = len([p for p in self.api("GET", "/api/proposals")["proposals"] if p["status"] == "pending"])
        for path in ("/", "/workspace", "/diagrams", "/dispatch", "/pipeline"):
            b.goto(self.url(path))
            if waiting:
                b.wait(shown, f"Proposals in the menu on {path} while {waiting} wait")
            else:
                b.pump(0.6)
                if b.js(shown):
                    raise Failure(f"Proposals shows on {path} with nothing waiting")
        b.goto(self.url("/proposals"))
        b.wait(shown, "Proposals in the menu on its own page")
        b.goto(self.url("/settings#mcp"))
        b.wait("""document.querySelector('#mcp a[href="/proposals"]')""", "a way to the page from Settings")
        self.check_errors("Proposals in the menu")

    def test_proposals_page_approves_and_rejects(self):
        b = self.b
        b.goto(self.url("/proposals"))
        b.wait("document.querySelectorAll('.step-card.pending').length === 3", "three waiting proposals")
        badge = "document.querySelector('#rail [data-count=proposals]')"
        b.wait(f"{badge}?.textContent === '3' && !{badge}.hidden", "the badge counting them")
        trail = b.js("document.querySelector('[aria-label=\"Change Settings: Phone notifications\"] .step-card-trail').textContent")
        if "Proposed by claude-code" not in trail:
            raise Failure(f"the card says {trail!r}")
        b.click('[aria-label="Change Settings: Phone notifications"] .step-card-actions .btn.primary')
        b.wait("document.querySelector('[aria-label=\"Change Settings: Phone notifications\"].done')", "the phone change approved")
        b.click('[aria-label="Save the task Inbox task"] .step-card-actions .btn.danger')
        b.wait("document.querySelector('[aria-label=\"Save the task Inbox task\"].rejected')", "the task rejected")
        b.wait(f"{badge}?.textContent === '1'", "the badge down to one")
        heads = b.js("[...document.querySelectorAll('.pr-head')].map((h) => h.textContent)")
        if heads != ["Waiting for you", "Decided"]:
            raise Failure(f"the page has the sections {heads}")
        if self.wait_minutes() != 15:
            raise Failure(f"yardbell.yml waits {self.wait_minutes()} minutes")
        self.check_errors("the Proposals page")

    def test_proposal_pipeline_edited_in_the_builder(self):
        b = self.b
        b.goto(self.url("/proposals"))
        card = '[aria-label="New pipeline: From the inbox"]'
        b.wait(f"document.querySelector('{card} .step-card-actions a')", "the pipeline proposal")
        b.js(f"[...document.querySelectorAll('{card} .step-card-actions a')].find((a) => a.textContent.trim() === 'Edit in the builder').click()")
        b.wait("document.querySelector('.pl-proposal')?.textContent.includes('Proposed by claude-code. Saving approves it.')", "the builder holding the proposal")
        b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")
        b.click('.pl-node[data-step="fix"]')
        b.wait("document.querySelector('#pl-inspector input[name=name]')", "the Fix step in the inspector")
        self.set_field("#pl-inspector input[name=name]", "Fix from the inbox")
        b.click("#pl-save")
        b.wait("new URLSearchParams(location.search).get('p') === 'from-the-inbox'", "the pipeline saved")
        status = b.js("(async () => (await (await fetch('/api/proposals/inbxpip1')).json()).status)()")
        if status != "edited":
            raise Failure(f"the proposal is {status}")
        saved = b.js("(async () => (await (await fetch('/api/pipelines/from-the-inbox')).json()))()")
        if saved["enabled"] or "Fix from the inbox" not in [s["name"] for s in saved["steps"]]:
            raise Failure(f"the library holds {saved}")
        b.goto(self.url("/proposals"))
        b.wait(f"document.querySelector('{card}') && !document.querySelector('{card}.pending')", "the proposal among the decided")

    def test_proposals_can_be_deleted_and_cleared(self):
        b = self.b
        b.goto(self.url("/proposals"))
        card = '[aria-label="Save the task Inbox task"]'
        b.wait(f"document.querySelector('{card}')", "the task proposal")
        b.click(f"{card} + .pr-delete")
        b.wait("document.querySelector('dialog.confirm[open]')", "the delete confirmation")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait(f"!document.querySelector('{card}')", "the proposal gone")
        if b.js("(async () => (await (await fetch('/api/proposals/inbxtsk1')).status))()") != 404:
            raise Failure("the deleted proposal is still kept")
        phone = '[aria-label="Change Settings: Phone notifications"]'
        if b.js(f"!!document.querySelector('{phone}.pending')"):
            b.click(f"{phone} .step-card-actions .btn.danger")
            b.wait(f"document.querySelector('{phone}.rejected')", "the phone change rejected")
        b.click("#pr-clear")
        b.wait("document.querySelector('dialog.confirm[open]')", "the clear confirmation")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("![...document.querySelectorAll('.pr-head')].some((h) => h.textContent === 'Decided')", "the decided proposals cleared")
        self.check_errors("deleting proposals")

    def test_settings_saves_a_teardown_command(self):
        b = self.b
        b.goto(self.url("/settings#worktree-setup"))
        b.wait("document.getElementById('setup-add')", "Worktree setup")
        b.click("#setup-add")
        b.wait("document.querySelector('.setup-row [data-key=teardown]')", "the teardown field")
        self.set_field(".setup-row:last-child [data-key=folder]", "demo-app")
        self.set_field(".setup-row:last-child [data-key=teardown]", "docker compose down")
        b.click("#setup-form button[type=submit]")
        b.wait("!document.getElementById('undo-bar').hidden", "the setup saved")
        with open(self.y.config) as f:
            config = f.read()
        if "teardown: docker compose down" not in config:
            raise Failure(f"yardbell.yml does not hold the teardown:\n{config}")

    def test_settings_saves_pipeline_notifications(self):
        b = self.b
        b.goto(self.url("/settings#phone"))
        b.wait("document.querySelector('#phone-form [name=pipeline_waiting]')?.checked === true", "the pipeline switches, on")
        b.click("#phone-form [name=pipeline_finished]")
        b.click("#phone-form [name=proposals]")
        b.click("#phone-form button[type=submit]")
        b.wait("!document.getElementById('undo-bar').hidden", "the switches saved")
        with open(self.y.config) as f:
            config = f.read()
        for want in ("pipeline_finished: false", "proposals: false"):
            if want not in config:
                raise Failure(f"yardbell.yml does not hold {want}:\n{config}")
        b.click("#phone-form [name=pipeline_finished]")
        b.click("#phone-form [name=proposals]")
        b.click("#phone-form button[type=submit]")

    # The page's own /api/runs is answered with terminals, since which runs have a live session
    # depends on what earlier tests did to the seeded runs.
    def with_terminals(self):
        self.b.js("""(() => {
          const real = window.fetch;
          window.fetch = async (url, init) => {
            const res = await real(url, init);
            if (String(url) !== '/api/runs') return res;
            const body = await res.json();
            for (const r of body.runs) {
              r.terminals = r.id === 'run-a'
                ? [{ step: 'root-cause', name: 'hp-term-a', machine: 'hp', label: 'Root cause', current: true }, { step: 'understand', name: 'hp-term-main', machine: 'hp', label: 'Understand', current: false }]
                : r.id === 'run-b' ? [{ step: 'test', name: 'hp-term-b', machine: 'hp', label: 'Test', current: true }] : [];
            }
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          };
        })()""")

    def test_run_page_terminal_follows_the_run(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-terminal')", "the terminal area")
        self.with_terminals()
        frame = "document.querySelector('.pl-terminal iframe')"
        b.wait("document.getElementById('pl-terminal-toggle')?.getAttribute('aria-expanded') === 'false'", "the terminal closed at first")
        if b.js(frame):
            raise Failure("a closed terminal still holds a live connection")
        tall = b.js("document.querySelector('.pl-run-main .pl-canvas').getBoundingClientRect().height")
        closed = b.js("document.querySelector('.pl-terminal').getBoundingClientRect().height")
        if closed > 60:
            raise Failure(f"the closed terminal takes {closed}px")
        b.click("#pl-terminal-toggle")
        b.wait(f"{frame}", "the terminal opening")
        if b.js("document.querySelector('.pl-run-main .pl-canvas').getBoundingClientRect().height") >= tall:
            raise Failure("opening the terminal left the canvas no smaller")
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        self.with_terminals()
        b.wait(f"{frame}", "the terminal staying open after a reload")
        b.wait(f"{frame}?.getAttribute('src') === '/term/hp/hp-term-a?embed=1'", "the current step's terminal")
        b.wait(f"{frame}.contentWindow.document.readyState === 'complete'", "the terminal loaded")
        b.js(f"{frame}.contentWindow.__kept = true")
        b.pump(6)
        if not b.js(f"{frame}.contentWindow.__kept === true"):
            raise Failure("a redraw reloaded the terminal")
        b.js("[...document.querySelectorAll('.pl-terminal-switch button')].find((x) => x.textContent.trim() === 'Understand').click()")
        b.wait(f"{frame}.getAttribute('src') === '/term/hp/hp-term-main?embed=1'", "the switch to the main session")
        b.click('.pl-run-item[data-id="run-b"]')
        b.wait(f"{frame}?.getAttribute('src') === '/term/hp/hp-term-b?embed=1'", "the terminal following the run")
        if b.js("document.querySelector('.pl-terminal-switch')"):
            raise Failure("one session needs no switch")
        b.wait("document.getElementById('pl-stop-session')", "Stop session")
        b.js("""window.__posted = []; const real = window.fetch; window.fetch = (u, o) => {
          if (String(u).includes('stop')) { window.__posted.push(String(u) + ' ' + (o && o.body)); return Promise.resolve(new Response('{"ok":true}', {headers: {'content-type': 'application/json'}})); }
          return real(u, o);
        }""")
        b.click("#pl-stop-session")
        b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('The step then waits for you')", "the question")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("window.__posted.length === 1", "the stop")
        said = b.js("window.__posted[0]")
        if "/api/runs/run-b/stop-session" not in said or "hp-term-b" not in said:
            raise Failure(f"the page posted {said}")

    def test_run_without_a_session_says_so(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-c"))
        b.wait("document.querySelector('.pl-terminal')?.textContent.includes('This run has no live session.')", "the note")
        if b.js("document.querySelector('.pl-terminal iframe')"):
            raise Failure("a terminal with no session")

    def add_connector(self):
        template = self.api("GET", "/api/settings/connectors")["starters"]["trello"]
        self.api("POST", "/api/settings/connectors", {**template, "was": ""})

    def remove_connector(self):
        self.api("DELETE", "/api/settings/connectors/trello")

    def test_builder_connector_trigger_shows_names(self):
        b = self.b
        self.add_connector()
        try:
            self.open_builder()
            b.js("""(() => {
              const real = window.fetch;
              window.fetch = (u, o) => {
                const url = String(u);
                const json = (v) => Promise.resolve(new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } }));
                if (url.includes('/options/boards')) return json([{ id: 'B1', name: 'Main board' }]);
                if (url.includes('/options/states')) return json([{ id: 'L1', name: 'Todo' }, { id: 'L2', name: 'Done' }]);
                return real(u, o);
              };
            })()""")
            b.js("document.querySelector('.pl-lib-item[data-kind=\"linear\"][data-group=\"Start when\"]').click()")
            b.wait("document.querySelector('#pl-inspector select[name=ticket-source]')", "where tickets come from")
            self.set_field("#pl-inspector select[name=ticket-source]", "trello")
            b.wait("document.querySelector('#pl-inspector select[name=param-board]')?.textContent.includes('Main board')", "the board by name")
            self.set_field("#pl-inspector select[name=param-board]", "B1")
            b.wait("[...document.querySelectorAll('#pl-inspector .pl-state-pick')].some((x) => x.textContent.includes('Todo'))", "the list by name")
            b.js("[...document.querySelectorAll('#pl-inspector .pl-state-pick')].find((x) => x.textContent.includes('Todo')).querySelector('input').click()")
            b.wait("[...document.querySelectorAll('#pl-inspector .pl-state-pick input')].find((x) => x.value === 'L1')?.checked", "the list ticked, stored by id")
            if b.js("document.querySelector('#pl-inspector select[name=param-board]').value") != "B1":
                raise Failure("the board is not stored by id")
            if "Trello" not in b.js("document.querySelector('.pl-canvas').textContent"):
                raise Failure("the Start when card does not name the tool")
        finally:
            self.remove_connector()
        self.check_errors("the connector trigger")

    def test_builder_linear_filter_and_preview(self):
        b = self.b
        self.api("POST", "/api/settings/secrets", {"name": "linear", "value": "lin_api_BROWSER"})
        try:
            self.open_builder()
            b.js("document.querySelector('.pl-lib-item[data-kind=\"linear\"][data-group=\"Start when\"]').click()")
            b.wait("document.querySelector('#pl-inspector input[name=filter-labels]')", "the Linear filter fields")
            self.set_field("#pl-inspector input[name=filter-labels]", "agent-ready, bug")
            b.wait("document.querySelector('.pl-canvas').textContent.includes('label agent-ready or bug')", "the Start when card to name the filter")
            b.click("#pl-preview-matches")
            b.wait("document.querySelector('.pl-preview-result')?.textContent.includes('1 ticket matches now')", "the preview's count")
            said = b.js("document.querySelector('.pl-trigger-preview').textContent")
            for words in ("Linear did the filtering", "COM-12", "only notes what already matches"):
                if words not in said:
                    raise Failure(f"the preview does not say {words!r}: {said}")
            labels = FakeLinear.filters[-1]["labels"]["some"]["or"]
            if [x["name"]["eqIgnoreCase"] for x in labels] != ["agent-ready", "bug"]:
                raise Failure(f"Linear was not asked for the labels: {labels}")
            self.set_field("#pl-inspector input[name=filter-labels]", "other")
            b.wait("!document.querySelector('.pl-preview-result')", "a changed filter to clear the old answer")
            self.set_field("#pl-inspector input[name=filter-labels]", "")
            b.click("#pl-preview-matches")
            b.wait("document.querySelector('.pl-preview-result')?.textContent.includes('No filter is set')", "the preview without a filter")
        finally:
            self.api("POST", "/api/settings/secrets/delete", {"name": "linear"})
        self.check_errors("the Linear filter")

    def test_builder_connector_filter(self):
        b = self.b
        self.add_connector()
        try:
            self.open_builder()
            b.js("""(() => {
              const real = window.fetch;
              window.fetch = (u, o) => {
                const url = String(u);
                const json = (v) => Promise.resolve(new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } }));
                if (url.includes('/options/boards')) return json([{ id: 'B1', name: 'Main board' }]);
                if (url.includes('/options/states')) return json([{ id: 'L1', name: 'Todo' }]);
                if (url.includes('/options/labels')) return url.includes('board=B1') ? json([{ id: 'X1', name: 'Bug' }, { id: 'X2', name: '' }]) : json([]);
                if (url.includes('/trigger-preview')) {
                  window.__preview = JSON.parse(o.body);
                  return json({ count: 0, read: 7, items: [], how: 'Trello cannot do all of this filtering, so Yardbell read 7 items and kept the matches.', note: null });
                }
                return real(u, o);
              };
            })()""")
            b.js("document.querySelector('.pl-lib-item[data-kind=\"linear\"][data-group=\"Start when\"]').click()")
            b.wait("document.querySelector('#pl-inspector select[name=ticket-source]')", "where tickets come from")
            self.set_field("#pl-inspector select[name=ticket-source]", "trello")
            b.wait("document.querySelector('#pl-preview-matches')?.disabled && document.querySelector('.pl-trigger-preview').textContent.includes('Pick the Board first')", "the preview to wait for the board")
            b.wait("document.querySelector('#pl-inspector select[name=param-board]')?.textContent.includes('Main board')", "the board by name")
            if b.js("document.querySelector('#pl-inspector select[name=param-label] option').textContent") != "Any":
                raise Failure("a filter should offer Any, not ask for a pick")
            self.set_field("#pl-inspector select[name=param-board]", "B1")
            b.wait("document.querySelector('#pl-inspector select[name=param-label]')?.textContent.includes('Bug')", "the board's labels")
            b.wait("[...document.querySelectorAll('#pl-inspector .pl-state-pick')].some((x) => x.textContent.includes('Todo'))", "the lists")
            b.js("document.querySelector('#pl-inspector .pl-state-pick input').click()")
            b.wait("document.querySelector('#pl-inspector .pl-state-pick input').checked", "the list ticked")
            self.set_field("#pl-inspector select[name=param-label]", "X1")
            b.wait("document.querySelector('#pl-inspector').textContent.includes('Yardbell reads its list and keeps the matches')", "who filters")
            if not b.js("document.querySelector('#pl-inspector .pl-state-pick input').checked"):
                raise Failure("picking a filter cleared the states")
            if "filtered by label" not in b.js("document.querySelector('.pl-canvas').textContent"):
                raise Failure("the Start when card does not mention the filter")
            b.click("#pl-preview-matches")
            b.wait("document.querySelector('.pl-preview-result')?.textContent.includes('Nothing matches now')", "the empty preview")
            sent = b.js("window.__preview.trigger.params")
            if sent != {"board": "B1", "label": "X1"}:
                raise Failure(f"the preview asked with {sent}")
            self.set_field("#pl-inspector select[name=param-board]", "")
            b.wait("!document.querySelector('#pl-inspector select[name=param-label]').value", "a new board to clear its label")
        finally:
            self.remove_connector()
        self.check_errors("the connector filter")

    def test_builder_tool_step(self):
        b = self.b
        self.api("POST", "/api/settings/mcp/servers", {"servers": [{"name": "tools", "url": "https://mcp.example.com/mcp"}]})
        try:
            self.open_builder()
            b.js("""window.__tools_real = window.fetch; window.fetch = (u, o) => String(u).includes('/mcp/servers/tools/tools')
              ? Promise.resolve(new Response(JSON.stringify({ tools: [
                  { name: 'readCard', description: 'Reads a card', read_only_hint: true, schema_hash: 'hash-read', input_schema: { type: 'object', required: ['card'], properties: { card: { type: 'string', description: 'The card id' }, deep: { type: 'object' } } } },
                  { name: 'moveCard', description: 'Moves a card', read_only_hint: false, schema_hash: 'hash-move', input_schema: { type: 'object', properties: { list: { type: 'string' } } } },
                ] }), { headers: { 'content-type': 'application/json' } }))
              : window.__tools_real(u, o)""")
            b.js("document.querySelector('.pl-lib-item[data-kind=\"call\"]').click()")
            b.wait("document.querySelector('.pl-node.kind-tool')", "the step")
            b.wait("document.querySelector('#pl-inspector select[name=tool]')", "the tool picker")
            b.wait("document.querySelector('#pl-inspector select[name=tool] option[value=moveCard]')", "the tools listed")
            self.set_field("#pl-inspector select[name=tool]", "moveCard")
            b.wait("document.querySelector('#pl-inspector input[name=\"arg-list\"]')", "a field from the schema")
            if b.js("document.querySelector('#pl-inspector input[name=only_reads]').checked"):
                raise Failure("a tool should default to changing things")
            b.wait("document.querySelector('.pl-node.kind-tool')?.textContent.includes('Changes')", "the card saying it changes")
            self.set_field("#pl-inspector select[name=tool]", "readCard")
            b.wait("document.querySelector('#pl-inspector input[name=\"arg-card\"]')", "the string field")
            if not b.js("document.querySelector('#pl-inspector textarea[name=\"arg-deep\"]')"):
                raise Failure("a nested argument should fall back to JSON")
            if not b.js("document.querySelector('#pl-inspector input[name=only_reads]').checked"):
                raise Failure("a read-only hint should pre-tick Only reads")
            self.check_errors("a Call MCP tool step")
        finally:
            b.js("if (window.__tools_real) window.fetch = window.__tools_real")
            self.api("POST", "/api/settings/mcp/servers", {"servers": []})

    def test_builder_call_step_shows_its_kind(self):
        b = self.b
        self.add_connector()
        try:
            self.open_builder()
            b.js("document.querySelector('.pl-lib-item[data-kind=\"call\"]').click()")
            b.wait("document.querySelector('.pl-node.kind-call')", "the step")
            b.wait("document.querySelector('#pl-inspector select[name=call]')", "the call picker")
            self.set_field("#pl-inspector select[name=call]", "move")
            b.wait("document.querySelector('.pl-node.kind-call')?.textContent.includes('Changes')", "the card saying it changes")
            b.wait("document.querySelector('#pl-inspector input[name=param-value]')", "the value the call needs")
            self.set_field("#pl-inspector select[name=call]", "read")
            b.wait("document.querySelector('.pl-node.kind-call')?.textContent.includes('Reads')", "the card saying it reads")
        finally:
            self.remove_connector()
        self.check_errors("a Call API step")

    def test_builder_command_step(self):
        b = self.b
        self.open_builder()
        b.js("document.querySelector('.pl-lib-item[data-kind=\"command\"]').click()")
        b.wait("document.querySelector('.pl-node.kind-command')", "the step")
        b.wait("document.querySelector('#pl-inspector textarea[name=command]')", "the command field")
        if not b.js("document.querySelector('#pl-inspector input[name=minutes]')?.min === '1'"):
            raise Failure("a command can be stopped after one minute")
        self.set_field("#pl-inspector textarea[name=command]", "make test")
        b.wait("document.querySelector('.pl-node.kind-command')?.textContent.includes('make test')", "the card showing the command")
        if b.js("!!document.querySelector('#pl-inspector .pl-approve-command')"):
            raise Failure("a command you typed should not ask to be approved")
        if not b.js("document.querySelector('.pl-node.kind-command').textContent.includes('Exit code decides')"):
            raise Failure("the card does not say what decides")
        self.check_errors("a Run a command step")
        made = self.api("POST", "/api/pipelines", {"definition": {**review_pipeline(), "id": "", "name": "Has a command", "enabled": False}})
        try:
            made["steps"].append({"id": "lint", "name": "Lint", "kind": "command", "command": "", "max_runs": 2,
                                  "next": {"pass": "end", "fail": "wait", "needs_you": "wait"}, "x": 700, "y": 300})
            next(s for s in made["steps"] if s["kind"] == "report")["next"]["pass"] = "lint"
            said = b.js(f"""fetch('/api/pipelines/{made["id"]}', {{ method: 'PUT', headers: {{ 'Content-Type': 'application/json' }}, body: {json.dumps(json.dumps(made))} }}).then((r) => r.json())""")
            if "Lint: the command is empty" not in said.get("problems", []):
                raise Failure(f"Save does not name an empty command: {said}")
            made["steps"][-1]["command"] = "npm test"
            self.api("PUT", f"/api/pipelines/{made['id']}", made)
            b.goto(self.url(f"/pipeline?p={made['id']}&tab=build"))
            b.wait("document.querySelector('.pl-node.kind-command')", "the saved step")
            if not b.js("document.querySelector('.pl-node.kind-command').textContent.includes('Not approved yet')"):
                raise Failure("the card does not say nobody approved it")
            b.js("document.querySelector('.pl-node.kind-command').dispatchEvent(new MouseEvent('click', { bubbles: true }))")
            b.wait("document.querySelector('#pl-inspector button[name=approve-command]')", "the approve button")
            b.js("document.querySelector('#pl-inspector button[name=approve-command]').click()")
            b.wait("document.querySelector('.pl-node.kind-command').textContent.includes('Exit code decides')", "the card once approved")
            self.check_errors("approving a command")
        finally:
            self.api("DELETE", f"/api/pipelines/{made['id']}")

    def test_command_step_continue_on_pass_button(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-detail')", "the run")
        b.js("""(() => {
          const real = window.fetch;
          window.__ran = null;
          window.__overridden = false;
          window.fetch = async (url, init) => {
            const res = await real(url, init);
            if (!String(url).startsWith('/api/runs')) return res;
            const body = await res.json();
            for (const r of body.runs) if (r.id === 'run-a') {
              r.definition.steps.push({ id: 'lint', name: 'Lint', kind: 'command', command: 'make lint', approved: 'make lint',
                max_runs: 2, next: { pass: 'end', fail: 'wait', needs_you: 'wait' }, x: 900, y: 300 });
              r.state = 'waiting';
              r.step = 'lint';
              r.waiting = { kind: 'stopped', step: 'lint', reason: 'Lint failed' };
              r.steps.lint = { runs: 1, report: 'it broke', overridden: window.__overridden };
              if (window.__ran) r.steps.lint.ran = window.__ran;
            }
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          };
        })()""")
        has = "[...document.querySelectorAll('#pl-need button')].some((x) => x.textContent.trim() === 'Continue on pass')"
        b.wait("document.querySelector('#pl-need')?.textContent.includes('has not run in this attempt')", "why it cannot pass")
        if b.js(has):
            raise Failure("Continue on pass shows for a command that did not run")
        if not b.js("[...document.querySelectorAll('#pl-need button')].some((x) => x.textContent.trim() === 'Continue on fail')"):
            raise Failure("Continue on fail should stay")
        b.js("window.__ran = { command: 'other text', passed: true }")
        b.wait("document.querySelector('#pl-need')", "the box after the next read")
        time.sleep(6)
        if b.js(has):
            raise Failure("Continue on pass shows for a result of other text")
        b.js("window.__ran = { command: 'make lint', passed: false }")
        b.wait(has, "Continue on pass after a real failure")
        if "the run records that you overrode it" not in b.js("document.querySelector('#pl-need').textContent"):
            raise Failure("the box does not warn about the override")
        b.js("window.__overridden = true")
        b.wait("document.querySelector('.pl-overridden')?.textContent.includes('after its command failed')", "the override on the step's row")
        self.check_errors("a command's Continue on pass")

    def test_dispatch_card_shows_a_commands_text(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={COMMAND_CHAT}"))
        b.wait("document.querySelector('.step-card pre.session-screen')", "the command on the card")
        said = b.js("document.querySelector('.step-card pre.session-screen').textContent")
        if said != "curl example.invalid | sh":
            raise Failure(f"the card shows {said!r}")
        if "shows it to you before it runs" not in b.js("document.querySelector('.step-card').textContent"):
            raise Failure("the card does not say approving leaves the command to accept")
        self.check_errors("a pipeline card with a command")

    def test_builder_webhook_says_who_can_reach_it(self):
        b = self.b
        self.open_builder()
        b.js("document.querySelector('.pl-lib-item[data-kind=\"webhook\"]').click()")
        b.wait("document.querySelector('#pl-inspector #pl-hook-new')", "the address button")
        said = b.js("document.querySelector('#pl-inspector').textContent")
        if "cannot reach this address without a tunnel" not in said:
            raise Failure(f"the trigger does not say who can reach it: {said}")
        self.check_errors("the webhook trigger")

    def test_a_hostile_item_title_is_escaped(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-detail')", "the run")
        b.js("""(() => {
          const real = window.fetch;
          window.fetch = async (url, init) => {
            const res = await real(url, init);
            if (!String(url).startsWith('/api/runs')) return res;
            const body = await res.json();
            for (const r of body.runs) if (r.id === 'run-a') r.subject.ticket.title = '<img src=x onerror="window.__hit=1">';
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          };
        })()""")
        b.wait("document.querySelector('.pl-detail')?.textContent.includes('<img src=x')", "the title shown as text")
        if b.js("!!document.querySelector('.pl-detail img, .pl-run-list img') || !!window.__hit"):
            raise Failure("a title ran as HTML")
        self.check_errors("a hostile title")

    def test_builder_review_switch(self):
        b = self.b
        self.open_builder()
        b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")
        b.click('.pl-node[data-step="test"]')
        b.wait("document.querySelector('#pl-inspector input[name=read_only]')", "the step in the inspector")
        said = b.js("document.querySelector('#pl-inspector input[name=read_only]').closest('label').textContent")
        if "Review: new read-only session" not in said:
            raise Failure(f"the switch says {said!r}")
        if "A new session" in b.js("document.querySelector('#pl-inspector').textContent"):
            raise Failure("the Session choice is still there")

    def test_github_and_gitlab_connect_their_own_way(self):
        b = self.b
        before = self.api("GET", "/api/settings")["pull_requests"]["value"]
        try:
            b.goto(self.url("/"))
            b.goto(self.url("/settings#connections"))
            b.wait("document.querySelector('#forge-rows [data-forge=github]')", "GitHub among the connections")
            if b.js("[...document.querySelectorAll('.settings-nav a')].some((a) => a.textContent === 'GitHub and GitLab')"):
                raise Failure("GitHub and GitLab still have their own menu item")
            if b.js("document.querySelector('#forge-rows [data-forge=github] .conn-type').textContent") != "gh":
                raise Failure("GitHub should default to gh")
            if b.js("document.querySelector('#forge-rows [data-forge=gitlab] .conn-type').textContent") != "Token":
                raise Failure("GitLab should default to a token")

            b.click("#forge-rows [data-forge=github]")
            b.wait("!document.getElementById('forge-github').hidden", "the GitHub step")
            if b.js("document.getElementById('conn-tabs').hidden") is not True:
                raise Failure("the tabs belong to New connection")
            if not b.js("document.getElementById('github-token-fields').hidden"):
                raise Failure("gh needs no token fields")
            b.js("document.querySelector('#forge-github [name=github_via][value=token]').click()")
            b.wait("!document.getElementById('github-token-fields').hidden", "the token fields")
            self.set_field("#forge-github [name=github_paste]", "ghp_BROWSER_VALUE")
            b.click("#forge-github button[type=submit]")
            b.wait("document.querySelector('#forge-rows [data-forge=github] .conn-type')?.textContent === 'Token' && !document.getElementById('conn-flow').open", "GitHub saved with a token")
            with open(self.y.config) as f:
                config = f.read()
            for want in ("github_via: token", "${secret:github_pr}"):
                if want not in config:
                    raise Failure(f"yardbell.yml does not hold {want}")
            if "ghp_BROWSER_VALUE" in config or "ghp_BROWSER_VALUE" in b.js("document.documentElement.outerHTML"):
                raise Failure("the token's value was kept where it can be seen")

            b.click("#forge-rows [data-forge=gitlab]")
            b.wait("!document.getElementById('forge-gitlab').hidden", "the GitLab step")
            b.js("document.querySelector('#forge-gitlab [name=gitlab_via][value=glab]').click()")
            b.click("#pr-add-host")
            b.wait("document.querySelector('#pr-hosts [data-key=host]')", "a host row")
            if b.js("document.querySelector('#pr-hosts [data-key=token]').offsetParent !== null"):
                raise Failure("glab needs no token box")
            self.set_field("#pr-hosts .row:last-child [data-key=host]", "git.example.com")
            b.click("#forge-gitlab button[type=submit]")
            b.wait("document.querySelector('#forge-rows [data-forge=gitlab] .conn-type')?.textContent === 'glab' && !document.getElementById('conn-flow').open", "GitLab saved with glab")
            with open(self.y.config) as f:
                config = f.read()
            if "gitlab_via: glab" not in config or "host: git.example.com" not in config:
                raise Failure(f"yardbell.yml does not hold the glab choice:\n{config}")
            self.check_errors("how GitHub and GitLab connect")
        finally:
            b.js("document.getElementById('conn-flow')?.close()")
            self.api("POST", "/api/settings/pull-requests", before)
            self.api("POST", "/api/settings/secrets/delete", {"name": "github_pr"})

    def test_settings_pull_requests_section(self):
        b = self.b
        self.api("POST", "/api/settings/secrets", {"name": "gitlab", "value": "glpat-browser-test"})
        b.goto(self.url("/"))
        b.goto(self.url("/settings#pull-requests"))
        b.wait("document.querySelector('#pr-form [name=enabled]')?.checked === true", "the Pull requests section")
        self.set_field("#pr-form [name=poll_seconds]", "300")
        b.click("#forge-rows [data-forge=gitlab]")
        b.wait("!document.getElementById('forge-gitlab').hidden", "the GitLab step")
        b.click("#pr-add-host")
        b.wait("document.querySelector('#pr-hosts [data-key=host]')", "a host row")
        self.set_field("#pr-hosts .row:last-child [data-key=host]", "git.example.com")
        self.set_field("#pr-hosts .row:last-child [data-key=token]", "${secret:gitlab}")
        b.click("#forge-gitlab button[type=submit]")
        b.wait("!document.getElementById('conn-flow').open && document.querySelector('#forge-rows [data-forge=gitlab]').textContent.includes('git.example.com')", "the section saved")
        with open(self.y.config) as f:
            config = f.read()
        for want in ("host: git.example.com", "poll_seconds: 300"):
            if want not in config:
                raise Failure(f"yardbell.yml does not hold {want}:\n{config}")
        if "glpat-browser-test" in config:
            raise Failure("the token's value reached yardbell.yml")
        self.check_errors("the Pull requests section")

    def stub_sign_in(self, reply):
        self.b.js("""window.__real = window.__real || window.fetch; window.__posted = []; window.fetch = (u, o) => {
          if (String(u).includes('/sign-in') || String(u).endsWith('/finish')) {
            window.__posted.push(String(u) + ' ' + (o && o.body));
            return Promise.resolve(new Response(JSON.stringify(%s), { headers: { 'content-type': 'application/json' } }));
          }
          return window.__real(u, o);
        }""" % json.dumps(reply))

    def add_mcp_server(self):
        self.api("POST", "/api/settings/mcp/servers", {"servers": [{"name": "tool", "url": "https://mcp.example.com/mcp"}]})
        self.b.goto(self.url("/"))
        self.b.goto(self.url("/settings#connections"))
        self.b.wait("document.querySelector('[data-mcp-act=sign-in]')", "the Sign in button")

    def row_action(self, row, action):
        self.b.click(f"{row} [data-row-menu]")
        self.b.wait(f"!document.querySelector('{row} .menu').hidden", "the row's menu")
        self.b.click(f"{row} {action}")

    def test_connection_rows_follow_one_shape(self):
        b = self.b
        self.add_mcp_server()
        try:
            head = b.js("[...document.querySelectorAll('#conn-all .conn-head span')].map((x) => x.textContent).filter(Boolean).join(' ')")
            if head != "Connection Type Status":
                raise Failure(f"the columns are {head!r}")
            row = "#server-rows .conn-row"
            drift = b.js(f"""Math.abs(document.querySelector('{row} .conn-status').getBoundingClientRect().left - document.querySelectorAll('#conn-all .conn-head span')[2].getBoundingClientRect().left)""")
            if drift > 1:
                raise Failure(f"the status sits {drift}px off its column")
            pad = b.js("(() => { document.getElementById('conn-new').click(); const v = getComputedStyle(document.querySelector('#conn-sign-in-list .conn-card')).paddingLeft; document.getElementById('conn-flow').close(); return v; })()")
            if pad == "0px":
                raise Failure("the picker rows have no padding")
            if "Not signed in" not in b.js(f"document.querySelector('{row} .conn-badge').textContent"):
                raise Failure("the status is not a badge")
            if b.js(f"document.querySelector('{row} [data-mcp-act=test]').offsetParent !== null"):
                raise Failure("Test should sit in the row's menu")
            b.click(f"{row} [data-row-menu]")
            b.wait(f"!document.querySelector('{row} .menu').hidden", "the menu")
            last = b.js(f"[...document.querySelectorAll('{row} .menu button')].pop().textContent")
            if last != "Remove" or not b.js(f"[...document.querySelectorAll('{row} .menu button')].pop().classList.contains('danger')"):
                raise Failure(f"the last item is {last}")
            b.js("document.body.click()")
            b.wait(f"document.querySelector('{row} .menu').hidden", "the menu to close")
            b.click(f"{row} .conn-name")
            b.wait("document.getElementById('conn-flow').open && !document.getElementById('server-form').hidden", "the row to open its edit form")
            if b.js("document.getElementById('conn-dialog-title').textContent") != "Edit tool":
                raise Failure("the row did not open its own edit")
            self.check_errors("connection rows")
        finally:
            self.remove_mcp_servers()

    def remove_mcp_servers(self):
        self.b.js("document.getElementById('conn-flow')?.close()")
        self.api("POST", "/api/settings/mcp/servers", {"servers": []})

    def test_server_sign_in_flow(self):
        b = self.b
        self.add_mcp_server()
        try:
            if "Not signed in" not in b.js("document.getElementById('server-rows').textContent"):
                raise Failure("the row does not say it is not signed in")
            b.viewport(390, 844)
            try:
                b.wait("window.innerWidth === 390", "the phone width")
                wide = b.js("""Math.max(...[...document.querySelectorAll('#server-rows button')].map((el) => el.getBoundingClientRect().right)) - window.innerWidth""")
                if wide > 0:
                    raise Failure(f"the server buttons run {wide}px past the phone screen")
            finally:
                b.viewport(1280, 900)
            self.stub_sign_in({"url": "https://auth.example.com/authorize?x=1", "sign_in_host": "auth.example.com", "redirect": "http://127.0.0.1:1/oauth/mcp/callback", "needs_client": False})
            b.click("[data-mcp-act=sign-in]")
            b.wait("document.getElementById('mcp-sign-in')?.textContent.includes('You will sign in at auth.example.com')", "the host, before leaving")
            link = b.js("document.querySelector('#mcp-sign-in a[data-continue]').getAttribute('href')")
            if link != "https://auth.example.com/authorize?x=1":
                raise Failure(f"Continue goes to {link}")
            self.check_errors("signing in")
        finally:
            self.remove_mcp_servers()

    def test_sign_in_says_it_is_working(self):
        b = self.b
        self.add_mcp_server()
        try:
            self.stub_sign_in({"url": "https://auth.example.com/a", "sign_in_host": "auth.example.com", "redirect": "http://127.0.0.1:1/oauth/mcp/callback", "needs_client": False})
            b.js("""window.__held = new Promise((go) => { window.__release = go; });
              const stubbed = window.fetch;
              window.fetch = (u, o) => String(u).includes('/sign-in') ? window.__held.then(() => stubbed(u, o)) : stubbed(u, o)""")
            b.click("[data-mcp-act=sign-in]")
            b.wait("document.querySelector('#mcp-sign-in [role=status]')?.textContent.includes('Finding where')", "word that it is working")
            if not b.js("document.querySelector('[data-mcp-act=sign-in]').disabled"):
                raise Failure("Sign in can be clicked again while it is working")
            b.js("window.__release()")
            b.wait("document.getElementById('mcp-sign-in').textContent.includes('You will sign in at auth.example.com')", "the host")
            if b.js("document.querySelector('#mcp-sign-in [role=status]')"):
                raise Failure("the working message stayed")
            self.check_errors("waiting for a sign-in")
        finally:
            self.remove_mcp_servers()

    def test_sign_in_from_another_device(self):
        b = self.b
        self.add_mcp_server()
        try:
            self.stub_sign_in({"url": "https://auth.example.com/a", "sign_in_host": "auth.example.com", "redirect": "http://127.0.0.1:1/oauth/mcp/callback", "needs_client": False})
            b.js("window.signsInHere = () => false")
            b.click("[data-mcp-act=sign-in]")
            b.wait("document.querySelector('#mcp-sign-in [name=address]')", "the box to paste into")
            said = b.js("document.getElementById('mcp-sign-in').textContent")
            if "another device" not in said:
                raise Failure(f"it does not explain: {said}")
            self.set_field("#mcp-sign-in [name=address]", "http://127.0.0.1:1/oauth/mcp/callback?code=c&state=s")
            b.click("#mcp-sign-in [data-finish]")
            b.wait("window.__posted.some((p) => p.includes('/finish') && p.includes('code=c'))", "the address sent")
            self.check_errors("signing in from another device")
        finally:
            self.remove_mcp_servers()

    def test_sign_in_needs_a_client(self):
        b = self.b
        self.add_mcp_server()
        try:
            self.stub_sign_in({"needs_client": True, "sign_in_host": "app.asana.com", "redirect": "http://127.0.0.1:1/oauth/mcp/callback"})
            b.click("[data-mcp-act=sign-in]")
            b.wait("document.querySelector('#mcp-sign-in [name=client_id]')", "the client fields")
            if "http://127.0.0.1:1/oauth/mcp/callback" not in b.js("document.getElementById('mcp-sign-in').textContent"):
                raise Failure("the redirect address is not shown")
            self.check_errors("a server that needs a client")
        finally:
            self.remove_mcp_servers()

    def test_the_connection_dialog_is_sized_by_its_content(self):
        # WebKit, the desktop app's engine, collapses a flex body with no starting height in a
        # dialog with no height of its own, and Firefox, which runs these tests, does not.
        b = self.b
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new')", "New connection")
        b.click("#conn-new")
        b.wait("document.querySelector('#conn-sign-in-list .conn-card')", "the tools")
        basis = b.js("getComputedStyle(document.querySelector('.conn-dialog-body')).flexBasis")
        b.js("document.getElementById('conn-flow').close()")
        if basis != "auto":
            raise Failure(f"the dialog body starts from {basis}, which collapses in WebKit")

    def test_connection_templates_are_a_grid(self):
        b = self.b
        lists = {"conn-new-panel": "conn-sign-in-list", "conn-tab-token": "conn-new-list"}
        measure = """((list) => {
          const tiles = [...document.getElementById(list).children];
          const flow = document.getElementById('conn-flow').getBoundingClientRect();
          const body = document.querySelector('.conn-dialog-body');
          return {
            tiles: tiles.length,
            columns: new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().left))).size,
            logos: tiles.filter((t) => t.querySelector('.conn-logo')?.textContent.trim() || t.querySelector('svg')).length,
            clipped: tiles.flatMap((t) => [...t.querySelectorAll('strong, small, button')]).filter((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).display !== 'inline').map((x) => x.textContent),
            past: Math.max(...tiles.map((t) => t.getBoundingClientRect().right)) - flow.right,
            sideways: body.scrollWidth - body.clientWidth,
            page: document.documentElement.scrollWidth - innerWidth,
            flowBottom: flow.bottom,
            height: innerHeight,
          };
        })"""

        def sizes(tab, list_id):
            b.click(f"#conn-tabs [data-tab={tab}]")
            b.wait(f"!document.getElementById('{tab}').hidden", f"the {tab} tab")
            return b.js(f"{measure}('{list_id}')")

        def check(seen, list_id, want):
            if seen["tiles"] != want:
                raise Failure(f"{list_id} has {seen['tiles']} tiles for {want} templates")
            if seen["logos"] != want:
                raise Failure(f"only {seen['logos']} of {want} tiles in {list_id} have an icon")
            if seen["clipped"]:
                raise Failure(f"clipped text in {list_id}: {seen['clipped']}")
            if seen["sideways"] > 0 or seen["page"] > 0 or seen["past"] > 0:
                raise Failure(f"{list_id} runs sideways: {seen}")
            if seen["flowBottom"] > seen["height"]:
                raise Failure(f"the modal runs past the window: {seen}")

        def open_modal():
            b.goto(self.url("/"))
            b.goto(self.url("/settings#connections"))
            b.wait("document.getElementById('conn-new') && connections.templates", "the section")
            b.click("#conn-new")
            b.wait("document.getElementById('conn-flow').open", "the modal")
            return {
                "conn-sign-in-list": b.js("connections.sign_in.length"),
                "conn-new-list": b.js("connections.templates.length") + 1,
            }

        try:
            b.viewport(1280, 800)
            want = open_modal()
            for tab, list_id in lists.items():
                seen = sizes(tab, list_id)
                check(seen, list_id, want[list_id])
                if seen["columns"] < 2:
                    raise Failure(f"{list_id} lays out in {seen['columns']} column at desktop width")

            b.viewport(390, 844, 3)
            want = open_modal()
            for tab, list_id in lists.items():
                check(sizes(tab, list_id), list_id, want[list_id])

            b.viewport(1280, 800)
            b.goto(self.url("/"))
            b.goto(self.url("/settings#connections"))
            b.wait("document.getElementById('conn-new') && connections.templates", "the section")
            b.js("""(() => {
              const tool = connections.sign_in.find((t) => t.id === 'jira');
              data.mcp_servers = [{ name: tool.id, url: tool.url }];
              data.mcp_auth = { [tool.id]: 'signed_in' };
              document.getElementById('conn-new').click();
            })()""")
            b.wait("document.querySelector('#conn-sign-in-list .conn-badge')", "the Connected badge")
            first = "document.querySelector('#conn-sign-in-list .conn-badge').closest('.conn-card')"
            if b.js(f"{first}.hasAttribute('data-sign-in') || !{first}.querySelector('svg')"):
                raise Failure("a connected tile should keep its icon and start no sign-in")
            b.js("document.getElementById('conn-flow').close()")
            self.check_errors("the template grid")
        finally:
            b.viewport(1280, 800)
            b.goto(self.url("/"))

    def test_sign_in_lists_common_tools_and_finds_one(self):
        b = self.b
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new') && connections.templates", "the section")
        b.js("document.getElementById('conn-new').click()")
        b.wait("document.querySelector('[data-sign-in=linear]')", "more tools than Trello and Jira")
        count = b.js("document.querySelectorAll('#conn-sign-in-list .conn-card').length")
        if count < 20:
            raise Failure(f"only {count} tools")
        width = b.js("document.getElementById('conn-flow').getBoundingClientRect().width")
        if width < 800:
            raise Failure(f"the modal is only {width}px wide")
        columns = b.js("getComputedStyle(document.getElementById('conn-sign-in-list')).gridTemplateColumns.split(' ').length")
        if columns != 3:
            raise Failure(f"{columns} columns")
        self.set_field("#conn-sign-in-search", "sent")
        b.wait("document.querySelector('[data-sign-in=sentry]') && !document.querySelector('[data-sign-in=sentry]').hidden && document.querySelector('[data-sign-in=linear]').hidden", "the search to narrow")
        self.set_field("#conn-sign-in-search", "nothing like this")
        b.wait("!document.getElementById('conn-sign-in-none').hidden", "word that nothing matched")
        b.js("document.getElementById('conn-flow').close()")
        self.check_errors("the sign-in list")

    def test_new_connection_is_one_step_at_a_time(self):
        b = self.b
        self.api("POST", "/api/settings/mcp/servers", {"servers": []})
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new') && connections.templates", "the section")
        reply = {"url": "https://auth.example.com/a", "sign_in_host": "auth.example.com", "redirect": "http://127.0.0.1:1/oauth/mcp/callback", "needs_client": False}
        self.stub_sign_in(reply)
        try:
            b.click("#conn-new")
            b.wait("document.getElementById('conn-flow').open", "the modal")
            tabs = b.js("[...document.querySelectorAll('#conn-tabs [data-tab]')].map((t) => t.textContent).join('|')")
            if tabs != "Sign in|MCP server|Token":
                raise Failure(f"the tabs are {tabs}")
            if b.js("document.querySelector('#conn-tabs [aria-selected=true]').textContent") != "Sign in":
                raise Failure("Sign in should be the first tab")

            b.click("#conn-tabs [data-tab=server-form]")
            b.wait("!document.getElementById('server-form').hidden", "the address step")
            if b.js("document.querySelector('#conn-tabs [aria-selected=true]').textContent") != "MCP server":
                raise Failure("the tab does not show where you are")
            if b.js("document.getElementById('conn-new-panel').hidden") is not True:
                raise Failure("the picker stayed under the form")
            if b.js("document.getElementById('server-more').open"):
                raise Failure("the extra options should be folded")
            self.set_field("#server-form [name=url]", "not an address")
            b.click("#server-form button[type=submit]")
            b.wait("document.getElementById('server-note').textContent.includes('https://')", "word about the address")
            self.set_field("#server-form [name=url]", "https://mcp.example.net/mcp")
            b.click("#server-form button[type=submit]")
            b.wait("document.getElementById('mcp-sign-in').textContent.includes('You will sign in at auth.example.com')", "the sign-in step")
            if not b.js("data.mcp_servers.some((s) => s.name === 'example')"):
                raise Failure(f"the name was not taken from the address: {b.js('JSON.stringify(data.mcp_servers)')}")

            b.js("""document.addEventListener('click', (e) => { if (e.target.closest('a[data-continue]')) e.preventDefault(); }, true);
              const stubbed = window.fetch;
              window.fetch = (u, o) => {
                const at = String(u);
                if (at.endsWith('/test')) return Promise.resolve(new Response(JSON.stringify({ version: '2025-11-25', tools: [{ name: 'readCard', description: 'Reads a card' }] }), { headers: { 'content-type': 'application/json' } }));
                if (at === '/api/settings' && window.__signed) return stubbed(u, o).then((r) => r.json()).then((d) => { d.mcp_auth = { example: 'signed_in' }; return new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } }); });
                return stubbed(u, o);
              }""")
            b.click("#mcp-sign-in a[data-continue]")
            b.wait("document.getElementById('mcp-sign-in').textContent.includes('Finish signing in')", "the waiting step")
            b.js("window.__signed = true")
            b.wait("!document.getElementById('mcp-tools').hidden && document.getElementById('mcp-tools').textContent.includes('readCard')", "the tools, with no Test to press")
            if "Connected to example" not in b.js("document.getElementById('conn-dialog-title').textContent"):
                raise Failure("it does not say it connected")
            b.click("[data-close-tools]")
            b.wait("!document.getElementById('conn-flow').open && document.querySelector('#server-rows [data-mcp-act=test]')", "back on the list")
            self.check_errors("adding by address")
        finally:
            self.remove_mcp_servers()

    def test_a_token_connection_takes_its_secret_in_the_form(self):
        b = self.b
        try:
            b.goto(self.url("/"))
            b.goto(self.url("/settings#connections"))
            b.wait("document.getElementById('conn-new') && connections.templates", "the section")
            b.click("#conn-new")
            b.click("#conn-tabs [data-tab=conn-tab-token]")
            b.click("#conn-new-list [data-starter=asana]")
            b.wait("!document.getElementById('conn-form').hidden && document.querySelector('#conn-secrets input[type=password]')", "a box for its secret")
            if b.js("document.getElementById('conn-more').open"):
                raise Failure("headers and calls should be folded for an example")
            name = b.js("document.querySelector('#conn-secrets input').dataset.secret")
            self.set_field("#conn-secrets input", "asana-value-BROWSER")
            b.click("#conn-form button[type=submit]")
            b.wait("document.querySelector('[data-conn=asana]')", "the saved connection")
            if "Save the secret" in b.js("document.querySelector('[data-conn=asana]').textContent"):
                raise Failure("the secret typed in the form was not saved")
            if "asana-value-BROWSER" in b.js("document.documentElement.outerHTML"):
                raise Failure("the secret stayed on the page")
            self.row_action("[data-conn=asana]", "[data-conn-act=delete]")
            b.wait("document.querySelector('dialog.confirm[open]')", "the question")
            b.click("dialog.confirm[open] [data-answer=yes]")
            b.wait("!document.querySelector('[data-conn=asana]')", "the connection gone")
            self.api("POST", "/api/settings/secrets/delete", {"name": name})
            self.check_errors("a token connection")

        finally:
            b.js("document.getElementById('conn-flow')?.close(); fetch('/api/settings/connectors/asana', { method: 'DELETE' })")
    def test_one_connections_page(self):
        b = self.b
        self.api("POST", "/api/settings/mcp/servers", {"servers": []})
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new') && connections.templates", "the section")
        nav = b.js("[...document.querySelectorAll('.settings-nav a')].map((a) => a.textContent).join('|')")
        if "MCP servers" in nav:
            raise Failure(f"the menu still splits them: {nav}")
        if not b.js("document.querySelector('#connections #server-rows') && document.querySelector('#connections #conn-rows') && document.querySelector('#connections #secret-rows')"):
            raise Failure("servers, connections and secrets are not all on the one page")
        guide = b.js("document.querySelector('#connections .conn-guide').textContent")
        for part in ("New connection", "Sign in", "Test"):
            if part not in guide:
                raise Failure(f"the guide does not mention {part}: {guide}")
        b.click("#conn-new")
        b.wait("document.querySelector('[data-sign-in=trello]')", "Trello under sign in")
        b.click("[data-another]")
        b.wait("!document.getElementById('server-form').hidden", "the server form")
        if b.js("document.getElementById('server-form').elements.kind.value") != "url":
            raise Failure("Another MCP server should ask for an address")
        b.click("#server-cancel")
        self.stub_sign_in({"url": "https://auth.example.com/a", "sign_in_host": "auth.example.com", "redirect": "http://127.0.0.1:1/oauth/mcp/callback", "needs_client": False})
        try:
            b.click("#conn-new")
            b.wait("document.querySelector('[data-sign-in=trello]')", "Trello under sign in")
            b.click("[data-sign-in=trello]")
            b.wait("document.getElementById('mcp-sign-in').textContent.includes('You will sign in at auth.example.com')", "the host, after picking Trello")
            if not b.js("data.mcp_servers.some((s) => s.name === 'trello' && s.url === 'https://mcp.trello.com/v1')"):
                raise Failure("picking Trello did not add it")
            self.check_errors("the one Connections page")
        finally:
            self.remove_mcp_servers()

    def test_tickets_come_from_any_connection(self):
        b = self.b
        self.api("POST", "/api/settings/connectors/connect", {"template": "trello"})
        try:
            made = self.api("POST", "/api/pipelines", {"template": "Implement my tickets"})
            pid = made.get("id") or made["definition"]["id"]
            b.js("localStorage.setItem('yb-pipeline-full', '1')")
            b.goto(self.url(f"/pipeline?p={pid}&tab=build"))
            b.wait("document.querySelector('.pl-node[data-step=\"plan\"]')", "the builder")
            b.click(".pl-node.pl-start")
            names = b.js("[...document.querySelectorAll('.pl-lib-item')].map((x) => x.textContent).join('|')")
            for gone in ("A connected tool", "Linear ticket", "Call API", "Call MCP tool"):
                if gone in names:
                    raise Failure(f"the library still has {gone}: {names}")
            for want in ("New ticket", "Update the ticket", "Use a connected tool"):
                if want not in names:
                    raise Failure(f"the library does not have {want}: {names}")
            b.wait("document.querySelector('#pl-inspector select[name=ticket-source]')", "where tickets come from")
            sources = b.js("[...document.querySelectorAll('#pl-inspector select[name=ticket-source] option')].map((o) => o.textContent).join('|')")
            if not sources.startswith("Linear|") or "Trello" not in sources:
                raise Failure(f"the sources are {sources}")
            self.set_field("#pl-inspector select[name=ticket-source]", "trello")
            b.wait("document.querySelector('.pl-canvas').textContent.includes('When Trello has a new item')", "the trigger on Trello")
            if b.js("document.querySelector('#pl-inspector select[name=ticket-source]').value") != "trello":
                raise Failure("the choice did not stay")
            self.set_field("#pl-inspector select[name=ticket-source]", "linear")
            b.wait("document.querySelector('.pl-canvas').textContent.includes('When a Linear ticket')", "the trigger back on Linear")
            b.js("document.querySelector('.pl-lib-item[data-kind=\"call\"]').click()")
            b.wait("document.querySelector('#pl-inspector select[name=connection]')", "the connection picker")
            options = b.js("[...document.querySelectorAll('#pl-inspector select[name=connection] option')].map((o) => o.value).join('|')")
            if "connector:trello" not in options or "server:trello" not in options:
                raise Failure(f"the connections are {options}")
            self.set_field("#pl-inspector select[name=connection]", "server:trello")
            b.wait("document.querySelector('.pl-node.kind-tool')", "the step as a tool")
            self.check_errors("tickets from any connection")
        finally:
            b.goto(self.url("/"))
            b.js("fetch('/api/settings/connectors/trello', { method: 'DELETE' })")
            self.remove_mcp_servers()

    def test_linear_is_a_connection(self):
        b = self.b
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.querySelector('#forge-rows [data-forge=linear]')", "Linear among the connections")
        b.click("#forge-rows [data-forge=linear]")
        b.wait("!document.getElementById('forge-linear').hidden", "the Linear step")
        self.set_field("#forge-linear [name=linear_key]", "lin_api_BROWSER_KEY")
        b.click("#forge-linear button[type=submit]")
        b.wait("!document.getElementById('conn-flow').open", "the key saved")
        b.wait("document.querySelector('#forge-rows [data-forge=linear]').textContent.includes('Saved')", "the row saying so")
        with open(self.y.config) as f:
            if "lin_api_BROWSER_KEY" in f.read():
                raise Failure("the key reached yardbell.yml")
        if "lin_api_BROWSER_KEY" in b.js("document.documentElement.outerHTML"):
            raise Failure("the key stayed on the page")
        self.check_errors("Linear as a connection")

    def test_linear_is_one_row_with_its_agent_server(self):
        b = self.b
        before = self.api("GET", "/api/settings")["mcp_servers"]
        servers = before + [
            {"name": "linear", "url": "https://mcp.linear.app/mcp", "machines": [MACHINE]},
            {"name": "notlinear", "url": "https://mcp.example.com/mcp"},
        ]
        self.api("POST", "/api/settings/mcp/servers", {"servers": servers})
        try:
            b.goto(self.url("/"))
            b.goto(self.url("/settings#connections"))
            b.wait("document.querySelector('#forge-rows [data-forge=linear]')?.textContent.includes('agents on')", "Linear saying agents use it")
            row = b.js("document.querySelector('#forge-rows [data-forge=linear]').textContent")
            if f"Pipelines, and agents on {MACHINE}" not in row:
                raise Failure(f"the Linear row reads {row}")
            names = b.js("[...document.querySelectorAll('#server-rows .conn-row strong')].map((x) => x.textContent)")
            if "linear" in names or "notlinear" not in names:
                raise Failure(f"the server rows are {names}")
            b.click("#forge-rows [data-forge=linear]")
            b.wait("!document.getElementById('forge-linear').hidden", "the Linear step")
            said = b.js("document.getElementById('linear-agents').innerText")
            if b.js("document.getElementById('linear-agents').hidden") or "mcp.linear.app" not in said or MACHINE not in said:
                raise Failure(f"the agent section reads {said!r}")
            b.click("#linear-agents [data-edit]")
            b.wait("!document.getElementById('server-form').hidden", "the server form")
            if b.js("document.getElementById('server-form').elements.name.value") != "linear":
                raise Failure("Edit opened the wrong server")
            b.js("document.getElementById('conn-flow').close()")
            b.wait("!document.getElementById('conn-flow').open", "the dialog to close")
            b.click("#forge-rows [data-forge=linear]")
            b.wait("!document.getElementById('forge-linear').hidden", "the Linear step")
            b.click("#linear-agents [data-remove]")
            b.wait("document.querySelector('dialog.confirm[open]')", "the remove confirmation")
            b.click("dialog.confirm[open] [data-answer=yes]")
            b.wait("document.querySelector('#forge-rows [data-forge=linear]').textContent.includes('Tickets for pipelines')", "Linear back to pipelines only")
            if not b.js("document.getElementById('linear-agents').hidden"):
                raise Failure("the agent section stayed after the server went")
            b.js("document.getElementById('conn-flow').close()")
            self.check_errors("Linear as one row")
        finally:
            self.api("POST", "/api/settings/mcp/servers", {"servers": before})
            b.goto(self.url("/"))

    # This machine's real folders can show up too, so a test only ever touches its own row.
    OWN_DIAGRAM = "[...document.querySelectorAll('.dg-list .row')].find((r) => r.textContent.includes('demo-app'))"

    def seed_diagram(self, body):
        folder = os.path.join(self.y.root, "demo-app", ".archify", "architecture-billing-20260101-000000")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "out.html"), "w") as f:
            f.write(body)
        return folder

    def test_a_diagram_cannot_reach_yardbell(self):
        b = self.b
        hostile = """<!doctype html><title>x</title><body>drawn<script>
          (async () => {
            const seen = {};
            try { seen.cookie = document.cookie; } catch (e) { seen.cookie = 'blocked'; }
            try { localStorage.setItem('x', '1'); seen.storage = 'open'; } catch (e) { seen.storage = 'blocked'; }
            try { const r = await fetch('/api/settings'); seen.api = String(r.status); } catch (e) { seen.api = 'blocked'; }
            try { const r = await fetch('https://example.com/'); seen.net = String(r.status); } catch (e) { seen.net = 'blocked'; }
            try { seen.parent = parent.document.title; } catch (e) { seen.parent = 'blocked'; }
            parent.postMessage({ diagram: seen }, '*');
          })();
        </script></body>"""
        folder = self.seed_diagram(hostile)
        try:
            found = [d for d in self.api("GET", "/api/diagrams")["diagrams"] if d["folder"] == "demo-app"]
            if len(found) != 1 or found[0]["file"] != "out.html":
                raise Failure(f"the list reads {found}")
            d = found[0]
            b.goto(self.url("/diagrams"))
            b.js("window.__seen = null; addEventListener('message', (e) => { if (e.data?.diagram) window.__seen = e.data.diagram; })")
            b.wait(self.OWN_DIAGRAM, "the diagram in the list")
            if b.js(f"{self.OWN_DIAGRAM}.querySelector('.dg-open').textContent").strip() != "architecture billing":
                raise Failure("the diagram's name reads wrong")
            b.js(f"{self.OWN_DIAGRAM}.querySelector('.dg-open').click()")
            b.wait("document.querySelector('iframe.dg-frame')", "the diagram's frame")
            if "allow-same-origin" in b.js("document.querySelector('iframe.dg-frame').getAttribute('sandbox')"):
                raise Failure("the frame shares Yardbell's origin")
            b.wait("window.__seen", "the diagram's script to report")
            seen = b.js("window.__seen")
            if seen["storage"] != "blocked" or seen["api"] != "blocked" or seen["net"] != "blocked" or seen["parent"] != "blocked" or seen["cookie"] not in ("", "blocked"):
                raise Failure(f"a diagram could reach out: {seen}")
            b.goto(self.url(f"/diagrams/view?machine={d['machine']}&folder={d['folder']}&dir={d['dir']}&file=out.html"))
            alone = b.js("(() => { try { return document.cookie; } catch (e) { return 'blocked'; } })()")
            if alone not in ("", "blocked"):
                raise Failure(f"opened at its own address, a diagram sees {alone!r}")
            b.goto(self.url("/"))
            blocked = [e for e in b.errors if "Content-Security-Policy" in e]
            if not blocked:
                raise Failure("the browser refused nothing, so the diagram's calls failed some other way")
            b.errors = [e for e in b.errors if e not in blocked]
            self.check_errors("a locked down diagram")
        finally:
            shutil.rmtree(os.path.dirname(folder), ignore_errors=True)

    def test_diagrams_page_shows_each_machine_and_draws(self):
        b = self.b
        folder = self.seed_diagram("<!doctype html><title>x</title>drawn")
        try:
            b.goto(self.url("/diagrams"))
            b.wait(self.OWN_DIAGRAM, "the diagram in the list")
            others = b.js("document.querySelectorAll('.dg-list .row').length") - 1
            state = self.api("GET", "/api/diagrams")["machines"][0]["state"]
            if state == "needs_node" and "Needs Node 18" not in b.js("document.querySelector('.dg-setup').innerText"):
                raise Failure("the page does not say Node is needed")
            if state != "installed" and not b.js("document.getElementById('draw-new').disabled"):
                raise Failure("Draw should wait for Archify")
            b.js("""(() => {
              const real = window.fetch;
              window.fetch = (u, o) => String(u).endsWith('/api/diagrams')
                ? real(u, o).then((r) => r.json()).then((d) => { d.machines.forEach((m) => { m.state = 'installed'; }); return new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } }); })
                : real(u, o);
              document.dispatchEvent(new Event('visibilitychange'));
            })()""")
            b.wait("!document.getElementById('draw-new').disabled", "Draw to be ready")
            b.click("#draw-new")
            b.wait("document.getElementById('draw-dialog')?.open", "the draw dialog")
            said = b.js("document.getElementById('draw-dialog').innerText")
            for want in ("uses that agent's tokens", "check it before sharing", "What to focus on"):
                if want not in said:
                    raise Failure(f"the dialog does not say {want!r}: {said}")
            if "demo-app" not in b.js("document.getElementById('draw-dialog').innerHTML"):
                raise Failure("the folder is not offered")
            b.js("[...document.querySelectorAll('#draw-dialog button')].find((x) => x.textContent === 'Cancel').click()")
            b.wait("!document.getElementById('draw-dialog')?.open", "the dialog to close")
            b.js(f"[...{self.OWN_DIAGRAM}.querySelectorAll('.btn')].find((x) => x.textContent === 'Delete').click()")
            b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('demo-app')", "the delete confirmation")
            b.click("dialog.confirm[open] [data-answer=yes]")
            b.wait(f"!{self.OWN_DIAGRAM}", "the diagram gone")
            if os.path.exists(folder):
                raise Failure("the diagram's folder is still there")
            left = b.js("document.querySelectorAll('.dg-list .row').length")
            if left != others:
                raise Failure(f"{others} other diagrams were listed and now {left} are")
            self.check_errors("the diagrams page")
        finally:
            shutil.rmtree(os.path.dirname(folder), ignore_errors=True)

    def test_a_diagram_can_start_a_pipeline_run(self):
        b = self.b
        folder = self.seed_diagram("<!doctype html><title>x</title>drawn")
        with open(os.path.join(folder, "candidate.json"), "w") as f:
            f.write('{"nodes":["billing <img src=x onerror=window.__bad=1>"]}')
        made = None
        try:
            b.goto(self.url("/diagrams"))
            b.wait(self.OWN_DIAGRAM, "the diagram in the list")
            # The run would go on to a real session, so only the request it sends is checked.
            b.js("""(() => {
              const real = window.fetch;
              window.__sent = [];
              window.fetch = (u, o) => {
                if (o?.method === 'POST' && String(u).endsWith('/runs')) {
                  window.__sent.push([String(u), o.body]);
                  return Promise.resolve(new Response(JSON.stringify({ runs: [] }), { headers: { 'content-type': 'application/json' } }));
                }
                return real(u, o);
              };
              window.addEventListener('beforeunload', (e) => e.preventDefault());
            })()""")
            b.js(f"[...{self.OWN_DIAGRAM}.querySelectorAll('.btn')].find((x) => x.textContent === 'Build from this').click()")
            b.wait("document.getElementById('build-dialog')?.open", "the build dialog")
            said = b.js("document.getElementById('build-dialog').innerText")
            for want in ("Implement from a diagram", "approve it before changing any code", "tokens"):
                if want not in said:
                    raise Failure(f"the dialog does not say {want!r}: {said}")
            b.js("[...document.querySelectorAll('#build-dialog button')].find((x) => x.textContent === 'Cancel').click()")
            b.wait("!document.getElementById('build-dialog')?.open", "the dialog to close")

            made = self.api("POST", "/api/pipelines", {"template": "Implement from a diagram"})["id"]
            b.goto(self.url(f"/pipeline?p={made}&tab=build"))
            b.wait("document.getElementById('pl-run-now')", "Run now")
            b.click("#pl-run-now")
            b.wait("document.querySelector('#pl-diagram option[value*=architecture-billing]')", "the diagram offered to Run now")
            if b.js("window.__bad"):
                raise Failure("text from the diagram was not escaped")
            self.check_errors("a diagram starting a run")
        finally:
            if made:
                self.api("DELETE", f"/api/pipelines/{made}")
            shutil.rmtree(os.path.dirname(folder), ignore_errors=True)

    def test_implement_from_a_diagram_template_waits_for_approval(self):
        made = self.api("POST", "/api/pipelines", {"template": "Implement from a diagram"})
        try:
            steps = {s["id"]: s for s in made["steps"]}
            if made["trigger"]["kind"] != "manual" or made["enabled"]:
                raise Failure(f"the template starts as {made['trigger']}, on: {made['enabled']}")
            if list(steps) != ["plan", "implement", "review", "fix", "push", "report"]:
                raise Failure(f"the steps are {list(steps)}")
            words = steps["implement"]["instructions"]
            for want in ("before you change any file", "say needs you", "{diagram}"):
                if want not in words:
                    raise Failure(f"Implement does not say {want!r}: {words}")
        finally:
            self.api("DELETE", f"/api/pipelines/{made['id']}")

    def test_draw_from_a_description(self):
        b = self.b
        b.goto(self.url("/diagrams"))
        b.wait("document.getElementById('draw-new')", "the page")
        b.js("""(() => {
          const real = window.fetch;
          window.__drawn = [];
          window.fetch = (u, o) => {
            if (String(u).endsWith('/api/diagrams/draw')) {
              window.__drawn.push(JSON.parse(o.body));
              return Promise.resolve(new Response(JSON.stringify({ error: 'stopped by the test' }), { status: 400, headers: { 'content-type': 'application/json' } }));
            }
            if (String(u).endsWith('/api/diagrams')) {
              return real(u, o).then((r) => r.json()).then((d) => { d.machines.forEach((m) => { m.state = 'installed'; }); return new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } }); });
            }
            return real(u, o);
          };
          document.dispatchEvent(new Event('visibilitychange'));
        })()""")
        b.wait("!document.getElementById('draw-new').disabled", "Draw to be ready")
        b.click("#draw-new")
        b.wait("document.getElementById('draw-dialog')?.open", "the draw dialog")
        b.click("#draw-dialog [data-kind=description]")
        b.wait("document.getElementById('draw-description')", "the description box")
        if not b.js("document.querySelector('#draw-dialog button[type=submit]').disabled"):
            raise Failure("Draw should wait for a description")
        self.set_field("#draw-description", "A shop with a cart")
        b.js("""(() => { const s = document.getElementById('draw-where'); s.value = '__new'; s.dispatchEvent(new Event('change', { bubbles: true })); })()""")
        b.wait("document.getElementById('draw-new-folder')", "the new folder box")
        if not b.js("document.querySelector('#draw-dialog button[type=submit]').disabled"):
            raise Failure("Draw should wait for a folder name")
        self.set_field("#draw-new-folder", "my-idea")
        b.wait("!document.querySelector('#draw-dialog button[type=submit]').disabled", "Draw to be ready")
        b.click("#draw-dialog button[type=submit]")
        b.wait("window.__drawn.length === 1", "the request")
        sent = b.js("window.__drawn[0]")
        if sent.get("description") != "A shop with a cart" or sent.get("new_folder") != "my-idea" or sent.get("folder"):
            raise Failure(f"the request was {sent}")
        b.wait("document.querySelector('#draw-dialog [role=alert]')?.textContent.includes('stopped by the test')", "the error kept in the dialog")
        b.js("document.getElementById('draw-dialog').close()")
        self.check_errors("drawing from a description")

    def test_settings_shows_archify_on_each_machine(self):
        b = self.b
        b.goto(self.url("/settings#diagrams"))
        b.wait("document.querySelector('#diagram-machines .dg-machine')", "the machine in the section")
        said = b.js("document.getElementById('diagram-machines').innerText")
        if MACHINE not in said or not any(w in said for w in ("Installed", "Not installed", "Needs Node")):
            raise Failure(f"the section reads {said}")
        self.check_errors("Archify in Settings")

    def test_connection_actions_are_fields(self):
        b = self.b
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new') && connections.templates", "the section")
        b.click("#conn-new")
        b.click("#conn-tabs [data-tab=conn-tab-token]")
        b.click("#conn-new-list [data-starter=trello]")
        b.wait("!document.getElementById('conn-form').hidden", "the form")
        b.js("document.getElementById('conn-more').open = true")
        b.wait("document.querySelector('#conn-more-tabs [data-more=conn-actions]')", "the tabs")
        tabs = b.js("[...document.querySelectorAll('#conn-more-tabs button')].map((t) => t.textContent).join('|')")
        if tabs != "Actions|Login headers|Choices|Settings":
            raise Failure(f"the tabs are {tabs}")
        if b.js("[...document.querySelectorAll('#conn-form textarea')].some((t) => t.value.includes('request:'))"):
            raise Failure("the form still shows YAML")
        said = b.js("document.getElementById('conn-actions').textContent")
        for want in ("Lists items", "Moves an item", "GET", "PUT", "Reads", "Changes"):
            if want not in said:
                raise Failure(f"the actions do not say {want!r}: {said}")
        b.js("document.querySelector('[data-call-name=list]').open = true")
        path = "[data-call-name=list] [data-field=path]"
        if "/boards/" not in b.js(f"document.querySelector('{path}').value"):
            raise Failure("the path is not in its own field")
        self.set_field(path, "/boards/{{board}}/cards/open")
        if not b.js("document.querySelector('[data-call-name=list] [data-pairs=map] [data-pair-key]')"):
            raise Failure("the reply fields are not in their own rows")
        b.click("#conn-action-add")
        b.wait("document.querySelector('[data-call-name=\"\"]')", "a new action")
        self.set_field("#conn-call-list [data-call]:last-child [data-field=name]", "archive")
        self.set_field("#conn-call-list [data-call]:last-child [data-field=path]", "/cards/{{item_id}}/archive")
        self.set_field("#conn-call-list [data-call]:last-child [data-field=method]", "POST")
        b.js("document.querySelector('[data-call-name=comment] [data-remove-call]').click()")
        b.click("#conn-more-tabs [data-more=conn-settings]")
        b.wait("document.querySelector('#conn-settings [name=id]').offsetParent !== null", "the settings tab")
        b.click("#conn-form button[type=submit]")
        b.wait("document.querySelector('[data-conn=trello]') && !document.getElementById('conn-flow').open", "the saved connection")
        saved = self.api("GET", "/api/settings/connectors")["list"]
        trello = next(c for c in saved if c["id"] == "trello")
        if trello["calls"]["list"]["request"]["path"] != "/boards/{{board}}/cards/open":
            raise Failure(f"the path was not saved: {trello['calls']['list']}")
        if trello["calls"]["list"]["map"].get("title") != "name":
            raise Failure("the reply fields were lost")
        if trello["calls"]["archive"]["request"]["method"] != "POST" or "comment" in trello["calls"]:
            raise Failure(f"the added and removed actions: {list(trello['calls'])}")
        if trello["params"][0]["name"] != "board":
            raise Failure("the choices were lost")
        if not next(p for p in trello["params"] if p["name"] == "label").get("filter"):
            raise Failure("saving the form lost a filter")
        self.row_action("[data-conn=trello]", "[data-conn-act=edit]")
        b.wait("!document.getElementById('conn-form').hidden", "the edit form")
        b.js("document.getElementById('conn-more').open = true")
        b.js("document.querySelector('[data-call-name=archive]').open = true")
        self.set_field("[data-call-name=archive] [data-field=body]", "{ not json")
        b.click("#conn-form button[type=submit]")
        b.wait("document.getElementById('conn-note').textContent.includes('archive')", "word about the bad body")
        b.js("document.getElementById('conn-flow').close()")
        self.row_action("[data-conn=trello]", "[data-conn-act=delete]")
        b.wait("document.querySelector('dialog.confirm[open]')", "the question")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("!document.querySelector('[data-conn=trello]')", "the connection gone")
        self.check_errors("actions as fields")

    def test_every_connection_input_looks_the_same(self):
        b = self.b
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new') && connections.templates", "the section")
        measure = """(() => {
          const out = new Set();
          for (const el of document.querySelectorAll('#conn-flow input:not([type=checkbox]):not([type=radio]), #conn-flow select')) {
            if (!el.offsetParent) continue;
            const c = getComputedStyle(el);
            out.add([c.height, c.borderTopColor, c.borderRadius, c.fontSize, c.backgroundColor, c.paddingLeft].join(' '));
          }
          return [...out];
        })()"""
        seen = set()
        b.click("#conn-new")
        b.wait("document.getElementById('conn-flow').open", "the modal")
        seen.update(b.js(measure))
        b.click("#conn-tabs [data-tab=server-form]")
        b.js("document.getElementById('server-more').open = true")
        seen.update(b.js(measure))
        b.click("#conn-tabs [data-tab=conn-tab-token]")
        b.click("#conn-new-list [data-starter=trello]")
        b.js("document.getElementById('conn-more').open = true")
        b.js("document.querySelector('[data-call-name=list]').open = true")
        seen.update(b.js(measure))
        b.click("#conn-more-tabs [data-more=conn-login]")
        seen.update(b.js(measure))
        b.click("#conn-more-tabs [data-more=conn-choices]")
        seen.update(b.js(measure))
        b.js("document.getElementById('conn-flow').close()")
        b.click("#secret-add")
        b.wait("document.getElementById('conn-flow').open && !document.getElementById('secret-form').hidden", "adding a secret in the modal")
        seen.update(b.js(measure))
        b.js("document.getElementById('conn-flow').close()")
        if len(seen) != 1:
            raise Failure(f"the inputs have {len(seen)} styles: {sorted(seen)}")

    def test_closing_the_modal_during_a_check_keeps_it_closed(self):
        b = self.b
        self.add_mcp_server()
        b.js("""window.__real = window.__real || window.fetch;
          window.__held = new Promise((go) => { window.__release = go; });
          window.fetch = (u, o) => String(u).endsWith('/test')
            ? window.__held.then(() => new Response(JSON.stringify({ version: '1', tools: [] }), { headers: { 'content-type': 'application/json' } }))
            : window.__real(u, o)""")
        try:
            b.js("void showConnected('tool')")
            b.wait("document.getElementById('conn-flow').open && document.getElementById('mcp-tools').textContent.includes('Checking')", "the check")
            b.click("#conn-close")
            b.wait("!document.getElementById('conn-flow').open", "the modal closed")
            b.js("window.__release()")
            b.pump(0.3)
            if b.js("document.getElementById('conn-flow').open"):
                raise Failure("the finished check opened the modal again")
            self.check_errors("closing during a check")
        finally:
            self.remove_mcp_servers()

    def test_a_signed_in_tool_shows_as_one_row(self):
        b = self.b
        self.api("POST", "/api/settings/connectors/connect", {"template": "trello"})
        try:
            b.goto(self.url("/"))
            b.goto(self.url("/settings#connections"))
            b.wait("document.querySelector('#server-rows .conn-row') && connections.templates", "the row")
            if b.js("document.querySelector('#conn-rows [data-conn=trello]')"):
                raise Failure("Trello shows twice")
            b.click("#server-rows .conn-row [data-row-menu]")
            b.wait("document.querySelector('#server-rows [data-conn-edit=trello]')?.offsetParent", "its actions in the menu")
            b.click("#server-rows [data-conn-edit=trello]")
            b.wait("!document.getElementById('conn-form').hidden", "the form")
            if b.js("document.querySelector('#conn-form [name=base_url]').offsetParent"):
                raise Failure("a server connection has no address to type")
            b.js("document.getElementById('conn-more').open = true")
            if "trelloReadCard" not in b.js("document.getElementById('conn-call-list').textContent"):
                raise Failure("the actions do not name their tool")
            b.js("document.getElementById('conn-flow').close()")
            data = self.api("GET", "/api/pipelines")
            if not any(c["id"] == "trello" for c in data["connectors"]):
                raise Failure("the pipeline builder does not offer Trello")
            b.click("#conn-new")
            b.click("#conn-tabs [data-tab=conn-tab-token]")
            b.click("#conn-new-list [data-starter=trello]")
            b.wait("!document.getElementById('conn-form').hidden", "the token form")
            b.click("#conn-form button[type=submit]")
            b.wait("document.querySelector('[data-conn=trello-token]') && !document.getElementById('conn-flow').open", "a token Trello beside the signed-in one")
            b.js("fetch('/api/settings/connectors/trello-token', { method: 'DELETE' })")
            self.check_errors("a signed-in tool")
        finally:
            b.js("document.getElementById('conn-flow')?.close(); fetch('/api/settings/connectors/trello', { method: 'DELETE' })")
            self.remove_mcp_servers()

    def test_loading_again_does_not_redraw_unchanged_rows(self):
        b = self.b
        self.add_mcp_server()
        try:
            b.wait("connections.templates", "the connections")
            b.js("window.__row = document.querySelector('#server-rows .conn-row'); window.__forge = document.querySelector('#forge-rows .conn-row')")
            b.js("void loadConnections()")
            b.pump(0.3)
            b.js("void refreshServerAuth()")
            b.pump(0.3)
            if not b.js("window.__row.isConnected && window.__forge.isConnected"):
                raise Failure("an unchanged row was redrawn, which can lose a click")
            b.click("#server-rows .conn-row [data-row-menu]")
            b.wait("!document.querySelector('#server-rows .menu').hidden", "the menu")
            b.js("setRows('server-rows', document.getElementById('server-rows').innerHTML + '<li id=late-row></li>')")
            if b.js("document.querySelector('#server-rows .menu').hidden"):
                raise Failure("a change closed the open menu")
            b.js("document.body.click()")
            b.wait("document.getElementById('late-row')", "the change, once the menu closed")
        finally:
            self.remove_mcp_servers()

    def test_a_pasted_token_never_replaces_a_secret(self):
        b = self.b
        self.api("POST", "/api/settings/secrets", {"name": "other_token", "value": "keep-me-BROWSER"})
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new') && connections.templates && data.secrets", "the section")
        made = b.js("keptAsSecret('other_token', 'new-value-BROWSER')")
        if made != "${secret:other_token-2}":
            raise Failure(f"it reused the name: {made}")
        secrets_file = os.path.join(os.path.dirname(self.y.config), "secrets.yml")
        with open(secrets_file) as f:
            stored = f.read()
        if "keep-me-BROWSER" not in stored:
            raise Failure("the earlier secret was replaced")
        for name in ("other_token", "other_token-2"):
            self.api("POST", "/api/settings/secrets/delete", {"name": name})

    def test_tokens_become_secrets_by_themselves(self):
        b = self.b
        before = self.api("GET", "/api/settings/pull-requests") if False else self.api("GET", "/api/settings")["pull_requests"]["value"]
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new') && connections.templates", "the section")
        b.js("""window.__real = window.__real || window.fetch; window.fetch = (u, o) => String(u).endsWith('/test')
          ? Promise.resolve(new Response(JSON.stringify({ version: '1', tools: [] }), { headers: { 'content-type': 'application/json' } }))
          : window.__real(u, o)""")
        try:
            b.click("#conn-new")
            b.click("#conn-tabs [data-tab=server-form]")
            self.set_field("#server-form [name=url]", "https://mcp.example.net/mcp")
            b.js("document.getElementById('server-more').open = true")
            self.set_field("#server-form [name=token]", "tok-BROWSER-ONE")
            self.set_field("#server-form [name=pairs]", "X-Api-Key=tok-BROWSER-TWO")
            b.click("#server-form button[type=submit]")
            b.wait("data.mcp_servers.some((s) => s.name === 'example')", "the server saved")
            b.js("document.getElementById('conn-flow').close()")
            b.pump(0.3)
            if b.js("document.getElementById('conn-flow').open"):
                raise Failure("closing the modal during a save did not hold")
            with open(self.y.config) as f:
                config = f.read()
            for value in ("tok-BROWSER-ONE", "tok-BROWSER-TWO"):
                if value in config:
                    raise Failure(f"{value} reached yardbell.yml")
            if "Bearer ${secret:example_token}" not in config or "${secret:example_x-api-key}" not in config:
                raise Failure(f"the headers do not name secrets:\n{config}")

            b.click("#conn-new")
            b.click("#conn-tabs [data-tab=conn-tab-token]")
            b.click("#conn-new-list [data-starter=asana]")
            b.wait("!document.getElementById('conn-form').hidden", "the form")
            b.js("""connHeaders = [{ name: 'Authorization', value: 'Bearer tok-BROWSER-THREE' }]; renderConnHeaders()""")
            b.click("#conn-form button[type=submit]")
            b.wait("document.querySelector('[data-conn=asana]') && !document.getElementById('conn-flow').open", "the connection saved")
            with open(self.y.config) as f:
                config = f.read()
            if "tok-BROWSER-THREE" in config or "Bearer ${secret:asana_authorization}" not in config:
                raise Failure(f"the login header was not kept as a secret:\n{config}")

            b.click("#forge-rows [data-forge=gitlab]")
            b.click("#pr-add-host")
            self.set_field("#pr-hosts .row:last-child [data-key=host]", "git-auto.example.com")
            self.set_field("#pr-hosts .row:last-child [data-key=paste]", "glpat-BROWSER-FOUR")
            b.click("#forge-gitlab button[type=submit]")
            b.wait("!document.getElementById('conn-flow').open", "GitLab saved")
            b.wait("document.querySelector('#forge-rows [data-forge=gitlab]').textContent.includes('git-auto.example.com')", "the host listed")
            with open(self.y.config) as f:
                config = f.read()
            if "glpat-BROWSER-FOUR" in config or "${secret:gitlab_git-auto_example_com}" not in config:
                raise Failure(f"the host's token was not kept as a secret:\n{config}")
            page = b.js("document.documentElement.outerHTML")
            for value in ("tok-BROWSER-ONE", "tok-BROWSER-TWO", "tok-BROWSER-THREE", "glpat-BROWSER-FOUR"):
                if value in page:
                    raise Failure(f"{value} is still on the page")
            b.wait("document.querySelector('[data-secret-row=asana_authorization]')?.textContent.includes('Asana')", "the secret saying what uses it")
            self.check_errors("tokens as secrets")
        finally:
            b.js("document.getElementById('conn-flow')?.close(); if (window.__real) { window.fetch = window.__real; delete window.__real; }")
            self.api("POST", "/api/settings/mcp/servers", {"servers": []})
            self.api("POST", "/api/settings/pull-requests", before)
            b.js("fetch('/api/settings/connectors/asana', { method: 'DELETE' })")
            for name in ("example_token", "example_x-api-key", "asana_authorization", "gitlab_git-auto_example_com"):
                try:
                    self.api("POST", "/api/settings/secrets/delete", {"name": name})
                except Exception:
                    pass

    def test_folders_load_on_the_connections_page(self):
        b = self.b
        b.goto(self.url("/"))
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('pr-folders') && !document.getElementById('pr-folders').textContent.includes('Checking your folders')", "the folders to load")
        head = b.js("[...document.querySelectorAll('#pull-requests .conn-head span')].map((x) => x.textContent).filter(Boolean).join(' ')")
        if head != "Folder Service Status":
            raise Failure(f"the folders' columns are {head!r}")
        if not b.js("document.getElementById('pr-save').hidden"):
            raise Failure("Save should wait for a change")
        self.set_field("#pr-form [name=poll_seconds]", "180")
        b.wait("!document.getElementById('pr-save').hidden", "Save after a change")

    def test_connections_section(self):
        b = self.b
        b.goto(self.url("/settings#connections"))
        b.wait("document.getElementById('conn-new')", "the section")
        if b.js("document.getElementById('conn-trello')"):
            raise Failure("the page still has a button for one tool")
        b.click("#conn-new")
        b.click("#conn-tabs [data-tab=conn-tab-token]")
        b.wait("document.querySelector('#conn-new-list [data-starter=trello]')", "the examples")
        said = b.js("document.getElementById('conn-new-list').textContent")
        for want in ("Start blank", "Trello", "GitHub Issues", "GitLab Issues", "Jira", "Asana"):
            if want not in said:
                raise Failure(f"the list does not offer {want!r}: {said}")
        b.click("#conn-new-list [data-starter=jira]")
        b.wait("document.querySelector('#conn-form [name=base_url]')?.value.includes('atlassian.net')", "the Jira example")
        b.click("#conn-cancel")
        b.click("#conn-new")
        b.click("#conn-tabs [data-tab=conn-tab-token]")
        b.click("#conn-new-list [data-starter='']")
        b.wait("document.querySelector('#conn-form [name=base_url]')?.value === ''", "a blank form")
        b.click("#conn-cancel")
        b.click("#conn-new")
        b.click("#conn-tabs [data-tab=conn-tab-token]")
        b.click("#conn-new-list [data-starter=trello]")
        b.wait("document.querySelector('#conn-form [name=base_url]')?.value === 'https://api.trello.com/1'", "the Trello template")
        b.js("document.getElementById('conn-more').open = true")
        if "secret:trello_token" not in b.js("document.querySelector('#conn-headers [data-key=value]').value"):
            raise Failure("the template's header is not a secret reference")
        b.click("#conn-form button[type=submit]")
        b.wait("document.querySelector('[data-conn=trello]')", "the saved connection")
        row = b.js("document.querySelector('[data-conn=trello]').textContent")
        for want in ("api.trello.com", "Save the secret", "trello_token"):
            if want not in row:
                raise Failure(f"the row does not say {want!r}: {row}")
        self.row_action("[data-conn=trello]", "[data-conn-act=share]")
        b.wait("document.getElementById('conn-share-text')", "the shared text")
        text = b.js("document.getElementById('conn-share-text').value")
        if "${secret:trello_token}" not in text:
            raise Failure(f"share lost its reference: {text}")
        b.click("[data-close-output]")
        b.click("#conn-new")
        b.click("#conn-tabs [data-tab=conn-tab-token]")
        b.click("#conn-import-open")
        self.set_field("#conn-import [name=text]", text.replace("id: trello", "id: copy"))
        b.click("#conn-import button[type=submit]")
        b.wait("document.querySelector('[data-conn=copy]')", "the imported connection")
        if "Switched off" not in b.js("document.querySelector('[data-conn=copy]').textContent") and "Save the secret" not in b.js("document.querySelector('[data-conn=copy]').textContent"):
            raise Failure("an import did not arrive switched off")
        if "api.trello.com" not in b.js("document.getElementById('conn-output').textContent"):
            raise Failure("the import does not name its host")
        b.click("[data-close-output]")
        for name in ("copy", "trello"):
            self.row_action(f"[data-conn={name}]", "[data-conn-act=delete]")
            b.wait("document.querySelector('dialog.confirm[open]')", "the question")
            b.click("dialog.confirm[open] [data-answer=yes]")
            b.wait(f"!document.querySelector('[data-conn={name}]')", "the connection gone")
        self.check_errors("the Connections section")

    def test_settings_explains_github_and_gitlab(self):
        b = self.b
        cfg_before = self.api("GET", "/api/settings")["pull_requests"]["value"]
        self.api("POST", "/api/settings/pull-requests", {**cfg_before, "gitlab": []})
        b.goto(self.url("/"))
        b.goto(self.url("/settings#pull-requests"))
        b.wait("document.querySelector('#pr-form [name=enabled]')?.checked === true", "the section")
        said = b.js("document.getElementById('connections').textContent")
        for want in ("GitHub", "gh auth login", "GitLab", "read_api", "No GitLab hosts yet"):
            if want not in said:
                raise Failure(f"the section does not say {want!r}:\n{said}")
        if "hp" not in b.js("document.getElementById('pr-github').textContent"):
            raise Failure("GitHub does not list the machines")
        b.click("#forge-rows [data-forge=gitlab]")
        b.wait("!document.getElementById('forge-gitlab').hidden", "the GitLab step")
        b.click("#pr-add-host")
        b.wait("document.querySelector('#pr-hosts [data-key=host]')", "a host row")
        for width in (1280, 390):
            b.viewport(width, 844)
            b.pump(0.2)
            at = b.js("""(() => {
              const row = document.querySelector('#pr-hosts .row').getBoundingClientRect();
              const x = document.querySelector('#pr-hosts [data-remove-host]').getBoundingClientRect();
              return { right: row.right - x.right, top: x.top - row.top };
            })()""")
            if not (0 <= at["right"] <= 12 and 0 <= at["top"] <= 12):
                raise Failure(f"the close icon is not in the top right at {width}px: {at}")
            if width == 390:
                lefts = b.js("[...document.querySelectorAll('#pr-hosts .row:first-child label')].map((x) => x.getBoundingClientRect().left)")
                if len(set(lefts)) != 1:
                    raise Failure(f"the host's fields are not stacked on a phone: {lefts}")
        b.viewport(1280, 800)
        row = b.js("document.querySelector('#pr-hosts .row').textContent")
        for want in ("Host", "Address", "Saved token", "Or paste a token", "Not checked yet"):
            if want not in row:
                raise Failure(f"the host row does not say {want!r}: {row}")
        if "No GitLab hosts yet" in b.js("document.getElementById('forge-gitlab').innerText"):
            raise Failure("the empty note stayed after adding a host")
        b.js("document.getElementById('conn-flow').close()")
        b.js("""window.__real = window.fetch; window.fetch = (u, o) => String(u).includes('/pull-requests/folders')
          ? Promise.resolve(new Response(JSON.stringify({ unreachable: [], folders: [
              { machine: 'hp', folder: 'web', host: 'github.com', project: 'acme/web', service: 'github' },
              { machine: 'hp', folder: 'app', host: 'gitlab.acme.org', project: 'acme/app', service: 'gitlab_unlisted' },
            ] }), { headers: { 'content-type': 'application/json' } }))
          : window.__real(u, o)""")
        b.click("#pr-folders-refresh")
        b.wait("document.querySelector('#pr-folders [data-add-host]')", "a folder on a GitLab host not listed")
        folders = b.js("document.getElementById('pr-folders').textContent")
        for want in ("web", "GitHub", "app", "GitLab", "Add gitlab.acme.org"):
            if want not in folders:
                raise Failure(f"the folders do not say {want!r}: {folders}")
        if "Not checked" in b.js("document.getElementById('pr-github').textContent") and b.js("document.querySelector('#pr-folders .pr-folder .pr-ok')"):
            raise Failure("a folder reads as working before anything was checked")
        hosts = b.js("document.querySelectorAll('#pr-hosts .row').length")
        b.click("#pr-folders [data-add-host]")
        b.wait(f"document.querySelectorAll('#pr-hosts .row').length === {hosts + 1}", "the host added")
        b.wait("!document.getElementById('forge-gitlab').hidden", "the GitLab step for the new host")
        if b.js("document.querySelector('#pr-hosts .row:last-child [data-key=host]').value") != "gitlab.acme.org":
            raise Failure("the added host is not the folder's")
        if b.js("document.querySelector('#pr-folders [data-add-host]')"):
            raise Failure("the folder still asks to add a host now listed")
        b.js("document.querySelector('#forge-github [name=use_github]').click()")
        b.wait("document.getElementById('pr-folders').textContent.includes('GitHub is switched off')", "GitHub off in the folder list")
        b.js("document.querySelector('#forge-github [name=use_github]').click()")
        b.js("document.getElementById('conn-flow').close()")
        b.js("window.fetch = window.__real")
        self.check_errors("the GitHub and GitLab section")

    def test_a_session_says_why_it_has_no_badge(self):
        b = self.b
        b.goto(self.url("/"))
        b.wait("document.querySelector('#rail .rail-link[href=\"/proposals\"]')", "the dashboard")
        b.js("""(() => {
          const real = window.fetch;
          window.fetch = async (url, init) => {
            const res = await real(url, init);
            if (!String(url).startsWith('/state')) return res;
            const body = await res.json();
            for (const s of body.sessions) { delete s.pull; s.pull_why = 'gh is not installed or not signed in on hp'; }
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'x-yardbell-build': res.headers.get('x-yardbell-build') || '' } });
          };
        })()""")
        self.y.tmux("new", "-d", "-s", "hp-why-test", "-c", os.path.join(self.y.root, "demo-app"), self.y.shell)
        try:
            b.wait("document.querySelector('.pr-why[href=\"/settings#pull-requests\"]')?.title.includes('gh is not installed')", "the reason on the session")
        finally:
            self.y.tmux("kill-session", "-t", "=hp-why-test")

    def test_phone_menu_is_a_bottom_tab_bar(self):
        b = self.b
        b.viewport(390, 844, 3)
        # The shell's #tabbar on a page it draws, the sidebar's foot elsewhere.
        probe = """(() => {
          const rect = (el) => el.getBoundingClientRect();
          const shell = document.getElementById('tabbar');
          const bar = shell || document.querySelector('.side-foot');
          const tabs = (shell ? [...bar.querySelectorAll('.tab')] : [...bar.querySelectorAll('.side-link:not(.theme-toggle):not(#logout):not(.desk-only)')])
            .filter((el) => el.getClientRects().length);
          const col = document.getElementById('col');
          const main = !shell ? document.querySelector('.main') : col?.getClientRects().length ? col : document.getElementById('main');
          return {
            bottom: Math.round(rect(bar).bottom), height: innerHeight, wide: Math.round(rect(bar).width), page: innerWidth,
            tabs: tabs.map((t) => (shell ? t.querySelector('.tab-label').textContent : t.textContent).trim().replace(/\\s*[0-9]+$/, '')),
            row: new Set(tabs.map((t) => Math.round(rect(t).top))).size,
            inside: tabs.every((t) => rect(t).left >= 0 && rect(t).right <= innerWidth),
            hit: tabs.every((t) => { const r = rect(t); return t.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }),
            mainEnd: Math.round(rect(main).bottom), barTop: Math.round(rect(bar).top),
            sideways: document.documentElement.scrollWidth > innerWidth,
            shell: Boolean(shell),
          };
        })()"""
        sidebar = ["Dashboard", "Workspace", "Pipelines", "Diagrams", "Dispatch", "Settings"]
        shell_tabs = ["Sessions", "Board", "Pipelines", "Dispatch", "More"]
        try:
            for path in ("/", "/pipeline", "/settings", "/dispatch", "/proposals", "/workspace"):
                b.goto(self.url(path))
                b.wait("document.querySelector('#tabbar .tab, .side-foot .side-link')", f"the menu on {path}")
                b.pump(0.4)
                seen = b.js(probe)
                problems = []
                if [t for t in seen["tabs"] if t != "Proposals"] != (shell_tabs if seen["shell"] else sidebar):
                    problems.append("tabs")
                if abs(seen["bottom"] - seen["height"]) > 1 or seen["wide"] != seen["page"]:
                    problems.append("not along the bottom")
                if seen["row"] != 1 or not seen["inside"] or not seen["hit"]:
                    problems.append("tabs not in one tappable row")
                if seen["sideways"]:
                    problems.append("sideways scroll")
                if seen["mainEnd"] > seen["barTop"] + 1:
                    problems.append("the page runs under the bar")
                if problems:
                    raise Failure(f"{path}: {problems}: {seen}")
            b.click("#tab-more")
            b.wait("!document.getElementById('tab-menu').hidden", "the More menu")
            more = b.js("""[...document.querySelectorAll('#tab-menu [role=menuitem]')].filter((el) => el.getClientRects().length)
              .map((el) => el.matches('[data-theme-toggle]') ? 'theme' : el.querySelector('.menu-label').textContent)""")
            if more != ["Search", "Diagrams", "Proposals", "Settings", "Usage", "Keep computer awake", "Live ports", "theme", "Log out"]:
                raise Failure(f"More holds {more}")
            b.key("Escape")
            b.wait("document.getElementById('tab-menu').hidden", "the More menu to close")
            for path, bar in (("/dispatch", "#tabbar"), ("/workspace", "#tabbar")):
                b.goto(self.url(path))
                b.wait(f"document.querySelector('{bar} [aria-current=page]')", f"the current tab on {path}")
                b.js("document.documentElement.classList.add('keyboard')")
                if b.js(f"document.querySelector('{bar}').getClientRects().length"):
                    raise Failure(f"the tab bar on {path} stays up over the keyboard")
        finally:
            b.viewport(1280, 800)

    def test_run_page_scrolls_on_a_phone(self):
        b = self.b
        try:
            # Short screens: with the terminal closed the page fits a tall phone.
            for width, height, ratio in ((390, 520, 3), (900, 500, 1)):
                b.viewport(width, height, ratio)
                b.goto(self.url("/pipeline?p=review&run=run-a"))
                b.wait("document.querySelector('.pl-detail')", "the run's details")
                moved = b.js("""(() => {
                  const body = document.querySelector('.pl-body');
                  body.scrollTop = 100000;
                  const d = document.querySelector('.pl-detail').getBoundingClientRect();
                  return { top: body.scrollTop, bottom: d.bottom, height: innerHeight };
                })()""")
                if moved["top"] <= 0 or moved["bottom"] > moved["height"] + 1:
                    raise Failure(f"the run page does not scroll to its end at {width}px: {moved}")
        finally:
            b.viewport(1280, 800)

    def test_pipeline_head_buttons_match(self):
        b = self.b
        try:
            for width, height, ratio in ((1280, 800, 1), (390, 844, 3)):
                b.viewport(width, height, ratio)
                b.goto(self.url("/pipeline"))
                b.wait("document.getElementById('pl-new')", "New pipeline")
                heights = b.js("[...document.querySelectorAll('.pl-head-actions .btn')].map((x) => x.getBoundingClientRect().height)")
                if len(set(heights)) != 1:
                    raise Failure(f"the head's buttons differ at {width}px: {heights}")
                if not b.js("document.querySelector('#pl-new .icon')"):
                    raise Failure("New pipeline has no plus, unlike New session")
        finally:
            b.viewport(1280, 800)

    def test_pipeline_list_scrolls_on_a_phone(self):
        b = self.b
        made = [self.api("POST", "/api/pipelines", {"empty": True})["id"] for _ in range(8)]
        b.viewport(390, 844, 3)
        try:
            b.goto(self.url("/pipeline"))
            b.wait("document.querySelectorAll('.pl-card[data-id]').length >= 8", "a long list")
            moved = b.js("""(() => {
              const main = document.getElementById('main');
              main.scrollTop = 100000;
              return main.scrollTop;
            })()""")
            if moved <= 0:
                raise Failure("the list of pipelines does not scroll")
        finally:
            b.viewport(1280, 800)
            for id in made:
                self.api("DELETE", f"/api/pipelines/{id}")

    def test_delete_pipeline_uses_the_page_dialog(self):
        b = self.b
        made = self.api("POST", "/api/pipelines", {"empty": True})["id"]
        b.js("localStorage.setItem('yb-pipeline-full', '1')")
        b.goto(self.url(f"/pipeline?p={made}&tab=build"))
        b.wait("document.getElementById('pl-delete')", "Delete in the builder")
        b.js("window.confirm = () => false")
        b.click("#pl-delete")
        b.wait("document.querySelector('dialog.confirm[open]')", "the page's own dialog")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("!new URLSearchParams(location.search).get('p')", "back on the list")
        if b.js(f"(async () => (await fetch('/api/pipelines/{made}')).status)()") != 404:
            raise Failure("the pipeline was not deleted")

    def test_a_run_with_no_result_says_what_to_do(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-detail')", "the run")
        b.js("""(() => {
          const real = window.fetch;
          window.fetch = async (url, init) => {
            const res = await real(url, init);
            if (!String(url).startsWith('/api/runs')) return res;
            const body = await res.json();
            for (const r of body.runs) if (r.id === 'run-a') {
              r.state = 'waiting';
              r.waiting = { kind: 'no_result', step: 'root-cause', reason: 'Root cause ended without a result', screen: '❯' };
            }
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          };
        })()""")
        b.wait("document.querySelector('#pl-need')?.textContent.includes('Show the terminal')", "what to do next")
        self.check_errors("a run with no result")

    # The whole graph in view first, so a real click lands on the card and not beside the canvas.
    def pick_node(self, step):
        self.b.js("[...document.querySelectorAll('.pl-zoom button')].find((x) => x.textContent.trim() === 'Fit').click()")
        self.b.click(f'.pl-node[data-step="{step}"]')

    def write_transcript(self):
        path = os.path.join(self.y.root, "demo-app")
        folder = os.path.join(self.y.env["HOME"], ".claude", "projects", re.sub(r"[^a-zA-Z0-9]", "-", path))
        os.makedirs(folder, exist_ok=True)
        lines = [
            {"type": "user", "timestamp": "2026-01-05T10:00:05Z",
             "message": {"role": "user", "content": "Read COM-1276 and the merge request.\nstep: understand-1-run-f"}},
            {"type": "assistant", "timestamp": "2026-01-05T10:01:00Z", "message": {"content": [
                {"type": "thinking", "thinking": "not shown"},
                {"type": "text", "text": "Reading the **export** code."},
                {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "bin/rspec spec/export_spec.rb"}}]}},
            {"type": "user", "timestamp": "2026-01-05T10:02:00Z", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "tu1", "is_error": True, "content": "1 example, 1 failure"}]}},
            {"type": "assistant", "timestamp": "2026-01-05T10:12:00Z", "message": {"content": [
                {"type": "text", "text": "The export times out after 30 seconds."}]}},
        ]
        with open(os.path.join(folder, "t1.jsonl"), "w") as f:
            f.write("".join(json.dumps(line, separators=(",", ":")) + "\n" for line in lines))

    def test_a_finished_runs_steps_show_their_result_and_transcript(self):
        b = self.b
        self.write_transcript()
        b.goto(self.url("/pipeline?p=review&run=run-f"))
        b.wait("document.getElementById('pl-run-history')", "the run's history")
        rounds = b.js("[...document.querySelectorAll('#pl-run-history li')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim())")
        tests = [r for r in rounds if "Test" in r]
        if len(tests) != 2 or "failed" not in tests[0] or "passed" not in tests[1]:
            raise Failure(f"the history does not show the failed test round and the one after: {rounds}")
        if "the batch fix is ready to merge" not in b.js("document.querySelector('.pl-detail').textContent"):
            raise Failure("the run's final report is missing")
        self.pick_node("understand")
        b.wait("document.getElementById('pl-step')", "the step's result")
        if not b.js("document.querySelector('.pl-node[data-step=\"understand\"]').classList.contains('selected')"):
            raise Failure("the picked step is not marked on the graph")
        panel = b.js("document.getElementById('pl-step').innerText.replace(/\\s+/g, ' ')")
        for want in ("Outcome passed", "Took 13 min", "Ran Once", f"Machine {MACHINE}", "demo-app", "hp-com-1276-run-f",
                     "The export times out after 30 seconds.", "Repro: export 50k rows", "Use the staging data"):
            if want not in panel:
                raise Failure(f"the step's result does not say {want!r}: {panel}")
        b.wait("document.querySelector('#pl-transcript')?.textContent.includes('1 example, 1 failure')", "the transcript")
        said = b.js("document.getElementById('pl-transcript').textContent")
        for want in ("Sent by Yardbell", "Read COM-1276", "bin/rspec spec/export_spec.rb", "Read only, from t1.jsonl"):
            if want not in said:
                raise Failure(f"the transcript does not show {want!r}: {said}")
        if "not shown" in said:
            raise Failure("the agent's thinking is shown")
        if b.js("document.querySelector('#pl-transcript .msg.md strong')?.textContent") != "export":
            raise Failure("the agent's reply is not read as Markdown")
        if not b.js("document.querySelector('#pl-transcript .tool.bad')"):
            raise Failure("the failed tool call is not marked")
        if b.js("document.querySelector('.pl-terminal iframe')"):
            raise Failure("a step with no session left shows a terminal")
        self.pick_node("test")
        b.wait("document.getElementById('pl-step')?.textContent.includes('2 times')", "the step that ran twice")
        if b.js("document.querySelectorAll('#pl-step-history li').length") != 2 or not b.js("document.querySelector('#pl-step-history li.failed')"):
            raise Failure("the step's own rounds are not listed with the failed one")
        b.wait("document.getElementById('pl-no-transcript')?.textContent.includes('Test ran on shell. Yardbell can only read Claude Code transcripts.')", "why it has no transcript")
        self.pick_node("report")
        b.wait("document.getElementById('pl-no-transcript')?.textContent.includes('ran in Dispatch')", "the Dispatch step's note")
        b.click("#pl-step-back")
        b.wait("!document.getElementById('pl-step') && document.getElementById('pl-run-history')", "back on the run")
        if new_step := b.js("new URLSearchParams(location.search).get('step')"):
            raise Failure(f"the address still names {new_step}")
        b.click('.pl-st-open[data-step="understand"]')
        b.wait("document.getElementById('pl-step')?.textContent.includes('Repro')", "the step opened from the list")
        b.goto(self.url("/pipeline?p=review&run=run-f&step=understand"))
        b.wait("document.querySelector('#pl-transcript')", "the step kept after a reload")
        try:
            b.viewport(390, 844, 3)
            b.wait("document.getElementById('pl-step')", "the step on a phone")
            if b.js("document.documentElement.scrollWidth") > b.js("innerWidth"):
                raise Failure("the step's result scrolls sideways on a phone")
        finally:
            b.viewport(1280, 800)
        self.check_errors("a finished run's steps")

    def test_a_step_with_a_live_session_shows_its_terminal(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-terminal')", "the terminal area")
        b.js("""(() => {
          const real = window.fetch;
          window.fetch = async (url, init) => {
            const res = await real(url, init);
            if (String(url) !== '/api/runs') return res;
            const body = await res.json();
            for (const r of body.runs) if (r.id === 'run-a') {
              r.steps['root-cause'].session = 'hp-term-a';
              r.terminals = [{ step: 'root-cause', name: 'hp-term-a', machine: 'hp', label: 'Root cause', current: true }];
            }
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          };
        })()""")
        self.pick_node("root-cause")
        b.wait("document.querySelector('.pl-terminal iframe')?.getAttribute('src') === '/term/hp/hp-term-a?embed=1' && document.querySelector('.pl-live')",
               "the step's live terminal")
        self.pick_node("understand")
        b.wait("document.getElementById('pl-no-transcript')?.textContent.includes('can only read Claude Code transcripts')", "the other step's note")
        self.pick_node("understand")
        b.wait("!document.getElementById('pl-step')", "a second click closing the step")
        self.check_errors("a step with a live session")

    def test_a_run_in_progress_cannot_be_deleted(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-a"))
        b.wait("document.querySelector('.pl-detail')", "the run in progress")
        if b.js("document.getElementById('pl-delete-run')"):
            raise Failure("a run still waiting offers Delete")
        said = b.js("""(async () => { const r = await fetch('/api/runs/run-a', { method: 'DELETE' }); return [r.status, (await r.json()).error]; })()""")
        if said[0] != 409 or "Drop it first" not in said[1]:
            raise Failure(f"deleting a waiting run answered {said}")
        b.click("#pl-delete")
        b.wait("document.getElementById('toast').textContent.includes('still queued, running or waiting')", "why the pipeline cannot go")
        if b.js("document.querySelector('dialog.confirm[open]')"):
            raise Failure("the pipeline delete asks although it is refused")
        if b.js("(async () => (await fetch('/api/pipelines/review')).status)()") != 200:
            raise Failure("the pipeline was deleted with runs still going")
        self.check_errors("a run in progress")

    def test_delete_a_finished_run(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-c"))
        b.wait("document.getElementById('pl-delete-run')", "Delete this run on a finished run")
        b.click("#pl-delete-run")
        b.wait("document.querySelector('dialog.confirm[open]')?.textContent.includes('Branches, pushed commits')", "the question saying what stays")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("(async () => !(await (await fetch('/api/runs')).json()).runs.some((r) => r.id === 'run-c'))()", "the run gone")
        self.check_errors("deleting a run")

    # Last: it deletes every finished run the other tests use.
    def test_delete_finished_runs_keeps_the_ones_going(self):
        b = self.b
        b.goto(self.url("/pipeline?p=review&run=run-f"))
        b.wait("document.getElementById('pl-clear-runs')", "Delete finished runs")
        b.click("#pl-clear-runs")
        tree = os.path.join(self.y.root, "demo-app")
        b.wait(f"document.querySelector('dialog.confirm[open]')?.textContent.includes('This worktree stays on disk: {tree} on {MACHINE}')", "the question naming the worktree that stays")
        b.click("dialog.confirm[open] [data-answer=yes]")
        b.wait("(async () => { const runs = (await (await fetch('/api/runs')).json()).runs.filter((r) => r.pipeline === 'review'); return !runs.some((r) => ['done', 'dropped'].includes(r.state)) && runs.some((r) => r.id === 'run-a'); })()",
               "the finished runs gone and the others kept")
        b.wait("!document.getElementById('pl-clear-runs') && new URLSearchParams(location.search).get('run') !== 'run-f'", "the page following")
        self.check_errors("deleting finished runs")

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
