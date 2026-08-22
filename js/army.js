// Экран "Армия": сверху командиры со своим инвентарём (то, что они возят
// с собой между планетами), ниже — войска, стоящие по планетам.

function openArmyScreen() {
  document.getElementById('army-screen').style.display = 'block';
  loadArmyData();
}

function closeArmyScreen() {
  document.getElementById('army-screen').style.display = 'none';
}

function loadArmyData() {
  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    var userId = res.data.session.user.id;
    loadCommanders(userId);
    loadGarrisons(userId);
  });
}

function loadCommanders(userId) {
  var listEl = document.getElementById('army-commanders-list');

  Promise.all([
    supabase.from('commanders').select('*').eq('user_id', userId).order('slot_index'),
    supabase.from('systems').select('id, name'),
    supabase.from('ships').select('*, ship_types(name, image, capacity)').eq('owner_user_id', userId),
    // Трюм — это не только пехота из ship_cargo: техника лежит строками
    // в unit_positions, и без неё загруженная канонерка пропадала из виду
    supabase.rpc('get_ship_holds')
  ]).then(function(results) {
    var commandersRes = results[0];
    var systemsRes = results[1];
    var shipsRes = results[2];
    var cargoRes = results[3];
    if (commandersRes.error || !commandersRes.data) return;

    var ships = shipsRes.error ? [] : (shipsRes.data || []);
    var cargoByShip = {};
    (cargoRes.data || []).forEach(function(c) {
      if (c.quantity <= 0) return;
      if (!cargoByShip[c.ship_id]) cargoByShip[c.ship_id] = [];
      cargoByShip[c.ship_id].push(c);
    });

    var shipsByCommander = {};
    ships.forEach(function(sh) {
      var key = sh.commander_id || 'free';
      if (!shipsByCommander[key]) shipsByCommander[key] = [];
      shipsByCommander[key].push(sh);
    });

    var systemNames = {};
    (systemsRes.data || []).forEach(function(s) { systemNames[s.id] = s.name; });

    listEl.innerHTML = '';

    commandersRes.data.forEach(function(c) {
      var row = document.createElement('div');
      row.className = 'commander-row' + (c.unlocked ? '' : ' locked');

      var head = document.createElement('div');
      head.className = 'commander-head';

      var icon = document.createElement('div');
      icon.className = 'commander-icon';
      icon.textContent = '♟';
      icon.style.color = c.unlocked ? '#5fd968' : '#55606c';
      icon.style.borderColor = c.unlocked ? '#5fd968' : '#2a3644';
      head.appendChild(icon);

      var info = document.createElement('div');
      info.className = 'commander-info';

      var name = document.createElement('div');
      name.className = 'commander-name';
      name.textContent = c.name;
      info.appendChild(name);

      var status = document.createElement('div');
      status.className = 'commander-status';
      if (!c.unlocked) {
        status.textContent = 'Заблокирован';
      } else if (c.moving_to) {
        status.textContent = 'В пути → ' + (systemNames[c.moving_to] || c.moving_to);
      } else {
        status.textContent = 'В системе: ' + (systemNames[c.current_system] || '—');
      }
      info.appendChild(status);
      head.appendChild(info);
      row.appendChild(head);

      if (c.unlocked) {
        // Флот командира: список кораблей, каждый раскрывается и показывает,
        // кто внутри. Так вся цепочка «командир → корабль → войска» видна
        // в одном месте, без отдельных разделов.
        row.appendChild(makeFleetSection(shipsByCommander[c.id] || [], cargoByShip, systemNames));

      }

      listEl.appendChild(row);
    });

    // Гарнизоны идут после командиров: командиры — главные действующие
    // лица, а гарнизон это фон. Каждая система свёрнута, иначе при трёх
    // кораблях на пяти планетах экран превращается в простыню.
    var free = shipsByCommander['free'] || [];
    if (free.length > 0) {
      var bySystem = {};
      free.forEach(function(sh) {
        if (!bySystem[sh.system_id]) bySystem[sh.system_id] = [];
        bySystem[sh.system_id].push(sh);
      });

      var sectionTitle = document.createElement('div');
      sectionTitle.className = 'garrison-section-title';
      sectionTitle.textContent = 'Гарнизоны';
      listEl.appendChild(sectionTitle);

      Object.keys(bySystem).sort(function(a, b) {
        return (systemNames[a] || a).localeCompare(systemNames[b] || b);
      }).forEach(function(sysId) {
        var group = bySystem[sysId];

        // Состав словами: «Венатор ×2, Тантив» — понятно, что стоит
        // в системе, не раскрывая список
        var counts = {};
        group.forEach(function(sh) {
          var nm = (sh.ship_types && sh.ship_types.name) || sh.ship_type;
          counts[nm] = (counts[nm] || 0) + 1;
        });
        var parts = Object.keys(counts).map(function(nm) {
          return counts[nm] > 1 ? nm + ' ×' + counts[nm] : nm;
        });

        var block = document.createElement('div');
        block.className = 'commander-row garrison-row';

        var head = document.createElement('button');
        head.className = 'commander-head garrison-head';
        head.innerHTML =
          '<span class="garrison-arrow">▸</span>' +
          '<div class="commander-info">' +
            '<div class="commander-name">' + (systemNames[sysId] || sysId) +
              '<span class="garrison-count">' + group.length + '</span></div>' +
            '<div class="commander-status">' + parts.join(', ') + '</div>' +
          '</div>';
        block.appendChild(head);

        var section = makeFleetSection(group, cargoByShip, systemNames);
        // Заголовок «Флот» внутри лишний: система уже названа сверху
        var inner = section.querySelector('.inventory-title');
        if (inner) inner.parentNode.removeChild(inner);
        section.style.display = 'none';
        block.appendChild(section);

        head.addEventListener('click', function() {
          var open = section.style.display !== 'none';
          section.style.display = open ? 'none' : 'block';
          head.querySelector('.garrison-arrow').textContent = open ? '▸' : '▾';
        });

        listEl.appendChild(block);
      });
    }

  });
}

// Раскрывающийся список кораблей: внутри каждого — его трюм.
function makeFleetSection(ships, cargoByShip, systemNames) {
  var wrap = document.createElement('div');
  wrap.className = 'fleet-section';

  var title = document.createElement('div');
  title.className = 'inventory-title';
  title.textContent = 'Флот';
  wrap.appendChild(title);

  if (ships.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'inventory-empty';
    empty.textContent = 'кораблей нет';
    wrap.appendChild(empty);
    return wrap;
  }

  ships.forEach(function(ship) {
    var type = ship.ship_types || {};
    var cargo = cargoByShip[ship.id] || [];
    // Место считаем слотами, а не головами: техника занимает больше,
    // а гружёная канонерка — ещё и за свой десант
    var used = cargo.reduce(function(a, c) { return a + (c.slots || c.quantity); }, 0);

    var block = document.createElement('div');
    block.className = 'ship-block';

    var header = document.createElement('button');
    header.className = 'ship-header';
    header.innerHTML =
      '<span class="garrison-arrow">▸</span>' +
      '<span class="ship-thumb"><img src="../' + (type.image || '') + '" alt=""></span>' +
      '<span class="ship-title">' + (type.name || ship.ship_type) +
        '<em>' + (ship.in_transit
            ? 'в гиперпространстве'
            : (systemNames[ship.system_id] || ship.system_id)) + '</em></span>' +
      '<span class="ship-capacity">' + used + '/' + (type.capacity || 0) + '</span>';
    block.appendChild(header);

    var body = document.createElement('div');
    body.className = 'garrison-body';
    body.style.display = 'none';

    // Управление трюмом прямо из списка флота: видно, что внутри,
    // и сразу можно догрузить или высадить.
    var manage = document.createElement('button');
    manage.className = 'ship-manage-btn';
    manage.textContent = 'Заполнить трюм';
    manage.addEventListener('click', function() {
      if (typeof openShipCargo === 'function') openShipCargo(ship, type);
    });
    body.appendChild(manage);

    if (cargo.length === 0) {
      var e = document.createElement('div');
      e.className = 'inventory-empty';
      e.textContent = 'трюм пуст';
      body.appendChild(e);
    } else {
      var grid = document.createElement('div');
      grid.className = 'inventory-grid';
      cargo.forEach(function(c) {
        // Поля приходят плоскими из get_ship_holds. У техники дописываем,
        // сколько десанта сидит внутри — иначе непонятно, почему она
        // занимает больше места, чем весит сама.
        var chip = makeUnitChip(
          { name: c.unit_name + (c.passengers ? ' +' + c.passengers : ''), image: c.unit_image },
          c.quantity);
        if (c.is_vehicle) chip.classList.add('cargo-vehicle');
        grid.appendChild(chip);
      });
      body.appendChild(grid);
    }
    block.appendChild(body);

    header.addEventListener('click', function() {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      header.querySelector('.garrison-arrow').textContent = open ? '▸' : '▾';
    });

    wrap.appendChild(block);
  });

  return wrap;
}

// Войска по планетам. Читаем реальные позиции юнитов на картах и группируем
// по системе: один боец — одна строка в БД, поэтому количество считаем сами.
function loadGarrisons(userId) {
  var listEl = document.getElementById('army-garrisons-list');
  if (!listEl) return;

  Promise.all([
    // Только те, кто реально стоит на земле: у сидящих в транспорте
    // и в трюме координат нет, иначе они считались бы дважды
    supabase.from('unit_positions').select('system_id, unit_type')
      .eq('owner_user_id', userId).not('x', 'is', null),
    supabase.from('systems').select('id, name'),
    supabase.from('unit_types').select('id, name, image')
  ]).then(function(results) {
    var unitsRes = results[0];
    var systemsRes = results[1];
    var typesRes = results[2];

    var systemNames = {};
    (systemsRes.data || []).forEach(function(s) { systemNames[s.id] = s.name; });

    var typeById = {};
    (typesRes.data || []).forEach(function(t) { typeById[t.id] = t; });

    if (unitsRes.error || !unitsRes.data || unitsRes.data.length === 0) {
      listEl.innerHTML = '<div class="army-empty">Войск на планетах пока нет</div>';
      return;
    }

    // { system_id: { unit_type: количество } }
    var bySystem = {};
    unitsRes.data.forEach(function(u) {
      if (!bySystem[u.system_id]) bySystem[u.system_id] = {};
      bySystem[u.system_id][u.unit_type] = (bySystem[u.system_id][u.unit_type] || 0) + 1;
    });

    listEl.innerHTML = '';
    Object.keys(bySystem).forEach(function(sysId) {
      var counts = bySystem[sysId];
      var total = Object.keys(counts).reduce(function(a, k) { return a + counts[k]; }, 0);

      var block = document.createElement('div');
      block.className = 'garrison-block';

      var header = document.createElement('button');
      header.className = 'garrison-header';
      header.innerHTML = '<span class="garrison-arrow">▸</span>' +
                         '<span class="garrison-name">' + (systemNames[sysId] || sysId) + '</span>' +
                         '<span class="garrison-total">' + total + '</span>';
      block.appendChild(header);

      var body = document.createElement('div');
      body.className = 'garrison-body';
      body.style.display = 'none';

      var grid = document.createElement('div');
      grid.className = 'inventory-grid';
      Object.keys(counts).forEach(function(typeId) {
        grid.appendChild(makeUnitChip(typeById[typeId], counts[typeId]));
      });
      body.appendChild(grid);
      block.appendChild(body);

      header.addEventListener('click', function() {
        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        header.querySelector('.garrison-arrow').textContent = open ? '▸' : '▾';
      });

      listEl.appendChild(block);
    });
  });
}

function makeUnitChip(type, quantity) {
  var chip = document.createElement('div');
  chip.className = 'unit-chip';

  var thumb = document.createElement('div');
  thumb.className = 'unit-chip-thumb';
  if (type && type.image) {
    var img = document.createElement('img');
    img.src = '../' + type.image;
    img.alt = '';
    thumb.appendChild(img);
  }
  chip.appendChild(thumb);

  var label = document.createElement('div');
  label.className = 'unit-chip-label';
  label.textContent = (type && type.name) || 'Юнит';
  chip.appendChild(label);

  var count = document.createElement('div');
  count.className = 'unit-chip-count';
  count.textContent = '×' + quantity;
  chip.appendChild(count);

  return chip;
}

document.addEventListener('DOMContentLoaded', function() {
  var armyButton = document.getElementById('panel-item-army');
  var closeButton = document.getElementById('army-screen-close');
  if (armyButton) armyButton.addEventListener('click', openArmyScreen);
  if (closeButton) closeButton.addEventListener('click', closeArmyScreen);
});
