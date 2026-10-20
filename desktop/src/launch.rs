use crate::client::ClientError;
use crate::windows;

pub const SIGNED_OUT: &str = "Signed out, enter the passcode again";

#[derive(Debug, PartialEq)]
pub enum Startup {
    Open { url: String },
    Retry { server: String },
    Connect { message: Option<String> },
}

pub fn startup(server: &str, result: Result<String, ClientError>) -> Startup {
    match result {
        Ok(code) => Startup::Open {
            url: windows::handoff_url(server, &code),
        },
        Err(ClientError::Unreachable(_) | ClientError::Other(_)) => Startup::Retry {
            server: server.to_string(),
        },
        Err(ClientError::SignedOut) => Startup::Connect {
            message: Some(SIGNED_OUT.to_string()),
        },
        Err(ClientError::WrongPasscode | ClientError::Locked) => Startup::Connect { message: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "http://100.101.7.20:4100";

    #[test]
    fn startup_cases() {
        assert_eq!(
            startup(SERVER, Ok("c0de".into())),
            Startup::Open {
                url: "http://100.101.7.20:4100/app/handoff/c0de".into()
            }
        );
        assert_eq!(
            startup(SERVER, Err(ClientError::Unreachable(SERVER.into()))),
            Startup::Retry {
                server: SERVER.into()
            }
        );
        assert_eq!(
            startup(
                SERVER,
                Err(ClientError::Other(
                    "the server answered 502 Bad Gateway".into()
                ))
            ),
            Startup::Retry {
                server: SERVER.into()
            }
        );
        assert_eq!(
            startup(SERVER, Err(ClientError::SignedOut)),
            Startup::Connect {
                message: Some("Signed out, enter the passcode again".into())
            }
        );
        assert_eq!(
            startup(SERVER, Err(ClientError::WrongPasscode)),
            Startup::Connect { message: None }
        );
        assert_eq!(
            startup(SERVER, Err(ClientError::Locked)),
            Startup::Connect { message: None }
        );
    }
}
