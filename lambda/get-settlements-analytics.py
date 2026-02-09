"""
Lambda function to get settlement analytics from trades-v2 table.

This queries trades that have been enriched with settlement data:
- settlement_time: Unix timestamp when market settled
- settlement_result: 'yes' or 'no'
- settlement_price: 1.0 (YES won) or 0.0 (NO won)
- category: Market category (populated by TIS at settlement time)

Returns data for:
1. Trade-to-settlement table with individual trade outcomes (paginated)
2. Summary statistics
3. Aggregations by idea, category, price bucket (on all data)
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
# Use traded-market-metadata for settlement analytics - it has no TTL (unlike market-metadata which expires 2 days after settlement)
traded_market_metadata_table = dynamodb.Table(os.environ.get('TRADED_MARKET_METADATA_TABLE', 'production-kalshi-traded-market-metadata'))


class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)


def get_category_from_ticker(ticker: str) -> str:
    """
    Fallback: derive category from ticker prefix.
    Only used if trade doesn't have category field.
    """
    prefix_map = {
        'KXNBAMENTION': 'Sports', 'KXNFLMENTION': 'Sports', 'KXNCAAMENTION': 'Sports',
        'KXNBA': 'Sports', 'KXNFL': 'Sports', 'KXNHL': 'Sports', 'KXMLB': 'Sports',
        'KXNCAA': 'Sports', 'KXCFB': 'Sports', 'KXSOC': 'Sports', 'KXPGA': 'Sports',
        'KXUFC': 'Sports', 'KXMMA': 'Sports',
        'KXHIGH': 'Weather', 'KXLOW': 'Weather', 'KXRAIN': 'Weather', 'KXSNOW': 'Weather',
        'KXTRUMP': 'Politics', 'KXELECTION': 'Politics', 'KXPRES': 'Politics', 'KXGOV': 'Politics',
        'KXFED': 'Economics', 'KXCPI': 'Economics', 'KXGDP': 'Economics', 'KXJOBS': 'Economics',
        'KXBTC': 'Crypto', 'KXETH': 'Crypto', 'KXCRYPTO': 'Crypto',
        'KXSPY': 'Financials', 'KXQQQ': 'Financials', 'KXSTOCK': 'Financials', 'KXINX': 'Financials',
        'KXNETFLIX': 'Entertainment', 'KXRT': 'Entertainment', 'KXDWTS': 'Entertainment',
        'KXMENTION': 'Mentions',
    }
    
    ticker_upper = ticker.upper()
    for prefix, category in prefix_map.items():
        if ticker_upper.startswith(prefix):
            return category
    return 'Other'


def get_settled_trades(user_name: str, days: int = 30) -> List[Dict[str, Any]]:
    """Get trades with settlement data for a user"""
    
    response = trades_table.query(
        IndexName='user_name-placed_at-index',
        KeyConditionExpression='user_name = :user',
        FilterExpression='attribute_exists(settlement_time)',
        ExpressionAttributeValues={':user': user_name}
    )
    
    items = response.get('Items', [])
    
    # Handle pagination
    while 'LastEvaluatedKey' in response:
        response = trades_table.query(
            IndexName='user_name-placed_at-index',
            KeyConditionExpression='user_name = :user',
            FilterExpression='attribute_exists(settlement_time)',
            ExpressionAttributeValues={':user': user_name},
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        items.extend(response.get('Items', []))
        
    # Filter by days if not 'all'
    # Use settlement_time (when profit/loss was realized) not placed_at (when trade was made).
    # This ensures "7d" shows trades whose outcomes affected the portfolio this week,
    # matching the Weekly Performance chart which measures portfolio value change.
    if days < 365:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        cutoff_ts = int(cutoff.timestamp())
        items = [t for t in items if int(t.get('settlement_time', 0)) >= cutoff_ts]
    
    return items


def calculate_trade_outcome(trade: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Calculate outcome for a single trade"""
    
    side = trade.get('side', 'yes')
    action = trade.get('action', 'buy')
    count = int(trade.get('filled_count', 0))
    purchase_price = float(trade.get('avg_fill_price', 0))
    settlement_result = trade.get('settlement_result', '')
    settlement_price = float(trade.get('settlement_price', 0))
    settlement_time = int(trade.get('settlement_time', 0))
    placed_at = int(trade.get('placed_at', 0))
    
    # Skip sells for now (focus on buys to settlement)
    if action == 'sell':
        return None
        
    won = (side == 'yes' and settlement_result == 'yes') or \
          (side == 'no' and settlement_result == 'no')
          
    if won:
        profit_per_contract = 1.00 - purchase_price
    else:
        profit_per_contract = -purchase_price
        
    total_cost = purchase_price * count
    total_return = (1.00 if won else 0.00) * count
    total_profit = profit_per_contract * count
    
    if settlement_time > 0 and placed_at > 0:
        duration_hours = (settlement_time - placed_at) / 3600
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


def get_market_metadata_batch(market_tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Batch fetch market metadata for multiple tickers from traded-market-metadata.
    This table has no TTL, so data persists indefinitely after settlement.
    Returns dict mapping ticker to metadata (yes_bid_dollars is final bid price, title for display).
    """
    result = {}
    
    # DynamoDB BatchGetItem has a limit of 100 items per request
    batch_size = 100
    for i in range(0, len(market_tickers), batch_size):
        batch_tickers = market_tickers[i:i + batch_size]
        
        keys = [{'market_ticker': ticker} for ticker in batch_tickers]
        
        try:
            response = dynamodb.batch_get_item(
                RequestItems={
                    traded_market_metadata_table.name: {
                        'Keys': keys,
                        'ProjectionExpression': 'market_ticker, yes_bid_dollars, no_bid_dollars, title'
                    }
                }
            )
            
            for item in response.get('Responses', {}).get(traded_market_metadata_table.name, []):
                ticker = item.get('market_ticker')
                if ticker:
                    # Keep None for missing data, and treat 0 as invalid (no real bid is $0.00)
                    yes_bid = item.get('yes_bid_dollars')
                    no_bid = item.get('no_bid_dollars')
                    result[ticker] = {
                        'yes_bid_dollars': float(yes_bid) if yes_bid and float(yes_bid) > 0 else None,
                        'no_bid_dollars': float(no_bid) if no_bid and float(no_bid) > 0 else None,
                        'title': item.get('title', '')
                    }
        except Exception as e:
            print(f"Error fetching traded market metadata batch: {e}")
            # Continue without metadata for this batch
    
    return result


def aggregate_trades(trades: List[Dict], group_by: str) -> Dict[str, Any]:
    """Aggregate trades by specified dimension with enhanced metrics"""
    
    groups = defaultdict(lambda: {
        'trades': 0, 'wins': 0, 'losses': 0,
        'total_cost': 0, 'total_return': 0, 'profit': 0,
        # New metrics
        'total_contracts': 0,
        'entry_price_sum': 0,  # For calculating average
        'final_bid_sum': 0,    # For calculating average
        'final_bid_count': 0,  # Count of contracts with final bid data (for avg calculation)
        'trades_with_final_bid': 0,  # Count of trades with final bid data
        'trades_above_entry': 0,
        'trades_equal_entry': 0,
        'trades_below_entry': 0,
        'trades_final_bid_below_90': 0,
        'wins_final_bid_below_90': 0,
        'duration_sum': 0,     # For calculating average duration
    })
    
    for t in trades:
        if group_by == 'idea':
            key = t.get('idea_name', 'Unknown') or 'No Idea'
        elif group_by == 'category':
            key = t.get('category', 'Other')
        elif group_by == 'price_bucket':
            key = get_price_bucket(t.get('purchase_price', 0))
        else:
            key = 'All'
            
        g = groups[key]
        count = t.get('count', 1)
        entry_price = t.get('purchase_price', 0)
        final_bid = t.get('final_bid_price')  # May be None if no metadata
        duration = t.get('duration_hours', 0)
        
        g['trades'] += 1
        g['total_contracts'] += count
        if t['won']:
            g['wins'] += 1
        else:
            g['losses'] += 1
        g['total_cost'] += t['total_cost']
        g['total_return'] += t['total_return']
        g['profit'] += t['profit']
        
        # Entry price weighted by contracts
        g['entry_price_sum'] += entry_price * count
        
        # Duration sum
        g['duration_sum'] += duration
        
        # Final bid metrics (only if we have valid data - not None or 0)
        if final_bid is not None and final_bid > 0:
            g['final_bid_sum'] += final_bid * count
            g['final_bid_count'] += count
            g['trades_with_final_bid'] += 1
            
            # Compare final bid to entry price (with small tolerance for floating point)
            # Count TRADES, not contracts
            if final_bid > entry_price + 0.001:
                g['trades_above_entry'] += 1
            elif final_bid < entry_price - 0.001:
                g['trades_below_entry'] += 1
            else:
                g['trades_equal_entry'] += 1
            
            # Trades where final bid < 0.90
            if final_bid < 0.90:
                g['trades_final_bid_below_90'] += 1
                if t['won']:
                    g['wins_final_bid_below_90'] += 1
        
    result = {}
    for key, g in groups.items():
        total_contracts = g['total_contracts']
        final_bid_count = g['final_bid_count']
        trades_with_final_bid = g['trades_with_final_bid']
        trades_below_90 = g['trades_final_bid_below_90']
        
        result[key] = {
            'trades': g['trades'],
            'wins': g['wins'],
            'losses': g['losses'],
            'win_rate': round(g['wins'] / g['trades'] * 100, 1) if g['trades'] > 0 else 0,
            'total_cost': round(g['total_cost'], 2),
            'total_return': round(g['total_return'], 2),
            'profit': round(g['profit'], 2),
            # New metrics
            'avg_entry_price': round(g['entry_price_sum'] / total_contracts, 3) if total_contracts > 0 else 0,
            'avg_final_bid': round(g['final_bid_sum'] / final_bid_count, 3) if final_bid_count > 0 else None,
            # Renamed: trades not contracts
            'trades_above_entry': g['trades_above_entry'],
            'trades_equal_entry': g['trades_equal_entry'],
            'trades_below_entry': g['trades_below_entry'],
            # Keep old names for backward compatibility with frontend
            'contracts_above_entry': g['trades_above_entry'],
            'contracts_equal_entry': g['trades_equal_entry'],
            'contracts_below_entry': g['trades_below_entry'],
            'pct_final_bid_below_90': round(trades_below_90 / trades_with_final_bid * 100, 1) if trades_with_final_bid > 0 else None,
            'win_rate_final_bid_below_90': round(g['wins_final_bid_below_90'] / trades_below_90 * 100, 1) if trades_below_90 > 0 else None,
            'avg_duration_hours': round(g['duration_sum'] / g['trades'], 2) if g['trades'] > 0 else 0,
        }
        
    return result


def lambda_handler(event, context):
    """
    Get settlement analytics from trades-v2
    
    Query params:
    - user or user_name: Username filter
    - period or days: 7d, 30d, 90d, all (default 30d)
    - group_by: idea, category, price_bucket (for grouped stats)
    - page: Page number (1-indexed, default 1)
    - page_size: Items per page (default 100, max 500)
    - losses_only: true/false - filter to only losing trades (default false)
    """
    
    try:
        params = event.get('queryStringParameters', {}) or {}
        requested_user = params.get('user_name', params.get('user', '')).strip()
        period = params.get('period', params.get('days', '30d'))
        group_by = params.get('group_by', '')
        losses_only = params.get('losses_only', '').lower() == 'true'
        
        # Pagination params
        page = max(1, int(params.get('page', 1)))
        page_size = min(500, max(1, int(params.get('page_size', 100))))
        
        # Determine days from period
        days_map = {'7d': 7, '30d': 30, '90d': 90, 'all': 365}
        days = days_map.get(period, 30)
        
        # Get user info from Cognito
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
        
        target_user = requested_user if requested_user else current_user
        if not is_admin and target_user != current_user:
            return {
                'statusCode': 403,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'Access denied'})
            }
            
        # Get all settled trades
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
                    'page': 1,
                    'page_size': page_size,
                    'total_pages': 0,
                    'trades': [],
                    'summary': {'total_profit': 0, 'win_rate': 0, 'wins': 0, 'losses': 0}
                })
            }
        
        # Fetch market metadata for all tickers to get final bid prices
        unique_tickers = list(set(t.get('market_ticker', '') for t in trades if t.get('market_ticker')))
        market_metadata = get_market_metadata_batch(unique_tickers)
        
        # Process ALL trades for summary/grouping stats
        all_processed = []
        for trade in trades:
            outcome = calculate_trade_outcome(trade)
            if outcome is None:
                continue
                
            ticker = trade.get('market_ticker', '')
            # Read category from trade (populated by TIS) or fall back to prefix
            category = trade.get('category', '') or get_category_from_ticker(ticker)
            
            # Get final bid price from market metadata
            # Use yes_bid for YES side trades, no_bid for NO side trades
            metadata = market_metadata.get(ticker, {})
            side = outcome.get('side', 'yes')
            if side == 'yes':
                final_bid_price = metadata.get('yes_bid_dollars')
            else:
                final_bid_price = metadata.get('no_bid_dollars')
            
            all_processed.append({
                'order_id': trade.get('order_id', ''),
                'market_ticker': ticker,
                'idea_name': trade.get('idea_name', ''),
                'category': category,
                'placed_at': int(trade.get('placed_at', 0)),
                'settlement_time': int(trade.get('settlement_time', 0)),
                'final_bid_price': final_bid_price,
                **outcome
            })
        
        # Sort by settlement time descending (most recent first)
        all_processed.sort(key=lambda x: x['settlement_time'], reverse=True)
        
        # Filter for losses only if requested
        if losses_only:
            all_processed = [t for t in all_processed if not t['won']]
        
        # Calculate summary on filtered trades
        total_profit = sum(t['profit'] for t in all_processed)
        wins = sum(1 for t in all_processed if t['won'])
        losses = len(all_processed) - wins
        win_rate = (wins / len(all_processed) * 100) if all_processed else 0
        total_cost = sum(t['total_cost'] for t in all_processed)
        
        summary = {
            'total_profit': round(total_profit, 2),
            'win_rate': round(win_rate, 1),
            'wins': wins,
            'losses': losses,
            'total_cost': round(total_cost, 2),
            'total_return': round(sum(t['total_return'] for t in all_processed), 2),
            'return_pct': round((total_profit / total_cost * 100), 1) if total_cost > 0 else 0
        }
        
        # Group stats on filtered trades (skip if losses_only - not useful)
        grouped_data = None
        if not losses_only:
            grouped_data = {
                'byCategory': aggregate_trades(all_processed, 'category'),
                'byIdea': aggregate_trades(all_processed, 'idea'),
                'byPriceBucket': aggregate_trades(all_processed, 'price_bucket')
            }
        
        # Pagination - slice for response
        total_trades = len(all_processed)
        total_pages = (total_trades + page_size - 1) // page_size
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        trades_page = all_processed[start_idx:end_idx]
        
        response_body = {
            'user': target_user,
            'period': period,
            'total_trades': total_trades,
            'page': page,
            'page_size': page_size,
            'total_pages': total_pages,
            'summary': summary,
            'trades': trades_page,
        }
        
        if grouped_data:
            response_body['grouped'] = grouped_data
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps(response_body, cls=DecimalEncoder)
        }
        
    except Exception as e:
        print(f"Error in get-settlements-analytics: {e}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }
