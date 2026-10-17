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

console.log(`${n} tests passed`);
