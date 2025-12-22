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
from portfolio_fetcher import fetch_user_portfolio_from_api

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
secretsmanager = boto3.client('secretsmanager', region_name='us-east-1')
positions_table = dynamodb.Table(os.environ.get('POSITIONS_TABLE', 'production-kalshi-market-positions'))
portfolio_table = dynamodb.Table(os.environ.get('PORTFOLIO_TABLE', 'production-kalshi-portfolio-snapshots'))
market_metadata_table = dynamodb.Table(os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'))
trades_table = dynamodb.Table(os.environ.get('TRADES_TABLE', 'production-kalshi-trades-v2'))

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

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
    
    PHASE 4.6 Architecture:
    1. Try positions-live table first (WebSocket-fed, real-time)
    2. Fall back to REST API if positions-live is stale (>5 min) or unavailable
    3. Enrich with fill price history and market metadata from DynamoDB
    4. Return combined view with current state + historical context
    
    Args:
        user_name: Username to fetch portfolio for
        api_key_id: Optional API key ID (unused, kept for backward compatibility)
    
    Returns:
        Dictionary with current portfolio state + historical enrichment
    """
    
    logger.info(f"Fetching portfolio for {user_name}")
    
    # PHASE 4.6: Try positions-live as PRIMARY source
    portfolio_live = get_positions_from_live_table(user_name)
    
    # Track if positions already have metadata (from batch API call)
    has_metadata = False
    
    if portfolio_live:
        # SUCCESS: Using positions-live (WebSocket data)
        logger.info(f"✓ Using positions-live for {user_name}: {len(portfolio_live['positions'])} positions")
        cash_balance = portfolio_live['balance_dollars']
        api_positions = portfolio_live['positions']
        total_position_value = portfolio_live['total_portfolio_value'] - cash_balance
        data_source = 'positions_live'
        fetched_at = portfolio_live.get('fetched_at')
        has_metadata = portfolio_live.get('has_metadata', False)
    else:
        # FALLBACK: Use REST API via PortfolioFetcherLayer
        logger.info(f"⚠ Falling back to REST API for {user_name} (positions-live unavailable/stale)")
        try:
            portfolio_api = fetch_user_portfolio_from_api(
                user_name=user_name,
                user_secret_prefix='production/kalshi/users',
                kalshi_base_url=os.environ.get('KALSHI_API_BASE_URL', 'https://api.elections.kalshi.com'),
                rate_limiter_table_name=os.environ.get('RATE_LIMITER_TABLE_NAME', 'production-kalshi-rate-limiter'),
                market_metadata_table_name=os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'),
                logger=logger
            )
        except Exception as e:
            logger.error(f"Failed to fetch portfolio from API for {user_name}: {e}", exc_info=True)
            raise
        
        cash_balance = portfolio_api['balance_dollars']
        api_positions = portfolio_api['positions']
        total_position_value = portfolio_api['total_portfolio_value'] - cash_balance
        data_source = 'api_with_enrichment'
        fetched_at = portfolio_api.get('fetched_at')
    
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
    
    # STEP 3: Enrich positions with market metadata and fill prices
    position_details = []
    
    for ticker, position_data in api_positions.items():
        contracts = position_data['position']
        market_value = position_data['market_value']
        current_price = position_data['current_price']
        
        # Check if position already has metadata (from positions-live batch API)
        if has_metadata:
            # Use metadata from positions-live (already fetched from Kalshi API)
            position_details.append({
                'ticker': ticker,
                'contracts': int(contracts),
                'side': 'yes' if contracts > 0 else 'no',
                'fill_price': float(fill_prices.get(ticker, 0)) if fill_prices.get(ticker) else None,
                'fill_time': fill_times.get(ticker),
                'idea_name': idea_names.get(ticker),
                'current_price': float(current_price),
                'market_value': float(market_value),
                'market_title': position_data.get('market_title', ticker),
                'close_time': position_data.get('close_time', ''),
                'event_ticker': position_data.get('event_ticker', ''),
                'series_ticker': position_data.get('series_ticker', ''),
                'market_status': position_data.get('market_status', 'unknown')
            })
        else:
            # Fallback: Get market metadata from DynamoDB (slower, 1 call per ticker)
            try:
                market_response = market_metadata_table.get_item(Key={'market_ticker': ticker})
                market = market_response.get('Item', {})
                
                # Combine event and market titles
                event_title = market.get('event_title', '')
                market_title = market.get('market_title', market.get('title', ''))
                full_title = f"{event_title}: {market_title}" if event_title and market_title else (market_title or event_title or ticker)
                
                # Get market status (active, closed, settled, etc.)
                market_status = market.get('status', 'unknown')
                
                # Extract series_ticker from market ticker if not in metadata
                series = market.get('series_ticker') or (ticker.split('-')[0] if ticker else '')
                
                position_details.append({
                    'ticker': ticker,
                    'contracts': int(contracts),
                    'side': 'yes' if contracts > 0 else 'no',
                    'fill_price': float(fill_prices.get(ticker, 0)) if fill_prices.get(ticker) else None,
                    'fill_time': fill_times.get(ticker),
                    'idea_name': idea_names.get(ticker),
                    'current_price': float(current_price),
                    'market_value': float(market_value),
                    'market_title': full_title,
                    'close_time': market.get('close_time', ''),
                    'event_ticker': market.get('event_ticker', ''),
                    'series_ticker': series,
                    'market_status': market_status
                })
                
            except Exception as e:
                logger.warning(f"Failed to get metadata for {ticker}: {e}")
                # Use API data only
                # Extract series_ticker from market ticker (prefix before first dash)
                series = ticker.split('-')[0] if ticker else ''
                position_details.append({
                    'ticker': ticker,
                    'contracts': int(contracts),
                    'side': 'yes' if contracts > 0 else 'no',
                    'fill_price': float(fill_prices.get(ticker, 0)) if fill_prices.get(ticker) else None,
                    'fill_time': fill_times.get(ticker),
                    'idea_name': idea_names.get(ticker),
                    'current_price': float(current_price),
                    'market_value': float(market_value),
                    'market_title': ticker,
                    'close_time': '',
                    'event_ticker': '',
                    'series_ticker': series,
                    'market_status': 'unknown'
                })
    
    logger.info(f"🔍 POSITION COUNT - After enrichment loop: {len(position_details)} positions (has_metadata={has_metadata})")
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


def get_positions_from_live_table(user_name: str) -> Dict[str, Any]:
    """
    PHASE 4.6: Read positions from DynamoDB positions-live table as PRIMARY source
    
    Architecture:
    1. Query positions-live table for user's positions and cash balance (1 DynamoDB call)
    2. Batch fetch current prices from Kalshi API (1 API call with comma-separated tickers)
    3. Calculate market_value = abs(position) * current_price
    
    Returns:
        - None if table is unavailable, empty, or Kalshi API fails
        - Dict with balance_dollars, positions, total_portfolio_value, fetched_at if available
    """
    try:
        positions_live_table_name = os.environ.get('POSITIONS_LIVE_TABLE')
        if not positions_live_table_name:
            logger.warning(f"POSITIONS_LIVE_TABLE not configured")
            return None
        
        positions_live_table = dynamodb.Table(positions_live_table_name)
        
        # STEP 1: Query all positions for this user from positions-live
        response = positions_live_table.query(
            KeyConditionExpression='user_name = :user',
            ExpressionAttributeValues={':user': user_name}
        )
        
        live_items = response.get('Items', [])
        
        if not live_items:
            logger.warning(f"No positions-live data found for {user_name}")
            return None
        
        # Parse positions and cash balance
        raw_positions = {}  # ticker -> position_count
        cash_balance = 0.0
        freshest_update = None
        
        for item in live_items:
            market_ticker = item.get('market_ticker', '')
            updated_at = item.get('updated_at', '')
            
            # Track freshest update for logging
            if updated_at:
                try:
                    update_dt = datetime.fromisoformat(updated_at)
                    if freshest_update is None or update_dt > freshest_update:
                        freshest_update = update_dt
                except:
                    pass
            
            if market_ticker == 'CASH_BALANCE':
                # Cash balance stored in position_cost field (dollars)
                cash_balance = float(item.get('position_cost', 0))
            else:
                # Regular position
                position_count = int(item.get('position', 0))
                if position_count != 0:  # Only include non-zero positions
                    raw_positions[market_ticker] = position_count
        
        # Log data age for monitoring (but don't reject based on it)
        if freshest_update:
            now_dt = datetime.now(timezone.utc)
            staleness_minutes = (now_dt - freshest_update).total_seconds() / 60
            logger.info(f"✓ positions-live for {user_name}: {len(raw_positions)} positions, data age {staleness_minutes:.1f} min")
        
        if not raw_positions:
            # No positions, just cash
            return {
                'balance_dollars': cash_balance,
                'positions': {},
                'total_portfolio_value': cash_balance,
                'fetched_at': freshest_update.isoformat() if freshest_update else None,
                'data_source': 'positions_live',
                'has_metadata': True  # Signal that positions include metadata
            }
        
        # STEP 2: Batch fetch current prices AND metadata from Kalshi API
        market_data = fetch_market_data_batch(user_name, list(raw_positions.keys()))
        
        if market_data is None:
            logger.warning(f"Failed to fetch market data for {user_name}, falling back to API")
            return None
        
        # STEP 3: Calculate market values and include metadata
        positions = {}
        total_position_value = 0.0
        
        for ticker, position_count in raw_positions.items():
            data = market_data.get(ticker)
            
            if data is None:
                # Market not found or no price - skip it (likely settled)
                logger.debug(f"No data for {ticker}, skipping")
                continue
            
            last_price = data['price']
            
            # Calculate current_price based on position side
            if position_count > 0:
                # Long = YES contracts, use YES price
                current_price = last_price
            else:
                # Short = NO contracts, NO price = 1 - YES price
                current_price = 1.0 - last_price
            
            market_value = abs(position_count) * current_price
            
            # Include market metadata from API response
            # Extract series_ticker from market ticker (prefix before first dash)
            series = ticker.split('-')[0] if ticker else ''
            positions[ticker] = {
                'position': position_count,
                'current_price': current_price,
                'market_value': market_value,
                # Metadata from Kalshi API
                'market_title': data.get('title', ticker),
                'market_status': data.get('status', 'unknown'),
                'close_time': data.get('close_time', ''),
                'event_ticker': data.get('event_ticker', ''),
                'series_ticker': series
            }
            
            total_position_value += market_value
        
        logger.info(f"✓ positions-live complete for {user_name}: {len(positions)} positions, ${total_position_value:.2f} position value")
        
        return {
            'balance_dollars': cash_balance,
            'positions': positions,
            'total_portfolio_value': cash_balance + total_position_value,
            'fetched_at': freshest_update.isoformat() if freshest_update else None,
            'data_source': 'positions_live',
            'has_metadata': True  # Signal that positions include metadata
        }
        
    except Exception as e:
        logger.error(f"Error reading positions-live for {user_name}: {e}", exc_info=True)
        return None


def fetch_market_data_batch(user_name: str, tickers: List[str]) -> Optional[Dict[str, dict]]:
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

