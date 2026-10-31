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
