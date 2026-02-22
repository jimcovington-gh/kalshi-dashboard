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
import base64
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
VSCODE_EXTENSION_URL = os.environ.get('VSCODE_EXTENSION_URL', '')
if not VSCODE_EXTENSION_URL:
    raise RuntimeError('VSCODE_EXTENSION_URL environment variable is not set. Cannot start without a configured extension URL.')
AUDIT_TTL_DAYS = 90

# DynamoDB tables
device_tokens_table = dynamodb.Table(DEVICE_TOKENS_TABLE)
security_audit_table = dynamodb.Table(SECURITY_AUDIT_TABLE)

# Read-only system prompt injected for non-admin tokens
READ_ONLY_SYSTEM_PROMPT = """You are a read-only assistant for the Kalshi trading system.

STRICT RULES - FOLLOW THESE WITHOUT EXCEPTION:
1. NEVER write code that modifies existing files, databases, tables, or infrastructure.
2. NEVER write AWS CLI commands that modify resources (no put-item, update-item, delete-item, batch-write, s3 cp/mv/rm/sync, lambda update-function, cloudformation deploy, etc.).
3. NEVER write shell commands that modify files (no sed -i, no > file redirects, no rm, no git checkout/reset/revert/push/commit).
4. NEVER suggest stopping, restarting, or redeploying any running service.
5. You MAY create NEW standalone note or documentation files when explicitly asked.
6. You MAY read and explain existing code, CloudWatch logs, and data.
7. You MAY write read-only queries: DynamoDB Scan/Query/GetItem with --query, aws describe-*, aws list-*, SELECT statements.
8. If asked to do something that would modify the system, politely decline and offer a read-only alternative.

You have context about this codebase. Use it to answer questions about system state, data, and architecture."""

# Dangerous patterns to flag in responses for read_only users
import re
DANGEROUS_PATTERNS = [
    (r'aws\s+dynamodb\s+(put-item|update-item|delete-item|batch-write-item)', 'DynamoDB write'),
    (r'aws\s+s3\s+(cp|mv|rm|sync)\s', 'S3 write'),
    (r'aws\s+lambda\s+(update-function|create-function|delete-function)', 'Lambda modification'),
    (r'aws\s+cloudformation\s+(deploy|delete-stack|update-stack)', 'CloudFormation modification'),
    (r'sam\s+(deploy|build)', 'SAM deployment'),
    (r'git\s+(checkout|reset|revert|push|commit)', 'Git write operation'),
    (r'\.put_item\(|\.update_item\(|\.delete_item\(|\.batch_write_item\(', 'DynamoDB write call'),
    (r'rm\s+-rf|rm\s+-r\b', 'File deletion'),
    (r'sed\s+-i\b', 'File modification'),
]


def scan_response_for_danger(text: str) -> list:
    """Return list of dangerous pattern matches found in response text."""
    matches = []
    for pattern, label in DANGEROUS_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            matches.append(label)
    return matches


def parse_jwt_claims(token: str) -> Dict[str, Any]:
    """Decode JWT payload without signature verification (used for Function URL path).
    Security note: we rely on device token as primary secret; JWT sub just provides
    user binding. Attacker would need a valid high-entropy device token to exploit this.
    """
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return {}
        payload = parts[1]
        payload += '=' * (4 - len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Handle incoming chat requests from the dashboard."""
    logger.info(f"Received event: {json.dumps(event, default=str)[:500]}")
    
    try:
        # Extract user from Cognito JWT (already validated by API Gateway authorizer)
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        # Always use 'sub' (UUID) as the identity — it's stable and always present in JWTs
        # When called via Function URL (no API Gateway authorizer), parse JWT from header
        if not claims:
            headers = event.get('headers', {})
            auth_header = headers.get('authorization') or headers.get('Authorization', '')
            if auth_header.startswith('Bearer '):
                claims = parse_jwt_claims(auth_header[7:])
        user_name = claims.get('sub') or claims.get('cognito:username')
        
        if not user_name:
            return error_response(401, 'UNAUTHORIZED', 'Authentication required')
        
        # Get device token from header
        headers = event.get('headers', {})
        # Headers are case-insensitive in HTTP, but API Gateway may lowercase them
        device_token = headers.get('x-device-token') or headers.get('X-Device-Token')
        if device_token:
            device_token = device_token.strip().upper()
        
        if not device_token:
            log_failed_attempt(
                reason='missing_device_token',
                user_name=user_name,
                ip_address=get_client_ip(event),
                user_agent=headers.get('user-agent', 'unknown')
            )
            return error_response(404, 'NOT_FOUND', 'Not found')
        
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
            
            # Send SNS alert for suspicious activity (fire-and-forget, don't block response)
            # Note: Lambda is in VPC so SNS may not be reachable without VPC endpoint
            try:
                import threading
                t = threading.Thread(target=send_security_alert, kwargs=dict(
                    message=f"Failed device token validation: {validation_result['reason']}",
                    user_name=user_name,
                    ip=get_client_ip(event),
                    token_partial=mask_token(device_token)
                ))
                t.daemon = True
                t.start()
            except Exception:
                pass
            
            return error_response(404, 'NOT_FOUND', 'Not found')
        
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
        permissions = validation_result.get('permissions', 'read_only')
        
        # Inject system prompt for non-admin users
        system_prompt = None if permissions == 'admin' else READ_ONLY_SYSTEM_PROMPT
        
        # Proxy request to VS Code extension
        try:
            response = proxy_to_vscode(message, conversation_id, include_context, system_prompt, permissions)
            
            # Response filtering: warn if read_only response contains dangerous patterns
            if permissions != 'admin':
                dangers = scan_response_for_danger(response.get('response', ''))
                if dangers:
                    warning = f"\n\n---\n⛔ **GUARDRAIL WARNING**: This response contains potentially destructive operations ({', '.join(dangers)}). Do NOT execute these commands."
                    response['response'] = response.get('response', '') + warning
                    logger.warning(f"Dangerous patterns in response for read_only user: {dangers}")
            
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
        
        # Validate that the JWT sub matches the sub this token was bound to at creation.
        # Tokens without cognito_sub (legacy) are rejected — require re-generation.
        token_sub = item.get('cognito_sub')
        if not token_sub:
            return {
                'valid': False,
                'reason': 'token_missing_sub',
                'message': 'Token predates identity binding. Please generate a new token.'
            }
        if token_sub != user_name:  # user_name here is actually the JWT sub (UUID)
            return {
                'valid': False,
                'reason': 'token_user_mismatch',
                'message': 'Token does not belong to this user'
            }
        
        return {
            'valid': True,
            'device_name': item.get('device_name', 'Unknown'),
            'permissions': item.get('permissions', 'read_only')
        }
        
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


def proxy_to_vscode(message: str, conversation_id: Optional[str], include_context: bool, system_prompt: Optional[str] = None, permissions: str = 'read_only') -> Dict[str, Any]:
    """Proxy the chat request to the VS Code extension."""
    payload = {
        'message': message,
        'include_context': include_context
    }
    if conversation_id:
        payload['conversation_id'] = conversation_id
    if system_prompt:
        payload['system_prompt'] = system_prompt
    payload['permissions'] = permissions
    
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
        },
        'body': json.dumps(data)
    }
