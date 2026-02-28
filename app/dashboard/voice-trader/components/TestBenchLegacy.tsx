/**
 * TestBenchLegacy.tsx - Legacy Voice Trader Test Bench
 * 
 * This is the ORIGINAL test bench that works with the legacy worker.py.
 * DO NOT MODIFY THIS FILE during v2 migration - it serves as:
 * 1. A working backup for production testing
 * 2. A reference implementation for the v2 test bench
 * 3. A fallback if v2 has issues
 * 
 * See TEST_BENCH_DOCUMENTATION.md for full documentation.
 */
'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

interface MentionEvent {
  event_ticker: string;
  title: string;
  start_date: string;  // ISO format
  hours_until_start: number;
  words: { market_ticker: string; word: string }[];
  word_count: number;
  container_status: string;
  container_task_arn?: string;
}

interface WordStatus {
  market_ticker: string;
  word: string;
  variants: string[];
  triggered: boolean;
  triggered_at?: number;
  no_purchased: boolean;
  trade_result?: {
    contracts_filled?: number;
    avg_buy_price?: number;
    cost?: number;
    sell_fill_price?: number;
    sell_contracts?: number;
    realized_profit?: number;
  };
  status?: 'pending' | 'success' | 'no_fill' | 'failed' | 'skipped';
}

interface Speaker {
  id: string;
  sample: string;
  is_valid: boolean;
}

interface ContainerState {
  call_state: string;
  status_message: string;
  audio_source: string;  // 'phone' or 'web'/'stream'
  qa_started: boolean;
  qa_detection_enabled: boolean;
  call_end_detection_enabled: boolean;
  detection_paused: boolean;
  dry_run: boolean;
  speakers: {
    valid_count: number;
    invalid_count: number;
    current: string;
    filter_enabled: boolean;
    details: Speaker[];
  };
  transcript_segments: number;
}

interface PnLSummary {
  cash_balance: number;
  total_exposure: number;
  realized_pnl: number;
  trades_count: number;
  trades: any[];
}

interface TranscriptSegment {
  text: string;
  timestamp: number;
  is_final: boolean;
  speaker_id?: string;
  show_speaker?: boolean;  // Show speaker ID prefix for this segment
  show_timestamp?: boolean;  // Show timestamp prefix for this segment
}

// System log entry - for events, trades, status changes (never truncated)
interface SystemLogEntry {
  timestamp: number;
  message: string;
  level: 'info' | 'trade' | 'warning' | 'error' | 'ai';
  details?: string;
}

interface RunningVoiceContainer {
  session_id: string;
  event_ticker: string;
  title: string;
  user_name: string;
  status: string;
  call_state: string;
  started_at: string;
  public_ip?: string;
  websocket_url?: string;
}

interface EC2Status {
  instance_id: string;
  status: 'running' | 'stopped' | 'stopping' | 'pending' | 'terminated';
  public_ip?: string;
  public_dns?: string;
  launch_time?: string;
  uptime_hours?: number;
  websocket_url?: string;
}

interface RivaStatus {
  endpoint: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  port_open: boolean;
  riva_client: boolean;
  health_check_ms?: number;
  connection_ms?: number;
  timestamp: string;
  error?: string;
}

interface QueuedEvent {
  event_ticker: string;
  scheduled_time: string;
  scheduled_timestamp: number;
  phone_number: string;
  user_name: string;
  status: 'pending' | 'started' | 'completed' | 'cancelled';
  created_at: string;
  config?: Record<string, unknown>;
  is_stale?: boolean;  // True if scheduled time passed more than 3 hours ago
  hours_until_start?: number;  // Hours until scheduled start (if not stale)
  hours_since_scheduled?: number;  // Hours since scheduled time (if stale)
}

type PageState = 'loading' | 'events' | 'setup' | 'monitoring';

const API_BASE = 'https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod';

// Voice Trader backend URLs - use env vars for dev/prod switching
// For local dev: create .env.local with NEXT_PUBLIC_VOICE_TRADER_HOST=dev-voice.apexmarkets.us
const VOICE_TRADER_HOST = process.env.NEXT_PUBLIC_VOICE_TRADER_HOST || 'voice.apexmarkets.us';
const EC2_BASE = `https://${VOICE_TRADER_HOST}:8080`;  // Direct EC2 endpoint
const WS_BASE = `wss://${VOICE_TRADER_HOST}:8765`;  // WebSocket endpoint

// Satellite channel picker thumbnail — auto-refreshes JPEG snapshot every 5s
function SatSnapshotImg({ streamId, ec2Base }: { streamId: number; ec2Base: string }) {
  const [ts, setTs] = React.useState(Date.now());
  React.useEffect(() => {
    const iv = setInterval(() => setTs(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);
  return (
    <img
      src={`${ec2Base}/satellite/snapshot/${streamId}?t=${ts}`}
      className="w-full aspect-video object-cover bg-black"
      alt=""
      style={{ minHeight: '90px' }}
      onError={e => { (e.currentTarget as HTMLImageElement).style.opacity = '0.2'; }}
    />
  );
}

export function TestBenchLegacy({ autoEventTicker }: { autoEventTicker?: string } = {}) {
  const router = useRouter();
  const [pageState, setPageState] = useState<PageState>('loading');
  const [events, setEvents] = useState<MentionEvent[]>([]);
  const autoEventHandled = useRef(false);
  const [selectedEvent, setSelectedEvent] = useState<MentionEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  // Setup form state
  const [audioSource, setAudioSource] = useState<'phone' | 'web' | 'satellite' | 'desktop'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('+12026268888');
  const [passcode, setPasscode] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [primeUrl, setPrimeUrl] = useState('');

  // Satellite TV channel picker
  interface SatStream { stream_id: number; channel_name: string; status: string; thumb_url: string; }
  const [satStreams, setSatStreams] = useState<SatStream[]>([]);
  const [satLoading, setSatLoading] = useState(false);
  const [satError, setSatError] = useState<string | null>(null);
  const [selectedSatStreamId, setSelectedSatStreamId] = useState<number | null>(null);
  const [scheduledStart, setScheduledStart] = useState('');
  const [dryRun, setDryRun] = useState(false);  // Dry run mode - no real trades
  const [showStarted, setShowStarted] = useState(false);  // Toggle to show already-started events
  
  // Launch state
  const [launching, setLaunching] = useState(false);
  const [launchStatus, setLaunchStatus] = useState('');
  
  // Monitoring state
  const [containerState, setContainerState] = useState<ContainerState | null>(null);
  const [words, setWords] = useState<WordStatus[]>([]);
  const [pnl, setPnl] = useState<PnLSummary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [systemLog, setSystemLog] = useState<SystemLogEntry[]>([]);  // System log - never truncated
  const [lastSpeakerId, setLastSpeakerId] = useState<string | null>(null);  // Track speaker changes
  const wsConnectedOnceRef = useRef<boolean>(false);  // Track if we've logged connection once
  const lastLoggedStatusRef = useRef<string | null>(null);  // Prevent Strict Mode duplicate logs
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const systemLogRef = useRef<HTMLDivElement | null>(null);  // For auto-scroll  
  // Audio playback state
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0.7);
  const [audioActive, setAudioActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  // Jitter buffer: track next scheduled playback time for gapless audio
  const nextPlayTimeRef = useRef<number>(0);
  const JITTER_BUFFER_MS = 50; // Buffer 50ms before starting playback (low latency for operator conversation);
  // Audio chunk counter for debugging
  const audioChunkCountRef = useRef<number>(0);
  const audioChunkLogIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Microphone state for two-way audio
  const [micEnabled, setMicEnabled] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioWorkletRef = useRef<AudioWorkletNode | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  
  // Dialpad state
  const [dialpadInput, setDialpadInput] = useState('');
  const [dialpadOpen, setDialpadOpen] = useState(false);
  
  // Trading parameters state
  const [betSize, setBetSize] = useState<number>(10);  // Last confirmed bet size on the server
  const [betSizeInput, setBetSizeInput] = useState<string>('10');  // Text input value (may differ from betSize while editing)
  const [betSizeDirty, setBetSizeDirty] = useState<boolean>(false);  // True when input differs from confirmed value
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [availableCash, setAvailableCash] = useState<number>(0);
  const [minTrade, setMinTrade] = useState<number>(10);  // Minimum trade size
  
  // WebSocket connection state
  const [wsConnected, setWsConnected] = useState(false);
  
  // Auto-dial state (true if voice trader will dial at scheduled time without user interaction)
  // Default to false so Start Call button shows until server confirms auto-dial
  const [autoDial, setAutoDial] = useState(false);
  
  // Auth token
  const [authToken, setAuthToken] = useState<string | null>(null);
  
  // Wake lock to prevent screen sleep during monitoring
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  
  // State for dial button UI feedback
  const [dialing, setDialing] = useState(false);
  
  // Running containers (for reconnection)
  const [runningContainers, setRunningContainers] = useState<RunningVoiceContainer[]>([]);

  // EC2 Voice Server state
  const [ec2Status, setEc2Status] = useState<EC2Status | null>(null);
  const [ec2Loading, setEc2Loading] = useState(false);
  const [ec2Error, setEc2Error] = useState<string | null>(null);

  // Riva STT server state
  const [rivaStatus, setRivaStatus] = useState<RivaStatus | null>(null);
  
  // Scheduled events queue state
  const [queuedEvents, setQueuedEvents] = useState<QueuedEvent[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [showQueueForm, setShowQueueForm] = useState(false);
  const [newQueueEvent, setNewQueueEvent] = useState({
    event_ticker: '',
    scheduled_time: '',
    phone_number: '+12026268888'
  });

  // Check for cert_accepted param on load (redirect back from cert page)
  // Fetch auth token on mount
  useEffect(() => {
    async function getAuth() {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (token) {
          setAuthToken(token);
          setPageState('events');
        } else {
          router.push('/');
        }
      } catch (err) {
        console.error('Auth error:', err);
        router.push('/');
      }
    }
    getAuth();
  }, [router]);

  // Wake lock management - prevents screen sleep during monitoring
  useEffect(() => {
    if (pageState !== 'monitoring') {
      // Release wake lock when not monitoring
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('Wake lock released');
      }
      return;
    }
    
    // Request wake lock when monitoring
    async function requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          console.log('Wake lock acquired - screen will stay on');
          
          wakeLockRef.current.addEventListener('release', () => {
            console.log('Wake lock released by system');
          });
        } catch (err) {
          console.log('Wake lock request failed:', err);
        }
      } else {
        console.log('Wake Lock API not supported');
      }
    }
    
    requestWakeLock();
    
    // Re-acquire wake lock when page becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && pageState === 'monitoring') {
        requestWakeLock();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
  }, [pageState]);

  // Auto-scroll system log to bottom when new entries are added
  useEffect(() => {
    if (systemLogRef.current) {
      systemLogRef.current.scrollTop = systemLogRef.current.scrollHeight;
    }
  }, [systemLog]);

  // Fetch events and running containers
  useEffect(() => {
    if (pageState !== 'events' || !authToken) return;
    
    async function fetchEvents() {
      // Primary: Use Lambda API (works even when EC2 is down)
      try {
        const response = await fetch(`${API_BASE}/voice-trader/events`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
        });
        
        if (response.ok) {
          const data = await response.json();
          setEvents(data.events || []);
          setError(null);
          return;
        } else {
          console.log('Lambda events API returned status:', response.status);
        }
      } catch (err) {
        console.log('Lambda events API failed:', err);
      }
      
      // Fallback: Try EC2 directly (faster if EC2 is running)
      try {
        const response = await fetch(`${EC2_BASE}/events`);
        
        if (response.ok) {
          const data = await response.json();
          setEvents(data.events || []);
          setError(null);
          return;
        }
      } catch (err) {
        console.log('EC2 events API failed:', err);
      }
      
      // Both sources failed
      setError('Failed to load events - check your connection');
    }
    
    async function fetchRunningContainers() {
      // Get status directly from EC2
      // Use short timeout (3s) to fail fast when EC2 is down
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      try {
        const response = await fetch(`${EC2_BASE}/status`, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const data = await response.json();
          // Convert single session status to container list format
          if (data.status !== 'idle' && data.session_id) {
            setRunningContainers([{
              session_id: data.session_id || 'current',
              event_ticker: data.event_ticker,
              title: data.event_ticker,
              user_name: data.user_name || 'unknown',
              status: data.status,
              call_state: data.call_state,
              started_at: data.started_at,
              websocket_url: WS_BASE
            }]);
          } else {
            setRunningContainers([]);
          }
        }
      } catch (err) {
        console.error('Error fetching status:', err);
        setRunningContainers([]);
      }
    }

    async function fetchEC2Status() {
      // Check if EC2 is responding by hitting health endpoint
      // Use short timeout (3s) to fail fast when EC2 is down
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      try {
        const response = await fetch(`${EC2_BASE}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const data = await response.json();
          setEc2Status({
            instance_id: data.instance_id || 'voice-trader-ec2',
            status: 'running',
            public_ip: data.public_ip || VOICE_TRADER_HOST,
            websocket_url: WS_BASE,
            uptime_hours: data.uptime_seconds ? data.uptime_seconds / 3600 : undefined
          });
          setEc2Error(null);
        } else {
          setEc2Status({
            instance_id: 'voice-trader-ec2',
            status: 'stopped',
            public_ip: undefined,
            websocket_url: undefined
          });
        }
      } catch (err) {
        // If we can't reach EC2, it's probably stopped
        setEc2Status({
          instance_id: 'voice-trader-ec2',
          status: 'stopped',
          public_ip: undefined,
          websocket_url: undefined
        });
        setEc2Error('Voice server not responding');
      }
    }

    async function fetchRivaStatus() {
      // Only fetch Riva status if EC2 is running
      // Use short timeout (3s) to fail fast when EC2 is down
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      try {
        const response = await fetch(`${EC2_BASE}/riva/status`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
          const data = await response.json();
          setRivaStatus(data);
        } else {
          setRivaStatus({
            endpoint: 'localhost:50051',
            status: 'unknown',
            port_open: false,
            riva_client: false,
            timestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        // EC2 not reachable, Riva status unknown
        setRivaStatus(null);
      }
    }

    async function fetchQueuedEvents() {
      // First try Lambda API (has stale detection)
      try {
        const response = await fetch(`${API_BASE}/voice-trader/ec2/queue/list`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
        });
        if (response.ok) {
          const data = await response.json();
          setQueuedEvents(data.events || []);
          setQueueError(null);
          return;
        }
      } catch (err) {
        console.log('Lambda queue failed, falling back to EC2');
      }
      
      // Fallback to EC2 direct (with short timeout)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${EC2_BASE}/queue`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
          const data = await response.json();
          setQueuedEvents(data.events || []);
          setQueueError(null);
        } else {
          setQueueError('Failed to fetch queue');
        }
      } catch (err) {
        setQueuedEvents([]);
      }
    }
    
    fetchEvents().then(() => {
      // Auto-select event from URL param (e.g. ?event=TICKER opened in new window)
      if (autoEventTicker && !autoEventHandled.current) {
        autoEventHandled.current = true;
        setEvents(prev => {
          const match = prev.find(e => e.event_ticker === autoEventTicker);
          if (match) {
            setSelectedEvent(match);
            setPageState('setup');
          }
          return prev;
        });
      }
    });
    fetchRunningContainers();
    fetchEC2Status();
    fetchRivaStatus();
    fetchQueuedEvents();
    const eventsInterval = setInterval(fetchEvents, 30000); // Refresh every 30s
    const containersInterval = setInterval(fetchRunningContainers, 10000); // Refresh every 10s
    const ec2Interval = setInterval(fetchEC2Status, 5000); // Refresh EC2 status every 5s
    const rivaInterval = setInterval(fetchRivaStatus, 10000); // Refresh Riva status every 10s
    const queueInterval = setInterval(fetchQueuedEvents, 30000); // Refresh queue every 30s
    return () => {
      clearInterval(eventsInterval);
      clearInterval(containersInterval);
      clearInterval(ec2Interval);
      clearInterval(rivaInterval);
      clearInterval(queueInterval);
    };
  }, [pageState, authToken]);

  // WebSocket connection for monitoring with retry logic
  useEffect(() => {
    if (pageState !== 'monitoring' || !wsUrl) return;
    
    let ws: WebSocket | null = null;
    let retryCount = 0;
    const maxRetries = 15;  // Try for ~30 seconds (2s intervals)
    let retryTimeout: NodeJS.Timeout | null = null;
    let isConnecting = true;
    
    const connectWebSocket = () => {
      if (!isConnecting) return;
      
      try {
        console.log(`WebSocket connecting to ${wsUrl} (attempt ${retryCount + 1}/${maxRetries})...`);
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.binaryType = 'arraybuffer'; // Enable binary data for audio
        
        ws.onopen = () => {
          console.log('Connected to voice trader WebSocket');
          setWsConnected(true);
          retryCount = 0;  // Reset retry count on success
          
          // Log connection to system log ONLY on first connect (not reconnects)
          if (!wsConnectedOnceRef.current) {
            wsConnectedOnceRef.current = true;
            setSystemLog(prev => [...prev, {
              timestamp: Date.now() / 1000,
              message: 'Connected to Voice Trader',
              level: 'info'
            }]);
          }
          
          // Request audio streaming
          ws?.send(JSON.stringify({ type: 'enable_audio_stream' }));
          // Request trading parameters
          ws?.send(JSON.stringify({ type: 'get_trading_params' }));
          // Send current bet size (user-controlled, defaults to $10)
          ws?.send(JSON.stringify({ type: 'set_bet_size', dollars: betSize }));
        };
        
        ws.onmessage = (event) => {
          // Handle binary audio data (always ArrayBuffer since we set ws.binaryType = 'arraybuffer')
          if (event.data instanceof ArrayBuffer) {
            let audioBuffer = event.data;
            const size = audioBuffer.byteLength;
            const firstByte = new Uint8Array(audioBuffer)[0];
            
            // CRITICAL: Check if this is actually JSON text encoded as ArrayBuffer
            // JSON starts with '{' (0x7B) - skip these, they're not audio!
            if (firstByte === 0x7B) {  // '{' character
              // This is JSON, decode and handle as message
              const text = new TextDecoder().decode(audioBuffer);
              const data = JSON.parse(text);
              // Re-dispatch as if it were a text message (fall through to JSON handling below)
              // by NOT returning here
            } else {
              // Skip tiny chunks (likely corrupted)
              if (size < 100) {
                console.warn(`[AUDIO] Tiny chunk skipped: size=${size}`);
                return;
              }
              
              // If odd number of bytes, pad to make even (Int16Array requires pairs)
              if (size % 2 !== 0) {
                const padded = new Uint8Array(size + 1);
                padded.set(new Uint8Array(audioBuffer));
                padded[size] = 0;
                audioBuffer = padded.buffer;
              }
              
              // Play the audio
              playAudioChunk(audioBuffer);
              return;
            }
          }
          
          // Handle JSON text messages (or JSON-as-ArrayBuffer that fell through)
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(new TextDecoder().decode(event.data));
          
          if (data.type === 'full_state') {
            // DEBUG: Log words received
            const triggeredWords = (data.words || []).filter((w: any) => w.triggered);
            console.log('[FULL_STATE] words:', data.words?.length, 'triggered:', triggeredWords.length, triggeredWords.map((w: any) => w.market_ticker));
            
            // Log status_message changes to System Log
            // NOTE: Must compare and log OUTSIDE setContainerState to avoid React Strict Mode
            // double-invocation causing duplicate log entries (side effects in updaters run twice!)
            const newStatus = data.call?.status_message;
            setContainerState(prevState => {
              // Log only if status actually changed (check inside updater for accurate prev value)
              // But use a ref to ensure we only log once even with Strict Mode double-invoke
              if (newStatus && newStatus !== prevState?.status_message) {
                // Check if we already logged this exact status (prevents Strict Mode duplicates)
                if (lastLoggedStatusRef.current !== newStatus) {
                  lastLoggedStatusRef.current = newStatus;
                  // Schedule the log entry (will only run once due to ref guard)
                  setTimeout(() => {
                    setSystemLog(prev => [...prev, {
                      timestamp: Date.now() / 1000,
                      message: newStatus,
                      level: newStatus.toLowerCase().includes('error') ? 'error' : 
                             newStatus.toLowerCase().includes('wait') ? 'warning' : 'info'
                    }]);
                  }, 0);
                }
              }
              return data.call;
            });
            setWords(data.words || []);
            setPnl(data.pnl);
            setTranscript(data.transcript || []);
            // Track if voice trader is waiting for manual dial
            if (data.auto_dial !== undefined) {
              setAutoDial(data.auto_dial);
            }
            // Reset dialing state when call progresses past connecting
            if (data.call?.call_state && data.call.call_state !== 'connecting') {
              setDialing(false);
            }
          } else if (data.type === 'transcript') {
            // Real-time transcript segment from voice trader
            const speakerId = data.speaker_id || 'unknown';
            const timestamp = data.timestamp || Date.now() / 1000;
            
            // Check if speaker changed
            setLastSpeakerId(prevSpeaker => {
              const speakerChanged = prevSpeaker !== null && prevSpeaker !== speakerId;
              
              setTranscript(prev => {
                const newSegment: TranscriptSegment = {
                  text: data.text,
                  is_final: data.is_final,
                  speaker_id: speakerId,
                  timestamp: timestamp,
                  show_speaker: speakerChanged || prev.length === 0,  // Show speaker on change or first segment
                  show_timestamp: speakerChanged || prev.length === 0  // Show timestamp on speaker change
                };
                
                // Replace partials with finals, keep evolving sentence
                if (data.is_final) {
                  // Final: remove recent partials and add this final
                  const withoutRecentPartials = prev.filter((seg) => {
                    // Keep all finals
                    if (seg.is_final) return true;
                    // Keep partials older than 5 seconds
                    if (seg.timestamp && timestamp - seg.timestamp > 5) return true;
                    return false;
                  });
                  return [...withoutRecentPartials.slice(-200), newSegment];
                } else {
                  // Partial: replace the last partial (if any) with this one
                  const lastIdx = prev.length - 1;
                  if (lastIdx >= 0 && !prev[lastIdx].is_final) {
                    // Replace last partial
                    return [...prev.slice(0, lastIdx), newSegment];
                  }
                  return [...prev.slice(-200), newSegment];
                }
              });
              
              return speakerId;  // Update lastSpeakerId
            });
          } else if (data.type === 'word_triggered') {
            // Update the words state based on status
            // pending = yellow (trade in progress)
            // success = green (got fills + profit)
            // no_fill/failed = gray (no trade executed)
            console.log('[WORD] Status:', data.word, data.market_ticker, data.status || 'triggered');
            setWords(prev => prev.map(w => 
              w.market_ticker === data.market_ticker 
                ? { 
                    ...w, 
                    triggered: true,  // Always mark triggered once detected
                    triggered_at: data.timestamp,
                    status: data.status || 'pending',
                    // Merge trade_result — pending has buy info, success adds sell info
                    trade_result: {
                      ...w.trade_result,
                      ...(data.contracts_filled !== undefined ? { contracts_filled: data.contracts_filled } : {}),
                      ...(data.avg_fill_price !== undefined ? { avg_buy_price: data.avg_fill_price } : {}),
                      ...(data.cost !== undefined ? { cost: data.cost } : {}),
                      ...(data.sell_fill_price !== undefined ? { sell_fill_price: data.sell_fill_price } : {}),
                      ...(data.sell_contracts !== undefined ? { sell_contracts: data.sell_contracts } : {}),
                      ...(data.realized_profit !== undefined ? { realized_profit: data.realized_profit } : {}),
                    }
                  }
                : w
            ));
            
            // Log trigger phrase to system log (if context available)
            if (data.context_before || data.context_after) {
              const before = data.context_before || '';
              const after = data.context_after || '';
              const word = data.word || '';
              
              // Format: "...context [WORD] context..."
              const triggerPhrase = `${before ? '...' + before : ''}[${word.toUpperCase()}]${after ? after + '...' : ''}`;
              
              setSystemLog(prev => [...prev, {
                timestamp: data.timestamp || Date.now() / 1000,
                message: `Word detected: ${word}`,
                level: 'trade',
                details: triggerPhrase
              }]);
            }
          } else if (data.type === 'word_status_update') {
            // Orderbook scanner detected word was already said (no NO bids)
            console.log('[WORD] Orderbook update:', data.market_ticker, data.source, data.reason);
            setWords(prev => prev.map(w => 
              w.market_ticker === data.market_ticker 
                ? { 
                    ...w, 
                    triggered: data.triggered,
                    status: 'skipped'  // Gray out - word was already said
                  }
                : w
            ));
            // Log to system log - word was already said
            setSystemLog(prev => [...prev, {
              timestamp: Date.now() / 1000,
              message: `Word already said: ${data.market_ticker} (${data.reason})`,
              level: 'warning'
            }]);
          } else if (data.type === 'event') {
            // Add event to system log (state changes, Q&A, etc.)
            setSystemLog(prev => [...prev, {
              timestamp: data.timestamp || Date.now() / 1000,
              message: data.message,
              level: 'info',
              details: data.event_type
            }]);
          } else if (data.type === 'speaker_change') {
            // Log speaker change to system log
            setSystemLog(prev => [...prev, {
              timestamp: data.timestamp || Date.now() / 1000,
              message: `Speaker changed: ${data.speaker_name || data.speaker_id}`,
              level: 'info'
            }]);
            // Update lastSpeakerId to trigger speaker label in transcript
            setLastSpeakerId(data.speaker_id);
            // Update speakers.current so the "▶ speaking" indicator moves in real time
            setContainerState(prev => prev ? {
              ...prev,
              speakers: { ...prev.speakers, current: data.speaker_id }
            } : prev);
          } else if (data.type === 'disconnect_alert') {
            setError(data.message);
            setAudioActive(false);  // Call disconnected - not active anymore
            setSystemLog(prev => [...prev, {
              timestamp: Date.now() / 1000,
              message: `Disconnected: ${data.message}`,
              level: 'warning'
            }]);
          } else if (data.type === 'audio_active') {
            setAudioActive(data.active);
          } else if (data.type === 'trading_params') {
            // Sync cash balance + bet size from server
            setCashBalance(data.cash_balance || 0);
            setAvailableCash(data.available_cash || 0);
            setMinTrade(data.min_trade || 10);
            // Sync bet size from server ONLY if user isn't actively editing (not dirty)
            if (data.bet_size != null) {
              setBetSize(data.bet_size);
              setBetSizeDirty(prev => {
                if (!prev) {
                  setBetSizeInput(String(data.bet_size));
                }
                return prev;
              });
            }
          } else if (data.type === 'speakers') {
            // Update speakers from server
            setContainerState(prev => prev ? {...prev, speakers: data.speakers} : prev);
          } else if (data.type === 'ai_event') {
            // AI detected significant event (Q&A start, call ending)
            let emoji = '🤖';
            let eventText = data.event;
            let level: 'ai' | 'warning' = 'ai';
            
            if (data.event === 'qa_started') {
              emoji = '❓';
              eventText = 'Q&A Session Detected';
              level = 'warning';
              // Update qa_started in container state
              setContainerState(prev => prev ? {...prev, qa_started: true} : prev);
            } else if (data.event === 'call_ending') {
              emoji = '🔔';
              eventText = 'Call Ending - Sweeping NO';
              level = 'warning';
            }
            
            // Add to system log
            setSystemLog(prev => [...prev, {
              timestamp: Date.now() / 1000,
              message: `${emoji} AI: ${eventText}`,
              level: level,
              details: data.reason || 'detected'
            }]);
          } else if (data.type === 'trade_executed') {
            // Trade executed (YES buy or NO sweep)
            const emoji = data.side === 'no' ? '🔴' : '🎯';
            const action = data.action === 'buy' ? 'Bought' : 'Sold';
            const sideLabel = data.side?.toUpperCase() || 'YES';
            const reason = data.reason === 'sweep_no' ? ' (sweep)' : '';
            
            // Add to system log as trade
            setSystemLog(prev => [...prev, {
              timestamp: Date.now() / 1000,
              message: `${emoji} ${action} ${sideLabel} on ${data.market_ticker}: ${data.contracts_filled || 0} @ $${(data.price || 0).toFixed(2)}${reason}`,
              level: 'trade'
            }]);
          }
        };
        
        ws.onerror = (err) => {
          console.error('WebSocket error:', err);
        };
        
        ws.onclose = (event) => {
          console.log(`WebSocket closed (code: ${event.code}). Total chunks received: ${audioChunkCountRef.current}`);
          setWsConnected(false);
          setAudioActive(false);
          // Reset jitter buffer and chunk counter for next connection
          nextPlayTimeRef.current = 0;
          audioChunkCountRef.current = 0;
          
          // Only show error if connection dropped unexpectedly (not user-initiated close)
          // Code 1000 = normal closure, 1001 = going away (navigation)
          if (event.code !== 1000 && event.code !== 1001 && !isConnecting) {
            setError(`Connection lost (code: ${event.code})`);
          }
          
          // Retry if we haven't connected yet and haven't exceeded retries
          if (isConnecting && retryCount < maxRetries) {
            retryCount++;
            console.log(`Retrying WebSocket in 2 seconds... (${retryCount}/${maxRetries})`);
            retryTimeout = setTimeout(connectWebSocket, 2000);
          }
        };
      } catch (err) {
        console.error('Failed to create WebSocket:', err);
        setWsConnected(false);
        
        // Retry on exception too
        if (isConnecting && retryCount < maxRetries) {
          retryCount++;
          retryTimeout = setTimeout(connectWebSocket, 2000);
        }
      }
    };
    
    connectWebSocket();
    
    return () => {
      isConnecting = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      if (ws) ws.close();
      // Cleanup audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      // Reset jitter buffer
      nextPlayTimeRef.current = 0;
      // Cleanup microphone
      stopMicrophone();
    };
  }, [pageState, wsUrl]);

  // Polling fallback for state updates (when WebSocket blocked by browser)
  useEffect(() => {
    if (pageState !== 'monitoring' || !sessionId) return;
    
    // Always poll for state since WebSocket is often blocked (mixed content)
    const pollState = async () => {
      try {
        // Poll EC2 directly for session status
        const response = await fetch(`${EC2_BASE}/status`);
        
        if (!response.ok) return;
        
        const data = await response.json();
        
        // Handle idle state - no active session on server
        if (data.status === 'idle') {
          // Check if there was a recent error (session failed to start)
          if (data.last_error) {
            setError(`Session failed: ${data.last_error}`);
          } else {
            setError('Session ended. Return to events to start a new call.');
          }
          setAudioActive(false);
          return;
        }
        
        // Update state from status endpoint (includes full state_summary)
        if (data.call_state || data.status_message) {
          setContainerState(prev => ({
            ...prev,
            call_state: data.call_state || prev?.call_state || 'connecting',
            status_message: data.status_message || prev?.status_message || 'Loading...',
            audio_source: data.audio_source || prev?.audio_source || 'phone',
            qa_started: data.qa_started || false,
            qa_detection_enabled: data.qa_detection_enabled ?? prev?.qa_detection_enabled ?? false,
            call_end_detection_enabled: data.call_end_detection_enabled ?? prev?.call_end_detection_enabled ?? false,
            detection_paused: data.detection_paused || false,
            dry_run: data.dry_run ?? prev?.dry_run ?? false,
            // Use speakers from response, fallback to prev if not present
            speakers: data.speakers || prev?.speakers || { valid_count: 0, invalid_count: 0, current: '', filter_enabled: false, details: [] },
            transcript_segments: data.transcript_segments || prev?.transcript_segments || 0
          }));
          
          // Reset dialing state when call progresses past connecting
          if (data.call_state && data.call_state !== 'connecting') {
            setDialing(false);
          }
          
          // Update audio active from polling
          if (data.audio_active !== undefined) {
            setAudioActive(data.audio_active);
          }
          
          // Update transcript preview if available
          if (data.transcript_preview) {
            setTranscript(prev => {
              // Add as a new segment if different from last
              const lastText = prev[prev.length - 1]?.text;
              if (lastText !== data.transcript_preview) {
                return [...prev.slice(-29), {
                  text: data.transcript_preview,
                  timestamp: Date.now() / 1000,
                  is_final: true
                }];
              }
              return prev;
            });
          }
        }
        
        // Check if container stopped or call disconnected
        if (data.ecs_status === 'STOPPED' || data.status === 'stopped') {
          setError('Container stopped');
          setAudioActive(false);
        }
        
        // Don't set error for disconnected - the status display handles it cleanly
        if (data.call_state === 'disconnected') {
          setAudioActive(false);
          setDialing(false);  // Reset dialing state
        }
        
      } catch (err) {
        console.error('Error polling status:', err);
      }
    };
        
    // Poll immediately and every 2 seconds
    pollState();
    const interval = setInterval(pollState, 2000);
    
    return () => clearInterval(interval);
  }, [pageState, sessionId, authToken]);

  // Stop microphone capture
  const stopMicrophone = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioWorkletRef.current) {
      audioWorkletRef.current.port.close();
      audioWorkletRef.current.disconnect();
      audioWorkletRef.current = null;
    }
    if (micContextRef.current) {
      micContextRef.current.close();
      micContextRef.current = null;
    }
    setMicActive(false);
  }, []);

  // Start microphone capture using AudioWorklet (lowest latency)
  // Falls back to ScriptProcessorNode if AudioWorklet unavailable
  // OPTIMIZED FOR LOW LATENCY - critical for real-time conference call interaction
  const startMicrophone = useCallback(async () => {
    console.log('[MIC] startMicrophone called');
    console.log('[MIC] wsRef.current:', wsRef.current);
    console.log('[MIC] readyState:', wsRef.current?.readyState, '(OPEN=1)');
    
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[MIC] WebSocket not connected - aborting mic start');
      return;
    }

    try {
      console.log('[MIC] Requesting microphone access...');
      // Request microphone access with low-latency constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 8000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // Request low latency from browser
          latency: 0,
        } as MediaTrackConstraints
      });
      mediaStreamRef.current = stream;

      // Create audio context with low-latency hint
      const audioContext = new AudioContext({ 
        sampleRate: 8000,
        latencyHint: 'interactive'  // Request lowest latency
      });
      micContextRef.current = audioContext;

      // Create source from microphone
      const source = audioContext.createMediaStreamSource(stream);

      // Try to use AudioWorklet (modern, lowest latency ~16ms)
      // Falls back to ScriptProcessorNode (~32ms) if unavailable
      // Use inline blob URL for reliability (avoids file loading/caching issues)
      if (audioContext.audioWorklet) {
        try {
          // Inline worklet code as blob - more reliable than external file
          const workletCode = `
            class MicrophoneProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.buffer = [];
                this.targetSamples = 256; // ~32ms at 8kHz
              }
              
              process(inputs, outputs, parameters) {
                const input = inputs[0];
                if (!input || !input[0]) return true;
                
                const samples = input[0];
                for (let i = 0; i < samples.length; i++) {
                  this.buffer.push(this.linearToMulaw(samples[i]));
                }
                
                if (this.buffer.length >= this.targetSamples) {
                  const data = new Uint8Array(this.buffer);
                  this.buffer = [];
                  this.port.postMessage(data.buffer, [data.buffer]);
                }
                return true;
              }
              
              linearToMulaw(sample) {
                const BIAS = 33;
                const sign = sample < 0 ? 0x80 : 0;
                if (sample < 0) sample = -sample;
                sample = Math.min(sample * 32768, 32767) + BIAS;
                let exp = 7;
                for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; mask >>= 1) exp--;
                const mantissa = (sample >> (exp + 3)) & 0x0F;
                return (~(sign | (exp << 4) | mantissa)) & 0xFF;
              }
            }
            registerProcessor('microphone-processor', MicrophoneProcessor);
          `;
          
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const workletUrl = URL.createObjectURL(blob);
          await audioContext.audioWorklet.addModule(workletUrl);
          URL.revokeObjectURL(workletUrl);
          
          const workletNode = new AudioWorkletNode(audioContext, 'microphone-processor');
          audioWorkletRef.current = workletNode;
          
          // Track sent packets for debugging
          let micPacketsSent = 0;
          
          // Receive mu-law audio from worklet and send to WebSocket
          workletNode.port.onmessage = (event) => {
            micPacketsSent++;
            if (micPacketsSent <= 5 || micPacketsSent % 50 === 0) {
              console.log(`[MIC] Sending packet #${micPacketsSent}, size=${event.data.byteLength}`);
            }
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
              if (micPacketsSent <= 5) {
                console.error('[MIC] WebSocket not open, cannot send audio');
              }
              return;
            }
            wsRef.current.send(event.data);
          };
          
          source.connect(workletNode);
          // Don't connect to destination - we don't want to hear ourselves
          
          setMicActive(true);
          console.log('Microphone capture started (AudioWorklet mode: ~16ms latency)');
          return;
        } catch (workletErr) {
          console.warn('AudioWorklet failed, falling back to ScriptProcessor:', workletErr);
        }
      }

      // Fallback: ScriptProcessorNode (deprecated but widely supported)
      // CRITICAL: Use smallest possible buffer size for lowest latency
      // bufferSize = 256 samples @ 8kHz = 32ms
      const bufferSize = 256;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32 PCM to mu-law (optimized tight loop)
        const mulawData = new Uint8Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          mulawData[i] = linearToMulaw(inputData[i]);
        }

        // Send as binary data to WebSocket immediately
        wsRef.current.send(mulawData.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setMicActive(true);
      console.log('Microphone capture started (ScriptProcessor fallback: ~32ms latency)');
    } catch (err) {
      console.error('Failed to start microphone:', err);
      setError('Microphone access denied. Please allow microphone access to speak to the call.');
    }
  }, []);

  // Toggle microphone
  const toggleMicrophone = useCallback(async () => {
    console.log('[MIC] Toggle clicked, micActive:', micActive, 'wsConnected:', wsConnected);
    if (micActive) {
      console.log('[MIC] Stopping microphone...');
      stopMicrophone();
    } else {
      console.log('[MIC] Starting microphone...');
      await startMicrophone();
    }
  }, [micActive, wsConnected, startMicrophone, stopMicrophone]);

  // Linear PCM to mu-law conversion
  const linearToMulaw = (sample: number): number => {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    const sign = sample < 0 ? 0x80 : 0;
    
    if (sample < 0) sample = -sample;
    
    // Clamp and scale to 16-bit range
    sample = Math.min(sample * 32768, 32767);
    
    // Add bias
    sample += MULAW_BIAS;
    
    // Find segment
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    
    // Calculate mantissa
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    
    // Combine and complement
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
  };

  // Initialize audio context for playback
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 8000 // Match Kinesis/Transcribe sample rate
      });
      audioContextRef.current = ctx;
      
      // Create gain node for volume control
      const gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      gainNode.gain.value = audioMuted ? 0 : audioVolume;
      gainNodeRef.current = gainNode;
    }
    return audioContextRef.current;
  }, [audioMuted, audioVolume]);

  // Play incoming audio chunk with jitter buffer for smooth playback
  const playAudioChunk = useCallback((arrayBuffer: ArrayBuffer) => {
    // Count ALL chunks received (even if muted)
    audioChunkCountRef.current++;
    const chunkNum = audioChunkCountRef.current;
    
    // Log every 50 chunks (roughly every second at 50 chunks/sec)
    if (chunkNum === 1 || chunkNum % 50 === 0) {
      console.log(`[AUDIO] Received chunk #${chunkNum}, size=${arrayBuffer.byteLength} bytes`);
    }
    
    if (audioMuted) return;
    
    try {
      const ctx = initAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      
      // Decode PCM audio (16-bit signed, 8kHz)
      const int16Array = new Int16Array(arrayBuffer);
      const floatArray = new Float32Array(int16Array.length);
      
      // Convert 16-bit to float
      for (let i = 0; i < int16Array.length; i++) {
        floatArray[i] = int16Array[i] / 32768.0;
      }
      
      const audioBuffer = ctx.createBuffer(1, floatArray.length, 8000);
      audioBuffer.copyToChannel(floatArray, 0);
      
      // Calculate chunk duration in seconds
      const chunkDuration = floatArray.length / 8000;
      
      // Jitter buffer: Schedule playback at precise times for gapless audio
      const now = ctx.currentTime;
      
      // If this is the first chunk or we've fallen behind, reset the schedule
      // Add jitter buffer delay on first chunk for smoother playback
      if (nextPlayTimeRef.current <= now) {
        nextPlayTimeRef.current = now + (JITTER_BUFFER_MS / 1000);
      }
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNodeRef.current || ctx.destination);
      
      // Schedule this chunk at the next available slot
      source.start(nextPlayTimeRef.current);
      
      // Advance the play time for the next chunk
      nextPlayTimeRef.current += chunkDuration;
      
    } catch (err) {
      console.error('Audio playback error:', err);
    }
  }, [audioMuted, initAudioContext]);

  // Update volume when slider changes
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = audioMuted ? 0 : audioVolume;
    }
  }, [audioVolume, audioMuted]);

  // EC2 Control handlers
  const handleEC2Start = async () => {
    if (!authToken) return;
    setEc2Loading(true);
    setEc2Error(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) {
        setEc2Error(data.error || 'Failed to start EC2 instance');
      } else {
        // Immediately update status to show pending
        setEc2Status(prev => prev ? { ...prev, status: 'pending' } : null);
      }
    } catch (err) {
      setEc2Error('Failed to start EC2 instance');
    } finally {
      setEc2Loading(false);
    }
  };

  const handleEC2Stop = async () => {
    if (!authToken) return;
    if (!confirm('Are you sure you want to stop the voice server? This will disconnect any active sessions.')) {
      return;
    }
    setEc2Loading(true);
    setEc2Error(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) {
        setEc2Error(data.error || 'Failed to stop EC2 instance');
      } else {
        // Immediately update status to show stopping
        setEc2Status(prev => prev ? { ...prev, status: 'stopping' } : null);
      }
    } catch (err) {
      setEc2Error('Failed to stop EC2 instance');
    } finally {
      setEc2Loading(false);
    }
  };

  const handleEC2Reboot = async () => {
    if (!authToken) return;
    if (!confirm('Are you sure you want to reboot the voice server? Active sessions will be disconnected.')) {
      return;
    }
    setEc2Loading(true);
    setEc2Error(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/reboot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) {
        setEc2Error(data.error || 'Failed to reboot EC2 instance');
      } else {
        // Immediately update status to show pending
        setEc2Status(prev => prev ? { ...prev, status: 'pending' } : null);
      }
    } catch (err) {
      setEc2Error('Failed to reboot EC2 instance');
    } finally {
      setEc2Loading(false);
    }
  };

  // Queue management handlers
  const handleAddToQueue = async () => {
    if (!authToken || !newQueueEvent.event_ticker || !newQueueEvent.scheduled_time) {
      setQueueError('Event ticker and scheduled time are required');
      return;
    }
    setQueueLoading(true);
    setQueueError(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/queue/add`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event_ticker: newQueueEvent.event_ticker,
          scheduled_time: newQueueEvent.scheduled_time,
          phone_number: newQueueEvent.phone_number || undefined
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setQueueError(data.error || 'Failed to add event to queue');
      } else {
        // Refresh queue list
        const queueRes = await fetch(`${EC2_BASE}/queue`);
        if (queueRes.ok) {
          const queueData = await queueRes.json();
          setQueuedEvents(queueData.events || []);
        }
        // Clear form
        setNewQueueEvent({ event_ticker: '', scheduled_time: '', phone_number: '' });
        setShowQueueForm(false);
      }
    } catch (err) {
      setQueueError('Failed to add event to queue');
    } finally {
      setQueueLoading(false);
    }
  };

  const handleRemoveFromQueue = async (eventTicker: string) => {
    if (!authToken) return;
    if (!confirm(`Remove ${eventTicker} from the queue?`)) return;
    
    setQueueLoading(true);
    setQueueError(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/queue/remove`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ event_ticker: eventTicker })
      });
      const data = await response.json();
      if (!response.ok) {
        setQueueError(data.error || 'Failed to remove event from queue');
      } else {
        // Refresh queue list
        const queueRes = await fetch(`${EC2_BASE}/queue`);
        if (queueRes.ok) {
          const queueData = await queueRes.json();
          setQueuedEvents(queueData.events || []);
        }
      }
    } catch (err) {
      setQueueError('Failed to remove event from queue');
    } finally {
      setQueueLoading(false);
    }
  };

  const handleSelectEvent = (event: MentionEvent) => {
    setSelectedEvent(event);
    setPageState('setup');
  };

  const handleLaunch = async () => {
    if (!selectedEvent || !authToken) return;
    
    // Validation
    if (audioSource === 'phone' && !phoneNumber) {
      setError('Phone number is required');
      return;
    }
    if (audioSource === 'web' && !webUrl) {
      setError('Web URL is required');
      return;
    }
    if (audioSource === 'satellite' && selectedSatStreamId === null) {
      setError('Please select a satellite channel');
      return;
    }

    // For Prime Video: start capture pipeline first
    // Open the VNC window synchronously NOW (while in user-gesture context) so browsers
    // don't block it as a popup from an async callback.
    let vncWindow: Window | null = null;
    if (audioSource === 'desktop') {
      vncWindow = window.open('about:blank', 'prime-vnc',
        'width=1280,height=800,toolbar=no,menubar=no,scrollbars=no,resizable=yes');
      try {
        const primeRes = await fetch(`${EC2_BASE}/prime/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: primeUrl || undefined, desktop_port: 4400 }),
        });
        if (!primeRes.ok) {
          const err = await primeRes.json().catch(() => ({})) as Record<string, unknown>;
          if (vncWindow && !vncWindow.closed) vncWindow.close();
          setError(`Prime pipeline failed: ${err.errors || primeRes.status}`);
          return;
        }
        // Pipeline started — navigate the pre-opened VNC window to the viewer
        if (vncWindow && !vncWindow.closed) {
          vncWindow.location.href = `${EC2_BASE}/prime/novnc`;
        }
      } catch (e) {
        if (vncWindow && !vncWindow.closed) vncWindow.close();
        setError(`Could not start Prime capture: ${(e as Error).message}`);
        return;
      }
    }
    
    // Check if EC2 server is responding
    if (ec2Status?.status !== 'running') {
      setError('Voice server is not running. Please start it first.');
      return;
    }
    
    setLaunching(true);
    setLaunchStatus('Dialing...');
    setError(null);
    
    // Clear state from any previous session
    setWords([]);
    setTranscript([]);
    setSystemLog([]);
    setContainerState(null);
    setLastSpeakerId(null);
    wsConnectedOnceRef.current = false;  // Allow "Connected" message for new session
    lastLoggedStatusRef.current = null;  // Allow status messages for new session
    
    // Close any existing WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    try {
      // Call EC2 directly - no Lambda needed!
      const body: any = {
        session_id: selectedEvent.event_ticker,  // Required by EC2 API
        event_ticker: selectedEvent.event_ticker,
        user_name: 'jimc',  // TODO: Get from auth
        audio_source: audioSource === 'satellite' ? 'satellite_transcript' : audioSource,
      };
      
      // Add audio source specific fields
      if (audioSource === 'phone') {
        body.phone_number = phoneNumber;
        if (passcode) {
          body.passcode = passcode;
        }
      } else if (audioSource === 'web') {
        body.stream_url = webUrl;
      } else if (audioSource === 'satellite') {
        body.satellite_stream_id = selectedSatStreamId;
      } else if (audioSource === 'desktop') {
        body.desktop_port = 4400;
      }
      
      // Always enable diarization so speaker panel works
      body.stt_diarization = true;

      // Add dry_run flag
      if (dryRun) {
        body.dry_run = true;
      }
      
      const response = await fetch(`${EC2_BASE}/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to launch');
      }
      
      // Save session ID for status polling
      setSessionId(data.session_id);
      
      // EC2 launch returns websocket_url immediately
      if (data.websocket_url) {
        setWsUrl(data.websocket_url);
        
        // EC2 uses voice.apexmarkets.us with Let's Encrypt - valid cert, go straight to monitoring
        setLaunching(false);
        setLaunchStatus('');
        setPageState('monitoring');
        return;
      }
      
      throw new Error('No WebSocket URL returned from server');
      
    } catch (err: any) {
      setError(err.message);
      setLaunchStatus('');
      setLaunching(false);
    }
  };

  const handleReconnect = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'redial' }));
      setError(null);
    }
  };

  // Reconnect to an existing running container
  const handleReconnectToContainer = async (container: RunningVoiceContainer) => {
    if (!authToken) return;
    
    setError(null);
    setSessionId(container.session_id);
    
    // Find the event for this container
    const matchingEvent = events.find(e => e.event_ticker === container.event_ticker);
    if (matchingEvent) {
      setSelectedEvent(matchingEvent);
    } else {
      // Create a minimal event object for display
      setSelectedEvent({
        event_ticker: container.event_ticker,
        title: container.title || container.event_ticker,
        start_date: container.started_at,
        hours_until_start: 0,
        words: [],
        word_count: 0,
        container_status: container.status
      });
    }
    
    if (container.websocket_url) {
      setWsUrl(container.websocket_url);
      
      // Go directly to monitoring - EC2 uses Let's Encrypt, cert is valid
      setPageState('monitoring');
    } else {
      setError('Container does not have a WebSocket URL yet');
    }
  };

  const sendDtmf = (digits: string) => {
    console.log('[DTMF] sendDtmf called with:', digits);
    console.log('[DTMF] wsRef.current:', wsRef.current ? 'exists' : 'null');
    console.log('[DTMF] readyState:', wsRef.current?.readyState, '(OPEN=1)');
    
    if (!digits) {
      console.error('[DTMF] No digits provided');
      return;
    }
    
    if (!wsRef.current) {
      console.error('[DTMF] WebSocket not initialized');
      return;
    }
    
    if (wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[DTMF] WebSocket not open, state:', wsRef.current.readyState);
      return;
    }
    
    const msg = JSON.stringify({ type: 'send_dtmf', digits });
    console.log('[DTMF] Sending:', msg);
    wsRef.current.send(msg);
    setDialpadInput('');
  };

  // Send bet size to server
  const sendBetSize = (dollars: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[BET] WebSocket not connected');
      return;
    }
    const msg = JSON.stringify({ type: 'set_bet_size', dollars });
    console.log('[BET] Sending:', msg);
    wsRef.current.send(msg);
    setBetSize(dollars);
    setBetSizeDirty(false);
  };

  // Handle bet size input change — update text only, mark dirty, do NOT send yet
  const handleBetSizeInputChange = (value: string) => {
    setBetSizeInput(value);
    const dollars = parseFloat(value);
    // Mark dirty if the input differs from the confirmed bet size
    setBetSizeDirty(!isNaN(dollars) && dollars >= 0 && dollars !== betSize);
  };

  // Confirm & send the bet size (button click or Enter key)
  const confirmBetSize = () => {
    const dollars = parseFloat(betSizeInput);
    if (!isNaN(dollars) && dollars >= 0) {
      sendBetSize(dollars);
    }
  };

  // Periodic trading params refresh
  useEffect(() => {
    if (pageState !== 'monitoring' || !wsRef.current) return;
    
    const interval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'get_trading_params' }));
      }
    }, 2000);  // Refresh every 2 seconds
    
    return () => clearInterval(interval);
  }, [pageState]);

  const handleStop = async () => {
    if (!sessionId) {
      setError('No active session to stop');
      return;
    }
    
    try {
      console.log('Stopping session:', sessionId);
      
      // Close WebSocket first
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      
      const response = await fetch(`${EC2_BASE}/stop/${encodeURIComponent(sessionId)}`, {
        method: 'POST'
      });
      console.log('Stop response:', response.status);
      
      // Clear all state and go back to lobby
      setPageState('events');
      setSelectedEvent(null);
      setSessionId(null);
      setContainerState(null);
      setWsConnected(false);
      setWsUrl(null);
      setWords([]);
      setTranscript([]);
      setSystemLog([]);
      setLastSpeakerId(null);
      setError(null);
      setDialing(false);
      setAudioActive(false);
    } catch (err) {
      console.error('Stop error:', err);
      setError('Failed to end call: ' + (err as Error).message);
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleTimeString();
  };

  const getCallStateColor = (state: string) => {
    switch (state) {
      case 'waiting': return 'text-yellow-500';
      case 'connecting': return 'text-blue-500';
      case 'in_progress': return 'text-green-500';
      case 'qa_session': return 'text-orange-500';
      case 'disconnected': return 'text-red-500';
      case 'sweeping_no': return 'text-purple-500';
      case 'completed': return 'text-gray-500';
      default: return 'text-gray-400';
    }
  };

  // Render based on page state
  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (pageState === 'events') {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <h1 className="text-3xl font-bold mb-6">Voice Mention Trader</h1>
        <p className="text-gray-400 mb-6">
          Select an upcoming mention event to trade. The system will dial into the earnings call,
          transcribe in real-time, and automatically trade when target words are spoken.
        </p>
        
        {error && (
          <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* EC2 Voice Server Control Panel */}
        <div className="mb-8 bg-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
            <span>🖥️</span>
            <span>Voice Server</span>
            {ec2Status && (
              <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
                ec2Status.status === 'running' ? 'bg-green-700 text-green-200' :
                ec2Status.status === 'stopped' ? 'bg-red-700 text-red-200' :
                ec2Status.status === 'pending' || ec2Status.status === 'stopping' ? 'bg-yellow-700 text-yellow-200' :
                'bg-gray-700 text-gray-300'
              }`}>
                {ec2Status.status.toUpperCase()}
              </span>
            )}
          </h2>
          
          {ec2Error && (
            <div className="bg-red-900/50 border border-red-700 text-red-200 px-3 py-2 rounded mb-3 text-sm">
              {ec2Error}
            </div>
          )}
          
          {ec2Status ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-4 text-sm">
                <div>
                  <span className="text-gray-400">Status:</span>{' '}
                  <span className={
                    ec2Status.status === 'running' ? 'text-green-400' :
                    ec2Status.status === 'stopped' ? 'text-red-400' :
                    'text-yellow-400'
                  }>
                    {ec2Status.status === 'running' && '●'} {ec2Status.status}
                  </span>
                </div>
                {ec2Status.public_ip && (
                  <div>
                    <span className="text-gray-400">IP:</span>{' '}
                    <span className="font-mono text-blue-400">{ec2Status.public_ip}</span>
                  </div>
                )}
                {ec2Status.public_dns && (
                  <div>
                    <span className="text-gray-400">DNS:</span>{' '}
                    <span className="font-mono text-blue-400 text-xs">{ec2Status.public_dns}</span>
                  </div>
                )}
                {ec2Status.uptime_hours !== null && ec2Status.uptime_hours !== undefined && (
                  <div>
                    <span className="text-gray-400">Uptime:</span>{' '}
                    <span className="text-white">
                      {ec2Status.uptime_hours < 1 
                        ? `${Math.round(ec2Status.uptime_hours * 60)} min`
                        : `${ec2Status.uptime_hours.toFixed(1)} hrs`}
                    </span>
                  </div>
                )}
              </div>

              {/* Riva STT Status */}
              {ec2Status.status === 'running' && rivaStatus && (
                <div className="flex flex-wrap gap-4 text-sm border-t border-gray-700 pt-3 mt-3">
                  <div>
                    <span className="text-gray-400">Riva STT:</span>{' '}
                    <span className={rivaStatus.status === 'healthy' ? 'text-green-400' : 'text-red-400'}>
                      {rivaStatus.status === 'healthy' ? '● ' : '○ '}
                      {rivaStatus.status}
                    </span>
                  </div>
                  {rivaStatus.health_check_ms !== undefined && (
                    <div>
                      <span className="text-gray-400">Latency:</span>{' '}
                      <span className="text-cyan-400">{rivaStatus.health_check_ms.toFixed(1)}ms</span>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-400">Endpoint:</span>{' '}
                    <span className="font-mono text-gray-300 text-xs">{rivaStatus.endpoint}</span>
                  </div>
                  {rivaStatus.error && (
                    <div className="text-red-400 text-xs">
                      Error: {rivaStatus.error}
                    </div>
                  )}
                </div>
              )}
              
              <div className="flex gap-2">
                {ec2Status.status === 'stopped' && (
                  <button
                    onClick={handleEC2Start}
                    disabled={ec2Loading}
                    className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded text-sm font-medium transition"
                  >
                    {ec2Loading ? 'Starting...' : '▶️ Start Server'}
                  </button>
                )}
                {ec2Status.status === 'running' && (
                  <>
                    <button
                      onClick={handleEC2Stop}
                      disabled={ec2Loading}
                      className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 rounded text-sm font-medium transition"
                    >
                      {ec2Loading ? 'Stopping...' : '⏹️ Stop Server'}
                    </button>
                    <button
                      onClick={handleEC2Reboot}
                      disabled={ec2Loading}
                      className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 rounded text-sm font-medium transition"
                    >
                      {ec2Loading ? 'Rebooting...' : '🔄 Reboot'}
                    </button>
                  </>
                )}
                {(ec2Status.status === 'pending' || ec2Status.status === 'stopping') && (
                  <span className="px-4 py-2 bg-gray-700 rounded text-sm text-gray-300 flex items-center gap-2">
                    <span className="animate-spin">⏳</span>
                    {ec2Status.status === 'pending' ? 'Starting...' : 'Stopping...'}
                  </span>
                )}
              </div>
              
              {ec2Status.status !== 'running' && (
                <p className="text-yellow-400 text-sm">
                  ⚠️ Voice server must be running to start trading sessions
                </p>
              )}
            </div>
          ) : (
            <div className="text-gray-400">Loading EC2 status...</div>
          )}
        </div>
        
        {/* Running Containers Section */}
        {runningContainers.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold mb-4 text-green-400">🔴 Running Sessions</h2>
            <p className="text-gray-400 text-sm mb-4">
              These voice trader containers are currently running. Click to reconnect and monitor.
            </p>
            <div className="grid gap-3">
              {runningContainers.map(container => (
                <div
                  key={container.session_id}
                  className="bg-green-900/30 border border-green-700 rounded-lg p-4 hover:bg-green-900/50 cursor-pointer transition"
                  onClick={() => handleReconnectToContainer(container)}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                        <h3 className="text-lg font-semibold text-green-300">{container.title || container.event_ticker}</h3>
                      </div>
                      <p className="text-gray-400 text-sm">{container.event_ticker}</p>
                      <p className="text-gray-500 text-xs mt-1">Session: {container.session_id}</p>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-green-400">
                        {container.call_state || container.status}
                      </div>
                      <div className="text-sm text-gray-400">
                        Started: {new Date(container.started_at).toLocaleTimeString()}
                      </div>
                      <div className="text-sm text-gray-500">
                        User: {container.user_name}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-sm text-green-400 font-medium">
                    → Click to reconnect and monitor
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scheduled Events Queue Section */}
        <div className="mb-8 bg-gray-800 rounded-lg p-4">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <span>⏰</span>
              <span>Scheduled Events</span>
              <span className="ml-2 px-2 py-0.5 rounded text-xs font-medium bg-blue-700 text-blue-200">
                {queuedEvents.length}
              </span>
            </h2>
            <button
              onClick={() => setShowQueueForm(!showQueueForm)}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium transition"
            >
              {showQueueForm ? '✕ Cancel' : '+ Schedule Event'}
            </button>
          </div>

          {queueError && (
            <div className="bg-red-900/50 border border-red-700 text-red-200 px-3 py-2 rounded mb-3 text-sm">
              {queueError}
            </div>
          )}

          {/* Add Event Form */}
          {showQueueForm && (
            <div className="bg-gray-700/50 rounded p-4 mb-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Event Ticker</label>
                  <select
                    value={newQueueEvent.event_ticker}
                    onChange={(e) => setNewQueueEvent(prev => ({ ...prev, event_ticker: e.target.value }))}
                    className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-2 text-white text-sm"
                  >
                    <option value="">Select event...</option>
                    {events.map(event => (
                      <option key={event.event_ticker} value={event.event_ticker}>
                        {event.title} ({event.event_ticker})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Scheduled Time (UTC)</label>
                  <input
                    type="datetime-local"
                    value={newQueueEvent.scheduled_time}
                    onChange={(e) => setNewQueueEvent(prev => ({ ...prev, scheduled_time: e.target.value }))}
                    className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-2 text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Phone Number (optional)</label>
                  <div className="flex gap-1 mb-1">
                    {[
                      { label: 'C-SPAN Radio', number: '+12026268888' },
                      { label: 'C-SPAN TV', number: '+16056154174' },
                    ].map(p => (
                      <button
                        key={p.number}
                        type="button"
                        onClick={() => setNewQueueEvent(prev => ({ ...prev, phone_number: p.number }))}
                        className={`px-2 py-0.5 rounded text-xs transition ${
                          newQueueEvent.phone_number === p.number
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="tel"
                    value={newQueueEvent.phone_number}
                    onChange={(e) => setNewQueueEvent(prev => ({ ...prev, phone_number: e.target.value }))}
                    placeholder="+15551234567"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-2 text-white text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAddToQueue}
                  disabled={queueLoading || !newQueueEvent.event_ticker || !newQueueEvent.scheduled_time}
                  className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded text-sm font-medium transition"
                >
                  {queueLoading ? 'Adding...' : '✓ Add to Queue'}
                </button>
                <p className="text-gray-400 text-xs self-center">
                  EC2 will auto-start 15 minutes before scheduled time
                </p>
              </div>
            </div>
          )}

          {/* Queued Events List */}
          {queuedEvents.length === 0 ? (
            <p className="text-gray-400 text-sm">
              No scheduled events. Add events to auto-start EC2 before trading sessions.
            </p>
          ) : (
            <div className="space-y-2">
              {/* Stale events warning */}
              {queuedEvents.some(e => e.is_stale) && (
                <div className="flex items-center justify-between bg-orange-900/30 border border-orange-700 rounded p-3 mb-3">
                  <span className="text-orange-300 text-sm">
                    ⚠️ {queuedEvents.filter(e => e.is_stale).length} stale event(s) found (scheduled time passed 3+ hours ago)
                  </span>
                  <button
                    onClick={async () => {
                      setQueueLoading(true);
                      try {
                        const response = await fetch(`${API_BASE}/voice-trader/ec2/queue/clean-stale`, {
                          method: 'POST',
                          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
                        });
                        if (response.ok) {
                          // Refresh queue list
                          const queueResponse = await fetch(`${API_BASE}/voice-trader/ec2/queue/list`, {
                            headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
                          });
                          if (queueResponse.ok) {
                            const data = await queueResponse.json();
                            setQueuedEvents(data.events || []);
                          }
                        }
                      } catch (err) {
                        console.error('Failed to clean stale events:', err);
                      } finally {
                        setQueueLoading(false);
                      }
                    }}
                    disabled={queueLoading}
                    className="px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 rounded text-xs font-medium transition"
                  >
                    🗑️ Clean Stale
                  </button>
                </div>
              )}
              
              {queuedEvents.map(event => (
                <div
                  key={event.event_ticker}
                  className={`flex justify-between items-center rounded p-3 ${
                    event.is_stale 
                      ? 'bg-red-900/30 border border-red-800' 
                      : 'bg-gray-700/50'
                  }`}
                >
                  <div>
                    <div className={`font-medium ${event.is_stale ? 'text-red-300' : 'text-blue-300'}`}>
                      {event.is_stale && '⚠️ '}{event.event_ticker}
                    </div>
                    <div className="text-sm text-gray-400">
                      {new Date(event.scheduled_time).toLocaleString()} UTC
                      {event.is_stale && event.hours_since_scheduled && (
                        <span className="text-red-400 ml-2">
                          ({event.hours_since_scheduled.toFixed(1)}h ago - STALE)
                        </span>
                      )}
                      {!event.is_stale && event.hours_until_start !== undefined && (
                        <span className={`ml-2 ${event.hours_until_start <= 0.5 ? 'text-green-400' : 'text-yellow-400'}`}>
                          ({event.hours_until_start <= 0 
                            ? 'NOW' 
                            : event.hours_until_start < 1 
                              ? `${Math.round(event.hours_until_start * 60)}m` 
                              : `${event.hours_until_start.toFixed(1)}h`})
                        </span>
                      )}
                    </div>
                    {event.phone_number && (
                      <div className="text-xs text-gray-500">📞 {event.phone_number}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      event.is_stale ? 'bg-red-700 text-red-200' :
                      event.status === 'pending' ? 'bg-yellow-700 text-yellow-200' :
                      event.status === 'started' ? 'bg-green-700 text-green-200' :
                      event.status === 'completed' ? 'bg-gray-600 text-gray-300' :
                      'bg-red-700 text-red-200'
                    }`}>
                      {event.is_stale ? 'stale' : event.status}
                    </span>
                    <button
                      onClick={() => handleRemoveFromQueue(event.event_ticker)}
                      disabled={queueLoading}
                      className="px-2 py-1 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 rounded text-xs font-medium transition"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
        {/* Upcoming Events Section */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">📅 Upcoming Events</h2>
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showStarted}
              onChange={(e) => setShowStarted(e.target.checked)}
              className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
            />
            Show started (last 24h)
          </label>
        </div>
        {events.filter(e => showStarted || (e.hours_until_start ?? 0) > 0).length === 0 ? (
          <div className="text-gray-400">No upcoming mention events found.</div>
        ) : (
          <div className="grid gap-4">
            {events.filter(e => showStarted || (e.hours_until_start ?? 0) > 0).map(event => (
              <div
                key={event.event_ticker}
                className="bg-gray-800 rounded-lg p-4 hover:bg-gray-700 cursor-pointer transition"
                onClick={() => handleSelectEvent(event)}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold">{event.title}</h3>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(`/dashboard/voice-trader?event=${encodeURIComponent(event.event_ticker)}`, '_blank', 'noopener');
                        }}
                        className="text-xs bg-blue-600 hover:bg-blue-500 px-2 py-0.5 rounded transition"
                        title="Open in new window"
                      >
                        ↗ New Window
                      </button>
                    </div>
                    <p className="text-gray-400 text-sm">{event.event_ticker}</p>
                  </div>
                  <div className="text-right">
                    <div className="text-sm text-gray-400">
                      Starts: {new Date(event.start_date).toLocaleString()}
                    </div>
                    <div className={`text-sm ${(event.hours_until_start ?? 0) <= 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                      {(event.hours_until_start ?? 0) <= 0 
                        ? `🔴 LIVE - started ${Math.abs(Math.round((event.hours_until_start ?? 0) * 60))} min ago`
                        : (event.hours_until_start ?? 0) < 1 
                          ? `${Math.round((event.hours_until_start ?? 0) * 60)} min until start`
                          : `${(event.hours_until_start ?? 0).toFixed(1)} hrs until start`}
                    </div>
                    <div className="text-sm text-blue-400">
                      {event.word_count} words to track
                    </div>
                    {event.container_status !== 'not_running' && (
                      <div className="text-sm text-green-400">
                        Container: {event.container_status}
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="mt-3 flex flex-wrap gap-2">
                  {(event.words || []).slice(0, 10).map(w => (
                    <span
                      key={w.market_ticker}
                      className="bg-gray-700 px-2 py-1 rounded text-xs"
                    >
                      {w.word}
                    </span>
                  ))}
                  {(event.words?.length ?? 0) > 10 && (
                    <span className="text-gray-500 text-xs">
                      +{(event.words?.length ?? 0) - 10} more
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (pageState === 'setup' && selectedEvent) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <button
          onClick={() => setPageState('events')}
          className="text-gray-400 hover:text-white mb-4"
        >
          ← Back to events
        </button>
        
        <h1 className="text-2xl font-bold mb-2">{selectedEvent.title}</h1>
        <a 
          href={`https://kalshi.com/events/${selectedEvent.event_ticker}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 hover:underline mb-6 inline-block"
        >
          {selectedEvent.event_ticker} ↗
        </a>
        
        {error && (
          <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">
            {error}
            <button onClick={() => setError(null)} className="ml-4 underline">Dismiss</button>
          </div>
        )}
        
        <div className="bg-gray-800 rounded-lg p-6 max-w-xl">
          <h2 className="text-xl font-semibold mb-4">Audio Source</h2>
          
          <div className="flex gap-3 mb-6 flex-wrap">
            <button
              className={`px-4 py-2 rounded ${audioSource === 'phone' ? 'bg-blue-600' : 'bg-gray-700'}`}
              onClick={() => setAudioSource('phone')}
            >
              📞 Phone Dial-In
            </button>
            <button
              className={`px-4 py-2 rounded ${audioSource === 'web' ? 'bg-blue-600' : 'bg-gray-700'}`}
              onClick={() => setAudioSource('web')}
            >
              🌐 Web Stream
            </button>
            <button
              className={`px-4 py-2 rounded ${audioSource === 'satellite' ? 'bg-blue-600' : 'bg-gray-700'}`}
              onClick={() => {
                setAudioSource('satellite');
                setSatError(null);
                setSatLoading(true);
                setSelectedSatStreamId(null);
                fetch(`${EC2_BASE}/satellite/streams`)
                  .then(r => r.json())
                  .then(d => { setSatStreams(d.streams || []); setSatLoading(false); })
                  .catch(() => { setSatError('Could not reach satellite server'); setSatLoading(false); });
              }}
            >
              📡 Satellite TV
            </button>
            <button
              className={`px-4 py-2 rounded ${audioSource === 'desktop' ? 'bg-purple-600' : 'bg-gray-700'}`}
              onClick={() => setAudioSource('desktop')}
            >
              🎬 Prime Video
            </button>

          </div>
          
          {audioSource === 'phone' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Phone Number</label>
                <div className="flex gap-2 mb-2">
                  {[
                    { label: 'C-SPAN Radio', number: '+12026268888' },
                    { label: 'C-SPAN TV', number: '+16056154174' },
                  ].map(p => (
                    <button
                      key={p.number}
                      type="button"
                      onClick={() => setPhoneNumber(p.number)}
                      className={`px-3 py-1 rounded text-xs font-medium transition ${
                        phoneNumber === p.number
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={phoneNumber}
                  onChange={e => setPhoneNumber(e.target.value)}
                  placeholder="+1-800-555-1234"
                  className="w-full bg-gray-700 rounded px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Passcode (optional)</label>
                <input
                  type="text"
                  value={passcode}
                  onChange={e => setPasscode(e.target.value)}
                  placeholder="123456# (if required)"
                  className="w-full bg-gray-700 rounded px-3 py-2 text-white"
                />
                <p className="text-xs text-gray-500 mt-1">Leave blank if no passcode needed. Include # or * if required</p>
              </div>
            </div>
          )}
          
          {audioSource === 'web' && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Web Stream URL</label>
              <input
                type="text"
                value={webUrl}
                onChange={e => setWebUrl(e.target.value)}
                placeholder="https://event.choruscall.com/..."
                className="w-full bg-gray-700 rounded px-3 py-2 text-white"
              />
              <p className="text-xs text-gray-500 mt-1">
                ⚠️ Web streams may have 5-15 second delay. Phone is recommended.
              </p>
            </div>
          )}

          {audioSource === 'desktop' && (
            <div className="space-y-3 mb-6">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Prime Video URL <span className="text-gray-500">(optional)</span></label>
                <input
                  type="text"
                  value={primeUrl}
                  onChange={e => setPrimeUrl(e.target.value)}
                  placeholder="https://www.amazon.com/video/detail/..."
                  className="w-full bg-gray-700 rounded px-3 py-2 text-white"
                />
              </div>
              <div className="bg-purple-900/30 border border-purple-700 rounded-lg p-3 text-sm text-purple-200 space-y-1">
                <p className="font-medium">🎬 How it works</p>
                <p className="text-xs text-purple-300">Chrome opens on the EC2 server. After launch, click <strong>Open VNC</strong> in the session monitor to see and control the browser — navigate to your show and press play. Audio streams automatically to the voice trader.</p>
              </div>
            </div>
          )}

          {audioSource === 'satellite' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-gray-400">Select Channel</label>
                <button
                  onClick={() => {
                    setSatLoading(true); setSatError(null); setSelectedSatStreamId(null);
                    fetch(`${EC2_BASE}/satellite/streams`)
                      .then(r => r.json())
                      .then(d => { setSatStreams(d.streams || []); setSatLoading(false); })
                      .catch(() => { setSatError('Could not reach satellite server'); setSatLoading(false); });
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >↺ Refresh</button>
              </div>
              {satLoading && (
                <div className="text-sm text-gray-400 py-4 text-center">Loading streams…</div>
              )}
              {satError && (
                <div className="text-sm text-red-400 py-2">{satError}</div>
              )}
              {!satLoading && !satError && satStreams.length === 0 && (
                <div className="text-sm text-gray-500 py-4 text-center">
                  No active streams — start a channel on the satellite server first.
                </div>
              )}
              {!satLoading && satStreams.length > 0 && (
                <div className="grid grid-cols-2 gap-3 mt-2">
                  {satStreams.map(s => (
                    <button
                      key={s.stream_id}
                      onClick={() => setSelectedSatStreamId(s.stream_id)}
                      className={`relative rounded-lg overflow-hidden border-2 transition-colors text-left ${
                        selectedSatStreamId === s.stream_id
                          ? 'border-green-500'
                          : 'border-gray-600 hover:border-gray-400'
                      }`}
                    >
                      <SatSnapshotImg streamId={s.stream_id} ec2Base={EC2_BASE} />
                      <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1">
                        <div className="text-xs font-medium truncate">{s.channel_name}</div>
                        <div className="text-xs text-gray-400">Stream {s.stream_id}</div>
                      </div>
                      {selectedSatStreamId === s.stream_id && (
                        <div className="absolute top-1 right-1 bg-green-500 rounded-full w-4 h-4 flex items-center justify-center text-xs">✓</div>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {selectedSatStreamId !== null && (
                <p className="text-xs text-green-400 mt-2">
                  ✓ Stream {selectedSatStreamId} selected — Riva transcripts will feed directly to Voice Trader
                </p>
              )}
            </div>
          )}
          
          <div className="mt-6">
            <label className="block text-sm text-gray-400 mb-1">Scheduled Start Time (optional)</label>
            <div className="flex gap-2">
              <input
                type="datetime-local"
                value={scheduledStart}
                onChange={e => setScheduledStart(e.target.value)}
                className="flex-1 bg-gray-700 rounded px-3 py-2 text-white"
              />
              {scheduledStart && (
                <button
                  type="button"
                  onClick={() => setScheduledStart('')}
                  className="px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-white"
                  title="Clear scheduled time"
                >
                  ✕
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {scheduledStart 
                ? `Will dial at ${new Date(scheduledStart).toLocaleTimeString()} local time`
                : 'Leave empty to dial immediately or show Start Call button'
              }
            </p>
          </div>
          
          <div className="mt-6">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={e => setDryRun(e.target.checked)}
                className="w-4 h-4 accent-yellow-500"
              />
              <span className={dryRun ? 'text-yellow-400 font-semibold' : ''}>
                🧪 Dry Run Mode {dryRun && '(ENABLED)'}
              </span>
            </label>
            <p className="text-xs text-gray-500 mt-1">
              When enabled, all trading actions are simulated. No real orders will be placed.
              Use this for testing the system without risking real money.
            </p>
          </div>
          
          <div className="mt-8">
            <button
              onClick={handleLaunch}
              disabled={launching || (audioSource === 'phone' && !phoneNumber) || (audioSource === 'web' && !webUrl) || (audioSource === 'satellite' && selectedSatStreamId === null)}
              className={`w-full font-bold py-3 px-4 rounded ${
                launching 
                  ? 'bg-gray-600 cursor-not-allowed' 
                  : 'bg-green-600 hover:bg-green-700'
              } text-white`}
            >
              {launching ? '⏳ ' + (launchStatus || 'Launching...') : '🚀 Launch Voice Trader'}
            </button>
            {launchStatus && !launching && (
              <p className="text-center text-gray-400 text-sm mt-2">{launchStatus}</p>
            )}
          </div>
        </div>
        
        <div className="mt-6 bg-gray-800 rounded-lg p-4">
          <h3 className="font-semibold mb-2">Words to Track ({selectedEvent.words?.length ?? 0})</h3>
          <div className="flex flex-wrap gap-2">
            {(selectedEvent.words || []).map(w => (
              <span
                key={w.market_ticker}
                className="bg-gray-700 px-2 py-1 rounded text-sm"
              >
                {w.word}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (pageState === 'monitoring' && selectedEvent) {
    // Derive simple call status from state
    const isCallActive = containerState?.call_state === 'in_progress' || containerState?.call_state === 'qa_session';
    const isConnecting = containerState?.call_state === 'connecting' || dialing;
    const isDisconnected = containerState?.call_state === 'disconnected' || containerState?.call_state === 'completed';
    const isReadyToConnect = containerState?.status_message?.toLowerCase().includes('ready to connect');
    
    // Single status message
    let statusMessage = 'Connecting...';
    let statusColor = 'text-gray-400';
    if (error) {
      statusMessage = error;
      statusColor = 'text-red-400';
    } else if (isCallActive) {
      statusMessage = '🟢 Call Active';
      statusColor = 'text-green-400';
    } else if (isConnecting) {
      statusMessage = '📞 Dialing...';
      statusColor = 'text-yellow-400';
    } else if (isDisconnected) {
      statusMessage = '🔴 Call Ended';
      statusColor = 'text-red-400';
    } else if (isReadyToConnect) {
      statusMessage = '⏳ Ready to Connect';
      statusColor = 'text-blue-400';
    } else if (containerState?.status_message) {
      statusMessage = containerState.status_message;
    }
    
    return (
      <div className="min-h-screen bg-gray-900 text-white p-4">
        {/* DRY RUN BANNER - show when in dry run mode */}
        {dryRun && (
          <div className="bg-yellow-600 text-yellow-900 px-3 py-1 rounded-lg mb-2 flex items-center gap-2 text-sm">
            <span>🧪</span>
            <span className="font-bold">DRY RUN MODE</span>
            <span>— No real trades will be executed</span>
          </div>
        )}

        {/* PRIME VIDEO BANNER - show when using desktop audio source */}
        {audioSource === 'desktop' && (
          <div className="bg-purple-900/40 border border-purple-700 px-3 py-2 rounded-lg mb-2 flex items-center gap-3 text-sm">
            <span className="text-purple-200 font-medium">🎬 Prime Video capture running</span>
            <button
              onClick={() => window.open(`${EC2_BASE}/prime/novnc`, 'prime-vnc',
                'width=1280,height=800,toolbar=no,menubar=no,scrollbars=no,resizable=yes')}
              className="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded font-medium transition-colors"
            >
              🖥️ Open VNC Viewer
            </button>
            <button
              onClick={async () => { await fetch(`${EC2_BASE}/prime/stop`, { method: 'POST' }); }}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            >
              Stop Capture
            </button>
          </div>
        )}
        
        {/* Header - SIMPLIFIED */}
        <div className="flex justify-between items-center mb-4">
          <div>
            <button
              onClick={() => {
                setPageState('events');
                setSelectedEvent(null);
                setSessionId(null);
                setWsConnected(false);
                setError(null);
                setDialing(false);
                setContainerState(null);  // Clear container state
                setWords([]);  // Clear word grid
                setTranscript([]);  // Clear transcript
                setSystemLog([]);  // Clear system log
                setLastSpeakerId(null);  // Reset speaker tracking
                if (wsRef.current) {
                  wsRef.current.close();
                  wsRef.current = null;
                }
              }}
              className="text-gray-400 hover:text-white text-sm mb-1 flex items-center gap-1"
            >
              ← Back to Lobby
            </button>
            <h1 className="text-xl font-bold">{selectedEvent.title}</h1>
            <a 
              href={`https://kalshi.com/events/${selectedEvent.event_ticker}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 hover:underline text-sm"
            >
              {selectedEvent.event_ticker} ↗
            </a>
            <div className={`text-sm ${statusColor}`}>{statusMessage}</div>
            
            {/* Detection Pause + Q&A Status Indicators */}
            {isCallActive && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                {/* Trading Toggle - system-wide on/off; starts OFF so user can identify speakers first */}
                <button
                  onClick={() => {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ 
                        type: 'set_detection_paused',
                        paused: !containerState?.detection_paused 
                      }));
                    }
                  }}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    containerState?.detection_paused 
                      ? 'bg-red-600 hover:bg-red-500 ring-2 ring-red-400' 
                      : 'bg-green-600 hover:bg-green-500'
                  }`}
                  title={containerState?.detection_paused 
                    ? "Trading OFF - Click to enable trading" 
                    : "Trading ON - Click to pause trading"}
                >
                  {containerState?.detection_paused ? '⏸️ Trading Off' : '▶️ Trading On'}
                </button>
                
                {/* Dry Run Toggle - Emergency stop / simulate mode */}
                <button
                  onClick={() => {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ 
                        type: 'set_dry_run',
                        dry_run: !containerState?.dry_run 
                      }));
                    }
                  }}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    containerState?.dry_run 
                      ? 'bg-yellow-600 hover:bg-yellow-500 ring-2 ring-yellow-400' 
                      : 'bg-blue-600 hover:bg-blue-500'
                  }`}
                  title={containerState?.dry_run 
                    ? "DRY RUN - trades are simulated, no real orders. Click to go live" 
                    : "LIVE - real orders will be placed. Click to switch to dry run"}
                >
                  {containerState?.dry_run ? '🧪 Dry Run' : '💰 Live'}
                </button>
                
                {/* Q&A Detection Toggle - show current state and allow toggle */}
                <button
                  onClick={() => {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ 
                        type: 'set_qa_detection_enabled',
                        enabled: !containerState?.qa_detection_enabled 
                      }));
                    }
                  }}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    containerState?.qa_detection_enabled 
                      ? 'bg-purple-600 hover:bg-purple-500' 
                      : 'bg-gray-600 hover:bg-gray-500'
                  }`}
                  title={containerState?.qa_detection_enabled 
                    ? "Q&A detection ON - AI will auto-pause on Q&A. Click to disable" 
                    : "Q&A detection OFF - Click to enable AI Q&A detection"}
                >
                  {containerState?.qa_detection_enabled ? '🤖 Q&A Detect: ON' : '🤖 Q&A Detect: OFF'}
                </button>
                
                {/* Call-End Detection Toggle */}
                <button
                  onClick={() => {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ 
                        type: 'set_call_end_detection_enabled',
                        enabled: !containerState?.call_end_detection_enabled 
                      }));
                    }
                  }}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    containerState?.call_end_detection_enabled 
                      ? 'bg-red-600 hover:bg-red-500' 
                      : 'bg-gray-600 hover:bg-gray-500'
                  }`}
                  title={containerState?.call_end_detection_enabled 
                    ? "End-of-call detection ON - AI will sweep NO on call end. Click to disable" 
                    : "End-of-call detection OFF - Click to enable"}
                >
                  {containerState?.call_end_detection_enabled ? '🔔 End Detect: ON' : '🔔 End Detect: OFF'}
                </button>
                
                {/* Q&A Triggered Status - show if Q&A has been triggered */}
                {containerState?.qa_started && (
                  <span className="bg-orange-600 px-2 py-1 rounded text-xs font-medium ring-2 ring-orange-400">
                    🎤 Q&A Triggered
                  </span>
                )}
              </div>
            )}
          </div>
          
          {/* ONE button based on state */}
          <div>
            {isReadyToConnect && !dialing && (
              <button
                onClick={async () => {
                  setDialing(true);
                  setError(null);
                  // Send connect command via WebSocket to worker
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'connect' }));
                  } else {
                    setError('WebSocket not connected');
                    setDialing(false);
                  }
                }}
                className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded"
              >
                📞 Start Call
              </button>
            )}
            {isConnecting && (
              <button
                onClick={() => {
                  // Cancel dialing - send stop command and reset state
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'cancel' }));
                  }
                  setDialing(false);
                  setError('Dialing cancelled');
                }}
                className="bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded animate-pulse"
              >
                📞 Dialing... (click to cancel)
              </button>
            )}
            {isCallActive && (
              <button
                onClick={handleStop}
                className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded"
              >
                📴 End Call
              </button>
            )}
            {isDisconnected && (
              <button
                onClick={() => {
                  setError(null);
                  setDialing(false);
                  // Go back to lobby to restart cleanly
                  setPageState('events');
                }}
                className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded"
              >
                ↩ Return to Lobby
              </button>
            )}
          </div>
        </div>
        
        {/* Audio Controls - simplified */}
        <div className="bg-gray-800 rounded-lg p-3 mb-4 flex items-center gap-3 flex-wrap">
          {/* Speaker control (incoming call audio) */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setAudioMuted(!audioMuted);
                // Resume audio context on user interaction (required by browsers)
                if (audioContextRef.current?.state === 'suspended') {
                  audioContextRef.current.resume();
                }
              }}
              className={`px-3 py-1.5 rounded text-sm transition-all duration-100 active:scale-95 active:brightness-75 flex items-center gap-1.5 ${
                audioMuted 
                  ? 'bg-red-600 hover:bg-red-700' 
                  : 'bg-gray-700 hover:bg-gray-600'
              }`}
              title="Mute/unmute incoming call audio"
            >
              {audioMuted ? '🔇' : '🔊'} Speaker
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={audioVolume}
              onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
              className="w-16 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
              title="Speaker volume"
            />
          </div>
          
          {/* Divider */}
          <div className="h-6 w-px bg-gray-600" />
          
          {/* Microphone control (outgoing user audio) */}
          <button
            onClick={toggleMicrophone}
            disabled={!wsConnected}
            className={`px-3 py-1.5 rounded text-sm flex items-center gap-1.5 transition-all duration-100 active:scale-95 active:brightness-75 ${
              !wsConnected
                ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                : micActive 
                  ? 'bg-green-600 hover:bg-green-700' 
                  : 'bg-gray-700 hover:bg-gray-600'
            }`}
            title={!wsConnected 
              ? "Microphone requires WebSocket (blocked by browser security on HTTPS)" 
              : "Toggle your microphone to speak to the call"}
          >
            {micActive ? (
              <>
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                🎤 Mic On
              </>
            ) : (
              '🎤 Mic Muted'
            )}
          </button>
          
          <div className="text-xs text-gray-500 ml-auto hidden lg:block">
            🔊 = hear call &nbsp;|&nbsp; 🎤 = talk to operator
          </div>
        </div>
        
        <div className="grid grid-cols-3 gap-4">
          {/* Left column: Word Grid - 5 columns for density */}
          <div className="col-span-2 bg-gray-800 rounded-lg p-3 max-h-[350px] overflow-y-auto">
            <h2 className="font-semibold mb-2 text-sm">Word Status</h2>
            <div className="grid grid-cols-5 gap-1">
              {words.map(w => {
                // Color based on status:
                // pending = yellow (trade in progress)
                // success = green (got fills)
                // skipped = purple strikethrough (word already said - orderbook detected)
                // no_fill/failed = gray (no trade executed)
                const bgClass = w.status === 'pending'
                  ? 'bg-yellow-900 border border-yellow-500'
                  : w.status === 'success'
                  ? 'bg-green-900 border border-green-500'
                  : w.status === 'skipped'
                  ? 'bg-purple-900/50 border border-purple-500'
                  : w.no_purchased
                  ? 'bg-red-900 border border-red-500'
                  : 'bg-gray-700';
                
                const statusIcon = w.status === 'pending'
                  ? '⏳'
                  : w.status === 'success'
                  ? '✓'
                  : w.status === 'no_fill'
                  ? '⚡'
                  : w.status === 'skipped'
                  ? '🚫'
                  : w.status === 'failed'
                  ? '✗'
                  : w.no_purchased
                  ? '✗ NO'
                  : '...';
                
                return (
                  <div
                    key={w.market_ticker}
                    className={`p-1.5 rounded text-xs ${bgClass}`}
                  >
                    <div className={`font-medium truncate ${w.status === 'skipped' ? 'line-through text-purple-300' : ''}`} title={w.word}>
                      {w.word}
                    </div>
                    <div className="text-[10px] text-gray-400 truncate">
                      {w.status === 'skipped'
                        ? '🚫 said'
                        : w.status === 'success' && w.trade_result
                        ? (w.trade_result.realized_profit !== undefined
                          ? `✓ ${w.trade_result.contracts_filled}@${w.trade_result.avg_buy_price?.toFixed(2)}→${w.trade_result.sell_fill_price?.toFixed(2)} +$${w.trade_result.realized_profit?.toFixed(2)}`
                          : `✓ ${w.trade_result.contracts_filled}@${w.trade_result.avg_buy_price?.toFixed(2)} (sell pending)`)
                        : w.status === 'pending' && w.trade_result
                        ? `⏳ ${w.trade_result.contracts_filled}@${w.trade_result.avg_buy_price?.toFixed(2)} ($${w.trade_result.cost?.toFixed(2)})`
                        : w.status && w.triggered_at
                        ? `${statusIcon} ${formatTime(w.triggered_at)}`
                        : w.no_purchased
                        ? '✗ NO'
                        : '...'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          
          {/* Right column: Trading & P&L (compact) */}
          <div className="space-y-3">
            {/* Trading Controls + P&L Combined */}
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <h2 className="font-semibold text-sm">Trading</h2>
                <button
                  onClick={() => setDialpadOpen(!dialpadOpen)}
                  className={`px-2 py-1 rounded text-xs ${dialpadOpen ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                  title="Toggle dialpad"
                >
                  📞 Dialpad
                </button>
              </div>
              <div className="text-sm space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-xs">Balance:</span>
                  <span className="font-mono text-xs">${cashBalance.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-xs">Available:</span>
                  <span className="font-mono text-xs">${availableCash.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-gray-400 text-xs">Bet Size:</span>
                  <div className="flex items-center gap-1">
                    <span className="text-gray-500 text-xs">$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={betSizeInput}
                      onChange={(e) => handleBetSizeInputChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          confirmBetSize();
                        }
                      }}
                      onBlur={() => {
                        const val = parseFloat(betSizeInput);
                        if (isNaN(val) || val < 0) {
                          setBetSizeInput(String(betSize));
                          setBetSizeDirty(false);
                        }
                      }}
                      className={`w-16 px-1 py-0.5 rounded text-xs font-mono text-right border ${
                        betSize < minTrade ? 'bg-red-900 border-red-500' :
                        betSizeDirty ? 'bg-yellow-900 border-yellow-500' :
                        'bg-green-900/40 border-green-600'
                      }`}
                    />
                    <button
                      onClick={confirmBetSize}
                      disabled={!betSizeDirty}
                      className={`px-1.5 py-0.5 rounded text-xs font-bold transition-colors ${
                        betSizeDirty
                          ? 'bg-yellow-600 hover:bg-yellow-500 text-black cursor-pointer'
                          : 'bg-green-800/60 text-green-300 cursor-default'
                      }`}
                    >
                      {betSizeDirty ? 'Set' : '✓'}
                    </button>
                  </div>
                </div>
                {betSize < minTrade && (
                  <div className="text-xs text-red-400">
                    ⚠️ Below min (${minTrade})
                  </div>
                )}
                {/* Manual Call End Button */}
                <div className="border-t border-gray-700 pt-2 mt-2">
                  <button
                    onClick={() => {
                      if (wsRef.current?.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({ type: 'force_call_end' }));
                      }
                    }}
                    className="w-full bg-red-700 hover:bg-red-600 px-2 py-1.5 rounded text-xs font-medium"
                    title="Manually trigger NO sweep on all untriggered markets"
                  >
                    🛑 End Call (Sweep NO)
                  </button>
                </div>
              </div>
            </div>
            
            {/* Dialpad Popup */}
            {dialpadOpen && (
              <div className="bg-gray-800 rounded-lg p-3 border border-gray-600">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-semibold text-sm">Dialpad</span>
                  <button
                    onClick={() => setDialpadOpen(false)}
                    className="text-gray-400 hover:text-white text-xs"
                  >
                    ✕
                  </button>
                </div>
                <div className="space-y-2">
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={dialpadInput}
                      onChange={(e) => setDialpadInput(e.target.value.replace(/[^0-9*#]/g, ''))}
                      onKeyDown={(e) => e.key === 'Enter' && sendDtmf(dialpadInput)}
                      placeholder="Digits..."
                      className="flex-1 min-w-0 bg-gray-700 px-2 py-1 rounded text-sm font-mono"
                      maxLength={20}
                    />
                    <button
                      onClick={() => sendDtmf(dialpadInput)}
                      disabled={!dialpadInput}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 px-2 py-1 rounded text-sm"
                    >
                      ➤
                    </button>
                  </div>
                  {passcode && (
                    <button
                      onClick={() => sendDtmf(passcode)}
                      className="w-full bg-green-600 hover:bg-green-700 py-1.5 rounded text-xs font-medium"
                    >
                      📞 Send PIN ({passcode})
                    </button>
                  )}
                  <div className="grid grid-cols-3 gap-1">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(d => (
                      <button
                        key={d}
                        onClick={() => sendDtmf(d)}
                        className="bg-gray-700 hover:bg-gray-600 py-1.5 rounded text-sm font-mono"
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            
            {/* Speakers - ALWAYS show section, even when empty */}
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-sm">🎙 Speakers</h2>
                {/* Speaker filter toggle - OFF by default, safe to enable once you trust the IDs */}
                <button
                  onClick={() => {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({
                        type: 'set_speaker_filter',
                        enabled: !containerState?.speakers?.filter_enabled
                      }));
                    }
                  }}
                  className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                    containerState?.speakers?.filter_enabled
                      ? 'bg-orange-600 hover:bg-orange-500 ring-1 ring-orange-400'
                      : 'bg-gray-600 hover:bg-gray-500'
                  }`}
                  title={containerState?.speakers?.filter_enabled
                    ? 'Speaker filter ON — uncheck a speaker to block their words from trading'
                    : 'Speaker filter OFF — all speakers trade (safe default). Enable to gate by speaker.'}
                >
                  {containerState?.speakers?.filter_enabled ? '🔒 Filter ON' : '🔓 Filter OFF'}
                </button>
              </div>
              <div className="text-xs space-y-1">
                {containerState?.speakers?.details && containerState.speakers.details.length > 0 ? (
                  containerState.speakers.details.slice(0, 8).map(s => {
                    const isCurrent = containerState.speakers.current === s.id;
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center gap-1.5 p-1 rounded ${
                          isCurrent
                            ? 'bg-blue-700/60 ring-1 ring-blue-400'
                            : s.is_valid ? 'bg-gray-700/50' : 'bg-red-900/40'
                        }`}
                      >
                        {/* Active speaker pulse */}
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          isCurrent ? 'bg-blue-400 animate-pulse' : 'bg-gray-600'
                        }`} />
                        {/* Valid-for-trading checkbox */}
                        <input
                          type="checkbox"
                          checked={s.is_valid}
                          onChange={(e) => {
                            if (wsRef.current?.readyState === WebSocket.OPEN) {
                              wsRef.current.send(JSON.stringify({
                                type: 'set_speaker_valid',
                                speaker_id: s.id,
                                is_valid: e.target.checked
                              }));
                            }
                          }}
                          title={s.is_valid ? 'Approved — words from this speaker will trade (when filter is ON)' : 'Not approved — check to allow this speaker to trigger trades'}
                          className="accent-green-500 cursor-pointer flex-shrink-0"
                        />
                        <span className="font-mono text-gray-300 flex-shrink-0">{s.id}</span>
                        {isCurrent && <span className="text-blue-300 text-[10px] flex-shrink-0">▶ speaking</span>}
                        <span className="text-gray-400 truncate">{s.sample}</span>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-gray-500 italic">No speakers detected yet{!containerState?.speakers?.filter_enabled ? ' — diarization active' : ''}</div>
                )}
                {containerState?.speakers?.filter_enabled && (
                  <div className="mt-1 text-orange-300 text-[10px]">
                    ⚠ Filter active — unchecked speakers will NOT trigger trades
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        
        {/* Split view: System Log and Transcript */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          {/* System/Execution Log - left panel, scrollable, never truncated */}
          <div className="bg-gray-800 rounded-lg p-3 max-h-[300px] overflow-y-auto" ref={systemLogRef}>
            <h2 className="font-semibold text-sm mb-2 sticky top-0 bg-gray-800 pb-1">📋 Execution Log</h2>
            <div className="text-xs space-y-0.5 font-mono">
              {systemLog.length === 0 ? (
                <div className="text-gray-500 italic">No events yet...</div>
              ) : (
                systemLog.map((entry, i) => {
                  const time = new Date(entry.timestamp * 1000).toLocaleTimeString();
                  // Color based on level
                  let colorClass = 'text-gray-300';
                  if (entry.level === 'trade') colorClass = 'text-green-400';
                  else if (entry.level === 'warning') colorClass = 'text-yellow-400';
                  else if (entry.level === 'error') colorClass = 'text-red-400';
                  else if (entry.level === 'ai') colorClass = 'text-purple-400';
                  
                  return (
                    <div key={i} className={`${colorClass} py-0.5`}>
                      <span className="text-gray-500">[{time}]</span> {entry.message}
                      {entry.details && <span className="text-gray-500"> ({entry.details})</span>}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          
          {/* Transcript - right panel, speech only with speaker markers */}
          <div className="bg-gray-800 rounded-lg p-3 max-h-[300px] overflow-y-auto">
            <h2 className="font-semibold text-sm mb-2 sticky top-0 bg-gray-800 pb-1">🎙️ Live Transcript</h2>
            <div className="text-xs space-y-0.5 font-mono">
              {(() => {
                const recent = transcript.slice(-100);
                // Find finals and the most recent partial
                const finalsOnly = recent.filter(seg => seg.is_final);
                const lastPartial = recent.filter(seg => !seg.is_final).slice(-1)[0];
                const toShow = lastPartial 
                  ? [...finalsOnly, lastPartial].slice(-50)
                  : finalsOnly.slice(-50);
                
                return toShow.map((seg, i) => {
                  const time = seg.timestamp ? new Date(seg.timestamp * 1000).toLocaleTimeString() : '';
                  
                  // Show speaker label and timestamp on speaker change
                  const prefix = seg.show_speaker 
                    ? <><span className="text-blue-400">[{time}]</span> <span className="text-cyan-400 font-bold">{seg.speaker_id || 'Speaker'}:</span> </>
                    : null;
                  
                  // Normal transcript - white for finals, gray italic for the current partial
                  return (
                    <div key={i} className={seg.is_final ? 'text-white' : 'text-gray-500 italic'}>
                      {prefix}{seg.text}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
// Test comment 1768250345
