"""
Signal Engine Velocity API — serves velocity/acceleration data for dashboard visualization.

Authenticated via Cognito (same as all dashboard APIs).
Admin-only: all velocity data is market-wide, not user-specific.

Query params:
  ?ticker=XYZ     → single market detail with full velocity profile
  ?mode=all       → all markets with velocity data (for graph view)
  (default)       → top movers ranked by acceleration
  ?limit=N        → override default top-N (max 200)
"""

import json
import os
import time
from decimal import Decimal

import boto3

VELOCITY_TABLE = os.environ.get("VELOCITY_TABLE", "production-signal-engine-velocity")
TOP_N = int(os.environ.get("TOP_N", "50"))

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
table = dynamodb.Table(VELOCITY_TABLE)


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

def _get_top_movers(limit):
    now = time.time()
    items = []
    params = {}
    while True:
        response = table.scan(**params)
        items.extend(response.get("Items", []))
        if "LastEvaluatedKey" not in response:
            break
        params["ExclusiveStartKey"] = response["LastEvaluatedKey"]

    summaries = [_market_summary(item, now) for item in items]
    summaries = [s for s in summaries if s["snapshot_count"] >= 2]
    summaries.sort(key=lambda s: s["max_accel"], reverse=True)

    return {
        "markets": summaries[:limit],
        "total_tracked": len(summaries),
        "generated_at": now,
    }


def _get_single_market(ticker):
    now = time.time()
    response = table.get_item(Key={"market_ticker": ticker})
    item = response.get("Item")
    if not item:
        return None
    return _market_summary(item, now)


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
        mode = params.get("mode", "top")
        limit = min(int(params.get("limit", TOP_N)), 200)

        print(f"signal-engine-velocity: user={current_user} ticker={ticker} mode={mode} limit={limit}")

        if ticker:
            data = _get_single_market(ticker)
            if data is None:
                return cors_response(404, {"error": f"Market {ticker} not found"})
        elif mode == "all":
            data = _get_top_movers(limit=9999)
        else:
            data = _get_top_movers(limit=limit)

        return cors_response(200, data)

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return cors_response(500, {"error": str(e)})
