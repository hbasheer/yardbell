pub mod client;
pub mod map;
pub mod net;
pub mod page;
#[cfg(test)]
pub(crate) mod tests;

pub use page::{Health, Listed, Status};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

const BEFORE_MAX: usize = 3;
const PAGES_MAX: u32 = 100;
const TRELLO: &str = include_str!("templates/trello.yml");

fn on() -> bool {
    true
}

fn is_on(v: &bool) -> bool {
    *v
}

fn is_off(v: &bool) -> bool {
    !*v
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connector {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "on", skip_serializing_if = "is_on")]
    pub enabled: bool,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "is_off")]
    pub allow_private: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<Param>,
    #[serde(default)]
    pub calls: BTreeMap<String, Call>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub options: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub request: Request,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub before: Vec<NamedRequest>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub items: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub map: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<CallKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<Page>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub method: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub query: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedRequest {
    pub name: String,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallKind {
    Lookup,
    Change,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageStyle {
    Cursor,
    Number,
    Offset,
    Link,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub style: PageStyle,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub param: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub next: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub has_more: String,
    #[serde(default)]
    pub size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_pages: Option<u32>,
}

impl Call {
    pub fn kind(&self) -> CallKind {
        self.kind
            .unwrap_or(match self.request.method.eq_ignore_ascii_case("GET") {
                true => CallKind::Lookup,
                false => CallKind::Change,
            })
    }
}

pub fn host_of(base_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(base_url).ok()?;
    parsed.host_str().map(str::to_ascii_lowercase)
}

pub fn client_for(
    list: &[Connector],
    id: &str,
    secrets: &Result<crate::secrets::Secrets, String>,
    saved: Vec<String>,
) -> Result<client::Client, String> {
    let c = list
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("there is no connector {id}"))?;
    if !c.enabled {
        return Err(format!("{} is switched off", c.name));
    }
    let secrets = secrets.as_ref().map_err(|e| format!("{}: {e}", c.name))?;
    client::Client::new(c, secrets, saved)
}

pub fn templates() -> Vec<&'static str> {
    vec!["trello", "github", "gitlab", "jira", "asana"]
}

pub fn template(name: &str) -> Option<Connector> {
    let text = match name {
        "trello" => TRELLO,
        "github" => include_str!("templates/github.yml"),
        "gitlab" => include_str!("templates/gitlab.yml"),
        "jira" => include_str!("templates/jira.yml"),
        "asana" => include_str!("templates/asana.yml"),
        _ => return None,
    };
    serde_yaml::from_str(text).ok()
}

pub fn blurb(name: &str) -> &'static str {
    match name {
        "trello" => "Cards on a board. Needs an API key and a token.",
        "github" => "Open issues in a repository. Needs a personal access token.",
        "gitlab" => "Open issues in a project. Needs a personal access token.",
        "jira" => "Your open issues. Needs your site's address and an API token.",
        "asana" => "Your tasks in a workspace. Needs a personal access token.",
        _ => "",
    }
}

fn plain_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(name.as_str(), "accept" | "content-type" | "user-agent") || name.ends_with("-version")
}

fn check_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && !path.contains("://")
}

fn holds_reference(value: &Value) -> bool {
    match value {
        Value::String(s) => crate::secrets::has_reference(s),
        Value::Array(list) => list.iter().any(holds_reference),
        Value::Object(map) => map.values().any(holds_reference),
        _ => false,
    }
}

fn literal_credential(value: &Value) -> Option<String> {
    match value {
        Value::Array(list) => list.iter().find_map(literal_credential),
        Value::Object(map) => map.iter().find_map(|(k, v)| match v {
            Value::String(s)
                if crate::mcp_read::credential(k) && !s.is_empty() && !s.contains("{{") =>
            {
                Some(k.clone())
            }
            other => literal_credential(other),
        }),
        _ => None,
    }
}

fn check_request(r: &Request) -> Result<(), String> {
    if crate::secrets::has_reference(&r.path) || r.body.as_ref().is_some_and(holds_reference) {
        return Err("a secret can only go in a header or the query".into());
    }
    if let Some(key) = r.body.as_ref().and_then(literal_credential) {
        return Err(format!("body {key} must not hold a credential"));
    }
    for (k, v) in &r.query {
        if crate::mcp_read::credential(k) && !crate::secrets::has_reference(v) && !v.contains("{{")
        {
            return Err(format!("query {k} must use ${{secret:NAME}}"));
        }
    }
    Ok(())
}

fn check_call(call: &Call) -> Result<(), String> {
    if call.before.len() > BEFORE_MAX {
        return Err(format!("at most {BEFORE_MAX} before requests"));
    }
    check_request(&call.request)?;
    for b in &call.before {
        check_request(&b.request)?;
    }
    let requests = call.before.iter().map(|b| &b.request);
    if !std::iter::once(&call.request)
        .chain(requests)
        .all(|r| check_path(&r.path))
    {
        return Err("path must start with /".into());
    }
    let Some(page) = &call.page else {
        return Ok(());
    };
    if page
        .max_pages
        .is_some_and(|n| !(1..=PAGES_MAX).contains(&n))
    {
        return Err(format!("max_pages must be from 1 to {PAGES_MAX}"));
    }
    match page.style {
        PageStyle::Cursor if page.next.is_empty() => Err("a cursor page needs next".into()),
        PageStyle::Number | PageStyle::Offset if page.size == 0 => {
            Err("this page style needs size".into())
        }
        _ => Ok(()),
    }
}

fn check_connector(c: &Connector) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&c.base_url).ok();
    let secure = parsed.is_some_and(|u| {
        u.has_host() && (u.scheme() == "https" || (u.scheme() == "http" && c.allow_private))
    });
    if !secure {
        return Err("base_url must be an https address".into());
    }
    if reqwest::Url::parse(&c.base_url)
        .is_ok_and(|u| !u.username().is_empty() || u.password().is_some())
    {
        return Err("base_url must not hold a user or password".into());
    }
    for (name, value) in &c.headers {
        if !crate::secrets::has_reference(value) && !plain_header(name) {
            return Err(format!("header {name} must use ${{secret:NAME}}"));
        }
        crate::secrets::references(value).map_err(|e| format!("header {name}: {e}"))?;
    }
    for (name, call) in &c.calls {
        check_call(call).map_err(|e| format!("call {name}: {e}"))?;
    }
    Ok(())
}

pub fn validate(list: &[Connector]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for (i, c) in list.iter().enumerate() {
        if c.id.trim().is_empty() {
            return Err(format!("connector {} needs an id", i + 1));
        }
        if !ids.insert(c.id.as_str()) {
            return Err(format!("two connectors have the id {}", c.id));
        }
        check_connector(c).map_err(|e| format!("connector {}: {e}", c.id))?;
    }
    Ok(())
}
