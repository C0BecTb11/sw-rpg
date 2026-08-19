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
    '<div id="sc-ap"><div id="sc-ap-dots"></div><div id="sc-ap-text"></div></div>' +
    '<div id="sc-actions">' +
      '<button class="sc-btn" id="sc-move">Ход</button>' +
      '<button class="sc-btn" id="sc-rotate">Разворот</button>' +
      '<button class="sc-btn sc-btn-ghost" id="sc-abilities" disabled>Способности</button>' +
    '</div>' +
    '<div id="sc-dial"></div>' +
    '<div id="sc-hint"></div>';

  document.body.appendChild(hud);

  document.getElementById('sc-close').addEventListener('click', scDeselect);
  document.getElementById('sc-move').addEventListener('click', function() {
    scSetMode(scMode === 'move' ? null : 'move');
  });
  document.getElementById('sc-rotate').addEventListener('click', function() {
    scSetMode(scMode === 'rotate' ? null : 'rotate');
  });

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
  scRenderAp();
  scRenderMode();
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
}

function scRenderMode() {
  var dial = document.getElementById('sc-dial');
  var hint = document.getElementById('sc-hint');
  var moveBtn = document.getElementById('sc-move');
  var rotBtn = document.getElementById('sc-rotate');
  if (!dial) return;

  dial.style.display = scMode === 'rotate' ? 'grid' : 'none';

  // Текущее положение подсвечиваем, чтобы было видно, куда смотрит нос
  var dirs = dial.querySelectorAll('.sc-dir');
  for (var i = 0; i < dirs.length; i++) {
    var isNow = scShip && parseInt(dirs[i].dataset.deg, 10) === (scShip.facing || 0);
    dirs[i].classList.toggle('current', !!isNow);
  }
  moveBtn.classList.toggle('active', scMode === 'move');
  rotBtn.classList.toggle('active', scMode === 'rotate');

  if (scMode === 'move') {
    hint.textContent = 'Коснись клетки, куда идти';
  } else if (scMode === 'rotate') {
    hint.textContent = 'Стрелка — направление носа';
  } else {
    hint.textContent = '';
  }

  scRenderRange();
}

// Полупрозрачный квадрат — куда можно дойти за один ход
function scRenderRange() {
  if (scRangeEl && scRangeEl.parentNode) scRangeEl.parentNode.removeChild(scRangeEl);
  scRangeEl = null;
  if (scMode !== 'move' || !scShip || !scType) return;

  var box = scBox(scType, scShip.facing);
  var r = scType.move_range;
  var el = document.createElement('div');
  el.className = 'sc-range';
  el.style.left = ((scShip.x - r) * CELL_PX) + 'px';
  el.style.top = ((scShip.y - r) * CELL_PX) + 'px';
  el.style.width = ((box.w + r * 2) * CELL_PX) + 'px';
  el.style.height = ((box.h + r * 2) * CELL_PX) + 'px';
  grid.appendChild(el);
  scRangeEl = el;
}

// ===== выбор корабля =====

function onOwnShipTapped(ship, type) {
  scShip = ship;
  scType = type;
  scMode = null;
  scRenderHud();
}

function scDeselect() {
  scShip = null;
  scType = null;
  scMode = null;
  var hud = document.getElementById('ship-hud');
  if (hud) hud.style.display = 'none';
  scRenderRange();
}

function scSetMode(mode) {
  scMode = mode;
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

function scDoMove(cx, cy) {
  if (!scShip || !scType) return;
  // Целимся центром корабля в выбранную клетку — так привычнее пальцем
  var box = scBox(scType, scShip.facing);
  var tx = cx - Math.floor(box.w / 2);
  var ty = cy - Math.floor(box.h / 2);

  scBusy(true);
  supabase.rpc('move_ship', {
    p_ship_id: scShip.id, p_x: tx, p_y: ty, p_facing: null
  }).then(function(res) {
    scBusy(false);
    if (res.error) { scFail(res.error.message); return; }
    scMode = null;
    loadShips();
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
    if (moved || scMode !== 'move') return;
    var rect = viewport.getBoundingClientRect();
    var gx = (e.clientX - rect.left - panX) / scale;
    var gy = (e.clientY - rect.top - panY) / scale;
    scDoMove(Math.floor(gx / CELL_PX), Math.floor(gy / CELL_PX));
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
