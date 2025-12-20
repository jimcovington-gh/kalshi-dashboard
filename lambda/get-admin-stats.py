"""
Lambda function to get admin statistics including:
- Last 5 market-capture run statistics (from CloudWatch)
- 20 most recent orders (from orders table)
- 20 most recent trades (from trades-v2 table)
- Upcoming mention events (next 24 hours)

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
cloudwatch = boto3.client('cloudwatch', region_name='us-east-1')

ORDERS_TABLE = os.environ.get('ORDERS_TABLE', 'production-kalshi-orders')
TRADES_TABLE = os.environ.get('TRADES_TABLE', 'production-kalshi-trades-v2')
MENTION_EVENTS_TABLE = os.environ.get('MENTION_EVENTS_TABLE', 'production-kalshi-mention-events')

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


def get_market_capture_runs():
    """
    Get the last 5 market-capture run statistics from CloudWatch.
    Market capture runs every 2 minutes.
    
    Fetches:
    - TotalExecutionTime (ms)
    - MarketsProcessed (count)
    """
    try:
        end_time = datetime.now(timezone.utc)
        # Look back 30 minutes to get ~15 data points (runs every 2 min)
        start_time = end_time - timedelta(minutes=30)
        
        # Get TotalExecutionTime metrics - 2 minute period to match schedule
        duration_response = cloudwatch.get_metric_statistics(
            Namespace='KalshiMarketCapture',
            MetricName='TotalExecutionTime',
            StartTime=start_time,
            EndTime=end_time,
            Period=120,  # 2 minutes
            Statistics=['Average', 'Maximum']
        )
        
        # Get MarketsProcessed metrics
        records_response = cloudwatch.get_metric_statistics(
            Namespace='KalshiMarketCapture',
            MetricName='MarketsProcessed',
            StartTime=start_time,
            EndTime=end_time,
            Period=120,  # 2 minutes
            Statistics=['Sum', 'Average']
        )
        
        # Combine metrics by timestamp
        duration_by_time = {
            dp['Timestamp'].isoformat(): {
                'duration_ms': dp.get('Average', dp.get('Maximum', 0)),
                'timestamp': dp['Timestamp'].isoformat()
            }
            for dp in duration_response.get('Datapoints', [])
        }
        
        records_by_time = {
            dp['Timestamp'].isoformat(): {
                'record_count': int(dp.get('Sum', dp.get('Average', 0)))
            }
            for dp in records_response.get('Datapoints', [])
        }
        
        # Merge the two
        runs = []
        all_times = set(duration_by_time.keys()) | set(records_by_time.keys())
        
        for ts in all_times:
            run = {
                'timestamp': ts,
                'duration_ms': duration_by_time.get(ts, {}).get('duration_ms', 0),
                'duration_sec': round(duration_by_time.get(ts, {}).get('duration_ms', 0) / 1000, 1),
                'record_count': records_by_time.get(ts, {}).get('record_count', 0)
            }
            runs.append(run)
        
        # Sort by timestamp descending and take top 5
        runs.sort(key=lambda x: x['timestamp'], reverse=True)
        return runs[:5]
        
    except Exception as e:
        logger.error(f"Error fetching market capture runs: {e}", exc_info=True)
        return []


def get_recent_orders(limit=20):
    """
    Get the most recent orders from the orders table.
    Uses full scan with pagination to ensure we get enough items.
    """
    try:
        table = dynamodb.Table(ORDERS_TABLE)
        
        # Scan with pagination to get enough orders
        all_orders = []
        scan_kwargs = {
            'ProjectionExpression': 'order_id, market_ticker, event_ticker, series_ticker, user_name, side, #a, quantity, limit_price, order_status, placed_at, idea_name',
            'ExpressionAttributeNames': {'#a': 'action'}
        }
        
        while len(all_orders) < 500:  # Get enough to find recent ones
            response = table.scan(**scan_kwargs)
            all_orders.extend(response.get('Items', []))
            
            if 'LastEvaluatedKey' not in response:
                break
            scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        
        logger.info(f"Scanned {len(all_orders)} orders total")
        
        # Sort by placed_at descending (timestamp in seconds)
        all_orders.sort(key=lambda x: int(x.get('placed_at', 0)), reverse=True)
        
        # Take top N
        recent_orders = all_orders[:limit]
        
        # Format for display
        formatted = []
        for order in recent_orders:
            placed_at = int(order.get('placed_at', 0))
            formatted.append({
                'order_id': order.get('order_id', ''),
                'market_ticker': order.get('market_ticker', ''),
                'event_ticker': order.get('event_ticker', ''),
                'series_ticker': order.get('series_ticker', ''),
                'user_name': order.get('user_name', ''),
                'side': order.get('side', ''),
                'action': order.get('action', ''),
                'quantity': int(order.get('quantity', 0)),
                'limit_price': float(order.get('limit_price', 0)),
                'order_status': order.get('order_status', ''),
                'placed_at': placed_at,
                'placed_at_iso': datetime.fromtimestamp(placed_at, tz=timezone.utc).isoformat() if placed_at else None,
                'idea_name': order.get('idea_name', '')
            })
        
        return formatted
        
    except Exception as e:
        logger.error(f"Error fetching recent orders: {e}", exc_info=True)
        return []


def get_recent_trades(limit=20):
    """
    Get the most recent trades (filled orders) from the trades-v2 table.
    Uses full scan with pagination to ensure we get enough items.
    """
    try:
        table = dynamodb.Table(TRADES_TABLE)
        
        # Scan with pagination
        all_trades = []
        scan_kwargs = {
            'ProjectionExpression': 'order_id, market_ticker, event_ticker, series_ticker, user_name, side, #a, filled_count, avg_fill_price, order_status, placed_at, completed_at, idea_name, idea_version',
            'ExpressionAttributeNames': {'#a': 'action'}
        }
        
        while len(all_trades) < 500:
            response = table.scan(**scan_kwargs)
            all_trades.extend(response.get('Items', []))
            
            if 'LastEvaluatedKey' not in response:
                break
            scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        
        logger.info(f"Scanned {len(all_trades)} trades total")
        
        # Sort by completed_at or placed_at descending
        def get_sort_key(x):
            completed = x.get('completed_at')
            placed = x.get('placed_at', 0)
            
            # Handle completed_at - could be ISO string or timestamp
            if completed:
                if isinstance(completed, str) and 'T' in completed:
                    # ISO format string - parse it
                    try:
                        return int(datetime.fromisoformat(completed.replace('Z', '+00:00')).timestamp())
                    except:
                        pass
                try:
                    return int(completed)
                except (ValueError, TypeError):
                    pass
            
            # Fall back to placed_at
            try:
                return int(placed)
            except (ValueError, TypeError):
                return 0
        
        all_trades.sort(key=get_sort_key, reverse=True)
        
        # Take top N
        recent_trades = all_trades[:limit]
        
        # Format for display
        formatted = []
        for trade in recent_trades:
            placed_at = int(trade.get('placed_at', 0)) if trade.get('placed_at') else 0
            
            # Handle completed_at - could be ISO string or timestamp
            completed_raw = trade.get('completed_at')
            completed_at = None
            if completed_raw:
                if isinstance(completed_raw, str) and 'T' in completed_raw:
                    try:
                        completed_at = int(datetime.fromisoformat(completed_raw.replace('Z', '+00:00')).timestamp())
                    except:
                        pass
                else:
                    try:
                        completed_at = int(completed_raw)
                    except (ValueError, TypeError):
                        pass
            
            formatted.append({
                'order_id': trade.get('order_id', ''),
                'market_ticker': trade.get('market_ticker', ''),
                'event_ticker': trade.get('event_ticker', ''),
                'series_ticker': trade.get('series_ticker', ''),
                'user_name': trade.get('user_name', ''),
                'side': trade.get('side', ''),
                'action': trade.get('action', ''),
                'filled_count': int(trade.get('filled_count', 0)),
                'avg_fill_price': float(trade.get('avg_fill_price', 0)),
                'total_cost': round(float(trade.get('filled_count', 0)) * float(trade.get('avg_fill_price', 0)), 2),
                'order_status': trade.get('order_status', ''),
                'placed_at': placed_at,
                'placed_at_iso': datetime.fromtimestamp(placed_at, tz=timezone.utc).isoformat() if placed_at else None,
                'completed_at': completed_at,
                'completed_at_iso': datetime.fromtimestamp(completed_at, tz=timezone.utc).isoformat() if completed_at else None,
                'idea_name': trade.get('idea_name', ''),
                'idea_version': trade.get('idea_version', '')
            })
        
        return formatted
        
    except Exception as e:
        logger.error(f"Error fetching recent trades: {e}", exc_info=True)
        return []


def get_upcoming_mention_events():
    """
    Get mention events starting in the next 24 hours.
    """
    try:
        table = dynamodb.Table(MENTION_EVENTS_TABLE)
        
        now = datetime.now(timezone.utc)
        tomorrow = now + timedelta(hours=24)
        
        # Scan for events - table should be small enough
        response = table.scan()
        items = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))
        
        # Filter to events starting in next 24 hours
        upcoming = []
        for item in items:
            start_date_str = item.get('start_date', '')
            if not start_date_str:
                continue
            
            try:
                start_date = datetime.fromisoformat(start_date_str.replace('Z', '+00:00'))
                if now <= start_date <= tomorrow:
                    upcoming.append({
                        'event_ticker': item.get('event_ticker', ''),
                        'series_ticker': item.get('series_ticker', ''),
                        'title': item.get('title', ''),
                        'sub_title': item.get('sub_title', ''),
                        'category': item.get('category', ''),
                        'start_date': start_date_str,
                        'strike_date': item.get('strike_date', ''),
                        'hours_until_start': round((start_date - now).total_seconds() / 3600, 1)
                    })
            except (ValueError, TypeError) as e:
                logger.warning(f"Could not parse start_date for {item.get('event_ticker')}: {e}")
                continue
        
        # Sort by start_date ascending (soonest first)
        upcoming.sort(key=lambda x: x['start_date'])
        
        logger.info(f"Found {len(upcoming)} upcoming mention events")
        return upcoming
        
    except Exception as e:
        logger.error(f"Error fetching upcoming mention events: {e}", exc_info=True)
        return []


def lambda_handler(event, context):
    """
    GET /admin-stats - Get admin statistics
    
    Returns:
    - market_capture_runs: Last 5 runs with duration and record count
    - recent_orders: 20 most recent orders
    - recent_trades: 20 most recent trades (filled)
    - upcoming_mention_events: Events starting in next 24 hours
    """
    
    # Check admin access
    if not is_admin(event):
        return cors_response(403, {'error': 'Admin access required'})
    
    try:
        market_capture_runs = get_market_capture_runs()
        recent_orders = get_recent_orders(20)
        recent_trades = get_recent_trades(20)
        upcoming_mention_events = get_upcoming_mention_events()
        
        return cors_response(200, {
            'market_capture_runs': market_capture_runs,
            'recent_orders': recent_orders,
            'recent_trades': recent_trades,
            'upcoming_mention_events': upcoming_mention_events
        })
        
    except Exception as e:
        logger.error(f"Error in admin stats: {e}", exc_info=True)
        return cors_response(500, {'error': str(e)})
