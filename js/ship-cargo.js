// Панель трюма корабля: погрузка войск с планеты и высадка обратно.
// Все правила держит сервер — здесь только выбор и отображение.

var cargoShip = null;
var cargoShipType = null;
var cargoTab = 'load';   // 'load' | 'unload'

function openShipCargo(ship, type) {
  cargoShip = ship;
  cargoShipType = type || {};
  cargoTab = 'load';

  document.getElementById('shipcargo-name').textContent = cargoShipType.name || 'Корабль';
  document.getElementById('shipcargo-panel').style.display = 'flex';
  setCargoTab('load');
}

function closeShipCargo() {
  document.getElementById('shipcargo-panel').style.display = 'none';
  cargoShip = null;
}

function setCargoTab(tab) {
  cargoTab = tab;
  document.getElementById('shipcargo-tab-load').className =
    'shipcargo-tab' + (tab === 'load' ? ' active' : '');
  document.getElementById('shipcargo-tab-unload').className =
    'shipcargo-tab' + (tab === 'unload' ? ' active' : '');

  document.getElementById('shipcargo-list').innerHTML =
    '<div class="cargo-empty">Загрузка...</div>';

  updateShipCapacity();
  if (tab === 'load') renderLoadable(); else renderCargo();
}

function updateShipCapacity() {
  var el = document.getElementById('shipcargo-capacity');
  supabase.rpc('ship_load_used', { p_ship_id: cargoShip.id }).then(function(res) {
    var used = (!res.error && typeof res.data === 'number') ? res.data : 0;
    var cap = cargoShipType.capacity || 0;
    var freeSlots = Math.max(0, cap - used);
    el.textContent = 'Трюм: ' + used + ' из ' + cap + ' слотов' +
      (freeSlots ? ' · свободно ' + freeSlots +
                   ' (это ' + (freeSlots * 2) + ' ед. ресурса)' : '');
    el.className = used >= cap ? 'cargo-capacity full' : 'cargo-capacity';
  });
}

// Что доступно к погрузке, решает сервер: только свои юниты и только
// из зоны высадки той планеты, над которой стоит корабль.
function renderLoadable() {
  supabase.rpc('get_ship_loadable', { p_ship_id: cargoShip.id }).then(function(res) {
    var list = document.getElementById('shipcargo-list');
    if (res.error) {
      list.innerHTML = '<div class="cargo-empty">' + res.error.message + '</div>';
      return;
    }
    // Войск может не быть, а склад при этом полон — ресурсы показываем всё равно
    if (!res.data || res.data.length === 0) {
      list.innerHTML = '<div class="cargo-empty">В зоне высадки этой планеты нет твоих войск</div>';
      renderLoadableResources(list);
      renderMarketPickup(list);
      return;
    }
    list.innerHTML = '';
    res.data.forEach(function(row) {
      list.appendChild(makeShipCargoRow(row, row.available, 'Погрузить', row.slot_size));
    });
    renderLoadableResources(list);
    renderMarketPickup(list);
  });
}

// Склад планеты, над которой стоит корабль. Сервер отдаёт запас только
// тому, кто держит планету, поэтому чужой склад сюда просто не придёт.
function renderLoadableResources(list) {
  if (!cargoShip || !cargoShip.system_id) return;

  supabase.rpc('get_planet_stock', { p_system_id: cargoShip.system_id })
    .then(function(res) {
      if (res.error || !res.data) return;

      var rows = res.data.filter(function(r) { return r.amount > 0; });
      if (!rows.length) return;

      list.appendChild(makeCargoSection('Склад планеты'));
      rows.forEach(function(r) {
        list.appendChild(makeResourceCargoRow(r.resource, r.name, r.amount, 'Погрузить'));
      });
    });
}

// Купленное на рынке лежит на чужой планете и вывозится отдельной кнопкой:
// право грузиться там даёт бронь, а не контроль над планетой.
function renderMarketPickup(list) {
  if (!cargoShip || !cargoShip.system_id) return;

  supabase.rpc('get_my_market_orders').then(function(res) {
    if (res.error || !res.data) return;

    var here = res.data.filter(function(o) {
      return o.system_id === cargoShip.system_id && o.amount_left > 0;
    });
    if (!here.length) return;

    list.appendChild(makeCargoSection('Куплено — забрать'));

    here.forEach(function(o) {
      var row = document.createElement('div');
      row.className = 'cargo-row cargo-resource cargo-bought';

      var info = document.createElement('div');
      info.className = 'cargo-info';
      info.innerHTML =
        '<div class="cargo-name">' + o.resource_name + '</div>' +
        '<div class="cargo-available">Оплачено: ' + o.amount_left +
          ' · бронь истекает через ' + formatCargoLeft(o.seconds_left) + '</div>';

      // Берём частями: если трюм неполон, глупо отказывать во всём заказе.
      // Остаток брони останется ждать второй ходки.
      var controls = document.createElement('div');
      controls.className = 'cargo-controls';

      var qty = document.createElement('div');
      qty.className = 'cargo-qty';

      var minus = document.createElement('button');
      minus.className = 'cargo-qty-btn'; minus.textContent = '−';
      var val = document.createElement('span');
      val.className = 'cargo-qty-value'; val.textContent = o.amount_left;
      var plus = document.createElement('button');
      plus.className = 'cargo-qty-btn'; plus.textContent = '+';

      minus.addEventListener('click', function() {
        val.textContent = Math.max(1, parseInt(val.textContent, 10) - 10);
      });
      plus.addEventListener('click', function() {
        val.textContent = Math.min(o.amount_left, parseInt(val.textContent, 10) + 10);
      });

      qty.appendChild(minus); qty.appendChild(val); qty.appendChild(plus);
      controls.appendChild(qty);

      var act = document.createElement('button');
      act.className = 'cargo-action';
      act.textContent = 'Вывезти';
      act.addEventListener('click', function() {
        act.disabled = true;
        supabase.rpc('load_market_order', {
          p_ship_id: cargoShip.id,
          p_order_id: o.order_id,
          p_amount: parseInt(val.textContent, 10)
        }).then(function(r2) {
          act.disabled = false;
          if (r2.error) { alert(r2.error.message); return; }
          setCargoTab(cargoTab);
        });
      });

      controls.appendChild(act);
      info.appendChild(controls);
      row.appendChild(info);
      list.appendChild(row);
    });
  });
}

function formatCargoLeft(sec) {
  if (sec >= 3600) return Math.floor(sec / 3600) + ' ч';
  if (sec >= 60) return Math.floor(sec / 60) + ' мин';
  return sec + ' с';
}

function renderCargo() {
  // Трюм это не только ship_cargo: пехота лежит там счётчиком, а техника
  // отдельными строками — иначе гружёная канонерка не помнила бы своих
  // пассажиров. Собираем обе части одной функцией.
  Promise.all([
    supabase.rpc('get_ship_holds'),
    supabase.rpc('get_carried_units', { p_carrier_unit_id: null, p_ship_id: cargoShip.id }),
    supabase.rpc('get_ship_resource_cargo', { p_ship_id: cargoShip.id })
  ]).then(function(r) {
    var list = document.getElementById('shipcargo-list');

    var holds = (!r[0].error && r[0].data) ? r[0].data : [];
    var mine = holds.filter(function(h) { return h.ship_id === cargoShip.id; });
    var vehicles = (!r[1].error && r[1].data) ? r[1].data : [];

    var cargoRes = (!r[2].error && r[2].data) ? r[2].data : [];

    if (!mine.length && !vehicles.length && !cargoRes.length) {
      list.innerHTML = '<div class="cargo-empty">Трюм пуст</div>';
      return;
    }

    list.innerHTML = '';

    // Техника идёт первой: она занимает больше места и её положение важнее
    vehicles.forEach(function(v) {
      list.appendChild(makeVehicleCargoRow(v));
    });

    mine.filter(function(h) { return !h.is_vehicle; }).forEach(function(h) {
      list.appendChild(makeShipCargoRow({
        unit_type: h.unit_type, name: h.unit_name, image: h.unit_image
      }, h.quantity, 'Высадить', h.slots / Math.max(1, h.quantity)));
    });

    if (cargoRes.length) {
      list.appendChild(makeCargoSection('Груз'));
      cargoRes.forEach(function(c) {
        list.appendChild(makeResourceCargoRow(c.resource, c.name, c.amount, 'Выгрузить'));
      });
    }
  });
}

function makeCargoSection(title) {
  var head = document.createElement('div');
  head.className = 'cargo-section';
  head.textContent = title;
  return head;
}

// Ресурс считается десятками, поэтому шаг у счётчика крупнее, чем у войск,
// и есть кнопка «всё» — иначе набирать сотню рудой по единице невозможно.
function makeResourceCargoRow(resourceId, label, available, actionLabel) {
  var row = document.createElement('div');
  row.className = 'cargo-row cargo-resource';

  var info = document.createElement('div');
  info.className = 'cargo-info';

  var name = document.createElement('div');
  name.className = 'cargo-name';
  name.textContent = label;
  info.appendChild(name);

  var avail = document.createElement('div');
  avail.className = 'cargo-available';
  avail.textContent = 'Доступно: ' + available + ' · 2 единицы на слот';
  info.appendChild(avail);

  var controls = document.createElement('div');
  controls.className = 'cargo-controls';

  var qty = document.createElement('div');
  qty.className = 'cargo-qty';

  var minus = document.createElement('button');
  minus.className = 'cargo-qty-btn';
  minus.textContent = '−';

  var val = document.createElement('span');
  val.className = 'cargo-qty-value';
  val.textContent = Math.min(10, available);

  var plus = document.createElement('button');
  plus.className = 'cargo-qty-btn';
  plus.textContent = '+';

  var all = document.createElement('button');
  all.className = 'cargo-qty-btn';
  all.textContent = 'всё';

  minus.addEventListener('click', function() {
    val.textContent = Math.max(1, parseInt(val.textContent, 10) - 10);
  });
  plus.addEventListener('click', function() {
    val.textContent = Math.min(available, parseInt(val.textContent, 10) + 10);
  });
  all.addEventListener('click', function() {
    val.textContent = available;
  });

  qty.appendChild(minus); qty.appendChild(val); qty.appendChild(plus); qty.appendChild(all);
  controls.appendChild(qty);

  var act = document.createElement('button');
  act.className = 'cargo-action';
  act.textContent = actionLabel;
  act.addEventListener('click', function() {
    var n = parseInt(val.textContent, 10);
    act.disabled = true;

    var fn = cargoTab === 'load' ? 'load_resource_to_ship' : 'unload_resource_from_ship';
    supabase.rpc(fn, {
      p_ship_id: cargoShip.id,
      p_resource: resourceId,
      p_amount: n
    }).then(function(res) {
      act.disabled = false;
      if (res.error) { alert(res.error.message); return; }
      setCargoTab(cargoTab);
    });
  });
  controls.appendChild(act);

  info.appendChild(controls);
  row.appendChild(info);
  return row;
}

// У техники нет счётчика: каждая машина отдельная, со своей прочностью
// и своим десантом внутри
function makeVehicleCargoRow(v) {
  var row = document.createElement('div');
  row.className = 'cargo-row cargo-vehicle';

  var thumb = document.createElement('div');
  thumb.className = 'cargo-thumb';
  if (v.unit_image) {
    var img = document.createElement('img');
    img.src = '../' + v.unit_image;
    img.alt = '';
    thumb.appendChild(img);
  }
  row.appendChild(thumb);

  var info = document.createElement('div');
  info.className = 'cargo-info';

  var name = document.createElement('div');
  name.className = 'cargo-name';
  name.textContent = v.unit_name + (v.passengers ? ' · десант ' + v.passengers : '');
  info.appendChild(name);

  var avail = document.createElement('div');
  avail.className = 'cargo-available';
  avail.textContent = 'Прочность ' + v.hp + ' · занимает ' + v.slots + ' слотов';
  info.appendChild(avail);

  var btn = document.createElement('button');
  btn.className = 'cargo-action';
  btn.textContent = 'Высадить';
  btn.addEventListener('click', function() {
    btn.disabled = true;
    supabase.rpc('unload_vehicle_auto', { p_unit_id: v.unit_id }).then(function(res) {
      btn.disabled = false;
      if (res.error) { alert(res.error.message); return; }
      renderCargo();
      if (typeof loadShips === 'function') loadShips();
    });
  });

  info.appendChild(btn);
  row.appendChild(info);
  return row;
}

function makeShipCargoRow(unit, available, actionLabel, slotSize) {
  var row = document.createElement('div');
  row.className = 'cargo-row';

  var thumb = document.createElement('div');
  thumb.className = 'cargo-thumb';
  if (unit.image) {
    var img = document.createElement('img');
    img.src = '../' + unit.image;
    img.alt = '';
    thumb.appendChild(img);
  }
  row.appendChild(thumb);

  var info = document.createElement('div');
  info.className = 'cargo-info';

  var name = document.createElement('div');
  name.className = 'cargo-name';
  name.textContent = unit.name || unit.unit_type;
  info.appendChild(name);

  var avail = document.createElement('div');
  avail.className = 'cargo-available';
  avail.textContent = 'Доступно: ' + available +
    (slotSize > 1 ? ' · ' + slotSize + ' слота каждый' : '');
  info.appendChild(avail);

  var controls = document.createElement('div');
  controls.className = 'cargo-controls';

  var qty = document.createElement('div');
  qty.className = 'cargo-qty';
  var minus = document.createElement('button');
  minus.className = 'cargo-qty-btn';
  minus.textContent = '−';
  var val = document.createElement('span');
  val.className = 'cargo-qty-value';
  val.textContent = '1';
  var plus = document.createElement('button');
  plus.className = 'cargo-qty-btn';
  plus.textContent = '+';

  minus.addEventListener('click', function() {
    val.textContent = Math.max(1, parseInt(val.textContent, 10) - 1);
  });
  plus.addEventListener('click', function() {
    val.textContent = Math.min(available, parseInt(val.textContent, 10) + 1);
  });

  qty.appendChild(minus); qty.appendChild(val); qty.appendChild(plus);
  controls.appendChild(qty);

  var act = document.createElement('button');
  act.className = 'cargo-action';
  act.textContent = actionLabel;
  act.addEventListener('click', function() {
    var n = parseInt(val.textContent, 10);
    act.disabled = true;
    var fn = cargoTab === 'load' ? 'load_to_ship' : 'unload_from_ship';
    supabase.rpc(fn, {
      p_ship_id: cargoShip.id,
      p_unit_type: unit.unit_type,
      p_quantity: n
    }).then(function(res) {
      act.disabled = false;
      if (res.error) {
        alert(res.error.message);
        return;
      }
      setCargoTab(cargoTab);
      if (typeof loadArmyData === 'function') loadArmyData();
    });
  });
  controls.appendChild(act);

  info.appendChild(controls);
  row.appendChild(info);
  return row;
}

document.addEventListener('DOMContentLoaded', function() {
  var close = document.getElementById('shipcargo-close');
  if (close) close.addEventListener('click', closeShipCargo);

  var tl = document.getElementById('shipcargo-tab-load');
  if (tl) tl.addEventListener('click', function() { setCargoTab('load'); });

  var tu = document.getElementById('shipcargo-tab-unload');
  if (tu) tu.addEventListener('click', function() { setCargoTab('unload'); });
});
