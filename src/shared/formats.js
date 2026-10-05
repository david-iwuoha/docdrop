// File types DocDrop understands, grouped by what opens them.
export const FORMATS = {
  doc: ['docx'],
  sheet: ['xlsx', 'xlsm', 'xls', 'ods', 'csv'],
  slides: ['pptx', 'ppt', 'ppsx', 'pptm'],
  pdf: ['pdf']
};

export const ALL_EXTENSIONS = [...FORMATS.doc, ...FORMATS.sheet, ...FORMATS.slides];

export const PICKER_TYPES = [
  {
    description: 'Documents, spreadsheets, presentations and PDFs',
    accept: {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx', '.ppsx', '.pptm'],
      'application/vnd.ms-powerpoint': ['.ppt'],
      'application/pdf': ['.pdf']
    }
  }
];

export function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function kindOf(name) {
  const ext = extensionOf(name);
  for (const [kind, list] of Object.entries(FORMATS)) {
    if (list.includes(ext)) return kind;
  }
  return null;
}

export function baseName(path) {
  return (path || '').split(/[\\/]/).pop();
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}
