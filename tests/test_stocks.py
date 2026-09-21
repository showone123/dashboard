import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
import stocks_service


class StocksTest(unittest.TestCase):
    def test_snapshot_is_structured_cached_and_bounded(self):
        stocks_service._cache.clear()
        stocks_service._NAMES.clear()
        stocks_service._names_loaded = False
        calls = []
        def fetch(request):
            calls.append(request.full_url)
            if 'tickers/list' in request.full_url:
                return {'code': 0, 'data': {'item': [{'thscode': '600519.SH', 'name': '贵州茅台'}]}}
            return {'code': 0, 'data': {'timestamp': 123, 'item': [
                {'thscode': '600519.SH', 'last_price': 100, 'price_change': None,
                 'price_change_ratio_pct': None, 'volume': 0, 'turnover': 0}]}}
        with patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': 'test-only'}):
            first = stocks_service.snapshot(['600519.SH'], fetch)
            second = stocks_service.snapshot(['600519.SH'], fetch)
            self.assertEqual(first, second)
            # 1 次行情快照 + 1 次名称字典；第二次调用两个都被缓存命中，不再产生请求
            self.assertEqual(len(calls), 2)
            self.assertEqual(sum('tickers/list' in u for u in calls), 1)
            self.assertEqual(first['items'][0]['price_change'], None)
            self.assertEqual(first['items'][0]['name'], '贵州茅台')
            with self.assertRaises(ValueError):
                stocks_service.snapshot(['http://localhost/'], fetch)
            with self.assertRaises(ValueError):
                stocks_service.snapshot(['600519.SH'] * 11, fetch)

    def test_names_failure_does_not_break_quotes(self):
        stocks_service._cache.clear()
        stocks_service._NAMES.clear()
        stocks_service._names_loaded = False
        def fetch(request):
            if 'tickers/list' in request.full_url:
                raise OSError('names upstream down')
            return {'code': 0, 'data': {'timestamp': 1, 'item': [{'thscode': '600519.SH', 'last_price': 100}]}}
        with patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': 'test-only'}):
            items = stocks_service.snapshot(['600519.SH'], fetch)['items']
            self.assertEqual(items[0]['last_price'], 100)
            self.assertEqual(items[0]['name'], '')

    def test_key_file_fallback_and_environment_priority(self):
        with TemporaryDirectory() as tmp:
            key_file = Path(tmp) / '.hithink_key'
            key_file.write_text('file-key\n', encoding='utf-8')
            with patch.object(stocks_service, '_KEY_FILE', str(key_file)), patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': ' env-key '}):
                self.assertEqual(stocks_service._api_key(), 'env-key')
            with patch.object(stocks_service, '_KEY_FILE', str(key_file)), patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': ''}):
                self.assertEqual(stocks_service._api_key(), 'file-key')
            key_file.write_text('', encoding='utf-8')
            with patch.object(stocks_service, '_KEY_FILE', str(key_file)), patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': ''}):
                with self.assertRaises(RuntimeError):
                    stocks_service.snapshot(['600519.SH'], lambda _: {})
            key_file.unlink()
            with patch.object(stocks_service, '_KEY_FILE', str(key_file)), patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': ''}):
                with self.assertRaises(RuntimeError):
                    stocks_service.snapshot(['600519.SH'], lambda _: {})


if __name__ == '__main__':
    unittest.main()
