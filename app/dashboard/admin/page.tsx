'use client';

import { useEffect, useState } from 'react';
import { isAdmin, getTradingStatus, setTradingStatus, TradingStatus, getMentionMonitors, clearMentionMonitors, MentionMonitorsResponse, getAdminStats, AdminStatsResponse, MarketCaptureRun, RecentOrder, RecentTrade } from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function AdminPage() {
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
  
  // Admin stats state
  const [adminStats, setAdminStats] = useState<AdminStatsResponse | null>(null);
  const [adminStatsLoading, setAdminStatsLoading] = useState(false);
  
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
        loadTradingStatus(),
        loadMentionMonitors(),
        loadAdminStats()
      ]);
    } catch (err: any) {
      setError('Access denied');
      setTimeout(() => router.push('/dashboard'), 2000);
    }
  }

  async function loadAdminStats() {
    setAdminStatsLoading(true);
    try {
      const data = await getAdminStats();
      setAdminStats(data);
    } catch (err: any) {
      console.error('Failed to load admin stats:', err);
    } finally {
      setAdminStatsLoading(false);
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

  // Helper function to build Kalshi event URL from event_ticker
  // Event tickers follow format like: KXNBAMENTION-25DEC03OKCGSW
  // URL format: https://kalshi.com/events/KXNBAMENTION/KXNBAMENTION-25DEC03OKCGSW
  function buildEventUrl(eventTicker: string): string {
    if (!eventTicker) return '';
    // Extract the series ticker (everything before the first hyphen or the whole thing if it follows series pattern)
    // Most event tickers are like: SERIESNAME-DATE or SERIESNAME-DATEDETAILS
    const parts = eventTicker.split('-');
    const seriesTicker = parts[0];
    return `https://kalshi.com/events/${seriesTicker}/${eventTicker}`;
  }

  // Helper function to format timestamp for display
  function formatTimestamp(timestamp: number | string | null): string {
    if (!timestamp) return '-';
    try {
      const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;
      const date = new Date(ts * 1000);
      return date.toLocaleString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      });
    } catch {
      return '-';
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
                      <a 
                        href={buildEventUrl(monitor.event_ticker)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        {monitor.event_ticker}
                      </a>
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

      {/* Market Capture Runs Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            📊 Market Capture Runs
            {adminStatsLoading && (
              <span className="text-sm font-normal text-gray-500">Loading...</span>
            )}
          </h2>
          <button
            onClick={loadAdminStats}
            disabled={adminStatsLoading}
            className="px-3 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md disabled:opacity-50"
          >
            🔄 Refresh
          </button>
        </div>

        {adminStats && adminStats.market_capture_runs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Duration</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Markets Processed</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {adminStats.market_capture_runs.map((run, idx) => (
                  <tr key={run.timestamp} className={idx === 0 ? 'bg-green-50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                      {new Date(run.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono">
                      <span className={`${run.duration_sec > 60 ? 'text-orange-600' : 'text-green-600'}`}>
                        {run.duration_sec}s
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono text-gray-900">
                      {run.record_count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {adminStats && adminStats.market_capture_runs.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No recent market capture runs found
          </div>
        )}
      </div>

      {/* Recent Orders Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            📝 Recent Orders (20)
          </h2>
        </div>

        {adminStats && adminStats.recent_orders.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ticker</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Side</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Action</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Qty</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Price</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Idea</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {adminStats.recent_orders.map((order) => (
                  <tr key={order.order_id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                      {formatTimestamp(order.placed_at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-900">
                      {order.user_name}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <a 
                        href={`/dashboard/trades?ticker=${order.market_ticker}&user_name=${order.user_name}`}
                        className="text-blue-600 hover:underline font-mono text-xs"
                      >
                        {order.market_ticker.length > 30 
                          ? order.market_ticker.substring(0, 30) + '...' 
                          : order.market_ticker}
                      </a>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        order.side === 'yes' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {order.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-center text-gray-600">
                      {order.action}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-gray-900">
                      {order.quantity}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-gray-900">
                      ${order.limit_price.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        order.order_status === 'executed' ? 'bg-green-100 text-green-800' :
                        order.order_status === 'resting' ? 'bg-yellow-100 text-yellow-800' :
                        order.order_status === 'cancelled' ? 'bg-gray-100 text-gray-600' :
                        order.order_status === 'pending' ? 'bg-blue-100 text-blue-800' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {order.order_status}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600 text-xs">
                      {order.idea_name || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {adminStats && adminStats.recent_orders.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No recent orders found
          </div>
        )}
      </div>

      {/* Recent Trades Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            💰 Recent Trades (20)
          </h2>
        </div>

        {adminStats && adminStats.recent_trades.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ticker</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Side</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Action</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Filled</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Avg Price</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Idea</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {adminStats.recent_trades.map((trade) => (
                  <tr key={trade.order_id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                      {formatTimestamp(trade.completed_at || trade.placed_at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-900">
                      {trade.user_name}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <a 
                        href={`/dashboard/trades?ticker=${trade.market_ticker}&user_name=${trade.user_name}`}
                        className="text-blue-600 hover:underline font-mono text-xs"
                      >
                        {trade.market_ticker.length > 30 
                          ? trade.market_ticker.substring(0, 30) + '...' 
                          : trade.market_ticker}
                      </a>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        trade.side === 'yes' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {trade.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-center text-gray-600">
                      {trade.action}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-gray-900">
                      {trade.filled_count}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-gray-900">
                      ${trade.avg_fill_price.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-green-600">
                      ${trade.total_cost.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600 text-xs">
                      {trade.idea_name || '-'}
                      {trade.idea_version && <span className="text-gray-400 ml-1">v{trade.idea_version}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {adminStats && adminStats.recent_trades.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No recent trades found
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}
    </div>
  );
}
