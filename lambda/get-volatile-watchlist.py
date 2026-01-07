"""
Lambda function to get volatile watchlist entries with current status.

Returns all active (watching, recovery) and recently-filled (< 120 min ago) entries
from the production-kalshi-volatile-watchlist DynamoDB table.

Also cleans up entries for inactive markets when users request the watchlist.

Admin only endpoint.
"""

import json
import boto3
from boto3.dynamodb.conditions import Key
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import os
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

WATCHLIST_TABLE = os.environ.get('WATCHLIST_TABLE', 'production-kalshi-volatile-watchlist')
MARKET_METADATA_TABLE = os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata')

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)


def get_user_groups(event):
    """Extract Cognito groups from the request context."""
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        groups_str = claims.get('cognito:groups', '')
        if groups_str:
            groups_str = groups_str.strip('[]')
            return [g.strip() for g in groups_str.replace(',', ' ').split()]
        return []
    except Exception:
        return []


def is_admin(event):
    """Check if the requesting user is an admin."""
    groups = get_user_groups(event)
    return 'admin' in groups


def cors_response(status_code, body):
    """Return a response with CORS headers."""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
            'Access-Control-Allow-Methods': 'GET,OPTIONS'
        },
        'body': json.dumps(body, cls=DecimalEncoder, default=str)
    }


import urllib.request
import urllib.error

KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2'


def get_market_metadata(market_tickers: list) -> dict:
    """
    Get market metadata for given tickers using batch_get_item.
    Returns dict mapping market_ticker -> metadata dict.
    """
    if not market_tickers:
        return {}
    
    metadata_table = dynamodb.Table(MARKET_METADATA_TABLE)
    result = {}
    
    # BatchGetItem can handle up to 100 keys at once
    for i in range(0, len(market_tickers), 100):
        batch = market_tickers[i:i+100]
        keys = [{'market_ticker': ticker} for ticker in batch]
        
        try:
            response = dynamodb.batch_get_item(
                RequestItems={
                    MARKET_METADATA_TABLE: {'Keys': keys}
                }
            )
            items = response.get('Responses', {}).get(MARKET_METADATA_TABLE, [])
            for item in items:
                result[item['market_ticker']] = item
        except Exception as e:
            logger.warning(f"Failed to batch get market metadata: {e}")
    
    return result


def get_live_market_status(market_tickers: list) -> dict:
    """
    Fetch live market status from Kalshi API.
    Returns dict mapping market_ticker -> status string.
    """
    if not market_tickers:
        return {}
    
    result = {}
    for ticker in market_tickers:
        try:
            url = f"{KALSHI_API_BASE}/markets/{ticker}"
            req = urllib.request.Request(url, headers={'User-Agent': 'kalshi-dashboard/1.0'})
            with urllib.request.urlopen(req, timeout=5) as response:
                if response.status == 200:
                    data = json.loads(response.read().decode('utf-8'))
                    result[ticker] = data.get('market', {}).get('status', 'unknown')
                else:
                    result[ticker] = 'unknown'
        except Exception as e:
            logger.warning(f"Failed to get live status for {ticker}: {e}")
            result[ticker] = 'unknown'
    
    return result


def cleanup_inactive_markets(watchlist_entries: list, live_status: dict) -> tuple:
    """
    Delete watchlist entries for markets that are no longer active.
    
    Args:
        watchlist_entries: List of watchlist items from DynamoDB
        live_status: Dict mapping ticker -> live status from Kalshi API
        
    Returns:
        Tuple of (active_entries, deleted_count)
    """
    watchlist_table = dynamodb.Table(WATCHLIST_TABLE)
    active_entries = []
    deleted_count = 0
    
    for entry in watchlist_entries:
        ticker = entry.get('market_ticker', '')
        status = live_status.get(ticker, 'unknown')
        
        # Keep entries for active markets only
        if status == 'active':
            active_entries.append(entry)
        else:
            # Delete inactive/finalized/settled market entry
            try:
                watchlist_table.delete_item(
                    Key={
                        'market_ticker': ticker,
                        'user_name': entry.get('user_name', '')
                    }
                )
                deleted_count += 1
                logger.info(f"Cleaned up watchlist entry for inactive market: {ticker} (status={status})")
            except Exception as e:
                logger.warning(f"Failed to delete watchlist entry {ticker}: {e}")
                # Keep entry if delete fails
                active_entries.append(entry)
    
    return active_entries, deleted_count


def get_volatile_watchlist_entries():
    """
    Scan all entries from volatile watchlist table.
    Returns watching entries only (recovery and filled are transient states).
    Cleans up entries for inactive markets (checks live Kalshi API status).
    Enriches with current market prices from our metadata.
    
    Returns:
        Tuple of (entries_list, cleanup_count)
        Each entry contains:
        - market_ticker: str
        - trade_side: str (YES or NO)
        - initial_price_dollars: float
        - highest_price_seen_dollars: float
        - lowest_price_seen_dollars: float  
        - current_price_dollars: float (current bid for the trade side)
        - action_trigger_price: float (price at which we'll buy)
        - added_at: str (ISO timestamp)
    """
    try:
        table = dynamodb.Table(WATCHLIST_TABLE)
        
        # Scan all entries
        response = table.scan()
        items = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))
        
        # Get unique market tickers
        all_tickers = list(set(item.get('market_ticker', '') for item in items if item.get('market_ticker')))
        
        # Fetch LIVE status from Kalshi API for cleanup check
        live_status = get_live_market_status(all_tickers)
        
        # Cleanup inactive markets based on live status
        items, cleanup_count = cleanup_inactive_markets(items, live_status)
        
        # Fetch market metadata for current prices (only for remaining active markets)
        remaining_tickers = list(set(item.get('market_ticker', '') for item in items if item.get('market_ticker')))
        market_metadata = get_market_metadata(remaining_tickers)
        
        # Filter to only watching state and organize by market_ticker
        now = datetime.now(timezone.utc)
        markets_dict = {}
        
        for item in items:
            state = item.get('state', '')
            
            # Only include watching state entries
            if state != 'watching':
                continue
            
            market_ticker = item.get('market_ticker', '')
            user_name = item.get('user_name', '')
            
            if not market_ticker:
                continue
            
            # Helper to convert Decimal to float
            def to_float(val):
                if isinstance(val, Decimal):
                    return float(val)
                return float(val) if val is not None else 0.0
            
            trade_side = item.get('trade_side', 'YES')
            initial_price = to_float(item.get('initial_price_dollars', 0))
            highest_price = to_float(item.get('highest_price_seen_dollars', 0))
            lowest_price = to_float(item.get('lowest_price_seen_dollars', 0))
            
            # Get current price from market metadata based on trade side
            metadata = market_metadata.get(market_ticker, {})
            if trade_side == 'YES':
                current_price = to_float(metadata.get('yes_bid_dollars', 0))
            else:
                current_price = to_float(metadata.get('no_bid_dollars', 0))
            
            # Extract action trigger price from volatility metrics
            # This is: highest_price - recovery_threshold (buy when price recovers to this level)
            volatility_metrics = item.get('volatility_metrics', {})
            if isinstance(volatility_metrics, Decimal):
                volatility_metrics = {}
            
            # Buy At = lowest_price_seen + buy_on_recovery_threshold (currently $0.01)
            # This is the price at which we trigger a buy after the price starts recovering
            BUY_ON_RECOVERY_THRESHOLD = 0.01  # From high-confidence.yaml
            action_price = None
            if lowest_price > 0:
                action_price = lowest_price + BUY_ON_RECOVERY_THRESHOLD
            
            # Create market entry if not exists
            if market_ticker not in markets_dict:
                markets_dict[market_ticker] = {
                    'market_ticker': market_ticker,
                    'trade_side': trade_side,
                    'initial_price_dollars': initial_price,
                    'highest_price_seen_dollars': highest_price,
                    'lowest_price_seen_dollars': lowest_price,
                    'current_price_dollars': current_price,
                    'added_at': item.get('added_at', ''),
                }
            
            # Store action trigger price if available
            if action_price is not None:
                markets_dict[market_ticker]['action_trigger_price'] = action_price
        
        # Convert to list sorted by added_at (newest first)
        result = list(markets_dict.values())
        result.sort(key=lambda x: x.get('added_at', ''), reverse=True)
        
        return result, cleanup_count
    
    except Exception as e:
        logger.error(f"Error scanning watchlist: {str(e)}")
        raise


def lambda_handler(event, context):
    """Handle GET requests to retrieve volatile watchlist."""
    
    # Check if admin
    if not is_admin(event):
        return cors_response(403, {'error': 'Access denied'})
    
    try:
        entries, cleanup_count = get_volatile_watchlist_entries()
        
        response_data = {
            'watchlist': entries,
            'count': len(entries),
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
        
        if cleanup_count > 0:
            response_data['cleaned_up'] = cleanup_count
            logger.info(f"Cleaned up {cleanup_count} entries for inactive markets")
        
        return cors_response(200, response_data)
    
    except Exception as e:
        logger.error(f"Error in lambda_handler: {str(e)}", exc_info=True)
        return cors_response(500, {'error': str(e)})
