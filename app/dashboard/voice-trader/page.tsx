'use client';

/**
 * Voice Trader Test Bench - Version Selector
 * 
 * This page provides a dropdown to switch between:
 * - Legacy Test Bench: Works with worker.py (production)
 * - V2 Test Bench: Works with worker_new.py (new pipeline)
 * 
 * The selection is persisted in localStorage so users return to their preferred version.
 */

import React, { useState, useEffect } from 'react';
import { TestBenchLegacy } from './components/TestBenchLegacy';
import { TestBenchV2 } from './components/TestBenchV2';

type TestBenchVersion = 'legacy' | 'v2';

const STORAGE_KEY = 'voice-trader-test-bench-version';

export default function VoiceTraderPage() {
  // Initialize from localStorage or default to 'legacy'
  const [version, setVersion] = useState<TestBenchVersion>('legacy');
  const [loaded, setLoaded] = useState(false);

  // Load saved preference on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'v2') {
      setVersion('v2');
    }
    setLoaded(true);
  }, []);

  // Save preference when changed
  const handleVersionChange = (newVersion: TestBenchVersion) => {
    setVersion(newVersion);
    localStorage.setItem(STORAGE_KEY, newVersion);
  };

  // Don't render until we've loaded the preference (prevents flash)
  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Version Selector - Fixed position in top-right */}
      <div className="absolute top-2 right-4 z-50 flex items-center gap-2 bg-gray-800/90 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-gray-600 shadow-lg">
        <label className="text-xs text-gray-400 whitespace-nowrap">Test Bench:</label>
        <select
          value={version}
          onChange={(e) => handleVersionChange(e.target.value as TestBenchVersion)}
          className="bg-gray-700 text-white text-sm rounded px-2 py-1 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
        >
          <option value="legacy">Legacy (worker.py)</option>
          <option value="v2">V2 Pipeline (worker_new.py)</option>
        </select>
        {version === 'v2' && (
          <span className="text-xs bg-yellow-600 text-white px-1.5 py-0.5 rounded">BETA</span>
        )}
      </div>

      {/* Render the selected test bench */}
      {version === 'legacy' ? <TestBenchLegacy /> : <TestBenchV2 />}
    </div>
  );
}
