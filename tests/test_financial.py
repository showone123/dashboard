import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
import financial_service as svc


class FinanceTest(unittest.TestCase):
    def setUp(self):
        svc._cache.clear()
        svc._hits.clear()

    def test_public_catalog_and_safe_query(self):
        self.assertEqual(len(svc.CATALOG), 79)
        self.assertNotIn('a-share-capital-flow-snapshot', svc.CATALOG)
        calls = []
        def fetch(req):
            calls.append(req.full_url)
            return {'code': 0, 'data': {'item': [{'thscode': '600519.SH'}]}}
        with patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': 'test-only'}):
            first = svc.query('meta-tickers-search', {'q': '600519'}, fetch=fetch)
            self.assertEqual(first, svc.query('meta-tickers-search', {'q': '600519'}, fetch=fetch))
            self.assertEqual(len(calls), 1)
            self.assertIn('limit=50', calls[0])
            with self.assertRaises(ValueError):
                svc.query('https://localhost/private', {}, fetch=fetch)
            with self.assertRaises(ValueError):
                svc.query('meta-tickers-search', {'q': 'x', 'url': 'http://localhost'}, fetch=fetch)
            with self.assertRaises(ValueError):
                svc.query('meta-tickers-search', {}, fetch=fetch)
            with self.assertRaises(ValueError):
                svc.query('meta-tickers-search', {'q': 'x', 'limit': '10000'}, fetch=fetch)

    def test_key_file_fallback(self):
        with TemporaryDirectory() as tmp:
            key_file = Path(tmp) / '.hithink_key'
            key_file.write_text('file-key\n', encoding='utf-8')
            seen = []
            def fetch(req):
                seen.append(req.get_header('X-api-key'))
                return {'code': 0, 'data': {'item': []}}
            with patch.object(svc, '_KEY_FILE', str(key_file)), patch.dict(os.environ, {'HITHINK_FINANCE_API_KEY': ''}):
                svc.query('meta-tickers-search', {'q': '600519'}, fetch=fetch)
            self.assertEqual(seen, ['file-key'])


if __name__ == '__main__':
    unittest.main()
