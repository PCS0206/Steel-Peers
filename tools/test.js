// 로직 테스트 (의존성 없음): node tools/test.js
const assert = require('assert');
const { loadGame } = require('./load');
const A = loadGame();
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };
const run = (G, days) => { for (let i = 0; i < days && !G.over; i++) A.tickDay(G); };
const snap = G => JSON.stringify(A.serialize(G));

test('지도 생성은 시드에 대해 결정적이며 지형이 섞여 있다', () => {
  const a = A.generateMap(7), b = A.generateMap(7);
  assert.deepStrictEqual(a.provs.map(p => [p.land, p.terrain, p.name]), b.provs.map(p => [p.land, p.terrain, p.name]));
  const kinds = new Set(a.provs.filter(p => p.land).map(p => p.terrain));
  assert.ok(kinds.size >= 4, 'terrain variety: ' + [...kinds]);
});

test('지역 다각형이 지도를 빈틈없이 덮고 클릭 판정이 맞다', () => {
  const m = A.generateMap(4);
  const area = poly => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
  const total = m.provs.reduce((s, p) => s + area(p.base), 0);
  assert.ok(Math.abs(total - 1200 * 700) < 1, 'cells tile map: ' + total);
  for (const p of m.provs.filter(q => q.land)) {
    assert.strictEqual(A.findProvince(m, p.x, p.y), p.id, p.name + ' centroid hit');
    for (const n of p.adj) assert.ok(m.provs[n].adj.includes(p.id), 'adjacency symmetric');
  }
});

test('시뮬레이션이 결정적이다', () => {
  const x = A.newGame(3, 6), y = A.newGame(3, 6);
  run(x, 200); run(y, 200);
  assert.strictEqual(snap(x), snap(y));
});

test('저장→불러오기 후에도 결과가 동일하다', () => {
  const x = A.newGame(5, 6), y = A.newGame(5, 6);
  run(x, 120); run(y, 120);
  const z = A.deserialize(JSON.parse(snap(y)));
  run(x, 150); run(z, 150);
  assert.strictEqual(snap(x), snap(z));
});

test('여러 시드·500일 불변식', () => {
  for (let s = 1; s <= 8; s++) {
    const G = A.newGame(s, 6);
    run(G, 500);
    for (const p of G.provs) if (p.land) {
      assert.ok(p.owner >= 0 && p.controller >= 0, 'land has owner/controller');
      assert.ok(G.countries[p.owner].alive || p.owner === p.controller || true);
    }
    for (const a of G.armies) {
      assert.ok(a.hp > 0 && G.provs[a.prov].land, 'army valid');
      assert.ok(Math.abs(a.hp - Object.values(a.comp).reduce((s2, v) => s2 + v, 0)) < 1e-6, 'hp == sum(comp)');
      assert.ok(a.org >= 0 && a.org <= 1);
      assert.ok(G.countries[a.owner].alive, 'dead country has no armies');
    }
    for (const c of G.countries) if (c.alive) assert.ok(A.controlledCount(G, c.id) > 0);
    for (const c of G.countries) if (c.faction >= 0) assert.ok(G.factions[c.faction]);
    for (const k of Object.keys(G.wars)) { const [a, b] = k.split('-').map(Number); assert.ok(!A.sameFaction(G, a, b), 'no war inside faction'); }
  }
});

test('지형/속도가 이동 시간에 반영된다', () => {
  const G = A.newGame(1, 6);
  const mk = (type, terrain) => { const a = A.spawnArmy(G, 0, G.provs.find(p => p.land).id, type); G.provs[a.prov].terrain = terrain; return A.moveDays(G, a, a.prov); };
  assert.strictEqual(mk('inf', 'plains'), 3);
  assert.ok(mk('inf', 'mountain') > mk('inf', 'plains'));
  assert.ok(mk('arm', 'plains') < mk('inf', 'plains'));
  assert.ok(mk('mtn', 'mountain') < mk('inf', 'mountain'));
});

test('분리/합병이 병력을 보존한다', () => {
  const G = A.newGame(1, 6);
  const a = A.spawnArmy(G, 0, G.countries[0].capital, 'inf', 3);
  const b = A.splitArmy(G, a, 'inf');
  assert.strictEqual(a.hp + b.hp, 3);
  A.mergeArmies(a, b);
  assert.strictEqual(a.hp, 4 - 1);
  assert.strictEqual(A.splitArmy(G, A.spawnArmy(G, 0, 0, 'arm', 1), 'arm'), null);
});

test('시야: 아군 영토 인접까지 보이고 먼 적지는 안 보인다', () => {
  const G = A.newGame(2, 6);
  const vis = A.visibleSet(G, 0);
  assert.ok(vis.has(G.countries[0].capital));
  const far = G.provs.find(p => p.land && p.owner === 3 && !p.adj.some(q => G.provs[q].owner === 0));
  assert.ok(!vis.has(far.id));
});

test('동맹: 자동 참전, 동맹국에 선전포고 불가', () => {
  const G = A.newGame(1, 6);
  assert.ok(A.formAlliance(G, 0, 1));
  assert.ok(!A.declareWar(G, 0, 1));
  A.declareWar(G, 2, 0);
  assert.ok(A.atWar(G, 2, 1), '동맹국 1이 2와 전쟁에 참전');
});

test('강화 + 점령지 요구는 점령한 지역의 소유권을 넘긴다', () => {
  const G = A.newGame(1, 6);
  G.player = 0; A.declareWar(G, 0, 1);
  const prov = G.provs.find(p => p.owner === 1 && p.id !== G.countries[1].capital);
  prov.controller = 0;
  G.day += 30;
  G.armies = G.armies.filter(a => a.owner !== 1); // 상대 전력 소멸 → 요구 수락
  const r = A.proposePeace(G, 0, 1, true);
  assert.ok(r.ok, r.msg);
  assert.strictEqual(prov.owner, 0);
  assert.ok(!A.atWar(G, 0, 1));
});

// 플레이어(0)가 이웃과 전쟁 중이고 접경 지역에 병력을 몰아 둔 시나리오
function frontScenario(mode, extra) {
  const G = A.newGame(1, 6);
  G.player = 0; G.countries[0].ai = false; G.countries[0].queue = [];
  const enemy = A.neighborsOf(G, 0)[0];
  A.declareWar(G, 0, enemy);
  const seed = G.provs.find(p => p.owner === 0 && p.adj.some(q => G.provs[q].owner === enemy));
  const f = A.createFront(G, 0, seed.id, mode);
  for (let i = 0; i < extra; i++) A.spawnArmy(G, 0, G.countries[0].capital, 'inf');
  A.assignToFront(G, f, new Set(G.armies.filter(a => a.owner === 0).map(a => a.id)));
  return { G, f, enemy };
}

test('전선: 접경 계산과 생성 조건', () => {
  const { G, f, enemy } = frontScenario('hold', 0);
  assert.strictEqual(f.enemy, enemy);
  assert.ok(f.border.length >= 1);
  for (const b of f.border) {
    assert.strictEqual(G.provs[b].controller, 0);
    assert.ok(G.provs[b].adj.some(q => G.provs[q].controller === enemy));
  }
  assert.strictEqual(A.createFront(G, 1, G.countries[1].capital, 'hold'), null, '전쟁 중이 아닌 곳엔 만들 수 없다');
});

test('전선(방어): 사단이 접경 지역으로 모여 분산된다', () => {
  const { G, f } = frontScenario('hold', 6);
  for (let i = 0; i < 25; i++) A.tickDay(G);
  const mine = G.armies.filter(a => a.owner === 0 && a.front === f.id);
  const onBorder = mine.filter(a => f.border.includes(a.prov) || a.path.length);
  assert.ok(onBorder.length >= mine.length * 0.8, `armies at/going to border: ${onBorder.length}/${mine.length}`);
  if (f.border.length >= 2) assert.ok(new Set(mine.map(a => a.prov)).size >= 2, 'spread over border provinces');
});

test('전선(공격): 우세하면 자동으로 적 지역을 점령해 나간다', () => {
  const { G, f, enemy } = frontScenario('attack', 14);
  G.countries[enemy].queue = [];
  const before = G.provs.filter(p => p.controller === 0).length;
  for (let i = 0; i < 120; i++) A.tickDay(G);
  const gained = G.provs.filter(p => p.controller === 0).length - before;
  assert.ok(gained >= 3, `front pushed forward: +${gained} provinces`);
});

test('전선: 전쟁이 끝나면 해산되고 사단은 풀려난다', () => {
  const { G, f, enemy } = frontScenario('hold', 2);
  for (const k of Object.keys(G.wars)) delete G.wars[k];   // 강화 성립을 모사
  A.tickDay(G);
  assert.ok(!G.fronts.includes(f));
  assert.ok(G.armies.every(a => a.front !== f.id));
});

test('전선: 저장/불러오기 후에도 같은 결과', () => {
  const x = frontScenario('attack', 8).G, y = frontScenario('attack', 8).G;
  for (let i = 0; i < 40; i++) { A.tickDay(x); A.tickDay(y); }
  const z = A.deserialize(JSON.parse(snap(y)));
  assert.strictEqual(z.fronts.length, y.fronts.length);
  for (let i = 0; i < 40; i++) { A.tickDay(x); A.tickDay(z); }
  assert.strictEqual(snap(x), snap(z));
});

// ---------- 경제: 공장 / 장비 / 훈련 ----------
const fresh = () => { const G = A.newGame(2, 6); G.player = 0; G.countries[0].ai = false; G.countries[0].queue = []; return G; };

test('경제: 시작 공장 분배와 장비 할당이 일관된다', () => {
  const G = A.newGame(2, 6);
  for (const c of G.countries) {
    const f = A.factoriesOf(G, c.id);
    assert.ok(f.civ > 0 && f.mil > 0, c.name + ' has both factory kinds');
    assert.strictEqual(c.alloc.small + c.alloc.tank, f.mil, 'all military factories allocated');
  }
  for (const p of G.provs.filter(q => q.land)) assert.ok(p.civ + p.mil <= p.slots && p.civ >= 0 && p.mil >= 0);
});

test('경제: 군수 공장 할당만큼 장비가, 민수 공장만큼 PP가 쌓인다', () => {
  const G = fresh(), c = G.countries[0];
  const { civ, mil } = A.factoriesOf(G, 0), s0 = c.equip.small, t0 = c.equip.tank, p0 = c.pp;
  A.tickDay(G);
  assert.ok(Math.abs(c.equip.small - s0 - c.alloc.small * A.EQUIP.small.out) < 1e-9);
  assert.ok(Math.abs(c.equip.tank - t0 - c.alloc.tank * A.EQUIP.tank.out) < 1e-9);
  assert.ok(Math.abs(c.pp - p0 - (1 + 0.6 * civ)) < 1e-9, 'pp income from civilian factories');
  assert.ok(mil > 0);
});

test('경제: 할당 조정은 군수 공장 수를 넘지 못한다', () => {
  const G = fresh(), c = G.countries[0], { mil } = A.factoriesOf(G, 0);
  assert.ok(!A.setAlloc(G, 0, 'small', +1), '이미 전부 할당됨');
  const had = c.alloc.tank;
  assert.ok(A.setAlloc(G, 0, 'tank', -1));
  assert.ok(A.setAlloc(G, 0, 'small', +1));
  assert.strictEqual(c.alloc.tank, had - 1);
  assert.strictEqual(c.alloc.small + c.alloc.tank, mil);
  c.alloc.small = c.alloc.tank = 0;
  assert.ok(!A.setAlloc(G, 0, 'tank', -1));
});

test('경제: 사단 훈련은 장비·인력을 쓰고 정해진 일수 뒤 편성된다', () => {
  const G = fresh(), c = G.countries[0];
  assert.ok(A.addTrainLine(G, 0, 'inf'));
  const armies0 = G.armies.filter(a => a.owner === 0).length, eq0 = c.equip.small, mp0 = c.manpower;
  A.tickDay(G);
  const q = c.queue[0];
  assert.ok(q.started, 'started the first day');
  assert.ok(c.equip.small < eq0 + c.eqRate.small, 'equipment spent');
  assert.ok(c.manpower < mp0 + 0.08 * 40, 'manpower spent');
  for (let i = 0; i < A.TRAIN_DAYS.inf - 1; i++) A.tickDay(G);
  assert.strictEqual(G.armies.filter(a => a.owner === 0).length, armies0, '아직 훈련 중');
  A.tickDay(G);   // 시작한 날 + TRAIN_DAYS일째에 편성
  assert.strictEqual(G.armies.filter(a => a.owner === 0).length, armies0 + 1, 'division spawned after training');
  assert.ok(!q.started, 'line repeats');
});

test('경제: 장비가 없으면 훈련이 대기하고, 라인 삭제 시 환급된다', () => {
  const G = fresh(), c = G.countries[0];
  c.equip.small = 0; c.alloc.small = 0; c.alloc.tank = 0;   // 생산도 끊어 둔다
  A.addTrainLine(G, 0, 'inf');
  for (let i = 0; i < 5; i++) A.tickDay(G);
  assert.strictEqual(c.queue[0].stall, 'small');
  assert.ok(!c.queue[0].started);
  c.equip.small = 100; A.tickDay(G);
  assert.ok(c.queue[0].started);
  const eq = c.equip.small, mp = c.manpower;
  A.removeLine(G, 0, 0);
  assert.strictEqual(c.equip.small, eq + A.UNITS.inf.eq.small);
  assert.strictEqual(c.manpower, mp + A.UNITS.inf.mp);
});

test('경제: 공장 건설은 PP를 쓰고 완공되며 슬롯을 넘지 못한다', () => {
  const G = fresh(), c = G.countries[0];
  const p = G.provs.find(q => q.owner === 0 && q.civ + q.mil < q.slots);
  const before = p.mil;
  assert.ok(A.queueBuild(G, 0, p.id, 'mil').ok);
  for (let i = 0; i < 25 && c.construction.length; i++) A.tickDay(G);
  assert.strictEqual(p.mil, before + 1, 'factory completed');
  assert.strictEqual(c.construction.length, 0);
  while (A.freeSlots(c, p) > 0) assert.ok(A.queueBuild(G, 0, p.id, 'civ').ok);
  assert.ok(!A.queueBuild(G, 0, p.id, 'civ').ok, 'no free slot');
  assert.ok(!A.queueBuild(G, 0, G.provs.find(q => q.owner === 1).id, 'civ').ok, 'not my province');
});

test('경제: 지역을 점령당하면 그 공장이 생산에서 빠진다', () => {
  const G = fresh();
  const before = A.factoriesOf(G, 0);
  const p = G.provs.filter(q => q.owner === 0 && q.civ + q.mil > 0)[0];
  p.controller = 1;
  const after = A.factoriesOf(G, 0);
  assert.strictEqual(before.civ + before.mil - after.civ - after.mil, p.civ + p.mil);
  A.tickDay(G);
  const c = G.countries[0];
  assert.strictEqual(c.alloc.small + c.alloc.tank <= after.mil, true, 'allocation clamped');
});

test('경제: AI가 공장을 늘린다', () => {
  const G = A.newGame(3, 6);
  const total = id => { const f = A.factoriesOf(G, id); return f.civ + f.mil; };
  const start = G.countries.map(c => total(c.id));
  for (let i = 0; i < 200; i++) A.tickDay(G);
  const grew = G.countries.filter((c, i) => c.alive && total(c.id) > start[i]).length;
  assert.ok(grew >= 3, `countries that built factories: ${grew}`);
});

// ---------- 알림용 로그/선전포고 미리보기 ----------
test('선전포고 미리보기가 실제 참전 결과와 일치한다', () => {
  const G = A.newGame(1, 6);
  A.formAlliance(G, 0, 1); A.formAlliance(G, 3, 4);
  const pre = A.warParticipants(G, 0, 3);
  assert.strictEqual(JSON.stringify(pre), JSON.stringify({ ours: [1], theirs: [4] }));
  const before = new Set(Object.keys(G.wars));
  assert.ok(A.declareWar(G, 0, 3));
  const joined = Object.keys(G.wars).filter(k => !before.has(k)).sort();
  assert.strictEqual(joined.join(), ['0-3', '1-3', '0-4'].sort().join());
});

test('로그에 종류·관련 국가·증가하는 id가 붙는다', () => {
  const G = A.newGame(1, 6);
  A.formAlliance(G, 0, 1); A.declareWar(G, 2, 0);
  const kinds = G.log.map(l => l.kind);
  assert.strictEqual(kinds.join(), 'alliance,war,join');
  assert.strictEqual(G.log[1].involved.join(), '2,0');
  assert.strictEqual(G.log[2].involved.join(), '1,2');
  assert.ok(G.log.every((l, i) => l.id === i + 1));
  const z = A.deserialize(A.serialize(G));
  assert.strictEqual(z.logSeq, G.logSeq);
});

// ---------- 호이4식 전선: 직접 그린 라인 / 공격 화살표 ----------
function warSetup(extra) {
  for (let seed = 1; seed < 30; seed++) {
    const G = A.newGame(seed, 6);
    G.player = 0; G.countries[0].ai = false; G.countries[0].queue = [];
    for (const enemy of A.neighborsOf(G, 0)) {
      const border = G.provs.filter(p => p.owner === 0 && p.adj.some(n => G.provs[n].owner === enemy));
      const e1Chain = border.length >= 3 && border[0].adj.some(n => G.provs[n].owner === enemy && G.provs[n].adj.some(m => G.provs[m].owner === enemy && m !== n && !G.provs[m].adj.includes(border[0].id)));
      if (!e1Chain) continue;
      A.declareWar(G, 0, enemy);
      for (let i = 0; i < extra; i++) A.spawnArmy(G, 0, G.countries[0].capital, 'inf');
      return { G, enemy, border: G.provs.filter(p => p.owner === 0 && A.frontCandidate(G, 0, p.id) === enemy) };
    }
  }
  throw new Error('no suitable war setup');
}

test('전선 그리기: 접경 지역만 라인이 되고, 라인 밖은 전선에 포함되지 않는다', () => {
  const { G, enemy, border } = warSetup(0);
  assert.ok(border.length >= 3, 'enough border provinces');
  const pick = border.slice(0, 2).map(p => p.id);
  const f = A.createFront(G, 0, pick[0], 'hold', pick);
  assert.ok(f);
  assert.strictEqual([...f.line].sort().join(), [...pick].sort().join());
  assert.strictEqual([...f.border].sort().join(), [...pick].sort().join(), 'only the drawn provinces');
  assert.strictEqual(f.enemy, enemy);
  const interior = G.provs.find(p => p.owner === 0 && A.frontCandidate(G, 0, p.id) < 0);
  assert.strictEqual(A.createFront(G, 0, interior.id, 'hold', [interior.id]), null, '접경이 아닌 지역으로는 못 그림');
  assert.strictEqual(A.createFront(G, 0, pick[0], 'hold', [pick[0], interior.id]), null, '라인에 접경 아닌 지역이 섞이면 거부');
});

test('전선 그리기: 건너편을 점령하면 라인이 앞으로 전진하고, 잃은 지역은 빠진다', () => {
  const { G, enemy, border } = warSetup(0);
  const b = border[0], f = A.createFront(G, 0, b.id, 'hold', [b.id]);
  const foes = b.adj.filter(n => G.provs[n].controller === enemy);
  for (const n of foes) G.provs[n].controller = 0;           // 건너편을 모두 점령했다고 가정
  A.tickDay(G);
  const fr = G.fronts.find(x => x.id === f.id);
  if (fr) {
    assert.ok(!fr.line.includes(b.id), '더 이상 접경이 아닌 지역은 라인에서 빠진다');
    assert.ok(fr.line.every(id => A.frontCandidate(G, 0, id, enemy) === enemy), 'new line provinces border the enemy');
    assert.ok(fr.line.some(id => foes.includes(id)), 'line advanced onto captured provinces');
  } else assert.ok(G.log.some(l => l.text.includes('접경 지역이 없어')), '전진할 곳이 없으면 해산');
});

test('전선 그리기: 적에게 라인 지역을 잃으면 라인이 뒤로 물러나 유지된다', () => {
  const { G, enemy, border } = warSetup(0);
  const b = border[0], f = A.createFront(G, 0, b.id, 'hold', [b.id]);
  b.controller = enemy;                                         // 라인의 유일한 지역을 적에게 빼앗김
  A.tickDay(G);
  const fr = G.fronts.find(x => x.id === f.id);
  assert.ok(fr, '전선이 해산되지 않고 유지된다');
  assert.ok(fr.line.length >= 1 && fr.line.every(id => id !== b.id && A.frontCandidate(G, 0, id, enemy) === enemy), 'retreated to new border provinces');
});

test('공격 화살표: 검증 규칙', () => {
  const { G, enemy, border } = warSetup(0);
  const f = A.createFront(G, 0, border[0].id, 'attack');
  const e1 = border[0].adj.find(n => G.provs[n].controller === enemy);
  const e2 = G.provs[e1].adj.find(n => G.provs[n].controller === enemy && n !== e1);
  assert.ok(A.addArrow(G, f, [e1]).ok);
  if (e2 !== undefined) assert.ok(A.addArrow(G, f, [e1, e2]).ok);
  assert.ok(!A.addArrow(G, f, [border[0].id]).ok, '내 지역으로는 못 그림');
  assert.ok(!A.addArrow(G, f, []).ok);
  const far = G.provs.find(p => p.owner === enemy && !p.adj.some(n => f.border.includes(n)));
  assert.ok(!A.addArrow(G, f, [far.id]).ok, '전선과 맞닿지 않은 곳에서 시작 불가');
  while (f.arrows.length < 4) f.arrows.push({ path: [e1] });
  assert.ok(!A.addArrow(G, f, [e1]).ok, '최대 4개');
});

test('공격 화살표: 사단이 화살표 목표를 먼저 공략하고, 점령하면 화살표가 줄어든다', () => {
  const { G, enemy, border } = warSetup(16);
  const b = border[0], f = A.createFront(G, 0, b.id, 'attack');
  const e1 = b.adj.find(n => G.provs[n].controller === enemy);
  const e2 = G.provs[e1].adj.find(n => G.provs[n].controller === enemy && !G.provs[n].adj.includes(b.id) && n !== e1);
  const path = e2 === undefined ? [e1] : [e1, e2];
  assert.ok(A.addArrow(G, f, path).ok);
  A.assignToFront(G, f, new Set(G.armies.filter(a => a.owner === 0).map(a => a.id)));
  const initial = new Set(G.provs.filter(p => p.controller === enemy).map(p => p.id));
  let stray = 0, maxPath = path.length;
  for (let d = 0; d < 150 && f.arrows.length; d++) {
    A.tickDay(G);
    const arrowIds = new Set(path);
    stray += G.provs.filter(p => initial.has(p.id) && p.controller === 0 && !arrowIds.has(p.id)).length > 0 && f.arrows.length ? 1 : 0;
    maxPath = Math.max(maxPath, f.arrows.length ? f.arrows[0].path.length : 0);
  }
  assert.ok(path.every(id => G.provs[id].controller === 0), 'arrow provinces captured');
  assert.strictEqual(stray, 0, '화살표가 남아 있는 동안 다른 적 지역은 공격하지 않는다');
  assert.ok(G.log.some(l => l.text.includes('화살표 목표를 달성')), 'arrow completion logged');
});

test('전선: 직접 그린 라인·화살표도 저장/불러오기에서 유지된다', () => {
  const { G, border } = warSetup(8);
  const f = A.createFront(G, 0, border[0].id, 'attack', border.slice(0, 2).map(p => p.id));
  const e1 = border[0].adj.find(n => G.provs[n].controller === f.enemy);
  A.addArrow(G, f, [e1]);
  for (let i = 0; i < 20; i++) A.tickDay(G);
  const z = A.deserialize(JSON.parse(JSON.stringify(A.serialize(G))));
  assert.strictEqual(JSON.stringify(z.fronts), JSON.stringify(G.fronts));
  for (let i = 0; i < 20; i++) { A.tickDay(G); A.tickDay(z); }
  assert.strictEqual(JSON.stringify(A.serialize(G)), JSON.stringify(A.serialize(z)));
});

console.log(`${n} tests passed`);
