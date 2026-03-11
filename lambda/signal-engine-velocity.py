"""
Signal Engine Velocity API — serves cluster-level velocity/acceleration data.

Authenticated via Cognito (same as all dashboard APIs).

Query params:
  (default)            → top clusters ranked by acceleration (cluster view)
  ?event=EVT_TICKER    → all markets within a single cluster (drill-down)
  ?ticker=XYZ          → single market detail with full velocity profile
  ?mode=all            → all clusters (no limit)
  ?limit=N             → override default top-N (max 200)
"""

import json
import os
import time
from collections import defaultdict
from decimal import Decimal

import boto3

VELOCITY_TABLE = os.environ.get("VELOCITY_TABLE", "production-signal-engine-velocity")
METADATA_TABLE = os.environ.get("METADATA_TABLE", "production-kalshi-market-metadata")
TOP_N = int(os.environ.get("TOP_N", "50"))

# Categories to exclude from the velocity dashboard
EXCLUDED_CATEGORIES = {"crypto", "mentions", "climate and weather", "financials", "sports"}

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
table = dynamodb.Table(VELOCITY_TABLE)
metadata_table = dynamodb.Table(METADATA_TABLE)


# ── Velocity Computation ────────────────────────────────────────────────────

WINDOWS = [
    ("5m", 5 / 60), ("15m", 15 / 60), ("30m", 30 / 60),
    ("1h", 1.0), ("1.5h", 1.5), ("2h", 2.0), ("2.5h", 2.5),
    ("3h", 3.0), ("4h", 4.0), ("5h", 5.0), ("6h", 6.0),
    ("8h", 8.0), ("12h", 12.0), ("18h", 18.0), ("24h", 24.0),
]

ACCEL_PAIRS = [
    ("5m", "1h"), ("15m", "2h"), ("30m", "3h"),
    ("1h", "6h"), ("1.5h", "8h"), ("2h", "12h"),
    ("3h", "18h"), ("4h", "24h"), ("6h", "24h"),
]


def _compute_velocities(snapshots, now):
    if not snapshots:
        return {}
    sorted_snaps = sorted(snapshots, key=lambda s: s["ts"])
    current = sorted_snaps[-1]
    velocities = {}
    for name, hours in WINDOWS:
        window_start = now - (hours * 3600)
        earliest = None
        for snap in sorted_snaps:
            if snap["ts"] >= window_start:
                earliest = snap
                break
        if earliest is None or earliest["ts"] == current["ts"]:
            velocities[name] = None
            continue
        elapsed_hours = (current["ts"] - earliest["ts"]) / 3600
        if elapsed_hours < 0.001:
            velocities[name] = None
            continue
        velocities[name] = (current["price"] - earliest["price"]) / elapsed_hours
    return velocities


def _compute_accelerations(velocities):
    accels = {}
    for short_name, long_name in ACCEL_PAIRS:
        key = f"{short_name}_vs_{long_name}"
        v_short = velocities.get(short_name)
        v_long = velocities.get(long_name)
        if v_short is None or v_long is None:
            accels[key] = None
            continue
        abs_long = abs(v_long)
        abs_short = abs(v_short)
        if abs_long < 0.001:
            accels[key] = 1.0 if abs_short < 0.001 else abs_short / 0.001
        else:
            accels[key] = abs_short / abs_long
    return accels


def _market_summary(item, now):
    ticker = item["market_ticker"]
    snapshots_raw = item.get("snapshots", [])
    snapshots = [
        {"ts": float(s["ts"]), "price": float(s["price"]), "trade_count": int(s.get("trade_count", 1))}
        for s in snapshots_raw
    ]
    if not snapshots:
        return {"market_ticker": ticker, "current_price": 0, "velocities": {}, "accelerations": {},
                "max_velocity": 0, "max_accel": 0, "snapshot_count": 0, "data_span_hours": 0,
                "last_update": 0, "price_history": []}

    sorted_snaps = sorted(snapshots, key=lambda s: s["ts"])
    current_price = sorted_snaps[-1]["price"]
    data_span_hours = (sorted_snaps[-1]["ts"] - sorted_snaps[0]["ts"]) / 3600 if len(sorted_snaps) > 1 else 0

    velocities = _compute_velocities(snapshots, now)
    accelerations = _compute_accelerations(velocities)

    valid_v = [abs(v) for v in velocities.values() if v is not None]
    valid_a = [a for a in accelerations.values() if a is not None]

    return {
        "market_ticker": ticker,
        "current_price": round(current_price, 4),
        "velocities": {k: round(v, 6) if v is not None else None for k, v in velocities.items()},
        "accelerations": {k: round(a, 2) if a is not None else None for k, a in accelerations.items()},
        "max_velocity": round(max(valid_v), 6) if valid_v else 0,
        "max_accel": round(max(valid_a), 2) if valid_a else 0,
        "snapshot_count": len(snapshots),
        "data_span_hours": round(data_span_hours, 1),
        "last_update": sorted_snaps[-1]["ts"],
        "price_history": [
            {"ts": s["ts"], "price": round(s["price"], 4)}
            for s in sorted_snaps[-60:]
        ],
    }


# ── Routes ──────────────────────────────────────────────────────────────────

def _load_metadata(tickers):
    """Batch-load category and event_ticker from market-metadata table."""
    result = {}
    for chunk_start in range(0, len(tickers), 100):
        chunk = tickers[chunk_start:chunk_start + 100]
        keys = [{"market_ticker": t} for t in chunk]
        response = dynamodb.meta.client.batch_get_item(
            RequestItems={
                METADATA_TABLE: {
                    "Keys": [{k: {"S": v} for k, v in key.items()} for key in keys],
                    "ProjectionExpression": "market_ticker, category, event_ticker",
                }
            }
        )
        for item in response.get("Responses", {}).get(METADATA_TABLE, []):
            ticker = item["market_ticker"]["S"]
            result[ticker] = {
                "category": item.get("category", {}).get("S", "unknown").lower(),
                "event_ticker": item.get("event_ticker", {}).get("S", ""),
            }
    return result


def _get_clusters(limit):
    """Aggregate markets into clusters by event_ticker, filter excluded categories."""
    now = time.time()

    # 1. Scan all velocity items
    items = []
    params = {}
    while True:
        response = table.scan(**params)
        items.extend(response.get("Items", []))
        if "LastEvaluatedKey" not in response:
            break
        params["ExclusiveStartKey"] = response["LastEvaluatedKey"]

    if not items:
        return {"clusters": [], "total_clusters": 0, "total_markets": 0, "generated_at": now}

    # 2. Batch-load metadata (category + event_ticker) for all tickers
    all_tickers = [item["market_ticker"] for item in items]
    metadata = _load_metadata(all_tickers)

    # 3. Compute market summaries, filtering out excluded categories
    clusters_map = defaultdict(list)  # event_ticker → [market_summary]
    excluded_count = 0

    for item in items:
        ticker = item["market_ticker"]
        meta = metadata.get(ticker, {})
        category = meta.get("category", "unknown")
        event_ticker = meta.get("event_ticker", "")

        if category in EXCLUDED_CATEGORIES:
            excluded_count += 1
            continue
        if not event_ticker:
            continue

        summary = _market_summary(item, now)
        if summary["snapshot_count"] < 2:
            continue

        summary["category"] = category
        summary["event_ticker"] = event_ticker
        clusters_map[event_ticker].append(summary)

    # 4. Build cluster-level summaries
    clusters = []
    for event_ticker, markets in clusters_map.items():
        if not markets:
            continue

        max_accel = max(m["max_accel"] for m in markets)
        max_velocity = max(m["max_velocity"] for m in markets)
        avg_price = sum(m["current_price"] for m in markets) / len(markets)
        latest_update = max(m["last_update"] for m in markets)
        # Use the most active market's sparkline as representative
        top_market = max(markets, key=lambda m: m["max_accel"])
        category = markets[0]["category"]

        clusters.append({
            "event_ticker": event_ticker,
            "category": category,
            "market_count": len(markets),
            "max_accel": max_accel,
            "max_velocity": max_velocity,
            "avg_price": round(avg_price, 4),
            "last_update": latest_update,
            "top_market_ticker": top_market["market_ticker"],
            "top_market_price": top_market["current_price"],
            "price_history": top_market["price_history"],
            "accelerations": top_market["accelerations"],
        })

    clusters.sort(key=lambda c: c["max_accel"], reverse=True)

    return {
        "clusters": clusters[:limit],
        "total_clusters": len(clusters),
        "total_markets": sum(c["market_count"] for c in clusters),
        "excluded_count": excluded_count,
        "generated_at": now,
    }


def _get_cluster_markets(event_ticker):
    """Get all markets for a specific cluster (event_ticker)."""
    now = time.time()

    # Scan velocity table for all items (we need to match by event_ticker from metadata)
    items = []
    params = {}
    while True:
        response = table.scan(**params)
        items.extend(response.get("Items", []))
        if "LastEvaluatedKey" not in response:
            break
        params["ExclusiveStartKey"] = response["LastEvaluatedKey"]

    all_tickers = [item["market_ticker"] for item in items]
    metadata = _load_metadata(all_tickers)

    markets = []
    for item in items:
        ticker = item["market_ticker"]
        meta = metadata.get(ticker, {})
        if meta.get("event_ticker") != event_ticker:
            continue
        summary = _market_summary(item, now)
        summary["event_ticker"] = event_ticker
        summary["category"] = meta.get("category", "unknown")
        markets.append(summary)

    markets.sort(key=lambda m: m["max_accel"], reverse=True)

    return {
        "event_ticker": event_ticker,
        "markets": markets,
        "market_count": len(markets),
        "generated_at": now,
    }


def _get_single_market(ticker):
    now = time.time()
    response = table.get_item(Key={"market_ticker": ticker})
    item = response.get("Item")
    if not item:
        return None
    summary = _market_summary(item, now)
    # Enrich with metadata
    meta = _load_metadata([ticker]).get(ticker, {})
    summary["event_ticker"] = meta.get("event_ticker", "")
    summary["category"] = meta.get("category", "unknown")
    return summary


# ── Lambda Handler ──────────────────────────────────────────────────────────

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def cors_response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Device-Token",
            "Access-Control-Allow-Methods": "GET,OPTIONS",
        },
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def lambda_handler(event, context):
    try:
        # ── Auth: require authenticated user ──
        claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
        current_user = claims.get("preferred_username", "")
        if not current_user:
            return cors_response(401, {"error": "Authentication required"})

        # ── Parse query params ──
        params = event.get("queryStringParameters") or {}
        ticker = params.get("ticker", "").strip()
        event_ticker = params.get("event", "").strip()
        mode = params.get("mode", "top")
        limit = min(int(params.get("limit", TOP_N)), 200)

        print(f"signal-engine-velocity: user={current_user} ticker={ticker} event={event_ticker} mode={mode} limit={limit}")

        if ticker:
            # Single market drill-down
            data = _get_single_market(ticker)
            if data is None:
                return cors_response(404, {"error": f"Market {ticker} not found"})
        elif event_ticker:
            # Cluster drill-down — all markets in this event
            data = _get_cluster_markets(event_ticker)
        elif mode == "all":
            data = _get_clusters(limit=9999)
        else:
            # Default: cluster view
            data = _get_clusters(limit=limit)

        return cors_response(200, data)

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return cors_response(500, {"error": str(e)})
