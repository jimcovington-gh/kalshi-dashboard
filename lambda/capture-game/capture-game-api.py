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
from concurrent.futures import ThreadPoolExecutor, as_completed

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


def fetch_all_milestones() -> list:
    """Fetch all milestones from Kalshi API.
    
    Returns:
        List of milestone dicts
    """
    api_key, private_key = get_kalshi_credentials()
    if not api_key or not private_key:
        return []
    
    timestamp = str(int(time.time() * 1000))
    path = '/trade-api/v2/milestones?limit=1000'
    
    signature = sign_kalshi_request(private_key, timestamp, 'GET', path)
    
    headers = {
        'KALSHI-ACCESS-KEY': api_key,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json'
    }
    
    try:
        resp = http.request('GET', f'{KALSHI_API_BASE}{path}', headers=headers, timeout=10.0)
        
        if resp.status != 200:
            print(f"Milestones API returned {resp.status}")
            return []
        
        data = json.loads(resp.data.decode('utf-8'))
        return data.get('milestones', [])
        
    except Exception as e:
        print(f"Error fetching milestones: {e}")
        return []


def find_milestone_for_event(event_ticker: str, milestones: list, now_ts: int) -> dict | None:
    """Find a matching milestone for an event ticker.
    
    Matches by checking primary_event_tickers and related_event_tickers.
    Filters out milestones with start_date in the past.
    
    Args:
        event_ticker: The event ticker to find a milestone for
        milestones: List of milestone dicts from API
        now_ts: Current timestamp for filtering past milestones
        
    Returns:
        Dict with start_timestamp if found, None otherwise
    """
    for m in milestones:
        # Check if event_ticker is in primary or related tickers
        primary = m.get('primary_event_tickers', [])
        related = m.get('related_event_tickers', [])
        
        if event_ticker not in primary and event_ticker not in related:
            continue
        
        # Found a matching milestone - check if start_date is in the future
        start_date_str = m.get('start_date')
        if not start_date_str:
            continue
            
        try:
            start_dt = datetime.fromisoformat(start_date_str.replace('Z', '+00:00'))
            start_ts = int(start_dt.timestamp())
            
            # Filter out past milestones (more than 1 hour ago)
            if start_ts < now_ts - 3600:
                print(f"Skipping past milestone for {event_ticker}: {start_date_str}")
                continue
            
            return {
                'start_timestamp': start_ts,
                'title': m.get('title', ''),
            }
        except Exception as e:
            print(f"Error parsing milestone start_date for {event_ticker}: {e}")
            continue
    
    return None


def update_event_start_date(event_ticker: str, start_timestamp: int) -> bool:
    """Cache the start_date to DynamoDB event metadata table.
    
    This prevents repeated API calls for the same event's milestone data.
    """
    try:
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(EVENT_METADATA_TABLE)
        table.update_item(
            Key={'event_ticker': event_ticker},
            UpdateExpression='SET start_date = :sd',
            ExpressionAttributeValues={':sd': start_timestamp}
        )
        print(f"Cached start_date={start_timestamp} for {event_ticker}")
        return True
    except Exception as e:
        print(f"Failed to cache start_date for {event_ticker}: {e}")
        return False


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
    Uses milestones API to get accurate start times when available,
    falls back to strike_date - 3 hours estimation.
    """
    events = []
    events_needing_milestones = []
    now = datetime.now(timezone.utc)
    now_ts = int(now.timestamp())
    max_ts = int((now + timedelta(hours=24)).timestamp())  # 24 hours ahead
    min_ts = int((now - timedelta(hours=5)).timestamp())  # 5 hours ago (in progress)
    
    print(f"DEBUG get_available_games: now_ts={now_ts}, min_ts={min_ts}, max_ts={max_ts}")
    
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
        
        print(f"DEBUG get_available_games: found {len(items)} sports events in time window")
        
        # Filter to supported series
        for item in items:
            event_ticker = item.get('event_ticker', '')
            series_ticker = item.get('series_ticker', '')
            strike_date = int(item.get('strike_date', 0))
            
            # Only include supported leagues
            if series_ticker not in SUPPORTED_SERIES:
                continue
            
            print(f"DEBUG: Processing event {event_ticker}, series={series_ticker}, strike_date={strike_date}")
            
            # Only include main game events
            if not series_ticker.endswith('GAME'):
                continue
            
            # Check for cached start_date in DynamoDB
            start_date_from_db = item.get('start_date')
            if start_date_from_db:
                start_timestamp = int(start_date_from_db)
                # Validate it's not in the distant past (bad cached data)
                if start_timestamp > now_ts - (24 * 3600):  # Within last 24 hours is OK
                    needs_milestone = False
                else:
                    # Bad cached data - re-estimate and mark for milestone lookup
                    start_timestamp = strike_date - (3 * 3600)
                    needs_milestone = True
            else:
                # Estimate start time from strike_date - 3 hours
                start_timestamp = strike_date - (3 * 3600)
                needs_milestone = True
            
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
            }
            events.append(event_data)
            print(f"DEBUG: Added event {event_ticker} with timestamp={start_timestamp}")
            
            # Track events that need milestone lookup
            if needs_milestone:
                events_needing_milestones.append(event_data)
        
        print(f"DEBUG: Before filter - {len(events)} events")
        # Filter by actual event_timestamp
        events = [e for e in events if min_ts <= e.get('event_timestamp', 0) <= max_ts]
        print(f"DEBUG: After filter - {len(events)} events (min_ts={min_ts}, max_ts={max_ts})")
        
        # Try to get accurate start times from milestones API for events that need it
        if events_needing_milestones:
            try:
                all_milestones = fetch_all_milestones()
                print(f"Fetched {len(all_milestones)} milestones for matching")
                
                for evt in events_needing_milestones:
                    event_ticker = evt['event_ticker']
                    milestone = find_milestone_for_event(event_ticker, all_milestones, now_ts)
                    
                    if milestone:
                        # Parse milestone start time
                        start_str = milestone.get('start_date', '')
                        if start_str:
                            try:
                                start_dt = datetime.fromisoformat(start_str.replace('Z', '+00:00'))
                                start_timestamp = int(start_dt.timestamp())
                                
                                # Update event with accurate time
                                evt['event_timestamp'] = start_timestamp
                                est_time = start_dt - timedelta(hours=5)
                                evt['event_time'] = est_time.strftime('%a %b %-d @ %-I:%M %p EST')
                                
                                # Recalculate time display
                                seconds_until = start_timestamp - now_ts
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
                                
                                # Cache to DynamoDB
                                update_event_start_date(event_ticker, start_timestamp)
                                print(f"Updated {event_ticker} with milestone start time: {start_str}")
                            except Exception as e:
                                print(f"Error parsing milestone start_date '{start_str}': {e}")
            except Exception as e:
                print(f"Error fetching milestones (will use estimates): {e}")
                import traceback
                traceback.print_exc()
        
    except Exception as e:
        print(f"Error fetching sports events: {e}")
        import traceback
        traceback.print_exc()
    
    # Sort by start time (may have changed after milestone updates)
    events.sort(key=lambda x: x.get('event_timestamp', 0))
    
    # Fetch series titles
    if events:
        series_tickers = [e.get('series_ticker', '') for e in events]
        series_titles = get_series_titles(series_tickers)
        for evt in events:
            series_ticker = evt.get('series_ticker', '')
            evt['series_title'] = series_titles.get(series_ticker, '')
    
    return events


def get_feeder_ip():
    """Get the sports data feeder IP from state table."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(CAPTURE_TABLE)
    
    try:
        # Get the feeder state directly by key
        response = table.get_item(Key={'key': 'FEEDER_STATE'})
        feeder = response.get('Item')
        print(f"DEBUG get_feeder_ip: feeder={feeder}")
        
        if feeder:
            ip_address = feeder.get('ip_address', '')
            status = feeder.get('status', '')
            
            # Check if heartbeat is recent (within last 2 minutes)
            # last_heartbeat is an ISO string like "2026-01-11T20:15:08.104405+00:00"
            last_heartbeat_str = feeder.get('last_heartbeat', '')
            print(f"DEBUG get_feeder_ip: ip={ip_address}, status={status}, heartbeat={last_heartbeat_str}")
            
            if last_heartbeat_str and status == 'running' and ip_address:
                from datetime import datetime, timezone
                try:
                    # Parse ISO format timestamp
                    heartbeat_dt = datetime.fromisoformat(last_heartbeat_str)
                    now = datetime.now(timezone.utc)
                    age_seconds = (now - heartbeat_dt).total_seconds()
                    print(f"DEBUG get_feeder_ip: age_seconds={age_seconds}")
                    if age_seconds < 120:
                        print(f"DEBUG get_feeder_ip: returning {ip_address}")
                        return ip_address
                    else:
                        print(f"DEBUG get_feeder_ip: heartbeat too old ({age_seconds}s)")
                except Exception as e:
                    print(f"Error parsing heartbeat timestamp: {e}")
        
    except Exception as e:
        print(f"Error fetching feeder IP: {e}")
    
    print("DEBUG get_feeder_ip: returning None")
    return None


# S3 bucket for capture data
S3_CAPTURE_BUCKET = "production-kalshi-trading-captures"


def get_capture_s3_stats(event_ticker: str) -> dict:
    """Get S3 stats (total file size, file count) for a capture's event_ticker prefix."""
    s3 = boto3.client('s3')
    
    try:
        # List objects in the event_ticker prefix
        paginator = s3.get_paginator('list_objects_v2')
        total_size = 0
        file_count = 0
        
        for page in paginator.paginate(Bucket=S3_CAPTURE_BUCKET, Prefix=f"{event_ticker}/"):
            if 'Contents' in page:
                for obj in page['Contents']:
                    total_size += obj.get('Size', 0)
                    file_count += 1
        
        return {
            'file_count': file_count,
            'total_bytes': total_size,
            'total_mb': round(total_size / (1024 * 1024), 2) if total_size > 0 else 0,
            'display': f"{round(total_size / 1024, 1)} KB" if total_size < 1024 * 1024 else f"{round(total_size / (1024 * 1024), 2)} MB"
        }
    except Exception as e:
        print(f"Error getting S3 stats for {event_ticker}: {e}")
        return {'file_count': 0, 'total_bytes': 0, 'total_mb': 0, 'display': '-'}


def get_capture_queue(include_s3_stats: bool = False):
    """Get all queued and active captures from DynamoDB.
    
    Args:
        include_s3_stats: If True, fetch S3 file sizes (slower, adds ~100ms per capture).
                         Default False for fast response.
    """
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(CAPTURE_TABLE)
    
    captures = []
    feeder_ip = get_feeder_ip()
    
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
        
        # Build capture list without S3 stats first
        for item in items:
            event_ticker = item.get('event_ticker', '')
            status = item.get('status', 'queued')
            
            captures.append({
                'event_ticker': event_ticker,
                'title': item.get('title', ''),
                'league': item.get('league', ''),
                'scheduled_start': int(item.get('scheduled_start', 0)),
                'queued_at': int(item.get('queued_at', 0)),
                'queued_by': item.get('queued_by', ''),
                'status': status,
                'capture_user': item.get('capture_user', ''),
                'data_points': int(item.get('data_points', 0)),
                's3_path': item.get('s3_path', ''),
                'feeder_url': f'ws://{feeder_ip}:8080' if feeder_ip else None,
                's3_stats': None,
            })
        
        # Fetch S3 stats in parallel if requested
        if include_s3_stats:
            tickers_needing_stats = [
                c['event_ticker'] for c in captures 
                if c['status'] in ('capturing', 'completed')
            ]
            
            if tickers_needing_stats:
                # Parallel S3 stats fetch (max 10 concurrent)
                s3_stats_map = {}
                with ThreadPoolExecutor(max_workers=10) as executor:
                    future_to_ticker = {
                        executor.submit(get_capture_s3_stats, ticker): ticker 
                        for ticker in tickers_needing_stats
                    }
                    for future in as_completed(future_to_ticker):
                        ticker = future_to_ticker[future]
                        try:
                            s3_stats_map[ticker] = future.result()
                        except Exception as e:
                            print(f"Error getting S3 stats for {ticker}: {e}")
                            s3_stats_map[ticker] = None
                
                # Apply stats to captures
                for capture in captures:
                    if capture['event_ticker'] in s3_stats_map:
                        capture['s3_stats'] = s3_stats_map[capture['event_ticker']]
        
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
            
            # Get queue to filter out already-queued games (no S3 stats needed)
            queue = get_capture_queue(include_s3_stats=False)
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
            # Check for ?include_stats=true query param
            query_params = event.get('queryStringParameters') or {}
            include_stats = query_params.get('include_stats', '').lower() == 'true'
            
            queue = get_capture_queue(include_s3_stats=include_stats)
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
        
        # GET /capture/live/{event_ticker} - Get live game data from feeder
        elif path.startswith('/capture/live/') and http_method == 'GET':
            event_ticker = path.split('/capture/live/')[1]
            
            if not event_ticker:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'event_ticker is required'})
                }
            
            feeder_ip = get_feeder_ip()
            if not feeder_ip:
                return {
                    'statusCode': 503,
                    'headers': headers,
                    'body': json.dumps({'error': 'Feeder not available'})
                }
            
            # Fetch game data from feeder HTTP API
            try:
                import urllib.request
                feeder_url = f'http://{feeder_ip}:8081/game/{event_ticker}'
                req = urllib.request.Request(feeder_url, headers={'Accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=5) as response:
                    game_data = json.loads(response.read().decode('utf-8'))
                    return {
                        'statusCode': 200,
                        'headers': headers,
                        'body': json.dumps(game_data, default=decimal_default)
                    }
            except urllib.error.HTTPError as e:
                return {
                    'statusCode': e.code,
                    'headers': headers,
                    'body': json.dumps({'error': f'Feeder returned {e.code}'})
                }
            except Exception as e:
                print(f"Error fetching from feeder: {e}")
                return {
                    'statusCode': 500,
                    'headers': headers,
                    'body': json.dumps({'error': f'Failed to fetch from feeder: {str(e)}'})
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
