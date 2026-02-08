import { get, post } from 'aws-amplify/api';
import { fetchAuthSession } from 'aws-amplify/auth';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-browser';

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
  fill_time?: string | number;
  idea_name?: string;
  current_price: number;
  market_value: number;
  market_title: string;
  close_time: string;
  event_ticker?: string;
  series_ticker?: string;
  market_status?: string;
  result?: string;
  strike?: string;
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

// Settlement Analytics Types
export interface SettledTrade {
  order_id: string;
  market_ticker: string;
  idea_name: string;
  category: string;
  placed_at: number;
  settlement_time: number;
  won: boolean;
  side: 'yes' | 'no';
  count: number;
  purchase_price: number;
  settlement_price: number;
  total_cost: number;
  total_return: number;
  profit: number;
  duration_hours: number;
}

export interface SettlementSummary {
  total_profit: number;
  win_rate: number;
  wins: number;
  losses: number;
  total_cost: number;
  total_return: number;
}

export interface GroupedStats {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_cost: number;
  total_return: number;
  profit: number;
  // New enhanced metrics
  avg_entry_price?: number;
  avg_final_bid?: number | null;
  contracts_above_entry?: number;
  contracts_equal_entry?: number;
  contracts_below_entry?: number;
  pct_final_bid_below_90?: number | null;
  win_rate_final_bid_below_90?: number | null;
  avg_duration_hours?: number;
}

export interface SettlementsResponse {
  user: string;
  period: string;
  total_trades: number;
  page: number;
  page_size: number;
  total_pages: number;
  summary: SettlementSummary;
  trades: SettledTrade[];
  grouped?: {
    byCategory?: Record<string, GroupedStats>;
    byIdea?: Record<string, GroupedStats>;
    byPriceBucket?: Record<string, GroupedStats>;
  };
}

export async function getSettlements(
  userName?: string,
  period: string = '30d',
  groupBy?: 'idea' | 'category' | 'price_bucket',
  page: number = 1,
  pageSize: number = 100,
  lossesOnly: boolean = false
): Promise<SettlementsResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const params: Record<string, string> = { 
      period,
      page: page.toString(),
      page_size: pageSize.toString()
    };
    if (userName) {
      params.user_name = userName;
    }
    if (groupBy) {
      params.group_by = groupBy;
    }
    if (lossesOnly) {
      params.losses_only = 'true';
    }

    const queryString = new URLSearchParams(params).toString();
    
    const restOperation = get({
      apiName: 'DashboardAPI',
      path: `/analytics/settlements?${queryString}`,
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as SettlementsResponse;
  } catch (error) {
    console.error('Error fetching settlements:', error);
    throw error;
  }
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

// Trading Status Types and Functions
export interface TradingIdea {
  idea_id: string;
  display_name: string;
  description: string;
}

export interface UserIdeaStatus {
  enabled: boolean;
  updated_at: string;
}

export interface UserTradingStatus {
  user_name: string;
  ideas: Record<string, UserIdeaStatus>;
}

export interface TradingStatus {
  trading_enabled: boolean | null;
  shutdown_active: boolean | null;
  reason: string;
  triggered_at: string;
  triggered_by: string;
  error?: string;
  ideas?: TradingIdea[];
  users?: UserTradingStatus[];
}

export async function getTradingStatus(): Promise<TradingStatus> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = get({
      apiName: 'DashboardAPI',
      path: '/trading-status',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as TradingStatus;
  } catch (error) {
    console.error('Error fetching trading status:', error);
    throw error;
  }
}

export async function setTradingStatus(enabled: boolean, reason?: string): Promise<TradingStatus> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: '/trading-status',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          enabled,
          reason: reason || '',
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as TradingStatus;
  } catch (error) {
    console.error('Error setting trading status:', error);
    throw error;
  }
}

export interface UserIdeaToggleResult {
  user_name: string;
  idea_id: string;
  enabled: boolean;
  updated_at: string;
  updated_by: string;
}

export async function setUserIdeaToggle(
  userName: string,
  ideaId: string,
  enabled: boolean
): Promise<UserIdeaToggleResult> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: '/trading-status',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          user_name: userName,
          idea_id: ideaId,
          enabled,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as UserIdeaToggleResult;
  } catch (error) {
    console.error('Error setting user idea toggle:', error);
    throw error;
  }
}

// Mention Monitor Types and Functions
export interface MentionMonitor {
  event_ticker: string;
  user_name: string;
  phase: string;
  fargate_state: string;
  start_date: string;
  close_time: number;
  open_time: number;
  created_at: string;
  activated_at: string;
  last_heartbeat: string;
  fargate_instance_id?: string;
  phase_updated_at?: string;
  fargate_task_arn?: string;
  fargate_task_state?: string;
  fargate_started_at?: string;
}

export interface UserMonitorSummary {
  active_events: number;
  pending_events: number;
  has_fargate: boolean;
  fargate_state: string;
}

export interface MentionMonitorsResponse {
  monitors: MentionMonitor[];
  users: Record<string, UserMonitorSummary>;
  total_running_fargate: number;
  total_active_events: number;
  error?: string;
}

export interface ClearMonitorsResult {
  user_name: string;
  fargate_stopped: boolean;
  events_cleared: number;
  errors: string[];
  success: boolean;
  stopped_task_arn?: string;
}

export async function getMentionMonitors(): Promise<MentionMonitorsResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = get({
      apiName: 'DashboardAPI',
      path: '/mention-monitors',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as MentionMonitorsResponse;
  } catch (error) {
    console.error('Error fetching mention monitors:', error);
    throw error;
  }
}

export async function clearMentionMonitors(userName: string): Promise<ClearMonitorsResult> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: '/mention-monitors/clear',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          user_name: userName,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as ClearMonitorsResult;
  } catch (error) {
    console.error('Error clearing mention monitors:', error);
    throw error;
  }
}

// Admin Stats Types and Functions
export interface MarketCaptureRun {
  timestamp: string;
  duration_ms: number;
  duration_sec: number;
  record_count: number;
}

export interface RecentOrder {
  order_id: string;
  market_ticker: string;
  event_ticker: string;
  series_ticker: string;
  user_name: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  quantity: number;
  limit_price: number;
  order_status: string;
  placed_at: number;
  placed_at_iso: string;
  idea_name: string;
}

export interface RecentTrade {
  order_id: string;
  market_ticker: string;
  event_ticker: string;
  series_ticker: string;
  user_name: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  filled_count: number;
  avg_fill_price: number;
  total_cost: number;
  order_status: string;
  placed_at: number;
  placed_at_iso: string;
  completed_at: number | null;
  completed_at_iso: string | null;
  idea_name: string;
  idea_version: string;
}

export interface UpcomingMentionEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title: string;
  category: string;
  start_date: string;
  strike_date: string;
  hours_until_start: number;
}

export interface AdminStatsResponse {
  market_capture_runs: MarketCaptureRun[];
  recent_orders: RecentOrder[];
  recent_trades: RecentTrade[];
  upcoming_mention_events: UpcomingMentionEvent[];
  error?: string;
}

export interface VolatileWatchlistMarket {
  market_ticker: string;
  trade_side: 'YES' | 'NO';
  initial_price_dollars: number;
  highest_price_seen_dollars: number;
  lowest_price_seen_dollars: number;
  current_price_dollars: number;
  added_at: string;
  action_trigger_price?: number;
}

export interface VolatileWatchlistResponse {
  watchlist: VolatileWatchlistMarket[];
  count: number;
  timestamp: string;
  cleaned_up?: number;
}

export async function getAdminStats(): Promise<AdminStatsResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = get({
      apiName: 'DashboardAPI',
      path: '/admin-stats',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as AdminStatsResponse;
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    throw error;
  }
}

export async function getVolatileWatchlist(): Promise<VolatileWatchlistResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = get({
      apiName: 'DashboardAPI',
      path: '/volatile-watchlist',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as VolatileWatchlistResponse;
  } catch (error) {
    console.error('Error fetching volatile watchlist:', error);
    throw error;
  }
}

// Volatile Orders Types and Functions
export interface VolatileOrder {
  order_id: string;
  market_ticker: string;
  user_name: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  order_status: string;
  filled_count: number;
  avg_fill_price: number;
  placed_at: number;
  placed_at_iso: string;
  idea_version: string;
  idea_parameters: Record<string, any>;
}

export interface VolatileOrdersResponse {
  orders: VolatileOrder[];
  count: number;
  hours: number;
  timestamp: string;
}

export async function getVolatileOrders(hours: number = 24): Promise<VolatileOrdersResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = get({
      apiName: 'DashboardAPI',
      path: `/volatile-orders?hours=${hours}`,
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as VolatileOrdersResponse;
  } catch (error) {
    console.error('Error fetching volatile orders:', error);
    throw error;
  }
}

// Voice Trader Types and Functions
export interface RunningVoiceContainer {
  session_id: string;
  event_ticker: string;
  title: string;
  user_name: string;
  status: string;
  call_state: string;
  started_at: string;
  public_ip?: string;
  websocket_url?: string;
}

export interface RunningVoiceContainersResponse {
  containers: RunningVoiceContainer[];
  count: number;
}

export async function getRunningVoiceContainers(): Promise<RunningVoiceContainersResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = get({
      apiName: 'DashboardAPI',
      path: '/voice-trader/running',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as RunningVoiceContainersResponse;
  } catch (error) {
    console.error('Error fetching running voice containers:', error);
    throw error;
  }
}

export async function stopVoiceContainer(sessionId: string): Promise<{ success: boolean; message: string }> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: `/voice-trader/stop/${sessionId}`,
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as { success: boolean; message: string };
  } catch (error) {
    console.error('Error stopping voice container:', error);
    throw error;
  }
}

// AI Chat Types and Functions
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIChatResponse {
  response: string;
  user: string;
  is_admin: boolean;
}

export async function sendAIChatMessage(messages: ChatMessage[]): Promise<AIChatResponse> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    // Convert messages to simple objects for Amplify API compatibility
    const messagesPayload = messages.map(m => ({ role: m.role, content: m.content }));

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: '/ai-chat',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          messages: JSON.stringify(messagesPayload),
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json();
    
    return data as unknown as AIChatResponse;
  } catch (error) {
    console.error('Error sending AI chat message:', error);
    throw error;
  }
}

// AI Chat Streaming Types
export interface AIChatStreamProgress {
  type: 'progress';
  content: string;
}

export interface ToolCall {
  tool: string;
  detail: string;
}

export interface AIChatStreamDone {
  type: 'done';
  content: string;
  user: string;
  is_admin: boolean;
  tool_calls?: ToolCall[];
}

export interface AIChatStreamError {
  type: 'error';
  content: string;
}

export type AIChatStreamChunk = AIChatStreamProgress | AIChatStreamDone | AIChatStreamError;

// Get the AI Chat Function URL from environment
// Falls back to empty string if not configured (will show error in UI)
const AI_CHAT_FUNCTION_URL = process.env.NEXT_PUBLIC_AI_CHAT_FUNCTION_URL || '';

/**
 * Sign a request using SigV4 for Lambda Function URL (IAM auth)
 */
async function signRequest(
  url: string,
  method: string,
  body: string,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  region: string
): Promise<Headers> {
  const parsedUrl = new URL(url);
  
  const signer = new SignatureV4({
    service: 'lambda',
    region,
    credentials,
    sha256: Sha256,
  });

  const request = {
    method,
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? parseInt(parsedUrl.port) : undefined,
    path: parsedUrl.pathname,
    query: Object.fromEntries(parsedUrl.searchParams),
    headers: {
      'Content-Type': 'application/json',
      'Host': parsedUrl.host,
    },
    body,
  };

  const signedRequest = await signer.sign(request);
  const headers = new Headers();
  for (const [key, value] of Object.entries(signedRequest.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

/**
 * Send AI chat message via Lambda Function URL.
 * Non-streaming: Lambda returns complete response (allows 15-min timeout)
 * 
 * @param messages - The conversation history
 * @param onProgress - Callback for progress updates (called once with "Processing...")
 * @param onDone - Callback when response is complete
 * @param onError - Callback for errors
 */
export async function sendAIChatMessageStreaming(
  messages: ChatMessage[],
  onProgress: (content: string) => void,
  onDone: (response: AIChatStreamDone) => void,
  onError: (error: string) => void
): Promise<void> {
  if (!AI_CHAT_FUNCTION_URL) {
    onError('AI Chat Function URL not configured. Check NEXT_PUBLIC_AI_CHAT_FUNCTION_URL environment variable.');
    return;
  }

  try {
    // Get user info from session for the request body
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken;
    // Note: cognito:username is the UUID when email is used as alias
    // Use preferred_username which contains the actual username (e.g., "jimc")
    const userName = idToken?.payload?.['preferred_username'] as string 
                  || idToken?.payload?.['cognito:username'] as string 
                  || 'unknown';
    const groups = idToken?.payload?.['cognito:groups'] as string[] || [];
    const isAdmin = groups.some(g => g.toLowerCase().includes('admin'));

    console.log('User:', userName, 'Admin:', isAdmin);

    // Build request body - include user info since Function URL has no auth
    const messagesPayload = messages.map(m => ({ role: m.role, content: m.content }));
    const body = JSON.stringify({ 
      messages: messagesPayload,
      user_name: userName,
      is_admin: isAdmin,
    });

    console.log('Making request to:', AI_CHAT_FUNCTION_URL);
    onProgress('Processing request (this may take a minute)...');

    // Make the request (no SigV4 needed - Function URL is public)
    let response: Response;
    try {
      response = await fetch(AI_CHAT_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
        mode: 'cors',
      });
    } catch (fetchError) {
      console.error('Fetch failed:', fetchError);
      onError(`Network error: ${fetchError instanceof Error ? fetchError.message : 'Unknown fetch error'}`);
      return;
    }

    console.log('Response status:', response.status);

    if (!response.ok) {
      const text = await response.text();
      console.error('Response error:', response.status, text);
      onError(`HTTP ${response.status}: ${text}`);
      return;
    }

    // Parse JSON response (not streaming)
    const result = await response.json();
    console.log('Response received:', result);

    // Handle API Gateway-style response (statusCode, headers, body)
    // Function URL with RESPONSE_STREAM mode returns this format
    let data = result;
    if (result.statusCode && result.body) {
      // Body is a JSON string, parse it
      data = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
    }

    if (data.error) {
      onError(data.error);
      return;
    }

    // Convert to the expected done format
    onDone({
      type: 'done',
      content: data.response || 'No response content',
      user: data.user || userName,
      is_admin: data.is_admin ?? isAdmin,
      tool_calls: data.tool_calls || [],
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    onError(error instanceof Error ? error.message : 'Unknown error');
  }
}

// Conversation storage types
export interface SavedConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

/**
 * List saved conversations from S3 (via Lambda)
 */
export async function listConversations(): Promise<SavedConversation[]> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = get({
      apiName: 'DashboardAPI',
      path: '/ai-chat/conversations',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json() as unknown as { conversations: SavedConversation[] };
    return data.conversations || [];
  } catch (error) {
    console.error('Error listing conversations:', error);
    return [];
  }
}

/**
 * Save a conversation to S3 (via Lambda)
 */
export async function saveConversation(id: string, title: string, messages: ChatMessage[]): Promise<boolean> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    // Convert messages to plain objects for API compatibility
    const messagesForApi = messages.map(m => ({ role: m.role, content: m.content }));

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: '/ai-chat/conversations',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          action: 'save',
          id,
          title,
          messages: messagesForApi,
        },
      },
    });

    await restOperation.response;
    return true;
  } catch (error) {
    console.error('Error saving conversation:', error);
    return false;
  }
}

/**
 * Load a conversation from S3 (via Lambda)
 */
export async function loadConversation(id: string): Promise<SavedConversation | null> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: '/ai-chat/conversations',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          action: 'load',
          id,
        },
      },
    });

    const response = await restOperation.response;
    const data = await response.body.json() as unknown as { conversation: SavedConversation };
    return data.conversation || null;
  } catch (error) {
    console.error('Error loading conversation:', error);
    return null;
  }
}

/**
 * Delete a conversation from S3 (via Lambda)
 */
export async function deleteConversation(id: string): Promise<boolean> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    const restOperation = post({
      apiName: 'DashboardAPI',
      path: '/ai-chat/conversations',
      options: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          action: 'delete',
          id,
        },
      },
    });

    await restOperation.response;
    return true;
  } catch (error) {
    console.error('Error deleting conversation:', error);
    return false;
  }
}
