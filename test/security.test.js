import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, verifyTotp, hashPassword, checkPassword, seal, unseal, fullName } from '../lib/security.js';
test('TOTP matches RFC 6238 SHA-1 vectors (six-digit suffix) and rejects replays', () => {
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for(const [seconds,expected] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']]) assert.equal(totp(secret,Math.floor(seconds/30)),expected);
  assert.equal(verifyTotp(secret,'287082',-1,59000),1);assert.equal(verifyTotp(secret,'287082',1,59000),null);
});
test('password hashes are salted, verified, length-limited; MFA encryption detects wrong keys',async()=>{
  const password='A long, unique test password';const first=await hashPassword(password),second=await hashPassword(password);
  assert.notEqual(first,second);assert(await checkPassword(password,first));assert.equal(await checkPassword('wrong',first),false);
  await assert.rejects(()=>hashPassword('short'));const encrypted=seal('SECRET','key-a');assert.equal(unseal(encrypted,'key-a'),'SECRET');assert.throws(()=>unseal(encrypted,'key-b'));
  assert.equal(fullName('  Alex   MORGAN ').normalized,fullName('alex morgan').normalized);assert.throws(()=>fullName('Alex\u200bMorgan'));
});
