(function () {
  const LANES = [
    { key: "needs", title: "Needs you", help: "Waiting for your answer, stopped on an error, or its pull request failed CI, has conflicts or has changes requested" },
    { key: "working", title: "Working", help: "The agent is working" },
    { key: "review", title: "In review", help: "Its pull request is open: CI is running, or it waits for a review" },
    { key: "ready", title: "Ready to merge", help: "Approved, CI green and no merge conflicts" },
    { key: "idle", title: "Idle", help: "No open pull request" },
  ];

  function needsFix(p) {
    return p.ci === "failing" || p.mergeable === "conflicting" || p.review === "changes_requested";
  }

  // A working agent is left to work, whatever its pull request says; an idle one is placed by what
  // its pull request needs next.
  function lane(s) {
    if (s.activity === "blocked" || s.stopped) return "needs";
    if (s.activity === "active") return "working";
    const p = s.pull;
    if (!p || p.state !== "open") return "idle";
    if (needsFix(p)) return "needs";
    if (window.YardbellPull.ready(p)) return "ready";
    return "review";
  }

  window.YardbellBoard = { LANES, lane, ready: window.YardbellPull.ready };
})();
