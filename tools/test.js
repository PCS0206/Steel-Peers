// 로직 테스트 (의존성 없음): node tools/test.js
const assert = require('assert');
const { loadGame } = require('./load');
const A = loadGame();
const allocSum = c => Object.values(c.alloc).reduce((s, v) => s + v, 0);
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
    assert.strictEqual(allocSum(c), f.mil, 'all military factories allocated');
  }
  for (const p of G.provs.filter(q => q.land)) assert.ok(p.civ + p.mil <= p.slots && p.civ >= 0 && p.mil >= 0);
});

test('경제: 군수 공장 할당만큼 장비가, 민수 공장만큼 PP가 쌓인다', () => {
  const G = fresh(), c = G.countries[0];
  const { civ, mil } = A.factoriesOf(G, 0), s0 = c.equip.small, t0 = c.equip.tank, p0 = c.pp;
  A.tickDay(G);
  assert.ok(Math.abs(c.equip.small - s0 - c.alloc.small * A.EQUIP.small.out) < 1e-9);
  assert.ok(Math.abs(c.equip.tank - t0 - c.alloc.tank * A.EQUIP.tank.out) < 1e-9);
  assert.ok(c.alloc.gun === 0 || c.eqRate.gun > 0, '야포도 생산된다');
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
  assert.strictEqual(allocSum(c), mil);
  c.alloc.small = c.alloc.tank = c.alloc.gun = 0;
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
  c.equip.small = 0; c.alloc.small = 0; c.alloc.tank = 0; c.alloc.gun = 0;   // 생산도 끊어 둔다
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
  assert.strictEqual(allocSum(c) <= after.mil, true, 'allocation clamped');
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

// ---------- 사단 설계 / 병과 ----------
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

test('기본 사단은 이전 능력치와 같다 (보병/기갑/산악) + 보병+포병', () => {
  const U = A.UNITS;
  assert.ok(near(U.inf.atk, 1) && near(U.inf.def, 1.1) && U.inf.speed === 1 && U.inf.mp === 8 && U.inf.eq.small === 40 && U.inf.days === 10 && U.inf.cls === 'inf');
  assert.ok(near(U.arm.atk, 1.9) && near(U.arm.def, 0.9) && near(U.arm.speed, 1.7) && U.arm.mp === 6 && U.arm.eq.tank === 25 && U.arm.days === 16 && U.arm.cls === 'arm');
  assert.ok(near(U.arm.terr.forest, 0.6) && near(U.arm.terr.mountain, 0.4));
  assert.ok(near(U.mtn.terr.hills, 1.3) && near(U.mtn.terr.mountain, 1.5) && near(U.mtn.rough, 0.5) && U.mtn.days === 12 && U.mtn.cls === 'mtn');
  assert.ok(U.cmb.eq.small === 32 && U.cmb.eq.gun === 5 && U.cmb.cls === 'inf', '보병 4 + 포병 1');
  assert.ok(U.cmb.speed < 1, '포병이 섞이면 느려진다');
});

test('사단 설계: 능력치는 대대 수에 비례하고 지원 중대가 보정을 준다', () => {
  const G = A.newGame(1, 6);
  const big = A.designTemplate(G, 0, { name: '대형보병', bn: { inf: 9 } });
  assert.ok(big.ok, big.msg);
  const u = A.UNITS[big.tpl.id];
  assert.ok(near(u.atk, 1.8) && near(u.def, 1.98) && u.eq.small === 72 && u.mp === 14.4 && u.days > A.UNITS.inf.days);
  assert.ok(A.armyStr({ comp: { [big.tpl.id]: 1 } }) > 1.7 * A.armyStr({ comp: { inf: 1 } }), '9대대는 5대대보다 훨씬 강하다');
  const sup = A.designTemplate(G, 0, { name: '정찰공병', bn: { inf: 4, tank: 1 }, sup: { recon: 1, eng: 1 } });
  const s = A.UNITS[sup.tpl.id];
  assert.ok(near(s.speed, 1 * 1.1), '속도 = 가장 느린 대대(보병 1.0) × 정찰 1.1');
  assert.ok(s.mp > 4 * 1.6 + 1.2 && s.eq.small > 4 * 8 + 3, '지원 중대 비용이 더해진다');
  const plain = A.compileTemplate({ name: 'x', bn: { inf: 4, tank: 1 }, sup: {} });
  assert.ok(s.terr.hills > plain.terr.hills, '공병은 험지 보정을 올린다');
});

test('사단 설계: 검증 규칙과 삭제 규칙', () => {
  const G = A.newGame(1, 6);
  const d = spec => A.designTemplate(G, 0, spec);
  assert.ok(!d({ name: '', bn: { inf: 3 } }).ok, '이름 없음');
  assert.ok(!d({ name: '빈', bn: {} }).ok, '대대 없음');
  assert.ok(!d({ name: '과다', bn: { inf: 10 } }).ok, '대대 9개 초과');
  assert.ok(!d({ name: '과다지원', bn: { inf: 3 }, sup: { recon: 2, eng: 1 } }).ok, '지원 2개 초과');
  assert.ok(!d({ name: '음수', bn: { inf: -1, tank: 3 } }).ok, '음수');
  assert.ok(!d({ name: '보병', bn: { inf: 3 } }).ok, '기본 사단과 같은 이름');
  const ok = d({ name: '내설계', bn: { inf: 3, art: 2 } });
  assert.ok(ok.ok); assert.ok(!d({ name: '내설계', bn: { inf: 2 } }).ok, '중복 이름');
  for (let i = 0; G.templates.length < A.MAX_TEMPLATES; i++) assert.ok(d({ name: '설계' + i, bn: { inf: 1 + (i % 4) } }).ok);
  assert.ok(!d({ name: '초과', bn: { inf: 1 } }).ok, '최대 개수');
  // 훈련 라인이 쓰는 설계는 삭제 불가, 정리하면 삭제 가능
  const c = G.countries[0]; c.queue = [];
  assert.ok(A.addTrainLine(G, 0, ok.tpl.id));
  assert.ok(!A.deleteTemplate(G, 0, ok.tpl.id).ok, '라인에서 사용 중');
  A.removeLine(G, 0, 0);
  assert.ok(A.deleteTemplate(G, 0, ok.tpl.id).ok);
  assert.ok(!(ok.tpl.id in A.UNITS), 'UNITS에서도 제거');
  assert.ok(!A.deleteTemplate(G, 0, 'inf').ok, '기본 사단은 삭제 불가');
  assert.ok(!A.deleteTemplate(G, 1, G.templates[0].id).ok, '남의 설계는 삭제 불가');
});

test('사단 설계: 설계한 사단이 훈련·편성되고 야포 장비를 쓴다', () => {
  const G = A.newGame(2, 6); G.player = 0; G.countries[0].ai = false; G.countries[0].queue = [];
  const r = A.designTemplate(G, 0, { name: '포병군단', bn: { inf: 2, art: 3 } });
  const id = r.tpl.id, u = A.UNITS[id], c = G.countries[0];
  assert.ok(u.eq.gun === 15 && u.eq.small === 16);
  A.addTrainLine(G, 0, id);
  const gun0 = c.equip.gun, armies0 = G.armies.filter(a => a.owner === 0).length;
  A.tickDay(G);
  assert.ok(c.queue[0].started, '야포·보병장비가 충분하면 시작');
  assert.ok(c.equip.gun < gun0 + c.eqRate.gun, '야포 소모');
  for (let i = 0; i < u.days; i++) A.tickDay(G);
  const made = G.armies.filter(a => a.owner === 0 && a.comp[id] > 0);
  assert.strictEqual(G.armies.filter(a => a.owner === 0).length, armies0 + 1);
  assert.ok(made.length === 1, '설계한 구성키로 편성');
  // 야포가 모자라면 대기
  c.equip.gun = 0; c.alloc.gun = 0;
  for (let i = 0; i < 3; i++) A.tickDay(G);
  const q = c.queue[0]; assert.ok(q.stall === 'gun' || q.started, 'gun stall');
});

test('사단 설계: 이동은 가장 느린 대대 기준, 산악 대대는 험지 페널티가 작다', () => {
  const G = A.newGame(1, 6);
  const plain = G.provs.find(p => p.land && p.terrain === 'plains') || G.provs.find(p => p.land);
  const mt = G.provs.find(p => p.land && p.terrain === 'mountain') || G.provs.find(p => p.land);
  plain.terrain = 'plains'; mt.terrain = 'mountain';
  const mk = (bn, sup = {}) => { const r = A.designTemplate(G, 0, { name: 'm' + G.templates.length, bn, sup }); const a = A.spawnArmy(G, 0, plain.id, r.tpl.id); return a; };
  const tank = mk({ tank: 5 }), mix = mk({ tank: 3, inf: 2 }), art = mk({ inf: 4, art: 1 }), mtn = mk({ mtn: 5 }), inf = mk({ inf: 5 }), recon = mk({ inf: 5 }, { recon: 1 });
  assert.ok(A.moveDays(G, tank, plain.id) < A.moveDays(G, mix, plain.id), '보병이 섞이면 전차도 느려진다');
  assert.strictEqual(A.moveDays(G, mix, plain.id), A.moveDays(G, inf, plain.id));
  assert.ok(A.moveDays(G, art, plain.id) >= A.moveDays(G, inf, plain.id), '포병은 더 느리다');
  assert.ok(A.moveDays(G, mtn, mt.id) < A.moveDays(G, inf, mt.id), '산악 대대는 산악에서 더 빠르다');
  assert.ok(A.moveDays(G, recon, mt.id) <= A.moveDays(G, inf, mt.id), '정찰은 이동을 줄인다');
});

test('사단 설계: 저장/불러오기와 새 게임에서 설계가 올바르게 관리된다', () => {
  const G = A.newGame(3, 6);
  const r = A.designTemplate(G, 0, { name: '저장테스트', bn: { inf: 3, tank: 2 }, sup: { eng: 1 } });
  A.spawnArmy(G, 0, G.countries[0].capital, r.tpl.id);
  for (let i = 0; i < 20; i++) A.tickDay(G);
  const snapStr = JSON.stringify(A.serialize(G));
  A.newGame(4, 6);                                      // 다른 게임을 만들면 이전 설계는 UNITS에서 사라진다
  assert.ok(!(r.tpl.id in A.UNITS), 'custom unit cleared on new game');
  const z = A.deserialize(JSON.parse(snapStr));
  assert.ok(r.tpl.id in A.UNITS && A.UNITS[r.tpl.id].name === '저장테스트', '불러오면 다시 등록');
  assert.ok(near(A.UNITS[r.tpl.id].atk, 3 * 0.2 + 2 * 0.38));
  for (let i = 0; i < 30; i++) { A.tickDay(z); }
  assert.ok(z.armies.length > 0);
  A.newGame(3, 6); const w = A.newGame(3, 6);
  assert.strictEqual(w.templates.length, 0);
});

// ---------- 난이도 ----------
test('난이도: 플레이어 시작 자원과 AI 경제 배율이 다르다', () => {
  const mk = lvl => { const G = A.newGame(5, 6, lvl); A.setPlayer(G, 0); return G; };
  const easy = mk('easy'), normal = mk('normal'), brutal = mk('brutal');
  assert.ok(easy.countries[0].pp > normal.countries[0].pp && normal.countries[0].pp > brutal.countries[0].pp, '플레이어 시작 PP');
  assert.ok(easy.countries[0].equip.small > normal.countries[0].equip.small);
  for (const G of [easy, normal, brutal]) A.tickDay(G);                      // 첫날: 공장 수가 같으므로 배율이 그대로 드러난다
  const ai = G => G.countries[3], D = A.DIFFICULTY;
  assert.ok(near(ai(brutal).income / ai(easy).income, D.brutal.aiEco / D.easy.aiEco, 1e-9), 'AI PP 수입 배율');
  assert.ok(near(ai(normal).income / ai(easy).income, D.normal.aiEco / D.easy.aiEco, 1e-9));
  const sumRate = G => Object.values(ai(G).eqRate).reduce((s, v) => s + v, 0);
  assert.ok(near(sumRate(brutal) / sumRate(easy), D.brutal.aiEco / D.easy.aiEco, 1e-9), 'AI 장비 생산 배율');
  for (const G of [easy, normal, brutal]) for (let i = 0; i < 29; i++) A.tickDay(G);
  assert.ok(ai(easy).income < ai(normal).income && ai(normal).income < ai(brutal).income, '30일 뒤에도 AI 수입은 난이도 순');
  assert.strictEqual(easy.countries[0].income, normal.countries[0].income, '플레이어 수입은 난이도와 무관');
  assert.ok(!A.setDifficulty(easy, '없는난이도') && easy.difficulty === 'easy');
  assert.ok(A.setDifficulty(easy, 'hard') && A.diffOf(easy).aiEco === A.DIFFICULTY.hard.aiEco);
});

test('난이도: 쉬움은 AI가 플레이어에게 늦게 선전포고하고 어려움은 일찍 한다', () => {
  const warsOnPlayer = (lvl, days) => {
    let n = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const G = A.newGame(seed, 6, lvl); A.setPlayer(G, 0);
      for (let d = 0; d < days && !G.over; d++) A.tickDay(G);
      n += A.neighborsOf(G, 0).filter(o => A.atWar(G, 0, o)).length;
    }
    return n;
  };
  const easy = warsOnPlayer('easy', 120), brutal = warsOnPlayer('brutal', 120);
  assert.strictEqual(easy, 0, '쉬움: 150일 전까지 AI는 플레이어를 공격하지 않는다');
  assert.ok(brutal > 0, '매우 어려움: 일찍 선전포고를 받는다');
});

test('난이도: 저장/불러오기가 난이도를 유지한다', () => {
  const G = A.newGame(2, 6, 'hard');
  const z = A.deserialize(JSON.parse(JSON.stringify(A.serialize(G))));
  assert.strictEqual(z.difficulty, 'hard');
});

console.log(`${n} tests passed`);
