// DocDrop viewer: opens a file, picks the right engine, and runs the toolbar.
import './styles.css';
import { kindOf, extensionOf, baseName, formatBytes, timeAgo } from '../shared/formats.js';
import { addRecent, listRecent, getRecent, touchRecent, clearRecent } from '../shared/recent.js';
import { initTheme, cycleTheme, themeLabel } from '../shared/theme.js';
import { readLocal, readRemote, fileAccessAllowed, pickFile, fromDrop, saveFile } from './files.js';

const $ = (id) => document.getElementById(id);

const state = {
  kind: null,      // 'doc' | 'sheet' | 'slides'
  name: '',
  handle: null,    // FileSystemFileHandle when we can write back to the original
  dirty: false,
  editing: false,
  view: null
};

let sheetView = null;
let docView = null;
let slidesView = null;
let pdfView = null;

const EDITABLE = ['doc', 'sheet', 'pdf'];

// ---------- small UI helpers ----------

let statusTimer;
function status(text, isError = false) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('error', isError);
  clearTimeout(statusTimer);
  if (text && !isError) statusTimer = setTimeout(() => (el.textContent = ''), 6000);
}

function setDirty(on) {
  const changed = state.dirty !== on;
  state.dirty = on;
  if (!changed) return; // called on every keystroke, so do nothing unless it changed
  $('unsaved').hidden = !on;
  document.title = (on ? '* ' : '') + (state.name || 'DocDrop');
  if (state.kind) updateChrome();
}

function showOnly(hostId) {
  for (const id of ['welcome', 'docHost', 'sheetHost', 'slidesHost', 'pdfHost']) $(id).hidden = id !== hostId;
}

function updateChrome() {
  const k = state.kind;
  const editable = EDITABLE.includes(k);
  $('kind').hidden = !k;
  $('kind').textContent = k ? extensionOf(state.name).toUpperCase() : '';
  $('title').textContent = state.name || 'DocDrop';
  $('searchBox').hidden = !editable;
  $('zoomBox').hidden = !(k === 'sheet' || k === 'pdf');
  $('editBtn').hidden = !editable;
  $('editBtn').setAttribute('aria-pressed', String(state.editing));
  $('editBtn').textContent = state.editing ? 'Editing' : 'Edit';
  $('saveBtn').hidden = !editable || !(state.editing || state.dirty);
  $('saveAsBtn').hidden = !editable || !(state.editing || state.dirty);
  $('presentBtn').hidden = k !== 'slides';
  $('printBtn').hidden = !k;
  $('docToolbarWrap').hidden = !(k === 'doc' && state.editing);
  $('pdfToolbar').hidden = k !== 'pdf';
  $('formulaBar').hidden = k !== 'sheet';
  $('sheetTools').hidden = !(k === 'sheet' && state.editing);
  $('sheetTabs').hidden = k !== 'sheet';
  document.title = (state.dirty ? '* ' : '') + (state.name || 'DocDrop');
}

function welcome({ title, html, error = false, busy = false } = {}) {
  showOnly('welcome');
  const card = document.querySelector('.dropcard');
  card.classList.toggle('error', error);
  $('welcomeTitle').textContent = title || 'Drop a file to open it';
  $('welcomeText').textContent = title ? '' : "PDF, Word, Excel and PowerPoint files. Drag one here from Chrome's downloads list or any folder.";
  $('welcomeText').hidden = !!title && !html;
  $('welcomeExtra').innerHTML = busy ? '<div class="spinner" role="status" aria-label="Loading"></div>' : html || '';
  $('welcomeOpen').hidden = busy;
  $('recentBox').hidden = true;
  if (!busy && !error) renderRecent();
}

async function renderRecent() {
  const items = await listRecent();
  const list = $('recentList');
  list.innerHTML = '';
  $('recentBox').hidden = !items.length || state.kind !== null;
  for (const it of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="ext"></span><span class="name"></span><span class="meta"></span>';
    b.querySelector('.ext').textContent = extensionOf(it.name).toUpperCase();
    b.querySelector('.name').textContent = it.name;
    b.querySelector('.meta').textContent = `${formatBytes(it.size)}, ${timeAgo(it.openedAt)}`;
    b.onclick = () => openRecent(it.id);
    li.appendChild(b);
    list.appendChild(li);
  }
}

// ---------- opening ----------

function confirmDiscard() {
  return !state.dirty || confirm('You have unsaved changes. Open another file and lose them?');
}

function teardown() {
  docView?.destroy();
  sheetView?.destroy();
  slidesView?.destroy();
  pdfView?.destroy();
  state.kind = null;
  state.editing = false;
  state.handle = null;
  state.view = null;
  setDirty(false);
  $('search').value = '';
  $('searchCount').textContent = '';
}

async function getSheetView() {
  if (!sheetView) {
    const { SheetView } = await import('./sheets.js');
    sheetView = new SheetView({
      host: $('sheetHost'),
      tabsEl: $('sheetTabs'),
      refEl: $('cellRef'),
      formulaEl: $('formula'),
      onDirty: () => setDirty(true),
      onStatus: (t) => status(t)
    });
  }
  return sheetView;
}

async function getDocView() {
  if (!docView) {
    const { DocxView } = await import('./docx.js');
    docView = new DocxView({
      host: $('docHost'),
      toolbarHost: $('docToolbar'),
      onDirty: () => setDirty(true),
      onError: (e) => status(e?.message || 'Something went wrong in the document.', true)
    });
  }
  return docView;
}

async function getSlidesView() {
  if (!slidesView) {
    const { SlidesView } = await import('./slides.js');
    slidesView = new SlidesView({
      host: $('slidesHost'),
      onError: (e) => status(e?.message || 'Something went wrong in the presentation.', true)
    });
  }
  return slidesView;
}

async function getPdfView() {
  if (!pdfView) {
    const { PdfView } = await import('./pdf.js');
    pdfView = new PdfView({
      host: $('pdfHost'),
      toolbarHost: $('pdfToolbar'),
      onDirty: () => setDirty(true),
      onStatus: (t) => status(t)
    });
  }
  return pdfView;
}

async function openBuffer(buf, name, { handle = null, remember = true } = {}) {
  const kind = kindOf(name);
  if (!kind) {
    return welcome({
      title: "DocDrop can't open this type of file",
      html: '<p>It opens .pdf, .docx, .xlsx, .xls, .xlsm, .ods, .csv, .pptx, .ppt and .ppsx files.</p>',
      error: true
    });
  }

  teardown();
  state.name = name;
  updateChrome();
  welcome({ title: 'Opening ' + name, busy: true });

  try {
    if (kind === 'sheet') {
      const v = await getSheetView();
      await v.load(buf, name);
      showOnly('sheetHost');
      state.view = v;
      if (v.convertedFrom) status(`Opened a .${v.convertedFrom} file. Saving will create an .xlsx copy.`);
    } else if (kind === 'doc') {
      const v = await getDocView();
      showOnly('docHost');
      await v.load(buf, name);
      state.view = v;
    } else if (kind === 'pdf') {
      const v = await getPdfView();
      showOnly('pdfHost');
      $('pdfToolbar').hidden = false;
      await v.load(buf, name);
      state.view = v;
      $('zoomReset').textContent = Math.round(v.zoom * 100) + '%';
    } else {
      const v = await getSlidesView();
      showOnly('slidesHost');
      await v.load(buf, name);
      state.view = v;
    }
    state.kind = kind;
    state.handle = handle;
    updateChrome();
    if (remember) addRecent(name, new Blob([buf]));
    if (kind === 'sheet') $('sheetHost').querySelector('.grid-wrap')?.focus();
  } catch (err) {
    console.error(err);
    teardown();
    state.name = name;
    updateChrome();
    welcome({
      title: "This file couldn't be opened",
      html: `<p>${escapeHtml(err?.message || 'It may be damaged or password protected.')}</p>`,
      error: true
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function openFile(file, handle = null) {
  if (!file || !confirmDiscard()) return;
  await openBuffer(await file.arrayBuffer(), file.name, { handle });
}

async function openRecent(id) {
  if (!confirmDiscard()) return;
  const it = await getRecent(id);
  if (!it) return status('That file is no longer in the recent list.', true);
  touchRecent(id);
  await openBuffer(await it.blob.arrayBuffer(), it.name, { remember: false });
}

async function openFromQuery() {
  const q = new URLSearchParams(location.search);
  if (q.get('recent')) return openRecent(q.get('recent'));
  const path = q.get('path');
  const remote = q.get('url');
  if (!path && !remote) return welcome();

  const name = path ? baseName(path) : q.get('name') || 'document.pdf';
  state.name = name;
  updateChrome();
  welcome({ title: 'Opening ' + name, busy: true });

  let buf = null;
  if (path) { try { buf = await readLocal(path); } catch { /* try the web address next */ } }
  if (!buf && remote) { try { buf = await readRemote(remote); } catch { /* fall through */ } }
  if (buf) return openBuffer(buf, name);

  const allowed = await fileAccessAllowed();
  welcome({
    title: 'Drag the file here to open it',
    error: true,
    html: allowed
      ? "<p>DocDrop couldn't read the file automatically. Download it, then drag it in from Chrome's downloads list.</p>"
      : `<p>To open downloads automatically, turn on file access once:</p>
         <ol><li>Go to <code>chrome://extensions</code></li>
         <li>Click <b>Details</b> on DocDrop</li>
         <li>Turn on <b>Allow access to file URLs</b></li></ol>`
  });
}

// ---------- actions ----------

async function toggleEdit() {
  if (!state.view || !EDITABLE.includes(state.kind)) return;
  state.editing = !state.editing;
  state.view.setEditing(state.editing);
  updateChrome();
  status(state.editing ? 'Editing is on. Press Save when you are done.' : 'Editing is off.');
}

async function save(saveAs = false) {
  if (!state.view || !EDITABLE.includes(state.kind)) return;
  const name = state.kind === 'sheet' ? sheetView.outputName() : state.name;
  const produce = () =>
    state.kind === 'sheet' ? sheetView.exportBlob() : state.kind === 'pdf' ? pdfView.exportBlob() : docView.exportDocx();
  try {
    status('Saving...');
    const result = await saveFile({ name, handle: state.handle, saveAs, produce });
    if (!result) return status('Save cancelled.');
    state.handle = result.handle;
    if (result.name !== state.name) {
      state.name = result.name;
      if (sheetView && state.kind === 'sheet') { sheetView.name = result.name; sheetView.ext = extensionOf(result.name); }
    }
    setDirty(false);
    updateChrome();
    status('Saved ' + result.name);
  } catch (err) {
    console.error(err);
    status('Could not save: ' + (err?.message || 'unknown error'), true);
  }
}

function print() {
  if (state.kind === 'doc') docView.print(state.name);
  else if (state.kind === 'slides') slidesView.print();
  else if (state.kind === 'pdf') pdfView.print();
  else window.print();
}

async function runSearch(dir) {
  if (!state.view || !EDITABLE.includes(state.kind)) return;
  const q = $('search').value;
  const res = await (dir === 0 || state.lastQuery !== q ? state.view.search(q) : state.view.step(dir));
  state.lastQuery = q;
  $('searchCount').textContent = !q ? '' : res.count ? `${res.index + 1} of ${res.count}` : 'No matches';
  if (res.where) status(res.where);
}

function zoom(delta) {
  const v = state.kind === 'sheet' ? sheetView : state.kind === 'pdf' ? pdfView : null;
  if (!v) return;
  const z = delta === 0 ? (state.kind === 'pdf' ? v.fitWidth() : v.setZoom(1)) : v.setZoom(v.zoom + delta);
  $('zoomReset').textContent = Math.round(z * 100) + '%';
}

// ---------- wiring ----------

async function openPicker() {
  if (!confirmDiscard()) return;
  const picked = await pickFile($('picker'));
  if (picked) {
    await openBuffer(await picked.file.arrayBuffer(), picked.file.name, { handle: picked.handle });
  }
}

$('openBtn').onclick = openPicker;
$('welcomeOpen').onclick = openPicker;
$('editBtn').onclick = toggleEdit;
$('saveBtn').onclick = () => save(false);
$('saveAsBtn').onclick = () => save(true);
$('printBtn').onclick = print;
$('presentBtn').onclick = () => slidesView?.present();
$('zoomIn').onclick = () => zoom(0.1);
$('zoomOut').onclick = () => zoom(-0.1);
$('zoomReset').onclick = () => zoom(0);
$('searchNext').onclick = () => runSearch(1);
$('searchPrev').onclick = () => runSearch(-1);
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { $('search').value = ''; $('searchCount').textContent = ''; }
});
$('clearRecent').onclick = async () => { await clearRecent(); renderRecent(); };
$('sheetTools').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act && sheetView) sheetView[act]();
});

$('themeBtn').onclick = async () => {
  $('themeBtn').textContent = themeLabel(await cycleTheme());
};

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's' && (state.editing || state.dirty)) { e.preventDefault(); save(e.shiftKey); }
  else if (k === 'o') { e.preventDefault(); openPicker(); }
  else if (k === 'f' && EDITABLE.includes(state.kind)) { e.preventDefault(); $('search').focus(); $('search').select(); }
  else if (k === 'p' && state.kind) { e.preventDefault(); print(); }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Drag and drop anywhere on the page.
let depth = 0;
addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  depth++;
  $('dropCover').hidden = false;
});
addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('dropCover').hidden = true; } });
addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  depth = 0;
  $('dropCover').hidden = true;
  fromDrop(e).then((got) => got && openFile(got.file, got.handle));
});

// Start.
initTheme().then((t) => ($('themeBtn').textContent = themeLabel(t)));
updateChrome();
openFromQuery();
