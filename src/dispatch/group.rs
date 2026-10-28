use super::follow::{self, Tracked};
use super::review::{bullet, clip, is_marker, unframed, value_of};
use super::store::now;
use super::{actions, missing, Dispatch, Refusal, Rule};
use crate::state::StateView;
use chrono::{DateTime, Local};
use serde::Deserialize;
use serde_json::{json, Value};

pub const MIN_CHILDREN: usize = 2;
pub const MAX_CHILDREN: usize = 6;
pub const DEFAULT_MINUTES: u64 = 60;
pub const MAX_MINUTES: u64 = 1440;
const MAX_LABEL: usize = 60;
const MAX_GATHER: usize = 2000;
const START: &str = "YARDBELL RESULT";
const END: &str = "END RESULT";
const MAX_DETAILS: usize = 10;
const SCREEN_LINES: usize = 14;
const TOLD_LINES: usize = 3;

#[derive(Deserialize)]
struct Args {
    #[serde(default)]
    title: String,
    #[serde(default)]
    children: Vec<Value>,
    #[serde(default)]
    gather: String,
    #[serde(default)]
    timeout_minutes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub title: String,
    pub gather: String,
    pub minutes: u64,
    pub children: Vec<Child>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Child {
    pub label: String,
    pub input: Value,
}

// How the rules decided one child's start.
#[derive(Debug, Clone, PartialEq)]
pub enum ChildStart {
    Ask(Option<Rule>),
    Run(Option<Rule>),
    Refuse { reason: String, rule: Option<Rule> },
}

pub fn plan(args: Value) -> Result<Plan, String> {
    let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
    let n = a.children.len();
    if !(MIN_CHILDREN..=MAX_CHILDREN).contains(&n) {
        return Err(format!(
            "a group has {MIN_CHILDREN} to {MAX_CHILDREN} children, this one has {n}; for one session use start_session"
        ));
    }
    let minutes = a.timeout_minutes.unwrap_or(DEFAULT_MINUTES);
    if !(1..=MAX_MINUTES).contains(&minutes) {
        return Err(format!(
            "timeout_minutes must be between 1 and {MAX_MINUTES}"
        ));
    }
    let gather = a.gather.trim().to_string();
    if gather.chars().count() > MAX_GATHER {
        return Err(format!("gather is longer than {MAX_GATHER} characters"));
    }
    let mut children: Vec<Child> = Vec::new();
    for (i, mut input) in a.children.into_iter().enumerate() {
        let n = i + 1;
        let Some(fields) = input.as_object_mut() else {
            return Err(format!(
                "child {n} must be an object with machine, folder and prompt"
            ));
        };
        let label = match fields.remove("label") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(label)) => label.trim().to_string(),
            Some(_) => return Err(format!("child {n}: label must be text")),
        };
        let label = if label.is_empty() {
            format!("Child {n}")
        } else {
            label
        };
        if label.chars().count() > MAX_LABEL || label.chars().any(char::is_control) {
            return Err(format!(
                "child {n}: label must be one line of at most {MAX_LABEL} characters"
            ));
        }
        if let Some(j) = children
            .iter()
            .position(|c| c.label.eq_ignore_ascii_case(&label))
        {
            return Err(format!(
                "children {} and {n} are both labelled {label:?}, give each its own label",
                j + 1
            ));
        }
        // A child is a new working session, never a reviewer or a resumed one.
        for key in ["read_only", "resume", "wait"] {
            fields.remove(key);
        }
        children.push(Child { label, input });
    }
    let title = match a.title.trim() {
        "" => format!("{n} sessions"),
        title => super::store::title_of(title),
    };
    Ok(Plan {
        title,
        gather,
        minutes,
        children,
    })
}

// Where a child works: the machine, the checkout (a folder label or a path) and the branch, empty
// for the checkout's current one.
#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    pub machine: String,
    pub repo: String,
    pub branch: String,
}

// Two children on the same branch of the same checkout would share one worktree and undo each
// other's work.
pub fn clash(places: &[Place]) -> Option<(usize, usize)> {
    for (i, a) in places.iter().enumerate() {
        if let Some(j) = places[i + 1..]
            .iter()
            .position(|b| a.machine == b.machine && a.repo == b.repo && a.branch == b.branch)
        {
            return Some((i, i + 1 + j));
        }
    }
    None
}

pub fn clash_message(places: &[Place], (a, b): (usize, usize)) -> String {
    let p = &places[a];
    let on = match p.branch.as_str() {
        "" => "on its current branch".to_string(),
        branch => format!("on branch {branch}"),
    };
    format!(
        "children {} and {} would both work in {} on {} {on}, give each its own branch",
        a + 1,
        b + 1,
        p.repo,
        p.machine
    )
}

// The end of every child's task: the block Yardbell reads back when it gathers the group.
pub fn with_request(prompt: &str, title: &str, gather: &str) -> String {
    if prompt.trim().is_empty() {
        return prompt.to_string();
    }
    let mut text = format!(
        "{prompt}\n\nThis session is one of several that Yardbell started together as the group \
\"{title}\". When you are done, end your reply with this block and nothing after it, so Yardbell \
can gather your result with the others:\n\n{START}\nstatus: done, partial, or failed\n\
summary: one to three sentences on what you did and what you found\n\
branch: the branch your work is on\n- one line for each detail worth knowing, such as a test \
result or a risk\n{END}"
    );
    if !gather.is_empty() {
        let stop = if gather.ends_with(['.', '!', '?']) {
            ""
        } else {
            "."
        };
        text.push_str(&format!(
            "\n\nThe results will be used to: {gather}{stop} Put what that needs in the summary \
and the detail lines."
        ));
    }
    text
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub status: &'static str,
    pub summary: String,
    pub branch: String,
    pub details: Vec<String>,
}

impl Outcome {
    pub fn to_json(&self) -> Value {
        json!({
            "status": self.status,
            "summary": self.summary,
            "branch": self.branch,
            "details": self.details,
        })
    }
}

fn status(word: &str) -> Option<&'static str> {
    match word.trim_end_matches('.').to_ascii_lowercase().as_str() {
        "done" | "finished" | "complete" | "completed" | "success" => Some("done"),
        "partial" | "partly done" | "partially done" => Some("partial"),
        "failed" | "blocked" | "stuck" => Some("failed"),
        _ => None,
    }
}

// The last result block on the screen. The block the task asks for ("done, partial, or failed")
// is not a status, so a screen that only shows the task, or a block still being written, gives
// None.
pub fn parse(screen: &str) -> Option<Outcome> {
    let lines: Vec<&str> = screen.lines().map(unframed).collect();
    let start = lines.iter().rposition(|l| is_marker(l, START))?;
    let end = start + lines[start..].iter().position(|l| is_marker(l, END))?;
    let mut found = None;
    let mut summary = String::new();
    let mut branch = String::new();
    let mut details: Vec<String> = Vec::new();
    let mut in_summary = false;
    for line in lines[start + 1..end].iter().filter(|l| !l.is_empty()) {
        if let Some(word) = value_of(line, "status") {
            found = Some(status(word)?);
            in_summary = false;
        } else if let Some(text) = value_of(line, "summary") {
            summary = text.to_string();
            in_summary = true;
        } else if let Some(text) = value_of(line, "branch") {
            branch = text.trim_matches('`').to_string();
            in_summary = false;
        } else if let Some(item) = bullet(line) {
            in_summary = false;
            if details.len() < MAX_DETAILS {
                details.push(item.to_string());
            }
        } else if in_summary {
            summary = format!("{summary} {line}");
        } else if let Some(last) = details.last_mut() {
            *last = format!("{last} {line}");
        }
    }
    Some(Outcome {
        status: found?,
        summary: clip(summary.trim()),
        branch: clip(&branch),
        details: details.iter().map(|d| clip(d)).collect(),
    })
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

// What became of one child's start: still to decide, starting, started as a session, or not.
enum Start {
    Undecided,
    Starting,
    Started(Box<Tracked>),
    NotStarted(String),
}

fn start_of(events: &[Value], step: &str) -> Start {
    let Some(a) = events
        .iter()
        .find(|e| e["role"] == "action" && e["id"] == step)
    else {
        return Start::NotStarted("Yardbell lost this step".into());
    };
    match text(a, "status") {
        "pending" => Start::Undecided,
        "rejected" => Start::NotStarted("rejected".into()),
        "withdrawn" => Start::NotStarted("withdrawn".into()),
        _ if a["result"].is_null() => Start::Starting,
        _ if a["result"]["ok"] != true => Start::NotStarted(format!(
            "it failed to start: {}",
            text(&a["result"], "text")
        )),
        _ => match follow::started(&a["result"]["session"]) {
            Some(t) => Start::Started(Box::new(t)),
            None => Start::NotStarted("it did not say which session it started".into()),
        },
    }
}

fn done(child: &Value) -> bool {
    child["state"] == "ended" || (child["state"] == "idle" && child["worked"] == true)
}

fn stamp(at: DateTime<Local>) -> String {
    at.to_rfc3339()
}

fn deadline(group: &Value) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(text(group, "deadline"))
        .ok()
        .map(|d| d.with_timezone(&Local))
}

// A group whose children are all done, or whose time is up, and the children to read back.
#[derive(Debug, Clone, PartialEq)]
pub struct Due {
    pub conversation: String,
    pub group: String,
    pub why: &'static str,
    pub children: Vec<Gathering>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Gathering {
    pub child: usize,
    pub machine: String,
    pub name: String,
    pub live: bool,
}

// Moves each group on: it runs once no child waits to be decided or is still starting, and it is
// due once every child that started is done (idle after working, or ended), or its time is up.
// The clock starts when the group starts running, so time spent waiting for approval is not
// counted. Returns whether anything changed.
pub(super) fn advance(
    conversation: &str,
    events: &mut [Value],
    view: &StateView,
    at: DateTime<Local>,
) -> (bool, Vec<Due>) {
    let mut changed = false;
    let mut due = Vec::new();
    let groups: Vec<usize> = (0..events.len())
        .filter(|i| events[*i]["role"] == "group")
        .collect();
    for gi in groups {
        let starts: Vec<Option<Start>> = events[gi]["children"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| c["step"].as_str().map(|s| start_of(events, s)))
            .collect();
        let group = &mut events[gi];
        match text(group, "status") {
            "waiting" => {
                if starts
                    .iter()
                    .flatten()
                    .any(|s| matches!(s, Start::Undecided | Start::Starting))
                {
                    continue;
                }
                let any = starts
                    .iter()
                    .flatten()
                    .any(|s| matches!(s, Start::Started(_)));
                if any {
                    let minutes = group["minutes"].as_u64().unwrap_or(DEFAULT_MINUTES) as i64;
                    group["status"] = json!("running");
                    group["started"] = json!(stamp(at));
                    group["deadline"] = json!(stamp(at + chrono::Duration::minutes(minutes)));
                } else {
                    group["status"] = json!("dropped");
                }
                changed = true;
            }
            "running" => {}
            _ => continue,
        }
        if group["status"] != "running" {
            continue;
        }
        let mut gathering = Vec::new();
        for (i, start) in starts.iter().enumerate() {
            let Some(Start::Started(t)) = start else {
                continue;
            };
            let child = &mut group["children"][i];
            let before = (child["state"].clone(), child["worked"].clone());
            child["session"] = json!({ "machine": t.machine, "name": t.name, "path": t.path });
            if let Some(state) = follow::state_now(t, view) {
                child["state"] = json!(state);
                if state == "working" || state == "blocked" {
                    child["worked"] = json!(true);
                }
            }
            if let Some(s) = view
                .sessions
                .iter()
                .find(|s| !s.stale && s.machine == t.machine && s.tmux.as_deref() == Some(&t.name))
            {
                if child["branch"] != s.branch.as_str() {
                    child["branch"] = json!(s.branch);
                    changed = true;
                }
            }
            changed |= (child["state"].clone(), child["worked"].clone()) != before;
            gathering.push(Gathering {
                child: i,
                machine: t.machine.clone(),
                name: t.name.clone(),
                live: child["state"] != "ended",
            });
        }
        let all_done = gathering.iter().all(|g| done(&group["children"][g.child]));
        let late = deadline(group).is_none_or(|d| at >= d);
        if !all_done && !late {
            continue;
        }
        let why = if all_done { "done" } else { "timeout" };
        group["status"] = json!("gathering");
        changed = true;
        due.push(Due {
            conversation: conversation.to_string(),
            group: text(group, "id").to_string(),
            why,
            children: gathering,
        });
    }
    (changed, due)
}

// A group cut short by a restart while it was being gathered is gathered again.
pub(super) fn resumed(events: &mut [Value]) {
    for e in events
        .iter_mut()
        .filter(|e| e["role"] == "group" && e["status"] == "gathering")
    {
        e["status"] = json!("running");
    }
}

// The group whose child a session is, while the group still gathers it, and that child's index.
fn child_of(events: &[Value], machine: &str, name: &str) -> Option<(usize, usize)> {
    let step = events.iter().find(|e| {
        e["role"] == "action"
            && e["group"].is_string()
            && e["result"]["session"]["machine"] == machine
            && e["result"]["session"]["name"] == name
    })?;
    let gi = events.iter().position(|e| {
        e["role"] == "group"
            && e["id"] == step["group"]
            && matches!(text(e, "status"), "waiting" | "running" | "gathering")
    })?;
    let ci = events[gi]["children"]
        .as_array()?
        .iter()
        .position(|c| c["step"] == step["id"])?;
    Some((gi, ci))
}

fn state_word(child: &Value) -> &'static str {
    match text(child, "state") {
        "blocked" => "needs input",
        "working" => "still working",
        "ended" => "ended",
        "idle" if done(child) => "finished",
        "idle" => "idle",
        _ => "unknown",
    }
}

fn told(card: &Value) -> String {
    let title = text(card, "title");
    let head = match text(card, "why") {
        "timeout" => format!(
            "The group \"{title}\" timed out after {} minutes, so Yardbell gathered what its \
children had.",
            card["minutes"]
        ),
        _ => format!("Every child of the group \"{title}\" is done."),
    };
    let children: Vec<String> = card["children"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, c)| {
            let label = text(c, "label");
            if c["started"] != true {
                return format!("{}) {label} did not start: {}.", i + 1, text(c, "note"));
            }
            let branch = match text(c, "branch") {
                "" => String::new(),
                b => format!(", branch {b}"),
            };
            let who = format!(
                "{}) {label} ({} on {}{branch}, {})",
                i + 1,
                text(c, "name"),
                text(c, "machine"),
                text(c, "state")
            );
            let r = &c["result"];
            if r.is_object() {
                let details: Vec<&str> = r["details"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let details = if details.is_empty() {
                    String::new()
                } else {
                    format!(" Details: {}", details.join("; "))
                };
                return format!(
                    "{who}: {}. {}{details}",
                    text(r, "status"),
                    text(r, "summary")
                );
            }
            let screen = follow::tail(text(c, "screen"), TOLD_LINES)
                .lines()
                .map(str::trim)
                .collect::<Vec<_>>()
                .join(" / ");
            match screen.as_str() {
                "" => format!("{who}: no result block."),
                screen => format!("{who}: no result block; its screen ends with: {screen}"),
            }
        })
        .collect();
    format!("{head} Results: {}", children.join(" "))
}

pub(super) fn untold(card: &mut Value) -> Option<String> {
    if card["told"] == true {
        return None;
    }
    card["told"] = json!(true);
    Some(told(card))
}

fn results(events: &[Value], group: &Value, due: &Due, screens: &[Option<String>]) -> Value {
    let children: Vec<Value> = group["children"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, c)| {
            let label = text(c, "label");
            if let Some(reason) = c["refused"].as_str() {
                return json!({ "label": label, "started": false, "note": format!("refused: {reason}") });
            }
            let gathered = due.children.iter().position(|g| g.child == i);
            let Some(at) = gathered else {
                let note = match c["step"].as_str().map(|s| start_of(events, s)) {
                    Some(Start::NotStarted(why)) => why,
                    _ => "it did not start".into(),
                };
                return json!({ "label": label, "started": false, "note": note });
            };
            let g = &due.children[at];
            let screen = screens
                .get(at)
                .cloned()
                .flatten()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| text(c, "screen").to_string());
            let outcome = parse(&screen)
                .map(|o| o.to_json())
                .or_else(|| c["result"].is_object().then(|| c["result"].clone()));
            let input = c["step"]
                .as_str()
                .and_then(|s| {
                    events
                        .iter()
                        .find(|e| e["role"] == "action" && e["id"] == s)
                })
                .map(|a| a["input"].clone())
                .unwrap_or_default();
            let branch = [
                outcome.as_ref().map_or("", |o| text(o, "branch")),
                text(c, "branch"),
                text(&input, "branch"),
            ]
            .into_iter()
            .find(|b| !b.is_empty())
            .unwrap_or_default();
            let mut child = json!({
                "label": label,
                "started": true,
                "machine": g.machine,
                "name": g.name,
                "path": c["session"]["path"],
                "branch": branch,
                "state": state_word(c),
                "screen": follow::tail(&screen, SCREEN_LINES),
            });
            if let Some(outcome) = outcome {
                child["result"] = outcome;
            }
            child
        })
        .collect();
    json!({
        "role": "results",
        "group": group["id"],
        "title": group["title"],
        "why": due.why,
        "minutes": group["minutes"],
        "gather": group["gather"],
        "follow": group["follow"] == true,
        "children": children,
        "at": now(),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Opened {
    pub group: String,
    pub steps: Vec<Option<String>>,
    pub follows: bool,
}

impl Dispatch {
    // Records the group as one card, and each child the rules let start, or ask about, as a step
    // of its own inside it. A child the rules refuse stays in the card with the reason.
    pub fn open_group(
        &self,
        id: &str,
        plan: &Plan,
        starts: &[ChildStart],
    ) -> Result<Opened, Refusal> {
        let at = now();
        let group_id = actions::new_id();
        let mut steps = Vec::new();
        let mut children = Vec::new();
        let mut events = Vec::new();
        for (child, start) in plan.children.iter().zip(starts) {
            let (status, rule) = match start {
                ChildStart::Refuse { reason, rule } => {
                    children.push(json!({
                        "label": child.label,
                        "input": child.input,
                        "refused": reason,
                        "rule": rule,
                    }));
                    steps.push(None);
                    continue;
                }
                ChildStart::Ask(rule) => ("pending", rule),
                ChildStart::Run(rule) => ("auto", rule),
            };
            let mut step = actions::event(
                "start_session",
                child.input.clone(),
                actions::By::Dispatch,
                None,
                status,
                &at,
            );
            step["group"] = json!(group_id);
            step["label"] = json!(child.label);
            if let Some(rule) = rule {
                step["rule"] = json!(rule);
            }
            if status == "auto" {
                step["told"] = json!(true);
            }
            let step_id = text(&step, "id").to_string();
            children.push(json!({ "label": child.label, "step": step_id }));
            steps.push(Some(step_id));
            events.push(step);
        }
        let group = json!({
            "role": "group",
            "id": group_id,
            "title": plan.title,
            "gather": plan.gather,
            "minutes": plan.minutes,
            "children": children,
            "status": "waiting",
            "by": "dispatch",
            "at": at,
        });
        // Only a group asked for in a message the person sent starts a turn of its own, so turns
        // Yardbell starts cannot keep starting more.
        let mut group = group;
        let follows = self.shared.edit(id, |s| {
            let chained = s
                .events
                .iter()
                .rev()
                .find(|e| e["role"] == "user")
                .is_some_and(|e| e["by"] == "yardbell");
            let follows = !plan.gather.is_empty() && !chained;
            group["follow"] = json!(follows);
            s.events.push(group.clone());
            s.events.extend(events.iter().cloned());
            Ok(follows)
        })?;
        for event in std::iter::once(&group).chain(&events) {
            self.shared.send_live(id, event);
        }
        Ok(Opened {
            group: group_id,
            steps,
            follows,
        })
    }

    // The input a child's step runs with: its task, with the result block asked for at the end.
    pub fn run_input(&self, id: &str, step: &str, mut input: Value) -> Value {
        let chats = self.shared.lock();
        let Some(events) = chats.get(id).map(|c| &c.stored.events) else {
            return input;
        };
        let group = events
            .iter()
            .find(|e| e["role"] == "action" && e["id"] == step)
            .and_then(|a| a["group"].as_str())
            .and_then(|g| events.iter().find(|e| e["role"] == "group" && e["id"] == g));
        if let Some(group) = group {
            let prompt = with_request(
                text(&input, "prompt"),
                text(group, "title"),
                text(group, "gather"),
            );
            if !prompt.is_empty() {
                input["prompt"] = json!(prompt);
            }
        }
        input
    }

    // The inputs of the step's siblings that still start or run, so an edit cannot put two
    // children in one checkout.
    pub fn siblings(&self, id: &str, step: &str) -> Option<Vec<Value>> {
        let chats = self.shared.lock();
        let events = &chats.get(id)?.stored.events;
        let group = events
            .iter()
            .find(|e| e["role"] == "action" && e["id"] == step)?
            .get("group")?
            .as_str()?
            .to_string();
        Some(
            events
                .iter()
                .filter(|e| {
                    e["role"] == "action" && e["group"] == group.as_str() && e["id"] != step
                })
                .filter(|e| {
                    matches!(
                        start_of(events, text(e, "id")),
                        Start::Undecided | Start::Starting | Start::Started(_)
                    )
                })
                .map(|e| e["input"].clone())
                .collect(),
        )
    }

    pub fn group_pending(&self, id: &str, group: &str) -> Result<Vec<String>, Refusal> {
        let chats = self.shared.lock();
        let events = &chats
            .get(id)
            .ok_or_else(|| missing("conversation"))?
            .stored
            .events;
        if !events
            .iter()
            .any(|e| e["role"] == "group" && e["id"] == group)
        {
            return Err(missing("group"));
        }
        Ok(actions::pending(events)
            .filter(|e| e["group"] == group)
            .filter_map(|e| e["id"].as_str().map(str::to_string))
            .collect())
    }

    pub fn due(&self, view: &StateView) -> Vec<Due> {
        self.due_at(view, Local::now())
    }

    pub fn due_at(&self, view: &StateView, at: DateTime<Local>) -> Vec<Due> {
        let mut found = Vec::new();
        let mut touched = Vec::new();
        {
            let mut chats = self.shared.lock();
            for c in chats.values_mut() {
                let (changed, due) = advance(&c.stored.id, &mut c.stored.events, view, at);
                if changed {
                    touched.push(c.stored.id.clone());
                }
                found.extend(due);
            }
        }
        for id in touched {
            self.shared.save(&id);
        }
        found
    }

    // Posts the Results card from the screens read for the due children, in their order. True
    // when Dispatch is to act on the results in a turn of its own.
    pub fn gathered(&self, due: &Due, screens: &[Option<String>]) -> bool {
        let card = self
            .shared
            .edit(&due.conversation, |s| {
                let gi = s
                    .events
                    .iter()
                    .position(|e| e["role"] == "group" && e["id"] == due.group.as_str())
                    .ok_or_else(|| missing("group"))?;
                if s.events[gi]["status"] != "gathering" {
                    return Err(Refusal::Taken("this group was already gathered".into()));
                }
                let card = results(&s.events, &s.events[gi], due, screens);
                s.events[gi]["status"] = json!("gathered");
                s.events[gi]["gathered"] = card["at"].clone();
                s.events.push(card.clone());
                Ok(card)
            })
            .ok();
        let Some(card) = card else {
            return false;
        };
        self.shared.send_live(&due.conversation, &card);
        card["follow"] == true
    }

    // A grouped child's report while its group runs: its screen is kept for the gather, and only
    // a question it asks becomes a session card. True when the report needs no card.
    pub(super) fn group_report(&self, change: &super::Change, screen: &str) -> bool {
        let card = {
            let mut chats = self.shared.lock();
            let Some(c) = chats.get_mut(&change.conversation) else {
                return false;
            };
            let Some((gi, ci)) = child_of(&c.stored.events, &change.machine, &change.name) else {
                return false;
            };
            let child = &mut c.stored.events[gi]["children"][ci];
            if !screen.trim().is_empty() {
                child["screen"] = json!(follow::tail(screen, SCREEN_LINES * 4));
                if let Some(outcome) = parse(screen) {
                    child["result"] = outcome.to_json();
                }
            }
            change.state == "blocked"
        };
        self.shared.save(&change.conversation);
        !card
    }

    // Starts one Dispatch turn with the gathered results when the group asked for one, unless
    // the conversation is answering or has steps waiting for the person, which a new turn would
    // withdraw. Then Dispatch hears the results with the next message instead.
    pub async fn follow_up(
        &self,
        id: &str,
        group: &str,
        port: u16,
        settings: &crate::config::DispatchSettings,
        extra: Option<&str>,
    ) -> Result<bool, String> {
        let (title, instruction) = {
            let chats = self.shared.lock();
            let c = chats.get(id).ok_or("no such conversation")?;
            let g = c
                .stored
                .events
                .iter()
                .find(|e| e["role"] == "group" && e["id"] == group)
                .ok_or("no such group")?;
            if g["follow"] != true || c.busy || actions::pending(&c.stored.events).next().is_some()
            {
                return Ok(false);
            }
            (text(g, "title").to_string(), text(g, "gather").to_string())
        };
        let note = format!(
            "Yardbell gathered the results of the group \"{title}\" and sent this message, the \
gather instruction you gave when you started the group; I did not type it. I may read it later, \
so say what you did and what waits for my approval."
        );
        let (_, mut rx) = self
            .follow_turn(id, &note, &instruction, port, settings, extra)
            .await?;
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::tests::{conversation, fake_claude};
    use crate::snapshot::Activity;
    use crate::state::{MachineView, SessionView};
    use std::path::Path;

    fn view(sessions: &[(&str, Activity)]) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines: vec![MachineView {
                name: "hp".into(),
                up: true,
                reason: None,
                last_seen: None,
                local: true,
                health: None,
                accounts: Vec::new(),
                mesh_on: None,
            }],
            folders: vec![],
            sessions: sessions
                .iter()
                .map(|(name, activity)| SessionView {
                    id: name.to_string(),
                    machine: "hp".into(),
                    agent: "claude".into(),
                    pid: 1,
                    folder: "app".into(),
                    ticket: "-".into(),
                    branch: format!("{name}-branch"),
                    activity: *activity,
                    attachable: true,
                    tmux: Some(name.to_string()),
                    stale: false,
                    ports: vec![],
                    pull: None,
                })
                .collect(),
            ended: vec![],
            host_terminal: crate::config::HostTerminal::None,
            mesh: None,
            server: None,
        }
    }

    fn three() -> Plan {
        plan(json!({
            "title": "Three ways to fix the redirect",
            "gather": "pick the smallest fix",
            "timeout_minutes": 30,
            "children": [
                { "label": "Guard", "machine": "hp", "folder": "app", "branch": "a", "new_branch": true, "prompt": "Fix it in the guard." },
                { "label": "Router", "machine": "hp", "folder": "app", "branch": "b", "new_branch": true, "prompt": "Fix it in the router." },
                { "label": "Pro", "machine": "pro", "folder": "app", "branch": "c", "prompt": "Fix it on pro." },
            ],
        }))
        .unwrap()
    }

    const REFUSED: &str = "the user's Dispatch rule \"deny start_session on pro\" refuses it";

    // Opens the group with Guard and Router waiting and Pro refused, then starts both as sessions.
    async fn started(dir: &Path) -> (Dispatch, String, String, Vec<String>) {
        let dispatch = fake_claude(dir, "true");
        let id = conversation(&dispatch, "try three ways").await;
        let starts = [
            ChildStart::Ask(None),
            ChildStart::Ask(None),
            ChildStart::Refuse {
                reason: REFUSED.into(),
                rule: None,
            },
        ];
        let opened = dispatch.open_group(&id, &three(), &starts).unwrap();
        assert!(opened.follows);
        let group = opened.group;
        assert_eq!(opened.steps[2], None);
        let steps: Vec<String> = opened.steps.into_iter().flatten().collect();
        assert_eq!(dispatch.group_pending(&id, &group).unwrap(), steps);
        assert_eq!(dispatch.list()[0]["waiting"], 2);
        assert!(dispatch.due_at(&view(&[]), Local::now()).is_empty());
        for (step, name) in steps.iter().zip(["hp-a", "hp-b"]) {
            dispatch.approve(&id, step, None).unwrap();
            assert!(
                dispatch.due_at(&view(&[]), Local::now()).is_empty(),
                "a child still starting holds the group"
            );
            dispatch
                .ran(
                    &id,
                    step,
                    &Ok(json!({ "machine": "hp", "name": name, "path": format!("/r/{name}") })),
                )
                .unwrap();
        }
        (dispatch, id, group, steps)
    }

    fn group_of(dispatch: &Dispatch, id: &str) -> Value {
        dispatch.get(id).unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["role"] == "group")
            .unwrap()
            .clone()
    }

    fn last(dispatch: &Dispatch, id: &str) -> Value {
        dispatch.get(id).unwrap()["events"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone()
    }

    const DONE: &str = "⏺ YARDBELL RESULT\n  status: done\n  summary: Guarded the redirect.\n  branch: a\n  - 12 tests pass\n  END RESULT";

    #[tokio::test]
    async fn a_group_is_one_card_with_its_children_as_steps() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = conversation(&dispatch, "try three ways").await;
        let starts = [
            ChildStart::Ask(None),
            ChildStart::Run(None),
            ChildStart::Refuse {
                reason: REFUSED.into(),
                rule: None,
            },
        ];
        let Opened { group, steps, .. } = dispatch.open_group(&id, &three(), &starts).unwrap();
        let card = group_of(&dispatch, &id);
        assert_eq!(
            (
                &card["id"],
                &card["status"],
                &card["minutes"],
                &card["gather"]
            ),
            (
                &json!(group),
                &json!("waiting"),
                &json!(30),
                &json!("pick the smallest fix")
            )
        );
        assert_eq!(
            card["children"][0],
            json!({ "label": "Guard", "step": steps[0] })
        );
        assert_eq!(card["children"][2]["refused"], REFUSED);
        assert_eq!(card["children"][2]["input"]["machine"], "pro");
        let ask = dispatch.step(&id, steps[0].as_deref().unwrap()).unwrap();
        assert_eq!(
            (&ask["status"], &ask["group"], &ask["label"], &ask["tool"]),
            (
                &json!("pending"),
                &json!(group),
                &json!("Guard"),
                &json!("start_session")
            )
        );
        let run = dispatch.step(&id, steps[1].as_deref().unwrap()).unwrap();
        assert_eq!(
            (&run["status"], &run["told"]),
            (&json!("auto"), &json!(true))
        );
        assert_eq!(
            dispatch.group_pending(&id, &group).unwrap(),
            [steps[0].clone().unwrap()]
        );
        assert_eq!(
            dispatch.group_pending(&id, "zzzzzzzz"),
            Err(Refusal::Missing("no such group".into()))
        );

        let input = dispatch.run_input(&id, steps[0].as_deref().unwrap(), ask["input"].clone());
        let prompt = input["prompt"].as_str().unwrap();
        assert!(
            prompt.starts_with("Fix it in the guard.\n\nThis session is one of several"),
            "{prompt}"
        );
        assert!(prompt.contains("group \"Three ways to fix the redirect\""));
        assert!(prompt.ends_with("The results will be used to: pick the smallest fix. Put what that needs in the summary and the detail lines."));
        assert_eq!(
            ask["input"]["prompt"], "Fix it in the guard.",
            "the card keeps the task as proposed"
        );
        let lone = json!({ "machine": "hp", "prompt": "x" });
        assert_eq!(dispatch.run_input(&id, "zzzzzzzz", lone.clone()), lone);

        let siblings = dispatch
            .siblings(&id, steps[0].as_deref().unwrap())
            .unwrap();
        assert_eq!(siblings.len(), 1, "the refused child is no sibling");
        assert_eq!(siblings[0]["branch"], "b");
        dispatch.reject(&id, steps[0].as_deref().unwrap()).unwrap();
        assert!(dispatch
            .siblings(&id, steps[1].as_deref().unwrap())
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_group_is_gathered_once_every_child_is_done() {
        let dir = tempfile::tempdir().unwrap();
        let (dispatch, id, group, _) = started(dir.path()).await;
        let t0 = Local::now();
        let working = view(&[("hp-a", Activity::Active), ("hp-b", Activity::Active)]);
        assert!(dispatch.due_at(&working, t0).is_empty());
        let card = group_of(&dispatch, &id);
        assert_eq!(card["status"], "running");
        assert_eq!(
            DateTime::parse_from_rfc3339(card["deadline"].as_str().unwrap()).unwrap(),
            t0 + chrono::Duration::minutes(30)
        );
        let one_done = view(&[("hp-a", Activity::Idle), ("hp-b", Activity::Active)]);
        assert!(dispatch.due_at(&one_done, t0).is_empty());
        let both = view(&[("hp-a", Activity::Idle)]);
        let due = dispatch.due_at(&both, t0);
        assert_eq!(due.len(), 1, "an ended child is done too");
        assert_eq!(
            (due[0].why, due[0].group.as_str()),
            ("done", group.as_str())
        );
        assert_eq!(
            due[0]
                .children
                .iter()
                .map(|g| (g.name.as_str(), g.live))
                .collect::<Vec<_>>(),
            [("hp-a", true), ("hp-b", false)]
        );
        assert!(dispatch.due_at(&both, t0).is_empty(), "it is gathered once");

        assert!(dispatch.gathered(&due[0], &[Some(DONE.into()), None]));
        assert!(
            !dispatch.gathered(&due[0], &[None, None]),
            "a second card is refused"
        );
        let results = last(&dispatch, &id);
        assert_eq!(
            (&results["role"], &results["why"], &results["group"]),
            (&json!("results"), &json!("done"), &json!(group))
        );
        let guard = &results["children"][0];
        assert_eq!(
            (
                &guard["name"],
                &guard["branch"],
                &guard["state"],
                &guard["result"]["summary"]
            ),
            (
                &json!("hp-a"),
                &json!("a"),
                &json!("finished"),
                &json!("Guarded the redirect.")
            )
        );
        let router = &results["children"][1];
        assert_eq!(
            (&router["state"], &router["branch"]),
            (&json!("ended"), &json!("hp-b-branch"))
        );
        assert!(router.get("result").is_none());
        assert_eq!(results["children"][2]["started"], false);
        assert_eq!(group_of(&dispatch, &id)["status"], "gathered");

        let mut events = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .clone();
        let news = actions::untold(&mut events);
        assert_eq!(
            news.last().unwrap(),
            &format!(
                "Every child of the group \"Three ways to fix the redirect\" is done. Results: \
1) Guard (hp-a on hp, branch a, finished): done. Guarded the redirect. Details: 12 tests pass \
2) Router (hp-b on hp, branch hp-b-branch, ended): no result block. \
3) Pro did not start: refused: {REFUSED}."
            )
        );
        assert!(actions::untold(&mut events).is_empty());
    }

    #[tokio::test]
    async fn a_child_that_waits_for_input_does_not_hold_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let (dispatch, id, _, _) = started(dir.path()).await;
        let t0 = Local::now();
        dispatch.due_at(
            &view(&[("hp-a", Activity::Active), ("hp-b", Activity::Active)]),
            t0,
        );
        let stuck = view(&[("hp-a", Activity::Idle), ("hp-b", Activity::Blocked)]);
        assert!(dispatch
            .due_at(&stuck, t0 + chrono::Duration::minutes(29))
            .is_empty());
        let card = group_of(&dispatch, &id);
        assert_eq!(card["children"][1]["state"], "blocked");
        let due = dispatch.due_at(&stuck, t0 + chrono::Duration::minutes(30));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].why, "timeout");
        assert!(due[0].children.iter().all(|g| g.live));
        let question = "Run the migration?\n ❯ 1. Yes\n   2. No";
        assert!(dispatch.gathered(&due[0], &[Some(DONE.into()), Some(question.into())]));
        let results = last(&dispatch, &id);
        assert_eq!(results["why"], "timeout");
        assert_eq!(results["children"][1]["state"], "needs input");
        assert!(results["children"][1]["screen"]
            .as_str()
            .unwrap()
            .ends_with("2. No"));
        let mut events = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .clone();
        let news = actions::untold(&mut events).pop().unwrap();
        assert!(
            news.starts_with(
                "The group \"Three ways to fix the redirect\" timed out after 30 minutes"
            ),
            "{news}"
        );
        assert!(news.contains("2) Router (hp-b on hp, branch hp-b-branch, needs input): no result block; its screen ends with: Run the migration? / ❯ 1. Yes / 2. No"), "{news}");
    }

    #[tokio::test]
    async fn a_child_that_is_idle_at_first_sight_is_not_done_yet() {
        let dir = tempfile::tempdir().unwrap();
        let (dispatch, id, _, _) = started(dir.path()).await;
        let t0 = Local::now();
        let idle = view(&[("hp-a", Activity::Idle), ("hp-b", Activity::Idle)]);
        assert!(
            dispatch.due_at(&idle, t0).is_empty(),
            "it has not worked yet"
        );
        assert_eq!(
            group_of(&dispatch, &id)["children"][0]["worked"],
            Value::Null
        );
    }

    #[tokio::test]
    async fn a_group_with_no_child_started_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = conversation(&dispatch, "try two ways").await;
        let mut two = three();
        two.children.pop();
        let steps = dispatch
            .open_group(&id, &two, &[ChildStart::Ask(None), ChildStart::Ask(None)])
            .unwrap()
            .steps;
        dispatch.reject(&id, steps[0].as_deref().unwrap()).unwrap();
        dispatch
            .approve(&id, steps[1].as_deref().unwrap(), None)
            .unwrap();
        dispatch
            .ran(
                &id,
                steps[1].as_deref().unwrap(),
                &Err("tmux: no server".into()),
            )
            .unwrap();
        assert!(dispatch.due_at(&view(&[]), Local::now()).is_empty());
        assert_eq!(group_of(&dispatch, &id)["status"], "dropped");
    }

    #[tokio::test]
    async fn a_group_carries_on_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (dispatch, id, group, steps) = started(dir.path()).await;
        let t0 = Local::now();
        dispatch.due_at(
            &view(&[("hp-a", Activity::Active), ("hp-b", Activity::Active)]),
            t0,
        );
        drop(dispatch);

        let reopened = fake_claude(dir.path(), "true");
        assert_eq!(group_of(&reopened, &id)["children"][0]["worked"], true);
        let quiet = view(&[("hp-a", Activity::Idle), ("hp-b", Activity::Blocked)]);
        assert!(reopened
            .due_at(&quiet, t0 + chrono::Duration::minutes(10))
            .is_empty());
        let due = reopened.due_at(&quiet, t0 + chrono::Duration::minutes(31));
        assert_eq!(due.len(), 1, "the deadline is kept");
        assert_eq!(due[0].why, "timeout");
        drop(reopened);

        let again = fake_claude(dir.path(), "true");
        assert_eq!(
            group_of(&again, &id)["status"],
            "running",
            "a cut-short gather runs again"
        );
        let due = again.due_at(&quiet, t0 + chrono::Duration::minutes(31));
        assert_eq!(due.len(), 1);
        assert!(again.gathered(&due[0], &[None, None]));
        assert_eq!(group_of(&again, &id)["status"], "gathered");
        assert_eq!(last(&again, &id)["group"], json!(group));
        assert!(again.step(&id, &steps[0]).unwrap()["result"]["ok"] == true);
    }

    #[tokio::test]
    async fn a_child_starting_when_yardbell_restarted_is_marked_failed() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = conversation(&dispatch, "try two ways").await;
        let mut two = three();
        two.children.pop();
        let steps = dispatch
            .open_group(&id, &two, &[ChildStart::Run(None), ChildStart::Ask(None)])
            .unwrap()
            .steps;
        drop(dispatch);
        let reopened = fake_claude(dir.path(), "true");
        let step = reopened.step(&id, steps[0].as_deref().unwrap()).unwrap();
        assert_eq!(step["result"]["ok"], false);
    }

    #[tokio::test]
    async fn a_gather_instruction_starts_one_turn_unless_steps_wait() {
        let dir = tempfile::tempdir().unwrap();
        let (dispatch, id, group, _) = started(dir.path()).await;
        let args = dir.path().join("args");
        let dispatch = dispatch.with_command(vec![
            "sh".into(),
            "-c".into(),
            format!(r#"printf '%s\n' "$@" > {}"#, args.display()),
            "claude".into(),
        ]);
        let t0 = Local::now();
        dispatch.due_at(
            &view(&[("hp-a", Activity::Active), ("hp-b", Activity::Active)]),
            t0,
        );
        let due = dispatch.due_at(
            &view(&[("hp-a", Activity::Idle), ("hp-b", Activity::Idle)]),
            t0,
        );
        assert!(dispatch.gathered(&due[0], &[Some(DONE.into()), None]));
        let settings = crate::config::DispatchSettings::default();
        let waiting = dispatch
            .propose(
                &id,
                "stop_session",
                json!({ "machine": "hp", "name": "hp-old" }),
                actions::By::Dispatch,
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            dispatch.follow_up(&id, &group, 4000, &settings, None).await,
            Ok(false),
            "a turn would withdraw the step that waits"
        );
        dispatch
            .reject(&id, waiting["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            dispatch.follow_up(&id, &group, 4000, &settings, None).await,
            Ok(true)
        );
        for _ in 0..100 {
            if !dispatch.get(&id).unwrap()["busy"].as_bool().unwrap() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let sent = std::fs::read_to_string(&args).unwrap();
        assert!(
            sent.starts_with(
                "-p\nYardbell gathered the results of the group \"Three ways to fix the redirect\""
            ),
            "{sent}"
        );
        assert!(
            sent.contains("Every child of the group"),
            "the results come as news: {sent}"
        );
        assert!(
            sent.contains("My message:\npick the smallest fix\n"),
            "{sent}"
        );
        let message = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|e| e["role"] == "user")
            .unwrap()
            .clone();
        assert_eq!(
            message,
            json!({ "role": "user", "text": "pick the smallest fix", "by": "yardbell" })
        );
        let mut again = three();
        again.children.pop();
        let chained = dispatch
            .open_group(&id, &again, &[ChildStart::Ask(None), ChildStart::Ask(None)])
            .unwrap();
        assert!(
            !chained.follows,
            "a group a follow-up started does not start another turn"
        );
    }

    #[tokio::test]
    async fn a_grouped_child_keeps_its_screen_and_only_asks_with_a_card() {
        let dir = tempfile::tempdir().unwrap();
        let (dispatch, id, _, _) = started(dir.path()).await;
        let working = view(&[("hp-a", Activity::Active), ("hp-b", Activity::Active)]);
        dispatch.observe(&working);
        dispatch.due_at(&working, Local::now());
        let before = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .len();
        let changes = dispatch.observe(&view(&[
            ("hp-a", Activity::Idle),
            ("hp-b", Activity::Blocked),
        ]));
        assert_eq!(changes.len(), 2);
        for change in &changes {
            let screen = if change.name == "hp-a" {
                DONE
            } else {
                "Proceed?\n ❯ 1. Yes"
            };
            dispatch.report(change, screen);
        }
        let events = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(events.len(), before + 1, "only the question is a card");
        assert_eq!(
            (&events[before]["role"], &events[before]["name"]),
            (&json!("session"), &json!("hp-b"))
        );
        let card = group_of(&dispatch, &id);
        assert_eq!(card["children"][0]["result"]["status"], "done");
        assert!(card["children"][0]["screen"]
            .as_str()
            .unwrap()
            .contains("END RESULT"));
    }

    #[test]
    fn a_plan_takes_labels_out_and_checks_its_shape() {
        let p = plan(json!({
            "title": "Three ways to fix the login redirect",
            "children": [
                { "label": " Patch ", "machine": "hp", "folder": "app", "branch": "a", "prompt": "x", "read_only": true },
                { "machine": "hp", "folder": "app", "branch": "b" },
            ],
            "gather": " pick one ",
        }))
        .unwrap();
        assert_eq!(p.title, "Three ways to fix the login redirect");
        assert_eq!(p.minutes, DEFAULT_MINUTES);
        assert_eq!(p.gather, "pick one");
        assert_eq!(p.children[0].label, "Patch");
        assert_eq!(p.children[1].label, "Child 2");
        assert_eq!(
            p.children[0].input,
            json!({ "machine": "hp", "folder": "app", "branch": "a", "prompt": "x" }),
            "the label and read_only are not start_session's to see"
        );
        let untitled = plan(json!({ "children": [{ "machine": "hp" }, { "machine": "pro" }] }));
        assert_eq!(untitled.unwrap().title, "2 sessions");

        let child = json!({ "machine": "hp" });
        let cases = [
            (
                json!({ "children": [child] }),
                "a group has 2 to 6 children, this one has 1; for one session use start_session",
            ),
            (
                json!({ "children": vec![child.clone(); 7] }),
                "a group has 2 to 6 children, this one has 7; for one session use start_session",
            ),
            (
                json!({ "children": [child, child], "timeout_minutes": 0 }),
                "timeout_minutes must be between 1 and 1440",
            ),
            (
                json!({ "children": [child, child], "timeout_minutes": 1441 }),
                "timeout_minutes must be between 1 and 1440",
            ),
            (
                json!({ "children": [child, "hp"] }),
                "child 2 must be an object with machine, folder and prompt",
            ),
            (
                json!({ "children": [{ "machine": "hp", "label": 3 }, child] }),
                "child 1: label must be text",
            ),
            (
                json!({ "children": [{ "machine": "hp", "label": "a\nb" }, child] }),
                "child 1: label must be one line of at most 60 characters",
            ),
            (
                json!({ "children": [{ "machine": "hp", "label": "Fast" }, { "machine": "hp", "label": "fast" }] }),
                "children 1 and 2 are both labelled \"fast\", give each its own label",
            ),
            (
                json!({ "children": [child, child], "gather": "x".repeat(2001) }),
                "gather is longer than 2000 characters",
            ),
        ];
        for (args, message) in cases {
            assert_eq!(plan(args).unwrap_err(), message);
        }
    }

    fn place(machine: &str, repo: &str, branch: &str) -> Place {
        Place {
            machine: machine.into(),
            repo: repo.into(),
            branch: branch.into(),
        }
    }

    #[test]
    fn two_children_on_one_branch_of_one_checkout_clash() {
        assert_eq!(
            clash(&[
                place("hp", "app", "a"),
                place("hp", "app", "b"),
                place("pro", "app", "a"),
                place("hp", "api", "a"),
            ]),
            None
        );
        let places = [
            place("hp", "app", "a"),
            place("hp", "app", ""),
            place("hp", "app", ""),
        ];
        assert_eq!(clash(&places), Some((1, 2)));
        assert_eq!(
            clash_message(&places, (1, 2)),
            "children 2 and 3 would both work in app on hp on its current branch, give each its own branch"
        );
        let named = [place("hp", "/r/app", "x"), place("hp", "/r/app", "x")];
        assert_eq!(
            clash_message(&named, clash(&named).unwrap()),
            "children 1 and 2 would both work in /r/app on hp on branch x, give each its own branch"
        );
    }

    #[test]
    fn each_task_asks_for_a_result_block() {
        assert_eq!(with_request("", "t", ""), "");
        let asked = with_request("Fix the redirect.", "Three ways", "pick the smallest fix");
        assert!(asked.starts_with("Fix the redirect.\n\nThis session is one of several"));
        assert!(asked.contains("group \"Three ways\""));
        assert!(asked.contains(&format!("{START}\nstatus: done, partial, or failed\n")));
        assert!(asked.ends_with("The results will be used to: pick the smallest fix. Put what that needs in the summary and the detail lines."));
        assert_eq!(parse(&asked), None, "the request itself is not a result");
    }

    #[test]
    fn the_last_result_block_is_read_from_the_screen() {
        let screen = "⏺ Bash(cargo test)\n  ⎿  ok\n\n⏺ YARDBELL RESULT\n  status: done\n  summary: Moved the redirect into the guard, so the\n  loop is gone.\n  branch: `eng-1-guard`\n  - 41 tests pass\n  - Touches the session\n    middleware too\n  END RESULT\n\n╭──────╮\n│ >    │\n╰──────╯";
        assert_eq!(
            parse(screen),
            Some(Outcome {
                status: "done",
                summary: "Moved the redirect into the guard, so the loop is gone.".into(),
                branch: "eng-1-guard".into(),
                details: vec![
                    "41 tests pass".into(),
                    "Touches the session middleware too".into()
                ],
            })
        );
        let two = "YARDBELL RESULT\nstatus: failed\nsummary: old\nEND RESULT\n**YARDBELL RESULT**\n**status:** partial\nsummary: new\nEND RESULT";
        let last = parse(two).unwrap();
        assert_eq!((last.status, last.summary.as_str()), ("partial", "new"));
        assert_eq!(
            parse("YARDBELL RESULT\nstatus: done\nsummary: still writ"),
            None
        );
        assert_eq!(parse("YARDBELL RESULT\nstatus: maybe\nEND RESULT"), None);
        assert_eq!(parse("no block here"), None);
    }
}
