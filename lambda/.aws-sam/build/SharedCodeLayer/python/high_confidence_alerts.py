#!/usr/bin/env python3
"""
Automated Trading Lambda Function

Scans DynamoDB for markets matching trading idea criteria and executes trades
automatically within risk limits based on portfolio constraints.

Environment Variables:
    MARKET_METADATA_TABLE_NAME: DynamoDB table with market data
    MARKET_POSITIONS_TABLE_NAME: DynamoDB table with user positions
    KALSHI_API_KEY_ID_SECRET_NAME: AWS Secrets Manager secret name for API key
    KALSHI_PRIVATE_KEY_SECRET_NAME: AWS Secrets Manager secret name for private key
    KALSHI_API_BASE_URL: Kalshi API base URL
    RATE_LIMITER_TABLE_NAME: DynamoDB table for rate limiting
"""

import os
import json
import math
import boto3
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Dict, List, Any, Optional
from collections import defaultdict

from utils import StructuredLogger
from s3_config_loader import get_latest_idea_version, get_all_enabled_users

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')
secrets_client = boto3.client('secretsmanager')
lambda_client = boto3.client('lambda')

# Logger
logger = StructuredLogger(__name__)

# Environment variables
MARKET_TABLE_NAME = os.environ['MARKET_METADATA_TABLE_NAME']
POSITIONS_TABLE_NAME = os.environ['MARKET_POSITIONS_TABLE_NAME']
SNAPSHOTS_TABLE_NAME = os.environ['PORTFOLIO_SNAPSHOTS_TABLE']
USER_SECRET_PREFIX = os.environ.get('USER_SECRET_PREFIX', 'kalshi/users')
KALSHI_BASE_URL = os.environ.get('KALSHI_API_BASE_URL', 'https://api.elections.kalshi.com')
RATE_LIMITER_TABLE = os.environ.get('RATE_LIMITER_TABLE_NAME')
CONFIG_BUCKET_NAME = os.environ.get('CONFIG_BUCKET_NAME', 'production-kalshi-trading-config')

# This Lambda is for high-confidence idea only
IDEA_ID = 'high-confidence'

# Minimum cash balance required to attempt trading
MINIMUM_TRADING_BALANCE = 10.0


def lambda_handler(event, context):
    """Main Lambda handler for automated trading."""
    import requests
    
    logger.info("Starting automated trading", timestamp=datetime.now(timezone.utc).isoformat())
    
    # Check if Kalshi exchange is active and trading before proceeding
    logger.info("Checking Kalshi exchange status")
    try:
        status_response = requests.get(
            f'{KALSHI_BASE_URL}/trade-api/v2/exchange/status',
            timeout=10
        )
        if status_response.ok:
            status = status_response.json()
            exchange_active = status.get('exchange_active', False)
            trading_active = status.get('trading_active', False)
            resume_time = status.get('exchange_estimated_resume_time')
            
            logger.info(
                "Exchange status retrieved",
                exchange_active=exchange_active,
                trading_active=trading_active,
                estimated_resume_time=resume_time
            )
            
            # Check exchange_active first (maintenance mode)
            if not exchange_active:
                logger.info(
                    "Exchange is not active (under maintenance) - skipping trading",
                    estimated_resume_time=resume_time,
                    reason="exchange_inactive"
                )
                return {
                    'statusCode': 200,
                    'message': 'Exchange not active - skipped trading',
                    'exchange_active': False,
                    'trading_active': trading_active,
                    'estimated_resume_time': resume_time,
                    'markets_scanned': 0,
                    'execution_summary': {'trades_attempted': 0, 'reason': 'exchange_inactive'}
                }
            
            # Check trading_active (outside trading hours or paused)
            if not trading_active:
                logger.info(
                    "Trading is not active (outside trading hours or paused) - skipping trading",
                    reason="trading_inactive"
                )
                return {
                    'statusCode': 200,
                    'message': 'Trading not active - skipped trading',
                    'exchange_active': exchange_active,
                    'trading_active': False,
                    'markets_scanned': 0,
                    'execution_summary': {'trades_attempted': 0, 'reason': 'trading_inactive'}
                }
        else:
            logger.warning(
                "Failed to check exchange status - proceeding anyway",
                status_code=status_response.status_code
            )
    except Exception as e:
        logger.warning(
            "Exception checking exchange status - proceeding anyway",
            error=str(e)
        )
    
    # Parse input - only user_name required (or "all")
    user_name = event.get('user_name')
    
    if not user_name:
        return {
            'statusCode': 400,
            'error': 'Missing required parameter: user_name'
        }
    
    # Determine which users to process
    if user_name.lower() == 'all':
        user_names = get_all_enabled_users()
        logger.info("Processing all users", user_count=len(user_names), users=user_names)
    else:
        user_names = [user_name]
        logger.info("Processing single user", user_name=user_name)
    
    # Load trading idea from S3 (latest version automatically)
    try:
        idea_config = get_latest_idea_version(IDEA_ID)
        idea = idea_config['parameters']
        idea_version = idea_config['version']
        idea['idea_name'] = IDEA_ID
        idea['idea_version'] = idea_version
        logger.info("Loaded idea from S3", idea_id=IDEA_ID, version=idea_version, parameters=idea)
    except Exception as e:
        logger.error("Failed to load idea from S3", idea_id=IDEA_ID, error=str(e))
        return {
            'statusCode': 500,
            'error': f'Failed to load trading idea: {str(e)}'
        }
    
    # Process each user
    all_results = []
    for current_user in user_names:
        result = process_user_trading(current_user, IDEA_ID, idea_version, idea)
        all_results.append(result)
    
    # Return summary
    if len(user_names) == 1:
        return all_results[0]
    else:
        return {
            'statusCode': 200,
            'message': f'Processed {len(user_names)} users',
            'idea_id': IDEA_ID,
            'idea_version': idea_version,
            'users_processed': len(user_names),
            'results': all_results
        }


def process_user_trading(user_name: str, idea_name: str, idea_version: str, idea: Dict) -> Dict:
    
    # Step 1: Get portfolio state
    max_portfolio_share = idea.get('max_portfolio_share', 0.10)
    portfolio = get_portfolio_state(user_name, max_portfolio_share)
    if 'error' in portfolio:
        return {
            'statusCode': 500,
            'error': portfolio['error']
        }
    
    logger.info("Portfolio state",
               cash=portfolio['total_cash'],
               positions_value=portfolio['total_position_value'],
               total_value=portfolio['total_portfolio_value'],
               max_position_value=portfolio['max_position_value'])
    
    # EARLY EXIT: Check minimum balance before scanning markets
    if portfolio['total_cash'] < MINIMUM_TRADING_BALANCE:
        logger.info("Insufficient balance for trading - skipping market scan", 
                   cash=portfolio['total_cash'],
                   minimum_required=MINIMUM_TRADING_BALANCE,
                   reason="balance_too_low")
        return {
            'statusCode': 200,
            'message': f'Insufficient balance for trading (minimum ${MINIMUM_TRADING_BALANCE} required)',
            'user_name': user_name,
            'idea_name': idea_name,
            'idea_version': idea_version,
            'cash_balance': portfolio['total_cash'],
            'minimum_required': MINIMUM_TRADING_BALANCE,
            'markets_scanned': 0,
            'markets_qualified': 0,
            'execution_summary': {
                'trades_attempted': 0,
                'trades_successful': 0,
                'reason': 'insufficient_balance'
            }
        }

    # Step 2-4: Scan and filter markets
    markets = scan_and_score_markets(idea, portfolio)
    logger.info("Market scan complete", qualified_markets=len(markets))
    
    if not markets:
        return {
            'statusCode': 200,
            'message': 'No qualifying markets found',
            'markets_scanned': 0,
            'markets_qualified': 0
        }
    
    # Step 5: Execute trades
    trade_results = execute_trades(user_name, markets, portfolio, idea)
    
    # Step 6: Return summary
    return {
        'statusCode': 200,
        'user_name': user_name,
        'idea_name': idea_name,
        'idea_version': idea_version,
        'idea_parameters': idea,
        'execution_summary': trade_results['summary'],
        'trade_details': trade_results['details']
    }


# Removed load_trading_idea - now using S3 config loader


def get_user_config(user_name: str):
    """
    Load user configuration from AWS Secrets Manager.
    Returns tuple: (api_key_id, private_key, metadata_dict)
    """
    try:
        # Get metadata (contains api_key_id and enabled flag)
        metadata_secret_name = f'{USER_SECRET_PREFIX}/{user_name}/metadata'
        metadata_response = secrets_client.get_secret_value(SecretId=metadata_secret_name)
        metadata = json.loads(metadata_response['SecretString'])
        
        api_key_id = metadata.get('api_key_id')
        if not api_key_id:
            raise ValueError(f"api_key_id not found in metadata for user {user_name}")
        
        # Get private key
        private_key_secret_name = f'{USER_SECRET_PREFIX}/{user_name}/private-key'
        private_key_response = secrets_client.get_secret_value(SecretId=private_key_secret_name)
        private_key = private_key_response['SecretString']
        
        return api_key_id, private_key, metadata
        
    except Exception as e:
        logger.error("Failed to load user config", user_name=user_name, error=str(e))
        raise


def get_portfolio_state(user_name: str, max_portfolio_share: float = 0.10) -> Dict:
    """
    Get user's current portfolio state from DynamoDB.
    Queries the most recent snapshot for cash balance and current positions.
    
    Args:
        user_name: User's username
        max_portfolio_share: Maximum portfolio percentage per position (default 0.10 = 10%)
    
    Returns: {
        'total_cash': float,
        'total_position_value': float,
        'total_portfolio_value': float,
        'max_position_value': float,
        'existing_positions_map': {ticker: float},
        'remaining_cash': float,
        'api_key_id': str  # Needed for subsequent queries
    }
    """
    try:
        # Load user credentials to get api_key_id
        api_key_id, private_key, metadata = get_user_config(user_name)
        
        # Query most recent portfolio snapshot for cash balance
        snapshots_table = dynamodb.Table(SNAPSHOTS_TABLE_NAME)
        snapshot_response = snapshots_table.query(
            KeyConditionExpression='api_key_id = :api_key_id',
            ExpressionAttributeValues={':api_key_id': api_key_id},
            ScanIndexForward=False,  # Descending order by snapshot_ts
            Limit=1  # Only get most recent
        )
        
        snapshot_items = snapshot_response.get('Items', [])
        if not snapshot_items:
            raise ValueError(f"No portfolio snapshots found for user {user_name}")
        
        snapshot = snapshot_items[0]
        total_cash_cents = float(snapshot.get('cash', 0))
        total_cash = total_cash_cents / 100.0  # Convert cents to dollars
        
        # Query user's current positions from MarketPositionsTable
        positions_table = dynamodb.Table(POSITIONS_TABLE_NAME)
        positions_response = positions_table.query(
            IndexName='UserTickerIndex',
            KeyConditionExpression='api_key_id = :api_key_id',
            ExpressionAttributeValues={':api_key_id': api_key_id},
            ScanIndexForward=False  # Get most recent snapshots first
        )
        
        # Aggregate positions by ticker (use most recent snapshot for each)
        # Build map of ticker -> position (number of contracts)
        positions_by_ticker = {}
        seen_tickers = set()
        for item in positions_response.get('Items', []):
            ticker = item.get('ticker')
            if ticker and ticker not in seen_tickers:
                seen_tickers.add(ticker)
                position = int(item.get('position', 0))
                if position != 0:  # Only include non-zero positions
                    positions_by_ticker[ticker] = position
        
        # Calculate position values by looking up current market prices
        # position_value = abs(position) * current_market_price
        market_table = dynamodb.Table(MARKET_TABLE_NAME)
        existing_positions_map = {}
        total_position_value = 0.0
        
        for ticker, position_count in positions_by_ticker.items():
            try:
                # Get current market data
                market_response = market_table.get_item(Key={'market_ticker': ticker})
                market = market_response.get('Item')
                
                if market:
                    # Use bid prices for position valuation (what we can sell at)
                    # Fallback to last trade price if bid not available
                    yes_price = float(market.get('yes_price', 0))
                    yes_bid = float(market.get('yes_bid_dollars', yes_price))
                    no_bid = float(market.get('no_bid_dollars', 1.0 - yes_price))
                    
                    # Position value calculation using bid prices:
                    # - Positive contracts (YES side): contracts × yes_bid (what we can sell YES at)
                    # - Negative contracts (NO side): |contracts| × no_bid (what we can sell NO at)
                    if position_count > 0:
                        position_value = position_count * yes_bid
                    else:
                        position_value = abs(position_count) * no_bid
                    
                    existing_positions_map[ticker] = position_value
                    total_position_value += position_value
                else:
                    logger.warning("Market not found for position", ticker=ticker)
            except Exception as e:
                logger.error("Error fetching market price", ticker=ticker, error=str(e))
        
        total_portfolio_value = total_cash + total_position_value
        max_position_value = total_portfolio_value * max_portfolio_share
        
        return {
            'total_cash': total_cash,
            'total_position_value': total_position_value,
            'total_portfolio_value': total_portfolio_value,
            'max_position_value': max_position_value,
            'existing_positions_map': existing_positions_map,
            'remaining_cash': total_cash,
            'api_key_id': api_key_id,  # Pass through for subsequent queries
            'private_key': private_key  # Pass through for trading client
        }
        
    except Exception as e:
        logger.error("Error loading portfolio state", user_name=user_name, error=str(e))
        return {'error': str(e)}


def scan_and_score_markets(idea: Dict, portfolio: Dict) -> List[Dict]:
    """Scan DynamoDB for markets matching idea criteria and calculate scores."""
    try:
        market_table = dynamodb.Table(MARKET_TABLE_NAME)
        
        min_confidence = Decimal(str(idea['min_confidence']))
        min_confidence_float = float(min_confidence)  # For comparisons with float prices
        low_confidence = Decimal('1.0') - min_confidence
        use_bid = idea.get('use_bid', False)
        
        markets = []
        last_key = None
        
        # Scan with confidence-based filter
        # If use_bid=True: filter by BID prices (what market is willing to pay)
        # If use_bid=False: filter by ASK prices (what we can buy at) - original behavior
        if use_bid:
            # Bid-based: look for markets where bid shows high confidence
            filter_expr = '(yes_bid_dollars >= :high OR no_bid_dollars >= :high) AND #status = :active'
        else:
            # Ask-based: look for markets where ask shows high confidence (original)
            filter_expr = '(yes_ask_dollars >= :high OR no_ask_dollars >= :high) AND #status = :active'
        
        while True:
            scan_kwargs = {
                'FilterExpression': filter_expr,
                'ExpressionAttributeValues': {
                    ':high': min_confidence,
                    ':active': 'active'
                },
                'ExpressionAttributeNames': {'#status': 'status'}
            }
            
            if last_key:
                scan_kwargs['ExclusiveStartKey'] = last_key
            
            response = market_table.scan(**scan_kwargs)
            markets.extend(response.get('Items', []))
            
            last_key = response.get('LastEvaluatedKey')
            if not last_key:
                break
        
        logger.info("Market scan completed", markets_found=len(markets), use_bid=use_bid)
        
        # Step 3: Post-scan filtering and scoring
        qualified_markets = []
        now = datetime.now(timezone.utc)
        
        for market in markets:
            # Get market category to determine if crypto/financial parameters should be used
            category = market.get('category', '').lower()
            is_crypto_or_financial = category in ['crypto', 'financials', 'unknown']
            is_climate = category == 'climate and weather'
            
            # TEMPORARY BLOCK: Skip crypto, financials, and unknown category markets
            if is_crypto_or_financial:
                logger.info("Skipping crypto/financials/unknown market", 
                           ticker=market.get('market_ticker'),
                           category=category,
                           reason="temporary_category_block")
                continue
            
            # Select appropriate parameters based on category
            if is_crypto_or_financial:
                market_min_confidence = idea.get('crypto_min_confidence', idea['min_confidence'])
                time_horizon = idea.get('crypto_time_horizon', idea['time_horizon'])
            elif is_climate:
                market_min_confidence = idea['min_confidence']
                time_horizon = idea.get('climate_time_horizon', idea['time_horizon'])
            else:
                market_min_confidence = idea['min_confidence']
                time_horizon = idea['time_horizon']
            
            # Convert to float for price comparisons
            market_min_confidence_float = float(market_min_confidence)
            
            # Determine effective expiration time
            close_time = market.get('close_time')
            expected_expiration_time = market.get('expected_expiration_time')
            
            if not close_time:
                continue
                
            close_time_ts = int(close_time)
            
            # Use expected_expiration_time if it's more than 24h after close_time
            if expected_expiration_time:
                expected_ts = int(expected_expiration_time)
                if expected_ts > (close_time_ts + 86400):  # 24 hours
                    effective_expiry_ts = expected_ts
                    expiry_source = "expected_expiration_time"
                else:
                    effective_expiry_ts = close_time_ts
                    expiry_source = "close_time"
            else:
                effective_expiry_ts = close_time_ts
                expiry_source = "close_time"
            
            effective_expiry = datetime.fromtimestamp(effective_expiry_ts, tz=timezone.utc)
            hours_to_expiry = (effective_expiry - now).total_seconds() / 3600
            
            # Filter by time horizon (using crypto-specific or standard)
            if hours_to_expiry <= 0 or hours_to_expiry > time_horizon:
                continue
            
            # Determine trade side and price based on strategy mode
            if use_bid:
                # BID-BASED MODE (v2.0.0+): Check bid prices and calculate midpoint
                # Look for markets where BID shows high confidence (market willing to pay high price)
                yes_bid_dollars = market.get('yes_bid_dollars')
                no_bid_dollars = market.get('no_bid_dollars')
                yes_ask_dollars = market.get('yes_ask_dollars')
                no_ask_dollars = market.get('no_ask_dollars')
                
                # Try YES side: if yes_bid >= min_confidence
                if yes_bid_dollars:
                    yes_bid = float(yes_bid_dollars)
                    if yes_bid >= market_min_confidence_float:
                        # Calculate midpoint, assume ask=1.00 if missing
                        yes_ask = float(yes_ask_dollars) if yes_ask_dollars else 1.00
                        spread = yes_ask - yes_bid
                        # If spread is exactly 0.01, use ask price; otherwise round down
                        if abs(spread - 0.01) < 0.001:  # Account for floating point precision
                            limit_price = yes_ask
                            logger.info("Using ask price for tight spread", 
                                       ticker=market.get('market_ticker'), 
                                       side="YES",
                                       bid=yes_bid, 
                                       ask=yes_ask, 
                                       spread=spread,
                                       limit_price=limit_price)
                        else:
                            midpoint = (yes_bid + yes_ask) / 2
                            limit_price = math.floor(midpoint * 100) / 100  # Round down to nearest cent
                        max_gain = 1.0 - limit_price
                        trade_side = "YES"
                    elif no_bid_dollars:
                        # Try NO side: if no_bid >= min_confidence
                        no_bid = float(no_bid_dollars)
                        if no_bid >= market_min_confidence_float:
                            no_ask = float(no_ask_dollars) if no_ask_dollars else 1.00
                            spread = no_ask - no_bid
                            # If spread is exactly 0.01, use ask price; otherwise round down
                            if abs(spread - 0.01) < 0.001:  # Account for floating point precision
                                limit_price = no_ask
                                logger.info("Using ask price for tight spread", 
                                           ticker=market.get('market_ticker'), 
                                           side="NO",
                                           bid=no_bid, 
                                           ask=no_ask, 
                                           spread=spread,
                                           limit_price=limit_price)
                            else:
                                midpoint = (no_bid + no_ask) / 2
                                limit_price = math.floor(midpoint * 100) / 100  # Round down to nearest cent
                            max_gain = 1.0 - limit_price
                            trade_side = "NO"
                        else:
                            continue
                    else:
                        continue
                elif no_bid_dollars:
                    # Only NO bid available
                    no_bid = float(no_bid_dollars)
                    if no_bid >= market_min_confidence_float:
                        no_ask = float(no_ask_dollars) if no_ask_dollars else 1.00
                        spread = no_ask - no_bid
                        # If spread is exactly 0.01, use ask price; otherwise round down
                        if abs(spread - 0.01) < 0.001:  # Account for floating point precision
                            limit_price = no_ask
                            logger.info("Using ask price for tight spread", 
                                       ticker=market.get('market_ticker'), 
                                       side="NO",
                                       bid=no_bid, 
                                       ask=no_ask, 
                                       spread=spread,
                                       limit_price=limit_price)
                        else:
                            midpoint = (no_bid + no_ask) / 2
                            limit_price = math.floor(midpoint * 100) / 100  # Round down to nearest cent
                        max_gain = 1.0 - limit_price
                        trade_side = "NO"
                    else:
                        continue
                else:
                    # No bid prices available
                    continue
            else:
                # ASK-BASED MODE (v1.x): Original behavior - check ask prices
                # We want to buy contracts where the ask price shows high confidence
                yes_ask_dollars = market.get('yes_ask_dollars')
                no_ask_dollars = market.get('no_ask_dollars')
                
                # Try YES side: if yes_ask is high enough, it means market is confident YES will win
                if yes_ask_dollars:
                    yes_ask = float(yes_ask_dollars)
                    if yes_ask >= market_min_confidence_float:
                        trade_side = "YES"
                        limit_price = yes_ask
                        max_gain = 1.0 - limit_price
                    elif no_ask_dollars:
                        # Try NO side: if no_ask is high enough, it means market is confident NO will win
                        no_ask = float(no_ask_dollars)
                        if no_ask >= market_min_confidence_float:
                            trade_side = "NO"
                            limit_price = no_ask
                            max_gain = 1.0 - limit_price
                        else:
                            continue
                    else:
                        continue
                elif no_ask_dollars:
                    # Only NO ask available
                    no_ask = float(no_ask_dollars)
                    if no_ask >= market_min_confidence_float:
                        trade_side = "NO"
                        limit_price = no_ask
                        max_gain = 1.0 - limit_price
                    else:
                        continue
                else:
                    # No ask prices available
                    continue
            
            # Filter by max_gain
            if max_gain <= 0:
                continue
            
            # Calculate score
            # Formula: 2 / (max_gain * hours_to_expiry)
            # Prioritizes small max_gain (high certainty) and short time horizons
            score = 2 / (max_gain * hours_to_expiry)
            
            # Step 4: Filter by minimum score
            if score < idea['minimum_score']:
                continue
            
            qualified_markets.append({
                **market,
                'trade_side': trade_side,
                'limit_price': limit_price,
                'max_gain': max_gain,
                'score': score,
                'hours_to_expiry': hours_to_expiry,
                'expiry_source': expiry_source,
                'effective_expiry_ts': effective_expiry_ts
            })
        
        # Sort by score descending
        qualified_markets.sort(key=lambda m: m['score'], reverse=True)
        
        return qualified_markets
        
    except Exception as e:
        logger.error("Error scanning markets", error=str(e))
        import traceback
        traceback.print_exc()
        return []


def get_fresh_portfolio_state(api_key_id: str) -> Dict:
    """
    Query current portfolio state from DynamoDB (fast refresh before each trade).
    This is called before each trade to account for concurrent trading activity.
    
    Recalculates position values using current market bid prices for accuracy.
    
    Returns: {
        'cash': float,
        'positions_map': {ticker: float}  # ticker -> current position value in dollars
    }
    """
    # Get most recent cash balance
    snapshots_table = dynamodb.Table(SNAPSHOTS_TABLE_NAME)
    snapshot_response = snapshots_table.query(
        KeyConditionExpression='api_key_id = :api_key_id',
        ExpressionAttributeValues={':api_key_id': api_key_id},
        ScanIndexForward=False,
        Limit=1
    )
    
    snapshot_items = snapshot_response.get('Items', [])
    cash = float(snapshot_items[0].get('cash', 0)) if snapshot_items else 0.0
    
    # Get current positions
    positions_table = dynamodb.Table(POSITIONS_TABLE_NAME)
    positions_response = positions_table.query(
        IndexName='UserTickerIndex',
        KeyConditionExpression='api_key_id = :api_key_id',
        ExpressionAttributeValues={':api_key_id': api_key_id},
        ScanIndexForward=False
    )
    
    # Build map of positions (ticker -> contract count)
    positions_by_ticker = {}
    seen_tickers = set()
    for item in positions_response.get('Items', []):
        ticker = item.get('ticker')
        if ticker and ticker not in seen_tickers:
            seen_tickers.add(ticker)
            position = int(item.get('position', 0))
            if position != 0:
                positions_by_ticker[ticker] = position
    
    # Recalculate position values using current market bid prices
    positions_map = {}
    market_table = dynamodb.Table(MARKET_TABLE_NAME)
    
    for ticker, position_count in positions_by_ticker.items():
        try:
            # Get current market data
            market_response = market_table.get_item(Key={'market_ticker': ticker})
            market = market_response.get('Item')
            
            if market:
                # Use bid prices for position valuation (what we can sell at)
                # Fallback to last trade price if bid not available
                yes_price = float(market.get('yes_price', 0))
                yes_bid = float(market.get('yes_bid_dollars', yes_price))
                no_bid = float(market.get('no_bid_dollars', 1.0 - yes_price))
                
                # Position value calculation using bid prices:
                # - Positive contracts (YES side): contracts × yes_bid
                # - Negative contracts (NO side): |contracts| × no_bid
                if position_count > 0:
                    position_value = position_count * yes_bid
                else:
                    position_value = abs(position_count) * no_bid
                
                positions_map[ticker] = position_value
            else:
                logger.warning("Market not found for position refresh", ticker=ticker)
        except Exception as e:
            logger.error("Error fetching market price for position refresh", ticker=ticker, error=str(e))
    
    return {
        'cash': cash,
        'positions_map': positions_map
    }


def execute_trades(user_name: str, markets: List[Dict], portfolio: Dict, idea: Dict) -> Dict:
    """
    Execute trades for qualified markets by invoking the Trading Lambda.
    Re-queries portfolio state before each trade to account for concurrent trading.
    
    NO API CALLS ARE MADE DIRECTLY - all trades go through the Trading Lambda.
    """
    # Get api_key_id for portfolio state queries
    api_key_id = portfolio.get('api_key_id')
    
    if not api_key_id:
        return {
            'summary': {'error': 'Missing api_key_id in portfolio state'},
            'details': []
        }
    
    # Get Trading Lambda function name from environment
    trading_lambda_name = os.environ.get('TRADING_LAMBDA_FUNCTION_NAME')
    if not trading_lambda_name:
        return {
            'summary': {'error': 'TRADING_LAMBDA_FUNCTION_NAME environment variable not set'},
            'details': []
        }
    
    # Track execution
    max_position_value = portfolio['max_position_value']
    
    trades_attempted = 0
    trades_successful = 0
    trades_skipped_cash = 0
    trades_skipped_size_limit = 0
    total_spent = 0.0
    trade_details = []
    
    starting_portfolio_value = portfolio['total_portfolio_value']
    
    # Extract idea parameters for Trading Lambda
    idea_name = idea.get('idea_name', 'high-confidence')
    idea_version = idea.get('idea_version', '1.1.0')
    
    for market in markets:
        ticker = market['market_ticker']
        trade_side = market['trade_side']
        limit_price = market['limit_price']
        score = market['score']
        
        # RE-QUERY portfolio state before EACH trade (accounts for concurrent trading)
        logger.info("Refreshing portfolio state", ticker=ticker)
        fresh_state = get_fresh_portfolio_state(api_key_id)
        remaining_cash = fresh_state['cash']
        existing_positions_map = fresh_state['positions_map']
        
        # Risk Check 1: Calculate available position value
        existing_position_value = existing_positions_map.get(ticker, 0.0)
        available_position_value = max_position_value - existing_position_value
        
        if available_position_value <= 0:
            logger.info("Skipping trade - position limit", 
                       ticker=ticker, 
                       existing_value=existing_position_value,
                       reason="at_position_limit")
            trades_skipped_size_limit += 1
            continue
        
        # Risk Check 2: Determine trade value
        trade_value = min(available_position_value, remaining_cash)
        
        if trade_value <= 0:
            logger.info("Skipping trade - no cash", 
                       ticker=ticker, 
                       cash=remaining_cash,
                       reason="insufficient_cash")
            trades_skipped_cash += 1
            continue
        
        # Execute trade by invoking Trading Lambda
        logger.info("Executing trade",
                   ticker=ticker,
                   side=trade_side,
                   trade_value=trade_value,
                   limit_price=limit_price,
                   score=score)
        trades_attempted += 1
        
        try:
            # Prepare payload for Trading Lambda
            trade_payload = {
                'user_name': user_name,
                'ticker': ticker,
                'side': trade_side.lower(),  # 'yes' or 'no'
                'max_dollar_amount': float(trade_value),
                'max_price': float(limit_price),
                'idea_id': idea_name,
                'idea_version': idea_version,
                'wait_for_fill': True,
                'fill_timeout': 30.0,
                'order_expiration_seconds': idea.get('order_expiration_seconds', 30)
            }
            
            # Invoke Trading Lambda asynchronously (fire-and-forget)
            # This allows multiple trades to execute in parallel
            response = lambda_client.invoke(
                FunctionName=trading_lambda_name,
                InvocationType='Event',  # Asynchronous - don't wait for response
                Payload=json.dumps(trade_payload)
            )
            
            # With async invocation, we don't get trade results back
            # Just log that the trade was triggered
            trades_attempted += 1
            
            logger.info("Trade Lambda invoked asynchronously",
                       ticker=ticker,
                       side=trade_side,
                       trade_value=trade_value,
                       limit_price=limit_price,
                       score=score)
            
            trade_details.append({
                'market_ticker': ticker,
                'side': trade_side,
                'trade_value': trade_value,
                'limit_price': limit_price,
                'score': score,
                'hours_to_expiry': market['hours_to_expiry'],
                'expiry_source': market['expiry_source'],
                'status': 'triggered',  # Changed from 'executed' since we don't wait
            })
                
        except Exception as e:
            logger.error("Error invoking Trading Lambda", ticker=ticker, error=str(e))
            import traceback
            traceback.print_exc()
            trade_details.append({
                'market_ticker': ticker,
                'side': trade_side,
                'trade_value': trade_value,
                'score': score,
                'status': 'error',
                'error': str(e)
            })
    
    # Calculate ending portfolio value
    ending_portfolio_value = starting_portfolio_value + total_spent  # Approximate
    
    summary = {
        'markets_scanned': len(markets),
        'markets_qualified': len(markets),
        'trades_attempted': trades_attempted,
        'trades_successful': trades_successful,
        'trades_skipped_cash': trades_skipped_cash,
        'trades_skipped_size_limit': trades_skipped_size_limit,
        'total_spent': total_spent,
        'starting_portfolio_value': starting_portfolio_value,
        'ending_portfolio_value': ending_portfolio_value
    }
    
    return {
        'summary': summary,
        'details': trade_details
    }

