use super::client::{Client, Item, Vars};
use super::map::{is_set, path, text_of};
use super::{Call, Page, PageStyle};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;

pub const ITEMS_MAX: usize = 5000;
pub const PAGES_DEFAULT: u32 = 20;

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Listed {
    pub items: Vec<Item>,
    pub skipped: Vec<String>,
    pub cut_off: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Status {
    pub ok: bool,
    pub at: String,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct Health(Mutex<BTreeMap<String, Status>>);

impl Health {
    pub fn set(&self, id: &str, status: Status) {
        self.0
            .lock()
            .expect("connector health")
            .insert(id.to_string(), status);
    }

    pub fn all(&self) -> BTreeMap<String, Status> {
        self.0.lock().expect("connector health").clone()
    }
}

fn next_link(header: &str) -> Option<String> {
    header.split(',').find_map(|part| {
        let (url, rest) = part.split_once(';')?;
        rest.contains("rel=\"next\"")
            .then(|| url.trim().trim_matches(['<', '>']).to_string())
    })
}

// Rows grouped under a parent, such as cards under their list. Each row keeps its parent, without
// the rows, as _parent, so a map can read what only the group knows.
fn nested_rows(value: &Value, outer: &str, inner: &str) -> Option<Value> {
    let groups = path(value, outer)?;
    let mut out = Vec::new();
    for group in groups.as_array()? {
        let Some(list) = path(group, inner) else {
            continue;
        };
        let mut parent = group.clone();
        if let Some(fields) = parent.as_object_mut() {
            fields.remove(inner);
        }
        for row in list.as_array().into_iter().flatten() {
            let mut row = row.clone();
            if let Some(fields) = row.as_object_mut() {
                fields.insert("_parent".to_string(), parent.clone());
            }
            out.push(row);
        }
    }
    Some(Value::Array(out))
}

fn rows<'a>(call: &Call, value: &'a Value, found: &'a mut Value) -> Option<&'a Vec<Value>> {
    if call.items.is_empty() {
        return value.as_array();
    }
    *found = match call.items.split_once("[].") {
        Some((outer, inner)) => nested_rows(value, outer, inner)?,
        None => path(value, &call.items)?,
    };
    found.as_array()
}

enum More {
    Done,
    Next(Option<(String, String)>),
    Link(String),
    Repeated,
}

fn more(
    page: &Page,
    value: &Value,
    link: Option<&str>,
    seen: &[String],
    page_no: u32,
    read: usize,
    count: usize,
) -> (More, Option<String>) {
    match page.style {
        PageStyle::Cursor => {
            let done = !page.has_more.is_empty()
                && !path(value, &page.has_more).is_some_and(|v| is_set(&v));
            let next = path(value, &page.next)
                .map(|v| text_of(&v))
                .unwrap_or_default();
            if done || next.is_empty() {
                (More::Done, None)
            } else if seen.contains(&next) {
                (More::Repeated, None)
            } else {
                (
                    More::Next(Some((page.param.clone(), next.clone()))),
                    Some(next),
                )
            }
        }
        PageStyle::Number if count < page.size as usize => (More::Done, None),
        PageStyle::Offset if count < page.size as usize => (More::Done, None),
        PageStyle::Number => (
            More::Next(Some((page.param.clone(), (page_no + 1).to_string()))),
            None,
        ),
        PageStyle::Offset => (
            More::Next(Some((page.param.clone(), read.to_string()))),
            None,
        ),
        PageStyle::Link => match link.and_then(next_link) {
            Some(url) => (More::Link(url), None),
            None => (More::Done, None),
        },
    }
}

fn first_extra(page: Option<&Page>) -> Option<(String, String)> {
    match page.map(|p| p.style) {
        Some(PageStyle::Number) => page.map(|p| (p.param.clone(), "1".to_string())),
        Some(PageStyle::Offset) => page.map(|p| (p.param.clone(), "0".to_string())),
        _ => None,
    }
}

impl Client {
    pub async fn list(&self, vars: &Vars) -> Result<Listed, String> {
        let call = self.call_named("list")?;
        let name = self.connector.name.clone();
        let mut vars = self.with_filters(vars);
        vars.0.entry("cursor".to_string()).or_default();
        let steps = self.run_before(call, &vars).await?;
        let max_pages = match &call.page {
            Some(p) => p.max_pages.unwrap_or(PAGES_DEFAULT),
            None => 1,
        };
        let mut out = Listed::default();
        let mut extra = first_extra(call.page.as_ref());
        let mut link: Option<String> = None;
        let mut seen: Vec<String> = Vec::new();
        let mut read = 0;
        for page_no in 1.. {
            let reply = match &link {
                Some(url) => self.send_link(&call.request, url).await?,
                None => self.send_call(call, &vars, &steps, extra.take()).await?,
            };
            self.check_error(call, &reply.value)?;
            let mut holder = Value::Null;
            let list = rows(call, &reply.value, &mut holder)
                .ok_or_else(|| format!("{name}: the reply holds no list at {:?}", call.items))?;
            for row in list {
                match Client::item_of(call, row) {
                    Ok(item) if out.items.len() < ITEMS_MAX => out.items.push(item),
                    Ok(_) => {
                        out.cut_off = Some(format!("the list was cut off at {ITEMS_MAX} items"));
                        return Ok(out);
                    }
                    Err(e) => out.skipped.push(e),
                }
            }
            read += list.len();
            let Some(page) = &call.page else {
                return Ok(out);
            };
            let (what, cursor) = more(
                page,
                &reply.value,
                reply.link.as_deref(),
                &seen,
                page_no,
                read,
                list.len(),
            );
            match what {
                More::Done => return Ok(out),
                More::Repeated => {
                    out.cut_off =
                        Some("the list was cut off: the server repeated a page".to_string());
                    return Ok(out);
                }
                _ if page_no >= max_pages => {
                    out.cut_off = Some(format!("the list was cut off at {max_pages} pages"));
                    return Ok(out);
                }
                More::Next(next) => {
                    if let Some(c) = cursor {
                        vars.0.insert("cursor".to_string(), c.clone());
                        seen.push(c);
                    }
                    extra = next.filter(|(param, _)| !param.is_empty());
                }
                More::Link(url) => link = Some(url),
            }
        }
        Ok(out)
    }
}
