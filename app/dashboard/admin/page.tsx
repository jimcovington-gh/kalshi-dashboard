'use client';

import { useEffect, useState } from 'react';
import { getPortfolio, Portfolio, getCurrentUser, isAdmin } from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function AdminPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isAdminUser, setIsAdminUser] = useState(false);
  const router = useRouter();

  useEffect(() => {
    checkAdminAndLoad();
  }, []);

  async function checkAdminAndLoad() {
    try {
      const adminStatus = await isAdmin();
      if (!adminStatus) {
        router.push('/dashboard');
        return;
      }
      setIsAdminUser(true);
      await loadAllPortfolios();
    } catch (err: any) {
      setError('Access denied');
      setTimeout(() => router.push('/dashboard'), 2000);
    }
  }

  async function loadAllPortfolios() {
    setIsLoading(true);
    setError('');
    try {
      const data = await getPortfolio(); // No user_name = admin sees all
      if (data.portfolios) {
        setPortfolios(data.portfolios);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load portfolios');
    } finally {
      setIsLoading(false);
    }
  }

  async function loadUserPortfolio(userName: string) {
    setIsLoading(true);
    setError('');
    try {
      const data = await getPortfolio(userName);
      if (data.portfolio) {
        setPortfolios([data.portfolio]);
        setSelectedUser(userName);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load portfolio');
    } finally {
      setIsLoading(false);
    }
  }

  if (!isAdminUser) {
    return (
      <div className="text-center py-12">
        <div className="text-red-600 font-semibold">Access Denied</div>
        <p className="text-gray-600 mt-2">This page is only accessible to administrators</p>
      </div>
    );
  }

  const totalValue = portfolios.reduce((sum, p) => sum + p.total_position_value, 0);
  const totalPositions = portfolios.reduce((sum, p) => sum + p.position_count, 0);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Admin Dashboard</h2>
          {selectedUser && (
            <button
              onClick={() => {
                setSelectedUser('');
                loadAllPortfolios();
              }}
              className="px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md"
            >
              ← View All Users
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-purple-50 p-4 rounded-lg">
            <div className="text-sm text-gray-600">Total Users</div>
            <div className="text-3xl font-bold text-purple-600">{portfolios.length}</div>
          </div>
          <div className="bg-green-50 p-4 rounded-lg">
            <div className="text-sm text-gray-600">Total Value (All Users)</div>
            <div className="text-3xl font-bold text-green-600">${totalValue.toFixed(2)}</div>
          </div>
          <div className="bg-blue-50 p-4 rounded-lg">
            <div className="text-sm text-gray-600">Total Positions</div>
            <div className="text-3xl font-bold text-blue-600">{totalPositions}</div>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12">Loading portfolios...</div>
      ) : (
        <div className="space-y-4">
          {portfolios.map((portfolio, idx) => (
            <div key={idx} className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{portfolio.user_name}</h3>
                  <p className="text-sm text-gray-600">
                    {portfolio.position_count} positions • ${portfolio.total_position_value.toFixed(2)} total value
                  </p>
                </div>
                {!selectedUser && (
                  <button
                    onClick={() => loadUserPortfolio(portfolio.user_name)}
                    className="px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md"
                  >
                    View Details →
                  </button>
                )}
              </div>

              {selectedUser === portfolio.user_name && (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Market</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Side</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Contracts</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Price</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Value</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {(() => {
                        const activePositions = portfolio.positions.filter(p => 
                          ['active', 'open', 'unknown'].includes((p.market_status || 'unknown').toLowerCase())
                        );
                        const closedPositions = portfolio.positions.filter(p => 
                          !['active', 'open', 'unknown'].includes((p.market_status || 'unknown').toLowerCase())
                        );
                        
                        return (
                          <>
                            {activePositions.length > 0 && (
                              <tr className="bg-green-50">
                                <td colSpan={6} className="px-6 py-2 text-xs font-semibold text-green-700 uppercase">
                                  Active Markets ({activePositions.length})
                                </td>
                              </tr>
                            )}
                            {activePositions.map((position, pidx) => (
                              <tr key={`active-${pidx}`} className="hover:bg-gray-50">
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <div className="text-sm font-medium text-gray-900">{position.ticker}</div>
                                  <div className="text-sm text-gray-500 truncate max-w-md">{position.market_title}</div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                                    {position.market_status || 'active'}
                                  </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <span
                                    className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                      position.side === 'yes' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                                    }`}
                                  >
                                    {position.side.toUpperCase()}
                                  </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                                  {Math.abs(position.contracts)}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                                  ${position.current_price.toFixed(2)}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900">
                                  ${position.market_value.toFixed(2)}
                                </td>
                              </tr>
                            ))}
                            {closedPositions.length > 0 && (
                              <tr className="bg-gray-100">
                                <td colSpan={6} className="px-6 py-2 text-xs font-semibold text-gray-600 uppercase">
                                  Closed/Settled Markets ({closedPositions.length})
                                </td>
                              </tr>
                            )}
                            {closedPositions.map((position, pidx) => (
                              <tr key={`closed-${pidx}`} className="hover:bg-gray-50 bg-gray-50/50">
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <div className="text-sm font-medium text-gray-600">{position.ticker}</div>
                                  <div className="text-sm text-gray-400 truncate max-w-md">{position.market_title}</div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-200 text-gray-600">
                                    {position.market_status || 'closed'}
                                  </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <span
                                    className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                      position.side === 'yes' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                                    }`}
                                  >
                                    {position.side.toUpperCase()}
                                  </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-600">
                                  {Math.abs(position.contracts)}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-600">
                                  ${position.current_price.toFixed(2)}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-600">
                                  ${position.market_value.toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </>
                        );
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
