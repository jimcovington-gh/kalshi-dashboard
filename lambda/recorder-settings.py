"""
Lambda function for Orderbook Recorder settings and status.

GET  /recorder-settings  - Returns current feature flag settings (all FEATURE# flags)
POST /recorder-settings  - Update a feature flag (admin only)
GET  /recorder-status    - Proxy to TIS to get recorder status (requires VPC)
"""

import json
import logging
import os
import urllib3

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
SHUTDOWN_TABLE = 'production-kalshi-trading-shutdown-signals'

TIS_ENDPOINT = os.environ.get('TIS_ENDPOINT', 'http://tis.production.local:8080')

_http = urllib3.PoolManager(
    timeout=urllib3.Timeout(connect=3.0, read=10.0),
    retries=urllib3.Retry(total=1, backoff_factor=0.5),
)

FEATURE_KEYS = {
    'recorder_enabled': 'FEATURE#orderbook_recorder',
    'record_after_trades': 'FEATURE#record_after_trades',
    'record_mention_markets': 'FEATURE#record_mention_markets',
}


def cors_response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        },
        'body': json.dumps(body),
    }


def get_user_groups(event):
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        groups_str = claims.get('cognito:groups', '')
        if groups_str:
            groups_str = groups_str.strip('[]')
            return [g.strip() for g in groups_str.replace(',', ' ').split()]
        return []
    except Exception:
        return []


def is_admin(event):
    return 'admin' in get_user_groups(event)


def get_username(event):
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        return claims.get('cognito:username', 'unknown')
    except Exception:
        return 'unknown'


def get_recorder_settings():
    """Read all FEATURE# flags from DynamoDB and return friendly dict."""
    table = dynamodb.Table(SHUTDOWN_TABLE)
    result = {}
    for friendly_key, ddb_key in FEATURE_KEYS.items():
        try:
            resp = table.get_item(Key={'signal_type': ddb_key})
            item = resp.get('Item', {})
            result[friendly_key] = bool(item.get('enabled', False))
        except Exception as e:
            logger.warning(f"Failed to read flag {ddb_key}: {e}")
            result[friendly_key] = False
    return result


def set_recorder_setting(friendly_key: str, enabled: bool, username: str):
    """Write one feature flag to DynamoDB."""
    ddb_key = FEATURE_KEYS.get(friendly_key)
    if not ddb_key:
        return None, f"Unknown setting key: {friendly_key}. Valid keys: {list(FEATURE_KEYS.keys())}"

    table = dynamodb.Table(SHUTDOWN_TABLE)
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    table.put_item(Item={
        'signal_type': ddb_key,
        'enabled': enabled,
        'reason': f"{'Enabled' if enabled else 'Disabled'} by {username}",
        'triggered_at': now,
        'triggered_by': username,
    })
    logger.info(f"RECORDER_SETTING: {ddb_key} set to {enabled} by {username}")
    return get_recorder_settings(), None


def get_recorder_status():
    """Proxy to TIS /v1/orderbook-recorder/status (requires VPC)."""
    try:
        url = f"{TIS_ENDPOINT}/v1/orderbook-recorder/status"
        resp = _http.request('GET', url)
        data = json.loads(resp.data.decode('utf-8'))
        return data, None
    except Exception as e:
        return None, f"Failed to reach TIS: {e}"


def lambda_handler(event, context):
    http_method = event.get('httpMethod', 'GET')
    path = event.get('path', '')

    if http_method == 'OPTIONS':
        return cors_response(200, {})

    if path == '/recorder-status':
        status, err = get_recorder_status()
        if err:
            return cors_response(502, {'error': err})
        return cors_response(200, status)

    if path == '/recorder-settings':
        if http_method == 'GET':
            settings = get_recorder_settings()
            return cors_response(200, settings)

        elif http_method == 'POST':
            if not is_admin(event):
                return cors_response(403, {'error': 'Access denied', 'message': 'Admins only'})
            try:
                body = json.loads(event.get('body', '{}'))
                key = body.get('key')
                enabled = body.get('enabled')
                if key is None or enabled is None:
                    return cors_response(400, {'error': 'Missing "key" or "enabled" fields'})
                username = get_username(event)
                settings, err = set_recorder_setting(key, bool(enabled), username)
                if err:
                    return cors_response(400, {'error': err})
                return cors_response(200, settings)
            except json.JSONDecodeError:
                return cors_response(400, {'error': 'Invalid JSON body'})
            except Exception as e:
                return cors_response(500, {'error': str(e)})

    return cors_response(404, {'error': f'Unknown path: {path}'})
