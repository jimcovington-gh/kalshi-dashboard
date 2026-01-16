"""
Lambda function to get high-confidence volatile orders from the last 24 hours.

Queries the trades-v2 table using the idea_name-index GSI for efficient lookups.
Returns orders with idea_name = "high-confidence:volatile".

Admin only endpoint.
"""

import json
import boto3
from boto3.dynamodb.conditions import Key, Attr
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import os
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

TRADES_TABLE = os.environ.get('TRADES_TABLE', 'production-kalshi-trades-v2')


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


def get_volatile_orders(hours: int = 24) -> list:
    """
    Get volatile orders from the last N hours.
    Uses idea_name-index GSI for efficient querying.
    """
    try:
        table = dynamodb.Table(TRADES_TABLE)
        
        # Calculate cutoff timestamp (epoch seconds)
        cutoff_time = datetime.now(timezone.utc) - timedelta(hours=hours)
        cutoff_epoch = int(cutoff_time.timestamp())
        
        # Query using the idea_name-index GSI
        # This is efficient - partitions by idea_name
        response = table.query(
            IndexName='idea_name-index',
            KeyConditionExpression=Key('idea_name').eq('high-confidence:volatile'),
            FilterExpression=Attr('placed_at').gte(cutoff_epoch),
            ScanIndexForward=False,  # Most recent first
        )
        
        items = response.get('Items', [])
        
        # Handle pagination if needed (unlikely with 24h window)
        while 'LastEvaluatedKey' in response:
            response = table.query(
                IndexName='idea_name-index',
                KeyConditionExpression=Key('idea_name').eq('high-confidence:volatile'),
                FilterExpression=Attr('placed_at').gte(cutoff_epoch),
                ScanIndexForward=False,
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response.get('Items', []))
        
        logger.info(f"Found {len(items)} volatile orders in last {hours} hours")
        
        # Format for display
        formatted = []
        for order in items:
            placed_at = int(order.get('placed_at', 0))
            filled_count = int(order.get('filled_count', 0))
            avg_fill_price = float(order.get('avg_fill_price', 0))
            
            # Extract key fields
            formatted.append({
                'order_id': order.get('order_id', ''),
                'market_ticker': order.get('market_ticker', ''),
                'user_name': order.get('user_name', ''),
                'side': order.get('side', ''),
                'action': order.get('action', ''),
                'order_status': order.get('order_status', ''),
                'filled_count': filled_count,
                'avg_fill_price': avg_fill_price,
                'placed_at': placed_at,
                'placed_at_iso': datetime.fromtimestamp(placed_at, tz=timezone.utc).isoformat() if placed_at else None,
                'idea_version': order.get('idea_version', ''),
                # Include recovery parameters if present
                'idea_parameters': order.get('idea_parameters', {}),
            })
        
        # Sort by placed_at descending
        formatted.sort(key=lambda x: x['placed_at'], reverse=True)
        
        return formatted
        
    except Exception as e:
        logger.error(f"Error fetching volatile orders: {e}", exc_info=True)
        return []


def handler(event, context):
    """Lambda handler for getting volatile orders."""
    
    # Handle CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return cors_response(200, {})
    
    # Check admin access
    if not is_admin(event):
        return cors_response(403, {'error': 'Admin access required'})
    
    try:
        # Get optional hours parameter (default 24)
        params = event.get('queryStringParameters') or {}
        hours = int(params.get('hours', 24))
        hours = min(hours, 168)  # Cap at 7 days max
        
        orders = get_volatile_orders(hours)
        
        return cors_response(200, {
            'orders': orders,
            'count': len(orders),
            'hours': hours,
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
        
    except Exception as e:
        logger.error(f"Error in handler: {e}", exc_info=True)
        return cors_response(500, {'error': str(e)})
