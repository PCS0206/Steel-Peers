'use strict';
// AI 국가: 생산 → (주기적) 외교 → 유휴 사단에 목표 부여

function aiTick(G, c) {
  while (c.queue.length < 3) c.queue.push({ progress: 0 });
  mergeIdle(G, c.id);
  if ((G.day + c.id * 3) % 10 === 0) aiDiplomacy(G, c);
  for (const a of G.armies) if (a.owner === c.id && !a.path.length) aiOrder(G, c, a);
}

function mergeIdle(G, owner) {
  const base = new Map();
  G.armies = G.armies.filter(a => {
    if (a.owner !== owner || a.path.length) return true;
    const b = base.get(a.prov);
    if (!b) { base.set(a.prov, a); return true; }
    b.hp += a.hp;
    return false;
  });
}

function aiDiplomacy(G, c) {
  const wars = warsOf(G, c.id);
  if (!wars.length) {
    if (G.day < 40 || G.rnd() > 0.18) return;
    const mine = strength(G, c.id);
    const cands = neighborsOf(G, c.id)
      .filter(o => (G.truces[warKey(c.id, o)] || 0) <= G.day && !(o === G.player && G.day < 75))
      .map(o => ({ o, s: strength(G, o) }))
      .filter(x => x.s < mine * 1.05)
      .sort((a, b) => a.s - b.s);
    if (cands.length) declareWar(G, c.id, cands[0].o);
    return;
  }
  for (const o of wars) {
    if (o === G.player) continue; // 플레이어와의 강화는 플레이어가 제안
    if (G.day - G.wars[warKey(c.id, o)] > 40 && G.rnd() < 0.12 && (strength(G, c.id) < strength(G, o) * 0.9 || G.rnd() < 0.3))
      makePeace(G, c.id, o);
  }
}

// 가장 가까운 공격/방어 목표를 BFS로 찾아 이동 명령
function aiOrder(G, c, army) {
  if (!warsOf(G, c.id).length || enemiesAt(G, army.prov, c.id).length) return;
  const dist = new Map([[army.prov, 0]]), prev = new Map(), q = [army.prov];
  let best = null, bestScore = Infinity;
  while (q.length) {
    const cur = q.shift(), d = dist.get(cur);
    if (cur !== army.prov) {
      const p = G.provs[cur];
      const eHp = enemiesAt(G, cur, c.id).reduce((s, x) => s + x.hp, 0);
      const enemyLand = p.owner >= 0 && atWar(G, c.id, p.owner);
      if ((enemyLand || eHp > 0) && eHp <= army.hp * 1.3) {
        const score = d - (p.id === (G.countries[p.owner] || {}).capital ? 3 : 0) + eHp * 0.5;
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
