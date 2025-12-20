"""
Lambda function to get and manage mention monitor status.

GET /mention-monitors - Returns current monitor status for all users (admin only)
POST /mention-monitors/clear - Clear monitors for a specific user (admin only)
"""

import json
import boto3
from datetime import datetime, timezone
import logging
import os

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
ecs = boto3.client('ecs', region_name='us-east-1')

MENTION_STATE_TABLE = os.environ.get('MENTION_STATE_TABLE', 'production-kalshi-mention-event-state')
ECS_CLUSTER = os.environ.get('ECS_CLUSTER', 'production-kalshi-fargate-cluster')


def get_user_groups(event):
    """Extract Cognito groups from the request context."""
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        groups_str = claims.get('cognito:groups', '')
        if groups_str:
            # Groups come as a string like "[admin, users]" or "admin users"
            groups_str = groups_str.strip('[]')
            return [g.strip() for g in groups_str.replace(',', ' ').split()]
        return []
    except Exception:
        return []


def is_admin(event):
    """Check if the requesting user is an admin."""
    groups = get_user_groups(event)
    return 'admin' in groups


def get_username(event):
    """Extract username from Cognito claims."""
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        return claims.get('cognito:username', 'unknown')
    except Exception:
        return 'unknown'


def cors_response(status_code, body):
    """Return a response with CORS headers."""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
            'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
        },
        'body': json.dumps(body, default=str)
    }


def get_mention_monitors():
    """
    Get current mention monitor status for all users.
    
    Returns:
        - monitors: List of active/running monitors with event details
        - users: Summary counts by user
        - total_running: Total number of running Fargate tasks
    """
    table = dynamodb.Table(MENTION_STATE_TABLE)
    
    try:
        # Scan for all items
        response = table.scan()
        items = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))
        
        # Separate into Fargate task records (USER#xxx) and event records
        fargate_tasks = {}  # user_name -> task info
        event_records = []  # List of event monitor records
        
        for item in items:
            event_ticker = item.get('event_ticker', '')
            
            if event_ticker.startswith('USER#'):
                # This is a Fargate task record
                user_id = item.get('user_id', '') or item.get('user_name', '')
                fargate_tasks[user_id] = {
                    'task_arn': item.get('fargate_task_arn', ''),
                    'state': item.get('fargate_state', ''),
                    'started_at': item.get('fargate_started_at', ''),
                    'last_heartbeat': item.get('last_heartbeat', '')
                }
            else:
                # This is an event record
                event_records.append(item)
        
        # Build monitor list with enriched info
        monitors = []
        for item in event_records:
            user_id = item.get('user_id', '') or item.get('user_name', '')
            fargate_state = item.get('fargate_state', '')
            
            # Only include active/pending/running monitors (not completed/stale)
            if fargate_state not in ['active', 'pending', 'running']:
                continue
            
            monitor = {
                'event_ticker': item.get('event_ticker', ''),
                'user_name': user_id,
                'phase': item.get('phase', ''),
                'fargate_state': fargate_state,
                'start_date': item.get('start_date', ''),
                'close_time': item.get('close_time', 0),
                'open_time': item.get('open_time', 0),
                'created_at': item.get('created_at', ''),
                'activated_at': item.get('activated_at', ''),
                'last_heartbeat': item.get('last_heartbeat', ''),
                'fargate_instance_id': item.get('fargate_instance_id', ''),
                'phase_updated_at': item.get('phase_updated_at', '')
            }
            
            # Add Fargate task info if available for this user
            if user_id in fargate_tasks:
                task_info = fargate_tasks[user_id]
                monitor['fargate_task_arn'] = task_info['task_arn']
                monitor['fargate_task_state'] = task_info['state']
                monitor['fargate_started_at'] = task_info['started_at']
            
            monitors.append(monitor)
        
        # Build user summary
        user_counts = {}
        for monitor in monitors:
            user = monitor['user_name']  # Already contains user_id value
            if user not in user_counts:
                user_counts[user] = {
                    'active_events': 0,
                    'pending_events': 0,
                    'has_fargate': user in fargate_tasks,
                    'fargate_state': fargate_tasks.get(user, {}).get('state', 'none')
                }
            if monitor['fargate_state'] == 'active':
                user_counts[user]['active_events'] += 1
            elif monitor['fargate_state'] == 'pending':
                user_counts[user]['pending_events'] += 1
        
        # Add user summary for users with Fargate but no active events
        for user, task_info in fargate_tasks.items():
            if user not in user_counts:
                user_counts[user] = {
                    'active_events': 0,
                    'pending_events': 0,
                    'has_fargate': True,
                    'fargate_state': task_info['state']
                }
        
        # Count running Fargate tasks
        running_count = sum(1 for t in fargate_tasks.values() if t['state'] == 'running')
        
        return {
            'monitors': monitors,
            'users': user_counts,
            'total_running_fargate': running_count,
            'total_active_events': len(monitors)
        }
        
    except Exception as e:
        logger.error(f"Error getting mention monitors: {e}", exc_info=True)
        return {
            'error': str(e),
            'monitors': [],
            'users': {},
            'total_running_fargate': 0,
            'total_active_events': 0
        }


def stop_fargate_task(task_arn: str) -> bool:
    """Stop a Fargate task by ARN."""
    try:
        if not task_arn:
            return False
        ecs.stop_task(
            cluster=ECS_CLUSTER,
            task=task_arn,
            reason='Cleared by admin via dashboard'
        )
        logger.info(f"Stopped Fargate task: {task_arn}")
        return True
    except Exception as e:
        logger.error(f"Failed to stop Fargate task {task_arn}: {e}")
        return False


def clear_user_monitors(user_name: str, admin_username: str) -> dict:
    """
    Clear all monitors for a specific user.
    
    This will:
    1. Stop any running Fargate task for the user (found via ECS API)
    2. Update the USER#xxx record to 'stopped' state
    3. Update all active/pending event records to 'cleared' state
    
    Args:
        user_name: The user whose monitors should be cleared
        admin_username: The admin performing the action
        
    Returns:
        Summary of actions taken
    """
    table = dynamodb.Table(MENTION_STATE_TABLE)
    now = datetime.now(timezone.utc).isoformat()
    
    results = {
        'user_name': user_name,
        'fargate_stopped': False,
        'events_cleared': 0,
        'errors': []
    }
    
    try:
        # 1. Find and stop Fargate task(s) for this user via ECS API
        # This is more reliable than using stored task ARN which may be stale
        try:
            # List all tasks in the cluster
            task_list = ecs.list_tasks(
                cluster=ECS_CLUSTER,
                family='production-mention-market-monitor'
            )
            task_arns = task_list.get('taskArns', [])
            
            if task_arns:
                # Describe tasks to find which belong to this user
                tasks_response = ecs.describe_tasks(
                    cluster=ECS_CLUSTER,
                    tasks=task_arns
                )
                
                for task in tasks_response.get('tasks', []):
                    # Check if this task is for the target user
                    # The USER_NAME is passed as an environment variable
                    for container in task.get('containers', []):
                        # Check overrides for USER_NAME env var
                        pass  # Container env vars aren't directly exposed, check task overrides
                    
                    # Check task overrides for the USER_NAME environment variable
                    overrides = task.get('overrides', {})
                    container_overrides = overrides.get('containerOverrides', [])
                    
                    for override in container_overrides:
                        env_vars = override.get('environment', [])
                        for env in env_vars:
                            if env.get('name') == 'USER_NAME' and env.get('value') == user_name:
                                task_arn = task.get('taskArn')
                                if task_arn and task.get('lastStatus') in ['RUNNING', 'PENDING']:
                                    if stop_fargate_task(task_arn):
                                        results['fargate_stopped'] = True
                                        results['stopped_task_arn'] = task_arn
                                        logger.info(f"Stopped Fargate task for user {user_name}: {task_arn}")
                                break
        except Exception as e:
            results['errors'].append(f"Error finding/stopping Fargate task via ECS: {str(e)}")
            logger.error(f"Error finding/stopping Fargate task for {user_name}: {e}")
        
        # 2. Update the USER# record to 'stopped' (don't delete it - keep history)
        try:
            table.update_item(
                Key={'event_ticker': f'USER#{user_name}'},
                UpdateExpression='SET fargate_state = :state, stopped_at = :time, cleared_by = :admin',
                ExpressionAttributeValues={
                    ':state': 'stopped',
                    ':time': now,
                    ':admin': admin_username
                }
            )
            logger.info(f"Marked USER#{user_name} record as stopped")
        except Exception as e:
            # Record might not exist, which is fine
            logger.warning(f"Could not update USER#{user_name} record: {e}")
        
        # 3. Update all active/pending event records to 'cleared'
        response = table.scan(
            FilterExpression='(user_id = :user OR user_name = :user) AND (fargate_state = :active OR fargate_state = :pending OR fargate_state = :running)',
            ExpressionAttributeValues={
                ':user': user_name,
                ':active': 'active',
                ':pending': 'pending',
                ':running': 'running'
            }
        )
        
        items = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                ExclusiveStartKey=response['LastEvaluatedKey'],
                FilterExpression='(user_id = :user OR user_name = :user) AND (fargate_state = :active OR fargate_state = :pending OR fargate_state = :running)',
                ExpressionAttributeValues={
                    ':user': user_name,
                    ':active': 'active',
                    ':pending': 'pending',
                    ':running': 'running'
                }
            )
            items.extend(response.get('Items', []))
        
        for item in items:
            event_ticker = item.get('event_ticker', '')
            if event_ticker.startswith('USER#'):
                continue  # Skip USER# records (already handled)
            
            try:
                table.update_item(
                    Key={'event_ticker': event_ticker},
                    UpdateExpression='SET fargate_state = :state, phase = :phase, cleared_at = :time, cleared_by = :admin',
                    ExpressionAttributeValues={
                        ':state': 'cleared',
                        ':phase': 'cleared',
                        ':time': now,
                        ':admin': admin_username
                    }
                )
                results['events_cleared'] += 1
                logger.info(f"Cleared event: {event_ticker}")
            except Exception as e:
                results['errors'].append(f"Error clearing {event_ticker}: {str(e)}")
                logger.error(f"Error clearing event {event_ticker}: {e}")
        
        results['success'] = len(results['errors']) == 0
        return results
        
    except Exception as e:
        logger.error(f"Error clearing monitors for {user_name}: {e}", exc_info=True)
        results['errors'].append(str(e))
        results['success'] = False
        return results


def lambda_handler(event, context):
    """Handle GET and POST requests for mention monitors."""
    
    http_method = event.get('httpMethod', 'GET')
    path = event.get('path', '')
    
    # Handle OPTIONS for CORS preflight
    if http_method == 'OPTIONS':
        return cors_response(200, {})
    
    # All endpoints require admin
    if not is_admin(event):
        return cors_response(403, {
            'error': 'Access denied',
            'message': 'Only administrators can access mention monitors'
        })
    
    # GET /mention-monitors - Get all monitors
    if http_method == 'GET':
        status = get_mention_monitors()
        return cors_response(200, status)
    
    # POST /mention-monitors/clear - Clear monitors for a user
    elif http_method == 'POST' and '/clear' in path:
        try:
            body = json.loads(event.get('body', '{}'))
            user_name = body.get('user_name')
            
            if not user_name:
                return cors_response(400, {
                    'error': 'Missing required field',
                    'message': 'Request must include "user_name" field'
                })
            
            admin_username = get_username(event)
            logger.info(f"Admin {admin_username} clearing monitors for user {user_name}")
            
            result = clear_user_monitors(user_name, admin_username)
            
            status_code = 200 if result['success'] else 500
            return cors_response(status_code, result)
            
        except json.JSONDecodeError:
            return cors_response(400, {
                'error': 'Invalid JSON',
                'message': 'Request body must be valid JSON'
            })
        except Exception as e:
            logger.error(f"Error in clear operation: {e}", exc_info=True)
            return cors_response(500, {
                'error': 'Internal error',
                'message': str(e)
            })
    
    else:
        return cors_response(405, {
            'error': 'Method not allowed',
            'message': f'HTTP method {http_method} on path {path} not supported'
        })
