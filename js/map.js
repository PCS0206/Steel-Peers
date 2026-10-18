'use strict';
// 절차적 지도: 정확한 보로노이 다각형 + 경계 흔들림(자연스러운 국경/해안선) + 벡터 렌더링

const MAP_W = 1200, MAP_H = 700;
const COLS = 22, ROWS = 13;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hash2(a, b) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
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

// 지형: move=이동 시간 배수, def=방어 보너스, tint=지도 색 보정
const TERRAIN = {
  plains:   { name: '평원', move: 1,   def: 1,    tint: [1.0, 1.0, 1.0] },
  forest:   { name: '숲',   move: 1.4, def: 1.15, tint: [0.8, 0.95, 0.8] },
  hills:    { name: '구릉', move: 1.5, def: 1.25, tint: [1.05, 0.97, 0.8] },
  mountain: { name: '산악', move: 2,   def: 1.5,  tint: [0.78, 0.78, 0.86] },
  marsh:    { name: '늪',   move: 1.8, def: 1,    tint: [0.78, 0.92, 0.95] },
};

const SYL = ['카', '르', '벤', '도', '라', '실', '안', '모', '네', '리', '타', '베', '오', '잘', '쿠', '민', '하', '세', '론', '발'];

// ---------- 지오메트리 ----------
// 시드 s의 보로노이 셀 = 지도 사각형을 이웃 시드와의 수직이등분선으로 잘라낸 볼록 다각형.
// 각 꼭짓점의 nb는 "이 꼭짓점에서 다음 꼭짓점까지의 변" 건너편 이웃 id (지도 바깥은 -1)
function clipCell(s, others) {
  let poly = [{ x: 0, y: 0, nb: -1 }, { x: MAP_W, y: 0, nb: -1 }, { x: MAP_W, y: MAP_H, nb: -1 }, { x: 0, y: MAP_H, nb: -1 }];
  for (const q of others) {
    const mx = (s.sx + q.sx) / 2, my = (s.sy + q.sy) / 2, nx = s.sx - q.sx, ny = s.sy - q.sy;
    const side = p => (p.x - mx) * nx + (p.y - my) * ny;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], r = poly[(i + 1) % poly.length], dp = side(p), dr = side(r);
      const cut = () => { const t = dp / (dp - dr); return { x: p.x + (r.x - p.x) * t, y: p.y + (r.y - p.y) * t }; };
      if (dp >= 0 && dr >= 0) out.push(p);
      else if (dp >= 0) { out.push(p); out.push({ ...cut(), nb: q.id }); }
      else if (dr >= 0) out.push({ ...cut(), nb: p.nb });
    }
    poly = out;
    if (poly.length < 3) break;
  }
  const snap = v => Math.round(v * 1000) / 1000;
  poly = poly.map(p => ({ x: snap(p.x), y: snap(p.y), nb: p.nb }));
  return poly.filter((p, i) => { const n = poly[(i + 1) % poly.length]; return Math.hypot(p.x - n.x, p.y - n.y) > 1e-3; });
}

// 두 끝점이 같으면 항상 같은 결과가 나오는 중점 변위 (인접한 두 셀이 같은 경계선을 공유하도록)
function subdivide(a, b, depth, amp, out) {
  if (depth === 0) { out.push(b); return; }
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  const r = (hash2(Math.round(mx * 8), Math.round(my * 8)) - 0.5) * 2;
  const m = { x: mx - dy / len * r * len * amp, y: my + dx / len * r * len * amp };
  subdivide(a, m, depth - 1, amp * 0.85, out);
  subdivide(m, b, depth - 1, amp * 0.85, out);
}
function jitterEdge(a, b, amp) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const depth = len > 50 ? 4 : len > 22 ? 3 : len > 8 ? 2 : 0;
  if (!depth) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  const flip = a.x > b.x || (a.x === b.x && a.y > b.y);
  const p0 = flip ? b : a, p1 = flip ? a : b, pts = [{ x: p0.x, y: p0.y }];
  subdivide(p0, p1, depth, amp, pts);
  return flip ? pts.reverse() : pts;
}

function polyCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function generateMap(seed) {
  const rnd = mulberry32(seed);
  const cw = MAP_W / COLS, ch = MAP_H / ROWS;
  const provs = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    let name = '';
    for (let k = 0, n = 2 + (rnd() < 0.4 ? 1 : 0); k < n; k++) name += SYL[Math.floor(rnd() * SYL.length)];
    provs.push({
      id: provs.length, sx: (c + 0.1 + rnd() * 0.8) * cw, sy: (r + 0.1 + rnd() * 0.8) * ch,
      col: c, row: r, name, land: false, owner: -1, controller: -1, terrain: 'plains', adj: [], industry: 0,
      shade: 0.9 + rnd() * 0.18, x: 0, y: 0, base: null, poly: null, edges: null, deco: [],
    });
  }

  // 정확한 보로노이 셀과 인접 관계
  for (const p of provs) {
    const others = provs.filter(q => q !== p && Math.abs(q.col - p.col) <= 3 && Math.abs(q.row - p.row) <= 3);
    p.base = clipCell(p, others);
    const c = polyCentroid(p.base);
    p.x = c.x; p.y = c.y;
    const adj = new Set();
    p.base.forEach((v, i) => {
      const n = p.base[(i + 1) % p.base.length];
      if (v.nb >= 0 && Math.hypot(n.x - v.x, n.y - v.y) > 1.5) adj.add(v.nb);
    });
    p.adj = [...adj];
  }
  // 대칭 보정 (모서리에서만 닿는 경우 한쪽에만 기록될 수 있음)
  for (const p of provs) for (const n of p.adj) if (!provs[n].adj.includes(p.id)) provs[n].adj.push(p.id);

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

  // 지형: 고도 상위 = 산/구릉, 나머지는 습도로 숲/늪/평원
  const ne = makeNoise(rnd, 6, 4), nm = makeNoise(rnd, 8, 5);
  const landP = provs.filter(p => p.land);
  const elev = new Map(landP.map(p => [p.id, 0.6 * ne(p.x / MAP_W, p.y / MAP_H) + 0.4 * rnd()]));
  const moist = new Map(landP.map(p => [p.id, 0.7 * nm(p.x / MAP_W, p.y / MAP_H) + 0.3 * rnd()]));
  const byElev = [...landP].sort((a, b) => elev.get(b.id) - elev.get(a.id));
  const byMoist = [...landP].sort((a, b) => moist.get(b.id) - moist.get(a.id));
  const nL = landP.length;
  byElev.forEach((p, i) => { if (i < nL * 0.1) p.terrain = 'mountain'; else if (i < nL * 0.3) p.terrain = 'hills'; });
  byMoist.forEach((p, i) => {
    if (p.terrain !== 'plains') return;
    if (i < nL * 0.28) p.terrain = 'forest';
    else if (i < nL * 0.4 && elev.get(p.id) < 0.45) p.terrain = 'marsh';
  });

  // 육지 지역의 흔들린 경계선과 장식 아이콘 위치
  for (const p of landP) {
    p.edges = p.base.map((v, i) => {
      const n = p.base[(i + 1) % p.base.length];
      const nbLand = v.nb >= 0 && provs[v.nb].land;
      const amp = v.nb < 0 ? 0 : nbLand ? 0.11 : 0.2;
      return { nb: v.nb, pts: amp ? jitterEdge(v, n, amp) : [{ x: v.x, y: v.y }, { x: n.x, y: n.y }] };
    });
    p.poly = [];
    for (const e of p.edges) for (let i = 0; i < e.pts.length - 1; i++) p.poly.push(e.pts[i]);
    const count = { mountain: 4, hills: 3, forest: 6, marsh: 4, plains: 0 }[p.terrain];
    const dr = mulberry32(seed * 131 + p.id);
    const xs = p.base.map(v => v.x), ys = p.base.map(v => v.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (let t = 0; t < 60 && p.deco.length < count; t++) {
      const x = x0 + dr() * (x1 - x0), y = y0 + dr() * (y1 - y0);
      if (Math.hypot(x - p.x, y - p.y) < 13 || !pointInPoly(p.poly, x, y)) continue;
      if (p.deco.some(d => Math.hypot(d.x - x, d.y - y) < 11)) continue;
      p.deco.push({ x, y, s: 0.8 + dr() * 0.5 });
    }
  }

  const m = { provs, cw, ch, sea: null, tex: null, land: null, coast: null, fill: [], occ: [], bProv: null, bOwn: null, ownSig: '', styleSig: '', cache: null, cacheS: 0, cacheDirty: true };
  if (typeof document !== 'undefined') buildMapLayers(m, seed);
  return m;
}

// 점이 속한 육지 지역 id (없으면 -1)
function findProvince(m, x, y) {
  const c0 = Math.floor(x / m.cw), r0 = Math.floor(y / m.ch);
  for (const p of m.provs) {
    if (!p.land || Math.abs(p.col - c0) > 2 || Math.abs(p.row - r0) > 2) continue;
    if (pointInPoly(p.poly, x, y)) return p.id;
  }
  return -1;
}

// ---------- 렌더링 (브라우저 전용) ----------
const pathOf = (pts, path = new Path2D(), close = false) => {
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  if (close) path.closePath();
  return path;
};

function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function buildMapLayers(m, seed) {
  const provs = m.provs;
  m.land = new Path2D(); m.coast = new Path2D();
  for (const p of provs) {
    if (!p.land) continue;
    p.path = pathOf(p.poly, new Path2D(), true);
    m.land.addPath(p.path);
    for (const e of p.edges) if (e.nb >= 0 && !provs[e.nb].land) pathOf(e.pts, m.coast);
  }

  // 바다: 깊이 그라데이션 + 해안 글로우 + 잔물결 (한 번만 그려 캐시)
  const S = 2;
  m.sea = mkCanvas(MAP_W * S, MAP_H * S);
  const g = m.sea.getContext('2d');
  const grad = g.createRadialGradient(MAP_W * S / 2, MAP_H * S / 2, 80, MAP_W * S / 2, MAP_H * S / 2, MAP_W * S * 0.62);
  grad.addColorStop(0, '#1f5a82'); grad.addColorStop(1, '#0a2640');
  g.fillStyle = grad; g.fillRect(0, 0, m.sea.width, m.sea.height);
  const wr = mulberry32(seed + 7);
  g.strokeStyle = 'rgba(190,230,255,0.07)'; g.lineWidth = 1.4;
  for (let i = 0; i < 420; i++) {
    const x = wr() * m.sea.width, y = wr() * m.sea.height, w = 14 + wr() * 26;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + w / 2, y - 5, x + w, y); g.stroke();
  }
  g.save(); g.scale(S, S);
  for (const [blur, color] of [[70, 'rgba(90,190,220,0.32)'], [26, 'rgba(150,225,240,0.55)']]) {
    g.shadowColor = color; g.shadowBlur = blur * S; g.fillStyle = '#000'; g.fill(m.land);
  }
  g.restore();

  // 질감: 육지에만 적용되는 저주파 노이즈 (overlay 합성용)
  m.tex = mkCanvas(MAP_W, MAP_H);
  const tg = m.tex.getContext('2d'), img = tg.createImageData(MAP_W, MAP_H);
  const tr = mulberry32(seed + 99), a = makeNoise(tr, 20, 12), b = makeNoise(tr, 55, 32), c = makeNoise(tr, 140, 80);
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const u = x / MAP_W, v = y / MAP_H, n = 0.5 * a(u, v) + 0.3 * b(u, v) + 0.2 * c(u, v);
    const k = (y * MAP_W + x) * 4, gray = Math.max(0, Math.min(255, 128 + (n - 0.5) * 230));
    img.data[k] = img.data[k + 1] = img.data[k + 2] = gray; img.data[k + 3] = 255;
  }
  tg.putImageData(img, 0, 0);
  tg.globalCompositeOperation = 'destination-in'; tg.fill(m.land);

  m.stripes = new Map();
}

const rgbStr = (r, gg, b) => `rgb(${Math.round(Math.min(255, r))},${Math.round(Math.min(255, gg))},${Math.round(Math.min(255, b))})`;

// 소유·점령·시야에 따른 색과 국경 경로를 갱신 (상태가 바뀔 때만 호출)
function updateMapStyle(G, vis) {
  const m = G.map, provs = G.provs;
  const sig = provs.map(p => p.owner + ':' + p.controller).join(',') + '|' + (vis ? [...vis].sort((a, b) => a - b).join(',') : '');
  if (sig === m.styleSig) return;       // 소유·점령·시야가 그대로면 다시 굽지 않는다
  m.styleSig = sig; m.cacheDirty = true;
  const style = (rgb, p, fog) => {
    const t = TERRAIN[p.terrain].tint;
    let r = rgb[0] * p.shade * t[0], g = rgb[1] * p.shade * t[1], b = rgb[2] * p.shade * t[2];
    if (fog) { const y = (r + g + b) / 3; r = r * 0.4 + y * 0.2; g = g * 0.4 + y * 0.2; b = b * 0.4 + y * 0.2; }
    return rgbStr(r, g, b);
  };
  for (const p of provs) {
    if (!p.land) continue;
    const fog = vis && !vis.has(p.id);
    m.fill[p.id] = style(p.owner >= 0 ? G.countries[p.owner].color : [120, 120, 120], p, fog);
    m.occ[p.id] = p.controller >= 0 && p.controller !== p.owner ? style(G.countries[p.controller].color, p, fog) : null;
  }
  const ownSig = provs.map(p => p.owner).join(',');
  if (ownSig !== m.ownSig) {
    m.ownSig = ownSig; m.bProv = new Path2D(); m.bOwn = new Path2D();
    for (const p of provs) {
      if (!p.land) continue;
      for (const e of p.edges) {
        if (e.nb <= p.id || !provs[e.nb].land) continue;
        pathOf(e.pts, provs[e.nb].owner === p.owner ? m.bProv : m.bOwn);
      }
    }
  }
}

function stripePattern(ctx, m, color) {
  let pat = m.stripes.get(color);
  if (pat) return pat;
  const c = mkCanvas(12, 12), g = c.getContext('2d');
  g.fillStyle = color; g.globalAlpha = 0.9;
  for (const o of [-12, 0, 12]) { g.beginPath(); g.moveTo(o, 12); g.lineTo(o + 6, 12); g.lineTo(o + 18, 0); g.lineTo(o + 12, 0); g.fill(); }
  pat = ctx.createPattern(c, 'repeat');
  m.stripes.set(color, pat);
  return pat;
}

function drawDeco(ctx, p) {
  ctx.fillStyle = 'rgba(15,20,10,0.30)'; ctx.strokeStyle = 'rgba(15,20,10,0.34)'; ctx.lineWidth = 0.9;
  for (const d of p.deco) {
    const s = d.s * 3.2;
    ctx.beginPath();
    switch (p.terrain) {
      case 'mountain':
        ctx.moveTo(d.x - s * 1.6, d.y + s); ctx.lineTo(d.x - s * 0.1, d.y - s * 1.7); ctx.lineTo(d.x + s * 1.6, d.y + s); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath();
        ctx.moveTo(d.x - s * 0.1, d.y - s * 1.7); ctx.lineTo(d.x + s * 0.55, d.y - s * 0.4); ctx.lineTo(d.x - s * 0.5, d.y - s * 0.4); ctx.fill();
        ctx.fillStyle = 'rgba(15,20,10,0.30)'; break;
      case 'hills': ctx.arc(d.x, d.y + s * 0.6, s * 1.5, Math.PI, 0); ctx.stroke(); break;
      case 'forest': ctx.arc(d.x, d.y - s * 0.4, s, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(d.x - 0.5, d.y + s * 0.5, 1, s * 0.8); break;
      case 'marsh': for (let i = -1; i <= 1; i++) { ctx.moveTo(d.x - s + i * 1.5, d.y + i * s * 0.7); ctx.lineTo(d.x + s + i * 1.5, d.y + i * s * 0.7); } ctx.stroke(); break;
    }
  }
}

// 정적 레이어: 바다·지역 색·질감·아이콘·경계선. z는 선 굵기 기준 줌(화면 px 단위로 일정하게 보이도록)
function drawStatic(ctx, G, z) {
  const m = G.map, provs = G.provs;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(m.sea, 0, 0, MAP_W, MAP_H);
  for (const p of provs) {
    if (!p.land) continue;
    ctx.fillStyle = m.fill[p.id]; ctx.fill(p.path);
    if (m.occ[p.id]) { ctx.fillStyle = stripePattern(ctx, m, m.occ[p.id]); ctx.fill(p.path); }
  }
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.5; ctx.drawImage(m.tex, 0, 0, MAP_W, MAP_H); ctx.restore();
  for (const p of provs) if (p.land && p.deco.length) drawDeco(ctx, p);

  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.26)'; ctx.lineWidth = 1 / z; ctx.stroke(m.bProv);
  ctx.strokeStyle = 'rgba(8,10,18,0.9)'; ctx.lineWidth = 3.2 / z; ctx.stroke(m.bOwn);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1 / z; ctx.stroke(m.bOwn);
  ctx.strokeStyle = 'rgba(6,22,38,0.95)'; ctx.lineWidth = 1.8 / z; ctx.stroke(m.coast);
}

// 지도 전체를 월드 좌표계에서 그린다 (ctx에는 카메라 변환이 이미 설정되어 있어야 함).
// 보통 줌에서는 정적 레이어를 오프스크린에 구워 두고 이미지로 그린다. 크게 확대하면 벡터로 직접 그려 선명하게 유지한다.
function drawMap(ctx, G, z, hoverId, selId) {
  const m = G.map, provs = G.provs, dpr = window.devicePixelRatio || 1;
  if (z * dpr > 3.2) drawStatic(ctx, G, z);
  else {
    const S = Math.min(3, Math.max(1, Math.ceil(z * dpr)));
    if (!m.cache || m.cacheS !== S || m.cacheDirty) {
      if (!m.cache || m.cacheS !== S) m.cache = mkCanvas(MAP_W * S, MAP_H * S);
      const g = m.cache.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, m.cache.width, m.cache.height);
      g.scale(S, S); drawStatic(g, G, S / dpr);
      m.cacheS = S; m.cacheDirty = false;
    }
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(m.cache, 0, 0, MAP_W, MAP_H);
  }
  for (const id of [hoverId, selId]) {
    if (id < 0 || !provs[id].land) continue;
    ctx.fillStyle = id === selId ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.1)'; ctx.fill(provs[id].path);
  }
  if (selId >= 0 && provs[selId].land) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.4 / z; ctx.stroke(provs[selId].path); }
}
