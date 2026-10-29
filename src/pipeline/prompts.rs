use super::record::Finding;

pub fn fix_findings(findings: &[Finding]) -> String {
    findings
        .iter()
        .map(|f| format!("{}: {}", f.place, f.text))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn fix_qa(report: &str) -> String {
    report.to_string()
}
