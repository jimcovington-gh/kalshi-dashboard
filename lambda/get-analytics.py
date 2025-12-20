"""
Lambda function to get analytics data (PnL by category, etc.)
"""

import json
import boto3
from decimal import Decimal
from typing import Dict, List, Any
import os
from datetime import datetime, timezone, timedelta
from collections import defaultdict

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
settlements_table = dynamodb.Table(os.environ.get('SETTLEMENTS_TABLE', 'production-kalshi-settlements'))
market_metadata_table = dynamodb.Table(os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'))
secretsmanager = boto3.client('secretsmanager', region_name='us-east-1')

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def get_api_key_id(user_name: str) -> str:
    """Helper to get api_key_id for a user"""
    try:
        secret_response = secretsmanager.get_secret_value(
            SecretId=f'production/kalshi/users/{user_name}/metadata'
        )
        secret_data = json.loads(secret_response['SecretString'])
        return secret_data['api_key_id']
    except Exception as e:
        print(f"Error getting api_key_id for user {user_name}: {e}")
        raise

def get_settlements(api_key_id: str, days: int = 30) -> List[Dict[str, Any]]:
    """Get settlements for the last N days"""
    
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(days=days)
    # Use timestamp for the GSI
    start_ts = int(start_time.timestamp())
    
    # Query using GSI: UserSettlementIndex (api_key_id, settled_time_ts)
    response = settlements_table.query(
        IndexName='UserSettlementIndex',
        KeyConditionExpression='api_key_id = :api_key AND settled_time_ts >= :start_ts',
        ExpressionAttributeValues={
            ':api_key': api_key_id,
            ':start_ts': start_ts
        }
    )
    
    return response.get('Items', [])

def batch_get_categories(tickers: List[str]) -> Dict[str, str]:
    """Get categories for a list of tickers using BatchGetItem"""
    
    if not tickers:
        return {}
        
    # Deduplicate
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
                        'ProjectionExpression': 'market_ticker, category, series_ticker'
                    }
                }
            )
            
            for item in response.get('Responses', {}).get(market_metadata_table.name, []):
                ticker = item['market_ticker']
                category = item.get('category', '').strip()
                
                # Filter out series ticker codes that got incorrectly stored as categories
                # These always start with 'kx' (case-insensitive)
                if category and category.lower().startswith('kx'):
                    category = 'Unknown'
                
                # If still no valid category
                if not category or category.lower() == 'unknown':
                    category = 'Unknown'
                else:
                    # Normalize category names to Title Case for consistency
                    category = category.title()
                    
                ticker_map[ticker] = category
                
        except Exception as e:
            print(f"Error batch getting metadata: {e}")
            
    return ticker_map

def lambda_handler(event, context):
    """
    Get analytics data
    
    Query params:
    - user_name: Username filter
    - period: 7d, 30d, 90d, all (default 30d)
    """
    
    try:
        # Parse query parameters
        params = event.get('queryStringParameters', {}) or {}
        requested_user = params.get('user_name', '').strip()
        period = params.get('period', '30d')
        
        # Determine days
        days = 30
        if period == '7d': days = 7
        elif period == '90d': days = 90
        elif period == 'all': days = 365
        
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
        
        # Authorization
        target_user = requested_user if requested_user else current_user
        if not is_admin and target_user != current_user:
            return {
                'statusCode': 403,
                'body': json.dumps({'error': 'Access denied'})
            }
            
        # 1. Get Settlements
        api_key_id = get_api_key_id(target_user)
        settlements = get_settlements(api_key_id, days)
        
        if not settlements:
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'user': target_user,
                    'period': period,
                    'total_pnl': 0,
                    'categories': []
                })
            }
            
        # 2. Get Categories
        tickers = [s['ticker'] for s in settlements]
        category_map = batch_get_categories(tickers)
        
        # 3. Aggregate PnL
        category_stats = defaultdict(lambda: {'pnl': 0, 'volume': 0, 'trades': 0, 'wins': 0})
        total_pnl = 0
        
        for s in settlements:
            ticker = s['ticker']
            category = category_map.get(ticker, 'Other')
            
            # Calculate PnL manually as 'value' field is unreliable
            revenue = float(s.get('revenue', 0))
            cost = float(s.get('yes_total_cost', 0)) + float(s.get('no_total_cost', 0))
            fees = float(s.get('fee_cost', 0) or 0)
            
            # Convert cents to dollars
            pnl = (revenue - cost) / 100 - fees
            volume = cost / 100
            
            category_stats[category]['pnl'] += pnl
            category_stats[category]['volume'] += volume
            category_stats[category]['trades'] += 1
            if pnl > 0:
                category_stats[category]['wins'] += 1
                
            total_pnl += pnl
            
        # Format results
        categories = []
        for cat, stats in category_stats.items():
            categories.append({
                'name': cat,
                'pnl': round(stats['pnl'], 2),
                'volume': round(stats['volume'], 2),
                'trades': stats['trades'],
                'win_rate': round(stats['wins'] / stats['trades'] * 100, 1) if stats['trades'] > 0 else 0
            })
            
        # Sort by PnL descending
        categories.sort(key=lambda x: x['pnl'], reverse=True)
        
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
                'total_pnl': round(total_pnl, 2),
                'categories': categories
            }, cls=DecimalEncoder)
        }
        
    except Exception as e:
        print(f"Error in get-analytics: {e}")
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
