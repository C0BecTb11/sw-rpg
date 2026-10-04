// ===== Автоход на наземной карте =====
// Боец или отряд сам идёт к дальней точке. Каждый шаг — обычный ход
// за одно действие, его делает сервер (automove_tick), когда у бойца
// есть очко действия. Здесь только выбор точки, предпросмотр «нити»,
// живая нить идущих автоходов, строка состояния в панели и сводки.
//
// Нить рисуется отдельным SVG в слое #gb-fx: он уже двигается вместе
// с холстом, а сам холст 4608×4608 перерисовывать ради линий дорого.
// Толщины и пунктир держатся одинаковыми на любом зуме через --fx-inv.
//
// Геометрия шагов совпадает с серверной один в один (см. контракт):
// n = ceil(dist / range), xk = x0 + floor((2·dx·k + n) / (2n)).

var AM_MAX_GROUP = 12;     // столько же пропускает start_auto_move
var AM_NEAR_RADIUS = 6;    // «Все рядом»: зазор до ведущего в клетках
var AM_TICK = 10;          // шаги делает серверный тик раз в 10 с
var AM_SVG_NS = 'http://www.w3.org/2000/svg';

var amRows = [];           // ответ get_my_auto_moves: активные и недавно завершённые
var amFetchedAt = 0;       // когда пришёл ответ: от него тикает «шаг через N с»
var amLoadSeq = 0;
var amLoadApplied = 0;
var amLoadTimer = null;
var amPollTimer = null;
var amTicker = null;
var amSvg = null;
var amTags = null;
var amPick = null;         // режим выбора: { leaderId, ids, grouping, target, busy, error }
var amFocusIds = null;     // только что отправленный отряд светится ярко, пока не выбран другой
var amLeaders = {};        // group_id -> id ведущего (знаем только для своих запусков)
var amLeadUnits = {};      // кого вели при запуске: по ним находим ведущего в строках отряда
var amHpMemo = {};         // прочность идущих: по ней видно, кого именно ранили
var amSeen = {};           // id завершённых, о которых уже сказали
var amSeenStore = false;   // хранилище доступно: после перезагрузки не повторяемся
var amFirstLoad = true;
var amLastSelId = null;
var amStopAsk = null;      // id бойца, у которого раскрыт выбор «отряд / только он»
var amDisabled = false;    // на сервере ещё нет функций — молчим, ничего не ломаем

// ---------- Геометрия ----------

// Дальность одного шага: как в unit_stats на сервере
function amRange(u) {
  if (typeof unitMoveRange === 'function') return unitMoveRange(u);
  var t = unitTypeById[u.unit_type] || {};
  return Math.max(1, (t.move_range || 0) + (u.bonus_move || 0));
}

function amSteps(x0, y0, x1, y1, range) {
  var dx = x1 - x0, dy = y1 - y0;
  var dist = Math.max(Math.abs(dx), Math.abs(dy));
  if (!dist) return [];
  var r = Math.max(1, range | 0);
  var n = Math.ceil(dist / r);
  var out = [];
  for (var k = 1; k <= n; k++) {
    out.push([x0 + Math.floor((2 * dx * k + n) / (2 * n)),
              y0 + Math.floor((2 * dy * k + n) / (2 * n))]);
  }
  return out;
}

function amClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function amUnit(id) {
  for (var i = 0; i < unitsOnMap.length; i++) if (unitsOnMap[i].id === id) return unitsOnMap[i];
  return null;
}

function amOnMap(u) { return !!u && u.x !== null && u.x !== undefined; }

function amName(u) {
  var t = unitTypeById[u.unit_type] || {};
  return u.hero_id && u.hero_name ? u.hero_name : (t.name || 'Боец');
}

function amStepsWord(n) { return n + ' ' + stlPlural(n, 'шаг', 'шага', 'шагов'); }

// «≈ 3 мин 30 с»; ноль — «сразу», без приблизительности
function amEtaText(sec) { return sec <= 0 ? 'сразу' : '≈ ' + amDur(sec); }

function amDur(sec) {
  if (sec <= 0) return 'сразу';
  sec = Math.ceil(sec / 10) * 10;
  if (sec < 60) return sec + ' с';
  var m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
  return m + ' мин' + (s ? ' ' + s + ' с' : '');
}

// Почему бойцу нельзя в автоход. Нет действий — не причина: он подождёт
function amBlockReason(u) {
  if (!u || u.owner_user_id !== currentUserId) return 'не твой боец';
  if (!amOnMap(u)) return 'боец в транспорте';
  if (u.hp !== undefined && u.hp !== null && u.hp <= 0) return 'боец выбыл';
  if (u.transit_to) return 'боец в пути';
  if (u.training_until && new Date(u.training_until).getTime() > gbServerNow()) return 'боец на обучении';
  return '';
}

// Сколько ждать, пока боец сделает n шагов: очки, что есть, тратятся сразу,
// остальные копятся по одному за откат
function amEtaFor(u, n) {
  if (!n) return 0;
  var t = unitTypeById[u.unit_type] || {};
  var cd = t.action_seconds || gbApCd;
  var st = unitApState(u);
  var ap = st ? st.ap : 0;
  // Даже при полных очках шаги идут не чаще тика
  var floor = (n - 1) * AM_TICK;
  if (ap >= n) return floor;
  if (!st || ap >= st.ap_max) return Math.max(floor, (n - ap) * cd);
  return Math.max(floor, st.next_in + (n - ap - 1) * cd);
}

// ---------- Занятость точки финиша (то, что видно игроку) ----------

function amBoxBlocked(u, x, y, skip) {
  var b = unitBox(u);
  var t = unitTypeById[u.unit_type] || {};
  for (var i = 0; i < unitsOnMap.length; i++) {
    var o = unitsOnMap[i];
    if (!amOnMap(o) || o.id === u.id || skip[o.id]) continue;
    var ob = unitBox(o);
    if (boxOverlap(x, y, b.w, b.h, o.x, o.y, ob.w, ob.h)) return true;
  }
  for (var j = 0; j < fieldStructures.length; j++) {
    var s = fieldStructures[j];
    var st = structTypeById[s.type_id] || {};
    if (!boxOverlap(x, y, b.w, b.h, s.x, s.y, s.w || 1, s.h || 1)) continue;
    if (!st.enterable || s.faction !== u.faction || (st.infantry_only && t.is_vehicle)) return true;
  }
  for (var k = 0; k < buildSlots.length; k++) {
    if (!buildingsBySlot[k + 1]) continue;
    if (boxOverlap(x, y, b.w, b.h, buildSlots[k].x, buildSlots[k].y, SLOT_SIZE, SLOT_SIZE)) return true;
  }
  return false;
}

// ---------- Данные ----------

function amInit() {
  if (!systemId || amTicker) return;
  try {
    var raw = window.localStorage.getItem('am-seen-ground');
    var now = Date.now();
    var obj = raw ? JSON.parse(raw) : {};
    Object.keys(obj || {}).forEach(function(id) {
      if (now - obj[id] < 15 * 60 * 1000) amSeen[id] = obj[id];
    });
    amSeenStore = true;
  } catch (e) { amSeenStore = false; }

  // Свой канал, а не общий 'ground-…': если таблицы ещё нет в публикации,
  // сломалась бы подписка на постройки и войска вместе с ней
  try {
    supabase
      .channel('automove-' + systemId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'auto_moves',
                                filter: 'system_id=eq.' + systemId }, function() {
        amLoadSoon(250);
      })
      .subscribe();
  } catch (e) {}

  amTicker = setInterval(amTick, 1000);
  amLoad();
}

function amSaveSeen() {
  if (!amSeenStore) return;
  try { window.localStorage.setItem('am-seen-ground', JSON.stringify(amSeen)); } catch (e) {}
}

function amLoadSoon(ms) {
  if (amDisabled) return;
  if (amLoadTimer) clearTimeout(amLoadTimer);
  amLoadTimer = setTimeout(function() { amLoadTimer = null; amLoad(); }, ms || 300);
}

function amLoad() {
  if (!systemId || amDisabled) return;
  var seq = ++amLoadSeq;
  supabase.rpc('get_my_auto_moves', { p_system_id: systemId, p_layer: 'ground' }).then(function(res) {
    if (seq <= amLoadApplied) return;
    if (res.error) {
      // Функции ещё нет на сервере — тихо выключаемся, карта работает как раньше
      if (/does not exist|not find|PGRST202/i.test((res.error.message || '') + (res.error.code || ''))) amDisabled = true;
      return;
    }
    amLoadApplied = seq;
    amApply(res.data || []);
  });
}

function amHasActive() {
  for (var i = 0; i < amRows.length; i++) if (amRows[i].status === 'active') return true;
  return false;
}

function amActiveFor(unitId) {
  for (var i = 0; i < amRows.length; i++) {
    var r = amRows[i];
    if (r.status === 'active' && r.unit_id === unitId) return r;
  }
  return null;
}

function amGroupOf(row) {
  if (!row) return [];
  if (!row.group_id) return [row];
  return amRows.filter(function(r) { return r.status === 'active' && r.group_id === row.group_id; });
}

function amApply(rows) {
  rows.forEach(function(r) {
    if (typeof r.path === 'string') { try { r.path = JSON.parse(r.path); } catch (e) { r.path = []; } }
    if (!Array.isArray(r.path)) r.path = [];
    if (r.group_id && r.status === 'active' && amLeadUnits[r.unit_id]) amLeaders[r.group_id] = r.unit_id;
  });
  amRows = rows;
  amFetchedAt = Date.now();

  amAnnounce(rows);

  // Прочность запоминаем, пока идут: при обрыве уроном видно, кого задело
  rows.forEach(function(r) {
    if (r.status !== 'active') return;
    var u = amUnit(r.unit_id);
    if (u) amHpMemo[r.unit_id] = u.hp;
  });

  if (amFocusIds) {
    var still = rows.some(function(r) { return r.status === 'active' && amFocusIds[r.unit_id]; });
    if (!still) amFocusIds = null;
  }

  // Подстраховка, если реалтайм молчит: пока кто-то идёт, спрашиваем сами
  if (amPollTimer) { clearTimeout(amPollTimer); amPollTimer = null; }
  if (amHasActive()) amPollTimer = setTimeout(function() { amPollTimer = null; amLoad(); }, 20000);

  amRender();
  amRefreshStrip();
}

// ---------- Сводки об окончании ----------

function amAnnounce(rows) {
  var first = amFirstLoad;
  amFirstLoad = false;

  var groups = {};
  rows.forEach(function(r) {
    var key = r.group_id || r.id;
    (groups[key] = groups[key] || []).push(r);
  });

  var changed = false;
  Object.keys(groups).forEach(function(key) {
    var g = groups[key];
    var fresh = g.filter(function(r) { return r.status !== 'active' && !amSeen[r.id]; });
    if (!fresh.length) return;
    // Отряд ещё идёт (кто-то отменился вручную) — итог скажем, когда дойдут все
    if (g.some(function(r) { return r.status === 'active'; })) return;

    var stamp = Date.now();
    g.forEach(function(r) { if (!amSeen[r.id]) amSeen[r.id] = stamp; });
    changed = true;

    // После перезагрузки без памяти не знаем, говорили ли уже — молчим
    if (first && !amSeenStore) return;
    amToast(key, g);
  });
  if (changed) amSaveSeen();
}

// Несколько итогов разом (два отряда пришли на одном тике) — по очереди,
// прерывание первым: оно важнее
var amToastQueue = [];
var amToastBusy = false;

function amQueueToast(opts) {
  if (opts.kind === 'am-stop') amToastQueue.unshift(opts); else amToastQueue.push(opts);
  if (!amToastBusy) amNextToast();
}

function amNextToast() {
  var opts = amToastQueue.shift();
  if (!opts) { amToastBusy = false; return; }
  amToastBusy = true;
  cbReport(opts);
  setTimeout(amNextToast, amToastQueue.length ? 2800 : 0);
}

function amToast(key, g) {
  // Как и сервер, молчим об отмене, ручном ходе и уходе с карты (сел в транспорт, погиб)
  var told = g.filter(function(r) {
    return r.stop_reason !== 'cancelled' && r.stop_reason !== 'manual' && r.stop_reason !== 'lost';
  });
  if (!told.length) return;

  var count = function(reason) { return told.filter(function(r) { return r.stop_reason === reason; }).length; };
  var damaged = count('damaged'), blocked = count('blocked');
  var lost = g.filter(function(r) { return r.stop_reason === 'lost'; }).length;
  var near = count('arrived_near'), arrived = count('arrived');
  var group = g.length > 1;

  var leadId = amLeaders[key] || g[0].unit_id;
  var lead = amUnit(leadId) || amUnit(told[0].unit_id);
  var at = function(r) {
    var u = amUnit(r.unit_id);
    var x = r.final_x !== null && r.final_x !== undefined ? r.final_x : (u ? u.x : null);
    var y = r.final_y !== null && r.final_y !== undefined ? r.final_y : (u ? u.y : null);
    return x === null || x === undefined ? '' : x + ':' + y;
  };
  var leadRow = g.filter(function(r) { return r.unit_id === leadId; })[0] || told[0];
  var opts;

  if (damaged) {
    // Кого задело: у кого прочность упала, пока шёл
    var hit = null;
    told.forEach(function(r) {
      var u = amUnit(r.unit_id);
      if (!hit && u && amHpMemo[r.unit_id] !== undefined && u.hp < amHpMemo[r.unit_id]) hit = u;
    });
    var who = hit || lead;
    var hitRow = hit ? g.filter(function(r) { return r.unit_id === hit.id; })[0] : leadRow;
    opts = {
      kind: 'am-stop', title: 'Автоход прерван',
      attacker: who ? cbUnitPic(who, 'mine') : null,
      lines: [{ text: (hit || !group ? 'Под огнём' : 'Отряд под огнём') + ' на ' + at(hitRow || leadRow), cls: 'bad' }]
    };
    // Сводка «под огнём» с карты приходит раньше и тут же сменяется этой —
    // поэтому полоса прочности переезжает сюда
    if (hit) {
      var ht = unitTypeById[hit.unit_type] || {};
      opts.damage = amHpMemo[hit.id] - hit.hp;
      opts.hpLeft = hit.hp;
      opts.hpMax = (ht.max_hp || hit.hp) + (hit.bonus_hp || 0);
    }
    if (group) opts.lines.push({ text: 'Отряд остановлен: ' + g.length + ' ' + stlPlural(g.length, 'боец', 'бойца', 'бойцов'), cls: 'muted' });
  } else if (blocked && !arrived && !near) {
    opts = {
      kind: 'am-stop', title: 'Путь перекрыт',
      attacker: lead ? cbUnitPic(lead, 'mine') : null,
      lines: [{ text: 'Шаг не удаётся — ' + (group ? 'отряд встал' : 'встал') + ' на ' + at(leadRow) },
              { text: 'Выбери другую точку или обойди препятствие', cls: 'muted' }]
    };
  } else if (!group && near) {
    opts = {
      kind: 'am-near', title: 'Встал рядом',
      attacker: lead ? cbUnitPic(lead, 'mine') : null,
      lines: [{ text: 'Точка занята — встал на ' + at(leadRow) }]
    };
  } else {
    var chips = [];
    if (group) chips.push({ text: 'дошли ' + (arrived + near) + ' из ' + g.length, cls: 'good' });
    if (near) chips.push({ text: 'рядом с точкой ' + near });
    if (blocked) chips.push({ text: 'путь перекрыт ' + blocked, cls: 'bad' });
    if (lost) chips.push({ text: 'выбыли ' + lost, cls: 'bad' });
    opts = {
      kind: 'am-ok', title: group ? 'Отряд на месте' : 'На месте',
      attacker: lead ? cbUnitPic(lead, 'mine') : null,
      chips: chips,
      lines: [{ text: (group ? 'Ведущий на ' : 'Позиция ') + at(leadRow), cls: 'muted' }]
    };
  }
  amQueueToast(opts);
}

// ---------- Отрисовка нитей ----------

function amEnsureLayer() {
  var layer = cbEnsureFxLayer();
  if (!layer) return false;
  if (!amSvg || amSvg.parentNode !== layer) {
    amSvg = document.createElementNS(AM_SVG_NS, 'svg');
    amSvg.setAttribute('id', 'am-svg');
    layer.insertBefore(amSvg, layer.firstChild);
    amTags = document.createElement('div');
    amTags.id = 'am-tags';
    layer.insertBefore(amTags, amSvg.nextSibling);
  }
  return true;
}

// Кого показывать ярко: выбранного бойца со всем его отрядом
function amBrightSet() {
  var set = {};
  if (selectedUnit && selectedUnit.owner_user_id === currentUserId) {
    var row = amActiveFor(selectedUnit.id);
    amGroupOf(row).forEach(function(r) { set[r.unit_id] = true; });
  }
  if (amFocusIds) Object.keys(amFocusIds).forEach(function(id) { set[id] = true; });
  return set;
}

function amCenter(x, y, b) {
  return [(x + b.w / 2) * CELL_PX, (y + b.h / 2) * CELL_PX];
}

function amRender() {
  if (!amEnsureLayer()) return;
  var svg = [], tags = [];
  var bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  var grow = function(px, py) {
    if (px < bb.x0) bb.x0 = px; if (py < bb.y0) bb.y0 = py;
    if (px > bb.x1) bb.x1 = px; if (py > bb.y1) bb.y1 = py;
  };

  var thread = function(u, path, cls) {
    if (!path.length) return;
    var b = unitBox(u);
    var c0 = amCenter(u.x, u.y, b);
    var d = 'M' + c0[0] + ' ' + c0[1];
    var nodes = '';
    grow(c0[0], c0[1]);
    for (var i = 0; i < path.length; i++) {
      var c = amCenter(path[i][0], path[i][1], b);
      d += ' L' + c[0] + ' ' + c[1];
      grow(c[0], c[1]);
      if (i < path.length - 1) nodes += 'M' + c[0] + ' ' + c[1] + 'h0';
    }
    var f = path[path.length - 1];
    var fx = f[0] * CELL_PX, fy = f[1] * CELL_PX, fw = b.w * CELL_PX, fh = b.h * CELL_PX;
    grow(fx - 8, fy - 8); grow(fx + fw + 8, fy + fh + 8);
    svg.push('<g class="am-thread ' + cls + '">' +
      '<path class="am-shadow" d="' + d + '"/>' +
      '<path class="am-line" d="' + d + '"/>' +
      (nodes ? '<path class="am-node" d="' + nodes + '"/><path class="am-node-in" d="' + nodes + '"/>' : '') +
      '<rect class="am-fin-halo" x="' + (fx + 1) + '" y="' + (fy + 1) + '" width="' + (fw - 2) + '" height="' + (fh - 2) + '" rx="5"/>' +
      '<rect class="am-fin" x="' + (fx + 1) + '" y="' + (fy + 1) + '" width="' + (fw - 2) + '" height="' + (fh - 2) + '" rx="5"/>' +
      '</g>');
  };

  var tag = function(u, f, text, cls) {
    var b = unitBox(u);
    tags.push('<div class="am-tagpos" style="left:' + ((f[0] + b.w / 2) * CELL_PX) + 'px;top:' +
      (f[1] * CELL_PX - 3) + 'px"><div class="am-tag ' + cls + '"><i>⚑</i>' + escHtml(text) + '</div></div>');
  };

  var ring = function(u, lead) {
    var b = unitBox(u);
    var x = u.x * CELL_PX - 3, y = u.y * CELL_PX - 3;
    var w = b.w * CELL_PX + 6, h = b.h * CELL_PX + 6;
    grow(x - 4, y - 4); grow(x + w + 4, y + h + 4);
    svg.push('<rect class="am-ring' + (lead ? ' lead' : '') + '" x="' + x + '" y="' + y +
             '" width="' + w + '" height="' + h + '" rx="7"/>');
  };

  var picking = {};
  if (amPick) amPick.ids.forEach(function(id) { picking[id] = true; });

  // Идущие автоходы: всегда, тонко; выбранный отряд — ярко
  var bright = amBrightSet();
  var lit = [];
  amRows.forEach(function(r) {
    if (r.status !== 'active' || !r.path || !r.path.length) return;
    var u = amUnit(r.unit_id);
    if (!amOnMap(u)) return;
    // У тех, кому сейчас выбирают новую точку, старая нить приглушена
    var hi = bright[r.unit_id] && !(amPick && amPick.target && picking[r.unit_id]);
    thread(u, r.path, hi ? 'live hi' : 'live');
    if (hi) lit.push(r);
  });

  // Подпись у финиша выбранного: у ведущего или у самого дальнего
  if (lit.length && !(amPick && amPick.target)) {
    var main = null, steps = 0, eta = 0;
    lit.forEach(function(r) {
      var u = amUnit(r.unit_id);
      steps = Math.max(steps, r.path.length);
      eta = Math.max(eta, amEtaFor(u, r.path.length));
      if (selectedUnit && r.unit_id === selectedUnit.id) main = r;
    });
    if (!main) {
      lit.forEach(function(r) { if (amLeaders[r.group_id] === r.unit_id) main = r; });
    }
    main = main || lit[0];
    tag(amUnit(main.unit_id), main.path[main.path.length - 1],
        amStepsWord(steps) + ' · ' + amEtaText(eta), 'live');
  }

  // Предпросмотр
  if (amPick) {
    var plan = amPlan();
    amPick.ids.forEach(function(id) {
      var u = amUnit(id);
      if (amOnMap(u)) ring(u, id === amPick.leaderId);
    });
    if (plan) {
      plan.members.forEach(function(m) { thread(m.u, m.path, 'plan' + (m.blocked ? ' blocked' : '')); });
      var L = plan.members[0];
      if (L && L.path.length) {
        tag(L.u, L.path[L.path.length - 1],
            amStepsWord(plan.steps) + ' · ' + amEtaText(plan.eta), 'plan');
      }
    }
  }

  if (!svg.length) {
    amSvg.style.display = 'none';
    amSvg.innerHTML = '';
  } else {
    var pad = 24;
    var x0 = Math.floor(bb.x0 - pad), y0 = Math.floor(bb.y0 - pad);
    var w = Math.ceil(bb.x1 - bb.x0 + pad * 2), h = Math.ceil(bb.y1 - bb.y0 + pad * 2);
    amSvg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + w + ' ' + h);
    amSvg.setAttribute('width', w);
    amSvg.setAttribute('height', h);
    amSvg.style.left = x0 + 'px';
    amSvg.style.top = y0 + 'px';
    amSvg.style.display = 'block';
    amSvg.innerHTML = svg.join('');
  }
  amTags.innerHTML = tags.join('');
  amFitTags();
  amLastSelId = selectedUnit ? selectedUnit.id : null;
}

// Подпись у края экрана не должна уезжать за него: сдвигаем внутрь.
// Слой с подписью уже обратно масштабирован, так что пиксели экранные
function amFitTags() {
  var list = amTags.querySelectorAll('.am-tag');
  var vw = window.innerWidth;
  for (var i = 0; i < list.length; i++) {
    var r = list[i].getBoundingClientRect();
    var mid = (r.left + r.right) / 2;
    // Финиш за краем экрана — подпись не трогаем: игрок к ней ещё подъедет
    if (mid < 0 || mid > vw) continue;
    var dx = 0;
    if (r.left < 8) dx = 8 - r.left;
    else if (r.right > vw - 8) dx = vw - 8 - r.right;
    // Подпись остаётся над своим финишем хотя бы краем
    var lim = Math.max(0, r.width / 2 - 14);
    dx = Math.max(-lim, Math.min(lim, dx));
    if (dx) list[i].style.transform = 'translateX(calc(-50% + ' + Math.round(dx) + 'px))';
  }
}

// Карта перерисовалась — возможно, сменился выбранный боец
function amOnRedraw() {
  var id = selectedUnit ? selectedUnit.id : null;
  if (amFocusIds && id && !amFocusIds[id]) amFocusIds = null;
  if (id !== amLastSelId) amRender();
}

// Войска сдвинулись: начало нити переезжает за бойцом
function amAfterUnits() {
  if (amPick) {
    // Кто ушёл с карты (сел в транспорт, погиб), из отряда выпадает
    amPick.ids = amPick.ids.filter(function(id) { return amOnMap(amUnit(id)); });
    if (amPick.ids.indexOf(amPick.leaderId) < 0) { amCancelPick(); return; }
    amPaintCard();
  }
  amRender();
  if (amHasActive()) amLoadSoon(600);
}

// ---------- Строка состояния в панели бойца ----------

function amStripHtml(unit, row) {
  var g = amGroupOf(row);
  var head = g.length > 1 ? 'Автоход · отряд ' + g.length : 'Автоход';
  if (amStopAsk === unit.id && g.length > 1) {
    return '<span class="am-strip-ico">⇉</span>' +
      '<div class="am-strip-txt"><b>Стоп</b></div>' +
      '<button class="am-strip-btn stop" data-am="all">Весь отряд</button>' +
      '<button class="am-strip-btn" data-am="one">Только он</button>' +
      '<button class="am-strip-btn x" data-am="back" aria-label="Назад">✕</button>';
  }
  return '<span class="am-strip-ico">⇉</span>' +
    '<div class="am-strip-txt"><b>' + head + '</b><span id="am-strip-sub">' + amStripSub(row) + '</span></div>' +
    '<button class="am-strip-btn stop" data-am="stop">Стоп</button>';
}

function amStripSub(row) {
  var left = row.path ? row.path.length : 0;
  var txt = 'осталось ' + amStepsWord(left);
  if (row.next_step_in !== null && row.next_step_in !== undefined) {
    var s = row.next_step_in - Math.floor((Date.now() - amFetchedAt) / 1000);
    txt += s > 0 ? ' · шаг через ' + s + ' с' : ' · шаг вот-вот';
  }
  return txt;
}

// Встраиваем строку в открытую панель своего бойца (или убираем её)
function amPanelStrip(bar, unit) {
  if (!bar || !unit) return;
  var old = document.getElementById('am-strip');
  var row = amDisabled ? null : amActiveFor(unit.id);
  if (!row) {
    if (old) old.parentNode.removeChild(old);
    return;
  }
  var strip = old;
  if (!strip) {
    var apRow = bar.querySelector('.gu-ap-row');
    if (!apRow) return;
    strip = document.createElement('div');
    strip.id = 'am-strip';
    strip.className = 'am-strip';
    apRow.parentNode.insertBefore(strip, apRow.nextSibling);
    strip.addEventListener('click', function(e) {
      var t = e.target;
      while (t && t !== strip && !t.getAttribute('data-am')) t = t.parentNode;
      if (!t || t === strip) return;
      amStripAction(unit, t.getAttribute('data-am'), t);
    });
  }
  strip.className = 'am-strip' + (amStopAsk === unit.id ? ' ask' : '');
  strip.innerHTML = amStripHtml(unit, row);
}

function amStripAction(unit, act, btn) {
  var row = amActiveFor(unit.id);
  var bar = document.getElementById('pickup-bar');
  if (!row) { amPanelStrip(bar, unit); return; }
  var g = amGroupOf(row);

  if (act === 'stop' && g.length > 1) { amStopAsk = unit.id; amPanelStrip(bar, unit); return; }
  if (act === 'back') { amStopAsk = null; amPanelStrip(bar, unit); return; }

  var ids = act === 'all' ? g.map(function(r) { return r.unit_id; }) : [unit.id];
  var btns = bar ? bar.querySelectorAll('.am-strip-btn') : [];
  for (var i = 0; i < btns.length; i++) btns[i].disabled = true;

  supabase.rpc('cancel_auto_move', { p_ids: ids }).then(function(r) {
    amStopAsk = null;
    if (r.error) {
      for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
      alert('Не удалось остановить: ' + r.error.message);
      return;
    }
    // Свою отмену сводкой не объявляем, хватит отметки над бойцами
    amRows.forEach(function(x) {
      if (x.status === 'active' && ids.indexOf(x.unit_id) >= 0) {
        x.status = 'stopped'; x.stop_reason = 'cancelled'; amSeen[x.id] = Date.now();
      }
    });
    amSaveSeen();
    ids.forEach(function(id) { var u = amUnit(id); if (amOnMap(u)) cbFloatOnUnit(u, 'стоп', 'miss'); });
    amRender();
    amPanelStrip(document.getElementById('pickup-bar'), unit);
    if (bar && bar.style.visibility !== 'hidden') setBottomInset(insetFor(bar));
    amLoadSoon(300);
  });
}

// Пришли свежие автоходы — строка в открытой панели должна совпадать
function amRefreshStrip() {
  var bar = document.getElementById('pickup-bar');
  if (!bar || bar.style.visibility === 'hidden') return;
  if (bar.getAttribute('data-intel') || bar.getAttribute('data-struct')) return;
  if (!selectedUnit || selectedUnit.owner_user_id !== currentUserId) return;
  if (!bar.querySelector('#gu-dots')) return;
  var had = !!document.getElementById('am-strip');
  amPanelStrip(bar, selectedUnit);
  var has = !!document.getElementById('am-strip');
  if (had !== has) setBottomInset(insetFor(bar));
}

// ---------- Плитка в панели способностей ----------

function amAddTile(addTile, info, unit, type) {
  if (amDisabled) return;
  var why = amBlockReason(unit);
  var row = amActiveFor(unit.id);
  var tile = addTile('automove', '⇉', 'Автоход', !why, function() {
    info.innerHTML = '<div class="gu-abil-name">Автоход</div>' +
      '<div class="gu-abil-text">Сам идёт к дальней точке. Каждый шаг — обычный ход до ' +
      amRange(unit) + ' клеток за одно действие: шагает, как только действие готово. ' +
      'Урон по бойцу прерывает путь.</div>' +
      '<div class="gu-abil-meta">можно повести отряд — до ' + AM_MAX_GROUP + ' бойцов</div>' +
      (row ? '<div class="gu-abil-meta warn">уже идёт: новая точка заменит маршрут</div>' : '') +
      (why ? '<div class="gu-abil-meta warn">' + why + '</div>' : '');
    guAbilityAction(info, 'Выбрать точку', !why, function() { amStartPick(unit); });
  });
  // Тикер очков снимает «заглушку» с плиток по числу действий —
  // автоходу действия не нужны, а запрет по другой причине снимать нельзя
  if (tile) tile.setAttribute('data-need', why ? '99' : '0');
  if (tile && row) tile.classList.add('am-going');
}

// ---------- Режим выбора точки ----------

function amOtherMode() {
  return !!(placingStructure || landingFighter || droppingVehicle || disembarking || heroAbility ||
            upgradeAbility || artilleryUnit || attackingUnit || abilityUnit || movingUnit ||
            droppingUnit || placingOrder);
}

function amStartPick(unit) {
  if (amBlockReason(unit)) return;
  // Другие режимы гасим: один тап — одно действие
  if (movingUnit) cancelGroundMove();
  if (attackingUnit || abilityUnit || artilleryUnit || heroAbility || upgradeAbility) cancelTargeting();

  // Если боец уже в отряде на ходу — предлагаем тот же состав
  var ids = [unit.id];
  amGroupOf(amActiveFor(unit.id)).forEach(function(r) {
    if (r.unit_id !== unit.id && amOnMap(amUnit(r.unit_id)) && ids.length < AM_MAX_GROUP) ids.push(r.unit_id);
  });

  amPick = { leaderId: unit.id, ids: ids, grouping: false, target: null, busy: false, error: '' };
  // Плитка не остаётся «нажатой» с пустым описанием, когда панель откроют снова
  guPickedAbility = null;
  hidePickup();
  selectedUnit = null;
  amStopAsk = null;
  amPaintCard();
  focusCell(unit.x + unitBox(unit).w / 2 - 0.5, unit.y + unitBox(unit).h / 2 - 0.5);
  redrawScene();
  amRender();
}

function amCancelPick() {
  if (!amPick) return;
  amPick = null;
  var card = document.getElementById('am-card');
  if (card) card.style.display = 'none';
  setBottomInset(0);
  amRender();
}

function amHandleTap(cellX, cellY) {
  if (!amPick || amPick.busy) return;
  if (cellX < 0 || cellY < 0 || cellX >= GRID_SIZE || cellY >= GRID_SIZE) return;

  var u = null;
  for (var i = 0; i < unitsOnMap.length; i++) {
    var o = unitsOnMap[i];
    if (!amOnMap(o)) continue;
    var b = unitBox(o);
    if (cellX >= o.x && cellX < o.x + b.w && cellY >= o.y && cellY < o.y + b.h) { u = o; break; }
  }

  if (amPick.grouping && u && u.owner_user_id === currentUserId) {
    amToggleMember(u);
    return;
  }
  amSetTarget(cellX, cellY);
}

function amToggleMember(u) {
  var at = amPick.ids.indexOf(u.id);
  if (u.id === amPick.leaderId) { cbFloatOnUnit(u, 'ведущий', 'miss'); return; }
  if (at >= 0) {
    amPick.ids.splice(at, 1);
  } else {
    var why = amBlockReason(u);
    if (why) { cbFloatOnUnit(u, why, 'miss'); return; }
    if (amPick.ids.length >= AM_MAX_GROUP) { cbFloatOnUnit(u, 'отряд полон', 'miss'); return; }
    amPick.ids.push(u.id);
  }
  amPick.error = '';
  amPaintCard();
  amRender();
}

function amAddNear() {
  var L = amUnit(amPick.leaderId);
  if (!amOnMap(L)) return;
  var lb = unitBox(L);
  var cand = [];
  unitsOnMap.forEach(function(u) {
    if (u.owner_user_id !== currentUserId || amPick.ids.indexOf(u.id) >= 0 || amBlockReason(u)) return;
    var b = unitBox(u);
    var gap = boxGap(L.x, L.y, lb.w, lb.h, u.x, u.y, b.w, b.h);
    if (gap <= AM_NEAR_RADIUS) cand.push({ u: u, gap: gap });
  });
  cand.sort(function(a, b) { return a.gap - b.gap; });
  var added = 0;
  cand.forEach(function(c) {
    if (amPick.ids.length >= AM_MAX_GROUP) return;
    amPick.ids.push(c.u.id);
    added++;
  });
  // Состав видно и править удобно сразу — включаем выбор отряда
  amPick.grouping = true;
  amPick.error = '';
  if (!added) cbFloatOnUnit(L, cand.length ? 'отряд полон' : 'рядом никого', 'miss');
  amPaintCard();
  amRender();
}

function amSetTarget(cellX, cellY) {
  var L = amUnit(amPick.leaderId);
  if (!amOnMap(L)) { amCancelPick(); return; }
  var b = unitBox(L);
  amPick.target = {
    x: amClamp(cellX - Math.floor((b.w - 1) / 2), 0, GRID_SIZE - b.w),
    y: amClamp(cellY - Math.floor((b.h - 1) / 2), 0, GRID_SIZE - b.h)
  };
  amPick.error = '';
  amPaintCard();
  amRender();
}

// Строй сохраняется: цель каждого = цель ведущего + его смещение от ведущего
function amPlan() {
  if (!amPick || !amPick.target) return null;
  var L = amUnit(amPick.leaderId);
  if (!amOnMap(L)) return null;
  var members = [];
  var range = Infinity;
  var skip = {};
  amPick.ids.forEach(function(id) {
    var u = amUnit(id);
    if (!amOnMap(u)) return;
    skip[id] = true;
    range = Math.min(range, amRange(u));
    members.push(u);
  });
  if (!members.length || range === Infinity) return null;

  var plan = { members: [], steps: 0, eta: 0, range: range, blocked: 0, leadBlocked: false };
  members.forEach(function(u) {
    var b = unitBox(u);
    var tx = amClamp(amPick.target.x + (u.x - L.x), 0, GRID_SIZE - b.w);
    var ty = amClamp(amPick.target.y + (u.y - L.y), 0, GRID_SIZE - b.h);
    var path = amSteps(u.x, u.y, tx, ty, range);
    var blocked = path.length > 0 && amBoxBlocked(u, tx, ty, skip);
    if (blocked) { plan.blocked++; if (u.id === L.id) plan.leadBlocked = true; }
    plan.steps = Math.max(plan.steps, path.length);
    plan.eta = Math.max(plan.eta, amEtaFor(u, path.length));
    plan.members.push({ u: u, x: tx, y: ty, path: path, blocked: blocked });
  });
  return plan;
}

function amEnsureCard() {
  var card = document.getElementById('am-card');
  if (card) return card;
  card = document.createElement('div');
  card.id = 'am-card';
  card.style.display = 'none';
  card.addEventListener('click', function(e) {
    var t = e.target;
    while (t && t !== card && !t.getAttribute('data-am')) t = t.parentNode;
    if (!t || t === card || t.disabled || !amPick) return;
    var act = t.getAttribute('data-am');
    if (act === 'cancel') { amCancelPick(); return; }
    if (act === 'group') { amPick.grouping = !amPick.grouping; amPaintCard(); return; }
    if (act === 'near') { amAddNear(); return; }
    if (act === 'retarget') { amPick.target = null; amPick.error = ''; amPaintCard(); amRender(); return; }
    if (act === 'go') { amGo(); }
  });
  document.body.appendChild(card);
  return card;
}

function amPaintCard() {
  if (!amPick) return;
  var card = amEnsureCard();
  var L = amUnit(amPick.leaderId);
  if (!L) return;
  var n = amPick.ids.length;
  var plan = amPlan();
  var html;

  var groupBtn = '<button class="am-b' + (amPick.grouping ? ' on' : '') + '" data-am="group">Отряд<i>' + n + '</i></button>';
  var nearBtn = '<button class="am-b" data-am="near"' + (n >= AM_MAX_GROUP ? ' disabled' : '') + '>Все рядом</button>';

  var sub = amPick.grouping
    ? 'Тапай своих бойцов — добавить или убрать. Тап по пустой клетке — точка'
    : 'Тапни точку на карте, куда идти';

  if (!plan) {
    html =
      '<div class="am-head">' +
        '<span class="am-ico">⇉</span>' +
        '<div class="am-ttl"><b>Автоход · ' + escHtml(amName(L)) + '</b><span>' + sub + '</span></div>' +
      '</div>' +
      '<div class="am-btns">' + groupBtn + nearBtn +
        '<button class="am-b" data-am="cancel">Отмена</button>' +
      '</div>';
  } else {
    var t = amPick.target;
    var warn = '';
    if (plan.leadBlocked && plan.blocked === 1) warn = 'Точка занята — встанет рядом';
    else if (plan.blocked) warn = 'Место занято у ' + plan.blocked + ' из ' + plan.members.length + ' — встанут рядом';
    var none = plan.steps === 0;

    html =
      '<div class="am-head">' +
        '<span class="am-ico">⇉</span>' +
        '<div class="am-ttl"><b>' + (n > 1 ? 'Автоход · отряд' : 'Автоход · ' + escHtml(amName(L))) + '</b>' +
          '<span>' + (n > 1 ? 'Ведёт ' + escHtml(amName(L)) + ' · цель ' : 'Цель ') + t.x + ':' + t.y + ' · шаг до ' + plan.range + ' кл' +
          (amPick.grouping ? ' · тапай своих, чтобы править отряд' : '') + '</span></div>' +
      '</div>' +
      '<div class="am-stats">' +
        '<div class="am-stat"><b>' + n + '</b><span>' + stlPlural(n, 'боец', 'бойца', 'бойцов') + '</span></div>' +
        '<div class="am-stat"><b>' + plan.steps + '</b><span>' + stlPlural(plan.steps, 'шаг', 'шага', 'шагов') + '</span></div>' +
        '<div class="am-stat wide"><b>' + (none ? '—' : amEtaText(plan.eta)) + '</b><span>в пути</span></div>' +
      '</div>' +
      (none ? '<div class="am-warn">Уже на месте — выбери другую точку</div>'
            : warn ? '<div class="am-warn">' + warn + '</div>' : '') +
      (amPick.error ? '<div class="am-warn err">' + escHtml(amPick.error) + '</div>' : '') +
      '<div class="am-btns">' + groupBtn + nearBtn +
        '<button class="am-b" data-am="retarget">Другая точка</button>' +
      '</div>' +
      '<div class="am-btns">' +
        '<button class="am-b" data-am="cancel">Отмена</button>' +
        '<button class="am-b go" data-am="go"' + (none || amPick.busy ? ' disabled' : '') + '>' +
          (amPick.busy ? 'Отправляю…' : 'Вперёд') + '</button>' +
      '</div>';
  }

  card.innerHTML = html;
  card.style.display = 'block';
  setBottomInset(insetFor(card));
}

function amGo() {
  var plan = amPlan();
  if (!plan || !plan.steps || amPick.busy) return;
  var pick = amPick;
  var ids = pick.ids.filter(function(id) { return amOnMap(amUnit(id)); });
  // Ведущий первым: сервер считает строй от него
  ids.splice(ids.indexOf(pick.leaderId), 1);
  ids.unshift(pick.leaderId);

  pick.busy = true;
  pick.error = '';
  amPaintCard();

  supabase.rpc('start_auto_move', {
    p_layer: 'ground', p_ids: ids, p_x: pick.target.x, p_y: pick.target.y
  }).then(function(r) {
    if (amPick !== pick) return;
    pick.busy = false;
    if (r.error) {
      pick.error = r.error.message || 'Не удалось начать автоход';
      amPaintCard();
      return;
    }
    var rows = r.data || [];
    var lead = amUnit(pick.leaderId);
    var steps = 0;
    rows.forEach(function(x) { steps = Math.max(steps, x.steps || 0); });
    if (!steps) steps = plan.steps;

    amFocusIds = {};
    ids.forEach(function(id) { amFocusIds[id] = true; delete amLeadUnits[id]; });
    amLeadUnits[pick.leaderId] = true;
    amCancelPick();

    cbReport({
      kind: 'am-go',
      title: ids.length > 1 ? 'Отряд выступил' : 'Автоход начат',
      attacker: lead ? cbUnitPic(lead, 'mine') : null,
      chips: [ids.length > 1 ? { text: 'отряд ' + ids.length } : null,
              { text: amStepsWord(steps) },
              { text: amEtaText(plan.eta) }],
      lines: [{ text: 'Цель ' + pick.target.x + ':' + pick.target.y, cls: 'muted' }]
    });

    // Первый шаг сервер делает сразу — карта и нити должны это показать
    loadUnits();
    amLoad();
  });
}

// ---------- Тикер ----------

function amTick() {
  if (amPick) {
    // Включился другой режим (высадка, стройка…) — уступаем ему
    if (amOtherMode()) { amCancelPick(); }
    else if (!amOnMap(amUnit(amPick.leaderId))) { amCancelPick(); }
  }
  var sub = document.getElementById('am-strip-sub');
  if (sub && selectedUnit) {
    var row = amActiveFor(selectedUnit.id);
    if (row) sub.textContent = amStripSub(row);
  }
}
