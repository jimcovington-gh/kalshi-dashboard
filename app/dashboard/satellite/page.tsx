'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

const SATELLITE_PROXY = 'https://voice.apexmarkets.us:8091';
const WS_PROXY = SATELLITE_PROXY.replace('https:', 'wss:');

const pages = [
  { id: 'streams', label: '📺 Streams', path: '/' },
  { id: 'ops', label: '⚙️ Operations', path: '/ops.html' },
  { id: 'feeds', label: '🔍 Feed Scanner', path: '/feed_scan.html' },
];

interface Satellite {
  slug: string;
  display_name: string;
  nickname: string | null;
  orbital_position: number;
  direction: string;
}

interface AdapterInfo {
  id: number;
  state: string;
  channel?: string;
}

interface DishInfo {
  satellite: string | null;
  display_name: string | null;
  nickname: string | null;
  position_degrees: number | null;
  direction: string | null;
}

function formatSatLabel(s: { display_name?: string | null; nickname?: string | null; orbital_position?: number | null; position_degrees?: number | null; direction?: string | null }) {
  const lon = `${s.orbital_position ?? s.position_degrees ?? '?'}${s.direction ?? 'W'}`;
  if (s.nickname) return `${s.nickname} - ${s.display_name} - ${lon}`;
  return `${s.display_name ?? 'Unknown'} - ${lon}`;
}

// Stream a job's log via WebSocket. Returns a promise that resolves with the job status.
function streamJobLog(
  jobId: string,
  onLine: (line: string) => void,
  onStatus?: (phase: string) => void,
  token?: string | null,
): Promise<'completed' | 'failed' | 'cancelled'> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const wsUrl = token ? `${WS_PROXY}/api/ops/${jobId}/stream?token=${encodeURIComponent(token)}` : `${WS_PROXY}/api/ops/${jobId}/stream`;
    const ws = new WebSocket(wsUrl);
    let lastStatus = '';
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'history' && Array.isArray(msg.lines)) {
          msg.lines.forEach((l: string) => onLine(l));
        } else if (msg.type === 'log') {
          onLine(msg.line);
        } else if (msg.type === 'status') {
          lastStatus = msg.job?.status || '';
          if (onStatus) onStatus(lastStatus);
          if (lastStatus === 'completed' || lastStatus === 'failed' || lastStatus === 'cancelled') {
            resolved = true;
            ws.close();
            resolve(lastStatus as 'completed' | 'failed' | 'cancelled');
          }
        } else if (msg.type === 'done') {
          ws.close();
          if (!resolved) {
            resolved = true;
            resolve((lastStatus || 'completed') as 'completed' | 'failed' | 'cancelled');
          }
        }
      } catch (_) {}
    };
    ws.onerror = () => { ws.close(); if (!resolved) { resolved = true; reject(new Error('Job log WebSocket error')); } };
    ws.onclose = () => { if (!resolved) { resolved = true; resolve((lastStatus || 'failed') as 'completed' | 'failed' | 'cancelled'); } };
  });
}

export default function SatellitePage() {
  const [activePage, setActivePage] = useState('streams');
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [dish, setDish] = useState<DishInfo | null>(null);
  const [satellites, setSatellites] = useState<Satellite[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<Satellite | null>(null);
  const [moving, setMoving] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);

  // Fetch Cognito auth token
  useEffect(() => {
    fetchAuthSession().then(session => {
      const token = session.tokens?.idToken?.toString() ?? null;
      setAuthToken(token);
    }).catch(err => console.error('fetchAuthSession failed:', err));
  }, []);

  // Authenticated fetch — adds Authorization header
  const fetchWithAuth = useCallback((url: string, opts: RequestInit = {}) => {
    const existing = (opts.headers as Record<string, string>) ?? {};
    return fetch(url, {
      ...opts,
      headers: { ...existing, ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    });
  }, [authToken]);

  // Move/scan log popup state
  const [logOpen, setLogOpen] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logPhase, setLogPhase] = useState('');  // e.g. "Stopping streams…", "Moving dish…", "Scanning lineup…"
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Fetch satellite list once (after auth token is available)
  useEffect(() => {
    if (!authToken) return;
    fetchWithAuth(`${SATELLITE_PROXY}/api/satellites`)
      .then(r => r.json())
      .then(data => setSatellites(data.satellites || []))
      .catch(() => {});
  }, [authToken, fetchWithAuth]);

  // Auto-scroll log popup
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logLines]);

  // WebSocket for real-time adapter/dish status
  const connectWs = useCallback(() => {
    if (!authToken) return; // Don't connect until we have a valid token
    if (wsRef.current) {
      try { wsRef.current.close(); } catch (_) {}
    }
    const wsUrl = `${WS_PROXY}/api/ws/status?token=${encodeURIComponent(authToken)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => {
      setWsConnected(false);
      reconnectRef.current = setTimeout(connectWs, 3000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'status') {
          setAdapters(msg.adapters || []);
          setDish(msg.dish || null);
        }
      } catch (_) {}
    };
  }, [authToken]);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWs, authToken]);

  const addLog = useCallback((line: string) => {
    setLogLines(prev => [...prev, line]);
  }, []);

  // Full move flow: stop streams → move dish → lineup scan → reload channels
  const doMoveDish = async (sat: Satellite) => {
    setMoving(true);
    setConfirmTarget(null);
    setLogLines([]);
    setLogOpen(true);

    try {
      // Phase 1: Stop all active streams
      setLogPhase('Stopping streams…');
      addLog('⏹ Stopping all active streams…');
      try {
        const streamsRes = await fetchWithAuth(`${SATELLITE_PROXY}/api/streams`);
        if (streamsRes.ok) {
          const streamsData = await streamsRes.json();
          const active = streamsData.streams || [];
          if (active.length > 0) {
            await Promise.all(active.map((s: { stream_id: string }) =>
              fetchWithAuth(`${SATELLITE_PROXY}/api/streams/${s.stream_id}`, { method: 'DELETE' }).catch(() => {})
            ));
            addLog(`  Stopped ${active.length} stream(s)`);
          } else {
            addLog('  No active streams');
          }
        }
      } catch (e) {
        addLog(`  Warning: could not stop streams (${e})`);
      }

      // Phase 2: Move dish
      setLogPhase(`Moving dish → ${formatSatLabel(sat)}`);
      addLog(`\n📡 Moving dish to ${formatSatLabel(sat)}…`);
      const moveRes = await fetchWithAuth(`${SATELLITE_PROXY}/api/ops/move-dish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ satellite: sat.slug }),
      });
      if (!moveRes.ok) {
        const d = await moveRes.json().catch(() => ({}));
        throw new Error(d.detail || moveRes.statusText);
      }
      const moveJob = await moveRes.json();
      const moveResult = await streamJobLog(moveJob.job_id, addLog, setLogPhase, authToken);
      if (moveResult !== 'completed') {
        addLog(`\n❌ Move ${moveResult}`);
        setLogPhase(`Move ${moveResult}`);
        return;
      }
      addLog('\n✅ Dish move complete');

      // Phase 3: Lineup scan
      setLogPhase(`Scanning lineup on ${sat.display_name}…`);
      addLog(`\n🔍 Starting lineup scan on ${sat.display_name}…`);
      const scanRes = await fetchWithAuth(`${SATELLITE_PROXY}/api/ops/scan-lineup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ satellite: sat.slug, auto_reload: true }),
      });
      if (!scanRes.ok) {
        const d = await scanRes.json().catch(() => ({}));
        addLog(`\n⚠ Lineup scan failed to start: ${d.detail || scanRes.statusText}`);
        setLogPhase('Scan failed to start');
      } else {
        const scanJob = await scanRes.json();
        const scanResult = await streamJobLog(scanJob.job_id, addLog, setLogPhase, authToken);
        if (scanResult === 'completed') {
          addLog('\n✅ Lineup scan complete');
        } else {
          addLog(`\n⚠ Lineup scan ${scanResult}`);
        }
      }

      // Phase 4: Reload the iframe to pick up new channels
      setLogPhase('Done');
      addLog('\n🔄 Reloading channels…');
      if (iframeRef.current) {
        iframeRef.current.src = iframeRef.current.src;
      }
      addLog('✅ All done — new channels loaded');

      // Auto-close log popup after success
      setTimeout(() => setLogOpen(false), 3000);

    } catch (e) {
      addLog(`\n❌ Error: ${e}`);
      setLogPhase('Error');
    } finally {
      setMoving(false);
    }
  };

  const currentPage = pages.find(p => p.id === activePage) || pages[0];
  const iframeSrc = authToken
    ? `${SATELLITE_PROXY}${currentPage.path}?embed=1&token=${encodeURIComponent(authToken)}`
    : `${SATELLITE_PROXY}${currentPage.path}?embed=1`;
  const dishLabel = dish ? formatSatLabel(dish) : 'Connecting…';

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col bg-gray-950">
      {/* Unified header */}
      <div className="bg-[#1a1a1a] border-b border-gray-700 px-4 py-1 flex items-center gap-4 shrink-0 h-10">
        {/* Left: tabs */}
        <div className="flex gap-1">
          {pages.map(page => (
            <button
              key={page.id}
              onClick={() => setActivePage(page.id)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                activePage === page.id
                  ? 'bg-cyan-600 text-white'
                  : 'text-gray-400 hover:bg-gray-700 hover:text-white'
              }`}
            >
              {page.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Center: current satellite (clickable) */}
        <button
          onClick={() => setPickerOpen(true)}
          className="text-sm font-semibold text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1.5"
          title="Change satellite"
        >
          📡 {dishLabel}
          <span className="text-[10px] text-gray-500">▼</span>
        </button>

        <div className="flex-1" />

        {/* Right: adapter dots + connection */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1" title="Adapter status">
            {Array.from({ length: 8 }, (_, i) => {
              const a = adapters.find(ad => ad.id === i);
              const st = a?.state || 'absent';
              const color = st === 'streaming' ? 'bg-emerald-400 shadow-[0_0_6px_#00ff88]'
                          : st === 'scanning' ? 'bg-blue-400 animate-pulse'
                          : st === 'tuned' ? 'bg-yellow-400'
                          : st === 'motor' ? 'bg-gray-500'
                          : st === 'error' ? 'bg-red-500'
                          : st === 'idle' ? 'bg-gray-600'
                          : 'bg-gray-800';
              return (
                <div
                  key={i}
                  className={`w-2.5 h-2.5 rounded-full ${color}`}
                  title={a?.channel ? `${i}: ${a.channel} (${st})` : `${i}: ${st}`}
                />
              );
            })}
          </div>
          <span className="text-[11px] text-gray-500">
            {adapters.filter(a => a.state === 'streaming').length}/8
          </span>
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`}
                title={wsConnected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>

      {/* Satellite Picker Modal */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPickerOpen(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-96 max-h-[70vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-200">Select Satellite</span>
              <button onClick={() => setPickerOpen(false)} className="text-gray-500 hover:text-white text-lg">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 py-1">
              {satellites.map(sat => {
                const isCurrent = dish?.satellite === sat.slug;
                return (
                  <button
                    key={sat.slug}
                    disabled={isCurrent}
                    onClick={() => { setPickerOpen(false); setConfirmTarget(sat); }}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                      isCurrent
                        ? 'text-emerald-400 bg-emerald-950/40 cursor-default'
                        : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                    }`}
                  >
                    {formatSatLabel(sat)}
                    {isCurrent && <span className="ml-2 text-[10px] text-emerald-600">● current</span>}
                  </button>
                );
              })}
              {satellites.length === 0 && (
                <div className="px-4 py-6 text-center text-gray-500 text-sm">Loading satellites…</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm Move Dialog */}
      {confirmTarget && !moving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-96 p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-gray-100 mb-3">Move Dish?</h3>
            <p className="text-sm text-gray-400 mb-1">
              This will physically move the dish from:
            </p>
            <p className="text-sm text-gray-200 mb-1 font-medium">
              {dish ? formatSatLabel(dish) : 'current position'}
            </p>
            <p className="text-sm text-gray-400 mb-1">to:</p>
            <p className="text-sm text-emerald-400 mb-4 font-medium">
              {formatSatLabel(confirmTarget)}
            </p>
            <p className="text-xs text-yellow-500 mb-4">
              ⚠ All active streams will be stopped and the dish will move.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmTarget(null)}
                className="px-4 py-1.5 text-sm text-gray-400 hover:text-white bg-gray-800 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => doMoveDish(confirmTarget)}
                className="px-4 py-1.5 text-sm text-white bg-emerald-700 hover:bg-emerald-600 rounded font-medium transition-colors"
              >
                Confirm Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move/Scan Log Popup */}
      {logOpen && (
        <div className="fixed bottom-4 right-4 z-50 w-[480px] max-h-[50vh] flex flex-col bg-gray-900 border border-gray-600 rounded-lg shadow-2xl overflow-hidden">
          <div className="px-3 py-2 bg-gray-800 border-b border-gray-700 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {moving && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />}
              <span className="text-xs font-semibold text-gray-200 truncate">{logPhase || 'Satellite Operation'}</span>
            </div>
            {!moving && (
              <button onClick={() => setLogOpen(false)} className="text-gray-500 hover:text-white text-sm ml-2 shrink-0">✕</button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap">
            {logLines.map((line, i) => (
              <div key={i} className={line.startsWith('✅') ? 'text-emerald-400' : line.startsWith('❌') ? 'text-red-400' : line.startsWith('⚠') ? 'text-yellow-400' : ''}>{line}</div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* Embedded satellite UI */}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        className="flex-1 w-full border-0"
        allow="autoplay; fullscreen"
        title="Satellite TV Control"
      />
    </div>
  );
}
