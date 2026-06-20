#!/usr/bin/env python3
"""
serve.py — tiny static file server for the CAD viewer.

Serves this self-contained `cad-viewer/` directory (index.html, vendored libs,
and the converted models in models/). Adds correct MIME types for .wasm and
.glb. Threaded so multiple part files download in parallel.

Usage:
    python3 serve.py            # http://localhost:8000/
    python3 serve.py 9000       # custom port
"""
from __future__ import annotations

import http.server
import os
import socketserver
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent  # this cad-viewer/ directory

EXTRA_TYPES = {
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".dae": "model/vnd.collada+xml",
    ".fbx": "application/octet-stream",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        # Allow the wasm/worker bits to load without cross-origin headaches.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter logging
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", port), partial(Handler)) as httpd:
        url = f"http://localhost:{port}/"
        print(f"Serving {ROOT}")
        print(f"CAD viewer:  {url}")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
