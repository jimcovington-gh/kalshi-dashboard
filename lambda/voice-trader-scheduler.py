"""
Voice Trader Scheduler Lambda

Triggered by EventBridge every 5 minutes to:
1. Check for upcoming scheduled events in the queue
2. Start EC2 instance 15 minutes before scheduled events
3. Mark events as 'started' when EC2 is launched
4. Clean up stale events from the queue (optional)

EventBridge Rule: rate(5 minutes)
"""

import json
import os
import boto3
from datetime import datetime, timezone, timedelta
from decimal import Decimal

# AWS clients
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
ec2 = boto3.client('ec2', region_name='us-east-1')

# Configuration
VOICE_TRADER_QUEUE_TABLE = os.environ.get('VOICE_TRADER_QUEUE_TABLE', 'production-kalshi-voice-trader-queue')
VOICE_TRADER_EC2_INSTANCE_ID = os.environ.get('VOICE_TRADER_EC2_INSTANCE_ID', 'i-007fa64f2c29180ec')

# How many minutes before scheduled time to start EC2
START_BEFORE_MINUTES = int(os.environ.get('START_BEFORE_MINUTES', '15'))


def lambda_handler(event, context):
    """Main Lambda handler - triggered by EventBridge schedule."""
    print(f"Scheduler invoked at {datetime.now(timezone.utc).isoformat()}")
    
    try:
        result = check_and_start_for_upcoming_events()
        return {
            'statusCode': 200,
            'body': json.dumps(result)
        }
    except Exception as e:
        print(f"Scheduler error: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }


def check_and_start_for_upcoming_events():
    """Check queue for upcoming events and start EC2 if needed."""
    queue_table = dynamodb.Table(VOICE_TRADER_QUEUE_TABLE)
    
    now = datetime.now(timezone.utc)
    now_ts = now.timestamp()
    
    # Events need EC2 started if their scheduled time is within START_BEFORE_MINUTES
    start_window_ts = now_ts + (START_BEFORE_MINUTES * 60)
    
    # Scan queue for pending events
    scan_result = queue_table.scan()
    items = scan_result.get('Items', [])
    
    pending_events = []
    events_to_start = []
    stale_events = []
    
    for item in items:
        status = item.get('status', 'pending')
        scheduled_ts = float(item.get('scheduled_timestamp', 0))
        event_ticker = item.get('event_ticker', '')
        
        # Check if event is stale (more than 3 hours past scheduled time)
        if scheduled_ts < (now_ts - 3 * 3600):
            stale_events.append(event_ticker)
            continue
        
        if status == 'pending':
            pending_events.append({
                'event_ticker': event_ticker,
                'scheduled_timestamp': scheduled_ts,
                'minutes_until': (scheduled_ts - now_ts) / 60
            })
            
            # Check if this event is within the start window
            if scheduled_ts <= start_window_ts:
                events_to_start.append(event_ticker)
    
    print(f"Found {len(pending_events)} pending events, {len(events_to_start)} need EC2 start, {len(stale_events)} stale")
    
    result = {
        'timestamp': now.isoformat(),
        'pending_events': pending_events,
        'events_triggering_start': events_to_start,
        'stale_events': stale_events,
        'ec2_action': None
    }
    
    if not events_to_start:
        result['ec2_action'] = 'no_action_needed'
        return result
    
    # Check EC2 status
    ec2_result = ec2.describe_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
    instance = ec2_result['Reservations'][0]['Instances'][0]
    ec2_state = instance['State']['Name']
    
    print(f"EC2 state: {ec2_state}")
    
    if ec2_state == 'running':
        result['ec2_action'] = 'already_running'
        # Mark events as started
        for event_ticker in events_to_start:
            update_event_status(queue_table, event_ticker, 'started')
        result['events_marked_started'] = events_to_start
        return result
    
    if ec2_state == 'stopped':
        # Start EC2
        print(f"Starting EC2 instance {VOICE_TRADER_EC2_INSTANCE_ID} for events: {events_to_start}")
        ec2.start_instances(InstanceIds=[VOICE_TRADER_EC2_INSTANCE_ID])
        result['ec2_action'] = 'started'
        
        # Mark events as started
        for event_ticker in events_to_start:
            update_event_status(queue_table, event_ticker, 'started')
        result['events_marked_started'] = events_to_start
        return result
    
    # EC2 is in some other state (pending, stopping, etc.)
    result['ec2_action'] = f'ec2_in_state_{ec2_state}'
    return result


def update_event_status(table, event_ticker: str, status: str):
    """Update the status of a queued event."""
    try:
        table.update_item(
            Key={'event_ticker': event_ticker},
            UpdateExpression='SET #status = :s, started_at = :t',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':s': status,
                ':t': datetime.now(timezone.utc).isoformat()
            }
        )
        print(f"Updated {event_ticker} status to {status}")
    except Exception as e:
        print(f"Failed to update {event_ticker}: {str(e)}")
