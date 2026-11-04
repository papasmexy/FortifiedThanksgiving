import { chromium } from 'playwright';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server.js';
import { totp } from '../lib/security.js';

// Only fictional accounts and temporary data; this never enrolls an admin in the real contest.
const directory=mkdtempSync(tmpdir()+'/thanksgiving-browser-');
const {app,db}=createApp({DATA_DIR:directory,BASE_URL:'http://127.0.0.1:3001'});const server=app.listen(3001,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
const errors=[];const output=process.env.QA_SCREENSHOT_DIR||tmpdir()+'/thanksgiving-room-screenshots';mkdirSync(output,{recursive:true});
try{
 const admin=await browser.newPage({viewport:{width:1440,height:1000}});admin.on('pageerror',e=>{errors.push(e.message);console.log('Browser JS error:',e.message);});admin.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/'))console.log('QA API error',r.status(),await r.text());});admin.on('dialog',d=>d.accept());
 await admin.goto(base+'/admin');await admin.locator('#admin-enroll').waitFor({state:'visible'});
 await admin.locator('#enroll-user').fill('test-organizer');await admin.locator('#enroll-pass').fill('Only a fictional QA password!');
 await admin.getByRole('button',{name:'Set up authenticator',exact:true}).click();await admin.locator('#totp-secret').waitFor({state:'visible'});
 const secret=await admin.locator('#totp-secret').textContent();await admin.locator('#confirm-otp').fill(totp(secret));
 await admin.getByRole('button',{name:'Finish admin setup'}).click();await admin.locator('#admin-dashboard').waitFor({state:'visible'});
 await admin.locator('summary').filter({hasText:'Create a competition room'}).click();
 await admin.locator('#new-room-title').fill('The QA Thanksgiving Table');await admin.locator('#new-room-code').fill('FEAST-BROWSER-TEST-2026');await admin.locator('#new-room-voting_open').check();
 await admin.locator('#new-room').getByRole('button',{name:'Create room',exact:true}).click();await admin.locator('#room-editor').waitFor({state:'visible'});
 const roomURL=await admin.locator('#room-link').inputValue();await admin.getByRole('button',{name:'I saved the code',exact:true}).click();
 const participant=await browser.newPage({viewport:{width:1440,height:1000}});participant.on('pageerror',e=>errors.push(e.message));participant.on('dialog',d=>d.accept());
 await participant.goto(roomURL);await participant.locator('#join-name').fill('Alex Morgan');await participant.locator('#join-code').fill('FEAST-BROWSER-TEST-2026');await participant.getByRole('button',{name:'Enter the room'}).click();
 await participant.locator('#saved-key-value').waitFor({state:'visible'});const personalKey=await participant.locator('#saved-key-value').textContent();await participant.getByRole('button',{name:'I saved my key'}).click();
 await participant.getByText('Awaiting organizer approval',{exact:true}).waitFor();
 const manage=async()=>{await admin.reload();await admin.getByRole('button',{name:'Manage room',exact:true}).click();await admin.locator('#members-table').waitFor({state:'visible'});};
 await manage();await admin.getByRole('row').filter({hasText:'Alex Morgan'}).getByRole('button',{name:'Approve',exact:true}).click();
 await participant.reload();await participant.getByRole('link',{name:'Share your plate',exact:true}).first().click();
 await participant.locator('#title').fill('Maple pecan pie');await participant.locator('#description').fill('A family favorite, baked with gratitude.');
 const photo=await sharp({create:{width:400,height:300,channels:3,background:'#ad6437'}}).png().toBuffer();
 await participant.locator('#photo').setInputFiles({name:'pie.png',mimeType:'image/png',buffer:photo});await participant.getByRole('button',{name:'Bring it to the table'}).click();
 await participant.locator('.card h3').filter({hasText:'Maple pecan pie'}).waitFor();assert(await participant.locator('.card img').evaluate(img=>img.complete&&img.naturalWidth>0));
 await participant.getByRole('button',{name:'Vote for Maple pecan pie',exact:true}).click();await participant.getByText('2 of 3 votes left',{exact:true}).waitFor();
 await participant.getByRole('link',{name:'Leaderboard',exact:true}).click();await participant.locator('.leader-row').waitFor();assert.equal(await participant.locator('.leader-votes').textContent(),'1 votes');
 await participant.getByRole('link',{name:'The gallery',exact:true}).click();await participant.screenshot({path:output+'/participant-desktop.png',fullPage:true});
 await participant.setViewportSize({width:390,height:844});await participant.screenshot({path:output+'/participant-mobile.png',fullPage:true});assert(await participant.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await participant.getByRole('button',{name:'Sign out',exact:true}).click();await participant.locator('#join-name').fill('Alex Morgan');await participant.locator('#join-code').fill('FEAST-BROWSER-TEST-2026');await participant.getByRole('button',{name:'Enter the room'}).click();
 await participant.locator('#personal-key-field').waitFor({state:'visible'});await participant.locator('#personal-key').fill(personalKey);await participant.getByRole('button',{name:'Enter the room'}).click();await participant.getByText('2 of 3 votes left',{exact:true}).waitFor();
 await manage();await admin.screenshot({path:output+'/admin-desktop.png',fullPage:false});await admin.setViewportSize({width:390,height:844});await admin.screenshot({path:output+'/admin-mobile.png',fullPage:false});assert(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await admin.getByRole('row').filter({hasText:'Alex Morgan'}).getByRole('button',{name:'Ban',exact:true}).click();
 await participant.reload();await participant.locator('#join-panel').waitFor({state:'visible'});
 assert.deepEqual(errors,[]);console.log('Browser acceptance passed: admin enrollment/MFA, room creation, approval, image submission, gallery, vote, leaderboard, name protection/recovery, ban, desktop/mobile layouts. Screenshots: '+output);
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();rmSync(directory,{recursive:true,force:true});}
