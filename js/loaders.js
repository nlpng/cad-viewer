// loaders.js — turn a user-picked File (or set of sibling Files) into a
// THREE.Object3D, dispatching on file extension.
//
// GLB/GLTF .... GLTFLoader (Draco + meshopt decoders registered)
// DAE ......... ColladaLoader (handles its own up-axis)
// FBX ......... FBXLoader
// OBJ ......... OBJLoader (+ MTL if a sibling .mtl is present)
// STL / PLY ... geometry loaders, wrapped in a default-material mesh
// STEP / IGES . occt-import-js (OpenCascade WASM) -> BufferGeometry meshes
//
// Multi-file formats (.gltf+.bin+textures, .obj+.mtl) resolve siblings through a
// LoadingManager URL modifier that matches requested resources by file name
// against the Files the user provided from the same folder / drop.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const VENDOR = './vendor';

export const SUPPORTED = [
  'glb', 'gltf', 'dae', 'fbx', 'obj', 'stl', 'ply', 'stp', 'step', 'igs', 'iges',
];

export function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function isSupported(name) {
  return SUPPORTED.includes(extOf(name));
}

const Z_UP_TO_Y_UP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const DEFAULT_MATERIAL = () =>
  new THREE.MeshStandardMaterial({ color: 0xb6bcc4, metalness: 0.15, roughness: 0.7 });

const draco = new DRACOLoader().setDecoderPath(`${VENDOR}/three/examples/jsm/libs/draco/gltf/`);

function configureGLTF(loader) {
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

const baseName = (p) => p.split(/[\\/]/).pop();

// LoadingManager that serves sibling resources from provided Files as blob URLs,
// matched by basename. `urls` collects created object URLs for later revocation.
function siblingManager(fileMap, urls) {
  const manager = new THREE.LoadingManager();
  const byName = new Map();
  if (fileMap) for (const [path, file] of fileMap) byName.set(baseName(path).toLowerCase(), file);

  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const file = byName.get(baseName(url.split('?')[0]).toLowerCase());
    if (!file) return url;
    const obj = URL.createObjectURL(file);
    urls.push(obj);
    return obj;
  });
  return manager;
}

// Load a File into a THREE.Object3D.
//   file       : the File to load
//   fileMap    : optional Map<relativePath, File> of siblings (multi-file formats)
//   onProgress : optional (fraction 0..1 | null) callback
export async function loadFile(file, fileMap = null, onProgress = null) {
  const ext = extOf(file.name);
  const urls = [];
  try {
    if (ext === 'stp' || ext === 'step' || ext === 'igs' || ext === 'iges') {
      return await loadOcct(new Uint8Array(await file.arrayBuffer()), ext);
    }

    const manager = siblingManager(fileMap, urls);
    const mainURL = URL.createObjectURL(file);
    urls.push(mainURL);
    const prog = onProgress
      ? (e) => onProgress(e.lengthComputable ? e.loaded / e.total : null)
      : undefined;

    switch (ext) {
      case 'glb':
      case 'gltf':
        return (await configureGLTF(new GLTFLoader(manager)).loadAsync(mainURL, prog)).scene;
      case 'dae':
        return (await new ColladaLoader(manager).loadAsync(mainURL, prog)).scene;
      case 'fbx':
        return await new FBXLoader(manager).loadAsync(mainURL, prog);
      case 'obj': {
        const objLoader = new OBJLoader(manager);
        const mtl = findSibling(fileMap, file.name, 'mtl');
        if (mtl) {
          const mtlURL = URL.createObjectURL(mtl);
          urls.push(mtlURL);
          const mats = await new MTLLoader(manager).loadAsync(mtlURL);
          mats.preload();
          objLoader.setMaterials(mats);
        }
        return await objLoader.loadAsync(mainURL, prog);
      }
      case 'stl':
        return meshFromGeometry(await new STLLoader(manager).loadAsync(mainURL, prog));
      case 'ply': {
        const geo = await new PLYLoader(manager).loadAsync(mainURL, prog);
        geo.computeVertexNormals();
        return meshFromGeometry(geo);
      }
      default:
        throw new Error(`Unsupported format: .${ext}`);
    }
  } finally {
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}

function findSibling(fileMap, name, wantExt) {
  if (!fileMap) return null;
  const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
  for (const [path, file] of fileMap) {
    const bn = baseName(path).toLowerCase();
    if (extOf(bn) === wantExt && bn.replace(/\.[^.]+$/, '') === stem) return file;
  }
  for (const [path, file] of fileMap) if (extOf(path) === wantExt) return file;
  return null;
}

function meshFromGeometry(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return new THREE.Mesh(geo, DEFAULT_MATERIAL());
}

// ---- STEP / IGES via occt-import-js (OpenCascade WASM) ----------------------
// Parsing runs in the vendored classic worker so it never blocks the main
// thread. The worker accepts { format, buffer, params } and posts back the same
// { success, meshes } object the synchronous API returns. Its own locateFile
// resolves the .wasm relative to the worker URL (vendor/occt/dist/).
const OCCT_WORKER = `${VENDOR}/occt/dist/occt-import-js-worker.js`;
let occtWorker = null;
let occtChain = Promise.resolve(); // serialize requests over the single worker

function getOcctWorker() {
  if (!occtWorker) occtWorker = new Worker(OCCT_WORKER);
  return occtWorker;
}

// Parse `bytes` (Uint8Array) in the worker. Serialized so concurrent callers
// don't clash over the single worker's message channel. The buffer is
// transferred to avoid a copy (the caller does not reuse it afterwards).
function parseOcct(bytes, format) {
  const run = () => new Promise((resolve, reject) => {
    const worker = getOcctWorker();
    const onMessage = (ev) => { cleanup(); resolve(ev.data); };
    const onError = (err) => {
      cleanup();
      // A worker error can leave it in a bad state — drop it so the next load
      // starts a fresh worker.
      occtWorker = null;
      reject(new Error(`occt-import-js worker failed: ${err.message || err}`));
    };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ format, buffer: bytes, params: null }, [bytes.buffer]);
  });
  // Chain so failures don't break the queue for subsequent loads.
  const result = occtChain.then(run, run);
  occtChain = result.catch(() => {});
  return result;
}

async function loadOcct(bytes, ext) {
  const format = ext === 'stp' || ext === 'step' ? 'step' : 'iges';
  const result = await parseOcct(bytes, format);
  if (!result || !result.success) throw new Error('OpenCascade failed to read the file');

  const group = new THREE.Group();
  for (const m of result.meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal)
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    if (m.index) geo.setIndex(m.index.array);
    if (!m.attributes.normal) geo.computeVertexNormals();
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0xb6bcc4);
    group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.65 })));
  }
  group.applyMatrix4(Z_UP_TO_Y_UP);
  return group;
}
