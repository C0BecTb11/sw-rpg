// Автоход в космосе: корабль (или флот) сам идёт к дальней точке.
//
// Ничего не решается здесь — шаги делает сервер (automove_tick вызывает
// настоящий move_ship), и каждый шаг стоит одно действие. Клиент только
// показывает: предпросмотр маршрута по той же формуле, что и на сервере,
// живую «нить» оставшегося пути и итог — прибыл, встал рядом, прерван.
//
// Связь с остальным кодом — через несколько крючков:
//   ship-control.js: плитка и строка состояния в панели корабля, режим 'auto',
//                    тап по полю, сброс при смене корабля;
//   space-battle.js: тап по кораблю / слоту станции в режиме выбора,
//                    отметка кораблей флота, обновление после loadShips.
//
// Бережём устройство: нить видна только у выбранного корабля с его флотом
// и в предпросмотре. Остальных идущих выдаёт неподвижный значок ⇉ на
// корабле (класс am-going). Пунктир неподвижный; живёт одна анимация —
// пульс финиша, на HTML-рамке (только transform и opacity).

var AM_MAX_GROUP = 12;     // столько же проверяет сервер
var AM_NEAR = 12;          // «Все рядом» — радиус от ведущего, клеток

var am = null;             // режим выбора цели: { leaderId, ids, picking, target }
var amMoves = [];          // строки get_my_auto_moves
var amMovesAt = 0;         // когда они получены (локальное время)
var amSeen = null;         // id -> статус; null до первой загрузки (итоги прошлого не показываем)
var amToasted = {};        // группа -> итог уже показан
var amHurtAt = {};         // id корабля -> когда по нему последний раз попали
var amLoadSeq = 0;
var amLoadApplied = 0;
var amLoadTimer = null;
var amSubscribed = false;
var amRpcBroken = false;
var amSvg = null;
var amPulseEl = null;      // пульс финиша — один на карте
var amTagEls = [];
var amPollTimer = null;
var amPosMemo = {};        // где стояли идущие: сдвинулся — значит, был шаг
var amRenderSig = '';
var amBoxSig = '';
var amStatusSig = '';
var amStarting = false;

// ===== расчёты =====

function amPlural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function amSteps(n) { return n + ' ' + amPlural(n, 'шаг', 'шага', 'шагов'); }

// Шаги от (x0,y0) до (x1,y1) — та же формула, что в automove на сервере:
// n = ceil(dist / range), точки на равных долях пути, последняя = цель.
function amPath(x0, y0, x1, y1, range) {
  var dx = x1 - x0, dy = y1 - y0;
  var dist = Math.max(Math.abs(dx), Math.abs(dy));
  var pts = [];
  if (!dist || !(range >= 1)) return pts;
  var n = Math.ceil(dist / range);
  for (var k = 1; k <= n; k++) {
    pts.push([
      x0 + Math.floor((2 * dx * k + n) / (2 * n)),
      y0 + Math.floor((2 * dy * k + n) / (2 * n))
    ]);
  }
  return pts;
}

function amType(ship) { return ship ? shipTypeById[ship.ship_type] : null; }

function amBoxOf(ship) {
  var t = amType(ship);
  return t ? shipBoxCells(t, ship.facing || 0) : { w: 1, h: 1 };
}

function amRangeOf(ship) {
  var t = amType(ship);
  return ((t && t.move_range) || 0) + ((ship && ship.bonus_move) || 0);
}

function amName(ship) {
  var t = amType(ship);
  return (t && t.name) || 'Корабль';
}

// Корабль стоит на карте и может идти сам
function amOnMap(ship) {
  return !!ship && ship.x !== null && ship.x !== undefined &&
    !ship.in_transit && !ship.carrier_ship_id && (ship.hp || 0) > 0;
}

function amMine(ship) {
  return !!ship && ship.owner_user_id === currentUserId;
}

// Зазор между коробками двух кораблей в клетках (по Чебышёву)
function amGap(a, b) {
  var ba = amBoxOf(a), bb = amBoxOf(b);
  var gx = Math.max(0, b.x - (a.x + ba.w - 1), a.x - (b.x + bb.w - 1));
  var gy = Math.max(0, b.y - (a.y + ba.h - 1), a.y - (b.y + bb.h - 1));
  return Math.max(gx, gy);
}

function amClampBox(x, y, box) {
  return {
    x: Math.max(0, Math.min(x, GRID_CELLS - box.w)),
    y: Math.max(0, Math.min(y, GRID_CELLS - box.h))
  };
}

// В зону прыжка противника хода нет. Сервер прижимает цель к краю
// этой зоны — предпросмотр делает то же, чтобы показать, куда корабль
// встанет на самом деле. band = true, если цель пришлось сдвинуть.
function amClampTarget(x, y, box) {
  var t = amClampBox(x, y, box);
  t.band = false;
  if (typeof myZoneSide !== 'undefined' && myZoneSide && typeof ZONE_HEIGHT !== 'undefined') {
    if (myZoneSide === 'bottom' && t.y < ZONE_HEIGHT) { t.y = ZONE_HEIGHT; t.band = true; }
    if (myZoneSide === 'top' && t.y + box.h > GRID_CELLS - ZONE_HEIGHT) {
      t.y = GRID_CELLS - ZONE_HEIGHT - box.h; t.band = true;
    }
  }
  return t;
}

// Строй у края карты: зажатые цели могут лечь друг на друга. Тогда
// корабль отодвигается дальше в сторону своего смещения от ведущего,
// а если упёрся — на ближайшее свободное место рядом.
function amFreeOf(x, y, box, taken) {
  for (var i = 0; i < taken.length; i++) {
    var b = taken[i];
    if (amOverlap(x, y, box.w, box.h, b.x, b.y, b.w, b.h)) return false;
  }
  return true;
}

function amSpread(t, box, dir, taken) {
  if (amFreeOf(t.x, t.y, box, taken)) return t;
  var last = null;
  for (var k = 1; k <= 40; k++) {
    var c = amClampTarget(t.x + dir[0] * k, t.y + dir[1] * k, box);
    if (last && c.x === last.x && c.y === last.y) break;   // упёрлись в край
    last = c;
    if (amFreeOf(c.x, c.y, box, taken)) { c.band = c.band || t.band; return c; }
  }
  for (var r = 1; r <= 8; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var q = amClampTarget(t.x + dx, t.y + dy, box);
        if (amFreeOf(q.x, q.y, box, taken)) { q.band = q.band || t.band; return q; }
      }
    }
  }
  return t;
}

// Сколько примерно ждать k шагов: сразу уходят накопленные действия,
// остальные — по одному за перезарядку
function amEtaSec(ship, k) {
  if (!ship || k <= 0) return 0;
  var st = scApState(ship);
  var extra = k - st.ap;
  if (extra <= 0) return 0;
  var cd = scSettings.cooldown || 30;
  return (st.ap >= st.max ? cd : st.nextIn) + (extra - 1) * cd;
}

function amEtaText(sec) {
  if (sec <= 0) return 'сразу';
  if (sec < 60) return '≈ ' + Math.max(10, Math.round(sec / 10) * 10) + ' с';
  return '≈ ' + Math.round(sec / 60) + ' мин';
}

function amCenter(x, y, box) {
  return [(x + box.w / 2) * CELL_PX, (y + box.h / 2) * CELL_PX];
}

function amOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

// Что из видимого мешает встать на точку. Невидимое сервер обойдёт сам —
// встанет рядом, — а видимое честнее показать заранее.
// Неподвижные препятствия для прокладки пути — те же, что у сервера:
// станция и чужая полоса прыжка (своя проходима)
function amSpaceObstacles() {
  var list = [];
  if (typeof stationSlot !== 'undefined' && stationSlot) {
    list.push({ x: stationSlot.x, y: stationSlot.y, w: STATION_SIZE, h: STATION_SIZE });
  }
  if (typeof myZoneSide !== 'undefined' && myZoneSide) {
    list.push({ x: 0, y: myZoneSide === 'top' ? GRID_CELLS - ZONE_HEIGHT : 0, w: GRID_CELLS, h: ZONE_HEIGHT });
  }
  return list;
}

function amBlockAt(x, y, box, skip) {
  if (typeof stationSlot !== 'undefined' && stationSlot &&
      amOverlap(x, y, box.w, box.h, stationSlot.x, stationSlot.y, STATION_SIZE, STATION_SIZE)) {
    return 'station';
  }
  for (var i = 0; i < shipsInSystem.length; i++) {
    var s = shipsInSystem[i];
    if (skip[s.id] || !amOnMap(s)) continue;
    var b = amBoxOf(s);
    if (amOverlap(x, y, box.w, box.h, s.x, s.y, b.w, b.h)) return 'ship';
  }
  return null;
}

// ===== план флота =====

function amMembers() {
  if (!am) return [];
  var list = [];
  am.ids.forEach(function(id) {
    var s = sxShipById(id);
    if (amOnMap(s) && amMine(s)) list.push(s);
  });
  return list;
}

// Цель каждого = цель ведущего + его смещение от ведущего. Строй
// сохраняется, а шаг у всех один — по самому медленному.
function amPlan() {
  if (!am || !am.target) return null;
  var members = amMembers();
  var leader = sxShipById(am.leaderId);
  if (!members.length || !amOnMap(leader)) return null;

  var range = Infinity;
  members.forEach(function(s) { range = Math.min(range, amRangeOf(s)); });
  if (!isFinite(range) || range < 1) range = 1;

  var skip = {};
  members.forEach(function(s) { skip[s.id] = true; });

  var steps = 0, eta = 0, warn = null, band = !!am.target.band;
  var taken = [];
  // Ведущий первым: его цель не двигается, остальные расходятся вокруг
  members.sort(function(a, b) { return (a.id === am.leaderId ? 0 : 1) - (b.id === am.leaderId ? 0 : 1); });
  var items = members.map(function(s) {
    var box = amBoxOf(s);
    var ox = s.x - leader.x, oy = s.y - leader.y;
    var t = amClampTarget(am.target.x + ox, am.target.y + oy, box);
    var dir = [ox > 0 ? 1 : ox < 0 ? -1 : 0, oy > 0 ? 1 : oy < 0 ? -1 : 0];
    if (!dir[0] && !dir[1]) dir = [0, 1];
    t = amSpread(t, box, dir, taken);
    taken.push({ x: t.x, y: t.y, w: box.w, h: box.h });
    if (t.band) band = true;
    // Путь в обход станции — как его проложит сервер
    var path = amRoute({ grid: GRID_CELLS, w: box.w, h: box.h, x0: s.x, y0: s.y,
                         x1: t.x, y1: t.y, range: range, obstacles: amSpaceObstacles() });
    var block = amBlockAt(t.x, t.y, box, skip);
    if (block && (!warn || s.id === am.leaderId)) warn = block;
    steps = Math.max(steps, path.length);
    eta = Math.max(eta, amEtaSec(s, path.length));
    return { ship: s, box: box, tx: t.x, ty: t.y, path: path, block: block };
  });

  return { items: items, range: range, steps: steps, eta: eta, warn: warn, band: band, leader: leader };
}

// ===== режим выбора цели =====

function amBegin() {
  if (!scShip || !scType) return;
  am = { leaderId: scShip.id, ids: [scShip.id], picking: false, target: null };
  amBoxSig = '';

  // Автоход нужен для дальних точек: отъезжаем, чтобы их было видно
  setTimeout(function() {
    if (!am || !scShip) return;
    if (scale > 0.55) scale = 0.55;
    var box = amBoxOf(scShip);
    focusCell(scShip.x + box.w / 2 - 0.5, scShip.y + box.h / 2 - 0.5);
  }, 30);
}

// Вызывается из scSetMode: ушли из режима — убираем предпросмотр
function amOnMode(mode) {
  if (mode === 'auto') {
    if (!am || !scShip || am.leaderId !== scShip.id) amBegin();
  } else if (am) {
    am = null;
    amAfterPickChange();
  }
}

// Вызывается из scResetSections: смена корабля или закрытие панели
function amReset() {
  var had = !!am;
  am = null;
  amBoxSig = '';
  amStatusSig = '';
  var hud = document.getElementById('ship-hud');
  if (hud) hud.classList.remove('mode-auto');
  if (had) amAfterPickChange();
  else amRender();
}

function amAfterPickChange() {
  if (typeof renderShips === 'function') renderShips();
  amRender();
  amRenderBox();
}

function amToggleMember(ship) {
  if (!am) return;
  if (ship.id === am.leaderId) { scFail('Ведущий всегда во флоте'); return; }
  if (!amOnMap(ship)) { scFail('Этот корабль сейчас не на карте'); return; }
  var i = am.ids.indexOf(ship.id);
  if (i >= 0) am.ids.splice(i, 1);
  else {
    if (am.ids.length >= AM_MAX_GROUP) { scFail('Во флоте не больше ' + AM_MAX_GROUP + ' кораблей'); return; }
    am.ids.push(ship.id);
  }
  amAfterPickChange();
}

function amAddNear() {
  if (!am) return;
  var leader = sxShipById(am.leaderId);
  if (!amOnMap(leader)) return;
  var near = shipsInSystem.filter(function(s) {
    return s.id !== leader.id && amMine(s) && amOnMap(s) && am.ids.indexOf(s.id) < 0 &&
      amGap(leader, s) <= AM_NEAR;
  }).sort(function(a, b) { return amGap(leader, a) - amGap(leader, b); });

  if (!near.length) {
    scFail(am.ids.length > 1 ? 'Все свои рядом уже во флоте' : 'В ' + AM_NEAR + ' клетках своих кораблей нет');
    return;
  }
  var added = 0;
  near.forEach(function(s) {
    if (am.ids.length >= AM_MAX_GROUP) return;
    am.ids.push(s.id);
    added++;
  });
  if (added < near.length) scFail('Взяли ' + added + ' — во флоте не больше ' + AM_MAX_GROUP);
  amAfterPickChange();
}

// Тап по клетке: коробка ведущего встаёт серединой на неё, разворот прежний
function amAim(cx, cy) {
  if (!am || !scShip) return;
  var leader = sxShipById(am.leaderId);
  if (!amOnMap(leader)) return;
  var box = amBoxOf(leader);
  var t = amClampTarget(cx - Math.floor(box.w / 2), cy - Math.floor(box.h / 2), box);
  am.target = { x: t.x, y: t.y, band: t.band };
  amRender();
  amRenderBox();
  scRenderMode();
}

function amEventCell(e) {
  var rect = viewport.getBoundingClientRect();
  return {
    x: Math.floor(((e.clientX - rect.left - panX) / scale) / CELL_PX),
    y: Math.floor(((e.clientY - rect.top - panY) / scale) / CELL_PX)
  };
}

// Тап по полю в режиме автохода (из scInitFieldTap)
function amFieldTap(cx, cy) {
  if (scMode !== 'auto' || !am) return false;
  amAim(cx, cy);
  return true;
}

// Тап по кораблю (из renderShips). true — тап обработан здесь.
function amShipTap(ship, type, mine, e) {
  if (scMode !== 'auto' || !am) return false;
  if (mine && am.picking) { amToggleMember(ship); return true; }
  // Иначе это просто точка на карте — корабль на ней или нет
  var c = amEventCell(e);
  amAim(c.x, c.y);
  return true;
}

// Тап по слоту станции в режиме выбора — тоже точка на карте
function amFieldEvent(e) {
  if (scMode !== 'auto' || !am) return false;
  var c = amEventCell(e);
  amAim(c.x, c.y);
  return true;
}

// Отметка кораблей на карте (из renderShips): в выборе флота — кольца,
// иначе свои идущие корабли получают значок ⇉
function amShipMark(ship) {
  if (am && scMode === 'auto') {
    if (ship.id === am.leaderId) return 'am-lead';
    if (am.ids.indexOf(ship.id) >= 0) return 'am-pick';
    if (am.picking && amMine(ship) && amOnMap(ship)) return 'am-can';
  }
  return amGoingMark(ship) ? 'am-going' : '';
}

function amGoingMark(ship) {
  return amMine(ship) && amOnMap(ship) && !!amActiveRow(ship.id);
}

// Пришли новые автоходы — значки на уже нарисованных кораблях, без
// пересборки всего поля
function amSyncMarks() {
  if (typeof grid === 'undefined' || !grid) return;
  var els = grid.querySelectorAll('.ship-sprite');
  for (var i = 0; i < els.length; i++) {
    var c = els[i].classList;
    var s = sxShipById(els[i].getAttribute('data-ship-id'));
    var on = !!s && amGoingMark(s) && !c.contains('am-lead') && !c.contains('am-pick') && !c.contains('am-can');
    if (c.contains('am-going') !== on) c.toggle('am-going', on);
  }
}

function amGo(btn) {
  var plan = amPlan();
  if (!plan || !plan.steps || amStarting) return;
  var ids = plan.items.map(function(it) { return it.ship.id; });
  // Ведущий первым: его цель — та, что передаём
  ids.sort(function(a, b) { return (a === am.leaderId ? -1 : 0) - (b === am.leaderId ? -1 : 0); });

  amStarting = true;
  if (btn) btn.disabled = true;
  var target = am.target;

  supabase.rpc('start_auto_move', {
    p_layer: 'space', p_ids: ids, p_x: target.x, p_y: target.y
  }).then(function(res) {
    amStarting = false;
    if (btn) btn.disabled = false;
    if (res.error) { scFail(res.error.message); return; }
    // Дальше о ходе говорит строка состояния в панели и нить на карте
    scSetMode(null);
    amLoad();
    loadShips();
  });
}

function amStop(ids, btn) {
  if (!ids || !ids.length) return;
  if (btn) btn.disabled = true;
  supabase.rpc('cancel_auto_move', { p_ids: ids }).then(function(res) {
    if (btn) btn.disabled = false;
    if (res.error) { scFail(res.error.message); return; }
    // Остановили сами — итоговой карточки не нужно
    ids.forEach(function(id) {
      var r = amActiveRow(id);
      if (r) amToasted[r.group_id || r.id] = true;
    });
    amLoad();
  });
}

// ===== панель: режим выбора =====

function amEnsureBox() {
  var box = document.getElementById('am-box');
  if (box) return box;
  var tab = document.getElementById('sc-tab-actions');
  if (!tab) return null;
  box = document.createElement('div');
  box.id = 'am-box';
  var confirm = document.getElementById('sc-confirm');
  tab.insertBefore(box, confirm || null);
  return box;
}

function amRenderBox() {
  var box = amEnsureBox();
  if (!box) return;
  var hud = document.getElementById('ship-hud');

  if (scMode !== 'auto' || !am || !scShip) {
    if (box.innerHTML) box.innerHTML = '';
    box.style.display = 'none';
    amBoxSig = '';
    if (hud) hud.classList.remove('mode-auto');
    return;
  }
  if (hud) hud.classList.add('mode-auto');

  var plan = amPlan();
  var n = am.ids.length;
  var leader = sxShipById(am.leaderId);
  var sig = [am.leaderId, am.ids.join(','), am.picking, am.target ? am.target.x + ':' + am.target.y : '-',
             plan ? plan.steps + '/' + plan.eta + '/' + plan.warn + '/' + plan.band + '/' + plan.range : '-'].join('|');
  if (sig === amBoxSig && box.innerHTML) return;
  amBoxSig = sig;

  var html = '<div class="am-head"><span class="am-ico">⇉</span><b>Автоход · ' + sxEsc(amName(leader)) + '</b>' +
    (am.target ? '' : '<em>— выбери точку</em>') + '</div>';

  if (plan) {
    var who = n > 1 ? 'Флот ' + n : sxEsc(amName(leader));
    var warnText = { ship: 'Точка занята — встанет рядом',
                     station: 'Там станция — встанет рядом' }[plan.warn];
    var bandText = plan.band ? 'Зона прыжка противника — цель сдвинута к её краю' : '';
    html += '<div class="am-sum">' +
      (plan.steps
        ? '<div class="am-sum-main">' + who + ' · ' + amSteps(plan.steps) + ' · ' + amEtaText(plan.eta) + '</div>' +
          '<div class="am-sum-sub">шаг до ' + plan.range + ' кл. · цель ' + am.target.x + ':' + am.target.y +
            ' · действие на шаг</div>'
        : '<div class="am-sum-main">Уже на месте</div>' +
          '<div class="am-sum-sub">Выбери точку подальше</div>') +
      (bandText && plan.steps ? '<div class="am-warn"><i>!</i>' + bandText + '</div>' : '') +
      (warnText && plan.steps ? '<div class="am-warn"><i>!</i>' + warnText + '</div>' : '') +
    '</div>';
  } else {
    html += '<div class="am-lead-text">Коснись дальней точки — корабль пойдёт сам, шаг за шагом. ' +
      'Каждый шаг — одно действие.</div>';
  }

  html += '<div class="am-row">' +
    '<button class="am-chip' + (am.picking ? ' on' : '') + '" data-a="fleet">Флот<b>' + n + '</b></button>' +
    '<button class="am-chip" data-a="near">Все рядом</button>' +
    '<button class="am-chip am-chip-x" data-a="cancel">Отмена</button>' +
  '</div>';

  if (am.picking) {
    html += '<div class="am-note">Золотое кольцо — во флоте. Строй сохранится, ' +
      'шаг — по самому медленному.</div>';
  }

  if (plan && plan.steps) {
    html += '<div class="am-go">' +
      '<button class="sc-btn sc-btn-go" data-a="go">Вперёд</button>' +
      '<button class="sc-btn" data-a="again">Другая точка</button>' +
    '</div>';
  }

  box.innerHTML = html;
  box.style.display = 'block';

  var bind = function(a, fn) {
    var b = box.querySelector('[data-a="' + a + '"]');
    if (b) b.addEventListener('click', function(e) { e.stopPropagation(); fn(b); });
  };
  bind('fleet', function() { am.picking = !am.picking; amAfterPickChange(); scRenderMode(); });
  bind('near', function() { amAddNear(); });
  bind('cancel', function() { scSetMode(null); });
  bind('go', function(b) { amGo(b); });
  bind('again', function() { am.target = null; amRender(); amRenderBox(); scRenderMode(); });

  amFitHud();
}

// Панель поменяла высоту — карта должна остаться над ней
function amFitHud() {
  var hud = document.getElementById('ship-hud');
  if (!hud || hud.style.display === 'none' || typeof setBottomInset !== 'function') return;
  setTimeout(function() {
    if (hud.style.display !== 'none') setBottomInset(hud.offsetHeight + 12);
  }, 0);
}

// Подсказка под панелью в режиме автохода (из scRenderMode)
function amHintText() {
  if (!am) return '';
  if (am.picking) return 'Тап по своему кораблю — во флот или из флота';
  if (am.target) return 'Можно ткнуть в другую точку';
  return 'Коснись точки на карте';
}

// ===== панель: плитка и строка состояния =====

function amActiveRow(shipId) {
  for (var i = 0; i < amMoves.length; i++) {
    var r = amMoves[i];
    if (r.ship_id === shipId && r.status === 'active') return r;
  }
  return null;
}

function amGroupRows(row) {
  if (!row) return [];
  if (!row.group_id) return [row];
  return amMoves.filter(function(r) { return r.status === 'active' && r.group_id === row.group_id; });
}

function amNextIn(row) {
  if (!row || row.next_step_in === null || row.next_step_in === undefined) return null;
  return Math.max(0, row.next_step_in - Math.floor((Date.now() - amMovesAt) / 1000));
}

// Плитка среди действий (из scRenderTiles). Действий не требует:
// автоход сам ждёт, пока они накопятся.
function amAddTile(add, describe) {
  if (!scShip || !amOnMap(scShip)) return;
  var row = amActiveRow(scShip.id);
  var range = amRangeOf(scShip);
  add('auto', '⇉', 'Автоход', true, function() {
    describe('Автоход',
      'Корабль сам идёт к дальней точке: шаг за шагом, по действию на шаг. ' +
      'Можно вести флот — строй сохранится.',
      'шаг до ' + range + ' кл.' + (row ? ' · уже идёт' : ''));
  });
  if (row) {
    var t = document.querySelector('#sc-tiles .sc-tile[data-key="auto"]');
    if (t) t.classList.add('am-running');
  }
}

// Строка «Автоход · осталось N шагов · шаг через 12 с» (из scRenderAp)
function amRenderStatus() {
  var tab = document.getElementById('sc-tab-actions');
  if (!tab) return;
  var el = document.getElementById('am-status');
  var row = scShip ? amActiveRow(scShip.id) : null;

  if (!row || scMode === 'auto') {
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    if (amStatusSig) { amStatusSig = ''; amFitHud(); }
    return;
  }

  if (!el) {
    el = document.createElement('div');
    el.id = 'am-status';
    tab.insertBefore(el, tab.firstChild);
  }

  var group = amGroupRows(row);
  var left = (row.path || []).length;
  var done = row.steps_done || 0;
  var total = Math.max(1, done + left);
  var next = amNextIn(row);
  var nextText = next === null ? '' : next > 0 ? 'шаг через ' + next + ' с' : 'шаг вот-вот';
  var sig = row.id + '|' + group.length;

  if (sig !== amStatusSig || !el.innerHTML) {
    amStatusSig = sig;
    el.className = 'am-status' + (group.length > 1 ? ' group' : '');
    el.innerHTML =
      '<div class="am-st-main">' +
        '<div class="am-st-title"><span class="am-ico">⇉</span><b>Автоход</b>' +
          (group.length > 1 ? '<em>· флот ' + group.length + '</em>' : '') + '</div>' +
        '<div class="am-st-line"><span class="am-st-left"></span><span class="am-st-next"></span></div>' +
        '<div class="am-st-track"><i></i></div>' +
      '</div>' +
      '<div class="am-st-acts">' +
        (group.length > 1
          ? '<button class="am-chip am-stop" data-a="all">Стоп флот</button>' +
            '<button class="am-chip" data-a="one">Только он</button>'
          : '<button class="am-chip am-stop" data-a="one">Стоп</button>') +
      '</div>';

    var forShip = row.ship_id;
    var all = el.querySelector('[data-a="all"]');
    if (all) all.addEventListener('click', function() {
      var r = amActiveRow(forShip);
      amStop(amGroupRows(r).map(function(g) { return g.ship_id; }), all);
    });
    var one = el.querySelector('[data-a="one"]');
    if (one) one.addEventListener('click', function() { amStop([forShip], one); });
    amFitHud();
  }

  el.style.display = 'flex';
  el.querySelector('.am-st-left').textContent = 'осталось ' + amSteps(left);
  el.querySelector('.am-st-next').textContent = nextText ? ' · ' + nextText : '';
  el.querySelector('.am-st-track i').style.width = Math.round(done / total * 100) + '%';
}

// ===== нить на карте =====

function amEnsureSvg() {
  if (amSvg && amSvg.parentNode === grid) return amSvg;
  amSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  amSvg.setAttribute('class', 'am-layer');
  var px = GRID_CELLS * CELL_PX;
  amSvg.setAttribute('width', px);
  amSvg.setAttribute('height', px);
  amSvg.setAttribute('viewBox', '0 0 ' + px + ' ' + px);
  // Под кораблями: нить выходит из-под корпуса, а не режет его
  grid.insertBefore(amSvg, grid.firstChild);
  return amSvg;
}

function amClearTags() {
  amTagEls.forEach(function(el) { if (el.parentNode) el.parentNode.removeChild(el); });
  amTagEls = [];
}

function amTag(x, y, box, text, cls) {
  var pos = document.createElement('div');
  pos.className = 'am-tag-pos';
  pos.style.left = ((x + box.w / 2) * CELL_PX) + 'px';
  pos.style.top = (y * CELL_PX) + 'px';
  var t = document.createElement('div');
  t.className = 'am-tag' + (cls ? ' ' + cls : '');
  t.textContent = text;
  pos.appendChild(t);
  pos.setAttribute('data-below', String((y + box.h) * CELL_PX));
  pos.setAttribute('data-top', String(y * CELL_PX));
  pos.setAttribute('data-cls', t.className);
  grid.appendChild(pos);
  amTagEls.push(pos);
}

// Подпись не должна залезать под часы и кредиты сверху и за края экрана:
// у верхнего края переносим её под финиш, по бокам — сдвигаем внутрь
function amFitTags() {
  var vw = window.innerWidth;
  amTagEls.forEach(function(pos) {
    var t = pos.firstChild;
    if (!t) return;
    // Каждый раз с чистого листа: после сдвига карты подгонка пересчитывается
    pos.style.top = pos.getAttribute('data-top') + 'px';
    t.className = pos.getAttribute('data-cls');
    t.style.transform = '';
    var r = t.getBoundingClientRect();
    var mid = (r.left + r.right) / 2;
    if (mid < 0 || mid > vw) return;
    if (r.top < 100 && t.className.indexOf('below') < 0) {
      pos.style.top = pos.getAttribute('data-below') + 'px';
      t.className += ' below';
      r = t.getBoundingClientRect();
    }
    var dx = 0;
    if (r.left < 8) dx = 8 - r.left;
    else if (r.right > vw - 8) dx = vw - 8 - r.right;
    var lim = Math.max(0, r.width / 2 - 14);
    dx = Math.max(-lim, Math.min(lim, dx));
    // Сам финиш почти целиком под верхней полосой — подпись всё равно
    // опускаем под неё, пока финиш хоть немного виден
    var dy = 0;
    if (r.top < 56 && r.bottom > -60) dy = 56 - r.top;
    if (dx || dy) {
      t.style.transform = 'translateX(calc(-50% + ' + Math.round(dx) + 'px))' +
        (dy ? ' translateY(' + Math.round(dy) + 'px)' : '');
    }
  });
}

// Карту сдвинули или приблизили (из applyTransform) — подгоняем подписи
// не чаще раза за кадр
var amFitPending = false;
function amOnTransform() {
  if (!amTagEls.length || amFitPending) return;
  amFitPending = true;
  (window.requestAnimationFrame || setTimeout)(function() {
    amFitPending = false;
    amFitTags();
  });
}

function amF(n) { return Math.round(n * 10) / 10; }

// Одна нить: ломаная через центры коробок, узлы на шагах, метка финиша
function amThreadSvg(ship, box, path, cls, ghost) {
  var start = amCenter(ship.x, ship.y, box);
  var pts = [start];
  path.forEach(function(p) {
    if (p[0] === ship.x && p[1] === ship.y && pts.length === 1) return;
    pts.push(amCenter(p[0], p[1], box));
  });
  if (pts.length < 2) return '';

  var line = pts.map(function(p) { return amF(p[0]) + ',' + amF(p[1]); }).join(' ');
  var fin = path[path.length - 1];
  var fx = fin[0] * CELL_PX, fy = fin[1] * CELL_PX, fw = box.w * CELL_PX, fh = box.h * CELL_PX;
  var c = pts[pts.length - 1];
  var r = Math.min(fw, fh) * 0.22;
  var hot = cls.indexOf('dim') < 0;

  var s = '<g class="am-g ' + cls + '">';
  s += '<polyline class="am-under" points="' + line + '"/>';
  s += '<polyline class="am-line" points="' + line + '"/>';
  for (var i = 1; i < pts.length - 1; i++) {
    s += '<circle class="am-node" cx="' + amF(pts[i][0]) + '" cy="' + amF(pts[i][1]) + '" r="' + (hot ? 5 : 3.5) + '"/>';
  }
  if (ghost) {
    var t = amType(ship);
    if (t && t.image) {
      var iw = t.width_cells * CELL_PX, ih = t.height_cells * CELL_PX;
      s += '<image class="am-ghost" href="../' + sxEsc(t.image) + '" x="' + amF(c[0] - iw / 2) + '" y="' + amF(c[1] - ih / 2) +
        '" width="' + iw + '" height="' + ih + '" transform="rotate(' + (ship.facing || 0) + ' ' + amF(c[0]) + ' ' + amF(c[1]) + ')"' +
        ' preserveAspectRatio="none"/>';
    }
  }
  s += '<rect class="am-fin" x="' + (fx + 2) + '" y="' + (fy + 2) + '" width="' + (fw - 4) + '" height="' + (fh - 4) + '" rx="4"/>';
  // Прицел в центре финиша
  s += '<path class="am-cross" d="M' + amF(c[0] - r) + ' ' + amF(c[1]) + 'H' + amF(c[0] + r) +
       'M' + amF(c[0]) + ' ' + amF(c[1] - r) + 'V' + amF(c[1] + r) + '"/>';
  s += '<circle class="am-dot" cx="' + amF(c[0]) + '" cy="' + amF(c[1]) + '" r="' + (hot ? 3.5 : 2.5) + '"/>';
  s += '</g>';
  return s;
}

function amSelectedGroup() {
  if (!scShip) return null;
  var r = amActiveRow(scShip.id);
  return r ? (r.group_id || r.id) : null;
}

function amRender() {
  if (typeof grid === 'undefined' || !grid) return;
  if (am && (scMode !== 'auto' || !scShip || scShip.id !== am.leaderId)) am = null;

  var hotKey = amSelectedGroup();
  var plan = amPlan();
  var parts = [];
  var tags = [];
  var pulse = null;
  var sigParts = [hotKey];

  // Живые автоходы: нить только у выбранного корабля и его флота. В выборе
  // цели прежний путь кораблей флота виден тускло, пока точка не выбрана
  amMoves.forEach(function(r) {
    if (r.status !== 'active' || !r.path || !r.path.length) return;
    var key = r.group_id || r.id;
    var hot = !!hotKey && key === hotKey;
    var picked = !!am && am.ids.indexOf(r.ship_id) >= 0;
    // В предпросмотре нового маршрута старая нить этих кораблей только мешает
    if (picked && plan) return;
    if (!hot && !picked) return;
    var s = sxShipById(r.ship_id);
    if (!amOnMap(s)) return;
    var box = amBoxOf(s);
    parts.push({ hot: hot, svg: amThreadSvg(s, box, r.path, hot ? 'live' : 'live dim', false) });
    sigParts.push(r.id + ':' + s.x + ':' + s.y + ':' + s.facing + ':' + JSON.stringify(r.path) + ':' + (hot ? 1 : 0));
    if (hot && scShip && s.id === scShip.id) {
      var fin = r.path[r.path.length - 1];
      var group = amGroupRows(r);
      var eta = 0;
      group.forEach(function(g) { eta = Math.max(eta, amEtaSec(sxShipById(g.ship_id), (g.path || []).length)); });
      tags.push([fin[0], fin[1], box, 'осталось ' + amSteps(r.path.length) + ' · ' + amEtaText(eta), '']);
      if (!plan) pulse = [fin[0], fin[1], box, ''];
    }
  });

  // Предпросмотр
  if (plan) {
    plan.items.forEach(function(it) {
      if (!it.path.length) return;
      var lead = it.ship.id === am.leaderId;
      parts.push({ hot: true, svg: amThreadSvg(it.ship, it.box, it.path, 'plan' + (lead ? ' lead' : ''), true) });
      sigParts.push('p' + it.ship.id + ':' + it.ship.x + ':' + it.ship.y + ':' + it.tx + ':' + it.ty + ':' + it.path.length);
      if (lead) {
        tags.push([it.tx, it.ty, it.box, amSteps(plan.steps) + ' · ' + amEtaText(plan.eta), 'plan']);
        pulse = [it.tx, it.ty, it.box, 'plan'];
      }
      if (it.block) tags.push([it.tx, it.ty + it.box.h, it.box, 'встанет рядом', 'warn below']);
    });
  }

  tags.forEach(function(t) { sigParts.push(t.join(':')); });
  if (pulse) sigParts.push('pulse:' + pulse[0] + ':' + pulse[1] + ':' + pulse[2].w + ':' + pulse[2].h + ':' + pulse[3]);
  var sig = sigParts.join('|');
  var svg = amEnsureSvg();
  if (sig === amRenderSig && svg.parentNode) return;
  amRenderSig = sig;

  // Яркие поверх тусклых. Пустой слой прячем целиком
  parts.sort(function(a, b) { return (a.hot ? 1 : 0) - (b.hot ? 1 : 0); });
  svg.innerHTML = parts.map(function(p) { return p.svg; }).join('');
  svg.style.display = parts.length ? '' : 'none';

  amRenderPulse(pulse);
  amClearTags();
  tags.forEach(function(t) { amTag(t[0], t[1], t[2], t[3], t[4]); });
  amFitTags();
}

// Пульс финиша: HTML-рамка под кораблями. Анимация только transform и
// opacity — её ведёт видеокарта, нить при этом не перерисовывается
function amRenderPulse(p) {
  if (!p) {
    if (amPulseEl && amPulseEl.parentNode) amPulseEl.parentNode.removeChild(amPulseEl);
    amPulseEl = null;
    return;
  }
  if (!amPulseEl) {
    amPulseEl = document.createElement('div');
  }
  if (amPulseEl.parentNode !== grid) grid.insertBefore(amPulseEl, amSvg ? amSvg.nextSibling : grid.firstChild);
  amPulseEl.className = 'am-pulse-box' + (p[3] ? ' ' + p[3] : '');
  amPulseEl.style.left = (p[0] * CELL_PX + 2) + 'px';
  amPulseEl.style.top = (p[1] * CELL_PX + 2) + 'px';
  amPulseEl.style.width = (p[2].w * CELL_PX - 4) + 'px';
  amPulseEl.style.height = (p[2].h * CELL_PX - 4) + 'px';
}

// ===== загрузка и итоги =====

function amLoadSoon() {
  if (amLoadTimer) clearTimeout(amLoadTimer);
  amLoadTimer = setTimeout(function() { amLoadTimer = null; amLoad(); }, 250);
}

function amLoad() {
  if (!systemId || !currentUserId || amRpcBroken) return;
  var seq = ++amLoadSeq;
  supabase.rpc('get_my_auto_moves', { p_system_id: systemId, p_layer: 'space' }).then(function(res) {
    if (seq <= amLoadApplied) return;
    amLoadApplied = seq;
    if (res.error) {
      // Функции ещё нет на сервере — молча живём без автохода
      if (/does not exist|not find|404/i.test(res.error.message || '')) amRpcBroken = true;
      return;
    }
    var rows = res.data || [];
    amCheckFinished(rows);
    amMoves = rows;
    amMovesAt = Date.now();
    amMovedSince();
    amRender();
    amSyncMarks();
    if (scShip) { scRenderTiles(); amRenderStatus(); }
    amArmPoll();
  });
}

// Подстраховка на случай пропущенного события: пока кто-то из своих идёт —
// перечитываем раз в 20 с. Никто не идёт — таймера нет
function amArmPoll() {
  if (amPollTimer) { clearTimeout(amPollTimer); amPollTimer = null; }
  var any = amMoves.some(function(r) { return r.status === 'active'; });
  if (!any) return;
  amPollTimer = setTimeout(function() {
    amPollTimer = null;
    if (document.hidden) { amArmPoll(); return; }
    amLoad();
  }, 20000);
}

// Сдвинулся ли кто-то из идущих с прошлого раза. Заодно запоминаем,
// где стоят сейчас
function amMovedSince() {
  var moved = false, next = {};
  amMoves.forEach(function(r) {
    if (r.status !== 'active') return;
    var s = sxShipById(r.ship_id);
    var at = amOnMap(s) ? s.x + ':' + s.y + ':' + (s.facing || 0) : '-';
    next[r.ship_id] = at;
    if (amPosMemo[r.ship_id] !== undefined && amPosMemo[r.ship_id] !== at) moved = true;
  });
  amPosMemo = next;
  return moved;
}

function amSubscribe() {
  if (amSubscribed || !systemId) return;
  amSubscribed = true;
  try {
    supabase
      .channel('automove-space-' + systemId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'auto_moves', filter: 'system_id=eq.' + systemId },
          function() { amLoadSoon(); })
      .subscribe();
  } catch (e) {}
}

// После каждой загрузки кораблей (из loadShips)
function amAfterShips(prev) {
  // Кто получил попадание — пригодится, чтобы назвать его в итоге
  if (prev && prev.length) {
    var before = {};
    prev.forEach(function(s) { before[s.id] = s; });
    shipsInSystem.forEach(function(s) {
      var p = before[s.id];
      if (!p || s.owner_user_id !== currentUserId) return;
      var lostShield = ['shield_fore', 'shield_aft', 'shield_port', 'shield_starboard'].some(function(k) {
        return (Number(s[k]) || 0) < (Number(p[k]) || 0);
      });
      if ((s.hp || 0) < (p.hp || 0) || lostShield) amHurtAt[s.id] = Date.now();
    });
  }

  if (am) {
    // Ушедшие с карты (в ангар, в прыжок, сбиты) выпадают из флота
    am.ids = am.ids.filter(function(id) { var s = sxShipById(id); return amOnMap(s); });
    if (am.ids.indexOf(am.leaderId) < 0) { scSetMode(null); }
  }

  amSubscribe();
  amRender();
  if (am) amRenderBox();
  // Перечитываем автоходы, только когда есть что обновлять: первая загрузка
  // или кто-то из идущих шагнул (путь на сервере стал короче). Остальное
  // приносит realtime, а пропущенное — редкий опрос
  if (amSeen === null || amMovedSince()) amLoadSoon();
}

// Итог показываем один раз на отряд и только при переходе, увиденном
// здесь: после перезагрузки страницы старые итоги не всплывают
function amCheckFinished(rows) {
  if (amSeen === null) {
    amSeen = {};
    rows.forEach(function(r) {
      amSeen[r.id] = r.status;
      if (r.status !== 'active') amToasted[r.group_id || r.id] = true;
    });
    return;
  }

  var changed = {};
  rows.forEach(function(r) {
    var prev = amSeen[r.id];
    amSeen[r.id] = r.status;
    if (r.status === 'active' || prev === r.status) return;
    // Новая строка, которая уже завершилась, — только если свежая
    if (prev === undefined && r.updated_at && Date.now() + scTimeOffset - new Date(r.updated_at).getTime() > 60000) return;
    changed[r.group_id || r.id] = true;
  });

  Object.keys(changed).forEach(function(key) {
    if (amToasted[key]) return;
    var group = rows.filter(function(r) { return (r.group_id || r.id) === key; });
    var reasons = {};
    group.forEach(function(r) { if (r.status !== 'active') reasons[r.stop_reason || 'arrived'] = true; });
    var stillGoing = group.some(function(r) { return r.status === 'active'; });

    // Прерывание и тупик видны сразу, прибытие — когда дошли все
    if (!reasons.damaged && !reasons.blocked && stillGoing) return;
    amToasted[key] = true;
    amReportFinish(group, reasons);
  });
}

function amReportFinish(group, reasons) {
  var ships = group.map(function(r) { return sxShipById(r.ship_id); });
  var lead = null, leadRow = group[0];
  for (var i = 0; i < ships.length; i++) if (ships[i]) { lead = ships[i]; leadRow = group[i]; break; }
  var many = group.length > 1;
  // Портрет и подпись: один корабль — его имя, флот — «Венатор и ещё 2»
  var pic = function(s) {
    var p = s ? sxShipPic(s, amType(s), 'mine') : { img: null, side: 'mine', name: 'Корабль' };
    if (many && s === lead) p.name = p.name + ' и ещё ' + (group.length - 1);
    return p;
  };
  var pos = (function(r) {
    var x = r.final_x, y = r.final_y;
    if (x === null || x === undefined) { x = r.target_x; y = r.target_y; }
    return (x === null || x === undefined) ? null : { text: 'Позиция ' + x + ':' + y, cls: 'muted' };
  })(leadRow);

  if (reasons.damaged) {
    // Называем того, по кому попали; не знаем — ведущего с флотом
    var hit = null, best = 0;
    ships.forEach(function(s) { if (s && (amHurtAt[s.id] || 0) > best) { best = amHurtAt[s.id]; hit = s; } });
    if (best && Date.now() - best > 60000) hit = null;
    var shown = hit || lead;
    var p = shown ? sxShipPic(shown, amType(shown), 'mine') : pic(null);
    if (!hit && many) p = pic(lead);
    amToast({
      kind: 'incoming',
      title: 'Автоход прерван',
      target: p,
      lines: [{ text: (hit || !many ? 'Под огнём' : 'Флот под огнём') + (many ? ' — флот остановлен' : '') },
              { text: 'Отвечай или уводи вручную', cls: 'muted' }]
    }, true);
    return;
  }

  if (reasons.blocked) {
    amToast({
      kind: 'hit', title: 'Путь перекрыт', target: pic(lead),
      lines: [{ text: 'Дальше не пройти — ' + (many ? 'флот стоит' : 'корабль стоит') },
              { text: 'Выбери другую точку', cls: 'muted' }]
    });
    return;
  }

  // Остановили сами или ушли с карты — сообщать нечего
  if (!reasons.arrived && !reasons.arrived_near) return;

  if (reasons.arrived_near && !many) {
    amToast({
      kind: 'hit', title: 'Встал рядом', target: pic(lead),
      lines: [{ text: 'Точка занята — встал как можно ближе' }, pos]
    });
    return;
  }

  amToast({
    kind: 'heal',
    title: many ? 'Флот на месте' : 'На месте',
    target: pic(lead),
    lines: [reasons.arrived_near ? { text: 'Кто-то встал рядом — точка занята' } : null, pos]
  });
}

// Свежую сводку боя не перебиваем: итог встаёт следом
function amToast(o, afterCombat) {
  var wait = (typeof sxToastShownAt !== 'undefined') ? 2200 - (Date.now() - sxToastShownAt) : 0;
  if (!afterCombat && wait > 0) wait = Math.min(wait, 1200);
  if (wait > 0) setTimeout(function() { sxReport(o); }, wait);
  else sxReport(o);
}
