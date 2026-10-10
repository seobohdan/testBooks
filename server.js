'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
/* ------------------------------------------------------------------ DB */
const IS_VERCEL = !!process.env.VERCEL;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const STORAGE = REDIS_URL && REDIS_TOKEN ? 'redis' : IS_VERCEL ? 'tmp' : 'file';
const DATA_DIR = IS_VERCEL ? '/tmp/libri-data' : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const REDIS_KEY = 'libri_db';
let ORIGIN = `http://localhost:${PORT}`;
let dirty = false;
let db;
const now = () => new Date().toISOString();
const rid = (n = 16) => crypto.randomBytes(n).toString('hex');

function seedProducts() {
  const items = [
    ['Мастер и Маргарита', 'Михаил Булгаков', 'Роман о визите дьявола в Москву 1930-х, о любви, трусости и творчестве.', 320, 12, 'Классика'],
    ['Преступление и наказание', 'Фёдор Достоевский', 'Психологический роман о студенте Раскольникове и цене «права на кровь».', 290, 8, 'Классика'],
    ['1984', 'Джордж Оруэлл', 'Антиутопия о тотальном контроле, новоязе и Большом Брате.', 260, 15, 'Фантастика'],
    ['Тайна Хоббита', 'Дж. Р. Р. Толкин', 'Путешествие Бильбо Бэггинса к Одинокой горе вместе с гномами и Гэндальфом.', 350, 6, 'Фантастика'],
    ['Маленький принц', 'Антуан де Сент-Экзюпери', 'Философская сказка о дружбе, ответственности и взрослых странностях.', 210, 20, 'Детям'],
    ['Чистый код', 'Роберт Мартин', 'Практики написания читаемого и поддерживаемого кода от мастера.', 690, 5, 'Технические'],
  ];
  return items.map(([title, author, description, price, stock, category], i) => ({
    id: i + 1, externalId: null, source: 'manual', title, author, description, price, stock,
    category, image: '', active: true, createdAt: now(), updatedAt: now(),
  }));
}

function defaultDb() {
  return {
    seq: { product: 7, order: 1 },
    products: seedProducts(),
    orders: [],
    settings: {
      shop: { name: 'Libri', currency: '₴' },
      pushKey: 'pk_' + rid(18),
      vendi: {
        enabled: true,
        baseUrl: '/mock/vendi-libri',   // относительный = адрес этого же сайта
        endpoint: '/products',
        authType: 'bearer',          // bearer | header | query | none
        authHeader: 'X-API-Key',     // имя заголовка / query-параметра
        apiKey: 'demo-key',
        extraHeaders: '{}',
        itemsPath: 'data.items',
        pageParam: '',
        maxPages: 10,
        priceDivisor: 100,
        defaultCategory: 'Книги',
        autoSyncMinutes: 0,
        lastSync: null,
        lastResult: null,
        mapping: {
          externalId: 'id', title: 'title', author: 'writer', description: 'about',
          price: 'price_cents', stock: 'qty', category: 'genre', image: 'cover_url',
        },
      },
    },
  };
}


const redis = async (cmd, opts = {}) => {
  const r = await fetch(`${REDIS_URL}/${cmd}`, { ...opts, headers: { Authorization: 'Bearer ' + REDIS_TOKEN } });
  if (!r.ok) throw new Error(`Redis ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
};
function loadFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  else { db = defaultDb(); save(); }
}
/** redis: читаем свежие данные на каждый запрос (serverless-инстансов может быть несколько) */
async function ensureLoaded() {
  if (STORAGE === 'redis') {
    const j = await redis(`get/${REDIS_KEY}`);
    if (j.result) db = JSON.parse(j.result);
    else { db = defaultDb(); dirty = true; }
  } else if (!db) loadFile();
}
function save() {
  if (STORAGE === 'redis') { dirty = true; return; }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
async function persist() {
  if (STORAGE !== 'redis' || !dirty) return;
  dirty = false;
  await redis(`set/${REDIS_KEY}`, { method: 'POST', body: JSON.stringify(db) });
}

/* ------------------------------------------------------------ Helpers */
const getPath = (obj, p) => {
  if (!p) return undefined;
  return String(p).split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
};
const has = (v) => v !== undefined && v !== null && v !== '';

const GUESS = {
  externalId: ['id', '_id', 'uuid', 'sku', 'isbn', 'code'],
  title: ['title', 'name', 'book_title', 'titolo'],
  author: ['author', 'authors', 'writer', 'autore'],
  description: ['description', 'desc', 'about', 'summary', 'descrizione'],
  price: ['price', 'cost', 'amount', 'prezzo'],
  stock: ['stock', 'quantity', 'qty', 'available', 'count'],
  category: ['category', 'genre', 'categoria'],
  image: ['image', 'image_url', 'cover', 'cover_url', 'photo', 'thumbnail', 'images.0'],
};

function pick(raw, field, mapping) {
  const own = mapping && mapping[field];
  if (own) { const v = getPath(raw, own); if (has(v)) return v; }
  for (const c of GUESS[field]) { const v = getPath(raw, c); if (has(v)) return v; }
  return undefined;
}
function toText(v) {
  if (!has(v)) return '';
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(', ');
  if (typeof v === 'object') return String(v.name || v.title || v.url || '');
  return String(v).trim();
}
function toNum(v) {
  if (typeof v === 'number') return v;
  if (!has(v)) return NaN;
  let s = String(v).replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  return parseFloat(s);
}

/** Приводит «сырой» объект товара из внешнего API к формату магазина */
function normalize(raw, cfg) {
  if (!raw || typeof raw !== 'object') throw new Error('элемент не является объектом');
  const m = cfg.mapping || {};
  const title = toText(pick(raw, 'title', m));
  if (!title) throw new Error('не найдено название (проверьте маппинг поля title)');
  let price = toNum(pick(raw, 'price', m));
  if (isNaN(price)) throw new Error('не найдена цена (проверьте маппинг поля price)');
  const div = Number(cfg.priceDivisor) || 1;
  price = Math.round((price / div) * 100) / 100;
  if (price < 0) throw new Error('цена отрицательная');
  let stock = toNum(pick(raw, 'stock', m));
  if (isNaN(stock)) stock = 1;
  const ext = pick(raw, 'externalId', m);
  return {
    externalId: has(ext) ? String(ext) : null,
    title,
    author: toText(pick(raw, 'author', m)),
    description: toText(pick(raw, 'description', m)),
    price,
    stock: Math.max(0, Math.floor(stock)),
    category: toText(pick(raw, 'category', m)) || cfg.defaultCategory || 'Книги',
    image: toText(pick(raw, 'image', m)),
  };
}

/** Создаёт/обновляет товары. Совпадение по (source, externalId). */
function upsert(mappedList, source) {
  const res = { created: 0, updated: 0, errors: [] };
  for (const item of mappedList) {
    let existing = item.externalId
      ? db.products.find((p) => p.source === source && p.externalId === item.externalId)
      : null;
    if (existing) {
      Object.assign(existing, item, { updatedAt: now() });
      res.updated++;
    } else {
      db.products.push({
        id: db.seq.product++, source, active: true, createdAt: now(), updatedAt: now(), ...item,
      });
      res.created++;
    }
  }
  save();
  return res;
}

function extractItems(data, itemsPath) {
  if (itemsPath) {
    const v = getPath(data, itemsPath);
    if (!Array.isArray(v)) throw new Error(`По пути «${itemsPath}» в ответе нет массива`);
    return v;
  }
  if (Array.isArray(data)) return data;
  const find = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 2) return null;
    for (const k of Object.keys(o)) {
      if (Array.isArray(o[k])) return o[k];
      const f = find(o[k], depth + 1); if (f) return f;
    }
    return null;
  };
  const f = find(data, 0);
  if (!f) throw new Error('Не удалось найти массив товаров в ответе. Укажите «Путь к массиву».');
  return f;
}

async function fetchVendiItems(v) {
  if (!v.baseUrl) throw new Error('Не указан Base URL');
  const headers = { Accept: 'application/json' };
  if (v.extraHeaders) {
    try { Object.assign(headers, JSON.parse(v.extraHeaders)); }
    catch { throw new Error('Доп. заголовки: невалидный JSON'); }
  }
  if (v.apiKey && v.authType === 'bearer') headers.Authorization = 'Bearer ' + v.apiKey;
  if (v.apiKey && v.authType === 'header') headers[v.authHeader || 'X-API-Key'] = v.apiKey;

  const root = v.baseUrl.startsWith('/') ? ORIGIN + v.baseUrl : v.baseUrl;
  const base = root.replace(/\/+$/, '') + '/' + String(v.endpoint || '').replace(/^\/+/, '');
  const pages = v.pageParam ? Math.max(1, Math.min(100, +v.maxPages || 1)) : 1;
  const all = [];
  for (let p = 1; p <= pages; p++) {
    let url;
    try { url = new URL(base); } catch { throw new Error('Некорректный URL: ' + base); }
    if (v.apiKey && v.authType === 'query') url.searchParams.set(v.authHeader || 'api_key', v.apiKey);
    if (v.pageParam) url.searchParams.set(v.pageParam, p);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try { res = await fetch(url, { headers, signal: ctrl.signal }); }
    catch (e) { throw new Error('Не удалось подключиться: ' + (e.name === 'AbortError' ? 'таймаут 15с' : e.cause?.code || e.message)); }
    finally { clearTimeout(t); }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Ответ не является JSON: ' + text.slice(0, 120)); }
    const items = extractItems(data, v.itemsPath);
    if (!items.length) break;
    all.push(...items);
  }
  return all;
}

function mapAll(rawItems, cfg, source) {
  return rawItems.map((raw, i) => {
    try {
      const mapped = normalize(raw, cfg);
      const exists = mapped.externalId && db.products.some((p) => p.source === source && p.externalId === mapped.externalId);
      return { index: i, mapped, status: exists ? 'update' : 'new' };
    } catch (e) { return { index: i, error: e.message, raw }; }
  });
}

async function runImport({ onlyIds, json } = {}) {
  const v = db.settings.vendi;
  const raw = json !== undefined ? extractItems(json, v.itemsPath && !Array.isArray(json) ? v.itemsPath : '') : await fetchVendiItems(v);
  let rows = mapAll(raw, v, 'vendi-libri');
  if (Array.isArray(onlyIds)) rows = rows.filter((r) => onlyIds.includes(r.index));
  const ok = rows.filter((r) => r.mapped).map((r) => r.mapped);
  const res = upsert(ok, 'vendi-libri');
  res.errors = rows.filter((r) => r.error).map((r) => `#${r.index + 1}: ${r.error}`);
  res.total = rows.length;
  v.lastSync = now();
  v.lastResult = { created: res.created, updated: res.updated, errors: res.errors.length };
  save();
  return res;
}

const publicProduct = (p) => ({
  id: p.id, title: p.title, author: p.author, description: p.description, price: p.price,
  stock: p.stock, category: p.category,
  image: p.image || `/api/cover?t=${encodeURIComponent(p.title)}&a=${encodeURIComponent(p.author || '')}`,
});

/* ----------------------------------------------------------------- App */
if (STORAGE !== 'redis') loadFile();
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(async (req, res, next) => {
  ORIGIN = `${req.protocol}://${req.get('host')}`;
  try { await ensureLoaded(); } catch (e) { return res.status(500).json({ error: 'Хранилище недоступно: ' + e.message }); }
  const end = res.end.bind(res);          // сохраняем в Redis ДО отправки ответа
  res.end = (...args) => {
    if (!dirty) return end(...args);
    persist().catch((e) => console.error('persist failed', e)).finally(() => end(...args));
    return res;
  };
  next();
});

/* ---- Public API */
app.get('/api/config', (req, res) => res.json(db.settings.shop));

app.get('/api/products', (req, res) => {
  let list = db.products.filter((p) => p.active);
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q) list = list.filter((p) => (p.title + ' ' + p.author).toLowerCase().includes(q));
  if (req.query.category) list = list.filter((p) => p.category === req.query.category);
  const s = req.query.sort;
  if (s === 'price_asc') list.sort((a, b) => a.price - b.price);
  else if (s === 'price_desc') list.sort((a, b) => b.price - a.price);
  else if (s === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  else list.sort((a, b) => b.id - a.id);
  res.json(list.map(publicProduct));
});
app.get('/api/products/:id', (req, res) => {
  const p = db.products.find((x) => x.id === +req.params.id && x.active);
  if (!p) return res.status(404).json({ error: 'Товар не найден' });
  res.json(publicProduct(p));
});
app.get('/api/categories', (req, res) => {
  res.json([...new Set(db.products.filter((p) => p.active).map((p) => p.category).filter(Boolean))].sort());
});

app.post('/api/orders', (req, res) => {
  const { name, phone, email, address, comment, items } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Укажите имя' });
  if (!phone || String(phone).replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Укажите телефон' });
  if (!address || !String(address).trim()) return res.status(400).json({ error: 'Укажите адрес доставки' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Корзина пуста' });
  const lines = [];
  for (const it of items) {
    const p = db.products.find((x) => x.id === +it.id && x.active);
    const qty = Math.floor(+it.qty);
    if (!p || !(qty > 0)) return res.status(400).json({ error: 'Некорректная позиция в корзине' });
    if (p.stock < qty) return res.status(400).json({ error: `«${p.title}»: в наличии только ${p.stock} шт.` });
    lines.push({ p, qty });
  }
  lines.forEach(({ p, qty }) => { p.stock -= qty; });
  const order = {
    id: db.seq.order++, createdAt: now(), status: 'new',
    customer: { name: String(name).trim(), phone: String(phone).trim(), email: String(email || '').trim(), address: String(address).trim(), comment: String(comment || '').trim() },
    items: lines.map(({ p, qty }) => ({ id: p.id, title: p.title, price: p.price, qty })),
    total: Math.round(lines.reduce((s, { p, qty }) => s + p.price * qty, 0) * 100) / 100,
  };
  db.orders.push(order);
  save();
  res.json({ ok: true, orderId: order.id, total: order.total });
});

app.get('/api/cover', (req, res) => {
  const t = String(req.query.t || '').slice(0, 80);
  const a = String(req.query.a || '').slice(0, 40);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const words = t.split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > 14 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  const tspans = lines.slice(0, 5).map((l, i) => `<tspan x="150" dy="${i ? 34 : 0}">${esc(l)}</tspan>`).join('');
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},45%,32%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},50%,18%)"/></linearGradient></defs><rect width="300" height="420" fill="url(#g)"/><rect x="14" y="14" width="272" height="392" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/><text x="150" y="130" text-anchor="middle" font-family="Georgia,serif" font-size="28" font-weight="bold" fill="#fff">${tspans}</text><text x="150" y="380" text-anchor="middle" font-family="Georgia,serif" font-size="16" fill="rgba(255,255,255,.8)">${esc(a)}</text></svg>`);
});

/* ---- Incoming API for Vendi Libri app (push) */
function pushAuth(req, res, next) {
  const key = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || key !== db.settings.pushKey) return res.status(401).json({ error: 'Неверный API-ключ' });
  next();
}
app.post('/api/v1/products', pushAuth, (req, res) => {
  let body = req.body;
  const list = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.products) ? body.products : [body];
  const cfg = db.settings.vendi;
  const mapped = []; const errors = [];
  list.forEach((raw, i) => {
    try { mapped.push(normalize(raw, cfg)); } catch (e) { errors.push(`#${i + 1}: ${e.message}`); }
  });
  const r = upsert(mapped, 'vendi-libri');
  res.status(errors.length && !mapped.length ? 400 : 200).json({ ok: mapped.length > 0, ...r, errors });
});
app.get('/api/v1/products', pushAuth, (req, res) => res.json(db.products.map((p) => ({ ...p }))));
app.delete('/api/v1/products/:externalId', pushAuth, (req, res) => {
  const i = db.products.findIndex((p) => p.externalId === req.params.externalId);
  if (i < 0) return res.status(404).json({ error: 'Не найдено' });
  db.products.splice(i, 1); save(); res.json({ ok: true });
});

/* ---- Mock Vendi Libri (для проверки интеграции без реального приложения) */
app.get('/mock/vendi-libri/products', (req, res) => {
  if ((req.get('authorization') || '') !== 'Bearer demo-key' && req.get('x-api-key') !== 'demo-key' && req.query.api_key !== 'demo-key')
    return res.status(401).json({ error: 'unauthorized' });
  const page = +req.query.page || 1;
  const data = page > 1 ? [] : [
    { id: 'vl-101', title: 'Собачье сердце', writer: 'Михаил Булгаков', about: 'Повесть о профессоре Преображенском и Шарикове.', price_cents: 18000, qty: 9, genre: 'Классика', cover_url: '' },
    { id: 'vl-102', title: 'Дюна', writer: 'Фрэнк Герберт', about: 'Эпопея о пустынной планете Арракис и пряности.', price_cents: 42000, qty: 7, genre: 'Фантастика', cover_url: '' },
    { id: 'vl-103', title: 'Sapiens. Краткая история человечества', writer: 'Юваль Ной Харари', about: 'Как Homo sapiens завоевал мир.', price_cents: 39000, qty: 11, genre: 'Нон-фикшн', cover_url: '' },
    { id: 'vl-104', title: 'Атомные привычки', writer: 'Джеймс Клир', about: 'Как маленькие изменения приводят к большим результатам.', price_cents: 35000, qty: 14, genre: 'Нон-фикшн', cover_url: '' },
  ];
  res.json({ data: { items: data, page } });
});

/* ---- Admin */
const sessions = new Map();
app.post('/api/admin/login', (req, res) => {
  const given = Buffer.from(String(req.body?.password || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) return res.status(401).json({ error: 'Неверный пароль' });
  const token = rid(24);
  sessions.set(token, Date.now() + 12 * 3600 * 1000);
  res.json({ token });
});
const adminAuth = (req, res, next) => {
  const t = req.get('x-admin-token');
  const exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Требуется вход' });
  next();
};
const admin = express.Router();
admin.use(adminAuth);

admin.get('/stats', (req, res) => res.json({
  storage: STORAGE, products: db.products.length, orders: db.orders.length,
  revenue: db.orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0),
}));

admin.get('/products', (req, res) => res.json(db.products));
function cleanProduct(b) {
  const price = toNum(b.price); const stock = toNum(b.stock);
  if (!String(b.title || '').trim()) throw new Error('Название обязательно');
  if (isNaN(price) || price < 0) throw new Error('Некорректная цена');
  return {
    title: String(b.title).trim(), author: String(b.author || '').trim(), description: String(b.description || '').trim(),
    price, stock: isNaN(stock) ? 0 : Math.max(0, Math.floor(stock)), category: String(b.category || '').trim() || 'Книги',
    image: String(b.image || '').trim(), active: b.active !== false,
  };
}
admin.post('/products', (req, res) => {
  try {
    const p = { id: db.seq.product++, externalId: null, source: 'manual', createdAt: now(), updatedAt: now(), ...cleanProduct(req.body) };
    db.products.push(p); save(); res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.put('/products/:id', (req, res) => {
  const p = db.products.find((x) => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'Не найдено' });
  try { Object.assign(p, cleanProduct(req.body), { updatedAt: now() }); save(); res.json(p); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
admin.delete('/products/:id', (req, res) => {
  const i = db.products.findIndex((x) => x.id === +req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Не найдено' });
  db.products.splice(i, 1); save(); res.json({ ok: true });
});

admin.get('/orders', (req, res) => res.json([...db.orders].reverse()));
admin.put('/orders/:id', (req, res) => {
  const o = db.orders.find((x) => x.id === +req.params.id);
  if (!o) return res.status(404).json({ error: 'Не найдено' });
  if (!['new', 'paid', 'shipped', 'done', 'cancelled'].includes(req.body.status)) return res.status(400).json({ error: 'Неверный статус' });
  o.status = req.body.status; save(); res.json(o);
});

admin.get('/settings', (req, res) => res.json({ shop: db.settings.shop, vendi: db.settings.vendi, pushKey: db.settings.pushKey }));
admin.put('/settings/shop', (req, res) => {
  const { name, currency } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Название обязательно' });
  db.settings.shop = { name: String(name).trim(), currency: String(currency || '₴').trim() };
  save(); res.json(db.settings.shop);
});
admin.put('/settings/vendi', (req, res) => {
  const b = req.body || {}; const v = db.settings.vendi;
  const str = (k) => (b[k] !== undefined ? String(b[k]).trim() : v[k]);
  Object.assign(v, {
    enabled: b.enabled !== false, baseUrl: str('baseUrl'), endpoint: str('endpoint'), authType: str('authType'),
    authHeader: str('authHeader'), apiKey: str('apiKey'), extraHeaders: b.extraHeaders !== undefined ? String(b.extraHeaders) : v.extraHeaders,
    itemsPath: str('itemsPath'), pageParam: str('pageParam'), maxPages: Math.max(1, +b.maxPages || 10),
    priceDivisor: Number(b.priceDivisor) > 0 ? Number(b.priceDivisor) : 1, defaultCategory: str('defaultCategory') || 'Книги',
    autoSyncMinutes: Math.max(0, Math.floor(+b.autoSyncMinutes || 0)),
    mapping: Object.fromEntries(Object.keys(GUESS).map((k) => [k, String(b.mapping?.[k] || '').trim()])),
  });
  save(); res.json(v);
});
admin.post('/settings/push-key', (req, res) => { db.settings.pushKey = 'pk_' + rid(18); save(); res.json({ pushKey: db.settings.pushKey }); });

admin.post('/integration/test', async (req, res) => {
  try {
    const items = await fetchVendiItems(db.settings.vendi);
    res.json({ ok: true, count: items.length, sample: items[0] || null });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
admin.post('/integration/preview', async (req, res) => {
  try {
    const v = db.settings.vendi;
    let raw;
    if (req.body?.json !== undefined) {
      const data = typeof req.body.json === 'string' ? JSON.parse(req.body.json) : req.body.json;
      raw = extractItems(data, Array.isArray(data) ? '' : v.itemsPath);
    } else raw = await fetchVendiItems(v);
    res.json({ ok: true, total: raw.length, rows: mapAll(raw, v, 'vendi-libri') });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
admin.post('/integration/import', async (req, res) => {
  try {
    let json;
    if (req.body?.json !== undefined) {
      const data = typeof req.body.json === 'string' ? JSON.parse(req.body.json) : req.body.json;
      json = Array.isArray(data) ? data : extractItems(data, db.settings.vendi.itemsPath);
    }
    res.json({ ok: true, ...(await runImport({ onlyIds: req.body?.ids, json })) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.use('/api/admin', admin);

/* Cron (Vercel): GET /api/cron/sync с заголовком Authorization: Bearer $CRON_SECRET */
app.get('/api/cron/sync', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== 'Bearer ' + secret) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await runImport()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* Автосинхронизация (только на обычном сервере; на Vercel — cron) */
if (!IS_VERCEL) setInterval(async () => {
  try {
    await ensureLoaded();
    const v = db.settings.vendi;
    if (!v.enabled || !v.autoSyncMinutes) return;
    const last = v.lastSync ? Date.parse(v.lastSync) : 0;
    if (Date.now() - last < v.autoSyncMinutes * 60000) return;
    try { await runImport(); console.log('[autosync] ok', v.lastResult); }
    catch (e) { v.lastSync = now(); v.lastResult = { error: e.message }; save(); console.log('[autosync] error', e.message); }
    await persist();
  } catch (e) { console.log('[autosync] storage error', e.message); }
}, 30000);

module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Магазин:  http://localhost:${PORT}`);
    console.log(`Админка:  http://localhost:${PORT}/admin/  (пароль: ${ADMIN_PASSWORD})`);
  });
}
