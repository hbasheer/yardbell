use super::{field, fields, flag, Worktrees, TEMP_DIR};
use crate::config::Machine;
use crate::folders::{valid_branch, worktree_dir};
use crate::shell::{quote, Duration};
use serde::Serialize;

const TIMEOUT: Duration = Duration::from_secs(30);
const MOVE_TIMEOUT: Duration = Duration::from_secs(300);
const HAVES_MAX: usize = 2000;
const PACKAGE_MAX_BYTES: u64 = 50_000_000;

// The session's checkout as the machine it runs on sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Source {
    pub top: String,
    pub main: String,
    pub branch: String,
    pub head: String,
    pub origin: String,
    pub changes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Target {
    pub repo: String,
    pub origin: String,
    pub haves: Vec<String>,
}

// The branch's commits the target lacks, as a git bundle, and the uncommitted changes, as a
// binary diff, both in base64. Either can be empty.
#[derive(Debug, Clone, PartialEq)]
pub struct Package {
    pub branch: String,
    pub head: String,
    pub bundle: String,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Landed {
    pub path: String,
    pub created: bool,
    pub applied: bool,
}

fn decode_fn() -> &'static str {
    // macOS before 13 only knows -D.
    "unb64() { [ -s \"$1\" ] || { : >\"$2\"; return 0; }; base64 -d <\"$1\" >\"$2\" 2>/dev/null || base64 -D <\"$1\" >\"$2\"; }; "
}

pub fn source_script(cwd: &str) -> String {
    let cwd = quote(cwd);
    format!(
        "cd {cwd} 2>/dev/null || {{ echo 'ERR the session folder is gone: '{cwd}; exit 0; }}; \
         top=$(git rev-parse --show-toplevel 2>/dev/null) || {{ echo 'ERR the session is not in a git checkout'; exit 0; }}; \
         cd \"$top\"; b=$(git branch --show-current); \
         [ -n \"$b\" ] || {{ echo 'ERR the session folder is on a detached HEAD; Yardbell moves a branch'; exit 0; }}; \
         printf 'TOP\\t%s\\nMAIN\\t%s\\nBRANCH\\t%s\\nHEAD\\t%s\\nORIGIN\\t%s\\nCHANGES\\t%s\\n' \"$top\" \
         \"$(git worktree list --porcelain | sed -n '1s/^worktree //p')\" \"$b\" \"$(git rev-parse HEAD)\" \
         \"$(git remote get-url origin 2>/dev/null)\" \"$(git status --porcelain --untracked-files=all | wc -l | tr -d ' ')\""
    )
}

pub fn target_script(repo: &str) -> String {
    format!(
        "cd {repo} 2>/dev/null || {{ echo 'ERR there is no folder '{repo}; exit 0; }}; \
         git rev-parse --git-dir >/dev/null 2>&1 || {{ echo 'ERR '{repo}' is not a git checkout'; exit 0; }}; \
         printf 'REPO\\t%s\\nORIGIN\\t%s\\n' \"$(git worktree list --porcelain | sed -n '1s/^worktree //p')\" \"$(git remote get-url origin 2>/dev/null)\"; \
         git for-each-ref --sort=-committerdate --format='HAVE%09%(objectname)' refs/heads refs/remotes refs/tags | head -{HAVES_MAX}",
        repo = quote(repo),
    )
}

// The commits the target already has are left out of the bundle. git needs the bundle's
// prerequisites to be ancestors of what it carries, so only those are kept.
pub fn pack_script(top: &str) -> String {
    format!(
        "cd {top} 2>/dev/null || {{ echo 'ERR the session folder is gone: '{top}; exit 0; }}; \
         {TEMP_DIR}\
         b=$(git branch --show-current); head=$(git rev-parse HEAD); \
         [ -n \"$b\" ] || {{ echo 'ERR the session folder is on a detached HEAD; Yardbell moves a branch'; exit 0; }}; \
         cat >\"$tmp/haves\"; prereq=''; there=''; \
         while read -r h; do case \"$h\" in ''|*[!0-9a-f]*) continue ;; esac; \
         git cat-file -e \"$h^{{commit}}\" 2>/dev/null || continue; \
         if git merge-base --is-ancestor \"$h\" \"$head\"; then prereq=\"$prereq $h\"; \
         elif git merge-base --is-ancestor \"$head\" \"$h\"; then there=1; fi; done <\"$tmp/haves\"; \
         case \" $prereq \" in *\" $head \"*) there=1 ;; esac; \
         if [ -z \"$there\" ]; then \
         not=''; [ -n \"$prereq\" ] && for p in $(git merge-base --independent $prereq); do not=\"$not ^$p\"; done; \
         git bundle create \"$tmp/bundle\" \"refs/heads/$b\" $not >/dev/null 2>\"$tmp/err\" || {{ echo \"ERR git could not bundle the branch: $(tail -n 1 \"$tmp/err\")\"; exit 0; }}; \
         else : >\"$tmp/bundle\"; fi; \
         export GIT_INDEX_FILE=\"$tmp/index\"; \
         git read-tree HEAD && git add -A . && git diff --cached --binary --no-color --no-ext-diff HEAD >\"$tmp/patch\" || {{ echo 'ERR git could not collect the uncommitted changes'; exit 0; }}; \
         unset GIT_INDEX_FILE; \
         size=$(cat \"$tmp/bundle\" \"$tmp/patch\" | wc -c | tr -d ' '); \
         [ \"$size\" -gt {PACKAGE_MAX_BYTES} ] && {{ echo \"ERR the branch and its changes are $size bytes, over the {PACKAGE_MAX_BYTES} Yardbell moves\"; exit 0; }}; \
         printf 'BRANCH\\t%s\\nHEAD\\t%s\\n' \"$b\" \"$head\"; \
         printf 'BUNDLE\\t'; base64 <\"$tmp/bundle\" | tr -d '\\n'; echo; \
         printf 'PATCH\\t'; base64 <\"$tmp/patch\" | tr -d '\\n'; echo",
        top = quote(top),
    )
}

// The branch lands in a worktree of its own on the target, never in its main checkout, and an
// existing branch there only moves forward. A worktree made here and then left half done is
// removed again.
pub fn unpack_script(repo: &str, branch: &str, head: &str) -> String {
    let target = worktree_dir(repo, branch);
    let parent = target.rsplit_once('/').map(|(p, _)| p).unwrap_or(&target);
    format!(
        "cd {repo} 2>/dev/null || {{ echo 'ERR there is no folder '{repo}; exit 0; }}; \
         {TEMP_DIR}{decode}\
         b={b}; head={head}; wt={wt}; \
         cat >\"$tmp/in\"; sed -n 1p \"$tmp/in\" >\"$tmp/b64b\"; sed -n 2p \"$tmp/in\" >\"$tmp/b64p\"; \
         unb64 \"$tmp/b64b\" \"$tmp/bundle\" && unb64 \"$tmp/b64p\" \"$tmp/patch\" || {{ echo 'ERR the moved work arrived damaged'; exit 0; }}; \
         if [ -s \"$tmp/bundle\" ]; then \
         git bundle verify -q \"$tmp/bundle\" >/dev/null 2>\"$tmp/err\" || {{ echo \"ERR the target lacks commits the moved branch builds on: $(tail -n 1 \"$tmp/err\")\"; exit 0; }}; \
         git fetch -q \"$tmp/bundle\" \"refs/heads/$b\" 2>\"$tmp/err\" || {{ echo \"ERR git could not read the moved branch: $(tail -n 1 \"$tmp/err\")\"; exit 0; }}; fi; \
         git cat-file -e \"$head^{{commit}}\" 2>/dev/null || {{ echo 'ERR the moved branch did not arrive'; exit 0; }}; \
         main=$(git worktree list --porcelain | sed -n '1s/^worktree //p'); \
         checked=$(git worktree list --porcelain | awk -v r=\"branch refs/heads/$b\" '/^worktree /{{w=substr($0,10)}} $0==r {{print w}}'); \
         have=$(git rev-parse -q --verify \"refs/heads/$b\"); \
         if [ -n \"$checked\" ] && [ \"$checked\" = \"$main\" ]; then echo \"ERR $b is checked out in the main checkout $main; switch it to another branch first\"; exit 0; fi; \
         if [ -n \"$have\" ] && [ \"$have\" != \"$head\" ]; then \
         git merge-base --is-ancestor \"$have\" \"$head\" || {{ echo \"ERR branch $b here has commits the moved work does not; Yardbell does not overwrite them\"; exit 0; }}; \
         [ -n \"$checked\" ] && {{ echo \"ERR branch $b is checked out at $checked with older commits; remove that worktree or update it first\"; exit 0; }}; \
         git update-ref \"refs/heads/$b\" \"$head\" \"$have\" || exit 1; fi; \
         [ -n \"$have\" ] || git update-ref \"refs/heads/$b\" \"$head\" '' || exit 1; \
         created=0; \
         if [ -n \"$checked\" ]; then \
         [ -z \"$(git -C \"$checked\" status --porcelain | head -n 1)\" ] || {{ echo \"ERR $checked already has changes of its own\"; exit 0; }}; path=$checked; \
         else mkdir -p {parent}; git worktree add -q \"$wt\" \"$b\" >&2 || {{ echo \"ERR git could not make a worktree at $wt\"; exit 0; }}; path=$wt; created=1; fi; \
         applied=0; \
         if [ -s \"$tmp/patch\" ]; then \
         if git -C \"$path\" apply --binary --whitespace=nowarn \"$tmp/patch\" 2>\"$tmp/err\"; then applied=1; \
         else [ $created = 1 ] && git worktree remove --force \"$path\" >/dev/null 2>&1; \
         echo \"ERR the uncommitted changes did not apply: $(tail -n 1 \"$tmp/err\")\"; exit 0; fi; fi; \
         printf 'PATH\\t%s\\n' \"$path\"; [ $created = 1 ] && echo CREATED; [ $applied = 1 ] && echo APPLIED; true",
        repo = quote(repo),
        decode = decode_fn(),
        b = quote(branch),
        head = quote(head),
        wt = quote(&target),
        parent = quote(parent),
    )
}

fn hex(sha: &str) -> bool {
    (7..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

// Clones of one repository can name origin differently (ssh or https, with or without .git).
pub fn same_origin(a: &str, b: &str) -> bool {
    let norm = |url: &str| {
        let url = url.trim().trim_end_matches('/').trim_end_matches(".git");
        let url = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
        let url = url.rsplit_once('@').map(|(_, host)| host).unwrap_or(url);
        url.replacen(':', "/", 1).to_lowercase()
    };
    a.trim().is_empty() || b.trim().is_empty() || norm(a) == norm(b)
}

impl Worktrees {
    pub async fn source(&self, m: &Machine, cwd: &str) -> Result<Source, String> {
        let out = self.run(m, &source_script(cwd), None, TIMEOUT).await?;
        let get = |key| field(&out, key).unwrap_or_default().to_string();
        let src = Source {
            top: get("TOP"),
            main: get("MAIN"),
            branch: get("BRANCH"),
            head: get("HEAD"),
            origin: get("ORIGIN"),
            changes: field(&out, "CHANGES")
                .and_then(|c| c.trim().parse().ok())
                .unwrap_or(0),
        };
        if src.top.is_empty() || !hex(&src.head) {
            return Err(format!("git did not describe {cwd} on {}", m.name));
        }
        if !valid_branch(&src.branch) {
            return Err(format!(
                "branch {:?} has a name Yardbell does not move",
                src.branch
            ));
        }
        Ok(src)
    }

    pub async fn target(&self, m: &Machine, repo: &str) -> Result<Target, String> {
        let out = self.run(m, &target_script(repo), None, TIMEOUT).await?;
        Ok(Target {
            repo: field(&out, "REPO").unwrap_or(repo).to_string(),
            origin: field(&out, "ORIGIN").unwrap_or_default().to_string(),
            haves: fields(&out, "HAVE")
                .filter(|h| hex(h))
                .map(str::to_string)
                .collect(),
        })
    }

    pub async fn pack(
        &self,
        m: &Machine,
        src: &Source,
        haves: &[String],
    ) -> Result<Package, String> {
        let input = haves.join("\n") + "\n";
        let out = self
            .run(m, &pack_script(&src.top), Some(input), MOVE_TIMEOUT)
            .await?;
        let branch = field(&out, "BRANCH").unwrap_or_default().to_string();
        let head = field(&out, "HEAD").unwrap_or_default().to_string();
        if branch != src.branch || head != src.head {
            return Err(format!(
                "{} changed branch or commit while it was being moved; try again",
                src.top
            ));
        }
        Ok(Package {
            branch,
            head,
            bundle: field(&out, "BUNDLE").unwrap_or_default().trim().to_string(),
            patch: field(&out, "PATCH").unwrap_or_default().trim().to_string(),
        })
    }

    pub async fn unpack(&self, m: &Machine, repo: &str, pkg: &Package) -> Result<Landed, String> {
        if !valid_branch(&pkg.branch) || !hex(&pkg.head) {
            return Err("the moved branch has a bad name or commit".into());
        }
        let input = format!("{}\n{}\n", pkg.bundle, pkg.patch);
        let out = self
            .run(
                m,
                &unpack_script(repo, &pkg.branch, &pkg.head),
                Some(input),
                MOVE_TIMEOUT,
            )
            .await?;
        let path = field(&out, "PATH").ok_or("git did not report where the work landed")?;
        Ok(Landed {
            path: path.to_string(),
            created: flag(&out, "CREATED"),
            applied: flag(&out, "APPLIED"),
        })
    }

    // The work goes through Yardbell, from one machine's ssh session to the other's: no remote
    // is pushed to and nothing is committed on either side.
    pub async fn hand_over(
        &self,
        from: &Machine,
        cwd: &str,
        to: &Machine,
        repo: &str,
    ) -> Result<(Source, Landed), String> {
        let src = self.source(from, cwd).await?;
        let landed = self.deliver(from, &src, to, repo).await?;
        Ok((src, landed))
    }

    pub async fn deliver(
        &self,
        from: &Machine,
        src: &Source,
        to: &Machine,
        repo: &str,
    ) -> Result<Landed, String> {
        let target = self.target(to, repo).await?;
        if !same_origin(&src.origin, &target.origin) {
            return Err(format!(
                "{} on {} and {} on {} are clones of different repositories ({} and {})",
                src.top, from.name, target.repo, to.name, src.origin, target.origin
            ));
        }
        let pkg = self.pack(from, src, &target.haves).await?;
        self.unpack(to, &target.repo, &pkg).await
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::machine;
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn origins_match_across_url_styles() {
        assert!(same_origin(
            "git@github.com:acme/web.git",
            "https://github.com/acme/web"
        ));
        assert!(same_origin(
            "ssh://git@github.com/acme/web.git",
            "git@github.com:acme/web"
        ));
        assert!(same_origin("", "git@github.com:acme/web"));
        assert!(!same_origin(
            "git@github.com:acme/web.git",
            "git@github.com:acme/api.git"
        ));
    }

    #[tokio::test]
    async fn the_package_goes_from_one_machine_to_the_other_unchanged() {
        let fake = Arc::new(FakeRunner::default());
        let src_out = format!(
            "TOP\t/r/app-worktrees/eng-1\nMAIN\t/r/app\nBRANCH\teng-1\nHEAD\t{HEAD}\nORIGIN\tgit@github.com:acme/app.git\nCHANGES\t2\n"
        );
        fake.stub("CHANGES", Output::ok_with(&src_out));
        fake.stub(
            "for-each-ref",
            Output::ok_with("REPO\t/s/app\nORIGIN\thttps://github.com/acme/app\nHAVE\taaaaaaa1111111\nHAVE\tnot-a-sha\n"),
        );
        fake.stub(
            "git bundle create",
            Output::ok_with(&format!(
                "BRANCH\teng-1\nHEAD\t{HEAD}\nBUNDLE\tQlVORExF\nPATCH\tUEFUQ0g=\n"
            )),
        );
        fake.stub(
            "git bundle verify",
            Output::ok_with("PATH\t/s/app-worktrees/eng-1\nCREATED\nAPPLIED\n"),
        );
        let w = Worktrees::new(
            fake.clone(),
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        let (src, landed) = w
            .hand_over(
                &machine("hp"),
                "/r/app-worktrees/eng-1/src",
                &machine("mini"),
                "/s/app",
            )
            .await
            .unwrap();
        assert_eq!(src.changes, 2);
        assert_eq!(
            landed,
            Landed {
                path: "/s/app-worktrees/eng-1".into(),
                created: true,
                applied: true
            }
        );
        let calls = fake.calls();
        assert_eq!(calls.len(), 4);
        assert!(calls[0].contains(&"hp".to_string()) && calls[3].contains(&"mini".to_string()));
        let inputs = fake.inputs();
        assert_eq!(
            inputs[2].as_deref(),
            Some("aaaaaaa1111111\n"),
            "only real commit ids are offered"
        );
        assert_eq!(inputs[3].as_deref(), Some("QlVORExF\nUEFUQ0g=\n"));
        let unpack = calls[3].last().unwrap();
        assert!(unpack.contains("wt='/s/app-worktrees/eng-1'"), "{unpack}");
        assert!(
            !unpack.contains("git push") && !unpack.contains("commit -"),
            "{unpack}"
        );
    }

    #[tokio::test]
    async fn different_repositories_are_refused_before_anything_moves() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "CHANGES",
            Output::ok_with(&format!("TOP\t/r/app\nMAIN\t/r/app\nBRANCH\teng-1\nHEAD\t{HEAD}\nORIGIN\tgit@github.com:acme/app.git\n")),
        );
        fake.stub(
            "for-each-ref",
            Output::ok_with("REPO\t/s/api\nORIGIN\tgit@github.com:acme/api.git\n"),
        );
        let w = Worktrees::new(
            fake.clone(),
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        let err = w
            .hand_over(&machine("hp"), "/r/app", &machine("mini"), "/s/api")
            .await
            .unwrap_err();
        assert!(err.contains("clones of different repositories"), "{err}");
        assert_eq!(fake.calls().len(), 2);
    }
}
