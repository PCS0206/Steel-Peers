'use strict';
// 사단 설계(호이4식): 전투 대대와 지원 중대를 조합해 사단 템플릿을 만들고 능력치·비용을 계산한다.
// 컴파일된 템플릿은 UNITS[id]에 등록되어 전투·이동·훈련 코드가 그대로 쓴다.

const MAX_BN = 9;          // 사단당 전투 대대 수
const MAX_SUP = 2;         // 사단당 지원 중대 수
const MAX_TEMPLATES = 8;   // 국가당 직접 설계한 사단 수
const TERRAINS = ['forest', 'hills', 'mountain', 'marsh'];

// 대대: atk/def=공격·방어, speed=속도, mp=인력(천 명), eq=장비, t=훈련 일수 기여, terr=지형별 보정, rough=험지 이동 페널티 반영 비율, cls=병과
const BN = {
  inf:  { name: '보병',     atk: 0.2,  def: 0.22, speed: 1,   mp: 1.6, eq: { small: 8 }, t: 1.2, terr: {}, rough: 1, cls: 'inf' },
  mtn:  { name: '산악보병', atk: 0.2,  def: 0.22, speed: 1,   mp: 1.6, eq: { small: 8 }, t: 1.6, terr: { hills: 1.3, mountain: 1.5 }, rough: 0.5, cls: 'mtn' },
  tank: { name: '전차',     atk: 0.38, def: 0.18, speed: 1.7, mp: 1.2, eq: { tank: 5 },  t: 2.4, terr: { forest: 0.6, hills: 0.7, mountain: 0.4, marsh: 0.5 }, rough: 1, cls: 'arm' },
  art:  { name: '포병',     atk: 0.34, def: 0.06, speed: 0.9, mp: 1.2, eq: { gun: 5 },   t: 1.6, terr: { hills: 0.9, mountain: 0.75, marsh: 0.8 }, rough: 1, cls: 'art' },
};
// 지원 중대: 능력치는 거의 없지만 사단 전체에 보정을 준다
const SUPPORT = {
  recon: { name: '정찰', mp: 0.4, eq: { small: 2 }, t: 0.4, desc: '이동 속도 +10%' },
  eng:   { name: '공병', mp: 0.4, eq: { small: 2 }, t: 0.4, desc: '험지(숲·구릉·산악·늪) 공격·방어 +8%' },
};
const CLS_NAME = { inf: '보병', arm: '기갑', mtn: '산악', art: '포병' };

// 기본 제공 사단 (모든 국가가 쓸 수 있다). id는 기존 부대 구성 키와 같다
const PRESETS = [
  { id: 'inf', name: '보병', bn: { inf: 5 }, sup: {} },
  { id: 'arm', name: '기갑', bn: { tank: 5 }, sup: {} },
  { id: 'mtn', name: '산악보병', bn: { mtn: 5 }, sup: {} },
  { id: 'cmb', name: '보병+포병', bn: { inf: 4, art: 1 }, sup: {} },
];

const UNITS = {};

function compileTemplate(tpl) {
  let atk = 0, def = 0, mp = 0, t = 4, speed = Infinity, nbn = 0, rough = 0;
  const eq = {}, clsCount = {}, terrW = {};
  for (const [k, c] of Object.entries(tpl.bn)) {
    if (!c) continue;
    const b = BN[k];
    nbn += c; atk += b.atk * c; def += b.def * c; mp += b.mp * c; t += b.t * c; rough += b.rough * c;
    speed = Math.min(speed, b.speed);
    for (const [e, v] of Object.entries(b.eq)) eq[e] = (eq[e] || 0) + v * c;
    clsCount[b.cls] = (clsCount[b.cls] || 0) + c;
    for (const ter of TERRAINS) terrW[ter] = (terrW[ter] || 0) + b.atk * c * (b.terr[ter] ?? 1);
  }
  if (!nbn) { speed = 1; }
  let mul = 1, speedMul = 1;
  for (const [k, c] of Object.entries(tpl.sup || {})) {
    if (!c) continue;
    const s = SUPPORT[k];
    mp += s.mp * c; t += s.t * c;
    for (const [e, v] of Object.entries(s.eq)) eq[e] = (eq[e] || 0) + v * c;
    if (k === 'recon') speedMul *= 1.1 ** c;
    if (k === 'eng') mul *= 1.08 ** c;
  }
  const terr = {};
  for (const ter of TERRAINS) terr[ter] = atk > 0 ? (terrW[ter] / atk) * mul : 1;
  // 주 병과: 대대 수가 가장 많은 병과 (동률이면 기갑 > 산악 > 포병 > 보병)
  const prio = ['arm', 'mtn', 'art', 'inf'];
  const cls = prio.slice().sort((x, y) => (clsCount[y] || 0) - (clsCount[x] || 0) || prio.indexOf(x) - prio.indexOf(y))[0];
  return {
    name: tpl.name, owner: tpl.owner ?? -1, bn: { ...tpl.bn }, sup: { ...(tpl.sup || {}) }, nbn, cls, clsCount,
    atk, def, speed: speed * speedMul, rough: nbn ? rough / nbn : 1, terr, eq, mp: Math.round(mp * 10) / 10, days: Math.round(t),
  };
}

function registerTemplate(tpl) { UNITS[tpl.id] = { id: tpl.id, ...compileTemplate(tpl) }; }
const isPreset = id => PRESETS.some(p => p.id === id);
// 직접 설계한 사단을 모두 지우고 목록으로 다시 등록 (새 게임/불러오기)
function resetTemplates(list = []) {
  for (const k of Object.keys(UNITS)) if (!isPreset(k)) delete UNITS[k];
  list.forEach(registerTemplate);
}
PRESETS.forEach(registerTemplate);

// 한 대대 종류를 몇 개 쓰는지 등을 사람이 읽는 문장으로
function describeTemplate(u) {
  const bn = Object.entries(u.bn).filter(([, c]) => c).map(([k, c]) => `${BN[k].name} ${c}`).join(' · ');
  const sup = Object.entries(u.sup || {}).filter(([, c]) => c).map(([k, c]) => `${SUPPORT[k].name}${c > 1 ? ' ×' + c : ''}`).join(', ');
  return bn + (sup ? ` + ${sup}` : '');
}

// 사단 효율 환산(보병 사단 1개 ≈ 1.0)
const unitStr = t => (UNITS[t].atk + UNITS[t].def) / 2.1;

const templatesOf = (G, owner) => G.templates.filter(t => t.owner === owner);
const templateIdsFor = (G, owner) => [...PRESETS.map(p => p.id), ...templatesOf(G, owner).map(t => t.id)];

// spec: { name, bn: {inf, mtn, tank, art}, sup: {recon, eng} }
function designTemplate(G, owner, spec) {
  const bn = {}, sup = {};
  let nb = 0, ns = 0;
  for (const k of Object.keys(BN)) { const c = Math.floor(+((spec.bn || {})[k]) || 0); if (c < 0) return { ok: false, msg: '대대 수가 올바르지 않다.' }; if (c) bn[k] = c; nb += c; }
  for (const k of Object.keys(SUPPORT)) { const c = Math.floor(+((spec.sup || {})[k]) || 0); if (c < 0) return { ok: false, msg: '지원 중대 수가 올바르지 않다.' }; if (c) sup[k] = c; ns += c; }
  const name = String(spec.name || '').trim().slice(0, 14);
  if (!name) return { ok: false, msg: '사단 이름을 입력하세요.' };
  if (nb < 1) return { ok: false, msg: '전투 대대를 하나 이상 넣어야 한다.' };
  if (nb > MAX_BN) return { ok: false, msg: `전투 대대는 최대 ${MAX_BN}개다.` };
  if (ns > MAX_SUP) return { ok: false, msg: `지원 중대는 최대 ${MAX_SUP}개다.` };
  if (templatesOf(G, owner).length >= MAX_TEMPLATES) return { ok: false, msg: `직접 설계한 사단은 최대 ${MAX_TEMPLATES}개다. 쓰지 않는 것을 삭제하세요.` };
  const names = [...PRESETS.map(p => p.name), ...templatesOf(G, owner).map(t => t.name)];
  if (names.includes(name)) return { ok: false, msg: '같은 이름의 사단이 이미 있다.' };
  const tpl = { id: 'T' + G.nextTemplate++, owner, name, bn, sup };
  G.templates.push(tpl);
  registerTemplate(tpl);
  return { ok: true, msg: `「${name}」 사단을 설계했다.`, tpl };
}

// 직접 설계한 사단 삭제: 훈련 라인이나 부대가 쓰고 있으면 거부
function deleteTemplate(G, owner, id) {
  const tpl = G.templates.find(t => t.id === id && t.owner === owner);
  if (!tpl) return { ok: false, msg: '삭제할 수 없는 사단이다.' };
  if (G.countries[owner].queue.some(q => q.type === id)) return { ok: false, msg: '훈련 라인에서 쓰고 있어 삭제할 수 없다.' };
  if (G.armies.some(a => a.comp[id] > 0.01)) return { ok: false, msg: '이 사단으로 편성된 부대가 있어 삭제할 수 없다.' };
  G.templates = G.templates.filter(t => t !== tpl);
  delete UNITS[id];
  return { ok: true, msg: `「${tpl.name}」 설계를 삭제했다.` };
}
