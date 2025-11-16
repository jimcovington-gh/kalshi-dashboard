"""S3 Configuration Loader for Trading Ideas

Loads trading configuration from S3 bucket instead of bundled files.
Supports YAML format with automatic version selection.
"""

import os
import boto3
import yaml
from typing import Dict, List, Any, Optional
from utils import StructuredLogger

logger = StructuredLogger(__name__)

s3_client = boto3.client('s3')

CONFIG_BUCKET = os.environ.get('CONFIG_BUCKET_NAME', 'production-kalshi-trading-config')


def load_yaml_from_s3(key: str) -> Dict[str, Any]:
    """Load YAML file from S3 config bucket."""
    try:
        response = s3_client.get_object(Bucket=CONFIG_BUCKET, Key=key)
        content = response['Body'].read().decode('utf-8')
        data = yaml.safe_load(content)
        logger.debug("Loaded config from S3", bucket=CONFIG_BUCKET, key=key)
        return data
    except Exception as e:
        logger.error("Failed to load config from S3", bucket=CONFIG_BUCKET, key=key, error=str(e))
        raise


def load_idea_config(idea_id: str) -> Dict[str, Any]:
    """Load trading idea configuration from S3.
    
    Args:
        idea_id: Trading idea identifier (e.g., 'high-confidence')
    
    Returns:
        Dict with idea configuration including all versions
    """
    key = f'ideas/{idea_id}.yaml'
    return load_yaml_from_s3(key)


def get_latest_idea_version(idea_id: str) -> Dict[str, Any]:
    """Get the latest version of a trading idea.
    
    Args:
        idea_id: Trading idea identifier
    
    Returns:
        Dict with latest version parameters and metadata
    """
    config = load_idea_config(idea_id)
    latest_version = config.get('latest_version')
    
    if not latest_version:
        raise ValueError(f"No latest_version specified for idea: {idea_id}")
    
    # Find the version in versions list
    for version_data in config.get('versions', []):
        if version_data.get('version') == latest_version:
            return {
                'idea_id': idea_id,
                'version': latest_version,
                'description': version_data.get('description', ''),
                'parameters': version_data.get('parameters', {})
            }
    
    raise ValueError(f"Latest version {latest_version} not found in versions list for {idea_id}")


def load_user_assignments() -> Dict[str, Any]:
    """Load user idea assignments from S3.
    
    Returns:
        Dict with user assignments configuration
    """
    return load_yaml_from_s3('user_idea_assignments.yaml')


def load_lambda_registry() -> Dict[str, Any]:
    """Load Lambda function registry from S3.
    
    Returns:
        Dict with Lambda function mappings
    """
    return load_yaml_from_s3('lambda_registry.yaml')


def get_users_for_idea(idea_id: str) -> List[str]:
    """Get list of users assigned to a specific idea.
    
    Args:
        idea_id: Trading idea identifier
    
    Returns:
        List of usernames enabled for this idea
    """
    assignments = load_user_assignments()
    users = []
    
    for user_config in assignments.get('users', []):
        if not user_config.get('enabled', True):
            continue
            
        user_name = user_config.get('user_name')
        for idea in user_config.get('ideas', []):
            if idea.get('idea_id') == idea_id and idea.get('enabled', True):
                users.append(user_name)
                break
    
    return users


def get_all_enabled_users() -> List[str]:
    """Get list of all enabled users.
    
    Returns:
        List of all enabled usernames
    """
    assignments = load_user_assignments()
    return [u['user_name'] for u in assignments.get('users', []) if u.get('enabled', True)]
