"""
AI Chat Lambda - Streaming Claude responses with data access tools

Architecture:
- Uses Bedrock Claude Sonnet 4.5 with tool calling
- Streams responses back to client via Lambda Response Streaming
- Tools for: DynamoDB queries, S3 reads, Kalshi API, documentation
- Internal rate limiter: 10 requests/second
- User-scoped data access (non-admin sees only their data)

Security:
- Read-only IAM policies (enforced at AWS level)
- User authentication via Cognito
- Admin users can query all users' data
"""

import json
import boto3
import os
import time
import logging
from typing import Dict, List, Any, Optional, Generator
from decimal import Decimal
from datetime import datetime, timezone
from functools import wraps
import hashlib
import hmac
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend
import base64
import urllib.request
import urllib.parse

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# AWS clients
bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')
s3 = boto3.client('s3', region_name='us-east-1')
secretsmanager = boto3.client('secretsmanager', region_name='us-east-1')

# Configuration
MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250514-v1:0'
MAX_TOKENS = 8192
INTERNAL_RATE_LIMIT = 10  # requests per second
HIGH_CALL_WARNING_THRESHOLD = 50

# Table configurations
KALSHI_TABLES = [
    'production-kalshi-event-archive',
    'production-kalshi-event-metadata',
    'production-kalshi-market-metadata',
    'production-kalshi-mention-event-rotation',
    'production-kalshi-mention-event-state',
    'production-kalshi-mention-event-termination',
    'production-kalshi-mention-events',
    'production-kalshi-orderbook-snapshots',
    'production-kalshi-orders',
    'production-kalshi-portfolio-snapshots',
    'production-kalshi-positions-live',
    'production-kalshi-prohibited-events',
    'production-kalshi-quickbets-sessions',
    'production-kalshi-rate-limiter',
    'production-kalshi-rotation-state',
    'production-kalshi-series-metadata',
    'production-kalshi-traded-market-metadata',
    'production-kalshi-trades-v2',
    'production-kalshi-trading-shutdown-signals',
    'production-kalshi-voice-trader-queue',
    'production-kalshi-voice-trader-sessions',
    'production-kalshi-voice-trader-state',
    'production-kalshi-volatile-watchlist',
]

S3_BUCKETS = [
    'production-kalshi-trading-config',
    'production-kalshi-trading-captures',
]

KALSHI_API_BASE = 'https://api.elections.kalshi.com'


class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


class RateLimiter:
    """Simple in-memory rate limiter for internal API calls"""
    
    def __init__(self, requests_per_second: int = 10):
        self.requests_per_second = requests_per_second
        self.tokens = requests_per_second
        self.last_refill = time.time()
    
    def acquire(self, count: int = 1) -> bool:
        """Try to acquire tokens. Returns True if successful."""
        now = time.time()
        # Refill tokens based on time elapsed
        elapsed = now - self.last_refill
        self.tokens = min(self.requests_per_second, self.tokens + elapsed * self.requests_per_second)
        self.last_refill = now
        
        if self.tokens >= count:
            self.tokens -= count
            return True
        return False
    
    def wait_and_acquire(self, count: int = 1) -> None:
        """Wait until tokens are available, then acquire."""
        while not self.acquire(count):
            time.sleep(0.1)


# Global rate limiter instance
rate_limiter = RateLimiter(INTERNAL_RATE_LIMIT)


def get_kalshi_credentials(user_name: str) -> tuple[str, str]:
    """Get Kalshi API credentials for a user from Secrets Manager."""
    try:
        # Get API key ID from metadata secret
        metadata_response = secretsmanager.get_secret_value(
            SecretId=f'production/kalshi/users/{user_name}/metadata'
        )
        metadata = json.loads(metadata_response['SecretString'])
        api_key_id = metadata.get('api_key_id')
        
        # Get private key
        key_response = secretsmanager.get_secret_value(
            SecretId=f'production/kalshi/users/{user_name}/private-key'
        )
        private_key = key_response['SecretString']
        
        return api_key_id, private_key
    except Exception as e:
        logger.error(f"Failed to get Kalshi credentials for {user_name}: {e}")
        raise


def sign_kalshi_request(api_key_id: str, private_key_pem: str, method: str, path: str, timestamp: int) -> str:
    """Sign a Kalshi API request using RSA-PSS."""
    message = f'{timestamp}{method}{path}'.encode('utf-8')
    
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode('utf-8'),
        password=None,
        backend=default_backend()
    )
    
    signature = private_key.sign(
        message,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.MAX_LENGTH
        ),
        hashes.SHA256()
    )
    
    return base64.b64encode(signature).decode('utf-8')


def call_kalshi_api(user_name: str, method: str, endpoint: str, params: Optional[Dict] = None) -> Dict:
    """Make an authenticated call to Kalshi API."""
    rate_limiter.wait_and_acquire()
    
    api_key_id, private_key = get_kalshi_credentials(user_name)
    
    # Build URL
    path = endpoint
    if params:
        query_string = urllib.parse.urlencode(params)
        url = f'{KALSHI_API_BASE}{endpoint}?{query_string}'
    else:
        url = f'{KALSHI_API_BASE}{endpoint}'
    
    # Sign request (use path without query params)
    timestamp = int(time.time() * 1000)
    signature = sign_kalshi_request(api_key_id, private_key, method, path, timestamp)
    
    headers = {
        'KALSHI-ACCESS-KEY': api_key_id,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': str(timestamp),
        'Content-Type': 'application/json',
    }
    
    request = urllib.request.Request(url, method=method, headers=headers)
    
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8') if e.fp else str(e)
        logger.error(f"Kalshi API error: {e.code} - {error_body}")
        raise Exception(f"Kalshi API error {e.code}: {error_body}")


# ============================================================================
# Tool Definitions for Claude
# ============================================================================

TOOLS = [
    {
        "name": "query_dynamodb_table",
        "description": """Query a DynamoDB table. Available tables:
- production-kalshi-trades-v2: Trade history (keys: user_name, placed_at)
- production-kalshi-positions-live: Current positions (keys: user_name, market_ticker)
- production-kalshi-orders: Order history (keys: user_name, order_id)
- production-kalshi-market-metadata: Market info (key: market_ticker)
- production-kalshi-mention-events: Mention event config (key: event_ticker)
- production-kalshi-mention-event-state: Event state (key: event_ticker)
- production-kalshi-portfolio-snapshots: Portfolio history (keys: user_name, timestamp)
- production-kalshi-volatile-watchlist: Volatility tracking
Use scan for broad queries, get_item for specific items, query for indexed lookups.""",
        "input_schema": {
            "type": "object",
            "properties": {
                "table_name": {
                    "type": "string",
                    "description": "The DynamoDB table name (must be a production-kalshi-* table)"
                },
                "operation": {
                    "type": "string",
                    "enum": ["scan", "get_item", "query"],
                    "description": "The operation type"
                },
                "key": {
                    "type": "object",
                    "description": "For get_item: the primary key. E.g., {'user_name': 'jimc', 'market_ticker': 'TICKER'}"
                },
                "filter_expression": {
                    "type": "string",
                    "description": "For scan: filter expression. E.g., 'user_name = :u'"
                },
                "key_condition_expression": {
                    "type": "string",
                    "description": "For query: key condition. E.g., 'user_name = :u'"
                },
                "expression_attribute_values": {
                    "type": "object",
                    "description": "Attribute values for expressions. E.g., {':u': 'jimc'}"
                },
                "index_name": {
                    "type": "string",
                    "description": "GSI name for query operations"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum items to return (default 100, max 1000)"
                }
            },
            "required": ["table_name", "operation"]
        }
    },
    {
        "name": "read_s3_file",
        "description": """Read a file from S3. Available buckets:
- production-kalshi-trading-config: Trading configuration (ideas/, etc.)
- production-kalshi-trading-captures: Recorded game/event data
Returns file content as text (for JSON/YAML) or metadata (for binary).""",
        "input_schema": {
            "type": "object",
            "properties": {
                "bucket": {
                    "type": "string",
                    "description": "S3 bucket name"
                },
                "key": {
                    "type": "string",
                    "description": "S3 object key (file path)"
                }
            },
            "required": ["bucket", "key"]
        }
    },
    {
        "name": "list_s3_objects",
        "description": "List objects in an S3 bucket/prefix",
        "input_schema": {
            "type": "object",
            "properties": {
                "bucket": {
                    "type": "string",
                    "description": "S3 bucket name"
                },
                "prefix": {
                    "type": "string",
                    "description": "S3 key prefix to filter objects"
                },
                "max_keys": {
                    "type": "integer",
                    "description": "Maximum objects to return (default 100)"
                }
            },
            "required": ["bucket"]
        }
    },
    {
        "name": "kalshi_get_portfolio",
        "description": "Get current portfolio (balance and positions) from Kalshi API for a user",
        "input_schema": {
            "type": "object",
            "properties": {
                "user_name": {
                    "type": "string",
                    "description": "Kalshi username to get portfolio for"
                }
            },
            "required": ["user_name"]
        }
    },
    {
        "name": "kalshi_get_market",
        "description": "Get details about a specific market from Kalshi API",
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {
                    "type": "string",
                    "description": "Market ticker (e.g., 'KXBTC-25JAN31-B60000')"
                },
                "user_name": {
                    "type": "string",
                    "description": "User for authentication"
                }
            },
            "required": ["ticker", "user_name"]
        }
    },
    {
        "name": "kalshi_get_orderbook",
        "description": "Get current orderbook for a market from Kalshi API",
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {
                    "type": "string",
                    "description": "Market ticker"
                },
                "user_name": {
                    "type": "string",
                    "description": "User for authentication"
                }
            },
            "required": ["ticker", "user_name"]
        }
    },
    {
        "name": "kalshi_get_fills",
        "description": "Get recent fills (executed trades) from Kalshi API",
        "input_schema": {
            "type": "object",
            "properties": {
                "user_name": {
                    "type": "string",
                    "description": "User to get fills for"
                },
                "ticker": {
                    "type": "string",
                    "description": "Optional: filter by market ticker"
                },
                "limit": {
                    "type": "integer",
                    "description": "Max fills to return (default 100)"
                }
            },
            "required": ["user_name"]
        }
    },
    {
        "name": "read_documentation",
        "description": """Read project documentation files. Available docs:
- PROJECT_SUMMARY.md: Complete system overview, architecture, deployment
- QUICK_REFERENCE.md: Quick commands, deployment steps, common tasks
- AGENTS.md: Critical deployment rules and gotchas
- TIS_ARCHITECTURE.md: Trading Infrastructure Service design
- QUICKBETS_IMPLEMENTATION.md: QuickBets system design
- EC2_VOICE_TRADER.md: Voice trader deployment and operation
Use this to understand how the system works.""",
        "input_schema": {
            "type": "object",
            "properties": {
                "doc_name": {
                    "type": "string",
                    "description": "Documentation filename (e.g., 'PROJECT_SUMMARY.md')"
                }
            },
            "required": ["doc_name"]
        }
    },
    {
        "name": "estimate_query_cost",
        "description": "Estimate how many API calls a complex query will require. Use before expensive operations.",
        "input_schema": {
            "type": "object",
            "properties": {
                "operation_type": {
                    "type": "string",
                    "enum": ["dynamodb_scan", "dynamodb_query", "kalshi_api", "s3_list"],
                    "description": "Type of operation"
                },
                "estimated_items": {
                    "type": "integer",
                    "description": "Estimated number of items/calls"
                }
            },
            "required": ["operation_type", "estimated_items"]
        }
    }
]


# ============================================================================
# Tool Implementations
# ============================================================================

def execute_tool(tool_name: str, tool_input: Dict, user_name: str, is_admin: bool) -> Dict:
    """Execute a tool and return the result."""
    try:
        if tool_name == "query_dynamodb_table":
            return tool_query_dynamodb(tool_input, user_name, is_admin)
        elif tool_name == "read_s3_file":
            return tool_read_s3(tool_input)
        elif tool_name == "list_s3_objects":
            return tool_list_s3(tool_input)
        elif tool_name == "kalshi_get_portfolio":
            return tool_kalshi_portfolio(tool_input, user_name, is_admin)
        elif tool_name == "kalshi_get_market":
            return tool_kalshi_market(tool_input, user_name, is_admin)
        elif tool_name == "kalshi_get_orderbook":
            return tool_kalshi_orderbook(tool_input, user_name, is_admin)
        elif tool_name == "kalshi_get_fills":
            return tool_kalshi_fills(tool_input, user_name, is_admin)
        elif tool_name == "read_documentation":
            return tool_read_docs(tool_input)
        elif tool_name == "estimate_query_cost":
            return tool_estimate_cost(tool_input)
        else:
            return {"error": f"Unknown tool: {tool_name}"}
    except Exception as e:
        logger.error(f"Tool execution error: {tool_name} - {e}")
        return {"error": str(e)}


def tool_query_dynamodb(params: Dict, user_name: str, is_admin: bool) -> Dict:
    """Query DynamoDB table with user scoping."""
    table_name = params.get('table_name', '')
    operation = params.get('operation', 'scan')
    limit = min(params.get('limit', 100), 1000)
    
    # Validate table
    if table_name not in KALSHI_TABLES:
        return {"error": f"Table not allowed: {table_name}. Allowed tables: {', '.join(KALSHI_TABLES)}"}
    
    table = dynamodb.Table(table_name)
    rate_limiter.wait_and_acquire()
    
    # User scoping for non-admin
    expression_values = params.get('expression_attribute_values', {})
    filter_expr = params.get('filter_expression', '')
    key_condition = params.get('key_condition_expression', '')
    
    # Add user filter for tables with user_name
    user_scoped_tables = [
        'production-kalshi-trades-v2',
        'production-kalshi-positions-live',
        'production-kalshi-orders',
        'production-kalshi-portfolio-snapshots',
    ]
    
    if not is_admin and table_name in user_scoped_tables:
        if ':user_filter' not in expression_values:
            expression_values[':user_filter'] = user_name
            if filter_expr:
                filter_expr = f"({filter_expr}) AND user_name = :user_filter"
            else:
                filter_expr = "user_name = :user_filter"
    
    try:
        if operation == 'get_item':
            key = params.get('key', {})
            response = table.get_item(Key=key)
            item = response.get('Item')
            return {"item": json.loads(json.dumps(item, cls=DecimalEncoder)) if item else None}
        
        elif operation == 'query':
            kwargs = {
                'Limit': limit,
            }
            if key_condition:
                kwargs['KeyConditionExpression'] = key_condition
            if expression_values:
                kwargs['ExpressionAttributeValues'] = expression_values
            if params.get('index_name'):
                kwargs['IndexName'] = params['index_name']
            if filter_expr:
                kwargs['FilterExpression'] = filter_expr
            
            response = table.query(**kwargs)
            items = response.get('Items', [])
            return {
                "items": json.loads(json.dumps(items, cls=DecimalEncoder)),
                "count": len(items),
                "scanned_count": response.get('ScannedCount', len(items))
            }
        
        else:  # scan
            kwargs = {'Limit': limit}
            if filter_expr:
                kwargs['FilterExpression'] = filter_expr
            if expression_values:
                kwargs['ExpressionAttributeValues'] = expression_values
            
            response = table.scan(**kwargs)
            items = response.get('Items', [])
            return {
                "items": json.loads(json.dumps(items, cls=DecimalEncoder)),
                "count": len(items),
                "scanned_count": response.get('ScannedCount', len(items))
            }
    
    except Exception as e:
        return {"error": f"DynamoDB error: {str(e)}"}


def tool_read_s3(params: Dict) -> Dict:
    """Read file from S3."""
    bucket = params.get('bucket', '')
    key = params.get('key', '')
    
    if bucket not in S3_BUCKETS:
        return {"error": f"Bucket not allowed: {bucket}"}
    
    rate_limiter.wait_and_acquire()
    
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
        content_type = response.get('ContentType', 'application/octet-stream')
        
        # For text files, return content
        if 'text' in content_type or 'json' in content_type or 'yaml' in content_type or key.endswith(('.json', '.yaml', '.yml', '.txt', '.md')):
            content = response['Body'].read().decode('utf-8')
            # Truncate very large files
            if len(content) > 50000:
                content = content[:50000] + "\n\n... [truncated, file too large]"
            return {"content": content, "content_type": content_type, "size": response['ContentLength']}
        else:
            return {
                "message": "Binary file - showing metadata only",
                "content_type": content_type,
                "size": response['ContentLength'],
                "last_modified": str(response['LastModified'])
            }
    except Exception as e:
        return {"error": f"S3 error: {str(e)}"}


def tool_list_s3(params: Dict) -> Dict:
    """List S3 objects."""
    bucket = params.get('bucket', '')
    prefix = params.get('prefix', '')
    max_keys = min(params.get('max_keys', 100), 1000)
    
    if bucket not in S3_BUCKETS:
        return {"error": f"Bucket not allowed: {bucket}"}
    
    rate_limiter.wait_and_acquire()
    
    try:
        response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=max_keys)
        objects = []
        for obj in response.get('Contents', []):
            objects.append({
                'key': obj['Key'],
                'size': obj['Size'],
                'last_modified': str(obj['LastModified'])
            })
        return {"objects": objects, "count": len(objects), "truncated": response.get('IsTruncated', False)}
    except Exception as e:
        return {"error": f"S3 error: {str(e)}"}


def tool_kalshi_portfolio(params: Dict, user_name: str, is_admin: bool) -> Dict:
    """Get Kalshi portfolio."""
    target_user = params.get('user_name', user_name)
    
    # Non-admin can only query their own data
    if not is_admin and target_user != user_name:
        return {"error": f"Access denied: you can only query your own portfolio"}
    
    try:
        # Get balance
        balance_response = call_kalshi_api(target_user, 'GET', '/trade-api/v2/portfolio/balance')
        
        # Get positions
        positions_response = call_kalshi_api(target_user, 'GET', '/trade-api/v2/portfolio/positions')
        
        return {
            "user": target_user,
            "balance": balance_response.get('balance', {}),
            "positions": positions_response.get('market_positions', [])
        }
    except Exception as e:
        return {"error": f"Kalshi API error: {str(e)}"}


def tool_kalshi_market(params: Dict, user_name: str, is_admin: bool) -> Dict:
    """Get market details from Kalshi."""
    ticker = params.get('ticker', '')
    auth_user = params.get('user_name', user_name)
    
    # Non-admin must use their own credentials
    if not is_admin and auth_user != user_name:
        auth_user = user_name
    
    try:
        response = call_kalshi_api(auth_user, 'GET', f'/trade-api/v2/markets/{ticker}')
        return response
    except Exception as e:
        return {"error": f"Kalshi API error: {str(e)}"}


def tool_kalshi_orderbook(params: Dict, user_name: str, is_admin: bool) -> Dict:
    """Get orderbook from Kalshi."""
    ticker = params.get('ticker', '')
    auth_user = params.get('user_name', user_name)
    
    if not is_admin and auth_user != user_name:
        auth_user = user_name
    
    try:
        response = call_kalshi_api(auth_user, 'GET', f'/trade-api/v2/markets/{ticker}/orderbook')
        return response
    except Exception as e:
        return {"error": f"Kalshi API error: {str(e)}"}


def tool_kalshi_fills(params: Dict, user_name: str, is_admin: bool) -> Dict:
    """Get fills from Kalshi."""
    target_user = params.get('user_name', user_name)
    
    if not is_admin and target_user != user_name:
        return {"error": f"Access denied: you can only query your own fills"}
    
    try:
        api_params = {'limit': min(params.get('limit', 100), 500)}
        if params.get('ticker'):
            api_params['ticker'] = params['ticker']
        
        response = call_kalshi_api(target_user, 'GET', '/trade-api/v2/portfolio/fills', api_params)
        return {"fills": response.get('fills', []), "cursor": response.get('cursor')}
    except Exception as e:
        return {"error": f"Kalshi API error: {str(e)}"}


def tool_read_docs(params: Dict) -> Dict:
    """Read documentation files from S3."""
    doc_name = params.get('doc_name', '')
    
    # Map of allowed docs (stored in S3)
    allowed_docs = [
        'PROJECT_SUMMARY.md',
        'QUICK_REFERENCE.md',
        'AGENTS.md',
        'TIS_ARCHITECTURE.md',
        'QUICKBETS_IMPLEMENTATION.md',
        'EC2_VOICE_TRADER.md',
    ]
    
    if doc_name not in allowed_docs:
        return {"error": f"Unknown document: {doc_name}. Available: {', '.join(allowed_docs)}"}
    
    rate_limiter.wait_and_acquire()
    
    try:
        # Read from S3
        response = s3.get_object(
            Bucket='production-kalshi-trading-config',
            Key=f'docs/{doc_name}'
        )
        content = response['Body'].read().decode('utf-8')
        
        # Truncate very large files
        if len(content) > 50000:
            content = content[:50000] + "\n\n... [truncated, file too large]"
        
        return {"content": content, "doc_name": doc_name}
    except s3.exceptions.NoSuchKey:
        return {"error": f"Document not found in S3: {doc_name}. Run sync-ai-docs.sh to upload."}
    except Exception as e:
        return {"error": f"Error reading document from S3: {str(e)}"}


def tool_estimate_cost(params: Dict) -> Dict:
    """Estimate query cost."""
    op_type = params.get('operation_type', '')
    estimated_items = params.get('estimated_items', 0)
    
    costs = {
        'dynamodb_scan': 1,  # 1 call per scan
        'dynamodb_query': 1,  # 1 call per query (paginated would be more)
        'kalshi_api': 1,  # 1 call per API request
        's3_list': 1,  # 1 call per list
    }
    
    base_cost = costs.get(op_type, 1)
    total_calls = base_cost * max(1, estimated_items // 100)  # Rough pagination estimate
    
    warning = None
    if total_calls > HIGH_CALL_WARNING_THRESHOLD:
        warning = f"⚠️ This operation may require ~{total_calls} API calls. Consider adding filters to reduce scope."
    
    return {
        "estimated_calls": total_calls,
        "warning": warning,
        "proceed": total_calls <= HIGH_CALL_WARNING_THRESHOLD
    }


# ============================================================================
# System Prompt
# ============================================================================

def build_system_prompt(user_name: str, is_admin: bool) -> str:
    """Build the system prompt with context."""
    
    admin_note = "You have ADMIN access - you can query data for any user." if is_admin else f"You are querying as user '{user_name}' - you can only access your own data."
    
    return f"""You are an AI assistant for the Kalshi Trading Dashboard. You help users understand their trading data, positions, and the system architecture.

{admin_note}

## Your Capabilities

1. **Query DynamoDB tables** - Trading data, positions, orders, market metadata
2. **Read S3 files** - Trading configurations, captured game data
3. **Call Kalshi API** - Live portfolio, market data, orderbooks (rate-limited to 10/sec)
4. **Read documentation** - System architecture and deployment docs

## Key Data Locations

### DynamoDB Tables
- `production-kalshi-trades-v2`: All executed trades (user_name, market_ticker, placed_at, filled_count, avg_fill_price)
- `production-kalshi-positions-live`: Current open positions (user_name, market_ticker, position, resting_orders)
- `production-kalshi-orders`: Order history (user_name, order_id, status)
- `production-kalshi-market-metadata`: Market info (ticker, title, event_ticker, close_time)
- `production-kalshi-mention-events`: Mention market configurations
- `production-kalshi-mention-event-state`: Current state of mention events

### S3 Buckets
- `production-kalshi-trading-config`: Trading idea configs (ideas/high-confidence.yaml)
- `production-kalshi-trading-captures`: Recorded game/event audio and data

## Guidelines

1. **Be concise** - Don't overwhelm with data. Summarize and highlight key points.
2. **Use tables** - Format data nicely when showing multiple items.
3. **Warn about costs** - Use estimate_query_cost before operations that might be expensive.
4. **Explain data** - Help users understand what the data means, not just show raw values.
5. **Stay read-only** - You cannot modify any data. If asked to trade or change settings, explain you can only read.

## Common Queries

- Portfolio value: Use kalshi_get_portfolio
- Recent trades: Query production-kalshi-trades-v2 with user filter
- Position details: Query production-kalshi-positions-live
- Market info: Query production-kalshi-market-metadata or use kalshi_get_market
- System docs: Use read_documentation for PROJECT_SUMMARY.md or QUICK_REFERENCE.md

Current timestamp: {datetime.now(timezone.utc).isoformat()}
"""


# ============================================================================
# Main Handler
# ============================================================================

def lambda_handler(event, context):
    """
    Main Lambda handler for AI chat.
    
    Expects:
    - body.messages: List of {role, content} messages
    - requestContext.authorizer.claims: Cognito user info
    
    Returns:
    - Streaming response with AI output
    """
    logger.info(f"AI Chat request received")
    
    try:
        # Parse request
        body = json.loads(event.get('body', '{}'))
        messages = body.get('messages', [])
        
        # Handle case where messages is a JSON string (from Amplify API)
        if isinstance(messages, str):
            messages = json.loads(messages)
        
        if not messages:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'No messages provided'})
            }
        
        # Get user from Cognito claims
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        user_name = claims.get('cognito:username', claims.get('preferred_username', 'unknown'))
        groups_str = claims.get('cognito:groups', '')
        is_admin = 'admin' in groups_str.lower() if groups_str else False
        
        logger.info(f"User: {user_name}, Admin: {is_admin}")
        
        # Build conversation for Bedrock
        system_prompt = build_system_prompt(user_name, is_admin)
        
        # Format messages for Claude
        claude_messages = []
        for msg in messages:
            role = msg.get('role', 'user')
            content = msg.get('content', '')
            if role in ['user', 'assistant']:
                claude_messages.append({'role': role, 'content': content})
        
        # Call Bedrock with tool support
        response = call_bedrock_with_tools(
            system_prompt=system_prompt,
            messages=claude_messages,
            user_name=user_name,
            is_admin=is_admin
        )
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            },
            'body': json.dumps({
                'response': response,
                'user': user_name,
                'is_admin': is_admin
            })
        }
        
    except Exception as e:
        logger.error(f"Error in AI chat handler: {e}", exc_info=True)
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }


def call_bedrock_with_tools(system_prompt: str, messages: List[Dict], user_name: str, is_admin: bool, max_iterations: int = 10) -> str:
    """
    Call Bedrock Claude with tool support, handling tool use loops.
    
    Returns the final text response after all tool calls are complete.
    """
    current_messages = messages.copy()
    
    for iteration in range(max_iterations):
        logger.info(f"Bedrock call iteration {iteration + 1}")
        
        # Call Bedrock
        response = bedrock.converse(
            modelId=MODEL_ID,
            system=[{'text': system_prompt}],
            messages=current_messages,
            toolConfig={'tools': [{'toolSpec': t} for t in TOOLS]},
            inferenceConfig={
                'maxTokens': MAX_TOKENS,
                'temperature': 0.3,
            }
        )
        
        # Check stop reason
        stop_reason = response.get('stopReason', 'end_turn')
        output = response.get('output', {})
        message = output.get('message', {})
        content_blocks = message.get('content', [])
        
        logger.info(f"Stop reason: {stop_reason}, Content blocks: {len(content_blocks)}")
        
        # If no tool use, extract text and return
        if stop_reason != 'tool_use':
            text_parts = []
            for block in content_blocks:
                if 'text' in block:
                    text_parts.append(block['text'])
            return '\n'.join(text_parts)
        
        # Handle tool use
        tool_results = []
        for block in content_blocks:
            if 'toolUse' in block:
                tool_use = block['toolUse']
                tool_id = tool_use['toolUseId']
                tool_name = tool_use['name']
                tool_input = tool_use.get('input', {})
                
                logger.info(f"Executing tool: {tool_name}")
                
                # Execute the tool
                result = execute_tool(tool_name, tool_input, user_name, is_admin)
                
                tool_results.append({
                    'toolResult': {
                        'toolUseId': tool_id,
                        'content': [{'json': result}]
                    }
                })
        
        # Add assistant message and tool results to conversation
        current_messages.append(message)
        current_messages.append({'role': 'user', 'content': tool_results})
    
    return "Max iterations reached. The query may be too complex."
