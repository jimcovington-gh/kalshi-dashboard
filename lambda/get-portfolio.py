"""
Lambda function to get portfolio data from DynamoDB
Supports user-specific queries and admin queries across all users
"""

import json
import boto3
from decimal import Decimal
from typing import Dict, List, Any
import os

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
positions_table = dynamodb.Table(os.environ.get('POSITIONS_TABLE', 'production-kalshi-market-positions'))
portfolio_table = dynamodb.Table(os.environ.get('PORTFOLIO_TABLE', 'production-kalshi-portfolio-snapshots'))
market_metadata_table = dynamodb.Table(os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'))

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def get_current_portfolio(user_name: str) -> Dict[str, Any]:
    """Get current portfolio positions and values"""
    
    # Get all non-zero positions
    response = positions_table.scan(
        FilterExpression='user_name = :user AND position <> :zero',
        ExpressionAttributeValues={
            ':user': user_name,
            ':zero': 0
        }
    )
    
    positions = response.get('Items', [])
    
    # Calculate current values
    total_position_value = 0
    position_details = []
    
    for pos in positions:
        ticker = pos['ticker']
        contracts = pos['position']
        
        # Get current market price
        try:
            market_response = market_metadata_table.get_item(Key={'ticker': ticker})
            market = market_response.get('Item', {})
            
            if contracts > 0:  # YES position
                current_price = market.get('yes_bid', 0)
            else:  # NO position
                current_price = market.get('no_bid', 0)
            
            position_value = abs(contracts) * current_price
            total_position_value += position_value
            
            position_details.append({
                'ticker': ticker,
                'contracts': int(contracts),
                'side': 'yes' if contracts > 0 else 'no',
                'current_price': float(current_price),
                'market_value': float(position_value),
                'market_title': market.get('title', ''),
                'close_time': market.get('close_time', '')
            })
        except Exception as e:
            print(f"Error getting market data for {ticker}: {e}")
            position_details.append({
                'ticker': ticker,
                'contracts': int(contracts),
                'side': 'yes' if contracts > 0 else 'no',
                'current_price': 0,
                'market_value': 0,
                'error': str(e)
            })
    
    # Sort by market value descending
    position_details.sort(key=lambda x: x['market_value'], reverse=True)
    
    return {
        'user_name': user_name,
        'position_count': len(positions),
        'total_position_value': float(total_position_value),
        'positions': position_details
    }

def get_portfolio_history(user_name: str, limit: int = 100) -> List[Dict[str, Any]]:
    """Get portfolio snapshot history"""
    
    response = portfolio_table.query(
        KeyConditionExpression='user_name = :user',
        ExpressionAttributeValues={':user': user_name},
        ScanIndexForward=False,  # Most recent first
        Limit=limit
    )
    
    return response.get('Items', [])

def lambda_handler(event, context):
    """
    Get portfolio data for user(s)
    
    Query params:
    - user_name: Username filter (optional for admin, returns all users if omitted)
    - include_history: Include historical snapshots (default: false)
    - history_limit: Number of historical snapshots (default: 100)
    
    Cognito claims (from authorizer):
    - username: Logged in user
    - cognito:groups: User groups (contains 'admin' for admin users)
    """
    
    try:
        # Parse query parameters
        params = event.get('queryStringParameters', {}) or {}
        requested_user = params.get('user_name', '').strip()
        include_history = params.get('include_history', 'false').lower() == 'true'
        history_limit = int(params.get('history_limit', '100'))
        
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        current_user = claims.get('cognito:username', claims.get('username', ''))
        user_groups = claims.get('cognito:groups', '').split(',') if claims.get('cognito:groups') else []
        is_admin = 'admin' in user_groups
        
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
                portfolio['history'] = get_portfolio_history(requested_user, history_limit)
            
            result = {
                'user': requested_user,
                'is_admin_view': is_admin,
                'portfolio': portfolio
            }
            
        else:
            # No user specified
            if is_admin:
                # Admin can see all users - get list from S3 config
                from s3_config_loader import get_all_enabled_users
                
                all_users = get_all_enabled_users()
                portfolios = []
                
                for user in all_users:
                    portfolio = get_current_portfolio(user)
                    if include_history:
                        portfolio['history'] = get_portfolio_history(user, history_limit)
                    portfolios.append(portfolio)
                
                result = {
                    'is_admin_view': True,
                    'user_count': len(all_users),
                    'portfolios': portfolios
                }
            else:
                # Regular user sees only their own
                portfolio = get_current_portfolio(current_user)
                
                if include_history:
                    portfolio['history'] = get_portfolio_history(current_user, history_limit)
                
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
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': f'Internal server error: {str(e)}'})
        }
