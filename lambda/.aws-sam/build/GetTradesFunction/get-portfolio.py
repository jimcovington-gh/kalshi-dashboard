"""
Lambda function to get portfolio data using PortfolioFetcherLayer + DynamoDB enrichment
Supports user-specific queries and admin queries across all users

Architecture:
1. Fetch fresh portfolio from Kalshi API via PortfolioFetcherLayer
2. Enrich with historical data (fill prices from trades, market titles, etc.)
3. Return combined view with current state + historical context
"""

import json
import boto3
import logging
from decimal import Decimal
from typing import Dict, List, Any, Optional
import os
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
from portfolio_fetcher import fetch_user_portfolio

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')
secretsmanager = boto3.client('secretsmanager', region_name='us-east-1')
positions_table = dynamodb.Table(os.environ.get('POSITIONS_TABLE', 'production-kalshi-market-positions'))
portfolio_table = dynamodb.Table(os.environ.get('PORTFOLIO_TABLE', 'production-kalshi-portfolio-snapshots'))
market_metadata_table = dynamodb.Table(os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'))
trades_table = dynamodb.Table(os.environ.get('TRADES_TABLE', 'production-kalshi-trades-v2'))

# Table name for batch operations (needs string, not Table object)
MARKET_METADATA_TABLE_NAME = os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata')

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)


def batch_get_market_metadata(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Batch fetch market metadata from DynamoDB for multiple tickers.
    
    Uses batch_get_item for efficiency (100 items per request max).
    Handles pagination for portfolios with 100+ positions.
    
    Args:
        tickers: List of market tickers to fetch metadata for
        
    Returns:
        Dict mapping ticker -> {market_title, event_ticker, series_ticker, market_status, close_time}
    """
    if not tickers:
        return {}
    
    result = {}
    BATCH_SIZE = 100  # DynamoDB limit
    
    # Process in batches of 100
    for i in range(0, len(tickers), BATCH_SIZE):
        batch_tickers = tickers[i:i + BATCH_SIZE]
        keys = [{'market_ticker': {'S': ticker}} for ticker in batch_tickers]
        
        try:
            response = dynamodb_client.batch_get_item(
                RequestItems={
                    MARKET_METADATA_TABLE_NAME: {
                        'Keys': keys,
                        'ProjectionExpression': 'market_ticker, market_title, event_ticker, series_ticker, market_status, close_time'
                    }
                }
            )
            
            # Process returned items
            items = response.get('Responses', {}).get(MARKET_METADATA_TABLE_NAME, [])
            for item in items:
                ticker = item.get('market_ticker', {}).get('S', '')
                if ticker:
                    result[ticker] = {
                        'market_title': item.get('market_title', {}).get('S', ticker),
                        'event_ticker': item.get('event_ticker', {}).get('S', ''),
                        'series_ticker': item.get('series_ticker', {}).get('S', ''),
                        'market_status': item.get('market_status', {}).get('S', 'unknown'),
                        'close_time': item.get('close_time', {}).get('S', '')
                    }
            
            # Handle unprocessed keys (throttling) with retry
            unprocessed = response.get('UnprocessedKeys', {}).get(MARKET_METADATA_TABLE_NAME, {}).get('Keys', [])
            retry_count = 0
            while unprocessed and retry_count < 3:
                retry_count += 1
                logger.warning(f"Retrying {len(unprocessed)} unprocessed keys (attempt {retry_count})")
                import time
                time.sleep(0.1 * retry_count)  # Exponential backoff
                
                retry_response = dynamodb_client.batch_get_item(
                    RequestItems={
                        MARKET_METADATA_TABLE_NAME: {
                            'Keys': unprocessed,
                            'ProjectionExpression': 'market_ticker, market_title, event_ticker, series_ticker, market_status, close_time'
                        }
                    }
                )
                
                retry_items = retry_response.get('Responses', {}).get(MARKET_METADATA_TABLE_NAME, [])
                for item in retry_items:
                    ticker = item.get('market_ticker', {}).get('S', '')
                    if ticker:
                        result[ticker] = {
                            'market_title': item.get('market_title', {}).get('S', ticker),
                            'event_ticker': item.get('event_ticker', {}).get('S', ''),
                            'series_ticker': item.get('series_ticker', {}).get('S', ''),
                            'market_status': item.get('market_status', {}).get('S', 'unknown'),
                            'close_time': item.get('close_time', {}).get('S', '')
                        }
                
                unprocessed = retry_response.get('UnprocessedKeys', {}).get(MARKET_METADATA_TABLE_NAME, {}).get('Keys', [])
            
            if unprocessed:
                logger.error(f"Failed to fetch {len(unprocessed)} keys after retries")
                
        except Exception as e:
            logger.error(f"batch_get_item failed for batch starting at index {i}: {e}")
            # Continue with next batch rather than failing entirely
            continue
    
    return result


def get_api_key_id(user_name: str) -> str:
    """Helper to get api_key_id for a user (used for portfolio history queries)"""
    try:
        secret_response = secretsmanager.get_secret_value(
            SecretId=f'production/kalshi/users/{user_name}/metadata'
        )
        secret_data = json.loads(secret_response['SecretString'])
        return secret_data['api_key_id']
    except Exception as e:
        logger.error(f"Error getting api_key_id for user {user_name}: {e}")
        raise

def get_current_portfolio(user_name: str, api_key_id: str = None) -> Dict[str, Any]:
    """
    Get current portfolio positions and values using positions-live (primary) or API (fallback)
    
    PHASE 7B Architecture (Cleanup):
    Uses portfolio-layer's fetch_user_portfolio() which:
    1. Tries positions-live table first (WebSocket-fed, real-time)
    2. Falls back to REST API if positions-live is stale (>12h) or unavailable
    Then enriches with fill price history from DynamoDB
    
    Args:
        user_name: Username to fetch portfolio for
        api_key_id: Optional API key ID (unused, kept for backward compatibility)
    
    Returns:
        Dictionary with current portfolio state + historical enrichment
    """
    
    logger.info(f"Fetching portfolio for {user_name}")
    
    # Use portfolio-layer's unified function (handles positions-live + REST fallback)
    try:
        portfolio = fetch_user_portfolio(
            user_name=user_name,
            user_secret_prefix='production/kalshi/users',
            kalshi_base_url=os.environ.get('KALSHI_API_BASE_URL', 'https://api.elections.kalshi.com'),
            rate_limiter_table_name=os.environ.get('RATE_LIMITER_TABLE_NAME', 'production-kalshi-rate-limiter'),
            market_metadata_table_name=os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'),
            positions_live_table_name=os.environ.get('POSITIONS_LIVE_TABLE', 'production-kalshi-positions-live'),
            logger=logger
        )
    except Exception as e:
        logger.error(f"Failed to fetch portfolio for {user_name}: {e}", exc_info=True)
        raise
    
    cash_balance = portfolio['balance_dollars']
    api_positions = portfolio['positions']
    total_position_value = portfolio['total_portfolio_value'] - cash_balance
    # Determine data source from log messages (positions-live logs "📊 Portfolio source: positions-live")
    data_source = 'positions_live'  # Layer handles source selection internally
    fetched_at = portfolio.get('fetched_at')
    
    logger.info(f"🔍 POSITION COUNT - Got {len(api_positions)} positions for {user_name} from {data_source}")
    
    # STEP 2: Get fill prices AND fill times by querying each ticker in parallel
    def query_ticker_fill_data(ticker: str) -> tuple:
        """Query fill price and fill time for a single ticker using market_ticker-index.
        Returns (ticker, avg_fill_price, most_recent_fill_time, idea_name)"""
        try:
            response = trades_table.query(
                IndexName='market_ticker-index',
                KeyConditionExpression='market_ticker = :ticker',
                FilterExpression='user_name = :user AND filled_count > :zero',
                ExpressionAttributeValues={
                    ':ticker': ticker,
                    ':user': user_name,
                    ':zero': 0
                }
            )
            items = response.get('Items', [])
            if items:
                total_contracts = sum(int(t.get('filled_count', 0)) for t in items)
                total_cost = sum(int(t.get('filled_count', 0)) * float(t.get('avg_fill_price', 0)) for t in items)
                # Get most recent fill time (latest trade, not earliest)
                fill_times = [t.get('completed_at') or t.get('placed_at') for t in items if t.get('completed_at') or t.get('placed_at')]
                most_recent_fill = max(fill_times) if fill_times else None
                
                # Get idea_name - if multiple trades, check if they're all the same
                idea_names = [t.get('idea_name') for t in items if t.get('idea_name')]
                if idea_names:
                    # If all trades have the same idea_name, use it; otherwise show "VARIOUS"
                    idea_name = idea_names[0] if len(set(idea_names)) == 1 else 'VARIOUS'
                else:
                    idea_name = None
                
                if total_contracts > 0:
                    return ticker, total_cost / total_contracts, most_recent_fill, idea_name
            return ticker, None, None, None
        except Exception as e:
            logger.warning(f"Failed to query fill data for {ticker}: {e}")
            return ticker, None, None, None
    
    # Query fill data in parallel (10 workers provides good balance)
    fill_prices = {}
    fill_times = {}
    idea_names = {}
    tickers_to_query = list(api_positions.keys())
    
    if tickers_to_query:
        try:
            with ThreadPoolExecutor(max_workers=10) as executor:
                results = list(executor.map(query_ticker_fill_data, tickers_to_query))
            
            for ticker, avg_price, fill_time, idea_name in results:
                if avg_price is not None:
                    fill_prices[ticker] = avg_price
                if fill_time is not None:
                    fill_times[ticker] = fill_time
                if idea_name is not None:
                    idea_names[ticker] = idea_name
            
            logger.info(f"Calculated fill data for {len(fill_prices)}/{len(tickers_to_query)} tickers using parallel queries")
        except Exception as e:
            logger.warning(f"Failed to fetch fill prices in parallel for {user_name}: {e}")
            fill_prices = {}
    
    # STEP 2.5: Batch fetch market metadata from DynamoDB (portfolio layer doesn't include metadata)
    # Use batch_get_item for efficiency - handles up to 100 items per batch
    market_metadata = {}
    if tickers_to_query:
        try:
            market_metadata = batch_get_market_metadata(tickers_to_query)
            logger.info(f"Batch fetched metadata for {len(market_metadata)}/{len(tickers_to_query)} tickers")
        except Exception as e:
            logger.warning(f"Failed to batch fetch market metadata: {e}")
            market_metadata = {}
    
    # STEP 3: Enrich positions with fill prices and market metadata
    position_details = []
    
    for ticker, position_data in api_positions.items():
        contracts = position_data['position']
        market_value = position_data['market_value']
        current_price = position_data['current_price']
        
        # Get metadata from batch lookup (fallback to ticker-derived values if missing)
        metadata = market_metadata.get(ticker, {})
        series = metadata.get('series_ticker') or (ticker.split('-')[0] if ticker else '')
        
        position_details.append({
            'ticker': ticker,
            'contracts': int(contracts),
            'side': 'yes' if contracts > 0 else 'no',
            'fill_price': float(fill_prices.get(ticker, 0)) if fill_prices.get(ticker) else None,
            'fill_time': fill_times.get(ticker),
            'idea_name': idea_names.get(ticker),
            'current_price': float(current_price),
            'market_value': float(market_value),
            'market_title': metadata.get('market_title', ticker),
            'close_time': metadata.get('close_time', ''),
            'event_ticker': metadata.get('event_ticker', ''),
            'series_ticker': series,
            'market_status': metadata.get('market_status', 'unknown')
        })

    
    logger.info(f"🔍 POSITION COUNT - After enrichment loop: {len(position_details)} positions")
    logger.info(f"🔍 ENRICHED TICKERS: {sorted([p['ticker'] for p in position_details])}")
    
    # DEBUG: Log market_status distribution
    status_counts = {}
    for p in position_details:
        s = p.get('market_status', 'MISSING')
        status_counts[s] = status_counts.get(s, 0) + 1
    logger.info(f"🔍 MARKET STATUS DISTRIBUTION: {status_counts}")
    
    # Sort: active/open markets first, then by market value descending within each group
    def sort_key(pos):
        # Active statuses come first (sort key 0), closed/settled come second (sort key 1)
        status = pos.get('market_status', 'unknown').lower()
        is_active = 1 if status in ('active', 'open', 'unknown') else 2
        # Within each group, sort by market value descending (negate for descending)
        return (is_active, -pos['market_value'])
    
    position_details.sort(key=sort_key)
    
    logger.info(f"🔍 POSITION COUNT - Returning {len(position_details)} positions to client for {user_name}")
    logger.info(f"Portfolio complete for {user_name}: {len(position_details)} positions, total value: ${cash_balance + total_position_value:.2f}")
    
    portfolio_result = {
        'user_name': user_name,
        'cash_balance': cash_balance,
        'position_count': len(position_details),
        'total_position_value': float(total_position_value),
        'positions': position_details,
        'data_source': data_source,  # 'positions_live' or 'api_with_enrichment'
        'fetched_at': fetched_at
    }
    
    return portfolio_result


# REMOVED: get_positions_from_live_table() - now handled by portfolio-layer's fetch_user_portfolio()


def fetch_market_data_batch_DEPRECATED(user_name: str, tickers: List[str]) -> Optional[Dict[str, dict]]:
    """
    Fetch current prices AND metadata for multiple markets in a single Kalshi API call.
    
    Uses GET /markets?tickers=T1,T2,T3... with pagination if >1000 tickers.
    
    Args:
        user_name: Username for API authentication
        tickers: List of market tickers to fetch
    
    Returns:
        Dict mapping ticker -> {price, title, status, close_time, event_ticker}, or None on error
    """
    from kalshi_client import KalshiClient
    
    if not tickers:
        return {}
    
    try:
        # Load user credentials
        metadata_secret_name = f'production/kalshi/users/{user_name}/metadata'
        metadata_response = secretsmanager.get_secret_value(SecretId=metadata_secret_name)
        metadata = json.loads(metadata_response['SecretString'])
        
        api_key_id = metadata.get('api_key_id')
        if not api_key_id:
            logger.error(f"api_key_id not found for {user_name}")
            return None
        
        private_key_secret_name = f'production/kalshi/users/{user_name}/private-key'
        private_key_response = secretsmanager.get_secret_value(SecretId=private_key_secret_name)
        private_key = private_key_response['SecretString']
        
        # Initialize client
        client = KalshiClient(
            base_url=os.environ.get('KALSHI_API_BASE_URL', 'https://api.elections.kalshi.com'),
            api_key_id=api_key_id,
            private_key_pem=private_key,
            logger=logger,
            requests_per_second=20,
            write_requests_per_second=10,
            rate_limiter_table_name=os.environ.get('RATE_LIMITER_TABLE_NAME', 'production-kalshi-rate-limiter')
        )
        
        market_data = {}
        
        # Process in batches of 1000 (API limit)
        BATCH_SIZE = 1000
        for i in range(0, len(tickers), BATCH_SIZE):
            batch_tickers = tickers[i:i + BATCH_SIZE]
            tickers_param = ','.join(batch_tickers)
            
            # Paginate through results
            cursor = None
            while True:
                path = f'/trade-api/v2/markets?tickers={tickers_param}&limit=1000'
                if cursor:
                    path += f'&cursor={cursor}'
                
                response = client._make_request(method='GET', path=path)
                
                markets = response.get('markets', [])
                for market in markets:
                    ticker = market.get('ticker')
                    status = market.get('status', '')
                    last_price_str = market.get('last_price_dollars')
                    
                    # Skip only finalized/settled markets (already converted to cash)
                    # Include 'closed' (awaiting settlement) - still has value
                    if status in ('finalized', 'settled'):
                        logger.debug(f"Skipping {ticker}: market status is {status} (already settled)")
                        continue
                    
                    if ticker and last_price_str:
                        try:
                            price = float(last_price_str)
                            # Also skip zero-price markets (settled)
                            if price == 0.0:
                                logger.debug(f"Skipping {ticker}: last_price is 0 (settled market)")
                                continue
                            
                            # Store full market data
                            market_data[ticker] = {
                                'price': price,
                                'title': market.get('title', ticker),
                                'status': status,
                                'close_time': market.get('close_time', ''),
                                'event_ticker': market.get('event_ticker', ''),
                                'subtitle': market.get('subtitle', '')
                            }
                        except (ValueError, TypeError):
                            pass
                
                # Check for more pages
                cursor = response.get('cursor')
                if not cursor or not markets:
                    break
        
        logger.info(f"Fetched data for {len(market_data)}/{len(tickers)} active markets from Kalshi API")
        return market_data
        
    except Exception as e:
        logger.error(f"Error fetching market prices batch: {e}", exc_info=True)
        return None


def get_positions_live_comparison(user_name: str) -> Dict[str, Any]:
    """
    DEPRECATED: Kept for backward compatibility during Phase 4 transition
    Read positions from DynamoDB positions-live table in COMPARISON MODE
    """
    try:
        positions_live_table_name = os.environ.get('POSITIONS_LIVE_TABLE')
        if not positions_live_table_name:
            return {}
        
        positions_live_table = dynamodb.Table(positions_live_table_name)
        
        response = positions_live_table.query(
            KeyConditionExpression='user_name = :user',
            ExpressionAttributeValues={':user': user_name}
        )
        
        live_items = response.get('Items', [])
        
        if not live_items:
            return {'status': 'not_available'}
        
        live_tickers = []
        min_staleness_minutes = float('inf')
        freshest_update = None
        
        for item in live_items:
            market_ticker = item.get('market_ticker', '')
            updated_at = item.get('updated_at', '')
            
            if market_ticker and market_ticker != 'CASH_BALANCE':
                live_tickers.append(market_ticker)
            
            if updated_at:
                try:
                    update_dt = datetime.fromisoformat(updated_at)
                    now_dt = datetime.now(timezone.utc)
                    staleness_seconds = (now_dt - update_dt).total_seconds()
                    staleness_minutes = staleness_seconds / 60
                    if staleness_minutes < min_staleness_minutes:
                        min_staleness_minutes = staleness_minutes
                        freshest_update = updated_at
                except:
                    pass
        
        if min_staleness_minutes == float('inf'):
            min_staleness_minutes = -1
        
        return {
            'status': 'available',
            'live_position_count': len(live_tickers),
            'live_tickers': sorted(live_tickers),
            'staleness_minutes': min_staleness_minutes,
            'freshest_update': freshest_update
        }
        
    except Exception as e:
        logger.error(f"Error reading positions-live for {user_name}: {e}", exc_info=True)
        return {'status': 'error', 'error': str(e)}


def compare_portfolios_log_diff(api_portfolio: Dict[str, Any], live_comparison: Dict[str, Any]) -> None:
    """
    Log differences between API portfolio and positions-live data
    
    This is used in Phase 4 comparison mode to identify any discrepancies
    between the REST API and the WebSocket-fed positions-live table.
    """
    if live_comparison.get('status') != 'available':
        return
    
    api_tickers = set([p['ticker'] for p in api_portfolio.get('positions', [])])
    live_tickers = set(live_comparison.get('live_tickers', []))
    
    if api_tickers == live_tickers:
        logger.info(f"✓ COMPARISON: Tickers match - API and positions-live in sync")
    else:
        missing_in_live = api_tickers - live_tickers
        extra_in_live = live_tickers - api_tickers
        
        if missing_in_live:
            logger.warning(f"⚠ COMPARISON: Missing in positions-live: {missing_in_live}")
        if extra_in_live:
            logger.warning(f"⚠ COMPARISON: Extra in positions-live: {extra_in_live}")
    
    # Log staleness warning if live data is too old (> 5 minutes)
    staleness = live_comparison.get('staleness_minutes', -1)
    if staleness > 5:
        logger.warning(f"⚠ COMPARISON: positions-live is stale ({staleness:.1f} min old)")
    elif staleness >= 0:
        logger.info(f"✓ COMPARISON: positions-live is fresh ({staleness:.1f} min old)")


def get_portfolio_history(api_key_id: str, period: str = '24h') -> List[Dict[str, Any]]:
    """Get portfolio snapshot history with downsampling"""
    
    now = datetime.now(timezone.utc)
    
    if period == '7d':
        start_time = now - timedelta(days=7)
        resolution = 'hour'
    elif period == '30d':
        start_time = now - timedelta(days=30)
        resolution = 'day'
    elif period == 'all':
        start_time = now - timedelta(days=365) # Cap at 1 year for now
        resolution = 'day'
    else: # Default to 24h
        start_time = now - timedelta(hours=24)
        resolution = '15min'

    start_ts = int(start_time.timestamp() * 1000)
    
    # Query DynamoDB
    items = []
    last_evaluated_key = None
    
    query_params = {
        'KeyConditionExpression': 'api_key_id = :api_key AND snapshot_ts >= :start_ts',
        'ExpressionAttributeValues': {
            ':api_key': api_key_id,
            ':start_ts': start_ts
        }
    }
    
    # Fetch all items in range (pagination)
    while True:
        if last_evaluated_key:
            query_params['ExclusiveStartKey'] = last_evaluated_key
            
        response = portfolio_table.query(**query_params)
        items.extend(response.get('Items', []))
        
        last_evaluated_key = response.get('LastEvaluatedKey')
        if not last_evaluated_key:
            break
            
    if not items:
        return []
        
    # Sort by timestamp ascending
    items.sort(key=lambda x: int(x['snapshot_ts']))
    
    # Downsample logic: Keep the LAST snapshot of each bucket
    buckets = {}
    for item in items:
        ts = int(item['snapshot_ts']) / 1000
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        
        if resolution == 'day':
            key = dt.strftime('%Y-%m-%d')
        elif resolution == 'hour':
            key = dt.strftime('%Y-%m-%d %H')
        else: # 15min
            minute = (dt.minute // 15) * 15
            key = dt.strftime(f'%Y-%m-%d %H:{minute:02d}')
            
        buckets[key] = item
        
    # Return sorted values
    return sorted(list(buckets.values()), key=lambda x: int(x['snapshot_ts']))

def lambda_handler(event, context):
    """
    Get portfolio data for user(s)
    
    Query params:
    - user_name: Username filter (optional for admin, returns all users if omitted)
    - include_history: Include historical snapshots (default: false)
    - history_period: Period for history (24h, 7d, 30d, all) - default 24h
    
    Cognito claims (from authorizer):
    - username: Logged in user
    - cognito:groups: User groups (contains 'admin' for admin users)
    """
    
    try:
        # Parse query parameters
        params = event.get('queryStringParameters', {}) or {}
        requested_user = params.get('user_name', '').strip()
        include_history = params.get('include_history', 'false').lower() == 'true'
        history_period = params.get('history_period', '24h')
        
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        current_user = claims.get('preferred_username', '')
        
        if not current_user:
            return {
                'statusCode': 401,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Authentication required - preferred_username not set'})
            }
        
        user_groups = claims.get('cognito:groups', '').split(',') if claims.get('cognito:groups') else []
        is_admin = 'admin' in user_groups
        
        print(f"DEBUG: requested_user='{requested_user}', current_user='{current_user}', is_admin={is_admin}, user_groups={user_groups}")
        
        # Authorization logic
        if requested_user:
            # Specific user requested
            if not is_admin and requested_user != current_user:
                return {
                    'statusCode': 403,
                    'headers': {'Content-Type': 'application/json'},
                    'body': json.dumps({'error': 'Access denied: Cannot view other users portfolio'})
                }
            
            # Get single user portfolio
            api_key_id = get_api_key_id(requested_user)
            portfolio = get_current_portfolio(requested_user, api_key_id)
            
            if include_history:
                portfolio['history'] = get_portfolio_history(api_key_id, history_period)
            
            result = {
                'user': requested_user,
                'is_admin_view': is_admin,
                'portfolio': portfolio
            }
            
        else:
            # No user specified
            if is_admin:
                # Admin can see all users - get list from S3 config
                print("DEBUG: Admin with no user specified - getting all users")
                from s3_config_loader import get_all_enabled_users
                
                all_users = get_all_enabled_users()
                print(f"DEBUG: Found {len(all_users)} users: {all_users}")
                portfolios = []
                
                for user in all_users:
                    try:
                        api_key_id = get_api_key_id(user)
                        portfolio = get_current_portfolio(user, api_key_id)
                        if include_history:
                            portfolio['history'] = get_portfolio_history(api_key_id, history_period)
                        portfolios.append(portfolio)
                    except Exception as e:
                        print(f"Error fetching portfolio for {user}: {e}")
                
                print(f"DEBUG: Returning {len(portfolios)} portfolios")
                result = {
                    'is_admin_view': True,
                    'user_count': len(all_users),
                    'portfolios': portfolios
                }
            else:
                # Regular user sees only their own
                if not current_user:
                    return {
                        'statusCode': 401,
                        'headers': {'Content-Type': 'application/json'},
                        'body': json.dumps({'error': 'Authentication required'})
                    }
                
                api_key_id = get_api_key_id(current_user)
                portfolio = get_current_portfolio(current_user, api_key_id)
                
                if include_history:
                    portfolio['history'] = get_portfolio_history(api_key_id, history_period)
                
                result = {
                    'user': current_user,
                    'is_admin_view': False,
                    'portfolio': portfolio
                }
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps(result, cls=DecimalEncoder)
        }
        
    except Exception as e:
        print(f"Error getting portfolio: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps({'error': f'Internal server error: {str(e)}'})
        }

