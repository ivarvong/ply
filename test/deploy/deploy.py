#!/usr/bin/env python3
"""Deploy the ply edge worker to a temporary Cloudflare account (proof-of-work provisioning, no credentials),
or to CF_ACCOUNT_ID/CF_API_TOKEN when set. Prints the worker URL and bearer token.

  python3 test/deploy/deploy.py [worker-name]
"""
import base64, hashlib, json, os, re, secrets, sys, time
from datetime import date, datetime
from pathlib import Path
import urllib.request

API = "https://api.cloudflare.com/client/v4"
HOME = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "cf-curl"
CACHE, TOKEN_FILE = HOME / "temporary.json", HOME / "ply-token"
ROOT = Path(__file__).resolve().parents[2]


def call(method, path, token=None, json_body=None, files=None, params=None):
    url = API + path + (("?" + "&".join(f"{k}={v}" for k, v in params.items())) if params else "")
    headers = {"Cloudflare-Workers-Script-Api-Date": "2025-08-01"}
    if token: headers["Authorization"] = f"Bearer {token}"
    if files:
        boundary = "----ply" + secrets.token_hex(8)
        parts = []
        for name, (filename, content, ctype) in files.items():
            head = f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"" + (f"; filename=\"{filename}\"" if filename else "") + f"\r\nContent-Type: {ctype}\r\n\r\n"
            parts.append(head.encode() + (content if isinstance(content, bytes) else content.encode()) + b"\r\n")
        data = b"".join(parts) + f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif json_body is not None:
        headers["Content-Type"] = "application/json"; data = json.dumps(json_body).encode()
    else:
        data = None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as r: d = json.loads(r.read())
    except urllib.error.HTTPError as e:
        d = json.loads(e.read() or b"{}")
    print(f"{method} {path} -> {'ok' if d.get('success') else d.get('errors')}", file=sys.stderr)
    if not d.get("success"): raise SystemExit(f"{method} {path}: {d.get('errors')}")
    return d["result"]


def temporary_account():
    if CACHE.exists():
        acct = json.loads(CACHE.read_text())
        left = min(datetime.fromisoformat(acct[k]["expiresAt"].replace("Z", "+00:00")).timestamp() for k in ("account", "claim")) - time.time()
        if left > 120: return acct
    ch = call("POST", "/provisioning/previews/challenge", json_body={})
    k, g, seed = int(ch["k"]), int(ch["g"]), base64.urlsafe_b64decode(ch["seed"] + "=" * (-len(ch["seed"]) % 4))
    if len(seed) != 32 or not (0 < k and 0 < g and k * g <= 64_000_000): raise SystemExit("refusing malformed proof-of-work challenge")
    h = hashlib.sha256(seed).digest(); checkpoints = [h]
    for _ in range(k):
        for _ in range(g): h = hashlib.sha256(h).digest()
        checkpoints.append(h)
    acct = call("POST", "/provisioning/previews", json_body={
        "termsOfService": "https://www.cloudflare.com/terms/", "privacyPolicy": "https://www.cloudflare.com/privacypolicy/",
        "acceptTermsOfService": "yes", "challengeToken": ch["challengeToken"],
        "solution": {"checkpoints": base64.b64encode(b"".join(checkpoints)).decode()}})
    HOME.mkdir(parents=True, exist_ok=True); CACHE.write_text(json.dumps(acct)); CACHE.chmod(0o600)
    TOKEN_FILE.unlink(missing_ok=True)
    return acct


def bundle():
    """Flat module set: src/*.js with bare specifiers, plus the worker."""
    mods = {}
    for f in sorted((ROOT / "src").glob("*.js")):
        mods[f.name] = re.sub(r"from '\./([\w.]+)'", r"from '\1'", f.read_text())
    mods["worker.mjs"] = (ROOT / "test/deploy/worker.mjs").read_text()
    return mods


def main(name="ply"):
    job = os.environ.get("PLY_JOB")  # JSON for the scheduled run
    if os.environ.get("CF_API_TOKEN"):
        acct, account, token = None, os.environ["CF_ACCOUNT_ID"], os.environ["CF_API_TOKEN"]
    else:
        acct = temporary_account(); account, token = acct["account"]["id"], acct["account"]["apiToken"]
    if not TOKEN_FILE.exists():
        HOME.mkdir(parents=True, exist_ok=True); TOKEN_FILE.write_text(secrets.token_urlsafe(24)); TOKEN_FILE.chmod(0o600)
    bearer = TOKEN_FILE.read_text().strip()
    base = f"/accounts/{account}/workers/scripts/{name}"
    # KV namespace for cron results (idempotent: reuse by title)
    ns = next((n for n in call("GET", f"/accounts/{account}/storage/kv/namespaces", token) if n["title"] == f"{name}-results"), None) \
         or call("POST", f"/accounts/{account}/storage/kv/namespaces", token, json_body={"title": f"{name}-results"})
    metadata = {"main_module": "worker.mjs", "compatibility_date": date.today().isoformat(), "compatibility_flags": ["nodejs_compat"],
                "bindings": [{"type": "secret_text", "name": "TOKEN", "text": bearer}, {"type": "kv_namespace", "name": "RESULTS", "namespace_id": ns["id"]}]
                            + ([{"type": "secret_text", "name": "JOB", "text": job}] if job else []),
                "observability": {"enabled": True}}
    files = {"metadata": (None, json.dumps(metadata), "application/json")}
    for fname, src in bundle().items(): files[fname] = (fname, src, "application/javascript+module")
    call("PUT", base, token, files=files, params={"excludeScript": "true"})
    call("POST", f"{base}/subdomain", token, json_body={"enabled": True, "previews_enabled": False})
    sub = call("GET", f"/accounts/{account}/workers/subdomain", token)["subdomain"]
    if job:
        call("PUT", f"{base}/schedules", token, json_body=[{"cron": "* * * * *"}])
    url = f"https://{name}.{sub}.workers.dev"
    print(json.dumps({"url": url, "token": bearer, "account": account, "api_token": token, "kv": ns["id"], "claim": acct["claim"]["url"] if acct else None, "expires": acct["claim"]["expiresAt"] if acct else None}))


if __name__ == "__main__":
    main(*sys.argv[1:2])
