'use client';

import { useEffect, useState } from 'react';
import { getPortfolio, Portfolio } from '@/lib/api';

export default function DashboardPage() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [isAdminView, setIsAdminView] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadPortfolio();
  }, []);

  async function loadPortfolio() {
    try {
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

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Portfolio Summary */}
      <div className="bg-white rounded-lg shadow p-4 md:p-6">
        <h2 className="text-xl md:text-2xl font-bold text-gray-900 mb-3 md:mb-4">Portfolio Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
          <div className="bg-blue-50 p-3 md:p-4 rounded-lg">
            <div className="text-xs md:text-sm text-gray-600">Total Positions</div>
            <div className="text-2xl md:text-3xl font-bold text-blue-600">{portfolio.position_count}</div>
          </div>
          <div className="bg-green-50 p-3 md:p-4 rounded-lg">
            <div className="text-xs md:text-sm text-gray-600">Total Value</div>
            <div className="text-2xl md:text-3xl font-bold text-green-600">
              ${portfolio.total_position_value.toFixed(2)}
            </div>
          </div>
          <div className="bg-purple-50 p-3 md:p-4 rounded-lg">
            <div className="text-xs md:text-sm text-gray-600">Average Position</div>
            <div className="text-2xl md:text-3xl font-bold text-purple-600">
              ${(portfolio.total_position_value / portfolio.position_count || 0).toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Positions Table - Desktop */}
      <div className="hidden md:block bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Active Positions</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Market
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Ticker
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Side
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Contracts
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Fill Price
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Price
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {portfolio.positions.map((position, idx) => {
                // Build Kalshi URL
                const buildMarketUrl = (seriesTicker: string, title: string, eventTicker: string) => {
                  if (!seriesTicker || !title || !eventTicker) return null;
                  const slug = title
                    .toLowerCase()
                    .replace(/[^a-z0-9\s-]/g, '')
                    .replace(/\s+/g, '-')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '');
                  return `https://kalshi.com/markets/${seriesTicker.toUpperCase()}/${slug}/${eventTicker.toUpperCase()}`;
                };
                
                const marketUrl = buildMarketUrl(
                  position.series_ticker || '',
                  position.market_title || '',
                  position.event_ticker || ''
                );

                return (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-4 py-2 whitespace-nowrap">
                      {marketUrl ? (
                        <a href={marketUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline truncate max-w-md block">
                          {position.market_title}
                        </a>
                      ) : (
                        <div className="text-xs text-gray-500 truncate max-w-md">{position.market_title}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <a href={`/dashboard/trades?ticker=${position.ticker}&user_name=${portfolio.user_name}`} className="text-xs font-medium text-blue-600 hover:underline">
                        {position.ticker}
                      </a>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
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
                  <td className="px-4 py-2 whitespace-nowrap text-right text-xs text-gray-900">
                    {Math.abs(position.contracts)}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-right text-xs text-gray-600">
                    {position.fill_price ? `$${position.fill_price.toFixed(2)}` : '-'}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-right text-xs font-semibold">
                    <span className={`${
                      position.current_price >= 0.95 || position.current_price <= 0.05
                        ? 'text-green-600'
                        : position.current_price >= 0.85 || position.current_price <= 0.15
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

      {/* Positions Cards - Mobile */}
      <div className="md:hidden space-y-3">
        <div className="px-4 py-3 bg-white rounded-lg shadow">
          <h3 className="text-base font-semibold text-gray-900 mb-3">Active Positions</h3>
        </div>
        {portfolio.positions.map((position, idx) => {
          // Build Kalshi URL
          const buildMarketUrl = (seriesTicker: string, title: string, eventTicker: string) => {
            if (!seriesTicker || !title || !eventTicker) return null;
            const slug = title
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, '')
              .replace(/\s+/g, '-')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '');
            return `https://kalshi.com/markets/${seriesTicker.toUpperCase()}/${slug}/${eventTicker.toUpperCase()}`;
          };
          
          const marketUrl = buildMarketUrl(
            position.series_ticker || '',
            position.market_title || '',
            position.event_ticker || ''
          );

          return (
            <div key={idx} className="bg-white rounded-lg shadow p-4">
              {/* Market Title */}
              {marketUrl ? (
                <a href={marketUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 hover:underline block mb-2">
                  {position.market_title}
                </a>
              ) : (
                <div className="text-sm font-medium text-gray-900 mb-2">{position.market_title}</div>
              )}
              
              {/* Ticker */}
              <a href={`/dashboard/trades?ticker=${position.ticker}&user_name=${portfolio.user_name}`} className="text-xs text-gray-500 hover:text-blue-600 block mb-3">
                {position.ticker}
              </a>
              
              {/* Stats Grid */}
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-gray-500 mb-1">Side</div>
                  <span className={`px-2 py-0.5 inline-flex text-xs leading-4 font-semibold rounded-full ${
                    position.side === 'yes'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-blue-100 text-blue-800'
                  }`}>
                    {position.side.toUpperCase()}
                  </span>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">Contracts</div>
                  <div className="text-sm font-semibold text-gray-900">{Math.abs(position.contracts)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">Fill</div>
                  <div className="text-sm font-medium text-gray-600">
                    {position.fill_price ? `$${position.fill_price.toFixed(2)}` : '-'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">Price</div>
                  <div className={`text-sm font-semibold ${
                    position.current_price >= 0.95 || position.current_price <= 0.05
                      ? 'text-green-600'
                      : position.current_price >= 0.85 || position.current_price <= 0.15
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
    </div>
  );
}
