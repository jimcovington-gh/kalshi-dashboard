import { get } from 'aws-amplify/api';
import { fetchAuthSession } from 'aws-amplify/auth';

export interface Trade {
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  filled_count: number;
  avg_fill_price: number;
  max_dollar_amount: number;
  status: string;
  success: boolean;
  initiated_at: string;
  fills?: string;
  error_message?: string;
  orderbook_snapshot?: any;
}

export interface Position {
  ticker: string;
  contracts: number;
  side: 'yes' | 'no';
  current_price: number;
  market_value: number;
  market_title: string;
  close_time: string;
  event_ticker?: string;
  series_ticker?: string;
}

export interface Portfolio {
  user_name: string;
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

export async function getPortfolio(userName?: string, includeHistory: boolean = false): Promise<PortfolioResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const params: any = {};
    if (userName) {
      params.user_name = userName;
    }
    if (includeHistory) {
      params.include_history = 'true';
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
