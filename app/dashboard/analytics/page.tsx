'use client';

import { useEffect, useState } from 'react';
import { getPortfolio, Portfolio } from '@/lib/api';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts';
import { format } from 'date-fns';

export default function AnalyticsPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [period, setPeriod] = useState<string>('24h');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadData();
  }, [period]);

  async function loadData() {
    setIsLoading(true);
    try {
      // Fetch with history enabled
      const data = await getPortfolio(undefined, true, period);
      
      let loadedPortfolios: Portfolio[] = [];
      
      if (data.is_admin_view && data.portfolios) {
        loadedPortfolios = data.portfolios;
      } else if (data.portfolio) {
        loadedPortfolios = [data.portfolio];
      }
      
      setPortfolios(loadedPortfolios);
      
      // Select first user if none selected or current selection not in list
      if (loadedPortfolios.length > 0) {
        if (!selectedUser || !loadedPortfolios.find(p => p.user_name === selectedUser)) {
          setSelectedUser(loadedPortfolios[0].user_name);
        }
      }
      
    } catch (err: any) {
      console.error('Error loading analytics:', err);
      setError(err.message || 'Failed to load analytics data');
    } finally {
      setIsLoading(false);
    }
  }

  const currentPortfolio = portfolios.find(p => p.user_name === selectedUser);
  const historyData = currentPortfolio?.history || [];

  // Format data for chart
  const chartData = historyData.map(item => ({
    timestamp: item.snapshot_ts,
    date: new Date(Number(item.snapshot_ts)),
    value: Number(item.total_value) / 100, // Convert cents to dollars
    cash: Number(item.cash) / 100,
    invested: (Number(item.total_value) - Number(item.cash)) / 100
  }));

  const formatXAxis = (tickItem: number) => {
    const date = new Date(tickItem);
    if (period === '24h') return format(date, 'HH:mm');
    if (period === '7d') return format(date, 'MMM dd');
    return format(date, 'MMM dd');
  };

  const formatTooltipDate = (timestamp: number) => {
    return format(new Date(timestamp), 'MMM dd, yyyy HH:mm');
  };

  const formatCurrency = (value: number) => {
    return `$${value.toFixed(2)}`;
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Portfolio Analytics</h1>
        
        <div className="flex flex-wrap gap-2">
          {/* User Selector (Admin only) */}
          {portfolios.length > 1 && (
            <select
              value={selectedUser}
              onChange={(e) => setSelectedUser(e.target.value)}
              className="block w-40 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
            >
              {portfolios.map(p => (
                <option key={p.user_name} value={p.user_name}>{p.user_name}</option>
              ))}
            </select>
          )}

          {/* Period Selector */}
          <div className="flex rounded-md shadow-sm" role="group">
            {['24h', '7d', '30d', 'all'].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`px-4 py-2 text-sm font-medium border ${
                  period === p
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                } ${
                  p === '24h' ? 'rounded-l-lg' : ''
                } ${
                  p === 'all' ? 'rounded-r-lg' : ''
                } -ml-px first:ml-0 focus:z-10 focus:ring-2 focus:ring-blue-500 focus:text-blue-700`}
              >
                {p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="h-96 flex items-center justify-center bg-white rounded-lg shadow">
          <div className="text-gray-500">Loading chart data...</div>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      ) : chartData.length === 0 ? (
        <div className="h-96 flex items-center justify-center bg-white rounded-lg shadow">
          <div className="text-gray-500">No history data available for this period</div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow p-4 md:p-6">
          <div className="mb-6">
            <h2 className="text-lg font-medium text-gray-900">Equity Curve</h2>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-gray-900">
                {formatCurrency(chartData[chartData.length - 1].value)}
              </span>
              <span className={`text-sm font-medium ${
                chartData[chartData.length - 1].value >= chartData[0].value 
                  ? 'text-green-600' 
                  : 'text-red-600'
              }`}>
                {chartData[chartData.length - 1].value >= chartData[0].value ? '+' : ''}
                {((chartData[chartData.length - 1].value - chartData[0].value) / chartData[0].value * 100).toFixed(2)}%
              </span>
              <span className="text-sm text-gray-500">vs start of period</span>
            </div>
          </div>

          <div className="h-[400px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartData}
                margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis 
                  dataKey="timestamp" 
                  tickFormatter={formatXAxis}
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  minTickGap={50}
                />
                <YAxis 
                  domain={['auto', 'auto']}
                  tickFormatter={(val) => `$${val}`}
                />
                <Tooltip 
                  labelFormatter={formatTooltipDate}
                  formatter={(value: number) => [formatCurrency(value), 'Portfolio Value']}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#2563eb"
                  fillOpacity={1}
                  fill="url(#colorValue)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
