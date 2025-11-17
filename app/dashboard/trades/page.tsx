'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { getTrades, Trade } from '@/lib/api';
import { format } from 'date-fns';

export default function TradesPage() {
  const searchParams = useSearchParams();
  const tickerParam = searchParams.get('ticker');
  
  const [ticker, setTicker] = useState(tickerParam || '');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  // Auto-search if ticker is in URL params
  useEffect(() => {
    if (tickerParam) {
      setTicker(tickerParam);
      performSearch(tickerParam);
    }
  }, [tickerParam]);

  async function performSearch(searchTicker: string) {
    if (!searchTicker.trim()) return;

    setIsLoading(true);
    setError('');
    setSearched(true);

    try {
      const data = await getTrades(searchTicker.toUpperCase().trim());
      setTrades(data.trades);
    } catch (err: any) {
      setError(err.message || 'Failed to load trades');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    performSearch(ticker);
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Trade History</h2>
        
        <form onSubmit={handleSearch} className="flex gap-4">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="Enter market ticker (e.g., KXHIGHAUS-25NOV16-B88.5)"
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {searched && trades.length === 0 && !isLoading && (
        <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
          No trades found for this ticker
        </div>
      )}

      {trades.map((trade, idx) => (
        <div
          key={idx}
          className={`bg-white rounded-lg shadow overflow-hidden border-l-4 ${
            trade.success ? 'border-green-500' : 'border-red-500'
          }`}
        >
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Trade #{idx + 1}</h3>
              <p className="text-sm text-gray-600">
                {format(new Date(trade.initiated_at), 'PPpp')}
              </p>
            </div>
            <span
              className={`px-3 py-1 rounded-full text-sm font-semibold ${
                trade.success
                  ? 'bg-green-100 text-green-800'
                  : 'bg-red-100 text-red-800'
              }`}
            >
              {trade.success ? '✅ Success' : '❌ Failed'}
            </span>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Side</div>
                <div className="text-lg font-semibold text-gray-900">{trade.side.toUpperCase()}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Contracts</div>
                <div className="text-lg font-semibold text-gray-900">{trade.filled_count || 0}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">
                  {trade.success ? 'Fill Price' : 'Target Price'}
                </div>
                <div className="text-lg font-semibold text-gray-900">
                  ${(trade.avg_fill_price || 0).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Total Cost</div>
                <div className="text-lg font-semibold text-gray-900">
                  ${((trade.filled_count || 0) * (trade.avg_fill_price || 0)).toFixed(2)}
                </div>
              </div>
            </div>

            {!trade.success && trade.error_message && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
                <strong>Error:</strong> {trade.error_message}
              </div>
            )}

            {trade.orderbook_snapshot && (
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Order Book Snapshot</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <OrderBookSide
                    title="YES Bids"
                    color="green"
                    levels={trade.orderbook_snapshot.yes_bids || []}
                  />
                  <OrderBookSide
                    title="NO Bids"
                    color="blue"
                    levels={(trade.orderbook_snapshot.no_bids || []).slice(0, 10)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function OrderBookSide({
  title,
  color,
  levels,
}: {
  title: string;
  color: string;
  levels: Array<{ price: number; quantity: number }>;
}) {
  const bgColor = color === 'green' ? 'bg-green-50' : 'bg-blue-50';
  const borderColor = color === 'green' ? 'border-green-200' : 'border-blue-200';

  return (
    <div className={`${bgColor} border ${borderColor} rounded-lg p-4`}>
      <h5 className="text-sm font-semibold text-gray-700 mb-2">{title}</h5>
      {levels.length > 0 ? (
        <div className="space-y-1 font-mono text-sm">
          {levels.map((level, idx) => (
            <div key={idx} className="flex justify-between text-gray-900">
              <span>${level.price.toFixed(2)}</span>
              <span>{level.quantity} contracts</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-gray-500 text-sm">No bids</div>
      )}
    </div>
  );
}
