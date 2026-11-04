import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,existsSync,readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createApp } from '../server.js';
import { totp } from '../lib/security.js';
import { issueRecovery } from '../scripts/admin-recover.mjs';
import { backupContest } from '../scripts/backup.mjs';
const password='A uniquely strong admin password!';
async function fixture(t,production=false){
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const directory=mkdtempSync(tmpdir()+'/thanksgiving-rooms-');
  const env={DATA_DIR:directory,...(production?{NODE_ENV:'production',BASE_URL:'https://contest.example',SESSION_SECRET:'session-'.repeat(8),ADMIN_ENCRYPTION_KEY:'encryption-'.repeat(8),ADMIN_SETUP_TOKEN:'bootstrap-'.repeat(8)}:{})};
  const {app,db}=createApp(env);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));db.close();rmSync(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;const tick=()=>t.mock.timers.tick(31000);
  function client(){
    const cookies=new Map();let csrf;
    async function request(url,{method='GET',body,token=true,origin}={}){
      const headers={'Cookie':[...cookies].map(([k,v])=>k+'='+v).join(';'),...(production?{'X-Forwarded-Proto':'https'}:{})};
      if(token&&csrf)headers['X-CSRF-Token']=csrf;if(origin)headers.Origin=origin;
      if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
      const response=await fetch(base+url,{method,headers,body,redirect:'manual'});
      for(const cookie of response.headers.getSetCookie()){const first=cookie.split(';')[0],at=first.indexOf('=');if(first.slice(at+1))cookies.set(first.slice(0,at),first.slice(at+1));else cookies.delete(first.slice(0,at));}
      return response;
    }
    async function me(room){const data=await(await request('/api/me'+(room?'?room='+room:''))).json();csrf=data.csrf;return data;}
    async function post(url,body,expected=200){const r=await request(url,{method:'POST',body});const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;}
    return{request,me,post,cookies};
  }
  const admin=client();await admin.me();
  const enrollment=await admin.post('/api/admin/enroll',{username:'organizer',password,setupToken:env.ADMIN_SETUP_TOKEN});
  await admin.post('/api/admin/enroll/confirm',{otp:totp(enrollment.secret)});await admin.me();
  const credentials=()=>{tick();return{password,otp:totp(enrollment.secret)};};
  let roomCount=0;
  async function room(extra={}){roomCount++;const code='FEAST-TEST-CODE-'+roomCount;const r=await admin.post('/api/admin/rooms',{title:'Thanksgiving '+roomCount,code,approval_required:false,voting_open:true,...extra},201);return{...r.room,code};}
  async function join(r,name,extra={}){const c=client();await c.me();const data=await c.post('/api/join',{name,code:r.code,roomId:r.id,...extra});await c.me(r.id);return{...c,personalKey:data.personalKey};}
  const image=await sharp({create:{width:40,height:30,channels:3,background:'#a76b32'}}).withMetadata({exif:{IFD0:{Artist:'Remove this metadata'}}}).png().toBuffer();
  function form(title='Maple pie',buffer=image){const f=new FormData();f.set('title',title);f.set('description','A family tradition');f.set('photo',new Blob([buffer],{type:'image/png'}),'dish.png');return f;}
  async function submit(c,r,title='Maple pie'){await c.post('/api/rooms/'+r.id+'/entries',form(title),201);return(await(await c.request('/api/rooms/'+r.id)).json()).entries.find(e=>e.mine);}
  return{db,env,directory,client,admin,room,join,submit,form,credentials,tick,adminSecret:enrollment.secret};
}

test('room/name login replaces SSO; code and credential hashing, CSRF, room isolation and private photos',async t=>{
  const f=await fixture(t),r=await f.room(),other=await f.room(),person=await f.join(r,'Alex Morgan');
  await f.admin.post('/api/join',{name:'Admin Participant',code:r.code},409);
  await person.post('/api/rooms/'+r.id+'/entries',f.form('Invalid image',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),400);
  const e=await f.submit(person,r);const guest=f.client();await guest.me();
  assert.equal((await guest.request('/api/rooms/'+r.id)).status,403);assert.equal((await guest.request(e.image)).status,403);
  await guest.post('/api/join',{name:'Some Person',code:'wrong'},403);
  assert.equal((await guest.request('/api/admin/rooms',{method:'POST',body:{},token:false})).status,403);
  await guest.post('/api/admin/rooms',{title:'Unauthorized'},401);
  const outsider=await f.join(other,'Alex Morgan');assert.equal((await outsider.request(e.image)).status,403);
  await outsider.post('/api/rooms/'+other.id+'/entries/'+e.id+'/vote',{},404);
  const photo=await person.request(e.image);assert.equal(photo.status,200);const meta=await sharp(Buffer.from(await photo.arrayBuffer())).metadata();assert.equal(meta.format,'webp');assert.equal(meta.exif,undefined);
  const stored=JSON.stringify({rooms:f.db.prepare('SELECT * FROM rooms').all(),members:f.db.prepare('SELECT * FROM members').all(),sessions:f.db.prepare('SELECT value FROM sessions').all(),admins:f.db.prepare('SELECT * FROM admins').all()});
  for(const secret of [r.code,person.personalKey,password,f.adminSecret])assert.equal(stored.includes(secret),false);
  assert.equal((await guest.request('/auth/login')).status,404);
});

test('same name cannot be hijacked; recovery and room-code rotation retain entries and vote budgets',async t=>{
  const f=await fixture(t),r=await f.room(),p=await f.join(r,'Alex Morgan'),e=await f.submit(p,r);
  await p.post('/api/rooms/'+r.id+'/entries/'+e.id+'/vote',{});
  const second=f.client();await second.me();const denied=await second.post('/api/join',{name:' alex  MORGAN ',code:r.code},409);assert(denied.needsKey);
  await second.post('/api/join',{name:'alex morgan',code:r.code,personalKey:p.personalKey});assert.equal((await second.me(r.id)).access.remainingVotes,2);
  await f.admin.post('/api/admin/rooms/'+r.id+'/code',{code:'NEW-FEAST-CODE-2026'});
  assert.equal((await p.request('/api/rooms/'+r.id)).status,403);
  await p.post('/api/join',{name:'Alex Morgan',code:'NEW-FEAST-CODE-2026'});assert.equal((await p.me(r.id)).access.remainingVotes,2);
  const recovery=await f.admin.post('/api/admin/members/'+(await p.me(r.id)).access.member.id+'/recovery',f.credentials());
  assert.equal((await p.request('/api/rooms/'+r.id)).status,403);
  await second.post('/api/join',{name:'Alex Morgan',code:'NEW-FEAST-CODE-2026',personalKey:p.personalKey},409);
  await second.post('/api/join',{name:'Alex Morgan',code:'NEW-FEAST-CODE-2026',personalKey:recovery.personalKey});assert.equal((await second.me(r.id)).access.remainingVotes,2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get().n,1);
});

test('three total votes are atomic across sessions; duplicate votes and duplicate submissions are rejected',async t=>{
  const f=await fixture(t),r=await f.room();const people=[];for(const name of ['Alex Morgan','Sam Rivera','Jordan Lee','Taylor Chen'])people.push(await f.join(r,name));
  const entries=[];for(let i=0;i<4;i++)entries.push(await f.submit(people[i],r,'Dish '+i));
  await people[0].post('/api/rooms/'+r.id+'/entries',f.form(),409);
  const second=await f.join(r,'Alex Morgan',{personalKey:people[0].personalKey});
  const results=await Promise.all(entries.map((e,i)=>(i%2?second:people[0]).request('/api/rooms/'+r.id+'/entries/'+e.id+'/vote',{method:'POST',body:{}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,200,200,409]);assert.equal((await second.me(r.id)).access.remainingVotes,0);
  const first=f.db.prepare('SELECT entry_id FROM votes LIMIT 1').get();await second.post('/api/rooms/'+r.id+'/entries/'+first.entry_id+'/vote',{},409);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM votes').get().n,3);
  const same=await f.join(r,'Alex Morgan',{personalKey:people[0].personalKey});assert.equal((await same.me(r.id)).access.remainingVotes,0);
});

test('approval, bans, schedules, moderation, closed rooms and maintenance are enforced on the server',async t=>{
  const f=await fixture(t),r=await f.room({approval_required:true}),p=await f.join(r,'Alex Morgan');let m=(await p.me(r.id)).access.member;
  assert.equal(m.status,'pending');await p.post('/api/rooms/'+r.id+'/entries',f.form(),403);
  await f.admin.post('/api/admin/members/'+m.id,{status:'approved'});const e=await f.submit(p,r);
  const pending=await f.join(r,'Sam Rivera');assert.equal((await(await pending.request('/api/rooms/'+r.id)).json()).entries.length,0);assert.equal((await pending.request(e.image)).status,403);
  await f.admin.post('/api/admin/entries/'+e.id,{status:'hidden'});assert.equal((await p.request(e.image)).status,404);await p.post('/api/rooms/'+r.id+'/entries/'+e.id+'/vote',{},404);
  await f.admin.post('/api/admin/entries/'+e.id,{status:'published'});
  await f.admin.post('/api/admin/rooms/'+r.id,{voting_open:false});await p.post('/api/rooms/'+r.id+'/entries/'+e.id+'/vote',{},409);
  await f.admin.post('/api/admin/rooms/'+r.id,{voting_open:true,voting_end_at:new Date(Date.now()-1000).toISOString()});await p.post('/api/rooms/'+r.id+'/entries/'+e.id+'/vote',{},409);
  await f.admin.post('/api/admin/rooms/'+r.id,{voting_end_at:null,status:'closed'});await p.post('/api/rooms/'+r.id+'/entries/'+e.id+'/vote',{},409);
  await f.admin.post('/api/admin/members/'+m.id,{status:'banned'});assert.equal((await p.request('/api/rooms/'+r.id)).status,403);
  await f.admin.post('/api/admin/site',{title:'Our Feast',tagline:'Welcome',maintenance:true,message:'Back soon'});assert.equal((await p.request('/api/rooms/'+r.id)).status,503);
  assert.equal((await f.admin.request('/api/admin/overview')).status,200);
});

test('admin MFA replay prevention, account cap, single-use invitation, revocation and audit trail',async t=>{
  const f=await fixture(t);const guest=f.client();await guest.me();
  await guest.post('/api/admin/login',{username:'organizer',password,otp:totp(f.adminSecret)},401);
  f.tick();await guest.post('/api/admin/login',{username:'organizer',password,otp:totp(f.adminSecret)});await guest.me();
  const invite=await f.admin.post('/api/admin/invites',{username:'second-admin',...f.credentials()});assert(invite.url.includes('#invite='));
  const second=f.client();await second.me();const pending=await second.post('/api/admin/enroll',{username:'second-admin',password,invitation:invite.invitation});
  await second.post('/api/admin/enroll/confirm',{otp:totp(pending.secret)});await second.me();
  await f.admin.post('/api/admin/invites',{username:'third-admin',...f.credentials()},409);
  const replay=f.client();await replay.me();await replay.post('/api/admin/enroll',{username:'second-admin',password,invitation:invite.invitation},403);
  const id=(await second.me()).admin.id;await f.admin.post('/api/admin/accounts/'+id,{disabled:true,...f.credentials()});assert.equal((await second.request('/api/admin/overview')).status,401);
  const a=f.db.prepare('SELECT * FROM audit').all();assert(a.some(x=>x.action==='admin.invited'));assert(a.some(x=>x.action==='admin.access_changed'));
});

test('persistent login lockout and eight-hour admin session expiry cannot be bypassed',async t=>{
  const f=await fixture(t);const c=f.client();await c.me();
  for(let i=0;i<5;i++)await c.post('/api/admin/login',{username:'organizer',password:'wrong',otp:'000000'},401);
  f.tick();await c.post('/api/admin/login',{username:'organizer',password,otp:totp(f.adminSecret)},401);
  t.mock.timers.tick(16*60000);await c.post('/api/admin/login',{username:'organizer',password,otp:totp(f.adminSecret)});await c.me();
  t.mock.timers.tick(8*3600000+1);assert.equal((await c.request('/api/admin/overview')).status,401);
});

test('production bootstrap, secure cookies, enrollment token guard, key-change guard and site branding',async t=>{
  assert.throws(()=>createApp({NODE_ENV:'production'}),/Production requires/);
  const f=await fixture(t,true);assert.throws(()=>createApp({...f.env,ADMIN_ENCRYPTION_KEY:'different-'.repeat(8)}),/changed/);
  const cookie=[...f.admin.cookies.keys()];assert(cookie.includes('__Host-ft.sid'));
  const r=await f.room(),p=await f.join(r,'Test Person');const response=await p.request('/api/me?room='+r.id);assert.equal(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"),true);
  const logo=new FormData();logo.set('photo',new Blob([await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).png().toBuffer()],{type:'image/png'}),'logo.png');await f.admin.post('/api/admin/logo',logo);assert.equal((await p.request('/brand-logo')).status,200);
  await f.admin.post('/api/admin/enroll',{username:'hacker',password,setupToken:f.env.ADMIN_SETUP_TOKEN},403);
  assert.equal((await f.admin.request('/api/admin/site',{method:'POST',body:{},origin:'https://evil.example'})).status,403);
});

test('exports neutralize spreadsheet formulas; purge requires archive, exact title and MFA and preserves other rooms',async t=>{
  const f=await fixture(t),r=await f.room(),other=await f.room(),p=await f.join(r,'Alex Morgan');const e=await f.submit(p,r,'=FORMULA()');
  const file=f.db.prepare('SELECT image FROM entries WHERE id=?').get(e.id).image;assert(existsSync(f.directory+'/room-uploads/'+file));
  const csv=await(await f.admin.request('/api/admin/rooms/'+r.id+'/export')).text();assert(csv.includes("'=FORMULA()"));
  await f.admin.post('/api/admin/rooms/'+r.id+'/purge',{confirm:r.title,...f.credentials()},400);
  await f.admin.post('/api/admin/rooms/'+r.id,{status:'archived'});await f.admin.post('/api/admin/rooms/'+r.id+'/purge',{confirm:r.title,...f.credentials()});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM rooms WHERE id=?').get(other.id).n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM members WHERE room_id=?').get(r.id).n,0);assert.equal(existsSync(f.directory+'/room-uploads/'+file),false);
});

test('operator recovery preserves contests; online backups exclude sessions and restore with the original encryption key',async t=>{
  const f=await fixture(t),r=await f.room(),p=await f.join(r,'Alex Morgan');await f.submit(p,r);
  const key=readFileSync(f.directory+'/.local-admin-key','utf8');
  const url=issueRecovery(f.db,key,'organizer','http://localhost:3000');const invitation=new URL(url).hash.slice(8);assert.throws(()=>issueRecovery(f.db,'wrong-key','organizer','http://localhost:3000'));
  const recovered=f.client();await recovered.me();const enrollment=await recovered.post('/api/admin/enroll',{username:'organizer',password,invitation});await recovered.post('/api/admin/enroll/confirm',{otp:totp(enrollment.secret)});await recovered.me();
  assert.equal((await f.admin.request('/api/admin/overview')).status,401);assert.equal(f.db.prepare('SELECT count(*) AS n FROM rooms').get().n,1);
  const destination=f.directory+'-backup';t.after(()=>rmSync(destination,{recursive:true,force:true}));await backupContest(f.directory,destination);
  const copy=new DatabaseSync(destination+'/rooms.sqlite');assert.equal(copy.prepare('SELECT count(*) AS n FROM sessions').get().n,0);assert.equal(copy.prepare('SELECT count(*) AS n FROM entries').get().n,1);copy.close();
  const restored=createApp({DATA_DIR:destination,ADMIN_ENCRYPTION_KEY:key});assert.equal(restored.db.prepare('SELECT count(*) AS n FROM members').get().n,1);restored.db.close();
  await assert.rejects(()=>backupContest(f.directory,destination));assert.equal(existsSync(destination+'/.local-admin-key'),false);
});
