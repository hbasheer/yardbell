use super::oauth::{discover, Auth, Meta, SignIn};
use super::Challenge;
use crate::config::{Config, McpServer};
use crate::connectors::tests::{stub, Stub};
use crate::settings::Settings;
use serde_json::json;

pub(crate) const REDIRECT: &str = "http://127.0.0.1:4000/oauth/mcp/callback";

fn config_text() -> &'static str {
    "port: 4000\nmachines:\n  - { name: hp, local: true, root: /tmp }\n"
}

pub(crate) fn store(dir: &tempfile::TempDir) -> Settings {
    let path = dir.path().join("yardbell.yml");
    std::fs::write(&path, config_text()).unwrap();
    Config::load(&path).unwrap();
    Settings::new(
        path,
        dir.path().join("ssh"),
        std::sync::Arc::new(chrono::Local::now),
    )
}

pub(crate) fn server(url: &str) -> McpServer {
    McpServer {
        name: "tool".into(),
        command: String::new(),
        url: url.to_string(),
        env: Default::default(),
        headers: Default::default(),
        machines: vec![],
        allow_private: true,
    }
}

// A server that wants a sign-in, with its sign-in host on the same address.
pub(crate) async fn signing_in(with_registration: bool) -> Stub {
    let s = stub().await;
    s.answer_with(
        "/mcp",
        401,
        vec![(
            "www-authenticate",
            format!(
                "Bearer resource_metadata=\"{}/prm\", scope=\"read\"",
                s.base
            ),
        )],
        "",
    );
    s.answer(
        "/prm",
        200,
        &json!({ "resource": format!("{}/mcp", s.base), "authorization_servers": [s.base] })
            .to_string(),
    );
    let mut meta = json!({
        "issuer": s.base,
        "authorization_endpoint": format!("{}/authorize", s.base),
        "token_endpoint": format!("{}/token", s.base),
        "revocation_endpoint": format!("{}/revoke", s.base),
        "code_challenge_methods_supported": ["S256"],
    });
    if with_registration {
        meta["registration_endpoint"] = json!(format!("{}/register", s.base));
    }
    s.answer(
        "/.well-known/oauth-authorization-server",
        200,
        &meta.to_string(),
    );
    s.answer("/register", 201, r#"{"client_id":"dyn-1"}"#);
    s.answer("/token", 200, r#"{"access_token":"acc-one","refresh_token":"ref-one","expires_in":3600,"token_type":"Bearer"}"#);
    s.answer("/revoke", 200, "{}");
    s
}

fn query(url: &str) -> std::collections::HashMap<String, String> {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

async fn signed_in(s: &Stub, dir: &tempfile::TempDir) -> (Auth, Settings, McpServer) {
    let auth = Auth::default();
    let st = store(dir);
    let srv = server(&format!("{}/mcp", s.base));
    let started = auth
        .start(&srv, REDIRECT, None, &st)
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    auth.finish(&started.state, "code-1", &st).await.unwrap();
    (auth, st, srv)
}

fn set_expired(st: &Settings, name: &str) {
    let secrets = st.secrets().unwrap();
    let mut meta: Meta =
        serde_json::from_str(secrets.get(&format!("mcp_oauth_{name}_meta")).unwrap()).unwrap();
    meta.expires_at = 1;
    st.set_reserved_secrets(&[(
        format!("mcp_oauth_{name}_meta"),
        serde_json::to_string(&meta).unwrap(),
    )])
    .unwrap();
}

#[tokio::test]
async fn discovery_reads_the_challenge() {
    let s = signing_in(true).await;
    let ch = Challenge {
        resource_metadata: Some(format!("{}/prm", s.base)),
        scope: Some("read".into()),
    };
    let found = discover(&format!("{}/mcp", s.base), &ch, true)
        .await
        .unwrap();
    assert_eq!(found.token, format!("{}/token", s.base));
    assert_eq!(found.scope.as_deref(), Some("read"));
    assert_eq!(found.resource, format!("{}/mcp", s.base));
    assert_eq!(
        found.sign_in_host,
        reqwest::Url::parse(&s.base).unwrap().host_str().unwrap()
    );
}

#[tokio::test]
async fn discovery_tries_the_well_known_addresses_in_order() {
    let s = signing_in(true).await;
    let prm =
        json!({ "authorization_servers": [s.base], "scopes_supported": ["a", "b"] }).to_string();
    s.answer("/.well-known/oauth-protected-resource", 200, &prm);
    let found = discover(&format!("{}/mcp", s.base), &Challenge::default(), true)
        .await
        .unwrap();
    assert_eq!(found.scope.as_deref(), Some("a b"));
    let urls = s.urls();
    assert_eq!(urls[0], "/.well-known/oauth-protected-resource/mcp");
    assert_eq!(urls[1], "/.well-known/oauth-protected-resource");
}

#[tokio::test]
async fn discovery_tries_oauth_then_openid() {
    let s = stub().await;
    let meta = json!({
        "authorization_endpoint": format!("{}/a", s.base),
        "token_endpoint": format!("{}/t", s.base),
        "code_challenge_methods_supported": ["S256"],
    })
    .to_string();
    s.answer(
        "/prm",
        200,
        &json!({ "authorization_servers": [format!("{}/tenant", s.base)] }).to_string(),
    );
    s.answer("/tenant/.well-known/openid-configuration", 200, &meta);
    let ch = Challenge {
        resource_metadata: Some(format!("{}/prm", s.base)),
        scope: None,
    };
    discover(&format!("{}/mcp", s.base), &ch, true)
        .await
        .unwrap();
    assert_eq!(
        s.urls()[1..],
        [
            "/.well-known/oauth-authorization-server/tenant",
            "/.well-known/openid-configuration/tenant",
            "/tenant/.well-known/openid-configuration",
        ]
    );
    let s = stub().await;
    s.answer(
        "/prm",
        200,
        &json!({ "authorization_servers": [s.base] }).to_string(),
    );
    let meta = meta.replace("/a", "/b");
    s.answer("/.well-known/openid-configuration", 200, &meta);
    let ch = Challenge {
        resource_metadata: Some(format!("{}/prm", s.base)),
        scope: None,
    };
    discover(&format!("{}/mcp", s.base), &ch, true)
        .await
        .unwrap();
    assert_eq!(
        s.urls()[1..],
        [
            "/.well-known/oauth-authorization-server",
            "/.well-known/openid-configuration"
        ]
    );
}

async fn with_meta(meta: serde_json::Value) -> Result<super::oauth::Found, String> {
    let s = stub().await;
    s.answer(
        "/prm",
        200,
        &json!({ "authorization_servers": [s.base] }).to_string(),
    );
    let text = meta.to_string().replace("BASE", &s.base);
    s.answer("/.well-known/oauth-authorization-server", 200, &text);
    let ch = Challenge {
        resource_metadata: Some(format!("{}/prm", s.base)),
        scope: None,
    };
    discover(&format!("{}/mcp", s.base), &ch, true).await
}

#[tokio::test]
async fn no_pkce_is_refused() {
    let e = with_meta(json!({ "authorization_endpoint": "BASE/a", "token_endpoint": "BASE/t" }))
        .await
        .unwrap_err();
    assert!(e.contains("PKCE"), "{e}");
}

#[tokio::test]
async fn a_plain_only_pkce_is_refused() {
    let e = with_meta(json!({ "authorization_endpoint": "BASE/a", "token_endpoint": "BASE/t", "code_challenge_methods_supported": ["plain"] })).await.unwrap_err();
    assert!(e.contains("PKCE"), "{e}");
}

#[tokio::test]
async fn an_http_sign_in_host_is_refused() {
    let e = discover(
        "https://localhost:9/mcp",
        &Challenge {
            resource_metadata: Some("http://example.com/prm".into()),
            scope: None,
        },
        false,
    )
    .await
    .unwrap_err();
    assert!(e.contains("https"), "{e}");
}

#[tokio::test]
async fn a_private_sign_in_host_is_refused() {
    let e = discover(
        "https://example.com/mcp",
        &Challenge {
            resource_metadata: Some("https://127.0.0.1:9/prm".into()),
            scope: None,
        },
        false,
    )
    .await
    .unwrap_err();
    assert!(e.contains("private address"), "{e}");
    let e = discover(
        "https://example.com/mcp",
        &Challenge {
            resource_metadata: Some("https://localhost:9/prm".into()),
            scope: None,
        },
        false,
    )
    .await
    .unwrap_err();
    assert!(e.contains("private address"), "{e}");
}

#[tokio::test]
async fn a_redirect_in_discovery_is_refused() {
    let s = stub().await;
    s.answer_with(
        "/prm",
        302,
        vec![("location", format!("{}/other", s.base))],
        "",
    );
    let ch = Challenge {
        resource_metadata: Some(format!("{}/prm", s.base)),
        scope: None,
    };
    let e = discover(&format!("{}/mcp", s.base), &ch, true)
        .await
        .unwrap_err();
    assert!(e.contains("redirect"), "{e}");
    assert_eq!(s.urls(), ["/prm"]);
}

#[tokio::test]
async fn html_metadata_says_so() {
    let s = stub().await;
    s.answer("/prm", 200, "<html>");
    let ch = Challenge {
        resource_metadata: Some(format!("{}/prm", s.base)),
        scope: None,
    };
    let e = discover(&format!("{}/mcp", s.base), &ch, true)
        .await
        .unwrap_err();
    assert!(e.contains("not JSON"), "{e}");
}

#[tokio::test]
async fn a_client_is_taken_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let st = store(&dir);
    let s = signing_in(true).await;
    let srv = server(&format!("{}/mcp", s.base));
    let auth = Auth::default();
    let given = auth
        .start(
            &srv,
            REDIRECT,
            Some(("mine".into(), Some("shh-secret".into()))),
            &st,
        )
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    assert_eq!(query(&given.url)["client_id"], "mine");
    assert!(!s.urls().iter().any(|u| u == "/register"));
    let dynamic = auth
        .start(&srv, REDIRECT, None, &st)
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    assert_eq!(query(&dynamic.url)["client_id"], "dyn-1");
    let s = signing_in(false).await;
    let srv = server(&format!("{}/mcp", s.base));
    match auth.start(&srv, REDIRECT, None, &st).await {
        Err(SignIn::NeedsClient {
            redirect,
            sign_in_host,
        }) => {
            assert_eq!(redirect, REDIRECT);
            assert!(!sign_in_host.is_empty());
        }
        other => panic!("{:?}", other.map(|_| ())),
    }
}

#[tokio::test]
async fn registration_asks_for_what_we_do() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    Auth::default()
        .start(
            &server(&format!("{}/mcp", s.base)),
            REDIRECT,
            None,
            &store(&dir),
        )
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    let asked = s.asked.lock().unwrap().clone();
    let body: serde_json::Value =
        serde_json::from_str(&asked.iter().find(|a| a.1 == "/register").unwrap().3).unwrap();
    assert_eq!(body["redirect_uris"], json!([REDIRECT]));
    assert_eq!(
        body["grant_types"],
        json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(body["token_endpoint_auth_method"], "none");
    assert_eq!(body["client_name"], "Yardbell");
}

#[tokio::test]
async fn the_address_carries_everything() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let srv = server(&format!("{}/mcp", s.base));
    let started = Auth::default()
        .start(&srv, REDIRECT, None, &store(&dir))
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    assert!(started.url.starts_with(&format!("{}/authorize?", s.base)));
    let q = query(&started.url);
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["state"], started.state);
    assert!(q["state"].len() >= 32);
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["code_challenge"].len(), 43);
    assert_eq!(q["resource"], srv.url);
    assert_eq!(q["scope"], "read");
    assert_eq!(q["redirect_uri"], REDIRECT);
}

#[tokio::test]
async fn finish_exchanges_and_saves() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let (_, st, srv) = signed_in(&s, &dir).await;
    let asked = s.asked.lock().unwrap().clone();
    let form = &asked.iter().find(|a| a.1 == "/token").unwrap().3;
    for want in [
        "grant_type=authorization_code",
        "code=code-1",
        "code_verifier=",
        "resource=",
        "client_id=dyn-1",
        "redirect_uri=",
    ] {
        assert!(form.contains(want), "{form}");
    }
    let secrets = st.secrets().unwrap();
    assert_eq!(secrets.get("mcp_oauth_tool_access"), Some("acc-one"));
    assert_eq!(secrets.get("mcp_oauth_tool_refresh"), Some("ref-one"));
    let meta: Meta = serde_json::from_str(secrets.get("mcp_oauth_tool_meta").unwrap()).unwrap();
    assert_eq!(meta.client_id, "dyn-1");
    assert!(meta.expires_at > 0);
    assert_eq!(Auth::status(&srv, &secrets), "signed_in");
}

#[tokio::test]
async fn a_wrong_state_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let st = store(&dir);
    let auth = Auth::default();
    auth.start(&server(&format!("{}/mcp", s.base)), REDIRECT, None, &st)
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    assert!(auth.finish("nope", "c", &st).await.is_err());
    assert!(st.secrets().unwrap().get("mcp_oauth_tool_access").is_none());
    assert!(!s.urls().iter().any(|u| u == "/token"));
}

#[tokio::test]
async fn a_used_state_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let st = store(&dir);
    let auth = Auth::default();
    let started = auth
        .start(&server(&format!("{}/mcp", s.base)), REDIRECT, None, &st)
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    auth.finish(&started.state, "c", &st).await.unwrap();
    assert!(auth.finish(&started.state, "c", &st).await.is_err());
}

#[tokio::test]
async fn an_old_state_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let st = store(&dir);
    let auth = Auth::default();
    let started = auth
        .start(&server(&format!("{}/mcp", s.base)), REDIRECT, None, &st)
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    auth.age_for_test(&started.state, 601);
    let e = auth.finish(&started.state, "c", &st).await.unwrap_err();
    assert!(e.contains("expired") || e.contains("again"), "{e}");
}

#[tokio::test]
async fn starting_twice_the_newest_wins() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let st = store(&dir);
    let auth = Auth::default();
    let srv = server(&format!("{}/mcp", s.base));
    let first = auth
        .start(&srv, REDIRECT, None, &st)
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    let second = auth
        .start(&srv, REDIRECT, None, &st)
        .await
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    assert!(
        st.secrets().unwrap().get("mcp_oauth_tool_access").is_none(),
        "nothing saved until the end"
    );
    assert!(auth.finish(&first.state, "c", &st).await.is_err());
    auth.finish(&second.state, "c", &st).await.unwrap();
}

#[test]
fn finish_from_address_reads_a_pasted_address() {
    assert_eq!(
        Auth::finish_from_address("http://127.0.0.1:4000/oauth/mcp/callback?code=c&state=s")
            .unwrap(),
        ("s".to_string(), "c".to_string())
    );
    let e = Auth::finish_from_address(
        "http://127.0.0.1:4000/oauth/mcp/callback?error=access_denied&error_description=No+thanks",
    )
    .unwrap_err();
    assert!(e.contains("No thanks"), "{e}");
    assert!(Auth::finish_from_address("not an address").is_err());
    assert!(Auth::finish_from_address("https://evil.example/oauth/mcp/callback?code=c").is_err());
}

#[tokio::test]
async fn a_token_near_expiry_refreshes() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let (auth, st, srv) = signed_in(&s, &dir).await;
    assert_eq!(
        auth.bearer(&srv, &st).await.unwrap().as_deref(),
        Some("acc-one")
    );
    assert_eq!(
        s.urls().iter().filter(|u| *u == "/token").count(),
        1,
        "still fresh"
    );
    set_expired(&st, "tool");
    s.answer(
        "/token",
        200,
        r#"{"access_token":"acc-two","refresh_token":"ref-two","expires_in":3600}"#,
    );
    assert_eq!(
        auth.bearer(&srv, &st).await.unwrap().as_deref(),
        Some("acc-two")
    );
    let asked = s.asked.lock().unwrap().clone();
    let form = &asked.iter().rev().find(|a| a.1 == "/token").unwrap().3;
    assert!(
        form.contains("grant_type=refresh_token")
            && form.contains("refresh_token=ref-one")
            && form.contains("resource="),
        "{form}"
    );
}

#[tokio::test]
async fn two_callers_refresh_once() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let (auth, st, srv) = signed_in(&s, &dir).await;
    set_expired(&st, "tool");
    let before = s.urls().iter().filter(|u| *u == "/token").count();
    let (a, b) = tokio::join!(auth.bearer(&srv, &st), auth.bearer(&srv, &st));
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(
        s.urls().iter().filter(|u| *u == "/token").count(),
        before + 1
    );
}

#[tokio::test]
async fn a_rotated_refresh_token_is_saved_with_its_access_token() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let (auth, st, srv) = signed_in(&s, &dir).await;
    set_expired(&st, "tool");
    s.answer(
        "/token",
        200,
        r#"{"access_token":"acc-two","refresh_token":"ref-two","expires_in":3600}"#,
    );
    auth.bearer(&srv, &st).await.unwrap();
    let secrets = st.secrets().unwrap();
    assert_eq!(secrets.get("mcp_oauth_tool_refresh"), Some("ref-two"));
    let fresh = Auth::default();
    set_expired(&st, "tool");
    s.answer("/token", 400, r#"{"error":"invalid_grant"}"#);
    let after_restart = fresh.bearer(&srv, &st).await;
    assert!(matches!(after_restart, Err(super::Failure::NeedsSignIn(_))));
    assert_eq!(Auth::status(&srv, &st.secrets().unwrap()), "sign_in_again");
}

#[tokio::test]
async fn a_failed_refresh_says_sign_in_again() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let (auth, st, srv) = signed_in(&s, &dir).await;
    set_expired(&st, "tool");
    s.answer("/token", 400, r#"{"error":"invalid_grant"}"#);
    assert!(matches!(
        auth.bearer(&srv, &st).await,
        Err(super::Failure::NeedsSignIn(_))
    ));
    assert_eq!(Auth::status(&srv, &st.secrets().unwrap()), "sign_in_again");
    let tries = s.urls().iter().filter(|u| *u == "/token").count();
    assert!(auth.bearer(&srv, &st).await.is_err());
    assert_eq!(
        s.urls().iter().filter(|u| *u == "/token").count(),
        tries,
        "no storm of retries"
    );
}

#[tokio::test]
async fn a_network_failure_is_not_a_lost_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let (auth, st, srv) = signed_in(&s, &dir).await;
    set_expired(&st, "tool");
    s.answer("/token", 503, "down");
    assert!(matches!(
        auth.bearer(&srv, &st).await,
        Err(super::Failure::Other(_))
    ));
    assert_eq!(Auth::status(&srv, &st.secrets().unwrap()), "signed_in");
}

#[tokio::test]
async fn sign_out_deletes_and_revokes() {
    let dir = tempfile::tempdir().unwrap();
    let s = signing_in(true).await;
    let (auth, st, srv) = signed_in(&s, &dir).await;
    auth.sign_out(&srv, &st).await.unwrap();
    let secrets = st.secrets().unwrap();
    assert!(secrets
        .list()
        .iter()
        .all(|i| !i.name.starts_with("mcp_oauth_tool")));
    assert!(s.urls().iter().any(|u| u == "/revoke"));
    assert_eq!(Auth::status(&srv, &secrets), "not_signed_in");
    let s = signing_in(true).await;
    let dir = tempfile::tempdir().unwrap();
    let (auth, st, srv) = signed_in(&s, &dir).await;
    s.answer("/revoke", 500, "no");
    auth.sign_out(&srv, &st).await.unwrap();
    assert!(st.secrets().unwrap().get("mcp_oauth_tool_access").is_none());
}

#[test]
fn status_knows_what_needs_no_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    let st = store(&dir);
    let mut srv = server("https://x.example/mcp");
    let secrets = st.secrets().unwrap();
    assert_eq!(Auth::status(&srv, &secrets), "not_signed_in");
    srv.headers
        .insert("Authorization".into(), "Bearer ${secret:t}".into());
    assert_eq!(Auth::status(&srv, &secrets), "not_needed");
    let mut cmd = server("");
    cmd.command = "npx x".into();
    assert_eq!(Auth::status(&cmd, &secrets), "not_needed");
}

#[test]
fn reserved_names_are_hidden_and_refused() {
    let dir = tempfile::tempdir().unwrap();
    let st = store(&dir);
    assert!(crate::secrets::is_reserved("mcp_oauth_x_access"));
    assert!(crate::secrets::is_reserved("pipeline_hook_x"));
    assert!(!crate::secrets::is_reserved("linear"));
    assert!(st.set_secret("mcp_oauth_x_access", "v").is_err());
    st.set_reserved_secrets(&[("mcp_oauth_x_access".to_string(), "value-1".to_string())])
        .unwrap();
    assert!(st.delete_secret("mcp_oauth_x_access").is_err());
    assert_eq!(
        st.secrets().unwrap().get("mcp_oauth_x_access"),
        Some("value-1")
    );
}

#[test]
fn a_sign_in_cannot_be_named_as_a_secret() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets.yml");
    std::fs::write(&path, "mcp_oauth_tool_access: tok-1\nplain: fine\n").unwrap();
    let secrets = crate::secrets::Secrets::load(&path).unwrap();
    assert_eq!(secrets.resolve("${secret:plain}").unwrap(), "fine");
    let e = secrets
        .resolve("Bearer ${secret:mcp_oauth_tool_access}")
        .unwrap_err()
        .to_string();
    assert!(!e.contains("tok-1"), "{e}");
    assert_eq!(
        secrets.get("mcp_oauth_tool_access"),
        Some("tok-1"),
        "Yardbell itself still reads it"
    );
}
