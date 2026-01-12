"""
Voice Mention Trader - Router Lambda

Handles:
- GET /voice-trader/events - List upcoming mention events (within 24 hours)
- POST /voice-trader/launch - Launch Fargate container for an event
- GET /voice-trader/status/{session_id} - Get container status
- POST /voice-trader/stop/{session_id} - Stop container
- POST /voice-trader/redial/{session_id} - Request redial via WebSocket

EC2 Control Endpoints:
- GET /voice-trader/ec2/status - Get EC2 instance status
- POST /voice-trader/ec2/start - Start EC2 instance
- POST /voice-trader/ec2/stop - Stop EC2 instance
- POST /voice-trader/ec2/reboot - Reboot EC2 instance

Called from the dashboard UI.
"""

import json
import os
import uuid
import boto3
from datetime import datetime, timezone, timedelta
from decimal import Decimal

# AWS clients
ecs = boto3.client('ecs', region_name='us-east-1')
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
ec2 = boto3.client('ec2', region_name='us-east-1')
ssm = boto3.client('ssm', region_name='us-east-1')

# Configuration
CLUSTER = os.environ.get('ECS_CLUSTER', 'production-kalshi-fargate-cluster')
TASK_FAMILY = os.environ.get('TASK_FAMILY', 'production-voice-mention-trader')
SUBNETS = os.environ.get('SUBNETS', '').split(',')
SECURITY_GROUPS = os.environ.get('SECURITY_GROUPS', '').split(',')
MARKET_METADATA_TABLE = os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata')
MENTION_EVENTS_TABLE = os.environ.get('MENTION_EVENTS_TABLE', 'production-kalshi-mention-events')
VOICE_TRADER_STATE_TABLE = os.environ.get('VOICE_TRADER_STATE_TABLE', 'production-kalshi-voice-trader-state')

# EC2 Configuration - Voice Trader instance
VOICE_TRADER_EC2_INSTANCE_ID = os.environ.get('VOICE_TRADER_EC2_INSTANCE_ID', 'i-0ae0218a057e5b4c3')
# Use domain name for WebSocket URL (Let's Encrypt cert) instead of IP
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
    
    # Parse path
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
        # Existing endpoints
        elif path.endswith('/events') and http_method == 'GET':
            return get_upcoming_events(event)
        elif path.endswith('/running') and http_method == 'GET':
            return get_running_containers(event)
        elif path.endswith('/launch') and http_method == 'POST':
            return launch_container(event)
        elif '/status/' in path and http_method == 'GET':
            session_id = path_parts[-1]
            return get_status(session_id)
        elif '/stop/' in path and http_method == 'POST':
            session_id = path_parts[-1]
            return stop_container(session_id)
        elif '/dial/' in path and http_method == 'POST':
            session_id = path_parts[-1]
            return request_dial(session_id)
        elif '/redial/' in path and http_method == 'POST':
            session_id = path_parts[-1]
            return request_redial(session_id)
        else:
            return response(404, {'error': 'Not found'})
            
    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return response(500, {'error': str(e)})


def get_upcoming_events(event):
    """
    Get mention events starting within the next 24 hours.
    
    Returns events with:
    - event_ticker
    - title
    - start_date (ISO format)
    - markets (list of words being tracked)
    """
    events_table = dynamodb.Table(MENTION_EVENTS_TABLE)
    market_table = dynamodb.Table(MARKET_METADATA_TABLE)
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    # Get current time bounds
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=24)
    
    # Scan for mention events
    mention_events = []
    
    # Scan mention events table
    scan_params = {}
    
    result = events_table.scan(**scan_params)
    items = result.get('Items', [])
    
    # Handle pagination
    while 'LastEvaluatedKey' in result:
        scan_params['ExclusiveStartKey'] = result['LastEvaluatedKey']
        result = events_table.scan(**scan_params)
        items.extend(result.get('Items', []))
    
    # Filter by start_date and enrich with market data
    for item in items:
        # Parse start_date (ISO format string like "2026-01-08T15:30:00+00:00")
        start_date_str = item.get('start_date', '')
        if not start_date_str:
            continue
            
        try:
            start_date = datetime.fromisoformat(start_date_str.replace('Z', '+00:00'))
        except (ValueError, TypeError):
            continue
        
        # Skip past events
        if start_date < now:
            continue
        
        # Skip events more than 24h out
        if start_date > cutoff:
            continue
        
        event_ticker = item.get('event_ticker', '')
        
        # Get markets for this event
        markets_result = market_table.query(
            IndexName='event-ticker-index',  # Assumes GSI exists
            KeyConditionExpression='event_ticker = :et',
            ExpressionAttributeValues={':et': event_ticker}
        ) if 'event-ticker-index' in str(market_table.table_name) else {'Items': []}
        
        # Fallback: scan with filter
        if not markets_result.get('Items'):
            markets_result = market_table.scan(
                FilterExpression='event_ticker = :et',
                ExpressionAttributeValues={':et': event_ticker}
            )
        
        markets = markets_result.get('Items', [])
        
        # Extract words from markets
        words = []
        for m in markets:
            custom_strike = m.get('custom_strike', {})
            word = custom_strike.get('Word', '')
            if word:
                words.append({
                    'market_ticker': m.get('ticker', ''),
                    'word': word
                })
        
        # Check if container is already running
        try:
            state_item = state_table.get_item(
                Key={'event_ticker': event_ticker}
            ).get('Item', {})
        except:
            state_item = {}
        
        # Calculate hours until start
        hours_until_start = round((start_date - now).total_seconds() / 3600, 1)
        
        mention_events.append({
            'event_ticker': event_ticker,
            'title': item.get('title', ''),
            'sub_title': item.get('sub_title', ''),
            'category': item.get('category', ''),
            'start_date': start_date_str,
            'strike_date': item.get('strike_date', ''),
            'hours_until_start': hours_until_start,
            'words': words,
            'word_count': len(words),
            'container_status': state_item.get('status', 'not_running'),
            'container_task_arn': state_item.get('task_arn')
        })
    
    # Sort by start_date ascending (soonest first)
    mention_events.sort(key=lambda x: x.get('start_date', ''))
    
    return response(200, {
        'events': mention_events,
        'count': len(mention_events)
    })


def get_running_containers(event):
    """
    Get all currently running voice trader containers.
    
    Returns list of running containers with their status, for reconnection.
    """
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    events_table = dynamodb.Table(MENTION_EVENTS_TABLE)
    
    # Scan for active sessions
    running_containers = []
    
    result = state_table.scan()
    items = result.get('Items', [])
    
    # Handle pagination
    while 'LastEvaluatedKey' in result:
        result = state_table.scan(ExclusiveStartKey=result['LastEvaluatedKey'])
        items.extend(result.get('Items', []))
    
    for item in items:
        status = item.get('status', '')
        session_id = item.get('session_id', '')
        task_arn = item.get('task_arn', '')
        
        # Skip stopped sessions
        if status in ['stopped', 'failed', 'completed']:
            continue
        
        # Skip old sessions (> 24 hours)
        started_at = item.get('started_at', '')
        if started_at:
            try:
                started_dt = datetime.fromisoformat(started_at.replace('Z', '+00:00'))
                if (datetime.now(timezone.utc) - started_dt).total_seconds() > 24 * 60 * 60:
                    continue
            except:
                pass
        
        # Check ECS task status
        public_ip = None
        ecs_status = 'UNKNOWN'
        if task_arn:
            try:
                tasks = ecs.describe_tasks(
                    cluster=CLUSTER,
                    tasks=[task_arn]
                ).get('tasks', [])
                
                if tasks:
                    task = tasks[0]
                    ecs_status = task.get('lastStatus', 'UNKNOWN')
                    
                    # Skip if task is not running
                    if ecs_status != 'RUNNING':
                        continue
                    
                    # Get public IP
                    attachments = task.get('attachments', [])
                    for attachment in attachments:
                        if attachment.get('type') == 'ElasticNetworkInterface':
                            for detail in attachment.get('details', []):
                                if detail.get('name') == 'networkInterfaceId':
                                    eni_id = detail.get('value')
                                    enis = ec2.describe_network_interfaces(
                                        NetworkInterfaceIds=[eni_id]
                                    ).get('NetworkInterfaces', [])
                                    if enis:
                                        public_ip = enis[0].get('Association', {}).get('PublicIp')
                else:
                    # Task not found, skip
                    continue
            except Exception as e:
                print(f"Error checking task {task_arn}: {e}")
                continue
        
        # Get event title
        event_ticker = item.get('event_ticker', '')
        title = event_ticker
        try:
            event_item = events_table.get_item(
                Key={'event_ticker': event_ticker}
            ).get('Item', {})
            title = event_item.get('title', event_ticker)
        except:
            pass
        
        running_containers.append({
            'session_id': session_id,
            'event_ticker': event_ticker,
            'title': title,
            'user_name': item.get('user_name', ''),
            'status': status,
            'call_state': item.get('call_state', ''),
            'started_at': started_at,
            'public_ip': public_ip,
            'domain': VOICE_TRADER_EC2_DOMAIN if item.get('instance_id') else None,
            'websocket_url': f'wss://{VOICE_TRADER_EC2_DOMAIN}:8765' if item.get('instance_id') else (f'wss://{public_ip}:8765' if public_ip else None)
        })
    
    # Sort by started_at descending (most recent first)
    running_containers.sort(key=lambda x: x.get('started_at', ''), reverse=True)
    
    return response(200, {
        'containers': running_containers,
        'count': len(running_containers)
    })


def launch_container(event):
    """
    Launch Fargate container for voice mention trading.
    
    Required body:
    - event_ticker: The mention event to trade
    - audio_source: "phone" or "web"
    - phone_number: Required if audio_source is "phone"
    - passcode: Required if audio_source is "phone"
    - web_url: Required if audio_source is "web"
    - user_name: User to trade as (defaults to jimc for admin)
    - qa_detection_enabled: Whether to detect Q&A transition (default true)
    - scheduled_start: ISO timestamp when call starts (optional)
    
    Returns session_id for tracking.
    """
    body = json.loads(event.get('body', '{}'))
    
    event_ticker = body.get('event_ticker')
    audio_source = body.get('audio_source', 'phone')
    phone_number = body.get('phone_number')
    passcode = body.get('passcode')
    web_url = body.get('web_url')
    user_name = body.get('user_name', 'jimc')
    qa_detection_enabled = body.get('qa_detection_enabled', True)
    scheduled_start = body.get('scheduled_start')
    
    # Validation
    if not event_ticker:
        return response(400, {'error': 'event_ticker required'})
    
    if audio_source == 'phone':
        if not phone_number:
            return response(400, {'error': 'phone_number required for phone audio'})
        # passcode is optional - some calls don't need it
    elif audio_source == 'web':
        if not web_url:
            return response(400, {'error': 'web_url required for web audio'})
    else:
        return response(400, {'error': 'audio_source must be "phone" or "web"'})
    
    # Generate unique session ID
    session_id = str(uuid.uuid4())[:8]  # Short UUID for readability
    
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    # Build environment variables
    env_vars = [
        {'name': 'SESSION_ID', 'value': session_id},
        {'name': 'EVENT_TICKER', 'value': event_ticker},
        {'name': 'USER_NAME', 'value': user_name},
        {'name': 'AUDIO_SOURCE', 'value': audio_source},
        {'name': 'QA_DETECTION_ENABLED', 'value': str(qa_detection_enabled).lower()},
        {'name': 'ENVIRONMENT', 'value': 'production'},
        {'name': 'AWS_DEFAULT_REGION', 'value': 'us-east-1'},
        # Phone provider: 'twilio' or 'telnyx' - controls which telephony service is used
        {'name': 'PHONE_PROVIDER', 'value': 'telnyx'},
    ]
    
    if audio_source == 'phone':
        env_vars.append({'name': 'PHONE_NUMBER', 'value': phone_number})
        if passcode:
            env_vars.append({'name': 'PASSCODE', 'value': passcode})
    else:
        env_vars.append({'name': 'WEB_URL', 'value': web_url})
    
    if scheduled_start:
        # Convert ISO to Unix timestamp
        if isinstance(scheduled_start, str):
            dt = datetime.fromisoformat(scheduled_start.replace('Z', '+00:00'))
            scheduled_start_ts = int(dt.timestamp())
        else:
            scheduled_start_ts = int(scheduled_start)
        env_vars.append({'name': 'SCHEDULED_START_TS', 'value': str(scheduled_start_ts)})
        # Auto-dial at scheduled time (no user interaction needed)
        env_vars.append({'name': 'AUTO_DIAL', 'value': 'true'})
    else:
        # No scheduled time - wait for user to click Start Call
        env_vars.append({'name': 'AUTO_DIAL', 'value': 'false'})
    
    # Launch ECS task
    try:
        task_response = ecs.run_task(
            cluster=CLUSTER,
            taskDefinition=TASK_FAMILY,
            launchType='FARGATE',
            networkConfiguration={
                'awsvpcConfiguration': {
                    'subnets': SUBNETS,
                    'securityGroups': SECURITY_GROUPS,
                    'assignPublicIp': 'ENABLED'
                }
            },
            overrides={
                'containerOverrides': [{
                    'name': 'voice-mention-trader',
                    'environment': env_vars
                }]
            }
        )
        
        tasks = task_response.get('tasks', [])
        if not tasks:
            failures = task_response.get('failures', [])
            return response(500, {
                'error': 'Failed to launch task',
                'failures': failures
            })
        
        task = tasks[0]
        task_arn = task['taskArn']
        
        # Save state with session_id as key
        state_table.put_item(Item={
            'session_id': session_id,
            'event_ticker': event_ticker,
            'task_arn': task_arn,
            'status': 'launching',
            'audio_source': audio_source,
            'user_name': user_name,
            'phone_number': phone_number if audio_source == 'phone' else None,
            'started_at': datetime.now(timezone.utc).isoformat(),
            'ttl': int(datetime.now(timezone.utc).timestamp()) + (7 * 24 * 60 * 60)  # 7 day TTL
        })
        
        return response(200, {
            'success': True,
            'session_id': session_id,
            'task_arn': task_arn,
            'event_ticker': event_ticker,
            'message': 'Container launching'
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to launch: {str(e)}'})


def get_status(session_id: str):
    """Get status of voice trader container by session_id."""
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    item = state_table.get_item(
        Key={'session_id': session_id}
    ).get('Item', {})
    
    if not item:
        return response(404, {'error': 'No session found'})
    
    task_arn = item.get('task_arn')
    
    # Get actual task status from ECS
    if task_arn:
        try:
            tasks = ecs.describe_tasks(
                cluster=CLUSTER,
                tasks=[task_arn]
            ).get('tasks', [])
            
            if tasks:
                task = tasks[0]
                ecs_status = task.get('lastStatus', 'UNKNOWN')
                
                # Get public IP if running
                public_ip = None
                if ecs_status == 'RUNNING':
                    # Get ENI
                    attachments = task.get('attachments', [])
                    for attachment in attachments:
                        if attachment.get('type') == 'ElasticNetworkInterface':
                            for detail in attachment.get('details', []):
                                if detail.get('name') == 'networkInterfaceId':
                                    eni_id = detail.get('value')
                                    # Get public IP from ENI
                                    enis = ec2.describe_network_interfaces(
                                        NetworkInterfaceIds=[eni_id]
                                    ).get('NetworkInterfaces', [])
                                    if enis:
                                        public_ip = enis[0].get('Association', {}).get('PublicIp')
                
                item['ecs_status'] = ecs_status
                item['public_ip'] = public_ip
                # Use wss:// for TLS - container now serves self-signed cert
                item['websocket_url'] = f'wss://{public_ip}:8765' if public_ip else None
                # URL for user to accept the self-signed certificate
                item['cert_accept_url'] = f'https://{public_ip}:8765' if public_ip else None
                
        except Exception as e:
            item['ecs_error'] = str(e)
    
    return response(200, item)


def stop_container(session_id: str):
    """Stop voice trader container by session_id."""
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    item = state_table.get_item(
        Key={'session_id': session_id}
    ).get('Item', {})
    
    if not item:
        return response(404, {'error': 'No session found'})
    
    task_arn = item.get('task_arn')
    
    if task_arn:
        try:
            ecs.stop_task(
                cluster=CLUSTER,
                task=task_arn,
                reason='User requested stop via dashboard'
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
            
            return response(200, {
                'success': True,
                'message': 'Container stopped'
            })
            
        except Exception as e:
            return response(500, {'error': f'Failed to stop: {str(e)}'})
    
    return response(400, {'error': 'No task ARN found'})


def request_dial(session_id: str):
    """
    Request initial dial via DynamoDB flag.
    
    This is an HTTP alternative to WebSocket dial command.
    Sets a flag in DynamoDB that the voice trader server polls for.
    """
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    item = state_table.get_item(
        Key={'session_id': session_id}
    ).get('Item', {})
    
    if not item:
        return response(404, {'error': 'No session found'})
    
    # Set dial_requested flag in DynamoDB
    # Voice trader server will poll this and start dialing
    state_table.update_item(
        Key={'session_id': session_id},
        UpdateExpression='SET dial_requested = :val, dial_requested_at = :ts',
        ExpressionAttributeValues={
            ':val': True,
            ':ts': datetime.now(timezone.utc).isoformat()
        }
    )
    
    print(f"Dial requested for session {session_id}")
    
    return response(200, {
        'success': True,
        'message': 'Dial request sent'
    })


def request_redial(session_id: str):
    """Request redial via container WebSocket."""
    state_table = dynamodb.Table(VOICE_TRADER_STATE_TABLE)
    
    item = state_table.get_item(
        Key={'session_id': session_id}
    ).get('Item', {})
    
    if not item:
        return response(404, {'error': 'No session found'})
    
    # The dashboard will send the redial command directly via WebSocket
    # This endpoint just validates the session exists
    
    return response(200, {
        'success': True,
        'websocket_url': item.get('websocket_url'),
        'cert_accept_url': item.get('cert_accept_url'),
        'message': 'Send redial message to WebSocket'
    })


# ============================================================================
# EC2 Control Functions
# ============================================================================

def get_ec2_status():
    """
    Get Voice Trader EC2 instance status.
    
    Returns:
    - instance_id: EC2 instance ID
    - status: running, stopped, pending, stopping, etc.
    - public_ip: Public IP if running
    - public_dns: AWS public DNS name if running
    - launch_time: When instance was launched
    - uptime_hours: Hours since launch (if running)
    - websocket_url: WebSocket URL using IP (if running)
    """
    try:
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        
        if not result.get('Reservations') or not result['Reservations'][0].get('Instances'):
            return response(404, {'error': 'EC2 instance not found'})
        
        instance = result['Reservations'][0]['Instances'][0]
        state = instance['State']['Name']
        public_ip = instance.get('PublicIpAddress')
        public_dns = instance.get('PublicDnsName')
        launch_time = instance.get('LaunchTime')
        
        # Calculate uptime if running
        uptime_hours = None
        if state == 'running' and launch_time:
            uptime_seconds = (datetime.now(timezone.utc) - launch_time.replace(tzinfo=timezone.utc)).total_seconds()
            uptime_hours = round(uptime_seconds / 3600, 2)
        
        # Build websocket URL using public IP (dynamic, like QuickBets)
        websocket_url = None
        if state == 'running' and public_ip:
            websocket_url = f'wss://{public_ip}:8765'
        
        return response(200, {
            'instance_id': VOICE_TRADER_EC2_INSTANCE_ID,
            'status': state,
            'public_ip': public_ip,
            'public_dns': public_dns,
            'launch_time': launch_time.isoformat() if launch_time else None,
            'uptime_hours': uptime_hours,
            'websocket_url': websocket_url
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to get EC2 status: {str(e)}'})


def start_ec2():
    """Start the Voice Trader EC2 instance."""
    try:
        # Check current state first
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state == 'running':
            return response(200, {
                'success': True,
                'message': 'Instance is already running',
                'status': 'running'
            })
        
        if current_state not in ['stopped']:
            return response(400, {
                'error': f'Cannot start instance in state: {current_state}',
                'status': current_state
            })
        
        # Start the instance
        ec2.start_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        
        return response(200, {
            'success': True,
            'message': 'Instance starting',
            'status': 'pending',
            'previous_state': current_state
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to start EC2: {str(e)}'})


def stop_ec2():
    """Stop the Voice Trader EC2 instance."""
    try:
        # Check current state first
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state == 'stopped':
            return response(200, {
                'success': True,
                'message': 'Instance is already stopped',
                'status': 'stopped'
            })
        
        if current_state not in ['running']:
            return response(400, {
                'error': f'Cannot stop instance in state: {current_state}',
                'status': current_state
            })
        
        # Stop the instance
        ec2.stop_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        
        return response(200, {
            'success': True,
            'message': 'Instance stopping',
            'status': 'stopping',
            'previous_state': current_state
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to stop EC2: {str(e)}'})


def reboot_ec2():
    """Reboot the Voice Trader EC2 instance."""
    try:
        # Check current state first
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        current_state = instance['State']['Name']
        
        if current_state != 'running':
            return response(400, {
                'error': f'Cannot reboot instance in state: {current_state}',
                'status': current_state
            })
        
        # Reboot the instance
        ec2.reboot_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        
        return response(200, {
            'success': True,
            'message': 'Instance rebooting',
            'status': 'rebooting'
        })
        
    except Exception as e:
        return response(500, {'error': f'Failed to reboot EC2: {str(e)}'})


def launch_ec2_session(event):
    """
    Launch a voice trader session on the EC2 instance via SSM.
    
    Similar to Fargate launch but uses SSM RunCommand to start the process.
    """
    body = json.loads(event.get('body', '{}'))
    
    event_ticker = body.get('event_ticker')
    audio_source = body.get('audio_source', 'phone')
    phone_number = body.get('phone_number')
    passcode = body.get('passcode')
    web_url = body.get('web_url')
    scheduled_start = body.get('scheduled_start')
    user_name = body.get('user_name', 'jimc')
    qa_detection_enabled = body.get('qa_detection_enabled', True)
    
    # Validation
    if not event_ticker:
        return response(400, {'error': 'event_ticker required'})
    
    if audio_source == 'phone':
        if not phone_number:
            return response(400, {'error': 'phone_number required for phone audio'})
    elif audio_source == 'web':
        if not web_url:
            return response(400, {'error': 'web_url required for web audio'})
    else:
        return response(400, {'error': 'audio_source must be "phone" or "web"'})
    
    # Check EC2 instance is running
    try:
        result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        instance = result['Reservations'][0]['Instances'][0]
        instance_state = instance['State']['Name']
        public_ip = instance.get('PublicIpAddress')
        
        if instance_state != 'running':
            return response(400, {
                'error': f'EC2 instance is {instance_state}. Start it first.',
                'status': instance_state
            })
        
        if not public_ip:
            return response(500, {'error': 'EC2 instance has no public IP'})
            
    except Exception as e:
        return response(500, {'error': f'Failed to check EC2 status: {str(e)}'})
    
    # Generate unique session ID
    session_id = str(uuid.uuid4())[:8]
    
    # Build environment variables for the command
    env_vars = {
        'SESSION_ID': session_id,
        'EVENT_TICKER': event_ticker,
        'USER_NAME': user_name,
        'AUDIO_SOURCE': audio_source,
        'QA_DETECTION_ENABLED': str(qa_detection_enabled).lower(),
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
        # Auto-dial at scheduled time (no user interaction needed)
        env_vars['AUTO_DIAL'] = 'true'
    else:
        # No scheduled time - wait for user to click Start Call
        env_vars['AUTO_DIAL'] = 'false'
    
    # Build shell command to run voice trader
    # Use bash explicitly and full venv path (SSM uses /bin/sh by default)
    # Kill any existing voice trader process first, wait for it to die
    # IMPORTANT: Use full venv path pattern to avoid killing bash shells that contain "python main.py" string
    env_exports = ' '.join([f'{k}="{v}"' for k, v in env_vars.items()])
    kill_pattern = "/opt/voice-trader/fargate-voice-mention-trader/venv/bin/python main.py"
    command = f'''#!/bin/bash
set -e

# Kill any existing voice trader process and wait for it to die
# Using full venv path to avoid matching bash shells that contain "python main.py" as args
KILL_PATTERN="{kill_pattern}"

if pgrep -f "$KILL_PATTERN" > /dev/null 2>&1; then
    echo "Killing existing voice trader process..."
    pkill -9 -f "$KILL_PATTERN" || true
    # Wait for process to actually terminate
    for i in {{1..10}}; do
        if ! pgrep -f "$KILL_PATTERN" > /dev/null 2>&1; then
            echo "Process terminated"
            break
        fi
        echo "Waiting for process to die ($i)..."
        sleep 0.5
    done
fi

cd /opt/voice-trader/fargate-voice-mention-trader
{env_exports} nohup /opt/voice-trader/fargate-voice-mention-trader/venv/bin/python main.py > /tmp/voice-trader-{session_id}.log 2>&1 &
echo $!
'''
    
    # Run command via SSM
    try:
        ssm_response = ssm.send_command(
            InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID],
            DocumentName='AWS-RunShellScript',
            Parameters={'commands': [command]},
            TimeoutSeconds=60
        )
        
        command_id = ssm_response['Command']['CommandId']
        
    except Exception as e:
        return response(500, {'error': f'Failed to send SSM command: {str(e)}'})
    
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
        'public_ip': public_ip,
        'domain': VOICE_TRADER_EC2_DOMAIN,
        'websocket_url': f'wss://{VOICE_TRADER_EC2_DOMAIN}:8765',
        'message': 'Session launching on EC2'
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
