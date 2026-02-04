'use client';

import { useState, useMemo } from 'react';
import { SettledTrade, GroupedStats, SettlementSummary } from '@/lib/api';
import { format } from 'date-fns';

// Grouped trade row (aggregated by settlement minute, market, side, idea, duration bucket, purchase price)
interface GroupedTradeRow {
  key: string;
  settlement_minute: number; // Unix timestamp rounded to minute
  market_ticker: string;
  side: 'yes' | 'no';
  idea_name: string;
  duration_bucket: number; // Duration rounded to 0.1h
  purchase_price: number; // Buy $ - grouped by this value
  total_qty: number;
  won: boolean; // All trades in group should have same result
  total_profit: number;
  trade_count: number; // Number of individual trades in this group
}

interface SettlementsTableProps {
  trades: SettledTrade[];
  summary: SettlementSummary;
  grouped?: {
    byCategory?: Record<string, GroupedStats>;
    byIdea?: Record<string, GroupedStats>;
    byPriceBucket?: Record<string, GroupedStats>;
  };
  groupBy: 'idea' | 'category' | 'price_bucket' | '';
  onGroupByChange: (groupBy: 'idea' | 'category' | 'price_bucket' | '') => void;
  isLoading: boolean;
  userName?: string;
  // Pagination
  totalTrades: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '-';
  // timestamp is in seconds
  return format(new Date(timestamp * 1000), 'MMM dd HH:mm');
}

// Build Kalshi market URL from ticker
function buildKalshiUrl(ticker: string): string {
  // Extract event ticker (everything before the last hyphen segment that's the market variant)
  // e.g., KXNBAMENTION-26JAN25DENMEM-MVP -> event is KXNBAMENTION-26JAN25DENMEM
  // Simpler approach: link to search page with ticker
  return `https://kalshi.com/markets?search=${encodeURIComponent(ticker)}`;
}

function formatDuration(hours: number): string {
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  } else if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  } else {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours.toFixed(0)}h`;
  }
}

// Group trades by settlement minute, market, side, idea, duration bucket, and purchase price
function groupTrades(trades: SettledTrade[]): GroupedTradeRow[] {
  const groups = new Map<string, GroupedTradeRow>();
  
  for (const trade of trades) {
    // Round settlement time to minute (60 seconds)
    const settlementMinute = Math.floor(trade.settlement_time / 60) * 60;
    // Round duration to 0.1h
    const durationBucket = Math.round(trade.duration_hours * 10) / 10;
    // Round purchase price to cents (2 decimal places)
    const purchasePrice = Math.round(trade.purchase_price * 100) / 100;
    
    const key = `${settlementMinute}|${trade.market_ticker}|${trade.side}|${trade.idea_name || ''}|${durationBucket}|${purchasePrice}`;
    
    const existing = groups.get(key);
    if (existing) {
      existing.total_qty += trade.count;
      existing.total_profit += trade.profit;
      existing.trade_count += 1;
    } else {
      groups.set(key, {
        key,
        settlement_minute: settlementMinute,
        market_ticker: trade.market_ticker,
        side: trade.side,
        idea_name: trade.idea_name || '-',
        duration_bucket: durationBucket,
        purchase_price: purchasePrice,
        total_qty: trade.count,
        won: trade.won,
        total_profit: trade.profit,
        trade_count: 1,
      });
    }
  }
  
  // Sort by settlement time descending (most recent first)
  return Array.from(groups.values()).sort((a, b) => b.settlement_minute - a.settlement_minute);
}

export default function SettlementsTable({
  trades,
  summary,
  grouped,
  groupBy,
  onGroupByChange,
  isLoading,
  userName,
  totalTrades,
  page,
  pageSize,
  totalPages,
  onPageChange
}: SettlementsTableProps) {
  const [showDetails, setShowDetails] = useState(false);
  
  // Memoize grouped trades
  const groupedTrades = useMemo(() => groupTrades(trades), [trades]);

  // Summary card
  const SummaryCards = () => (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div className="bg-white rounded-lg shadow p-4">
        <div className="text-sm text-gray-500">Total Profit</div>
        <div className={`text-2xl font-bold ${summary.total_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          {formatCurrency(summary.total_profit)}
        </div>
      </div>
      <div className="bg-white rounded-lg shadow p-4">
        <div className="text-sm text-gray-500">Win Rate</div>
        <div className="text-2xl font-bold text-gray-900">
          {summary.win_rate.toFixed(1)}%
        </div>
      </div>
      <div className="bg-white rounded-lg shadow p-4">
        <div className="text-sm text-gray-500">Wins / Losses</div>
        <div className="text-2xl font-bold">
          <span className="text-green-600">{summary.wins}</span>
          {' / '}
          <span className="text-red-600">{summary.losses}</span>
        </div>
      </div>
      <div className="bg-white rounded-lg shadow p-4">
        <div className="text-sm text-gray-500">Return %</div>
        <div className={`text-2xl font-bold ${summary.total_cost > 0 ? (summary.total_profit / summary.total_cost * 100) >= 0 ? 'text-green-600' : 'text-red-600' : 'text-gray-900'}`}>
          {summary.total_cost > 0 ? `${(summary.total_profit / summary.total_cost * 100).toFixed(1)}%` : '-'}
        </div>
      </div>
    </div>
  );

  // Grouped stats table
  const GroupedTable = () => {
    if (!grouped) return null;
    
    // Get the right grouped data based on groupBy selection
    const groupedData = groupBy === 'category' ? grouped.byCategory :
                        groupBy === 'idea' ? grouped.byIdea :
                        groupBy === 'price_bucket' ? grouped.byPriceBucket : null;
    
    if (!groupedData) return null;
    
    const sortedGroups = Object.entries(groupedData)
      .sort((a, b) => b[1].profit - a[1].profit);

    // Helper to format final bid comparison breakdown
    const formatBidBreakdown = (above: number | undefined, equal: number | undefined, below: number | undefined) => {
      if (above === undefined) return '-';
      return (
        <span className="text-xs">
          <span className="text-green-600" title="Above entry">↑{above}</span>
          {' / '}
          <span className="text-gray-500" title="Equal to entry">={equal || 0}</span>
          {' / '}
          <span className="text-red-600" title="Below entry">↓{below || 0}</span>
        </span>
      );
    };

    return (
      <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">
            By {groupBy === 'price_bucket' ? 'Purchase Price' : groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {groupBy === 'price_bucket' ? 'Price Range' : groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}
                </th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Trades</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Win Rate</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Profit</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider" title="Average Entry Price">Avg Entry</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider" title="Average Final Bid Price">Avg Final Bid</th>
                <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider" title="Trades: Above/Equal/Below Entry">Bid vs Entry</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider" title="% of contracts where final bid < $0.90">% &lt;$0.90</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider" title="Win rate for contracts where final bid < $0.90">WR &lt;$0.90</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider" title="Average Duration (hours)">Avg Dur (h)</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {sortedGroups.map(([key, stats]) => (
                <tr key={key} className="hover:bg-gray-50">
                  <td className="px-3 py-3 text-sm font-medium text-gray-900">{key}</td>
                  <td className="px-3 py-3 text-sm text-right text-gray-500">
                    {stats.trades}
                    <span className="text-xs ml-1">
                      (<span className="text-green-600">{stats.wins}</span>/<span className="text-red-600">{stats.losses}</span>)
                    </span>
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-900">{stats.win_rate.toFixed(1)}%</td>
                  <td className={`px-3 py-3 text-sm text-right font-medium ${stats.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(stats.profit)}
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-900">
                    {stats.avg_entry_price !== undefined ? `$${stats.avg_entry_price.toFixed(3)}` : '-'}
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-900">
                    {stats.avg_final_bid !== undefined && stats.avg_final_bid !== null ? `$${stats.avg_final_bid.toFixed(3)}` : '-'}
                  </td>
                  <td className="px-3 py-3 text-sm text-center">
                    {formatBidBreakdown(stats.contracts_above_entry, stats.contracts_equal_entry, stats.contracts_below_entry)}
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-900">
                    {stats.pct_final_bid_below_90 !== undefined && stats.pct_final_bid_below_90 !== null ? `${stats.pct_final_bid_below_90.toFixed(1)}%` : '-'}
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-900">
                    {stats.win_rate_final_bid_below_90 !== undefined && stats.win_rate_final_bid_below_90 !== null ? `${stats.win_rate_final_bid_below_90.toFixed(1)}%` : '-'}
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-500">
                    {stats.avg_duration_hours !== undefined ? stats.avg_duration_hours.toFixed(2) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // Grouped trades table (aggregated by settlement minute, market, side, idea, duration, buy price)
  const TradesTable = () => (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
        <h3 className="text-lg font-medium text-gray-900">Recent Settled Trades</h3>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">
            {groupedTrades.length} groups from {trades.length} trades
          </span>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            {showDetails ? 'Hide Details' : 'Show Details'}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Settled</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Market</th>
              {showDetails && (
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Idea</th>
              )}
              <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Side</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Qty</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Buy $</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Result</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Profit</th>
              {showDetails && (
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {groupedTrades.slice(0, 100).map((row) => {
              const kalshiUrl = buildKalshiUrl(row.market_ticker);
              const tradeUrl = `/dashboard/trades?ticker=${encodeURIComponent(row.market_ticker)}${userName ? `&user_name=${encodeURIComponent(userName)}` : ''}`;
              
              return (
              <tr key={row.key} className={`hover:bg-gray-50 ${row.won ? '' : 'bg-red-50'}`}>
                <td className="px-3 py-2 text-sm whitespace-nowrap">
                  <a href={tradeUrl} className="text-blue-600 hover:underline">
                    {formatDate(row.settlement_minute)}
                  </a>
                </td>
                <td className="px-3 py-2 text-sm font-mono text-xs max-w-[200px] truncate" title={row.market_ticker}>
                  <a href={kalshiUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                    {row.market_ticker}
                  </a>
                </td>
                {showDetails && (
                  <td className="px-3 py-2 text-sm text-gray-500">{row.idea_name}</td>
                )}
                <td className="px-3 py-2 text-center">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    row.side === 'yes' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {row.side.toUpperCase()}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm text-right text-gray-900">
                  {row.total_qty}
                  {row.trade_count > 1 && (
                    <span className="text-xs text-gray-400 ml-1">({row.trade_count})</span>
                  )}
                </td>
                <td className="px-3 py-2 text-sm text-right text-gray-900">${row.purchase_price.toFixed(2)}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    row.won ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {row.won ? 'WIN' : 'LOSS'}
                  </span>
                </td>
                <td className={`px-3 py-2 text-sm text-right font-medium ${row.total_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(row.total_profit)}
                </td>
                {showDetails && (
                  <td className="px-3 py-2 text-sm text-right text-gray-500">
                    {row.duration_bucket.toFixed(1)}h
                  </td>
                )}
              </tr>
            );
            })}
          </tbody>
        </table>
      </div>
      {groupedTrades.length > 100 && (
        <div className="px-4 py-3 bg-gray-50 text-sm text-gray-500 flex justify-between items-center">
          <span>Showing first 100 of {groupedTrades.length} groups</span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onPageChange(page - 1)}
                disabled={page <= 1}
                className="px-3 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <span className="text-sm">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => onPageChange(page + 1)}
                disabled={page >= totalPages}
                className="px-3 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <div className="h-48 flex items-center justify-center bg-white rounded-lg shadow">
        <div className="text-gray-500">Loading settlement data...</div>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
        No settled trades found for this period
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Group By Selector */}
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium text-gray-700">Group by:</span>
        <div className="flex rounded-md shadow-sm" role="group">
          {[
            { value: '', label: 'None' },
            { value: 'category', label: 'Category' },
            { value: 'idea', label: 'Idea' },
            { value: 'price_bucket', label: 'Price' }
          ].map((option, idx, arr) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onGroupByChange(option.value as any)}
              className={`px-3 py-1.5 text-sm font-medium border ${
                groupBy === option.value
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              } ${idx === 0 ? 'rounded-l-lg' : ''} ${
                idx === arr.length - 1 ? 'rounded-r-lg' : ''
              } -ml-px first:ml-0`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <SummaryCards />
      
      {grouped && <GroupedTable />}
      
      <TradesTable />
    </div>
  );
}
