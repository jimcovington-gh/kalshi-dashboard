'use client';

import { useEffect, useState } from 'react';
import { getPortfolio, Portfolio, getCurrentUser, isAdmin, getTradingStatus, setTradingStatus, TradingStatus, getMentionMonitors, clearMentionMonitors, MentionMonitor, MentionMonitorsResponse, UserMonitorSummary } from '@/lib/api';
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
  
  // Mention monitors state
  const [mentionMonitors, setMentionMonitors] = useState<MentionMonitorsResponse | null>(null);
  const [mentionMonitorsLoading, setMentionMonitorsLoading] = useState(false);
  const [clearingUser, setClearingUser] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState<string | null>(null);
  
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
        loadTradingStatus(),
        loadMentionMonitors()
      ]);
    } catch (err: any) {
      setError('Access denied');
      setTimeout(() => router.push('/dashboard'), 2000);
    }
  }

  async function loadMentionMonitors() {
    setMentionMonitorsLoading(true);
    try {
      const data = await getMentionMonitors();
      setMentionMonitors(data);
    } catch (err: any) {
      console.error('Failed to load mention monitors:', err);
    } finally {
      setMentionMonitorsLoading(false);
    }
  }

  async function handleClearMonitors(userName: string) {
    setClearingUser(userName);
    try {
      const result = await clearMentionMonitors(userName);
      if (result.success) {
        // Refresh the monitors list
        await loadMentionMonitors();
      } else {
        setError(`Failed to clear monitors: ${result.errors.join(', ')}`);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to clear monitors');
    } finally {
      setClearingUser(null);
      setShowClearConfirm(null);
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

  // Helper function to format time ago
  function formatTimeAgo(dateString: string): string {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      const diffDays = Math.floor(diffHr / 24);
      return `${diffDays}d ago`;
    } catch {
      return dateString;
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

      {/* Clear Monitors Confirmation Modal */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold text-orange-600 mb-4">⚠️ Clear Monitors for {showClearConfirm}?</h3>
            <p className="text-gray-700 mb-4">
              This will:
            </p>
            <ul className="list-disc list-inside text-gray-600 mb-4 space-y-1">
              <li>Stop the running Fargate task</li>
              <li>Clear all active event monitors</li>
              <li>Mark events as cleared in the database</li>
            </ul>
            <p className="text-sm text-gray-500 mb-4">
              The monitors can be re-launched by the TradingManager Lambda on the next scheduled run.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowClearConfirm(null)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => handleClearMonitors(showClearConfirm)}
                disabled={clearingUser !== null}
                className="px-4 py-2 bg-orange-600 text-white font-bold rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                {clearingUser === showClearConfirm ? 'Clearing...' : 'Clear Monitors'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mention Monitors Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            📡 Mention Monitors
            {mentionMonitorsLoading && (
              <span className="text-sm font-normal text-gray-500">Loading...</span>
            )}
          </h2>
          <button
            onClick={loadMentionMonitors}
            disabled={mentionMonitorsLoading}
            className="px-3 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md disabled:opacity-50"
          >
            🔄 Refresh
          </button>
        </div>

        {/* Summary Cards */}
        {mentionMonitors && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-cyan-50 p-4 rounded-lg">
              <div className="text-sm text-gray-600">Running Fargate Tasks</div>
              <div className="text-3xl font-bold text-cyan-600">{mentionMonitors.total_running_fargate}</div>
            </div>
            <div className="bg-indigo-50 p-4 rounded-lg">
              <div className="text-sm text-gray-600">Active Events</div>
              <div className="text-3xl font-bold text-indigo-600">{mentionMonitors.total_active_events}</div>
            </div>
            <div className="bg-amber-50 p-4 rounded-lg">
              <div className="text-sm text-gray-600">Users with Monitors</div>
              <div className="text-3xl font-bold text-amber-600">{Object.keys(mentionMonitors.users).length}</div>
            </div>
          </div>
        )}

        {/* User Summary Cards with Clear Buttons */}
        {mentionMonitors && Object.keys(mentionMonitors.users).length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 uppercase mb-3">Users</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(mentionMonitors.users).map(([userName, summary]) => (
                <div key={userName} className="border rounded-lg p-4 flex justify-between items-center bg-gray-50">
                  <div>
                    <div className="font-semibold text-gray-900">{userName}</div>
                    <div className="text-sm text-gray-600">
                      {summary.active_events} active, {summary.pending_events} pending
                    </div>
                    <div className="text-xs text-gray-500">
                      Fargate: <span className={`font-medium ${
                        summary.fargate_state === 'running' ? 'text-green-600' : 
                        summary.fargate_state === 'none' ? 'text-gray-400' : 'text-orange-500'
                      }`}>
                        {summary.fargate_state}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowClearConfirm(userName)}
                    disabled={clearingUser !== null || (!summary.has_fargate && summary.active_events === 0)}
                    className="px-3 py-1 text-sm font-medium text-orange-600 hover:text-orange-800 hover:bg-orange-50 rounded-md disabled:opacity-50 disabled:cursor-not-allowed border border-orange-200"
                  >
                    {clearingUser === userName ? '...' : 'Clear'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Monitors Table */}
        {mentionMonitors && mentionMonitors.monitors.length > 0 && (
          <div className="overflow-x-auto">
            <h3 className="text-sm font-semibold text-gray-700 uppercase mb-3">Active Monitors</h3>
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Event</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Phase</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">State</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Start Time</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Heartbeat</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {mentionMonitors.monitors.map((monitor) => (
                  <tr key={monitor.event_ticker} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{monitor.event_ticker}</div>
                      {monitor.fargate_instance_id && (
                        <div className="text-xs text-gray-400">Instance: {monitor.fargate_instance_id}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                      {monitor.user_name}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        monitor.phase === 'phase1' ? 'bg-yellow-100 text-yellow-800' :
                        monitor.phase === 'phase2' ? 'bg-blue-100 text-blue-800' :
                        monitor.phase === 'phase3' ? 'bg-green-100 text-green-800' :
                        monitor.phase === 'phase4' ? 'bg-purple-100 text-purple-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {monitor.phase}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        monitor.fargate_state === 'active' ? 'bg-green-100 text-green-800' :
                        monitor.fargate_state === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                        monitor.fargate_state === 'running' ? 'bg-cyan-100 text-cyan-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {monitor.fargate_state}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                      {monitor.start_date ? new Date(monitor.start_date).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                      {monitor.last_heartbeat ? (
                        <span title={monitor.last_heartbeat}>
                          {formatTimeAgo(monitor.last_heartbeat)}
                        </span>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {mentionMonitors && mentionMonitors.monitors.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No active mention monitors
          </div>
        )}

        {mentionMonitors?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
            Error loading monitors: {mentionMonitors.error}
          </div>
        )}
      </div>

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
