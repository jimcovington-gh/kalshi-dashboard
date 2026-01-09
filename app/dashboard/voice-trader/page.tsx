'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter, useSearchParams } from 'next/navigation';

interface MentionEvent {
  event_ticker: string;
  title: string;
  start_date: string;  // ISO format
  hours_until_start: number;
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
  status_message: string;
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

type PageState = 'loading' | 'events' | 'setup' | 'cert_pending' | 'monitoring';

const API_BASE = 'https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod';

export default function VoiceTraderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pageState, setPageState] = useState<PageState>('loading');
  const [events, setEvents] = useState<MentionEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<MentionEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  // Track if we need to send dial command after cert acceptance
  const [pendingDial, setPendingDial] = useState(false);
  const [certAccepted, setCertAccepted] = useState(false);
  
  // Setup form state
  const [audioSource, setAudioSource] = useState<'phone' | 'web'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [passcode, setPasscode] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [qaDetectionEnabled, setQaDetectionEnabled] = useState(true);
  
  // Launch state
  const [launching, setLaunching] = useState(false);
  const [launchStatus, setLaunchStatus] = useState('');
  
  // Monitoring state
  const [containerState, setContainerState] = useState<ContainerState | null>(null);
  const [words, setWords] = useState<WordStatus[]>([]);
  const [pnl, setPnl] = useState<PnLSummary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [certAcceptUrl, setCertAcceptUrl] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  // Audio playback state
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0.7);
  const [audioActive, setAudioActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  
  // Microphone state for two-way audio
  const [micEnabled, setMicEnabled] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioWorkletRef = useRef<AudioWorkletNode | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  
  // Dialpad state
  const [dialpadInput, setDialpadInput] = useState('');
  
  // WebSocket connection state
  const [wsConnected, setWsConnected] = useState(false);
  
  // Auth token
  const [authToken, setAuthToken] = useState<string | null>(null);

  // Check for cert_accepted param on load (redirect back from cert page)
  useEffect(() => {
    const certParam = searchParams.get('cert_accepted');
    const savedSession = searchParams.get('session_id');
    
    if (certParam === 'true') {
      console.log('Certificate accepted, will send dial command');
      setCertAccepted(true);
      setPendingDial(true);
      
      // Restore session if passed
      if (savedSession) {
        setSessionId(savedSession);
      }
      
      // Clean URL params
      router.replace('/dashboard/voice-trader', { scroll: false });
    }
  }, [searchParams, router]);

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

  // Restore session after cert acceptance redirect
  useEffect(() => {
    if (!certAccepted || !authToken) return;
    
    const savedData = sessionStorage.getItem('voice_trader_session');
    if (savedData) {
      try {
        const { sessionId: savedSessionId, wsUrl: savedWsUrl, certAcceptUrl: savedCertUrl, event } = JSON.parse(savedData);
        
        setSessionId(savedSessionId);
        setWsUrl(savedWsUrl);
        setCertAcceptUrl(savedCertUrl);
        if (event) setSelectedEvent(event);
        
        // Go to monitoring page
        setPageState('monitoring');
        
        // Clear saved data
        sessionStorage.removeItem('voice_trader_session');
        
        console.log('Session restored after cert acceptance, will send dial command when WebSocket connects');
      } catch (err) {
        console.error('Error restoring session:', err);
      }
    }
  }, [certAccepted, authToken]);

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

  // WebSocket connection for monitoring (may fail due to mixed content)
  useEffect(() => {
    if (pageState !== 'monitoring' || !wsUrl) return;
    
    // Try to connect to WebSocket
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer'; // Enable binary data for audio
      
      ws.onopen = () => {
        console.log('Connected to voice trader WebSocket');
        setWsConnected(true);
        
        // If we just came back from cert acceptance, send dial command
        if (pendingDial) {
          console.log('Sending dial command after cert acceptance');
          ws?.send(JSON.stringify({ type: 'dial' }));
          setPendingDial(false);
        }
        
        // Request audio streaming
        ws?.send(JSON.stringify({ type: 'enable_audio_stream' }));
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
        console.error('WebSocket error (may be blocked by browser):', err);
        setWsConnected(false);
      };
      
      ws.onclose = () => {
        console.log('WebSocket closed');
        setWsConnected(false);
        setAudioActive(false);
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      setWsConnected(false);
    }
    
    return () => {
      if (ws) ws.close();
      // Cleanup audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      // Cleanup microphone
      stopMicrophone();
    };
  }, [pageState, wsUrl]);

  // Polling fallback for state updates (when WebSocket blocked by browser)
  useEffect(() => {
    if (pageState !== 'monitoring' || !sessionId || !authToken) return;
    
    // Always poll for state since WebSocket is often blocked (mixed content)
    const pollState = async () => {
      try {
        const response = await fetch(`${API_BASE}/voice-trader/status/${sessionId}`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        
        if (!response.ok) return;
        
        const data = await response.json();
        
        // Update state from DynamoDB data (pushed by container)
        if (data.call_state || data.status_message) {
          setContainerState(prev => ({
            ...prev,
            call_state: data.call_state || prev?.call_state || 'connecting',
            status_message: data.status_message || prev?.status_message || 'Loading...',
            qa_started: data.qa_started || false,
            speakers: prev?.speakers || { valid_count: 0, invalid_count: 0, current: '', details: [] },
            transcript_segments: prev?.transcript_segments || 0
          }));
          
          // Update audio active from polling
          if (data.audio_active !== undefined) {
            setAudioActive(data.audio_active);
          }
          
          // Update transcript preview if available
          if (data.transcript_preview) {
            setTranscript(prev => {
              // Add as a new segment if different from last
              const lastText = prev[prev.length - 1]?.text;
              if (lastText !== data.transcript_preview) {
                return [...prev.slice(-29), {
                  text: data.transcript_preview,
                  timestamp: Date.now() / 1000,
                  is_final: true
                }];
              }
              return prev;
            });
          }
        }
        
        // Check if container stopped or call disconnected
        if (data.ecs_status === 'STOPPED' || data.status === 'stopped') {
          setError('Container stopped');
        }
        
        // Set error for disconnected call (enables Redial button)
        if (data.call_state === 'disconnected') {
          setError('Call disconnected. Click Redial to reconnect.');
        }
        
      } catch (err) {
        console.error('Error polling status:', err);
      }
    };
    
    // Poll immediately and every 2 seconds
    pollState();
    const interval = setInterval(pollState, 2000);
    
    return () => clearInterval(interval);
  }, [pageState, sessionId, authToken]);

  // Stop microphone capture
  const stopMicrophone = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioWorkletRef.current) {
      audioWorkletRef.current.disconnect();
      audioWorkletRef.current = null;
    }
    if (micContextRef.current) {
      micContextRef.current.close();
      micContextRef.current = null;
    }
    setMicActive(false);
  }, []);

  // Start microphone capture and send audio to WebSocket
  const startMicrophone = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      return;
    }

    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 8000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      mediaStreamRef.current = stream;

      // Create audio context for processing
      const audioContext = new AudioContext({ sampleRate: 8000 });
      micContextRef.current = audioContext;

      // Create source from microphone
      const source = audioContext.createMediaStreamSource(stream);

      // Create script processor for capturing audio (using deprecated API as fallback)
      // In production, use AudioWorklet for better performance
      const bufferSize = 2048;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32 PCM to mu-law
        const mulawData = new Uint8Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          mulawData[i] = linearToMulaw(inputData[i]);
        }

        // Send as binary data to WebSocket
        wsRef.current.send(mulawData.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setMicActive(true);
      console.log('Microphone capture started');
    } catch (err) {
      console.error('Failed to start microphone:', err);
      setError('Microphone access denied. Please allow microphone access to speak to the call.');
    }
  }, []);

  // Toggle microphone
  const toggleMicrophone = useCallback(async () => {
    if (micActive) {
      stopMicrophone();
    } else {
      await startMicrophone();
    }
  }, [micActive, startMicrophone, stopMicrophone]);

  // Linear PCM to mu-law conversion
  const linearToMulaw = (sample: number): number => {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    const sign = sample < 0 ? 0x80 : 0;
    
    if (sample < 0) sample = -sample;
    
    // Clamp and scale to 16-bit range
    sample = Math.min(sample * 32768, 32767);
    
    // Add bias
    sample += MULAW_BIAS;
    
    // Find segment
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    
    // Calculate mantissa
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    
    // Combine and complement
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
  };

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
    
    setLaunching(true);
    setLaunchStatus('Preparing launch...');
    setError(null);
    
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
      
      setLaunchStatus('Launching container...');
      
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
      
      setLaunchStatus('Container launched! Waiting for it to be ready...');
      
      // Poll for container to be ready
      await waitForContainer(data.session_id);
      
    } catch (err: any) {
      setError(err.message);
      setLaunchStatus('');
      setLaunching(false);
    }
  };

  const waitForContainer = async (sessionId: string) => {
    // Poll status until we get WebSocket URL
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      
      setLaunchStatus(`Waiting for container... (${i * 2}s)`);
      
      try {
        const response = await fetch(`${API_BASE}/voice-trader/status/${sessionId}`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        
        if (data.websocket_url && data.cert_accept_url) {
          setWsUrl(data.websocket_url);
          setCertAcceptUrl(data.cert_accept_url);
          
          // Store session data for after cert acceptance
          sessionStorage.setItem('voice_trader_session', JSON.stringify({
            sessionId,
            wsUrl: data.websocket_url,
            certAcceptUrl: data.cert_accept_url,
            event: selectedEvent
          }));
          
          // Show intermediate cert acceptance page instead of immediate redirect
          // (Browsers don't handle redirects to self-signed certs well)
          setLaunching(false);
          setLaunchStatus('');
          setPageState('cert_pending');
          return;
        }
        
        if (data.ecs_status === 'STOPPED' || data.status === 'failed') {
          throw new Error('Container failed to start');
        }
      } catch (err) {
        console.error('Status poll error:', err);
      }
    }
    
    setLaunching(false);
    setLaunchStatus('');
    throw new Error('Container did not start in time');
  };

  const handleReconnect = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'redial' }));
      setError(null);
    }
  };

  const sendDtmf = (digits: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && digits) {
      wsRef.current.send(JSON.stringify({ type: 'send_dtmf', digits }));
      setDialpadInput('');
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
                      Starts: {new Date(event.start_date).toLocaleString()}
                    </div>
                    <div className="text-sm text-yellow-400">
                      {event.hours_until_start < 1 
                        ? `${Math.round(event.hours_until_start * 60)} min` 
                        : `${event.hours_until_start.toFixed(1)} hrs`} until start
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
              disabled={launching}
              className={`w-full font-bold py-3 px-4 rounded ${
                launching 
                  ? 'bg-gray-600 cursor-not-allowed' 
                  : 'bg-green-600 hover:bg-green-700'
              } text-white`}
            >
              {launching ? '⏳ ' + (launchStatus || 'Launching...') : '🚀 Launch Voice Trader'}
            </button>
            {launchStatus && !launching && (
              <p className="text-center text-gray-400 text-sm mt-2">{launchStatus}</p>
            )}
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

  // Certificate acceptance intermediate page
  if (pageState === 'cert_pending' && certAcceptUrl && selectedEvent) {
    const returnUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/dashboard/voice-trader?cert_accepted=true&session_id=${sessionId}`;
    const certUrl = `${certAcceptUrl}?return_url=${encodeURIComponent(returnUrl)}`;
    
    return (
      <div className="min-h-screen bg-gray-900 text-white p-4 flex items-center justify-center">
        <div className="max-w-lg w-full">
          <div className="bg-gray-800 rounded-lg p-6 shadow-lg">
            <div className="text-center mb-6">
              <div className="text-5xl mb-4">🔐</div>
              <h1 className="text-2xl font-bold mb-2">Accept Security Certificate</h1>
              <p className="text-gray-400">
                One more step to enable real-time audio
              </p>
            </div>
            
            <div className="bg-gray-700 rounded-lg p-4 mb-6">
              <h3 className="font-semibold mb-3">Steps:</h3>
              <ol className="list-decimal list-inside space-y-3 text-sm text-gray-300">
                <li>Click the button below to open the certificate page</li>
                <li>Your browser will show a security warning - this is expected</li>
                <li>Click <span className="text-yellow-400 font-medium">&quot;Advanced&quot;</span> then <span className="text-yellow-400 font-medium">&quot;Proceed&quot;</span></li>
                <li>You&apos;ll be automatically redirected back here</li>
              </ol>
            </div>
            
            <a
              href={certUrl}
              className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg text-center transition-colors"
            >
              Accept Certificate & Continue →
            </a>
            
            <div className="mt-4 text-center">
              <button
                onClick={() => {
                  setPageState('monitoring');
                  setCertAccepted(true);
                }}
                className="text-gray-500 hover:text-gray-400 text-sm underline"
              >
                Skip (microphone won&apos;t work)
              </button>
            </div>
            
            <div className="mt-6 p-3 bg-gray-900 rounded text-xs text-gray-500">
              <strong>Why is this needed?</strong> The voice trader uses a direct WebSocket 
              connection for low-latency audio. Your browser needs to trust this connection 
              for the microphone to work.
            </div>
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
              {containerState?.status_message || containerState?.call_state || 'Connecting...'}
              {containerState?.qa_started && ' • Q&A Active'}
            </div>
          </div>
          <div className="flex gap-2">
            {error && (
              <button
                onClick={handleReconnect}
                className="bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded transition-all duration-100 active:scale-95 active:brightness-75"
              >
                📞 Redial
              </button>
            )}
            <button
              onClick={handleStop}
              className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded transition-all duration-100 active:scale-95 active:brightness-75"
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
        
        {/* Certificate acceptance message - only show if WebSocket failed to connect after cert redirect */}
        {!wsConnected && certAcceptUrl && !pendingDial && (
          <div className="bg-yellow-900 border border-yellow-600 text-yellow-200 px-4 py-3 rounded mb-4">
            <div className="font-semibold mb-1">🔐 WebSocket Connection Failed</div>
            <div className="text-sm">
              If the microphone is not working, you may need to manually accept the certificate:
              <ol className="list-decimal ml-5 mt-2">
                <li>
                  <a 
                    href={certAcceptUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-yellow-400 underline hover:text-yellow-300"
                  >
                    Click here to open {certAcceptUrl}
                  </a>
                </li>
                <li>Click &quot;Advanced&quot; → &quot;Proceed to {certAcceptUrl?.replace('https://', '').split(':')[0]} (unsafe)&quot;</li>
                <li>Return to this tab and refresh the page</li>
              </ol>
            </div>
          </div>
        )}
        
        {/* Audio Controls */}
        <div className="bg-gray-800 rounded-lg p-3 mb-4 flex items-center gap-3 flex-wrap">
          {/* Call status indicator */}
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${audioActive ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className={`text-sm ${audioActive ? 'text-green-400' : 'text-gray-400'}`}>
              {audioActive ? '📞 Connected' : 'Waiting for audio...'}
            </span>
          </div>
          
          {/* Divider */}
          <div className="h-6 w-px bg-gray-600" />
          
          {/* Speaker control (incoming call audio) */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setAudioMuted(!audioMuted);
                // Resume audio context on user interaction (required by browsers)
                if (audioContextRef.current?.state === 'suspended') {
                  audioContextRef.current.resume();
                }
              }}
              className={`px-3 py-1.5 rounded text-sm transition-all duration-100 active:scale-95 active:brightness-75 flex items-center gap-1.5 ${
                audioMuted 
                  ? 'bg-red-600 hover:bg-red-700' 
                  : 'bg-gray-700 hover:bg-gray-600'
              }`}
              title="Mute/unmute incoming call audio"
            >
              {audioMuted ? '🔇' : '🔊'} Speaker
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={audioVolume}
              onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
              className="w-16 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
              title="Speaker volume"
            />
          </div>
          
          {/* Divider */}
          <div className="h-6 w-px bg-gray-600" />
          
          {/* Microphone control (outgoing user audio) */}
          <button
            onClick={toggleMicrophone}
            disabled={!wsConnected}
            className={`px-3 py-1.5 rounded text-sm flex items-center gap-1.5 transition-all duration-100 active:scale-95 active:brightness-75 ${
              !wsConnected
                ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                : micActive 
                  ? 'bg-green-600 hover:bg-green-700' 
                  : 'bg-gray-700 hover:bg-gray-600'
            }`}
            title={!wsConnected 
              ? "Microphone requires WebSocket (blocked by browser security on HTTPS)" 
              : "Toggle your microphone to speak to the call"}
          >
            {micActive ? (
              <>
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                🎤 Mic On
              </>
            ) : (
              '🎤 Mic Muted'
            )}
          </button>
          
          <div className="text-xs text-gray-500 ml-auto hidden lg:block">
            🔊 = hear call &nbsp;|&nbsp; 🎤 = talk to operator
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
            
            {/* Dialpad */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h2 className="font-semibold mb-2">Dialpad</h2>
              <div className="space-y-2">
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={dialpadInput}
                    onChange={(e) => setDialpadInput(e.target.value.replace(/[^0-9*#]/g, ''))}
                    onKeyDown={(e) => e.key === 'Enter' && sendDtmf(dialpadInput)}
                    placeholder="Digits..."
                    className="flex-1 min-w-0 bg-gray-700 px-2 py-1 rounded text-sm font-mono"
                    maxLength={20}
                  />
                  <button
                    onClick={() => sendDtmf(dialpadInput)}
                    disabled={!dialpadInput}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 px-2 py-1 rounded text-sm transition-all duration-100 active:scale-95 active:brightness-75 shrink-0"
                  >
                    ➤
                  </button>
                </div>
                {/* Send PIN button - sends passcode in one burst */}
                {passcode && (
                  <button
                    onClick={() => sendDtmf(passcode)}
                    className="w-full bg-green-600 hover:bg-green-700 py-2 rounded text-sm font-medium transition-all duration-100 active:scale-95 active:brightness-75"
                  >
                    📞 Send PIN ({passcode})
                  </button>
                )}
                <div className="grid grid-cols-3 gap-1">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(d => (
                    <button
                      key={d}
                      onClick={() => sendDtmf(d)}
                      className="bg-gray-700 hover:bg-gray-600 py-2 rounded text-lg font-mono transition-all duration-100 active:scale-95 active:brightness-75"
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
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
