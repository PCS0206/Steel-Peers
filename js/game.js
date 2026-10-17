'use strict';
// 게임 규칙: 국가/사단/생산/전쟁/전투/점령 (DOM 의존 없음)

const MOVE_DAYS = 3;     // 지역 하나를 이동하는 데 걸리는 일수
const DIV_COST = 60;     // 사단 1개 생산 비용(PP)
const TRAIN_RATE = 4;    // 생산 항목 하나가 하루에 쓸 수 있는 최대 PP
const MAX_PARALLEL = 3;  // 동시에 진행되는 생산 항목 수
const TRUCE_DAYS = 40;
const START_YEAR = 1936;

const COUNTRY_DEFS = [
  { name: '아우렐리아', color: [214, 80, 70] },
  { name: '브란도르', color: [70, 120, 214] },
  { name: '키레네', color: [230, 190, 70] },
  { name: '드라비아', color: [110, 180, 90] },
  { name: '엘도리아', color: [170, 100, 200] },
  { name: '팔칸', color: [90, 190, 190] },
  { name: '사르마', color: [220, 130, 60] },
];

// 받침 유무에 따라 조사 선택: josa('팔칸','이/가')
function josa(word, pair) {
  const [withB, noB] = pair.split('/');
  const code = word.charCodeAt(word.length - 1) - 0xAC00;
  return word + (code >= 0 && code % 28 !== 0 ? withB : noB);
}

const warKey = (a, b) => (a < b ? a + '-' + b : b + '-' + a);

function newGame(seed, nCountries) {
  const map = generateMap(seed);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const G = {
    seed, rnd, map, provs: map.provs, countries: [], armies: [], wars: {}, truces: {},
    day: 0, log: [], nextArmyId: 1, player: -1, over: null, dirty: true, landCount: 0,
  };
  const land = G.provs.filter(p => p.land);
  G.landCount = land.length;

  // 수도: 서로 멀리 떨어지도록 선택
  const caps = [land[Math.floor(rnd() * land.length)]];
  while (caps.length < nCountries) {
    let best = null, bd = -1;
    for (let t = 0; t < 40; t++) {
      const c = land[Math.floor(rnd() * land.length)];
      const d = Math.min(...caps.map(q => (q.x - c.x) ** 2 + (q.y - c.y) ** 2));
      if (d > bd) { bd = d; best = c; }
    }
    caps.push(best);
  }
  caps.forEach((cap, i) => {
    const def = COUNTRY_DEFS[i % COUNTRY_DEFS.length];
    G.countries.push({ id: i, name: def.name, color: def.color, capital: cap.id, pp: 60, income: 0, queue: [], alive: true, ai: true });
    cap.owner = i;
  });

  // 국경을 번갈아 넓혀 영토 분배
  let progress = true;
  while (progress) {
    progress = false;
    for (const c of G.countries) {
      const cand = land.filter(p => p.owner < 0 && p.adj.some(n => G.provs[n].owner === c.id));
      if (cand.length) { cand[Math.floor(rnd() * cand.length)].owner = c.id; progress = true; }
    }
  }
  for (const p of land) {
    const r = rnd();
    p.industry = r < 0.4 ? 0 : r < 0.75 ? 1 : r < 0.95 ? 2 : 3;
  }
  for (const c of G.countries) {
    G.provs[c.capital].industry += 3;
    const own = land.filter(p => p.owner === c.id);
    spawnArmy(G, c.id, c.capital, 1); spawnArmy(G, c.id, c.capital, 1);
    for (let i = 0; i < 2; i++) spawnArmy(G, c.id, own[Math.floor(rnd() * own.length)].id, 1);
  }
  return G;
}

function spawnArmy(G, owner, prov, hp) {
  const a = { id: G.nextArmyId++, owner, prov, hp, path: [], prog: 0 };
  G.armies.push(a);
  return a;
}

function addLog(G, text, owner) { G.log.push({ day: G.day, text, owner }); if (G.log.length > 200) G.log.shift(); }
function dateStr(day) { return new Date(Date.UTC(START_YEAR, 0, 1 + day)).toISOString().slice(0, 10); }

const atWar = (G, a, b) => a !== b && a >= 0 && b >= 0 && !!G.wars[warKey(a, b)];
const armiesAt = (G, prov) => G.armies.filter(a => a.prov === prov);
const enemiesAt = (G, prov, owner) => G.armies.filter(a => a.prov === prov && atWar(G, owner, a.owner));
const provCount = (G, id) => G.provs.reduce((n, p) => n + (p.owner === id ? 1 : 0), 0);
const strength = (G, id) => G.armies.reduce((s, a) => s + (a.owner === id ? a.hp : 0), 0) + 0.15 * provCount(G, id);
const warsOf = (G, id) => G.countries.filter(c => c.alive && atWar(G, id, c.id)).map(c => c.id);

function neighborsOf(G, id) {
  const s = new Set();
  for (const p of G.provs) if (p.owner === id)
    for (const n of p.adj) { const o = G.provs[n].owner; if (o >= 0 && o !== id && G.countries[o].alive) s.add(o); }
  return [...s];
}

function enterable(G, owner, provId) {
  const p = G.provs[provId];
  return p.land && (p.owner === owner || p.owner < 0 || atWar(G, owner, p.owner));
}

// BFS 경로 (from 제외, to 포함). 갈 수 없으면 null
function findPath(G, from, to, owner) {
  if (from === to || !enterable(G, owner, to)) return null;
  const prev = new Map([[from, -1]]), q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    for (const n of G.provs[cur].adj) if (!prev.has(n) && enterable(G, owner, n)) { prev.set(n, cur); q.push(n); }
  }
  if (!prev.has(to)) return null;
  const path = [];
  for (let c = to; c !== from; c = prev.get(c)) path.unshift(c);
  return path;
}

function declareWar(G, a, b) {
  const k = warKey(a, b);
  if (G.wars[k] || (G.truces[k] || 0) > G.day) return false;
  G.wars[k] = G.day;
  addLog(G, `${josa(G.countries[a].name, '이/가')} ${G.countries[b].name}에 선전포고했다!`, a);
  return true;
}

function makePeace(G, a, b) {
  const k = warKey(a, b);
  delete G.wars[k];
  G.truces[k] = G.day + TRUCE_DAYS;
  addLog(G, `${josa(G.countries[a].name, '과/와')} ${josa(G.countries[b].name, '이/가')} 강화했다.`, a);
  for (const arm of G.armies) {
    if ((arm.owner === a || arm.owner === b) && G.provs[arm.prov].owner >= 0 && G.provs[arm.prov].owner !== arm.owner) {
      arm.prov = nearestOwned(G, arm.prov, arm.owner); arm.path = []; arm.prog = 0;
    }
  }
}

function nearestOwned(G, from, owner) {
  const seen = new Set([from]), q = [from];
  while (q.length) {
    const cur = q.shift();
    if (G.provs[cur].owner === owner) return cur;
    for (const n of G.provs[cur].adj) if (!seen.has(n) && G.provs[n].land) { seen.add(n); q.push(n); }
  }
  return from;
}

// 플레이어가 강화를 제안하면 AI가 수락 여부를 결정
function proposePeace(G, player, other) {
  const since = G.wars[warKey(player, other)];
  if (G.day - since < 20) return { ok: false, msg: '전쟁 개시 후 20일이 지나야 강화를 제안할 수 있다.' };
  const ok = strength(G, other) < strength(G, player) || G.rnd() < 0.15;
  if (ok) { makePeace(G, player, other); return { ok: true, msg: '강화가 성립되었다.' }; }
  return { ok: false, msg: `${josa(G.countries[other].name, '이/가')} 강화를 거부했다.` };
}

function tickDay(G) {
  if (G.over) return;
  G.day++;
  economy(G);
  movement(G);
  combat(G);
  occupation(G);
  for (const c of G.countries) if (c.alive && c.ai) aiTick(G, c);
  checkVictory(G);
}

function economy(G) {
  for (const c of G.countries) {
    if (!c.alive) continue;
    c.income = 1 + G.provs.reduce((s, p) => s + (p.owner === c.id ? p.industry : 0), 0) * 0.25;
    c.pp = Math.min(500, c.pp + c.income);
    let active = 0;
    for (const q of c.queue) {
      if (active++ >= MAX_PARALLEL) break;
      const spend = Math.min(TRAIN_RATE, c.pp, DIV_COST - q.progress);
      q.progress += spend; c.pp -= spend;
    }
    c.queue = c.queue.filter(q => {
      if (q.progress < DIV_COST - 1e-6) return true;
      spawnArmy(G, c.id, G.provs[c.capital].owner === c.id ? c.capital : nearestOwned(G, c.capital, c.id), 1);
      if (c.id === G.player) addLog(G, '새 사단이 편성되었다.', c.id);
      q.progress = 0;
      return true; // 생산 라인은 계속 반복된다
    });
  }
}

function movement(G) {
  for (const a of G.armies) {
    if (!a.path.length) { a.prog = 0; continue; }
    const next = a.path[0];
    if (!enterable(G, a.owner, next)) { a.path = []; a.prog = 0; continue; }
    // 교전 중에는 아군 영토로만 후퇴 가능
    if (enemiesAt(G, a.prov, a.owner).length && G.provs[next].owner !== a.owner) { a.prog = 0; continue; }
    if (++a.prog >= MOVE_DAYS) { a.prov = next; a.path.shift(); a.prog = 0; }
  }
}

function combat(G) {
  const byProv = new Map();
  for (const a of G.armies) { if (!byProv.has(a.prov)) byProv.set(a.prov, []); byProv.get(a.prov).push(a); }
  const dmg = new Map();
  for (const [pid, list] of byProv) {
    const owners = [...new Set(list.map(a => a.owner))];
    if (owners.length < 2) continue;
    for (const o of owners) {
      const enemies = list.filter(x => atWar(G, o, x.owner));
      if (!enemies.length) continue;
      const hp = list.reduce((s, x) => s + (x.owner === o ? x.hp : 0), 0);
      const bonus = G.provs[pid].owner === o ? 1.2 : 1;
      const per = hp * 0.12 * bonus * (0.8 + G.rnd() * 0.4) / enemies.length;
      for (const e of enemies) dmg.set(e, (dmg.get(e) || 0) + per);
    }
  }
  for (const [a, d] of dmg) a.hp -= d;
  G.armies = G.armies.filter(a => a.hp > 0.05);
}

function occupation(G) {
  const byProv = new Map();
  for (const a of G.armies) { if (!byProv.has(a.prov)) byProv.set(a.prov, []); byProv.get(a.prov).push(a); }
  for (const [pid, list] of byProv) {
    const p = G.provs[pid];
    if (!p.land || list.some(a => a.owner === p.owner)) continue;
    const occ = list.filter(a => p.owner < 0 || atWar(G, a.owner, p.owner));
    if (!occ.length) continue;
    const totals = new Map();
    for (const a of occ) totals.set(a.owner, (totals.get(a.owner) || 0) + a.hp);
    const winner = [...totals.entries()].sort((x, y) => y[1] - x[1])[0][0];
    capture(G, p, winner);
  }
}

function capture(G, p, newOwner) {
  const old = p.owner;
  p.owner = newOwner;
  G.dirty = true;
  if (old < 0) return;
  const oc = G.countries[old];
  if (p.id === oc.capital) {
    addLog(G, `${josa(G.countries[newOwner].name, '이/가')} ${oc.name}의 수도 ${josa(p.name, '을/를')} 점령했다!`, newOwner);
    const rest = G.provs.filter(q => q.owner === old).sort((a, b) => b.industry - a.industry)[0];
    if (rest) oc.capital = rest.id;
  } else if (newOwner === G.player || old === G.player) {
    addLog(G, `${p.name}: ${G.countries[newOwner].name}, ${oc.name}에게서 점령`, newOwner);
  }
  if (!G.provs.some(q => q.owner === old)) eliminate(G, old);
}

function eliminate(G, id) {
  const c = G.countries[id];
  c.alive = false; c.queue = [];
  G.armies = G.armies.filter(a => a.owner !== id);
  for (const k of Object.keys(G.wars)) if (k.split('-').map(Number).includes(id)) delete G.wars[k];
  addLog(G, `${josa(c.name, '이/가')} 멸망했다.`, id);
}

function checkVictory(G) {
  if (G.player < 0 || G.over) return;
  const me = G.countries[G.player];
  if (!me.alive) { G.over = 'lose'; return; }
  const alive = G.countries.filter(c => c.alive);
  if (alive.length === 1 || provCount(G, G.player) >= G.landCount * 0.6) G.over = 'win';
}
