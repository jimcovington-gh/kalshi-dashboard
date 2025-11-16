"""AWS Lambda handler for Kalshi market data capture.

This is the main entry point for the Lambda function that orchestrates
fetching market data from Kalshi and writing it to InfluxDB.
"""

import os
import time
import requests
from datetime import datetime, timezone
from typing import Dict, Any, List, Set, Optional
from collections import defaultdict

from config import get_config, ConfigurationError
from kalshi_client import KalshiClient, KalshiAPIError
from influxdb_writer import InfluxDBWriter, InfluxDBWriterError
from dynamodb_metadata_writer import DynamoDBMetadataWriter
from models import Series, Event, Market, MarketSnapshot, KalshiMarketResponse
from utils import (
    StructuredLogger,
    CloudWatchMetrics,
    get_lambda_context_info,
    calculate_execution_progress
)


class ExecutionStats:
    """Track execution statistics for reporting.
    
    Attributes:
        start_time: Execution start timestamp
        markets_fetched: Number of markets fetched from API
        snapshots_written: Number of time-series snapshots written
        new_series: Number of new series discovered
        new_events: Number of new events discovered
        new_markets: Number of new markets discovered
        errors: List of error messages encountered
    """
    
    def __init__(self):
        """Initialize execution statistics."""
        self.start_time = time.time()
        self.markets_fetched = 0
        self.snapshots_written = 0
        self.new_series = 0
        self.new_events = 0
        self.new_markets = 0
        self.errors: List[str] = []
        self.series_updated = 0
        self.events_updated = 0
        self.markets_updated = 0
        self.rate_limiter_invocations = 0
        self.rate_limiter_wait_time_ms = 0.0
    
    def add_error(self, error: str) -> None:
        """Add an error to the error list.
        
        Args:
            error: Error message to add
        """
        self.errors.append(error)
    
    def get_duration(self) -> float:
        """Get execution duration in seconds.
        
        Returns:
            Duration since start in seconds
        """
        return time.time() - self.start_time
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert stats to dictionary for logging.
        
        Returns:
            Dictionary with all statistics
        """
        return {
            'duration_seconds': round(self.get_duration(), 2),
            'markets_fetched': self.markets_fetched,
            'snapshots_written': self.snapshots_written,
            'new_series': self.new_series,
            'new_events': self.new_events,
            'new_markets': self.new_markets,
            'series_updated': self.series_updated,
            'events_updated': self.events_updated,
            'markets_updated': self.markets_updated,
            'rate_limiter_invocations': self.rate_limiter_invocations,
            'rate_limiter_wait_time_ms': round(self.rate_limiter_wait_time_ms, 2),
            'error_count': len(self.errors),
            'errors': self.errors[:10],  # Limit to first 10 errors
        }


def process_market_data(
    market_responses: List[KalshiMarketResponse],
    logger: StructuredLogger,
    stats: ExecutionStats,
    capture_time: datetime,
    kalshi_client=None,
    dynamodb_writer=None,
    existing_series_data: dict = None,
    events_cache: dict = None
) -> tuple[List[MarketSnapshot], Dict[str, Series], Dict[str, Event], Dict[str, Market]]:
    """Process raw market responses into domain models.
    
    Extracts snapshots, series, events, and markets from API responses.
    Tracks new vs existing entities for statistics.
    Filters out crypto and financials markets.
    
    Args:
        market_responses: List of market responses from Kalshi API
        logger: Structured logger instance
        stats: Execution statistics tracker
        capture_time: Timestamp when these markets were fetched from API
        kalshi_client: Optional Kalshi client for API calls
        dynamodb_writer: Optional DynamoDB writer for event lookups
        existing_series_data: Dict mapping series_ticker -> {'category': str}
        events_cache: Pre-loaded dict of event_ticker -> event data (shared across batches)
        
    Returns:
        Tuple of (snapshots, series_dict, events_dict, markets_dict)
    """
    snapshots: List[MarketSnapshot] = []
    series_dict: Dict[str, Series] = {}
    events_dict: Dict[str, Event] = {}
    markets_dict: Dict[str, Market] = {}
    
    if capture_time is None:
        capture_time = datetime.utcnow()
    
    # Use provided events cache or create empty dict
    if events_cache is None:
        events_cache = {}
    
    logger.info(
        "Processing market data",
        total_markets=len(market_responses),
        events_cache_size=len(events_cache)
    )
    
    # Log first 10 markets' series tickers for debugging
    for idx, mr in enumerate(market_responses[:10]):
        logger.info(f"Sample market #{idx}", extra={
            "market_ticker": mr.ticker,
            "series_ticker": mr.series_ticker,
            "event_ticker": mr.event_ticker
        })
    
    # ═══════════════════════════════════════════════════════════════════════
    # Event cache is now provided as parameter (shared globally across batches)
    # This eliminates 120+ redundant DynamoDB batch operations
    # ═══════════════════════════════════════════════════════════════════════
    
    for market_response in market_responses:
        try:
            # NOTE: Multivariate markets are now filtered in iter_all_markets()
            # so they never reach this point
            
            # OPTIMIZATION: Check series_ticker and filter crypto/financials BEFORE creating objects
            # Markets often come without series_ticker or category - need to look up from event
            series_ticker = market_response.series_ticker
            category = ''
            
            # Look up event data from cache (pre-loaded from DynamoDB) first
            event_in_cache = market_response.event_ticker in events_cache
            if event_in_cache:
                event_data = events_cache[market_response.event_ticker]
                # Get series_ticker from event if market doesn't have it
                if not series_ticker:
                    series_ticker = event_data.get('series_ticker')
                # Get category from event if available AND not empty
                event_category = (event_data.get('category') or '').lower()
                if event_category and event_category != 'unknown':
                    category = event_category
            
            # OPTIMIZATION: Early check for crypto/financials using series data BEFORE API call
            # This avoids expensive API calls for markets we'll filter out anyway
            if not category and series_ticker and existing_series_data and series_ticker in existing_series_data:
                series_category = existing_series_data[series_ticker].get('category', '').lower()
                if series_category and series_category != 'unknown':
                    category = series_category
            
            
            # If we don't have a valid category yet, fetch from API
            # This is normal operation when cache doesn't have category data
            if (not category or category == 'unknown') and kalshi_client:
                try:
                    event_api_data = kalshi_client.get_event(market_response.event_ticker)
                    if event_api_data:
                        api_category = (event_api_data.get('category') or '').lower()
                        if api_category and api_category != 'unknown':
                            category = api_category
                        if not series_ticker:
                            series_ticker = event_api_data.get('series_ticker')
                        # Update cache with complete data
                        events_cache[market_response.event_ticker] = {
                            'series_ticker': series_ticker,
                            'category': category,
                            'title': event_api_data.get('title', ''),
                            'sub_title': event_api_data.get('sub_title', '')
                        }
                        logger.info(
                            f"Fetched event from API to get category",
                            event_ticker=market_response.event_ticker,
                            category=category,
                            series_ticker=series_ticker
                        )
                except Exception as e:
                    logger.warning(
                        f"Failed to fetch category for event {market_response.event_ticker} - will retry next run",
                        event_ticker=market_response.event_ticker,
                        error=str(e)
                    )
            
            # CRITICAL ERROR: Only log as ERROR if ALL methods failed to get category
            if not category or category == 'unknown':
                logger.error(
                    f"CRITICAL: Market has no valid category after all lookups",
                    market_ticker=market_response.ticker,
                    event_ticker=market_response.event_ticker,
                    series_ticker=series_ticker,
                    category=category
                )
                # Skip this market - don't write it with invalid category
                continue
            
            # Debug logging for specific markets
            if 'HIGHCHI-25NOV08' in market_response.ticker:
                logger.info(
                    "HIGHCHI market processing",
                    extra={
                        'ticker': market_response.ticker,
                        'event_ticker': market_response.event_ticker,
                        'category': category,
                        'series_ticker': series_ticker
                    }
                )
            
            # Create snapshot for time-series data (only for non-filtered markets)
            snapshot = market_response.to_snapshot(timestamp=capture_time)
            snapshots.append(snapshot)
            
            # Create market metadata
            market = market_response.to_market()
            
            # Update series_ticker if we got it from event cache above
            if series_ticker and not market.series_ticker:
                market.series_ticker = series_ticker
            
            # Populate price fields from snapshot
            market.yes_price = snapshot.yes_price
            market.no_price = snapshot.no_price
            market.yes_bid = snapshot.yes_bid
            market.no_bid = snapshot.no_bid
            market.yes_ask = snapshot.yes_ask
            market.no_ask = snapshot.no_ask
            market.last_price = snapshot.last_price
            market.volume = snapshot.volume
            market.volume_24h = snapshot.volume_24h
            market.open_interest = snapshot.open_interest
            market.liquidity = snapshot.liquidity
            market.last_updated = capture_time
            
            # Set category from what we've found (backfill logic will fix unknown/empty later)
            market.category = category if category else 'unknown'
            
            # Create or update event (we already fetched event data above if needed)
            # UPDATE existing events if we now have a better category
            if market.event_ticker in events_dict:
                existing_event = events_dict[market.event_ticker]
                # Update event category if current one is better (not empty/unknown)
                if category and category != 'unknown' and (not existing_event.category or existing_event.category == 'unknown'):
                    existing_event.category = category
                    existing_event.last_updated = capture_time
                    logger.info(
                        f"Updated event category from cache",
                        event_ticker=market.event_ticker,
                        old_category=existing_event.category,
                        new_category=category
                    )
            elif market.event_ticker not in events_dict:
                # Get event details from cache (either pre-loaded or just fetched above)
                event_title = market.title
                event_subtitle = market.subtitle
                if market.event_ticker in events_cache:
                    event_cache_data = events_cache[market.event_ticker]
                    if 'title' in event_cache_data and event_cache_data['title']:
                        event_title = event_cache_data['title']
                    if 'sub_title' in event_cache_data and event_cache_data['sub_title']:
                        event_subtitle = event_cache_data['sub_title']
                
                # VALIDATION: Events must have valid category
                if not category or category == 'unknown':
                    logger.error(
                        f"CRITICAL: Skipping event with invalid category",
                        event_ticker=market.event_ticker,
                        category=category
                    )
                    continue
                
                event = Event(
                    event_ticker=market.event_ticker,
                    series_ticker=market.series_ticker,
                    title=event_title,
                    category=category,
                    sub_title=event_subtitle,
                    strike_date=market.expected_expiration_time,
                    first_seen=capture_time,
                    last_updated=capture_time
                )
                events_dict[event.event_ticker] = event
            
            # Store updated market
            markets_dict[market.market_ticker] = market
            
            # Fetch series data if this is a new series (for series metadata only, not filtering)
            # Skip if already exists in DynamoDB (existing_series_data) or current batch (series_dict)
            if (market.series_ticker and 
                market.series_ticker not in series_dict and
                market.series_ticker not in existing_series_data):
                series_data = None
                if kalshi_client:
                    try:
                        series_data = kalshi_client.get_series(market.series_ticker)
                        logger.debug(
                            f"Fetched series data from API",
                            series_ticker=market.series_ticker
                        )
                    except Exception as e:
                        logger.warning(
                            f"Failed to fetch series details for {market.series_ticker}",
                            series_ticker=market.series_ticker,
                            error=str(e)
                        )
                
                if series_data:
                    # VALIDATION: Series must have valid category
                    series_category = series_data.get('category', category)
                    if not series_category or series_category == 'unknown':
                        logger.error(
                            f"CRITICAL: Series has invalid category",
                            series_ticker=market.series_ticker,
                            category=series_category
                        )
                        # Use the category from event/market as fallback
                        series_category = category
                    
                    # Final validation - if still invalid, skip this series
                    if not series_category or series_category == 'unknown':
                        logger.error(
                            f"CRITICAL: Skipping series with no valid category",
                            series_ticker=market.series_ticker
                        )
                    else:
                        series = Series(
                            series_ticker=market.series_ticker,
                            title=series_data.get('title', market.title.split(' - ')[0] if ' - ' in market.title else market.title),
                            category=series_category,
                            frequency=series_data.get('frequency'),
                            tags=series_data.get('tags') or [],
                            fee_multiplier=series_data.get('fee_multiplier'),
                            fee_type=series_data.get('fee_type'),
                            created_time=None,  # Parse from series_data if available
                            first_seen=capture_time,
                            last_updated=capture_time
                        )
                else:
                    # Fallback to inferred data - but category must still be valid
                    if not category or category == 'unknown':
                        logger.error(
                            f"CRITICAL: Cannot create series without valid category",
                            series_ticker=market.series_ticker,
                            category=category
                        )
                    else:
                        series = Series(
                            series_ticker=market.series_ticker,
                            title=market.title.split(' - ')[0] if ' - ' in market.title else market.title,
                            category=category,
                            first_seen=capture_time,
                            last_updated=capture_time
                        )
                
                if 'series' in locals():
                    series_dict[series.series_ticker] = series
                    logger.info(f"New series discovered", extra={
                        "series_ticker": market.series_ticker,
                        "title": series.title,
                    "total_series_count": len(series_dict)
                })
                
        except Exception as e:
            error_msg = f"Failed to process market {market_response.ticker}: {e}"
            logger.warning(
                error_msg,
                market_ticker=market_response.ticker,
                error=str(e)
            )
            stats.add_error(error_msg)
    
    logger.info(
        "Completed processing market data",
        snapshots=len(snapshots),
        unique_series=len(series_dict),
        unique_events=len(events_dict),
        unique_markets=len(markets_dict)
    )
    
    # Update market categories from series data (now that all series are fetched)
    # Fix markets that have missing, unknown, or incorrect categories
    categories_updated = 0
    series_ticker_updated = 0
    
    for market in markets_dict.values():
        # First, fix series_ticker if it's empty by looking up from event
        if not market.series_ticker and market.event_ticker in events_dict:
            event = events_dict[market.event_ticker]
            if event.series_ticker:
                market.series_ticker = event.series_ticker
                series_ticker_updated += 1
        
        # Then update category from series or event
        needs_category_update = (
            not market.category or 
            market.category == 'unknown' or 
            market.category == market.series_ticker
        )
        
        if needs_category_update:
            # Try series first
            if market.series_ticker and market.series_ticker in series_dict:
                series = series_dict[market.series_ticker]
                if series.category and series.category != 'unknown':
                    market.category = series.category
                    categories_updated += 1
                    continue
            
            # Fallback to event category
            if market.event_ticker in events_dict:
                event = events_dict[market.event_ticker]
                if event.category and event.category != 'unknown':
                    market.category = event.category
                    categories_updated += 1
    
    if series_ticker_updated > 0:
        logger.info(f"Updated {series_ticker_updated} market series_ticker values from event data")
    if categories_updated > 0:
        logger.info(f"Updated {categories_updated} market categories from series/event data")
    
    # Filter out markets that still have invalid categories after backfill
    invalid_markets = []
    for market_ticker, market in list(markets_dict.items()):
        if not market.category or market.category == 'unknown':
            invalid_markets.append(market_ticker)
            del markets_dict[market_ticker]
    
    if invalid_markets:
        logger.warning(
            f"Excluded {len(invalid_markets)} markets with invalid categories after backfill",
            count=len(invalid_markets),
            sample_tickers=invalid_markets[:5]
        )
    
    return snapshots, series_dict, events_dict, markets_dict


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """AWS Lambda handler function.
    
    This is the main entry point for the Lambda function. It orchestrates
    the complete workflow:
    1. Load configuration
    2. Initialize clients (Kalshi API, InfluxDB)
    3. Fetch all open markets from Kalshi
    4. Process market data into snapshots and metadata
    5. Write snapshots to InfluxDB (time-series)
    6. Write metadata to InfluxDB (series, events, markets)
    7. Emit CloudWatch metrics
    8. Return execution summary
    
    Args:
        event: Lambda event (from EventBridge trigger)
        context: Lambda context object
        
    Returns:
        Dictionary with execution results and statistics
    """
    # Record start time
    import time
    start_time = time.time()
    
    # Initialize statistics tracker
    stats = ExecutionStats()
    
    # Initialize logger (will be reconfigured with proper level from config)
    logger = StructuredLogger(__name__)
    
    # Get Lambda context info
    lambda_info = get_lambda_context_info()
    request_id = getattr(context, 'aws_request_id', 'unknown')
    
    logger.info(
        "Lambda execution started",
        request_id=request_id,
        **lambda_info
    )
    
    # Check if Kalshi exchange is active before proceeding
    logger.info("Checking Kalshi exchange status")
    try:
        status_response = requests.get(
            'https://api.elections.kalshi.com/trade-api/v2/exchange/status',
            timeout=10
        )
        if status_response.ok:
            status = status_response.json()
            exchange_active = status.get('exchange_active', False)
            trading_active = status.get('trading_active', False)
            resume_time = status.get('exchange_estimated_resume_time')
            
            logger.info(
                "Exchange status retrieved",
                exchange_active=exchange_active,
                trading_active=trading_active,
                estimated_resume_time=resume_time
            )
            
            # Market capture only needs exchange_active (not trading_active)
            # We capture market data even when trading is paused
            if not exchange_active:
                logger.info(
                    "Exchange is not active (under maintenance) - skipping market capture",
                    estimated_resume_time=resume_time,
                    reason="exchange_inactive"
                )
                return {
                    'statusCode': 200,
                    'body': 'Exchange not active - skipped execution',
                    'exchange_active': False,
                    'trading_active': trading_active,
                    'estimated_resume_time': resume_time
                }
        else:
            logger.warning(
                "Failed to check exchange status - proceeding anyway",
                status_code=status_response.status_code
            )
    except Exception as e:
        logger.warning(
            "Exception checking exchange status - proceeding anyway",
            error=str(e)
        )
    
    kalshi_client = None
    influxdb_writer = None
    metrics = CloudWatchMetrics()
    
    try:
        # Load configuration
        logger.info("Loading configuration")
        try:
            config = get_config()
            
            # Reconfigure logger with proper level
            logger = StructuredLogger(__name__, level=config.log_level)
            
            logger.info(
                "Configuration loaded successfully",
                kalshi_base_url=config.kalshi_api_base_url,
                influxdb_url=config.influxdb_url,
                influxdb_bucket=config.influxdb_bucket,
                is_local=config.is_local
            )
            
        except ConfigurationError as e:
            logger.critical(
                "Failed to load configuration",
                error=str(e)
            )
            stats.add_error(f"Configuration error: {e}")
            return {
                'statusCode': 500,
                'body': 'Configuration error',
                'stats': stats.to_dict()
            }
        
        # Initialize Kalshi API client
        logger.info("Initializing Kalshi API client")
        try:
            kalshi_client = KalshiClient(
                base_url=config.kalshi_api_base_url,
                api_key_id=config.kalshi_api_key_id,
                private_key_pem=config.kalshi_private_key,
                logger=logger,
                requests_per_second=config.kalshi_read_rate_limit,
                write_requests_per_second=config.kalshi_post_rate_limit,
                rate_limiter_table_name=config.rate_limiter_table_name
            )
            if config.rate_limiter_table_name:
                logger.info(
                    "Using DynamoDB rate limiters",
                    table_name=config.rate_limiter_table_name,
                    read_rate_limit=config.kalshi_read_rate_limit,
                    post_rate_limit=config.kalshi_post_rate_limit
                )
            else:
                logger.info(
                    "Using in-memory rate limiters",
                    read_rate_limit=config.kalshi_read_rate_limit,
                    post_rate_limit=config.kalshi_post_rate_limit
                )
        except Exception as e:
            logger.critical(
                "Failed to initialize Kalshi API client",
                error=str(e)
            )
            stats.add_error(f"Kalshi client initialization error: {e}")
            return {
                'statusCode': 500,
                'body': 'Failed to initialize Kalshi client',
                'stats': stats.to_dict()
            }
        
        # Initialize InfluxDB writer
        logger.info("Initializing InfluxDB writer")
        try:
            influxdb_writer = InfluxDBWriter(
                url=config.influxdb_url,
                token=config.influxdb_token,
                org=config.influxdb_org,
                bucket=config.influxdb_bucket,
                logger=logger
            )
        except Exception as e:
            logger.critical(
                "Failed to initialize InfluxDB writer",
                error=str(e)
            )
            stats.add_error(f"InfluxDB writer initialization error: {e}")
            return {
                'statusCode': 500,
                'body': 'Failed to initialize InfluxDB writer',
                'stats': stats.to_dict()
            }
        
        # Process markets in batches to avoid memory issues
        # With 161,000 markets, we'll process 5,000 at a time
        PROCESS_BATCH_SIZE = 5000
        
        logger.info("Starting batch processing of markets from Kalshi API")
        
        # Track metadata across all batches
        series_dict: Dict[str, Series] = {}
        events_dict: Dict[str, Event] = {}
        markets_dict: Dict[str, Market] = {}
        
        # Initialize DynamoDB writer early (if configured)
        dynamodb_writer = None
        existing_market_states = {}
        existing_tickers = set()  # Will be populated from DynamoDB
        
        if all([
            config.series_metadata_table_name,
            config.event_metadata_table_name,
            config.market_metadata_table_name
        ]):
            logger.info("Initializing DynamoDB writer for incremental writes")
            try:
                dynamodb_writer = DynamoDBMetadataWriter(
                    series_table_name=config.series_metadata_table_name,
                    event_table_name=config.event_metadata_table_name,
                    market_table_name=config.market_metadata_table_name,
                    region=config.aws_region,
                    logger=logger
                )
                
                # Load ALL metadata at startup (faster than incremental loading)
                existing_market_states = dynamodb_writer.load_existing_market_states()
                logger.info(f"Loaded {len(existing_market_states)} existing market states from DynamoDB")
                
                # Use DynamoDB market states as existing tickers (no need to query InfluxDB)
                existing_tickers = set(existing_market_states.keys())
                logger.info(f"Using {len(existing_tickers)} existing tickers from DynamoDB")
                
                existing_series_data = dynamodb_writer.load_existing_series_data()
                logger.info(f"Loaded {len(existing_series_data)} existing series with categories from DynamoDB")
                
                # NEW: Load ALL events at startup to eliminate 5+ batch operations during execution
                global_events_cache = dynamodb_writer.load_existing_events()
                logger.info(f"Loaded {len(global_events_cache)} existing events from DynamoDB")
                
            except Exception as e:
                logger.error(f"Failed to initialize DynamoDB writer: {e}")
                dynamodb_writer = None
                existing_market_states = {}
                existing_tickers = set()
                existing_series_data = {}
                global_events_cache = {}
        else:
            existing_series_data = {}
            global_events_cache = {}
        
        try:
            # Get the market iterator from Kalshi client
            # This yields (market, capture_time) tuples page-by-page
            batch = []
            batch_capture_times = []  # Track capture time for each market in batch
            batch_num = 0
            
            for market_response, page_capture_time in kalshi_client.iter_all_markets(status='open'):
                batch.append(market_response)
                batch_capture_times.append(page_capture_time)
                stats.markets_fetched += 1
                
                # Process batch when it reaches PROCESS_BATCH_SIZE
                if len(batch) >= PROCESS_BATCH_SIZE:
                    batch_num += 1
                    logger.info(
                        f"Processing batch {batch_num}",
                        batch_size=len(batch),
                        total_fetched=stats.markets_fetched
                    )
                    
                    # Process markets in sub-batches by their capture_time
                    # Group consecutive markets with the same capture_time
                    batch_snapshots_all = []
                    batch_series = {}
                    batch_events = {}
                    batch_markets = {}
                    
                    # Use global events cache (loaded once at startup)
                    # No need to build per-batch anymore!
                    
                    i = 0
                    while i < len(batch):
                        current_capture_time = batch_capture_times[i]
                        sub_batch = [batch[i]]
                        
                        # Collect all consecutive markets with same capture_time
                        while i + 1 < len(batch) and batch_capture_times[i + 1] == current_capture_time:
                            i += 1
                            sub_batch.append(batch[i])
                        
                        # Process this sub-batch with its shared capture_time AND global event cache
                        sub_snapshots, sub_series, sub_events, sub_markets = process_market_data(
                            sub_batch,
                            logger,
                            stats,
                            current_capture_time,
                            kalshi_client,
                            dynamodb_writer,
                            existing_series_data,
                            global_events_cache  # Pass global event cache (loaded once at startup)
                        )
                        
                        batch_snapshots_all.extend(sub_snapshots)
                        batch_series.update(sub_series)
                        batch_events.update(sub_events)
                        batch_markets.update(sub_markets)
                        
                        i += 1
                    
                    # Merge metadata (deduplicate across batches)
                    series_dict.update(batch_series)
                    events_dict.update(batch_events)
                    markets_dict.update(batch_markets)
                    
                    # Write snapshots immediately (don't hold in memory)
                    try:
                        written_count = influxdb_writer.write_market_snapshots(
                            batch_snapshots_all,
                            batch_size=1000
                        )
                        stats.snapshots_written += written_count
                        
                        logger.info(
                            f"Wrote batch {batch_num} snapshots",
                            snapshots_written=written_count,
                            total_snapshots_written=stats.snapshots_written
                        )
                        
                    except InfluxDBWriterError as e:
                        logger.error(
                            f"Failed to write batch {batch_num} snapshots",
                            error=str(e)
                        )
                        stats.add_error(f"Batch {batch_num} snapshot write error: {e}")
                    
                    # Write metadata to DynamoDB incrementally
                    if dynamodb_writer:
                        try:
                            # Categorize markets for this batch
                            batch_new_markets = []
                            batch_active_markets = []
                            batch_status_changed = []
                            
                            for market in batch_markets.values():
                                if market.market_ticker not in existing_market_states:
                                    batch_new_markets.append(market)
                                    # Track as existing for future batches
                                    existing_market_states[market.market_ticker] = {
                                        'status': market.status,
                                        'last_price': market.last_price
                                    }
                                else:
                                    existing_state = existing_market_states[market.market_ticker]
                                    if existing_state['status'] == 'active' and market.status != 'active':
                                        batch_status_changed.append(market)
                                        existing_market_states[market.market_ticker]['status'] = market.status
                                    elif market.status == 'active':
                                        batch_active_markets.append(market)
                            
                            # Write new series/events (only those new in this batch)
                            new_series = [s for s in batch_series.values()]
                            new_events = [e for e in batch_events.values()]
                            
                            # Filter to only count truly NEW items (not in DB at start)
                            truly_new_series = [s for s in new_series if s.series_ticker not in existing_series_data]
                            truly_new_events = [e for e in new_events if e.event_ticker not in global_events_cache]
                            
                            if new_series:
                                dynamodb_writer.batch_write_series(new_series)
                                stats.new_series += len(truly_new_series)
                            if new_events:
                                dynamodb_writer.batch_write_events(new_events)
                                stats.new_events += len(truly_new_events)
                            if batch_new_markets:
                                dynamodb_writer.batch_write_markets(batch_new_markets)
                                stats.new_markets += len(batch_new_markets)
                            if batch_active_markets:
                                updated = dynamodb_writer.update_market_prices_parallel(batch_active_markets, max_workers=10)
                                stats.markets_updated += updated
                            if batch_status_changed:
                                for market in batch_status_changed:
                                    dynamodb_writer.update_market_full(market)
                            
                            logger.info(
                                f"Wrote batch {batch_num} metadata to DynamoDB",
                                series=len(new_series),
                                events=len(new_events),
                                new_markets=len(batch_new_markets),
                                active_markets=len(batch_active_markets),
                                status_changed=len(batch_status_changed)
                            )
                        except Exception as e:
                            logger.error(f"Failed to write batch {batch_num} to DynamoDB: {e}")
                            stats.add_error(f"Batch {batch_num} DynamoDB write error: {e}")
                    
                    # Clear batch to free memory
                    batch = []
                    batch_capture_times = []
                    
                    # Check for timeout risk (warn at 13 minutes)
                    if stats.get_duration() > 780:  # 13 minutes
                        logger.warning(
                            "Approaching Lambda timeout, stopping batch processing",
                            duration_seconds=stats.get_duration(),
                            markets_processed=stats.markets_fetched
                        )
                        break
            
            # Process remaining markets in final batch
            if batch:
                batch_num += 1
                logger.info(
                    f"Processing final batch {batch_num}",
                    batch_size=len(batch),
                    total_fetched=stats.markets_fetched
                )
                
                # Process markets in sub-batches by their capture_time
                batch_snapshots_all = []
                batch_series = {}
                batch_events = {}
                batch_markets = {}
                
                # Use global events cache (loaded once at startup)
                
                i = 0
                while i < len(batch):
                    current_capture_time = batch_capture_times[i]
                    sub_batch = [batch[i]]
                    
                    # Collect all consecutive markets with same capture_time
                    while i + 1 < len(batch) and batch_capture_times[i + 1] == current_capture_time:
                        i += 1
                        sub_batch.append(batch[i])
                    
                    # Process this sub-batch with its shared capture_time AND global event cache
                    sub_snapshots, sub_series, sub_events, sub_markets = process_market_data(
                        sub_batch,
                        logger,
                        stats,
                        current_capture_time,
                        kalshi_client,
                        dynamodb_writer,
                        existing_series_data,
                        global_events_cache  # Pass global event cache (loaded once at startup)
                    )
                    
                    batch_snapshots_all.extend(sub_snapshots)
                    batch_series.update(sub_series)
                    batch_events.update(sub_events)
                    batch_markets.update(sub_markets)
                    
                    i += 1
                
                series_dict.update(batch_series)
                events_dict.update(batch_events)
                markets_dict.update(batch_markets)
                
                try:
                    written_count = influxdb_writer.write_market_snapshots(
                        batch_snapshots_all,
                        batch_size=1000
                    )
                    stats.snapshots_written += written_count
                    
                    logger.info(
                        f"Wrote final batch {batch_num} snapshots",
                        snapshots_written=written_count,
                        total_snapshots_written=stats.snapshots_written
                    )
                    
                except InfluxDBWriterError as e:
                    logger.error(
                        f"Failed to write final batch {batch_num} snapshots",
                        error=str(e)
                    )
                    stats.add_error(f"Final batch snapshot write error: {e}")
                
                # Write final batch metadata to DynamoDB
                if dynamodb_writer:
                    try:
                        # Categorize markets for final batch
                        batch_new_markets = []
                        batch_active_markets = []
                        batch_status_changed = []
                        
                        for market in batch_markets.values():
                            if market.market_ticker not in existing_market_states:
                                batch_new_markets.append(market)
                                existing_market_states[market.market_ticker] = {
                                    'status': market.status,
                                    'last_price': market.last_price
                                }
                            else:
                                existing_state = existing_market_states[market.market_ticker]
                                if existing_state['status'] == 'active' and market.status != 'active':
                                    batch_status_changed.append(market)
                                    existing_market_states[market.market_ticker]['status'] = market.status
                                elif market.status == 'active':
                                    batch_active_markets.append(market)
                        
                        # Write new series/events
                        new_series = [s for s in batch_series.values()]
                        new_events = [e for e in batch_events.values()]
                        
                        # Filter to only count truly NEW items (not in DB at start)
                        truly_new_series = [s for s in new_series if s.series_ticker not in existing_series_data]
                        truly_new_events = [e for e in new_events if e.event_ticker not in global_events_cache]
                        
                        if new_series:
                            dynamodb_writer.batch_write_series(new_series)
                            stats.new_series += len(truly_new_series)
                        if new_events:
                            dynamodb_writer.batch_write_events(new_events)
                            stats.new_events += len(truly_new_events)
                        if batch_new_markets:
                            dynamodb_writer.batch_write_markets(batch_new_markets)
                            stats.new_markets += len(batch_new_markets)
                        if batch_active_markets:
                            updated = dynamodb_writer.update_market_prices_parallel(batch_active_markets, max_workers=10)
                            stats.markets_updated += updated
                        if batch_status_changed:
                            for market in batch_status_changed:
                                dynamodb_writer.update_market_full(market)
                        
                        logger.info(
                            f"Wrote final batch {batch_num} metadata to DynamoDB",
                            series=len(new_series),
                            events=len(new_events),
                            new_markets=len(batch_new_markets),
                            active_markets=len(batch_active_markets),
                            status_changed=len(batch_status_changed)
                        )
                    except Exception as e:
                        logger.error(f"Failed to write final batch {batch_num} to DynamoDB: {e}")
                        stats.add_error(f"Final batch DynamoDB write error: {e}")
            
            logger.info(
                "Completed batch processing of all markets",
                total_markets=stats.markets_fetched,
                total_batches=batch_num,
                snapshots_written=stats.snapshots_written
            )
            
            metrics.put_metric(
                metric_name='MarketsProcessed',
                value=stats.markets_fetched,
                unit='Count'
            )
            
            metrics.put_metric(
                metric_name='SnapshotsWritten',
                value=stats.snapshots_written,
                unit='Count'
            )
            
        except KalshiAPIError as e:
            logger.critical(
                "Failed to fetch markets from Kalshi",
                error=str(e)
            )
            stats.add_error(f"Kalshi API error: {e}")
            metrics.put_metric(
                metric_name='ErrorCount',
                value=1,
                unit='Count'
            )
            return {
                'statusCode': 500,
                'body': 'Failed to fetch markets from Kalshi',
                'stats': stats.to_dict()
            }
        
        logger.info(
            "Market data processing complete",
            snapshots_written=stats.snapshots_written,
            new_series=stats.new_series,
            new_events=stats.new_events,
            new_markets=stats.new_markets,
            markets_updated=stats.markets_updated
        )
        
        # NOTE: InfluxDB metadata writes removed for performance optimization
        # All metadata is stored in DynamoDB and used by all Lambdas
        # InfluxDB only stores market_snapshots (time-series price data)
        logger.info(
            "Skipping InfluxDB metadata writes (using DynamoDB only)",
            markets=len(markets_dict),
            events=len(events_dict),
            series=len(series_dict)
        )
        
        # DynamoDB metadata writes already completed incrementally during batch processing
        if dynamodb_writer:
            logger.info(
                "DynamoDB incremental writes completed during batch processing",
                total_series=len(series_dict),
                total_events=len(events_dict),
                total_markets=len(markets_dict)
            )
        else:
            logger.info("DynamoDB metadata tables not configured, skipping DynamoDB writes")
        
        # Emit execution time metric
        duration_ms = stats.get_duration() * 1000
        metrics.put_metric(
            metric_name='TotalExecutionTime',
            value=duration_ms,
            unit='Milliseconds'
        )
        
        # Emit error count metric
        if stats.errors:
            metrics.put_metric(
                metric_name='ErrorCount',
                value=len(stats.errors),
                unit='Count'
            )
        
        # Calculate total execution time
        total_duration = time.time() - start_time
        
        # Final summary with all key metrics in one log line
        logger.info(
            "Lambda execution completed successfully",
            duration_seconds=round(total_duration, 2),
            markets_fetched=stats.markets_fetched,
            snapshots_written=stats.snapshots_written,
            new_series=stats.new_series,
            new_events=stats.new_events,
            new_markets=stats.new_markets,
            series_updated=stats.series_updated,
            events_updated=stats.events_updated,
            markets_updated=stats.markets_updated,
            rate_limiter_invocations=stats.rate_limiter_invocations,
            rate_limiter_wait_time_ms=stats.rate_limiter_wait_time_ms,
            error_count=len(stats.errors),
            errors=stats.errors
        )
        
        # Detailed execution summary
        logger.info(
            "Execution Summary",
            **stats.to_dict()
        )
        
        return {
            'statusCode': 200,
            'body': 'Market data capture completed successfully',
            'stats': stats.to_dict()
        }
        
    except Exception as e:
        logger.critical(
            "Unexpected error in Lambda handler",
            error=str(e),
            error_type=type(e).__name__
        )
        stats.add_error(f"Unexpected error: {e}")
        
        metrics.put_metric(
            metric_name='ErrorCount',
            value=1,
            unit='Count'
        )
        
        return {
            'statusCode': 500,
            'body': f'Unexpected error: {str(e)}',
            'stats': stats.to_dict()
        }
        
    finally:
        # Collect rate limiter stats before cleanup
        if kalshi_client:
            try:
                rate_stats = kalshi_client.get_rate_limiter_stats()
                stats.rate_limiter_invocations = rate_stats.get('invocations', 0)
                stats.rate_limiter_wait_time_ms = rate_stats.get('total_wait_time_ms', 0.0)
            except Exception as e:
                logger.warning(f"Error collecting rate limiter stats: {e}")
        
        # Cleanup resources
        if kalshi_client:
            try:
                kalshi_client.close()
            except Exception as e:
                logger.warning(f"Error closing Kalshi client: {e}")
        
        if influxdb_writer:
            try:
                influxdb_writer.close()
            except Exception as e:
                logger.warning(f"Error closing InfluxDB writer: {e}")
        
        # Flush metrics to CloudWatch
        try:
            metrics.flush_metrics()
        except Exception as e:
            logger.warning(f"Error flushing metrics: {e}")
        
        logger.info(
            "Lambda execution finished",
            duration_seconds=stats.get_duration()
        )
