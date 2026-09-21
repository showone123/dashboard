"""Allowlisted Fuyao REST adapter for the finance explorer (stdlib only)."""
import json
import os
import threading
import time
from collections import OrderedDict, defaultdict, deque
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CATALOG = {x['id']: x for x in json.loads((Path(__file__).parent / 'financial_catalog.json').read_text(encoding='utf-8'))}
_cache = OrderedDict()
_hits = defaultdict(deque)
_lock = threading.Lock()


def query(endpoint_id, params, client='local', fetch=None):
    endpoint = CATALOG.get(endpoint_id)
    if endpoint is None or not isinstance(params, dict):
        raise ValueError('Unknown endpoint or invalid parameters')
    allowed = {p['name']: p for p in endpoint['params']}
    if set(params) - set(allowed):
        raise ValueError('Unsupported parameter')
    clean = {}
    for name, spec in allowed.items():
        value = params.get(name, '')
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            raise ValueError('Parameter must be text or number')
        value = str(value).strip()
        if spec['required'] and not value:
            raise ValueError('Missing required parameter: ' + name)
        if value:
            if len(value) > 2000 or '\x00' in value:
                raise ValueError('Parameter too long')
            clean[name] = value
    if 'limit' in clean:
        try:
            if not 1 <= int(clean['limit']) <= 100:
                raise ValueError('Limit must be 1-100')
        except ValueError:
            raise ValueError('Limit must be 1-100')
    elif 'limit' in allowed:
        clean['limit'] = '50'
    if 'thscodes' in clean and len(clean['thscodes'].split(',')) > 20:
        raise ValueError('Maximum 20 symbols per request')
    if not os.environ.get('HITHINK_FINANCE_API_KEY'):
        raise RuntimeError('Server API key is not configured')
    cache_key = (endpoint_id, tuple(sorted(clean.items())))
    now = time.monotonic()
    with _lock:
        hit = _cache.get(cache_key)
        if hit and now - hit[0] < 30:
            _cache.move_to_end(cache_key)
            return hit[1]
        history = _hits[client]
        while history and now - history[0] > 60:
            history.popleft()
        if len(history) >= 30:
            raise RuntimeError('Too many requests; retry in one minute')
        history.append(now)
    url = 'https://fuyao.aicubes.cn' + endpoint['path'] + ('?' + urlencode(clean) if clean else '')
    request = Request(url, headers={'X-api-key': os.environ['HITHINK_FINANCE_API_KEY']})
    if fetch is None:
        def fetch(req):
            with urlopen(req, timeout=20) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise RuntimeError('Result exceeds 2 MB; narrow the query')
                return json.loads(raw)
    result = fetch(request)
    if not isinstance(result, dict) or 'code' not in result:
        raise RuntimeError('Invalid upstream response')
    if result['code'] == 0:
        with _lock:
            _cache[cache_key] = (now, result)
            _cache.move_to_end(cache_key)
            if len(_cache) > 32:
                _cache.popitem(last=False)
    return result
