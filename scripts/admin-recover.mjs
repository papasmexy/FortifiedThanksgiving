import { DatabaseSync } from 'node:sqlite';
import { existsSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { token,digest,equal } from '../lib/security.js';
import { transaction } from '../lib/database.js';

export function issueRecovery(db,key,username,baseURL){
  const check=db.prepare("SELECT value FROM config WHERE key='key-check'").get();
  if(!check||!equal(check.value,digest(key,'key-check','rooms-v1')))throw new Error('Use the original ADMIN_ENCRYPTION_KEY. Do not reset the database.');
  const admin=db.prepare('SELECT * FROM admins WHERE username=?').get(String(username||'').toLowerCase());
  if(!admin)throw new Error('Specify an existing administrator username.');
  const invitation=token();
  transaction(db,()=>{
    db.prepare('UPDATE admin_invites SET used=1 WHERE username=?').run(admin.username);
    db.prepare('INSERT INTO admin_invites VALUES (?,?,?,?,0)').run(digest(key,'admin-invite',invitation),admin.username,admin.id,Date.now()+3600000);
    db.prepare('INSERT INTO audit(admin_id,action,target,created_at) VALUES (?,?,?,?)').run(null,'operator.admin_recovery',admin.id,new Date().toISOString());
  });
  return new URL('/admin',baseURL).href+'#invite='+invitation;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=path.resolve(process.env.DATA_DIR||'data');const file=path.join(directory,'rooms.sqlite');
  if(!existsSync(file))throw new Error('No rooms database exists here. Check DATA_DIR.');
  const key=process.env.ADMIN_ENCRYPTION_KEY||readFileSync(path.join(directory,'.local-admin-key'),'utf8');
  const db=new DatabaseSync(file);try{
    const url=issueRecovery(db,key,process.argv[2],process.env.BASE_URL||'http://localhost:3000');
    console.log('PRIVATE ONE-TIME ADMIN RECOVERY LINK (expires in 1 hour). Treat it like a password; do not paste into chat or public logs.\n'+url);
  }finally{db.close();}
}
