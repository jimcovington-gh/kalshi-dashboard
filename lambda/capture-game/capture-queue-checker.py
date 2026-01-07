"""
Capture Queue Checker Lambda

Triggered by EventBridge every 5 minutes to:
1. Check for captures scheduled to start in the next 10 minutes
2. Launch sportsfeeder if needed
3. Keep sportsfeeder running if captures are pending
"""

import json
import os
import time
import boto3
from datetime import datetime, timezone, timedelta
from decimal import Decimal


CAPTURE_TABLE = os.environ.get('CAPTURE_TABLE', 'production-sports-feeder-state')
SPORTSFEEDER_LAUNCH_LAMBDA = os.environ.get('SPORTSFEEDER_LAUNCH_LAMBDA', 'production-sportsfeeder-launch')


def decimal_default(obj):
    """Handle Decimal serialization for JSON."""
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def get_feeder_state():
    """Get current sportsfeeder state from DynamoDB."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(CAPTURE_TABLE)
    
    try:
        response = table.get_item(Key={'key': 'FEEDER_STATE'})
        return response.get('Item')
    except Exception as e:
        print(f"Error getting feeder state: {e}")
        return None


def get_pending_captures():
    """Get all queued captures from DynamoDB."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(CAPTURE_TABLE)
    
    captures = []
    
    try:
        response = table.scan(
            FilterExpression='begins_with(#k, :prefix) AND #status = :status',
            ExpressionAttributeNames={
                '#k': 'key',
                '#status': 'status'
            },
            ExpressionAttributeValues={
                ':prefix': 'CAPTURE_QUEUE#',
                ':status': 'queued'
            }
        )
        
        items = response.get('Items', [])
        
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression='begins_with(#k, :prefix) AND #status = :status',
                ExpressionAttributeNames={
                    '#k': 'key',
                    '#status': 'status'
                },
                ExpressionAttributeValues={
                    ':prefix': 'CAPTURE_QUEUE#',
                    ':status': 'queued'
                },
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response.get('Items', []))
        
        for item in items:
            captures.append({
                'event_ticker': item.get('event_ticker', ''),
                'scheduled_start': int(item.get('scheduled_start', 0)),
                'capture_user': item.get('capture_user', ''),
            })
        
    except Exception as e:
        print(f"Error fetching pending captures: {e}")
    
    return captures


def launch_sportsfeeder():
    """Invoke the sportsfeeder launch Lambda."""
    lambda_client = boto3.client('lambda')
    
    try:
        response = lambda_client.invoke(
            FunctionName=SPORTSFEEDER_LAUNCH_LAMBDA,
            InvocationType='Event',  # Async invocation
            Payload=json.dumps({'source': 'capture-queue-checker'})
        )
        print(f"Launched sportsfeeder: {response.get('StatusCode')}")
        return True
    except Exception as e:
        print(f"Failed to launch sportsfeeder: {e}")
        return False


def lambda_handler(event, context):
    """Main handler - check queue and launch sportsfeeder if needed."""
    print(f"Event: {json.dumps(event)}")
    
    now = int(time.time())
    
    # Get pending captures
    pending = get_pending_captures()
    print(f"Found {len(pending)} pending captures")
    
    if not pending:
        print("No pending captures, nothing to do")
        return {'statusCode': 200, 'body': 'No pending captures'}
    
    # Check if any captures start within the next 10 minutes
    start_threshold = now + (10 * 60)  # 10 minutes from now
    
    captures_due_soon = [
        c for c in pending 
        if c['scheduled_start'] <= start_threshold
    ]
    
    print(f"Captures due within 10 minutes: {len(captures_due_soon)}")
    
    if not captures_due_soon:
        print("No captures due soon")
        return {'statusCode': 200, 'body': 'No captures due soon'}
    
    # Check if sportsfeeder is already running
    feeder_state = get_feeder_state()
    
    if feeder_state:
        status = feeder_state.get('status', 'unknown')
        last_heartbeat = feeder_state.get('last_heartbeat', '')
        
        # Check if heartbeat is recent (within last 2 minutes)
        is_running = False
        if last_heartbeat:
            try:
                hb_time = datetime.fromisoformat(last_heartbeat.replace('Z', '+00:00'))
                hb_ts = int(hb_time.timestamp())
                is_running = (now - hb_ts) < 120 and status == 'running'
            except:
                pass
        
        if is_running:
            print(f"Sportsfeeder already running (status={status}, heartbeat={last_heartbeat})")
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'Sportsfeeder already running',
                    'captures_due': len(captures_due_soon)
                })
            }
    
    # Launch sportsfeeder
    print(f"Launching sportsfeeder for {len(captures_due_soon)} captures")
    
    for capture in captures_due_soon:
        print(f"  - {capture['event_ticker']} starts at {capture['scheduled_start']}")
    
    success = launch_sportsfeeder()
    
    return {
        'statusCode': 200 if success else 500,
        'body': json.dumps({
            'message': 'Sportsfeeder launch attempted' if success else 'Failed to launch',
            'captures_due': len(captures_due_soon),
            'captures': [c['event_ticker'] for c in captures_due_soon]
        })
    }
