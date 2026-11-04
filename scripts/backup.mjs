import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync,copyFileSync,existsSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function backupContest(directory,destination){
  const source=path.resolve(directory),target=path.resolve(destination);
  if(target===source||target.startsWith(source+path.sep))throw new Error('Choose a NEW backup directory outside DATA_DIR.');
  if(!existsSync(path.join(source,'rooms.sqlite')))throw new Error('No rooms database at DATA_DIR.');
  mkdirSync(target,{mode:0o700});mkdirSync(path.join(target,'room-uploads'),{mode:0o700});
  const live=new DatabaseSync(path.join(source,'rooms.sqlite'),{readOnly:true});
  try{await backup(live,path.join(target,'rooms.sqlite'));}finally{live.close();}
  const snapshot=new DatabaseSync(path.join(target,'rooms.sqlite'));
  try{
    const files=snapshot.prepare('SELECT image FROM entries UNION SELECT value AS image FROM config WHERE key=\'logo\'').all();
    for(const {image} of files){if(!/^[a-f0-9-]+\.webp$/.test(image))throw new Error('Unexpected photo name in database.');copyFileSync(path.join(source,'room-uploads',image),path.join(target,'room-uploads',image));}
    snapshot.exec('DELETE FROM sessions; VACUUM;');
    writeFileSync(path.join(target,'backup-info.json'),JSON.stringify({createdAt:new Date().toISOString(),photos:files.length,complete:true,masterKeyIncluded:false,sessionsIncluded:false})+'\n',{mode:0o600});
    return{photos:files.length};
  }finally{snapshot.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.umask(0o077);if(!process.argv[2])throw new Error('Usage: npm run backup -- /protected/NEW-backup-directory');
  const result=await backupContest(process.env.DATA_DIR||'data',process.argv[2]);console.log('Backup complete; '+result.photos+' photos. Keep the original admin encryption key separately in your secure secret store.');
}
