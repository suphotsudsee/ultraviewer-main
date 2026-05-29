# OwnView Windows Agent

This is the native Windows agent scaffold for OwnView.

Current status:

- Visible Windows Forms consent window
- Loads `agentsettings.json`
- Connects to the OwnView server over WebSocket `/agent`
- Sends hello and heartbeat messages
- Appears in `GET /api/agents` and the web UI `Windows Agents` panel
- Shows incoming support requests from web users
- Sends approve/reject decisions back to the server
- Captures the visible Windows screen after approval and streams low-rate JPEG frames
- Captures the full Windows virtual desktop, including multiple monitors
- Can accept mouse and keyboard input after approval when `allowRemoteInput` is `true`
- Does not run as a hidden service
- Does not support unattended access

The agent intentionally starts with a visible consent-first shell. Native screen
capture is enabled only after explicit approval. Input injection should only be
added behind explicit on-screen approval, session logging, and a visible stop
control.

## Build

Install .NET 8 SDK on Windows, then run:

```powershell
cd WindowsAgent
dotnet build
```

## Publish

Create a framework-dependent Windows x64 build:

```powershell
cd WindowsAgent
dotnet publish -c Release -r win-x64 --self-contained false -o publish\win-x64
```

The runnable file is:

```text
WindowsAgent\publish\win-x64\OwnViewAgent.exe
```

This build requires .NET Desktop Runtime 8 or newer on the user2 machine.

## Run

Copy the example settings:

```powershell
copy agentsettings.example.json agentsettings.json
```

Edit `agentsettings.json`:

```json
{
  "serverUrl": "https://phoubonviewer.phoubon.in.th",
  "agentKey": "change-this-agent-key",
  "agentName": "DESKTOP-OWNVIEW",
  "requireVisibleApproval": true,
  "allowRemoteInput": false
}
```

`agentKey` must match `OWNVIEW_AGENT_SHARED_KEY` on the server when that
environment variable is set.

Set `"allowRemoteInput": true` only on machines where the local user agrees to
mouse/keyboard control after pressing `Approve visible support`.

Run:

```powershell
dotnet run
```

For the published build, place `agentsettings.json` beside
`OwnViewAgent.exe`, then run:

```powershell
.\OwnViewAgent.exe
```

## Next Agent Milestones

1. Replace JPEG frame polling with WebRTC media transport.
2. Add stronger per-agent enrollment and signed installer flow.
3. Add update flow.
4. Expand keyboard layout handling for non-US keyboards.
