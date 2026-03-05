'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

const SATELLITE_PROXY = 'https://voice.apexmarkets.us:8090';

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
  state: string;  // "idle", "streaming", "scanning", "tuned", "motor", "error", "absent"
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

export default function SatellitePage() {
  const [activePage, setActivePage] = useState('streams');
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [dish, setDish] = useState<DishInfo | null>(null);
  const [satellites, setSatellites] = useState<Satellite[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<Satellite | null>(null);
  const [moving, setMoving] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch satellite list once
  useEffect(() => {
    fetch(`${SATELLITE_PROXY}/api/satellites`)
      .then(r => r.json())
      .then(data => setSatellites(data.satellites || []))
      .catch(() => {});
  }, []);

  // WebSocket for real-time adapter/dish status
  const connectWs = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch (_) {}
    }
    const ws = new WebSocket(`${SATELLITE_PROXY.replace('https:', 'wss:')}/api/ws/status`);
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
  }, []);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWs]);

  // Move dish
  const doMoveDish = async (sat: Satellite) => {
    setMoving(true);
    try {
      const res = await fetch(`${SATELLITE_PROXY}/api/ops/move-dish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ satellite: sat.slug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Move failed: ${data.detail || res.statusText}`);
      }
    } catch (e) {
      alert(`Move failed: ${e}`);
    } finally {
      setMoving(false);
      setConfirmTarget(null);
    }
  };

  const currentPage = pages.find(p => p.id === activePage) || pages[0];
  const iframeSrc = `${SATELLITE_PROXY}${currentPage.path}?embed=1`;
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
      {confirmTarget && (
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
              ⚠ All active streams will be interrupted during the move.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmTarget(null)}
                disabled={moving}
                className="px-4 py-1.5 text-sm text-gray-400 hover:text-white bg-gray-800 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => doMoveDish(confirmTarget)}
                disabled={moving}
                className="px-4 py-1.5 text-sm text-white bg-emerald-700 hover:bg-emerald-600 rounded font-medium transition-colors disabled:opacity-50"
              >
                {moving ? 'Moving…' : 'Confirm Move'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Embedded satellite UI */}
      <iframe
        src={iframeSrc}
        className="flex-1 w-full border-0"
        allow="autoplay; fullscreen"
        title="Satellite TV Control"
      />
    </div>
  );
}
