# Voice Trader Test Bench Documentation

## ⚠️ IMPORTANT: There Are TWO Test Benches

### 1. EC2 Test Bench (PRIMARY - for testing)
**URL:** https://voice.apexmarkets.us:8080/test  
**Location:** `/home/ubuntu/kalshi/kalshi-market-capture/voice-trader/static/test.html`  
**Purpose:** Multi-session testing, head-to-head comparisons, STT provider testing  
**V2 Toggle:** Checkbox in header enables V2 pipeline (worker_new.py)  

### 2. Dashboard Voice Trader Page (PRODUCTION UI)
**URL:** https://dashboard.apexmarkets.us/dashboard/voice-trader  
**Location:** `/home/ubuntu/kalshi/kalshi-dashboard/app/dashboard/voice-trader/`  
**Purpose:** Production interface for live trading sessions  

---

## EC2 Test Bench Features

The EC2 test bench at https://voice.apexmarkets.us:8080/test provides:

### V2 Pipeline Toggle
- **Checkbox in header** labeled "V2 Pipeline"
- When checked, all sessions use `worker_new.py` (v2 pipeline)
- When unchecked, sessions use `worker.py` (legacy)
- Toggle turns green when V2 is enabled

### Multi-Session Support
- Launch multiple concurrent sessions
- Compare Telnyx vs Twilio latency (head-to-head)
- Each session has its own WebSocket connection

### STT Provider Comparison
- Head-to-head STT testing (Riva, AWS Transcribe, Deepgram, AssemblyAI)
- Compare transcription latency across providers
- Same audio sent to multiple providers simultaneously

### Real-time Monitoring
- Live transcripts with latency measurements
- Audio chunk metrics
- Word match detection
- System logs per session

---

## Dashboard Voice Trader Page Structure

**This section describes the production UI, NOT the test bench.**

```
app/dashboard/voice-trader/
├── page.tsx                         # Version selector (dropdown)
├── TEST_BENCH_DOCUMENTATION.md      # This file
└── components/
    ├── TestBenchLegacy.tsx          # Legacy production UI (worker.py)
    └── TestBenchV2.tsx              # V2 production UI (worker_new.py) - marked BETA
```

## Version Selector (Dashboard Only)

The main `page.tsx` provides a dropdown in the top-right corner to switch between:
- **Legacy (worker.py)**: Production-stable test bench
- **V2 Pipeline (worker_new.py)**: For testing the new pipeline (marked BETA)

Selection is persisted in localStorage.  

## Purpose

The Voice Trader Test Bench is a **web-based diagnostic and testing UI** that provides direct access to nearly every feature of the Voice Trader system (except live trading). It's designed to:

1. **Exercise all voice trader features** in a highly configurable environment
2. **Observe runtime details** that aren't visible in production (transcripts, audio playback, system logs)
3. **Debug scenarios** with full visibility into state machines, speakers, detection status
4. **Test audio paths** including phone (Telnyx) and web (SRT/YouTube) sources
5. **Monitor real-time system state** during development and debugging

## Accessing the Test Bench

1. Log into the Kalshi Dashboard at https://dashboard.apexmarkets.us
2. Navigate to the **Voice Trader** tab in the sidebar
3. The test bench shows:
   - EC2 server status
   - Available mention events
   - Running sessions
   - Scheduled event queue

## Key Features

### 1. Event Selection & Launch
- Lists all available mention events (KXNFLMENTION-*, etc.)
- Shows word count, start time, hours until start
- Supports two audio sources:
  - **Phone**: Dial into conference call via Telnyx (enter phone number + passcode)
  - **Web**: Stream from SRT/YouTube URL

### 2. Scheduled Event Queue
- Queue events for automatic execution at scheduled times
- Cancel queued events
- View status (pending/started/completed/cancelled)

### 3. Real-Time Monitoring Panel
When a session is active, provides:

#### Audio Controls
- **Mute/Unmute** audio playback
- **Volume control** slider
- **Microphone** enable/disable (two-way audio)
- **DTMF Dialpad** for sending touch-tones (mute/unmute in conferences)

#### Detection Controls
- **Pause/Resume Detection** - Temporarily disable word matching
- **Dry Run Toggle** - Enable/disable trading (trades are simulated)
- **Q&A Detection** - Toggle speaker validation
- **Call End Detection** - Toggle auto-hangup on call termination

#### Status Displays
- **Call State**: ready → connecting → connected → ended
- **Audio Source**: phone/web/stream
- **Speaker Info**: Valid/invalid speaker counts, current speaker ID
- **Trading Parameters**: Bet size, cash balance

#### Live Feeds
- **Transcript Panel**: Real-time speech-to-text with speaker IDs
- **System Log**: Events, trades, warnings, errors (never truncated)
- **Word Status Grid**: Shows each word, triggered status, trade results

### 4. EC2 Server Management
- **Start/Stop/Reboot** EC2 instance
- View server health, uptime, public IP
- Check Riva STT status (GPU transcription service)

### 5. Session Management
- **Reconnect** to running sessions
- **Force call end** - Terminate session manually
- **Cancel** pending connections

## WebSocket Message Types (Test Bench → Worker)

The test bench communicates with the voice trader worker via WebSocket:

| Message Type | Purpose |
|--------------|---------|
| `enable_audio_stream` | Start receiving audio data for playback |
| `get_trading_params` | Request current bet size, balance |
| `set_bet_size` | Update bet size (dollars) |
| `set_detection_paused` | Toggle word detection on/off |
| `set_dry_run` | Toggle dry run mode |
| `set_qa_detection_enabled` | Toggle Q&A speaker detection |
| `set_call_end_detection_enabled` | Toggle call end detection |
| `send_dtmf` | Send DTMF digits to phone line |
| `connect` | Initiate phone call / start streaming |
| `cancel` | Cancel pending connection |
| `redial` | Reconnect to dropped call |
| `force_call_end` | Force terminate session |

## State Machine

```
PageState: loading → events → setup → monitoring

Call States (from worker):
  ready → connecting → connected → ended
  (with various intermediate states)
```

## Technical Details

### Audio Playback
- μ-law encoded audio from worker
- Decoded via Web Audio API
- 50ms jitter buffer for smooth playback
- Real-time volume control via GainNode

### Microphone Input
- AudioWorklet-based capture
- μ-law encoding before transmission
- Two-way audio support for operator conversation

### Wake Lock
- Prevents screen sleep during monitoring
- Auto-reacquires on visibility change

## Configuration

Environment variable for development:
```
NEXT_PUBLIC_VOICE_TRADER_HOST=dev-voice.apexmarkets.us
```

Production defaults to `voice.apexmarkets.us:8080` (HTTPS) and `:8765` (WSS).

## Why This Matters for v2 Migration

When migrating to v2 worker pipeline:
1. **Keep this test bench working** - It's the primary debugging tool
2. **Test bench validates all WebSocket message types** - v2 must support same protocol
3. **Audio playback validates audio pipeline** - v2 must produce compatible audio chunks
4. **Transcript display validates STT pipeline** - v2 must emit same transcript format
5. **Word status grid validates trading signals** - v2 must emit compatible word/trade events

## Backup Strategy

The test bench is now structured with two parallel implementations:

1. **TestBenchLegacy.tsx** - Frozen copy, DO NOT MODIFY during v2 migration
   - Works with `worker.py` (production worker)
   - Serves as reference implementation
   - Fallback if v2 has issues

2. **TestBenchV2.tsx** - Can be modified for v2 pipeline
   - Works with `worker_new.py` (v2 worker)
   - Can add v2-specific features
   - Safe to experiment with

This structure ensures we always have a working test bench during the migration.

---

Last updated: 2026-01-30
