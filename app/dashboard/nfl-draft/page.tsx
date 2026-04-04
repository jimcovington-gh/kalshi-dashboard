'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

// --- Types ---

interface Prospect {
  name: string;
  suffix: string;
  position: string;
  drafted: boolean;
  drafted_at_pick: number;
  drafted_by_team: string;
}

interface BetOpportunity {
  ticker: string;
  side: 'yes' | 'no';
  player_name: string;
  market_description: string;
  series_type: string;
  contracts: number;
  total_cost: number;
  total_payout: number;
  projected_profit: number;
  avg_price: number;
  assigned_user: string;
}

interface OrderResult {
  ticker: string;
  side: string;
  action: string;
  success: boolean;
  order_id: string;
  contracts_filled: number;
  fill_cost_dollars: number;
  fees_dollars: number;
  error_code: string;
  error_message: string;
  assigned_user: string;
}

interface PickFireResult {
  pick_number: number;
  player_name: string;
  team: string;
  position: string;
  bets_attempted: number;
  buy_results: OrderResult[];
  sell_results: OrderResult[];
  total_cost: number;
  total_potential_profit: number;
  total_latency_ms: number;
}

interface DraftPick {
  pick_number: number;
  team: string;
  state: 'upcoming' | 'on_clock' | 'armed' | 'identifying' | 'firing' | 'traded' | 'skipped';
  selected_player: string;
}

interface TranscriptEntry {
  text: string;
  is_final: boolean;
  timestamp: number;
  source: string;
  speaker?: string;
}

interface AudioStats {
  rms: number;
  rms_db: number;
  peak: number;
  peak_db: number;
  clipping: boolean;
  clip_samples: number;
  silence: boolean;
  chunks: number;
  receiving: boolean;
  mumble_connected: boolean;
  queue_size: number;
  transcripts_final: number;
  transcripts_partial: number;
}

interface PlayerPrice {
  name: string;
  position: string;
  suffix: string;
  best_yes_bid: number;
}

interface SessionStatus {
  session_id: string;
  status: string;
  current_pick: number;
  pick_state: string;
  pick_team: string;
  active_prospects: number;
  total_prospects: number;
  picks_completed: number;
  position_counts: Record<string, number>;
  testing_mode: string;
  wallet_limit: number | null;
  users: string[];
  user_budgets: Record<string, number>;
  orderbook_cache?: {
    connected: boolean;
    subscribed_tickers: number;
    cached_books: number;
    fresh_books: number;
    updates_received: number;
    reconnect_count: number;
    last_update_at: number;
  };
}

// --- Constants ---

const VOICE_TRADER_HOST = process.env.NEXT_PUBLIC_VOICE_TRADER_HOST || 'voice.apexmarkets.us';
const API_BASE = `https://${VOICE_TRADER_HOST}:9180`;
const WS_URL = `wss://${VOICE_TRADER_HOST}:9180/ws`;
const MAX_TRANSCRIPT_ENTRIES = 300;

const PICK_STATE_COLORS: Record<string, string> = {
  upcoming: 'bg-gray-200 text-gray-700',
  on_clock: 'bg-yellow-200 text-yellow-800',
  armed: 'bg-orange-200 text-orange-800',
  identifying: 'bg-purple-200 text-purple-800 animate-pulse',
  firing: 'bg-red-200 text-red-800 animate-pulse',
  traded: 'bg-green-200 text-green-800',
  skipped: 'bg-gray-300 text-gray-500',
};

const MODE_LABELS: Record<string, string> = {
  live: '⚠️ LIVE',
  dry_run: '🧪 DRY RUN',
  low_value: '💵 $1 BETS',
  low_wallet: '💰 LOW WALLET',
};

const MODE_COLORS: Record<string, string> = {
  live: 'bg-red-100 text-red-800 border-red-300',
  dry_run: 'bg-blue-100 text-blue-800 border-blue-300',
  low_value: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  low_wallet: 'bg-purple-100 text-purple-800 border-purple-300',
};

// All 32 NFL teams sorted alphabetically by city
const NFL_TEAMS = [
  { abbr: 'ARI', label: 'Arizona Cardinals' },
  { abbr: 'ATL', label: 'Atlanta Falcons' },
  { abbr: 'BAL', label: 'Baltimore Ravens' },
  { abbr: 'BUF', label: 'Buffalo Bills' },
  { abbr: 'CAR', label: 'Carolina Panthers' },
  { abbr: 'CHI', label: 'Chicago Bears' },
  { abbr: 'CIN', label: 'Cincinnati Bengals' },
  { abbr: 'CLE', label: 'Cleveland Browns' },
  { abbr: 'DAL', label: 'Dallas Cowboys' },
  { abbr: 'DEN', label: 'Denver Broncos' },
  { abbr: 'DET', label: 'Detroit Lions' },
  { abbr: 'GB', label: 'Green Bay Packers' },
  { abbr: 'HOU', label: 'Houston Texans' },
  { abbr: 'IND', label: 'Indianapolis Colts' },
  { abbr: 'JAX', label: 'Jacksonville Jaguars' },
  { abbr: 'KC', label: 'Kansas City Chiefs' },
  { abbr: 'LAC', label: 'Los Angeles Chargers' },
  { abbr: 'LAR', label: 'Los Angeles Rams' },
  { abbr: 'LV', label: 'Las Vegas Raiders' },
  { abbr: 'MIA', label: 'Miami Dolphins' },
  { abbr: 'MIN', label: 'Minnesota Vikings' },
  { abbr: 'NE', label: 'New England Patriots' },
  { abbr: 'NO', label: 'New Orleans Saints' },
  { abbr: 'NYG', label: 'New York Giants' },
  { abbr: 'NYJ', label: 'New York Jets' },
  { abbr: 'PHI', label: 'Philadelphia Eagles' },
  { abbr: 'PIT', label: 'Pittsburgh Steelers' },
  { abbr: 'SEA', label: 'Seattle Seahawks' },
  { abbr: 'SF', label: 'San Francisco 49ers' },
  { abbr: 'TB', label: 'Tampa Bay Buccaneers' },
  { abbr: 'TEN', label: 'Tennessee Titans' },
  { abbr: 'WAS', label: 'Washington Commanders' },
];

// --- Page ---

export default function NFLDraftPage() {
  // Connection
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Session data
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [rankedBets, setRankedBets] = useState<BetOpportunity[]>([]);
  const [fireResults, setFireResults] = useState<PickFireResult[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [audioStats, setAudioStats] = useState<AudioStats | null>(null);
  const [playerPrices, setPlayerPrices] = useState<PlayerPrice[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [matchAlert, setMatchAlert] = useState<string | null>(null);

  // Controls
  const [manualPlayerInput, setManualPlayerInput] = useState('');
  const [teamOverrideInput, setTeamOverrideInput] = useState('');

  // Double-click tracking for player tiles
  const lastTileClick = useRef<{ name: string; time: number }>({ name: '', time: 0 });
  const [pendingTile, setPendingTile] = useState<string | null>(null);
  const pendingTileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [transcriptInjectInput, setTranscriptInjectInput] = useState('');
  const [selectedMode, setSelectedMode] = useState('dry_run');
  const [walletLimitInput, setWalletLimitInput] = useState('100');
  const [bridgeRestarting, setBridgeRestarting] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Tick every second for live staleness display
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // Computed
  const currentPick = picks.find(p => p.pick_number === (status?.current_pick ?? 0));
  const totalPnL = fireResults.reduce((sum, r) =>
    sum + r.buy_results.reduce((s, b) => s + (b.success ? b.contracts_filled * 1.0 - b.fill_cost_dollars : 0), 0), 0);
  const totalCost = fireResults.reduce((sum, r) =>
    sum + r.buy_results.reduce((s, b) => s + (b.success ? b.fill_cost_dollars + b.fees_dollars : 0), 0), 0);
  const lastRound = fireResults.length > 0 ? fireResults[fireResults.length - 1] : null;
  const lastRoundPnL = lastRound
    ? lastRound.buy_results.reduce((s, b) => s + (b.success ? b.contracts_filled * 1.0 - b.fill_cost_dollars : 0), 0)
    : 0;

  // Per-user profit breakdown
  const userPnL = fireResults.reduce<Record<string, { maxProfit: number; cost: number }>>((acc, r) => {
    for (const b of r.buy_results) {
      if (b.success && b.assigned_user) {
        if (!acc[b.assigned_user]) acc[b.assigned_user] = { maxProfit: 0, cost: 0 };
        acc[b.assigned_user].maxProfit += b.contracts_filled * 1.0 - b.fill_cost_dollars;
        acc[b.assigned_user].cost += b.fill_cost_dollars + b.fees_dollars;
      }
    }
    return acc;
  }, {});

  // WS send helper
  const wsSend = useCallback((msg: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  // WebSocket connection
  useEffect(() => {
    function connect() {
      setReconnecting(false);
      const socket = new WebSocket(`${WS_URL}`);
      ws.current = socket;

      socket.onopen = () => {
        setConnected(true);
        setReconnecting(false);
      };

      socket.onmessage = (evt) => {
        if (evt.data instanceof ArrayBuffer) return;
        const msg = JSON.parse(evt.data);

        switch (msg.type) {
          case 'status':
            setStatus(msg.data as SessionStatus);
            setInitializing(false);
            break;

          case 'picks':
            setPicks(msg.data as DraftPick[]);
            break;

          case 'prospects':
            setProspects(msg.data as Prospect[]);
            break;

          case 'ranked_bets':
            setRankedBets(msg.data as BetOpportunity[]);
            break;

          case 'player_prices':
            setPlayerPrices(msg.data as PlayerPrice[]);
            break;

          case 'fire_result':
            setFireResults(prev => [...prev, msg.data as PickFireResult]);
            break;

          case 'match':
            setMatchAlert(msg.data.player_name);
            setTimeout(() => setMatchAlert(null), 5000);
            break;

          case 'transcript': {
            const entry = msg.data as TranscriptEntry;
            setTranscripts(prev => {
              // Skip duplicate partials (same text as last entry)
              if (prev.length > 0 && prev[prev.length - 1].text === entry.text) return prev;
              const next = [...prev, entry];
              return next.length > MAX_TRANSCRIPT_ENTRIES
                ? next.slice(next.length - MAX_TRANSCRIPT_ENTRIES)
                : next;
            });
            break;
          }

          case 'audio_stats':
            setAudioStats(msg.data as AudioStats);
            break;

          case 'diagnostic':
            // Show engine diagnostics inline in the transcript feed
            setTranscripts(prev => {
              const next = [...prev, {
                text: msg.data.message,
                is_final: true,
                timestamp: Date.now() / 1000,
                source: 'engine',
              }];
              return next.length > MAX_TRANSCRIPT_ENTRIES
                ? next.slice(next.length - MAX_TRANSCRIPT_ENTRIES)
                : next;
            });
            break;

          case 'error':
            setErrors(prev => [...prev.slice(-19), msg.data.message as string]);
            setInitializing(false);
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

      socket.onerror = () => { socket.close(); };
    }

    connect();

    const pingInterval = setInterval(() => { wsSend({ type: 'ping' }); }, 15000);

    return () => {
      clearInterval(pingInterval);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
      ws.current = null;
      setConnected(false);
    };
  }, [wsSend]);

  // Auto-scroll transcript (container only, not the whole page)
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcripts]);

  // --- Actions ---

  const handleArm = () => wsSend({ type: 'arm' });
  const handleDisarm = () => wsSend({ type: 'disarm' });
  const handleSkip = () => wsSend({ type: 'skip' });
  const handleReset = () => {
    wsSend({ type: 'reset' });
    setFireResults([]);
    setRankedBets([]);
  };

  const handleManualFire = () => {
    if (manualPlayerInput.trim()) {
      wsSend({ type: 'manual_fire', player_name: manualPlayerInput.trim() });
      setManualPlayerInput('');
    }
  };

  const handleTileClick = (playerName: string) => {
    const now = Date.now();
    const last = lastTileClick.current;
    if (last.name === playerName && now - last.time <= 1000) {
      // Double-click confirmed — fire
      wsSend({ type: 'manual_fire', player_name: playerName });
      lastTileClick.current = { name: '', time: 0 };
      setPendingTile(null);
      if (pendingTileTimer.current) clearTimeout(pendingTileTimer.current);
    } else {
      // First click — mark pending
      lastTileClick.current = { name: playerName, time: now };
      setPendingTile(playerName);
      if (pendingTileTimer.current) clearTimeout(pendingTileTimer.current);
      pendingTileTimer.current = setTimeout(() => setPendingTile(null), 1000);
    }
  };

  const handleRefreshPrices = () => {
    wsSend({ type: 'fetch_player_prices' });
  };

  const handleRefreshOrderbooks = () => {
    wsSend({ type: 'refresh_orderbooks' });
  };

  const handleInitialize = () => {
    setInitializing(true);
    wsSend({
      type: 'initialize',
      testing_mode: selectedMode,
      wallet_limit: selectedMode === 'low_wallet' ? parseFloat(walletLimitInput) || 100 : undefined,
    });
  };
  const handleAdvancePick = (n: number) => wsSend({ type: 'advance', pick_number: n });
  const handleRemoveProspect = (name: string) => wsSend({ type: 'remove', player_name: name });

  const handleInjectTranscript = () => {
    if (transcriptInjectInput.trim()) {
      wsSend({ type: 'transcript', text: transcriptInjectInput.trim(), is_final: true, source: 'manual' });
      setTranscriptInjectInput('');
    }
  };

  const handleBridgeRestart = async () => {
    setBridgeRestarting(true);
    try {
      const resp = await fetch(`${API_BASE}/bridge/restart`, { method: 'POST' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: 'Unknown error' }));
        setErrors(prev => [...prev.slice(-19), `Bridge restart failed: ${data.detail || resp.statusText}`]);
      }
    } catch (e) {
      setErrors(prev => [...prev.slice(-19), `Bridge restart failed: ${e}`]);
    } finally {
      setTimeout(() => setBridgeRestarting(false), 3000);
    }
  };

  // Audio level bar helper — maps dBFS to 0-100%
  const dbToPercent = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

  // --- Render ---

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">🏈 NFL Draft Trader</h1>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${connected ? 'bg-green-100 text-green-800' : reconnecting ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}`}>
            {connected ? 'CONNECTED' : reconnecting ? 'RECONNECTING...' : 'DISCONNECTED'}
          </span>
          {status && (
            <span className="text-sm text-gray-500">
              {status.active_prospects}/{status.total_prospects} players &middot; {status.picks_completed} picks traded
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold text-gray-700">
            Spent: <span className="text-gray-900">${totalCost.toFixed(2)}</span>
            {' · '}
            Max Profit: <span className={totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}>${totalPnL.toFixed(2)}</span>
            {Object.entries(userPnL).map(([user, stats]) => (
              <span key={user} className="ml-1 text-[11px]">
                ({user}: <span className={stats.maxProfit >= 0 ? 'text-green-600' : 'text-red-600'}>${stats.maxProfit.toFixed(2)}</span>)
              </span>
            ))}
            {lastRound && (
              <>
                {' · '}
                Last ({lastRound.player_name}): <span className={lastRoundPnL >= 0 ? 'text-green-600' : 'text-red-600'}>${lastRoundPnL.toFixed(2)}</span>
              </>
            )}
          </span>
          {status?.testing_mode && (
            <span className={`px-2 py-0.5 rounded text-xs font-bold border ${MODE_COLORS[status.testing_mode] || 'bg-gray-100'}`}>
              {MODE_LABELS[status.testing_mode] || status.testing_mode.toUpperCase()}
              {status.testing_mode === 'low_wallet' && status.wallet_limit != null && ` ($${status.wallet_limit})`}
            </span>
          )}
          {!status && (
            <div className="flex items-center gap-2">
              <select
                value={selectedMode}
                onChange={e => setSelectedMode(e.target.value)}
                className="px-2 py-1.5 border rounded text-sm bg-white"
              >
                <option value="dry_run">🧪 Dry Run</option>
                <option value="low_value">💵 $1 Bets</option>
                <option value="low_wallet">💰 Low Wallet</option>
                <option value="live">⚠️ LIVE</option>
              </select>
              {selectedMode === 'low_wallet' && (
                <input
                  type="number"
                  value={walletLimitInput}
                  onChange={e => setWalletLimitInput(e.target.value)}
                  className="w-20 px-2 py-1.5 border rounded text-sm"
                  placeholder="$100"
                  min={1}
                />
              )}
              <button onClick={handleInitialize}
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait"
                disabled={initializing}>
                {initializing ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    Initializing…
                  </span>
                ) : 'Initialize Session'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Match Alert Flash */}
      {matchAlert && (
        <div className="mb-4 p-3 bg-green-600 text-white rounded-lg text-center text-lg font-bold animate-pulse">
          🎯 MATCHED: {matchAlert} — FIRING ORDERS
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* Far Left Column: Prospect Pool */}
        <div className="col-span-2 space-y-4">
          {/* Prospect Pool */}
          <div className="bg-white rounded-lg shadow p-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
              Prospects ({prospects.filter(p => !p.drafted).length})
            </h2>
            <div className="max-h-[calc(100vh-180px)] overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-400 border-b sticky top-0 bg-white">
                    <th className="pb-1 pr-1">Player</th>
                    <th className="pb-1 pr-1">Pos</th>
                    <th className="pb-1 w-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {prospects.map(p => (
                    <tr key={p.suffix} className={`border-b border-gray-50 ${p.drafted ? 'opacity-40' : ''}`}>
                      <td className="py-0.5 pr-1 truncate max-w-[100px]" title={p.name}>
                        {p.drafted ? (
                          <span className="text-gray-400">#{p.drafted_at_pick} {p.name}</span>
                        ) : (
                          p.name
                        )}
                      </td>
                      <td className="py-0.5 pr-1 font-medium text-gray-500">{p.position}</td>
                      <td className="py-0.5 text-center">
                        {!p.drafted && (
                          <button
                            onClick={() => handleRemoveProspect(p.name)}
                            className="text-gray-300 hover:text-red-500 text-xs leading-none"
                            title={`Remove ${p.name}`}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Left Column: Current Pick + Controls */}
        <div className="col-span-3 space-y-4">

          {/* Current Pick Card */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Current Pick</h2>
            {currentPick ? (
              <div>
                <div className="text-4xl font-bold text-gray-900">#{currentPick.pick_number}</div>
                <div className="text-xl font-semibold text-gray-700 mt-1">{currentPick.team}</div>
                <div className={`inline-block mt-2 px-2 py-0.5 rounded text-xs font-medium ${PICK_STATE_COLORS[currentPick.state] || 'bg-gray-200'}`}>
                  {currentPick.state.toUpperCase()}
                </div>
                {currentPick.selected_player && (
                  <div className="mt-2 text-sm text-green-700 font-medium">
                    ✅ {currentPick.selected_player}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-gray-400 text-sm">No pick active</div>
            )}
          </div>

          {/* Controls */}
          <div className="bg-white rounded-lg shadow p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-1">Controls</h2>

            <div className="flex gap-2">
              <button onClick={handleArm}
                className="flex-1 px-3 py-2 bg-orange-500 text-white rounded font-medium text-sm hover:bg-orange-600 disabled:opacity-50"
                disabled={!connected || currentPick?.state === 'armed'}>
                🎯 ARM
              </button>
              <button onClick={handleDisarm}
                className="flex-1 px-3 py-2 bg-gray-500 text-white rounded font-medium text-sm hover:bg-gray-600 disabled:opacity-50"
                disabled={!connected}>
                DISARM
              </button>
              <button onClick={handleSkip}
                className="flex-1 px-3 py-2 bg-gray-400 text-white rounded font-medium text-sm hover:bg-gray-500 disabled:opacity-50"
                disabled={!connected}>
                SKIP
              </button>
              <button onClick={handleReset}
                className="flex-1 px-3 py-2 bg-blue-500 text-white rounded font-medium text-sm hover:bg-blue-600 disabled:opacity-50"
                disabled={!connected}>
                ↺ RESET
              </button>
            </div>

            {/* Per-User Budgets */}
            {status?.users && status.user_budgets && (
              <div>
                <label className="text-xs text-gray-500 font-medium">Budget per bet (per user)</label>
                <div className="flex gap-2 mt-1">
                  {status.users.map(user => (
                    <div key={user} className="flex-1">
                      <label className="text-[10px] text-gray-400 block">{user}</label>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-400">$</span>
                        <input
                          type="number"
                          defaultValue={status.user_budgets[user] ?? 100}
                          onBlur={e => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val) && val > 0) {
                              wsSend({ type: 'update_budget', user_name: user, budget: val });
                            }
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              const val = parseFloat((e.target as HTMLInputElement).value);
                              if (!isNaN(val) && val > 0) {
                                wsSend({ type: 'update_budget', user_name: user, budget: val });
                              }
                            }
                          }}
                          className="w-full px-2 py-1 border rounded text-sm font-mono"
                          min={1}
                          step={10}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Manual Fire — Player Tiles */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-500 font-medium">Manual Fire (double-click)</label>
                <button
                  onClick={handleRefreshPrices}
                  disabled={!connected}
                  className="text-[10px] text-blue-600 hover:text-blue-800 disabled:opacity-40"
                >
                  ↻ Refresh
                </button>
              </div>
              {playerPrices.length > 0 ? (
                <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
                  {playerPrices.map(pp => (
                    <button
                      key={pp.suffix}
                      onClick={() => handleTileClick(pp.name)}
                      disabled={!connected}
                      className={`text-left px-2 py-1.5 rounded border text-xs transition-all select-none
                        ${pendingTile === pp.name
                          ? 'bg-red-100 border-red-400 ring-2 ring-red-300 animate-pulse'
                          : 'bg-gray-50 border-gray-200 hover:bg-gray-100 hover:border-gray-300'}
                        disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      <div className="font-semibold text-gray-800 truncate">{pp.name}</div>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-gray-400">{pp.position}</span>
                        <span className="font-mono font-bold text-green-700">${pp.best_yes_bid.toFixed(2)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-gray-400 text-[10px] text-center py-2">
                  No player prices — click Refresh or advance pick
                </div>
              )}
              {/* Fallback dropdown for unlisted players */}
              <details className="mt-2">
                <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">
                  Unlisted player...
                </summary>
                <div className="flex gap-1 mt-1">
                  <select
                    value={manualPlayerInput}
                    onChange={e => setManualPlayerInput(e.target.value)}
                    className="flex-1 px-2 py-1.5 border rounded text-sm bg-white"
                  >
                    <option value="">Select player...</option>
                    {prospects.filter(p => !p.drafted).map(p => (
                      <option key={p.suffix} value={p.name}>
                        {p.name} ({p.position})
                      </option>
                    ))}
                  </select>
                  <button onClick={handleManualFire}
                    className="px-3 py-1.5 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                    disabled={!connected || !manualPlayerInput}>
                    🔥 FIRE
                  </button>
                </div>
              </details>
            </div>

            {/* Team Override */}
            <div>
              <label className="text-xs text-gray-500 font-medium">Team Override (trade)</label>
              <div className="flex gap-1 mt-1">
                <select
                  value={teamOverrideInput}
                  onChange={e => {
                    setTeamOverrideInput(e.target.value);
                    if (e.target.value && status?.current_pick) {
                      wsSend({ type: 'update_team', pick_number: status.current_pick, team: e.target.value });
                    }
                  }}
                  className="flex-1 px-2 py-1.5 border rounded text-sm bg-white"
                >
                  <option value="">Select team...</option>
                  {NFL_TEAMS.map(t => (
                    <option key={t.abbr} value={t.abbr}>
                      {t.abbr} — {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Position Counts */}
          {status?.position_counts && Object.keys(status.position_counts).length > 0 && (
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Positions Drafted</h2>
              <div className="grid grid-cols-4 gap-1 text-xs">
                {Object.entries(status.position_counts).sort((a, b) => b[1] - a[1]).map(([pos, count]) => (
                  <div key={pos} className="text-center bg-gray-50 rounded p-1">
                    <div className="font-bold text-gray-700">{pos}</div>
                    <div className="text-gray-500">{count}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Errors */}
          {errors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <h2 className="text-xs font-semibold text-red-600 uppercase mb-1">Errors</h2>
              <div className="space-y-1 max-h-32 overflow-y-auto text-xs text-red-700 font-mono">
                {errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            </div>
          )}
        </div>

        {/* Center + Right Column: Pick Tracker + Audio + Ranked Bets */}
        <div className="col-span-7 space-y-4">

          {/* Pick Tracker Strip */}
          <div className="bg-white rounded-lg shadow p-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Pick Tracker</h2>
            <div className="flex flex-wrap gap-1.5">
              {picks.map(pick => (
                <button
                  key={pick.pick_number}
                  onClick={() => handleAdvancePick(pick.pick_number)}
                  title={`#${pick.pick_number} ${pick.team}${pick.selected_player ? ` — ${pick.selected_player}` : ''}`}
                  className={`w-8 h-8 rounded text-xs font-bold flex items-center justify-center cursor-pointer
                    ${pick.pick_number === status?.current_pick ? 'ring-2 ring-blue-500' : ''}
                    ${PICK_STATE_COLORS[pick.state] || 'bg-gray-100 text-gray-600'}
                    hover:opacity-80 transition-opacity`}
                >
                  {pick.pick_number}
                </button>
              ))}
            </div>
          </div>

          {/* Ranked Bets Table */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
              Top Bets {rankedBets.length > 0 && `(${rankedBets.length})`}
            </h2>
            {rankedBets.length > 0 ? (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="pb-1 pr-2">#</th>
                    <th className="pb-1 pr-2">Ticker</th>
                    <th className="pb-1 pr-2">Market</th>
                    <th className="pb-1 pr-2">Side</th>
                    <th className="pb-1 pr-2 text-right">Qty</th>
                    <th className="pb-1 pr-2 text-right">Avg $</th>
                    <th className="pb-1 pr-2 text-right">Cost</th>
                    <th className="pb-1 text-right">Profit</th>
                    <th className="pb-1 text-right">User</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedBets.map((bet, i) => (
                    <tr key={bet.ticker} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-1 pr-2 font-mono text-gray-400">{i + 1}</td>
                      <td className="py-1 pr-2 font-mono text-[10px]">
                        <a
                          href={`https://kalshi.com/markets/${bet.ticker.split('-')[0].toLowerCase()}/_/${bet.ticker.slice(0, bet.ticker.lastIndexOf('-')).toLowerCase()}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 underline"
                        >
                          {bet.ticker}
                        </a>
                      </td>
                      <td className="py-1 pr-2 truncate max-w-[200px]" title={bet.market_description}>
                        {bet.market_description}
                      </td>
                      <td className="py-1 pr-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${bet.side === 'yes' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {bet.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{bet.contracts}</td>
                      <td className="py-1 pr-2 text-right font-mono">${bet.avg_price.toFixed(2)}</td>
                      <td className="py-1 pr-2 text-right font-mono">${bet.total_cost.toFixed(2)}</td>
                      <td className="py-1 text-right font-mono font-bold text-green-600">
                        ${bet.projected_profit.toFixed(2)}
                      </td>
                      <td className="py-1 pl-2 text-right">
                        <span className="inline-block px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold text-[10px]">
                          {bet.assigned_user}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-gray-400 text-sm py-4 text-center">
                Bets will appear when a pick is being processed
              </div>
            )}
          </div>

          {/* Fire Results */}
          {fireResults.length > 0 && (
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Trade History</h2>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {fireResults.slice().reverse().map((result, i) => (
                  <div key={i} className="border border-gray-100 rounded p-2 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-gray-800">
                        Pick #{result.pick_number} — {result.player_name}{result.position ? ` (${result.position})` : ''}{result.team ? ` → ${result.team}` : ''}
                      </span>
                      <span className="text-gray-500">
                        {result.bets_attempted} bets &middot; {result.total_latency_ms.toFixed(0)}ms
                      </span>
                    </div>
                    <div className="flex gap-4 mt-1 text-gray-600">
                      <span>
                        Buys: {result.buy_results.filter(r => r.success).length}/{result.buy_results.length} filled
                      </span>
                      <span>
                        Cost: ${result.buy_results.reduce((s, r) => s + r.fill_cost_dollars, 0).toFixed(2)}
                      </span>
                      <span className="text-green-600 font-medium">
                        Sells: {result.sell_results.filter(r => r.success).length} placed
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Audio / Mumble Bridge Panel */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-500 uppercase">Mumble Bridge</h2>
              <button
                onClick={handleBridgeRestart}
                disabled={bridgeRestarting}
                className="px-2 py-1 text-[10px] font-medium rounded bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
              >
                {bridgeRestarting ? '⏳ Restarting...' : '🔄 Restart Bridge'}
              </button>
            </div>

            {/* Connection Status */}
            <div className="flex items-center gap-4 mb-3 text-xs">
              <div className="flex items-center gap-1.5">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${audioStats?.mumble_connected ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className={audioStats?.mumble_connected ? 'text-green-700 font-medium' : 'text-red-600 font-medium'}>
                  {audioStats?.mumble_connected ? 'Mumble Connected' : 'Mumble Disconnected'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${audioStats ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className={audioStats ? 'text-green-700 font-medium' : 'text-red-600 font-medium'}>
                  {audioStats ? 'Bridge Active' : 'Bridge Offline'}
                </span>
              </div>
              {audioStats?.receiving && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-green-700 font-medium">Audio Receiving</span>
                </div>
              )}
            </div>

            {audioStats ? (
              <div className="space-y-2">
                {/* Level Meter */}
                <div>
                  <div className="flex items-center justify-between text-[10px] text-gray-400 mb-0.5">
                    <span>RMS {audioStats.rms_db.toFixed(0)} dBFS</span>
                    <span>Peak {audioStats.peak_db.toFixed(0)} dBFS</span>
                  </div>
                  <div className="relative h-4 bg-gray-100 rounded overflow-hidden">
                    <div
                      className={`absolute inset-y-0 left-0 rounded transition-all duration-200 ${audioStats.clipping ? 'bg-red-500' : audioStats.silence ? 'bg-gray-300' : 'bg-green-500'}`}
                      style={{ width: `${dbToPercent(audioStats.rms_db)}%` }}
                    />
                    <div
                      className="absolute inset-y-0 w-0.5 bg-yellow-500 transition-all duration-100"
                      style={{ left: `${dbToPercent(audioStats.peak_db)}%` }}
                    />
                  </div>
                </div>

                {/* Status indicators */}
                <div className="flex items-center gap-3 text-[10px]">
                  {audioStats.clipping && (
                    <span className="text-red-600 font-bold animate-pulse">⚠ CLIPPING ({audioStats.clip_samples})</span>
                  )}
                  {audioStats.silence && !audioStats.clipping && (
                    <span className="text-gray-400">Silence</span>
                  )}
                  {!audioStats.silence && !audioStats.clipping && audioStats.receiving && (
                    <span className="text-green-600">Good Signal</span>
                  )}
                  <span className="text-gray-400">
                    Queue: {audioStats.queue_size} | Finals: {audioStats.transcripts_final} | Partials: {audioStats.transcripts_partial}
                  </span>
                </div>
              </div>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-700">
                <p className="font-medium">Bridge is not sending data.</p>
                <p className="text-red-500 mt-1">Check that the mumble-bridge service is running on EC2 and that a Mumble client is connected to the server.</p>
              </div>
            )}
          </div>

          {/* Orderbook Cache Status */}
          {status?.orderbook_cache && (
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-500 uppercase">Orderbook Cache</h2>
                <button
                  onClick={handleRefreshOrderbooks}
                  disabled={!connected}
                  className="px-2 py-1 text-[10px] font-medium rounded bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50"
                >
                  📡 Refresh Books
                </button>
              </div>
              <div className="flex items-center gap-4 mb-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${status.orderbook_cache.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className={status.orderbook_cache.connected ? 'text-green-700 font-medium' : 'text-red-600 font-medium'}>
                    {status.orderbook_cache.connected ? 'TIS Connected' : 'TIS Disconnected'}
                  </span>
                </div>
                <span className="text-gray-400">
                  {status.orderbook_cache.cached_books}/{status.orderbook_cache.subscribed_tickers} books
                  {' '}({status.orderbook_cache.fresh_books} fresh)
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span className="text-gray-500">
                  Updates: {status.orderbook_cache.updates_received}
                </span>
                {status.orderbook_cache.reconnect_count > 0 && (
                  <span className="text-yellow-600">
                    Reconnects: {status.orderbook_cache.reconnect_count}
                  </span>
                )}
                <span className={`font-mono ${
                  status.orderbook_cache.last_update_at > 0
                    ? (now / 1000 - status.orderbook_cache.last_update_at < 30 ? 'text-green-600' : 'text-yellow-600')
                    : 'text-red-500'
                }`}>
                  {status.orderbook_cache.last_update_at > 0
                    ? `${Math.round(now / 1000 - status.orderbook_cache.last_update_at)}s ago`
                    : 'No data yet'}
                </span>
              </div>
            </div>
          )}

          {/* Transcript Feed */}
          <div className="bg-gray-900 rounded-lg shadow p-4 text-green-400 font-mono text-xs">
            <h2 className="text-gray-500 uppercase font-semibold text-[10px] mb-2 font-sans">
              Live Transcript
            </h2>
            <div ref={transcriptContainerRef} className="h-48 overflow-y-auto space-y-0.5">
              {transcripts.length === 0 ? (
                <div className="text-gray-600">Waiting for audio...</div>
              ) : (
                transcripts.map((t, i) => (
                  <div key={i} className={
                    t.source === 'engine'
                      ? 'text-yellow-400 italic'
                      : t.is_final ? 'text-green-300' : 'text-green-600'
                  }>
                    {t.source !== 'engine' && (
                      <span className="text-gray-600 mr-1">[{t.source}{t.speaker ? `:${t.speaker}` : ''}]</span>
                    )}
                    {t.text}
                  </div>
                ))
              )}

            </div>
            {/* Inject transcript */}
            <div className="flex gap-1 mt-2 pt-2 border-t border-gray-700">
              <input
                type="text"
                value={transcriptInjectInput}
                onChange={e => setTranscriptInjectInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleInjectTranscript()}
                placeholder="Inject test transcript..."
                className="flex-1 px-2 py-1 bg-gray-800 text-green-300 rounded text-xs border border-gray-700 placeholder-gray-600 focus:outline-none focus:border-green-600"
              />
              <button
                onClick={handleInjectTranscript}
                disabled={!connected || !transcriptInjectInput.trim()}
                className="px-2 py-1 bg-green-700 text-green-100 rounded text-xs font-medium hover:bg-green-600 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
