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
  onArm: (categoryId: string) => void;
  onDisarm: () => void;
  onFire: (nomineeId: string) => void;
  onConfigUpdate: (config: { position_size_dollars: number }) => void;
}

export function ControlPanel({
  categories,
  currentCategory,
  connected,
  onArm,
  onDisarm,
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

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Controls
      </h2>
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
}
