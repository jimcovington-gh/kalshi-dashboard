"""
Capture Game API Lambda

Provides endpoints for:
- GET /capture/games - List available NFL/NCAA/NBA games in next 24 hours
- GET /capture/queue - List queued and active captures
- POST /capture/queue - Add game to capture queue
- DELETE /capture/queue/{event_ticker} - Remove from queue
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


# Environment variables
KALSHI_API_BASE = os.environ.get('KALSHI_API_BASE_URL', 'https://api.elections.kalshi.com')
CAPTURE_TABLE = os.environ.get('CAPTURE_TABLE', 'production-sports-feeder-state')
EVENT_METADATA_TABLE = os.environ.get('EVENT_METADATA_TABLE', 'production-kalshi-event-metadata')
SERIES_METADATA_TABLE = os.environ.get('SERIES_METADATA_TABLE', 'production-kalshi-series-metadata')

# Series tickers for supported leagues (only NFL, NCAA Basketball, NBA)
SUPPORTED_SERIES = {
    'KXNFLGAME': 'NFL',
    'KXNCAAMBGAME': 'NCAA Men\'s Basketball',
    'KXNCAAWBGAME': 'NCAA Women\'s Basketball',
    'KXNBAGAME': 'NBA',
}

http = urllib3.PoolManager()

# Cache for credentials
_kalshi_credentials = None


def decimal_default(obj):
    """Handle Decimal serialization for JSON."""
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def get_kalshi_credentials():
    """Get Kalshi API credentials from Secrets Manager (cached)."""
    global _kalshi_credentials
    if _kalshi_credentials:
        return _kalshi_credentials
    
    secrets_client = boto3.client('secretsmanager')
    
    try:
        # Use the main API credentials for listing events
        api_key_response = secrets_client.get_secret_value(SecretId='production-kalshi-api-key-id')
        api_key = api_key_response['SecretString']
        
        private_key_response = secrets_client.get_secret_value(SecretId='production-kalshi-private-key')
        private_key = private_key_response['SecretString']
        
        _kalshi_credentials = (api_key, private_key)
        return _kalshi_credentials
    except Exception as e:
        print(f"Failed to get Kalshi credentials: {e}")
        return None, None


def sign_kalshi_request(private_key_pem: str, timestamp: str, method: str, path: str) -> str:
    """Sign a Kalshi API request using RSA-PSS."""
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


def fetch_milestone_for_event(event_ticker: str) -> dict | None:
    """Fetch milestone data from Kalshi API for a single event.
    
    Returns:
        Dict with start_timestamp and details, or None if not found
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
        
        # Find the main game milestone (type containing 'game')
        game_milestone = None
        for m in milestones:
            if 'game' in m.get('type', '').lower():
                game_milestone = m
                break
        
        if not game_milestone:
            game_milestone = milestones[0]
        
        start_date_str = game_milestone.get('start_date')
        if start_date_str:
            start_dt = datetime.fromisoformat(start_date_str.replace('Z', '+00:00'))
            return {
                'start_timestamp': int(start_dt.timestamp()),
                'title': game_milestone.get('title', ''),
                'details': game_milestone.get('details', {}),
            }
        
        return None
        
    except Exception as e:
        print(f"Error fetching milestone for {event_ticker}: {e}")
        return None


def get_series_titles(series_tickers: list) -> dict:
    """Fetch series titles from DynamoDB for the given series tickers."""
    if not series_tickers:
        return {}
    
    unique_tickers = list(set(series_tickers))
    titles = {}
    
    dynamodb = boto3.resource('dynamodb')
    
    try:
        for i in range(0, len(unique_tickers), 100):
            batch = unique_tickers[i:i+100]
            response = dynamodb.meta.client.batch_get_item(
                RequestItems={
                    SERIES_METADATA_TABLE: {
                        'Keys': [{'series_ticker': ticker} for ticker in batch],
                        'ProjectionExpression': 'series_ticker, title'
                    }
                }
            )
            
            for item in response.get('Responses', {}).get(SERIES_METADATA_TABLE, []):
                ticker = item.get('series_ticker')
                title = item.get('title', '')
                if ticker:
                    titles[ticker] = title
                    
    except Exception as e:
        print(f"Error fetching series titles: {e}")
        
    return titles


def get_available_games():
    """Fetch available sports events for supported leagues (NFL, NCAA BB, NBA).
    
    Returns events from 5 hours ago (in progress) to 24 hours ahead.
    """
    events = []
    now = datetime.now(timezone.utc)
    now_ts = int(now.timestamp())
    max_ts = int((now + timedelta(hours=24)).timestamp())  # 24 hours ahead
    min_ts = int((now - timedelta(hours=5)).timestamp())  # 5 hours ago (in progress)
    
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(EVENT_METADATA_TABLE)
    
    try:
        # Scan for sports category events
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
        
        # Filter to supported series and fetch milestones for accurate start times
        events_needing_milestones = []
        
        for item in items:
            event_ticker = item.get('event_ticker', '')
            series_ticker = item.get('series_ticker', '')
            strike_date = int(item.get('strike_date', 0))
            
            # Only include supported leagues
            if series_ticker not in SUPPORTED_SERIES:
                continue
            
            # Only include main game events
            if not series_ticker.endswith('GAME'):
                continue
            
            # Use start_date from DynamoDB if available
            start_date_from_db = item.get('start_date')
            if start_date_from_db:
                start_timestamp = int(start_date_from_db)
                needs_fetch = False
            else:
                # Estimate game start time
                start_timestamp = strike_date - (3 * 3600)
                needs_fetch = True
            
            start_datetime = datetime.fromtimestamp(start_timestamp, tz=timezone.utc)
            
            # Format for display
            est_time = start_datetime - timedelta(hours=5)
            start_time_formatted = est_time.strftime('%a %b %-d @ %-I:%M %p EST')
            
            # Calculate time until start
            seconds_until = start_timestamp - now_ts
            if seconds_until < 0:
                time_display = f"Started {abs(seconds_until) // 3600}h {(abs(seconds_until) % 3600) // 60}m ago"
                has_started = True
            else:
                hours = seconds_until // 3600
                minutes = (seconds_until % 3600) // 60
                if hours > 0:
                    time_display = f"Starts in {hours}h {minutes}m"
                else:
                    time_display = f"Starts in {minutes}m"
                has_started = False
            
            event_data = {
                'event_ticker': event_ticker,
                'title': item.get('title', ''),
                'series_ticker': series_ticker,
                'league': SUPPORTED_SERIES.get(series_ticker, 'Unknown'),
                'event_time': start_time_formatted,
                'event_timestamp': start_timestamp,
                'time_display': time_display,
                'has_started': has_started,
                '_needs_milestone_fetch': needs_fetch
            }
            events.append(event_data)
            
            if needs_fetch:
                events_needing_milestones.append(event_data)
        
        # Fetch milestones for events missing start_date (limit to avoid timeout)
        if events_needing_milestones:
            print(f"Fetching milestones for {len(events_needing_milestones)} events")
            for evt in events_needing_milestones[:10]:
                milestone_data = fetch_milestone_for_event(evt['event_ticker'])
                if milestone_data:
                    start_ts = milestone_data['start_timestamp']
                    evt['event_timestamp'] = start_ts
                    start_dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
                    est_time = start_dt - timedelta(hours=5)
                    evt['event_time'] = est_time.strftime('%a %b %-d @ %-I:%M %p EST')
                    
                    # Recalculate time display
                    seconds_until = start_ts - now_ts
                    if seconds_until < 0:
                        evt['time_display'] = f"Started {abs(seconds_until) // 3600}h {(abs(seconds_until) % 3600) // 60}m ago"
                        evt['has_started'] = True
                    else:
                        hours = seconds_until // 3600
                        minutes = (seconds_until % 3600) // 60
                        if hours > 0:
                            evt['time_display'] = f"Starts in {hours}h {minutes}m"
                        else:
                            evt['time_display'] = f"Starts in {minutes}m"
                        evt['has_started'] = False
        
        # Clean up internal flag
        for evt in events:
            evt.pop('_needs_milestone_fetch', None)
        
        # Filter by actual event_timestamp
        events = [e for e in events if min_ts <= e.get('event_timestamp', 0) <= max_ts]
        
    except Exception as e:
        print(f"Error fetching sports events: {e}")
        import traceback
        traceback.print_exc()
    
    # Sort by start time
    events.sort(key=lambda x: x.get('event_timestamp', 0))
    
    # Fetch series titles
    if events:
        series_tickers = [e.get('series_ticker', '') for e in events]
        series_titles = get_series_titles(series_tickers)
        for evt in events:
            series_ticker = evt.get('series_ticker', '')
            evt['series_title'] = series_titles.get(series_ticker, '')
    
    return events


def get_capture_queue():
    """Get all queued and active captures from DynamoDB."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(CAPTURE_TABLE)
    
    captures = []
    
    try:
        # Scan for capture queue items
        response = table.scan(
            FilterExpression='begins_with(#k, :prefix)',
            ExpressionAttributeNames={'#k': 'key'},
            ExpressionAttributeValues={':prefix': 'CAPTURE_QUEUE#'}
        )
        
        items = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression='begins_with(#k, :prefix)',
                ExpressionAttributeNames={'#k': 'key'},
                ExpressionAttributeValues={':prefix': 'CAPTURE_QUEUE#'},
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response.get('Items', []))
        
        for item in items:
            captures.append({
                'event_ticker': item.get('event_ticker', ''),
                'title': item.get('title', ''),
                'league': item.get('league', ''),
                'scheduled_start': int(item.get('scheduled_start', 0)),
                'queued_at': int(item.get('queued_at', 0)),
                'queued_by': item.get('queued_by', ''),
                'status': item.get('status', 'queued'),  # queued, capturing, completed, failed
                'capture_user': item.get('capture_user', ''),
                'data_points': int(item.get('data_points', 0)),
                's3_path': item.get('s3_path', ''),
            })
        
    except Exception as e:
        print(f"Error fetching capture queue: {e}")
    
    # Sort by scheduled start time
    captures.sort(key=lambda x: x.get('scheduled_start', 0))
    
    return captures


def add_to_queue(event_ticker: str, title: str, league: str, scheduled_start: int, queued_by: str, capture_user: str):
    """Add a game to the capture queue."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(CAPTURE_TABLE)
    
    try:
        table.put_item(
            Item={
                'key': f'CAPTURE_QUEUE#{event_ticker}',
                'event_ticker': event_ticker,
                'title': title,
                'league': league,
                'scheduled_start': scheduled_start,
                'queued_at': int(time.time()),
                'queued_by': queued_by,
                'capture_user': capture_user,
                'status': 'queued',
                'data_points': 0,
                's3_path': '',
            },
            ConditionExpression='attribute_not_exists(#k)',
            ExpressionAttributeNames={'#k': 'key'}
        )
        return True, "Game queued for capture"
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False, "Game is already in the capture queue"
        raise


def remove_from_queue(event_ticker: str) -> tuple[bool, str]:
    """Remove a game from the capture queue."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(CAPTURE_TABLE)
    
    try:
        # Get item first to check status
        response = table.get_item(Key={'key': f'CAPTURE_QUEUE#{event_ticker}'})
        item = response.get('Item')
        
        if not item:
            return False, "Game not found in queue"
        
        status = item.get('status', 'queued')
        if status == 'capturing':
            return False, "Cannot remove game while capture is in progress"
        
        table.delete_item(Key={'key': f'CAPTURE_QUEUE#{event_ticker}'})
        return True, "Game removed from queue"
        
    except Exception as e:
        print(f"Error removing from queue: {e}")
        return False, str(e)


def lambda_handler(event, context):
    """Main Lambda handler."""
    print(f"Event: {json.dumps(event)}")
    
    http_method = event.get('httpMethod', '')
    path = event.get('path', '')
    
    # CORS headers
    headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
    
    # Handle OPTIONS preflight
    if http_method == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': ''}
    
    # Get username from Cognito authorizer
    claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
    username = claims.get('preferred_username') or claims.get('cognito:username', 'unknown')
    
    # Check if admin (for capture_user selection)
    is_admin = username == 'admin' or 'admin' in username.lower()
    
    try:
        # GET /capture/games - List available games
        if path == '/capture/games' and http_method == 'GET':
            games = get_available_games()
            
            # Get queue to filter out already-queued games
            queue = get_capture_queue()
            queued_tickers = {c['event_ticker'] for c in queue}
            
            # Filter out games already in queue
            available_games = [g for g in games if g['event_ticker'] not in queued_tickers]
            
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'games': available_games,
                    'username': username,
                    'is_admin': is_admin,
                }, default=decimal_default)
            }
        
        # GET /capture/queue - List queued captures
        elif path == '/capture/queue' and http_method == 'GET':
            queue = get_capture_queue()
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'captures': queue,
                }, default=decimal_default)
            }
        
        # POST /capture/queue - Add game to queue
        elif path == '/capture/queue' and http_method == 'POST':
            body = json.loads(event.get('body', '{}'))
            event_ticker = body.get('event_ticker')
            title = body.get('title', '')
            league = body.get('league', '')
            scheduled_start = body.get('scheduled_start', 0)
            
            if not event_ticker:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'event_ticker is required'})
                }
            
            # Determine capture_user: admin uses 'jimc', others use their username
            capture_user = 'jimc' if is_admin else username
            
            success, message = add_to_queue(
                event_ticker=event_ticker,
                title=title,
                league=league,
                scheduled_start=scheduled_start,
                queued_by=username,
                capture_user=capture_user
            )
            
            return {
                'statusCode': 200 if success else 400,
                'headers': headers,
                'body': json.dumps({
                    'success': success,
                    'message': message,
                    'capture_user': capture_user,
                })
            }
        
        # DELETE /capture/queue/{event_ticker} - Remove from queue
        elif path.startswith('/capture/queue/') and http_method == 'DELETE':
            event_ticker = path.split('/capture/queue/')[1]
            
            if not event_ticker:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'event_ticker is required'})
                }
            
            success, message = remove_from_queue(event_ticker)
            
            return {
                'statusCode': 200 if success else 400,
                'headers': headers,
                'body': json.dumps({
                    'success': success,
                    'message': message,
                })
            }
        
        else:
            return {
                'statusCode': 404,
                'headers': headers,
                'body': json.dumps({'error': f'Not found: {http_method} {path}'})
            }
            
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }
