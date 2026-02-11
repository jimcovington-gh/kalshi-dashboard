"""
Copilot Web Proxy Lambda - Proxies authenticated requests to VS Code extension

Security:
- Layer 1: Cognito JWT (via API Gateway authorizer)
- Layer 2: Device token (X-Device-Token header, checked against DynamoDB)
- All failed attempts logged to security audit table
- SNS alerts sent for suspicious activity

Architecture:
- Browser → API Gateway → This Lambda → EC2 VS Code Extension → GitHub Copilot
"""

import json
import boto3
import os
import time
import logging
import uuid
import urllib.request
import urllib.error
from typing import Dict, Any, Optional
from datetime import datetime, timezone

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# AWS clients
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
sns = boto3.client('sns', region_name='us-east-1')

# Configuration from environment
DEVICE_TOKENS_TABLE = os.environ.get('DEVICE_TOKENS_TABLE', 'production-kalshi-device-tokens')
SECURITY_AUDIT_TABLE = os.environ.get('SECURITY_AUDIT_TABLE', 'production-kalshi-security-audit')
SNS_ALERT_TOPIC = os.environ.get('SNS_ALERT_TOPIC', '')
VSCODE_EXTENSION_URL = os.environ.get('VSCODE_EXTENSION_URL', 'http://172.31.41.120:9876')
AUDIT_TTL_DAYS = 90

# DynamoDB tables
device_tokens_table = dynamodb.Table(DEVICE_TOKENS_TABLE)
security_audit_table = dynamodb.Table(SECURITY_AUDIT_TABLE)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Handle incoming chat requests from the dashboard."""
    logger.info(f"Received event: {json.dumps(event, default=str)[:500]}")
    
    try:
        # Extract user from Cognito JWT (already validated by API Gateway authorizer)
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        user_name = claims.get('cognito:username') or claims.get('sub')
        
        if not user_name:
            return error_response(401, 'UNAUTHORIZED', 'Authentication required')
        
        # Get device token from header
        headers = event.get('headers', {})
        # Headers are case-insensitive in HTTP, but API Gateway may lowercase them
        device_token = headers.get('x-device-token') or headers.get('X-Device-Token')
        
        if not device_token:
            log_failed_attempt(
                reason='missing_device_token',
                user_name=user_name,
                ip_address=get_client_ip(event),
                user_agent=headers.get('user-agent', 'unknown')
            )
            return error_response(403, 'MISSING_DEVICE_TOKEN', 'Device token required in X-Device-Token header')
        
        # Validate device token
        validation_result = validate_device_token(device_token, user_name)
        if not validation_result['valid']:
            log_failed_attempt(
                reason=validation_result['reason'],
                user_name=user_name,
                ip_address=get_client_ip(event),
                user_agent=headers.get('user-agent', 'unknown'),
                device_token_partial=mask_token(device_token)
            )
            
            # Send SNS alert for suspicious activity
            send_security_alert(
                f"Failed device token validation: {validation_result['reason']}",
                user_name=user_name,
                ip=get_client_ip(event),
                token_partial=mask_token(device_token)
            )
            
            return error_response(403, validation_result['reason'].upper(), validation_result['message'])
        
        # Parse request body
        try:
            body = json.loads(event.get('body', '{}'))
        except json.JSONDecodeError:
            return error_response(400, 'INVALID_JSON', 'Request body must be valid JSON')
        
        message = body.get('message')
        if not message:
            return error_response(400, 'MISSING_MESSAGE', 'Request must include a "message" field')
        
        conversation_id = body.get('conversation_id')
        include_context = body.get('include_context', True)
        
        # Proxy request to VS Code extension
        try:
            response = proxy_to_vscode(message, conversation_id, include_context)
            
            # Update last_used_at for the device token
            update_token_last_used(device_token)
            
            return success_response(response)
            
        except urllib.error.URLError as e:
            logger.error(f"Failed to connect to VS Code extension: {e}")
            return error_response(503, 'EXTENSION_UNAVAILABLE', 
                'Copilot proxy extension is not available. Ensure VS Code is running with the extension active.')
        except Exception as e:
            logger.error(f"Error proxying request: {e}", exc_info=True)
            return error_response(500, 'PROXY_ERROR', str(e))
            
    except Exception as e:
        logger.error(f"Unhandled error: {e}", exc_info=True)
        return error_response(500, 'INTERNAL_ERROR', 'An unexpected error occurred')


def validate_device_token(token: str, user_name: str) -> Dict[str, Any]:
    """Validate device token against DynamoDB."""
    try:
        response = device_tokens_table.get_item(Key={'token': token})
        item = response.get('Item')
        
        if not item:
            return {
                'valid': False,
                'reason': 'unknown_token',
                'message': 'Unknown device token'
            }
        
        if item.get('revoked', False):
            return {
                'valid': False,
                'reason': 'revoked_token',
                'message': 'Device token has been revoked'
            }
        
        if item.get('user_name') != user_name:
            return {
                'valid': False,
                'reason': 'token_user_mismatch',
                'message': 'Device token is not associated with this user'
            }
        
        return {'valid': True, 'device_name': item.get('device_name', 'Unknown')}
        
    except Exception as e:
        logger.error(f"Error validating device token: {e}")
        return {
            'valid': False,
            'reason': 'validation_error',
            'message': 'Error validating device token'
        }


def update_token_last_used(token: str) -> None:
    """Update the last_used_at timestamp for a device token."""
    try:
        device_tokens_table.update_item(
            Key={'token': token},
            UpdateExpression='SET last_used_at = :time',
            ExpressionAttributeValues={':time': int(time.time())}
        )
    except Exception as e:
        # Don't fail the request if we can't update the timestamp
        logger.warning(f"Failed to update last_used_at for token: {e}")


def proxy_to_vscode(message: str, conversation_id: Optional[str], include_context: bool) -> Dict[str, Any]:
    """Proxy the chat request to the VS Code extension."""
    payload = {
        'message': message,
        'include_context': include_context
    }
    if conversation_id:
        payload['conversation_id'] = conversation_id
    
    data = json.dumps(payload).encode('utf-8')
    
    req = urllib.request.Request(
        f"{VSCODE_EXTENSION_URL}/chat",
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    
    # 5 minute timeout for long-running requests
    with urllib.request.urlopen(req, timeout=300) as response:
        return json.loads(response.read().decode('utf-8'))


def log_failed_attempt(reason: str, user_name: Optional[str], ip_address: str, 
                       user_agent: str, device_token_partial: Optional[str] = None) -> None:
    """Log failed authentication attempt to DynamoDB."""
    try:
        now = datetime.now(timezone.utc)
        date_str = now.strftime('%Y-%m-%d')
        timestamp = int(now.timestamp() * 1000)
        unique_id = str(uuid.uuid4())[:12]
        
        ttl = int(time.time()) + (AUDIT_TTL_DAYS * 24 * 60 * 60)
        
        item = {
            'pk': f"FAILED_AUTH#{date_str}",
            'sk': f"{timestamp}#{unique_id}",
            'timestamp': int(time.time()),
            'event_type': 'failed_auth',
            'reason': reason,
            'ip_address': ip_address,
            'user_agent': user_agent,
            'user_name': user_name,
            'ttl': ttl
        }
        
        if device_token_partial:
            item['device_token_partial'] = device_token_partial
        
        security_audit_table.put_item(Item=item)
        logger.warning(f"Logged failed auth attempt: {reason} from {ip_address}, user={user_name}")
        
    except Exception as e:
        logger.error(f"Failed to log security audit entry: {e}")


def send_security_alert(message: str, **kwargs) -> None:
    """Send SNS alert for security-relevant events."""
    if not SNS_ALERT_TOPIC:
        logger.warning("SNS_ALERT_TOPIC not configured, skipping alert")
        return
    
    try:
        details = '\n'.join(f"  {k}: {v}" for k, v in kwargs.items())
        full_message = f"""Security Alert: {message}

Details:
{details}

Time: {datetime.now(timezone.utc).isoformat()}
"""
        
        sns.publish(
            TopicArn=SNS_ALERT_TOPIC,
            Subject='Kalshi Dashboard Security Alert',
            Message=full_message
        )
        logger.info(f"Sent security alert: {message}")
        
    except Exception as e:
        logger.error(f"Failed to send SNS alert: {e}")


def mask_token(token: str) -> str:
    """Mask a device token for logging (show first 4 chars only)."""
    if len(token) <= 4:
        return '****'
    return f"{token[:4]}-****"


def get_client_ip(event: Dict[str, Any]) -> str:
    """Extract client IP from API Gateway event."""
    # Try X-Forwarded-For first (for clients behind proxies)
    headers = event.get('headers', {})
    forwarded_for = headers.get('x-forwarded-for') or headers.get('X-Forwarded-For')
    if forwarded_for:
        # Take the first IP (original client)
        return forwarded_for.split(',')[0].strip()
    
    # Fall back to source IP from request context
    return event.get('requestContext', {}).get('identity', {}).get('sourceIp', 'unknown')


def error_response(status_code: int, error_code: str, message: str) -> Dict[str, Any]:
    """Create an error response."""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Device-Token'
        },
        'body': json.dumps({
            'error': message,
            'code': error_code
        })
    }


def success_response(data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a success response."""
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Device-Token'
        },
        'body': json.dumps(data)
    }
