"""Portfolio data models for Kalshi portfolio tracking.

This module defines Pydantic models for:
- API responses from Kalshi (Balance, Positions, Settlements)
- DynamoDB items for storage
"""

from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, Field


# ============================================================================
# Kalshi API Response Models
# ============================================================================

class BalanceResponse(BaseModel):
    """Response from GET /portfolio/balance"""
    balance: int  # cents - available for trading
    portfolio_value: int  # cents - current positions value
    updated_ts: int  # Unix timestamp


class MarketPosition(BaseModel):
    """Individual market position from positions API"""
    ticker: str
    total_traded: int  # total contracts traded
    total_traded_dollars: Optional[str] = None  # string dollar amount
    position: int  # current position (positive or negative)
    market_exposure: int  # at-risk value in cents
    market_exposure_dollars: Optional[str] = None
    realized_pnl: int  # realized profit/loss in cents
    realized_pnl_dollars: Optional[str] = None
    resting_orders_count: Optional[int] = None  # Not always provided by API
    fees_paid: int  # cents
    fees_paid_dollars: Optional[str] = None
    last_updated_ts: str  # ISO timestamp


class EventPosition(BaseModel):
    """Event-level position aggregate from positions API"""
    event_ticker: str
    total_cost: int  # cents
    total_cost_dollars: Optional[str] = None
    total_cost_shares: Optional[int] = None  # number of contracts (not always present)
    event_exposure: int  # cents
    event_exposure_dollars: Optional[str] = None
    realized_pnl: int  # cents
    realized_pnl_dollars: Optional[str] = None
    resting_order_count: Optional[int] = None  # Not always provided by API
    fees_paid: int  # cents
    fees_paid_dollars: Optional[str] = None


class PositionsResponse(BaseModel):
    """Response from GET /portfolio/positions"""
    cursor: Optional[str] = None
    market_positions: List[MarketPosition] = []
    event_positions: List[EventPosition] = []


class Settlement(BaseModel):
    """Settlement record from settlements API"""
    ticker: str
    market_result: str  # "yes" or "no"
    yes_count: int  # contracts held
    yes_total_cost: int  # cents
    no_count: int
    no_total_cost: int
    revenue: int  # settlement payout in cents
    settled_time: str  # ISO timestamp
    fee_cost: Optional[str] = None  # string dollar amount (not always present)
    value: int  # profit/loss in cents


class SettlementsResponse(BaseModel):
    """Response from GET /portfolio/settlements"""
    settlements: List[Settlement] = []
    cursor: Optional[str] = None


# ============================================================================
# DynamoDB Item Models
# ============================================================================

class PortfolioSnapshotItem(BaseModel):
    """DynamoDB item for PortfolioSnapshots table"""
    api_key_id: str  # HASH key
    snapshot_ts: int  # RANGE key - Unix timestamp in milliseconds
    cash: int  # cents - available for trading
    portfolio_value: int  # cents - total value of all positions
    total_value: int  # cents - cash + portfolio_value
    updated_ts: int  # from Kalshi API
    total_positions_count: int
    user_name: str
    userid: str = "jimc"  # User identifier for multi-user support
    created_at: str  # ISO timestamp


class MarketPositionItem(BaseModel):
    """DynamoDB item for MarketPositions table"""
    position_id: str  # HASH key - composite: {api_key_id}#{ticker}#{snapshot_ts}
    snapshot_ts: int  # RANGE key
    api_key_id: str
    ticker: str
    total_traded: int
    total_traded_dollars: Optional[str] = None
    position: int
    market_exposure: int
    market_exposure_dollars: Optional[str] = None
    realized_pnl: int
    realized_pnl_dollars: Optional[str] = None
    resting_orders_count: Optional[int] = None
    fees_paid: int
    fees_paid_dollars: Optional[str] = None
    last_updated_ts: str
    user_name: str
    userid: str = "jimc"  # User identifier for multi-user support
    created_at: str


class EventPositionItem(BaseModel):
    """DynamoDB item for EventPositions table"""
    position_id: str  # HASH key - composite: {api_key_id}#{event_ticker}#{snapshot_ts}
    snapshot_ts: int  # RANGE key
    api_key_id: str
    event_ticker: str
    total_cost: int
    total_cost_dollars: Optional[str] = None
    total_cost_shares: Optional[int] = None  # Not always present in API response
    event_exposure: int
    event_exposure_dollars: Optional[str] = None
    realized_pnl: int
    realized_pnl_dollars: Optional[str] = None
    resting_order_count: Optional[int] = None
    fees_paid: int
    fees_paid_dollars: Optional[str] = None
    user_name: str
    userid: str = "jimc"  # User identifier for multi-user support
    created_at: str


class SettlementItem(BaseModel):
    """DynamoDB item for Settlements table"""
    settlement_id: str  # HASH key - composite: {api_key_id}#{ticker}
    settled_time: str  # RANGE key - ISO timestamp
    api_key_id: str
    ticker: str
    market_result: str
    yes_count: int
    yes_total_cost: int
    no_count: int
    no_total_cost: int
    revenue: int
    settled_time_ts: int  # Unix timestamp for queries
    fee_cost: Optional[str] = None  # Not always present in API response
    value: int
    user_name: str
    userid: str = "jimc"  # User identifier for multi-user support
    captured_at: str  # ISO timestamp
    ttl: int  # Unix timestamp for DynamoDB TTL (30 days from capture)


# ============================================================================
# User Metadata Model
# ============================================================================

class UserMetadata(BaseModel):
    """Metadata stored in Secrets Manager for each user"""
    user_name: str
    api_key_id: str  # Kalshi API key ID
    enabled: bool = True
    created_at: Optional[str] = None
    disabled_at: Optional[str] = None
    notes: Optional[str] = None


# ============================================================================
# Response Models for Lambda
# ============================================================================

class PortfolioCaptureResponse(BaseModel):
    """Response from portfolio tracker Lambda"""
    statusCode: int
    summary: dict
    balance: Optional[dict] = None
    positions: Optional[dict] = None
    settlements: Optional[dict] = None
    error: Optional[str] = None
    error_type: Optional[str] = None
