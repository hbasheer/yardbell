use crate::config::Config;
use crate::probe::Probe;
use crate::service::in_docker;
use crate::shell::{RealRunner, Runner};
use crate::ssh::Ssh;
use std::path::Path;
use std::sync::Arc;

pub fn pmset_never_sleeps(output: &str) -> bool {
    output.lines().any(|line| {
        let mut words = line.split_whitespace();
        words.next() == Some("sleep") && words.next() == Some("0")
    })
}

pub fn ufw_hints(cfg: &Config) -> Vec<String> {
    let rule =
        |ports: String| format!("sudo ufw allow in on nordlynx to any port {ports} proto tcp");
    let mut out = vec![rule(cfg.port.to_string())];
    let mut prefixes: Vec<u8> = cfg
        .remote_machines()
        .filter_map(|m| m.port_prefix)
        .collect();
    prefixes.sort_unstable();
    for p in prefixes {
        let start = p as u32 * 10000;
        out.push(rule(format!("{start}:{}", (start + 9999).min(65535))));
    }
    out
}

pub fn gitlab_line(host: &str, found: &Result<String, String>) -> (bool, String) {
    match found {
        Ok(name) => (true, format!("{host}: signed in as {name}")),
        Err(problem) => (false, format!("{host}: {problem}")),
    }
}

pub fn pipeline_lines(
    cfg: &Config,
    linear: &Result<usize, String>,
    gh: &[(String, bool)],
) -> Vec<(bool, String)> {
    let Some(p) = &cfg.pipeline else {
        return Vec::new();
    };
    let mut lines = vec![match linear {
        Ok(n) => (
            true,
            format!("pipeline: Linear answers, {n} open tickets are yours"),
        ),
        Err(e) => (false, format!("pipeline: {e}")),
    }];
    if !p.linear_state.is_empty() {
        lines.push((
            true,
            format!(
                "pipeline: finished tickets move to {} in Linear, so the key needs write access",
                p.linear_state
            ),
        ));
    }
    for (machine, logged_in) in gh {
        lines.push(if *logged_in {
            (true, format!("pipeline: gh is logged in on {machine}"))
        } else {
            (
                false,
                format!("pipeline: gh is not logged in on {machine}, so draft pull requests cannot be opened there (run gh auth login on {machine})"),
            )
        });
    }
    for g in &cfg.pull_requests.gitlab {
        lines.push((
            true,
            format!(
                "pipeline: draft merge requests on {} need its token to have the api scope",
                g.host
            ),
        ));
    }
    lines
}

fn line(ok: bool, text: &str) {
    println!("{} {text}", if ok { "✓" } else { "✗" });
}

pub async fn run(path: &Path, state_dir: std::path::PathBuf) -> anyhow::Result<()> {
    let cfg = match Config::load(path) {
        Ok(cfg) => {
            line(true, &format!("config {}", path.display()));
            cfg
        }
        Err(e) => {
            line(false, &e.to_string());
            return Ok(());
        }
    };
    line(
        cfg.passcode_hash.is_some(),
        "passcode set (run `yardbell passcode` if not)",
    );
    let runner: Arc<dyn Runner> = Arc::new(RealRunner::default());
    let mesh = crate::mesh::HostMesh::new(runner.clone()).check(&cfg).await;
    match mesh.on {
        Some(on) => line(
            on,
            &format!(
                "{} is {} on this machine",
                mesh.label,
                if on { "on" } else { "off" }
            ),
        ),
        None => println!(
            "  {}: status unknown (no command line and no mesh address found)",
            mesh.label
        ),
    }
    if let Some(hint) = &mesh.hint {
        println!("  fix: {hint}");
    }
    let ssh = Ssh::new(state_dir);
    let probe = Probe::new(runner.clone(), ssh.clone());
    for m in &cfg.machines {
        let st = probe.check(&cfg, m).await;
        let detail = match (&st.reason, &st.snapshot) {
            (Some(reason), _) => reason.to_string(),
            (None, Some(snap)) => format!(
                "{} agent sessions, {} folders",
                snap.sessions.len(),
                snap.folders.len()
            ),
            (None, None) => "ok".into(),
        };
        line(st.up, &format!("{}: {detail}", m.name));
    }
    if !cfg.pull_requests.gitlab.is_empty() {
        let secrets = crate::secrets::Secrets::for_config(path).map_err(|e| e.to_string());
        let gitlab = crate::pulls::GitLab::new();
        for access in crate::pulls::accesses(&cfg.pull_requests, &secrets) {
            let (ok, text) = gitlab_line(&access.host, &gitlab.whoami(&access).await);
            line(ok, &text);
        }
    }
    if let Some(p) = &cfg.pipeline {
        let secrets = crate::secrets::Secrets::for_config(path).map_err(|e| e.to_string());
        let linear = match secrets.and_then(|s| {
            s.get(crate::triggers::LINEAR_SECRET)
                .map(str::to_string)
                .ok_or_else(|| {
                    "the secret linear is not set, so the pipeline cannot read tickets".to_string()
                })
        }) {
            Ok(key) => crate::pipeline::linear::Linear::new()
                .open(&key)
                .await
                .map(|t| t.len()),
            Err(e) => Err(e),
        };
        let mut gh = Vec::new();
        for name in &p.machines {
            let Some(m) = cfg.machine(name) else {
                continue;
            };
            let out = runner
                .run(
                    ssh.command(m, "gh auth status >/dev/null 2>&1"),
                    None,
                    std::time::Duration::from_secs(15),
                )
                .await;
            gh.push((name.clone(), out.ok()));
        }
        for (ok, text) in pipeline_lines(&cfg, &linear, &gh) {
            line(ok, &text);
        }
    }
    if in_docker() {
        println!("  running inside Docker: the host machine is reached over ssh like any other");
    }
    if cfg!(target_os = "macos") {
        let out = runner
            .run(
                vec!["pmset".into(), "-g".into()],
                None,
                std::time::Duration::from_secs(3),
            )
            .await;
        let ok = pmset_never_sleeps(&out.stdout);
        line(ok, "this Mac never sleeps");
        if !ok {
            println!("  fix: sudo pmset -a sleep 0");
        }
    } else {
        let ufw = runner
            .run(
                vec!["bash".into(), "-c".into(), "command -v ufw".into()],
                None,
                std::time::Duration::from_secs(3),
            )
            .await;
        if ufw.ok() {
            println!("  ufw is installed. If it is active, other devices need these rules to reach Yardbell and its tunnels:");
            for hint in ufw_hints(&cfg) {
                println!("    {hint}");
            }
        } else {
            println!("  firewall: not macOS, ufw not found, nothing to check");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn gitlab_lines_name_the_account_or_the_problem() {
        assert_eq!(
            gitlab_line("git.commslayer.com", &Ok("hbasheer".into())),
            (true, "git.commslayer.com: signed in as hbasheer".into())
        );
        assert_eq!(
            gitlab_line(
                "git.commslayer.com",
                &Err("the secret gitlab is not set".into())
            ),
            (
                false,
                "git.commslayer.com: the secret gitlab is not set".into()
            )
        );
    }

    #[test]
    fn the_pipeline_lines_name_each_problem() {
        let cfg: crate::config::Config = serde_yaml::from_str(
            "machines:\n  - name: hp\n    local: true\n    root: /r\npipeline:\n  machines: [hp]\n  test_machine: hp\n  linear_state: In Review\npull_requests:\n  gitlab:\n    - host: git.example.com\n      token: x\n",
        )
        .unwrap();
        let lines = pipeline_lines(
            &cfg,
            &Err("Linear refused the API key in the secret linear".into()),
            &[("hp".into(), false)],
        );
        assert_eq!(
            lines,
            vec![
                (false, "pipeline: Linear refused the API key in the secret linear".into()),
                (true, "pipeline: finished tickets move to In Review in Linear, so the key needs write access".into()),
                (false, "pipeline: gh is not logged in on hp, so draft pull requests cannot be opened there (run gh auth login on hp)".into()),
                (true, "pipeline: draft merge requests on git.example.com need its token to have the api scope".into()),
            ]
        );
        let ok = pipeline_lines(&cfg, &Ok(3), &[("hp".into(), true)]);
        assert_eq!(
            ok[0],
            (
                true,
                "pipeline: Linear answers, 3 open tickets are yours".into()
            )
        );
        assert_eq!(ok[2], (true, "pipeline: gh is logged in on hp".into()));
    }

    #[test]
    fn no_pipeline_no_line() {
        let cfg: crate::config::Config =
            serde_yaml::from_str("machines:\n  - name: hp\n    local: true\n    root: /r\n")
                .unwrap();
        assert!(pipeline_lines(&cfg, &Ok(0), &[]).is_empty());
    }

    #[test]
    fn pmset_sleep_zero() {
        assert!(pmset_never_sleeps("System-wide power settings:\n Currently in use:\n standby              0\n sleep                0 (sleep prevented by powerd)\n displaysleep         10\n"));
        assert!(!pmset_never_sleeps(
            " Currently in use:\n sleep                1\n displaysleep         0\n"
        ));
        assert!(!pmset_never_sleeps(" displaysleep         0\n"));
    }

    #[test]
    fn ufw_hints_cover_port_and_prefixes() {
        let cfg = Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap();
        let hints = ufw_hints(&cfg);
        assert_eq!(
            hints[0],
            "sudo ufw allow in on nordlynx to any port 4000 proto tcp"
        );
        assert!(hints.contains(
            &"sudo ufw allow in on nordlynx to any port 10000:19999 proto tcp".to_string()
        ));
        assert!(hints.contains(
            &"sudo ufw allow in on nordlynx to any port 20000:29999 proto tcp".to_string()
        ));
        assert_eq!(hints.len(), 3);
    }
}
