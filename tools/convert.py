#!/usr/bin/env python3
"""
convert.py — OPTIONAL helper to pre-convert heavy meshes into compact GLB.

The viewer loads models dynamically and needs no pre-processing. But very large
ASCII meshes (e.g. a 130 MB COLLADA part) load slowly in the browser. Run this to
turn them into binary GLB (typically ~3x smaller, much faster to load), then just
open the resulting .glb in the viewer like any other file.

Loads .dae/.obj/.stl/.ply/.off via trimesh, rotates COLLADA Z-up into glTF Y-up,
exports GLB, and (if tools/gltfpack exists) meshopt-compresses it.

Usage:
    python3 tools/convert.py model.dae                     # -> ./glb/model.glb
    python3 tools/convert.py /path/to/folder --out ./glb   # convert a whole folder
    python3 tools/convert.py a.dae b.stl --simplify 0.5    # decimate via gltfpack

Source files are never modified.
"""
from __future__ import annotations

import argparse
import math
import shutil
import subprocess
import sys
from pathlib import Path

import trimesh

HERE = Path(__file__).resolve().parent
GLTFPACK = HERE / "gltfpack"

CONVERTIBLE = {".dae", ".obj", ".stl", ".ply", ".off"}
Z_UP_TO_Y_UP = trimesh.transformations.rotation_matrix(-math.pi / 2.0, [1, 0, 0])


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024.0


def gather(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in inputs:
        p = Path(raw).expanduser()
        if p.is_dir():
            files += [f for f in sorted(p.rglob("*")) if f.suffix.lower() in CONVERTIBLE]
        elif p.is_file() and p.suffix.lower() in CONVERTIBLE:
            files.append(p)
        else:
            print(f"  skip (unsupported/not found): {raw}", file=sys.stderr)
    return files


def convert_one(src: Path, out_dir: Path, simplify: float | None) -> Path | None:
    print(f"  {src.name} ({human(src.stat().st_size)}) ...", flush=True)
    scene = trimesh.load(src, force="scene")
    if src.suffix.lower() == ".dae":
        scene.apply_transform(Z_UP_TO_Y_UP)  # COLLADA is Z-up; glTF is Y-up
    out = out_dir / f"{src.stem}.glb"
    out.write_bytes(scene.export(file_type="glb"))

    if GLTFPACK.exists():
        tmp = out.with_suffix(".packed.glb")
        cmd = [str(GLTFPACK), "-i", str(out), "-o", str(tmp), "-cc"]
        if simplify is not None:
            cmd += ["-si", str(simplify)]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            shutil.move(tmp, out)
        except (subprocess.CalledProcessError, OSError) as e:
            tmp.unlink(missing_ok=True)
            print(f"    (gltfpack skipped: {e})", file=sys.stderr)

    print(f"    -> {out}  ({human(out.stat().st_size)})", flush=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="mesh files or folders to convert")
    ap.add_argument("--out", default="./glb", help="output directory (default: ./glb)")
    ap.add_argument("--simplify", type=float, default=None,
                    help="gltfpack triangle ratio 0..1 (requires tools/gltfpack)")
    args = ap.parse_args()

    files = gather(args.inputs)
    if not files:
        print("Nothing to convert. Supported: " + ", ".join(sorted(CONVERTIBLE)), file=sys.stderr)
        return 1

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Converting {len(files)} file(s) -> {out_dir}")
    if not GLTFPACK.exists():
        print("  (gltfpack not found — emitting plain binary GLB; run tools/fetch_vendor.sh to add it)")

    ok = 0
    for f in files:
        try:
            convert_one(f, out_dir, args.simplify)
            ok += 1
        except Exception as e:  # noqa: BLE001 - keep going on a bad file
            print(f"  !! failed: {f.name}: {e}", file=sys.stderr)

    print(f"\nDone: {ok}/{len(files)} converted. Open the .glb files in the viewer.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
