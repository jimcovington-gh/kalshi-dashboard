"""
Lambda function to get portfolio data using PortfolioFetcherLayer + DynamoDB enrichment
Supports user-specific queries and admin queries across all users

Architecture:
1. Fetch fresh portfolio from Kalshi API via PortfolioFetcherLayer
2. Enrich with historical data (fill prices from trades, market titles, etc.)
3. Return combined view with current state + historical context
"""

import json
import boto3
import logging
from decimal import Decimal
from typing import Dict, List, Any
import os
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
from portfolio_fetcher import fetch_user_portfolio_from_api

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
secretsmanager = boto3.client('secretsmanager', region_name='us-east-1')
positions_table = dynamodb.Table(os.environ.get('POSITIONS_TABLE', 'production-kalshi-market-positions'))
portfolio_table = dynamodb.Table(os.environ.get('PORTFOLIO_TABLE', 'production-kalshi-portfolio-snapshots'))
market_metadata_table = dynamodb.Table(os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'))
trades_table = dynamodb.Table(os.environ.get('TRADES_TABLE', 'production-kalshi-trades-v2'))

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def get_api_key_id(user_name: str) -> str:
    """Helper to get api_key_id for a user (used for portfolio history queries)"""
    try:
        secret_response = secretsmanager.get_secret_value(
            SecretId=f'production/kalshi/users/{user_name}/metadata'
        )
        secret_data = json.loads(secret_response['SecretString'])
        return secret_data['api_key_id']
    except Exception as e:
        logger.error(f"Error getting api_key_id for user {user_name}: {e}")
        raise

def get_current_portfolio(user_name: str, api_key_id: str = None) -> Dict[str, Any]:
    """
    Get current portfolio positions and values using PortfolioFetcherLayer + DynamoDB enrichment
    
    Architecture:
    1. Fetch fresh portfolio from Kalshi API (current positions & balance)
    2. Query DynamoDB trades table for fill price history
    3. Query DynamoDB metadata table for market titles and context
    4. Combine API data with historical enrichment
    
    Args:
        user_name: Username to fetch portfolio for
        api_key_id: Optional API key ID (unused, kept for backward compatibility)
    
    Returns:
        Dictionary with current portfolio state + historical enrichment
    """
    
    logger.info(f"Fetching portfolio for {user_name} using PortfolioFetcherLayer")
    
    # STEP 1: Fetch fresh portfolio from Kalshi API via layer
    try:
        portfolio_api = fetch_user_portfolio_from_api(
            user_name=user_name,
            user_secret_prefix='production/kalshi/users',  # Will construct 'production/kalshi/users/{user}/metadata'
            kalshi_base_url=os.environ.get('KALSHI_API_BASE_URL', 'https://api.elections.kalshi.com'),
            rate_limiter_table_name=os.environ.get('RATE_LIMITER_TABLE_NAME', 'production-kalshi-rate-limiter'),
            market_metadata_table_name=os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata'),
            logger=logger
        )
    except Exception as e:
        logger.error(f"Failed to fetch portfolio from API for {user_name}: {e}", exc_info=True)
        raise
    
    cash_balance = portfolio_api['balance_dollars']
    api_positions = portfolio_api['positions']  # Dict[ticker, {position, current_price, market_value}]
    total_position_value = portfolio_api['total_portfolio_value'] - cash_balance
    
    logger.info(f"🔍 POSITION COUNT - Layer returned {len(api_positions)} positions for {user_name}")
    logger.info(f"🔍 LAYER TICKERS: {sorted(list(api_positions.keys()))}")
    
    # STEP 2: Get fill prices by querying each ticker in parallel (avoids pagination issues)
    def query_ticker_fill_price(ticker: str) -> tuple:
        """Query fill price for a single ticker using market_ticker-index"""
        try:
            response = trades_table.query(
                IndexName='market_ticker-index',
                KeyConditionExpression='market_ticker = :ticker',
                FilterExpression='user_name = :user AND filled_count > :zero',
                ExpressionAttributeValues={
                    ':ticker': ticker,
                    ':user': user_name,
                    ':zero': 0
                }
            )
            items = response.get('Items', [])
            if items:
                total_contracts = sum(int(t.get('filled_count', 0)) for t in items)
                total_cost = sum(int(t.get('filled_count', 0)) * float(t.get('avg_fill_price', 0)) for t in items)
                if total_contracts > 0:
                    return ticker, total_cost / total_contracts
            return ticker, None
        except Exception as e:
            logger.warning(f"Failed to query fill price for {ticker}: {e}")
            return ticker, None
    
    # Query fill prices in parallel (10 workers provides good balance)
    fill_prices = {}
    tickers_to_query = list(api_positions.keys())
    
    if tickers_to_query:
        try:
            with ThreadPoolExecutor(max_workers=10) as executor:
                results = list(executor.map(query_ticker_fill_price, tickers_to_query))
            
            for ticker, avg_price in results:
                if avg_price is not None:
                    fill_prices[ticker] = avg_price
            
            logger.info(f"Calculated fill prices for {len(fill_prices)}/{len(tickers_to_query)} tickers using parallel queries")
        except Exception as e:
            logger.warning(f"Failed to fetch fill prices in parallel for {user_name}: {e}")
            fill_prices = {}
    
    # STEP 3: Enrich positions with market metadata and fill prices
    position_details = []
    
    for ticker, position_data in api_positions.items():
        contracts = position_data['position']
        market_value = position_data['market_value']
        current_price = position_data['current_price']
        
        # Get market metadata for titles and context
        try:
            market_response = market_metadata_table.get_item(Key={'market_ticker': ticker})
            market = market_response.get('Item', {})
            
            # Combine event and market titles
            event_title = market.get('event_title', '')
            market_title = market.get('market_title', market.get('title', ''))
            full_title = f"{event_title}: {market_title}" if event_title and market_title else (market_title or event_title or ticker)
            
            position_details.append({
                'ticker': ticker,
                'contracts': int(contracts),
                'side': 'yes' if contracts > 0 else 'no',
                'fill_price': float(fill_prices.get(ticker, 0)) if fill_prices.get(ticker) else None,
                'current_price': float(current_price),
                'market_value': float(market_value),
                'market_title': full_title,
                'close_time': market.get('close_time', ''),
                'event_ticker': market.get('event_ticker', ''),
                'series_ticker': market.get('series_ticker', '')
            })
            
        except Exception as e:
            logger.warning(f"Failed to get metadata for {ticker}: {e}")
            # Use API data only
            position_details.append({
                'ticker': ticker,
                'contracts': int(contracts),
                'side': 'yes' if contracts > 0 else 'no',
                'fill_price': float(fill_prices.get(ticker, 0)) if fill_prices.get(ticker) else None,
                'current_price': float(current_price),
                'market_value': float(market_value),
                'market_title': ticker,
                'close_time': '',
                'event_ticker': '',
                'series_ticker': ''
            })
    
    logger.info(f"🔍 POSITION COUNT - After enrichment loop: {len(position_details)} positions")
    logger.info(f"🔍 ENRICHED TICKERS: {sorted([p['ticker'] for p in position_details])}")
    
    # Sort by market value descending
    position_details.sort(key=lambda x: x['market_value'], reverse=True)
    
    logger.info(f"🔍 POSITION COUNT - Returning {len(position_details)} positions to client for {user_name}")
    logger.info(f"Portfolio complete for {user_name}: {len(position_details)} positions, total value: ${cash_balance + total_position_value:.2f}")
    
    return {
        'user_name': user_name,
        'cash_balance': cash_balance,
        'position_count': len(position_details),
        'total_position_value': float(total_position_value),
        'positions': position_details,
        'data_source': 'api_with_enrichment',  # Indicate data freshness
        'fetched_at': portfolio_api.get('fetched_at')
    }


def get_portfolio_history(api_key_id: str, period: str = '24h') -> List[Dict[str, Any]]:
    """Get portfolio snapshot history with downsampling"""
    
    now = datetime.now(timezone.utc)
    
    if period == '7d':
        start_time = now - timedelta(days=7)
        resolution = 'hour'
    elif period == '30d':
        start_time = now - timedelta(days=30)
        resolution = 'day'
    elif period == 'all':
        start_time = now - timedelta(days=365) # Cap at 1 year for now
        resolution = 'day'
    else: # Default to 24h
        start_time = now - timedelta(hours=24)
        resolution = '15min'

    start_ts = int(start_time.timestamp() * 1000)
    
    # Query DynamoDB
    items = []
    last_evaluated_key = None
    
    query_params = {
        'KeyConditionExpression': 'api_key_id = :api_key AND snapshot_ts >= :start_ts',
        'ExpressionAttributeValues': {
            ':api_key': api_key_id,
            ':start_ts': start_ts
        }
    }
    
    # Fetch all items in range (pagination)
    while True:
        if last_evaluated_key:
            query_params['ExclusiveStartKey'] = last_evaluated_key
            
        response = portfolio_table.query(**query_params)
        items.extend(response.get('Items', []))
        
        last_evaluated_key = response.get('LastEvaluatedKey')
        if not last_evaluated_key:
            break
            
    if not items:
        return []
        
    # Sort by timestamp ascending
    items.sort(key=lambda x: int(x['snapshot_ts']))
    
    # Downsample logic: Keep the LAST snapshot of each bucket
    buckets = {}
    for item in items:
        ts = int(item['snapshot_ts']) / 1000
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        
        if resolution == 'day':
            key = dt.strftime('%Y-%m-%d')
        elif resolution == 'hour':
            key = dt.strftime('%Y-%m-%d %H')
        else: # 15min
            minute = (dt.minute // 15) * 15
            key = dt.strftime(f'%Y-%m-%d %H:{minute:02d}')
            
        buckets[key] = item
        
    # Return sorted values
    return sorted(list(buckets.values()), key=lambda x: int(x['snapshot_ts']))

def lambda_handler(event, context):
    """
    Get portfolio data for user(s)
    
    Query params:
    - user_name: Username filter (optional for admin, returns all users if omitted)
    - include_history: Include historical snapshots (default: false)
    - history_period: Period for history (24h, 7d, 30d, all) - default 24h
    
    Cognito claims (from authorizer):
    - username: Logged in user
    - cognito:groups: User groups (contains 'admin' for admin users)
    """
    
    try:
        # Parse query parameters
        params = event.get('queryStringParameters', {}) or {}
        requested_user = params.get('user_name', '').strip()
        include_history = params.get('include_history', 'false').lower() == 'true'
        history_period = params.get('history_period', '24h')
        
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
            api_key_id = get_api_key_id(requested_user)
            portfolio = get_current_portfolio(requested_user, api_key_id)
            
            if include_history:
                portfolio['history'] = get_portfolio_history(api_key_id, history_period)
            
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
                    try:
                        api_key_id = get_api_key_id(user)
                        portfolio = get_current_portfolio(user, api_key_id)
                        if include_history:
                            portfolio['history'] = get_portfolio_history(api_key_id, history_period)
                        portfolios.append(portfolio)
                    except Exception as e:
                        print(f"Error fetching portfolio for {user}: {e}")
                
                print(f"DEBUG: Returning {len(portfolios)} portfolios")
                result = {
                    'is_admin_view': True,
                    'user_count': len(all_users),
                    'portfolios': portfolios
                }
            else:
                # Regular user sees only their own
                if not current_user:
                    return {
                        'statusCode': 401,
                        'headers': {'Content-Type': 'application/json'},
                        'body': json.dumps({'error': 'Authentication required'})
                    }
                
                api_key_id = get_api_key_id(current_user)
                portfolio = get_current_portfolio(current_user, api_key_id)
                
                if include_history:
                    portfolio['history'] = get_portfolio_history(api_key_id, history_period)
                
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

