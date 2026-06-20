#!/usr/bin/env bash
#
# fetch_vendor.sh — download all front-end dependencies for the CAD viewer so it
# runs fully offline (no CDN at runtime). Re-runnable; skips what already exists.
#
# Vendored into viewer/vendor/:
#   three/   -> three.js build + examples/jsm addons (OrbitControls, GLTFLoader,
#               DRACOLoader, ColladaLoader, FBXLoader, OBJLoader, STLLoader,
#               PLYLoader, BufferGeometryUtils) + libs/draco + libs/meshopt.
#               Pulled from the npm tarball so all relative imports stay intact.
#   occt/    -> occt-import-js (OpenCascade WASM) for in-browser STEP/IGES parsing.
# Into tools/:
#   gltfpack -> meshoptimizer CLI (best-effort) for extra GLB compression.
#
set -euo pipefail

THREE_VERSION="0.169.0"
OCCT_VERSION="0.0.23"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # cad-viewer/
VENDOR_DIR="$ROOT_DIR/vendor"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$VENDOR_DIR"

fetch_tarball() {
  # fetch_tarball <url> <dest_dir>  — download an npm tarball and extract its
  # contents (npm tarballs wrap everything in a top-level "package/" dir).
  local url="$1" dest="$2" tgz="$TMP_DIR/$(basename "$2").tgz"
  echo ">> downloading $url"
  curl -fSL --retry 3 --max-time 300 -o "$tgz" "$url"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest" --strip-components=1
}

# ---- three.js ---------------------------------------------------------------
if [ -f "$VENDOR_DIR/three/build/three.module.js" ]; then
  echo "== three.js already vendored, skipping"
else
  echo "== vendoring three.js $THREE_VERSION"
  fetch_tarball \
    "https://registry.npmjs.org/three/-/three-${THREE_VERSION}.tgz" \
    "$VENDOR_DIR/three"
fi

# ---- occt-import-js (STEP / IGES) -------------------------------------------
if [ -f "$VENDOR_DIR/occt/dist/occt-import-js.js" ]; then
  echo "== occt-import-js already vendored, skipping"
else
  echo "== vendoring occt-import-js $OCCT_VERSION"
  fetch_tarball \
    "https://registry.npmjs.org/occt-import-js/-/occt-import-js-${OCCT_VERSION}.tgz" \
    "$VENDOR_DIR/occt"
fi

# ---- gltfpack (optional, best-effort) ---------------------------------------
# The npm "gltfpack" package ships a WASM build + a tiny Node shim, but we have
# no Node. The standalone native binary lives on meshoptimizer GitHub releases.
# If this fails the converter falls back to plain (still small) binary GLB.
GLTFPACK_BIN="$ROOT_DIR/tools/gltfpack"
if [ -x "$GLTFPACK_BIN" ]; then
  echo "== gltfpack already present, skipping"
else
  echo "== attempting to fetch gltfpack (optional)"
  if curl -fSL --retry 2 --max-time 120 \
       -o "$GLTFPACK_BIN" \
       "https://github.com/zeux/meshoptimizer/releases/latest/download/gltfpack-ubuntu.zip" 2>/dev/null; then
    # The asset is a zip; try to unpack. If it's actually a raw binary, keep it.
    if file "$GLTFPACK_BIN" 2>/dev/null | grep -qi zip; then
      unzip -o "$GLTFPACK_BIN" -d "$ROOT_DIR/tools" >/dev/null 2>&1 || true
      rm -f "$GLTFPACK_BIN"
      [ -f "$ROOT_DIR/tools/gltfpack" ] && chmod +x "$ROOT_DIR/tools/gltfpack"
    else
      chmod +x "$GLTFPACK_BIN"
    fi
  fi
  if [ -x "$GLTFPACK_BIN" ]; then
    echo "   gltfpack ready: $GLTFPACK_BIN"
  else
    rm -f "$GLTFPACK_BIN"
    echo "   gltfpack unavailable — converter will emit plain binary GLB (still ~3-4x smaller than .dae)"
  fi
fi

echo
echo "Vendoring complete:"
echo "  three.js      -> $VENDOR_DIR/three/build/three.module.js"
echo "  addons        -> $VENDOR_DIR/three/examples/jsm/"
echo "  occt-import   -> $VENDOR_DIR/occt/dist/"
if [ -x "$GLTFPACK_BIN" ]; then echo "  gltfpack      -> $GLTFPACK_BIN"; fi
exit 0
