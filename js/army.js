// Экран "Армия": список юнитов игрока и 5 слотов командиров
// (разблокированные показывают текущую систему, заблокированные — затемнены).

function openArmyScreen() {
  var screen = document.getElementById('army-screen');
  screen.style.display = 'block';
  loadArmyData();
}

function closeArmyScreen() {
  document.getElementById('army-screen').style.display = 'none';
}

function loadArmyData() {
  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    var userId = res.data.session.user.id;

    loadUnits(userId);
    loadCommanders(userId);
  });
}

function loadUnits(userId) {
  var listEl = document.getElementById('army-units-list');

  supabase.from('army_units').select('*').eq('user_id', userId).gt('quantity', 0).then(function(res) {
    if (res.error || !res.data || res.data.length === 0) {
      listEl.innerHTML = '<div class="army-empty">Пока нет созданных юнитов</div>';
      return;
    }

    listEl.innerHTML = '';
    res.data.forEach(function(unit) {
      var row = document.createElement('div');
      row.className = 'army-unit-row';

      var icon = document.createElement('div');
      icon.className = 'army-unit-icon';
      icon.textContent = '⚙';
      row.appendChild(icon);

      var name = document.createElement('div');
      name.className = 'army-unit-name';
      name.textContent = unit.unit_name;
      row.appendChild(name);

      var count = document.createElement('div');
      count.className = 'army-unit-count';
      count.textContent = '×' + unit.quantity;
      row.appendChild(count);

      listEl.appendChild(row);
    });
  });
}

function loadCommanders(userId) {
  var listEl = document.getElementById('army-commanders-list');

  supabase.from('commanders').select('*').eq('user_id', userId).order('slot_index').then(function(res) {
    if (res.error || !res.data) return;

    listEl.innerHTML = '';
    res.data.forEach(function(commander) {
      var row = document.createElement('div');
      row.className = 'commander-row' + (commander.unlocked ? '' : ' locked');

      var icon = document.createElement('div');
      icon.className = 'commander-icon';
      icon.textContent = '♟';
      icon.style.color = commander.unlocked ? '#5fd968' : '#55606c';
      icon.style.borderColor = commander.unlocked ? '#5fd968' : '#2a3644';
      row.appendChild(icon);

      var info = document.createElement('div');
      info.className = 'commander-info';

      var name = document.createElement('div');
      name.className = 'commander-name';
      name.textContent = commander.name;
      info.appendChild(name);

      var status = document.createElement('div');
      status.className = 'commander-status';
      status.textContent = commander.unlocked
        ? ('В системе: ' + (commander.current_system || '—'))
        : 'Заблокирован';
      info.appendChild(status);

      row.appendChild(info);
      listEl.appendChild(row);
    });
  });
}

document.addEventListener('DOMContentLoaded', function() {
  var armyButton = document.getElementById('panel-item-army');
  var closeButton = document.getElementById('army-screen-close');

  if (armyButton) armyButton.addEventListener('click', openArmyScreen);
  if (closeButton) closeButton.addEventListener('click', closeArmyScreen);
});
