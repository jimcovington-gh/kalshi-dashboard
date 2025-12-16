"""
QuickBets Sign Lambda - Signs Kalshi API requests for CORS test.

This Lambda retrieves the user's RSA private key from Secrets Manager
and generates the signature headers needed for authenticated Kalshi API calls.
"""

import json
import os
import base64
import hashlib
import boto3
from datetime import datetime, timezone
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend


def get_user_credentials(user_name: str) -> tuple[str, str]:
    """Get user's Kalshi API credentials from Secrets Manager."""
    secretsmanager = boto3.client('secretsmanager')
    secret_prefix = os.environ.get('USER_SECRET_PREFIX', 'production/kalshi/users')
    
    # Get API key ID
    try:
        metadata_secret = secretsmanager.get_secret_value(
            SecretId=f"{secret_prefix}/{user_name}/metadata"
        )
        metadata = json.loads(metadata_secret['SecretString'])
        api_key_id = metadata.get('api_key_id')
    except Exception as e:
        raise ValueError(f"Could not get API key for user {user_name}: {e}")
    
    # Get private key
    try:
        private_key_secret = secretsmanager.get_secret_value(
            SecretId=f"{secret_prefix}/{user_name}/private-key"
        )
        secret_value = private_key_secret['SecretString']
        
        # Handle both raw PEM and JSON format
        if secret_value.strip().startswith('{'):
            private_key_data = json.loads(secret_value)
            private_key_pem = private_key_data.get('private_key', secret_value)
        else:
            private_key_pem = secret_value
            
    except Exception as e:
        raise ValueError(f"Could not get private key for user {user_name}: {e}")
    
    return api_key_id, private_key_pem


def sign_request(method: str, path: str, api_key_id: str, private_key_pem: str) -> dict:
    """
    Generate Kalshi API signature headers.
    
    Args:
        method: HTTP method (GET, POST, etc.)
        path: API path (e.g., /trade-api/v2/portfolio/orders)
        api_key_id: Kalshi API key ID
        private_key_pem: RSA private key in PEM format
    
    Returns:
        Dict with KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP
    """
    # Load the private key
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode('utf-8'),
        password=None,
        backend=default_backend()
    )
    
    # Generate timestamp (milliseconds since epoch)
    timestamp = str(int(datetime.now(tz=timezone.utc).timestamp() * 1000))
    
    # Remove query string from path for signing
    path_without_query = path.split('?')[0]
    
    # Create message to sign: timestamp + method + path
    msg_string = f"{timestamp}{method.upper()}{path_without_query}"
    
    # Sign with RSA-PSS
    signature = private_key.sign(
        msg_string.encode('utf-8'),
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.AUTO
        ),
        hashes.SHA256()
    )
    
    # Base64 encode the signature
    signature_b64 = base64.b64encode(signature).decode('utf-8')
    
    return {
        'KALSHI-ACCESS-KEY': api_key_id,
        'KALSHI-ACCESS-SIGNATURE': signature_b64,
        'KALSHI-ACCESS-TIMESTAMP': timestamp
    }


def lambda_handler(event, context):
    """
    Lambda handler for signing Kalshi API requests.
    
    Expected input:
    {
        "method": "GET" | "POST",
        "path": "/trade-api/v2/portfolio/orders",
        "user_name": "jimc",
        "body": {} (optional, for POST requests)
    }
    
    Returns:
    {
        "headers": {
            "KALSHI-ACCESS-KEY": "...",
            "KALSHI-ACCESS-SIGNATURE": "...",
            "KALSHI-ACCESS-TIMESTAMP": "..."
        },
        "body": {} (echo back for convenience)
    }
    """
    # Parse request body
    try:
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event.get('body') or event
    except json.JSONDecodeError:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
            },
            'body': json.dumps({'error': 'Invalid JSON body'})
        }
    
    # Extract parameters
    method = body.get('method', 'GET')
    path = body.get('path')
    user_name = body.get('user_name')
    request_body = body.get('body', {})
    
    if not path:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
            },
            'body': json.dumps({'error': 'Missing required parameter: path'})
        }
    
    if not user_name:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
            },
            'body': json.dumps({'error': 'Missing required parameter: user_name'})
        }
    
    try:
        # Get user credentials
        api_key_id, private_key_pem = get_user_credentials(user_name)
        
        # Generate signature
        headers = sign_request(method, path, api_key_id, private_key_pem)
        
        response_body = {
            'headers': headers,
            'body': request_body,
            'method': method,
            'path': path,
            'timestamp_generated': headers['KALSHI-ACCESS-TIMESTAMP']
        }
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
            },
            'body': json.dumps(response_body)
        }
        
    except ValueError as e:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
            },
            'body': json.dumps({'error': str(e)})
        }
    except Exception as e:
        print(f"Error signing request: {e}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
            },
            'body': json.dumps({'error': f'Internal error: {str(e)}'})
        }
