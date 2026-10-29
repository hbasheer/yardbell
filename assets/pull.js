(function () {
  // One word for a session's pull request, the most urgent first: what failed, then what a
  // reviewer asked for, then how far CI got.
  function status(p) {
    if (p.state === "merged") return { word: "merged", tone: "done" };
    if (p.state === "closed") return { word: "closed", tone: "" };
    if (p.ci === "failing") return { word: "CI failing", tone: "bad" };
    if (p.review === "changes_requested") return { word: "changes requested", tone: "warn" };
    if (p.ci === "pending") return { word: "CI running", tone: "pending" };
    if (p.review === "approved") return { word: "approved", tone: "ok" };
    if (p.ci === "passing") return { word: "CI passing", tone: "ok" };
    return { word: p.draft ? "draft" : "open", tone: "" };
  }

  // GitLab numbers a merge request !12 where GitHub writes #12.
  function ref(p) {
    return `${p.forge === "gitlab" ? "!" : "#"}${p.number}`;
  }

  function noun(p) {
    return p.forge === "gitlab" ? "Merge request" : "Pull request";
  }

  // What the badge's word leaves out: where CI and the review stand, or that it was merged or closed.
  function details(p) {
    if (p.state === "merged" || p.state === "closed") return [p.state === "merged" ? "Merged" : "Closed"];
    const parts = [];
    const ci = { failing: p.forge === "gitlab" ? "Pipeline failing" : "CI failing", pending: "CI running", passing: "CI passing" }[p.ci];
    if (ci) parts.push(p.ci === "failing" && p.failed?.length ? `${ci} on ${p.failed.join(", ")}` : ci);
    const review = { approved: "Approved", changes_requested: "Changes requested", review_required: "Review required" }[p.review];
    if (review) parts.push(review);
    return parts;
  }

  function describe(p) {
    const head = `${noun(p)} ${ref(p)}${p.title ? `: ${p.title}` : ""}${p.draft ? " (draft)" : ""}`;
    return `${[head, ...details(p)].join(". ")}.`;
  }

  window.YardbellPull = { status, describe, details, ref, noun };
})();
