'use client';

import { useEffect, useState } from 'react';
import { getPortfolio, Portfolio, getCurrentUser, isAdmin, getTradingStatus, setTradingStatus, TradingStatus } from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function AdminPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [tradingStatus, setTradingStatusState] = useState<TradingStatus | null>(null);
  const [tradingStatusLoading, setTradingStatusLoading] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [disableReason, setDisableReason] = useState('');
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
      await Promise.all([
        loadAllPortfolios(),
        loadTradingStatus()
      ]);
    } catch (err: any) {
      setError('Access denied');
      setTimeout(() => router.push('/dashboard'), 2000);
    }
  }

  async function loadTradingStatus() {
    try {
      const status = await getTradingStatus();
      setTradingStatusState(status);
    } catch (err: any) {
      console.error('Failed to load trading status:', err);
    }
  }

  async function handleToggleTrading() {
    if (!tradingStatus) return;
    
    if (tradingStatus.trading_enabled) {
      // Show confirmation dialog before disabling
      setShowDisableConfirm(true);
    } else {
      // Enable trading directly
      await updateTradingStatus(true, 'Manually re-enabled');
    }
  }

  async function confirmDisableTrading() {
    await updateTradingStatus(false, disableReason || 'Manually disabled');
    setShowDisableConfirm(false);
    setDisableReason('');
  }

  async function updateTradingStatus(enabled: boolean, reason: string) {
    setTradingStatusLoading(true);
    try {
      const status = await setTradingStatus(enabled, reason);
      setTradingStatusState(status);
    } catch (err: any) {
      setError(err.message || 'Failed to update trading status');
    } finally {
      setTradingStatusLoading(false);
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
      {/* Trading Status Control Panel */}
      <div className={`rounded-lg shadow p-6 ${
        tradingStatus?.trading_enabled === false 
          ? 'bg-red-50 border-2 border-red-300' 
          : tradingStatus?.trading_enabled === true 
            ? 'bg-green-50 border-2 border-green-300'
            : 'bg-gray-50'
      }`}>
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              🛡️ Trading Control
              {tradingStatus?.trading_enabled === false && (
                <span className="px-2 py-1 text-sm bg-red-600 text-white rounded-full animate-pulse">
                  EMERGENCY STOP ACTIVE
                </span>
              )}
            </h2>
            {tradingStatus && (
              <div className="mt-2 text-sm text-gray-600">
                {tradingStatus.trading_enabled ? (
                  <span className="text-green-700 font-medium">✓ Automated trading is ENABLED</span>
                ) : (
                  <span className="text-red-700 font-medium">✗ Automated trading is DISABLED</span>
                )}
                {tradingStatus.reason && (
                  <p className="mt-1 text-gray-500">
                    Reason: {tradingStatus.reason}
                  </p>
                )}
                {tradingStatus.triggered_at && (
                  <p className="text-gray-400 text-xs mt-1">
                    Last changed: {new Date(tradingStatus.triggered_at).toLocaleString()}
                    {tradingStatus.triggered_by && ` by ${tradingStatus.triggered_by}`}
                  </p>
                )}
              </div>
            )}
          </div>
          <div>
            {tradingStatus?.trading_enabled ? (
              <button
                onClick={handleToggleTrading}
                disabled={tradingStatusLoading}
                className="px-6 py-3 bg-red-600 text-white font-bold rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
              >
                {tradingStatusLoading ? '...' : '🛑 STOP ALL TRADING'}
              </button>
            ) : (
              <button
                onClick={handleToggleTrading}
                disabled={tradingStatusLoading}
                className="px-6 py-3 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
              >
                {tradingStatusLoading ? '...' : '✓ ENABLE TRADING'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Disable Trading Confirmation Modal */}
      {showDisableConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold text-red-600 mb-4">⚠️ Confirm Emergency Stop</h3>
            <p className="text-gray-700 mb-4">
              This will immediately stop ALL automated trading across all systems. 
              Manual trades through the dashboard will still work.
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason (optional)
              </label>
              <input
                type="text"
                value={disableReason}
                onChange={(e) => setDisableReason(e.target.value)}
                placeholder="e.g., Investigating unusual activity"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-red-500 focus:border-red-500"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDisableConfirm(false);
                  setDisableReason('');
                }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={confirmDisableTrading}
                disabled={tradingStatusLoading}
                className="px-4 py-2 bg-red-600 text-white font-bold rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {tradingStatusLoading ? 'Stopping...' : 'STOP TRADING'}
              </button>
            </div>
          </div>
        </div>
      )}

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
