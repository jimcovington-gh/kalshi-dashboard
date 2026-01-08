'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

interface MentionEvent {
  event_ticker: string;
  title: string;
  close_time: number;
  close_time_iso: string;
  scheduled_start?: string;
  words: { market_ticker: string; word: string }[];
  word_count: number;
  container_status: string;
  container_task_arn?: string;
}

interface WordStatus {
  market_ticker: string;
  word: string;
  variants: string[];
  triggered: boolean;
  triggered_at?: number;
  no_purchased: boolean;
  trade_result?: any;
}

interface Speaker {
  id: string;
  sample: string;
  is_valid: boolean;
}

interface ContainerState {
  call_state: string;
  qa_started: boolean;
  speakers: {
    valid_count: number;
    invalid_count: number;
    current: string;
    details: Speaker[];
  };
  transcript_segments: number;
}

interface PnLSummary {
  cash_balance: number;
  total_exposure: number;
  realized_pnl: number;
  trades_count: number;
  trades: any[];
}

interface TranscriptSegment {
  text: string;
  timestamp: number;
  is_final: boolean;
  speaker_id?: string;
}

type PageState = 'loading' | 'events' | 'setup' | 'monitoring';

const API_BASE = 'https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod';

export default function VoiceTraderPage() {
  const router = useRouter();
  const [pageState, setPageState] = useState<PageState>('loading');
  const [events, setEvents] = useState<MentionEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<MentionEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  // Setup form state
  const [audioSource, setAudioSource] = useState<'phone' | 'web'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [passcode, setPasscode] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [qaDetectionEnabled, setQaDetectionEnabled] = useState(true);
  
  // Monitoring state
  const [containerState, setContainerState] = useState<ContainerState | null>(null);
  const [words, setWords] = useState<WordStatus[]>([]);
  const [pnl, setPnl] = useState<PnLSummary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  // Audio playback state
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0.7);
  const [audioActive, setAudioActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  
  // Auth token
  const [authToken, setAuthToken] = useState<string | null>(null);

  // Fetch auth token on mount
  useEffect(() => {
    async function getAuth() {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (token) {
          setAuthToken(token);
          setPageState('events');
        } else {
          router.push('/');
        }
      } catch (err) {
        console.error('Auth error:', err);
        router.push('/');
      }
    }
    getAuth();
  }, [router]);

  // Fetch events
  useEffect(() => {
    if (pageState !== 'events' || !authToken) return;
    
    async function fetchEvents() {
      try {
        const response = await fetch(`${API_BASE}/voice-trader/events`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to fetch events');
        
        const data = await response.json();
        setEvents(data.events || []);
      } catch (err) {
        console.error('Error fetching events:', err);
        setError('Failed to load events');
      }
    }
    
    fetchEvents();
    const interval = setInterval(fetchEvents, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [pageState, authToken]);

  // WebSocket connection for monitoring
  useEffect(() => {
    if (pageState !== 'monitoring' || !wsUrl) return;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer'; // Enable binary data for audio
    
    ws.onopen = () => {
      console.log('Connected to voice trader');
      // Request audio streaming
      ws.send(JSON.stringify({ type: 'enable_audio_stream' }));
    };
    
    ws.onmessage = (event) => {
      // Handle binary audio data
      if (event.data instanceof ArrayBuffer) {
        playAudioChunk(event.data);
        return;
      }
      
      const data = JSON.parse(event.data);
      
      if (data.type === 'full_state') {
        setContainerState(data.call);
        setWords(data.words || []);
        setPnl(data.pnl);
        setTranscript(data.transcript || []);
      } else if (data.type === 'word_triggered') {
        // Flash animation could go here
        console.log('Word triggered:', data.word);
      } else if (data.type === 'disconnect_alert') {
        setError(data.message);
      } else if (data.type === 'audio_active') {
        setAudioActive(data.active);
      }
    };
    
    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
    
    ws.onclose = () => {
      console.log('WebSocket closed');
      setAudioActive(false);
    };
    
    return () => {
      ws.close();
      // Cleanup audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [pageState, wsUrl]);

  // Initialize audio context for playback
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 8000 // Match Kinesis/Transcribe sample rate
      });
      audioContextRef.current = ctx;
      
      // Create gain node for volume control
      const gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      gainNode.gain.value = audioMuted ? 0 : audioVolume;
      gainNodeRef.current = gainNode;
    }
    return audioContextRef.current;
  }, [audioMuted, audioVolume]);

  // Play incoming audio chunk
  const playAudioChunk = useCallback((arrayBuffer: ArrayBuffer) => {
    if (audioMuted) return;
    
    try {
      const ctx = initAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      
      // Decode and play PCM audio (16-bit signed, 8kHz)
      const int16Array = new Int16Array(arrayBuffer);
      const floatArray = new Float32Array(int16Array.length);
      
      // Convert 16-bit to float
      for (let i = 0; i < int16Array.length; i++) {
        floatArray[i] = int16Array[i] / 32768.0;
      }
      
      const audioBuffer = ctx.createBuffer(1, floatArray.length, 8000);
      audioBuffer.copyToChannel(floatArray, 0);
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNodeRef.current || ctx.destination);
      source.start();
    } catch (err) {
      console.error('Audio playback error:', err);
    }
  }, [audioMuted, initAudioContext]);

  // Update volume when slider changes
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = audioMuted ? 0 : audioVolume;
    }
  }, [audioVolume, audioMuted]);

  const handleSelectEvent = (event: MentionEvent) => {
    setSelectedEvent(event);
    setPageState('setup');
  };

  const handleLaunch = async () => {
    if (!selectedEvent || !authToken) return;
    
    // Validation
    if (audioSource === 'phone' && !phoneNumber) {
      setError('Phone number is required');
      return;
    }
    if (audioSource === 'web' && !webUrl) {
      setError('Web URL is required');
      return;
    }
    
    try {
      const body: any = {
        event_ticker: selectedEvent.event_ticker,
        audio_source: audioSource,
        qa_detection_enabled: qaDetectionEnabled,
      };
      
      if (audioSource === 'phone') {
        body.phone_number = phoneNumber;
        if (passcode) {
          body.passcode = passcode;
        }
      } else {
        body.web_url = webUrl;
      }
      
      if (scheduledStart) {
        body.scheduled_start = scheduledStart;
      }
      
      const response = await fetch(`${API_BASE}/voice-trader/launch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify(body)
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to launch');
      }
      
      // Save session ID for status polling
      setSessionId(data.session_id);
      
      // Poll for container to be ready
      await waitForContainer(data.session_id);
      
    } catch (err: any) {
      setError(err.message);
    }
  };

  const waitForContainer = async (sessionId: string) => {
    // Poll status until we get WebSocket URL
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      
      try {
        const response = await fetch(`${API_BASE}/voice-trader/status/${sessionId}`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        
        if (data.websocket_url) {
          setWsUrl(data.websocket_url);
          setPageState('monitoring');
          return;
        }
        
        if (data.ecs_status === 'STOPPED' || data.status === 'failed') {
          throw new Error('Container failed to start');
        }
      } catch (err) {
        console.error('Status poll error:', err);
      }
    }
    
    throw new Error('Container did not start in time');
  };

  const handleReconnect = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'redial' }));
      setError(null);
    }
  };

  const handleStop = async () => {
    if (!sessionId || !authToken) return;
    
    try {
      await fetch(`${API_BASE}/voice-trader/stop/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      
      setPageState('events');
      setSelectedEvent(null);
      setSessionId(null);
    } catch (err) {
      console.error('Stop error:', err);
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleTimeString();
  };

  const getCallStateColor = (state: string) => {
    switch (state) {
      case 'waiting': return 'text-yellow-500';
      case 'connecting': return 'text-blue-500';
      case 'in_progress': return 'text-green-500';
      case 'qa_session': return 'text-orange-500';
      case 'disconnected': return 'text-red-500';
      case 'sweeping_no': return 'text-purple-500';
      case 'completed': return 'text-gray-500';
      default: return 'text-gray-400';
    }
  };

  // Render based on page state
  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (pageState === 'events') {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <h1 className="text-3xl font-bold mb-6">Voice Mention Trader</h1>
        <p className="text-gray-400 mb-6">
          Select an upcoming mention event to trade. The system will dial into the earnings call,
          transcribe in real-time, and automatically trade when target words are spoken.
        </p>
        
        {error && (
          <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}
        
        {events.length === 0 ? (
          <div className="text-gray-400">No upcoming mention events found.</div>
        ) : (
          <div className="grid gap-4">
            {events.map(event => (
              <div
                key={event.event_ticker}
                className="bg-gray-800 rounded-lg p-4 hover:bg-gray-700 cursor-pointer transition"
                onClick={() => handleSelectEvent(event)}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-lg font-semibold">{event.title}</h3>
                    <p className="text-gray-400 text-sm">{event.event_ticker}</p>
                  </div>
                  <div className="text-right">
                    <div className="text-sm text-gray-400">
                      Closes: {new Date(event.close_time * 1000).toLocaleString()}
                    </div>
                    <div className="text-sm text-blue-400">
                      {event.word_count} words to track
                    </div>
                    {event.container_status !== 'not_running' && (
                      <div className="text-sm text-green-400">
                        Container: {event.container_status}
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="mt-3 flex flex-wrap gap-2">
                  {event.words.slice(0, 10).map(w => (
                    <span
                      key={w.market_ticker}
                      className="bg-gray-700 px-2 py-1 rounded text-xs"
                    >
                      {w.word}
                    </span>
                  ))}
                  {event.words.length > 10 && (
                    <span className="text-gray-500 text-xs">
                      +{event.words.length - 10} more
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (pageState === 'setup' && selectedEvent) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <button
          onClick={() => setPageState('events')}
          className="text-gray-400 hover:text-white mb-4"
        >
          ← Back to events
        </button>
        
        <h1 className="text-2xl font-bold mb-2">{selectedEvent.title}</h1>
        <p className="text-gray-400 mb-6">{selectedEvent.event_ticker}</p>
        
        {error && (
          <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">
            {error}
            <button onClick={() => setError(null)} className="ml-4 underline">Dismiss</button>
          </div>
        )}
        
        <div className="bg-gray-800 rounded-lg p-6 max-w-xl">
          <h2 className="text-xl font-semibold mb-4">Audio Source</h2>
          
          <div className="flex gap-4 mb-6">
            <button
              className={`px-4 py-2 rounded ${audioSource === 'phone' ? 'bg-blue-600' : 'bg-gray-700'}`}
              onClick={() => setAudioSource('phone')}
            >
              📞 Phone Dial-In
            </button>
            <button
              className={`px-4 py-2 rounded ${audioSource === 'web' ? 'bg-blue-600' : 'bg-gray-700'}`}
              onClick={() => setAudioSource('web')}
            >
              🌐 Web Stream
            </button>
          </div>
          
          {audioSource === 'phone' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Phone Number</label>
                <input
                  type="text"
                  value={phoneNumber}
                  onChange={e => setPhoneNumber(e.target.value)}
                  placeholder="+1-800-555-1234"
                  className="w-full bg-gray-700 rounded px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Passcode (optional)</label>
                <input
                  type="text"
                  value={passcode}
                  onChange={e => setPasscode(e.target.value)}
                  placeholder="123456# (if required)"
                  className="w-full bg-gray-700 rounded px-3 py-2 text-white"
                />
                <p className="text-xs text-gray-500 mt-1">Leave blank if no passcode needed. Include # or * if required</p>
              </div>
            </div>
          )}
          
          {audioSource === 'web' && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Web Stream URL</label>
              <input
                type="text"
                value={webUrl}
                onChange={e => setWebUrl(e.target.value)}
                placeholder="https://event.choruscall.com/..."
                className="w-full bg-gray-700 rounded px-3 py-2 text-white"
              />
              <p className="text-xs text-gray-500 mt-1">
                ⚠️ Web streams may have 5-15 second delay. Phone is recommended.
              </p>
            </div>
          )}
          
          <div className="mt-6">
            <label className="block text-sm text-gray-400 mb-1">Scheduled Start Time (optional)</label>
            <input
              type="datetime-local"
              value={scheduledStart}
              onChange={e => setScheduledStart(e.target.value)}
              className="w-full bg-gray-700 rounded px-3 py-2 text-white"
            />
            <p className="text-xs text-gray-500 mt-1">
              Container will wait until this time before dialing
            </p>
          </div>
          
          <div className="mt-6">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={qaDetectionEnabled}
                onChange={e => setQaDetectionEnabled(e.target.checked)}
                className="w-4 h-4"
              />
              <span>Enable Q&A Detection</span>
            </label>
            <p className="text-xs text-gray-500 mt-1">
              When enabled, words from Q&A participants (shareholders/analysts) will be ignored.
              Disable this if all speakers' words count.
            </p>
          </div>
          
          <div className="mt-8">
            <button
              onClick={handleLaunch}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-4 rounded"
            >
              🚀 Launch Voice Trader
            </button>
          </div>
        </div>
        
        <div className="mt-6 bg-gray-800 rounded-lg p-4">
          <h3 className="font-semibold mb-2">Words to Track ({selectedEvent.words.length})</h3>
          <div className="flex flex-wrap gap-2">
            {selectedEvent.words.map(w => (
              <span
                key={w.market_ticker}
                className="bg-gray-700 px-2 py-1 rounded text-sm"
              >
                {w.word}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (pageState === 'monitoring' && selectedEvent) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-4">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-xl font-bold">{selectedEvent.title}</h1>
            <div className={`text-sm ${getCallStateColor(containerState?.call_state || '')}`}>
              Status: {containerState?.call_state || 'Unknown'}
              {containerState?.qa_started && ' • Q&A Active'}
            </div>
          </div>
          <div className="flex gap-2">
            {error && (
              <button
                onClick={handleReconnect}
                className="bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded"
              >
                📞 Redial
              </button>
            )}
            <button
              onClick={handleStop}
              className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded"
            >
              Stop
            </button>
          </div>
        </div>
        
        {error && (
          <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}
        
        {/* Audio Controls */}
        <div className="bg-gray-800 rounded-lg p-3 mb-4 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${audioActive ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className="text-sm text-gray-400">
              {audioActive ? 'Audio Active' : 'No Audio'}
            </span>
          </div>
          
          <button
            onClick={() => {
              setAudioMuted(!audioMuted);
              // Resume audio context on user interaction (required by browsers)
              if (audioContextRef.current?.state === 'suspended') {
                audioContextRef.current.resume();
              }
            }}
            className={`px-3 py-1 rounded text-sm ${audioMuted ? 'bg-red-600' : 'bg-gray-700'}`}
          >
            {audioMuted ? '🔇 Unmute' : '🔊 Mute'}
          </button>
          
          <div className="flex items-center gap-2 flex-1 max-w-xs">
            <span className="text-sm text-gray-400">Vol:</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={audioVolume}
              onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
              className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
            <span className="text-sm text-gray-400 w-8">{Math.round(audioVolume * 100)}%</span>
          </div>
          
          <div className="text-xs text-gray-500 ml-auto">
            💡 Click Unmute to hear the live call audio
          </div>
        </div>
        
        <div className="grid grid-cols-3 gap-4">
          {/* Left column: Word Grid */}
          <div className="col-span-2 bg-gray-800 rounded-lg p-4 max-h-[400px] overflow-y-auto">
            <h2 className="font-semibold mb-3">Word Status</h2>
            <div className="grid grid-cols-3 gap-2">
              {words.map(w => (
                <div
                  key={w.market_ticker}
                  className={`p-2 rounded text-sm ${
                    w.triggered
                      ? 'bg-green-900 border border-green-500'
                      : w.no_purchased
                      ? 'bg-red-900 border border-red-500'
                      : 'bg-gray-700'
                  }`}
                >
                  <div className="font-medium truncate" title={w.word}>
                    {w.word}
                  </div>
                  <div className="text-xs text-gray-400">
                    {w.triggered
                      ? `✓ YES @ ${formatTime(w.triggered_at!)}`
                      : w.no_purchased
                      ? '✗ NO purchased'
                      : 'Watching...'}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Right column: P&L + Speakers */}
          <div className="space-y-4">
            {/* P&L */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h2 className="font-semibold mb-2">P&L</h2>
              {pnl && (
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Cash:</span>
                    <span>${pnl.cash_balance.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Exposure:</span>
                    <span>${pnl.total_exposure.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Trades:</span>
                    <span>{pnl.trades_count}</span>
                  </div>
                </div>
              )}
            </div>
            
            {/* Speakers */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h2 className="font-semibold mb-2">Speakers</h2>
              {containerState?.speakers && (
                <div className="text-sm space-y-2">
                  <div className="flex justify-between text-gray-400">
                    <span>Valid: {containerState.speakers.valid_count}</span>
                    <span>Invalid: {containerState.speakers.invalid_count}</span>
                  </div>
                  <div className="space-y-1">
                    {containerState.speakers.details.slice(0, 5).map(s => (
                      <div
                        key={s.id}
                        className={`text-xs p-1 rounded ${
                          s.is_valid ? 'bg-green-900' : 'bg-red-900'
                        }`}
                      >
                        <span className="font-mono">{s.id}</span>: {s.sample}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        
        {/* Transcript */}
        <div className="mt-4 bg-gray-800 rounded-lg p-4 max-h-[300px] overflow-y-auto">
          <h2 className="font-semibold mb-2">Live Transcript</h2>
          <div className="text-sm space-y-1 font-mono">
            {transcript.slice(-30).map((seg, i) => (
              <div key={i} className={seg.is_final ? 'text-white' : 'text-gray-500'}>
                {seg.speaker_id && (
                  <span className="text-blue-400">[{seg.speaker_id}] </span>
                )}
                {seg.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
