import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, createHash, constants } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server.js';
import { contestIdentity } from '../lib/microsoft-auth.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const oid = '33333333-3333-4333-8333-333333333333';
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
const endpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const json = value => Buffer.from(JSON.stringify(value)).toString('base64url');

async function fixture(t, { override = {}, forged = false, badMetadata = false } = {}) {
  const directory = mkdtempSync(`${tmpdir()}/thanksgiving-oidc-`);
  const keyPath = `${directory}/key.pem`;
  writeFileSync(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const env = {
    NODE_ENV: 'production', BASE_URL: 'https://contest.example.com',
    DATA_DIR: directory, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId,
    OIDC_PRIVATE_KEY_PATH: keyPath, OIDC_CERT_THUMBPRINT: 'A'.repeat(43),
    IDENTITY_SECRET: 'test-identity-key-'.repeat(4), SESSION_SECRET: 'test-session-key-'.repeat(4)
  };
  let nonce, challenge, tokenCalls = 0;
  const fetcher = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return Response.json({
      issuer, authorization_endpoint: `${endpoint}/authorize`,
      token_endpoint: badMetadata ? 'https://attacker.invalid/token' : `${endpoint}/token`,
      jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      response_types_supported: ['code'], subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['private_key_jwt']
    });
    if (url.pathname.endsWith('/keys')) return Response.json({ keys: [jwk] });
    if (url.pathname.endsWith('/token')) {
      tokenCalls++;
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.has('client_secret'), false);
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
      const assertion = params.get('client_assertion').split('.');
      assert.equal(JSON.parse(Buffer.from(assertion[0], 'base64url'))['x5t#S256'], env.OIDC_CERT_THUMBPRINT);
      assert.equal(JSON.parse(Buffer.from(assertion[0], 'base64url')).alg, 'PS256');
      assert.equal(JSON.parse(Buffer.from(assertion[1], 'base64url')).aud, `${endpoint}/token`);
      assert(verify('sha256', Buffer.from(assertion.slice(0, 2).join('.')), { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(assertion[2], 'base64url')));
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, aud: clientId, sub: 'pairwise-sub', oid, tid: tenant, acct: 0,
        roles: ['Contest.Participant'], nonce, iat: now, exp: now + 300,
        name: 'DO NOT STORE THIS NAME', email: 'do-not-store@company.example', ...override };
      const unsigned = `${json({ alg: 'RS256', kid: 'test-key' })}.${json(payload)}`;
      const signature = sign('RSA-SHA256', Buffer.from(unsigned), forged ? attacker.privateKey : keys.privateKey).toString('base64url');
      return Response.json({ token_type: 'Bearer', expires_in: 300, access_token: 'DO-NOT-STORE-TOKEN', id_token: `${unsigned}.${signature}` });
    }
    throw new Error('Unexpected request');
  };
  const { app, db } = createApp(env, { oidcFetch: fetcher });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  async function request(url, params) {
    const headers = { 'X-Forwarded-Proto': 'https', ...(cookie ? { Cookie: cookie } : {}) };
    if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(base + url, { redirect: 'manual', headers, ...(params ? { method: 'POST', body: new URLSearchParams(params) } : {}) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return r;
  }
  async function begin() {
    const response = await request('/auth/login');
    if (response.status !== 302) return { response };
    const authorization = new URL(response.headers.get('location'));
    nonce = authorization.searchParams.get('nonce'); challenge = authorization.searchParams.get('code_challenge');
    assert.equal(authorization.origin, 'https://login.microsoftonline.com');
    assert.equal(authorization.searchParams.get('scope'), 'openid profile');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('response_mode'), 'form_post');
    assert.match(response.headers.get('set-cookie'), /SameSite=None/);
    assert.match(response.headers.get('set-cookie'), /__Host-thanksgiving.sid=/);
    return { authorization, response };
  }
  return { begin, request, db, env, tokenCalls: () => tokenCalls };
}

test('Microsoft sign-in uses PKCE, state, nonce, certificate assertions and signed ID tokens; only pseudonymous identity is persisted', async t => {
  const f = await fixture(t); const { authorization } = await f.begin();
  const params = { code: 'one-time-code', state: authorization.searchParams.get('state') };
  const callback = await f.request('/auth/callback', params);
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('set-cookie'), /SameSite=Lax/);
  const me = await (await f.request('/api/me')).json();
  assert.match(me.user.name, /^Home cook [A-F0-9]{8}$/);
  assert.equal(Object.hasOwn(me.user, 'id'), false);
  const users = f.db.prepare('SELECT * FROM users').all(); assert.equal(users.length, 1);
  assert.match(users[0].id, /^u1:[a-f0-9]{64}$/);
  const stored = JSON.stringify({ users, sessions: f.db.prepare('SELECT value FROM sessions').all() });
  for (const forbidden of [tenant, oid, clientId, 'DO NOT STORE THIS NAME', 'do-not-store@company.example', 'DO-NOT-STORE-TOKEN', 'one-time-code']) assert.equal(stored.includes(forbidden), false);
  assert.equal((await f.request('/auth/callback', params)).status, 400, 'callback cannot be replayed');
  assert.equal((await f.request('/auth/callback?code=test&state=anything')).status, 405);
  assert.equal(f.tokenCalls(), 1);
});

test('sign-in rejects invalid signatures, audience, issuer, expiry, nonce, tenant, guest status and missing assignment', async t => {
  for (const [name, options] of Object.entries({
    forged: { forged: true }, audience: { override: { aud: 'other-app' } },
    issuer: { override: { iss: 'https://attacker.invalid' } }, expired: { override: { exp: 1 } },
    nonce: { override: { nonce: 'wrong' } }, tenant: { override: { tid: '44444444-4444-4444-8444-444444444444' } },
    guest: { override: { acct: 1 } }, missingAccountType: { override: { acct: undefined } },
    missingRole: { override: { roles: [] } }
  })) await t.test(name, async t => {
    const f = await fixture(t, options); const { authorization } = await f.begin();
    assert.notEqual((await f.request('/auth/callback', { code: 'test', state: authorization.searchParams.get('state') })).status, 302);
    assert.equal((await (await f.request('/api/me')).json()).user, null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  });
});

test('wrong state is rejected before token exchange; discovered endpoints cannot point outside Microsoft', async t => {
  const f = await fixture(t); await f.begin();
  assert.notEqual((await f.request('/auth/callback', { code: 'test', state: 'wrong' })).status, 302);
  assert.equal(f.tokenCalls(), 0);
  const other = await fixture(t, { badMetadata: true });
  assert.equal((await other.begin()).response.status, 500);
  assert.equal(other.tokenCalls(), 0);
});

test('pseudonymous IDs stay stable when email, name or pairwise subject changes; different people remain distinct', () => {
  const settings = { issuer, tenant, identitySecret: 'stable-key' };
  const base = { iss: issuer, tid: tenant, oid, sub: 'sub', acct: 0, roles: ['Contest.Participant'] };
  const first = contestIdentity(base, settings);
  assert.deepEqual(contestIdentity({ ...base, name: 'Changed', email: 'changed@example.com', sub: 'another-sub' }, settings), first);
  assert.notEqual(contestIdentity({ ...base, oid: '55555555-5555-4555-8555-555555555555' }, settings).id, first.id);
});

test('startup refuses identity-key changes and legacy SSO accounts without modifying existing users', async t => {
  const f = await fixture(t);
  assert.throws(() => createApp({ ...f.env, IDENTITY_SECRET: 'changed-secret-'.repeat(4) }), /refusing to reset contest identities/);
  f.db.prepare('INSERT INTO users VALUES (?,?)').run('legacy-test-issuer|legacy-subject', 'Preserve this existing record');
  assert.throws(() => createApp(f.env), /explicit preservation\/migration plan/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('authenticated sessions have an absolute one-hour lifetime even if the cookie has been extended', async t => {
  const f = await fixture(t); const { authorization } = await f.begin();
  assert.equal((await f.request('/auth/callback', { code: 'test', state: authorization.searchParams.get('state') })).status, 302);
  for (const row of f.db.prepare('SELECT sid,value FROM sessions').all()) {
    const data = JSON.parse(row.value); data.authenticatedAt = Date.now() - 3_600_001;
    f.db.prepare('UPDATE sessions SET value=? WHERE sid=?').run(JSON.stringify(data), row.sid);
  }
  assert.equal((await (await f.request('/api/me')).json()).user, null);
  assert.equal((await f.request('/api/entries')).status, 401);
});
