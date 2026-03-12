# Listener UI Plan — Voice Trader Dashboard

**Date:** 2026-03-12  
**Status:** In Progress  

## Goal

Add dashboard UI so non-technical operators can manage field listeners (create, assign, monitor) and see listener status during live trading sessions — all without touching a command line.

## Components to Build

### 1. Listener Admin Panel (`ListenerAdminPanel.tsx`)

Full CRUD admin panel, rendered inside the **setup page** of TestBenchV2, below the Audio Source section when "🎧 Field Listener" is selected.

**Features:**
- **List** all registered listeners with status badges (connected / disconnected)
- **Create** new listener: name, passcode, optional phone number
- **Delete** listener (with confirmation)
- **Assign** listener to a trader + optional event ticker
- **QR Code** link to the listener's mobile page (`https://voice.apexmarkets.us:8080/listen/{id}`)
- **Copy Link** button for easy sharing
- Show **call-in number** (+1 703-313-9446) when phone_number is registered

**API Endpoints Used:**
| Action | Method | Endpoint |
|--------|--------|----------|
| List | GET | `/admin/listeners` |
| Create | POST | `/admin/listener` — body: `{name, passcode, phone_number}` |
| Delete | DELETE | `/admin/listener/{id}` |
| Assign | POST | `/admin/listener/{id}/assign` — body: `{trader, event_ticker}` |
| Status | GET | `/admin/listener/{id}/status` |

### 2. Audio Source: "Field Listener" Option

Add `'listener'` to the audioSource union type in TestBenchV2. When selected:
- Show the ListenerAdminPanel inline
- The session doesn't need to use listener as its audio_source on /connect — listeners inject transcripts independently
- Launch button behavior unchanged (user still picks phone/satellite/etc. as the primary audio source)

**Actually, better approach:** Listeners work independently of the audio source selection. They inject transcripts into any active session for the assigned trader. So instead of making "listener" an audio source option, we should:
1. Add a collapsible **"Field Listeners"** section to the setup page (always visible, regardless of audio source)
2. Add a **listener status bar** to the monitoring page showing connected listeners in real-time

### 3. Listener Status Bar (`ListenerStatusBar.tsx`)

Compact bar shown on the **monitoring page**, between the error panel and stats panel. Shows:
- Number of connected listeners for the current trader
- Each listener's name, connection duration, last audio timestamp
- Green dot = connected & streaming, Yellow dot = connected but no audio in 10s, Gray dot = disconnected
- Expandable to show transcription activity

**Data source:** Poll `GET /admin/listeners` every 5 seconds during active session.

## UI Layout

### Setup Page (modified)
```
Back Button
Audio Source Buttons (6 existing + no new one)
Conditional Form Panels (phone/web/satellite/etc.)
──────────────────────────────────
▼ Field Listeners (collapsible)     ← NEW
  [+ Add Listener]
  ┌─────────────────────────────┐
  │ 🟢 "Field Mic 1" (jimc)    │
  │    📱 Link  📋 Copy  🗑️    │
  │ ⚪ "Field Mic 2" (unassigned)│
  │    📱 Link  📋 Copy  🗑️    │
  └─────────────────────────────┘
  Call-in: +1 (703) 313-9446
──────────────────────────────────
Dry Run Toggle
Launch Button
Words Preview
```

### Monitoring Page (modified)
```
Top Bar (State + Timer + Pipeline + Controls)
Error Panel
Listener Status Bar                              ← NEW
Stats Panel
VNC Panels
Config Info
Word Grid
Transcript + Log
```

## Design Decisions

1. **No separate admin page** — listeners are managed inline on the voice trader setup page, where the operators already are.

2. **Listeners are independent of audio source** — A session can use "phone" as its primary audio, and have 3 field listeners also feeding transcripts simultaneously. This matches the backend design.

3. **QR codes** — Generated client-side from the listener URL. No server dependency.

4. **Auto-refresh** — Listener list and status poll every 5s via EC2 direct calls (no API Gateway auth needed for these, since /admin/* requires Cognito JWT which the dashboard already has... wait, but EC2 calls in TestBenchV2 don't send auth headers). Need to check if admin endpoints require auth or if the Cognito middleware on the API server handles this.

   **Resolution:** The api_server.py has Cognito auth middleware on `/admin/*` routes. The dashboard fetches a Cognito token on load (`fetchAuthSession`). EC2 direct calls will need to include the Bearer token for admin endpoints.

5. **Minimal state** — Listener data is fetched from the server; no complex local state management needed.

## Implementation Checklist

- [ ] Create `ListenerAdminPanel.tsx` component
- [ ] Create `ListenerStatusBar.tsx` component  
- [ ] Add "Field Listeners" collapsible section to setup page in TestBenchV2
- [ ] Add ListenerStatusBar to monitoring page in TestBenchV2
- [ ] Add listener types/interfaces
- [ ] Wire up API calls with Cognito auth
- [ ] Test locally with `npm run build`
- [ ] Run pre-deploy validation
- [ ] Deploy via `./deploy.sh`
