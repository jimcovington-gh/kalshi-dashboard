"""
Lambda function to monitor Kalshi API changelog for breaking changes.
Runs weekly (Monday) to check for upcoming changes in Thursday releases.
Uses RSS feed for reliable parsing.
"""
import json
import logging
import os
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Dict, List, Any
from urllib.request import urlopen, Request
from urllib.error import URLError

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
SNS_TOPIC_ARN = os.environ.get('SNS_TOPIC_ARN', '')

# Kalshi changelog RSS feed URL
CHANGELOG_RSS_URL = "https://docs.kalshi.com/changelog/rss.xml"
LOOKAHEAD_DAYS = 14  # Check for changes within next 2 weeks


def fetch_changelog() -> str:
    """Fetch the Kalshi API changelog RSS feed."""
    logger.info("Fetching Kalshi API changelog RSS feed")
    
    try:
        req = Request(
            CHANGELOG_RSS_URL,
            headers={'User-Agent': 'Kalshi-Changelog-Monitor/1.0'}
        )
        with urlopen(req, timeout=10) as response:
            return response.read().decode('utf-8')
    except URLError as e:
        logger.error(f"Failed to fetch changelog: {str(e)}")
        raise


def parse_changelog(rss_content: str) -> List[Dict[str, Any]]:
    """Parse changelog RSS feed and extract breaking/upcoming changes with dates."""
    logger.info("Parsing changelog RSS feed for breaking changes")
    
    try:
        root = ET.fromstring(rss_content)
        
        # Find all items in the RSS feed
        items = root.findall('.//item')
        
        changes = []
        for item in items:
            # Get categories
            categories = [cat.text for cat in item.findall('category') if cat.text]
            
            # Check if this is a breaking change or upcoming change
            is_breaking = any('breaking' in cat.lower() for cat in categories)
            is_upcoming = any('upcoming' in cat.lower() for cat in categories)
            
            # We want breaking changes or anything marked as upcoming
            if is_breaking or is_upcoming:
                title_elem = item.find('title')
                title = title_elem.text if title_elem is not None and title_elem.text else 'Unknown'
                
                desc_elem = item.find('description')
                description = desc_elem.text if desc_elem is not None and desc_elem.text else ''
                
                pub_date_elem = item.find('pubDate')
                pub_date_str = pub_date_elem.text if pub_date_elem is not None else None
                
                link_elem = item.find('link')
                link = link_elem.text if link_elem is not None and link_elem.text else ''
                
                # Get content to extract the actual "Expected release:" date
                content_elem = item.find('{http://purl.org/rss/1.0/modules/content/}encoded')
                content = content_elem.text if content_elem is not None and content_elem.text else description
                
                # Try to extract "Expected release:" date from content
                # Format: "Expected release: <code>November 20, 2025</code>"
                import re
                release_date_match = re.search(r'Expected release:.*?(\w+ \d{1,2}(?:st|nd|rd|th)?, \d{4})', content, re.IGNORECASE)
                
                change_date = None
                date_source = "pubDate"
                
                if release_date_match:
                    # Found explicit expected release date in content
                    try:
                        date_str = release_date_match.group(1)
                        # Parse dates like "November 20, 2025" or "November 13th, 2025"
                        date_str_clean = re.sub(r'(\d+)(st|nd|rd|th)', r'\1', date_str)
                        change_date = datetime.strptime(date_str_clean, '%B %d, %Y')
                        # Make timezone-aware
                        from datetime import timezone
                        change_date = change_date.replace(tzinfo=timezone.utc)
                        date_source = "expected_release"
                    except Exception as e:
                        logger.warning(f"Could not parse expected release date '{release_date_match.group(1)}': {e}")
                
                # Fallback to publication date if no expected release found
                if change_date is None and pub_date_str:
                    try:
                        change_date = parsedate_to_datetime(pub_date_str)
                    except Exception as e:
                        logger.warning(f"Could not parse pubDate '{pub_date_str}': {e}")
                
                changes.append({
                    'date': change_date,
                    'date_str': change_date.strftime('%B %d, %Y') if change_date else 'Unknown',
                    'date_source': date_source,
                    'title': title,
                    'description': description[:500],  # Limit length
                    'categories': categories,
                    'link': link,
                    'is_breaking': is_breaking,
                    'is_upcoming': is_upcoming
                })
        
        logger.info(f"Found {len(changes)} total breaking/upcoming changes in changelog")
        return changes
        
    except ET.ParseError as e:
        logger.error(f"Failed to parse RSS feed: {str(e)}")
        raise


def filter_upcoming_changes(changes: List[Dict[str, Any]], days_ahead: int = LOOKAHEAD_DAYS) -> List[Dict[str, Any]]:
    """Filter breaking changes happening within the next N days."""
    upcoming = []
    now = datetime.now(datetime.UTC if hasattr(datetime, 'UTC') else None)
    if now.tzinfo is None:
        # Fallback for Python < 3.11
        from datetime import timezone
        now = datetime.now(timezone.utc)
    
    cutoff = now + timedelta(days=days_ahead)
    
    for change in changes:
        change_date = change.get('date')
        
        if change_date:
            # Make timezone-aware for comparison
            if change_date.tzinfo is None:
                from datetime import timezone
                change_date = change_date.replace(tzinfo=timezone.utc)
            
            # Include if the change is upcoming (not in the past, but within our window)
            if now <= change_date <= cutoff:
                upcoming.append(change)
            # Also include if it's marked as "Upcoming" even if we can't parse the exact date
            elif change.get('is_upcoming') and 'Expected release' in change.get('description', ''):
                upcoming.append(change)
    
    logger.info(f"Found {len(upcoming)} upcoming breaking changes within {days_ahead} days")
    return upcoming


def send_notification(changes: List[Dict[str, Any]]) -> None:
    """Send SNS notification about upcoming breaking changes."""
    if not SNS_TOPIC_ARN:
        logger.warning("SNS_TOPIC_ARN not configured, skipping notification")
        return
    
    if not changes:
        logger.info("No breaking changes to notify about")
        return
    
    # Format message
    message_lines = [
        "🚨 Kalshi API Breaking Changes Alert 🚨",
        "",
        f"Found {len(changes)} upcoming API changes that require attention:",
        ""
    ]
    
    for change in changes:
        is_breaking = "⚠️ BREAKING" if change.get('is_breaking') else "ℹ️ UPDATE"
        message_lines.extend([
            f"{is_breaking} - {change['title']}",
            f"Date: {change['date_str']}",
            f"Categories: {', '.join(change['categories'])}",
            f"Description: {change['description']}",
            f"Link: {change['link']}",
            ""
        ])
    
    message_lines.extend([
        "---",
        "Please review these changes and update the application code if needed.",
        "This check runs every Monday at 10:00 AM UTC (3 days before Thursday releases)."
    ])
    
    message = "\n".join(message_lines)
    subject = f"⚠️ Kalshi API: {len(changes)} Upcoming Changes Detected"
    
    # Send to SNS
    try:
        sns = boto3.client('sns')
        response = sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=subject[:100],  # SNS subject limit
            Message=message
        )
        logger.info(f"Notification sent successfully: {response['MessageId']}")
    except Exception as e:
        logger.error(f"Failed to send notification: {str(e)}")
        raise


def lambda_handler(event, context) -> Dict[str, Any]:
    """Lambda handler function."""
    logger.info("Changelog monitor started")
    
    try:
        # Fetch and parse changelog
        rss_content = fetch_changelog()
        all_changes = parse_changelog(rss_content)
        
        # Filter for upcoming changes
        upcoming_changes = filter_upcoming_changes(all_changes)
        
        # Send notification if there are upcoming changes
        if upcoming_changes:
            send_notification(upcoming_changes)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Changelog check completed',
                'total_breaking_changes': len(all_changes),
                'upcoming_changes': len(upcoming_changes),
                'changes': [
                    {
                        'title': c['title'],
                        'date': c['date_str'],
                        'is_breaking': c['is_breaking']
                    }
                    for c in upcoming_changes
                ]
            })
        }
        
    except Exception as e:
        logger.error(f"Changelog monitor failed: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e)
            })
        }


if __name__ == '__main__':
    """For local testing."""
    print("Testing Kalshi Changelog Monitor")
    print("=" * 50)
    
    result = lambda_handler({}, {})
    print(json.dumps(json.loads(result['body']), indent=2))
