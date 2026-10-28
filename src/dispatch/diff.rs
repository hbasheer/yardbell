use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

// Past this many cells the word table gets too big, and lines are compared instead.
const MAX_CELLS: usize = 4_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Same,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Part {
    pub op: Op,
    pub text: String,
}

fn tokens(text: &str) -> Vec<&str> {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    WORDS
        .get_or_init(|| Regex::new(r"\s+|\S+").expect("word pattern"))
        .find_iter(text)
        .map(|m| m.as_str())
        .collect()
}

fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

// Words that changed between two texts, in order, with the words both share between them.
pub fn words(from: &str, to: &str) -> Vec<Part> {
    let (a, b) = (tokens(from), tokens(to));
    if (a.len() + 1) * (b.len() + 1) <= MAX_CELLS {
        return merged(&a, &b);
    }
    let (a, b) = (lines(from), lines(to));
    if (a.len() + 1) * (b.len() + 1) <= MAX_CELLS {
        return merged(&a, &b);
    }
    let mut out = Vec::new();
    push(&mut out, Op::Del, from);
    push(&mut out, Op::Add, to);
    out
}

fn merged(a: &[&str], b: &[&str]) -> Vec<Part> {
    let (n, m) = (a.len(), b.len());
    let width = m + 1;
    let mut longest = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            longest[i * width + j] = if a[i] == b[j] {
                longest[(i + 1) * width + j + 1] + 1
            } else {
                longest[(i + 1) * width + j].max(longest[i * width + j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            push(&mut out, Op::Same, a[i]);
            i += 1;
            j += 1;
        } else if longest[(i + 1) * width + j] >= longest[i * width + j + 1] {
            push(&mut out, Op::Del, a[i]);
            i += 1;
        } else {
            push(&mut out, Op::Add, b[j]);
            j += 1;
        }
    }
    for t in &a[i..] {
        push(&mut out, Op::Del, t);
    }
    for t in &b[j..] {
        push(&mut out, Op::Add, t);
    }
    out
}

fn push(out: &mut Vec<Part>, op: Op, text: &str) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(last) if last.op == op => last.text.push_str(text),
        _ => out.push(Part {
            op,
            text: text.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(parts: &[Part]) -> String {
        parts
            .iter()
            .map(|p| match p.op {
                Op::Same => p.text.clone(),
                Op::Add => format!("[+{}]", p.text),
                Op::Del => format!("[-{}]", p.text),
            })
            .collect()
    }

    #[test]
    fn changed_words_are_marked_and_the_rest_kept() {
        let parts = words(
            "Run the tests on hp and report.",
            "Run all tests on hp and pro, then report.",
        );
        assert_eq!(
            show(&parts),
            "Run [-the][+all] tests on hp and [+pro, then ]report."
        );
        let joined = |op: Op| -> String {
            parts
                .iter()
                .filter(|p| p.op != op)
                .map(|p| p.text.as_str())
                .collect()
        };
        assert_eq!(joined(Op::Add), "Run the tests on hp and report.");
        assert_eq!(joined(Op::Del), "Run all tests on hp and pro, then report.");
    }

    #[test]
    fn same_text_is_one_part_and_empty_sides_are_one_change() {
        assert_eq!(
            words("a b", "a b"),
            [Part {
                op: Op::Same,
                text: "a b".into()
            }]
        );
        assert_eq!(show(&words("", "new text")), "[+new text]");
        assert_eq!(show(&words("old", "")), "[-old]");
        assert!(words("", "").is_empty());
    }

    #[test]
    fn a_huge_text_is_compared_by_line() {
        let a: String = (0..2500).map(|i| format!("w{i} ")).collect::<String>() + "\nend\n";
        let b = a.replace("\nend\n", "\nfinish\n");
        let parts = words(&a, &b);
        assert_eq!(show(&parts[1..]), "[-end\n][+finish\n]");
    }
}
