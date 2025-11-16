import json
import os
import boto3
from influxdb_client import InfluxDBClient
import io
import csv
from datetime import datetime

def lambda_handler(event, context):
    """
    Query InfluxDB for market data and return as CSV
    
    Parameters (via event):
        - time_range: e.g., "-4h", "-1d", "-30m" (required)
        - market_ticker: e.g., "KXSPOTIFYSONGSOPALITE-25NOV07-265" (required)
    
    Returns:
        - CSV data as string
        - Row count
        - Query metadata
    """
    
    # Get parameters
    time_range = event.get('time_range')
    market_ticker = event.get('market_ticker')
    
    if not time_range or not market_ticker:
        return {
            'statusCode': 400,
            'body': json.dumps({
                'error': 'Missing required parameters: time_range and market_ticker'
            })
        }
    
    # Get InfluxDB configuration
    url = os.environ['INFLUXDB_URL']
    org = os.environ.get('INFLUXDB_ORG', 'productionkalshi')
    bucket = os.environ.get('INFLUXDB_BUCKET', 'marketdata')
    
    # Get token from Secrets Manager
    secrets_client = boto3.client('secretsmanager')
    secret_response = secrets_client.get_secret_value(SecretId='production-influxdb-token')
    secret_data = json.loads(secret_response['SecretString'])
    token = secret_data['token']
    
    # Build Flux query
    flux_query = f'''
from(bucket: "{bucket}")
  |> range(start: {time_range})
  |> filter(fn: (r) => r["market_ticker"] == "{market_ticker}")
  |> sort(columns: ["_time"])
'''
    
    print(f"Querying InfluxDB for market: {market_ticker}, time range: {time_range}")
    
    # Query InfluxDB
    client = InfluxDBClient(url=url, token=token, org=org, timeout=30000)
    query_api = client.query_api()
    
    try:
        result = query_api.query(flux_query)
        
        # Convert to CSV
        csv_buffer = io.StringIO()
        writer = None
        row_count = 0
        
        for table in result:
            for record in table.records:
                row_data = {
                    'time': record.get_time().isoformat(),
                    'field': record.get_field(),
                    'value': record.get_value(),
                    'market_ticker': record.values.get('market_ticker'),
                    'event_ticker': record.values.get('event_ticker'),
                    'series_ticker': record.values.get('series_ticker')
                }
                
                if writer is None:
                    writer = csv.DictWriter(csv_buffer, fieldnames=row_data.keys())
                    writer.writeheader()
                
                writer.writerow(row_data)
                row_count += 1
        
        csv_data = csv_buffer.getvalue()
        csv_buffer.close()
        client.close()
        
        # Check size
        data_size_mb = len(csv_data) / (1024 * 1024)
        
        if data_size_mb > 5.5:  # Leave some headroom below 6MB limit
            return {
                'statusCode': 413,
                'body': json.dumps({
                    'error': f'Data too large: {data_size_mb:.2f}MB (limit ~6MB)',
                    'row_count': row_count,
                    'suggestion': 'Use a shorter time range'
                })
            }
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'csv_data': csv_data,
                'row_count': row_count,
                'data_size_mb': round(data_size_mb, 2),
                'market_ticker': market_ticker,
                'time_range': time_range,
                'query_time': datetime.utcnow().isoformat()
            })
        }
        
    except Exception as e:
        client.close()
        print(f"Error querying InfluxDB: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'error_type': type(e).__name__
            })
        }
