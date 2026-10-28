# Security policy

Yardbell gives anyone who logs in a full shell on every machine it manages. Please treat it with the
same care as an ssh key.

## How Yardbell is meant to be deployed

- It listens only on `127.0.0.1` and the host's mesh VPN address, never on all interfaces.
- Every page, API call and websocket requires the passcode cookie. Five wrong passcodes in
  a minute lock that address out for five minutes.
- Requests that change anything must come from Yardbell's own origin.
- Do not expose Yardbell to the public internet, a shared LAN, or through a reverse proxy you do not
  control.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
(Security > Report a vulnerability) on this repository. Include the version, a description, and
steps to reproduce. You should hear back within a week.
