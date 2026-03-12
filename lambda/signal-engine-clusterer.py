"""Signal Engine Occurrence Clusterer -- uses Bedrock Claude Haiku to identify
specific real-world occurrences (yes/no events) and link prediction markets
that would be causally affected by each occurrence.

An "occurrence" is a single concrete event (e.g., "Kristi Noem departs DHS")
that drives price movement across multiple markets, potentially spanning
different Kalshi event_tickers. Markets can belong to MULTIPLE occurrences.

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
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3

CLUSTER_TABLE = os.environ["CLUSTER_TABLE"]
METADATA_TABLE = os.environ.get("METADATA_TABLE", "production-kalshi-market-metadata")
VELOCITY_TABLE = os.environ.get("VELOCITY_TABLE", "production-signal-engine-velocity")
CLASSIFICATION_TABLE = os.environ.get("CLASSIFICATION_TABLE", "production-signal-engine-market-class")
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")

EXCLUDED_CATEGORIES = {"crypto", "mentions", "climate and weather", "financials", "sports"}
# Max markets to send per Bedrock call (context window management)
BATCH_SIZE = 150
CLUSTER_TTL_DAYS = 7
# Max parallel Bedrock calls (Haiku supports high concurrency)
MAX_BEDROCK_WORKERS = 10

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")
cluster_table = dynamodb.Table(CLUSTER_TABLE)
metadata_table = dynamodb.Table(METADATA_TABLE)
velocity_table = dynamodb.Table(VELOCITY_TABLE)
classification_table = dynamodb.Table(CLASSIFICATION_TABLE)


CLUSTER_SYSTEM_PROMPT = """You identify specific real-world occurrences that would causally move prediction market prices, and group the affected markets under each occurrence.

An "occurrence" is a SINGLE, SPECIFIC event that either will or won't happen — something you could bet on.

EXAMPLE INPUT:
- KXCABDEPART-26 | KXCABDEPART | politics | Will there be 3+ cabinet departures by Dec 2026?
- KXNOEM-DHS | KXNOEM | politics | Will Kristi Noem be DHS Secretary on June 1?
- KXSD-SENATE | KXSDSN | politics | Will Republicans win the SD Senate special election?
- KXDHS-HEAD | KXDHS | politics | Will DHS have a new secretary by July?
- KXHEGSETH | KXHEG | politics | Will Pete Hegseth be Defense Secretary on June 1?
- KXFED-MAR26 | KXFED | economics | Will the Fed cut rates at March 2026 FOMC?
- KXFED-JUN26 | KXFED | economics | Will the Fed cut rates at June 2026 FOMC?
- KXFEDCUTS26 | KXFED | economics | Will there be 3+ Fed rate cuts in 2026?

CORRECT OUTPUT — each occurrence is ONE specific event:
[
  {"name": "Kristi Noem departs as DHS Secretary", "description": "Her departure would increase cabinet departure count, change DHS leadership, and trigger SD Senate special election", "tickers": ["KXCABDEPART-26", "KXNOEM-DHS", "KXSD-SENATE", "KXDHS-HEAD"]},
  {"name": "Pete Hegseth departs as Defense Secretary", "description": "His departure would increase cabinet departure count", "tickers": ["KXCABDEPART-26", "KXHEGSETH"]},
  {"name": "Fed cuts rates at March 2026 FOMC", "description": "A March cut would contribute to the total cuts count for 2026", "tickers": ["KXFED-MAR26", "KXFEDCUTS26"]},
  {"name": "Fed cuts rates at June 2026 FOMC", "description": "A June cut would contribute to the total cuts count for 2026", "tickers": ["KXFED-JUN26", "KXFEDCUTS26"]}
]

WRONG OUTPUT — these are categories, not occurrences:
[
  {"name": "Trump administration departures", "tickers": ["KXCABDEPART-26", "KXNOEM-DHS", "KXHEGSETH"]},
  {"name": "Federal Reserve Policy Decisions", "tickers": ["KXFED-MAR26", "KXFED-JUN26", "KXFEDCUTS26"]}
]
^ WRONG because "Trump administration departures" is a CATEGORY containing multiple different events.
Each individual person departing is a SEPARATE occurrence with different causal chains.
"Federal Reserve Policy Decisions" lumps separate FOMC meetings into one cluster.

RULES:
1. SPECIFIC AND CONCRETE ONLY. Each occurrence is ONE event you can answer yes/no to.
   GOOD: "Pete Hegseth leaves as Defense Secretary", "Fed cuts rates at June 2026 FOMC"
   FORBIDDEN — NEVER output names like these:
   - "2026 Congressional Elections" (category)
   - "Entertainment industry events" (category)
   - "Trump Policy Actions" (category)
   - "Potential changes to X" (vague category)
   - "Federal Reserve Policy Decisions" (category — split into individual FOMC meetings)
2. A market CAN belong to MULTIPLE occurrences. This is ESSENTIAL for counting/aggregate
   markets (e.g., "3+ cabinet departures" belongs to every individual departure occurrence).
3. It's OK if an occurrence only has 1 market in THIS batch. Markets in other batches may
   also belong to it. Include it — duplicates across batches will be merged later.
4. Name: verb phrase describing what happens (3-10 words).
5. Description: 1 sentence explaining the CAUSAL LINK.
6. CROSS-EVENT CONNECTIONS are the whole point. Look for:
   - Individual events that feed into counting/aggregate markets
   - Person-level events that affect department, successor, and vacancy markets
   - Geographic events that affect state/district level races
7. Be MAXIMALLY GRANULAR. Each person, each date, each meeting = separate occurrence.
8. EVERY market should belong to at least one occurrence. If you can't find a cross-event
   connection, create an occurrence for the most specific event the market directly bets on.

Respond with ONLY a JSON array:
[{"name": "Occurrence Name", "description": "Causal link", "tickers": ["T1", "T2", ...]}]"""


ASSIGN_SYSTEM_PROMPT = """You assign new prediction markets to existing occurrence-based clusters.
Each cluster represents a specific real-world event (occurrence) that either will or won't happen.

Given:
1. EXISTING occurrences (name, description, sample markets)
2. NEW markets to assign

For each new market, determine which occurrence(s) would causally affect it.
A market can belong to MULTIPLE occurrences.

Only create a NEW occurrence if the market is affected by a specific event not already captured.
New occurrences must be SPECIFIC (a single yes/no event), not a category.

Respond with ONLY a JSON object:
{
  "assignments": [{"ticker": "MKTTICKER", "cluster_names": ["Occurrence A", "Occurrence B"]}],
  "new_clusters": [{"name": "New Occurrence", "description": "Causal link", "tickers": ["T1", "T2"]}]
}"""


CONSOLIDATION_PROMPT = """Given these occurrence names from a prediction market clustering task, identify any that refer to the SAME specific real-world event but are phrased differently, and should be merged.

RULES:
1. Only merge occurrences that are truly the SAME event phrased differently.
   MERGE: "Fed cuts rates in June 2026" + "Federal Reserve June 2026 rate cut"
   DO NOT MERGE: "Fed cuts rates in June" + "Fed cuts rates in July" (different events)
   DO NOT MERGE: "Pete Hegseth leaves Defense" + "Cabinet departures" (related but different)
2. Choose the clearest, most specific name as the canonical name.

Respond with ONLY a JSON array:
[{"keep": "Best Name", "merge": ["Duplicate Name 1", "Duplicate Name 2"]}]

If no duplicates exist, respond with []. Only include groups with actual duplicates."""


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


def _consolidate_occurrences(all_clusters):
    """Use Bedrock to find and merge duplicate occurrence names across batches.

    Two occurrences that describe the same real-world event but were named differently
    in different batches (e.g., "Fed cuts rates June 2026" vs "Federal Reserve June rate cut")
    get merged into one.
    """
    unique_names = list(set(c.get("name", "").strip() for c in all_clusters if c.get("name")))
    if len(unique_names) <= 15:
        # Not enough to warrant a consolidation call
        return all_clusters

    user_msg = "OCCURRENCE NAMES:\n" + "\n".join(f"- {n}" for n in sorted(unique_names))

    try:
        merges = _call_bedrock(CONSOLIDATION_PROMPT, user_msg, max_tokens=4096)
    except Exception as e:
        print(f"clusterer: consolidation call failed, skipping: {e}")
        return all_clusters

    if not isinstance(merges, list) or not merges:
        print("clusterer: consolidation found no duplicates")
        return all_clusters

    # Build merge map: old_name_lower → canonical_name
    merge_map = {}
    for group in merges:
        canonical = group.get("keep", "")
        if not canonical:
            continue
        for old_name in group.get("merge", []):
            merge_map[old_name.lower().strip()] = canonical

    if not merge_map:
        print("clusterer: consolidation found no duplicates")
        return all_clusters

    # Re-merge using canonical names
    merged = {}
    for cluster in all_clusters:
        name = cluster.get("name", "").strip()
        canonical = merge_map.get(name.lower().strip(), name)
        key = canonical.lower().strip()
        if key in merged:
            existing_tickers = set(merged[key].get("tickers", []))
            existing_tickers.update(cluster.get("tickers", []))
            merged[key]["tickers"] = list(existing_tickers)
        else:
            cluster_copy = dict(cluster)
            cluster_copy["name"] = canonical
            merged[key] = cluster_copy

    before = len(all_clusters)
    after = len(merged)
    print(f"clusterer: consolidation merged {before} → {after} occurrences ({before - after} duplicates)")
    return list(merged.values())


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


# Patterns that indicate a category name rather than a specific occurrence
_CATEGORY_WORDS = {"events", "races", "elections", "miscellaneous", "various", "other", "general"}
_CATEGORY_PHRASES = ["potential changes", "policy decisions", "political appointments"]


def _is_category_name(name):
    """Return True if the name looks like a broad category rather than a specific occurrence."""
    lower = name.lower()
    words = set(lower.split())
    if words & _CATEGORY_WORDS:
        return True
    return any(p in lower for p in _CATEGORY_PHRASES)


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

        # Filter to only active tickers
        member_tickers = [t for t in cluster.get("tickers", []) if t in active_tickers]
        if len(member_tickers) < 2:
            continue

        new_cluster_ids.add(cluster_id)

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


def _process_one_batch(batch_info):
    """Process a single batch of markets through Bedrock. Thread-safe."""
    batch_start, batch, total = batch_info
    prompt_text = _format_markets_for_prompt(batch)
    label = f"{batch_start+1}-{batch_start+len(batch)} of {total}"

    print(f"clusterer: sending batch of {len(batch)} markets to Bedrock ({label})")

    try:
        result = _call_bedrock(CLUSTER_SYSTEM_PROMPT, prompt_text)
        if isinstance(result, list):
            print(f"clusterer: Bedrock returned {len(result)} clusters for batch {label}")
            return result
        else:
            print(f"clusterer: unexpected Bedrock response type for batch {label}: {type(result)}")
            return []
    except Exception as e:
        print(f"clusterer: Bedrock error on batch {label}: {e}")
        traceback.print_exc()
        return []


def _recluster(context):
    """Full recluster: get all active markets, call Bedrock to cluster them."""
    start = time.time()
    markets = _get_active_markets()
    if not markets:
        return {"statusCode": 200, "body": json.dumps({"clusters": 0, "markets": 0})}

    active_tickers = set(markets.keys())

    # Split into batches
    market_list = list(markets.items())
    batches = []
    for batch_start in range(0, len(market_list), BATCH_SIZE):
        batch = dict(market_list[batch_start:batch_start + BATCH_SIZE])
        batches.append((batch_start, batch, len(markets)))

    print(f"clusterer: processing {len(batches)} batches with {MAX_BEDROCK_WORKERS} parallel workers")

    # Process all batches in parallel
    all_clusters = []
    with ThreadPoolExecutor(max_workers=MAX_BEDROCK_WORKERS) as executor:
        futures = {executor.submit(_process_one_batch, b): b for b in batches}
        for future in as_completed(futures):
            result = future.result()
            if result:
                all_clusters.extend(result)

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
    print(f"clusterer: {len(final_clusters)} occurrences after exact-name merge")

    # Filter out category-style names (but keep singletons — they may merge across batches)
    before_filter = len(final_clusters)
    final_clusters = [
        c for c in final_clusters
        if not _is_category_name(c.get("name", ""))
    ]
    if before_filter != len(final_clusters):
        print(f"clusterer: removed {before_filter - len(final_clusters)} category-style names")

    # Consolidate: use Bedrock to find fuzzy duplicate occurrence names across batches
    final_clusters = _consolidate_occurrences(final_clusters)

    # NOW enforce minimum 2 active markets (after cross-batch merge + consolidation)
    before_min = len(final_clusters)
    final_clusters = [
        c for c in final_clusters
        if len([t for t in c.get("tickers", []) if t in active_tickers]) >= 2
    ]
    if before_min != len(final_clusters):
        print(f"clusterer: removed {before_min - len(final_clusters)} singletons after consolidation")

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
