'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { getTrades, Trade } from '@/lib/api';
import { format } from 'date-fns';

export default function TradesPage() {
  const searchParams = useSearchParams();
  const tickerParam = searchParams.get('ticker');
  const userNameParam = searchParams.get('user_name');
  
  const [ticker, setTicker] = useState(tickerParam || '');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  // Auto-search if ticker is in URL params
  useEffect(() => {
    if (tickerParam) {
      setTicker(tickerParam);
      performSearch(tickerParam, userNameParam || undefined);
    }
  }, [tickerParam, userNameParam]);

  async function performSearch(searchTicker: string, userName?: string) {
    if (!searchTicker.trim()) return;

    setIsLoading(true);
    setError('');
    setSearched(true);

    try {
      const data = await getTrades(searchTicker.toUpperCase().trim(), userName);
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
    <div className="space-y-4 md:space-y-6">
      <div className="bg-white rounded-lg shadow p-4 md:p-6">
        <h2 className="text-xl md:text-2xl font-bold text-gray-900 mb-3 md:mb-4">Trade History</h2>
        
        <form onSubmit={handleSearch} className="flex flex-col md:flex-row gap-3 md:gap-4">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="Enter ticker (e.g., KXHIGHAUS-25NOV16-B88.5)"
            className="flex-1 px-3 md:px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 text-sm md:text-base"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="px-4 md:px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed text-sm md:text-base"
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
        <div className="bg-white rounded-lg shadow p-8 md:p-12 text-center text-gray-500">
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
          <div className="px-4 md:px-6 py-3 md:py-4 bg-gray-50 border-b border-gray-200 flex flex-col md:flex-row md:justify-between md:items-center gap-2">
            <div>
              <h3 className="text-base md:text-lg font-semibold text-gray-900">Trade #{idx + 1}</h3>
              <p className="text-xs md:text-sm text-gray-600">
                {format(new Date(trade.initiated_at), 'PPpp')}
              </p>
            </div>
            <span
              className={`px-3 py-1 rounded-full text-xs md:text-sm font-semibold self-start md:self-auto ${
                trade.success
                  ? 'bg-green-100 text-green-800'
                  : 'bg-red-100 text-red-800'
              }`}
            >
              {trade.success ? '✅ Success' : '❌ Failed'}
            </span>
          </div>

          <div className="p-4 md:p-6">
            <div className="grid grid-cols-2 gap-3 md:gap-4 mb-4">
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Side</div>
                <div className="text-base md:text-lg font-semibold text-gray-900">{trade.side.toUpperCase()}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Contracts</div>
                <div className="text-base md:text-lg font-semibold text-gray-900">{trade.filled_count || 0}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">
                  {trade.success ? 'Fill Price' : 'Target Price'}
                </div>
                <div className="text-base md:text-lg font-semibold text-gray-900">
                  ${(trade.avg_fill_price || 0).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Total Cost</div>
                <div className="text-base md:text-lg font-semibold text-gray-900">
                  ${((trade.filled_count || 0) * (trade.avg_fill_price || 0)).toFixed(2)}
                </div>
              </div>
            </div>

            {!trade.success && trade.error_message && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 md:px-4 py-2 md:py-3 rounded-lg mb-3 md:mb-4 text-sm">
                <strong>Error:</strong> {trade.error_message}
              </div>
            )}

            {trade.orderbook_snapshot && (
              <div className="mt-3 md:mt-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-2 md:mb-3">
                  Order Book Snapshot (from {trade.side.toUpperCase()} holder perspective)
                </h4>
                <MergedOrderBook
                  snapshot={trade.orderbook_snapshot}
                  userSide={trade.side}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface OrderBookLevel {
  price: number;
  quantity: number;
}

interface OrderBookSnapshot {
  yes_bids?: OrderBookLevel[];
  no_bids?: OrderBookLevel[];
}

function MergedOrderBook({
  snapshot,
  userSide,
}: {
  snapshot: OrderBookSnapshot;
  userSide: string;
}) {
  // Transform orderbook based on user's position
  // If user holds NO: YES bids become YES asks (price = 1 - yes_bid)
  // If user holds YES: NO bids become NO asks (price = 1 - no_bid)
  
  const yesBids = snapshot.yes_bids || [];
  const noBids = snapshot.no_bids || [];
  
  let bids: Array<{ side: string; price: number; quantity: number }> = [];
  let asks: Array<{ side: string; price: number; quantity: number }> = [];
  
  if (userSide.toLowerCase() === 'no') {
    // User holds NO position
    // NO bids = bids from user's perspective
    bids = noBids.map(level => ({
      side: 'NO',
      price: level.price,
      quantity: level.quantity
    }));
    
    // YES bids = asks from user's perspective (flipped: 1 - price)
    asks = yesBids.map(level => ({
      side: 'YES',
      price: 1 - level.price,
      quantity: level.quantity
    }));
  } else {
    // User holds YES position
    // YES bids = bids from user's perspective
    bids = yesBids.map(level => ({
      side: 'YES',
      price: level.price,
      quantity: level.quantity
    }));
    
    // NO bids = asks from user's perspective (flipped: 1 - price)
    asks = noBids.map(level => ({
      side: 'NO',
      price: 1 - level.price,
      quantity: level.quantity
    }));
  }
  
  // Sort: bids descending (highest first), asks ascending (lowest first)
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  
  // Take top 10 of each
  const topBids = bids.slice(0, 10);
  const topAsks = asks.slice(0, 10);

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
      {/* Table Header */}
      <div className="bg-white px-4 py-2 border-b border-gray-300">
        <div className="grid grid-cols-4 gap-2 text-xs font-semibold text-gray-600">
          <div className="text-left">Type</div>
          <div className="text-left">Side</div>
          <div className="text-right">Price</div>
          <div className="text-right">Size</div>
        </div>
      </div>

      {/* Asks Section (on top, ascending order) */}
      {topAsks.length > 0 ? (
        <div className="divide-y divide-gray-100">
          {topAsks.map((level, idx) => (
            <div key={idx} className="px-4 py-1.5 grid grid-cols-4 gap-2 font-mono text-sm bg-red-50 hover:bg-red-100 transition-colors">
              <span className="text-red-700 font-semibold">ASK</span>
              <span className="text-gray-700 font-semibold">{level.side}</span>
              <span className="text-right text-red-700 font-semibold">${level.price.toFixed(2)}</span>
              <span className="text-right text-gray-600">{level.quantity}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-4 text-center text-gray-400 text-sm bg-red-50">No asks</div>
      )}

      {/* Spread Barrier */}
      <div className="h-2 bg-gradient-to-b from-red-100 via-gray-300 to-green-100 border-y-2 border-gray-400"></div>

      {/* Bids Section (on bottom, descending order) */}
      {topBids.length > 0 ? (
        <div className="divide-y divide-gray-100">
          {topBids.map((level, idx) => (
            <div key={idx} className="px-4 py-1.5 grid grid-cols-4 gap-2 font-mono text-sm bg-green-50 hover:bg-green-100 transition-colors">
              <span className="text-green-700 font-semibold">BID</span>
              <span className="text-gray-700 font-semibold">{level.side}</span>
              <span className="text-right text-green-700 font-semibold">${level.price.toFixed(2)}</span>
              <span className="text-right text-gray-600">{level.quantity}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-4 text-center text-gray-400 text-sm bg-green-50">No bids</div>
      )}
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
