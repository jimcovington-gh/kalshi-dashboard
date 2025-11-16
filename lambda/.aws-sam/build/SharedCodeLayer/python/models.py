"""Pydantic models for Kalshi market data.

This module defines all data models used for validating and structuring
data from the Kalshi API and for writing to InfluxDB.

Price fields use dollar format (0-1.0 range) from Kalshi API *_dollars fields.
"""

from datetime import datetime, timezone
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field, field_validator, ConfigDict


class Series(BaseModel):
    """Represents a Kalshi series (collection of related events).
    
    Attributes:
        series_ticker: Unique identifier for the series
        title: Human-readable series title
        category: Category classification
        frequency: How often events occur (e.g., 'daily', 'weekly')
        tags: List of tags for categorization
        created_time: When the series was created on Kalshi
        first_seen: When this series was first captured by our system
        last_updated: When this series metadata was last updated
    """
    
    model_config = ConfigDict(str_strip_whitespace=True)
    
    series_ticker: str = Field(..., min_length=1, description="Unique series identifier")
    title: str = Field(..., min_length=1, description="Series title")
    category: str = Field(..., min_length=1, description="Category classification")
    frequency: Optional[str] = Field(None, description="Event frequency")
    tags: list[str] = Field(default_factory=list, description="Category tags")
    fee_multiplier: Optional[float] = Field(None, description="Fee multiplier for this series")
    fee_type: Optional[str] = Field(None, description="Type of fee structure")
    created_time: Optional[datetime] = Field(None, description="Creation timestamp from Kalshi")
    first_seen: datetime = Field(default_factory=datetime.utcnow, description="First capture time")
    last_updated: datetime = Field(default_factory=datetime.utcnow, description="Last update time")
    
    @field_validator('series_ticker', 'title', 'category')
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        """Ensure critical string fields are not empty after stripping."""
        if not v or not v.strip():
            raise ValueError("Field cannot be empty")
        return v


class Event(BaseModel):
    """Represents a Kalshi event (specific occurrence within a series).
    
    Attributes:
        event_ticker: Unique identifier for the event
        series_ticker: Parent series identifier
        title: Human-readable event title
        category: Category classification
        sub_title: Additional descriptive text
        mutually_exclusive: Whether markets in this event are mutually exclusive
        strike_date: Date when the event resolves (if applicable)
        created_time: When the event was created on Kalshi
        first_seen: When this event was first captured by our system
        last_updated: When this event metadata was last updated
    """
    
    model_config = ConfigDict(str_strip_whitespace=True)
    
    event_ticker: str = Field(..., min_length=1, description="Unique event identifier")
    series_ticker: str = Field(..., min_length=1, description="Parent series identifier")
    title: str = Field(..., min_length=1, description="Event title")
    category: str = Field(..., min_length=1, description="Category classification")
    sub_title: Optional[str] = Field(None, description="Event subtitle")
    mutually_exclusive: bool = Field(default=False, description="Markets mutually exclusive")
    available_on_brokers: list = Field(default_factory=list, description="List of brokers where event is available")
    strike_date: Optional[datetime] = Field(None, description="Event resolution date")
    created_time: Optional[datetime] = Field(None, description="Creation timestamp from Kalshi")
    first_seen: datetime = Field(default_factory=datetime.utcnow, description="First capture time")
    last_updated: datetime = Field(default_factory=datetime.utcnow, description="Last update time")
    
    @field_validator('available_on_brokers', mode='before')
    @classmethod
    def normalize_brokers(cls, v):
        """Normalize available_on_brokers field - API sometimes returns False instead of empty list."""
        if v is False or v is None:
            return []
        if isinstance(v, list):
            return v
        return []
    
    @field_validator('event_ticker', 'series_ticker', 'title', 'category')
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        """Ensure critical string fields are not empty after stripping."""
        if not v or not v.strip():
            raise ValueError("Field cannot be empty")
        return v


class Market(BaseModel):
    """Represents a Kalshi market (tradeable prediction market).
    
    Attributes:
        market_ticker: Unique identifier for the market
        event_ticker: Parent event identifier
        series_ticker: Parent series identifier
        category: Market category (from parent event)
        title: Human-readable market title
        subtitle: Additional descriptive text
        yes_sub_title: Description of YES outcome
        no_sub_title: Description of NO outcome
        open_time: When the market opened for trading
        close_time: When the market closes for trading
        expected_expiration_time: Expected settlement time
        settlement_value: Final settlement value (if settled)
        result: Market result (if settled)
        status: Current market status (open, closed, settled, etc.)
        can_close_early: Whether market can close before close_time
        floor_strike: Lower bound for ranged markets
        cap_strike: Upper bound for ranged markets
        strike_type: Type of strike (e.g., 'percentage', 'number')
        tick_size: Minimum price increment
        price_step: Price step from price_ranges
        yes_price: Current yes price (from snapshot)
        no_price: Current no price (from snapshot)
        yes_bid: Current yes bid (from snapshot)
        no_bid: Current no bid (from snapshot)
        yes_ask: Current yes ask (from snapshot)
        no_ask: Current no ask (from snapshot)
        last_price: Last trade price (from snapshot)
        volume: Total volume (from snapshot)
        volume_24h: 24-hour volume (from snapshot)
        open_interest: Open interest (from snapshot)
        liquidity: Liquidity metric (from snapshot)
        first_seen: When this market was first captured by our system
        last_updated: When this market metadata was last updated
    """
    
    model_config = ConfigDict(str_strip_whitespace=True)
    
    market_ticker: str = Field(..., min_length=1, description="Unique market identifier")
    event_ticker: str = Field(..., min_length=1, description="Parent event identifier")
    series_ticker: str = Field(default="", description="Parent series identifier (empty if unknown)")
    category: Optional[str] = Field(None, description="Market category from parent event")
    title: str = Field(..., min_length=1, description="Market title")
    subtitle: Optional[str] = Field(None, description="Market subtitle")
    yes_sub_title: str = Field(default="Yes", description="YES outcome description")
    no_sub_title: str = Field(default="No", description="NO outcome description")
    open_time: Optional[datetime] = Field(None, description="Market open time")
    close_time: Optional[datetime] = Field(None, description="Market close time")
    expected_expiration_time: Optional[datetime] = Field(None, description="Expected settlement time")
    settlement_value: Optional[str] = Field(None, description="Settlement value")
    result: Optional[str] = Field(None, description="Market result")
    status: str = Field(..., min_length=1, description="Market status")
    can_close_early: bool = Field(default=False, description="Can close early flag")
    floor_strike: Optional[float] = Field(None, description="Lower bound for ranged markets")
    cap_strike: Optional[float] = Field(None, description="Upper bound for ranged markets")
    strike_type: Optional[str] = Field(None, description="Strike type")
    tick_size: Optional[float] = Field(None, description="Minimum price increment")
    price_step: Optional[float] = Field(None, description="Price step from price_ranges")
    
    # Price fields from MarketSnapshot (for DynamoDB storage)
    yes_price: Optional[float] = Field(None, ge=0, le=1.0, description="Current yes price (dollars)")
    no_price: Optional[float] = Field(None, ge=0, le=1.0, description="Current no price (dollars)")
    yes_bid: Optional[float] = Field(None, ge=0, le=1.0, description="Current yes bid (dollars)")
    no_bid: Optional[float] = Field(None, ge=0, le=1.0, description="Current no bid (dollars)")
    yes_ask: Optional[float] = Field(None, ge=0, le=1.0, description="Current yes ask (dollars)")
    no_ask: Optional[float] = Field(None, ge=0, le=1.0, description="Current no ask (dollars)")
    last_price: Optional[float] = Field(None, ge=0, le=1.0, description="Last trade price (dollars)")
    volume: Optional[int] = Field(None, ge=0, description="Total volume")
    volume_24h: Optional[int] = Field(None, ge=0, description="24-hour volume")
    open_interest: Optional[int] = Field(None, ge=0, description="Open interest")
    liquidity: Optional[float] = Field(None, description="Liquidity metric (can be negative)")
    
    first_seen: datetime = Field(default_factory=datetime.utcnow, description="First capture time")
    last_updated: datetime = Field(default_factory=datetime.utcnow, description="Last update time")
    
    @field_validator('market_ticker', 'event_ticker', 'title', 'status')
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        """Ensure critical string fields are not empty after stripping."""
        if not v or not v.strip():
            raise ValueError("Field cannot be empty")
        return v
    
    # Strike values can be negative for some markets (e.g., employment, temperature)
    # No validation needed - InfluxDB will handle any numeric value


class MarketSnapshot(BaseModel):
    """Represents a point-in-time snapshot of market data for time-series storage.
    
    This model is used for writing data to InfluxDB as time-series points.
    
    Attributes:
        market_ticker: Unique market identifier (tag)
        event_ticker: Parent event identifier (tag)
        series_ticker: Parent series identifier (tag)
        status: Market status (tag)
        yes_price: Current yes price in cents (field)
        no_price: Current no price in cents (field)
        yes_bid: Best yes bid price in cents (field)
        no_bid: Best no bid price in cents (field)
        yes_ask: Best yes ask price in cents (field)
        no_ask: Best no ask price in cents (field)
        volume: Total volume traded (field)
        open_interest: Current open interest (field)
        liquidity: Market liquidity metric (field)
        timestamp: Snapshot timestamp (defaults to current time)
    """
    
    model_config = ConfigDict(str_strip_whitespace=True)
    
    # Tags (indexed in InfluxDB)
    market_ticker: str = Field(..., min_length=1, description="Market identifier")
    event_ticker: str = Field(..., min_length=1, description="Event identifier")
    series_ticker: str = Field(default="", description="Series identifier (empty if unknown)")
    status: str = Field(..., min_length=1, description="Market status")
    
    # Fields (not indexed in InfluxDB)
    yes_price: Optional[float] = Field(None, ge=0, le=1.0, description="Yes price (dollars)")
    no_price: Optional[float] = Field(None, ge=0, le=1.0, description="No price (dollars)")
    yes_bid: Optional[float] = Field(None, ge=0, le=1.0, description="Yes bid (dollars)")
    no_bid: Optional[float] = Field(None, ge=0, le=1.0, description="No bid (dollars)")
    yes_ask: Optional[float] = Field(None, ge=0, le=1.0, description="Yes ask (dollars)")
    no_ask: Optional[float] = Field(None, ge=0, le=1.0, description="No ask (dollars)")
    last_price: Optional[float] = Field(None, ge=0, le=1.0, description="Last trade price (dollars)")
    volume: Optional[int] = Field(None, ge=0, description="Total volume")
    volume_24h: Optional[int] = Field(None, ge=0, description="24-hour volume")
    open_interest: Optional[int] = Field(None, ge=0, description="Open interest")
    liquidity: Optional[float] = Field(None, description="Liquidity metric (can be negative)")
    
    # Timestamp
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Snapshot time")
    
    @field_validator('market_ticker', 'event_ticker', 'status')
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        """Ensure required tag fields are not empty after stripping."""
        if not v or not v.strip():
            raise ValueError("Tag field cannot be empty")
        return v
    
    def to_influx_point(self) -> Dict[str, Any]:
        """Convert to InfluxDB point format.
        
        Returns:
            Dictionary with 'measurement', 'tags', 'fields', and 'time' keys
        """
        tags = {
            "market_ticker": self.market_ticker,
            "event_ticker": self.event_ticker,
            "series_ticker": self.series_ticker,
            "status": self.status,
        }
        
        fields = {}
        if self.yes_price is not None:
            fields["yes_price"] = self.yes_price
        if self.no_price is not None:
            fields["no_price"] = self.no_price
        if self.yes_bid is not None:
            fields["yes_bid"] = self.yes_bid
        if self.no_bid is not None:
            fields["no_bid"] = self.no_bid
        if self.yes_ask is not None:
            fields["yes_ask"] = self.yes_ask
        if self.no_ask is not None:
            fields["no_ask"] = self.no_ask
        if self.last_price is not None:
            fields["last_price"] = self.last_price
        if self.volume is not None:
            fields["volume"] = self.volume
        if self.volume_24h is not None:
            fields["volume_24h"] = self.volume_24h
        if self.open_interest is not None:
            fields["open_interest"] = self.open_interest
        if self.liquidity is not None:
            fields["liquidity"] = self.liquidity
        
        return {
            "measurement": "market_snapshots",
            "tags": tags,
            "fields": fields,
            "time": self.timestamp,
        }


class OrderbookLevel(BaseModel):
    """Represents a single level in the orderbook.

    Attributes:
        price: Price in dollars (0-1.0 range)
        quantity: Number of contracts available at this price
    """
    price: float = Field(..., ge=0, le=1.0, description="Price in dollars")
    quantity: int = Field(..., ge=0, description="Number of contracts")


class Orderbook(BaseModel):
    """Represents the orderbook for a market.

    Attributes:
        yes_bids: List of YES bid levels sorted by price (ascending)
        no_bids: List of NO bid levels sorted by price (ascending)
    """
    yes_bids: list[OrderbookLevel] = Field(default_factory=list, description="YES side bids")
    no_bids: list[OrderbookLevel] = Field(default_factory=list, description="NO side bids")

    def get_best_yes_bid(self) -> Optional[OrderbookLevel]:
        """Get the highest YES bid (first element in descending sorted array)."""
        return self.yes_bids[0] if self.yes_bids else None

    def get_best_no_bid(self) -> Optional[OrderbookLevel]:
        """Get the highest NO bid (first element in descending sorted array)."""
        return self.no_bids[0] if self.no_bids else None

    def get_best_yes_ask(self) -> Optional[OrderbookLevel]:
        """Calculate best YES ask from best NO bid (100 - no_bid)."""
        best_no_bid = self.get_best_no_bid()
        if best_no_bid:
            return OrderbookLevel(
                price=1.0 - best_no_bid.price,
                quantity=best_no_bid.quantity
            )
        return None

    def get_best_no_ask(self) -> Optional[OrderbookLevel]:
        """Calculate best NO ask from best YES bid (100 - yes_bid)."""
        best_yes_bid = self.get_best_yes_bid()
        if best_yes_bid:
            return OrderbookLevel(
                price=1.0 - best_yes_bid.price,
                quantity=best_yes_bid.quantity
            )
        return None


class OrderRequest(BaseModel):
    """Request to create an order on Kalshi.

    Attributes:
        ticker: Market ticker to trade
        side: Which side to trade (yes or no)
        action: Buy or sell action
        count: Number of contracts
        type: Order type (limit or market)
        yes_price_dollars: YES price in dollars as string (for limit orders)
        no_price_dollars: NO price in dollars as string (for limit orders)
        time_in_force: Order time in force policy
        expiration_ts: Unix timestamp (seconds) when order expires (optional)
        cancel_order_on_pause: Whether to cancel order if market pauses
        client_order_id: Optional client-assigned order ID
    """
    ticker: str = Field(..., min_length=1, description="Market ticker")
    side: str = Field(..., description="Position side", pattern="^(yes|no)$")
    action: str = Field(..., description="Trade action", pattern="^(buy|sell)$")
    count: int = Field(..., ge=1, description="Number of contracts")
    type: str = Field(default="limit", description="Order type", pattern="^(limit|market)$")
    yes_price: Optional[int] = Field(None, description="YES price in cents (e.g., 97 for $0.97)")
    no_price: Optional[int] = Field(None, description="NO price in cents (e.g., 97 for $0.97)")
    yes_price_dollars: Optional[str] = Field(None, description="YES price in dollars (e.g., '0.9700')")
    no_price_dollars: Optional[str] = Field(None, description="NO price in dollars (e.g., '0.9700')")
    time_in_force: str = Field(default="good_till_canceled", description="Order time in force policy")
    expiration_ts: Optional[int] = Field(None, description="Unix timestamp (seconds) when order expires")
    self_trade_prevention_type: str = Field(default="taker_at_cross", description="Self-trade prevention policy")
    cancel_order_on_pause: bool = Field(default=True, description="Cancel order if market pauses")
    client_order_id: Optional[str] = Field(None, description="Client-assigned order ID")


class OrderResponse(BaseModel):
    """Response from creating an order.

    Attributes:
        order_id: Kalshi-assigned order ID
        client_order_id: Client-assigned order ID if provided
        status: Order status
        yes_price: YES price in dollars
        no_price: NO price in dollars
        created_time: When order was created
        remaining_count: Remaining unfilled contracts
        fill_count: Number of filled contracts
    """
    order_id: str = Field(..., description="Kalshi order ID")
    client_order_id: Optional[str] = Field(None, description="Client order ID")
    status: str = Field(..., description="Order status")
    yes_price: Optional[float] = Field(None, description="YES price in dollars")
    no_price: Optional[float] = Field(None, description="NO price in dollars")
    created_time: Optional[datetime] = Field(None, description="Order creation time")
    remaining_count: Optional[int] = Field(None, description="Remaining unfilled contracts")
    fill_count: Optional[int] = Field(None, description="Number of filled contracts")


class Fill(BaseModel):
    """Represents a fill (execution) of an order.

    Attributes:
        order_id: Order ID that was filled
        fill_id: Unique fill ID
        ticker: Market ticker
        side: Position side (yes/no)
        action: Trade action (buy/sell)
        count: Number of contracts filled
        price: Fill price in dollars
        created_time: When fill occurred
    """
    order_id: str = Field(..., description="Order ID")
    fill_id: str = Field(..., description="Fill ID")
    ticker: str = Field(..., description="Market ticker")
    side: str = Field(..., description="Position side")
    action: str = Field(..., description="Trade action")
    count: int = Field(..., ge=1, description="Contracts filled")
    price: float = Field(..., ge=0, le=1.0, description="Fill price in dollars")
    created_time: Optional[datetime] = Field(None, description="Fill time")


class TradeIdea(BaseModel):
    """Represents a trading idea that generated this trade.

    Attributes:
        idea_id: Unique identifier for the trading idea
        idea_version: Version of the trading idea/strategy
        idea_description: Optional human-readable description
        created_time: When the idea was created
    """
    idea_id: str = Field(..., min_length=1, description="Unique idea identifier")
    idea_version: str = Field(..., min_length=1, description="Idea version")
    idea_description: Optional[str] = Field(None, description="Idea description")
    created_time: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Idea creation time")


class TradeLog(BaseModel):
    """Complete log entry for a trade execution.

    This comprehensive log captures all details needed to trace a trade
    back to its originating idea and reproduce the exact market conditions.

    Attributes:
        trade_id: Unique identifier for this trade execution
        userid: User identifier for multi-user trading
        idea: Trading idea that generated this trade
        ticker: Market ticker
        side: Position side (yes/no)
        action: Trade action (buy/sell)
        max_dollar_amount: Maximum budget
        max_price: Maximum price constraint
        orderbook_snapshot: Orderbook at time of order placement
        orderbook_fetch_time: When orderbook was fetched
        order_placement_time: When order was submitted
        order: Order response from API
        fills: All fills received for this order
        success: Whether trade succeeded
        error_message: Error details if failed
        completion_time: When trade execution completed
    """
    trade_id: str = Field(..., description="Unique trade execution ID")
    userid: str = Field(default="jimc", description="User identifier")
    idea: TradeIdea = Field(..., description="Originating trading idea")
    ticker: str = Field(..., description="Market ticker")
    side: str = Field(..., description="Position side")
    action: str = Field(..., description="Trade action")
    max_dollar_amount: float = Field(..., description="Maximum budget")
    max_price: float = Field(..., description="Maximum price constraint")
    orderbook_snapshot: Optional[Orderbook] = Field(None, description="Orderbook at order time")
    orderbook_fetch_time: Optional[datetime] = Field(None, description="Orderbook fetch timestamp")
    order_placement_time: Optional[datetime] = Field(None, description="Order submission timestamp")
    order: Optional[OrderResponse] = Field(None, description="Order details")
    fills: list[Fill] = Field(default_factory=list, description="All fills received")
    success: bool = Field(..., description="Trade success status")
    error_message: Optional[str] = Field(None, description="Error details")
    completion_time: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Completion timestamp")

    def to_log_dict(self) -> Dict[str, Any]:
        """Convert to dictionary suitable for structured logging.

        Returns:
            Dictionary with all trade details
        """
        return {
            'trade_id': self.trade_id,
            'userid': self.userid,
            'idea_id': self.idea.idea_id,
            'idea_version': self.idea.idea_version,
            'idea_description': self.idea.idea_description,
            'ticker': self.ticker,
            'side': self.side,
            'action': self.action,
            'max_dollar_amount': self.max_dollar_amount,
            'max_price': self.max_price,
            'orderbook_fetch_time': self.orderbook_fetch_time.isoformat() if self.orderbook_fetch_time else None,
            'order_placement_time': self.order_placement_time.isoformat() if self.order_placement_time else None,
            'order_id': self.order.order_id if self.order else None,
            'order_status': self.order.status if self.order else None,
            'fill_count': len(self.fills),
            'total_contracts_filled': sum(f.count for f in self.fills),
            'avg_fill_price': (sum(f.price * f.count for f in self.fills) / sum(f.count for f in self.fills)) if self.fills else None,
            'success': self.success,
            'error_message': self.error_message,
            'completion_time': self.completion_time.isoformat()
        }


class FillLog(BaseModel):
    """Individual fill log entry with traceability to idea.

    Each fill is logged separately with full context for audit trails.

    Attributes:
        fill_id: Unique fill identifier from Kalshi
        trade_id: Associated trade execution ID
        idea_id: Originating trading idea ID
        idea_version: Version of the trading idea
        order_id: Order ID that was filled
        ticker: Market ticker
        side: Position side
        action: Trade action
        count: Contracts filled
        price: Fill price
        fill_timestamp: When fill occurred
        received_timestamp: When fill notification was received
    """
    fill_id: str = Field(..., description="Kalshi fill ID")
    trade_id: str = Field(..., description="Trade execution ID")
    idea_id: str = Field(..., description="Idea ID")
    idea_version: str = Field(..., description="Idea version")
    order_id: str = Field(..., description="Order ID")
    ticker: str = Field(..., description="Market ticker")
    side: str = Field(..., description="Position side")
    action: str = Field(..., description="Trade action")
    count: int = Field(..., ge=1, description="Contracts filled")
    price: float = Field(..., ge=0, le=1.0, description="Fill price")
    fill_timestamp: Optional[datetime] = Field(None, description="Fill occurrence time")
    received_timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Fill received time")

    def to_log_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for structured logging."""
        return {
            'fill_id': self.fill_id,
            'trade_id': self.trade_id,
            'idea_id': self.idea_id,
            'idea_version': self.idea_version,
            'order_id': self.order_id,
            'ticker': self.ticker,
            'side': self.side,
            'action': self.action,
            'count': self.count,
            'price': self.price,
            'cost': self.count * self.price,
            'fill_timestamp': self.fill_timestamp.isoformat() if self.fill_timestamp else None,
            'received_timestamp': self.received_timestamp.isoformat()
        }


class TradeResult(BaseModel):
    """Result of executing a trade.

    Attributes:
        success: Whether trade was successful
        trade_log: Complete trade log entry
        execution_summary: Human-readable summary
    """
    success: bool = Field(..., description="Trade success status")
    trade_log: TradeLog = Field(..., description="Complete trade log")
    execution_summary: str = Field(..., description="Execution summary")


class KalshiMarketResponse(BaseModel):
    """Represents the market data returned by Kalshi API.

    This is a raw response model that gets transformed into our domain models.
    """

    model_config = ConfigDict(extra='allow')

    ticker: str = Field(..., description="Market ticker")
    event_ticker: str = Field(..., description="Event ticker")
    series_ticker: Optional[str] = Field(None, description="Series ticker")
    category: Optional[str] = Field(None, description="Market/Event category")
    title: str = Field(..., description="Market title")
    subtitle: Optional[str] = Field(None, description="Market subtitle")
    yes_sub_title: Optional[str] = Field(None, description="Yes outcome title")
    no_sub_title: Optional[str] = Field(None, description="No outcome title")
    open_time: Optional[str] = Field(None, description="Open timestamp")
    close_time: Optional[str] = Field(None, description="Close timestamp")
    expected_expiration_time: Optional[str] = Field(None, description="Expected expiration")
    settlement_value: Optional[str] = Field(None, description="Settlement value")
    result: Optional[str] = Field(None, description="Market result")
    status: str = Field(..., description="Market status")
    can_close_early: Optional[bool] = Field(None, description="Can close early")
    floor_strike: Optional[float] = Field(None, description="Floor strike")
    cap_strike: Optional[float] = Field(None, description="Cap strike")
    strike_type: Optional[str] = Field(None, description="Strike type")
    yes_bid_dollars: Optional[float] = Field(None, description="Yes bid in dollars")
    yes_ask_dollars: Optional[float] = Field(None, description="Yes ask in dollars")
    no_bid_dollars: Optional[float] = Field(None, description="No bid in dollars")
    no_ask_dollars: Optional[float] = Field(None, description="No ask in dollars")
    price_dollars: Optional[float] = Field(None, description="Last price in dollars", alias="last_price_dollars")
    previous_yes_bid_dollars: Optional[float] = Field(None, description="Previous yes bid in dollars")
    previous_yes_ask_dollars: Optional[float] = Field(None, description="Previous yes ask in dollars")
    previous_price_dollars: Optional[float] = Field(None, description="Previous price in dollars")
    volume: Optional[int] = Field(None, description="Total volume")
    volume_24h: Optional[int] = Field(None, description="24h volume")
    liquidity_dollars: Optional[float] = Field(None, description="Liquidity in dollars")
    open_interest: Optional[int] = Field(None, description="Open interest")
    tick_size: Optional[float] = Field(None, description="Minimum price increment")
    price_ranges: Optional[list] = Field(None, description="Price ranges with step information")

    # Multivariate market fields
    multivariate_event_ticker: Optional[str] = Field(None, alias="Multivariate Event Ticker", description="Multivariate event ticker if this is a multivariate market")
    mve_selected_legs: Optional[list] = Field(None, description="Selected legs for multivariate events - if populated, this is a multivariate market")
    custom_strike: Optional[dict] = Field(None, description="Custom strike information that may contain multivariate event ticker")
    
    def _parse_timestamp(self, ts_str: Optional[str]) -> Optional[datetime]:
        """Parse ISO 8601 timestamp string to datetime."""
        if not ts_str:
            return None
        try:
            # Remove 'Z' and parse as UTC
            if ts_str.endswith('Z'):
                ts_str = ts_str[:-1] + '+00:00'
            return datetime.fromisoformat(ts_str)
        except (ValueError, AttributeError):
            return None
    
    def to_market(self) -> Market:
        """Convert to Market model."""
        # Extract price_step from price_ranges if available
        price_step = None
        if self.price_ranges and len(self.price_ranges) > 0:
            first_range = self.price_ranges[0]
            if isinstance(first_range, dict) and 'step' in first_range:
                try:
                    price_step = float(first_range['step'])
                except (ValueError, TypeError):
                    pass
        
        return Market(
            market_ticker=self.ticker,
            event_ticker=self.event_ticker,
            series_ticker=self.series_ticker or "",  # Empty string instead of "UNKNOWN"
            title=self.title,
            subtitle=self.subtitle,
            yes_sub_title=self.yes_sub_title or "Yes",
            no_sub_title=self.no_sub_title or "No",
            open_time=self._parse_timestamp(self.open_time),
            close_time=self._parse_timestamp(self.close_time),
            expected_expiration_time=self._parse_timestamp(self.expected_expiration_time),
            settlement_value=self.settlement_value,
            result=self.result,
            status=self.status,
            can_close_early=self.can_close_early or False,
            floor_strike=self.floor_strike,
            cap_strike=self.cap_strike,
            strike_type=self.strike_type,
            tick_size=self.tick_size,
            price_step=price_step,
        )
    
    def to_snapshot(self, timestamp: Optional[datetime] = None) -> MarketSnapshot:
        """Convert to MarketSnapshot model.
        
        Args:
            timestamp: Optional timestamp override (defaults to current time)
            
        Returns:
            MarketSnapshot instance
        """
        # Calculate yes and no prices from bid/ask or last price
        yes_price = None
        no_price = None
        
        if self.yes_bid_dollars is not None and self.yes_ask_dollars is not None:
            yes_price = (self.yes_bid_dollars + self.yes_ask_dollars) / 2.0
        elif self.price_dollars is not None:
            yes_price = self.price_dollars
        
        if yes_price is not None:
            no_price = 1.0 - yes_price
        
        return MarketSnapshot(
            market_ticker=self.ticker,
            event_ticker=self.event_ticker,
            series_ticker=self.series_ticker or "",  # Empty string instead of "UNKNOWN"
            status=self.status,
            yes_price=yes_price,
            no_price=no_price,
            yes_bid=self.yes_bid_dollars,
            no_bid=self.no_bid_dollars,
            yes_ask=self.yes_ask_dollars,
            no_ask=self.no_ask_dollars,
            last_price=self.price_dollars,
            volume=self.volume,
            volume_24h=self.volume_24h,
            open_interest=self.open_interest,
            liquidity=self.liquidity_dollars,
            timestamp=timestamp or datetime.utcnow(),
        )
