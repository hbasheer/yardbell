use super::{last_lines, Check, Ci, Note, Pull, LOG_BYTES, LOG_LINES};
use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize, Default)]
struct Who {
    #[serde(default)]
    username: String,
}

fn name(who: &Option<Who>) -> String {
    who.as_ref().map(|w| w.username.clone()).unwrap_or_default()
}

#[derive(Deserialize)]
struct Listed {
    iid: u64,
    #[serde(default)]
    source_project_id: Option<u64>,
    #[serde(default)]
    target_project_id: Option<u64>,
}

#[derive(Deserialize)]
struct RawPipeline {
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct RawMr {
    iid: u64,
    web_url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    author: Option<Who>,
    #[serde(default)]
    head_pipeline: Option<RawPipeline>,
}

#[derive(Deserialize)]
struct RawReviewer {
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
struct RawApprovals {
    #[serde(default)]
    approved: bool,
}

#[derive(Deserialize)]
struct RawJob {
    #[serde(default)]
    name: String,
    #[serde(default)]
    stage: String,
    #[serde(default)]
    allow_failure: bool,
    #[serde(default)]
    web_url: String,
}

#[derive(Deserialize)]
struct RawPosition {
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    new_line: Option<u64>,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    old_line: Option<u64>,
}

#[derive(Deserialize)]
struct RawNote {
    id: u64,
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: Option<Who>,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    position: Option<RawPosition>,
}

#[derive(Deserialize)]
struct RawDiscussion {
    #[serde(default)]
    notes: Vec<RawNote>,
}

// A merge request opened from a fork can share the branch's name; it is someone else's.
pub(super) fn pick_mr(list_json: &str) -> Result<Option<u64>, String> {
    let list: Vec<Listed> = serde_json::from_str(list_json).map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .find(|m| m.source_project_id == m.target_project_id)
        .map(|m| m.iid))
}

pub(super) fn ci_of(status: Option<&str>) -> Ci {
    match status {
        Some("failed") => Ci::Failing,
        Some(
            "created" | "waiting_for_resource" | "preparing" | "pending" | "running" | "scheduled",
        ) => Ci::Pending,
        Some("success") => Ci::Passing,
        _ => Ci::None,
    }
}

pub(super) fn parse_mr(json: &str) -> Result<Pull, String> {
    let raw: RawMr = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let state = match raw.state.as_str() {
        "opened" | "locked" => "open".to_string(),
        other => other.to_string(),
    };
    Ok(Pull {
        forge: "gitlab".into(),
        number: raw.iid,
        url: raw.web_url,
        title: raw.title,
        state,
        draft: raw.draft,
        review: String::new(),
        ci: ci_of(raw.head_pipeline.as_ref().and_then(|p| p.status.as_deref())),
        failed: Vec::new(),
        head: raw.sha.unwrap_or_default(),
        author: name(&raw.author),
        notes: Vec::new(),
    })
}

pub(super) fn review_of(reviewers_json: Option<&str>, approvals_json: Option<&str>) -> String {
    let reviewers: Vec<RawReviewer> = reviewers_json
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    if reviewers.iter().any(|r| r.state == "requested_changes") {
        return "changes_requested".into();
    }
    let approved = approvals_json
        .and_then(|j| serde_json::from_str::<RawApprovals>(j).ok())
        .is_some_and(|a| a.approved);
    if approved {
        "approved".into()
    } else {
        String::new()
    }
}

pub(super) fn failed_checks(jobs_json: &str) -> Result<Vec<Check>, String> {
    let jobs: Vec<RawJob> = serde_json::from_str(jobs_json).map_err(|e| e.to_string())?;
    Ok(jobs
        .into_iter()
        .filter(|j| !j.allow_failure)
        .map(|j| Check {
            name: if j.stage.is_empty() {
                j.name
            } else {
                format!("{} / {}", j.stage, j.name)
            },
            url: j.web_url,
            log: String::new(),
        })
        .collect())
}

fn place(p: &RawPosition) -> String {
    let at = |path: &Option<String>, line: Option<u64>| match (path, line) {
        (Some(path), Some(line)) => Some(format!("{path}:{line}")),
        _ => None,
    };
    at(&p.new_path, p.new_line)
        .or_else(|| at(&p.old_path, p.old_line))
        .or_else(|| p.new_path.clone().or_else(|| p.old_path.clone()))
        .unwrap_or_default()
}

pub(super) fn notes(discussions_json: &str, web_url: &str, author: &str, me: &str) -> Vec<Note> {
    let Ok(discussions) = serde_json::from_str::<Vec<RawDiscussion>>(discussions_json) else {
        return Vec::new();
    };
    discussions
        .into_iter()
        .flat_map(|d| d.notes)
        .filter_map(|n| {
            let who = name(&n.author);
            if n.system || who.is_empty() || who == author || (!me.is_empty() && who == me) {
                return None;
            }
            Some(Note {
                id: format!("gitlab:{}", n.id),
                kind: if n.position.is_some() {
                    "inline"
                } else {
                    "comment"
                }
                .into(),
                author: who,
                body: n.body,
                url: format!("{web_url}#note_{}", n.id),
                place: n.position.as_ref().map(place).unwrap_or_default(),
            })
        })
        .collect()
}

pub(super) fn job_id(check_url: &str) -> Option<u64> {
    let (_, tail) = check_url.split_once("/-/jobs/")?;
    tail.split(['/', '?', '#']).next()?.parse().ok()
}

fn noise() -> &'static (Regex, Regex) {
    static RE: OnceLock<(Regex, Regex)> = OnceLock::new();
    RE.get_or_init(|| {
        (
            Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("static regex"),
            Regex::new(r"section_(start|end):\d+:\S*").expect("static regex"),
        )
    })
}

// A runner redraws a line with carriage returns and wraps each step in section markers; only
// what the line finally said is worth reading.
pub(super) fn excerpt(trace: &str) -> String {
    let (ansi, section) = noise();
    let lines: Vec<String> = trace
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .map(|l| l.rsplit('\r').next().unwrap_or(l))
        .map(|l| section.replace_all(l, "").to_string())
        .map(|l| ansi.replace_all(&l, "").trim_end().to_string())
        .filter(|l| !l.trim().is_empty())
        .collect();
    last_lines(&lines, LOG_LINES, LOG_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MRS: &str = include_str!("../../tests/fixtures/gitlab_mrs.json");
    const MR: &str = include_str!("../../tests/fixtures/gitlab_mr.json");
    const REVIEWERS: &str = include_str!("../../tests/fixtures/gitlab_reviewers.json");
    const APPROVALS: &str = include_str!("../../tests/fixtures/gitlab_approvals.json");
    const JOBS: &str = include_str!("../../tests/fixtures/gitlab_jobs.json");
    const DISCUSSIONS: &str = include_str!("../../tests/fixtures/gitlab_discussions.json");
    const TRACE: &str = include_str!("../../tests/fixtures/gitlab_trace.txt");
    const WEB: &str = "https://git.commslayer.com/commslayer/app/-/merge_requests/12";

    #[test]
    fn the_merge_request_from_this_project_is_picked() {
        assert_eq!(pick_mr(MRS).unwrap(), Some(12));
        assert_eq!(pick_mr("[]").unwrap(), None);
        assert!(pick_mr("{").is_err());
    }

    #[test]
    fn a_merge_request_is_read() {
        let p = parse_mr(MR).unwrap();
        assert_eq!(p.forge, "gitlab");
        assert_eq!(p.number, 12);
        assert_eq!(p.url, WEB);
        assert_eq!(p.title, "Fix the login redirect");
        assert_eq!(p.state, "open");
        assert!(!p.draft);
        assert_eq!(p.head, format!("abc123{}", "0".repeat(34)));
        assert_eq!(p.author, "hb");
        assert_eq!(p.ci, Ci::Failing);
        for (state, want) in [
            ("opened", "open"),
            ("locked", "open"),
            ("merged", "merged"),
            ("closed", "closed"),
        ] {
            let mut v: serde_json::Value = serde_json::from_str(MR).unwrap();
            v["state"] = state.into();
            assert_eq!(parse_mr(&v.to_string()).unwrap().state, want, "{state}");
        }
    }

    #[test]
    fn pipeline_statuses_add_up_to_one_ci_state() {
        assert_eq!(ci_of(Some("failed")), Ci::Failing);
        for s in [
            "created",
            "waiting_for_resource",
            "preparing",
            "pending",
            "running",
            "scheduled",
        ] {
            assert_eq!(ci_of(Some(s)), Ci::Pending, "{s}");
        }
        assert_eq!(ci_of(Some("success")), Ci::Passing);
        for s in [Some("canceled"), Some("skipped"), Some("manual"), None] {
            assert_eq!(ci_of(s), Ci::None, "{s:?}");
        }
    }

    #[test]
    fn review_state_comes_from_reviewers_then_approvals() {
        assert_eq!(
            review_of(Some(REVIEWERS), Some(APPROVALS)),
            "changes_requested"
        );
        let approved = r#"[{"user":{"username":"rev2"},"state":"approved"}]"#;
        assert_eq!(review_of(Some(approved), Some(APPROVALS)), "approved");
        assert_eq!(review_of(None, Some(APPROVALS)), "approved");
        assert_eq!(review_of(None, Some(r#"{"approved":false}"#)), "");
        assert_eq!(review_of(None, None), "");
    }

    #[test]
    fn failed_jobs_that_may_fail_are_left_out() {
        assert_eq!(
            failed_checks(JOBS).unwrap(),
            [Check {
                name: "test / rspec".into(),
                url: "https://git.commslayer.com/commslayer/app/-/jobs/9001".into(),
                log: String::new(),
            }]
        );
        assert!(failed_checks("nope").is_err());
    }

    #[test]
    fn notes_leave_out_system_author_and_own_comments() {
        let got = notes(DISCUSSIONS, WEB, "hb", "me-bot");
        let short: Vec<(&str, &str, &str, &str)> = got
            .iter()
            .map(|n| {
                (
                    n.id.as_str(),
                    n.kind.as_str(),
                    n.author.as_str(),
                    n.place.as_str(),
                )
            })
            .collect();
        assert_eq!(
            short,
            [
                ("gitlab:301", "comment", "rev1", ""),
                ("gitlab:303", "inline", "rev1", "app/models/user.rb:42"),
                (
                    "gitlab:305",
                    "inline",
                    "rev2",
                    "app/controllers/sessions_controller.rb:17"
                ),
            ]
        );
        assert_eq!(got[0].url, format!("{WEB}#note_301"));
        assert_eq!(got[0].body, "Please add a test for the redirect.");
        assert!(notes("not json", WEB, "hb", "").is_empty());
    }

    #[test]
    fn a_job_id_is_read_from_its_url() {
        assert_eq!(job_id("https://git.x/g/app/-/jobs/123"), Some(123));
        assert_eq!(
            job_id("https://github.com/acme/app/actions/runs/111/job/222"),
            None
        );
    }

    #[test]
    fn the_trace_excerpt_is_the_readable_end() {
        let e = excerpt(TRACE);
        assert!(!e.contains('\u{1b}'), "{e:?}");
        assert!(!e.contains("section_"), "{e:?}");
        assert!(!e.contains('\r'), "{e:?}");
        assert!(
            e.contains("Downloading 100%") && !e.contains("Downloading 10%"),
            "{e:?}"
        );
        assert!(e.lines().count() <= 30);
        assert!(e.ends_with("ERROR: Job failed: exit code 1"), "{e:?}");
        assert_eq!(super::super::telling_line(&e), "2 examples, 1 failure");
    }
}
