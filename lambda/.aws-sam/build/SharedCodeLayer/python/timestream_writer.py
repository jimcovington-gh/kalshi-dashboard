"""
Writes Kalshi market data to Amazon Timestream.
"""
import logging
from datetime import datetime
from typing import List, Dict, Any, Optional
import boto3
from botocore.exceptions import ClientError

from models import MarketSnapshot

logger = logging.getLogger(__name__)


class TimestreamWriter:
    """Writes market snapshots to Amazon Timestream."""
    
    def __init__(
        self,
        database_name: str,
        table_name: str,
        region: str = 'us-east-1'
    ):
        """
        Initialize Timestream writer.
        
        Args:
            database_name: Timestream database name
            table_name: Timestream table name
            region: AWS region
        """
        self.database_name = database_name
        self.table_name = table_name
        self.region = region
        
        # Initialize Timestream client
        self.client = boto3.client('timestream-write', region_name=region)
        
        logger.info(
            f"Initialized TimestreamWriter for {database_name}.{table_name}"
        )
    
    def write_snapshots(
        self,
        snapshots: List[MarketSnapshot]
    ) -> tuple[int, int]:
        """
        Write market snapshots to Timestream.
        
        Args:
            snapshots: List of market snapshots to write
            
        Returns:
            Tuple of (successful_writes, failed_writes)
        """
        if not snapshots:
            logger.warning("No snapshots to write")
            return 0, 0
        
        successful = 0
        failed = 0
        
        # Timestream supports up to 100 records per request
        batch_size = 100
        
        for i in range(0, len(snapshots), batch_size):
            batch = snapshots[i:i + batch_size]
            
            try:
                records = self._convert_snapshots_to_records(batch)
                
                self.client.write_records(
                    DatabaseName=self.database_name,
                    TableName=self.table_name,
                    Records=records
                )
                
                successful += len(batch)
                logger.debug(f"Wrote batch of {len(batch)} records")
                
            except ClientError as e:
                error_code = e.response['Error']['Code']
                error_msg = e.response['Error']['Message']
                logger.error(
                    f"Failed to write batch: {error_code} - {error_msg}"
                )
                failed += len(batch)
            except Exception as e:
                logger.error(f"Unexpected error writing batch: {e}")
                failed += len(batch)
        
        logger.info(
            f"Write complete: {successful} successful, {failed} failed"
        )
        
        return successful, failed
    
    def _convert_snapshots_to_records(
        self,
        snapshots: List[MarketSnapshot]
    ) -> List[Dict[str, Any]]:
        """
        Convert market snapshots to Timestream records.
        
        Args:
            snapshots: List of market snapshots
            
        Returns:
            List of Timestream record dictionaries
        """
        records = []
        
        for snapshot in snapshots:
            # Get timestamp in nanoseconds since epoch
            if isinstance(snapshot.timestamp, datetime):
                timestamp_ms = int(snapshot.timestamp.timestamp() * 1000)
            else:
                timestamp_ms = snapshot.timestamp
            
            # Build dimensions (identifying attributes)
            dimensions = [
                {'Name': 'ticker', 'Value': snapshot.ticker},
                {'Name': 'market_id', 'Value': str(snapshot.market_id)},
            ]
            
            if snapshot.event_ticker:
                dimensions.append({
                    'Name': 'event_ticker',
                    'Value': snapshot.event_ticker
                })
            
            if snapshot.market_type:
                dimensions.append({
                    'Name': 'market_type',
                    'Value': snapshot.market_type
                })
            
            if snapshot.category:
                dimensions.append({
                    'Name': 'category',
                    'Value': snapshot.category
                })
            
            if snapshot.title:
                # Timestream dimension values max 2048 chars
                title = snapshot.title[:2048]
                dimensions.append({'Name': 'title', 'Value': title})
            
            if snapshot.subtitle:
                subtitle = snapshot.subtitle[:2048]
                dimensions.append({'Name': 'subtitle', 'Value': subtitle})
            
            if snapshot.status:
                dimensions.append({'Name': 'status', 'Value': snapshot.status})
            
            # Build multi-measure record with all numeric/boolean values
            measure_values = []
            
            # Price measures
            if snapshot.yes_bid is not None:
                measure_values.append({
                    'Name': 'yes_bid',
                    'Value': str(snapshot.yes_bid),
                    'Type': 'DOUBLE'
                })
            
            if snapshot.yes_ask is not None:
                measure_values.append({
                    'Name': 'yes_ask',
                    'Value': str(snapshot.yes_ask),
                    'Type': 'DOUBLE'
                })
            
            if snapshot.no_bid is not None:
                measure_values.append({
                    'Name': 'no_bid',
                    'Value': str(snapshot.no_bid),
                    'Type': 'DOUBLE'
                })
            
            if snapshot.no_ask is not None:
                measure_values.append({
                    'Name': 'no_ask',
                    'Value': str(snapshot.no_ask),
                    'Type': 'DOUBLE'
                })
            
            # Volume measures
            if snapshot.volume is not None:
                measure_values.append({
                    'Name': 'volume',
                    'Value': str(snapshot.volume),
                    'Type': 'BIGINT'
                })
            
            if snapshot.open_interest is not None:
                measure_values.append({
                    'Name': 'open_interest',
                    'Value': str(snapshot.open_interest),
                    'Type': 'BIGINT'
                })
            
            # Liquidity measures
            if snapshot.liquidity is not None:
                measure_values.append({
                    'Name': 'liquidity',
                    'Value': str(snapshot.liquidity),
                    'Type': 'BIGINT'
                })
            
            # Risk measures
            if snapshot.yes_sub_title is not None:
                measure_values.append({
                    'Name': 'yes_sub_title',
                    'Value': str(snapshot.yes_sub_title),
                    'Type': 'VARCHAR'
                })
            
            if snapshot.no_sub_title is not None:
                measure_values.append({
                    'Name': 'no_sub_title',
                    'Value': str(snapshot.no_sub_title),
                    'Type': 'VARCHAR'
                })
            
            # Boolean measures
            if snapshot.can_close_early is not None:
                measure_values.append({
                    'Name': 'can_close_early',
                    'Value': 'true' if snapshot.can_close_early else 'false',
                    'Type': 'BOOLEAN'
                })
            
            # Create the record
            record = {
                'Time': str(timestamp_ms),
                'TimeUnit': 'MILLISECONDS',
                'Dimensions': dimensions,
                'MeasureName': 'market_snapshot',
                'MeasureValueType': 'MULTI',
                'MeasureValues': measure_values
            }
            
            records.append(record)
        
        return records
    
    def test_connection(self) -> bool:
        """
        Test connection to Timestream.
        
        Returns:
            True if connection is successful, False otherwise
        """
        try:
            response = self.client.describe_table(
                DatabaseName=self.database_name,
                TableName=self.table_name
            )
            logger.info(f"Successfully connected to Timestream table")
            logger.debug(f"Table details: {response['Table']}")
            return True
        except ClientError as e:
            logger.error(f"Failed to connect to Timestream: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error testing connection: {e}")
            return False
    
    def get_table_info(self) -> Optional[Dict[str, Any]]:
        """
        Get information about the Timestream table.
        
        Returns:
            Table information dictionary or None if error
        """
        try:
            response = self.client.describe_table(
                DatabaseName=self.database_name,
                TableName=self.table_name
            )
            return response['Table']
        except Exception as e:
            logger.error(f"Failed to get table info: {e}")
            return None
