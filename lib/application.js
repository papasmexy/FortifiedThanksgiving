import express from 'express';
import session from 'express-session';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from './database.js';
import { token, digest, equal, hashPassword, checkPassword, totpSecret, verifyTotp, seal, unseal, fullName, roomCode } from './security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const now = () => new Date().toISOString();
const text = (v, max, required = false) => {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw fail(400, 'Please check the required text fields and their length limits.');
  return v.trim();
};
const username = v => { if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,39}$/i.test(v)) throw fail(400, 'Use an admin username of 3–40 letters, numbers, dots, dashes or underscores.'); return v.toLowerCase(); };
const publicAdmin = a => a ? { id: a.id, username: a.username, disabled: !!a.disabled } : null;
const publicRoom = r => { const { code_hash, ...value } = r; return value; };

export function createApp(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const baseURL = env.BASE_URL || 'http://localhost:3000';
  const origin = new URL(baseURL);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !['http:', 'https:'].includes(origin.protocol)) throw new Error('BASE_URL must be an origin without credentials, a path, query or fragment.');
  if (production && (origin.protocol !== 'https:' || (env.SESSION_SECRET || '').length < 32 || (env.ADMIN_ENCRYPTION_KEY || '').length < 32)) throw new Error('Production requires HTTPS BASE_URL, SESSION_SECRET and ADMIN_ENCRYPTION_KEY (independent random secrets, at least 32 characters each).');
  if (!production && !['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) throw new Error('Development must use a loopback BASE_URL.');
  if (env.SESSION_SECRET && env.SESSION_SECRET === env.ADMIN_ENCRYPTION_KEY) throw new Error('Use independent session and admin encryption secrets.');
  const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
  const uploads = path.join(dataDir, 'room-uploads');
  mkdirSync(uploads, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dataDir, '.local-admin-key');
  if (!production && !env.ADMIN_ENCRYPTION_KEY && !existsSync(keyFile)) writeFileSync(keyFile, token() + token(), { flag: 'wx', mode: 0o600 });
  const key = env.ADMIN_ENCRYPTION_KEY || readFileSync(keyFile, 'utf8');
  const secret = env.SESSION_SECRET || digest(key, 'development', 'session');
  const db = openDatabase(dataDir);
  const fingerprint = digest(key, 'key-check', 'rooms-v1');
  const saved = db.prepare("SELECT value FROM config WHERE key='key-check'").get();
  if (saved && !equal(saved.value, fingerprint)) { db.close(); throw new Error('ADMIN_ENCRYPTION_KEY changed. Restore the original key; do not reset the database.'); }
  db.prepare("INSERT OR IGNORE INTO config VALUES ('key-check',?)").run(fingerprint);
  if (production && !db.prepare('SELECT 1 FROM admins LIMIT 1').get() && (env.ADMIN_SETUP_TOKEN || '').length < 32) { db.close(); throw new Error('First admin setup requires a random ADMIN_SETUP_TOKEN of at least 32 characters.'); }
  const setting = (name, fallback = '') => db.prepare('SELECT value FROM config WHERE key=?').get(name)?.value ?? fallback;
  const audit = (admin, action, room = null, target = null) => db.prepare('INSERT INTO audit(admin_id,action,room_id,target,created_at) VALUES (?,?,?,?,?)').run(admin?.id || null, action, room, target, now());
  class Store extends session.Store {
    get(sid, cb) { try { const r = db.prepare('SELECT value FROM sessions WHERE sid=? AND expires>?').get(sid, Date.now()); cb(null, r ? JSON.parse(r.value) : null); } catch (e) { cb(e); } }
    set(sid, value, cb = () => {}) { try { db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now()); db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(sid, JSON.stringify(value), new Date(value.cookie.expires).getTime()); cb(); } catch (e) { cb(e); } }
    destroy(sid, cb = () => {}) { try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(); } catch (e) { cb(e); } }
  }
  const app = express();
  app.disable('x-powered-by'); if (production) app.set('trust proxy', 1);
  sharp.cache({ memory: 16, files: 0, items: 20 }); sharp.concurrency(1);
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(),microphone=(),geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000'); next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: db.prepare('SELECT 1 AS ok').get().ok === 1 }));
  const sessionName = production ? '__Host-ft.sid' : 'ft.sid';
  const memberCookie = production ? '__Host-ft.member' : 'ft.member';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', path: '/' };
  app.use(session({ store: new Store(), secret, name: sessionName, resave: false, saveUninitialized: false, cookie: { ...cookieOptions, maxAge: 7 * 86400000 } }));
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    req.session.csrf ||= token();
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && !equal(req.get('X-CSRF-Token'), req.session.csrf)) return next(fail(403, 'Refresh this page and try again.'));
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('Origin') && req.get('Origin') !== origin.origin) return next(fail(403, 'Requests must come from this site.'));
    const a = req.session.admin && db.prepare('SELECT * FROM admins WHERE id=?').get(req.session.admin.id);
    if (a && !a.disabled && a.version === req.session.admin.version && Date.now() - req.session.admin.since < 8 * 3600000) req.admin = a;
    else if (req.session.admin) delete req.session.admin;
    next();
  });
  const admin = (req, res, next) => req.admin ? next() : next(fail(401, 'Administrator sign-in required.'));
  const limiter = (limit, windowMs) => rateLimit({ limit, windowMs, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Wait and try again.' } });
  app.use('/api/join', limiter(500, 15 * 60000)); // Allows an office sharing one NAT; admin approval controls new-name abuse.
  app.use('/api/admin/login', limiter(15, 15 * 60000));
  app.use('/api/admin/enroll', limiter(20, 15 * 60000));
  app.use('/api', (req, res, next) => {
    if (setting('maintenance', 'false') === 'true' && !req.path.startsWith('/admin') && !req.admin && !['/me','/site','/logout'].includes(req.path)) return next(fail(503, setting('maintenanceMessage', 'The competition is temporarily paused. Please check back soon.')));
    next();
  });
  const roomFor = id => { const r = db.prepare('SELECT * FROM rooms WHERE id=?').get(id); if (!r) throw fail(404, 'Room not found.'); return r; };
  function membership(req, id) {
    const room = roomFor(id); const access = req.session.rooms?.[id];
    if (req.admin) return { room, member: null };
    const member = access && db.prepare('SELECT * FROM members WHERE id=? AND room_id=?').get(access.id, id);
    if (!member || member.status === 'banned' || access.version !== room.version || !equal(access.keyTag, member.credential_hash) || room.status === 'archived') throw fail(403, 'Enter this room using its current access code.');
    return { room, member };
  }
  function canAct(room, member, kind) {
    if (!member || member.status !== 'approved') throw fail(403, 'Your participation is awaiting administrator approval.');
    if (room.status !== 'active' || (room.starts_at && Date.now() < Date.parse(room.starts_at)) || !room[kind + '_open'] || (room[kind + '_end_at'] && Date.now() >= Date.parse(room[kind + '_end_at']))) throw fail(409, kind === 'voting' ? 'Voting is closed for this room.' : 'Submissions are closed for this room.');
  }
  function listings(roomId, member, all = false) {
    return db.prepare(`SELECT e.id,e.title,e.description,e.status,e.created_at,m.name AS author,e.member_id,
      '/photos/'||e.id AS image,
      (SELECT count(*) FROM votes v JOIN members voter ON voter.id=v.member_id WHERE v.entry_id=e.id AND voter.status='approved') AS votes,
      EXISTS(SELECT 1 FROM votes v WHERE v.entry_id=e.id AND v.member_id=?) AS voted,e.member_id=? AS mine
      FROM entries e JOIN members m ON m.id=e.member_id WHERE e.room_id=? ${all ? '' : "AND e.status='published' AND m.status='approved'"} ORDER BY e.created_at DESC,e.id`).all(member?.id || '', member?.id || '', roomId).map(({ member_id, ...r }) => r);
  }
  const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
  const save = req => new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
  const cookieValue = req => { try { return decodeURIComponent((req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(memberCookie + '='))?.slice(memberCookie.length + 1) || ''); } catch { return ''; } };
  app.get('/api/site', (req, res) => res.json({ title: setting('siteTitle', 'Fortified Thanksgiving'), tagline: setting('tagline', 'Good things happen around a table.'), maintenance: setting('maintenance', 'false') === 'true', message: setting('maintenanceMessage'), logo: setting('logo') ? '/brand-logo' : null }));
  app.get('/api/me', (req, res) => {
    let access = null;
    if (req.query.room) { try { const { room, member } = membership(req, String(req.query.room)); if (member) access = { room: publicRoom(room), member: { id: member.id, name: member.name, status: member.status }, remainingVotes: 3 - db.prepare('SELECT count(*) AS n FROM votes WHERE member_id=?').get(member.id).n, hasEntry: !!db.prepare('SELECT 1 FROM entries WHERE member_id=?').get(member.id) }; } catch {} }
    res.json({ csrf: req.session.csrf, admin: publicAdmin(req.admin), access, local: !production });
  });
  app.post('/api/join', async (req, res) => {
    if(req.admin)throw fail(409,'Use a private browser window to participate while signed in as an administrator.');
    const name = fullName(req.body.name); const code = roomCode(req.body.code);
    const room = db.prepare('SELECT * FROM rooms WHERE code_hash=?').get(digest(key, 'room-code', code));
    if (!room || (req.body.roomId && room.id !== req.body.roomId) || room.status === 'archived' || room.status === 'draft' || !room.join_open) throw fail(403, 'This room code is invalid or entry is closed.');
    let member = db.prepare('SELECT * FROM members WHERE room_id=? AND name_key=?').get(room.id, name.normalized);
    let personalKey;
    if (member) {
      const cookie = cookieValue(req).split('.');
      const supplied = req.body.personalKey || (cookie[0] === member.id ? cookie[1] : '');
      if (member.status === 'banned' || !equal(member.credential_hash, digest(key, 'member-key', String(supplied)))) throw fail(409, 'This name is already registered. Use your saved personal sign-in key or ask an administrator for recovery.', { needsKey: true });
    } else {
      personalKey = token(); member = { id: randomUUID(), name: name.name, status: room.approval_required ? 'pending' : 'approved' };
      member.credential_hash = digest(key, 'member-key', personalKey);
      try { db.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?)').run(member.id, room.id, name.name, name.normalized, member.credential_hash, member.status, now()); }
      catch (e) { if (/UNIQUE/.test(e.message)) throw fail(409, 'This name was just registered. Please sign in again.'); throw e; }
    }
    const remembered = personalKey || req.body.personalKey || cookieValue(req).split('.')[1];
    const rooms = req.session.rooms || {};
    await regenerate(req); req.session.csrf = token(); req.session.rooms = { ...rooms, [room.id]: { id: member.id, version: room.version, keyTag: member.credential_hash } };
    res.cookie(memberCookie, member.id + '.' + remembered, { ...cookieOptions, maxAge: 30 * 86400000 });
    await save(req); res.json({ roomId: room.id, personalKey: personalKey || null });
  });
  app.post('/api/logout', (req, res, next) => req.session.destroy(e => { if (e) return next(e); res.clearCookie(sessionName, cookieOptions); res.clearCookie(memberCookie, cookieOptions); res.json({ ok: true }); }));
  app.get('/api/rooms/:id', (req, res) => { const { room, member } = membership(req, req.params.id); res.json({ room: publicRoom(room), entries: member && member.status !== 'approved' ? [] : listings(room.id, member) }); });
  let imageOwner = null;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2, fieldSize: 4096 } });
  const slot = (req, res, next) => {
    if (imageOwner) { res.set('Retry-After', '3'); return next(fail(429, 'Another photo is processing. Try again in a moment.')); }
    const owner = Symbol(); imageOwner = owner; res.locals.owner = owner;
    res.once('close', () => { if (!res.locals.processing && imageOwner === owner) imageOwner = null; }); next();
  };
  const picture = async buffer => {
    try {
      const png=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg=buffer.subarray(0,3).equals(Buffer.from([255,216,255]));
      const webp=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';
      if(!png&&!jpeg&&!webp)throw new Error('signature');
      const image = sharp(buffer, { limitInputPixels: 25000000, animated: false }); const meta = await image.metadata(); if (!['jpeg','png','webp'].includes(meta.format)) throw new Error('format'); return await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(); }
    catch { throw fail(400, 'Use a valid JPG, PNG or WebP photo, at most 8 MB and 25 megapixels.'); }
  };
  app.post('/api/rooms/:id/entries', (req, res, next) => { try { const a = membership(req, req.params.id); canAct(a.room, a.member, 'submissions'); req.access = a; next(); } catch (e) { next(e); } }, slot, upload.single('photo'), async (req, res) => {
    res.locals.processing = true;
    try {
      const title = text(req.body.title, 80, true), description = text(req.body.description || '', 600); if (!req.file) throw fail(400, 'Choose a photo.');
      const photo = await picture(req.file.buffer); const filename = randomUUID() + '.webp'; const file = path.join(uploads, filename);
      writeFileSync(file, photo, { flag: 'wx', mode: 0o600 });
      try { transaction(db, () => {
        const { room, member } = membership(req, req.params.id); canAct(room, member, 'submissions');
        db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), room.id, member.id, title, description, filename, 'published', now());
      }); } catch (e) { unlinkSync(file); if (/UNIQUE/.test(e.message)) throw fail(409, 'You already submitted a creation in this room.'); throw e; }
      res.status(201).json({ ok: true });
    } finally { res.locals.processing = false; if (imageOwner === res.locals.owner) imageOwner = null; }
  });
  app.post('/api/rooms/:id/entries/:entry/vote', (req, res) => {
    transaction(db, () => {
      const { room, member } = membership(req, req.params.id); canAct(room, member, 'voting');
      const entry = db.prepare("SELECT e.id FROM entries e JOIN members m ON m.id=e.member_id WHERE e.id=? AND e.room_id=? AND e.status='published' AND m.status='approved'").get(req.params.entry, room.id);
      if (!entry) throw fail(404, 'Creation not available in this room.');
      if (db.prepare('SELECT 1 FROM votes WHERE member_id=? AND entry_id=?').get(member.id, entry.id)) throw fail(409, 'You already voted for this creation.');
      if (db.prepare('SELECT count(*) AS n FROM votes WHERE member_id=?').get(member.id).n >= 3) throw fail(409, 'You have used all three votes in this room.');
      db.prepare('INSERT INTO votes VALUES (?,?,?,?)').run(member.id, entry.id, room.id, now());
    }); res.json({ ok: true });
  });
  app.get('/photos/:id', (req, res) => {
    const entry = db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id); if (!entry) throw fail(404, 'Photo not found.');
    const { room, member } = membership(req, entry.room_id);
    if (!req.admin && member.status !== 'approved') throw fail(403, 'Organizer approval is required to view room photos.');
    const author = db.prepare('SELECT status FROM members WHERE id=?').get(entry.member_id);
    if (!req.admin && (entry.status !== 'published' || author.status !== 'approved')) throw fail(404, 'Photo not found.');
    res.sendFile(path.join(uploads, entry.image));
  });

  app.get('/api/admin/status', (req, res) => res.json({ setupRequired: !db.prepare('SELECT 1 FROM admins LIMIT 1').get(), localSetup: !production, admin: publicAdmin(req.admin) }));
  const dummyPassword = hashPassword(token() + token());
  async function verifyAdmin(req) {
    const original = req.admin || db.prepare('SELECT * FROM admins WHERE username=?').get(String(req.body.username || '').toLowerCase());
    const stored = original?.password_hash || await dummyPassword;
    const pass = await checkPassword(req.body.password, stored);
    const a = original && db.prepare('SELECT * FROM admins WHERE id=?').get(original.id);
    if (!a || a.disabled || a.version !== original.version || a.password_hash !== original.password_hash || a.locked_until > Date.now()) throw fail(401, 'Invalid administrator credentials or account temporarily locked.');
    const step = pass ? verifyTotp(unseal(a.totp_secret, key), req.body.otp, a.last_step) : null;
    if (step === null) {
      db.prepare('UPDATE admins SET failed=failed+1,locked_until=CASE WHEN failed+1>=5 THEN ? ELSE locked_until END WHERE id=?').run(Date.now() + 15 * 60000, a.id);
      throw fail(401, 'Invalid credentials. Use a fresh authenticator code. Repeated failures lock sign-in for 15 minutes.');
    }
    const changed = db.prepare('UPDATE admins SET last_step=?,failed=0,locked_until=0 WHERE id=? AND last_step<?').run(step, a.id, step);
    if (!changed.changes) throw fail(401, 'Wait for a fresh authenticator code.'); return a;
  }
  const reauth = async (req, res, next) => { try { await verifyAdmin(req); next(); } catch (e) { next(e); } };
  async function adminSession(req, a) { await regenerate(req); req.session.csrf = token(); req.session.admin = { id: a.id, version: a.version, since: Date.now() }; req.session.cookie.maxAge = 8 * 3600000; await save(req); }
  app.post('/api/admin/login', async (req, res) => { const a = await verifyAdmin(req); await adminSession(req, a); audit(a, 'admin.login'); res.json({ ok: true }); });
  app.post('/api/admin/enroll', async (req, res) => {
    const name = username(req.body.username); const count = db.prepare('SELECT count(*) AS n FROM admins').get().n;
    let source = 'bootstrap', inviteHash = null;
    if (req.body.invitation) {
      inviteHash = digest(key, 'admin-invite', String(req.body.invitation)); const invite = db.prepare('SELECT * FROM admin_invites WHERE hash=? AND used=0 AND expires>? AND username=?').get(inviteHash, Date.now(), name);
      if (!invite) throw fail(403, 'This admin invitation is invalid or expired.'); source = 'invite';
    } else if (count || (production && !equal(String(req.body.setupToken || ''), env.ADMIN_SETUP_TOKEN))) throw fail(403, 'Administrator setup is unavailable or the setup token is incorrect.');
    const hash = await hashPassword(req.body.password); const otpSecret = totpSecret();
    req.session.enrollment = { username: name, hash, otp: seal(otpSecret, key), source, inviteHash, until: Date.now() + 10 * 60000 };
    await save(req); res.json({ secret: otpSecret, uri: 'otpauth://totp/FortifiedThanksgiving:' + encodeURIComponent(name) + '?secret=' + otpSecret + '&issuer=FortifiedThanksgiving&digits=6&period=30' });
  });
  app.post('/api/admin/enroll/confirm', async (req, res) => {
    const pending = req.session.enrollment; if (!pending || pending.until < Date.now()) throw fail(400, 'Start admin enrollment again.');
    const step = verifyTotp(unseal(pending.otp, key), req.body.otp); if (step === null) throw fail(400, 'The authenticator code is incorrect.');
    const a = transaction(db, () => {
      const count = db.prepare('SELECT count(*) AS n FROM admins').get().n;
      let target = null;
      if (pending.source === 'bootstrap') { if (count) throw fail(409, 'The first administrator has already been created.'); }
      else { const invite = db.prepare('SELECT * FROM admin_invites WHERE hash=? AND used=0 AND expires>?').get(pending.inviteHash, Date.now()); if (!invite) throw fail(403, 'Invitation expired or already used.'); target = invite.target_id; db.prepare('UPDATE admin_invites SET used=1 WHERE hash=?').run(pending.inviteHash); }
      if (target) db.prepare('UPDATE admins SET password_hash=?,totp_secret=?,last_step=?,version=version+1,disabled=0,failed=0,locked_until=0 WHERE id=?').run(pending.hash, pending.otp, step, target);
      else { if (count >= 2) throw fail(409, 'This site supports at most two admin accounts.'); target = randomUUID(); db.prepare('INSERT INTO admins(id,username,password_hash,totp_secret,last_step) VALUES (?,?,?,?,?)').run(target, pending.username, pending.hash, pending.otp, step); }
      const created = db.prepare('SELECT * FROM admins WHERE id=?').get(target); audit(created, 'admin.enrolled'); return created;
    });
    await adminSession(req, a); res.json({ ok: true });
  });
  app.get('/api/admin/overview', admin, (req, res) => res.json({
    rooms: db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all().map(r => ({ ...publicRoom(r), participants: db.prepare('SELECT count(*) AS n FROM members WHERE room_id=?').get(r.id).n, entries: db.prepare('SELECT count(*) AS n FROM entries WHERE room_id=?').get(r.id).n })),
    admins: db.prepare('SELECT id,username,disabled FROM admins').all(),
    audit: db.prepare('SELECT a.*,u.username FROM audit a LEFT JOIN admins u ON u.id=a.admin_id ORDER BY a.id DESC LIMIT 100').all(),
    site: { title: setting('siteTitle','Fortified Thanksgiving'), tagline: setting('tagline','Good things happen around a table.'), maintenance: setting('maintenance','false') === 'true', message: setting('maintenanceMessage') }
  }));
  app.post('/api/admin/invites', admin, reauth, (req, res) => {
    const name = username(req.body.username); const target = db.prepare('SELECT * FROM admins WHERE username=?').get(name);
    if (target?.id === req.admin.id) throw fail(400, 'Use your account settings to change your own password.');
    if (!target && db.prepare('SELECT count(*) AS n FROM admins').get().n >= 2) throw fail(409, 'Both admin accounts already exist. Invite an existing username to recover that account.');
    const invitation = token(); const hash = digest(key, 'admin-invite', invitation);
    transaction(db, () => { db.prepare('UPDATE admin_invites SET used=1 WHERE username=?').run(name); db.prepare('INSERT INTO admin_invites VALUES (?,?,?,?,0)').run(hash, name, target?.id || null, Date.now() + 86400000); audit(req.admin, 'admin.invited', null, target?.id || null); });
    res.json({ invitation, url: origin.origin + '/admin#invite=' + invitation, username: name });
  });
  app.post('/api/admin/accounts/:id', admin, reauth, (req, res) => {
    if (req.params.id === req.admin.id) throw fail(400, 'You cannot disable your own administrator account.');
    if (typeof req.body.disabled !== 'boolean') throw fail(400, 'Choose enabled or disabled.');
    const change = db.prepare('UPDATE admins SET disabled=?,version=version+1 WHERE id=?').run(Number(req.body.disabled), req.params.id); if (!change.changes) throw fail(404, 'Admin not found.'); audit(req.admin, 'admin.access_changed', null, req.params.id); res.json({ ok: true });
  });
  app.post('/api/admin/password', admin, reauth, async (req, res) => {
    const hash = await hashPassword(req.body.newPassword); db.prepare('UPDATE admins SET password_hash=?,version=version+1 WHERE id=?').run(hash, req.admin.id);
    const a = db.prepare('SELECT * FROM admins WHERE id=?').get(req.admin.id); audit(a, 'admin.password_changed'); await adminSession(req, a); res.json({ ok: true });
  });
  function roomFields(body) {
    const out = {};
    if ('title' in body) out.title = text(body.title, 100, true);
    if ('description' in body) out.description = text(body.description, 600);
    if ('status' in body) { if (!['draft','active','closed','archived'].includes(body.status)) throw fail(400,'Choose a valid room status.'); out.status = body.status; }
    for (const b of ['join_open','submissions_open','voting_open','approval_required']) if (b in body) { if (typeof body[b] !== 'boolean') throw fail(400, 'Invalid room setting.'); out[b] = Number(body[b]); }
    for (const d of ['starts_at','submissions_end_at','voting_end_at']) if (d in body) { if (body[d] && (typeof body[d] !== 'string' || !Number.isFinite(Date.parse(body[d])))) throw fail(400, 'Check the competition dates.'); out[d] = body[d] ? new Date(body[d]).toISOString() : null; }
    return out;
  }
  function checkDates(r) { for (const end of [r.submissions_end_at,r.voting_end_at]) if (end && r.starts_at && end <= r.starts_at) throw fail(400, 'Deadlines must be after the competition start.'); }
  app.post('/api/admin/rooms', admin, (req, res) => {
    const fields = roomFields(req.body); if (!fields.title) throw fail(400, 'Give the room a title.');
    const code = roomCode(req.body.code); if (code.length < 10 || code.length > 64 || /[\p{Cc}\p{Cf}]/u.test(code)) throw fail(400, 'Choose an access code of 10–64 characters.');
    const r = { id: randomUUID(), title: fields.title, description: '', code_hash: digest(key,'room-code',code), status: 'active', join_open: 1, submissions_open: 1, voting_open: 0, approval_required: 1, starts_at: null, submissions_end_at: null, voting_end_at: null, ...fields };
    checkDates(r);
    try { transaction(db, () => { db.prepare('INSERT INTO rooms(id,title,description,code_hash,status,join_open,submissions_open,voting_open,approval_required,starts_at,submissions_end_at,voting_end_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...['id','title','description','code_hash','status','join_open','submissions_open','voting_open','approval_required','starts_at','submissions_end_at','voting_end_at'].map(k => r[k]),now()); audit(req.admin,'room.created',r.id); }); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw fail(409, 'Choose a different access code; it is already in use.'); throw e; }
    res.status(201).json({ room: publicRoom(roomFor(r.id)), url: origin.origin + '/r/' + r.id });
  });
  app.get('/api/admin/rooms/:id', admin, (req, res) => {
    const r = roomFor(req.params.id); res.json({ room: publicRoom(r), entries: listings(r.id,null,true), members: db.prepare('SELECT id,name,status,created_at,(SELECT count(*) FROM votes v WHERE v.member_id=m.id) AS votes_used FROM members m WHERE room_id=? ORDER BY created_at DESC').all(r.id) });
  });
  app.post('/api/admin/rooms/:id', admin, (req, res) => {
    const r = roomFor(req.params.id), fields = roomFields(req.body); checkDates({ ...r,...fields });
    transaction(db, () => { for (const [column,value] of Object.entries(fields)) db.prepare('UPDATE rooms SET ' + column + '=? WHERE id=?').run(value,r.id); audit(req.admin,'room.updated',r.id); }); res.json({ ok: true });
  });
  app.post('/api/admin/rooms/:id/code', admin, (req, res) => {
    const r = roomFor(req.params.id); const code = roomCode(req.body.code); if (code.length < 10 || code.length > 64 || /[\p{Cc}\p{Cf}]/u.test(code)) throw fail(400, 'Use a code of 10–64 characters.');
    try { transaction(db, () => { db.prepare('UPDATE rooms SET code_hash=?,version=version+1 WHERE id=?').run(digest(key,'room-code',code),r.id); audit(req.admin,'room.code_rotated',r.id); }); } catch (e) { if (/UNIQUE/.test(e.message)) throw fail(409,'Code already in use.'); throw e; }
    res.json({ ok: true });
  });
  app.post('/api/admin/members/:id', admin, (req, res) => {
    const m = db.prepare('SELECT * FROM members WHERE id=?').get(req.params.id); if (!m) throw fail(404,'Participant not found.');
    if (!['approved','pending','banned'].includes(req.body.status)) throw fail(400,'Choose approved, pending or banned.');
    transaction(db, () => { db.prepare('UPDATE members SET status=? WHERE id=?').run(req.body.status,m.id); audit(req.admin,'participant.' + req.body.status,m.room_id,m.id); }); res.json({ ok: true });
  });
  app.post('/api/admin/rooms/:id/approve-pending', admin, (req, res) => { const r=roomFor(req.params.id); transaction(db,()=>{ db.prepare("UPDATE members SET status='approved' WHERE room_id=? AND status='pending'").run(r.id);audit(req.admin,'participants.approved_pending',r.id); }); res.json({ ok:true }); });
  app.post('/api/admin/members/:id/recovery', admin, reauth, (req, res) => {
    const m=db.prepare('SELECT * FROM members WHERE id=?').get(req.params.id);if(!m)throw fail(404,'Participant not found.');
    const personalKey=token();transaction(db,()=>{db.prepare('UPDATE members SET credential_hash=? WHERE id=?').run(digest(key,'member-key',personalKey),m.id);audit(req.admin,'participant.recovery',m.room_id,m.id);});
    // Invalidate existing participant sessions; the new key is needed to sign in again.
    for(const s of db.prepare('SELECT sid,value FROM sessions').all()){const data=JSON.parse(s.value);if(data.rooms?.[m.room_id]?.id===m.id){delete data.rooms[m.room_id];db.prepare('UPDATE sessions SET value=? WHERE sid=?').run(JSON.stringify(data),s.sid);}}
    res.json({ personalKey });
  });
  app.post('/api/admin/members/:id/name',admin,(req,res)=>{
    const m=db.prepare('SELECT * FROM members WHERE id=?').get(req.params.id);if(!m)throw fail(404,'Participant not found.');const name=fullName(req.body.name);
    try{transaction(db,()=>{db.prepare('UPDATE members SET name=?,name_key=? WHERE id=?').run(name.name,name.normalized,m.id);audit(req.admin,'participant.renamed',m.room_id,m.id);});}
    catch(e){if(/UNIQUE/.test(e.message))throw fail(409,'Another participant already uses that name in this room.');throw e;}res.json({ok:true});
  });
  app.post('/api/admin/entries/:id', admin, (req,res)=>{
    const e=db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id);if(!e)throw fail(404,'Entry not found.');
    if(!['published','hidden','disqualified'].includes(req.body.status))throw fail(400,'Choose a valid entry status.');
    const title='title' in req.body?text(req.body.title,80,true):e.title,description='description' in req.body?text(req.body.description,600):e.description;
    transaction(db,()=>{db.prepare('UPDATE entries SET status=?,title=?,description=? WHERE id=?').run(req.body.status,title,description,e.id);audit(req.admin,'entry.'+req.body.status,e.room_id,e.id);});res.json({ok:true});
  });
  app.post('/api/admin/site',admin,(req,res)=>{
    const title=text(req.body.title,80,true),tagline=text(req.body.tagline||'',160),message=text(req.body.message||'',300);
    if(typeof req.body.maintenance!=='boolean')throw fail(400,'Choose a maintenance setting.');
    transaction(db,()=>{for(const [k,v] of Object.entries({siteTitle:title,tagline,maintenance:String(req.body.maintenance),maintenanceMessage:message}))db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run(k,v);audit(req.admin,'site.updated');});res.json({ok:true});
  });
  app.post('/api/admin/logo',admin,slot,upload.single('photo'),async(req,res)=>{
    res.locals.processing=true;try{if(!req.file)throw fail(400,'Choose a logo image.');const data=await picture(req.file.buffer);const file=randomUUID()+'.webp';writeFileSync(path.join(uploads,file),data,{flag:'wx',mode:0o600});db.prepare("INSERT OR REPLACE INTO config VALUES ('logo',?)").run(file);audit(req.admin,'site.logo_updated');res.json({ok:true});}finally{res.locals.processing=false;if(imageOwner===res.locals.owner)imageOwner=null;}
  });
  app.get('/brand-logo',(req,res)=>{const file=setting('logo');if(!file)throw fail(404,'Logo not found.');res.sendFile(path.join(uploads,file));});
  app.get('/api/admin/rooms/:id/export',admin,(req,res)=>{
    const r=roomFor(req.params.id);const rows=listings(r.id,null,true).sort((a,b)=>b.votes-a.votes);
    const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r]/,"'$&").replaceAll('"','""')+'"';
    const csv=[['Title','Participant','Votes','Status'],...rows.map(e=>[e.title,e.author,e.votes,e.status])].map(row=>row.map(cell).join(',')).join('\r\n');
    audit(req.admin,'room.exported',r.id);res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="competition-results.csv"'}).send(csv);
  });
  app.post('/api/admin/rooms/:id/purge',admin,reauth,(req,res)=>{
    const r=roomFor(req.params.id);if(r.status!=='archived'||req.body.confirm!==r.title)throw fail(400,'Archive the room and type its exact title to permanently delete it.');
    const files=db.prepare('SELECT image FROM entries WHERE room_id=?').all(r.id);
    transaction(db,()=>{db.prepare('DELETE FROM votes WHERE room_id=?').run(r.id);db.prepare('DELETE FROM entries WHERE room_id=?').run(r.id);db.prepare('DELETE FROM members WHERE room_id=?').run(r.id);db.prepare('DELETE FROM rooms WHERE id=?').run(r.id);audit(req.admin,'room.permanently_deleted',r.id);});
    for(const f of files)try{unlinkSync(path.join(uploads,f.image));}catch{}res.json({ok:true});
  });
  app.use(express.static(path.join(root,'public'),{index:false}));
  app.get(['/','/admin','/r/:id'],(req,res)=>res.sendFile(path.join(root,'public/index.html')));
  app.use((req,res,next)=>next(fail(404,'Not found.')));
  app.use((error,req,res,next)=>{const status=error instanceof multer.MulterError?400:error.status||500;if(status===500)console.error('Request failed',{category:'internal',status});res.status(status).json({error:error instanceof multer.MulterError?'Upload one image, at most 8 MB.':status===500?'Something went wrong. Please try again.':error.message,...(error.needsKey?{needsKey:true}:{})});});
  return {app,db};
}
