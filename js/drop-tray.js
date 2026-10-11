// Десант: перетаскивание из трюма в полосу вторжения.
//
// Раньше высадка шла так: кнопка → список → выбрать строку → тыкать
// в клетки полосы по одному. Теперь кнопка «Высадка» открывает лоток
// с карточками того, что ждёт в трюмах над планетой, а карта сама
// показывает полосу вторжения. Карточку тянут пальцем прямо на поле:
// под пальцем видно место (зелёное — можно, красное — нельзя) и подсказку.
// Отпустил на свободной клетке полосы — боец на земле. Короткий тап по
// карточке по-прежнему выбирает её, и тогда ставят тапами по клеткам.
//
// Правила те же, что у сервера (unload_unit_at, unload_vehicle_at,
// land_fighter): клиент лишь заранее показывает, что выйдет.

var dtOpen = false;
var dtSelKey = null;        // выбранная тапом карточка
var dtDrag = null;          // карточка в руке
var dtPending = [];         // отпустили, ждём сервер: {x, y, w, h, img}
var dtCloseTimer = null;
var dtDirty = false;        // данные сменились, пока карточка в руке
var dtCardTouch = false;    // палец лежит на карточке (ещё не поднял её)

var DT_HOLD_MS = 220;       // удержание, после которого карточка «в руке»
var DT_SLOP = 9;

function dtEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Что можно высадить: истребители, техника и пехота из трюмов
function dtItems() {
  var l = dropListFor();
  var out = [];
  l.fighters.forEach(function(f) {
    out.push({ key: 'f:' + f.fighter_id, kind: 'fighter', src: f, w: 1, h: 1,
               img: f.image, name: f.name, veh: true,
               badge: f.hp + '/' + f.max_hp, sub: f.carrier_name,
               ready: f.zone !== null && f.zone !== undefined });
  });
  l.vehicles.forEach(function(v) {
    out.push({ key: 'v:' + v.unit_id, kind: 'vehicle', src: v,
               w: v.width_cells || 1, h: v.height_cells || 1,
               img: v.unit_image, name: v.unit_name, veh: true,
               badge: (v.width_cells || 1) + '×' + (v.height_cells || 1) +
                      (v.passengers ? ' +' + v.passengers : ''),
               sub: v.ship_name, ready: v.zone !== null && v.zone !== undefined });
  });
  l.cargo.forEach(function(c) {
    var t = unitTypeById[c.unit_type] || {};
    out.push({ key: 'c:' + c.ship_id + '|' + c.unit_type, kind: 'unit', src: c, w: 1, h: 1,
               img: c.unit_image || t.image, name: c.unit_name, veh: !!t.is_vehicle,
               badge: '×' + c.quantity, count: c.quantity, sub: c.ship_name,
               ready: c.zone !== null && c.zone !== undefined });
  });
  return out;
}

// Сколько ещё можно взять с карточки: часть уже летит на сервер
function dtLeft(it) {
  var n = 0;
  for (var i = 0; i < dtPending.length; i++) {
    var p = dtPending[i];
    if (p.key !== it.key) continue;
    // Уже на земле: в счёт, пока не пришёл свежий трюм (он уже без него)
    if (p.landed && dtHoldList(it.kind) !== p.holdRef) continue;
    n++;
  }
  return (it.count || 1) - n;
}

// Список трюма, из которого карточка: loadDropCargo заменяет его целиком
function dtHoldList(kind) {
  return kind === 'unit' ? dropCargo : kind === 'vehicle' ? dropVehicles : dropFighters;
}

// Высота лотка: по раскладке, а не по экрану — пока он выезжает,
// его прямоугольник ещё внизу за краем
function dtInset(el) {
  return el && el.offsetHeight ? el.offsetHeight + 8 : 0;
}

function dtItemByKey(key) {
  var all = dtItems();
  for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
  return null;
}

// ── Лоток ─────────────────────────────────────────────────────────

function dtEnsure() {
  var el = document.getElementById('dt-tray');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'dt-tray';
  el.innerHTML =
    '<div class="dt-head">' +
      '<span class="dt-ico">⇣</span>' +
      '<span class="dt-titles"><b>Десант</b><i id="dt-hint">Перетащи карточку в полосу вторжения</i></span>' +
      '<button type="button" class="dt-x" aria-label="Закрыть">✕</button>' +
    '</div>' +
    '<div class="dt-cards" id="dt-cards"></div>';
  el.querySelector('.dt-x').addEventListener('click', closeDropTray);
  // Касания лотка не должны двигать карту под ним
  ['touchstart', 'touchmove', 'wheel'].forEach(function(ev) {
    el.addEventListener(ev, function(e) { e.stopPropagation(); }, { passive: true });
  });
  document.body.appendChild(el);
  return el;
}

function openDropTray() {
  if (dtCloseTimer) { clearTimeout(dtCloseTimer); dtCloseTimer = null; }
  // Другие режимы карты гасим: один жест — одно действие
  if (typeof cancelDrop === 'function' && (droppingUnit || droppingVehicle || landingFighter)) cancelDrop();
  if (selectedUnit) { selectedUnit = null; hidePickup(); }
  if (typeof selectedStructure !== 'undefined' && selectedStructure) { selectedStructure = null; hidePickup(); }

  var el = dtEnsure();
  dtOpen = true;
  dtSelKey = null;
  dtRender();
  el.classList.add('open');

  var btn = document.getElementById('drop-btn');
  if (btn) btn.style.visibility = 'hidden';

  // Полоса вторжения — на виду над лотком и в рабочем масштабе
  setTimeout(function() {
    if (!dtOpen) return;
    setBottomInset(dtInset(el));
    // Середину экрана берём до смены масштаба, иначе карта прыгнет вбок
    var midX = (viewport.clientWidth / 2 - panX) / scale / CELL_PX;
    if (scale < 0.9) scale = 1;
    focusCell(midX, GRID_SIZE - ATTACK_ZONE_H / 2 - 1);
    redrawScene();
  }, 30);
}

function closeDropTray() {
  if (!dtOpen) return;
  dtOpen = false;
  dtSelKey = null;
  dtCancelDrag();
  droppingUnit = null; droppingVehicle = null; landingFighter = null;
  var el = document.getElementById('dt-tray');
  if (el) el.classList.remove('open');
  setBottomInset(0);
  updateDropBtn();
  redrawScene();
}

// Свежие данные трюмов (loadDropCargo) — перерисовываем лоток
// Пока карточка в руке, лоток не перестраиваем: если убрать из DOM
// элемент, на котором началось касание, браузер перестанет слать
// touchmove документу и жест оборвётся. Перерисуем после броска.
function dtRefresh() {
  if (!dtOpen) return;
  if (dtDrag || dtCardTouch) { dtDirty = true; return; }
  dtRender();
}

function dtRender() {
  var box = document.getElementById('dt-cards');
  if (!box) return;
  var items = dtItems();
  dtDirty = false;
  box.innerHTML = '';

  if (!items.length) {
    box.innerHTML = '<div class="dt-empty">Все на земле — трюмы пусты</div>';
    // Высадили последнего — лоток уходит сам
    if (!dtCloseTimer) dtCloseTimer = setTimeout(function() { dtCloseTimer = null; closeDropTray(); }, 1400);
    return;
  }
  if (dtCloseTimer) { clearTimeout(dtCloseTimer); dtCloseTimer = null; }

  // Выбранная тапом карточка могла кончиться
  if (dtSelKey && !items.some(function(i) { return i.key === dtSelKey && i.ready && dtLeft(i) > 0; })) dtSelect(null);

  items.forEach(function(it) {
    var left = dtLeft(it);
    var flying = it.ready && left <= 0;
    var badge = it.kind === 'unit' ? '×' + Math.max(0, left) : it.badge;
    var c = document.createElement('div');
    c.className = 'dt-card' + (it.ready && !flying ? '' : ' off') + (flying ? ' flying' : '') +
                  (it.key === dtSelKey ? ' sel' : '') + (it.veh ? ' veh' : '');
    c.setAttribute('data-key', it.key);
    c.innerHTML =
      '<span class="dt-thumb">' + (it.img ? '<img src="../' + dtEsc(it.img) + '" alt="" draggable="false">' : '') +
        '<em>' + dtEsc(badge) + '</em></span>' +
      '<span class="dt-name">' + dtEsc(it.name) + '</span>' +
      '<span class="dt-sub">' + (!it.ready ? 'вне площадки сброса' : flying ? 'высаживается…' : dtEsc(it.sub)) + '</span>';
    if (it.ready && !flying) dtBindCard(c, it);
    box.appendChild(c);
  });

  var hint = document.getElementById('dt-hint');
  if (hint) {
    var sel = dtSelKey ? dtItemByKey(dtSelKey) : null;
    hint.textContent = sel ? 'Выбрано: ' + sel.name + ' — тапни по полосе или тяни карточку'
                           : 'Перетащи карточку в полосу вторжения';
  }
}

// Тап по карточке: выбрать для постановки тапами (старый способ)
function dtSelect(it) {
  droppingUnit = null; droppingVehicle = null; landingFighter = null;
  dtSelKey = it ? it.key : null;
  if (it) {
    if (it.kind === 'unit') droppingUnit = { shipId: it.src.ship_id, unitType: it.src.unit_type, name: it.name };
    else if (it.kind === 'vehicle') droppingVehicle = it.src;
    else landingFighter = it.src;
  }
  var cards = document.querySelectorAll('#dt-cards .dt-card');
  for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('sel', cards[i].getAttribute('data-key') === dtSelKey);
  var hint = document.getElementById('dt-hint');
  if (hint) hint.textContent = it ? 'Выбрано: ' + it.name + ' — тапни по полосе или тяни карточку'
                                  : 'Перетащи карточку в полосу вторжения';
  redrawScene();
}

// ── Жест: карточка из лотка на поле ──────────────────────────────

function dtBindCard(card, it) {
  var start = null;

  var begin = function(x, y, id) {
    if (dtDrag) return;
    start = { x: x, y: y, id: id, moved: false,
              timer: setTimeout(function() { if (start && !start.moved) dtStartDrag(it, card, start.x, start.y, start.id); }, DT_HOLD_MS) };
  };
  var move = function(x, y, e) {
    if (dtDrag) return;
    if (!start) return;
    var dx = x - start.x, dy = y - start.y;
    if (Math.abs(dx) < DT_SLOP && Math.abs(dy) < DT_SLOP) return;
    start.moved = true;
    clearTimeout(start.timer);
    // Вверх — тянем на поле; вбок — листаем лоток
    if (-dy > Math.abs(dx)) {
      if (e && e.cancelable) e.preventDefault();
      dtStartDrag(it, card, x, y, start.id);
    } else {
      start = null;
    }
  };
  var end = function() {
    if (!start) return;
    clearTimeout(start.timer);
    var tap = !start.moved && !dtDrag;
    start = null;
    if (tap) dtSelect(dtSelKey === it.key ? null : it);
  };
  // Палец ушёл с карточки без подъёма: перерисовать отложенное
  var release = function() {
    dtCardTouch = false;
    if (dtDirty && !dtDrag && dtOpen) dtRender();
  };

  card.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) { if (start) { clearTimeout(start.timer); start = null; } return; }
    dtCardTouch = true;
    var t = e.changedTouches[0];
    begin(t.clientX, t.clientY, t.identifier);
  }, { passive: true });
  card.addEventListener('touchmove', function(e) {
    if (e.touches.length !== 1) return;
    move(e.touches[0].clientX, e.touches[0].clientY, e);
  }, { passive: false });
  card.addEventListener('touchend', function(e) {
    if (dtDrag) return;               // жест закончит обработчик документа
    var wasTap = start && !start.moved;
    end();
    if (wasTap && e.cancelable) e.preventDefault();
    release();
  });
  card.addEventListener('touchcancel', function() {
    if (start) { clearTimeout(start.timer); start = null; }
    if (!dtDrag) release();
  });
  card.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dtCardTouch = true;
    begin(e.clientX, e.clientY, null);
    var mm = function(ev) { move(ev.clientX, ev.clientY, ev); if (dtDrag) dtDragMove(ev.clientX, ev.clientY); };
    var mu = function(ev) {
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
      if (dtDrag) { dtDragEnd(ev.clientX, ev.clientY); return; }
      end();
      release();
    };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
  });
}

function dtStartDrag(it, card, x, y, touchId) {
  // Лоток успели перестроить — эта карточка уже не на экране
  if (dtDrag || !dtOpen || !document.body.contains(card)) { dtCardTouch = false; return; }
  var ghost = document.createElement('div');
  ghost.className = 'dt-ghost' + (it.veh ? ' veh' : '');
  ghost.innerHTML = it.img ? '<img src="../' + dtEsc(it.img) + '" alt="">' : '';
  document.body.appendChild(ghost);

  dtDrag = { it: it, card: card, ghost: ghost, cx: x, cy: y, entered: false,
             cell: null, ok: false, why: '', raf: 0,
             tid: touchId === undefined ? null : touchId,
             trayTop: dtTrayTop() };
  card.classList.add('lifted');
  if (typeof dcBuzz === 'function') dcBuzz(14);

  // Ловим на погружении: лоток гасит всплытие касаний, чтобы не двигать карту
  document.addEventListener('touchstart', dtDocStart, true);
  document.addEventListener('touchmove', dtDocMove, { passive: false, capture: true });
  document.addEventListener('touchend', dtDocEnd, true);
  document.addEventListener('touchcancel', dtDocCancel, true);

  // Пока несёшь, картинку предзагружаем для отрисовки на поле
  if (it.img && typeof getUnitImage === 'function') getUnitImage(it.img);
  dtDragMove(x, y);
  dtDrag.raf = requestAnimationFrame(dtEdgeTick);
}

// Палец, который несёт карточку. Мышью — любое касание не наше
function dtOwnTouch(list) {
  if (!dtDrag || !list) return null;
  for (var i = 0; i < list.length; i++) {
    if (dtDrag.tid !== null && list[i].identifier === dtDrag.tid) return list[i];
  }
  return null;
}

// Пока карточка в руке, карта других пальцев не слышит: ни щипка,
// ни выбора бойца вторым касанием
function dtDocStart(e) {
  if (!dtDrag) return;
  e.stopPropagation();
}

function dtDocMove(e) {
  if (!dtDrag) return;
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
  var t = dtOwnTouch(e.touches);
  if (t) dtDragMove(t.clientX, t.clientY);
}

function dtDocEnd(e) {
  if (!dtDrag) return;
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
  var t = dtOwnTouch(e.changedTouches);
  if (!t) return;                 // поднялся другой палец
  dtDragEnd(t.clientX, t.clientY);
}

function dtDocCancel(e) {
  if (!dtDrag) return;
  if (dtDrag.tid !== null && !dtOwnTouch(e.changedTouches)) return;
  dtCancelDrag();
}

// Верх лотка: ниже него — не карта, а сам лоток
function dtTrayTop() {
  if (dtDrag && dtDrag.trayTop !== undefined) return dtDrag.trayTop;   // за жест лоток не двигается
  var el = document.getElementById('dt-tray');
  return el ? el.getBoundingClientRect().top : window.innerHeight;
}

function dtDragMove(x, y) {
  var d = dtDrag;
  if (!d) return;
  d.cx = x; d.cy = y;

  var top = dtTrayTop();
  var overTray = y > top - 6;
  if (!overTray && y < top - 36) d.entered = true;
  d.ghost.classList.toggle('over-tray', overTray);
  d.ghost.classList.toggle('on-map', !overTray);

  if (overTray) {
    // Над лотком карточка висит над пальцем: видно, что её несут
    d.ghost.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y - 44) + 'px)';
    if (d.cell) { d.cell = null; d.ok = false; d.key = ''; redrawScene(); }
    if (typeof dcHideChip === 'function') dcHideChip();
    return;
  }
  // Над картой место показывает сама клетка под пальцем, а над ней —
  // подсказка; миниатюра уходит в сторону от пальца, чтобы не закрывать их
  var gx = x < 90 ? x + 46 : x - 46;
  d.ghost.style.transform = 'translate(' + Math.round(gx) + 'px,' + Math.round(y - 30) + 'px)';

  var c = gbClientCell(x, y);
  var it = d.it;
  // Корпус встаёт серединой под палец
  var cx = c.x - Math.floor((it.w - 1) / 2), cy = c.y - Math.floor((it.h - 1) / 2);
  // Клетка та же — карту не перерисовываем, двигаем только подсказку
  var key = cx + ':' + cy + ':' + dtPending.length + (d.occRef === unitsOnMap ? '' : '*');
  var same = key === d.key;
  if (!same) {
    d.key = key;
    d.cell = { x: cx, y: cy };
    d.why = dtWhy(it, cx, cy);
    d.ok = !d.why;
    d.ghost.classList.toggle('bad', !d.ok);
  }

  if (typeof dcChip === 'function') {
    if (d.ok) dcChip(x, y, 'Высадить сюда', it.name + ' · ' + cx + ':' + cy, 'move');
    else dcChip(x, y, d.why, it.kind === 'fighter' && !iAmAttacker ? 'садятся в зону высадки' : 'тяни в полосу вторжения', 'bad');
  }
  if (!same) redrawScene();
}

// Почему сюда нельзя (или null — можно)
function dtWhy(it, x, y) {
  if (x < 0 || y < 0 || x + it.w > GRID_SIZE || y + it.h > GRID_SIZE) return 'За краем карты';
  if (it.kind === 'fighter') {
    if (!fighterLandCellAllowed(x, y)) return iAmAttacker ? 'Вне полосы вторжения' : 'Вне зоны высадки';
  } else if (y < GRID_SIZE - ATTACK_ZONE_H) {
    return 'Вне полосы вторжения';
  }
  // Занятость считаем раз на свежую карту, а не на каждый сдвиг пальца
  var d = dtDrag;
  var occ;
  if (d && d.occ && d.occRef === unitsOnMap && d.occPend === dtPending.length) {
    occ = d.occ;
    return isBoxFree(occ, x, y, it.w, it.h) ? null : 'Место занято';
  }
  occ = buildOccupancy();
  dtPending.forEach(function(p) {
    for (var dx = 0; dx < p.w; dx++) for (var dy = 0; dy < p.h; dy++) occ[(p.x + dx) + ':' + (p.y + dy)] = true;
  });
  if (d) { d.occ = occ; d.occRef = unitsOnMap; d.occPend = dtPending.length; }
  if (!isBoxFree(occ, x, y, it.w, it.h)) return 'Место занято';
  return null;
}

// cancelDrop из ground-battle.js: режим тапов снят — лоток остаётся
function dtAfterCancel() {
  if (!dtOpen) return;
  dtSelKey = null;
  var el = document.getElementById('dt-tray');
  var btn = document.getElementById('drop-btn');
  if (btn) btn.style.visibility = 'hidden';
  dtRender();
  if (el) setBottomInset(dtInset(el));
}

// У края видимой части карта едет за пальцем — полоса шире экрана
function dtEdgeTick() {
  var d = dtDrag;
  if (!d) return;
  if (d.entered && typeof dcEdgeVelocity === 'function') {
    var r = viewport.getBoundingClientRect();
    var box = { left: r.left, top: r.top, right: r.right, bottom: Math.min(r.bottom, dtTrayTop()) };
    // Под лотком скорость не считаем: палец там — значит несут обратно
    if (d.cy < box.bottom) {
      var v = dcEdgeVelocity(box, d.cx, d.cy);
      if (v.x || v.y) {
        var px = panX, py = panY;
        panX += v.x; panY += v.y;
        clampPan();
        if (panX !== px || panY !== py) { applyTransform(); dtDragMove(d.cx, d.cy); }
      }
    }
  }
  d.raf = requestAnimationFrame(dtEdgeTick);
}

function dtDragEnd(x, y) {
  var d = dtDrag;
  if (!d) return;
  dtDragMove(x, y);
  var it = d.it, cell = d.cell, ok = d.ok, why = d.why;
  dtCancelDrag();

  if (!cell) return;          // отпустили над лотком — карточка вернулась
  if (!ok) {
    if (typeof dcFlash === 'function') dcFlash(x, y, why || 'Сюда нельзя', 'карточка вернулась в лоток', 'bad', 1600);
    return;
  }
  dtCommit(it, cell.x, cell.y, x, y);
}

function dtCancelDrag() {
  var d = dtDrag;
  if (!d) return;
  dtDrag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
  if (d.card) d.card.classList.remove('lifted');
  document.removeEventListener('touchstart', dtDocStart, true);
  document.removeEventListener('touchmove', dtDocMove, true);
  document.removeEventListener('touchend', dtDocEnd, true);
  document.removeEventListener('touchcancel', dtDocCancel, true);
  dtCardTouch = false;
  if (typeof dcHideChip === 'function') dcHideChip();
  if (dtDirty && dtOpen) dtRender();
  redrawScene();
}

// Тап по полосе, когда карточка выбрана тапом: те же проверки и та же
// отметка ожидания, что у броска, — без окон alert
function dtTapPlace(cx, cy, fx, fy) {
  var it = dtSelKey ? dtItemByKey(dtSelKey) : null;
  if (!it || !it.ready || dtLeft(it) <= 0) { dtSelect(null); return; }
  var x = cx - Math.floor((it.w - 1) / 2), y = cy - Math.floor((it.h - 1) / 2);
  var why = dtWhy(it, x, y);
  if (why) {
    if (typeof dcFlash === 'function') dcFlash(fx, fy, why, it.kind === 'fighter' && !iAmAttacker ? 'садятся в зону высадки' : 'ставь в полосу вторжения', 'bad', 1600);
    return;
  }
  dtCommit(it, x, y, fx, fy);
}

// Отпустили на свободной клетке: приказ серверу. Пока ждём ответ,
// место отмечено полупрозрачным бойцом — второй не ляжет поверх
function dtCommit(it, x, y, fx, fy) {
  var pend = { x: x, y: y, w: it.w, h: it.h, img: it.img, key: it.key };
  dtPending.push(pend);
  dtRefresh();
  redrawScene();

  var req;
  if (it.kind === 'unit') {
    req = supabase.rpc('unload_unit_at', { p_ship_id: it.src.ship_id, p_unit_type: it.src.unit_type, p_x: x, p_y: y });
  } else if (it.kind === 'vehicle') {
    req = supabase.rpc('unload_vehicle_at', { p_unit_id: it.src.unit_id, p_x: x, p_y: y });
  } else {
    req = supabase.rpc('land_fighter', { p_fighter_id: it.src.fighter_id, p_x: x, p_y: y });
  }

  var done = function() {
    var i = dtPending.indexOf(pend);
    if (i >= 0) dtPending.splice(i, 1);
    dtRefresh();
  };

  Promise.resolve(req).then(function(r) {
    if (r && r.error) {
      done();
      redrawScene();
      if (typeof dcFlash === 'function') dcFlash(fx, fy, 'Не вышло', r.error.message, 'bad', 2600);
      return;
    }
    if (typeof dcBuzz === 'function') dcBuzz(10);
    // Боец на земле: в счёт трюма он больше не входит (свежий трюм уже
    // без него), а отметка на поле держится до свежей карты — dtDraw
    // уберёт её сам, чтобы боец не мигнул
    pend.landed = true;
    pend.holdRef = dtHoldList(it.kind);
    loadUnits();
    pend.seq = loadUnitsSeq;      // отметка уйдёт с ответом именно этой загрузки
    loadDropCargo();
    setTimeout(function() { done(); redrawScene(); }, 5000);
  }, function(e) {
    done();
    redrawScene();
    if (typeof dcFlash === 'function') dcFlash(fx, fy, 'Не вышло', (e && e.message) || 'нет связи с сервером', 'bad', 2600);
  });
}

// ── Отрисовка на поле (из drawScene) ─────────────────────────────

function dtDraw() {
  if (!dtOpen) return;
  var y0 = GRID_SIZE - ATTACK_ZONE_H;

  // Полоса вторжения: мягкая заливка и рамка, пока лоток открыт
  if (!droppingUnit && !droppingVehicle && !landingFighter) {
    ctx.fillStyle = 'rgba(217,74,74,0.10)';
    ctx.fillRect(0, y0 * CELL_PX, GRID_SIZE * CELL_PX, ATTACK_ZONE_H * CELL_PX);
  }
  ctx.strokeStyle = 'rgba(217,74,74,0.75)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(1, y0 * CELL_PX + 1, GRID_SIZE * CELL_PX - 2, ATTACK_ZONE_H * CELL_PX - 2);
  ctx.setLineDash([]);

  // Ждут ответа сервера. Высаженные уходят, как только пришла свежая карта
  for (var i = dtPending.length - 1; i >= 0; i--) {
    if (dtPending[i].landed && loadUnitsApplied >= dtPending[i].seq) dtPending.splice(i, 1);
  }
  dtPending.forEach(function(p) { dtDrawBox(p.x, p.y, p.w, p.h, p.img, 'pending'); });

  // Карточка в руке
  var d = dtDrag;
  if (d && d.cell) dtDrawBox(d.cell.x, d.cell.y, d.it.w, d.it.h, d.it.img, d.ok ? 'ok' : 'bad', d.it);
}

function dtDrawBox(x, y, w, h, img, state, it) {
  var px = x * CELL_PX, py = y * CELL_PX, bw = w * CELL_PX, bh = h * CELL_PX;
  ctx.save();
  ctx.globalAlpha = state === 'pending' ? 0.55 : 0.85;
  ctx.fillStyle = state === 'bad' ? 'rgba(217,74,74,0.28)' : 'rgba(95,217,104,0.22)';
  ctx.fillRect(px + 2, py + 2, bw - 4, bh - 4);
  var im = img && typeof getUnitImage === 'function' ? getUnitImage(img) : null;
  if (im && im.complete && !im.failed && im.naturalWidth > 0 && state !== 'bad') {
    var type = it && it.kind === 'unit' ? unitTypeById[it.src.unit_type] : null;
    var cr = (it && it.kind === 'unit' && typeof gbUnitCrop === 'function')
      ? gbUnitCrop(im, type) : [0, 0, im.naturalWidth, im.naturalHeight];
    ctx.drawImage(im, cr[0], cr[1], cr[2], cr[3], px + 3, py + 3, bw - 6, bh - 6);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = state === 'bad' ? '#d94a4a' : state === 'pending' ? '#d9a940' : '#5fd968';
  ctx.lineWidth = 2;
  if (state === 'pending') ctx.setLineDash([4, 4]);
  ctx.strokeRect(px + 2, py + 2, bw - 4, bh - 4);
  ctx.setLineDash([]);
  ctx.restore();
}
