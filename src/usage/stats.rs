use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};

use chrono::{DateTime, Local, NaiveDate, TimeDelta};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const VERSION: u32 = 1;
const RECENT_SESSIONS: usize = 12;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    pub fn parse(text: &str) -> Option<Option<Provider>> {
        match text {
            "" | "all" => Some(None),
            "claude" => Some(Some(Provider::Claude)),
            "codex" => Some(Some(Provider::Codex)),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Turn {
    #[serde(rename = "k")]
    key: String,
    #[serde(rename = "t")]
    at: i64,
    #[serde(rename = "m", default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(rename = "i")]
    input: u64,
    #[serde(rename = "o")]
    output: u64,
    #[serde(rename = "r")]
    cache_read: u64,
    #[serde(rename = "w")]
    cache_write: u64,
}

impl Turn {
    fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct CodexState {
    model: Option<String>,
    turn: Option<String>,
    totals: Option<[u64; 5]>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    provider: Provider,
    size: u64,
    mtime: i64,
    offset: u64,
    session: Option<String>,
    cwd: Option<String>,
    turns: Vec<Turn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex: Option<CodexState>,
}

impl Entry {
    fn new(provider: Provider) -> Entry {
        Entry {
            provider,
            size: 0,
            mtime: 0,
            offset: 0,
            session: None,
            cwd: None,
            turns: Vec::new(),
            codex: (provider == Provider::Codex).then(CodexState::default),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    version: u32,
    files: HashMap<String, Entry>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Scanned {
    pub files: usize,
    pub read: usize,
}

// Token use from the transcripts Claude Code and Codex keep on this machine. What each file held is
// kept in Yardbell's state folder with the file's size and time, so a later look reads only the
// files that changed, and only what was appended to them.
pub struct Stats {
    claude_dir: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    cache_path: PathBuf,
    cache: Mutex<Option<Cache>>,
}

impl Stats {
    pub fn new(
        claude_dir: Option<PathBuf>,
        codex_home: Option<PathBuf>,
        cache_path: PathBuf,
    ) -> Stats {
        Stats {
            claude_dir,
            codex_home,
            cache_path,
            cache: Mutex::new(None),
        }
    }

    fn transcripts(&self) -> Vec<(Provider, PathBuf)> {
        let mut found = Vec::new();
        if let Some(dir) = &self.claude_dir {
            walk(&dir.join("projects"), &mut |path| {
                if path.extension().is_some_and(|e| e == "jsonl") {
                    found.push((Provider::Claude, path.to_path_buf()));
                }
            });
        }
        if let Some(home) = &self.codex_home {
            for sub in ["sessions", "archived_sessions"] {
                walk(&home.join(sub), &mut |path| {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        found.push((Provider::Codex, path.to_path_buf()));
                    }
                });
            }
        }
        found
    }

    fn load(&self) -> Cache {
        std::fs::read(&self.cache_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Cache>(&bytes).ok())
            .filter(|cache| cache.version == VERSION)
            .unwrap_or(Cache {
                version: VERSION,
                files: HashMap::new(),
            })
    }

    fn scan(&self, cache: &mut Cache) -> Scanned {
        let found = self.transcripts();
        let mut work: Vec<(String, PathBuf, Entry, u64, i64)> = Vec::new();
        let mut keep: HashSet<String> = HashSet::new();
        for (provider, path) in &found {
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            let key = path.to_string_lossy().into_owned();
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as i64)
                .unwrap_or(0);
            keep.insert(key.clone());
            let entry = match cache.files.get(&key) {
                Some(e) if e.provider == *provider && e.size == size && e.mtime == mtime => {
                    continue
                }
                // Transcripts are only ever appended to, so a longer file is read from where the
                // last look stopped.
                Some(e) if e.provider == *provider && size > e.size => e.clone(),
                _ => Entry::new(*provider),
            };
            work.push((key, path.clone(), entry, size, mtime));
        }
        let read = work.len();
        let before = cache.files.len();
        cache.files.retain(|key, _| keep.contains(key));
        let removed = before != cache.files.len();
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(1, 4);
        // The biggest files go first, each to whichever thread is free, since a few long
        // transcripts in one folder hold most of the bytes.
        work.sort_by_key(|(_, _, entry, size, _)| size.saturating_sub(entry.offset));
        let queue = Mutex::new(work);
        let done: Vec<(String, Entry)> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|_| {
                    scope.spawn(|| {
                        let mut out = Vec::new();
                        loop {
                            let next = queue.lock().expect("scan queue").pop();
                            let Some((key, path, mut entry, size, mtime)) = next else {
                                break;
                            };
                            read_from(&path, &mut entry);
                            entry.size = size;
                            entry.mtime = mtime;
                            out.push((key, entry));
                        }
                        out
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        });
        cache.files.extend(done);
        if read > 0 || removed {
            match serde_json::to_vec(&cache) {
                Ok(bytes) => {
                    if let Err(e) = crate::dispatch::write_private(&self.cache_path, &bytes) {
                        tracing::warn!(error = %e, "could not save the usage stats cache");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "could not save the usage stats cache"),
            }
        }
        Scanned {
            files: found.len(),
            read,
        }
    }

    // Reads what changed since the last look, then sums the last `days` days (today included).
    pub fn report(&self, only: Option<Provider>, days: u32, now: DateTime<Local>) -> Value {
        let started = Instant::now();
        let mut guard = self.cache.lock().expect("stats lock");
        let cache = guard.get_or_insert_with(|| self.load());
        let scanned = self.scan(cache);
        let mut out = summarize(cache, only, days.clamp(1, 365), now);
        out["scan"] = json!({
            "files": scanned.files,
            "read": scanned.read,
            "ms": started.elapsed().as_millis() as u64,
        });
        out
    }
}

fn walk(dir: &Path, found: &mut dyn FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, found);
        } else if kind.is_file() {
            found(&path);
        }
    }
}

fn read_from(path: &Path, entry: &mut Entry) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(entry.offset)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return;
    }
    // A last line still being written is left for the next look.
    let Some(end) = bytes.iter().rposition(|b| *b == b'\n').map(|at| at + 1) else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes[..end]);
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    for line in text.split('\n') {
        let turn = match entry.provider {
            Provider::Claude => claude_turn(line, entry),
            Provider::Codex => codex_turn(line, entry),
        };
        entry.turns.extend(turn);
    }
    if entry.session.is_none() {
        entry.session = Some(match entry.provider {
            Provider::Codex => fallback
                .rsplit('-')
                .take(5)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("-"),
            Provider::Claude => fallback,
        });
    }
    entry.offset += end as u64;
}

#[derive(Deserialize)]
struct ClaudeRecord {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    timestamp: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    uuid: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize, Default)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    iterations: Option<Vec<ClaudeUsage>>,
}

impl ClaudeUsage {
    fn parts(&self) -> [u64; 4] {
        [
            self.input_tokens,
            self.output_tokens,
            self.cache_read_input_tokens,
            self.cache_creation_input_tokens,
        ]
    }
}

fn stamp(text: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text?)
        .ok()
        .map(|t| t.timestamp())
}

// Claude Code writes one line per content block of a reply, each with the reply's usage, so a
// reply is known by its message and request ids.
fn claude_turn(line: &str, entry: &mut Entry) -> Option<Turn> {
    if !line.contains("\"assistant\"") || !line.contains("\"usage\"") {
        return None;
    }
    let record: ClaudeRecord = serde_json::from_str(line).ok()?;
    if record.kind.as_deref() != Some("assistant") {
        return None;
    }
    if entry.session.is_none() {
        entry.session = record.session_id.clone();
    }
    if entry.cwd.is_none() {
        entry.cwd = record.cwd.clone();
    }
    let message = record.message?;
    let usage = message.usage.unwrap_or_default();
    let mut parts = usage.parts();
    // Some replies leave the top-level figures at zero and put them in `iterations`.
    if parts.iter().all(|n| *n == 0) {
        for part in usage.iterations.iter().flatten() {
            for (sum, n) in parts.iter_mut().zip(part.parts()) {
                *sum += n;
            }
        }
    }
    if parts.iter().all(|n| *n == 0) {
        return None;
    }
    let at = stamp(record.timestamp.as_deref())?;
    let key = match (&message.id, &record.request_id, &record.uuid) {
        (Some(id), Some(request), _) => format!("{id}:{request}"),
        (Some(id), None, _) => format!("msg:{id}"),
        (None, _, Some(uuid)) => format!("uuid:{uuid}"),
        _ => format!("at:{at}:{parts:?}"),
    };
    Some(Turn {
        key,
        at,
        model: message.model.filter(|m| !m.starts_with('<')),
        input: parts[0],
        output: parts[1],
        cache_read: parts[2],
        cache_write: parts[3],
    })
}

#[derive(Deserialize)]
struct CodexRecord {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<Value>,
}

fn codex_totals(usage: &Value) -> Option<[u64; 5]> {
    if !usage.is_object() {
        return None;
    }
    let n = |key: &str| usage[key].as_u64().unwrap_or(0);
    let input = n("input_tokens");
    let cached = usage["cached_input_tokens"]
        .as_u64()
        .or(usage["cache_read_input_tokens"].as_u64())
        .unwrap_or(0);
    let output = n("output_tokens");
    let total = match n("total_tokens") {
        0 => input + output,
        t => t,
    };
    Some([input, cached, output, n("reasoning_output_tokens"), total])
}

// Codex writes a running total with each turn's own use; the turn's figure is counted, and a total
// that did not change is the same turn reported again.
fn codex_turn(line: &str, entry: &mut Entry) -> Option<Turn> {
    if !(line.contains("token_count")
        || line.contains("\"turn_context\"")
        || line.contains("\"session_meta\""))
    {
        return None;
    }
    let record: CodexRecord = serde_json::from_str(line).ok()?;
    let payload = record.payload?;
    let state = entry.codex.get_or_insert_with(CodexState::default);
    match record.kind.as_deref() {
        Some("session_meta") => {
            entry.session = payload["id"]
                .as_str()
                .map(str::to_string)
                .or(entry.session.take());
            if let Some(cwd) = payload["cwd"].as_str() {
                entry.cwd = Some(cwd.to_string());
            }
            None
        }
        Some("turn_context") => {
            state.turn = payload["turn_id"].as_str().map(str::to_string);
            if let Some(model) = payload["model"].as_str() {
                state.model = Some(model.to_string());
            }
            if entry.cwd.is_none() {
                entry.cwd = payload["cwd"].as_str().map(str::to_string);
            }
            None
        }
        Some("event_msg") if payload["type"] == "token_count" => {
            let info = &payload["info"];
            let total = codex_totals(&info["total_token_usage"]);
            let last = codex_totals(&info["last_token_usage"]);
            if total.is_some() && total == state.totals {
                return None;
            }
            let delta = match (total, last, state.totals) {
                (_, Some(last), _) => last,
                (Some(total), None, Some(before))
                    if total.iter().zip(before).all(|(a, b)| *a >= b) =>
                {
                    let mut d = [0; 5];
                    for (i, slot) in d.iter_mut().enumerate() {
                        *slot = total[i] - before[i];
                    }
                    d
                }
                (Some(total), None, None) => total,
                // A total that went down was rewritten by a compaction or resume, so it is
                // the new starting point.
                _ => {
                    if total.is_some() {
                        state.totals = total;
                    }
                    return None;
                }
            };
            state.totals = match (total, state.totals) {
                (Some(total), _) => Some(total),
                (None, Some(before)) => Some(std::array::from_fn(|i| before[i] + delta[i])),
                (None, None) => None,
            };
            let at = stamp(record.timestamp.as_deref())?;
            let [input, cached, output, _, total_tokens] = delta;
            if total_tokens == 0 && input == 0 && output == 0 {
                return None;
            }
            let cached = cached.min(input);
            let who = state
                .turn
                .clone()
                .unwrap_or_else(|| record.timestamp.clone().unwrap_or_default());
            Some(Turn {
                key: format!("{who}|{total:?}|{last:?}"),
                at,
                model: info["model"]
                    .as_str()
                    .map(str::to_string)
                    .or(state.model.clone()),
                input: input - cached,
                output,
                cache_read: cached,
                cache_write: 0,
            })
        }
        _ => None,
    }
}

#[derive(Default)]
struct Sums {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    turns: u64,
}

impl Sums {
    fn add(&mut self, t: &Turn) {
        self.input += t.input;
        self.output += t.output;
        self.cache_read += t.cache_read;
        self.cache_write += t.cache_write;
        self.turns += 1;
    }

    fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    fn json(&self) -> Value {
        json!({
            "tokens": self.tokens(),
            "input": self.input,
            "output": self.output,
            "cache_read": self.cache_read,
            "cache_write": self.cache_write,
            "turns": self.turns,
        })
    }
}

struct Seen<'a> {
    provider: Provider,
    session: &'a str,
    cwd: Option<&'a str>,
    turn: Turn,
}

fn local_day(at: i64) -> Option<NaiveDate> {
    DateTime::from_timestamp(at, 0).map(|t| t.with_timezone(&Local).date_naive())
}

fn folder_name(cwd: Option<&str>) -> String {
    cwd.and_then(|c| Path::new(c).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Unknown folder".into())
}

fn summarize(cache: &Cache, only: Option<Provider>, days: u32, now: DateTime<Local>) -> Value {
    let today = now.date_naive();
    let first = today - TimeDelta::days(i64::from(days) - 1);
    let since = first
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(Local).earliest())
        .map(|t| t.timestamp())
        .unwrap_or(0);
    let mut agents: BTreeMap<&str, bool> = BTreeMap::from([("claude", false), ("codex", false)]);
    let mut rows: Vec<Seen> = Vec::new();
    let mut index: HashMap<(Provider, &str), usize> = HashMap::new();
    let mut entries: Vec<&Entry> = cache.files.values().collect();
    entries.sort_by_key(|e| (e.provider.id(), e.session.as_deref()));
    for entry in entries {
        if !entry.turns.is_empty() {
            agents.insert(entry.provider.id(), true);
        }
        if only.is_some_and(|p| p != entry.provider) {
            continue;
        }
        for turn in entry.turns.iter().filter(|t| t.at >= since) {
            if let Some(&at) = index.get(&(entry.provider, turn.key.as_str())) {
                let kept = &mut rows[at].turn;
                kept.input = kept.input.max(turn.input);
                kept.output = kept.output.max(turn.output);
                kept.cache_read = kept.cache_read.max(turn.cache_read);
                kept.cache_write = kept.cache_write.max(turn.cache_write);
                continue;
            }
            index.insert((entry.provider, turn.key.as_str()), rows.len());
            rows.push(Seen {
                provider: entry.provider,
                session: entry.session.as_deref().unwrap_or(""),
                cwd: entry.cwd.as_deref(),
                turn: turn.clone(),
            });
        }
    }

    struct Day<'a> {
        sums: Sums,
        sessions: HashSet<(Provider, &'a str)>,
    }
    struct Session<'a> {
        provider: Provider,
        id: &'a str,
        cwd: Option<&'a str>,
        first: i64,
        last: i64,
        sums: Sums,
        models: HashMap<String, u64>,
    }
    let mut daily: BTreeMap<NaiveDate, Day> = BTreeMap::new();
    let mut day = first;
    while day <= today {
        daily.insert(
            day,
            Day {
                sums: Sums::default(),
                sessions: HashSet::new(),
            },
        );
        day += TimeDelta::days(1);
    }
    let mut totals = Sums::default();
    let mut models: HashMap<(Provider, String), Sums> = HashMap::new();
    let mut sessions: HashMap<(Provider, &str), Session> = HashMap::new();
    for row in &rows {
        let t = &row.turn;
        let Some(on) = local_day(t.at) else { continue };
        let Some(bucket) = daily.get_mut(&on) else {
            continue;
        };
        bucket.sums.add(t);
        bucket.sessions.insert((row.provider, row.session));
        totals.add(t);
        let model = t.model.clone().unwrap_or_else(|| "Unknown model".into());
        models
            .entry((row.provider, model.clone()))
            .or_default()
            .add(t);
        let s = sessions
            .entry((row.provider, row.session))
            .or_insert_with(|| Session {
                provider: row.provider,
                id: row.session,
                cwd: row.cwd,
                first: t.at,
                last: t.at,
                sums: Sums::default(),
                models: HashMap::new(),
            });
        s.first = s.first.min(t.at);
        s.last = s.last.max(t.at);
        s.cwd = s.cwd.or(row.cwd);
        s.sums.add(t);
        *s.models.entry(model).or_default() += t.tokens();
    }

    let active_days = daily.values().filter(|d| d.sums.turns > 0).count();
    let all_tokens = totals.tokens().max(1) as f64;
    let mut models: Vec<Value> = models
        .into_iter()
        .map(|((provider, model), sums)| {
            json!({
                "provider": provider.id(),
                "model": model,
                "tokens": sums.tokens(),
                "turns": sums.turns,
                "share": sums.tokens() as f64 / all_tokens,
            })
        })
        .collect();
    models.sort_by(|a, b| {
        b["tokens"]
            .as_u64()
            .cmp(&a["tokens"].as_u64())
            .then_with(|| a["model"].as_str().cmp(&b["model"].as_str()))
    });
    let session_count = sessions.len();
    let mut recent: Vec<Session> = sessions.into_values().collect();
    recent.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.id.cmp(b.id)));
    let recent: Vec<Value> = recent
        .into_iter()
        .take(RECENT_SESSIONS)
        .map(|s| {
            let model = s
                .models
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
                .map(|(m, _)| m.clone());
            json!({
                "provider": s.provider.id(),
                "id": s.id,
                "project": folder_name(s.cwd),
                "folder": s.cwd,
                "model": model,
                "tokens": s.sums.tokens(),
                "turns": s.sums.turns,
                "started": s.first,
                "ended": s.last,
                "duration": s.last - s.first,
            })
        })
        .collect();
    let mut totals_json = totals.json();
    totals_json["sessions"] = json!(session_count);
    totals_json["active_days"] = json!(active_days);
    json!({
        "provider": only.map(Provider::id).unwrap_or("all"),
        "days": days,
        "from": first.to_string(),
        "to": today.to_string(),
        "totals": totals_json,
        "daily": daily.iter().map(|(day, d)| {
            let mut out = d.sums.json();
            out["day"] = json!(day.to_string());
            out["sessions"] = json!(d.sessions.len());
            out
        }).collect::<Vec<_>>(),
        "models": models,
        "sessions": recent,
        "agents": agents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, 12, 18, 0, 0).unwrap()
    }

    fn stamp_of(day: u32, hour: u32) -> String {
        Local
            .with_ymd_and_hms(2026, 11, day, hour, 0, 0)
            .unwrap()
            .to_rfc3339()
    }

    fn assistant(id: &str, request: &str, at: &str, model: &str, usage: Value) -> String {
        json!({
            "type": "assistant", "sessionId": "sess-a", "cwd": "/work/demo-app", "timestamp": at,
            "requestId": request, "uuid": format!("u-{id}"),
            "message": {"id": id, "model": model, "role": "assistant", "usage": usage, "content": [{"type": "text", "text": "assistant usage"}]}
        })
        .to_string()
    }

    fn write(path: &Path, lines: &[String]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    fn append(path: &Path, lines: &[String]) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all((lines.join("\n") + "\n").as_bytes()).unwrap();
    }

    fn claude_fixture(dir: &Path) -> PathBuf {
        let file = dir.join("claude/projects/-work-demo-app/sess-a.jsonl");
        write(
            &file,
            &[
                json!({"type": "user", "sessionId": "sess-a", "message": {"role": "user", "content": "hi"}}).to_string(),
                assistant("m1", "r1", &stamp_of(11, 9), "claude-opus-5-5", json!({"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20})),
                assistant("m1", "r1", &stamp_of(11, 9), "claude-opus-5-5", json!({"input_tokens": 10, "output_tokens": 50, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20})),
                assistant("m2", "r2", &stamp_of(12, 10), "claude-opus-5-5", json!({"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "iterations": [{"input_tokens": 2, "output_tokens": 8, "cache_read_input_tokens": 90, "cache_creation_input_tokens": 0}]})),
                assistant("m3", "r3", &stamp_of(12, 11), "<synthetic>", json!({"input_tokens": 0, "output_tokens": 0})),
                "not json".into(),
            ],
        );
        let sub = dir.join("claude/projects/-work-demo-app/sess-a/subagents/agent-1.jsonl");
        write(
            &sub,
            &[assistant(
                "m9",
                "r9",
                &stamp_of(1, 9),
                "claude-haiku-4-5",
                json!({"input_tokens": 1, "output_tokens": 1}),
            )],
        );
        file
    }

    fn codex_fixture(dir: &Path) -> PathBuf {
        let file = dir.join("codex/sessions/2026/11/12/rollout-2026-11-12T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl");
        let count = |at: &str, total: [u64; 3], last: Option<[u64; 3]>| {
            let usage = |u: [u64; 3]| json!({"input_tokens": u[0], "cached_input_tokens": u[1], "output_tokens": u[2], "reasoning_output_tokens": 0, "total_tokens": u[0] + u[2]});
            json!({"timestamp": at, "type": "event_msg", "payload": {"type": "token_count",
                "info": {"total_token_usage": usage(total), "last_token_usage": last.map(usage)},
                "rate_limits": {"primary": {"used_percent": 4.0, "window_minutes": 300}}}})
            .to_string()
        };
        write(
            &file,
            &[
                json!({"timestamp": stamp_of(12, 10), "type": "session_meta", "payload": {"id": "0199aaaa-bbbb-cccc-dddd-eeeeffff0000", "cwd": "/work/demo-api", "base_instructions": {"text": "long"}}}).to_string(),
                json!({"timestamp": stamp_of(12, 10), "type": "turn_context", "payload": {"turn_id": "t1", "cwd": "/work/demo-api", "model": "gpt-6.1-sol"}}).to_string(),
                count(&stamp_of(12, 10), [1000, 200, 50], Some([1000, 200, 50])),
                count(&stamp_of(12, 10), [1000, 200, 50], Some([1000, 200, 50])),
                json!({"timestamp": stamp_of(12, 11), "type": "event_msg", "payload": {"type": "token_count", "info": null, "rate_limits": {}}}).to_string(),
                json!({"timestamp": stamp_of(12, 11), "type": "turn_context", "payload": {"turn_id": "t2", "model": "gpt-6.1-sol"}}).to_string(),
                count(&stamp_of(12, 11), [1600, 500, 80], None),
            ],
        );
        file
    }

    fn stats(dir: &Path) -> Stats {
        Stats::new(
            Some(dir.join("claude")),
            Some(dir.join("codex")),
            dir.join("state/usage-stats.json"),
        )
    }

    #[test]
    fn claude_replies_are_counted_once_with_their_largest_figures() {
        let dir = tempfile::tempdir().unwrap();
        claude_fixture(dir.path());
        let report = stats(dir.path()).report(Some(Provider::Claude), 30, now());
        let totals = &report["totals"];
        assert_eq!(totals["turns"], 3, "{report}");
        assert_eq!(totals["input"], 10 + 2 + 1);
        assert_eq!(totals["output"], 50 + 8 + 1);
        assert_eq!(totals["cache_read"], 100 + 90);
        assert_eq!(totals["cache_write"], 20);
        assert_eq!(totals["sessions"], 1, "the subagent belongs to its session");
        assert_eq!(totals["active_days"], 3);
        let daily = report["daily"].as_array().unwrap();
        assert_eq!(daily.len(), 30);
        assert_eq!(daily.last().unwrap()["day"], "2026-11-12");
        assert_eq!(daily.last().unwrap()["tokens"], 100);
        assert_eq!(daily.last().unwrap()["sessions"], 1);
        assert_eq!(report["models"][0]["model"], "claude-opus-5-5");
        assert_eq!(report["models"][1]["model"], "claude-haiku-4-5");
        let session = &report["sessions"][0];
        assert_eq!(session["project"], "demo-app");
        assert_eq!(session["id"], "sess-a");
        assert_eq!(session["model"], "claude-opus-5-5");
        assert_eq!(report["agents"]["claude"], true);
        assert_eq!(report["agents"]["codex"], false);

        let week = stats(dir.path()).report(Some(Provider::Claude), 7, now());
        assert_eq!(
            week["totals"]["turns"], 2,
            "the day-1 subagent reply is older"
        );
    }

    #[test]
    fn codex_turns_count_each_turns_own_use() {
        let dir = tempfile::tempdir().unwrap();
        codex_fixture(dir.path());
        let report = stats(dir.path()).report(Some(Provider::Codex), 30, now());
        let totals = &report["totals"];
        assert_eq!(totals["turns"], 2, "{report}");
        assert_eq!(totals["input"], 800 + 300);
        assert_eq!(totals["cache_read"], 200 + 300);
        assert_eq!(totals["output"], 50 + 30);
        let session = &report["sessions"][0];
        assert_eq!(session["id"], "0199aaaa-bbbb-cccc-dddd-eeeeffff0000");
        assert_eq!(session["project"], "demo-api");
        assert_eq!(session["model"], "gpt-6.1-sol");
        assert_eq!(session["duration"], 3600);
    }

    #[test]
    fn all_agents_are_summed_together() {
        let dir = tempfile::tempdir().unwrap();
        claude_fixture(dir.path());
        codex_fixture(dir.path());
        let report = stats(dir.path()).report(None, 30, now());
        assert_eq!(report["provider"], "all");
        assert_eq!(report["totals"]["turns"], 5);
        assert_eq!(report["totals"]["sessions"], 2);
        let providers: HashSet<&str> = report["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["provider"].as_str().unwrap())
            .collect();
        assert_eq!(providers, HashSet::from(["claude", "codex"]));
        assert_eq!(
            report["daily"].as_array().unwrap().last().unwrap()["sessions"],
            2
        );
    }

    #[test]
    fn a_repeat_look_reads_only_what_changed() {
        let dir = tempfile::tempdir().unwrap();
        let file = claude_fixture(dir.path());
        codex_fixture(dir.path());
        let first = stats(dir.path()).report(None, 30, now());
        assert_eq!(first["scan"]["files"], 3);
        assert_eq!(first["scan"]["read"], 3);
        assert!(dir.path().join("state/usage-stats.json").is_file());

        let again = stats(dir.path());
        let second = again.report(None, 30, now());
        assert_eq!(
            second["scan"]["read"], 0,
            "a new start reads the saved cache"
        );
        assert_eq!(second["totals"], first["totals"]);

        append(
            &file,
            &[assistant(
                "m4",
                "r4",
                &stamp_of(12, 12),
                "claude-opus-5-5",
                json!({"input_tokens": 7, "output_tokens": 3}),
            )],
        );
        let third = again.report(None, 30, now());
        assert_eq!(third["scan"]["read"], 1);
        assert_eq!(third["totals"]["turns"], 6);
        assert_eq!(
            third["totals"]["input"],
            first["totals"]["input"].as_u64().unwrap() + 7
        );

        std::fs::remove_file(&file).unwrap();
        let fourth = again.report(None, 30, now());
        assert_eq!(fourth["scan"]["files"], 2);
        assert_eq!(fourth["totals"]["turns"], 3);
    }

    #[test]
    fn a_line_still_being_written_waits_for_its_end() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("claude/projects/p/s.jsonl");
        let line = assistant(
            "m1",
            "r1",
            &stamp_of(12, 9),
            "claude-opus-5-5",
            json!({"input_tokens": 4, "output_tokens": 1}),
        );
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, &line[..line.len() / 2]).unwrap();
        let s = stats(dir.path());
        assert_eq!(s.report(None, 30, now())["totals"]["turns"], 0);
        std::fs::write(&file, format!("{line}\n")).unwrap();
        assert_eq!(s.report(None, 30, now())["totals"]["turns"], 1);
    }

    #[test]
    fn nothing_to_read_is_an_empty_report() {
        let dir = tempfile::tempdir().unwrap();
        let report = Stats::new(None, None, dir.path().join("cache.json")).report(None, 7, now());
        assert_eq!(report["totals"]["tokens"], 0);
        assert_eq!(report["daily"].as_array().unwrap().len(), 7);
        assert_eq!(report["sessions"], json!([]));
        assert_eq!(Provider::parse("codex"), Some(Some(Provider::Codex)));
        assert_eq!(Provider::parse("all"), Some(None));
        assert_eq!(Provider::parse("nope"), None);
    }
}
