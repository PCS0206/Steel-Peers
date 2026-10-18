'use strict';
// 전선: 적과 맞닿은 내 지역(접경)을 자동 계산하고, 전선에 배치된 사단을 자동으로 움직인다.
//  - 방어(hold): 접경 지역에 병력을 위협에 비례해 분산 배치
//  - 공격(attack): 접경에 집결한 뒤 이길 수 있는 적 지역으로 자동 진격, 점령하면 전선이 따라 전진
// 전선 AI는 플레이어와 같은 시야 정보(안개)만 사용한다.

const MAX_FRONTS = 6;

function createFront(G, owner, seed, mode = 'attack') {
  const p = G.provs[seed];
  if (!p || !p.land || p.controller !== owner) return null;
  if (G.fronts.filter(f => f.owner === owner).length >= MAX_FRONTS) return null;
  const cnt = new Map();
  for (const n of p.adj) { const c = G.provs[n].controller; if (c >= 0 && atWar(G, owner, c)) cnt.set(c, (cnt.get(c) || 0) + 1); }
  if (!cnt.size) return null;
  const enemy = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const f = { id: G.nextFront++, owner, enemy, seed, mode, auto: false, name: `${G.countries[enemy].name} 전선`, border: [] };
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

// 적(f.enemy) 지배지와 맞닿은 내 지배지 중, 시드에서 이어지는 한 덩어리
function frontBorder(G, f) {
  const P = G.provs;
  const isBorder = p => p.land && p.controller === f.owner && p.adj.some(n => P[n].land && P[n].controller === f.enemy);
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
    if (f.auto) for (const a of G.armies) if (a.owner === f.owner && !a.front && a.born === G.day) a.front = f.id;
    if (!visCache.has(f.owner)) visCache.set(f.owner, visibleSet(G, f.owner));
    runFront(G, f, visCache.get(f.owner));
  }
}

// 적 부대 병력 (시야 밖은 1.5로 가정)
function foeHp(G, pid, owner, vis) {
  if (!vis.has(pid)) return 1.5;
  return enemiesAt(G, pid, owner).reduce((s, a) => s + a.hp, 0);
}

function runFront(G, f, vis) {
  const P = G.provs, owner = f.owner, border = new Set(f.border);
  const armies = frontArmies(G, f);
  if (!armies.length) return;

  // 접경별 정보: 위협(인접 적 병력 최댓값), 약한 정도(인접 적 병력 최솟값), 현재 배치량, 침투한 적 병력
  const threat = new Map(), weak = new Map(), cov = new Map(), inside = new Map();
  for (const b of border) {
    inside.set(b, enemiesAt(G, b, owner).reduce((s, a) => s + a.hp, 0));
    let mx = 0, mn = Infinity;
    for (const n of P[b].adj) if (P[n].land && P[n].controller === f.enemy) { const h = foeHp(G, n, owner, vis); mx = Math.max(mx, h); mn = Math.min(mn, h); }
    threat.set(b, mx); weak.set(b, mn); cov.set(b, 0);
  }
  for (const a of armies) {
    const dest = a.path.length ? a.path[a.path.length - 1] : a.prov;
    if (cov.has(dest)) cov.set(dest, cov.get(dest) + a.hp);
  }

  for (const a of armies) {
    if (a.path.length || enemiesAt(G, a.prov, owner).length) continue; // 이동 중이거나 교전 중이면 그대로 둔다
    const here = border.has(a.prov);

    // 접경에서 이길 수 있는 인접 적 지역으로 진격. 방어 모드는 국지 우세일 때 적 부대만 역공한다
    const aggressive = f.mode === 'attack';
    if (here && a.org >= 0.4 && isSupplied(G, a)) {
      let best = null, bs = Infinity;
      for (const n of P[a.prov].adj) {
        if (!P[n].land || P[n].controller !== f.enemy || G.supply[owner][n] > SUPPLY_RANGE + 1) continue;
        const h = foeHp(G, n, owner, vis);
        if (aggressive ? h > a.hp * 1.3 + 0.01 : (h < 0.05 || h > a.hp * 0.8)) continue;
        const score = h * 0.5 - (G.countries[f.enemy].capital === n ? 3 : 0);
        if (score < bs) { bs = score; best = n; }
      }
      if (best !== null) { a.path = [best]; a.prog = 0; cov.set(a.prov, cov.get(a.prov) - a.hp); continue; }
    }

    // 배치: 가장 필요한 접경으로 이동 (공격은 약한 곳 우선, 방어는 위협 대비 병력이 모자란 곳 우선)
    const need = b => f.mode === 'attack'
      ? cov.get(b) + Math.min(weak.get(b), 4) * 0.8 - inside.get(b) * 1.2
      : (cov.get(b) - inside.get(b) * 1.5) / (1 + threat.get(b));
    let best = null, bs = Infinity, bestPath = null;
    for (const b of border) {
      const path = b === a.prov ? [] : findPath(G, a.prov, b, owner);
      if (path === null) continue;
      const s = need(b) + path.length * (f.mode === 'attack' ? 0.4 : 0.25);
      if (s < bs) { bs = s; best = b; bestPath = path; }
    }
    if (best === null || best === a.prov) continue;
    if (here && need(a.prov) - bs < 1.2) continue; // 이미 충분히 균형이면 이동하지 않는다
    if (cov.has(a.prov)) cov.set(a.prov, cov.get(a.prov) - a.hp);
    cov.set(best, cov.get(best) + a.hp);
    a.path = bestPath; a.prog = 0;
  }
}
