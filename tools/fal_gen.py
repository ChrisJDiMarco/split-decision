#!/usr/bin/env python3
"""Tiny fal.ai queue client for concept art. Reads FAL key from Cabinet's Keychain vault.

usage: fal_gen.py <jobs.json> <out_dir>
jobs.json: [{"name": "bruiser", "model": "fal-ai/nano-banana-2", "input": {...}}]
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import concurrent.futures as cf

QUEUE = "https://queue.fal.run"
POLL_SECONDS = 2.0
TIMEOUT_SECONDS = 300


def fal_key() -> str:
    return subprocess.run(
        ["security", "find-generic-password", "-s", "com.chrisdimarco.cabinet.api-keys", "-a", "fal", "-w"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def call(method: str, url: str, key: str, body=None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Key {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def download(url: str, path: str, attempts: int = 4) -> None:
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
            return
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2 * (attempt + 1))


def run(job: dict, key: str, out_dir: str) -> str:
    model = job["model"]
    sub = call("POST", f"{QUEUE}/{model}", key, job["input"])
    status_url = sub.get("status_url") or f"{QUEUE}/{model}/requests/{sub['request_id']}/status"
    result_url = sub.get("response_url") or f"{QUEUE}/{model}/requests/{sub['request_id']}"
    start = time.time()
    while True:
        st = call("GET", status_url, key)
        if st.get("status") == "COMPLETED":
            break
        if time.time() - start > TIMEOUT_SECONDS:
            return f"{job['name']}: TIMEOUT"
        time.sleep(POLL_SECONDS)
    res = call("GET", result_url, key)
    images = res.get("images") or ([res["image"]] if res.get("image") else [])
    saved = []
    for i, img in enumerate(images):
        url = img["url"]
        ext = ".png" if "png" in (img.get("content_type") or url) else ".jpg"
        path = os.path.join(out_dir, f"{job['name']}{'' if i == 0 else f'-{i}'}{ext}")
        download(url, path)
        saved.append(path)
    return f"{job['name']}: {', '.join(saved) or 'NO IMAGE ' + json.dumps(res)[:300]}"


def main() -> None:
    jobs = json.load(open(sys.argv[1]))
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    key = fal_key()
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(run, j, key, out_dir) for j in jobs]
        for f in cf.as_completed(futures):
            try:
                print(f.result(), flush=True)
            except Exception as e:  # report per-job failure, keep the rest
                print(f"FAILED: {e}", flush=True)


if __name__ == "__main__":
    main()
