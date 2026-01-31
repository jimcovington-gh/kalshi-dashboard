"""S3 Configuration Loader for Trading Ideas

Loads trading configuration from S3 bucket instead of bundled files.
Supports YAML format with automatic version selection.
"""

import os
import boto3
import yaml
import logging
from typing import Dict, List, Any, Optional

# Configure simple logger
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

s3_client = boto3.client('s3')

CONFIG_BUCKET = os.environ.get('CONFIG_BUCKET_NAME', 'production-kalshi-trading-config')


def load_yaml_from_s3(key: str) -> Dict[str, Any]:
    """Load YAML file from S3 config bucket."""
    try:
        response = s3_client.get_object(Bucket=CONFIG_BUCKET, Key=key)
        content = response['Body'].read().decode('utf-8')
        data = yaml.safe_load(content)
        logger.debug(f"Loaded config from S3: {CONFIG_BUCKET}/{key}")
        return data
    except Exception as e:
        logger.error(f"Failed to load config from S3: {CONFIG_BUCKET}/{key} - {e}")
        raise


def load_idea_config(idea_id: str) -> Dict[str, Any]:
    """Load trading idea configuration from S3.
    
    Args:
        idea_id: Trading idea identifier (e.g., 'hicon')
    
    Returns:
        Dict with idea configuration including all versions
    """
    key = f'ideas/{idea_id}.yaml'
    return load_yaml_from_s3(key)


def get_latest_idea_version(idea_id: str) -> Dict[str, Any]:
    """Get the latest version of a trading idea.
    
    Supports two YAML formats:
    - Old format: 'latest_version' at top, 'versions' list with version blocks
    - New format: 'version' at top, 'parameters' directly at top level (no versions list)
    
    Args:
        idea_id: Trading idea identifier
    
    Returns:
        Dict with latest version parameters and metadata
    """
    config = load_idea_config(idea_id)
    
    # Check for old format first (latest_version + versions list)
    latest_version = config.get('latest_version')
    if latest_version:
        # Old format: find version in versions list
        for version_data in config.get('versions', []):
            if version_data.get('version') == latest_version:
                return {
                    'idea_id': idea_id,
                    'version': latest_version,
                    'description': version_data.get('description', ''),
                    'parameters': version_data.get('parameters', {})
                }
        raise ValueError(f"Latest version {latest_version} not found in versions list for {idea_id}")
    
    # Check for new simplified format (version + top-level parameters)
    version = config.get('version')
    if version:
        return {
            'idea_id': idea_id,
            'version': version,
            'description': config.get('version_description', ''),
            'parameters': config.get('parameters', {})
        }
    
    raise ValueError(f"No 'latest_version' or 'version' specified for idea: {idea_id}")


def _discover_users_from_secrets() -> List[str]:
    """Discover users from Secrets Manager based on secret naming pattern.
    
    Looks for secrets matching 'production/kalshi/users/*/metadata' pattern.
    
    Returns:
        List of usernames discovered from Secrets Manager
    """
    secrets_client = boto3.client('secretsmanager')
    users = []
    
    try:
        paginator = secrets_client.get_paginator('list_secrets')
        for page in paginator.paginate(
            Filters=[{'Key': 'name', 'Values': ['production/kalshi/users/']}]
        ):
            for secret in page.get('SecretList', []):
                name = secret.get('Name', '')
                # Parse 'production/kalshi/users/jimc/metadata' -> 'jimc'
                if name.endswith('/metadata'):
                    parts = name.split('/')
                    if len(parts) >= 4:
                        username = parts[3]  # production/kalshi/users/<username>/metadata
                        # Skip UUIDs (like ad88f20e-dc9c-45d2-a0ec-e0782c3e23d8)
                        if not _is_uuid(username):
                            users.append(username)
        
        # Sort for consistent ordering across invocations (critical for round-robin rotation)
        users.sort()
        logger.debug(f"Discovered users from Secrets Manager: {users}")
        return users
    except Exception as e:
        logger.error(f"Failed to discover users from Secrets Manager: {e}")
        return []


def _is_uuid(s: str) -> bool:
    """Check if string looks like a UUID."""
    import re
    uuid_pattern = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$', re.IGNORECASE)
    return bool(uuid_pattern.match(s))


def load_user_assignments() -> Dict[str, Any]:
    """Build user assignments dynamically from Secrets Manager.
    
    Users are discovered from Secrets Manager (production/kalshi/users/*/metadata).
    For dashboard portfolio view, all discovered users are considered enabled.
    
    Returns:
        Dict with user assignments: {'users': [{'user_name': 'jimc', 'enabled': True}]}
    """
    users = _discover_users_from_secrets()
    
    result = {'users': []}
    for user_name in users:
        result['users'].append({
            'user_name': user_name,
            'enabled': True
        })
    
    logger.debug(f"Built user assignments dynamically: {[u['user_name'] for u in result['users']]}")
    return result


def load_lambda_registry() -> Dict[str, Any]:
    """Load Lambda function registry from S3.
    
    Returns:
        Dict with Lambda function mappings
    """
    return load_yaml_from_s3('lambda_registry.yaml')


def get_users_for_idea(idea_id: str) -> List[str]:
    """Get list of all users (dashboard doesn't filter by idea).
    
    Args:
        idea_id: Trading idea identifier (ignored for dashboard)
    
    Returns:
        List of all usernames from Secrets Manager
    """
    return _discover_users_from_secrets()


def get_all_enabled_users() -> List[str]:
    """Get list of all users from Secrets Manager.
    
    Returns:
        List of all usernames discovered from Secrets Manager
    """
    return _discover_users_from_secrets()
