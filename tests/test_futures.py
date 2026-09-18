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

    def test_unknown_category_and_unkeyed_refresh(self):
        for req, code in [
            (self.url + '/api/futures?category=http://localhost', 400),
            (Request(self.url + '/api/futures/refresh', method='POST'), 403),
            (Request(self.url + '/api/futures/refresh', method='POST', headers={'X-FluxDesk-Request':'0'}), 403),
        ]:
            with self.assertRaises(HTTPError) as err:
                urlopen(req)
            self.assertEqual(err.exception.code, code)

    def test_same_origin_refresh_is_allowed(self):
        """正向用例：真实浏览器走的就是这条路（必带 Origin）。

        2026-09-18 线上故障：服务端拿 Origin 的 netloc 去比对 Host，而平台边缘网关
        不向应用转发可用的 Host，导致这里恒不相等 → 所有真实用户的"立即刷新"都 403。
        当时门禁只有反向用例（无头→403、Origin: evil.test→403），
        "永远 403" 的实现照样全绿 —— 这正是本用例存在的理由。
        """
        req = Request(self.url + '/api/futures/refresh?category=futures', method='POST',
                      headers={'X-FluxDesk-Request': '1', 'Origin': self.url})
        with urlopen(req) as response:
            self.assertIn(json.load(response)['action'], ('started', 'running', 'cooldown'))

    def test_refresh_does_not_depend_on_host_header(self):
        """回归用例，与环境无关：故意错配 Host + 正确 Origin，必须仍然成功。

        修好之前这条会 403（netloc != Host），修好之后必须 200。
        等价于把"网关不转发可用 Host"这个真实条件搬进了测试。
        """
        req = Request(self.url + '/api/futures/refresh?category=options', method='POST',
                      headers={'X-FluxDesk-Request': '1', 'Origin': self.url,
                               'Host': 'gateway.internal:9999'})
        with urlopen(req) as response:
            self.assertIn(json.load(response)['action'], ('started', 'running', 'cooldown'))

    def test_refresh_ignores_origin_because_preflight_is_the_real_gate(self):
        """跨站防护不靠比对 Origin，而靠"不暴露任何 CORS 头"。

        自定义头不是 CORS 安全头 → 跨域 fetch 必先预检 → 服务端不返回 Access-Control-*，
        浏览器拦掉真实请求；form 提交又设不了自定义头。两条路径都在自定义头这一关死掉。
        所以带自定义头的跨域 Origin 被接受是设计如此，前提是下面那条用例成立。
        """
        req = Request(self.url + '/api/futures/refresh?category=articles', method='POST',
                      headers={'X-FluxDesk-Request': '1', 'Origin': 'https://evil.test'})
        with urlopen(req) as response:
            self.assertIn(json.load(response)['action'], ('started', 'running', 'cooldown'))

    def test_no_cors_headers_are_ever_exposed(self):
        """把上面那条用例的前提锁死：预检拿不到任何 CORS 头，跨域请求就发不出去。"""
        req = Request(self.url + '/api/futures/refresh?category=futures', method='OPTIONS',
                      headers={'Origin': 'https://evil.test',
                               'Access-Control-Request-Method': 'POST',
                               'Access-Control-Request-Headers': 'x-fluxdesk-request'})
        try:
            response = urlopen(req)
        except HTTPError as err:
            response = err
        leaked = [name for name in response.headers.keys()
                  if name.lower().startswith('access-control')]
        self.assertEqual([], leaked, 'response must not expose CORS headers: %s' % leaked)

    def test_cloud_exclusion_spa_and_source_blocking(self):
        with self.assertRaises(HTTPError) as err:
            urlopen(self.url + '/.cloud/auth')
        self.assertEqual(err.exception.code, 404)
        for path in ['/typo-route', '/server.py', '/futures_service.py', '/.hidden/private', '/__pycache__/private.pyc']:
            with urlopen(self.url + path) as response:
                self.assertIn(b'<!DOCTYPE html>', response.read(100))


if __name__ == '__main__':
    unittest.main()
