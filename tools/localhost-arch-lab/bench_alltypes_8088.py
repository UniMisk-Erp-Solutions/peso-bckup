import os
import threading
import time
import urllib.request
import statistics
import json
import random

ANON = os.environ.get("BENCH_ANON_KEY", "")
if not ANON:
    raise SystemExit("Set BENCH_ANON_KEY (Pesowise anon JWT from .46 Coolify env)")
MODE = open("/tmp/bench_mode.txt").read().strip()
N = int(os.environ.get("BENCH_N", "10000"))
WORKERS = int(os.environ.get("BENCH_WORKERS", "40"))
BASE = os.environ.get("BENCH_BASE", "http://127.0.0.1:8088")

MIX = [
    ("rest_read", "GET", "/rest/v1/", None),
    ("rest_read", "HEAD", "/rest/v1/", None),
    ("rest_read", "OPTIONS", "/rest/v1/", None),
    ("rest_write", "POST", "/rest/v1/rpc/__bench_noop__", b"{}"),
    ("rest_write", "PATCH", "/rest/v1/__bench_fake__", b'{"x":1}'),
    ("rest_write", "DELETE", "/rest/v1/__bench_fake__?id=eq.0", None),
    ("auth_read", "GET", "/auth/v1/health", None),
    ("auth_read", "GET", "/auth/v1/settings", None),
    (
        "auth_write",
        "POST",
        "/auth/v1/token?grant_type=password",
        b'{"email":"bench@invalid.local","password":"invalid"}',
    ),
    ("storage", "GET", "/storage/v1/bucket", None),
    ("realtime", "GET", "/realtime/v1/", None),
]

lock = threading.Lock()
times, codes, errors, idx = [], {}, 0, 0
by_type = {}


def worker():
    global idx, errors
    while True:
        with lock:
            if idx >= N:
                break
            idx += 1
        kind, method, path, body = random.choice(MIX)
        url = BASE + path
        headers = {
            "apikey": ANON,
            "Authorization": "Bearer " + ANON,
            "Accept": "application/json",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        t0 = time.perf_counter()
        code = "err"
        try:
            req = urllib.request.Request(
                url, data=body, headers=headers, method=method
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                code = str(r.status)
        except urllib.error.HTTPError as e:
            code = str(e.code)
        except Exception:
            with lock:
                errors += 1
            code = "err"
        dt = time.perf_counter() - t0
        with lock:
            times.append(dt)
            codes[code] = codes.get(code, 0) + 1
            key = kind + ":" + method
            by_type[key] = by_type.get(key, 0) + 1


start = time.perf_counter()
threads = [threading.Thread(target=worker) for _ in range(WORKERS)]
for t in threads:
    t.start()
for t in threads:
    t.join()
elapsed = time.perf_counter() - start
times.sort()


def pct(p):
    if not times:
        return 0
    k = max(0, min(int(round((p / 100) * len(times))) - 1, len(times) - 1))
    return times[k]


out = {
    "mode": MODE,
    "n": N,
    "workers": WORKERS,
    "target": BASE,
    "traffic": "all_types_mixed_via_haproxy_8088",
    "elapsed_s": round(elapsed, 3),
    "rps": round(N / elapsed, 2),
    "errors": errors,
    "codes": codes,
    "by_type_method": by_type,
    "lat_avg_ms": round(statistics.mean(times) * 1000, 2) if times else 0,
    "lat_p50_ms": round(pct(50) * 1000, 2),
    "lat_p95_ms": round(pct(95) * 1000, 2),
    "lat_p99_ms": round(pct(99) * 1000, 2),
    "lat_max_ms": round(times[-1] * 1000, 2) if times else 0,
}
open("/tmp/bench_alltypes_result.json", "w").write(json.dumps(out))
print(json.dumps(out, indent=2))
