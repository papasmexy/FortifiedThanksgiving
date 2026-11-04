import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server.js';

async function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'thanksgiving-'));
  const { app, db } = createApp({ DEMO_AUTH: 'true', DATA_DIR: directory });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie = '', csrf = '';
    async function request(url, { method = 'GET', body, token = true } = {}) {
      const headers = { Cookie: cookie };
      if (token && csrf) headers['X-CSRF-Token'] = csrf;
      if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
      const response = await fetch(base + url, { method, headers, body });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    }
    async function me() { const r = await request('/api/me'); const data = await r.json(); csrf = data.csrf; return data; }
    async function login(account) { await me(); assert.equal((await request('/auth/demo', { method: 'POST', body: { account } })).status, 200); return me(); }
    return { request, me, login };
  }
  const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#bd632e' } }).png().toBuffer();
  const form = (title = 'Maple pie', buffer = image) => {
    const value = new FormData(); value.set('title', title); value.set('description', '<script>hello</script> A family tradition.'); value.set('photo', new Blob([buffer], { type: 'image/png' }), 'dish.png'); return value;
  };
  return { client, db, form, base };
}

test('sign-in and CSRF protect gallery, uploads, voting, photos, and logout', async t => {
  const { client, form } = await fixture(t);
  const guest = client(); await guest.me();
  assert.equal((await guest.request('/api/entries')).status, 401);
  assert.equal((await guest.request('/photos/anything.webp')).status, 401);
  assert.equal((await guest.request('/api/entries', { method: 'POST', body: form() })).status, 401);
  assert.equal((await guest.request('/auth/demo', { method: 'POST', body: { account: 'alex' }, token: false })).status, 403);
  const person = client(); await person.login('alex');
  assert.equal((await person.request('/auth/logout', { method: 'POST', token: false })).status, 403);
  assert.equal((await person.request('/api/entries/id/vote', { method: 'POST', token: false })).status, 403);
  assert.equal((await person.request('/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await person.request('/api/entries')).status, 401);
});

test('upload validates image contents, stores a safe photo, and allows one entry per employee', async t => {
  const { client, form } = await fixture(t);
  const person = client(); await person.login('alex');
  assert.equal((await person.request('/api/entries', { method: 'POST', body: form('Fake', Buffer.from('<svg onload="alert(1)"></svg>')) })).status, 400);
  assert.equal((await person.request('/api/entries', { method: 'POST', body: form('x'.repeat(81)) })).status, 400);
  assert.equal((await person.request('/api/entries', { method: 'POST', body: form() })).status, 201);
  const [entry] = await (await person.request('/api/entries')).json();
  assert.equal(entry.title, 'Maple pie'); assert.equal(entry.author, 'Alex Morgan'); assert.equal(entry.mine, 1);
  const photo = await person.request(entry.image);
  assert.equal(photo.status, 200); assert.equal(photo.headers.get('content-type'), 'image/webp');
  assert.equal((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).format, 'webp');
  assert.equal((await person.request('/api/entries', { method: 'POST', body: form('Second dish') })).status, 409);
});

test('health checks do not create sessions and per-account API rate limits cannot be bypassed with another session', async t => {
  const { client, db } = await fixture(t);
  const guest = client();
  const health = await guest.request('/healthz');
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('set-cookie'), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  const person = client(); await person.login('alex');
  for (let i = 0; i < 120; i++) assert.equal((await person.request('/api/entries')).status, 200);
  const other = client(); await other.login('alex');
  assert.equal((await other.request('/api/entries')).status, 429);
});

test('three lifetime votes on distinct entries persist across logout and separate sessions; concurrent requests cannot exceed budget', async t => {
  const { client, form, db } = await fixture(t);
  const people = [];
  for (const account of ['alex', 'sam', 'jordan', 'taylor']) {
    const person = client(); await person.login(account);
    assert.equal((await person.request('/api/entries', { method: 'POST', body: form(`${account} creation`) })).status, 201);
    people.push(person);
  }
  const voter = people[0];
  const entries = await (await voter.request('/api/entries')).json();
  const vote = (person, id) => person.request(`/api/entries/${id}/vote`, { method: 'POST' });
  assert.equal((await vote(voter, 'missing')).status, 404);
  assert.equal((await vote(voter, entries[0].id)).status, 200);
  assert.equal((await vote(voter, entries[0].id)).status, 409);
  assert.equal((await voter.me()).remainingVotes, 2);
  const secondSession = client(); await secondSession.login('alex');
  const results = await Promise.all(entries.slice(1).map((entry, i) => vote(i % 2 ? secondSession : voter, entry.id)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 409]);
  assert.equal((await voter.me()).remainingVotes, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM votes WHERE user_id=?').get('demo:alex').n, 3);
  assert.throws(() => db.prepare('INSERT INTO votes VALUES (?,?)').run('demo:alex', entries.find(e => !db.prepare('SELECT 1 FROM votes WHERE user_id=? AND entry_id=?').get('demo:alex', e.id)).id), /vote limit reached/);
  assert.equal((await voter.request('/auth/logout', { method: 'POST' })).status, 200);
  await voter.login('alex'); assert.equal((await voter.me()).remainingVotes, 0);
  assert.equal((await people[1].me()).remainingVotes, 3);
  const tally = await (await voter.request('/api/entries')).json();
  assert.equal(tally.reduce((sum, entry) => sum + entry.votes, 0), 3);
  assert.equal(tally.filter(entry => entry.voted).length, 3);
});

test('production rejects demo mode, insecure URLs, weak secrets, and incomplete SSO configuration', () => {
  assert.throws(() => createApp({ NODE_ENV: 'production', DEMO_AUTH: 'true' }), /Production requires/);
  assert.throws(() => createApp({ NODE_ENV: 'production', BASE_URL: 'http://example.com', SESSION_SECRET: 'x'.repeat(40) }), /Production requires/);
  assert.throws(() => createApp({ NODE_ENV: 'production', BASE_URL: 'https://example.com', SESSION_SECRET: 'short' }), /Production requires/);
  assert.throws(() => createApp({ NODE_ENV: 'production', BASE_URL: 'https://example.com', SESSION_SECRET: 'x'.repeat(40) }), /Configure OIDC/);
  assert.throws(() => createApp({ OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0', OIDC_CLIENT_ID: 'test', OIDC_CLIENT_SECRET: 'test', COMPANY_EMAIL_DOMAIN: 'example.com' }), /tenant-specific Microsoft Entra/);
});
