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

  var hpPct = Math.max(0, Math.min(100, (scShip.hp / scType.max_hp) * 100));
  document.getElementById('sc-hp-num').textContent = scShip.hp + ' / ' + scType.max_hp;
  document.getElementById('sc-hp-fill').style.width = hpPct + '%';

  document.getElementById('sc-props').innerHTML =
    '<span title="урон">◎ ' + (scType.damage || 0) + '</span>' +
    '<span title="дальность огня">➶ ' + (scType.weapon_range || 0) + '</span>' +
    '<span title="ход">⇢ ' + (scType.move_range || 0) + '</span>' +
    '<span title="обзор">◈ ' + (scType.vision_range || 0) + '</span>';

  scRenderTabs();

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
  if (scType.hangar_slots > 0 || scType.is_fighter) tabs.push({ id: 'hangar', label: 'Ангар' });
  tabs.push({ id: 'info', label: 'Описание' });

  // Вкладка могла исчезнуть при смене корабля — тогда возвращаемся к действиям
  if (!tabs.some(function(t) { return t.id === scTab; })) scTab = 'actions';

  box.innerHTML = '';
  tabs.forEach(function(t) {
    var b = document.createElement('button');
    b.className = 'sc-tab' + (scTab === t.id ? ' active' : '');
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
    supabase.rpc('get_carried_units', { p_carrier_unit_id: null, p_ship_id: forShip })
  ]).then(function(r) {
    if (!scShip || scShip.id !== forShip || scTab !== 'cargo') return;

    var holds = (!r[0].error && r[0].data) ? r[0].data : [];
    var mine = holds.filter(function(h) { return h.ship_id === forShip && !h.is_vehicle; });
    var vehicles = (!r[1].error && r[1].data) ? r[1].data : [];

    var used = 0;
    holds.forEach(function(h) { if (h.ship_id === forShip) used += (h.slots || 0); });

    box.innerHTML = '<div class="sc-hangar-head">Трюм · ' +
      used + ' из ' + (scType.capacity || 0) + '</div>';

    if (!mine.length && !vehicles.length) {
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

    var note = document.createElement('div');
    note.className = 'sc-hangar-empty';
    note.textContent = 'На чужой планете высадка идёт поштучно с наземной карты';
    box.appendChild(note);
  });
}

function scRenderTiles() {
  var tiles = document.getElementById('sc-tiles');
  var info = document.getElementById('sc-abil-info');
  if (!tiles || !info) return;

  var st = scApState(scShip);
  var canAct = st.ap >= 1;
  var inBand = false;

  tiles.innerHTML = '';

  var add = function(key, icon, label, enabled, onPick) {
    var b = document.createElement('button');
    b.className = 'sc-tile' + (scMode === key ? ' active' : '') + (enabled ? '' : ' locked');
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

  if (!scMode) {
    describe('Действия', 'Выбери, что делает корабль.',
      st.ap >= st.apMax ? 'действия готовы' : '+1 через ' + st.nextIn + ' с');
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
  if (!scType.hangar_slots) {
    box.innerHTML = '';
    if (scType.is_fighter) scRenderFighterActions(box);
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
function scRenderFighterActions(box) {
  box.innerHTML = '<div class="sc-hangar-head">Носитель</div>';

  if (!scShip) return;
  var forShip = scShip.id;

  var loading = document.createElement('div');
  loading.className = 'sc-hangar-empty';
  loading.textContent = 'Ищем носитель…';
  box.appendChild(loading);

  supabase.rpc('get_recall_carriers', { p_fighter_id: forShip }).then(function(res) {
    if (!scShip || scShip.id !== forShip || scTab !== 'hangar') return;

    var list = (!res.error && res.data) ? res.data : [];
    box.innerHTML = '<div class="sc-hangar-head">Носитель</div>';

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

function scStartLand(f) {
  scHangarPick = f;
  scHangarMode = 'land';
  scSetMode(null);

  var hint = document.getElementById('sc-hint');
  hint.textContent = 'Посадка идёт на наземной карте — открой её и выбери клетку';
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
  scHangarMode = null;
  scHangarPick = null;
  scTargets = [];
  scPreview = null;

  var hud = document.getElementById('ship-hud');
  if (hud) hud.classList.remove('mode-move', 'mode-rotate', 'mode-attack', 'mode-hangar');

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
    hud.classList.remove('mode-move', 'mode-rotate', 'mode-attack', 'mode-hangar');
    if (mode) hud.classList.add('mode-' + mode);
  }
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
