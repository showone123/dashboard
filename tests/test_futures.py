"""Offline regressions for last-good data, bounded refresh and existing routing."""
import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'build'))
from futures_service import Cache, parse_page, safe_url, FUTURE_COLUMNS


def table(price='10', extra=''):
    return '<table id="heyuetbl"><tr><td class="jysname">测试交易所</td></tr><tr><td class="heyuealink" title="手续费更新时间：2026-09-18"><a href="/qihuoshouxufeisingle?heyue=au">黄金(au2610)</a></td>' + ''.join('<td>' + s + '</td>' for s in [price] + ['0.5/万分之<br>(2元)'] * 11) + '</tr>' + extra + '</table>'


class ParserTests(unittest.TestCase):
    def test_units_and_source_time_preserved(self):
        result = parse_page('futures', table(), 'https://www.9qihuo.com/qihuoshouxufei')
        row = result['items'][0]
        self.assertEqual(len(row['fields']), len(FUTURE_COLUMNS) - 1)
        self.assertEqual(row['fields'][1][1], '0.5/万分之 (2元)')
        self.assertEqual(row['source_updated_at'], '2026-09-18')
        self.assertEqual(row['group'], '测试交易所')

    def test_error_page_and_changed_shape_rejected(self):
        for html in ['<h1>Access denied</h1>', table().replace('<td>10</td>', '')]:
            with self.assertRaises(ValueError):
                parse_page('futures', html, 'https://www.9qihuo.com/qihuoshouxufei')

    def test_links_are_restricted(self):
        for url in ['javascript:alert(1)', 'https://evil.test', '//evil.test/x', 'http://www.9qihuo.com@evil.test']:
            self.assertEqual(safe_url(url), '')
        self.assertEqual(safe_url('/gongsi'), 'https://www.9qihuo.com/gongsi')

    def test_bootstrap_covers_all_categories(self):
        seed = json.loads((ROOT / 'build/futures_seed.json').read_text(encoding='utf-8'))
        for key in ('futures', 'options', 'companies', 'articles', 'software', 'option:au_o'):
            self.assertTrue(seed[key]['items'], key)
            self.assertTrue(seed[key]['updated_at'])
            self.assertEqual(len(seed[key]['items']), len({r['id'] for r in seed[key]['items']}))


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Cache(self.tmp.name, fetcher=lambda _: table())

    def tearDown(self):
        self.cache.pool.shutdown(wait=True)
        self.tmp.cleanup()

    def wait_done(self):
        limit = time.monotonic() + 3
        while self.cache.running and time.monotonic() < limit:
            time.sleep(.01)
        self.assertFalse(self.cache.running)

    def test_failure_preserves_last_success_and_restart(self):
        self.cache._update('futures')
        good = self.cache.snapshot('futures')
        self.cache.fetcher = lambda _: '<h1>502 Bad Gateway</h1>'
        self.cache._update('futures')
        failed = self.cache.snapshot('futures')
        self.assertEqual(good['items'], failed['items'])
        self.assertEqual(good['updated_at'], failed['updated_at'])
        self.assertIn('error', failed)
        restarted = Cache(self.tmp.name)
        self.assertEqual(restarted.snapshot('futures')['items'], good['items'])
        restarted.pool.shutdown()

    def test_get_never_waits_for_scraper_and_refresh_deduplicates(self):
        gate = threading.Event()
        def delayed(_):
            gate.wait(2)
            return table()
        self.cache.fetcher = delayed
        self.assertEqual(self.cache.refresh('futures', True), 'started')
        start = time.monotonic()
        self.assertEqual(self.cache.snapshot('futures')['items'], [])
        self.assertLess(time.monotonic() - start, .1)
        self.assertEqual(self.cache.refresh('futures', True), 'running')
        gate.set(); self.wait_done()
        self.assertEqual(self.cache.refresh('futures', True), 'cooldown')

    def test_independent_categories_and_unknown_option(self):
        self.cache._update('futures')
        self.cache.fetcher = lambda _: '<h1>blocked</h1>'
        self.cache._update('companies')
        self.assertTrue(self.cache.snapshot('futures')['items'])
        with self.assertRaises(ValueError):
            self.cache.refresh('option:../../secret', True)

    def test_disk_failure_preserves_previous_snapshot(self):
        self.cache._update('futures')
        original = self.cache.snapshot('futures')
        bad = Path(self.tmp.name) / 'not-a-directory'
        bad.write_text('file')
        self.cache.directory = bad
        self.cache.fetcher = lambda _: table('999')
        self.cache._update('futures')
        self.assertEqual(original['items'], self.cache.snapshot('futures')['items'])


class RoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('futures_test_server', ROOT / 'dist/server.py')
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.module.CACHE = Cache(cls.tmp.name, ROOT / 'build/futures_seed.json', fetcher=lambda _: table())
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), cls.module.Handler)
        cls.url = 'http://127.0.0.1:' + str(cls.server.server_port)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()
        cls.module.CACHE.pool.shutdown(wait=True); cls.tmp.cleanup()

    def test_cached_api_and_refresh(self):
        with urlopen(self.url + '/api/futures?category=futures') as response:
            self.assertTrue(json.load(response)['items'])
        req = Request(self.url + '/api/futures/refresh?category=futures', method='POST', headers={'X-FluxDesk-Request':'1'})
        with urlopen(req) as response:
            self.assertIn(json.load(response)['action'], ('started', 'running', 'cooldown'))

    def test_unknown_category_and_cross_origin_refresh(self):
        for req, code in [
            (self.url + '/api/futures?category=http://localhost', 400),
            (Request(self.url + '/api/futures/refresh', method='POST'), 403),
            (Request(self.url + '/api/futures/refresh', method='POST', headers={'X-FluxDesk-Request':'1','Origin':'https://evil.test'}), 403),
        ]:
            with self.assertRaises(HTTPError) as err:
                urlopen(req)
            self.assertEqual(err.exception.code, code)

    def test_cloud_exclusion_spa_and_source_blocking(self):
        with self.assertRaises(HTTPError) as err:
            urlopen(self.url + '/.cloud/auth')
        self.assertEqual(err.exception.code, 404)
        for path in ['/typo-route', '/server.py', '/futures_service.py', '/.hidden/private', '/__pycache__/private.pyc']:
            with urlopen(self.url + path) as response:
                self.assertIn(b'<!DOCTYPE html>', response.read(100))


if __name__ == '__main__':
    unittest.main()
