// Абордаж: правила хода и стрельбы на палубе — те же, что на сервере
// (boarding_geo, boarding_step_ok, boarding_los, boarding_cover).
// Клиент считает их заранее, чтобы подсветить, куда боец дойдёт и в кого
// попадёт; решает всё равно сервер.
//
// Клетки нумеруются i = y*w + x. zone — номер зоны или -1 (пустота);
// solid: 0 — свободно, 1 — укрытие, 2 — глухой предмет, 3 — турель.

var BDR_ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
var BDR_COVER = 40;     // укрытие гасит 40% урона

function bdrGeo(dk) {
  if (dk._geo) return dk._geo;
  var w = dk.w, h = dk.h, n = w * h, i, x, y;
  var zone = [], solid = [];
  for (i = 0; i < n; i++) { zone.push(-1); solid.push(0); }
  for (y = 0; y < h; y++) {
    var line = dk.grid[y] || '';
    for (x = 0; x < w; x++) {
      var ch = line.charAt(x);
      if (ch && ch !== '.') zone[y * w + x] = BDR_ALPH.indexOf(ch);
    }
  }
  var mark = function(px, py, v) {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    var k = py * w + px;
    if (v > solid[k]) solid[k] = v;
  };
  if (dk.props) {
    dk.props.forEach(function(p) {
      var v = p.s === 'block' ? 2 : p.s === 'cover' ? 1 : 0;
      if (!v) return;
      for (var a = p.x; a < p.x + p.w; a++) for (var b = p.y; b < p.y + p.h; b++) mark(a, b, v);
    });
  } else {
    (dk.blocks || []).forEach(function(r) { for (var a = r[0]; a < r[0] + r[2]; a++) for (var b = r[1]; b < r[1] + r[3]; b++) mark(a, b, 2); });
    (dk.cover || []).forEach(function(c) { mark(c[0], c[1], 1); });
  }
  (dk.turrets || []).forEach(function(t) { solid[t[1] * w + t[0]] = 3; });
  var doors = {};
  (dk.doors || []).forEach(function(d) {
    var a = d.c1[1] * w + d.c1[0], b = d.c2[1] * w + d.c2[0];
    doors[Math.min(a, b) + '-' + Math.max(a, b)] = d;
  });
  dk._geo = { w: w, h: h, zone: zone, solid: solid, doors: doors };
  return dk._geo;
}

function bdrEdgeOpen(g, state, a, b) {
  if (g.zone[a] === g.zone[b]) return true;
  var d = g.doors[Math.min(a, b) + '-' + Math.max(a, b)];
  if (!d) return false;
  if (d.kind === 'lift') return true;
  var st = (state && state[d.id]) || 'open';
  return st === 'open' || st === 'broken';
}

function bdrFree(g, x, y) {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return false;
  var k = y * g.w + x;
  return g.zone[k] >= 0 && g.solid[k] === 0;
}

// Шаг в соседнюю клетку; по диагонали — только когда свободны обе боковые
function bdrStepOk(g, state, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (!dx && !dy)) return false;
  if (!bdrFree(g, bx, by)) return false;
  var a = ay * g.w + ax, b = by * g.w + bx;
  if (!dx || !dy) return bdrEdgeOpen(g, state, a, b);
  if (!bdrFree(g, bx, ay) || !bdrFree(g, ax, by)) return false;
  var c1 = ay * g.w + bx, c2 = by * g.w + ax;
  return bdrEdgeOpen(g, state, a, c1) && bdrEdgeOpen(g, state, c1, b) &&
         bdrEdgeOpen(g, state, a, c2) && bdrEdgeOpen(g, state, c2, b);
}

function bdrLosStep(g, state, ax, ay, bx, by, last) {
  if (bx < 0 || by < 0 || bx >= g.w || by >= g.h) return false;
  var b = by * g.w + bx;
  if (g.zone[b] < 0) return false;
  if (!last && g.solid[b] === 2) return false;
  return bdrEdgeOpen(g, state, ay * g.w + ax, b);
}

// Линия огня между центрами клеток; через угол — если свободен хотя бы один обход
function bdrLos(g, state, x0, y0, x1, y1) {
  var nx = Math.abs(x1 - x0), ny = Math.abs(y1 - y0);
  var sx = x1 > x0 ? 1 : x1 < x0 ? -1 : 0, sy = y1 > y0 ? 1 : y1 < y0 ? -1 : 0;
  var ix = 0, iy = 0, cx = x0, cy = y0;
  while (ix < nx || iy < ny) {
    var t = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (t === 0) {
      var last = cx + sx === x1 && cy + sy === y1;
      var okA = bdrLosStep(g, state, cx, cy, cx + sx, cy, false) && bdrLosStep(g, state, cx + sx, cy, cx + sx, cy + sy, last);
      var okB = bdrLosStep(g, state, cx, cy, cx, cy + sy, false) && bdrLosStep(g, state, cx, cy + sy, cx + sx, cy + sy, last);
      if (!okA && !okB) return false;
      cx += sx; cy += sy; ix++; iy++;
    } else if (t < 0) {
      if (!bdrLosStep(g, state, cx, cy, cx + sx, cy, cx + sx === x1 && cy === y1)) return false;
      cx += sx; ix++;
    } else {
      if (!bdrLosStep(g, state, cx, cy, cx, cy + sy, cx === x1 && cy + sy === y1)) return false;
      cy += sy; iy++;
    }
  }
  return true;
}

// Укрытие цели: ящик или пульт вплотную к цели со стороны стрелка, в той же комнате
function bdrCover(g, x0, y0, tx, ty) {
  if (Math.max(Math.abs(tx - x0), Math.abs(ty - y0)) <= 1) return 0;
  var o = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (var i = 0; i < 4; i++) {
    var cx = tx + o[i][0], cy = ty + o[i][1];
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) continue;
    var c = cy * g.w + cx;
    if (g.solid[c] !== 1 || g.zone[c] !== g.zone[ty * g.w + tx]) continue;
    if (o[i][0] * (x0 - tx) > 0 || o[i][1] * (y0 - ty) > 0) return BDR_COVER;
  }
  return 0;
}

// Куда боец дойдёт: поиск в ширину до maxSteps шагов. Сквозь своих можно пройти,
// сквозь врагов — нет, встать — только на пустую клетку. occ: «x,y» → сторона
function bdrReach(g, state, sx, sy, maxSteps, occ, side) {
  var dist = {}, prev = {}, q = [sy * g.w + sx], head = 0;
  dist[q[0]] = 0;
  var nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (head < q.length) {
    var k = q[head++], d = dist[k];
    if (d >= maxSteps) continue;
    var x = k % g.w, y = (k - x) / g.w;
    for (var i = 0; i < 8; i++) {
      var nx = x + nb[i][0], ny = y + nb[i][1];
      var nk = ny * g.w + nx;
      if (dist[nk] !== undefined) continue;
      if (!bdrStepOk(g, state, x, y, nx, ny)) continue;
      var o = occ[nx + ',' + ny];
      if (o && o !== side) continue;
      dist[nk] = d + 1; prev[nk] = k;
      q.push(nk);
    }
  }
  return { dist: dist, prev: prev, w: g.w, sx: sx, sy: sy, occ: occ };
}

// Путь до клетки (без стартовой), или null
function bdrPath(r, x, y) {
  var k = y * r.w + x;
  if (r.dist[k] === undefined || r.dist[k] === 0) return null;
  if (r.occ[x + ',' + y]) return null;
  var out = [];
  while (k !== undefined && r.dist[k] > 0) {
    out.push([k % r.w, Math.floor(k / r.w)]);
    k = r.prev[k];
  }
  return out.reverse();
}
