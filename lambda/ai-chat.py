"""
AI Chat Lambda - Streaming Claude responses with data access tools

Architecture:
- Uses Bedrock Claude Sonnet 4.5 with tool calling
- Streams responses back to client via Lambda Response Streaming
- Tools for: DynamoDB queries, S3 reads, Kalshi API, documentation
- Internal rate limiter: 10 requests/second
- User-scoped data access (non-admin sees only their data)
- Conversations stored in localStorage (client) + optional S3 save

Security:
- Read-only IAM policies (enforced at AWS level)
- User authentication via Cognito IAM credentials (Function URL)
- Admin users can query all users' data

Endpoints:
- Function URL (primary): Streaming, 15 min timeout, IAM auth
- API Gateway (legacy): Non-streaming, 29s timeout, Cognito auth
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
logs_client = boto3.client('logs', region_name='us-east-1')

# Configuration
# Claude Opus 4.6 via cross-region inference profile (1M context window)
MODEL_ID = 'us.anthropic.claude-opus-4-6-v1'
MAX_TOKENS = 64000  # Claude Opus 4.6 supports up to 64K output tokens
MAX_INPUT_TOKENS = 950000  # Claude Opus 4.6 supports 1M context (preview), leave room for output
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


def estimate_tokens(text: str) -> int:
    """Rough estimate of tokens (Claude uses ~4 chars per token on average)."""
    return len(text) // 4


def estimate_messages_tokens(messages: List[Dict]) -> int:
    """Estimate total tokens in a list of messages."""
    total = 0
    for msg in messages:
        content = msg.get('content', [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and 'text' in block:
                    total += estimate_tokens(block['text'])
        elif isinstance(content, str):
            total += estimate_tokens(content)
    return total


def truncate_conversation(messages: List[Dict], max_tokens: int = MAX_INPUT_TOKENS) -> List[Dict]:
    """
    Truncate conversation history to fit within token limit.
    Keeps the first message (for context) and as many recent messages as possible.
    """
    if not messages:
        return messages
    
    total_tokens = estimate_messages_tokens(messages)
    
    if total_tokens <= max_tokens:
        return messages
    
    logger.info(f"Truncating conversation: {total_tokens} estimated tokens -> {max_tokens} limit")
    
    # Always keep first and last message
    if len(messages) <= 2:
        return messages
    
    # Keep first message, then add messages from the end until we hit limit
    first_msg = messages[0]
    first_tokens = estimate_messages_tokens([first_msg])
    
    # Add messages from the end
    kept_messages = []
    running_total = first_tokens
    
    for msg in reversed(messages[1:]):
        msg_tokens = estimate_messages_tokens([msg])
        if running_total + msg_tokens <= max_tokens:
            kept_messages.insert(0, msg)
            running_total += msg_tokens
        else:
            break
    
    # If we had to drop messages, add a system note
    dropped_count = len(messages) - 1 - len(kept_messages)
    if dropped_count > 0:
        truncation_note = {
            'role': 'assistant',
            'content': [{'text': f'[Note: {dropped_count} earlier messages were truncated to fit context window. The conversation continues below.]'}]
        }
        result = [first_msg, truncation_note] + kept_messages
    else:
        result = [first_msg] + kept_messages
    
    logger.info(f"Kept {len(result)} messages, dropped {dropped_count}")
    return result


class DecimalEncoder(json.JSONEncoder):
    """Convert Decimal to float for JSON serialization"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


# Maximum characters for a single tool result to prevent context overflow
MAX_TOOL_RESULT_CHARS = 100000

def truncate_tool_result(result: Dict) -> Dict:
    """
    Truncate tool results that are too large to prevent context overflow.
    For list results, keeps complete items until limit is reached.
    """
    result_str = json.dumps(result, cls=DecimalEncoder)
    if len(result_str) <= MAX_TOOL_RESULT_CHARS:
        return result
    
    logger.warning(f"Tool result too large ({len(result_str)} chars), truncating to {MAX_TOOL_RESULT_CHARS}")
    
    # If result has 'items' list, truncate by removing items from the end
    if 'items' in result and isinstance(result['items'], list):
        items = result['items']
        truncated_items = []
        current_size = len(json.dumps({**result, 'items': []}, cls=DecimalEncoder))
        
        for item in items:
            item_str = json.dumps(item, cls=DecimalEncoder)
            if current_size + len(item_str) + 2 < MAX_TOOL_RESULT_CHARS:  # +2 for comma and bracket
                truncated_items.append(item)
                current_size += len(item_str) + 2
            else:
                break
        
        result = {
            **result,
            'items': truncated_items,
            'count': len(truncated_items),
            'truncated': True,
            'truncated_message': f'Result truncated from {len(items)} to {len(truncated_items)} items due to size limits'
        }
        return result
    
    # For other results, just truncate the string representation
    truncated_str = result_str[:MAX_TOOL_RESULT_CHARS]
    return {
        'truncated_result': truncated_str,
        'truncated': True,
        'original_size': len(result_str),
        'truncated_message': 'Result truncated due to size limits'
    }


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
        "description": """Query a DynamoDB table. 

⚠️ EFFICIENCY RULES:
- Use limit=10-25 for initial queries (can request more if needed)
- Use 'query' with index_name + key_condition_expression for large tables
- trades-v2 records are ~6KB each due to orderbook_snapshot field!

TABLE SCHEMAS (use correct keys!):

production-kalshi-trades-v2:
  - Primary key: order_id (HASH only)
  - GSI 'user_name-placed_at-index': user_name (HASH), placed_at (RANGE) ← USE THIS FOR USER TRADES
  - GSI 'user_name-index': user_name (HASH)
  - GSI 'market_ticker-index': market_ticker (HASH)
  - ⚠️ Each record ~6KB due to orderbook_snapshot field

production-kalshi-positions-live:
  - Primary key: user_name (HASH), market_ticker (RANGE)
  - Small records, safe to query with higher limits

production-kalshi-orders:
  - Primary key: order_id (HASH only)
  - GSI 'user_name-placed_at-index': user_name (HASH), placed_at (RANGE) ← USE THIS
  - GSI 'user_name-index': user_name (HASH)

production-kalshi-market-metadata:
  - Primary key: market_ticker (HASH)
  - GSI 'event_ticker-index': event_ticker (HASH)
  - GSI 'status-index': status (HASH)

production-kalshi-portfolio-snapshots:
  - Primary key: api_key_id (HASH), snapshot_ts (RANGE)

QUERY EXAMPLE for user trades:
  operation='query', table='production-kalshi-trades-v2', 
  index_name='user_name-placed_at-index',
  key_condition_expression='user_name = :u',
  expression_attribute_values={':u': 'jimc'}, 
  limit=25, scan_index_forward=false (newest first)""",
        "inputSchema": {
            "type": "object",
            "properties": {
                "table_name": {
                    "type": "string",
                    "description": "The DynamoDB table name (must be a production-kalshi-* table)"
                },
                "operation": {
                    "type": "string",
                    "enum": ["scan", "get_item", "query"],
                    "description": "The operation type. Use 'query' with index_name for user-scoped tables!"
                },
                "key": {
                    "type": "object",
                    "description": "For get_item: the primary key. E.g., {'order_id': 'abc-123'}"
                },
                "filter_expression": {
                    "type": "string",
                    "description": "Filter expression (applied AFTER scan/query). E.g., 'status = :s'"
                },
                "key_condition_expression": {
                    "type": "string",
                    "description": "For query: key condition. E.g., 'user_name = :u' - REQUIRED for query operation"
                },
                "expression_attribute_values": {
                    "type": "object",
                    "description": "Attribute values for expressions. E.g., {':u': 'jimc'}"
                },
                "index_name": {
                    "type": "string",
                    "description": "GSI name - REQUIRED for querying trades-v2 or orders by user_name! Use 'user_name-placed_at-index'"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum items to return. Use 10-25 for trades (6KB each!). Max 1000."
                },
                "scan_index_forward": {
                    "type": "boolean",
                    "description": "Sort order for query. false=descending (newest first), true=ascending (oldest first). Default true."
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
        "inputSchema": {
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
        "inputSchema": {
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
        "inputSchema": {
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
        "inputSchema": {
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
        "inputSchema": {
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
        "inputSchema": {
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
        "inputSchema": {
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
        "inputSchema": {
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
    },
    {
        "name": "search_execution_logs",
        "description": """Search CloudWatch execution logs for trade decisions and market activity.

Use this tool to understand WHY a trade was made or to trace the decision path for a specific market.

LOG GROUPS:
- /ecs/kalshi-tis - TIS (Trading Infrastructure Service) - order execution, fills
- /ecs/kalshi-quickbets - QuickBets container - real-time trading
- /ecs/production-mention-market-monitor - Mention market monitoring, phase transitions, orderbook analysis
- /ecs/production-voice-mention-trader - Voice trader (legacy)

SEARCH PATTERNS:
- For a specific market: use the full market_ticker (e.g., 'KXEARNINGSMENTIONAXP-26JUN30-REGU')
- For event-level activity: use just the word suffix (e.g., 'REGU', 'MILL', 'BLOC')
- For errors: use filter_pattern='ERROR' or 'WARNING'
- For phase transitions: use filter_pattern='P3→4' or 'phase' with market_ticker

TIME RANGE:
- Default: last 1 hour
- For specific trades: use placed_at timestamp from trades-v2 (provide hours_ago=0 and use start_time_utc)

IMPORTANT: Returns max 50 log entries. Use specific time ranges and filter patterns to narrow results.""",
        "inputSchema": {
            "type": "object",
            "properties": {
                "log_group": {
                    "type": "string",
                    "enum": ["/ecs/kalshi-tis", "/ecs/kalshi-quickbets", "/ecs/production-mention-market-monitor", "/ecs/production-voice-mention-trader"],
                    "description": "CloudWatch log group to search"
                },
                "filter_pattern": {
                    "type": "string",
                    "description": "CloudWatch filter pattern. Use market_ticker or keyword like 'ERROR'. Patterns: 'TICKER' matches exact, '?A ?B' matches A OR B"
                },
                "hours_ago": {
                    "type": "integer",
                    "description": "How many hours back to search (default 1, max 24)"
                },
                "start_time_utc": {
                    "type": "string",
                    "description": "Optional: specific start time in ISO format (e.g., '2026-01-30T13:48:00'). Overrides hours_ago."
                },
                "end_time_utc": {
                    "type": "string",
                    "description": "Optional: specific end time in ISO format. Only used with start_time_utc."
                },
                "limit": {
                    "type": "integer",
                    "description": "Max log entries to return (default 25, max 50)"
                }
            },
            "required": ["log_group", "filter_pattern"]
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
        elif tool_name == "search_execution_logs":
            return tool_search_execution_logs(tool_input, user_name, is_admin)
        else:
            return {"error": f"Unknown tool: {tool_name}"}
    except Exception as e:
        logger.error(f"Tool execution error: {tool_name} - {e}")
        return {"error": str(e)}


def tool_query_dynamodb(params: Dict, user_name: str, is_admin: bool) -> Dict:
    """Query DynamoDB table with user scoping."""
    table_name = params.get('table_name', '')
    operation = params.get('operation', 'scan')
    # Default to 25 items - enough for most queries but not overwhelming
    limit = min(params.get('limit', 25), 1000)
    scan_index_forward = params.get('scan_index_forward', True)  # True = ascending (oldest first)
    
    # Validate table
    if table_name not in KALSHI_TABLES:
        return {"error": f"Table not allowed: {table_name}. Allowed tables: {', '.join(KALSHI_TABLES)}"}
    
    table = dynamodb.Table(table_name)
    rate_limiter.wait_and_acquire()
    
    # User scoping for non-admin
    expression_values = params.get('expression_attribute_values', {})
    filter_expr = params.get('filter_expression', '')
    key_condition = params.get('key_condition_expression', '')
    
    # Add user filter for tables with user_name (only for scan operations)
    user_scoped_tables = [
        'production-kalshi-trades-v2',
        'production-kalshi-positions-live',
        'production-kalshi-orders',
        'production-kalshi-portfolio-snapshots',
    ]
    
    if not is_admin and table_name in user_scoped_tables and operation == 'scan':
        if ':user_filter' not in expression_values:
            expression_values[':user_filter'] = user_name
            if filter_expr:
                filter_expr = f"({filter_expr}) AND user_name = :user_filter"
            else:
                filter_expr = "user_name = :user_filter"
    
    def strip_large_fields(items: list, table: str) -> list:
        """Remove large fields that bloat responses."""
        if table == 'production-kalshi-trades-v2':
            # orderbook_snapshot is ~3KB per record and rarely needed
            for item in items:
                if 'orderbook_snapshot' in item:
                    del item['orderbook_snapshot']
                # idea_parameters is also verbose
                if 'idea_parameters' in item:
                    del item['idea_parameters']
        return items
    
    try:
        if operation == 'get_item':
            key = params.get('key', {})
            response = table.get_item(Key=key)
            item = response.get('Item')
            if item:
                items = strip_large_fields([item], table_name)
                item = items[0] if items else None
            return {"item": json.loads(json.dumps(item, cls=DecimalEncoder)) if item else None}
        
        elif operation == 'query':
            kwargs = {
                'Limit': limit,
                'ScanIndexForward': scan_index_forward,
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
            items = strip_large_fields(items, table_name)
            return {
                "items": json.loads(json.dumps(items, cls=DecimalEncoder)),
                "count": len(items),
                "scanned_count": response.get('ScannedCount', len(items)),
                "has_more": 'LastEvaluatedKey' in response
            }
        
        else:  # scan
            kwargs = {'Limit': limit}
            if filter_expr:
                kwargs['FilterExpression'] = filter_expr
            if expression_values:
                kwargs['ExpressionAttributeValues'] = expression_values
            
            response = table.scan(**kwargs)
            items = response.get('Items', [])
            items = strip_large_fields(items, table_name)
            return {
                "items": json.loads(json.dumps(items, cls=DecimalEncoder)),
                "count": len(items),
                "scanned_count": response.get('ScannedCount', len(items)),
                "has_more": 'LastEvaluatedKey' in response
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
            if len(content) > 500000:
                content = content[:500000] + "\n\n... [truncated, file too large]"
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
        if len(content) > 500000:
            content = content[:500000] + "\n\n... [truncated, file too large]"
        
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


def tool_search_execution_logs(params: Dict, user_name: str, is_admin: bool) -> Dict:
    """Search CloudWatch logs for trade execution details."""
    filter_pattern = params.get('filter_pattern', '')
    
    # Non-admins can only search if their username is in the filter pattern
    # This ensures they can only see logs related to their own trades
    if not is_admin:
        if not filter_pattern or user_name.lower() not in filter_pattern.lower():
            return {"error": f"Non-admin users must include their username ('{user_name}') in the filter pattern to search execution logs."}
    
    log_group = params.get('log_group', '')
    filter_pattern = params.get('filter_pattern', '')
    hours_ago = min(params.get('hours_ago', 1), 24)  # Max 24 hours
    limit = min(params.get('limit', 25), 50)  # Max 50 entries
    
    # Validate log group
    allowed_log_groups = [
        '/ecs/kalshi-tis',
        '/ecs/kalshi-quickbets', 
        '/ecs/production-mention-market-monitor',
        '/ecs/production-voice-mention-trader'
    ]
    if log_group not in allowed_log_groups:
        return {"error": f"Log group not allowed: {log_group}. Allowed: {', '.join(allowed_log_groups)}"}
    
    # For non-admins, add username to filter pattern if not already prominently included
    # This is a safety measure to ensure they only see their own logs
    if not is_admin and user_name.lower() not in filter_pattern.lower():
        filter_pattern = f'"{user_name}" {filter_pattern}'.strip()
    
    # Calculate time range
    now = datetime.now(timezone.utc)
    start_time_utc = params.get('start_time_utc')
    end_time_utc = params.get('end_time_utc')
    
    if start_time_utc:
        try:
            # Parse ISO format
            start_dt = datetime.fromisoformat(start_time_utc.replace('Z', '+00:00'))
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)
            start_ms = int(start_dt.timestamp() * 1000)
            
            if end_time_utc:
                end_dt = datetime.fromisoformat(end_time_utc.replace('Z', '+00:00'))
                if end_dt.tzinfo is None:
                    end_dt = end_dt.replace(tzinfo=timezone.utc)
                end_ms = int(end_dt.timestamp() * 1000)
            else:
                # Default to 10 minutes after start
                end_ms = start_ms + (10 * 60 * 1000)
        except ValueError as e:
            return {"error": f"Invalid time format: {e}. Use ISO format like '2026-01-30T13:48:00'"}
    else:
        # Use hours_ago
        end_ms = int(now.timestamp() * 1000)
        start_ms = end_ms - (hours_ago * 60 * 60 * 1000)
    
    rate_limiter.wait_and_acquire()
    
    try:
        response = logs_client.filter_log_events(
            logGroupName=log_group,
            startTime=start_ms,
            endTime=end_ms,
            filterPattern=filter_pattern,
            limit=limit
        )
        
        events = response.get('events', [])
        
        if not events:
            return {
                "log_group": log_group,
                "filter_pattern": filter_pattern,
                "time_range": f"{datetime.fromtimestamp(start_ms/1000, tz=timezone.utc).isoformat()} to {datetime.fromtimestamp(end_ms/1000, tz=timezone.utc).isoformat()}",
                "message": "No log entries found matching the filter pattern in this time range.",
                "entries": []
            }
        
        # Format entries
        formatted_entries = []
        for event in events:
            ts = datetime.fromtimestamp(event['timestamp'] / 1000, tz=timezone.utc)
            formatted_entries.append({
                "timestamp": ts.strftime('%Y-%m-%d %H:%M:%S UTC'),
                "message": event['message'].strip()
            })
        
        return {
            "log_group": log_group,
            "filter_pattern": filter_pattern,
            "time_range": f"{datetime.fromtimestamp(start_ms/1000, tz=timezone.utc).isoformat()} to {datetime.fromtimestamp(end_ms/1000, tz=timezone.utc).isoformat()}",
            "entry_count": len(formatted_entries),
            "entries": formatted_entries
        }
        
    except logs_client.exceptions.ResourceNotFoundException:
        return {"error": f"Log group not found: {log_group}"}
    except Exception as e:
        logger.error(f"CloudWatch search error: {e}")
        return {"error": f"Error searching logs: {str(e)}"}


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

## DynamoDB Table Schemas (USE CORRECT KEYS!)

### production-kalshi-trades-v2 (⚠️ ~3KB per record after stripping)
- **Primary key:** order_id (HASH only) - NOT user_name!
- **GSI 'user_name-placed_at-index':** user_name (HASH), placed_at (RANGE) ← USE THIS FOR USER TRADES
- **GSI 'market_ticker-index':** market_ticker (HASH)
- Query example: operation='query', index_name='user_name-placed_at-index', key_condition='user_name = :u', scan_index_forward=false

### production-kalshi-positions-live (small, safe to query)
- **Primary key:** user_name (HASH), market_ticker (RANGE)
- Can query directly by user_name without GSI

### production-kalshi-orders
- **Primary key:** order_id (HASH only)
- **GSI 'user_name-placed_at-index':** user_name (HASH), placed_at (RANGE) ← USE THIS

### production-kalshi-market-metadata
- **Primary key:** market_ticker (HASH)
- **GSI 'event_ticker-index':** event_ticker (HASH)
- Use get_item for single market lookups

### S3 Buckets
- `production-kalshi-trading-config`: Trading idea configs (ideas/high-confidence.yaml)
- `production-kalshi-trading-captures`: Recorded game/event audio and data

## ⚠️ CRITICAL: Query Patterns

### For User Trades (CORRECT WAY):
```
query_dynamodb_table(
  table_name="production-kalshi-trades-v2",
  operation="query",
  index_name="user_name-placed_at-index",   ← REQUIRED! Primary key is order_id, not user_name
  key_condition_expression="user_name = :u",
  expression_attribute_values={{":u": "{user_name}"}},
  scan_index_forward=false,  ← newest first
  limit=25
)
```

### For User Positions (simpler - user_name is primary key):
```
query_dynamodb_table(
  table_name="production-kalshi-positions-live",
  operation="query",
  key_condition_expression="user_name = :u",
  expression_attribute_values={{":u": "{user_name}"}},
  limit=100
)
```

### NEVER DO THIS:
❌ scan on trades-v2 (11K+ records, will timeout)
❌ query trades-v2 without index_name (primary key is order_id, not user_name)
❌ limit=100+ on trades (3KB each = 300KB+ response)

## General Guidelines

1. **Be concise** - Summarize and highlight key points.
2. **Use tables** - Format data nicely when showing multiple items.
3. **Explain data** - Help users understand what the data means.
4. **Stay read-only** - You cannot modify any data.
5. **Time formatting** - Timestamps are UTC. Convert to US Eastern when displaying.
   - Display like "Jan 29, 2026 at 2:30 PM ET"
   - placed_at is Unix timestamp (seconds since epoch)
6. **Give exact counts** - When reporting row counts, always give the exact number (e.g., "27 trades") instead of approximate ranges (e.g., "20+ trades" or "several trades"). Query to get the actual count if needed.
7. **Show market_ticker, not order_id** - When displaying trades to users, show the market_ticker (e.g., "KXBTC-26JAN29-T104999") as the primary identifier, not the internal order_id. Users care about which market, not the UUID.

## Domain Knowledge: Mention Markets

"Mention markets" or "mention events" are a special type of event where we bet on whether someone will say specific words during a broadcast (typically NFL games or other live events).

**Structure:**
- An **event** (e.g., "KXNFLMENTION-25DEC22SFIND") contains multiple **markets**, one per word
- Each **market** represents a single word that may or may not be said (e.g., "touchdown", "fumble", "challenge")
- Buying **YES** = betting the word WILL be said during the broadcast
- Buying **NO** = betting the word will NOT be said

**How to identify mention markets:**
- Category field equals `mention`
- OR the event_ticker/market_ticker contains the string `MENTION` (e.g., `KXNFLMENTION-...`)

**Related tables:**
- `production-kalshi-mention-events` - List of mention events we're tracking
- `production-kalshi-mention-event-state` - Current state of each event (active, monitoring, etc.)
- `production-kalshi-mention-event-rotation` - Rotation schedule for mention event monitoring

**Trading strategy:** We use the Voice Trader system to listen to live audio and trade in real-time when words are detected.

## Execution Log Search

You can search CloudWatch logs to understand trade decisions and debug issues. This is useful when users ask "why did we trade X?" or "what happened at time Y?".

**Access Rules:**
- Non-admin users can search logs, but MUST include their username in the filter_pattern
- The system automatically ensures users only see logs related to their own trading activity
- When searching for a user, ALWAYS include their username (e.g., "jimc REGU" instead of just "REGU")

**Available Log Groups:**
- `/ecs/production-mention-market-monitor` - Main mention market monitoring (phase transitions, orderbook checks, trade signals)
- `/ecs/kalshi-tis` - TIS (Trading Infrastructure Service) - order execution, fills
- `/ecs/kalshi-quickbets` - QuickBets container trading activity
- `/ecs/production-voice-mention-trader` - Voice trader (legacy)

**How to trace a trade decision:**
1. Get the trade from `production-kalshi-trades-v2` by market_ticker or order_id
2. Note the `placed_at` timestamp (Unix seconds)
3. Search `/ecs/production-mention-market-monitor` with:
   - `filter_pattern`: the market_ticker (e.g., "KXEARNINGSMENTIONAXP-26JUN30-REGU")
   - `start_time_utc`: Convert placed_at to ISO format, go ~2 minutes earlier
   - `end_time_utc`: ~1 minute after placed_at

**Log patterns to look for:**
- `[P3→4]` - Phase 3 to 4 transition checks (market-by-market orderbook analysis)
- `[TRADE-RECEIVED]` - Trade detected on WebSocket
- `[PHASE-3-CHECK]` - Speech-end detection logic
- `[SPEECH-END-RAMP-UP]` / `[SPEECH-END-BURST]` - Trade volume analysis
- `ERROR` / `WARNING` - Issues and reconnections

**Example: Trace why REGU triggered:**
1. Query trades-v2 for market_ticker containing "REGU"
2. Get placed_at timestamp
3. Search logs with filter_pattern="REGU" around that time
4. Look for phase transitions and orderbook state

## NCAA Basketball Game Capture Data

We capture tick-level market and game state data during live NCAA basketball games for analysis and strategy development.

**Storage Location:**
- S3 Bucket: `production-kalshi-trading-captures`
- Folder structure: `KXNCAAMBGAME-{{date}}{{matchup}}/` (e.g., `KXNCAAMBGAME-26FEB10MARQVILL/`)
- Files: `{{timestamp}}_capture.jsonl` (JSONL format - one JSON object per line)
- Files marked `_INCOMPLETE` are from interrupted captures

**Event Ticker Naming:**
- `KXNCAAMBGAME-{{date}}{{matchup}}` - Win market (who wins the game)
- `KXNCAAMBSPREAD-{{date}}{{matchup}}` - Spread market (point spread)
- `KXNCAAMBTOTAL-{{date}}{{matchup}}` - Total/Over-Under market (combined score)
- Date format: `26FEB10` = February 10, 2026
- Matchup format: `MARQVILL` = Marquette at Villanova (visitor + home abbreviated)

**Data Schema (each line is a JSON object):**
```json
{{
  "ts": 1770777006260,        // Unix timestamp in MILLISECONDS
  "win": {{                   // Win market prices (who wins)
    "yes_bid": 0.54,          // Best bid for YES
    "yes_ask": 0.55,          // Best ask for YES
    "last": 0.55              // Last trade price
  }},
  "spread": {{                // Spread market prices (selected most liquid spread line)
    "yes_bid": 0.01,
    "yes_ask": 0.06,
    "last": 0.04
  }},
  "total": {{                 // Total/O-U market prices (selected most liquid total line)
    "yes_bid": 0.84,
    "yes_ask": 0.96,
    "last": 0.91
  }},
  "game": {{                  // Live game state from sports feed
    "home": 66,               // Home team score
    "away": 69,               // Away team score  
    "period": "half2",        // "half1", "half2", or "halftime"
    "clock": "4:00",          // Time remaining in period
    "status": "inprogress"    // "scheduled", "inprogress", "final"
  }}
}}
```

**Querying Capture Data:**
- Use `read_s3_file` to fetch capture files
- These are JSONL files (newline-delimited JSON), NOT regular JSON arrays
- Files can be large (50MB+ for full games) - use `max_bytes` parameter
- Each line is independent - parse line by line

**Example: Get recent data from a game:**
```
read_s3_file(
  bucket="production-kalshi-trading-captures",
  key="KXNCAAMBGAME-26FEB10MARQVILL/2026-02-11T00-30-46_capture.jsonl",
  max_bytes=50000  // Get ~50KB sample
)
```

**Auto-Queue System:**
Games are automatically queued for capture via Lambda (`production-capture-game-auto-queue`):
- Runs every 30 minutes
- Scans Kalshi for NCAA basketball events (series: KXNCAAMBGAME)
- Queues games scheduled within the next 4 hours
- State tracked in DynamoDB `production-sports-feeder-state` table

**Analysis Use Cases:**
- Study price movements relative to game events (scores, timeouts, fouls)
- Compare win/spread/total correlations during different game phases
- Identify profitable patterns (e.g., endgame pullback opportunities)
- Backtest trading strategies against historical tick data

Current UTC timestamp: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC
Note: US Eastern is currently {'EST (UTC-5)' if datetime.now(timezone.utc).month in [11, 12, 1, 2, 3] else 'EDT (UTC-4)'}.
"""


# ============================================================================
# Main Handler
# ============================================================================

def lambda_handler(event, context):
    """
    AI Chat handler - supports both streaming (Function URL) and non-streaming (API Gateway).
    
    For Function URL (streaming):
    - Returns a generator that yields JSON chunks
    - Each chunk: {"type": "progress|text|done|error", "content": "..."}
    
    For API Gateway (non-streaming):
    - Returns complete response as JSON
    
    Actions:
    - chat: Process a chat message
    - save: Save conversation to S3
    - load: Load conversation from S3
    - list: List saved conversations
    - delete: Delete a saved conversation
    """
    logger.info(f"AI Chat request received")
    
    # Detect if this is a Function URL request (streaming) or API Gateway
    is_function_url = 'requestContext' in event and 'http' in event.get('requestContext', {})
    
    try:
        # Parse request body (may be empty for GET requests)
        body_str = event.get('body', '{}') or '{}'
        if isinstance(body_str, str):
            body = json.loads(body_str) if body_str else {}
        else:
            body = body_str or {}
        
        # Get HTTP method and path for routing
        http_method = event.get('httpMethod', 'POST')
        path = event.get('path', '/ai-chat')
        
        # Determine action based on path or body
        if '/conversations' in path:
            if http_method == 'GET':
                action = 'list'
            else:
                # POST to /conversations - action in body
                action = body.get('action', 'save')
        else:
            action = body.get('action', 'chat')
        
        # Get user identity - different for Function URL vs API Gateway
        if is_function_url:
            # Function URL with IAM auth - user comes from request body
            user_name = body.get('user_name', 'unknown')
            is_admin = body.get('is_admin', False)
        else:
            # API Gateway with Cognito authorizer
            claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
            user_name = claims.get('cognito:username', claims.get('preferred_username', 'unknown'))
            groups_str = claims.get('cognito:groups', '')
            is_admin = 'admin' in groups_str.lower() if groups_str else False
        
        logger.info(f"User: {user_name}, Admin: {is_admin}, Action: {action}, Method: {http_method}, Path: {path}, Streaming: {is_function_url}")
        
        # Handle different actions
        if action == 'save':
            return handle_save_conversation(body, user_name)
        elif action == 'load':
            return handle_load_conversation(body, user_name)
        elif action == 'list':
            return handle_list_conversations(user_name)
        elif action == 'delete':
            return handle_delete_conversation(body, user_name)
        elif action == 'chat':
            # Both Function URL and API Gateway use sync handler
            # Function URL gives us 15-min timeout, streaming not supported for Python
            return handle_chat_sync(body, user_name, is_admin)
        else:
            return error_response(400, f"Unknown action: {action}")
            
    except Exception as e:
        logger.error(f"Error in AI chat handler: {e}", exc_info=True)
        return error_response(500, str(e))


def error_response(status_code: int, message: str) -> Dict:
    """Return a standard error response."""
    # Note: Don't add CORS headers here - Function URL handles them
    # Adding them causes duplicate '*, *' which browsers reject
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
        },
        'body': json.dumps({'error': message})
    }


def success_response(data: Dict) -> Dict:
    """Return a standard success response."""
    # Note: Don't add CORS headers here - Function URL handles them
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json',
        },
        'body': json.dumps(data, cls=DecimalEncoder)
    }


# ============================================================================
# Conversation Storage (S3)
# ============================================================================

CONVERSATIONS_BUCKET = os.environ.get('CONVERSATIONS_BUCKET', 'production-kalshi-trading-config')
CONVERSATIONS_PREFIX = 'ai-conversations'


def handle_save_conversation(body: Dict, user_name: str) -> Dict:
    """Save a conversation to S3."""
    conversation_id = body.get('conversation_id')
    title = body.get('title', 'Untitled')
    messages = body.get('messages', [])
    
    if not conversation_id:
        conversation_id = f"{int(time.time() * 1000)}"
    
    conversation = {
        'id': conversation_id,
        'title': title,
        'messages': messages,
        'user_name': user_name,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    
    key = f"{CONVERSATIONS_PREFIX}/{user_name}/{conversation_id}.json"
    
    try:
        s3.put_object(
            Bucket=CONVERSATIONS_BUCKET,
            Key=key,
            Body=json.dumps(conversation, cls=DecimalEncoder),
            ContentType='application/json'
        )
        return success_response({'conversation_id': conversation_id, 'saved': True})
    except Exception as e:
        logger.error(f"Failed to save conversation: {e}")
        return error_response(500, f"Failed to save: {e}")


def handle_load_conversation(body: Dict, user_name: str) -> Dict:
    """Load a conversation from S3."""
    conversation_id = body.get('conversation_id')
    if not conversation_id:
        return error_response(400, "conversation_id required")
    
    key = f"{CONVERSATIONS_PREFIX}/{user_name}/{conversation_id}.json"
    
    try:
        response = s3.get_object(Bucket=CONVERSATIONS_BUCKET, Key=key)
        conversation = json.loads(response['Body'].read().decode('utf-8'))
        return success_response({'conversation': conversation})
    except s3.exceptions.NoSuchKey:
        return error_response(404, "Conversation not found")
    except Exception as e:
        logger.error(f"Failed to load conversation: {e}")
        return error_response(500, f"Failed to load: {e}")


def handle_list_conversations(user_name: str) -> Dict:
    """List all conversations for a user."""
    prefix = f"{CONVERSATIONS_PREFIX}/{user_name}/"
    
    try:
        response = s3.list_objects_v2(
            Bucket=CONVERSATIONS_BUCKET,
            Prefix=prefix,
            MaxKeys=100
        )
        
        conversations = []
        for obj in response.get('Contents', []):
            try:
                meta_response = s3.get_object(Bucket=CONVERSATIONS_BUCKET, Key=obj['Key'])
                conv = json.loads(meta_response['Body'].read().decode('utf-8'))
                conversations.append({
                    'id': conv.get('id'),
                    'title': conv.get('title', 'Untitled'),
                    'created_at': conv.get('created_at'),
                    'updated_at': conv.get('updated_at'),
                    'message_count': len(conv.get('messages', [])),
                })
            except:
                pass
        
        conversations.sort(key=lambda x: x.get('updated_at', ''), reverse=True)
        return success_response({'conversations': conversations})
    except Exception as e:
        logger.error(f"Failed to list conversations: {e}")
        return error_response(500, f"Failed to list: {e}")


def handle_delete_conversation(body: Dict, user_name: str) -> Dict:
    """Delete a conversation from S3."""
    conversation_id = body.get('conversation_id')
    if not conversation_id:
        return error_response(400, "conversation_id required")
    
    key = f"{CONVERSATIONS_PREFIX}/{user_name}/{conversation_id}.json"
    
    try:
        s3.delete_object(Bucket=CONVERSATIONS_BUCKET, Key=key)
        return success_response({'deleted': True})
    except Exception as e:
        logger.error(f"Failed to delete conversation: {e}")
        return error_response(500, f"Failed to delete: {e}")


# ============================================================================
# Chat Handlers
# ============================================================================

def handle_chat_sync(body: Dict, user_name: str, is_admin: bool) -> Dict:
    """Handle chat synchronously (for API Gateway)."""
    messages = body.get('messages', [])
    
    if isinstance(messages, str):
        messages = json.loads(messages)
    
    if not messages:
        return error_response(400, 'No messages provided')
    
    system_prompt = build_system_prompt(user_name, is_admin)
    
    claude_messages = []
    for msg in messages:
        role = msg.get('role', 'user')
        content = msg.get('content', '')
        if role in ['user', 'assistant']:
            claude_messages.append({
                'role': role, 
                'content': [{'text': content}]
            })
    
    # Truncate conversation if too long
    claude_messages = truncate_conversation(claude_messages)
    
    result = call_bedrock_with_tools(
        system_prompt=system_prompt,
        messages=claude_messages,
        user_name=user_name,
        is_admin=is_admin
    )
    
    return success_response({
        'response': result['response'],
        'tool_calls': result['tool_calls'],
        'user': user_name,
        'is_admin': is_admin
    })


def handle_chat_streaming(body: Dict, user_name: str, is_admin: bool):
    """
    Handle chat with streaming response (for Function URL).
    Returns a generator that yields newline-delimited JSON chunks.
    """
    messages = body.get('messages', [])
    
    if isinstance(messages, str):
        messages = json.loads(messages)
    
    if not messages:
        yield json.dumps({'type': 'error', 'content': 'No messages provided'}) + '\n'
        return
    
    system_prompt = build_system_prompt(user_name, is_admin)
    
    claude_messages = []
    for msg in messages:
        role = msg.get('role', 'user')
        content = msg.get('content', '')
        if role in ['user', 'assistant']:
            claude_messages.append({
                'role': role, 
                'content': [{'text': content}]
            })
    
    # Truncate conversation if too long
    claude_messages = truncate_conversation(claude_messages)
    
    yield from call_bedrock_with_tools_streaming(
        system_prompt=system_prompt,
        messages=claude_messages,
        user_name=user_name,
        is_admin=is_admin
    )


def call_bedrock_with_tools_streaming(
    system_prompt: str, 
    messages: List[Dict], 
    user_name: str, 
    is_admin: bool, 
    max_iterations: int = 20
) -> Generator[str, None, None]:
    """
    Call Bedrock Claude with tool support, yielding progress updates.
    
    Yields newline-delimited JSON chunks:
    - {"type": "progress", "content": "Querying portfolio..."}
    - {"type": "done", "content": "full response", "user": "...", "is_admin": ...}
    - {"type": "error", "content": "error message"}
    """
    current_messages = messages.copy()
    
    bedrock_tools = []
    for t in TOOLS:
        tool_spec = {
            'name': t['name'],
            'description': t['description'],
            'inputSchema': {'json': t['inputSchema']}
        }
        bedrock_tools.append({'toolSpec': tool_spec})
    
    for iteration in range(max_iterations):
        # Log the size of what we're sending
        messages_json = json.dumps(current_messages, cls=DecimalEncoder)
        system_json = json.dumps(system_prompt)
        tools_json = json.dumps(bedrock_tools)
        logger.info(f"Bedrock call iteration {iteration + 1}: messages={len(messages_json)} chars, system={len(system_json)} chars, tools={len(tools_json)} chars, total={len(messages_json)+len(system_json)+len(tools_json)} chars")
        yield json.dumps({'type': 'progress', 'content': f'Thinking... (iteration {iteration + 1})'}) + '\n'
        
        response = bedrock.converse(
            modelId=MODEL_ID,
            system=[{'text': system_prompt}],
            messages=current_messages,
            toolConfig={'tools': bedrock_tools},
            inferenceConfig={
                'maxTokens': MAX_TOKENS,
                'temperature': 0.3,
            }
        )
        
        stop_reason = response.get('stopReason', 'end_turn')
        output = response.get('output', {})
        message = output.get('message', {})
        content_blocks = message.get('content', [])
        
        logger.info(f"Stop reason: {stop_reason}, Content blocks: {len(content_blocks)}")
        
        if stop_reason != 'tool_use':
            text_parts = []
            for block in content_blocks:
                if 'text' in block:
                    text_parts.append(block['text'])
            full_response = '\n'.join(text_parts)
            yield json.dumps({'type': 'done', 'content': full_response, 'user': user_name, 'is_admin': is_admin}) + '\n'
            return
        
        tool_results = []
        for block in content_blocks:
            if 'toolUse' in block:
                tool_use = block['toolUse']
                tool_id = tool_use['toolUseId']
                tool_name = tool_use['name']
                tool_input = tool_use.get('input', {})
                
                friendly_name = tool_name.replace('_', ' ').title()
                yield json.dumps({'type': 'progress', 'content': f'Executing: {friendly_name}...'}) + '\n'
                
                logger.info(f"Executing tool: {tool_name}")
                result = execute_tool(tool_name, tool_input, user_name, is_admin)
                result = truncate_tool_result(result)  # Prevent context overflow
                
                tool_results.append({
                    'toolResult': {
                        'toolUseId': tool_id,
                        'content': [{'json': result}]
                    }
                })
        
        current_messages.append(message)
        current_messages.append({'role': 'user', 'content': tool_results})
    
    yield json.dumps({'type': 'done', 'content': 'Max iterations reached. The query may be too complex.', 'user': user_name, 'is_admin': is_admin}) + '\n'


def call_bedrock_with_tools(system_prompt: str, messages: List[Dict], user_name: str, is_admin: bool, max_iterations: int = 20) -> Dict:
    """
    Call Bedrock Claude with tool support, handling tool use loops.
    
    Returns a dict with:
    - response: The final text response
    - tool_calls: List of tools that were called with their descriptions
    """
    current_messages = messages.copy()
    tool_calls_made = []  # Track which tools were called
    
    # Convert tools to Bedrock format - inputSchema must be wrapped in {'json': schema}
    bedrock_tools = []
    for t in TOOLS:
        tool_spec = {
            'name': t['name'],
            'description': t['description'],
            'inputSchema': {'json': t['inputSchema']}  # Wrap in json key
        }
        bedrock_tools.append({'toolSpec': tool_spec})
    
    for iteration in range(max_iterations):
        # Log the size of what we're sending
        messages_json = json.dumps(current_messages, cls=DecimalEncoder)
        system_json = json.dumps(system_prompt)
        tools_json = json.dumps(bedrock_tools)
        logger.info(f"Bedrock call iteration {iteration + 1}: messages={len(messages_json)} chars, system={len(system_json)} chars, tools={len(tools_json)} chars, total={len(messages_json)+len(system_json)+len(tools_json)} chars")
        
        # Call Bedrock
        response = bedrock.converse(
            modelId=MODEL_ID,
            system=[{'text': system_prompt}],
            messages=current_messages,
            toolConfig={'tools': bedrock_tools},
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
            return {
                'response': '\n'.join(text_parts),
                'tool_calls': tool_calls_made
            }
        
        # Handle tool use
        tool_results = []
        for block in content_blocks:
            if 'toolUse' in block:
                tool_use = block['toolUse']
                tool_id = tool_use['toolUseId']
                tool_name = tool_use['name']
                tool_input = tool_use.get('input', {})
                
                logger.info(f"Executing tool: {tool_name}")
                
                # Track the tool call for the "train of thought"
                tool_call_info = {'tool': tool_name}
                if tool_name == 'query_dynamodb':
                    tool_call_info['detail'] = f"Querying {tool_input.get('table_name', 'table')}"
                elif tool_name == 'read_s3_file':
                    tool_call_info['detail'] = f"Reading {tool_input.get('key', 'file')}"
                elif tool_name == 'kalshi_get_portfolio':
                    tool_call_info['detail'] = f"Getting portfolio for {tool_input.get('user_name', 'user')}"
                elif tool_name == 'kalshi_get_market':
                    tool_call_info['detail'] = f"Getting market {tool_input.get('ticker', '')}"
                elif tool_name == 'kalshi_get_orderbook':
                    tool_call_info['detail'] = f"Getting orderbook for {tool_input.get('ticker', '')}"
                elif tool_name == 'read_documentation':
                    tool_call_info['detail'] = f"Reading {tool_input.get('file_path', 'docs')}"
                elif tool_name == 'estimate_query_cost':
                    tool_call_info['detail'] = f"Estimating cost for {tool_input.get('table_name', 'query')}"
                else:
                    tool_call_info['detail'] = tool_name
                tool_calls_made.append(tool_call_info)
                
                # Execute the tool
                result = execute_tool(tool_name, tool_input, user_name, is_admin)
                result = truncate_tool_result(result)  # Prevent context overflow
                
                tool_results.append({
                    'toolResult': {
                        'toolUseId': tool_id,
                        'content': [{'json': result}]
                    }
                })
        
        # Add assistant message and tool results to conversation
        current_messages.append(message)
        current_messages.append({'role': 'user', 'content': tool_results})
    
    return {
        'response': "Max iterations reached. The query may be too complex.",
        'tool_calls': tool_calls_made
    }
