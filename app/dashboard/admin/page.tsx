'use client';

import { useEffect, useState } from 'react';
import { isAdmin, getTradingStatus, setTradingStatus, setUserIdeaToggle, TradingStatus, TradingIdea, UserTradingStatus, getMentionMonitors, clearMentionMonitors, MentionMonitorsResponse, getAdminStats, AdminStatsResponse, MarketCaptureRun, RecentOrder, RecentTrade, UpcomingMentionEvent, getVolatileWatchlist, VolatileWatchlistResponse, getVolatileOrders, VolatileOrdersResponse, getRunningVoiceContainers, stopVoiceContainer, RunningVoiceContainer, RunningVoiceContainersResponse, getRecorderSettings, setRecorderSetting, getRecorderStatus, RecorderSettings, RecorderStatus, getSportsCaptures, SportsCapture } from '@/lib/api';
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
  
  // Volatile watchlist state
  const [volatileWatchlist, setVolatileWatchlist] = useState<VolatileWatchlistResponse | null>(null);
  const [volatileWatchlistLoading, setVolatileWatchlistLoading] = useState(false);
  
  // Volatile orders state
  const [volatileOrders, setVolatileOrders] = useState<VolatileOrdersResponse | null>(null);
  const [volatileOrdersLoading, setVolatileOrdersLoading] = useState(false);
  
  // Voice trader containers state
  const [voiceContainers, setVoiceContainers] = useState<RunningVoiceContainersResponse | null>(null);
  const [voiceContainersLoading, setVoiceContainersLoading] = useState(false);
  const [stoppingContainer, setStoppingContainer] = useState<string | null>(null);
  
  // Per-user/per-idea toggle state
  const [toggleLoading, setToggleLoading] = useState<string | null>(null); // Format: "user_name#idea_id"

  // Orderbook Recorder state
  const [recorderSettings, setRecorderSettings] = useState<RecorderSettings | null>(null);
  const [recorderSettingsLoading, setRecorderSettingsLoading] = useState(false);
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus | null>(null);
  const [recorderStatusLoading, setRecorderStatusLoading] = useState(false);
  const [recorderToggleLoading, setRecorderToggleLoading] = useState<string | null>(null);
  const [sportsCaptures, setSportsCaptures] = useState<SportsCapture[]>([]);
  const [sportsCapturesLoading, setSportsCapturesLoading] = useState(false);
  
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
        loadAdminStats(),
        loadVolatileWatchlist(),
        loadVolatileOrders(),
        loadVoiceContainers(),
        loadRecorderSettings(),
        loadRecorderStatus(),
        loadSportsCaptures(),
      ]);
    } catch (err: any) {
      setError('Access denied');
      setTimeout(() => router.push('/dashboard'), 2000);
    }
  }

  async function loadRecorderSettings() {
    setRecorderSettingsLoading(true);
    try {
      const data = await getRecorderSettings();
      setRecorderSettings(data);
    } catch (err: any) {
      console.error('Failed to load recorder settings:', err);
    } finally {
      setRecorderSettingsLoading(false);
    }
  }

  async function loadRecorderStatus() {
    setRecorderStatusLoading(true);
    try {
      const data = await getRecorderStatus();
      setRecorderStatus(data);
    } catch (err: any) {
      console.error('Failed to load recorder status:', err);
    } finally {
      setRecorderStatusLoading(false);
    }
  }

  async function handleRecorderToggle(key: string) {
    if (!recorderSettings) return;
    const currentValue = recorderSettings[key as keyof RecorderSettings];
    const newValue = !currentValue;
    setRecorderToggleLoading(key);
    try {
      const updated = await setRecorderSetting(key, newValue);
      setRecorderSettings(updated);
      // Flags are cached in TIS for 60s; refresh status after a short delay
      setTimeout(() => loadRecorderStatus(), 1500);
    } catch (err: any) {
      setError(`Failed to update recorder setting: ${err.message}`);
    } finally {
      setRecorderToggleLoading(null);
    }
  }

  async function loadSportsCaptures() {
    setSportsCapturesLoading(true);
    try {
      const data = await getSportsCaptures();
      setSportsCaptures(data.captures);
    } catch (err: any) {
      console.error('Failed to load sports captures:', err);
    } finally {
      setSportsCapturesLoading(false);
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

  async function loadVolatileWatchlist() {
    setVolatileWatchlistLoading(true);
    try {
      const data = await getVolatileWatchlist();
      setVolatileWatchlist(data);
    } catch (err: any) {
      console.error('Failed to load volatile watchlist:', err);
    } finally {
      setVolatileWatchlistLoading(false);
    }
  }

  async function loadVolatileOrders() {
    setVolatileOrdersLoading(true);
    try {
      const data = await getVolatileOrders(24);
      setVolatileOrders(data);
    } catch (err: any) {
      console.error('Failed to load volatile orders:', err);
    } finally {
      setVolatileOrdersLoading(false);
    }
  }

  async function loadVoiceContainers() {
    setVoiceContainersLoading(true);
    try {
      const data = await getRunningVoiceContainers();
      setVoiceContainers(data);
    } catch (err: any) {
      console.error('Failed to load voice containers:', err);
    } finally {
      setVoiceContainersLoading(false);
    }
  }

  async function handleStopVoiceContainer(sessionId: string) {
    setStoppingContainer(sessionId);
    try {
      await stopVoiceContainer(sessionId);
      await loadVoiceContainers();
    } catch (err: any) {
      setError(`Failed to stop container: ${err.message}`);
    } finally {
      setStoppingContainer(null);
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

  // Helper function to build Kalshi market URL from market_ticker
  // Format: https://kalshi.com/markets/<prefix>/<market_ticker>
  function buildKalshiMarketUrl(marketTicker: string): string {
    if (!marketTicker) return '';
    const prefix = marketTicker.split('-')[0];
    return `https://kalshi.com/markets/${prefix}/${marketTicker}`;
  }

  // Helper function to build Kalshi event URL from event_ticker (for mention events)
  // Format: https://kalshi.com/markets/<prefix>/<event_ticker>
  function buildEventUrl(eventTicker: string): string {
    if (!eventTicker) return '';
    const prefix = eventTicker.split('-')[0];
    return `https://kalshi.com/markets/${prefix}/${eventTicker}`;
  }

  // Abbreviate an event ticker into a short readable title
  // e.g. "KXNFLMENTION-25DEC22SFIND" → "NFL Mention SFIND"
  //      "KXNCAAMBGAME-26FEB25URISBON" → "NCAAMB URISBON"
  //      "KXBTC-26FEB25" → "BTC 26FEB25"
  function abbreviateGroupKey(groupKey: string): string {
    if (!groupKey) return groupKey;
    const parts = groupKey.split('-');
    // First part is the Kalshi series prefix like KXNFLMENTION, KXNCAAMBGAME, etc.
    const seriesPrefix = parts[0] || '';
    // Strip 'KX' prefix
    let series = seriesPrefix.startsWith('KX') ? seriesPrefix.slice(2) : seriesPrefix;
    // Extract the suffix part (team codes, etc.) — everything after the date portion in the last segment
    // Date pattern: 2-digit day + 3-letter month + 2-digit year (e.g. 25DEC22, 26FEB25)
    const rest = parts.slice(1).join('-');
    const dateMatch = rest.match(/^(\d{2}[A-Z]{3}\d{2})(.*)/); 
    let suffix = '';
    if (dateMatch) {
      suffix = dateMatch[2]; // everything after the date
    } else {
      suffix = rest;
    }
    // Clean up series name: split known patterns
    series = series
      .replace(/MENTION$/, ' Mention')
      .replace(/GAME$/, '')
      .replace(/SPREAD$/, ' Spread')
      .replace(/TOTAL$/, ' Total');
    const display = suffix ? `${series} ${suffix}` : series || groupKey;
    return display.trim();
  }

  // Helper function to build Kalshi market URL from market_ticker (for volatile watchlist/orders)
  // Format: https://kalshi.com/markets/<prefix>/<market_ticker>
  function buildMarketUrlFromTicker(marketTicker: string): string {
    if (!marketTicker) return '';
    const prefix = marketTicker.split('-')[0];
    return `https://kalshi.com/markets/${prefix}/${marketTicker}`;
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
      {/* Admin Navigation */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
        <a
          href="/dashboard/admin/devices"
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
        >
          🔐 Device Management
        </a>
      </div>

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
              <div className="mt-2 text-base text-gray-600">
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
                  <p className="text-gray-400 text-sm mt-1">
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
              <label className="block text-base font-medium text-gray-700 mb-1">
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
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              🎛️ Trading Idea Controls
              {tradingStatus.shutdown_active && (
                <span className="text-base font-normal text-red-600">(Master shutdown active)</span>
              )}
            </h2>
            <button
              onClick={loadTradingStatus}
              disabled={tradingStatusLoading}
              className="px-2 py-1 text-base text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
            >
              🔄
            </button>
          </div>
          
          {/* Mobile-friendly responsive grid */}
          <div className="overflow-x-auto">
            <table className="min-w-full text-base">
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
                              px-3 py-1 rounded text-base font-bold uppercase tracking-wide
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
                        className="px-2 py-1 rounded text-base font-bold text-orange-700 bg-orange-100 hover:bg-orange-200 border border-orange-300 disabled:opacity-50 disabled:cursor-not-allowed"
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
          <div className="mt-3 flex flex-wrap gap-4 text-base text-gray-500">
            <div className="flex items-center gap-1">
              <span className="px-2 py-0.5 rounded bg-green-500 text-white text-base font-bold">ON</span>
              <span>Trading enabled</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="px-2 py-0.5 rounded bg-red-500 text-white text-base font-bold">OFF</span>
              <span>Trading disabled</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="px-2 py-0.5 rounded bg-gray-300 text-gray-500 text-base font-bold">OFF</span>
              <span>Blocked by master</span>
            </div>
            <div className="flex items-center gap-1 border-l pl-4 border-orange-200">
              <span className="px-2 py-0.5 rounded bg-orange-100 text-orange-700 text-base font-bold border border-orange-300">Clear</span>
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
            <p className="text-base text-gray-500 mb-4">
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
          <h2 className="text-xl font-bold text-gray-900 mb-2">🎯 Active Monitors</h2>
          {mentionMonitors && mentionMonitors.monitors.length > 0 ? (
            <table className="min-w-full text-base">
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
                        className="text-blue-600 hover:underline font-mono text-base">{m.event_ticker}</a>
                    </td>
                    <td className="px-2 py-1">{m.user_name}</td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1 py-0.5 rounded text-sm ${m.fargate_state === 'active' ? 'bg-green-100 text-green-700' : m.fargate_state === 'pending' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>{m.fargate_state}</span>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1 py-0.5 rounded text-sm ${m.phase === 'phase1' ? 'bg-yellow-100 text-yellow-700' : m.phase === 'phase2' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>{m.phase}</span>
                    </td>
                    <td className="px-2 py-1 text-gray-600 text-base">
                      {m.start_date ? formatRelativeTime(m.start_date) : '-'}
                    </td>
                    <td className="px-2 py-1 text-gray-600">{m.last_heartbeat ? formatTimeAgo(m.last_heartbeat) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-4 text-gray-500 text-base">No active monitors</div>
          )}
        </div>

        {/* Upcoming Mention Events */}
        <div className="bg-white rounded-lg shadow p-4 order-2">
          <h2 className="text-xl font-bold text-gray-900 mb-2">⏰ Upcoming Mentions</h2>
          {adminStats && adminStats.upcoming_mention_events && adminStats.upcoming_mention_events.length > 0 ? (
            <table className="min-w-full text-base">
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
            <div className="text-center py-4 text-gray-500 text-base">No upcoming mention events</div>
          )}
        </div>
      </div>

      {/* Market Capture Runs Section */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-xl font-bold text-gray-900">📊 Market Capture (2min)</h2>
          <button onClick={loadAdminStats} disabled={adminStatsLoading}
            className="px-2 py-1 text-base text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50">🔄</button>
        </div>
        {adminStats && adminStats.market_capture_runs.length > 0 && (
          <table className="min-w-full text-base">
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
        <h2 className="text-xl font-bold text-gray-900 mb-2">📝 Recent Orders</h2>
        {adminStats && adminStats.recent_orders.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '12%'}}>Time</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '10%'}}>User</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '28%'}}>Market</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500" style={{width: '8%'}}>Side</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500" style={{width: '8%'}}>Qty</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500" style={{width: '10%'}}>Price</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '24%'}}>Idea</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {adminStats.recent_orders.map((order) => (
                  <tr key={order.order_id} className="hover:bg-gray-50">
                    <td className="px-2 py-1 whitespace-nowrap" style={{width: '12%'}}>
                      <a href={`/dashboard/trades?ticker=${encodeURIComponent(order.market_ticker)}&user_name=${encodeURIComponent(order.user_name)}`}
                        className="text-blue-600 hover:underline">
                        {formatTimestamp(order.placed_at)}
                      </a>
                    </td>
                    <td className="px-2 py-1 font-medium text-gray-900" style={{width: '10%'}}>{order.user_name}</td>
                    <td className="px-2 py-1 whitespace-nowrap" style={{width: '28%'}}>
                      <a href={buildKalshiMarketUrl(order.market_ticker)}
                        target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline font-mono">
                        {order.market_ticker}
                      </a>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-base font-semibold ${order.side === 'yes' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                        {order.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-gray-900">{order.quantity}</td>
                    <td className="px-2 py-1 text-right font-mono text-gray-900">${order.limit_price.toFixed(2)}</td>
                    <td className="px-2 py-1 text-left text-gray-600" style={{width: '24%'}}>
                      {order.idea_name || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {adminStats && adminStats.recent_orders.length === 0 && (
          <div className="text-center py-4 text-gray-500 text-base">No recent orders</div>
        )}
      </div>

      {/* Recent Trades Section - links to trade details */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-xl font-bold text-gray-900 mb-2">💰 Recent Trades</h2>
        {adminStats && adminStats.recent_trades.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '12%'}}>Time</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '10%'}}>User</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500" style={{width: '28%'}}>Market</th>
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
                    <td className="px-2 py-1 whitespace-nowrap" style={{width: '12%'}}>
                      <a href={`/dashboard/trades?ticker=${encodeURIComponent(trade.market_ticker)}&user_name=${encodeURIComponent(trade.user_name)}`}
                        className="text-blue-600 hover:underline">
                        {formatTimestamp(trade.completed_at || trade.placed_at)}
                      </a>
                    </td>
                    <td className="px-2 py-1 font-medium text-gray-900" style={{width: '10%'}}>{trade.user_name}</td>
                    <td className="px-2 py-1 whitespace-nowrap" style={{width: '28%'}}>
                      <a href={buildKalshiMarketUrl(trade.market_ticker)}
                        target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline font-mono">
                        {trade.market_ticker}
                      </a>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-base font-semibold ${trade.side === 'yes' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                        {trade.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-gray-900">{trade.filled_count}</td>
                    <td className="px-2 py-1 text-right font-mono text-gray-900">${trade.avg_fill_price.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right font-mono font-semibold text-green-600">${trade.total_cost.toFixed(2)}</td>
                    <td className="px-2 py-1 text-gray-600">{trade.idea_name || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {adminStats && adminStats.recent_trades.length === 0 && (
          <div className="text-center py-4 text-gray-500 text-base">No recent trades</div>
        )}
      </div>

      {/* Voice Trader Containers Section */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            🎙️ Running Voice Trader Containers
          </h2>
          <button onClick={loadVoiceContainers} disabled={voiceContainersLoading}
            className="px-2 py-1 text-base text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50">🔄</button>
        </div>

        {voiceContainers && voiceContainers.containers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Session</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Event</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">User</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Status</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Call State</th>
                  <th className="px-2 py-1 text-right font-medium text-gray-500">Started</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {voiceContainers.containers.map((container) => {
                  const startedDate = new Date(container.started_at);
                  const now = new Date();
                  const diffMs = now.getTime() - startedDate.getTime();
                  const diffMin = Math.floor(diffMs / 60000);
                  const hours = Math.floor(diffMin / 60);
                  const mins = diffMin % 60;
                  const ageStr = `${hours}h ${mins}m`;
                  
                  const callStateColor = container.call_state === 'in_progress' 
                    ? 'bg-green-100 text-green-700' 
                    : container.call_state === 'qa_session'
                    ? 'bg-orange-100 text-orange-700'
                    : container.call_state === 'disconnected'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-gray-100 text-gray-700';
                  
                  return (
                    <tr key={container.session_id}>
                      <td className="px-2 py-1 whitespace-nowrap font-mono text-base">
                        {container.session_id}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        <div className="font-medium text-gray-900 text-sm truncate max-w-[200px]" title={container.title}>
                          {container.title}
                        </div>
                        <div className="text-gray-500 text-sm truncate max-w-[200px]">{container.event_ticker}</div>
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-gray-700">{container.user_name}</td>
                      <td className="px-2 py-1 text-center">
                        <span className="px-1.5 py-0.5 rounded text-sm bg-blue-100 text-blue-700">
                          {container.status}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-sm ${callStateColor}`}>
                          {container.call_state || 'unknown'}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right text-gray-600 whitespace-nowrap">{ageStr} ago</td>
                      <td className="px-2 py-1 text-center">
                        <div className="flex gap-1 justify-center">
                          <a
                            href={`/dashboard/voice-trader?session=${container.session_id}`}
                            className="px-2 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                          >
                            Monitor
                          </a>
                          <button
                            onClick={() => handleStopVoiceContainer(container.session_id)}
                            disabled={stoppingContainer === container.session_id}
                            className="px-2 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50"
                          >
                            {stoppingContainer === container.session_id ? '...' : 'Stop'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : voiceContainers ? (
          <div className="text-center py-4 text-gray-500 text-base">No running voice trader containers</div>
        ) : (
          <div className="text-center py-4 text-gray-400 text-base">Loading...</div>
        )}
      </div>

      {/* Volatile Watchlist Section - High-Confidence Volatility Tracking */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            📈 High-Confidence Volatility Watchlist
          </h2>
          <button onClick={loadVolatileWatchlist} disabled={volatileWatchlistLoading}
            className="px-2 py-1 text-base text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50">🔄</button>
        </div>

        {volatileWatchlist && volatileWatchlist.watchlist.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-1.5 py-1 text-left font-medium text-gray-500 whitespace-nowrap">Market</th>
                  <th className="px-1.5 py-1 text-center font-medium text-gray-500 whitespace-nowrap">Side</th>
                  <th className="px-1.5 py-1 text-right font-medium text-gray-500 whitespace-nowrap">Age</th>
                  <th className="px-1.5 py-1 text-right font-medium text-gray-500 whitespace-nowrap">Initial</th>
                  <th className="px-1.5 py-1 text-right font-medium text-gray-500 whitespace-nowrap">Current</th>
                  <th className="px-1.5 py-1 text-right font-medium text-gray-500 whitespace-nowrap">Lowest</th>
                  <th className="px-1.5 py-1 text-right font-medium text-gray-500 whitespace-nowrap">Buy At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {volatileWatchlist.watchlist.map((market) => {
                  const addedDate = new Date(market.added_at);
                  const now = new Date();
                  const diffMs = now.getTime() - addedDate.getTime();
                  const diffMin = Math.floor(diffMs / 60000);
                  const hours = Math.floor(diffMin / 60);
                  const mins = diffMin % 60;
                  const ageStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
                  
                  // Lowest price seen
                  const lowestPrice = market.lowest_price_seen_dollars || 0;
                  const dropFromHighest = market.highest_price_seen_dollars - lowestPrice;
                  const dropPercent = market.highest_price_seen_dollars > 0 
                    ? ((dropFromHighest / market.highest_price_seen_dollars) * 100).toFixed(0) 
                    : '0';
                  
                  const sideColor = market.trade_side === 'YES' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700';
                  
                  return (
                    <tr key={market.market_ticker}>
                      <td className="px-1.5 py-1 whitespace-nowrap font-mono text-base">
                        <a href={buildMarketUrlFromTicker(market.market_ticker)}
                          target="_blank" rel="noopener noreferrer"
                          className="text-blue-600 hover:underline">
                          {market.market_ticker}
                        </a>
                      </td>
                      <td className="px-1.5 py-1 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-base font-semibold ${sideColor}`}>
                          {market.trade_side}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 text-right text-gray-700 font-mono whitespace-nowrap">{ageStr}</td>
                      <td className="px-1.5 py-1 text-right text-gray-900 font-mono font-semibold">${market.initial_price_dollars.toFixed(2)}</td>
                      <td className="px-1.5 py-1 text-right text-gray-900 font-mono font-semibold">${market.current_price_dollars.toFixed(2)}</td>
                      <td className="px-1.5 py-1 text-right font-mono">
                        {lowestPrice > 0 ? (
                          <>
                            <span className="text-blue-600 font-semibold">${lowestPrice.toFixed(2)}</span>
                            {dropFromHighest > 0 && (
                              <span className="text-gray-500 text-sm ml-1">(↓{dropPercent}%)</span>
                            )}
                          </>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono text-green-700 font-semibold">
                        {market.action_trigger_price !== undefined ? `$${market.action_trigger_price.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {volatileWatchlist.cleaned_up && volatileWatchlist.cleaned_up > 0 && (
              <div className="text-base text-gray-500 mt-2">
                Cleaned up {volatileWatchlist.cleaned_up} stale entries
              </div>
            )}
          </div>
        ) : volatileWatchlist ? (
          <div className="text-center py-4 text-gray-500 text-base">No active watchlist entries</div>
        ) : (
          <div className="text-center py-4 text-gray-400 text-base">Loading...</div>
        )}
      </div>

      {/* Volatile Orders Section - Recent Dip-Buy Attempts */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            🎯 Volatile Dip-Buy Orders (24h)
          </h2>
          <button onClick={loadVolatileOrders} disabled={volatileOrdersLoading}
            className="px-2 py-1 text-base text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50">🔄</button>
        </div>

        {volatileOrders && volatileOrders.orders.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-1.5 py-1 text-left font-medium text-gray-500 whitespace-nowrap">Time</th>
                  <th className="px-1.5 py-1 text-left font-medium text-gray-500 whitespace-nowrap">Market</th>
                  <th className="px-1.5 py-1 text-center font-medium text-gray-500 whitespace-nowrap">User</th>
                  <th className="px-1.5 py-1 text-center font-medium text-gray-500 whitespace-nowrap">Side</th>
                  <th className="px-1.5 py-1 text-center font-medium text-gray-500 whitespace-nowrap">Status</th>
                  <th className="px-1.5 py-1 text-right font-medium text-gray-500 whitespace-nowrap">Filled</th>
                  <th className="px-1.5 py-1 text-right font-medium text-gray-500 whitespace-nowrap">Avg Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {volatileOrders.orders.map((order) => {
                  const placedDate = new Date(order.placed_at_iso);
                  const now = new Date();
                  const diffMs = now.getTime() - placedDate.getTime();
                  const diffMin = Math.floor(diffMs / 60000);
                  const hours = Math.floor(diffMin / 60);
                  const mins = diffMin % 60;
                  const ageStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
                  
                  const sideColor = order.side === 'yes' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700';
                  const statusColor = order.order_status === 'executed' 
                    ? 'bg-green-100 text-green-700'
                    : order.order_status === 'cancelled' || order.order_status === 'expired'
                    ? 'bg-gray-100 text-gray-600'
                    : 'bg-yellow-100 text-yellow-700';
                  
                  return (
                    <tr key={order.order_id}>
                      <td className="px-1.5 py-1 whitespace-nowrap text-gray-600">{ageStr} ago</td>
                      <td className="px-1.5 py-1 whitespace-nowrap font-mono text-base">
                        <a href={buildMarketUrlFromTicker(order.market_ticker)}
                          target="_blank" rel="noopener noreferrer"
                          className="text-blue-600 hover:underline">
                          {order.market_ticker}
                        </a>
                      </td>
                      <td className="px-1.5 py-1 text-center text-gray-700">{order.user_name}</td>
                      <td className="px-1.5 py-1 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-base font-semibold ${sideColor}`}>
                          {order.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-base font-semibold ${statusColor}`}>
                          {order.order_status}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono font-semibold text-gray-900">
                        {order.filled_count > 0 ? order.filled_count : '—'}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono font-semibold text-gray-900">
                        {order.avg_fill_price > 0 ? `$${order.avg_fill_price.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="text-base text-gray-500 mt-2">
              {volatileOrders.count} order{volatileOrders.count !== 1 ? 's' : ''} in last {volatileOrders.hours} hours
            </div>
          </div>
        ) : volatileOrders ? (
          <div className="text-center py-4 text-gray-500 text-base">No volatile orders in last 24 hours</div>
        ) : (
          <div className="text-center py-4 text-gray-400 text-base">Loading...</div>
        )}
      </div>

      {/* Orderbook Recorder */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-xl font-bold text-gray-900">📼 Orderbook Recorder</h2>
          <button
            onClick={() => { loadRecorderSettings(); loadRecorderStatus(); loadSportsCaptures(); }}
            disabled={recorderSettingsLoading || recorderStatusLoading}
            className="px-2 py-1 text-base text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
          >
            🔄
          </button>
        </div>

        {/* Three feature flag toggles */}
        <div className="flex flex-wrap gap-4 mb-4">
          {[
            { key: 'recorder_enabled', label: 'Recorder On/Off', desc: 'Master switch — allows manual and auto recording' },
            { key: 'record_after_trades', label: 'Record After Trades', desc: 'Auto-start recording each market when a trade is placed' },
            { key: 'record_mention_markets', label: 'Record Mention Markets', desc: 'Auto-start recording entire mention event on monitor activation' },
            { key: 'record_basketball_games', label: 'Record Basketball', desc: 'Auto-queue basketball game captures via sports feeder' },
          ].map(({ key, label, desc }) => {
            const value = recorderSettings ? recorderSettings[key as keyof RecorderSettings] : false;
            const isLoading = recorderToggleLoading === key;
            return (
              <div key={key} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
                <button
                  onClick={() => handleRecorderToggle(key)}
                  disabled={isLoading || recorderSettingsLoading}
                  className={`px-3 py-1 rounded text-base font-bold uppercase tracking-wide min-w-[4rem] transition-colors duration-200 ${
                    isLoading
                      ? 'animate-pulse bg-gray-300 text-gray-500'
                      : value
                      ? 'bg-green-500 hover:bg-green-600 text-white'
                      : 'bg-red-500 hover:bg-red-600 text-white'
                  } disabled:opacity-50`}
                  title={desc}
                >
                  {isLoading ? '...' : value ? 'ON' : 'OFF'}
                </button>
                <div>
                  <div className="text-sm font-semibold text-gray-800">{label}</div>
                  <div className="text-xs text-gray-500">{desc}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Active sessions table */}
        <div>
          <div className="text-sm font-semibold text-gray-700 mb-1">
            Active Sessions{recorderStatus ? ` (${recorderStatus.active_sessions})` : ''}
          </div>
          {recorderStatusLoading ? (
            <div className="text-center py-4 text-gray-400 text-sm">Loading...</div>
          ) : recorderStatus && recorderStatus.sessions.length > 0 ? (
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Event</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Tickers</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Data Points</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Buffer</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Started</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">S3 Key</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recorderStatus.sessions.map((s) => (
                  <tr key={s.group_key} className="hover:bg-gray-50">
                    <td className="px-2 py-1 font-semibold text-gray-900" title={s.group_key}>
                        <a href={buildEventUrl(s.group_key)} target="_blank" rel="noopener noreferrer"
                           className="text-blue-600 hover:text-blue-800 hover:underline">
                          {abbreviateGroupKey(s.group_key)}
                        </a>
                      </td>
                    <td className="px-2 py-1 text-center text-gray-700">{s.tickers.length}</td>
                    <td className="px-2 py-1 text-center font-mono text-gray-700">{s.data_points.toLocaleString()}</td>
                    <td className="px-2 py-1 text-center font-mono text-gray-700">{s.buffer_size}</td>
                    <td className="px-2 py-1 text-gray-600">{new Date(s.started_at).toLocaleTimeString()}</td>
                    <td className="px-2 py-1 font-mono text-xs text-gray-500 max-w-xs truncate" title={s.s3_key}>{s.s3_key}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-3 text-gray-400 text-sm">No active recording sessions</div>
          )}
        </div>

        {/* Basketball captures from sports feeder */}
        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="text-sm font-semibold text-gray-700 mb-2">
            🏀 Basketball Captures (Sports Feeder){sportsCaptures.length > 0 ? (() => {
              const live = sportsCaptures.filter(c => (c.status === 'capturing' || c.status === 'running') && !c.stale).length;
              const queued = sportsCaptures.filter(c => c.status === 'queued').length;
              const stale = sportsCaptures.filter(c => c.stale).length;
              return ` — ${live} live${queued ? `, ${queued} queued` : ''}${stale ? `, ${stale} stale` : ''}`;
            })() : ''}
          </div>
          {sportsCapturesLoading ? (
            <div className="text-center py-4 text-gray-400 text-sm">Loading...</div>
          ) : sportsCaptures.length > 0 ? (
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Game</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500 hidden sm:table-cell">League</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500">Status</th>
                  <th className="px-2 py-1 text-center font-medium text-gray-500" title="Data point count is only written at capture completion">Data Points</th>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">Start</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sportsCaptures.map((c) => {
                  const isStale = c.stale;
                  const statusColor = isStale
                    ? 'bg-gray-100 text-gray-400'
                    : c.status === 'capturing'
                    ? 'bg-green-100 text-green-800'
                    : c.status === 'running'
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-yellow-100 text-yellow-800';
                  const startTs = c.scheduled_start ? parseInt(c.scheduled_start) * 1000 : 0;
                  const startTime = startTs ? new Date(startTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
                  const kalshiUrl = buildEventUrl(c.event_ticker);
                  return (
                    <tr key={c.event_ticker} className={isStale ? 'opacity-50 hover:opacity-70' : 'hover:bg-gray-50'}>
                      <td className="px-2 py-1 font-semibold text-gray-900">
                        <a href={kalshiUrl} target="_blank" rel="noopener noreferrer"
                           className="text-blue-600 hover:text-blue-800 hover:underline">
                          {c.title}
                        </a>
                      </td>
                      <td className="px-2 py-1 text-gray-500 text-xs hidden sm:table-cell">{c.league}</td>
                      <td className="px-2 py-1 text-center">
                        {isStale
                          ? <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-400" title="Capture abandoned when feeder restarted">stale</span>
                          : <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${statusColor}`}>{c.status}</span>
                        }
                      </td>
                      <td className="px-2 py-1 text-center font-mono text-gray-700">
                        {c.data_points > 0
                          ? c.data_points.toLocaleString()
                          : (!isStale && (c.status === 'capturing' || c.status === 'running'))
                          ? <span className="text-green-600 text-xs font-bold animate-pulse">● live</span>
                          : '—'}
                      </td>
                      <td className="px-2 py-1 text-gray-600">{startTime}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-3 text-gray-400 text-sm">No active basketball captures</div>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-base">
          {error}
        </div>
      )}
    </div>
  );
}
