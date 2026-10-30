try {
    const envPath = require('path').join(__dirname, '.env');
    if (require('fs').existsSync(envPath)) {
        for (const line of require('fs').readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m || line.trim().startsWith('#')) continue;
            let v = m[2];
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
            if (process.env[m[1]] === undefined) process.env[m[1]] = v;
        }
        console.log('📄 .env file loaded');
    }
} catch (e) { console.error('⚠️ Could not read .env:', e.message); }

const os = require('os');
const path = require('path');
const fs = require('fs');
const SAFE_HOME = process.env.SAFE_HOME || '/tmp';
try { fs.mkdirSync(SAFE_HOME, { recursive: true }); } catch {}
if (!process.env.HOME) process.env.HOME = SAFE_HOME;
if (!process.env.USERPROFILE) process.env.USERPROFILE = SAFE_HOME;
process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(SAFE_HOME, '.cache');
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(SAFE_HOME, '.config');
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || path.join(SAFE_HOME, '.puppeteer');
try { os.homedir(); } catch {
    const orig = os.homedir;
    os.homedir = () => { try { return orig(); } catch { return SAFE_HOME; } };
}

const QRCode = require('qrcode');
const express = require('express');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;     // master key (for your payment site only)
const MIN_GAP_MS = 3000;                 // min gap between two messages of the same account
const MAX_PER_MINUTE = 10;
const MAX_FAILED_AUTH_PER_MINUTE = 5;
const MAX_MESSAGE_LENGTH = 2000;
const BOOT_STAGGER_MS = 1500;            // delay between starting each saved session at boot

if (!API_KEY || API_KEY.length < 16) {
    console.error('❌ You must set API_KEY (at least 16 characters) as an environment variable.');
    process.exit(1);
}

// ===== Storage =====
// Sessions folder (persistent location). Priority: WA_DATA ← /data (Volume) ← local folder (temporary).
const AUTH_DIR = process.env.WA_DATA ||
    (fs.existsSync('/data') ? '/data/wa-auth' : path.join(__dirname, 'wa-auth'));
const AUTH_IS_PERSISTENT = AUTH_DIR.startsWith('/data');
console.log('📁 Sessions folder:', AUTH_DIR);

// Upstash Redis (REST): keeps sessions AND accounts outside the server disk.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_PREFIX = 'wa-auth:';
if (!AUTH_IS_PERSISTENT && !USE_REDIS) {
    console.warn('⚠️ Nothing is persistent! Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN or create a Volume on /data.');
}

async function redisCmd(args) {
    const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error('Redis: ' + (data.error || res.status));
    return data.result;
}

async function redisClear(prefix) {
    try {
        const keys = await redisCmd(['KEYS', prefix + '*']);
        if (keys && keys.length) await redisCmd(['DEL', ...keys]);
    } catch (e) { console.error('Redis clear error:', e.message); }
}

async function useRedisAuthState(baileys, prefix) {
    const { BufferJSON, initAuthCreds, proto } = baileys;
    const write = (data, key) => redisCmd(['SET', prefix + key, JSON.stringify(data, BufferJSON.replacer)]);
    const read = async (key) => {
        const v = await redisCmd(['GET', prefix + key]);
        return v ? JSON.parse(v, BufferJSON.reviver) : null;
    };
    const remove = (key) => redisCmd(['DEL', prefix + key]);

    const creds = (await read('creds')) || initAuthCreds();
    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                await Promise.all(ids.map(async (id) => {
                    let value = await read(`${type}-${id}`);
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    data[id] = value;
                }));
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category in data) {
                    for (const id in data[category]) {
                        const value = data[category][id];
                        const key = `${category}-${id}`;
                        tasks.push(value ? write(value, key) : remove(key));
                    }
                }
                await Promise.all(tasks);
            }
        }
    };
    return { state, saveCreds: () => write(state.creds, 'creds') };
}

// Accounts: Redis (acct:<email>) or a JSON file next to the sessions folder
const DATA_FILE = process.env.ACCOUNTS_FILE || path.join(path.dirname(AUTH_DIR), 'accounts.json');
let fileDb = {};
if (!USE_REDIS) { try { fileDb = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {} }
function saveFileDb() {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(fileDb));
        fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.error('⚠️ Could not save accounts:', e.message); }
}
const store = {
    async get(email) {
        if (USE_REDIS) { const v = await redisCmd(['GET', 'acct:' + email]); return v ? JSON.parse(v) : null; }
        return fileDb[email] || null;
    },
    async set(email, acc) {
        if (USE_REDIS) await redisCmd(['SET', 'acct:' + email, JSON.stringify(acc)]);
        else { fileDb[email] = acc; saveFileDb(); }
    },
    async del(email) {
        if (USE_REDIS) await redisCmd(['DEL', 'acct:' + email]);
        else { delete fileDb[email]; saveFileDb(); }
    },
    async all() {
        if (!USE_REDIS) return Object.values(fileDb);
        const keys = await redisCmd(['KEYS', 'acct:*']);
        const out = [];
        for (let i = 0; i < keys.length; i += 100) {
            const vals = await redisCmd(['MGET', ...keys.slice(i, i + 100)]);
            for (const v of vals) if (v) out.push(JSON.parse(v));
        }
        return out;
    }
};

// ===== Plans & accounts =====
// Every plan ends at the first of: quota used up OR `days` passed. No plan renews by itself.
const PLANS = {
    free:     { name: 'Free',     limit: 250,  price: 0,   days: 30 }, // one-time trial
    pro:      { name: 'Pro',      limit: 1500, price: 200, days: 30 },
    business: { name: 'Business', limit: 7000, price: 500, days: 30 }
};
const DAY_MS = 86400000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const DUMMY_HASH = sha('no-such-account');
function safeEqual(a, b) {
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(),
                                  crypto.createHash('sha256').update(String(b)).digest());
}
const newKey = () => 'wk_' + crypto.randomBytes(24).toString('hex');

function normEmail(e) {
    if (typeof e !== 'string') return null;
    const v = e.trim().toLowerCase();
    return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}
function normPlan(p) {
    if (typeof p !== 'string') return null;
    const k = p.trim().toLowerCase();
    return PLANS[k] ? k : null;
}
function periodFor(plan) {
    return { used: 0, started: Date.now(), expires: PLANS[plan].days ? Date.now() + PLANS[plan].days * DAY_MS : null };
}
function accView(a) {
    const p = PLANS[a.plan];
    return {
        email: a.email, plan: a.plan, plan_name: p.name, limit: p.limit, used: a.used,
        remaining: Math.max(0, p.limit - a.used),
        expires_at: a.expires ? new Date(a.expires).toISOString() : null,
        auto_renew: false,
        expired: !!(a.expires && a.expires <= Date.now())
    };
}

// One operation at a time per email, so simultaneous requests can't overspend the quota
const locks = new Map();
function withLock(key, fn) {
    const run = (locks.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
}

// Create the account (new key + session id) or change its plan (usage resets, new period)
const upsertAccount = (email, plan) => withLock(email, async () => {
    const old = await store.get(email);
    // The free trial is granted once only: an existing account is never reset or moved back to it
    if (old && plan === 'free') return { acc: old, key: null, created: false };
    let key = null, acc;
    if (old) {
        acc = { ...old, plan, ...periodFor(plan) };
    } else {
        key = newKey();
        acc = { email, plan, key_hash: sha(key), sid: crypto.randomBytes(8).toString('hex'), created: Date.now(), ...periodFor(plan) };
    }
    await store.set(email, acc);
    return { acc, key, created: !old };
});
const rotateKey = email => withLock(email, async () => {
    const acc = await store.get(email);
    if (!acc) return null;
    const key = newKey();
    acc.key_hash = sha(key);
    await store.set(email, acc);
    return { acc, key };
});
const getFresh = email => withLock(email, () => store.get(email));
const reserve = email => withLock(email, async () => {
    const a = await store.get(email);
    if (!a) return { error: 'noacct' };
    if (a.expires && a.expires <= Date.now()) return { error: 'expired', acc: a };
    if (a.used >= PLANS[a.plan].limit) return { error: 'quota', acc: a };
    a.used++;
    await store.set(email, a);
    return { ok: true, acc: a };
});
const refund = email => withLock(email, async () => {
    const a = await store.get(email);
    if (a && a.used > 0) { a.used--; await store.set(email, a); }
});

// ===== WhatsApp sessions (one per account) =====
const sessions = new Map(); // sid -> state
let baileysVersion;

function getSession(acc) {
    let s = sessions.get(acc.sid);
    if (!s) {
        s = { sid: acc.sid, sock: null, ready: false, qrImg: null, qrVer: 0, error: null, starting: false, stopped: false, lastSent: 0 };
        sessions.set(acc.sid, s);
    }
    return s;
}
function ensureSession(acc) {
    const s = getSession(acc);
    if (!s.sock && !s.starting) startSession(s);
    return s;
}
function clearSessionData(sid) {
    try { fs.rmSync(path.join(AUTH_DIR, sid), { recursive: true, force: true }); } catch {}
    return USE_REDIS ? redisClear(REDIS_PREFIX + sid + ':') : Promise.resolve();
}

async function startSession(s) {
    if (s.starting || s.stopped) return;
    s.starting = true;
    try {
        const baileys = await import('@whiskeysockets/baileys');
        const makeWASocket = baileys.default && typeof baileys.default === 'function' ? baileys.default : baileys.makeWASocket;
        const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;
        const pino = require('pino');

        let state, saveCreds;
        if (USE_REDIS) {
            ({ state, saveCreds } = await useRedisAuthState(baileys, REDIS_PREFIX + s.sid + ':'));
        } else {
            const dir = path.join(AUTH_DIR, s.sid);
            fs.mkdirSync(dir, { recursive: true });
            ({ state, saveCreds } = await useMultiFileAuthState(dir));
        }
        if (!baileysVersion) { try { ({ version: baileysVersion } = await fetchLatestBaileysVersion()); } catch {} }

        const sock = makeWASocket({
            auth: state,
            version: baileysVersion,
            logger: pino({ level: 'silent' }),
            browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '1.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false
        });
        s.sock = sock;

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (u) => {
            if (s.sock !== sock) return; // event from an old socket
            const { connection, lastDisconnect, qr } = u;
            if (qr) {
                try { s.qrImg = await QRCode.toDataURL(qr, { width: 300, margin: 2 }); s.qrVer++; }
                catch (e) { console.error('QR error', e.message); }
            }
            if (connection === 'open') {
                s.ready = true; s.qrImg = null; s.qrVer++; s.error = null;
                console.log('✅ Session ready:', s.sid);
            }
            if (connection === 'close') {
                s.ready = false; s.sock = null; s.starting = false;
                const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                    ? lastDisconnect.error.output.statusCode : undefined;
                console.log('🔌 Session', s.sid, 'closed, code:', code);
                if (s.stopped) return;
                if (code === (DisconnectReason ? DisconnectReason.loggedOut : 401)) {
                    await clearSessionData(s.sid);
                    s.qrImg = null; s.qrVer++;
                }
                setTimeout(() => startSession(s), 3000);
            }
        });
    } catch (err) {
        s.error = err.message; s.starting = false;
        console.error('⚠️ Session', s.sid, 'startup failed:', err.stack || err.message);
        if (!s.stopped) setTimeout(() => startSession(s), 8000);
    } finally {
        if (s.sock) s.starting = false;
    }
}

async function stopSession(sid) {
    const s = sessions.get(sid);
    if (s) {
        s.stopped = true; s.ready = false;
        try { await s.sock?.logout(); } catch {}
        try { s.sock?.end(); } catch {}
        sessions.delete(sid);
    }
    await clearSessionData(sid);
}

function waitReady(s, ms) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (s.ready || s.qrImg || Date.now() - t0 >= ms) { clearInterval(iv); resolve(); }
        }, 500);
    });
}

process.on('uncaughtException', err => console.error('⚠️', err.message));
process.on('unhandledRejection', err => console.error('⚠️', (err && err.message) || err));

// ===== Rate limiting =====
function createLimiter(max, keyFn) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [k, list] of hits) if (!list.some(t => now - t < 60000)) hits.delete(k);
    }, 60000).unref();
    return {
        blocked: req => (hits.get(keyFn(req)) || []).filter(t => Date.now() - t < 60000).length >= max,
        record: req => {
            const k = keyFn(req);
            const list = (hits.get(k) || []).filter(t => Date.now() - t < 60000);
            list.push(Date.now());
            hits.set(k, list);
        }
    };
}
const failLimit = createLimiter(MAX_FAILED_AUTH_PER_MINUTE, req => req.ip);
const sendLimit = createLimiter(MAX_PER_MINUTE, req => req.ip + '|' + (req.body && req.body.email || ''));
const rateLimit = (req, res, next) => {
    if (sendLimit.blocked(req)) return res.status(429).json({ ok: false, error: 'Too many requests, please wait a bit' });
    sendLimit.record(req);
    next();
};

function denyAuth(req, res, error) {
    failLimit.record(req);
    return setTimeout(() => res.status(401).json({ ok: false, error }), 800);
}
function tooManyFails(req, res) {
    if (!failLimit.blocked(req)) return false;
    res.status(429).json({ ok: false, error: 'Too many failed attempts, please wait a bit' });
    return true;
}

// ADMIN auth (your payment site): { api_key } = the master API_KEY from the env
function adminAuth(req, res, next) {
    if (tooManyFails(req, res)) return;
    const { api_key } = req.body;
    if (typeof api_key !== 'string' || !api_key) {
        return res.status(400).json({ ok: false, error: 'api_key is required' });
    }
    if (safeEqual(api_key, API_KEY)) return next();
    return denyAuth(req, res, 'Invalid api_key');
}

// CLIENT auth: { email, api_key } must match an existing account, otherwise the request is rejected
async function clientAuth(req, res, next) {
    if (tooManyFails(req, res)) return;
    const email = normEmail(req.body.email);
    const key = req.body.api_key;
    if (!email || typeof key !== 'string' || !key) {
        return res.status(400).json({ ok: false, error: 'email and api_key are required' });
    }
    try {
        const acc = await getFresh(email);
        const okKey = safeEqual(sha(key), acc ? acc.key_hash : DUMMY_HASH);
        if (!acc || !okKey) return denyAuth(req, res, 'Unknown email or invalid api_key');
        req.acc = acc;
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Server error' });
    }
}

// ===== Express =====
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb', strict: true, type: 'application/json' }));

app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
});

// The API accepts JSON only (a JSON object)
app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
        }
    }
    next();
});

app.get('/', (req, res) => res.json({ ok: true, service: 'whatsapp-api' }));

// ----- ADMIN -----
// Create an account (returns its api_key ONCE) or change/renew its plan (usage resets, new 30-day period).
// Asking for "free" on an existing account changes nothing (the trial is one-time).
app.post('/admin/account', adminAuth, async (req, res) => {
    const email = normEmail(req.body.email);
    const plan = normPlan(req.body.plan);
    if (!email) return res.status(400).json({ ok: false, error: 'A valid email is required' });
    if (!plan) return res.status(400).json({ ok: false, error: 'plan must be one of: free, pro, business' });
    try {
        const { acc, key, created } = await upsertAccount(email, plan);
        ensureSession(acc);
        const out = { ok: true, created, usage: accView(acc) };
        if (key) out.api_key = key;
        res.json(out);
    } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Server error' }); }
});

// Issue a new api_key (the old one stops working immediately)
app.post('/admin/rotate-key', adminAuth, async (req, res) => {
    const email = normEmail(req.body.email);
    if (!email) return res.status(400).json({ ok: false, error: 'A valid email is required' });
    try {
        const r = await rotateKey(email);
        if (!r) return res.status(404).json({ ok: false, error: 'No such account' });
        res.json({ ok: true, api_key: r.key });
    } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Server error' }); }
});

// Delete the account, unlink and wipe its WhatsApp session
app.post('/admin/delete', adminAuth, async (req, res) => {
    const email = normEmail(req.body.email);
    if (!email) return res.status(400).json({ ok: false, error: 'A valid email is required' });
    try {
        const acc = await store.get(email);
        if (!acc) return res.status(404).json({ ok: false, error: 'No such account' });
        await withLock(email, () => store.del(email));
        await stopSession(acc.sid);
        res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Server error' }); }
});

// ----- CLIENT -----
app.post('/usage', clientAuth, (req, res) => res.json({ ok: true, usage: accView(req.acc) }));

app.post('/status', clientAuth, (req, res) => {
    const s = ensureSession(req.acc);
    res.json({ ok: true, ready: s.ready, error: s.error, hasQr: !!s.qrImg, usage: accView(req.acc) });
});

// QR image (data URL) to link this account's WhatsApp number
app.post('/qr', clientAuth, rateLimit, async (req, res) => {
    const s = ensureSession(req.acc);
    if (!s.ready && !s.qrImg) await waitReady(s, 10000);
    if (s.ready) return res.json({ ok: false, ready: true, error: 'Already linked, no QR needed' });
    if (!s.qrImg) return res.status(503).json({ ok: false, error: 'QR is not ready yet, try again in a few seconds' });
    res.json({ ok: true, img: s.qrImg });
});

app.post('/send', clientAuth, rateLimit, async (req, res) => {
    const { number: rawNumber, message: rawMessage } = req.body;
    if ((typeof rawNumber !== 'string' && typeof rawNumber !== 'number') || typeof rawMessage !== 'string') {
        return res.status(400).json({ ok: false, error: 'number (string or number) and message (string) are required' });
    }
    const email = req.acc.email;

    // Plan ended (30 days passed or quota used up): reject before touching WhatsApp
    const a0 = PLANS[req.acc.plan];
    const expired0 = !!(req.acc.expires && req.acc.expires <= Date.now());
    if (expired0 || req.acc.used >= a0.limit) {
        return res.status(402).json({
            ok: false,
            code: expired0 ? 'plan_expired' : 'quota_exceeded',
            error: expired0 ? 'Plan expired, please renew' : 'Message quota used up, please upgrade your plan',
            usage: accView(req.acc)
        });
    }

    const s = ensureSession(req.acc);
    if (!s.ready) await waitReady(s, 25000);
    if (!s.ready) {
        return res.status(503).json({
            ok: false,
            code: s.qrImg ? 'qr_required' : 'not_ready',
            error: s.qrImg ? 'This account needs a QR scan (use /qr)' : 'The session is not ready yet, try again in a few seconds'
        });
    }

    const number = String(rawNumber).replace(/\D/g, '');
    const message = rawMessage.trim();
    if (number.length < 11 || number.length > 12 || !message) {
        return res.status(400).json({ ok: false, error: 'Number or message is missing' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ ok: false, error: 'Message is too long' });

    const prevSent = s.lastSent;
    if (Date.now() - s.lastSent < MIN_GAP_MS) return res.status(429).json({ ok: false, error: 'Wait a few seconds and try again' });
    s.lastSent = Date.now();

    let r;
    try { r = await reserve(email); }
    catch (err) {
        console.error(err); s.lastSent = prevSent;
        return res.status(500).json({ ok: false, error: 'Could not read usage data' });
    }
    if (!r.ok) {
        s.lastSent = prevSent;
        if (r.error === 'noacct') return res.status(404).json({ ok: false, error: 'No such account' });
        return res.status(402).json({
            ok: false,
            code: r.error === 'expired' ? 'plan_expired' : 'quota_exceeded',
            error: r.error === 'expired' ? 'Plan expired, please renew' : 'Message quota used up, please upgrade your plan',
            usage: accView(r.acc)
        });
    }

    try {
        const [w] = await s.sock.onWhatsApp(number);
        if (!w || !w.exists) {
            await refund(email); r.acc.used--;
            return res.status(404).json({ ok: false, error: 'Number is not on WhatsApp', usage: accView(r.acc) });
        }
        await s.sock.sendMessage(w.jid, { text: message });
        res.json({ ok: true, usage: accView(r.acc) });
    } catch (err) {
        console.error(err);
        await refund(email).catch(() => {});
        res.status(500).json({ ok: false, error: 'Failed to send' });
    }
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Request too large' });
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🌐 API running on port ${PORT}`);
    // Bring every saved account's WhatsApp session back online (staggered)
    try {
        const all = await store.all();
        all.forEach((acc, i) => setTimeout(() => ensureSession(acc), i * BOOT_STAGGER_MS));
        console.log(`👥 Restoring ${all.length} session(s)`);
    } catch (e) { console.error('⚠️ Could not load accounts:', e.message); }
});