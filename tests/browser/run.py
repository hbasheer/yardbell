#!/usr/bin/env python3
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import zlib

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
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Nothing needs you right now."}]}}'
echo '{"type":"result","is_error":false,"result":"Nothing needs you right now."}'
"""


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
        # `claude`, out of reach: Dispatch looks Claude Code up through a login shell and must
        # find only the fake one.
        self.env = {
            "HOME": home,
            "PATH": f"{fake_bin}:{SYSTEM_PATH}",
            "SHELL": "/bin/bash",
            "LANG": "C.UTF-8",
            "USER": os.environ.get("USER", "runner"),
            "TMUX_TMPDIR": self.tmux_dir,
            "YARDBELL_STATE": self.state,
            "CLAUDE_CONFIG_DIR": os.path.join(home, ".claude"),
        }
        out = subprocess.run(["bash", "-lic", "command -v claude"], env=self.env, capture_output=True, text=True)
        found = [line for line in out.stdout.splitlines() if line.startswith("/")]
        if found != [self.fake_claude]:
            raise SystemExit(f"refusing to start: the test server would find claude at {found}, not only the fake one")
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
            "screen": "Done.", "options": [], "at": "2026-01-01T10:00:00+00:00",
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
        for chat in (short, long, review, pull, scan):
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

    def test_dispatch_shows_a_saved_conversation(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={SHORT_CHAT}"))
        b.wait("document.querySelector('#dispatch-log .msg.user')?.textContent.includes('Fix the login redirect')", "the saved user message")
        b.wait("document.querySelector('#dispatch-log .msg.md strong')?.textContent === 'hp-demo-app'", "the saved answer with its markdown")
        b.wait("document.getElementById('convo-list').textContent.includes('A long conversation')", "the conversation list")

    def test_dispatch_review_card_diff_and_evidence(self):
        b = self.b
        b.goto(self.url(f"/dispatch?c={REVIEW_CHAT}"))
        card = "#dispatch-log .step-card.review"
        b.wait(f"document.querySelector('{card}')?.textContent.includes('Review of')", "the seeded review card")
        b.wait(f"(() => {{ const i = document.querySelector('{card} .finding-shots img'); return i && i.complete && i.naturalWidth === 640; }})()", "the screenshot thumbnail")
        b.wait(f"document.querySelector('{card} .finding-shot-error')?.textContent.includes('gone.png was not attached')", "the screenshot that was not kept")
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
        b.wait(f"document.querySelector('{card} .step-card-foot .btn.primary')?.textContent.trim().startsWith(document.querySelector('{card} .scan-target') ? 'Send 3 to' : 'Fix 3 in a new session')", "the send button once the sessions are read")
        if self.session and b.js(f"[...document.querySelectorAll('{card} .scan-target option')].map((o) => o.value).join()") != f"{self.session},":
            raise Failure("the shell session in demo-app is not offered")
        b.js(f"(() => {{ const s = document.querySelector('{card} .scan-target select'); if (s) {{ s.value = ''; s.dispatchEvent(new Event('change')); }} }})()")
        b.wait(f"document.querySelector('{card} .step-card-foot .btn.primary')?.textContent.trim() === 'Fix 3 in a new session'", "the new session choice")
        b.click(f"{card} .step-card-foot .btn.primary")
        b.wait(f"document.querySelector('{card} .step-card-trail')?.textContent.startsWith('Asked for a new session to fix 3 findings')", "the card's outcome")
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
        b.click("#new-chat")
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
        for expected in ("#12", "Fix the login redirect", "CI / test", "login::redirects ... FAILED", "echo pull''-sent"):
            if expected not in text:
                raise Failure(f"the card does not show {expected!r}:\n{text}")
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
