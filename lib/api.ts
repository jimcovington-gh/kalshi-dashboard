import { get } from 'aws-amplify/api';
import { fetchAuthSession } from 'aws-amplify/auth';

// V2 Trade schema - uses market_ticker, idea_name, placed_at, completed_at
// Only filled trades are returned (filled_count > 0)
export interface Trade {
  order_id: string;
  market_ticker: string;
  user_name: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  filled_count: number;
  avg_fill_price: number;
  max_dollar_amount: number;
  max_price: number;
  order_status: string;
  placed_at: string;
  completed_at?: string;
  idea_name: string;
  idea_version: string;
  idea_parameters: Record<string, any>;
  fill_count: number;
  fills?: Array<{
    fill_id: string;
    order_id: string;
    ticker: string;
    side: string;
    action: string;
    count: number;
    price: number;
    created_time: string;
  }>;
  orderbook_snapshot?: {
    yes_bids?: Array<{ price: number; quantity: number }>;
    no_bids?: Array<{ price: number; quantity: number }>;
  };
  // Legacy field aliases for backward compatibility
  ticker?: string;  // Maps to market_ticker
  initiated_at?: string;  // Maps to placed_at
}

export interface Position {
  ticker: string;
  contracts: number;
  side: 'yes' | 'no';
  fill_price?: number;
  current_price: number;
  market_value: number;
  market_title: string;
  close_time: string;
  event_ticker?: string;
  series_ticker?: string;
}

export interface Portfolio {
  user_name: string;
  cash_balance: number;
  position_count: number;
  total_position_value: number;
  positions: Position[];
  history?: any[];
}

export interface PortfolioResponse {
  user?: string;
  is_admin_view: boolean;
  portfolio?: Portfolio;
  portfolios?: Portfolio[];
  user_count?: number;
}

export interface CategoryStat {
  name: string;
  pnl: number;
  volume: number;
  trades: number;
  win_rate: number;
}

export interface AnalyticsResponse {
  user: string;
  period: string;
  total_pnl: number;
  categories: CategoryStat[];
}

export async function getTrades(ticker: string, userName?: string): Promise<{
  ticker: string;
  user: string;
  is_admin_view: boolean;
  count: number;
  trades: Trade[];
}> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const params: any = { ticker };
    if (userName) {
      params.user_name = userName;
    }

    const queryString = new URLSearchParams(params).toString();
    
    const restOperation = get({
      apiName: 'DashboardAPI',
      path: `/trades?${queryString}`,
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as any;
  } catch (error) {
    console.error('Error fetching trades:', error);
    throw error;
  }
}

export async function getPortfolio(
  userName?: string, 
  includeHistory: boolean = false,
  historyPeriod: string = '24h'
): Promise<PortfolioResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const params: any = {};
    if (userName) {
      params.user_name = userName;
    }
    if (includeHistory) {
      params.include_history = 'true';
      params.history_period = historyPeriod;
    }

    const queryString = new URLSearchParams(params).toString();
    const path = queryString ? `/portfolio?${queryString}` : '/portfolio';
    
    const restOperation = get({
      apiName: 'DashboardAPI',
      path,
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as any;
  } catch (error) {
    console.error('Error fetching portfolio:', error);
    throw error;
  }
}

export async function isAdmin(): Promise<boolean> {
  try {
    const session = await fetchAuthSession();
    const groups = session.tokens?.accessToken?.payload['cognito:groups'] as string[] | undefined;
    return groups?.includes('admin') || false;
  } catch {
    return false;
  }
}

export async function getCurrentUser(): Promise<string> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.payload['cognito:username'] as string || '';
  } catch {
    return '';
  }
}

export async function getAnalytics(
  userName?: string,
  period: string = '30d'
): Promise<AnalyticsResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const params: any = { period };
    if (userName) {
      params.user_name = userName;
    }

    const queryString = new URLSearchParams(params).toString();
    
    const restOperation = get({
      apiName: 'DashboardAPI',
      path: `/analytics?${queryString}`,
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as any;
  } catch (error) {
    console.error('Error fetching analytics:', error);
    throw error;
  }
}
