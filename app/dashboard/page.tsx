'use client';

import { useEffect, useState } from 'react';
import { getPortfolio, Portfolio, Position } from '@/lib/api';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

export default function DashboardPage() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [isAdminView, setIsAdminView] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const router = useRouter();

  useEffect(() => {
    loadPortfolio();
  }, []);

  async function loadPortfolio() {
    try {
      // Check if user is authenticated before calling API
      const session = await fetchAuthSession();
      if (!session.tokens?.idToken) {
        console.error('No authentication token found, redirecting to login');
        router.push('/');
        return;
      }

      const data = await getPortfolio();
      console.log('Portfolio API response:', JSON.stringify(data, null, 2));
      
      if (data.is_admin_view && data.portfolios && data.portfolios.length > 0) {
        // Admin view - show all portfolios
        console.log(`Admin view: ${data.portfolios.length} portfolios`);
        setPortfolios(data.portfolios);
        setIsAdminView(true);
      } else if (data.portfolio) {
        // Regular user view
        console.log(`User view: ${data.portfolio.user_name}`);
        setPortfolio(data.portfolio);
        setIsAdminView(false);
      }
    } catch (err: any) {
      console.error('Error fetching portfolio:', err);
      setError(err.message || 'Failed to load portfolio');
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoading) {
    return <div className="text-center py-12">Loading portfolio...</div>;
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        {error}
      </div>
    );
  }

  if (!isAdminView && !portfolio) {
    return <div className="text-center py-12">No portfolio data available</div>;
  }

  if (isAdminView && portfolios.length === 0) {
    return <div className="text-center py-12">No portfolios available</div>;
  }

  // Admin view - render all portfolios
  if (isAdminView) {
    return (
      <div className="space-y-8">
        {portfolios.map((userPortfolio, userIdx) => (
          <div key={userIdx} className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50/30">
            {/* User Header */}
            <div className="bg-blue-600 text-white px-4 py-3 rounded-t-lg -mx-4 -mt-4 mb-4">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold">{userPortfolio.user_name}</h2>
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="text-blue-200">Cash:</span>
                    <span className="ml-2 font-semibold">${(userPortfolio.cash_balance || 0).toFixed(2)}</span>
                  </div>
                  <div>
                    <span className="text-blue-200">Total:</span>
                    <span className="ml-2 font-semibold">${((userPortfolio.cash_balance || 0) + (userPortfolio.total_position_value || 0)).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>
            
            <PortfolioContent portfolio={userPortfolio} />
          </div>
        ))}
      </div>
    );
  }

  // Regular user view
  return <PortfolioContent portfolio={portfolio!} />;
}

function PortfolioContent({ portfolio }: { portfolio: Portfolio }) {
  // DEBUG: Log what we receive
  console.log('PortfolioContent positions:', portfolio.positions.map(p => ({
    ticker: p.ticker,
    market_status: p.market_status
  })));

  // Separate positions by market status
  // Active = markets still trading (active, open, unknown)
  // Determined = markets closed but not yet settled (closed, determined)
  // We exclude settled positions as they've already paid out
  const activePositions = portfolio.positions.filter(p => 
    !p.market_status || p.market_status === 'active' || p.market_status === 'open' || p.market_status === 'unknown'
  );
  const determinedPositions = portfolio.positions.filter(p => 
    p.market_status && (p.market_status === 'closed' || p.market_status === 'determined')
  );

  // Sort each group by fill_time descending (newest first)
  const sortByFillTime = (positions: Position[]) => {
    return [...positions].sort((a, b) => {
      const timeA = a.fill_time ? new Date(a.fill_time).getTime() : 0;
      const timeB = b.fill_time ? new Date(b.fill_time).getTime() : 0;
      return timeB - timeA; // Descending order (newest first)
    });
  };

  const sortedActivePositions = sortByFillTime(activePositions);
  const sortedDeterminedPositions = sortByFillTime(determinedPositions);

  // DEBUG: Log filter results
  console.log('Active positions count:', activePositions.length);
  console.log('Determined positions count:', determinedPositions.length);
  console.log('Determined positions:', determinedPositions.map(p => p.ticker));

  return (
    <div className="space-y-3 md:space-y-4">
      {/* Portfolio Summary */}
      <div className="bg-white rounded-lg shadow p-3 md:p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
          <div className="bg-blue-50 p-2 md:p-3 rounded-lg">
            <div className="text-xs md:text-sm text-gray-600">Total Positions</div>
            <div className="text-2xl md:text-3xl font-bold text-blue-600">{portfolio.position_count}</div>
          </div>
          <div className="bg-green-50 p-2 md:p-3 rounded-lg">
            <div className="text-xs md:text-sm text-gray-600">Position Value</div>
            <div className="text-2xl md:text-3xl font-bold text-green-600">
              ${portfolio.total_position_value.toFixed(2)}
            </div>
          </div>
          <div className="bg-yellow-50 p-2 md:p-3 rounded-lg">
            <div className="text-xs md:text-sm text-gray-600">Cash Balance</div>
            <div className="text-2xl md:text-3xl font-bold text-yellow-600">
              ${(portfolio.cash_balance || 0).toFixed(2)}
            </div>
          </div>
          <div className="bg-purple-50 p-2 md:p-3 rounded-lg">
            <div className="text-xs md:text-sm text-gray-600">Total Value</div>
            <div className="text-2xl md:text-3xl font-bold text-purple-600">
              ${((portfolio.cash_balance || 0) + portfolio.total_position_value).toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Active Positions */}
      {activePositions.length > 0 && (
        <PositionsTable 
          positions={sortedActivePositions} 
          title="Active Positions" 
          userName={portfolio.user_name}
          badgeColor="green"
        />
      )}

      {/* Determined/Closed Positions (awaiting settlement) */}
      {determinedPositions.length > 0 && (
        <PositionsTable 
          positions={sortedDeterminedPositions} 
          title="Awaiting Settlement" 
          userName={portfolio.user_name}
          badgeColor="gray"
        />
      )}

      {/* Show message if no positions */}
      {activePositions.length === 0 && determinedPositions.length === 0 && (
        <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
          No positions found
        </div>
      )}
    </div>
  );
}

function PositionsTable({ positions, title, userName, badgeColor }: { 
  positions: Position[]; 
  title: string; 
  userName: string;
  badgeColor: 'green' | 'gray';
}) {
  const bgColor = badgeColor === 'green' ? 'bg-green-50' : 'bg-gray-50';
  const borderColor = badgeColor === 'green' ? 'border-green-200' : 'border-gray-300';
  const headerBg = badgeColor === 'green' ? 'bg-green-100' : 'bg-gray-200';
  
  return (
    <>
      {/* Desktop Table */}
      <div className={`hidden md:block bg-white rounded-lg shadow overflow-hidden border ${borderColor}`}>
        <div className={`px-4 py-2 ${headerBg} border-b ${borderColor}`}>
          <h3 className="text-lg font-semibold text-gray-900">{title} ({positions.length})</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className={bgColor}>
              <tr>
                <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/4">
                  Time
                </th>
                <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/4">
                  Idea
                </th>
                <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Market
                </th>
                <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Side
                </th>
                <th className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  QTY
                </th>
                <th className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Fill Price
                </th>
                <th className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Current Price
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {positions.map((position, idx) => {
                const marketUrl = buildMarketUrl(
                  position.series_ticker || '',
                  position.market_title || '',
                  position.event_ticker || ''
                );
                
                // Format fill time
                const fillDateTime = position.fill_time ? formatDateTime(position.fill_time) : '-';
                const tradeUrl = `/dashboard/trades?ticker=${position.ticker}&user_name=${userName}`;

                return (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-0.5 whitespace-nowrap w-1/4">
                      <a href={tradeUrl} className="text-xs text-blue-600 hover:underline">
                        {fillDateTime}
                      </a>
                    </td>
                    <td className="px-3 py-0.5 whitespace-nowrap w-1/4 text-xs text-gray-600">
                      {position.idea_name || '-'}
                    </td>
                    <td className="px-3 py-0.5 whitespace-nowrap">
                      {marketUrl ? (
                        <a href={marketUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline truncate max-w-md block">
                          {position.market_title}
                        </a>
                      ) : (
                        <div className="text-xs text-gray-500 truncate max-w-md">{position.market_title}</div>
                      )}
                    </td>
                    <td className="px-3 py-0.5 whitespace-nowrap">
                      <span
                        className={`px-2 py-0.5 inline-flex text-xs leading-4 font-semibold rounded-full ${
                          position.side === 'yes'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {position.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-0.5 whitespace-nowrap text-right text-xs text-gray-900">
                      {Math.abs(position.contracts)}
                    </td>
                    <td className="px-3 py-0.5 whitespace-nowrap text-right text-xs text-gray-600">
                      {position.fill_price ? `$${position.fill_price.toFixed(2)}` : '-'}
                    </td>
                    <td className="px-3 py-0.5 whitespace-nowrap text-right text-xs font-semibold">
                      <span className={`${
                        position.current_price >= 0.95
                          ? 'text-green-600'
                          : position.current_price >= 0.85
                          ? 'text-orange-600'
                          : 'text-red-600'
                      }`}>
                        ${position.current_price.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-2">
        <div className={`px-3 py-2 rounded-lg shadow ${headerBg}`}>
          <h3 className="text-base font-semibold text-gray-900">{title} ({positions.length})</h3>
        </div>
        {positions.map((position, idx) => {
          const marketUrl = buildMarketUrl(
            position.series_ticker || '',
            position.market_title || '',
            position.event_ticker || ''
          );
          const fillDateTime = position.fill_time ? formatDateTime(position.fill_time) : '-';
          const tradeUrl = `/dashboard/trades?ticker=${position.ticker}&user_name=${userName}`;

          return (
            <div key={idx} className="bg-white rounded-lg shadow p-2.5">
              {/* Market Title */}
              {marketUrl ? (
                <a href={marketUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 hover:underline block mb-1.5">
                  {position.market_title}
                </a>
              ) : (
                <div className="text-sm font-medium text-gray-900 mb-1.5">{position.market_title}</div>
              )}
              
              {/* Stats Grid - 6 columns with Time and Idea first (25% each) */}
              <div className="grid grid-cols-8 gap-1 text-xs">
                <div className="col-span-2">
                  <div className="text-gray-500 mb-0.5">Time</div>
                  <a href={tradeUrl} className="text-blue-600 hover:underline text-xs">
                    {fillDateTime}
                  </a>
                </div>
                <div className="col-span-2">
                  <div className="text-gray-500 mb-0.5">Idea</div>
                  <div className="text-gray-600 truncate">{position.idea_name || '-'}</div>
                </div>
                <div className="col-span-1">
                  <div className="text-gray-500 mb-0.5">Side</div>
                  <span className={`px-1.5 py-0.5 inline-flex text-xs leading-4 font-semibold rounded-full ${
                    position.side === 'yes'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-blue-100 text-blue-800'
                  }`}>
                    {position.side.toUpperCase()}
                  </span>
                </div>
                <div className="col-span-1">
                  <div className="text-gray-500 mb-0.5">QTY</div>
                  <div className="font-semibold text-gray-900">{Math.abs(position.contracts)}</div>
                </div>
                <div className="col-span-1">
                  <div className="text-gray-500 mb-0.5">Fill</div>
                  <div className="font-medium text-gray-600">
                    {position.fill_price ? `$${position.fill_price.toFixed(2)}` : '-'}
                  </div>
                </div>
                <div className="col-span-1">
                  <div className="text-gray-500 mb-0.5">Price</div>
                  <div className={`font-semibold ${
                    position.current_price >= 0.95
                      ? 'text-green-600'
                      : position.current_price >= 0.85
                      ? 'text-orange-600'
                      : 'text-red-600'
                  }`}>
                    ${position.current_price.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// Helper function to build Kalshi market URL
function buildMarketUrl(seriesTicker: string, title: string, eventTicker: string): string | null {
  if (!seriesTicker || !title || !eventTicker) return null;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `https://kalshi.com/markets/${seriesTicker.toUpperCase()}/${slug}/${eventTicker.toUpperCase()}`;
}

// Helper function to format date/time for display
function formatDateTime(dateValue: string | number): string {
  try {
    let date: Date;
    
    if (typeof dateValue === 'number') {
      // Unix timestamp in seconds
      date = new Date(dateValue * 1000);
    } else if (typeof dateValue === 'string') {
      // Try parsing as ISO string or Unix timestamp string
      const asNumber = Number(dateValue);
      if (!isNaN(asNumber)) {
        // It's a number string - likely Unix timestamp in seconds
        date = new Date(asNumber * 1000);
      } else {
        // Try as ISO string
        date = new Date(dateValue);
      }
    } else {
      return '-';
    }
    
    if (isNaN(date.getTime())) return '-';
    
    // Format as "MM/DD HH:MM AM/PM"
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    
    return `${month}/${day} ${time}`;
  } catch {
    return '-';
  }
}
