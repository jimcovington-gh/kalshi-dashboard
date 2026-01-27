'use client';

import { useState } from 'react';
import { SettledTrade, GroupedStats, SettlementSummary } from '@/lib/api';
import { format } from 'date-fns';

interface SettlementsTableProps {
  trades: SettledTrade[];
  summary: SettlementSummary;
  grouped?: Record<string, GroupedStats>;
  groupBy: 'idea' | 'category' | 'price_bucket' | '';
  onGroupByChange: (groupBy: 'idea' | 'category' | 'price_bucket' | '') => void;
  isLoading: boolean;
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

export default function SettlementsTable({
  trades,
  summary,
  grouped,
  groupBy,
  onGroupByChange,
  isLoading
}: SettlementsTableProps) {
  const [showDetails, setShowDetails] = useState(false);

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
        <div className="text-sm text-gray-500">Total Invested</div>
        <div className="text-2xl font-bold text-gray-900">
          ${summary.total_cost.toFixed(2)}
        </div>
      </div>
    </div>
  );

  // Grouped stats table
  const GroupedTable = () => {
    if (!grouped) return null;
    
    const sortedGroups = Object.entries(grouped)
      .sort((a, b) => b[1].profit - a[1].profit);

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
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {groupBy === 'price_bucket' ? 'Price Range' : groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Trades</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Win Rate</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Profit</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {sortedGroups.map(([key, stats]) => (
                <tr key={key} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{key}</td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">
                    {stats.trades}
                    <span className="text-xs ml-1">
                      (<span className="text-green-600">{stats.wins}</span>/<span className="text-red-600">{stats.losses}</span>)
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-900">{stats.win_rate.toFixed(1)}%</td>
                  <td className={`px-4 py-3 text-sm text-right font-medium ${stats.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(stats.profit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // Individual trades table
  const TradesTable = () => (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
        <h3 className="text-lg font-medium text-gray-900">Recent Settled Trades</h3>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          {showDetails ? 'Hide Details' : 'Show Details'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Settled</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Market</th>
              {showDetails && (
                <>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Idea</th>
                </>
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
            {trades.slice(0, 100).map((trade) => (
              <tr key={trade.order_id} className={`hover:bg-gray-50 ${trade.won ? '' : 'bg-red-50'}`}>
                <td className="px-3 py-2 text-sm text-gray-500 whitespace-nowrap">
                  {formatDate(trade.settlement_time)}
                </td>
                <td className="px-3 py-2 text-sm text-gray-900 font-mono text-xs max-w-[200px] truncate" title={trade.market_ticker}>
                  {trade.market_ticker}
                </td>
                {showDetails && (
                  <>
                    <td className="px-3 py-2 text-sm text-gray-500">{trade.category}</td>
                    <td className="px-3 py-2 text-sm text-gray-500">{trade.idea_name || '-'}</td>
                  </>
                )}
                <td className="px-3 py-2 text-center">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    trade.side === 'yes' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {trade.side.toUpperCase()}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm text-right text-gray-900">{trade.count}</td>
                <td className="px-3 py-2 text-sm text-right text-gray-900">${trade.purchase_price.toFixed(2)}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    trade.won ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {trade.won ? 'WIN' : 'LOSS'}
                  </span>
                </td>
                <td className={`px-3 py-2 text-sm text-right font-medium ${trade.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(trade.profit)}
                </td>
                {showDetails && (
                  <td className="px-3 py-2 text-sm text-right text-gray-500">
                    {formatDuration(trade.duration_hours)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {trades.length > 100 && (
        <div className="px-4 py-3 bg-gray-50 text-sm text-gray-500 text-center">
          Showing 100 of {trades.length} trades
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
