use super::map::{is_set, path, text_of};
use super::net::{is_private, PublicOnly};
use super::{Call, Connector, Request};
use crate::secrets::Secrets;
use regex::Regex;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::Url;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);
const REPLY_MAX: usize = 1024 * 1024;
const SNIPPET: usize = 200;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Vars(pub BTreeMap<String, String>);

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Item {
    pub item_id: String,
    pub id: String,
    pub title: String,
    pub url: String,
    pub description: String,
    pub state: String,
    pub closed: bool,
    pub fields: BTreeMap<String, String>,
}

pub(super) struct Reply {
    pub value: Value,
    pub link: Option<String>,
}

pub struct Client {
    pub(super) connector: Connector,
    headers: Vec<(HeaderName, HeaderValue)>,
    query_secrets: BTreeMap<String, String>,
    saved: Vec<String>,
    http: reqwest::Client,
    tools: Option<Arc<dyn super::ToolCaller>>,
}

type Steps = BTreeMap<String, Value>;

fn slots() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*([^{}\s]+)\s*\}\}").expect("static regex"))
}

fn references() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\$\{secret:([^}]+)\}").expect("static regex"))
}

fn lookup(name: &str, vars: &Vars, steps: &Steps) -> Option<String> {
    if let Some(rest) = name.strip_prefix("steps.") {
        let (step, at) = rest.split_once('.').unwrap_or((rest, ""));
        return path(steps.get(step)?, at).map(|v| text_of(&v));
    }
    vars.0.get(name).cloned()
}

const GIVEN: [&str; 7] = [
    "item_id", "ticket", "title", "url", "branch", "report", "cursor",
];

// The values a call needs someone to supply: its slots, less what a run always knows.
pub fn needs_of(call: &Call) -> Vec<String> {
    let text = serde_json::to_string(&(&call.request, &call.before)).unwrap_or_default();
    let mut names: Vec<String> = slots()
        .captures_iter(&text)
        .map(|s| s[1].to_string())
        .filter(|n| !n.starts_with("steps.") && !GIVEN.contains(&n.as_str()))
        .collect();
    names.sort();
    names.dedup();
    names
}

fn fill(
    text: &str,
    vars: &Vars,
    steps: &Steps,
    each: &dyn Fn(&str) -> String,
) -> Result<String, String> {
    let mut out = String::new();
    let mut from = 0;
    for slot in slots().captures_iter(text) {
        let whole = slot.get(0).expect("a whole match");
        out.push_str(&text[from..whole.start()]);
        let value = lookup(&slot[1], vars, steps)
            .ok_or_else(|| format!("this call needs a value for {}", &slot[1]))?;
        out.push_str(&each(&value));
        from = whole.end();
    }
    out.push_str(&text[from..]);
    Ok(out)
}

fn encoded(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn fill_path(text: &str, vars: &Vars, steps: &Steps) -> Result<String, String> {
    // A value of .. would survive encoding and climb out of the path this call names.
    let climbs = slots()
        .captures_iter(text)
        .filter_map(|s| lookup(&s[1], vars, steps))
        .any(|v| v == "." || v == "..");
    if climbs {
        return Err("a value in this call's path is not allowed".into());
    }
    fill(text, vars, steps, &encoded)
}

fn fill_json(value: &Value, vars: &Vars, steps: &Steps) -> Result<Value, String> {
    Ok(match value {
        Value::String(s) => Value::String(fill(s, vars, steps, &str::to_string)?),
        Value::Array(list) => Value::Array(
            list.iter()
                .map(|v| fill_json(v, vars, steps))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| Ok((k.clone(), fill_json(v, vars, steps)?)))
                .collect::<Result<_, String>>()?,
        ),
        other => other.clone(),
    })
}

pub fn render_path(text: &str, vars: &Vars) -> Result<String, String> {
    fill_path(text, vars, &Steps::new())
}

pub fn render_text(text: &str, vars: &Vars) -> Result<String, String> {
    fill(text, vars, &Steps::new(), &str::to_string)
}

pub fn render_json(value: &Value, vars: &Vars) -> Result<Value, String> {
    fill_json(value, vars, &Steps::new())
}

fn chain(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(e) = source {
        text = format!("{text}: {e}");
        source = e.source();
    }
    text
}

fn mapped(call: &Call, row: &Value, name: &str) -> String {
    call.map
        .get(name)
        .and_then(|at| path(row, at))
        .map(|v| text_of(&v))
        .unwrap_or_default()
}

fn missing(call: &Call, name: &str) -> String {
    let field = call.map.get(name).map_or(name, String::as_str);
    format!("a row has no {field}")
}

const NAMED: [&str; 7] = [
    "item_id",
    "id",
    "title",
    "url",
    "description",
    "state",
    "closed",
];

impl Client {
    pub fn new(c: &Connector, secrets: &Secrets, saved: Vec<String>) -> Result<Client, String> {
        let mut headers = Vec::new();
        for (name, value) in &c.headers {
            let value = secrets
                .resolve(value)
                .map_err(|e| format!("{}: {e}", c.name))?;
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| format!("{}: {name} is not a header name", c.name))?;
            let mut value = HeaderValue::from_str(&value)
                .map_err(|_| format!("{}: the value of {name} cannot be sent", c.name))?;
            value.set_sensitive(true);
            headers.push((name, value));
        }
        let mut query_secrets = BTreeMap::new();
        let requests = c.calls.values().flat_map(|call| {
            std::iter::once(&call.request).chain(call.before.iter().map(|b| &b.request))
        });
        for value in requests.flat_map(|r| r.query.values()) {
            for name in crate::secrets::references(value).map_err(|e| format!("{}: {e}", c.name))? {
                let found = secrets
                    .get(name)
                    .ok_or_else(|| format!("{}: the secret {name} is not set", c.name))?;
                query_secrets.insert(name.to_string(), found.to_string());
            }
        }
        let mut http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT);
        if !c.allow_private {
            http = http.dns_resolver(Arc::new(PublicOnly));
        }
        Ok(Client {
            connector: c.clone(),
            headers,
            query_secrets,
            saved,
            http: http.build().map_err(|e| e.to_string())?,
            tools: None,
        })
    }

    pub fn with_tools(mut self, tools: Arc<dyn super::ToolCaller>) -> Client {
        self.tools = Some(tools);
        self
    }

    async fn ask_tool(
        &self,
        call: &Call,
        vars: &Vars,
        steps: &Steps,
        extra: Option<(String, String)>,
    ) -> Result<Reply, String> {
        use crate::mcp_client::Failure;
        let name = &self.connector.name;
        let server = &self.connector.server;
        let tools = self.tools.as_ref().ok_or_else(|| {
            format!("{name} goes through {server}, which only the running server can reach")
        })?;
        let mut arguments =
            fill_json(&call.arguments, vars, steps).map_err(|e| format!("{name}: {e}"))?;
        if let Some(fields) = arguments.as_object_mut() {
            fields.retain(|_, v| v != "");
            if let Some((key, value)) = extra {
                fields.insert(key, Value::String(value));
            }
        }
        let reply =
            tools
                .call(server, &call.tool, arguments)
                .await
                .map_err(|failure| match failure {
                    Failure::NeedsSignIn(_) => {
                        format!("{server}: sign in again under Settings, Connections")
                    }
                    Failure::NeedsScope(c) => format!(
                    "{server} wants more access ({}). Sign in again under Settings, Connections",
                    c.scope.as_deref().unwrap_or("no scope named")
                ),
                    Failure::NotAllowed(e) | Failure::Other(e) => self.scrub(&e),
                })?;
        if reply.is_error {
            return Err(format!("{name}: {}", self.scrub(&reply.text)));
        }
        let value = match reply.structured {
            Some(value) => value,
            None => match serde_json::from_str(&reply.text) {
                Ok(value) => value,
                Err(_) if call.kind() == super::CallKind::Change => {
                    Value::String(self.scrub(&reply.text))
                }
                Err(_) => {
                    return Err(format!(
                        "{name}: {} answered with text that is not JSON",
                        call.tool
                    ))
                }
            },
        };
        Ok(Reply { value, link: None })
    }

    pub(super) async fn send_call(
        &self,
        call: &Call,
        vars: &Vars,
        steps: &Steps,
        extra: Option<(String, String)>,
    ) -> Result<Reply, String> {
        if call.tool.is_empty() {
            self.send(&call.request, vars, steps, extra).await
        } else {
            self.ask_tool(call, vars, steps, extra).await
        }
    }

    pub fn call_named(&self, name: &str) -> Result<&Call, String> {
        self.connector
            .calls
            .get(name)
            .ok_or_else(|| format!("{} has no call {name}", self.connector.name))
    }

    fn scrub(&self, text: &str) -> String {
        crate::mcp_read::scrubbed(text, &self.saved)
    }

    fn checked_url(&self, url: &str) -> Result<Url, String> {
        let wanted = Url::parse(&self.connector.base_url).map_err(|e| e.to_string())?;
        let url = Url::parse(url).map_err(|e| e.to_string())?;
        if url.host_str() != wanted.host_str()
            || url.port_or_known_default() != wanted.port_or_known_default()
        {
            return Err(format!(
                "{}: that address is on another host",
                self.connector.name
            ));
        }
        let literal = url
            .host_str()
            .map(|h| h.trim_matches(['[', ']']))
            .and_then(|h| h.parse().ok());
        if !self.connector.allow_private && literal.is_some_and(is_private) {
            return Err(format!(
                "{}: {} is a private address",
                self.connector.name,
                url.host_str().unwrap_or_default()
            ));
        }
        Ok(url)
    }

    async fn send_url(
        &self,
        method: &str,
        url: Url,
        query: Vec<(String, String)>,
        body: Option<Value>,
    ) -> Result<Reply, String> {
        let name = &self.connector.name;
        let host = url.host_str().unwrap_or_default().to_string();
        let method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
            .map_err(|_| format!("{name}: {method} is not a method"))?;
        let mut req = self.http.request(method, url).query(&query);
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        let mut res = req.send().await.map_err(|e| {
            let text = chain(&e.without_url());
            self.scrub(&format!("{name}: could not reach {host}: {text}"))
        })?;
        let status = res.status();
        if status.is_redirection() {
            return Err(format!(
                "{name}: {host} answered a redirect ({}), which Yardbell does not follow",
                status.as_u16()
            ));
        }
        let link = res
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| {
            self.scrub(&format!(
                "{name}: {host} stopped answering: {}",
                chain(&e.without_url())
            ))
        })? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > REPLY_MAX {
                return Err(format!("{name}: the reply from {host} is over 1 MB"));
            }
        }
        let text = self.scrub(&String::from_utf8_lossy(&bytes));
        if !status.is_success() {
            let said: String = text.chars().take(SNIPPET).collect();
            return Err(format!(
                "{name}: {host} answered {}: {said}",
                status.as_u16()
            ));
        }
        if text.trim().is_empty() {
            return Ok(Reply {
                value: Value::Null,
                link,
            });
        }
        let value = serde_json::from_str(&text)
            .map_err(|_| format!("{name}: the reply from {host} is not JSON"))?;
        Ok(Reply { value, link })
    }

    pub(super) async fn send(
        &self,
        request: &Request,
        vars: &Vars,
        steps: &Steps,
        extra: Option<(String, String)>,
    ) -> Result<Reply, String> {
        let path = fill_path(&request.path, vars, steps)
            .map_err(|e| format!("{}: {e}", self.connector.name))?;
        let base = self.connector.base_url.trim_end_matches('/');
        let url = self.checked_url(&format!("{base}{path}"))?;
        let mut query = Vec::new();
        // Secrets become slots of their own, so a value from a ticket that spells a reference stays
        // the text it is.
        let mut with_secrets = vars.clone();
        for (name, value) in &self.query_secrets {
            with_secrets
                .0
                .insert(format!("secret.{name}"), value.clone());
        }
        for (k, v) in &request.query {
            let v = references().replace_all(v, "{{secret.$1}}");
            let v = fill(&v, &with_secrets, steps, &str::to_string)
                .map_err(|e| format!("{}: {e}", self.connector.name))?;
            query.push((k.clone(), v));
        }
        query.extend(extra);
        let body = match &request.body {
            Some(b) => Some(
                fill_json(b, vars, steps).map_err(|e| format!("{}: {e}", self.connector.name))?,
            ),
            None => None,
        };
        self.send_url(&request.method, url, query, body).await
    }

    pub(super) async fn send_link(&self, request: &Request, link: &str) -> Result<Reply, String> {
        let url = self.checked_url(link)?;
        self.send_url(&request.method, url, Vec::new(), None).await
    }

    pub(super) async fn run_before(&self, call: &Call, vars: &Vars) -> Result<Steps, String> {
        let mut steps = Steps::new();
        for b in &call.before {
            let reply = self.send(&b.request, vars, &steps, None).await?;
            steps.insert(b.name.clone(), reply.value);
        }
        Ok(steps)
    }

    pub(super) fn check_error(&self, call: &Call, value: &Value) -> Result<(), String> {
        if call.error.is_empty() {
            return Ok(());
        }
        match path(value, &call.error).filter(is_set) {
            Some(found) => {
                let said: String = text_of(&found).chars().take(SNIPPET).collect();
                Err(format!("{}: {said}", self.connector.name))
            }
            None => Ok(()),
        }
    }

    pub async fn call(&self, name: &str, vars: &Vars) -> Result<Value, String> {
        let call = self.call_named(name)?;
        let steps = self.run_before(call, vars).await?;
        let reply = self.send_call(call, vars, &steps, None).await?;
        self.check_error(call, &reply.value)?;
        Ok(reply.value)
    }

    fn row(call: &Call, row: &Value) -> Item {
        let fields = call
            .map
            .keys()
            .filter(|k| !NAMED.contains(&k.as_str()))
            .map(|k| (k.clone(), mapped(call, row, k)))
            .collect();
        let line = |name: &str| crate::pipeline::prompts::one_line(&mapped(call, row, name));
        let item_id = line("item_id");
        let id = line("id");
        let id = match id.rsplit_once('/') {
            Some((_, last)) if id.contains("://") && !last.is_empty() => last.to_string(),
            _ => id,
        };
        Item {
            id: if id.is_empty() { item_id.clone() } else { id },
            item_id,
            title: line("title"),
            url: super::map::clean_url(&mapped(call, row, "url")),
            description: mapped(call, row, "description"),
            state: mapped(call, row, "state"),
            closed: mapped(call, row, "closed") == "true",
            fields,
        }
    }

    // Only what the connector names is ever kept; the rest of a reply goes no further.
    pub async fn options(&self, name: &str, vars: &Vars) -> Result<Vec<(String, String)>, String> {
        let call = self.call_named(name)?;
        if call.kind() == super::CallKind::Change {
            return Err(format!(
                "{name} changes something, so it cannot fill a list"
            ));
        }
        let value = self.call(name, vars).await?;
        let rows = path(&value, &call.items).unwrap_or(Value::Null);
        Ok(rows
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|row| (mapped(call, row, "id"), mapped(call, row, "name")))
                    .collect()
            })
            .unwrap_or_default())
    }

    // A choice nobody made, for a check that only needs to see the connection work.
    pub async fn with_defaults(&self, vars: &Vars) -> Vars {
        let mut filled = vars.clone();
        for param in &self.connector.params {
            if filled.0.contains_key(&param.name) || param.options.is_empty() {
                continue;
            }
            if let Ok(found) = self.options(&param.options, &filled).await {
                if let Some((id, _)) = found.into_iter().next() {
                    filled.0.insert(param.name.clone(), id);
                }
            }
        }
        filled
    }

    pub fn mapped_reply(call: &Call, value: &Value) -> Value {
        if call.map.is_empty() {
            return Value::Null;
        }
        let kept = call
            .map
            .iter()
            .filter_map(|(k, at)| path(value, at).map(|v| (k.clone(), v)))
            .collect();
        Value::Object(kept)
    }

    pub fn item_of(call: &Call, row: &Value) -> Result<Item, String> {
        let item = Self::row(call, row);
        if item.item_id.trim().is_empty() {
            return Err(missing(call, "item_id"));
        }
        if item.title.trim().is_empty() {
            return Err(missing(call, "title"));
        }
        Ok(item)
    }

    pub fn read_item(call: &Call, row: &Value, item_id: &str) -> Result<Item, String> {
        let mut item = Self::row(call, row);
        item.item_id = item_id.to_string();
        if item.id.is_empty() {
            item.id = item_id.to_string();
        }
        if item.title.trim().is_empty() {
            return Err(missing(call, "title"));
        }
        Ok(item)
    }

    pub async fn read(&self, vars: &Vars) -> Result<Item, String> {
        let value = self.call("read", vars).await?;
        let item_id = vars.0.get("item_id").cloned().unwrap_or_default();
        Self::read_item(self.call_named("read")?, &value, &item_id)
            .map_err(|e| format!("{}: {e}", self.connector.name))
    }
}
