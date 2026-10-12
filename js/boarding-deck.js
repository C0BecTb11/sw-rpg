// Абордаж: палуба на холсте.
//
// Два слоя. Неподвижный — «чертёж» палубы: корпус снаружи с дюзами и
// ходовыми огнями, пол каждого отсека в своей отделке, свет ламп, стены
// с фаской, предметы с тенями. Рисуется один раз на палубу в отдельный
// холст. Живой слой — каждый кадр поверх: двери, туман, тревога, бойцы,
// турели, подписи, мини-карта.
//
// Координаты плана — клетки: x к носу, y к правому борту. На телефоне
// корабль стоит носом вверх (план повёрнут на 90°), подписи и жетоны
// всегда рисуются прямо, в координатах экрана.
//
// Снаружи нужны из boarding.js: bdState, bdSel, bdSelDoor, bdMine(),
// bdDoorState(d), bdUnits(n), bdAdjDoors(u), bdPrepDeck(dk).

var BDC = null;

var BDC_PAD = 4;          // поле вокруг корпуса в клетках: дюзы, рукав шлюза
var BDC_MAXS = 64;        // крупнее этого клетку не растягиваем, px
var BDC_ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Отделка отсеков: пол, свет ламп, акцент
var BDC_THEME = {
  room:     { floor: '#131b26', light: '#a9c2dd', acc: '#5b6b7d' },
  corr:     { floor: '#0e141c', light: '#8fc3ea', acc: '#3d5770' },
  bridge:   { floor: '#0d1726', light: '#5aa6ff', acc: '#4a90d9' },
  ops:      { floor: '#101a27', light: '#6fb0f0', acc: '#4a90d9' },
  servers:  { floor: '#0f1420', light: '#9b86ff', acc: '#8a6fd0' },
  shield:   { floor: '#0b1a21', light: '#46d4ff', acc: '#36b6dc' },
  reactor:  { floor: '#1a120c', light: '#ff8a3a', acc: '#e08a2c' },
  engine:   { floor: '#12141c', light: '#7aa8ff', acc: '#4a6fb0' },
  armory:   { floor: '#1a1215', light: '#ff7a6a', acc: '#d94a4a' },
  gunnery:  { floor: '#171316', light: '#ff9a6a', acc: '#b8562f' },
  quarters: { floor: '#16161b', light: '#e8d9a8', acc: '#8a7d62' },
  mess:     { floor: '#17151a', light: '#f0d49a', acc: '#a8874f' },
  med:      { floor: '#0f1c1d', light: '#7ff0dc', acc: '#3fbfa8' },
  plaza:    { floor: '#121923', light: '#cfe0f5', acc: '#5b6b7d' },
  hold:     { floor: '#16140f', light: '#e3c78a', acc: '#d9a940' },
  workshop: { floor: '#15161a', light: '#ffc76a', acc: '#d9a940' },
  hangar:   { floor: '#14181e', light: '#dfe8f2', acc: '#d9a940' },
  lock:     { floor: '#0b191a', light: '#5fe0cb', acc: '#1f9d8a' },
  lift:     { floor: '#121a26', light: '#8fb6e0', acc: '#4a6f99' },
  pods:     { floor: '#10161e', light: '#ffb36a', acc: '#d9a940' }
};

var BDC_AREA_THEME = {
  brg: 'bridge', tac: 'ops', kom: 'ops', sen: 'ops', nav: 'ops', cnf: 'ops', bic: 'ops', com: 'ops', brf: 'ops',
  arc: 'servers', srv: 'servers', shd: 'shield', grd: 'armory', ars: 'armory', amm: 'armory', rng: 'armory', trp: 'armory',
  bt1: 'gunnery', bt2: 'gunnery', gun: 'gunnery', c1: 'quarters', c2: 'quarters', c3: 'quarters', cap: 'quarters',
  war: 'quarters', bar: 'quarters', kub: 'quarters', cab: 'quarters', crw: 'quarters', mes: 'mess', gal: 'mess',
  med: 'med', atr: 'plaza', rea: 'reactor', eng: 'engine', pwr: 'engine', pmp: 'engine', gyr: 'engine',
  ws: 'workshop', hld: 'hold', hold: 'hold', sto: 'hold', fue: 'hold', clo: 'hold', hng: 'hangar',
  lkp: 'lock', lks: 'lock', pod: 'pods'
};

// Окраска корпуса и техники по стороне хозяина корабля
var BDC_LIVERY = {
  republic: { hull: ['#2b333d', '#4b5561', '#2b333d'], stripe: '#a8322d', craft: '#c9ced6', craft2: '#a8322d' },
  cis:      { hull: ['#2f2b25', '#575043', '#2f2b25'], stripe: '#4d6f9e', craft: '#a89a7a', craft2: '#4d6f9e' },
  other:    { hull: ['#272e37', '#47525f', '#272e37'], stripe: '#d9a940', craft: '#a7b3c2', craft2: '#d9a940' }
};

var BDC_SIDE = { mine: '#5fd968', ally: '#4a90d9', foe: '#ff5a4f' };

// ---------- мелочи ----------

function bdcHash(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function bdcRng(seed) {
  var a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bdcRR(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function bdcAlpha(hex, a) {
  var n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function bdcMix(hex, hex2, k) {
  var a = parseInt(hex.slice(1), 16), b = parseInt(hex2.slice(1), 16);
  var r = Math.round(((a >> 16) & 255) * (1 - k) + ((b >> 16) & 255) * k);
  var g = Math.round(((a >> 8) & 255) * (1 - k) + ((b >> 8) & 255) * k);
  var bl = Math.round((a & 255) * (1 - k) + (b & 255) * k);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}

// Корпус наружу на d клеток: у выпуклого многоугольника сдвигаем стороны и пересекаем
function bdcOffsetPoly(pts, d) {
  var n = pts.length, area = 0, i;
  for (i = 0; i < n; i++) { var p = pts[i], q = pts[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  var sgn = area > 0 ? 1 : -1;
  var lines = [];
  for (i = 0; i < n; i++) {
    var a = pts[i], b = pts[(i + 1) % n];
    var dx = b[0] - a[0], dy = b[1] - a[1], L = Math.sqrt(dx * dx + dy * dy) || 1;
    // Наружная нормаль: при обходе против часовой (в экранных осях — по часовой) — вправо
    var nx = sgn * dy / L, ny = -sgn * dx / L;
    lines.push([a[0] + nx * d, a[1] + ny * d, dx, dy]);
  }
  var out = [];
  for (i = 0; i < n; i++) {
    var l1 = lines[(i + n - 1) % n], l2 = lines[i];
    var den = l1[2] * l2[3] - l1[3] * l2[2];
    if (Math.abs(den) < 1e-9) { out.push([l2[0], l2[1]]); continue; }
    var t = ((l2[0] - l1[0]) * l2[3] - (l2[1] - l1[1]) * l2[2]) / den;
    out.push([l1[0] + l1[2] * t, l1[1] + l1[3] * t]);
  }
  return out;
}

function bdcPolyPath(c, pts) {
  c.moveTo(pts[0][0], pts[0][1]);
  for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
}

function bdcReduced() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- разбор палубы под рисование ----------

function bdcGeom(dk) {
  if (dk._g) return dk._g;
  var g = { areaOf: [], areas: {}, areaList: [], zonePath: {}, walls: [], doors: [], beacons: [] };
  var W = dk.w, H = dk.h, x, y;
  for (y = 0; y < H; y++) {
    var row = [];
    for (x = 0; x < W; x++) {
      var zi = dk._zone[y][x];
      row.push(zi >= 0 ? dk.zones[zi].area : null);
    }
    g.areaOf.push(row);
  }
  var at = function(xx, yy) { return (yy < 0 || yy >= H || xx < 0 || xx >= W) ? null : g.areaOf[yy][xx]; };
  g.at = at;

  // Отсеки: подпись, род, клетки рядами, прямоугольники
  dk.zones.forEach(function(z) {
    var a = g.areas[z.area];
    if (!a) {
      a = g.areas[z.area] = { id: z.area, kind: z.kind, label: z.label || (z.kind === 'lock' ? 'Шлюз' : ''), runs: [], cells: 0,
                              minx: 1e9, miny: 1e9, maxx: -1, maxy: -1, zones: [], role: null };
      g.areaList.push(a);
    }
    if (z.role) a.role = z.role;
    a.zones.push(z.id);
  });
  for (y = 0; y < H; y++) {
    for (x = 0; x < W;) {
      var id = g.areaOf[y][x];
      if (!id) { x++; continue; }
      var x0 = x; while (x < W && g.areaOf[y][x] === id) x++;
      var ar = g.areas[id];
      ar.runs.push([x0, y, x - x0, 1]); ar.cells += x - x0;
      ar.minx = Math.min(ar.minx, x0); ar.maxx = Math.max(ar.maxx, x - 1);
      ar.miny = Math.min(ar.miny, y); ar.maxy = Math.max(ar.maxy, y);
    }
  }
  // Прямоугольники отсеков — из шаблона, если есть; иначе — рамка
  var rectsById = {};
  (dk.areas || []).forEach(function(a) { if (a.rects) rectsById[a.id] = a.rects; });
  g.areaList.forEach(function(a) {
    var rs = rectsById[a.id];
    a.rects = rs ? rs.map(function(r) { return [r[0], r[1], r[2] - r[0] + 1, r[3] - r[1] + 1]; })
                 : [[a.minx, a.miny, a.maxx - a.minx + 1, a.maxy - a.miny + 1]];
    a.big = a.rects.slice().sort(function(p, q) { return q[2] * q[3] - p[2] * p[3]; })[0];
    a.theme = BDC_THEME[BDC_AREA_THEME[a.id] || (a.kind === 'goal' ? 'ops' : a.kind)] || BDC_THEME.room;
    a.themeKey = BDC_AREA_THEME[a.id] || a.kind;
  });

  // Пути зон (для тумана) — рядами клеток
  var zr = {};
  for (y = 0; y < H; y++) {
    for (x = 0; x < W;) {
      var zi2 = dk._zone[y][x];
      if (zi2 < 0) { x++; continue; }
      var xs = x; while (x < W && dk._zone[y][x] === zi2) x++;
      (zr[zi2] = zr[zi2] || []).push([xs, y, x - xs, 1]);
    }
  }
  dk.zones.forEach(function(z, i) {
    var p = new Path2D();
    (zr[i] || []).forEach(function(r) { p.rect(r[0], r[1], r[2], r[3]); });
    g.zonePath[z.id] = p;
  });

  // Стены: граница двух отсеков или отсека и пустоты, кроме проёмов дверей
  var hs = {}, vs = {}, bnd = {};
  var addB = function(aid, seg) { (bnd[aid] = bnd[aid] || []).push(seg); };
  for (y = 0; y < H; y++) {
    for (x = 0; x < W; x++) {
      var a0 = at(x, y);
      if (!a0) continue;
      var nb = [[x, y - 1, 'n'], [x, y + 1, 's'], [x - 1, y, 'w'], [x + 1, y, 'e']];
      for (var k = 0; k < 4; k++) {
        var n = nb[k], b0 = at(n[0], n[1]);
        if (b0 === a0) continue;
        var seg = n[2] === 'n' ? [x, y, x + 1, y] : n[2] === 's' ? [x, y + 1, x + 1, y + 1]
                : n[2] === 'w' ? [x, y, x, y + 1] : [x + 1, y, x + 1, y + 1];
        addB(a0, seg);
        if (dk._edge[bdEdgeKey([x, y], [n[0], n[1]])]) continue;
        if (b0 && (n[2] === 'n' || n[2] === 'w')) continue;
        var outer = !b0;
        if (n[2] === 'n') (hs[y] = hs[y] || []).push([x, outer]);
        else if (n[2] === 's') (hs[y + 1] = hs[y + 1] || []).push([x, outer]);
        else if (n[2] === 'w') (vs[x] = vs[x] || []).push([y, outer]);
        else (vs[x + 1] = vs[x + 1] || []).push([y, outer]);
      }
    }
  }
  var merge = function(map, horiz) {
    Object.keys(map).forEach(function(kk) {
      var L = map[kk].sort(function(p, q) { return p[0] - q[0]; });
      for (var i = 0; i < L.length;) {
        var j = i; while (j + 1 < L.length && L[j + 1][0] === L[j][0] + 1 && L[j + 1][1] === L[i][1]) j++;
        var c = +kk;
        g.walls.push(horiz ? [L[i][0], c, L[j][0] + 1, c, L[i][1]] : [c, L[i][0], c, L[j][0] + 1, L[i][1]]);
        i = j + 1;
      }
    });
  };
  merge(hs, true); merge(vs, false);
  g.bound = bnd;

  // Двери: середина, направление проёма
  dk.doors.forEach(function(d) {
    var c1 = d.c1, c2 = d.c2, o;
    if (c1[0] === c2[0]) { var yy = Math.max(c1[1], c2[1]); o = { x0: c1[0], y0: yy, x1: c1[0] + 1, y1: yy, h: true }; }
    else { var xx = Math.max(c1[0], c2[0]); o = { x0: xx, y0: c1[1], x1: xx, y1: c1[1] + 1, h: false }; }
    o.mx = (o.x0 + o.x1) / 2; o.my = (o.y0 + o.y1) / 2; o.d = d;
    g.doors.push(o);
  });

  // Маяки тревоги: в коридорах у стены, через несколько клеток
  var rnd = bdcRng(bdcHash(dk.key || ('d' + dk.n)) ^ 77);
  g.areaList.forEach(function(a) {
    if (a.kind !== 'corr' && a.kind !== 'lock') return;
    var step = a.kind === 'lock' ? 99 : 7, cnt = 0;
    a.runs.forEach(function(r) {
      for (var cx = r[0]; cx < r[0] + r[2]; cx++) {
        var wallN = at(cx, r[1] - 1) !== a.id, wallS = at(cx, r[1] + 1) !== a.id;
        if (!(wallN || wallS)) continue;
        if (cnt++ % step !== 3) continue;
        g.beacons.push([cx + 0.5, wallN ? r[1] + 0.12 : r[1] + 0.88, rnd() * 6.28]);
      }
    });
    if (a.kind === 'lock') g.beacons.push([a.big[0] + 0.3, a.big[1] + 0.3, rnd() * 6.28]);
  });

  // Предметы: из props (v2) или из blocks/cover (v1)
  g.props = (dk.props || []).slice();
  if (!dk.props) {
    (dk.blocks || []).forEach(function(b) { g.props.push({ k: 'container', x: b[0], y: b[1], w: b[2], h: b[3], s: 'block' }); });
    (dk.cover || []).forEach(function(c) { g.props.push({ k: 'crate', x: c[0], y: c[1], w: 1, h: 1, s: 'cover' }); });
  }
  g.goalProps = g.props.filter(function(p) {
    if (p.k !== 'reactor' && p.k !== 'shieldcore' && p.k !== 'holo') return false;
    var a = g.areas[at(p.x, p.y)];
    return a && a.kind === 'goal';
  });
  dk._g = g;
  return g;
}

// ---------- неподвижный слой ----------

function bdcBuildArt(dk, faction) {
  var g = bdcGeom(dk);
  var P = BDC_PAD, W = dk.w, H = dk.h;
  // Плотность: сколько px холста на клетку; держим холст в разумных пределах памяти
  // ~6.5 Мпикс на чертёж: чётко на телефоне и не тяжело для памяти
  var A = Math.max(24, Math.min(64, Math.floor(Math.sqrt(6.5e6 / ((W + P * 2) * (H + P * 2)))), Math.floor(4096 / (W + P * 2))));
  var cv = document.createElement('canvas');
  cv.width = (W + P * 2) * A; cv.height = (H + P * 2) * A;
  var c = cv.getContext('2d');
  c.setTransform(A, 0, 0, A, P * A, P * A);
  c.lineJoin = 'round';
  var px = 1 / A;
  var liv = BDC_LIVERY[faction] || BDC_LIVERY.other;
  var rnd = bdcRng(bdcHash((dk.key || 'd') + ':' + dk.n + ':' + W));

  var hull = dk.hull;
  var outer = bdcOffsetPoly(hull, 0.85);
  var rim = bdcOffsetPoly(hull, 1.25);

  // --- дюзы за кормой (корма — x = 0) ---
  var engY = H > 20 ? [H * 0.24, H * 0.5, H * 0.76] : [H * 0.3, H * 0.7];
  engY.forEach(function(ey) {
    var len = P + 0.5, hw = H > 20 ? 2.3 : 1.9;
    var gr = c.createLinearGradient(-1, 0, -len - 1, 0);
    gr.addColorStop(0, 'rgba(170,215,255,0.55)');
    gr.addColorStop(0.35, 'rgba(80,150,255,0.22)');
    gr.addColorStop(1, 'rgba(40,90,255,0)');
    c.fillStyle = gr;
    c.beginPath();
    c.moveTo(-0.6, ey - hw); c.quadraticCurveTo(-len * 0.6, ey - hw * 0.8, -len - 1, ey);
    c.quadraticCurveTo(-len * 0.6, ey + hw * 0.8, -0.6, ey + hw); c.closePath(); c.fill();
    var rg = c.createRadialGradient(-1.2, ey, 0, -1.2, ey, hw * 1.4);
    rg.addColorStop(0, 'rgba(235,248,255,0.9)'); rg.addColorStop(0.3, 'rgba(120,190,255,0.45)'); rg.addColorStop(1, 'rgba(60,120,255,0)');
    c.fillStyle = rg; c.beginPath(); c.arc(-1.2, ey, hw * 1.4, 0, Math.PI * 2); c.fill();
    // Сопло
    var ng = c.createLinearGradient(0, ey - hw, 0, ey + hw);
    ng.addColorStop(0, '#1b2028'); ng.addColorStop(0.5, '#59636f'); ng.addColorStop(1, '#1b2028');
    c.fillStyle = ng; bdcRR(c, -1.5, ey - hw * 0.72, 2.1, hw * 1.44, 0.35); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 2 * px; c.stroke();
    c.fillStyle = '#cfe8ff'; bdcRR(c, -1.62, ey - hw * 0.5, 0.28, hw, 0.12); c.fill();
  });

  // --- обшивка ---
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.75)'; c.shadowBlur = A * 0.9; c.shadowOffsetY = A * 0.25;
  var hg = c.createLinearGradient(0, -1, 0, H + 1);
  hg.addColorStop(0, liv.hull[0]); hg.addColorStop(0.5, liv.hull[1]); hg.addColorStop(1, liv.hull[2]);
  c.fillStyle = hg; c.beginPath(); bdcPolyPath(c, rim); c.fill();
  c.restore();
  // Кромка
  c.strokeStyle = 'rgba(190,210,230,0.35)'; c.lineWidth = 1.5 * px; c.beginPath(); bdcPolyPath(c, rim); c.stroke();

  // Пояс обшивки: плиты, швы, надстройки
  c.save();
  c.beginPath(); bdcPolyPath(c, rim); bdcPolyPath(c, hull); c.clip('evenodd');
  for (var gx = -2; gx < W + 2; gx += 2) {
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 1.5 * px;
    c.beginPath(); c.moveTo(gx, -2); c.lineTo(gx, H + 2); c.stroke();
  }
  for (var gy = -2; gy < H + 2; gy += 1.5) {
    c.strokeStyle = 'rgba(255,255,255,0.05)'; c.lineWidth = px;
    c.beginPath(); c.moveTo(-2, gy); c.lineTo(W + 2, gy); c.stroke();
  }
  for (var i = 0; i < W * 3; i++) {
    var rx = -1 + rnd() * (W + 2), ry = -1.3 + rnd() * (H + 2.6);
    var rw = 0.3 + rnd() * 1.4, rh = 0.2 + rnd() * 0.5;
    c.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.07)';
    c.fillRect(rx, ry, rw, rh);
  }
  // Полосы стороны у носа
  c.globalAlpha = 0.85;
  c.fillStyle = liv.stripe;
  c.fillRect(W * 0.62, -2, 0.55, H + 4);
  c.fillRect(W * 0.62 + 0.8, -2, 0.22, H + 4);
  c.globalAlpha = 1;
  c.restore();

  // Внутренняя кромка корпуса
  c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 0.18; c.beginPath(); bdcPolyPath(c, outer); c.stroke();

  // --- машинное нутро между отсеками ---
  c.fillStyle = '#06090e'; c.beginPath(); bdcPolyPath(c, hull); c.fill();
  c.save(); c.beginPath(); bdcPolyPath(c, hull); c.clip();
  c.strokeStyle = 'rgba(90,120,150,0.07)'; c.lineWidth = 0.08;
  for (var d0 = -H; d0 < W + H; d0 += 0.5) { c.beginPath(); c.moveTo(d0, 0); c.lineTo(d0 + H, H); c.stroke(); }
  c.restore();

  // --- полы отсеков ---
  g.areaList.forEach(function(a) { bdcFloor(c, dk, g, a, px, rnd, liv); });

  // --- лазы ---
  (dk.ducts || []).forEach(function(du) {
    c.save();
    c.strokeStyle = 'rgba(138,111,208,0.28)'; c.lineWidth = 0.42; c.lineCap = 'round';
    c.beginPath();
    du.path.forEach(function(p, k) { if (k) c.lineTo(p[0] + 0.5, p[1] + 0.5); else c.moveTo(p[0] + 0.5, p[1] + 0.5); });
    c.stroke();
    c.strokeStyle = 'rgba(185,163,242,0.55)'; c.lineWidth = 0.07; c.setLineDash([0.25, 0.18]);
    c.stroke(); c.setLineDash([]);
    c.restore();
    [du.a, du.b].forEach(function(e) { bdcVent(c, e[0], e[1], px); });
  });

  // --- предметы ---
  g.props.forEach(function(p) { bdcProp(c, dk, g, p, px, rnd, liv); });

  // --- стены ---
  c.lineCap = 'square';
  var wallPass = function(w, col, off) {
    c.strokeStyle = col; c.lineWidth = w;
    c.beginPath();
    g.walls.forEach(function(s) { c.moveTo(s[0] + off, s[1] + off); c.lineTo(s[2] + off, s[3] + off); });
    c.stroke();
  };
  c.save(); c.shadowColor = 'rgba(0,0,0,0.8)'; c.shadowBlur = A * 0.35; c.shadowOffsetY = A * 0.06;
  wallPass(0.34, '#05070b', 0);
  c.restore();
  wallPass(0.26, '#2d3a49', 0);
  wallPass(0.1, '#465a6f', -0.04);
  wallPass(0.03, 'rgba(160,190,220,0.55)', -0.08);
  // Внешние стены толще
  c.strokeStyle = '#0a0e14'; c.lineWidth = 0.12; c.beginPath();
  g.walls.forEach(function(s) { if (s[4]) { c.moveTo(s[0], s[1]); c.lineTo(s[2], s[3]); } });
  c.stroke();

  // --- косяки дверей ---
  g.doors.forEach(function(o) {
    if (o.d.kind === 'lift') return;
    var t = o.d.kind === 'door' ? 0.16 : 0.22;
    [[o.x0, o.y0], [o.x1, o.y1]].forEach(function(e) {
      c.fillStyle = '#5b6b7d';
      c.fillRect(e[0] - t, e[1] - t, t * 2, t * 2);
      c.fillStyle = 'rgba(0,0,0,0.5)';
      c.fillRect(e[0] - t * 0.5, e[1] - t * 0.5, t, t);
    });
    // Порог
    c.fillStyle = o.d.kind === 'blast' ? 'rgba(224,138,44,0.22)' : o.d.kind === 'lock' ? 'rgba(31,157,138,0.25)' : 'rgba(143,168,196,0.12)';
    if (o.h) c.fillRect(o.x0 + 0.1, o.y0 - 0.12, 0.8, 0.24); else c.fillRect(o.x0 - 0.12, o.y0 + 0.1, 0.24, 0.8);
  });

  // --- стыковочные кольца снаружи ---
  (dk.ports || []).forEach(function(p) {
    var oy = p.side === 'n' ? -1 : 1;
    var ey = p.side === 'n' ? p.y : p.y + 1;
    var cx = p.x + 0.5;
    c.fillStyle = '#3a4757';
    bdcRR(c, cx - 1.3, p.side === 'n' ? ey - 1.6 : ey + 0.2, 2.6, 1.4, 0.3); c.fill();
    c.strokeStyle = 'rgba(95,224,203,0.6)'; c.lineWidth = 0.08;
    c.beginPath(); c.arc(cx, ey + oy * 0.9, 0.7, 0, Math.PI * 2); c.stroke();
    c.fillStyle = 'rgba(8,20,22,0.9)'; c.beginPath(); c.arc(cx, ey + oy * 0.9, 0.55, 0, Math.PI * 2); c.fill();
  });

  // --- люки ---
  (dk.hatches || []).forEach(function(h) {
    var cx = h.x + 0.5, cy = h.y + 0.5;
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = A * 0.15;
    c.fillStyle = '#2a2438'; c.beginPath(); c.arc(cx, cy, 0.44, 0, Math.PI * 2); c.fill();
    c.restore();
    c.save(); c.beginPath(); c.arc(cx, cy, 0.44, 0, Math.PI * 2); c.arc(cx, cy, 0.33, 0, Math.PI * 2, true); c.clip();
    for (var k = 0; k < 12; k++) {
      c.fillStyle = k % 2 ? '#141018' : '#d9a940';
      c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, 0.5, k * Math.PI / 6, (k + 1) * Math.PI / 6); c.fill();
    }
    c.restore();
    var hg2 = c.createRadialGradient(cx - 0.1, cy - 0.1, 0, cx, cy, 0.33);
    hg2.addColorStop(0, '#4b4166'); hg2.addColorStop(1, '#1a1526');
    c.fillStyle = hg2; c.beginPath(); c.arc(cx, cy, 0.31, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(185,163,242,0.7)'; c.lineWidth = 0.035;
    c.beginPath(); c.moveTo(cx - 0.2, cy); c.lineTo(cx + 0.2, cy); c.moveTo(cx, cy - 0.2); c.lineTo(cx, cy + 0.2); c.stroke();
  });

  return { cv: cv, A: A, P: P };
}

// Пол отсека: основа, отделка, лампы, затенение у стен
function bdcFloor(c, dk, g, a, px, rnd, liv) {
  var th = a.theme, tk = a.themeKey;
  var path = new Path2D();
  a.runs.forEach(function(r) { path.rect(r[0], r[1], r[2], r[3]); });
  c.save();
  c.clip(path);
  c.fillStyle = th.floor; c.fillRect(a.minx, a.miny, a.maxx - a.minx + 1, a.maxy - a.miny + 1);

  var bx = a.minx, by = a.miny, bw = a.maxx - a.minx + 1, bh = a.maxy - a.miny + 1;
  var x, y;

  if (a.kind === 'corr' || tk === 'pods') {
    // Настил: решётка по оси коридора, плиты по краям
    var horiz = bw >= bh;
    c.fillStyle = 'rgba(0,0,0,0.25)';
    a.runs.forEach(function(r) { c.fillRect(r[0], r[1] + 0.08, r[2], 0.84); });
    c.strokeStyle = 'rgba(140,170,200,0.07)'; c.lineWidth = 0.04;
    c.beginPath();
    for (x = bx; x <= bx + bw; x += 0.25) { c.moveTo(x, by); c.lineTo(x, by + bh); }
    if (!horiz) for (y = by; y <= by + bh; y += 0.25) { c.moveTo(bx, y); c.lineTo(bx + bw, y); }
    c.stroke();
  } else if (tk === 'lift') {
    var lx = bx + bw / 2, ly = by + bh / 2;
    var lg = c.createRadialGradient(lx, ly, 0, lx, ly, bw * 0.7);
    lg.addColorStop(0, '#2a3a50'); lg.addColorStop(1, '#101722');
    c.fillStyle = lg; c.fillRect(bx, by, bw, bh);
    c.strokeStyle = 'rgba(143,182,224,0.35)'; c.lineWidth = 0.05;
    for (var rr = 0.3; rr < bw * 0.6; rr += 0.25) { c.beginPath(); c.arc(lx, ly, rr, 0, Math.PI * 2); c.stroke(); }
    c.strokeStyle = 'rgba(217,169,64,0.65)'; c.lineWidth = 0.09; c.setLineDash([0.22, 0.16]);
    c.strokeRect(bx + 0.14, by + 0.14, bw - 0.28, bh - 0.28); c.setLineDash([]);
  } else {
    // Плитка 1×1 с фаской
    for (y = by; y < by + bh; y++) {
      for (x = bx; x < bx + bw; x++) {
        if (g.at(x, y) !== a.id) continue;
        var k = ((x * 7 + y * 13) % 5) / 5;
        c.fillStyle = 'rgba(255,255,255,' + (0.012 + k * 0.018) + ')';
        c.fillRect(x + 0.04, y + 0.04, 0.92, 0.92);
        c.fillStyle = 'rgba(255,255,255,0.045)'; c.fillRect(x + 0.04, y + 0.04, 0.92, 0.04);
        c.fillStyle = 'rgba(0,0,0,0.32)'; c.fillRect(x + 0.04, y + 0.92, 0.92, 0.04);
      }
    }
  }

  // Отделка по назначению
  var cx0 = a.big[0] + a.big[2] / 2, cy0 = a.big[1] + a.big[3] / 2;
  if (tk === 'hold' || tk === 'workshop') {
    c.strokeStyle = 'rgba(217,169,64,0.35)'; c.lineWidth = 0.08; c.setLineDash([0.4, 0.3]);
    // Разметка — по основному прямоугольнику отсека
    c.strokeRect(a.big[0] + 0.5, a.big[1] + 0.5, a.big[2] - 1, a.big[3] - 1);
    c.setLineDash([]);
  } else if (tk === 'hangar') {
    c.strokeStyle = 'rgba(217,169,64,0.5)'; c.lineWidth = 0.1;
    [a.big].forEach(function(r) {
      c.strokeRect(r[0] + 0.6, r[1] + 0.6, r[2] - 1.2, r[3] - 1.2);
      for (var hx = r[0] + 3; hx < r[0] + r[2] - 2; hx += 4) {
        c.beginPath(); c.moveTo(hx, r[1] + 0.6); c.lineTo(hx + 0.6, r[1] + 1.2); c.lineTo(hx + 1.2, r[1] + 0.6); c.stroke();
      }
    });
    c.strokeStyle = 'rgba(223,232,242,0.12)'; c.lineWidth = 0.06;
    for (x = bx; x <= bx + bw; x += 3) { c.beginPath(); c.moveTo(x, by); c.lineTo(x, by + bh); c.stroke(); }
  } else if (tk === 'reactor') {
    var rp = g.props.filter(function(p) { return p.k === 'reactor'; })[0];
    var rcx = rp ? rp.x + rp.w / 2 : cx0, rcy = rp ? rp.y + rp.h / 2 : cy0;
    var rgr = c.createRadialGradient(rcx, rcy, 0, rcx, rcy, Math.max(bw, bh) * 0.6);
    rgr.addColorStop(0, 'rgba(255,120,40,0.35)'); rgr.addColorStop(0.5, 'rgba(255,90,30,0.1)'); rgr.addColorStop(1, 'rgba(255,90,30,0)');
    c.fillStyle = rgr; c.fillRect(bx, by, bw, bh);
    c.strokeStyle = 'rgba(224,138,44,0.55)'; c.lineWidth = 0.12; c.setLineDash([0.35, 0.25]);
    c.beginPath(); c.ellipse(rcx, rcy, (rp ? rp.w : 4) / 2 + 1.1, (rp ? rp.h : 4) / 2 + 1.1, 0, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
  } else if (tk === 'bridge') {
    var hp = g.props.filter(function(p) { return p.k === 'holo' && g.at(p.x, p.y) === a.id; })[0];
    var bcx = hp ? hp.x + hp.w / 2 : cx0, bcy = hp ? hp.y + hp.h / 2 : cy0;
    var bgr = c.createRadialGradient(bcx, bcy, 0, bcx, bcy, Math.max(bw, bh) * 0.7);
    bgr.addColorStop(0, 'rgba(90,166,255,0.25)'); bgr.addColorStop(1, 'rgba(90,166,255,0)');
    c.fillStyle = bgr; c.fillRect(bx, by, bw, bh);
    c.strokeStyle = 'rgba(90,166,255,0.14)'; c.lineWidth = 0.05;
    for (var an = 0; an < 24; an++) {
      var aa = an * Math.PI / 12;
      c.beginPath(); c.moveTo(bcx + Math.cos(aa) * 1.8, bcy + Math.sin(aa) * 1.8); c.lineTo(bcx + Math.cos(aa) * 12, bcy + Math.sin(aa) * 12); c.stroke();
    }
    [2.6, 3.6, 4.8].forEach(function(r0) { c.beginPath(); c.arc(bcx, bcy, r0, 0, Math.PI * 2); c.stroke(); });
  } else if (tk === 'shield') {
    g.props.forEach(function(p) {
      if (p.k !== 'shieldcore') return;
      var sx = p.x + p.w / 2, sy = p.y + p.h / 2;
      var sg = c.createRadialGradient(sx, sy, 0, sx, sy, 3.2);
      sg.addColorStop(0, 'rgba(70,212,255,0.3)'); sg.addColorStop(1, 'rgba(70,212,255,0)');
      c.fillStyle = sg; c.fillRect(sx - 3.2, sy - 3.2, 6.4, 6.4);
      c.strokeStyle = 'rgba(70,212,255,0.3)'; c.lineWidth = 0.06;
      for (var hx2 = 0; hx2 < 6; hx2++) {
        var a2 = hx2 * Math.PI / 3;
        c.beginPath(); c.moveTo(sx + Math.cos(a2) * 2.1, sy + Math.sin(a2) * 2.1);
        c.lineTo(sx + Math.cos(a2 + Math.PI / 3) * 2.1, sy + Math.sin(a2 + Math.PI / 3) * 2.1); c.stroke();
      }
    });
  } else if (tk === 'plaza') {
    var pr = Math.min(a.big[2], a.big[3]) * 0.42;
    c.strokeStyle = bdcAlpha(liv.stripe, 0.32); c.lineWidth = 0.14;
    c.beginPath(); c.arc(cx0, cy0, pr, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 0.06; c.beginPath(); c.arc(cx0, cy0, pr * 0.72, 0, Math.PI * 2); c.stroke();
    for (var sp = 0; sp < 8; sp++) {
      var a3 = sp * Math.PI / 4;
      c.beginPath(); c.moveTo(cx0 + Math.cos(a3) * pr * 0.25, cy0 + Math.sin(a3) * pr * 0.25);
      c.lineTo(cx0 + Math.cos(a3) * pr * 0.72, cy0 + Math.sin(a3) * pr * 0.72); c.stroke();
    }
  } else if (tk === 'med') {
    c.fillStyle = 'rgba(127,240,220,0.06)'; c.fillRect(bx, by, bw, bh);
    c.strokeStyle = 'rgba(127,240,220,0.2)'; c.lineWidth = 0.1;
    c.beginPath(); c.moveTo(cx0 - 0.6, cy0); c.lineTo(cx0 + 0.6, cy0); c.moveTo(cx0, cy0 - 0.6); c.lineTo(cx0, cy0 + 0.6); c.stroke();
  } else if (tk === 'lock') {
    c.fillStyle = 'rgba(95,224,203,0.05)'; c.fillRect(bx, by, bw, bh);
  }

  // Лампы под потолком
  c.globalCompositeOperation = 'lighter';
  a.rects.forEach(function(r) {
    var step = a.kind === 'corr' ? 4 : 4.5;
    var nx = Math.max(1, Math.round(r[2] / step)), ny = Math.max(1, Math.round(r[3] / step));
    for (var i = 0; i < nx; i++) {
      for (var j = 0; j < ny; j++) {
        var lx2 = r[0] + (i + 0.5) * r[2] / nx, ly2 = r[1] + (j + 0.5) * r[3] / ny;
        var rad = Math.max(1.6, Math.min(3.4, Math.min(r[2] / nx, r[3] / ny) * 0.95));
        var lg2 = c.createRadialGradient(lx2, ly2, 0, lx2, ly2, rad);
        lg2.addColorStop(0, bdcAlpha(th.light, a.kind === 'corr' ? 0.15 : 0.2));
        lg2.addColorStop(1, bdcAlpha(th.light, 0));
        c.fillStyle = lg2; c.fillRect(lx2 - rad, ly2 - rad, rad * 2, rad * 2);
      }
    }
  });
  c.globalCompositeOperation = 'source-over';

  // Затенение у стен и световая кромка
  var bp = new Path2D();
  (g.bound[a.id] || []).forEach(function(s) { bp.moveTo(s[0], s[1]); bp.lineTo(s[2], s[3]); });
  c.lineCap = 'square';
  c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = 1.0; c.stroke(bp);
  c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 0.5; c.stroke(bp);
  if (a.kind === 'corr' || a.kind === 'lock' || tk === 'bridge') {
    c.strokeStyle = bdcAlpha(th.light, 0.22); c.lineWidth = 0.62; c.stroke(bp);
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.5; c.stroke(bp);
  }
  if (a.kind === 'lock') {
    c.save();
    c.lineWidth = 0.44; c.setLineDash([0.2, 0.2]);
    c.strokeStyle = 'rgba(217,169,64,0.55)'; c.stroke(bp);
    c.setLineDash([]); c.restore();
  }
  c.restore();
}

function bdcVent(c, x, y, px) {
  c.fillStyle = '#1a1526'; c.fillRect(x + 0.18, y + 0.18, 0.64, 0.64);
  c.strokeStyle = 'rgba(185,163,242,0.6)'; c.lineWidth = 0.04;
  c.strokeRect(x + 0.18, y + 0.18, 0.64, 0.64);
  c.beginPath();
  for (var i = 1; i < 4; i++) { c.moveTo(x + 0.22, y + 0.18 + i * 0.16); c.lineTo(x + 0.78, y + 0.18 + i * 0.16); }
  c.stroke();
}

// ---------- предметы ----------

function bdcProp(c, dk, g, p, px, rnd, liv) {
  var x = p.x, y = p.y, w = p.w, h = p.h, k = p.k;
  var a = g.areas[g.at(x, y)];
  var th = a ? a.theme : BDC_THEME.room;
  var hz = w >= h;
  c.save();
  if (k !== 'pipe') { c.shadowColor = 'rgba(0,0,0,0.65)'; c.shadowBlur = 0.25 / px; c.shadowOffsetX = 0.06 / px; c.shadowOffsetY = 0.1 / px; }
  var metal = function(x0, y0, w0, h0, c1, c2) {
    var gr = hz ? c.createLinearGradient(0, y0, 0, y0 + h0) : c.createLinearGradient(x0, 0, x0 + w0, 0);
    gr.addColorStop(0, c1); gr.addColorStop(0.5, c2); gr.addColorStop(1, c1);
    return gr;
  };
  var noShadow = function() { c.shadowColor = 'transparent'; };
  var cx = x + w / 2, cy = y + h / 2;

  switch (k) {
    case 'console': {
      c.fillStyle = metal(x, y, w, h, '#1d2631', '#3a4757'); bdcRR(c, x + 0.1, y + 0.12, w - 0.2, h - 0.24, 0.12); c.fill();
      noShadow();
      c.fillStyle = bdcAlpha(th.light, 0.85);
      if (hz) bdcRR(c, x + 0.18, y + 0.22, w - 0.36, 0.26, 0.06); else bdcRR(c, x + 0.22, y + 0.18, 0.26, h - 0.36, 0.06);
      c.fill();
      c.fillStyle = bdcAlpha(th.light, 0.25); c.fillRect(x + 0.1, y + 0.1, w - 0.2, 0.03);
      for (var i = 0; i < 3; i++) {
        c.fillStyle = ['#ff5a4f', '#5fd968', '#d9a940'][i];
        c.fillRect(x + 0.24 + i * 0.18, y + h - 0.36, 0.08, 0.08);
      }
      break;
    }
    case 'chair': {
      c.fillStyle = '#2f3b4a'; bdcRR(c, x + 0.24, y + 0.24, 0.52, 0.52, 0.16); c.fill();
      noShadow();
      c.fillStyle = '#4b5a6c'; bdcRR(c, x + 0.3, y + 0.3, 0.4, 0.4, 0.12); c.fill();
      break;
    }
    case 'crate': {
      c.fillStyle = metal(x, y, w, h, '#3c4754', '#56636f'); bdcRR(c, x + 0.13, y + 0.13, w - 0.26, h - 0.26, 0.05); c.fill();
      noShadow();
      c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.05;
      c.beginPath(); c.moveTo(x + 0.18, y + 0.18); c.lineTo(x + w - 0.18, y + h - 0.18);
      c.moveTo(x + w - 0.18, y + 0.18); c.lineTo(x + 0.18, y + h - 0.18); c.stroke();
      c.strokeStyle = 'rgba(217,169,64,0.55)'; c.lineWidth = 0.05; c.strokeRect(x + 0.16, y + 0.16, w - 0.32, h - 0.32);
      break;
    }
    case 'table': {
      if (w === 1 && h === 1) { c.fillStyle = '#2a3542'; c.beginPath(); c.arc(cx, cy, 0.36, 0, Math.PI * 2); c.fill(); noShadow();
        c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 0.04; c.beginPath(); c.arc(cx, cy, 0.3, 0, Math.PI * 2); c.stroke(); break; }
      c.fillStyle = metal(x, y, w, h, '#26303c', '#364352'); bdcRR(c, x + 0.1, y + 0.14, w - 0.2, h - 0.28, 0.12); c.fill();
      noShadow();
      c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(x + 0.16, y + 0.18, w - 0.32, 0.04);
      for (var t = 0; t < Math.max(w, h) - 0.5; t += 1) {
        c.fillStyle = 'rgba(207,216,220,0.25)';
        if (hz) c.fillRect(x + 0.4 + t, cy - 0.08, 0.2, 0.16); else c.fillRect(cx - 0.08, y + 0.4 + t, 0.16, 0.2);
      }
      break;
    }
    case 'counter': {
      c.fillStyle = metal(x, y, w, h, '#2b3440', '#45525f'); c.fillRect(x + 0.05, y + 0.1, w - 0.1, h - 0.2); noShadow();
      for (var s2 = 0.5; s2 < w; s2 += 1.6) { c.fillStyle = '#10161e'; c.beginPath(); c.ellipse(x + s2 + 0.3, cy, 0.24, 0.18, 0, 0, Math.PI * 2); c.fill(); }
      break;
    }
    case 'locker': {
      c.fillStyle = metal(x, y, w, h, '#2c3744', '#465566'); c.fillRect(x + 0.12, y + 0.08, w - 0.24, h - 0.16); noShadow();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.04;
      c.beginPath(); c.moveTo(cx, y + 0.1); c.lineTo(cx, y + h - 0.1); c.stroke();
      c.fillStyle = 'rgba(95,217,104,0.8)'; c.fillRect(cx - 0.12, y + 0.2, 0.06, 0.06);
      break;
    }
    case 'bench': {
      c.fillStyle = '#3a4757'; bdcRR(c, x + 0.08, y + 0.3, w - 0.16, h - 0.6, 0.08); c.fill(); break;
    }
    case 'barrier': {
      c.fillStyle = metal(x, y, w, h, '#2e3946', '#4d5b6a'); bdcRR(c, x + 0.12, y + 0.12, w - 0.24, h - 0.24, 0.08); c.fill(); noShadow();
      c.save(); bdcRR(c, x + 0.12, y + 0.12, w - 0.24, h - 0.24, 0.08); c.clip();
      for (var b = -3; b < w + h + 3; b += 0.4) {
        c.fillStyle = 'rgba(217,169,64,0.55)'; c.beginPath();
        c.moveTo(x + b, y); c.lineTo(x + b + 0.2, y); c.lineTo(x + b + 0.2 - h, y + h); c.lineTo(x + b - h, y + h); c.fill();
      }
      c.restore();
      c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 0.05; bdcRR(c, x + 0.12, y + 0.12, w - 0.24, h - 0.24, 0.08); c.stroke();
      break;
    }
    case 'sandbag': {
      c.fillStyle = '#6b6047';
      var n = Math.max(w, h) * 2;
      for (var s3 = 0; s3 < n; s3++) {
        var bx = hz ? x + 0.25 + s3 * (w - 0.5) / (n - 1 || 1) : cx;
        var by = hz ? cy : y + 0.25 + s3 * (h - 0.5) / (n - 1 || 1);
        c.beginPath(); c.ellipse(bx, by, hz ? 0.3 : 0.36, hz ? 0.36 : 0.3, 0, 0, Math.PI * 2); c.fill();
      }
      noShadow(); c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 0.03;
      for (var s4 = 0; s4 < n; s4++) {
        var bx2 = hz ? x + 0.25 + s4 * (w - 0.5) / (n - 1 || 1) : cx;
        var by2 = hz ? cy : y + 0.25 + s4 * (h - 0.5) / (n - 1 || 1);
        c.beginPath(); c.ellipse(bx2, by2, 0.22, 0.22, 0, 0, Math.PI * 2); c.stroke();
      }
      break;
    }
    case 'cart': {
      c.fillStyle = '#4a5563'; c.fillRect(x + 0.2, y + 0.18, 0.6, 0.6); noShadow();
      c.fillStyle = '#10161e';
      [[0.22, 0.2], [0.72, 0.2], [0.22, 0.72], [0.72, 0.72]].forEach(function(q) { c.beginPath(); c.arc(x + q[0], y + q[1], 0.07, 0, 7); c.fill(); });
      c.fillStyle = '#d9a940'; c.fillRect(x + 0.3, y + 0.3, 0.4, 0.12);
      break;
    }
    case 'container': {
      var cols = ['#7a3b2e', '#2f5d7a', '#5c6331', '#4a4f57', '#7a5a2e'];
      var col = cols[(x * 3 + y * 5) % cols.length];
      c.fillStyle = metal(x, y, w, h, bdcMix(col, '#000000', 0.35), col);
      c.fillRect(x + 0.06, y + 0.06, w - 0.12, h - 0.12); noShadow();
      c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 0.05; c.beginPath();
      if (hz) for (var r1 = x + 0.3; r1 < x + w - 0.1; r1 += 0.22) { c.moveTo(r1, y + 0.1); c.lineTo(r1, y + h - 0.1); }
      else for (var r2 = y + 0.3; r2 < y + h - 0.1; r2 += 0.22) { c.moveTo(x + 0.1, r2); c.lineTo(x + w - 0.1, r2); }
      c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.75)';
      if (hz) c.fillRect(x + w * 0.35, cy - 0.12, w * 0.3, 0.24); else c.fillRect(cx - 0.12, y + h * 0.35, 0.24, h * 0.3);
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x + 0.06, y + 0.06, w - 0.12, 0.08);
      break;
    }
    case 'rack': {
      c.fillStyle = '#1e2731'; c.fillRect(x + 0.08, y + 0.08, w - 0.16, h - 0.16); noShadow();
      c.strokeStyle = '#4b5a6c'; c.lineWidth = 0.05; c.strokeRect(x + 0.08, y + 0.08, w - 0.16, h - 0.16);
      var cnt = Math.round((w + h) * 2.5);
      for (var it = 0; it < cnt; it++) {
        c.fillStyle = ['#5b6b7d', '#8a7d62', '#3d5770', '#a8322d', '#5c6331'][Math.floor(rnd() * 5)];
        var ix = x + 0.14 + rnd() * (w - 0.48), iy = y + 0.14 + rnd() * (h - 0.48);
        c.fillRect(ix, iy, 0.12 + rnd() * 0.2, 0.12 + rnd() * 0.2);
      }
      break;
    }
    case 'bunk': {
      c.fillStyle = '#2a323d'; bdcRR(c, x + 0.06, y + 0.12, w - 0.12, h - 0.24, 0.08); c.fill(); noShadow();
      c.fillStyle = '#4c5868'; bdcRR(c, x + 0.12, y + 0.18, w - 0.24, h - 0.36, 0.06); c.fill();
      c.fillStyle = '#a7b3c2';
      if (hz) bdcRR(c, x + 0.16, y + 0.24, 0.32, h - 0.48, 0.08); else bdcRR(c, x + 0.24, y + 0.16, w - 0.48, 0.32, 0.08);
      c.fill();
      c.fillStyle = bdcAlpha(liv.stripe, 0.7);
      if (hz) c.fillRect(x + w * 0.55, y + 0.18, w * 0.33, h - 0.36); else c.fillRect(x + 0.18, y + h * 0.55, w - 0.36, h * 0.33);
      break;
    }
    case 'pillar': {
      var pg = c.createRadialGradient(cx - 0.12, cy - 0.12, 0.05, cx, cy, 0.46);
      pg.addColorStop(0, '#6f8296'); pg.addColorStop(1, '#232c37');
      c.fillStyle = pg; c.beginPath(); c.arc(cx, cy, 0.44, 0, 7); c.fill(); noShadow();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.05; c.beginPath(); c.arc(cx, cy, 0.3, 0, 7); c.stroke();
      break;
    }
    case 'core': {
      c.fillStyle = '#1c2430'; bdcRR(c, x + 0.1, y + 0.1, w - 0.2, h - 0.2, 0.25); c.fill(); noShadow();
      var cg = c.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.42);
      cg.addColorStop(0, '#ffffff'); cg.addColorStop(0.35, bdcAlpha(th.light, 0.9)); cg.addColorStop(1, bdcAlpha(th.light, 0));
      c.fillStyle = cg; c.beginPath(); c.arc(cx, cy, Math.min(w, h) * 0.42, 0, 7); c.fill();
      c.strokeStyle = '#4b5a6c'; c.lineWidth = 0.08; c.beginPath(); c.arc(cx, cy, Math.min(w, h) * 0.38, 0, 7); c.stroke();
      break;
    }
    case 'engine': {
      var R = Math.min(w, h) / 2 - 0.08;
      var eg = c.createRadialGradient(cx - R * 0.3, cy - R * 0.3, 0.1, cx, cy, R);
      eg.addColorStop(0, '#5f6d7d'); eg.addColorStop(1, '#1b222b');
      c.fillStyle = eg; c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fill(); noShadow();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.06;
      for (var f = 0; f < 16; f++) {
        var fa = f * Math.PI / 8;
        c.beginPath(); c.moveTo(cx + Math.cos(fa) * R * 0.45, cy + Math.sin(fa) * R * 0.45); c.lineTo(cx + Math.cos(fa + 0.25) * R * 0.92, cy + Math.sin(fa + 0.25) * R * 0.92); c.stroke();
      }
      var eg2 = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.45);
      eg2.addColorStop(0, '#e8f4ff'); eg2.addColorStop(0.5, 'rgba(122,168,255,0.8)'); eg2.addColorStop(1, 'rgba(60,100,200,0.2)');
      c.fillStyle = eg2; c.beginPath(); c.arc(cx, cy, R * 0.45, 0, 7); c.fill();
      break;
    }
    case 'gun': {
      // Казённик орудия, ствол — к ближнему борту
      var up = cy < dk.h / 2;
      c.fillStyle = metal(x, y, w, h, '#2b343f', '#4f5d6c'); bdcRR(c, x + 0.08, y + 0.08, w - 0.16, h - 0.16, 0.25); c.fill(); noShadow();
      c.fillStyle = '#1a2129'; c.beginPath(); c.arc(cx, cy, Math.min(w, h) * 0.32, 0, 7); c.fill();
      c.fillStyle = '#5b6b7d';
      if (up) c.fillRect(cx - 0.12, y - 0.3, 0.24, h * 0.5 + 0.3); else c.fillRect(cx - 0.12, cy, 0.24, h * 0.5 + 0.3);
      c.fillStyle = 'rgba(255,90,79,0.8)'; c.beginPath(); c.arc(cx, cy, 0.1, 0, 7); c.fill();
      break;
    }
    case 'tank': {
      var tr = Math.min(w, h) / 2 - 0.1;
      var tg = c.createRadialGradient(cx - tr * 0.35, cy - tr * 0.35, 0.02, cx, cy, tr);
      tg.addColorStop(0, '#8a98a8'); tg.addColorStop(1, '#2a333e');
      c.fillStyle = tg;
      if (w === h) { c.beginPath(); c.arc(cx, cy, tr, 0, 7); c.fill(); }
      else { bdcRR(c, x + 0.1, y + 0.1, w - 0.2, h - 0.2, tr); c.fill(); }
      noShadow();
      c.strokeStyle = 'rgba(217,169,64,0.6)'; c.lineWidth = 0.05; c.beginPath(); c.arc(cx, cy, tr * 0.6, 0, 7); c.stroke();
      break;
    }
    case 'fighter': {
      c.translate(cx, cy);
      if (!hz) c.rotate(Math.PI / 2);
      var L = Math.max(w, h) * 0.48, Wd = Math.min(w, h) * 0.48;
      c.fillStyle = liv.craft;
      c.beginPath(); c.moveTo(L, 0); c.lineTo(-L * 0.6, -Wd * 0.22); c.lineTo(-L * 0.8, 0); c.lineTo(-L * 0.6, Wd * 0.22); c.closePath(); c.fill();
      noShadow();
      c.fillStyle = bdcMix(liv.craft, '#000000', 0.25);
      c.beginPath(); c.moveTo(-L * 0.1, -Wd * 0.18); c.lineTo(-L * 0.55, -Wd); c.lineTo(-L * 0.8, -Wd); c.lineTo(-L * 0.55, -Wd * 0.12); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(-L * 0.1, Wd * 0.18); c.lineTo(-L * 0.55, Wd); c.lineTo(-L * 0.8, Wd); c.lineTo(-L * 0.55, Wd * 0.12); c.closePath(); c.fill();
      c.fillStyle = liv.craft2; c.fillRect(-L * 0.3, -Wd * 0.08, L * 0.5, Wd * 0.16);
      c.fillStyle = '#1b3550'; c.beginPath(); c.ellipse(L * 0.3, 0, L * 0.18, Wd * 0.1, 0, 0, 7); c.fill();
      break;
    }
    case 'shuttle': {
      c.translate(cx, cy);
      if (!hz) c.rotate(Math.PI / 2);
      var L2 = Math.max(w, h) * 0.46, W2 = Math.min(w, h) * 0.46;
      c.fillStyle = liv.craft;
      c.beginPath(); c.moveTo(L2, 0); c.lineTo(L2 * 0.3, -W2 * 0.3); c.lineTo(-L2, -W2 * 0.3); c.lineTo(-L2, W2 * 0.3); c.lineTo(L2 * 0.3, W2 * 0.3); c.closePath(); c.fill();
      noShadow();
      c.fillStyle = bdcMix(liv.craft, '#000000', 0.2);
      c.beginPath(); c.moveTo(L2 * 0.05, -W2 * 0.3); c.lineTo(-L2 * 0.5, -W2); c.lineTo(-L2 * 0.8, -W2); c.lineTo(-L2 * 0.6, -W2 * 0.3); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(L2 * 0.05, W2 * 0.3); c.lineTo(-L2 * 0.5, W2); c.lineTo(-L2 * 0.8, W2); c.lineTo(-L2 * 0.6, W2 * 0.3); c.closePath(); c.fill();
      c.fillStyle = liv.craft2; c.fillRect(-L2 * 0.6, -W2 * 0.06, L2 * 1.1, W2 * 0.12);
      c.fillStyle = '#1b3550'; c.beginPath(); c.ellipse(L2 * 0.6, 0, L2 * 0.18, W2 * 0.16, 0, 0, 7); c.fill();
      c.fillStyle = 'rgba(160,210,255,0.7)'; c.fillRect(-L2 * 1.02, -W2 * 0.22, L2 * 0.06, W2 * 0.44);
      break;
    }
    case 'pod': {
      c.fillStyle = metal(x, y, w, h, '#3a4553', '#7a8796'); bdcRR(c, x + 0.1, y + 0.12, w - 0.2, h - 0.24, Math.min(w, h) * 0.4); c.fill(); noShadow();
      c.fillStyle = '#1b3550'; c.beginPath(); c.arc(hz ? x + w - 0.45 : cx, hz ? cy : y + h - 0.45, 0.16, 0, 7); c.fill();
      c.fillStyle = 'rgba(255,179,106,0.85)'; c.beginPath(); c.arc(hz ? x + 0.35 : cx, hz ? cy : y + 0.35, 0.07, 0, 7); c.fill();
      break;
    }
    case 'holo': {
      c.fillStyle = '#121a26'; bdcRR(c, x + 0.06, y + 0.06, w - 0.12, h - 0.12, 0.3); c.fill(); noShadow();
      c.strokeStyle = '#4b5a6c'; c.lineWidth = 0.06; bdcRR(c, x + 0.06, y + 0.06, w - 0.12, h - 0.12, 0.3); c.stroke();
      c.strokeStyle = 'rgba(90,166,255,0.45)'; c.lineWidth = 0.03;
      c.beginPath();
      for (var hx = x + 0.3; hx < x + w - 0.2; hx += 0.2) { c.moveTo(hx, y + 0.2); c.lineTo(hx, y + h - 0.2); }
      for (var hy = y + 0.3; hy < y + h - 0.2; hy += 0.2) { c.moveTo(x + 0.2, hy); c.lineTo(x + w - 0.2, hy); }
      c.stroke();
      break;
    }
    case 'reactor': {
      var RR = Math.min(w, h) / 2;
      c.fillStyle = '#20160f'; c.beginPath(); c.ellipse(cx, cy, w / 2, h / 2, 0, 0, 7); c.fill(); noShadow();
      c.strokeStyle = '#5b4a33'; c.lineWidth = 0.18; c.beginPath(); c.ellipse(cx, cy, w / 2 - 0.15, h / 2 - 0.15, 0, 0, 7); c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 0.06;
      for (var sg2 = 0; sg2 < 12; sg2++) {
        var a4 = sg2 * Math.PI / 6;
        c.beginPath(); c.moveTo(cx + Math.cos(a4) * (w / 2 - 0.3), cy + Math.sin(a4) * (h / 2 - 0.3));
        c.lineTo(cx + Math.cos(a4) * (w / 2), cy + Math.sin(a4) * (h / 2)); c.stroke();
      }
      var rg2 = c.createRadialGradient(cx, cy, 0, cx, cy, RR * 0.75);
      rg2.addColorStop(0, '#fffbe8'); rg2.addColorStop(0.3, '#ffc35a'); rg2.addColorStop(0.7, 'rgba(255,100,30,0.75)'); rg2.addColorStop(1, 'rgba(120,30,10,0.4)');
      c.fillStyle = rg2; c.beginPath(); c.ellipse(cx, cy, w / 2 - 0.5, h / 2 - 0.5, 0, 0, 7); c.fill();
      break;
    }
    case 'shieldcore': {
      var SR = Math.min(w, h) / 2 - 0.08;
      c.fillStyle = '#121c24'; c.beginPath(); c.arc(cx, cy, SR, 0, 7); c.fill(); noShadow();
      var sgr = c.createRadialGradient(cx - SR * 0.25, cy - SR * 0.25, 0, cx, cy, SR * 0.8);
      sgr.addColorStop(0, '#eaffff'); sgr.addColorStop(0.35, 'rgba(70,212,255,0.85)'); sgr.addColorStop(1, 'rgba(20,90,140,0.3)');
      c.fillStyle = sgr; c.beginPath(); c.arc(cx, cy, SR * 0.78, 0, 7); c.fill();
      c.strokeStyle = '#4b5a6c'; c.lineWidth = 0.12; c.beginPath(); c.arc(cx, cy, SR - 0.05, 0, 7); c.stroke();
      for (var q2 = 0; q2 < 4; q2++) {
        var a5 = q2 * Math.PI / 2 + Math.PI / 4;
        c.fillStyle = '#5b6b7d'; c.beginPath(); c.arc(cx + Math.cos(a5) * SR, cy + Math.sin(a5) * SR, 0.18, 0, 7); c.fill();
      }
      break;
    }
    case 'server': {
      c.fillStyle = '#141b25'; c.fillRect(x + 0.1, y + 0.06, w - 0.2, h - 0.12); noShadow();
      c.strokeStyle = '#3d4c5e'; c.lineWidth = 0.04; c.strokeRect(x + 0.1, y + 0.06, w - 0.2, h - 0.12);
      c.strokeStyle = 'rgba(0,0,0,0.6)'; c.beginPath();
      for (var sv = y + 0.25; sv < y + h - 0.1; sv += 0.2) { c.moveTo(x + 0.14, sv); c.lineTo(x + w - 0.14, sv); }
      c.stroke();
      for (var l = 0; l < (w + h) * 4; l++) {
        c.fillStyle = rnd() < 0.7 ? 'rgba(95,217,104,0.8)' : 'rgba(74,144,217,0.8)';
        c.fillRect(x + 0.16 + rnd() * (w - 0.36), y + 0.12 + rnd() * (h - 0.28), 0.05, 0.05);
      }
      break;
    }
    case 'torpedo': {
      c.translate(cx, cy);
      if (!hz) c.rotate(Math.PI / 2);
      var TL = Math.max(w, h) / 2 - 0.06;
      c.fillStyle = metal(-TL, -0.3, TL * 2, 0.6, '#3c4a2e', '#6b7a52'); bdcRR(c, -TL, -0.26, TL * 2, 0.52, 0.26); c.fill(); noShadow();
      c.fillStyle = '#a8322d'; c.fillRect(TL - 0.45, -0.26, 0.14, 0.52);
      c.fillStyle = '#2b343f'; c.beginPath(); c.moveTo(-TL, -0.4); c.lineTo(-TL + 0.35, -0.2); c.lineTo(-TL + 0.35, 0.2); c.lineTo(-TL, 0.4); c.closePath(); c.fill();
      break;
    }
    case 'gyro': {
      var GR = Math.min(w, h) / 2 - 0.1;
      c.strokeStyle = '#6f8296'; c.lineWidth = 0.14; c.beginPath(); c.arc(cx, cy, GR, 0, 7); c.stroke(); noShadow();
      c.lineWidth = 0.08; c.strokeStyle = '#8fa8c4';
      c.beginPath(); c.ellipse(cx, cy, GR * 0.75, GR * 0.35, Math.PI / 4, 0, 7); c.stroke();
      c.beginPath(); c.ellipse(cx, cy, GR * 0.75, GR * 0.35, -Math.PI / 4, 0, 7); c.stroke();
      c.fillStyle = '#d9a940'; c.beginPath(); c.arc(cx, cy, 0.14, 0, 7); c.fill();
      break;
    }
    case 'pump': {
      c.fillStyle = '#2a333e'; bdcRR(c, x + 0.1, y + 0.1, w - 0.2, h - 0.2, 0.15); c.fill(); noShadow();
      var pr2 = Math.min(w, h) * 0.3;
      c.fillStyle = '#4f5d6c'; c.beginPath(); c.arc(cx, cy, pr2, 0, 7); c.fill();
      c.fillStyle = '#a8322d'; c.beginPath(); c.arc(cx, cy, pr2 * 0.45, 0, 7); c.fill();
      c.strokeStyle = '#5b6b7d'; c.lineWidth = 0.14;
      c.beginPath(); c.moveTo(x + 0.1, cy); c.lineTo(x + w - 0.1, cy); c.stroke();
      break;
    }
    case 'bacta': {
      c.fillStyle = '#1e2731'; c.beginPath(); c.arc(cx, cy, 0.44, 0, 7); c.fill(); noShadow();
      var bg = c.createRadialGradient(cx - 0.1, cy - 0.1, 0, cx, cy, 0.34);
      bg.addColorStop(0, 'rgba(180,255,200,0.95)'); bg.addColorStop(1, 'rgba(40,160,90,0.7)');
      c.fillStyle = bg; c.beginPath(); c.arc(cx, cy, 0.34, 0, 7); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.7)';
      [[0.08, -0.1, 0.05], [-0.1, 0.06, 0.04], [0.04, 0.12, 0.03]].forEach(function(q) { c.beginPath(); c.arc(cx + q[0], cy + q[1], q[2], 0, 7); c.fill(); });
      break;
    }
    case 'pipe': {
      c.strokeStyle = '#2a3542'; c.lineWidth = 0.22; c.lineCap = 'round';
      c.beginPath();
      if (hz) { c.moveTo(x + 0.1, y + 0.3); c.lineTo(x + w - 0.1, y + 0.3); c.moveTo(x + 0.1, y + 0.68); c.lineTo(x + w - 0.1, y + 0.68); }
      else { c.moveTo(x + 0.3, y + 0.1); c.lineTo(x + 0.3, y + h - 0.1); c.moveTo(x + 0.68, y + 0.1); c.lineTo(x + 0.68, y + h - 0.1); }
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 0.05; c.stroke();
      c.fillStyle = '#4b5a6c';
      for (var j2 = 0.5; j2 < Math.max(w, h); j2 += 1.5) {
        if (hz) { c.fillRect(x + j2, y + 0.15, 0.1, 0.7); } else { c.fillRect(x + 0.15, y + j2, 0.7, 0.1); }
      }
      break;
    }
    default: {
      c.fillStyle = p.s === 'block' ? '#263241' : '#344456';
      bdcRR(c, x + 0.1, y + 0.1, w - 0.2, h - 0.2, 0.1); c.fill();
    }
  }
  c.restore();
}

// ---------- камера ----------

function bdcView() { return BDC.rot ? { a: BDC.vh, b: BDC.vw } : { a: BDC.vw, b: BDC.vh }; }

function bdcMinS() {
  var v = bdcView(), dk = BDC.dk;
  return Math.max(4, Math.min(v.a / (dk.w + 6), v.b / (dk.h + 3)));
}

// Предел крупности: не меньше полутора «всей палубы», даже на огромном экране
function bdcMaxS() { return Math.max(BDC_MAXS, bdcMinS() * 1.6); }

function bdcTacS() {
  return Math.min(bdcMaxS(), Math.max(bdcMinS() * 1.5, Math.min(46, Math.max(30, Math.min(BDC.vw, BDC.vh) / 10.5))));
}

function bdcClamp(cam) {
  var dk = BDC.dk, v = bdcView(), m = 1.5, mx = 3;
  cam.s = Math.max(bdcMinS(), Math.min(bdcMaxS(), cam.s));
  var ex = v.a / 2 / cam.s, ey = v.b / 2 / cam.s;
  if (dk.w + mx * 2 <= ex * 2) cam.cx = dk.w / 2; else cam.cx = Math.max(-mx + ex, Math.min(dk.w + mx - ex, cam.cx));
  if (dk.h + m * 2 <= ey * 2) cam.cy = dk.h / 2; else cam.cy = Math.max(-m + ey, Math.min(dk.h + m - ey, cam.cy));
  return cam;
}

function bdcToScreen(px, py, cam) {
  cam = cam || BDC.cam;
  var dx = (px - cam.cx) * cam.s, dy = (py - cam.cy) * cam.s;
  return BDC.rot ? [BDC.vw / 2 + dy, BDC.vh / 2 - dx] : [BDC.vw / 2 + dx, BDC.vh / 2 + dy];
}

function bdcToPlan(sx, sy, cam) {
  cam = cam || BDC.cam;
  var dx = (sx - BDC.vw / 2) / cam.s, dy = (sy - BDC.vh / 2) / cam.s;
  return BDC.rot ? [cam.cx - dy, cam.cy + dx] : [cam.cx + dx, cam.cy + dy];
}

function bdcZoomAt(sx, sy, s) {
  var p = bdcToPlan(sx, sy);
  var cam = BDC.cam;
  cam.s = Math.max(bdcMinS(), Math.min(bdcMaxS(), s));
  var dx = (sx - BDC.vw / 2) / cam.s, dy = (sy - BDC.vh / 2) / cam.s;
  if (BDC.rot) { cam.cx = p[0] + dy; cam.cy = p[1] - dx; } else { cam.cx = p[0] - dx; cam.cy = p[1] - dy; }
  bdcClamp(cam);
}

function bdcPan(dx, dy) {
  var cam = BDC.cam;
  if (BDC.rot) { cam.cy -= dx / cam.s; cam.cx += dy / cam.s; } else { cam.cx -= dx / cam.s; cam.cy -= dy / cam.s; }
  bdcClamp(cam);
}

// Плавный перелёт камеры
function bdcFly(cx, cy, s, now) {
  var to = bdcClamp({ cx: cx, cy: cy, s: s });
  if (now || bdcReduced()) { BDC.cam = to; BDC.fly = null; bdcDirty(); return; }
  BDC.fly = { from: { cx: BDC.cam.cx, cy: BDC.cam.cy, s: BDC.cam.s }, to: to, t0: performance.now(), dur: 340 };
  bdcDirty();
}

function bdcOverview(now) { var dk = BDC.dk; bdcFly(dk.w / 2, dk.h / 2, bdcMinS(), now); }

function bdcIsOverview() { return BDC.cam.s < bdcMinS() * 1.25; }

function bdcFocus(px, py, now) { bdcFly(px, py, Math.max(BDC.cam.s, bdcTacS()), now); }

function bdcToggleZoom() {
  if (!BDC || !BDC.dk) return;
  if (!bdcIsOverview()) { bdcOverview(); return; }
  var u = bdSel ? bdUnitById(bdSel) : null;
  var mine = u && u.deck === BDC.dk.n ? [u] : bdUnits(BDC.dk.n).filter(function(x) { return x.side === bdMine(); });
  if (mine.length) {
    var c = bdcCentroid(mine);
    bdcFly(c[0], c[1], bdcTacS());
  } else {
    bdcFly(BDC.cam.cx, BDC.cam.cy, bdcTacS());
  }
}

function bdcCentroid(list) {
  var sx = 0, sy = 0;
  list.forEach(function(u) { sx += u.x + 0.5; sy += u.y + 0.5; });
  return [sx / list.length, sy / list.length];
}

// ---------- запуск ----------

function bdcInit(view, onTap) {
  var cv = document.createElement('canvas');
  cv.id = 'bd-cv';
  view.appendChild(cv);
  BDC = {
    view: view, cv: cv, ctx: cv.getContext('2d'), dpr: 1, vw: 1, vh: 1, rot: true,
    dk: null, artKey: null, art: null, cam: { cx: 0, cy: 0, s: 20 }, fly: null,
    ptrs: {}, drag: null, vel: null, imgs: {}, doorAnim: {}, sparks: [],
    dirty: true, last: 0, onTap: onTap, tile: null, tilePat: null, reduce: bdcReduced(), mini: null
  };
  var tile = new Image();
  tile.onload = function() { BDC.tile = tile; BDC.tilePat = null; bdcDirty(); };
  tile.src = '../assets/ui/galaxy-bg-tile.png';
  bdcBindInput();
  bdcResize();
  requestAnimationFrame(bdcFrame);
}

function bdcResize() {
  if (!BDC) return;
  var r = BDC.view.getBoundingClientRect();
  var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  var rot = window.innerHeight >= window.innerWidth;
  var changed = w !== BDC.vw || h !== BDC.vh || dpr !== BDC.dpr || rot !== BDC.rot;
  if (!changed) return;
  var wasOver = !!(BDC.dk && bdcIsOverview());
  // Держим на месте середину плана
  if (rot !== BDC.rot && BDC.mini) { BDC.mini.width = BDC.mini.height = 0; BDC.mini = null; }
  BDC.vw = w; BDC.vh = h; BDC.dpr = dpr; BDC.rot = rot;
  BDC.cv.width = Math.round(w * dpr); BDC.cv.height = Math.round(h * dpr);
  BDC.cv.style.width = w + 'px'; BDC.cv.style.height = h + 'px';
  if (BDC.dk) {
    // Была вся палуба — остаётся вся палуба и после поворота экрана
    if (wasOver) bdcOverview(true); else bdcClamp(BDC.cam);
  }
  bdcDirty();
}

// Новая палуба: перерисовать чертёж, поставить камеру
function bdcSetDeck(dk, faction, place) {
  var key = (dk.key || 'd') + ':' + dk.n + ':' + dk.w + 'x' + dk.h + ':' + faction;
  var same = BDC.artKey === key;
  BDC.dk = dk;
  if (!same) {
    // Старый чертёж отпускаем сразу: iOS считает память холстов до сборки мусора
    if (BDC.art) BDC.art.cv.width = BDC.art.cv.height = 0;
    if (BDC.mini) BDC.mini.width = BDC.mini.height = 0;
    BDC.fogKey = null;
    BDC.art = bdcBuildArt(dk, faction);
    BDC.artKey = key;
    BDC.mini = null;
    BDC.doorAnim = {};
  }
  if (place === 'mine') {
    var mine = bdUnits(dk.n).filter(function(u) { return u.side === bdMine(); });
    if (mine.length) { var c = bdcCentroid(mine); bdcFly(c[0], c[1], bdcTacS(), true); }
    else bdcOverview(true);
  } else if (!same) {
    bdcOverview(true);
  }
  bdcClamp(BDC.cam);
  bdcDirty();
}

function bdcFocusUnit(u) {
  if (!u || !BDC.dk || u.deck !== BDC.dk.n) return;
  bdcKeepInView([[u.x, u.y]]);
}

// Клетки должны быть в кадре: у края или под мини-картой — ведём камеру к их середине
function bdcKeepInView(cells) {
  if (!BDC || !BDC.dk || !cells.length) return;
  var m = 52, mm = BDC.miniRect, bad = bdcIsOverview(), sx = 0, sy = 0;
  cells.forEach(function(p) {
    var q = bdcToScreen(p[0] + 0.5, p[1] + 0.5);
    if (q[0] < m || q[1] < m || q[0] > BDC.vw - m || q[1] > BDC.vh - m) bad = true;
    if (mm && q[0] > mm.x - 26 && q[1] < mm.y + mm.h + 26) bad = true;
    sx += p[0] + 0.5; sy += p[1] + 0.5;
  });
  if (bad) bdcFocus(sx / cells.length, sy / cells.length);
}

function bdcDirty() { if (BDC) BDC.dirty = true; }

// ---------- ввод: перетаскивание, щипок, колесо, касание ----------

function bdcBindInput() {
  var cv = BDC.cv;
  var pts = BDC.ptrs;
  var start = null;
  var pinch = null;
  var hist = [];

  var pos = function(e) { var r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  var ids = function() { return Object.keys(pts); };

  cv.addEventListener('pointerdown', function(e) {
    if (!BDC.dk) return;
    try { cv.setPointerCapture(e.pointerId); } catch (er) { /* ничего */ }
    pts[e.pointerId] = pos(e);
    BDC.vel = null; BDC.fly = null;
    var k = ids();
    if (k.length === 1) {
      start = { p: pts[e.pointerId].slice(), t: performance.now(), moved: false, unit: false };
      hist = [];
      // Палец на выбранном своём бойце — тянем бойца, а не карту
      if (BDC.onDrag && BDC.onDrag.start) {
        var q = bdcToPlan(start.p[0], start.p[1]);
        start.unit = !!BDC.onDrag.start([Math.floor(q[0]), Math.floor(q[1])]);
      }
    }
    if (k.length === 2) {
      var a = pts[k[0]], b = pts[k[1]];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s: BDC.cam.s, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      if (start) {
        start.moved = true;
        if (start.unit && BDC.onDrag.cancel) BDC.onDrag.cancel();
        start.unit = false;
      }
    }
  });

  cv.addEventListener('pointermove', function(e) {
    if (!pts[e.pointerId]) return;
    var p = pos(e), prev = pts[e.pointerId];
    pts[e.pointerId] = p;
    var k = ids();
    if (k.length >= 2 && pinch) {
      var a = pts[k[0]], b = pts[k[1]];
      var d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      var m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      bdcPan(m[0] - pinch.m[0], m[1] - pinch.m[1]);
      bdcZoomAt(m[0], m[1], pinch.s * d / pinch.d);
      pinch.m = m;
      bdcDirty();
      return;
    }
    if (!start) return;
    if (!start.moved && Math.hypot(p[0] - start.p[0], p[1] - start.p[1]) > 7) start.moved = true;
    if (start.unit) {
      if (start.moved) {
        var q2 = bdcToPlan(p[0], p[1]);
        BDC.onDrag.move([Math.floor(q2[0]), Math.floor(q2[1])], p);
      }
      return;
    }
    if (start.moved) {
      bdcPan(p[0] - prev[0], p[1] - prev[1]);
      var t = performance.now();
      hist.push([t, p[0] - prev[0], p[1] - prev[1]]);
      while (hist.length && t - hist[0][0] > 90) hist.shift();
      bdcDirty();
    }
  });

  var up = function(e) {
    if (!pts[e.pointerId]) return;
    var p = pos(e);
    delete pts[e.pointerId];
    var k = ids();
    if (k.length === 1) {
      // Из щипка в одиночное перетаскивание — без рывка
      pinch = null;
      start = { p: pts[k[0]].slice(), t: performance.now(), moved: true };
      hist = [];
      return;
    }
    if (k.length >= 2) {
      // Третий палец поднят — щипок заново от двух оставшихся
      var a2 = pts[k[0]], b2 = pts[k[1]];
      pinch = { d: Math.hypot(a2[0] - b2[0], a2[1] - b2[1]) || 1, s: BDC.cam.s, m: [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2] };
      return;
    }
    pinch = null;
    // Палец постоял перед отпусканием — старые замеры скорости не в счёт
    var now = performance.now();
    while (hist.length && now - hist[0][0] > 90) hist.shift();
    if (start && start.unit && start.moved) {
      var q3 = bdcToPlan(p[0], p[1]);
      if (e.type === 'pointerup') BDC.onDrag.end([Math.floor(q3[0]), Math.floor(q3[1])]);
      else if (BDC.onDrag.cancel) BDC.onDrag.cancel();
    } else if (start && !start.moved && e.type === 'pointerup') {
      bdcTapAt(p[0], p[1]);
    } else if (start && start.moved && hist.length > 1 && !BDC.reduce) {
      var dt = Math.max(16, hist[hist.length - 1][0] - hist[0][0]), vx = 0, vy = 0;
      hist.forEach(function(h) { vx += h[1]; vy += h[2]; });
      BDC.vel = [vx / dt * 16, vy / dt * 16];
    }
    start = null;
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  // Захват потерян без pointerup (системный жест, уход со страницы) — палец забываем
  cv.addEventListener('lostpointercapture', function(e) { if (pts[e.pointerId]) up(e); });

  cv.addEventListener('wheel', function(e) {
    if (!BDC.dk) return;
    e.preventDefault();
    var p = pos(e);
    BDC.fly = null;
    bdcZoomAt(p[0], p[1], BDC.cam.s * Math.exp(-e.deltaY * 0.0016));
    bdcDirty();
  }, { passive: false });
}

// Что под пальцем: мини-карта, боец, дверь, клетка
function bdcTapAt(sx, sy) {
  var mm = BDC.miniRect;
  if (mm && sx >= mm.x && sx <= mm.x + mm.w && sy >= mm.y && sy <= mm.y + mm.h) {
    var fx = (sx - mm.x) / mm.w, fy = (sy - mm.y) / mm.h;
    var dk0 = BDC.dk;
    var pxp = BDC.rot ? (1 - fy) * dk0.w : fx * dk0.w, pyp = BDC.rot ? fx * dk0.h : fy * dk0.h;
    bdcFly(pxp, pyp, BDC.cam.s);
    return;
  }
  var dk = BDC.dk, g = bdcGeom(dk), sc = BDC.cam.s;
  var p = bdcToPlan(sx, sy);
  var cx = Math.floor(p[0]), cy = Math.floor(p[1]);
  // Ближний боец и ближняя дверь — в пикселях экрана
  var unit = null, cell = null, ud = 1e9;
  bdUnits(dk.n).forEach(function(u) {
    if (u.x === cx && u.y === cy) cell = u;
    var d = Math.hypot(p[0] - (u.x + 0.5), p[1] - (u.y + 0.5)) * sc;
    if (d < ud) { ud = d; unit = u; }
  });
  var best = null, bd = 1e9;
  g.doors.forEach(function(o) {
    if (o.d.kind === 'lift') return;
    var d = Math.hypot(p[0] - o.mx, p[1] - o.my) * sc;
    if (d < bd) { bd = d; best = o; }
  });
  var finger = 18;                          // радиус пальца, px
  var tur = null;
  (dk.turrets || []).forEach(function(t) { if (t[0] === cx && t[1] === cy) tur = dk.n + ':' + t[0] + ':' + t[1]; });
  if (tur) { BDC.onTap({ turret: tur, cell: [cx, cy] }); return; }
  if (cell) {
    // Касание по клетке бойца: дверь — только если попали точно в её середину
    if (best && bd < Math.min(finger, sc * 0.2)) { BDC.onTap({ door: best.d.id }); return; }
    BDC.onTap({ unit: cell.id }); return;
  }
  // Пустая подсвеченная клетка хода важнее соседней двери и бойца рядом —
  // кроме точного попадания в середину двери или в фишку бойца
  var reach = BDC.ov && BDC.ov.reach ? BDC.ov.reach.cells : null;
  if (reach && reach.some(function(r) { return r[0] === cx && r[1] === cy; })) {
    if (best && bd < Math.min(finger, sc * 0.2)) { BDC.onTap({ door: best.d.id }); return; }
    if (unit && ud < Math.max(6, sc * 0.42)) { BDC.onTap({ unit: unit.id }); return; }
    BDC.onTap({ cell: [cx, cy] }); return;
  }
  if (unit && ud <= Math.max(finger, sc * 0.45) && (!best || ud <= bd)) { BDC.onTap({ unit: unit.id }); return; }
  if (best && bd <= Math.max(finger, sc * 0.48)) { BDC.onTap({ door: best.d.id }); return; }
  if (unit && ud <= Math.max(finger, sc * 0.45)) { BDC.onTap({ unit: unit.id }); return; }
  BDC.onTap({ cell: [cx, cy] });
}

// ---------- кадр ----------

function bdcFrame(t) {
  requestAnimationFrame(bdcFrame);
  if (!BDC || !BDC.dk || !bdState) return;
  var moving = false;
  // Шаг кадра в долях 16 мс: на 120 Гц инерция та же, что на 60 Гц
  var dt = Math.min(4, Math.max(0.25, (t - (BDC.tPrev || t - 16)) / 16));
  BDC.tPrev = t;
  if (BDC.fly) {
    var f = BDC.fly, k = Math.min(1, (t - f.t0) / f.dur), e = 1 - Math.pow(1 - k, 3);
    BDC.cam = { cx: f.from.cx + (f.to.cx - f.from.cx) * e, cy: f.from.cy + (f.to.cy - f.from.cy) * e, s: f.from.s + (f.to.s - f.from.s) * e };
    if (k >= 1) { BDC.cam = f.to; BDC.fly = null; }
    moving = true;
  }
  if (BDC.vel) {
    bdcPan(BDC.vel[0] * dt, BDC.vel[1] * dt);
    var dec = Math.pow(0.92, dt);
    BDC.vel[0] *= dec; BDC.vel[1] *= dec;
    if (Math.abs(BDC.vel[0]) + Math.abs(BDC.vel[1]) < 0.3) BDC.vel = null;
    moving = true;
  }
  var anim = bdcDoorStep() || bdcFxBusy();
  // Без движения — живой фон ~20 кадров в секунду
  var ambient = !BDC.reduce && t - BDC.last > 50;
  if (!(BDC.dirty || moving || anim || ambient)) return;
  BDC.last = t;
  BDC.dirty = false;
  bdcDraw(t / 1000);
}

// Створки едут к своему состоянию
function bdcDoorStep() {
  var dk = BDC.dk, any = false;
  dk.doors.forEach(function(d) {
    if (d.kind === 'lift') return;
    var st = bdDoorState(d);
    var target = (st === 'open' || st === 'broken') ? 1 : 0;
    var cur = BDC.doorAnim[d.id];
    if (cur === undefined || BDC.reduce) { BDC.doorAnim[d.id] = target; return; }
    if (Math.abs(cur - target) < 0.01) { BDC.doorAnim[d.id] = target; return; }
    BDC.doorAnim[d.id] = cur + (target - cur) * 0.2;
    any = true;
  });
  return any;
}

function bdcDraw(T) {
  var c = BDC.ctx, dk = BDC.dk, g = bdcGeom(dk), cam = BDC.cam, dpr = BDC.dpr;
  var vw = BDC.vw, vh = BDC.vh, s = cam.s;
  var vis = bdVisibleSet();
  var side = bdMine();
  var alarm = bdState.status === 'active' && bdState.alarm;

  // --- фон: звёздная плитка игры с лёгким параллаксом ---
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#04060b'; c.fillRect(0, 0, vw, vh);
  if (BDC.tile) {
    if (!BDC.tilePat) BDC.tilePat = c.createPattern(BDC.tile, 'repeat');
    var o = bdcToScreen(0, 0);
    c.save();
    c.translate((o[0] * 0.15) % BDC.tile.width, (o[1] * 0.15) % BDC.tile.height);
    c.globalAlpha = 0.9;
    c.fillStyle = BDC.tilePat; c.fillRect(-BDC.tile.width, -BDC.tile.height, vw + BDC.tile.width * 2, vh + BDC.tile.height * 2);
    c.restore();
  }

  // --- план ---
  c.save();
  c.translate(vw / 2, vh / 2);
  if (BDC.rot) c.rotate(-Math.PI / 2);
  c.scale(s, s);
  c.translate(-cam.cx, -cam.cy);
  var art = BDC.art;
  c.imageSmoothingEnabled = true;
  c.drawImage(art.cv, -art.P, -art.P, dk.w + art.P * 2, dk.h + art.P * 2);

  if (!BDC.reduce) bdcAmbient(c, dk, g, T, alarm);

  // Рукав атакующего у его шлюза
  bdcTube(c, dk, T);

  // Цели: золотая рамка
  g.goalProps.forEach(function(p) {
    c.save();
    c.strokeStyle = 'rgba(240,200,106,' + (0.55 + 0.25 * Math.sin(T * 2.2)) + ')';
    c.lineWidth = Math.max(0.05, 1.6 / s); c.setLineDash([0.3, 0.18]); c.lineDashOffset = -T * 0.6;
    bdcRR(c, p.x - 0.12, p.y - 0.12, p.w + 0.24, p.h + 0.24, 0.3); c.stroke();
    c.restore();
  });

  // Туман
  bdcFog(c, dk, g, vis, T);

  // Чьи отсеки, мостик под захватом, заряд в реакторе
  bdcGoalsPlan(c, dk, g, s, T);

  // Без света — темнота поверх палубы; подсветка хода, двери и бойцы — над ней
  c.save();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  bdcDarkness(c, dk, s, T);
  c.restore();

  // Куда дойдёт выбранный боец и путь до выбранной клетки
  bdcDrawReach(c, s, T);

  // Двери
  var u = bdSel ? bdUnitById(bdSel) : null;
  var adj = {};
  if (u && u.mine && u.deck === dk.n && bdState.status === 'active') {
    bdAdjDoors(u).forEach(function(d) { if (bdDoorActs(d, u).length) adj[d.id] = true; });
  }
  g.doors.forEach(function(o) { if (o.d.kind !== 'lift') bdcDoor(c, o, T, adj[o.d.id], bdSelDoor === o.d.id, s); });

  // Турели защиты
  (dk.turrets || []).forEach(function(tr, i) { bdcTurret(c, tr, side, T, i, dk.n); });

  // Выстрелы, взрывы, переходы
  var nowMs = performance.now();
  bdcDrawFxPlan(c, s, nowMs);

  // Клетка выбранного бойца
  if (u && u.deck === dk.n) {
    c.fillStyle = 'rgba(217,169,64,0.14)'; c.fillRect(u.x, u.y, 1, 1);
  }
  c.restore();

  // --- экранный слой: подписи, люки, лифты, бойцы ---
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  bdcLabels(c, dk, g, vis, s);
  bdcMarks(c, dk, s);
  var units = bdUnits(dk.n).slice().sort(function(a, b) { return (a.id === bdSel) - (b.id === bdSel); });
  units.forEach(function(x) { bdcToken(c, x, s, T, 1); });
  units.forEach(function(x) { bdcToken(c, x, s, T, 2); });
  bdcDrawTargets(c, s, T);
  bdcDrawPlanCost(c, s);
  bdcGoalsScreen(c, dk, g, s, T);
  // Учение: маяк у цели текущего шага (js/boarding-drill.js)
  if (typeof bddBeacon === 'function' && bdDrill()) bddBeacon(c, dk, s, T);

  // Тревога: красная кромка экрана
  if (alarm && !BDC.reduce) {
    var k = 0.08 + 0.08 * (0.5 + 0.5 * Math.sin(T * 3.4));
    var vg = c.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.45, vw / 2, vh / 2, Math.max(vw, vh) * 0.75);
    vg.addColorStop(0, 'rgba(255,40,30,0)'); vg.addColorStop(1, 'rgba(255,40,30,' + k + ')');
    c.fillStyle = vg; c.fillRect(0, 0, vw, vh);
  }
  // Виньетка
  var vg2 = c.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.55, vw / 2, vh / 2, Math.max(vw, vh) * 0.8);
  vg2.addColorStop(0, 'rgba(0,0,0,0)'); vg2.addColorStop(1, 'rgba(0,0,0,0.45)');
  c.fillStyle = vg2; c.fillRect(0, 0, vw, vh);

  bdcMini(c, dk, g, vis);
  bdcDarkBadge(c, dk);
  // Цифры урона — поверх мини-карты и виньетки, чтобы не терялись у края
  bdcDrawFxScreen(c, s, nowMs);

  // Кнопка масштаба: «+» — к своим, «−» — вся палуба
  var ov = bdcIsOverview();
  if (BDC.zoomOv !== ov) {
    BDC.zoomOv = ov;
    var zb = document.getElementById('bd-zoom');
    if (zb) { zb.textContent = ov ? '+' : '−'; zb.setAttribute('aria-label', ov ? 'Крупнее' : 'Вся палуба'); }
  }
}

// Живой фон: реактор, щиты, голограммы, двигатели, огни, тревога
function bdcAmbient(c, dk, g, T, alarm) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  g.props.forEach(function(p, i) {
    var cx = p.x + p.w / 2, cy = p.y + p.h / 2, r, gr;
    if (p.k === 'reactor') {
      r = Math.max(p.w, p.h) * 0.75;
      var k = 0.5 + 0.5 * Math.sin(T * 2.6) * Math.sin(T * 0.7 + 1);
      gr = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(255,200,110,' + (0.35 + 0.25 * k) + ')'); gr.addColorStop(1, 'rgba(255,90,30,0)');
      c.fillStyle = gr; c.fillRect(cx - r, cy - r, r * 2, r * 2);
      c.strokeStyle = 'rgba(255,170,80,0.45)'; c.lineWidth = 0.08;
      for (var q = 0; q < 3; q++) {
        var a0 = T * (0.8 + q * 0.35) + q * 2.1;
        c.beginPath(); c.ellipse(cx, cy, p.w / 2 - 0.25 - q * 0.35, p.h / 2 - 0.25 - q * 0.35, 0, a0, a0 + 1.6); c.stroke();
      }
    } else if (p.k === 'shieldcore') {
      r = Math.max(p.w, p.h) * 0.9;
      var k2 = 0.5 + 0.5 * Math.sin(T * 3 + i);
      gr = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(120,230,255,' + (0.25 + 0.2 * k2) + ')'); gr.addColorStop(1, 'rgba(70,212,255,0)');
      c.fillStyle = gr; c.fillRect(cx - r, cy - r, r * 2, r * 2);
      c.strokeStyle = 'rgba(140,235,255,0.55)'; c.lineWidth = 0.06;
      var a1 = T * 1.7 + i;
      c.beginPath(); c.arc(cx, cy, p.w * 0.42, a1, a1 + 1.2); c.stroke();
      c.beginPath(); c.arc(cx, cy, p.w * 0.42, a1 + Math.PI, a1 + Math.PI + 1.2); c.stroke();
    } else if (p.k === 'holo') {
      // Голограмма: вращающаяся сфера из колец
      var R = Math.min(p.w, p.h) * 0.42, fl = 0.75 + 0.25 * Math.sin(T * 13 + i) * Math.sin(T * 5.3);
      gr = c.createRadialGradient(cx, cy, 0, cx, cy, R * 1.8);
      gr.addColorStop(0, 'rgba(90,166,255,' + 0.22 * fl + ')'); gr.addColorStop(1, 'rgba(90,166,255,0)');
      c.fillStyle = gr; c.fillRect(cx - R * 1.8, cy - R * 1.8, R * 3.6, R * 3.6);
      c.strokeStyle = 'rgba(130,190,255,' + 0.6 * fl + ')'; c.lineWidth = 0.035;
      for (var m = 0; m < 4; m++) {
        var ph = T * 0.9 + m * Math.PI / 4;
        c.beginPath(); c.ellipse(cx, cy, R * Math.abs(Math.cos(ph)), R, 0, 0, Math.PI * 2); c.stroke();
      }
      c.beginPath(); c.ellipse(cx, cy, R, R * 0.35, 0, 0, Math.PI * 2); c.stroke();
    } else if (p.k === 'engine') {
      r = Math.min(p.w, p.h) * 0.5;
      var k3 = 0.6 + 0.4 * Math.sin(T * 9 + i * 1.7) * Math.sin(T * 3.1);
      gr = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(160,200,255,' + 0.35 * k3 + ')'); gr.addColorStop(1, 'rgba(80,130,255,0)');
      c.fillStyle = gr; c.fillRect(cx - r, cy - r, r * 2, r * 2);
    } else if (p.k === 'core') {
      r = Math.min(p.w, p.h) * 0.7;
      gr = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(255,230,160,' + (0.2 + 0.15 * Math.sin(T * 4 + i)) + ')'); gr.addColorStop(1, 'rgba(255,200,120,0)');
      c.fillStyle = gr; c.fillRect(cx - r, cy - r, r * 2, r * 2);
    } else if (p.k === 'server' || p.k === 'console') {
      // Мигание огоньков
      var seed = (p.x * 31 + p.y * 17) % 97;
      if (Math.sin(T * (2 + seed % 5) + seed) > 0.6) {
        c.fillStyle = seed % 3 ? 'rgba(95,217,104,0.9)' : 'rgba(255,90,79,0.9)';
        c.fillRect(p.x + 0.2 + (seed % 7) / 10 * (p.w - 0.4), p.y + 0.2 + (seed % 5) / 6 * (p.h - 0.4), 0.07, 0.07);
      }
    }
  });

  // Двигатели снаружи — дрожание пламени
  var H = dk.h;
  var engY = H > 20 ? [H * 0.24, H * 0.5, H * 0.76] : [H * 0.3, H * 0.7];
  engY.forEach(function(ey, i) {
    var k = 0.5 + 0.5 * Math.sin(T * 17 + i * 2) * Math.sin(T * 6.3 + i);
    var r = 2.2 + k * 0.6;
    var gr = c.createRadialGradient(-1.4, ey, 0, -1.4, ey, r);
    gr.addColorStop(0, 'rgba(200,230,255,' + (0.25 + 0.2 * k) + ')'); gr.addColorStop(1, 'rgba(80,140,255,0)');
    c.fillStyle = gr; c.fillRect(-1.4 - r, ey - r, r * 2, r * 2);
  });

  // Ходовые огни: левый борт красный, правый зелёный, нос — белый проблеск
  var hull = dk.hull, rim = g.rim || (g.rim = bdcOffsetPoly(hull, 1.05));
  var blink = (T % 1.6) < 0.18;
  var lights = [];
  rim.forEach(function(p, i) {
    var col = p[1] < H * 0.4 ? '255,70,60' : p[1] > H * 0.6 ? '95,255,120' : '255,255,255';
    lights.push([p[0], p[1], col, i]);
  });
  lights.forEach(function(L) {
    var on = L[2] === '255,255,255' ? blink : (0.5 + 0.5 * Math.sin(T * 2 + L[3])) > 0.3;
    if (!on) return;
    var gr = c.createRadialGradient(L[0], L[1], 0, L[0], L[1], 0.8);
    gr.addColorStop(0, 'rgba(' + L[2] + ',0.9)'); gr.addColorStop(1, 'rgba(' + L[2] + ',0)');
    c.fillStyle = gr; c.fillRect(L[0] - 0.8, L[1] - 0.8, 1.6, 1.6);
  });

  // Тревога: мигалки в коридорах и красный налёт
  if (alarm) {
    var pulse = 0.5 + 0.5 * Math.sin(T * 3.4);
    g.areaList.forEach(function(a) {
      if (a.kind !== 'corr' && a.kind !== 'lock') return;
      c.fillStyle = 'rgba(255,40,30,' + (0.02 + 0.04 * pulse) + ')';
      a.runs.forEach(function(r) { c.fillRect(r[0], r[1], r[2], r[3]); });
    });
    g.beacons.forEach(function(b) {
      var ang = T * 4 + b[2];
      var gr = c.createRadialGradient(b[0], b[1], 0, b[0], b[1], 1.9);
      gr.addColorStop(0, 'rgba(255,60,40,0.42)'); gr.addColorStop(1, 'rgba(255,60,40,0)');
      c.fillStyle = gr;
      c.beginPath(); c.moveTo(b[0], b[1]); c.arc(b[0], b[1], 1.9, ang - 0.3, ang + 0.3); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(b[0], b[1]); c.arc(b[0], b[1], 1.9, ang + Math.PI - 0.3, ang + Math.PI + 0.3); c.closePath(); c.fill();
      c.fillStyle = 'rgba(255,120,100,0.95)'; c.beginPath(); c.arc(b[0], b[1], 0.09, 0, 7); c.fill();
    });
  }
  c.restore();
}

// Рукав от корабля атакующего к его шлюзу
function bdcTube(c, dk, T) {
  var port = bdState.port;
  (dk.ports || []).forEach(function(p) {
    if (p.side !== port) return;
    var n = p.side === 'n';
    var ey = n ? p.y : p.y + 1, dir = n ? -1 : 1;
    var x0 = p.x + 0.5, len = BDC_PAD + 0.4;
    c.save();
    var gr = c.createLinearGradient(x0 - 0.8, 0, x0 + 0.8, 0);
    gr.addColorStop(0, '#1b2129'); gr.addColorStop(0.5, '#5b6878'); gr.addColorStop(1, '#1b2129');
    c.fillStyle = gr;
    var y0 = n ? ey - len : ey;
    c.fillRect(x0 - 0.8, y0, 1.6, len);
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.06;
    for (var r = 0.3; r < len; r += 0.45) { c.beginPath(); c.moveTo(x0 - 0.8, ey + dir * r); c.lineTo(x0 + 0.8, ey + dir * r); c.stroke(); }
    if (!BDC.reduce) {
      c.globalCompositeOperation = 'lighter';
      for (var k = 0; k < 3; k++) {
        var ph = ((T * 0.8 + k / 3) % 1);
        var yy = ey + dir * (len * (1 - ph));
        var g2 = c.createRadialGradient(x0, yy, 0, x0, yy, 0.9);
        g2.addColorStop(0, 'rgba(95,224,203,' + (0.5 * (1 - ph)) + ')'); g2.addColorStop(1, 'rgba(95,224,203,0)');
        c.fillStyle = g2; c.fillRect(x0 - 0.9, yy - 0.9, 1.8, 1.8);
      }
    }
    c.restore();
  });
}

// Туман: тёмная пелена с бегущими строками развёртки
function bdcFog(c, dk, g, vis, T) {
  if (!BDC.fogPat) {
    var pc = document.createElement('canvas'); pc.width = 8; pc.height = 8;
    var x = pc.getContext('2d');
    x.fillStyle = 'rgba(110,170,230,0.07)'; x.fillRect(0, 0, 8, 1);
    BDC.fogPat = c.createPattern(pc, 'repeat');
  }
  // Невидимые отсеки — как схема из базы корабля: без цвета, в синеве, с развёрткой
  // Путь тумана собираем заново, только когда меняется видимость
  var key = dk.n + '|' + dk.zones.map(function(z) { return vis[dk.n + ':' + z.id] ? 1 : 0; }).join('');
  if (BDC.fogKey !== key) {
    var fp = new Path2D(), any = false;
    dk.zones.forEach(function(z) {
      if (vis[dk.n + ':' + z.id]) return;
      fp.addPath(g.zonePath[z.id]); any = true;
    });
    BDC.fogKey = key; BDC.fogPath = any ? fp : null;
  }
  var fog = BDC.fogPath;
  if (!fog) return;
  c.save();
  c.globalCompositeOperation = 'color';
  c.fillStyle = '#2f6db0'; c.fill(fog);
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = 'rgba(4,10,22,0.5)'; c.fill(fog);
  c.clip(fog);
  c.setTransform(BDC.dpr, 0, 0, BDC.dpr, 0, 0);
  if (!BDC.reduce) c.translate(0, (T * 14) % 8);
  c.fillStyle = BDC.fogPat;
  c.fillRect(0, -8, BDC.vw, BDC.vh + 16);
  c.restore();
}

// Дверь: две створки, огонёк состояния, рамка выбора
function bdcDoor(c, o, T, actionable, selected, s) {
  var d = o.d, st = bdDoorState(d);
  var open = BDC.doorAnim[d.id] !== undefined ? BDC.doorAnim[d.id] : (st === 'open' || st === 'broken' ? 1 : 0);
  var th = d.kind === 'door' ? 0.13 : d.kind === 'lock' ? 0.22 : 0.26;
  var ax = o.h ? 1 : 0, ay = o.h ? 0 : 1;   // вдоль проёма
  var nx = ay, ny = ax;                       // поперёк
  var x0 = o.x0, y0 = o.y0;
  var half = 0.5 * (1 - open * 0.8);

  c.save();
  if (st === 'broken') {
    // Выбита: опалённый проём, раскалённые края, искорёженные обломки, искры
    var sg = c.createRadialGradient(o.mx, o.my, 0, o.mx, o.my, 1.0);
    sg.addColorStop(0, 'rgba(0,0,0,0.85)'); sg.addColorStop(0.6, 'rgba(10,6,4,0.45)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sg; c.fillRect(o.mx - 1, o.my - 1, 2, 2);
    var heat = BDC.reduce ? 0.7 : 0.55 + 0.45 * Math.sin(T * 3 + o.mx * 2);
    var dcol = d.kind === 'blast' ? '#6a4a1c' : d.kind === 'lock' ? '#1a4f49' : '#4a5a6b';
    // Обломки створок, загнутые наружу от косяков
    [[x0, y0, 1], [o.x1, o.y1, -1]].forEach(function(e, i) {
      c.save(); c.translate(e[0], e[1]);
      c.rotate(Math.atan2(ay, ax) + (i ? 1 : -1) * 0.65);
      c.fillStyle = dcol;
      c.beginPath();
      c.moveTo(0, -th / 2); c.lineTo(e[2] * 0.3, -th / 2 - 0.04); c.lineTo(e[2] * 0.22, -0.01);
      c.lineTo(e[2] * 0.34, th / 2 + 0.05); c.lineTo(0, th / 2); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(255,140,50,' + 0.8 * heat + ')'; c.lineWidth = 0.035;
      c.beginPath(); c.moveTo(e[2] * 0.3, -th / 2 - 0.04); c.lineTo(e[2] * 0.22, -0.01); c.lineTo(e[2] * 0.34, th / 2 + 0.05); c.stroke();
      c.restore();
    });
    // Раскалённая кромка проёма
    c.globalCompositeOperation = 'lighter';
    var hg = c.createRadialGradient(o.mx, o.my, 0, o.mx, o.my, 0.6);
    hg.addColorStop(0, 'rgba(255,120,40,' + 0.35 * heat + ')'); hg.addColorStop(1, 'rgba(255,80,20,0)');
    c.fillStyle = hg; c.fillRect(o.mx - 0.6, o.my - 0.6, 1.2, 1.2);
    if (!BDC.reduce) {
      for (var k = 0; k < 7; k++) {
        var ph = (T * 1.1 + k * 0.29 + (o.mx * 3 + o.my) % 1) % 1;
        var a = k * 2.3 + o.mx;
        var r = 0.08 + ph * 0.7;
        c.fillStyle = 'rgba(255,' + Math.round(190 - ph * 120) + ',60,' + (0.95 * (1 - ph)) + ')';
        c.beginPath(); c.arc(o.mx + Math.cos(a) * r, o.my + Math.sin(a) * r, 0.035 + 0.02 * (1 - ph), 0, 7); c.fill();
      }
    }
    c.restore();
    if (selected || actionable) bdcDoorRing(c, o, T, selected, s);
    return;
  }

  // Створки
  var col, col2;
  if (d.kind === 'blast') { col = '#b5832e'; col2 = '#5a3f14'; }
  else if (d.kind === 'lock') { col = '#2fa595'; col2 = '#0f3f3a'; }
  else { col = '#8fa3b8'; col2 = '#3d4c5e'; }
  var leaf = function(from, sign) {
    // from: 0 — от начала проёма, 1 — от конца
    var sx = x0 + ax * from, sy = y0 + ay * from;
    var ex = sx + ax * half * sign, ey = sy + ay * half * sign;
    var rx = Math.min(sx, ex) - nx * th / 2, ry = Math.min(sy, ey) - ny * th / 2;
    var rw = Math.abs(ex - sx) + nx * th, rh = Math.abs(ey - sy) + ny * th;
    var gr = o.h ? c.createLinearGradient(0, ry, 0, ry + rh) : c.createLinearGradient(rx, 0, rx + rw, 0);
    gr.addColorStop(0, col2); gr.addColorStop(0.5, col); gr.addColorStop(1, col2);
    c.fillStyle = gr; c.fillRect(rx, ry, rw, rh);
    if (d.kind === 'blast') {
      c.save(); c.beginPath(); c.rect(rx, ry, rw, rh); c.clip();
      c.fillStyle = 'rgba(15,10,5,0.75)';
      for (var t = -1; t < 2; t += 0.16) {
        c.beginPath();
        if (o.h) { c.moveTo(rx + t, ry); c.lineTo(rx + t + 0.07, ry); c.lineTo(rx + t + 0.07 - rh, ry + rh); c.lineTo(rx + t - rh, ry + rh); }
        else { c.moveTo(rx, ry + t); c.lineTo(rx, ry + t + 0.07); c.lineTo(rx + rw, ry + t + 0.07 - rw); c.lineTo(rx + rw, ry + t - rw); }
        c.fill();
      }
      c.restore();
    }
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 0.03; c.strokeRect(rx, ry, rw, rh);
  };
  c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 4;
  leaf(0, 1); leaf(1, -1);
  c.shadowColor = 'transparent';

  // Огонёк состояния
  var lc = st === 'locked' ? '255,70,60' : st === 'closed' ? '227,162,74' : '95,217,104';
  var pulse = st === 'locked' && !BDC.reduce ? 0.65 + 0.35 * Math.sin(T * 5 + o.mx) : 1;
  var lx = o.mx, ly = o.my;
  if (st === 'open') {
    // Открыта — два зелёных огонька на косяках
    [[x0, y0], [o.x1, o.y1]].forEach(function(e) {
      c.fillStyle = 'rgba(' + lc + ',0.9)'; c.beginPath(); c.arc(e[0], e[1], 0.06, 0, 7); c.fill();
    });
  } else {
    c.globalCompositeOperation = 'lighter';
    var lg = c.createRadialGradient(lx, ly, 0, lx, ly, 0.5);
    lg.addColorStop(0, 'rgba(' + lc + ',' + 0.55 * pulse + ')'); lg.addColorStop(1, 'rgba(' + lc + ',0)');
    c.fillStyle = lg; c.fillRect(lx - 0.5, ly - 0.5, 1, 1);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgba(' + lc + ',1)'; c.beginPath(); c.arc(lx, ly, 0.075, 0, 7); c.fill();
    if (st === 'locked' && d.kind === 'door') {
      // Засов поперёк створок
      c.fillStyle = '#d9a940';
      c.fillRect(lx - (nx * 0.18 + ax * 0.04), ly - (ny * 0.18 + ay * 0.04), nx * 0.36 + ax * 0.08, ny * 0.36 + ay * 0.08);
      c.fillStyle = 'rgba(' + lc + ',1)'; c.beginPath(); c.arc(lx, ly, 0.06, 0, 7); c.fill();
    }
  }
  c.restore();
  if (selected || actionable) bdcDoorRing(c, o, T, selected, s);
}

function bdcDoorRing(c, o, T, selected, s) {
  var k = BDC.reduce ? 1 : 0.5 + 0.5 * Math.sin(T * 5);
  c.save();
  c.lineWidth = Math.max(0.06, 2 / s);
  c.strokeStyle = selected ? 'rgba(255,255,255,' + (0.7 + 0.3 * k) + ')' : 'rgba(240,200,106,' + (0.5 + 0.5 * k) + ')';
  c.shadowColor = selected ? 'rgba(255,255,255,0.9)' : 'rgba(217,169,64,0.9)'; c.shadowBlur = 8;
  c.beginPath(); c.arc(o.mx, o.my, 0.36 + 0.05 * k, 0, 7); c.stroke();
  c.restore();
}

// Турель: купол стороны хозяина, ствол водит по сторонам
function bdcTurretState(deck, t) {
  var key = deck + ':' + t[0] + ':' + t[1], list = (bdState && bdState.turrets) || [];
  for (var i = 0; i < list.length; i++) if (list[i].k === key) return list[i];
  return { k: key, hp: 150, max: 150 };
}

function bdcTurret(c, t, side, T, i, deck) {
  var cx = t[0] + 0.5, cy = t[1] + 0.5;
  var col = side === 'def' ? BDC_SIDE.mine : BDC_SIDE.foe;
  var ts = bdcTurretState(deck, t);
  if (ts.off) { bdcTurretOff(c, cx, cy, i); return; }
  if (ts.hp <= 0) { bdcTurretWreck(c, cx, cy, T, i); return; }
  var a = BDC.reduce ? i : Math.sin(T * 0.6 + i * 1.7) * 1.4 + i * 2;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = 6;
  c.fillStyle = '#1c242e'; c.beginPath(); c.arc(cx, cy, 0.42, 0, 7); c.fill();
  c.shadowColor = 'transparent';
  c.strokeStyle = bdcAlpha(col, 0.85); c.lineWidth = 0.06; c.beginPath(); c.arc(cx, cy, 0.4, 0, 7); c.stroke();
  c.translate(cx, cy); c.rotate(a);
  c.fillStyle = '#5b6b7d'; c.fillRect(0.05, -0.07, 0.42, 0.06); c.fillRect(0.05, 0.01, 0.42, 0.06);
  var gr = c.createRadialGradient(-0.06, -0.06, 0, 0, 0, 0.26);
  gr.addColorStop(0, '#8fa3b8'); gr.addColorStop(1, '#2d3a49');
  c.fillStyle = gr; c.beginPath(); c.arc(0, 0, 0.24, 0, 7); c.fill();
  c.fillStyle = bdcAlpha(col, 0.95); c.beginPath(); c.arc(0.1, 0, 0.05, 0, 7); c.fill();
  c.restore();
  // Прочность — полоской под куполом, когда турель уже задета
  if (ts.hp < ts.max) {
    var k = Math.max(0, ts.hp / ts.max);
    c.fillStyle = 'rgba(0,0,0,0.75)'; c.fillRect(cx - 0.4, cy + 0.5, 0.8, 0.12);
    c.fillStyle = k > 0.5 ? col : k > 0.25 ? '#e3a24a' : '#ff5a4f'; c.fillRect(cx - 0.38, cy + 0.52, 0.76 * k, 0.08);
  }
}

// Отключённая турель (учение): купол цел, стволы опущены, огней нет
function bdcTurretOff(c, cx, cy, i) {
  c.save();
  c.fillStyle = '#151b23'; c.beginPath(); c.arc(cx, cy, 0.42, 0, 7); c.fill();
  c.strokeStyle = 'rgba(85,96,108,0.7)'; c.lineWidth = 0.05; c.setLineDash([0.12, 0.1]);
  c.beginPath(); c.arc(cx, cy, 0.4, 0, 7); c.stroke(); c.setLineDash([]);
  c.translate(cx, cy); c.rotate(i * 2 + 0.6);
  c.fillStyle = '#3a4552'; c.fillRect(0.05, -0.07, 0.36, 0.06); c.fillRect(0.05, 0.01, 0.36, 0.06);
  c.fillStyle = '#2a333e'; c.beginPath(); c.arc(0, 0, 0.24, 0, 7); c.fill();
  c.restore();
}

// Разбитая турель: обгоревшее основание, обломок ствола, дымок
function bdcTurretWreck(c, cx, cy, T, i) {
  c.save();
  var g = c.createRadialGradient(cx, cy, 0, cx, cy, 0.6);
  g.addColorStop(0, 'rgba(0,0,0,0.7)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(cx - 0.6, cy - 0.6, 1.2, 1.2);
  c.fillStyle = '#1a1f26'; c.beginPath(); c.arc(cx, cy, 0.36, 0, 7); c.fill();
  c.strokeStyle = '#3a2a22'; c.lineWidth = 0.05;
  c.beginPath(); c.moveTo(cx - 0.25, cy - 0.1); c.lineTo(cx, cy + 0.05); c.lineTo(cx + 0.2, cy - 0.2);
  c.moveTo(cx - 0.05, cy + 0.25); c.lineTo(cx + 0.05, cy); c.stroke();
  c.fillStyle = '#4a4f57'; c.save(); c.translate(cx, cy); c.rotate(0.9 + i); c.fillRect(0.1, -0.04, 0.22, 0.08); c.restore();
  if (!BDC.reduce) {
    for (var k = 0; k < 3; k++) {
      var ph = (T * 0.35 + k / 3 + i * 0.13) % 1;
      c.fillStyle = 'rgba(90,96,108,' + 0.35 * (1 - ph) + ')';
      c.beginPath(); c.arc(cx + Math.sin(ph * 6 + k) * 0.12, cy - ph * 0.9, 0.12 + ph * 0.25, 0, 7); c.fill();
    }
  }
  c.restore();
}

// ---------- экранный слой ----------

function bdcText(c, txt, x, y, fs, col, spacing) {
  c.font = 'bold ' + fs + 'px "Courier New", monospace';
  var cw = c.measureText('M').width + spacing;
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(3,5,9,0.92)'; c.lineWidth = 3.2;
  for (var i = 0; i < txt.length; i++) c.strokeText(txt.charAt(i), x + i * cw, y);
  c.fillStyle = col;
  for (var j = 0; j < txt.length; j++) c.fillText(txt.charAt(j), x + j * cw, y);
  return txt.length * cw - spacing;
}

function bdcRectScreen(r) {
  var a = bdcToScreen(r[0], r[1]), b = bdcToScreen(r[0] + r[2], r[1] + r[3]);
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

function bdcLabels(c, dk, g, vis, s) {
  if (s < 9) return;
  var fs = Math.max(8, Math.min(12, s * 0.34));
  var cwBase = fs * 0.6 + 1;
  var busy = {};
  g.props.forEach(function(p) { if (p.k === 'pipe') return; for (var x = p.x; x < p.x + p.w; x++) for (var y = p.y; y < p.y + p.h; y++) busy[x + ':' + y] = 1; });
  bdUnits(dk.n).forEach(function(u) { busy[u.x + ':' + u.y] = 1; });
  (dk.turrets || []).forEach(function(t) { busy[t[0] + ':' + t[1]] = 1; });
  // Люк с плашкой «↓П3» под ним занимает и клетку ниже на экране
  (dk.hatches || []).forEach(function(h) {
    busy[h.x + ':' + h.y] = 1;
    if (BDC.rot) busy[(h.x - 1) + ':' + h.y] = 1; else busy[h.x + ':' + (h.y + 1)] = 1;
  });
  (dk.ducts || []).forEach(function(du) { busy[du.a[0] + ':' + du.a[1]] = 1; busy[du.b[0] + ':' + du.b[1]] = 1; });
  var placed = [];
  var hits = function(x, y, w, h) {
    for (var i = 0; i < placed.length; i++) {
      var q = placed[i];
      if (x < q[0] + q[2] + 6 && x + w + 6 > q[0] && y < q[1] + q[3] + 3 && y + h + 3 > q[1]) return true;
    }
    return false;
  };
  c.textBaseline = 'alphabetic';
  // Цели — первыми: их подписи важнее
  var order = g.areaList.slice().sort(function(p, q) { return (q.kind === 'goal') - (p.kind === 'goal'); });
  order.forEach(function(a) {
    if (!a.label || a.kind === 'lift') return;
    var text = a.label.toUpperCase();
    var r = bdcRectScreen(a.big);
    // Подпись держится в видимой части отсека
    var vx0 = Math.max(r.x, 0), vy0 = Math.max(r.y, 0), vx1 = Math.min(r.x + r.w, BDC.vw), vy1 = Math.min(r.y + r.h, BDC.vh);
    if (vx1 - vx0 < 30 || vy1 - vy0 < 14) return;
    r = { x: vx0, y: vy0, w: vx1 - vx0, h: vy1 - vy0 };
    var goal = a.kind === 'goal';
    var f = fs;
    var rows = [text];
    var w = text.length * cwBase;
    if (w > r.w - 8) {
      var words = text.split(' '), best = null;
      for (var i = 1; i < words.length; i++) {
        var p1 = words.slice(0, i).join(' '), p2 = words.slice(i).join(' ');
        var ww = Math.max(p1.length, p2.length) * cwBase;
        if (!best || ww < best.w) best = { rows: [p1, p2], w: ww };
      }
      if (best && best.w <= r.w - 8) { rows = best.rows; w = best.w; }
      else if (goal) { f = Math.max(7, fs - 2); w = text.length * (f * 0.6 + 1); if (w > r.w + 20) return; }
      else return;
    }
    var lh = f + 3, hgt = rows.length * lh + (goal ? 0 : 0);
    if (hgt > r.h - 4 && !goal) return;
    var inset = Math.max(5, s * 0.18);
    var gw = w + (goal || (a.role && a.role !== 'hold') ? 10 : 0);
    var cands = [[r.x + inset, r.y + inset], [r.x + r.w - inset - gw, r.y + inset],
                 [r.x + inset, r.y + r.h - inset - hgt], [r.x + r.w - inset - gw, r.y + r.h - inset - hgt]];
    var pick = null;
    for (var k = 0; k < cands.length; k++) {
      var cd = cands[k], ok = !hits(cd[0], cd[1], gw, hgt);
      for (var px = cd[0]; px <= cd[0] + gw && ok; px += Math.max(4, s / 2)) {
        for (var py = cd[1]; py <= cd[1] + hgt && ok; py += Math.max(4, s / 2)) {
          var pl = bdcToPlan(px, py);
          if (busy[Math.floor(pl[0]) + ':' + Math.floor(pl[1])]) ok = false;
        }
      }
      if (ok) { pick = cd; break; }
    }
    if (!pick) {
      // Все углы заняты предметами — берём первый, что не налезает на чужую подпись
      for (var k2 = 0; k2 < cands.length && !pick; k2++) if (!hits(cands[k2][0], cands[k2][1], gw, hgt)) pick = cands[k2];
      if (!pick) return;
    }
    placed.push([pick[0], pick[1], gw, hgt]);
    var fogged = a.zones.every(function(z) { return !vis[dk.n + ':' + z]; });
    var col = goal ? '#f0d48a' : a.kind === 'lock' ? '#5fe0cb' : a.kind === 'corr' ? '#7f93a8' : '#a9bccf';
    // Отсек с ролью: кружок цвета держащей стороны (серый — пусто)
    var who = a.role && a.role !== 'hold' && typeof bdgHolder === 'function' ? bdgHolder(a.role) : null;
    var holdCol = who ? (who === bdMine() ? '#5fd968' : '#ff5a4f') : null;
    var mark = !goal && a.role && a.role !== 'hold' && typeof BDG_ROLE !== 'undefined' && BDG_ROLE[a.role];
    c.globalAlpha = fogged ? 0.55 : 1;
    rows.forEach(function(t, i) {
      var x0 = pick[0];
      if (goal && i === 0) {
        // Ромб цели: золото, а если держат — цвет стороны
        var dy = pick[1] + f * 0.55;
        c.fillStyle = holdCol || '#d9a940';
        c.beginPath(); c.moveTo(x0 - 1, dy); c.lineTo(x0 + 3, dy - 4); c.lineTo(x0 + 7, dy); c.lineTo(x0 + 3, dy + 4); c.closePath(); c.fill();
        x0 += 10;
      } else if (goal) x0 += 10;
      else if (mark && i === 0) {
        var my = pick[1] + f * 0.55;
        c.fillStyle = holdCol || 'rgba(143,168,196,0.35)';
        c.strokeStyle = holdCol ? 'rgba(0,0,0,0.6)' : 'rgba(143,168,196,0.8)'; c.lineWidth = 1;
        c.beginPath(); c.arc(x0 + 3, my, 3.2, 0, 7); c.fill(); c.stroke();
        x0 += 10;
      } else if (mark) x0 += 10;
      bdcText(c, t, x0, pick[1] + f + i * lh - 1, f, col, 1);
    });
    c.globalAlpha = 1;
  });
}

// Люки (куда ведут) и лифты (буква)
function bdcMarks(c, dk, s) {
  if (s < 10) return;
  var fs = Math.max(8, Math.min(12, s * 0.34));
  (dk.hatches || []).forEach(function(h) {
    var p = bdcToScreen(h.x + 0.5, h.y + 0.5);
    var up = h.to && h.to[0] < dk.n;
    var welded = typeof bdgWelded === 'function' && bdgWelded(h.id);
    var txt = welded ? 'ЗАВАРЕН' : (up ? '↑' : '↓') + (h.to ? 'П' + h.to[0] : '');
    if (welded) {
      // Шов крест-накрест поверх крышки люка
      var r = s * 0.34;
      c.save();
      c.strokeStyle = 'rgba(255,170,70,0.95)'; c.lineWidth = Math.max(2, s * 0.08); c.lineCap = 'round';
      c.shadowColor = 'rgba(255,140,40,0.8)'; c.shadowBlur = 6;
      c.beginPath(); c.moveTo(p[0] - r, p[1] - r); c.lineTo(p[0] + r, p[1] + r); c.moveTo(p[0] + r, p[1] - r); c.lineTo(p[0] - r, p[1] + r); c.stroke();
      c.restore();
    }
    c.font = 'bold ' + fs + 'px "Courier New", monospace';
    var w = c.measureText(txt).width + 8;
    var y = p[1] + s * 0.5 + 3;
    c.fillStyle = welded ? 'rgba(30,14,4,0.92)' : 'rgba(13,11,22,0.88)'; bdcRR(c, p[0] - w / 2, y, w, fs + 5, 4); c.fill();
    c.strokeStyle = welded ? 'rgba(227,162,74,0.9)' : 'rgba(154,126,230,0.8)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = welded ? '#f3c98a' : '#cbb8ff'; c.textAlign = 'center'; c.fillText(txt, p[0], y + fs + 1);
    c.textAlign = 'left';
  });
  (dk.lifts || []).forEach(function(l) {
    var p = bdcToScreen(l.box[0] + l.box[2] / 2, l.box[1] + l.box[3] / 2);
    var f = Math.max(10, Math.min(20, s * 0.6));
    c.font = 'bold ' + f + 'px "Courier New", monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 3; c.strokeStyle = 'rgba(3,5,9,0.9)'; c.strokeText(l.label, p[0], p[1]);
    c.fillStyle = '#cfe0f5'; c.fillText(l.label, p[0], p[1]);
    if (s >= 22) {
      c.font = 'bold ' + Math.max(7, f * 0.42) + 'px "Courier New", monospace';
      c.fillStyle = 'rgba(143,182,224,0.9)'; c.fillText('ЛИФТ', p[0], p[1] + f * 0.7);
    }
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  });
}

function bdcImg(src) {
  var im = BDC.imgs[src];
  if (im) return im.complete && im.naturalWidth ? im : null;
  im = new Image();
  im.onload = function() { bdcDirty(); };
  im.src = src;
  BDC.imgs[src] = im;
  return null;
}

// Жетон бойца: портрет в круге, кольцо стороны, дуга здоровья, значки
// pass 1 — жетон, pass 2 — значки поверх соседей
function bdcToken(c, u, s, T, pass) {
  var pp = bdcUnitPos(u), p = bdcToScreen(pp[0], pp[1]);
  var x = p[0], y = p[1];
  if (x < -40 || y < -40 || x > BDC.vw + 40 || y > BDC.vh + 40) return;
  var kind = u.mine ? 'mine' : (u.side === bdMine() ? 'ally' : 'foe');
  var col = BDC_SIDE[kind];
  var sel = bdSel === u.id;
  var r = s * 0.42;
  var pct = u.max_hp ? Math.max(0, Math.min(1, u.hp / u.max_hp)) : 1;

  if (r < 6) {
    if (pass === 2) return;
    c.fillStyle = col; c.beginPath(); c.arc(x, y, Math.max(2.4, r), 0, 7); c.fill();
    c.strokeStyle = sel ? '#f0c86a' : 'rgba(0,0,0,0.7)'; c.lineWidth = sel ? 2 : 1; c.stroke();
    return;
  }
  if (pass === 2) { bdcBadges(c, u, x, y, r); return; }
  // Тень
  c.fillStyle = 'rgba(0,0,0,0.5)';
  c.beginPath(); c.ellipse(x + r * 0.08, y + r * 0.18, r * 1.02, r * 0.95, 0, 0, 7); c.fill();
  // Ореол выбора
  if (sel) {
    var k = BDC.reduce ? 1 : 0.5 + 0.5 * Math.sin(T * 4);
    var gr = c.createRadialGradient(x, y, r * 0.8, x, y, r * 1.8);
    gr.addColorStop(0, 'rgba(240,200,106,' + (0.35 + 0.25 * k) + ')'); gr.addColorStop(1, 'rgba(240,200,106,0)');
    c.fillStyle = gr; c.beginPath(); c.arc(x, y, r * 1.8, 0, 7); c.fill();
  } else if (kind === 'foe') {
    var gr2 = c.createRadialGradient(x, y, r * 0.8, x, y, r * 1.45);
    gr2.addColorStop(0, 'rgba(255,90,79,0.3)'); gr2.addColorStop(1, 'rgba(255,90,79,0)');
    c.fillStyle = gr2; c.beginPath(); c.arc(x, y, r * 1.45, 0, 7); c.fill();
  }
  // Подложка и портрет
  c.fillStyle = '#0a0d14'; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  var im = u.image ? bdcImg('../' + u.image) : null;
  var ir = r - Math.max(2, r * 0.15) + 0.5;
  if (im) {
    c.save(); c.beginPath(); c.arc(x, y, ir, 0, 7); c.clip();
    var iw = im.naturalWidth, ih = im.naturalHeight, sc = (ir * 2) / Math.min(iw, ih);
    c.drawImage(im, x - iw * sc / 2, y - ir, iw * sc, ih * sc);
    c.restore();
  } else {
    c.fillStyle = bdcAlpha(col, 0.25); c.beginPath(); c.arc(x, y, ir, 0, 7); c.fill();
    c.fillStyle = col; c.font = 'bold ' + Math.round(r * 0.9) + 'px "Courier New", monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText((u.name || '?').charAt(0), x, y + 1);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  }
  // Кольцо стороны — оно же запас здоровья: убыль темнеет по часовой
  var lw = Math.max(2, r * 0.15), rr0 = r - lw / 2;
  c.lineWidth = lw;
  c.strokeStyle = 'rgba(20,24,30,0.95)';
  c.beginPath(); c.arc(x, y, rr0, 0, 7); c.stroke();
  var ringCol = sel ? '#f0c86a' : pct <= 0.3 ? '#ff8a3a' : col;
  if (pct > 0) {
    c.strokeStyle = ringCol;
    c.beginPath(); c.arc(x, y, rr0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct); c.stroke();
  }
  // Вращающаяся рамка выбора
  if (sel) {
    c.save(); c.strokeStyle = 'rgba(240,200,106,0.95)'; c.lineWidth = 1.6;
    c.setLineDash([5, 4]); c.lineDashOffset = BDC.reduce ? 0 : -T * 18;
    c.beginPath(); c.arc(x, y, r + 4, 0, 7); c.stroke(); c.restore();
  }
}

// Значки жетона: герой, инженер, огоньки действий
function bdcBadges(c, u, x, y, r) {
  // «На чеку» — глаз слева сверху
  if (u.watch && r >= 9) {
    var wx = x - r * 0.72, wy = y - r * 0.72, wr = Math.max(4.5, r * 0.34);
    c.fillStyle = '#0a0d14'; c.beginPath(); c.arc(wx, wy, wr, 0, 7); c.fill();
    c.strokeStyle = '#e3a24a'; c.lineWidth = Math.max(1.2, wr * 0.22);
    c.beginPath(); c.ellipse(wx, wy, wr * 0.68, wr * 0.4, 0, 0, 7); c.stroke();
    c.fillStyle = '#e3a24a'; c.beginPath(); c.arc(wx, wy, wr * 0.2, 0, 7); c.fill();
  }
  // Герой — звезда
  if (u.hero && r >= 9) {
    var bx = x + r * 0.72, by = y - r * 0.72, br = Math.max(4.5, r * 0.34);
    c.fillStyle = '#0a0d14'; c.beginPath(); c.arc(bx, by, br, 0, 7); c.fill();
    c.fillStyle = '#f0c86a'; c.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? br * 0.42 : br * 0.9;
      if (i) c.lineTo(bx + Math.cos(a) * rr, by + Math.sin(a) * rr); else c.moveTo(bx + Math.cos(a) * rr, by + Math.sin(a) * rr);
    }
    c.closePath(); c.fill();
  }
  // Инженер — ключ
  if (u.engineer && r >= 9) {
    var ex = x + r * 0.72, ey = y + r * 0.6, er = Math.max(4.5, r * 0.32);
    c.fillStyle = '#0a0d14'; c.beginPath(); c.arc(ex, ey, er, 0, 7); c.fill();
    c.strokeStyle = '#8fd0ff'; c.lineWidth = Math.max(1.2, er * 0.28); c.lineCap = 'round';
    c.beginPath(); c.moveTo(ex - er * 0.45, ey + er * 0.45); c.lineTo(ex + er * 0.2, ey - er * 0.2); c.stroke();
    c.beginPath(); c.arc(ex + er * 0.3, ey - er * 0.3, er * 0.32, Math.PI * 0.25, Math.PI * 1.75); c.stroke();
    c.lineCap = 'butt';
  }
  // Действия своих — огоньки на нижнем крае жетона
  if (u.mine && u.ap !== null && u.ap !== undefined && r >= 10) {
    var mx = u.ap_max || 2, pw = mx * 6 + 4, py = y + r - 3;
    c.fillStyle = 'rgba(6,8,12,0.92)'; bdcRR(c, x - pw / 2, py - 3.5, pw, 7, 3.5); c.fill();
    for (var j = 0; j < mx; j++) {
      c.fillStyle = j < u.ap ? '#7dff8a' : '#2a323c';
      c.beginPath(); c.arc(x - pw / 2 + 5 + j * 6, py, 2, 0, 7); c.fill();
    }
  }
}

// Мини-карта в углу: вся палуба, бойцы, рамка экрана
function bdcMini(c, dk, g, vis) {
  BDC.miniRect = null;
  if (bdcIsOverview()) return;
  var rot = BDC.rot;
  var mw, mh;
  if (rot) { mw = Math.min(64, BDC.vw * 0.17); mh = mw * dk.w / dk.h; if (mh > BDC.vh * 0.42) { mh = BDC.vh * 0.42; mw = mh * dk.h / dk.w; } }
  else { mh = Math.min(60, BDC.vh * 0.2); mw = mh * dk.w / dk.h; }
  var x = BDC.vw - mw - 10, y = 10;
  BDC.miniRect = { x: x, y: y, w: mw, h: mh };
  if (!BDC.mini) {
    // Уменьшенный чертёж, один раз на палубу
    var mc = document.createElement('canvas');
    var k = 4;
    mc.width = Math.round((rot ? dk.h : dk.w) * k); mc.height = Math.round((rot ? dk.w : dk.h) * k);
    var m = mc.getContext('2d');
    if (rot) { m.translate(0, mc.height); m.rotate(-Math.PI / 2); }
    m.drawImage(BDC.art.cv, BDC.art.P * BDC.art.A, BDC.art.P * BDC.art.A, dk.w * BDC.art.A, dk.h * BDC.art.A, 0, 0, dk.w * k, dk.h * k);
    BDC.mini = mc;
  }
  c.save();
  c.fillStyle = 'rgba(5,7,12,0.82)'; bdcRR(c, x - 4, y - 4, mw + 8, mh + 8, 6); c.fill();
  c.strokeStyle = '#2a3644'; c.lineWidth = 1; c.stroke();
  c.globalAlpha = 0.9; c.drawImage(BDC.mini, x, y, mw, mh); c.globalAlpha = 1;
  var toMini = function(px, py) {
    return rot ? [x + py / dk.h * mw, y + (1 - px / dk.w) * mh] : [x + px / dk.w * mw, y + py / dk.h * mh];
  };
  // Туман
  c.fillStyle = 'rgba(3,5,10,0.6)';
  dk.zones.forEach(function(z) {
    if (vis[dk.n + ':' + z.id]) return;
    var b = z.box, a = toMini(b[0], b[1]), e = toMini(b[0] + b[2], b[1] + b[3]);
    c.fillRect(Math.min(a[0], e[0]), Math.min(a[1], e[1]), Math.abs(a[0] - e[0]), Math.abs(a[1] - e[1]));
  });
  // Отсеки с ролью — цветом держащей стороны
  if (typeof bdgList === 'function' && bdState.status === 'active') {
    bdgList().forEach(function(r) {
      if (r.deck !== dk.n) return;
      var who = bdgHolder(r.role), a = g.areas[r.area];
      if (!who || !a) return;
      c.fillStyle = bdcAlpha(who === bdMine() ? '#5fd968' : '#ff5a4f', 0.42);
      a.rects.forEach(function(b) {
        var p0 = toMini(b[0], b[1]), p1 = toMini(b[0] + b[2], b[1] + b[3]);
        c.fillRect(Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.abs(p0[0] - p1[0]), Math.abs(p0[1] - p1[1]));
      });
    });
    var chm = bdState.charge;
    if (chm && chm.deck === dk.n) {
      var cq = toMini(chm.x + 0.5, chm.y + 0.5);
      c.fillStyle = '#ff3b2a'; c.beginPath(); c.arc(cq[0], cq[1], 3, 0, 7); c.fill();
    }
  }
  bdUnits(dk.n).forEach(function(u) {
    var q = toMini(u.x + 0.5, u.y + 0.5);
    c.fillStyle = BDC_SIDE[u.mine ? 'mine' : (u.side === bdMine() ? 'ally' : 'foe')];
    c.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3);
  });
  // Что сейчас на экране
  var a0 = bdcToPlan(0, 0), a1 = bdcToPlan(BDC.vw, BDC.vh);
  var p0 = toMini(a0[0], a0[1]), p1 = toMini(a1[0], a1[1]);
  var rx = Math.max(x, Math.min(p0[0], p1[0])), ry = Math.max(y, Math.min(p0[1], p1[1]));
  var rx2 = Math.min(x + mw, Math.max(p0[0], p1[0])), ry2 = Math.min(y + mh, Math.max(p0[1], p1[1]));
  c.strokeStyle = 'rgba(240,200,106,0.9)'; c.lineWidth = 1.2;
  c.strokeRect(rx, ry, Math.max(2, rx2 - rx), Math.max(2, ry2 - ry));
  c.restore();
}
