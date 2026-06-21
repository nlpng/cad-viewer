// app.js — wires the DOM to the scene: folder/file pickers, drag & drop (files
// and folders), a filterable model list, multi-select assembly loading, the
// floating toolbar, stats, and loading/empty/error states. No hardcoded paths.
import { createViewer } from './scene.js';
import { loadFile, isSupported, extOf } from './loaders.js';

const $ = (id) => document.getElementById(id);

let viewer;
try {
  viewer = createViewer($('canvas'), $('viewport'));
} catch (err) {
  console.error(err);
  const card = document.querySelector('.empty-card');
  if (card) {
    card.innerHTML =
      '<h2>3D view unavailable</h2>' +
      '<p>This browser could not start WebGL. Try enabling hardware ' +
      'acceleration or using a different browser.</p>';
  }
  $('empty').hidden = false;
  throw err; // stop wiring up an unusable viewer
}

// Extensions parsed off-thread with no progress events (occt-import-js).
const OCCT_EXTS = new Set(['stp', 'step', 'igs', 'iges']);
// Drops larger than this (or any folder drop) populate the list instead of
// auto-assembling everything into one model.
const ASSEMBLE_DROP_MAX = 8;

// ---- state ----
const allFiles = new Map();      // path -> File (everything, for sibling resolution)
let models = [];                 // [{ path, file, ext, size }] supported only
const selected = new Set();      // selected paths (checkboxes)
let activePath = null;
let filter = '';
let loadSeq = 0;

// ---- file ingestion ---------------------------------------------------------
function ingest(items) {
  // items: [{ path, file }]
  let added = 0;
  for (const { path, file } of items) {
    if (allFiles.has(path)) continue;
    allFiles.set(path, file);
    if (isSupported(file.name)) {
      models.push({ path, file, ext: extOf(file.name), size: file.size });
      added++;
    }
  }
  models.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  renderList();
  return added;
}

function fromInput(input) {
  return [...input.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
}

// Drag & drop, including dropped folders (recursed via webkitGetAsEntry).
// Returns { items, hadDirectory } — hadDirectory is true if any dropped root was
// a folder, so the caller can list-only instead of auto-assembling everything.
async function fromDataTransfer(dt) {
  const roots = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!roots.length) {
    return { items: [...dt.files].map((f) => ({ path: f.name, file: f })), hadDirectory: false };
  }
  const hadDirectory = roots.some((e) => e.isDirectory);
  const out = [];
  await Promise.all(roots.map((e) => walkEntry(e, '', out)));
  return { items: out, hadDirectory };
}
function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => { out.push({ path: prefix + entry.name, file: f }); resolve(); }, resolve);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const read = () => reader.readEntries(async (ents) => {
        if (!ents.length) return resolve();
        await Promise.all(ents.map((e) => walkEntry(e, `${prefix}${entry.name}/`, out)));
        read();
      }, resolve);
      read();
    } else resolve();
  });
}

// ---- list rendering ---------------------------------------------------------
function renderList() {
  const ul = $('file-list');
  const q = filter.trim().toLowerCase();
  const shown = q ? models.filter((m) => m.path.toLowerCase().includes(q)) : models;

  $('file-count').textContent = models.length
    ? `${models.length} model${models.length > 1 ? 's' : ''}${q ? ` · ${shown.length} shown` : ''}`
    : 'No models loaded';
  $('clear-list').hidden = models.length === 0;

  ul.innerHTML = '';
  if (!models.length) {
    ul.innerHTML = '<li class="empty-list">Open a folder or drop files to begin.</li>';
    return;
  }
  if (!shown.length) {
    ul.innerHTML = '<li class="empty-list">No models match your filter.</li>';
    return;
  }

  for (const m of shown) {
    const li = document.createElement('li');

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'cb'; cb.checked = selected.has(m.path);
    cb.setAttribute('aria-label', `Select ${baseName(m.path)}`);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(m.path);
      else selected.delete(m.path);
      updateSelectionBar();
    });

    // The whole row is a button so it is keyboard-focusable and Enter/Space-activatable.
    const row = document.createElement('button');
    row.type = 'button';
    row.className = m.path === activePath ? 'row active' : 'row';

    const badge = document.createElement('span');
    badge.className = 'badge'; badge.textContent = m.ext.toUpperCase();

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = baseName(m.path); name.title = m.path;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${dirName(m.path)}${dirName(m.path) ? ' · ' : ''}${human(m.size)}`;
    info.append(name, meta);

    row.append(badge, info);
    row.addEventListener('click', () => loadList([m]));
    li.append(cb, row);
    ul.appendChild(li);
  }
}

function updateSelectionBar() {
  const bar = $('selection-bar');
  bar.hidden = selected.size < 1;
  $('selected-count').textContent = `${selected.size} selected`;
}

// ---- loading ----------------------------------------------------------------
async function loadList(list) {
  if (!list.length) return;
  const seq = ++loadSeq;
  showOverlay(true);
  viewer.clear();
  activePath = list.length === 1 ? list[0].path : null;
  renderList();

  const t0 = performance.now();
  try {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      setOverlay(`${baseName(m.path)}${list.length > 1 ? `  (${i + 1}/${list.length})` : ''}`, 0);
      // STEP/IGES parse off-thread with no progress events — show a moving
      // indeterminate bar instead of a stalled 0%.
      const indeterminate = OCCT_EXTS.has(m.ext);
      setOverlayIndeterminate(indeterminate);
      const obj = await loadFile(m.file, allFiles, (frac) => {
        if (frac != null) setOverlay(null, frac);
      });
      setOverlayIndeterminate(false);
      if (seq !== loadSeq) return; // superseded
      viewer.add(obj, baseName(m.path));
    }
    viewer.fitView();
    buildParts();
    showStats({
      name: list.length === 1 ? baseName(list[0].path) : 'Assembly',
      parts: viewer.parts().length,
      tris: viewer.triangleCount(),
      ms: Math.round(performance.now() - t0),
    });
    $('empty').hidden = true;
    $('toolbar').hidden = false;
    $('stats').hidden = false;
  } catch (err) {
    console.error(err);
    toast(`Could not load: ${err.message || err}`);
    if (!viewer.parts().length) { $('empty').hidden = false; $('stats').hidden = true; }
  } finally {
    if (seq === loadSeq) showOverlay(false);
  }
}

// ---- parts panel ------------------------------------------------------------
function getParts() {
  const top = viewer.parts();
  if (top.length === 1) {
    const kids = top[0].children.filter(hasMesh);
    if (kids.length > 1) return kids;
  }
  return top;
}
function hasMesh(o) { let f = false; o.traverse((n) => { if (n.isMesh) f = true; }); return f; }

function buildParts() {
  const parts = getParts();
  const panel = $('parts-panel');
  const ul = $('parts-list');
  ul.innerHTML = '';
  if (parts.length <= 1) { panel.hidden = true; return; }
  panel.hidden = false;
  parts.forEach((part, i) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = part.visible;
    cb.addEventListener('change', () => { part.visible = cb.checked; viewer.invalidate(); });
    const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = partColor(part);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = part.userData.partName || part.name || `part ${i + 1}`;
    nm.title = nm.textContent;
    li.append(cb, sw, nm);
    ul.appendChild(li);
  });
}
function partColor(part) {
  let css = '#b6bcc4';
  part.traverse((o) => {
    if (o.isMesh && o.material) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.color) css = `#${m.color.getHexString()}`;
    }
  });
  return css;
}

// ---- overlay / stats / toast ------------------------------------------------
function showOverlay(v) {
  $('overlay').hidden = !v;
  if (v) setOverlay('Loading…', 0);
  else setOverlayIndeterminate(false);
}
function setOverlay(name, frac) {
  if (name != null) $('overlay-name').textContent = name;
  if (frac != null) {
    $('overlay-bar').style.width = `${Math.round(frac * 100)}%`;
    $('overlay-pct').textContent = frac > 0 ? `${Math.round(frac * 100)}%` : '';
  }
}
// Toggle a continuously-animated bar for loaders that report no progress (occt).
function setOverlayIndeterminate(on) {
  const bar = document.querySelector('.progress');
  if (!bar) return;
  bar.classList.toggle('indeterminate', on);
  if (on) {
    $('overlay-bar').style.width = '';
    $('overlay-pct').textContent = '';
  }
}
function showStats({ name, parts, tris, ms }) {
  $('stats').innerHTML =
    `<b>${escapeHtml(name)}</b><span class="dot"></span>${parts} part${parts > 1 ? 's' : ''}` +
    `<span class="dot"></span>${tris.toLocaleString()} tris` +
    `<span class="dot"></span>${ms} ms`;
}
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => (el.hidden = true), 250); }, 4200);
}

// ---- helpers ----------------------------------------------------------------
const baseName = (p) => p.split('/').pop();
const dirName = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
function human(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- wiring -----------------------------------------------------------------
$('btn-open-folder').addEventListener('click', () => $('folder-input').click());
$('empty-open-folder').addEventListener('click', () => $('folder-input').click());
$('btn-open-files').addEventListener('click', () => $('file-input').click());
$('empty-open-files').addEventListener('click', () => $('file-input').click());

$('folder-input').addEventListener('change', (e) => {
  const added = ingest(fromInput(e.target));
  if (!added) toast('No supported model files found in that folder.');
  e.target.value = '';
});
$('file-input').addEventListener('change', (e) => {
  const items = fromInput(e.target);
  const added = ingest(items);
  e.target.value = '';
  // if exactly one model was opened, load it immediately
  const loadable = items.filter((i) => isSupported(i.file.name));
  if (loadable.length === 1) loadList([models.find((m) => m.path === loadable[0].path)].filter(Boolean));
  else if (!added) toast('No supported model files selected.');
});

$('search').addEventListener('input', (e) => { filter = e.target.value; renderList(); });
$('clear-list').addEventListener('click', () => {
  models = []; allFiles.clear(); selected.clear(); activePath = null;
  renderList(); updateSelectionBar();
});
$('load-selected').addEventListener('click', () => {
  const list = models.filter((m) => selected.has(m.path));
  if (list.length) loadList(list);
});

// drag & drop over the whole viewport
const vp = $('viewport');
let dragDepth = 0;
vp.addEventListener('dragenter', (e) => { e.preventDefault(); if (dragDepth++ === 0) $('drop-veil').hidden = false; });
vp.addEventListener('dragover', (e) => { e.preventDefault(); });
vp.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop-veil').hidden = true; } });
vp.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('drop-veil').hidden = true;
  const { items, hadDirectory } = await fromDataTransfer(e.dataTransfer);
  const before = models.length;
  ingest(items); // merges the dropped items into `models`
  const dropped = items.filter((i) => isSupported(i.file.name));
  if (!dropped.length) { toast('No supported model files dropped.'); return; }

  // A dropped folder (or a large batch) populates the list rather than fusing
  // everything into one surprise assembly. A small drop of loose files still
  // loads immediately (drag-one-to-view, .obj+.mtl, a few parts).
  if (hadDirectory || dropped.length > ASSEMBLE_DROP_MAX) {
    if (models.length === before) toast('Those files are already loaded.');
    else toast(`Added ${dropped.length} models — click one to view, or tick several and Load together.`);
    return;
  }

  // load: single dropped file -> view it; multiple -> assemble them
  const toLoad = dropped
    .map((d) => models.find((m) => m.path === d.path || m.path === d.file.name))
    .filter(Boolean);
  if (toLoad.length) loadList(toLoad);
  else if (models.length === before) toast('Those files are already loaded.');
});

// toolbar
function tbToggle(btn, fn) {
  btn.addEventListener('click', () => {
    const on = btn.classList.toggle('is-on');
    btn.setAttribute('aria-pressed', String(on));
    fn(on);
  });
}
$('tb-fit').addEventListener('click', () => viewer.fitView());
tbToggle($('tb-wire'), (on) => viewer.setWireframe(on));
tbToggle($('tb-grid'), (on) => viewer.setGrid(on));
tbToggle($('tb-axes'), (on) => viewer.setAxes(on));
$('tb-bg').addEventListener('input', (e) => viewer.setBackground(e.target.value));

// keyboard: F = fit
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' && !/input|textarea/i.test(e.target.tagName)) viewer.fitView();
});

renderList();
