'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  getSignalEngineVelocity,
  VelocityMarket,
  VelocityCluster,
  ClusterResponse,
  ClusterMarketsResponse,
} from '@/lib/api';

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
  const a = Math.abs(v);
  if (v > 0) {
    // Accelerating UP — red shades
    if (a >= 10) return 'bg-red-600 text-white';
    if (a >= 5) return 'bg-red-400 text-white';
    if (a >= 3) return 'bg-orange-400 text-white';
    if (a >= 2) return 'bg-yellow-400 text-gray-900';
    if (a >= 1.5) return 'bg-yellow-200 text-gray-800';
    return 'bg-green-100 text-green-800';
  } else {
    // Accelerating DOWN — blue shades
    if (a >= 10) return 'bg-blue-700 text-white';
    if (a >= 5) return 'bg-blue-500 text-white';
    if (a >= 3) return 'bg-blue-400 text-white';
    if (a >= 2) return 'bg-cyan-400 text-gray-900';
    if (a >= 1.5) return 'bg-cyan-200 text-gray-800';
    return 'bg-green-100 text-green-800';
  }
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
  const a = Math.abs(v);
  const arrow = v > 0 ? '↑' : v < 0 ? '↓' : '';
  if (a >= 100) return `${arrow}${a.toFixed(0)}×`;
  if (a >= 10) return `${arrow}${a.toFixed(1)}×`;
  return `${arrow}${a.toFixed(2)}×`;
}

function timeAgo(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function categoryBadge(cat: string): string {
  const map: Record<string, string> = {
    politics: 'bg-purple-100 text-purple-700',
    economics: 'bg-blue-100 text-blue-700',
    entertainment: 'bg-pink-100 text-pink-700',
    elections: 'bg-indigo-100 text-indigo-700',
    social: 'bg-teal-100 text-teal-700',
  };
  return map[cat?.toLowerCase()] ?? 'bg-gray-100 text-gray-600';
}

// ── Sparkline Component ────────────────────────────────────────────────────

function Sparkline({ data, width = 120, height = 32 }: {
  data: Array<{ ts: number; price: number }>;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return <div style={{ width, height }} className="bg-gray-50 rounded" />;

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

// ── Market Detail Panel ────────────────────────────────────────────────────

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
          {market.title && (
            <p className="text-sm text-gray-600 mt-0.5">
              {market.kalshi_url ? (
                <a href={market.kalshi_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  {market.title} ↗
                </a>
              ) : market.title}
            </p>
          )}
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

// ── Cluster Drill-Down View ────────────────────────────────────────────────

function ClusterDrillDown({
  cluster,
  onBack,
}: {
  cluster: { type: 'ai'; clusterId: string } | { type: 'event'; eventTicker: string };
  onBack: () => void;
}) {
  const [markets, setMarkets] = useState<VelocityMarket[]>([]);
  const [displayName, setDisplayName] = useState<string>(
    cluster.type === 'ai' ? cluster.clusterId : cluster.eventTicker
  );
  const [description, setDescription] = useState<string>('');
  const [eventTickers, setEventTickers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts = cluster.type === 'ai'
          ? { cluster: cluster.clusterId }
          : { event: cluster.eventTicker };
        const result = await getSignalEngineVelocity(opts);
        if (!cancelled && 'markets' in result) {
          const cmr = result as ClusterMarketsResponse;
          setMarkets(cmr.markets);
          if (cmr.display_name) setDisplayName(cmr.display_name);
          if (cmr.description) setDescription(cmr.description);
          if (cmr.event_tickers) setEventTickers(cmr.event_tickers);
        }
      } catch (err) {
        console.error('Failed to load cluster markets:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cluster]);

  const selectedMarket = markets.find(m => m.market_ticker === selectedTicker) ?? null;

  if (loading) {
    return <div className="py-10 text-center text-gray-500">Loading cluster markets...</div>;
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-4 px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 flex items-center gap-1"
      >
        ← Back to clusters
      </button>
      <h2 className="text-lg font-bold text-gray-900 mb-1">
        {displayName}
        {cluster.type === 'ai' && (
          <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700">AI Cluster</span>
        )}
      </h2>
      {description && (
        <p className="text-sm text-gray-600 mb-1">{description}</p>
      )}
      <p className="text-sm text-gray-500 mb-4">
        {cluster.type === 'ai' ? (
          <>
            <span className="font-mono text-xs text-gray-400">{cluster.clusterId}</span>
            {eventTickers.length > 1 && (
              <span className="ml-2 text-xs text-gray-400">· spans {eventTickers.length} events</span>
            )}
          </>
        ) : (
          <span className="font-mono text-xs text-gray-400">{cluster.eventTicker}</span>
        )}
        <span className="mx-2">·</span>
        {markets.length} markets in this cluster
      </p>

      {selectedMarket && (
        <MarketDetail market={selectedMarket} onClose={() => setSelectedTicker(null)} />
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b text-left text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-3 py-2 w-[280px]">Market</th>
              <th className="px-2 py-2 w-[60px] text-right">Price</th>
              <th className="px-2 py-2 w-[120px]">Sparkline</th>
              <th className="px-2 py-2 w-[70px] text-right">Max Accel</th>
              <th className="px-2 py-2 text-center">Acceleration Heatmap</th>
              <th className="px-2 py-2 w-[50px] text-right">Span</th>
              <th className="px-2 py-2 w-[60px] text-right">Updated</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((market) => {
              const isSelected = selectedTicker === market.market_ticker;
              return (
                <tr
                  key={market.market_ticker}
                  onClick={() => setSelectedTicker(isSelected ? null : market.market_ticker)}
                  className={`border-b border-gray-100 cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-3 py-1.5">
                    <div className="min-w-0">
                      {market.title ? (
                        <span className="text-xs font-medium text-gray-900 truncate block max-w-[270px]" title={market.title}>
                          {market.kalshi_url ? (
                            <a href={market.kalshi_url} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline" onClick={e => e.stopPropagation()}>
                              {market.title}
                            </a>
                          ) : market.title}
                        </span>
                      ) : null}
                      <span className="font-mono text-[10px] text-gray-400 truncate block max-w-[270px]" title={market.market_ticker}>
                        {market.market_ticker}
                      </span>
                    </div>
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
                          {market.accelerations[a] != null
                            ? (Math.abs(market.accelerations[a]!) >= 10 ? (market.accelerations[a]! > 0 ? '↑!' : '↓!') : (market.accelerations[a]! > 0 ? '↑' : market.accelerations[a]! < 0 ? '↓' : '') + Math.abs(market.accelerations[a]!).toFixed(0))
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
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function SignalEnginePage() {
  const [clusters, setClusters] = useState<VelocityCluster[]>([]);
  const [totalMarkets, setTotalMarkets] = useState(0);
  const [excludedCount, setExcludedCount] = useState(0);
  const [filteredNotSurprise, setFilteredNotSurprise] = useState(0);
  const [aiClusterCount, setAiClusterCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const [sortBy, setSortBy] = useState<'accel' | 'velocity' | 'markets' | 'updated'>('accel');
  const [drillCluster, setDrillCluster] = useState<{ type: 'ai'; clusterId: string } | { type: 'event'; eventTicker: string } | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await getSignalEngineVelocity({ mode: 'all' });
      if ('clusters' in result) {
        const cr = result as ClusterResponse;
        setClusters(cr.clusters);
        setTotalMarkets(cr.total_markets);
        setExcludedCount(cr.excluded_count ?? 0);
        setFilteredNotSurprise(cr.filtered_not_surprise ?? 0);
        setAiClusterCount(cr.ai_clusters ?? 0);
        setError(null);
      }
      setLastRefresh(Date.now());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load';
      console.error('Failed to fetch cluster data:', err);
      setError(msg);
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

  const sortedClusters = React.useMemo(() => {
    const c = [...clusters];
    switch (sortBy) {
      case 'accel': return c.sort((a, b) => Math.abs(b.max_accel) - Math.abs(a.max_accel));
      case 'velocity': return c.sort((a, b) => b.max_velocity - a.max_velocity);
      case 'markets': return c.sort((a, b) => b.market_count - a.market_count);
      case 'updated': return c.sort((a, b) => b.last_update - a.last_update);
      default: return c;
    }
  }, [clusters, sortBy]);

  // Drill-down view
  if (drillCluster) {
    return (
      <div>
        <ClusterDrillDown cluster={drillCluster} onBack={() => setDrillCluster(null)} />
        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <span className="font-medium">Acceleration:</span>
          <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800">&lt;1.5× normal</span>
          <span className="font-medium ml-2">↑ Up:</span>
          <span className="px-1.5 py-0.5 rounded bg-yellow-200 text-gray-800">1.5-2×</span>
          <span className="px-1.5 py-0.5 rounded bg-orange-400 text-white">3-5×</span>
          <span className="px-1.5 py-0.5 rounded bg-red-600 text-white">&gt;10×</span>
          <span className="font-medium ml-2">↓ Down:</span>
          <span className="px-1.5 py-0.5 rounded bg-cyan-200 text-gray-800">1.5-2×</span>
          <span className="px-1.5 py-0.5 rounded bg-blue-400 text-white">3-5×</span>
          <span className="px-1.5 py-0.5 rounded bg-blue-700 text-white">&gt;10×</span>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-lg text-gray-500">Loading signal engine data...</div>
      </div>
    );
  }

  if (error && clusters.length === 0) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-semibold">Error loading velocity data</h3>
        <p className="text-red-600 text-sm mt-1">{error}</p>
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
          <h1 className="text-xl font-bold text-gray-900">⚡ Signal Engine — Cluster Velocity</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {sortedClusters.length} clusters · {totalMarkets} markets
            {aiClusterCount > 0 && <span className="text-violet-500"> · {aiClusterCount} AI-grouped</span>}
            {excludedCount > 0 && <span className="text-gray-400"> · {excludedCount} excluded</span>}
            {filteredNotSurprise > 0 && <span className="text-gray-400"> · {filteredNotSurprise} non-surprise filtered</span>}
            {lastRefresh > 0 && (
              <span className="ml-2 text-gray-400">· refreshed {timeAgo(lastRefresh / 1000)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">Sort:</span>
          {(['accel', 'velocity', 'markets', 'updated'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-2 py-1 text-xs rounded ${
                sortBy === s
                  ? 'bg-gray-800 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {s === 'accel' ? '🔥 Accel' : s === 'velocity' ? '📈 Velocity' : s === 'markets' ? '📊 Markets' : '🕐 Recent'}
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

      {/* Cluster Table */}
      {sortedClusters.length === 0 ? (
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
                <th className="px-3 py-2 w-[260px]">Cluster</th>
                <th className="px-2 py-2 w-[90px]">Category</th>
                <th className="px-2 py-2 w-[55px] text-right">Mkts</th>
                <th className="px-2 py-2 w-[60px] text-right">Avg ¢</th>
                <th className="px-2 py-2 w-[120px]">Top Market</th>
                <th className="px-2 py-2 w-[70px] text-right">Max Accel</th>
                <th className="px-2 py-2 text-center">Acceleration Heatmap</th>
                <th className="px-2 py-2 w-[60px] text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sortedClusters.map((cluster) => (
                <tr
                  key={cluster.cluster_id ?? cluster.event_ticker}
                  onClick={() =>
                    cluster.is_ai_cluster && cluster.cluster_id
                      ? setDrillCluster({ type: 'ai', clusterId: cluster.cluster_id })
                      : setDrillCluster({ type: 'event', eventTicker: cluster.event_ticker })
                  }
                  className="border-b border-gray-100 cursor-pointer transition-colors hover:bg-gray-50"
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium text-gray-900 truncate block max-w-[200px]" title={cluster.display_name || cluster.event_ticker}>
                          {cluster.display_name || cluster.event_ticker}
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-[10px] text-gray-400 truncate block max-w-[170px]">
                            {cluster.event_ticker}
                          </span>
                          {cluster.is_ai_cluster && (
                            <span className="inline-block px-1 py-0 rounded text-[9px] font-semibold bg-violet-100 text-violet-700 border border-violet-300 whitespace-nowrap" title={`AI cluster spanning ${cluster.event_tickers?.length ?? 1} events`}>
                              AI
                            </span>
                          )}
                          {cluster.leak_watch && (
                            <span className="inline-block px-1 py-0 rounded text-[9px] font-semibold bg-amber-100 text-amber-700 border border-amber-300 whitespace-nowrap" title="Non-surprise market within 48h of close (leak detection window)">
                              LEAK WATCH
                            </span>
                          )}
                        </div>
                      </div>
                      <Sparkline data={cluster.price_history} width={60} height={20} />
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${categoryBadge(cluster.category)}`}>
                      {cluster.category}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs">
                    {cluster.market_count}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs font-medium">
                    {(cluster.avg_price * 100).toFixed(0)}¢
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="font-mono text-[10px] text-gray-500 truncate block max-w-[110px]" title={cluster.top_market_ticker}>
                      {cluster.top_market_ticker}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold font-mono ${accelColor(cluster.max_accel)}`}>
                      {formatAccel(cluster.max_accel)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-0.5 justify-center">
                      {ACCEL_LABELS.map(a => (
                        <div
                          key={a}
                          className={`w-5 h-5 rounded-sm text-[9px] flex items-center justify-center font-mono ${accelColor(cluster.accelerations[a])}`}
                          title={`${a}: ${formatAccel(cluster.accelerations[a])}`}
                        >
                          {cluster.accelerations[a] != null
                            ? (Math.abs(cluster.accelerations[a]!) >= 10 ? (cluster.accelerations[a]! > 0 ? '↑!' : '↓!') : (cluster.accelerations[a]! > 0 ? '↑' : cluster.accelerations[a]! < 0 ? '↓' : '') + Math.abs(cluster.accelerations[a]!).toFixed(0))
                            : '·'}
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-400">
                    {timeAgo(cluster.last_update)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <span className="font-medium">Acceleration:</span>
        <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800">&lt;1.5× normal</span>
        <span className="font-medium ml-2">↑ Up:</span>
        <span className="px-1.5 py-0.5 rounded bg-yellow-200 text-gray-800">1.5-2×</span>
        <span className="px-1.5 py-0.5 rounded bg-orange-400 text-white">3-5×</span>
        <span className="px-1.5 py-0.5 rounded bg-red-600 text-white">&gt;10×</span>
        <span className="font-medium ml-2">↓ Down:</span>
        <span className="px-1.5 py-0.5 rounded bg-cyan-200 text-gray-800">1.5-2×</span>
        <span className="px-1.5 py-0.5 rounded bg-blue-400 text-white">3-5×</span>
        <span className="px-1.5 py-0.5 rounded bg-blue-700 text-white">&gt;10×</span>
      </div>
    </div>
  );
}
