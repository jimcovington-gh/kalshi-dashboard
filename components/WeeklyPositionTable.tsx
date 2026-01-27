'use client';

interface WeekData {
  weekStart: string;
  weekEnd: string;
  startValue: number;
  endValue: number;
  change: number;
  changePercent: number;
}

interface WeeklyPositionTableProps {
  history: Array<{
    snapshot_ts: number;
    total_value: number;
    cash: number;
  }>;
  isLoading: boolean;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function getWeekBounds(date: Date): { start: Date; end: Date } {
  const day = date.getDay();
  const start = new Date(date);
  start.setDate(date.getDate() - day); // Sunday
  start.setHours(0, 0, 0, 0);
  
  const end = new Date(start);
  end.setDate(start.getDate() + 6); // Saturday
  end.setHours(23, 59, 59, 999);
  
  return { start, end };
}

function formatDateShort(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function WeeklyPositionTable({ history, isLoading }: WeeklyPositionTableProps) {
  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Weekly Performance</h3>
        <div className="h-32 flex items-center justify-center text-gray-500">
          Loading...
        </div>
      </div>
    );
  }

  if (!history || history.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Weekly Performance</h3>
        <div className="text-gray-500 text-center py-8">
          No portfolio history available
        </div>
      </div>
    );
  }

  // Sort history by timestamp (oldest first)
  const sortedHistory = [...history].sort((a, b) => a.snapshot_ts - b.snapshot_ts);
  
  // Group history by week
  const weeklyData: Map<string, { values: number[]; timestamps: number[] }> = new Map();
  
  for (const point of sortedHistory) {
    const date = new Date(point.snapshot_ts);
    const { start } = getWeekBounds(date);
    const weekKey = start.toISOString().split('T')[0];
    
    if (!weeklyData.has(weekKey)) {
      weeklyData.set(weekKey, { values: [], timestamps: [] });
    }
    
    const week = weeklyData.get(weekKey)!;
    week.values.push(Number(point.total_value));
    week.timestamps.push(point.snapshot_ts);
  }
  
  // Calculate weekly changes (last 4 weeks)
  const weeks: WeekData[] = [];
  const weekKeys = Array.from(weeklyData.keys()).sort().reverse().slice(0, 4);
  
  for (const weekKey of weekKeys) {
    const weekDate = new Date(weekKey);
    const { start, end } = getWeekBounds(weekDate);
    const data = weeklyData.get(weekKey)!;
    
    if (data.values.length === 0) continue;
    
    const startValue = data.values[0];
    const endValue = data.values[data.values.length - 1];
    const change = endValue - startValue;
    const changePercent = startValue > 0 ? (change / startValue) * 100 : 0;
    
    weeks.push({
      weekStart: formatDateShort(start),
      weekEnd: formatDateShort(end),
      startValue,
      endValue,
      change,
      changePercent
    });
  }
  
  // Calculate total change across all weeks
  const totalStartValue = weeks.length > 0 ? weeks[weeks.length - 1].startValue : 0;
  const totalEndValue = weeks.length > 0 ? weeks[0].endValue : 0;
  const totalChange = totalEndValue - totalStartValue;
  const totalChangePercent = totalStartValue > 0 ? (totalChange / totalStartValue) * 100 : 0;

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-medium text-gray-900">Weekly Performance</h3>
        <div className="text-right">
          <span className="text-sm text-gray-500">Period Total: </span>
          <span className={`text-lg font-bold ${totalChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatPercent(totalChangePercent)}
          </span>
        </div>
      </div>
      
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Week</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Start</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">End</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Change</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {weeks.map((week, idx) => (
              <tr key={idx} className={idx === 0 ? 'bg-blue-50' : ''}>
                <td className="px-3 py-3 text-sm text-gray-900">
                  {week.weekStart} - {week.weekEnd}
                  {idx === 0 && <span className="ml-2 text-xs text-blue-600">(Current)</span>}
                </td>
                <td className="px-3 py-3 text-sm text-right text-gray-500">
                  {formatCurrency(week.startValue)}
                </td>
                <td className="px-3 py-3 text-sm text-right text-gray-900 font-medium">
                  {formatCurrency(week.endValue)}
                </td>
                <td className={`px-3 py-3 text-sm text-right font-medium ${
                  week.change >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {week.change >= 0 ? '+' : ''}{formatCurrency(week.change).replace('$', '')}
                </td>
                <td className={`px-3 py-3 text-sm text-right font-bold ${
                  week.changePercent >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {formatPercent(week.changePercent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
