'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

interface QuickBetsSession {
  event_ticker: string;
  user_name: string;
  websocket_url: string;
  fargate_public_ip: string;
  started_at: number;
  last_heartbeat: number;
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

export default function QuickBetsPage() {
  const [session, setSession] = useState<QuickBetsSession | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [prices, setPrices] = useState<TeamPrices>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-100), { time, message, type }]);
  }, []);

  // Fetch active QuickBets session from DynamoDB via API
  useEffect(() => {
    async function fetchSession() {
      try {
        const authSession = await fetchAuthSession();
        if (!authSession.tokens?.idToken) {
          router.push('/');
          return;
        }

        // Call API to get active QuickBets sessions
        const response = await fetch(
          'https://5uthw49k2c.execute-api.us-east-1.amazonaws.com/prod/sessions',
          {
            headers: {
              'Authorization': authSession.tokens.idToken.toString(),
            },
          }
        );

        if (!response.ok) {
          throw new Error('Failed to fetch sessions');
        }

        const data = await response.json();
        if (data.sessions && data.sessions.length > 0) {
          setSession(data.sessions[0]);
          addLog(`Found active session: ${data.sessions[0].event_ticker}`, 'success');
        } else {
          addLog('No active QuickBets sessions found', 'error');
        }
      } catch (err: any) {
        console.error('Error fetching session:', err);
        setError(err.message);
        addLog(`Error: ${err.message}`, 'error');
      } finally {
        setIsLoading(false);
      }
    }

    fetchSession();
  }, [router, addLog]);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const connectWebSocket = useCallback(async () => {
    if (!session) return;

    // Get fresh auth token
    let authToken: string;
    try {
      const authSession = await fetchAuthSession();
      if (!authSession.tokens?.idToken) {
        addLog('Not authenticated', 'error');
        return;
      }
      authToken = authSession.tokens.idToken.toString();
    } catch (e) {
      addLog('Failed to get auth token', 'error');
      return;
    }

    // Use WebSocket URL from session (NLB with valid TLS)
    const wsUrl = session.websocket_url;
    
    setConnecting(true);
    addLog(`Connecting to ${wsUrl}...`);

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog('WebSocket connected, sending auth...', 'info');
        // Send auth message immediately
        ws.send(JSON.stringify({
          type: 'auth',
          token: authToken
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const msgType = data.type || data.event;
          
          // Handle auth success
          if (msgType === 'auth_success') {
            setConnected(true);
            setConnecting(false);
            addLog(`Authenticated as ${data.user}`, 'success');
            return;
          }
          
          // Handle other message types
          switch (msgType) {
            case 'prices':
              if (data.data) {
                setPrices(data.data);
                // Filter out metadata keys like 'updated_at'
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
              // Heartbeat response, ignore
              break;

            case 'error':
              addLog(`Error: ${data.message || data.error}`, 'error');
              break;

            default:
              addLog(`Message: ${JSON.stringify(data)}`, 'info');
          }
        } catch (e) {
          addLog(`Raw message: ${event.data}`, 'info');
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        setConnecting(false);
        addLog(`Disconnected (code: ${event.code})`, 'error');
        wsRef.current = null;
      };

      ws.onerror = () => {
        addLog('WebSocket error', 'error');
      };

    } catch (e: any) {
      setConnecting(false);
      addLog(`Connection failed: ${e.message}`, 'error');
    }
  }, [session, addLog]);

  const handleMessage = useCallback((data: any) => {
    const type = data.type || data.event;

    switch (type) {
      case 'prices':
        if (data.prices) {
          setPrices(data.prices);
          const teams = Object.keys(data.prices);
          addLog(`Price update: ${teams.map(t => `${t}=${data.prices[t].best_ask}¢`).join(', ')}`, 'price');
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

      case 'error':
        addLog(`Error: ${data.message}`, 'error');
        break;

      default:
        addLog(`Message: ${JSON.stringify(data)}`, 'info');
    }
  }, [addLog]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const sendBuy = useCallback((team: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('Not connected!', 'error');
      return;
    }

    addLog(`Sending BUY for ${team}...`);
    wsRef.current.send(JSON.stringify({
      action: 'buy',
      team: team
    }));
  }, [addLog]);

  // Filter out metadata keys from prices to get actual teams
  const teams = Object.keys(prices).filter(k => k !== 'updated_at');

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading QuickBets...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-cyan-400 mb-2">⚡ QuickBets</h1>
        
        {error && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        {/* Connection Status */}
        <div className={`px-4 py-3 rounded-lg mb-6 font-medium ${
          connected 
            ? 'bg-green-900/50 border border-green-500 text-green-200' 
            : connecting
              ? 'bg-yellow-900/50 border border-yellow-500 text-yellow-200'
              : 'bg-red-900/50 border border-red-500 text-red-200'
        }`}>
          {connected 
            ? `Connected to ${session?.event_ticker}` 
            : connecting 
              ? 'Connecting...' 
              : 'Disconnected'}
        </div>

        {/* Session Info */}
        {session && (
          <div className="bg-gray-800 rounded-xl p-6 mb-6">
            <h2 className="text-lg font-semibold mb-3">Session Info</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-400">Event:</span>
                <span className="ml-2 font-mono">{session.event_ticker}</span>
              </div>
              <div>
                <span className="text-gray-400">User:</span>
                <span className="ml-2">{session.user_name}</span>
              </div>
              <div>
                <span className="text-gray-400">Server:</span>
                <span className="ml-2 font-mono text-xs">{session.fargate_public_ip}</span>
              </div>
              <div>
                <span className="text-gray-400">Started:</span>
                <span className="ml-2">{new Date(session.started_at * 1000).toLocaleTimeString()}</span>
              </div>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={connectWebSocket}
                disabled={connected || connecting}
                className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-600 rounded-lg font-medium transition-colors"
              >
                {connecting ? 'Connecting...' : 'Connect'}
              </button>
              <button
                onClick={disconnect}
                disabled={!connected}
                className="px-6 py-2 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 rounded-lg font-medium transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

        {/* Team Cards */}
        {connected && (
          <div className="grid grid-cols-2 gap-6 mb-6">
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
        )}

        {/* Event Log */}
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
