'use strict';
// 경제: 민수 공장 → PP(공장 건설), 군수 공장 → 장비 생산 → 비축 장비로 사단 훈련.
// 공장은 지역에 속한다: 소유와 지배를 모두 가진 국가만 그 공장을 쓴다(점령당하면 생산 중단).

const EQUIP = {
  small: { name: '보병장비', out: 0.8 },   // 군수 공장 1개당 하루 생산량
  tank: { name: '전차', out: 0.35 },
  gun: { name: '야포', out: 0.45 },
};
const FACTORY_COST = 100;   // 공장 1개 건설 PP
const BUILD_RATE = 10;      // 건설 프로젝트 하나가 하루에 쓸 수 있는 최대 PP
const MAX_BUILD = 3;        // 동시에 진행되는 건설 수
const MAX_PROJECTS = 6;     // 건설 대기열 최대
const BASE_PP = 1, CIV_PP = 0.6;
const EQ_CAP = 1500, PP_CAP = 1000;
const SLOT_BONUS = 1;       // 지역 공장 슬롯 = 산업 + 1
// 기본 사단의 훈련 일수 (설계한 사단은 UNITS[id].days)
const TRAIN_DAYS = { get inf() { return UNITS.inf.days; }, get arm() { return UNITS.arm.days; }, get mtn() { return UNITS.mtn.days; } };

// 소유·지배를 모두 가진 지역의 공장 합
function factoriesOf(G, id) {
  let civ = 0, mil = 0;
  for (const p of G.provs) if (p.land && p.owner === id && p.controller === id) { civ += p.civ; mil += p.mil; }
  return { civ, mil };
}

function initEconomy(G) {
  for (const p of G.provs) {
    if (!p.land) continue;
    p.slots = p.industry + SLOT_BONUS;
    p.mil = Math.round(p.industry * 0.45);
    p.civ = p.industry - p.mil;
  }
  for (const c of G.countries) {
    const { mil } = factoriesOf(G, c.id), small = Math.round(mil * 0.55), tank = Math.round(mil * 0.25);
    c.alloc = { small, tank, gun: mil - small - tank };
    c.fac = factoriesOf(G, c.id);
  }
}

const allocTotal = a => Object.values(a).reduce((s, v) => s + v, 0);
function clampAlloc(c, mil) {
  const a = c.alloc;
  while (allocTotal(a) > mil) { const k = Object.keys(a).sort((x, y) => a[y] - a[x])[0]; if (a[k] <= 0) break; a[k]--; }
}

const queuedBuilds = (c, provId) => c.construction.filter(j => j.prov === provId).length;
const freeSlots = (c, p) => p.slots - p.civ - p.mil - queuedBuilds(c, p.id);

function queueBuild(G, cid, provId, kind) {
  const c = G.countries[cid], p = G.provs[provId];
  if (!p || !p.land || p.owner !== cid || p.controller !== cid) return { ok: false, msg: '내가 소유·지배하는 지역에만 지을 수 있다.' };
  if (kind !== 'civ' && kind !== 'mil') return { ok: false, msg: '알 수 없는 공장 종류' };
  if (freeSlots(c, p) <= 0) return { ok: false, msg: '이 지역에는 더 지을 공간이 없다.' };
  if (c.construction.length >= MAX_PROJECTS) return { ok: false, msg: `건설 대기열이 가득 찼다 (${MAX_PROJECTS}).` };
  c.construction.push({ prov: provId, kind, progress: 0 });
  return { ok: true, msg: `${p.name}에 ${kind === 'civ' ? '민수' : '군수'} 공장 건설을 시작했다.` };
}

function cancelBuild(G, cid, index) {
  const c = G.countries[cid], j = c.construction[index];
  if (!j) return;
  c.pp += j.progress * 0.5;           // 진행분의 절반을 돌려받는다
  c.construction.splice(index, 1);
}

// 군수 공장 할당 조정: eq 장비 쪽으로 delta(±1)
function setAlloc(G, cid, eq, delta) {
  const c = G.countries[cid], { mil } = factoriesOf(G, cid), a = c.alloc;
  if (delta > 0 && allocTotal(a) >= mil) return false;
  if (delta < 0 && a[eq] <= 0) return false;
  a[eq] += delta;
  return true;
}

function addTrainLine(G, cid, type) {
  const c = G.countries[cid];
  if (c.queue.length >= MAX_LINES) return false;
  c.queue.push({ type, progress: 0, started: false });
  return true;
}

// 훈련 라인 삭제. 이미 훈련을 시작했다면 장비·인력을 돌려준다
function removeLine(G, cid, index) {
  const c = G.countries[cid], q = c.queue[index];
  if (!q) return;
  if (q.started) {
    for (const [k, v] of Object.entries(UNITS[q.type].eq)) c.equip[k] += v;
    c.manpower += UNITS[q.type].mp;
  }
  c.queue.splice(index, 1);
}

function economy(G) {
  for (const c of G.countries) {
    if (!c.alive) continue;
    const fac = c.fac = factoriesOf(G, c.id);
    clampAlloc(c, fac.mil);

    const eco = c.ai ? diffOf(G).aiEco : 1;                                 // 난이도: AI 경제 배율
    c.income = (BASE_PP + CIV_PP * fac.civ) * eco;
    c.pp = Math.min(PP_CAP, c.pp + c.income);
    c.manpower = Math.min(150, c.manpower + 0.08 * controlledCount(G, c.id) * eco);
    c.eqRate = {};
    for (const k of Object.keys(EQUIP)) {
      c.eqRate[k] = (c.alloc[k] || 0) * EQUIP[k].out * eco;
      c.equip[k] = Math.min(EQ_CAP, c.equip[k] + c.eqRate[k]);
    }

    // 건설: 앞의 MAX_BUILD개가 PP를 쓴다
    let active = 0;
    c.construction = c.construction.filter(j => {
      const p = G.provs[j.prov];
      if (p.owner !== c.id || p.controller !== c.id) return false;   // 지역을 잃으면 취소
      if (active++ >= MAX_BUILD) return true;
      const spend = Math.min(BUILD_RATE, c.pp, FACTORY_COST - j.progress);
      j.progress += spend; c.pp -= spend;
      if (j.progress < FACTORY_COST - 1e-6) return true;
      if (p.civ + p.mil >= p.slots) return false;
      p[j.kind]++;
      if (j.kind === 'mil') c.alloc.small = (c.alloc.small || 0) + 1;   // 새 군수 공장은 보병장비에 우선 할당
      if (c.id === G.player) addLog(G, `${p.name}에 ${j.kind === 'civ' ? '민수' : '군수'} 공장이 완공되었다.`, c.id, 'built', [c.id]);
      G.dirty = true;
      return false;
    });

    trainDivisions(G, c);
  }
}

// 훈련: 시작할 때 장비·인력을 소모하고 사단 템플릿의 훈련 일수 동안 훈련한 뒤 수도에 편성. 완료되면 같은 라인이 반복된다
function trainDivisions(G, c) {
  let active = c.queue.filter(q => q.started).length;
  for (const q of c.queue) {
    const u = UNITS[q.type];
    if (!q.started) {
      q.stall = null;
      if (active >= MAX_PARALLEL) { q.stall = 'slot'; continue; }
      const lack = Object.entries(u.eq).find(([k, v]) => c.equip[k] < v);
      if (lack) { q.stall = lack[0]; continue; }
      if (c.manpower < u.mp) { q.stall = 'mp'; continue; }
      for (const [k, v] of Object.entries(u.eq)) c.equip[k] -= v;
      c.manpower -= u.mp;
      q.started = true; q.progress = 0; active++;
    } else if (++q.progress >= u.days) {
      const home = G.provs[c.capital].controller === c.id ? c.capital : nearestControlled(G, c.capital, c.id);
      spawnArmy(G, c.id, home, q.type);
      if (c.id === G.player) addLog(G, `새 ${u.name} 사단이 편성되었다.`, c.id, 'unit', [c.id]);
      q.started = false; q.progress = 0;
    }
  }
}
