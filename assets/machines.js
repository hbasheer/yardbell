(function () {
  const RATED = 85;

  function memPct(m) {
    const h = m.health;
    return m.up && h && h.mem_total_kb ? Math.round((h.mem_used_kb / h.mem_total_kb) * 100) : null;
  }

  function limitPct(m) {
    const h = m.health;
    return m.up && h && h.limit_kb ? Math.round((h.limit_used_kb / h.limit_kb) * 100) : null;
  }

  // An account's own memory limit can run out on a machine with plenty free, so it counts too.
  function tone(m) {
    if (!m.up) return "bad";
    return Math.max(memPct(m) ?? 0, limitPct(m) ?? 0) >= RATED ? "warn" : "ok";
  }

  function word(m) {
    const t = tone(m);
    if (t !== "warn") return t === "bad" ? "down" : "connected";
    const limit = limitPct(m);
    return limit !== null && limit > (memPct(m) ?? 0) ? `your memory limit at ${limit}%` : `memory at ${memPct(m)}%`;
  }

  function order(machines) {
    const rank = (m) => (m.up ? (tone(m) === "warn" ? 1 : 2) : 0);
    return [...machines].sort((a, b) => rank(a) - rank(b));
  }

  window.YardbellMachines = { RATED, memPct, limitPct, tone, word, order };
})();
