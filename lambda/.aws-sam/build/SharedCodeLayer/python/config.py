"""Configuration management for Kalshi market capture application.

This module handles loading configuration from environment variables and
AWS Secrets Manager, with support for local development using .env files.
"""

import os
import json
from typing import Optional
from dataclasses import dataclass
from functools import lru_cache

import boto3
from botocore.exceptions import ClientError

# Optional import for local development
try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


@dataclass
class Config:
    """Application configuration.
    
    Attributes:
        kalshi_api_base_url: Base URL for Kalshi API
        kalshi_api_key_id: Kalshi API key ID
        kalshi_private_key: Kalshi RSA private key (PEM format)
        influxdb_url: InfluxDB connection URL
        influxdb_token: InfluxDB authentication token
        influxdb_org: InfluxDB organization name
        influxdb_bucket: InfluxDB bucket name
        aws_region: AWS region for Secrets Manager
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR)
        is_local: Whether running in local development mode
        rate_limiter_table_name: DynamoDB table name for centralized rate limiting (optional)
        kalshi_read_rate_limit: Read operations rate limit (requests/second)
        kalshi_post_rate_limit: POST operations rate limit (requests/second)
        series_metadata_table_name: DynamoDB table name for series metadata (optional)
        event_metadata_table_name: DynamoDB table name for event metadata (optional)
        market_metadata_table_name: DynamoDB table name for market metadata (optional)
        trades_table_name: DynamoDB table name for trade logs (optional)
        exit_liquidity_threshold: Minimum exit liquidity ratio (default: 0.5 = 50%)
        open_interest_limit_pct: Maximum trade size as % of open interest (default: 0.01 = 1%)
        default_fill_timeout: Default timeout for waiting for fills in seconds (default: 30.0)
    """
    
    kalshi_api_base_url: str
    kalshi_api_key_id: str
    kalshi_private_key: str
    influxdb_url: str
    influxdb_token: str
    influxdb_org: str
    influxdb_bucket: str
    aws_region: str = 'us-east-1'
    log_level: str = 'INFO'
    is_local: bool = False
    rate_limiter_table_name: Optional[str] = None
    kalshi_read_rate_limit: int = 20
    kalshi_post_rate_limit: int = 10
    series_metadata_table_name: Optional[str] = None
    event_metadata_table_name: Optional[str] = None
    market_metadata_table_name: Optional[str] = None
    trades_table_name: Optional[str] = None
    exit_liquidity_threshold: float = 0.5
    open_interest_limit_pct: float = 0.01
    default_fill_timeout: float = 30.0


class ConfigurationError(Exception):
    """Raised when configuration is invalid or cannot be loaded."""
    pass


class SecretsManager:
    """AWS Secrets Manager client wrapper for retrieving secrets.
    
    This class handles fetching secrets from AWS Secrets Manager with
    proper error handling and retries.
    """
    
    def __init__(self, region_name: str):
        """Initialize Secrets Manager client.
        
        Args:
            region_name: AWS region where secrets are stored
        """
        self.client = boto3.client('secretsmanager', region_name=region_name)
    
    def get_secret(self, secret_name: str) -> str:
        """Retrieve a secret value from AWS Secrets Manager.
        
        Args:
            secret_name: Name or ARN of the secret
            
        Returns:
            Secret string value
            
        Raises:
            ConfigurationError: If secret cannot be retrieved
        """
        try:
            response = self.client.get_secret_value(SecretId=secret_name)
            
            # Secrets can be stored as string or binary
            if 'SecretString' in response:
                return response['SecretString']
            else:
                # Binary secrets are base64 encoded
                import base64
                return base64.b64decode(response['SecretBinary']).decode('utf-8')
                
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'ResourceNotFoundException':
                raise ConfigurationError(
                    f"Secret '{secret_name}' not found in Secrets Manager"
                ) from e
            elif error_code == 'InvalidRequestException':
                raise ConfigurationError(
                    f"Invalid request for secret '{secret_name}'"
                ) from e
            elif error_code == 'InvalidParameterException':
                raise ConfigurationError(
                    f"Invalid parameter for secret '{secret_name}'"
                ) from e
            elif error_code in ['DecryptionFailure', 'InternalServiceError']:
                raise ConfigurationError(
                    f"Failed to decrypt or retrieve secret '{secret_name}': {error_code}"
                ) from e
            else:
                raise ConfigurationError(
                    f"Unexpected error retrieving secret '{secret_name}': {e}"
                ) from e
        except Exception as e:
            raise ConfigurationError(
                f"Failed to retrieve secret '{secret_name}': {e}"
            ) from e


def _get_env_var(name: str, required: bool = True, default: Optional[str] = None) -> Optional[str]:
    """Get environment variable with optional default and validation.
    
    Args:
        name: Environment variable name
        required: Whether the variable is required
        default: Default value if not set
        
    Returns:
        Environment variable value or default
        
    Raises:
        ConfigurationError: If required variable is not set
    """
    value = os.getenv(name, default)
    if required and not value:
        raise ConfigurationError(f"Required environment variable '{name}' is not set")
    return value


def _is_running_in_lambda() -> bool:
    """Check if code is running in AWS Lambda environment.
    
    Returns:
        True if running in Lambda, False otherwise
    """
    return bool(os.getenv('AWS_LAMBDA_FUNCTION_NAME'))


def load_configuration() -> Config:
    """Load application configuration from environment and Secrets Manager.
    
    Configuration priority:
    1. Direct environment variables (for local testing with values in .env)
    2. AWS Secrets Manager (for production Lambda)
    3. Defaults (where applicable)
    
    Local Development:
        Set KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY, and INFLUXDB_TOKEN
        directly in .env file to bypass Secrets Manager.
    
    Production (Lambda):
        Environment variables specify secret names, and actual values
        are fetched from AWS Secrets Manager.
    
    Returns:
        Config instance with all configuration loaded
        
    Raises:
        ConfigurationError: If required configuration is missing or invalid
    """
    # Load .env file if it exists (for local development)
    if load_dotenv is not None:
        load_dotenv()
    
    is_local = not _is_running_in_lambda()
    aws_region = _get_env_var('AWS_REGION', required=False, default='us-east-1')
    
    # Base configuration from environment
    kalshi_api_base_url = _get_env_var(
        'KALSHI_API_BASE_URL',
        required=False,
        default='https://api.elections.kalshi.com'
    )
    influxdb_url = _get_env_var('INFLUXDB_URL', required=False, default='')
    influxdb_org = _get_env_var('INFLUXDB_ORG', required=False, default='')
    influxdb_bucket = _get_env_var('INFLUXDB_BUCKET', required=False, default='')
    log_level = _get_env_var('LOG_LEVEL', required=False, default='INFO')
    
    # Load secrets - check for direct values first (local dev), then Secrets Manager
    kalshi_api_key_id: Optional[str] = None
    kalshi_private_key: Optional[str] = None
    influxdb_token: Optional[str] = None
    
    # Check for direct secret values (local development)
    kalshi_api_key_id = os.getenv('KALSHI_API_KEY_ID')
    kalshi_private_key = os.getenv('KALSHI_PRIVATE_KEY')
    influxdb_token = os.getenv('INFLUXDB_TOKEN')
    
    # If not found directly, fetch from Secrets Manager
    if not all([kalshi_api_key_id, kalshi_private_key, influxdb_token]):
        secrets_manager = SecretsManager(aws_region)
        
        # Get Kalshi API key ID from separate secret
        if not kalshi_api_key_id:
            kalshi_key_id_secret_name = _get_env_var(
                'KALSHI_API_KEY_ID_SECRET_NAME',
                required=False,
                default='production-kalshi-api-key-id'
            )
            
            try:
                kalshi_key_id_json = secrets_manager.get_secret(kalshi_key_id_secret_name)
                kalshi_key_id_secret = json.loads(kalshi_key_id_json)
                kalshi_api_key_id = kalshi_key_id_secret.get('api_key_id')
            except Exception as e:
                raise ConfigurationError(
                    f"Failed to load Kalshi API key ID from Secrets Manager: {e}"
                ) from e
        
        # Get Kalshi private key from separate secret
        if not kalshi_private_key:
            kalshi_private_key_secret_name = _get_env_var(
                'KALSHI_PRIVATE_KEY_SECRET_NAME',
                required=False,
                default='production-kalshi-private-key'
            )
            
            try:
                kalshi_private_key_json = secrets_manager.get_secret(kalshi_private_key_secret_name)
                # Try to parse as JSON first (for {"private_key": "..."} format)
                try:
                    kalshi_private_key_secret = json.loads(kalshi_private_key_json)
                    kalshi_private_key = kalshi_private_key_secret.get('private_key')
                except json.JSONDecodeError:
                    # If not JSON, treat the entire string as the private key
                    kalshi_private_key = kalshi_private_key_json
            except Exception as e:
                raise ConfigurationError(
                    f"Failed to load Kalshi private key from Secrets Manager: {e}"
                ) from e
        
        # Get InfluxDB token (optional - only needed for market capture)
        if not influxdb_token and influxdb_url:
            influxdb_secret_name = _get_env_var(
                'INFLUXDB_TOKEN_SECRET_NAME',
                required=False,
                default='production-influxdb-token'
            )
            
            try:
                influxdb_secret_json = secrets_manager.get_secret(influxdb_secret_name)
                influxdb_secret = json.loads(influxdb_secret_json)
                influxdb_token = influxdb_secret.get('token')
            except Exception as e:
                # Don't fail if InfluxDB token not found - trading lambda doesn't need it
                pass
    
    # Validate that we got required secrets
    if not kalshi_api_key_id:
        raise ConfigurationError("KALSHI_API_KEY_ID not found in environment or Secrets Manager")
    if not kalshi_private_key:
        raise ConfigurationError("KALSHI_PRIVATE_KEY not found in environment or Secrets Manager")
    # InfluxDB token is optional - only required for market capture lambda
    if not influxdb_token:
        influxdb_token = ''
    
    # Validate private key format (should be PEM)
    if not kalshi_private_key.strip().startswith('-----BEGIN'):
        raise ConfigurationError(
            "KALSHI_PRIVATE_KEY must be in PEM format (starting with '-----BEGIN')"
        )
    
    # Get DynamoDB rate limiter table name (optional)
    rate_limiter_table_name = os.getenv('RATE_LIMITER_TABLE_NAME')
    
    # Get rate limit values
    kalshi_read_rate_limit = int(os.getenv('KALSHI_RATE_LIMIT', '20'))
    kalshi_post_rate_limit = int(os.getenv('KALSHI_POST_RATE_LIMIT', '10'))
    
    # Get DynamoDB metadata table names (optional)
    series_metadata_table_name = os.getenv('SERIES_METADATA_TABLE_NAME')
    event_metadata_table_name = os.getenv('EVENT_METADATA_TABLE_NAME')
    market_metadata_table_name = os.getenv('MARKET_METADATA_TABLE_NAME')
    trades_table_name = os.getenv('TRADES_TABLE_NAME')
    
    # Get safety parameters
    exit_liquidity_threshold = float(os.getenv('EXIT_LIQUIDITY_THRESHOLD', '0.5'))
    open_interest_limit_pct = float(os.getenv('OPEN_INTEREST_LIMIT_PCT', '0.01'))
    default_fill_timeout = float(os.getenv('DEFAULT_FILL_TIMEOUT', '30.0'))
    
    return Config(
        kalshi_api_base_url=kalshi_api_base_url.rstrip('/'),
        kalshi_api_key_id=kalshi_api_key_id.strip(),
        kalshi_private_key=kalshi_private_key,
        influxdb_url=influxdb_url.rstrip('/'),
        influxdb_token=influxdb_token.strip(),
        influxdb_org=influxdb_org.strip(),
        influxdb_bucket=influxdb_bucket.strip(),
        aws_region=aws_region,
        log_level=log_level.upper(),
        is_local=is_local,
        rate_limiter_table_name=rate_limiter_table_name,
        kalshi_read_rate_limit=kalshi_read_rate_limit,
        kalshi_post_rate_limit=kalshi_post_rate_limit,
        series_metadata_table_name=series_metadata_table_name,
        event_metadata_table_name=event_metadata_table_name,
        market_metadata_table_name=market_metadata_table_name,
        trades_table_name=trades_table_name,
        exit_liquidity_threshold=exit_liquidity_threshold,
        open_interest_limit_pct=open_interest_limit_pct,
        default_fill_timeout=default_fill_timeout,
    )


@lru_cache(maxsize=1)
def get_config() -> Config:
    """Get cached configuration instance (singleton pattern).
    
    This function ensures configuration is loaded only once per Lambda
    execution context and reused across invocations.
    
    Returns:
        Config instance
        
    Raises:
        ConfigurationError: If configuration cannot be loaded
    """
    return load_configuration()
