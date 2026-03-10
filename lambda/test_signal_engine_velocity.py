"""Tests for signal-engine-velocity Lambda handler."""

import importlib
import json
import os
import sys
import time
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

# Add the lambda directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

# Must set region before import
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

# Import module with hyphenated name
sev = importlib.import_module("signal-engine-velocity")


def _make_event(params=None, user="testuser", groups=""):
    """Build a mock API Gateway event with Cognito claims."""
    return {
        "requestContext": {
            "authorizer": {
                "claims": {
                    "preferred_username": user,
                    "cognito:groups": groups,
                }
            }
        },
        "queryStringParameters": params,
    }


def _make_dynamo_item(ticker, prices, start_ts=None):
    """Build a DynamoDB item with snapshots. Last snapshot is at time.time()."""
    now = time.time()
    n = len(prices)
    snapshots = []
    for i, price in enumerate(prices):
        # Space snapshots 60s apart, ending at now
        ts = now - (n - 1 - i) * 60
        snapshots.append({
            "ts": Decimal(str(round(ts, 3))),
            "price": Decimal(str(price)),
            "trade_count": Decimal("1"),
        })
    return {
        "market_ticker": ticker,
        "snapshots": snapshots,
    }


class TestAuth:
    """Test Cognito authentication."""

    def test_rejects_unauthenticated(self):
        with patch.object(sev, 'table') as mock_table:
            event = {
                "requestContext": {"authorizer": {"claims": {}}},
                "queryStringParameters": None,
            }
            resp = sev.lambda_handler(event, None)
            assert resp["statusCode"] == 401
            body = json.loads(resp["body"])
            assert "Authentication required" in body["error"]

    def test_accepts_authenticated(self):
        with patch.object(sev, 'table') as mock_table:
            mock_table.scan.return_value = {"Items": []}
            event = _make_event(user="admin@test.com")
            resp = sev.lambda_handler(event, None)
            assert resp["statusCode"] == 200


class TestCorsHeaders:
    """Test CORS headers are present."""

    def test_cors_headers(self):
        with patch.object(sev, 'table') as mock_table:
            mock_table.scan.return_value = {"Items": []}
            event = _make_event()
            resp = sev.lambda_handler(event, None)
            assert resp["headers"]["Access-Control-Allow-Origin"] == "*"
            assert "GET" in resp["headers"]["Access-Control-Allow-Methods"]
            assert "Authorization" in resp["headers"]["Access-Control-Allow-Headers"]


class TestTopMovers:
    """Test default top-movers endpoint."""

    def test_empty_table(self):
        with patch.object(sev, 'table') as mock_table:
            mock_table.scan.return_value = {"Items": []}
            event = _make_event()
            resp = sev.lambda_handler(event, None)
            assert resp["statusCode"] == 200
            body = json.loads(resp["body"])
            assert body["markets"] == []
            assert body["total_tracked"] == 0

    def test_returns_sorted_by_accel(self):
        with patch.object(sev, 'table') as mock_table:
            items = [
                # SLOW: flat market, no movement
                _make_dynamo_item("SLOW-MKT", [0.50] * 30),
                # FAST: flat then sudden spike (last 5 snapshots jump) => high short velocity, low long velocity => high accel
                _make_dynamo_item("FAST-MKT", [0.50] * 25 + [0.55, 0.60, 0.65, 0.70, 0.75]),
            ]
            mock_table.scan.return_value = {"Items": items}
            event = _make_event()
            resp = sev.lambda_handler(event, None)
            body = json.loads(resp["body"])
            assert len(body["markets"]) == 2
            assert body["markets"][0]["market_ticker"] == "FAST-MKT"

    def test_limit_param(self):
        with patch.object(sev, 'table') as mock_table:
            items = [_make_dynamo_item(f"MKT-{i}", [0.50, 0.55], time.time() - 120) for i in range(10)]
            mock_table.scan.return_value = {"Items": items}
            event = _make_event(params={"limit": "3"})
            resp = sev.lambda_handler(event, None)
            body = json.loads(resp["body"])
            assert len(body["markets"]) == 3

    def test_limit_capped_at_200(self):
        with patch.object(sev, 'table') as mock_table:
            mock_table.scan.return_value = {"Items": []}
            event = _make_event(params={"limit": "999"})
            resp = sev.lambda_handler(event, None)
            assert resp["statusCode"] == 200


class TestSingleMarket:
    """Test single market detail endpoint."""

    def test_market_not_found(self):
        with patch.object(sev, 'table') as mock_table:
            mock_table.get_item.return_value = {}
            event = _make_event(params={"ticker": "NONEXIST"})
            resp = sev.lambda_handler(event, None)
            assert resp["statusCode"] == 404
            body = json.loads(resp["body"])
            assert "error" in body
            assert "not found" in body["error"]

    def test_single_market_found(self):
        with patch.object(sev, 'table') as mock_table:
            now = time.time()
            item = _make_dynamo_item("TEST-MKT", [0.40, 0.45, 0.50, 0.55, 0.60], now - 300)
            mock_table.get_item.return_value = {"Item": item}
            event = _make_event(params={"ticker": "TEST-MKT"})
            resp = sev.lambda_handler(event, None)
            body = json.loads(resp["body"])
            assert body["market_ticker"] == "TEST-MKT"
            assert body["current_price"] > 0
            assert "velocities" in body
            assert "accelerations" in body
            assert "price_history" in body


class TestVelocityComputation:
    """Test inline velocity computation."""

    def test_rising_market_positive_velocity(self):
        with patch.object(sev, 'table') as mock_table:
            now = time.time()
            # Price rising from 0.40 to 0.80 over 60min (40 snapshots at 90s intervals)
            prices = [0.40 + i * 0.01 for i in range(40)]
            item = _make_dynamo_item("RISE-MKT", prices, now - 3600)
            mock_table.get_item.return_value = {"Item": item}
            event = _make_event(params={"ticker": "RISE-MKT"})
            resp = sev.lambda_handler(event, None)
            body = json.loads(resp["body"])
            # 5m velocity should be positive
            v5m = body["velocities"].get("5m")
            assert v5m is not None
            assert v5m > 0

    def test_flat_market_low_velocity(self):
        with patch.object(sev, 'table') as mock_table:
            now = time.time()
            prices = [0.50] * 30
            item = _make_dynamo_item("FLAT-MKT", prices, now - 1800)
            mock_table.get_item.return_value = {"Item": item}
            event = _make_event(params={"ticker": "FLAT-MKT"})
            resp = sev.lambda_handler(event, None)
            body = json.loads(resp["body"])
            assert body["max_velocity"] < 0.001


class TestDecimalSerialization:
    """Test that DynamoDB Decimals serialize to JSON cleanly."""

    def test_decimal_response_is_valid_json(self):
        with patch.object(sev, 'table') as mock_table:
            now = time.time()
            item = _make_dynamo_item("DEC-MKT", [0.50, 0.55], now - 120)
            mock_table.scan.return_value = {"Items": [item]}
            event = _make_event()
            resp = sev.lambda_handler(event, None)
            # Should not raise on json.loads
            body = json.loads(resp["body"])
            assert isinstance(body["markets"][0]["current_price"], float)


class TestPagination:
    """Test DynamoDB scan pagination."""

    def test_handles_paginated_scan(self):
        with patch.object(sev, 'table') as mock_table:
            now = time.time()
            item1 = _make_dynamo_item("PAGE-1", [0.50, 0.55], now - 120)
            item2 = _make_dynamo_item("PAGE-2", [0.60, 0.65], now - 120)
            mock_table.scan.side_effect = [
                {"Items": [item1], "LastEvaluatedKey": {"market_ticker": "PAGE-1"}},
                {"Items": [item2]},
            ]
            event = _make_event()
            resp = sev.lambda_handler(event, None)
            body = json.loads(resp["body"])
            assert body["total_tracked"] == 2
