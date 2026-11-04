import express from 'express';
import session from 'express-session';
import multer from 'multer';
import sharp from 'sharp';
import * as oidc from 'openid-client';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createApp(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const demo = env.DEMO_AUTH === 'true';
  const baseURL = env.BASE_URL || 'http://localhost:3000';
  const secret = env.SESSION_SECRET || (production ? '' : randomBytes(48).toString('hex'));
  if (production && (demo || secret.length < 32 || !baseURL.startsWith('https://'))) {
    throw new Error('Production requires HTTPS BASE_URL, SESSION_SECRET of at least 32 characters, and DEMO_AUTH disabled.');
  }
  if (!demo && (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.COMPANY_EMAIL_DOMAIN)) {
    throw new Error('Configure OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and COMPANY_EMAIL_DOMAIN, or use npm run dev locally.');
  }
  if (!demo && !/^https:\/\/login\.microsoftonline\.com\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\/v2\.0\/?$/i.test(env.OIDC_ISSUER)) {
    throw new Error('Use your tenant-specific Microsoft Entra issuer: https://login.microsoftonline.com/TENANT_UUID/v2.0');
  }
  const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
  const uploads = path.join(dataDir, 'uploads');
  mkdirSync(uploads, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL, image TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS votes (user_id TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id), PRIMARY KEY(user_id,entry_id));
    CREATE TRIGGER IF NOT EXISTS vote_budget BEFORE INSERT ON votes
      WHEN (SELECT count(*) FROM votes WHERE user_id=NEW.user_id)>=3
      BEGIN SELECT RAISE(ABORT, 'vote limit reached'); END;
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);`);
  class SQLiteStore extends session.Store {
    get(sid, cb) {
      try {
        const row = db.prepare('SELECT value FROM sessions WHERE sid=? AND expires>?').get(sid, Date.now());
        cb(null, row ? JSON.parse(row.value) : null);
      } catch (e) { cb(e); }
    }
    set(sid, value, cb = () => {}) {
      try {
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(sid, JSON.stringify(value), new Date(value.cookie.expires).getTime());
        cb();
      } catch (e) { cb(e); }
    }
    destroy(sid, cb = () => {}) {
      try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(); } catch (e) { cb(e); }
    }
  }
  const app = express();
  app.disable('x-powered-by');
  // Deploy behind exactly one trusted reverse proxy; do not expose the Node port publicly.
  if (production) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Cache-Control': 'no-store'
    });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(session({
    store: new SQLiteStore(), secret, name: 'thanksgiving.sid', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 8 * 60 * 60 * 1000 }
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    req.session.csrf ||= randomBytes(32).toString('hex');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-CSRF-Token') !== req.session.csrf) {
      return next(fail(403, 'Please refresh the page and try again.'));
    }
    next();
  });
  const auth = (req, res, next) => req.session.user ? next() : next(fail(401, 'Sign in to continue.'));
  const login = (req, user) => new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      db.prepare('INSERT INTO users VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(user.id, user.name);
      req.session.user = user;
      req.session.csrf = randomBytes(32).toString('hex');
      req.session.save(error => error ? reject(error) : resolve());
    });
  });
  let configPromise;
  const config = () => configPromise ||= oidc.discovery(new URL(env.OIDC_ISSUER), env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET).catch(e => { configPromise = null; throw e; });
  app.get('/api/me', (req, res) => {
    const used = req.session.user ? db.prepare('SELECT count(*) AS n FROM votes WHERE user_id=?').get(req.session.user.id).n : 0;
    res.json({ user: req.session.user || null, csrf: req.session.csrf, remainingVotes: 3 - used, demo });
  });
  app.get('/auth/login', async (req, res) => {
    if (demo) return res.redirect('/?signin=demo');
    const client = await config();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    req.session.oidc = { verifier, state, nonce, started: Date.now() };
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: new URL('/auth/callback', baseURL).href, scope: 'openid profile email',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce
    });
    await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
    res.redirect(url.href);
  });
  app.get('/auth/callback', async (req, res) => {
    if (demo) throw fail(404, 'SSO is disabled in demo mode.');
    const pending = req.session.oidc;
    delete req.session.oidc;
    if (!pending || Date.now() - pending.started > 10 * 60 * 1000) throw fail(400, 'Sign-in expired. Please try again.');
    const client = await config();
    const callback = new URL('/auth/callback', baseURL);
    callback.search = new URL(req.originalUrl, baseURL).search;
    const tokens = await oidc.authorizationCodeGrant(client, callback, {
      pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true
    });
    const claims = tokens.claims();
    // Identity comes from the validated issuer and subject, never an editable email address.
    const email = String(claims.email || claims.preferred_username || '').toLowerCase();
    const domain = env.COMPANY_EMAIL_DOMAIN.toLowerCase();
    if (email.split('@').length !== 2 || email.split('@')[1] !== domain || claims.email_verified === false) {
      throw fail(403, 'Please use your company account.');
    }
    await login(req, { id: `${claims.iss}|${claims.sub}`, name: String(claims.name || email.split('@')[0]).slice(0, 100) });
    res.redirect('/');
  });
  app.post('/auth/demo', async (req, res) => {
    if (!demo) throw fail(404, 'Not found.');
    const names = { alex: 'Alex Morgan', sam: 'Sam Rivera', jordan: 'Jordan Lee', taylor: 'Taylor Chen' };
    if (!Object.hasOwn(names, req.body.account || '')) throw fail(400, 'Choose a demo account.');
    await login(req, { id: `demo:${req.body.account}`, name: names[req.body.account] });
    res.json({ ok: true });
  });
  app.post('/auth/logout', (req, res, next) => req.session.destroy(e => {
    if (e) return next(e);
    res.clearCookie('thanksgiving.sid'); res.json({ ok: true });
  }));
  app.get('/api/entries', auth, (req, res) => {
    res.json(db.prepare(`SELECT e.id,e.title,e.description,e.created_at,u.name AS author,
      '/photos/'||e.image AS image, count(v.user_id) AS votes,
      EXISTS(SELECT 1 FROM votes mine WHERE mine.entry_id=e.id AND mine.user_id=?) AS voted,
      e.user_id=? AS mine
      FROM entries e JOIN users u ON e.user_id=u.id LEFT JOIN votes v ON v.entry_id=e.id
      GROUP BY e.id ORDER BY e.created_at DESC,e.id`).all(req.session.user.id, req.session.user.id));
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2, fieldSize: 4096 } });
  app.post('/api/entries', auth, upload.single('photo'), async (req, res) => {
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    if (!title || title.length > 80 || description.length > 600 || !req.file) throw fail(400, 'Add a title (up to 80 characters), a photo, and a description of up to 600 characters.');
    if (db.prepare('SELECT id FROM entries WHERE user_id=?').get(req.session.user.id)) throw fail(409, 'You have already submitted your creation.');
    let photo;
    try {
      const source = sharp(req.file.buffer, { limitInputPixels: 25_000_000, animated: false });
      const metadata = await source.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('format');
      photo = await source.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    } catch { throw fail(400, 'Use a valid JPG, PNG, or WebP photo, at most 8 MB and 25 megapixels.'); }
    const filename = `${randomUUID()}.webp`;
    const filepath = path.join(uploads, filename);
    writeFileSync(filepath, photo, { flag: 'wx' });
    try {
      db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?)').run(randomUUID(), req.session.user.id, title, description, filename, new Date().toISOString());
    } catch (error) {
      unlinkSync(filepath);
      if (error.code?.startsWith('ERR_SQLITE') && /UNIQUE/.test(error.message)) throw fail(409, 'You have already submitted your creation.');
      throw error;
    }
    res.status(201).json({ ok: true });
  });
  app.post('/api/entries/:id/vote', auth, (req, res) => {
    const user = req.session.user.id;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT id FROM entries WHERE id=?').get(req.params.id)) throw fail(404, 'Creation not found.');
      if (db.prepare('SELECT 1 FROM votes WHERE user_id=? AND entry_id=?').get(user, req.params.id)) throw fail(409, 'You have already voted for this creation.');
      if (db.prepare('SELECT count(*) AS n FROM votes WHERE user_id=?').get(user).n >= 3) throw fail(409, 'You have used all three votes.');
      db.prepare('INSERT INTO votes VALUES (?,?)').run(user, req.params.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ ok: true });
  });
  app.use('/photos', auth, express.static(uploads, { dotfiles: 'deny', index: false }));
  app.use(express.static(path.join(root, 'public')));
  app.use((req, res, next) => next(fail(404, 'Not found.')));
  app.use((error, req, res, next) => {
    const status = error instanceof multer.MulterError ? 400 : error.status || 500;
    if (status === 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: error instanceof multer.MulterError ? 'Upload one photo, at most 8 MB.' : status === 500 ? 'Something went wrong. Please try again.' : error.message });
  });
  return { app, db };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Fortified Thanksgiving listening on port ${process.env.PORT || 3000}${process.env.DEMO_AUTH === 'true' ? ' (LOCAL DEMO — not company SSO)' : ''}`));
}
