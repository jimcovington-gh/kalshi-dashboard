'use client';

import { useEffect, useState } from 'react';
import { isAdmin, getTradingStatus, setTradingStatus, setUserIdeaToggle, TradingStatus, TradingIdea, UserTradingStatus, getMentionMonitors, clearMentionMonitors, MentionMonitorsResponse, getAdminStats, AdminStatsResponse, MarketCaptureRun, RecentOrder, RecentTrade, UpcomingMentionEvent } from '@/lib/api';
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
  
  // Per-user/per-idea toggle state
  const [toggleLoading, setToggleLoading] = useState<string | null>(null); // Format: "user_name#idea_id"
  
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

  async function handleUserIdeaToggle(userName: string, ideaId: string, currentEnabled: boolean) {
    const toggleKey = `${userName}#${ideaId}`;
    const newEnabled = !currentEnabled;
    
    // Optimistic update: Update UI immediately before API call
    if (tradingStatus?.users) {
      setTradingStatusState(prev => {
        if (!prev?.users) return prev;
        return {
          ...prev,
          users: prev.users.map(user => {
            if (user.user_name !== userName) return user;
            return {
              ...user,
              ideas: {
                ...user.ideas,
                [ideaId]: {
                  ...user.ideas[ideaId],
                  enabled: newEnabled,
                  updated_at: new Date().toISOString()
                }
              }
            };
          })
        };
      });
    }
    
    setToggleLoading(toggleKey);
    try {
      await setUserIdeaToggle(userName, ideaId, newEnabled);
      // Refresh to sync with server (in case of any discrepancies)
      await loadTradingStatus();
    } catch (err: any) {
      // Rollback on error: revert to previous state
      if (tradingStatus?.users) {
        setTradingStatusState(prev => {
          if (!prev?.users) return prev;
          return {
            ...prev,
            users: prev.users.map(user => {
              if (user.user_name !== userName) return user;
              return {
                ...user,
                ideas: {
                  ...user.ideas,
                  [ideaId]: {
                    ...user.ideas[ideaId],
                    enabled: currentEnabled // Revert to original
                  }
                }
              };
            })
          };
        });
      }
      setError(err.message || 'Failed to toggle user idea status');
    } finally {
      setToggleLoading(null);
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

  // Helper function to format relative time (past or future) in HH:MM format
  function formatRelativeTime(dateString: string): string {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = date.getTime() - now.getTime();
      const isFuture = diffMs > 0;
      const absDiffMs = Math.abs(diffMs);
      const absDiffMin = Math.floor(absDiffMs / 60000);
      
      const hours = Math.floor(absDiffMin / 60);
      const mins = absDiffMin % 60;
      
      const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
      
      return isFuture ? `in ${timeStr}` : `${timeStr} ago`;
    } catch {
      return dateString;
    }
  }

  // Helper function to build Kalshi event URL from event_ticker
  function buildEventUrl(eventTicker: string): string {
    if (!eventTicker) return '';
    const parts = eventTicker.split('-');
    const seriesTicker = parts[0];
    return `https://kalshi.com/markets/${seriesTicker}/${eventTicker}`;
  }

  // Helper function to build Kalshi event URL from market_ticker
  function buildMarketUrlFromTicker(marketTicker: string): string {
    if (!marketTicker) return '';
    // Extract event ticker by removing the last segment (market suffix)
    const parts = marketTicker.split('-');
    if (parts.length < 2) return '';
    const seriesTicker = parts[0];
    const eventTicker = parts.slice(0, -1).join('-');
    return `https://kalshi.com/markets/${seriesTicker}/${eventTicker}`;
  }

  // Helper function to format timestamp for display (compact)
  function formatTimestamp(timestamp: number | string | null): string {
    if (!timestamp) return '-';
    try {
      const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;
      const date = new Date(ts * 1000);
      return date.toLocaleString('en-US', { 
        month: 'numeric', 
        day: 'numeric', 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch {
      return '-';
    }
  }

  // Helper to format hours until start
  function formatHoursUntil(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${Math.round(hours / 24)}d`;
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

      {/* Per-User/Per-Idea Trading Controls */}
      {tradingStatus?.ideas && tradingStatus?.users && tradingStatus.users.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              🎛️ Trading Idea Controls
              {tradingStatus.shutdown_active && (
                <span className="text-xs font-normal text-red-600">(Master shutdown active)</span>
              )}
            </h2>
            <button
              onClick={loadTradingStatus}
              disabled={tradingStatusLoading}
              className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
            >
              🔄
            </button>
          </div>
          
          {/* Mobile-friendly responsive grid */}
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-2 text-left font-semibold text-gray-700 sticky left-0 bg-gray-50">User</th>
                  {tradingStatus.ideas.map((idea) => (
                    <th key={idea.idea_id} className="px-2 py-2 text-center font-semibold text-gray-700 whitespace-nowrap">
                      <div title={idea.description}>{idea.display_name}</div>
                    </th>
                  ))}
                  <th className="px-2 py-2 text-center font-semibold text-gray-700 whitespace-nowrap border-l-2 border-orange-200">
                    <div title="Stop Fargate task and clear all monitors for user">Monitors</div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tradingStatus.users.map((user) => (
                  <tr key={user.user_name} className="hover:bg-gray-50">
                    <td className="px-2 py-2 font-medium text-gray-900 sticky left-0 bg-white">
                      {user.user_name}
                    </td>
                    {tradingStatus.ideas!.map((idea) => {
                      const ideaStatus = user.ideas[idea.idea_id];
                      const isEnabled = ideaStatus?.enabled ?? false;
                      const toggleKey = `${user.user_name}#${idea.idea_id}`;
                      const isLoading = toggleLoading === toggleKey;
                      const isDisabledByMaster = tradingStatus.shutdown_active ?? false;
                      
                      return (
                        <td key={idea.idea_id} className="px-2 py-2 text-center">
                          <button
                            onClick={() => handleUserIdeaToggle(user.user_name, idea.idea_id, isEnabled)}
                            disabled={isLoading || isDisabledByMaster}
                            className={`
                              px-3 py-1 rounded text-xs font-bold uppercase tracking-wide
                              transition-colors duration-200 min-w-[4rem]
                              ${isDisabledByMaster 
                                ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
                                : isEnabled 
                                  ? 'bg-green-500 hover:bg-green-600 text-white' 
                                  : 'bg-red-500 hover:bg-red-600 text-white'
                              }
                              ${isLoading ? 'animate-pulse' : ''}
                            `}
                            title={
                              isDisabledByMaster 
                                ? 'Master shutdown is active' 
                                : `Click to ${isEnabled ? 'disable' : 'enable'}`
                            }
                          >
                            {isLoading ? '...' : isEnabled ? 'ON' : 'OFF'}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-center border-l-2 border-orange-200">
                      <button
                        onClick={() => setShowClearConfirm(user.user_name)}
                        disabled={clearingUser !== null}
                        className="px-2 py-1 rounded text-xs font-bold text-orange-700 bg-orange-100 hover:bg-orange-200 border border-orange-300 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Stop Fargate task and clear all monitors for this user"
                      >
                        {clearingUser === user.user_name ? '...' : 'Clear'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
            <div className="flex items-center gap-1">
              <span className="px-2 py-0.5 rounded bg-green-500 text-white text-xs font-bold">ON</span>
              <span>Trading enabled</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="px-2 py-0.5 rounded bg-red-500 text-white text-xs font-bold">OFF</span>
              <span>Trading disabled</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="px-2 py-0.5 rounded bg-gray-300 text-gray-500 text-xs font-bold">OFF</span>
              <span>Blocked by master</span>
            </div>
            <div className="flex items-center gap-1 border-l pl-4 border-orange-200">
              <span className="px-2 py-0.5 rounded bg-orange-100 text-orange-700 text-xs font-bold border border-orange-300">Clear</span>
              <span>Stop monitors &amp; Fargate task</span>
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

      {/* Side-by-side: Active Monitors Table + Upcoming Mentions (desktop) / Stacked (mobile) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active Monitors Compact Table */}
        <div className="bg-white rounded-lg shadow p-4 order-1">
          <h2 className="text-lg font-bold text-gray-900 mb-2">🎯 Active Monitors</h2>
          {mentionMonitors && mentionMonitors.monitors.length > 0 ? (
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Event</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">User</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">State</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Phase</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Start Time</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Heartbeat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {mentionMonitors.monitors.map((m) => (
                  <tr key={m.event_ticker}>
                    <td className="px-2 py-1">
                      <a href={buildEventUrl(m.event_ticker)} target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline font-mono text-xs">{m.event_ticker}</a>
                    </td>
                    <td className="px-2 py-1">{m.user_name}</td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1 py-0.5 rounded text-xs ${m.fargate_state === 'active' ? 'bg-green-100 text-green-700' : m.fargate_state === 'pending' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>{m.fargate_state}</span>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1 py-0.5 rounded text-xs ${m.phase === 'phase1' ? 'bg-yellow-100 text-yellow-700' : m.phase === 'phase2' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>{m.phase}</span>
                    </td>
                    <td className="px-2 py-1 text-gray-600 text-xs">
                      {m.start_date ? formatRelativeTime(m.start_date) : '-'}
                    </td>
                    <td className="px-2 py-1 text-gray-600">{m.last_heartbeat ? formatTimeAgo(m.last_heartbeat) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-4 text-gray-500 text-sm">No active monitors</div>
          )}
        </div>

        {/* Upcoming Mention Events */}
        <div className="bg-white rounded-lg shadow p-4 order-2">
          <h2 className="text-lg font-bold text-gray-900 mb-2">⏰ Upcoming Mentions (24h)</h2>
          {adminStats && adminStats.upcoming_mention_events && adminStats.upcoming_mention_events.length > 0 ? (
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Event</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Title</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500">Starts In</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {adminStats.upcoming_mention_events.map((evt) => (
                  <tr key={evt.event_ticker} className={evt.hours_until_start < 2 ? 'bg-yellow-50' : ''}>
                    <td className="px-2 py-1">
                      <a href={buildEventUrl(evt.event_ticker)} target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline font-mono">{evt.event_ticker}</a>
                    </td>
                    <td className="px-2 py-1 text-gray-700 max-w-xs truncate" title={evt.title}>{evt.title}</td>
                    <td className="px-2 py-1 text-right font-mono">
                      <span className={evt.hours_until_start < 2 ? 'text-orange-600 font-semibold' : 'text-gray-600'}>
                        {formatHoursUntil(evt.hours_until_start)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-4 text-gray-500 text-sm">No upcoming mention events</div>
          )}
        </div>
      </div>

      {/* Market Capture Runs Section */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-lg font-bold text-gray-900">📊 Market Capture (2min)</h2>
          <button onClick={loadAdminStats} disabled={adminStatsLoading}
            className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50">🔄</button>
        </div>
        {adminStats && adminStats.market_capture_runs.length > 0 && (
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-1 text-left font-medium text-gray-500">Time</th>
                <th className="px-2 py-1 text-right font-medium text-gray-500">Duration</th>
                <th className="px-2 py-1 text-right font-medium text-gray-500">Markets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {adminStats.market_capture_runs.map((run, idx) => (
                <tr key={run.timestamp} className={idx === 0 ? 'bg-green-50' : ''}>
                  <td className="px-2 py-1 text-gray-700">{new Date(run.timestamp).toLocaleTimeString()}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    <span className={run.duration_sec > 60 ? 'text-orange-600' : 'text-green-600'}>{run.duration_sec}s</span>
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{run.record_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent Orders Section - links to Kalshi */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-bold text-gray-900 mb-2">📝 Recent Orders</h2>
        {adminStats && adminStats.recent_orders.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '12%'}}>Time</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '10%'}}>User</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '35%'}}>Market</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500" style={{width: '8%'}}>Side</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500" style={{width: '8%'}}>Qty</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500" style={{width: '10%'}}>Price</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '22%'}}>Idea</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {adminStats.recent_orders.map((order) => (
                  <tr key={order.order_id} className="hover:bg-gray-50">
                    <td className="px-2 py-1 text-gray-600 whitespace-nowrap" style={{width: '12%'}}>{formatTimestamp(order.placed_at)}</td>
                    <td className="px-2 py-1 font-medium" style={{width: '10%'}}>{order.user_name}</td>
                    <td className="px-2 py-1 whitespace-nowrap" style={{width: '35%'}}>
                      <a href={buildMarketUrlFromTicker(order.market_ticker)}
                        target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline font-mono">
                        {order.market_ticker}
                      </a>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${order.side === 'yes' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                        {order.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{order.quantity}</td>
                    <td className="px-2 py-1 text-right font-mono">${order.limit_price.toFixed(2)}</td>
                    <td className="px-2 py-1 text-left text-gray-600 truncate max-w-[120px]" title={order.idea_name || ''}>
                      {order.idea_name || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {adminStats && adminStats.recent_orders.length === 0 && (
          <div className="text-center py-4 text-gray-500 text-sm">No recent orders</div>
        )}
      </div>

      {/* Recent Trades Section - links to trade details */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-bold text-gray-900 mb-2">💰 Recent Trades</h2>
        {adminStats && adminStats.recent_trades.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '12%'}}>Time</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '10%'}}>User</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '35%'}}>Market</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500" style={{width: '8%'}}>Side</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500" style={{width: '8%'}}>Filled</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500" style={{width: '8%'}}>Price</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500" style={{width: '10%'}}>Total</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '16%'}}>Idea</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {adminStats.recent_trades.map((trade) => (
                  <tr key={trade.order_id} className="hover:bg-gray-50">
                    <td className="px-2 py-1 text-gray-600 whitespace-nowrap" style={{width: '12%'}}>{formatTimestamp(trade.completed_at || trade.placed_at)}</td>
                    <td className="px-2 py-1 font-medium" style={{width: '10%'}}>{trade.user_name}</td>
                    <td className="px-2 py-1 whitespace-nowrap" style={{width: '35%'}}>
                      <a href={`/dashboard/trades?ticker=${trade.market_ticker}&user_name=${trade.user_name}`}
                        className="text-blue-600 hover:underline font-mono">
                        {trade.market_ticker}
                      </a>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${trade.side === 'yes' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                        {trade.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{trade.filled_count}</td>
                    <td className="px-2 py-1 text-right font-mono">${trade.avg_fill_price.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right font-mono font-semibold text-green-600">${trade.total_cost.toFixed(2)}</td>
                    <td className="px-2 py-1 text-gray-600">{trade.idea_name || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {adminStats && adminStats.recent_trades.length === 0 && (
          <div className="text-center py-4 text-gray-500 text-sm">No recent trades</div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
