"""
QuickBets Sessions Lambda

Fetches active QuickBets sessions from DynamoDB for the dashboard.
"""

import json
import boto3
import time
from decimal import Decimal


def decimal_default(obj):
    """Handle Decimal serialization for JSON."""
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def lambda_handler(event, context):
    """Get active QuickBets sessions."""
    
    # Handle CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': ''
        }
    
    try:
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        current_user = claims.get('preferred_username', '')
        cognito_groups = claims.get('cognito:groups', '')
        
        if not current_user:
            return {
                'statusCode': 401,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                    'Access-Control-Allow-Methods': 'GET,OPTIONS'
                },
                'body': json.dumps({'error': 'Authentication required - preferred_username not set'})
            }
        
        # Check if user is admin
        is_admin = 'admin' in cognito_groups.lower() if cognito_groups else False
        
        # Query DynamoDB for active sessions
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table('production-kalshi-quickbets-sessions')
        
        # Get all sessions (admin) or filter by user
        response = table.scan()
        sessions = response.get('Items', [])
        
        # Filter out expired sessions (TTL check)
        now = int(time.time())
        active_sessions = []
        
        for session in sessions:
            ttl = session.get('ttl', 0)
            if ttl > now:
                # Only show sessions for this user unless admin
                session_user = session.get('user_name', '')
                if is_admin or session_user == current_user:
                    active_sessions.append({
                        'event_ticker': session.get('event_ticker', ''),
                        'user_name': session.get('user_name', ''),
                        'websocket_url': session.get('websocket_url', ''),
                        'fargate_public_ip': session.get('fargate_public_ip', ''),
                        'started_at': session.get('started_at', 0),
                        'last_heartbeat': session.get('last_heartbeat', 0),
                        'fargate_task_arn': session.get('fargate_task_arn', '')
                    })
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'sessions': active_sessions,
                'count': len(active_sessions)
            }, default=decimal_default)
        }
        
    except Exception as e:
        print(f"Error fetching sessions: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'error': str(e)
            })
        }
