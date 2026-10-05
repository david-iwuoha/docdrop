// PDF viewing and editing.
// Viewing: PDF.js (Mozilla). Pages are drawn only when on screen, at full screen sharpness.
// Editing: edits live as light HTML on top of the page while you work, so typing is instant.
// Saving: pdf-lib writes edits as real PDF text and shapes (never pictures of pages), and
// MuPDF (Artifex) properly removes old words when you change existing text.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const CSS_UNITS = 96 / 72;
const MAX_RENDERED = 16;
const FONTS = {
  sans: { label: 'Sans', css: 'Helvetica, Arial, sans-serif', base: 0.946 },
  serif: { label: 'Serif', css: '"Times New Roman", Times, serif', base: 0.938 },
  mono: { label: 'Mono', css: '"Courier New", Courier, monospace', base: 0.866 }
};
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const TOOLS = [
  ['select', 'Select', 'Select, move and resize things you added'],
  ['edit', 'Edit text', 'Click any existing text to change it'],
  ['text', 'Add text', 'Click anywhere on the page to type'],
  ['highlight', 'Highlight', 'Drag over an area to highlight it'],
  ['draw', 'Draw', 'Draw freehand'],
  ['box', 'Box', 'Drag to draw a box'],
  ['whiteout', 'White-out', 'Drag to cover something'],
  ['image', 'Image', 'Add a picture'],
  ['sign', 'Sign', 'Draw your signature']
];

let uid = 0;
const newId = (p = 'o') => p + (++uid).toString(36) + Math.random().toString(36).slice(2, 6);
const dirOf = (a) => ({ x: Math.cos(a), y: Math.sin(a) });
const downOf = (a) => ({ x: Math.sin(a), y: -Math.cos(a) });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexToRgb01(hex) {
  const h = (hex || '#000000').replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function guessFont(item, page) {
  let name = '';
  try { name = page.commonObjs.get(item.fontName)?.name || ''; } catch { /* font not loaded yet */ }
  const fam = `${item.family || ''} ${name}`.toLowerCase();
  const font = /courier|mono/.test(fam) ? 'mono' : /times|serif|roman|georgia|garamond|cambria/.test(fam) && !/sans/.test(fam) ? 'serif' : 'sans';
  return { font, bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name) };
}

export class PdfView {
  constructor({ host, toolbarHost, onDirty, onStatus }) {
    this.host = host;
    this.toolbarHost = toolbarHost;
    this.onDirty = onDirty;
    this.onStatus = onStatus;
    this.reset();
    this.onKey = (e) => this.handleKey(e);
    document.addEventListener('keydown', this.onKey);
  }

  reset() {
    this.sources = [];
    this.pages = [];
    this.cache = new Map();
    this.pageEls = new Map();
    this.objects = new Map();
    this.images = new Map();
    this.formValues = new Map();
    this.formMeta = new Map();
    this.formChanged = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.hits = [];
    this.hitIndex = -1;
    this.selected = null;
    this.editing = false;
    this.tool = 'select';
    this.style = { color: '#000000', size: 12, font: 'sans', bold: false };
    this.zoom = 1;
    this.showPages = false;
    this.password = null;
  }

  // ---------------------------------------------------------------- loading

  async load(buf, name) {
    this.destroy();
    this.name = name;
    const bytes = new Uint8Array(buf.slice(0));
    const doc = await this.openPdf(bytes);
    this.sources = [{ bytes, doc, name }];
    this.pages = Array.from({ length: doc.numPages }, (_, i) => ({ id: newId('p'), src: 0, index: i, rot: 0 }));
    this.buildShell();
    this.buildToolbar();
    await Promise.all(this.pages.map((p) => this.pdfPage(p)));
    this.zoom = this.fitZoom();
    this.layoutPages();
    this.renderThumbs();
  }

  openPdf(bytes) {
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      cMapUrl: chrome.runtime.getURL('pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('pdfjs/standard_fonts/'),
      wasmUrl: chrome.runtime.getURL('pdfjs/wasm/')
    });
    task.onPassword = (update, reason) => {
      const wrong = reason === pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD;
      const pw = prompt(wrong ? 'Wrong password. Please try again:' : 'This PDF is protected. Enter its password:');
      if (pw == null) task.destroy();
      else { this.password = pw; update(pw); }
    };
    return task.promise.catch((e) => {
      if (e?.name === 'PasswordException' || /password/i.test(e?.message || '')) throw new Error('This PDF needs a password to open.');
      throw e;
    });
  }

  async pdfPage(p) {
    const key = p.src + ':' + p.index;
    let c = this.cache.get(key);
    if (!c) {
      c = { page: await this.sources[p.src].doc.getPage(p.index + 1) };
      this.cache.set(key, c);
    }
    return c;
  }

  pageById(id) { return this.pages.find((p) => p.id === id); }
  cached(p) { return this.cache.get(p.src + ':' + p.index); }
  rotationOf(p, c) { return (((c.page.rotate + p.rot) % 360) + 360) % 360; }
  viewport(p, c, scale = this.zoom * CSS_UNITS) { return c.page.getViewport({ scale, rotation: this.rotationOf(p, c) }); }

  // ---------------------------------------------------------------- layout

  buildShell() {
    this.host.innerHTML = `
      <div class="pdf-wrap">
        <aside class="pdf-pages" hidden>
          <div class="pdf-thumbs"></div>
          <button type="button" class="pdf-add">Add pages from another PDF</button>
        </aside>
        <div class="pdf-scroll" tabindex="-1"><div class="pdf-column"></div></div>
      </div>
      <input type="file" class="pdf-file-pdf" accept="application/pdf,.pdf" hidden>
      <input type="file" class="pdf-file-img" accept="image/png,image/jpeg" hidden>`;
    this.aside = this.host.querySelector('.pdf-pages');
    this.thumbsEl = this.host.querySelector('.pdf-thumbs');
    this.scroll = this.host.querySelector('.pdf-scroll');
    this.column = this.host.querySelector('.pdf-column');
    this.pdfInput = this.host.querySelector('.pdf-file-pdf');
    this.imgInput = this.host.querySelector('.pdf-file-img');

    this.host.querySelector('.pdf-add').onclick = () => this.pdfInput.click();
    this.pdfInput.onchange = () => { const f = this.pdfInput.files[0]; this.pdfInput.value = ''; if (f) this.addPdf(f); };
    this.imgInput.onchange = () => { const f = this.imgInput.files[0]; this.imgInput.value = ''; if (f) this.addImageFile(f); };

    this.column.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.column.addEventListener('pointermove', (e) => this.onHover(e));
    this.column.addEventListener('input', (e) => this.onInput(e));
    this.column.addEventListener('change', (e) => this.onFieldChange(e));
    this.column.addEventListener('focusin', (e) => this.onFocusIn(e));
    this.column.addEventListener('focusout', (e) => this.onFocusOut(e));
  }

  fitZoom() {
    const first = this.pages[0];
    if (!first) return 1;
    const vp = this.viewport(first, this.cached(first), CSS_UNITS);
    const avail = (this.scroll?.clientWidth || this.host.clientWidth || 900) - 48;
    return clamp(avail / vp.width, 0.25, 4);
  }

  layoutPages() {
    const sc = this.scroll;
    const ratio = sc.scrollHeight ? (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight : 0;
    this.observer?.disconnect();
    for (const pe of this.pageEls.values()) pe.task?.cancel();
    this.pageEls.clear();
    this.column.innerHTML = '';

    this.observer = new IntersectionObserver((entries) => this.onVisibility(entries), { root: sc, rootMargin: '900px 0px' });
    for (const p of this.pages) {
      const c = this.cached(p);
      const vp = this.viewport(p, c);
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.id = p.id;
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      const layer = document.createElement('div');
      layer.className = 'pdf-layer';
      el.appendChild(layer);
      this.column.appendChild(el);
      this.pageEls.set(p.id, { el, layer, vp, rendered: false, visible: false });
      this.observer.observe(el);
    }
    this.column.classList.toggle('editing', this.editing);
    this.column.dataset.tool = this.tool;
    if (ratio) sc.scrollTop = ratio * sc.scrollHeight - sc.clientHeight / 2;
  }

  onVisibility(entries) {
    for (const en of entries) {
      const pe = this.pageEls.get(en.target.dataset.id);
      if (!pe) continue;
      pe.visible = en.isIntersecting;
      if (en.isIntersecting) this.renderPage(en.target.dataset.id);
      else if (pe.rendering) { pe.task?.cancel(); pe.rendering = false; }
    }
    this.trimRendered();
  }

  trimRendered() {
    const rendered = [...this.pageEls.entries()].filter(([, pe]) => pe.rendered && !pe.visible);
    const total = [...this.pageEls.values()].filter((pe) => pe.rendered).length;
    let extra = total - MAX_RENDERED;
    for (const [id, pe] of rendered) {
      if (extra-- <= 0) break;
      if (pe.layer.contains(document.activeElement)) continue;
      pe.canvas?.remove();
      pe.canvas = null;
      pe.rendered = false;
      pe.layer.innerHTML = '';
      this.pageEls.set(id, pe);
    }
  }

  async renderPage(id) {
    const pe = this.pageEls.get(id);
    if (!pe || pe.rendered || pe.rendering) return;
    const p = this.pageById(id);
    if (!p) return;
    pe.rendering = true;
    const c = await this.pdfPage(p);
    const vp = pe.vp;
    let out = window.devicePixelRatio || 1;
    const maxPixels = 16e6;
    if (vp.width * vp.height * out * out > maxPixels) out = Math.sqrt(maxPixels / (vp.width * vp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * out);
    canvas.height = Math.floor(vp.height * out);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    const task = c.page.render({
      canvasContext: ctx,
      canvas,
      viewport: vp,
      transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS
    });
    pe.task = task;
    try {
      await task.promise;
    } catch (e) {
      pe.rendering = false;
      if (e?.name !== 'RenderingCancelledException') console.warn('DocDrop: page render failed', e);
      return;
    }
    if (this.pageEls.get(id) !== pe) return;
    pe.canvas?.remove();
    pe.el.insertBefore(canvas, pe.layer);
    pe.canvas = canvas;
    pe.out = out;
    pe.rendered = true;
    pe.rendering = false;
    await Promise.all([this.ensureText(p, c), this.ensureForms(p, c)]);
    if (this.pageEls.get(id) === pe) this.drawLayer(id);
  }

  // ---------------------------------------------------------------- page text and forms

  async ensureText(p, c) {
    if (c.text) return c.text;
    const tc = await c.page.getTextContent();
    c.text = tc.items
      .filter((it) => it.str && it.str.trim() && it.width > 0)
      .map((it) => {
        const [a, b, cc, d, e, f] = it.transform;
        const st = tc.styles[it.fontName] || {};
        if (st.vertical) return null;
        const angle = Math.atan2(b, a);
        const size = Math.hypot(cc, d) || Math.hypot(a, b) || 10;
        const asc = st.ascent || 0.8;
        const desc = st.descent ? Math.abs(st.descent) : 0.2;
        const dn = downOf(angle);
        return {
          str: it.str, angle, size, fontName: it.fontName, family: st.fontFamily,
          origin: { x: e, y: f },
          x: e - dn.x * asc * size, y: f - dn.y * asc * size,
          w: it.width, h: (asc + desc) * size
        };
      })
      .filter(Boolean);
    return c.text;
  }

  async ensureForms(p, c) {
    if (c.fields) return c.fields;
    let annots = [];
    try { annots = await c.page.getAnnotations({ intent: 'display' }); } catch { /* none */ }
    c.fields = annots.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.pushButton && ['Tx', 'Btn', 'Ch'].includes(a.fieldType));
    for (const a of c.fields) {
      const name = a.fieldName;
      if (!this.formMeta.has(name)) this.formMeta.set(name, { src: p.src, type: a.fieldType, radio: a.radioButton, check: a.checkBox, options: a.options });
      if (this.formValues.has(name)) continue;
      let v;
      if (a.fieldType === 'Tx') v = a.fieldValue ?? '';
      else if (a.checkBox) v = !!a.fieldValue && a.fieldValue !== 'Off';
      else if (a.radioButton) v = a.fieldValue && a.fieldValue !== 'Off' ? a.fieldValue : '';
      else if (a.fieldType === 'Ch') v = Array.isArray(a.fieldValue) ? a.fieldValue[0] || '' : a.fieldValue || '';
      this.formValues.set(name, v);
    }
    return c.fields;
  }

  // ---------------------------------------------------------------- drawing the edit layer

  screenFrame(o, vp) {
    const s = vp.convertToViewportPoint(o.x, o.y);
    const d = dirOf(o.angle);
    const s2 = vp.convertToViewportPoint(o.x + d.x, o.y + d.y);
    return { left: s[0], top: s[1], theta: Math.atan2(s2[1] - s[1], s2[0] - s[0]), k: vp.scale };
  }

  place(el, o, vp, sized = true) {
    const f = this.screenFrame(o, vp);
    el.style.left = f.left + 'px';
    el.style.top = f.top + 'px';
    el.style.transform = `rotate(${f.theta}rad)`;
    if (sized) {
      el.style.width = o.w * f.k + 'px';
      el.style.height = o.h * f.k + 'px';
    }
    return f;
  }

  drawLayer(id) {
    const pe = this.pageEls.get(id);
    const p = this.pageById(id);
    if (!pe || !p || !pe.rendered) return;
    const c = this.cached(p);
    const vp = pe.vp;
    const layer = pe.layer;
    const frag = document.createDocumentFragment();

    // Search matches
    this.hits.forEach((h, i) => {
      if (h.pageId !== id) return;
      const it = c.text[h.ti];
      const d = dirOf(it.angle);
      const frac = h.start / it.str.length;
      const box = { x: it.x + d.x * it.w * frac, y: it.y + d.y * it.w * frac, w: (it.w * h.len) / it.str.length, h: it.h, angle: it.angle };
      const el = document.createElement('div');
      el.className = 'pdf-hit' + (i === this.hitIndex ? ' current' : '');
      this.place(el, box, vp);
      frag.appendChild(el);
    });

    // Form fields (from the original PDF only)
    if (p.src === 0) for (const a of c.fields || []) frag.appendChild(this.fieldEl(a, vp));

    // Ink strokes share one SVG
    const inks = [...this.objects.values()].filter((o) => o.pageId === id && o.type === 'ink');
    if (inks.length) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'pdf-ink');
      svg.setAttribute('width', vp.width);
      svg.setAttribute('height', vp.height);
      for (const o of inks) svg.appendChild(this.inkEl(o, vp));
      frag.appendChild(svg);
    }

    for (const o of this.objects.values()) {
      if (o.pageId !== id || o.type === 'ink') continue;
      if (o.type === 'replace') frag.appendChild(this.maskEl(o, vp));
      frag.appendChild(this.objEl(o, vp));
    }

    layer.innerHTML = '';
    layer.appendChild(frag);
  }

  redrawAll() {
    for (const id of this.pageEls.keys()) this.drawLayer(id);
  }

  objEl(o, vp) {
    const el = document.createElement('div');
    el.dataset.obj = o.id;
    el.className = `pdf-obj pdf-${o.type}` + (this.selected === o.id ? ' sel' : '');
    const isText = o.type === 'text' || o.type === 'replace';
    const f = this.place(el, o, vp, !isText);
    if (isText) {
      const F = FONTS[o.font] || FONTS.sans;
      el.style.fontFamily = F.css;
      el.style.fontSize = o.size * f.k + 'px';
      el.style.fontWeight = o.bold ? '700' : '400';
      el.style.fontStyle = o.italic ? 'italic' : 'normal';
      el.style.color = o.color;
      el.textContent = o.text;
      el.contentEditable = this.editing ? 'plaintext-only' : 'false';
      el.spellcheck = false;
      if (this.editing) {
        const grip = document.createElement('span');
        grip.className = 'pdf-grip';
        grip.contentEditable = 'false';
        grip.title = 'Drag to move';
        el.appendChild(grip);
      }
    } else if (o.type === 'highlight') {
      el.style.background = o.color;
    } else if (o.type === 'box') {
      el.style.border = `${Math.max(1, o.stroke * f.k)}px solid ${o.color}`;
    } else if (o.type === 'image') {
      const img = document.createElement('img');
      img.src = this.images.get(o.imageId)?.dataUrl || '';
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
    }
    if (this.editing && ['highlight', 'box', 'whiteout', 'image'].includes(o.type)) {
      const h = document.createElement('span');
      h.className = 'pdf-handle';
      el.appendChild(h);
    }
    return el;
  }

  maskEl(o, vp) {
    const el = document.createElement('div');
    el.className = 'pdf-mask';
    el.dataset.mask = o.id;
    this.place(el, o.redact, vp);
    el.style.background = o.mask || '#ffffff';
    return el;
  }

  inkEl(o, vp) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    path.setAttribute('points', o.points.map((pt) => vp.convertToViewportPoint(pt.x, pt.y).join(',')).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', o.color);
    path.setAttribute('stroke-width', Math.max(1, o.stroke * vp.scale));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.dataset.obj = o.id;
    if (this.selected === o.id) path.classList.add('sel');
    return path;
  }

  fieldEl(a, vp) {
    const r = vp.convertToViewportRectangle(a.rect);
    const left = Math.min(r[0], r[2]), top = Math.min(r[1], r[3]);
    const w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
    const name = a.fieldName;
    const v = this.formValues.get(name);
    let el;
    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input');
      if (!a.multiLine) el.type = a.password ? 'password' : 'text';
      el.value = v ?? '';
      if (a.maxLen) el.maxLength = a.maxLen;
      el.style.fontSize = Math.max(8, Math.min(h * 0.68, (a.multiLine ? 12 : 99) * vp.scale)) + 'px';
    } else if (a.checkBox || a.radioButton) {
      el = document.createElement('input');
      el.type = a.radioButton ? 'radio' : 'checkbox';
      if (a.radioButton) { el.name = 'dd-' + name; el.value = a.buttonValue; el.checked = v === a.buttonValue; }
      else el.checked = !!v;
    } else {
      el = document.createElement('select');
      if (!a.combo) el.size = Math.max(2, Math.floor(h / (14 * vp.scale)));
      for (const opt of a.options || []) {
        const o = document.createElement('option');
        o.value = opt.exportValue;
        o.textContent = opt.displayValue;
        el.appendChild(o);
      }
      el.value = v ?? '';
    }
    el.className = 'pdf-field';
    el.dataset.field = name;
    el.disabled = !!a.readOnly;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.title = a.alternativeText || name;
    return el;
  }

  objElById(id) {
    return this.column.querySelector(`[data-obj="${CSS.escape(id)}"]`);
  }

  refreshObj(o) {
    const pe = this.pageEls.get(o.pageId);
    if (!pe?.rendered) return;
    if (o.type === 'ink') return this.drawLayer(o.pageId);
    const el = this.objElById(o.id);
    if (!el) return this.drawLayer(o.pageId);
    const isText = o.type === 'text' || o.type === 'replace';
    const f = this.place(el, o, pe.vp, !isText);
    if (isText) {
      el.style.fontFamily = (FONTS[o.font] || FONTS.sans).css;
      el.style.fontSize = o.size * f.k + 'px';
      el.style.fontWeight = o.bold ? '700' : '400';
      el.style.color = o.color;
    } else if (o.type === 'highlight') el.style.background = o.color;
    else if (o.type === 'box') el.style.border = `${Math.max(1, o.stroke * f.k)}px solid ${o.color}`;
  }

  // ---------------------------------------------------------------- toolbar

  buildToolbar() {
    const tools = TOOLS.map(([id, label, tip]) =>
      `<button type="button" class="pdf-tool" data-tool="${id}" title="${tip}" aria-pressed="false">${label}</button>`).join('');
    const sizes = SIZES.map((s) => `<option value="${s}">${s}</option>`).join('');
    const fonts = Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
    this.toolbarHost.innerHTML = `
      <div class="pdf-bar">
        <div class="pdf-group">
          <button type="button" data-act="pages" aria-pressed="false" title="Show pages to reorder, rotate, delete or add">Pages</button>
          <button type="button" data-act="fit" title="Fit the page to the window width">Fit width</button>
        </div>
        <div class="pdf-group pdf-edit-only">${tools}</div>
        <div class="pdf-group pdf-edit-only">
          <label class="pdf-color" title="Colour"><input type="color" data-style="color" value="#000000"></label>
          <select data-style="size" title="Size">${sizes}</select>
          <select data-style="font" title="Font">${fonts}</select>
          <button type="button" data-style="bold" aria-pressed="false" title="Bold"><b>B</b></button>
        </div>
        <div class="pdf-group pdf-edit-only">
          <button type="button" data-act="undo" title="Undo (Ctrl+Z)">Undo</button>
          <button type="button" data-act="redo" title="Redo (Ctrl+Y)">Redo</button>
          <button type="button" data-act="delete" title="Delete the selected item (Delete key)">Delete</button>
        </div>
        <span class="pdf-hint pdf-view-only">Click <b>Edit</b> to change this PDF. You can fill in forms any time.</span>
      </div>`;
    this.toolbarHost.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) this.setTool(b.dataset.tool);
      else if (b.dataset.act === 'pages') this.togglePages();
      else if (b.dataset.act === 'fit') this.fitWidth();
      else if (b.dataset.act === 'undo') this.undo();
      else if (b.dataset.act === 'redo') this.redo();
      else if (b.dataset.act === 'delete') this.deleteSelected();
      else if (b.dataset.style === 'bold') this.applyStyle({ bold: !this.style.bold });
    };
    this.toolbarHost.oninput = (e) => {
      const k = e.target.dataset.style;
      if (k === 'color') this.applyStyle({ color: e.target.value });
    };
    this.toolbarHost.onchange = (e) => {
      const k = e.target.dataset.style;
      if (k === 'size') this.applyStyle({ size: Number(e.target.value) });
      if (k === 'font') this.applyStyle({ font: e.target.value });
    };
    this.syncToolbar();
  }

  syncToolbar() {
    const bar = this.toolbarHost;
    bar.classList.toggle('pdf-editing', this.editing);
    bar.querySelectorAll('.pdf-tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool)));
    bar.querySelector('[data-act="pages"]')?.setAttribute('aria-pressed', String(this.showPages));
    const s = this.style;
    const color = bar.querySelector('[data-style="color"]');
    if (color) color.value = s.color;
    const size = bar.querySelector('[data-style="size"]');
    if (size) size.value = String(SIZES.includes(s.size) ? s.size : 12);
    const font = bar.querySelector('[data-style="font"]');
    if (font) font.value = s.font;
    bar.querySelector('[data-style="bold"]')?.setAttribute('aria-pressed', String(!!s.bold));
    const del = bar.querySelector('[data-act="delete"]');
    if (del) del.disabled = !this.selected;
    const undo = bar.querySelector('[data-act="undo"]');
    if (undo) undo.disabled = !this.undoStack.length;
    const redo = bar.querySelector('[data-act="redo"]');
    if (redo) redo.disabled = !this.redoStack.length;
  }

  setTool(tool) {
    if (!this.editing) return;
    if (tool === 'image') { this.imgInput.click(); return; }
    if (tool === 'sign') { this.openSignaturePad(); return; }
    this.tool = tool;
    if (tool === 'highlight' && this.style.color === '#000000') this.style.color = '#ffe14d';
    if (tool !== 'highlight' && this.style.color === '#ffe14d') this.style.color = '#000000';
    this.column.dataset.tool = tool;
    this.hoverEl?.remove();
    this.syncToolbar();
    const tips = { edit: 'Click any text in the PDF to change it.', text: 'Click where you want to type.', highlight: 'Drag over what you want to highlight.', draw: 'Hold and drag to draw.', box: 'Drag to draw a box.', whiteout: 'Drag over anything you want to cover.' };
    if (tips[tool]) this.onStatus(tips[tool]);
  }

  applyStyle(change) {
    Object.assign(this.style, change);
    const o = this.selected && this.objects.get(this.selected);
    if (o) {
      this.pushUndo();
      if ('color' in change) o.color = change.color;
      if (o.type === 'text' || o.type === 'replace') {
        if ('size' in change) o.size = change.size;
        if ('font' in change) o.font = change.font;
        if ('bold' in change) o.bold = change.bold;
      } else if ((o.type === 'box' || o.type === 'ink') && 'size' in change) {
        o.stroke = Math.max(0.5, change.size / 6);
      }
      this.refreshObj(o);
      this.changed();
    }
    this.syncToolbar();
  }

  // ---------------------------------------------------------------- editing mode

  setEditing(on) {
    this.editing = on;
    this.tool = 'select';
    this.selected = null;
    this.column.classList.toggle('editing', on);
    this.column.dataset.tool = 'select';
    this.hoverEl?.remove();
    this.syncToolbar();
    this.redrawAll();
  }

  changed() {
    this.onDirty();
    this.syncToolbar();
  }

  select(id) {
    if (this.selected === id) return;
    const prev = this.selected && this.objects.get(this.selected);
    this.selected = id;
    if (prev) this.refreshSelection(prev.id);
    if (id) {
      this.refreshSelection(id);
      const o = this.objects.get(id);
      if (o) {
        const s = { color: o.color };
        if (o.size) s.size = o.size;
        if (o.font) s.font = o.font;
        s.bold = !!o.bold;
        Object.assign(this.style, s);
      }
    }
    this.syncToolbar();
  }

  refreshSelection(id) {
    const o = this.objects.get(id);
    if (!o) return;
    if (o.type === 'ink') return this.drawLayer(o.pageId);
    this.objElById(id)?.classList.toggle('sel', this.selected === id);
  }

  addObject(o, { focus = false } = {}) {
    this.objects.set(o.id, o);
    this.drawLayer(o.pageId);
    this.select(o.id);
    this.changed();
    if (focus) {
      const el = this.objElById(o.id);
      if (el) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el.firstChild?.nodeType === 3 ? el.firstChild : el);
        if (o.type === 'text') range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  deleteSelected() {
    const o = this.selected && this.objects.get(this.selected);
    if (!o) return;
    this.pushUndo();
    this.objects.delete(o.id);
    this.selected = null;
    this.drawLayer(o.pageId);
    this.changed();
  }

  // ---------------------------------------------------------------- undo

  snapshot() {
    return JSON.stringify({ objects: [...this.objects.values()], pages: this.pages });
  }

  restore(json) {
    const s = JSON.parse(json);
    const pagesChanged = JSON.stringify(s.pages) !== JSON.stringify(this.pages);
    this.objects = new Map(s.objects.map((o) => [o.id, o]));
    this.pages = s.pages;
    this.selected = null;
    if (pagesChanged) { this.layoutPages(); this.renderThumbs(); }
    else this.redrawAll();
    this.changed();
  }

  pushUndo(snap = this.snapshot()) {
    this.undoStack.push(snap);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.syncToolbar();
  }

  undo() {
    if (!this.undoStack.length) return this.onStatus('Nothing to undo.');
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return this.onStatus('Nothing to redo.');
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }

  // ---------------------------------------------------------------- pointer handling

  pageAt(e) {
    const el = e.target.closest('.pdf-page');
    if (!el) return null;
    const pe = this.pageEls.get(el.dataset.id);
    if (!pe) return null;
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id, pe, sx: e.clientX - r.left, sy: e.clientY - r.top, rect: r };
  }

  toUser(pe, sx, sy) {
    const [x, y] = pe.vp.convertToPdfPoint(sx, sy);
    return { x, y };
  }

  screenAngle(pe, sx, sy) {
    const a = this.toUser(pe, sx, sy), b = this.toUser(pe, sx + 10, sy);
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  onPointerDown(e) {
    if (e.button !== 0 || !this.editing) return;
    if (e.target.closest('.pdf-field')) return;
    const at = this.pageAt(e);
    if (!at) return;
    const objNode = e.target.closest('[data-obj]');
    const o = objNode && this.objects.get(objNode.dataset.obj);

    if (o && this.tool !== 'draw') {
      this.select(o.id);
      const isText = o.type === 'text' || o.type === 'replace';
      if (isText && !e.target.closest('.pdf-grip')) return; // let the caret go where they clicked
      e.preventDefault();
      return this.startDrag(e, at, o, e.target.closest('.pdf-handle') ? 'resize' : 'move');
    }

    if (document.activeElement?.isContentEditable) document.activeElement.blur();
    this.select(null);

    if (this.tool === 'text') { e.preventDefault(); return this.createText(at); }
    if (this.tool === 'edit') { e.preventDefault(); return this.editExistingText(at); }
    if (['highlight', 'box', 'whiteout'].includes(this.tool)) { e.preventDefault(); return this.startShape(e, at); }
    if (this.tool === 'draw') { e.preventDefault(); return this.startInk(e, at); }
  }

  track(e, onMove, onUp) {
    const target = e.target;
    try { target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  startDrag(e, at, o, mode) {
    const before = this.snapshot();
    const start = { x: e.clientX, y: e.clientY };
    const orig = JSON.parse(JSON.stringify(o));
    const pe = at.pe;
    const f = o.type === 'ink' ? null : this.screenFrame(orig, pe.vp);
    const ratio = o.type === 'image' ? orig.h / orig.w : null;
    let moved = false;
    let frame = 0;
    this.track(e, (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      if (mode === 'move') {
        if (o.type === 'ink') {
          const a = this.toUser(pe, 0, 0), b = this.toUser(pe, dx, dy);
          o.points = orig.points.map((p) => ({ x: p.x + b.x - a.x, y: p.y + b.y - a.y }));
        } else {
          const u = this.toUser(pe, f.left + dx, f.top + dy);
          o.x = u.x; o.y = u.y;
        }
      } else {
        const along = dx * Math.cos(f.theta) + dy * Math.sin(f.theta);
        const across = -dx * Math.sin(f.theta) + dy * Math.cos(f.theta);
        o.w = Math.max(4, orig.w + along / f.k);
        o.h = ratio ? o.w * ratio : Math.max(4, orig.h + across / f.k);
      }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.refreshObj(o); });
    }, () => {
      if (frame) cancelAnimationFrame(frame);
      this.refreshObj(o);
      if (moved) { this.pushUndo(before); this.changed(); }
    });
  }

  createText(at) {
    const size = this.style.size;
    const k = at.pe.vp.scale;
    const angle = this.screenAngle(at.pe, at.sx, at.sy);
    const u = this.toUser(at.pe, at.sx - 2, at.sy - size * k * 0.6);
    this.pushUndo();
    this.addObject({
      id: newId(), type: 'text', pageId: at.id, x: u.x, y: u.y, angle, w: 10, h: size * 1.2,
      text: '', size, font: this.style.font, bold: this.style.bold, italic: false, color: this.style.color
    }, { focus: true });
  }

  async editExistingText(at) {
    const p = this.pageById(at.id);
    const c = this.cached(p);
    const items = await this.ensureText(p, c);
    const u = this.toUser(at.pe, at.sx, at.sy);
    const hitIdx = this.textItemAt(items, u);
    if (hitIdx < 0) return this.onStatus('No text there. Try clicking directly on a word, or use Add text.');
    const existing = [...this.objects.values()].find((o) => o.type === 'replace' && o.pageId === at.id && o.item === hitIdx);
    if (existing) { this.select(existing.id); this.objElById(existing.id)?.focus(); return; }
    const it = items[hitIdx];
    const g = guessFont(it, c.page);
    const base = FONTS[g.font].base;
    const dn = downOf(it.angle);
    this.pushUndo();
    this.addObject({
      id: newId(), type: 'replace', pageId: at.id, item: hitIdx,
      x: it.origin.x - dn.x * base * it.size, y: it.origin.y - dn.y * base * it.size,
      angle: it.angle, w: it.w, h: it.size * 1.2,
      text: it.str, size: Math.round(it.size * 10) / 10, font: g.font, bold: g.bold, italic: g.italic, color: '#000000',
      redact: { x: it.x, y: it.y, w: it.w, h: it.h, angle: it.angle },
      mask: this.sampleBackground(at.pe, it)
    }, { focus: true });
    this.onStatus('Type to change the text. Click outside when you are done.');
  }

  textItemAt(items, u) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const d = dirOf(it.angle), dn = downOf(it.angle);
      const vx = u.x - it.x, vy = u.y - it.y;
      const along = vx * d.x + vy * d.y;
      const down = vx * dn.x + vy * dn.y;
      if (along >= -1 && along <= it.w + 1 && down >= -1 && down <= it.h + 1) return i;
    }
    return -1;
  }

  sampleBackground(pe, it) {
    try {
      const f = this.screenFrame(it, pe.vp);
      const ctx = pe.canvas.getContext('2d');
      const px = ctx.getImageData(Math.max(0, Math.round((f.left + 1) * pe.out)), Math.max(0, Math.round((f.top + 1) * pe.out)), 1, 1).data;
      return `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
    } catch {
      return '#ffffff';
    }
  }

  startShape(e, at) {
    const pe = at.pe;
    const type = this.tool;
    const angle = this.screenAngle(pe, at.sx, at.sy);
    const before = this.snapshot();
    const o = {
      id: newId(), type, pageId: at.id, angle, x: 0, y: 0, w: 0, h: 0,
      color: type === 'whiteout' ? '#ffffff' : this.style.color, stroke: Math.max(0.5, this.style.size / 6)
    };
    const x0 = at.sx, y0 = at.sy;
    const update = (sx, sy) => {
      const k = pe.vp.scale;
      const u = this.toUser(pe, Math.min(x0, sx), Math.min(y0, sy));
      o.x = u.x; o.y = u.y;
      o.w = Math.abs(sx - x0) / k;
      o.h = Math.abs(sy - y0) / k;
    };
    update(x0, y0);
    this.objects.set(o.id, o);
    this.drawLayer(at.id);
    let frame = 0;
    this.track(e, (ev) => {
      update(ev.clientX - at.rect.left, ev.clientY - at.rect.top);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.refreshObj(o); });
    }, () => {
      if (frame) cancelAnimationFrame(frame);
      if (o.w * pe.vp.scale < 4 || o.h * pe.vp.scale < 4) {
        this.objects.delete(o.id);
        this.drawLayer(at.id);
        return;
      }
      this.pushUndo(before);
      this.select(o.id);
      this.drawLayer(at.id);
      this.changed();
    });
  }

  startInk(e, at) {
    const pe = at.pe;
    const before = this.snapshot();
    const o = { id: newId(), type: 'ink', pageId: at.id, points: [this.toUser(pe, at.sx, at.sy)], color: this.style.color, stroke: Math.max(0.5, this.style.size / 6) };
    this.objects.set(o.id, o);
    this.drawLayer(at.id);
    let last = { x: at.sx, y: at.sy };
    let line = pe.layer.querySelector(`polyline[data-obj="${o.id}"]`);
    let pts = line?.getAttribute('points') || '';
    this.track(e, (ev) => {
      const sx = ev.clientX - at.rect.left, sy = ev.clientY - at.rect.top;
      if (Math.hypot(sx - last.x, sy - last.y) < 1.5) return;
      last = { x: sx, y: sy };
      o.points.push(this.toUser(pe, sx, sy));
      pts += ` ${sx},${sy}`;
      line?.setAttribute('points', pts);
    }, () => {
      if (o.points.length < 2) o.points.push({ x: o.points[0].x + 0.5, y: o.points[0].y });
      this.pushUndo(before);
      this.drawLayer(at.id);
      this.changed();
    });
  }

  onHover(e) {
    if (!this.editing || this.tool !== 'edit') return;
    const at = this.pageAt(e);
    if (!at) return;
    const p = this.pageById(at.id);
    const c = this.cached(p);
    if (!c?.text) return;
    const idx = this.textItemAt(c.text, this.toUser(at.pe, at.sx, at.sy));
    if (idx < 0) { this.hoverEl?.remove(); return; }
    if (!this.hoverEl) { this.hoverEl = document.createElement('div'); this.hoverEl.className = 'pdf-hover'; }
    this.place(this.hoverEl, c.text[idx], at.pe.vp);
    if (this.hoverEl.parentNode !== at.pe.layer) at.pe.layer.appendChild(this.hoverEl);
  }

  // Typing in text boxes: update the data only, no redraw, so it stays instant.
  onInput(e) {
    const el = e.target.closest('[data-obj]');
    if (!el) return;
    const o = this.objects.get(el.dataset.obj);
    if (!o) return;
    o.text = el.innerText.replace(/\n$/, '');
    const k = this.pageEls.get(o.pageId)?.vp.scale || 1;
    o.w = Math.max(10, el.scrollWidth / k);
    this.onDirty();
  }

  onFocusIn(e) {
    const el = e.target.closest('[data-obj]');
    if (el && el.isContentEditable) this.editStart = { id: el.dataset.obj, snap: this.snapshot() };
  }

  onFocusOut(e) {
    const el = e.target.closest('[data-obj]');
    if (!el || !this.editStart || this.editStart.id !== el.dataset.obj) return;
    const o = this.objects.get(el.dataset.obj);
    const before = JSON.parse(this.editStart.snap).objects.find((x) => x.id === el.dataset.obj);
    if (o && o.type === 'text' && !o.text.trim()) {
      this.objects.delete(o.id);
      if (this.selected === o.id) this.selected = null;
      this.drawLayer(o.pageId);
    } else if (o && before && before.text !== o.text) {
      this.pushUndo(this.editStart.snap);
    }
    this.editStart = null;
    this.syncToolbar();
  }

  onFieldChange(e) {
    const el = e.target.closest('.pdf-field');
    if (!el) return;
    const name = el.dataset.field;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'radio') v = el.checked ? el.value : this.formValues.get(name);
    else v = el.value;
    this.formValues.set(name, v);
    this.formChanged.add(name);
    this.onDirty();
  }

  handleKey(e) {
    if (!this.host.isConnected || this.host.hidden || !this.pages.length) return;
    const t = e.target;
    const typing = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (!this.editing) return;
    if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
    if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); return this.redo(); }
    if (typing) {
      if (e.key === 'Escape' && t.isContentEditable) t.blur();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); return this.deleteSelected(); }
    if (e.key === 'Escape') { this.select(null); this.setTool('select'); return; }
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const o = this.selected && this.objects.get(this.selected);
    if (nudge && o && o.type !== 'ink') {
      e.preventDefault();
      const pe = this.pageEls.get(o.pageId);
      const f = this.screenFrame(o, pe.vp);
      const step = e.shiftKey ? 10 : 1;
      this.pushUndo();
      const u = this.toUser(pe, f.left + nudge[0] * step, f.top + nudge[1] * step);
      o.x = u.x; o.y = u.y;
      this.refreshObj(o);
      this.changed();
    }
  }

  // ---------------------------------------------------------------- images and signatures

  visiblePage() {
    const top = this.scroll.getBoundingClientRect().top + this.scroll.clientHeight / 3;
    for (const [id, pe] of this.pageEls) {
      const r = pe.el.getBoundingClientRect();
      if (r.top <= top && r.bottom >= top) return { id, pe };
    }
    const [id, pe] = this.pageEls.entries().next().value;
    return { id, pe };
  }

  async addImageFile(file) {
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    this.placeImage(dataUrl, file.type === 'image/png' ? 'png' : 'jpg', 220);
  }

  async placeImage(dataUrl, kind, widthPt) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const imageId = newId('i');
    this.images.set(imageId, { dataUrl, kind });
    const { id, pe } = this.visiblePage();
    const k = pe.vp.scale;
    const pageW = pe.vp.width / k, pageH = pe.vp.height / k;
    const w = Math.min(widthPt, pageW * 0.6);
    const h = (w * img.naturalHeight) / img.naturalWidth;
    const sx = (pe.vp.width - w * k) / 2;
    const r = pe.el.getBoundingClientRect();
    const viewTop = Math.max(0, this.scroll.getBoundingClientRect().top - r.top) + 60;
    const sy = Math.min(viewTop, pe.vp.height - h * k - 10);
    const u = this.toUser(pe, sx, Math.max(0, sy));
    this.pushUndo();
    this.setTool('select');
    this.addObject({ id: newId(), type: 'image', pageId: id, imageId, x: u.x, y: u.y, angle: this.screenAngle(pe, sx, sy), w, h, color: '#000000' });
    if (pageH < h) this.onStatus('The picture is larger than the page; drag the corner to resize it.');
  }

  openSignaturePad() {
    const wrap = document.createElement('div');
    wrap.className = 'pdf-modal';
    wrap.innerHTML = `
      <div class="pdf-modal-card" role="dialog" aria-label="Draw your signature">
        <h3>Draw your signature</h3>
        <canvas width="560" height="200"></canvas>
        <div class="pdf-modal-actions">
          <button type="button" data-act="clear">Clear</button>
          <span></span>
          <button type="button" data-act="cancel">Cancel</button>
          <button type="button" data-act="use" class="primary">Add signature</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const cv = wrap.querySelector('canvas');
    const ctx = cv.getContext('2d');
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.style.color === '#ffe14d' ? '#000000' : this.style.color;
    let drawing = false, any = false;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };
    cv.onpointerdown = (e) => { drawing = true; any = true; cv.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
    cv.onpointermove = (e) => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } };
    cv.onpointerup = () => { drawing = false; };
    const close = () => wrap.remove();
    wrap.onclick = (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'clear') { ctx.clearRect(0, 0, cv.width, cv.height); any = false; }
      if (act === 'cancel' || e.target === wrap) close();
      if (act === 'use') {
        if (!any) return;
        const trimmed = this.trimCanvas(cv);
        close();
        this.placeImage(trimmed, 'png', 160);
      }
    };
  }

  trimCanvas(cv) {
    const ctx = cv.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    }
    if (x1 <= x0 || y1 <= y0) return cv.toDataURL('image/png');
    const pad = 6;
    const out = document.createElement('canvas');
    out.width = x1 - x0 + pad * 2;
    out.height = y1 - y0 + pad * 2;
    out.getContext('2d').drawImage(cv, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- pages panel

  togglePages() {
    this.showPages = !this.showPages;
    this.aside.hidden = !this.showPages;
    this.syncToolbar();
    if (this.showPages) this.renderThumbs();
  }

  renderThumbs() {
    if (!this.showPages || !this.thumbsEl) return;
    this.thumbObserver?.disconnect();
    this.thumbsEl.innerHTML = '';
    this.thumbObserver = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { this.drawThumb(en.target); this.thumbObserver.unobserve(en.target); }
    }, { root: this.aside, rootMargin: '300px 0px' });
    this.pages.forEach((p, i) => {
      const c = this.cached(p);
      const vp = this.viewport(p, c, 1);
      const w = 120, h = Math.round((w * vp.height) / vp.width);
      const item = document.createElement('div');
      item.className = 'pdf-thumb';
      item.dataset.id = p.id;
      item.innerHTML = `
        <button type="button" class="pdf-thumb-img" data-go title="Go to page ${i + 1}" style="width:${w}px;height:${h}px"></button>
        <div class="pdf-thumb-bar">
          <span>${i + 1}</span>
          <button type="button" data-page="up" title="Move up" aria-label="Move page ${i + 1} up" ${i === 0 ? 'disabled' : ''}>&#8593;</button>
          <button type="button" data-page="down" title="Move down" aria-label="Move page ${i + 1} down" ${i === this.pages.length - 1 ? 'disabled' : ''}>&#8595;</button>
          <button type="button" data-page="rotate" title="Rotate" aria-label="Rotate page ${i + 1}">&#8635;</button>
          <button type="button" data-page="delete" title="Delete page" aria-label="Delete page ${i + 1}">&#10005;</button>
        </div>`;
      this.thumbsEl.appendChild(item);
      this.thumbObserver.observe(item);
    });
    this.thumbsEl.onclick = (e) => {
      const item = e.target.closest('.pdf-thumb');
      if (!item) return;
      const id = item.dataset.id;
      const act = e.target.closest('[data-page]')?.dataset.page;
      if (e.target.closest('[data-go]')) return this.pageEls.get(id)?.el.scrollIntoView({ block: 'start' });
      if (!act) return;
      if (!this.editing) return this.onStatus('Click Edit to rearrange pages.');
      if (act === 'rotate') this.rotatePage(id);
      if (act === 'delete') this.deletePage(id);
      if (act === 'up' || act === 'down') this.movePage(id, act === 'up' ? -1 : 1);
    };
  }

  async drawThumb(item) {
    const p = this.pageById(item.dataset.id);
    if (!p) return;
    const c = await this.pdfPage(p);
    const base = this.viewport(p, c, 1);
    const scale = (120 / base.width) * (window.devicePixelRatio || 1);
    const vp = this.viewport(p, c, scale);
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width);
    cv.height = Math.floor(vp.height);
    try {
      await c.page.render({ canvasContext: cv.getContext('2d'), canvas: cv, viewport: vp }).promise;
      item.querySelector('.pdf-thumb-img')?.appendChild(cv);
    } catch { /* skipped */ }
  }

  rotatePage(id) {
    const p = this.pageById(id);
    this.pushUndo();
    p.rot = (p.rot + 90) % 360;
    this.layoutPages();
    this.renderThumbs();
    this.changed();
  }

  deletePage(id) {
    if (this.pages.length === 1) return this.onStatus('A PDF needs at least one page.');
    this.pushUndo();
    this.pages = this.pages.filter((p) => p.id !== id);
    for (const o of [...this.objects.values()]) if (o.pageId === id) this.objects.delete(o.id);
    this.layoutPages();
    this.renderThumbs();
    this.changed();
  }

  movePage(id, dir) {
    const i = this.pages.findIndex((p) => p.id === id);
    const j = i + dir;
    if (j < 0 || j >= this.pages.length) return;
    this.pushUndo();
    [this.pages[i], this.pages[j]] = [this.pages[j], this.pages[i]];
    this.layoutPages();
    this.renderThumbs();
    this.changed();
  }

  async addPdf(file) {
    if (!this.editing) return this.onStatus('Click Edit to add pages.');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await this.openPdf(bytes);
      const src = this.sources.length;
      this.sources.push({ bytes, doc, name: file.name });
      this.pushUndo();
      for (let i = 0; i < doc.numPages; i++) this.pages.push({ id: newId('p'), src, index: i, rot: 0 });
      await Promise.all(this.pages.map((p) => this.pdfPage(p)));
      this.layoutPages();
      this.renderThumbs();
      this.changed();
      this.onStatus(`Added ${doc.numPages} page${doc.numPages === 1 ? '' : 's'} from ${file.name}.`);
    } catch (e) {
      this.onStatus('Could not add that PDF: ' + (e?.message || 'unknown error'));
    }
  }

  // ---------------------------------------------------------------- zoom

  setZoom(z) {
    this.zoom = clamp(Math.round(z * 100) / 100, 0.25, 4);
    this.layoutPages();
    return this.zoom;
  }

  fitWidth() {
    this.zoom = this.fitZoom();
    this.layoutPages();
    return this.zoom;
  }

  // ---------------------------------------------------------------- search

  async search(query) {
    this.hits = [];
    this.hitIndex = -1;
    const q = (query || '').trim().toLowerCase();
    if (!q) { this.redrawAll(); return { count: 0, index: -1 }; }
    if (this.pages.length > 30) this.onStatus('Searching...');
    for (const p of this.pages) {
      const c = await this.pdfPage(p);
      const items = await this.ensureText(p, c);
      items.forEach((it, ti) => {
        const s = it.str.toLowerCase();
        let i = s.indexOf(q);
        while (i >= 0 && this.hits.length < 5000) {
          this.hits.push({ pageId: p.id, ti, start: i, len: q.length });
          i = s.indexOf(q, i + q.length);
        }
      });
    }
    this.onStatus('');
    this.redrawAll();
    return this.step(1);
  }

  step(dir) {
    const n = this.hits.length;
    if (!n) return { count: 0, index: -1 };
    const prev = this.hits[this.hitIndex];
    this.hitIndex = (this.hitIndex + dir + n) % n;
    const hit = this.hits[this.hitIndex];
    if (prev && prev.pageId !== hit.pageId) this.drawLayer(prev.pageId);
    this.drawLayer(hit.pageId);
    const pe = this.pageEls.get(hit.pageId);
    const c = this.cached(this.pageById(hit.pageId));
    if (pe && c?.text) {
      const f = this.screenFrame(c.text[hit.ti], pe.vp);
      const top = pe.el.offsetTop + f.top - this.scroll.clientHeight / 3;
      this.scroll.scrollTo({ top, behavior: 'auto' });
    }
    const pageNo = this.pages.findIndex((p) => p.id === hit.pageId) + 1;
    return { count: n, index: this.hitIndex, where: `Page ${pageNo}` };
  }

  // ---------------------------------------------------------------- saving

  hasEdits() {
    if (this.objects.size || this.formChanged.size) return true;
    return !(this.pages.length === this.sources[0].doc.numPages && this.pages.every((p, i) => p.src === 0 && p.index === i && !p.rot));
  }

  async exportBlob() {
    if (document.activeElement?.isContentEditable) document.activeElement.blur();
    if (!this.hasEdits()) return new Blob([this.sources[0].bytes], { type: 'application/pdf' });

    const lib = await import('pdf-lib');
    const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, pushGraphicsState, popGraphicsState } = lib;

    // 1. Remove the old words wherever existing text was changed (MuPDF).
    const srcBytes = [];
    for (let si = 0; si < this.sources.length; si++) {
      const reps = [...this.objects.values()].filter((o) => o.type === 'replace' && this.pageById(o.pageId)?.src === si);
      srcBytes.push(reps.length ? await this.redact(si, reps) : this.sources[si].bytes);
    }

    const doc = await PDFDocument.load(srcBytes[0], { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) throw new Error('This PDF is password protected, so DocDrop cannot save changes to it.');

    // 2. Form answers.
    const formProblems = this.applyForms(doc, lib);

    // 3. Pages: order, rotation, pages added from other PDFs.
    const originals = doc.getPages();
    const others = new Map();
    const final = [];
    for (const p of this.pages) {
      let page;
      if (p.src === 0) page = originals[p.index];
      else {
        if (!others.has(p.src)) others.set(p.src, await PDFDocument.load(srcBytes[p.src], { ignoreEncryption: true }));
        [page] = await doc.copyPages(others.get(p.src), [p.index]);
      }
      final.push({ p, page });
    }
    const sameOrder = this.pages.length === originals.length && this.pages.every((p, i) => p.src === 0 && p.index === i);
    if (!sameOrder) {
      for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
      final.forEach(({ page }, i) => doc.insertPage(i, page));
    }
    for (const { p, page } of final) if (p.rot) page.setRotation(degrees((page.getRotation().angle + p.rot) % 360));

    // 4. Draw additions as real PDF content.
    const fonts = new Map();
    const fontFor = async (o) => {
      const names = {
        sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
        serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
        mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique']
      }[o.font] || ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'];
      const key = names[(o.bold ? 1 : 0) + (o.italic ? 2 : 0)];
      if (!fonts.has(key)) fonts.set(key, await doc.embedFont(StandardFonts[key]));
      return fonts.get(key);
    };
    const embedded = new Map();
    let replacedChars = 0;
    const clean = (font, line) => [...line].map((ch) => {
      try { font.encodeText(ch); return ch; } catch { replacedChars++; return ch === '\u20A6' ? 'N' : '?'; }
    }).join('');

    for (const { p, page } of final) {
      const objs = [...this.objects.values()].filter((o) => o.pageId === p.id);
      if (!objs.length) continue;
      this.wrapExisting(doc, page, pushGraphicsState, popGraphicsState);
      for (const o of objs) {
        const [r, g, b] = hexToRgb01(o.color);
        const color = rgb(r, g, b);
        if (o.type === 'ink') {
          const pts = o.points;
          for (let i = 0; i < pts.length - 1; i++) {
            page.drawLine({ start: pts[i], end: pts[i + 1], thickness: o.stroke, color, lineCap: LineCapStyle.Round });
          }
          continue;
        }
        const rot = degrees((o.angle * 180) / Math.PI);
        const dn = downOf(o.angle);
        if (o.type === 'text' || o.type === 'replace') {
          if (!o.text) continue;
          const font = await fontFor(o);
          const base = (FONTS[o.font] || FONTS.sans).base;
          o.text.split('\n').forEach((line, i) => {
            if (!line) return;
            const off = (base + 1.2 * i) * o.size;
            page.drawText(clean(font, line), { x: o.x + dn.x * off, y: o.y + dn.y * off, size: o.size, font, color, rotate: rot });
          });
          continue;
        }
        const bl = { x: o.x + dn.x * o.h, y: o.y + dn.y * o.h };
        if (o.type === 'highlight') page.drawRectangle({ x: bl.x, y: bl.y, width: o.w, height: o.h, rotate: rot, color, opacity: 0.38, blendMode: BlendMode.Multiply });
        else if (o.type === 'box') page.drawRectangle({ x: bl.x, y: bl.y, width: o.w, height: o.h, rotate: rot, borderColor: color, borderWidth: o.stroke });
        else if (o.type === 'whiteout') page.drawRectangle({ x: bl.x, y: bl.y, width: o.w, height: o.h, rotate: rot, color: rgb(1, 1, 1) });
        else if (o.type === 'image') {
          const im = this.images.get(o.imageId);
          if (!im) continue;
          if (!embedded.has(o.imageId)) {
            const bytes = await (await fetch(im.dataUrl)).arrayBuffer();
            embedded.set(o.imageId, im.kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes));
          }
          page.drawImage(embedded.get(o.imageId), { x: bl.x, y: bl.y, width: o.w, height: o.h, rotate: rot });
        }
      }
    }

    let out = await doc.save();
    const deleted = originals.length > this.pages.filter((p) => p.src === 0).length;
    if (deleted) out = await this.compact(out); // drop the deleted pages' contents from the file

    const notes = [];
    if (replacedChars) notes.push(`${replacedChars} character(s) are not supported by the PDF's standard fonts and were replaced`);
    if (formProblems) notes.push(`${formProblems} form field(s) could not be saved`);
    if (notes.length) this.onStatus('Saved, but ' + notes.join(', and ') + '.');
    return new Blob([out], { type: 'application/pdf' });
  }

  // Keep the page's own drawing settings from leaking into what we add.
  wrapExisting(doc, page, pushGraphicsState, popGraphicsState) {
    try {
      const ctx = doc.context;
      const start = ctx.register(ctx.contentStream([pushGraphicsState()]));
      const end = ctx.register(ctx.contentStream([popGraphicsState()]));
      page.node.wrapContentStreams(start, end);
    } catch { /* older pdf-lib already does this */ }
  }

  applyForms(doc, lib) {
    if (!this.formChanged.size) return 0;
    let form;
    try { form = doc.getForm(); } catch { return this.formChanged.size; }
    let problems = 0;
    for (const name of this.formChanged) {
      const meta = this.formMeta.get(name);
      if (meta?.src !== 0) continue;
      const v = this.formValues.get(name);
      try {
        const f = form.getField(name);
        if (f instanceof lib.PDFTextField) f.setText(String(v ?? ''));
        else if (f instanceof lib.PDFCheckBox) v ? f.check() : f.uncheck();
        else if (f instanceof lib.PDFRadioGroup) v ? f.select(v) : f.clear();
        else if (f instanceof lib.PDFDropdown || f instanceof lib.PDFOptionList) {
          const opt = (meta.options || []).find((o) => o.exportValue === v);
          const choice = opt?.displayValue ?? v;
          if (choice) f.select(choice); else f.clear();
        }
      } catch (e) {
        console.warn('DocDrop: form field not saved', name, e);
        problems++;
      }
    }
    return problems;
  }

  async loadMupdf() {
    this.onStatus('Preparing the text editor engine...');
    const mupdf = await import('mupdf');
    return mupdf;
  }

  async redact(si, reps) {
    const mupdf = await this.loadMupdf();
    const doc = mupdf.Document.openDocument(this.sources[si].bytes, 'application/pdf');
    const pdf = doc.asPDF ? doc.asPDF() : doc;
    if (pdf.needsPassword?.() && !(this.password && pdf.authenticatePassword(this.password))) {
      throw new Error('This PDF is password protected, so its text cannot be changed.');
    }
    const byPage = new Map();
    for (const o of reps) {
      const p = this.pageById(o.pageId);
      if (!byPage.has(p.index)) byPage.set(p.index, []);
      byPage.get(p.index).push(o);
    }
    const P = mupdf.PDFPage || {};
    for (const [index, list] of byPage) {
      const page = pdf.loadPage(index);
      const c = this.cache.get(si + ':' + index);
      const vp1 = c.page.getViewport({ scale: 1 }); // MuPDF page space = unscaled, page's own rotation
      for (const o of list) {
        const r = o.redact;
        const d = dirOf(r.angle), dn = downOf(r.angle);
        const corners = [
          [r.x, r.y], [r.x + d.x * r.w, r.y + d.y * r.w],
          [r.x + dn.x * r.h, r.y + dn.y * r.h], [r.x + d.x * r.w + dn.x * r.h, r.y + d.y * r.w + dn.y * r.h]
        ].map(([x, y]) => vp1.convertToViewportPoint(x, y));
        const xs = corners.map((q) => q[0]), ys = corners.map((q) => q[1]);
        const annot = page.createAnnotation('Redact');
        annot.setRect([Math.min(...xs) - 0.3, Math.min(...ys) - 0.3, Math.max(...xs) + 0.3, Math.max(...ys) + 0.3]);
        annot.update?.();
      }
      // No black boxes; keep pictures and lines; remove only the text underneath.
      page.applyRedactions(0, P.REDACT_IMAGE_NONE ?? 0, P.REDACT_LINE_ART_NONE ?? 0, P.REDACT_TEXT_REMOVE ?? 0);
    }
    const out = pdf.saveToBuffer('garbage,compress').asUint8Array().slice();
    doc.destroy?.();
    this.onStatus('');
    return out;
  }

  async compact(bytes) {
    try {
      const mupdf = await this.loadMupdf();
      const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
      const pdf = doc.asPDF ? doc.asPDF() : doc;
      const out = pdf.saveToBuffer('garbage,compress').asUint8Array().slice();
      doc.destroy?.();
      this.onStatus('');
      return out;
    } catch (e) {
      console.warn('DocDrop: could not compact PDF', e);
      return bytes;
    }
  }

  // Print or save as PDF through Chrome's own sharp PDF viewer.
  async print() {
    try {
      const blob = await this.exportBlob();
      const url = URL.createObjectURL(blob);
      chrome.tabs.create({ url });
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60000);
      this.onStatus('Opened in Chrome\'s PDF viewer. Use its print button.');
    } catch (e) {
      this.onStatus('Could not prepare the PDF for printing: ' + (e?.message || 'unknown error'));
    }
  }

  // ---------------------------------------------------------------- cleanup

  destroy() {
    this.observer?.disconnect();
    this.thumbObserver?.disconnect();
    for (const pe of this.pageEls?.values() || []) pe.task?.cancel();
    for (const s of this.sources || []) { try { s.doc?.destroy(); } catch { /* ignore */ } }
    document.querySelector('.pdf-modal')?.remove();
    if (this.host) this.host.innerHTML = '';
    if (this.toolbarHost) this.toolbarHost.innerHTML = '';
    this.reset();
  }
}
