'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

// API base URL for capture game Lambda
const CAPTURE_API_BASE = 'https://8mmffkzucg.execute-api.us-east-1.amazonaws.com/prod';

interface AvailableGame {
  event_ticker: string;
  title: string;
  series_ticker: string;
  series_title?: string;
  league: string;
  event_time: string;
  event_timestamp: number;
  time_display: string;
  has_started: boolean;
}

interface S3Stats {
  file_count: number;
  total_bytes: number;
  total_mb: number;
  display: string;
}

interface QueuedCapture {
  event_ticker: string;
  title: string;
  league: string;
  scheduled_start: number;
  queued_at: number;
  queued_by: string;
  status: 'queued' | 'capturing' | 'completed' | 'failed';
  capture_user: string;
  data_points: number;
  s3_path: string;
  feeder_url?: string;
  s3_stats?: S3Stats;
}

type PageState = 'loading' | 'lobby';

// League icons and colors
const LEAGUE_CONFIG: Record<string, { icon: string; color: string; bgColor: string }> = {
  'NFL': { icon: '🏈', color: 'text-green-700', bgColor: 'bg-green-50' },
  'NCAA Men\'s Basketball': { icon: '🏀', color: 'text-orange-700', bgColor: 'bg-orange-50' },
  'NCAA Women\'s Basketball': { icon: '🏀', color: 'text-pink-700', bgColor: 'bg-pink-50' },
  'NBA': { icon: '🏀', color: 'text-blue-700', bgColor: 'bg-blue-50' },
};

export default function CaptureGamePage() {
  const [pageState, setPageState] = useState<PageState>('loading');
  const [error, setError] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [username, setUsername] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  
  // Lobby state
  const [availableGames, setAvailableGames] = useState<AvailableGame[]>([]);
  const [queuedCaptures, setQueuedCaptures] = useState<QueuedCapture[]>([]);
  const [expandedLeagues, setExpandedLeagues] = useState<Set<string>>(new Set(['NFL', 'NBA', 'NCAA Men\'s Basketball']));
  
  // Confirmation dialog
  const [confirmGame, setConfirmGame] = useState<AvailableGame | null>(null);
  
  const router = useRouter();

  // Load lobby data
  const loadLobby = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      if (!session.tokens?.idToken) {
        router.push('/');
        return;
      }
      const token = session.tokens.idToken.toString();
      setAuthToken(token);
      
      // Get username from token
      const preferredUsername = session.tokens.idToken.payload['preferred_username'] as string;
      const email = session.tokens.idToken.payload['email'] as string;
      const displayName = preferredUsername || (email ? email.split('@')[0] : 'User');
      setUsername(displayName);
      setIsAdmin(displayName === 'admin' || displayName.toLowerCase().includes('admin'));
      
      // Fetch available games
      const gamesResponse = await fetch(`${CAPTURE_API_BASE}/capture/games`, {
        headers: { 'Authorization': token },
      });
      
      if (!gamesResponse.ok) {
        throw new Error('Failed to fetch games');
      }
      
      const gamesData = await gamesResponse.json();
      setAvailableGames(gamesData.games || []);
      
      // Fetch queue
      const queueResponse = await fetch(`${CAPTURE_API_BASE}/capture/queue`, {
        headers: { 'Authorization': token },
      });
      
      if (queueResponse.ok) {
        const queueData = await queueResponse.json();
        setQueuedCaptures(queueData.captures || []);
      }
      
      setPageState('lobby');
      
    } catch (err: any) {
      console.error('Error loading lobby:', err);
      setError(err.message);
      setPageState('lobby');
    }
  }, [router]);

  useEffect(() => {
    loadLobby();
    
    // Refresh queue every 30 seconds
    const interval = setInterval(loadLobby, 30000);
    
    return () => {
      clearInterval(interval);
    };
  }, [loadLobby]);

  // Queue a game for capture
  const queueGame = async (game: AvailableGame) => {
    try {
      const response = await fetch(`${CAPTURE_API_BASE}/capture/queue`, {
        method: 'POST',
        headers: {
          'Authorization': authToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_ticker: game.event_ticker,
          title: game.title,
          league: game.league,
          scheduled_start: game.event_timestamp,
        }),
      });
      
      const data = await response.json();
      
      if (data.success) {
        // Refresh lobby
        await loadLobby();
        setConfirmGame(null);
      } else {
        alert(data.message || 'Failed to queue game');
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  // Remove a game from queue
  const removeFromQueue = async (eventTicker: string) => {
    try {
      const response = await fetch(`${CAPTURE_API_BASE}/capture/queue/${encodeURIComponent(eventTicker)}`, {
        method: 'DELETE',
        headers: { 'Authorization': authToken },
      });
      
      const data = await response.json();
      
      if (data.success) {
        await loadLobby();
      } else {
        alert(data.message || 'Failed to remove from queue');
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  // Format timestamp for display
  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleTimeString();
  };

  // Filter out games that are already queued/capturing OR have already started
  const queuedTickers = new Set(queuedCaptures.map(c => c.event_ticker));
  const gamesNotInQueue = availableGames.filter(game => 
    !queuedTickers.has(game.event_ticker) && !game.has_started
  );
  
  // Group games by league
  const gamesByLeague = gamesNotInQueue.reduce((acc, game) => {
    const league = game.league || 'Other';
    if (!acc[league]) acc[league] = [];
    acc[league].push(game);
    return acc;
  }, {} as Record<string, AvailableGame[]>);

  // Render confirmation dialog
  const renderConfirmDialog = () => {
    if (!confirmGame) return null;
    
    const isAfterStart = confirmGame.has_started;
    
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
          <h3 className="text-lg font-semibold mb-4">
            {isAfterStart ? '⚠️ Game Already Started' : '📹 Confirm Data Capture'}
          </h3>
          
          <div className="mb-4">
            <p className="text-gray-700 mb-2">{confirmGame.title}</p>
            <p className="text-sm text-gray-500">{confirmGame.league} • {confirmGame.time_display}</p>
          </div>
          
          {isAfterStart ? (
            <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 mb-4">
              <p className="text-sm text-yellow-800">
                <strong>Note:</strong> This game has already started. Data capture will begin immediately,
                but you will miss trading data from before capture started.
              </p>
            </div>
          ) : (
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mb-4">
              <p className="text-sm text-blue-800">
                Data capture will automatically begin at game start time and continue until the game ends.
                The captured data will be saved to S3 for later analysis.
              </p>
            </div>
          )}
          
          <div className="flex space-x-3">
            <button
              onClick={() => setConfirmGame(null)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={() => queueGame(confirmGame)}
              className={`flex-1 px-4 py-2 rounded-md text-white ${
                isAfterStart 
                  ? 'bg-yellow-600 hover:bg-yellow-700' 
                  : 'bg-purple-600 hover:bg-purple-700'
              }`}
            >
              {isAfterStart ? 'Start Capture Now' : 'Queue for Capture'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Render queued captures section
  const renderQueuedCaptures = () => {
    if (queuedCaptures.length === 0) return null;
    
    return (
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4 text-gray-800">
          📊 Active & Queued Captures
          <span className="text-sm font-normal text-gray-500 ml-2">(refreshes every 30s)</span>
        </h2>
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Game</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">League</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Start Time</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Captured Data</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {queuedCaptures.map((capture) => {
                const config = LEAGUE_CONFIG[capture.league] || { icon: '🎮', color: 'text-gray-700', bgColor: 'bg-gray-50' };
                const statusColors: Record<string, string> = {
                  'queued': 'bg-yellow-100 text-yellow-800',
                  'capturing': 'bg-green-100 text-green-800',
                  'completed': 'bg-blue-100 text-blue-800',
                  'failed': 'bg-red-100 text-red-800',
                };
                
                return (
                  <tr key={capture.event_ticker} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900">{capture.title}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`${config.color}`}>{config.icon} {capture.league}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {new Date(capture.scheduled_start * 1000).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[capture.status]}`}>
                        {capture.status === 'capturing' ? '🔴 LIVE' : capture.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {capture.s3_stats && capture.s3_stats.total_bytes > 0 ? (
                        <span className="text-green-600 font-medium">
                          ✅ {capture.s3_stats.display}
                        </span>
                      ) : capture.status === 'queued' ? (
                        <span className="text-gray-400">Waiting...</span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm space-x-2">
                      {capture.status === 'queued' && (
                        <button
                          onClick={() => removeFromQueue(capture.event_ticker)}
                          className="text-red-600 hover:text-red-800"
                        >
                          Remove
                        </button>
                      )}
                      {(capture.status === 'capturing' || capture.status === 'completed') && capture.s3_stats && capture.s3_stats.total_bytes > 0 && (
                        <span className="text-gray-500 text-xs">{capture.s3_stats.file_count} file(s)</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // Render available games
  const renderAvailableGames = () => {
    const sortedLeagues = Object.keys(gamesByLeague).sort((a, b) => {
      const order = ['NFL', 'NBA', 'NCAA Men\'s Basketball', 'NCAA Women\'s Basketball'];
      return order.indexOf(a) - order.indexOf(b);
    });
    
    return (
      <div>
        <h2 className="text-lg font-semibold mb-4 text-gray-800">
          Available Games (Next 24 Hours)
        </h2>
        
        {sortedLeagues.length === 0 ? (
          <div className="bg-gray-50 rounded-lg p-8 text-center text-gray-500">
            No games available for capture in the next 24 hours.
          </div>
        ) : (
          <div className="space-y-4">
            {sortedLeagues.map((league) => {
              const games = gamesByLeague[league];
              const config = LEAGUE_CONFIG[league] || { icon: '🎮', color: 'text-gray-700', bgColor: 'bg-gray-50' };
              const isExpanded = expandedLeagues.has(league);
              
              return (
                <div key={league} className="bg-white rounded-lg shadow overflow-hidden">
                  <button
                    onClick={() => {
                      const newExpanded = new Set(expandedLeagues);
                      if (isExpanded) {
                        newExpanded.delete(league);
                      } else {
                        newExpanded.add(league);
                      }
                      setExpandedLeagues(newExpanded);
                    }}
                    className={`w-full px-4 py-3 flex items-center justify-between ${config.bgColor} hover:opacity-90`}
                  >
                    <span className={`font-medium ${config.color}`}>
                      {config.icon} {league} ({games.length} games)
                    </span>
                    <span className="text-gray-500">{isExpanded ? '▼' : '▶'}</span>
                  </button>
                  
                  {isExpanded && (
                    <div className="divide-y divide-gray-100">
                      {games.map((game) => (
                        <div
                          key={game.event_ticker}
                          className="px-4 py-3 flex items-center justify-between hover:bg-gray-50"
                        >
                          <div className="flex-1">
                            <p className="text-sm font-medium text-gray-900">{game.title}</p>
                            <p className="text-xs text-gray-500">{game.time_display}</p>
                          </div>
                          <button
                            onClick={() => setConfirmGame(game)}
                            className="ml-4 px-3 py-1 rounded-md text-sm font-medium bg-purple-100 text-purple-700 hover:bg-purple-200"
                          >
                            Queue
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // Loading state
  if (pageState === 'loading') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg text-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">📹 Capture Game Data</h1>
        <p className="text-gray-600">
          Record trading data for sports games. Data is captured to S3 for later analysis.
        </p>
        {isAdmin && (
          <p className="text-sm text-purple-600 mt-1">
            Admin mode: Captures will use jimc credentials
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {renderQueuedCaptures()}
      {renderAvailableGames()}

      {renderConfirmDialog()}
    </div>
  );
}
