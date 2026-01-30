# Test Bench V2 Migration Plan

**Created:** 2026-01-30 02:53 UTC  
**Last Updated:** 2026-01-30 02:53 UTC  
**Status:** IN PROGRESS

## Overview

This document tracks the migration of TestBenchV2.tsx to work with the new v2 worker pipeline (worker_new.py).

## Goal

Enable all features of the test bench without changing the UI, but using the new v2 worker infrastructure.

## Architecture Differences

### Old Worker (worker.py)
- Monolithic worker with embedded state
- Direct WebSocket message handling
- Hardcoded state broadcasts
- Ad-hoc message protocol

### New Worker (worker_new.py)
- Modular pipeline architecture
- DashboardWebSocketServer handles connections
- Session manages state machine
- Standardized message protocol:
  - Server sends: `{type: "state"|"transcript"|"trade"|"error", data: {...}}`
  - Client sends: `{action: "ping"|"get_state"}`

## Feature Migration Checklist

### 1. Connection & Basic State
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| WebSocket connect | ✅ | ✅ | ⬜ TODO |
| Auto-reconnect | ✅ | ✅ | ⬜ TODO |
| Full state request | `get_state` implicit | `action: get_state` | ⬜ TODO |
| Ping/pong keepalive | `type: ping/pong` | `action: ping` | ⬜ TODO |

### 2. Session Lifecycle
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| Connect (dial/stream) | `type: connect` | Via API → env vars | ⬜ TODO |
| Hangup | `type: hangup` | Session stop | ⬜ TODO |
| Force call end | `type: force_call_end` | Session stop | ⬜ TODO |
| Cancel | `type: cancel` | Session cancel | ⬜ TODO |
| Redial | `type: redial` | New session | ⬜ TODO |

### 3. State Display
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| Call state | `full_state.call_state` | `state.session_state` | ⬜ TODO |
| Status message | `full_state.status_message` | Derived from state | ⬜ TODO |
| Audio source | `full_state.audio_source` | `config.audio.source_type` | ⬜ TODO |
| Session ID | `full_state.session_id` | `state.session_id` | ⬜ TODO |
| Dry run mode | `full_state.dry_run` | `config.trading.dry_run` | ⬜ TODO |

### 4. Transcript Display
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| Interim transcripts | `type: transcript` | `type: transcript` | ⬜ TODO |
| Final transcripts | `transcript.is_final` | Same | ⬜ TODO |
| Speaker ID | `transcript.speaker_id` | Same | ⬜ TODO |
| Timestamps | `transcript.timestamp` | Same | ⬜ TODO |

### 5. Word Matching & Trading
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| Word triggered | `type: word_triggered` | `type: trade` (yes) | ⬜ TODO |
| Word status update | `type: word_status_update` | `type: word_status` | ⬜ TODO |
| Trade executed | `type: trade_executed` | `type: trade` | ⬜ TODO |
| Set bet size | `type: set_bet_size` | Via session config | ⬜ TODO |
| Get trading params | `type: get_trading_params` | `action: get_state` | ⬜ TODO |

### 6. Detection Controls
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| Pause detection | `type: set_detection_paused` | Pipeline pause | ⬜ TODO |
| Dry run toggle | `type: set_dry_run` | Config update | ⬜ TODO |
| Q&A detection | `type: set_qa_detection_enabled` | Config flag | ⬜ TODO |
| Call end detection | `type: set_call_end_detection_enabled` | Config flag | ⬜ TODO |

### 7. Audio Features
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| Enable audio stream | `type: enable_audio_stream` | Automatic | ⬜ TODO |
| Audio playback | Binary chunks | Same | ⬜ TODO |
| DTMF send | `type: send_dtmf` | Audio source method | ⬜ TODO |
| Mic input | Worklet → binary | Same | ⬜ TODO |

### 8. System Log & Events
| Feature | Legacy Support | V2 Support | Status |
|---------|---------------|------------|--------|
| Event log | `type: event` | `type: event` | ⬜ TODO |
| AI events | `type: ai_event` | Same | ⬜ TODO |
| Speaker change | `type: speaker_change` | Same | ⬜ TODO |
| Disconnect alert | `type: disconnect_alert` | `type: error` | ⬜ TODO |

## Implementation Strategy

### Phase 1: Protocol Adapter
Create a message adapter layer that translates between legacy and v2 protocols:
- Incoming: v2 messages → legacy format (for existing UI code)
- Outgoing: legacy commands → v2 actions

### Phase 2: State Mapping
Map v2 session state to legacy state structure:
- `SessionState.TRADING` → `call_state: 'connected'`
- `SessionStats` → UI stat displays
- `SessionConfig` → settings displays

### Phase 3: Command Routing
Implement command sending for v2:
- Detection toggles via session update
- Bet size via session config
- DTMF via audio source

### Phase 4: Event Handling
Ensure all event types are handled:
- Transcripts (same format)
- Trades (new format → adapt)
- Errors (new format → adapt)

## Code Changes Required

### TestBenchV2.tsx Changes

1. **Add V2 protocol constants** (lines ~130)
2. **Add message adapter function** (new function)
3. **Update WebSocket message handler** (lines ~562-800)
4. **Update command sending functions** (various)
5. **Add state mapping helper** (new function)

## Progress Log

| Date | Time | Change | Status |
|------|------|--------|--------|
| 2026-01-30 | 02:53 | Created migration plan | ✅ |
| | | Phase 1: Protocol adapter | ⬜ |
| | | Phase 2: State mapping | ⬜ |
| | | Phase 3: Command routing | ⬜ |
| | | Phase 4: Event handling | ⬜ |
| | | Syntax validation | ⬜ |
| | | Ready for testing | ⬜ |
