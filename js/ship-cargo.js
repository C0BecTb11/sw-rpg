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
    el.textContent = 'Трюм: ' + used + ' из ' + cap + ' слотов';
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
    if (!res.data || res.data.length === 0) {
      list.innerHTML = '<div class="cargo-empty">В зоне высадки этой планеты нет твоих войск</div>';
      return;
    }
    list.innerHTML = '';
    res.data.forEach(function(row) {
      list.appendChild(makeShipCargoRow(row, row.available, 'Погрузить', row.slot_size));
    });
  });
}

function renderCargo() {
  supabase.from('ship_cargo').select('*, unit_types(name, image, slot_size)')
    .eq('ship_id', cargoShip.id).gt('quantity', 0)
    .then(function(res) {
      var list = document.getElementById('shipcargo-list');
      if (res.error || !res.data || res.data.length === 0) {
        list.innerHTML = '<div class="cargo-empty">Трюм пуст</div>';
        return;
      }
      list.innerHTML = '';
      res.data.forEach(function(row) {
        var t = row.unit_types || {};
        list.appendChild(makeShipCargoRow({
          unit_type: row.unit_type, name: t.name, image: t.image
        }, row.quantity, 'Высадить', t.slot_size || 1));
      });
    });
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
