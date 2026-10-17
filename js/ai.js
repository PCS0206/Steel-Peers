'use strict';
// AI 국가: 생산 → (주기적) 외교 → 유휴 사단에 목표 부여. AI는 안개의 영향을 받지 않는다.

function aiTick(G, c) {
  while (c.queue.length < 3) c.queue.push({ type: aiLineType(G, c), progress: 0 });
  mergeIdle(G, c.id);
  if ((G.day + c.id * 3) % 10 === 0) aiDiplomacy(G, c);
  for (const a of G.armies) if (a.owner === c.id && !a.path.length) aiOrder(G, c, a);
}

// 보병 2 : 기갑 1 비율, 영토에 산지가 많으면 기갑 대신 산악보병
function aiLineType(G, c) {
  if (c.queue.length % 3 !== 2) return 'inf';
  const own = G.provs.filter(p => p.owner === c.id);
  const rough = own.filter(p => p.terrain === 'mountain' || p.terrain === 'hills').length / own.length;
  return rough > 0.3 ? 'mtn' : 'arm';
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
    if (G.day < 40 || G.rnd() > 0.18) return;
    const mine = strength(G, c.id);
    const cands = neighborsOf(G, c.id)
      .filter(o => (G.truces[warKey(c.id, o)] || 0) <= G.day && !sameFaction(G, c.id, o) && !(o === G.player && G.day < 75))
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
      const eHp = enemiesAt(G, cur, c.id).reduce((s, x) => s + x.hp, 0);
      const enemyLand = p.controller >= 0 && atWar(G, c.id, p.controller);
      if ((enemyLand || eHp > 0) && eHp <= army.hp * 1.3 && sup[cur] <= SUPPLY_RANGE + 1) {
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
