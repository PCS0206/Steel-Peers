'use strict';
// 화면: 카메라, 렌더링, 입력(마우스/터치), 패널, 저장/불러오기

const $ = id => document.getElementById(id);
const canvas = $('map'), ctx = canvas.getContext('2d');
const DAY_MS = [Infinity, 700, 300, 90];
const SAVE_KEY = 'steelpeers.save.v1', AUTO_KEY = 'steelpeers.auto.v1';
const TOPBAR_H = 42;

let G = null;
let phase = 'menu';             // menu | pick | play | over
let speed = 0, acc = 0, lastT = 0;
let cam = { x: 0, y: 0, z: 1 }, minZ = 0.4;
let hover = -1, selProv = -1, selArmies = new Set(), moveMode = false;
let panelDirty = true;

const isMobile = () => innerWidth <= 720;
// 패널이 가리는 영역을 뺀 지도 표시 영역
function viewRect() {
  return isMobile() ? { w: innerWidth, h: innerHeight * 0.6 - TOPBAR_H / 2, top: TOPBAR_H }
    : { w: innerWidth - 290, h: innerHeight - TOPBAR_H, top: TOPBAR_H };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  const v = viewRect();
  minZ = Math.min(v.w / MAP_W, v.h / MAP_H) * 0.97;
  if (G) G.dirty = true;
}
function centerOn(x, y, z) {
  const v = viewRect();
  cam.z = Math.min(6, Math.max(minZ, z));
  cam.x = x - v.w / 2 / cam.z;
  cam.y = y - (v.top + v.h / 2) / cam.z;
}
const fitCamera = () => centerOn(MAP_W / 2, MAP_H / 2, minZ);
const toWorld = (sx, sy) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });
function provAt(sx, sy) {
  const w = toWorld(sx, sy);
  const gx = Math.floor(w.x / RES), gy = Math.floor(w.y / RES);
  if (!G || gx < 0 || gy < 0 || gx >= GW || gy >= GH) return -1;
  const id = G.map.idmap[gy * GW + gx];
  return G.provs[id].land ? id : -1;
}
// 시야 밖이면 적 정보를 숨긴다
const canSee = pid => !G.vis || G.vis.has(pid);
const isFriend = o => G.player >= 0 && (o === G.player || sameFaction(G, G.player, o));

// ---------- 게임 시작/저장 ----------
function enterGame(g, p) {
  G = g; phase = p; speed = 0; selProv = -1; selArmies.clear(); hover = -1; moveMode = false;
  $('overlay').classList.add('hidden');
  G.dirty = true; panelDirty = true;
}
function startGame() {
  enterGame(newGame(+$('seed').value || 1, +$('ncountries').value), 'pick');
  banner('플레이할 국가를 지도에서 클릭하세요');
  fitCamera();
}
function pickCountry(id) {
  G.player = id; G.countries[id].ai = false;
  phase = 'play'; speed = 0;
  banner(`${G.countries[id].name} — Space로 시작`, 4000);
  focusCapital();
}
function focusCapital() {
  const cap = G.provs[G.countries[G.player].capital];
  selProv = cap.id; selectOwnArmies();
  centerOn(cap.x, cap.y, 1.6);
  G.dirty = true; panelDirty = true;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};
function saveGame(key = SAVE_KEY) {
  if (!G || G.player < 0 || G.over) return false;
  const ok = store.set(key, JSON.stringify(serialize(G)));
  if (key === SAVE_KEY) banner(ok ? '저장했습니다' : '저장에 실패했습니다 (브라우저 저장소 사용 불가)', 1800);
  return ok;
}
function loadGame(key = SAVE_KEY) {
  const raw = store.get(key);
  if (!raw) { banner('저장된 게임이 없습니다', 1800); return false; }
  try {
    const g = deserialize(JSON.parse(raw));
    enterGame(g, 'play');
    focusCapital();
    banner(`불러왔습니다 — ${dateStr(g.day)}`, 2500);
    return true;
  } catch (e) { banner('저장 데이터를 읽을 수 없습니다', 2500); return false; }
}
let bannerTimer = 0;
function banner(text, ms) {
  const b = $('banner'); b.textContent = text; b.style.display = 'block';
  clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => { b.style.display = 'none'; }, ms);
}
function setSpeed(s) {
  if (phase !== 'play') return;
  speed = s; panelDirty = true; syncTop(); $('banner').style.display = 'none';
}
function showMenu() {
  speed = 0; syncTop();
  const has = !!(store.get(AUTO_KEY) || store.get(SAVE_KEY));
  $('continue').style.display = has ? 'block' : 'none';
  $('overlay').classList.remove('hidden');
}

// ---------- 선택/명령 ----------
function selectOwnArmies() {
  selArmies = new Set(G.armies.filter(a => a.prov === selProv && a.owner === G.player).map(a => a.id));
}
function orderMove(target) {
  const armies = G.armies.filter(a => selArmies.has(a.id));
  if (!armies.length) { banner('먼저 사단이 있는 지역을 선택하세요', 1800); return; }
  let moved = 0;
  for (const a of armies) {
    const p = findPath(G, a.prov, target, a.owner);
    if (p) { a.path = p; a.prog = 0; moved++; }
  }
  if (!moved) banner('이동할 수 없는 지역입니다 (전쟁 중이 아닌 국가의 영토)', 2000);
  G.dirty = true;
}
function handleTap(sx, sy) {
  const id = provAt(sx, sy);
  if (id < 0) return;
  if (phase === 'pick') { if (G.provs[id].owner >= 0) pickCountry(G.provs[id].owner); return; }
  if (phase !== 'play') return;
  if (moveMode) { moveMode = false; orderMove(id); panelDirty = true; return; }
  selProv = id; selectOwnArmies(); G.dirty = true; panelDirty = true;
}

// ---------- 입력: 포인터(마우스/터치 공통) ----------
const ptrs = new Map();
let gesture = null;
const pdist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
function zoomAt(sx, sy, factor) {
  const before = toWorld(sx, sy);
  cam.z = Math.min(6, Math.max(minZ, cam.z * factor));
  cam.x = before.x - sx / cam.z; cam.y = before.y - sy / cam.z;
}
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) {
    gesture = { x: e.clientX, y: e.clientY, moved: false, long: false, touch: e.pointerType !== 'mouse' };
    if (gesture.touch) { // 길게 누르면 이동 명령
      const g = gesture;
      g.timer = setTimeout(() => { if (gesture !== g || g.moved || phase !== 'play') return; g.long = true; const id = provAt(g.x, g.y); if (id >= 0) orderMove(id); }, 450);
    }
  } else if (ptrs.size === 2) {
    if (gesture) clearTimeout(gesture.timer);
    gesture = { pinch: pdist(), moved: true };
  }
});
canvas.addEventListener('pointermove', e => {
  if (!G) return;
  if (ptrs.has(e.pointerId)) {
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && gesture && gesture.pinch) {
      const d = pdist(), [a, b] = [...ptrs.values()];
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / gesture.pinch);
      gesture.pinch = d;
    } else if (gesture && gesture.x !== undefined) {
      if (!gesture.moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 6) { gesture.moved = true; clearTimeout(gesture.timer); }
      if (gesture.moved) { cam.x -= (e.clientX - prev.x) / cam.z; cam.y -= (e.clientY - prev.y) / cam.z; canvas.style.cursor = 'grabbing'; }
    }
  }
  if (e.pointerType === 'mouse') {
    const h = provAt(e.clientX, e.clientY);
    if (h !== hover) { hover = h; G.dirty = true; }
  }
});
function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  canvas.style.cursor = 'grab';
  if (gesture && gesture.x !== undefined && ptrs.size === 0) {
    clearTimeout(gesture.timer);
    if (e.type === 'pointerup' && !gesture.moved && !gesture.long) handleTap(e.clientX, e.clientY);
  }
  if (ptrs.size === 0) gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (phase !== 'play') return;
  const id = provAt(e.clientX, e.clientY);
  if (id >= 0) orderMove(id);
});
canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
window.addEventListener('keydown', e => {
  if (phase !== 'play' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setSpeed(speed ? 0 : 1); }
  else if (['Digit1', 'Digit2', 'Digit3'].includes(e.code)) setSpeed(+e.code.slice(-1));
});
document.querySelector('.speeds').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) setSpeed(+b.dataset.speed);
});
$('start').addEventListener('click', startGame);
$('continue').addEventListener('click', () => {
  const auto = store.get(AUTO_KEY), manual = store.get(SAVE_KEY);
  const pick = (!manual || (auto && JSON.parse(auto).day > JSON.parse(manual).day)) ? AUTO_KEY : SAVE_KEY;
  loadGame(pick);
});
$('btnSave').addEventListener('click', () => saveGame());
$('btnLoad').addEventListener('click', () => loadGame());
$('btnMenu').addEventListener('click', showMenu);
$('overlay').addEventListener('click', e => { if (e.target === $('overlay') && (phase === 'play' || phase === 'pick')) $('overlay').classList.add('hidden'); });
window.addEventListener('resize', resize);

// ---------- 패널 액션 ----------
$('panel').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || phase !== 'play') return;
  const me = G.countries[G.player], p = selProv >= 0 ? G.provs[selProv] : null;
  const other = p ? p.owner : -1;
  switch (b.dataset.act) {
    case 'train': if (me.queue.length < MAX_LINES) me.queue.push({ type: b.dataset.type, progress: 0 }); break;
    case 'rmline': me.queue.splice(+b.dataset.i, 1); break;
    case 'war': if (!declareWar(G, G.player, other)) banner('휴전 기간이거나 동맹국이라 선전포고할 수 없습니다', 2000); break;
    case 'peace': banner(proposePeace(G, G.player, other, false).msg, 2500); break;
    case 'demand': banner(proposePeace(G, G.player, other, true).msg, 3000); break;
    case 'ally': banner(proposeAlliance(G, G.player, other).msg, 2500); break;
    case 'leave': leaveFaction(G, G.player); break;
    case 'move': moveMode = !moveMode; if (moveMode) banner('이동할 지역을 탭하세요', 2000); break;
    case 'split': {
      const a = G.armies.find(x => selArmies.has(x.id) && x.comp[b.dataset.type] >= 1 && x.hp >= 2);
      if (a) selArmies.add(splitArmy(G, a, b.dataset.type).id);
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
const compText = a => Object.entries(a.comp).filter(([, v]) => v >= 0.05).map(([t, v]) => `${UNITS[t].name} ${v.toFixed(1)}`).join(' · ');
const factionTag = c => c.faction >= 0 ? `<span class="tag">${esc(G.factions[c.faction].name)}</span>` : '';

function syncTop() {
  document.querySelectorAll('.speeds button').forEach(b => b.classList.toggle('on', +b.dataset.speed === speed));
  if (!G) return;
  $('date').textContent = dateStr(G.day);
  if (G.player >= 0) {
    const me = G.countries[G.player];
    const divs = G.armies.filter(a => a.owner === me.id).reduce((s, a) => s + a.hp, 0);
    $('pp').innerHTML = `${sw(me)}${esc(me.name)} · PP <b>${me.pp.toFixed(0)}</b> (+${me.income.toFixed(1)}) · 인력 <b>${me.manpower.toFixed(0)}k</b> · 사단 ${divs.toFixed(1)}`;
    const w = warsOf(G, me.id);
    $('wars').textContent = w.length ? '⚔ ' + w.map(i => G.countries[i].name).join(', ') : '';
  }
}

function renderPanel() {
  panelDirty = false;
  if (phase === 'pick') { $('panel').innerHTML = '<p class="dim">지도에서 플레이할 국가를 클릭하세요.</p>'; return; }
  if (phase !== 'play') { $('panel').innerHTML = '<p class="dim">게임이 끝났습니다.</p>'; return; }
  const me = G.countries[G.player];
  let h = `<h2>${sw(me)}${esc(me.name)}${factionTag(me)}</h2>`;
  h += `<div class="dim">영토 ${ownedCount(G, me.id)} / ${G.landCount} · 승리: 60% 점령 또는 동맹 통일</div>`;
  const divs = G.armies.filter(a => a.owner === me.id).reduce((s, a) => s + a.hp, 0);
  h += `<div class="stat">PP <b>${me.pp.toFixed(0)}</b> (+${me.income.toFixed(1)}) · 인력 <b>${me.manpower.toFixed(0)}k</b> · 사단 ${divs.toFixed(1)}</div>`;
  const w = warsOf(G, me.id);
  if (w.length) h += `<div class="warn">⚔ ${w.map(i => esc(G.countries[i].name)).join(', ')}</div>`;
  if (me.faction >= 0) h += `<div class="row"><button data-act="leave">동맹 탈퇴</button></div>`;

  h += `<h3>생산 라인 (반복)</h3>`;
  me.queue.forEach((q, i) => {
    const u = UNITS[q.type], stalled = q.progress >= u.pp - 1e-6 && me.manpower < u.mp;
    h += `<div class="dim">${u.name} · ${i < MAX_PARALLEL ? '진행' : '대기'} ${(q.progress / u.pp * 100).toFixed(0)}%${stalled ? ' <span class="warn">인력 부족</span>' : ''} <a href="#" data-act="rmline" data-i="${i}" onclick="return false">[삭제]</a></div><div class="bar"><i style="width:${q.progress / u.pp * 100}%"></i></div>`;
  });
  h += `<div class="row">` + Object.entries(UNITS).map(([t, u]) => `<button data-act="train" data-type="${t}" ${me.queue.length >= MAX_LINES ? 'disabled' : ''} title="PP ${u.pp} · 인력 ${u.mp}k">+${u.name}</button>`).join('') + `</div>`;
  if (!me.queue.length) h += `<div class="dim">라인이 없으면 PP가 쌓이기만 합니다.</div>`;

  const p = selProv >= 0 ? G.provs[selProv] : null;
  if (p) {
    const owner = p.owner >= 0 ? G.countries[p.owner] : null, ctl = p.controller >= 0 ? G.countries[p.controller] : null;
    const T = TERRAIN[p.terrain];
    h += `<h3>지역</h3><b>${esc(p.name)}</b>${owner && owner.capital === p.id ? ' ★수도' : ''}<br>`;
    h += `<span class="dim">소유: ${owner ? sw(owner) + esc(owner.name) : '중립'}${ctl && ctl !== owner ? ` · <span class="warn">${esc(ctl.name)} 점령</span>` : ''}</span><br>`;
    h += `<span class="dim">지형: ${T.name} (이동 ×${T.move}, 방어 ×${T.def}) · 산업 ${p.industry}</span>`;
    const mine = G.armies.filter(a => a.prov === p.id && a.owner === me.id);
    if (mine.length) {
      h += `<h3>내 사단</h3>`;
      for (const a of mine) {
        const sup = isSupplied(G, a);
        h += `<label class="army"><input type="checkbox" data-army="${a.id}" ${selArmies.has(a.id) ? 'checked' : ''}> ${compText(a)}<br><span class="dim">조직도 ${(a.org * 100).toFixed(0)}% · ${sup ? '<span class="ok">보급 양호</span>' : '<span class="warn">보급 끊김</span>'}${a.path.length ? ' · 이동 중' : ''}</span></label>`;
      }
      const types = Object.keys(UNITS).filter(t => mine.some(a => a.comp[t] >= 1 && a.hp >= 2));
      h += `<div class="row">${types.map(t => `<button data-act="split" data-type="${t}">${UNITS[t].name} 1 분리</button>`).join('')}<button data-act="move" class="${moveMode ? 'on-mode' : ''}">${moveMode ? '목적지를 탭…' : '이동 모드'}</button></div><div class="dim">우클릭 / 길게 누르기 / 이동 모드로 명령</div>`;
    }
    if (canSee(p.id)) {
      const foes = {};
      G.armies.filter(a => a.prov === p.id && a.owner !== me.id).forEach(a => { foes[a.owner] = (foes[a.owner] || 0) + a.hp; });
      for (const [o, hp] of Object.entries(foes)) h += `<div>${sw(G.countries[o])}${esc(G.countries[o].name)} ${hp.toFixed(1)}개 사단</div>`;
    } else h += `<div class="dim">시야 밖 — 부대 정보를 알 수 없다</div>`;

    if (owner && owner.id !== me.id) {
      const war = atWar(G, me.id, owner.id), allied = sameFaction(G, me.id, owner.id);
      h += `<h3>외교 — ${esc(owner.name)}${factionTag(owner)}</h3><div class="row">`;
      if (war) {
        const since = G.day - G.wars[warKey(me.id, owner.id)], sc = warScore(G, me.id, owner.id);
        h += `<button data-act="peace">백색 강화</button><button data-act="demand" ${sc ? '' : 'disabled'}>점령지 요구 (${sc})</button><span class="dim">전쟁 ${since}일째</span>`;
      } else if (allied) h += `<span class="ok">동맹국</span>`;
      else {
        if (neighborsOf(G, me.id).includes(owner.id)) h += `<button data-act="war">선전포고</button>`;
        h += `<button data-act="ally">동맹 제안</button>`;
      }
      h += `</div>`;
    }
  }
  h += `<h3>세계</h3>`;
  for (const c of G.countries) h += `<div>${sw(c)}${esc(c.name)}${factionTag(c)}${c.alive ? ` <span class="dim">${ownedCount(G, c.id)}지역${isFriend(c.id) || !G.vis ? ' · 전력 ' + strength(G, c.id).toFixed(1) : ''}</span>` : ' ✝'}</div>`;
  $('panel').innerHTML = h;
}

function renderLog() {
  $('log').innerHTML = G.log.slice(-6).map(l => `<div style="border-left-color:rgb(${(G.countries[l.owner] || { color: [90, 90, 90] }).color})">${dateStr(l.day).slice(5)} ${esc(l.text)}</div>`).join('');
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
  if (G.dirty) {
    G.vis = phase === 'play' ? visibleSet(G, G.player) : null;
    renderMapImage(G, phase === 'play' || phase === 'pick' ? hover : -1, selProv, G.vis);
    G.dirty = false;
  }
  ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(G.map.canvas, 0, 0, MAP_W, MAP_H);

  // 지형 기호
  if (cam.z > 1.2) {
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(0,0,0,.35)';
    for (const p of G.provs) if (p.land && TERRAIN[p.terrain].glyph) ctx.fillText(TERRAIN[p.terrain].glyph, p.x + 14, p.y - 12);
  }
  // 국가명
  if (cam.z < 2.5) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 22px sans-serif'; ctx.lineJoin = 'round';
    for (const c of G.countries) {
      if (!c.alive) continue;
      const own = G.provs.filter(p => p.owner === c.id);
      if (!own.length) continue;
      const x = own.reduce((s, p) => s + p.x, 0) / own.length, y = own.reduce((s, p) => s + p.y, 0) / own.length;
      ctx.lineWidth = 4; ctx.strokeStyle = '#000a'; ctx.strokeText(c.name, x, y);
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.85; ctx.fillText(c.name, x, y); ctx.globalAlpha = 1;
    }
  }
  // 수도
  ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const c of G.countries) if (c.alive) { const p = G.provs[c.capital]; ctx.fillStyle = '#ffe58a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText('★', p.x, p.y - 14); ctx.fillText('★', p.x, p.y - 14); }

  // 이동 경로
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  for (const a of G.armies) {
    if (!a.path.length) continue;
    const mine = a.owner === G.player;
    if (!mine && !(canSee(a.prov) && selProv === a.prov)) continue;
    ctx.strokeStyle = mine ? (selArmies.has(a.id) ? '#fff' : '#ffe58a') : `rgb(${G.countries[a.owner].color})`;
    ctx.beginPath(); ctx.moveTo(G.provs[a.prov].x, G.provs[a.prov].y);
    for (const n of a.path) ctx.lineTo(G.provs[n].x, G.provs[n].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 부대 마커 (시야 밖의 적 부대는 숨김)
  const groups = new Map();
  for (const a of G.armies) {
    if (!isFriend(a.owner) && !canSee(a.prov)) continue;
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
    while (acc >= DAY_MS[speed]) {
      acc -= DAY_MS[speed]; tickDay(G); G.dirty = true; panelDirty = true;
      if (G.day % 30 === 0) saveGame(AUTO_KEY);
      if (G.over) break;
    }
  }
  if (G && G.over && phase === 'play') {
    speed = 0; phase = 'over';
    banner(G.over === 'win' ? '🏆 승리!' : '💀 패배: 나라가 멸망했습니다.');
    $('overlay').querySelector('p').textContent = `${dateStr(G.day)} — ${G.over === 'win' ? '승리!' : '패배'}`;
    $('continue').style.display = 'none';
    $('overlay').classList.remove('hidden');
    G.dirty = true;
  }
  if (G && panelDirty) { renderPanel(); syncTop(); renderLog(); }
  draw();
  requestAnimationFrame(frame);
}

resize(); syncTop();
$('panel').innerHTML = '<p class="dim">새 게임을 시작하세요.</p>';
if (store.get(AUTO_KEY) || store.get(SAVE_KEY)) $('continue').style.display = 'block';
requestAnimationFrame(frame);
