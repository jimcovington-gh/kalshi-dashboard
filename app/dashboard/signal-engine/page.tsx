'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getSignalEngineVelocity, VelocityMarket, VelocityResponse } from '@/lib/api';

// ── Constants ──────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 30_000; // 30s

const WINDOW_LABELS = [
  '5m', '15m', '30m', '1h', '1.5h', '2h', '2.5h',
  '3h', '4h', '5h', '6h', '8h', '12h', '18h', '24h',
];

const ACCEL_LABELS = [
  '5m_vs_1h', '15m_vs_2h', '30m_vs_3h',
  '1h_vs_6h', '1.5h_vs_8h', '2h_vs_12h',
  '3h_vs_18h', '4h_vs_24h', '6h_vs_24h',
];

// ── Helpers ────────────────────────────────────────────────────────────────

function accelColor(v: number | null): string {
  if (v === null || v === undefined) return 'bg-gray-100 text-gray-400';
  if (v >= 10) return 'bg-red-600 text-white';
  if (v >= 5) return 'bg-red-400 text-white';
  if (v >= 3) return 'bg-orange-400 text-white';
  if (v >= 2) return 'bg-yellow-400 text-gray-900';
  if (v >= 1.5) return 'bg-yellow-200 text-gray-800';
  return 'bg-green-100 text-green-800';
}

function velocityColor(v: number | null): string {
  if (v === null || v === undefined) return 'text-gray-400';
  const abs = Math.abs(v);
  if (abs >= 0.5) return v > 0 ? 'text-red-600 font-bold' : 'text-blue-600 font-bold';
  if (abs >= 0.1) return v > 0 ? 'text-red-500' : 'text-blue-500';
  if (abs >= 0.02) return v > 0 ? 'text-orange-500' : 'text-cyan-500';
  return 'text-gray-500';
}

function formatVelocity(v: number | null): string {
  if (v === null || v === undefined) return '—';
  if (Math.abs(v) < 0.001) return '0';
  const sign = v > 0 ? '+' : '';
  if (Math.abs(v) >= 1) return `${sign}${v.toFixed(1)}`;
  if (Math.abs(v) >= 0.01) return `${sign}${v.toFixed(3)}`;
  return `${sign}${v.toFixed(4)}`;
}

function formatAccel(v: number | null): string {
  if (v === null || v === undefined) return '—';
  if (v >= 100) return `${v.toFixed(0)}×`;
  if (v >= 10) return `${v.toFixed(1)}×`;
  return `${v.toFixed(2)}×`;
}

function timeAgo(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ── Sparkline Component ────────────────────────────────────────────────────

function Sparkline({ data, width = 120, height = 32 }: {
  data: Array<{ ts: number; price: number }>;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return <div className="w-[120px] h-[32px] bg-gray-50 rounded" />;

  const prices = data.map(d => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 0.01;
  const pad = 2;

  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * (width - 2 * pad);
    const y = height - pad - ((d.price - min) / range) * (height - 2 * pad);
    return `${x},${y}`;
  }).join(' ');

  const lastPrice = prices[prices.length - 1];
  const firstPrice = prices[0];
  const color = lastPrice >= firstPrice ? '#22c55e' : '#ef4444';

  return (
    <svg width={width} height={height} className="inline-block">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Detail Panel ───────────────────────────────────────────────────────────

function MarketDetail({ market, onClose }: { market: VelocityMarket; onClose: () => void }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-5 mb-6 relative">
      <button 
        onClick={onClose}
        className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 text-xl leading-none"
      >
        ×
      </button>
      
      <div className="flex items-start gap-6 mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900 font-mono">{market.market_ticker}</h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-2xl font-bold">{(market.current_price * 100).toFixed(1)}¢</span>
            <span className="text-sm text-gray-500">
              {market.snapshot_count} snapshots · {market.data_span_hours.toFixed(1)}h span
            </span>
            <span className="text-sm text-gray-400">Updated {timeAgo(market.last_update)}</span>
          </div>
        </div>
        <div className="ml-auto">
          <Sparkline data={market.price_history} width={200} height={48} />
        </div>
      </div>

      {/* Velocity Grid */}
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Velocity (price change / hour)</h3>
        <div className="grid grid-cols-5 gap-1.5">
          {WINDOW_LABELS.map(w => (
            <div key={w} className="text-center">
              <div className="text-[10px] text-gray-500 mb-0.5">{w}</div>
              <div className={`text-xs font-mono px-1 py-0.5 rounded ${velocityColor(market.velocities[w])}`}>
                {formatVelocity(market.velocities[w])}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Acceleration Grid */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Acceleration (short÷long velocity ratio)</h3>
        <div className="grid grid-cols-3 gap-1.5">
          {ACCEL_LABELS.map(a => {
            const [short, long] = a.split('_vs_');
            return (
              <div key={a} className={`text-center px-2 py-1.5 rounded ${accelColor(market.accelerations[a])}`}>
                <div className="text-[10px] opacity-75">{short} ÷ {long}</div>
                <div className="text-sm font-bold font-mono">
                  {formatAccel(market.accelerations[a])}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function SignalEnginePage() {
  const [data, setData] = useState<VelocityResponse | null>(null);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const [sortBy, setSortBy] = useState<'accel' | 'velocity' | 'price' | 'updated'>('accel');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await getSignalEngineVelocity({ mode: 'all' });
      if ('markets' in result) {
        setData(result);
        setError(null);
      }
      setLastRefresh(Date.now());
    } catch (err: any) {
      console.error('Failed to fetch velocity data:', err);
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, REFRESH_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData]);

  const sortedMarkets = React.useMemo(() => {
    if (!data?.markets) return [];
    const m = [...data.markets];
    switch (sortBy) {
      case 'accel': return m.sort((a, b) => b.max_accel - a.max_accel);
      case 'velocity': return m.sort((a, b) => b.max_velocity - a.max_velocity);
      case 'price': return m.sort((a, b) => b.current_price - a.current_price);
      case 'updated': return m.sort((a, b) => b.last_update - a.last_update);
      default: return m;
    }
  }, [data, sortBy]);

  const selectedMarket = React.useMemo(() => {
    if (!selectedTicker || !data?.markets) return null;
    return data.markets.find(m => m.market_ticker === selectedTicker) ?? null;
  }, [selectedTicker, data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-lg text-gray-500">Loading signal engine data...</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-semibold">Error loading velocity data</h3>
        <p className="text-red-600 text-sm mt-1">{error}</p>
        <p className="text-gray-500 text-xs mt-2">
          The signal engine pipeline may not be deployed yet. Deploy with <code className="bg-gray-100 px-1 rounded">sam build && sam deploy</code> from kalshi-market-capture/.
        </p>
        <button onClick={fetchData} className="mt-3 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">⚡ Signal Engine — Velocity Monitor</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Tracking {data?.total_tracked ?? 0} markets · 
            15 time windows · 9 acceleration pairs
            {lastRefresh > 0 && (
              <span className="ml-2 text-gray-400">· refreshed {timeAgo(lastRefresh / 1000)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">Sort:</span>
          {(['accel', 'velocity', 'price', 'updated'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-2 py-1 text-xs rounded ${
                sortBy === s
                  ? 'bg-gray-800 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {s === 'accel' ? '🔥 Accel' : s === 'velocity' ? '📈 Velocity' : s === 'price' ? '💰 Price' : '🕐 Recent'}
            </button>
          ))}
          <button
            onClick={fetchData}
            className="ml-2 px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-2 mb-4 text-sm text-yellow-700">
          Last refresh failed: {error}. Showing stale data.
        </div>
      )}

      {/* Detail Panel (expanded market) */}
      {selectedMarket && (
        <MarketDetail market={selectedMarket} onClose={() => setSelectedTicker(null)} />
      )}

      {/* Market Table */}
      {sortedMarkets.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-500 text-lg">No velocity data yet</p>
          <p className="text-gray-400 text-sm mt-2">
            The signal engine processor Lambda needs to be deployed and receive trade data from S3.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2 w-[200px]">Market</th>
                <th className="px-2 py-2 w-[60px] text-right">Price</th>
                <th className="px-2 py-2 w-[120px]">Sparkline</th>
                <th className="px-2 py-2 w-[70px] text-right">Max Accel</th>
                <th className="px-2 py-2 text-center">Acceleration Heatmap</th>
                <th className="px-2 py-2 w-[50px] text-right">Span</th>
                <th className="px-2 py-2 w-[60px] text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sortedMarkets.map((market) => {
                const isSelected = selectedTicker === market.market_ticker;
                return (
                  <tr
                    key={market.market_ticker}
                    onClick={() => setSelectedTicker(isSelected ? null : market.market_ticker)}
                    className={`border-b border-gray-100 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-blue-50'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs font-medium text-gray-900 truncate block max-w-[190px]" title={market.market_ticker}>
                        {market.market_ticker}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs font-medium">
                      {(market.current_price * 100).toFixed(0)}¢
                    </td>
                    <td className="px-2 py-1.5">
                      <Sparkline data={market.price_history} width={100} height={24} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold font-mono ${accelColor(market.max_accel)}`}>
                        {formatAccel(market.max_accel)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-0.5 justify-center">
                        {ACCEL_LABELS.map(a => (
                          <div
                            key={a}
                            className={`w-5 h-5 rounded-sm text-[9px] flex items-center justify-center font-mono ${accelColor(market.accelerations[a])}`}
                            title={`${a}: ${formatAccel(market.accelerations[a])}`}
                          >
                            {market.accelerations[a] !== null && market.accelerations[a] !== undefined
                              ? (market.accelerations[a]! >= 10 ? '!' : market.accelerations[a]!.toFixed(0))
                              : '·'}
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right text-xs text-gray-500">
                      {market.data_span_hours.toFixed(0)}h
                    </td>
                    <td className="px-2 py-1.5 text-right text-xs text-gray-400">
                      {timeAgo(market.last_update)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="mt-4 flex items-center gap-4 text-xs text-gray-500">
        <span className="font-medium">Acceleration scale:</span>
        <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800">&lt;1.5× normal</span>
        <span className="px-1.5 py-0.5 rounded bg-yellow-200 text-gray-800">1.5-2× warming</span>
        <span className="px-1.5 py-0.5 rounded bg-yellow-400 text-gray-900">2-3× elevated</span>
        <span className="px-1.5 py-0.5 rounded bg-orange-400 text-white">3-5× hot</span>
        <span className="px-1.5 py-0.5 rounded bg-red-400 text-white">5-10× alert</span>
        <span className="px-1.5 py-0.5 rounded bg-red-600 text-white">&gt;10× extreme</span>
      </div>
    </div>
  );
}
