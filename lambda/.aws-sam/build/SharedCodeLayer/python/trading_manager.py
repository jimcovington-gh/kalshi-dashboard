"""
TradingManager Lambda - Orchestrates multi-user, multi-idea trading
Reads configuration from S3 and invokes appropriate idea Lambdas
"""

import json
import logging
import os
import boto3
from typing import Dict, List, Any

from s3_config_loader import load_user_assignments, load_lambda_registry

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# Initialize AWS clients
lambda_client = boto3.client('lambda')

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Orchestrate trading across multiple users and ideas
    
    Input event can be:
    - {} (empty) - Process all enabled users and their assigned ideas
    - {"user_name": "username"} - Process specific user's assigned ideas
    - {"idea_name": "idea-id"} - Process all users assigned to this idea
    """
    logger.info("TradingManager invoked", extra={
        "event": event,
        "request_id": context.aws_request_id
    })
    
    try:
        # Load configuration from S3
        user_assignments = load_user_assignments()
        lambda_registry = load_lambda_registry()
        
        # Build lookup dict for lambdas
        lambda_lookup = {}
        for lambda_config in lambda_registry.get('lambdas', []):
            lambda_lookup[lambda_config['idea_id']] = lambda_config['function_name']
        
        logger.info("Loaded configuration from S3", extra={
            "user_count": len(user_assignments.get('users', [])),
            "lambda_count": len(lambda_lookup)
        })
        
        # Determine what to process
        user_filter = event.get('user_name')
        idea_filter = event.get('idea_name')
        
        # Build execution plan
        executions = []
        
        for user_config in user_assignments.get('users', []):
            user_name = user_config['user_name']
            
            # Apply user filter if specified
            if user_filter and user_name != user_filter:
                continue
            
            # Skip disabled users
            if not user_config.get('enabled', True):
                logger.info(f"Skipping disabled user", extra={"user_name": user_name})
                continue
            
            # Process each idea assigned to this user
            for idea_assignment in user_config.get('ideas', []):
                idea_id = idea_assignment['idea_id']
                
                # Apply idea filter if specified
                if idea_filter and idea_id != idea_filter:
                    continue
                
                # Skip disabled ideas
                if not idea_assignment.get('enabled', True):
                    logger.info(f"Skipping disabled idea", extra={
                        "user_name": user_name,
                        "idea_id": idea_id
                    })
                    continue
                
                # Look up Lambda function for this idea
                lambda_function = lambda_lookup.get(idea_id)
                
                if not lambda_function:
                    logger.warning(f"No Lambda registered for idea", extra={
                        "idea_id": idea_id,
                        "user_name": user_name
                    })
                    continue
                
                executions.append({
                    'user_name': user_name,
                    'idea_id': idea_id,
                    'lambda_function': lambda_function
                })
        
        logger.info(f"Execution plan created", extra={
            "execution_count": len(executions)
        })
        
        # Execute each Lambda asynchronously
        results = []
        for execution in executions:
            try:
                payload = {
                    'user_name': execution['user_name']
                }
                
                logger.info(f"Invoking idea Lambda", extra={
                    "user_name": execution['user_name'],
                    "idea_id": execution['idea_id'],
                    "lambda_function": execution['lambda_function']
                })
                
                response = lambda_client.invoke(
                    FunctionName=execution['lambda_function'],
                    InvocationType='Event',  # Asynchronous
                    Payload=json.dumps(payload)
                )
                
                results.append({
                    'user_name': execution['user_name'],
                    'idea_id': execution['idea_id'],
                    'lambda_function': execution['lambda_function'],
                    'status': 'invoked',
                    'status_code': response['StatusCode']
                })
                
            except Exception as e:
                logger.error(f"Failed to invoke Lambda", extra={
                    "user_name": execution['user_name'],
                    "idea_id": execution['idea_id'],
                    "lambda_function": execution['lambda_function'],
                    "error": str(e)
                })
                
                results.append({
                    'user_name': execution['user_name'],
                    'idea_id': execution['idea_id'],
                    'lambda_function': execution['lambda_function'],
                    'status': 'failed',
                    'error': str(e)
                })
        
        # Summary
        successful = sum(1 for r in results if r['status'] == 'invoked')
        failed = sum(1 for r in results if r['status'] == 'failed')
        
        logger.info("TradingManager completed", extra={
            "total_executions": len(results),
            "successful": successful,
            "failed": failed
        })
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'execution_count': len(results),
                'successful': successful,
                'failed': failed,
                'results': results
            })
        }
        
    except Exception as e:
        logger.error(f"TradingManager failed", extra={
            "error": str(e),
            "error_type": type(e).__name__
        }, exc_info=True)
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'error_type': type(e).__name__
            })
        }
