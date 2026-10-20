use crate::config::expand_tilde;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

const LABEL: &str = "com.yardbell.server";

pub struct ServiceSpec {
    pub exe: PathBuf,
    pub config: PathBuf,
    pub workdir: PathBuf,
    pub path_env: String,
    pub log: PathBuf,
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn s(path: &Path) -> String {
    xml(&path.display().to_string())
}

pub fn plist(spec: &ServiceSpec) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>--config</string>
    <string>{config}</string>
    <string>serve</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        exe = s(&spec.exe),
        config = s(&spec.config),
        workdir = s(&spec.workdir),
        path = xml(&spec.path_env),
        log = s(&spec.log),
    )
}

pub fn systemd_unit(spec: &ServiceSpec) -> String {
    format!(
        "[Unit]\nDescription=Yardbell\nAfter=network-online.target\n\n[Service]\nExecStart=\"{exe}\" --config \"{config}\" serve --no-open\nWorkingDirectory={workdir}\nEnvironment=\"PATH={path}\"\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
        exe = spec.exe.display(),
        config = spec.config.display(),
        workdir = spec.workdir.display(),
        path = spec.path_env,
    )
}

fn plist_path() -> PathBuf {
    expand_tilde(&format!("~/Library/LaunchAgents/{LABEL}.plist"))
}

fn unit_path() -> PathBuf {
    expand_tilde("~/.config/systemd/user/yardbell.service")
}

pub fn installed() -> bool {
    if cfg!(target_os = "macos") {
        plist_path().exists()
    } else {
        unit_path().exists()
    }
}

pub fn restart_argv() -> Vec<String> {
    if cfg!(target_os = "macos") {
        vec![
            "launchctl".into(),
            "kickstart".into(),
            "-k".into(),
            format!("gui/{}/{LABEL}", uid()),
        ]
    } else {
        vec![
            "systemctl".into(),
            "--user".into(),
            "restart".into(),
            "yardbell".into(),
        ]
    }
}

pub fn in_docker() -> bool {
    Path::new("/.dockerenv").exists()
}

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

fn run(cmd: &mut Command) -> Result<()> {
    let out = cmd
        .output()
        .with_context(|| format!("cannot run {cmd:?}"))?;
    if !out.status.success() {
        bail!(
            "{cmd:?} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

pub fn install(config: &Path) -> Result<()> {
    if in_docker() {
        bail!("inside Docker, use `restart: unless-stopped` in the compose file instead");
    }
    let config =
        std::fs::canonicalize(config).with_context(|| format!("{} not found", config.display()))?;
    let spec = ServiceSpec {
        exe: std::env::current_exe()?,
        config,
        workdir: expand_tilde("~"),
        path_env: std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        log: expand_tilde("~/Library/Logs/yardbell.log"),
    };
    if cfg!(target_os = "macos") {
        let path = plist_path();
        std::fs::create_dir_all(path.parent().expect("plist dir"))?;
        std::fs::write(&path, plist(&spec))?;
        let domain = format!("gui/{}", uid());
        let _ = Command::new("launchctl")
            .args(["bootout", &domain, &path.display().to_string()])
            .output();
        run(Command::new("launchctl").args(["bootstrap", &domain, &path.display().to_string()]))?;
        println!(
            "Installed {}. Yardbell now starts at login, logs in {}",
            path.display(),
            spec.log.display()
        );
        return Ok(());
    }
    let path = unit_path();
    std::fs::create_dir_all(path.parent().expect("unit dir"))?;
    std::fs::write(&path, systemd_unit(&spec))?;
    run(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
    run(Command::new("systemctl").args(["--user", "enable", "--now", "yardbell"]))?;
    println!(
        "Installed {}. Logs: journalctl --user -u yardbell",
        path.display()
    );
    Ok(())
}

pub fn uninstall() -> Result<()> {
    if cfg!(target_os = "macos") {
        let path = plist_path();
        let _ = Command::new("launchctl")
            .args([
                "bootout",
                &format!("gui/{}", uid()),
                &path.display().to_string(),
            ])
            .output();
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        println!("Removed {}", path.display());
        return Ok(());
    }
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", "yardbell"])
        .output();
    let path = unit_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();
    println!("Removed {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            exe: PathBuf::from("/Users/u/bin/yardbell"),
            config: PathBuf::from("/Users/u/.config/yardbell/yardbell.yml"),
            workdir: PathBuf::from("/Users/u"),
            path_env: "/opt/homebrew/bin:/usr/bin:/bin".into(),
            log: PathBuf::from("/Users/u/Library/Logs/yardbell.log"),
        }
    }

    #[test]
    fn plist_has_required_keys() {
        let p = plist(&spec());
        assert!(p.contains("<string>com.yardbell.server</string>"));
        assert!(p.contains("<string>/Users/u/bin/yardbell</string>\n    <string>--config</string>\n    <string>/Users/u/.config/yardbell/yardbell.yml</string>\n    <string>serve</string>\n    <string>--no-open</string>"));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(p.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(p.contains("<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>"));
        assert_eq!(
            p.matches("<string>/Users/u/Library/Logs/yardbell.log</string>")
                .count(),
            2
        );
    }

    #[test]
    fn plist_escapes_xml() {
        let mut s = spec();
        s.config = PathBuf::from("/Users/u/a&b<c>.yml");
        assert!(plist(&s).contains("<string>/Users/u/a&amp;b&lt;c&gt;.yml</string>"));
    }

    #[test]
    fn systemd_unit_contents() {
        let u = systemd_unit(&spec());
        assert!(u.contains("ExecStart=\"/Users/u/bin/yardbell\" --config \"/Users/u/.config/yardbell/yardbell.yml\" serve --no-open"));
        assert!(u.contains("Restart=always"));
        assert!(u.contains("Environment=\"PATH=/opt/homebrew/bin:/usr/bin:/bin\""));
        assert!(u.contains("WantedBy=default.target"));
    }
}
