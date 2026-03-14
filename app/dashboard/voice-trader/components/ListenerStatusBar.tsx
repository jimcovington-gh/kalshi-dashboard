/**
 * ListenerStatusBar.tsx — Real-time listener status during active sessions
 *
 * Shows connected field listeners as a compact bar on the monitoring page.
 * Polls /admin/listeners every 5s. Color-coded status dots.
 * Per-listener audio mute/unmute toggles when audio bridges are active.
 */
'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface ListenerStatus {
  listener_id: string;
  name: string;
  assigned_trader: string;
  connected: boolean;
  connected_at?: number;
  last_audio_at?: number;
}

interface ListenerAudioInfo {
  name: string;
  muted: boolean;
}

interface Props {
  ec2Base: string;
  /** Only show listeners assigned to this trader */
  traderFilter?: string;
  /** Listener audio sources from worker (listener_id → {name, muted}) */
  listenerAudioSources?: Record<string, ListenerAudioInfo>;
  /** Callback to toggle listener audio mute */
  onToggleListenerAudio?: (listenerId: string, muted: boolean) => void;
}

export function ListenerStatusBar({ ec2Base, traderFilter, listenerAudioSources, onToggleListenerAudio }: Props) {
  const [listeners, setListeners] = useState<ListenerStatus[]>([]);
  const [expanded, setExpanded] = useState(false);

  const fetchListeners = useCallback(async () => {
    try {
      const res = await fetch(`${ec2Base}/admin/listeners`);
      if (!res.ok) return;
      const data = await res.json();
      const all: ListenerStatus[] = data.listeners || [];
      // Filter to relevant trader if specified
      setListeners(traderFilter ? all.filter(l => l.assigned_trader === traderFilter) : all);
    } catch {
      // Silently fail — this is a status display, not critical
    }
  }, [ec2Base, traderFilter]);

  useEffect(() => {
    fetchListeners();
    const interval = setInterval(fetchListeners, 5000);
    return () => clearInterval(interval);
  }, [fetchListeners]);

  const connectedListeners = listeners.filter(l => l.connected);

  // Don't render if no listeners assigned to this trader
  if (listeners.length === 0) return null;

  const now = Date.now() / 1000;

  const getStatusColor = (l: ListenerStatus): string => {
    if (!l.connected) return 'bg-gray-500';
    if (l.last_audio_at && (now - l.last_audio_at) > 10) return 'bg-yellow-500'; // stale audio
    return 'bg-green-500';
  };

  const getStatusLabel = (l: ListenerStatus): string => {
    if (!l.connected) return 'Disconnected';
    if (l.last_audio_at && (now - l.last_audio_at) > 10) return 'No audio';
    return 'Streaming';
  };

  const formatUptime = (connectedAt?: number): string => {
    if (!connectedAt) return '';
    const secs = Math.floor(now - connectedAt);
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
  };

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-sm"
      >
        <div className="flex items-center gap-3">
          <span className="text-gray-400 font-medium">🎧 Field Listeners</span>
          {/* Summary dots */}
          <div className="flex items-center gap-1.5">
            {listeners.map(l => (
              <div
                key={l.listener_id}
                className={`w-2 h-2 rounded-full ${getStatusColor(l)}`}
                title={`${l.name}: ${getStatusLabel(l)}`}
              />
            ))}
          </div>
          <span className="text-xs text-gray-500">
            {connectedListeners.length}/{listeners.length} connected
          </span>
        </div>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-gray-700 space-y-1.5">
          {listeners.map(l => {
            const audioInfo = listenerAudioSources?.[l.listener_id];
            const hasAudioBridge = !!audioInfo;
            const isMuted = audioInfo?.muted ?? true;
            return (
              <div key={l.listener_id} className="flex items-center gap-3 text-xs">
                <div
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(l)} ${l.connected ? 'animate-pulse' : ''}`}
                />
                <span className={`font-medium ${l.connected ? 'text-white' : 'text-gray-500'}`}>
                  {l.name}
                </span>
                <span className={`${l.connected ? 'text-green-400' : 'text-gray-600'}`}>
                  {getStatusLabel(l)}
                </span>
                {l.connected && l.connected_at && (
                  <span className="text-gray-500">{formatUptime(l.connected_at)}</span>
                )}
                {/* Audio toggle — only shown when bridge is active */}
                {hasAudioBridge && onToggleListenerAudio && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleListenerAudio(l.listener_id, !isMuted); }}
                    className={`ml-auto px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                      isMuted
                        ? 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                        : 'bg-green-800 text-green-300 hover:bg-green-700'
                    }`}
                    title={isMuted ? 'Unmute listener audio' : 'Mute listener audio'}
                  >
                    {isMuted ? '🔇' : '🔊'}
                  </button>
                )}
              </div>
            );
          })}
          {listeners.length === 0 && (
            <div className="text-xs text-gray-500 py-1">No listeners assigned to this trader.</div>
          )}
        </div>
      )}
    </div>
  );
}
