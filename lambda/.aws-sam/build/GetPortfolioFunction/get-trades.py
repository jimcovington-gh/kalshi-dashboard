"""
Lambda function to query trades from DynamoDB
Supports user-specific queries and admin queries across all users
"""

import json
import boto3
from decimal import Decimal
from typing import Dict, List, Any
import os

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
trades_table = dynamodb.Table(os.environ.get('TRADES_TABLE', 'production-kalshi-trades'))

class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def lambda_handler(event, context):
    """
    Query trades from DynamoDB
    
    Query params:
    - ticker: Market ticker (required)
    - user_name: Username filter (optional for admin)
    
    Cognito claims (from authorizer):
    - username: Logged in user
    - cognito:groups: User groups (contains 'admin' for admin users)
    """
    
    try:
        # Parse query parameters
        params = event.get('queryStringParameters', {}) or {}
        ticker = params.get('ticker', '').upper().strip()
        requested_user = params.get('user_name', '').strip()
        
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        current_user = claims.get('cognito:username', claims.get('username', ''))
        user_groups = claims.get('cognito:groups', '').split(',') if claims.get('cognito:groups') else []
        is_admin = 'admin' in user_groups
        
        if not ticker:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'ticker parameter is required'})
            }
        
        # Build filter expression
        filter_expression = 'ticker = :ticker'
        expression_values = {':ticker': ticker}
        
        # Authorization logic
        if requested_user:
            # Specific user requested
            if not is_admin and requested_user != current_user:
                return {
                    'statusCode': 403,
                    'headers': {'Content-Type': 'application/json'},
                    'body': json.dumps({'error': 'Access denied: Cannot view other users trades'})
                }
            filter_expression += ' AND user_name = :user'
            expression_values[':user'] = requested_user
        else:
            # No user specified - default to current user unless admin
            if not is_admin:
                filter_expression += ' AND user_name = :user'
                expression_values[':user'] = current_user
            # Admin sees all trades if no user specified
        
        # Query DynamoDB
        response = trades_table.scan(
            FilterExpression=filter_expression,
            ExpressionAttributeValues=expression_values
        )
        
        trades = response.get('Items', [])
        
        # Sort by timestamp descending
        trades.sort(key=lambda x: x.get('initiated_at', ''), reverse=True)
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps({
                'ticker': ticker,
                'user': requested_user or current_user,
                'is_admin_view': is_admin and not requested_user,
                'count': len(trades),
                'trades': trades
            }, cls=DecimalEncoder)
        }
        
    except Exception as e:
        print(f"Error querying trades: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': f'Internal server error: {str(e)}'})
        }
