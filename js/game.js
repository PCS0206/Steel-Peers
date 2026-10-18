'use strict';
// 게임 규칙: 국가/사단/생산/전쟁/전투/점령/동맹 (DOM 의존 없음)

const MOVE_DAYS = 3;      // 평원 기준 지역 하나를 이동하는 일수
const MAX_PARALLEL = 3;   // 동시에 진행되는 생산 라인 수
const MAX_LINES = 6;
const MAX_FACTION = 3;    // 동맹 최대 인원
const TRUCE_DAYS = 40;
const START_YEAR = 1936;
const SUPPLY_RANGE = 2;   // 아군 지배 지역에서 이만큼 떨어진 곳까지 보급
const SAVE_VERSION = 2;

// 사단 종류. eq=훈련에 드는 장비, mp=인력(천 명), terr=지형별 공격·방어 보정
const UNITS = {
  inf: { name: '보병', eq: { small: 40 }, mp: 8, atk: 1, def: 1.1, speed: 1, terr: {} },
  arm: { name: '기갑', eq: { tank: 25 }, mp: 6, atk: 1.9, def: 0.9, speed: 1.7, terr: { forest: 0.6, hills: 0.7, mountain: 0.4, marsh: 0.5 } },
  mtn: { name: '산악보병', eq: { small: 40 }, mp: 8, atk: 1, def: 1.1, speed: 1, terr: { hills: 1.3, mountain: 1.5 } },
};
const unitMod = (type, terrain) => UNITS[type].terr[terrain] ?? 1;

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

function emptyState(seed, map) {
  return {
    seed, map, provs: map.provs, countries: [], armies: [], wars: {}, truces: {}, factions: [], nextFaction: 1, fronts: [], nextFront: 1,
    day: 0, log: [], logSeq: 0, nextArmyId: 1, player: -1, over: null, dirty: true, landCount: 0, supply: [], vis: null,
    rnd: mulberry32(seed),
  };
}

function newGame(seed, nCountries) {
  const map = generateMap(seed);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const G = emptyState(seed, map);
  G.nCountries = nCountries;
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
    G.countries.push({ id: i, name: def.name, color: def.color, capital: cap.id, pp: 100, manpower: 40, income: 0, equip: { small: 80, tank: 30 }, alloc: { small: 0, tank: 0 }, eqRate: { small: 0, tank: 0 }, fac: { civ: 0, mil: 0 }, construction: [], queue: [], alive: true, ai: true, faction: -1 });
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
    p.controller = p.owner;
  }
  for (const c of G.countries) G.provs[c.capital].industry += 3;
  initEconomy(G);
  for (const c of G.countries) {
    const own = land.filter(p => p.owner === c.id);
    spawnArmy(G, c.id, c.capital, 'inf'); spawnArmy(G, c.id, c.capital, 'inf'); spawnArmy(G, c.id, c.capital, 'arm');
    for (let i = 0; i < 2; i++) spawnArmy(G, c.id, own[Math.floor(rnd() * own.length)].id, 'inf');
  }
  computeSupply(G);
  return G;
}

function spawnArmy(G, owner, prov, type, amount = 1) {
  const a = { id: G.nextArmyId++, owner, prov, hp: amount, comp: { [type]: amount }, org: 1, path: [], prog: 0, front: null, born: G.day };
  G.armies.push(a);
  return a;
}

function mergeArmies(into, from) {
  const tot = into.hp + from.hp;
  into.org = (into.org * into.hp + from.org * from.hp) / tot;
  for (const t in from.comp) into.comp[t] = (into.comp[t] || 0) + from.comp[t];
  into.hp = tot;
}

// 지정한 종류 1개 사단을 떼어 새 부대로 만든다
function splitArmy(G, a, type) {
  if (!(a.comp[type] >= 1) || a.hp < 2) return null;
  a.comp[type] -= 1; a.hp -= 1;
  const n = spawnArmy(G, a.owner, a.prov, type, 1);
  n.org = a.org; n.front = a.front;
  return n;
}

function setHp(a) { a.hp = Object.values(a.comp).reduce((s, v) => s + v, 0); }
function scaleArmy(a, factor) { for (const t in a.comp) a.comp[t] *= factor; setHp(a); }

// kind: war/join/peace/alliance/leave/capital/occupy/fall/built/unit/front/info, involved: 관련 국가 id들 (UI 알림 분류용)
function addLog(G, text, owner, kind = 'info', involved = []) {
  G.log.push({ id: ++G.logSeq, day: G.day, text, owner, kind, involved });
  if (G.log.length > 200) G.log.shift();
}
function dateStr(day) { return new Date(Date.UTC(START_YEAR, 0, 1 + day)).toISOString().slice(0, 10); }

const atWar = (G, a, b) => a !== b && a >= 0 && b >= 0 && G.wars[warKey(a, b)] !== undefined;
const sameFaction = (G, a, b) => a !== b && a >= 0 && b >= 0 && G.countries[a].faction >= 0 && G.countries[a].faction === G.countries[b].faction;
const enemiesAt = (G, prov, owner) => G.armies.filter(a => a.prov === prov && atWar(G, owner, a.owner));
const ownedCount = (G, id) => G.provs.reduce((n, p) => n + (p.owner === id ? 1 : 0), 0);
const controlledCount = (G, id) => G.provs.reduce((n, p) => n + (p.controller === id && p.land ? 1 : 0), 0);
const strength = (G, id) => G.armies.reduce((s, a) => s + (a.owner === id ? a.hp : 0), 0) + 0.15 * controlledCount(G, id);
const warsOf = (G, id) => G.countries.filter(c => c.alive && atWar(G, id, c.id)).map(c => c.id);
const membersOf = (G, faction) => G.countries.filter(c => c.alive && c.faction === faction);
// owner의 영토 중 controller가 점령한 지역 수
const warScore = (G, controller, owner) => G.provs.reduce((n, p) => n + (p.owner === owner && p.controller === controller ? 1 : 0), 0);

function neighborsOf(G, id) {
  const s = new Set();
  for (const p of G.provs) if (p.owner === id)
    for (const n of p.adj) { const o = G.provs[n].owner; if (o >= 0 && o !== id && G.countries[o].alive) s.add(o); }
  return [...s];
}

// 이동 가능 여부: 아군/동맹 지배지, 중립, 또는 전쟁 중인 상대의 영토
function enterable(G, who, provId) {
  const p = G.provs[provId];
  if (!p.land) return false;
  return p.controller === who || p.owner === who || p.controller < 0 || sameFaction(G, who, p.controller)
    || atWar(G, who, p.controller) || atWar(G, who, p.owner);
}

// BFS 경로 (from 제외, to 포함). 갈 수 없으면 null
function findPath(G, from, to, who) {
  if (from === to || !enterable(G, who, to)) return null;
  const prev = new Map([[from, -1]]), q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    for (const n of G.provs[cur].adj) if (!prev.has(n) && enterable(G, who, n)) { prev.set(n, cur); q.push(n); }
  }
  if (!prev.has(to)) return null;
  const path = [];
  for (let c = to; c !== from; c = prev.get(c)) path.unshift(c);
  return path;
}

// ---------- 보급 / 시야 ----------
// 각 국가가 지배하는 지역에서 육지 거리를 BFS로 계산
function computeSupply(G) {
  G.supply = G.countries.map(c => {
    const dist = new Int16Array(G.provs.length).fill(99), q = [];
    for (const p of G.provs) if (p.land && p.controller === c.id) { dist[p.id] = 0; q.push(p.id); }
    for (let i = 0; i < q.length; i++) {
      const cur = q[i];
      for (const n of G.provs[cur].adj) if (G.provs[n].land && dist[n] > dist[cur] + 1) { dist[n] = dist[cur] + 1; q.push(n); }
    }
    return dist;
  });
}
const isSupplied = (G, a) => G.supply[a.owner][a.prov] <= SUPPLY_RANGE;

// 보이는 지역: 아군(동맹 포함) 지배·소유지와 그 인접, 아군 부대 주변
function visibleSet(G, id) {
  const vis = new Set();
  const add = p => { vis.add(p); for (const n of G.provs[p].adj) vis.add(n); };
  const friend = o => o === id || sameFaction(G, id, o);
  for (const p of G.provs) if (p.land && (friend(p.controller) || friend(p.owner))) add(p.id);
  for (const a of G.armies) if (friend(a.owner)) add(a.prov);
  return vis;
}

// ---------- 외교 ----------
// a가 b에게 선전포고하면 누가 참전하는가: ours = a 쪽 동맹, theirs = b 쪽 동맹 (b의 동맹이 a를 상대로 참전)
function warParticipants(G, a, b) {
  const joiners = (side, foe) => {
    const f = G.countries[side].faction;
    if (f < 0) return [];
    return membersOf(G, f).filter(m => m.id !== side && m.id !== foe && !atWar(G, m.id, foe) && !sameFaction(G, m.id, foe)).map(m => m.id);
  };
  return { ours: joiners(a, b), theirs: joiners(b, a) };
}

function declareWar(G, a, b) {
  const k = warKey(a, b);
  if (G.wars[k] !== undefined || sameFaction(G, a, b) || (G.truces[k] || 0) > G.day) return false;
  const { ours, theirs } = warParticipants(G, a, b);
  G.wars[k] = G.day;
  addLog(G, `${josa(G.countries[a].name, '이/가')} ${G.countries[b].name}에 선전포고했다!`, a, 'war', [a, b]);
  // 양측 동맹이 자동 참전
  for (const [list, foe] of [[ours, b], [theirs, a]]) {
    for (const id of list) {
      G.wars[warKey(id, foe)] = G.day;
      addLog(G, `${josa(G.countries[id].name, '이/가')} 동맹을 지키기 위해 ${G.countries[foe].name}와의 전쟁에 참전했다.`, id, 'join', [id, foe]);
    }
  }
  return true;
}

function makePeace(G, a, b, winner = -1) {
  delete G.wars[warKey(a, b)];
  G.truces[warKey(a, b)] = G.day + TRUCE_DAYS;
  if (winner >= 0) {
    const loser = winner === a ? b : a;
    let n = 0;
    for (const p of G.provs) if (p.owner === loser && p.controller === winner) { p.owner = winner; n++; }
    G.dirty = true;
    addLog(G, `${josa(G.countries[winner].name, '이/가')} ${G.countries[loser].name}에게서 ${n}개 지역을 할양받고 강화했다.`, winner, 'peace', [winner, loser]);
  } else {
    addLog(G, `${josa(G.countries[a].name, '과/와')} ${josa(G.countries[b].name, '이/가')} 강화했다.`, a, 'peace', [a, b]);
  }
  // 갈 수 없게 된 지역에 있는 부대는 가까운 아군 지역으로 복귀
  for (const arm of G.armies) {
    if (!enterable(G, arm.owner, arm.prov)) { arm.prov = nearestControlled(G, arm.prov, arm.owner); arm.path = []; arm.prog = 0; }
  }
  G.dirty = true;
}

function nearestControlled(G, from, who) {
  const seen = new Set([from]), q = [from];
  while (q.length) {
    const cur = q.shift();
    if (G.provs[cur].controller === who) return cur;
    for (const n of G.provs[cur].adj) if (!seen.has(n) && G.provs[n].land) { seen.add(n); q.push(n); }
  }
  return from;
}

// AI 쌍 강화: 점령 지역이 더 많은 쪽이 승자
function aiPeace(G, a, b) {
  const sa = warScore(G, a, b), sb = warScore(G, b, a);
  makePeace(G, a, b, sa > sb ? a : sb > sa ? b : -1);
}

// 플레이어 강화 제안. demand=true면 점령한 지역의 할양을 요구한다
function proposePeace(G, player, other, demand) {
  const since = G.wars[warKey(player, other)];
  if (G.day - since < 20) return { ok: false, msg: '전쟁 개시 후 20일이 지나야 강화를 제안할 수 있다.' };
  const name = josa(G.countries[other].name, '이/가');
  if (demand) {
    const score = warScore(G, player, other);
    if (!score) return { ok: false, msg: '점령한 지역이 없어 요구할 영토가 없다.' };
    const capTaken = G.provs[G.countries[other].capital].controller === player;
    if (strength(G, other) < strength(G, player) * 0.9 || capTaken) { makePeace(G, player, other, player); return { ok: true, msg: `${score}개 지역을 할양받았다.` }; }
    return { ok: false, msg: `${name} 영토 할양을 거부했다. 더 압박하라.` };
  }
  if (strength(G, other) < strength(G, player) || G.rnd() < 0.15) { makePeace(G, player, other); return { ok: true, msg: '강화가 성립되었다.' }; }
  return { ok: false, msg: `${name} 강화를 거부했다.` };
}

// ---------- 동맹 ----------
function canJoin(G, a, b) {
  const A = G.countries[a], B = G.countries[b];
  if (!A.alive || !B.alive || atWar(G, a, b)) return false;
  if (A.faction >= 0 && B.faction >= 0) return false; // 서로 다른 동맹끼리(또는 이미 같은 동맹)는 불가
  const members = [...(A.faction >= 0 ? membersOf(G, A.faction) : [A]), ...(B.faction >= 0 ? membersOf(G, B.faction) : [B])];
  if (members.length > MAX_FACTION) return false;
  return members.every(m => members.every(n => m.id === n.id || !atWar(G, m.id, n.id)));
}

function formAlliance(G, a, b) {
  if (!canJoin(G, a, b)) return false;
  const A = G.countries[a], B = G.countries[b];
  let f = A.faction >= 0 ? A.faction : B.faction;
  if (f < 0) { f = G.nextFaction++; G.factions[f] = { id: f, name: `${A.name} 동맹` }; A.faction = f; }
  A.faction = B.faction = f;
  addLog(G, `${josa(A.name, '과/와')} ${josa(B.name, '이/가')} 동맹을 맺었다.`, a, 'alliance', [a, b]);
  return true;
}

function leaveFaction(G, id) {
  const c = G.countries[id], f = c.faction;
  if (f < 0) return;
  c.faction = -1;
  addLog(G, `${josa(c.name, '이/가')} 동맹을 탈퇴했다.`, id, 'leave', [id]);
  if (membersOf(G, f).length < 2) membersOf(G, f).forEach(m => { m.faction = -1; });
}

const hasCommonEnemy = (G, a, b) => G.countries.some(c => c.alive && c.id !== a && c.id !== b && atWar(G, a, c.id) && atWar(G, b, c.id));

function proposeAlliance(G, player, other) {
  const name = josa(G.countries[other].name, '이/가');
  if (!canJoin(G, player, other)) return { ok: false, msg: `${name} 동맹을 맺을 수 없는 상태다.` };
  if (hasCommonEnemy(G, player, other) || (strength(G, other) < strength(G, player) * 1.3 && G.rnd() < 0.5)) {
    formAlliance(G, player, other);
    return { ok: true, msg: '동맹이 성립되었다.' };
  }
  return { ok: false, msg: `${name} 동맹을 거절했다.` };
}

// ---------- 일 단위 진행 ----------
function tickDay(G) {
  if (G.over) return;
  G.day++;
  G.rnd = mulberry32(G.seed * 7919 + G.day); // 하루 단위로 시드: 저장/불러오기 후에도 결과 동일
  computeSupply(G);
  economy(G);
  movement(G);
  combat(G);
  occupation(G);
  upkeep(G);
  frontsTick(G);
  for (const c of G.countries) if (c.alive && c.ai) aiTick(G, c);
  checkVictory(G);
}

// 지형·속도를 반영한 이동 일수 (구성 중 가장 느린 사단 기준)
function moveDays(G, a, provId) {
  const tm = TERRAIN[G.provs[provId].terrain].move;
  let days = 0;
  for (const t in a.comp) {
    if (a.comp[t] < 0.01) continue;
    const mult = t === 'mtn' && tm > 1 ? 1 + (tm - 1) * 0.5 : tm; // 산악병은 험지 페널티 절반
    days = Math.max(days, MOVE_DAYS * mult / UNITS[t].speed);
  }
  return Math.max(1, Math.ceil(days - 1e-9));
}

function movement(G) {
  for (const a of G.armies) {
    if (!a.path.length) { a.prog = 0; continue; }
    const next = a.path[0];
    if (!enterable(G, a.owner, next)) { a.path = []; a.prog = 0; continue; }
    // 교전 중에는 아군 지역으로만 후퇴 가능
    if (enemiesAt(G, a.prov, a.owner).length && G.provs[next].controller !== a.owner) { a.prog = 0; continue; }
    if (++a.prog >= moveDays(G, a, next)) { a.prov = next; a.path.shift(); a.prog = 0; }
  }
}

function combat(G) {
  const byProv = new Map();
  for (const a of G.armies) { a.fought = false; if (!byProv.has(a.prov)) byProv.set(a.prov, []); byProv.get(a.prov).push(a); }
  const dmg = new Map();
  for (const [pid, list] of byProv) {
    const owners = [...new Set(list.map(a => a.owner))];
    if (owners.length < 2) continue;
    const p = G.provs[pid], terr = TERRAIN[p.terrain];
    for (const o of owners) {
      const mine = list.filter(x => x.owner === o);
      const enemies = list.filter(x => atWar(G, o, x.owner));
      if (!enemies.length) continue;
      let power = 0;
      for (const a of mine) {
        a.fought = true;
        for (const t in a.comp) power += a.comp[t] * UNITS[t].atk * unitMod(t, p.terrain) * (0.6 + 0.4 * a.org);
      }
      const base = power * 0.12 * (0.8 + G.rnd() * 0.4) / enemies.length;
      for (const e of enemies) {
        e.fought = true;
        let def = 0;
        for (const t in e.comp) def += e.comp[t] * UNITS[t].def * unitMod(t, p.terrain);
        def /= e.hp;
        const defender = e.owner === p.controller || sameFaction(G, e.owner, p.controller);
        if (defender) def *= 1.1 * terr.def;
        const supplyPenalty = isSupplied(G, e) ? 1 : 1.25;
        dmg.set(e, (dmg.get(e) || 0) + base / def * supplyPenalty);
      }
    }
  }
  for (const [a, d] of dmg) scaleArmy(a, Math.max(0, (a.hp - d) / a.hp));
  G.armies = G.armies.filter(a => a.hp > 0.05);
}

// 상대 지역에 아군만 남으면 점령 (소유권은 그대로, 지배권만 이동)
function occupation(G) {
  const byProv = new Map();
  for (const a of G.armies) { if (!byProv.has(a.prov)) byProv.set(a.prov, []); byProv.get(a.prov).push(a); }
  for (const [pid, list] of byProv) {
    const p = G.provs[pid];
    if (!p.land || list.some(a => a.owner === p.controller || sameFaction(G, a.owner, p.controller))) continue;
    const occ = list.filter(a => p.controller < 0 || atWar(G, a.owner, p.controller));
    if (!occ.length) continue;
    const totals = new Map();
    for (const a of occ) totals.set(a.owner, (totals.get(a.owner) || 0) + a.hp);
    occupy(G, p, [...totals.entries()].sort((x, y) => y[1] - x[1])[0][0]);
  }
  for (const c of G.countries) if (c.alive && !G.provs.some(p => p.land && p.controller === c.id)) capitulate(G, c.id);
}

function occupy(G, p, who) {
  const old = p.controller;
  p.controller = who;
  G.dirty = true;
  if (old < 0) { p.owner = who; return; }
  const oc = G.countries[old];
  if (p.owner === old && p.id === oc.capital) {
    addLog(G, `${josa(G.countries[who].name, '이/가')} ${oc.name}의 수도 ${josa(p.name, '을/를')} 점령했다!`, who, 'capital', [who, old]);
    const rest = G.provs.filter(q => q.land && q.controller === old).sort((a, b) => (b.civ + b.mil) - (a.civ + a.mil))[0];
    if (rest) oc.capital = rest.id;
  } else if (who === G.player || old === G.player || p.owner === G.player) {
    addLog(G, `${p.name}: ${G.countries[who].name}, ${G.countries[old].name}에게서 점령`, who, 'occupy', [who, old]);
  }
}

// 지배하는 지역이 하나도 없으면 항복: 영토는 점령국에 합병
function capitulate(G, id) {
  const c = G.countries[id];
  for (const p of G.provs) if (p.land && p.owner === id && p.controller >= 0) p.owner = p.controller;
  c.alive = false; c.queue = []; c.construction = []; c.faction = -1;
  G.armies = G.armies.filter(a => a.owner !== id);
  for (const k of Object.keys(G.wars)) if (k.split('-').map(Number).includes(id)) delete G.wars[k];
  G.dirty = true;
  addLog(G, `${josa(c.name, '이/가')} 항복했다.`, id, 'fall', [id]);
}

// 보급 끊김은 조직도와 병력을 깎고, 보급되는 휴식 부대는 조직도를 회복
function upkeep(G) {
  for (const a of G.armies) {
    const ok = isSupplied(G, a);
    if (a.fought) a.org = Math.max(0, a.org - 0.03);
    else if (ok) a.org = Math.min(1, a.org + 0.03);
    else a.org = Math.max(0, a.org - 0.03);
    if (!ok) scaleArmy(a, 0.99);
    delete a.fought;
  }
}

function checkVictory(G) {
  if (G.player < 0 || G.over) return;
  const me = G.countries[G.player];
  if (!me.alive) { G.over = 'lose'; return; }
  const alive = G.countries.filter(c => c.alive);
  if (ownedCount(G, G.player) >= G.landCount * 0.6 || alive.every(c => c.id === G.player || sameFaction(G, G.player, c.id))) G.over = 'win';
}

// ---------- 저장 / 불러오기 ----------
function serialize(G) {
  return JSON.parse(JSON.stringify({
    v: SAVE_VERSION, seed: G.seed, nCountries: G.nCountries, day: G.day, player: G.player, nextArmyId: G.nextArmyId,
    countries: G.countries, armies: G.armies, wars: G.wars, truces: G.truces, factions: G.factions, nextFaction: G.nextFaction, fronts: G.fronts, nextFront: G.nextFront,
    log: G.log.slice(-60), logSeq: G.logSeq, over: G.over, landCount: G.landCount, provs: G.provs.map(p => [p.owner, p.controller, p.industry, p.civ, p.mil]),
  }));
}

function deserialize(d) {
  if (!d || d.v !== SAVE_VERSION) throw new Error('지원하지 않는 저장 데이터');
  const G = emptyState(d.seed, generateMap(d.seed));
  Object.assign(G, {
    nCountries: d.nCountries, day: d.day, player: d.player, nextArmyId: d.nextArmyId, countries: d.countries, armies: d.armies,
    wars: d.wars, truces: d.truces, factions: d.factions, nextFaction: d.nextFaction, fronts: d.fronts || [], nextFront: d.nextFront || 1, log: d.log, logSeq: d.logSeq || 0, over: d.over, landCount: d.landCount,
  });
  d.provs.forEach(([owner, controller, industry, civ, mil], i) => Object.assign(G.provs[i], { owner, controller, industry, civ, mil, slots: industry + SLOT_BONUS }));
  computeSupply(G);
  return G;
}
