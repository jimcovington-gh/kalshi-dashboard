"""Utility functions for logging, retries, and error handling.

This module provides reusable utilities for the application including
structured logging, retry decorators, and helper functions.
"""

import time
import logging
import json
import functools
from typing import Any, Callable, Dict, Optional, TypeVar, cast
from datetime import datetime, timezone

import boto3


# Type variable for generic retry decorator
F = TypeVar('F', bound=Callable[..., Any])


class StructuredLogger:
    """Structured JSON logger for CloudWatch.
    
    This logger outputs JSON-formatted log messages that are easy to
    parse and query in CloudWatch Logs Insights.
    """
    
    def __init__(self, name: str, level: str = 'INFO'):
        """Initialize structured logger.
        
        Args:
            name: Logger name (typically module name)
            level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        """
        self.logger = logging.getLogger(name)
        self.logger.setLevel(getattr(logging, level.upper()))
        
        # Remove existing handlers to avoid duplicates
        self.logger.handlers = []
        
        # Create console handler with JSON formatter
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter())
        self.logger.addHandler(handler)
        
        # Prevent propagation to root logger
        self.logger.propagate = False
    
    def _log(
        self,
        level: str,
        message: str,
        **kwargs: Any
    ) -> None:
        """Internal log method that adds structured context.
        
        Args:
            level: Log level (debug, info, warning, error, critical)
            message: Log message
            **kwargs: Additional structured context fields
        """
        extra = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'level': level.upper(),
            'message': message,
            **kwargs
        }
        
        log_method = getattr(self.logger, level.lower())
        log_method(message, extra={'structured': extra})
    
    def debug(self, message: str, **kwargs: Any) -> None:
        """Log debug message with structured context."""
        self._log('DEBUG', message, **kwargs)
    
    def info(self, message: str, **kwargs: Any) -> None:
        """Log info message with structured context."""
        self._log('INFO', message, **kwargs)
    
    def warning(self, message: str, **kwargs: Any) -> None:
        """Log warning message with structured context."""
        self._log('WARNING', message, **kwargs)
    
    def error(self, message: str, **kwargs: Any) -> None:
        """Log error message with structured context."""
        self._log('ERROR', message, **kwargs)
    
    def critical(self, message: str, **kwargs: Any) -> None:
        """Log critical message with structured context."""
        self._log('CRITICAL', message, **kwargs)


class JsonFormatter(logging.Formatter):
    """JSON formatter for structured logging."""
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON.
        
        Args:
            record: Log record to format
            
        Returns:
            JSON-formatted log string
        """
        # Get structured data if available
        if hasattr(record, 'structured'):
            log_data = record.structured
        else:
            # Fallback to basic formatting
            log_data = {
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'level': record.levelname,
                'message': record.getMessage(),
                'module': record.module,
                'function': record.funcName,
                'line': record.lineno,
            }
        
        # Add exception info if present
        if record.exc_info:
            log_data['exception'] = self.formatException(record.exc_info)
        
        return json.dumps(log_data, default=str)


class CloudWatchMetrics:
    """CloudWatch custom metrics publisher.
    
    This class provides methods to emit custom metrics to CloudWatch
    for monitoring application performance and behavior.
    """
    
    def __init__(self, namespace: str = 'KalshiMarketCapture'):
        """Initialize CloudWatch metrics client.
        
        Args:
            namespace: CloudWatch metrics namespace
        """
        self.namespace = namespace
        self.client = boto3.client('cloudwatch')
        self.metrics_buffer: list[Dict[str, Any]] = []
    
    def put_metric(
        self,
        metric_name: str,
        value: float,
        unit: str = 'Count',
        dimensions: Optional[Dict[str, str]] = None
    ) -> None:
        """Add a metric to the buffer.
        
        Args:
            metric_name: Name of the metric
            value: Metric value
            unit: Metric unit (Count, Seconds, Milliseconds, etc.)
            dimensions: Optional metric dimensions
        """
        metric_data = {
            'MetricName': metric_name,
            'Value': value,
            'Unit': unit,
            'Timestamp': datetime.now(timezone.utc),
        }
        
        if dimensions:
            metric_data['Dimensions'] = [
                {'Name': k, 'Value': v} for k, v in dimensions.items()
            ]
        
        self.metrics_buffer.append(metric_data)
    
    def flush_metrics(self) -> None:
        """Flush all buffered metrics to CloudWatch.
        
        Metrics are sent in batches of up to 20 (CloudWatch API limit).
        """
        if not self.metrics_buffer:
            return
        
        # CloudWatch allows max 20 metrics per request
        batch_size = 20
        for i in range(0, len(self.metrics_buffer), batch_size):
            batch = self.metrics_buffer[i:i + batch_size]
            try:
                self.client.put_metric_data(
                    Namespace=self.namespace,
                    MetricData=batch
                )
            except Exception as e:
                # Log error but don't fail the application
                logging.error(f"Failed to publish metrics to CloudWatch: {e}")
        
        # Clear buffer after flushing
        self.metrics_buffer = []


def retry_with_backoff(
    max_attempts: int = 3,
    initial_delay: float = 1.0,
    exponential_base: float = 2.0,
    max_delay: float = 60.0,
    exceptions: tuple = (Exception,),
    logger: Optional[StructuredLogger] = None
) -> Callable[[F], F]:
    """Decorator for retrying functions with exponential backoff.
    
    Args:
        max_attempts: Maximum number of retry attempts
        initial_delay: Initial delay in seconds before first retry
        exponential_base: Base for exponential backoff calculation
        max_delay: Maximum delay between retries in seconds
        exceptions: Tuple of exception types to catch and retry
        logger: Optional logger for logging retry attempts
        
    Returns:
        Decorated function with retry logic
        
    Example:
        @retry_with_backoff(max_attempts=3, exceptions=(requests.RequestException,))
        def fetch_data():
            # Function that might fail
            pass
    """
    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            attempt = 0
            delay = initial_delay
            
            while attempt < max_attempts:
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    attempt += 1
                    if attempt >= max_attempts:
                        if logger:
                            logger.error(
                                f"Function {func.__name__} failed after {max_attempts} attempts",
                                error=str(e),
                                function=func.__name__
                            )
                        raise
                    
                    if logger:
                        logger.warning(
                            f"Function {func.__name__} failed, retrying in {delay}s",
                            attempt=attempt,
                            max_attempts=max_attempts,
                            delay=delay,
                            error=str(e),
                            function=func.__name__
                        )
                    
                    time.sleep(delay)
                    delay = min(delay * exponential_base, max_delay)
            
            # This should never be reached, but for type safety
            return func(*args, **kwargs)
        
        return cast(F, wrapper)
    return decorator


def measure_time(func: F) -> F:
    """Decorator to measure and log function execution time.
    
    Args:
        func: Function to measure
        
    Returns:
        Decorated function that logs execution time
    """
    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        start_time = time.time()
        try:
            result = func(*args, **kwargs)
            return result
        finally:
            duration_ms = (time.time() - start_time) * 1000
            logging.debug(
                f"Function {func.__name__} took {duration_ms:.2f}ms",
                extra={
                    'structured': {
                        'function': func.__name__,
                        'duration_ms': duration_ms,
                    }
                }
            )
    
    return cast(F, wrapper)


def batch_iterator(items: list[Any], batch_size: int):
    """Yield successive batches from a list.
    
    Args:
        items: List of items to batch
        batch_size: Size of each batch
        
    Yields:
        Batches of items
        
    Example:
        for batch in batch_iterator(range(100), 10):
            process_batch(batch)
    """
    for i in range(0, len(items), batch_size):
        yield items[i:i + batch_size]


def safe_get(dictionary: Dict[str, Any], *keys: str, default: Any = None) -> Any:
    """Safely get nested dictionary values.
    
    Args:
        dictionary: Dictionary to access
        *keys: Sequence of keys to traverse
        default: Default value if key path not found
        
    Returns:
        Value at key path or default
        
    Example:
        value = safe_get(data, 'user', 'profile', 'email', default='unknown')
    """
    current = dictionary
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def get_lambda_context_info() -> Dict[str, Any]:
    """Get Lambda execution context information.
    
    Returns:
        Dictionary with Lambda context details (if available)
    """
    import os
    
    context_info = {
        'function_name': os.getenv('AWS_LAMBDA_FUNCTION_NAME'),
        'function_version': os.getenv('AWS_LAMBDA_FUNCTION_VERSION'),
        'memory_limit_mb': os.getenv('AWS_LAMBDA_FUNCTION_MEMORY_SIZE'),
        'log_group': os.getenv('AWS_LAMBDA_LOG_GROUP_NAME'),
        'log_stream': os.getenv('AWS_LAMBDA_LOG_STREAM_NAME'),
        'region': os.getenv('AWS_REGION'),
    }
    
    # Remove None values
    return {k: v for k, v in context_info.items() if v is not None}


def format_bytes(bytes_value: int) -> str:
    """Format bytes as human-readable string.
    
    Args:
        bytes_value: Number of bytes
        
    Returns:
        Formatted string (e.g., "1.5 MB")
    """
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_value < 1024.0:
            return f"{bytes_value:.2f} {unit}"
        bytes_value /= 1024.0
    return f"{bytes_value:.2f} PB"


def calculate_execution_progress(
    current: int,
    total: int,
    start_time: float
) -> Dict[str, Any]:
    """Calculate execution progress and estimated completion time.
    
    Args:
        current: Current progress count
        total: Total items to process
        start_time: Execution start time (from time.time())
        
    Returns:
        Dictionary with progress metrics
    """
    elapsed = time.time() - start_time
    percent = (current / total * 100) if total > 0 else 0
    
    if current > 0:
        rate = current / elapsed
        remaining = total - current
        eta_seconds = remaining / rate if rate > 0 else 0
    else:
        rate = 0
        eta_seconds = 0
    
    return {
        'current': current,
        'total': total,
        'percent': round(percent, 2),
        'elapsed_seconds': round(elapsed, 2),
        'rate_per_second': round(rate, 2),
        'eta_seconds': round(eta_seconds, 2),
    }
