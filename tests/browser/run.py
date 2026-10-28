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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bidi import Browser, Failure, free_port  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PASSCODE = "yardbell-browser-tests"
PASSCODE_HASH = "$argon2id$v=19$m=19456,t=2,p=1$W9HtFU6zAJJHfaLZxyoLZw$CowUQvJ7lk5RORBJ4iV9u9uJi2N9R2CA1dxq3fupAOg"
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
MACHINE = "hp"
SHORT_CHAT = "browsertestshort"
LONG_CHAT = "browsertestlong0"
PAGES = ["/", "/workspace", "/dispatch", "/settings", "/add"]


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
        # `claude`, out of reach: Dispatch looks Claude Code up through a login shell.
        self.env = {
            "HOME": home,
            "PATH": SYSTEM_PATH,
            "SHELL": "/bin/bash",
            "LANG": "C.UTF-8",
            "USER": os.environ.get("USER", "runner"),
            "TMUX_TMPDIR": self.tmux_dir,
            "YARDBELL_STATE": self.state,
            "CLAUDE_CONFIG_DIR": os.path.join(home, ".claude"),
        }
        out = subprocess.run(["bash", "-lic", "command -v claude"], env=self.env, capture_output=True, text=True)
        found = [line for line in out.stdout.splitlines() if line.startswith("/")]
        if found:
            raise SystemExit(f"refusing to start: the test server would find a real claude at {found[-1]}")
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
        for chat in (short, long):
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
