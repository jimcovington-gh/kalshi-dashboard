"""Lambda function to get portfolio data via TIS + DynamoDB enrichment
Supports user-specific queries and admin queries across all users

Architecture:
1. Fetch positions from TIS API (positions-live DynamoDB via Cloud Map)
2. Fetch prices + metadata from market-metadata DynamoDB
3. Enrich with historical data (fill prices from trades-v2)
4. Return combined view with current state + historical context
"""

import json
import boto3
import logging
from decimal import Decimal
from typing import Dict, List, Any, Optional
import os
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
import urllib3

# TIS endpoint - resolved via Cloud Map DNS inside VPC
TIS_ENDPOINT = os.environ.get('TIS_ENDPOINT', 'http://tis.production.local:8080')

# Connection pool (reuse across invocations)
_http = None

def get_http():
    """Get or create HTTP connection pool."""
    global _http
    if _http is None:
        _http = urllib3.PoolManager(
            timeout=urllib3.Timeout(connect=5.0, read=30.0),
            retries=urllib3.Retry(total=2, backoff_factor=0.5)
        )
    return _http


def fetch_positions_from_tis(user_name: str) -> Dict[str, Any]:
    """Fetch positions + cash balance from TIS API.
    
    Args:
        user_name: Username to fetch positions for
        
    Returns:
        Dict with 'positions' (list of position dicts) and 'cash_balance' dict
        
    Raises:
        Exception on TIS communication failure
    """
    url = f"{TIS_ENDPOINT}/v1/positions/{user_name}?include_cash=true"
    http = get_http()
    
    response = http.request('GET', url, headers={'Content-Type': 'application/json'})
    
    if response.status >= 400:
        raise Exception(f"TIS GET /v1/positions/{user_name} failed: {response.status} {response.data.decode('utf-8')[:200]}")
    
    return json.loads(response.data.decode('utf-8'))

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')
positions_table = dynamodb.Table(os.environ.get('POSITIONS_TABLE', 'production-kalshi-market-positions'))
portfolio_table = dynamodb.Table(os.environ.get('PORTFOLIO_TABLE', 'production-kalshi-portfolio-snapshots-v2'))
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


def _extract_metadata_from_item(item: Dict, ticker: str) -> Dict[str, Any]:
    """Extract metadata fields from a DynamoDB item, handling field name variations and types."""
    # close_time can be Number (epoch) or String (ISO)
    close_time_val = ''
    if 'close_time' in item:
        if 'N' in item['close_time']:
            # Convert epoch to ISO string
            try:
                epoch = int(item['close_time']['N'])
                close_time_val = datetime.fromtimestamp(epoch, timezone.utc).isoformat()
            except (ValueError, TypeError):
                close_time_val = ''
        elif 'S' in item['close_time']:
            close_time_val = item['close_time']['S']
    
    # Extract last_price_dollars for price computation
    last_price_dollars = None
    if 'last_price_dollars' in item:
        raw = item['last_price_dollars']
        if 'N' in raw:
            try:
                last_price_dollars = float(raw['N'])
            except (ValueError, TypeError):
                pass
        elif 'S' in raw:
            try:
                last_price_dollars = float(raw['S'])
            except (ValueError, TypeError):
                pass
    
    return {
        # Field is 'title' in table, we return as 'market_title'
        'market_title': item.get('title', {}).get('S', ticker),
        'event_ticker': item.get('event_ticker', {}).get('S', ''),
        'series_ticker': item.get('series_ticker', {}).get('S', ''),
        # Field is 'status' in table, we return as 'market_status'
        'market_status': item.get('status', {}).get('S', 'unknown'),
        # Market result: 'yes' or 'no' if determined/settled, empty otherwise
        'result': item.get('result', {}).get('S', ''),
        'close_time': close_time_val,
        'strike': item.get('strike', {}).get('S', ''),
        'last_price_dollars': last_price_dollars
    }


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
                        # Use actual field names from table: title, status (not market_title, market_status)
                        'ProjectionExpression': 'market_ticker, title, event_ticker, series_ticker, #s, close_time, strike, last_price_dollars',
                        'ExpressionAttributeNames': {'#s': 'status'}  # 'status' is reserved word
                    }
                }
            )
            
            # Process returned items
            items = response.get('Responses', {}).get(MARKET_METADATA_TABLE_NAME, [])
            for item in items:
                ticker = item.get('market_ticker', {}).get('S', '')
                if ticker:
                    result[ticker] = _extract_metadata_from_item(item, ticker)
            
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
                            'ProjectionExpression': 'market_ticker, title, event_ticker, series_ticker, #s, close_time, strike, last_price_dollars',
                            'ExpressionAttributeNames': {'#s': 'status'}
                        }
                    }
                )
                
                retry_items = retry_response.get('Responses', {}).get(MARKET_METADATA_TABLE_NAME, [])
                for item in retry_items:
                    ticker = item.get('market_ticker', {}).get('S', '')
                    if ticker:
                        result[ticker] = _extract_metadata_from_item(item, ticker)
                
                unprocessed = retry_response.get('UnprocessedKeys', {}).get(MARKET_METADATA_TABLE_NAME, {}).get('Keys', [])
            
            if unprocessed:
                logger.error(f"Failed to fetch {len(unprocessed)} keys after retries")
                
        except Exception as e:
            logger.error(f"batch_get_item failed for batch starting at index {i}: {e}")
            # Continue with next batch rather than failing entirely
            continue
    
    return result


def get_users_from_tis() -> List[str]:
    """Get list of active users from TIS status endpoint."""
    try:
        url = f"{TIS_ENDPOINT}/v1/status"
        http = get_http()
        response = http.request('GET', url, headers={'Content-Type': 'application/json'})
        if response.status >= 400:
            logger.error(f"TIS /v1/status failed: {response.status}")
            return []
        data = json.loads(response.data.decode('utf-8'))
        return data.get('monitors', {}).get('users', [])
    except Exception as e:
        logger.error(f"Failed to get users from TIS: {e}")
        return []


def get_current_portfolio(user_name: str) -> Dict[str, Any]:
    """
    Get current portfolio positions and values via TIS + market-metadata.
    
    Architecture:
    1. TIS /v1/positions/{user} -> raw positions + cash from positions-live DynamoDB
    2. market-metadata DynamoDB -> prices (last_price_dollars) + display fields
    3. trades-v2 DynamoDB -> fill prices, fill times, idea names
    
    Args:
        user_name: Username to fetch portfolio for
    
    Returns:
        Dictionary with current portfolio state + historical enrichment
    """
    
    logger.info(f"Fetching portfolio for {user_name}")
    
    # STEP 1: Get positions + cash from TIS
    try:
        tis_data = fetch_positions_from_tis(user_name)
    except Exception as e:
        logger.error(f"Failed to fetch positions from TIS for {user_name}: {e}", exc_info=True)
        raise
    
    # Parse TIS response
    cash_balance = 0.0
    if tis_data.get('cash_balance'):
        cash_balance = float(tis_data['cash_balance'].get('balance_dollars', 0))
    
    # Build raw positions dict: ticker -> position_count
    # Also capture market_status from positions-live (TIS returns this from DynamoDB)
    raw_positions = {}
    positions_live_status = {}  # ticker -> market_status from positions-live table
    for pos in tis_data.get('positions', []):
        ticker = pos.get('market_ticker', '')
        position_count = int(pos.get('position', 0))
        if ticker and position_count != 0:
            raw_positions[ticker] = position_count
            positions_live_status[ticker] = pos.get('market_status', '')
    
    data_source = 'tis'
    fetched_at = tis_data.get('timestamp', datetime.now(timezone.utc).isoformat())
    
    logger.info(f"🔍 POSITION COUNT - Got {len(raw_positions)} positions for {user_name} from TIS, cash=${cash_balance:.2f}")
    
    # STEP 1.5: Get fill prices AND fill times by querying each ticker in parallel
    def query_ticker_fill_data(ticker: str) -> tuple:
        """Query fill price and fill time for a single ticker using market_ticker-index.
        Returns (ticker, avg_fill_price, most_recent_fill_time, idea_name)
        
        Calculates volume-weighted average price (VWAP) from individual fills
        across all trades for accurate pricing when multiple fills at different prices."""
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
                # Calculate VWAP from individual fills for accuracy
                # Each fill has 'price' and 'count' fields
                total_contracts = 0
                total_cost = 0.0
                
                for trade in items:
                    fills = trade.get('fills', [])
                    if fills:
                        # Calculate from individual fills (most accurate)
                        for fill in fills:
                            if isinstance(fill, dict):
                                count = int(fill.get('count', 0))
                                price = float(fill.get('price', 0))
                                total_contracts += count
                                total_cost += count * price
                    else:
                        # Fallback to trade-level avg_fill_price if no fills array
                        count = int(trade.get('filled_count', 0))
                        price = float(trade.get('avg_fill_price', 0))
                        total_contracts += count
                        total_cost += count * price
                
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
                    # Round to 3 decimal places (tenth of a cent)
                    vwap = round(total_cost / total_contracts, 3)
                    return ticker, vwap, most_recent_fill, idea_name
            return ticker, None, None, None
        except Exception as e:
            logger.warning(f"Failed to query fill data for {ticker}: {e}")
            return ticker, None, None, None
    
    # Query fill data in parallel (10 workers provides good balance)
    fill_prices = {}
    fill_times = {}
    idea_names = {}
    tickers_to_query = list(raw_positions.keys())
    
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
    
    # STEP 2: Batch fetch market metadata + prices from DynamoDB
    # This single batch fetch provides both display fields AND last_price_dollars for price computation
    market_metadata = {}
    if tickers_to_query:
        try:
            market_metadata = batch_get_market_metadata(tickers_to_query)
            logger.info(f"Batch fetched metadata for {len(market_metadata)}/{len(tickers_to_query)} tickers")
        except Exception as e:
            logger.warning(f"Failed to batch fetch market metadata: {e}")
            market_metadata = {}
    
    # STEP 3: Compute prices and enrich positions
    position_details = []
    total_position_value = 0.0
    settled_positions_skipped = 0
    
    for ticker, position_count in raw_positions.items():
        contracts = position_count
        
        # Get metadata + price from batch lookup
        metadata = market_metadata.get(ticker, {})
        series = metadata.get('series_ticker') or (ticker.split('-')[0] if ticker else '')
        
        # Compute current_price from last_price_dollars
        # If market has a result (determined/settled), use $1.00 or $0.00
        market_result = metadata.get('result', '')
        # Use positions-live market_status as primary (TIS syncs from Kalshi API),
        # fall back to market-metadata status. This is critical because market-metadata
        # may show 'closed' while positions-live correctly shows 'finalized'/'settled'.
        market_status = positions_live_status.get(ticker, '') or metadata.get('market_status', 'unknown')
        side = 'yes' if contracts > 0 else 'no'
        
        # CRITICAL FIX: If market is finalized/settled, the settlement payout is
        # ALREADY included in cash_balance. Including these positions in
        # total_position_value would double-count them. Value them at $0 for the
        # total, but still show them in the positions list for visibility.
        if market_status in ('finalized', 'settled'):
            current_price = 0.0
            market_value = 0.0
            settled_positions_skipped += 1
        elif market_result in ('yes', 'no') and market_status in ('determined',):
            # Result is known but not yet settled: position is worth $1 if we're on the winning side, $0 otherwise
            current_price = 1.0 if market_result == side else 0.0
            market_value = abs(contracts) * current_price
            total_position_value += market_value
        else:
            last_price = metadata.get('last_price_dollars')
            if last_price is not None and last_price > 0:
                if contracts > 0:
                    current_price = last_price  # YES side
                else:
                    current_price = 1.0 - last_price  # NO side
            else:
                # Fallback: midpoint estimate if no price data
                current_price = 0.5
                logger.warning(f"No price data for {ticker} in market-metadata, using 0.5 estimate")
            market_value = abs(contracts) * current_price
            total_position_value += market_value
        
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
            'market_status': market_status,
            'result': metadata.get('result', ''),
            'strike': metadata.get('strike', '')
        })

    
    logger.info(f"🔍 POSITION COUNT - After enrichment loop: {len(position_details)} positions")
    if settled_positions_skipped > 0:
        logger.info(f"🔍 SETTLED POSITIONS: {settled_positions_skipped} positions valued at $0 (settlement already in cash)")
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
        'data_source': data_source,  # 'tis'
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


def get_portfolio_history(user_name: str, period: str = '24h') -> List[Dict[str, Any]]:
    """Get portfolio snapshot history with efficient time-bucket sampling.
    
    Queries portfolio-snapshots-v2 table by user_name (partition key).
    Instead of fetching all records and downsampling (slow for large datasets),
    we query one record per time bucket directly from DynamoDB.
    """
    
    now = datetime.now(timezone.utc)
    
    # Define time buckets based on period
    if period == '7d':
        start_time = now - timedelta(days=7)
        bucket_delta = timedelta(hours=1)  # ~168 buckets
    elif period == '30d':
        start_time = now - timedelta(days=30)
        bucket_delta = timedelta(hours=6)  # ~120 buckets (every 6 hours)
    elif period == 'all':
        start_time = now - timedelta(days=365)
        bucket_delta = timedelta(days=1)  # ~365 buckets
    else:  # Default to 24h
        start_time = now - timedelta(hours=24)
        bucket_delta = timedelta(minutes=15)  # ~96 buckets

    # Generate time bucket boundaries
    buckets = []
    bucket_end = start_time + bucket_delta
    while bucket_end <= now:
        buckets.append(bucket_end)
        bucket_end += bucket_delta
    # Always include "now" as the last bucket
    if not buckets or buckets[-1] < now - timedelta(minutes=5):
        buckets.append(now)
    
    logger.info(f"Portfolio history: period={period}, buckets={len(buckets)}")
    
    # Query one record per bucket (the latest record before each bucket boundary)
    # Use batched queries for efficiency
    items = []
    
    for bucket_time in buckets:
        bucket_ts = int(bucket_time.timestamp() * 1000)
        prev_bucket_ts = int((bucket_time - bucket_delta).timestamp() * 1000)
        
        try:
            # Query for the latest record in this bucket (scan backwards, limit 1)
            response = portfolio_table.query(
                KeyConditionExpression='user_name = :uname AND snapshot_ts BETWEEN :start_ts AND :end_ts',
                ExpressionAttributeValues={
                    ':uname': user_name,
                    ':start_ts': prev_bucket_ts,
                    ':end_ts': bucket_ts
                },
                ScanIndexForward=False,  # Newest first
                Limit=1
            )
            
            if response.get('Items'):
                items.append(response['Items'][0])
        except Exception as e:
            logger.warning(f"Error querying bucket {bucket_time}: {e}")
            continue
    
    if not items:
        # Fallback: try a simple limited query if bucket queries returned nothing
        logger.info("Bucket queries returned no results, trying fallback")
        start_ts = int(start_time.timestamp() * 1000)
        response = portfolio_table.query(
            KeyConditionExpression='user_name = :uname AND snapshot_ts >= :start_ts',
            ExpressionAttributeValues={
                ':uname': user_name,
                ':start_ts': start_ts
            },
            Limit=200  # Cap at 200 records for fallback
        )
        items = response.get('Items', [])
    
    # Sort by timestamp ascending
    items.sort(key=lambda x: int(x['snapshot_ts']))
    
    logger.info(f"Portfolio history returning {len(items)} records")
    return items

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
            portfolio = get_current_portfolio(requested_user)
            
            if include_history:
                portfolio['history'] = get_portfolio_history(requested_user, history_period)
            
            result = {
                'user': requested_user,
                'is_admin_view': is_admin,
                'portfolio': portfolio
            }
            
        else:
            # No user specified
            if is_admin:
                # Admin can see all users - get list from TIS
                print("DEBUG: Admin with no user specified - getting all users")
                all_users = get_users_from_tis()
                print(f"DEBUG: Found {len(all_users)} users: {all_users}")
                portfolios = []
                
                for user in all_users:
                    try:
                        portfolio = get_current_portfolio(user)
                        if include_history:
                            portfolio['history'] = get_portfolio_history(user, history_period)
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
                
                portfolio = get_current_portfolio(current_user)
                
                if include_history:
                    portfolio['history'] = get_portfolio_history(current_user, history_period)
                
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

