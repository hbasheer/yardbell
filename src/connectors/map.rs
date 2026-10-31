use serde_json::Value;

// Reads a.b, users.0.id, items[].id or [].id from a reply. An empty path is the whole reply.
pub fn path(value: &Value, at: &str) -> Option<Value> {
    if at.is_empty() {
        return Some(value.clone());
    }
    let (head, rest) = at.split_once('.').unwrap_or((at, ""));
    if let Some(name) = head.strip_suffix("[]") {
        let list = if name.is_empty() {
            value
        } else {
            value.get(name)?
        };
        let rows = list.as_array()?.iter().filter_map(|row| path(row, rest));
        return Some(Value::Array(rows.collect()));
    }
    let next = match head.parse::<usize>() {
        Ok(i) => value.get(i)?,
        Err(_) => value.get(head)?,
    };
    path(next, rest)
}

pub fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn is_set(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => true,
    }
}

// Every field path in a row, so a person can write a map without reading API docs.
pub fn paths_of(row: &Value) -> Vec<String> {
    fn walk(value: &Value, at: &str, out: &mut Vec<String>) {
        match value {
            Value::Object(map) if !map.is_empty() => {
                for (k, v) in map {
                    let next = if at.is_empty() {
                        k.clone()
                    } else {
                        format!("{at}.{k}")
                    };
                    walk(v, &next, out);
                }
            }
            Value::Array(list) if list.first().is_some_and(Value::is_object) => {
                walk(&list[0], &format!("{at}[]"), out);
            }
            _ => out.push(at.to_string()),
        }
    }
    let mut out = Vec::new();
    walk(row, "", &mut out);
    out.sort();
    out.dedup();
    out
}

// A link is only kept when it is plainly one, so outside text cannot pass as one.
pub fn clean_url(text: &str) -> String {
    let text = text.trim();
    let plain = text.starts_with("https://") || text.starts_with("http://");
    if plain && !text.contains(char::is_whitespace) {
        text.to_string()
    } else {
        String::new()
    }
}
