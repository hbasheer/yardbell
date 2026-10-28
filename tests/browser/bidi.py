"""A small WebDriver BiDi client for headless Firefox, using only the standard library."""

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.parse

KEYS = {
    "Enter": "",
    "Tab": "",
    "Escape": "",
    "Backspace": "",
    "ArrowUp": "",
    "ArrowDown": "",
    "ArrowLeft": "",
    "ArrowRight": "",
}
MODIFIERS = {"Shift": "", "Control": "", "Alt": "", "Meta": ""}


class Failure(Exception):
    pass


class WebSocket:
    def __init__(self, url):
        u = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise Failure("Firefox closed the websocket during the handshake")
            buf += chunk
        head, _, self.buf = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise Failure("websocket handshake refused: " + head.decode(errors="replace"))

    def send(self, data, opcode=0x1):
        data = data.encode() if isinstance(data, str) else data
        head = bytearray([0x80 | opcode])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _frame(self):
        b = self.buf
        if len(b) < 2:
            return None
        n, i = b[1] & 0x7F, 2
        if n == 126:
            if len(b) < 4:
                return None
            n, i = struct.unpack(">H", b[2:4])[0], 4
        elif n == 127:
            if len(b) < 10:
                return None
            n, i = struct.unpack(">Q", b[2:10])[0], 10
        if b[1] & 0x80:
            i += 4
        if len(b) < i + n:
            return None
        self.buf = b[i + n :]
        return b[0], b[i : i + n]

    def recv(self, timeout):
        deadline = time.time() + timeout
        parts = b""
        while True:
            frame = self._frame()
            if frame is None:
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError
                self.sock.settimeout(left)
                try:
                    chunk = self.sock.recv(1 << 20)
                except socket.timeout:
                    raise TimeoutError
                if not chunk:
                    raise Failure("Firefox closed the websocket")
                self.buf += chunk
                continue
            b0, data = frame
            op = b0 & 0x0F
            if op == 0x8:
                raise Failure("Firefox closed the websocket")
            if op == 0x9:
                self.send(data, opcode=0xA)
                continue
            if op == 0xA:
                continue
            parts += data
            if b0 & 0x80:
                return parts.decode()


def plain(v):
    t, val = v.get("type"), v.get("value")
    if t in ("undefined", "null"):
        return None
    if t in ("array", "set"):
        return [plain(x) for x in val or []]
    if t in ("object", "map"):
        return {(k if isinstance(k, str) else str(plain(k))): plain(x) for k, x in val or []}
    if t in ("string", "number", "boolean", "bigint"):
        return val
    return f"<{t}>"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Browser:
    def __init__(self, firefox, width=1280, height=800):
        self.profile = tempfile.mkdtemp(prefix="yardbell-firefox-")
        prefs = {
            "browser.shell.checkDefaultBrowser": False,
            "browser.aboutwelcome.enabled": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.reportingpolicy.firstRun": False,
            "browser.startup.homepage_override.mstone": "ignore",
            "app.update.disabledForTesting": True,
            "layout.css.prefers-color-scheme.content-override": 1,
            "ui.prefersReducedMotion": 1,
        }
        with open(os.path.join(self.profile, "user.js"), "w") as f:
            for k, v in prefs.items():
                f.write(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n")
        port = free_port()
        self.log = open(os.path.join(self.profile, "firefox.log"), "w")
        self.proc = subprocess.Popen(
            [
                firefox,
                "--headless",
                "--no-remote",
                "--profile",
                self.profile,
                f"--remote-debugging-port={port}",
                f"--width={width}",
                f"--height={height}",
                "about:blank",
            ],
            stdout=self.log,
            stderr=self.log,
            start_new_session=True,
        )
        self.next_id = 0
        self.errors = []
        try:
            self.ws = self._connect(port)
            self.call("session.new", capabilities={})
            self.call("session.subscribe", events=["log.entryAdded"])
            self.context = self.call("browsingContext.getTree")["contexts"][0]["context"]
        except BaseException:
            self.close()
            raise
        self.viewport(width, height)

    def _connect(self, port):
        deadline = time.time() + 60
        while time.time() < deadline:
            if self.proc.poll() is not None:
                break
            try:
                return WebSocket(f"ws://127.0.0.1:{port}/session")
            except (OSError, Failure):
                time.sleep(0.25)
        self.log.flush()
        with open(os.path.join(self.profile, "firefox.log")) as f:
            tail = f.read()[-2000:]
        raise Failure("Firefox did not start:\n" + tail)

    def close(self):
        try:
            self.call("browser.close", timeout=5)
        except Exception:
            pass
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(5)
        self.log.close()
        shutil.rmtree(self.profile, ignore_errors=True)

    def call(self, method, timeout=30.0, **params):
        self.next_id += 1
        mid = self.next_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        deadline = time.time() + timeout
        while True:
            try:
                msg = json.loads(self.ws.recv(max(deadline - time.time(), 0.01)))
            except TimeoutError:
                raise Failure(f"{method} got no answer within {timeout}s")
            if msg.get("id") == mid:
                if msg.get("type") == "error":
                    raise Failure(f"{method}: {msg.get('error')}: {msg.get('message')}")
                return msg.get("result", {})
            self._event(msg)

    def pump(self, seconds):
        deadline = time.time() + seconds
        while True:
            left = deadline - time.time()
            if left <= 0:
                return
            try:
                self._event(json.loads(self.ws.recv(left)))
            except TimeoutError:
                return

    def _event(self, msg):
        if msg.get("method") != "log.entryAdded":
            return
        p = msg.get("params", {})
        if p.get("level") != "error":
            return
        frames = (p.get("stackTrace") or {}).get("callFrames") or []
        where = f" at {frames[0].get('url')}:{frames[0].get('lineNumber', 0) + 1}" if frames else ""
        kind = "page error" if p.get("type") == "javascript" else "console.error"
        self.errors.append(f"[{kind}] {p.get('text')}{where}")

    def viewport(self, width, height, ratio=1):
        self.call(
            "browsingContext.setViewport",
            context=self.context,
            viewport={"width": width, "height": height},
            devicePixelRatio=ratio,
        )
        self.pump(0.2)

    def goto(self, url):
        self.call("browsingContext.navigate", context=self.context, url=url, wait="complete")
        self.pump(0.2)

    def js(self, expression):
        r = self.call(
            "script.evaluate",
            expression=expression,
            target={"context": self.context},
            awaitPromise=True,
            userActivation=True,
            resultOwnership="none",
            serializationOptions={"maxObjectDepth": 6},
        )
        if r.get("type") == "exception":
            d = r.get("exceptionDetails", {})
            raise Failure(f"script threw: {d.get('text') or json.dumps(d)[:500]}\n  in: {expression[:300]}")
        return plain(r.get("result", {}))

    def wait(self, expression, what, timeout=10):
        deadline = time.time() + timeout
        while True:
            value = self.js(expression)
            if value:
                return value
            if time.time() > deadline:
                raise Failure(f"timed out after {timeout}s waiting for {what}")
            self.pump(0.15)

    def click(self, selector):
        box = self.wait(
            f"""(() => {{
              const el = document.querySelector({json.dumps(selector)});
              if (!el) return null;
              el.scrollIntoView({{block: "center", inline: "center"}});
              const r = el.getBoundingClientRect();
              return r.width && r.height ? {{x: r.left + r.width / 2, y: r.top + r.height / 2}} : null;
            }})()""",
            f"a visible {selector}",
        )
        self._actions(
            {
                "type": "pointer",
                "id": "mouse",
                "parameters": {"pointerType": "mouse"},
                "actions": [
                    {"type": "pointerMove", "x": int(box["x"]), "y": int(box["y"]), "origin": "viewport"},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerUp", "button": 0},
                ],
            }
        )
        self.pump(0.2)

    def type(self, text):
        keys = []
        for ch in text:
            keys += [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]
        self._actions({"type": "key", "id": "keyboard", "actions": keys})
        self.pump(0.1)

    def key(self, name, *modifiers):
        held = [MODIFIERS[m] for m in modifiers]
        key = KEYS.get(name, name)
        seq = [{"type": "keyDown", "value": m} for m in held]
        seq += [{"type": "keyDown", "value": key}, {"type": "keyUp", "value": key}]
        seq += [{"type": "keyUp", "value": m} for m in reversed(held)]
        self._actions({"type": "key", "id": "keyboard", "actions": seq})
        self.pump(0.1)

    def _actions(self, *sources):
        self.call("input.performActions", context=self.context, actions=list(sources))
        self.call("input.releaseActions", context=self.context)

    def screenshot(self, path):
        data = self.call("browsingContext.captureScreenshot", context=self.context)["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))

    def close_other_tabs(self):
        for c in self.call("browsingContext.getTree")["contexts"]:
            if c["context"] != self.context:
                self.call("browsingContext.close", context=c["context"])
