"""Kalshi Trading Client with orderbook and order execution capabilities.

This module extends the KalshiClient to provide trading functionality including
reading orderbooks, placing orders, and confirming fills via WebSocket.
"""

import asyncio
import base64
import json
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

import websockets
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from kalshi_client import KalshiClient, KalshiAPIError, KalshiBusinessError
from models import (
    Orderbook, OrderbookLevel, OrderRequest, OrderResponse,
    Fill, TradeResult, TradeIdea, TradeLog, FillLog
)
from utils import StructuredLogger


class PartialFillTimeout(asyncio.TimeoutError):
    """Exception raised when a limit order times out with partial fills.
    
    Attributes:
        fills: List of fills received before timeout
        message: Error message
    """
    def __init__(self, message: str, fills: List[Fill]):
        super().__init__(message)
        self.fills = fills


class KalshiTradingClient(KalshiClient):
    """Extended Kalshi client with trading capabilities.

    This client adds orderbook reading, order placement, and WebSocket
    fill confirmation on top of the base KalshiClient functionality.
    """

    def __init__(
        self,
        base_url: str,
        api_key_id: str,
        private_key_pem: str,
        logger: Optional[StructuredLogger] = None,
        read_requests_per_second: int = 20,
        post_requests_per_second: int = 10,
        rate_limiter_table_name: Optional[str] = None,
        market_metadata_table_name: Optional[str] = None,
        exit_liquidity_threshold: float = 0.5,
        open_interest_limit_pct: float = 0.01
    ):
        """Initialize trading client.

        Args:
            base_url: Base URL for Kalshi API
            api_key_id: Kalshi API key ID
            private_key_pem: RSA private key in PEM format
            logger: Optional structured logger instance
            read_requests_per_second: Maximum API read requests per second
            post_requests_per_second: Maximum API POST requests per second
            rate_limiter_table_name: DynamoDB table name for rate limiting
            market_metadata_table_name: DynamoDB table name for market metadata
            exit_liquidity_threshold: Minimum exit liquidity ratio (default: 0.5 = 50%)
            open_interest_limit_pct: Maximum trade size as % of open interest (default: 0.01 = 1%)
        """
        super().__init__(
            base_url=base_url,
            api_key_id=api_key_id,
            private_key_pem=private_key_pem,
            logger=logger,
            requests_per_second=read_requests_per_second,
            write_requests_per_second=post_requests_per_second,
            rate_limiter_table_name=rate_limiter_table_name
        )

        # Store safety parameters
        self.market_metadata_table_name = market_metadata_table_name
        self.exit_liquidity_threshold = exit_liquidity_threshold
        self.open_interest_limit_pct = open_interest_limit_pct

        # Derive WebSocket URL from base URL
        ws_protocol = "wss" if "https" in base_url else "ws"
        ws_host = base_url.replace("https://", "").replace("http://", "")
        self.ws_url = f"{ws_protocol}://{ws_host}/trade-api/ws/v2"

        self.logger.info("Trading client initialized", ws_url=self.ws_url)

    def get_orderbook(self, ticker: str, depth: int = 0) -> Orderbook:
        """Fetch the orderbook for a market.

        Args:
            ticker: Market ticker
            depth: Orderbook depth (0 = all levels, 1-100 for specific depth)

        Returns:
            Orderbook object with yes and no bids

        Raises:
            KalshiAPIError: If API request fails
        """
        self.logger.info("Fetching orderbook", ticker=ticker, depth=depth)

        params = {}
        if depth > 0:
            params['depth'] = depth

        response = self._make_request(
            method='GET',
            path=f'/trade-api/v2/markets/{ticker}/orderbook',
            params=params
        )

        orderbook_data = response.get('orderbook', {})

        # Parse yes bids (prices are in cents, convert to dollars)
        # Handle null/None for empty orderbooks
        yes_bids = []
        yes_data = orderbook_data.get('yes')
        if yes_data:
            for price_cents, quantity in yes_data:
                # Handle both integer cents and string formats
                if isinstance(price_cents, str):
                    price = float(price_cents) if '.' in price_cents else float(price_cents) / 100.0
                else:
                    price = price_cents / 100.0
                yes_bids.append(OrderbookLevel(
                    price=price,
                    quantity=quantity
                ))
            # Sort bids by price descending (best bids first)
            yes_bids.sort(key=lambda x: x.price, reverse=True)

        # Parse no bids (prices are in cents, convert to dollars)
        # Handle null/None for empty orderbooks
        no_bids = []
        no_data = orderbook_data.get('no')
        if no_data:
            for price_cents, quantity in no_data:
                # Handle both integer cents and string formats
                if isinstance(price_cents, str):
                    price = float(price_cents) if '.' in price_cents else float(price_cents) / 100.0
                else:
                    price = price_cents / 100.0
                no_bids.append(OrderbookLevel(
                    price=price,
                    quantity=quantity
                ))
            # Sort bids by price descending (best bids first)
            no_bids.sort(key=lambda x: x.price, reverse=True)

        orderbook = Orderbook(yes_bids=yes_bids, no_bids=no_bids)

        self.logger.info(
            "Orderbook fetched",
            ticker=ticker,
            yes_levels=len(yes_bids),
            no_levels=len(no_bids),
            best_yes_bid=orderbook.get_best_yes_bid().price if orderbook.get_best_yes_bid() else None,
            best_no_bid=orderbook.get_best_no_bid().price if orderbook.get_best_no_bid() else None
        )

        return orderbook

    def get_open_interest(self, ticker: str) -> Optional[int]:
        """Get open interest for a market from DynamoDB metadata.

        Args:
            ticker: Market ticker

        Returns:
            Open interest (number of contracts) or None if not found
        """
        if not self.market_metadata_table_name:
            self.logger.warning(
                "Market metadata table not configured - cannot check open interest",
                ticker=ticker
            )
            return None

        try:
            import boto3
            dynamodb = boto3.resource('dynamodb')
            table = dynamodb.Table(self.market_metadata_table_name)

            response = table.get_item(Key={'market_ticker': ticker})

            if 'Item' not in response:
                self.logger.warning(
                    "Market not found in metadata table",
                    ticker=ticker,
                    table=self.market_metadata_table_name
                )
                return None

            open_interest = response['Item'].get('open_interest')

            if open_interest is not None:
                # Convert Decimal to int if needed
                from decimal import Decimal
                if isinstance(open_interest, Decimal):
                    open_interest = int(open_interest)

                self.logger.info(
                    "Retrieved open interest",
                    ticker=ticker,
                    open_interest=open_interest
                )

            return open_interest

        except Exception as e:
            self.logger.error(
                "Failed to get open interest from DynamoDB",
                ticker=ticker,
                error=str(e),
                error_type=type(e).__name__
            )
            return None

    def calculate_exit_liquidity(
        self,
        side: str,
        price: float,
        contracts: int,
        orderbook: Orderbook
    ) -> Dict[str, Any]:
        """Calculate available exit liquidity on opposite side of orderbook.

        Args:
            side: Side being bought ('yes' or 'no')
            price: Price being paid per contract
            contracts: Number of contracts to buy
            orderbook: Current orderbook

        Returns:
            Dictionary with 'exit_value', 'trade_value', 'exit_ratio', 'sufficient'
        """
        trade_value = contracts * price

        # If buying YES, we exit by selling YES back to YES buyers (YES bids)
        # If buying NO, we exit by selling NO back to NO buyers (NO bids)
        # So we check the SAME side's bid orderbook for exit liquidity
        if side.lower() == 'yes':
            exit_bids = orderbook.yes_bids
        else:
            exit_bids = orderbook.no_bids

        # Calculate total value available in opposite side up to our contract count
        exit_value = 0.0
        contracts_covered = 0

        self.logger.info(
            "Calculating exit liquidity from orderbook",
            side=side,
            target_contracts=contracts,
            orderbook_levels=len(exit_bids),
            exit_bids=[(b.price, b.quantity) for b in exit_bids]
        )

        for level in exit_bids:
            if contracts_covered >= contracts:
                break

            # Take as many contracts as we need from this level
            contracts_from_level = min(level.quantity, contracts - contracts_covered)
            exit_value += contracts_from_level * level.price
            contracts_covered += contracts_from_level

        exit_ratio = exit_value / trade_value if trade_value > 0 else 0.0

        result = {
            'exit_value': exit_value,
            'trade_value': trade_value,
            'exit_ratio': exit_ratio,
            'contracts_covered': contracts_covered,
            'sufficient': exit_ratio >= self.exit_liquidity_threshold
        }

        self.logger.info(
            "Exit liquidity calculated",
            side=side,
            contracts=contracts,
            trade_value=trade_value,
            exit_value=exit_value,
            exit_ratio=exit_ratio,
            threshold=self.exit_liquidity_threshold,
            sufficient=result['sufficient']
        )

        return result

    def calculate_order_parameters(
        self,
        ticker: str,
        side: str,
        max_dollar_amount: float,
        max_price: float,
        orderbook: Optional[Orderbook] = None,
        order_type: str = 'market',
        use_bid: bool = False
    ) -> Dict[str, Any]:
        """Calculate order parameters based on constraints, orderbook, and safety checks.

        Applies up to 4 limits to determine final trade size:
        1. Available contracts at max_price (only for market orders with use_bid=False)
        2. Budget constraint (max_dollar_amount)
        3. Exit liquidity (exit_liquidity_threshold of opposite side orderbook)
        4. Open interest limit (open_interest_limit_pct of total OI)

        Args:
            ticker: Market ticker
            side: 'yes' or 'no'
            max_dollar_amount: Maximum dollars to spend
            max_price: Maximum price willing to pay per contract (0-1.0)
            orderbook: Optional pre-fetched orderbook (will fetch if not provided)
            order_type: 'market' (take liquidity) or 'limit' (post liquidity)
            use_bid: Whether this is a bid-based market maker strategy (True) or ask-based taker (False)

        Returns:
            Dictionary with 'count', 'price', 'available_contracts', 'total_cost',
            'limit_applied', 'reduction_reason' keys

        Raises:
            ValueError: If no contracts available at acceptable price or safety checks fail
        """
        if orderbook is None:
            orderbook = self.get_orderbook(ticker)

        # For bid-based market maker strategy (use_bid=True), we're posting limit orders
        # For ask-based taker strategy (use_bid=False), we're taking existing liquidity
        if use_bid:
            # Bid-based market maker: we're creating a new bid in the orderbook
            # We don't need existing bids/asks - we're filling a gap
            ask_price = max_price  # Use our limit price
            
            # For bid-based strategies, we're not constrained by existing liquidity
            # Set to a large number - will be limited by budget, exit liquidity, and OI
            total_available_quantity = 999999
            
        elif order_type == 'limit':
            # Limit order in ask-based strategy: we still need to check orderbook
            # to ensure there's existing market activity
            if side.lower() == 'yes':
                best_bid = orderbook.get_best_yes_bid()
                if best_bid is None:
                    raise ValueError(f"No {side.upper()} bids in orderbook - market may not be active")
                ask_price = max_price  # Use our limit price
            else:
                best_bid = orderbook.get_best_no_bid()
                if best_bid is None:
                    raise ValueError(f"No {side.upper()} bids in orderbook - market may not be active")
                ask_price = max_price  # Use our limit price
            
            # For limit orders, we're not constrained by ask size
            # Set to a large number - will be limited by budget, exit liquidity, and OI
            total_available_quantity = 999999
            
        else:
            # Market order: we're taking liquidity from asks
            # Get the ask price for the side we want to buy
            if side.lower() == 'yes':
                best_ask = orderbook.get_best_yes_ask()
                # Get YES asks (derived from NO bids)
                ask_levels = [(1.0 - level.price, level.quantity) for level in orderbook.no_bids]
            else:
                best_ask = orderbook.get_best_no_ask()
                # Get NO asks (derived from YES bids)
                ask_levels = [(1.0 - level.price, level.quantity) for level in orderbook.yes_bids]

            if best_ask is None:
                raise ValueError(f"No {side.upper()} contracts available in orderbook")

            ask_price = best_ask.price
            
            # Calculate total available quantity across ALL levels up to max_price
            total_available_quantity = 0
            for level_price, level_quantity in ask_levels:
                if level_price <= max_price:
                    total_available_quantity += level_quantity

        self.logger.info(
            "Calculating order parameters",
            ticker=ticker,
            side=side,
            best_ask_price=ask_price,
            total_available_quantity=total_available_quantity,
            max_price=max_price,
            max_dollar_amount=max_dollar_amount
        )

        # Check if price is acceptable
        if ask_price > max_price:
            raise ValueError(
                f"Best {side.upper()} ask price {ask_price:.4f} exceeds "
                f"maximum price {max_price:.4f}"
            )

        # LIMIT 1: Available contracts up to max_price
        limit_1_contracts = total_available_quantity
        limit_applied = "orderbook_liquidity"

        # LIMIT 2: Budget constraint (using best ask price for conservative estimate)
        limit_2_contracts = int(max_dollar_amount / ask_price)
        if limit_2_contracts < limit_1_contracts:
            limit_1_contracts = limit_2_contracts
            limit_applied = "budget"

        # Start with the smaller of orderbook availability and budget
        contracts_to_buy = limit_1_contracts

        if contracts_to_buy == 0:
            raise ValueError(
                f"Cannot afford any contracts at price {ask_price:.4f} "
                f"with budget ${max_dollar_amount:.2f}"
            )

        reduction_reasons = []

        # LIMIT 3: Exit liquidity check
        exit_liq = self.calculate_exit_liquidity(
            side=side,
            price=ask_price,
            contracts=contracts_to_buy,
            orderbook=orderbook
        )

        if not exit_liq['sufficient']:
            # Reduce contract count to meet exit liquidity requirement
            # We need: exit_value >= threshold * trade_value
            # exit_value = sum of opposite side values
            # trade_value = contracts * price
            # We need to find max contracts where exit liquidity is sufficient

            # Binary search for maximum contracts with sufficient exit liquidity
            low, high = 1, contracts_to_buy
            max_safe_contracts = 0

            while low <= high:
                mid = (low + high) // 2
                test_liq = self.calculate_exit_liquidity(
                    side=side,
                    price=ask_price,
                    contracts=mid,
                    orderbook=orderbook
                )

                if test_liq['sufficient']:
                    max_safe_contracts = mid
                    low = mid + 1
                else:
                    high = mid - 1

            if max_safe_contracts == 0:
                raise ValueError(
                    f"Insufficient exit liquidity: need {self.exit_liquidity_threshold*100}% "
                    f"of trade value available on opposite side orderbook"
                )

            if max_safe_contracts < contracts_to_buy:
                reduction_reasons.append(
                    f"exit_liquidity: reduced from {contracts_to_buy} to {max_safe_contracts} "
                    f"contracts to maintain {self.exit_liquidity_threshold*100}% exit liquidity"
                )
                contracts_to_buy = max_safe_contracts
                limit_applied = "exit_liquidity"

        # LIMIT 4: Open interest limit
        open_interest = self.get_open_interest(ticker)

        if open_interest is not None and open_interest > 0:
            max_oi_contracts = int(open_interest * self.open_interest_limit_pct)

            if max_oi_contracts < contracts_to_buy:
                reduction_reasons.append(
                    f"open_interest: reduced from {contracts_to_buy} to {max_oi_contracts} "
                    f"contracts (limit: {self.open_interest_limit_pct*100}% of OI={open_interest})"
                )
                contracts_to_buy = max_oi_contracts
                limit_applied = "open_interest"

            if contracts_to_buy == 0:
                raise ValueError(
                    f"Trade size too small: {self.open_interest_limit_pct*100}% of "
                    f"open interest ({open_interest}) = 0 contracts"
                )

            self.logger.info(
                "Open interest check",
                ticker=ticker,
                open_interest=open_interest,
                oi_limit_pct=self.open_interest_limit_pct,
                max_oi_contracts=max_oi_contracts,
                final_contracts=contracts_to_buy
            )

        # Log any reductions
        if reduction_reasons:
            self.logger.warning(
                "Trade size reduced due to safety limits",
                ticker=ticker,
                side=side,
                original_budget_contracts=limit_2_contracts,
                final_contracts=contracts_to_buy,
                reductions=reduction_reasons
            )

        # SITE-WIDE MINIMUM: Enforce 10 contract minimum
        MIN_CONTRACTS = 10
        if contracts_to_buy < MIN_CONTRACTS:
            raise ValueError(
                f"Trade size below minimum: {contracts_to_buy} contracts "
                f"(minimum required: {MIN_CONTRACTS})"
            )

        result = {
            'count': contracts_to_buy,
            'price': max_price,  # Use max_price for the limit order
            'available_contracts': total_available_quantity,
            'total_cost': contracts_to_buy * max_price,  # Conservative estimate using max_price
            'limit_applied': limit_applied,
            'reduction_reasons': reduction_reasons
        }

        self.logger.info(
            "Order parameters calculated",
            ticker=ticker,
            **result
        )

        return result

    def _make_request_with_body(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        timeout: int = 10
    ) -> Dict[str, Any]:
        """Make authenticated request with JSON body to Kalshi API.

        This is a specialized version for POST requests with body.

        Args:
            method: HTTP method (POST, PUT, etc.)
            path: API endpoint path (without base URL)
            body: Request body as dictionary
            timeout: Request timeout in seconds

        Returns:
            JSON response as dictionary

        Raises:
            KalshiAPIError: For API errors
        """
        import time
        import requests

        # Apply rate limiting
        self.rate_limiter.acquire()

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
                json=body,
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
                raise KalshiAPIError(
                    f"Authentication failed: {response.status_code} - {response.text}"
                )

            # Handle rate limiting
            if response.status_code == 429:
                raise KalshiAPIError(
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

    def create_order(self, order_request: OrderRequest) -> OrderResponse:
        """Create an order on Kalshi.

        Args:
            order_request: Order request details

        Returns:
            OrderResponse with order details

        Raises:
            KalshiAPIError: If order creation fails
        """
        self.logger.info(
            "Creating order",
            ticker=order_request.ticker,
            side=order_request.side,
            action=order_request.action,
            count=order_request.count,
            type=order_request.type
        )

        # Build request body
        body = {
            'ticker': order_request.ticker,
            'side': order_request.side,
            'action': order_request.action,
            'count': order_request.count,
            'type': order_request.type
        }

        if order_request.client_order_id:
            body['client_order_id'] = order_request.client_order_id

        if order_request.yes_price is not None:
            body['yes_price'] = order_request.yes_price

        if order_request.no_price is not None:
            body['no_price'] = order_request.no_price

        body['time_in_force'] = order_request.time_in_force
        
        if order_request.expiration_ts is not None:
            body['expiration_ts'] = order_request.expiration_ts
        
        body['self_trade_prevention_type'] = order_request.self_trade_prevention_type
        body['cancel_order_on_pause'] = order_request.cancel_order_on_pause

        self.logger.info("Sending order request to Kalshi API", body=body)

        # Make API request with body
        response = self._make_request_with_body(
            method='POST',
            path='/trade-api/v2/portfolio/orders',
            body=body
        )

        order_data = response.get('order', {})

        # Parse response into OrderResponse
        # Handle both integer cents and string dollar formats
        yes_price = None
        if order_data.get('yes_price') is not None:
            yes_val = order_data.get('yes_price')
            if isinstance(yes_val, (int, float)):
                yes_price = yes_val / 100.0
            else:
                yes_price = float(yes_val) / 100.0
        elif order_data.get('yes_price_dollars'):
            yes_price = float(order_data.get('yes_price_dollars'))
            
        no_price = None
        if order_data.get('no_price') is not None:
            no_val = order_data.get('no_price')
            if isinstance(no_val, (int, float)):
                no_price = no_val / 100.0
            else:
                no_price = float(no_val) / 100.0
        elif order_data.get('no_price_dollars'):
            no_price = float(order_data.get('no_price_dollars'))

        order_response = OrderResponse(
            order_id=order_data.get('order_id', ''),
            client_order_id=order_data.get('client_order_id'),
            status=order_data.get('status', ''),
            yes_price=yes_price,
            no_price=no_price,
            created_time=self._parse_timestamp_ms(order_data.get('created_time')),
            remaining_count=order_data.get('remaining_count'),
            fill_count=order_data.get('fill_count')
        )

        self.logger.info(
            "Order created",
            order_id=order_response.order_id,
            status=order_response.status,
            fill_count=order_response.fill_count,
            remaining_count=order_response.remaining_count
        )

        return order_response

    def _parse_timestamp_ms(self, ts_ms: Optional[int]) -> Optional[datetime]:
        """Parse millisecond timestamp to datetime."""
        if ts_ms is None:
            return None
        # Handle both integer milliseconds and ISO string formats
        if isinstance(ts_ms, str):
            # It's an ISO datetime string
            return datetime.fromisoformat(ts_ms.replace('Z', '+00:00'))
        # It's an integer in milliseconds
        return datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)

    def _generate_ws_auth_headers(self) -> Dict[str, str]:
        """Generate WebSocket authentication headers.

        Returns:
            Dictionary with authentication headers
        """
        timestamp = str(int(datetime.now(tz=timezone.utc).timestamp() * 1000))
        msg_string = f"{timestamp}GET/trade-api/ws/v2"

        signature = self.private_key.sign(
            msg_string.encode('utf-8'),
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH
            ),
            hashes.SHA256()
        )

        signature_b64 = base64.b64encode(signature).decode('utf-8')

        return {
            'KALSHI-ACCESS-KEY': self.api_key_id,
            'KALSHI-ACCESS-SIGNATURE': signature_b64,
            'KALSHI-ACCESS-TIMESTAMP': timestamp
        }

    async def listen_for_fills(
        self,
        order_id: str,
        timeout: float = 30.0
    ) -> tuple[List[Fill], str | None]:
        """Listen for fills on WebSocket for a specific order.

        Args:
            order_id: Order ID to wait for fills
            timeout: Timeout in seconds

        Returns:
            Tuple of (list of fills received, final order status if received)

        Raises:
            asyncio.TimeoutError: If timeout is exceeded
            KalshiAPIError: If WebSocket connection fails
        """
        self.logger.info(
            "Connecting to WebSocket for fills",
            order_id=order_id,
            timeout=timeout
        )

        fills = []
        final_order_status = None
        auth_headers = self._generate_ws_auth_headers()

        try:
            async with websockets.connect(
                self.ws_url,
                additional_headers=auth_headers
            ) as websocket:
                self.logger.debug("WebSocket connected")

                # Subscribe to both fill and order channels
                # Fill channel: get fill notifications
                # Order channel: get order updates (cancellations, expirations, etc.)
                subscribe_msg = {
                    'id': 1,
                    'cmd': 'subscribe',
                    'params': {
                        'channels': ['fill', 'order']
                    }
                }

                await websocket.send(json.dumps(subscribe_msg))
                self.logger.debug("Subscribed to fill and order channels")

                # Listen for messages with timeout
                start_time = asyncio.get_event_loop().time()

                while True:
                    remaining_time = timeout - (asyncio.get_event_loop().time() - start_time)

                    if remaining_time <= 0:
                        # Our internal timeout exceeded - this means we didn't receive
                        # order cancellation/expiration from Kalshi within expected time
                        # This is unusual but not necessarily an error
                        self.logger.info(
                            "Internal timeout exceeded waiting for order completion",
                            order_id=order_id,
                            fills_received=len(fills),
                            timeout=timeout
                        )
                        # Raise exception with any fills received so far
                        raise PartialFillTimeout(
                            f"Timeout waiting for order completion for {order_id}",
                            fills=fills
                        )

                    try:
                        message = await asyncio.wait_for(
                            websocket.recv(),
                            timeout=remaining_time
                        )

                        data = json.loads(message)

                        # Check if this is an error message
                        if data.get('type') == 'error':
                            error_msg = data.get('msg', {})
                            self.logger.error(
                                "WebSocket error",
                                error_code=error_msg.get('code'),
                                error_message=error_msg.get('msg')
                            )
                            continue

                        # Check if this is a message with data
                        if 'msg' in data and isinstance(data['msg'], dict):
                            msg_data = data['msg']
                            
                            # Check if this is for our order
                            if msg_data.get('order_id') != order_id:
                                continue
                            
                            # Check if this is an order status update
                            if 'status' in msg_data:
                                order_status = msg_data.get('status')
                                
                                # Handle order cancellations/expirations
                                if order_status in ['canceled', 'expired']:
                                    final_order_status = order_status
                                    self.logger.info(
                                        "Order cancelled/expired by exchange",
                                        order_id=order_id,
                                        status=order_status,
                                        fills_received=len(fills)
                                    )
                                    # Exit the loop - order is done
                                    break
                                
                                # Handle order execution completion
                                if order_status == 'executed':
                                    final_order_status = order_status
                                    self.logger.info(
                                        "Order fully executed",
                                        order_id=order_id,
                                        fills_received=len(fills)
                                    )
                                    # Exit the loop - order is fully filled
                                    break
                            
                            # Check if this is a fill message (has trade_id field)
                            if 'trade_id' in msg_data:
                                # Parse price using dollar fields (subpenny precision)
                                # Kalshi only sends yes_price_dollars for all fills
                                # For NO-side trades, we calculate price as (1.0 - yes_price)
                                side = msg_data.get('side', '')
                                
                                if 'yes_price_dollars' in msg_data:
                                    yes_price = float(msg_data['yes_price_dollars'])
                                    # For NO side: price = 1.0 - yes_price
                                    # For YES side: price = yes_price
                                    price = (1.0 - yes_price) if side == 'no' else yes_price
                                else:
                                    # Fallback to old cent-based fields
                                    price_val = msg_data.get('yes_price') or msg_data.get('no_price', 0)
                                    if isinstance(price_val, str):
                                        price = float(price_val) if '.' in str(price_val) else float(price_val) / 100.0
                                    else:
                                        price = price_val / 100.0 if price_val else 0
                                
                                fill = Fill(
                                    order_id=msg_data.get('order_id', ''),
                                    fill_id=msg_data.get('trade_id', ''),
                                    ticker=msg_data.get('ticker', ''),
                                    side=side,
                                    action=msg_data.get('action', ''),
                                    count=msg_data.get('count', 0),
                                    price=price,
                                    created_time=self._parse_timestamp_ms(msg_data.get('created_time'))
                                )

                                fills.append(fill)

                                self.logger.info(
                                    "Fill received",
                                    order_id=order_id,
                                    fill_id=fill.fill_id,
                                    count=fill.count,
                                    price=fill.price
                                )
                                # Don't break here - there might be more fills or a status update

                    except asyncio.TimeoutError:
                        # Inner timeout - continue to check outer timeout
                        continue

        except PartialFillTimeout:
            # Re-raise with partial fills intact
            # This is expected for limit orders that timeout before being filled/cancelled by exchange
            raise

        except Exception as e:
            # Unexpected WebSocket errors (connection issues, etc.)
            self.logger.error(
                "WebSocket connection failed",
                error=str(e),
                order_id=order_id
            )
            raise KalshiAPIError(f"WebSocket connection failed: {e}") from e

        return fills, final_order_status

    def cancel_order(self, order_id: str) -> Dict[str, Any]:
        """Cancel an open order.

        Args:
            order_id: Order ID to cancel

        Returns:
            Cancellation response from API

        Raises:
            KalshiAPIError: For API errors
        """
        self.logger.info(
            "Cancelling order",
            order_id=order_id
        )

        # Use POST rate limiter for DELETE requests
        self.post_rate_limiter.acquire()

        path = f"/trade-api/v2/portfolio/orders/{order_id}"
        
        try:
            response = self._make_request('DELETE', path)
            
            self.logger.info(
                "Order cancelled successfully",
                order_id=order_id
            )
            
            return response
        except Exception as e:
            self.logger.error(
                "Failed to cancel order",
                order_id=order_id,
                error=str(e)
            )
            raise

    def execute_trade(
        self,
        ticker: str,
        side: str,
        max_dollar_amount: float,
        max_price: float,
        idea: TradeIdea,
        trade_id: str,
        userid: str,
        wait_for_fill: bool = True,
        fill_timeout: float = 30.0,
        order_expiration_seconds: Optional[int] = None,
        use_bid: bool = False
    ) -> TradeResult:
        """Execute a complete trade including orderbook analysis, order placement, and fill confirmation.

        Args:
            ticker: Market ticker to trade
            side: 'yes' or 'no'
            max_dollar_amount: Maximum dollars to spend
            max_price: Maximum price per contract (0-1.0)
            idea: Trading idea that generated this trade
            trade_id: Unique identifier for this trade execution
            userid: User identifier for multi-user trading
            wait_for_fill: Whether to wait for fill confirmation via WebSocket
            fill_timeout: Timeout for waiting for fills (seconds)
            order_expiration_seconds: Seconds from now when order expires (optional)
            use_bid: Whether to use bid-based pricing (market maker) or ask-based (taker)

        Returns:
            TradeResult with execution details and comprehensive logging
        """
        # Initialize trade log
        trade_log = TradeLog(
            trade_id=trade_id,
            userid=userid,
            idea=idea,
            ticker=ticker,
            side=side,
            action='buy',
            max_dollar_amount=max_dollar_amount,
            max_price=max_price,
            success=False
        )

        self.logger.info(
            "Executing trade",
            **trade_log.to_log_dict(),
            wait_for_fill=wait_for_fill,
            fill_timeout=fill_timeout
        )

        try:
            # Step 1: Fetch orderbook (uses read rate limiter)
            orderbook_fetch_time = datetime.now(timezone.utc)
            self.logger.info(
                "Fetching orderbook",
                trade_id=trade_id,
                idea_id=idea.idea_id,
                ticker=ticker
            )
            orderbook = self.get_orderbook(ticker)
            trade_log.orderbook_snapshot = orderbook
            trade_log.orderbook_fetch_time = orderbook_fetch_time

            self.logger.info(
                "Orderbook fetched",
                trade_id=trade_id,
                idea_id=idea.idea_id,
                ticker=ticker,
                yes_levels=len(orderbook.yes_bids),
                no_levels=len(orderbook.no_bids),
                best_yes_bid=orderbook.get_best_yes_bid().price if orderbook.get_best_yes_bid() else None,
                best_no_bid=orderbook.get_best_no_bid().price if orderbook.get_best_no_bid() else None,
                fetch_time=orderbook_fetch_time.isoformat()
            )

            # Step 2: Calculate order parameters
            self.logger.info(
                "Calculating order parameters",
                trade_id=trade_id,
                idea_id=idea.idea_id,
                ticker=ticker,
                side=side,
                max_dollar_amount=max_dollar_amount,
                max_price=max_price
            )

            order_params = self.calculate_order_parameters(
                ticker=ticker,
                side=side,
                max_dollar_amount=max_dollar_amount,
                max_price=max_price,
                orderbook=orderbook,
                order_type='limit',
                use_bid=use_bid
            )

            self.logger.info(
                "Order parameters calculated",
                trade_id=trade_id,
                idea_id=idea.idea_id,
                **order_params
            )

            # Step 3: Create order request
            price_cents = int(round(order_params['price'] * 100))
            
            # Calculate expiration timestamp if order_expiration_seconds provided
            expiration_ts = None
            if order_expiration_seconds is not None:
                expiration_ts = int(datetime.now(timezone.utc).timestamp() + order_expiration_seconds)

            order_request = OrderRequest(
                ticker=ticker,
                side=side,
                action='buy',
                count=order_params['count'],
                type='limit',
                yes_price=price_cents if side == 'yes' else None,
                no_price=price_cents if side == 'no' else None,
                time_in_force='good_till_canceled',
                expiration_ts=expiration_ts,
                self_trade_prevention_type='taker_at_cross',
                cancel_order_on_pause=True,
                client_order_id=trade_id  # Use trade_id directly for shorter client_order_id
            )

            # Step 4: Place order (uses write rate limiter)
            order_placement_time = datetime.now(timezone.utc)
            trade_log.order_placement_time = order_placement_time

            self.logger.info(
                "Placing order",
                trade_id=trade_id,
                idea_id=idea.idea_id,
                ticker=ticker,
                side=side,
                count=order_request.count,
                price=order_params['price'],
                placement_time=order_placement_time.isoformat()
            )

            order_response = self.create_order(order_request)
            trade_log.order = order_response

            self.logger.info(
                "Order placed successfully",
                trade_id=trade_id,
                idea_id=idea.idea_id,
                order_id=order_response.order_id,
                status=order_response.status
            )

            # Step 5: Wait for fills if requested
            fills = []
            if wait_for_fill:
                # Check if order is already fully filled (status="executed" and remaining_count=0)
                if (order_response.status == "executed" and 
                    order_response.remaining_count == 0 and 
                    order_response.fill_count is not None and 
                    order_response.fill_count > 0):
                    
                    self.logger.info(
                        "Order already fully filled in response",
                        trade_id=trade_id,
                        order_id=order_response.order_id,
                        fill_count=order_response.fill_count
                    )
                    
                    # Synthesize fill record from order response
                    # Since order filled immediately, create a single fill with the order data
                    fill_price = order_response.yes_price if side == 'yes' else order_response.no_price
                    synthesized_fill = Fill(
                        order_id=order_response.order_id,
                        fill_id=f"{order_response.order_id}-immediate",  # Synthetic fill ID
                        ticker=ticker,
                        side=side,
                        action='buy',  # execute_trade only does buys
                        count=order_response.fill_count,
                        price=fill_price,
                        created_time=order_response.created_time
                    )
                    fills = [synthesized_fill]
                    
                    self.logger.info(
                        "Synthesized fill from immediate execution",
                        fill_id=synthesized_fill.fill_id,
                        count=synthesized_fill.count,
                        price=synthesized_fill.price
                    )
                    
                elif order_response.status in ["resting", "pending"]:
                    # Order not filled yet - wait for fills via WebSocket
                    # If order has expiration, extend our timeout to be longer than expiration
                    # This allows Kalshi to auto-cancel and send us a cancellation message
                    actual_timeout = fill_timeout
                    if order_expiration_seconds is not None:
                        # Wait 5 seconds longer than the order expiration to receive cancellation message
                        actual_timeout = order_expiration_seconds + 5
                        
                    self.logger.info(
                        "Waiting for fills via WebSocket",
                        trade_id=trade_id,
                        idea_id=idea.idea_id,
                        order_id=order_response.order_id,
                        status=order_response.status,
                        timeout=actual_timeout,
                        order_expiration_seconds=order_expiration_seconds
                    )

                    try:
                        fills, final_order_status = asyncio.run(
                            self.listen_for_fills(
                                order_id=order_response.order_id,
                                timeout=actual_timeout
                            )
                        )

                        # Update order status in trade_log if we received a final status
                        if final_order_status and trade_log.order:
                            trade_log.order.status = final_order_status
                            self.logger.info(
                                "Updated order status from WebSocket",
                                order_id=order_response.order_id,
                                final_status=final_order_status
                            )

                        # Log each fill individually
                        for fill in fills:
                            fill_log = FillLog(
                                fill_id=fill.fill_id,
                                trade_id=trade_id,
                                idea_id=idea.idea_id,
                                idea_version=idea.idea_version,
                                order_id=fill.order_id,
                                ticker=fill.ticker,
                                side=fill.side,
                                action=fill.action,
                                count=fill.count,
                                price=fill.price,
                                fill_timestamp=fill.created_time
                            )

                            self.logger.info(
                                "Fill received",
                                **fill_log.to_log_dict()
                            )

                    except PartialFillTimeout as e:
                        # Our internal timeout exceeded - Kalshi should have already cancelled the order
                        # This is unusual - log at INFO since it's expected behavior, just late notification
                        fills = e.fills
                        
                        if len(fills) > 0:
                            # Partial fills received before timeout
                            self.logger.info(
                                "Order timed out with partial fills (Kalshi likely already cancelled)",
                                trade_id=trade_id,
                                idea_id=idea.idea_id,
                                order_id=order_response.order_id,
                                timeout=actual_timeout,
                                partial_fills=len(fills),
                                filled_contracts=sum(f.count for f in fills)
                            )
                            
                            # Log each fill that was received
                            for fill in fills:
                                fill_log = FillLog(
                                    fill_id=fill.fill_id,
                                    trade_id=trade_id,
                                    idea_id=idea.idea_id,
                                    idea_version=idea.idea_version,
                                    order_id=fill.order_id,
                                    ticker=fill.ticker,
                                    side=fill.side,
                                    action=fill.action,
                                    count=fill.count,
                                    price=fill.price,
                                    fill_timestamp=fill.created_time
                                )

                                self.logger.info(
                                    "Partial fill received",
                                    **fill_log.to_log_dict()
                                )
                        else:
                            # No fills before timeout - order expired unfilled (expected)
                            self.logger.info(
                                "Order timed out unfilled (expired by exchange)",
                                trade_id=trade_id,
                                idea_id=idea.idea_id,
                                order_id=order_response.order_id,
                                timeout=actual_timeout
                            )
                        
                        # No need to cancel - Kalshi's expiration_ts already handled it
                        # The order is already cancelled by the exchange

            trade_log.fills = fills

            # Step 6: Build execution summary
            total_filled = sum(f.count for f in fills)
            avg_fill_price = (
                sum(f.price * f.count for f in fills) / total_filled
                if total_filled > 0 else order_params['price']
            )

            # Calculate actual cost from fills
            actual_cost = sum(f.price * f.count for f in fills) if fills else 0.0
            
            summary_parts = [
                f"Trade executed: {side.upper()} {ticker}",
                f"Idea: {idea.idea_id} v{idea.idea_version}",
                f"Trade ID: {trade_id}",
                f"Ordered: {order_params['count']} contracts at ${order_params['price']:.4f}",
                f"Filled: {total_filled} contracts at avg ${avg_fill_price:.4f}",
                f"Actual cost: ${actual_cost:.2f}",
                f"Order ID: {order_response.order_id}"
            ]
            
            # Add partial fill warning if applicable
            if total_filled < order_params['count'] and total_filled > 0:
                summary_parts.append(f"Partial fill: {total_filled}/{order_params['count']} contracts filled before timeout")
            elif total_filled == 0:
                summary_parts.append("Limit order placed but unfilled (normal for market-making)")
            
            summary = "\n".join(summary_parts)

            # For limit orders, success=True means order was placed successfully
            # Fills are a separate concern - unfilled/partial limit orders are still successful placements
            trade_log.success = True
            trade_log.completion_time = datetime.now(timezone.utc)

            if total_filled == order_params['count']:
                self.logger.info(
                    "Trade completed - fully filled",
                    **trade_log.to_log_dict()
                )
            elif total_filled > 0:
                self.logger.info(
                    "Trade completed - partially filled",
                    **trade_log.to_log_dict(),
                    filled=total_filled,
                    ordered=order_params['count']
                )
            else:
                self.logger.info(
                    "Limit order placed but unfilled",
                    **trade_log.to_log_dict()
                )

            return TradeResult(
                success=True,
                trade_log=trade_log,
                execution_summary=summary
            )

        except KalshiBusinessError as e:
            # Expected business condition - normal operation
            error_msg = f"Trade not executed: {e.error_code}"
            trade_log.error_message = error_msg
            trade_log.success = False
            trade_log.completion_time = datetime.now(timezone.utc)

            self.logger.info(
                "Trade not executed due to business condition",
                **trade_log.to_log_dict(),
                business_condition=e.error_code,
                http_status=e.http_status
            )

            return TradeResult(
                success=False,
                trade_log=trade_log,
                execution_summary=error_msg
            )

        except ValueError as e:
            # Check if this is a normal business condition (size limits, etc)
            error_str = str(e)
            is_business_condition = any(phrase in error_str.lower() for phrase in [
                'below minimum',
                'too small',
                'cannot afford',
                'insufficient exit liquidity',
                'exceeds maximum price'
            ])
            
            error_msg = f"Trade not executed: {str(e)}"
            trade_log.error_message = error_msg
            trade_log.success = False
            trade_log.completion_time = datetime.now(timezone.utc)

            if is_business_condition:
                # Normal business condition - log as INFO
                self.logger.info(
                    "Trade not executed due to constraints",
                    **trade_log.to_log_dict(),
                    constraint=error_str
                )
            else:
                # Unexpected ValueError - log as ERROR
                self.logger.error(
                    "Trade execution failed",
                    **trade_log.to_log_dict(),
                    exception_type="ValueError",
                    exception_message=error_str
                )

            return TradeResult(
                success=False,
                trade_log=trade_log,
                execution_summary=error_msg
            )

        except Exception as e:
            error_msg = f"Trade execution failed: {str(e)}"
            trade_log.error_message = error_msg
            trade_log.success = False
            trade_log.completion_time = datetime.now(timezone.utc)

            self.logger.error(
                "Trade execution failed",
                **trade_log.to_log_dict(),
                exception_type=type(e).__name__,
                exception_message=str(e)
            )

            return TradeResult(
                success=False,
                trade_log=trade_log,
                execution_summary=error_msg
            )
