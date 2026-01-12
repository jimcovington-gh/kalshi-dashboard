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

# EC2 Configuration
VOICE_TRADER_EC2_INSTANCE_ID = os.environ.get('VOICE_TRADER_EC2_INSTANCE_ID', 'i-0ae0218a057e5b4c3')
VOICE_TRADER_EC2_DOMAIN = os.environ.get('VOICE_TRADER_EC2_DOMAIN', 'voice.apexmarkets.us')


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def lambda_handler(event, context):
    """Main Lambda handler."""
    print(f"Event: {json.dumps(event)}")
    
    http_method = event.get('httpMethod', event.get('requestContext', {}).get('http', {}).get('method', 'GET'))
    path = event.get('path', event.get('rawPath', ''))
    path_parts = path.strip('/').split('/')
    
    try:
        # EC2 control endpoints
        if '/ec2/status' in path and http_method == 'GET':
            return get_ec2_status()
        elif '/ec2/start' in path and http_method == 'POST':
            return start_ec2()
        elif '/ec2/stop' in path and http_method == 'POST':
            return stop_ec2()
        elif '/ec2/reboot' in path and http_method == 'POST':
            return reboot_ec2()
        elif '/ec2/launch' in path and http_method == 'POST':
            return launch_ec2_session(event)
        elif '/ec2/stop-session/' in path and http_method == 'POST':
            session_id = path_parts[-1]
            return stop_session(session_id)
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
    """Get mention events starting within the next 24 hours."""
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
                
                # Include events starting within 24 hours OR already in progress (started within last 3 hours)
                three_hours_ago = now - timedelta(hours=3)
                if three_hours_ago <= start_date <= cutoff:
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
    """Stop a voice trader session by killing the process."""
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    item = state_table.get_item(Key={'session_id': session_id}).get('Item', {})
    
    if not item:
        return response(404, {'error': 'Session not found'})
    
    # Kill the process via SSM
    kill_pattern = "/opt/voice-trader/fargate-voice-mention-trader/venv/bin/python main.py"
    command = f'''#!/bin/bash
pkill -9 -f "{kill_pattern}" || echo "No process found"
'''
    
    try:
        ssm.send_command(
            InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID],
            DocumentName='AWS-RunShellScript',
            Parameters={'commands': [command]},
            TimeoutSeconds=30
        )
        
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
        
        return response(200, {'success': True, 'message': 'Session stopped'})
        
    except Exception as e:
        return response(500, {'error': f'Failed to stop session: {str(e)}'})


# ============================================================================
# EC2 Control Functions
# ============================================================================

def get_ec2_status():
    """Get Voice Trader EC2 instance status."""
    try:
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        
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
            'instance_id': VOICE_TRADER_EC2_INSTANCE_ID,
            'status': state,
            'public_ip': public_ip,
            'domain': VOICE_TRADER_EC2_DOMAIN,
            'launch_time': launch_time.isoformat() if launch_time else None,
            'uptime_hours': uptime_hours,
            'websocket_url': f'wss://{VOICE_TRADER_EC2_DOMAIN}:8765' if state == 'running' else None
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to get EC2 status: {str(e)}'})


def start_ec2():
    """Start the Voice Trader EC2 instance."""
    try:
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state == 'running':
            return response(200, {'success': True, 'message': 'Already running', 'status': 'running'})
        
        if current_state != 'stopped':
            return response(400, {'error': f'Cannot start from state: {current_state}'})
        
        ec2.start_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        return response(200, {'success': True, 'message': 'Starting', 'status': 'pending'})
        
    except Exception as e:
        return response(500, {'error': f'Failed to start: {str(e)}'})


def stop_ec2():
    """Stop the Voice Trader EC2 instance."""
    try:
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state == 'stopped':
            return response(200, {'success': True, 'message': 'Already stopped', 'status': 'stopped'})
        
        if current_state != 'running':
            return response(400, {'error': f'Cannot stop from state: {current_state}'})
        
        ec2.stop_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        return response(200, {'success': True, 'message': 'Stopping', 'status': 'stopping'})
        
    except Exception as e:
        return response(500, {'error': f'Failed to stop: {str(e)}'})


def reboot_ec2():
    """Reboot the Voice Trader EC2 instance."""
    try:
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state != 'running':
            return response(400, {'error': f'Cannot reboot from state: {current_state}'})
        
        ec2.reboot_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        return response(200, {'success': True, 'message': 'Rebooting', 'status': 'rebooting'})
        
    except Exception as e:
        return response(500, {'error': f'Failed to reboot: {str(e)}'})


def launch_ec2_session(event):
    """Launch a voice trader session on EC2 via SSM."""
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
    
    # Check EC2 is running
    try:
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        if instance['State']['Name'] != 'running':
            return response(400, {'error': 'EC2 instance not running. Start it first.'})
        public_ip = instance.get('PublicIpAddress')
    except Exception as e:
        return response(500, {'error': f'Failed to check EC2: {str(e)}'})
    
    session_id = str(uuid.uuid4())[:8]
    
    # Build environment
    env_vars = {
        'SESSION_ID': session_id,
        'EVENT_TICKER': event_ticker,
        'USER_NAME': user_name,
        'AUDIO_SOURCE': audio_source,
        'ENVIRONMENT': 'production',
        'AWS_DEFAULT_REGION': 'us-east-1',
        'PHONE_PROVIDER': 'telnyx',
    }
    
    if audio_source == 'phone':
        env_vars['PHONE_NUMBER'] = phone_number
        if passcode:
            env_vars['PASSCODE'] = passcode
    else:
        env_vars['WEB_URL'] = web_url
    
    if scheduled_start:
        if isinstance(scheduled_start, str):
            dt = datetime.fromisoformat(scheduled_start.replace('Z', '+00:00'))
            env_vars['SCHEDULED_START_TS'] = str(int(dt.timestamp()))
        else:
            env_vars['SCHEDULED_START_TS'] = str(int(scheduled_start))
        env_vars['AUTO_DIAL'] = 'true'
    else:
        env_vars['AUTO_DIAL'] = 'false'
    
    # Build command
    env_exports = ' '.join([f'{k}="{v}"' for k, v in env_vars.items()])
    kill_pattern = "/opt/voice-trader/fargate-voice-mention-trader/venv/bin/python main.py"
    command = f'''#!/bin/bash
set -e

# Kill existing process
if pgrep -f "{kill_pattern}" > /dev/null 2>&1; then
    pkill -9 -f "{kill_pattern}" || true
    sleep 1
fi

cd /opt/voice-trader/fargate-voice-mention-trader
{env_exports} nohup /opt/voice-trader/fargate-voice-mention-trader/venv/bin/python main.py > /tmp/voice-trader-{session_id}.log 2>&1 &
echo $!
'''
    
    try:
        ssm_response = ssm.send_command(
            InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID],
            DocumentName='AWS-RunShellScript',
            Parameters={'commands': [command]},
            TimeoutSeconds=60
        )
        command_id = ssm_response['Command']['CommandId']
    except Exception as e:
        return response(500, {'error': f'Failed to launch: {str(e)}'})
    
    # Save state
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    state_table.put_item(Item={
        'session_id': session_id,
        'event_ticker': event_ticker,
        'instance_id': VOICE_TRADER_EC2_INSTANCE_ID,
        'ssm_command_id': command_id,
        'status': 'launching',
        'audio_source': audio_source,
        'user_name': user_name,
        'phone_number': phone_number if audio_source == 'phone' else None,
        'public_ip': public_ip,
        'started_at': datetime.now(timezone.utc).isoformat(),
        'ttl': int(datetime.now(timezone.utc).timestamp()) + (7 * 24 * 60 * 60)
    })
    
    return response(200, {
        'success': True,
        'session_id': session_id,
        'event_ticker': event_ticker,
        'domain': VOICE_TRADER_EC2_DOMAIN,
        'websocket_url': f'wss://{VOICE_TRADER_EC2_DOMAIN}:8765',
        'message': 'Session launching'
    })


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
