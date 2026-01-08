"""
Voice Mention Trader - Router Lambda

Handles:
- GET /voice-trader/events - List upcoming mention events (within 24 hours)
- POST /voice-trader/launch - Launch Fargate container for an event
- GET /voice-trader/status/{session_id} - Get container status
- POST /voice-trader/stop/{session_id} - Stop container
- POST /voice-trader/redial/{session_id} - Request redial via WebSocket

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

# Configuration
CLUSTER = os.environ.get('ECS_CLUSTER', 'production-kalshi-fargate-cluster')
TASK_FAMILY = os.environ.get('TASK_FAMILY', 'production-voice-mention-trader')
SUBNETS = os.environ.get('SUBNETS', '').split(',')
SECURITY_GROUPS = os.environ.get('SECURITY_GROUPS', '').split(',')
MARKET_METADATA_TABLE = os.environ.get('MARKET_METADATA_TABLE', 'production-kalshi-market-metadata')
MENTION_EVENTS_TABLE = os.environ.get('MENTION_EVENTS_TABLE', 'production-kalshi-mention-events')
VOICE_TRADER_STATE_TABLE = os.environ.get('VOICE_TRADER_STATE_TABLE', 'production-kalshi-voice-trader-state')


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
        if path.endswith('/events') and http_method == 'GET':
            return get_upcoming_events(event)
        elif path.endswith('/launch') and http_method == 'POST':
            return launch_container(event)
        elif '/status/' in path and http_method == 'GET':
            session_id = path_parts[-1]
            return get_status(session_id)
        elif '/stop/' in path and http_method == 'POST':
            session_id = path_parts[-1]
            return stop_container(session_id)
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
                item['websocket_url'] = f'ws://{public_ip}:8765' if public_ip else None
                
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
        'message': 'Send redial message to WebSocket'
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
