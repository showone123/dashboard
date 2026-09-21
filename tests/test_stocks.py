import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
import stocks_service


class StocksTest(unittest.TestCase):
    def test_snapshot_is_structured_cached_and_bounded(self):
        stocks_service._cache.clear()
        calls = []
        def fetch(request):
            calls.append(request.full_url)
            return {'code': 0, 'data': {'timestamp': 123, 'item': [
                {'thscode': '600519.SH', 'last_price': 100, 'price_change': None,
                 'price_change_ratio_pct': None, 'volume': 0, 'turnover': 0}]}}
        with patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': 'test-only'}):
            first = stocks_service.snapshot(['600519.SH'], fetch)
            second = stocks_service.snapshot(['600519.SH'], fetch)
            self.assertEqual(first, second)
            self.assertEqual(len(calls), 1)
            self.assertEqual(first['items'][0]['price_change'], None)
            with self.assertRaises(ValueError):
                stocks_service.snapshot(['http://localhost/'], fetch)
            with self.assertRaises(ValueError):
                stocks_service.snapshot(['600519.SH'] * 11, fetch)


if __name__ == '__main__':
    unittest.main()
