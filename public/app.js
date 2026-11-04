const $ = s => document.querySelector(s);
const el = (tag, content, className) => { const n=document.createElement(tag); if(content!==undefined)n.textContent=content;if(className)n.className=className;return n; };
const values = form => Object.fromEntries(new FormData(form));
let me, site, roomId=location.pathname.match(/^\/r\/([^/]+)$/)?.[1]||'', entries=[], selectedRoom='', details, overview, previewURL, statusTimer;
const adminPage=location.pathname==='/admin';
let invitation=location.hash.startsWith('#invite=')?decodeURIComponent(location.hash.slice(8)):'';
if(invitation)history.replaceState(null,'','/admin');
function status(message,error=false){$('#status').textContent=message;$('#status').classList.toggle('error',error);$('#status').hidden=false;clearTimeout(statusTimer);if(!error)statusTimer=setTimeout(()=>$('#status').hidden=true,7000);}
async function api(url,options={}) {
 const r=await fetch(url,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(me?{'X-CSRF-Token':me.csrf}:{}),...options.headers}});
 const data=await r.json();if(!r.ok){const e=new Error(data.error||'Please try again.');e.needsKey=data.needsKey;throw e;}return data;
}
const post=(url,body={})=>api(url,{method:'POST',body:body instanceof FormData?body:JSON.stringify(body)});
const act = callback => async event => {event?.preventDefault();const button=event?.submitter;if(button)button.disabled=true;try{await callback(event);}catch(e){status(e.message,true);}finally{if(button)button.disabled=false;}};
function empty(target,title,message){const box=el('div',undefined,'empty');box.append(el('h3',title),el('p',message));target.replaceChildren(box);}
function phase(room,kind){return room.status==='active'&&!!room[kind+'_open']&&(!room.starts_at||Date.now()>=Date.parse(room.starts_at))&&(!room[kind+'_end_at']||Date.now()<Date.parse(room[kind+'_end_at']));}
function button(label,callback,className='secondary'){const b=el('button',label,className);b.type='button';b.addEventListener('click',act(callback));return b;}
async function refresh(){
 me=await api('/api/me'+(roomId?'?room='+encodeURIComponent(roomId):''));
 site=await api('/api/site');
 $('#local-banner').hidden=!me.local;$('#hero').hidden=adminPage;document.querySelector('nav').hidden=adminPage;
 $('#maintenance-banner').hidden=!site.maintenance;$('#maintenance-banner').textContent=site.message||'Participant access is temporarily paused.';
 $('#site-title').textContent=site.title;document.title=site.title;$('#footer-tagline').textContent=site.tagline;
 $('#brand-logo').hidden=!site.logo;document.querySelector('.brand-mark').hidden=!!site.logo;if(site.logo)$('#brand-logo').src=site.logo+'?v='+Date.now();
 const account=$('#account');account.replaceChildren();
 if(me.admin||me.access){account.append(el('span',me.admin?me.admin.username:me.access.member.name,'account-name'),button('Sign out',async()=>{await post('/api/logout');location.href=adminPage?'/admin':location.pathname;},'text-button'));}
 else if(!adminPage){const a=el('a','Organizer sign in','button small');a.href='/admin';account.append(a);}
 $('#admin-shell').hidden=!adminPage;$('#join-panel').hidden=adminPage||!!me.access;$('#room-banner').hidden=adminPage||!me.access;
 if(adminPage){await refreshAdmin();return;}
 if(me.access){const r=await api('/api/rooms/'+roomId);entries=r.entries;}
 else entries=[];
 render();
}
function render(){
 const page=['gallery','submit','leaderboard'].includes(location.hash.slice(1))?location.hash.slice(1):'gallery';
 document.querySelectorAll('.page').forEach(n=>n.hidden=adminPage||!me?.access||n.id!==page+'-page');
 document.querySelectorAll('[data-page]').forEach(n=>{n.classList.toggle('active',n.dataset.page===page);if(n.dataset.page===page)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
 if(!me?.access||adminPage)return;
 const {room,member,remainingVotes,hasEntry}=me.access;
 $('#room-title').textContent=room.title;$('#room-description').textContent=room.description;
 $('#participant-state').textContent=member.status==='pending'?'Awaiting organizer approval':room.status==='closed'?'Competition closed':'Welcome, '+member.name;
 $('#room-rules').textContent='Submissions: '+(phase(room,'submissions')?'open':'closed')+' · Voting: '+(phase(room,'voting')?'open':'closed')+(room.voting_end_at?' · Voting ends '+new Date(room.voting_end_at).toLocaleString():'');
 $('#votes-left').textContent=remainingVotes+' of 3 votes left';
 $('#entry-count').textContent=entries.length+' creations at the table';
 const grid=$('#gallery-grid');grid.replaceChildren();
 const sorted=[...entries].sort($('#sort').value==='popular'?(a,b)=>b.votes-a.votes:(a,b)=>b.created_at.localeCompare(a.created_at));
 for(const e of sorted){const card=$('#card-template').content.cloneNode(true);card.querySelector('img').src=e.image;card.querySelector('img').alt=e.title;card.querySelector('.your-entry').hidden=!e.mine;card.querySelector('.card-author').textContent='FROM '+e.author.toUpperCase()+'’S KITCHEN';card.querySelector('h3').textContent=e.title;card.querySelector('.card-description').textContent=e.description;card.querySelector('.vote-total').textContent=e.votes+' '+(e.votes===1?'vote':'votes');
 const b=card.querySelector('button');b.textContent=e.voted?'Voted':'Give a vote';b.setAttribute('aria-label',(e.voted?'Voted for ':'Vote for ')+e.title);b.disabled=!!e.voted||!remainingVotes||member.status!=='approved'||!phase(room,'voting');
 b.onclick=act(async()=>{if(!confirm('Give one of your three final votes to “'+e.title+'”?'))return;b.disabled=true;await post('/api/rooms/'+roomId+'/entries/'+e.id+'/vote');await refresh();status('Your vote has been counted.');});grid.append(card);}
 if(!entries.length)empty(grid,'The table is set.','Approved creations in this room will appear here.');
 const unavailable=hasEntry||member.status!=='approved'||!phase(room,'submissions');
 $('#entry-form').hidden=unavailable;$('#submit-unavailable').hidden=!unavailable;
 if(unavailable)empty($('#submit-unavailable'),hasEntry?'Your creation has a seat at the table.':member.status==='pending'?'Your organizer is reviewing your participation.':'Submissions are closed.',hasEntry?'Only one submission is allowed per participant in a room.':'Your organizer controls when participation opens.');
 const board=$('#leaderboard-list');board.replaceChildren();let previous,rank;
 [...entries].sort((a,b)=>b.votes-a.votes||a.created_at.localeCompare(b.created_at)).forEach((e,i)=>{if(e.votes!==previous)rank=i+1;previous=e.votes;const row=el('article',undefined,'leader-row'),pic=el('img'),info=el('div');pic.src=e.image;pic.alt=e.title;pic.loading='lazy';info.append(el('h3',e.title),el('p','By '+e.author));row.append(el('span',String(rank).padStart(2,'0'),'rank'),pic,info,el('strong',e.votes+' votes','leader-votes'));board.append(row);});
 if(!entries.length)empty(board,'Every feast starts with one dish.','The leaderboard will appear as creations arrive.');
}
$('#join-form').addEventListener('submit',act(async e=>{
 const data=values(e.target);if(roomId)data.roomId=roomId;
 try{const result=await post('/api/join',data);roomId=result.roomId;history.replaceState(null,'','/r/'+roomId+'#gallery');$('#personal-key').value='';$('#join-code').value='';if(result.personalKey){$('#saved-key-value').textContent=result.personalKey;$('#saved-key').hidden=false;}await refresh();(result.personalKey?$('#saved-key'):$('#room-banner')).scrollIntoView({behavior:'smooth'});}
 catch(error){if(error.needsKey){$('#personal-key-field').hidden=false;$('#personal-key').focus();}throw error;}
}));
$('#dismiss-key').onclick=()=>{$('#saved-key').hidden=true;$('#saved-key-value').textContent='';};
$('#entry-form').addEventListener('submit',act(async e=>{await post('/api/rooms/'+roomId+'/entries',new FormData(e.target));e.target.reset();$('#preview').hidden=true;if(previewURL)URL.revokeObjectURL(previewURL);location.hash='#gallery';await refresh();status('Your creation is at the table.');}));
$('#photo').onchange=e=>{const f=e.target.files[0];if(previewURL)URL.revokeObjectURL(previewURL);$('#preview').hidden=true;if(!f)return;if(f.size>8*1024*1024||!['image/jpeg','image/png','image/webp'].includes(f.type)){e.target.value='';status('Choose a JPG, PNG or WebP photo, up to 8 MB.',true);return;}previewURL=URL.createObjectURL(f);$('#preview').src=previewURL;$('#preview').hidden=false;};
$('#sort').onchange=render;$('#refresh-board').onclick=act(refresh);
window.addEventListener('hashchange',()=>{if(!adminPage){render();const target=me?.access?document.querySelector('.page:not([hidden])'):$('#join-panel');target?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});if(me?.access&&location.hash==='#leaderboard')refresh().catch(e=>status(e.message,true));}});

function reauthenticate(){return new Promise((resolve,reject)=>{const dialog=$('#reauth-dialog'),form=$('#reauth-form');form.reset();dialog.showModal();let settled=false;const finish=(value)=>{if(settled)return;settled=true;dialog.close();resolve(value);};form.onsubmit=e=>{e.preventDefault();const data=values(form);form.reset();finish(data);};$('#cancel-reauth').onclick=()=>finish(null);dialog.oncancel=()=>finish(null);});}
async function sensitive(url,body={}){const credentials=await reauthenticate();if(!credentials)return null;return post(url,{...body,...credentials});}
function input(form,name,label,type='text',value='',required=false){const id=form.id+'-'+name;const l=el('label',label);l.htmlFor=id;const i=el(type==='textarea'?'textarea':'input');i.id=id;i.name=name;if(type!=='textarea')i.type=type;if(type==='checkbox'){i.checked=!!value;l.className='check';l.prepend(i);form.append(l);}else{i.value=value??'';i.required=required;form.append(l,i);}return i;}
function localDate(v){if(!v)return '';const date=new Date(v);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function generateCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return 'FEAST-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>chars[b%chars.length]).join('');}
function roomForm(form,r,isNew){
 form.replaceChildren();input(form,'title','Room title','text',r.title||'',true).maxLength=100;input(form,'description','Welcome message','textarea',r.description||'').maxLength=600;
 if(isNew){const code=input(form,'code','Shared access code (10–64 characters)','text',generateCode(),true);code.minLength=10;code.maxLength=64;form.append(button('Generate a different code',()=>{code.value=generateCode();}));form.append(el('small','Save and share this code separately. It is stored as a keyed hash and cannot be displayed later.'));}
 const label=el('label','Room status'),select=el('select');select.name='status';for(const value of ['draft','active','closed','archived']){const o=el('option',value);o.value=value;select.append(o);}select.value=r.status||'active';form.append(label,select);
 for(const [name,labelText,initial] of [['join_open','Allow joining with the room code',true],['submissions_open','Accept submissions',true],['voting_open','Allow voting',false],['approval_required','Require admin approval before new participants view photos, submit or vote',true]])input(form,name,labelText,'checkbox',isNew?initial:r[name]);
 form.append(el('small','Approval affects new participants. Review existing pending names separately. Closing or archiving a room stops submissions and voting.'));
 for(const [name,labelText] of [['starts_at','Start (optional, your local time)'],['submissions_end_at','Submission deadline (optional)'],['voting_end_at','Voting deadline (optional)']])input(form,name,labelText,'datetime-local',localDate(r[name]));
 const submit=el('button',isNew?'Create room':'Save room settings','button');submit.type='submit';form.append(submit);
}
function roomValues(form){const data=values(form);for(const name of ['join_open','submissions_open','voting_open','approval_required'])data[name]=form.elements[name].checked;for(const name of ['starts_at','submissions_end_at','voting_end_at'])data[name]=data[name]?new Date(data[name]).toISOString():null;return data;}
async function refreshAdmin(){
 const state=await api('/api/admin/status');const signedIn=!!me.admin&&!invitation;$('#admin-auth').hidden=signedIn;$('#admin-dashboard').hidden=!signedIn;
 if(!signedIn){$('#admin-login').hidden=state.setupRequired||!!invitation;$('#admin-enroll').hidden=!state.setupRequired&&!invitation;$('#setup-token-field').hidden=state.localSetup||!!invitation;$('#admin-auth-message').textContent=state.setupRequired&&state.localSetup?'Local first-admin setup: create your own username, password and authenticator. No default admin password exists.':'';return;}
 $('#totp-secret').textContent='';$('#admin-confirm').hidden=true;
 overview=await api('/api/admin/overview');
 const list=$('#room-list');list.replaceChildren();for(const r of overview.rooms){const card=el('article',undefined,'admin-box');card.append(el('span',r.status.toUpperCase(),'eyebrow'),el('h3',r.title),el('p',r.participants+' participants · '+r.entries+' submissions'),button('Manage room',async()=>{selectedRoom=r.id;await loadRoom();$('#room-editor').scrollIntoView({behavior:'smooth'});}));list.append(card);}
 if(!overview.rooms.length)empty(list,'Set your first table.','Create a room below, choose its access code, and share its link.');
 const form=$('#site-form');form.elements.title.value=overview.site.title;form.elements.tagline.value=overview.site.tagline;form.elements.maintenance.checked=overview.site.maintenance;form.elements.message.value=overview.site.message;
 const accounts=$('#admin-accounts-list');accounts.replaceChildren();for(const a of overview.admins){const row=el('div',undefined,'admin-account');row.append(el('strong',a.username),el('span',a.disabled?'Disabled':'Active'));if(a.id!==me.admin.id)row.append(button(a.disabled?'Enable':'Disable',async()=>{const result=await sensitive('/api/admin/accounts/'+a.id,{disabled:!a.disabled});if(result)await refresh();}));accounts.append(row);}
 const table=el('table');const head=el('tr');for(const title of ['When','Administrator','Action','Room'])head.append(el('th',title));table.append(head);for(const a of overview.audit){const row=el('tr');for(const v of [new Date(a.created_at).toLocaleString(),a.username||'System',a.action,overview.rooms.find(r=>r.id===a.room_id)?.title||'—'])row.append(el('td',v));table.append(row);}$('#audit-list').replaceChildren(table);
 if(selectedRoom&&overview.rooms.some(r=>r.id===selectedRoom))await loadRoom();else{$('#room-editor').hidden=true;selectedRoom='';}
}
async function loadRoom(){
 details=await api('/api/admin/rooms/'+selectedRoom);$('#room-editor').hidden=false;$('#editor-title').textContent=details.room.title;$('#room-link').value=location.origin+'/r/'+selectedRoom;roomForm($('#edit-room'),details.room,false);renderMembers();renderModeration();
}
function renderMembers(){
 if(!details)return;const table=el('table'),head=el('tr');for(const label of ['Name','Status','Used votes','Actions'])head.append(el('th',label));table.append(head);
 const needle=$('#member-filter').value.toLowerCase();for(const m of details.members.filter(m=>m.name.toLowerCase().includes(needle))){const row=el('tr');row.append(el('td',m.name),el('td',m.status),el('td',String(m.votes_used)));const actions=el('td',undefined,'inline-actions');for(const state of ['approved','pending','banned']){const b=button(state==='approved'?'Approve':state==='pending'?'Mark pending':'Ban',async()=>{if(state==='banned'&&!confirm('Block this participant and exclude their content and votes from results?'))return;await post('/api/admin/members/'+m.id,{status:state});await loadRoom();});b.disabled=m.status===state;actions.append(b);}actions.append(button('Rename',async()=>{const name=prompt('Correct this participant’s full name:',m.name);if(name){await post('/api/admin/members/'+m.id+'/name',{name});await loadRoom();}}));actions.append(button('Recover access',async()=>{const result=await sensitive('/api/admin/members/'+m.id+'/recovery');if(result){const box=el('div',undefined,'notice');box.append(el('strong','New personal key for '+m.name),el('output',result.personalKey,'secret-output'),el('p','Share it privately. Existing sessions and the old key have been revoked.'),button('Dismiss',()=>box.remove()));$('#members-table').before(box);}}));row.append(actions);table.append(row);}$('#members-table').replaceChildren(table);
}
function renderModeration(){const grid=$('#moderation-grid');grid.replaceChildren();for(const e of details.entries){const card=el('article',undefined,'card'),img=el('img');img.src=e.image;img.alt=e.title;img.loading='lazy';img.className='moderation-photo';const body=el('div',undefined,'card-body');body.append(el('h3',e.title),el('p',e.author+' · '+e.votes+' votes · '+e.status),el('p',e.description));const select=el('select');for(const s of ['published','hidden','disqualified']){const o=el('option',s);o.value=s;select.append(o);}select.value=e.status;const label=el('label','Moderation status');label.append(select);const titleInput=el('input');titleInput.value=e.title;titleInput.maxLength=80;const storyInput=el('textarea');storyInput.value=e.description;storyInput.maxLength=600;const titleLabel=el('label','Edit title');titleLabel.append(titleInput);const storyLabel=el('label','Edit story');storyLabel.append(storyInput);body.append(titleLabel,storyLabel,label,button('Update entry',async()=>{await post('/api/admin/entries/'+e.id,{status:select.value,title:titleInput.value,description:storyInput.value});await loadRoom();}));card.append(img,body);grid.append(card);}if(!details.entries.length)empty(grid,'No dishes yet.','Submitted creations will appear here for review.');}
$('#member-filter').oninput=renderMembers;
document.querySelectorAll('[data-admin-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('.admin-tab').forEach(section=>section.hidden=section.id!=='admin-'+b.dataset.adminTab);document.querySelectorAll('[data-admin-tab]').forEach(n=>n.classList.toggle('selected',n===b));});
$('#admin-login').addEventListener('submit',act(async e=>{await post('/api/admin/login',values(e.target));e.target.reset();await refresh();}));
$('#admin-enroll').addEventListener('submit',act(async e=>{const data=values(e.target);if(invitation)data.invitation=invitation;const result=await post('/api/admin/enroll',data);e.target.reset();e.target.hidden=true;$('#totp-secret').textContent=result.secret;$('#admin-confirm').hidden=false;}));
$('#admin-confirm').addEventListener('submit',act(async e=>{await post('/api/admin/enroll/confirm',values(e.target));e.target.reset();$('#totp-secret').textContent='';invitation='';await refresh();status('Administrator account ready.');}));
roomForm($('#new-room'),{},true);
$('#new-room').addEventListener('submit',act(async e=>{const data=roomValues(e.target);const result=await post('/api/admin/rooms',data);selectedRoom=result.room.id;const box=el('div',undefined,'notice');box.append(el('h3','Room created. Save the access code.'),el('p',result.room.title),el('output',data.code,'secret-output'),el('input'));box.lastChild.value=location.origin+'/r/'+selectedRoom;box.lastChild.readOnly=true;box.append(button('I saved the code',()=>box.remove()));$('#room-list').before(box);roomForm(e.target,{},true);await refresh();$('#room-editor').scrollIntoView({behavior:'smooth'});}));
$('#edit-room').addEventListener('submit',act(async e=>{await post('/api/admin/rooms/'+selectedRoom,roomValues(e.target));await refresh();status('Room settings saved.');}));
$('#rotate-code').addEventListener('submit',act(async e=>{if(!confirm('Change this code and require participants to enter it again? Their votes stay used.'))return;await post('/api/admin/rooms/'+selectedRoom+'/code',values(e.target));e.target.reset();status('Room code changed. Share the new code privately.');}));
$('#approve-pending').onclick=act(async()=>{if(!confirm('Approve every pending participant in this room? Review names before confirming.'))return;await post('/api/admin/rooms/'+selectedRoom+'/approve-pending');await loadRoom();});
$('#export-results').onclick=act(async()=>{const response=await fetch('/api/admin/rooms/'+selectedRoom+'/export');if(!response.ok){const data=await response.json();throw new Error(data.error);}const url=URL.createObjectURL(await response.blob()),a=el('a');a.href=url;a.download='competition-results.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('#purge-room').addEventListener('submit',act(async e=>{if(!confirm('This is permanent. Delete the archived room and all its participant data and photos?'))return;const result=await sensitive('/api/admin/rooms/'+selectedRoom+'/purge',values(e.target));if(result){selectedRoom='';e.target.reset();await refresh();status('Archived room permanently deleted.');}}));
$('#site-form').addEventListener('submit',act(async e=>{await post('/api/admin/site',{...values(e.target),maintenance:e.target.elements.maintenance.checked});await refresh();status('Site settings saved.');}));
$('#logo-form').addEventListener('submit',act(async e=>{await post('/api/admin/logo',new FormData(e.target));e.target.reset();await refresh();status('Logo updated.');}));
$('#invite-admin').addEventListener('submit',act(async e=>{const result=await sensitive('/api/admin/invites',values(e.target));if(result){const box=$('#invite-result');box.replaceChildren(el('h3','Private admin invitation for '+result.username),el('p','Expires in 24 hours. Share only with the intended admin. Recovery invitations replace that account’s password and authenticator when accepted.'),el('output',result.url,'secret-output'),button('Dismiss invitation',()=>{box.replaceChildren();box.hidden=true;}));box.hidden=false;e.target.reset();}}));
$('#password-form').addEventListener('submit',act(async e=>{const result=await sensitive('/api/admin/password',values(e.target));if(result){e.target.reset();await refresh();status('Password changed. Other sessions for this account are invalidated.');}}));
refresh().catch(e=>status(e.message,true));
