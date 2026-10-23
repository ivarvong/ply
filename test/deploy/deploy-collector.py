#!/usr/bin/env python3
"""Deploy the OTLP collector worker (from the user's collector.py, verbatim) to the same temporary account."""
import json, os, secrets, sys
from datetime import date
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from deploy import call, temporary_account, HOME
def main(name="otel"):
    acct = temporary_account(); account, token = acct["account"]["id"], acct["account"]["apiToken"]
    tf = HOME / "collector-token"
    if not tf.exists(): tf.write_text(secrets.token_urlsafe(24)); tf.chmod(0o600)
    ctoken = tf.read_text().strip()
    base = f"/accounts/{account}/workers/scripts/{name}"
    exists = False
    try: call("GET", f"/accounts/{account}/workers/scripts/{name}/settings", token); exists = True
    except SystemExit: pass
    metadata = {"main_module": "collector.js", "compatibility_date": date.today().isoformat(),
                "bindings": [{"type": "durable_object_namespace", "name": "STORE", "class_name": "Store"}, {"type": "secret_text", "name": "TOKEN", "text": ctoken}],
                "observability": {"enabled": True, "traces": {"enabled": True, "head_sampling_rate": 1}},
                **({} if exists else {"migrations": {"new_tag": "v1", "new_sqlite_classes": ["Store"]}})}
    call("PUT", base, token, files={"metadata": (None, json.dumps(metadata), "application/json"), "collector.js": ("collector.js", (Path(__file__).parent / "collector.js").read_text(), "application/javascript+module")}, params={"excludeScript": "true"})
    call("POST", f"{base}/subdomain", token, json_body={"enabled": True, "previews_enabled": False})
    sub = call("GET", f"/accounts/{account}/workers/subdomain", token)["subdomain"]
    print(json.dumps({"url": f"https://{name}.{sub}.workers.dev", "token": ctoken, "account": account}))
if __name__ == "__main__": main(*sys.argv[1:2])
