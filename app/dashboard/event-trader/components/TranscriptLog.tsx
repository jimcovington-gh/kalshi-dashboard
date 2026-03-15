'use client';

import React, { useEffect, useRef, useMemo } from 'react';

interface TranscriptEntry {
  text: string;
  is_final: boolean;
  provider: string;
  latency_ms: number;
  trigger_detected: boolean;
  timestamp: number;
}

interface TranscriptLogProps {
  entries: TranscriptEntry[];
  matchLine: string | null;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const TranscriptLog = React.memo(function TranscriptLog({ entries, matchLine }: TranscriptLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Collapse consecutive partials: show finals + triggers as permanent lines,
  // only the latest in-progress partial as a single live line at the bottom.
  const { displayEntries, livePartial } = useMemo(() => {
    const display: TranscriptEntry[] = [];
    let live: TranscriptEntry | null = null;

    for (const entry of entries) {
      if (entry.is_final || entry.trigger_detected) {
        display.push(entry);
        live = null;
      } else {
        live = entry;
      }
    }
    return { displayEntries: display, livePartial: live };
  }, [entries]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  }

  useEffect(() => {
    const el = containerRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length]);

  function renderEntry(entry: TranscriptEntry, i: number, isLive = false) {
    let textColor = 'text-gray-300';
    let badge: React.ReactNode = null;

    if (entry.trigger_detected) {
      textColor = 'text-orange-300';
      badge = <span className="text-orange-400 ml-1">⚡ TRIGGER</span>;
    }

    const isMatchLine = matchLine !== null && entry.text.includes(matchLine);
    if (isMatchLine) {
      textColor = 'text-green-300';
      badge = <span className="text-green-400 ml-1">🎯 FIRE</span>;
    }

    return (
      <div key={isLive ? 'live-partial' : `${entry.timestamp}-${i}`} className={`${textColor} leading-relaxed`}>
        <span className="text-gray-600">[{formatTime(entry.timestamp)}]</span>{' '}
        <span className={isLive ? 'italic opacity-60' : ''}>
          {isLive && <span className="text-blue-400 mr-1 animate-pulse">●</span>}
          &quot;{entry.text}&quot;
        </span>
        {badge}
        {entry.latency_ms > 0 && (
          <span className="text-gray-600 ml-1">({entry.latency_ms}ms)</span>
        )}
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 flex flex-col">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Transcript
      </h2>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 max-h-64 overflow-y-auto font-mono text-xs space-y-0.5"
      >
        {displayEntries.length === 0 && !livePartial && (
          <p className="text-gray-500 italic">Waiting for transcript...</p>
        )}
        {displayEntries.map((entry, i) => renderEntry(entry, i))}
        {livePartial && renderEntry(livePartial, -1, true)}
      </div>
    </div>
  );
});