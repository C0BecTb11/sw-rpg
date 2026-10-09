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
var scSettings = { cooldown: 30, apMax: 2, shieldRegenSec: 30 };
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
      if (row.key === 'shield_regen_seconds') scSettings.shieldRegenSec = parseInt(row.value, 10) || 30;
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
  // Устройство то же, что у наземной панели: портрет с характеристиками
  // сверху, вкладки снизу. Космос отличается щитами по секторам и ангаром,
  // поэтому им отведены свои вкладки, а не общий список.
  hud.innerHTML =
    '<div class="sc-top">' +
      '<div class="sc-portrait"><img id="sc-portrait-img" alt=""></div>' +
      '<div class="sc-stats">' +
        '<div class="sc-name" id="sc-name">—</div>' +
        '<div class="sc-role" id="sc-sub"></div>' +
        '<div class="sc-hp">' +
          '<span class="sc-hp-num" id="sc-hp-num"></span>' +
          '<div class="sc-hp-track"><i id="sc-hp-fill"></i></div>' +
        '</div>' +
        '<div class="sc-props" id="sc-props"></div>' +
      '</div>' +
      '<button class="sc-close" id="sc-close">✕</button>' +
    '</div>' +

    '<div class="sc-ap-row" id="sc-ap">' +
      '<div class="sc-dots" id="sc-ap-dots"></div>' +
      '<div class="sc-ap-text" id="sc-ap-text"></div>' +
    '</div>' +

    '<div class="sc-tabs" id="sc-tabs"></div>' +
    '<div class="sc-panel">' +
      '<div id="sc-tab-actions">' +
        '<div class="sc-abils">' +
          '<div class="sc-tiles" id="sc-tiles"></div>' +
          '<div class="sc-abil-info" id="sc-abil-info"></div>' +
        '</div>' +
        '<div id="sc-confirm">' +
          '<button class="sc-btn sc-btn-go" id="sc-go">Идти</button>' +
          '<button class="sc-btn" id="sc-cancel">Отмена</button>' +
        '</div>' +
        '<div id="sc-dial"></div>' +
        '<div id="sc-targets"></div>' +
      '</div>' +
      '<div id="sc-tab-shields"></div>' +
      '<div id="sc-tab-cargo"></div>' +
      '<div id="sc-tab-hangar"><div id="sc-hangar"></div></div>' +
      '<div id="sc-tab-info"><div id="sc-cmd"></div><div class="sc-desc" id="sc-desc"></div></div>' +
    '</div>' +
    '<div id="sc-hint"></div>' +
    '<div id="sc-bars" style="display:none;"></div>';

  document.body.appendChild(hud);

  document.getElementById('sc-close').addEventListener('click', scDeselect);
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

  var role = scType.is_fighter
    ? (scType.hull_class === 'bomber' ? 'Бомбардировщик' : 'Истребитель')
    : (scType.hull_class === 'corvette' ? 'Корвет' : 'Крупный корабль');

  document.getElementById('sc-sub').textContent =
    role + ' · ' + scShip.x + ':' + scShip.y;

  var img = document.getElementById('sc-portrait-img');
  if (img && scType.image) img.src = '../' + scType.image;

  var hpMaxOwn = (scType.max_hp || scShip.hp) + (scShip.bonus_hp || 0);
  var hpPct = Math.max(0, Math.min(100, (scShip.hp / hpMaxOwn) * 100));
  document.getElementById('sc-hp-num').textContent = scShip.hp + ' / ' + hpMaxOwn;
  document.getElementById('sc-hp-fill').style.width = hpPct + '%';

  document.getElementById('sc-props').innerHTML =
    '<span title="урон">◎ ' + (scType.damage || 0) + '</span>' +
    '<span title="дальность огня">➶ ' + (scType.weapon_range || 0) + '</span>' +
    '<span title="ход">⇢ ' + (scType.move_range || 0) + '</span>' +
    '<span title="обзор">◈ ' + (scType.vision_range || 0) + '</span>';

  scRenderTabs();

  // Корпус и четыре сектора щитов. В базе лежит значение на момент
  // последнего удара, а щит с тех пор подрос — считаем как сервер
  var realSh = sxShields(scShip, scType);
  var maxShield = realSh.max;
  var arcs = [
    { key: 'shield_fore', label: 'Нос' },
    { key: 'shield_starboard', label: 'Правый' },
    { key: 'shield_aft', label: 'Корма' },
    { key: 'shield_port', label: 'Левый' }
  ];

  var html = '<div class="sc-bar sc-bar-hull">' +
    '<span>Корпус</span>' +
    '<div class="sc-track"><i style="width:' +
      Math.max(0, Math.min(100, (scShip.hp / hpMaxOwn) * 100)) + '%"></i></div>' +
    '<b>' + scShip.hp + '</b></div>';

  if (maxShield > 0) {
    html += '<div class="sc-arcs">';
    arcs.forEach(function(a) {
      var v = realSh[a.key];
      var pct = Math.max(0, Math.min(100, (v / (a.key === 'shield_fore' ? realSh.maxFore : maxShield)) * 100));
      html += '<div class="sc-arc' + (v === 0 ? ' down' : '') + '">' +
        '<span>' + a.label + '</span>' +
        '<div class="sc-track sc-track-shield"><i style="width:' + pct + '%"></i></div>' +
        '<b>' + v + '</b></div>';
    });
    html += '</div>';
  }

  document.getElementById('sc-tab-shields').innerHTML = html;

  var desc = document.getElementById('sc-desc');
  if (desc) desc.textContent = scType.description || 'Описание пока не заполнено';

  scRenderCommander();
  scRenderAp();
  scRenderMode();
}

// ===== Вкладки =====
// Щиты и ангар вынесены отдельно: держать их на виду постоянно значит
// закрывать карту, на которую надо тыкать при ходе и атаке.
var scTab = 'actions';

function scRenderTabs() {
  var box = document.getElementById('sc-tabs');
  if (!box) return;

  var tabs = [{ id: 'actions', label: 'Действия' }];

  if ((scType.max_shield || 0) > 0) tabs.push({ id: 'shields', label: 'Щиты' });
  // Трюм только у тех, кто возит: у истребителя вместимость ноль
  if ((scType.capacity || 0) > 0) tabs.push({ id: 'cargo', label: 'Трюм' });
  // Ангар только у носителей. Истребителю он не нужен: возвращаться
  // он умеет, но это действие, а не помещение — ему место среди плиток.
  if (scType.hangar_slots > 0) tabs.push({ id: 'hangar', label: 'Ангар' });
  tabs.push({ id: 'info', label: 'Описание' });

  // Вкладка могла исчезнуть при смене корабля — тогда возвращаемся к действиям
  if (!tabs.some(function(t) { return t.id === scTab; })) scTab = 'actions';

  box.innerHTML = '';
  tabs.forEach(function(t) {
    var b = document.createElement('button');
    b.className = 'sc-tab' + (scTab === t.id ? ' active' : '');
    b.setAttribute('data-tab', t.id);
    b.textContent = t.label;
    b.addEventListener('click', function() {
      scTab = t.id;
      if (t.id !== 'actions') scSetMode(null);
      scRenderTabs();
      scApplyTab();
      if (t.id === 'hangar') scRenderHangar();
      if (t.id === 'cargo') scRenderCargo();
    });
    box.appendChild(b);
  });

  scApplyTab();
}

function scApplyTab() {
  ['actions', 'shields', 'cargo', 'hangar', 'info'].forEach(function(id) {
    var el = document.getElementById('sc-tab-' + id);
    if (el) el.style.display = (scTab === id) ? 'block' : 'none';
  });
}

// Плитки действий: ход, разворот, атака. Справа — пояснение выбранного,
// чтобы игрок понимал последствие до нажатия.
// Трюм: пехота лежит счётчиком, техника отдельными строками. Показываем
// обе части и даём высадить прямо отсюда. На своей планете место подбирает
// сервер, при вторжении высадка идёт поштучно с наземной карты.
function scRenderCargo() {
  var box = document.getElementById('sc-tab-cargo');
  if (!box || !scShip) return;

  var forShip = scShip.id;
  box.innerHTML = '<div class="sc-hangar-head">Трюм</div>' +
                  '<div class="sc-hangar-empty">Загрузка…</div>';

  Promise.all([
    supabase.rpc('get_ship_holds'),
    supabase.rpc('get_carried_units', { p_carrier_unit_id: null, p_ship_id: forShip }),
    // Ресурсы делят тот же трюм: без них полный грузом корабль
    // показывался здесь пустым, а в «Армии» — забитым
    supabase.rpc('get_ship_resource_cargo', { p_ship_id: forShip }),
    scResourceColors()
  ]).then(function(r) {
    if (!scShip || scShip.id !== forShip || scTab !== 'cargo') return;

    var holds = (!r[0].error && r[0].data) ? r[0].data : [];
    var mine = holds.filter(function(h) { return h.ship_id === forShip && !h.is_vehicle; });
    var vehicles = (!r[1].error && r[1].data) ? r[1].data : [];
    var goods = (!r[2].error && r[2].data) ? r[2].data : [];

    var used = 0;
    holds.forEach(function(h) { if (h.ship_id === forShip) used += (h.slots || 0); });
    goods.forEach(function(g) { used += (g.slots || 0); });

    var cap = scType.capacity || 0;
    box.innerHTML = '<div class="sc-hangar-head">Трюм · ' +
      '<span class="' + (cap && used >= cap ? 'sc-cargo-full' : '') + '">' +
      used + ' из ' + cap + '</span></div>';

    if (!mine.length && !vehicles.length && !goods.length) {
      var empty = document.createElement('div');
      empty.className = 'sc-hangar-empty';
      empty.textContent = 'Пусто';
      box.appendChild(empty);
      return;
    }

    vehicles.forEach(function(v) {
      var row = document.createElement('div');
      row.className = 'sc-hangar-row';
      row.innerHTML = '<div class="sc-hangar-line"><span>' + v.unit_name +
        (v.passengers ? ' · десант ' + v.passengers : '') + '</span>' +
        '<em>' + v.slots + ' сл.</em></div>';

      var b = document.createElement('button');
      b.className = 'sc-hangar-btn wide';
      b.textContent = 'Высадить';
      b.addEventListener('click', function() {
        b.disabled = true;
        supabase.rpc('unload_vehicle_auto', { p_unit_id: v.unit_id }).then(function(res) {
          if (res.error) { scFail(res.error.message); b.disabled = false; return; }
          scRenderCargo();
          loadShips();
        });
      });
      row.appendChild(b);
      box.appendChild(row);
    });

    mine.forEach(function(h) {
      var row = document.createElement('div');
      row.className = 'sc-hangar-row';
      row.innerHTML = '<div class="sc-hangar-line"><span>' + h.unit_name + '</span>' +
        '<em>×' + h.quantity + '</em></div>';

      var acts = document.createElement('div');
      acts.className = 'sc-hangar-acts';

      [1, 5].forEach(function(n) {
        if (n > h.quantity) return;
        var b = document.createElement('button');
        b.className = 'sc-hangar-btn';
        b.textContent = 'Высадить ' + n;
        b.addEventListener('click', function() {
          b.disabled = true;
          supabase.rpc('unload_from_ship', {
            p_ship_id: forShip, p_unit_type: h.unit_type, p_quantity: n
          }).then(function(res) {
            if (res.error) { scFail(res.error.message); b.disabled = false; return; }
            scRenderCargo();
            loadShips();
          });
        });
        acts.appendChild(b);
      });

      row.appendChild(acts);
      box.appendChild(row);
    });

    if (mine.length || vehicles.length) {
      var note = document.createElement('div');
      note.className = 'sc-hangar-empty';
      note.textContent = 'На чужой планете высадка идёт поштучно с наземной карты';
      box.appendChild(note);
    }

    if (goods.length) scRenderCargoGoods(box, forShip, goods, r[3] || {});
  });
}

// Цвета ресурсов нужны только для полоски у строки груза — спрашиваем
// один раз за страницу
var scResColors = null;
function scResourceColors() {
  if (scResColors) return Promise.resolve(scResColors);
  return supabase.from('resources').select('id, color').then(function(res) {
    var map = {};
    (res.data || []).forEach(function(x) { map[x.id] = x.color; });
    if (!res.error) scResColors = map;
    return map;
  });
}

// Груз выгружается на склад планеты, над которой стоит корабль. Правила
// (своя сторона, место на складе) проверяет сервер — его ответ показываем
// прямо в трюме, а не в подсказке над плитками, которой тут не видно.
function scRenderCargoGoods(box, forShip, goods, colors) {
  var head = document.createElement('div');
  head.className = 'sc-hangar-head sc-cargo-sub';
  head.textContent = 'Груз · выгрузить на склад';
  box.appendChild(head);

  var err = document.createElement('div');
  err.className = 'sc-cargo-err';
  err.style.display = 'none';
  box.appendChild(err);

  // Строка груза короткая: название и объём слева, кнопки справа.
  // Семь ресурсов в полный рост растягивали панель на два экрана.
  goods.forEach(function(g) {
    var row = document.createElement('div');
    row.className = 'sc-hangar-row sc-cargo-goods';
    if (colors[g.resource]) row.style.borderLeftColor = colors[g.resource];

    var txt = document.createElement('div');
    txt.className = 'sc-goods-txt';
    var nm = document.createElement('span');
    nm.textContent = g.name;
    var meta = document.createElement('em');
    meta.textContent = g.amount + ' ед. · ' + g.slots + ' сл.';
    txt.appendChild(nm);
    txt.appendChild(meta);
    row.appendChild(txt);

    var acts = document.createElement('div');
    acts.className = 'sc-hangar-acts';
    var steps = g.amount > 10 ? [10, g.amount] : [g.amount];
    steps.forEach(function(n) {
      var b = document.createElement('button');
      b.className = 'sc-hangar-btn';
      b.textContent = n === g.amount ? 'Всё' : String(n);
      b.addEventListener('click', function() {
        b.disabled = true;
        supabase.rpc('unload_resource_from_ship', {
          p_ship_id: forShip, p_resource: g.resource, p_amount: n
        }).then(function(res) {
          if (res.error) {
            b.disabled = false;
            err.textContent = res.error.message;
            err.style.display = 'block';
            return;
          }
          scRenderCargo();
        });
      });
      acts.appendChild(b);
    });
    row.appendChild(acts);
    box.appendChild(row);
  });

  var note = document.createElement('div');
  note.className = 'sc-hangar-empty';
  note.textContent = 'Выгрузка — только на планете своей стороны, пока на складе есть место';
  box.appendChild(note);
}

function scRenderTiles() {
  var tiles = document.getElementById('sc-tiles');
  var info = document.getElementById('sc-abil-info');
  if (!tiles || !info) return;

  var st = scApState(scShip);
  var canAct = st.ap >= 1;

  tiles.innerHTML = '';

  var add = function(key, icon, label, enabled, onPick) {
    var b = document.createElement('button');
    b.className = 'sc-tile' + (scMode === key ? ' active' : '') + (enabled ? '' : ' locked');
    b.setAttribute('data-key', key);
    b.innerHTML = '<span class="sc-tile-icon">' + icon + '</span>' +
                  '<span class="sc-tile-label">' + label + '</span>';
    b.addEventListener('click', function() {
      scSetMode(scMode === key ? null : key);
      onPick();
    });
    tiles.appendChild(b);
  };

  var describe = function(name, text, meta) {
    info.innerHTML = '<div class="sc-abil-name">' + name + '</div>' +
      '<div class="sc-abil-text">' + text + '</div>' +
      (meta ? '<div class="sc-abil-meta">' + meta + '</div>' : '');
  };

  add('move', '⇢', 'Ход', canAct, function() {
    describe('Перемещение',
      'До ' + scType.move_range + ' клеток за одно действие. ' +
      'Коснись клетки — корабль встанет на неё серединой.',
      canAct ? null : 'нет очков действий');
  });

  add('rotate', '⟳', 'Разворот', canAct, function() {
    describe('Разворот',
      'Меняет, каким бортом корабль встречает противника. ' +
      'Щит держится по секторам, поэтому подставлять целый борт выгоднее.',
      canAct ? null : 'нет очков действий');
  });

  add('attack', '◎', 'Атака', canAct, function() {
    describe('Атака',
      'Урон зависит от класса цели: бомбардировщик рвёт крупные корабли, ' +
      'истребитель прикрывает от них своих.',
      canAct ? null : 'нет очков действий');
  });

  // Автоход: дальняя точка шагами, по действию на шаг (js/automove-space.js)
  if (typeof amAddTile === 'function') amAddTile(add, describe);

  // Притягивающий луч — способность, а не пассивка. Плитка появляется
  // только там, где дополнение действительно стоит.
  if (scShip.has_tractor) {
    add('tractor', '⊙', 'Захват', canAct, function() {
      describe('Притягивающие лучи',
        'Удерживает выбранное судно на месте. Берёт на дальность обзора — ' +
        'останавливает издалека, пока противник не сблизился.', null);
      scRenderTractor(info);
    });
  }

  // Истребителю нужен путь домой, и это именно действие
  if (scType.is_fighter) {
    add('recall', '⇤', 'В ангар', true, function() {
      describe('Возврат в ангар',
        'Носитель должен быть рядом и со свободным местом. ' +
        'Подбитая машина возвращается как есть — прочность не восстанавливается.',
        null);
      scRenderFighterActions(info);
    });
  }

  if (!scMode) {
    describe('Действия', 'Выбери, что делает корабль.',
      st.ap >= st.max ? 'действия готовы' : '+1 через ' + st.nextIn + ' с');
  }
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

    // Командир нужен редко, а места занимал много. Сворачиваем в строку,
    // которая раскрывается по тапу.
    box.innerHTML = '';

    var head = document.createElement('button');
    head.className = 'sc-cmd-head' + (current ? ' assigned' : '');
    head.innerHTML = '<span class="sc-cmd-arrow">▸</span> Командир: ' +
      (current ? current.name : 'в обороне');
    box.appendChild(head);

    var details = document.createElement('div');
    details.className = 'sc-cmd-details';
    box.appendChild(details);

    head.addEventListener('click', function() {
      var open = box.classList.toggle('open');
      head.querySelector('.sc-cmd-arrow').textContent = open ? '▾' : '▸';
    });

    var state = document.createElement('div');
    state.className = 'sc-cmd-state' + (current ? ' assigned' : '');
    state.textContent = current
      ? 'ведёт ' + current.name + ' — уйдёт вместе с ним'
      : 'в обороне системы — остаётся на месте';
    details.appendChild(state);

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

    details.appendChild(sel);

    if (here.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'sc-cmd-hint';
      hint.textContent = 'Свободных командиров в этой системе нет';
      details.appendChild(hint);
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
  // Видимость решают классы режима на самой панели. Инлайновый стиль
  // здесь перебивал бы их: он сильнее правил из таблицы стилей, и раздел
  // оставался на экране даже в режиме хода.
  // У истребителя ангара нет: возврат к носителю показывается плиткой
  // среди действий, а не отдельным разделом
  if (!scType.hangar_slots) {
    box.innerHTML = '';
    return;
  }

  var forShip = scShip.id;
  box.innerHTML = '<div class="sc-hangar-head">Ангар</div>' +
                  '<div class="sc-hangar-empty">Загрузка…</div>';

  // Читаем ангар прямо из таблицы: истребители внутри принадлежат игроку,
  // права на чтение у него есть. Так убирается лишнее звено — раньше
  // содержимое шло через функцию, и любой сбой в ней выглядел как
  // пустой ангар, без всякого объяснения.
  supabase.from('ships')
    .select('id, hp, ship_type, ship_types(name, image, max_hp)')
    .eq('carrier_ship_id', forShip)
    .then(function(res) {
    if (!scShip || scShip.id !== forShip || scTab !== 'hangar') return;

    if (res.error) {
      box.innerHTML = '<div class="sc-hangar-head">Ангар</div>' +
        '<div class="sc-hangar-empty">Ошибка: ' + res.error.message + '</div>';
      return;
    }

    var list = (res.data || []).map(function(f) {
      var t = f.ship_types || {};
      return { fighter_id: f.id, name: t.name || f.ship_type,
               hp: f.hp, max_hp: t.max_hp || f.hp };
    });

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
// Носители, готовые принять: считает сервер, потому что дотянуться
// можно не до любого корабля с ангаром, а только до ближайшего
// со свободным местом
// Цели и перезарядку считает сервер: клиент не должен решать,
// докуда дотягивается луч
function scRenderTractor(box) {
  if (!scShip) return;

  var forShip = scShip.id;
  var head = box.innerHTML;

  Promise.all([
    supabase.rpc('get_ship_abilities', { p_ship_id: forShip }),
    supabase.rpc('get_tractor_targets', { p_ship_id: forShip })
  ]).then(function(r) {
    if (!scShip || scShip.id !== forShip || scMode !== 'tractor') return;

    var ab = (!r[0].error && r[0].data && r[0].data.length) ? r[0].data[0] : null;
    var targets = (!r[1].error && r[1].data) ? r[1].data : [];

    box.innerHTML = head;

    if (ab && !ab.ready) {
      var cd = document.createElement('div');
      cd.className = 'sc-abil-meta warn';
      cd.textContent = 'Излучатели перезаряжаются: ' + ab.seconds_left + ' с';
      box.appendChild(cd);
      return;
    }

    if (!targets.length) {
      var empty = document.createElement('div');
      empty.className = 'sc-abil-meta';
      empty.textContent = 'Целей в зоне захвата нет';
      box.appendChild(empty);
      return;
    }

    targets.forEach(function(t) {
      var b = document.createElement('button');
      b.className = 'sc-hangar-btn wide';
      b.innerHTML = t.ship_name + ' <b>' + t.x + ':' + t.y + '</b> · ' + t.gap + ' кл.' +
        (t.held ? ' · уже держим ' + t.held_left + ' с' : '');
      b.disabled = t.held;

      b.addEventListener('click', function() {
        b.disabled = true;
        var holder = scShip, holderType = scType;
        supabase.rpc('use_tractor', {
          p_ship_id: forShip, p_target_id: t.target_id
        }).then(function(res) {
          if (res.error) { scFail(res.error.message); b.disabled = false; return; }
          scFail('Захват держит ' + res.data + ' с');
          var held = sxShipById(t.target_id);
          sxReport({
            kind: 'info', title: 'Луч захвата',
            attacker: sxShipPic(holder, holderType, 'mine'),
            target: { img: held && shipTypeById[held.ship_type] && shipTypeById[held.ship_type].image,
                      side: held ? sxSide(held) : 'enemy', name: t.ship_name },
            lines: [{ text: 'Цель удержана ' + res.data + ' с — с места не сдвинется' }]
          });
          loadShips();
          scRenderTractor(box);
        });
      });

      box.appendChild(b);
    });
  });
}

function scRenderFighterActions(box) {
  var head = box.innerHTML;

  if (!scShip) return;
  var forShip = scShip.id;

  var loading = document.createElement('div');
  loading.className = 'sc-hangar-empty';
  loading.textContent = 'Ищем носитель…';
  box.appendChild(loading);

  supabase.rpc('get_recall_carriers', { p_fighter_id: forShip }).then(function(res) {
    // Возврат живёт среди действий: у истребителя своей вкладки ангара нет
    if (!scShip || scShip.id !== forShip || scTab !== 'actions') return;

    var list = (!res.error && res.data) ? res.data : [];
    box.innerHTML = head;

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'sc-hangar-empty';
      empty.textContent = 'Рядом нет носителя со свободным местом';
      box.appendChild(empty);
      return;
    }

    list.forEach(function(c) {
      var b = document.createElement('button');
      b.className = 'sc-hangar-btn wide';
      b.innerHTML = 'В ангар · ' + c.carrier_name +
        ' <b>' + c.x + ':' + c.y + '</b> · мест ' + c.free_slots;
      b.addEventListener('click', function() {
        b.disabled = true;
        supabase.rpc('recall_fighter', {
          p_fighter_id: forShip, p_carrier_id: c.carrier_id
        }).then(function(r) {
          if (r.error) { scFail(r.error.message); b.disabled = false; return; }
          scDeselect();
          loadShips();
        });
      });
      box.appendChild(b);
    });
  });
}

function scStartLaunch(f) {
  scHangarPick = f;
  scHangarMode = 'launch';
  scSetMode(null);

  var hint = document.getElementById('sc-hint');
  hint.textContent = 'Коснись клетки рядом с носителем';
}

// Посадка идёт на наземной карте: сразу переходим туда с этим
// истребителем в режиме посадки. Раньше кнопка лишь просила открыть
// карту самому, а там на своей планете не было даже кнопки высадки.
function scStartLand(f) {
  scHangarPick = null;
  scHangarMode = null;

  // Носитель не в площадке сброса — садиться неоткуда, на землю не ведём
  supabase.rpc('get_landable_fighters', { p_system_id: systemId }).then(function(res) {
    var row = (!res.error && res.data) ? res.data.filter(function(x) {
      return x.fighter_id === f.fighter_id;
    })[0] : null;
    if (row && (row.zone === null || row.zone === undefined)) {
      scFail('Сначала поставь носитель целиком в площадку сброса');
      return;
    }
    window.location.href = 'ground-battle.html?system=' + encodeURIComponent(systemId) +
      '&land=' + encodeURIComponent(f.fighter_id);
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

  // Доступность действий показывают сами плитки
  scRenderTiles();
  if (typeof amRenderStatus === 'function') amRenderStatus();
}

function scRenderMode() {
  var dial = document.getElementById('sc-dial');
  var hint = document.getElementById('sc-hint');
  if (!dial) return;

  // Режим живёт внутри вкладки действий: выбрал ход или атаку — вернись
  // на неё, иначе плитки окажутся спрятаны за щитами
  if (scMode) { scTab = 'actions'; scApplyTab(); }

  if (scMode === 'attack') scLoadTargets();

  scRenderTiles();

  dial.style.display = scMode === 'rotate' ? 'grid' : 'none';

  var dirs = dial.querySelectorAll('.sc-dir');
  for (var i = 0; i < dirs.length; i++) {
    var isNow = scShip && parseInt(dirs[i].dataset.deg, 10) === (scShip.facing || 0);
    dirs[i].classList.toggle('current', !!isNow);
  }

  var confirmBox = document.getElementById('sc-confirm');
  confirmBox.style.display = (scMode === 'move' && scPreview) ? 'flex' : 'none';

  var targetsBox = document.getElementById('sc-targets');
  if (targetsBox) targetsBox.style.display = scMode === 'attack' ? 'block' : 'none';

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
  } else if (scMode === 'auto') {
    hint.textContent = typeof amHintText === 'function' ? amHintText() : '';
  } else {
    hint.textContent = '';
  }

  scRenderRange();
  if (typeof amRenderBox === 'function') { amRenderBox(); amRender(); }
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

  // Каждый корабль открывается заново, без режима и без чужих списков.
  // Иначе панель показывала ангар «Венатора» при выборе истребителя:
  // раздел оставался нарисованным с прошлого раза.
  if (scJustSelected) scResetSections();

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
  scResetSections();

  var hud = document.getElementById('ship-hud');
  if (hud) hud.style.display = 'none';
  if (typeof setBottomInset === 'function') setBottomInset(0);
  scRenderRange();
}

// Полная очистка разделов: содержимое, состояние режимов и списки
function scResetSections() {
  scMode = null;
  // Каждый корабль открывается на действиях: иначе остаётся вкладка
  // от предыдущего, а у него мог быть ангар, которого здесь нет
  scTab = 'actions';
  scHangarMode = null;
  scHangarPick = null;
  scTargets = [];
  scPreview = null;

  var hud = document.getElementById('ship-hud');
  if (hud) hud.classList.remove('mode-move', 'mode-rotate', 'mode-attack', 'mode-hangar', 'mode-auto');
  if (typeof amReset === 'function') amReset();

  ['sc-targets', 'sc-hangar'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  var cmd = document.getElementById('sc-cmd');
  if (cmd) cmd.classList.remove('open');
}

function scSetMode(mode) {
  scMode = mode;

  // Видимость разделов решают классы: во время хода и атаки нужна карта,
  // а не полосы щитов
  var hud = document.getElementById('ship-hud');
  if (hud) {
    hud.classList.remove('mode-move', 'mode-rotate', 'mode-attack', 'mode-hangar', 'mode-auto');
    if (mode) hud.classList.add('mode-' + mode);
  }
  if (mode !== 'move') scPreview = null;
  if (typeof amOnMode === 'function') amOnMode(mode);
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
  // Ушёл в ангар носителя — на карте его больше нет, держать HUD незачем
  if (!fresh || fresh.carrier_ship_id || fresh.x === null || fresh.x === undefined) {
    scDeselect(); return;
  }
  scShip = fresh;
  scRenderHud();
}

// ===== действия =====

// Пока сервер не ответил, повторный тап не должен отправить второй приказ
function scBusy(on) {
  var b = document.getElementById('sc-go');
  if (b) b.disabled = on;
  var dirs = document.querySelectorAll('#sc-dial .sc-dir');
  for (var i = 0; i < dirs.length; i++) dirs[i].disabled = on;
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

  var forShip = scShip.id;

  supabase.rpc('get_attack_targets', { p_ship_id: forShip }).then(function(res) {
    if (scMode !== 'attack' || !scShip || scShip.id !== forShip) return;

    scTargets = (res.error || !res.data) ? [] : res.data;
    if (typeof renderShips === 'function') renderShips();

    if (!scTargets.length) {
      box.innerHTML = '<div class="sc-targets-empty">Целей в радиусе нет</div>';
      var h = document.getElementById('sc-hint');
      if (h) h.textContent = 'Подойди ближе или найди цель обзором';
      return;
    }

    box.innerHTML = '';
    res.data.forEach(function(t) {
      var hpPct = t.max_hp ? Math.max(0, t.hp / t.max_hp * 100) : 100;

      var b = document.createElement('button');
      b.className = 'sc-target';
      // Урон считает сервер по классу цели: бомбардировщик по крейсеру
      // бьёт втрое сильнее, чем по истребителю, и это должно быть видно
      // до выстрела, а не после
      b.innerHTML =
        '<div class="sc-target-line">' +
          '<span>' + t.ship_name + ' <b>' + t.x + ':' + t.y + '</b></span>' +
          '<em>' + t.chance + '%</em>' +
        '</div>' +
        '<div class="sc-target-track"><i style="width:' + hpPct + '%"></i></div>' +
        '<div class="sc-target-sub">урон <b class="sc-dmg">' + t.damage + '</b>' +
          ' · дистанция ' + t.gap + ' · корпус ' + t.hp + '</div>';

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

  // Стрелка запоминаем до запроса: к ответу выбор мог смениться.
  // Отметку своего выстрела тоже ставим заранее — реалтайм приносит
  // урон раньше ответа, и это не должно выглядеть как «нас атакуют».
  var shooter = scShip, shooterType = scType;
  // Цель как она есть перед выстрелом: к ответу реалтайм мог её уже убрать
  var snap = sxShipById(target.target_id);
  if (snap) snap = Object.assign({}, snap);
  sxLastOwnAction = Date.now();
  sxSkipDiff[target.target_id] = Date.now() + 4000;

  supabase.rpc('attack_ship', {
    p_attacker_id: shooter.id, p_target_id: target.target_id
  }).then(function(res) {
    if (res.error) { scFail(res.error.message); if (btn) btn.disabled = false; return; }

    var r = (res.data && res.data.length) ? res.data[0] : null;
    var hint = document.getElementById('sc-hint');

    if (!r) { loadShips(); return; }

    var arc = SC_ARCS[r.arc] || '';

    // Подробности — в карточке сводки; строка в панели остаётся короткой
    if (hint) {
      if (!r.hit) hint.textContent = 'Промах по ' + target.ship_name;
      else if (r.destroyed) hint.textContent = target.ship_name + ' уничтожен';
      else hint.textContent = 'Попадание ' + arc + ' · щит ' + r.shield_left + ' · корпус ' + r.target_hp;
    }
    sxReportShot(shooter, shooterType, target, r, snap);

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

    // Тап в пустоту закрывает паспорт чужого корабля
    if (!scMode && !scHangarMode && sxIntelId) { sxCloseIntel(); return; }

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

    if (scMode !== 'move' && scMode !== 'auto') return;
    var rect = viewport.getBoundingClientRect();
    var gx = (e.clientX - rect.left - panX) / scale;
    var gy = (e.clientY - rect.top - panY) / scale;
    if (scMode === 'auto') {
      if (typeof amFieldTap === 'function') amFieldTap(Math.floor(gx / CELL_PX), Math.floor(gy / CELL_PX));
      return;
    }
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

// ===== Боевые сводки и разведданные в космосе =====
// То же, что на земле: над целью всплывает урон или «промах», внизу на
// несколько секунд встаёт карточка с портретами, уроном и остатком
// корпуса. У кораблей урон делится на щит и корпус — сводка показывает
// оба. Тап по чужому кораблю открывает разведданные: паспорт корабля,
// корпус и щиты по секторам. Улучшения, луч захвата и прочие системы
// противника не показываются.

var sxToastEl = null;
var sxToastTimer = null;
var sxLastOwnAction = 0;
var sxSkipDiff = {};        // id корабля -> до какого времени не всплывать по разнице (сводка уже показала)
var sxOwnerNames = {};
var sxOwnerAsked = {};
var sxIntelId = null;       // чей паспорт открыт
var sxIntelEl = null;
var sxRangeEls = [];
var sxShipsSeq = 0;
var sxShipsApplied = 0;

var SX_ARCS = [
  { key: 'shield_fore', label: 'Нос' },
  { key: 'shield_starboard', label: 'Правый борт' },
  { key: 'shield_port', label: 'Левый борт' },
  { key: 'shield_aft', label: 'Корма' }
];

function sxEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sxShipById(id) {
  for (var i = 0; i < shipsInSystem.length; i++) if (shipsInSystem[i].id === id) return shipsInSystem[i];
  return null;
}

function sxMaxHp(ship, type) {
  return ((type && type.max_hp) || (ship && ship.hp) || 0) + ((ship && ship.bonus_hp) || 0);
}

// Щит, каким его видит сервер (ship_shields): записанное значение плюс
// подзарядка с последнего удара, не выше предела. В строке базы лежит
// значение на момент удара — по нему щит выглядел бы пробитым, когда
// он давно восстановился.
function sxShields(ship, type, atMs) {
  var max = ((type && type.max_shield) || 0) + ((ship && ship.bonus_shield) || 0);
  var maxFore = max + ((ship && ship.bonus_fore) || 0);
  var regen = 0;
  if (ship && ship.shields_updated_at && type && type.shield_regen) {
    var at = atMs || scServerNow();
    var step = (scSettings.shieldRegenSec || 30) * 1000;
    regen = Math.max(0, Math.floor((at - new Date(ship.shields_updated_at).getTime()) / step)) * type.shield_regen;
  }
  var res = { max: max, maxFore: maxFore };
  SX_ARCS.forEach(function(a) {
    var cap = a.key === 'shield_fore' ? maxFore : max;
    res[a.key] = Math.max(0, Math.min(cap, (Number(ship && ship[a.key]) || 0) + regen));
  });
  return res;
}

function sxSide(ship) {
  if (ship.owner_user_id && ship.owner_user_id === currentUserId) return 'mine';
  if (typeof spaceMyFaction !== 'undefined' && spaceMyFaction && ship.faction === spaceMyFaction) return 'ally';
  return 'enemy';
}

function sxRole(type) {
  if (!type) return 'Корабль';
  if (type.is_fighter) return type.hull_class === 'bomber' ? 'Бомбардировщик' : 'Истребитель';
  return type.hull_class === 'corvette' ? 'Корвет' : 'Крупный корабль';
}

// ---------- Порядок ответов и разница между загрузками ----------

// Вызывается из loadShips до запроса: номер и время запроса
function sxShipsRequested() {
  return { seq: ++sxShipsSeq, at: Date.now() };
}

// Ответ свежее показанного? Старый поверх нового откатил бы корабли назад
function sxShipsFresh(req) {
  if (!req || req.seq <= sxShipsApplied) return false;
  sxShipsApplied = req.seq;
  return true;
}

var sxPrevShipsAt = 0;       // серверное время, на которое считан прошлый список

function sxAfterShips(prev, req) {
  var at = scServerNow();
  sxDiffShips(prev, shipsInSystem, sxPrevShipsAt || at, at);
  sxPrevShipsAt = at;
  sxRefreshIntel();
}

// Потеря щита — по секторам: каждый сектор сравниваем с самим собой,
// посчитав подзарядку на момент каждого снимка. Сумма не годится:
// при ударе сервер записывает подзарядку во все секторы сразу, и сумма
// растёт, хотя один сектор просел.
function sxDiffShips(prev, next, prevAt, nowAt) {
  if (!prev || !prev.length) return;
  var before = {};
  prev.forEach(function(s) { before[s.id] = s; });
  var now = Date.now();

  var hurt = [];
  next.forEach(function(s) {
    var p = before[s.id];
    if (!p) return;
    var t = shipTypeById[s.ship_type];
    var dHull = (s.hp || 0) - (p.hp || 0);
    var a0 = sxShields(p, t, prevAt), a1 = sxShields(s, t, nowAt);
    var dShield = 0;
    SX_ARCS.forEach(function(a) { dShield -= Math.max(0, a0[a.key] - a1[a.key]); });
    if (!dHull && !dShield) return;

    if (!(sxSkipDiff[s.id] && sxSkipDiff[s.id] > now)) {
      var both = dShield < 0 && dHull;
      if (dShield < 0) sxFloatOnShip(s, '⛨ −' + (-dShield), 'shield', 0, both ? -0.9 : 0);
      if (dHull) sxFloatOnShip(s, dHull < 0 ? '−' + (-dHull) : '+' + dHull, dHull < 0 ? 'dmg' : 'heal',
                               both ? 160 : 0, both ? 0.9 : 0);
    }
    if ((dHull < 0 || dShield < 0) && s.owner_user_id === currentUserId) {
      hurt.push({ s: s, hull: Math.max(0, -dHull), shield: Math.max(0, -dShield) });
    }
  });

  // Свои выстрелы в космосе своих не задевают, поэтому по нашим бьёт
  // только противник. Если на экране свежая сводка своего выстрела,
  // тревогу показываем следом, а не поверх неё.
  if (!hurt.length) return;
  var wait = 1600 - (Date.now() - sxToastShownAt);
  if (wait > 0) setTimeout(function() { sxReportIncoming(hurt); }, wait);
  else sxReportIncoming(hurt);
}

// ---------- Всплывающие цифры ----------

function sxFloat(cellX, cellY, wCells, text, kind, delay, shift) {
  if (typeof grid === 'undefined' || !grid) return;
  var pos = document.createElement('div');
  pos.className = 'fx-pos';
  // shift — сдвиг в долях клетки, чтобы щит и корпус не слипались
  pos.style.left = ((cellX + (wCells || 1) / 2 + (shift || 0)) * CELL_PX) + 'px';
  pos.style.top = (cellY * CELL_PX) + 'px';
  var txt = document.createElement('div');
  txt.className = 'fx-txt fx-' + kind;
  txt.textContent = text;
  if (delay) txt.style.animationDelay = delay + 'ms';
  pos.appendChild(txt);
  grid.appendChild(pos);
  setTimeout(function() { if (pos.parentNode) pos.parentNode.removeChild(pos); }, 1700 + (delay || 0));
}

function sxFloatOnShip(ship, text, kind, delay, shift) {
  if (!ship) return;
  var t = shipTypeById[ship.ship_type];
  var box = t ? shipBoxCells(t, ship.facing || 0) : { w: 1, h: 1 };
  sxFloat(ship.x, ship.y, box.w, text, kind, delay, shift);
}

// Масштаб подписей обратный масштабу поля — на любом зуме одного размера
function sxSyncScale() {
  if (typeof grid !== 'undefined' && grid) grid.style.setProperty('--fx-inv', (1 / (scale || 1)).toFixed(4));
}

// ---------- Карточка сводки ----------

function sxEnsureToast() {
  if (sxToastEl && sxToastEl.parentNode) return sxToastEl;
  sxToastEl = document.createElement('div');
  sxToastEl.id = 'cb-toast';
  // Сама карточка касания пропускает — под ней может быть цель.
  // Закрывает её только крестик.
  sxToastEl.addEventListener('click', function(e) {
    if (e.target && e.target.className === 'cb-x') sxHideToast();
  });
  document.body.appendChild(sxToastEl);
  return sxToastEl;
}

function sxPlaceToast() {
  if (!sxToastEl) return;
  sxToastEl.style.bottom = uiBottomInset > 0 ? (uiBottomInset + 4) + 'px' : '';
}

function sxHideToast() {
  if (sxToastTimer) { clearTimeout(sxToastTimer); sxToastTimer = null; }
  if (sxToastEl) sxToastEl.classList.remove('show');
}

function sxPic(p) {
  if (!p) return '';
  return '<div class="cb-pic ship side-' + (p.side || 'enemy') + '">' +
    (p.img ? '<img src="../' + sxEsc(p.img) + '" alt="">' : '') + '</div>';
}

function sxShipPic(ship, type, side) {
  return { img: type && type.image, side: side || (ship ? sxSide(ship) : 'enemy'),
           name: (type && type.name) || 'Корабль' };
}

var sxToastShownAt = 0;

function sxReport(o) {
  var el = sxEnsureToast();
  sxToastShownAt = Date.now();
  var kind = o.kind || 'hit';
  var titles = { hit: 'Попадание', miss: 'Промах', kill: 'Корабль уничтожен',
                 incoming: 'Под огнём', info: 'Сводка', shield: 'Удар в щит' };
  var title = o.title || titles[kind] || 'Сводка';

  var pics = (o.attacker || o.target)
    ? '<div class="cb-pics">' + sxPic(o.attacker) +
        (o.attacker && o.target ? '<span class="cb-arrow">➜</span>' : '') + sxPic(o.target) + '</div>'
    : '';

  var who = o.attacker && o.target
    ? sxEsc(o.attacker.name) + ' <i>→</i> ' + sxEsc(o.target.name)
    : o.target ? sxEsc(o.target.name) : o.attacker ? sxEsc(o.attacker.name) : '';

  var hp = '';
  if (o.hpMax) {
    var left = Math.max(0, Math.min(o.hpMax, o.hpLeft || 0));
    var lost = Math.max(0, Math.min(o.hpMax - left, o.hullLost || 0));
    var lPct = left / o.hpMax * 100, xPct = lost / o.hpMax * 100;
    hp = '<div class="cb-hp">' +
      '<span class="cb-num">' + (kind === 'miss' ? '—' : '−' + (o.damage || 0)) + '</span>' +
      '<div class="cb-track"><i class="left" style="width:' + lPct.toFixed(1) + '%"></i>' +
        (xPct > 0 ? '<i class="lost" style="left:' + lPct.toFixed(1) + '%;width:' + xPct.toFixed(1) + '%"></i>' : '') +
      '</div>' +
      '<span class="cb-left">' + left + ' / ' + o.hpMax + '</span>' +
    '</div>';
  }

  var chips = (o.chips || []).filter(Boolean).map(function(c) {
    return '<span class="cb-chip' + (c.cls ? ' ' + c.cls : '') + '">' + sxEsc(c.text) + '</span>';
  }).join('');
  var lines = (o.lines || []).filter(Boolean).map(function(l) {
    return '<div class="cb-line' + (l.cls ? ' ' + l.cls : '') + '">' + sxEsc(l.text) + '</div>';
  }).join('');

  el.className = 'cb-' + kind;
  el.innerHTML = '<button class="cb-x" aria-label="Закрыть">✕</button>' + pics +
    '<div class="cb-body">' +
      '<div class="cb-head"><b>' + sxEsc(title) + '</b>' +
        (o.chance !== null && o.chance !== undefined ? '<span class="cb-chance">шанс ' + o.chance + '%</span>' : '') +
      '</div>' +
      (who ? '<div class="cb-who">' + who + '</div>' : '') +
      hp +
      (chips ? '<div class="cb-chips">' + chips + '</div>' : '') +
      lines +
    '</div>';

  sxPlaceToast();
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  if (sxToastTimer) clearTimeout(sxToastTimer);
  sxToastTimer = setTimeout(sxHideToast, kind === 'miss' ? 3200 : 4800);
}

// Выстрел корабля. Сервер отвечает: сектор, весь урон, остаток щита
// сектора и корпуса. Сколько ушло в корпус — разница прочности до и после.
function sxReportShot(attacker, aType, target, r, snap) {
  sxLastOwnAction = Date.now();
  var ts = snap || sxShipById(target.target_id);
  var tt = ts ? shipTypeById[ts.ship_type] : null;
  var before = ts ? ts.hp : ((target.hp !== null && target.hp !== undefined) ? target.hp : 0);
  var max = ts ? sxMaxHp(ts, tt) : (target.max_hp || 0);
  var arc = SC_ARCS[r.arc] || '';
  var where = ts || { x: target.x, y: target.y, ship_type: null };

  if (!r.hit) {
    sxFloatOnShip(where, 'ПРОМАХ', 'miss');
    sxReport({ kind: 'miss', chance: target.chance,
      attacker: sxShipPic(attacker, aType, 'mine'),
      target: { img: tt && tt.image, side: ts ? sxSide(ts) : 'enemy', name: target.ship_name },
      hpLeft: before, hpMax: max });
    return;
  }

  var hull = r.destroyed ? before : Math.max(0, before - (r.target_hp || 0));
  // У сбитого урон сверх корпуса — это перебор, а не щит
  var shield = r.destroyed ? 0 : Math.max(0, (r.damage || 0) - hull);
  var both = shield > 0 && hull > 0;

  if (shield > 0) sxFloatOnShip(where, '⛨ −' + shield, 'shield', 0, both ? -0.9 : 0);
  if (hull > 0) sxFloatOnShip(where, '−' + hull, 'dmg', both ? 160 : 0, both ? 0.9 : 0);
  if (r.destroyed) sxFloatOnShip(where, 'УНИЧТОЖЕН', 'kill', 380);

  var chips = [];
  if (arc) chips.push({ text: arc });
  if (shield > 0) chips.push({ text: 'щит −' + shield, cls: 'shield' });
  chips.push(hull > 0 ? { text: 'корпус −' + hull, cls: 'bad' } : { text: 'корпус цел' });
  if (!r.destroyed && r.shield_left !== null && r.shield_left !== undefined) {
    chips.push({ text: 'щит сектора ' + r.shield_left, cls: r.shield_left > 0 ? '' : 'bad' });
  }

  sxReport({
    kind: r.destroyed ? 'kill' : (hull > 0 ? 'hit' : 'shield'),
    title: r.destroyed ? 'Корабль уничтожен' : (hull > 0 ? 'Попадание' : 'Удар в щит'),
    chance: target.chance,
    attacker: sxShipPic(attacker, aType, 'mine'),
    target: { img: tt && tt.image, side: ts ? sxSide(ts) : 'enemy', name: target.ship_name },
    damage: r.damage || 0,
    hullLost: hull,
    hpLeft: r.destroyed ? 0 : r.target_hp,
    hpMax: max,
    chips: chips,
    lines: (!r.destroyed && hull === 0) ? [{ text: 'Весь урон принял щит — ударь в другой сектор', cls: 'muted' }] : []
  });
}

function sxReportIncoming(hurt) {
  if (hurt.length === 1) {
    var h = hurt[0], t = shipTypeById[h.s.ship_type];
    var chips = [];
    if (h.shield) chips.push({ text: 'щит −' + h.shield, cls: 'shield' });
    if (h.hull) chips.push({ text: 'корпус −' + h.hull, cls: 'bad' });
    sxReport({ kind: 'incoming', target: sxShipPic(h.s, t, 'mine'),
      damage: h.hull + h.shield, hullLost: h.hull, hpLeft: h.s.hp, hpMax: sxMaxHp(h.s, t),
      chips: chips, lines: [{ text: 'Позиция ' + h.s.x + ':' + h.s.y }] });
    return;
  }
  var total = 0;
  sxReport({
    kind: 'incoming',
    title: 'Под огнём · кораблей: ' + hurt.length,
    chips: hurt.slice(0, 4).map(function(h) {
      var t = shipTypeById[h.s.ship_type];
      total += h.hull + h.shield;
      return { text: ((t && t.name) || 'корабль') + ' −' + (h.hull + h.shield), cls: 'bad' };
    })
  });
}

// ---------- Разведданные о чужом корабле ----------

function sxEnsureIntel() {
  if (sxIntelEl && sxIntelEl.parentNode) return sxIntelEl;
  sxIntelEl = document.createElement('div');
  sxIntelEl.id = 'sx-intel';
  sxIntelEl.style.display = 'none';
  document.body.appendChild(sxIntelEl);
  return sxIntelEl;
}

function sxLoadOwner(id, done) {
  if (!id || sxOwnerNames[id] !== undefined || sxOwnerAsked[id]) return;
  sxOwnerAsked[id] = true;
  supabase.from('profiles').select('id, nickname').eq('id', id).maybeSingle().then(function(r) {
    sxOwnerNames[id] = (!r.error && r.data && r.data.nickname) ? r.data.nickname : null;
    if (done) done();
  });
}

function sxShowIntel(ship, type, keepView) {
  if (!ship || !type) return;
  // Своя панель и разведка — одна шторка внизу: одна сменяет другую
  if (scShip) scDeselect();

  var el = sxEnsureIntel();
  var side = sxSide(ship);
  sxIntelId = ship.id;

  var max = sxMaxHp(ship, type);
  var hpPct = max ? Math.max(0, Math.min(100, ship.hp / max * 100)) : 100;
  var box = shipBoxCells(type, ship.facing || 0);
  var nick = sxOwnerNames[ship.owner_user_id];

  // Щиты по секторам: где тонко, туда и бить. Предел берём паспортный —
  // усиленный щит противника выдаст себя только тем, что держит дольше.
  var shieldMax = type.max_shield || 0;
  var sh = sxShields(ship, type);
  var arcs = '';
  if (shieldMax > 0) {
    arcs = '<div class="ui-label">Щиты по секторам</div><div class="sx-arcs">' +
      SX_ARCS.map(function(a) {
        var v = sh[a.key];
        var m = Math.max(shieldMax, v);
        var pct = m ? Math.max(0, Math.min(100, v / m * 100)) : 0;
        return '<div class="sx-arc' + (v <= 0 ? ' down' : '') + '">' +
          '<span>' + a.label + '</span>' +
          '<div class="sx-arc-track"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
          '<b>' + v + '</b></div>';
      }).join('') + '</div>';
  }

  var marks = [];
  var now = scServerNow();
  if (ship.tractor_until && new Date(ship.tractor_until).getTime() > now) {
    marks.push({ text: 'Удержан лучом захвата', cls: 'mind' });
  }
  if (shieldMax > 0) {
    var down = SX_ARCS.filter(function(a) { return sh[a.key] <= 0; }).length;
    if (down) marks.push({ text: 'Щит пробит: секторов ' + down, cls: 'reveal' });
  }
  if (ship.hp < max * 0.35) marks.push({ text: 'Корпус на исходе', cls: 'wound' });

  var range = type.weapon_range || 0;
  var stats = [
    ['Урон', type.damage || 0, '◎'],
    ['Дальность', range, '➶'],
    ['Обзор', type.vision_range || 0, '◈'],
    ['Ход', type.move_range || 0, '⇢'],
    ['Точность', (type.accuracy || 0) + '%', '⌖'],
    ['Уклонение', (type.evasion || 0) + '%', '↯']
  ];

  var extra = [];
  if (type.hangar_slots) extra.push('ангар ' + type.hangar_slots);
  if (type.capacity) extra.push('трюм ' + type.capacity);

  // Реалтайм дёргает перерисовку на каждое движение в системе. Если
  // у этого корабля ничего не поменялось — не трогаем шторку, иначе
  // прокрутка прыгает наверх посреди боя.
  var sig = [ship.id, ship.hp, ship.x, ship.y, ship.facing, ship.tractor_until, nick,
             SX_ARCS.map(function(a) { return sh[a.key]; }).join(',')].join('|');
  if (keepView && el.style.display !== 'none' && el.getAttribute('data-sig') === sig) return;
  var keepScroll = keepView ? el.scrollTop : 0;

  el.setAttribute('data-sig', sig);
  el.setAttribute('data-side', side);
  el.innerHTML =
    '<div class="sc-top">' +
      '<div class="sc-portrait sx-portrait side-' + side + '">' +
        (type.image ? '<img src="../' + sxEsc(type.image) + '" alt="">' : '') +
        '<span class="ui-tag">' + (side === 'enemy' ? 'ВРАГ' : 'СВОЙ') + '</span>' +
      '</div>' +
      '<div class="sc-stats">' +
        '<div class="sc-name sx-name">' + sxEsc(type.name) + '</div>' +
        '<div class="sc-role"><b class="sx-side side-' + side + '">' + (side === 'enemy' ? 'Противник' : 'Союзник') + '</b> · ' +
          sxEsc(sxRole(type)) + ' · ' + box.w + '×' + box.h + ' · ' + ship.x + ':' + ship.y + '</div>' +
        '<div class="sc-hp sx-hp">' +
          '<span class="sc-hp-num">' + ship.hp + ' / ' + max + '</span>' +
          '<div class="sc-hp-track"><i style="width:' + hpPct.toFixed(1) + '%"></i></div>' +
        '</div>' +
        (nick ? '<div class="ui-owner">Командир: <b>' + sxEsc(nick) + '</b></div>' : '') +
      '</div>' +
      '<button class="sc-close" id="sx-close">✕</button>' +
    '</div>' +
    (marks.length ? '<div class="ui-marks">' + marks.map(function(m) {
      return '<span class="ui-mark ' + m.cls + '">' + sxEsc(m.text) + '</span>';
    }).join('') + '</div>' : '') +
    '<div class="sx-panel">' +
      arcs +
      '<div class="ui-label">Паспорт корабля' + (extra.length ? ' · ' + extra.join(' · ') : '') + '</div>' +
      '<div class="ui-grid">' + stats.map(function(s) {
        return '<div class="ui-stat"><i>' + s[2] + '</i><b>' + s[1] + '</b><span>' + s[0] + '</span></div>';
      }).join('') + '</div>' +
      (type.description ? '<div class="sc-desc ui-desc">' + sxEsc(type.description) + '</div>' : '') +
      '<div class="ui-hidden"><span class="ui-lock">⛒</span><span>' + (side === 'enemy'
        ? 'Улучшения, луч захвата и прочие системы противника неизвестны. Характеристики — заводские.'
        : 'Улучшения и системы союзника видит только его командир') + '</span></div>' +
    '</div>';

  document.getElementById('sx-close').addEventListener('click', sxCloseIntel);

  el.style.display = 'block';
  el.scrollTop = keepScroll;
  sxDrawRanges(ship, type, side);
  // Подсветку на карте ставим только при открытии: при обновлении
  // корабли и так перерисованы загрузкой
  if (!keepView && typeof renderShips === 'function') renderShips();

  setTimeout(function() {
    if (sxIntelId !== ship.id) return;
    setBottomInset(el.offsetHeight + 12);
    if (!keepView) focusCell(ship.x + box.w / 2, ship.y + box.h / 2);
  }, 0);

  if (ship.owner_user_id && sxOwnerNames[ship.owner_user_id] === undefined) {
    sxLoadOwner(ship.owner_user_id, function() {
      if (sxIntelId === ship.id) {
        var fresh = sxShipById(ship.id);
        if (fresh) sxShowIntel(fresh, shipTypeById[fresh.ship_type], true);
      }
    });
  }
}

// Куда достаёт его орудие и что он видит — от корпуса, паспортные значения
function sxDrawRanges(ship, type, side) {
  sxClearRanges();
  var box = shipBoxCells(type, ship.facing || 0);
  [[type.weapon_range, side === 'enemy' ? 'fire' : 'ally'], [type.vision_range, 'vision']].forEach(function(r) {
    if (!r[0]) return;
    var el = document.createElement('div');
    el.className = 'sx-range sx-range-' + r[1];
    el.style.left = ((ship.x - r[0]) * CELL_PX) + 'px';
    el.style.top = ((ship.y - r[0]) * CELL_PX) + 'px';
    el.style.width = ((box.w + r[0] * 2) * CELL_PX) + 'px';
    el.style.height = ((box.h + r[0] * 2) * CELL_PX) + 'px';
    grid.insertBefore(el, grid.firstChild);
    sxRangeEls.push(el);
  });
}

function sxClearRanges() {
  sxRangeEls.forEach(function(el) { if (el.parentNode) el.parentNode.removeChild(el); });
  sxRangeEls = [];
}

function sxCloseIntel() {
  if (!sxIntelId) return;
  sxIntelId = null;
  sxClearRanges();
  if (sxIntelEl) { sxIntelEl.style.display = 'none'; sxIntelEl.removeAttribute('data-sig'); }
  setBottomInset(0);
  if (typeof renderShips === 'function') renderShips();
}

function sxRefreshIntel() {
  if (!sxIntelId) return;
  var fresh = sxShipById(sxIntelId);
  var type = fresh ? shipTypeById[fresh.ship_type] : null;
  if (!fresh || !type || fresh.owner_user_id === currentUserId || fresh.carrier_ship_id) {
    sxCloseIntel(); return;
  }
  sxShowIntel(fresh, type, true);
}


// ---------- Переход по ссылке из ленты и процессов ----------
// ?system=…&ship=… — выбрать корабль (свой — панель, чужой — паспорт)
// &x=…&y=…         — показать точку
// &open=shipyard   — верфь станции; open=station — панель станции

function sxDeepLink() {
  var q = new URLSearchParams(window.location.search);
  var link = {
    ship: q.get('ship'),
    x: q.get('x') !== null ? parseInt(q.get('x'), 10) : null,
    y: q.get('y') !== null ? parseInt(q.get('y'), 10) : null,
    open: q.get('open')
  };
  if (!link.ship && link.x === null && !link.open) return;

  try {
    var keep = '?system=' + encodeURIComponent(systemId) +
               (typeof isBuildMode === 'function' && isBuildMode() ? '&mode=build' : '');
    window.history.replaceState(null, '', window.location.pathname + keep);
  } catch (e) {}

  var tries = 0;
  var wait = setInterval(function() {
    tries++;
    var ready = sxShipsApplied > 0 && (typeof stationLoaded === 'undefined' || stationLoaded);
    if (!ready && tries < 50) return;
    clearInterval(wait);
    sxApplyLink(link);
  }, 200);
}

function sxApplyLink(link) {

  if (link.ship) {
    var s = sxShipById(link.ship);
    var t = s ? shipTypeById[s.ship_type] : null;
    if (s && t && s.x !== null && s.x !== undefined) {
      var box = shipBoxCells(t, s.facing || 0);
      if (s.owner_user_id === currentUserId) onOwnShipTapped(s, t);
      else sxShowIntel(s, t);
      // Центрируем, когда панель уже заняла низ экрана
      setTimeout(function() {
        sxLinkZoom(); focusCell(s.x + box.w / 2 - 0.5, s.y + box.h / 2 - 0.5);
        sxPing(s.x, s.y, box.w, box.h);
      }, 120);
      return;
    }
  }

  if (link.open === 'shipyard' || link.open === 'station') {
    // Слота станции в системе нет — показывать нечего, остаёмся на обзоре
    if (typeof stationSlot === 'undefined' || !stationSlot) return;
    sxLinkZoom(); focusCell(stationSlot.x + STATION_SIZE / 2 - 0.5, stationSlot.y + STATION_SIZE / 2 - 0.5);
    sxPing(stationSlot.x, stationSlot.y, STATION_SIZE, STATION_SIZE);
    setTimeout(function() {
      if (typeof onStationSlotTapped !== 'function') return;
      // Панель станции сама решает, доступна ли верфь: стройка, трофей,
      // чужой контроль. Если кнопка верфи видна — сразу в верфь,
      // иначе остаётся панель с объяснением
      onStationSlotTapped();
      var yardBtn = document.getElementById('station-shipyard-btn');
      if (link.open === 'shipyard' && yardBtn && yardBtn.style.display === 'block' &&
          typeof openShipyard === 'function') {
        if (typeof closeStationPanel === 'function') closeStationPanel();
        openShipyard();
      }
    }, 350);
    return;
  }

  if (link.x !== null && link.y !== null && !isNaN(link.x) && !isNaN(link.y)) {
    sxLinkZoom(); focusCell(link.x, link.y);
    sxPing(link.x, link.y, 1, 1);
  }
}

// С обзора всей системы переходим на рабочий масштаб — только когда
// действительно есть что показать
function sxLinkZoom() { if (scale < 0.8) scale = 0.95; }

function sxPing(x, y, w, h) {
  if (typeof grid === 'undefined' || !grid) return;
  var el = document.createElement('div');
  el.className = 'fx-ping';
  el.style.left = (x * CELL_PX) + 'px';
  el.style.top = (y * CELL_PX) + 'px';
  el.style.width = ((w || 1) * CELL_PX) + 'px';
  el.style.height = ((h || 1) * CELL_PX) + 'px';
  el.innerHTML = '<i></i><i></i>';
  grid.appendChild(el);
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 4200);
}
