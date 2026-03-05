'use client';

import { useState } from 'react';

const SATELLITE_PROXY = 'https://voice.apexmarkets.us:8090';

// Satellite UI pages
const pages = [
  { id: 'streams', label: '📺 Streams', path: '/' },
  { id: 'ops', label: '⚙️ Operations', path: '/ops.html' },
  { id: 'feeds', label: '🔍 Feed Scanner', path: '/feed_scan.html' },
];

export default function SatellitePage() {
  const [activePage, setActivePage] = useState('streams');
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  const currentPage = pages.find(p => p.id === activePage) || pages[0];
  const iframeSrc = `${SATELLITE_PROXY}${currentPage.path}`;

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col">
      {/* Sub-navigation bar */}
      <div className="bg-gray-900 border-b border-gray-700 px-4 py-1.5 flex items-center gap-4 shrink-0">
        <div className="flex gap-1">
          {pages.map(page => (
            <button
              key={page.id}
              onClick={() => setActivePage(page.id)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                activePage === page.id
                  ? 'bg-cyan-600 text-white'
                  : 'text-gray-300 hover:bg-gray-700 hover:text-white'
              }`}
            >
              {page.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Connection status */}
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className={`w-2 h-2 rounded-full ${
            isConnected === true ? 'bg-green-500' : isConnected === false ? 'bg-red-500' : 'bg-yellow-500'
          }`} />
          {isConnected === true ? 'Connected' : isConnected === false ? 'Unreachable' : 'Checking...'}
        </div>

        {/* Open in new tab */}
        <a
          href={iframeSrc}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-cyan-400 hover:text-cyan-300"
        >
          ↗ Open
        </a>
      </div>

      {/* Embedded satellite UI */}
      <iframe
        src={iframeSrc}
        className="flex-1 w-full border-0"
        onLoad={() => setIsConnected(true)}
        onError={() => setIsConnected(false)}
        allow="autoplay; fullscreen"
        title="Satellite TV Control"
      />
    </div>
  );
}
