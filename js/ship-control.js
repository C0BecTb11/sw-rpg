// Управление кораблём: выбор, ход, разворот, очки действий.
//
// Всё, что здесь считается — только для отображения. Любое реальное
// изменение проходит через RPC move_ship / rotate_ship, а те проверяют
// владельца, дальность, занятость клеток и списывают действие по времени
// сервера. Подкрутить часы на телефоне и ускорить перезарядку нельзя:
// клиент вообще не передаёт время, а лишь показывает разницу с now()
// сервера, полученным через get_server_time.

var scShip = null;         // выбранный корабль
var scType = null;         // его тип
var scMode = null;         // null | 'move' | 'rotate'
var scTimeOffset = 0;      // серверное время минус локальное, мс
var scSettings = { cooldown: 30, apMax: 2 };
var scTicker = null;
var scRangeEl = null;
var scJustSelected = false;
var scGhostEl = null;
var scPreview = null;      // {x, y, dist} — куда встанет корабль

// Четыре положения: нос вверх, вправо, вниз, влево. Этого хватает,
// чтобы подставить врагу нос, корму или борт.
var SC_FACINGS = [
  { deg: 0,   label: '↑', name: 'носом вверх' },
  { deg: 90,  label: '→', name: 'носом вправо' },
  { deg: 180, label: '↓', name: 'носом вниз' },
  { deg: 270, label: '←', name: 'носом влево' }
];

// ===== служебное =====

function scServerNow() {
  return Date.now() + scTimeOffset;
}

function scSyncTime() {
  return supabase.rpc('get_server_time').then(function(res) {
    if (!res.error && res.data) {
      scTimeOffset = new Date(res.data).getTime() - Date.now();
    }
  });
}

function scLoadSettings() {
  return supabase.from('game_settings').select('key, value').then(function(res) {
    if (res.error || !res.data) return;
    res.data.forEach(function(row) {
      if (row.key === 'ship_action_cooldown_seconds') scSettings.cooldown = parseInt(row.value, 10) || 30;
      if (row.key === 'ship_action_max') scSettings.apMax = parseInt(row.value, 10) || 2;
    });
  });
}

// Габариты с учётом разворота — та же формула, что в ship_box_w/h на сервере
function scBox(type, facing) {
  return (facing === 90 || facing === 270)
    ? { w: type.height_cells, h: type.width_cells }
    : { w: type.width_cells, h: type.height_cells };
}

// Сколько действий накоплено прямо сейчас
function scApState(ship) {
  var cd = scSettings.cooldown;
  var max = scSettings.apMax;
  var elapsed = Math.floor((scServerNow() - new Date(ship.ap_updated_at).getTime()) / 1000);
  if (elapsed < 0) elapsed = 0;
  var ap = Math.min(max, (ship.ap || 0) + Math.floor(elapsed / cd));
  return {
    ap: ap,
    max: max,
    nextIn: ap >= max ? 0 : cd - (elapsed % cd)
  };
}

// ===== HUD =====

function scEnsureHud() {
  var hud = document.getElementById('ship-hud');
  if (hud) return hud;

  hud = document.createElement('div');
  hud.id = 'ship-hud';
  hud.style.display = 'none';
  hud.innerHTML =
    '<div id="sc-head">' +
      '<div><div id="sc-name">—</div><div id="sc-sub"></div></div>' +
      '<button id="sc-close">✕</button>' +
    '</div>' +
    '<div id="sc-bars"></div>' +
    '<div id="sc-cmd"></div>' +
    '<div id="sc-ap"><div id="sc-ap-dots"></div><div id="sc-ap-text"></div></div>' +
    '<div id="sc-actions">' +
      '<button class="sc-btn" id="sc-move">Ход</button>' +
      '<button class="sc-btn" id="sc-rotate">Разворот</button>' +
      '<button class="sc-btn" id="sc-attack">Атака</button>' +
    '</div>' +
    '<div id="sc-confirm">' +
      '<button class="sc-btn sc-btn-go" id="sc-go">Идти</button>' +
      '<button class="sc-btn" id="sc-cancel">Отмена</button>' +
    '</div>' +
    '<div id="sc-dial"></div>' +
    '<div id="sc-targets" style="display:none;"></div>' +
    '<div id="sc-hangar"></div>' +
    '<div id="sc-hint"></div>';

  document.body.appendChild(hud);

  document.getElementById('sc-close').addEventListener('click', scDeselect);
  document.getElementById('sc-move').addEventListener('click', function() {
    scSetMode(scMode === 'move' ? null : 'move');
  });
  document.getElementById('sc-rotate').addEventListener('click', function() {
    scSetMode(scMode === 'rotate' ? null : 'rotate');
  });
  document.getElementById('sc-attack').addEventListener('click', function() {
    scSetMode(scMode === 'attack' ? null : 'attack');
  });
  document.getElementById('sc-go').addEventListener('click', scConfirmMove);
  document.getElementById('sc-cancel').addEventListener('click', scCancelAim);

  var dial = document.getElementById('sc-dial');
  SC_FACINGS.forEach(function(f) {
    var b = document.createElement('button');
    b.className = 'sc-dir';
    b.dataset.deg = f.deg;
    b.textContent = f.label;
    b.title = f.name;
    b.addEventListener('click', function() { scDoRotate(f.deg); });
    dial.appendChild(b);
  });

  return hud;
}

function scRenderHud() {
  if (!scShip || !scType) return;
  var hud = scEnsureHud();
  hud.style.display = 'block';

  // Поднимаем карту над панелью, иначе половина клеток, куда можно пойти,
  // прячется под самим HUD
  if (typeof setBottomInset === 'function') {
    setTimeout(function() {
      setBottomInset(hud.offsetHeight + 12);
      // Карту доводим до корабля только при выборе. Иначе после каждого
      // выстрела экран прыгал обратно, потому что HUD перерисовывается
      // на каждом обновлении списка кораблей.
      if (!scJustSelected) return;
      scJustSelected = false;
      // Корабль должен остаться перед глазами вместе с зоной хода,
      // а не уехать под панель
      if (typeof focusCell === 'function' && scShip && scType) {
        var box = scBox(scType, scShip.facing);
        focusCell(scShip.x + box.w / 2, scShip.y + box.h / 2);
      }
    }, 0);
  }

  document.getElementById('sc-name').textContent = scType.name;
  document.getElementById('sc-sub').textContent =
    'позиция ' + scShip.x + ':' + scShip.y + ' · ход до ' + scType.move_range + ' кл.';

  // Корпус и четыре сектора щитов
  var maxShield = scType.max_shield || 0;
  var arcs = [
    { key: 'shield_fore', label: 'Нос' },
    { key: 'shield_starboard', label: 'Правый' },
    { key: 'shield_aft', label: 'Корма' },
    { key: 'shield_port', label: 'Левый' }
  ];

  var html = '<div class="sc-bar sc-bar-hull">' +
    '<span>Корпус</span>' +
    '<div class="sc-track"><i style="width:' +
      Math.max(0, Math.min(100, (scShip.hp / scType.max_hp) * 100)) + '%"></i></div>' +
    '<b>' + scShip.hp + '</b></div>';

  if (maxShield > 0) {
    html += '<div class="sc-arcs">';
    arcs.forEach(function(a) {
      var v = scShip[a.key];
      v = (v === null || v === undefined) ? 0 : v;
      var pct = Math.max(0, Math.min(100, (v / maxShield) * 100));
      html += '<div class="sc-arc' + (v === 0 ? ' down' : '') + '">' +
        '<span>' + a.label + '</span>' +
        '<div class="sc-track sc-track-shield"><i style="width:' + pct + '%"></i></div>' +
        '<b>' + v + '</b></div>';
    });
    html += '</div>';
  }

  document.getElementById('sc-bars').innerHTML = html;
  scRenderHangar();
  scRenderCommander();
  scRenderAp();
  scRenderMode();
}

// Командир нужен только для перелётов между планетами. Корабль без
// командира — это не забытый корабль, а гарнизон: он остаётся оборонять
// систему. Поэтому здесь нейтральная формулировка, а не предупреждение.
var scCommandersCache = null;

function scRenderCommander() {
  var box = document.getElementById('sc-cmd');
  if (!box || !scShip) return;

  box.innerHTML = '<div class="sc-cmd-title">Командир</div>' +
    '<div class="sc-cmd-state">…</div>';

  var fill = function(list) {
    var here = list.filter(function(c) {
      return c.unlocked && !c.moving_to && c.current_system === scShip.system_id;
    });

    var current = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === scShip.commander_id) { current = list[i]; break; }
    }

    box.innerHTML = '<div class="sc-cmd-title">Командир</div>';

    var state = document.createElement('div');
    state.className = 'sc-cmd-state' + (current ? ' assigned' : '');
    state.textContent = current
      ? 'ведёт ' + current.name + ' — уйдёт вместе с ним'
      : 'в обороне системы — остаётся на месте';
    box.appendChild(state);

    var sel = document.createElement('select');
    sel.className = 'sc-cmd-select';

    var none = document.createElement('option');
    none.value = '';
    none.textContent = '— оставить в обороне —';
    sel.appendChild(none);

    // Командир, который уже ведёт корабль, может быть не в этой системе
    // (например, флот ещё не догнал его) — держим его в списке, иначе
    // выбор молча сбросился бы
    if (current && here.indexOf(current) === -1) here.unshift(current);

    here.forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (scShip.commander_id === c.id) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.addEventListener('change', function() {
      sel.disabled = true;
      supabase.rpc('assign_ship', {
        p_ship_id: scShip.id,
        p_commander_id: sel.value || null
      }).then(function(r) {
        sel.disabled = false;
        if (r.error) { scFail(r.error.message); return; }
        loadShips();
      });
    });

    box.appendChild(sel);

    if (here.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'sc-cmd-hint';
      hint.textContent = 'Свободных командиров в этой системе нет';
      box.appendChild(hint);
    }
  };

  if (scCommandersCache) { fill(scCommandersCache); return; }

  supabase.from('commanders').select('*').eq('user_id', currentUserId)
    .then(function(res) {
      scCommandersCache = res.error ? [] : (res.data || []);
      fill(scCommandersCache);
    });
}

// ===== Ангар =====
// Истребители в ангаре и на карте — это один и тот же корабль, просто
// в разных состояниях. Выпуск и посадка меняют состояние, а не создают
// новую сущность, поэтому прочность и повреждения сохраняются.

var scHangarMode = null;   // null | 'launch' | 'land'
var scHangarPick = null;   // выбранный истребитель

function scRenderHangar() {
  var box = document.getElementById('sc-hangar');
  if (!box || !scShip || !scType) return;

  // Ангар есть не у всех, и это нормально
  if (!scType.hangar_slots) {
    box.innerHTML = '';
    box.style.display = 'none';
    if (scType.is_fighter) scRenderFighterActions(box);
    return;
  }

  box.style.display = 'block';

  supabase.rpc('get_hangar', { p_ship_id: scShip.id }).then(function(res) {
    if (!scShip) return;
    var list = (!res.error && res.data) ? res.data : [];

    var html = '<div class="sc-hangar-head">Ангар · ' +
      list.length + ' из ' + scType.hangar_slots + '</div>';
    box.innerHTML = html;

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'sc-hangar-empty';
      empty.textContent = 'Пусто';
      box.appendChild(empty);
      return;
    }

    list.forEach(function(f) {
      var hpPct = f.max_hp ? Math.max(0, f.hp / f.max_hp * 100) : 100;

      var row = document.createElement('div');
      row.className = 'sc-hangar-row';
      row.innerHTML =
        '<div class="sc-hangar-line"><span>' + f.name + '</span>' +
        '<em>' + f.hp + '/' + f.max_hp + '</em></div>' +
        '<div class="sc-hangar-track"><i style="width:' + hpPct + '%"></i></div>';

      var acts = document.createElement('div');
      acts.className = 'sc-hangar-acts';

      var launch = document.createElement('button');
      launch.className = 'sc-hangar-btn';
      launch.textContent = 'Выпустить';
      launch.addEventListener('click', function() { scStartLaunch(f); });
      acts.appendChild(launch);

      var land = document.createElement('button');
      land.className = 'sc-hangar-btn';
      land.textContent = 'На грунт';
      land.addEventListener('click', function() { scStartLand(f); });
      acts.appendChild(land);

      row.appendChild(acts);
      box.appendChild(row);
    });
  });
}

// Истребитель, уже вылетевший: ему нужна кнопка возврата
function scRenderFighterActions(box) {
  box.style.display = 'block';
  box.innerHTML = '<div class="sc-hangar-head">Носитель</div>';

  var b = document.createElement('button');
  b.className = 'sc-hangar-btn wide';
  b.textContent = 'Вернуться в ангар';
  b.addEventListener('click', scRecallToCarrier);
  box.appendChild(b);
}

function scStartLaunch(f) {
  scHangarPick = f;
  scHangarMode = 'launch';
  scSetMode(null);

  var hint = document.getElementById('sc-hint');
  hint.textContent = 'Коснись клетки рядом с носителем';
}

function scStartLand(f) {
  scHangarPick = f;
  scHangarMode = 'land';
  scSetMode(null);

  var hint = document.getElementById('sc-hint');
  hint.textContent = 'Посадка идёт на наземной карте — открой её и выбери клетку';
}

// Возврат в ангар ближайшего своего носителя со свободным местом
function scRecallToCarrier() {
  if (!scShip) return;

  var carrier = null;
  for (var i = 0; i < shipsInSystem.length; i++) {
    var c = shipsInSystem[i];
    if (c.owner_user_id !== currentUserId) continue;
    var ct = shipTypeById[c.ship_type];
    if (!ct || !ct.hangar_slots) continue;
    carrier = c;
    break;
  }

  if (!carrier) { scFail('Рядом нет носителя с ангаром'); return; }

  supabase.rpc('recall_fighter', {
    p_fighter_id: scShip.id, p_carrier_id: carrier.id
  }).then(function(r) {
    if (r.error) { scFail(r.error.message); return; }
    scDeselect();
    loadShips();
  });
}

function scRenderAp() {
  if (!scShip) return;
  var st = scApState(scShip);
  var dots = document.getElementById('sc-ap-dots');
  var text = document.getElementById('sc-ap-text');
  if (!dots || !text) return;

  var html = '';
  for (var i = 0; i < st.max; i++) {
    html += '<i class="sc-dot' + (i < st.ap ? ' on' : '') + '"></i>';
  }
  dots.innerHTML = html;

  text.textContent = st.ap >= st.max
    ? 'действия готовы'
    : '+1 через ' + st.nextIn + ' с';

  document.getElementById('sc-move').disabled = st.ap < 1;
  document.getElementById('sc-rotate').disabled = st.ap < 1;
  document.getElementById('sc-attack').disabled = st.ap < 1;
}

function scRenderMode() {
  var dial = document.getElementById('sc-dial');
  var hint = document.getElementById('sc-hint');
  var moveBtn = document.getElementById('sc-move');
  var rotBtn = document.getElementById('sc-rotate');
  if (!dial) return;

  var targets = document.getElementById('sc-targets');
  if (targets) targets.style.display = scMode === 'attack' ? 'block' : 'none';
  if (scMode === 'attack') scLoadTargets();

  dial.style.display = scMode === 'rotate' ? 'grid' : 'none';

  // Текущее положение подсвечиваем, чтобы было видно, куда смотрит нос
  var dirs = dial.querySelectorAll('.sc-dir');
  for (var i = 0; i < dirs.length; i++) {
    var isNow = scShip && parseInt(dirs[i].dataset.deg, 10) === (scShip.facing || 0);
    dirs[i].classList.toggle('current', !!isNow);
  }
  moveBtn.classList.toggle('active', scMode === 'move');
  rotBtn.classList.toggle('active', scMode === 'rotate');

  var confirmBox = document.getElementById('sc-confirm');
  confirmBox.style.display = (scMode === 'move' && scPreview) ? 'flex' : 'none';
  document.getElementById('sc-actions').style.display =
    (scMode === 'move' && scPreview) ? 'none' : 'flex';

  document.getElementById('sc-attack').classList.toggle('active', scMode === 'attack');

  if (scMode !== 'attack' && scTargets.length) {
    scTargets = [];
    if (typeof renderShips === 'function') renderShips();
  }

  if (scMode === 'attack') {
    hint.textContent = 'Ткни в цель на карте или выбери из списка';
  } else if (scMode === 'move' && scPreview) {
    hint.textContent = 'Пройдёт ' + scPreview.dist + ' из ' + scType.move_range +
      ' кл. · можно ткнуть в другую клетку';
  } else if (scMode === 'move') {
    hint.textContent = 'Коснись клетки — корабль встанет на неё серединой';
  } else if (scMode === 'rotate') {
    hint.textContent = 'Стрелка — направление носа';
  } else {
    hint.textContent = '';
  }

  scRenderRange();
}

// Якорь корабля — клетка, в которую игрок целится пальцем.
// Совпадает с тем, как сервер считает дальность, поэтому нарисованная
// зона и реальная всегда совпадают.
function scAnchor(ship, type) {
  var box = scBox(type, ship.facing);
  return {
    x: ship.x + Math.floor(box.w / 2),
    y: ship.y + Math.floor(box.h / 2)
  };
}

// Зона хода — множество клеток, куда можно поставить якорь.
// Раньше я рисовал габарит корабля, раздутый на дальность: выглядело
// щедрее, чем есть, и тап у края давал «слишком далеко».
function scRenderRange() {
  if (scRangeEl && scRangeEl.parentNode) scRangeEl.parentNode.removeChild(scRangeEl);
  scRangeEl = null;
  if (scMode !== 'move' || !scShip || !scType) return;

  var a = scAnchor(scShip, scType);
  var r = scType.move_range;

  var el = document.createElement('div');
  el.className = 'sc-range';
  el.style.left = ((a.x - r) * CELL_PX) + 'px';
  el.style.top = ((a.y - r) * CELL_PX) + 'px';
  el.style.width = ((r * 2 + 1) * CELL_PX) + 'px';
  el.style.height = ((r * 2 + 1) * CELL_PX) + 'px';
  grid.appendChild(el);
  scRangeEl = el;
}

// Призрак: корабль в натуральную величину на будущем месте.
// С крупной посудиной без него приходится угадывать, какой угол
// куда встанет.
function scRenderGhost() {
  if (scGhostEl && scGhostEl.parentNode) scGhostEl.parentNode.removeChild(scGhostEl);
  scGhostEl = null;
  if (!scPreview || !scShip || !scType) return;

  var box = scBox(scType, scShip.facing);

  var el = document.createElement('div');
  el.className = 'sc-ghost';
  el.style.left = (scPreview.x * CELL_PX) + 'px';
  el.style.top = (scPreview.y * CELL_PX) + 'px';
  el.style.width = (box.w * CELL_PX) + 'px';
  el.style.height = (box.h * CELL_PX) + 'px';

  if (scType.image) {
    var im = document.createElement('img');
    im.src = '../' + scType.image;
    im.style.width = (scType.width_cells * CELL_PX) + 'px';
    im.style.height = (scType.height_cells * CELL_PX) + 'px';
    im.style.position = 'absolute';
    im.style.left = '50%';
    im.style.top = '50%';
    im.style.transform = 'translate(-50%, -50%) rotate(' + (scShip.facing || 0) + 'deg)';
    el.appendChild(im);
  }

  grid.appendChild(el);
  scGhostEl = el;
}

// ===== выбор корабля =====

function onOwnShipTapped(ship, type) {
  scJustSelected = (!scShip || scShip.id !== ship.id);
  scShip = ship;
  scType = type;
  scMode = null;
  scRenderHud();
}

function scDeselect() {
  scShip = null;
  scType = null;
  scMode = null;
  scPreview = null;
  scRenderGhost();
  var hud = document.getElementById('ship-hud');
  if (hud) hud.style.display = 'none';
  if (typeof setBottomInset === 'function') setBottomInset(0);
  scRenderRange();
}

function scSetMode(mode) {
  scMode = mode;
  if (mode !== 'move') scPreview = null;
  scRenderGhost();
  scRenderMode();
}

// После перезагрузки списка кораблей обновляем выбранный
function onShipsReloaded() {
  if (!scShip) return;
  var fresh = null;
  for (var i = 0; i < shipsInSystem.length; i++) {
    if (shipsInSystem[i].id === scShip.id) { fresh = shipsInSystem[i]; break; }
  }
  if (!fresh) { scDeselect(); return; }
  scShip = fresh;
  scRenderHud();
}

// ===== действия =====

function scBusy(on) {
  ['sc-move', 'sc-rotate'].forEach(function(id) {
    var b = document.getElementById(id);
    if (b) b.disabled = on;
  });
}

function scDoRotate(deg) {
  if (!scShip || deg === scShip.facing) return;
  scBusy(true);
  supabase.rpc('rotate_ship', { p_ship_id: scShip.id, p_facing: deg }).then(function(res) {
    scBusy(false);
    if (res.error) { scFail(res.error.message); return; }
    scMode = null;
    loadShips();
  });
}

// Тап не ходит сразу, а ставит призрака. Ход стоит действия, которое
// копится 30 секунд, — промахнуться пальцем и потерять его обидно.
function scAimAt(cx, cy) {
  if (!scShip || !scType) return;

  var a = scAnchor(scShip, scType);
  var r = scType.move_range;

  // Тап за пределом дальности не отбрасываем, а прижимаем к пределу:
  // игрок хотел «туда, максимально далеко», и получает ровно это,
  // а не ошибку и не ход на клетку короче
  var ax = Math.max(a.x - r, Math.min(a.x + r, cx));
  var ay = Math.max(a.y - r, Math.min(a.y + r, cy));

  var box = scBox(scType, scShip.facing);
  var tx = ax - Math.floor(box.w / 2);
  var ty = ay - Math.floor(box.h / 2);

  // Корпус не должен свеситься за край карты
  tx = Math.max(0, Math.min(tx, GRID_CELLS - box.w));
  ty = Math.max(0, Math.min(ty, GRID_CELLS - box.h));

  scPreview = {
    x: tx,
    y: ty,
    dist: Math.max(Math.abs(tx - scShip.x), Math.abs(ty - scShip.y))
  };

  scRenderGhost();
  scRenderMode();
}

function scConfirmMove() {
  if (!scPreview) return;
  var target = scPreview;

  scBusy(true);
  supabase.rpc('move_ship', {
    p_ship_id: scShip.id, p_x: target.x, p_y: target.y, p_facing: null
  }).then(function(res) {
    scBusy(false);
    if (res.error) { scFail(res.error.message); return; }
    scCancelAim();
    scMode = null;
    loadShips();
  });
}

function scCancelAim() {
  scPreview = null;
  scRenderGhost();
  scRenderMode();
}

// Цели в радиусе. Список считает сервер: он же проверяет туман войны,
// поэтому подсмотреть невидимого противника через этот список нельзя.
// Цели, до которых этот корабль дотягивается. Держим отдельно, чтобы
// отрисовка карты могла подсветить их, а тап — сразу выстрелить.
var scTargets = [];

function scIsTargetable(shipId) {
  if (scMode !== 'attack') return false;
  for (var i = 0; i < scTargets.length; i++) {
    if (scTargets[i].target_id === shipId) return true;
  }
  return false;
}

// Тап по чужому кораблю в режиме атаки. Возвращает true, если выстрел
// начат — тогда карта не открывает карточку корабля.
function scTryAttackByTap(ship) {
  if (scMode !== 'attack' || !scShip) return false;

  var target = null;
  for (var i = 0; i < scTargets.length; i++) {
    if (scTargets[i].target_id === ship.id) { target = scTargets[i]; break; }
  }

  if (!target) {
    // Цель видно, но дотянуться нечем — объясняем, а не молчим
    scFail('Цель вне досягаемости этого корабля');
    return true;
  }

  scDoAttack(target, null);
  return true;
}

function scLoadTargets() {
  var box = document.getElementById('sc-targets');
  if (!box || !scShip) return;

  box.innerHTML = '<div class="sc-targets-empty">Ищем цели…</div>';

  supabase.rpc('get_attack_targets', { p_ship_id: scShip.id }).then(function(res) {
    if (scMode !== 'attack') return;

    scTargets = (res.error || !res.data) ? [] : res.data;
    if (typeof renderShips === 'function') renderShips();

    if (!scTargets.length) {
      box.innerHTML = '<div class="sc-targets-empty">В радиусе никого</div>';
      return;
    }

    box.innerHTML = '';
    res.data.forEach(function(t) {
      var hpPct = t.max_hp ? Math.max(0, t.hp / t.max_hp * 100) : 100;

      var b = document.createElement('button');
      b.className = 'sc-target';
      b.innerHTML =
        '<div class="sc-target-line">' +
          '<span>' + t.ship_name + ' <b>' + t.x + ':' + t.y + '</b></span>' +
          '<em>' + t.chance + '%</em>' +
        '</div>' +
        '<div class="sc-target-track"><i style="width:' + hpPct + '%"></i></div>' +
        '<div class="sc-target-sub">дистанция ' + t.gap + ' · корпус ' + t.hp + '</div>';

      b.addEventListener('click', function() { scDoAttack(t, b); });
      box.appendChild(b);
    });
  });
}

var SC_ARCS = { fore: 'в нос', aft: 'в корму', port: 'в левый борт', starboard: 'в правый борт' };

// Сводка боя сверху экрана: три строки максимум, каждая живёт восемь
// секунд. Это подсказка «что сейчас произошло», а не журнал.
function scLog(kind, title, details) {
  var box = document.getElementById('combat-log');
  if (!box) return;

  var line = document.createElement('div');
  line.className = 'clog ' + kind;
  line.innerHTML = '<span class="clog-title">' + title + '</span>' +
    (details ? '<span class="clog-details">' + details + '</span>' : '');

  box.insertBefore(line, box.firstChild);
  while (box.children.length > 3) box.removeChild(box.lastChild);

  setTimeout(function() {
    line.classList.add('fading');
    setTimeout(function() {
      if (line.parentNode) line.parentNode.removeChild(line);
    }, 600);
  }, 8000);
}

function scDoAttack(target, btn) {
  if (btn) btn.disabled = true;

  supabase.rpc('attack_ship', {
    p_attacker_id: scShip.id, p_target_id: target.target_id
  }).then(function(res) {
    if (res.error) { scFail(res.error.message); if (btn) btn.disabled = false; return; }

    var r = (res.data && res.data.length) ? res.data[0] : null;
    var hint = document.getElementById('sc-hint');

    if (!r) { loadShips(); return; }

    var me = scType.name;
    var arc = SC_ARCS[r.arc] || '';

    if (!r.hit) {
      hint.textContent = 'Промах по ' + target.ship_name;
      scLog('miss', 'Промах по ' + target.ship_name, 'шанс был ' + target.chance + '%');
    } else if (r.destroyed) {
      hint.textContent = target.ship_name + ' уничтожен';
      scLog('kill', target.ship_name + ' уничтожен', me + ' · ' + arc + ' · −' + r.damage);
    } else {
      // Сколько дошло до корпуса — разница прочности до и после.
      // Без этого не понять, пробил ты щит или он всё удержал.
      var byHull = Math.max(0, target.hp - r.target_hp);

      hint.textContent = 'Попадание ' + arc +
        ' · щит ' + r.shield_left + ' · корпус ' + r.target_hp;

      scLog(byHull > 0 ? 'hull' : 'shield',
            me + ' → ' + target.ship_name + ' · ' + arc,
            '−' + r.damage + (byHull > 0 ? ' (по корпусу ' + byHull + ')' : ' весь в щит') +
            ' · щит ' + r.shield_left + ' · корпус ' + r.target_hp);
    }

    loadShips();
    // Список целей мог измениться: кто-то погиб, кто-то вышел из радиуса
    if (scMode === 'attack') scLoadTargets();
  });
}

function scFail(msg) {
  var hint = document.getElementById('sc-hint');
  if (!hint) return;
  hint.textContent = msg;
  hint.classList.add('error');
  setTimeout(function() {
    hint.classList.remove('error');
    scRenderMode();
  }, 2500);
}

// ===== тап по полю =====

function scInitFieldTap() {
  var downX = 0, downY = 0, moved = false;

  viewport.addEventListener('pointerdown', function(e) {
    downX = e.clientX; downY = e.clientY; moved = false;
  });

  viewport.addEventListener('pointermove', function(e) {
    if (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8) moved = true;
  });

  viewport.addEventListener('click', function(e) {
    if (moved) return;

    if (scHangarMode === 'launch' && scHangarPick) {
      var rect0 = viewport.getBoundingClientRect();
      var lx = Math.floor(((e.clientX - rect0.left - panX) / scale) / CELL_PX);
      var ly = Math.floor(((e.clientY - rect0.top - panY) / scale) / CELL_PX);

      supabase.rpc('launch_fighter', {
        p_fighter_id: scHangarPick.fighter_id, p_x: lx, p_y: ly
      }).then(function(r) {
        if (r.error) { scFail(r.error.message); return; }
        scHangarMode = null; scHangarPick = null;
        loadShips();
        if (scShip) scRenderHangar();
      });
      return;
    }

    if (scMode !== 'move') return;
    var rect = viewport.getBoundingClientRect();
    var gx = (e.clientX - rect.left - panX) / scale;
    var gy = (e.clientY - rect.top - panY) / scale;
    scAimAt(Math.floor(gx / CELL_PX), Math.floor(gy / CELL_PX));
  });
}

document.addEventListener('DOMContentLoaded', function() {
  Promise.all([scSyncTime(), scLoadSettings()]).then(function() {
    scInitFieldTap();
    // Пересчёт перезарядки раз в секунду — считаем от серверного времени,
    // поэтому лишних запросов к базе не нужно
    scTicker = setInterval(function() {
      if (scShip) scRenderAp();
    }, 1000);
  });
});
