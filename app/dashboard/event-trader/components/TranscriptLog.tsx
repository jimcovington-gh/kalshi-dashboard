'use client';

import React, { useEffect, useRef } from 'react';

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

export function TranscriptLog({ entries, matchLine }: TranscriptLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

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
        {entries.length === 0 && (
          <p className="text-gray-500 italic">Waiting for transcript...</p>
        )}
        {entries.map((entry, i) => {
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
            <div key={i} className={`${textColor} leading-relaxed`}>
              <span className="text-gray-600">[{formatTime(entry.timestamp)}]</span>{' '}
              <span className={entry.is_final ? '' : 'italic opacity-70'}>
                &quot;{entry.text}&quot;
              </span>
              {badge}
              {entry.latency_ms > 0 && (
                <span className="text-gray-600 ml-1">({entry.latency_ms}ms)</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
