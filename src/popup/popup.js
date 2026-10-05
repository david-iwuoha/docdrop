// DocDrop popup: on/off switch, open the DocDrop tab, recent files.
import './popup.css';
import { listRecent } from '../shared/recent.js';
import { extensionOf } from '../shared/formats.js';
import { initTheme, cycleTheme, themeLabel } from '../shared/theme.js';

const $ = (id) => document.getElementById(id);
const toggle = $('toggle');

function paint(on) {
  toggle.checked = on;
  $('status').textContent = on ? 'On: downloads open automatically' : 'Off';
  $('status').classList.toggle('on', on);
  $('hint').hidden = on;
}

chrome.storage.local.get('enabled').then(({ enabled }) => paint(enabled === true));

toggle.addEventListener('change', async () => {
  paint(toggle.checked);
  await chrome.runtime.sendMessage({ type: 'setEnabled', enabled: toggle.checked });
  if (toggle.checked) window.close();
});

$('openTab').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'openDropTab' });
  window.close();
});

// Open the PDF showing in the current tab. Clicking the DocDrop icon gives
// DocDrop permission to read that one tab (the "activeTab" permission).
$('editPdf').addEventListener('click', async () => {
  const btn = $('editPdf');
  const msg = $('pdfMsg');
  msg.hidden = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!/^(https?|file):/i.test(url)) {
    msg.textContent = 'Open a PDF in this tab first, then click here.';
    msg.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Opening...';
  let name = 'document.pdf';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || name; } catch { /* keep default */ }
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  const params = new URLSearchParams({ url, name });
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?' + params.toString(), index: tab.index + 1 });
  window.close();
});

listRecent().then((items) => {
  const top = items.slice(0, 5);
  $('recentBox').hidden = !top.length;
  for (const it of top) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="name"></span><span class="ext"></span>';
    b.querySelector('.name').textContent = it.name;
    b.querySelector('.ext').textContent = extensionOf(it.name).toUpperCase();
    b.onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?recent=' + encodeURIComponent(it.id) });
      window.close();
    };
    li.appendChild(b);
    $('recentList').appendChild(li);
  }
});

initTheme().then((t) => ($('themeBtn').textContent = themeLabel(t)));
$('themeBtn').onclick = async () => ($('themeBtn').textContent = themeLabel(await cycleTheme()));
