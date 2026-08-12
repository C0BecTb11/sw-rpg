// Панель управления фракции — доступна только лидеру (кнопка открытия уже
// проверена в faction-panel.js, но реальная защита — на уровне RLS в БД:
// system_control можно писать, только если auth.uid() совпадает с
// leader_user_id в faction_leadership для фракции данной планеты).

function openFactionControlScreen() {
  var screen = document.getElementById('faction-control-screen');
  var listEl = document.getElementById('faction-control-list');
  listEl.innerHTML = '<div class="army-empty">Загрузка...</div>';
  screen.style.display = 'block';

  if (!currentPlayerFaction) return;

  Promise.all([
    supabase.from('systems').select('id, name').eq('faction', currentPlayerFaction),
    supabase.from('profiles').select('id, nickname').eq('faction', currentPlayerFaction),
    supabase.from('system_control').select('system_id, controller_user_id')
  ]).then(function(results) {
    var systemsRes = results[0];
    var membersRes = results[1];
    var controlRes = results[2];

    if (systemsRes.error || !systemsRes.data) {
      listEl.innerHTML = '<div class="army-empty">Не удалось загрузить планеты</div>';
      return;
    }

    var members = membersRes.error ? [] : membersRes.data;
    var controlMap = {};
    if (!controlRes.error && controlRes.data) {
      controlRes.data.forEach(function(row) {
        controlMap[row.system_id] = row.controller_user_id;
      });
    }

    listEl.innerHTML = '';
    systemsRes.data.forEach(function(system) {
      var row = document.createElement('div');
      row.className = 'faction-control-row';

      var name = document.createElement('div');
      name.className = 'faction-control-planet-name';
      name.textContent = system.name;
      row.appendChild(name);

      var select = document.createElement('select');
      select.className = 'faction-control-select';

      var noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = '— не назначен —';
      select.appendChild(noneOption);

      members.forEach(function(member) {
        var option = document.createElement('option');
        option.value = member.id;
        option.textContent = member.nickname;
        if (controlMap[system.id] === member.id) {
          option.selected = true;
        }
        select.appendChild(option);
      });

      row.appendChild(select);

      var status = document.createElement('div');
      status.className = 'faction-control-status';
      row.appendChild(status);

      select.addEventListener('change', function() {
        var newControllerId = select.value || null;
        status.textContent = 'Сохраняем...';

        var hasExisting = Object.prototype.hasOwnProperty.call(controlMap, system.id);
        var query = hasExisting
          ? supabase.from('system_control').update({ controller_user_id: newControllerId }).eq('system_id', system.id)
          : supabase.from('system_control').insert({ system_id: system.id, controller_user_id: newControllerId });

        query.then(function(res) {
          if (res.error) {
            status.textContent = 'Ошибка: ' + res.error.message;
            return;
          }
          controlMap[system.id] = newControllerId;
          status.textContent = 'Сохранено';
          setTimeout(function() { status.textContent = ''; }, 2000);
        });
      });

      listEl.appendChild(row);
    });

    if (systemsRes.data.length === 0) {
      listEl.innerHTML = '<div class="army-empty">У фракции пока нет планет</div>';
    }
  });
}

function closeFactionControlScreen() {
  document.getElementById('faction-control-screen').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  var closeBtn = document.getElementById('faction-control-close');
  if (closeBtn) closeBtn.addEventListener('click', closeFactionControlScreen);
});
