// Абордаж: подсветка хода и целей, выстрелы, взрывы, плавный ход бойцов.
// Рисует поверх палубы из js/boarding-deck.js: подсветка — в координатах
// плана (под бойцами), прицелы и всплывающие цифры — в координатах экрана.

var BDC_BOLT = { republic: ['#5fb8ff', '#e6f6ff'], cis: ['#ff4a3a', '#ffe1d6'], other: ['#ffb84a', '#fff1d6'] };

// ---------- данные от страницы ----------

// ov: { reach: {cells: [[x, y, actions]]}, plan: {from, path, cost}, targets: [{key, x, y, chance, cover}], aim: key }
function bdcSetOverlay(ov) {
  if (!BDC) return;
  BDC.ov = ov || null;
  bdcDirty();
}

// Плавный ход бойца по клеткам пути (с начальной)
function bdcAnimMove(unitId, path) {
  if (!BDC || !path || path.length < 2 || BDC.reduce) return;
  BDC.anims = BDC.anims || {};
  BDC.anims[unitId] = { path: path, t0: performance.now(), per: 95 };
  bdcDirty();
}

// Где сейчас рисовать бойца: на пути хода или на своей клетке
function bdcUnitPos(u) {
  var a = BDC.anims && BDC.anims[u.id];
  if (a) {
    var k = (performance.now() - a.t0) / a.per;
    var last = a.path[a.path.length - 1];
    if (k >= a.path.length - 1 || last[0] !== u.x || last[1] !== u.y) { delete BDC.anims[u.id]; }
    else {
      var i = Math.floor(k), f = k - i, e = f * f * (3 - 2 * f);
      var p0 = a.path[i], p1 = a.path[i + 1];
      return [p0[0] + 0.5 + (p1[0] - p0[0]) * e, p0[1] + 0.5 + (p1[1] - p0[1]) * e];
    }
  }
  return [u.x + 0.5, u.y + 0.5];
}

function bdcFxAdd(fx) {
  if (!BDC) return;
  BDC.fx = BDC.fx || [];
  fx.t0 = performance.now() + (fx.delay || 0);
  BDC.fx.push(fx);
  bdcDirty();
}

// Выстрел: трассер, вспышка у ствола, искры у цели, цифра урона
function bdcFxShot(e, col, delay) {
  delay = delay || 0;
  var pal = BDC_BOLT[col] || BDC_BOLT.other;
  bdcFxAdd({ k: 'bolt', d: e.d, f: e.f, t: e.t, hit: !!e.hit, c: pal, dur: 520, delay: delay, seed: e.s || 0 });
  if (e.hit) {
    bdcFxAdd({ k: 'float', d: e.d, x: e.t[0], y: e.t[1], text: '−' + (e.dmg || 0), kind: 'dmg', dur: 1500, delay: delay + 170 });
    if (e.kill) {
      bdcFxAdd({ k: 'boom', d: e.d, x: e.t[0], y: e.t[1], dur: 900, delay: delay + 170, seed: e.s || 0 });
      bdcFxAdd({ k: 'float', d: e.d, x: e.t[0], y: e.t[1], text: e.tt ? 'РАЗБИТА' : 'УНИЧТОЖЕН', kind: 'kill', dur: 1700, delay: delay + 420 });
    }
  } else {
    bdcFxAdd({ k: 'float', d: e.d, x: e.t[0], y: e.t[1], text: 'ПРОМАХ', kind: 'miss', dur: 1400, delay: delay + 170 });
  }
}

function bdcFxWarp(d, x, y, delay) {
  bdcFxAdd({ k: 'warp', d: d, x: x, y: y, dur: 700, delay: delay || 0 });
}

function bdcFxBusy() {
  if (!BDC) return false;
  var now = performance.now();
  if (BDC.fx && BDC.fx.length) {
    BDC.fx = BDC.fx.filter(function(f) { return now - f.t0 < f.dur; });
    if (BDC.fx.length) return true;
  }
  // Ход, который так и не дорисовали (боец ушёл в туман, открыта другая палуба), — снимаем
  var busy = false;
  if (BDC.anims) for (var k in BDC.anims) {
    if (!BDC.anims.hasOwnProperty(k)) continue;
    var a = BDC.anims[k];
    if (now - a.t0 > (a.path.length - 1) * a.per) delete BDC.anims[k];
    else busy = true;
  }
  return busy;
}

// ---------- подсветка хода (план) ----------

function bdcDrawReach(c, s, T) {
  var ov = BDC.ov;
  if (!ov || !ov.reach || !ov.reach.cells) return;
  var map = {};
  ov.reach.cells.forEach(function(q) { map[q[0] + ',' + q[1]] = q[2]; });
  var lw = Math.max(0.04, 1.4 / s);
  c.save();
  ov.reach.cells.forEach(function(q) {
    var one = q[2] === 1;
    c.fillStyle = one ? 'rgba(95,217,104,0.13)' : 'rgba(217,169,64,0.09)';
    c.fillRect(q[0] + 0.04, q[1] + 0.04, 0.92, 0.92);
  });
  // Контур областей «1 действие» и «2 действия»
  [[1, 'rgba(125,255,138,0.75)'], [2, 'rgba(240,200,106,0.55)']].forEach(function(z) {
    c.strokeStyle = z[1]; c.lineWidth = lw * (z[0] === 1 ? 1.4 : 1);
    c.beginPath();
    ov.reach.cells.forEach(function(q) {
      if (q[2] > z[0]) return;
      var x = q[0], y = q[1];
      var inn = function(a, b) { var v = map[a + ',' + b]; return v !== undefined && v <= z[0]; };
      if (!inn(x, y - 1)) { c.moveTo(x, y); c.lineTo(x + 1, y); }
      if (!inn(x, y + 1)) { c.moveTo(x, y + 1); c.lineTo(x + 1, y + 1); }
      if (!inn(x - 1, y)) { c.moveTo(x, y); c.lineTo(x, y + 1); }
      if (!inn(x + 1, y)) { c.moveTo(x + 1, y); c.lineTo(x + 1, y + 1); }
    });
    c.stroke();
  });
  // Путь и точка назначения
  var pl = ov.plan;
  if (pl && pl.path && pl.path.length) {
    var pts = [pl.from].concat(pl.path);
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = Math.max(0.16, 5 / s);
    c.beginPath(); pts.forEach(function(p, i) { if (i) c.lineTo(p[0] + 0.5, p[1] + 0.5); else c.moveTo(p[0] + 0.5, p[1] + 0.5); }); c.stroke();
    c.strokeStyle = pl.cost > 1 ? '#f0c86a' : '#7dff8a'; c.lineWidth = Math.max(0.08, 2.4 / s);
    c.setLineDash([0.22, 0.16]); c.lineDashOffset = BDC.reduce ? 0 : -T * 0.9;
    c.stroke(); c.setLineDash([]);
    var e = pts[pts.length - 1], k = BDC.reduce ? 1 : 0.5 + 0.5 * Math.sin(T * 5);
    c.strokeStyle = pl.cost > 1 ? 'rgba(240,200,106,0.95)' : 'rgba(125,255,138,0.95)';
    c.lineWidth = Math.max(0.06, 2 / s);
    c.beginPath(); c.arc(e[0] + 0.5, e[1] + 0.5, 0.34 + 0.05 * k, 0, 7); c.stroke();
    c.beginPath(); c.arc(e[0] + 0.5, e[1] + 0.5, 0.12, 0, 7);
    c.fillStyle = c.strokeStyle; c.fill();
  }
  c.restore();
}

// ---------- прицелы (экран) ----------

function bdcDrawTargets(c, s, T) {
  var ov = BDC.ov;
  if (!ov || !ov.targets || !ov.targets.length) return;
  var r = Math.max(9, s * 0.5);
  ov.targets.forEach(function(t) {
    var p = bdcToScreen(t.x + 0.5, t.y + 0.5);
    var on = ov.aim === t.key;
    var k = BDC.reduce ? 1 : 0.5 + 0.5 * Math.sin(T * 6);
    var rr = r + (on ? 4 + 2 * k : 2);
    c.save();
    c.translate(p[0], p[1]);
    if (on && !BDC.reduce) c.rotate(T * 0.8);
    c.strokeStyle = on ? '#ff5a4f' : 'rgba(255,90,79,0.8)';
    c.lineWidth = on ? 2.4 : 1.6;
    c.shadowColor = 'rgba(255,60,40,0.9)'; c.shadowBlur = on ? 10 : 4;
    var L = rr * 0.42;
    for (var i = 0; i < 4; i++) {
      c.rotate(Math.PI / 2);
      c.beginPath(); c.moveTo(rr, -rr + L); c.lineTo(rr, -rr); c.lineTo(rr - L, -rr); c.stroke();
    }
    c.restore();
    // Шанс попадания под прицелом
    if (s >= 14) {
      var txt = t.chance + '%' + (t.cover ? ' · укр' : '');
      c.font = 'bold ' + (on ? 12 : 10) + 'px "Courier New", monospace';
      var w = c.measureText(txt).width + 8, y = p[1] + rr + 4;
      c.fillStyle = on ? 'rgba(120,16,10,0.92)' : 'rgba(10,6,8,0.85)';
      bdcRR(c, p[0] - w / 2, y, w, on ? 16 : 14, 4); c.fill();
      c.strokeStyle = 'rgba(255,90,79,0.8)'; c.lineWidth = 1; c.stroke();
      c.fillStyle = '#ffd6cf'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(txt, p[0], y + (on ? 8 : 7));
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    }
  });
  // Линия от стрелка к выбранной цели
  var u = bdSel ? bdUnitById(bdSel) : null, t2 = null;
  ov.targets.forEach(function(t) { if (t.key === ov.aim) t2 = t; });
  if (u && t2 && u.deck === BDC.dk.n) {
    var a = bdcToScreen.apply(null, bdcUnitPos(u)), b = bdcToScreen(t2.x + 0.5, t2.y + 0.5);
    c.save();
    c.strokeStyle = 'rgba(255,90,79,0.75)'; c.lineWidth = 1.6; c.setLineDash([6, 5]);
    c.lineDashOffset = BDC.reduce ? 0 : -T * 30;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    c.restore();
  }
}

// Стоимость хода у точки назначения
function bdcDrawPlanCost(c, s) {
  var pl = BDC.ov && BDC.ov.plan;
  if (!pl || !pl.path || !pl.path.length) return;
  var e = pl.path[pl.path.length - 1];
  var p = bdcToScreen(e[0] + 0.5, e[1] + 0.5);
  var txt = pl.cost + ' д.';
  c.font = 'bold 11px "Courier New", monospace';
  var w = c.measureText(txt).width + 10, y = p[1] - Math.max(14, s * 0.5) - 16;
  c.fillStyle = 'rgba(8,11,17,0.92)'; bdcRR(c, p[0] - w / 2, y, w, 16, 5); c.fill();
  c.strokeStyle = pl.cost > 1 ? '#f0c86a' : '#7dff8a'; c.lineWidth = 1; c.stroke();
  c.fillStyle = pl.cost > 1 ? '#f0c86a' : '#7dff8a'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(txt, p[0], y + 8);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}

// ---------- эффекты ----------

function bdcDrawFxPlan(c, s, now) {
  if (!BDC.fx || !BDC.fx.length) return;
  var dk = BDC.dk;
  c.save();
  c.globalCompositeOperation = 'lighter';
  BDC.fx.forEach(function(f) {
    if (f.d !== dk.n) return;
    var t = (now - f.t0) / f.dur;
    if (t < 0 || t > 1) return;
    if (f.k === 'bolt') bdcFxBolt(c, f, t, s);
    else if (f.k === 'boom') bdcFxBoom(c, f, t);
    else if (f.k === 'warp') bdcFxWarpDraw(c, f, t);
    else if (f.k === 'charge' || f.k === 'vent' || f.k === 'weld') bdcFxGoals(c, f, t, s);
  });
  c.restore();
}

function bdcFxBolt(c, f, t, s) {
  var x0 = f.f[0] + 0.5, y0 = f.f[1] + 0.5, x1 = f.t[0] + 0.5, y1 = f.t[1] + 0.5;
  var dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  if (!f.hit) {
    // Мимо: конец уходит в сторону и дальше цели
    var side = (f.seed % 2 ? 1 : -1) * 0.45;
    x1 += -dy / L * side + dx / L * 0.8; y1 += dx / L * side + dy / L * 0.8;
    dx = x1 - x0; dy = y1 - y0; L = Math.hypot(dx, dy) || 1;
  }
  var travel = 0.32;                         // доля времени на полёт
  var col = f.c[0], core = f.c[1];
  // Вспышка у ствола
  if (t < 0.25) {
    var m = 1 - t / 0.25;
    var g = c.createRadialGradient(x0, y0, 0, x0, y0, 0.55);
    g.addColorStop(0, bdcAlpha(core, 0.9 * m)); g.addColorStop(0.4, bdcAlpha(col, 0.6 * m)); g.addColorStop(1, bdcAlpha(col, 0));
    c.fillStyle = g; c.fillRect(x0 - 0.6, y0 - 0.6, 1.2, 1.2);
  }
  if (t < travel) {
    var k = t / travel, seg = Math.min(1.4, L * 0.6);
    var hx = x0 + dx * k, hy = y0 + dy * k;
    var tx = hx - dx / L * seg, ty = hy - dy / L * seg;
    if (k * L < seg) { tx = x0; ty = y0; }
    c.lineCap = 'round';
    c.strokeStyle = bdcAlpha(col, 0.55); c.lineWidth = Math.max(0.16, 6 / s);
    c.beginPath(); c.moveTo(tx, ty); c.lineTo(hx, hy); c.stroke();
    c.strokeStyle = bdcAlpha(core, 0.95); c.lineWidth = Math.max(0.06, 2.2 / s);
    c.beginPath(); c.moveTo(tx, ty); c.lineTo(hx, hy); c.stroke();
  } else if (f.hit) {
    // Попадание: вспышка и искры
    var q = (t - travel) / (1 - travel);
    var g2 = c.createRadialGradient(x1, y1, 0, x1, y1, 0.75);
    g2.addColorStop(0, bdcAlpha(core, 0.95 * (1 - q))); g2.addColorStop(0.35, bdcAlpha(col, 0.7 * (1 - q))); g2.addColorStop(1, bdcAlpha(col, 0));
    c.fillStyle = g2; c.fillRect(x1 - 0.8, y1 - 0.8, 1.6, 1.6);
    for (var i = 0; i < 7; i++) {
      var a = (f.seed * 1.7 + i * 0.9) % (Math.PI * 2), r = 0.15 + q * (0.5 + (i % 3) * 0.2);
      c.fillStyle = bdcAlpha(core, 0.9 * (1 - q));
      c.beginPath(); c.arc(x1 + Math.cos(a) * r, y1 + Math.sin(a) * r, 0.04 * (1 - q) + 0.015, 0, 7); c.fill();
    }
  } else {
    // Промах: след тает
    var q2 = (t - travel) / (1 - travel);
    c.strokeStyle = bdcAlpha(col, 0.35 * (1 - q2)); c.lineWidth = Math.max(0.05, 2 / s);
    c.beginPath(); c.moveTo(x0 + dx * 0.6, y0 + dy * 0.6); c.lineTo(x1, y1); c.stroke();
  }
}

function bdcFxBoom(c, f, t) {
  var x = f.x + 0.5, y = f.y + 0.5;
  var g = c.createRadialGradient(x, y, 0, x, y, 0.4 + t * 1.2);
  g.addColorStop(0, 'rgba(255,240,200,' + 0.9 * (1 - t) + ')');
  g.addColorStop(0.4, 'rgba(255,140,40,' + 0.6 * (1 - t) + ')');
  g.addColorStop(1, 'rgba(255,60,20,0)');
  c.fillStyle = g; c.fillRect(x - 2, y - 2, 4, 4);
  c.strokeStyle = 'rgba(255,170,90,' + 0.8 * (1 - t) + ')'; c.lineWidth = 0.06;
  c.beginPath(); c.arc(x, y, 0.3 + t * 1.3, 0, 7); c.stroke();
  for (var i = 0; i < 10; i++) {
    var a = (f.seed * 2.3 + i * 0.63) % (Math.PI * 2), r = 0.2 + t * (0.6 + (i % 4) * 0.25);
    c.fillStyle = 'rgba(255,' + (200 - i * 10) + ',80,' + (1 - t) + ')';
    c.beginPath(); c.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, 0.05 * (1 - t) + 0.02, 0, 7); c.fill();
  }
}

function bdcFxWarpDraw(c, f, t) {
  var x = f.x + 0.5, y = f.y + 0.5;
  c.strokeStyle = 'rgba(140,200,255,' + 0.85 * (1 - t) + ')'; c.lineWidth = 0.07;
  for (var i = 0; i < 3; i++) {
    var r = 0.15 + ((t + i * 0.25) % 1) * 0.8;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.stroke();
  }
  var g = c.createRadialGradient(x, y, 0, x, y, 0.8);
  g.addColorStop(0, 'rgba(200,230,255,' + 0.6 * (1 - t) + ')'); g.addColorStop(1, 'rgba(120,180,255,0)');
  c.fillStyle = g; c.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
}

// Всплывающие цифры: тот же вид, что на земле (красный урон, серый промах, плашка гибели)
function bdcDrawFxScreen(c, s, now) {
  if (!BDC.fx || !BDC.fx.length) return;
  var dk = BDC.dk;
  BDC.fx.forEach(function(f) {
    if (f.k !== 'float' || f.d !== dk.n) return;
    var t = (now - f.t0) / f.dur;
    if (t < 0 || t > 1) return;
    var p = bdcToScreen(f.x + 0.5, f.y + 0.5);
    var y0 = p[1] - Math.max(12, s * 0.45);
    var rise, sc, op;
    if (t < 0.12) { op = t / 0.12; sc = 0.7 + 0.42 * (t / 0.12); rise = 6 - 10 * (t / 0.12); }
    else if (t < 0.25) { op = 1; sc = 1.12 - 0.12 * ((t - 0.12) / 0.13); rise = -4 - 4 * ((t - 0.12) / 0.13); }
    else { op = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25; sc = 1; rise = -8 - 30 * ((t - 0.25) / 0.75); }
    c.save();
    c.globalAlpha = Math.max(0, op);
    c.translate(p[0], y0 + rise); c.scale(sc, sc);
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    if (f.kind === 'kill') {
      c.font = 'bold 11px "Courier New", monospace';
      var w = c.measureText(f.text).width + 16;
      c.fillStyle = 'rgba(217,74,74,0.92)'; bdcRR(c, -w / 2, -14, w, 18, 4); c.fill();
      c.fillStyle = '#fff'; c.fillText(f.text, 0, 0);
    } else {
      var fs = f.kind === 'dmg' ? 18 : f.kind === 'miss' ? 12 : 16;
      c.font = 'bold ' + fs + 'px "Courier New", monospace';
      c.lineWidth = 3.4; c.lineJoin = 'round'; c.strokeStyle = 'rgba(0,0,0,0.92)';
      c.strokeText(f.text, 0, 0);
      c.fillStyle = f.kind === 'dmg' ? '#ff6b4a' : f.kind === 'heal' ? '#5fd968' : '#cfd8dc';
      c.fillText(f.text, 0, 0);
    }
    c.restore();
  });
}

// ---------- цели и отсеки (js/boarding-goals.js) ----------

var BDC_HOLD = { own: '#5fd968', foe: '#ff5a4f' };

function bdcAreaPath(a) {
  if (a._path) return a._path;
  var p = new Path2D();
  a.runs.forEach(function(r) { p.rect(r[0], r[1], r[2], r[3]); });
  a._path = p;
  return p;
}

// План: кто держит отсеки с ролью, мостик под захватом, заряд в реакторе
function bdcGoalsPlan(c, dk, g, s, T) {
  if (!bdState || bdState.status !== 'active' || typeof bdgList !== 'function') return;
  var mine = bdMine(), pulse = BDC.reduce ? 0.5 : 0.5 + 0.5 * Math.sin(T * 3);
  c.save();
  bdgList().forEach(function(r) {
    if (r.deck !== dk.n) return;
    var a = g.areas[r.area], who = bdgHolder(r.role);
    if (!a || !who) return;
    var col = who === mine ? BDC_HOLD.own : BDC_HOLD.foe;
    var on = bdgOn(r.role);
    c.fillStyle = bdcAlpha(col, on ? 0.07 + 0.04 * pulse : 0.05);
    c.fill(bdcAreaPath(a));
  });
  // Мостик: атакующие одни внутри — золото с бегущей штриховкой
  if (bdgBridgeLeft() !== null) {
    bdgList().forEach(function(r) {
      if (r.role !== 'bridge' || r.deck !== dk.n) return;
      var a = g.areas[r.area];
      if (!a) return;
      var path = bdcAreaPath(a);
      c.fillStyle = 'rgba(240,200,106,' + (0.07 + 0.08 * pulse) + ')'; c.fill(path);
      c.save();
      c.clip(path);
      c.strokeStyle = 'rgba(240,200,106,0.16)'; c.lineWidth = 0.18;
      var off = BDC.reduce ? 0 : (T * 1.2) % 1.2;
      for (var k = a.minx - (a.maxy - a.miny) - 2; k < a.maxx + 2; k += 1.2) {
        c.beginPath(); c.moveTo(k + off, a.maxy + 1.5); c.lineTo(k + off + (a.maxy - a.miny) + 3, a.miny - 1.5); c.stroke();
      }
      c.restore();
    });
  }
  // Заряд: пульсирующий красный маяк
  var ch = bdState.charge;
  if (ch && ch.deck === dk.n) {
    var x = ch.x + 0.5, y = ch.y + 0.5;
    var left = bdgChargeLeft() || 0;
    var fast = left < 60 ? 9 : left < 120 ? 6 : 3.4;
    var k2 = BDC.reduce ? 0.6 : 0.5 + 0.5 * Math.sin(T * fast);
    var gr = c.createRadialGradient(x, y, 0, x, y, 1.6);
    gr.addColorStop(0, 'rgba(255,70,50,' + (0.45 + 0.35 * k2) + ')');
    gr.addColorStop(0.45, 'rgba(255,40,30,' + (0.18 + 0.12 * k2) + ')');
    gr.addColorStop(1, 'rgba(255,30,20,0)');
    c.fillStyle = gr; c.fillRect(x - 1.6, y - 1.6, 3.2, 3.2);
    c.save();
    c.translate(x, y);
    if (!BDC.reduce) c.rotate(T * 1.4);
    c.strokeStyle = 'rgba(255,120,100,0.9)'; c.lineWidth = Math.max(0.05, 1.8 / s);
    c.setLineDash([0.18, 0.12]);
    c.beginPath(); c.arc(0, 0, 0.55, 0, 7); c.stroke();
    c.restore();
    // Сам заряд: шайба с мигающим огнём
    c.fillStyle = '#2a0f0d'; c.beginPath(); c.arc(x, y, 0.26, 0, 7); c.fill();
    c.strokeStyle = '#ff6b4a'; c.lineWidth = Math.max(0.04, 1.4 / s); c.stroke();
    c.fillStyle = k2 > 0.5 ? '#ffe1d6' : '#ff3b2a';
    c.beginPath(); c.arc(x, y, 0.09, 0, 7); c.fill();
  }
  c.restore();
}

// Экран: отсчёты над зарядом и мостиком
function bdcGoalsScreen(c, dk, g, s, T) {
  if (!bdState || bdState.status !== 'active' || typeof bdgList !== 'function') return;
  var pill = function(x, y, txt, col, fill, pct) {
    c.font = 'bold 11px "Courier New", monospace';
    var w = c.measureText(txt).width + 16;
    c.fillStyle = fill; bdcRR(c, x - w / 2, y - 9, w, 18, 9); c.fill();
    c.strokeStyle = col; c.lineWidth = 1.2; c.stroke();
    if (pct !== undefined) {
      c.save(); bdcRR(c, x - w / 2, y - 9, w, 18, 9); c.clip();
      c.fillStyle = bdcAlpha(col, 0.28); c.fillRect(x - w / 2, y - 9, w * Math.max(0, Math.min(1, pct)), 18);
      c.restore();
    }
    c.fillStyle = col; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(txt, x, y + 0.5);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  };
  var ch = bdState.charge;
  if (ch && ch.deck === dk.n) {
    var left = bdgChargeLeft() || 0;
    var p = bdcToScreen(ch.x + 0.5, ch.y + 0.5);
    pill(p[0], p[1] - Math.max(18, s * 0.9), 'ЗАРЯД ' + bdClock(left), '#ff8a75', 'rgba(60,8,6,0.92)', 1 - left / bdgChargeTotal());
  }
  var bl = bdgBridgeLeft();
  if (bl !== null) {
    bdgList().forEach(function(r) {
      if (r.role !== 'bridge' || r.deck !== dk.n) return;
      var a = g.areas[r.area];
      if (!a) return;
      var q = bdcToScreen(a.big[0] + a.big[2] / 2, a.big[1] + a.big[3] / 2);
      var mine = bdState.side === 'att';
      pill(q[0], q[1], (mine ? 'ЗАХВАТ ' : 'ПОТЕРЯ ') + bdClock(bl), mine ? '#f0d48a' : '#ff8a75',
           mine ? 'rgba(40,30,8,0.92)' : 'rgba(60,8,6,0.92)', 1 - bl / bdState.bridge.need);
    });
  }
}

// Тьма: энергоузел у атакующего — видно только около своих бойцов
function bdcDarkness(c, dk, s, T) {
  if (typeof bdgDark !== 'function' || !bdgDark(dk.n)) return;
  var vw = BDC.vw, vh = BDC.vh, dpr = BDC.dpr;
  var cv = BDC.darkCv || (BDC.darkCv = document.createElement('canvas'));
  var W = Math.round(vw * dpr), H = Math.round(vh * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  var x = cv.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, vw, vh);
  var flick = BDC.reduce ? 0 : 0.03 * Math.sin(T * 7.3) * Math.sin(T * 2.1);
  x.fillStyle = 'rgba(2,4,10,' + (0.84 + flick) + ')';
  x.fillRect(0, 0, vw, vh);
  x.globalCompositeOperation = 'destination-out';
  var R = Math.max(26, s * 2.6), mine = bdMine();
  bdUnits(dk.n).forEach(function(u) {
    if (u.side !== mine) return;
    var p = bdcToScreen.apply(null, bdcUnitPos(u));
    var gr = x.createRadialGradient(p[0], p[1], R * 0.2, p[0], p[1], R);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.8)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.fillRect(p[0] - R, p[1] - R, R * 2, R * 2);
  });
  c.drawImage(cv, 0, 0, vw, vh);
  // Аварийные огни: тусклый красный по краю
  if (!BDC.reduce) {
    var k = 0.05 + 0.05 * (0.5 + 0.5 * Math.sin(T * 1.7));
    var vg = c.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.4, vw / 2, vh / 2, Math.max(vw, vh) * 0.75);
    vg.addColorStop(0, 'rgba(160,20,10,0)'); vg.addColorStop(1, 'rgba(160,20,10,' + k + ')');
    c.fillStyle = vg; c.fillRect(0, 0, vw, vh);
  }
}

// Плашка тьмы — поверх подписей, чтобы читалась
function bdcDarkBadge(c, dk) {
  if (typeof bdgDark !== 'function' || !bdgDark(dk.n)) return;
  c.font = 'bold 10px "Courier New", monospace';
  var txt = 'БЕЗ СВЕТА · ОБЗОР 2 КЛЕТКИ · ТУРЕЛИ МОЛЧАТ';
  var w = c.measureText(txt).width + 18;
  var x = 10, y = 10;
  if (BDC.miniRect && x + w > BDC.miniRect.x - 8) w = Math.max(60, BDC.miniRect.x - 8 - x);
  c.save();
  c.fillStyle = 'rgba(30,14,4,0.94)'; bdcRR(c, x, y, w, 18, 9); c.fill();
  c.strokeStyle = 'rgba(227,162,74,0.8)'; c.lineWidth = 1; c.stroke();
  c.beginPath(); bdcRR(c, x, y, w, 18, 9); c.clip();
  c.fillStyle = '#e3a24a'; c.textBaseline = 'middle'; c.fillText(txt, x + 9, y + 9.5);
  c.restore();
}

// Эффекты отсеков на плане: заряд, продувка, сварка
function bdcFxGoals(c, f, t, s) {
  if (f.k === 'charge') {
    var x = f.x + 0.5, y = f.y + 0.5, plant = f.act === 'plant';
    var col = plant ? '255,80,60' : '120,200,255';
    for (var i = 0; i < 3; i++) {
      var r = 0.2 + ((t * 1.6 + i * 0.33) % 1) * 1.6;
      c.strokeStyle = 'rgba(' + col + ',' + 0.8 * (1 - t) + ')'; c.lineWidth = 0.08;
      c.beginPath(); c.arc(x, y, r, 0, 7); c.stroke();
    }
    var g = c.createRadialGradient(x, y, 0, x, y, 1.2);
    g.addColorStop(0, 'rgba(' + col + ',' + 0.7 * (1 - t) + ')'); g.addColorStop(1, 'rgba(' + col + ',0)');
    c.fillStyle = g; c.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
  } else if (f.k === 'vent') {
    var a = bdcGeom(BDC.dk).areas[f.area];
    if (!a) return;
    c.save();
    c.clip(bdcAreaPath(a));
    var op = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    c.fillStyle = 'rgba(190,225,255,' + 0.22 * op + ')';
    c.fill(bdcAreaPath(a));
    // Порывы: косые полосы, сдуваемые к шлюзу продувки
    c.strokeStyle = 'rgba(225,245,255,' + 0.55 * op + ')'; c.lineCap = 'round';
    var w = a.maxx - a.minx + 1, h = a.maxy - a.miny + 1;
    for (var k = 0; k < 26; k++) {
      var sx = a.minx + ((k * 7.31 + f.seed) % w), sy = a.miny + ((k * 3.17 + f.seed * 0.7) % h);
      var len = 0.6 + (k % 4) * 0.35, run = ((t * 2.4 + k * 0.137) % 1) * (w + 2) - 1;
      c.lineWidth = 0.05 + (k % 3) * 0.03;
      c.beginPath(); c.moveTo(sx + run, sy); c.lineTo(sx + run + len, sy - len * 0.25); c.stroke();
    }
    c.restore();
  } else if (f.k === 'weld') {
    var wx = f.x + 0.5, wy = f.y + 0.5;
    for (var j = 0; j < 14; j++) {
      var ang = (f.seed * 1.3 + j * 0.71) % (Math.PI * 2), rr = 0.1 + t * (0.5 + (j % 3) * 0.25);
      c.fillStyle = 'rgba(255,' + (190 + (j % 3) * 20) + ',90,' + (1 - t) + ')';
      c.beginPath(); c.arc(wx + Math.cos(ang) * rr, wy + Math.sin(ang) * rr + t * t * 0.5, 0.04, 0, 7); c.fill();
    }
    var gw = c.createRadialGradient(wx, wy, 0, wx, wy, 0.6);
    gw.addColorStop(0, 'rgba(255,250,220,' + 0.9 * (1 - t) + ')'); gw.addColorStop(1, 'rgba(255,170,60,0)');
    c.fillStyle = gw; c.fillRect(wx - 0.6, wy - 0.6, 1.2, 1.2);
  }
}
