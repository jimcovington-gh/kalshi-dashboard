"""
Lambda function to get settlement analytics from trades-v2 table.

This queries trades that have been enriched with settlement data:
- settlement_time: Unix timestamp when market settled
- settlement_result: 'yes' or 'no'
- settlement_price: 1.0 (YES won) or 0.0 (NO won)

Returns data for:
1. Trade-to-settlement table with individual trade outcomes
2. Weekly position changes
3. Aggregations by idea, category, price bucket
"""

import json
import boto3
from decimal import Decimal
from typing import Dict, List, Any, Optional
import os
from datetime import datetime, timezone, timedelta
from collections import defaultdict

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
trades_table = dynamodb.Table(os.environ.get('TRADES_TABLE', 'production-kalshi-trades-v2'))
market_metadata_table = dynamodb.Table(os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'))
secretsmanager = boto3.client('secretsmanager', region_name='us-east-1')


class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)


def get_category_from_ticker(ticker: str) -> str:
    """Derive category from ticker prefix"""
    # Common ticker prefixes
    prefix_map = {
        'KXNBA': 'NBA',
        'KXNFL': 'NFL', 
        'KXNHL': 'NHL',
        'KXMLB': 'MLB',
        'KXNCAAMB': 'NCAAMB',
        'KXNCAAFB': 'NCAAFB',
        'KXSOC': 'Soccer',
        'KXPGA': 'Golf',
        'KXUFC': 'UFC',
        'KXMMA': 'MMA',
        'KXECON': 'Economics',
        'KXFED': 'Fed/Rates',
        'KXCPI': 'Inflation',
        'KXGDP': 'GDP',
        'KXJOBS': 'Jobs',
        'KXWEATHER': 'Weather',
        'KXTEMP': 'Weather',
        'KXELECTION': 'Politics',
        'KXPRES': 'Politics',
        'KXGOV': 'Politics',
        'KXCONGRESS': 'Politics',
        'KXSENATE': 'Politics',
        'KXHOUSE': 'Politics',
        'KXCRYPTO': 'Crypto',
        'KXBTC': 'Crypto',
        'KXETH': 'Crypto',
        'KXSTOCK': 'Stocks',
        'KXSPY': 'Stocks',
        'KXQQQ': 'Stocks',
        'KXMENTION': 'Mentions',
    }
    
    ticker_upper = ticker.upper()
    for prefix, category in prefix_map.items():
        if ticker_upper.startswith(prefix):
            return category
    return 'Other'


def batch_get_categories(tickers: List[str]) -> Dict[str, str]:
    """Get categories for a list of tickers using BatchGetItem"""
    if not tickers:
        return {}
        
    unique_tickers = list(set(tickers))
    ticker_map = {}
    
    # Process in batches of 100 (DynamoDB limit)
    for i in range(0, len(unique_tickers), 100):
        batch = unique_tickers[i:i+100]
        keys = [{'market_ticker': t} for t in batch]
        
        try:
            response = dynamodb.batch_get_item(
                RequestItems={
                    market_metadata_table.name: {
                        'Keys': keys,
                        'ProjectionExpression': 'market_ticker, category'
                    }
                }
            )
            
            for item in response.get('Responses', {}).get(market_metadata_table.name, []):
                ticker = item['market_ticker']
                category = item.get('category', '').strip()
                
                # Skip invalid categories (series tickers stored incorrectly)
                if category and not category.lower().startswith('kx'):
                    ticker_map[ticker] = category.title()
                    
        except Exception as e:
            print(f"Error batch getting metadata: {e}")
            
    # Fill in missing categories from ticker prefix
    for ticker in unique_tickers:
        if ticker not in ticker_map:
            ticker_map[ticker] = get_category_from_ticker(ticker)
            
    return ticker_map


def get_settled_trades(user_name: str, days: int = 30) -> List[Dict[str, Any]]:
    """Get trades with settlement data for a user"""
    
    # Query using user_name-placed_at-index GSI
    # We want trades that have settlement_time set
    response = trades_table.query(
        IndexName='user_name-placed_at-index',
        KeyConditionExpression='user_name = :user',
        FilterExpression='attribute_exists(settlement_time)',
        ExpressionAttributeValues={
            ':user': user_name
        }
    )
    
    items = response.get('Items', [])
    
    # Handle pagination
    while 'LastEvaluatedKey' in response:
        response = trades_table.query(
            IndexName='user_name-placed_at-index',
            KeyConditionExpression='user_name = :user',
            FilterExpression='attribute_exists(settlement_time)',
            ExpressionAttributeValues={
                ':user': user_name
            },
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        items.extend(response.get('Items', []))
        
    # Filter by days if not 'all'
    if days < 365:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        cutoff_ts = int(cutoff.timestamp())  # placed_at is in seconds (Unix timestamp)
        items = [t for t in items if int(t.get('placed_at', 0)) >= cutoff_ts]
    
    return items


def calculate_trade_outcome(trade: Dict[str, Any]) -> Dict[str, Any]:
    """Calculate outcome for a single trade"""
    
    # Get trade details
    side = trade.get('side', 'yes')  # 'yes' or 'no'
    action = trade.get('action', 'buy')  # 'buy' or 'sell'
    count = int(trade.get('filled_count', 0))  # Number of contracts filled
    
    # Get purchase price - avg_fill_price is already in dollars (0.01 to 1.00 range)
    purchase_price = float(trade.get('avg_fill_price', 0))
    
    # Settlement data
    settlement_result = trade.get('settlement_result', '')  # 'yes' or 'no'
    settlement_price = float(trade.get('settlement_price', 0))  # 1.0 or 0.0
    settlement_time = int(trade.get('settlement_time', 0))
    placed_at = int(trade.get('placed_at', 0))
        
    # For sells, we're closing a position, not opening
    if action == 'sell':
        # Selling means we're exiting, use purchase price as "exit price"
        # This is complex - for now focus on buys to settlement
        return None
        
    # Calculate outcome
    # If we bought YES and market settled YES, we win $1.00 per contract
    # If we bought YES and market settled NO, we lose our purchase price
    # If we bought NO and market settled NO, we win $1.00 per contract  
    # If we bought NO and market settled YES, we lose our purchase price
    
    won = (side == 'yes' and settlement_result == 'yes') or \
          (side == 'no' and settlement_result == 'no')
          
    if won:
        # Win: receive $1.00 per contract, paid purchase_price
        profit_per_contract = 1.00 - purchase_price
    else:
        # Loss: receive $0.00, paid purchase_price
        profit_per_contract = -purchase_price
        
    total_cost = purchase_price * count
    total_return = (1.00 if won else 0.00) * count
    total_profit = profit_per_contract * count
    
    # Duration in hours (timestamps are in seconds)
    if settlement_time > 0 and placed_at > 0:
        duration_seconds = settlement_time - placed_at
        duration_hours = duration_seconds / 3600
    else:
        duration_hours = 0
        
    return {
        'won': won,
        'side': side,
        'count': count,
        'purchase_price': round(purchase_price, 2),
        'settlement_price': settlement_price,
        'total_cost': round(total_cost, 2),
        'total_return': round(total_return, 2),
        'profit': round(total_profit, 2),
        'duration_hours': round(duration_hours, 1)
    }


def get_price_bucket(price: float) -> str:
    """Categorize price into buckets"""
    if price < 0.95:
        return '<0.95'
    elif price < 0.96:
        return '0.95'
    elif price < 0.97:
        return '0.96'
    elif price < 0.98:
        return '0.97'
    elif price < 0.99:
        return '0.98'
    else:
        return '0.99+'


def lambda_handler(event, context):
    """
    Get settlement analytics from trades-v2
    
    Query params:
    - user_name: Username filter (admin only for other users)
    - period: 7d, 30d, 90d, all (default 30d)
    - group_by: idea, category, price_bucket, user (default: none - returns raw trades)
    """
    
    try:
        # Parse query parameters
        params = event.get('queryStringParameters', {}) or {}
        requested_user = params.get('user_name', '').strip()
        period = params.get('period', '30d')
        group_by = params.get('group_by', '')
        
        # Determine days
        days_map = {'7d': 7, '30d': 30, '90d': 90, 'all': 365}
        days = days_map.get(period, 30)
        
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        current_user = claims.get('preferred_username', '')
        
        if not current_user:
            return {
                'statusCode': 401,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'Authentication required'})
            }
        
        user_groups = claims.get('cognito:groups', '').split(',') if claims.get('cognito:groups') else []
        is_admin = 'admin' in user_groups
        
        # Authorization
        target_user = requested_user if requested_user else current_user
        if not is_admin and target_user != current_user:
            return {
                'statusCode': 403,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'Access denied'})
            }
            
        # Get settled trades
        trades = get_settled_trades(target_user, days)
        
        if not trades:
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'user': target_user,
                    'period': period,
                    'total_trades': 0,
                    'trades': [],
                    'summary': {
                        'total_profit': 0,
                        'win_rate': 0,
                        'wins': 0,
                        'losses': 0
                    }
                })
            }
            
        # Get categories for all tickers
        tickers = [t.get('market_ticker', '') for t in trades]
        category_map = batch_get_categories(tickers)
        
        # Process each trade
        processed_trades = []
        for trade in trades:
            outcome = calculate_trade_outcome(trade)
            if outcome is None:
                continue  # Skip sells for now
                
            ticker = trade.get('market_ticker', '')
            processed_trades.append({
                'order_id': trade.get('order_id', ''),
                'market_ticker': ticker,
                'idea_name': trade.get('idea_name', ''),
                'category': category_map.get(ticker, 'Other'),
                'placed_at': int(trade.get('placed_at', 0)),
                'settlement_time': int(trade.get('settlement_time', 0)),
                **outcome
            })
            
        # Calculate summary
        total_profit = sum(t['profit'] for t in processed_trades)
        wins = sum(1 for t in processed_trades if t['won'])
        losses = len(processed_trades) - wins
        win_rate = (wins / len(processed_trades) * 100) if processed_trades else 0
        
        summary = {
            'total_profit': round(total_profit, 2),
            'win_rate': round(win_rate, 1),
            'wins': wins,
            'losses': losses,
            'total_cost': round(sum(t['total_cost'] for t in processed_trades), 2),
            'total_return': round(sum(t['total_return'] for t in processed_trades), 2)
        }
        
        # Group if requested
        grouped_data = None
        if group_by:
            grouped_data = aggregate_trades(processed_trades, group_by)
            
        # Sort trades by settlement time descending (most recent first)
        processed_trades.sort(key=lambda x: x['settlement_time'], reverse=True)
        
        # Limit to most recent 500 trades for response size
        trades_response = processed_trades[:500]
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps({
                'user': target_user,
                'period': period,
                'total_trades': len(processed_trades),
                'summary': summary,
                'trades': trades_response,
                'grouped': grouped_data
            }, cls=DecimalEncoder)
        }
        
    except Exception as e:
        print(f"Error in get-settlements-analytics: {e}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': str(e)})
        }


def aggregate_trades(trades: List[Dict], group_by: str) -> Dict[str, Any]:
    """Aggregate trades by specified dimension"""
    
    groups = defaultdict(lambda: {
        'trades': 0,
        'wins': 0,
        'losses': 0,
        'total_cost': 0,
        'total_return': 0,
        'profit': 0
    })
    
    for t in trades:
        # Determine group key
        if group_by == 'idea':
            key = t.get('idea_name', 'Unknown') or 'No Idea'
        elif group_by == 'category':
            key = t.get('category', 'Other')
        elif group_by == 'price_bucket':
            key = get_price_bucket(t.get('purchase_price', 0))
        else:
            key = 'All'
            
        g = groups[key]
        g['trades'] += 1
        if t['won']:
            g['wins'] += 1
        else:
            g['losses'] += 1
        g['total_cost'] += t['total_cost']
        g['total_return'] += t['total_return']
        g['profit'] += t['profit']
        
    # Calculate win rates and round values
    result = {}
    for key, g in groups.items():
        result[key] = {
            'trades': g['trades'],
            'wins': g['wins'],
            'losses': g['losses'],
            'win_rate': round(g['wins'] / g['trades'] * 100, 1) if g['trades'] > 0 else 0,
            'total_cost': round(g['total_cost'], 2),
            'total_return': round(g['total_return'], 2),
            'profit': round(g['profit'], 2)
        }
        
    return result
