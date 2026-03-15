'use client';

import React from 'react';

interface NomineeInfo {
  name: string;
  nominee_id: string;
  ticker: string;
  soundex_code?: string;
  has_thin_market?: boolean;
}

interface NomineeListProps {
  nominees: NomineeInfo[];
  categoryName: string | null;
  matchedNominee: string | null;
}

export const NomineeList = React.memo(function NomineeList({ nominees, categoryName, matchedNominee }: NomineeListProps) {
  if (!categoryName) {
    return (
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Nominees
        </h2>
        <p className="text-gray-500 text-sm italic">Arm a category to see nominees</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Nominees — <span className="text-white normal-case">{categoryName}</span>
      </h2>
      <div className="space-y-1">
        {nominees.map((nom) => {
          const isMatched = matchedNominee === nom.nominee_id;
          return (
            <div
              key={nom.nominee_id}
              className={`px-3 py-2 rounded text-sm flex items-center justify-between ${
                isMatched
                  ? 'bg-green-900/50 border border-green-600'
                  : nom.has_thin_market
                    ? 'opacity-50'
                    : ''
              }`}
            >
              <div className="flex items-center gap-2">
                {isMatched && <span>🎯</span>}
                <span className={isMatched ? 'text-green-300 font-medium' : 'text-white'}>
                  {nom.name}
                </span>
                {nom.has_thin_market && (
                  <span className="text-xs text-yellow-500 bg-yellow-900/40 px-1.5 py-0.5 rounded">
                    thin
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {nom.soundex_code && (
                  <span className="text-xs font-mono text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded">
                    {nom.soundex_code}
                  </span>
                )}
                <span className="text-xs text-gray-500 font-mono">{nom.ticker}</span>
              </div>
            </div>
          );
        })}
        {nominees.length === 0 && (
          <p className="text-gray-500 text-sm italic">No nominees for this category</p>
        )}
      </div>
    </div>
  );
});
