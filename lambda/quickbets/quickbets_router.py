"""
QuickBets Router Lambda

Handles container discovery and launch coordination for direct WebSocket connections.
Replaces NLB routing with direct container IP connections.

Key features:
1. Single multi-event container - one container handles ALL events
2. ECS is source of truth - no database sync issues  
3. DynamoDB lock prevents duplicate container launches
4. Direct WebSocket URL returned to browser

Flow:
1. Check ECS for running quickbets container
2. If running: return direct WebSocket URL
3. If not: acquire launch lock, start container, return "launching" status
4. Browser polls until ready
"""

import json
import boto3
import time
import os
import hmac
import hashlib
import secrets
import urllib.request
import urllib.error
from botocore.exceptions import ClientError
from decimal import Decimal

# Configuration
ECS_CLUSTER = os.environ.get('ECS_CLUSTER', 'production-kalshi-fargate-cluster')
TASK_FAMILY = os.environ.get('TASK_FAMILY', 'kalshi-quickbets')
TASK_DEFINITION = os.environ.get('TASK_DEFINITION', 'kalshi-quickbets')
SUBNET_ID = os.environ.get('SUBNET_ID', 'subnet-0ba02a0291289ed61')
SECURITY_GROUP = os.environ.get('SECURITY_GROUP', 'sg-056792d76ef21c4c5')
ENVIRONMENT = os.environ.get('ENVIRONMENT', 'production')
LOCK_TABLE = os.environ.get('LOCK_TABLE', 'production-quickbets-launch-lock')
TOKEN_SECRET = os.environ.get('TOKEN_SECRET', 'quickbets-token-secret-change-me')

# NLB configuration for TLS termination (browsers require wss:// from HTTPS pages)
NLB_TARGET_GROUP_ARN = os.environ.get('NLB_TARGET_GROUP_ARN', 
    'arn:aws:elasticloadbalancing:us-east-1:355149669325:targetgroup/quickbets-tg/cb8af6cb45089d10')
WSS_HOST = os.environ.get('WSS_HOST', 'quickbets.apexmarkets.us')

# Sports Feeder config (for preliminary game state)
SPORTSFEEDER_LAUNCHER_LAMBDA = os.environ.get('SPORTSFEEDER_LAUNCHER_LAMBDA', 'production-sportsfeeder-launch')

# Lock configuration
LOCK_TTL_SECONDS = 120  # 2 minutes - enough for container startup

# AWS clients
ecs = boto3.client('ecs')
ec2 = boto3.client('ec2')
elbv2 = boto3.client('elbv2')
dynamodb = boto3.client('dynamodb')
secrets_client = boto3.client('secretsmanager')
lambda_client = boto3.client('lambda')


def lambda_handler(event, context):
    """
    Route QuickBets connections.
    
    Returns:
    - ready: container running, here's the WebSocket URL
    - launching: container starting, poll again
    - error: something went wrong
    """
    # Handle CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return cors_response(200, '')
    
    try:
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        preferred_username = claims.get('preferred_username', '')
        user_sub = claims.get('sub', '')
        
        if not preferred_username:
            return cors_response(401, {'error': 'Authentication required'})
        
        # Parse request - event_ticker from body or query params
        body = {}
        if event.get('body'):
            try:
                body = json.loads(event['body'])
            except:
                pass
        
        event_ticker = (
            body.get('event_ticker') or 
            event.get('queryStringParameters', {}).get('event_ticker', '')
        )
        
        if not event_ticker:
            return cors_response(400, {'error': 'event_ticker is required'})
        
        print(f"Router request: user={preferred_username}, event={event_ticker}")
        
        # Check if user has trading credentials
        has_credentials, cred_error = check_user_credentials(preferred_username)
        if not has_credentials:
            return cors_response(403, {
                'error': cred_error,
                'error_code': 'NO_TRADING_CREDENTIALS'
            })
        
        # Step 1: Check ECS for running container
        container = find_running_container()
        
        if container:
            # Container is running - ensure it's registered with NLB and return wss:// URL
            register_with_nlb(container['private_ip'])
            
            token = generate_connection_token(user_sub, preferred_username, event_ticker)
            # Use wss:// via NLB for TLS (browsers block ws:// from HTTPS pages)
            ws_url = f"wss://{WSS_HOST}/{event_ticker}?token={token}&user={preferred_username}"
            
            # Try to get preliminary game state
            game_state = get_preliminary_game_state(event_ticker)
            
            response_data = {
                'status': 'ready',
                'ws_url': ws_url,
                'event_ticker': event_ticker,
                'container_ip': container['ip'],
                'token': token
            }
            if game_state:
                response_data['game_state'] = game_state
            
            print(f"Container ready: {container['ip']}")
            return cors_response(200, response_data)
        
        # Step 2: No container running - try to acquire launch lock
        lock_acquired, lock_info = try_acquire_launch_lock(context.aws_request_id)
        
        if lock_acquired:
            # We got the lock - launch container
            print("Acquired launch lock, starting container...")
            task_arn = launch_container(preferred_username)
            
            if task_arn:
                # Update lock with task ARN
                update_lock_with_task(task_arn)
                
                # Try to get game state while launching
                game_state = get_preliminary_game_state(event_ticker)
                
                response_data = {
                    'status': 'launching',
                    'task_arn': task_arn,
                    'event_ticker': event_ticker,
                    'message': 'Container starting, poll for ready'
                }
                if game_state:
                    response_data['game_state'] = game_state
                
                return cors_response(202, response_data)
            else:
                # Launch failed - release lock by setting short expiry
                release_lock()
                return cors_response(500, {'error': 'Failed to launch container'})
        else:
            # Someone else is launching - just return launching status
            print(f"Lock held by another request, task_arn={lock_info.get('task_arn')}")
            
            game_state = get_preliminary_game_state(event_ticker)
            
            response_data = {
                'status': 'launching',
                'event_ticker': event_ticker,
                'message': 'Container starting, poll for ready'
            }
            if game_state:
                response_data['game_state'] = game_state
            
            return cors_response(202, response_data)
        
    except Exception as e:
        print(f"Router error: {e}")
        import traceback
        traceback.print_exc()
        return cors_response(500, {'error': str(e)})


def find_running_container() -> dict | None:
    """
    Find a running QuickBets container.
    
    Returns dict with 'ip' (public), 'private_ip', and 'task_arn' if found, None otherwise.
    """
    try:
        # List tasks for our family
        response = ecs.list_tasks(
            cluster=ECS_CLUSTER,
            family=TASK_FAMILY,
            desiredStatus='RUNNING'
        )
        
        task_arns = response.get('taskArns', [])
        if not task_arns:
            return None
        
        # Describe the first running task
        describe_response = ecs.describe_tasks(
            cluster=ECS_CLUSTER,
            tasks=task_arns[:1]  # Just check the first one
        )
        
        for task in describe_response.get('tasks', []):
            status = task.get('lastStatus', '')
            
            if status != 'RUNNING':
                continue
            
            # Get ENI ID and private IP
            eni_id = None
            private_ip = None
            for attachment in task.get('attachments', []):
                if attachment.get('type') == 'ElasticNetworkInterface':
                    for detail in attachment.get('details', []):
                        if detail.get('name') == 'networkInterfaceId':
                            eni_id = detail.get('value')
                        if detail.get('name') == 'privateIPv4Address':
                            private_ip = detail.get('value')
            
            if not eni_id or not private_ip:
                continue
            
            # Get public IP from ENI
            try:
                eni_response = ec2.describe_network_interfaces(
                    NetworkInterfaceIds=[eni_id]
                )
                public_ip = eni_response['NetworkInterfaces'][0].get('Association', {}).get('PublicIp')
                
                if public_ip:
                    return {
                        'ip': public_ip,  # Return public IP for browser access
                        'private_ip': private_ip,
                        'task_arn': task.get('taskArn')
                    }
            except Exception as e:
                print(f"Error getting public IP for ENI {eni_id}: {e}")
                # Fall back to private IP if public IP lookup fails
                return {
                    'ip': private_ip,
                    'private_ip': private_ip,
                    'task_arn': task.get('taskArn')
                }
        
        return None
        
    except Exception as e:
        print(f"Error finding container: {e}")
        return None


def register_with_nlb(private_ip: str):
    """
    Register container with NLB target group for TLS termination.
    
    Browsers require wss:// when connecting from HTTPS pages.
    NLB handles TLS termination and forwards to container on port 8080.
    """
    try:
        # First, deregister any old targets
        current_targets = elbv2.describe_target_health(
            TargetGroupArn=NLB_TARGET_GROUP_ARN
        )
        
        for target in current_targets.get('TargetHealthDescriptions', []):
            target_id = target['Target']['Id']
            if target_id != private_ip:
                print(f"Deregistering old target: {target_id}")
                elbv2.deregister_targets(
                    TargetGroupArn=NLB_TARGET_GROUP_ARN,
                    Targets=[{'Id': target_id, 'Port': 8080}]
                )
        
        # Register the current container
        elbv2.register_targets(
            TargetGroupArn=NLB_TARGET_GROUP_ARN,
            Targets=[{'Id': private_ip, 'Port': 8080}]
        )
        print(f"Registered container {private_ip} with NLB")
        
    except Exception as e:
        print(f"Error registering with NLB: {e}")
        # Non-fatal - container might still work via direct connection


def try_acquire_launch_lock(request_id: str) -> tuple[bool, dict]:
    """
    Try to acquire the launch lock using DynamoDB conditional write.
    
    Returns (acquired: bool, lock_info: dict)
    """
    now = int(time.time())
    expires = now + LOCK_TTL_SECONDS
    
    try:
        dynamodb.put_item(
            TableName=LOCK_TABLE,
            Item={
                'pk': {'S': 'SINGLETON'},
                'lock_holder': {'S': request_id},
                'lock_expires': {'N': str(expires)},
                'locked_at': {'N': str(now)}
            },
            ConditionExpression='attribute_not_exists(pk) OR lock_expires < :now',
            ExpressionAttributeValues={
                ':now': {'N': str(now)}
            }
        )
        print(f"Lock acquired: request_id={request_id}, expires={expires}")
        return True, {}
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            # Lock is held by someone else - get the current lock info
            try:
                response = dynamodb.get_item(
                    TableName=LOCK_TABLE,
                    Key={'pk': {'S': 'SINGLETON'}}
                )
                item = response.get('Item', {})
                return False, {
                    'lock_holder': item.get('lock_holder', {}).get('S'),
                    'task_arn': item.get('task_arn', {}).get('S'),
                    'lock_expires': int(item.get('lock_expires', {}).get('N', 0))
                }
            except:
                return False, {}
        else:
            print(f"Lock error: {e}")
            raise


def update_lock_with_task(task_arn: str):
    """Update the lock record with the task ARN."""
    try:
        dynamodb.update_item(
            TableName=LOCK_TABLE,
            Key={'pk': {'S': 'SINGLETON'}},
            UpdateExpression='SET task_arn = :arn',
            ExpressionAttributeValues={
                ':arn': {'S': task_arn}
            }
        )
    except Exception as e:
        print(f"Error updating lock with task ARN: {e}")


def release_lock():
    """Release the lock by setting a very short expiry."""
    try:
        dynamodb.update_item(
            TableName=LOCK_TABLE,
            Key={'pk': {'S': 'SINGLETON'}},
            UpdateExpression='SET lock_expires = :exp',
            ExpressionAttributeValues={
                ':exp': {'N': str(int(time.time()))}  # Expire immediately
            }
        )
    except Exception as e:
        print(f"Error releasing lock: {e}")


def launch_container(user_name: str) -> str | None:
    """
    Launch a new QuickBets container.
    
    Note: The container now handles ALL events, so we don't pass EVENT_TICKER.
    """
    try:
        # Get latest task definition revision
        response = ecs.describe_task_definition(taskDefinition=TASK_DEFINITION)
        task_def_arn = response['taskDefinition']['taskDefinitionArn']
        
        # Launch task - NOTE: No EVENT_TICKER, container handles all events
        response = ecs.run_task(
            cluster=ECS_CLUSTER,
            taskDefinition=task_def_arn,
            launchType='FARGATE',
            networkConfiguration={
                'awsvpcConfiguration': {
                    'subnets': [SUBNET_ID],
                    'securityGroups': [SECURITY_GROUP],
                    'assignPublicIp': 'ENABLED'
                }
            },
            overrides={
                'containerOverrides': [{
                    'name': 'quickbets',
                    'environment': [
                        # Multi-event mode - no specific event
                        # Must explicitly set empty to override task definition default
                        {'name': 'EVENT_TICKER', 'value': ''},
                        {'name': 'MODE', 'value': 'multi_event'},
                        # First user - for credential lookup 
                        {'name': 'USER_NAME', 'value': user_name},
                        {'name': 'USER_SECRET_PREFIX', 'value': f'{ENVIRONMENT}/kalshi/users/{user_name}'},
                    ]
                }]
            }
        )
        
        tasks = response.get('tasks', [])
        if not tasks:
            failures = response.get('failures', [])
            print(f"Failed to launch task: {failures}")
            return None
        
        task_arn = tasks[0]['taskArn']
        print(f"Launched container: {task_arn}")
        return task_arn
        
    except Exception as e:
        print(f"Error launching container: {e}")
        return None


def generate_connection_token(user_sub: str, username: str, event_ticker: str) -> str:
    """
    Generate a signed token for WebSocket connection validation.
    
    Token includes:
    - user_sub: Cognito user ID
    - username: preferred_username
    - event: event ticker
    - exp: expiration timestamp
    - nonce: random value for uniqueness
    """
    exp = int(time.time()) + 300  # 5 minute expiry
    nonce = secrets.token_hex(8)
    
    # Create payload
    payload = f"{user_sub}:{username}:{event_ticker}:{exp}:{nonce}"
    
    # Sign it
    signature = hmac.new(
        TOKEN_SECRET.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()[:16]
    
    # Return as simple string (not JWT for simplicity)
    # Format: base64(payload):signature
    import base64
    token_payload = base64.b64encode(payload.encode()).decode()
    return f"{token_payload}.{signature}"


def check_user_credentials(username: str) -> tuple[bool, str]:
    """Check if user has Kalshi trading credentials."""
    secret_prefix = f'{ENVIRONMENT}/kalshi/users/{username}'
    
    try:
        secrets_client.describe_secret(SecretId=f'{secret_prefix}/metadata')
        secrets_client.describe_secret(SecretId=f'{secret_prefix}/private-key')
        return True, ""
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        if error_code == 'ResourceNotFoundException':
            return False, "No trading credentials configured for this account"
        return False, f"Error checking credentials: {e}"
    except Exception as e:
        return False, f"Unexpected error: {e}"


def get_preliminary_game_state(event_ticker: str) -> dict | None:
    """Fetch preliminary game state from sportsfeeder if available."""
    try:
        response = lambda_client.invoke(
            FunctionName=SPORTSFEEDER_LAUNCHER_LAMBDA,
            InvocationType='RequestResponse',
            Payload=json.dumps({})
        )
        
        payload = json.loads(response['Payload'].read())
        if payload.get('statusCode') != 200:
            return None
        
        feeder_ip = payload.get('ip')
        if not feeder_ip:
            return None
        
        url = f"http://{feeder_ip}:8081/game/{event_ticker}"
        req = urllib.request.Request(url, method='GET')
        req.add_header('Accept', 'application/json')
        
        with urllib.request.urlopen(req, timeout=3) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode('utf-8'))
        return None
        
    except Exception as e:
        print(f"Error fetching game state: {e}")
        return None


def cors_response(status_code: int, body):
    """Return response with CORS headers."""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        },
        'body': json.dumps(body) if isinstance(body, dict) else body
    }
