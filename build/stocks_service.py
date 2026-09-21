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
        return {"items": [_cache[c][1] for c in codes if c in _cache], "cached_seconds": TTL}
