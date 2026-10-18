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
let hover = -1, selProv = -1, selArmies = new Set(), moveMode = false, selFront = null;
let winTab = null;                 // 왼쪽 탭 창: null | 'eco' | 'mil' | 'dip'
let selBox = null;                 // 드래그 박스 선택 중인 화면 사각형
let dragMode = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ? 'pan' : 'select';   // 드래그 동작: 박스 선택 / 지도 이동
let drawMode = null;            // 전선/화살표 그리기: { kind:'line'|'arrow', front, items:[], enemy, anchor }
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
  return G ? findProvince(G.map, w.x, w.y) : -1;
}
// 시야 밖이면 적 정보를 숨긴다
const canSee = pid => !G.vis || G.vis.has(pid);
const isFriend = o => G.player >= 0 && (o === G.player || sameFaction(G, G.player, o));

// ---------- 게임 시작/저장 ----------
function enterGame(g, p) {
  G = g; lastEventId = g.logSeq; phase = p; speed = 0; selProv = -1; selArmies.clear(); hover = -1; moveMode = false; selFront = null; drawMode = null; selBox = null; winTab = null; syncDrawBar();
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
  $('banner').style.display = 'none';
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
// ---------- 알림: 배너(고정 안내) / 토스트(상단, 잠깐) / 모달(중앙, 자동 정지) ----------
let bannerTimer = 0;
function banner(text, ms, tone) {
  if (ms) { toast(text, tone || 'info', Math.max(ms, 2500)); return; }   // 짧은 안내는 토스트로
  const b = $('banner'); b.textContent = text; b.style.display = 'block'; clearTimeout(bannerTimer);
}
function toast(text, tone = 'info', ms = 5500, small = false) {
  const box = $('toasts'), el = document.createElement('div');
  el.className = `toast ${tone}${small ? ' small' : ''}`; el.textContent = text;
  const close = () => el.remove();
  el.addEventListener('click', close);
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(close, ms);
}

const modalQueue = [];
let modalOpen = false, modalCur = null, resumeSpeed = 0;
// opts: { title, body(html), tone, buttons: [{ label, primary, danger, onClick }] }
function showModal(opts) {
  modalQueue.push({ tone: 'info', buttons: [{ label: '확인', primary: true }], ...opts });
  if (!modalOpen) nextModal();
}
function nextModal() {
  const m = modalQueue.shift();
  if (!m) {
    modalOpen = false; modalCur = null; $('modal').classList.add('hidden');
    if (resumeSpeed && phase === 'play') { speed = resumeSpeed; panelDirty = true; syncTop(); }
    resumeSpeed = 0;
    return;
  }
  if (!modalOpen) { modalOpen = true; if (speed) { resumeSpeed = speed; speed = 0; syncTop(); } }   // 열려 있는 동안 정지
  modalCur = m;
  const dlg = $('modal').querySelector('.dlg');
  dlg.className = `dlg ${m.tone}`;
  dlg.innerHTML = `<h2>${m.title}</h2><div class="body">${m.body}</div><div class="btns">${m.buttons.map((b, i) => `<button data-i="${i}" class="${b.primary ? 'primary' : ''}${b.danger ? ' danger' : ''}">${b.label}</button>`).join('')}</div>`;
  $('modal').classList.remove('hidden');
  dlg.querySelector('button.primary, button.danger, button')?.focus();
}
function answerModal(i) {
  const b = modalCur && modalCur.buttons[i];
  if (!b) return;
  if (b.onClick) b.onClick();
  if (G) { G.dirty = true; panelDirty = true; processEvents(); }
  nextModal();
}
$('modal').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) answerModal(+b.dataset.i); });

// 로그 이벤트를 화면 알림으로 바꾼다. 내게 중요한 일은 모달(자동 정지), 나머지는 토스트
let lastEventId = 0;
function processEvents() {
  if (!G) return;
  if (G.player < 0) { lastEventId = G.logSeq; return; }
  for (const e of G.log) if (e.id > lastEventId) { lastEventId = e.id; presentEvent(e); }
}
function presentEvent(e) {
  const me = G.player, inv = e.involved || [], N = i => G.countries[i].name;
  const meIn = inv.includes(me), friendIn = inv.some(i => i !== me && isFriend(i));
  const enemies = () => warsOf(G, me).map(i => esc(N(i))).join(', ') || '없음';
  switch (e.kind) {
    case 'war':
      if (e.owner === me) return toast(`⚔ ${e.text}`, 'war', 7000);
      if (inv[1] === me) return showModal({ tone: 'war', title: `⚠ ${esc(N(inv[0]))}의 선전포고`,
        body: `${esc(e.text)}<ul><li>현재 교전 중: <b>${enemies()}</b></li></ul><div class="sub">전선을 편성해 접경에 사단을 배치하고, 생산 라인을 점검하세요. 개전 20일 후부터 강화를 제안할 수 있습니다.</div>` });
      return toast(`⚔ ${e.text}`, meIn || friendIn ? 'war' : 'info', meIn || friendIn ? 7000 : 4500, !(meIn || friendIn));
    case 'join':
      if (inv[0] === me) return showModal({ tone: 'war', title: '🤝 동맹 참전',
        body: `${esc(e.text)}<div class="sub">동맹국의 전쟁에 자동으로 참전했습니다. 현재 교전 중: <b>${enemies()}</b></div>` });
      if (inv[1] === me) return showModal({ tone: 'war', title: '⚠ 새로운 적',
        body: `${esc(e.text)}<div class="sub">현재 교전 중: <b>${enemies()}</b></div>` });
      return toast(`🤝 ${e.text}`, friendIn ? 'war' : 'info', friendIn ? 6000 : 4000, !friendIn);
    case 'peace': return toast(`🕊 ${e.text}`, meIn ? 'good' : 'info', meIn ? 7000 : 4500, !meIn);
    case 'alliance': return toast(`🤝 ${e.text}`, meIn ? 'good' : 'info', meIn ? 6000 : 4500, !meIn);
    case 'leave': return toast(e.text, 'info', 4500, !meIn);
    case 'capital':
      if (inv[1] === me) return showModal({ tone: 'war', title: '🏛 수도 함락!',
        body: `${esc(e.text)}<div class="sub">수도가 <b>${esc(G.provs[G.countries[me].capital].name)}</b>(으)로 이전되었습니다. 수도를 잃으면 생산·사기에 큰 타격입니다. 수복하거나 강화를 모색하세요.</div>` });
      return toast(`🏛 ${e.text}`, inv[0] === me ? 'good' : 'info', inv[0] === me ? 6500 : 4500, inv[0] !== me);
    case 'fall': return inv[0] === me ? undefined : toast(`💀 ${e.text}`, 'warn', 6000);
    case 'built': return toast(`🏭 ${e.text}`, 'good', 4500, true);
    case 'front': return toast(e.text, 'info', 4500, true);
  }
}

// 선전포고 전 확인: 참전하는 동맹을 미리 보여준다
function confirmWar(other) {
  const me = G.player, B = G.countries[other], { ours, theirs } = warParticipants(G, me, other);
  const names = ids => ids.length ? ids.map(i => `<b>${esc(G.countries[i].name)}</b>`).join(', ') : '없음';
  const left = (G.truces[warKey(me, other)] || 0) - G.day;
  if (left > 0) return toast(`${B.name}와는 휴전 중입니다 (${left}일 남음). 휴전이 끝나야 선전포고할 수 있습니다.`, 'warn', 5000);
  showModal({
    tone: 'war', title: `⚔ ${esc(B.name)}에 선전포고`,
    body: `정말 <b>${esc(B.name)}</b>와 전쟁을 시작하시겠습니까?<ul><li>우리 편으로 참전하는 동맹: ${names(ours)}</li><li>상대 편으로 참전하는 동맹: ${names(theirs)}</li></ul><div class="sub">전쟁이 시작되면 20일 동안은 강화를 제안할 수 없고, 끝난 뒤에도 40일간 다시 선전포고할 수 없습니다.</div>`,
    buttons: [{ label: '선전포고', danger: true, onClick: () => { if (!declareWar(G, me, other)) toast('선전포고할 수 없습니다 (동맹국이거나 휴전 중)', 'warn'); } }, { label: '취소' }],
  });
}
function confirmLeave() {
  const me = G.countries[G.player], f = G.factions[me.faction];
  showModal({
    tone: 'warn', title: '동맹 탈퇴',
    body: `<b>${esc(f ? f.name : '동맹')}</b>을(를) 탈퇴하시겠습니까?<div class="sub">동맹국의 자동 참전 지원과 시야 공유를 잃고, 동맹 승리 조건도 달성할 수 없게 됩니다.</div>`,
    buttons: [{ label: '탈퇴', danger: true, onClick: () => leaveFaction(G, G.player) }, { label: '취소' }],
  });
}
const resultToast = r => toast(r.msg, r.ok ? 'good' : 'warn', r.ok ? 5500 : 4500);

// ---------- 전선 / 공격 화살표 그리기 ----------
function startLineDraw() {
  if (!warsOf(G, G.player).length) return toast('전쟁 중인 적이 없어 전선을 그릴 수 없습니다', 'warn');
  moveMode = false; winTab = null; panelDirty = true; drawMode = { kind: 'line', front: null, items: [], enemy: null, anchor: null }; syncDrawBar();
}
function startArrowDraw(frontId) {
  moveMode = false; winTab = null; panelDirty = true; drawMode = { kind: 'arrow', front: frontId, items: [], enemy: null, anchor: null }; syncDrawBar();
}
function drawCandidate(id) {
  const d = drawMode, P = G.provs;
  if (!d || id < 0) return false;
  if (d.kind === 'line') return !d.items.includes(id) && frontCandidate(G, G.player, id, d.enemy) >= 0;
  const f = G.fronts.find(x => x.id === d.front);
  if (!f) return false;
  const last = d.items.length ? d.items[d.items.length - 1] : d.anchor;
  if (last === null) return f.border.includes(id) || (P[id].land && P[id].controller === f.enemy && P[id].adj.some(n => f.border.includes(n)));
  return P[id].land && P[id].controller === f.enemy && !d.items.includes(id) && P[id].adj.includes(last);
}
function drawAdd(id) {
  if (!drawCandidate(id)) return;
  const d = drawMode;
  if (d.kind === 'line') { if (d.enemy === null) d.enemy = frontCandidate(G, G.player, id); d.items.push(id); }
  else {
    const f = G.fronts.find(x => x.id === d.front);
    if (d.anchor === null && !d.items.length && f.border.includes(id)) d.anchor = id; else d.items.push(id);
  }
  syncDrawBar();
}
function drawUndo() {
  const d = drawMode; if (!d) return;
  if (d.items.length) d.items.pop(); else if (d.anchor !== null) d.anchor = null;
  if (d.kind === 'line' && !d.items.length) d.enemy = null;
  syncDrawBar();
}
function drawCancel() { drawMode = null; syncDrawBar(); panelDirty = true; }
function drawFinish() {
  const d = drawMode; if (!d) return;
  if (!d.items.length) return toast(d.kind === 'line' ? '접경 지역을 먼저 선택하세요 (드래그 또는 탭)' : '적 지역을 따라 화살표를 그리세요', 'warn');
  const items = [...d.items], me = G.player;
  drawMode = null; syncDrawBar(); panelDirty = true;
  if (d.kind === 'arrow') {
    const f = G.fronts.find(x => x.id === d.front);
    return f ? resultToast(addArrow(G, f, items)) : undefined;
  }
  const make = mode => () => {
    const f = createFront(G, me, items[0], mode, items);
    if (!f) return toast('전선을 만들 수 없습니다', 'warn');
    selFront = f.id; assignToFront(G, f, selArmies);
    toast(`${f.name} 편성 (${mode === 'attack' ? '공격' : '방어'}) — 사단을 배치하세요${mode === 'attack' ? '. 공격 화살표로 진격 목표를 정할 수 있습니다' : ''}`, 'good', 6500);
  };
  showModal({
    tone: 'warn', title: '전선 편성',
    body: `선택한 접경 <b>${items.length}개 지역</b>에 전선을 만듭니다. 모드를 고르세요.<ul><li>⚔ <b>공격</b>: 접경에 집결해 적 지역으로 진격 (이후 화살표로 목표 지정)</li><li>🛡 <b>방어</b>: 접경에 병력을 분산하고 침투한 적을 막음</li></ul>`,
    buttons: [{ label: '⚔ 공격 전선', primary: true, onClick: make('attack') }, { label: '🛡 방어 전선', onClick: make('hold') }, { label: '취소' }],
  });
}
function syncDrawBar() {
  const bar = $('drawbar'), d = drawMode;
  document.body.classList.toggle('drawing', !!d);
  bar.classList.toggle('hidden', !d);
  if (!d) return;
  $('drawtext').innerHTML = d.kind === 'line'
    ? `<b>🖊 전선 그리기</b> — 적과 맞닿은 <b>내 접경 지역</b>을 드래그(또는 탭)해서 고르세요. <span class="dim">선택 ${d.items.length}개</span>`
    : `<b>➜ 공격 화살표</b> — 전선 위에서 시작해 <b>적 지역을 따라</b> 드래그(또는 탭)하세요. <span class="dim">경로 ${d.items.length}개</span>`;
}
document.querySelector('#drawbar .btns').addEventListener('click', e => {
  const b = e.target.closest('[data-draw]'); if (!b) return;
  ({ undo: drawUndo, finish: drawFinish, cancel: drawCancel })[b.dataset.draw]();
});

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
  if (!armies.length) { toast('먼저 사단이 있는 지역을 선택하세요', 'warn'); return; }
  let moved = 0;
  for (const a of armies) {
    const p = findPath(G, a.prov, target, a.owner);
    if (p) { a.path = p; a.prog = 0; moved++; a.front = null; }
  }
  if (!moved) toast('이동할 수 없는 지역입니다 (전쟁 중이 아닌 국가의 영토)', 'warn');
  G.dirty = true;
}
function handleTap(sx, sy) {
  const id = provAt(sx, sy);
  if (id < 0) return;
  if (phase === 'pick') { if (G.provs[id].owner >= 0) pickCountry(G.provs[id].owner); return; }
  if (phase !== 'play') return;
  if (moveMode) { moveMode = false; orderMove(id); panelDirty = true; return; }
  selProv = id; selectOwnArmies(); panelDirty = true;
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
  const mouse = e.pointerType === 'mouse';
  if (mouse && e.button === 1) e.preventDefault();
  if (mouse && e.button !== 0) {   // 오른쪽/가운데 버튼: 드래그하면 지도 이동, 그냥 놓으면 (오른쪽) 이동 명령
    if (e.button !== 2 && e.button !== 1) return;
    canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture = { pan: true, rightBtn: e.button === 2, x: e.clientX, y: e.clientY, moved: e.button === 1 };
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1 && drawMode) {   // 그리기 중: 누르고 드래그하면 지역을 칠한다 (두 손가락은 핀치 확대)
    gesture = { paint: true, moved: true, x: e.clientX, y: e.clientY };
    drawAdd(provAt(e.clientX, e.clientY));
  } else if (ptrs.size === 1) {
    // 드래그 동작: 선택 모드면 박스로 부대 선택, 이동 모드면 지도 이동 (터치 기기는 기본이 이동)
    gesture = { x: e.clientX, y: e.clientY, moved: false, long: false, touch: !mouse, box: dragMode === 'select' && phase === 'play' };
    if (gesture.touch) { // 길게 누르면 이동 명령
      const g = gesture;
      g.timer = setTimeout(() => { if (gesture !== g || g.moved || phase !== 'play') return; g.long = true; const id = provAt(g.x, g.y); if (id >= 0) orderMove(id); }, 450);
    }
  } else if (ptrs.size === 2) {
    if (gesture) clearTimeout(gesture.timer);
    selBox = null;
    gesture = { pinch: pdist(), moved: true };
  }
});
canvas.addEventListener('pointermove', e => {
  if (!G) return;
  if (ptrs.has(e.pointerId)) {
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture && gesture.paint) {
      if (ptrs.size === 1 && drawMode) drawAdd(provAt(e.clientX, e.clientY));
    } else if (ptrs.size === 2 && gesture && gesture.pinch) {
      const d = pdist(), [a, b] = [...ptrs.values()];
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / gesture.pinch);
      gesture.pinch = d;
    } else if (gesture && gesture.x !== undefined) {
      if (!gesture.moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 6) { gesture.moved = true; clearTimeout(gesture.timer); }
      if (gesture.moved) {
        if (gesture.box) selBox = { x0: gesture.x, y0: gesture.y, x1: e.clientX, y1: e.clientY };
        else { cam.x -= (e.clientX - prev.x) / cam.z; cam.y -= (e.clientY - prev.y) / cam.z; canvas.style.cursor = 'grabbing'; }
      }
    }
  }
  if (e.pointerType === 'mouse') {
    const h = provAt(e.clientX, e.clientY);
    if (h !== hover) hover = h;
  }
});
// 박스 안(부대 마커 위치 기준)에 있는 내 부대를 선택한다. Shift를 누르면 기존 선택에 추가
function finishBox(box, additive) {
  const a = toWorld(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1)), b = toWorld(Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
  const ids = G.armies.filter(ar => {
    const p = G.provs[ar.prov];
    return ar.owner === G.player && p.x >= a.x - 8 && p.x <= b.x + 8 && p.y + 4 >= a.y - 8 && p.y + 4 <= b.y + 8;
  }).map(ar => ar.id);
  if (!additive) selArmies = new Set();
  ids.forEach(id => selArmies.add(id));
  panelDirty = true;
  if (!ids.length && !additive) toast('박스 안에 내 부대가 없습니다', 'warn', 2500, true);
}
function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  canvas.style.cursor = '';
  const g = gesture;
  if (g && g.pan && ptrs.size === 0) {
    if (e.type === 'pointerup' && g.rightBtn && !g.moved) {   // 오른쪽 클릭: 이동 명령 (그리기 중이면 취소)
      if (drawMode) drawCancel();
      else if (phase === 'play') { const id = provAt(e.clientX, e.clientY); if (id >= 0) orderMove(id); }
    }
  } else if (g && g.x !== undefined && ptrs.size === 0) {
    clearTimeout(g.timer);
    if (e.type === 'pointerup') {
      if (g.moved && g.box && selBox) finishBox(selBox, e.shiftKey);
      else if (!g.moved && !g.long) handleTap(e.clientX, e.clientY);
    }
  }
  selBox = null;
  if (ptrs.size === 0) gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
window.addEventListener('keydown', e => {
  if (modalOpen) {   // 모달이 열려 있으면 Enter=기본 버튼, Esc=마지막(취소) 버튼
    if (e.code === 'Escape') { e.preventDefault(); answerModal(modalCur.buttons.length - 1); }
    else if (e.code === 'Enter' && !e.target.closest?.('button')) { e.preventDefault(); answerModal(Math.max(0, modalCur.buttons.findIndex(b => b.primary))); }
    return;
  }
  if (phase !== 'play' || e.target.tagName === 'INPUT') return;
  if (drawMode) { if (e.code === 'Escape') drawCancel(); else if (e.code === 'Enter') drawFinish(); else if (e.code === 'Backspace') drawUndo(); return; }
  if (e.code === 'Space') { e.preventDefault(); setSpeed(speed ? 0 : 1); }
  else if (['Digit1', 'Digit2', 'Digit3'].includes(e.code)) setSpeed(+e.code.slice(-1));
  else if (e.code === 'KeyP') toggleWin('eco');
  else if (e.code === 'KeyM') toggleWin('mil');
  else if (e.code === 'KeyD') toggleWin('dip');
  else if (e.code === 'Escape') { if (selArmies.size) selArmies = new Set(); else winTab = null; panelDirty = true; syncTop(); }
  else if (e.code.startsWith('Arrow')) {   // 방향키로 지도 이동
    e.preventDefault();
    const step = 60 / cam.z;
    if (e.code === 'ArrowLeft') cam.x -= step; else if (e.code === 'ArrowRight') cam.x += step; else if (e.code === 'ArrowUp') cam.y -= step; else cam.y += step;
  }
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

// ---------- 액션 처리 (오른쪽 패널 / 왼쪽 탭 창 / 하단 선택 바 공통) ----------
const frontById = id => G.fronts.find(x => x.id === +id);
function onAction(e) {
  const b = e.target.closest('[data-act]'); if (!b || phase !== 'play') return;
  const me = G.countries[G.player], p = selProv >= 0 ? G.provs[selProv] : null;
  const other = b.dataset.c !== undefined ? +b.dataset.c : (p ? p.owner : -1);   // 외교 대상: 외교 탭은 data-c, 지역 패널은 선택한 지역의 소유국
  switch (b.dataset.act) {
    case 'tab': winTab = b.dataset.tab; break;
    case 'wclose': winTab = null; break;
    case 'train': addTrainLine(G, G.player, b.dataset.type); break;
    case 'rmline': removeLine(G, G.player, +b.dataset.i); break;
    case 'alloc': setAlloc(G, G.player, b.dataset.eq, +b.dataset.d); break;
    case 'build': resultToast(queueBuild(G, G.player, selProv, b.dataset.kind)); break;
    case 'cancelbuild': cancelBuild(G, G.player, +b.dataset.i); break;
    case 'war': confirmWar(other); break;
    case 'peace': resultToast(proposePeace(G, G.player, other, false)); break;
    case 'demand': resultToast(proposePeace(G, G.player, other, true)); break;
    case 'ally': resultToast(proposeAlliance(G, G.player, other)); break;
    case 'leave': confirmLeave(); break;
    case 'fcreate': { const f = createFront(G, G.player, selProv, b.dataset.mode); if (f) { selFront = f.id; assignToFront(G, f, selArmies); } else toast('이 지역에는 전선을 만들 수 없습니다 (적 지배지와 맞닿은 내 지역)', 'warn'); break; }
    case 'fdraw': startLineDraw(); break;
    case 'farrow': startArrowDraw(+b.dataset.id); break;
    case 'farrowclear': { const f = frontById(b.dataset.id); if (f) f.arrows = []; break; }
    case 'fselect': selFront = +b.dataset.id; break;
    case 'fmode': { const f = frontById(b.dataset.id); if (f) f.mode = f.mode === 'attack' ? 'hold' : 'attack'; break; }
    case 'fassign': { const f = frontById(b.dataset.id); if (f) assignToFront(G, f, selArmies); break; }
    case 'fall': { const f = frontById(b.dataset.id); if (f) assignToFront(G, f, new Set(G.armies.filter(a => a.owner === G.player && !a.front).map(a => a.id))); break; }
    case 'fauto': { const f = frontById(b.dataset.id); if (f) { const on = !f.auto; G.fronts.forEach(x => { if (x.owner === f.owner) x.auto = false; }); f.auto = on; } break; }
    case 'fdel': { const f = frontById(b.dataset.id); if (f) { dissolveFront(G, f); if (selFront === f.id) selFront = null; } break; }
    case 'move': moveMode = !moveMode; if (moveMode) banner('이동할 지역을 탭하세요', 2000); break;
    case 'split': {
      const a = G.armies.find(x => selArmies.has(x.id) && x.comp[b.dataset.type] >= 1 && x.hp >= 2);
      if (a) selArmies.add(splitArmy(G, a, b.dataset.type).id);
      break;
    }
    // ----- 부대 선택 / 전선 배치 -----
    case 'selall': selArmies = new Set(G.armies.filter(a => a.owner === G.player).map(a => a.id)); break;
    case 'selfree': selArmies = new Set(G.armies.filter(a => a.owner === G.player && !a.front).map(a => a.id)); break;
    case 'selfront': selArmies = new Set(G.armies.filter(a => a.owner === G.player && a.front === +b.dataset.id).map(a => a.id)); break;
    case 'selclear': selArmies = new Set(); break;
    case 'selassign': {   // 선택한 부대만 이 전선에 배치
      const f = frontById(b.dataset.id);
      if (f) { const n = assignToFront(G, f, selArmies); toast(`${n}개 부대를 ${f.name}에 배치했습니다`, 'good', 3500); selArmies = new Set(); }
      break;
    }
    case 'selunassign': {
      let n = 0; for (const a of G.armies) if (selArmies.has(a.id) && a.front) { a.front = null; n++; }
      toast(`${n}개 부대를 전선에서 뺐습니다`, 'info', 3000); break;
    }
    case 'seldraw': startLineDraw(); break;   // 선택한 부대를 유지한 채 새 전선을 그린다 (완료 시 자동 배치)
  }
  G.dirty = true; panelDirty = true; processEvents();
}
for (const id of ['panel', 'win', 'selbar']) $(id).addEventListener('click', onAction);
function onToggleArmy(e) {
  const id = +e.target.dataset.army; if (!id) return;
  e.target.checked ? selArmies.add(id) : selArmies.delete(id);
  panelDirty = true;
}
for (const id of ['panel', 'win']) $(id).addEventListener('change', onToggleArmy);
// 메뉴 버튼 / 드래그 모드
document.querySelector('.menus').addEventListener('click', e => { const b = e.target.closest('[data-win]'); if (b) toggleWin(b.dataset.win); });
$('btnDrag').addEventListener('click', () => { dragMode = dragMode === 'select' ? 'pan' : 'select'; syncTop(); panelDirty = true; toast(dragMode === 'select' ? '드래그 = 부대 박스 선택 (지도 이동: 우클릭 드래그)' : '드래그 = 지도 이동', 'info', 3000); });
function toggleWin(tab) { winTab = winTab === tab ? null : tab; panelDirty = true; syncTop(); }

// ---------- 패널/상단바 ----------
const sw = c => `<span class="swatch" style="background:rgb(${c.color})"></span>`;
const esc = s => String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
const compText = a => Object.entries(a.comp).filter(([, v]) => v >= 0.05).map(([t, v]) => `${UNITS[t].name} ${v.toFixed(1)}`).join(' · ');
const factionTag = c => c.faction >= 0 ? `<span class="tag">${esc(G.factions[c.faction].name)}</span>` : '';

function syncTop() {
  document.querySelectorAll('.menus button').forEach(b => b.classList.toggle('on', b.dataset.win === winTab));
  $('btnDrag').innerHTML = dragMode === 'select' ? '<span class="ic">▭</span><span class="tx"> 선택</span>' : '<span class="ic">✋</span><span class="tx"> 이동</span>';
  $('btnDrag').classList.toggle('on', dragMode === 'select');
  document.querySelectorAll('.speeds button').forEach(b => b.classList.toggle('on', +b.dataset.speed === speed));
  if (!G) return;
  $('date').textContent = dateStr(G.day);
  if (G.player >= 0) {
    const me = G.countries[G.player];
    const divs = G.armies.filter(a => a.owner === me.id).reduce((s, a) => s + a.hp, 0);
    $('pp').innerHTML = `${sw(me)}${esc(me.name)} · PP <b>${me.pp.toFixed(0)}</b> · 보병장비 <b>${me.equip.small.toFixed(0)}</b> · 전차 <b>${me.equip.tank.toFixed(0)}</b> · 인력 <b>${me.manpower.toFixed(0)}k</b> · 사단 ${divs.toFixed(1)}`;
    const w = warsOf(G, me.id);
    $('wars').textContent = w.length ? '⚔ ' + w.map(i => G.countries[i].name).join(', ') : '';
  }
}

function setHTML(el, html) { const top = el.scrollTop; el.innerHTML = html; el.scrollTop = top; }
const compSum = arr => { const t = {}; for (const a of arr) for (const k in a.comp) t[k] = (t[k] || 0) + a.comp[k]; return Object.entries(t).filter(([, v]) => v >= 0.05).map(([k, v]) => `${UNITS[k].name} ${v.toFixed(1)}`).join(' · '); };
const frontName = a => { const f = a.front && G.fronts.find(x => x.id === a.front); return f ? f.name : null; };

function renderPanel() {
  panelDirty = false;
  if (phase === 'pick') { $('panel').innerHTML = '<p class="dim">지도에서 플레이할 국가를 클릭하세요.</p>'; renderWin(null); renderSelBar(null); return; }
  if (phase !== 'play') { $('panel').innerHTML = '<p class="dim">게임이 끝났습니다.</p>'; renderWin(null); renderSelBar(null); return; }
  const me = G.countries[G.player];
  setHTML($('panel'), htmlSelection(me));
  renderWin(me);
  renderSelBar(me);
}

const helpHtml = () => `<div class="help"><b>조작</b><br>${dragMode === 'select'
  ? '좌클릭: 지역 선택 · <b>좌드래그: 부대 박스 선택</b> (Shift: 추가)<br>우클릭: 선택한 부대 이동 · 우드래그·휠: 지도 이동·확대'
  : '탭: 지역 선택 · 드래그: 지도 이동 · 핀치: 확대<br>길게 누르기: 이동 명령 · 상단 ▭ 버튼: 박스 선택 모드'}<br>메뉴: <kbd>P</kbd> 생산 · <kbd>M</kbd> 군사 · <kbd>D</kbd> 외교</div>`;

// ----- 오른쪽 패널: 선택한 지역 -----
function htmlSelection(me) {
  const p = selProv >= 0 ? G.provs[selProv] : null;
  if (!p) return `<h2>지역</h2><p class="dim">지도에서 지역을 클릭하세요.</p>` + helpHtml();
  const owner = p.owner >= 0 ? G.countries[p.owner] : null, ctl = p.controller >= 0 ? G.countries[p.controller] : null, T = TERRAIN[p.terrain];
  let h = `<h2>${esc(p.name)}${owner && owner.capital === p.id ? ' ★' : ''}</h2>`;
  h += `<div class="dim">소유: ${owner ? sw(owner) + esc(owner.name) : '중립'}${ctl && ctl !== owner ? ` · <span class="warn">${esc(ctl.name)} 점령</span>` : ''}</div>`;
  h += `<div class="dim">지형: ${T.name} (이동 ×${T.move}, 방어 ×${T.def})</div>`;
  if (p.land && p.owner === me.id) {
    const free = freeSlots(me, p), mine = p.controller === me.id;
    h += `<div class="dim">공장: 민수 ${p.civ} · 군수 ${p.mil} / 슬롯 ${p.slots}${mine ? '' : ' <span class="warn">(점령당해 생산 중단)</span>'}</div>`;
    if (mine) h += `<div class="row"><button data-act="build" data-kind="civ" ${free > 0 ? '' : 'disabled'}>+민수 공장</button><button data-act="build" data-kind="mil" ${free > 0 ? '' : 'disabled'}>+군수 공장</button></div>`;
  }
  const mine = G.armies.filter(a => a.prov === p.id && a.owner === me.id);
  if (mine.length) {
    h += `<h3>이 지역의 내 사단</h3>`;
    for (const a of mine) {
      const sup = isSupplied(G, a), fn = frontName(a);
      h += `<label class="army"><input type="checkbox" data-army="${a.id}" ${selArmies.has(a.id) ? 'checked' : ''}> ${compText(a)}<br><span class="dim">조직도 ${(a.org * 100).toFixed(0)}% · ${sup ? '<span class="ok">보급 양호</span>' : '<span class="warn">보급 끊김</span>'}${a.path.length ? ' · 이동 중' : ''}${fn ? ` · <span class="tag">${esc(fn)}</span>` : ''}</span></label>`;
    }
    const types = Object.keys(UNITS).filter(t => mine.some(a => a.comp[t] >= 1 && a.hp >= 2));
    h += `<div class="row">${types.map(t => `<button data-act="split" data-type="${t}">${UNITS[t].name} 1 분리</button>`).join('')}<button data-act="move" class="${moveMode ? 'on-mode' : ''}">${moveMode ? '목적지를 탭…' : '이동 모드'}</button></div>`;
  }
  if (canSee(p.id)) {
    const foes = {};
    G.armies.filter(a => a.prov === p.id && a.owner !== me.id).forEach(a => { foes[a.owner] = (foes[a.owner] || 0) + a.hp; });
    for (const [o, hp] of Object.entries(foes)) h += `<div>${sw(G.countries[o])}${esc(G.countries[o].name)} ${hp.toFixed(1)}개 사단</div>`;
  } else h += `<div class="dim">시야 밖 — 부대 정보를 알 수 없다</div>`;

  if (p.controller === me.id && p.adj.some(n => G.provs[n].land && G.provs[n].controller >= 0 && atWar(G, me.id, G.provs[n].controller))) {
    h += `<h3>전선</h3><div class="row"><button data-act="fcreate" data-mode="attack">⚔ 자동 공격 전선</button><button data-act="fcreate" data-mode="hold">🛡 자동 방어 전선</button></div><div class="dim">이 지역에서 이어지는 접경 전체를 자동으로 잡습니다. 직접 긋기·부대 고르기는 <kbd>M</kbd> 군사 메뉴에서.</div>`;
  }
  if (owner && owner.id !== me.id) h += `<h3>외교 — ${esc(owner.name)}</h3><div class="row">${diploButtons(me, owner)}</div>`;
  return h + helpHtml();
}

// 외교 버튼 묶음 (지역 패널·외교 탭 공통). data-c로 대상 국가를 지정
function diploButtons(me, c) {
  const war = atWar(G, me.id, c.id), allied = sameFaction(G, me.id, c.id), d = `data-c="${c.id}"`;
  if (war) {
    const since = G.day - G.wars[warKey(me.id, c.id)], sc = warScore(G, me.id, c.id);
    return `<button data-act="peace" ${d}>백색 강화</button><button data-act="demand" ${d} ${sc ? '' : 'disabled'}>점령지 요구 (${sc})</button><span class="dim">전쟁 ${since}일째</span>`;
  }
  if (allied) return `<span class="ok">동맹국</span>`;
  const truce = (G.truces[warKey(me.id, c.id)] || 0) - G.day;
  let h = '';
  if (neighborsOf(G, me.id).includes(c.id)) h += `<button data-act="war" ${d}>선전포고</button>`; else h += `<span class="dim">국경 없음</span>`;
  h += `<button data-act="ally" ${d}>동맹 제안</button>`;
  if (truce > 0) h += `<span class="dim">휴전 ${truce}일</span>`;
  return h;
}

// ----- 왼쪽 탭 창 -----
const WIN_TABS = [['eco', '🏭 생산', 'P'], ['mil', '⚔ 군사', 'M'], ['dip', '🤝 외교', 'D']];
function renderWin(me) {
  const win = $('win');
  if (!winTab || !me) { win.classList.add('hidden'); return; }
  win.classList.remove('hidden');
  const prev = win.querySelector('.wbody'), top = prev ? prev.scrollTop : 0;
  const tabs = WIN_TABS.map(([k, label, key]) => `<button data-act="tab" data-tab="${k}" class="${winTab === k ? 'on' : ''}">${label}<kbd>${key}</kbd></button>`).join('');
  const body = winTab === 'eco' ? htmlEconomy(me) : winTab === 'mil' ? htmlMilitary(me) : htmlDiplomacy(me);
  win.innerHTML = `<div class="wtabs">${tabs}<button class="x" data-act="wclose" title="닫기 (Esc)">×</button></div><div class="wbody">${body}</div>`;
  win.querySelector('.wbody').scrollTop = top;
}

function htmlEconomy(me) {
  const divs = G.armies.filter(a => a.owner === me.id).reduce((s, a) => s + a.hp, 0);
  let h = `<div class="stat">PP <b>${me.pp.toFixed(0)}</b> (+${me.income.toFixed(1)}/일) · 인력 <b>${me.manpower.toFixed(0)}k</b> · 사단 ${divs.toFixed(1)}</div>`;
  const fac = me.fac, allocated = me.alloc.small + me.alloc.tank;
  h += `<h3>공장</h3><div class="dim">민수 <b>${fac.civ}</b> (PP +${me.income.toFixed(1)}/일) · 군수 <b>${fac.mil}</b> (할당 ${allocated}/${fac.mil})</div>`;
  for (const [k, e] of Object.entries(EQUIP)) {
    h += `<div class="alloc"><span>${e.name} <b>${me.alloc[k]}</b>개 공장 → +${me.eqRate[k].toFixed(1)}/일 · 비축 <b>${me.equip[k].toFixed(0)}</b></span>`
      + `<span><button data-act="alloc" data-eq="${k}" data-d="-1" ${me.alloc[k] > 0 ? '' : 'disabled'}>−</button><button data-act="alloc" data-eq="${k}" data-d="1" ${allocated < fac.mil ? '' : 'disabled'}>+</button></span></div>`;
  }
  if (me.construction.length) {
    h += `<div class="dim" style="margin-top:6px">건설 중</div>`;
    me.construction.forEach((j, i) => {
      h += `<div class="dim">${j.kind === 'civ' ? '민수' : '군수'} 공장 · ${esc(G.provs[j.prov].name)} · ${i < MAX_BUILD ? '' : '대기 · '}${(j.progress / FACTORY_COST * 100).toFixed(0)}% <a href="#" data-act="cancelbuild" data-i="${i}" onclick="return false">[취소]</a></div><div class="bar"><i style="width:${j.progress / FACTORY_COST * 100}%"></i></div>`;
    });
  }
  h += `<div class="dim">공장은 지도에서 내 지역을 선택해 건설합니다 (${FACTORY_COST} PP).</div>`;
  h += `<h3>사단 훈련 (반복)</h3>`;
  const stallText = { small: '보병장비 부족', tank: '전차 부족', mp: '인력 부족', slot: '대기' };
  me.queue.forEach((q, i) => {
    const u2 = UNITS[q.type], days = TRAIN_DAYS[q.type];
    const state = q.started ? `훈련 ${q.progress}/${days}일` : `<span class="warn">${stallText[q.stall] || '대기'}</span>`;
    h += `<div class="dim">${u2.name} · ${state} <a href="#" data-act="rmline" data-i="${i}" onclick="return false">[삭제]</a></div><div class="bar"><i style="width:${q.started ? q.progress / days * 100 : 0}%"></i></div>`;
  });
  const costText = u2 => Object.entries(u2.eq).map(([k, v]) => `${EQUIP[k].name} ${v}`).join(' · ') + ` · 인력 ${u2.mp}k`;
  h += `<div class="row">` + Object.entries(UNITS).map(([t, u2]) => `<button data-act="train" data-type="${t}" ${me.queue.length >= MAX_LINES ? 'disabled' : ''} title="${costText(u2)} · ${TRAIN_DAYS[t]}일">+${u2.name}</button>`).join('') + `</div>`;
  h += `<div class="dim">${Object.entries(UNITS).map(([t, u2]) => `${u2.name}: ${costText(u2)}`).join('<br>')}</div>`;
  if (!me.queue.length) h += `<div class="warn">훈련 라인이 없으면 사단이 편성되지 않습니다.</div>`;
  return h;
}

function htmlMilitary(me) {
  const myFronts = G.fronts.filter(f => f.owner === me.id), atWarNow = warsOf(G, me.id).length > 0;
  let h = `<h3 style="margin-top:2px">전선</h3>`;
  if (atWarNow) h += `<div class="row"><button data-act="fdraw" class="${drawMode && drawMode.kind === 'line' ? 'on-mode' : ''}">🖊 전선 그리기</button></div><div class="dim">접경 지역을 드래그해서 전선을 긋습니다. 공격 전선은 <b>화살표</b>로 진격 목표를 정할 수 있습니다.</div>`;
  else h += `<div class="dim">전쟁 중인 적이 없습니다. 선전포고하면 전선을 만들 수 있습니다.</div>`;
  for (const f of myFronts) {
    const fa = frontArmies(G, f), hp = fa.reduce((s2, a) => s2 + a.hp, 0), atk = f.mode === 'attack', arrows = f.arrows || [];
    h += `<div class="front${f.id === selFront ? ' sel' : ''}"><a href="#" data-act="fselect" data-id="${f.id}" onclick="return false"><b>${atk ? '⚔' : '🛡'} ${esc(f.name)}</b></a> <span class="tag">${atk ? '공격' : '방어'}</span><br>`;
    h += `<span class="dim">사단 ${hp.toFixed(1)} (${fa.length}부대) · 접경 ${f.border.length}지역 · ${f.line ? '직접 그린 라인' : '자동 라인'}${arrows.length ? ` · 화살표 ${arrows.length}` : ''}</span><div class="row">`;
    h += `<button data-act="fassign" data-id="${f.id}" ${selArmies.size ? '' : 'disabled'} title="선택한 부대만 이 전선에 배치">선택 부대 배치 (${selArmies.size})</button>`;
    h += `<button data-act="fall" data-id="${f.id}" title="어느 전선에도 없는 부대를 전부 이 전선에 배치">미배치 전부</button>`;
    h += `<button data-act="selfront" data-id="${f.id}" ${fa.length ? '' : 'disabled'}>이 전선 부대 선택</button>`;
    if (atk) h += `<button data-act="farrow" data-id="${f.id}" class="${drawMode && drawMode.front === f.id ? 'on-mode' : ''}" ${arrows.length >= MAX_ARROWS ? 'disabled' : ''}>➜ 공격 화살표</button>`;
    if (arrows.length) h += `<button data-act="farrowclear" data-id="${f.id}">화살표 지우기</button>`;
    h += `<button data-act="fmode" data-id="${f.id}">${atk ? '방어로 전환' : '공격으로 전환'}</button>`;
    h += `<button data-act="fauto" data-id="${f.id}" class="${f.auto ? 'on-mode' : ''}">신규 자동 배치${f.auto ? ' ON' : ''}</button>`;
    h += `<button data-act="fdel" data-id="${f.id}">해산</button></div></div>`;
  }

  // 부대 목록: 체크해서 원하는 부대만 골라 전선에 넣는다
  const armies = G.armies.filter(a => a.owner === me.id);
  h += `<h3>부대 ${armies.length}개 · 선택 ${selArmies.size}</h3>`;
  h += `<div class="row"><button data-act="selall">전체</button><button data-act="selfree">미배치</button><button data-act="selclear">해제</button></div><div class="dim">지도에서 <b>드래그</b>로 박스 선택도 됩니다. 고른 뒤 전선 카드의 「선택 부대 배치」 또는 화면 아래 선택 바를 쓰세요.</div>`;
  const groups = [{ name: '미배치', id: 0, list: armies.filter(a => !a.front) }, ...myFronts.map(f => ({ name: f.name, id: f.id, list: armies.filter(a => a.front === f.id) }))];
  for (const g of groups) {
    if (!g.list.length) continue;
    h += `<div class="dim gtitle">${esc(g.name)} (${g.list.length}) ${g.id ? `<a href="#" data-act="selfront" data-id="${g.id}" onclick="return false">[그룹 선택]</a>` : `<a href="#" data-act="selfree" onclick="return false">[그룹 선택]</a>`}</div>`;
    for (const a of g.list.slice(0, 60)) h += `<label class="army sm"><input type="checkbox" data-army="${a.id}" ${selArmies.has(a.id) ? 'checked' : ''}> ${compText(a)} <span class="dim">· ${esc(G.provs[a.prov].name)}${a.path.length ? ' → 이동 중' : ''}</span></label>`;
  }
  return h;
}

function htmlDiplomacy(me) {
  const w = warsOf(G, me.id);
  let h = `<div class="stat">영토 ${ownedCount(G, me.id)} / ${G.landCount} · 승리: 60% 점령 또는 동맹 통일</div>`;
  if (w.length) h += `<div class="warn">⚔ 교전 중: ${w.map(i => esc(G.countries[i].name)).join(', ')}</div>`;
  if (me.faction >= 0) h += `<div class="row">${factionTag(me)}<button data-act="leave">동맹 탈퇴</button></div>`;
  h += `<h3>국가</h3>`;
  for (const c of G.countries) {
    if (c.id === me.id) continue;
    const foe = atWar(G, me.id, c.id);
    h += `<div class="crow${foe ? ' foe' : ''}"><div>${sw(c)}<b>${esc(c.name)}</b>${foe ? ' <span class="warn">⚔ 적</span>' : ''}${factionTag(c)}${c.alive ? ` <span class="dim">${ownedCount(G, c.id)}지역${isFriend(c.id) || !G.vis ? ' · 전력 ' + strength(G, c.id).toFixed(1) : ''}</span>` : ' ✝'}</div>`;
    if (c.alive) h += `<div class="row">${diploButtons(me, c)}</div>`;
    h += `</div>`;
  }
  return h;
}

// ----- 하단 선택 바: 고른 부대를 원하는 전선에 넣는다 -----
function renderSelBar(me) {
  const bar = $('selbar');
  if (!me || !selArmies.size || drawMode) { bar.classList.add('hidden'); return; }
  const sel = G.armies.filter(a => selArmies.has(a.id)), hp = sel.reduce((s, a) => s + a.hp, 0);
  if (!sel.length) { bar.classList.add('hidden'); return; }
  const fronts = G.fronts.filter(f => f.owner === me.id);
  const inFront = sel.some(a => a.front);
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="sinfo"><b>선택 ${sel.length}부대</b> · 사단 ${hp.toFixed(1)}<br><span class="dim">${compSum(sel)}</span></div><div class="sbtns">`
    + fronts.map(f => `<button data-act="selassign" data-id="${f.id}" title="선택한 부대를 ${esc(f.name)}에 배치">${f.mode === 'attack' ? '⚔' : '🛡'} ${esc(f.name)}</button>`).join('')
    + (warsOf(G, me.id).length ? `<button data-act="seldraw" title="선택한 부대와 함께 새 전선 그리기">🖊 새 전선</button>` : '')
    + (inFront ? `<button data-act="selunassign">전선에서 빼기</button>` : '')
    + `<button data-act="selclear">해제</button></div>`;
}

function renderLog() {
  $('log').innerHTML = G.log.slice(-6).map(l => `<div style="border-left-color:rgb(${(G.countries[l.owner] || { color: [90, 90, 90] }).color})">${dateStr(l.day).slice(5)} ${esc(l.text)}</div>`).join('');
}

// ---------- 그리기 ----------
function flag(x, y, color, n, selected, badge) {
  const w = 22, h = 14;
  ctx.fillStyle = `rgb(${color})`; ctx.fillRect(x - w / 2, y - h / 2, w, h);
  ctx.lineWidth = selected ? 2 : 1; ctx.strokeStyle = selected ? '#fff' : '#101820'; ctx.strokeRect(x - w / 2, y - h / 2, w, h);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5; ctx.strokeText(n, x, y + 0.5); ctx.fillText(n, x, y + 0.5);
  if (badge) { // 전선 배치 표시: 공격=주황, 방어=파랑
    ctx.beginPath(); ctx.arc(x + w / 2, y - h / 2, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = badge === 'attack' ? '#ff6a40' : '#4a9bff'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
}

// 전선: 내 접경 지역과 적 지배지 사이의 경계를 굵게 표시
function drawFronts() {
  const z = cam.z;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const f of G.fronts) {
    if (f.owner !== G.player) continue;
    const sel = f.id === selFront, path = new Path2D();
    for (const pid of f.border) for (const e of G.provs[pid].edges) {
      if (e.nb < 0 || G.provs[e.nb].controller !== f.enemy) continue;
      path.moveTo(e.pts[0].x, e.pts[0].y);
      for (let i = 1; i < e.pts.length; i++) path.lineTo(e.pts[i].x, e.pts[i].y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = (sel ? 9 : 6.5) / z; ctx.stroke(path);
    ctx.strokeStyle = f.mode === 'attack' ? 'rgba(255,106,64,0.98)' : 'rgba(74,155,255,0.98)'; ctx.lineWidth = (sel ? 5.5 : 3.6) / z; ctx.stroke(path);
    if (sel) { ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2 / z; ctx.stroke(path); }
  }
}

// 공격 화살표: 전선 접경에서 시작해 적 지역을 따라 이어지는 굵은 화살표
function drawArrows() {
  const z = cam.z, P = G.provs;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const f of G.fronts) {
    if (f.owner !== G.player) continue;
    const sel = f.id === selFront;
    for (const ar of f.arrows || []) {
      const start = P[ar.path[0]].adj.find(n => f.border.includes(n));
      const pts = [...(start !== undefined ? [P[start]] : []), ...ar.path.map(id => P[id])];
      if (pts.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = (sel ? 8.5 : 7) / z; ctx.stroke();
      ctx.strokeStyle = sel ? '#ffb347' : '#ff7a3c'; ctx.lineWidth = (sel ? 5 : 4) / z; ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; arrowHead(pts[pts.length - 2], pts[pts.length - 1], 16 / z);
    }
  }
}

// 그리기 모드: 선택 가능한 지역을 깜빡이는 테두리로 보여주고, 지금까지 그린 선/화살표를 표시
function drawDraft() {
  const d = drawMode; if (!d) return;
  const z = cam.z, P = G.provs, pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const p of P) {
    if (!p.land || !drawCandidate(p.id)) continue;
    ctx.fillStyle = `rgba(255,170,60,${0.1 + 0.12 * pulse})`; ctx.fill(p.path);
    ctx.strokeStyle = `rgba(255,170,60,${0.55 + 0.4 * pulse})`; ctx.lineWidth = 2.2 / z; ctx.stroke(p.path);
  }
  for (const id of d.items) { ctx.fillStyle = 'rgba(255,140,40,0.45)'; ctx.fill(P[id].path); }
  const pts = [...(d.anchor !== null ? [P[d.anchor]] : []), ...d.items.map(id => P[id])];
  if (pts.length) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 7 / z; ctx.stroke();
    ctx.strokeStyle = '#ffc060'; ctx.lineWidth = 4 / z; ctx.stroke();
    if (d.kind === 'arrow' && pts.length >= 2) { ctx.fillStyle = '#ffc060'; arrowHead(pts[pts.length - 2], pts[pts.length - 1], 16 / z); }
    for (const q of pts) { ctx.beginPath(); ctx.arc(q.x, q.y, 3.5 / z, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
  }
}

// 내 지역의 공장 수 (확대했을 때만): 파랑=민수, 주황=군수
function drawFactories() {
  if (cam.z < 1.2 || G.player < 0) return;
  ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const box = (x, y, color, n) => {
    ctx.fillStyle = color; ctx.fillRect(x, y, 11, 8); ctx.strokeStyle = '#101820'; ctx.lineWidth = 0.8; ctx.strokeRect(x, y, 11, 8);
    ctx.fillStyle = '#fff'; ctx.fillText(n, x + 5.5, y + 4.4);
  };
  for (const p of G.provs) {
    if (!p.land || p.controller !== G.player || p.owner !== G.player || !(p.civ + p.mil)) continue;
    let y = p.y - 8;
    if (p.civ) { box(p.x - 28, y, '#3b8fe0', p.civ); y += 9; }
    if (p.mil) box(p.x - 28, y, '#e8862e', p.mil);
  }
}

// 이동 화살표 머리
function arrowHead(from, to, size) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(ang - 0.45), to.y - size * Math.sin(ang - 0.45));
  ctx.lineTo(to.x - size * Math.cos(ang + 0.45), to.y - size * Math.sin(ang + 0.45));
  ctx.closePath(); ctx.fill();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a1a2c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!G) return;
  if (G.dirty) {
    G.vis = phase === 'play' ? visibleSet(G, G.player) : null;
    updateMapStyle(G, G.vis);
    G.dirty = false;
  }
  ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);
  drawMap(ctx, G, cam.z, phase === 'play' || phase === 'pick' ? hover : -1, selProv);
  drawFronts();
  drawArrows();
  drawFactories();
  drawDraft();

  // 국가명
  if (cam.z < 2.5) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 22px sans-serif'; ctx.lineJoin = 'round';
    for (const c of G.countries) {
      if (!c.alive) continue;
      const own = G.provs.filter(p => p.owner === c.id);
      if (!own.length) continue;
      const x = own.reduce((s, p) => s + p.x, 0) / own.length, y = own.reduce((s, p) => s + p.y, 0) / own.length;
      const foe = G.player >= 0 && atWar(G, G.player, c.id), ally = G.player >= 0 && sameFaction(G, G.player, c.id);
      const label = foe ? `⚔ ${c.name}` : ally ? `🤝 ${c.name}` : c.name;
      ctx.lineWidth = 4; ctx.strokeStyle = foe ? 'rgba(60,0,0,0.85)' : '#000a'; ctx.strokeText(label, x, y);
      ctx.fillStyle = foe ? '#ff8a78' : ally ? '#9bf0a0' : '#fff'; ctx.globalAlpha = foe || ally ? 1 : 0.85; ctx.fillText(label, x, y); ctx.globalAlpha = 1;
    }
  }
  // 수도
  ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const c of G.countries) if (c.alive) { const p = G.provs[c.capital]; ctx.fillStyle = G.player >= 0 && atWar(G, G.player, c.id) ? '#ff6a5a' : '#ffe58a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText('★', p.x, p.y - 14); ctx.fillText('★', p.x, p.y - 14); }

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
  for (const a of G.armies) { // 화살표 머리
    if (!a.path.length || (a.owner !== G.player && !(canSee(a.prov) && selProv === a.prov))) continue;
    const pts = [G.provs[a.prov], ...a.path.map(n => G.provs[n])], last = pts[pts.length - 1], prev = pts[pts.length - 2];
    ctx.fillStyle = a.owner === G.player ? (a.front ? '#ff9a70' : '#ffe58a') : `rgb(${G.countries[a.owner].color})`;
    arrowHead(prev, last, 7 / Math.max(cam.z, 0.7));
  }

  // 부대 마커 (시야 밖의 적 부대는 숨김)
  const groups = new Map();
  for (const a of G.armies) {
    if (!isFriend(a.owner) && !canSee(a.prov)) continue;
    const key = a.prov + ':' + a.owner;
    if (!groups.has(key)) groups.set(key, { prov: a.prov, owner: a.owner, hp: 0, sel: false, badge: null });
    const g = groups.get(key); g.hp += a.hp; g.sel = g.sel || selArmies.has(a.id);
    if (a.front && !g.badge) { const f = G.fronts.find(x => x.id === a.front); if (f) g.badge = f.mode; }
  }
  const perProv = new Map();
  for (const g of groups.values()) {
    const i = perProv.get(g.prov) || 0; perProv.set(g.prov, i + 1);
    const p = G.provs[g.prov];
    flag(p.x + i * 14 - 4, p.y + 4 + i * 10, G.countries[g.owner].color, Math.ceil(g.hp - 1e-6), g.sel, g.badge);
  }
  drawSelBox(dpr);
}

// 드래그 박스 (화면 좌표)
function drawSelBox(dpr) {
  if (!selBox) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = Math.min(selBox.x0, selBox.x1), y = Math.min(selBox.y0, selBox.y1), w = Math.abs(selBox.x1 - selBox.x0), h = Math.abs(selBox.y1 - selBox.y0);
  ctx.fillStyle = 'rgba(120,190,255,0.16)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(160,215,255,0.95)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
}

function frame(t) {
  const dt = Math.min(200, t - lastT); lastT = t;
  if (G && phase === 'play' && speed && !G.over) {
    acc += dt;
    while (acc >= DAY_MS[speed]) {
      acc -= DAY_MS[speed]; tickDay(G); G.dirty = true; panelDirty = true;
      processEvents(); if (modalOpen) break;   // 중요한 알림이 뜨면 즉시 정지
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
  if (G && selArmies.size && panelDirty) { const alive = new Set(G.armies.map(a => a.id)); for (const id of [...selArmies]) if (!alive.has(id)) selArmies.delete(id); }
  if (G && panelDirty) { renderPanel(); syncTop(); renderLog(); }
  draw();
  requestAnimationFrame(frame);
}

resize(); syncTop();
$('panel').innerHTML = '<p class="dim">새 게임을 시작하세요.</p>';
if (store.get(AUTO_KEY) || store.get(SAVE_KEY)) $('continue').style.display = 'block';
requestAnimationFrame(frame);
