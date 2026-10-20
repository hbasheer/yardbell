# Docker on macOS: host networking check

Yardbell's Docker image needs host networking so its tunnels can open ports on the host and listen
on the mesh address. On Linux that is `network_mode: host`. On macOS, Docker Desktop runs
containers in a VM, and host networking (Docker Desktop 4.34 or later, Settings > Resources >
Network > "Enable host networking") may or may not expose the mesh address.

Status: not verified yet. Run this on your Mac before relying on Docker there; otherwise use the
native binary on macOS.

1. `docker run --rm --network host python:3.12-alpine python -m http.server 4000 --bind <mac-mesh-ip>`
2. On the Mac: `curl -sI http://localhost:4000` and `curl -sI http://<mac-mesh-ip>:4000`
3. From a phone with the mesh VPN on: open `http://<mac-mesh-ip>:4000`
4. `docker run --rm --network host alpine sh -c 'ping -c1 <other-machine-mesh-ip> && nc -zv <other-machine-mesh-ip> 22'`

Docker on macOS is supported only if all four pass. Please report your result in an issue.
