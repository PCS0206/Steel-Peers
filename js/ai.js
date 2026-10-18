'use strict';
// AI 국가: 생산 → (주기적) 외교 → 유휴 사단에 목표 부여. AI는 안개의 영향을 받지 않는다.

function aiTick(G, c) {
  aiEconomy(G, c);
  while (c.queue.length < 3) c.queue.push({ type: aiLineType(G, c), progress: 0, started: false });
  mergeIdle(G, c.id);
  if ((G.day + c.id * 3) % 10 === 0) aiDiplomacy(G, c);
  for (const a of G.armies) if (a.owner === c.id && !a.path.length) aiOrder(G, c, a);
}

// 보병 → 보병+포병 → 기갑(영토에 산지가 많으면 산악보병) 순으로 돌아가며 훈련
function aiLineType(G, c) {
  const i = c.queue.length % 3;
  if (i === 0) return 'inf';
  if (i === 1) return 'cmb';
  const own = G.provs.filter(p => p.owner === c.id);
  const rough = own.filter(p => p.terrain === 'mountain' || p.terrain === 'hills').length / own.length;
  return rough > 0.3 ? 'mtn' : 'arm';
}

// 장비 할당: 기본 비율(보병장비 .5 : 전차 .3 : 야포 .2)에 비축이 적은 쪽을 더 반영, 공장 건설은 민수:군수 ≈ 1.2:1
function aiEconomy(G, c) {
  const mil = (c.fac || factoriesOf(G, c.id)).mil, base = { small: 0.5, tank: 0.3, gun: 0.2 };
  const w = {}; let sum = 0;
  for (const k of Object.keys(base)) { w[k] = base[k] / (1 + (c.equip[k] || 0) / 80); sum += w[k]; }
  const alloc = {}; let used = 0;
  const rem = Object.keys(w).map(k => { const x = mil * w[k] / sum; alloc[k] = Math.floor(x); used += alloc[k]; return [k, x - alloc[k]]; }).sort((p, q) => q[1] - p[1]);
  for (let i = 0; used < mil; i++, used++) alloc[rem[i % rem.length][0]]++;
  c.alloc = alloc;

  if (c.construction.length < 2 && c.pp >= FACTORY_COST * 0.5) {
    const spots = G.provs.filter(p => p.land && p.owner === c.id && p.controller === c.id && freeSlots(c, p) > 0)
      .sort((x, y) => y.industry - x.industry);
    if (spots.length) queueBuild(G, c.id, spots[0].id, c.fac.civ < c.fac.mil * 1.2 ? 'civ' : 'mil');
  }
}

function mergeIdle(G, owner) {
  const base = new Map();
  G.armies = G.armies.filter(a => {
    if (a.owner !== owner || a.path.length) return true;
    const b = base.get(a.prov);
    if (!b) { base.set(a.prov, a); return true; }
    mergeArmies(b, a);
    return false;
  });
}

function aiDiplomacy(G, c) {
  const wars = warsOf(G, c.id);
  // 동맹: 전쟁 중이 아니라면 공동의 적이 있는 나라, 없으면 가끔 이웃과
  if (G.rnd() < 0.1) {
    const cands = G.countries.filter(o => o.alive && o.id !== c.id && o.id !== G.player && canJoin(G, c.id, o.id));
    const pick = cands.find(o => hasCommonEnemy(G, c.id, o.id)) || (G.rnd() < 0.15 ? cands[Math.floor(G.rnd() * cands.length)] : null);
    if (pick) formAlliance(G, c.id, pick.id);
  }
  if (!wars.length) {
    if (G.day < 40 || G.rnd() > Math.min(0.9, 0.18 * diffOf(G).warProb)) return;
    const mine = strength(G, c.id);
    const cands = neighborsOf(G, c.id)
      .filter(o => (G.truces[warKey(c.id, o)] || 0) <= G.day && !sameFaction(G, c.id, o) && !(o === G.player && G.day < diffOf(G).warDay))
      .map(o => ({ o, s: strength(G, o) }))
      .filter(x => x.s < mine * 1.05)
      .sort((a, b) => a.s - b.s);
    if (cands.length) declareWar(G, c.id, cands[0].o);
    return;
  }
  for (const o of wars) {
    if (o === G.player) continue; // 플레이어와의 강화는 플레이어가 제안
    if (G.day - G.wars[warKey(c.id, o)] > 40 && G.rnd() < 0.12 && (strength(G, c.id) < strength(G, o) * 0.9 || G.rnd() < 0.3))
      aiPeace(G, c.id, o);
  }
}

// 가장 가까운 공격/방어 목표를 BFS로 찾아 이동 명령 (보급 범위를 벗어나는 곳은 제외)
function aiOrder(G, c, army) {
  if (!warsOf(G, c.id).length || enemiesAt(G, army.prov, c.id).length) return;
  const sup = G.supply[c.id];
  const dist = new Map([[army.prov, 0]]), prev = new Map(), q = [army.prov];
  let best = null, bestScore = Infinity;
  while (q.length) {
    const cur = q.shift(), d = dist.get(cur);
    if (cur !== army.prov) {
      const p = G.provs[cur];
      const eHp = enemiesAt(G, cur, c.id).reduce((s, x) => s + armyStr(x), 0);
      const enemyLand = p.controller >= 0 && atWar(G, c.id, p.controller);
      if ((enemyLand || eHp > 0) && eHp <= armyStr(army) * 1.3 && sup[cur] <= SUPPLY_RANGE + 1) {
        const capital = [p.owner, p.controller].some(o => o >= 0 && atWar(G, c.id, o) && G.countries[o].capital === p.id);
        const score = d - (capital ? 3 : 0) + eHp * 0.5;
        if (score < bestScore) { bestScore = score; best = cur; }
      }
    }
    for (const n of G.provs[cur].adj) if (!dist.has(n) && enterable(G, c.id, n)) { dist.set(n, d + 1); prev.set(n, cur); q.push(n); }
  }
  if (best === null) return;
  const path = [];
  for (let x = best; x !== army.prov; x = prev.get(x)) path.unshift(x);
  army.path = path; army.prog = 0;
}
