"""
Lambda function to query trades from DynamoDB (v2 table)
Supports user-specific queries and admin queries across all users
"""

import json
import boto3
from decimal import Decimal
from typing import Dict, List, Any
import os

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
trades_table = dynamodb.Table(os.environ.get('TRADES_TABLE', 'production-kalshi-trades-v2'))

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def lambda_handler(event, context):
    """
    Query trades from DynamoDB (v2 table schema)
    
    Query params:
    - ticker: Market ticker (required)
    - user_name: Username filter (required - each user sees only their trades)
    
    Cognito claims (from authorizer):
    - username: Logged in user
    - cognito:groups: User groups (contains 'admin' for admin users)
    """
    
    try:
        # Parse query parameters
        params = event.get('queryStringParameters', {}) or {}
        ticker = params.get('ticker', '').upper().strip()
        requested_user = params.get('user_name', '').strip()
        
        print(f"DEBUG: params={params}, requested_user='{requested_user}'")
        
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        # Try preferred_username first (our custom attribute), fall back to email prefix
        current_user = claims.get('preferred_username', '')
        if not current_user:
            email = claims.get('email', '')
            current_user = email.split('@')[0] if '@' in email else claims.get('cognito:username', '')
        
        user_groups = claims.get('cognito:groups', '').split(',') if claims.get('cognito:groups') else []
        is_admin = 'admin' in user_groups
        
        print(f"DEBUG: current_user='{current_user}', is_admin={is_admin}")
        
        if not ticker:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'ticker parameter is required'})
            }
        
        # Determine which user's trades to fetch
        target_user = requested_user if requested_user else current_user
        
        # Authorization logic
        if requested_user and not is_admin and requested_user != current_user:
            return {
                'statusCode': 403,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Access denied: Cannot view other users trades'})
            }
        
        # Query using market_ticker-index GSI with user filter (v2 schema)
        # This is more efficient than a full table scan
        print(f"Querying market_ticker-index for ticker={ticker}, user={target_user}")
        
        response = trades_table.query(
            IndexName='market_ticker-index',
            KeyConditionExpression='market_ticker = :ticker',
            FilterExpression='user_name = :user AND filled_count > :zero',
            ExpressionAttributeValues={
                ':ticker': ticker,
                ':user': target_user,
                ':zero': 0
            }
        )
        
        trades = response.get('Items', [])
        print(f"Found {len(trades)} trades for ticker {ticker}, user {target_user}")
        
        # Parse JSON string fields and add idea_parameters
        for trade in trades:
            if 'orderbook_snapshot' in trade and isinstance(trade['orderbook_snapshot'], str):
                try:
                    trade['orderbook_snapshot'] = json.loads(trade['orderbook_snapshot'])
                except json.JSONDecodeError:
                    print(f"Failed to parse orderbook_snapshot for trade {trade.get('order_id')}")
                    trade['orderbook_snapshot'] = None
            if 'fills' in trade and isinstance(trade['fills'], str):
                try:
                    trade['fills'] = json.loads(trade['fills'])
                except json.JSONDecodeError:
                    print(f"Failed to parse fills for trade {trade.get('order_id')}")
                    trade['fills'] = None
            # idea_parameters is already a Map in DynamoDB, will be converted to dict automatically
        
        # Sort by timestamp descending (v2 uses placed_at/completed_at)
        trades.sort(key=lambda x: x.get('completed_at', x.get('placed_at', '')), reverse=True)
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps({
                'ticker': ticker,
                'user': requested_user or current_user,
                'is_admin_view': is_admin and not requested_user,
                'count': len(trades),
                'trades': trades
            }, cls=DecimalEncoder)
        }
        
    except Exception as e:
        print(f"Error querying trades: {str(e)}")
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
