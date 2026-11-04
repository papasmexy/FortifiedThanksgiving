const $ = selector => document.querySelector(selector);
let me, entries = [], previewURL;
let statusTimer;
function status(message, error = false) {
  const box = $('#status'); box.textContent = message; box.classList.toggle('error', error); box.hidden = false;
  clearTimeout(statusTimer);
  if (!error) statusTimer = setTimeout(() => { box.hidden = true; }, 6000);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(me ? { 'X-CSRF-Token': me.csrf } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) location.reload(); throw new Error(data.error || 'Please try again.'); }
  return data;
}
function empty(target, title, description) {
  const box = document.createElement('div'); box.className = 'empty';
  const heading = document.createElement('h3'); heading.textContent = title;
  const text = document.createElement('p'); text.textContent = description;
  box.append(heading, text); target.replaceChildren(box);
}
function render() {
  const page = ['gallery', 'submit', 'leaderboard'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'gallery';
  document.querySelectorAll('.page').forEach(el => el.hidden = !me.user || el.id !== `${page}-page`);
  document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === page); if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (!me.user) return;
  $('#votes-left').textContent = `♡ ${me.remainingVotes} of 3 votes left`;
  $('#entry-count').textContent = `${entries.length} ${entries.length === 1 ? 'creation' : 'creations'} at the table`;
  const gallery = $('#gallery-grid'); gallery.replaceChildren();
  const sorted = [...entries].sort($('#sort').value === 'popular' ? (a, b) => b.votes - a.votes : (a, b) => b.created_at.localeCompare(a.created_at));
  for (const entry of sorted) {
    const card = $('#card-template').content.cloneNode(true);
    card.querySelector('img').src = entry.image; card.querySelector('img').alt = entry.title;
    card.querySelector('.your-entry').hidden = !entry.mine;
    card.querySelector('.card-author').textContent = `FROM ${entry.author.toUpperCase()}’S KITCHEN`;
    card.querySelector('h3').textContent = entry.title;
    card.querySelector('.card-description').textContent = entry.description;
    card.querySelector('.vote-total').textContent = `${entry.votes} ${entry.votes === 1 ? 'vote' : 'votes'}`;
    const button = card.querySelector('button'); button.textContent = entry.voted ? '♥ Voted' : '♡ Give a vote'; button.disabled = !!entry.voted || me.remainingVotes === 0;
    button.setAttribute('aria-label', `${entry.voted ? 'Voted for' : 'Vote for'} ${entry.title}`);
    button.addEventListener('click', async () => {
      if (!confirm(`Give one of your three votes to “${entry.title}”? Votes are final.`)) return;
      button.disabled = true;
      try { await api(`/api/entries/${encodeURIComponent(entry.id)}/vote`, { method: 'POST' }); await refresh(); status('A little love, delivered. Your vote has been counted.'); }
      catch (error) { status(error.message, true); await refresh().catch(() => {}); }
    });
    gallery.append(card);
  }
  if (!entries.length) empty(gallery, 'The table is set. Be the first to share.', 'Your Thanksgiving creation could start something delicious.');
  const hasEntry = entries.some(e => e.mine); $('#entry-form').hidden = hasEntry; $('#already-submitted').hidden = !hasEntry;
  const board = $('#leaderboard-list'); board.replaceChildren();
  let previousVotes, rank;
  [...entries].sort((a, b) => b.votes - a.votes || a.created_at.localeCompare(b.created_at)).forEach((entry, index) => {
    if (entry.votes !== previousVotes) rank = index + 1;
    previousVotes = entry.votes;
    const row = document.createElement('article'); row.className = 'leader-row';
    const position = document.createElement('span'); position.className = 'rank'; position.textContent = String(rank).padStart(2, '0');
    const image = document.createElement('img'); image.src = entry.image; image.alt = entry.title; image.loading = 'lazy';
    const info = document.createElement('div'); const title = document.createElement('h3'); title.textContent = entry.title; const name = document.createElement('p'); name.textContent = `By ${entry.author}`; info.append(title, name);
    const votes = document.createElement('strong'); votes.className = 'leader-votes'; votes.textContent = `${entry.votes} ${entry.votes === 1 ? 'vote' : 'votes'}`;
    row.append(position, image, info, votes); board.append(row);
  });
  if (!entries.length) empty(board, 'Every great feast starts with one dish.', 'Share your creation to get the friendly competition started.');
}
async function refresh() {
  me = await api('/api/me');
  entries = me.user ? await api('/api/entries') : [];
  $('#demo-banner').hidden = !me.demo;
  $('#signin-panel').hidden = !!me.user;
  $('#demo-accounts').hidden = !me.demo;
  const account = $('#account');
  if (me.user) {
    const name = document.createElement('span'); name.className = 'account-name'; name.textContent = me.user.name;
    const logout = document.createElement('button'); logout.className = 'text-button'; logout.textContent = 'Sign out';
    logout.onclick = async () => { try { await api('/auth/logout', { method: 'POST' }); location.reload(); } catch (e) { status(e.message, true); } };
    account.replaceChildren(name, logout);
  }
  render();
}
document.querySelectorAll('[data-demo]').forEach(button => button.onclick = async () => {
  try { await api('/auth/demo', { method: 'POST', body: JSON.stringify({ account: button.dataset.demo }) }); await refresh(); }
  catch (error) { status(error.message, true); }
});
$('#entry-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#submit-button'); button.disabled = true; button.textContent = 'Bringing it to the table…';
  try { await api('/api/entries', { method: 'POST', body: new FormData(event.target) }); event.target.reset(); $('#preview').hidden = true; if (previewURL) URL.revokeObjectURL(previewURL); location.hash = '#gallery'; await refresh(); status('Your dish has a seat at the table. Thanks for sharing!'); }
  catch (error) { status(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Bring it to the table ↗'; }
});
$('#photo').addEventListener('change', event => {
  const file = event.target.files[0]; if (previewURL) URL.revokeObjectURL(previewURL);
  $('#preview').hidden = true;
  if (!file) return;
  if (file.size > 8 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { event.target.value = ''; status('Choose a JPG, PNG, or WebP photo under 8 MB.', true); return; }
  previewURL = URL.createObjectURL(file); $('#preview').src = previewURL; $('#preview').hidden = false;
});
$('#sort').addEventListener('change', render);
window.addEventListener('hashchange', () => {
  render();
  const destination = me?.user ? document.querySelector('.page:not([hidden])') : $('#signin-panel');
  destination?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  if (me?.user && location.hash === '#leaderboard') refresh().catch(e => status(e.message, true));
});
refresh().catch(error => status(error.message, true));
