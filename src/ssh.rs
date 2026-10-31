use crate::config::Machine;
use std::path::PathBuf;

pub const REMOTE_PATH: &str =
    r#"PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/snap/bin:$HOME/.local/bin"; export PATH; "#;

const SOCKET_PATH_MAX: usize = 100;
const CONTROL_HASH_LEN: usize = 40;

#[derive(Debug, Clone)]
pub struct Ssh {
    cm_dir: PathBuf,
}

fn control_dir(state_dir: &std::path::Path) -> PathBuf {
    let preferred = state_dir.join("cm");
    if preferred.as_os_str().len() + 1 + CONTROL_HASH_LEN < SOCKET_PATH_MAX {
        return preferred;
    }
    PathBuf::from(format!("/tmp/yardbell-cm-{}", unsafe { libc::getuid() }))
}

impl Ssh {
    pub fn new(state_dir: PathBuf) -> Ssh {
        let cm_dir = control_dir(&state_dir);
        if std::fs::create_dir_all(&cm_dir).is_ok() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&cm_dir, std::fs::Permissions::from_mode(0o700));
        }
        Ssh { cm_dir }
    }

    pub fn base(&self) -> Vec<String> {
        let cm = format!("ControlPath={}/%C", self.cm_dir.display());
        [
            "-o",
            "ControlMaster=auto",
            "-o",
            &cm,
            "-o",
            "ControlPersist=60",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=3",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=3",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    pub fn command(&self, m: &Machine, remote: &str) -> Vec<String> {
        if m.is_local() {
            return vec!["bash".into(), "-c".into(), remote.into()];
        }
        let mut argv = vec!["ssh".to_string()];
        argv.extend(self.base());
        argv.push(m.ssh_host().into());
        argv.push(format!("{REMOTE_PATH}{remote}"));
        argv
    }

    pub fn exit_master(&self, m: &Machine) -> Vec<String> {
        let mut argv = vec!["ssh".to_string()];
        argv.extend(self.base());
        argv.extend(["-O".into(), "exit".into(), m.ssh_host().into()]);
        argv
    }

    pub fn tty_command(&self, m: &Machine, remote: &str) -> Vec<String> {
        let mut argv = self.command(m, remote);
        if !m.is_local() {
            argv.insert(1, "-t".into());
        }
        argv
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Machine;

    fn machine(local: bool) -> Machine {
        Machine {
            name: "hp".into(),
            ssh: Some("hp-host".into()),
            mesh_ip: None,
            port_prefix: if local { None } else { Some(1) },
            root: "/r".into(),
            local,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        }
    }

    #[test]
    fn ssh_command_remote() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = Ssh::new(dir.path().to_path_buf());
        let cm = format!("ControlPath={}/%C", control_dir(dir.path()).display());
        assert_eq!(
            ssh.command(&machine(false), "true"),
            vec![
                "ssh",
                "-o",
                "ControlMaster=auto",
                "-o",
                &cm,
                "-o",
                "ControlPersist=60",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=3",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=3",
                "hp-host",
                r#"PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/snap/bin:$HOME/.local/bin"; export PATH; true"#
            ]
        );
        assert!(control_dir(dir.path()).is_dir());
    }

    #[test]
    fn control_path_stays_under_socket_limit() {
        let long = std::path::PathBuf::from(format!("/tmp/{}", "x".repeat(90)));
        let ssh = Ssh::new(long);
        let opt = ssh
            .base()
            .into_iter()
            .find(|o| o.starts_with("ControlPath="))
            .unwrap();
        let path = opt
            .trim_start_matches("ControlPath=")
            .replace("%C", &"c".repeat(40));
        assert!(path.len() < 100, "{path} is {} bytes", path.len());
        let dir = std::path::Path::new(&path).parent().unwrap().to_path_buf();
        assert!(dir.is_dir());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn exit_master_argv() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = Ssh::new(dir.path().to_path_buf());
        let argv = ssh.exit_master(&machine(false));
        assert_eq!(argv[0], "ssh");
        assert_eq!(&argv[argv.len() - 3..], ["-O", "exit", "hp-host"]);
    }

    #[test]
    fn ssh_tty_command_adds_t() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = Ssh::new(dir.path().to_path_buf());
        let argv = ssh.tty_command(&machine(false), "tmux attach");
        assert_eq!(argv[1], "-t");
        assert!(argv.last().unwrap().ends_with("; tmux attach"));
    }

    #[test]
    fn ssh_command_local_uses_bash() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = Ssh::new(dir.path().to_path_buf());
        assert_eq!(
            ssh.command(&machine(true), "true"),
            vec!["bash", "-c", "true"]
        );
    }
}
