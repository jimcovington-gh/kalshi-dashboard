"""
QuickBets Launch Lambda

Launches a new Fargate task for a SPECIFIC EVENT (not lobby mode).
User must provide event_ticker in request body.
Polls until the task has an IP, registers it to NLB target group, returns WebSocket URL.

Also returns preliminary game_state from sportsfeeder if available.
"""

import json
import boto3
import time
import os
import urllib.request
import urllib.error
from botocore.exceptions import ClientError

# Configuration - all from environment variables
ECS_CLUSTER = os.environ['ECS_CLUSTER']
TASK_DEFINITION = os.environ['TASK_DEFINITION']
SUBNET_ID = os.environ['SUBNET_ID']
SECURITY_GROUP = os.environ['SECURITY_GROUP']
TARGET_GROUP_ARN = os.environ['TARGET_GROUP_ARN']
WEBSOCKET_URL = os.environ['WEBSOCKET_URL']
QUICKBETS_TABLE = os.environ['QUICKBETS_TABLE']
ENVIRONMENT = os.environ.get('ENVIRONMENT', 'production')

# Sports Feeder config (for preliminary game state)
SPORTSFEEDER_LAUNCHER_LAMBDA = os.environ.get('SPORTSFEEDER_LAUNCHER_LAMBDA', 'production-sportsfeeder-launch')

# AWS clients
ecs = boto3.client('ecs')
elbv2 = boto3.client('elbv2')
dynamodb = boto3.resource('dynamodb')
secrets_client = boto3.client('secretsmanager')
lambda_client = boto3.client('lambda')


def find_running_task_for_event(event_ticker: str) -> dict | None:
    """Find an existing running ECS task for the given event ticker."""
    try:
        # List all running tasks for our task family
        response = ecs.list_tasks(
            cluster=ECS_CLUSTER,
            family=TASK_DEFINITION,
            desiredStatus='RUNNING'
        )
        task_arns = response.get('taskArns', [])
        
        if not task_arns:
            return None
        
        # Describe tasks to get their environment variables and IPs
        describe_response = ecs.describe_tasks(
            cluster=ECS_CLUSTER,
            tasks=task_arns
        )
        
        for task in describe_response.get('tasks', []):
            # Get the EVENT_TICKER from container overrides
            task_event = None
            for override in task.get('overrides', {}).get('containerOverrides', []):
                for env in override.get('environment', []):
                    if env.get('name') == 'EVENT_TICKER':
                        task_event = env.get('value')
                        break
            
            # Check if this task is for our event
            if task_event == event_ticker:
                # Get the task's private IP
                for attachment in task.get('attachments', []):
                    if attachment.get('type') == 'ElasticNetworkInterface':
                        for detail in attachment.get('details', []):
                            if detail.get('name') == 'privateIPv4Address':
                                return {
                                    'task_arn': task.get('taskArn'),
                                    'ip': detail.get('value'),
                                    'event_ticker': task_event
                                }
        
        return None
        
    except Exception as e:
        print(f"Error finding running task: {e}")
        return None


def ensure_target_registered(private_ip: str):
    """Ensure a target IP is registered to the NLB target group."""
    try:
        # Check if already registered
        response = elbv2.describe_target_health(
            TargetGroupArn=TARGET_GROUP_ARN,
            Targets=[{'Id': private_ip, 'Port': 8080}]
        )
        
        # If we got a response without error, check if it's registered
        for desc in response.get('TargetHealthDescriptions', []):
            state = desc.get('TargetHealth', {}).get('State', '')
            if state in ['healthy', 'initial', 'unhealthy']:
                print(f"Target {private_ip} already registered (state: {state})")
                return
        
        # Not registered, register it
        register_target(private_ip)
        
    except ClientError as e:
        if 'InvalidTarget' in str(e):
            # Target not registered, register it
            register_target(private_ip)
        else:
            print(f"Error checking target: {e}")
            # Try to register anyway
            register_target(private_ip)


def get_preliminary_game_state(event_ticker: str) -> dict | None:
    """
    Fetch preliminary game state from sportsfeeder if available.
    
    This allows the QuickBets page to show game data immediately
    without waiting for the WebSocket connection to establish.
    
    Returns game state dict or None if unavailable.
    """
    try:
        # First, get sportsfeeder IP via the launcher Lambda
        response = lambda_client.invoke(
            FunctionName=SPORTSFEEDER_LAUNCHER_LAMBDA,
            InvocationType='RequestResponse',
            Payload=json.dumps({})
        )
        
        payload = json.loads(response['Payload'].read())
        if payload.get('statusCode') != 200:
            print(f"Sportsfeeder launcher returned non-200: {payload}")
            return None
        
        feeder_ip = payload.get('ip')
        if not feeder_ip:
            print("No feeder IP returned")
            return None
        
        # Fetch game state from sportsfeeder HTTP endpoint
        url = f"http://{feeder_ip}:8081/game/{event_ticker}"
        print(f"Fetching game state from {url}")
        
        req = urllib.request.Request(url, method='GET')
        req.add_header('Accept', 'application/json')
        
        with urllib.request.urlopen(req, timeout=3) as resp:
            if resp.status == 200:
                game_data = json.loads(resp.read().decode('utf-8'))
                print(f"Got game state: {json.dumps(game_data)[:200]}...")
                return game_data
            else:
                print(f"Game endpoint returned status {resp.status}")
                return None
                
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"Game {event_ticker} not found in sportsfeeder (may not have started)")
        else:
            print(f"HTTP error fetching game state: {e}")
        return None
    except Exception as e:
        print(f"Error fetching game state: {e}")
        return None


def lambda_handler(event, context):
    """Launch a QuickBets Fargate task for a specific event."""
    
    # Handle CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return cors_response(200, '')
    
    try:
        # Get user info from Cognito authorizer
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        preferred_username = claims.get('preferred_username', '')
        
        if not preferred_username:
            return cors_response(401, {'error': 'Authentication required - preferred_username not set'})
        
        # Parse request body to get event_ticker
        body = {}
        if event.get('body'):
            try:
                body = json.loads(event['body'])
            except:
                pass
        
        event_ticker = body.get('event_ticker', '')
        if not event_ticker:
            return cors_response(400, {'error': 'event_ticker is required'})
        
        print(f"Launching QuickBets for user: {preferred_username}, event: {event_ticker}")
        
        # Check if user has Kalshi trading credentials configured
        has_credentials, cred_error = check_user_credentials(preferred_username)
        if not has_credentials:
            return cors_response(403, {
                'error': cred_error,
                'error_code': 'NO_TRADING_CREDENTIALS'
            })
        
        # First, check if there's already a RUNNING ECS task for this event
        # This is the authoritative check - DynamoDB sessions can become stale
        existing_task = find_running_task_for_event(event_ticker)
        if existing_task:
            task_ip = existing_task['ip']
            task_arn = existing_task['task_arn']
            print(f"Found existing running task for {event_ticker}: {task_ip}")
            
            # Ensure this task is registered to NLB
            ensure_target_registered(task_ip)
            
            # Try to get preliminary game state from sportsfeeder
            game_state = get_preliminary_game_state(event_ticker)
            
            response_data = {
                'websocket_url': WEBSOCKET_URL,
                'status': 'existing',
                'event_ticker': event_ticker,
                'task_ip': task_ip,
                'message': 'Found existing container for this event'
            }
            if game_state:
                response_data['game_state'] = game_state
            
            return cors_response(200, response_data)
        
        # No running task for this event - launch a new one
        task_arn = launch_fargate_task(preferred_username, event_ticker)
        if not task_arn:
            return cors_response(500, {'error': 'Failed to launch Fargate task'})
        
        print(f"Launched task: {task_arn}")
        
        # Try to get preliminary game state while we wait
        # This gives the browser something to show immediately
        game_state = get_preliminary_game_state(event_ticker)
        
        # Poll for task IP (reduced timeout - don't wait too long)
        private_ip = wait_for_task_ip(task_arn, timeout_seconds=15)
        if not private_ip:
            # Return immediately - browser will retry
            response_data = {
                'websocket_url': WEBSOCKET_URL,
                'status': 'starting',
                'task_arn': task_arn,
                'event_ticker': event_ticker,
                'message': 'Task starting, connect now and retry if needed'
            }
            if game_state:
                response_data['game_state'] = game_state
            return cors_response(202, response_data)
        
        print(f"Task IP: {private_ip}")
        
        # Register to NLB target group
        register_target(private_ip)
        
        # Save session to DynamoDB
        save_session(event_ticker, preferred_username, task_arn, private_ip)
        
        # Don't wait for health check - browser will handle retries
        # The NLB will route once healthy
        
        response_data = {
            'websocket_url': WEBSOCKET_URL,
            'status': 'ready',
            'task_arn': task_arn,
            'event_ticker': event_ticker,
            'message': 'QuickBets server ready'
        }
        if game_state:
            response_data['game_state'] = game_state
        return cors_response(200, response_data)
        
    except Exception as e:
        print(f"Error launching QuickBets: {e}")
        import traceback
        traceback.print_exc()
        return cors_response(500, {'error': str(e)})


def check_user_credentials(username: str) -> tuple[bool, str]:
    """
    Check if user has Kalshi trading credentials in Secrets Manager.
    
    Returns:
        Tuple of (has_credentials: bool, error_message: str)
    """
    secret_prefix = f'{ENVIRONMENT}/kalshi/users/{username}'
    
    try:
        # Check if metadata secret exists (contains API key)
        secrets_client.describe_secret(SecretId=f'{secret_prefix}/metadata')
        
        # Check if private key secret exists
        secrets_client.describe_secret(SecretId=f'{secret_prefix}/private-key')
        
        print(f"User {username} has valid trading credentials")
        return True, ""
        
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        
        if error_code == 'ResourceNotFoundException':
            error_msg = (
                "This account does not have Kalshi trading credentials configured. "
                "Please log in with a different account that has trading access."
            )
            print(f"User {username} missing trading credentials")
            return False, error_msg
        else:
            error_msg = f"Error checking credentials: {str(e)}"
            print(error_msg)
            return False, error_msg
    except Exception as e:
        error_msg = f"Unexpected error checking credentials: {str(e)}"
        print(error_msg)
        return False, error_msg


def check_existing_session(event_ticker: str) -> dict | None:
    """Check if there's an existing session for this event."""
    try:
        table = dynamodb.Table(QUICKBETS_TABLE)
        response = table.get_item(Key={'event_ticker': event_ticker})
        item = response.get('Item')
        
        if item:
            # Check TTL
            ttl = int(item.get('ttl', 0))
            if ttl > time.time():
                return item
        return None
    except Exception as e:
        print(f"Error checking session: {e}")
        return None


def save_session(event_ticker: str, user_name: str, task_arn: str, private_ip: str):
    """Save session to DynamoDB."""
    try:
        table = dynamodb.Table(QUICKBETS_TABLE)
        table.put_item(Item={
            'event_ticker': event_ticker,
            'user_name': user_name,
            'fargate_task_arn': task_arn,
            'fargate_private_ip': private_ip,
            'websocket_url': WEBSOCKET_URL,
            'started_at': int(time.time()),
            'ttl': int(time.time()) + 3600  # 1 hour TTL
        })
        print(f"Saved session for {event_ticker}")
    except Exception as e:
        print(f"Error saving session: {e}")


def launch_fargate_task(user_name: str, event_ticker: str) -> str | None:
    """Launch ECS Fargate task with specific event."""
    try:
        # Get latest task definition revision
        response = ecs.describe_task_definition(taskDefinition=TASK_DEFINITION)
        task_def_arn = response['taskDefinition']['taskDefinitionArn']
        
        # Launch task with USER_NAME and EVENT_TICKER
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
                        {'name': 'USER_NAME', 'value': user_name},
                        {'name': 'EVENT_TICKER', 'value': event_ticker},
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
        
        return tasks[0]['taskArn']
        
    except Exception as e:
        print(f"Error launching task: {e}")
        return None


def wait_for_task_ip(task_arn: str, timeout_seconds: int = 25) -> str | None:
    """Poll until task has a private IP address."""
    start_time = time.time()
    
    while time.time() - start_time < timeout_seconds:
        try:
            response = ecs.describe_tasks(
                cluster=ECS_CLUSTER,
                tasks=[task_arn]
            )
            
            tasks = response.get('tasks', [])
            if not tasks:
                print("Task not found")
                return None
            
            task = tasks[0]
            status = task.get('lastStatus', '')
            
            print(f"Task status: {status}")
            
            if status == 'STOPPED':
                reason = task.get('stoppedReason', 'Unknown')
                print(f"Task stopped: {reason}")
                return None
            
            # Look for private IP in attachments
            for attachment in task.get('attachments', []):
                if attachment.get('type') == 'ElasticNetworkInterface':
                    for detail in attachment.get('details', []):
                        if detail.get('name') == 'privateIPv4Address':
                            return detail.get('value')
            
            time.sleep(2)
            
        except Exception as e:
            print(f"Error checking task: {e}")
            time.sleep(2)
    
    print(f"Timeout waiting for task IP after {timeout_seconds}s")
    return None


def register_target(private_ip: str):
    """Register IP to NLB target group."""
    try:
        elbv2.register_targets(
            TargetGroupArn=TARGET_GROUP_ARN,
            Targets=[{
                'Id': private_ip,
                'Port': 8080
            }]
        )
        print(f"Registered target: {private_ip}:8080")
    except Exception as e:
        print(f"Error registering target: {e}")
        raise


def wait_for_target_healthy(private_ip: str, timeout_seconds: int = 15) -> bool:
    """Wait for NLB target to become healthy."""
    start_time = time.time()
    
    while time.time() - start_time < timeout_seconds:
        try:
            response = elbv2.describe_target_health(
                TargetGroupArn=TARGET_GROUP_ARN,
                Targets=[{'Id': private_ip, 'Port': 8080}]
            )
            
            for desc in response.get('TargetHealthDescriptions', []):
                state = desc.get('TargetHealth', {}).get('State', '')
                print(f"Target health: {state}")
                if state == 'healthy':
                    return True
            
            time.sleep(2)
            
        except Exception as e:
            print(f"Error checking target health: {e}")
            time.sleep(2)
    
    return False


def cors_response(status_code: int, body):
    """Return response with CORS headers."""
    return {
        'statusCode': status_code,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
            'Content-Type': 'application/json'
        },
        'body': json.dumps(body) if isinstance(body, dict) else body
    }
