use super::cleanup::RemoveError;
use super::integrate::{Integration, Method};
use super::testing::local;
use super::Worktrees;
use crate::folders::Folders;
use crate::shell::RealRunner;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn commit(dir: &Path, file: &str, text: &str, message: &str) {
    write(&dir.join(file), text);
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
}

struct Rig {
    dir: tempfile::TempDir,
    worktrees: Worktrees,
    folders: Folders,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(RealRunner::default());
    let ssh = crate::ssh::Ssh::new(dir.path().join("state"));
    Rig {
        worktrees: Worktrees::new(runner.clone(), ssh.clone()),
        folders: Folders::new(runner, ssh),
        dir,
    }
}

fn repo(at: &Path) -> String {
    git(
        at.parent().unwrap(),
        &["init", "-q", "-b", "main", at.to_str().unwrap()],
    );
    commit(at, "app.txt", "one\ntwo\nthree\n", "init");
    at.to_str().unwrap().to_string()
}

#[tokio::test]
async fn integrate_merges_in_order_and_stops_at_a_conflict() {
    let r = rig();
    let app = r.dir.path().join("app");
    let path = repo(&app);
    for (branch, file, text) in [
        ("eng-1-api", "api.txt", "api\n"),
        ("eng-1-web", "web.txt", "web\n"),
        ("eng-1-clash", "app.txt", "one\nCLASH\nthree\n"),
        ("eng-1-late", "late.txt", "late\n"),
    ] {
        git(&app, &["checkout", "-q", "-b", branch, "main"]);
        commit(&app, file, text, branch);
    }
    git(&app, &["checkout", "-q", "main"]);
    commit(&app, "app.txt", "one\nMAIN\nthree\n", "main moves on");
    let m = local("here", r.dir.path().to_str().unwrap());
    for method in [Method::Merge, Method::Rebase] {
        let into = format!("together-{method:?}").to_lowercase();
        let plan = Integration {
            base: "main".into(),
            branches: ["eng-1-api", "eng-1-web", "eng-1-clash", "eng-1-late"]
                .map(String::from)
                .to_vec(),
            into: into.clone(),
            method,
        };
        let done = r
            .worktrees
            .integrate(&r.folders, &m, &path, &plan)
            .await
            .unwrap();
        assert_eq!(done.merged, ["eng-1-api", "eng-1-web"], "{method:?}");
        let conflict = done.conflict.clone().unwrap();
        assert_eq!(conflict.branch, "eng-1-clash");
        assert_eq!(conflict.files, ["app.txt"]);
        assert_eq!(done.pending, ["eng-1-late"]);
        let wt = Path::new(&done.path);
        assert!(wt.join("api.txt").exists() && wt.join("web.txt").exists());
        assert_eq!(
            git(wt, &["status", "--porcelain"]),
            "",
            "the conflict was undone"
        );
        assert_eq!(git(wt, &["branch", "--show-current"]), into);
        assert_eq!(git(&app, &["branch", "--show-current"]), "main");
        assert_eq!(
            std::fs::read_to_string(app.join("app.txt")).unwrap(),
            "one\nMAIN\nthree\n"
        );
    }
}

#[tokio::test]
async fn handoff_moves_commits_and_uncommitted_changes_without_pushing() {
    let r = rig();
    let origin = r.dir.path().join("origin.git");
    git(
        r.dir.path(),
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            origin.to_str().unwrap(),
        ],
    );
    let seed = r.dir.path().join("seed");
    repo(&seed);
    git(
        &seed,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&seed, &["push", "-q", "origin", "main"]);
    let from = r.dir.path().join("hp");
    let to = r.dir.path().join("mini");
    std::fs::create_dir_all(&from).unwrap();
    std::fs::create_dir_all(&to).unwrap();
    git(&from, &["clone", "-q", origin.to_str().unwrap(), "app"]);
    git(&to, &["clone", "-q", origin.to_str().unwrap(), "app"]);
    let src = from.join("app");
    git(&src, &["checkout", "-q", "-b", "eng-7-move"]);
    commit(&src, "feature.txt", "committed\n", "feature");
    std::fs::write(src.join("app.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    write(&src.join("new/notes.md"), "not committed yet\n");
    std::fs::write(src.join("logo.bin"), [0u8, 159, 146, 150, 255, 0, 1]).unwrap();
    git(&src, &["add", "app.txt"]);
    let index_before = std::fs::read(src.join(".git/index")).unwrap();

    let hp = local("hp", from.to_str().unwrap());
    let mini = local("mini", to.to_str().unwrap());
    let target_repo = to.join("app");
    let (moved, landed) = r
        .worktrees
        .hand_over(
            &hp,
            src.to_str().unwrap(),
            &mini,
            target_repo.to_str().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(moved.branch, "eng-7-move");
    assert!(landed.created && landed.applied, "{landed:?}");
    let wt = Path::new(&landed.path);
    assert_eq!(
        landed.path,
        crate::folders::worktree_dir(target_repo.to_str().unwrap(), "eng-7-move")
    );
    assert_eq!(git(wt, &["rev-parse", "HEAD"]), moved.head);
    assert_eq!(
        std::fs::read_to_string(wt.join("feature.txt")).unwrap(),
        "committed\n"
    );
    assert_eq!(
        std::fs::read_to_string(wt.join("app.txt")).unwrap(),
        "one\ntwo\nthree\nfour\n"
    );
    assert_eq!(
        std::fs::read_to_string(wt.join("new/notes.md")).unwrap(),
        "not committed yet\n"
    );
    assert_eq!(
        std::fs::read(wt.join("logo.bin")).unwrap(),
        [0u8, 159, 146, 150, 255, 0, 1]
    );
    assert_eq!(git(&target_repo, &["branch", "--show-current"]), "main");
    assert_eq!(git(&target_repo, &["status", "--porcelain"]), "");
    assert_eq!(
        git(&origin, &["branch", "--list", "eng-7-move"]),
        "",
        "nothing reached the remote"
    );
    assert_eq!(std::fs::read(src.join(".git/index")).unwrap(), index_before);
    assert_eq!(git(&src, &["log", "-1", "--format=%s"]), "feature");

    let again = r
        .worktrees
        .hand_over(
            &hp,
            src.to_str().unwrap(),
            &mini,
            target_repo.to_str().unwrap(),
        )
        .await
        .unwrap_err();
    assert!(again.contains("already has changes of its own"), "{again}");
}

#[tokio::test]
async fn cleanup_counts_only_work_that_would_be_lost() {
    let r = rig();
    let app = r.dir.path().join("app");
    let path = repo(&app);
    let m = local("here", r.dir.path().to_str().unwrap());
    let pick = crate::folders::Pick {
        branch: "eng-9".into(),
        new_branch: true,
        base: "main".into(),
    };
    let wt = r.folders.prepare(&m, &path, &pick, "main").await.unwrap();
    assert!(wt.created);
    let ins = r.worktrees.inspect(&m, &wt.path).await.unwrap();
    assert!(ins.linked && !ins.at_risk(), "{ins:?}");
    assert_eq!(ins.main, path);
    assert_eq!(ins.merged_into, "main");

    commit(Path::new(&wt.path), "x.txt", "x\n", "work");
    write(&Path::new(&wt.path).join("y.txt"), "y\n");
    let ins = r.worktrees.inspect(&m, &wt.path).await.unwrap();
    assert_eq!(ins.dirty, ["?? y.txt"]);
    assert_eq!(ins.unpushed.len(), 1, "{ins:?}");
    assert_eq!(ins.merged_into, "");
    let refused = r.worktrees.remove(&m, &ins, false, true).await.unwrap_err();
    assert!(matches!(refused, RemoveError::AtRisk(_)));
    assert!(Path::new(&wt.path).exists());

    let main = r.worktrees.inspect(&m, &path).await.unwrap();
    let err = r.worktrees.remove(&m, &main, true, true).await.unwrap_err();
    assert!(matches!(err, RemoveError::MainCheckout(_)));

    let done = r.worktrees.remove(&m, &ins, true, true).await.unwrap();
    assert!(!done.branch_deleted, "an unmerged branch stays");
    assert!(!Path::new(&wt.path).exists());
    assert!(app.join("app.txt").exists());
    assert_eq!(git(&app, &["branch", "--list", "eng-9"]), "eng-9");
}
