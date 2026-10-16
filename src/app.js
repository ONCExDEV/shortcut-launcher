'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const webview = window.__TAURI__.webview.getCurrentWebview();
const { open: openDialog, save: saveDialog } = window.__TAURI__.dialog;

const $ = (selector) => document.querySelector(selector);
const el = {
  search: $('#search'), grid: $('#grid'), groups: $('#groups'), empty: $('#empty'), drop: $('#drop'),
  menu: $('#menu'), toast: $('#toast'), footLeft: $('#foot-left'), footRight: $('#foot-right'),
  headTitle: $('#head-title'), headMeta: $('#head-meta'), launchAll: $('#btn-launch-all'),
  content: $('.content'), selBar: $('#sel-bar'),
  item: $('#dlg-item'), settings: $('#dlg-settings'), apps: $('#dlg-apps'),
};

const DEFAULT_HOTKEY = 'Ctrl+Alt+KeyL';
/** Bump when icon extraction improves, so existing icons are fetched again once. */
const ICON_VERSION = 2;

let data = null;
let activeId = null;
let query = '';
let selected = -1;
let visible = [];
let editingGroup = null;
let suppressClick = false;
let toastTimer;
const picked = new Set();
let anchorId = null;
let renamingId = null;
let clip = null;

/* ---------- Helpers ---------- */

const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isUrl = (t) => /^[a-z][a-z0-9+.-]*:\/\//i.test(t);
const isShell = (t) => t.startsWith('shell:');
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const group = (id = activeId) => data.groups.find((g) => g.id === id);
const allItems = () => data.groups.flatMap((g) => g.items);
const findItem = (id) => allItems().find((i) => i.id === id);
const dialogOpen = () => !!document.querySelector('dialog[open]');
const hideWindow = () => invoke('hide_window');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function baseName(target) {
  if (isUrl(target)) {
    try { return new URL(target).hostname.replace(/^www\./, ''); } catch { return target; }
  }
  const file = target.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || target;
  return file.replace(/\.(lnk|exe|url|bat|cmd)$/i, '');
}

function prettyKey(hotkey) {
  return hotkey.replace(/Key([A-Z])/g, '$1').replace(/Digit(\d)/g, '$1').replace(/Arrow/g, '').replace(/\+/g, ' + ');
}

function logProblem(message) {
  invoke('log_message', { message: String(message).slice(0, 500) }).catch(() => {});
}

window.addEventListener('error', (e) => { logProblem(`error: ${e.message}`); showToast(`Something went wrong: ${e.message}`, { error: true }); });
window.addEventListener('unhandledrejection', (e) => { logProblem(`rejection: ${e.reason}`); showToast(`Something went wrong: ${e.reason}`, { error: true }); });

/* ---------- Data: loading and saving ---------- */

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const s = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const settings = {
    hotkey: typeof s.hotkey === 'string' && s.hotkey ? s.hotkey : DEFAULT_HOTKEY,
    closeAfterLaunch: s.closeAfterLaunch !== false,
    alwaysOnTop: s.alwaysOnTop === true,
    shortcutsFolder: typeof s.shortcutsFolder === 'string' ? s.shortcutsFolder : '',
    openWithDoubleClick: s.openWithDoubleClick !== false,
    theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
  };

  const used = new Set();
  const freshId = () => { let id; do { id = uid(); } while (used.has(id)); used.add(id); return id; };
  const claimId = (id) => (typeof id === 'string' && id && !used.has(id) ? (used.add(id), id) : freshId());

  const groups = (Array.isArray(src.groups) ? src.groups : [])
    .filter((g) => g && typeof g === 'object')
    .map((g) => ({
      id: claimId(g.id),
      name: String(g.name ?? '').trim().slice(0, 60) || 'Group',
      items: (Array.isArray(g.items) ? g.items : [])
        .filter((i) => i && typeof i === 'object' && typeof i.target === 'string' && i.target)
        .map((i) => ({
          id: claimId(i.id),
          name: String(i.name ?? '').trim() || baseName(i.target),
          target: i.target,
          args: typeof i.args === 'string' ? i.args : '',
          admin: i.admin === true,
          uses: Number.isFinite(i.uses) ? i.uses : 0,
          icon: typeof i.icon === 'string' && i.icon.startsWith('data:image/') ? i.icon : null,
        })),
    }));
  if (!groups.length) groups.push({ id: freshId(), name: 'General', items: [] });
  const iconVersion = Number.isFinite(src.iconVersion) ? src.iconVersion : 0;
  return { version: 1, iconVersion, settings, groups };
}

let pendingJson = null;
let writing = false;
let saveBlocked = false;

/** Writes the whole data set to disk right away. Rapid changes are coalesced; failures are retried and reported. */
function save() {
  if (saveBlocked || !data) return;
  pendingJson = JSON.stringify(data);
  flushSaves();
}

async function flushSaves() {
  if (writing) return;
  writing = true;
  let failures = 0;
  while (pendingJson !== null) {
    const json = pendingJson;
    pendingJson = null;
    try {
      await invoke('save_data', { json });
      if (failures) showToast('Saved', {});
      failures = 0;
    } catch (e) {
      failures += 1;
      logProblem(`save failed (attempt ${failures}): ${e}`);
      if (pendingJson === null) pendingJson = json;
      if (failures >= 5) {
        showToast(`Your latest changes could not be saved: ${e}. They are kept until you close the app.`, { error: true, sticky: true });
        pendingJson = null;
        break;
      }
      await sleep(1000 * failures);
    }
  }
  writing = false;
}

async function loadData() {
  try {
    const result = await invoke('load_data');
    const fresh = !result.data;
    const loaded = normalize(result.data ? JSON.parse(result.data) : null);
    return { loaded, fresh, notice: result.notice };
  } catch (e) {
    saveBlocked = true;
    logProblem(`load failed: ${e}`);
    return {
      loaded: normalize(null),
      fresh: false,
      notice: `Your data could not be read (${e}). Nothing will be saved this session so your files stay untouched. Please restart the launcher.`,
    };
  }
}

/* ---------- Toast ---------- */

function showToast(message, { error = false, undo = null, action = null, sticky = false } = {}) {
  clearTimeout(toastTimer);
  const act = action || (undo && { label: 'Undo', run: undo });
  el.toast.className = error ? 'toast error' : 'toast';
  el.toast.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
  if (act) {
    const button = Object.assign(document.createElement('button'), { textContent: act.label });
    button.onclick = () => { act.run(); el.toast.hidden = true; };
    el.toast.append(button);
  }
  el.toast.hidden = false;
  if (!sticky) toastTimer = setTimeout(() => { el.toast.hidden = true; }, act ? 8000 : error ? 6000 : 3500);
}

el.toast.addEventListener('click', (e) => { if (!e.target.closest('button')) el.toast.hidden = true; });

const inShortcutsFolder = (target) => {
  const folder = data.settings.shortcutsFolder;
  if (!folder || !isLocalFile(target)) return false;
  const base = `${folder.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()}\\`;
  return target.replace(/\//g, '\\').toLowerCase().startsWith(base);
};

/** The shortcut files in the shortcuts folder that belong only to the items being removed. */
function shortcutFilesOf(removed) {
  if (!data.settings.shortcutsFolder) return [];
  const keep = new Set(allItems().filter((i) => !removed.includes(i)).map((i) => i.target.toLowerCase()));
  const seen = new Set();
  return removed
    .map((i) => i.target)
    .filter((t) => /\.(lnk|url|appref-ms)$/i.test(t) && inShortcutsFolder(t) && !keep.has(t.toLowerCase()) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

/**
 * Runs a change and offers Undo. Items that are being removed lose their shortcut file in the shortcuts folder:
 * it is moved to a safe place (kept for 30 days) and Undo puts it back.
 */
function withUndo(message, mutate, { removing = [] } = {}) {
  const snapshot = JSON.stringify(data);
  const files = shortcutFilesOf(removing);
  const folder = data.settings.shortcutsFolder;
  mutate();
  save();
  render();
  const trashed = files.length
    ? invoke('trash_shortcut_files', { folder, paths: files }).catch((e) => { logProblem(`remove files failed: ${e}`); return []; })
    : Promise.resolve([]);
  const note = files.length
    ? `. ${files.length === 1 ? 'Its shortcut file was' : `${files.length} shortcut files were`} also taken out of "${folderLabel(folder)}"`
    : '';
  showToast(message + note, {
    undo: async () => {
      const taken = (await trashed).filter((t) => t.holding);
      const restored = taken.length ? await invoke('restore_shortcut_files', { items: taken }).catch(() => []) : [];
      data = normalize(JSON.parse(snapshot));
      for (const r of restored) {
        if (!r.error && r.to !== r.original) allItems().forEach((i) => { if (i.target === r.original) i.target = r.to; });
      }
      if (!group()) activeId = data.groups[0].id;
      save();
      render();
    },
  });
}

/* ---------- Search ---------- */

function score(name, q) {
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  let i = 0;
  for (const c of n) if (c === q[i] && ++i === q.length) return 20;
  return 0;
}

function computeVisible() {
  const q = query.trim().toLowerCase();
  if (!q) return group().items;
  const rank = (r) => r.s + Math.min(r.item.uses || 0, 10) * 0.5;
  return allItems()
    .map((item) => ({ item, s: score(item.name, q) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => rank(b) - rank(a) || a.item.name.localeCompare(b.item.name))
    .map((r) => r.item);
}

/* ---------- Rendering ---------- */

function render() {
  renderGroups();
  renderGrid();
}

function renderGroups() {
  el.groups.innerHTML = data.groups.map((g) => {
    const active = !query && g.id === activeId ? ' active' : '';
    const label = editingGroup === g.id
      ? `<input type="text" value="${esc(g.name)}" maxlength="40" spellcheck="false">`
      : `<span class="name">${esc(g.name)}</span><span class="count">${g.items.length}</span>`;
    return `<button class="group${active}" data-id="${g.id}">${label}</button>`;
  }).join('');

  const input = el.groups.querySelector('input');
  if (!input) return;
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name) group(editingGroup).name = name;
    editingGroup = null;
    save();
    render();
    el.search.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

function tileHtml(item, index) {
  const icon = item.icon
    ? `<img src="${item.icon}" alt="" draggable="false">`
    : `<span class="letter" style="--h:${hue(item.name)}">${esc([...item.name.trim()][0]?.toUpperCase() || '?')}</span>`;
  const isCut = clip?.mode === 'cut' && clip.ids.includes(item.id);
  const cls = ['tile', index === selected && 'sel', picked.has(item.id) && 'picked', isCut && 'cut'].filter(Boolean).join(' ');
  const label = renamingId === item.id
    ? `<input class="rename" type="text" value="${esc(item.name)}" maxlength="80" spellcheck="false">`
    : `<span class="label">${esc(item.name)}</span>`;
  return `<button class="${cls}" data-id="${item.id}" title="${esc(item.target)}"><span class="ico">${icon}</span>${label}</button>`;
}

function emptyHtml() {
  if (query.trim()) return `<div><h2>No results</h2><p>Nothing matches “${esc(query.trim())}”.</p></div>`;
  const welcome = allItems().length === 0;
  const lead = welcome
    ? 'Add your apps, files and folders once. After that you can open anything with a hotkey and a quick search.'
    : 'Add shortcuts to this group, or drag them in from another group.';
  return `<div>${welcome ? '<img class="hero" src="logo.png" alt="">' : ''}<h2>${welcome ? 'Welcome to Shortcut Launcher' : 'This group is empty'}</h2><p>${lead} You can also drop files into this window.</p>
    <div class="btns"><button class="btn primary" data-act="apps">Add apps</button><button class="btn" data-act="files">Add files</button><button class="btn" data-act="desktop">Import desktop</button></div></div>`;
}

function renderGrid() {
  visible = computeVisible();
  if (selected >= visible.length) selected = visible.length - 1;
  for (const id of picked) if (!findItem(id)) picked.delete(id);

  el.grid.innerHTML = visible.map(tileHtml).join('');
  const empty = !visible.length;
  el.grid.hidden = empty;
  el.empty.hidden = !empty;
  if (empty) el.empty.innerHTML = emptyHtml();

  const q = query.trim();
  el.headTitle.textContent = q ? `Results for “${q}”` : group().name;
  updateSelectionUi();
  el.footRight.textContent = plural(allItems().length, 'shortcut');
  el.grid.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  bindRenameInput();
}

function updateSelectionUi() {
  const q = query.trim();
  const g = group();
  const n = picked.size;
  el.headMeta.textContent = n > 1 ? `${n} selected` : q ? `${visible.length} found` : plural(g.items.length, 'shortcut');
  el.selBar.hidden = n < 2;
  el.launchAll.hidden = n > 1 || !!q || !g.items.length;
}

function setActive(id) {
  picked.clear();
  activeId = id;
  query = '';
  el.search.value = '';
  selected = -1;
  render();
  el.search.focus();
}

/* ---------- Launching ---------- */

const fileName = (target) => target.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const folderLabel = (path) => fileName(path) || path;
const isLocalFile = (t) => !isUrl(t) && !isShell(t);

/** If a shortcut's file is gone, looks for the same file name in the shortcuts folder and points the item at it. */
async function relink(item) {
  const folder = data.settings.shortcutsFolder;
  if (!folder || !isLocalFile(item.target)) return false;
  const [gone] = await invoke('missing_paths', { paths: [item.target] });
  if (!gone) return false;
  const found = await invoke('find_in_folder', { folder, names: [fileName(item.target)] });
  const hit = found[fileName(item.target).toLowerCase()];
  if (!hit) return false;
  item.target = hit;
  save();
  return true;
}

async function launchItem(item, { admin = false, keepOpen = false } = {}) {
  const run = () => invoke('launch', { target: item.target, args: item.args || '', admin: admin || item.admin });
  try {
    try {
      await run();
    } catch (first) {
      if (!(await relink(item))) throw first;
      await run();
    }
    item.uses = (item.uses || 0) + 1;
    save();
    if (data.settings.closeAfterLaunch && !keepOpen) hideWindow();
  } catch (e) {
    const [gone] = isLocalFile(item.target) ? await invoke('missing_paths', { paths: [item.target] }).catch(() => []) : [];
    if (!gone) return showToast(String(e), { error: true });
    if (data.settings.shortcutsFolder) {
      showToast(`"${item.name}" was not found, not even in your shortcuts folder.`, { error: true });
    } else {
      showToast(`"${item.name}" was moved or deleted. Choose your shortcuts folder in Settings to find it again.`, { error: true, action: { label: 'Settings', run: openSettings } });
    }
  }
}

async function launchGroup(g) {
  for (const item of g.items) {
    await launchItem(item, { keepOpen: true });
    await sleep(150);
  }
  if (data.settings.closeAfterLaunch) hideWindow();
}

/* ---------- Adding shortcuts ---------- */

async function fetchIcon(target) {
  if (isUrl(target)) return null;
  try { return await invoke('get_icon', { path: target }); } catch { return null; }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i]); }
  }));
  return out;
}

/** With a shortcuts folder set, everything that gets added also gets its shortcut file in that folder. */
async function place(entries) {
  const folder = data.settings.shortcutsFolder;
  const unchanged = { targets: entries.map((e) => e.target), note: '' };
  if (!folder || !entries.length) return unchanged;
  try {
    const results = await invoke('place_in_folder', {
      folder,
      items: entries.map((e) => ({ name: e.name, target: e.target, args: e.args || '' })),
    });
    const count = (action) => results.filter((r) => !r.error && r.action === action).length;
    const failed = results.filter((r) => r.error).length;
    const label = `"${folderLabel(folder)}"`;
    const parts = [];
    if (count('created')) parts.push(`saved ${plural(count('created'), 'shortcut')} in ${label}`);
    if (count('moved')) parts.push(`moved ${count('moved')} from your desktop to ${label}`);
    if (count('copied')) parts.push(`copied ${count('copied')} into ${label}`);
    if (failed) parts.push(`${failed} could not be saved there, so the original is used`);
    return { targets: results.map((r, i) => (r.error ? entries[i].target : r.to)), actions: results.map((r) => (r.error ? 'kept' : r.action)), note: parts.join(', ') };
  } catch (e) {
    logProblem(`place failed: ${e}`);
    return unchanged;
  }
}

async function addEntries(entries, groupId = activeId) {
  if (!entries.length) return;
  if (entries.length > 8) showToast(`Adding ${entries.length} shortcuts…`);
  const placed = await place(entries);
  const final = entries.map((entry, i) => ({ ...entry, final: placed.targets[i] }));
  const created = await mapLimit(final, 8, async (entry) => ({
    id: uid(),
    name: entry.name,
    target: entry.final,
    args: entry.final === entry.target ? entry.args || '' : '',
    admin: entry.admin === true,
    uses: 0,
    icon: isUrl(entry.target) ? null : await fetchIcon(entry.final),
  }));
  const target = group(groupId) || group();
  target.items.push(...created);
  save();
  render();
  const added = created.length === 1 ? `Added ${created[0].name}` : `Added ${created.length} shortcuts`;
  showToast(placed.note ? `${added}, ${placed.note}` : added);
}

const addPaths = (paths, groupId) => addEntries(paths.map((path) => ({ name: baseName(path), target: path })), groupId);

async function pickAndAdd(directory) {
  try {
    const picked = await openDialog({ directory, multiple: true });
    if (picked) await addPaths(Array.isArray(picked) ? picked : [picked]);
  } finally {
    appWindow.setFocus();
  }
}

async function importDesktop() {
  const found = await invoke('desktop_shortcuts');
  const known = new Set(allItems().map((i) => i.target.toLowerCase()));
  const fresh = found.filter((f) => !known.has(f.path.toLowerCase()));
  if (!fresh.length) return showToast('Nothing new on your desktop');

  let target = data.groups.find((g) => g.name === 'Desktop');
  if (!target) {
    target = { id: uid(), name: 'Desktop', items: [] };
    data.groups.push(target);
  }
  activeId = target.id;
  query = '';
  el.search.value = '';
  await addEntries(fresh.map((f) => ({ name: f.name, target: f.path })), target.id);
}

async function importFromFolder() {
  const folder = data.settings.shortcutsFolder;
  if (!folder) return showToast('Choose a shortcuts folder in Settings first');
  const known = new Set(allItems().map((i) => i.target.toLowerCase()));
  const fresh = (await invoke('list_folder', { folder })).filter((f) => !known.has(f.path.toLowerCase()));
  if (!fresh.length) return showToast('Everything in your shortcuts folder is already in the launcher');

  let target = data.groups.find((g) => g.name === 'Shortcuts');
  if (!target) {
    target = { id: uid(), name: 'Shortcuts', items: [] };
    data.groups.push(target);
  }
  activeId = target.id;
  query = '';
  el.search.value = '';
  await addEntries(fresh.map((f) => ({ name: f.name, target: f.path })), target.id);
}

/** Finds shortcuts whose file no longer exists and points them at the same file name in the shortcuts folder. */
async function repairBroken({ announce = true } = {}) {
  const folder = data.settings.shortcutsFolder;
  if (!folder) {
    if (announce) showToast('Choose a shortcuts folder first');
    return { fixed: 0, left: 0 };
  }
  const items = allItems().filter((i) => isLocalFile(i.target));
  const gone = new Set((await invoke('missing_paths', { paths: items.map((i) => i.target) })).map((p) => p.toLowerCase()));
  const broken = items.filter((i) => gone.has(i.target.toLowerCase()));
  if (!broken.length) {
    if (announce) showToast('All your shortcuts work');
    return { fixed: 0, left: 0 };
  }
  const found = await invoke('find_in_folder', { folder, names: broken.map((i) => fileName(i.target)) });
  let fixed = 0;
  for (const item of broken) {
    const hit = found[fileName(item.target).toLowerCase()];
    if (hit) { item.target = hit; fixed += 1; }
  }
  if (fixed) { save(); render(); }
  const left = broken.length - fixed;
  if (announce) {
    showToast(left
      ? `Fixed ${fixed} of ${broken.length} broken shortcuts. ${left} could not be found in your shortcuts folder.`
      : `Fixed ${plural(fixed, 'broken shortcut')}.`);
  } else if (fixed) {
    showToast(`Fixed ${plural(fixed, 'broken shortcut')} using your shortcuts folder.`);
  }
  return { fixed, left };
}

/** Gives every shortcut that is not in the shortcuts folder yet its own file there. */
async function syncToFolder() {
  const folder = data.settings.shortcutsFolder;
  if (!folder) return showToast('Choose a shortcuts folder first');
  const todo = allItems().filter((i) => !inShortcutsFolder(i.target));
  if (!todo.length) return showToast('Everything is already in your shortcuts folder');
  showToast(`Saving ${plural(todo.length, 'shortcut')} into your folder…`);
  const placed = await place(todo.map((i) => ({ name: i.name, target: i.target, args: i.args })));
  let changed = 0;
  todo.forEach((item, index) => {
    const target = placed.targets[index];
    if (target === item.target) return;
    item.args = placed.actions[index] === 'created' ? '' : item.args;
    item.target = target;
    changed += 1;
  });
  save();
  render();
  const skipped = todo.length - changed;
  showToast(`${changed ? `Saved ${plural(changed, 'shortcut')} into "${folderLabel(folder)}"` : 'Nothing could be saved there'}${skipped ? `. ${skipped} could not be saved (their original is still used)` : ''}.`);
}

const reportError = (e) => showToast(String(e), { error: true });

/** Fetches every icon again (sharper, without the frame Windows adds). Icons that cannot be read are left as they are. */
async function refreshIcons({ announce = true } = {}) {
  const targets = allItems().filter((i) => !isUrl(i.target));
  if (announce && targets.length) showToast(`Refreshing ${plural(targets.length, 'icon')}…`);
  let updated = 0;
  await mapLimit(targets, 8, async (item) => {
    const icon = await fetchIcon(item.target);
    if (icon) { item.icon = icon; updated += 1; }
  });
  data.iconVersion = ICON_VERSION;
  save();
  render();
  if (announce) showToast(`Refreshed ${plural(updated, 'icon')}`);
}

/* ---------- Installed apps picker ---------- */

let appList = [];
const chosen = new Set();

function visibleApps() {
  const q = $('#a-search').value.trim().toLowerCase();
  return appList.filter((a) => !q || a.name.toLowerCase().includes(q));
}

function renderApps() {
  const shown = visibleApps();
  $('#a-list').innerHTML = shown.map((a) => {
    const checked = chosen.has(a.target) ? ' checked' : '';
    return `<label class="${a.added ? 'pick added' : 'pick'}"><input type="checkbox" data-t="${esc(a.target)}"${checked}${a.added ? ' disabled' : ''}><span>${esc(a.name)}</span>${a.added ? '<em>Added</em>' : ''}</label>`;
  }).join('') || '<div class="empty" style="height:100%">No apps found</div>';
  $('#a-count').textContent = `${chosen.size} selected`;
}

async function openAppsPicker() {
  hideMenu();
  chosen.clear();
  $('#a-search').value = '';
  $('#a-list').innerHTML = '<div class="empty" style="height:100%">Loading your apps…</div>';
  $('#a-count').textContent = '0 selected';
  el.apps.showModal();
  $('#a-search').focus();
  try {
    const raw = await invoke('start_apps');
    const parsed = raw ? JSON.parse(raw) : [];
    const known = new Set(allItems().map((i) => i.target.toLowerCase()));
    const seen = new Set();
    appList = (Array.isArray(parsed) ? parsed : [parsed])
      .map((a) => ({ name: a.Name, target: `shell:AppsFolder\\${a.AppID}` }))
      .filter((a) => a.name && !seen.has(a.target) && seen.add(a.target))
      .map((a) => ({ ...a, added: known.has(a.target.toLowerCase()) }));
    renderApps();
  } catch (e) {
    el.apps.close();
    reportError(e);
  }
}

function showAddMenu() {
  const r = $('#btn-add').getBoundingClientRect();
  showMenu(r.right - 210, r.bottom + 4, [
    { label: 'Installed apps…', run: openAppsPicker },
    { label: 'Files…', run: () => pickAndAdd(false) },
    { label: 'Folders…', run: () => pickAndAdd(true) },
    { label: 'Everything on my desktop', run: () => importDesktop().catch(reportError) },
    ...(data.settings.shortcutsFolder ? [{ label: 'Everything in my shortcuts folder', run: () => importFromFolder().catch(reportError) }] : []),
    '-',
    { label: 'Website or custom shortcut…', run: () => openItemDialog() },
  ]);
}

/* ---------- Editing ---------- */

function openItemDialog(item = null) {
  hideMenu();
  $('#item-title').textContent = item ? 'Edit shortcut' : 'Add shortcut';
  $('#f-name').value = item?.name || '';
  $('#f-target').value = item?.target || '';
  $('#f-args').value = item?.args || '';
  $('#f-admin').checked = !!item?.admin;
  el.item.dataset.editing = item?.id || '';
  el.item.showModal();
  (item ? $('#f-name') : $('#f-target')).focus();
}

async function browse(directory) {
  try {
    const path = await openDialog({ directory, multiple: false });
    if (typeof path === 'string') {
      $('#f-target').value = path;
      if (!$('#f-name').value.trim()) $('#f-name').value = baseName(path);
    }
  } finally {
    appWindow.setFocus();
  }
}

async function submitItem(e) {
  e.preventDefault();
  const target = $('#f-target').value.trim();
  if (!target) return;
  const name = $('#f-name').value.trim() || baseName(target);
  const args = $('#f-args').value.trim();
  const admin = $('#f-admin').checked;
  const editingId = el.item.dataset.editing;

  if (editingId) {
    const item = findItem(editingId);
    if (item) {
      const changed = item.target !== target;
      Object.assign(item, { name, target, args, admin });
      if (changed) item.icon = await fetchIcon(target);
    }
  } else {
    el.item.close();
    await addEntries([{ name, target, args, admin }]);
    return;
  }
  el.item.close();
  save();
  render();
}

function removeItem(item) {
  withUndo(`Removed ${item.name}`, () => {
    data.groups.forEach((g) => { g.items = g.items.filter((i) => i.id !== item.id); });
  }, { removing: [item] });
}

function addGroup() {
  const g = { id: uid(), name: 'New group', items: [] };
  data.groups.push(g);
  activeId = g.id;
  query = '';
  el.search.value = '';
  editingGroup = g.id;
  save();
  render();
}

function deleteGroup(g) {
  if (data.groups.length === 1) return showToast('You need at least one group', { error: true });
  withUndo(`Deleted ${g.name}`, () => {
    data.groups = data.groups.filter((x) => x.id !== g.id);
    if (activeId === g.id) activeId = data.groups[0].id;
  }, { removing: [...g.items] });
}

/* ---------- Context menu ---------- */

function hideMenu() { el.menu.hidden = true; }

function showMenu(x, y, entries) {
  const makeButton = (entry, className) => {
    const button = document.createElement('button');
    button.className = [className, entry.danger && 'danger'].filter(Boolean).join(' ');
    button.disabled = !!entry.disabled;
    button.onclick = () => { hideMenu(); entry.run(); };
    return button;
  };
  el.menu.replaceChildren(...entries.map((entry) => {
    if (entry === '-') return document.createElement('hr');
    if (entry.row) {
      const row = document.createElement('div');
      row.className = 'menu-row';
      for (const icon of entry.row) {
        const button = makeButton(icon, 'menu-icon');
        button.title = icon.label;
        button.innerHTML = `${ICONS[icon.icon]}<span>${esc(icon.label)}</span>`;
        row.append(button);
      }
      return row;
    }
    const button = makeButton(entry, '');
    button.innerHTML = `<span>${esc(entry.label)}</span>${entry.hint ? `<kbd>${esc(entry.hint)}</kbd>` : ''}`;
    return button;
  }));
  el.menu.hidden = false;
  const { width, height } = el.menu.getBoundingClientRect();
  el.menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  el.menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
}

function itemMenu(item, x, y) {
  const local = isLocalFile(item.target);
  showMenu(x, y, [
    { row: [
      { label: 'Cut', icon: 'cut', run: () => copyItems('cut') },
      { label: 'Copy', icon: 'copy', run: () => copyItems('copy') },
      { label: 'Rename', icon: 'rename', run: () => startRename(item.id) },
      { label: 'Remove', icon: 'trash', danger: true, run: () => removeItem(item) },
    ] },
    { label: 'Open', hint: 'Enter', run: () => launchItem(item) },
    ...(local ? [
      { label: 'Run as administrator', hint: 'Ctrl+Enter', run: () => launchItem(item, { admin: true }) },
      { label: 'Show in folder', run: () => invoke('reveal', { target: item.target }).catch(reportError) },
    ] : []),
    '-',
    { label: isUrl(item.target) ? 'Copy link' : 'Copy as path', hint: 'Ctrl+Shift+C', run: () => copyAsText(item.target, isUrl(item.target) ? 'Copied the link' : 'Copied the path') },
    ...(local ? [{ label: 'Properties', hint: 'Alt+Enter', run: () => showProperties(item) }] : []),
    { label: 'Edit…', run: () => openItemDialog(item) },
  ]);
}

function groupMenu(g, x, y) {
  showMenu(x, y, [
    { label: 'Open all', run: () => launchGroup(g) },
    { label: 'Paste here', hint: 'Ctrl+V', disabled: !clip, run: () => pasteItems(g.id) },
    { label: 'Sort A to Z', run: () => sortGroup(g) },
    '-',
    { label: 'Rename', hint: 'F2', run: () => { editingGroup = g.id; renderGroups(); } },
    { label: 'Delete group', danger: true, run: () => deleteGroup(g) },
  ]);
}

/** Right-click on empty space in the list. */
function emptyMenu(x, y) {
  showMenu(x, y, [
    { label: 'Paste', hint: 'Ctrl+V', disabled: !clip, run: () => pasteItems() },
    { label: 'Select all', hint: 'Ctrl+A', run: pickAll },
    { label: 'Sort A to Z', run: () => sortGroup(group()) },
    '-',
    { label: 'Add apps…', run: openAppsPicker },
    { label: 'Add files…', run: () => pickAndAdd(false).catch(reportError) },
    { label: 'New group', run: addGroup },
  ]);
}

/* ---------- Multi-select ---------- */

function refreshPicked() {
  el.grid.querySelectorAll('.tile[data-id]').forEach((t) => t.classList.toggle('picked', picked.has(t.dataset.id)));
  updateSelectionUi();
}

function clearPicked() {
  if (!picked.size) return;
  picked.clear();
  refreshPicked();
}

function togglePicked(id) {
  if (picked.has(id)) picked.delete(id); else picked.add(id);
  anchorId = id;
  refreshPicked();
}

function rangePick(id, additive) {
  const ids = visible.map((i) => i.id);
  const a = ids.indexOf(anchorId);
  const b = ids.indexOf(id);
  if (a < 0 || b < 0) return togglePicked(id);
  if (!additive) picked.clear();
  ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((i) => picked.add(i));
  refreshPicked();
}

function pickAll() {
  visible.forEach((i) => picked.add(i.id));
  refreshPicked();
}

async function openPicked() {
  const items = allItems().filter((i) => picked.has(i.id));
  for (const item of items) {
    await launchItem(item, { keepOpen: true });
    await sleep(150);
  }
  clearPicked();
  if (data.settings.closeAfterLaunch) hideWindow();
}

function removePicked() {
  const n = picked.size;
  if (!n) return;
  const removing = allItems().filter((i) => picked.has(i.id));
  withUndo(`Removed ${plural(n, 'shortcut')}`, () => {
    data.groups.forEach((g) => { g.items = g.items.filter((i) => !picked.has(i.id)); });
    picked.clear();
  }, { removing });
}

function moveItems(ids, destId) {
  const dest = group(destId);
  const moving = allItems().filter((i) => ids.includes(i.id));
  if (!dest || !moving.length) return;
  data.groups.forEach((g) => { g.items = g.items.filter((i) => !ids.includes(i.id)); });
  dest.items.push(...moving);
  picked.clear();
  save();
  render();
  showToast(`Moved ${plural(moving.length, 'shortcut')} to ${dest.name}`);
}

function moveMenuEntries() {
  return data.groups.map((g) => ({ label: g.name, run: () => moveItems([...picked], g.id) }));
}

function selectionMenu(x, y) {
  const n = picked.size;
  showMenu(x, y, [
    { row: [
      { label: 'Cut', icon: 'cut', run: () => copyItems('cut') },
      { label: 'Copy', icon: 'copy', run: () => copyItems('copy') },
    ] },
    { label: `Open ${plural(n, 'shortcut')}`, run: openPicked },
    { label: 'Copy as paths', hint: 'Ctrl+Shift+C', run: () => copyAsText(clipItems().map((i) => i.target).join('\r\n'), 'Copied the paths') },
    '-',
    ...moveMenuEntries().map((entry) => ({ ...entry, label: `Move to ${entry.label}` })),
    '-',
    { label: `Remove ${plural(n, 'shortcut')}`, danger: true, run: removePicked },
  ]);
}

/** Rubber-band selection: press on empty space and drag a rectangle over the shortcuts you want. */
function startMarquee(e) {
  const box = el.content;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  const base = additive ? new Set(picked) : new Set();
  const toContent = (ev) => {
    const r = box.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top + box.scrollTop };
  };
  const start = toContent(e);
  let last = e;
  let rect = null;
  let timer = null;

  const update = () => {
    const br = box.getBoundingClientRect();
    const p = toContent(last);
    const x1 = Math.min(start.x, p.x), x2 = Math.max(start.x, p.x);
    const y1 = Math.min(start.y, p.y), y2 = Math.max(start.y, p.y);
    rect.style.cssText = `left:${x1}px;top:${y1}px;width:${x2 - x1}px;height:${y2 - y1}px`;
    picked.clear();
    base.forEach((id) => picked.add(id));
    el.grid.querySelectorAll('.tile[data-id]').forEach((t) => {
      const r = t.getBoundingClientRect();
      const tx1 = r.left - br.left, ty1 = r.top - br.top + box.scrollTop;
      if (tx1 < x2 && tx1 + r.width > x1 && ty1 < y2 && ty1 + r.height > y1) picked.add(t.dataset.id);
    });
    refreshPicked();
  };

  const tick = () => {
    const br = box.getBoundingClientRect();
    if (last.clientY < br.top + 28) box.scrollTop -= 14;
    else if (last.clientY > br.bottom - 28) box.scrollTop += 14;
    update();
  };

  const move = (ev) => {
    last = ev;
    if (!rect) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
      rect = document.createElement('div');
      rect.className = 'marquee';
      box.append(rect);
      timer = setInterval(tick, 30);
    }
    update();
  };

  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    clearInterval(timer);
    if (rect) rect.remove();
    else if (!additive) clearPicked();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* ---------- Drag to reorder ---------- */

function clearMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function beginDrag(e, kind, id, node) {
  if (e.button !== 0 || (query && kind !== 'item') || editingGroup) return;
  const sx = e.clientX, sy = e.clientY;
  let ghost = null, target = null;
  let ids = [id];
  const dragged = [node];

  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (kind === 'item') {
        if (picked.has(id)) {
          ids = [...picked];
          el.grid.querySelectorAll('.tile.picked').forEach((t) => { if (t !== node) dragged.push(t); });
        } else {
          clearPicked();
        }
      }
      ghost = node.cloneNode(true);
      ghost.classList.add('ghost');
      if (ids.length > 1) ghost.insertAdjacentHTML('beforeend', `<span class="badge">${ids.length}</span>`);
      document.body.append(ghost);
      dragged.forEach((t) => t.classList.add('dragging'));
      document.body.classList.add('is-dragging');
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    clearMarks();
    target = null;
    if (kind === 'item' && (ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= innerWidth || ev.clientY >= innerHeight)) {
      finish(false);
      return dragOut(ids);
    }
    if (query) return;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(kind === 'item' ? '.tile[data-id], .group' : '.group');
    if (!over || over === node || (kind === 'item' && ids.includes(over.dataset.id))) return;
    const r = over.getBoundingClientRect();
    if (over.classList.contains('group')) {
      if (kind === 'item') { over.classList.add('drop-into'); target = { type: 'group', id: over.dataset.id }; return; }
      const after = ev.clientY > r.top + r.height / 2;
      over.classList.add(after ? 'drop-after' : 'drop-before');
      target = { type: 'group', id: over.dataset.id, after };
    } else {
      const after = ev.clientX > r.left + r.width / 2;
      over.classList.add(after ? 'drop-after' : 'drop-before');
      target = { type: 'tile', id: over.dataset.id, after };
    }
  };

  const finish = (drop) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!ghost) return;
    ghost.remove();
    dragged.forEach((t) => t.classList.remove('dragging'));
    document.body.classList.remove('is-dragging');
    clearMarks();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (drop && target) applyDrop(kind, ids, target);
  };
  const up = () => finish(true);

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

let draggingOut = false;

/** Dragging shortcuts out of the window hands them to Windows, so they can be dropped on the desktop or into any folder. */
async function dragOut(ids) {
  const items = ids.map(findItem).filter(Boolean);
  if (!items.length || draggingOut) return;
  draggingOut = true;
  el.drop.hidden = true;
  try {
    await invoke('drag_out', { items: items.map((i) => ({ name: i.name, target: i.target, args: i.args || '' })) });
  } catch (e) {
    reportError(e);
  } finally {
    setTimeout(() => { draggingOut = false; el.drop.hidden = true; }, 300);
  }
}

function moveWithin(list, id, targetId, after) {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return;
  const [moved] = list.splice(from, 1);
  const to = list.findIndex((x) => x.id === targetId);
  list.splice(to < 0 ? list.length : to + (after ? 1 : 0), 0, moved);
}

function applyDrop(kind, ids, target) {
  if (kind === 'group') {
    moveWithin(data.groups, ids[0], target.id, target.after);
  } else if (target.type === 'tile') {
    const g = group();
    const moving = g.items.filter((i) => ids.includes(i.id));
    const rest = g.items.filter((i) => !ids.includes(i.id));
    const at = rest.findIndex((i) => i.id === target.id);
    if (at < 0 || !moving.length) return;
    rest.splice(at + (target.after ? 1 : 0), 0, ...moving);
    g.items = rest;
  } else if (target.id !== activeId) {
    return moveItems(ids, target.id);
  } else {
    return;
  }
  save();
  render();
}

/* ---------- Settings ---------- */

function applyTheme() {
  const theme = data.settings.theme;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

async function applyHotkey(hotkey, { silent = false } = {}) {
  try {
    await invoke('set_hotkey', { hotkey });
    return true;
  } catch (e) {
    if (!silent) reportError(e);
    return false;
  }
}

function captureHotkey() {
  const button = $('#s-hotkey');
  button.textContent = 'Press keys…';
  button.classList.add('capturing');
  const modifiers = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

  const stop = () => {
    window.removeEventListener('keydown', onKey, true);
    button.classList.remove('capturing');
    button.textContent = prettyKey(data.settings.hotkey);
  };
  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') return stop();
    if (modifiers.includes(e.code)) return;
    const parts = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!parts.length && !/^F\d+$/.test(e.code)) return showToast('Include Ctrl, Alt, Shift or Win', { error: true });
    const hotkey = [...parts, e.code].join('+');
    stop();
    if (await applyHotkey(hotkey)) {
      data.settings.hotkey = hotkey;
      save();
      button.textContent = prettyKey(hotkey);
    }
  };
  window.addEventListener('keydown', onKey, true);
}

function fillSettings() {
  const s = data.settings;
  $('#s-hotkey').textContent = prettyKey(s.hotkey);
  $('#s-close').checked = s.closeAfterLaunch;
  $('#s-top').checked = s.alwaysOnTop;
  $('#s-theme').value = s.theme;
  $('#s-dbl').checked = s.openWithDoubleClick;
  const folder = $('#s-sfolder');
  folder.textContent = s.shortcutsFolder || 'Not set';
  folder.title = s.shortcutsFolder;
}

async function openSettings() {
  hideMenu();
  fillSettings();
  $('#s-auto').checked = await invoke('get_autostart').catch(() => false);
  el.settings.showModal();
}

const jsonFilter = [{ name: 'Shortcut Launcher backup', extensions: ['json'] }];

async function exportBackup() {
  try {
    const path = await saveDialog({ defaultPath: 'shortcut-launcher-backup.json', filters: jsonFilter });
    if (!path) return;
    await invoke('export_backup', { path });
    showToast('Backup exported');
  } catch (e) { reportError(e); } finally { appWindow.setFocus(); }
}

async function restoreBackup() {
  try {
    const path = await openDialog({ multiple: false, filters: jsonFilter });
    if (typeof path !== 'string') return;
    const raw = await invoke('import_backup', { path });
    data = normalize(JSON.parse(raw));
    activeId = data.groups[0].id;
    applyTheme();
    fillSettings();
    await appWindow.setAlwaysOnTop(data.settings.alwaysOnTop);
    await applyHotkey(data.settings.hotkey, { silent: true });
    render();
    showToast('Backup restored. Your previous data was kept in the backups folder.');
  } catch (e) { reportError(e); } finally { appWindow.setFocus(); }
}

/* ---------- Events ---------- */

function bindEvents() {
  el.search.addEventListener('input', () => {
    query = el.search.value;
    selected = query.trim() ? 0 : -1;
    render();
  });

  el.grid.addEventListener('click', (e) => {
    if (suppressClick || e.target.closest('input')) return;
    const tile = e.target.closest('.tile[data-id]');
    const item = tile && findItem(tile.dataset.id);
    if (!item) return;
    if (e.shiftKey) return rangePick(item.id, e.ctrlKey || e.metaKey);
    if (e.ctrlKey || e.metaKey) { anchorId = item.id; return togglePicked(item.id); }
    if (data.settings.openWithDoubleClick) return selectOnly(item.id);
    clearPicked();
    launchItem(item);
  });
  el.grid.addEventListener('dblclick', (e) => {
    if (!data.settings.openWithDoubleClick || e.target.closest('input') || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const tile = e.target.closest('.tile[data-id]');
    const item = tile && findItem(tile.dataset.id);
    if (!item) return;
    selectOnly(item.id);
    launchItem(item);
  });
  el.content.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.tile, button, input, a')) return;
    const box = el.content.getBoundingClientRect();
    if (e.clientX > box.left + el.content.clientWidth) return;
    e.preventDefault();
    startMarquee(e);
  });
  el.grid.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input')) return;
    const tile = e.target.closest('.tile[data-id]');
    if (tile) beginDrag(e, 'item', tile.dataset.id, tile);
  });
  el.grid.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.tile[data-id]');
    const item = tile && findItem(tile.dataset.id);
    if (!item) return;
    if (!picked.has(item.id)) selectOnly(item.id);
    if (picked.size > 1) return selectionMenu(e.clientX, e.clientY);
    itemMenu(item, e.clientX, e.clientY);
  });
  el.content.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile')) return;
    emptyMenu(e.clientX, e.clientY);
  });

  el.empty.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'apps') openAppsPicker();
    if (act === 'files') pickAndAdd(false).catch(reportError);
    if (act === 'desktop') importDesktop().catch(reportError);
  });

  el.groups.addEventListener('click', (e) => {
    const node = e.target.closest('.group');
    if (node && !suppressClick) setActive(node.dataset.id);
  });
  el.groups.addEventListener('dblclick', (e) => {
    const node = e.target.closest('.group');
    if (node) { editingGroup = node.dataset.id; renderGroups(); }
  });
  el.groups.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.group');
    if (node && !e.target.matches('input')) beginDrag(e, 'group', node.dataset.id, node);
  });
  el.groups.addEventListener('contextmenu', (e) => {
    const node = e.target.closest('.group');
    if (node) groupMenu(group(node.dataset.id), e.clientX, e.clientY);
  });

  $('#add-group').onclick = addGroup;
  $('#btn-add').onclick = showAddMenu;
  $('#btn-hide').onclick = hideWindow;
  $('#btn-settings').onclick = openSettings;
  el.launchAll.onclick = () => launchGroup(group());
  $('#sel-open').onclick = openPicked;
  $('#sel-remove').onclick = removePicked;
  $('#sel-clear').onclick = clearPicked;
  $('#sel-move').onclick = () => {
    const r = $('#sel-move').getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, moveMenuEntries());
  };

  $('#form-item').addEventListener('submit', submitItem);
  $('#item-cancel').onclick = () => el.item.close();
  $('#b-file').onclick = () => browse(false);
  $('#b-folder').onclick = () => browse(true);
  $('#f-target').addEventListener('blur', () => {
    const target = $('#f-target').value.trim();
    if (target && !$('#f-name').value.trim()) $('#f-name').value = baseName(target);
  });

  $('#a-search').addEventListener('input', renderApps);
  $('#a-list').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-t]');
    if (!box) return;
    if (box.checked) chosen.add(box.dataset.t); else chosen.delete(box.dataset.t);
    $('#a-count').textContent = `${chosen.size} selected`;
  });
  $('#a-all').onclick = () => { visibleApps().filter((a) => !a.added).forEach((a) => chosen.add(a.target)); renderApps(); };
  $('#a-cancel').onclick = () => el.apps.close();
  $('#a-add').onclick = async () => {
    const entries = appList.filter((a) => chosen.has(a.target));
    el.apps.close();
    await addEntries(entries);
  };

  $('#s-hotkey').onclick = captureHotkey;
  $('#s-close').onchange = (e) => { data.settings.closeAfterLaunch = e.target.checked; save(); };
  $('#s-dbl').onchange = (e) => { data.settings.openWithDoubleClick = e.target.checked; save(); updateHint(); };
  $('#s-top').onchange = async (e) => {
    data.settings.alwaysOnTop = e.target.checked;
    save();
    await appWindow.setAlwaysOnTop(e.target.checked).catch(reportError);
  };
  $('#s-theme').onchange = (e) => { data.settings.theme = e.target.value; applyTheme(); save(); };
  $('#s-auto').onchange = (e) => invoke('set_autostart', { enabled: e.target.checked }).catch((err) => {
    e.target.checked = !e.target.checked;
    reportError(err);
  });
  $('#s-desktop').onclick = () => invoke('create_desktop_shortcut')
    .then(() => showToast('Desktop shortcut created'))
    .catch(reportError);
  $('#s-choose').onclick = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, defaultPath: data.settings.shortcutsFolder || undefined });
      if (typeof picked !== 'string') return;
      data.settings.shortcutsFolder = picked;
      save();
      fillSettings();
      const { fixed } = await repairBroken({ announce: false });
      const outside = allItems().filter((i) => !inShortcutsFolder(i.target)).length;
      const parts = [];
      if (fixed) parts.push(`Fixed ${plural(fixed, 'broken shortcut')}`);
      if (outside) parts.push(`${plural(outside, 'shortcut')} ${outside === 1 ? 'is' : 'are'} not in this folder yet`);
      if (outside) showToast(`${parts.join('. ')}.`, { action: { label: 'Save them all here', run: () => syncToFolder().catch(reportError) } });
      else showToast(parts.length ? `${parts.join('. ')}.` : 'Shortcuts folder set');
    } catch (e) { reportError(e); } finally { appWindow.setFocus(); }
  };
  $('#s-fix').onclick = () => repairBroken().catch(reportError);
  $('#s-sync').onclick = () => syncToFolder().catch(reportError);
  $('#s-icons').onclick = () => refreshIcons().catch(reportError);
  $('#s-import').onclick = () => { el.settings.close(); importDesktop().catch(reportError); };
  $('#s-export').onclick = exportBackup;
  $('#s-restore').onclick = restoreBackup;
  $('#s-folder').onclick = () => invoke('open_data_folder').catch(reportError);
  $('#s-quit').onclick = () => invoke('quit_app');
  $('#s-done').onclick = () => el.settings.close();

  [el.item, el.settings, el.apps].forEach((dlg) => dlg.addEventListener('close', () => el.search.focus()));

  document.addEventListener('pointerdown', (e) => { if (!el.menu.contains(e.target)) hideMenu(); });
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('paste', onPaste);
  window.addEventListener('blur', hideMenu);

  // Fired by the app whenever the window is brought back with the hotkey or the tray icon.
  listen('launcher-shown', () => {
    if (dialogOpen()) return;
    query = '';
    el.search.value = '';
    selected = -1;
    picked.clear();
    render();
    el.search.focus();
  });

  webview.onDragDropEvent((event) => {
    const p = event.payload;
    if (draggingOut) return;
    if (p.type === 'enter' || p.type === 'over') el.drop.hidden = false;
    else if (p.type === 'leave') el.drop.hidden = true;
    else if (p.type === 'drop') {
      el.drop.hidden = true;
      if (p.paths?.length) addPaths(p.paths).catch(reportError);
    }
  });
}

function moveSelection(delta) {
  if (!visible.length) return;
  let base = selected;
  if (base < 0 && picked.size === 1) base = visible.findIndex((i) => picked.has(i.id));
  selected = base < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, base + delta));
  if (data.settings.openWithDoubleClick) {
    picked.clear();
    picked.add(visible[selected].id);
    anchorId = visible[selected].id;
  }
  renderGrid();
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (!el.menu.hidden) return hideMenu();
    if (dialogOpen()) return;
    if (picked.size) return clearPicked();
    if (query) { el.search.value = ''; query = ''; selected = -1; return render(); }
    return void hideWindow();
  }
  if (dialogOpen() || editingGroup) return;

  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && (key === 'c' || key === 'x')) {
    if (e.shiftKey) {
      const items = key === 'c' ? clipItems() : [];
      if (items.length) { e.preventDefault(); copyAsText(items.map((i) => i.target).join('\r\n'), items.length > 1 ? 'Copied the paths' : 'Copied the path'); }
      return;
    }
    const textSelected = document.activeElement === el.search && el.search.selectionStart !== el.search.selectionEnd;
    if (!textSelected && clipItems().length) { e.preventDefault(); copyItems(key === 'x' ? 'cut' : 'copy'); }
    return;
  }
  if (e.altKey && e.key === 'Enter') {
    const item = singleItem();
    if (item && isLocalFile(item.target)) { e.preventDefault(); showProperties(item); }
    return;
  }

  const columns = getComputedStyle(el.grid).gridTemplateColumns.split(' ').length || 1;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); return moveSelection(columns);
    case 'ArrowUp': e.preventDefault(); return moveSelection(-columns);
    case 'ArrowRight': if (!query) { e.preventDefault(); moveSelection(1); } return;
    case 'ArrowLeft': if (!query) { e.preventDefault(); moveSelection(-1); } return;
    case 'Delete':
      if (picked.size && !el.search.value) { e.preventDefault(); removePicked(); }
      return;
    case 'Enter': {
      if (picked.size && selected < 0) { e.preventDefault(); return void openPicked(); }
      const item = visible[selected >= 0 ? selected : (query ? 0 : -1)];
      if (item) { e.preventDefault(); launchItem(item, { admin: e.ctrlKey }); }
      return;
    }
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'a' && !el.search.value) { e.preventDefault(); return pickAll(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); return showAddMenu(); }
  if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
    const g = data.groups[Number(e.key) - 1];
    if (g) { e.preventDefault(); setActive(g.id); }
    return;
  }
  if (e.key === 'F2') {
    const item = singleItem();
    if (item) { e.preventDefault(); return startRename(item.id); }
    if (!query) { editingGroup = activeId; return renderGroups(); }
    return;
  }
  // Typing anywhere starts a search.
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && document.activeElement !== el.search) el.search.focus();
}

/* ---------- Copy, cut and paste ---------- */

const ICONS = {
  cut: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  rename: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

/** The shortcut the user is pointing at when exactly one is selected (by click or by keyboard). */
function singleItem() {
  if (picked.size === 1) return findItem([...picked][0]);
  if (!picked.size && selected >= 0) return visible[selected] || null;
  return null;
}

/** The shortcuts a copy or cut applies to: the selection, or the keyboard-highlighted one. */
function clipItems() {
  if (picked.size) return allItems().filter((i) => picked.has(i.id));
  const item = selected >= 0 ? visible[selected] : null;
  return item ? [item] : [];
}

function writeClipboard(text) {
  const box = document.createElement('textarea');
  box.value = text;
  box.style.cssText = 'position:fixed;left:-9999px;opacity:0';
  document.body.append(box);
  const previous = document.activeElement;
  box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* fall through to the async API */ }
  box.remove();
  previous?.focus?.();
  if (!ok && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => { ok = true; }).catch(() => {});
  return ok;
}

function copyItems(mode) {
  const items = clipItems();
  if (!items.length) return;
  const text = items.map((i) => i.target).join('\r\n');
  const mine = { mode, ids: items.map((i) => i.id), snapshots: items.map((i) => ({ ...i })), text, unverified: false, filePaths: [] };
  clip = mine;
  // Real files go on the Windows clipboard, so Ctrl+V in Explorer or on the desktop pastes the shortcuts.
  // The launcher remembers which files it put there, to recognise its own copy when pasting back in.
  mine.ready = invoke('copy_shortcut_files', { items: items.map((i) => ({ name: i.name, target: i.target, args: i.args || '' })), text })
    .then((paths) => { mine.filePaths = paths; })
    .catch(() => { if (!writeClipboard(text)) mine.unverified = true; });
  render();
  showToast(`${mode === 'cut' ? 'Cut' : 'Copied'} ${plural(items.length, 'shortcut')}`);
}

function copyAsText(text, message = 'Copied the path') {
  writeClipboard(text);
  clip = null;
  render();
  showToast(message);
}

function pasteItems(destId = activeId) {
  const dest = group(destId);
  if (!clip || !dest) return;
  if (clip.mode === 'cut') {
    const ids = clip.ids.filter((id) => findItem(id));
    clip = null;
    if (!ids.length) return render();
    if (ids.every((id) => dest.items.some((i) => i.id === id))) { render(); return showToast('They are already in this group'); }
    return moveItems(ids, dest.id);
  }
  const copies = clip.snapshots.map((snapshot) => ({ ...snapshot, id: uid() }));
  dest.items.push(...copies);
  picked.clear();
  copies.forEach((c) => picked.add(c.id));
  save();
  render();
  showToast(`Pasted ${plural(copies.length, 'shortcut')}`);
}

/** Ctrl+V: pastes what the launcher copied, or files copied elsewhere; plain text is left to the search box. */
function onPaste(e) {
  if (dialogOpen() || editingGroup || renamingId) return;
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (clip && (text === clip.text || (clip.unverified && !text))) {
    e.preventDefault();
    return pasteItems();
  }
  // Files on the clipboard: either the launcher's own copy, or files copied in Explorer (added like dropped files).
  const hasFiles = e.clipboardData?.types?.includes('Files') || e.clipboardData?.files?.length > 0;
  if (!hasFiles) return;
  e.preventDefault();
  const mine = clip;
  Promise.all([invoke('clipboard_files'), mine?.ready])
    .then(([paths]) => {
      const same = (a, b) => a.length === b.length && a.every((p, i) => p.toLowerCase() === b[i].toLowerCase());
      if (mine && clip === mine && mine.filePaths.length && same(paths, mine.filePaths)) return pasteItems();
      return paths.length ? addPaths(paths) : showToast('There is nothing to paste');
    })
    .catch(reportError);
}

function showProperties(item) {
  invoke('show_properties', { path: item.target }).catch(reportError);
}

function sortGroup(g) {
  withUndo(`Sorted ${g.name} from A to Z`, () => {
    g.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  });
}

/* ---------- Renaming a shortcut ---------- */

function startRename(id) {
  hideMenu();
  renamingId = id;
  renderGrid();
}

function bindRenameInput() {
  const input = el.grid.querySelector('input.rename');
  if (!input) return;
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    const item = findItem(renamingId);
    if (commit && name && item && item.name !== name) { item.name = name; save(); }
    renamingId = null;
    renderGrid();
    el.search.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  for (const type of ['click', 'dblclick', 'pointerdown', 'contextmenu']) input.addEventListener(type, (e) => e.stopPropagation());
}

function selectOnly(id) {
  picked.clear();
  picked.add(id);
  anchorId = id;
  selected = -1;
  el.grid.querySelectorAll('.sel').forEach((t) => t.classList.remove('sel'));
  refreshPicked();
}

function updateHint() {
  el.footLeft.textContent = `${data.settings.openWithDoubleClick ? 'Double-click' : 'Click'} opens · Drag to select several · Right-click for more`;
}

/* ---------- Start ---------- */

async function init() {
  const { loaded, fresh, notice } = await loadData();
  data = loaded;
  activeId = data.groups[0].id;
  applyTheme();
  bindEvents();
  render();
  updateHint();
  el.search.focus();
  if (notice) showToast(notice, { error: true, sticky: true });
  if (fresh && !saveBlocked) save();

  appWindow.setAlwaysOnTop(data.settings.alwaysOnTop).catch(() => {});
  if (!saveBlocked && data.iconVersion < ICON_VERSION) refreshIcons({ announce: false }).catch(logProblem);
  if (!saveBlocked && data.settings.shortcutsFolder) repairBroken({ announce: false }).catch(logProblem);
  if (!(await applyHotkey(data.settings.hotkey, { silent: true })) && !notice) {
    showToast(`${prettyKey(data.settings.hotkey)} is unavailable. Pick another hotkey in Settings.`, { error: true });
  }
}

init();
