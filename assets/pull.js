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

  function describe(p) {
    const parts = [`Pull request #${p.number}${p.title ? `: ${p.title}` : ""}${p.draft ? " (draft)" : ""}`];
    if (p.state === "merged" || p.state === "closed") return `${parts[0]}. ${p.state === "merged" ? "Merged" : "Closed"}.`;
    const ci = { failing: "CI failing", pending: "CI running", passing: "CI passing" }[p.ci];
    if (ci) parts.push(p.ci === "failing" && p.failed?.length ? `${ci} on ${p.failed.join(", ")}` : ci);
    const review = { approved: "Approved", changes_requested: "Changes requested", review_required: "Review required" }[p.review];
    if (review) parts.push(review);
    return `${parts.join(". ")}.`;
  }

  window.YardbellPull = { status, describe };
})();
