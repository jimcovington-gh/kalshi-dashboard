'use client';

import React, { useState } from 'react';

interface NomineeInfo {
  name: string;
  nominee_id: string;
  ticker: string;
  soundex_code?: string;
  has_thin_market?: boolean;
}

interface CategoryInfo {
  name: string;
  category_id: string;
  state: 'idle' | 'armed' | 'identifying' | 'traded';
  winner: string | null;
  nominees: NomineeInfo[];
  pnl?: number;
}

interface ControlPanelProps {
  categories: CategoryInfo[];
  currentCategory: string | null;
  connected: boolean;
  isIdentifying: boolean;
  autoTriggered: boolean;
  manualTriggered: boolean;
  triggerAlertPhrase: string | null;
  onArm: (categoryId: string) => void;
  onDisarm: () => void;
  onTrigger: () => void;
  onResetTrigger: () => void;
  onFire: (nomineeId: string) => void;
  onConfigUpdate: (config: { position_size_dollars: number }) => void;
}

export const ControlPanel = React.memo(function ControlPanel({
  categories,
  currentCategory,
  connected,
  isIdentifying,
  autoTriggered,
  manualTriggered,
  triggerAlertPhrase,
  onArm,
  onDisarm,
  onTrigger,
  onResetTrigger,
  onFire,
  onConfigUpdate,
}: ControlPanelProps) {
  const [betSize, setBetSize] = useState(2000);

  const idleCategories = categories.filter((c) => c.state === 'idle');
  const armedCategory = categories.find((c) => c.category_id === currentCategory);
  const armedNominees = armedCategory?.nominees ?? [];

  function handleBetSizeChange(value: string) {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num > 0) {
      setBetSize(num);
    }
  }

  function handleBetSizeCommit() {
    onConfigUpdate({ position_size_dollars: betSize });
  }

  const isArmed = !!currentCategory && !isIdentifying;

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Controls
      </h2>

      {/* Dual-trigger gate indicator */}
      {isArmed && (
        <div className="mb-3 p-3 rounded-lg bg-gray-900 border border-gray-600">
          <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Dual Trigger Gate</div>
          <div className="flex items-center gap-4">
            {/* AUTO indicator */}
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-3 h-3 rounded-full ${
                  autoTriggered
                    ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]'
                    : 'bg-gray-600'
                }`}
              />
              <span className={`text-sm font-medium ${autoTriggered ? 'text-green-300' : 'text-gray-500'}`}>
                AUTO
              </span>
              {autoTriggered && (
                <button
                  onClick={onResetTrigger}
                  className="text-xs text-red-400 hover:text-red-300 border border-red-700 rounded px-1.5 py-0.5 transition-colors"
                  title="Dismiss false auto-trigger and re-enable detection"
                >
                  RESET
                </button>
              )}
            </div>

            {/* Separator */}
            <span className="text-gray-600 text-lg font-bold">&amp;</span>

            {/* MANUAL indicator */}
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-3 h-3 rounded-full ${
                  manualTriggered
                    ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]'
                    : 'bg-gray-600'
                }`}
              />
              <span className={`text-sm font-medium ${manualTriggered ? 'text-green-300' : 'text-gray-500'}`}>
                MANUAL
              </span>
            </div>

            {/* Status text */}
            <span className="text-xs text-gray-500 ml-auto">
              {autoTriggered && manualTriggered
                ? 'Both confirmed → IDENTIFYING'
                : autoTriggered
                ? 'Waiting for manual confirm...'
                : manualTriggered
                ? 'Waiting for audio trigger...'
                : 'Both required to start matching'}
            </span>
          </div>
          {autoTriggered && triggerAlertPhrase && (
            <div className="mt-2 text-xs text-yellow-400 truncate">
              Detected: “{triggerAlertPhrase}”
            </div>
          )}
        </div>
      )}

      {/* Auto-trigger alert banner */}
      {isArmed && autoTriggered && !manualTriggered && (
        <div className="mb-3 animate-pulse bg-yellow-900/50 border-2 border-yellow-500 rounded-lg p-3 text-center">
          <span className="text-yellow-200 font-bold text-sm">
            ⚡ TRIGGER DETECTED — Click TRIGGER to confirm!
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* ARM dropdown */}
        <div className="flex items-center gap-1">
          <select
            disabled={!connected || idleCategories.length === 0}
            onChange={(e) => {
              if (e.target.value) onArm(e.target.value);
              e.target.value = '';
            }}
            defaultValue=""
            className="bg-gray-700 text-white text-sm rounded px-3 py-1.5 border border-gray-600 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-yellow-500"
          >
            <option value="" disabled>
              ARM Next ▼
            </option>
            {idleCategories.map((c) => (
              <option key={c.category_id} value={c.category_id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* TRIGGER — manual half of dual-trigger gate */}
        <button
          onClick={onTrigger}
          disabled={!connected || !currentCategory || isIdentifying || manualTriggered}
          className={`text-white text-sm font-bold rounded px-4 py-1.5 transition-colors ring-2 ${
            isArmed && autoTriggered && !manualTriggered
              ? 'bg-yellow-600 hover:bg-yellow-500 ring-yellow-400 animate-pulse'
              : manualTriggered
              ? 'bg-green-800 ring-green-600 opacity-60 cursor-not-allowed'
              : 'bg-blue-700 hover:bg-blue-600 ring-blue-500/50'
          } disabled:bg-gray-700 disabled:opacity-40 disabled:ring-gray-600 disabled:animate-none`}
          title={manualTriggered ? 'Manual trigger already confirmed' : 'Confirm manual trigger (both auto + manual required)'}
        >
          {manualTriggered ? '✓ TRIGGERED' : '⚡ TRIGGER'}
        </button>

        {/* DISARM */}
        <button
          onClick={onDisarm}
          disabled={!connected || !currentCategory}
          className="bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:opacity-40 text-white text-sm font-medium rounded px-3 py-1.5 transition-colors"
        >
          Disarm
        </button>

        {/* Manual FIRE */}
        <select
          disabled={!connected || armedNominees.length === 0}
          onChange={(e) => {
            if (e.target.value) onFire(e.target.value);
            e.target.value = '';
          }}
          defaultValue=""
          className="bg-orange-700 text-white text-sm rounded px-3 py-1.5 border border-orange-600 disabled:bg-gray-700 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-orange-500"
        >
          <option value="" disabled>
            Manual Fire ▼
          </option>
          {armedNominees.map((n) => (
            <option key={n.nominee_id} value={n.nominee_id}>
              {n.name}
            </option>
          ))}
        </select>

        {/* Divider */}
        <div className="w-px h-6 bg-gray-600" />

        {/* Bet Size */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-400">Bet size:</label>
          <div className="flex items-center">
            <span className="text-gray-400 text-sm mr-0.5">$</span>
            <input
              type="number"
              value={betSize}
              onChange={(e) => handleBetSizeChange(e.target.value)}
              onBlur={handleBetSizeCommit}
              onKeyDown={(e) => e.key === 'Enter' && handleBetSizeCommit()}
              min={1}
              className="w-20 bg-gray-700 text-white text-sm rounded px-2 py-1.5 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>
    </div>
  );
});
