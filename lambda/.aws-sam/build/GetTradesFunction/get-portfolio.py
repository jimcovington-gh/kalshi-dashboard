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
secretsmanager = boto3.client('secretsmanager', region_name='us-east-1')
positions_table = dynamodb.Table(os.environ.get('POSITIONS_TABLE', 'production-kalshi-market-positions'))
portfolio_table = dynamodb.Table(os.environ.get('PORTFOLIO_TABLE', 'production-kalshi-portfolio-snapshots'))
market_metadata_table = dynamodb.Table(os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'))
trades_table = dynamodb.Table(os.environ.get('TRADES_TABLE', 'production-kalshi-trades'))

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def get_current_portfolio(user_name: str) -> Dict[str, Any]:
    """Get current portfolio positions and values"""
    
    # Get user's api_key_id from Secrets Manager
    try:
        secret_response = secretsmanager.get_secret_value(
            SecretId=f'production/kalshi/users/{user_name}/metadata'
        )
        secret_data = json.loads(secret_response['SecretString'])
        api_key_id = secret_data['api_key_id']
    except Exception as e:
        print(f"Error getting api_key_id for user {user_name}: {e}")
        raise
    
    # Get latest portfolio snapshot for cash balance - query directly by api_key_id
    snapshot_response = portfolio_table.query(
        KeyConditionExpression='api_key_id = :api_key',
        ExpressionAttributeValues={':api_key': api_key_id},
        ScanIndexForward=False,
        Limit=1
    )
    
    snapshot = snapshot_response.get('Items', [{}])[0] if snapshot_response.get('Items') else {}
    cash_balance = float(snapshot.get('cash', 0)) / 100  # Convert cents to dollars
    
    # Get all non-zero positions
    response = positions_table.scan(
        FilterExpression='user_name = :user AND #pos <> :zero',
        ExpressionAttributeNames={
            '#pos': 'position'
        },
        ExpressionAttributeValues={
            ':user': user_name,
            ':zero': 0
        }
    )
    
    positions = response.get('Items', [])
    
    # Get all filled trades for this user to calculate average fill prices
    trades_response = trades_table.scan(
        FilterExpression='user_name = :user AND filled_count > :zero',
        ExpressionAttributeValues={
            ':user': user_name,
            ':zero': 0
        }
    )
    
    # Calculate average fill price per ticker
    fill_prices = {}
    for trade in trades_response.get('Items', []):
        ticker = trade.get('ticker')
        filled_count = int(trade.get('filled_count', 0))
        avg_fill_price = float(trade.get('avg_fill_price', 0))
        
        if ticker and filled_count > 0 and avg_fill_price > 0:
            if ticker not in fill_prices:
                fill_prices[ticker] = {'total_contracts': 0, 'total_cost': 0}
            fill_prices[ticker]['total_contracts'] += filled_count
            fill_prices[ticker]['total_cost'] += filled_count * avg_fill_price
    
    # Calculate weighted average
    for ticker in fill_prices:
        if fill_prices[ticker]['total_contracts'] > 0:
            fill_prices[ticker] = fill_prices[ticker]['total_cost'] / fill_prices[ticker]['total_contracts']
        else:
            fill_prices[ticker] = 0
    
    # Calculate current values
    total_position_value = 0
    position_details = []
    
    for pos in positions:
        ticker = pos['ticker']
        contracts = pos['position']
        
        # Get current market price and title
        try:
            market_response = market_metadata_table.get_item(Key={'market_ticker': ticker})
            market = market_response.get('Item', {})
            
            # For closed markets, use last_price; for active markets, use bid
            market_status = market.get('status', 'active')
            if market_status == 'closed':
                last_price = float(market.get('last_price_dollars', 0))
                if contracts > 0:  # YES position
                    current_price = last_price
                else:  # NO position - inverse of last YES price
                    current_price = 1 - last_price
            else:
                if contracts > 0:  # YES position
                    current_price = market.get('yes_bid_dollars', 0)
                else:  # NO position
                    current_price = market.get('no_bid_dollars', 0)
            
            position_value = abs(contracts) * current_price
            total_position_value += position_value
            
            # Combine event and market titles
            event_title = market.get('event_title', '')
            market_title = market.get('market_title', market.get('title', ''))
            full_title = f"{event_title}: {market_title}" if event_title and market_title else (market_title or event_title or ticker)
            
            # Get fill price for this ticker
            fill_price = fill_prices.get(ticker, 0)
            
            position_details.append({
                'ticker': ticker,
                'contracts': int(contracts),
                'side': 'yes' if contracts > 0 else 'no',
                'fill_price': float(fill_price) if fill_price > 0 else None,
                'current_price': float(current_price),
                'market_value': float(position_value),
                'market_title': full_title,
                'close_time': market.get('close_time', ''),
                'event_ticker': market.get('event_ticker', ''),
                'series_ticker': market.get('series_ticker', '')
            })
        except Exception as e:
            print(f"Error getting market data for {ticker}: {e}")
            fill_price = fill_prices.get(ticker, 0)
            position_details.append({
                'ticker': ticker,
                'contracts': int(contracts),
                'side': 'yes' if contracts > 0 else 'no',
                'fill_price': float(fill_price) if fill_price > 0 else None,
                'current_price': 0,
                'market_value': 0,
                'market_title': ticker,
                'close_time': '',
                'event_ticker': '',
                'series_ticker': ''
            })
    
    # Sort by market value descending
    position_details.sort(key=lambda x: x['market_value'], reverse=True)
    
    return {
        'user_name': user_name,
        'cash_balance': cash_balance,
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
        # Try preferred_username first (our custom attribute), fall back to email prefix
        current_user = claims.get('preferred_username', '')
        if not current_user:
            email = claims.get('email', '')
            current_user = email.split('@')[0] if '@' in email else claims.get('cognito:username', '')
        
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
                print("DEBUG: Admin with no user specified - getting all users")
                from s3_config_loader import get_all_enabled_users
                
                all_users = get_all_enabled_users()
                print(f"DEBUG: Found {len(all_users)} users: {all_users}")
                portfolios = []
                
                for user in all_users:
                    portfolio = get_current_portfolio(user)
                    if include_history:
                        portfolio['history'] = get_portfolio_history(user, history_limit)
                    portfolios.append(portfolio)
                
                print(f"DEBUG: Returning {len(portfolios)} portfolios")
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
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps({'error': f'Internal server error: {str(e)}'})
        }

