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
const WS_URL = `wss://${VOICE_TRADER_HOST}:9080/ws`;
const MAX_TRANSCRIPT_ENTRIES = 500;

// --- Page ---

export default function EventTraderPage() {
  // Connection state
  const [sessionId, setSessionId] = useState('');
  const [sessionIdInput, setSessionIdInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Session data
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [trades, setTrades] = useState<TradeInfo[]>([]);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [matchedNominee, setMatchedNominee] = useState<string | null>(null);
  const [matchLine, setMatchLine] = useState<string | null>(null);
  const [lastScore, setLastScore] = useState<ScoreUpdate | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // WebSocket send helper
  const wsSend = useCallback((msg: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  // WebSocket connection
  useEffect(() => {
    if (!sessionId) return;

    function connect() {
      setReconnecting(false);
      const socket = new WebSocket(`${WS_URL}/${sessionId}`);
      ws.current = socket;

      socket.onopen = () => {
        setConnected(true);
        setReconnecting(false);
      };

      socket.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        switch (msg.type) {
          case 'state':
            setSessionState(msg.data as SessionState);
            break;

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
  const handleFire = useCallback(
    (nomineeId: string) => wsSend({ type: 'fire', nominee: nomineeId }),
    [wsSend]
  );
  const handleConfigUpdate = useCallback(
    (config: { position_size_dollars: number }) => wsSend({ type: 'config', data: config }),
    [wsSend]
  );

  // Start session
  function handleConnect() {
    const id = sessionIdInput.trim();
    if (!id) return;
    // Reset state for new session
    setTranscriptEntries([]);
    setTrades([]);
    setLatencies([]);
    setMatchedNominee(null);
    setMatchLine(null);
    setLastScore(null);
    setErrors([]);
    setSessionState(null);
    setSessionId(id);
  }

  function handleDisconnect() {
    ws.current?.close();
    ws.current = null;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
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
            Connect to a live event trading session to monitor and control trades in real time.
          </p>

          <label className="block text-sm text-gray-400 mb-1">Session ID</label>
          <input
            type="text"
            value={sessionIdInput}
            onChange={(e) => setSessionIdInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            placeholder="e.g. oscars-2026"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-4"
          />

          <button
            onClick={handleConnect}
            disabled={!sessionIdInput.trim()}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
          >
            Connect
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
            onArm={handleArm}
            onDisarm={handleDisarm}
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
