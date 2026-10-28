use crate::auth::Clock;
use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");
const ASK_FOR: Duration = Duration::from_secs(5);
const KEEP_FOR: Duration = Duration::from_secs(3600);

pub type Fetch = Arc<dyn Fn() -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Check {
    UpToDate { latest: String },
    Available { latest: String, url: String },
    Unknown { reason: String },
}

pub struct Updates {
    fetch: Fetch,
    clock: Clock,
    cached: tokio::sync::Mutex<Option<(Instant, Release)>>,
}

impl Updates {
    pub fn new(fetch: Fetch, clock: Clock) -> Updates {
        Updates {
            fetch,
            clock,
            cached: tokio::sync::Mutex::new(None),
        }
    }

    // GitHub allows 60 unauthenticated requests an hour per address, so an answer is kept an
    // hour and one caller asks at a time. A failure is not kept, so trying again asks again.
    pub async fn check(&self, current: &str) -> Check {
        let mut cached = self.cached.lock().await;
        let now = (self.clock)();
        let fresh = cached
            .as_ref()
            .filter(|(at, _)| now.saturating_duration_since(*at) < KEEP_FOR)
            .map(|(_, release)| release.clone());
        let release = match fresh {
            Some(release) => release,
            None => match self.ask().await {
                Ok(release) => {
                    *cached = Some((now, release.clone()));
                    release
                }
                Err(reason) => return Check::Unknown { reason },
            },
        };
        compare(current, release)
    }

    async fn ask(&self) -> Result<Release, String> {
        let body = tokio::time::timeout(ASK_FOR, (self.fetch)())
            .await
            .map_err(|_| format!("GitHub did not answer within {} seconds", ASK_FOR.as_secs()))??;
        latest(&body).ok_or_else(|| "GitHub's answer named no release".to_string())
    }
}

pub fn github() -> Fetch {
    Arc::new(|| {
        Box::pin(async {
            let repo = REPOSITORY.trim_start_matches("https://github.com/");
            let res = reqwest::Client::new()
                .get(format!(
                    "https://api.github.com/repos/{repo}/releases/latest"
                ))
                .header(reqwest::header::USER_AGENT, format!("yardbell/{VERSION}"))
                .header(reqwest::header::ACCEPT, "application/vnd.github+json")
                .timeout(ASK_FOR)
                .send()
                .await
                .map_err(|e| format!("cannot reach GitHub: {e}"))?;
            if !res.status().is_success() {
                return Err(format!("GitHub answered {}", res.status()));
            }
            res.json().await.map_err(|e| e.to_string())
        })
    })
}

pub fn latest(body: &Value) -> Option<Release> {
    let tag = body["tag_name"].as_str()?;
    let version = tag.strip_prefix('v').unwrap_or(tag);
    parse(version)?;
    let url = body["html_url"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| release_notes(version));
    Some(Release {
        version: version.to_string(),
        url,
    })
}

fn compare(current: &str, release: Release) -> Check {
    match (parse(&release.version), parse(current)) {
        (Some(latest), Some(running)) if latest > running => Check::Available {
            latest: release.version,
            url: release.url,
        },
        (Some(_), Some(_)) => Check::UpToDate {
            latest: release.version,
        },
        _ => Check::Unknown {
            reason: format!("can't compare {current} with {}", release.version),
        },
    }
}

// A pre-release suffix is dropped: releases are only ever tagged as plain x.y.z.
fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let found = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(found)
}

pub fn release_notes(version: &str) -> String {
    format!("{REPOSITORY}/releases/tag/v{version}")
}

pub fn changelog() -> String {
    format!("{REPOSITORY}/blob/main/CHANGELOG.md")
}

pub fn docs(version: &str) -> String {
    format!("{REPOSITORY}/tree/v{version}/docs")
}

pub fn os_name() -> String {
    let named = if cfg!(target_os = "macos") {
        mac_version(Path::new(
            "/System/Library/CoreServices/SystemVersion.plist",
        ))
    } else {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|text| pretty_name(&text))
    };
    named.unwrap_or_else(|| std::env::consts::OS.to_string())
}

fn pretty_name(os_release: &str) -> Option<String> {
    os_release
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|name| !name.is_empty())
}

fn mac_version(plist: &Path) -> Option<String> {
    let text = std::fs::read_to_string(plist).ok()?;
    let after = text.split("<key>ProductVersion</key>").nth(1)?;
    let value = after.split("<string>").nth(1)?.split("</string>").next()?;
    Some(format!("macOS {}", value.trim()))
}

pub fn in_container() -> bool {
    Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn release(tag: &str) -> Value {
        json!({
            "tag_name": tag,
            "html_url": format!("https://github.com/hbasheer/yardbell/releases/tag/{tag}"),
        })
    }

    struct Rig {
        updates: Updates,
        asked: Arc<AtomicUsize>,
        answer: Arc<Mutex<Result<Value, String>>>,
        now: Arc<Mutex<Instant>>,
    }

    impl Rig {
        fn new(answer: Result<Value, String>) -> Rig {
            let asked = Arc::new(AtomicUsize::new(0));
            let answer = Arc::new(Mutex::new(answer));
            let now = Arc::new(Mutex::new(Instant::now()));
            let fetch: Fetch = {
                let (asked, answer) = (asked.clone(), answer.clone());
                Arc::new(move || {
                    asked.fetch_add(1, Ordering::SeqCst);
                    let answer = answer.lock().unwrap().clone();
                    Box::pin(async move { answer })
                })
            };
            let clock: Clock = {
                let now = now.clone();
                Arc::new(move || *now.lock().unwrap())
            };
            Rig {
                updates: Updates::new(fetch, clock),
                asked,
                answer,
                now,
            }
        }

        fn asked(&self) -> usize {
            self.asked.load(Ordering::SeqCst)
        }

        fn advance(&self, secs: u64) {
            *self.now.lock().unwrap() += Duration::from_secs(secs);
        }
    }

    #[test]
    fn versions_compare_as_numbers() {
        assert_eq!(parse("0.6.9"), Some((0, 6, 9)));
        assert_eq!(parse("0.10.0-rc.1"), Some((0, 10, 0)));
        assert!(parse("0.10.0") > parse("0.9.12"));
        for bad in ["", "0.6", "0.6.9.1", "v0.6.9", "x.y.z", "0..1"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_latest_release_is_read_from_githubs_answer() {
        assert_eq!(
            latest(&release("v0.7.1")),
            Some(Release {
                version: "0.7.1".into(),
                url: "https://github.com/hbasheer/yardbell/releases/tag/v0.7.1".into(),
            })
        );
        assert_eq!(
            latest(&json!({ "tag_name": "0.7.1" })).map(|r| r.url),
            Some(release_notes("0.7.1"))
        );
        assert_eq!(latest(&json!({ "message": "Not Found" })), None);
        assert_eq!(latest(&json!({ "tag_name": "nightly" })), None);
    }

    #[test]
    fn links_point_at_this_versions_tag() {
        assert_eq!(REPOSITORY, "https://github.com/hbasheer/yardbell");
        assert_eq!(
            release_notes("0.6.9"),
            "https://github.com/hbasheer/yardbell/releases/tag/v0.6.9"
        );
        assert_eq!(
            docs("0.6.9"),
            "https://github.com/hbasheer/yardbell/tree/v0.6.9/docs"
        );
    }

    #[tokio::test]
    async fn a_newer_release_is_available_and_the_same_one_is_up_to_date() {
        let rig = Rig::new(Ok(release("v0.7.1")));
        assert_eq!(
            rig.updates.check("0.6.9").await,
            Check::Available {
                latest: "0.7.1".into(),
                url: "https://github.com/hbasheer/yardbell/releases/tag/v0.7.1".into(),
            }
        );
        assert_eq!(
            rig.updates.check("0.7.1").await,
            Check::UpToDate {
                latest: "0.7.1".into()
            }
        );
        assert_eq!(
            rig.updates.check("0.8.0").await,
            Check::UpToDate {
                latest: "0.7.1".into()
            }
        );
    }

    #[tokio::test]
    async fn the_answer_is_kept_an_hour() {
        let rig = Rig::new(Ok(release("v0.7.1")));
        rig.updates.check(VERSION).await;
        rig.advance(3599);
        *rig.answer.lock().unwrap() = Ok(release("v0.7.2"));
        assert!(matches!(
            rig.updates.check("0.6.9").await,
            Check::Available { latest, .. } if latest == "0.7.1"
        ));
        assert_eq!(rig.asked(), 1);
        rig.advance(1);
        assert!(matches!(
            rig.updates.check("0.6.9").await,
            Check::Available { latest, .. } if latest == "0.7.2"
        ));
        assert_eq!(rig.asked(), 2);
    }

    #[tokio::test]
    async fn a_failure_says_why_and_is_not_kept() {
        let rig = Rig::new(Err("GitHub answered 403 Forbidden".into()));
        assert_eq!(
            rig.updates.check("0.6.9").await,
            Check::Unknown {
                reason: "GitHub answered 403 Forbidden".into()
            }
        );
        *rig.answer.lock().unwrap() = Ok(json!({ "message": "Not Found" }));
        assert_eq!(
            rig.updates.check("0.6.9").await,
            Check::Unknown {
                reason: "GitHub's answer named no release".into()
            }
        );
        *rig.answer.lock().unwrap() = Ok(release("v0.6.9"));
        assert!(matches!(
            rig.updates.check("0.6.9").await,
            Check::UpToDate { .. }
        ));
        assert_eq!(rig.asked(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_answer_gives_up_after_five_seconds() {
        let fetch: Fetch = Arc::new(|| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(release("v9.9.9"))
            })
        });
        let updates = Updates::new(fetch, Arc::new(Instant::now));
        assert_eq!(
            updates.check("0.6.9").await,
            Check::Unknown {
                reason: "GitHub did not answer within 5 seconds".into()
            }
        );
    }

    #[test]
    fn os_names_come_from_the_systems_own_files() {
        assert_eq!(
            pretty_name("NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nID=arch\n").as_deref(),
            Some("Arch Linux")
        );
        assert_eq!(
            pretty_name("PRETTY_NAME=Omarchy\n").as_deref(),
            Some("Omarchy")
        );
        assert_eq!(pretty_name("NAME=x\n"), None);
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("SystemVersion.plist");
        std::fs::write(
            &plist,
            "<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>15.1</string>\n</dict>",
        )
        .unwrap();
        assert_eq!(mac_version(&plist).as_deref(), Some("macOS 15.1"));
        assert_eq!(mac_version(&dir.path().join("missing")), None);
    }
}
