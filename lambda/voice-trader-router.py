"""
Voice Mention Trader - Router Lambda

SIMPLIFIED: EC2 only, no Fargate. Direct HTTP for dial (to container).

Handles:
- GET /voice-trader/events - List upcoming mention events
- GET /voice-trader/running - Get running sessions (EC2)
- GET /voice-trader/status/{session_id} - Get session status

EC2 Control:
- GET /voice-trader/ec2/status - Get EC2 instance status
- POST /voice-trader/ec2/start - Start EC2 instance
- POST /voice-trader/ec2/stop - Stop EC2 instance  
- POST /voice-trader/ec2/reboot - Reboot EC2 instance
- POST /voice-trader/ec2/launch - Launch voice trader session
- POST /voice-trader/ec2/stop-session/{session_id} - Stop a session

Queue Management:
- POST /voice-trader/ec2/queue/add - Add event to scheduled queue
- POST /voice-trader/ec2/queue/remove - Remove event from queue
"""

import json
import os
import uuid
import boto3
from datetime import datetime, timezone, timedelta
from decimal import Decimal

# AWS clients
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
ec2 = boto3.client('ec2', region_name='us-east-1')
ssm = boto3.client('ssm', region_name='us-east-1')

# Configuration
MARKET_METADATA_TABLE = os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata')
MENTION_EVENTS_TABLE = os.environ.get('MENTION_EVENTS_TABLE', 'production-kalshi-mention-events')
VOICE_TRADER_STATE_TABLE = os.environ.get('VOICE_TRADER_STATE_TABLE', 'production-kalshi-voice-trader-state')
VOICE_TRADER_QUEUE_TABLE = os.environ.get('VOICE_TRADER_QUEUE_TABLE', 'production-kalshi-voice-trader-queue')

# EC2 Configuration - Production (GPU instance: g4dn.xlarge)
VOICE_TRADER_EC2_INSTANCE_ID = os.environ.get('VOICE_TRADER_EC2_INSTANCE_ID', 'i-007fa64f2c29180ec')
VOICE_TRADER_EC2_DOMAIN = os.environ.get('VOICE_TRADER_EC2_DOMAIN', 'voice.apexmarkets.us')

# EC2 Configuration - Dev
VOICE_TRADER_EC2_INSTANCE_ID_DEV = os.environ.get('VOICE_TRADER_EC2_INSTANCE_ID_DEV', 'i-04d29cacb3c2d76a6')
VOICE_TRADER_EC2_DOMAIN_DEV = os.environ.get('VOICE_TRADER_EC2_DOMAIN_DEV', 'dev-voice.apexmarkets.us')


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def get_ec2_config(event):
    """Get EC2 instance ID and domain based on env query param.
    
    Args:
        event: Lambda event dict
    
    Returns:
        tuple: (instance_id, domain, env_name)
    """
    # Check query params for env=dev
    query_params = event.get('queryStringParameters') or {}
    env = query_params.get('env', 'prod')
    
    if env == 'dev':
        return (VOICE_TRADER_EC2_INSTANCE_ID_DEV, VOICE_TRADER_EC2_DOMAIN_DEV, 'dev')
    else:
        return (VOICE_TRADER_EC2_INSTANCE_ID, VOICE_TRADER_EC2_DOMAIN, 'prod')


def lambda_handler(event, context):
    """Main Lambda handler."""
    print(f"Event: {json.dumps(event)}")
    
    http_method = event.get('httpMethod', event.get('requestContext', {}).get('http', {}).get('method', 'GET'))
    path = event.get('path', event.get('rawPath', ''))
    path_parts = path.strip('/').split('/')
    
    try:
        # EC2 control endpoints - pass event for env detection
        if '/ec2/status' in path and http_method == 'GET':
            return get_ec2_status(event)
        elif '/ec2/start' in path and http_method == 'POST':
            return start_ec2(event)
        elif '/ec2/stop' in path and http_method == 'POST':
            return stop_ec2(event)
        elif '/ec2/reboot' in path and http_method == 'POST':
            return reboot_ec2(event)
        elif '/ec2/launch' in path and http_method == 'POST':
            return launch_ec2_session(event)
        elif '/ec2/stop-session/' in path and http_method == 'POST':
            session_id = path_parts[-1]
            return stop_session(session_id)
        # Queue management endpoints
        elif '/ec2/queue/list' in path and http_method == 'GET':
            return get_queue_list(event)
        elif '/ec2/queue/add' in path and http_method == 'POST':
            return add_to_queue(event)
        elif '/ec2/queue/remove' in path and http_method == 'POST':
            return remove_from_queue(event)
        elif '/ec2/queue/clean-stale' in path and http_method == 'POST':
            return clean_stale_queue_events(event)
        # Worker/session endpoints  
        elif '/ec2/workers' in path and http_method == 'GET':
            return get_active_workers(event)
        # Query endpoints
        elif path.endswith('/events') and http_method == 'GET':
            return get_upcoming_events(event)
        elif path.endswith('/running') and http_method == 'GET':
            return get_running_sessions()
        elif '/status/' in path and http_method == 'GET':
            session_id = path_parts[-1]
            return get_status(session_id)
        else:
            return response(404, {'error': 'Not found'})
            
    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return response(500, {'error': str(e)})


def get_upcoming_events(event):
    """Get mention events starting within the next 24 hours or started within the last 3 hours."""
    events_table = dynamodb.Table(MENTION_EVENTS_TABLE)
    market_table = dynamodb.Table(MARKET_METADATA_TABLE)
    
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=24)
    
    # Scan for events with start_date in the next 24 hours
    # In production, this should use a GSI on start_date
    try:
        scan_result = events_table.scan()
        items = scan_result.get('Items', [])
        
        upcoming = []
        for item in items:
            start_date_str = item.get('start_date', '')
            if not start_date_str:
                continue
                
            try:
                # Parse ISO format
                start_date = datetime.fromisoformat(start_date_str.replace('Z', '+00:00'))
                
                # Include events starting within 24 hours OR started within last 24 hours
                twenty_four_hours_ago = now - timedelta(hours=24)
                if twenty_four_hours_ago <= start_date <= cutoff:
                    hours_until = (start_date - now).total_seconds() / 3600
                    
                    # Get associated markets (words)
                    event_ticker = item.get('event_ticker', '')
                    markets = []
                    
                    try:
                        market_scan = market_table.scan(
                            FilterExpression='event_ticker = :et',
                            ExpressionAttributeValues={':et': event_ticker}
                        )
                        for market in market_scan.get('Items', []):
                            word = market.get('subtitle', '').replace('mentioned', '').strip().strip('?')
                            if word:
                                markets.append({
                                    'market_ticker': market.get('ticker', ''),
                                    'word': word
                                })
                    except Exception as e:
                        print(f"Error fetching markets for {event_ticker}: {e}")
                    
                    upcoming.append({
                        'event_ticker': event_ticker,
                        'title': item.get('title', ''),
                        'start_date': start_date_str,
                        'hours_until_start': round(hours_until, 1),
                        'words': markets,
                        'word_count': len(markets)
                    })
            except Exception as e:
                print(f"Error parsing date for {item.get('event_ticker')}: {e}")
                continue
        
        # Sort by start time
        upcoming.sort(key=lambda x: x['start_date'])
        
        return response(200, {
            'events': upcoming,
            'count': len(upcoming),
            'as_of': now.isoformat()
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to fetch events: {str(e)}'})


def get_running_sessions():
    """Get currently running voice trader sessions from DynamoDB."""
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    # Query for active sessions (not stopped)
    try:
        scan_result = state_table.scan()
        items = scan_result.get('Items', [])
        
        sessions = []
        now = datetime.now(timezone.utc)
        
        for item in items:
            status = item.get('status', '')
            started_at = item.get('started_at', '')
            
            # Skip stopped sessions
            if status == 'stopped':
                continue
            
            # Skip old sessions (more than 6 hours old)
            if started_at:
                try:
                    started = datetime.fromisoformat(started_at.replace('Z', '+00:00'))
                    if (now - started).total_seconds() > 6 * 3600:
                        continue
                except:
                    pass
            
            sessions.append({
                'session_id': item.get('session_id'),
                'event_ticker': item.get('event_ticker'),
                'user_name': item.get('user_name'),
                'status': status,
                'started_at': started_at,
                'public_ip': item.get('public_ip'),
                'websocket_url': f'wss://{VOICE_TRADER_EC2_DOMAIN}:8765'
            })
        
        # Sort by started_at descending
        sessions.sort(key=lambda x: x.get('started_at', ''), reverse=True)
        
        return response(200, {
            'sessions': sessions,
            'count': len(sessions)
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to fetch sessions: {str(e)}'})


def get_status(session_id: str):
    """Get status of a voice trader session."""
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    item = state_table.get_item(Key={'session_id': session_id}).get('Item', {})
    
    if not item:
        return response(404, {'error': 'Session not found'})
    
    # Add WebSocket URL
    item['websocket_url'] = f'wss://{VOICE_TRADER_EC2_DOMAIN}:8765'
    item['domain'] = VOICE_TRADER_EC2_DOMAIN
    
    return response(200, item)


def stop_session(session_id: str):
    """Stop a voice trader session via HTTP API."""
    import urllib.request
    import ssl
    
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    item = state_table.get_item(Key={'session_id': session_id}).get('Item', {})
    
    if not item:
        return response(404, {'error': 'Session not found'})
    
    # Get the domain from the session's env
    env_name = item.get('env', 'prod')
    if env_name == 'dev':
        domain = VOICE_TRADER_EC2_DOMAIN_DEV
    else:
        domain = VOICE_TRADER_EC2_DOMAIN
    
    api_url = f'https://{domain}:8080'
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    
    try:
        # Call the /stop endpoint
        stop_req = urllib.request.Request(
            f'{api_url}/stop',
            method='POST'
        )
        with urllib.request.urlopen(stop_req, timeout=10, context=ssl_ctx) as resp:
            result = json.loads(resp.read().decode())
        
        # Update state
        state_table.update_item(
            Key={'session_id': session_id},
            UpdateExpression='SET #status = :s, stopped_at = :t',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':s': 'stopped',
                ':t': datetime.now(timezone.utc).isoformat()
            }
        )
        
        return response(200, {'success': True, 'message': result.get('message', 'Session stopped')})
        
    except Exception as e:
        return response(500, {'error': f'Failed to stop session: {str(e)}'})


# ============================================================================
# EC2 Control Functions
# ============================================================================

def get_ec2_status(event):
    """Get Voice Trader EC2 instance status."""
    instance_id, domain, env_name = get_ec2_config(event)
    
    try:
        result = ec2.describe_instances(InstanceIds=[instance_id])
        
        if not result.get('Reservations') or not result['Reservations'][0].get('Instances'):
            return response(404, {'error': 'EC2 instance not found'})
        
        instance = result['Reservations'][0]['Instances'][0]
        state = instance['State']['Name']
        public_ip = instance.get('PublicIpAddress')
        launch_time = instance.get('LaunchTime')
        
        uptime_hours = None
        if state == 'running' and launch_time:
            uptime_seconds = (datetime.now(timezone.utc) - launch_time.replace(tzinfo=timezone.utc)).total_seconds()
            uptime_hours = round(uptime_seconds / 3600, 2)
        
        return response(200, {
            'instance_id': instance_id,
            'status': state,
            'public_ip': public_ip,
            'domain': domain,
            'env': env_name,
            'launch_time': launch_time.isoformat() if launch_time else None,
            'uptime_hours': uptime_hours,
            'websocket_url': f'wss://{domain}:8765' if state == 'running' else None
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to get EC2 status: {str(e)}'})


def start_ec2(event):
    """Start the Voice Trader EC2 instance."""
    instance_id, domain, env_name = get_ec2_config(event)
    
    try:
        result = ec2.describe_instances(InstanceIds=[instance_id])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state == 'running':
            return response(200, {'success': True, 'message': 'Already running', 'status': 'running', 'env': env_name})
        
        if current_state != 'stopped':
            return response(400, {'error': f'Cannot start from state: {current_state}'})
        
        ec2.start_instances(InstanceIds=[instance_id])
        return response(200, {'success': True, 'message': 'Starting', 'status': 'pending', 'env': env_name})
        
    except Exception as e:
        return response(500, {'error': f'Failed to start: {str(e)}'})


def stop_ec2(event):
    """Stop the Voice Trader EC2 instance."""
    instance_id, domain, env_name = get_ec2_config(event)
    
    try:
        result = ec2.describe_instances(InstanceIds=[instance_id])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state == 'stopped':
            return response(200, {'success': True, 'message': 'Already stopped', 'status': 'stopped', 'env': env_name})
        
        if current_state != 'running':
            return response(400, {'error': f'Cannot stop from state: {current_state}'})
        
        ec2.stop_instances(InstanceIds=[instance_id])
        return response(200, {'success': True, 'message': 'Stopping', 'status': 'stopping', 'env': env_name})
        
    except Exception as e:
        return response(500, {'error': f'Failed to stop: {str(e)}'})


def reboot_ec2(event):
    """Reboot the Voice Trader EC2 instance."""
    instance_id, domain, env_name = get_ec2_config(event)
    
    try:
        result = ec2.describe_instances(InstanceIds=[instance_id])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state != 'running':
            return response(400, {'error': f'Cannot reboot from state: {current_state}'})
        
        ec2.reboot_instances(InstanceIds=[instance_id])
        return response(200, {'success': True, 'message': 'Rebooting', 'status': 'rebooting', 'env': env_name})
        
    except Exception as e:
        return response(500, {'error': f'Failed to reboot: {str(e)}'})


def launch_ec2_session(event):
    """Launch a voice trader session via HTTP API on EC2.
    
    Uses the new two-process architecture:
    - API server (always running) on :8080
    - Worker process spawned on demand via POST /connect
    """
    instance_id, domain, env_name = get_ec2_config(event)
    
    body = json.loads(event.get('body', '{}'))
    
    event_ticker = body.get('event_ticker')
    audio_source = body.get('audio_source', 'phone')
    phone_number = body.get('phone_number')
    passcode = body.get('passcode')
    web_url = body.get('web_url')
    scheduled_start = body.get('scheduled_start')
    user_name = body.get('user_name', 'jimc')
    
    # Validation
    if not event_ticker:
        return response(400, {'error': 'event_ticker required'})
    
    if audio_source == 'phone' and not phone_number:
        return response(400, {'error': 'phone_number required for phone audio'})
    if audio_source == 'web' and not web_url:
        return response(400, {'error': 'web_url required for web audio'})
    
    # Check EC2 health via HTTP API (fast, no SSM)
    import urllib.request
    import ssl
    
    api_url = f'https://{domain}:8080'
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    
    try:
        health_req = urllib.request.Request(f'{api_url}/health')
        with urllib.request.urlopen(health_req, timeout=5, context=ssl_ctx) as resp:
            health_data = json.loads(resp.read().decode())
            if health_data.get('status') != 'healthy':
                return response(400, {'error': f'API server not healthy: {health_data}'})
    except Exception as e:
        return response(400, {'error': f'EC2 API not reachable ({env_name}). Is the instance running? Error: {str(e)}'})
    
    # Build connect request
    # Note: EC2 API expects session_id and stream_url (not web_url)
    session_id = event_ticker or f"session_{int(datetime.now(timezone.utc).timestamp())}"
    connect_body = {
        'session_id': session_id,
        'event_ticker': event_ticker,
        'user_name': user_name,
        'audio_source': audio_source,
        'dry_run': env_name == 'dev',  # Dev always uses dry run
    }
    
    if audio_source == 'phone':
        connect_body['phone_number'] = phone_number
        if passcode:
            connect_body['passcode'] = passcode
    else:
        # EC2 API expects stream_url, not web_url
        connect_body['stream_url'] = web_url
    
    if scheduled_start:
        if isinstance(scheduled_start, str):
            dt = datetime.fromisoformat(scheduled_start.replace('Z', '+00:00'))
            connect_body['scheduled_start'] = int(dt.timestamp())
        else:
            connect_body['scheduled_start'] = int(scheduled_start)
    
    # Call the API server's /connect endpoint
    try:
        connect_data = json.dumps(connect_body).encode('utf-8')
        connect_req = urllib.request.Request(
            f'{api_url}/connect',
            data=connect_data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(connect_req, timeout=30, context=ssl_ctx) as resp:
            result = json.loads(resp.read().decode())
            
        session_id = result.get('session_id', 'unknown')
        
        # Save state (for session tracking)
        state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
        state_table.put_item(Item={
            'session_id': session_id,
            'event_ticker': event_ticker,
            'instance_id': instance_id,
            'status': result.get('status', 'connecting'),
            'audio_source': audio_source,
            'user_name': user_name,
            'phone_number': phone_number if audio_source == 'phone' else None,
            'env': env_name,
            'started_at': datetime.now(timezone.utc).isoformat(),
            'ttl': int(datetime.now(timezone.utc).timestamp()) + (7 * 24 * 60 * 60)
        })
        
        return response(200, {
            'success': True,
            'session_id': session_id,
            'event_ticker': event_ticker,
            'env': env_name,
            'domain': domain,
            'websocket_url': f'wss://{domain}:8765',
            'message': result.get('message', 'Session started')
        })
        
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.read else str(e)
        return response(e.code, {'error': f'Failed to connect: {error_body}'})
    except Exception as e:
        return response(500, {'error': f'Failed to launch: {str(e)}'})


def add_to_queue(event):
    """Add an event to the scheduled queue."""
    try:
        body = json.loads(event.get('body', '{}'))
    except json.JSONDecodeError:
        return response(400, {'error': 'Invalid JSON body'})
    
    event_ticker = body.get('event_ticker')
    scheduled_time = body.get('scheduled_time')
    phone_number = body.get('phone_number', '')
    
    if not event_ticker or not scheduled_time:
        return response(400, {'error': 'event_ticker and scheduled_time are required'})
    
    # Parse scheduled_time to timestamp
    try:
        # Handle datetime-local format (no timezone) - assume UTC
        if 'T' in scheduled_time and not scheduled_time.endswith('Z') and '+' not in scheduled_time:
            scheduled_time = scheduled_time + ':00Z'
        scheduled_dt = datetime.fromisoformat(scheduled_time.replace('Z', '+00:00'))
        scheduled_timestamp = scheduled_dt.timestamp()
    except ValueError as e:
        return response(400, {'error': f'Invalid scheduled_time format: {str(e)}'})
    
    # Get username from auth context
    user_name = 'jimc'  # Default, should come from auth
    request_context = event.get('requestContext', {})
    authorizer = request_context.get('authorizer', {})
    if authorizer.get('claims'):
        user_name = authorizer['claims'].get('cognito:username', user_name)
    
    # Add to queue table
    queue_table = dynamodb.Table(VOICE_TRADER_QUEUE_TABLE)
    item = {
        'event_ticker': event_ticker,
        'scheduled_time': scheduled_time,
        'scheduled_timestamp': Decimal(str(scheduled_timestamp)),
        'phone_number': phone_number,
        'user_name': user_name,
        'status': 'pending',
        'created_at': datetime.now(timezone.utc).isoformat(),
        'config': {},
        'ttl': int(scheduled_timestamp) + 86400  # Expire 24h after scheduled time
    }
    queue_table.put_item(Item=item)
    
    return response(200, {
        'success': True,
        'event_ticker': event_ticker,
        'scheduled_time': scheduled_time
    })


def remove_from_queue(event):
    """Remove an event from the scheduled queue."""
    try:
        body = json.loads(event.get('body', '{}'))
    except json.JSONDecodeError:
        return response(400, {'error': 'Invalid JSON body'})
    
    event_ticker = body.get('event_ticker')
    if not event_ticker:
        return response(400, {'error': 'event_ticker is required'})
    
    # Remove from queue table
    queue_table = dynamodb.Table(VOICE_TRADER_QUEUE_TABLE)
    queue_table.delete_item(Key={'event_ticker': event_ticker})
    
    return response(200, {
        'success': True,
        'event_ticker': event_ticker,
        'removed': True
    })


def get_queue_list(event):
    """Get all queued events with stale detection.
    
    Returns events with 'is_stale' flag for events whose scheduled_time has passed.
    """
    queue_table = dynamodb.Table(VOICE_TRADER_QUEUE_TABLE)
    
    try:
        scan_result = queue_table.scan()
        items = scan_result.get('Items', [])
        
        now = datetime.now(timezone.utc)
        now_ts = now.timestamp()
        
        events = []
        stale_count = 0
        
        for item in items:
            scheduled_timestamp = float(item.get('scheduled_timestamp', 0))
            
            # Event is stale if scheduled time was more than 3 hours ago
            is_stale = scheduled_timestamp < (now_ts - 3 * 3600)
            
            # Calculate hours until/since scheduled time
            hours_diff = (scheduled_timestamp - now_ts) / 3600
            
            if is_stale:
                stale_count += 1
            
            events.append({
                'event_ticker': item.get('event_ticker'),
                'scheduled_time': item.get('scheduled_time'),
                'scheduled_timestamp': scheduled_timestamp,
                'phone_number': item.get('phone_number', ''),
                'user_name': item.get('user_name', ''),
                'status': item.get('status', 'pending'),
                'created_at': item.get('created_at'),
                'is_stale': is_stale,
                'hours_until_start': round(hours_diff, 2) if not is_stale else None,
                'hours_since_scheduled': round(-hours_diff, 2) if is_stale else None
            })
        
        # Sort by scheduled time (upcoming first, then stale)
        events.sort(key=lambda x: (x['is_stale'], x['scheduled_timestamp']))
        
        return response(200, {
            'events': events,
            'count': len(events),
            'stale_count': stale_count,
            'as_of': now.isoformat()
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to fetch queue: {str(e)}'})


def clean_stale_queue_events(event):
    """Remove stale events from the queue.
    
    An event is stale if its scheduled_time was more than 3 hours ago.
    """
    queue_table = dynamodb.Table(VOICE_TRADER_QUEUE_TABLE)
    
    try:
        scan_result = queue_table.scan()
        items = scan_result.get('Items', [])
        
        now_ts = datetime.now(timezone.utc).timestamp()
        stale_cutoff = now_ts - 3 * 3600  # 3 hours ago
        
        removed = []
        for item in items:
            scheduled_timestamp = float(item.get('scheduled_timestamp', 0))
            
            if scheduled_timestamp < stale_cutoff:
                event_ticker = item.get('event_ticker')
                queue_table.delete_item(Key={'event_ticker': event_ticker})
                removed.append(event_ticker)
        
        return response(200, {
            'success': True,
            'removed': removed,
            'removed_count': len(removed)
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to clean stale events: {str(e)}'})


def get_active_workers(event):
    """Get active workers from EC2 instance.
    
    Returns list of workers/sessions currently running on EC2.
    """
    instance_id, domain, env_name = get_ec2_config(event)
    
    # First check if EC2 is running
    try:
        result = ec2.describe_instances(InstanceIds=[instance_id])
        instance = result['Reservations'][0]['Instances'][0]
        state = instance['State']['Name']
        
        if state != 'running':
            return response(200, {
                'ec2_status': state,
                'workers': [],
                'count': 0,
                'message': 'EC2 instance not running'
            })
    except Exception as e:
        return response(500, {'error': f'Failed to check EC2 status: {str(e)}'})
    
    # Call EC2 API to get active sessions
    import urllib.request
    import ssl
    
    api_url = f'https://{domain}:8080'
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    
    try:
        status_req = urllib.request.Request(f'{api_url}/status')
        with urllib.request.urlopen(status_req, timeout=10, context=ssl_ctx) as resp:
            status_data = json.loads(resp.read().decode())
        
        workers = []
        
        # Single worker case (current architecture)
        if status_data.get('status') != 'idle':
            workers.append({
                'session_id': status_data.get('session_id', 'current'),
                'event_ticker': status_data.get('event_ticker'),
                'user_name': status_data.get('user_name'),
                'call_state': status_data.get('call_state'),
                'started_at': status_data.get('started_at'),
                'transcript_segments': status_data.get('transcript_segments', 0),
                'domain': domain,
                'websocket_url': f'wss://{domain}:8765'
            })
        
        # Also check /pool for multi-session info
        try:
            pool_req = urllib.request.Request(f'{api_url}/pool')
            with urllib.request.urlopen(pool_req, timeout=5, context=ssl_ctx) as resp:
                pool_data = json.loads(resp.read().decode())
                
            # Add active sessions from pool
            for sid, info in pool_data.get('sessions', {}).items():
                if info.get('status') != 'stopped':
                    # Don't duplicate the main session
                    if not any(w['session_id'] == sid for w in workers):
                        workers.append({
                            'session_id': sid,
                            'event_ticker': info.get('event_ticker'),
                            'user_name': info.get('user_name'),
                            'call_state': info.get('status'),
                            'started_at': info.get('started_at'),
                            'domain': domain,
                            'websocket_url': f'wss://{domain}:8765'
                        })
        except:
            pass  # Pool endpoint might not exist
        
        return response(200, {
            'ec2_status': 'running',
            'workers': workers,
            'count': len(workers),
            'domain': domain,
            'env': env_name
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to get workers: {str(e)}'})


def response(status_code: int, body: dict) -> dict:
    """Build API Gateway response."""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        },
        'body': json.dumps(body, cls=DecimalEncoder)
    }
