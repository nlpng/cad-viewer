// scene.js — the three.js scene: renderer, camera, controls, lights, helpers,
// and a small imperative API the app calls to add/clear/frame models.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createViewer(canvas, viewportEl) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err) {
    // No WebGL context (unsupported / disabled / blocked) — surface a clear error
    // so the caller can show a message instead of a silently blank canvas.
    throw new Error('WebGL is not available in this browser', { cause: err });
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
  camera.position.set(6, 4, 8);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f3a, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(5, 10, 7.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd2ff, 0.7);
  fill.position.set(-6, 4, -6);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(0, -6, -2);
  scene.add(rim);

  // helpers
  const grid = new THREE.GridHelper(40, 40, 0x3a4250, 0x232a33);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  scene.add(grid);
  const axes = new THREE.AxesHelper(2);
  scene.add(axes);

  const root = new THREE.Group();
  scene.add(root);

  let wireframe = false;

  function clear() {
    for (const child of [...root.children]) {
      root.remove(child);
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          // material.dispose() does NOT free attached textures — dispose them too.
          for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
          m.dispose();
        });
      });
    }
    requestRender();
  }

  function add(object3d, name) {
    object3d.name = name || object3d.name || 'model';
    object3d.userData.partName = name || object3d.name;
    applyWireframeTo(object3d);
    root.add(object3d);
    requestRender();
    return object3d;
  }

  function applyWireframeTo(obj) {
    obj.traverse((o) => {
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m && 'wireframe' in m) m.wireframe = wireframe; });
      }
    });
  }

  function triangleCount() {
    let tris = 0;
    root.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
      }
    });
    return Math.round(tris);
  }

  function fitView() {
    root.updateMatrixWorld(true); // ensure world transforms are current before measuring
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.6;

    const dir = new THREE.Vector3(0.85, 0.55, 1).normalize();
    camera.position.copy(center).add(dir.multiplyScalar(dist));
    camera.near = Math.max(dist / 1000, 0.001);
    camera.far = dist * 1000;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();

    grid.position.set(center.x, box.min.y, center.z);
    const g = Math.max(maxDim * 2, 1);
    grid.scale.setScalar(g / 40);
    axes.scale.setScalar(maxDim * 0.4);
    requestRender();
  }

  // public API consumed by app.js
  const api = {
    clear,
    add,
    fitView,
    triangleCount,
    parts: () => root.children,
    invalidate: requestRender, // request a redraw after an external scene mutation
    setWireframe(v) { wireframe = v; applyWireframeTo(root); requestRender(); },
    setGrid(v) { grid.visible = v; requestRender(); },
    setAxes(v) { axes.visible = v; requestRender(); },
    setBackground(hex) { scene.background = new THREE.Color(hex); requestRender(); },
  };

  // ---- on-demand rendering ----
  // Render only when the view actually changes (model loaded, a toggle, orbiting,
  // resize) instead of every frame. OrbitControls.update() returns true while the
  // camera is still settling (damping), so we keep scheduling frames until it stops.
  let renderPending = false;
  function frame() {
    renderPending = false;
    const moving = controls.update();
    renderer.render(scene, camera);
    if (moving) requestRender();
  }
  function requestRender() {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(frame);
    }
  }
  controls.addEventListener('start', requestRender);
  controls.addEventListener('change', requestRender);

  function resize() {
    const w = viewportEl.clientWidth || 1;
    const h = viewportEl.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(viewportEl);
  resize();

  requestRender(); // initial draw

  return api;
}
