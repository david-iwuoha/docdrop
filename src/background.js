// DocDrop background worker: on/off state, the drop tab, and opening downloads.
const SUPPORTED = ['pdf', 'docx', 'xlsx', 'xlsm', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'ppsx', 'pptm'];
const VIEWER = chrome.runtime.getURL('viewer.html');

async function isOn() {
  const { enabled } = await chrome.storage.local.get('enabled');
  return enabled === true;
}

async function showBadge(on) {
  await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2E8B7A' });
}

// Open the drop tab, or switch to it if one is already open.
async function openDropTab() {
  let existing = null;
  if (chrome.runtime.getContexts) {
    const pages = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    existing = pages.find((p) => p.documentUrl === VIEWER);
  }
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: VIEWER });
  }
}

chrome.runtime.onInstalled.addListener(async () => showBadge(await isOn()));
chrome.runtime.onStartup.addListener(async () => showBadge(await isOn()));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'setEnabled') {
      await chrome.storage.local.set({ enabled: msg.enabled });
      await showBadge(msg.enabled);
      if (msg.enabled) await openDropTab();
    } else if (msg.type === 'openDropTab') {
      await openDropTab();
    }
    reply({ ok: true });
  })();
  return true;
});

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// When a supported file finishes downloading, open it in DocDrop.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current !== 'complete') return;
  if (!(await isOn())) return;

  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item || !SUPPORTED.includes(extensionOf(item.filename))) return;
  if (item.byExtensionId === chrome.runtime.id) return; // our own "Save" downloads

  const params = new URLSearchParams({ path: item.filename, url: item.finalUrl || item.url || '' });
  chrome.tabs.create({ url: VIEWER + '?' + params.toString() });
});
