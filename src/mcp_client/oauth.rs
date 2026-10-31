use super::http::{HttpClient, HttpOptions};
use super::{Challenge, Failure};
use crate::config::McpServer;
use crate::connectors::net::{is_private, same, PublicOnly};
use crate::secrets::Secrets;
use crate::settings::Settings;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REPLY_MAX: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const STATE_SECONDS: i64 = 600;
const REFRESH_EARLY_SECONDS: i64 = 60;

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub resource: String,
    pub sign_in_host: String,
    pub authorize: String,
    pub token: String,
    pub registration: Option<String>,
    pub revocation: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Started {
    pub url: String,
    pub sign_in_host: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SignIn {
    NotNeeded,
    NeedsClient {
        redirect: String,
        sign_in_host: String,
    },
    Failed(String),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Meta {
    pub client_id: String,
    pub expires_at: i64,
    pub token: String,
    pub revocation: String,
    pub resource: String,
    pub scope: String,
    pub failed: bool,
    pub server_url: String,
}

struct Pending {
    server: String,
    state: String,
    verifier: String,
    created: chrono::DateTime<chrono::Utc>,
    client_id: String,
    client_secret: Option<String>,
    found: Found,
    redirect: String,
    allow_private: bool,
    server_url: String,
}

// Sign-ins under way, newest per server, and one lock per server so a token is refreshed once.
#[derive(Default)]
pub struct Auth {
    pending: Mutex<HashMap<String, Pending>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn name_of(server: &str, part: &str) -> String {
    format!("mcp_oauth_{server}_{part}")
}

fn client(allow_private: bool) -> Result<reqwest::Client, String> {
    let mut http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT);
    if !allow_private {
        http = http.dns_resolver(Arc::new(PublicOnly));
    }
    http.build().map_err(|e| e.to_string())
}

fn checked(address: &str, allow_private: bool) -> Result<Url, String> {
    let url = Url::parse(address).map_err(|_| format!("{address} is not an address"))?;
    if url.scheme() != "https" && !(url.scheme() == "http" && allow_private) {
        return Err(format!("{address} must be an https address"));
    }
    let literal: Option<std::net::IpAddr> = url
        .host_str()
        .map(|h| h.trim_matches(['[', ']']))
        .and_then(|h| h.parse().ok());
    if !allow_private && literal.is_some_and(is_private) {
        return Err(format!("{address} is a private address"));
    }
    Ok(url)
}

fn chain(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(e) = source {
        text = format!("{text}: {e}");
        source = e.source();
    }
    text
}

async fn read_reply(mut res: reqwest::Response) -> Result<(StatusCode, String), String> {
    let status = res.status();
    if status.is_redirection() {
        return Err(format!(
            "the sign-in host answered a redirect ({}), which Yardbell does not follow",
            status.as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| {
        format!(
            "the sign-in host stopped answering: {}",
            chain(&e.without_url())
        )
    })? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > REPLY_MAX {
            return Err("the sign-in host's reply is too large".to_string());
        }
    }
    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
}

async fn get_json(address: &str, allow_private: bool) -> Result<Value, String> {
    let url = checked(address, allow_private)?;
    let host = url.host_str().unwrap_or_default().to_string();
    let res = client(allow_private)?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not reach {host}: {}", chain(&e.without_url())))?;
    let (status, text) = read_reply(res).await?;
    if !status.is_success() {
        return Err(format!("{host} answered {}", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|_| format!("the reply from {host} is not JSON"))
}

async fn first_json(addresses: &[String], allow_private: bool) -> Result<Value, String> {
    let mut last = "there is nothing to try".to_string();
    for address in addresses {
        match get_json(address, allow_private).await {
            Ok(value) => return Ok(value),
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn origin_of(url: &Url) -> String {
    let mut origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
    if let Some(port) = url.port() {
        origin = format!("{origin}:{port}");
    }
    origin
}

fn resource_addresses(server_url: &str) -> Result<Vec<String>, String> {
    let url = Url::parse(server_url).map_err(|_| format!("{server_url} is not an address"))?;
    let origin = origin_of(&url);
    let path = url.path().trim_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() {
        out.push(format!(
            "{origin}/.well-known/oauth-protected-resource/{path}"
        ));
    }
    out.push(format!("{origin}/.well-known/oauth-protected-resource"));
    Ok(out)
}

fn issuer_addresses(issuer: &str) -> Result<Vec<String>, String> {
    let url = Url::parse(issuer).map_err(|_| format!("{issuer} is not an address"))?;
    let origin = origin_of(&url);
    let path = url.path().trim_matches('/');
    Ok(if path.is_empty() {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server/{path}"),
            format!("{origin}/.well-known/openid-configuration/{path}"),
            format!("{origin}/{path}/.well-known/openid-configuration"),
        ]
    })
}

pub async fn discover(
    server_url: &str,
    challenge: &Challenge,
    allow_private: bool,
) -> Result<Found, String> {
    let resource_meta = match &challenge.resource_metadata {
        Some(address) => get_json(address, allow_private).await?,
        None => first_json(&resource_addresses(server_url)?, allow_private).await?,
    };
    let issuer = resource_meta["authorization_servers"][0]
        .as_str()
        .ok_or("the server does not say where to sign in")?;
    let meta = first_json(&issuer_addresses(issuer)?, allow_private).await?;
    let has_s256 = meta["code_challenge_methods_supported"]
        .as_array()
        .is_some_and(|m| m.iter().any(|v| v == "S256"));
    if !has_s256 {
        return Err(
            "the sign-in host does not offer PKCE with S256, so Yardbell will not sign in there"
                .to_string(),
        );
    }
    let address = |key: &str| -> Result<Option<String>, String> {
        match meta[key].as_str() {
            Some(a) => checked(a, allow_private).map(|_| Some(a.to_string())),
            None => Ok(None),
        }
    };
    let authorize = address("authorization_endpoint")?
        .ok_or("the sign-in host has no authorization address")?;
    let token = address("token_endpoint")?.ok_or("the sign-in host has no token address")?;
    let scope = challenge.scope.clone().or_else(|| {
        resource_meta["scopes_supported"].as_array().map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
    });
    let server_host = Url::parse(server_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string));
    let resource = resource_meta["resource"]
        .as_str()
        .filter(|r| {
            Url::parse(r)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                == server_host
        })
        .unwrap_or(server_url)
        .to_string();
    let sign_in_host = Url::parse(&authorize)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    Ok(Found {
        resource,
        sign_in_host,
        authorize,
        token,
        registration: address("registration_endpoint")?,
        revocation: address("revocation_endpoint")?,
        scope: scope.filter(|s| !s.is_empty()),
    })
}

fn random_text() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn read_meta(secrets: &Secrets, server: &str) -> Option<Meta> {
    serde_json::from_str(secrets.get(&name_of(server, "meta"))?).ok()
}

struct Tokens {
    access: String,
    refresh: Option<String>,
    expires_at: i64,
}

fn tokens_of(text: &str) -> Result<Tokens, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| "the sign-in host's token reply is not JSON".to_string())?;
    let access = value["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("the sign-in host gave no access token")?;
    Ok(Tokens {
        access: access.to_string(),
        refresh: value["refresh_token"].as_str().map(str::to_string),
        expires_at: value["expires_in"].as_i64().map_or(0, |n| now() + n),
    })
}

fn token_error(status: StatusCode, text: &str) -> String {
    let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let said = value["error_description"]
        .as_str()
        .or(value["error"].as_str())
        .unwrap_or("no reason given");
    format!("the sign-in host answered {}: {said}", status.as_u16())
}

fn save(
    store: &Settings,
    server: &str,
    tokens: &Tokens,
    client_secret: Option<&str>,
    meta: &Meta,
) -> Result<(), String> {
    let mut entries = vec![
        (name_of(server, "access"), tokens.access.clone()),
        (
            name_of(server, "meta"),
            serde_json::to_string(meta).map_err(|e| e.to_string())?,
        ),
    ];
    if let Some(refresh) = &tokens.refresh {
        entries.push((name_of(server, "refresh"), refresh.clone()));
    }
    if let Some(secret) = client_secret {
        entries.push((name_of(server, "client"), secret.to_string()));
    }
    // One write, so a restart never finds a rotated refresh token half saved.
    store.set_reserved_secrets(&entries)
}

impl Auth {
    async fn register(
        found: &Found,
        redirect: &str,
        allow_private: bool,
    ) -> Result<(String, Option<String>), String> {
        let address = found
            .registration
            .as_deref()
            .ok_or("no registration address")?;
        let url = checked(address, allow_private)?;
        let body = json!({
            "client_name": "Yardbell",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        });
        let res = client(allow_private)?
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("could not register: {}", chain(&e.without_url())))?;
        let (status, text) = read_reply(res).await?;
        if !status.is_success() {
            return Err(token_error(status, &text));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|_| "the registration reply is not JSON".to_string())?;
        let id = value["client_id"]
            .as_str()
            .ok_or("registration gave no client id")?;
        Ok((
            id.to_string(),
            value["client_secret"].as_str().map(str::to_string),
        ))
    }

    pub async fn start(
        &self,
        server: &McpServer,
        redirect: &str,
        given: Option<(String, Option<String>)>,
        _store: &Settings,
    ) -> Result<Started, SignIn> {
        let failed = |e: String| SignIn::Failed(format!("{}: {e}", server.name));
        let mut probe = HttpClient::new(HttpOptions {
            url: server.url.clone(),
            headers: Vec::new(),
            bearer: None,
            allow_private: server.allow_private,
            saved: Vec::new(),
            timeout: TIMEOUT,
        })
        .map_err(failed)?;
        let challenge = match probe.connect().await {
            Ok(_) => {
                probe.close().await;
                return Err(SignIn::NotNeeded);
            }
            Err(Failure::NeedsSignIn(c)) | Err(Failure::NeedsScope(c)) => c,
            Err(Failure::NotAllowed(_) | Failure::Other(_)) => Challenge::default(),
        };
        let found = discover(&server.url, &challenge, server.allow_private)
            .await
            .map_err(failed)?;
        let (client_id, client_secret) = match given {
            Some(pair) => pair,
            None if found.registration.is_some() => {
                Self::register(&found, redirect, server.allow_private)
                    .await
                    .map_err(failed)?
            }
            None => {
                return Err(SignIn::NeedsClient {
                    redirect: redirect.to_string(),
                    sign_in_host: found.sign_in_host,
                })
            }
        };
        let (state, verifier) = (random_text(), random_text());
        let mut url = checked(&found.authorize, server.allow_private).map_err(failed)?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("response_type", "code")
                .append_pair("client_id", &client_id)
                .append_pair("redirect_uri", redirect)
                .append_pair("state", &state)
                .append_pair("code_challenge", &challenge_of(&verifier))
                .append_pair("code_challenge_method", "S256")
                .append_pair("resource", &found.resource);
            if let Some(scope) = &found.scope {
                q.append_pair("scope", scope);
            }
        }
        let sign_in_host = found.sign_in_host.clone();
        self.pending.lock().expect("sign-ins").insert(
            server.name.clone(),
            Pending {
                server: server.name.clone(),
                state: state.clone(),
                verifier,
                created: chrono::Utc::now(),
                client_id,
                client_secret,
                found,
                redirect: redirect.to_string(),
                allow_private: server.allow_private,
                server_url: server.url.clone(),
            },
        );
        Ok(Started {
            url: url.to_string(),
            sign_in_host,
            state,
        })
    }

    #[cfg(test)]
    pub fn age_for_test(&self, state: &str, seconds: i64) {
        let mut all = self.pending.lock().expect("sign-ins");
        for p in all.values_mut().filter(|p| p.state == state) {
            p.created -= chrono::Duration::seconds(seconds);
        }
    }

    pub async fn finish(
        &self,
        state: &str,
        code: &str,
        store: &Settings,
    ) -> Result<String, String> {
        let pending = {
            let mut all = self.pending.lock().expect("sign-ins");
            let key = all
                .iter()
                .find(|(_, p)| same(&p.state, state))
                .map(|(k, _)| k.clone())
                .ok_or("this sign-in is not the one Yardbell started, or it was already used")?;
            all.remove(&key).expect("the sign-in just found")
        };
        if (chrono::Utc::now() - pending.created).num_seconds() > STATE_SECONDS {
            return Err("this sign-in has expired, so start it again".to_string());
        }
        let mut form = vec![
            ("grant_type", "authorization_code".to_string()),
            ("code", code.to_string()),
            ("redirect_uri", pending.redirect.clone()),
            ("client_id", pending.client_id.clone()),
            ("code_verifier", pending.verifier.clone()),
            ("resource", pending.found.resource.clone()),
        ];
        if let Some(secret) = &pending.client_secret {
            form.push(("client_secret", secret.clone()));
        }
        let url = checked(&pending.found.token, pending.allow_private)?;
        let res = client(pending.allow_private)?
            .post(url)
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("could not finish signing in: {}", chain(&e.without_url())))?;
        let (status, text) = read_reply(res).await?;
        if !status.is_success() {
            return Err(token_error(status, &text));
        }
        let tokens = tokens_of(&text)?;
        let meta = Meta {
            client_id: pending.client_id.clone(),
            expires_at: tokens.expires_at,
            token: pending.found.token.clone(),
            revocation: pending.found.revocation.clone().unwrap_or_default(),
            resource: pending.found.resource.clone(),
            scope: pending.found.scope.clone().unwrap_or_default(),
            failed: false,
            server_url: pending.server_url.clone(),
        };
        save(
            store,
            &pending.server,
            &tokens,
            pending.client_secret.as_deref(),
            &meta,
        )?;
        Ok(pending.server)
    }

    pub fn finish_from_address(address: &str) -> Result<(String, String), String> {
        let url =
            Url::parse(address.trim()).map_err(|_| "that is not a page address".to_string())?;
        if !url.path().ends_with("/oauth/mcp/callback") || url.host_str() != Some("127.0.0.1") {
            return Err("that is not the address Yardbell sent you back to".to_string());
        }
        let field = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        if let Some(error) = field("error") {
            return Err(field("error_description").unwrap_or(error));
        }
        match (field("state"), field("code")) {
            (Some(state), Some(code)) => Ok((state, code)),
            _ => Err("that address holds no sign-in".to_string()),
        }
    }

    fn lock_for(&self, server: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks
            .lock()
            .expect("refresh locks")
            .entry(server.to_string())
            .or_default()
            .clone()
    }

    pub async fn bearer(
        &self,
        server: &McpServer,
        store: &Settings,
    ) -> Result<Option<String>, Failure> {
        let other = |e: String| Failure::Other(format!("{}: {e}", server.name));
        let lost = || Failure::NeedsSignIn(Challenge::default());
        let secrets = store.secrets().map_err(other)?;
        if secrets.get(&name_of(&server.name, "access")).is_none() {
            return Ok(None);
        }
        let fresh =
            |meta: &Meta| meta.expires_at == 0 || meta.expires_at > now() + REFRESH_EARLY_SECONDS;
        let meta = read_meta(&secrets, &server.name)
            .filter(|m| m.server_url == server.url)
            .ok_or_else(lost)?;
        if meta.failed {
            return Err(lost());
        }
        if fresh(&meta) {
            return Ok(secrets
                .get(&name_of(&server.name, "access"))
                .map(str::to_string));
        }
        let lock = self.lock_for(&server.name);
        let _held = lock.lock().await;
        let secrets = store.secrets().map_err(other)?;
        let mut meta = read_meta(&secrets, &server.name)
            .filter(|m| m.server_url == server.url)
            .ok_or_else(lost)?;
        if meta.failed {
            return Err(lost());
        }
        if fresh(&meta) {
            return Ok(secrets
                .get(&name_of(&server.name, "access"))
                .map(str::to_string));
        }
        let mark_failed = |mut meta: Meta| {
            meta.failed = true;
            let text = serde_json::to_string(&meta).unwrap_or_default();
            store.set_reserved_secrets(&[(name_of(&server.name, "meta"), text)])
        };
        let Some(refresh) = secrets.get(&name_of(&server.name, "refresh")) else {
            mark_failed(meta).map_err(other)?;
            return Err(lost());
        };
        let mut form = vec![
            ("grant_type", "refresh_token".to_string()),
            ("refresh_token", refresh.to_string()),
            ("client_id", meta.client_id.clone()),
            ("resource", meta.resource.clone()),
        ];
        if let Some(secret) = secrets.get(&name_of(&server.name, "client")) {
            form.push(("client_secret", secret.to_string()));
        }
        let url = checked(&meta.token, server.allow_private).map_err(other)?;
        let sent = client(server.allow_private)
            .map_err(other)?
            .post(url)
            .form(&form)
            .send()
            .await
            .map_err(|e| other(format!("could not refresh: {}", chain(&e.without_url()))))?;
        let (status, text) = read_reply(sent).await.map_err(other)?;
        if matches!(status, StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED) {
            mark_failed(meta).map_err(other)?;
            return Err(lost());
        }
        if !status.is_success() {
            return Err(other(token_error(status, &text)));
        }
        let tokens = tokens_of(&text).map_err(other)?;
        meta.expires_at = tokens.expires_at;
        save(store, &server.name, &tokens, None, &meta).map_err(other)?;
        Ok(Some(tokens.access))
    }

    pub async fn sign_out(&self, server: &McpServer, store: &Settings) -> Result<(), String> {
        let secrets = store.secrets()?;
        if let Some(meta) = read_meta(&secrets, &server.name).filter(|m| !m.revocation.is_empty()) {
            let token = secrets
                .get(&name_of(&server.name, "refresh"))
                .or(secrets.get(&name_of(&server.name, "access")));
            if let (Some(token), Ok(url), Ok(http)) = (
                token,
                checked(&meta.revocation, server.allow_private),
                client(server.allow_private),
            ) {
                let form = [
                    ("token", token.to_string()),
                    ("client_id", meta.client_id.clone()),
                ];
                if let Err(e) = http.post(url).form(&form).send().await {
                    tracing::warn!(error = %e.without_url(), server = %server.name, "could not revoke a sign-in");
                }
            }
        }
        let names: Vec<String> = ["access", "refresh", "client", "meta"]
            .iter()
            .map(|part| name_of(&server.name, part))
            .collect();
        store.remove_reserved(&names)
    }

    pub fn status(server: &McpServer, secrets: &Secrets) -> &'static str {
        if server.url.is_empty() || !server.headers.is_empty() {
            return "not_needed";
        }
        match read_meta(secrets, &server.name) {
            Some(meta) if meta.failed => "sign_in_again",
            Some(meta)
                if meta.server_url == server.url
                    && secrets.get(&name_of(&server.name, "access")).is_some() =>
            {
                "signed_in"
            }
            _ => "not_signed_in",
        }
    }
}
