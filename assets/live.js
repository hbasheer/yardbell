(function () {
  // The server says on a websocket when the state changed, and the page then fetches /state as it
  // always did, so a change shows within a moment instead of on the page's next timer. While the
  // socket is down the page polls as before, and a hidden page does neither.
  const RETRY = [1000, 2000, 5000, 10000, 30000];
  // The server speaks after every machine check, so a socket quiet for this long died unnoticed,
  // for example while the computer slept.
  const QUIET = 30000;
  const followers = [];
  let socket = null;
  let open = false;
  let missed = false;
  let heard = 0;
  let attempt = 0;
  let retry = 0;

  function run(f) {
    if (f.running) { f.again = true; return; }
    f.running = true;
    Promise.resolve().then(f.load).catch(() => {}).finally(() => {
      f.running = false;
      if (f.again) { f.again = false; run(f); }
    });
  }

  function schedule(f) {
    clearTimeout(f.timer);
    if (document.hidden) return;
    f.timer = setTimeout(() => {
      if (open && Date.now() - heard > QUIET) reconnect();
      run(f);
      schedule(f);
    }, open ? QUIET : f.every);
  }

  function changed() {
    heard = Date.now();
    followers.forEach((f) => { run(f); schedule(f); });
  }

  function connect() {
    clearTimeout(retry);
    if (socket || document.hidden || !followers.length) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/state/live`);
    socket = ws;
    ws.onopen = () => {
      open = true;
      attempt = 0;
      heard = Date.now();
      if (missed) changed();
      else followers.forEach(schedule);
      missed = false;
    };
    ws.onmessage = changed;
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      open = false;
      missed = true;
      followers.forEach(schedule);
      if (!document.hidden) retry = setTimeout(connect, RETRY[Math.min(attempt++, RETRY.length - 1)]);
    };
  }

  function disconnect() {
    clearTimeout(retry);
    const ws = socket;
    socket = null;
    open = false;
    if (ws) ws.close();
  }

  function reconnect() {
    disconnect();
    missed = true;
    connect();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      disconnect();
      followers.forEach((f) => clearTimeout(f.timer));
      return;
    }
    attempt = 0;
    missed = false;
    changed();
    connect();
  });

  window.addEventListener("online", () => {
    attempt = 0;
    reconnect();
  });

  window.YardbellLive = {
    // Calls load whenever the state may have changed. The page makes the first call itself.
    follow(load, every) {
      const f = { load, every, timer: 0, running: false, again: false };
      followers.push(f);
      schedule(f);
      connect();
    },
    // After an action the server checks that machine again and says so on the socket. Without
    // the socket, ask for the check from here, as the pages did before.
    soon() {
      if (open) return;
      fetch("/refresh", { method: "POST", headers: { Accept: "application/json" } }).catch(() => {}).finally(changed);
    },
  };
})();
