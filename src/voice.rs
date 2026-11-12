use crate::config::{expand_tilde, VoiceInput, VoiceSettings};
use crate::secrets::Secrets;
use crate::shell::{Output, Runner};
pub use crate::voice_models::ModelStore;
use rand::Rng;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const AUDIO_MAX: usize = 25 * 1024 * 1024;
pub const DEFAULT_WHISPER_COMMAND: &str = "whisper-cli";
pub const DEFAULT_MODEL: &str = "small";
pub const DEFAULT_API_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const DEFAULT_API_MODEL: &str = "whisper-1";
const CONVERT_TIMEOUT: Duration = Duration::from_secs(60);
const WHISPER_TIMEOUT: Duration = Duration::from_secs(300);
const API_TIMEOUT: Duration = Duration::from_secs(120);

pub const OFF_MESSAGE: &str = "Voice input is off. Turn it on under Settings, Voice.";

enum Model {
    File(PathBuf),
    Name(String),
}

fn model(setting: &str) -> Result<Model, String> {
    let given = setting.trim();
    if given.contains('/') || given.starts_with('~') {
        return Ok(Model::File(expand_tilde(given)));
    }
    let name = given.strip_prefix("ggml-").unwrap_or(given);
    let name = name.strip_suffix(".bin").unwrap_or(name);
    if name.is_empty() {
        return Ok(Model::Name(DEFAULT_MODEL.to_string()));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(format!(
            "voice.whisper_model {given:?} is neither a Whisper model name like {DEFAULT_MODEL} nor a path to a ggml file"
        ));
    }
    Ok(Model::Name(name.to_string()))
}

impl ModelStore {
    pub fn resolve(&self, setting: &str) -> Result<PathBuf, String> {
        Ok(match model(setting)? {
            Model::File(path) => path,
            Model::Name(name) => self.file(&name),
        })
    }

    async fn ensure(&self, setting: &str) -> Result<PathBuf, String> {
        let name = match model(setting)? {
            Model::File(path) => return Ok(path),
            Model::Name(name) => name,
        };
        let path = self.file(&name);
        if path.is_file() {
            return Ok(path);
        }
        self.download(&name).await
    }
}

fn extension(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or("").trim() {
        "audio/ogg" | "application/ogg" => "ogg",
        "audio/mp4" | "video/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/flac" | "audio/x-flac" => "flac",
        _ => "webm",
    }
}

fn failure(what: &str, out: &Output) -> String {
    if out.timed_out {
        return format!("{what} did not finish in time");
    }
    let said = if out.stderr.trim().is_empty() {
        out.stdout.clone()
    } else {
        out.stderr.clone()
    };
    let last = said.lines().rev().find(|l| !l.trim().is_empty());
    match last {
        Some(line) => format!("{what}: {}", line.trim()),
        None => format!("{what} failed (exit {})", out.status.unwrap_or(-1)),
    }
}

// Whisper prints each segment on a line, and silence as markers like [BLANK_AUDIO] or (music).
fn tidy(stdout: &str) -> String {
    let marker = |l: &str| {
        (l.starts_with('[') && l.ends_with(']')) || (l.starts_with('(') && l.ends_with(')'))
    };
    let words: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !marker(l))
        .collect();
    words
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Scratch, String> {
        let dir = std::env::temp_dir().join(format!(
            "yardbell-voice-{}-{:08x}",
            std::process::id(),
            rand::thread_rng().gen::<u32>()
        ));
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make a working folder: {e}"))?;
        Ok(Scratch(dir))
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub async fn transcribe(
    runner: &dyn Runner,
    voice: &VoiceSettings,
    store: &ModelStore,
    secrets: &Secrets,
    audio: &[u8],
    mime: &str,
) -> Result<String, String> {
    if audio.is_empty() {
        return Err("the recording is empty".into());
    }
    let text = match voice.input {
        VoiceInput::Off => return Err(OFF_MESSAGE.into()),
        VoiceInput::Local => local(runner, voice, store, audio, mime).await?,
        VoiceInput::Api => api(voice, secrets, audio, mime).await?,
    };
    Ok(if voice.remove_fillers {
        without_fillers(&text)
    } else {
        text
    })
}

pub const VOCABULARY_MAX: usize = 800;

// Whisper takes the words as the text that came before, which steers its spelling of names.
fn prompt(vocabulary: &str) -> Option<String> {
    let words: Vec<&str> = vocabulary
        .split([',', '\n'])
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .collect();
    (!words.is_empty()).then(|| words.join(", "))
}

const FILLERS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "mm", "ah",
];

// "Like" is a filler only where a clause starts or a comma sets it apart; "I like it" keeps it.
pub fn without_fillers(text: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut capital = false;
    let words: Vec<&str> = text.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        let core = word.trim_matches(|c: char| !c.is_alphanumeric());
        let tail: String = word
            .chars()
            .rev()
            .take_while(|c| !c.is_alphanumeric())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let lower = core.to_lowercase();
        let starts_clause = kept
            .last()
            .is_none_or(|w| w.ends_with([',', '.', '?', '!', ';', ':']));
        let filler = FILLERS.contains(&lower.as_str())
            || (lower == "like" && (starts_clause || tail.starts_with(',')) && i + 1 < words.len());
        if !filler {
            let mut word = word.to_string();
            if capital {
                let mut chars = word.chars();
                if let Some(first) = chars.next() {
                    word = first.to_uppercase().chain(chars).collect();
                }
                capital = false;
            }
            kept.push(word);
            continue;
        }
        let ends_sentence = tail.contains(['.', '?', '!']);
        match kept.last_mut() {
            Some(last) if ends_sentence => {
                let trimmed = last.trim_end_matches([',', ';', ':']).to_string();
                *last = format!("{trimmed}{}", tail.trim_start_matches(','));
            }
            Some(last) if tail.starts_with(',') && last.ends_with(',') => {
                last.pop();
            }
            None => capital = core.chars().next().is_some_and(char::is_uppercase),
            _ => {}
        }
        if ends_sentence {
            capital = true;
        }
    }
    kept.join(" ")
}

async fn local(
    runner: &dyn Runner,
    voice: &VoiceSettings,
    store: &ModelStore,
    audio: &[u8],
    mime: &str,
) -> Result<String, String> {
    let scratch = Scratch::new()?;
    let recording = scratch.file(&format!("recording.{}", extension(mime)));
    std::fs::write(&recording, audio).map_err(|e| format!("cannot keep the recording: {e}"))?;
    // Not "recording.wav": a wav upload already sits at that name, and ffmpeg
    // cannot read and write the same file.
    let wav = scratch.file("whisper.wav");
    let path = |p: &Path| p.display().to_string();
    let converted = runner
        .run(
            vec![
                "ffmpeg".into(),
                "-hide_banner".into(),
                "-loglevel".into(),
                "error".into(),
                "-y".into(),
                "-i".into(),
                path(&recording),
                "-ar".into(),
                "16000".into(),
                "-ac".into(),
                "1".into(),
                path(&wav),
            ],
            None,
            CONVERT_TIMEOUT,
        )
        .await;
    if !converted.ok() {
        return Err(failure("ffmpeg could not read the recording", &converted));
    }
    let command = match voice.whisper_command.trim() {
        "" => DEFAULT_WHISPER_COMMAND,
        given => given,
    };
    let model = store.ensure(&voice.whisper_model).await?;
    let mut argv = vec![
        command.to_string(),
        "-m".into(),
        model.display().to_string(),
        "-f".into(),
        path(&wav),
        "-nt".into(),
        "-np".into(),
    ];
    let language = voice.language.trim();
    if !language.is_empty() {
        argv.push("-l".into());
        argv.push(language.into());
    }
    if let Some(words) = prompt(&voice.vocabulary) {
        argv.push("--prompt".into());
        argv.push(words);
    }
    let out = runner.run(argv, None, WHISPER_TIMEOUT).await;
    if !out.ok() {
        return Err(failure(&format!("{command} could not transcribe"), &out));
    }
    Ok(tidy(&out.stdout))
}

async fn api(
    voice: &VoiceSettings,
    secrets: &Secrets,
    audio: &[u8],
    mime: &str,
) -> Result<String, String> {
    let key = secrets
        .resolve(voice.api_key.trim())
        .map_err(|e| e.to_string())?;
    let url = match voice.api_url.trim() {
        "" => DEFAULT_API_URL,
        given => given,
    };
    let model = match voice.api_model.trim() {
        "" => DEFAULT_API_MODEL,
        given => given,
    };
    let mime = mime.split(';').next().unwrap_or("audio/webm").trim();
    let file = reqwest::multipart::Part::bytes(audio.to_vec())
        .file_name(format!("recording.{}", extension(mime)))
        .mime_str(mime)
        .map_err(|e| format!("the recording's type {mime:?} is not sendable: {e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .part("file", file);
    let language = voice.language.trim();
    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    if let Some(words) = prompt(&voice.vocabulary) {
        form = form.text("prompt", words);
    }
    let client = reqwest::Client::builder()
        .timeout(API_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(url)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("the speech-to-text API is not answering: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let said = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .or_else(|| v.pointer("/error"))
                    .and_then(|m| m.as_str().map(String::from))
            })
            .unwrap_or_else(|| body.chars().take(200).collect());
        return Err(format!("the speech-to-text API said {status}: {said}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "the speech-to-text API sent no JSON back")?;
    match parsed.get("text").and_then(|t| t.as_str()) {
        Some(text) => Ok(text.trim().to_string()),
        None => Err("the speech-to-text API sent no text back".into()),
    }
}

// What the Test button in Settings reports. The API is never called, so testing costs nothing;
// the local tools only print their version.
pub async fn check(
    runner: &dyn Runner,
    voice: &VoiceSettings,
    store: &ModelStore,
    secrets: &Secrets,
) -> (bool, String) {
    match voice.input {
        VoiceInput::Off => (false, OFF_MESSAGE.into()),
        VoiceInput::Local => {
            let mut problems = Vec::new();
            let ffmpeg = runner
                .run(vec!["ffmpeg".into(), "-version".into()], None, CONVERT_TIMEOUT)
                .await;
            if !ffmpeg.ok() {
                problems.push("ffmpeg is not installed on this machine".to_string());
            }
            let command = match voice.whisper_command.trim() {
                "" => DEFAULT_WHISPER_COMMAND,
                given => given,
            };
            let found = runner
                .run(vec![command.into(), "--help".into()], None, CONVERT_TIMEOUT)
                .await;
            if found.status == Some(127) {
                problems.push(format!("{command} was not found on this machine"));
            }
            let mut downloads = None;
            match model(&voice.whisper_model) {
                Err(problem) => problems.push(problem),
                Ok(Model::File(path)) if !path.is_file() => {
                    problems.push(format!("there is no model file at {}", path.display()))
                }
                Ok(Model::Name(name)) => {
                    if !store.dir.join(format!("ggml-{name}.bin")).is_file() {
                        downloads = Some(name);
                    }
                }
                Ok(Model::File(_)) => {}
            }
            if !problems.is_empty() {
                (false, problems.join(". "))
            } else if let Some(name) = downloads {
                (
                    true,
                    format!(
                        "ffmpeg and the Whisper command are in place. The {name} model is downloaded to {} on the first dictation.",
                        store.dir.display()
                    ),
                )
            } else {
                (true, "ffmpeg, the Whisper command and the model are all in place.".into())
            }
        }
        VoiceInput::Api => match secrets.resolve(voice.api_key.trim()) {
            Ok(_) => (
                true,
                "The key is set. The API itself is not called here, so the first dictation is the real test.".into(),
            ),
            Err(e) => (false, e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRunner;

    fn secrets() -> Secrets {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Secrets::load(&dir.path().join("secrets.yml")).unwrap();
        store.set("stt", "key-123", chrono::Utc::now()).unwrap();
        store
    }

    fn local_settings() -> VoiceSettings {
        VoiceSettings {
            input: VoiceInput::Local,
            whisper_model: "/models/ggml-base.en.bin".into(),
            ..VoiceSettings::default()
        }
    }

    #[tokio::test]
    async fn off_says_where_to_turn_it_on() {
        let fake = FakeRunner::default();
        let err = transcribe(
            &fake,
            &VoiceSettings::default(),
            &ModelStore::default(),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert!(err.contains("Settings"), "{err}");
    }

    #[tokio::test]
    async fn local_converts_then_transcribes() {
        let fake = FakeRunner::default();
        fake.stub("ffmpeg", Output::ok_with(""));
        fake.stub(
            "whisper-cli",
            Output::ok_with("  Fix the login test.\n[BLANK_AUDIO]\n  Then run it.  \n"),
        );
        let text = transcribe(
            &fake,
            &local_settings(),
            &ModelStore::default(),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap();
        assert_eq!(text, "Fix the login test. Then run it.");
        let calls = fake.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0][0], "ffmpeg");
        assert!(calls[0].iter().any(|a| a.ends_with("recording.webm")));
        assert!(calls[0].windows(2).any(|w| w == ["-ar", "16000"]));
        assert_eq!(calls[1][0], "whisper-cli");
        assert!(calls[1]
            .windows(2)
            .any(|w| w == ["-m", "/models/ggml-base.en.bin"]));
        assert!(calls[1].contains(&"-nt".to_string()));
        assert!(!calls[1].contains(&"-l".to_string()), "no language given");
    }

    #[tokio::test]
    async fn local_passes_the_language_and_own_command() {
        let fake = FakeRunner::default();
        fake.stub("ffmpeg", Output::ok_with(""));
        fake.stub("/opt/whisper/main", Output::ok_with("hei"));
        let voice = VoiceSettings {
            whisper_command: "/opt/whisper/main".into(),
            language: "fi".into(),
            ..local_settings()
        };
        let text = transcribe(
            &fake,
            &voice,
            &ModelStore::default(),
            &secrets(),
            b"x",
            "audio/ogg",
        )
        .await
        .unwrap();
        assert_eq!(text, "hei");
        let calls = fake.calls();
        assert!(calls[1].windows(2).any(|w| w == ["-l", "fi"]));
    }

    #[tokio::test]
    async fn a_failing_tool_reports_its_last_line() {
        let fake = FakeRunner::default();
        fake.stub("ffmpeg", Output::failed(1, "something\nInvalid data found"));
        let err = transcribe(
            &fake,
            &local_settings(),
            &ModelStore::default(),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert_eq!(
            err,
            "ffmpeg could not read the recording: Invalid data found"
        );
        let fake = FakeRunner::default();
        fake.stub("ffmpeg", Output::ok_with(""));
        fake.stub(
            "whisper-cli",
            Output::failed(127, "whisper-cli: No such file or directory"),
        );
        let err = transcribe(
            &fake,
            &local_settings(),
            &ModelStore::default(),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert!(err.contains("whisper-cli could not transcribe"), "{err}");
    }

    #[tokio::test]
    async fn api_sends_the_recording_and_reads_text_back() {
        use axum::routing::post;
        let headers: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let seen = headers.clone();
        let app = axum::Router::new().route(
            "/v1/audio/transcriptions",
            post(move |req: axum::http::Request<axum::body::Body>| {
                let seen = seen.clone();
                async move {
                    let auth = req
                        .headers()
                        .get("authorization")
                        .and_then(|h| h.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let kind = req
                        .headers()
                        .get("content-type")
                        .and_then(|h| h.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    seen.lock().unwrap().push(auth);
                    seen.lock().unwrap().push(kind);
                    axum::Json(serde_json::json!({ "text": " from the api " }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let voice = VoiceSettings {
            input: VoiceInput::Api,
            api_url: format!("http://127.0.0.1:{port}/v1/audio/transcriptions"),
            api_key: "${secret:stt}".into(),
            ..VoiceSettings::default()
        };
        let text = transcribe(
            &FakeRunner::default(),
            &voice,
            &ModelStore::default(),
            &secrets(),
            b"RIFFdata",
            "audio/webm;codecs=opus",
        )
        .await
        .unwrap();
        assert_eq!(text, "from the api");
        let seen = headers.lock().unwrap().clone();
        assert_eq!(seen[0], "Bearer key-123");
        assert!(seen[1].starts_with("multipart/form-data"), "{}", seen[1]);
    }

    #[tokio::test]
    async fn api_with_a_missing_secret_names_it() {
        let voice = VoiceSettings {
            input: VoiceInput::Api,
            api_key: "${secret:gone}".into(),
            ..VoiceSettings::default()
        };
        let err = transcribe(
            &FakeRunner::default(),
            &voice,
            &ModelStore::default(),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert!(err.contains("gone"), "{err}");
    }

    #[tokio::test]
    async fn check_reports_what_is_missing_locally() {
        let fake = FakeRunner::default();
        fake.stub("ffmpeg -version", Output::ok_with("ffmpeg version 6"));
        fake.stub("whisper-cli --help", Output::failed(127, "not found"));
        let (ok, message) =
            check(&fake, &local_settings(), &ModelStore::default(), &secrets()).await;
        assert!(!ok);
        assert!(message.contains("whisper-cli was not found"), "{message}");
        assert!(message.contains("no model file"), "{message}");
        assert!(!message.contains("ffmpeg is not installed"), "{message}");
    }

    #[tokio::test]
    async fn check_api_only_needs_the_secret() {
        let voice = VoiceSettings {
            input: VoiceInput::Api,
            api_key: "${secret:stt}".into(),
            ..VoiceSettings::default()
        };
        let (ok, _) = check(
            &FakeRunner::default(),
            &voice,
            &ModelStore::default(),
            &secrets(),
        )
        .await;
        assert!(ok);
        let missing = VoiceSettings {
            api_key: "${secret:gone}".into(),
            ..voice
        };
        let (ok, message) = check(
            &FakeRunner::default(),
            &missing,
            &ModelStore::default(),
            &secrets(),
        )
        .await;
        assert!(!ok);
        assert!(message.contains("gone"), "{message}");
    }

    fn store(dir: &Path, url_base: &str) -> ModelStore {
        ModelStore {
            dir: dir.to_path_buf(),
            url_base: url_base.to_string(),
            catalog: &[],
        }
    }

    // Serves url_base; the closure answers GET /ggml-<name>.bin and counts the hits.
    async fn model_server(
        body: impl Fn() -> axum::response::Response + Clone + Send + Sync + 'static,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicU32>) {
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let seen = hits.clone();
        let app = axum::Router::new().route(
            "/{file}",
            axum::routing::get(move || {
                let seen = seen.clone();
                let body = body.clone();
                async move {
                    seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    body()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://127.0.0.1:{port}"), hits)
    }

    fn weights() -> Vec<u8> {
        let mut bytes = b"lmgg".to_vec();
        bytes.extend_from_slice(&[7; 64]);
        bytes
    }

    #[test]
    fn the_model_setting_is_a_name_or_a_path() {
        let dir = tempfile::tempdir().unwrap();
        let at = store(dir.path(), "http://unused");
        let resolved = |setting: &str| at.resolve(setting).unwrap();
        assert_eq!(resolved(""), dir.path().join("ggml-small.bin"));
        assert_eq!(resolved("small"), dir.path().join("ggml-small.bin"));
        assert_eq!(
            resolved("ggml-small.bin"),
            dir.path().join("ggml-small.bin")
        );
        assert_eq!(resolved("base.en"), dir.path().join("ggml-base.en.bin"));
        assert_eq!(
            resolved("large-v3-turbo"),
            dir.path().join("ggml-large-v3-turbo.bin")
        );
        assert_eq!(
            resolved("/models/own.bin"),
            PathBuf::from("/models/own.bin")
        );
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            resolved("~/models/own.bin"),
            Path::new(&home).join("models/own.bin")
        );
        let err = at.resolve("so wrong").unwrap_err();
        assert!(err.contains("so wrong"), "{err}");
    }

    #[tokio::test]
    async fn a_named_model_is_downloaded_once_and_reused() {
        let (url, hits) = model_server(|| {
            use axum::response::IntoResponse;
            weights().into_response()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let at = store(dir.path(), &url);
        let voice = VoiceSettings {
            whisper_model: "small".into(),
            ..local_settings()
        };
        for _ in 0..2 {
            let fake = FakeRunner::default();
            fake.stub("ffmpeg", Output::ok_with(""));
            fake.stub("whisper-cli", Output::ok_with("hello"));
            let text = transcribe(&fake, &voice, &at, &secrets(), b"x", "audio/webm")
                .await
                .unwrap();
            assert_eq!(text, "hello");
            let model = dir.path().join("ggml-small.bin").display().to_string();
            assert!(
                fake.calls()[1]
                    .windows(2)
                    .any(|w| w == ["-m".to_string(), model.clone()]),
                "{:?}",
                fake.calls()[1]
            );
        }
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read(dir.path().join("ggml-small.bin")).unwrap(),
            weights()
        );
    }

    #[tokio::test]
    async fn a_failed_download_says_so_and_leaves_nothing_behind() {
        let (url, _) = model_server(|| {
            use axum::response::IntoResponse;
            (axum::http::StatusCode::NOT_FOUND, "no such model").into_response()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::default();
        fake.stub("ffmpeg", Output::ok_with(""));
        let voice = VoiceSettings {
            whisper_model: "small".into(),
            ..local_settings()
        };
        let err = transcribe(
            &fake,
            &voice,
            &store(dir.path(), &url),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert!(err.contains("small"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_download_that_is_not_a_model_is_refused() {
        let (url, _) = model_server(|| {
            use axum::response::IntoResponse;
            "<html>a login page</html>".into_response()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::default();
        fake.stub("ffmpeg", Output::ok_with(""));
        let voice = VoiceSettings {
            whisper_model: "small".into(),
            ..local_settings()
        };
        let err = transcribe(
            &fake,
            &voice,
            &store(dir.path(), &url),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert!(err.contains("not a ggml model"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn check_says_a_named_model_downloads_on_first_use() {
        let fake = FakeRunner::default();
        fake.stub("ffmpeg -version", Output::ok_with("ffmpeg version 6"));
        fake.stub("whisper-cli --help", Output::ok_with("usage"));
        let dir = tempfile::tempdir().unwrap();
        let voice = VoiceSettings {
            whisper_model: String::new(),
            ..local_settings()
        };
        let (ok, message) = check(
            &fake,
            &voice,
            &store(dir.path(), "http://unused"),
            &secrets(),
        )
        .await;
        assert!(ok, "{message}");
        assert!(message.contains("first dictation"), "{message}");
        std::fs::write(dir.path().join("ggml-small.bin"), weights()).unwrap();
        let (ok, message) = check(
            &fake,
            &voice,
            &store(dir.path(), "http://unused"),
            &secrets(),
        )
        .await;
        assert!(ok, "{message}");
        assert!(message.contains("all in place"), "{message}");
    }

    #[test]
    fn filler_words_are_dropped_and_the_rest_reads_on() {
        let cases = [
            (
                "Um, so we should fix the login test.",
                "So we should fix the login test.",
            ),
            ("So, uh, we should fix it.", "So we should fix it."),
            ("Run it again, um.", "Run it again."),
            ("It was, like, huge.", "It was huge."),
            ("Like I said, run the tests.", "I said, run the tests."),
            ("I like it.", "I like it."),
            ("Make it look like this", "Make it look like this"),
            ("Hmm. Uh, okay then.", "Okay then."),
            (
                "Fix the umbrella and the uh error",
                "Fix the umbrella and the error",
            ),
        ];
        for (said, cleaned) in cases {
            assert_eq!(without_fillers(said), cleaned, "for {said:?}");
        }
    }

    #[tokio::test]
    async fn the_vocabulary_and_filler_setting_reach_whisper() {
        let fake = FakeRunner::default();
        fake.stub("ffmpeg", Output::ok_with(""));
        fake.stub(
            "whisper-cli",
            Output::ok_with("Um, ask Yardbell to, uh, merge it."),
        );
        let voice = VoiceSettings {
            vocabulary: "Yardbell, Dispatch\nwhisper.cpp, ".into(),
            remove_fillers: true,
            language: "auto".into(),
            ..local_settings()
        };
        let text = transcribe(
            &fake,
            &voice,
            &ModelStore::default(),
            &secrets(),
            b"x",
            "audio/webm",
        )
        .await
        .unwrap();
        assert_eq!(text, "Ask Yardbell to merge it.");
        let calls = fake.calls();
        assert!(calls[1]
            .windows(2)
            .any(|w| w == ["--prompt", "Yardbell, Dispatch, whisper.cpp"]));
        assert!(calls[1].windows(2).any(|w| w == ["-l", "auto"]));
    }
}
