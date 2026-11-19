/* «Залог» — акт приёма квартиры. Прототип на vanilla JS. */
'use strict';

/* ============================ утилиты ============================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const nowISO = () => new Date().toISOString();
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtT = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
const num = (n) => (typeof n === 'number' ? String(n).replace('.', ',') : '');
const fmtVal = (v) => String(v == null ? '' : v).replace('.', ',');

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2800);
}

/* ============================ хранилище ============================ */
const DB_NAME = 'zalog.v1';
const ST_ACTS = 'acts';
const ST_PHOTOS = 'photos';
let _db = null;

function db() {
  return new Promise((res, rej) => {
    if (_db) return res(_db);
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(ST_ACTS)) d.createObjectStore(ST_ACTS, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(ST_PHOTOS)) d.createObjectStore(ST_PHOTOS, { keyPath: 'id' });
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readonly');
    const q = t.objectStore(store).get(key);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
}
async function idbPut(store, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).put(val);
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error);
  });
}
async function idbAll(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readonly');
    const q = t.objectStore(store).getAll();
    q.onsuccess = () => res(q.result || []);
    q.onerror = () => rej(q.error);
  });
}
async function idbDel(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error);
  });
}

/* фотографии держим отдельно от акта, чтобы список открывался быстро */
const PHOTO = new Map();
async function photoPut(id, dataUrl) { await idbPut(ST_PHOTOS, { id, data: dataUrl }); PHOTO.set(id, dataUrl); }
async function photoEnsure(a) {
  const ids = [];
  a.rooms.forEach(r => r.frames.forEach(f => { if (f.photo) ids.push(f.photo.id); }));
  a.defects.forEach(d => { if (d.photo) ids.push(d.photo.id); });
  a.meters.forEach(m => { if (m.photo) ids.push(m.photo.id); });
  await Promise.all(ids.filter(id => !PHOTO.has(id)).map(async id => {
    const rec = await idbGet(ST_PHOTOS, id);
    if (rec) PHOTO.set(id, rec.data);
  }));
}

/* ============================ хеш и геометка ============================ */
async function sha256(str) {
  if (window.crypto && crypto.subtle) {
    const buf = new TextEncoder().encode(str);
    const dg = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(dg)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'fnv1a' + h.toString(16).padStart(8, '0');
}

function geoGet() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      p => resolve({
        lat: Math.round(p.coords.latitude * 1e6) / 1e6,
        lng: Math.round(p.coords.longitude * 1e6) / 1e6,
        acc: Math.round(p.coords.accuracy || 0)
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 20000 }
    );
  });
}

/* ============================ модель ============================ */
const ROOM_TEMPLATE = [
  { key: 'hall', name: 'Прихожая', frames: [
    { label: 'Входная дверь и замки', required: true },
    { label: 'Пол и плинтусы', required: true },
    { label: 'Стены и обои', required: false },
    { label: 'Потолок', required: false }
  ] },
  { key: 'kitchen', name: 'Кухня', frames: [
    { label: 'Плита / варочная панель', required: true },
    { label: 'Холодильник', required: true },
    { label: 'Столешница и фасады', required: true },
    { label: 'Мойка и смеситель', required: false },
    { label: 'Стены, пол, потолок', required: false }
  ] },
  { key: 'room', name: 'Комната', frames: [
    { label: 'Стены и обои', required: true },
    { label: 'Пол и плинтусы', required: true },
    { label: 'Потолок', required: true },
    { label: 'Окно и подоконник', required: true },
    { label: 'Мебель и техника', required: false }
  ] },
  { key: 'bath', name: 'Санузел', frames: [
    { label: 'Сантехника (ванна, унитаз)', required: true },
    { label: 'Плитка, стены, пол', required: true },
    { label: 'Вентиляция и потолок', required: false }
  ] },
  { key: 'balcony', name: 'Балкон / лоджия', frames: [
    { label: 'Остекление и рамы', required: false },
    { label: 'Пол и стены', required: false }
  ] }
];
const METER_TEMPLATE = [
  { key: 'cold', name: 'Холодная вода', unit: 'м³' },
  { key: 'hot', name: 'Горячая вода', unit: 'м³' },
  { key: 'elec', name: 'Электричество', unit: 'кВт·ч' },
  { key: 'gas', name: 'Газ', unit: 'м³' }
];
const SEV = { low: 'незначительный', mid: 'средний', high: 'существенный' };

function newAct(f) {
  return {
    id: uid(),
    createdAt: nowISO(),
    updatedAt: nowISO(),
    startedAt: nowISO(),
    finishedAt: null,
    type: f.type,
    address: f.address,
    landlord: { name: f.landlordName, phone: f.landlordPhone },
    tenant: { name: f.tenantName, phone: f.tenantPhone },
    geo: null,
    rooms: ROOM_TEMPLATE.map(r => ({
      key: r.key, name: r.name,
      frames: r.frames.map(fr => ({ id: uid(), label: fr.label, required: fr.required, photo: null }))
    })),
    defects: [],
    meters: METER_TEMPLATE.map(m => ({ key: m.key, name: m.name, unit: m.unit, value: '', photo: null })),
    chain: '',
    signatures: { landlord: null, tenant: null },
    paid: null
  };
}

let ACTS = [];
let CUR = null;

async function loadActs() { ACTS = await idbAll(ST_ACTS); }
async function getAct(id) {
  if (CUR && CUR.id === id) return CUR;
  const a = await idbGet(ST_ACTS, id);
  if (a) { await photoEnsure(a); CUR = a; }
  return a;
}
async function saveAct(a) {
  a.updatedAt = nowISO();
  await idbPut(ST_ACTS, a);
  const i = ACTS.findIndex(x => x.id === a.id);
  if (i >= 0) ACTS[i] = a; else ACTS.push(a);
}

function framesOf(a) { return a.rooms.reduce((acc, r) => acc.concat(r.frames), []); }
function progressOf(a) {
  const f = framesOf(a);
  const done = f.filter(x => x.photo).length;
  return { done, total: f.length, pct: f.length ? Math.round(done * 100 / f.length) : 0 };
}
function missingRequired(a) { return framesOf(a).filter(f => f.required && !f.photo); }
function metersFilled(a) { return a.meters.filter(m => m.value !== '').length; }
function roomName(a, key) { const r = a.rooms.find(x => x.key === key); return r ? r.name : '—'; }
function statusOf(a) {
  if (a.paid) return { label: 'Оплачен', cls: 'paid' };
  if (a.signatures.landlord && a.signatures.tenant) return { label: 'Подписан', cls: 'ready' };
  if (a.signatures.landlord || a.signatures.tenant) return { label: 'Ждёт подписи', cls: 'wait' };
  return { label: 'Черновик', cls: 'draft' };
}

/* пересчёт контрольной цепочки по всем кадрам */
async function recomputeChain(a) {
  const items = [];
  a.rooms.forEach(r => r.frames.forEach(f => { if (f.photo) items.push(f.photo); }));
  a.defects.forEach(d => { if (d.photo) items.push(d.photo); });
  a.meters.forEach(m => { if (m.photo) items.push(m.photo); });
  items.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  let chain = 'genesis';
  for (const it of items) chain = await sha256(chain + '|' + it.hash + '|' + it.ts);
  a.chain = chain;
  if (!a.geo) a.geo = (items.find(i => i.geo) || {}).geo || null;
  if (!a.finishedAt && missingRequired(a).length === 0) a.finishedAt = nowISO();
}

/* ============================ съёмка ============================ */
const cameraEl = $('#camera');
let PENDING = null;

function shoot(job) {
  PENDING = job;
  cameraEl.value = '';
  cameraEl.click();
}

async function shrink(file) {
  const maxSide = 1600;
  let bitmap = null;
  try { bitmap = await createImageBitmap(file); } catch (e) { bitmap = null; }
  if (!bitmap) {
    bitmap = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('bad image'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = bitmap.width, h0 = bitmap.height;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  return c.toDataURL('image/jpeg', 0.82);
}

async function onCamera() {
  const file = cameraEl.files && cameraEl.files[0];
  const job = PENDING;
  PENDING = null;
  if (!file || !job) return;

  const ageMin = (Date.now() - (file.lastModified || 0)) / 60000;
  if (ageMin > 30) {
    toast('Этот снимок сделан ' + Math.round(ageMin) + ' мин назад. Для акта нужен кадр прямо сейчас.');
    return;
  }

  toast('Снимаю координаты…');
  const geo = await geoGet();
  let data;
  try { data = await shrink(file); } catch (e) { toast('Не удалось обработать снимок'); return; }

  const id = uid();
  await photoPut(id, data);
  const ts = nowISO();
  const hash = await sha256(data + '|' + ts + '|' + JSON.stringify(geo || {}));
  const photo = { id, ts, geo, hash };

  const a = CUR;
  if (job.kind === 'frame') {
    const r = a.rooms.find(x => x.key === job.room);
    const f = r && r.frames.find(x => x.id === job.frame);
    if (!f) return;
    f.photo = photo;
  } else if (job.kind === 'defect') {
    const d = a.defects.find(x => x.id === job.defect);
    if (!d) return;
    d.photo = photo;
  } else if (job.kind === 'meter') {
    const m = a.meters.find(x => x.key === job.meter);
    if (!m) return;
    m.photo = photo;
  }

  await recomputeChain(a);
  await saveAct(a);
  await render();
  toast(geo ? 'Кадр сохранён · геометка есть' : 'Кадр сохранён · без геометки');
}

/* ============================ экраны ============================ */
function appbar(title, backHash) {
  return '<header class="appbar">' +
    (backHash
      ? '<button class="back" data-act="nav" data-to="' + backHash + '" aria-label="Назад">‹</button>'
      : '<div class="brand"><span class="logo">З</span><div><b>Залог</b><small>акт приёма квартиры</small></div></div>') +
    (backHash ? '<h1>' + esc(title) + '</h1>' : '') +
    '</header>';
}

function viewList() {
  const acts = ACTS.slice().sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  const cards = acts.map(a => {
    const p = progressOf(a), st = statusOf(a);
    return '<a class="card act-card" href="#/act/' + a.id + '">' +
      '<div class="row between"><b>' + esc(a.address || 'Без адреса') + '</b><span class="badge ' + st.cls + '">' + st.label + '</span></div>' +
      '<div class="muted small" style="margin-top:4px">' + (a.type === 'in' ? 'Заселение' : 'Выезд') + ' · ' + fmtDT(a.createdAt) + '</div>' +
      '<div class="progress"><i style="width:' + p.pct + '%"></i></div>' +
      '<div class="muted small">' + p.done + ' из ' + p.total + ' кадров · дефектов: ' + a.defects.length + '</div>' +
      '</a>';
  }).join('');

  return appbar() + '<main class="wrap">' +
    '<p class="lead">Фиксируем состояние квартиры и показания счётчиков при заселении и выезде. Кадры — только с камеры, с геометкой и временем. На выходе — PDF-акт для обеих сторон.</p>' +
    '<button class="btn btn-primary btn-block btn-lg" data-act="go" data-to="#/new">Новый акт</button>' +
    (acts.length ? '<div class="section-title">Мои акты</div>' + cards : '<div class="empty">Пока пусто. Первый акт создаётся за минуту: адрес, стороны и обход по чек-листу.</div>') +
    '</main>';
}

function viewNew() {
  return appbar('Новый акт', '#/') + '<main class="wrap">' +
    '<div class="seg" id="act-type"><button class="on" data-act="type" data-type="in">Заселение</button><button data-act="type" data-type="out">Выезд</button></div>' +
    '<label class="field"><span>Адрес объекта</span><input id="f-address" type="text" placeholder="Москва, ул. Ленина, 12, кв. 34" autocomplete="off"></label>' +
    '<div class="section-title">Арендодатель</div>' +
    '<label class="field"><span>ФИО</span><input id="f-ll-name" type="text" placeholder="Иванов Иван Иванович" autocomplete="off"></label>' +
    '<label class="field"><span>Телефон</span><input id="f-ll-phone" type="tel" placeholder="+7 900 000-00-00" autocomplete="off"></label>' +
    '<div class="section-title">Арендатор</div>' +
    '<label class="field"><span>ФИО</span><input id="f-tn-name" type="text" placeholder="Петров Пётр Петрович" autocomplete="off"></label>' +
    '<label class="field"><span>Телефон</span><input id="f-tn-phone" type="tel" placeholder="+7 900 000-00-00" autocomplete="off"></label>' +
    '<button class="btn btn-primary btn-block btn-lg" data-act="create-act">Начать обход</button>' +
    '<p class="tiny muted" style="margin-top:12px">Данные хранятся на этом устройстве. Фотографии не покидают телефон, пока вы сами не отправите акт.</p>' +
    '</main>';
}

function viewAct(a) {
  const p = progressOf(a), miss = missingRequired(a), st = statusOf(a);
  const roomRows = a.rooms.map(r => {
    const done = r.frames.filter(f => f.photo).length;
    const full = done === r.frames.length;
    return '<button class="nav-row" data-act="nav" data-to="#/act/' + a.id + '/room/' + r.key + '">' +
      '<div class="ico">' + (full ? '✓' : '◻') + '</div>' +
      '<div class="txt"><b>' + esc(r.name) + '</b><small>' + done + ' из ' + r.frames.length + ' кадров</small></div>' +
      '<div class="chev">›</div></button>';
  }).join('');

  const bothSigned = a.signatures.landlord && a.signatures.tenant;

  return appbar('Акт приёма', '#/') +
    '<main class="wrap">' +
    '<div class="card">' +
      '<div class="row between"><b style="font-size:17px">' + esc(a.address || 'Без адреса') + '</b><span class="badge ' + st.cls + '">' + st.label + '</span></div>' +
      '<div class="muted small" style="margin-top:4px">' + (a.type === 'in' ? 'Заселение' : 'Выезд') + ' · начат ' + fmtDT(a.startedAt) + '</div>' +
      '<div class="progress"><i style="width:' + p.pct + '%"></i></div>' +
      '<div class="muted small">' + p.done + ' из ' + p.total + ' кадров' + (miss.length ? ' · осталось обязательных: ' + miss.length : ' · обязательные кадры собраны') + '</div>' +
    '</div>' +

    '<div class="section-title">Обход</div>' +
    '<div class="card" style="padding:2px 14px">' + roomRows + '</div>' +

    '<div class="section-title">Данные акта</div>' +
    '<div class="card" style="padding:2px 14px">' +
      '<button class="nav-row" data-act="nav" data-to="#/act/' + a.id + '/defects"><div class="ico">!</div><div class="txt"><b>Дефекты</b><small>' + (a.defects.length ? 'зафиксировано: ' + a.defects.length : 'не зафиксированы') + '</small></div><div class="chev">›</div></button>' +
      '<button class="nav-row" data-act="nav" data-to="#/act/' + a.id + '/meters"><div class="ico">◎</div><div class="txt"><b>Счётчики</b><small>заполнено ' + metersFilled(a) + ' из ' + a.meters.length + '</small></div><div class="chev">›</div></button>' +
      '<button class="nav-row" data-act="nav" data-to="#/act/' + a.id + '/sign"><div class="ico">✎</div><div class="txt"><b>Подписи сторон</b><small>' + (bothSigned ? 'подписан обеими сторонами' : 'подписано: ' + ((a.signatures.landlord ? 1 : 0) + (a.signatures.tenant ? 1 : 0)) + ' из 2') + '</small></div><div class="chev">›</div></button>' +
    '</div>' +

    '<div class="section-title">Документ</div>' +
    '<button class="btn btn-block" data-act="nav" data-to="#/act/' + a.id + '/doc">Предпросмотр акта</button>' +
    '<button class="btn btn-primary btn-block" style="margin-top:10px" data-act="print-act">' + (a.paid ? 'Скачать PDF' : 'Скачать PDF · 299 ₽') + '</button>' +
    (a.chain ? '<p class="tiny muted" style="margin-top:12px">Контрольная сумма: <span class="mono">' + a.chain.slice(0, 32) + '…</span></p>' : '') +
    '<button class="btn btn-ghost btn-block" style="margin-top:18px" data-act="del-act">Удалить акт</button>' +
    '</main>';
}

function viewRoom(a, roomKey) {
  const r = a.rooms.find(x => x.key === roomKey);
  if (!r) return viewAct(a);
  const done = r.frames.filter(f => f.photo).length;
  const cards = r.frames.map(f => {
    const ph = f.photo;
    const src = ph ? (PHOTO.get(ph.id) || '') : '';
    return '<div class="frame' + (ph ? ' filled' : '') + '" data-act="shoot" data-room="' + r.key + '" data-frame="' + f.id + '">' +
      (ph ? '<button class="del" data-act="del-photo" data-room="' + r.key + '" data-frame="' + f.id + '" aria-label="Удалить кадр">×</button>' : '') +
      '<div class="ph">' + (src ? '<img src="' + src + '" alt="">' : '📷') + '</div>' +
      '<div class="cap"><b>' + esc(f.label) + (f.required ? ' <span class="req">обязательно</span>' : '') + '</b>' +
      '<small>' + (ph ? fmtT(ph.ts) + (ph.geo ? ' · ' + num(ph.geo.lat) + ', ' + num(ph.geo.lng) : ' · без геометки') : 'Нажмите, чтобы снять') + '</small></div>' +
      '</div>';
  }).join('');

  const idx = a.rooms.findIndex(x => x.key === roomKey);
  const prev = a.rooms[idx - 1], next = a.rooms[idx + 1];

  return appbar(r.name, '#/act/' + a.id) + '<main class="wrap">' +
    '<div class="muted small">Снято ' + done + ' из ' + r.frames.length + '</div>' +
    '<div class="progress"><i style="width:' + Math.round(done * 100 / r.frames.length) + '%"></i></div>' +
    '<div class="grid2" style="margin-top:14px">' + cards + '</div>' +
    '<button class="btn btn-block" style="margin-top:16px" data-act="nav" data-to="#/act/' + a.id + '/defects">Добавить дефект в этом помещении</button>' +
    '<div class="row" style="margin-top:16px;gap:10px">' +
      (prev ? '<button class="btn" style="flex:1" data-act="nav" data-to="#/act/' + a.id + '/room/' + prev.key + '">‹ ' + esc(prev.name) + '</button>' : '') +
      (next ? '<button class="btn" style="flex:1" data-act="nav" data-to="#/act/' + a.id + '/room/' + next.key + '">' + esc(next.name) + ' ›</button>' : '') +
    '</div>' +
    '<p class="tiny muted" style="margin-top:14px">Кадр снимается камерой в момент осмотра — выбрать файл из галереи нельзя. Время и координаты записываются автоматически.</p>' +
    '</main>';
}

function viewDefects(a) {
  const opts = a.rooms.map(r => '<option value="' + r.key + '">' + esc(r.name) + '</option>').join('');
  const list = a.defects.length ? a.defects.map(d => {
    const src = d.photo ? (PHOTO.get(d.photo.id) || '') : '';
    return '<div class="card" style="padding:12px">' +
      '<div class="row between"><b style="font-size:14px">' + esc(roomName(a, d.room)) + '</b><button class="btn btn-ghost" style="padding:4px 8px;font-size:13px" data-act="del-defect" data-id="' + d.id + '">Удалить</button></div>' +
      '<div style="font-size:14px;margin:4px 0 6px">' + esc(d.desc) + '</div>' +
      '<div class="muted small">' + esc(SEV[d.sev] || '') + '</div>' +
      (src ? '<img src="' + src + '" alt="" style="width:100%;border-radius:10px;margin-top:8px;display:block">' : '<button class="btn btn-block" style="margin-top:8px" data-act="shoot-defect" data-id="' + d.id + '">Снять фото дефекта</button>') +
      '</div>';
  }).join('') : '<div class="empty">Дефектов пока нет. Если всё цело — этот раздел можно пропустить.</div>';

  return appbar('Дефекты', '#/act/' + a.id) + '<main class="wrap">' +
    '<div class="card">' +
      '<label class="field"><span>Помещение</span><select id="df-room">' + opts + '</select></label>' +
      '<label class="field"><span>Что повреждено</span><textarea id="df-desc" placeholder="Скол на ламинате у окна, 5 см; царапина на дверце шкафа"></textarea></label>' +
      '<label class="field"><span>Степень</span><select id="df-sev">' +
        '<option value="low">Незначительный — след эксплуатации</option>' +
        '<option value="mid" selected>Средний — заметное повреждение</option>' +
        '<option value="high">Существенный — влияет на залог</option>' +
      '</select></label>' +
      '<button class="btn btn-primary btn-block" data-act="save-defect">Добавить и снять фото</button>' +
    '</div>' +
    (a.defects.length ? '<div class="section-title">Зафиксировано</div>' + list : list) +
    '</main>';
}

function viewMeters(a) {
  const rows = a.meters.map(m => {
    const src = m.photo ? (PHOTO.get(m.photo.id) || '') : '';
    return '<div class="meter">' +
      '<div><b>' + esc(m.name) + '</b><small>' + esc(m.unit) + '</small></div>' +
      '<div class="val">' +
        '<input type="number" step="0.001" inputmode="decimal" id="m-' + m.key + '" data-meter="' + m.key + '" value="' + esc(m.value) + '" placeholder="0">' +
        '<button class="thumbbtn' + (src ? ' ok' : '') + '" data-act="shoot-meter" data-meter="' + m.key + '">' + (src ? '<img src="' + src + '" alt="">' : 'фото') + '</button>' +
      '</div></div>';
  }).join('');

  return appbar('Счётчики', '#/act/' + a.id) + '<main class="wrap">' +
    '<p class="lead">Показания на момент осмотра. Фото табло прикладывается к акту.</p>' +
    '<div class="card" style="padding:4px 14px">' + rows + '</div>' +
    '<button class="btn btn-primary btn-block" style="margin-top:16px" data-act="save-meters">Сохранить показания</button>' +
    '</main>';
}

function viewSign(a) {
  const box = (role, title, who) => {
    const s = a.signatures[role];
    return '<div class="signer' + (s ? ' done' : '') + '">' +
      '<div class="row between"><b style="font-size:15px">' + title + '</b><span class="st">' + (s ? 'подписано' : 'не подписано') + '</span></div>' +
      '<div class="muted small" style="margin-top:2px">' + esc(who.name || 'ФИО не указано') + (who.phone ? ' · ' + esc(who.phone) : '') + '</div>' +
      (s
        ? '<div class="tiny muted" style="margin-top:8px">ПЭП · ' + fmtDT(s.at) + ' · код ' + esc(s.code) + '</div>'
        : '<button class="btn btn-primary btn-block" style="margin-top:10px" data-act="sign-start" data-role="' + role + '">Подписать</button>') +
      '</div>';
  };

  return appbar('Подписи', '#/act/' + a.id) + '<main class="wrap">' +
    box('landlord', 'Арендодатель', a.landlord || {}) +
    box('tenant', 'Арендатор', a.tenant || {}) +
    '<p class="tiny muted">Каждая сторона подтверждает акт одноразовым кодом из СМС. В прототипе код показывается на экране — в рабочей версии его отправляет сервис. Это простая электронная подпись (ПЭП) по ст. 6 закона № 63-ФЗ: для суда фиксируется, кто, когда и с какого номера подтвердил документ.</p>' +
    '</main>';
}

function viewDoc(a) {
  return appbar('Предпросмотр', '#/act/' + a.id) + '<main class="wrap">' +
    '<div class="doc-preview"><div class="doc">' + docBody(a) + '</div></div>' +
    '<button class="btn btn-primary btn-block btn-lg" style="margin-top:16px" data-act="print-act">' + (a.paid ? 'Скачать PDF' : 'Скачать PDF · 299 ₽') + '</button>' +
    '<p class="tiny muted" style="margin-top:10px">В браузере: «Печать» → «Сохранить как PDF». Документ встаёт на A4 с фотографиями и подписями.</p>' +
    '</main>';
}

/* ============================ документ ============================ */
function docBody(a) {
  const p = progressOf(a);
  const typeLabel = a.type === 'in' ? 'при заселении' : 'при выезде';
  const geo = a.geo;

  const roomsRows = a.rooms.map((r, i) => {
    const done = r.frames.filter(f => f.photo).length;
    const names = r.frames.map(f => esc(f.label)).join('; ');
    return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + names + '</td><td>' + done + '/' + r.frames.length + '</td></tr>';
  }).join('');

  const defectRows = a.defects.length
    ? a.defects.map((d, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(roomName(a, d.room)) + '</td><td>' + esc(d.desc) + '</td><td>' + esc(SEV[d.sev] || '') + '</td></tr>').join('')
    : '<tr><td colspan="4">Повреждений не зафиксировано.</td></tr>';

  const meterRows = a.meters.map(m => '<tr><td>' + esc(m.name) + '</td><td>' + (m.value !== '' ? esc(fmtVal(m.value)) + ' ' + esc(m.unit) : '—') + '</td><td>' + (m.photo ? 'фото табло' : 'нет фото') + '</td></tr>').join('');

  const shots = [];
  a.rooms.forEach(r => r.frames.forEach(f => { if (f.photo) shots.push({ cap: r.name + ' · ' + f.label, ph: f.photo }); }));
  a.defects.forEach(d => { if (d.photo) shots.push({ cap: 'Дефект · ' + d.desc, ph: d.photo }); });
  a.meters.forEach(m => { if (m.photo) shots.push({ cap: 'Счётчик · ' + m.name, ph: m.photo }); });

  const photoGrid = shots.map((s, i) => {
    const src = PHOTO.get(s.ph.id) || '';
    return '<div class="doc-photo"><img src="' + src + '" alt="">' +
      '<div class="pc"><b>' + (i + 1) + '. ' + esc(s.cap) + '</b>' +
      fmtDT(s.ph.ts) + (s.ph.geo ? ' · ' + num(s.ph.geo.lat) + ', ' + num(s.ph.geo.lng) + ' ±' + s.ph.geo.acc + ' м' : ' · без геометки') +
      '<br>SHA-256 ' + esc(s.ph.hash.slice(0, 20)) + '…</div></div>';
  }).join('');

  const signBox = (role, title) => {
    const s = a.signatures[role];
    const who = (role === 'landlord' ? a.landlord : a.tenant) || {};
    return '<div class="sign-box"><b>' + title + '</b><br>' + esc(who.name || '____________________') +
      (who.phone ? '<br>тел. ' + esc(who.phone) : '') +
      '<div class="sl"></div><div style="font-size:9px;color:#666">подпись</div>' +
      (s ? '<div style="margin-top:6px">ПЭП, код ' + esc(s.code) + '<br>' + fmtDT(s.at) + '</div>' : '<div style="margin-top:6px;color:#777">не подписано</div>') +
      '</div>';
  };

  return '' +
    '<h2>АКТ ПРИЁМА-ПЕРЕДАЧИ ЖИЛОГО ПОМЕЩЕНИЯ</h2>' +
    '<div class="doc-sub">' + typeLabel + ' · фиксация состояния объекта и показаний приборов учёта</div>' +

    '<p><b>Дата и время составления:</b> ' + fmtDT(a.startedAt) + (a.finishedAt ? ' — ' + fmtT(a.finishedAt) : '') + '</p>' +
    '<p><b>Объект:</b> ' + esc(a.address || '____________________') + '</p>' +
    '<p><b>Место съёмки:</b> ' + (geo ? num(geo.lat) + ', ' + num(geo.lng) + ' (точность ±' + geo.acc + ' м)' : 'геометка недоступна — координаты не зафиксированы') + '</p>' +

    '<h3>1. Стороны</h3>' +
    '<table><tr><th style="width:32%">Сторона</th><th>ФИО</th><th>Телефон</th></tr>' +
    '<tr><td>Арендодатель</td><td>' + esc(a.landlord.name || '—') + '</td><td>' + esc(a.landlord.phone || '—') + '</td></tr>' +
    '<tr><td>Арендатор</td><td>' + esc(a.tenant.name || '—') + '</td><td>' + esc(a.tenant.phone || '—') + '</td></tr></table>' +

    '<h3>2. Порядок фиксации</h3>' +
    '<p class="doc-note">2.1. Осмотр проведён сторонами в указанные в акте дату и время. Состояние помещения, имущества и показания приборов учёта зафиксированы средствами мобильного приложения «Залог».</p>' +
    '<p class="doc-note">2.2. Фотоматериалы получены камерой устройства непосредственно в ходе осмотра. Загрузка изображений из памяти устройства технически исключена; каждый кадр содержит отметку времени съёмки и координаты места.</p>' +
    '<p class="doc-note">2.3. Целостность и неизменность фотоматериалов подтверждается последовательной контрольной суммой SHA-256, рассчитанной по всем кадрам акта.</p>' +
    '<p class="doc-note">2.4. Стороны подтверждают, что перечень зафиксированных повреждений является полным на дату составления акта. Повреждения, не отражённые в акте, считаются отсутствовавшими.</p>' +

    '<h3>3. Зафиксированные помещения</h3>' +
    '<table><tr><th style="width:6%">№</th><th style="width:24%">Помещение</th><th>Кадры</th><th style="width:14%">Снято</th></tr>' + roomsRows + '</table>' +
    '<p class="doc-note">Всего кадров: ' + p.done + ' из ' + p.total + '.</p>' +

    '<h3>4. Выявленные повреждения и дефекты</h3>' +
    '<table><tr><th style="width:6%">№</th><th style="width:24%">Помещение</th><th>Описание</th><th style="width:22%">Степень</th></tr>' + defectRows + '</table>' +

    '<h3>5. Показания приборов учёта</h3>' +
    '<table><tr><th style="width:40%">Прибор</th><th style="width:30%">Показание</th><th>Фотофиксация</th></tr>' + meterRows + '</table>' +

    (shots.length ? '<h3>6. Фотоматериалы (' + shots.length + ')</h3><div class="ph-grid">' + photoGrid + '</div>' : '<h3>6. Фотоматериалы</h3><p class="doc-note">Кадры не добавлены.</p>') +

    '<h3>7. Подписи сторон</h3>' +
    '<p class="doc-note">Стороны ознакомлены с содержанием акта и подтверждают изложенные сведения. Акт подписан простой электронной подписью в порядке ст. 6 Федерального закона от 06.04.2011 № 63-ФЗ «Об электронной подписи»: одноразовый код направлен на номер телефона стороны и введён ею лично.</p>' +
    '<div class="sign-grid">' + signBox('landlord', 'Арендодатель') + signBox('tenant', 'Арендатор') + '</div>' +

    '<div class="doc-foot">' +
      '<b>Контрольная сумма документа (SHA-256):</b><br><span style="word-break:break-all">' + esc(a.chain || '—') + '</span><br>' +
      'Сформировано приложением «Залог» ' + fmtDT(nowISO()) + '. Документ действителен вместе с оригинальными фотоматериалами, хранящимися в приложении.' +
    '</div>';
}

/* ============================ печать ============================ */
async function printAct() {
  const a = CUR;
  if (!a) return;
  if (!a.paid) { paywall(a); return; }
  $('#printArea').innerHTML = '<div class="doc">' + docBody(a) + '</div>';
  const imgs = $$('#printArea img');
  await Promise.all(imgs.map(img => (img.complete ? 1 : new Promise(r => { img.onload = r; img.onerror = r; }))));
  await new Promise(r => setTimeout(r, 150));
  window.print();
}

/* ============================ модальные окна ============================ */
function openModal(html) {
  const m = $('#modal');
  m.innerHTML = '<div class="sheet"><div class="grab"></div>' + html + '</div>';
  m.classList.add('on');
}
function closeModal() {
  const m = $('#modal');
  m.classList.remove('on');
  m.innerHTML = '';
}

function paywall(a) {
  openModal(
    '<h2>Акт готов</h2>' +
    '<p>Документ собран из ' + progressOf(a).done + ' кадров. Выберите, как оплатить генерацию PDF.</p>' +
    '<div class="plan"><b>299 ₽</b><span>один акт: PDF без ограничений + отправка второй стороне</span></div>' +
    '<div class="plan"><b>490 ₽</b><span>акт + защищённое хранение копии 3 года</span></div>' +
    '<div class="plan"><b>1 500 ₽/мес</b><span>риелторам и управляющим компаниям: акты без ограничений</span></div>' +
    '<button class="btn btn-primary btn-block btn-lg" data-act="pay" data-plan="299">Оплатить 299 ₽</button>' +
    '<button class="btn btn-ghost btn-block" data-act="close-modal">Позже</button>' +
    '<p class="tiny muted" style="margin-top:8px">Демо-режим: оплата имитируется, деньги не списываются.</p>'
  );
}

function signModal(role) {
  const a = CUR;
  const who = role === 'landlord' ? a.landlord : a.tenant;
  const title = role === 'landlord' ? 'Подпись арендодателя' : 'Подпись арендатора';
  window._sms = null;
  openModal(
    '<h2>' + title + '</h2>' +
    '<p>Код придёт на номер второй стороны. В прототипе — показывается здесь.</p>' +
    '<label class="field"><span>Телефон</span><input id="sg-phone" type="tel" value="' + esc(who.phone || '') + '" placeholder="+7 900 000-00-00"></label>' +
    '<button class="btn btn-primary btn-block" data-act="sign-send" data-role="' + role + '">Получить код</button>' +
    '<button class="btn btn-ghost btn-block" data-act="close-modal">Отмена</button>'
  );
}

function codeModal(role, code) {
  openModal(
    '<h2>Введите код из СМС</h2>' +
    '<p>Демо-режим: код <b>' + code + '</b>. В рабочей версии его присылает сервис на телефон стороны.</p>' +
    '<label class="field"><span>Код подтверждения</span><input id="sg-code" inputmode="numeric" maxlength="4" placeholder="0000" style="letter-spacing:8px;text-align:center;font-size:22px"></label>' +
    '<button class="btn btn-primary btn-block" data-act="sign-confirm" data-role="' + role + '">Подтвердить и подписать</button>' +
    '<button class="btn btn-ghost btn-block" data-act="close-modal">Отмена</button>'
  );
}

/* ============================ действия ============================ */
let NEW_TYPE = 'in';

async function createAct() {
  const address = $('#f-address').value.trim();
  const llName = $('#f-ll-name').value.trim();
  const tnName = $('#f-tn-name').value.trim();
  if (!address) return toast('Укажите адрес объекта');
  if (!llName || !tnName) return toast('Укажите ФИО обеих сторон');
  const a = newAct({
    type: NEW_TYPE,
    address,
    landlordName: llName,
    landlordPhone: $('#f-ll-phone').value.trim(),
    tenantName: tnName,
    tenantPhone: $('#f-tn-phone').value.trim()
  });
  a.geo = await geoGet();
  await saveAct(a);
  CUR = a;
  location.hash = '#/act/' + a.id;
  render();
  toast('Акт создан. Начинайте обход.');
}

async function saveDefect() {
  const a = CUR;
  const room = $('#df-room').value;
  const desc = $('#df-desc').value.trim();
  const sev = $('#df-sev').value;
  if (!desc) return toast('Опишите повреждение');
  const d = { id: uid(), room, desc, sev, photo: null, createdAt: nowISO() };
  a.defects.push(d);
  await saveAct(a);
  toast('Дефект добавлен — снимите кадр');
  shoot({ kind: 'defect', defect: d.id });
}

async function saveMeters() {
  const a = CUR;
  a.meters.forEach(m => {
    const el = document.getElementById('m-' + m.key);
    if (el) m.value = el.value.trim();
  });
  await saveAct(a);
  toast('Показания сохранены');
}

/* ============================ рендер и роутинг ============================ */
function parseRoute() {
  const raw = (location.hash || '').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return { view: 'list' };
  if (parts[0] === 'new') return { view: 'new' };
  if (parts[0] === 'act') {
    const id = parts[1];
    if (!parts[2]) return { view: 'act', id };
    if (parts[2] === 'room') return { view: 'room', id, room: parts[3] };
    return { view: parts[2], id };
  }
  return { view: 'list' };
}

async function render() {
  const r = parseRoute();
  let html = '';

  if (r.view === 'list') {
    await loadActs();
    html = viewList();
  } else if (r.view === 'new') {
    html = viewNew();
  } else {
    const a = await getAct(r.id);
    if (!a) { location.hash = '#/'; return; }
    CUR = a;
    if (r.view === 'act') html = viewAct(a);
    else if (r.view === 'room') html = viewRoom(a, r.room);
    else if (r.view === 'defects') html = viewDefects(a);
    else if (r.view === 'meters') html = viewMeters(a);
    else if (r.view === 'sign') html = viewSign(a);
    else if (r.view === 'doc') html = viewDoc(a);
    else html = viewAct(a);
  }

  $('#app').innerHTML = html;
  window.scrollTo(0, 0);
}

function go(to) { location.hash = to; render(); }

async function onClick(e) {
  const seg = e.target.closest('[data-act="type"]');
  if (seg) {
    NEW_TYPE = seg.dataset.type;
    $$('#act-type button').forEach(b => b.classList.toggle('on', b === seg));
    return;
  }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act !== 'del-photo' && act !== 'shoot' && act !== 'del-defect' && act !== 'del-act') e.preventDefault();

  switch (act) {
    case 'nav': go(el.dataset.to); break;
    case 'go': go(el.dataset.to); break;

    case 'create-act': await createAct(); break;

    case 'shoot':
      shoot({ kind: 'frame', room: el.dataset.room, frame: el.dataset.frame });
      break;

    case 'del-photo': {
      e.stopPropagation();
      const a = CUR, r = a.rooms.find(x => x.key === el.dataset.room);
      const f = r && r.frames.find(x => x.id === el.dataset.frame);
      if (!f || !f.photo) return;
      await idbDel(ST_PHOTOS, f.photo.id);
      PHOTO.delete(f.photo.id);
      f.photo = null;
      await recomputeChain(a);
      await saveAct(a);
      await render();
      toast('Кадр удалён');
      break;
    }

    case 'save-defect': await saveDefect(); break;

    case 'shoot-defect':
      shoot({ kind: 'defect', defect: el.dataset.id });
      break;

    case 'del-defect': {
      const a = CUR;
      const d = a.defects.find(x => x.id === el.dataset.id);
      if (!d) return;
      if (d.photo) { await idbDel(ST_PHOTOS, d.photo.id); PHOTO.delete(d.photo.id); }
      a.defects = a.defects.filter(x => x.id !== d.id);
      await recomputeChain(a);
      await saveAct(a);
      await render();
      toast('Дефект удалён');
      break;
    }

    case 'shoot-meter':
      shoot({ kind: 'meter', meter: el.dataset.meter });
      break;

    case 'save-meters': await saveMeters(); break;

    case 'sign-start': signModal(el.dataset.role); break;

    case 'sign-send': {
      const phone = ($('#sg-phone') || {}).value || '';
      if (phone.replace(/\D/g, '').length < 10) return toast('Укажите корректный номер');
      const code = String(Math.floor(1000 + Math.random() * 9000));
      window._sms = code;
      codeModal(el.dataset.role, code);
      break;
    }

    case 'sign-confirm': {
      const a = CUR;
      const entered = (($('#sg-code') || {}).value || '').trim();
      if (entered !== window._sms) return toast('Неверный код');
      const role = el.dataset.role;
      const who = role === 'landlord' ? a.landlord : a.tenant;
      a.signatures[role] = {
        name: who.name, phone: who.phone, at: nowISO(),
        code: String(window._sms).slice(0, 2) + '**'
      };
      await recomputeChain(a);
      await saveAct(a);
      closeModal();
      await render();
      toast('Подписано');
      break;
    }

    case 'print-act': await printAct(); break;

    case 'pay': {
      const a = CUR;
      el.textContent = 'Оплата…';
      el.disabled = true;
      await new Promise(r => setTimeout(r, 900));
      a.paid = { plan: el.dataset.plan || '299', at: nowISO(), demo: true };
      await saveAct(a);
      closeModal();
      await render();
      toast('Оплачено (демо). Формирую PDF.');
      await printAct();
      break;
    }

    case 'del-act': {
      const a = CUR;
      if (!confirm('Удалить акт и все его кадры? Действие необратимо.')) return;
      const ids = [];
      a.rooms.forEach(r => r.frames.forEach(f => { if (f.photo) ids.push(f.photo.id); }));
      a.defects.forEach(d => { if (d.photo) ids.push(d.photo.id); });
      a.meters.forEach(m => { if (m.photo) ids.push(m.photo.id); });
      for (const id of ids) { await idbDel(ST_PHOTOS, id); PHOTO.delete(id); }
      await idbDel(ST_ACTS, a.id);
      ACTS = ACTS.filter(x => x.id !== a.id);
      CUR = null;
      go('#/');
      toast('Акт удалён');
      break;
    }

    case 'close-modal': closeModal(); break;
  }
}

function onInput(e) {
  const key = e.target && e.target.dataset && e.target.dataset.meter;
  if (key && CUR) {
    const m = CUR.meters.find(x => x.key === key);
    if (m) m.value = e.target.value;
  }
}

async function onChange(e) {
  const key = e.target && e.target.dataset && e.target.dataset.meter;
  if (!key || !CUR) return;
  const m = CUR.meters.find(x => x.key === key);
  if (!m) return;
  m.value = e.target.value.trim();
  await saveAct(CUR);
}

/* ============================ старт ============================ */
async function init() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  $('#camera').addEventListener('change', onCamera);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  window.addEventListener('hashchange', render);
  await render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
