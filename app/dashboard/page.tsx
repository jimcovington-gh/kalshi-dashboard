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
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
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
        // Auto-expand all users for admin
        const allUsers = new Set(data.portfolios.map(p => p.user_name));
        setExpandedUsers(allUsers);
      } else if (data.portfolio) {
        // Regular user view
        console.log(`User view: ${data.portfolio.user_name}`);
        setPortfolio(data.portfolio);
        setIsAdminView(false);
        // Auto-expand the user banner
        setExpandedUsers(new Set([data.portfolio.user_name]));
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
        {portfolios.map((userPortfolio, userIdx) => {
          const totalContracts = userPortfolio.positions.reduce((sum, p) => sum + Math.abs(p.contracts), 0);
          const userKey = userPortfolio.user_name;
          const isExpanded = expandedUsers.has(userKey);
          
          return (
            <div key={userIdx} className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50/30">
              {/* User Header - Clickable */}
              <div 
                className="bg-blue-600 text-white px-4 py-3 rounded-t-lg -mx-4 -mt-4 mb-4 cursor-pointer hover:bg-blue-700 transition-colors"
                onClick={() => {
                  const newExpanded = new Set(expandedUsers);
                  if (isExpanded) {
                    newExpanded.delete(userKey);
                  } else {
                    newExpanded.add(userKey);
                  }
                  setExpandedUsers(newExpanded);
                }}
              >
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{isExpanded ? '▼' : '▶'}</span>
                    <h2 className="text-xl font-bold">{userPortfolio.user_name}</h2>
                  </div>
                  <div className="flex gap-6 text-sm">
                    <div>
                      <div>
                        <span className="text-blue-200">Positions:</span>
                        <span className="ml-2 font-semibold">{userPortfolio.position_count}</span>
                      </div>
                      <div className="mt-1">
                        <span className="text-blue-200">Contracts:</span>
                        <span className="ml-2 font-semibold">{totalContracts}</span>
                      </div>
                    </div>
                    <div>
                      <div>
                        <span className="text-blue-200">Cash:</span>
                        <span className="ml-2 font-semibold">${(userPortfolio.cash_balance || 0).toFixed(2)}</span>
                      </div>
                      <div className="mt-1">
                        <span className="text-blue-200">Total:</span>
                        <span className="ml-2 font-semibold">${((userPortfolio.cash_balance || 0) + (userPortfolio.total_position_value || 0)).toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              {isExpanded && (
                <PortfolioContent 
                  portfolio={userPortfolio} 
                  expandedGroups={expandedGroups}
                  setExpandedGroups={setExpandedGroups}
                  userKey={userKey}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Regular user view
  return (
    <PortfolioContent 
      portfolio={portfolio!} 
      expandedGroups={expandedGroups}
      setExpandedGroups={setExpandedGroups}
      userKey={portfolio!.user_name}
    />
  );
}

function PortfolioContent({ portfolio, expandedGroups, setExpandedGroups, userKey }: { 
  portfolio: Portfolio;
  expandedGroups: Set<string>;
  setExpandedGroups: (groups: Set<string>) => void;
  userKey: string;
}) {
  // Separate positions by market status
  const activePositions = portfolio.positions.filter(p => 
    !p.market_status || p.market_status === 'active' || p.market_status === 'open' || p.market_status === 'unknown'
  );
  const inactivePositions = portfolio.positions.filter(p => 
    p.market_status === 'inactive'
  );
  const determinedPositions = portfolio.positions.filter(p => 
    p.market_status && (p.market_status === 'closed' || p.market_status === 'determined')
  );

  // Sort each group by fill_time descending (newest first)
  const sortByFillTime = (positions: Position[]) => {
    return [...positions].sort((a, b) => {
      const timeA = a.fill_time ? new Date(a.fill_time).getTime() : 0;
      const timeB = b.fill_time ? new Date(b.fill_time).getTime() : 0;
      return timeB - timeA;
    });
  };

  const sortedActivePositions = sortByFillTime(activePositions);
  const sortedInactivePositions = sortByFillTime(inactivePositions);
  const sortedDeterminedPositions = sortByFillTime(determinedPositions);

  // Calculate group stats
  const activeStats = {
    contracts: activePositions.reduce((sum, p) => sum + Math.abs(p.contracts), 0),
    value: activePositions.reduce((sum, p) => sum + p.market_value, 0)
  };
  const inactiveStats = {
    contracts: inactivePositions.reduce((sum, p) => sum + Math.abs(p.contracts), 0),
    value: inactivePositions.reduce((sum, p) => sum + p.market_value, 0)
  };
  const determinedStats = {
    contracts: determinedPositions.reduce((sum, p) => sum + Math.abs(p.contracts), 0),
    value: determinedPositions.reduce((sum, p) => sum + p.market_value, 0)
  };

  return (
    <div className="space-y-3 md:space-y-4">

      {/* Active Positions */}
      {activePositions.length > 0 && (
        <PositionsTable 
          positions={sortedActivePositions} 
          title="Active Positions" 
          userName={portfolio.user_name}
          badgeColor="green"
          groupKey={`${userKey}-active`}
          expandedGroups={expandedGroups}
          setExpandedGroups={setExpandedGroups}
          totalContracts={activeStats.contracts}
          totalValue={activeStats.value}
        />
      )}

      {/* Inactive Positions (paused/suspended) */}
      {inactivePositions.length > 0 && (
        <PositionsTable 
          positions={sortedInactivePositions} 
          title="Inactive (Paused)" 
          userName={portfolio.user_name}
          badgeColor="yellow"
          groupKey={`${userKey}-inactive`}
          expandedGroups={expandedGroups}
          setExpandedGroups={setExpandedGroups}
          totalContracts={inactiveStats.contracts}
          totalValue={inactiveStats.value}
        />
      )}

      {/* Determined/Closed Positions (awaiting settlement) */}
      {determinedPositions.length > 0 && (
        <PositionsTable 
          positions={sortedDeterminedPositions} 
          title="Awaiting Settlement" 
          userName={portfolio.user_name}
          badgeColor="gray"
          groupKey={`${userKey}-determined`}
          expandedGroups={expandedGroups}
          setExpandedGroups={setExpandedGroups}
          totalContracts={determinedStats.contracts}
          totalValue={determinedStats.value}
        />
      )}

      {/* Show message if no positions */}
      {activePositions.length === 0 && inactivePositions.length === 0 && determinedPositions.length === 0 && (
        <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
          No positions found
        </div>
      )}
    </div>
  );
}

function PositionsTable({ positions, title, userName, badgeColor, groupKey, expandedGroups, setExpandedGroups, totalContracts, totalValue }: { 
  positions: Position[]; 
  title: string; 
  userName: string;
  badgeColor: 'green' | 'yellow' | 'gray';
  groupKey: string;
  expandedGroups: Set<string>;
  setExpandedGroups: (groups: Set<string>) => void;
  totalContracts: number;
  totalValue: number;
}) {
  const isExpanded = expandedGroups.has(groupKey);
  const bgColor = badgeColor === 'green' ? 'bg-green-50' : badgeColor === 'yellow' ? 'bg-yellow-50' : 'bg-gray-50';
  const borderColor = badgeColor === 'green' ? 'border-green-200' : badgeColor === 'yellow' ? 'border-yellow-300' : 'border-gray-300';
  const headerBg = badgeColor === 'green' ? 'bg-green-100' : badgeColor === 'yellow' ? 'bg-yellow-100' : 'bg-gray-200';
  
  const toggleExpanded = () => {
    const newExpanded = new Set(expandedGroups);
    if (isExpanded) {
      newExpanded.delete(groupKey);
    } else {
      newExpanded.add(groupKey);
    }
    setExpandedGroups(newExpanded);
  };
  
  return (
    <>
      {/* Desktop Table */}
      <div className={`hidden md:block bg-white rounded-lg shadow overflow-hidden border ${borderColor}`}>
        <div 
          className={`px-4 py-2 ${headerBg} border-b ${borderColor} cursor-pointer hover:opacity-80 transition-opacity`}
          onClick={toggleExpanded}
        >
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">
              <span className="mr-2">{isExpanded ? '▼' : '▶'}</span>
              {title} ({positions.length})
            </h3>
            <div className="flex gap-4 text-sm text-gray-700">
              <div>
                <span className="font-medium">Contracts:</span> {totalContracts}
              </div>
              <div>
                <span className="font-medium">Value:</span> ${totalValue.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
        {isExpanded && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className={bgColor}>
                <tr>
                  <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" style={{width: '32%'}}>
                    Time
                  </th>
                  <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" style={{width: '20%'}}>
                    Idea
                  </th>
                  <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Market
                  </th>
                  <th className="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" style={{width: '3.75%'}}>
                    Side
                  </th>
                  <th className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wider" style={{width: '3.75%'}}>
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
                      <td className="px-3 py-0.5 whitespace-nowrap" style={{width: '32%'}}>
                        <a href={tradeUrl} className="text-xs text-blue-600 hover:underline">
                          {fillDateTime}
                        </a>
                      </td>
                      <td className="px-3 py-0.5 whitespace-nowrap text-xs text-gray-600" style={{width: '20%'}}>
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
        )}
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-2">
        <div 
          className={`px-3 py-2 rounded-lg shadow ${headerBg} cursor-pointer active:opacity-80`}
          onClick={toggleExpanded}
        >
          <div className="flex justify-between items-center">
            <h3 className="text-base font-semibold text-gray-900">
              <span className="mr-2">{isExpanded ? '▼' : '▶'}</span>
              {title} ({positions.length})
            </h3>
            <div className="text-xs text-gray-700">
              <div>{totalContracts} contracts</div>
              <div>${totalValue.toFixed(2)}</div>
            </div>
          </div>
        </div>
        {isExpanded && (
          <div className="space-y-2">
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
        )}
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
