'use client';

import React, { useMemo } from 'react';

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

interface CategoryInfo {
  name: string;
  category_id: string;
  state: 'idle' | 'armed' | 'identifying' | 'traded';
  winner: string | null;
  nominees: { name: string; nominee_id: string; ticker: string; soundex_code?: string; has_thin_market?: boolean }[];
  pnl?: number;
}

interface SessionStatsProps {
  categories: CategoryInfo[];
  trades: TradeInfo[];
  latencies: number[];
}

export const SessionStats = React.memo(function SessionStats({ categories, trades, latencies }: SessionStatsProps) {
  const { totalCategories, tradedCategories, totalPnl } = useMemo(() => ({
    totalCategories: categories.length,
    tradedCategories: categories.filter((c) => c.state === 'traded').length,
    totalPnl: categories.reduce((sum, c) => sum + (c.pnl ?? 0), 0),
  }), [categories]);

  const { avgLatency, totalCost, filledTrades } = useMemo(() => ({
    avgLatency: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    totalCost: trades.reduce((sum, t) => sum + Math.abs(t.cost_dollars), 0),
    filledTrades: trades.filter((t) => t.contracts_filled > 0).length,
  }), [trades, latencies]);

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Session Stats
      </h2>
      <div className="flex flex-wrap gap-6 text-sm">
        <Stat label="Categories" value={`${tradedCategories}/${totalCategories} traded`} />
        <Stat
          label="P&L"
          value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toLocaleString()}`}
          color={totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}
        />
        <Stat
          label="Avg Latency"
          value={latencies.length > 0 ? `${avgLatency}ms` : '—'}
        />
        <Stat label="Trades" value={`${filledTrades} filled / ${trades.length} sent`} />
        <Stat label="Deployed" value={`$${totalCost.toLocaleString()}`} />
      </div>
    </div>
  );
});

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-gray-500 text-xs">{label}</div>
      <div className={`font-medium ${color ?? 'text-white'}`}>{value}</div>
    </div>
  );
}
