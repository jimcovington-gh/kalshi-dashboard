'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

interface AvailableEvent {
  event_ticker: string;
  title: string;
  series_ticker: string;
  close_time: string;
  event_time: string;
  event_timestamp: number;  // Unix timestamp of game start
  status: string;
}

interface UserSession {
  event_ticker: string;
  title: string;
  websocket_url: string;
  started_at: number;
}

interface TeamPrices {
  [team: string]: {
    best_ask: number;
    best_bid: number;
    ticker: string;
    type: string;
    bids?: { price: number; quantity: number }[];
    asks?: { price: number; quantity: number }[];
  };
}

interface GameState {
  home_points?: number;
  away_points?: number;
  home_team?: string;  // Team abbreviation (e.g., "ATL")
  away_team?: string;  // Team abbreviation (e.g., "TB")
  home_team_id?: string;
  away_team_id?: string;
  status?: string;
  period_type?: string;
  period_number?: number;
  clock?: string;
  possession_team?: string;  // Team abbreviation with possession
  possession_team_id?: string;
  winner?: string;
}

interface LogEntry {
  time: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'price';
}

type PageState = 'loading' | 'lobby' | 'launching' | 'trading';

const API_BASE = 'https://5uthw49k2c.execute-api.us-east-1.amazonaws.com/prod';

// Helper function to get event type prefix from series_ticker (e.g., "KXNFLGAME" -> "KXNFLGAME")
function getEventTypePrefix(seriesTicker: string): string {
  if (!seriesTicker) return 'Other';
  return seriesTicker;  // Use full series_ticker as header
}

// Helper function to format relative time from unix timestamp
function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const now = Math.floor(Date.now() / 1000);
  const diffSeconds = timestamp - now;
  const absDiff = Math.abs(diffSeconds);
  const hours = Math.floor(absDiff / 3600);
  const minutes = Math.floor((absDiff % 3600) / 60);
  
  const timeStr = `${hours}:${minutes.toString().padStart(2, '0')}`;
  
  if (diffSeconds < 0) {
    return `Started ${timeStr} ago`;
  } else {
    return `Starts in ${timeStr}`;
  }
}

export default function QuickBetsPage() {
  // Page state
  const [pageState, setPageState] = useState<PageState>('loading');
  const [error, setError] = useState('');
  
  // Lobby state
  const [availableEvents, setAvailableEvents] = useState<AvailableEvent[]>([]);
  const [userSessions, setUserSessions] = useState<UserSession[]>([]);
  
  // Trading state
  const [eventTicker, setEventTicker] = useState<string>('');
  const [eventTitle, setEventTitle] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [prices, setPrices] = useState<TeamPrices>({});
  const [gameState, setGameState] = useState<GameState>({});
  
  // Price log throttling (60 second interval)
  const lastPriceLogTime = useRef<number>(0);
  const PRICE_LOG_INTERVAL_MS = 60 * 1000; // 60 seconds
  
  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  
  // Auth & WebSocket
  const [authToken, setAuthToken] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryCount = useRef(0);
  const wsRetryTimeout = useRef<NodeJS.Timeout | null>(null);
  const currentWsUrl = useRef<string>('');
  const isLaunching = useRef(false);
  const isReconnecting = useRef<string | null>(null);  // event_ticker if reconnecting to existing session
  
  const router = useRouter();

  // Wake Lock to prevent screen sleep (like watching a video)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-100), { time, message, type }]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // Fetch events on page load (Lambda-based lobby)
  useEffect(() => {
    async function loadLobby() {
      try {
        // Get auth token
        const authSession = await fetchAuthSession();
        if (!authSession.tokens?.idToken) {
          router.push('/');
          return;
        }
        const token = authSession.tokens.idToken.toString();
        setAuthToken(token);
        
        addLog('Loading available events...');
        
        // Fetch events from Lambda
        const response = await fetch(`${API_BASE}/events`, {
          headers: {
            'Authorization': token,
          },
        });

        const data = await response.json();

        // Check for credentials error BEFORE checking response.ok
        if (data.error_code === 'NO_TRADING_CREDENTIALS') {
          setError('This account does not have Kalshi trading credentials configured. Please log in with a different account that has trading access.');
          addLog('❌ No trading credentials for this account', 'error');
          addLog('Please log out and sign in with a trading account', 'error');
          setPageState('lobby');
          return;
        }

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch events');
        }

        setAvailableEvents(data.available_events || []);
        setUserSessions(data.user_sessions || []);
        
        addLog(`Found ${data.available_events?.length || 0} available events`, 'success');
        if (data.user_sessions?.length > 0) {
          addLog(`You have ${data.user_sessions.length} active session(s)`, 'info');
        }
        
        setPageState('lobby');
        
      } catch (err: any) {
        console.error('Error loading lobby:', err);
        setError(err.message);
        addLog(`Error: ${err.message}`, 'error');
        setPageState('lobby');
      }
    }

    loadLobby();
    
    // Cleanup on unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
      }
      if (wsRetryTimeout.current) {
        clearTimeout(wsRetryTimeout.current);
      }
    };
  }, [router, addLog]);

  // Handle WebSocket messages - MUST be defined before connectWebSocket
  const handleWebSocketMessage = useCallback((data: any) => {
    const msgType = data.type;
    
    switch (msgType) {
      case 'auth_success':
        setConnected(true);
        setPageState('trading');
        isLaunching.current = false;
        isReconnecting.current = null;  // Clear reconnection tracking on success
        addLog(`Authenticated as ${data.user}`, 'success');
        break;
      
      case 'subscribed':
        // Initial game state from sportsfeeder when we first subscribe
        if (data.games && data.games.length > 0) {
          const game = data.games[0];
          addLog(`Subscribed to ${game.title || game.event_ticker}`, 'success');
          setGameState(prev => ({
            ...prev,
            home_points: game.home_points ?? prev.home_points,
            away_points: game.away_points ?? prev.away_points,
            home_team: game.home_team_abbr ?? prev.home_team,
            away_team: game.away_team_abbr ?? prev.away_team,
            home_team_id: game.home_team_id ?? prev.home_team_id,
            away_team_id: game.away_team_id ?? prev.away_team_id,
            status: game.status ?? prev.status,
            period_type: game.period_type ?? prev.period_type,
            period_number: game.period_number ?? prev.period_number,
            clock: game.clock ?? prev.clock,
            possession_team: game.possession_team_id ?? prev.possession_team,
          }));
        }
        break;
      
      case 'prices':
        if (data.data) {
          setPrices(data.data);
          // Throttle price log display to every 60 seconds
          const now = Date.now();
          if (now - lastPriceLogTime.current >= PRICE_LOG_INTERVAL_MS) {
            const teams = Object.keys(data.data).filter(k => k !== 'updated_at');
            if (teams.length > 0) {
              addLog(`Price update: ${teams.map(t => `${t}=${data.data[t]?.best_ask || '--'}¢`).join(', ')}`, 'price');
            }
            lastPriceLogTime.current = now;
          }
        }
        break;
      
      case 'game_update':
        // Update game state (scores, period, clock, etc.)
        // Map sportsfeeder field names to our state structure
        if (data.data) {
          setGameState(prev => ({
            ...prev,
            home_points: data.data.home_points ?? prev.home_points,
            away_points: data.data.away_points ?? prev.away_points,
            home_team: data.data.home_team_abbr ?? data.data.home_team ?? prev.home_team,
            away_team: data.data.away_team_abbr ?? data.data.away_team ?? prev.away_team,
            home_team_id: data.data.home_team_id ?? prev.home_team_id,
            away_team_id: data.data.away_team_id ?? prev.away_team_id,
            status: data.data.status ?? prev.status,
            period_type: data.data.period_type ?? prev.period_type,
            period_number: data.data.period_number ?? prev.period_number,
            clock: data.data.clock ?? prev.clock,
            possession_team: data.data.possession_team_id ?? data.data.possession_team ?? prev.possession_team,
          }));
        }
        break;

      case 'buy_result':
        if (data.success) {
          addLog(`✅ BUY SUCCESS: ${data.team} @ ${data.avg_price}¢ x${data.filled_count}`, 'success');
        } else {
          addLog(`❌ BUY FAILED: ${data.error}`, 'error');
        }
        break;

      case 'sell_result':
        const pnl = data.net_pnl >= 0 ? `+${data.net_pnl}` : data.net_pnl;
        addLog(`💰 SELL: ${data.team} @ ${data.avg_price}¢, P&L: ${pnl}¢`, 'success');
        break;

      case 'pong':
        break;

      case 'event_mode_started':
        // Silently acknowledge - UI already shows connected state
        break;
        
      case 'auth_success':
        // Silently acknowledge - handled by connection state
        break;

      case 'error':
        addLog(`Error: ${data.message || data.error}`, 'error');
        break;

      default:
        // Only log truly unknown messages
        console.log('Unknown message type:', data.type, data);
    }
  }, [addLog]);

  // Connect WebSocket - MUST be defined before launchEvent
  const connectWebSocket = useCallback((wsUrl: string, token: string, targetEvent: string, isRetry = false) => {
    // Store for retries
    currentWsUrl.current = wsUrl;
    
    if (!isRetry) {
      wsRetryCount.current = 0;
      addLog(`Connecting to ${wsUrl}...`);
    }
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog('WebSocket connected, authenticating...', 'info');
        ws.send(JSON.stringify({
          type: 'auth',
          token: token,
          event_ticker: targetEvent  // Tell server which event we want
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (e) {
          addLog(`Raw message: ${event.data}`, 'info');
        }
      };

      ws.onclose = (event) => {
        // Ignore close events from stale connections
        if (wsRef.current !== ws) {
          return;
        }
        
        setConnected(false);
        wsRef.current = null;
        
        // 4003 = Invalid/expired token - need to refresh auth
        if (event.code === 4003) {
          addLog('Auth token expired, refreshing...', 'info');
          // Refresh the token and retry
          fetchAuthSession({ forceRefresh: true }).then(async (authSession) => {
            if (!authSession.tokens?.idToken) {
              addLog('Failed to refresh auth token', 'error');
              setPageState('lobby');
              return;
            }
            const newToken = authSession.tokens.idToken.toString();
            setAuthToken(newToken);
            addLog('Token refreshed, reconnecting...', 'info');
            // Retry with new token
            connectWebSocket(currentWsUrl.current, newToken, targetEvent, true);
          }).catch((err) => {
            addLog(`Failed to refresh token: ${err.message}`, 'error');
            setPageState('lobby');
          });
          return;
        }
        
        // 4010 = connected to wrong container, retry to hit correct one
        if (event.code === 4010) {
          if (wsRetryCount.current < 30) {
            wsRetryCount.current++;
            const delay = 500 + Math.random() * 500; // Random delay to avoid hitting same container
            addLog(`Wrong container, retrying (${wsRetryCount.current}/30)...`, 'info');
            wsRetryTimeout.current = setTimeout(() => {
              connectWebSocket(currentWsUrl.current, token, targetEvent, true);
            }, delay);
            return;
          } else {
            addLog('Failed to connect to correct container after 30 attempts', 'error');
            setPageState('lobby');
            return;
          }
        }
        
        // Auto-retry if we're still launching and haven't connected yet
        // Use fast retries since NLB health check takes ~10s
        if (isLaunching.current && wsRetryCount.current < 30) {
          wsRetryCount.current++;
          const delay = 500; // Fast fixed retry - NLB will accept once healthy
          if (wsRetryCount.current === 1) {
            addLog(`Waiting for server to become healthy...`, 'info');
          }
          wsRetryTimeout.current = setTimeout(() => {
            connectWebSocket(currentWsUrl.current, token, targetEvent, true);
          }, delay);
        } else if (!isLaunching.current) {
          // Check if this was a reconnection attempt to a stale session
          if (isReconnecting.current && (event.code === 1006 || event.code === 1001)) {
            const staleTicker = isReconnecting.current;
            addLog(`Session expired. Removing stale session and returning to lobby.`, 'error');
            // Remove the stale session from the list
            setUserSessions(prev => prev.filter(s => s.event_ticker !== staleTicker));
            isReconnecting.current = null;
            setPageState('lobby');
          } else {
            addLog(`Disconnected (code: ${event.code})`, 'error');
          }
        }
      };

      ws.onerror = () => {
        // Error will trigger onclose, which handles retry
      };

    } catch (e: any) {
      addLog(`Connection failed: ${e.message}`, 'error');
      setPageState('lobby');
    }
  }, [addLog, handleWebSocketMessage]);

  // Launch Fargate for selected event
  const launchEvent = useCallback(async (selectedEvent: string, title?: string) => {
    if (!authToken) {
      addLog('Not authenticated', 'error');
      return;
    }
    
    setPageState('launching');
    isLaunching.current = true;
    setEventTicker(selectedEvent);
    setEventTitle(title || selectedEvent);
    addLog(`Connecting to ${title || selectedEvent}...`);
    
    // Request wake lock immediately to prevent screen sleep during launch
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(lock => {
        wakeLockRef.current = lock;
        addLog('Screen wake lock acquired', 'info');
      }).catch(() => {});
    }
    
    try {
      // Try new router endpoint first (direct connection)
      let useDirectConnection = true;
      let wsUrl = '';
      let routerData: any = null;
      
      try {
        const routerResponse = await fetch(`${API_BASE}/connect`, {
          method: 'POST',
          headers: {
            'Authorization': authToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ event_ticker: selectedEvent }),
        });
        
        if (routerResponse.ok || routerResponse.status === 202) {
          routerData = await routerResponse.json();
          
          if (routerData.status === 'ready') {
            // Container running - use direct WebSocket URL
            wsUrl = routerData.ws_url;
            addLog('Container ready, connecting directly...', 'success');
          } else if (routerData.status === 'launching') {
            // Container starting - poll for ready
            addLog('Container starting, waiting...', 'info');
            
            // Poll every 2 seconds for up to 60 seconds
            for (let i = 0; i < 30; i++) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              const pollResponse = await fetch(`${API_BASE}/connect`, {
                method: 'POST',
                headers: {
                  'Authorization': authToken,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ event_ticker: selectedEvent }),
              });
              
              const pollData = await pollResponse.json();
              
              if (pollData.status === 'ready') {
                wsUrl = pollData.ws_url;
                routerData = pollData;
                addLog('Container ready!', 'success');
                break;
              }
              
              if (pollData.status === 'error') {
                throw new Error(pollData.error || 'Container failed to start');
              }
              
              addLog(`Starting... (${i * 2 + 2}s)`, 'info');
            }
            
            if (!wsUrl) {
              throw new Error('Container startup timeout');
            }
          }
        } else {
          // Router endpoint not available, fall back to old launch
          useDirectConnection = false;
        }
      } catch (routerErr: any) {
        // Router endpoint failed - fall back to old launch endpoint
        console.log('Router failed, using launch endpoint:', routerErr.message);
        useDirectConnection = false;
      }
      
      // Fall back to old NLB-based launch if router didn't work
      if (!useDirectConnection || !wsUrl) {
        addLog('Using legacy launcher...', 'info');
        const response = await fetch(`${API_BASE}/launch`, {
          method: 'POST',
          headers: {
            'Authorization': authToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ event_ticker: selectedEvent }),
        });

        const data = await response.json();
        
        if (!response.ok) {
          if (data.error_code === 'NO_TRADING_CREDENTIALS') {
            setError('This account does not have Kalshi trading credentials configured.');
            addLog('❌ No trading credentials for this account', 'error');
          } else {
            setError(data.error || 'Failed to launch server');
            addLog(`Error: ${data.error || 'Failed to launch server'}`, 'error');
          }
          setPageState('lobby');
          isLaunching.current = false;
          return;
        }
        
        wsUrl = data.websocket_url;
        routerData = data;
        addLog(`Server ${data.status}: ${data.message}`, 'success');
      }
      
      // If we got preliminary game state, use it immediately
      if (routerData?.game_state) {
        addLog('Received preliminary game state', 'info');
        setGameState({
          home_points: routerData.game_state.home_points,
          away_points: routerData.game_state.away_points,
          home_team: routerData.game_state.home_team_abbr,
          away_team: routerData.game_state.away_team_abbr,
          status: routerData.game_state.status,
          period_type: routerData.game_state.period_type,
          period_number: routerData.game_state.period_number,
          clock: routerData.game_state.clock,
          possession_team: routerData.game_state.possession_team_id,
        });
      }
      
      // Connect to WebSocket
      connectWebSocket(wsUrl, authToken, selectedEvent);
      
    } catch (err: any) {
      console.error('Error launching:', err);
      setError(err.message);
      addLog(`Error: ${err.message}`, 'error');
      setPageState('lobby');
    }
  }, [authToken, addLog, connectWebSocket]);

  // Reconnect to existing session
  const reconnectSession = useCallback(async (session: UserSession) => {
    setPageState('launching');
    setEventTicker(session.event_ticker);
    setEventTitle(session.title || session.event_ticker);
    isReconnecting.current = session.event_ticker;  // Track that we're reconnecting
    addLog(`Reconnecting to ${session.title || session.event_ticker}...`);
    
    const wsUrl = session.websocket_url;
    connectWebSocket(wsUrl, authToken, session.event_ticker);
  }, [authToken, addLog, connectWebSocket]);

  const sendBuy = useCallback((team: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('Not connected!', 'error');
      return;
    }

    addLog(`Sending BUY for ${team}...`);
    wsRef.current.send(JSON.stringify({
      type: 'buy',
      team: team
    }));
  }, [addLog]);

  const backToLobby = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (wsRetryTimeout.current) {
      clearTimeout(wsRetryTimeout.current);
      wsRetryTimeout.current = null;
    }
    // Release wake lock
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
    wsRetryCount.current = 0;
    isLaunching.current = false;
    setConnected(false);
    setEventTicker('');
    setPrices({});
    setPageState('loading');
    // Re-fetch events
    window.location.reload();
  }, []);

  // Filter teams from prices (exclude tie/draw for 3-outcome games like soccer)
  const teams = Object.keys(prices).filter(k => 
    k !== 'updated_at' && 
    !['tie', 'draw', 'tied', 'drawn'].includes(k.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-4xl mx-auto">
        
        {error && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded-lg mb-4">
            {error}
            <button onClick={() => setError('')} className="float-right text-red-400 hover:text-red-200">×</button>
          </div>
        )}

        {/* Status Bar - hidden during trading */}
        {(pageState === 'loading' || pageState === 'launching') && (
          <div className={`px-4 py-3 rounded-lg mb-6 font-medium ${
            pageState === 'launching'
            ? 'bg-yellow-900/50 border border-yellow-500 text-yellow-200'
            : 'bg-gray-800 border border-gray-600 text-gray-300'
          }`}>
            {pageState === 'loading' && 'Loading events...'}
            {pageState === 'launching' && `Launching: ${eventTitle || eventTicker}...`}
          </div>
        )}

        {/* LOADING STATE */}
        {pageState === 'loading' && (
          <div className="bg-gray-800 rounded-xl p-12 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-400 mx-auto mb-4"></div>
            <p className="text-gray-400">Loading available events...</p>
          </div>
        )}

        {/* LOBBY STATE */}
        {pageState === 'lobby' && (
          <div className="space-y-6">
            {/* Your Active Sessions */}
            {userSessions.length > 0 && (
              <div className="bg-gray-800 rounded-xl p-6">
                <h2 className="text-lg font-semibold text-green-400 mb-4">🔄 Your Active Sessions</h2>
                <div className="space-y-3">
                  {userSessions.map((session) => (
                    <div 
                      key={session.event_ticker}
                      className="flex items-center justify-between bg-gray-700 rounded-lg p-4"
                    >
                      <div>
                        <div className="font-bold">{session.title || session.event_ticker}</div>
                        <div className="text-sm text-gray-400">
                          Started {new Date(session.started_at * 1000).toLocaleTimeString()}
                        </div>
                      </div>
                      <button
                        onClick={() => reconnectSession(session)}
                        className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-medium transition-colors"
                      >
                        Reconnect
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Available Events */}
            <div className="bg-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">Select an Event to Start Trading</h2>
              
              {availableEvents.length === 0 ? (
                <p className="text-gray-400 text-center py-8">No live events available right now</p>
              ) : (
                <div className="space-y-2">
                  {(() => {
                    const sorted = [...availableEvents].sort((a, b) => {
                      const seriesCompare = (a.series_ticker || '').localeCompare(b.series_ticker || '');
                      if (seriesCompare !== 0) return seriesCompare;
                      return (a.event_timestamp || 0) - (b.event_timestamp || 0);
                    });
                    let lastPrefix = '';
                    return sorted.map((event) => {
                      const currentPrefix = getEventTypePrefix(event.series_ticker);
                      const showHeader = currentPrefix !== lastPrefix;
                      lastPrefix = currentPrefix;
                      return (
                        <div key={event.event_ticker}>
                          {showHeader && (
                            <div className="text-sm font-semibold text-gray-400 uppercase tracking-wider pt-3 pb-1">
                              {currentPrefix}
                            </div>
                          )}
                          <div className="flex items-center justify-between bg-gray-700 rounded-lg p-4 hover:bg-gray-600 transition-colors">
                            <div className="flex-1">
                              <div className="font-bold">{event.title || event.event_ticker}</div>
                              <div className="text-sm text-gray-400">
                                <span className="text-gray-300">{event.event_ticker}</span>
                                {event.event_timestamp && <span className="mx-2">•</span>}
                                {event.event_timestamp && <span className="text-cyan-400">{formatRelativeTime(event.event_timestamp)}</span>}
                              </div>
                            </div>
                            <button
                              onClick={() => launchEvent(event.event_ticker, event.title)}
                              className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg font-medium transition-colors"
                            >
                              Select
                            </button>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>
        )}

        {/* LAUNCHING STATE */}
        {pageState === 'launching' && (
          <div className="bg-gray-800 rounded-xl p-12 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-400 mx-auto mb-4"></div>
            <p className="text-gray-400">Launching: {eventTitle || eventTicker}</p>
            <p className="text-gray-500 text-sm mt-2">This may take 20-30 seconds</p>
          </div>
        )}

        {/* TRADING STATE */}
        {pageState === 'trading' && connected && (
          <>
            {/* Team Cards */}
            <div className="grid grid-cols-2 gap-6 mb-4">
              {teams.length > 0 ? (
                teams.map((team) => {
                  // Determine score for this team based on home/away mapping
                  let teamScore: number | undefined;
                  if (gameState.home_team?.toUpperCase() === team.toUpperCase()) {
                    teamScore = gameState.home_points;
                  } else if (gameState.away_team?.toUpperCase() === team.toUpperCase()) {
                    teamScore = gameState.away_points;
                  }
                  
                  const teamData = prices[team];
                  const bids = teamData?.bids || [];
                  const asks = teamData?.asks || [];
                  
                  return (
                    <div key={team} className="bg-gray-800 rounded-2xl p-6 text-center">
                      {/* Best Ask Price */}
                      <div className="text-5xl font-bold text-cyan-400 mb-4">
                        {teamData?.best_ask || '--'}¢
                      </div>
                      
                      {/* Bids above button (descending - highest first) */}
                      <div className="font-mono text-xs text-green-400 mb-2 space-y-0.5">
                        {bids.slice(0, 3).map((bid, i) => (
                          <div key={`bid-${i}`}>{bid.price}-{bid.quantity}</div>
                        ))}
                        {bids.length === 0 && <div className="text-gray-600">--</div>}
                      </div>
                      
                      {/* Buy Button - Team + Score */}
                      <button
                        onClick={() => sendBuy(team)}
                        className="w-full py-5 text-2xl font-bold uppercase tracking-wider bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 rounded-xl transition-all transform hover:scale-[1.02] active:scale-[0.98] mb-2"
                      >
                        {team.toUpperCase()}{teamScore !== undefined ? ` ${teamScore}` : ''}
                      </button>
                      
                      {/* Asks below button (descending - highest first) */}
                      <div className="font-mono text-xs text-red-400 mt-2 space-y-0.5">
                        {[...asks].slice(0, 3).reverse().map((ask, i) => (
                          <div key={`ask-${i}`}>{ask.price}-{ask.quantity}</div>
                        ))}
                        {asks.length === 0 && <div className="text-gray-600">--</div>}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="col-span-2 text-center py-12 text-gray-400">
                  Waiting for price updates...
                </div>
              )}
            </div>
            
            {/* Event/Game Status Banner - below team cards */}
            <div className="bg-green-900/50 border border-green-500 text-green-200 px-4 py-3 rounded-lg mb-6 text-center font-medium">
              {/* Show game status if available, otherwise event title */}
              {gameState.status && gameState.status !== 'scheduled' ? (
                <span>
                  {gameState.clock && <span>{gameState.clock}</span>}
                  {gameState.period_type && gameState.period_number && (
                    <span>{gameState.clock ? ' • ' : ''}{gameState.period_type.charAt(0).toUpperCase() + gameState.period_type.slice(1)} {gameState.period_number}</span>
                  )}
                  {gameState.status && (
                    <span>{(gameState.clock || gameState.period_type) ? ' • ' : ''}{gameState.status.replace('_', ' ').toUpperCase()}</span>
                  )}
                  {gameState.possession_team && (
                    <span> • 🏈 {gameState.possession_team.toUpperCase()}</span>
                  )}
                </span>
              ) : (
                eventTitle || eventTicker
              )}
            </div>
          </>
        )}

        {/* Event Log - Always visible */}
        <div className="bg-gray-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-cyan-400 mb-3">Event Log</h3>
          <div 
            ref={logContainerRef}
            className="bg-gray-900 rounded-lg p-4 h-64 overflow-y-auto font-mono text-xs"
          >
            {logs.map((log, i) => (
              <div 
                key={i} 
                className={`mb-1 ${
                  log.type === 'success' ? 'text-green-400' :
                  log.type === 'error' ? 'text-red-400' :
                  log.type === 'price' ? 'text-cyan-400' :
                  'text-gray-400'
                }`}
              >
                [{log.time}] {log.message}
              </div>
            ))}
            {logs.length === 0 && (
              <div className="text-gray-500">No events yet...</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
