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
    supabase.from('commander_inventory').select('*, unit_types(name, image)')
  ]).then(function(results) {
    var commandersRes = results[0];
    var systemsRes = results[1];
    var invRes = results[2];
    if (commandersRes.error || !commandersRes.data) return;

    var systemNames = {};
    (systemsRes.data || []).forEach(function(s) { systemNames[s.id] = s.name; });

    var invByCommander = {};
    (invRes.data || []).forEach(function(row) {
      if (row.quantity <= 0) return;
      if (!invByCommander[row.commander_id]) invByCommander[row.commander_id] = [];
      invByCommander[row.commander_id].push(row);
    });

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
        var inv = document.createElement('div');
        inv.className = 'commander-inventory';

        var invTitle = document.createElement('div');
        invTitle.className = 'inventory-title';
        invTitle.textContent = 'Отряд';
        inv.appendChild(invTitle);

        var items = invByCommander[c.id] || [];
        if (items.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'inventory-empty';
          empty.textContent = 'пусто';
          inv.appendChild(empty);
        } else {
          var grid = document.createElement('div');
          grid.className = 'inventory-grid';
          items.forEach(function(it) {
            grid.appendChild(makeUnitChip(it.unit_types, it.quantity));
          });
          inv.appendChild(grid);
        }
        row.appendChild(inv);
      }

      listEl.appendChild(row);
    });
  });
}

// Войска по планетам. Читаем реальные позиции юнитов на картах и группируем
// по системе: один боец — одна строка в БД, поэтому количество считаем сами.
function loadGarrisons(userId) {
  var listEl = document.getElementById('army-garrisons-list');
  if (!listEl) return;

  Promise.all([
    supabase.from('unit_positions').select('system_id, unit_type').eq('owner_user_id', userId),
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
