use crate::config::expand_tilde;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

pub const RECOMMENDED: &str = "base.en";
pub const RECOMMENDED_MULTILINGUAL: &str = "small";
const MODELS_DIR: &str = "~/.local/share/yardbell/models";
const MODEL_URL_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const GGML_MAGIC: &[u8] = b"lmgg";
const CANCELLED: &str = "the download was cancelled";
pub const WHISPER_MISSING: &str = "whisper.cpp is not installed on this machine. Install it (on a Mac: brew install whisper-cpp; on Linux: build it from github.com/ggml-org/whisper.cpp) so that whisper-cli is on the PATH or at ~/.local/share/yardbell/whisper-cpp/bin/whisper-cli, then try again.";
pub const FFMPEG_MISSING: &str = "ffmpeg is not installed on this machine. Install it (brew install ffmpeg, or your Linux package manager's ffmpeg) so that it is on the PATH, then try again.";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct SpeechModel {
    pub name: &'static str,
    pub label: &'static str,
    pub bytes: u64,
    pub quality: u8,
    pub english_only: bool,
    pub note: &'static str,
}

// Sizes are those of the files in the official whisper.cpp repository on Hugging Face, so a
// download that ends short, or a page served in place of the model, is caught.
pub const CATALOG: &[SpeechModel] = &[
    SpeechModel {
        name: "tiny.en",
        label: "Whisper Tiny (English)",
        bytes: 77_704_715,
        quality: 2,
        english_only: true,
        note: "The quickest. Misses more words.",
    },
    SpeechModel {
        name: "base.en",
        label: "Whisper Base (English)",
        bytes: 147_964_211,
        quality: 3,
        english_only: true,
        note: "Quick on any processor, and a good place to start.",
    },
    SpeechModel {
        name: "small.en",
        label: "Whisper Small (English)",
        bytes: 487_614_201,
        quality: 4,
        english_only: true,
        note: "Hears more through accents. A little slower.",
    },
    SpeechModel {
        name: "medium.en",
        label: "Whisper Medium (English)",
        bytes: 1_533_774_781,
        quality: 5,
        english_only: true,
        note: "The most accurate in English. Needs a fast machine.",
    },
    SpeechModel {
        name: "small",
        label: "Whisper Small (99 languages)",
        bytes: 487_601_967,
        quality: 3,
        english_only: false,
        note: "For dictation in languages other than English.",
    },
    SpeechModel {
        name: "large-v3-turbo",
        label: "Whisper Large v3 Turbo",
        bytes: 1_624_555_275,
        quality: 5,
        english_only: false,
        note: "Accurate in every language. Best with a graphics card.",
    },
];

pub fn recommended(language: &str) -> &'static str {
    match language.trim() {
        "" | "en" => RECOMMENDED,
        _ => RECOMMENDED_MULTILINGUAL,
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    pub running: bool,
    pub error: Option<String>,
}

struct Download {
    progress: Progress,
    cancel: Arc<AtomicBool>,
}

// Keyed by the model's final path, so a dictation that needs the model and a Download press share
// one download instead of writing the same file twice.
static DOWNLOADS: LazyLock<Mutex<HashMap<PathBuf, Download>>> = LazyLock::new(Default::default);

pub struct ModelStore {
    pub dir: PathBuf,
    pub url_base: String,
    pub catalog: &'static [SpeechModel],
}

impl Default for ModelStore {
    // YARDBELL_MODELS and YARDBELL_MODELS_URL point a dev server or the browser tests at their own
    // folder and a stand-in for Hugging Face.
    fn default() -> ModelStore {
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        ModelStore {
            dir: expand_tilde(&env("YARDBELL_MODELS").unwrap_or_else(|| MODELS_DIR.into())),
            url_base: env("YARDBELL_MODELS_URL").unwrap_or_else(|| MODEL_URL_BASE.into()),
            catalog: CATALOG,
        }
    }
}

fn megabytes(bytes: u64) -> String {
    format!("{} MB", (bytes + 500_000) / 1_000_000)
}

pub fn still_downloading(name: &str, progress: &Progress) -> String {
    let percent = (progress.done * 100)
        .checked_div(progress.total)
        .map(|p| format!(" ({p}%)"))
        .unwrap_or_default();
    format!("The {name} model is still downloading{percent}. Dictation works once it finishes.")
}

fn starts_like_a_model(path: &Path) -> bool {
    let mut head = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok_and(|()| head == GGML_MAGIC)
}

impl ModelStore {
    pub fn find(&self, name: &str) -> Option<&'static SpeechModel> {
        self.catalog.iter().find(|m| m.name == name)
    }

    pub fn known(&self, name: &str) -> Result<&'static SpeechModel, String> {
        self.find(name).ok_or_else(|| {
            let names: Vec<&str> = self.catalog.iter().map(|m| m.name).collect();
            format!(
                "{name:?} is not one of the speech models Yardbell offers ({})",
                names.join(", ")
            )
        })
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.dir.join(format!("ggml-{name}.bin"))
    }

    fn part(&self, name: &str) -> PathBuf {
        self.dir.join(format!(".ggml-{name}.bin.part"))
    }

    pub fn downloaded(&self, name: &str) -> bool {
        self.file(name).is_file()
    }

    pub fn partial(&self, name: &str) -> u64 {
        std::fs::metadata(self.part(name)).map_or(0, |m| m.len())
    }

    pub fn progress(&self, name: &str) -> Option<Progress> {
        let all = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
        all.get(&self.file(name)).map(|d| d.progress.clone())
    }

    // Claims the download, so a second press while one runs is refused rather than run twice.
    pub fn start(&self, name: &str) -> Result<Arc<AtomicBool>, String> {
        let mut all = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
        let key = self.file(name);
        if let Some(d) = all.get(&key).filter(|d| d.progress.running) {
            return Err(still_downloading(name, &d.progress));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Progress {
            done: self.partial(name),
            total: self.find(name).map_or(0, |m| m.bytes),
            running: true,
            error: None,
        };
        all.insert(
            key,
            Download {
                progress,
                cancel: cancel.clone(),
            },
        );
        Ok(cancel)
    }

    pub async fn run(&self, name: &str, cancel: Arc<AtomicBool>) -> Result<PathBuf, String> {
        let result = self.fetch(name, &cancel).await;
        let mut all = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
        let key = self.file(name);
        match &result {
            Err(e) if e != CANCELLED => {
                if let Some(d) = all.get_mut(&key) {
                    d.progress.running = false;
                    d.progress.error = Some(e.clone());
                }
            }
            _ => {
                all.remove(&key);
            }
        }
        result
    }

    pub async fn download(&self, name: &str) -> Result<PathBuf, String> {
        let cancel = self.start(name)?;
        self.run(name, cancel).await
    }

    pub fn cancel(&self, name: &str) -> bool {
        let all = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
        match all.get(&self.file(name)).filter(|d| d.progress.running) {
            Some(d) => {
                d.cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        {
            let mut all = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
            let key = self.file(name);
            if all.get(&key).is_some_and(|d| d.progress.running) {
                return Err(format!(
                    "the {name} model is downloading. Cancel the download first."
                ));
            }
            all.remove(&key);
        }
        for path in [self.file(name), self.part(name)] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("cannot delete {}: {e}", path.display())),
            }
        }
        Ok(())
    }

    fn report(&self, name: &str, done: u64, total: u64) {
        let mut all = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(d) = all.get_mut(&self.file(name)) {
            d.progress.done = done;
            d.progress.total = total;
        }
    }

    // Streams into a .part file next to the model. A connection that breaks off keeps what
    // arrived, and the next download asks only for the rest; anything that is not the model is
    // thrown away.
    async fn fetch(&self, name: &str, cancel: &AtomicBool) -> Result<PathBuf, String> {
        let expected = self.find(name).map(|m| m.bytes);
        let url = format!("{}/ggml-{name}.bin", self.url_base);
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("cannot make the models folder {}: {e}", self.dir.display()))?;
        let part = self.part(name);
        let discard = || {
            let _ = std::fs::remove_file(&part);
        };
        let mut have = self.partial(name);
        if have > 0 && (expected.is_some_and(|e| have > e) || !starts_like_a_model(&part)) {
            discard();
            have = 0;
        }
        if have == 0 || expected != Some(have) {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| e.to_string())?;
            let mut req = client.get(&url);
            if have > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
            }
            let mut res = req
                .send()
                .await
                .map_err(|e| format!("the {name} model could not be downloaded from {url}: {e}"))?;
            let resumed = have > 0 && res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
            if !resumed {
                if !res.status().is_success() {
                    return Err(format!(
                        "the {name} model could not be downloaded from {url}: the server said {}",
                        res.status()
                    ));
                }
                have = 0;
            }
            let offered = res.content_length().map(|n| n + have);
            if let (Some(want), Some(got)) = (expected, offered) {
                if want != got {
                    discard();
                    return Err(format!(
                        "{url} offers {got} bytes where the {name} model has {want}, so it is not the right file"
                    ));
                }
            }
            let total = expected.or(offered).unwrap_or(0);
            self.report(name, have, total);
            let opened = if resumed {
                std::fs::OpenOptions::new().append(true).open(&part)
            } else {
                std::fs::File::create(&part)
            };
            let mut file =
                opened.map_err(|e| format!("cannot write the model to {}: {e}", part.display()))?;
            let mut head: Vec<u8> = if resumed {
                GGML_MAGIC.to_vec()
            } else {
                Vec::new()
            };
            loop {
                if cancel.load(Ordering::SeqCst) {
                    drop(file);
                    discard();
                    return Err(CANCELLED.into());
                }
                let chunk = match res.chunk().await {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break,
                    Err(e) => {
                        return Err(format!(
                            "the {name} model download broke off after {} ({e}). Download it again to carry on from there.",
                            megabytes(have)
                        ))
                    }
                };
                if head.len() < GGML_MAGIC.len() {
                    let take = chunk.len().min(GGML_MAGIC.len() - head.len());
                    head.extend_from_slice(&chunk[..take]);
                    if head.len() == GGML_MAGIC.len() && head != GGML_MAGIC {
                        drop(file);
                        discard();
                        return Err(format!("what {url} sends is not a ggml model file"));
                    }
                }
                file.write_all(&chunk)
                    .map_err(|e| format!("cannot write the model to {}: {e}", part.display()))?;
                have += chunk.len() as u64;
                self.report(name, have, total);
            }
            file.flush()
                .map_err(|e| format!("cannot write the model to {}: {e}", part.display()))?;
            if head.len() < GGML_MAGIC.len() {
                drop(file);
                discard();
                return Err(format!("what {url} sends is not a ggml model file"));
            }
        }
        if let Some(want) = expected {
            if have < want {
                return Err(format!(
                    "the {name} model download stopped at {} of {}. Download it again to carry on from there.",
                    megabytes(have),
                    megabytes(want)
                ));
            }
            if have > want {
                discard();
                return Err(format!(
                    "the {name} model came out larger than it should be, so it was thrown away"
                ));
            }
        }
        let path = self.file(name);
        std::fs::rename(&part, &path).map_err(|e| {
            discard();
            format!("the downloaded model cannot be moved into place: {e}")
        })?;
        Ok(path)
    }
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn on_path(name: &str, path_var: Option<&OsString>) -> Option<PathBuf> {
    std::env::split_paths(path_var?)
        .map(|dir| dir.join(name))
        .find(|p| executable(p))
}

fn whisper_in(
    configured: &str,
    path_var: Option<&OsString>,
    fallbacks: &[PathBuf],
) -> Option<PathBuf> {
    let configured = configured.trim();
    let given = if configured.is_empty() {
        None
    } else if configured.contains('/') || configured.starts_with('~') {
        Some(expand_tilde(configured)).filter(|p| executable(p))
    } else {
        on_path(configured, path_var)
    };
    given
        .or_else(|| on_path("whisper-cli", path_var))
        .or_else(|| on_path("whisper-cpp", path_var))
        .or_else(|| fallbacks.iter().find(|p| executable(p)).cloned())
}

// A desktop app or a login service often starts with a short PATH, so the usual install places
// are looked at too.
pub fn find_whisper(configured: &str) -> Option<PathBuf> {
    let fallbacks = [
        expand_tilde("~/.local/share/yardbell/whisper-cpp/bin/whisper-cli"),
        PathBuf::from("/opt/homebrew/bin/whisper-cli"),
        PathBuf::from("/usr/local/bin/whisper-cli"),
    ];
    whisper_in(configured, std::env::var_os("PATH").as_ref(), &fallbacks)
}

pub fn find_ffmpeg() -> Option<PathBuf> {
    on_path("ffmpeg", std::env::var_os("PATH").as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TEST_BYTES: u64 = 4096;
    static TEST_CATALOG: &[SpeechModel] = &[SpeechModel {
        name: "tiny.en",
        label: "Tiny",
        bytes: TEST_BYTES,
        quality: 2,
        english_only: true,
        note: "",
    }];

    fn weights() -> Vec<u8> {
        let mut bytes = GGML_MAGIC.to_vec();
        bytes.extend((0..TEST_BYTES as usize - GGML_MAGIC.len()).map(|i| (i % 251) as u8));
        bytes
    }

    fn store(dir: &Path, url_base: &str) -> ModelStore {
        ModelStore {
            dir: dir.to_path_buf(),
            url_base: url_base.to_string(),
            catalog: TEST_CATALOG,
        }
    }

    // A bare HTTP server, so a test can break the connection halfway or answer a Range request.
    // `answer` gets the request head and the hit count and returns what to write back.
    async fn raw_server(
        answer: impl Fn(&str, u32) -> Vec<u8> + Send + Sync + 'static,
    ) -> (String, Arc<AtomicU32>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicU32::new(0));
        let seen = hits.clone();
        let answer = Arc::new(answer);
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let n = seen.fetch_add(1, Ordering::SeqCst) + 1;
                let answer = answer.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        let read = sock.read(&mut buf).await.unwrap();
                        if read == 0 {
                            return;
                        }
                        head.extend_from_slice(&buf[..read]);
                    }
                    let reply = answer(&String::from_utf8_lossy(&head), n);
                    let _ = sock.write_all(&reply).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("http://127.0.0.1:{port}"), hits)
    }

    fn reply(status: &str, headers: &str, length: usize, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {length}\r\nConnection: close\r\n{headers}\r\n"
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn the_catalog_holds_the_offered_models_and_checks_names() {
        let names: Vec<&str> = CATALOG.iter().map(|m| m.name).collect();
        for name in [
            "tiny.en",
            "base.en",
            "small.en",
            "medium.en",
            "large-v3-turbo",
        ] {
            assert!(names.contains(&name), "{name} missing from {names:?}");
        }
        assert!(CATALOG
            .iter()
            .all(|m| (1..=5).contains(&m.quality) && m.bytes > 0));
        let at = ModelStore {
            dir: PathBuf::from("/models"),
            url_base: "http://unused".into(),
            catalog: CATALOG,
        };
        assert_eq!(at.known("base.en").unwrap().bytes, 147_964_211);
        for bad in [
            "../etc/passwd",
            "base.en/../x",
            "https://evil/x.bin",
            "large-v2",
            "",
        ] {
            assert!(at.known(bad).is_err(), "{bad} was accepted");
        }
        assert_eq!(recommended(""), "base.en");
        assert_eq!(recommended("en"), "base.en");
        assert_eq!(recommended("auto"), "small");
        assert_eq!(recommended("ar"), "small");
    }

    #[tokio::test]
    async fn a_model_downloads_into_the_folder_with_its_size_checked() {
        let body = weights();
        let (url, _) = raw_server(move |_, _| reply("200 OK", "", body.len(), &body)).await;
        let dir = tempfile::tempdir().unwrap();
        let at = store(dir.path(), &url);
        assert!(!at.downloaded("tiny.en"));
        let path = at.download("tiny.en").await.unwrap();
        assert_eq!(path, dir.path().join("ggml-tiny.en.bin"));
        assert_eq!(std::fs::read(&path).unwrap(), weights());
        assert!(at.downloaded("tiny.en"));
        assert_eq!(at.progress("tiny.en"), None);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["ggml-tiny.en.bin"]);
    }

    #[tokio::test]
    async fn a_broken_download_resumes_where_it_stopped() {
        let body = weights();
        let half = body.len() / 2;
        let ranges: Arc<Mutex<Vec<String>>> = Default::default();
        let seen = ranges.clone();
        let (url, hits) = raw_server(move |head, n| {
            let range = head
                .lines()
                .find_map(|l| {
                    l.strip_prefix("range: ")
                        .or_else(|| l.strip_prefix("Range: "))
                })
                .unwrap_or("")
                .to_string();
            seen.lock().unwrap().push(range);
            if n == 1 {
                return reply("200 OK", "", body.len(), &body[..half]);
            }
            reply(
                "206 Partial Content",
                &format!(
                    "Content-Range: bytes {half}-{}/{}\r\n",
                    body.len() - 1,
                    body.len()
                ),
                body.len() - half,
                &body[half..],
            )
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let at = store(dir.path(), &url);
        let err = at.download("tiny.en").await.unwrap_err();
        assert!(err.contains("carry on"), "{err}");
        assert_eq!(at.partial("tiny.en"), half as u64);
        let failed = at.progress("tiny.en").unwrap();
        assert!(!failed.running);
        assert_eq!(failed.error.as_deref(), Some(err.as_str()));
        at.download("tiny.en").await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        assert_eq!(ranges.lock().unwrap()[1], format!("bytes={half}-"));
        assert_eq!(std::fs::read(at.file("tiny.en")).unwrap(), weights());
        assert_eq!(at.partial("tiny.en"), 0);
        assert_eq!(at.progress("tiny.en"), None);
    }

    #[tokio::test]
    async fn a_file_of_the_wrong_size_is_refused_and_removed() {
        let mut body = weights();
        body.truncate(1000);
        let (url, _) = raw_server(move |_, _| reply("200 OK", "", body.len(), &body)).await;
        let dir = tempfile::tempdir().unwrap();
        let err = store(dir.path(), &url)
            .download("tiny.en")
            .await
            .unwrap_err();
        assert!(err.contains("not the right file"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_page_in_place_of_the_model_is_thrown_away() {
        let page = vec![b'<'; TEST_BYTES as usize];
        let (url, _) = raw_server(move |_, _| reply("200 OK", "", page.len(), &page)).await;
        let dir = tempfile::tempdir().unwrap();
        let err = store(dir.path(), &url)
            .download("tiny.en")
            .await
            .unwrap_err();
        assert!(err.contains("not a ggml model"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_second_download_of_the_same_model_waits_its_turn() {
        let dir = tempfile::tempdir().unwrap();
        let at = store(dir.path(), "http://unused");
        let _claim = at.start("tiny.en").unwrap();
        let err = at.download("tiny.en").await.unwrap_err();
        assert!(err.contains("still downloading"), "{err}");
        assert!(at.delete("tiny.en").unwrap_err().contains("Cancel"));
        assert!(at.cancel("tiny.en"));
    }

    #[test]
    fn delete_removes_the_model_and_any_partial_download() {
        let dir = tempfile::tempdir().unwrap();
        let at = store(dir.path(), "http://unused");
        std::fs::write(at.file("tiny.en"), weights()).unwrap();
        std::fs::write(at.part("tiny.en"), b"lmgg").unwrap();
        at.delete("tiny.en").unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        at.delete("tiny.en").unwrap();
    }

    #[test]
    fn whisper_is_found_where_it_is_installed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = |rel: &str| {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        let bin = tool("bin/whisper-cli");
        let own = tool("opt/whisper/main");
        let installed = tool("share/whisper-cpp/bin/whisper-cli");
        std::fs::write(dir.path().join("plain"), "").unwrap();
        let path = Some(OsString::from(dir.path().join("bin")));
        let none = Some(OsString::from(dir.path().join("empty")));
        let fallbacks = [installed.clone()];
        assert_eq!(whisper_in("", path.as_ref(), &fallbacks), Some(bin.clone()));
        assert_eq!(
            whisper_in(own.to_str().unwrap(), path.as_ref(), &fallbacks),
            Some(own)
        );
        assert_eq!(
            whisper_in("/no/such/tool", path.as_ref(), &fallbacks),
            Some(bin)
        );
        assert_eq!(whisper_in("", none.as_ref(), &fallbacks), Some(installed));
        let plain = [dir.path().join("plain")];
        assert_eq!(whisper_in("", none.as_ref(), &plain), None);
    }
}
