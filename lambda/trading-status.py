"""
Lambda function to get and set trading shutdown status.

GET /trading-status - Returns current shutdown status (includes per-user/per-idea toggles)
POST /trading-status - Sets shutdown status (admin only)

Per-user/per-idea toggle records use signal_type format: "USER_IDEA#{user_name}#{idea_id}"
"""

import json
import logging
import boto3
import yaml
from datetime import datetime, timezone

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
s3_client = boto3.client('s3')
SHUTDOWN_TABLE = 'production-kalshi-trading-shutdown-signals'
CONFIG_BUCKET = 'production-kalshi-trading-config'

# Hardcoded list of trading ideas - new ideas can be added here
TRADING_IDEAS = [
    {'idea_id': 'high-confidence', 'display_name': 'High Confidence', 'description': 'Automated high-confidence trades'},
    {'idea_id': 'mention-market', 'display_name': 'Mention Markets', 'description': 'Social mention-based trading'},
    {'idea_id': 'quickbets', 'display_name': 'QuickBets', 'description': 'Manual quick betting interface'},
]


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
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        },
        'body': json.dumps(body)
    }


# Cache for users loaded from S3 (refreshed on each Lambda invocation)
_cached_users = None
_cached_user_names = None


def get_users_from_s3():
    """Load users from S3 config bucket.
    
    Returns list of user dicts with user_name and enabled status.
    Caches result for validation purposes.
    """
    global _cached_users, _cached_user_names
    
    try:
        response = s3_client.get_object(Bucket=CONFIG_BUCKET, Key='user_idea_assignments.yaml')
        content = response['Body'].read().decode('utf-8')
        data = yaml.safe_load(content)
        
        users = []
        for user_config in data.get('users', []):
            if user_config.get('enabled', True):
                users.append({
                    'user_name': user_config.get('user_name'),
                    'enabled': user_config.get('enabled', True)
                })
        
        # Cache for validation
        _cached_users = users
        _cached_user_names = {u['user_name'] for u in users}
        return users
    except Exception as e:
        print(f"Error loading users from S3: {e}")
        # Return cached if available, otherwise empty
        return _cached_users if _cached_users else []


def is_valid_user(user_name: str) -> bool:
    """Check if user_name exists in the S3 config."""
    global _cached_user_names
    
    # If cache is empty, try to load
    if _cached_user_names is None:
        get_users_from_s3()
    
    return _cached_user_names and user_name in _cached_user_names


def get_trading_status():
    """Get current trading shutdown status including per-user/per-idea toggles."""
    table = dynamodb.Table(SHUTDOWN_TABLE)
    
    try:
        # Get master shutdown status
        response = table.get_item(
            Key={'signal_type': 'MASTER_SHUTDOWN'},
            ConsistentRead=True
        )
        
        item = response.get('Item')
        master_status = {
            'trading_enabled': True,
            'shutdown_active': False,
            'reason': '',
            'triggered_at': '',
            'triggered_by': ''
        }
        
        if item:
            # enabled=true means trading ON, enabled=false means shutdown active
            enabled = item.get('enabled', True)
            master_status = {
                'trading_enabled': enabled,
                'shutdown_active': not enabled,
                'reason': item.get('reason', ''),
                'triggered_at': item.get('triggered_at', ''),
                'triggered_by': item.get('triggered_by', '')
            }
        
        # Get users from S3
        users = get_users_from_s3()
        
        # Get all per-user/per-idea toggles with pagination handling
        user_idea_toggles = {}
        
        # Scan for USER_IDEA# records (with pagination for large datasets)
        last_evaluated_key = None
        while True:
            scan_params = {
                'FilterExpression': 'begins_with(signal_type, :prefix)',
                'ExpressionAttributeValues': {':prefix': 'USER_IDEA#'}
            }
            if last_evaluated_key:
                scan_params['ExclusiveStartKey'] = last_evaluated_key
            
            scan_response = table.scan(**scan_params)
            
            for toggle_item in scan_response.get('Items', []):
                signal_type = toggle_item.get('signal_type', '')
                # Parse USER_IDEA#{user_name}#{idea_id}
                parts = signal_type.split('#')
                if len(parts) == 3:
                    _, user_name, idea_id = parts
                    if user_name not in user_idea_toggles:
                        user_idea_toggles[user_name] = {}
                    # enabled=true means trading ON
                    user_idea_toggles[user_name][idea_id] = {
                        'enabled': toggle_item.get('enabled', False),
                        'updated_at': toggle_item.get('triggered_at', ''),
                    }
            
            # Check if there are more pages
            last_evaluated_key = scan_response.get('LastEvaluatedKey')
            if not last_evaluated_key:
                break
        
        # Build the full response with defaults for missing toggles
        # Default is DISABLED (enabled=False) when record doesn't exist
        user_statuses = []
        for user in users:
            user_name = user['user_name']
            idea_statuses = {}
            
            for idea in TRADING_IDEAS:
                idea_id = idea['idea_id']
                if user_name in user_idea_toggles and idea_id in user_idea_toggles[user_name]:
                    idea_statuses[idea_id] = user_idea_toggles[user_name][idea_id]
                else:
                    # Default: disabled (no record = disabled per requirements)
                    idea_statuses[idea_id] = {'enabled': False, 'updated_at': ''}
            
            user_statuses.append({
                'user_name': user_name,
                'ideas': idea_statuses
            })
        
        return {
            **master_status,
            'ideas': TRADING_IDEAS,
            'users': user_statuses,
            'user_idea_toggles': user_idea_toggles  # Raw data for reference
        }
        
    except Exception as e:
        # On error, report unknown status
        return {
            'trading_enabled': None,
            'shutdown_active': None,
            'reason': f'Error checking status: {str(e)}',
            'triggered_at': '',
            'triggered_by': '',
            'error': str(e),
            'ideas': TRADING_IDEAS,
            'users': []
        }


def set_trading_status(enabled: bool, reason: str, username: str):
    """Set trading shutdown status and return full status."""
    table = dynamodb.Table(SHUTDOWN_TABLE)
    
    now = datetime.now(timezone.utc).isoformat()
    
    # enabled=true means trading is ON
    item = {
        'signal_type': 'MASTER_SHUTDOWN',
        'enabled': enabled,
        'reason': reason,
        'triggered_at': now,
        'triggered_by': username
    }
    
    # LOG THE MASTER SHUTDOWN TOGGLE
    logger.info(f"MASTER_SHUTDOWN_TOGGLE: enabled={enabled} reason='{reason}' triggered_by={username} triggered_at={now}")
    
    table.put_item(Item=item)
    
    logger.info(f"MASTER_SHUTDOWN_TOGGLE_COMPLETE: DynamoDB updated successfully")
    
    # Return full status including users/ideas so UI doesn't lose the grid
    return get_trading_status()


def set_user_idea_toggle(user_name: str, idea_id: str, enabled: bool, username: str):
    """Set per-user/per-idea trading toggle.
    
    Args:
        user_name: The trading user name (e.g., 'jimc')
        idea_id: The trading idea ID (e.g., 'high-confidence')
        enabled: True to enable trading, False to disable
        username: Admin username making the change
    
    Returns:
        Dict with the updated toggle status
    """
    table = dynamodb.Table(SHUTDOWN_TABLE)
    
    now = datetime.now(timezone.utc).isoformat()
    signal_type = f'USER_IDEA#{user_name}#{idea_id}'
    
    # enabled=true means trading is ON
    item = {
        'signal_type': signal_type,
        'enabled': enabled,
        'user_name': user_name,
        'idea_id': idea_id,
        'reason': f"{'Enabled' if enabled else 'Disabled'} by {username}",
        'triggered_at': now,
        'triggered_by': username
    }
    
    # LOG THE USER/IDEA TOGGLE
    action = 'ENABLED' if enabled else 'DISABLED'
    logger.info(f"USER_IDEA_TOGGLE: user={user_name} idea={idea_id} action={action} triggered_by={username} triggered_at={now}")
    
    table.put_item(Item=item)
    
    logger.info(f"USER_IDEA_TOGGLE_COMPLETE: {user_name}/{idea_id} {action} - DynamoDB updated successfully")
    
    return {
        'user_name': user_name,
        'idea_id': idea_id,
        'enabled': enabled,
        'updated_at': now,
        'updated_by': username
    }


def lambda_handler(event, context):
    """Handle GET and POST requests for trading status."""
    
    http_method = event.get('httpMethod', 'GET')
    path = event.get('path', '')
    
    # Handle OPTIONS for CORS preflight
    if http_method == 'OPTIONS':
        return cors_response(200, {})
    
    if http_method == 'GET':
        # Anyone authenticated can check status
        status = get_trading_status()
        return cors_response(200, status)
    
    elif http_method == 'POST':
        # Only admins can change status
        if not is_admin(event):
            return cors_response(403, {
                'error': 'Access denied',
                'message': 'Only administrators can change trading status'
            })
        
        try:
            body = json.loads(event.get('body', '{}'))
            username = get_username(event)
            
            # Check if this is a per-user/per-idea toggle request
            if 'user_name' in body and 'idea_id' in body:
                user_name = body.get('user_name')
                idea_id = body.get('idea_id')
                enabled = body.get('enabled')
                
                if enabled is None:
                    return cors_response(400, {
                        'error': 'Missing required field',
                        'message': 'Request must include "enabled" field (true/false)'
                    })
                
                # Validate user_name exists in S3 config
                if not is_valid_user(user_name):
                    return cors_response(400, {
                        'error': 'Invalid user_name',
                        'message': f'User "{user_name}" not found in trading config. Check for typos.'
                    })
                
                # Validate idea_id
                valid_ideas = [idea['idea_id'] for idea in TRADING_IDEAS]
                if idea_id not in valid_ideas:
                    return cors_response(400, {
                        'error': 'Invalid idea_id',
                        'message': f'idea_id must be one of: {valid_ideas}'
                    })
                
                result = set_user_idea_toggle(user_name, idea_id, enabled, username)
                return cors_response(200, result)
            
            # Otherwise, it's a master shutdown toggle
            enabled = body.get('enabled')
            reason = body.get('reason', '')
            
            if enabled is None:
                return cors_response(400, {
                    'error': 'Missing required field',
                    'message': 'Request must include "enabled" field (true/false)'
                })
            
            # Add context to reason
            if enabled:
                full_reason = f"Trading enabled by {username}" + (f": {reason}" if reason else "")
            else:
                full_reason = f"Trading disabled by {username}" + (f": {reason}" if reason else "")
            
            status = set_trading_status(enabled, full_reason, username)
            return cors_response(200, status)
            
        except json.JSONDecodeError:
            return cors_response(400, {
                'error': 'Invalid JSON',
                'message': 'Request body must be valid JSON'
            })
        except Exception as e:
            return cors_response(500, {
                'error': 'Internal error',
                'message': str(e)
            })
    
    else:
        return cors_response(405, {
            'error': 'Method not allowed',
            'message': f'HTTP method {http_method} not supported'
        })
