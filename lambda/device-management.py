"""
Device Management Lambda - Admin API for managing device tokens

Endpoints handled:
- GET /admin/devices - List all devices (admin only)
- POST /admin/devices - Generate a new device token (admin only)
- DELETE /admin/devices/{token_partial} - Revoke a device token (admin only)
- GET /admin/security-audit - View failed authentication attempts (admin only)

Security:
- All endpoints require admin role via Cognito
- Tokens are generated server-side with secure random
- Revoked tokens remain in DB for audit trail
"""

import json
import boto3
import os
import time
import logging
import secrets
import string
from typing import Dict, Any, List
from datetime import datetime, timezone
from boto3.dynamodb.conditions import Key

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# AWS clients
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

# Configuration from environment
DEVICE_TOKENS_TABLE = os.environ.get('DEVICE_TOKENS_TABLE', 'production-kalshi-device-tokens')
SECURITY_AUDIT_TABLE = os.environ.get('SECURITY_AUDIT_TABLE', 'production-kalshi-security-audit')

# Admins who can manage devices
ADMIN_USERS = {'jimc', 'andrew', 'admin'}

# DynamoDB tables
device_tokens_table = dynamodb.Table(DEVICE_TOKENS_TABLE)
security_audit_table = dynamodb.Table(SECURITY_AUDIT_TABLE)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Route requests to appropriate handler."""
    logger.info(f"Received event: {json.dumps(event, default=str)[:500]}")
    
    try:
        # Extract user from Cognito JWT
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        user_name = claims.get('cognito:username') or claims.get('sub')
        
        if not user_name:
            return error_response(401, 'UNAUTHORIZED', 'Authentication required')
        
        # Check admin access
        if user_name not in ADMIN_USERS:
            logger.warning(f"Non-admin user {user_name} attempted to access device management")
            return error_response(403, 'FORBIDDEN', 'Admin access required')
        
        # Route based on path and method
        http_method = event.get('httpMethod', '')
        path = event.get('path', '')
        
        if path == '/admin/devices':
            if http_method == 'GET':
                return list_devices()
            elif http_method == 'POST':
                return generate_token(event, user_name)
        elif path.startswith('/admin/devices/') and http_method == 'DELETE':
            token_partial = path.split('/')[-1]
            return revoke_token(token_partial, user_name)
        elif path == '/admin/security-audit' and http_method == 'GET':
            return get_security_audit(event)
        
        return error_response(404, 'NOT_FOUND', f'Unknown endpoint: {http_method} {path}')
        
    except Exception as e:
        logger.error(f"Unhandled error: {e}", exc_info=True)
        return error_response(500, 'INTERNAL_ERROR', str(e))


def list_devices() -> Dict[str, Any]:
    """List all registered devices."""
    try:
        # Scan all devices (small table, scan is fine)
        response = device_tokens_table.scan()
        items = response.get('Items', [])
        
        # Handle pagination if needed
        while 'LastEvaluatedKey' in response:
            response = device_tokens_table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))
        
        devices = []
        for item in items:
            devices.append({
                'token_partial': mask_token(item.get('token', '')),
                'user_name': item.get('user_name'),
                'device_name': item.get('device_name'),
                'created_at': format_timestamp(item.get('created_at')),
                'created_by': item.get('created_by'),
                'last_used_at': format_timestamp(item.get('last_used_at')),
                'revoked': item.get('revoked', False),
                'revoked_at': format_timestamp(item.get('revoked_at')),
                'revoked_by': item.get('revoked_by')
            })
        
        # Sort by created_at descending (newest first)
        devices.sort(key=lambda x: x.get('created_at') or '', reverse=True)
        
        return success_response({'devices': devices})
        
    except Exception as e:
        logger.error(f"Error listing devices: {e}", exc_info=True)
        return error_response(500, 'LIST_ERROR', str(e))


def generate_token(event: Dict[str, Any], admin_user: str) -> Dict[str, Any]:
    """Generate a new device token."""
    try:
        body = json.loads(event.get('body', '{}'))
    except json.JSONDecodeError:
        return error_response(400, 'INVALID_JSON', 'Request body must be valid JSON')
    
    user_name = body.get('user_name')
    device_name = body.get('device_name')
    
    if not user_name:
        return error_response(400, 'MISSING_USER', 'user_name is required')
    if not device_name:
        return error_response(400, 'MISSING_DEVICE', 'device_name is required')
    
    try:
        # Generate a secure random token: XXXX-XXXX-XXXX-XXXX format
        token = generate_secure_token()
        now = int(time.time())
        
        # Store in DynamoDB
        device_tokens_table.put_item(Item={
            'token': token,
            'user_name': user_name,
            'device_name': device_name,
            'created_at': now,
            'created_by': admin_user,
            'last_used_at': None,
            'revoked': False,
            'revoked_at': None,
            'revoked_by': None
        })
        
        logger.info(f"Generated device token for {user_name}/{device_name} by {admin_user}")
        
        # Return the full token ONLY on creation (never shown again)
        return success_response({
            'token': token,  # Full token - only shown once!
            'user_name': user_name,
            'device_name': device_name,
            'message': 'Token generated. Copy it now - it will not be shown again!'
        })
        
    except Exception as e:
        logger.error(f"Error generating token: {e}", exc_info=True)
        return error_response(500, 'GENERATION_ERROR', str(e))


def revoke_token(token_partial: str, admin_user: str) -> Dict[str, Any]:
    """Revoke a device token by its partial identifier."""
    if not token_partial or len(token_partial) < 4:
        return error_response(400, 'INVALID_TOKEN', 'Valid token partial required')
    
    try:
        # Find the full token by partial match (scan with filter)
        response = device_tokens_table.scan()
        items = response.get('Items', [])
        
        matching_tokens = [
            item for item in items 
            if item.get('token', '').startswith(token_partial.split('-')[0])
        ]
        
        if len(matching_tokens) == 0:
            return error_response(404, 'TOKEN_NOT_FOUND', 'No matching token found')
        
        if len(matching_tokens) > 1:
            return error_response(400, 'AMBIGUOUS_TOKEN', 
                'Multiple tokens match. Use a more specific identifier.')
        
        token_item = matching_tokens[0]
        full_token = token_item['token']
        
        if token_item.get('revoked', False):
            return error_response(400, 'ALREADY_REVOKED', 'Token is already revoked')
        
        # Update the token as revoked
        now = int(time.time())
        device_tokens_table.update_item(
            Key={'token': full_token},
            UpdateExpression='SET revoked = :r, revoked_at = :t, revoked_by = :b',
            ExpressionAttributeValues={
                ':r': True,
                ':t': now,
                ':b': admin_user
            }
        )
        
        logger.info(f"Revoked token {mask_token(full_token)} for {token_item.get('user_name')} by {admin_user}")
        
        return success_response({
            'success': True,
            'message': f"Token for {token_item.get('device_name')} ({token_item.get('user_name')}) has been revoked"
        })
        
    except Exception as e:
        logger.error(f"Error revoking token: {e}", exc_info=True)
        return error_response(500, 'REVOKE_ERROR', str(e))


def get_security_audit(event: Dict[str, Any]) -> Dict[str, Any]:
    """Get recent failed authentication attempts."""
    try:
        # Get query parameters
        query_params = event.get('queryStringParameters') or {}
        days = int(query_params.get('days', '7'))
        days = min(days, 90)  # Cap at 90 days (TTL limit)
        
        # Query for each day
        failed_attempts = []
        today = datetime.now(timezone.utc)
        
        for i in range(days):
            date = today - __import__('datetime').timedelta(days=i)
            date_str = date.strftime('%Y-%m-%d')
            pk = f"FAILED_AUTH#{date_str}"
            
            try:
                response = security_audit_table.query(
                    KeyConditionExpression=Key('pk').eq(pk)
                )
                
                for item in response.get('Items', []):
                    failed_attempts.append({
                        'timestamp': format_timestamp(item.get('timestamp')),
                        'reason': item.get('reason'),
                        'ip_address': item.get('ip_address'),
                        'user_name': item.get('user_name'),
                        'device_token_partial': item.get('device_token_partial'),
                        'user_agent': item.get('user_agent', '')[:100]  # Truncate long UAs
                    })
            except Exception as e:
                logger.warning(f"Error querying security audit for {date_str}: {e}")
        
        # Sort by timestamp descending (newest first)
        failed_attempts.sort(key=lambda x: x.get('timestamp') or '', reverse=True)
        
        return success_response({
            'failed_attempts': failed_attempts,
            'total_count': len(failed_attempts),
            'days_queried': days
        })
        
    except Exception as e:
        logger.error(f"Error getting security audit: {e}", exc_info=True)
        return error_response(500, 'AUDIT_ERROR', str(e))


def generate_secure_token() -> str:
    """Generate a cryptographically secure token in XXXX-XXXX-XXXX-XXXX format."""
    # Use uppercase letters and digits, avoiding ambiguous characters (0, O, I, 1, L)
    alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    
    groups = []
    for _ in range(4):
        group = ''.join(secrets.choice(alphabet) for _ in range(4))
        groups.append(group)
    
    return '-'.join(groups)


def mask_token(token: str) -> str:
    """Mask a token for display (show first group only)."""
    if not token or len(token) < 4:
        return '****'
    parts = token.split('-')
    if len(parts) >= 1:
        return f"{parts[0]}-****-****-****"
    return f"{token[:4]}-****"


def format_timestamp(ts: Any) -> str | None:
    """Convert Unix timestamp to ISO format."""
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(int(ts), timezone.utc).isoformat()
    except (ValueError, TypeError):
        return None


def error_response(status_code: int, error_code: str, message: str) -> Dict[str, Any]:
    """Create an error response."""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization'
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
            'Access-Control-Allow-Headers': 'Content-Type,Authorization'
        },
        'body': json.dumps(data)
    }
