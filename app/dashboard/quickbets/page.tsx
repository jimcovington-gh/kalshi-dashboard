'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

interface AvailableEvent {
  event_ticker: string;
  title: string;
  series_ticker: string;
  series_title?: string;  // Human-readable series name from DynamoDB
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
    bids?: { price: number; size: number }[];
    asks?: { price: number; size: number }[];
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
  color?: string;  // Optional color for custom styling
}

type PageState = 'loading' | 'lobby' | 'launching' | 'trading';

const API_BASE = 'https://5uthw49k2c.execute-api.us-east-1.amazonaws.com/prod';

// League priority order: American pro leagues first, NCAA second, international last
const LEAGUE_PRIORITY: Record<string, number> = {
  'KXNFLGAME': 1,   // NFL
  'KXNHLGAME': 2,   // NHL
  'KXNBAGAME': 3,   // NBA
  'KXMLBGAME': 4,   // MLB
  'KXMLSGAME': 5,   // MLS
  'KXNCAAFGAME': 20, // NCAA Football
  'KXNCAABGAME': 21, // NCAA Basketball
  'KXNCAAWBBGAME': 22, // NCAA Women's Basketball
  // International and other leagues get priority 50+ (after NCAA)
};

function getLeaguePriority(seriesTicker: string): number {
  // Check for NCAA pattern (KXNCAA*) - give them priority 25 if not explicitly listed
  if (seriesTicker.startsWith('KXNCAA')) {
    return LEAGUE_PRIORITY[seriesTicker] || 25;
  }
  return LEAGUE_PRIORITY[seriesTicker] || 50; // International/other leagues after NCAA
}

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
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());  // Expanded series groups (default: all collapsed)
  
  // Trading state
  const [eventTicker, setEventTicker] = useState<string>('');
  const [eventTitle, setEventTitle] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [prices, setPrices] = useState<TeamPrices>({});
  const [previousPrices, setPreviousPrices] = useState<TeamPrices>({});  // Track previous prices for change detection
  const [gameState, setGameState] = useState<GameState>({});
  const [betAmount, setBetAmount] = useState<string>('$10');  // Bet amount selector
  const [sellDelay, setSellDelay] = useState<number>(8);  // Sell delay in seconds
  const [teamsSwapped, setTeamsSwapped] = useState(false);  // Swap left/right teams
  const [teamColors, setTeamColors] = useState<{[team: string]: string}>({});  // Per-team colors
  const [colorPickerOpen, setColorPickerOpen] = useState<string | null>(null);  // Which team's color picker is open
  
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

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info', color?: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-100), { time, message, type, color }]);
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
          setPrices(prev => {
            // Track significant price changes (>= 4 cents)
            const teams = Object.keys(data.data).filter(k => k !== 'updated_at');
            const priceChanges: {team: string, message: string, isUp: boolean}[] = [];
            
            teams.forEach(team => {
              const newAsk = data.data[team]?.best_ask;
              const prevAsk = prev[team]?.best_ask;
              
              if (newAsk !== undefined && prevAsk !== undefined) {
                const priceDiff = Math.abs(newAsk - prevAsk);
                if (priceDiff >= 0.04) {  // 4 cents or more
                  const isUp = newAsk > prevAsk;
                  const arrow = isUp ? '↑' : '↓';  // ↑ or ↓
                  const newCents = Math.round(newAsk * 100);
                  const prevCents = Math.round(prevAsk * 100);
                  priceChanges.push({
                    team,
                    message: `${arrow} ${team}: ${prevCents}¢ → ${newCents}¢`,
                    isUp
                  });
                }
              }
            });
            
            if (priceChanges.length > 0) {
              // Format with team colors
              priceChanges.forEach(({team, message, isUp}) => {
                addLog(message, 'price', teamColors[team] || '#ffffff');
              });
            }
            
            return data.data;
          });
        }
        break;
      
      case 'game_update':
        // Update game state (scores, period, clock, etc.)
        // Map sportsfeeder field names to our state structure
        if (data.data) {
          setGameState(prev => {
            // Check if this update is for the current event
            // If we have teams set and the update has different teams, ignore it
            const updateHomeTeam = data.data.home_team_abbr ?? data.data.home_team;
            const updateAwayTeam = data.data.away_team_abbr ?? data.data.away_team;
            
            // Only filter if we have teams established and the update has team info
            if (prev.home_team && prev.away_team && updateHomeTeam && updateAwayTeam) {
              // If teams don't match, this is for a different event - ignore it
              if (updateHomeTeam !== prev.home_team || updateAwayTeam !== prev.away_team) {
                console.log(`Ignoring game_update for ${updateAwayTeam} vs ${updateHomeTeam} (current: ${prev.away_team} vs ${prev.home_team})`);
                return prev;  // Don't update state or log anything
              }
            }
            
            const newState = {
              ...prev,
              home_points: data.data.home_points ?? prev.home_points,
              away_points: data.data.away_points ?? prev.away_points,
              home_team: updateHomeTeam ?? prev.home_team,
              away_team: updateAwayTeam ?? prev.away_team,
              home_team_id: data.data.home_team_id ?? prev.home_team_id,
              away_team_id: data.data.away_team_id ?? prev.away_team_id,
              status: data.data.status ?? prev.status,
              period_type: data.data.period_type ?? prev.period_type,
              period_number: data.data.period_number ?? prev.period_number,
              clock: data.data.clock ?? prev.clock,
              possession_team: data.data.possession_team_id ?? data.data.possession_team ?? prev.possession_team,
            };
            
            // Log meaningful game state changes
            const changes: string[] = [];
            
            // Score changes
            if (newState.home_points !== prev.home_points || newState.away_points !== prev.away_points) {
              changes.push(`Score: ${newState.away_team || 'AWAY'} ${newState.away_points} - ${newState.home_team || 'HOME'} ${newState.home_points}`);
            }
            
            // Period changes
            if (newState.period_number !== prev.period_number || newState.period_type !== prev.period_type) {
              const periodLabel = newState.period_type || 'Period';
              changes.push(`${periodLabel} ${newState.period_number}`);
            }
            
            // Clock changes (only log significant changes, not every tick)
            if (newState.clock !== prev.clock && newState.clock) {
              // Only log clock at certain times (start of period, timeouts, etc.)
              const clockMinutes = parseInt(newState.clock.split(':')[0] || '0');
              const prevClockMinutes = parseInt((prev.clock || '0:00').split(':')[0] || '0');
              if (clockMinutes !== prevClockMinutes) {
                changes.push(`Clock: ${newState.clock}`);
              }
            }
            
            if (changes.length > 0) {
              addLog(`🏀 ${changes.join(' | ')}`, 'info');
            }
            
            return newState;
          });
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
        addLog(`${data.error || data.message}`, 'error');
        // Handle game-complete errors by returning to lobby
        if (data.error_code === 'game_complete' || data.error_code === 'game_cancelled') {
          // Give user time to read the message before returning to lobby
          setTimeout(() => {
            setPageState('lobby');
          }, 3000);
        }
        break;

      default:
        // Only log truly unknown messages
        console.log('Unknown message type:', data.type, data);
    }
  }, [addLog, teamColors]);

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
    
    // Request wake lock on reconnection to prevent screen sleep
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(lock => {
        wakeLockRef.current = lock;
        addLog('Screen wake lock acquired', 'info');
      }).catch(() => {});
    }
    
    const wsUrl = session.websocket_url;
    connectWebSocket(wsUrl, authToken, session.event_ticker);
  }, [authToken, addLog, connectWebSocket]);

  const sendBuy = useCallback((team: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('Not connected!', 'error');
      return;
    }

    addLog(`Sending BUY for ${team} (${betAmount}, ${sellDelay}s)...`);
    wsRef.current.send(JSON.stringify({
      type: 'buy',
      team: team,
      bet_amount: betAmount,  // Send selected bet amount
      sell_delay: sellDelay   // Send selected sell delay
    }));
  }, [addLog, betAmount, sellDelay]);

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
  const teamsRaw = Object.keys(prices).filter(k => 
    k !== 'updated_at' && 
    !['tie', 'draw', 'tied', 'drawn'].includes(k.toLowerCase())
  );
  
  // Sort teams: home team first by default
  const teamsSorted = [...teamsRaw].sort((a, b) => {
    const aIsHome = gameState.home_team?.toUpperCase() === a.toUpperCase();
    const bIsHome = gameState.home_team?.toUpperCase() === b.toUpperCase();
    if (aIsHome && !bIsHome) return -1;
    if (!aIsHome && bIsHome) return 1;
    return 0;
  });
  
  // Apply swap if needed
  const teams = teamsSwapped ? [...teamsSorted].reverse() : teamsSorted;
  
  // Set default color for home team (white) when teams first appear
  useEffect(() => {
    if (teamsSorted.length >= 2 && Object.keys(teamColors).length === 0) {
      const homeTeam = teamsSorted[0];
      setTeamColors({ [homeTeam]: '#ffffff' });
    }
  }, [teamsSorted, teamColors]);
  
  // 16-color palette for team buttons
  const colorPalette = [
    '#ffffff', '#ef4444', '#f97316', '#eab308',
    '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
    '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e', '#78716c', '#1f2937'
  ];

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

            {/* Available Events - Grouped by Series */}
            <div className="bg-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">Select an Event to Start Monitoring</h2>
              
              {availableEvents.length === 0 ? (
                <p className="text-gray-400 text-center py-8">No live events available right now</p>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    const now = Math.floor(Date.now() / 1000);
                    const fiveHoursAgo = now - (5 * 3600);
                    const filtered = availableEvents.filter(e => 
                      e.event_timestamp && e.event_timestamp <= now && e.event_timestamp >= fiveHoursAgo
                    );
                    
                    // Group events by series_title (human-readable name)
                    const groupedBySeries: Record<string, AvailableEvent[]> = {};
                    filtered.forEach(event => {
                      const seriesTitle = event.series_title || event.series_ticker || 'Other';
                      if (!groupedBySeries[seriesTitle]) {
                        groupedBySeries[seriesTitle] = [];
                      }
                      groupedBySeries[seriesTitle].push(event);
                    });
                    
                    // Sort series by league priority, then alphabetically
                    // Use first event's ticker for priority lookup
                    const sortedSeriesKeys = Object.keys(groupedBySeries).sort((a, b) => {
                      const firstEventA = groupedBySeries[a][0];
                      const firstEventB = groupedBySeries[b][0];
                      const priorityA = getLeaguePriority(firstEventA?.series_ticker || a);
                      const priorityB = getLeaguePriority(firstEventB?.series_ticker || b);
                      if (priorityA !== priorityB) return priorityA - priorityB;
                      return a.localeCompare(b);
                    });
                    
                    // Sort events within each series by start time
                    sortedSeriesKeys.forEach(seriesTitle => {
                      groupedBySeries[seriesTitle].sort((a, b) => 
                        (a.event_timestamp || 0) - (b.event_timestamp || 0)
                      );
                    });
                    
                    return sortedSeriesKeys.map((seriesTitle) => {
                      const events = groupedBySeries[seriesTitle];
                      const firstEvent = events[0];
                      const isExpanded = expandedSeries.has(seriesTitle);
                      
                      return (
                        <div key={seriesTitle} className="border border-gray-700 rounded-lg overflow-hidden">
                          {/* Series Header - Clickable to expand/collapse */}
                          <button
                            onClick={() => {
                              setExpandedSeries(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(seriesTitle)) {
                                  newSet.delete(seriesTitle);
                                } else {
                                  newSet.add(seriesTitle);
                                }
                                return newSet;
                              });
                            }}
                            className="w-full flex items-center justify-between bg-gray-700 hover:bg-gray-600 px-4 py-3 transition-colors text-left"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-gray-400">{isExpanded ? '▼' : '▶'}</span>
                              <span className="font-semibold text-cyan-400">{seriesTitle}</span>
                              <span className="text-sm text-gray-400">({events.length} {events.length === 1 ? 'event' : 'events'})</span>
                            </div>
                          </button>
                          
                          {/* Events List */}
                          {isExpanded && (
                            <div className="divide-y divide-gray-700">
                              {events.map((event) => (
                                <div 
                                  key={event.event_ticker}
                                  className="flex items-center justify-between bg-gray-800 px-4 py-3 hover:bg-gray-750 transition-colors"
                                >
                                  <div className="flex-1">
                                    <div className="font-medium">{event.title || event.event_ticker}</div>
                                    <div className="text-sm text-gray-400">
                                      {event.event_timestamp && <span className="text-cyan-400">{formatRelativeTime(event.event_timestamp)}</span>}
                                    </div>
                                  </div>
                                  <button
                                    onClick={() => launchEvent(event.event_ticker, event.title)}
                                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg font-medium transition-colors text-sm"
                                  >
                                    Select
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
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
            {/* Team Cards with Swap Button */}
            <div className="flex items-center gap-2 mb-4">
              {teams.length > 0 ? (
                <>
                  {teams.map((team, idx) => {
                    // Determine score for this team based on home/away mapping
                    let teamScore: number | undefined;
                    if (gameState.home_team?.toUpperCase() === team.toUpperCase()) {
                      teamScore = gameState.home_points;
                    } else if (gameState.away_team?.toUpperCase() === team.toUpperCase()) {
                      teamScore = gameState.away_points;
                    }
                    
                    // Check if this team has possession
                    let hasPossession = false;
                    const poss = gameState.possession_team;
                    if (poss) {
                      if (poss.length > 10) {
                        // It's a team ID - check against home/away team IDs
                        const isHome = gameState.home_team?.toUpperCase() === team.toUpperCase();
                        const isAway = gameState.away_team?.toUpperCase() === team.toUpperCase();
                        hasPossession = (isHome && gameState.home_team_id === poss) || 
                                       (isAway && gameState.away_team_id === poss);
                      } else {
                        // It's an abbreviation
                        hasPossession = poss.toUpperCase() === team.toUpperCase();
                      }
                    }
                    
                    const teamData = prices[team];
                    const bids = teamData?.bids || [];
                    const asks = teamData?.asks || [];
                    const teamColor = teamColors[team] || 'transparent';
                    const textColor = teamColor === '#ffffff' || teamColor === '#fbbf24' || teamColor === '#22c55e' || teamColor === '#06b6d4' ? 'text-gray-900' : 'text-white';
                    
                    return (
                      <React.Fragment key={team}>
                        <div className="flex-1 bg-gray-800 rounded-2xl p-4 text-center relative flex flex-col">
                          {/* Color picker button - small rainbow icon in upper left */}
                          <div className="absolute top-2 left-2 z-10">
                            <button
                              onClick={() => setColorPickerOpen(colorPickerOpen === team ? null : team)}
                              className="w-6 h-6 rounded border border-gray-600 hover:border-cyan-400 transition-colors"
                              style={{ 
                                background: 'linear-gradient(135deg, #ef4444 0%, #f97316 17%, #eab308 33%, #22c55e 50%, #06b6d4 67%, #6366f1 83%, #a855f7 100%)'
                              }}
                              title="Change team color"
                            />
                            
                            {/* Color picker popup - expands right and down from upper left */}
                            {colorPickerOpen === team && (
                              <div 
                                className="absolute z-50 bg-gray-900 border border-gray-600 rounded-lg p-3 shadow-xl"
                                style={{ top: '32px', left: '0', minWidth: '140px' }}
                              >
                                <div className="grid grid-cols-4 gap-2">
                                  {colorPalette.map((color) => (
                                    <button
                                      key={color}
                                      onClick={() => {
                                        setTeamColors(prev => ({ ...prev, [team]: color }));
                                        setColorPickerOpen(null);
                                      }}
                                      className={`w-7 h-7 rounded border-2 ${teamColors[team] === color || (!teamColors[team] && idx === 0 && color === '#ffffff') ? 'border-cyan-400 ring-2 ring-cyan-400' : 'border-gray-600 hover:border-gray-400'}`}
                                      style={{ backgroundColor: color }}
                                      title={color}
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          
                          {/* Asks above button - fixed height container */}
                          <div className="font-mono text-xs text-red-400 mb-2 space-y-0.5" style={{ minHeight: '60px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                            {[...asks].slice(0, 3).reverse().map((ask, i) => (
                              <div key={`ask-${i}`}>{Math.round(ask.price * 100)}-{ask.size}</div>
                            ))}
                            {asks.length === 0 && <div className="text-gray-600">--</div>}
                          </div>
                          
                          {/* Buy Button - Team + Score (with possession icon if applicable) */}
                          <button
                            onClick={() => sendBuy(team)}
                            className={`w-full py-8 text-xl font-bold uppercase tracking-wider rounded-xl transition-all transform hover:scale-[1.02] active:scale-[0.98] mb-2 ${textColor}`}
                            style={{ backgroundColor: teamColor === 'transparent' ? undefined : teamColor }}
                          >
                            {hasPossession && '🏈 '}{team.toUpperCase()}{teamScore !== undefined ? ` ${teamScore}` : ''}
                          </button>
                          
                          {/* Bids below button - fixed height container */}
                          <div className="font-mono text-xs text-green-400 mt-2 space-y-0.5" style={{ minHeight: '60px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
                            {bids.slice(0, 3).map((bid, i) => (
                              <div key={`bid-${i}`}>{Math.round(bid.price * 100)}-{bid.size}</div>
                            ))}
                            {bids.length === 0 && <div className="text-gray-600">--</div>}
                          </div>
                        </div>
                        
                        {/* Swap button between teams */}
                        {idx === 0 && teams.length > 1 && (
                          <button
                            onClick={() => setTeamsSwapped(!teamsSwapped)}
                            className="px-2 py-4 bg-gray-700 hover:bg-gray-600 rounded-lg text-xl transition-colors"
                            title="Swap teams"
                          >
                            ⇄
                          </button>
                        )}
                      </React.Fragment>
                    );
                  })}
                </>
              ) : (
                <div className="flex-1 text-center py-12 text-gray-400">
                  Waiting for price updates...
                </div>
              )}
            </div>
            
            {/* Controls Row: Bet Amount + Sell Delay */}
            <div className="flex justify-center items-center gap-4 mb-4">
              <div className="flex items-center gap-2">
                <select
                  value={betAmount}
                  onChange={(e) => setBetAmount(e.target.value)}
                  className="bg-gray-700 text-white px-3 py-2 rounded-lg border border-gray-600 focus:border-cyan-500 focus:outline-none"
                >
                  <option value="$10">10</option>
                  <option value="10%">10%</option>
                  <option value="20%">20%</option>
                  <option value="50%">50%</option>
                  <option value="95%">95%</option>
                </select>
              </div>
              
              <div className="flex items-center gap-2">
                <select
                  value={sellDelay}
                  onChange={(e) => setSellDelay(parseInt(e.target.value))}
                  className="bg-gray-700 text-white px-3 py-2 rounded-lg border border-gray-600 focus:border-cyan-500 focus:outline-none"
                >
                  {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => (
                    <option key={s} value={s}>{s}s</option>
                  ))}
                </select>
              </div>
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
                style={log.color ? { color: log.color, fontWeight: 'bold' } : undefined}
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
