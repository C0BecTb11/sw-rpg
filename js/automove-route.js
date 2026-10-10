// Путь автохода в обход препятствий — точная копия automove_route на сервере.
// Клиент считает его сам только для предпросмотра (нить и число шагов до
// «Вперёд»); настоящий путь всё равно прокладывает и проверяет база.
// Порядок соседей, окно поиска и формулы прямой совпадают с сервером —
// иначе предпросмотр обещал бы одну дорогу, а бойцы пошли бы другой.
//
// o = { grid, w, h, x0, y0, x1, y1, range, obstacles: [{x, y, w, h}] }
// Возвращает шаги [[x, y], ...] — верхний левый угол корпуса на каждом шаге.

// Прежняя прямая: n = ceil(dist / range) равных долей, последняя — цель
function amrLine(x0, y0, x1, y1, range) {
  var dx = x1 - x0, dy = y1 - y0;
  var dist = Math.max(Math.abs(dx), Math.abs(dy));
  var out = [];
  if (!dist) return out;
  var n = Math.ceil(dist / Math.max(1, range));
  for (var k = 1; k <= n; k++) {
    out.push([x0 + Math.floor((2 * dx * k + n) / (2 * n)),
              y0 + Math.floor((2 * dy * k + n) / (2 * n))]);
  }
  return out;
}

function amRoute(o) {
  var M = 14;
  var r = Math.max(1, o.range | 0);
  var W = o.w || 1, H = o.h || 1;
  var mx = o.grid - W, my = o.grid - H;
  var x0 = o.x0, y0 = o.y0;
  var tx = Math.min(Math.max(o.x1, 0), mx), ty = Math.min(Math.max(o.y1, 0), my);
  if (x0 === tx && y0 === ty) return [];

  var rx0 = Math.max(0, Math.min(x0, tx) - M), rx1 = Math.min(mx, Math.max(x0, tx) + M);
  var ry0 = Math.max(0, Math.min(y0, ty) - M), ry1 = Math.min(my, Math.max(y0, ty) + M);
  rx0 = Math.min(rx0, x0); ry0 = Math.min(ry0, y0); rx1 = Math.max(rx1, x0); ry1 = Math.max(ry1, y0);
  var rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1, n = rw * rh;
  var idx = function(x, y) { return (y - ry0) * rw + (x - rx0); };

  // Клетки, где верхний левый угол корпуса упрётся в препятствие
  var blk = new Uint8Array(n);
  (o.obstacles || []).forEach(function(ob) {
    var ax = Math.max(rx0, ob.x - W + 1), bx = Math.min(rx1, ob.x + ob.w - 1);
    var ay = Math.max(ry0, ob.y - H + 1), by = Math.min(ry1, ob.y + ob.h - 1);
    for (var yy = ay; yy <= by; yy++) {
      for (var xx = ax; xx <= bx; xx++) blk[idx(xx, yy)] = 1;
    }
  });

  var s = idx(x0, y0), t = idx(tx, ty);
  var sblk = !!blk[s];
  var cellX = function(i) { return rx0 + i % rw; };
  var cellY = function(i) { return ry0 + Math.floor(i / rw); };

  // 1. Прямая, если ни один прыжок не задевает препятствие
  var hops = amrLine(x0, y0, tx, ty, r);
  var ok = true, px = x0, py = y0;
  for (var hi = 0; hi < hops.length && ok; hi++) {
    var hx = hops[hi][0], hy = hops[hi][1];
    var st = Math.max(Math.abs(hx - px), Math.abs(hy - py));
    for (var k = 1; k <= st; k++) {
      var qx = px + Math.floor((2 * (hx - px) * k + st) / (2 * st));
      var qy = py + Math.floor((2 * (hy - py) * k + st) / (2 * st));
      if (blk[idx(qx, qy)] && !(sblk && hi === 0)) { ok = false; break; }
    }
    px = hx; py = hy;
  }
  if (ok) return hops;

  // 2. Цель под препятствием — ближайшая свободная клетка у неё
  if (blk[t]) {
    var found = false;
    for (var ring = 1; ring <= Math.max(rw, rh) && !found; ring++) {
      var best0 = -1, bestE = 0;
      for (var yy = Math.max(ry0, ty - ring); yy <= Math.min(ry1, ty + ring); yy++) {
        for (var xx = Math.max(rx0, tx - ring); xx <= Math.min(rx1, tx + ring); xx++) {
          if (Math.max(Math.abs(xx - tx), Math.abs(yy - ty)) !== ring) continue;
          var ci = idx(xx, yy);
          if (blk[ci]) continue;
          var e = (xx - tx) * (xx - tx) + (yy - ty) * (yy - ty) + (xx - x0) * (xx - x0) + (yy - y0) * (yy - y0);
          if (best0 < 0 || e < bestE) { best0 = ci; bestE = e; }
        }
      }
      if (best0 >= 0) { t = best0; found = true; }
    }
    if (!found || t === s) return [];
    tx = cellX(t); ty = cellY(t);
  }

  // 3. Поиск в ширину; по диагонали — только если оба боковых соседа свободны
  var DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  var par = new Int32Array(n);
  for (var pi = 0; pi < n; pi++) par[pi] = -1;
  var q = new Int32Array(n);
  var qh = 0, qt = 0;
  par[s] = s; q[qt++] = s;
  var best = s;
  var bestD = Math.max(Math.abs(x0 - tx), Math.abs(y0 - ty));
  var bestEE = (x0 - tx) * (x0 - tx) + (y0 - ty) * (y0 - ty);
  while (qh < qt) {
    var cur = q[qh++];
    if (cur === t) break;
    var cx = cellX(cur), cy = cellY(cur);
    var dd = Math.max(Math.abs(cx - tx), Math.abs(cy - ty));
    var ee = (cx - tx) * (cx - tx) + (cy - ty) * (cy - ty);
    if (dd < bestD || (dd === bestD && ee < bestEE)) { best = cur; bestD = dd; bestEE = ee; }
    var esc = blk[cur] && sblk;
    for (var d = 0; d < 8; d++) {
      var nx = cx + DX[d], ny = cy + DY[d];
      if (nx < rx0 || nx > rx1 || ny < ry0 || ny > ry1) continue;
      var ni = idx(nx, ny);
      if (par[ni] !== -1) continue;
      if (blk[ni] && !esc) continue;
      if (d > 3 && !esc && (blk[idx(nx, cy)] || blk[idx(cx, ny)])) continue;
      par[ni] = cur; q[qt++] = ni;
    }
  }
  if (par[t] !== -1) best = t;
  if (best === s) return [];

  var path = [];
  for (var c = best; c !== s; c = par[c]) path.unshift(c);

  // 4. Шаги: самая дальняя клетка пути в пределах хода с чистой прямой
  var res = [];
  px = x0; py = y0;
  var i = 0;
  while (i < path.length) {
    var j = Math.min(path.length, i + r);
    var wx, wy;
    for (;;) {
      wx = cellX(path[j - 1]); wy = cellY(path[j - 1]);
      if (j === i + 1) break;
      var good = !blk[path[j - 1]];
      if (good && Math.max(Math.abs(wx - px), Math.abs(wy - py)) <= r) {
        var stp = Math.max(Math.abs(wx - px), Math.abs(wy - py));
        var fromBlk = sblk && blk[idx(px, py)];
        for (var kk = 1; kk <= stp; kk++) {
          var sx = px + Math.floor((2 * (wx - px) * kk + stp) / (2 * stp));
          var sy = py + Math.floor((2 * (wy - py) * kk + stp) / (2 * stp));
          if (blk[idx(sx, sy)] && !fromBlk) { good = false; break; }
        }
      } else {
        good = false;
      }
      if (good) break;
      j--;
    }
    res.push([wx, wy]);
    px = wx; py = wy; i = j;
  }
  return res;
}

// Пересекается ли корпус w×h в (x, y) с каким-нибудь препятствием
function amrBlocked(obstacles, x, y, w, h) {
  for (var i = 0; i < obstacles.length; i++) {
    var o = obstacles[i];
    if (x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y) return true;
  }
  return false;
}
