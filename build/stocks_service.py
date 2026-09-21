"""Small, server-side Fuyao snapshot adapter. The API key never reaches HTML."""
import json
import os
import re
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CODE = re.compile(r"^[0-9]{6}\.(?:SH|SZ|BJ)$")
_cache = {}
_lock = threading.Lock()
TTL = 30
_NAMES = {}
_names_loaded = False


def _names(key, fetch=None):
    """A 股中文名字典，进程内只取一次。

    ponytail: 一次 1.2MB 换整本字典（比逐只搜索省 N 次往返，且新加自选不用再请求）；
    若某天 A 股数量超过 10000 只，多出来的会显示「—」，届时改成分页即可。
    """
    global _names_loaded
    if _names_loaded:
        return _NAMES
    url = "https://fuyao.aicubes.cn/api/meta/tickers/list?" + urlencode({"asset_type": "a-share", "limit": 10000})
    request = Request(url, headers={"X-api-key": key})
    try:
        if fetch is None:
            def fetch(req):
                with urlopen(req, timeout=20) as response:
                    return json.load(response)
        result = fetch(request)
        for row in (result.get("data") or {}).get("item") or []:
            if row.get("thscode") and row.get("name"):
                _NAMES[row["thscode"]] = row["name"]
        _names_loaded = bool(_NAMES)
    except Exception:
        pass  # 拿不到名字不该把行情一起弄挂，前端显示「—」
    return _NAMES

_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".hithink_key")


def _api_key():
    """Prefer the platform environment; fall back to a local deployment secret."""
    value = os.environ.get("HITHINK_FINANCE_API_KEY")
    if value:
        return value.strip()
    try:
        with open(_KEY_FILE, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def snapshot(codes, fetch=None):
    if not codes or len(codes) > 10 or len(set(codes)) != len(codes) or any(not CODE.fullmatch(c) for c in codes):
        raise ValueError("Use 1-10 unique full A-share codes")
    key = _api_key()
    if not key:
        raise RuntimeError("HITHINK_FINANCE_API_KEY is not configured on the server")
    now = time.monotonic()
    with _lock:
        missing = [c for c in codes if c not in _cache or now - _cache[c][0] >= TTL]
        if missing:
            url = "https://fuyao.aicubes.cn/api/a-share/prices/snapshot?" + urlencode({"thscodes": ",".join(missing)})
            request = Request(url, headers={"X-api-key": key})
            if fetch is None:
                def fetch(req):
                    with urlopen(req, timeout=12) as response:
                        return json.load(response)
            result = fetch(request)
            if result.get("code") != 0 or not isinstance(result.get("data", {}).get("item"), list):
                raise RuntimeError("Upstream snapshot unavailable")
            stamp = result["data"].get("timestamp")
            for item in result["data"]["item"]:
                code = item.get("thscode")
                if code in missing:
                    _cache[code] = (now, {"thscode": code, "last_price": item.get("last_price"),
                                          "price_change": item.get("price_change"),
                                          "price_change_ratio_pct": item.get("price_change_ratio_pct"),
                                          "volume": item.get("volume"), "turnover": item.get("turnover"),
                                          "timestamp": stamp})
    names = _names(key, fetch)
    return {"items": [dict(_cache[c][1], name=names.get(c, "")) for c in codes if c in _cache],
            "cached_seconds": TTL}
