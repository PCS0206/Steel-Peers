'use strict';
// 화면: 카메라, 렌더링, 입력, 패널

const $ = id => document.getElementById(id);
const canvas = $('map'), ctx = canvas.getContext('2d');
const DAY_MS = [Infinity, 700, 300, 90];

let G = null;
let phase = 'menu';             // menu | pick | play
let speed = 0, acc = 0, lastT = 0;
let cam = { x: 0, y: 0, z: 1 }, minZ = 0.4;
let hover = -1, selProv = -1, selArmies = new Set();
let panelDirty = true, lastPanelDay = -1;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  minZ = Math.min(innerWidth / MAP_W, (innerHeight - 42) / MAP_H) * 0.95;
}
function fitCamera() {
  cam.z = minZ;
  cam.x = MAP_W / 2 - innerWidth / 2 / cam.z + (innerWidth > 720 ? 145 / cam.z : 0);
  cam.y = MAP_H / 2 - (innerHeight + 42) / 2 / cam.z;
}
const toWorld = (sx, sy) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });
function provAt(sx, sy) {
  const w = toWorld(sx, sy);
  const gx = Math.floor(w.x / RES), gy = Math.floor(w.y / RES);
  if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return -1;
  const id = G.map.idmap[gy * GW + gx];
  return G.provs[id].land ? id : -1;
}

// ---------- 새 게임 ----------
function startGame() {
  G = newGame(+$('seed').value || 1, +$('ncountries').value);
  phase = 'pick'; speed = 0; selProv = -1; selArmies.clear(); hover = -1;
  $('overlay').classList.add('hidden');
  banner('플레이할 국가를 지도에서 클릭하세요');
  fitCamera(); G.dirty = true; panelDirty = true;
}
function pickCountry(id) {
  G.player = id; G.countries[id].ai = false;
  phase = 'play'; speed = 0;
  banner(`${G.countries[id].name} — Space로 시작`, 4000);
  const cap = G.provs[G.countries[id].capital];
  selProv = cap.id; selectOwnArmies();
  cam.z = Math.max(minZ, 1.4); cam.x = cap.x - innerWidth / 2 / cam.z + 145 / cam.z; cam.y = cap.y - innerHeight / 2 / cam.z;
  panelDirty = true;
}
let bannerTimer = 0;
function banner(text, ms) {
  const b = $('banner'); b.textContent = text; b.style.display = 'block';
  clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => { b.style.display = 'none'; }, ms);
}
function setSpeed(s) { speed = s; panelDirty = true; syncTop(); if (phase === 'play') $('banner').style.display = 'none'; }

// ---------- 선택/명령 ----------
function selectOwnArmies() {
  selArmies = new Set(G.armies.filter(a => a.prov === selProv && a.owner === G.player).map(a => a.id));
}
function orderMove(target) {
  const armies = G.armies.filter(a => selArmies.has(a.id));
  if (!armies.length) return;
  let moved = 0;
  for (const a of armies) {
    const p = findPath(G, a.prov, target, a.owner);
    if (p) { a.path = p; a.prog = 0; moved++; }
  }
  if (!moved) banner('이동할 수 없는 지역입니다 (바다이거나 전쟁 중이 아닌 국가의 영토)', 2000);
}

// ---------- 입력 ----------
let drag = null;
canvas.addEventListener('mousedown', e => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, moved: false }; });
window.addEventListener('mousemove', e => {
  if (!G) return;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.moved || Math.hypot(dx, dy) > 4) {
      drag.moved = true; cam.x -= dx / cam.z; cam.y -= dy / cam.z; drag.x = e.clientX; drag.y = e.clientY;
      canvas.style.cursor = 'grabbing';
    }
  }
  const h = provAt(e.clientX, e.clientY);
  if (h !== hover) { hover = h; G.dirty = true; }
});
window.addEventListener('mouseup', e => {
  if (!drag) return;
  const wasClick = !drag.moved; drag = null; canvas.style.cursor = 'grab';
  if (!wasClick || !G || e.target !== canvas) return;
  const id = provAt(e.clientX, e.clientY);
  if (id < 0) return;
  if (phase === 'pick') { if (G.provs[id].owner >= 0) pickCountry(G.provs[id].owner); return; }
  selProv = id; selectOwnArmies(); G.dirty = true; panelDirty = true;
});
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (phase !== 'play') return;
  const id = provAt(e.clientX, e.clientY);
  if (id >= 0) orderMove(id);
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const before = toWorld(e.clientX, e.clientY);
  cam.z = Math.min(6, Math.max(minZ, cam.z * Math.exp(-e.deltaY * 0.0015)));
  cam.x = before.x - e.clientX / cam.z; cam.y = before.y - e.clientY / cam.z;
}, { passive: false });
window.addEventListener('keydown', e => {
  if (phase !== 'play' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setSpeed(speed ? 0 : 1); }
  else if (['Digit1', 'Digit2', 'Digit3'].includes(e.code)) setSpeed(+e.code.slice(-1));
});
document.querySelector('.speeds').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b && phase === 'play') setSpeed(+b.dataset.speed);
});
$('start').addEventListener('click', startGame);
window.addEventListener('resize', resize);

$('panel').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || phase !== 'play') return;
  const me = G.countries[G.player], p = G.provs[selProv];
  switch (b.dataset.act) {
    case 'train': if (me.queue.length < 6) me.queue.push({ progress: 0 }); break;
    case 'rmline': me.queue.splice(+b.dataset.i, 1); break;
    case 'war': if (!declareWar(G, G.player, p.owner)) banner('휴전 기간이라 선전포고할 수 없습니다', 2000); break;
    case 'peace': banner(proposePeace(G, G.player, p.owner).msg, 2500); break;
    case 'split': {
      const a = G.armies.find(x => selArmies.has(x.id) && x.hp >= 2);
      if (a) { a.hp -= 1; selArmies.add(spawnArmy(G, a.owner, a.prov, 1).id); }
      break;
    }
  }
  G.dirty = true; panelDirty = true;
});
$('panel').addEventListener('change', e => {
  const id = +e.target.dataset.army; if (!id) return;
  e.target.checked ? selArmies.add(id) : selArmies.delete(id);
});

// ---------- 패널/상단바 ----------
const sw = c => `<span class="swatch" style="background:rgb(${c.color})"></span>`;
const esc = s => String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

function syncTop() {
  document.querySelectorAll('.speeds button').forEach(b => b.classList.toggle('on', +b.dataset.speed === speed));
  if (!G) return;
  $('date').textContent = dateStr(G.day);
  if (G.player >= 0) {
    const me = G.countries[G.player];
    $('pp').innerHTML = `${sw(me)}${esc(me.name)} · PP <b>${me.pp.toFixed(0)}</b> (+${me.income.toFixed(1)}/일) · 사단 ${G.armies.filter(a => a.owner === me.id).reduce((s, a) => s + a.hp, 0).toFixed(1)}`;
    const w = warsOf(G, me.id);
    $('wars').textContent = w.length ? '⚔ ' + w.map(i => G.countries[i].name).join(', ') : '';
  }
}

function renderPanel() {
  panelDirty = false; lastPanelDay = G.day;
  if (phase !== 'play') { $('panel').innerHTML = '<p class="dim">국가를 선택하면 시작합니다.</p>'; return; }
  const me = G.countries[G.player];
  let h = `<h2>${sw(me)}${esc(me.name)}</h2>`;
  h += `<div class="dim">영토 ${provCount(G, me.id)} / ${G.landCount} · 승리: 60% 점령</div>`;
  h += `<h3>생산 라인 (사단 ${DIV_COST}PP, 반복)</h3>`;
  me.queue.forEach((q, i) => { h += `<div class="dim">라인 ${i + 1} · ${i < MAX_PARALLEL ? '진행' : '대기'} ${(q.progress / DIV_COST * 100).toFixed(0)}% <a href="#" data-act="rmline" data-i="${i}" onclick="return false">[삭제]</a></div><div class="bar"><i style="width:${q.progress / DIV_COST * 100}%"></i></div>`; });
  h += `<div class="row"><button data-act="train" ${me.queue.length >= 6 ? 'disabled' : ''}>+ 생산 라인 추가</button></div>`;
  if (!me.queue.length) h += `<div class="dim">라인이 없으면 PP가 쌓이기만 합니다.</div>`;

  const p = selProv >= 0 ? G.provs[selProv] : null;
  if (p) {
    const owner = p.owner >= 0 ? G.countries[p.owner] : null;
    h += `<h3>지역</h3><b>${esc(p.name)}</b>${owner && owner.capital === p.id ? ' ★수도' : ''}<br>`;
    h += `<span class="dim">소유: ${owner ? sw(owner) + esc(owner.name) : '중립'} · 산업 ${p.industry}</span>`;
    const mine = G.armies.filter(a => a.prov === p.id && a.owner === me.id);
    if (mine.length) {
      h += `<h3>내 사단</h3>`;
      for (const a of mine) h += `<label class="army"><input type="checkbox" data-army="${a.id}" ${selArmies.has(a.id) ? 'checked' : ''}> ${a.hp.toFixed(1)}개 사단${a.path.length ? ' → 이동 중' : ''}</label>`;
      h += `<div class="row"><button data-act="split" ${mine.some(a => a.hp >= 2) ? '' : 'disabled'}>1개 분리</button></div><div class="dim">우클릭으로 이동 명령</div>`;
    }
    const foes = {};
    G.armies.filter(a => a.prov === p.id && a.owner !== me.id).forEach(a => { foes[a.owner] = (foes[a.owner] || 0) + a.hp; });
    for (const [o, hp] of Object.entries(foes)) h += `<div>${sw(G.countries[o])}${esc(G.countries[o].name)} ${hp.toFixed(1)}개 사단</div>`;
    if (owner && owner.id !== me.id) {
      h += `<h3>외교</h3><div class="row">`;
      if (atWar(G, me.id, owner.id)) h += `<button data-act="peace">강화 제안</button><span class="dim">전쟁 ${G.day - G.wars[warKey(me.id, owner.id)]}일째</span>`;
      else if (neighborsOf(G, me.id).includes(owner.id)) h += `<button data-act="war">${esc(owner.name)}에 선전포고</button>`;
      else h += `<span class="dim">국경을 맞대야 선전포고할 수 있다</span>`;
      h += `</div>`;
    }
  }
  h += `<h3>세계</h3>`;
  for (const c of G.countries) h += `<div>${sw(c)}${esc(c.name)}${c.alive ? ` <span class="dim">${provCount(G, c.id)}지역 · 전력 ${strength(G, c.id).toFixed(1)}</span>` : ' ✝'}</div>`;
  $('panel').innerHTML = h;
}

function renderLog() {
  const el = $('log'); const rows = G.log.slice(-6);
  el.innerHTML = rows.map(l => `<div style="border-left-color:rgb(${(G.countries[l.owner] || { color: [90, 90, 90] }).color})">${dateStr(l.day).slice(5)} ${esc(l.text)}</div>`).join('');
}

// ---------- 그리기 ----------
function flag(x, y, color, n, selected) {
  const w = 22, h = 14;
  ctx.fillStyle = `rgb(${color})`; ctx.fillRect(x - w / 2, y - h / 2, w, h);
  ctx.lineWidth = selected ? 2 : 1; ctx.strokeStyle = selected ? '#fff' : '#101820'; ctx.strokeRect(x - w / 2, y - h / 2, w, h);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5; ctx.strokeText(n, x, y + 0.5); ctx.fillText(n, x, y + 0.5);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a1a2c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!G) return;
  if (G.dirty) { renderMapImage(G, phase === 'play' || phase === 'pick' ? hover : -1, selProv); G.dirty = false; }
  ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(G.map.canvas, 0, 0, MAP_W, MAP_H);

  // 국가명
  if (cam.z < 2.5) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 22px sans-serif'; ctx.lineJoin = 'round';
    for (const c of G.countries) {
      if (!c.alive) continue;
      const own = G.provs.filter(p => p.owner === c.id);
      const x = own.reduce((s, p) => s + p.x, 0) / own.length, y = own.reduce((s, p) => s + p.y, 0) / own.length;
      ctx.lineWidth = 4; ctx.strokeStyle = '#000a'; ctx.strokeText(c.name, x, y);
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.85; ctx.fillText(c.name, x, y); ctx.globalAlpha = 1;
    }
  }
  // 수도
  ctx.font = '14px sans-serif';
  for (const c of G.countries) if (c.alive) { const p = G.provs[c.capital]; ctx.fillStyle = '#ffe58a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText('★', p.x, p.y - 14); ctx.fillText('★', p.x, p.y - 14); }

  // 이동 경로
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  for (const a of G.armies) {
    if (!a.path.length) continue;
    const mine = a.owner === G.player;
    if (!mine && !(selProv === a.prov)) continue;
    ctx.strokeStyle = mine ? (selArmies.has(a.id) ? '#fff' : '#ffe58a') : `rgb(${G.countries[a.owner].color})`;
    ctx.beginPath(); ctx.moveTo(G.provs[a.prov].x, G.provs[a.prov].y);
    for (const n of a.path) ctx.lineTo(G.provs[n].x, G.provs[n].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 부대 마커
  const groups = new Map();
  for (const a of G.armies) {
    const key = a.prov + ':' + a.owner;
    if (!groups.has(key)) groups.set(key, { prov: a.prov, owner: a.owner, hp: 0, sel: false });
    const g = groups.get(key); g.hp += a.hp; g.sel = g.sel || selArmies.has(a.id);
  }
  const perProv = new Map();
  for (const g of groups.values()) {
    const i = perProv.get(g.prov) || 0; perProv.set(g.prov, i + 1);
    const p = G.provs[g.prov];
    flag(p.x + i * 14 - 4, p.y + 4 + i * 10, G.countries[g.owner].color, Math.ceil(g.hp - 1e-6), g.sel);
  }
}

function frame(t) {
  const dt = Math.min(200, t - lastT); lastT = t;
  if (G && phase === 'play' && speed && !G.over) {
    acc += dt;
    while (acc >= DAY_MS[speed]) { acc -= DAY_MS[speed]; tickDay(G); G.dirty = true; panelDirty = true; if (G.over) break; }
  }
  if (G && G.over && phase === 'play') {
    speed = 0; phase = 'over';
    banner(G.over === 'win' ? '🏆 승리! 대륙을 제패했습니다.' : '💀 패배: 나라가 멸망했습니다.');
    $('overlay').classList.remove('hidden');
    $('overlay').querySelector('p').textContent = G.over === 'win' ? `${dateStr(G.day)} — 승리!` : `${dateStr(G.day)} — 패배`;
  }
  if (G && panelDirty) { renderPanel(); syncTop(); renderLog(); }
  draw();
  requestAnimationFrame(frame);
}

resize(); syncTop(); renderPanelIdle();
function renderPanelIdle() { $('panel').innerHTML = '<p class="dim">새 게임을 시작하세요.</p>'; }
requestAnimationFrame(frame);
