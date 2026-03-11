"""
Signal Engine Market Classifier — uses Bedrock Claude Haiku to classify markets
as "surprise-tradable" or "not-surprise-tradable".

Surprise-tradable: outcome can be determined by a single discrete event at any time.
Not-surprise-tradable: tracks slow-moving/cumulative stats, only resolves by waiting.

Non-surprise markets still appear within 48h of close_time (leak detection window).

Invocation modes:
  EventBridge scheduled rule  → classifies unclassified velocity markets
  {"action": "backfill"}      → re-classifies ALL velocity markets
"""

import json
import os
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3

CLASSIFICATION_TABLE = os.environ["CLASSIFICATION_TABLE"]
METADATA_TABLE = os.environ.get("METADATA_TABLE", "production-kalshi-market-metadata")
VELOCITY_TABLE = os.environ.get("VELOCITY_TABLE", "production-signal-engine-velocity")
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")
CLASSIFY_CONCURRENCY = int(os.environ.get("CLASSIFY_CONCURRENCY", "8"))
CLASSIFICATION_TTL_DAYS = 30

EXCLUDED_CATEGORIES = {"crypto", "mentions", "climate and weather", "financials", "sports"}

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")
classification_table = dynamodb.Table(CLASSIFICATION_TABLE)
metadata_table = dynamodb.Table(METADATA_TABLE)
velocity_table = dynamodb.Table(VELOCITY_TABLE)

SYSTEM_PROMPT = """You classify prediction markets. Given a market's title, resolution rules, and early close condition, determine if it is "surprise-tradable" or not.

SURPRISE-TRADABLE (true): The outcome can be determined by a single discrete event that could happen at any time before the end date. A surprise or breaking news could instantly move this market or resolve it.
Examples: "Will senator resign by Dec 31?", "Will there be a Category 5 hurricane?", "Will X be indicted?", "Will the Fed cut rates at the next meeting?", "Will Congress pass bill X?"

NOT SURPRISE-TRADABLE (false): The outcome is determined by a slow-moving cumulative statistic, average, or measurement that only resolves by waiting until the measurement date. No single event can instantly determine the outcome.
Examples: "Average gas prices above $3.50 by Dec 31", "GDP growth above 3%", "President approval rating at specific date", "Average temperature above X"

Respond with ONLY a JSON object, no other text:
{"surprise": true, "reason": "can resolve instantly if senator resigns"}"""


def _classify_one(title, rules_primary, early_close_condition):
    """Call Bedrock to classify a single market. Returns (surprise_bool, reason_str)."""
    user_msg = (
        f"Title: {title}\n"
        f"Rules: {rules_primary or 'N/A'}\n"
        f"Early Close: {early_close_condition or 'None'}"
    )

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 100,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_msg}],
        "temperature": 0,
    })

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=body,
    )
    result_text = json.loads(response["body"].read())["content"][0]["text"].strip()

    # Parse JSON response
    try:
        # Handle case where model wraps JSON in markdown code block
        text = result_text
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        parsed = json.loads(text)
        return bool(parsed.get("surprise", False)), str(parsed.get("reason", "unknown"))[:200]
    except (json.JSONDecodeError, IndexError):
        print(f"classifier: failed to parse LLM response: {result_text[:200]}")
        # Conservative default: treat as surprise-tradable (don't filter it out)
        return True, f"parse_error: {result_text[:100]}"


def _scan_all(table_obj, projection=None):
    """Scan an entire DynamoDB table."""
    items = []
    params = {}
    if projection:
        expr_names = {}
        expr_parts = []
        for i, field in enumerate(projection):
            alias = f"#p{i}"
            expr_names[alias] = field
            expr_parts.append(alias)
        params["ProjectionExpression"] = ", ".join(expr_parts)
        params["ExpressionAttributeNames"] = expr_names
    while True:
        response = table_obj.scan(**params)
        items.extend(response.get("Items", []))
        if "LastEvaluatedKey" not in response:
            break
        params["ExclusiveStartKey"] = response["LastEvaluatedKey"]
    return items


def _batch_get_metadata(tickers):
    """Batch-load metadata fields needed for classification."""
    result = {}
    unique = list(set(tickers))
    for i in range(0, len(unique), 100):
        chunk = unique[i:i + 100]
        response = dynamodb.batch_get_item(
            RequestItems={
                METADATA_TABLE: {
                    "Keys": [{"market_ticker": t} for t in chunk],
                    "ProjectionExpression": "#mt, #cat, #rp, #ecc, #ct, #ti, #et",
                    "ExpressionAttributeNames": {
                        "#mt": "market_ticker",
                        "#cat": "category",
                        "#rp": "rules_primary",
                        "#ecc": "early_close_condition",
                        "#ct": "close_time",
                        "#ti": "title",
                        "#et": "event_ticker",
                    },
                }
            }
        )
        for item in response.get("Responses", {}).get(METADATA_TABLE, []):
            ticker = item["market_ticker"]
            result[ticker] = {
                "category": str(item.get("category", "unknown")).lower(),
                "title": str(item.get("title", "")),
                "rules_primary": str(item.get("rules_primary", "")),
                "early_close_condition": str(item.get("early_close_condition", "")),
                "close_time": int(item.get("close_time", 0)),
                "event_ticker": str(item.get("event_ticker", "")),
            }
    return result


def _batch_get_existing_classifications(tickers):
    """Batch-load existing classifications to find which are already done."""
    result = {}
    unique = list(set(tickers))
    for i in range(0, len(unique), 100):
        chunk = unique[i:i + 100]
        response = dynamodb.batch_get_item(
            RequestItems={
                CLASSIFICATION_TABLE: {
                    "Keys": [{"market_ticker": t} for t in chunk],
                    "ProjectionExpression": "market_ticker, classified_at",
                }
            }
        )
        for item in response.get("Responses", {}).get(CLASSIFICATION_TABLE, []):
            result[item["market_ticker"]] = int(item.get("classified_at", 0))
    return result


def _classify_and_store(ticker, meta):
    """Classify one market and write result to DynamoDB."""
    surprise, reason = _classify_one(
        meta["title"], meta["rules_primary"], meta["early_close_condition"]
    )
    now = int(time.time())

    classification_table.put_item(Item={
        "market_ticker": ticker,
        "surprise_tradable": surprise,
        "reason": reason,
        "close_time": meta["close_time"],
        "event_ticker": meta["event_ticker"],
        "title": meta["title"],
        "classified_at": now,
        "ttl": now + CLASSIFICATION_TTL_DAYS * 86400,
    })

    return ticker, surprise, reason


def _classify_specific_tickers(tickers, context):
    """Classify a specific list of tickers (called from real-time lifecycle trigger)."""
    start = time.time()
    tickers = list(set(tickers))  # dedupe
    print(f"classifier: classify_tickers mode, {len(tickers)} tickers")

    # Load metadata
    metadata = _batch_get_metadata(tickers)
    print(f"classifier: {len(metadata)} tickers with metadata")

    # Filter out excluded categories and markets without titles
    eligible = {
        t: m for t, m in metadata.items()
        if m["category"] not in EXCLUDED_CATEGORIES and m["title"]
    }
    print(f"classifier: {len(eligible)} eligible (after category exclusion)")

    # Skip already-classified (fresh) markets
    existing = _batch_get_existing_classifications(list(eligible.keys()))
    now = time.time()
    stale_cutoff = now - CLASSIFICATION_TTL_DAYS * 86400
    to_classify = {
        t: m for t, m in eligible.items()
        if t not in existing or existing[t] < stale_cutoff
    }
    print(f"classifier: {len(existing)} already classified, {len(to_classify)} to classify")

    if not to_classify:
        print("classifier: nothing to classify")
        return {"statusCode": 200, "body": json.dumps({
            "action": "classify_tickers", "classified": 0,
            "elapsed": round(time.time() - start, 1)
        })}

    classified = 0
    errors = 0
    with ThreadPoolExecutor(max_workers=CLASSIFY_CONCURRENCY) as executor:
        futures = {
            executor.submit(_classify_and_store, ticker, meta): ticker
            for ticker, meta in to_classify.items()
        }
        for future in as_completed(futures):
            ticker = futures[future]
            try:
                t, surprise, reason = future.result()
                classified += 1
                print(f"classifier: {t} → surprise={surprise} ({reason})")
            except Exception as e:
                errors += 1
                print(f"classifier: ERROR {ticker}: {e}")

    elapsed = round(time.time() - start, 1)
    print(f"classifier: done. classified={classified}, errors={errors}, elapsed={elapsed}s")
    return {"statusCode": 200, "body": json.dumps({
        "action": "classify_tickers", "classified": classified,
        "errors": errors, "elapsed": elapsed,
    })}


def lambda_handler(event, context):
    start = time.time()
    action = "classify_new"

    # EventBridge scheduled events won't have 'action'
    if isinstance(event, dict) and "action" in event:
        action = event["action"]

    print(f"classifier: action={action}")

    # Real-time: classify specific tickers (from trade-capture lifecycle trigger)
    if action == "classify_tickers":
        tickers = event.get("tickers", [])
        if not tickers:
            return {"statusCode": 400, "body": json.dumps({"error": "no tickers provided"})}
        return _classify_specific_tickers(tickers, context)

    try:
        # 1. Get all tickers from velocity table
        velocity_items = _scan_all(velocity_table, projection=["market_ticker"])
        velocity_tickers = [item["market_ticker"] for item in velocity_items]
        print(f"classifier: {len(velocity_tickers)} tickers in velocity table")

        # 2. Load metadata for all
        metadata = _batch_get_metadata(velocity_tickers)
        print(f"classifier: {len(metadata)} tickers with metadata")

        # 3. Filter out excluded categories and markets without titles
        eligible = {
            t: m for t, m in metadata.items()
            if m["category"] not in EXCLUDED_CATEGORIES and m["title"]
        }
        print(f"classifier: {len(eligible)} eligible (after category exclusion)")

        # 4. For classify_new, skip already-classified markets with fresh classifications
        if action == "classify_new":
            existing = _batch_get_existing_classifications(list(eligible.keys()))
            now = time.time()
            stale_cutoff = now - CLASSIFICATION_TTL_DAYS * 86400
            to_classify = {
                t: m for t, m in eligible.items()
                if t not in existing or existing[t] < stale_cutoff
            }
            print(f"classifier: {len(existing)} already classified, {len(to_classify)} new/stale")
        else:
            # backfill: classify everything
            to_classify = eligible
            print(f"classifier: backfill mode, classifying all {len(to_classify)}")

        if not to_classify:
            print("classifier: nothing to classify")
            return {"statusCode": 200, "body": json.dumps({
                "classified": 0, "elapsed": round(time.time() - start, 1)
            })}

        # 5. Classify with thread-pool concurrency
        classified = 0
        errors = 0

        with ThreadPoolExecutor(max_workers=CLASSIFY_CONCURRENCY) as executor:
            futures = {
                executor.submit(_classify_and_store, ticker, meta): ticker
                for ticker, meta in to_classify.items()
            }
            for future in as_completed(futures):
                ticker = futures[future]
                try:
                    t, surprise, reason = future.result()
                    classified += 1
                    if classified % 100 == 0:
                        elapsed = time.time() - start
                        remaining = context.get_remaining_time_in_millis() / 1000
                        print(f"classifier: progress {classified}/{len(to_classify)} "
                              f"({elapsed:.1f}s elapsed, {remaining:.0f}s remaining)")
                except Exception as e:
                    errors += 1
                    print(f"classifier: ERROR {ticker}: {e}")
                    traceback.print_exc()

        elapsed = round(time.time() - start, 1)
        print(f"classifier: done. classified={classified}, errors={errors}, elapsed={elapsed}s")

        return {
            "statusCode": 200,
            "body": json.dumps({
                "action": action,
                "classified": classified,
                "errors": errors,
                "total_eligible": len(eligible),
                "elapsed": elapsed,
            }),
        }

    except Exception as e:
        print(f"classifier: FATAL ERROR: {e}")
        traceback.print_exc()
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
