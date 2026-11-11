(function () {
  // One word for a session's pull request, the most urgent first: what failed or cannot merge,
  // then what a reviewer asked for, then how far CI got.
  function status(p) {
    if (p.state === "merged") return { word: "merged", tone: "done" };
    if (p.state === "closed") return { word: "closed", tone: "" };
    if (p.ci === "failing") return { word: "CI failing", tone: "bad" };
    if (p.mergeable === "conflicting") return { word: "conflicts", tone: "bad" };
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
    if (p.mergeable === "conflicting") parts.push(p.base ? `Merge conflicts with ${p.base}` : "Merge conflicts");
    const review = { approved: "Approved", changes_requested: "Changes requested", review_required: "Review required" }[p.review];
    if (review) parts.push(review);
    return parts;
  }

  function describe(p) {
    const head = `${noun(p)} ${ref(p)}${p.title ? `: ${p.title}` : ""}${p.draft ? " (draft)" : ""}`;
    return `${[head, ...details(p)].join(". ")}.`;
  }

  // Starts a review of a session's pull request, in the Dispatch conversation that follows the
  // session, and gives back that conversation.
  async function review(machine, name) {
    const res = await fetch("/dispatch/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ machine, name }),
    });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("logged out");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data.conversation;
  }

  // Where the newest review of a session's branch stands, shown beside its pull request badge.
  function reviewMark(s) {
    const r = s?.review;
    if (!r) return null;
    const href = `/dispatch?c=${encodeURIComponent(r.conversation)}`;
    const head = s.pull?.head;
    if (["ready", "changes"].includes(r.state) && head && r.commit && r.commit !== head) {
      return { word: "reviewed an older commit", tone: "", href, title: `The newest review was of ${r.commit.slice(0, 7)}. ${noun(s.pull)} ${ref(s.pull)} is now at ${head.slice(0, 7)}.` };
    }
    switch (r.state) {
      case "asking": return { word: "review waiting", tone: "pending", href, title: "A review of this branch waits for you in Dispatch." };
      case "reviewing": return { word: "reviewing", tone: "pending", href, title: "A reviewer is reading this branch and running its tests." };
      case "ready": return { word: "review: ready", tone: "ok", href, title: "The newest review found nothing that needs changing." };
      default: {
        const n = r.findings || 0;
        const word = n ? `${n} review ${n === 1 ? "finding" : "findings"}` : "review: changes needed";
        const tone = { high: "bad", medium: "warn", low: "" }[r.top] ?? "warn";
        return { word, tone, href, title: `The newest review asks for changes${r.top ? `; the most serious is ${r.top}` : ""}.` };
      }
    }
  }

  function reviewable(s) {
    return Boolean(s?.tmux && s.pull?.state === "open" && !s.stale);
  }

  // GitHub can take a moment to say whether a pull request merges cleanly, so only a known conflict
  // keeps an approved, green one out of Ready to merge.
  function ready(p) {
    return !p.draft && p.review === "approved" && (p.ci === "passing" || p.ci === "none") && p.mergeable !== "conflicting";
  }

  function mergeText(p) {
    return {
      title: `Merge ${ref(p)}?`,
      body: `${p.title ? `${p.title}. ` : ""}It merges into ${p.base || "its base branch"} on ${p.forge === "gitlab" ? "GitLab" : "GitHub"}, the way Settings says, and only if nothing was pushed to the ${noun(p).toLowerCase()} since this page showed it. The branch is kept.`,
    };
  }

  async function merge(s) {
    const res = await fetch(`/sessions/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux)}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ head: s.pull.head }),
    });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("logged out");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return ref(s.pull);
  }

  window.YardbellPull = { status, describe, details, ref, noun, review, reviewable, reviewMark, ready, mergeText, merge };
})();
