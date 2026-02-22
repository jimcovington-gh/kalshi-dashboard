/**
 * TestBenchV2.tsx - V2 Pipeline Voice Trader Test Bench
 * 
 * This version is designed to work with the NEW v2 worker pipeline (worker_new.py).
 * 
 * v2 Features:
 * - Native v2 message format support
 * - Real-time stats dashboard
 * - Pipeline stage indicator
 * - Session timer
 * - Dedicated error panel
 * - Clean, organized UI
 * 
 * See TEST_BENCH_DOCUMENTATION.md for full documentation.
 */
'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

// =============================================================================
// Types - V2 Native Format
// =============================================================================

/** V2 Session States - matches pipeline/session.py SessionState enum */
type SessionState = 
  | 'created'      // Session created, not started
  | 'configuring'  // User is setting up
  | 'ready'        // Ready to start trading
  | 'connecting'   // Connecting to audio source
  | 'trading'      // Active trading
  | 'closing'      // Closing positions
  | 'completed'    // Session ended normally
  | 'error'        // Session ended with error
  | 'cancelled';   // Session cancelled by user

/** V2 Pipeline Component States */
type ComponentState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** V2 Session Statistics */
interface SessionStats {
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  audio_chunks: number;
  audio_duration_seconds: number;
  transcripts: number;
  final_transcripts: number;
  total_words: number;
  words_matched: number;
  yes_trades: number;
  no_trades: number;
  trades_filled: number;
  trades_rejected: number;
  total_volume_dollars: number;
  realized_pnl: number;
}

/** V2 Pipeline Status */
interface PipelineStatus {
  audio: ComponentState;
  stt: ComponentState;
  trading: ComponentState;
  overall: ComponentState;
}

/** V2 Session Config (from worker) */
interface SessionConfig {
  event_ticker: string;
  user_name: string;
  dry_run: boolean;
  audio_source: string;
  stt_provider: string;
}

/** V2 Full State (from WebSocket) */
interface V2State {
  session_id: string;
  state: SessionState;
  config: SessionConfig;
  stats: SessionStats;
  error_message: string;
  pipeline?: PipelineStatus;
  recent_events?: V2Event[];
}

/** V2 Event */
interface V2Event {
  timestamp: string;
  event_type: string;
  data: Record<string, unknown>;
}

/** V2 Transcript */
interface V2Transcript {
  text: string;
  is_final: boolean;
  speaker_id?: string;
  timestamp: number;
  confidence?: number;
}

/** V2 Trade */
interface V2Trade {
  market_ticker: string;
  word: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  contracts: number;
  price: number;
  filled: number;
  status: 'pending' | 'filled' | 'partial' | 'rejected' | 'error';
  reason?: string;
  timestamp: string;
}

/** Mention Event (from API) */
interface MentionEvent {
  event_ticker: string;
  title: string;
  start_date: string;
  hours_until_start: number;
  words: { market_ticker: string; word: string }[];
  word_count: number;
  container_status: string;
}

/** Word tracking status */
interface WordStatus {
  market_ticker: string;
  word: string;
  triggered: boolean;
  triggered_at?: number;
  status?: 'pending' | 'success' | 'partial' | 'rejected' | 'skipped';
  contracts_filled?: number;
  price?: number;
}

/** Transcript segment for display */
interface TranscriptSegment {
  text: string;
  timestamp: number;
  is_final: boolean;
  speaker_id?: string;
  show_speaker?: boolean;
}

/** System log entry */
interface SystemLogEntry {
  timestamp: number;
  message: string;
  level: 'info' | 'trade' | 'warning' | 'error' | 'ai';
  details?: string;
}

/** EC2 Status */
interface EC2Status {
  instance_id: string;
  status: 'running' | 'stopped' | 'stopping' | 'pending' | 'terminated';
  public_ip?: string;
  uptime_hours?: number;
}

/** Riva STT Status */
interface RivaStatus {
  status: 'healthy' | 'unhealthy' | 'unknown';
  port_open: boolean;
  health_check_ms?: number;
}

type PageState = 'loading' | 'events' | 'setup' | 'monitoring';

// =============================================================================
// Configuration
// =============================================================================

const API_BASE = 'https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod';
const VOICE_TRADER_HOST = process.env.NEXT_PUBLIC_VOICE_TRADER_HOST || 'voice.apexmarkets.us';
const EC2_BASE = `https://${VOICE_TRADER_HOST}:8080`;
const WS_BASE = `wss://${VOICE_TRADER_HOST}:8765`;

// =============================================================================
// Utility Functions
// =============================================================================

const formatDuration = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatTime = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleTimeString();
};

const getStateColor = (state: SessionState): string => {
  const colors: Record<SessionState, string> = {
    created: 'text-gray-400',
    configuring: 'text-blue-400',
    ready: 'text-yellow-400',
    connecting: 'text-blue-500',
    trading: 'text-green-500',
    closing: 'text-purple-500',
    completed: 'text-gray-500',
    error: 'text-red-500',
    cancelled: 'text-orange-500',
  };
  return colors[state] || 'text-gray-400';
};

const getStateBgColor = (state: SessionState): string => {
  const colors: Record<SessionState, string> = {
    created: 'bg-gray-700',
    configuring: 'bg-blue-900',
    ready: 'bg-yellow-900',
    connecting: 'bg-blue-800',
    trading: 'bg-green-900',
    closing: 'bg-purple-900',
    completed: 'bg-gray-800',
    error: 'bg-red-900',
    cancelled: 'bg-orange-900',
  };
  return colors[state] || 'bg-gray-700';
};

const getStateIcon = (state: SessionState): string => {
  const icons: Record<SessionState, string> = {
    created: '⚪',
    configuring: '⚙️',
    ready: '🟡',
    connecting: '🔄',
    trading: '🟢',
    closing: '🔴',
    completed: '✅',
    error: '❌',
    cancelled: '⛔',
  };
  return icons[state] || '⚪';
};

const getComponentStateColor = (state: ComponentState): string => {
  const colors: Record<ComponentState, string> = {
    stopped: 'bg-gray-600',
    starting: 'bg-yellow-600',
    running: 'bg-green-600',
    stopping: 'bg-orange-600',
    error: 'bg-red-600',
  };
  return colors[state] || 'bg-gray-600';
};

// =============================================================================
// Sub-Components
// =============================================================================

/** Pipeline Stage Indicator */
const PipelineIndicator: React.FC<{ pipeline?: PipelineStatus }> = ({ pipeline }) => {
  const stages = [
    { name: 'Audio', state: pipeline?.audio || 'stopped' },
    { name: 'STT', state: pipeline?.stt || 'stopped' },
    { name: 'Trading', state: pipeline?.trading || 'stopped' },
  ];

  return (
    <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
      <span className="text-xs text-gray-400 mr-2">Pipeline:</span>
      {stages.map((stage, i) => (
        <React.Fragment key={stage.name}>
          <div className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-full ${getComponentStateColor(stage.state as ComponentState)}`} />
            <span className="text-xs text-gray-300">{stage.name}</span>
          </div>
          {i < stages.length - 1 && <span className="text-gray-600">→</span>}
        </React.Fragment>
      ))}
    </div>
  );
};

/** Session Timer */
const SessionTimer: React.FC<{ startedAt: string | null; endedAt: string | null }> = ({ startedAt, endedAt }) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }

    const start = new Date(startedAt).getTime();
    const end = endedAt ? new Date(endedAt).getTime() : null;

    if (end) {
      setElapsed((end - start) / 1000);
      return;
    }

    const interval = setInterval(() => {
      setElapsed((Date.now() - start) / 1000);
    }, 1000);

    return () => clearInterval(interval);
  }, [startedAt, endedAt]);

  return (
    <div className="bg-gray-800 rounded-lg px-4 py-2 flex items-center gap-2">
      <span className="text-gray-400 text-sm">⏱️</span>
      <span className="font-mono text-lg text-white">{formatDuration(elapsed)}</span>
    </div>
  );
};

/** Stats Dashboard Panel */
const StatsPanel: React.FC<{ stats: SessionStats | null }> = ({ stats }) => {
  if (!stats) return null;

  const statItems = [
    { label: 'Audio Chunks', value: stats.audio_chunks.toLocaleString(), icon: '🎵' },
    { label: 'Audio Duration', value: `${stats.audio_duration_seconds.toFixed(1)}s`, icon: '⏱️' },
    { label: 'Transcripts', value: `${stats.final_transcripts} final`, icon: '📝' },
    { label: 'Words Heard', value: stats.total_words.toLocaleString(), icon: '👂' },
    { label: 'Words Matched', value: stats.words_matched.toString(), icon: '🎯' },
    { label: 'YES Trades', value: stats.yes_trades.toString(), icon: '🟢' },
    { label: 'NO Trades', value: stats.no_trades.toString(), icon: '🔴' },
    { label: 'Filled', value: stats.trades_filled.toString(), icon: '✅' },
    { label: 'Rejected', value: stats.trades_rejected.toString(), icon: '❌' },
    { label: 'Volume', value: `$${stats.total_volume_dollars.toFixed(2)}`, icon: '💰' },
    { label: 'P&L', value: `$${stats.realized_pnl.toFixed(2)}`, icon: stats.realized_pnl >= 0 ? '📈' : '📉' },
  ];

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
        <span>📊</span> Session Statistics
      </h3>
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {statItems.map(({ label, value, icon }) => (
          <div key={label} className="bg-gray-700/50 rounded px-2 py-1.5 text-center">
            <div className="text-xs text-gray-400">{icon} {label}</div>
            <div className="text-sm font-medium text-white">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Error Panel */
const ErrorPanel: React.FC<{ 
  error: string | null; 
  errorMessage: string;
  onDismiss: () => void;
}> = ({ error, errorMessage, onDismiss }) => {
  const displayError = error || errorMessage;
  if (!displayError) return null;

  return (
    <div className="bg-red-900/80 border border-red-500 rounded-lg p-4 mb-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <h4 className="font-semibold text-red-200">Error</h4>
            <p className="text-red-100 text-sm mt-1">{displayError}</p>
          </div>
        </div>
        <button 
          onClick={onDismiss}
          className="text-red-300 hover:text-white text-sm px-2"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

/** State Badge */
const StateBadge: React.FC<{ state: SessionState }> = ({ state }) => (
  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${getStateBgColor(state)} ${getStateColor(state)}`}>
    <span>{getStateIcon(state)}</span>
    <span className="uppercase">{state}</span>
  </span>
);

/** Word Grid */
const WordGrid: React.FC<{ words: WordStatus[] }> = ({ words }) => {
  const getWordStyle = (word: WordStatus) => {
    if (word.status === 'success') return 'bg-green-800 border-green-500 text-green-200';
    if (word.status === 'pending') return 'bg-yellow-800 border-yellow-500 text-yellow-200 animate-pulse';
    if (word.status === 'partial') return 'bg-blue-800 border-blue-500 text-blue-200';
    if (word.status === 'rejected' || word.status === 'skipped') return 'bg-gray-700 border-gray-500 text-gray-400 line-through';
    if (word.triggered) return 'bg-green-900 border-green-600 text-green-300';
    return 'bg-gray-800 border-gray-600 text-gray-300';
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
        <span>🎯</span> Target Words ({words.filter(w => w.triggered || w.status === 'success').length}/{words.length})
      </h3>
      <div className="flex flex-wrap gap-2">
        {words.map(word => (
          <div
            key={word.market_ticker}
            className={`px-3 py-1.5 rounded border text-sm ${getWordStyle(word)}`}
            title={`${word.market_ticker}${word.status ? ` - ${word.status}` : ''}`}
          >
            {word.word}
            {word.contracts_filled && word.contracts_filled > 0 && (
              <span className="ml-1 text-xs opacity-75">({word.contracts_filled})</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

/** System Log */
const SystemLog: React.FC<{ entries: SystemLogEntry[]; logRef: React.RefObject<HTMLDivElement | null> }> = ({ entries, logRef }) => {
  const getLevelStyle = (level: string) => {
    switch (level) {
      case 'trade': return 'text-green-400';
      case 'warning': return 'text-yellow-400';
      case 'error': return 'text-red-400';
      case 'ai': return 'text-purple-400';
      default: return 'text-gray-400';
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4 flex-1 min-h-0">
      <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
        <span>📋</span> System Log
      </h3>
      <div 
        ref={logRef}
        className="h-48 overflow-y-auto font-mono text-xs space-y-1 bg-gray-900 rounded p-2"
      >
        {entries.length === 0 ? (
          <div className="text-gray-500 italic">No events yet...</div>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className={getLevelStyle(entry.level)}>
              <span className="text-gray-500">[{formatTime(entry.timestamp)}]</span>{' '}
              {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/** Transcript Panel */
const TranscriptPanel: React.FC<{ segments: TranscriptSegment[] }> = ({ segments }) => {
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [segments]);

  return (
    <div className="bg-gray-800 rounded-lg p-4 flex-1 min-h-0">
      <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
        <span>🎤</span> Live Transcript
      </h3>
      <div 
        ref={transcriptRef}
        className="h-64 overflow-y-auto bg-gray-900 rounded p-3 text-sm"
      >
        {segments.length === 0 ? (
          <div className="text-gray-500 italic">Waiting for audio...</div>
        ) : (
          segments.map((seg, i) => (
            <span key={i} className={seg.is_final ? 'text-white' : 'text-gray-400'}>
              {seg.show_speaker && seg.speaker_id && (
                <span className="text-blue-400 text-xs mr-1">[{seg.speaker_id}]</span>
              )}
              {seg.text}{' '}
            </span>
          ))
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Satellite channel picker thumbnail — auto-refreshes JPEG snapshot every 5s
// =============================================================================

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

// =============================================================================
// Main Component
// =============================================================================

export function TestBenchV2() {
  const router = useRouter();
  
  // Page navigation state
  const [pageState, setPageState] = useState<PageState>('loading');
  const [authToken, setAuthToken] = useState<string | null>(null);
  
  // Events list
  const [events, setEvents] = useState<MentionEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<MentionEvent | null>(null);
  
  // Setup form
  const [audioSource, setAudioSource] = useState<'phone' | 'web' | 'satellite'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [passcode, setPasscode] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [launching, setLaunching] = useState(false);

  // Satellite TV channel picker
  interface SatStream { stream_id: number; channel_name: string; status: string; thumb_url: string; }
  const [satStreams, setSatStreams] = useState<SatStream[]>([]);
  const [satLoading, setSatLoading] = useState(false);
  const [satError, setSatError] = useState<string | null>(null);
  const [selectedSatStreamId, setSelectedSatStreamId] = useState<number | null>(null);
  
  // Session state (V2 format)
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>('created');
  const [sessionConfig, setSessionConfig] = useState<SessionConfig | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null);
  
  // UI state
  const [error, setError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [words, setWords] = useState<WordStatus[]>([]);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [systemLog, setSystemLog] = useState<SystemLogEntry[]>([]);
  const systemLogRef = useRef<HTMLDivElement>(null);
  
  // WebSocket
  const [wsConnected, setWsConnected] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  // EC2/Riva status
  const [ec2Status, setEc2Status] = useState<EC2Status | null>(null);
  const [rivaStatus, setRivaStatus] = useState<RivaStatus | null>(null);
  const [ec2Loading, setEc2Loading] = useState(false);
  
  // Audio playback
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0.7);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);

  // Track speaker changes for transcript display
  const lastSpeakerRef = useRef<string | null>(null);

  // ==========================================================================
  // Auth
  // ==========================================================================
  
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
      } catch {
        router.push('/');
      }
    }
    getAuth();
  }, [router]);

  // ==========================================================================
  // Fetch Events
  // ==========================================================================
  
  useEffect(() => {
    if (pageState !== 'events' || !authToken) return;

    async function fetchEvents() {
      try {
        const response = await fetch(`${API_BASE}/voice-trader/events`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (response.ok) {
          const data = await response.json();
          setEvents(data.events || []);
        }
      } catch (err) {
        console.error('Failed to fetch events:', err);
      }
    }

    async function fetchEC2Status() {
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${EC2_BASE}/health`, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          setEc2Status({
            instance_id: data.instance_id || 'unknown',
            status: 'running',
            public_ip: data.public_ip,
            uptime_hours: data.uptime_hours,
          });
          setRivaStatus(data.riva);
        }
      } catch {
        setEc2Status({ instance_id: 'unknown', status: 'stopped' });
      }
    }

    fetchEvents();
    fetchEC2Status();
    const interval = setInterval(() => {
      fetchEvents();
      fetchEC2Status();
    }, 30000);
    return () => clearInterval(interval);
  }, [pageState, authToken]);

  // ==========================================================================
  // WebSocket Connection
  // ==========================================================================
  
  useEffect(() => {
    if (pageState !== 'monitoring' || !wsUrl) return;

    let ws: WebSocket | null = null;
    let retryCount = 0;
    const maxRetries = 15;
    let retryTimeout: NodeJS.Timeout | null = null;
    let isConnecting = true;

    const connectWebSocket = () => {
      if (!isConnecting) return;

      try {
        console.log(`[WS] Connecting to ${wsUrl} (attempt ${retryCount + 1}/${maxRetries})`);
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          console.log('[WS] Connected');
          setWsConnected(true);
          retryCount = 0;
          
          addSystemLog('Connected to Voice Trader (v2 pipeline)', 'info');
          
          // Request initial state
          ws?.send(JSON.stringify({ action: 'get_state' }));
        };

        ws.onmessage = (event) => {
          // Handle binary audio data
          if (event.data instanceof ArrayBuffer) {
            const firstByte = new Uint8Array(event.data)[0];
            if (firstByte !== 0x7B) { // Not JSON
              playAudioChunk(event.data);
              return;
            }
          }

          // Parse JSON message
          const raw = typeof event.data === 'string' 
            ? event.data 
            : new TextDecoder().decode(event.data);
          
          try {
            const message = JSON.parse(raw);
            handleV2Message(message);
          } catch (err) {
            console.error('[WS] Failed to parse message:', err);
          }
        };

        ws.onerror = (err) => {
          console.error('[WS] Error:', err);
        };

        ws.onclose = (event) => {
          console.log(`[WS] Closed (code: ${event.code})`);
          setWsConnected(false);

          if (isConnecting && retryCount < maxRetries) {
            retryCount++;
            retryTimeout = setTimeout(connectWebSocket, 2000);
          }
        };
      } catch (err) {
        console.error('[WS] Failed to create:', err);
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
    };
  }, [pageState, wsUrl]);

  // ==========================================================================
  // V2 Message Handler
  // ==========================================================================
  
  const handleV2Message = useCallback((message: { type: string; data?: unknown; timestamp?: string }) => {
    const { type, data } = message;

    switch (type) {
      case 'state': {
        // Full state update
        const state = data as V2State;
        setSessionState(state.state);
        setSessionConfig(state.config);
        setSessionStats(state.stats);
        setPipelineStatus(state.pipeline || null);
        setErrorMessage(state.error_message || '');
        
        // Initialize words from config if needed
        if (state.config?.event_ticker && words.length === 0) {
          // Words will be populated from event data
        }
        break;
      }

      case 'state_change': {
        // State transition
        const { old_state, new_state } = data as { old_state: string; new_state: string };
        setSessionState(new_state as SessionState);
        addSystemLog(`State: ${old_state} → ${new_state}`, 'info');
        break;
      }

      case 'transcript': {
        // Transcript update
        const t = data as V2Transcript;
        const speakerChanged = lastSpeakerRef.current !== t.speaker_id;
        lastSpeakerRef.current = t.speaker_id || null;

        setTranscript(prev => {
          const newSeg: TranscriptSegment = {
            text: t.text,
            is_final: t.is_final,
            speaker_id: t.speaker_id,
            timestamp: t.timestamp,
            show_speaker: speakerChanged || prev.length === 0,
          };

          if (t.is_final) {
            // Keep only final transcripts + this one
            const finals = prev.filter(s => s.is_final);
            return [...finals.slice(-100), newSeg];
          } else {
            // Replace last partial
            const lastIdx = prev.length - 1;
            if (lastIdx >= 0 && !prev[lastIdx].is_final) {
              return [...prev.slice(0, lastIdx), newSeg];
            }
            return [...prev, newSeg];
          }
        });
        break;
      }

      case 'trade': {
        // Trade execution
        const trade = data as V2Trade;
        const emoji = trade.side === 'yes' ? '🟢' : '🔴';
        const status = trade.status === 'filled' ? '✅' : trade.status === 'rejected' ? '❌' : '⏳';
        
        addSystemLog(
          `${emoji} ${trade.side.toUpperCase()} ${trade.word}: ${trade.filled}/${trade.contracts} @ $${trade.price.toFixed(2)} ${status}`,
          'trade'
        );

        // Update word status
        setWords(prev => prev.map(w => 
          w.market_ticker === trade.market_ticker
            ? { 
                ...w, 
                triggered: true,
                status: trade.status === 'filled' ? 'success' : 
                        trade.status === 'partial' ? 'partial' :
                        trade.status === 'rejected' ? 'rejected' : 'pending',
                contracts_filled: trade.filled,
                price: trade.price,
              }
            : w
        ));
        break;
      }

      case 'error': {
        // Error message
        const { message: errMsg } = data as { message: string };
        setError(errMsg);
        addSystemLog(`Error: ${errMsg}`, 'error');
        break;
      }

      case 'pong': {
        // Keepalive response - ignore
        break;
      }

      // Legacy message types (for compatibility during transition)
      case 'full_state': {
        // Legacy full state - adapt to v2
        const legacyData = data as Record<string, unknown>;
        if (legacyData.call) {
          const call = legacyData.call as Record<string, unknown>;
          // Map legacy call_state to session state
          const stateMap: Record<string, SessionState> = {
            waiting: 'ready',
            connecting: 'connecting',
            in_progress: 'trading',
            connected: 'trading',
            qa_session: 'trading',
            disconnected: 'completed',
            completed: 'completed',
          };
          setSessionState(stateMap[call.call_state as string] || 'trading');
        }
        if (legacyData.words) {
          setWords(legacyData.words as WordStatus[]);
        }
        break;
      }

      case 'word_triggered':
      case 'word_status_update': {
        // Legacy word events
        const wordData = data as { market_ticker: string; word?: string; triggered?: boolean; status?: string };
        setWords(prev => prev.map(w =>
          w.market_ticker === wordData.market_ticker
            ? { ...w, triggered: wordData.triggered ?? true, status: (wordData.status as WordStatus['status']) || 'pending' }
            : w
        ));
        break;
      }

      case 'event': {
        // Generic event
        const eventData = data as { message: string; event_type?: string };
        addSystemLog(eventData.message, 'info');
        break;
      }

      case 'ai_event': {
        // AI detection event
        const aiData = data as { event: string; reason?: string };
        addSystemLog(`🤖 AI: ${aiData.event}${aiData.reason ? ` - ${aiData.reason}` : ''}`, 'ai');
        break;
      }

      case 'trade_executed': {
        // Legacy trade event
        const legacyTrade = data as { market_ticker: string; side: string; contracts_filled: number; price: number };
        addSystemLog(
          `${legacyTrade.side === 'yes' ? '🟢' : '🔴'} ${legacyTrade.side.toUpperCase()}: ${legacyTrade.contracts_filled} @ $${legacyTrade.price.toFixed(2)}`,
          'trade'
        );
        break;
      }

      default:
        console.log('[WS] Unknown message type:', type, data);
    }
  }, [words.length]);

  // ==========================================================================
  // Helpers
  // ==========================================================================
  
  const addSystemLog = useCallback((message: string, level: SystemLogEntry['level']) => {
    setSystemLog(prev => [...prev.slice(-200), {
      timestamp: Date.now() / 1000,
      message,
      level,
    }]);
  }, []);

  // Auto-scroll system log
  useEffect(() => {
    if (systemLogRef.current) {
      systemLogRef.current.scrollTop = systemLogRef.current.scrollHeight;
    }
  }, [systemLog]);

  // ==========================================================================
  // Audio Playback
  // ==========================================================================
  
  const playAudioChunk = useCallback((buffer: ArrayBuffer) => {
    if (audioMuted || buffer.byteLength < 100) return;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 8000 });
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.connect(audioContextRef.current.destination);
      gainNodeRef.current.gain.value = audioVolume;
    }

    const ctx = audioContextRef.current;
    const gain = gainNodeRef.current!;

    // Decode μ-law
    const mulaw = new Uint8Array(buffer);
    const pcm = new Float32Array(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) {
      const mu = ~mulaw[i] & 0xFF;
      const sign = mu & 0x80 ? -1 : 1;
      const exponent = (mu >> 4) & 0x07;
      const mantissa = mu & 0x0F;
      const sample = sign * ((mantissa << 1) + 33) * Math.pow(2, exponent) - 33;
      pcm[i] = sample / 8192;
    }

    const audioBuffer = ctx.createBuffer(1, pcm.length, 8000);
    audioBuffer.getChannelData(0).set(pcm);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gain);

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
  }, [audioMuted, audioVolume]);

  // Update volume
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = audioVolume;
    }
  }, [audioVolume]);

  // ==========================================================================
  // Actions
  // ==========================================================================
  
  const handleSelectEvent = (event: MentionEvent) => {
    setSelectedEvent(event);
    setWords(event.words.map(w => ({
      market_ticker: w.market_ticker,
      word: w.word,
      triggered: false,
    })));
    setPageState('setup');
  };

  const handleLaunch = async () => {
    if (!selectedEvent) return;
    
    setLaunching(true);
    setError(null);

    try {
      const config = {
        session_id: selectedEvent.event_ticker,
        event_ticker: selectedEvent.event_ticker,
        audio_source: audioSource === 'satellite' ? 'satellite_transcript' : audioSource,
        phone_number: audioSource === 'phone' ? phoneNumber : undefined,
        passcode: audioSource === 'phone' ? passcode : undefined,
        stream_url: audioSource === 'web' ? webUrl : undefined,
        satellite_stream_id: audioSource === 'satellite' ? selectedSatStreamId : undefined,
        dry_run: dryRun,
        use_v2: true, // Use v2 worker pipeline (worker_new.py)
      };

      const response = await fetch(`${EC2_BASE}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        throw new Error(`Launch failed: ${response.status}`);
      }

      const data = await response.json();
      setSessionId(data.session_id);
      setWsUrl(`${WS_BASE}?session=${data.session_id}`);
      setPageState('monitoring');
      addSystemLog(`Session started: ${data.session_id}`, 'info');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const handleStop = async () => {
    if (!sessionId) return;

    try {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      await fetch(`${EC2_BASE}/stop/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
      });

      // Reset state
      setPageState('events');
      setSelectedEvent(null);
      setSessionId(null);
      setSessionState('created');
      setSessionStats(null);
      setPipelineStatus(null);
      setWords([]);
      setTranscript([]);
      setSystemLog([]);
      setError(null);
      setWsUrl(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleEC2Start = async () => {
    setEc2Loading(true);
    try {
      await fetch(`${API_BASE}/voice-trader/ec2/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setEc2Status(prev => prev ? { ...prev, status: 'pending' } : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEc2Loading(false);
    }
  };

  const handleEC2Stop = async () => {
    setEc2Loading(true);
    try {
      await fetch(`${API_BASE}/voice-trader/ec2/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setEc2Status(prev => prev ? { ...prev, status: 'stopping' } : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEc2Loading(false);
    }
  };

  // ==========================================================================
  // Render: Loading
  // ==========================================================================
  
  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl animate-pulse">Loading...</div>
      </div>
    );
  }

  // ==========================================================================
  // Render: Events List
  // ==========================================================================
  
  if (pageState === 'events') {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold">Voice Trader Test Bench</h1>
              <p className="text-gray-400 mt-1">v2 Pipeline</p>
            </div>
            <div className="text-right">
              {ec2Status && (
                <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
                  ec2Status.status === 'running' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${ec2Status.status === 'running' ? 'bg-green-400' : 'bg-red-400'}`} />
                  Server {ec2Status.status}
                </div>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4 flex justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="underline">Dismiss</button>
            </div>
          )}

          {/* Server Controls */}
          <div className="bg-gray-800 rounded-lg p-4 mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              🖥️ Voice Server
            </h2>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                {ec2Status?.status === 'running' ? (
                  <div className="text-sm text-gray-400">
                    IP: {ec2Status.public_ip} • Uptime: {ec2Status.uptime_hours?.toFixed(1)}h
                    {rivaStatus && (
                      <span className={`ml-2 ${rivaStatus.status === 'healthy' ? 'text-green-400' : 'text-red-400'}`}>
                        • Riva: {rivaStatus.status}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">Server is offline</div>
                )}
              </div>
              <div className="flex gap-2">
                {ec2Status?.status !== 'running' ? (
                  <button
                    onClick={handleEC2Start}
                    disabled={ec2Loading}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-sm"
                  >
                    {ec2Loading ? 'Starting...' : 'Start Server'}
                  </button>
                ) : (
                  <button
                    onClick={handleEC2Stop}
                    disabled={ec2Loading}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded text-sm"
                  >
                    {ec2Loading ? 'Stopping...' : 'Stop Server'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Events Grid */}
          <h2 className="text-xl font-semibold mb-4">📅 Upcoming Events</h2>
          {events.length === 0 ? (
            <div className="text-gray-500 text-center py-8">No events available</div>
          ) : (
            <div className="grid gap-4">
              {events.map(event => (
                <div
                  key={event.event_ticker}
                  onClick={() => handleSelectEvent(event)}
                  className="bg-gray-800 hover:bg-gray-750 rounded-lg p-4 cursor-pointer transition-colors border border-gray-700 hover:border-gray-600"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-lg font-semibold">{event.title}</h3>
                      <p className="text-gray-400 text-sm">{event.event_ticker}</p>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-400">
                        {new Date(event.start_date).toLocaleString()}
                      </div>
                      <div className={`text-sm ${event.hours_until_start <= 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                        {event.hours_until_start <= 0 
                          ? `🔴 LIVE - ${Math.abs(Math.round(event.hours_until_start * 60))} min ago`
                          : `${event.hours_until_start.toFixed(1)} hrs until start`}
                      </div>
                      <div className="text-sm text-blue-400">{event.word_count} words</div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {event.words.slice(0, 8).map(w => (
                      <span key={w.market_ticker} className="bg-gray-700 px-2 py-1 rounded text-xs">
                        {w.word}
                      </span>
                    ))}
                    {event.words.length > 8 && (
                      <span className="text-gray-500 text-xs">+{event.words.length - 8} more</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==========================================================================
  // Render: Setup
  // ==========================================================================
  
  if (pageState === 'setup' && selectedEvent) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-2xl mx-auto">
          <button
            onClick={() => setPageState('events')}
            className="text-gray-400 hover:text-white mb-4"
          >
            ← Back to events
          </button>

          <h1 className="text-2xl font-bold mb-1">{selectedEvent.title}</h1>
          <p className="text-gray-400 mb-6">{selectedEvent.event_ticker}</p>

          {error && (
            <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          <div className="bg-gray-800 rounded-lg p-6 space-y-6">
            {/* Audio Source */}
            <div>
              <h2 className="text-lg font-semibold mb-3">Audio Source</h2>
              <div className="flex gap-3">
                <button
                  onClick={() => setAudioSource('phone')}
                  className={`flex-1 py-3 rounded-lg border-2 transition-colors ${
                    audioSource === 'phone' 
                      ? 'border-blue-500 bg-blue-900/50' 
                      : 'border-gray-600 hover:border-gray-500'
                  }`}
                >
                  📞 Phone Dial-In
                </button>
                <button
                  onClick={() => setAudioSource('web')}
                  className={`flex-1 py-3 rounded-lg border-2 transition-colors ${
                    audioSource === 'web' 
                      ? 'border-blue-500 bg-blue-900/50' 
                      : 'border-gray-600 hover:border-gray-500'
                  }`}
                >
                  🌐 Web Stream
                </button>
                <button
                  onClick={() => {
                    setAudioSource('satellite');
                    setSatError(null);
                    setSatLoading(true);
                    setSelectedSatStreamId(null);
                    fetch(`${EC2_BASE}/satellite/streams`)
                      .then(r => r.json())
                      .then(d => { setSatStreams(d.streams || []); setSatLoading(false); })
                      .catch(e => { setSatError('Could not reach satellite server'); setSatLoading(false); });
                  }}
                  className={`flex-1 py-3 rounded-lg border-2 transition-colors ${
                    audioSource === 'satellite'
                      ? 'border-blue-500 bg-blue-900/50'
                      : 'border-gray-600 hover:border-gray-500'
                  }`}
                >
                  📡 Satellite TV
                </button>
              </div>
            </div>

            {/* Phone Options */}
            {audioSource === 'phone' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Phone Number</label>
                  <input
                    type="text"
                    value={phoneNumber}
                    onChange={e => setPhoneNumber(e.target.value)}
                    placeholder="+1-800-555-1234"
                    className="w-full bg-gray-700 rounded px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Passcode</label>
                  <input
                    type="text"
                    value={passcode}
                    onChange={e => setPasscode(e.target.value)}
                    placeholder="Optional - include # if needed"
                    className="w-full bg-gray-700 rounded px-3 py-2"
                  />
                </div>
              </div>
            )}

            {/* Web Options */}
            {audioSource === 'web' && (
              <div>
                <label className="block text-sm text-gray-400 mb-1">Stream URL</label>
                <input
                  type="text"
                  value={webUrl}
                  onChange={e => setWebUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-gray-700 rounded px-3 py-2"
                />
                <p className="text-xs text-yellow-400 mt-1">
                  ⚠️ Web streams have 5-15s delay. Phone is recommended.
                </p>
              </div>
            )}

            {/* Satellite channel picker */}
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
                          <div className="text-xs text-gray-400">Adapter {s.stream_id}</div>
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

            {/* Dry Run Toggle */}
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="dryRun"
                checked={dryRun}
                onChange={e => setDryRun(e.target.checked)}
                className="w-5 h-5 rounded"
              />
              <label htmlFor="dryRun" className="text-sm">
                <span className="font-medium">Dry Run Mode</span>
                <span className="text-gray-400 ml-2">- Simulated trades only</span>
              </label>
            </div>

            {/* Launch Button */}
            <button
              onClick={handleLaunch}
              disabled={launching || (audioSource === 'phone' && !phoneNumber) || (audioSource === 'web' && !webUrl) || (audioSource === 'satellite' && selectedSatStreamId === null)}
              className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-semibold text-lg transition-colors"
            >
              {launching ? '🔄 Launching...' : '🚀 Start Session'}
            </button>
          </div>

          {/* Words Preview */}
          <div className="mt-6 bg-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">
              Target Words ({selectedEvent.words.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {selectedEvent.words.map(w => (
                <span key={w.market_ticker} className="bg-gray-700 px-2 py-1 rounded text-xs">
                  {w.word}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================================================
  // Render: Monitoring
  // ==========================================================================
  
  if (pageState === 'monitoring') {
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        {/* Top Bar */}
        <div className="bg-gray-800 border-b border-gray-700 px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-3">
            {/* Left: State + Timer */}
            <div className="flex items-center gap-4">
              <StateBadge state={sessionState} />
              <SessionTimer 
                startedAt={sessionStats?.started_at || null} 
                endedAt={sessionStats?.ended_at || null} 
              />
            </div>
            
            {/* Center: Pipeline */}
            <PipelineIndicator pipeline={pipelineStatus || undefined} />
            
            {/* Right: Controls */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">🔊</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={audioVolume}
                  onChange={e => setAudioVolume(parseFloat(e.target.value))}
                  className="w-20"
                />
                <button
                  onClick={() => setAudioMuted(!audioMuted)}
                  className={`px-2 py-1 rounded text-sm ${audioMuted ? 'bg-red-600' : 'bg-gray-700'}`}
                >
                  {audioMuted ? '🔇' : '🔊'}
                </button>
              </div>
              <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`} 
                   title={wsConnected ? 'Connected' : 'Disconnected'} />
              <button
                onClick={handleStop}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm font-medium"
              >
                End Session
              </button>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="max-w-7xl mx-auto p-4 space-y-4">
          {/* Error Panel */}
          <ErrorPanel 
            error={error} 
            errorMessage={errorMessage} 
            onDismiss={() => { setError(null); setErrorMessage(''); }} 
          />

          {/* Stats Panel */}
          <StatsPanel stats={sessionStats} />

          {/* Config Info */}
          {sessionConfig && (
            <div className="bg-gray-800 rounded-lg px-4 py-2 flex items-center gap-4 text-sm">
              <span className="text-gray-400">Event:</span>
              <span className="font-medium">{sessionConfig.event_ticker}</span>
              <span className="text-gray-600">|</span>
              <span className="text-gray-400">User:</span>
              <span>{sessionConfig.user_name}</span>
              <span className="text-gray-600">|</span>
              <span className="text-gray-400">Audio:</span>
              <span>{sessionConfig.audio_source}</span>
              <span className="text-gray-600">|</span>
              <span className="text-gray-400">STT:</span>
              <span>{sessionConfig.stt_provider}</span>
              {sessionConfig.dry_run && (
                <>
                  <span className="text-gray-600">|</span>
                  <span className="px-2 py-0.5 bg-yellow-800 text-yellow-200 rounded text-xs">DRY RUN</span>
                </>
              )}
            </div>
          )}

          {/* Word Grid */}
          <WordGrid words={words} />

          {/* Transcript + Log */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TranscriptPanel segments={transcript} />
            <SystemLog entries={systemLog} logRef={systemLogRef} />
          </div>
        </div>
      </div>
    );
  }

  return null;
}
