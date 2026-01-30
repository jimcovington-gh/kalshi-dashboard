# Test Bench V2 Migration Plan

**Created:** 2026-01-30 02:53 UTC  
**Last Updated:** 2026-01-30 03:05 UTC  
**Status:** ✅ COMPLETE - Ready for Testing

## Overview

TestBenchV2.tsx has been completely rewritten to work with the v2 worker pipeline (worker_new.py).

## Changes Made

### UI Improvements
1. ✅ **Stats Dashboard Panel** - Real-time session statistics (audio chunks, transcripts, trades, volume, P&L)
2. ✅ **Pipeline Stage Indicator** - Shows Audio → STT → Trading component status
3. ✅ **Session Timer** - Live duration counter
4. ✅ **Error Panel** - Dedicated error display with dismiss
5. ✅ **State Badge** - Clean v2 state display with icons and colors
6. ✅ **Word Grid** - Visual word status with animation for pending trades
7. ✅ **Organized Layout** - Clean top bar, stats, config, words, transcript, log sections

### V2 Native Message Support
1. ✅ `type: state` - Full state with config, stats, pipeline status
2. ✅ `type: state_change` - State transitions
3. ✅ `type: transcript` - Speech-to-text results
4. ✅ `type: trade` - Trade execution with detailed status
5. ✅ `type: error` - Error messages
6. ✅ Legacy message compatibility during transition

### V2 Session States (Displayed Natively)
| State | Icon | Color | Description |
|-------|------|-------|-------------|
| created | ⚪ | gray | Session created |
| configuring | ⚙️ | blue | User setup |
| ready | 🟡 | yellow | Ready to start |
| connecting | 🔄 | blue | Connecting to audio |
| trading | 🟢 | green | Active trading |
| closing | 🔴 | purple | Closing positions |
| completed | ✅ | gray | Ended normally |
| error | ❌ | red | Error state |
| cancelled | ⛔ | orange | User cancelled |

### Code Reduction
- **Before:** 2838 lines (TestBenchLegacy.tsx)
- **After:** 1440 lines (TestBenchV2.tsx)  
- **Reduction:** 49% smaller, cleaner, more maintainable

### Features Preserved
- ✅ Event listing and selection
- ✅ Phone/Web audio source selection
- ✅ Dry run toggle
- ✅ Server start/stop controls
- ✅ Live transcript display
- ✅ System log
- ✅ Word status grid
- ✅ Audio playback with volume control
- ✅ WebSocket reconnection with retries

### Features Temporarily Simplified (Can Add Back If Needed)
- DTMF dialpad (send touch tones)
- Microphone two-way audio
- Scheduled events queue
- Detection pause toggle
- Q&A detection toggle
- Call end detection toggle

## Next Steps

1. **Deploy Dashboard** - `cd kalshi-dashboard && ./deploy.sh "Add v2 test bench"`
2. **Deploy v2 Worker** - Enable USE_NEW_WORKER=true on EC2
3. **Test with Legacy** - Select "Legacy" in dropdown to verify old worker still works
4. **Test with V2** - Select "V2 Pipeline" to test new worker
5. **Compare Behavior** - Run same event with both and compare results
