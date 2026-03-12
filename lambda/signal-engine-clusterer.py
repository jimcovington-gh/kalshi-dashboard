"""
Signal Engine AI Clusterer — uses Bedrock Claude Haiku to group markets
into semantic clusters that cross event boundaries.

Markets can belong to MULTIPLE clusters. Clusters have AI-generated names.

Invocation modes:
  {"action": "recluster"}       → full recluster of all active velocity markets
  {"action": "assign_new", "tickers": [...]}  → assign new markets to existing clusters
  EventBridge scheduled rule    → periodic recluster (every 30 min)
"""

import hashlib
import json
import os
import time
import traceback

import boto3

CLUSTER_TABLE = os.environ["CLUSTER_TABLE"]
METADATA_TABLE = os.environ.get("METADATA_TABLE", "production-kalshi-market-metadata")
VELOCITY_TABLE = os.environ.get("VELOCITY_TABLE", "production-signal-engine-velocity")
CLASSIFICATION_TABLE = os.environ.get("CLASSIFICATION_TABLE", "production-signal-engine-market-class")
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")

EXCLUDED_CATEGORIES = {"crypto", "mentions", "climate and weather", "financials", "sports"}
# Max markets to send per Bedrock call (context window management)
BATCH_SIZE = 75
CLUSTER_TTL_DAYS = 7

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")
cluster_table = dynamodb.Table(CLUSTER_TABLE)
metadata_table = dynamodb.Table(METADATA_TABLE)
velocity_table = dynamodb.Table(VELOCITY_TABLE)
classification_table = dynamodb.Table(CLASSIFICATION_TABLE)


CLUSTER_SYSTEM_PROMPT = """You group prediction markets into thematic clusters. Given a list of markets (each with a ticker, title, event_ticker, and category), group them into meaningful clusters.

RULES:
1. Group markets that are about the SAME topic, person, policy, or event — even if they have different event_tickers.
2. A market can belong to MULTIPLE clusters if it spans multiple themes.
3. Each cluster should have 2+ markets. Don't create singleton clusters.
4. Give each cluster a short, descriptive name (3-8 words). The name should describe the THEME, not just repeat a ticker.
5. Include a brief 1-sentence description of what unifies the cluster.

GOOD cluster names: "Trump Tariff Policy", "Fed Interest Rate Decisions", "Ukraine Conflict Escalation", "NCAA March Madness Outcomes", "Supreme Court Rulings 2026"
BAD cluster names: "KXTARIFF Markets", "Various Political Events", "Miscellaneous"

Respond with ONLY a JSON array. Each element:
{"name": "Cluster Name", "description": "What unifies these markets", "tickers": ["TICKER1", "TICKER2", ...]}

If a market doesn't fit any cluster, omit it (it will remain unclustered)."""


ASSIGN_SYSTEM_PROMPT = """You assign new prediction markets to existing thematic clusters. Given:
1. A list of EXISTING clusters (each with name, description, and sample market titles)
2. A list of NEW markets (each with ticker, title, event_ticker)

For each new market, decide which existing cluster(s) it belongs to, or if it needs a NEW cluster.

RULES:
1. A market can belong to MULTIPLE clusters.
2. Only create a new cluster if the market truly doesn't fit any existing cluster.
3. New cluster names should be 3-8 words, descriptive of the theme.

Respond with ONLY a JSON object:
{
  "assignments": [{"ticker": "MKTTICKER", "cluster_names": ["Existing Cluster", "Another Cluster"]}],
  "new_clusters": [{"name": "New Cluster Name", "description": "What unifies it", "tickers": ["T1", "T2"]}]
}

If a market doesn't fit any cluster and can't form a new one (no related peers), omit it from assignments."""


def _generate_cluster_id(name):
    """Deterministic cluster ID from name."""
    return hashlib.sha256(name.lower().strip().encode()).hexdigest()[:16]


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
    """Batch-load metadata for tickers."""
    result = {}
    unique = list(set(tickers))
    for i in range(0, len(unique), 100):
        chunk = unique[i:i + 100]
        response = dynamodb.batch_get_item(
            RequestItems={
                METADATA_TABLE: {
                    "Keys": [{"market_ticker": t} for t in chunk],
                    "ProjectionExpression": "#mt, #cat, #ti, #et",
                    "ExpressionAttributeNames": {
                        "#mt": "market_ticker",
                        "#cat": "category",
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
                "event_ticker": str(item.get("event_ticker", "")),
            }
    return result


def _batch_get_classifications(tickers):
    """Batch-load existing surprise classifications."""
    result = {}
    unique = list(set(tickers))
    for i in range(0, len(unique), 100):
        chunk = unique[i:i + 100]
        response = dynamodb.batch_get_item(
            RequestItems={
                CLASSIFICATION_TABLE: {
                    "Keys": [{"market_ticker": t} for t in chunk],
                    "ProjectionExpression": "market_ticker, surprise_tradable",
                }
            }
        )
        for item in response.get("Responses", {}).get(CLASSIFICATION_TABLE, []):
            result[item["market_ticker"]] = bool(item.get("surprise_tradable", True))
    return result


def _repair_truncated_json(text):
    """Attempt to repair JSON truncated mid-array by Bedrock output token limit."""
    # Find the last complete object in a JSON array
    # Strategy: find last '}' that closes an array element, then close the array
    last_close = text.rfind('}')
    if last_close == -1:
        return None
    # Try progressively shorter truncations
    for end in range(last_close + 1, max(last_close - 200, 0), -1):
        candidate = text[:end].rstrip().rstrip(',')
        if not candidate.endswith('}'):
            continue
        try:
            return json.loads(candidate + ']')
        except json.JSONDecodeError:
            continue
    return None


def _call_bedrock(system_prompt, user_msg, max_tokens=8192):
    """Call Bedrock Claude Haiku and return parsed JSON."""
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_msg}],
        "temperature": 0,
    })

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=body,
    )
    resp_body = json.loads(response["body"].read())
    result_text = resp_body["content"][0]["text"].strip()
    stop_reason = resp_body.get("stop_reason", "")

    # Parse JSON, handling markdown code blocks
    text = result_text
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # If output was truncated (hit max_tokens), try to repair
        if stop_reason == "max_tokens":
            print(f"clusterer: output truncated (max_tokens), attempting JSON repair")
            repaired = _repair_truncated_json(text)
            if repaired is not None:
                print(f"clusterer: repaired truncated JSON, got {len(repaired)} items")
                return repaired
        raise


def _get_active_markets():
    """Get all active velocity markets with metadata, filtered by category and classification."""
    # 1. Get all velocity tickers
    velocity_items = _scan_all(velocity_table, projection=["market_ticker"])
    velocity_tickers = [item["market_ticker"] for item in velocity_items]
    print(f"clusterer: {len(velocity_tickers)} tickers in velocity table")

    if not velocity_tickers:
        return {}

    # 2. Load metadata
    metadata = _batch_get_metadata(velocity_tickers)

    # 3. Filter excluded categories and markets without titles
    eligible = {
        t: m for t, m in metadata.items()
        if m["category"] not in EXCLUDED_CATEGORIES and m["title"]
    }
    print(f"clusterer: {len(eligible)} eligible after category filter")

    # 4. Filter to surprise-tradable only (non-surprise markets don't need clustering)
    classifications = _batch_get_classifications(list(eligible.keys()))
    result = {}
    for t, m in eligible.items():
        is_surprise = classifications.get(t, True)  # default surprise if unclassified
        if is_surprise:
            result[t] = m
    print(f"clusterer: {len(result)} surprise-tradable markets to cluster")
    return result


def _format_markets_for_prompt(markets):
    """Format market dict into a compact string for the LLM prompt."""
    lines = []
    for ticker, meta in sorted(markets.items()):
        lines.append(f"- {ticker} | {meta['event_ticker']} | {meta['category']} | {meta['title']}")
    return "\n".join(lines)


def _store_clusters(clusters_data, active_tickers):
    """Write cluster assignments to DynamoDB. Removes stale clusters."""
    now = int(time.time())
    ttl = now + CLUSTER_TTL_DAYS * 86400

    # Build the new cluster set
    new_cluster_ids = set()
    for cluster in clusters_data:
        name = cluster["name"]
        cluster_id = _generate_cluster_id(name)
        new_cluster_ids.add(cluster_id)

        # Filter to only active tickers
        member_tickers = [t for t in cluster.get("tickers", []) if t in active_tickers]
        if not member_tickers:
            continue

        cluster_table.put_item(Item={
            "cluster_id": cluster_id,
            "cluster_name": name,
            "description": cluster.get("description", ""),
            "member_tickers": member_tickers,
            "market_count": len(member_tickers),
            "updated_at": now,
            "ttl": ttl,
        })

    # Delete stale clusters not in the new set
    existing_clusters = _scan_all(cluster_table, projection=["cluster_id"])
    stale_count = 0
    for item in existing_clusters:
        cid = item["cluster_id"]
        if cid not in new_cluster_ids:
            cluster_table.delete_item(Key={"cluster_id": cid})
            stale_count += 1

    print(f"clusterer: stored {len(new_cluster_ids)} clusters, deleted {stale_count} stale")
    return len(new_cluster_ids)


def _recluster(context):
    """Full recluster: get all active markets, call Bedrock to cluster them."""
    start = time.time()
    markets = _get_active_markets()
    if not markets:
        return {"statusCode": 200, "body": json.dumps({"clusters": 0, "markets": 0})}

    active_tickers = set(markets.keys())

    # Split into batches if too many markets
    market_list = list(markets.items())
    all_clusters = []

    for batch_start in range(0, len(market_list), BATCH_SIZE):
        batch = dict(market_list[batch_start:batch_start + BATCH_SIZE])
        prompt_text = _format_markets_for_prompt(batch)

        print(f"clusterer: sending batch of {len(batch)} markets to Bedrock "
              f"({batch_start+1}-{batch_start+len(batch)} of {len(markets)})")

        try:
            result = _call_bedrock(CLUSTER_SYSTEM_PROMPT, prompt_text)
            if isinstance(result, list):
                all_clusters.extend(result)
                print(f"clusterer: Bedrock returned {len(result)} clusters for this batch")
            else:
                print(f"clusterer: unexpected Bedrock response type: {type(result)}")
        except Exception as e:
            print(f"clusterer: Bedrock error on batch: {e}")
            traceback.print_exc()

    if not all_clusters:
        print("clusterer: no clusters returned from Bedrock")
        return {"statusCode": 200, "body": json.dumps({"clusters": 0, "markets": len(markets)})}

    # Merge clusters with the same name across batches
    merged = {}
    for cluster in all_clusters:
        name = cluster.get("name", "").strip()
        if not name:
            continue
        key = name.lower()
        if key in merged:
            # Merge tickers
            existing_tickers = set(merged[key].get("tickers", []))
            existing_tickers.update(cluster.get("tickers", []))
            merged[key]["tickers"] = list(existing_tickers)
        else:
            merged[key] = cluster

    final_clusters = list(merged.values())
    print(f"clusterer: {len(final_clusters)} clusters after merging duplicates")

    stored = _store_clusters(final_clusters, active_tickers)

    elapsed = round(time.time() - start, 1)
    print(f"clusterer: recluster complete. {stored} clusters, {len(markets)} markets, {elapsed}s")

    return {"statusCode": 200, "body": json.dumps({
        "action": "recluster",
        "clusters": stored,
        "markets": len(markets),
        "elapsed": elapsed,
    })}


def _assign_new(tickers, context):
    """Assign newly created markets to existing clusters (incremental update)."""
    start = time.time()
    tickers = list(set(tickers))
    print(f"clusterer: assign_new for {len(tickers)} tickers")

    # Load metadata for new markets
    metadata = _batch_get_metadata(tickers)
    eligible = {
        t: m for t, m in metadata.items()
        if m["category"] not in EXCLUDED_CATEGORIES and m["title"]
    }

    if not eligible:
        print("clusterer: no eligible new markets")
        return {"statusCode": 200, "body": json.dumps({"assigned": 0})}

    # Load existing clusters
    existing_clusters = _scan_all(cluster_table)
    if not existing_clusters:
        # No clusters yet — do a full recluster instead
        print("clusterer: no existing clusters, triggering full recluster")
        return _recluster(context)

    # Build cluster context for the prompt
    cluster_context_lines = []
    cluster_name_to_id = {}
    for c in existing_clusters:
        name = c.get("cluster_name", "")
        desc = c.get("description", "")
        members = c.get("member_tickers", [])
        cluster_name_to_id[name.lower()] = c["cluster_id"]
        sample = ", ".join(members[:5])
        cluster_context_lines.append(
            f"- \"{name}\": {desc} (members: {sample}{'...' if len(members) > 5 else ''})"
        )

    new_markets_text = _format_markets_for_prompt(eligible)

    user_msg = (
        f"EXISTING CLUSTERS:\n" +
        "\n".join(cluster_context_lines) +
        f"\n\nNEW MARKETS TO ASSIGN:\n{new_markets_text}"
    )

    try:
        result = _call_bedrock(ASSIGN_SYSTEM_PROMPT, user_msg)
    except Exception as e:
        print(f"clusterer: Bedrock error during assign_new: {e}")
        traceback.print_exc()
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

    now = int(time.time())
    ttl = now + CLUSTER_TTL_DAYS * 86400
    assigned_count = 0

    # Process assignments to existing clusters
    assignments = result.get("assignments", [])
    for assignment in assignments:
        ticker = assignment.get("ticker", "")
        cluster_names = assignment.get("cluster_names", [])
        for cname in cluster_names:
            cid = cluster_name_to_id.get(cname.lower())
            if not cid:
                continue
            # Find the cluster and add the ticker
            for c in existing_clusters:
                if c["cluster_id"] == cid:
                    members = c.get("member_tickers", [])
                    if ticker not in members:
                        members.append(ticker)
                        cluster_table.put_item(Item={
                            "cluster_id": cid,
                            "cluster_name": c["cluster_name"],
                            "description": c.get("description", ""),
                            "member_tickers": members,
                            "market_count": len(members),
                            "updated_at": now,
                            "ttl": ttl,
                        })
                        assigned_count += 1
                    break

    # Process new clusters
    new_clusters = result.get("new_clusters", [])
    for nc in new_clusters:
        name = nc.get("name", "").strip()
        if not name:
            continue
        member_tickers = [t for t in nc.get("tickers", []) if t in eligible]
        if len(member_tickers) < 2:
            continue
        cid = _generate_cluster_id(name)
        cluster_table.put_item(Item={
            "cluster_id": cid,
            "cluster_name": name,
            "description": nc.get("description", ""),
            "member_tickers": member_tickers,
            "market_count": len(member_tickers),
            "updated_at": now,
            "ttl": ttl,
        })
        assigned_count += len(member_tickers)

    elapsed = round(time.time() - start, 1)
    print(f"clusterer: assigned {assigned_count} market-cluster pairs, "
          f"{len(new_clusters)} new clusters, {elapsed}s")

    return {"statusCode": 200, "body": json.dumps({
        "action": "assign_new",
        "assigned": assigned_count,
        "new_clusters": len(new_clusters),
        "elapsed": elapsed,
    })}


def lambda_handler(event, context):
    action = "recluster"
    if isinstance(event, dict) and "action" in event:
        action = event["action"]

    print(f"clusterer: action={action}")

    try:
        if action == "assign_new":
            tickers = event.get("tickers", [])
            if not tickers:
                return {"statusCode": 400, "body": json.dumps({"error": "no tickers provided"})}
            return _assign_new(tickers, context)
        else:
            # recluster (default, also EventBridge)
            return _recluster(context)
    except Exception as e:
        print(f"clusterer: FATAL ERROR: {e}")
        traceback.print_exc()
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
