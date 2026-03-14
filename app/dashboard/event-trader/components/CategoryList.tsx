'use client';

import React from 'react';

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

const STATE_ICONS: Record<CategoryInfo['state'], string> = {
  idle: '⬚',
  armed: '🎯',
  identifying: '🔍',
  traded: '✅',
};

const STATE_LABELS: Record<CategoryInfo['state'], string> = {
  idle: 'idle',
  armed: 'listening...',
  identifying: 'identifying...',
  traded: 'traded',
};

interface CategoryListProps {
  categories: CategoryInfo[];
  currentCategory: string | null;
  onArm: (categoryId: string) => void;
}

export function CategoryList({ categories, currentCategory, onArm }: CategoryListProps) {
  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Categories
      </h2>
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {categories.length === 0 && (
          <p className="text-gray-500 text-sm italic">No categories loaded</p>
        )}
        {categories.map((cat) => {
          const isActive = cat.category_id === currentCategory;
          return (
            <button
              key={cat.category_id}
              onClick={() => cat.state === 'idle' && onArm(cat.category_id)}
              disabled={cat.state !== 'idle'}
              className={`w-full text-left px-3 py-2 rounded text-sm flex items-center justify-between transition-colors ${
                isActive
                  ? 'bg-yellow-900/40 border border-yellow-600'
                  : cat.state === 'idle'
                    ? 'hover:bg-gray-700 cursor-pointer'
                    : 'cursor-default'
              } ${cat.state === 'traded' ? 'opacity-70' : ''}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0">{STATE_ICONS[cat.state]}</span>
                <span className="text-white truncate">{cat.name}</span>
                {cat.winner && (
                  <span className="text-green-400 truncate">— {cat.winner}</span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                {cat.state === 'traded' && cat.pnl != null && (
                  <span className={cat.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {cat.pnl >= 0 ? '+' : ''}${cat.pnl.toLocaleString()}
                  </span>
                )}
                <span className="text-gray-500 text-xs">{STATE_LABELS[cat.state]}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
