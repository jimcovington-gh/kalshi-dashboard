'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CategoryList } from './components/CategoryList';
import { NomineeList } from './components/NomineeList';
import { TranscriptLog } from './components/TranscriptLog';
import { ControlPanel } from './components/ControlPanel';
import { SessionStats } from './components/SessionStats';

// --- Types ---

interface NomineeInfo {
  name: string;
  nominee_id: string;
  ticker: string;
  soundex_code?: string;
  has_thin_market?: boolean;
}

interface CategoryInfo {
  name: string;
  category_id: string;
  state: 'idle' | 'armed' | 'identifying' | 'traded';
  winner: string | null;
  nominees: NomineeInfo[];
  pnl?: number;
}

interface SessionState {
  session_id: string;
  current_category: string | null;
  state: 'idle' | 'armed' | 'identifying' | 'traded';
  armed_at: number | null;
  categories: CategoryInfo[];
}

interface TranscriptEntry {
  text: string;
  is_final: boolean;
  provider: string;
  latency_ms: number;
  trigger_detected: boolean;
  timestamp: number;
}

interface TradeInfo {
  nominee: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  contracts_filled: number;
  cost_dollars: number;
  latency_ms: number;
  total_latency_ms: number;
  sell_placed: boolean;
}

interface ScoreUpdate {
  elapsed_ms: number;
  candidates: { name: string; soundex_match: boolean }[];
  decision: string | null;
  fired: boolean;
}

// --- Constants ---

const VOICE_TRADER_HOST = process.env.NEXT_PUBLIC_VOICE_TRADER_HOST || 'voice.apexmarkets.us';
const API_BASE = `https://${VOICE_TRADER_HOST}:9080`;
const WS_URL = `wss://${VOICE_TRADER_HOST}:9080/ws`;
const MAX_TRANSCRIPT_ENTRIES = 500;

interface AvailableSession {
  session_id: string;
  event_name: string;
  event_date: string;
  status: string;
}

// --- Page ---

export default function EventTraderPage() {
  // Connection state
  const [sessionId, setSessionId] = useState('');
  const [sessionIdInput, setSessionIdInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audio source configuration
  const [audioSourceType, setAudioSourceType] = useState<'srt_url' | 'youtube' | 'none'>('none');
  const [srtUrl, setSrtUrl] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [dryRun, setDryRun] = useState(true);

  // Audio playback
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0.8);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const audioChunkCount = useRef<number>(0);

  // Available sessions from API
  const [availableSessions, setAvailableSessions] = useState<AvailableSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);

  // Session data
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [trades, setTrades] = useState<TradeInfo[]>([]);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [matchedNominee, setMatchedNominee] = useState<string | null>(null);
  const [matchLine, setMatchLine] = useState<string | null>(null);
  const [lastScore, setLastScore] = useState<ScoreUpdate | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [autoTriggered, setAutoTriggered] = useState(false);
  const [manualTriggered, setManualTriggered] = useState(false);
  const [triggerAlertPhrase, setTriggerAlertPhrase] = useState<string | null>(null);

  // Fetch available sessions on mount
  useEffect(() => {
    async function fetchSessions() {
      try {
        const resp = await fetch(`${API_BASE}/sessions`);
        if (resp.ok) {
          const data = await resp.json();
          setAvailableSessions(data.sessions ?? []);
          // Auto-select first session if none selected
          if (data.sessions?.length > 0 && !sessionIdInput) {
            setSessionIdInput(data.sessions[0].session_id);
          }
        }
      } catch {
        // API might not be reachable yet — that's OK
      } finally {
        setLoadingSessions(false);
      }
    }
    fetchSessions();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket send helper
  const wsSend = useCallback((msg: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  // Audio playback — PCM s16le 16kHz mono
  const JITTER_BUFFER_MS = 50;

  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
        sampleRate: 16000,
      });
      audioContextRef.current = ctx;
      const gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      gainNode.gain.value = audioMuted ? 0 : audioVolume;
      gainNodeRef.current = gainNode;
    }
    return audioContextRef.current;
  }, [audioMuted, audioVolume]);

  const playAudioChunk = useCallback((arrayBuffer: ArrayBuffer) => {
    audioChunkCount.current++;
    if (audioMuted) return;
    if (arrayBuffer.byteLength < 100) return; // skip tiny/corrupt chunks
    try {
      const ctx = initAudioContext();
      if (ctx.state === 'suspended') ctx.resume();

      const int16 = new Int16Array(arrayBuffer);
      const floats = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768.0;

      const buf = ctx.createBuffer(1, floats.length, 16000);
      buf.copyToChannel(floats, 0);

      const now = ctx.currentTime;
      if (nextPlayTimeRef.current <= now) {
        nextPlayTimeRef.current = now + JITTER_BUFFER_MS / 1000;
      }

      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(gainNodeRef.current || ctx.destination);
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += floats.length / 16000;
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

  // WebSocket connection
  useEffect(() => {
    if (!sessionId) return;

    function connect() {
      setReconnecting(false);
      const socket = new WebSocket(`${WS_URL}/${sessionId}`);
      socket.binaryType = 'arraybuffer';
      ws.current = socket;

      socket.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        // Request audio streaming from worker
        socket.send(JSON.stringify({ type: 'enable_audio_stream' }));
      };

      socket.onmessage = (evt) => {
        // Binary frame = audio PCM data
        if (evt.data instanceof ArrayBuffer) {
          playAudioChunk(evt.data);
          return;
        }

        const msg = JSON.parse(evt.data);
        switch (msg.type) {
          case 'state':
            setSessionState(msg.data as SessionState);
            // Sync trigger gate flags from server state
            if ('auto_triggered' in msg.data) setAutoTriggered(msg.data.auto_triggered);
            if ('manual_triggered' in msg.data) setManualTriggered(msg.data.manual_triggered);
            break;

          case 'trigger_alert': {
            setAutoTriggered(true);
            setTriggerAlertPhrase(msg.data?.phrase ?? null);
            break;
          }

          case 'transcript': {
            const entry: TranscriptEntry = {
              ...msg.data,
              timestamp: msg.data.timestamp ?? Date.now(),
            };
            setTranscriptEntries((prev) => {
              const next = [...prev, entry];
              return next.length > MAX_TRANSCRIPT_ENTRIES
                ? next.slice(next.length - MAX_TRANSCRIPT_ENTRIES)
                : next;
            });
            break;
          }

          case 'scores': {
            const score = msg.data as ScoreUpdate;
            setLastScore(score);
            if (score.fired && score.decision) {
              setMatchedNominee(score.decision);
              setMatchLine(score.decision);
            }
            break;
          }

          case 'trade': {
            const trade = msg.data as TradeInfo;
            setTrades((prev) => [...prev, trade]);
            setLatencies((prev) => [...prev, trade.total_latency_ms]);
            break;
          }

          case 'error':
            setErrors((prev) => [...prev.slice(-19), msg.data.message as string]);
            break;

          case 'pong':
            break;

          default:
            break;
        }
      };

      socket.onclose = () => {
        setConnected(false);
        setReconnecting(true);
        reconnectTimer.current = setTimeout(connect, 2000);
      };

      socket.onerror = () => {
        socket.close();
      };
    }

    connect();

    // Ping keepalive
    const pingInterval = setInterval(() => {
      wsSend({ type: 'ping' });
    }, 15000);

    return () => {
      clearInterval(pingInterval);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
      ws.current = null;
      setConnected(false);
      setReconnecting(false);
    };
  }, [sessionId, wsSend]);

  // Commands
  const handleArm = useCallback(
    (categoryId: string) => wsSend({ type: 'arm', category: categoryId }),
    [wsSend]
  );
  const handleDisarm = useCallback(() => wsSend({ type: 'disarm' }), [wsSend]);
  const handleTrigger = useCallback(() => wsSend({ type: 'trigger' }), [wsSend]);
  const handleResetTrigger = useCallback(() => {
    setAutoTriggered(false);
    setTriggerAlertPhrase(null);
    wsSend({ type: 'reset_trigger' });
  }, [wsSend]);
  const handleFire = useCallback(
    (nomineeId: string) => wsSend({ type: 'fire', nominee: nomineeId }),
    [wsSend]
  );
  const handleConfigUpdate = useCallback(
    (config: { position_size_dollars: number }) => wsSend({ type: 'config', data: config }),
    [wsSend]
  );

  // Start session — calls POST /session/start to spawn worker, then connects WebSocket
  async function handleConnect() {
    const id = sessionIdInput.trim();
    if (!id) return;

    // Determine SRT URL
    let srt = '';
    let yt = '';
    if (audioSourceType === 'srt_url') {
      srt = srtUrl.trim();
      if (!srt) {
        setStartError('Enter an SRT URL');
        return;
      }
    } else if (audioSourceType === 'youtube') {
      yt = youtubeUrl.trim();
      if (!yt) {
        setStartError('Enter a YouTube URL');
        return;
      }
    }

    // Reset state for new session
    setTranscriptEntries([]);
    setTrades([]);
    setLatencies([]);
    setMatchedNominee(null);
    setMatchLine(null);
    setLastScore(null);
    setErrors([]);
    setSessionState(null);
    setAutoTriggered(false);
    setManualTriggered(false);
    setTriggerAlertPhrase(null);
    setStartError(null);
    setStartingSession(true);

    try {
      // First check if a session is already running
      const statusResp = await fetch(`${API_BASE}/status`);
      if (statusResp.ok) {
        const statusData = await statusResp.json();
        if (statusData.active_session?.session_id === id) {
          // Worker already running for this session — skip start, just connect WS
          setSessionId(id);
          return;
        }
        if (statusData.active_session) {
          // Different session running — stop it first
          await fetch(`${API_BASE}/session/${statusData.active_session.session_id}/stop`, { method: 'POST' });
        }
      }

      // Start the worker with audio source config
      const body: Record<string, unknown> = {
        session_id: id,
        srt_url: srt,
        youtube_url: yt,
        dry_run: dryRun,
      };

      const resp = await fetch(`${API_BASE}/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail ?? `HTTP ${resp.status}`);
      }

      // Worker started — now connect WebSocket
      setSessionId(id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStartingSession(false);
    }
  }

  async function handleDisconnect() {
    ws.current?.close();
    ws.current = null;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    // Clean up audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    nextPlayTimeRef.current = 0;
    audioChunkCount.current = 0;
    // Stop the worker on the server
    if (sessionId) {
      try {
        await fetch(`${API_BASE}/session/${sessionId}/stop`, { method: 'POST' });
      } catch { /* ignore — server might already be stopped */ }
    }
    setSessionId('');
    setConnected(false);
    setReconnecting(false);
  }

  // Derived state
  const categories = sessionState?.categories ?? [];
  const currentCategory = sessionState?.current_category ?? null;
  const armedCat = categories.find((c) => c.category_id === currentCategory);
  const armedNominees = armedCat?.nominees ?? [];

  // --- Setup screen (no session) ---
  if (!sessionId) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-8">
        <div className="max-w-md w-full bg-gray-800 rounded-xl border border-gray-700 p-8">
          <h1 className="text-2xl font-bold mb-2">🎬 Event Trader</h1>
          <p className="text-gray-400 text-sm mb-6">
            Select an event session to connect and start trading.
          </p>

          {/* Session selector */}
          <label className="block text-sm text-gray-400 mb-1">Event Session</label>
          {loadingSessions ? (
            <div className="w-full bg-gray-700 text-gray-500 rounded-lg px-4 py-2.5 border border-gray-600 mb-4 animate-pulse">
              Loading sessions...
            </div>
          ) : availableSessions.length > 0 ? (
            <select
              value={sessionIdInput}
              onChange={(e) => setSessionIdInput(e.target.value)}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-4 appearance-none cursor-pointer"
            >
              {availableSessions.map((s) => (
                <option key={s.session_id} value={s.session_id}>
                  {s.event_name} — {s.event_date} ({s.status})
                </option>
              ))}
            </select>
          ) : (
            <div className="mb-4">
              <input
                type="text"
                value={sessionIdInput}
                onChange={(e) => setSessionIdInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                placeholder="e.g. OSCARS-2026"
                className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-yellow-500 text-xs mt-1">No sessions found — enter ID manually</p>
            </div>
          )}

          {/* Audio source */}
          <label className="block text-sm text-gray-400 mb-1 mt-2">Audio Source</label>
          <div className="flex gap-2 mb-3">
            {[
              { value: 'none' as const, label: 'None (dry run)' },
              { value: 'srt_url' as const, label: 'SRT URL' },
              { value: 'youtube' as const, label: 'YouTube' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setAudioSourceType(opt.value)}
                className={`flex-1 text-sm py-2 px-3 rounded-lg border transition-colors ${
                  audioSourceType === opt.value
                    ? 'bg-emerald-900/50 border-emerald-600 text-emerald-300'
                    : 'bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {audioSourceType === 'srt_url' && (
            <div className="mb-3">
              <input
                type="text"
                value={srtUrl}
                onChange={(e) => setSrtUrl(e.target.value)}
                placeholder="srt://host:port or host:port"
                className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm font-mono"
              />
              <p className="text-gray-500 text-xs mt-1">
                SRT caller mode — connects outbound to the given URL.
                Use for satellite feeds or YouTube via ffmpeg bridge.
              </p>
            </div>
          )}

          {audioSourceType === 'youtube' && (
            <div className="mb-3">
              <input
                type="text"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm font-mono"
              />
              <p className="text-gray-500 text-xs mt-1">
                YouTube live stream — auto-launches satellite ffmpeg bridge.
                ~3s latency from HLS extraction.
              </p>
            </div>
          )}

          {/* Dry run toggle */}
          <label className="flex items-center gap-2 text-sm text-gray-400 mb-4 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-emerald-500 focus:ring-emerald-500"
            />
            Dry run (no real trades)
          </label>

          {/* Error message */}
          {startError && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 mb-3 text-sm text-red-300">
              {startError}
            </div>
          )}

          <button
            onClick={handleConnect}
            disabled={!sessionIdInput.trim() || startingSession}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
          >
            {startingSession ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Starting worker...
              </span>
            ) : (
              'Connect'
            )}
          </button>
        </div>
      </div>
    );
  }

  // --- Live session screen ---
  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 lg:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">🎬 Event Trader</h1>
          {sessionState && (
            <span className="text-gray-400 text-sm">— {sessionId}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Connection status */}
          <span className="flex items-center gap-1.5 text-sm">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                connected ? 'bg-green-400' : reconnecting ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'
              }`}
            />
            <span className="text-gray-400">
              {connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected'}
            </span>
          </span>
          <button
            onClick={handleDisconnect}
            className="text-xs text-gray-500 hover:text-red-400 border border-gray-700 rounded px-2 py-1 transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Audio player controls */}
      {(audioSourceType === 'srt_url' || audioSourceType === 'youtube') && (
        <div className="flex items-center gap-3 mb-4 bg-gray-800 rounded-lg px-4 py-2 border border-gray-700">
          <span className="text-gray-400 text-sm">🔊 Audio</span>
          <button
            onClick={() => setAudioMuted(!audioMuted)}
            className={`text-sm px-2 py-1 rounded border transition-colors ${
              audioMuted
                ? 'bg-red-900/40 border-red-700 text-red-400'
                : 'bg-gray-700 border-gray-600 text-gray-300 hover:border-gray-500'
            }`}
          >
            {audioMuted ? '🔇 Muted' : '🔊 Live'}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={audioVolume}
            onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
            className="w-24 accent-emerald-500"
          />
          <span className="text-gray-500 text-xs">{Math.round(audioVolume * 100)}%</span>
          {audioChunkCount.current > 0 && (
            <span className="text-gray-600 text-xs ml-auto">
              {audioChunkCount.current} chunks
            </span>
          )}
        </div>
      )}

      {/* Errors banner */}
      {errors.length > 0 && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-2 mb-4 text-sm text-red-300">
          {errors[errors.length - 1]}
          {errors.length > 1 && (
            <span className="text-red-500 ml-2">({errors.length} errors)</span>
          )}
        </div>
      )}

      {/* State badge */}
      {sessionState && (
        <div className="mb-4 flex items-center gap-2">
          <StateBadge state={sessionState.state} />
          {armedCat && (
            <span className="text-gray-300 text-sm">— {armedCat.name}</span>
          )}
          {lastScore && !lastScore.fired && lastScore.candidates.length > 0 && (
            <span className="text-yellow-400 text-xs ml-2">
              Candidates: {lastScore.candidates.map((c) => c.name).join(', ')} ({lastScore.elapsed_ms}ms)
            </span>
          )}
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left column: Categories */}
        <div className="lg:col-span-1 space-y-4">
          <CategoryList
            categories={categories}
            currentCategory={currentCategory}
            onArm={handleArm}
          />
          <NomineeList
            nominees={armedNominees}
            categoryName={armedCat?.name ?? null}
            matchedNominee={matchedNominee}
          />
        </div>

        {/* Right column: Transcript, controls, stats */}
        <div className="lg:col-span-2 space-y-4">
          <TranscriptLog entries={transcriptEntries} matchLine={matchLine} />
          <ControlPanel
            categories={categories}
            currentCategory={currentCategory}
            connected={connected}
            isIdentifying={sessionState?.state === 'identifying'}
            autoTriggered={autoTriggered}
            manualTriggered={manualTriggered}
            triggerAlertPhrase={triggerAlertPhrase}
            onArm={handleArm}
            onDisarm={handleDisarm}
            onTrigger={handleTrigger}
            onResetTrigger={handleResetTrigger}
            onFire={handleFire}
            onConfigUpdate={handleConfigUpdate}
          />
          <SessionStats
            categories={categories}
            trades={trades}
            latencies={latencies}
          />
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

function StateBadge({ state }: { state: SessionState['state'] }) {
  const config: Record<SessionState['state'], { icon: string; label: string; color: string }> = {
    idle: { icon: '⬚', label: 'IDLE', color: 'bg-gray-700 text-gray-300' },
    armed: { icon: '🎯', label: 'ARMED', color: 'bg-yellow-900/60 text-yellow-300 border border-yellow-700' },
    identifying: { icon: '🔍', label: 'IDENTIFYING', color: 'bg-blue-900/60 text-blue-300 border border-blue-700 animate-pulse' },
    traded: { icon: '✅', label: 'TRADED', color: 'bg-green-900/60 text-green-300 border border-green-700' },
  };
  const c = config[state];
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium px-2.5 py-1 rounded ${c.color}`}>
      {c.icon} {c.label}
    </span>
  );
}
