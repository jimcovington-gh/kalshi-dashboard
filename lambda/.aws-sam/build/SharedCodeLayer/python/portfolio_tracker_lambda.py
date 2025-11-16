"""Portfolio Tracker Lambda Function

Captures portfolio data (cash balance, positions, settlements) from Kalshi
for a specific user and stores in DynamoDB.

Invocation:
{
    "user_name": "jimc",  // username identifier
    "include_settlements": true  // optional, defaults to true
}

Response:
{
    "statusCode": 200,
    "summary": {...},
    "cash": {...},
    "positions": {...},
    "settlements": {...}  // omitted if include_settlements=false
}
"""

import json
import os
import boto3
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
import time

from kalshi_client import KalshiClient
from portfolio_models import (
    BalanceResponse, PositionsResponse, SettlementsResponse,
    UserMetadata, PortfolioSnapshotItem, MarketPositionItem,
    EventPositionItem, SettlementItem
)
from utils import StructuredLogger


# Initialize clients
secrets_client = boto3.client('secretsmanager')
dynamodb = boto3.resource('dynamodb')

# Environment variables
ENVIRONMENT = os.environ.get('ENVIRONMENT', 'production')
KALSHI_BASE_URL = os.environ.get('KALSHI_BASE_URL', 'https://api.elections.kalshi.com')
USER_SECRET_PREFIX = os.environ.get('USER_SECRET_PREFIX', f'{ENVIRONMENT}/kalshi/users')

# DynamoDB table names
PORTFOLIO_SNAPSHOTS_TABLE = os.environ.get('PORTFOLIO_SNAPSHOTS_TABLE')
MARKET_POSITIONS_TABLE = os.environ.get('MARKET_POSITIONS_TABLE')
EVENT_POSITIONS_TABLE = os.environ.get('EVENT_POSITIONS_TABLE')
SETTLEMENTS_TABLE = os.environ.get('SETTLEMENTS_TABLE')

# Logger
logger = StructuredLogger(__name__)

# Client cache for warm Lambda containers
# Key: api_key_id, Value: KalshiClient instance
_client_cache: Dict[str, KalshiClient] = {}


class UserNotFoundError(Exception):
    """User not configured in Secrets Manager"""
    pass


class UserDisabledError(Exception):
    """User is disabled in metadata"""
    pass


def get_all_users() -> List[str]:
    """Get list of all enabled users from S3 configuration.
    
    Reads user_idea_assignments.yaml from S3 and returns
    a list of enabled usernames.
    
    Returns:
        List of enabled usernames (e.g., ["jimc", "user2"])
    """
    try:
        # Import S3 config loader
        from s3_config_loader import get_all_enabled_users
        
        users = get_all_enabled_users()
        logger.info("Loaded enabled users from S3", user_count=len(users), users=users)
        return users
        
    except Exception as e:
        logger.error("Failed to load users from S3, falling back to Secrets Manager scan", error=str(e))
        
        # Fallback to Secrets Manager (legacy behavior)
        users = []
        try:
            # List all secrets matching the user metadata pattern
            paginator = secrets_client.get_paginator('list_secrets')
            page_iterator = paginator.paginate(
                Filters=[
                    {
                        'Key': 'name',
                        'Values': [f'{USER_SECRET_PREFIX}/']
                    }
                ]
            )
            
            for page in page_iterator:
                for secret in page.get('SecretList', []):
                    secret_name = secret['Name']
                    
                    # Only process metadata secrets (not private-key secrets)
                    if secret_name.endswith('/metadata'):
                        # Extract username from path: production/kalshi/users/USERNAME/metadata
                        parts = secret_name.split('/')
                        if len(parts) >= 5:  # Should be: env/kalshi/users/USERNAME/metadata
                            user_name = parts[-2]  # Username is second-to-last part
                            
                            # Check if user is enabled
                            try:
                                response = secrets_client.get_secret_value(SecretId=secret_name)
                                metadata_dict = json.loads(response['SecretString'])
                                metadata = UserMetadata(**metadata_dict)
                                
                                if metadata.enabled:
                                    users.append(user_name)
                                    logger.info("Found enabled user (Secrets Manager)", user_name=user_name)
                                else:
                                    logger.info("Skipping disabled user (Secrets Manager)", user_name=user_name)
                            except Exception as e:
                                logger.warning("Error checking user metadata",
                                             user_name=user_name,
                                             error=str(e))
        
            logger.info("User scan completed (Secrets Manager fallback)", total_enabled_users=len(users), users=users)
            return users
            
        except Exception as inner_e:
            logger.error("Error scanning Secrets Manager for users", error=str(inner_e))
            return []
        raise
    
    return users


def get_user_config(user_name: str) -> tuple[str, str, UserMetadata]:
    """Retrieve user configuration from Secrets Manager.
    
    Retrieves API key ID, private key, and metadata for a given username.
    
    Args:
        user_name: Username identifier (e.g., "jimc")
        
    Returns:
        Tuple of (api_key_id, private_key, metadata)
        
    Raises:
        UserNotFoundError: If user secrets don't exist
        UserDisabledError: If user is disabled
    """
    # Get metadata (contains api_key_id and enabled flag)
    metadata_secret_name = f'{USER_SECRET_PREFIX}/{user_name}/metadata'
    
    try:
        response = secrets_client.get_secret_value(SecretId=metadata_secret_name)
        metadata_dict = json.loads(response['SecretString'])
        metadata = UserMetadata(**metadata_dict)
        
        if not metadata.enabled:
            raise UserDisabledError(
                f"User {user_name} is disabled (disabled_at: {metadata.disabled_at})"
            )
        
        # Extract api_key_id from metadata
        api_key_id = metadata_dict.get('api_key_id')
        if not api_key_id:
            raise UserNotFoundError(
                f"User {user_name} metadata missing api_key_id field"
            )
        
        logger.info("User metadata loaded", 
                   user_name=user_name,
                   api_key_id=api_key_id,
                   enabled=metadata.enabled)
        
    except secrets_client.exceptions.ResourceNotFoundException:
        raise UserNotFoundError(
            f"User {user_name} not configured. "
            f"Expected secret: {metadata_secret_name}"
        )
    
    # Get private key
    private_key_secret_name = f'{USER_SECRET_PREFIX}/{user_name}/private-key'
    
    try:
        response = secrets_client.get_secret_value(SecretId=private_key_secret_name)
        secret_string = response['SecretString']
        
        # Handle both formats: plain text PEM or JSON {"private_key": "..."}
        if secret_string.strip().startswith('-----BEGIN'):
            # Plain text PEM format
            private_key = secret_string
        else:
            # JSON format
            secret_data = json.loads(secret_string)
            private_key = secret_data['private_key']
        
        logger.info("Private key loaded", user_name=user_name)
        
    except secrets_client.exceptions.ResourceNotFoundException:
        raise UserNotFoundError(
            f"Private key for user {user_name} not found. "
            f"Expected secret: {private_key_secret_name}"
        )
    
    return api_key_id, private_key, metadata


def get_or_create_client(api_key_id: str, private_key: str) -> KalshiClient:
    """Get cached KalshiClient or create new one.
    
    Caches clients by api_key_id for warm Lambda containers.
    With 10-minute invocations, Lambda containers stay warm (~15min idle timeout),
    saving ~158ms on client initialization.
    
    Args:
        api_key_id: User's API key ID
        private_key: User's RSA private key
        
    Returns:
        Initialized KalshiClient (cached or new)
    """
    if api_key_id in _client_cache:
        logger.info("Using cached KalshiClient", api_key_id=api_key_id)
        return _client_cache[api_key_id]
    
    logger.info("Creating new KalshiClient", api_key_id=api_key_id)
    client = KalshiClient(
        base_url=KALSHI_BASE_URL,
        api_key_id=api_key_id,
        private_key_pem=private_key,
        logger=logger,
        requests_per_second=20,
        write_requests_per_second=2
    )
    _client_cache[api_key_id] = client
    return client


def capture_balance(client: KalshiClient, api_key_id: str, user_name: str) -> Dict[str, Any]:
    """Capture cash balance and portfolio value.
    
    Only writes snapshot to DynamoDB on the hour (:00 minutes).
    Always returns balance info for positions capture.
    
    Args:
        client: Initialized KalshiClient
        api_key_id: User's API key ID
        user_name: User's friendly name
        
    Returns:
        Dict with cash balance info and DynamoDB write status
    """
    start_time = time.time()
    logger.info("Capturing cash balance", api_key_id=api_key_id)
    
    # API call - endpoint still called 'balance'
    api_start = time.time()
    response = client._make_request('GET', '/trade-api/v2/portfolio/balance')
    api_time = (time.time() - api_start) * 1000
    
    balance_response = BalanceResponse(**response)
    
    # Create snapshot
    now = datetime.now(timezone.utc)
    snapshot_ts = int(now.timestamp() * 1000)
    created_at = now.isoformat()
    
    # Only write snapshot on the hour (:00 minutes)
    current_minute = now.minute
    should_write_snapshot = (current_minute == 0)
    
    if should_write_snapshot:
        snapshot_item = PortfolioSnapshotItem(
            api_key_id=api_key_id,
            snapshot_ts=snapshot_ts,
            cash=balance_response.balance,  # API returns 'balance', we store as 'cash'
            portfolio_value=balance_response.portfolio_value,
            total_value=balance_response.balance + balance_response.portfolio_value,  # Total account value
            updated_ts=balance_response.updated_ts,
            total_positions_count=0,  # Will be updated after positions
            user_name=user_name,
            userid=user_name,  # Use username as userid
            created_at=created_at
        )
        
        # Write to DynamoDB
        db_start = time.time()
        table = dynamodb.Table(PORTFOLIO_SNAPSHOTS_TABLE)
        table.put_item(Item=snapshot_item.dict())
        db_time = (time.time() - db_start) * 1000
        
        logger.info("Portfolio snapshot written (hourly)",
                   api_key_id=api_key_id,
                   snapshot_hour=now.strftime('%Y-%m-%d %H:00'))
    else:
        db_time = 0
        logger.info("Portfolio snapshot skipped (only write on :00)",
                   api_key_id=api_key_id,
                   current_minute=current_minute)
    
    total_time = (time.time() - start_time) * 1000
    
    logger.info("Cash balance captured",
               api_key_id=api_key_id,
               cash=balance_response.balance,
               portfolio_value=balance_response.portfolio_value,
               timing_ms={'total': round(total_time, 2), 'api': round(api_time, 2), 'db': round(db_time, 2)})
    
    return {
        'cash': balance_response.balance,
        'portfolio_value': balance_response.portfolio_value,
        'updated_ts': balance_response.updated_ts,
        'snapshot_ts': snapshot_ts,
        'snapshot_written': should_write_snapshot
    }


def capture_positions(
    client: KalshiClient,
    api_key_id: str,
    user_name: str,
    snapshot_ts: int,
    snapshot_written: bool = False
) -> Dict[str, Any]:
    """Capture all market and event positions.
    
    Args:
        client: Initialized KalshiClient
        api_key_id: User's API key ID
        user_name: User's friendly name
        snapshot_ts: Timestamp for this capture session
        snapshot_written: Whether a portfolio snapshot was written
        
    Returns:
        Dict with position counts and total exposure
    """
    start_time = time.time()
    logger.info("Capturing positions", api_key_id=api_key_id)
    
    market_positions_table = dynamodb.Table(MARKET_POSITIONS_TABLE)
    event_positions_table = dynamodb.Table(EVENT_POSITIONS_TABLE)
    
    all_market_positions = []
    all_event_positions = []
    cursor = None
    page = 1
    created_at = datetime.now(timezone.utc).isoformat()
    
    # Paginate through all positions
    api_time = 0
    while True:
        params = {'limit': 1000}  # Max allowed
        if cursor:
            params['cursor'] = cursor
        
        api_start = time.time()
        response = client._make_request('GET', '/trade-api/v2/portfolio/positions', params=params)
        api_time += (time.time() - api_start) * 1000
        
        positions = PositionsResponse(**response)
        
        all_market_positions.extend(positions.market_positions)
        all_event_positions.extend(positions.event_positions)
        
        logger.info("Positions page retrieved",
                   page=page,
                   market_count=len(positions.market_positions),
                   event_count=len(positions.event_positions))
        
        cursor = positions.cursor
        if not cursor:
            break
        
        page += 1
    
    # Delete old positions for this user before inserting new ones
    db_start = time.time()
    
    # Delete all existing market positions for this user
    logger.info("Deleting old market positions", api_key_id=api_key_id)
    response = market_positions_table.query(
        IndexName='UserTickerIndex',
        KeyConditionExpression='api_key_id = :api_key_id',
        ExpressionAttributeValues={':api_key_id': api_key_id},
        ProjectionExpression='position_id, snapshot_ts'
    )
    
    old_items = response.get('Items', [])
    while response.get('LastEvaluatedKey'):
        response = market_positions_table.query(
            IndexName='UserTickerIndex',
            KeyConditionExpression='api_key_id = :api_key_id',
            ExpressionAttributeValues={':api_key_id': api_key_id},
            ProjectionExpression='position_id, snapshot_ts',
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        old_items.extend(response.get('Items', []))
    
    # Batch delete old market positions
    if old_items:
        for i in range(0, len(old_items), 25):
            batch = old_items[i:i+25]
            with market_positions_table.batch_writer() as batch_writer:
                for item in batch:
                    batch_writer.delete_item(Key={
                        'position_id': item['position_id'],
                        'snapshot_ts': item['snapshot_ts']
                    })
        logger.info("Deleted old market positions", count=len(old_items))
    
    # Delete all existing event positions for this user
    logger.info("Deleting old event positions", api_key_id=api_key_id)
    response = event_positions_table.query(
        IndexName='UserEventIndex',
        KeyConditionExpression='api_key_id = :api_key_id',
        ExpressionAttributeValues={':api_key_id': api_key_id},
        ProjectionExpression='position_id, snapshot_ts'
    )
    
    old_event_items = response.get('Items', [])
    while response.get('LastEvaluatedKey'):
        response = event_positions_table.query(
            IndexName='UserEventIndex',
            KeyConditionExpression='api_key_id = :api_key_id',
            ExpressionAttributeValues={':api_key_id': api_key_id},
            ProjectionExpression='position_id, snapshot_ts',
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        old_event_items.extend(response.get('Items', []))
    
    if old_event_items:
        for i in range(0, len(old_event_items), 25):
            batch = old_event_items[i:i+25]
            with event_positions_table.batch_writer() as batch_writer:
                for item in batch:
                    batch_writer.delete_item(Key={
                        'position_id': item['position_id'],
                        'snapshot_ts': item['snapshot_ts']
                    })
        logger.info("Deleted old event positions", count=len(old_event_items))
    
    # Prepare new items for batch write
    market_items = []
    
    for position in all_market_positions:
        position_id = f"{api_key_id}#{position.ticker}#{snapshot_ts}"
        
        item = MarketPositionItem(
            position_id=position_id,
            snapshot_ts=snapshot_ts,
            api_key_id=api_key_id,
            ticker=position.ticker,
            total_traded=position.total_traded,
            total_traded_dollars=position.total_traded_dollars,
            position=position.position,
            market_exposure=position.market_exposure,
            market_exposure_dollars=position.market_exposure_dollars,
            realized_pnl=position.realized_pnl,
            realized_pnl_dollars=position.realized_pnl_dollars,
            resting_orders_count=position.resting_orders_count,
            fees_paid=position.fees_paid,
            fees_paid_dollars=position.fees_paid_dollars,
            last_updated_ts=position.last_updated_ts,
            user_name=user_name,
            userid=user_name,  # Use username as userid
            created_at=created_at
        )
        
        market_items.append(item.dict())
    
    # Prepare event position items
    event_items = []
    for position in all_event_positions:
        position_id = f"{api_key_id}#{position.event_ticker}#{snapshot_ts}"
        
        item = EventPositionItem(
            position_id=position_id,
            snapshot_ts=snapshot_ts,
            api_key_id=api_key_id,
            event_ticker=position.event_ticker,
            total_cost=position.total_cost,
            total_cost_dollars=position.total_cost_dollars,
            total_cost_shares=position.total_cost_shares,
            event_exposure=position.event_exposure,
            event_exposure_dollars=position.event_exposure_dollars,
            realized_pnl=position.realized_pnl,
            realized_pnl_dollars=position.realized_pnl_dollars,
            resting_order_count=position.resting_order_count,
            fees_paid=position.fees_paid,
            fees_paid_dollars=position.fees_paid_dollars,
            user_name=user_name,
            userid=user_name,  # Use username as userid
            created_at=created_at
        )
        
        event_items.append(item.dict())
    
    # Batch write all positions to DynamoDB
    market_positions_table = dynamodb.Table(MARKET_POSITIONS_TABLE)
    event_positions_table = dynamodb.Table(EVENT_POSITIONS_TABLE)
    
    # DynamoDB batch_write_item supports max 25 items per batch
    def batch_write_items(table_name: str, items: list):
        """Write items in batches of 25"""
        for i in range(0, len(items), 25):
            batch = items[i:i+25]
            request_items = {
                table_name: [{'PutRequest': {'Item': item}} for item in batch]
            }
            dynamodb.meta.client.batch_write_item(RequestItems=request_items)
    
    if market_items:
        batch_write_items(MARKET_POSITIONS_TABLE, market_items)
    
    if event_items:
        batch_write_items(EVENT_POSITIONS_TABLE, event_items)
    
    db_time = (time.time() - db_start) * 1000
    
    # Update snapshot with position counts
    # Update snapshot with position count ONLY if snapshot was written
    if snapshot_written:
        try:
            snapshots_table = dynamodb.Table(PORTFOLIO_SNAPSHOTS_TABLE)
            snapshots_table.update_item(
                Key={
                    'api_key_id': api_key_id,
                    'snapshot_ts': snapshot_ts
                },
                UpdateExpression='SET total_positions_count = :count',
                ExpressionAttributeValues={
                    ':count': len(all_market_positions)
                }
            )
        except Exception as e:
            logger.error("Failed to update snapshot with position count", error=str(e))
    else:
        logger.debug("Skipping snapshot update (no snapshot written this minute)")
    
    total_time = (time.time() - start_time) * 1000
    
    logger.info("Positions captured",
               api_key_id=api_key_id,
               market_positions=len(all_market_positions),
               event_positions=len(all_event_positions),
               timing_ms={'total': round(total_time, 2), 'api': round(api_time, 2), 'db': round(db_time, 2)})
    
    return {
        'market_positions_count': len(all_market_positions),
        'event_positions_count': len(all_event_positions)
    }


def capture_settlements(
    client: KalshiClient,
    api_key_id: str,
    user_name: str,
    lookback_hours: int = 24
) -> Dict[str, Any]:
    """Capture settlements from specified lookback period.
    
    Args:
        client: Initialized KalshiClient
        api_key_id: User's API key ID
        user_name: User's friendly name
        lookback_hours: Hours to look back for settlements (default: 24)
        
    Returns:
        Dict with settlement counts and totals
    """
    logger.info("Capturing settlements", 
               api_key_id=api_key_id,
               lookback_hours=lookback_hours)
    
    settlements_table = dynamodb.Table(SETTLEMENTS_TABLE)
    
    # Calculate lookback time
    now = datetime.now(timezone.utc)
    lookback = now - timedelta(hours=lookback_hours)
    min_ts = int(lookback.timestamp())
    
    all_settlements = []
    cursor = None
    page = 1
    captured_at = now.isoformat()
    ttl_expiry = int((now + timedelta(days=30)).timestamp())  # 30 days TTL
    
    # Paginate through settlements
    while True:
        params = {
            'limit': 200,  # Max allowed for settlements
            'min_ts': min_ts
        }
        if cursor:
            params['cursor'] = cursor
        
        response = client._make_request('GET', '/trade-api/v2/portfolio/settlements', params=params)
        settlements = SettlementsResponse(**response)
        
        all_settlements.extend(settlements.settlements)
        
        logger.info("Settlements page retrieved",
                   page=page,
                   count=len(settlements.settlements))
        
        cursor = settlements.cursor
        if not cursor or len(settlements.settlements) == 0:
            break
        
        page += 1
    
    # Write settlements to DynamoDB
    total_revenue = 0
    total_fees = 0
    total_pnl = 0
    
    for settlement in all_settlements:
        settlement_id = f"{api_key_id}#{settlement.ticker}"
        
        # Parse settled_time to Unix timestamp
        settled_dt = datetime.fromisoformat(settlement.settled_time.replace('Z', '+00:00'))
        settled_time_ts = int(settled_dt.timestamp())
        
        item = SettlementItem(
            settlement_id=settlement_id,
            settled_time=settlement.settled_time,
            api_key_id=api_key_id,
            ticker=settlement.ticker,
            market_result=settlement.market_result,
            yes_count=settlement.yes_count,
            yes_total_cost=settlement.yes_total_cost,
            no_count=settlement.no_count,
            no_total_cost=settlement.no_total_cost,
            revenue=settlement.revenue,
            settled_time_ts=settled_time_ts,
            fee_cost=settlement.fee_cost,
            value=settlement.value,
            user_name=user_name,
            userid=user_name,  # Use username as userid
            captured_at=captured_at,
            ttl=ttl_expiry
        )
        
        settlements_table.put_item(Item=item.dict())
        
        total_revenue += settlement.revenue
        if settlement.fee_cost is not None:
            total_fees += int(float(settlement.fee_cost) * 100)  # Convert to cents
        total_pnl += settlement.value
    
    logger.info("Settlements captured",
               api_key_id=api_key_id,
               count=len(all_settlements),
               total_revenue=total_revenue,
               total_pnl=total_pnl)
    
    return {
        'count': len(all_settlements),
        'total_revenue': total_revenue,
        'total_fees': total_fees,
        'net_pnl': total_pnl
    }


def handle_all_users(
    include_settlements: bool,
    settlement_lookback_hours: int,
    start_time: float
) -> Dict[str, Any]:
    """Process all enabled users sequentially.
    
    Args:
        include_settlements: Whether to capture settlements
        settlement_lookback_hours: Hours to look back for settlements
        start_time: Lambda invocation start time
        
    Returns:
        Dict with results for all users
    """
    logger.info("Multi-user capture started (all users mode)")
    
    # Get all enabled users
    try:
        users = get_all_users()
    except Exception as e:
        logger.error("Failed to get user list", error=str(e))
        return {
            'statusCode': 500,
            'error': f'Failed to get user list: {str(e)}',
            'error_type': type(e).__name__
        }
    
    if not users:
        logger.warning("No enabled users found")
        return {
            'statusCode': 200,
            'summary': {
                'status': 'success',
                'mode': 'all_users',
                'total_users': 0,
                'successful': 0,
                'failed': 0,
                'execution_time_ms': int((time.time() - start_time) * 1000)
            },
            'users': {}
        }
    
    # Process each user
    user_results = {}
    successful = 0
    failed = 0
    
    for user_name in users:
        user_start = time.time()
        
        try:
            logger.info("Processing user", user_name=user_name)
            
            # Get user config
            api_key_id, private_key, metadata = get_user_config(user_name)
            
            # Get or create client
            client = get_or_create_client(api_key_id, private_key)
            
            # Capture balance
            balance_info = capture_balance(client, api_key_id, user_name)
            snapshot_ts = balance_info['snapshot_ts']
            snapshot_written = balance_info['snapshot_written']
            
            # Capture positions
            positions_info = capture_positions(client, api_key_id, user_name, snapshot_ts, snapshot_written)
            
            # Capture settlements (optional)
            settlements_info = None
            if include_settlements:
                settlements_info = capture_settlements(client, api_key_id, user_name, settlement_lookback_hours)
            
            user_time = int((time.time() - user_start) * 1000)
            
            user_results[user_name] = {
                'status': 'success',
                'api_key_id': api_key_id,
                'cash': balance_info['cash'],
                'portfolio_value': balance_info['portfolio_value'],
                'positions': positions_info,
                'settlements': settlements_info if include_settlements else None,
                'execution_time_ms': user_time
            }
            
            successful += 1
            logger.info("User processing completed", 
                       user_name=user_name,
                       execution_time_ms=user_time)
            
        except Exception as e:
            user_time = int((time.time() - user_start) * 1000)
            
            user_results[user_name] = {
                'status': 'failed',
                'error': str(e),
                'error_type': type(e).__name__,
                'execution_time_ms': user_time
            }
            
            failed += 1
            logger.error("User processing failed",
                        user_name=user_name,
                        error=str(e),
                        error_type=type(e).__name__)
    
    # Final summary
    total_time = int((time.time() - start_time) * 1000)
    
    logger.info("Multi-user capture completed",
               total_users=len(users),
               successful=successful,
               failed=failed,
               execution_time_ms=total_time)
    
    return {
        'statusCode': 200,
        'summary': {
            'status': 'success',
            'mode': 'all_users',
            'total_users': len(users),
            'successful': successful,
            'failed': failed,
            'execution_time_ms': total_time
        },
        'users': user_results
    }


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Main Lambda handler for portfolio capture.
    
    Supports both individual user capture and multi-user "all" mode.
    
    Args:
        event: Lambda event with user_name (specific user or "all")
        context: Lambda context
        
    Returns:
        Response dict with portfolio data and status
    """
    start_time = time.time()
    timing = {}
    
    try:
        # Validate input
        user_name = event.get('user_name')
        if not user_name:
            return {
                'statusCode': 400,
                'error': 'Missing required parameter: user_name',
                'error_type': 'ValidationError'
            }
        
        # Get optional parameters
        include_settlements = event.get('include_settlements', True)
        settlement_lookback_hours = event.get('settlement_lookback_hours', 24)
        
        # Handle "all" users mode
        if user_name.lower() == "all":
            return handle_all_users(include_settlements, settlement_lookback_hours, start_time)
        
        # Single user mode (existing behavior)
        logger.info("Portfolio capture started", 
                   user_name=user_name,
                   include_settlements=include_settlements,
                   settlement_lookback_hours=settlement_lookback_hours)
        
        # Get user configuration (api_key_id, private_key, metadata)
        secrets_start = time.time()
        api_key_id, private_key, metadata = get_user_config(user_name)
        timing['secrets_ms'] = round((time.time() - secrets_start) * 1000, 2)
        
        # Get or create cached Kalshi client (saves ~158ms on warm containers)
        client_start = time.time()
        client = get_or_create_client(api_key_id, private_key)
        timing['client_init_ms'] = round((time.time() - client_start) * 1000, 2)
        
        # Capture balance
        balance_info = capture_balance(client, api_key_id, user_name)
        snapshot_ts = balance_info['snapshot_ts']
        snapshot_written = balance_info['snapshot_written']
        
        # Capture positions
        positions_info = capture_positions(client, api_key_id, user_name, snapshot_ts, snapshot_written)
        
        # Capture settlements (optional)
        settlements_info = None
        if include_settlements:
            settlements_info = capture_settlements(client, api_key_id, user_name, settlement_lookback_hours)
        
        # Calculate execution time
        execution_time_ms = int((time.time() - start_time) * 1000)
        timing['total_ms'] = execution_time_ms
        
        logger.info("Portfolio capture completed",
                   api_key_id=api_key_id,
                   user_name=user_name,
                   include_settlements=include_settlements,
                   execution_time_ms=execution_time_ms,
                   timing_breakdown=timing)
        
        response = {
            'statusCode': 200,
            'summary': {
                'api_key_id': api_key_id,
                'user_name': user_name,
                'status': 'success',
                'execution_time_ms': execution_time_ms,
                'timing': timing
            },
            'cash': {
                'cash': balance_info['cash'],
                'portfolio_value': balance_info['portfolio_value'],
                'updated_ts': balance_info['updated_ts']
            },
            'positions': positions_info
        }
        
        # Only include settlements in response if requested
        if include_settlements and settlements_info:
            response['settlements'] = settlements_info
        
        return response
        
    except UserNotFoundError as e:
        logger.error("User not found", error=str(e), user_name=event.get('user_name'))
        return {
            'statusCode': 404,
            'error': str(e),
            'error_type': 'UserNotFoundError',
            'user_name': event.get('user_name')
        }
        
    except UserDisabledError as e:
        logger.error("User disabled", error=str(e), user_name=event.get('user_name'))
        return {
            'statusCode': 403,
            'error': str(e),
            'error_type': 'UserDisabledError',
            'user_name': event.get('user_name')
        }
        
    except Exception as e:
        logger.error("Portfolio capture failed",
                    error=str(e),
                    error_type=type(e).__name__,
                    user_name=event.get('user_name'))
        return {
            'statusCode': 500,
            'error': str(e),
            'error_type': type(e).__name__,
            'user_name': event.get('user_name')
        }

