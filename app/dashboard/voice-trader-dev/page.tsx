'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';

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
  qa_detection_enabled?: boolean;  // Whether Q&A detection is enabled for this session
  detection_paused: boolean;
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
  is_event?: boolean;  // For state changes, trades, Q&A, etc.
  event_type?: 'state_change' | 'trade' | 'qa_started' | 'call_end' | 'speaker_change';
}

interface RunningVoiceContainer {
  session_id: string;
  event_ticker: string;
  title: string;
  user_name: string;
  status: string;
  call_state: string;
  started_at: string;
  public_ip?: string;
  websocket_url?: string;
}

interface EC2Status {
  instance_id: string;
  status: 'running' | 'stopped' | 'stopping' | 'pending' | 'terminated';
  public_ip?: string;
  public_dns?: string;
  launch_time?: string;
  uptime_hours?: number;
  websocket_url?: string;
}

type PageState = 'loading' | 'events' | 'setup' | 'monitoring';

const API_BASE = 'https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod';

// DEV Voice Trader - hardcoded to dev backend
const VOICE_TRADER_HOST = 'voice.apexmarkets.us';  // Same as prod - no separate dev server yet
const EC2_BASE = `https://${VOICE_TRADER_HOST}:8080`;  // EC2 endpoint
const WS_BASE = `wss://${VOICE_TRADER_HOST}:8765`;  // WebSocket endpoint

export default function VoiceTraderDevPage() {
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
  
  // Launch state
  const [launching, setLaunching] = useState(false);
  const [launchStatus, setLaunchStatus] = useState('');
  
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
  // Jitter buffer: track next scheduled playback time for gapless audio
  const nextPlayTimeRef = useRef<number>(0);
  const JITTER_BUFFER_MS = 50; // Buffer 50ms before starting playback (low latency for operator conversation);
  // Audio chunk counter for debugging
  const audioChunkCountRef = useRef<number>(0);
  const audioChunkLogIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Microphone state for two-way audio
  const [micEnabled, setMicEnabled] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioWorkletRef = useRef<AudioWorkletNode | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  
  // Dialpad state
  const [dialpadInput, setDialpadInput] = useState('');
  const [dialpadOpen, setDialpadOpen] = useState(false);
  
  // Trading parameters state
  const [betSize, setBetSize] = useState<number>(10);  // Current bet size in dollars - user controlled only
  const [betSizeInput, setBetSizeInput] = useState<string>('10');  // Text input value
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [availableCash, setAvailableCash] = useState<number>(0);
  const [minTrade, setMinTrade] = useState<number>(10);  // Minimum trade size
  
  // WebSocket connection state
  const [wsConnected, setWsConnected] = useState(false);
  
  // Auto-dial state (true if voice trader will dial at scheduled time without user interaction)
  // Default to false so Start Call button shows until server confirms auto-dial
  const [autoDial, setAutoDial] = useState(false);
  
  // Auth token
  const [authToken, setAuthToken] = useState<string | null>(null);
  
  // Wake lock to prevent screen sleep during monitoring
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  
  // State for dial button UI feedback
  const [dialing, setDialing] = useState(false);
  
  // Running containers (for reconnection)
  const [runningContainers, setRunningContainers] = useState<RunningVoiceContainer[]>([]);

  // EC2 Voice Server state
  const [ec2Status, setEc2Status] = useState<EC2Status | null>(null);
  const [ec2Loading, setEc2Loading] = useState(false);
  const [ec2Error, setEc2Error] = useState<string | null>(null);

  // Check for cert_accepted param on load (redirect back from cert page)
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

  // Wake lock management - prevents screen sleep during monitoring
  useEffect(() => {
    if (pageState !== 'monitoring') {
      // Release wake lock when not monitoring
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('Wake lock released');
      }
      return;
    }
    
    // Request wake lock when monitoring
    async function requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          console.log('Wake lock acquired - screen will stay on');
          
          wakeLockRef.current.addEventListener('release', () => {
            console.log('Wake lock released by system');
          });
        } catch (err) {
          console.log('Wake lock request failed:', err);
        }
      } else {
        console.log('Wake Lock API not supported');
      }
    }
    
    requestWakeLock();
    
    // Re-acquire wake lock when page becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && pageState === 'monitoring') {
        requestWakeLock();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
  }, [pageState]);

  // Fetch events and running containers
  useEffect(() => {
    if (pageState !== 'events' || !authToken) return;
    
    async function fetchEvents() {
      try {
        // Fetch events directly from EC2
        const response = await fetch(`${EC2_BASE}/events`);
        
        if (!response.ok) throw new Error('Failed to fetch events');
        
        const data = await response.json();
        setEvents(data.events || []);
      } catch (err) {
        console.error('Error fetching events:', err);
        setError('Failed to load events - is the voice server running?');
      }
    }
    
    async function fetchRunningContainers() {
      // Get status directly from EC2
      try {
        const response = await fetch(`${EC2_BASE}/status`);
        
        if (response.ok) {
          const data = await response.json();
          // Convert single session status to container list format
          if (data.status !== 'idle' && data.session_id) {
            setRunningContainers([{
              session_id: data.session_id || 'current',
              event_ticker: data.event_ticker,
              title: data.event_ticker,
              user_name: data.user_name || 'unknown',
              status: data.status,
              call_state: data.call_state,
              started_at: data.started_at,
              websocket_url: WS_BASE
            }]);
          } else {
            setRunningContainers([]);
          }
        }
      } catch (err) {
        console.error('Error fetching status:', err);
        setRunningContainers([]);
      }
    }

    async function fetchEC2Status() {
      // Check if EC2 is responding by hitting health endpoint
      try {
        const response = await fetch(`${EC2_BASE}/health`);
        
        if (response.ok) {
          const data = await response.json();
          setEc2Status({
            instance_id: data.instance_id || 'voice-trader-ec2',
            status: 'running',
            public_ip: data.public_ip || VOICE_TRADER_HOST,
            websocket_url: WS_BASE,
            uptime_hours: data.uptime_seconds ? data.uptime_seconds / 3600 : undefined
          });
          setEc2Error(null);
        } else {
          setEc2Status({
            instance_id: 'voice-trader-ec2',
            status: 'stopped',
            public_ip: undefined,
            websocket_url: undefined
          });
        }
      } catch (err) {
        // If we can't reach EC2, it's probably stopped
        setEc2Status({
          instance_id: 'voice-trader-ec2',
          status: 'stopped',
          public_ip: undefined,
          websocket_url: undefined
        });
        setEc2Error('Voice server not responding');
      }
    }
    
    fetchEvents();
    fetchRunningContainers();
    fetchEC2Status();
    const eventsInterval = setInterval(fetchEvents, 30000); // Refresh every 30s
    const containersInterval = setInterval(fetchRunningContainers, 10000); // Refresh every 10s
    const ec2Interval = setInterval(fetchEC2Status, 5000); // Refresh EC2 status every 5s
    return () => {
      clearInterval(eventsInterval);
      clearInterval(containersInterval);
      clearInterval(ec2Interval);
    };
  }, [pageState, authToken]);

  // WebSocket connection for monitoring with retry logic
  useEffect(() => {
    if (pageState !== 'monitoring' || !wsUrl) return;
    
    let ws: WebSocket | null = null;
    let retryCount = 0;
    const maxRetries = 15;  // Try for ~30 seconds (2s intervals)
    let retryTimeout: NodeJS.Timeout | null = null;
    let isConnecting = true;
    
    const connectWebSocket = () => {
      if (!isConnecting) return;
      
      try {
        console.log(`WebSocket connecting to ${wsUrl} (attempt ${retryCount + 1}/${maxRetries})...`);
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.binaryType = 'arraybuffer'; // Enable binary data for audio
        
        ws.onopen = () => {
          console.log('Connected to voice trader WebSocket');
          setWsConnected(true);
          retryCount = 0;  // Reset retry count on success
          
          // Request audio streaming
          ws?.send(JSON.stringify({ type: 'enable_audio_stream' }));
          // Request trading parameters
          ws?.send(JSON.stringify({ type: 'get_trading_params' }));
          // Send current bet size (user-controlled, defaults to $10)
          ws?.send(JSON.stringify({ type: 'set_bet_size', dollars: betSize }));
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
            // Track if voice trader is waiting for manual dial
            if (data.auto_dial !== undefined) {
              setAutoDial(data.auto_dial);
            }
            // Reset dialing state when call progresses past connecting
            if (data.call?.call_state && data.call.call_state !== 'connecting') {
              setDialing(false);
            }
          } else if (data.type === 'transcript') {
            // Real-time transcript segment from voice trader
            setTranscript(prev => {
              const newSegment: TranscriptSegment = {
                text: data.text,
                is_final: data.is_final,
                speaker_id: data.speaker_id,
                timestamp: data.timestamp
              };
              
              // Option B: Replace partials with finals, keep evolving sentence
              if (data.is_final) {
                // Final: remove recent partials and add this final
                const withoutRecentPartials = prev.filter((seg, idx) => {
                  // Keep all finals and events
                  if (seg.is_final || seg.is_event) return true;
                  // Keep partials older than 5 seconds
                  if (seg.timestamp && data.timestamp - seg.timestamp > 5) return true;
                  return false;
                });
                return [...withoutRecentPartials.slice(-99), newSegment];
              } else {
                // Partial: replace the last partial (if any) with this one
                const lastIdx = prev.length - 1;
                if (lastIdx >= 0 && !prev[lastIdx].is_final && !prev[lastIdx].is_event) {
                  // Replace last partial
                  return [...prev.slice(0, lastIdx), newSegment];
                }
                return [...prev.slice(-99), newSegment];
              }
            });
          } else if (data.type === 'word_triggered') {
            // Update the words state to mark this word as triggered
            console.log('[WORD] Triggered:', data.word, data.market_ticker);
            setWords(prev => prev.map(w => 
              w.market_ticker === data.market_ticker 
                ? { ...w, triggered: true, triggered_at: data.timestamp }
                : w
            ));
          } else if (data.type === 'event') {
            // Add event to transcript log (state changes, trades, Q&A, etc.)
            setTranscript(prev => {
              const eventSegment: TranscriptSegment = {
                text: data.message,
                timestamp: data.timestamp,
                is_final: true,
                is_event: true,
                event_type: data.event_type
              };
              return [...prev.slice(-99), eventSegment];
            });
          } else if (data.type === 'speaker_change') {
            // Add speaker change marker to transcript
            setTranscript(prev => {
              const speakerEvent: TranscriptSegment = {
                text: `── Speaker: ${data.speaker_name || data.speaker_id} ──`,
                timestamp: data.timestamp,
                is_final: true,
                is_event: true,
                event_type: 'speaker_change',
                speaker_id: data.speaker_id
              };
              return [...prev.slice(-99), speakerEvent];
            });
          } else if (data.type === 'disconnect_alert') {
            setError(data.message);
            setAudioActive(false);  // Call disconnected - not active anymore
          } else if (data.type === 'audio_active') {
            setAudioActive(data.active);
          } else if (data.type === 'trading_params') {
            // Update cash balance from server - bet size is user-controlled only
            setCashBalance(data.cash_balance || 0);
            setAvailableCash(data.available_cash || 0);
            setMinTrade(data.min_trade || 10);
            // DO NOT update betSize from server - user controls it entirely
          }
        };
        
        ws.onerror = (err) => {
          console.error('WebSocket error:', err);
        };
        
        ws.onclose = (event) => {
          console.log(`WebSocket closed (code: ${event.code}). Total chunks received: ${audioChunkCountRef.current}`);
          setWsConnected(false);
          setAudioActive(false);
          // Reset jitter buffer and chunk counter for next connection
          nextPlayTimeRef.current = 0;
          audioChunkCountRef.current = 0;
          
          // Only show error if connection dropped unexpectedly (not user-initiated close)
          // Code 1000 = normal closure, 1001 = going away (navigation)
          if (event.code !== 1000 && event.code !== 1001 && !isConnecting) {
            setError(`Connection lost (code: ${event.code})`);
          }
          
          // Retry if we haven't connected yet and haven't exceeded retries
          if (isConnecting && retryCount < maxRetries) {
            retryCount++;
            console.log(`Retrying WebSocket in 2 seconds... (${retryCount}/${maxRetries})`);
            retryTimeout = setTimeout(connectWebSocket, 2000);
          }
        };
      } catch (err) {
        console.error('Failed to create WebSocket:', err);
        setWsConnected(false);
        
        // Retry on exception too
        if (isConnecting && retryCount < maxRetries) {
          retryCount++;
          retryTimeout = setTimeout(connectWebSocket, 2000);
        }
      }
    };
    
    connectWebSocket();
    
    return () => {
      isConnecting = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      if (ws) ws.close();
      // Cleanup audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      // Reset jitter buffer
      nextPlayTimeRef.current = 0;
      // Cleanup microphone
      stopMicrophone();
    };
  }, [pageState, wsUrl]);

  // Polling fallback for state updates (when WebSocket blocked by browser)
  useEffect(() => {
    if (pageState !== 'monitoring' || !sessionId) return;
    
    // Always poll for state since WebSocket is often blocked (mixed content)
    const pollState = async () => {
      try {
        // Poll EC2 directly for session status
        const response = await fetch(`${EC2_BASE}/status`);
        
        if (!response.ok) return;
        
        const data = await response.json();
        
        // Handle idle state - no active session on server
        if (data.status === 'idle') {
          // Check if there was a recent error (session failed to start)
          if (data.last_error) {
            setError(`Session failed: ${data.last_error}`);
          } else {
            setError('Session ended. Return to events to start a new call.');
          }
          setAudioActive(false);
          return;
        }
        
        // Update state from status endpoint (includes full state_summary)
        if (data.call_state || data.status_message) {
          setContainerState(prev => ({
            ...prev,
            call_state: data.call_state || prev?.call_state || 'connecting',
            status_message: data.status_message || prev?.status_message || 'Loading...',
            qa_started: data.qa_started || false,
            detection_paused: data.detection_paused || false,
            // Use speakers from response, fallback to prev if not present
            speakers: data.speakers || prev?.speakers || { valid_count: 0, invalid_count: 0, current: '', details: [] },
            transcript_segments: data.transcript_segments || prev?.transcript_segments || 0
          }));
          
          // Reset dialing state when call progresses past connecting
          if (data.call_state && data.call_state !== 'connecting') {
            setDialing(false);
          }
          
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
          setAudioActive(false);
        }
        
        // Don't set error for disconnected - the status display handles it cleanly
        if (data.call_state === 'disconnected') {
          setAudioActive(false);
          setDialing(false);  // Reset dialing state
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
      audioWorkletRef.current.port.close();
      audioWorkletRef.current.disconnect();
      audioWorkletRef.current = null;
    }
    if (micContextRef.current) {
      micContextRef.current.close();
      micContextRef.current = null;
    }
    setMicActive(false);
  }, []);

  // Start microphone capture using AudioWorklet (lowest latency)
  // Falls back to ScriptProcessorNode if AudioWorklet unavailable
  // OPTIMIZED FOR LOW LATENCY - critical for real-time conference call interaction
  const startMicrophone = useCallback(async () => {
    console.log('[MIC] startMicrophone called');
    console.log('[MIC] wsRef.current:', wsRef.current);
    console.log('[MIC] readyState:', wsRef.current?.readyState, '(OPEN=1)');
    
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[MIC] WebSocket not connected - aborting mic start');
      return;
    }

    try {
      console.log('[MIC] Requesting microphone access...');
      // Request microphone access with low-latency constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 8000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // Request low latency from browser
          latency: 0,
        } as MediaTrackConstraints
      });
      mediaStreamRef.current = stream;

      // Create audio context with low-latency hint
      const audioContext = new AudioContext({ 
        sampleRate: 8000,
        latencyHint: 'interactive'  // Request lowest latency
      });
      micContextRef.current = audioContext;

      // Create source from microphone
      const source = audioContext.createMediaStreamSource(stream);

      // Try to use AudioWorklet (modern, lowest latency ~16ms)
      // Falls back to ScriptProcessorNode (~32ms) if unavailable
      // Use inline blob URL for reliability (avoids file loading/caching issues)
      if (audioContext.audioWorklet) {
        try {
          // Inline worklet code as blob - more reliable than external file
          const workletCode = `
            class MicrophoneProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.buffer = [];
                this.targetSamples = 256; // ~32ms at 8kHz
              }
              
              process(inputs, outputs, parameters) {
                const input = inputs[0];
                if (!input || !input[0]) return true;
                
                const samples = input[0];
                for (let i = 0; i < samples.length; i++) {
                  this.buffer.push(this.linearToMulaw(samples[i]));
                }
                
                if (this.buffer.length >= this.targetSamples) {
                  const data = new Uint8Array(this.buffer);
                  this.buffer = [];
                  this.port.postMessage(data.buffer, [data.buffer]);
                }
                return true;
              }
              
              linearToMulaw(sample) {
                const BIAS = 33;
                const sign = sample < 0 ? 0x80 : 0;
                if (sample < 0) sample = -sample;
                sample = Math.min(sample * 32768, 32767) + BIAS;
                let exp = 7;
                for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; mask >>= 1) exp--;
                const mantissa = (sample >> (exp + 3)) & 0x0F;
                return (~(sign | (exp << 4) | mantissa)) & 0xFF;
              }
            }
            registerProcessor('microphone-processor', MicrophoneProcessor);
          `;
          
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const workletUrl = URL.createObjectURL(blob);
          await audioContext.audioWorklet.addModule(workletUrl);
          URL.revokeObjectURL(workletUrl);
          
          const workletNode = new AudioWorkletNode(audioContext, 'microphone-processor');
          audioWorkletRef.current = workletNode;
          
          // Track sent packets for debugging
          let micPacketsSent = 0;
          
          // Receive mu-law audio from worklet and send to WebSocket
          workletNode.port.onmessage = (event) => {
            micPacketsSent++;
            if (micPacketsSent <= 5 || micPacketsSent % 50 === 0) {
              console.log(`[MIC] Sending packet #${micPacketsSent}, size=${event.data.byteLength}`);
            }
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
              if (micPacketsSent <= 5) {
                console.error('[MIC] WebSocket not open, cannot send audio');
              }
              return;
            }
            wsRef.current.send(event.data);
          };
          
          source.connect(workletNode);
          // Don't connect to destination - we don't want to hear ourselves
          
          setMicActive(true);
          console.log('Microphone capture started (AudioWorklet mode: ~16ms latency)');
          return;
        } catch (workletErr) {
          console.warn('AudioWorklet failed, falling back to ScriptProcessor:', workletErr);
        }
      }

      // Fallback: ScriptProcessorNode (deprecated but widely supported)
      // CRITICAL: Use smallest possible buffer size for lowest latency
      // bufferSize = 256 samples @ 8kHz = 32ms
      const bufferSize = 256;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32 PCM to mu-law (optimized tight loop)
        const mulawData = new Uint8Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          mulawData[i] = linearToMulaw(inputData[i]);
        }

        // Send as binary data to WebSocket immediately
        wsRef.current.send(mulawData.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setMicActive(true);
      console.log('Microphone capture started (ScriptProcessor fallback: ~32ms latency)');
    } catch (err) {
      console.error('Failed to start microphone:', err);
      setError('Microphone access denied. Please allow microphone access to speak to the call.');
    }
  }, []);

  // Toggle microphone
  const toggleMicrophone = useCallback(async () => {
    console.log('[MIC] Toggle clicked, micActive:', micActive, 'wsConnected:', wsConnected);
    if (micActive) {
      console.log('[MIC] Stopping microphone...');
      stopMicrophone();
    } else {
      console.log('[MIC] Starting microphone...');
      await startMicrophone();
    }
  }, [micActive, wsConnected, startMicrophone, stopMicrophone]);

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

  // Play incoming audio chunk with jitter buffer for smooth playback
  const playAudioChunk = useCallback((arrayBuffer: ArrayBuffer) => {
    // Count ALL chunks received (even if muted)
    audioChunkCountRef.current++;
    const chunkNum = audioChunkCountRef.current;
    
    // Log every 50 chunks (roughly every second at 50 chunks/sec)
    if (chunkNum === 1 || chunkNum % 50 === 0) {
      console.log(`[AUDIO] Received chunk #${chunkNum}, size=${arrayBuffer.byteLength} bytes`);
    }
    
    if (audioMuted) return;
    
    try {
      const ctx = initAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      
      // Decode PCM audio (16-bit signed, 8kHz)
      const int16Array = new Int16Array(arrayBuffer);
      const floatArray = new Float32Array(int16Array.length);
      
      // Convert 16-bit to float
      for (let i = 0; i < int16Array.length; i++) {
        floatArray[i] = int16Array[i] / 32768.0;
      }
      
      const audioBuffer = ctx.createBuffer(1, floatArray.length, 8000);
      audioBuffer.copyToChannel(floatArray, 0);
      
      // Calculate chunk duration in seconds
      const chunkDuration = floatArray.length / 8000;
      
      // Jitter buffer: Schedule playback at precise times for gapless audio
      const now = ctx.currentTime;
      
      // If this is the first chunk or we've fallen behind, reset the schedule
      // Add jitter buffer delay on first chunk for smoother playback
      if (nextPlayTimeRef.current <= now) {
        nextPlayTimeRef.current = now + (JITTER_BUFFER_MS / 1000);
      }
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNodeRef.current || ctx.destination);
      
      // Schedule this chunk at the next available slot
      source.start(nextPlayTimeRef.current);
      
      // Advance the play time for the next chunk
      nextPlayTimeRef.current += chunkDuration;
      
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

  // EC2 Control handlers
  const handleEC2Start = async () => {
    if (!authToken) return;
    setEc2Loading(true);
    setEc2Error(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/start?env=dev`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) {
        setEc2Error(data.error || 'Failed to start EC2 instance');
      } else {
        // Immediately update status to show pending
        setEc2Status(prev => prev ? { ...prev, status: 'pending' } : null);
      }
    } catch (err) {
      setEc2Error('Failed to start EC2 instance');
    } finally {
      setEc2Loading(false);
    }
  };

  const handleEC2Stop = async () => {
    if (!authToken) return;
    if (!confirm('Are you sure you want to stop the voice server? This will disconnect any active sessions.')) {
      return;
    }
    setEc2Loading(true);
    setEc2Error(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/stop?env=dev`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) {
        setEc2Error(data.error || 'Failed to stop EC2 instance');
      } else {
        // Immediately update status to show stopping
        setEc2Status(prev => prev ? { ...prev, status: 'stopping' } : null);
      }
    } catch (err) {
      setEc2Error('Failed to stop EC2 instance');
    } finally {
      setEc2Loading(false);
    }
  };

  const handleEC2Reboot = async () => {
    if (!authToken) return;
    if (!confirm('Are you sure you want to reboot the voice server? Active sessions will be disconnected.')) {
      return;
    }
    setEc2Loading(true);
    setEc2Error(null);
    try {
      const response = await fetch(`${API_BASE}/voice-trader/ec2/reboot?env=dev`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) {
        setEc2Error(data.error || 'Failed to reboot EC2 instance');
      } else {
        // Immediately update status to show pending
        setEc2Status(prev => prev ? { ...prev, status: 'pending' } : null);
      }
    } catch (err) {
      setEc2Error('Failed to reboot EC2 instance');
    } finally {
      setEc2Loading(false);
    }
  };

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
    
    // Check if EC2 server is responding
    if (ec2Status?.status !== 'running') {
      setError('Voice server is not running. Please start it first.');
      return;
    }
    
    setLaunching(true);
    setLaunchStatus('Dialing...');
    setError(null);
    
    try {
      // Call EC2 directly - no Lambda needed!
      const body: any = {
        event_ticker: selectedEvent.event_ticker,
        user_name: 'jimc',  // TODO: Get from auth
      };
      
      // Add audio source specific fields
      if (audioSource === 'phone') {
        body.phone_number = phoneNumber;
        if (passcode) {
          body.passcode = passcode;
        }
      } else if (audioSource === 'web') {
        body.stream_url = webUrl;
      }
      
      const response = await fetch(`${EC2_BASE}/dial`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to launch');
      }
      
      // Save session ID for status polling
      setSessionId(data.session_id);
      
      // EC2 launch returns websocket_url immediately
      if (data.websocket_url) {
        setWsUrl(data.websocket_url);
        
        // EC2 uses voice.apexmarkets.us with Let's Encrypt - valid cert, go straight to monitoring
        setLaunching(false);
        setLaunchStatus('');
        setPageState('monitoring');
        return;
      }
      
      throw new Error('No WebSocket URL returned from server');
      
    } catch (err: any) {
      setError(err.message);
      setLaunchStatus('');
      setLaunching(false);
    }
  };

  const handleReconnect = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'redial' }));
      setError(null);
    }
  };

  // Reconnect to an existing running container
  const handleReconnectToContainer = async (container: RunningVoiceContainer) => {
    if (!authToken) return;
    
    setError(null);
    setSessionId(container.session_id);
    
    // Find the event for this container
    const matchingEvent = events.find(e => e.event_ticker === container.event_ticker);
    if (matchingEvent) {
      setSelectedEvent(matchingEvent);
    } else {
      // Create a minimal event object for display
      setSelectedEvent({
        event_ticker: container.event_ticker,
        title: container.title || container.event_ticker,
        start_date: container.started_at,
        hours_until_start: 0,
        words: [],
        word_count: 0,
        container_status: container.status
      });
    }
    
    if (container.websocket_url) {
      setWsUrl(container.websocket_url);
      
      // Go directly to monitoring - EC2 uses Let's Encrypt, cert is valid
      setPageState('monitoring');
    } else {
      setError('Container does not have a WebSocket URL yet');
    }
  };

  const sendDtmf = (digits: string) => {
    console.log('[DTMF] sendDtmf called with:', digits);
    console.log('[DTMF] wsRef.current:', wsRef.current ? 'exists' : 'null');
    console.log('[DTMF] readyState:', wsRef.current?.readyState, '(OPEN=1)');
    
    if (!digits) {
      console.error('[DTMF] No digits provided');
      return;
    }
    
    if (!wsRef.current) {
      console.error('[DTMF] WebSocket not initialized');
      return;
    }
    
    if (wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[DTMF] WebSocket not open, state:', wsRef.current.readyState);
      return;
    }
    
    const msg = JSON.stringify({ type: 'send_dtmf', digits });
    console.log('[DTMF] Sending:', msg);
    wsRef.current.send(msg);
    setDialpadInput('');
  };

  // Send bet size to server
  const sendBetSize = (dollars: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[BET] WebSocket not connected');
      return;
    }
    const msg = JSON.stringify({ type: 'set_bet_size', dollars });
    console.log('[BET] Sending:', msg);
    wsRef.current.send(msg);
    setBetSize(dollars);
  };

  // Handle bet size input change
  const handleBetSizeChange = (value: string) => {
    setBetSizeInput(value);
    const dollars = parseFloat(value);
    if (!isNaN(dollars) && dollars >= 0) {
      sendBetSize(dollars);
    }
  };

  // Periodic trading params refresh
  useEffect(() => {
    if (pageState !== 'monitoring' || !wsRef.current) return;
    
    const interval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'get_trading_params' }));
      }
    }, 2000);  // Refresh every 2 seconds
    
    return () => clearInterval(interval);
  }, [pageState]);

  const handleStop = async () => {
    if (!sessionId) {
      setError('No active session to stop');
      return;
    }
    
    try {
      console.log('Stopping session:', sessionId);
      const response = await fetch(`${EC2_BASE}/stop/${encodeURIComponent(sessionId)}`, {
        method: 'POST'
      });
      console.log('Stop response:', response.status);
      
      // Go back to lobby
      setPageState('events');
      setSelectedEvent(null);
      setSessionId(null);
      setContainerState(null);
      setError(null);
    } catch (err) {
      console.error('Stop error:', err);
      setError('Failed to end call: ' + (err as Error).message);
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
        {/* DEV ENVIRONMENT BANNER */}
        <div className="bg-yellow-600 text-yellow-900 px-4 py-2 rounded-lg mb-4 flex items-center gap-2">
          <span className="text-xl">🧪</span>
          <span className="font-bold">DEV ENVIRONMENT</span>
          <span className="text-sm">— Connected to dev-voice.apexmarkets.us (DRY_RUN mode by default)</span>
        </div>
        
        <h1 className="text-3xl font-bold mb-6">Voice Mention Trader <span className="text-yellow-500 text-xl">(DEV)</span></h1>
        <p className="text-gray-400 mb-6">
          Select an upcoming mention event to trade. The system will dial into the earnings call,
          transcribe in real-time, and automatically trade when target words are spoken.
        </p>
        
        {error && (
          <div className="bg-red-900 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* EC2 Voice Server Control Panel */}
        <div className="mb-8 bg-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
            <span>🖥️</span>
            <span>Voice Server</span>
            {ec2Status && (
              <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
                ec2Status.status === 'running' ? 'bg-green-700 text-green-200' :
                ec2Status.status === 'stopped' ? 'bg-red-700 text-red-200' :
                ec2Status.status === 'pending' || ec2Status.status === 'stopping' ? 'bg-yellow-700 text-yellow-200' :
                'bg-gray-700 text-gray-300'
              }`}>
                {ec2Status.status.toUpperCase()}
              </span>
            )}
          </h2>
          
          {ec2Error && (
            <div className="bg-red-900/50 border border-red-700 text-red-200 px-3 py-2 rounded mb-3 text-sm">
              {ec2Error}
            </div>
          )}
          
          {ec2Status ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-4 text-sm">
                <div>
                  <span className="text-gray-400">Status:</span>{' '}
                  <span className={
                    ec2Status.status === 'running' ? 'text-green-400' :
                    ec2Status.status === 'stopped' ? 'text-red-400' :
                    'text-yellow-400'
                  }>
                    {ec2Status.status === 'running' && '●'} {ec2Status.status}
                  </span>
                </div>
                {ec2Status.public_ip && (
                  <div>
                    <span className="text-gray-400">IP:</span>{' '}
                    <span className="font-mono text-blue-400">{ec2Status.public_ip}</span>
                  </div>
                )}
                {ec2Status.public_dns && (
                  <div>
                    <span className="text-gray-400">DNS:</span>{' '}
                    <span className="font-mono text-blue-400 text-xs">{ec2Status.public_dns}</span>
                  </div>
                )}
                {ec2Status.uptime_hours !== null && ec2Status.uptime_hours !== undefined && (
                  <div>
                    <span className="text-gray-400">Uptime:</span>{' '}
                    <span className="text-white">
                      {ec2Status.uptime_hours < 1 
                        ? `${Math.round(ec2Status.uptime_hours * 60)} min`
                        : `${ec2Status.uptime_hours.toFixed(1)} hrs`}
                    </span>
                  </div>
                )}
              </div>
              
              <div className="flex gap-2">
                {ec2Status.status === 'stopped' && (
                  <button
                    onClick={handleEC2Start}
                    disabled={ec2Loading}
                    className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded text-sm font-medium transition"
                  >
                    {ec2Loading ? 'Starting...' : '▶️ Start Server'}
                  </button>
                )}
                {ec2Status.status === 'running' && (
                  <>
                    <button
                      onClick={handleEC2Stop}
                      disabled={ec2Loading}
                      className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 rounded text-sm font-medium transition"
                    >
                      {ec2Loading ? 'Stopping...' : '⏹️ Stop Server'}
                    </button>
                    <button
                      onClick={handleEC2Reboot}
                      disabled={ec2Loading}
                      className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 rounded text-sm font-medium transition"
                    >
                      {ec2Loading ? 'Rebooting...' : '🔄 Reboot'}
                    </button>
                  </>
                )}
                {(ec2Status.status === 'pending' || ec2Status.status === 'stopping') && (
                  <span className="px-4 py-2 bg-gray-700 rounded text-sm text-gray-300 flex items-center gap-2">
                    <span className="animate-spin">⏳</span>
                    {ec2Status.status === 'pending' ? 'Starting...' : 'Stopping...'}
                  </span>
                )}
              </div>
              
              {ec2Status.status !== 'running' && (
                <p className="text-yellow-400 text-sm">
                  ⚠️ Voice server must be running to start trading sessions
                </p>
              )}
            </div>
          ) : (
            <div className="text-gray-400">Loading EC2 status...</div>
          )}
        </div>
        
        {/* Running Containers Section */}
        {runningContainers.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold mb-4 text-green-400">🔴 Running Sessions</h2>
            <p className="text-gray-400 text-sm mb-4">
              These voice trader containers are currently running. Click to reconnect and monitor.
            </p>
            <div className="grid gap-3">
              {runningContainers.map(container => (
                <div
                  key={container.session_id}
                  className="bg-green-900/30 border border-green-700 rounded-lg p-4 hover:bg-green-900/50 cursor-pointer transition"
                  onClick={() => handleReconnectToContainer(container)}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                        <h3 className="text-lg font-semibold text-green-300">{container.title || container.event_ticker}</h3>
                      </div>
                      <p className="text-gray-400 text-sm">{container.event_ticker}</p>
                      <p className="text-gray-500 text-xs mt-1">Session: {container.session_id}</p>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-green-400">
                        {container.call_state || container.status}
                      </div>
                      <div className="text-sm text-gray-400">
                        Started: {new Date(container.started_at).toLocaleTimeString()}
                      </div>
                      <div className="text-sm text-gray-500">
                        User: {container.user_name}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-sm text-green-400 font-medium">
                    → Click to reconnect and monitor
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* Upcoming Events Section */}
        <h2 className="text-xl font-bold mb-4">📅 Upcoming Events</h2>
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
                    <div className={`text-sm ${(event.hours_until_start ?? 0) <= 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                      {(event.hours_until_start ?? 0) <= 0 
                        ? `🔴 LIVE - started ${Math.abs(Math.round((event.hours_until_start ?? 0) * 60))} min ago`
                        : (event.hours_until_start ?? 0) < 1 
                          ? `${Math.round((event.hours_until_start ?? 0) * 60)} min until start`
                          : `${(event.hours_until_start ?? 0).toFixed(1)} hrs until start`}
                    </div>
                    <div className="text-sm text-blue-400">
                      {event.word_count ?? event.words?.length ?? 0} words to track
                    </div>
                    {event.container_status !== 'not_running' && (
                      <div className="text-sm text-green-400">
                        Container: {event.container_status}
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="mt-3 flex flex-wrap gap-2">
                  {(event.words || []).slice(0, 10).map(w => (
                    <span
                      key={w.market_ticker}
                      className="bg-gray-700 px-2 py-1 rounded text-xs"
                    >
                      {w.word}
                    </span>
                  ))}
                  {(event.words?.length || 0) > 10 && (
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
            <div className="flex gap-2">
              <input
                type="datetime-local"
                value={scheduledStart}
                onChange={e => setScheduledStart(e.target.value)}
                className="flex-1 bg-gray-700 rounded px-3 py-2 text-white"
              />
              {scheduledStart && (
                <button
                  type="button"
                  onClick={() => setScheduledStart('')}
                  className="px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-white"
                  title="Clear scheduled time"
                >
                  ✕
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {scheduledStart 
                ? `Will dial at ${new Date(scheduledStart).toLocaleTimeString()} local time`
                : 'Leave empty to dial immediately or show Start Call button'
              }
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
          <h3 className="font-semibold mb-2">Words to Track ({selectedEvent.words?.length ?? 0})</h3>
          <div className="flex flex-wrap gap-2">
            {(selectedEvent.words || []).map(w => (
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
    // Derive simple call status from state
    const isCallActive = containerState?.call_state === 'in_progress' || containerState?.call_state === 'qa_session';
    const isConnecting = containerState?.call_state === 'connecting' || dialing;
    const isDisconnected = containerState?.call_state === 'disconnected' || containerState?.call_state === 'completed';
    const isReadyToDial = containerState?.status_message?.toLowerCase().includes('ready to dial');
    
    // Single status message
    let statusMessage = 'Connecting...';
    let statusColor = 'text-gray-400';
    if (error) {
      statusMessage = error;
      statusColor = 'text-red-400';
    } else if (isCallActive) {
      statusMessage = '🟢 Call Active';
      statusColor = 'text-green-400';
    } else if (isConnecting) {
      statusMessage = '📞 Dialing...';
      statusColor = 'text-yellow-400';
    } else if (isDisconnected) {
      statusMessage = '🔴 Call Ended';
      statusColor = 'text-red-400';
    } else if (isReadyToDial) {
      statusMessage = '⏳ Ready to Dial';
      statusColor = 'text-blue-400';
    } else if (containerState?.status_message) {
      statusMessage = containerState.status_message;
    }
    
    return (
      <div className="min-h-screen bg-gray-900 text-white p-4">
        {/* DEV ENVIRONMENT BANNER */}
        <div className="bg-yellow-600 text-yellow-900 px-3 py-1 rounded-lg mb-2 flex items-center gap-2 text-sm">
          <span>🧪</span>
          <span className="font-bold">DEV</span>
          <span>— dev-voice.apexmarkets.us</span>
        </div>
        
        {/* Header - SIMPLIFIED */}
        <div className="flex justify-between items-center mb-4">
          <div>
            <button
              onClick={() => {
                setPageState('events');
                setSelectedEvent(null);
                setSessionId(null);
                setWsConnected(false);
                setError(null);
                setDialing(false);
                setContainerState(null);  // Clear container state
                setWords([]);  // Clear word grid
                setTranscript([]);  // Clear transcript
                if (wsRef.current) {
                  wsRef.current.close();
                  wsRef.current = null;
                }
              }}
              className="text-gray-400 hover:text-white text-sm mb-1 flex items-center gap-1"
            >
              ← Back to Lobby
            </button>
            <h1 className="text-xl font-bold">{selectedEvent.title} <span className="text-yellow-500 text-base">(DEV)</span></h1>
            <div className={`text-sm ${statusColor}`}>{statusMessage}</div>
            
            {/* Detection Pause + Q&A Status Indicators */}
            {isCallActive && (
              <div className="mt-2 flex items-center gap-2">
                {/* Detection Pause Button - prominent toggle */}
                <button
                  onClick={() => {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ 
                        type: 'set_detection_paused',
                        paused: !containerState?.detection_paused 
                      }));
                    }
                  }}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    containerState?.detection_paused 
                      ? 'bg-red-600 hover:bg-red-500 ring-2 ring-red-400' 
                      : 'bg-green-600 hover:bg-green-500'
                  }`}
                  title={containerState?.detection_paused 
                    ? "Detection PAUSED - Click to resume" 
                    : "Detection ACTIVE - Click to pause"}
                >
                  {containerState?.detection_paused ? '⏸️ Paused' : '▶️ Detecting'}
                </button>
                
                {/* Q&A Status - only show if Q&A detection is enabled for this session */}
                {(containerState?.qa_detection_enabled !== false) && (
                  containerState?.qa_started ? (
                    <span className="bg-orange-600 px-2 py-1 rounded text-xs font-medium">
                      🎤 Q&A Active
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        if (wsRef.current?.readyState === WebSocket.OPEN) {
                          wsRef.current.send(JSON.stringify({ type: 'set_qa_started' }));
                        }
                      }}
                      className="bg-gray-700 hover:bg-orange-600 px-2 py-1 rounded text-xs"
                      title="Click to manually mark Q&A as started"
                    >
                      Q&A Not Started
                    </button>
                  )
                )}
              </div>
            )}
          </div>
          
          {/* ONE button based on state */}
          <div>
            {isReadyToDial && !dialing && (
              <button
                onClick={async () => {
                  setDialing(true);
                  setError(null);
                  const containerUrl = wsUrl?.replace('wss://', 'https://').replace(':8765', ':8080');
                  if (!containerUrl) {
                    setError('Container URL not available');
                    setDialing(false);
                    return;
                  }
                  try {
                    const response = await fetch(`${containerUrl}/dial`, { method: 'POST' });
                    if (!response.ok) {
                      const data = await response.json();
                      throw new Error(data.error || 'Failed to dial');
                    }
                  } catch (err: any) {
                    setError(err.message);
                    setDialing(false);
                  }
                }}
                className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded"
              >
                📞 Start Call
              </button>
            )}
            {isConnecting && (
              <span className="bg-yellow-600 px-4 py-2 rounded animate-pulse">📞 Dialing...</span>
            )}
            {isCallActive && (
              <button
                onClick={handleStop}
                className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded"
              >
                📴 End Call
              </button>
            )}
            {isDisconnected && (
              <button
                onClick={() => {
                  setError(null);
                  setDialing(false);
                  // Go back to lobby to restart cleanly
                  setPageState('events');
                }}
                className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded"
              >
                ↩ Return to Lobby
              </button>
            )}
          </div>
        </div>
        
        {/* Audio Controls - simplified */}
        <div className="bg-gray-800 rounded-lg p-3 mb-4 flex items-center gap-3 flex-wrap">
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
          {/* Left column: Word Grid - 5 columns for density */}
          <div className="col-span-2 bg-gray-800 rounded-lg p-3 max-h-[350px] overflow-y-auto">
            <h2 className="font-semibold mb-2 text-sm">Word Status</h2>
            <div className="grid grid-cols-5 gap-1">
              {words.map(w => (
                <div
                  key={w.market_ticker}
                  className={`p-1.5 rounded text-xs ${
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
                  <div className="text-[10px] text-gray-400 truncate">
                    {w.triggered
                      ? `✓ ${formatTime(w.triggered_at!)}`
                      : w.no_purchased
                      ? '✗ NO'
                      : '...'}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Right column: Trading & P&L (compact) */}
          <div className="space-y-3">
            {/* Trading Controls + P&L Combined */}
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <h2 className="font-semibold text-sm">Trading</h2>
                <button
                  onClick={() => setDialpadOpen(!dialpadOpen)}
                  className={`px-2 py-1 rounded text-xs ${dialpadOpen ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                  title="Toggle dialpad"
                >
                  📞 Dialpad
                </button>
              </div>
              <div className="text-sm space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-xs">Balance:</span>
                  <span className="font-mono text-xs">${cashBalance.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-xs">Available:</span>
                  <span className="font-mono text-xs">${availableCash.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-gray-400 text-xs">Bet Size:</span>
                  <div className="flex items-center gap-1">
                    <span className="text-gray-500 text-xs">$</span>
                    <input
                      type="number"
                      value={betSizeInput}
                      onChange={(e) => handleBetSizeChange(e.target.value)}
                      onBlur={() => {
                        const val = parseFloat(betSizeInput);
                        if (isNaN(val) || val < 0) {
                          setBetSizeInput(betSize.toFixed(2));
                        }
                      }}
                      className={`w-16 px-1 py-0.5 rounded text-xs font-mono text-right ${
                        betSize < minTrade ? 'bg-red-900 border border-red-500' : 'bg-gray-700'
                      }`}
                      min="0"
                      step="1"
                    />
                  </div>
                </div>
                {betSize < minTrade && (
                  <div className="text-xs text-red-400">
                    ⚠️ Below min (${minTrade})
                  </div>
                )}
                {/* Manual Call End Button */}
                <div className="border-t border-gray-700 pt-2 mt-2">
                  <button
                    onClick={() => {
                      if (wsRef.current?.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({ type: 'force_call_end' }));
                      }
                    }}
                    className="w-full bg-red-700 hover:bg-red-600 px-2 py-1.5 rounded text-xs font-medium"
                    title="Manually trigger NO sweep on all untriggered markets"
                  >
                    🛑 End Call (Sweep NO)
                  </button>
                </div>
              </div>
            </div>
            
            {/* Dialpad Popup */}
            {dialpadOpen && (
              <div className="bg-gray-800 rounded-lg p-3 border border-gray-600">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-semibold text-sm">Dialpad</span>
                  <button
                    onClick={() => setDialpadOpen(false)}
                    className="text-gray-400 hover:text-white text-xs"
                  >
                    ✕
                  </button>
                </div>
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
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 px-2 py-1 rounded text-sm"
                    >
                      ➤
                    </button>
                  </div>
                  {passcode && (
                    <button
                      onClick={() => sendDtmf(passcode)}
                      className="w-full bg-green-600 hover:bg-green-700 py-1.5 rounded text-xs font-medium"
                    >
                      📞 Send PIN ({passcode})
                    </button>
                  )}
                  <div className="grid grid-cols-3 gap-1">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(d => (
                      <button
                        key={d}
                        onClick={() => sendDtmf(d)}
                        className="bg-gray-700 hover:bg-gray-600 py-1.5 rounded text-sm font-mono"
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            
            {/* Speakers - ALWAYS show section, even when empty */}
            <div className="bg-gray-800 rounded-lg p-3">
              <h2 className="font-semibold text-sm mb-1">Speakers</h2>
              <div className="text-xs space-y-1">
                <div className="flex justify-between text-gray-400">
                  <span>✓ {containerState?.speakers?.valid_count ?? 0}</span>
                  <span>✗ {containerState?.speakers?.invalid_count ?? 0}</span>
                </div>
                {containerState?.speakers?.details && containerState.speakers.details.length > 0 ? (
                  containerState.speakers.details.slice(0, 5).map(s => (
                    <div
                      key={s.id}
                      className={`text-xs p-1 rounded truncate ${
                        s.is_valid ? 'bg-green-900/50' : 'bg-red-900/50'
                      }`}
                    >
                      <span className="font-mono">{s.id}</span>: {s.sample}
                    </div>
                  ))
                ) : (
                  <div className="text-gray-500 italic">No speakers detected yet</div>
                )}
              </div>
            </div>
          </div>
        </div>
        
        {/* Transcript */}
        <div className="mt-3 bg-gray-800 rounded-lg p-3 max-h-[250px] overflow-y-auto">
          <h2 className="font-semibold text-sm mb-2">Live Transcript</h2>
          <div className="text-xs space-y-0.5 font-mono">
            {/* Filter: show only finals, events, and the ONE most recent partial */}
            {(() => {
              const recent = transcript.slice(-50);
              // Find finals and events
              const finalsAndEvents = recent.filter(seg => seg.is_final || seg.is_event);
              // Find the most recent partial (if any)
              const lastPartial = recent.filter(seg => !seg.is_final && !seg.is_event).slice(-1)[0];
              // Combine and show last 30
              const toShow = lastPartial 
                ? [...finalsAndEvents, lastPartial].slice(-30)
                : finalsAndEvents.slice(-30);
              
              return toShow.map((seg, i) => {
                // Event messages (state changes, trades, Q&A, etc.) - green
                if (seg.is_event) {
                  const time = seg.timestamp ? new Date(seg.timestamp * 1000).toLocaleTimeString() : '';
                  return (
                    <div key={i} className="text-green-400 py-0.5">
                      <span className="text-green-600">[{time}]</span> {seg.text}
                    </div>
                  );
                }
                // Normal transcript - white for finals, gray italic for the current partial
                return (
                  <div key={i} className={seg.is_final ? 'text-white' : 'text-gray-500 italic'}>
                    {seg.text}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
// Test comment 1768250345
