"""InfluxDB writer for storing market data and metadata.

This module handles writing time-series market snapshots and metadata
to InfluxDB with optimized batch processing and error handling.
Default batch size of 10,000 records provides optimal throughput
while maintaining reliability for large datasets.
"""

from typing import List, Optional, Dict, Any
from datetime import datetime

from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS
from influxdb_client.client.exceptions import InfluxDBError

from models import MarketSnapshot, Series, Event, Market
from utils import StructuredLogger, retry_with_backoff, batch_iterator


class InfluxDBWriterError(Exception):
    """Base exception for InfluxDB writer errors."""
    pass


class InfluxDBWriter:
    """Writer for InfluxDB operations.
    
    This class handles writing market snapshots (time-series data) and
    metadata (series, events, markets) to InfluxDB with optimized batch 
    processing and error handling. Uses 10,000 record batches by default
    for optimal throughput with large datasets.
    
    Attributes:
        client: InfluxDB client instance
        bucket: Target bucket name
        org: Organization name
        logger: Structured logger instance
        write_api: InfluxDB write API
    """
    
    def __init__(
        self,
        url: str,
        token: str,
        org: str,
        bucket: str,
        logger: Optional[StructuredLogger] = None
    ):
        """Initialize InfluxDB writer.
        
        Args:
            url: InfluxDB server URL
            token: Authentication token
            org: Organization name
            bucket: Target bucket name
            logger: Optional structured logger instance
            
        Raises:
            InfluxDBWriterError: If connection fails
        """
        self.bucket = bucket
        self.org = org
        self.logger = logger or StructuredLogger(__name__)
        
        try:
            self.client = InfluxDBClient(
                url=url,
                token=token,
                org=org,
                timeout=30_000,  # 30 second timeout
                verify_ssl=False  # Required for Timestream for InfluxDB self-signed certs
            )
            
            # Create write API with synchronous mode
            self.write_api = self.client.write_api(write_options=SYNCHRONOUS)
            
            # Skip connection verification - requires admin permissions we don't have
            # The write token only has read/write permissions, not bucket management
            # self._verify_connection()
            
            self.logger.info(
                "InfluxDB writer initialized",
                url=url,
                org=org,
                bucket=bucket
            )
            
        except Exception as e:
            raise InfluxDBWriterError(
                f"Failed to initialize InfluxDB client: {e}"
            ) from e
    
    def _verify_connection(self) -> None:
        """Verify connection to InfluxDB.
        
        Raises:
            InfluxDBWriterError: If connection verification fails
        """
        try:
            # Try to query buckets to verify connection
            buckets_api = self.client.buckets_api()
            bucket = buckets_api.find_bucket_by_name(self.bucket)
            
            if not bucket:
                self.logger.warning(
                    f"Bucket '{self.bucket}' not found - it will be created on first write"
                )
            else:
                self.logger.debug(
                    "Successfully connected to InfluxDB",
                    bucket_id=bucket.id
                )
                
        except Exception as e:
            raise InfluxDBWriterError(
                f"Failed to verify InfluxDB connection: {e}"
            ) from e
    
    def get_existing_market_tickers(self) -> set:
        """Query InfluxDB to get all existing market tickers.
        
        Returns:
            Set of market_ticker strings that already exist in market_metadata
        """
        try:
            query_api = self.client.query_api()
            # Use tag values query - much faster than scanning all data
            query = f'''
                import "influxdata/influxdb/schema"
                
                schema.tagValues(
                    bucket: "{self.bucket}",
                    tag: "market_ticker",
                    predicate: (r) => r._measurement == "market_metadata",
                    start: -365d
                )
            '''
            
            result = query_api.query(query=query, org=self.org)
            
            existing_tickers = set()
            for table in result:
                for record in table.records:
                    ticker = record.get_value()
                    if ticker:
                        existing_tickers.add(ticker)
            
            self.logger.info(
                "Retrieved existing market tickers",
                count=len(existing_tickers)
            )
            
            return existing_tickers
            
        except Exception as e:
            self.logger.warning(
                "Failed to query existing market tickers, will write all markets",
                error=str(e)
            )
            # Return empty set on error - will write all markets (safe fallback)
            return set()
    
    @retry_with_backoff(
        max_attempts=3,
        exceptions=(InfluxDBError, InfluxDBWriterError)
    )
    def write_market_snapshots(
        self,
        snapshots: List[MarketSnapshot],
        batch_size: int = 10000
    ) -> int:
        """Write market snapshots to InfluxDB as time-series data.
        
        Snapshots are written in batches for efficiency. Failed batches
        are logged but don't stop the overall write operation.
        
        Args:
            snapshots: List of MarketSnapshot objects to write
            batch_size: Number of points per batch (default: 10000)
            
        Returns:
            Number of successfully written snapshots
            
        Raises:
            InfluxDBWriterError: If write operation fails critically
        """
        if not snapshots:
            self.logger.debug("No snapshots to write")
            return 0
        
        total_written = 0
        total_failed = 0
        
        self.logger.info(
            "Starting to write market snapshots",
            total_snapshots=len(snapshots),
            batch_size=batch_size
        )
        
        for batch_num, batch in enumerate(batch_iterator(snapshots, batch_size), 1):
            try:
                # Convert snapshots to InfluxDB points
                points = []
                for snapshot in batch:
                    try:
                        point_dict = snapshot.to_influx_point()
                        
                        # Create Point object
                        point = Point(point_dict['measurement'])
                        
                        # Add tags
                        for tag_key, tag_value in point_dict['tags'].items():
                            point = point.tag(tag_key, tag_value)
                        
                        # Add fields
                        for field_key, field_value in point_dict['fields'].items():
                            point = point.field(field_key, field_value)
                        
                        # Set timestamp
                        point = point.time(point_dict['time'], WritePrecision.NS)
                        
                        points.append(point)
                        
                    except Exception as e:
                        self.logger.warning(
                            "Failed to convert snapshot to point",
                            market_ticker=snapshot.market_ticker,
                            error=str(e)
                        )
                        total_failed += 1
                
                # Write batch
                if points:
                    self.write_api.write(
                        bucket=self.bucket,
                        org=self.org,
                        record=points
                    )
                    total_written += len(points)
                    
                    self.logger.debug(
                        f"Wrote batch {batch_num}",
                        batch_num=batch_num,
                        points_written=len(points),
                        total_written=total_written
                    )
                    
            except InfluxDBError as e:
                self.logger.error(
                    f"Failed to write batch {batch_num}",
                    batch_num=batch_num,
                    batch_size=len(batch),
                    error=str(e)
                )
                total_failed += len(batch)
        
        self.logger.info(
            "Completed writing market snapshots",
            total_written=total_written,
            total_failed=total_failed,
            total_snapshots=len(snapshots)
        )
        
        return total_written
    
    def upsert_series(self, series: Series) -> None:
        """Insert or update series metadata.
        
        Series metadata is stored as a measurement with tags for querying.
        
        Args:
            series: Series object to upsert
            
        Raises:
            InfluxDBWriterError: If write fails
        """
        try:
            point = (
                Point("series_metadata")
                .tag("series_ticker", series.series_ticker)
                .tag("category", series.category)
                .field("title", series.title)
                .field("frequency", series.frequency or "unknown")
                .field("tags", ",".join(series.tags) if series.tags else "")
                .field("fee_multiplier", series.fee_multiplier or 0.0)
                .field("fee_type", series.fee_type or "")
                .field("created_time_ns", int(series.created_time.timestamp() * 1_000_000_000) if series.created_time else 0)
                .field("first_seen_ns", int(series.first_seen.timestamp() * 1_000_000_000))
                .field("last_updated_ns", int(series.last_updated.timestamp() * 1_000_000_000))
                .time(datetime.utcnow(), WritePrecision.NS)
            )
            
            self.write_api.write(
                bucket=self.bucket,
                org=self.org,
                record=point
            )
            
            self.logger.debug(
                "Upserted series metadata",
                series_ticker=series.series_ticker
            )
            
        except Exception as e:
            self.logger.error(
                "Failed to upsert series metadata",
                series_ticker=series.series_ticker,
                error=str(e)
            )
            raise InfluxDBWriterError(
                f"Failed to upsert series {series.series_ticker}: {e}"
            ) from e
    
    def upsert_event(self, event: Event) -> None:
        """Insert or update event metadata.
        
        Event metadata is stored as a measurement with tags for querying.
        
        Args:
            event: Event object to upsert
            
        Raises:
            InfluxDBWriterError: If write fails
        """
        try:
            point = (
                Point("event_metadata")
                .tag("event_ticker", event.event_ticker)
                .tag("series_ticker", event.series_ticker)
                .tag("category", event.category)
                .field("title", event.title)
                .field("sub_title", event.sub_title or "")
                .field("mutually_exclusive", event.mutually_exclusive)
                .field("available_on_brokers", ",".join(event.available_on_brokers) if event.available_on_brokers else "")
                .field("strike_date_ns", int(event.strike_date.timestamp() * 1_000_000_000) if event.strike_date else 0)
                .field("created_time_ns", int(event.created_time.timestamp() * 1_000_000_000) if event.created_time else 0)
                .field("first_seen_ns", int(event.first_seen.timestamp() * 1_000_000_000))
                .field("last_updated_ns", int(event.last_updated.timestamp() * 1_000_000_000))
                .time(datetime.utcnow(), WritePrecision.NS)
            )
            
            self.write_api.write(
                bucket=self.bucket,
                org=self.org,
                record=point
            )
            
            self.logger.debug(
                "Upserted event metadata",
                event_ticker=event.event_ticker
            )
            
        except Exception as e:
            self.logger.error(
                "Failed to upsert event metadata",
                event_ticker=event.event_ticker,
                error=str(e)
            )
            raise InfluxDBWriterError(
                f"Failed to upsert event {event.event_ticker}: {e}"
            ) from e
    
    def upsert_market(self, market: Market) -> None:
        """Insert or update market metadata.
        
        Market metadata is stored as a measurement with tags for querying.
        
        Args:
            market: Market object to upsert
            
        Raises:
            InfluxDBWriterError: If write fails
        """
        try:
            point = (
                Point("market_metadata")
                .tag("market_ticker", market.market_ticker)
                .tag("event_ticker", market.event_ticker)
                .tag("series_ticker", market.series_ticker)
                .tag("status", market.status)
                .field("title", market.title)
                .field("subtitle", market.subtitle or "")
                .field("yes_sub_title", market.yes_sub_title)
                .field("no_sub_title", market.no_sub_title)
                .field("open_time_ns", int(market.open_time.timestamp() * 1_000_000_000) if market.open_time else 0)
                .field("close_time_ns", int(market.close_time.timestamp() * 1_000_000_000) if market.close_time else 0)
                .field("expected_expiration_time_ns", int(market.expected_expiration_time.timestamp() * 1_000_000_000) if market.expected_expiration_time else 0)
                .field("settlement_value", market.settlement_value or "")
                .field("result", market.result or "")
                .field("can_close_early", market.can_close_early)
                .field("floor_strike", market.floor_strike or 0.0)
                .field("cap_strike", market.cap_strike or 0.0)
                .field("strike_type", market.strike_type or "")
                .field("tick_size", market.tick_size or 0.0)
                .field("price_step", market.price_step or 0.0)
                .field("first_seen_ns", int(market.first_seen.timestamp() * 1_000_000_000))
                .field("last_updated_ns", int(market.last_updated.timestamp() * 1_000_000_000))
                .time(datetime.utcnow(), WritePrecision.NS)
            )
            
            self.write_api.write(
                bucket=self.bucket,
                org=self.org,
                record=point
            )
            
            self.logger.debug(
                "Upserted market metadata",
                market_ticker=market.market_ticker
            )
            
        except Exception as e:
            self.logger.error(
                "Failed to upsert market metadata",
                market_ticker=market.market_ticker,
                error=str(e)
            )
            raise InfluxDBWriterError(
                f"Failed to upsert market {market.market_ticker}: {e}"
            ) from e
    
    def batch_upsert_series(self, series_list: List[Series]) -> int:
        """Batch upsert multiple series metadata records.
        
        Args:
            series_list: List of Series objects to upsert
            
        Returns:
            Number of successfully upserted records
        """
        if not series_list:
            return 0
        
        try:
            points = []
            now = datetime.utcnow()
            
            for series in series_list:
                point = (
                    Point("series_metadata")
                    .tag("series_ticker", series.series_ticker)
                    .tag("frequency", series.frequency)
                    .field("title", series.title)
                    .field("category", series.category)
                    .field("tags", ",".join(series.tags) if series.tags else "")
                    .field("first_seen_ns", int(series.first_seen.timestamp() * 1_000_000_000))
                    .field("last_updated_ns", int(series.last_updated.timestamp() * 1_000_000_000))
                    .time(now, WritePrecision.NS)
                )
                points.append(point)
            
            # Single batch write for all series
            self.write_api.write(
                bucket=self.bucket,
                org=self.org,
                record=points
            )
            
            self.logger.info(
                "Batch upserted series metadata",
                count=len(series_list)
            )
            
            return len(series_list)
            
        except Exception as e:
            self.logger.error(
                "Failed to batch upsert series",
                count=len(series_list),
                error=str(e)
            )
            raise InfluxDBWriterError(
                f"Failed to batch upsert {len(series_list)} series: {e}"
            ) from e
    
    def batch_upsert_events(self, events_list: List[Event]) -> int:
        """Batch upsert multiple event metadata records.
        
        Args:
            events_list: List of Event objects to upsert
            
        Returns:
            Number of successfully upserted records
        """
        if not events_list:
            return 0
        
        try:
            points = []
            now = datetime.utcnow()
            
            for event in events_list:
                point = (
                    Point("event_metadata")
                    .tag("event_ticker", event.event_ticker)
                    .tag("series_ticker", event.series_ticker)
                    .tag("category", event.category)
                    .field("title", event.title)
                    .field("sub_title", event.sub_title or "")
                    .field("mutually_exclusive", event.mutually_exclusive)
                    .field("strike_date_ns", int(event.strike_date.timestamp() * 1_000_000_000) if event.strike_date else 0)
                    .field("created_time_ns", int(event.created_time.timestamp() * 1_000_000_000) if event.created_time else 0)
                    .field("first_seen_ns", int(event.first_seen.timestamp() * 1_000_000_000))
                    .field("last_updated_ns", int(event.last_updated.timestamp() * 1_000_000_000))
                    .time(now, WritePrecision.NS)
                )
                points.append(point)
            
            # Single batch write for all events
            self.write_api.write(
                bucket=self.bucket,
                org=self.org,
                record=points
            )
            
            self.logger.info(
                "Batch upserted event metadata",
                count=len(events_list)
            )
            
            return len(events_list)
            
        except Exception as e:
            self.logger.error(
                "Failed to batch upsert events",
                count=len(events_list),
                error=str(e)
            )
            raise InfluxDBWriterError(
                f"Failed to batch upsert {len(events_list)} events: {e}"
            ) from e
    
    def batch_upsert_markets(self, markets_list: List[Market]) -> int:
        """Batch upsert multiple market metadata records.
        
        Args:
            markets_list: List of Market objects to upsert
            
        Returns:
            Number of successfully upserted records
        """
        if not markets_list:
            return 0
        
        try:
            points = []
            now = datetime.utcnow()
            
            for market in markets_list:
                point = (
                    Point("market_metadata")
                    .tag("market_ticker", market.market_ticker)
                    .tag("event_ticker", market.event_ticker)
                    .tag("series_ticker", market.series_ticker)
                    .tag("status", market.status)
                    .field("title", market.title)
                    .field("subtitle", market.subtitle or "")
                    .field("yes_sub_title", market.yes_sub_title)
                    .field("no_sub_title", market.no_sub_title)
                    .field("open_time_ns", int(market.open_time.timestamp() * 1_000_000_000) if market.open_time else 0)
                    .field("close_time_ns", int(market.close_time.timestamp() * 1_000_000_000) if market.close_time else 0)
                    .field("expected_expiration_time_ns", int(market.expected_expiration_time.timestamp() * 1_000_000_000) if market.expected_expiration_time else 0)
                    .field("settlement_value", market.settlement_value or "")
                    .field("result", market.result or "")
                    .field("can_close_early", market.can_close_early)
                    .field("floor_strike", market.floor_strike or 0.0)
                    .field("cap_strike", market.cap_strike or 0.0)
                    .field("strike_type", market.strike_type or "")
                    .field("first_seen_ns", int(market.first_seen.timestamp() * 1_000_000_000))
                    .field("last_updated_ns", int(market.last_updated.timestamp() * 1_000_000_000))
                    .time(now, WritePrecision.NS)
                )
                points.append(point)
            
            # Single batch write for all markets
            self.write_api.write(
                bucket=self.bucket,
                org=self.org,
                record=points
            )
            
            self.logger.info(
                "Batch upserted market metadata",
                count=len(markets_list)
            )
            
            return len(markets_list)
            
        except Exception as e:
            self.logger.error(
                "Failed to batch upsert markets",
                count=len(markets_list),
                error=str(e)
            )
            raise InfluxDBWriterError(
                f"Failed to batch upsert {len(markets_list)} markets: {e}"
            ) from e
    
    def verify_recent_writes(self, measurement: str, expected_min_count: int = 1) -> dict:
        """Verify that data was actually written to InfluxDB by querying recent data.
        
        Args:
            measurement: Measurement name to check (e.g., 'market_snapshot', 'market_metadata')
            expected_min_count: Minimum number of records expected
            
        Returns:
            Dictionary with verification results:
            - success: Whether verification passed
            - count: Number of records found
            - latest_timestamp: Most recent record timestamp
            - error: Error message if verification failed
        """
        try:
            query_api = self.client.query_api()
            
            # Query for records from the last 5 minutes
            query = f'''
                from(bucket: "{self.bucket}")
                    |> range(start: -5m)
                    |> filter(fn: (r) => r._measurement == "{measurement}")
                    |> group()
                    |> count()
            '''
            
            result = query_api.query(query=query, org=self.org)
            
            count = 0
            for table in result:
                for record in table.records:
                    count = record.get_value()
                    break
            
            # Also get the latest timestamp
            timestamp_query = f'''
                from(bucket: "{self.bucket}")
                    |> range(start: -5m)
                    |> filter(fn: (r) => r._measurement == "{measurement}")
                    |> group()
                    |> last()
                    |> keep(columns: ["_time"])
            '''
            
            timestamp_result = query_api.query(query=timestamp_query, org=self.org)
            latest_timestamp = None
            for table in timestamp_result:
                for record in table.records:
                    latest_timestamp = record.get_time()
                    break
            
            success = count >= expected_min_count
            
            result_dict = {
                'success': success,
                'count': count,
                'latest_timestamp': latest_timestamp.isoformat() if latest_timestamp else None,
                'error': None if success else f"Expected at least {expected_min_count} records, found {count}"
            }
            
            if success:
                self.logger.info(
                    f"Verified {measurement} writes",
                    **result_dict
                )
            else:
                self.logger.warning(
                    f"Write verification failed for {measurement}",
                    **result_dict
                )
            
            return result_dict
            
        except Exception as e:
            error_msg = f"Failed to verify writes: {e}"
            self.logger.error(error_msg)
            return {
                'success': False,
                'count': 0,
                'latest_timestamp': None,
                'error': error_msg
            }
    
    def close(self) -> None:
        """Close InfluxDB client and cleanup resources."""
        if self.write_api:
            self.write_api.close()
        if self.client:
            self.client.close()
        
        self.logger.debug("InfluxDB writer closed")
