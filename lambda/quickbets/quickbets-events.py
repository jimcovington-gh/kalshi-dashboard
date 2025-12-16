"""
QuickBets Events Lambda

Fetches active sports events from Kalshi API and filters based on:
- User's running sessions (shown with "reconnect" option)
- Other users' running sessions (hidden from dropdown)
- Available events (no Fargate running)
"""

import json
import os
import time
import base64
import hashlib
import boto3
import urllib3
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from botocore.exceptions import ClientError

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


# Kalshi API base URL
KALSHI_API_BASE = os.environ.get('KALSHI_API_BASE_URL', 'https://api.elections.kalshi.com')

# DynamoDB tables
SESSIONS_TABLE = os.environ.get('SESSIONS_TABLE', 'production-kalshi-quickbets-sessions')
EVENT_METADATA_TABLE = os.environ.get('EVENT_METADATA_TABLE', 'production-kalshi-event-metadata')

# Secrets Manager for Kalshi API credentials
KALSHI_API_KEY_SECRET = os.environ.get('KALSHI_API_KEY_SECRET', 'production-kalshi-api-key-id')
KALSHI_PRIVATE_KEY_SECRET = os.environ.get('KALSHI_PRIVATE_KEY_SECRET', 'production-kalshi-private-key')

http = urllib3.PoolManager()

# Cache for credentials (reused across invocations)
_kalshi_credentials = None

# Secrets client for credential checks
_secrets_client = None

def get_secrets_client():
    """Get cached Secrets Manager client."""
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client('secretsmanager')
    return _secrets_client


def decimal_default(obj):
    """Handle Decimal serialization for JSON."""
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def check_user_trading_credentials(username: str) -> tuple[bool, str]:
    """
    Check if user has Kalshi trading credentials in Secrets Manager.
    
    Returns:
        Tuple of (has_credentials: bool, error_message: str)
    """
    secret_prefix = f'production/kalshi/users/{username}'
    secrets_client = get_secrets_client()
    
    try:
        # Check if metadata secret exists (contains API key)
        secrets_client.describe_secret(SecretId=f'{secret_prefix}/metadata')
        
        # Check if private key secret exists
        secrets_client.describe_secret(SecretId=f'{secret_prefix}/private-key')
        
        print(f"User {username} has valid trading credentials")
        return True, ""
        
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        
        if error_code == 'ResourceNotFoundException':
            error_msg = (
                f"No Kalshi trading credentials configured for this account. "
                f"QuickBets requires a user with configured Kalshi API keys. "
                f"Please log in with a different account that has trading access, "
                f"or contact an administrator to set up your trading credentials."
            )
            print(f"User {username} missing trading credentials")
            return False, error_msg
        else:
            error_msg = f"Error checking credentials: {str(e)}"
            print(error_msg)
            return False, error_msg
    except Exception as e:
        error_msg = f"Unexpected error checking credentials: {str(e)}"
        print(error_msg)
        return False, error_msg


def get_kalshi_credentials():
    """Get Kalshi API credentials from Secrets Manager (cached)."""
    global _kalshi_credentials
    if _kalshi_credentials:
        return _kalshi_credentials
    
    secrets_client = boto3.client('secretsmanager')
    
    try:
        api_key_response = secrets_client.get_secret_value(SecretId=KALSHI_API_KEY_SECRET)
        api_key = api_key_response['SecretString']
        
        private_key_response = secrets_client.get_secret_value(SecretId=KALSHI_PRIVATE_KEY_SECRET)
        private_key = private_key_response['SecretString']
        
        _kalshi_credentials = (api_key, private_key)
        return _kalshi_credentials
    except Exception as e:
        print(f"Failed to get Kalshi credentials: {e}")
        return None, None


def sign_kalshi_request(private_key_pem: str, timestamp: str, method: str, path: str) -> str:
    """Sign a Kalshi API request using RSA-PSS."""
    # Message format: timestamp + method + path (no body, no query params in signature)
    path_without_query = path.split('?')[0]
    message = f"{timestamp}{method}{path_without_query}"
    
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode('utf-8'),
        password=None
    )
    
    signature = private_key.sign(
        message.encode('utf-8'),
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH
        ),
        hashes.SHA256()
    )
    
    return base64.b64encode(signature).decode('utf-8')


def fetch_milestone_for_event(event_ticker: str) -> int | None:
    """Fetch start_date from Kalshi milestones API for a single event.
    
    Returns:
        start_timestamp (int) if found, None otherwise
    """
    api_key, private_key = get_kalshi_credentials()
    if not api_key or not private_key:
        return None
    
    timestamp = str(int(time.time() * 1000))
    path = f'/trade-api/v2/milestones?event_ticker={event_ticker}&limit=200'
    
    signature = sign_kalshi_request(private_key, timestamp, 'GET', path)
    
    headers = {
        'KALSHI-ACCESS-KEY': api_key,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json'
    }
    
    try:
        resp = http.request('GET', f'{KALSHI_API_BASE}{path}', headers=headers, timeout=5.0)
        
        if resp.status != 200:
            print(f"Milestones API returned {resp.status} for {event_ticker}")
            return None
        
        data = json.loads(resp.data.decode('utf-8'))
        milestones = data.get('milestones', [])
        
        if not milestones:
            return None
        
        # Get start_date from first milestone
        start_date_str = milestones[0].get('start_date')
        if start_date_str:
            start_dt = datetime.fromisoformat(start_date_str.replace('Z', '+00:00'))
            return int(start_dt.timestamp())
        
        return None
        
    except Exception as e:
        print(f"Error fetching milestone for {event_ticker}: {e}")
        return None


def cache_start_date(event_ticker: str, start_timestamp: int):
    """Cache start_date in DynamoDB for future requests."""
    try:
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(EVENT_METADATA_TABLE)
        
        table.update_item(
            Key={'event_ticker': event_ticker},
            UpdateExpression='SET start_date = :sd, last_updated = :lu',
            ExpressionAttributeValues={
                ':sd': start_timestamp,
                ':lu': int(time.time())
            }
        )
        print(f"Cached start_date for {event_ticker}: {start_timestamp}")
    except Exception as e:
        print(f"Failed to cache start_date for {event_ticker}: {e}")


def get_active_sports_events():
    """Fetch active sports events from DynamoDB event metadata, filtered to 5 hours ago through 1 hour ahead."""
    events = []
    now = datetime.now(timezone.utc)
    now_ts = int(now.timestamp())
    max_ts = int((now + timedelta(hours=1)).timestamp())
    min_ts = int((now - timedelta(hours=5)).timestamp())  # Games started up to 5 hours ago (in progress)
    
    # Query DynamoDB for sports events
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(EVENT_METADATA_TABLE)
    
    try:
        # Scan for sports category events within time window
        response = table.scan(
            FilterExpression='category = :cat AND strike_date > :min_ts AND strike_date < :max_ts',
            ExpressionAttributeValues={
                ':cat': 'sports',
                ':min_ts': min_ts,
                ':max_ts': max_ts + (3 * 3600)  # Add 3 hours since strike_date is ~3h after game start
            }
        )
        
        items = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression='category = :cat AND strike_date > :min_ts AND strike_date < :max_ts',
                ExpressionAttributeValues={
                    ':cat': 'sports',
                    ':min_ts': min_ts,
                    ':max_ts': max_ts + (3 * 3600)
                },
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response.get('Items', []))
        
        # Track events needing milestone fetch (no start_date cached)
        events_needing_milestones = []
        
        for item in items:
            event_ticker = item.get('event_ticker', '')
            series_ticker = item.get('series_ticker', '')
            strike_date = int(item.get('strike_date', 0))
            
            # Only include main game events (series_ticker ends with GAME)
            # Skip derivative markets like BTTS, TOTAL, SPREAD, AST, etc.
            if not series_ticker.endswith('GAME'):
                continue
            
            # Use start_date from DynamoDB if available (populated from milestones),
            # otherwise mark for milestone fetch
            start_date_from_db = item.get('start_date')
            if start_date_from_db:
                start_timestamp = int(start_date_from_db)
                needs_fetch = False
            else:
                # Fallback: estimate game start time (strike_date minus 3 hours)
                # This will be corrected if we can fetch from milestones API
                start_timestamp = strike_date - (3 * 3600)
                needs_fetch = True
            
            start_datetime = datetime.fromtimestamp(start_timestamp, tz=timezone.utc)
            
            # Format for display: "Mon Dec 15 @ 8:15 PM EST"
            est_time = start_datetime - timedelta(hours=5)
            start_time_formatted = est_time.strftime('%a %b %-d @ %-I:%M %p EST')
            
            event_data = {
                'event_ticker': event_ticker,
                'title': item.get('title', ''),
                'series_ticker': series_ticker,
                'category': 'sports',
                'event_time': start_time_formatted,
                'event_timestamp': start_timestamp,
                'sub_title': item.get('sub_title', ''),
                '_needs_milestone_fetch': needs_fetch
            }
            events.append(event_data)
            
            if needs_fetch:
                events_needing_milestones.append(event_data)
        
        # Fetch milestones for events missing start_date (limit to avoid timeout)
        # Only fetch for the first few events since they're sorted by time
        if events_needing_milestones:
            print(f"Fetching milestones for {len(events_needing_milestones)} events without cached start_date")
            fetched_count = 0
            for evt in events_needing_milestones[:5]:  # Limit to 5 API calls
                start_ts = fetch_milestone_for_event(evt['event_ticker'])
                if start_ts:
                    # Update the event in our list
                    evt['event_timestamp'] = start_ts
                    start_dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
                    est_time = start_dt - timedelta(hours=5)
                    evt['event_time'] = est_time.strftime('%a %b %-d @ %-I:%M %p EST')
                    evt['_needs_milestone_fetch'] = False
                    
                    # Cache for future requests
                    cache_start_date(evt['event_ticker'], start_ts)
                    fetched_count += 1
            print(f"Successfully fetched {fetched_count} milestones")
        
        # Clean up internal flag before returning
        for evt in events:
            evt.pop('_needs_milestone_fetch', None)
        
        # Filter by actual event_timestamp (game start time), not strike_date
        # This ensures we only return games that started within the last 5 hours
        # or will start within the next hour
        pre_filter_count = len(events)
        events = [e for e in events if min_ts <= e.get('event_timestamp', 0) <= max_ts]
        print(f"Time filter: {pre_filter_count} events -> {len(events)} events (min_ts={min_ts}, max_ts={max_ts})")
            
    except Exception as e:
        print(f"Error fetching sports events from DynamoDB: {e}")
        import traceback
        traceback.print_exc()
    
    # Sort by start time (soonest first)
    events.sort(key=lambda x: x.get('event_timestamp', 0))
    
    return events


def get_running_sessions():
    """Get all running QuickBets sessions from DynamoDB."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(SESSIONS_TABLE)
    
    response = table.scan()
    sessions = response.get('Items', [])
    
    # Filter by TTL
    now = int(time.time())
    active = {}
    
    for session in sessions:
        ttl = int(session.get('ttl', 0))
        if ttl > now:
            event_ticker = session.get('event_ticker', '')
            active[event_ticker] = {
                'user_name': session.get('user_name', ''),
                'websocket_url': session.get('websocket_url', ''),
                'fargate_task_arn': session.get('fargate_task_arn', ''),
                'started_at': session.get('started_at', 0)
            }
    
    return active


def lambda_handler(event, context):
    """Get available sports events for QuickBets."""
    
    # Handle CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': ''
        }
    
    try:
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        current_user = claims.get('preferred_username', '')
        
        if not current_user:
            return {
                'statusCode': 401,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                'body': json.dumps({'error': 'Authentication required - preferred_username not set'})
            }
        
        print(f"User: {current_user}")
        
        # Check if user has Kalshi trading credentials BEFORE fetching events
        has_credentials, cred_error = check_user_trading_credentials(current_user)
        if not has_credentials:
            return {
                'statusCode': 403,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                'body': json.dumps({
                    'error': cred_error,
                    'error_code': 'NO_TRADING_CREDENTIALS'
                })
            }
        
        # Fetch active sports events from Kalshi
        sports_events = get_active_sports_events()
        
        # Get running sessions
        running_sessions = get_running_sessions()
        
        # Categorize events
        available_events = []
        user_sessions = []
        
        for evt in sports_events:
            event_ticker = evt['event_ticker']
            
            if event_ticker in running_sessions:
                session_info = running_sessions[event_ticker]
                session_user = session_info['user_name']
                
                # Check if this is the current user's session
                if session_user == current_user:
                    # User's own session - show as reconnectable
                    user_sessions.append({
                        **evt,
                        'status': 'running',
                        'websocket_url': session_info['websocket_url'],
                        'started_at': session_info['started_at']
                    })
                # Else: another user's session - don't show at all
            else:
                # No Fargate running - available for launch
                available_events.append({
                    **evt,
                    'status': 'available'
                })
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'available_events': available_events,
                'user_sessions': user_sessions,
                'current_user': current_user
            }, default=decimal_default)
        }
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'error': str(e)
            })
        }
