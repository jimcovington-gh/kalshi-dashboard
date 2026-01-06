"""
Lambda function to get volatile watchlist entries with current status.

Returns all active (watching, recovery) and recently-filled (< 120 min ago) entries
from the production-kalshi-volatile-watchlist DynamoDB table.

Admin only endpoint.
"""

import json
import boto3
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import os
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

WATCHLIST_TABLE = os.environ.get('WATCHLIST_TABLE', 'production-kalshi-volatile-watchlist')

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


def get_volatile_watchlist_entries():
    """
    Scan all entries from volatile watchlist table.
    Returns watching, recovery, and recently-filled entries (< 120 min old).
    Groups entries by market_ticker.
    
    Returns:
        Dict with markets as keys, each containing:
        - market_ticker: str
        - trade_side: str (YES or NO)
        - initial_price_dollars: float
        - highest_price_seen_dollars: float
        - lowest_price_seen_dollars: float
        - current_price_dollars: float (last tracked)
        - action_trigger_price: float (from volatility_metrics if available)
        - added_at: str (ISO timestamp)
        - entries: List of per-user entries with shares
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
        
        # Filter and organize by market_ticker
        now = datetime.now(timezone.utc)
        filled_cutoff = now - timedelta(minutes=120)
        
        markets_dict = {}
        
        for item in items:
            state = item.get('state', '')
            
            # Include watching, recovery, and recently-filled entries
            if state not in ['watching', 'recovery', 'filled']:
                continue
            
            # If filled, check if within 120 minute window
            if state == 'filled':
                filled_at_str = item.get('filled_at')
                if filled_at_str:
                    try:
                        filled_at = datetime.fromisoformat(filled_at_str.replace('Z', '+00:00'))
                        if filled_at < filled_cutoff:
                            continue  # Skip old filled entries
                    except:
                        continue
                else:
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
            
            initial_price = to_float(item.get('initial_price_dollars', 0))
            highest_price = to_float(item.get('highest_price_seen_dollars', 0))
            lowest_price = to_float(item.get('lowest_price_seen_dollars', 0))
            
            # Create market entry if not exists
            if market_ticker not in markets_dict:
                markets_dict[market_ticker] = {
                    'market_ticker': market_ticker,
                    'trade_side': item.get('trade_side', ''),
                    'initial_price_dollars': initial_price,
                    'highest_price_seen_dollars': highest_price,
                    'lowest_price_seen_dollars': lowest_price,
                    'added_at': item.get('added_at', ''),
                    'state': state,
                    'entries': [],  # Per-user entries
                    'user_count': 0
                }
            
            # Extract action trigger price from volatility metrics if available
            volatility_metrics = item.get('volatility_metrics', {})
            if isinstance(volatility_metrics, Decimal):
                volatility_metrics = {}
            
            action_price = None
            if volatility_metrics:
                # Get the dip amount from metrics
                dip_amount = volatility_metrics.get('max_dip_dollars')
                if dip_amount:
                    dip_amount = to_float(dip_amount)
                    if dip_amount > 0:
                        action_price = initial_price - dip_amount
            
            # Add per-user entry
            entry = {
                'user_name': user_name,
                'state': state,
                'filled_at': item.get('filled_at'),
                'fill_price_dollars': to_float(item.get('fill_price_dollars')) if item.get('fill_price_dollars') else None,
            }
            
            markets_dict[market_ticker]['entries'].append(entry)
            markets_dict[market_ticker]['user_count'] = len(set([e['user_name'] for e in markets_dict[market_ticker]['entries']]))
            
            # Store action trigger price if available
            if action_price is not None:
                markets_dict[market_ticker]['action_trigger_price'] = action_price
        
        # Convert to list sorted by added_at (newest first)
        result = list(markets_dict.values())
        result.sort(key=lambda x: x.get('added_at', ''), reverse=True)
        
        return result
    
    except Exception as e:
        logger.error(f"Error scanning watchlist: {str(e)}")
        raise


def lambda_handler(event, context):
    """Handle GET requests to retrieve volatile watchlist."""
    
    # Check if admin
    if not is_admin(event):
        return cors_response(403, {'error': 'Access denied'})
    
    try:
        entries = get_volatile_watchlist_entries()
        
        return cors_response(200, {
            'watchlist': entries,
            'count': len(entries),
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
    
    except Exception as e:
        logger.error(f"Error in lambda_handler: {str(e)}", exc_info=True)
        return cors_response(500, {'error': str(e)})
