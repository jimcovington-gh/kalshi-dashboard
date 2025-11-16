"""AWS Lambda function for executing trades on Kalshi with idea validation.

This Lambda function accepts trade parameters (ticker, max amount, max price),
validates the trading idea against the ideas registry, reads the orderbook,
places orders, and confirms fills via WebSocket.

All trades are logged with full traceability to the originating trading idea
and persisted to DynamoDB for long-term storage and analysis.
"""

import json
import os
import uuid
import traceback
from typing import Dict, Any, List
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

from kalshi_trading_client import KalshiTradingClient
from models import TradeIdea
from config import get_config
from utils import StructuredLogger
from trading_ideas_manager import (
    validate_trade_idea,
    get_idea_description,
    get_idea_parameters
)


# DynamoDB client
dynamodb = boto3.resource('dynamodb')

# Secrets Manager client
secrets_client = boto3.client('secretsmanager')

# Environment variables
ENVIRONMENT = os.environ.get('ENVIRONMENT', 'production')
USER_SECRET_PREFIX = os.environ.get('USER_SECRET_PREFIX', f'{ENVIRONMENT}/kalshi/users')

# Client cache for warm Lambda containers
# Key: (api_key_id, rate_limiter_table), Value: KalshiTradingClient instance
_client_cache: Dict[tuple, KalshiTradingClient] = {}


class UserNotFoundError(Exception):
    """User not configured in Secrets Manager"""
    pass


class UserDisabledError(Exception):
    """User is disabled in metadata"""
    pass


def get_user_config(user_name: str) -> tuple[str, str]:
    """Retrieve user configuration from Secrets Manager.
    
    Args:
        user_name: Username identifier (e.g., 'jimc')
        
    Returns:
        Tuple of (api_key_id, private_key)
        
    Raises:
        UserNotFoundError: If user secrets don't exist
        UserDisabledError: If user is disabled in metadata
    """
    # Get metadata
    metadata_secret_name = f"{USER_SECRET_PREFIX}/{user_name}/metadata"
    
    try:
        response = secrets_client.get_secret_value(SecretId=metadata_secret_name)
        metadata = json.loads(response['SecretString'])
        
        # Check if user is enabled
        if not metadata.get('enabled', True):
            raise UserDisabledError(
                f"User {user_name} is disabled. "
                f"Disabled at: {metadata.get('disabled_at', 'unknown')}"
            )
        
        api_key_id = metadata['api_key_id']
        
    except secrets_client.exceptions.ResourceNotFoundException:
        raise UserNotFoundError(
            f"User {user_name} not found. "
            f"Expected secret: {metadata_secret_name}"
        )
    except KeyError:
        raise UserNotFoundError(
            f"User metadata for {user_name} is missing 'api_key_id' field"
        )
    
    # Get private key
    private_key_secret_name = f"{USER_SECRET_PREFIX}/{user_name}/private-key"
    
    try:
        response = secrets_client.get_secret_value(SecretId=private_key_secret_name)
        secret_string = response['SecretString']
        
        # Handle both plain text and JSON-wrapped private keys
        try:
            secret_data = json.loads(secret_string)
            private_key = secret_data['private_key']
        except (json.JSONDecodeError, KeyError):
            # Plain text private key
            private_key = secret_string
        
    except secrets_client.exceptions.ResourceNotFoundException:
        raise UserNotFoundError(
            f"Private key for user {user_name} not found. "
            f"Expected secret: {private_key_secret_name}"
        )
    
    return api_key_id, private_key


def is_event_prohibited(event_ticker: str, logger: StructuredLogger) -> tuple[bool, str]:
    """Check if an event is prohibited from automated trading.
    
    Args:
        event_ticker: Event ticker to check (e.g., "KXELECTION-2024")
        logger: Structured logger instance
        
    Returns:
        Tuple of (is_prohibited: bool, reason: str)
        - If prohibited: (True, "reason why")
        - If allowed: (False, "")
        - On error: (True, "error message") - fail closed for safety
    """
    prohibited_table_name = os.environ.get('PROHIBITED_EVENTS_TABLE')
    
    if not prohibited_table_name:
        logger.warning("PROHIBITED_EVENTS_TABLE not configured, allowing trade")
        return False, ""
    
    try:
        table = dynamodb.Table(prohibited_table_name)
        response = table.get_item(Key={'event_ticker': event_ticker})
        
        if 'Item' in response:
            item = response['Item']
            
            # Check if temporary prohibition has expired
            if 'expires_at' in item:
                try:
                    expires = datetime.fromisoformat(item['expires_at'])
                    if datetime.now(timezone.utc) > expires:
                        logger.info(
                            "Temporary event prohibition expired",
                            event_ticker=event_ticker,
                            expired_at=item['expires_at']
                        )
                        return False, ""
                except (ValueError, TypeError) as e:
                    logger.warning(
                        "Invalid expires_at format, treating as active prohibition",
                        event_ticker=event_ticker,
                        expires_at=item.get('expires_at'),
                        error=str(e)
                    )
            
            reason = item.get('reason', 'Event prohibited from automated trading')
            logger.info(
                "Event is prohibited",
                event_ticker=event_ticker,
                reason=reason,
                added_by=item.get('added_by'),
                added_at=item.get('added_at')
            )
            return True, reason
        
        return False, ""
        
    except Exception as e:
        logger.error(
            "Error checking prohibited events table - failing closed (prohibiting trade)",
            event_ticker=event_ticker,
            error=str(e),
            traceback=traceback.format_exc()
        )
        # Fail closed: treat as prohibited on error for safety
        return True, f"Error checking prohibition status: {str(e)}"


def _decimal_default(obj):
    """JSON serializer for Decimal objects."""
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def persist_trade_initiation(trade_log: Dict[str, Any], table_name: str, logger: StructuredLogger) -> None:
    """Persist trade initiation details to DynamoDB.

    Args:
        trade_log: Trade log dictionary
        table_name: DynamoDB table name
        logger: Structured logger instance
    """
    try:
        table = dynamodb.Table(table_name)

        # Prepare item for DynamoDB
        item = {
            'trade_id': trade_log['trade_id'],
            'userid': trade_log.get('userid', 'jimc'),  # User identifier
            'idea_id': trade_log['idea']['idea_id'],
            'idea_version': trade_log['idea']['idea_version'],
            'ticker': trade_log['ticker'],
            'side': trade_log['side'],
            'action': trade_log['action'],
            'max_dollar_amount': Decimal(str(trade_log['max_dollar_amount'])),
            'max_price': Decimal(str(trade_log['max_price'])),
            'orderbook_fetch_time': trade_log.get('orderbook_fetch_time', ''),
            'order_placement_time': trade_log.get('order_placement_time', ''),
            'initiated_at': datetime.now(timezone.utc).isoformat(),
            'status': 'initiated'
        }

        # Add orderbook snapshot if available
        if trade_log.get('orderbook_snapshot'):
            item['orderbook_snapshot'] = json.dumps(trade_log['orderbook_snapshot'], default=_decimal_default)

        table.put_item(Item=item)

        logger.info(
            "Trade initiation persisted to DynamoDB",
            trade_id=trade_log['trade_id'],
            table_name=table_name
        )

    except ClientError as e:
        logger.error(
            "Failed to persist trade initiation to DynamoDB",
            trade_id=trade_log['trade_id'],
            error=str(e),
            error_code=e.response['Error']['Code']
        )
        # Don't fail the trade if DynamoDB write fails
    except Exception as e:
        logger.error(
            "Unexpected error persisting trade initiation",
            trade_id=trade_log['trade_id'],
            error=str(e),
            error_type=type(e).__name__
        )


def persist_trade_completion(trade_log: Dict[str, Any], table_name: str, logger: StructuredLogger) -> None:
    """Persist trade completion details to DynamoDB.

    Args:
        trade_log: Trade log dictionary with complete execution details
        table_name: DynamoDB table name
        logger: Structured logger instance
    """
    try:
        table = dynamodb.Table(table_name)

        # Calculate summary statistics
        total_filled = sum(f.get('count', 0) for f in trade_log.get('fills', []))
        avg_fill_price = 0.0
        if total_filled > 0:
            total_cost = sum(f.get('count', 0) * f.get('price', 0.0) for f in trade_log.get('fills', []))
            avg_fill_price = total_cost / total_filled

        # Prepare update expression
        update_expr = "SET #status = :status, completed_at = :completed_at, #success = :success, " \
                     "order_id = :order_id, order_status = :order_status, " \
                     "filled_count = :filled_count, avg_fill_price = :avg_fill_price, " \
                     "fill_count = :fill_count, completion_time = :completion_time"
        
        expr_attr_names = {
            '#status': 'status',
            '#success': 'success'
        }
        
        order = trade_log.get('order') or {}
        
        expr_attr_values = {
            ':status': 'completed',
            ':completed_at': datetime.now(timezone.utc).isoformat(),
            ':success': trade_log['success'],
            ':order_id': order.get('order_id', ''),
            ':order_status': order.get('status', ''),
            ':filled_count': total_filled,
            ':avg_fill_price': Decimal(str(avg_fill_price)) if avg_fill_price > 0 else Decimal('0'),
            ':fill_count': len(trade_log.get('fills', [])),
            ':completion_time': trade_log.get('completion_time', '')
        }

        # Add fills as JSON if present
        if trade_log.get('fills'):
            update_expr += ", fills = :fills"
            expr_attr_values[':fills'] = json.dumps(trade_log['fills'], default=_decimal_default)

        # Add error message if present
        if trade_log.get('error_message'):
            update_expr += ", error_message = :error_message"
            expr_attr_values[':error_message'] = trade_log['error_message']

        # Update the existing record
        table.update_item(
            Key={'trade_id': trade_log['trade_id']},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=expr_attr_names,
            ExpressionAttributeValues=expr_attr_values
        )

        logger.info(
            "Trade completion persisted to DynamoDB",
            trade_id=trade_log['trade_id'],
            table_name=table_name,
            success=trade_log['success'],
            total_contracts_filled=total_filled
        )

    except ClientError as e:
        logger.error(
            "Failed to persist trade completion to DynamoDB",
            trade_id=trade_log['trade_id'],
            error=str(e),
            error_code=e.response['Error']['Code']
        )
        # Don't fail the trade if DynamoDB write fails
    except Exception as e:
        logger.error(
            "Unexpected error persisting trade completion",
            trade_id=trade_log['trade_id'],
            error=str(e),
            error_type=type(e).__name__
        )


def update_portfolio_after_trade(
    user_name: str,
    api_key_id: str,
    ticker: str,
    side: str,
    fills: List[Dict[str, Any]],
    logger: StructuredLogger
) -> None:
    """Update portfolio positions and cash after trade execution.
    
    Updates or creates position for the ticker and decrements cash by total cost.
    
    Args:
        user_name: User's friendly name
        api_key_id: User's API key ID
        ticker: Market ticker
        side: Trade side ('yes' or 'no')
        fills: List of fill dictionaries with count and price
        logger: Structured logger instance
    """
    if not fills:
        logger.info("No fills to update portfolio", ticker=ticker)
        return
    
    try:
        # Calculate totals from actual fills
        total_contracts = sum(f.get('count', 0) for f in fills)
        
        # Calculate fees based on Kalshi's fee schedule
        # For limit orders that fill immediately (taker): fees = round_up(0.07 × C × P × (1-P))
        # For limit orders that rest (maker): fees = round_up(0.0175 × C × P × (1-P))
        # Since our orders can be either, we'll use taker fees as the conservative estimate
        total_fee_cents = 0
        for f in fills:
            count = f.get('count', 0)
            price = f.get('price', 0.0)  # Already in dollars (e.g., 0.95)
            
            # Expected earnings: P × (1-P)
            expected_earnings = price * (1.0 - price)
            
            # Taker fee (conservative): 0.07 × count × expected_earnings, rounded up to next cent
            fee_dollars = 0.07 * count * expected_earnings
            fee_cents = int(fee_dollars * 100) if fee_dollars * 100 == int(fee_dollars * 100) else int(fee_dollars * 100) + 1
            total_fee_cents += fee_cents
        
        # Contract cost (what we paid for the contracts)
        contracts_cost_cents = int(sum(f.get('count', 0) * f.get('price', 0.0) * 100 for f in fills))
        
        # Total cost = contract cost + fees
        total_cost_cents = contracts_cost_cents + total_fee_cents
        
        if total_contracts == 0:
            logger.info("No contracts filled, skipping portfolio update", ticker=ticker)
            return
        
        logger.info(
            "Updating portfolio after trade",
            user_name=user_name,
            ticker=ticker,
            side=side,
            total_contracts=total_contracts,
            contracts_cost_cents=contracts_cost_cents,
            fee_cents=total_fee_cents,
            total_cost_cents=total_cost_cents
        )
        
        # Get table names from environment
        positions_table_name = os.environ.get('MARKET_POSITIONS_TABLE')
        snapshots_table_name = os.environ.get('PORTFOLIO_SNAPSHOTS_TABLE')
        
        if not positions_table_name or not snapshots_table_name:
            logger.warning("Portfolio table names not configured, skipping update")
            return
        
        # Update position (add to existing or create new)
        positions_table = dynamodb.Table(positions_table_name)
        
        # Query for existing position by api_key_id and ticker
        # Use UserTickerIndex: api_key_id (HASH), ticker (RANGE)
        response = positions_table.query(
            IndexName='UserTickerIndex',
            KeyConditionExpression='api_key_id = :api_key_id AND ticker = :ticker',
            ExpressionAttributeValues={
                ':api_key_id': api_key_id,
                ':ticker': ticker
            },
            ScanIndexForward=False,  # Most recent first
            Limit=1
        )
        
        existing_position = response.get('Items', [{}])[0] if response.get('Items') else {}
        
        # Calculate new position count
        current_position = existing_position.get('position', 0)
        if side.lower() == 'yes':
            new_position = current_position + total_contracts
        else:  # 'no' side
            new_position = current_position - total_contracts
        
        # Create new position record
        snapshot_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
        position_id = f"{api_key_id}#{ticker}#{snapshot_ts}"
        created_at = datetime.now(timezone.utc).isoformat()
        
        position_item = {
            'position_id': position_id,
            'snapshot_ts': snapshot_ts,
            'api_key_id': api_key_id,
            'user_name': user_name,
            'userid': user_name,
            'ticker': ticker,
            'position': new_position,
            'market_exposure': abs(new_position) * 100,  # Rough estimate in cents
            'resting_orders_count': 0,
            'fees_paid': existing_position.get('fees_paid', 0) + total_fee_cents,
            'realized_pnl': existing_position.get('realized_pnl', 0),
            'last_updated_ts': created_at,
            'created_at': created_at
        }
        
        positions_table.put_item(Item=position_item)
        
        logger.info(
            "Position updated",
            ticker=ticker,
            old_position=current_position,
            new_position=new_position,
            contracts_traded=total_contracts
        )
        
        # Update cash balance (decrement by total cost)
        snapshots_table = dynamodb.Table(snapshots_table_name)
        
        # Query for most recent snapshot for this user
        response = snapshots_table.query(
            KeyConditionExpression='api_key_id = :api_key_id',
            ExpressionAttributeValues={
                ':api_key_id': api_key_id
            },
            ScanIndexForward=False,  # Most recent first
            Limit=1
        )
        
        existing_snapshot = response.get('Items', [{}])[0] if response.get('Items') else {}
        current_cash = existing_snapshot.get('cash', 0)
        new_cash = current_cash - total_cost_cents
        
        # Create new snapshot with updated cash
        portfolio_value = existing_snapshot.get('portfolio_value', 0)
        snapshot_item = {
            'api_key_id': api_key_id,
            'snapshot_ts': snapshot_ts,
            'cash': new_cash,
            'portfolio_value': portfolio_value,
            'total_value': new_cash + portfolio_value,
            'updated_ts': int(datetime.now(timezone.utc).timestamp()),
            'total_positions_count': existing_snapshot.get('total_positions_count', 0),
            'user_name': user_name,
            'userid': user_name,
            'created_at': created_at
        }
        
        snapshots_table.put_item(Item=snapshot_item)
        
        logger.info(
            "Cash balance updated",
            old_cash_cents=current_cash,
            new_cash_cents=new_cash,
            cost_cents=total_cost_cents,
            old_cash_dollars=round(current_cash / 100, 2),
            new_cash_dollars=round(new_cash / 100, 2),
            cost_dollars=round(total_cost_cents / 100, 2)
        )
        
    except Exception as e:
        logger.error(
            "Failed to update portfolio after trade",
            error=str(e),
            error_type=type(e).__name__,
            ticker=ticker,
            user_name=user_name
        )
        # Don't fail the trade if portfolio update fails


def get_or_create_trading_client(
    base_url: str,
    api_key_id: str,
    private_key_pem: str,
    logger: StructuredLogger,
    read_requests_per_second: int,
    post_requests_per_second: int,
    rate_limiter_table_name: str,
    market_metadata_table_name: str,
    exit_liquidity_threshold: float,
    open_interest_limit_pct: float
) -> KalshiTradingClient:
    """Get cached KalshiTradingClient or create new one.
    
    Caches clients by (api_key_id, rate_limiter_table) for warm Lambda containers.
    Lambda containers stay warm for ~15 minutes, saving ~100-200ms on client initialization.
    
    Args:
        All KalshiTradingClient initialization parameters
        
    Returns:
        Initialized KalshiTradingClient (cached or new)
    """
    cache_key = (api_key_id, rate_limiter_table_name)
    
    if cache_key in _client_cache:
        logger.info("Using cached KalshiTradingClient", api_key_id=api_key_id)
        return _client_cache[cache_key]
    
    logger.info("Creating new KalshiTradingClient", api_key_id=api_key_id)
    client = KalshiTradingClient(
        base_url=base_url,
        api_key_id=api_key_id,
        private_key_pem=private_key_pem,
        logger=logger,
        read_requests_per_second=read_requests_per_second,
        post_requests_per_second=post_requests_per_second,
        rate_limiter_table_name=rate_limiter_table_name,
        market_metadata_table_name=market_metadata_table_name,
        exit_liquidity_threshold=exit_liquidity_threshold,
        open_interest_limit_pct=open_interest_limit_pct
    )
    _client_cache[cache_key] = client
    return client


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Execute a trade on Kalshi with safety checks and orderbook analysis.

    Expected event format:
    {
        "user_name": "jimc",                            // Required: Username for credential lookup
        "ticker": "MARKET-TICKER",
        "side": "yes" or "no",
        "max_dollar_amount": 100.0,
        "max_price": 0.75,
        "idea_id": "high-confidence-alert-v1",          // Required: Must exist in trading_ideas.json
        "idea_version": "1.2.3",                        // Required: Must exist for the idea
        "wait_for_fill": true,                          // Optional: default true
        "fill_timeout": 30.0                            // Optional: default from config (30.0)
    }

    Returns:
    {
        "statusCode": 200 or 400/500,
        "body": {
            "success": true/false,
            "trade_log": {
                "trade_id": "...",
                "idea": {...},
                "ticker": "...",
                "orderbook_snapshot": {...},
                "order": {...},
                "fills": [...],
                ...
            },
            "execution_summary": "..."
        }
    }

    Args:
        event: Lambda event containing trade parameters
        context: Lambda context object

    Returns:
        API Gateway-compatible response
    """
    logger = StructuredLogger(__name__)
    logger.info("Trading Lambda invoked", event=event)

    try:
        # Load configuration
        config = get_config()

        # Parse and validate input
        if isinstance(event.get('body'), str):
            # If body is a JSON string (from API Gateway), parse it
            body = json.loads(event['body'])
        else:
            # Direct invocation
            body = event

        # Required parameters
        user_name = body.get('user_name')
        ticker = body.get('ticker')
        side = body.get('side')
        max_dollar_amount = body.get('max_dollar_amount')
        max_price = body.get('max_price')
        idea_id = body.get('idea_id')
        idea_version = body.get('idea_version')

        # Validate user_name first
        if not user_name:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': 'Missing required parameter: user_name'
                })
            }

        # Validate required parameters
        if not ticker:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': 'Missing required parameter: ticker'
                })
            }

        # Extract event_ticker from market ticker and check prohibition EARLY
        # This is one of the first checks to avoid wasting time on prohibited events
        ticker_parts = ticker.split('-')
        if len(ticker_parts) >= 2:
            event_ticker = '-'.join(ticker_parts[:2])
        else:
            event_ticker = ticker  # Fallback if format is unexpected
        
        # Check if event is prohibited from automated trading
        is_prohibited, prohibition_reason = is_event_prohibited(event_ticker, logger)
        if is_prohibited:
            logger.warning(
                "Trade blocked - event is prohibited",
                event_ticker=event_ticker,
                ticker=ticker,
                reason=prohibition_reason
            )
            return {
                'statusCode': 403,
                'body': json.dumps({
                    'success': False,
                    'error_message': f'Event {event_ticker} is prohibited from automated trading: {prohibition_reason}',
                    'event_ticker': event_ticker,
                    'prohibition_reason': prohibition_reason
                })
            }

        if not side or side.lower() not in ['yes', 'no']:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': 'Missing or invalid parameter: side (must be "yes" or "no")'
                })
            }

        if max_dollar_amount is None or max_dollar_amount <= 0:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': 'Missing or invalid parameter: max_dollar_amount (must be > 0)'
                })
            }

        if max_price is None or max_price <= 0 or max_price > 1.0:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': 'Missing or invalid parameter: max_price (must be 0 < price <= 1.0)'
                })
            }

        if not idea_id:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': 'Missing required parameter: idea_id'
                })
            }

        if not idea_version:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': 'Missing required parameter: idea_version'
                })
            }

        # Validate idea and version exist in registry
        is_valid, error_msg = validate_trade_idea(idea_id, idea_version)
        if not is_valid:
            logger.error(
                "Invalid trading idea reference",
                idea_id=idea_id,
                idea_version=idea_version,
                error=error_msg
            )
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'success': False,
                    'error_message': f'Invalid trading idea: {error_msg}'
                })
            }

        logger.info(
            "Trading idea validated",
            idea_id=idea_id,
            idea_version=idea_version
        )

        # Auto-populate description from registry
        idea_description = get_idea_description(idea_id)
        logger.info(
            "Auto-populated idea description from registry",
            idea_id=idea_id,
            description=idea_description
        )

        # Get idea parameters (used for exit_liquidity_threshold override)
        idea_params = get_idea_parameters(idea_id, idea_version)
        if idea_params:
            logger.info(
                "Idea parameters",
                idea_id=idea_id,
                idea_version=idea_version,
                parameters=idea_params
            )
        
        # Extract exit_liquidity_threshold from idea parameters, fallback to config
        exit_liquidity_threshold = idea_params.get('exit_liquidity_threshold', config.exit_liquidity_threshold) if idea_params else config.exit_liquidity_threshold
        
        logger.info(
            "Exit liquidity threshold",
            exit_liquidity_threshold=exit_liquidity_threshold,
            from_idea_params=('exit_liquidity_threshold' in idea_params) if idea_params else False,
            config_default=config.exit_liquidity_threshold
        )

        # Auto-generate trade ID for tracking
        trade_id = str(uuid.uuid4())

        # Optional parameters
        wait_for_fill = body.get('wait_for_fill', True)
        fill_timeout = body.get('fill_timeout', config.default_fill_timeout)

        # Create trading idea
        idea = TradeIdea(
            idea_id=idea_id,
            idea_version=idea_version,
            idea_description=idea_description,
            created_time=datetime.now(timezone.utc)
        )

        logger.info(
            "Validated trade parameters",
            trade_id=trade_id,
            user_name=user_name,
            idea_id=idea_id,
            idea_version=idea_version,
            ticker=ticker,
            event_ticker=event_ticker,
            side=side,
            max_dollar_amount=max_dollar_amount,
            max_price=max_price,
            wait_for_fill=wait_for_fill,
            fill_timeout=fill_timeout
        )

        # Get user credentials from Secrets Manager
        try:
            api_key_id, private_key = get_user_config(user_name)
            logger.info("User credentials loaded", user_name=user_name, api_key_id=api_key_id)
        except (UserNotFoundError, UserDisabledError) as e:
            logger.error("User authentication failed", user_name=user_name, error=str(e))
            return {
                'statusCode': 403,
                'body': json.dumps({
                    'success': False,
                    'error_message': str(e),
                    'user_name': user_name
                })
            }

        # Initialize trading client with rate limiters (or use cached)
        trading_client = get_or_create_trading_client(
            base_url=config.kalshi_api_base_url,
            api_key_id=api_key_id,
            private_key_pem=private_key,
            logger=logger,
            read_requests_per_second=config.kalshi_read_rate_limit,
            post_requests_per_second=config.kalshi_post_rate_limit,
            rate_limiter_table_name=config.rate_limiter_table_name,
            market_metadata_table_name=config.market_metadata_table_name,
            exit_liquidity_threshold=exit_liquidity_threshold,
            open_interest_limit_pct=config.open_interest_limit_pct
        )

        # Check exchange status before trading
        try:
            exchange_status = trading_client.get_exchange_status()
            exchange_active = exchange_status.get('exchange_active', False)
            trading_active = exchange_status.get('trading_active', False)
            
            logger.info(
                "Exchange status check",
                exchange_active=exchange_active,
                trading_active=trading_active,
                status=exchange_status
            )
            
            if not exchange_active:
                error_msg = "Exchange is not active (under maintenance)"
                estimated_resume = exchange_status.get('exchange_estimated_resume_time')
                if estimated_resume:
                    error_msg += f". Estimated resume time: {estimated_resume}"
                
                logger.warning(
                    "Trading blocked - exchange inactive",
                    exchange_status=exchange_status
                )
                
                return {
                    'statusCode': 503,
                    'body': json.dumps({
                        'success': False,
                        'error_message': error_msg,
                        'exchange_status': exchange_status
                    })
                }
            
            if not trading_active:
                error_msg = "Trading is not active on the exchange"
                
                logger.warning(
                    "Trading blocked - trading inactive",
                    exchange_status=exchange_status
                )
                
                return {
                    'statusCode': 503,
                    'body': json.dumps({
                        'success': False,
                        'error_message': error_msg,
                        'exchange_status': exchange_status
                    })
                }
                
        except Exception as e:
            logger.error(
                "Failed to check exchange status",
                error=str(e),
                error_type=type(e).__name__
            )
            
            return {
                'statusCode': 503,
                'body': json.dumps({
                    'success': False,
                    'error_message': f"Failed to verify exchange status: {str(e)}. Trading blocked for safety."
                })
            }

        # Execute trade with full traceability
        result = trading_client.execute_trade(
            ticker=ticker,
            side=side.lower(),
            max_dollar_amount=max_dollar_amount,
            max_price=max_price,
            idea=idea,
            trade_id=trade_id,
            userid=user_name,
            wait_for_fill=wait_for_fill,
            fill_timeout=fill_timeout,
            order_expiration_seconds=event.get('order_expiration_seconds'),
            use_bid=idea_params.get('use_bid', False) if idea_params else False
        )

        # Convert result to dict for JSON serialization
        result_dict = result.model_dump(mode='json')

        # Persist trade initiation and completion to DynamoDB
        if config.trades_table_name:
            persist_trade_initiation(result_dict['trade_log'], config.trades_table_name, logger)
            persist_trade_completion(result_dict['trade_log'], config.trades_table_name, logger)

        # Update portfolio after trade (whether successful or timed out)
        update_portfolio_after_trade(
            user_name=user_name,
            api_key_id=api_key_id,
            ticker=ticker,
            side=side,
            fills=result_dict['trade_log'].get('fills', []),
            logger=logger
        )

        logger.info(
            "Trade execution completed",
            success=result.success,
            ticker=ticker,
            trade_id=trade_id
        )

        status_code = 200 if result.success else 400

        return {
            'statusCode': status_code,
            'headers': {
                'Content-Type': 'application/json'
            },
            'body': json.dumps(result_dict)
        }

    except Exception as e:
        logger.error(
            "Unexpected error in trading Lambda",
            error=str(e),
            error_type=type(e).__name__,
            traceback=traceback.format_exc()
        )

        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'success': False,
                'error_message': f'Internal error: {str(e)}',
                'execution_summary': f'Trade failed due to internal error: {str(e)}',
                'traceback': traceback.format_exc()
            })
        }


# For local testing
if __name__ == "__main__":
    import sys

    # Example test event
    test_event = {
        "ticker": "PRES-2024-GOP",
        "side": "yes",
        "max_dollar_amount": 10.0,
        "max_price": 0.60,
        "idea_id": "high-confidence-alert-v1",
        "idea_version": "1.2.0",
        "wait_for_fill": True,
        "fill_timeout": 30.0
    }

    print("Testing trading Lambda function locally...")
    print(f"Test event: {json.dumps(test_event, indent=2)}")
    print("\n" + "=" * 80 + "\n")

    result = lambda_handler(test_event, None)

    print(f"Status Code: {result['statusCode']}")
    print(f"Response Body:")
    print(json.dumps(json.loads(result['body']), indent=2))
