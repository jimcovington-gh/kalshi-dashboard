'use client';

import { useEffect, useState } from 'react';
import { getPortfolio, getSettlements, Portfolio, SettlementsResponse } from '@/lib/api';
import SettlementsTable from '@/components/SettlementsTable';
import WeeklyPositionTable from '@/components/WeeklyPositionTable';

export default function AnalyticsPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [period, setPeriod] = useState<string>('30d');
  const [groupBy, setGroupBy] = useState<'idea' | 'category' | 'price_bucket' | ''>('category');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingSettlements, setIsLoadingSettlements] = useState(true);
  const [error, setError] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [settlementsData, setSettlementsData] = useState<SettlementsResponse | null>(null);

  useEffect(() => {
    loadPortfolioData();
  }, []); // Load portfolio once on mount

  useEffect(() => {
    if (selectedUser) {
      loadSettlementsData();
    }
  }, [selectedUser, period, groupBy]); // Reload settlements when user/period/groupBy changes

  async function loadPortfolioData() {
    setIsLoading(true);
    try {
      // Fetch Portfolio History - don't pass selectedUser to get all portfolios for admins
      const portfolioData = await getPortfolio(undefined, true, '30d');
      
      let loadedPortfolios: Portfolio[] = [];
      const adminView = portfolioData.is_admin_view;
      setIsAdmin(adminView);
      
      if (adminView && portfolioData.portfolios) {
        loadedPortfolios = portfolioData.portfolios;
      } else if (portfolioData.portfolio) {
        loadedPortfolios = [portfolioData.portfolio];
      }
      
      setPortfolios(loadedPortfolios);
      
      // Set initial user if not selected
      if (!selectedUser && loadedPortfolios.length > 0) {
        setSelectedUser(loadedPortfolios[0].user_name);
      }
      
    } catch (err: any) {
      console.error('Error loading portfolio:', err);
      setError(err.message || 'Failed to load portfolio data');
    } finally {
      setIsLoading(false);
    }
  }

  async function loadSettlementsData() {
    setIsLoadingSettlements(true);
    try {
      const data = await getSettlements(
        selectedUser,
        period,
        groupBy || undefined
      );
      setSettlementsData(data);
    } catch (err: any) {
      console.error('Error loading settlements:', err);
      // Don't set main error, just log it
    } finally {
      setIsLoadingSettlements(false);
    }
  }

  const currentPortfolio = portfolios.find(p => p.user_name === selectedUser);
  const historyData = currentPortfolio?.history || [];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Portfolio Analytics</h1>
        
        <div className="flex flex-wrap gap-2">
          {/* User Selector (show only for admins with multiple users) */}
          {isAdmin && portfolios.length > 1 && (
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
            {['7d', '30d', '90d', 'all'].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`px-4 py-2 text-sm font-medium border ${
                  period === p
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                } ${
                  p === '7d' ? 'rounded-l-lg' : ''
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

      {error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      ) : (
        <>
          {/* Weekly Position Table */}
          <WeeklyPositionTable
            history={historyData}
            isLoading={isLoading}
          />

          {/* Settlements Table */}
          <div className="mt-6">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Trades to Settlement</h2>
            <SettlementsTable
              trades={settlementsData?.trades || []}
              summary={settlementsData?.summary || { total_profit: 0, win_rate: 0, wins: 0, losses: 0, total_cost: 0, total_return: 0 }}
              grouped={settlementsData?.grouped}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              isLoading={isLoadingSettlements}
            />
          </div>
        </>
      )}
    </div>
  );
}
