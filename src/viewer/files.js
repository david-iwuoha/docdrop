// Reading files into DocDrop and saving them back out.
import { PICKER_TYPES } from '../shared/formats.js';

// "C:\Users\me\Downloads\a b.docx" or "/Users/me/a.docx" -> file:/// URL
export function toFileUrl(path) {
  const parts = path.replace(/\\/g, '/').split('/');
  const encoded = parts.map((p, i) => (i === 0 && /^[a-zA-Z]:$/.test(p) ? p : encodeURIComponent(p)));
  const joined = encoded.join('/');
  return 'file://' + (joined.startsWith('/') ? '' : '/') + joined;
}

// Needs "Allow access to file URLs" switched on for DocDrop.
export function readLocal(path) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', toFileUrl(path));
    xhr.responseType = 'arraybuffer';
    xhr.onload = () =>
      xhr.response && xhr.response.byteLength ? resolve(xhr.response) : reject(new Error('empty'));
    xhr.onerror = () => reject(new Error('blocked'));
    xhr.send();
  });
}

export async function readRemote(url) {
  if (/^file:/i.test(url || '')) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => (xhr.response && xhr.response.byteLength ? resolve(xhr.response) : reject(new Error('empty')));
      xhr.onerror = () => reject(new Error('blocked'));
      xhr.send();
    });
  }
  if (!/^https?:/i.test(url || '')) throw new Error('no url');
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.arrayBuffer();
}

export function fileAccessAllowed() {
  return new Promise((resolve) =>
    chrome.extension?.isAllowedFileSchemeAccess
      ? chrome.extension.isAllowedFileSchemeAccess(resolve)
      : resolve(true)
  );
}

// Returns { file, handle } or null if the person cancelled.
export async function pickFile(fallbackInput) {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, excludeAcceptAllOption: false });
      return { file: await handle.getFile(), handle };
    } catch (e) {
      if (e.name === 'AbortError') return null;
    }
  }
  return new Promise((resolve) => {
    fallbackInput.value = '';
    fallbackInput.onchange = () => resolve(fallbackInput.files[0] ? { file: fallbackInput.files[0], handle: null } : null);
    fallbackInput.click();
  });
}

// From a drop event. Must be called synchronously inside the drop handler.
export function fromDrop(event) {
  const item = [...(event.dataTransfer.items || [])].find((i) => i.kind === 'file');
  const file = event.dataTransfer.files[0];
  if (!file) return Promise.resolve(null);
  const handlePromise = item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
  return handlePromise.then((handle) => ({ file, handle: handle && handle.kind === 'file' ? handle : null }));
}

function typeFor(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase();
  const map = {
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel workbook'],
    csv: ['text/csv', 'CSV file']
  };
  const [mime, description] = map[ext] || ['application/octet-stream', 'File'];
  return [{ description, accept: { [mime]: ['.' + ext] } }];
}

async function writeTo(handle, blob) {
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

/**
 * Save a file. `produce` is an async function returning a Blob; it is called only
 * after permission or a location has been granted, so the browser keeps the click.
 * Returns { handle, name } on success, or null if cancelled.
 */
export async function saveFile({ name, handle, saveAs, produce }) {
  // 1. Overwrite the file we opened, if we have permission.
  if (handle && !saveAs && handle.name === name) {
    let perm = await handle.queryPermission?.({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await handle.requestPermission?.({ mode: 'readwrite' });
    if (perm === 'granted') {
      await writeTo(handle, await produce());
      return { handle, name: handle.name };
    }
  }

  // 2. Ask where to save.
  if (window.showSaveFilePicker) {
    let target;
    try {
      target = await window.showSaveFilePicker({ suggestedName: name, types: typeFor(name), startIn: handle || 'downloads' });
    } catch (e) {
      if (e.name === 'AbortError') return null;
      target = null;
    }
    if (target) {
      await writeTo(target, await produce());
      return { handle: target, name: target.name };
    }
  }

  // 3. Last resort: a normal download with a Save As window.
  const blob = await produce();
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: name, saveAs: true, conflictAction: 'uniquify' });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { handle: null, name };
}
