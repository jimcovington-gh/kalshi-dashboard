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
  };
}

interface LogEntry {
  time: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'price';
}

type PageState = 'loading' | 'lobby' | 'launching' | 'trading';

const API_BASE = 'https://5uthw49k2c.execute-api.us-east-1.amazonaws.com/prod';

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

        if (!response.ok) {
          throw new Error('Failed to fetch events');
        }

        const data = await response.json();
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
    addLog(`Launching server for ${title || selectedEvent}...`);
    
    // Request wake lock immediately to prevent screen sleep during launch
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(lock => {
        wakeLockRef.current = lock;
        addLog('Screen wake lock acquired', 'info');
      }).catch(() => {});
    }
    
    try {
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
        throw new Error(data.error || 'Failed to launch server');
      }
      
      addLog(`Server ${data.status}: ${data.message}`, 'success');
      
      // Connect to WebSocket
      const wsUrl = data.websocket_url;
      addLog(`Connecting to ${wsUrl}...`);
      
      connectWebSocket(wsUrl, authToken, selectedEvent);
      
    } catch (err: any) {
      console.error('Error launching:', err);
      setError(err.message);
      addLog(`Error: ${err.message}`, 'error');
      setPageState('lobby');
    }
  }, [authToken, addLog]);

  // Reconnect to existing session
  const reconnectSession = useCallback(async (session: UserSession) => {
    setPageState('launching');
    setEventTicker(session.event_ticker);
    setEventTitle(session.title || session.event_ticker);
    addLog(`Reconnecting to ${session.title || session.event_ticker}...`);
    
    const wsUrl = session.websocket_url;
    connectWebSocket(wsUrl, authToken, session.event_ticker);
  }, [authToken, addLog, connectWebSocket]);

  const connectWebSocket = useCallback((wsUrl: string, token: string, targetEvent: string, isRetry = false) => {
    // Store for retries
    currentWsUrl.current = wsUrl;
    
    if (!isRetry) {
      wsRetryCount.current = 0;
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
        if (isLaunching.current && wsRetryCount.current < 20) {
          wsRetryCount.current++;
          const delay = Math.min(2000, 500 + wsRetryCount.current * 200);
          addLog(`Retrying connection (${wsRetryCount.current}/20)...`, 'info');
          wsRetryTimeout.current = setTimeout(() => {
            connectWebSocket(currentWsUrl.current, token, targetEvent, true);
          }, delay);
        } else if (!isLaunching.current) {
          addLog(`Disconnected (code: ${event.code})`, 'error');
        }
      };

      ws.onerror = () => {
        // Error will trigger onclose, which handles retry
      };

    } catch (e: any) {
      addLog(`Connection failed: ${e.message}`, 'error');
      setPageState('lobby');
    }
  }, [addLog]);

  const handleWebSocketMessage = useCallback((data: any) => {
    const msgType = data.type;
    
    switch (msgType) {
      case 'auth_success':
        setConnected(true);
        setPageState('trading');
        isLaunching.current = false;
        addLog(`Authenticated as ${data.user}`, 'success');
        break;
      
      case 'prices':
        if (data.data) {
          setPrices(data.data);
          const teams = Object.keys(data.data).filter(k => k !== 'updated_at');
          if (teams.length > 0) {
            addLog(`Price update: ${teams.map(t => `${t}=${data.data[t]?.best_ask || '--'}¢`).join(', ')}`, 'price');
          }
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

      case 'error':
        addLog(`Error: ${data.message || data.error}`, 'error');
        break;

      default:
        addLog(`Message: ${JSON.stringify(data)}`, 'info');
    }
  }, [addLog]);

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

  // Filter teams from prices
  const teams = Object.keys(prices).filter(k => k !== 'updated_at');

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
                <div className="space-y-3">
                  {availableEvents.map((event) => (
                    <div 
                      key={event.event_ticker}
                      className="flex items-center justify-between bg-gray-700 rounded-lg p-4 hover:bg-gray-600 transition-colors"
                    >
                      <div className="flex-1">
                        <div className="font-bold">{event.title || event.event_ticker}</div>
                        <div className="text-sm text-gray-400">
                          <span className="text-gray-300">{event.event_ticker}</span>
                          {event.event_time && <span className="mx-2">•</span>}
                          {event.event_time && <span className="text-cyan-400">{event.event_time}</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => launchEvent(event.event_ticker, event.title)}
                        className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg font-medium transition-colors"
                      >
                        Select
                      </button>
                    </div>
                  ))}
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
                teams.map((team) => (
                  <div key={team} className="bg-gray-800 rounded-2xl p-8 text-center">
                    <div className="text-3xl font-bold mb-4">{team.toUpperCase()}</div>
                    <div className="text-5xl font-bold text-cyan-400 mb-6">
                      {prices[team]?.best_ask || '--'}¢
                    </div>
                    <button
                      onClick={() => sendBuy(team)}
                      className="w-full py-5 text-2xl font-bold uppercase tracking-wider bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 rounded-xl transition-all transform hover:scale-[1.02] active:scale-[0.98]"
                    >
                      BUY {team.toUpperCase()}
                    </button>
                  </div>
                ))
              ) : (
                <div className="col-span-2 text-center py-12 text-gray-400">
                  Waiting for price updates...
                </div>
              )}
            </div>
            
            {/* Event Title Banner - below team cards */}
            <div className="bg-green-900/50 border border-green-500 text-green-200 px-4 py-3 rounded-lg mb-6 text-center font-medium">
              {eventTitle || eventTicker}
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
