/**
 * ListenerAdminPanel.tsx — Manage field listeners (create, assign, delete)
 *
 * Rendered inline on the voice-trader setup page so non-technical operators
 * can set up field workers without a command line.
 */
'use client';

import React, { useEffect, useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListenerInfo {
  listener_id: string;
  name: string;
  assigned_trader: string;
  assigned_event: string;
  phone_number: string;
  created_at: number;
  connected: boolean;
  connected_at?: number;
  last_audio_at?: number;
  passcode?: string;            // only present right after create
  session_linked?: boolean;     // from /status endpoint
  uptime_seconds?: number;
}

interface Props {
  ec2Base: string;
  /** Currently selected event ticker (for one-click assign) */
  eventTicker?: string;
  /** Default trader name to pre-fill the assign form */
  defaultTrader?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ListenerAdminPanel({ ec2Base, eventTicker, defaultTrader }: Props) {
  // List state
  const [listeners, setListeners] = useState<ListenerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPasscode, setNewPasscode] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);

  // Assign form
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignTrader, setAssignTrader] = useState(defaultTrader || 'jimc');
  const [assignEvent, setAssignEvent] = useState(eventTicker || '');

  // Newly created — show passcode + link once
  const [justCreated, setJustCreated] = useState<ListenerInfo | null>(null);

  // Confirm delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Copied link feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // Fetch listeners
  // ------------------------------------------------------------------

  const fetchListeners = useCallback(async () => {
    try {
      const res = await fetch(`${ec2Base}/admin/listeners`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setListeners(data.listeners || []);
      setError(null);
    } catch (e) {
      setError(`Failed to load listeners: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [ec2Base]);

  useEffect(() => {
    fetchListeners();
    const interval = setInterval(fetchListeners, 5000);
    return () => clearInterval(interval);
  }, [fetchListeners]);

  // Update assign event when parent event changes
  useEffect(() => {
    if (eventTicker) setAssignEvent(eventTicker);
  }, [eventTicker]);

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------

  const handleCreate = async () => {
    if (!newName.trim() || !newPasscode.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${ec2Base}/admin/listener`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          passcode: newPasscode.trim(),
          phone_number: newPhone.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const created: ListenerInfo = await res.json();
      setJustCreated(created);
      setNewName('');
      setNewPasscode('');
      setNewPhone('');
      setShowCreate(false);
      await fetchListeners();
    } catch (e) {
      setError(`Create failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  // ------------------------------------------------------------------
  // Delete
  // ------------------------------------------------------------------

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`${ec2Base}/admin/listener/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConfirmDeleteId(null);
      if (justCreated?.listener_id === id) setJustCreated(null);
      await fetchListeners();
    } catch (e) {
      setError(`Delete failed: ${(e as Error).message}`);
    }
  };

  // ------------------------------------------------------------------
  // Assign
  // ------------------------------------------------------------------

  const handleAssign = async (id: string) => {
    try {
      const res = await fetch(`${ec2Base}/admin/listener/${encodeURIComponent(id)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trader: assignTrader,
          event_ticker: assignEvent,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setAssigningId(null);
      await fetchListeners();
    } catch (e) {
      setError(`Assign failed: ${(e as Error).message}`);
    }
  };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  const listenerUrl = (id: string) => `${ec2Base}/listen/${encodeURIComponent(id)}`;

  const copyLink = (id: string) => {
    navigator.clipboard.writeText(listenerUrl(id)).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const generatePasscode = () => {
    const chars = '0123456789';
    let code = '';
    const arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    for (const b of arr) code += chars[b % chars.length];
    return code;
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">
          🎧 Field Listeners {listeners.length > 0 && <span className="text-gray-500">({listeners.length})</span>}
        </h3>
        <button
          onClick={() => {
            setShowCreate(!showCreate);
            if (!showCreate) setNewPasscode(generatePasscode());
          }}
          className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
        >
          {showCreate ? '✕ Cancel' : '+ Add Listener'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 px-3 py-2 rounded text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-300">✕</button>
        </div>
      )}

      {/* Just-created banner */}
      {justCreated && (
        <div className="bg-green-900/50 border border-green-700 text-green-200 px-4 py-3 rounded text-sm space-y-2">
          <p className="font-medium">✅ Listener &quot;{justCreated.name}&quot; created!</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-green-400">ID:</span>{' '}
              <code className="bg-green-800/50 px-1 rounded">{justCreated.listener_id}</code>
            </div>
            <div>
              <span className="text-green-400">Passcode:</span>{' '}
              <code className="bg-green-800/50 px-1 rounded font-bold">{justCreated.passcode}</code>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-green-400">📱 Link:</span>
            <code className="text-xs bg-green-800/50 px-2 py-1 rounded flex-1 truncate">{listenerUrl(justCreated.listener_id)}</code>
            <button
              onClick={() => copyLink(justCreated.listener_id)}
              className="text-xs px-2 py-1 bg-green-700 hover:bg-green-600 rounded"
            >
              📋 Copy
            </button>
          </div>
          <p className="text-xs text-green-400 mt-1">
            Share this link and passcode with the field worker. They open it on their phone to start streaming audio.
          </p>
          <button onClick={() => setJustCreated(null)} className="text-xs text-green-500 hover:text-green-400 mt-1">
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="bg-gray-700/50 border border-gray-600 rounded-lg p-4 space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name *</label>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Field Mic - Stadium"
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Passcode * (min 4 chars)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPasscode}
                  onChange={e => setNewPasscode(e.target.value)}
                  placeholder="e.g. 847293"
                  className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm font-mono"
                />
                <button
                  onClick={() => setNewPasscode(generatePasscode())}
                  className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
                  title="Generate random passcode"
                >🎲</button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Phone (for call-in backup)</label>
              <input
                type="text"
                value={newPhone}
                onChange={e => setNewPhone(e.target.value)}
                placeholder="+15551234567"
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim() || newPasscode.trim().length < 4}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
            >
              {creating ? '⏳ Creating...' : '✅ Create Listener'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-sm text-gray-400 py-3 text-center animate-pulse">Loading listeners…</div>
      )}

      {/* Empty state */}
      {!loading && listeners.length === 0 && (
        <div className="text-sm text-gray-500 py-4 text-center">
          No listeners registered yet. Click &quot;+ Add Listener&quot; to create one.
        </div>
      )}

      {/* Listener list */}
      {listeners.length > 0 && (
        <div className="space-y-2">
          {listeners.map(l => (
            <div
              key={l.listener_id}
              className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3"
            >
              <div className="flex items-center gap-3">
                {/* Status dot */}
                <div
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    l.connected ? 'bg-green-500 animate-pulse' : 'bg-gray-500'
                  }`}
                  title={l.connected ? 'Connected & streaming' : 'Disconnected'}
                />

                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{l.name}</span>
                    {l.connected && (
                      <span className="text-xs bg-green-800 text-green-200 px-1.5 py-0.5 rounded">LIVE</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                    {l.assigned_trader ? (
                      <span>👤 {l.assigned_trader}</span>
                    ) : (
                      <span className="text-yellow-500">⚠ Unassigned</span>
                    )}
                    {l.assigned_event && <span>📋 {l.assigned_event}</span>}
                    {l.phone_number && <span>📞 {l.phone_number}</span>}
                    <span className="text-gray-600">ID: {l.listener_id}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Open listener page */}
                  <a
                    href={listenerUrl(l.listener_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition-colors"
                    title="Open listener page"
                  >
                    📱
                  </a>

                  {/* Copy link */}
                  <button
                    onClick={() => copyLink(l.listener_id)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition-colors"
                    title="Copy link to clipboard"
                  >
                    {copiedId === l.listener_id ? '✓' : '📋'}
                  </button>

                  {/* Assign */}
                  <button
                    onClick={() => {
                      if (assigningId === l.listener_id) {
                        setAssigningId(null);
                      } else {
                        setAssigningId(l.listener_id);
                        setAssignTrader(l.assigned_trader || defaultTrader || 'jimc');
                        setAssignEvent(l.assigned_event || eventTicker || '');
                      }
                    }}
                    className={`px-2 py-1 rounded text-xs transition-colors ${
                      assigningId === l.listener_id
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 hover:bg-gray-600'
                    }`}
                    title="Assign to trader"
                  >
                    👤
                  </button>

                  {/* Delete */}
                  {confirmDeleteId === l.listener_id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(l.listener_id)}
                        className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-xs font-medium"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(l.listener_id)}
                      className="px-2 py-1 bg-gray-700 hover:bg-red-700 rounded text-xs transition-colors"
                      title="Delete listener"
                    >
                      🗑️
                    </button>
                  )}
                </div>
              </div>

              {/* Assign form (inline expand) */}
              {assigningId === l.listener_id && (
                <div className="mt-3 pt-3 border-t border-gray-700 flex items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-400 mb-1">Trader</label>
                    <select
                      value={assignTrader}
                      onChange={e => setAssignTrader(e.target.value)}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm"
                    >
                      <option value="jimc">jimc</option>
                      <option value="andrews">andrews</option>
                      <option value="staybetter">staybetter</option>
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-gray-400 mb-1">Event (optional)</label>
                    <input
                      type="text"
                      value={assignEvent}
                      onChange={e => setAssignEvent(e.target.value)}
                      placeholder={eventTicker || 'e.g. KXEVENT-123'}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm"
                    />
                  </div>
                  <button
                    onClick={() => handleAssign(l.listener_id)}
                    className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium transition-colors"
                  >
                    Assign
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Call-in info */}
      <div className="bg-gray-800/50 border border-gray-700 rounded px-3 py-2 text-xs text-gray-400">
        📞 <strong className="text-gray-300">Call-in backup:</strong> Field workers with a registered phone number
        can also call <span className="font-mono text-blue-400">+1 (703) 313-9446</span> — their caller ID will auto-match
        to the listener.
      </div>
    </div>
  );
}
