import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const stub = here('./src/shared/node-canvas-stub.js');

// Copies files the extension needs at runtime, plus the licence and notice
// files of bundled libraries (their licences ask for this when redistributed).
const LICENSED = ['superdoc', 'pptx-vanilla-viewer', 'exceljs', 'xlsx', 'three', 'pdfjs-dist', 'pdf-lib', 'mupdf'];
function copyExtras() {
  return {
    name: 'docdrop-copy-extras',
    closeBundle() {
      // PDF.js font and character data, so every PDF renders correctly.
      const pdfjs = here('./node_modules/pdfjs-dist');
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        if (existsSync(`${pdfjs}/${dir}`)) cpSync(`${pdfjs}/${dir}`, here(`./dist/pdfjs/${dir}`), { recursive: true });
      }
      // Licences
      const out = here('./dist/licenses');
      mkdirSync(out, { recursive: true });
      for (const f of ['LICENSE', 'NOTICE.md']) {
        if (existsSync(here('./' + f))) copyFileSync(here('./' + f), `${out}/DocDrop-${f}`);
      }
      for (const pkg of LICENSED) {
        for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE', 'NOTICE.md']) {
          const src = here(`./node_modules/${pkg}/${f}`);
          if (existsSync(src)) copyFileSync(src, `${out}/${pkg}-${f}`);
        }
      }
    }
  };
}

// DocDrop is built as a Chrome extension (Manifest V3).
// Everything is bundled locally because extensions may not load remote code.
export default defineConfig({
  root: here('./src'),
  publicDir: here('./public'),
  base: './',
  resolve: {
    alias: {
      // Server-only libraries some packages mention; never used in Chrome.
      '@napi-rs/canvas': stub,
      'canvas': stub
    }
  },
  build: {
    outDir: here('./dist'),
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 30000,
    rollupOptions: {
      input: {
        viewer: here('./src/viewer.html'),
        popup: here('./src/popup.html'),
        background: here('./src/background.js')
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'
      }
    }
  },
  worker: { format: 'es' },
  plugins: [copyExtras()]
});
