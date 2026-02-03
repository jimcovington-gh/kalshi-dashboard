"""
Unit tests for get-settlements-analytics.py

Tests the new enhanced metrics:
- avg_entry_price
- avg_final_bid
- contracts_above_entry, contracts_equal_entry, contracts_below_entry
- pct_final_bid_below_90
- win_rate_final_bid_below_90
- avg_duration_hours
"""

import pytest
import sys
import os

# Import the module under test
# Need to handle the hyphenated filename
import importlib.util
spec = importlib.util.spec_from_file_location(
    "settlements_analytics",
    os.path.join(os.path.dirname(__file__), "get-settlements-analytics.py")
)
settlements_analytics = importlib.util.module_from_spec(spec)


# Mock boto3 before loading the module
class MockTable:
    def __init__(self, name):
        self.name = name

class MockDynamoDB:
    def Table(self, name):
        return MockTable(name)
    
    def batch_get_item(self, **kwargs):
        return {'Responses': {}}

# Patch boto3
import boto3
original_resource = boto3.resource
boto3.resource = lambda *args, **kwargs: MockDynamoDB()

# Now load the module
spec.loader.exec_module(settlements_analytics)

# Restore boto3
boto3.resource = original_resource


class TestGetPriceBucket:
    """Test the get_price_bucket function"""
    
    def test_below_95(self):
        assert settlements_analytics.get_price_bucket(0.90) == '<0.95'
        assert settlements_analytics.get_price_bucket(0.94) == '<0.95'
        assert settlements_analytics.get_price_bucket(0.00) == '<0.95'
    
    def test_95_bucket(self):
        assert settlements_analytics.get_price_bucket(0.95) == '0.95'
        assert settlements_analytics.get_price_bucket(0.959) == '0.95'
    
    def test_96_bucket(self):
        assert settlements_analytics.get_price_bucket(0.96) == '0.96'
        assert settlements_analytics.get_price_bucket(0.969) == '0.96'
    
    def test_97_bucket(self):
        assert settlements_analytics.get_price_bucket(0.97) == '0.97'
        assert settlements_analytics.get_price_bucket(0.979) == '0.97'
    
    def test_98_bucket(self):
        assert settlements_analytics.get_price_bucket(0.98) == '0.98'
        assert settlements_analytics.get_price_bucket(0.989) == '0.98'
    
    def test_99_plus(self):
        assert settlements_analytics.get_price_bucket(0.99) == '0.99+'
        assert settlements_analytics.get_price_bucket(1.00) == '0.99+'


class TestCalculateTradeOutcome:
    """Test the calculate_trade_outcome function"""
    
    def test_winning_yes_trade(self):
        trade = {
            'side': 'yes',
            'action': 'buy',
            'filled_count': 10,
            'avg_fill_price': 0.95,
            'settlement_result': 'yes',
            'settlement_price': 1.0,
            'settlement_time': 1700000000,
            'placed_at': 1699996400  # 1 hour before settlement
        }
        result = settlements_analytics.calculate_trade_outcome(trade)
        
        assert result['won'] == True
        assert result['side'] == 'yes'
        assert result['count'] == 10
        assert result['purchase_price'] == 0.95
        assert result['total_cost'] == 9.50
        assert result['total_return'] == 10.00
        assert result['profit'] == 0.50  # (1.00 - 0.95) * 10
        assert result['duration_hours'] == 1.0
    
    def test_losing_yes_trade(self):
        trade = {
            'side': 'yes',
            'action': 'buy',
            'filled_count': 5,
            'avg_fill_price': 0.96,
            'settlement_result': 'no',
            'settlement_price': 0.0,
            'settlement_time': 1700000000,
            'placed_at': 1699964000  # 10 hours before
        }
        result = settlements_analytics.calculate_trade_outcome(trade)
        
        assert result['won'] == False
        assert result['profit'] == -4.80  # -0.96 * 5
        assert result['duration_hours'] == 10.0
    
    def test_winning_no_trade(self):
        trade = {
            'side': 'no',
            'action': 'buy',
            'filled_count': 20,
            'avg_fill_price': 0.05,
            'settlement_result': 'no',
            'settlement_price': 0.0,
            'settlement_time': 1700000000,
            'placed_at': 1699900000
        }
        result = settlements_analytics.calculate_trade_outcome(trade)
        
        assert result['won'] == True
        assert result['profit'] == 19.00  # (1.00 - 0.05) * 20
    
    def test_sell_action_returns_none(self):
        trade = {
            'side': 'yes',
            'action': 'sell',
            'filled_count': 10,
            'avg_fill_price': 0.95,
            'settlement_result': 'yes',
            'settlement_price': 1.0,
        }
        result = settlements_analytics.calculate_trade_outcome(trade)
        assert result is None


class TestAggregateTrades:
    """Test the aggregate_trades function with enhanced metrics"""
    
    def test_basic_aggregation_by_category(self):
        trades = [
            {
                'category': 'Sports',
                'won': True,
                'count': 10,
                'purchase_price': 0.95,
                'total_cost': 9.50,
                'total_return': 10.00,
                'profit': 0.50,
                'final_bid_price': 0.98,
                'duration_hours': 2.0,
            },
            {
                'category': 'Sports',
                'won': False,
                'count': 5,
                'purchase_price': 0.96,
                'total_cost': 4.80,
                'total_return': 0.00,
                'profit': -4.80,
                'final_bid_price': 0.85,
                'duration_hours': 10.0,
            },
        ]
        
        result = settlements_analytics.aggregate_trades(trades, 'category')
        
        assert 'Sports' in result
        stats = result['Sports']
        
        assert stats['trades'] == 2
        assert stats['wins'] == 1
        assert stats['losses'] == 1
        assert stats['win_rate'] == 50.0
        assert stats['profit'] == -4.30  # 0.50 + (-4.80)
        
        # New metrics
        # avg_entry_price = (0.95*10 + 0.96*5) / 15 = 14.30 / 15 = 0.953
        assert abs(stats['avg_entry_price'] - 0.953) < 0.001
        
        # avg_final_bid = (0.98*10 + 0.85*5) / 15 = 14.05 / 15 = 0.937
        assert abs(stats['avg_final_bid'] - 0.937) < 0.001
        
        # contracts_above_entry: 0.98 > 0.95 -> 10 contracts
        assert stats['contracts_above_entry'] == 10
        
        # contracts_below_entry: 0.85 < 0.96 -> 5 contracts
        assert stats['contracts_below_entry'] == 5
        
        assert stats['contracts_equal_entry'] == 0
        
        # pct_final_bid_below_90: only 5 contracts (0.85) out of 15 = 33.3%
        assert abs(stats['pct_final_bid_below_90'] - 33.3) < 0.1
        
        # win_rate_final_bid_below_90: 0 wins out of 5 contracts below 0.90 = 0%
        assert stats['win_rate_final_bid_below_90'] == 0.0
        
        # avg_duration_hours = (2.0 + 10.0) / 2 = 6.0
        assert stats['avg_duration_hours'] == 6.0
    
    def test_aggregation_with_missing_final_bid(self):
        """Test that missing final_bid_price is handled gracefully"""
        trades = [
            {
                'category': 'Weather',
                'won': True,
                'count': 10,
                'purchase_price': 0.95,
                'total_cost': 9.50,
                'total_return': 10.00,
                'profit': 0.50,
                'final_bid_price': None,  # Missing metadata
                'duration_hours': 5.0,
            },
        ]
        
        result = settlements_analytics.aggregate_trades(trades, 'category')
        stats = result['Weather']
        
        assert stats['trades'] == 1
        assert stats['avg_entry_price'] == 0.95
        assert stats['avg_final_bid'] is None  # No data available
        assert stats['contracts_above_entry'] == 0
        assert stats['contracts_below_entry'] == 0
        assert stats['contracts_equal_entry'] == 0
        assert stats['pct_final_bid_below_90'] is None
        assert stats['win_rate_final_bid_below_90'] is None
    
    def test_aggregation_with_equal_entry_and_final_bid(self):
        """Test contracts where final bid equals entry price"""
        trades = [
            {
                'category': 'Politics',
                'won': True,
                'count': 10,
                'purchase_price': 0.96,
                'total_cost': 9.60,
                'total_return': 10.00,
                'profit': 0.40,
                'final_bid_price': 0.96,  # Equal to entry
                'duration_hours': 1.0,
            },
        ]
        
        result = settlements_analytics.aggregate_trades(trades, 'category')
        stats = result['Politics']
        
        assert stats['contracts_equal_entry'] == 10
        assert stats['contracts_above_entry'] == 0
        assert stats['contracts_below_entry'] == 0
    
    def test_aggregation_win_rate_below_90(self):
        """Test win rate calculation for contracts with final bid < 0.90"""
        trades = [
            {
                'category': 'Crypto',
                'won': True,
                'count': 10,
                'purchase_price': 0.85,
                'total_cost': 8.50,
                'total_return': 10.00,
                'profit': 1.50,
                'final_bid_price': 0.80,  # Below 0.90, won
                'duration_hours': 1.0,
            },
            {
                'category': 'Crypto',
                'won': False,
                'count': 10,
                'purchase_price': 0.85,
                'total_cost': 8.50,
                'total_return': 0.00,
                'profit': -8.50,
                'final_bid_price': 0.75,  # Below 0.90, lost
                'duration_hours': 1.0,
            },
            {
                'category': 'Crypto',
                'won': True,
                'count': 10,
                'purchase_price': 0.95,
                'total_cost': 9.50,
                'total_return': 10.00,
                'profit': 0.50,
                'final_bid_price': 0.98,  # Above 0.90
                'duration_hours': 1.0,
            },
        ]
        
        result = settlements_analytics.aggregate_trades(trades, 'category')
        stats = result['Crypto']
        
        # 20 contracts below 0.90 out of 30 total = 66.7%
        assert abs(stats['pct_final_bid_below_90'] - 66.7) < 0.1
        
        # 10 winning contracts out of 20 below 0.90 = 50%
        assert stats['win_rate_final_bid_below_90'] == 50.0
    
    def test_aggregation_by_price_bucket(self):
        """Test grouping by price bucket"""
        trades = [
            {
                'purchase_price': 0.95,
                'won': True,
                'count': 10,
                'total_cost': 9.50,
                'total_return': 10.00,
                'profit': 0.50,
                'final_bid_price': 0.96,
                'duration_hours': 1.0,
            },
            {
                'purchase_price': 0.99,
                'won': False,
                'count': 5,
                'total_cost': 4.95,
                'total_return': 0.00,
                'profit': -4.95,
                'final_bid_price': 0.98,
                'duration_hours': 2.0,
            },
        ]
        
        result = settlements_analytics.aggregate_trades(trades, 'price_bucket')
        
        assert '0.95' in result
        assert '0.99+' in result
        assert result['0.95']['trades'] == 1
        assert result['0.99+']['trades'] == 1


class TestGetCategoryFromTicker:
    """Test ticker to category mapping"""
    
    def test_sports_tickers(self):
        assert settlements_analytics.get_category_from_ticker('KXNBA-SOMETHING') == 'Sports'
        assert settlements_analytics.get_category_from_ticker('KXNFLMENTION-26JAN') == 'Sports'
    
    def test_weather_tickers(self):
        assert settlements_analytics.get_category_from_ticker('KXHIGH-NYC-25JAN') == 'Weather'
    
    def test_unknown_ticker(self):
        assert settlements_analytics.get_category_from_ticker('KXUNKNOWN-STUFF') == 'Other'


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
