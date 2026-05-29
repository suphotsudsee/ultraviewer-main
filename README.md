# OwnView Assist

OwnView Assist is a React/Vite prototype for a consent-based remote support client.
It is built from the existing source in this repository and reworked into an
independent branded interface.

This repository currently contains a frontend shell plus a local signaling server
for session IDs, status changes, realtime updates, and chat messages. It does not
include a real remote desktop engine, unattended access, device agent, relay
server, or file transfer backend.

The repository also includes an early Windows agent scaffold in
[WindowsAgent](WindowsAgent). It is not a full remote-control agent yet; it is a
visible consent-first native shell that connects to the server and sends
heartbeats.

## Features

- Local access ID and temporary password UI
- Local signaling server using HTTP and WebSocket
- Incoming support mode with explicit user consent copy
- Pending approval step before a session becomes connected
- Two-client request flow: requester waits while the receiving device approves
- Persistent JSONL audit trail for session and consent events
- Short-lived session token required for protected session APIs and WebSocket
- Browser `RTCPeerConnection` negotiation with data channel and screen-share tracks
- Windows agent scaffold with visible consent window and heartbeat registration
- Web UI agent registry for connected Windows agents
- Partner ID form for starting an assisted session
- Session status panel and remote screen placeholder
- Chat mockup for support conversation flow
- Safety checklist for consent, logging, and encryption requirements

## Development

```bash
cd UltraviewSource
npm install
npm run dev
```

This starts both services:

- Vite client: `http://127.0.0.1:5173`
- Signaling server: `http://127.0.0.1:8787`

The Vite dev server proxies `/api` and `/ws` to the signaling server.

Run only one side if needed:

```bash
npm run client
npm run server
```

For LAN-only testing, run the Vite client on all interfaces:

```bash
npm run client:lan
```

## Public Internet Deployment

For cross-internet use, deploy the built app behind HTTPS. Browser screen sharing
with `getDisplayMedia` requires a secure context, so a raw `http://PUBLIC_IP`
URL is not enough for real screen sharing. Use a domain with TLS, for example:

```text
https://phoubonviewer.phoubon.in.th
```

Build and run the production server:

```bash
cd UltraviewSource
npm install
npm run build
set OWNVIEW_HOST=0.0.0.0
set OWNVIEW_SIGNAL_PORT=8787
set OWNVIEW_PUBLIC_URL=https://phoubonviewer.phoubon.in.th
set OWNVIEW_ALLOWED_ORIGIN=https://phoubonviewer.phoubon.in.th
npm run start
```

On Linux, use `export` instead of `set`.

The production server serves both:

- Frontend: `/`
- API and WebSocket: `/api/*` and `/ws`

Place Nginx, Caddy, Cloudflare Tunnel, or another TLS reverse proxy in front of
the Node server:

```text
Internet -> HTTPS reverse proxy :443 -> OwnView Node server :8787
```

Open inbound firewall/security-group ports:

```text
443/tcp   HTTPS public app
80/tcp    optional, only for certificate redirect/challenge
8787/tcp  only if exposing Node directly, not recommended
```

For WebRTC across the public internet, STUN alone often works only for simple NAT
cases. For reliable connections across CGNAT, symmetric NAT, corporate networks,
or mobile networks, deploy a TURN server and configure it with:

```text
OWNVIEW_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"ownview","credential":"change-me"}]
```

TURN server firewall ports usually include:

```text
3478/tcp
3478/udp
49152-65535/udp  relay port range, configurable in coturn
```

Copy [.env.example](UltraviewSource/.env.example) as a deployment checklist.

## Windows Agent Prototype

The Windows agent scaffold lives in:

```text
WindowsAgent
```

Install on the Windows device that will eventually be controlled:

1. Install .NET 8 SDK.
2. Copy `WindowsAgent/agentsettings.example.json` to `WindowsAgent/agentsettings.json`.
3. Set `serverUrl` to your OwnView HTTPS URL.
4. If the server uses `OWNVIEW_AGENT_SHARED_KEY`, set the same value in `agentKey`.
5. Run:

```powershell
cd WindowsAgent
dotnet run
```

The agent currently:

- Shows a visible Windows consent window
- Connects to `/agent`
- Sends `agent.hello` and heartbeat messages
- Appears in `GET /api/agents`
- Appears in the `Windows Agents` panel in the web UI
- Receives visible support requests from the web UI
- Sends approve/reject decisions back to the server
- Captures the visible Windows screen after approval and sends low-rate JPEG frames to the web UI
- Accepts mouse and keyboard input after approval when `allowRemoteInput` is enabled
- Does not support hidden or unattended access

Native input control will be added only behind explicit visible approval and a
visible stop control.

## Two-Client Test Flow

Use two browser windows or two different machines that can reach the same dev
server URL.

1. Open the app as user2, the device receiving support.
2. Click `Open for support`.
3. Copy user2's `ID`.
4. Open the app as user1, the support operator.
5. Enter user2's ID in `Partner ID`.
6. Click `Start connection`.
7. user1 will show `Waiting approval`.
8. user2 will show `Approve remote control?`.
9. user2 clicks `Approve`.
10. Both user1 and user2 move to `Connected`.
11. In user1's `WebRTC Data` panel, click `Start RTC`.
12. When the data channel opens, type a test message and click `Send`.
13. On the device that should share its screen, click `Share Screen`.
14. Approve the browser screen-sharing prompt.

The remote screen uses browser `getDisplayMedia`, so it requires an explicit
browser permission prompt every time. It can share a browser-selected screen,
window, or tab, but it is not yet a native Windows remote-control agent.

## Browser-to-Windows-Agent Flow

Use this when user2 runs the native Windows agent and user1 uses the web UI.

1. Start the public server with `OWNVIEW_PUBLIC_URL` set to your real HTTPS URL.
2. Set `OWNVIEW_AGENT_SHARED_KEY` on the server.
3. On user2's Windows PC, run `WindowsAgent` with matching `serverUrl` and `agentKey`.
4. In the web UI, user1 checks the `Windows Agents` panel.
5. Click `Use ID` on user2's connected agent.
6. Click `Start connection`.
7. user2 sees a visible approval request in the Windows agent window.
8. user2 clicks `Approve visible support` or `Reject / Stop`.

This creates the native agent consent flow, native screen preview, and optional
mouse/keyboard input. Remote input is only relayed when the Windows agent has
`allowRemoteInput` enabled and the local user approves the session.

Audit events are written to:

```text
UltraviewSource/server/data/audit-log.jsonl
```

The audit trail intentionally avoids storing generated passwords. Chat events are
stored as metadata, such as message length, rather than full message content.

Session tokens are issued by `POST /api/sessions` and expire after 15 minutes.
Protected endpoints require the token in the `x-ownview-token` header. WebSocket
connections require the same token in the `token` query parameter. The token is
kept in frontend memory and is not written to the audit log.

## Build

```bash
cd UltraviewSource
npm run build
```

## Lint

```bash
cd UltraviewSource
npm run lint
```

## Next Backend Milestones

1. Persist session records outside process memory.
2. Add authenticated device registration around the current session token flow.
3. Add actor metadata to consent decisions after device authentication exists.
4. Add remote input over the existing data channel with a visible permission model.
5. Add native Windows screen capture and controlled `SendInput` support inside the agent.
