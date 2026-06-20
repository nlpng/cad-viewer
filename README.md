# CAD Viewer

A local, offline 3D model viewer built on three.js. **No build step, no hardcoded
paths** — open a folder, pick files, or drag & drop, and view them instantly.

## Features

- **Open any folder** — scans it (recursively) for supported models and lists them.
- **Open files** or **drag & drop** files *or folders* anywhere on the view.
- **Filterable model list**, click to view; tick several and **load them together**
  as one assembly.
- Per-part visibility toggles, wireframe, grid, axes, background color, fit-to-view
  (`F`), and a triangle / load-time readout.
- Runs **fully offline** — three.js and all loaders are vendored locally.

### Supported formats

`GLB` · `GLTF` · `DAE` (COLLADA) · `FBX` · `OBJ` (+`MTL`) · `STL` · `PLY` ·
`STEP`/`STP` · `IGES`/`IGS`

STEP and IGES are tessellated in-browser via OpenCascade (occt-import-js).
Multi-file formats (`.gltf`+`.bin`+textures, `.obj`+`.mtl`) resolve their
siblings automatically when you open the containing folder or drop them together.

## Setup (one time)

Vendor the front-end libraries (needs internet once):

```bash
bash tools/fetch_vendor.sh
```

## Run

```bash
python3 serve.py            # -> http://localhost:8000/
python3 serve.py 9000       # custom port
```

A small static server is used (rather than opening the file directly) because ES
modules require `http://`. Model files are read **locally in the browser** — they
are never uploaded anywhere.

## Run with Docker

The image fetches the vendored libraries during the build, so you don't need to run
`tools/fetch_vendor.sh` first (it works from a clean clone).

```bash
# Standalone container
docker build -t cad-viewer .
docker run --rm -p 8000:8000 cad-viewer

# …or with Docker Compose
docker compose up --build
```

Then open <http://localhost:8000/>. Use a different host port with
`docker run --rm -p 9000:8000 cad-viewer` or `PORT=9000 docker compose up`.

## Optional: speed up very large meshes

Big ASCII meshes (e.g. a 130 MB `.dae`) load slowly in the browser. Convert them
to compact binary GLB once, then open the `.glb`:

```bash
# deps live in the conda `dojo` env (not conda base)
conda run -n dojo python -m pip install "trimesh[easy]" pycollada numpy
conda run -n dojo python tools/convert.py /path/to/models --out ./glb
```

`tools/convert.py` accepts files or folders (`.dae/.obj/.stl/.ply/.off`), writes
GLB to `--out`, and—if `tools/gltfpack` is present (added by `fetch_vendor.sh`)—
meshopt-compresses them (`--simplify 0.5` to also decimate).

## Layout

```
cad-viewer/
├── index.html          # app shell + import map
├── serve.py            # static server (http://localhost:8000/)
├── css/style.css
├── js/
│   ├── app.js          # file pickers, drag&drop, list, toolbar, loading
│   ├── scene.js        # three.js scene / camera / controls / helpers
│   └── loaders.js      # extension -> loader dispatch (+ STEP/IGES, sibling resolution)
├── vendor/             # three.js, draco/meshopt, occt-import-js (offline)
└── tools/
    ├── fetch_vendor.sh # download vendored libs
    └── convert.py      # optional: heavy mesh -> compact GLB
```

## Notes

- `.blend` is not supported (needs Blender); export to FBX/GLB/DAE first.
- The folder picker reads file metadata up front but only loads a model's bytes
  when you click it.
- Very large models render fine on a GPU; software rendering will be slower.
