use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::utils::acl::RemoteUrlPattern;
use tauri::{AppHandle, Manager};
use url::{Host, Url};

use crate::windows;

const IDENTIFIER: &str = "server";
const PERMISSIONS: [&str; 2] = ["core:event:default", "clipboard-manager:allow-write-text"];
const TERMINAL_PERMISSIONS: [&str; 1] = ["clipboard-manager:allow-read-text"];

#[derive(Default)]
pub struct Granted(Mutex<Vec<String>>);

pub fn grant_server_pages(app: &AppHandle, server: &str) {
    let Some(pages) = pages(server) else {
        eprintln!("yardbell: no clipboard or shortcuts for {server}: it can't be matched exactly");
        return;
    };
    let granted = app.state::<Granted>();
    let mut granted = granted.0.lock().unwrap();
    let Some(identifier) = identifier(&granted, &pages) else {
        return;
    };
    let added = capabilities(&identifier, &pages)
        .into_iter()
        .try_for_each(|capability| app.add_capability(capability));
    match added {
        Ok(()) => granted.push(pages),
        Err(e) => eprintln!("yardbell: can't give {server} the clipboard and shortcuts: {e}"),
    }
}

fn pages(server: &str) -> Option<String> {
    let url = Url::parse(server).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = match url.host()? {
        Host::Domain(domain) if domain.chars().all(plain_host_char) => domain.to_string(),
        Host::Domain(_) => return None,
        Host::Ipv4(ip) => ip.to_string(),
        // URLPattern reads an unescaped colon as the start of a named group.
        Host::Ipv6(ip) => format!("[{}]", ip.to_string().replace(':', "\\:")),
    };
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let pages = format!("{}://{host}{port}/*", url.scheme());
    pages.parse::<RemoteUrlPattern>().ok()?;
    Some(pages)
}

fn plain_host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')
}

fn identifier(granted: &[String], pages: &str) -> Option<String> {
    if granted.iter().any(|granted| granted == pages) {
        return None;
    }
    Some(match granted.len() {
        0 => IDENTIFIER.to_string(),
        n => format!("{IDENTIFIER}-{}", n + 1),
    })
}

fn capabilities(identifier: &str, pages: &str) -> Vec<CapabilityBuilder> {
    let terminals = format!("{}*", windows::TERMINAL);
    vec![
        capability(
            identifier,
            pages,
            &[windows::MAIN, &terminals],
            &PERMISSIONS,
        ),
        capability(
            &format!("{identifier}-terminal"),
            pages,
            &[&terminals],
            &TERMINAL_PERMISSIONS,
        ),
    ]
}

fn capability(
    identifier: &str,
    pages: &str,
    labels: &[&str],
    permissions: &[&str],
) -> CapabilityBuilder {
    let builder = CapabilityBuilder::new(identifier)
        .remote(pages.to_string())
        .local(false)
        .windows(labels.iter().copied());
    permissions.iter().fold(builder, |builder, permission| {
        builder.permission(*permission)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::capability::{Capability, CapabilityFile};
    use tauri::utils::acl::manifest::Manifest;
    use tauri::utils::acl::resolved::Resolved;
    use tauri::utils::acl::{ExecutionContext, RemoteUrlPattern};
    use tauri::utils::platform::Target;
    use url::Url;

    use super::*;

    const SERVER: &str = "http://100.101.7.20:4100";
    const PAGES: &str = "http://100.101.7.20:4100/*";

    fn matches(pattern: &str, url: &str) -> bool {
        let pattern: RemoteUrlPattern = pattern.parse().unwrap();
        pattern.test(&Url::parse(url).unwrap())
    }

    fn built(capability: CapabilityBuilder) -> Capability {
        match capability.build() {
            CapabilityFile::Capability(capability) => capability,
            _ => panic!("expected a single capability"),
        }
    }

    #[test]
    fn pages_cover_exactly_the_server_origin() {
        assert_eq!(pages(SERVER).as_deref(), Some(PAGES));
        assert_eq!(
            pages("https://box.tail1234.ts.net").as_deref(),
            Some("https://box.tail1234.ts.net/*")
        );
        assert_eq!(
            pages("http://my_box.lan:80").as_deref(),
            Some("http://my_box.lan/*")
        );
        assert_eq!(
            pages("http://[fd7a:115c:a1e0::1]:4100").as_deref(),
            Some("http://[fd7a\\:115c\\:a1e0\\:\\:1]:4100/*")
        );
        assert_eq!(pages("http://100.101.7.20:4100/").as_deref(), Some(PAGES));
    }

    #[test]
    fn pages_refuse_addresses_that_would_widen_the_pattern() {
        for server in [
            "http://*:4100",
            "http://*.ts.net:4100",
            "http://a(b):4100",
            "http://a{b}:4100",
            "http://a+b:4100",
            "file:///etc",
            "tauri://localhost",
            "not an address",
            "",
        ] {
            assert_eq!(pages(server), None, "{server}");
        }
    }

    #[test]
    fn the_pattern_matches_server_pages_and_nothing_else() {
        for url in [
            "http://100.101.7.20:4100/",
            "http://100.101.7.20:4100/term/mini/api-1",
            "http://100.101.7.20:4100/term/my%20box/a%2Fb?x=1#end",
            "http://100.101.7.20:4100/app/handoff/c0de",
        ] {
            assert!(matches(PAGES, url), "{url}");
        }
        for url in [
            "https://100.101.7.20:4100/",
            "http://100.101.7.20:4101/",
            "http://100.101.7.20/",
            "http://100.101.7.200:4100/",
            "http://100.101.7.2:4100/",
            "http://evil.example/http://100.101.7.20:4100/",
            "http://100.101.7.20:4100@evil.example/",
            "http://100.101.7.20.evil.example:4100/",
            "tauri://localhost/launch.html",
        ] {
            assert!(!matches(PAGES, url), "{url}");
        }
        let ipv6 = pages("http://[fd7a:115c:a1e0::1]:4100").unwrap();
        assert!(matches(&ipv6, "http://[fd7a:115c:a1e0::1]:4100/term/a/b"));
        assert!(!matches(&ipv6, "http://[fd7a:115c:a1e0::2]:4100/"));
        assert!(!matches(&ipv6, "http://[fd7a:115c:a1e0::1]:4101/"));
    }

    #[test]
    fn each_server_is_granted_once_under_its_own_identifier() {
        let mut granted = Vec::new();
        let first = identifier(&granted, PAGES);
        assert_eq!(first.as_deref(), Some("server"));
        granted.push(PAGES.to_string());
        assert_eq!(identifier(&granted, PAGES), None);

        let other = "https://box.tail1234.ts.net/*";
        assert_eq!(identifier(&granted, other).as_deref(), Some("server-2"));
        granted.push(other.to_string());
        assert_eq!(identifier(&granted, other), None);
        assert_eq!(identifier(&granted, PAGES), None);
        assert_eq!(
            identifier(&granted, "http://100.1.2.3:4100/*").as_deref(),
            Some("server-3")
        );
    }

    fn permissions(capability: &Capability) -> Vec<String> {
        capability
            .permissions
            .iter()
            .map(|permission| permission.identifier().get().to_string())
            .collect()
    }

    #[test]
    fn the_capabilities_are_remote_only_and_paste_is_for_terminals() {
        let capabilities: Vec<Capability> = capabilities("server", PAGES)
            .into_iter()
            .map(built)
            .collect();
        for capability in &capabilities {
            assert!(!capability.local);
            assert_eq!(
                capability.remote.as_ref().map(|remote| remote.urls.clone()),
                Some(vec![PAGES.to_string()])
            );
            assert!(capability.webviews.is_empty());
        }
        let shown: Vec<(&str, Vec<&str>, Vec<String>)> = capabilities
            .iter()
            .map(|capability| {
                (
                    capability.identifier.as_str(),
                    capability.windows.iter().map(String::as_str).collect(),
                    permissions(capability),
                )
            })
            .collect();
        assert_eq!(
            shown,
            [
                (
                    "server",
                    vec!["main", "term-*"],
                    vec![
                        "core:event:default".to_string(),
                        "clipboard-manager:allow-write-text".to_string()
                    ]
                ),
                (
                    "server-terminal",
                    vec!["term-*"],
                    vec!["clipboard-manager:allow-read-text".to_string()]
                ),
            ]
        );
    }

    #[test]
    fn the_capabilities_resolve_to_events_and_text_clipboard_only() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/gen/schemas/acl-manifests.json"
        );
        let manifests = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("{path} is written by build.rs: {e}"));
        let acl: BTreeMap<String, Manifest> = serde_json::from_str(&manifests).unwrap();
        let resolved = Resolved::resolve(
            &acl,
            capabilities("server", PAGES)
                .into_iter()
                .map(built)
                .map(|capability| (capability.identifier.clone(), capability))
                .collect(),
            Target::current(),
        )
        .unwrap();

        let commands: Vec<&str> = resolved
            .allowed_commands
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            commands,
            [
                "plugin:clipboard-manager|read_text",
                "plugin:clipboard-manager|write_text",
                "plugin:event|emit",
                "plugin:event|emit_to",
                "plugin:event|listen",
                "plugin:event|unlisten",
            ]
        );
        assert!(resolved.denied_commands.is_empty());

        let terminal = windows::terminal_label("mini", "api-1");
        for (command, grants) in &resolved.allowed_commands {
            let paste = command == "plugin:clipboard-manager|read_text";
            for grant in grants {
                let ExecutionContext::Remote { url } = &grant.context else {
                    panic!("{command} is granted to local pages");
                };
                let server_page = Url::parse("http://100.101.7.20:4100/").unwrap();
                let other_port = Url::parse("http://100.101.7.20:5173/").unwrap();
                assert!(url.test(&server_page), "{command}");
                assert!(!url.test(&other_port), "{command}");
                let granted = |label: &str| grant.windows.iter().any(|w| w.matches(label));
                assert!(granted(&terminal), "{command} {terminal}");
                assert_eq!(granted(windows::MAIN), !paste, "{command} main");
                assert!(!granted(windows::CONNECT), "{command} connect");
            }
        }
    }
}
