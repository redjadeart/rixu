const DEFAULT_HABITS = ['晨间整理', '语言学习', '设计练习', '运动', '阅读', '睡前复盘'];
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const $ = s => document.querySelector(s);
const app = $('#app');
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return fmt(d); };
const today = () => fmt(new Date());
const label = k => { const d = parse(k); return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`; };
const rel = k => {
  const diff = Math.round((parse(k) - parse(today())) / 864e5);
  if (diff === 0) return '今天';
  if (diff === -1) return '昨天';
  if (diff === 1) return '明天';
  return diff < 0 ? `${-diff} 天前` : `${diff} 天后`;
};

const params = new URLSearchParams(location.search);
const isFull = true;

/* ---------- 云端 ---------- */
const SB_URL = 'https://xuadrdlrskyyohgwrpnx.supabase.co';
const SB_KEY = 'sb_publishable_Vxsp8NFu7sphTBJguR9FXw_0S61Cs_9';
const sb = window.supabase.createClient(SB_URL, SB_KEY);
const CACHE = 'rixu-cache-v1';
let user = null;
let synced = {};          // key -> 上次和云端一致时的 JSON
let dirty = new Set();    // 本地改了、还没传上去的 key
let flushTimer = null, flushing = false;
let state = { habits: [], days: {} };
let cur = params.get('date') || today();
let view = params.get('view') || 'day';
let filter = 'all';
const openSet = new Set(params.get('open') ? [params.get('open')] : []);

/* ---------- 数据 ---------- */
const toKV = st => {
  const m = { habits: JSON.stringify(st.habits) };
  for (const k in st.days) m['day:' + k] = JSON.stringify(st.days[k]);
  return m;
};
function normalize() {
  for (const k in state.days) { state.days[k].notes ??= {}; state.days[k].extras ??= []; state.days[k].tasks ??= {}; state.days[k].done ??= {}; }
}
function writeCache() {
  try { localStorage.setItem(CACHE, JSON.stringify({ uid: user.id, state, synced, dirty: [...dirty] })); } catch {}
}
function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (c && c.uid === user.id) { state = c.state; synced = c.synced || {}; dirty = new Set(c.dirty || []); normalize(); return true; }
  } catch {}
  return false;
}
function setSync(t, cls = '') { const el = $('#sync'); if (el) { el.textContent = t; el.className = 'sync ' + cls; } }

async function pull() {
  if (!navigator.onLine) { setSync('离线', 'off'); return false; }
  setSync('同步中…');
  const { data, error } = await sb.from('kv').select('key,value');
  if (error) { setSync('同步失败', 'err'); console.error(error); return false; }
  const remote = {};
  for (const r of data) remote[r.key] = JSON.stringify(r.value);
  const local = toKV(state);
  let changed = false;
  for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    if (dirty.has(k)) continue;                     // 本地有没传的改动，以本地为准
    if (k in remote) {
      if (remote[k] !== local[k]) {
        const v = JSON.parse(remote[k]);
        if (k === 'habits') state.habits = v; else state.days[k.slice(4)] = v;
        changed = true;
      }
      synced[k] = remote[k];
    } else if (k in synced) {                         // 别的设备删掉了
      if (k === 'habits') state.habits = []; else delete state.days[k.slice(4)];
      delete synced[k]; changed = true;
    } else dirty.add(k);                              // 只在本地有：传上去
  }
  normalize(); writeCache();
  await flush();
  return changed;
}
async function flush() {
  if (flushing || !dirty.size) { if (!dirty.size) setSync('已同步', 'ok'); return; }
  if (!navigator.onLine) { setSync('离线 · 联网后同步', 'off'); return; }
  flushing = true; setSync('同步中…');
  const keys = [...dirty], local = toKV(state);
  const up = keys.filter(k => k in local), del = keys.filter(k => !(k in local));
  try {
    if (up.length) {
      const { error } = await sb.from('kv').upsert(up.map(k => ({ user_id: user.id, key: k, value: JSON.parse(local[k]), updated_at: new Date().toISOString() })));
      if (error) throw error;
    }
    if (del.length) {
      const { error } = await sb.from('kv').delete().in('key', del);
      if (error) throw error;
    }
    const now = toKV(state);
    for (const k of up) { if (now[k] === local[k]) dirty.delete(k); synced[k] = local[k]; }
    for (const k of del) { if (!(k in now)) dirty.delete(k); delete synced[k]; }
    writeCache();
    setSync(dirty.size ? '同步中…' : '已同步', dirty.size ? '' : 'ok');
  } catch (e) { console.error(e); setSync('同步失败，稍后重试', 'err'); }
  flushing = false;
  if (dirty.size) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 3000); }
}
function hasNotes(html) {
  return !!html && (/<img/i.test(html) || html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim() !== '');
}
function save() {
  for (const k in state.days) {
    const d = state.days[k];
    const has = Object.values(d.tasks || {}).some(v => v && v.trim())
      || Object.values(d.done || {}).some(Boolean)
      || Object.values(d.notes || {}).some(hasNotes)
      || (d.extras || []).length > 0
      || !!d.order || !!d.rolled;
    if (!has) delete state.days[k];
  }
  const local = toKV(state);
  for (const k of new Set([...Object.keys(local), ...Object.keys(synced)])) {
    if (local[k] !== synced[k]) dirty.add(k);
  }
  writeCache();
  updateTitle();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}
function updateTitle() {
  const d = state.days[today()];
  const left = d ? dayItems(d).filter(h => !d.done[h.id]).length : active().length;
  document.title = left ? `(${left}) 日序` : '日序';
}
const day = k => {
  const d = (state.days[k] ??= { tasks: {}, done: {}, notes: {}, extras: [] });
  d.notes ??= {};
  d.extras ??= [];
  return d;
};
const active = () => state.habits.filter(h => !h.archived);
const habitNotes = id => { const h = state.habits.find(x => x.id === id); return hasNotes(h?.notes) ? h.notes : ''; };
// 当天的完整顺序：固定习惯 + 临时任务（临时任务记住它排在哪个习惯后面）
function dayItems(d) {
  const ex = d.extras || [], out = [], used = new Set();
  if (d.order) {
    // 当天单独调整过顺序
    const byId = new Map([
      ...active().map(h => [h.id, { id: h.id, name: h.name }]),
      ...ex.map(e => [e.id, { id: e.id, name: e.name, extra: true, since: e.since }]),
    ]);
    for (const id of d.order) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
    return [...out, ...byId.values()];
  }
  const push = e => { out.push({ id: e.id, name: e.name, extra: true, since: e.since }); used.add(e.id); };
  ex.filter(e => e.after === null).forEach(push);
  for (const h of active()) {
    out.push({ id: h.id, name: h.name });
    ex.filter(e => e.after === h.id).forEach(push);
  }
  ex.filter(e => !used.has(e.id)).forEach(push);
  return out;
}
// 以前写过的内容（去重，最近的在前）
function recentTasks(id) {
  const out = [], seen = new Set();
  for (const k of Object.keys(state.days).filter(k => k !== cur).sort().reverse()) {
    const t = (state.days[k].tasks?.[id] || '').trim();
    if (t && !seen.has(t)) { seen.add(t); out.push({ text: t, date: k }); }
    if (out.length >= 10) break;
  }
  return out;
}
function recentExtras() {
  const out = [], seen = new Set((day(cur).extras || []).map(e => e.name.trim()));
  for (const k of Object.keys(state.days).filter(k => k !== cur).sort().reverse()) {
    for (const e of state.days[k].extras || []) {
      const t = (e.name || '').trim();
      if (t && !seen.has(t)) { seen.add(t); out.push({ text: t, date: k }); }
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}
function pickMenu(btn, options, onPick) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = `<div class="menu-title">复用以前的内容</div>` + (options.length
    ? options.map((o, i) => `<button data-i="${i}"><span>${esc(o.text)}</span><em>${rel(o.date)}</em></button>`).join('')
    : '<div class="menu-empty">还没有用过的内容</div>');
  document.body.append(m);
  const r = btn.getBoundingClientRect();
  m.style.top = `${r.bottom + scrollY + 4}px`;
  m.style.left = `${Math.max(8, r.right + scrollX - m.offsetWidth)}px`;
  const close = () => { m.remove(); document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc_); };
  const out = e => { if (!m.contains(e.target) && e.target !== btn) close(); };
  const esc_ = e => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc_); });
  m.querySelectorAll('button').forEach(b => b.onclick = () => { close(); onPick(options[+b.dataset.i].text); });
}
const lastTask = (id, before) => {
  const keys = Object.keys(state.days).filter(k => k < before).sort().reverse();
  for (const k of keys) { const t = state.days[k].tasks?.[id]; if (t && t.trim()) return t; }
  return '';
};

/* ---------- 没完成的延续到新的一天 ---------- */
function rollover() {
  const t = today(), td = day(t);
  if (td.rolled) return;
  td.rolled = true;
  const prevKey = Object.keys(state.days).filter(k => k < t).sort().pop();
  if (prevKey) {
    const P = state.days[prevKey], pn = P.notes || {}, pd = P.done || {};
    // 习惯本身每天都有；没完成的具体内容和详情带过来
    for (const h of active()) {
      if (pd[h.id]) continue;
      const task = (P.tasks?.[h.id] || '').trim(), note = pn[h.id];
      if (!task && !hasNotes(note)) continue;
      if ((td.tasks[h.id] || '').trim() || hasNotes(td.notes[h.id])) continue;
      if (task) td.tasks[h.id] = P.tasks[h.id];
      if (hasNotes(note)) td.notes[h.id] = note;
      (td.carried ??= {})[h.id] = P.carried?.[h.id] || prevKey;
    }
    // 没完成的临时任务整条带过来
    for (const e of P.extras || []) {
      if (pd[e.id]) continue;
      const root = e.root || e.id;
      if (td.extras.some(x => (x.root || x.id) === root)) continue;
      const nid = 'x' + uid();
      td.extras.push({ id: nid, name: e.name, after: '__end', root, since: e.since || prevKey });
      if (hasNotes(pn[e.id])) td.notes[nid] = pn[e.id];
    }
  }
  save();
}
// 打勾；如果是补完以前的，把已经延续到后面几天的那份去掉
function toggleDone(k, id) {
  const d = day(k);
  d.done[id] = !d.done[id];
  if (d.done[id]) {
    const ex = d.extras.find(e => e.id === id);
    for (const k2 of Object.keys(state.days).filter(x => x > k)) {
      const d2 = state.days[k2];
      if (ex) {
        const root = ex.root || ex.id;
        const gone = (d2.extras || []).filter(e => (e.root || e.id) === root && !d2.done?.[e.id]);
        if (gone.length) {
          d2.extras = d2.extras.filter(e => !gone.includes(e));
          gone.forEach(e => { delete d2.notes?.[e.id]; });
        }
      } else if (d2.carried?.[id] && !d2.done?.[id] && (d2.tasks?.[id] || '') === (d.tasks[id] || '')) {
        delete d2.tasks[id]; delete d2.carried[id];
        if (d2.notes?.[id] === d.notes[id]) delete d2.notes[id];
      }
    }
  }
  save();
}

/* ---------- 图片：单独存储，笔记里只放引用 ---------- */
const imgCache = new Map();
const imgPath = id => `${user.id}/${id}`;
async function compress(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const toBlob = (t, q) => new Promise(r => c.toBlob(r, t, q));
  let blob = await toBlob('image/webp', 0.82);
  if (!blob || blob.type !== 'image/webp') {
    // iPhone 的 Safari 不支持 webp，改用 jpeg（先铺白底，透明处不会变黑）
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    blob = await toBlob('image/jpeg', 0.85);
  }
  return blob;
}
async function storeImage(file) {
  const id = uid(), blob = await compress(file);
  const { error } = await sb.storage.from('images').upload(imgPath(id), blob, { contentType: blob.type });
  if (error) { alert('图片上传失败，检查一下网络。'); throw error; }
  imgCache.set(id, URL.createObjectURL(blob));
  return id;
}
async function hydrate(root) {
  const imgs = [...root.querySelectorAll('img[data-img]')];
  const need = [...new Set(imgs.map(i => i.dataset.img).filter(id => !imgCache.has(id)))];
  if (need.length && navigator.onLine) {
    const { data } = await sb.storage.from('images').createSignedUrls(need.map(imgPath), 60 * 60 * 24);
    (data || []).forEach((r, i) => { if (r.signedUrl) imgCache.set(need[i], r.signedUrl); });
  }
  imgs.forEach(i => { const src = imgCache.get(i.dataset.img); if (src && i.src !== src) i.src = src; });
}
function usedImages() {
  const used = new Set();
  const notes = [
    ...state.habits.map(h => h.notes || ''),
    ...Object.values(state.days).flatMap(d => Object.values(d.notes || {})),
  ];
  for (const html of notes)
    for (const m of String(html).matchAll(/data-img="([a-z0-9]+)"/g)) used.add(m[1]);
  return used;
}
async function gcImages() {
  // 只删一天前上传、并且已经没有任何笔记引用的图片
  if (dirty.size) return;
  const { data } = await sb.storage.from('images').list(user.id, { limit: 1000 });
  const used = usedImages(), old = Date.now() - 864e5;
  const dead = (data || []).filter(f => !used.has(f.name) && new Date(f.created_at).getTime() < old).map(f => imgPath(f.name));
  if (dead.length) sb.storage.from('images').remove(dead);
}
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

/* ---------- 富文本：只保留安全的标签 ---------- */
const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI']);
function clean(html) {
  const src = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html').body.firstChild;
  const out = document.createElement('div');
  (function walk(from, to) {
    for (const n of from.childNodes) {
      if (n.nodeType === 3) { to.append(n.textContent); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (t === 'BR') { to.append(document.createElement('br')); continue; }
      if (t === 'IMG') {
        const id = n.getAttribute('data-img');
        if (id && /^[a-z0-9]+$/.test(id)) { const i = document.createElement('img'); i.dataset.img = id; to.append(i); }
        continue;
      }
      if (t === 'A') {
        const h = n.getAttribute('href') || '';
        if (/^https?:\/\//i.test(h)) { const a = document.createElement('a'); a.href = h; walk(n, a); to.append(a); }
        else walk(n, to);
        continue;
      }
      if (t === 'DIV' || t === 'P') { const d = document.createElement('div'); walk(n, d); to.append(d); continue; }
      if (KEEP.has(t)) { const e = document.createElement(t); walk(n, e); to.append(e); continue; }
      walk(n, to);
    }
  })(src, out);
  return out.innerHTML;
}
function serialize(ed) {
  const c = ed.cloneNode(true);
  c.querySelectorAll('img').forEach(i => i.removeAttribute('src'));
  return clean(c.innerHTML);
}
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const linkify = t => esc(t).replace(URL_RE, u => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>');

function openLink(url) { window.open(url, '_blank', 'noopener'); }

function lightbox(img, onDelete) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${img.src}"><div class="lb-bar">
    ${onDelete ? '<button class="lb-del">删除图片</button>' : ''}<button class="lb-close">关闭</button></div>`;
  document.body.append(box);
  const close = () => box.remove();
  box.onclick = e => { if (e.target === box) close(); };
  box.querySelector('.lb-close').onclick = close;
  box.querySelector('.lb-del')?.addEventListener('click', () => { onDelete(); close(); });
}

/* ---------- 详情编辑器 ---------- */
function bindView(v) {
  hydrate(v);
  v.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a) { e.preventDefault(); openLink(a.href); }
    else if (e.target.tagName === 'IMG') lightbox(e.target);
  });
}

// get/set：读写这段笔记；fullUrl：弹窗里选图时跳转的全屏页面
function mountEditor(wrap, { get, set, onSave, fullUrl }) {
  const ed = wrap.querySelector('.editor');
  const linkbar = wrap.querySelector('.linkbar');
  const linkInput = linkbar.querySelector('input');
  const file = wrap.querySelector('input[type=file]');
  let saved = null;

  ed.innerHTML = hasNotes(get()) ? clean(get()) : '';
  hydrate(ed);

  const persist = () => {
    set(serialize(ed));
    save();
    onSave?.();
  };
  const keepSel = () => {
    const s = getSelection();
    if (s.rangeCount && ed.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
  };
  const restoreSel = () => {
    ed.focus();
    if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
    else { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  };
  const insertImages = async files => {
    for (const f of files) {
      const imgId = await storeImage(f);
      restoreSel();
      document.execCommand('insertHTML', false, `<img data-img="${imgId}" src="${imgCache.get(imgId)}"><br>`);
      keepSel();
    }
    persist();
  };

  ed.addEventListener('input', persist);
  ed.addEventListener('keyup', keepSel);
  ed.addEventListener('pointerup', keepSel);
  ed.addEventListener('blur', keepSel);
  ed.addEventListener('paste', e => {
    e.preventDefault();
    const imgs = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
    if (imgs.length) { keepSel(); insertImages(imgs); return; }
    document.execCommand('insertHTML', false, linkify(e.clipboardData.getData('text/plain')));
  });
  ed.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  ed.addEventListener('drop', e => {
    const imgs = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) saved = r;
    insertImages(imgs);
  });
  ed.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a) { e.preventDefault(); openLink(a.href); return; }
    if (e.target.tagName === 'IMG') lightbox(e.target, () => { e.target.remove(); persist(); });
  });

  wrap.querySelectorAll('.tools button').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); keepSel(); }));
  wrap.querySelector('[data-act=link]').onclick = () => {
    linkbar.hidden = !linkbar.hidden;
    if (!linkbar.hidden) { linkInput.value = ''; linkInput.focus(); }
  };
  const addLink = () => {
    let url = linkInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    restoreSel();
    const s = getSelection();
    if (s.rangeCount && !s.getRangeAt(0).collapsed) document.execCommand('createLink', false, url);
    else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
    linkbar.hidden = true;
    persist();
  };
  linkbar.querySelector('button').onclick = addLink;
  linkInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } if (e.key === 'Escape') linkbar.hidden = true; };

  wrap.querySelector('[data-act=img]').onclick = () => {
    file.click();
  };
  file.onchange = () => { insertImages([...file.files].filter(f => f.type.startsWith('image/'))); file.value = ''; };
}

/* ---------- 视图 ---------- */
function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  updateTitle();
  ({ day: renderDay, history: renderHistory, edit: renderEdit })[view]();
}

const detailHTML = (ph = '今天的详细内容…可以直接粘贴链接、截图，或把图片拖进来', ref = '') => `
  <div class="detail">
    ${ref ? `<div class="habit-ref"><div class="ref-label">习惯说明</div><div class="notes-view">${clean(ref)}</div></div>` : ''}
    <div class="editor" contenteditable="true" data-placeholder="${ph}"></div>
    <div class="tools">
      <button data-act="link" title="选中文字后添加链接">链接</button>
      <button data-act="img">图片</button>
      <span class="tip">Ctrl+B 加粗</span>
    </div>
    <div class="linkbar" hidden><input placeholder="粘贴网址，回车插入"><button>插入</button></div>
    <input type="file" accept="image/*" multiple hidden>
  </div>`;

function renderDay() {
  const d = day(cur), hs = dayItems(d);
  const n = hs.filter(h => d.done[h.id]).length;
  const isToday = cur === today();
  app.innerHTML = `
    <div class="datebar">
      <button class="nav" data-step="-1" title="前一天">‹</button>
      <div class="date"><b>${label(cur)}</b><span>${rel(cur)}</span></div>
      <button class="nav" data-step="1" title="后一天">›</button>
    </div>
    <div class="progress"><i style="width:${hs.length ? (n / hs.length) * 100 : 0}%"></i></div>
    <div class="count">${n} / ${hs.length} 完成${d.order ? ' · <a href="#" id="resetOrder" title="这天的顺序是单独调整过的">恢复默认顺序</a>' : ''}${isToday ? '' : ' · <a href="#" id="goToday">回到今天</a>'}</div>
    <ol class="list" id="list">${hs.map((h, i) => {
      const x = h.extra;
      const since = x ? h.since : d.carried?.[h.id];
      const last = x ? '' : lastTask(h.id, cur);
      const open = openSet.has(h.id);
      return `
      <li data-id="${h.id}" class="${d.done[h.id] ? 'done' : ''} ${x ? 'extra' : ''}">
        <span class="handle" title="拖动排序">⋮⋮</span>
        <button class="check" title="完成">${d.done[h.id] ? '✓' : i + 1}</button>
        <div class="body">
          <div class="head">
            ${x ? `<input class="xname nav-input" value="${esc(h.name)}" placeholder="临时任务">`
                : `<div class="name">${esc(h.name)}</div>`}
            <div class="acts">
              ${since ? `<span class="tag carry" title="${label(since)} 开始，还没完成">延续 · ${rel(since)}</span>`
                : x ? '<span class="tag">临时</span>' : ''}
              <button class="more ${hasNotes(d.notes[h.id]) ? 'has' : ''} ${!x && hasNotes(habitNotes(h.id)) ? 'ref' : ''} ${open ? 'open' : ''}" title="详细内容">详情</button>
              ${x ? '<button class="del" title="删除这个临时任务">✕</button>' : ''}
            </div>
          </div>
          ${x ? '' : `<div class="task-row"><input class="task nav-input" value="${esc(d.tasks[h.id] || '')}"
            placeholder="${esc(last ? '上次：' + last : '今天具体做什么…')}" data-last="${esc(last)}">
            ${last ? '<button class="reuse" title="复用以前的内容">↺</button>' : ''}</div>`}
          ${open ? detailHTML(undefined, x ? '' : habitNotes(h.id)) : ''}
        </div>
      </li>`;
    }).join('')}</ol>
    <div class="add-row"><span>＋</span><input id="newTask" placeholder="添加临时任务，回车">
      ${recentExtras().length ? '<button class="reuse" id="reuseExtra" title="复用以前的临时任务">↺</button>' : ''}</div>
    ${!state.habits.length && Object.keys(state.days).length <= 1 ? `<div class="welcome">
      <b>还没有数据</b><p>到「习惯」页底部点「导入」，选插件导出的 JSON 文件，就能把以前的数据搬过来。或者直接在「习惯」里添加新的。</p>
      <button class="primary" id="goImport">去导入</button></div>` : ''}`;

  app.querySelectorAll('.nav').forEach(b => b.onclick = () => { cur = addDays(cur, +b.dataset.step); render(); });
  $('#goImport')?.addEventListener('click', () => { view = 'edit'; render(); });
  $('#goToday')?.addEventListener('click', e => { e.preventDefault(); cur = today(); render(); });
  $('#resetOrder')?.addEventListener('click', e => { e.preventDefault(); delete day(cur).order; save(); render(); });

  const list = $('#list');
  const inputs = [...list.querySelectorAll('.nav-input')];
  list.querySelectorAll('li').forEach(li => {
    const id = li.dataset.id;
    li.querySelector('.check').onclick = () => { toggleDone(cur, id); render(); };
    if (li.classList.contains('extra')) {
      const ex = day(cur).extras.find(e => e.id === id);
      const nm = li.querySelector('.xname');
      nm.oninput = () => { ex.name = nm.value; save(); };
      li.querySelector('.del').onclick = () => {
        const dd = day(cur);
        dd.extras = dd.extras.filter(e => e.id !== id);
        delete dd.tasks[id]; delete dd.done[id]; delete dd.notes[id];
        openSet.delete(id); save(); render();
      };
    }
    li.querySelector('.more').onclick = () => {
      openSet.has(id) ? openSet.delete(id) : openSet.add(id);
      render();
      if (openSet.has(id)) $(`li[data-id="${id}"] .editor`)?.focus();
    };
    const inp = li.querySelector('.nav-input');
    const i = inputs.indexOf(inp);
    if (inp.classList.contains('task')) inp.oninput = () => { const dd = day(cur); dd.tasks[id] = inp.value; if (dd.carried) delete dd.carried[id]; save(); };
    inp.onkeydown = e => {
      if (e.key === 'Tab' && !e.shiftKey && !inp.value && inp.dataset.last) {
        e.preventDefault(); inp.value = inp.dataset.last; inp.oninput();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) li.querySelector('.check').click();
        else (inputs[i + 1] || $('#newTask')).focus();
      }
    };
    const rb = li.querySelector('.reuse');
    if (rb) rb.onclick = () => pickMenu(rb, recentTasks(id), t => { inp.value = t; inp.oninput(); inp.focus(); });
    const det = li.querySelector('.detail');
    if (det) {
      mountEditor(det, {
        get: () => day(cur).notes[id],
        set: v => { day(cur).notes[id] = v; },
        onSave: () => li.querySelector('.more').classList.toggle('has', hasNotes(day(cur).notes[id])),
        fullUrl: `popup.html?full=1&date=${cur}&open=${id}`,
      });
      det.querySelectorAll('.habit-ref .notes-view').forEach(bindView);
    }
  });
  const nt = $('#newTask');
  const addExtra = name => {
    const dd = day(cur);
    dd.extras.push({ id: 'x' + uid(), name, after: '__end' });
    save(); render(); $('#newTask').focus();
  };
  nt.onkeydown = e => { if (e.key === 'Enter' && nt.value.trim()) addExtra(nt.value.trim()); };
  const rx = $('#reuseExtra');
  if (rx) rx.onclick = () => pickMenu(rx, recentExtras(), addExtra);
  // 今日里拖动：只改这一天的顺序
  enableDrag(list, seq => { day(cur).order = seq; save(); render(); });
  const firstEmpty = inputs.find(x => !x.value && !x.closest('li').classList.contains('done'));
  if (isToday && firstEmpty && !isFull && !openSet.size) firstEmpty.focus();
}

// 轻微震动：安卓用 vibrate；iPhone（iOS 18+）用开关控件触发系统触感，不支持时什么都不做
const haptic = (() => {
  let lbl = null;
  return () => {
    try {
      if (navigator.vibrate) { navigator.vibrate(8); return; }
      if (!lbl) {
        lbl = document.createElement('label');
        lbl.style.cssText = 'position:fixed;left:-99px;top:0;opacity:0;pointer-events:none';
        const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', '');
        lbl.append(i); document.body.append(lbl);
      }
      lbl.click();
    } catch {}
  };
})();

// 排序：电脑上拖 ⋮⋮；手机上按住卡片任意位置约 0.3 秒，然后拖
function enableDrag(list, onEnd) {
  const ids = () => [...list.children].map(c => c.dataset.id).filter(Boolean);
  // 拖动时不移动 DOM：卡片 1:1 跟手，其他卡片用弹簧动画让位，松手后弹回落位
  const session = (item, startY) => {
    const els = [...list.children].filter(c => c.dataset.id);
    const from = els.indexOf(item);
    const rects = els.map(e => e.getBoundingClientRect());
    const space = els.length > 1 ? rects[1].top - rects[0].bottom : 0;
    const h = rects[from].height + space;
    const center0 = rects[from].top + rects[from].height / 2;
    const scroll0 = scrollY;
    let y = startY, to = from, ended = false, done = null;

    // 每张卡片一个弹簧：位置 y、缩放 s
    const st = new Map(els.map(e => [e, { y: 0, vy: 0, ty: 0, s: 1, vs: 0, ts: 1 }]));
    const me = st.get(item);
    me.ts = 1.045;
    if (item.classList.contains('pressing') || getComputedStyle(item).scale !== 'none') me.s = parseFloat(getComputedStyle(item).scale) || 1;
    document.body.classList.add('is-dragging');
    item.classList.add('dragging');
    els.forEach(e => { e.style.transition = 'none'; });
    haptic();

    const step = (o, k, z, dt) => {
      const c = 2 * z * Math.sqrt(k);
      o.vy += (-k * (o.y - o.ty) - c * o.vy) * dt; o.y += o.vy * dt;
    };
    let last = performance.now();
    const frame = now => {
      const dt = Math.min((now - last) / 1000, 1 / 30); last = now;
      // 边缘自动滚动
      if (!ended) {
        const edge = 90;
        const v = y < edge ? -(edge - y) / 5 : y > innerHeight - edge ? (y - innerHeight + edge) / 5 : 0;
        if (v) { scrollBy(0, v); retarget(); }
      }
      let busy = false;
      for (const [e, o] of st) {
        if (e === item && !ended) { o.y = o.ty; o.vy = 0; }        // 拖着的卡片紧贴手指
        else step(o, ended && e === item ? 420 : 520, ended && e === item ? .78 : .72, dt);
        const cs = 2 * .55 * Math.sqrt(700);                         // 起飞/落下时的缩放带一点回弹
        o.vs += (-700 * (o.s - o.ts) - cs * o.vs) * dt; o.s += o.vs * dt;
        e.style.translate = Math.abs(o.y) < .05 ? '' : `0 ${o.y.toFixed(2)}px`;
        e.style.scale = Math.abs(o.s - 1) < .0005 ? '' : o.s.toFixed(4);
        if (Math.abs(o.y - o.ty) > .3 || Math.abs(o.vy) > 3 || Math.abs(o.s - o.ts) > .001 || Math.abs(o.vs) > .01) busy = true;
      }
      if (ended && !busy) return done();
      requestAnimationFrame(frame);
    };
    const retarget = () => {
      const dy = y - startY + (scrollY - scroll0);
      me.ty = dy;
      const c = center0 + dy;
      let t = from;
      for (let i = from + 1; i < els.length; i++) if (c > rects[i].top + rects[i].height / 2) t = i;
      for (let i = from - 1; i >= 0; i--) if (c < rects[i].top + rects[i].height / 2) t = i;
      if (t !== to) { to = t; haptic(); }
      els.forEach((e, i) => {
        if (e === item) return;
        st.get(e).ty = from < to && i > from && i <= to ? -h : to < from && i >= to && i < from ? h : 0;
      });
    };
    requestAnimationFrame(frame);

    return {
      move(ny) { y = ny; retarget(); },
      end() {
        ended = true;
        let land = 0;
        if (to > from) for (let i = from + 1; i <= to; i++) land += rects[i].height + space;
        if (to < from) for (let i = to; i < from; i++) land -= rects[i].height + space;
        me.ty = land; me.ts = 1;
        haptic();
        done = () => {
          els.forEach(e => { e.style.translate = ''; e.style.scale = ''; });
          item.classList.remove('dragging');
          document.body.classList.remove('is-dragging');
          if (to !== from) {
            const seq = els.map(e => e.dataset.id);
            seq.splice(to, 0, seq.splice(from, 1)[0]);
            onEnd(seq);
          }
          requestAnimationFrame(() => els.forEach(e => { e.style.transition = ''; }));
        };
      },
    };
  };

  // 电脑：鼠标拖手柄
  list.querySelectorAll('.handle').forEach(h => {
    h.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button > 0) return;
      const item = h.closest('[data-id]');
      if (!item || item.parentElement !== list) return;
      e.preventDefault();
      const s = session(item, e.clientY);
      const move = ev => s.move(ev.clientY);
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); s.end(); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  });

  // 手机：长按卡片
  [...list.children].filter(c => c.dataset.id).forEach(item => {
    let timer = null, s = null, sx = 0, sy = 0;
    item.addEventListener('touchstart', e => {
      if (e.touches.length > 1 || e.target.closest('.detail, .editor') || e.target === document.activeElement) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      item.classList.add('pressing');
      timer = setTimeout(() => {
        timer = null;
        document.activeElement?.blur?.();
        s = session(item, sy);
        item.classList.remove('pressing');
      }, 200);
    }, { passive: true });
    item.addEventListener('touchmove', e => {
      const t = e.touches[0];
      if (s) { e.preventDefault(); s.move(t.clientY); return; }
      if (timer && (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8)) { clearTimeout(timer); timer = null; item.classList.remove('pressing'); }  // 是在滚动
    }, { passive: false });
    const finish = e => {
      item.classList.remove('pressing');
      if (timer) { clearTimeout(timer); timer = null; }
      if (!s) return;
      e.preventDefault();               // 拖完不要触发点击 / 聚焦输入框
      const done = s; s = null; done.end();
    };
    item.addEventListener('touchend', finish, { passive: false });
    item.addEventListener('touchcancel', finish, { passive: false });
    item.addEventListener('contextmenu', e => e.preventDefault());
  });
}

function renderHistory() {
  const keys = Object.keys(state.days).sort().reverse();
  const hs = state.habits;
  const blocks = keys.map(k => {
    const d = state.days[k];
    const items = [...hs, ...(d.extras || []).map(e => ({ ...e, extra: true }))];
    const rows = items
      .filter(h => (filter === 'all' || h.id === filter || (filter === '__extra' && h.extra))
        && (h.extra || (d.tasks[h.id] || '').trim() || d.done[h.id] || hasNotes(d.notes?.[h.id])))
      .map(h => `<div class="row">
        <span class="m ${d.done[h.id] ? '' : 'no'}">${d.done[h.id] ? '✓' : '○'}</span>
        <span class="n">${h.extra ? '<i class="tag">临时</i>' : esc(h.name)}</span>
        <div class="t">${esc(h.extra ? h.name : d.tasks[h.id] || '')}
          ${hasNotes(d.notes?.[h.id]) ? `<div class="notes-view">${clean(d.notes[h.id])}</div>` : ''}
        </div></div>`).join('');
    return rows ? `<div class="dayblock"><h4 data-k="${k}">${label(k)} · ${rel(k)}</h4>${rows}</div>` : '';
  }).filter(Boolean);
  const doneDays = filter === 'all' || filter === '__extra' ? null : keys.filter(k => state.days[k].done[filter]).length;

  app.innerHTML = `
    <div class="filter">
      <select id="f">
        <option value="all">全部</option>
        <option value="__extra" ${filter === '__extra' ? 'selected' : ''}>临时任务</option>
        ${hs.map(h => `<option value="${h.id}" ${filter === h.id ? 'selected' : ''}>${esc(h.name)}${h.archived ? '（已删除）' : ''}</option>`).join('')}
      </select>
      ${doneDays !== null ? `<span>完成 ${doneDays} 天</span>` : ''}
    </div>
    ${blocks.join('') || '<p class="empty">还没有记录。</p>'}`;
  $('#f').onchange = e => { filter = e.target.value; render(); };
  app.querySelectorAll('h4[data-k]').forEach(h => h.onclick = () => { cur = h.dataset.k; view = 'day'; render(); });
  app.querySelectorAll('.notes-view').forEach(bindView);
}

function renderEdit() {
  const hs = active(), archived = state.habits.filter(h => h.archived);
  app.innerHTML = `
    <p class="hint">拖动 ⋮⋮ 设置每天的默认顺序。在「今日」里拖动只改当天。</p>
    <div id="rows">${hs.map(h => `
      <div class="habit-item" data-id="${h.id}">
        <div class="edit-row">
          <span class="handle" title="拖动调整默认顺序">⋮⋮</span>
          <input value="${esc(h.name)}">
          <button class="note-btn ${hasNotes(h.notes) ? 'has' : ''} ${openSet.has(h.id) ? 'open' : ''}" title="长期说明">说明</button>
          <button class="x" title="删除">✕</button>
        </div>
        ${openSet.has(h.id) ? detailHTML('长期说明：步骤、参考链接、示例图…每天展开「详情」时都会显示') : ''}
      </div>`).join('')}</div>
    <div class="edit-row">
      <input id="newName" placeholder="新习惯名称，回车添加">
      <button class="primary" id="add">添加</button>
    </div>
    ${archived.length ? `<div class="section"><h5>已删除</h5>${archived.map(h =>
      `<span class="chip">${esc(h.name)}<button data-restore="${h.id}">恢复</button></span>`).join('')}</div>` : ''}
    <div class="section">
      <h5>备份（含图片）</h5>
      <div class="btns"><button id="export">导出 JSON</button><button id="import">导入</button></div>
      <input type="file" id="file" accept=".json" hidden>
    </div>
    <div class="section">
      <h5>账号</h5>
      <div class="btns"><span class="who">${esc(user.email)}</span><button id="logout">退出登录</button></div>
    </div>`;

  app.querySelectorAll('#rows .habit-item').forEach(item => {
    const h = state.habits.find(x => x.id === item.dataset.id);
    const inp = item.querySelector('.edit-row input');
    const nb = item.querySelector('.note-btn');
    inp.oninput = () => { h.name = inp.value; save(); };
    item.querySelector('.x').onclick = () => { h.archived = true; save(); render(); };
    nb.onclick = () => {
      openSet.has(h.id) ? openSet.delete(h.id) : openSet.add(h.id);
      render();
      if (openSet.has(h.id)) $(`.habit-item[data-id="${h.id}"] .editor`)?.focus();
    };
    const det = item.querySelector('.detail');
    if (det) mountEditor(det, {
      get: () => h.notes,
      set: v => { h.notes = v; },
      onSave: () => nb.classList.toggle('has', hasNotes(h.notes)),
      fullUrl: `popup.html?full=1&view=edit&open=${h.id}`,
    });
  });
  enableDrag($('#rows'), seq => {
    state.habits = [...seq.map(id => state.habits.find(h => h.id === id)), ...state.habits.filter(h => h.archived)];
    save(); render();
  });
  const add = () => {
    const name = $('#newName').value.trim();
    if (!name) return;
    state.habits.splice(active().length, 0, { id: uid(), name });
    save(); render(); $('#newName').focus();
  };
  $('#add').onclick = add;
  $('#newName').onkeydown = e => { if (e.key === 'Enter') add(); };
  app.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => {
    const h = state.habits.find(x => x.id === b.dataset.restore);
    h.archived = false;
    state.habits = [...active().filter(x => x !== h), h, ...state.habits.filter(x => x.archived)];
    save(); render();
  });
  $('#export').onclick = async () => {
    const out = { habits: state.habits, days: state.days };
    for (const id of usedImages()) {
      const { data } = await sb.storage.from('images').download(imgPath(id));
      if (data) out['img:' + id] = await blobToDataURL(data);
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `rixu-${today()}.json` });
    a.click();
  };
  $('#import').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    let data;
    try {
      data = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(data.habits) || typeof data.days !== 'object') throw 0;
    } catch { alert('文件格式不对。'); return; }
    if (!confirm('导入会覆盖云端现在的所有数据，继续吗？')) return;
    await importData(data);
  };
  $('#logout').onclick = async () => {
    if (dirty.size && !confirm('还有改动没同步，确定退出？')) return;
    await sb.auth.signOut();
    localStorage.removeItem(CACHE);
    location.reload();
  };
}

async function importData(data) {
  setSync('导入中…');
  try {
    const imgs = Object.keys(data).filter(k => k.startsWith('img:'));
    for (const k of imgs) {
      const blob = await (await fetch(data[k])).blob();
      const { error } = await sb.storage.from('images').upload(imgPath(k.slice(4)), blob, { contentType: blob.type });
      if (error && !/exists|duplicate/i.test(error.message || '')) throw error;   // 以前导入过的图片跳过
    }
    const { error } = await sb.from('kv').delete().eq('user_id', user.id);
    if (error) throw error;
    state = { habits: data.habits, days: data.days };
    normalize();
    synced = {}; dirty = new Set(Object.keys(toKV(state)));
    imgCache.clear();
    await flush();
    rollover(); render();
    alert(`导入完成：${state.habits.filter(h => !h.archived).length} 个习惯，${Object.keys(state.days).length} 天记录，${imgs.length} 张图片。`);
  } catch (err) { console.error(err); alert('导入失败：' + (err.message || err)); setSync('导入失败', 'err'); }
}

/* ---------- 登录 ---------- */
function showLogin(msg = '') {
  document.body.classList.add('login-mode');
  app.innerHTML = `
    <form class="login" id="login">
      <h1>日序</h1>
      <p>登录后，电脑和手机的数据会自动同步。</p>
      <input type="email" id="email" placeholder="邮箱" autocomplete="username" required>
      <input type="password" id="pw" placeholder="密码" autocomplete="current-password" required>
      <button class="primary" type="submit">登录</button>
      <div class="err">${esc(msg)}</div>
    </form>`;
  $('#login').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = '登录中…';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#pw').value });
    if (error) return showLogin(error.message.includes('Invalid') ? '邮箱或密码不对。' : error.message);
    start(data.user);
  };
}

async function start(u) {
  user = u;
  document.body.classList.remove('login-mode');
  if (readCache()) render();
  else { app.innerHTML = '<p class="empty">加载中…</p>'; }
  await pull();
  rollover(); render();
  setTimeout(gcImages, 5000);
}

/* ---------- 启动 ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
const typing = () => { const el = document.activeElement; return el && (el.tagName === 'INPUT' || el.isContentEditable); };
async function refresh() {
  if (!user || document.hidden) return;
  let changed = await pull();
  if (!state.days[today()]?.rolled) { rollover(); changed = true; }  // 过了零点
  if (changed && !typing()) render();
}
document.addEventListener('visibilitychange', refresh);
window.addEventListener('online', refresh);
window.addEventListener('offline', () => setSync('离线', 'off'));
setInterval(refresh, 60000);
window.addEventListener('beforeunload', e => { if (dirty.size) { flush(); e.preventDefault(); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
sb.auth.getSession().then(({ data }) => data.session ? start(data.session.user) : showLogin());
