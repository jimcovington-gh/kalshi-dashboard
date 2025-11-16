"""
DynamoDB metadata writer for Kalshi market data.

Handles batch writing and updating of Series, Event, and Market metadata
to DynamoDB tables with optimizations for performance.
"""

import time
import logging
from typing import List, Dict, Set, Optional, Any
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal
import boto3
from boto3.dynamodb.types import TypeSerializer, TypeDeserializer
from botocore.exceptions import ClientError

from models import Series, Event, Market


class DynamoDBMetadataWriter:
    """Writes and updates metadata to DynamoDB tables efficiently."""
    
    def __init__(
        self,
        series_table_name: str,
        event_table_name: str,
        market_table_name: str,
        region: str = 'us-east-1',
        logger: Optional[logging.Logger] = None
    ):
        """
        Initialize DynamoDB metadata writer.
        
        Args:
            series_table_name: Name of Series metadata table
            event_table_name: Name of Event metadata table
            market_table_name: Name of Market metadata table
            region: AWS region
            logger: Optional logger instance
        """
        self.series_table_name = series_table_name
        self.event_table_name = event_table_name
        self.market_table_name = market_table_name
        self.logger = logger or logging.getLogger(__name__)
        
        self.dynamodb = boto3.client('dynamodb', region_name=region)
        self.resource = boto3.resource('dynamodb', region_name=region)
        
        # Tables
        self.series_table = self.resource.Table(series_table_name)
        self.event_table = self.resource.Table(event_table_name)
        self.market_table = self.resource.Table(market_table_name)
        
        # TypeSerializer/Deserializer for converting between Python and DynamoDB formats
        self.serializer = TypeSerializer()
        self.deserializer = TypeDeserializer()
        
        self.logger.info(
            "DynamoDB metadata writer initialized",
            extra={
                "series_table": series_table_name,
                "event_table": event_table_name,
                "market_table": market_table_name
            }
        )
    
    def _deserialize_dynamodb_item(self, item: Dict) -> Dict[str, Any]:
        """
        Deserialize a DynamoDB item to Python dict.
        
        Args:
            item: DynamoDB item in low-level format (with type descriptors)
            
        Returns:
            Python dict with native types
        """
        return {k: self.deserializer.deserialize(v) for k, v in item.items()}
    
    def _convert_floats_to_decimal(self, obj: Any) -> Any:
        """
        Recursively convert all float values to Decimal for DynamoDB compatibility.
        
        DynamoDB does not support Python float type - must use decimal.Decimal for numbers.
        
        Args:
            obj: Python object (dict, list, float, or other)
            
        Returns:
            Object with all floats converted to Decimal
        """
        if isinstance(obj, float):
            return Decimal(str(obj))
        elif isinstance(obj, dict):
            return {k: self._convert_floats_to_decimal(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._convert_floats_to_decimal(item) for item in obj]
        return obj
    
    def get_event_by_ticker(self, event_ticker: str) -> Optional[Dict[str, Any]]:
        """
        Get event metadata from DynamoDB by event_ticker.
        
        Args:
            event_ticker: Event ticker to look up
            
        Returns:
            Dict with event data if found, None otherwise
        """
        try:
            response = self.event_table.get_item(
                Key={'event_ticker': event_ticker}
            )
            return response.get('Item')
        except Exception as e:
            self.logger.debug(f"Event not found in DynamoDB: {event_ticker}")
            return None
    
    def batch_get_events(self, event_tickers: List[str]) -> Dict[str, Dict[str, Any]]:
        """
        Batch get events from DynamoDB for multiple event_tickers.
        
        This is significantly faster than individual get_item calls.
        DynamoDB batch_get_item supports up to 100 items per request.
        
        Args:
            event_tickers: List of event tickers to fetch
            
        Returns:
            Dict mapping event_ticker to event data (only for events found in DB)
        """
        if not event_tickers:
            return {}
        
        events_cache = {}
        
        # Process in chunks of 100 (DynamoDB batch_get_item limit)
        for i in range(0, len(event_tickers), 100):
            chunk = event_tickers[i:i+100]
            
            try:
                response = self.resource.batch_get_item(
                    RequestItems={
                        self.event_table_name: {
                            'Keys': [{'event_ticker': ticker} for ticker in chunk]
                        }
                    }
                )
                
                # Extract items from response
                items = response.get('Responses', {}).get(self.event_table_name, [])
                for item in items:
                    event_ticker = item.get('event_ticker')
                    if event_ticker:
                        events_cache[event_ticker] = item
                
                # Handle unprocessed keys (throttling)
                unprocessed = response.get('UnprocessedKeys', {})
                while unprocessed:
                    self.logger.warning(f"Retrying {len(unprocessed)} unprocessed event keys")
                    time.sleep(0.1)
                    response = self.resource.batch_get_item(RequestItems=unprocessed)
                    
                    items = response.get('Responses', {}).get(self.event_table_name, [])
                    for item in items:
                        event_ticker = item.get('event_ticker')
                        if event_ticker:
                            events_cache[event_ticker] = item
                    
                    unprocessed = response.get('UnprocessedKeys', {})
                    
            except Exception as e:
                self.logger.error(f"Error batch fetching events: {e}")
                # Fall back to individual gets for this chunk
                for ticker in chunk:
                    event_item = self.get_event_by_ticker(ticker)
                    if event_item:
                        events_cache[ticker] = event_item
        
        self.logger.info(f"Batch fetched {len(events_cache)} events from DynamoDB")
        return events_cache
    
    def load_existing_series_tickers(self) -> set:
        """
        Load existing series tickers from DynamoDB.
        
        Returns:
            Set of series_ticker strings that already exist in DynamoDB
        """
        return set(self.load_existing_series_data().keys())
    
    def load_existing_series_data(self) -> dict:
        """
        Load existing series data from DynamoDB.
        
        Returns:
            Dict mapping series_ticker -> dict with 'category' and other fields
        """
        self.logger.info("Loading existing series data from DynamoDB")
        start_time = time.time()
        
        series_data = {}
        
        try:
            # Scan series table for ticker and category
            paginator = self.dynamodb.get_paginator('scan')
            page_iterator = paginator.paginate(
                TableName=self.series_table_name,
                ProjectionExpression='series_ticker,category'
            )
            
            for page in page_iterator:
                for item in page.get('Items', []):
                    ticker = item.get('series_ticker', {}).get('S')
                    category = item.get('category', {}).get('S', '')
                    if ticker:
                        series_data[ticker] = {'category': category}
            
            elapsed = time.time() - start_time
            self.logger.info(
                f"Loaded {len(series_data)} existing series with categories in {elapsed:.2f}s"
            )
            
        except Exception as e:
            self.logger.error(
                f"Failed to load existing series data: {str(e)}",
                error=str(e)
            )
        
        return series_data
    
    def load_existing_market_states(self) -> Dict[str, Dict]:
        """
        Load existing market tickers and their status from DynamoDB.
        
        Returns:
            Dict mapping market_ticker to {'status': str, 'last_updated': int}
        """
        self.logger.info("Loading existing market states from DynamoDB")
        start_time = time.time()
        
        market_states = {}
        
        try:
            # Scan market table for ticker and status
            paginator = self.dynamodb.get_paginator('scan')
            page_iterator = paginator.paginate(
                TableName=self.market_table_name,
                ProjectionExpression='market_ticker, #status, last_updated',
                ExpressionAttributeNames={'#status': 'status'}
            )
            
            for page in page_iterator:
                for item in page.get('Items', []):
                    ticker = item.get('market_ticker', {}).get('S')
                    status = item.get('status', {}).get('S')
                    last_updated = item.get('last_updated', {}).get('N')
                    
                    if ticker:
                        market_states[ticker] = {
                            'status': status,
                            'last_updated': int(last_updated) if last_updated else 0
                        }
            
            elapsed = time.time() - start_time
            self.logger.info(
                f"Loaded {len(market_states)} existing markets in {elapsed:.2f}s"
            )
            
            return market_states
            
        except Exception as e:
            self.logger.error(f"Failed to load existing markets: {e}")
            return {}
    
    def load_existing_events(self) -> Dict[str, Dict[str, Any]]:
        """
        Load ALL events from DynamoDB at startup.
        
        This is faster than doing multiple batch_get operations throughout execution.
        Events are lightweight - just event_ticker, series_ticker, title, etc.
        
        Returns:
            Dict mapping event_ticker -> event data
        """
        self.logger.info("Loading ALL existing events from DynamoDB")
        start_time = time.time()
        
        events_cache = {}
        
        try:
            # Full table scan with pagination
            paginator = self.dynamodb.get_paginator('scan')
            page_iterator = paginator.paginate(TableName=self.event_table_name)
            
            for page in page_iterator:
                for item in page.get('Items', []):
                    # Deserialize DynamoDB item to Python dict
                    event_data = self._deserialize_dynamodb_item(item)
                    event_ticker = event_data.get('event_ticker')
                    if event_ticker:
                        events_cache[event_ticker] = event_data
            
            elapsed = time.time() - start_time
            self.logger.info(
                f"Loaded {len(events_cache)} existing events in {elapsed:.2f}s"
            )
            
            return events_cache
            
        except Exception as e:
            self.logger.error(f"Failed to load existing events: {e}")
            return {}
    
    def batch_write_series(self, series_list: List[Series]) -> int:
        """
        Batch write Series metadata to DynamoDB.
        
        Args:
            series_list: List of Series objects to write
            
        Returns:
            Number of items successfully written
        """
        if not series_list:
            return 0
        
        self.logger.info(f"Batch writing {len(series_list)} series to DynamoDB")
        written_count = 0
        
        # Convert to DynamoDB items
        items = [self._series_to_dynamodb_item(s) for s in series_list]
        
        # Batch write in chunks of 25
        for i in range(0, len(items), 25):
            chunk = items[i:i+25]
            written_count += self._batch_write_chunk(
                self.series_table_name,
                chunk
            )
        
        self.logger.info(f"Wrote {written_count}/{len(series_list)} series to DynamoDB")
        return written_count
    
    def batch_write_events(self, events: List[Event]) -> int:
        """
        Batch write Event metadata to DynamoDB.
        
        Args:
            events: List of Event objects to write
            
        Returns:
            Number of items successfully written
        """
        if not events:
            return 0
        
        self.logger.info(f"Batch writing {len(events)} events to DynamoDB")
        written_count = 0
        
        # Convert to DynamoDB items
        items = [self._event_to_dynamodb_item(e) for e in events]
        
        # Batch write in chunks of 25
        for i in range(0, len(items), 25):
            chunk = items[i:i+25]
            written_count += self._batch_write_chunk(
                self.event_table_name,
                chunk
            )
        
        self.logger.info(f"Wrote {written_count}/{len(events)} events to DynamoDB")
        return written_count
    
    def batch_write_markets(self, markets: List[Market]) -> int:
        """
        Batch write market metadata to DynamoDB using UpdateItem to ensure existing markets are updated.
        
        Only writes ACTIVE markets (filters out closed/settled).
        Uses UpdateItem instead of PutRequest to update existing items with new category data.
        
        Args:
            markets: List of Market objects to write
            
        Returns:
            Number of items successfully written
        """
        if not markets:
            return 0
        
        # Filter to only active markets (Kalshi uses 'active' not 'open')
        original_count = len(markets)
        markets = [m for m in markets if m.status == 'active']
        
        if len(markets) < original_count:
            self.logger.info(f"Filtered out {original_count - len(markets)} non-active markets")
        
        if not markets:
            self.logger.info("No active markets to write")
            return 0
        
        self.logger.info(f"Batch writing {len(markets)} active markets to DynamoDB using UpdateItem")
        written_count = 0
        
        # Use individual UpdateItem operations to ensure existing markets are updated
        # This is necessary because PutRequest doesn't update existing items
        for market in markets:
            if self._update_market_metadata(market):
                written_count += 1
        
        self.logger.info(f"Wrote {written_count}/{len(markets)} markets to DynamoDB")
        return written_count
    
    def _update_market_metadata(self, market: Market) -> bool:
        """
        Update or insert market metadata using UpdateItem.
        
        This ensures existing markets get updated with new category data,
        fixing markets that have category="unknown" from old data.
        
        Args:
            market: Market object to write
            
        Returns:
            True if successful
        """
        try:
            item = self._market_to_dynamodb_item(market)
            
            # Build update expression for all fields
            update_parts = []
            attr_names = {}
            attr_values = {}
            
            for key, value in item.items():
                if key == 'market_ticker':
                    continue  # Skip primary key
                
                # Use attribute name placeholder to handle reserved words
                attr_name = f"#{key}"
                attr_value = f":{key}"
                
                update_parts.append(f"{attr_name} = {attr_value}")
                attr_names[attr_name] = key
                
                # Convert floats to Decimal before serialization
                converted_value = self._convert_floats_to_decimal(value)
                attr_values[attr_value] = self.serializer.serialize(converted_value)
            
            update_expression = "SET " + ", ".join(update_parts)
            
            self.dynamodb.update_item(
                TableName=self.market_table_name,
                Key={'market_ticker': self.serializer.serialize(market.market_ticker)},
                UpdateExpression=update_expression,
                ExpressionAttributeNames=attr_names,
                ExpressionAttributeValues=attr_values
            )
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to update market {market.market_ticker}: {e}")
            return False
    
    def update_market_prices_parallel(self, markets: List[Market], max_workers: int = 20) -> int:
        """
        Update market prices using parallel UpdateItem operations.
        
        Only updates price fields for existing markets. Used for OPEN markets.
        
        Args:
            markets: List of Market objects with updated prices
            max_workers: Number of parallel threads
            
        Returns:
            Number of markets successfully updated
        """
        if not markets:
            return 0
        
        self.logger.info(f"Updating prices for {len(markets)} markets using {max_workers} threads")
        start_time = time.time()
        
        updated_count = 0
        
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(self._update_single_market_prices, market): market
                for market in markets
            }
            
            for future in as_completed(futures):
                try:
                    if future.result():
                        updated_count += 1
                except Exception as e:
                    market = futures[future]
                    self.logger.error(
                        f"Failed to update market {market.market_ticker}: {e}"
                    )
        
        elapsed = time.time() - start_time
        self.logger.info(
            f"Updated {updated_count}/{len(markets)} markets in {elapsed:.2f}s "
            f"({updated_count/elapsed:.0f} updates/sec)"
        )
        
        return updated_count
    
    def update_market_full(self, market: Market) -> bool:
        """
        Full update of market (PutItem) for status-changed markets.
        
        Args:
            market: Market object to update
            
        Returns:
            True if successful
        """
        try:
            item = self._market_to_dynamodb_item(market)
            # Convert floats to Decimal for DynamoDB compatibility
            item_with_decimals = self._convert_floats_to_decimal(item)
            self.market_table.put_item(Item=item_with_decimals)
            return True
        except Exception as e:
            self.logger.error(f"Failed to update market {market.market_ticker}: {e}")
            return False
    
    def _batch_write_chunk(self, table_name: str, items: List[Dict]) -> int:
        """
        Write a chunk of items using BatchWriteItem.
        
        Args:
            table_name: Target table name
            items: List of Python dict items (max 25) - will be converted and serialized to DynamoDB format
            
        Returns:
            Number of items successfully written
        """
        if not items:
            return 0
        
        try:
            # Convert floats to Decimal (DynamoDB doesn't support Python float)
            items_with_decimals = [self._convert_floats_to_decimal(item) for item in items]
            
            # Serialize items to DynamoDB format
            dynamodb_items = [
                {k: self.serializer.serialize(v) for k, v in item.items()}
                for item in items_with_decimals
            ]
            
            request_items = {
                table_name: [{'PutRequest': {'Item': item}} for item in dynamodb_items]
            }
            
            response = self.dynamodb.batch_write_item(RequestItems=request_items)
            
            # Handle unprocessed items
            unprocessed = response.get('UnprocessedItems', {})
            if unprocessed:
                self.logger.warning(
                    f"Batch write had {len(unprocessed.get(table_name, []))} unprocessed items"
                )
                # Could implement retry logic here
            
            return len(items) - len(unprocessed.get(table_name, []))
            
        except Exception as e:
            self.logger.error(f"Batch write failed: {e}")
            return 0
    
    def _update_single_market_prices(self, market: Market) -> bool:
        """
        Update price fields for a single market using UpdateItem.
        
        Args:
            market: Market with updated prices
            
        Returns:
            True if successful
        """
        try:
            # Build update expression for price fields only
            update_expression_parts = []
            expression_attribute_values = {}
            
            price_fields = {
                'yes_price': market.yes_price,
                'no_price': market.no_price,
                'yes_bid_dollars': market.yes_bid,
                'no_bid_dollars': market.no_bid,
                'yes_ask_dollars': market.yes_ask,
                'no_ask_dollars': market.no_ask,
                'last_price_dollars': market.last_price,
                'volume': market.volume,
                'volume_24h': market.volume_24h,
                'open_interest': market.open_interest,
                'liquidity': market.liquidity,
                'last_updated': int(market.last_updated.timestamp())
            }
            
            for field_name, value in price_fields.items():
                if value is not None:
                    update_expression_parts.append(f"{field_name} = :{field_name}")
                    # Convert float to Decimal for DynamoDB compatibility
                    converted_value = Decimal(str(value)) if isinstance(value, float) else value
                    expression_attribute_values[f":{field_name}"] = converted_value
            
            if not update_expression_parts:
                return False
            
            update_expression = "SET " + ", ".join(update_expression_parts)
            
            self.market_table.update_item(
                Key={'market_ticker': market.market_ticker},
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_attribute_values
            )
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to update market {market.market_ticker}: {e}")
            return False
    
    def _series_to_dynamodb_item(self, series: Series) -> Dict:
        """Convert Series model to DynamoDB item."""
        item = {
            'series_ticker': series.series_ticker,
            'ticker': series.series_ticker,  # Alias for compatibility
            'title': series.title,
            'category': series.category or '',
            'frequency': series.frequency or '',
            'tags': series.tags or [],
            'first_seen': int(series.first_seen.timestamp()),
            'last_updated': int(series.last_updated.timestamp())
        }
        return {k: v for k, v in item.items() if v is not None and v != ''}
    
    def _event_to_dynamodb_item(self, event: Event) -> Dict:
        """Convert Event model to DynamoDB item."""
        item = {
            'event_ticker': event.event_ticker,
            'series_ticker': event.series_ticker,
            'title': event.title,
            'sub_title': event.sub_title or '',
            'category': event.category or '',
            'mutually_exclusive': event.mutually_exclusive,
            'first_seen': int(event.first_seen.timestamp()),
            'last_updated': int(event.last_updated.timestamp())
        }
        
        if event.strike_date:
            item['strike_date'] = int(event.strike_date.timestamp())
        
        return {k: v for k, v in item.items() if v is not None and v != ''}
    
    def _market_to_dynamodb_item(self, market: Market) -> Dict:
        """Convert Market model to DynamoDB item."""
        item = {
            'market_ticker': market.market_ticker,
            'event_ticker': market.event_ticker,
            'series_ticker': market.series_ticker,
            'category': market.category or '',
            'title': market.title,
            'subtitle': market.subtitle or '',
            'yes_sub_title': market.yes_sub_title,
            'no_sub_title': market.no_sub_title,
            'status': market.status,
            'can_close_early': market.can_close_early,
            'first_seen': int(market.first_seen.timestamp()),
            'last_updated': int(market.last_updated.timestamp())
        }
        
        # Add optional timestamp fields
        if market.open_time:
            item['open_time'] = int(market.open_time.timestamp())
        if market.close_time:
            item['close_time'] = int(market.close_time.timestamp())
        if market.expected_expiration_time:
            item['expected_expiration_time'] = int(market.expected_expiration_time.timestamp())
        
        # Add optional fields
        optional_fields = {
            'settlement_value': market.settlement_value,
            'result': market.result,
            'floor_strike': market.floor_strike,
            'cap_strike': market.cap_strike,
            'strike_type': market.strike_type,
            'tick_size': market.tick_size,
            'price_step': market.price_step,
            # Price fields (stored with _dollars suffix for clarity)
            'yes_price': market.yes_price,
            'no_price': market.no_price,
            'yes_bid_dollars': market.yes_bid,
            'no_bid_dollars': market.no_bid,
            'yes_ask_dollars': market.yes_ask,
            'no_ask_dollars': market.no_ask,
            'last_price_dollars': market.last_price,
            'volume': market.volume,
            'volume_24h': market.volume_24h,
            'open_interest': market.open_interest,
            'liquidity': market.liquidity
        }
        
        for key, value in optional_fields.items():
            if value is not None:
                item[key] = value
        
        return {k: v for k, v in item.items() if v != ''}
