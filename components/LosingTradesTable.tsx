'use client';

import { SettledTrade } from '@/lib/api';
import { format } from 'date-fns';

interface LosingTradesTableProps {
  trades: SettledTrade[];
  totalLoss: number;
  isLoading: boolean;
  userName?: string;
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '-';
  return format(new Date(timestamp * 1000), 'MMM dd HH:mm');
}

function buildKalshiUrl(ticker: string): string {
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

export default function LosingTradesTable({
  trades,
  totalLoss,
  isLoading,
  userName
}: LosingTradesTableProps) {
  if (isLoading) {
    return (
      <div className="h-32 flex items-center justify-center bg-white rounded-lg shadow">
        <div className="text-gray-500">Loading losing trades...</div>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="bg-green-50 rounded-lg shadow p-6 text-center">
        <div className="text-green-600 font-medium">🎉 No losing trades in this period!</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      {/* Header with total loss */}
      <div className="px-4 py-3 bg-red-50 border-b border-red-100 flex justify-between items-center">
        <div>
          <span className="font-medium text-red-800">Losing Trades</span>
          <span className="text-red-600 text-sm ml-2">({trades.length} trades)</span>
        </div>
        <div className="text-red-700 font-bold">
          Total Loss: {formatCurrency(totalLoss)}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Settled</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Market</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Idea</th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Side</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Qty</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Loss</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {trades.map((trade) => {
              const kalshiUrl = buildKalshiUrl(trade.market_ticker);
              const tradeUrl = userName ? `/dashboard/trade/${trade.order_id}?user=${userName}` : `/dashboard/trade/${trade.order_id}`;
              
              return (
                <tr key={trade.order_id} className="hover:bg-red-50">
                  <td className="px-3 py-2 text-sm whitespace-nowrap">
                    <a href={tradeUrl} className="text-blue-600 hover:underline">
                      {formatDate(trade.settlement_time)}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-sm font-mono text-xs max-w-[200px] truncate" title={trade.market_ticker}>
                    <a href={kalshiUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                      {trade.market_ticker}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-500">{trade.category}</td>
                  <td className="px-3 py-2 text-sm text-gray-500">{trade.idea_name || '-'}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      trade.side === 'yes' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                    }`}>
                      {trade.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-sm text-right text-gray-900">{trade.count}</td>
                  <td className="px-3 py-2 text-sm text-right text-gray-900">${trade.purchase_price.toFixed(2)}</td>
                  <td className="px-3 py-2 text-sm text-right font-medium text-red-600">
                    {formatCurrency(trade.profit)}
                  </td>
                  <td className="px-3 py-2 text-sm text-right text-gray-500">
                    {formatDuration(trade.duration_hours)}
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
