"""
Auto-Queue Lambda for NCAA Basketball Game Captures.
Runs every 30 minutes via EventBridge to automatically discover and queue upcoming games
for the sports data feeder capture system.

Scans event metadata for upcoming NCAA Men's Basketball games and creates queue entries
in the sports feeder state table. Idempotent — safe to run repeatedly without duplicates.
"""

import json
import os
import time
import logging
import boto3
from boto3.dynamodb.conditions import Attr
from datetime import datetime, timezone
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(logging.INFO)

EVENT_METADATA_TABLE = os.environ.get('EVENT_METADATA_TABLE', 'production-kalshi-event-metadata')
CAPTURE_TABLE = os.environ.get('CAPTURE_TABLE', 'production-sports-feeder-state')

# Series tickers to auto-queue
AUTO_QUEUE_SERIES = ['KXNCAAMBGAME']

# League display names for each series
SERIES_LEAGUE_MAP = {
    'KXNCAAMBGAME': 'NCAA Men\'s Basketball',
}

# Time windows
LOOKBACK_SECONDS = 3 * 3600       # 3 hours — catch in-progress games
LOOKAHEAD_SECONDS = 48 * 3600     # 48 hours — don't queue too far ahead
GAME_DURATION_ESTIMATE = 10800    # 3 hours — used to estimate start from strike_date


def lambda_handler(event, context):
    """Main handler — discover upcoming games and queue them for capture."""
    now = int(time.time())
    min_strike = now - LOOKBACK_SECONDS
    max_strike = now + LOOKAHEAD_SECONDS

    logger.info(f"Auto-queue run at {now} ({datetime.fromtimestamp(now, tz=timezone.utc).isoformat()})")
    logger.info(f"Strike date window: {min_strike} to {max_strike}")

    dynamodb = boto3.resource('dynamodb')
    metadata_table = dynamodb.Table(EVENT_METADATA_TABLE)
    capture_table = dynamodb.Table(CAPTURE_TABLE)

    # Step 1: Discover upcoming games from event metadata
    upcoming_events = scan_upcoming_events(metadata_table, min_strike, max_strike)
    logger.info(f"Found {len(upcoming_events)} upcoming events in metadata")

    # Step 2: Queue each event, skipping duplicates
    queued_count = 0
    already_queued_count = 0
    errors = []

    for evt in upcoming_events:
        event_ticker = evt['event_ticker']
        try:
            was_queued = queue_event(capture_table, evt, now)
            if was_queued:
                queued_count += 1
                logger.info(f"Queued: {event_ticker} — {evt.get('title', 'unknown')}")
            else:
                already_queued_count += 1
                logger.debug(f"Already queued: {event_ticker}")
        except Exception as e:
            logger.error(f"Failed to queue {event_ticker}: {e}")
            errors.append(event_ticker)

    summary = (
        f"Auto-queued {queued_count} new games, "
        f"{already_queued_count} already queued, "
        f"{len(upcoming_events)} total upcoming"
    )
    logger.info(summary)

    if errors:
        logger.error(f"Failed to queue {len(errors)} events: {errors}")

    return {
        'statusCode': 200,
        'body': json.dumps({
            'summary': summary,
            'queued': queued_count,
            'already_queued': already_queued_count,
            'total_upcoming': len(upcoming_events),
            'errors': errors,
        })
    }


def scan_upcoming_events(metadata_table, min_strike, max_strike):
    """
    Scan event metadata for upcoming games matching our series tickers.
    Handles DynamoDB pagination to retrieve all matching events.
    """
    all_events = []

    for series_ticker in AUTO_QUEUE_SERIES:
        # DynamoDB scan with filter — series_ticker match + strike_date in window
        filter_expr = (
            Attr('series_ticker').eq(series_ticker) &
            Attr('strike_date').gte(Decimal(str(min_strike))) &
            Attr('strike_date').lte(Decimal(str(max_strike)))
        )

        scan_kwargs = {
            'FilterExpression': filter_expr,
        }

        while True:
            response = metadata_table.scan(**scan_kwargs)
            items = response.get('Items', [])
            all_events.extend(items)

            # Handle pagination
            last_key = response.get('LastEvaluatedKey')
            if last_key:
                scan_kwargs['ExclusiveStartKey'] = last_key
            else:
                break

        logger.info(f"Series {series_ticker}: found {len(all_events)} events in window")

    return all_events


def queue_event(capture_table, event_metadata, now):
    """
    Create a queue entry for a single event. Returns True if newly queued,
    False if already existed. Uses condition_expression to avoid overwriting.
    """
    event_ticker = event_metadata['event_ticker']
    queue_key = f"CAPTURE_QUEUE#{event_ticker}"

    # Determine scheduled start time
    if 'start_date' in event_metadata and event_metadata['start_date']:
        scheduled_start = int(event_metadata['start_date'])
    else:
        # Estimate: strike_date is roughly game end, so subtract game duration
        strike_date = int(event_metadata['strike_date'])
        scheduled_start = strike_date - GAME_DURATION_ESTIMATE

    # Look up league from series ticker
    series_ticker = event_metadata.get('series_ticker', '')
    league = SERIES_LEAGUE_MAP.get(series_ticker, series_ticker)

    item = {
        'key': queue_key,
        'event_ticker': event_ticker,
        'status': 'queued',
        'scheduled_start': scheduled_start,
        'capture_user': 'jimc',
        'queued_by': 'auto-queue',
        'queued_at': now,
        'league': league,
        'title': event_metadata.get('title', ''),
    }

    try:
        capture_table.put_item(
            Item=item,
            ConditionExpression='attribute_not_exists(#k)',
            ExpressionAttributeNames={'#k': 'key'},
        )
        return True
    except capture_table.meta.client.exceptions.ConditionalCheckFailedException:
        # Item already exists — this is expected for idempotency
        return False
