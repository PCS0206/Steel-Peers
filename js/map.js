'use strict';
// 절차적 지도 생성: 보로노이 지역(province) + 노이즈 기반 육지/바다

const MAP_W = 1200, MAP_H = 700, RES = 2;
const GW = MAP_W / RES, GH = MAP_H / RES;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeNoise(rnd, cols, rows) {
  const v = [];
  for (let i = 0; i < (cols + 1) * (rows + 1); i++) v.push(rnd());
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x * cols, fy = y * rows;
    const ix = Math.min(cols - 1, Math.floor(fx)), iy = Math.min(rows - 1, Math.floor(fy));
    const tx = sm(fx - ix), ty = sm(fy - iy), w = cols + 1;
    const a = v[iy * w + ix], b = v[iy * w + ix + 1], c = v[(iy + 1) * w + ix], d = v[(iy + 1) * w + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

const SYL = ['카', '르', '벤', '도', '라', '실', '안', '모', '네', '리', '타', '베', '오', '잘', '쿠', '민', '하', '세', '론', '발'];

function generateMap(seed) {
  const rnd = mulberry32(seed);
  const COLS = 22, ROWS = 13, cw = MAP_W / COLS, ch = MAP_H / ROWS;
  const provs = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    let name = '';
    for (let k = 0, n = 2 + (rnd() < 0.4 ? 1 : 0); k < n; k++) name += SYL[Math.floor(rnd() * SYL.length)];
    provs.push({
      id: provs.length, sx: (c + 0.1 + rnd() * 0.8) * cw, sy: (r + 0.1 + rnd() * 0.8) * ch,
      col: c, row: r, name, land: false, owner: -1, adj: [], industry: 0, shade: 0.88 + rnd() * 0.2, x: 0, y: 0,
    });
  }
  const at = (c, r) => provs[r * COLS + c];

  // 각 격자 셀이 속한 지역(가장 가까운 시드) 계산
  const idmap = new Int16Array(GW * GH);
  const sumX = new Float64Array(provs.length), sumY = new Float64Array(provs.length), cnt = new Int32Array(provs.length);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const x = gx * RES + RES / 2, y = gy * RES + RES / 2;
    const c0 = Math.floor(x / cw), r0 = Math.floor(y / ch);
    let best = -1, bd = 1e18;
    for (let r = Math.max(0, r0 - 2); r <= Math.min(ROWS - 1, r0 + 2); r++)
      for (let c = Math.max(0, c0 - 2); c <= Math.min(COLS - 1, c0 + 2); c++) {
        const p = at(c, r), d = (p.sx - x) ** 2 + (p.sy - y) ** 2;
        if (d < bd) { bd = d; best = p.id; }
      }
    idmap[gy * GW + gx] = best;
    sumX[best] += x; sumY[best] += y; cnt[best]++;
  }
  for (const p of provs) { p.x = sumX[p.id] / cnt[p.id]; p.y = sumY[p.id] / cnt[p.id]; }

  // 인접 관계 + 경계 픽셀
  const adjSet = provs.map(() => new Set());
  const bidx = [], bnb = [];
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const i = gy * GW + gx, a = idmap[i];
    for (const j of [gx + 1 < GW ? i + 1 : -1, gy + 1 < GH ? i + GW : -1]) {
      if (j < 0) continue;
      const b = idmap[j];
      if (a !== b) { adjSet[a].add(b); adjSet[b].add(a); bidx.push(i); bnb.push(b); }
    }
  }
  provs.forEach(p => { p.adj = [...adjSet[p.id]]; });

  // 노이즈로 육지 선택 (상위 ~56%)
  const n1 = makeNoise(rnd, 4, 3), n2 = makeNoise(rnd, 9, 6), n3 = makeNoise(rnd, 16, 10);
  const val = provs.map(p => {
    const u = p.x / MAP_W, v = p.y / MAP_H;
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    return 0.55 * n1(u, v) + 0.3 * n2(u, v) + 0.15 * n3(u, v) - 0.3 * Math.sqrt(dx * dx * 0.8 + dy * dy);
  });
  const sorted = [...val].sort((a, b) => b - a);
  const thr = sorted[Math.floor(provs.length * 0.56)];
  provs.forEach((p, i) => { p.land = val[i] >= thr; });

  // 가장 큰 대륙만 육지로 유지
  const seen = new Set();
  let bestComp = [];
  for (const p of provs) {
    if (!p.land || seen.has(p.id)) continue;
    const comp = [p.id], q = [p.id]; seen.add(p.id);
    while (q.length) {
      const cur = q.pop();
      for (const n of provs[cur].adj) if (provs[n].land && !seen.has(n)) { seen.add(n); comp.push(n); q.push(n); }
    }
    if (comp.length > bestComp.length) bestComp = comp;
  }
  const keep = new Set(bestComp);
  provs.forEach(p => { p.land = keep.has(p.id); });

  const m = { provs, idmap, bidx: Int32Array.from(bidx), bnb: Int16Array.from(bnb), canvas: null, ctx: null, img: null, buf32: null };
  if (typeof document !== 'undefined') {
    m.canvas = document.createElement('canvas');
    m.canvas.width = GW; m.canvas.height = GH;
    m.ctx = m.canvas.getContext('2d');
    m.img = m.ctx.createImageData(GW, GH);
    m.buf32 = new Uint32Array(m.img.data.buffer);
  }
  return m;
}

const pack = (r, g, b) => (0xFF000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>> 0;

// 소유자 색으로 지도를 오프스크린 캔버스에 그린다
function renderMapImage(G, hoverId, selId) {
  const m = G.map;
  if (!m.ctx) return;
  const provs = G.provs, buf = m.buf32, idmap = m.idmap;
  const cols = new Uint32Array(provs.length);
  for (const p of provs) {
    if (!p.land) { cols[p.id] = pack(26, 50, 82); continue; }
    let [r, g, b] = p.owner >= 0 ? G.countries[p.owner].color : [120, 120, 120];
    let k = p.shade;
    if (p.id === selId) k *= 1.4; else if (p.id === hoverId) k *= 1.2;
    cols[p.id] = pack(r * k, g * k, b * k);
  }
  for (let i = 0; i < idmap.length; i++) buf[i] = cols[idmap[i]];
  for (let k = 0; k < m.bidx.length; k++) {
    const i = m.bidx[k], pa = provs[idmap[i]], pb = provs[m.bnb[k]];
    if (!pa.land && !pb.land) continue;
    if (pa.land && pb.land) {
      if (pa.owner !== pb.owner) { buf[i] = pack(15, 15, 20); continue; }
      const c = cols[pa.id];
      buf[i] = pack((c & 255) * 0.78, ((c >> 8) & 255) * 0.78, ((c >> 16) & 255) * 0.78);
    }
    else buf[i] = pack(12, 28, 48);
  }
  m.ctx.putImageData(m.img, 0, 0);
}
