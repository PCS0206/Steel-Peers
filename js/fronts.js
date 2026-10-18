'use strict';
// 전선: 적과 맞닿은 내 지역(접경)을 따라 선을 긋고, 배치된 사단을 자동으로 움직인다 (호이4식).
//  - 전선 라인: 접경 지역을 직접 골라 그리거나(f.line), 시드에서 이어지는 접경 전체를 자동으로 잡는다
//  - 방어(hold): 접경에 병력을 위협에 비례해 분산, 침투한 적에게 집결, 국지 우세 시 역공
//  - 공격(attack): 접경에 집결한 뒤 진격. 공격 화살표(f.arrows)가 있으면 화살표 목표를 순서대로 공략
//  - 점령으로 접경이 바뀌면 전선도 따라 전진하고, 밀리면 뒤로 물러난다
// 전선 AI는 플레이어와 같은 시야 정보(안개)만 사용한다.

const MAX_FRONTS = 6;
const MAX_ARROWS = 4;

// id가 내 접경 지역(적 지배지와 맞닿은 내 지배지)이면 맞닿은 적 국가를 돌려준다. enemy를 주면 그 적에 대해서만 판정
function frontCandidate(G, owner, id, enemy = null) {
  const p = G.provs[id];
  if (!p || !p.land || p.controller !== owner) return -1;
  const cnt = new Map();
  for (const n of p.adj) {
    const c = G.provs[n].land ? G.provs[n].controller : -1;
    if (c >= 0 && atWar(G, owner, c)) cnt.set(c, (cnt.get(c) || 0) + 1);
  }
  if (enemy !== null) return cnt.has(enemy) ? enemy : -1;
  if (!cnt.size) return -1;
  return [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// line: 직접 그린 접경 지역 id들 (없으면 seed에서 이어지는 접경 전체를 자동으로 잡는다)
function createFront(G, owner, seed, mode = 'attack', line = null) {
  if (G.fronts.filter(f => f.owner === owner).length >= MAX_FRONTS) return null;
  let enemy;
  if (line && line.length) {
    enemy = frontCandidate(G, owner, line[0]);
    if (enemy < 0 || !line.every(id => frontCandidate(G, owner, id, enemy) === enemy)) return null;
    seed = line[0];
  } else {
    enemy = frontCandidate(G, owner, seed);
    if (enemy < 0) return null;
    line = null;
  }
  const same = G.fronts.filter(f => f.owner === owner && f.enemy === enemy).length;
  const f = {
    id: G.nextFront++, owner, enemy, seed, mode, auto: false, line: line ? [...new Set(line)] : null, maxLine: line ? Math.max(4, new Set(line).size * 2) : 0, arrows: [],
    name: `${G.countries[enemy].name} 전선${same ? ' ' + (same + 1) : ''}`, border: [],
  };
  G.fronts.push(f);
  f.border = frontBorder(G, f);
  addLog(G, `${f.name}을 편성했다 (${mode === 'attack' ? '공격' : '방어'}).`, owner, 'front', [owner]);
  return f;
}

function dissolveFront(G, f, why) {
  G.fronts = G.fronts.filter(x => x !== f);
  for (const a of G.armies) if (a.front === f.id) a.front = null;
  if (why) addLog(G, `${f.name}: ${why}`, f.owner, 'front', [f.owner]);
}

// 공격 화살표: 접경 바로 건너편 적 지역에서 시작해 이어지는 적 지배지의 경로
function addArrow(G, f, path) {
  if (!path || !path.length) return { ok: false, msg: '화살표 경로가 비어 있다.' };
  if ((f.arrows || []).length >= MAX_ARROWS) return { ok: false, msg: `화살표는 전선당 최대 ${MAX_ARROWS}개다.` };
  const P = G.provs;
  if (!path.every(id => P[id] && P[id].land && P[id].controller === f.enemy)) return { ok: false, msg: '화살표는 적이 지배하는 지역으로만 그릴 수 있다.' };
  if (!P[path[0]].adj.some(n => f.border.includes(n))) return { ok: false, msg: '화살표는 전선과 맞닿은 적 지역에서 시작해야 한다.' };
  for (let i = 1; i < path.length; i++) if (!P[path[i]].adj.includes(path[i - 1])) return { ok: false, msg: '화살표 경로가 이어져 있지 않다.' };
  f.arrows = f.arrows || [];
  f.arrows.push({ path: [...path] });
  return { ok: true, msg: `공격 화살표를 추가했다 (${path.length}개 지역).` };
}

// 이미 점령한 지역은 화살표 앞에서 떼어 내고, 끝까지 도달한 화살표는 지운다
function pruneArrows(G, f) {
  f.arrows = (f.arrows || []).filter(ar => {
    while (ar.path.length && G.provs[ar.path[0]].controller !== f.enemy) ar.path.shift();
    return ar.path.length > 0;
  });
}

// 전선 접경: 직접 그린 라인(전진 반영) 또는 시드에서 이어지는 접경 전체
function frontBorder(G, f) {
  const P = G.provs;
  const isBorder = p => p.land && p.controller === f.owner && p.adj.some(n => P[n].land && P[n].controller === f.enemy);

  if (f.line) {
    // 유지되는 지역은 그대로. 전진/후퇴로 새로 생기는 접경은 이웃 수가 많은 순으로 채우되, 라인 길이는 처음 그린 길이의 2배(최소 4)를 넘지 않는다
    const kept = [], added = new Map();
    for (const id of f.line) {
      if (P[id].controller === f.owner && isBorder(P[id])) kept.push(id);
      else for (const q of P[id].adj) if (isBorder(P[q])) added.set(q, (added.get(q) || 0) + 1);
    }
    const next = new Set(kept);
    const cap = f.maxLine || Math.max(4, f.line.length * 2);
    [...added.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).forEach(([q]) => { if (next.size < cap) next.add(q); });
    f.line = [...next];
    return f.line;
  }

  const border = new Set(P.filter(isBorder).map(p => p.id));
  if (!border.size) return [];
  let seed = f.seed;
  if (!border.has(seed)) {            // 시드를 잃었으면 가까운 접경으로 옮긴다 (최대 6걸음)
    const dist = new Map([[seed, 0]]), q = [seed];
    seed = -1;
    while (q.length) {
      const c = q.shift();
      if (border.has(c)) { seed = c; break; }
      if (dist.get(c) >= 6) continue;
      for (const n of P[c].adj) if (!dist.has(n) && P[n].land) { dist.set(n, dist.get(c) + 1); q.push(n); }
    }
    if (seed < 0) return [];
    f.seed = seed;
  }
  const comp = new Set([seed]), q = [seed];
  while (q.length) {
    const c = q.shift();
    for (const n of P[c].adj) {
      if (border.has(n)) { if (!comp.has(n)) { comp.add(n); q.push(n); } }
      else if (P[n].land && P[n].controller === f.owner) {   // 접경이 아닌 내 지역 하나를 건너 이어지는 경우
        for (const m of P[n].adj) if (border.has(m) && !comp.has(m)) { comp.add(m); q.push(m); }
      }
    }
  }
  return [...comp];
}

// 재배치용 경로: 아군(동맹 포함) 지배 지역으로만 이동한다 (적 영토를 가로지르지 않는다)
function friendlyPath(G, from, to, who) {
  const ok = id => { const p = G.provs[id]; return p.land && (p.controller === who || sameFaction(G, who, p.controller)); };
  if (from === to) return [];
  if (!ok(to)) return null;
  const prev = new Map([[from, -1]]), q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    for (const n of G.provs[cur].adj) if (!prev.has(n) && ok(n)) { prev.set(n, cur); q.push(n); }
  }
  if (!prev.has(to)) return null;
  const path = [];
  for (let c = to; c !== from; c = prev.get(c)) path.unshift(c);
  return path;
}

const frontArmies = (G, f) => G.armies.filter(a => a.front === f.id && a.owner === f.owner);

function assignToFront(G, f, armyIds) {
  let n = 0;
  for (const a of G.armies) if (armyIds.has(a.id) && a.owner === f.owner) { a.front = f.id; a.path = []; a.prog = 0; n++; }
  return n;
}

function frontsTick(G) {
  if (!G.fronts.length) return;
  const visCache = new Map();
  for (const f of [...G.fronts]) {
    const c = G.countries[f.owner];
    if (!c.alive || !G.countries[f.enemy].alive || !atWar(G, f.owner, f.enemy)) { dissolveFront(G, f, '전쟁이 끝나 해산되었다.'); continue; }
    f.border = frontBorder(G, f);
    if (!f.border.length) { dissolveFront(G, f, '접경 지역이 없어 해산되었다.'); continue; }
    const before = (f.arrows || []).length;
    pruneArrows(G, f);
    if (before && !f.arrows.length) addLog(G, `${f.name}: 모든 공격 화살표 목표를 달성했다.`, f.owner, 'front', [f.owner]);
    if (f.auto) for (const a of G.armies) if (a.owner === f.owner && !a.front && a.born === G.day) a.front = f.id;
    if (!visCache.has(f.owner)) visCache.set(f.owner, visibleSet(G, f.owner));
    runFront(G, f, visCache.get(f.owner));
  }
}

// 적 부대 병력 (시야 밖은 1.5로 가정)
function foeHp(G, pid, owner, vis) {
  if (!vis.has(pid)) return 1.5;
  return enemiesAt(G, pid, owner).reduce((s, a) => s + armyStr(a), 0);
}

function runFront(G, f, vis) {
  const P = G.provs, owner = f.owner, border = new Set(f.border);
  const armies = frontArmies(G, f);
  if (!armies.length) return;

  // 공격 화살표의 현재 목표 (각 화살표의 첫 번째 적 지역)
  const targets = new Set((f.arrows || []).map(ar => ar.path[0]));
  const aggressive = f.mode === 'attack';

  // 접경별 정보: 위협(인접 적 병력 최댓값), 약한 정도(인접 적 병력 최솟값), 현재 배치량, 침투한 적 병력, 화살표 목표와의 인접 수
  const threat = new Map(), weak = new Map(), cov = new Map(), inside = new Map(), pull = new Map();
  for (const b of border) {
    inside.set(b, enemiesAt(G, b, owner).reduce((s, a) => s + armyStr(a), 0));
    let mx = 0, mn = Infinity, pl = 0;
    for (const n of P[b].adj) if (P[n].land && P[n].controller === f.enemy) {
      const h = foeHp(G, n, owner, vis);
      mx = Math.max(mx, h); mn = Math.min(mn, h);
      if (targets.has(n)) pl++;
    }
    threat.set(b, mx); weak.set(b, mn); cov.set(b, 0); pull.set(b, pl);
  }
  for (const a of armies) {
    const dest = a.path.length ? a.path[a.path.length - 1] : a.prov;
    if (cov.has(dest)) cov.set(dest, cov.get(dest) + armyStr(a));
  }

  // 한 지역에 모인 대기 중인 사단들은 합산 전력으로 함께 움직인다
  const idle = new Map();
  for (const a of armies) {
    if (a.path.length || enemiesAt(G, a.prov, owner).length) continue; // 이동 중이거나 교전 중이면 그대로 둔다
    if (!idle.has(a.prov)) idle.set(a.prov, []);
    idle.get(a.prov).push(a);
  }

  const need = b => aggressive
    ? cov.get(b) + Math.min(weak.get(b), 4) * 0.8 - inside.get(b) * 1.2 - pull.get(b) * 3
    : (cov.get(b) - inside.get(b) * 1.5) / (1 + threat.get(b));

  for (const [pid, list] of idle) {
    // 접경에서 진격. 공격 화살표가 있으면 화살표 목표만, 없으면 이길 수 있는 인접 적 지역으로.
    // 방어 모드는 국지 우세일 때 적 부대만 역공한다
    if (border.has(pid)) {
      const ready = list.filter(a => a.org >= 0.4 && isSupplied(G, a));
      const readyHp = ready.reduce((s, a) => s + armyStr(a), 0);
      if (ready.length) {
        let best = null, bs = Infinity;
        for (const n of P[pid].adj) {
          if (!P[n].land || P[n].controller !== f.enemy || G.supply[owner][n] > SUPPLY_RANGE + 1) continue;
          if (aggressive && targets.size && !targets.has(n)) continue;
          const h = foeHp(G, n, owner, vis);
          if (aggressive ? h > readyHp * 1.3 + 0.01 : (h < 0.05 || h > readyHp * 0.8)) continue;
          const score = h * 0.5 - (G.countries[f.enemy].capital === n ? 3 : 0);
          if (score < bs) { bs = score; best = n; }
        }
        if (best !== null) {
          for (const a of ready) { a.path = [best]; a.prog = 0; }
          cov.set(pid, cov.get(pid) - readyHp);
          continue;
        }
      }
    }

    // 배치: 가장 필요한 접경으로 이동 (공격은 화살표·약한 곳 우선, 방어는 위협 대비 병력이 모자란 곳 우선)
    for (const a of list) {
      const here = border.has(a.prov);
      let best = null, bs = Infinity, bestPath = null;
      for (const b of border) {
        const path = friendlyPath(G, a.prov, b, owner);
        if (path === null) continue;
        const s = need(b) + path.length * (aggressive ? 0.4 : 0.25);
        if (s < bs) { bs = s; best = b; bestPath = path; }
      }
      if (best === null || best === a.prov) continue;
      if (here && need(a.prov) - bs < 1.2) continue; // 이미 충분히 균형이면 이동하지 않는다
      if (cov.has(a.prov)) cov.set(a.prov, cov.get(a.prov) - armyStr(a));
      cov.set(best, cov.get(best) + armyStr(a));
      a.path = bestPath; a.prog = 0;
    }
  }
}
