"""Kalshi API client with RSA-PSS authentication.

This module provides a client for interacting with the Kalshi prediction
market API, including RSA signature-based authentication and pagination
support for fetching market data.
"""

import base64
import os
import time
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend

from models import KalshiMarketResponse
from utils import StructuredLogger, retry_with_backoff

# Try to import DynamoDB rate limiter from Lambda Layer
try:
    from rate_limiter import DynamoDBRateLimiter, PostRateLimiter, RateLimiterConfig
    DYNAMODB_RATE_LIMITER_AVAILABLE = True
except ImportError as e:
    import sys
    print(f"IMPORT ERROR: Failed to import DynamoDB rate limiter: {e}", file=sys.stderr)
    print(f"IMPORT ERROR: sys.path = {sys.path}", file=sys.stderr)
    DYNAMODB_RATE_LIMITER_AVAILABLE = False


class RateLimiter:
    """Token bucket rate limiter for API requests.
    
    Attributes:
        rate: Maximum requests per second
        tokens: Current token count
        last_update: Last time tokens were replenished
        lock: Thread lock for token updates
        logger: Optional logger for debugging
        invocation_count: Number of times acquire was called
        total_wait_time_ms: Total time spent waiting in milliseconds
    """
    
    def __init__(self, requests_per_second: int = 20, logger=None):
        """Initialize rate limiter.
        
        Args:
            requests_per_second: Maximum number of requests per second
            logger: Optional logger instance
        """
        self.rate = requests_per_second
        self.tokens = float(requests_per_second)
        self.last_update = time.time()
        self.lock = threading.Lock()
        self.logger = logger
        self.invocation_count = 0
        self.total_wait_time_ms = 0.0
    
    def acquire(self, tokens: int = 1):
        """Acquire tokens, blocking if necessary to respect rate limit.
        
        Args:
            tokens: Number of tokens to acquire (default: 1)
        """
        with self.lock:
            self.invocation_count += 1
            now = time.time()
            # Replenish tokens based on time elapsed since last update
            elapsed = now - self.last_update
            self.tokens = min(self.rate, self.tokens + elapsed * self.rate)
            
            # If we don't have enough tokens, wait until we do
            if self.tokens < tokens:
                sleep_time = (tokens - self.tokens) / self.rate
                if self.logger:
                    self.logger.debug(
                        "Rate limiter: out of tokens, sleeping",
                        available_tokens=self.tokens,
                        required_tokens=tokens,
                        sleep_seconds=sleep_time,
                        rate_limit=self.rate
                    )
                time.sleep(sleep_time)
                self.total_wait_time_ms += sleep_time * 1000
                self.tokens = tokens  # We now have enough tokens after waiting
            
            # Update last_update and consume tokens
            self.last_update = time.time()
            self.tokens -= tokens
    
    def get_stats(self) -> dict:
        """Get rate limiter statistics.
        
        Returns:
            Dictionary with invocation count and total wait time
        """
        return {
            'invocations': self.invocation_count,
            'total_wait_time_ms': round(self.total_wait_time_ms, 2)
        }


class KalshiAPIError(Exception):
    """Base exception for Kalshi API errors."""
    
    def __init__(self, message: str, error_code: str = None, http_status: int = None):
        super().__init__(message)
        self.error_code = error_code
        self.http_status = http_status


class KalshiBusinessError(KalshiAPIError):
    """Raised for expected business conditions (insufficient balance, etc)."""
    pass


class KalshiAuthenticationError(KalshiAPIError):
    """Raised when authentication fails."""
    pass


class KalshiRateLimitError(KalshiAPIError):
    """Raised when rate limit is exceeded."""
    pass


class KalshiClient:
    """Client for Kalshi prediction market API.
    
    This client handles RSA-PSS signature-based authentication and provides
    methods for fetching market, event, and series data from Kalshi.
    
    Attributes:
        base_url: Base URL for Kalshi API
        api_key_id: Kalshi API key ID
        private_key: RSA private key for signing requests
        session: HTTP session with connection pooling
        logger: Structured logger instance
    """
    
    def __init__(
        self,
        base_url: str,
        api_key_id: str,
        private_key_pem: str,
        logger: Optional[StructuredLogger] = None,
        requests_per_second: int = 20,
        write_requests_per_second: int = 10,
        rate_limiter_table_name: Optional[str] = None
    ):
        """Initialize Kalshi API client.
        
        Args:
            base_url: Base URL for Kalshi API (e.g., https://api.kalshi.com)
            api_key_id: Kalshi API key ID
            private_key_pem: RSA private key in PEM format
            logger: Optional structured logger instance
            requests_per_second: Maximum API read requests per second (default: 20)
            write_requests_per_second: Maximum API write requests per second (default: 10)
            rate_limiter_table_name: DynamoDB table name for centralized rate limiting
            
        Raises:
            KalshiAuthenticationError: If private key is invalid
        """
        self.base_url = base_url.rstrip('/')
        self.api_key_id = api_key_id
        self.logger = logger or StructuredLogger(__name__)
        
        # Initialize read rate limiter (DynamoDB or in-memory fallback)
        if rate_limiter_table_name and DYNAMODB_RATE_LIMITER_AVAILABLE:
            self.logger.info("Initializing DynamoDB read rate limiter", table_name=rate_limiter_table_name)
            self.rate_limiter = DynamoDBRateLimiter(
                RateLimiterConfig(
                    table_name=rate_limiter_table_name,
                    api_key_id=api_key_id,
                    capacity=requests_per_second,
                    refill_rate=float(requests_per_second)
                ),
                logger=self.logger
            )
            self.using_dynamodb_rate_limiter = True
        else:
            if rate_limiter_table_name:
                self.logger.warning("DynamoDB rate limiter requested but not available, using in-memory fallback")
            self.rate_limiter = RateLimiter(requests_per_second, logger=self.logger)
            self.using_dynamodb_rate_limiter = False
        
        # Initialize POST rate limiter (DynamoDB or in-memory fallback)
        if rate_limiter_table_name and DYNAMODB_RATE_LIMITER_AVAILABLE:
            self.logger.info("Initializing DynamoDB POST rate limiter", table_name=rate_limiter_table_name)
            self.post_rate_limiter = PostRateLimiter(
                RateLimiterConfig(
                    table_name=rate_limiter_table_name,
                    api_key_id=api_key_id,
                    capacity=write_requests_per_second,
                    refill_rate=float(write_requests_per_second)
                ),
                logger=self.logger
            )
            self.using_dynamodb_post_rate_limiter = True
        else:
            if rate_limiter_table_name:
                self.logger.warning("DynamoDB POST rate limiter requested but not available, using in-memory fallback")
            self.post_rate_limiter = RateLimiter(write_requests_per_second, logger=self.logger)
            self.using_dynamodb_post_rate_limiter = False
        
        # Load and parse the private key
        try:
            self.private_key = serialization.load_pem_private_key(
                private_key_pem.encode('utf-8'),
                password=None,
                backend=default_backend()
            )
        except Exception as e:
            raise KalshiAuthenticationError(
                f"Failed to load private key: {e}"
            ) from e
        
        # Create session with connection pooling and retries
        self.session = self._create_session()
        
        self.logger.info("Kalshi API client initialized", base_url=base_url)
    
    def _create_session(self) -> requests.Session:
        """Create HTTP session with retry logic and connection pooling.
        
        Returns:
            Configured requests Session
        """
        session = requests.Session()
        
        # Configure retries for transient errors
        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[500, 502, 503, 504],
            allowed_methods=["GET", "POST"],
        )
        
        adapter = HTTPAdapter(
            max_retries=retry_strategy,
            pool_connections=10,
            pool_maxsize=20
        )
        
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        
        return session
    
    def _sign_request(self, method: str, path: str) -> Dict[str, str]:
        """Generate RSA-PSS signature for API request.
        
        The signature is created from: timestamp + method + path_without_query
        where timestamp is milliseconds since epoch, method is uppercase,
        and path excludes query parameters.
        
        Args:
            method: HTTP method (GET, POST, etc.)
            path: Request path (may include query parameters)
            
        Returns:
            Dictionary with authentication headers
        """
        # Generate timestamp in milliseconds
        timestamp = str(int(datetime.now(tz=timezone.utc).timestamp() * 1000))
        
        # Strip query parameters from path for signature
        path_without_query = path.split('?')[0]
        
        # Create signature message: timestamp + UPPERCASE_METHOD + path
        msg_string = f"{timestamp}{method.upper()}{path_without_query}"
        
        # Sign with RSA-PSS
        signature = self.private_key.sign(
            msg_string.encode('utf-8'),
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH
            ),
            hashes.SHA256()
        )
        
        # Encode signature as base64
        signature_b64 = base64.b64encode(signature).decode('utf-8')
        
        return {
            'KALSHI-ACCESS-KEY': self.api_key_id,
            'KALSHI-ACCESS-SIGNATURE': signature_b64,
            'KALSHI-ACCESS-TIMESTAMP': timestamp
        }
    
    def _make_request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        tokens: int = 1,
        timeout: int = 10
    ) -> Dict[str, Any]:
        """Make authenticated request to Kalshi API.
        
        Args:
            method: HTTP method (GET, POST, DELETE, etc.)
            path: API endpoint path (without base URL)
            params: Optional query parameters
            json_data: Optional JSON body for POST/PUT/PATCH requests
            tokens: Number of rate limiter tokens to acquire (for batch operations)
            timeout: Request timeout in seconds
            
        Returns:
            JSON response as dictionary
            
        Raises:
            KalshiAuthenticationError: If authentication fails (401, 403)
            KalshiRateLimitError: If rate limit exceeded (429)
            KalshiAPIError: For other API errors
        """
        # Select appropriate rate limiter based on HTTP method
        if method.upper() in ['POST', 'PUT', 'PATCH', 'DELETE']:
            rate_limiter = self.post_rate_limiter
            limiter_type = "post"
        else:
            rate_limiter = self.rate_limiter
            limiter_type = "get"
        
        # Apply rate limiting before making request
        rate_limiter.acquire(tokens=tokens)
        
        self.logger.debug(
            f"Rate limiter acquired {tokens} token(s)",
            limiter_type=limiter_type,
            tokens=tokens,
            method=method,
            path=path
        )
        
        # Ensure path starts with /
        if not path.startswith('/'):
            path = '/' + path
        
        # Build full URL
        url = f"{self.base_url}{path}"
        
        # Generate authentication headers
        auth_headers = self._sign_request(method, path)
        
        # Combine with standard headers
        headers = {
            **auth_headers,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }
        
        # Make request
        start_time = time.time()
        try:
            response = self.session.request(
                method=method,
                url=url,
                headers=headers,
                params=params,
                json=json_data,
                timeout=timeout
            )
            
            duration_ms = (time.time() - start_time) * 1000
            
            self.logger.debug(
                f"API request: {method} {path}",
                method=method,
                path=path,
                status_code=response.status_code,
                duration_ms=round(duration_ms, 2)
            )
            
            # Handle authentication errors
            if response.status_code in [401, 403]:
                raise KalshiAuthenticationError(
                    f"Authentication failed: {response.status_code} - {response.text}"
                )
            
            # Handle rate limiting
            if response.status_code == 429:
                raise KalshiRateLimitError(
                    f"Rate limit exceeded: {response.text}"
                )
            
            # Handle other errors
            if not response.ok:
                # Try to parse error response
                error_code = None
                error_message = response.text
                try:
                    error_data = response.json()
                    if 'error' in error_data:
                        error_code = error_data['error'].get('code')
                        error_message = error_data['error'].get('message', response.text)
                except:
                    pass
                
                # Check if this is an expected business condition
                business_error_codes = [
                    'insufficient_balance',
                    'market_not_open',
                    'market_paused',
                    'order_min_not_met',
                    'order_max_exceeded'
                ]
                
                if error_code in business_error_codes:
                    raise KalshiBusinessError(
                        f"API request failed: {response.status_code} - {response.text}",
                        error_code=error_code,
                        http_status=response.status_code
                    )
                
                # Real error
                raise KalshiAPIError(
                    f"API request failed: {response.status_code} - {response.text}",
                    error_code=error_code,
                    http_status=response.status_code
                )
            
            return response.json()
            
        except requests.exceptions.Timeout as e:
            self.logger.error(
                f"Request timeout: {method} {path}",
                method=method,
                path=path,
                timeout=timeout,
                error=str(e)
            )
            raise KalshiAPIError(f"Request timeout after {timeout}s") from e
        
        except requests.exceptions.RequestException as e:
            self.logger.error(
                f"Request failed: {method} {path}",
                method=method,
                path=path,
                error=str(e)
            )
            raise KalshiAPIError(f"Request failed: {e}") from e
    
    def get_all_markets(
        self,
        status: str = 'open',
        limit: int = 1000
    ) -> List[KalshiMarketResponse]:
        """Fetch all markets from Kalshi API with pagination.
        
        This method sequentially fetches all markets using cursor-based
        pagination. Each request depends on the cursor from the previous
        response, so requests cannot be parallelized.
        
        Args:
            status: Market status filter (default: 'open')
            limit: Number of markets per page (max 1000)
            
        Returns:
            List of KalshiMarketResponse objects
            
        Raises:
            KalshiAPIError: If API request fails
        """
        all_markets: List[KalshiMarketResponse] = []
        cursor: Optional[str] = None
        page = 0
        
        self.logger.info(
            "Starting to fetch markets",
            status=status,
            limit=limit
        )
        
        while True:
            page += 1
            
            # Build query parameters
            params: Dict[str, Any] = {
                'limit': limit,
                'status': status,
            }
            
            if cursor:
                params['cursor'] = cursor
            
            # Fetch page of markets
            try:
                response = self._make_request(
                    method='GET',
                    path='/trade-api/v2/markets',
                    params=params,
                    timeout=30  # Longer timeout for large responses
                )
            except KalshiAPIError as e:
                self.logger.error(
                    f"Failed to fetch markets page {page}",
                    page=page,
                    cursor=cursor,
                    error=str(e)
                )
                raise
            
            # Parse markets from response
            markets_data = response.get('markets', [])
            
            if not markets_data:
                self.logger.info(
                    "No more markets to fetch",
                    page=page,
                    total_markets=len(all_markets)
                )
                break
            
            # Convert to Pydantic models
            for market_dict in markets_data:
                try:
                    market = KalshiMarketResponse(**market_dict)
                    all_markets.append(market)
                except Exception as e:
                    self.logger.warning(
                        "Failed to parse market data",
                        market_ticker=market_dict.get('ticker', 'unknown'),
                        error=str(e)
                    )
            
            self.logger.info(
                f"Fetched page {page} of markets",
                page=page,
                markets_in_page=len(markets_data),
                total_markets=len(all_markets)
            )
            
            # Check for next page cursor
            cursor = response.get('cursor')
            if not cursor:
                self.logger.info(
                    "Reached end of market pagination",
                    total_pages=page,
                    total_markets=len(all_markets)
                )
                break
        
        self.logger.info(
            "Completed fetching all markets",
            total_markets=len(all_markets),
            total_pages=page
        )
        
        return all_markets
    
    def iter_all_markets(
        self,
        status: str = 'open',
        limit: int = 1000
    ):
        """Iterate over all markets from Kalshi API with pagination.
        
        Multivariate markets are filtered out before yielding.
        
        This is a generator that yields (market, capture_time) tuples.
        Each page of results shares the same capture_time (when API call was made).
        This is memory-efficient for processing large numbers of markets.
        
        Args:
            status: Market status filter (default: 'open')
            limit: Number of markets per page (max 1000)
            
        Yields:
            Tuple of (KalshiMarketResponse, datetime) - market and its API call timestamp
            
        Raises:
            KalshiAPIError: If API request fails
        """
        cursor: Optional[str] = None
        page = 0
        
        self.logger.info(
            "Starting to iterate over markets",
            status=status,
            limit=limit
        )
        
        while True:
            page += 1
            
            # Build query parameters
            params: Dict[str, Any] = {
                'limit': limit,
                'status': status,
                'mve_filter': 'exclude',  # Exclude multivariate events at API level
            }
            
            if cursor:
                params['cursor'] = cursor
            
            # Capture timestamp right before API call
            page_capture_time = datetime.now(timezone.utc)
            
            # Fetch page of markets
            try:
                response = self._make_request(
                    method='GET',
                    path='/trade-api/v2/markets',
                    params=params,
                    timeout=30  # Longer timeout for large responses
                )
            except KalshiAPIError as e:
                self.logger.error(
                    f"Failed to fetch markets page {page}",
                    page=page,
                    cursor=cursor,
                    error=str(e)
                )
                raise
            
            # Parse markets from response
            markets_data = response.get('markets', [])
            
            if not markets_data:
                self.logger.info(
                    "No more markets to fetch",
                    page=page
                )
                break
            
            # Yield markets with their page capture time
            for market_dict in markets_data:
                try:
                    # SAFETY CHECK: MVEs should already be filtered by API, but verify
                    # This catches any issues with the API filter
                    if market_dict.get('mve_selected_legs') or market_dict.get('multivariate_event_ticker'):
                        self.logger.warning(
                            "Multivariate market bypassed API filter - this should not happen!",
                            ticker=market_dict.get('ticker', 'unknown'),
                            has_mve_legs=bool(market_dict.get('mve_selected_legs')),
                            has_mve_ticker=bool(market_dict.get('multivariate_event_ticker'))
                        )
                        continue
                    
                    market = KalshiMarketResponse(**market_dict)
                    yield (market, page_capture_time)
                except Exception as e:
                    self.logger.warning(
                        "Failed to parse market data",
                        market_ticker=market_dict.get('ticker', 'unknown'),
                        error=str(e)
                    )
            
            self.logger.info(
                f"Fetched page {page} of markets",
                page=page,
                markets_in_page=len(markets_data),
                capture_time=page_capture_time.isoformat()
            )
            
            # Check for next page cursor
            cursor = response.get('cursor')
            if not cursor:
                self.logger.info(
                    "Reached end of market pagination",
                    total_pages=page
                )
                break
    
    @retry_with_backoff(
        max_attempts=3,
        exceptions=(KalshiAPIError,)
    )
    def get_event(self, event_ticker: str) -> Dict[str, Any]:
        """Fetch event details by ticker.
        
        Args:
            event_ticker: Unique event identifier
            
        Returns:
            Event data as dictionary
            
        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.debug(
            "Fetching event details",
            event_ticker=event_ticker
        )
        
        response = self._make_request(
            method='GET',
            path=f'/trade-api/v2/events/{event_ticker}'
        )
        
        return response.get('event', {})
    
    @retry_with_backoff(
        max_attempts=3,
        exceptions=(KalshiAPIError,)
    )
    def get_series(self, series_ticker: str) -> Dict[str, Any]:
        """Fetch series details by ticker.
        
        Args:
            series_ticker: Unique series identifier
            
        Returns:
            Series data as dictionary
            
        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.debug(
            "Fetching series details",
            series_ticker=series_ticker
        )
        
        response = self._make_request(
            method='GET',
            path=f'/trade-api/v2/series/{series_ticker}'
        )
        
        return response.get('series', {})
    
    def get_exchange_status(self) -> Dict[str, Any]:
        """Get the current exchange status (no authentication required).
        
        This endpoint does not require authentication and can be called without
        consuming rate limiter tokens.
        
        Returns:
            Dictionary with exchange status including:
                - exchange_active (bool): False if core exchange is under maintenance
                - trading_active (bool): True if trading is currently permitted
                - exchange_estimated_resume_time (str|null): Estimated downtime end
            
        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.debug("Fetching exchange status (unauthenticated)")
        
        url = f"{self.base_url}/trade-api/v2/exchange/status"
        
        try:
            response = self.session.get(url, timeout=10)
            
            if not response.ok:
                raise KalshiAPIError(
                    f"Failed to get exchange status: {response.status_code} - {response.text}"
                )
            
            return response.json()
            
        except requests.exceptions.RequestException as e:
            self.logger.error(
                "Failed to get exchange status",
                error=str(e)
            )
            raise KalshiAPIError(f"Exchange status request failed: {e}") from e
    
    def get_rate_limiter_stats(self) -> dict:
        """Get statistics from both GET and POST rate limiters.
        
        Returns:
            Dictionary with rate limiter statistics for GET and POST operations
        """
        read_stats = {'invocations': 0, 'total_wait_time_ms': 0.0}
        post_stats = {'invocations': 0, 'total_wait_time_ms': 0.0}
        
        if hasattr(self.rate_limiter, 'get_stats'):
            read_stats = self.rate_limiter.get_stats()
        
        if hasattr(self.post_rate_limiter, 'get_stats'):
            post_stats = self.post_rate_limiter.get_stats()
        
        return {
            'get': read_stats,
            'post': post_stats,
            'total_invocations': read_stats['invocations'] + post_stats['invocations'],
            'total_wait_time_ms': read_stats.get('total_wait_time_ms', 0.0) + post_stats.get('total_wait_time_ms', 0.0)
        }
    
    # Write operation methods
    
    def create_order(
        self,
        ticker: str,
        action: str,
        side: str,
        count: int,
        order_type: str = "market",
        yes_price: Optional[int] = None,
        no_price: Optional[int] = None,
        expiration_ts: Optional[int] = None
    ) -> Dict[str, Any]:
        """Create a single order.
        
        Args:
            ticker: Market ticker symbol
            action: "buy" or "sell"
            side: "yes" or "no"
            count: Number of contracts
            order_type: "market" or "limit" (default: "market")
            yes_price: Limit price for yes side (cents, required for limit orders)
            no_price: Limit price for no side (cents, required for limit orders)
            expiration_ts: Order expiration timestamp (optional)
            
        Returns:
            API response with order details
            
        Raises:
            KalshiAPIError: If API request fails
        """
        order_data = {
            "ticker": ticker,
            "action": action,
            "side": side,
            "count": count,
            "type": order_type
        }
        
        if yes_price is not None:
            order_data["yes_price"] = yes_price
        if no_price is not None:
            order_data["no_price"] = no_price
        if expiration_ts is not None:
            order_data["expiration_ts"] = expiration_ts
        
        self.logger.info(
            "Creating order",
            ticker=ticker,
            action=action,
            side=side,
            count=count,
            order_type=order_type
        )
        
        return self._make_request(
            method='POST',
            path='/trade-api/v2/portfolio/orders',
            json_data=order_data,
            tokens=1
        )
    
    def batch_create_orders(self, orders: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Create multiple orders in a single batch.
        
        Args:
            orders: List of order dictionaries, each containing:
                - ticker: Market ticker symbol
                - action: "buy" or "sell"
                - side: "yes" or "no"
                - count: Number of contracts
                - type: "market" or "limit"
                - yes_price: Optional limit price (cents)
                - no_price: Optional limit price (cents)
                
        Returns:
            API response with batch order results
            
        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.info(
            "Creating batch orders",
            order_count=len(orders)
        )
        
        return self._make_request(
            method='POST',
            path='/trade-api/v2/portfolio/orders/batches',
            json_data={'orders': orders},
            tokens=len(orders)  # Consume tokens equal to number of orders
        )
    
    def cancel_order(self, order_id: str) -> Dict[str, Any]:
        """Cancel a single order.
        
        Args:
            order_id: Order ID to cancel
            
        Returns:
            API response with cancellation details
            
        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.info(
            "Cancelling order",
            order_id=order_id
        )
        
        return self._make_request(
            method='DELETE',
            path=f'/trade-api/v2/portfolio/orders/{order_id}',
            tokens=1
        )
    
    def batch_cancel_orders(self, order_ids: List[str]) -> Dict[str, Any]:
        """Cancel multiple orders in a single batch.
        
        Args:
            order_ids: List of order IDs to cancel
            
        Returns:
            API response with batch cancellation results
            
        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.info(
            "Cancelling batch orders",
            order_count=len(order_ids)
        )
        
        return self._make_request(
            method='DELETE',
            path='/trade-api/v2/portfolio/orders',
            json_data={'order_ids': order_ids},
            tokens=len(order_ids)  # Consume tokens equal to number of orders
        )
    
    def amend_order(
        self,
        order_id: str,
        action: Optional[str] = None,
        side: Optional[str] = None,
        count: Optional[int] = None,
        yes_price: Optional[int] = None,
        no_price: Optional[int] = None
    ) -> Dict[str, Any]:
        """Amend an existing order.
        
        Args:
            order_id: Order ID to amend
            action: New action ("buy" or "sell")
            side: New side ("yes" or "no")
            count: New contract count
            yes_price: New yes price (cents)
            no_price: New no price (cents)
            
        Returns:
            API response with amended order details
            
        Raises:
            KalshiAPIError: If API request fails
        """
        amend_data = {}
        if action is not None:
            amend_data['action'] = action
        if side is not None:
            amend_data['side'] = side
        if count is not None:
            amend_data['count'] = count
        if yes_price is not None:
            amend_data['yes_price'] = yes_price
        if no_price is not None:
            amend_data['no_price'] = no_price
        
        self.logger.info(
            "Amending order",
            order_id=order_id,
            changes=amend_data
        )
        
        return self._make_request(
            method='POST',
            path=f'/trade-api/v2/portfolio/orders/{order_id}/amend',
            json_data=amend_data,
            tokens=1
        )
    
    def decrease_order(self, order_id: str, count: int) -> Dict[str, Any]:
        """Decrease the count of an existing order.
        
        Args:
            order_id: Order ID to decrease
            count: New (lower) contract count
            
        Returns:
            API response with decreased order details
            
        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.info(
            "Decreasing order",
            order_id=order_id,
            new_count=count
        )
        
        return self._make_request(
            method='POST',
            path=f'/trade-api/v2/portfolio/orders/{order_id}/decrease',
            json_data={'count': count},
            tokens=1
        )
    
    def close(self) -> None:
        """Close HTTP session and cleanup resources."""
        if self.session:
            self.session.close()
            self.logger.debug("Kalshi API client session closed")
