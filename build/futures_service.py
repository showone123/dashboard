"""Nine Futures public-page extraction and last-good snapshots (stdlib only).

No user data or credentials are stored here. Only fixed source pages and option
links discovered in the source index can be fetched. The HTTP server owns one
Cache instance; refresh work runs in its bounded thread pool, never in GET.
"""
import copy
import hashlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

BASE = 'https://www.9qihuo.com'
# 抓取目标白名单。2026-09-18 按用户要求下线公司类（/gongsi）与软件类（/ruanjian）两个来源页：
# 不在此表内的 key 一律在 Cache.source() 抛 ValueError → 接口返回 400，不会触发抓取。
# 分类集合必须与 build/futures.js 的 categories 完全一致（verify.py §9 会比对）。
SOURCES = {
    'futures': ('期货手续费', '/qihuoshouxufei'),
    'options': ('期权手续费', '/qiquanshouxufei'),
    'articles': ('期货资料', '/fenlei/ziliao'),
}
FUTURE_COLUMNS = ['合约品种', '参考价格', '涨/跌停板', '买开保证金%', '卖开保证金%',
                  '保证金/每手', '开仓手续费', '平昨手续费', '平今手续费',
                  '每跳毛利/元', '手续费(开+平)', '每跳净利/元', '备注']
OPTION_COLUMNS = ['期权品种', '参考价格', '涨/跌停板', '成交量', '类型', '权利金',
                  '开仓手续费', '平昨手续费', '平今手续费', '行权手续费',
                  '每跳毛利/元', '手续费(开+平)', '每跳净利/元', '备注']


def now():
    return datetime.now(timezone.utc).isoformat()


class Node:
    def __init__(self, tag='', attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    def find(self, tag=None, cls=None, ident=None):
        out = []
        for child in self.children:
            if not isinstance(child, Node):
                continue
            if ((tag is None or child.tag == tag) and
                    (cls is None or cls in child.attrs.get('class', '').split()) and
                    (ident is None or child.attrs.get('id') == ident)):
                out.append(child)
            out.extend(child.find(tag, cls, ident))
        return out

    def text(self):
        if self.tag in ('script', 'style', 'noscript'):
            return ''
        return re.sub(r'\s+', ' ', ''.join(
            c.text() if isinstance(c, Node) else c for c in self.children)).strip()


class Tree(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
            'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag == 'br':
            self.stack[-1].children.append(' ')
        node = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def safe_url(href):
    url = urljoin(BASE, href)
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or parts.netloc != 'www.9qihuo.com':
        return ''
    return 'https://' + parts.netloc + parts.path + ('?' + parts.query if parts.query else '')


def first(nodes):
    return nodes[0] if nodes else Node()


def item(title, url, group='', fields=None, stamp=''):
    return {'id': hashlib.sha256((url + '|' + title).encode()).hexdigest()[:20],
            'title': title, 'url': url, 'group': group, 'fields': fields or [],
            'source_updated_at': stamp}


def parse_page(key, html, url):
    root = Tree(html).root
    records, columns = [], []
    if key == 'futures' or key.startswith('option:'):
        table = first(root.find(ident='heyuetbl'))
        columns = OPTION_COLUMNS if key.startswith('option:') else FUTURE_COLUMNS
        group = ''
        for row in table.find('tr'):
            cells = [c for c in row.children if isinstance(c, Node) and c.tag in ('td', 'th')]
            if not cells:
                continue
            if 'jysname' in cells[0].attrs.get('class', '').split():
                group = cells[0].text()
            elif 'heyuealink' in cells[0].attrs.get('class', '').split():
                if len(cells) != len(columns):
                    raise ValueError('来源表格列数变化，本次未覆盖缓存')
                link = safe_url(first(cells[0].find('a')).attrs.get('href', '')) or url
                if not cells[0].find('a'):
                    link = url
                stamp = cells[0].attrs.get('title', '').replace('手续费更新时间：', '')
                records.append(item(cells[0].text(), link, group,
                                    [[label, cell.text()] for label, cell in zip(columns[1:], cells[1:])], stamp))
    elif key == 'options':
        for a in root.find('a'):
            link = safe_url(a.attrs.get('href', ''))
            parts = urlsplit(link)
            code = parse_qs(parts.query).get('heyue', [''])[0]
            if parts.path == '/qiquanshouxufei' and re.fullmatch(r'[A-Za-z0-9_-]{1,24}', code):
                record = item(a.text(), link, '期权品种')
                record['product'] = code
                records.append(record)
    elif key == 'articles':
        for row in root.find(cls='post-info'):
            a = first(first(row.find('h2')).find('a'))
            stamp = first(row.find('time')).attrs.get('datetime', '')
            records.append(item(a.text(), safe_url(a.attrs.get('href', '')), '期货资料', [], stamp))
    records = list({r['id']: r for r in records if r['title'] and r['url']}.values())
    if not records:
        raise ValueError('来源未返回可识别内容，本次未覆盖缓存')
    if len(records) > 15000:
        raise ValueError('来源记录超出安全上限')
    return {'items': records, 'columns': columns, 'source_url': url,
            'scope': '来源当前页面；更多内容请查看原站' if key == 'articles' else
                     '来源费用原值（元或万分之），参考价格非实时行情',
            'updated_at': now()}


class SourceRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not safe_url(newurl):
            raise ValueError('来源跳转域名异常')
        return super().redirect_request(req, fp, code, msg, headers, safe_url(newurl))


def fetch_html(url):
    if not safe_url(url):
        raise ValueError('不支持的来源')
    req = Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; FluxDesk/1.0)',
                                'Referer': BASE + '/'})
    with build_opener(SourceRedirect()).open(req, timeout=20) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('来源页面过大')
        return raw.decode('utf-8-sig')


class Cache:
    TTL = 6 * 60 * 60
    COOLDOWN = 60

    def __init__(self, directory, seed=None, fetcher=fetch_html):
        self.directory = Path(directory)
        self.fetcher = fetcher
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='futures')
        self.data, self.running, self.attempts = {}, set(), {}
        if seed and Path(seed).exists():
            try:
                self.data = json.loads(Path(seed).read_text(encoding='utf-8'))
            except (OSError, ValueError):
                pass
        try:
            for path in self.directory.glob('*.json'):
                try:
                    saved = json.loads(path.read_text(encoding='utf-8'))
                    key = saved['key']
                    # 磁盘缓存比代码活得久（本平台跨重部署保留），所以这里要过滤：
                    # 已下线分类留下的旧文件不再装载。option:<品种代码> 是动态键，必须放行。
                    if key not in SOURCES and not key.startswith('option:'):
                        continue
                    self.data[key] = saved['snapshot']
                except (OSError, ValueError, KeyError):
                    continue
        except OSError:
            pass

    def source(self, key):
        if key in SOURCES:
            return BASE + SOURCES[key][1]
        if key.startswith('option:'):
            product = key.split(':', 1)[1]
            for r in self.data.get('options', {}).get('items', []):
                if r.get('product') == product:
                    return r['url']
        raise ValueError('未知分类或期权品种')

    def snapshot(self, key):
        with self.lock:
            url = self.source(key)
            result = copy.deepcopy(self.data.get(key, {'items': [], 'columns': [], 'source_url': url}))
            result['refreshing'] = key in self.running
            stamp = result.get('updated_at')
            result['stale'] = not stamp or time.time() - datetime.fromisoformat(stamp).timestamp() > self.TTL
            return result

    def refresh(self, key, force=False):
        with self.lock:
            self.source(key)
            if key in self.running:
                return 'running'
            elapsed = time.monotonic() - self.attempts.get(key, -1e20)
            if elapsed < self.COOLDOWN:
                return 'cooldown'
            if not force and not self.snapshot(key)['stale']:
                return 'fresh'
            if len(self.running) >= 8:
                return 'busy'
            self.running.add(key)
            self.attempts[key] = time.monotonic()
            self.pool.submit(self._update, key)
            return 'started'

    def _update(self, key):
        try:
            url = self.source(key)
            snapshot = parse_page(key, self.fetcher(url), url)
            # Persist before replacing the last good in-memory snapshot.
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / (hashlib.sha256(key.encode()).hexdigest() + '.json')
            temp = path.with_suffix('.tmp')
            temp.write_text(json.dumps({'key': key, 'snapshot': snapshot}, ensure_ascii=False), encoding='utf-8')
            os.replace(str(temp), str(path))
            with self.lock:
                self.data[key] = snapshot
        except Exception:
            with self.lock:
                existing = self.data.setdefault(key, {'items': [], 'columns': [], 'source_url': self.source(key)})
                existing['error'] = '更新失败，已保留上次数据；可稍后重试或查看来源。'
                existing['last_attempt_at'] = now()
        finally:
            with self.lock:
                self.running.discard(key)

    def start_background(self):
        def loop():
            while True:
                for key in SOURCES:
                    self.refresh(key)
                time.sleep(self.TTL)
        threading.Thread(target=loop, daemon=True, name='futures-schedule').start()
