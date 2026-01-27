# Analytics Page Upgrade - Design Document

**Created:** 2026-01-27  
**Author:** Copilot  
**Status:** APPROVED - Ready for Implementation

---

## Executive Summary

This document outlines the design for upgrading the `/dashboard/analytics` page with two major features:
1. **Weekly Position Table** - Replace the equity curve chart with a 4-week position table showing weekly and cumulative % changes
2. **Trades to Settlement Table** - New table showing all settled trades with comprehensive analytics and grouping capabilities

**Key Decisions (User Approved):**
- Category: Use BOTH ticker prefix AND `category` field from metadata
- Week boundary: Sunday 23:59 UTC ✅
- Price buckets: <0.95, 0.95, 0.96, 0.97, 0.98, 0.99 (most trades are high-confidence)
- Settlement data: Option B - Background sync to DynamoDB (via TIS)
- Backfill: Create and run script for historical settlement data

---

## Current State

### Existing Analytics Page
- **Location:** `/app/dashboard/analytics/page.tsx`
- **Current Features:**
  - Equity curve chart (Recharts AreaChart)
  - Period selector (24h, 7d, 30d, all)
  - User selector (admin only)
- **Data Source:** `getPortfolio()` API with `history` data from `production-kalshi-portfolio-snapshots` table

### Existing Data Tables

| Table | Primary Key | Relevant Fields |
|-------|------------|-----------------|
| `production-kalshi-portfolio-snapshots` | `api_key_id` + `snapshot_ts` | `total_value`, `cash`, `user_name` |
| `production-kalshi-trades-v2` | `order_id` | `market_ticker`, `user_name`, `side`, `avg_fill_price`, `filled_count`, `idea_name`, `placed_at` |
| `production-kalshi-market-metadata` | `market_ticker` | `status`, `finalized_time`, `close_time` |

### Data Gap: Settlement Information
The trades table (`production-kalshi-trades-v2`) does **NOT** contain settlement data (settlement price, settlement time, settlement result). This data must be fetched from Kalshi's `/portfolio/settlements` API.

---

## Feature 1: Weekly Position Table

### Requirements
- Show portfolio value at end of each of the last 4 weeks (Sunday 23:59 UTC)
- Calculate weekly % change and cumulative % change from oldest week
- Display for each user (admin view shows all users)

### Data Source
- **Table:** `production-kalshi-portfolio-snapshots`
- **Query Strategy:** For each user, query snapshots at week boundaries

### UI Design

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Weekly Portfolio Performance (All Users)                                    │
├─────────────┬──────────────┬──────────────┬──────────────┬──────────────────┤
│ User        │ Week of 1/6  │ Week of 1/13 │ Week of 1/20 │ Current (1/27)   │
├─────────────┼──────────────┼──────────────┼──────────────┼──────────────────┤
│ jimc        │ $3,450.00    │ $3,512.00    │ $3,623.50    │ $3,750.25        │
│             │ --           │ +1.80%       │ +5.03%       │ +8.70%           │
│             │              │ (+1.80% wk)  │ (+3.18% wk)  │ (+3.50% wk)      │
├─────────────┼──────────────┼──────────────┼──────────────┼──────────────────┤
│ andrews     │ $2,100.00    │ $2,050.00    │ $2,180.00    │ $2,250.00        │
│             │ --           │ -2.38%       │ +3.81%       │ +7.14%           │
│             │              │ (-2.38% wk)  │ (+6.34% wk)  │ (+3.21% wk)      │
└─────────────┴──────────────┴──────────────┴──────────────┴──────────────────┘
```

### API Changes

**Option A: Extend `get-portfolio.py`** (Recommended)
- Add `weekly_summary` parameter
- Returns week-end snapshots for last 4 weeks

**Option B: New `get-analytics.py` endpoint**
- Separate endpoint for weekly data

### Implementation Details

```python
# Lambda: get-portfolio.py enhancement
def get_weekly_snapshots(api_key_id: str, weeks: int = 4) -> List[Dict]:
    """Get portfolio snapshots at week boundaries."""
    now = datetime.now(timezone.utc)
    
    # Find most recent Sunday 23:59
    days_since_sunday = (now.weekday() + 1) % 7
    last_sunday = now - timedelta(days=days_since_sunday)
    last_sunday = last_sunday.replace(hour=23, minute=59, second=59, microsecond=0)
    
    snapshots = []
    for week in range(weeks):
        target_time = last_sunday - timedelta(weeks=week)
        target_ts = int(target_time.timestamp() * 1000)
        
        # Query nearest snapshot to target time (within 2 hour window)
        response = portfolio_table.query(
            KeyConditionExpression='api_key_id = :api AND snapshot_ts <= :ts',
            ExpressionAttributeValues={
                ':api': api_key_id,
                ':ts': target_ts
            },
            ScanIndexForward=False,
            Limit=1
        )
        
        if response.get('Items'):
            snapshots.append(response['Items'][0])
    
    return snapshots
```

---

## Feature 2: Trades to Settlement Table

### Requirements
- Show all trades that have settled (market finalized)
- Columns: Date/Time of Trade, Idea, Market Ticker, Market Category, Share Purchase Price, Settlement Price, Total Amount Purchased, Total Amount Settled, Duration (purchase → settlement), $ Return
- Grouping: By User, By Idea, By Share Purchase Price (bucketed)
- Filterable by date range

### Data Sources

1. **Trades:** `production-kalshi-trades-v2`
   - Has: `market_ticker`, `idea_name`, `avg_fill_price`, `filled_count`, `placed_at`, `user_name`
   - **NEW:** `settlement_time`, `settlement_result`, `settlement_price` (added by TIS + backfill)

2. **Market Category:** `production-kalshi-market-metadata.category` + ticker prefix fallback

### Data Strategy: Background Sync (Option B) ✅ SELECTED

TIS will write settlement data to trades-v2 when markets settle:
```
Market settles → Kalshi sends market_lifecycle_v2 event
  → TIS receives event with result ("yes"/"no") and settled_ts
  → TIS queries trades-v2 by market_ticker (GSI)
  → TIS updates each trade with settlement_time, settlement_result, settlement_price
```

Historical data will be backfilled via `backfill_settlements.py`.

### Settlement Price Calculation

```python
# Settlement price is based on market_result AND the trade's side
# If trade side matches result → won → settlement_price = 1.00
# If trade side doesn't match → lost → settlement_price = 0.00

def calculate_return(trade: Dict) -> float:
    """Calculate $ return for a settled trade."""
    side = trade['side']  # "yes" or "no"
    contracts = trade['filled_count']
    purchase_price = trade['avg_fill_price']  # Already in dollars (0.00-1.00)
    settlement_result = trade['settlement_result']  # "yes" or "no"
    
    # Did we win?
    won = (side == settlement_result)
    
    # Settlement pays $1.00 per winning contract, $0.00 per losing
    if won:
        settlement_price = 1.00
    else:
        settlement_price = 0.00
    
    # Calculate return
    if trade['action'] == 'buy':
        cost = contracts * purchase_price
        payout = contracts * settlement_price
        return payout - cost
    else:  # sell
        # Selling means we received (1 - price) and give back settlement
        received = contracts * (1.0 - purchase_price) if side == 'yes' else contracts * purchase_price
        # This is more complex for sells - usually shorts
        return received - (contracts * settlement_price)
```

### UI Design

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Trades to Settlement                                                                        Group by: [User ▼]  │
├────────────────────┬────────────────────┬──────────────────────────┬──────────┬────────┬────────┬───────┬───────┤
│ Date/Time          │ Idea               │ Market Ticker            │ Category │ Bought │ Settle │ Qty   │ P&L   │
│                    │                    │                          │          │ Price  │ Price  │       │       │
├────────────────────┼────────────────────┼──────────────────────────┼──────────┼────────┼────────┼───────┼───────┤
│ 2026-01-25 14:32   │ high-confidence    │ KXFED-26JAN31-425        │ Economics│ $0.92  │ $1.00  │ 50    │ +$4.00│
│ 2026-01-24 09:15   │ mention-trader     │ KXNFLMENTION-SF-BROCK    │ Sports   │ $0.05  │ $0.00  │ 100   │ -$5.00│
│ 2026-01-23 18:45   │ high-confidence    │ KXSP500-26JAN24-5950     │ Finance  │ $0.88  │ $1.00  │ 25    │ +$3.00│
├────────────────────┴────────────────────┴──────────────────────────┴──────────┴────────┴────────┴───────┴───────┤
│                                                                                    Total P&L: +$2.00            │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Grouping Modes

1. **By User** (default for admins) - Group rows by user_name, show user subtotals
2. **By Idea** - Group by idea_name (high-confidence, mention-trader, etc.)
3. **By Purchase Price** - Bucket by price range: <0.95, 0.95, 0.96, 0.97, 0.98, 0.99

### API Design

**New Endpoint:** `GET /analytics/settlements`

**Request Parameters:**
```
user_name: string (optional, admin can specify any user)
period: "7d" | "30d" | "90d" | "all"
group_by: "user" | "idea" | "price_bucket" (optional)
```

**Response:**
```json
{
  "user": "jimc",
  "period": "30d",
  "trades": [
    {
      "order_id": "abc123",
      "market_ticker": "KXFED-26JAN31-425",
      "idea_name": "high-confidence",
      "category": "Economics",
      "trade_time": "2026-01-25T14:32:00Z",
      "settlement_time": "2026-01-31T17:00:00Z",
      "side": "yes",
      "action": "buy",
      "contracts": 50,
      "purchase_price": 0.92,
      "settlement_price": 1.00,
      "duration_hours": 146.5,
      "return_dollars": 4.00
    }
  ],
  "summary": {
    "total_trades": 25,
    "total_return": 127.50,
    "win_rate": 0.68,
    "avg_duration_hours": 48.3
  }
}
```

### Market Category Derivation

Use BOTH sources for category, with the following priority:
1. **`category` field** from `production-kalshi-market-metadata` table (if present and valid)
2. **Ticker prefix fallback** when category field is empty/null

```python
TICKER_CATEGORY_MAP = {
    'KXFED': 'Economics',
    'KXCPI': 'Economics',
    'KXGDP': 'Economics',
    'KXSP500': 'Finance',
    'KXNASDAQ': 'Finance', 
    'KXBTC': 'Crypto',
    'KXETH': 'Crypto',
    'KXNFL': 'Sports',
    'KXNBA': 'Sports',
    'KXMLB': 'Sports',
    'KXNHL': 'Sports',
    'KXNETFLIX': 'Entertainment',
    'KXBILLBOARD': 'Entertainment',
    'KXSPOTIFY': 'Entertainment',
    'KXWEATHER': 'Weather',
    'KXPREZ': 'Politics',
    'KXSENATE': 'Politics',
    'KXHOUSE': 'Politics',
    'KXGOV': 'Politics',
    # ... etc
}

def get_category(ticker: str, metadata_category: Optional[str] = None) -> str:
    """Get category from metadata first, then fall back to ticker prefix."""
    # First check metadata category
    if metadata_category and metadata_category.strip() and not metadata_category.lower().startswith('kx'):
        return metadata_category.strip().title()
    
    # Fall back to ticker prefix
    for prefix, category in TICKER_CATEGORY_MAP.items():
        if ticker.upper().startswith(prefix):
            return category
    return 'Other'
```

---

## NEW: Settlement Data Sync (Option B)

### Overview

TIS will be modified to write settlement data to `production-kalshi-trades-v2` when markets settle.
This eliminates the need for real-time API calls when querying settled trades.

### New Fields on trades-v2 Table

| Field | Type | Description |
|-------|------|-------------|
| `settlement_time` | Number | Unix timestamp of settlement |
| `settlement_result` | String | "yes" or "no" - which side won |
| `settlement_price` | Number | 1.00 for win, 0.00 for loss (based on trade side) |

### TIS Modification: `handle_market_lifecycle()`

When TIS receives a `market_lifecycle_v2` settlement event:

1. ✅ **CURRENT:** Delete position from positions-live table
2. ✅ **CURRENT:** Refresh cash balance
3. ✅ **CURRENT:** Remove from lifecycle subscriptions
4. 🆕 **NEW:** Update all trades for this market_ticker with settlement data

```python
async def handle_market_lifecycle(self, data: dict):
    """Handle market_lifecycle WebSocket message (settlement notification)."""
    msg = data.get('msg', {})
    market_ticker = msg.get('market_ticker')
    event_type = msg.get('event_type')
    
    if event_type != 'settled':
        return
    
    result = msg.get('result')  # "yes" or "no"
    settled_ts = msg.get('settled_ts')  # Unix timestamp
    
    # ... existing cleanup code ...
    
    # NEW: Update trades with settlement data
    await self.update_trades_with_settlement(
        market_ticker=market_ticker,
        settlement_result=result,
        settlement_time=settled_ts
    )

async def update_trades_with_settlement(
    self, 
    market_ticker: str, 
    settlement_result: str, 
    settlement_time: int
):
    """
    Update all trades for this market with settlement data.
    
    Uses market_ticker-index GSI to find all trades for this market,
    then updates each with settlement fields.
    """
    trades_table = self.dynamodb_resource.Table('production-kalshi-trades-v2')
    
    # Query all trades for this market (across all users)
    response = trades_table.query(
        IndexName='market_ticker-index',
        KeyConditionExpression='market_ticker = :ticker',
        ExpressionAttributeValues={':ticker': market_ticker}
    )
    
    for trade in response.get('Items', []):
        order_id = trade['order_id']
        side = trade['side']  # "yes" or "no"
        
        # Calculate settlement price based on whether trade won
        won = (side == settlement_result)
        settlement_price = 1.00 if won else 0.00
        
        # Update the trade record
        trades_table.update_item(
            Key={'order_id': order_id},
            UpdateExpression='SET settlement_time = :st, settlement_result = :sr, settlement_price = :sp',
            ExpressionAttributeValues={
                ':st': settlement_time,
                ':sr': settlement_result,
                ':sp': Decimal(str(settlement_price))
            }
        )
        
        self.logger.info(
            "SETTLEMENT: Updated trade with settlement data",
            order_id=order_id,
            market_ticker=market_ticker,
            settlement_result=settlement_result,
            won=won
        )
```

### Backfill Script: `backfill_settlements.py`

New script to backfill settlement data for historical trades.

**Strategy:**
1. For each user (jimc, andrews), fetch ALL settlements from Kalshi API
2. For each settlement, query trades-v2 by market_ticker
3. Update trades that don't have settlement data

```python
#!/usr/bin/env python3
"""
Backfill settlement data for historical trades.

This script:
1. Fetches all settlements from Kalshi API for each user
2. Matches settlements to trades in production-kalshi-trades-v2
3. Updates trades with settlement_time, settlement_result, settlement_price

Usage:
    python3 backfill_settlements.py --dry-run  # Preview changes
    python3 backfill_settlements.py            # Actually update
"""

import argparse
import json
import boto3
from decimal import Decimal
from datetime import datetime, timezone
import time

# ... (full implementation in separate file)
```

---

## Implementation Plan (Updated)

### Phase 0: Settlement Data Infrastructure (2-3 hours) ⭐ NEW

1. **Modify TIS `main.py`**
   - Add `update_trades_with_settlement()` method
   - Call from `handle_market_lifecycle()` after settlement

2. **Create `backfill_settlements.py`**
   - Fetch settlements from Kalshi API
   - Match to trades-v2 records
   - Update with settlement fields
   - Run for all users

3. **Test and Deploy TIS**
   - Deploy updated TIS
   - Run backfill script
   - Verify data integrity

### Phase 1: Backend API (2-3 hours)

1. **Create `get-settlements-analytics.py` Lambda**
   - Fetch trades from trades-v2 table (now includes settlement data!)
   - Enrich with category from metadata table + ticker prefix
   - Return formatted response
   - No Kalshi API calls needed (data is in DynamoDB)

2. **Update `template.yaml`**
   - Add new Lambda function
   - Add API Gateway route `/analytics/settlements`
   - Add IAM permissions

3. **Extend `get-portfolio.py`**
   - Add `weekly_summary=true` parameter
   - Return week-boundary snapshots

### Phase 2: Frontend UI (3-4 hours)

1. **Replace Equity Chart with Weekly Table**
   - New `WeeklyPositionTable` component
   - Fetch data with `getPortfolio({ weekly_summary: true })`
   - Display % changes with color coding

2. **Add Settlements Table**
   - New `SettlementsTable` component
   - Grouping controls (dropdown)
   - Sortable columns
   - Loading states

3. **Update Analytics Page Layout**
   - Stack tables vertically
   - Keep period/user selectors

### Phase 3: Testing & Polish (1-2 hours)

1. Test with multiple users
2. Handle edge cases (no settlements, empty weeks)
3. Performance optimization if needed

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `lambda/get-settlements-analytics.py` | New Lambda for settlements data |
| `components/WeeklyPositionTable.tsx` | Weekly position table component |
| `components/SettlementsTable.tsx` | Settlements table component |

### Modified Files
| File | Changes |
|------|---------|
| `lambda/get-portfolio.py` | Add weekly_summary parameter |
| `lambda/template.yaml` | Add new Lambda + API route |
| `app/dashboard/analytics/page.tsx` | Replace chart, add settlements table |
| `lib/api.ts` | Add `getSettlements()` function |

---

## IAM Permissions Required

The new Lambda needs:
```yaml
Policies:
  - DynamoDBReadPolicy:
      TableName: production-kalshi-trades-v2
  - DynamoDBReadPolicy:
      TableName: production-kalshi-market-metadata
  - Statement:
      - Effect: Allow
        Action:
          - secretsmanager:GetSecretValue
        Resource:
          - !Sub 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:production/kalshi/users/*'
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Kalshi API rate limiting | Medium | Medium | Use same rate limiter as portfolio fetcher |
| Slow response (many settlements) | Medium | Low | Data is local in DynamoDB, no API calls |
| Missing settlement data | Low | Medium | Show "pending" for unsettled trades |
| Stale portfolio snapshots | Low | Low | Use nearest snapshot within 2-hour window |
| Backfill script failure | Low | Medium | Run in dry-run mode first, manual retry |

---

## Resolved Questions

| Question | Decision |
|----------|----------|
| Category source | Use BOTH `category` field AND ticker prefix fallback ✅ |
| Settlement data strategy | Option B: Background sync via TIS + backfill script ✅ |
| Purchase price buckets | <0.95, 0.95, 0.96, 0.97, 0.98, 0.99 ✅ |
| Week boundary | Sunday 23:59 UTC ✅ |

---

## Remaining Questions

None - ready for implementation!

---

## Approval

- [x] Design approved by user (2026-01-27)
- [ ] Phase 0: TIS modification + backfill script
- [ ] Phase 1: Backend API  
- [ ] Phase 2: Frontend UI
- [ ] Phase 3: Testing & Polish
