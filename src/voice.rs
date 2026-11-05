use crate::config::{expand_tilde, VoiceInput, VoiceSettings};
use crate::secrets::Secrets;
use crate::shell::{Output, Runner};
use rand::Rng;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const AUDIO_MAX: usize = 25 * 1024 * 1024;
pub const DEFAULT_WHISPER_COMMAND: &str = "whisper-cli";
pub const DEFAULT_API_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const DEFAULT_API_MODEL: &str = "whisper-1";
const CONVERT_TIMEOUT: Duration = Duration::from_secs(60);
const WHISPER_TIMEOUT: Duration = Duration::from_secs(300);
const API_TIMEOUT: Duration = Duration::from_secs(120);

pub const OFF_MESSAGE: &str = "Voice input is off. Turn it on under Settings, Voice.";

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
    secrets: &Secrets,
    audio: &[u8],
    mime: &str,
) -> Result<String, String> {
    if audio.is_empty() {
        return Err("the recording is empty".into());
    }
    match voice.input {
        VoiceInput::Off => Err(OFF_MESSAGE.into()),
        VoiceInput::Local => local(runner, voice, audio, mime).await,
        VoiceInput::Api => api(voice, secrets, audio, mime).await,
    }
}

async fn local(
    runner: &dyn Runner,
    voice: &VoiceSettings,
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
    let mut argv = vec![
        command.to_string(),
        "-m".into(),
        expand_tilde(voice.whisper_model.trim())
            .display()
            .to_string(),
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
    if !language.is_empty() {
        form = form.text("language", language.to_string());
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
            let model = expand_tilde(voice.whisper_model.trim());
            if !model.is_file() {
                problems.push(format!("there is no model file at {}", model.display()));
            }
            if problems.is_empty() {
                (true, "ffmpeg, the Whisper command and the model are all in place.".into())
            } else {
                (false, problems.join(". "))
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
        let text = transcribe(&fake, &local_settings(), &secrets(), b"x", "audio/webm")
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
        let text = transcribe(&fake, &voice, &secrets(), b"x", "audio/ogg")
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
        let err = transcribe(&fake, &local_settings(), &secrets(), b"x", "audio/webm")
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
        let err = transcribe(&fake, &local_settings(), &secrets(), b"x", "audio/webm")
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
        let (ok, message) = check(&fake, &local_settings(), &secrets()).await;
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
        let (ok, _) = check(&FakeRunner::default(), &voice, &secrets()).await;
        assert!(ok);
        let missing = VoiceSettings {
            api_key: "${secret:gone}".into(),
            ..voice
        };
        let (ok, message) = check(&FakeRunner::default(), &missing, &secrets()).await;
        assert!(!ok);
        assert!(message.contains("gone"), "{message}");
    }
}
