// Панель управления фракции — доступна только лидеру (кнопка открытия уже
// проверена в faction-panel.js, но реальная защита — на уровне RLS в БД:
// system_control можно писать, только если auth.uid() совпадает с
// leader_user_id в faction_leadership для фракции данной планеты).
//
// Передаётся только планета: право строить и нанимать следует за контролем
// над системой. Войска, корабли и уже оплаченные заказы производства
// остаются за своими хозяевами — смена управляющего их не касается.

function openFactionControlScreen() {
  var screen = document.getElementById('faction-control-screen');
  var listEl = document.getElementById('faction-control-list');
  listEl.innerHTML = '<div class="army-empty">Загрузка...</div>';
  screen.style.display = 'block';

  if (!currentPlayerFaction) return;

  Promise.all([
    supabase.rpc('get_faction_systems'),
    supabase.from('profiles').select('id, nickname').eq('faction', currentPlayerFaction)
  ]).then(function(results) {
    var systemsRes = results[0];
    var membersRes = results[1];

    if (systemsRes.error || !systemsRes.data) {
      listEl.innerHTML = '<div class="army-empty">Не удалось загрузить планеты</div>';
      return;
    }

    var members = membersRes.error ? [] : membersRes.data;
    var systems = systemsRes.data;

    listEl.innerHTML = '';

    if (systems.length === 0) {
      listEl.innerHTML = '<div class="army-empty">У фракции пока нет планет</div>';
      return;
    }

    // Свежезахваченные идут первыми — их выдаёт сервер в начале списка.
    // Заголовок ставим один раз, перед первой обычной планетой.
    var pendingCount = systems.filter(function(s) { return s.pending; }).length;
    var headerDone = false;

    if (pendingCount > 0) {
      var capTitle = document.createElement('div');
      capTitle.className = 'faction-control-group';
      capTitle.textContent = 'Захвачено, ждёт распределения';
      listEl.appendChild(capTitle);
    }

    systems.forEach(function(system) {
      if (!system.pending && pendingCount > 0 && !headerDone) {
        var restTitle = document.createElement('div');
        restTitle.className = 'faction-control-group';
        restTitle.textContent = 'Остальные планеты';
        listEl.appendChild(restTitle);
        headerDone = true;
      }

      var row = document.createElement('div');
      row.className = 'faction-control-row' + (system.pending ? ' pending' : '');

      var name = document.createElement('div');
      name.className = 'faction-control-planet-name';
      name.textContent = system.name;

      // Голая цифра построек ничего не говорит: «2» над Кристофсисом
      // не объясняет, что там стоит. Прячем подробности за стрелкой —
      // назначение остаётся на виду, а заглянуть можно по желанию.
      if (system.buildings > 0) {
        var toggle = document.createElement('button');
        toggle.className = 'faction-control-toggle';
        toggle.innerHTML = '<span class="fc-arrow">▸</span> что построено · ' + system.buildings;
        name.appendChild(toggle);
      }

      row.appendChild(name);

      var details = document.createElement('div');
      details.className = 'faction-control-details';
      details.style.display = 'none';
      row.appendChild(details);

      if (system.buildings > 0) {
        var loaded = false;
        toggle.addEventListener('click', function() {
          var open = details.style.display !== 'none';
          details.style.display = open ? 'none' : 'block';
          toggle.querySelector('.fc-arrow').textContent = open ? '▸' : '▾';

          if (open || loaded) return;
          loaded = true;
          details.innerHTML = '<div class="fc-detail-empty">Загрузка...</div>';

          supabase.rpc('get_system_summary', { p_system_id: system.system_id })
            .then(function(res) {
              if (res.error || !res.data || !res.data.length) {
                details.innerHTML = '<div class="fc-detail-empty">Пусто</div>';
                return;
              }
              details.innerHTML = '';
              res.data.forEach(function(item) {
                var line = document.createElement('div');
                line.className = 'fc-detail' + (item.captured ? ' captured' : '');
                line.innerHTML =
                  '<span>' + (item.kind === 'station' ? '◇ ' : '▪ ') + item.name + '</span>' +
                  '<em>' + item.building_state + '</em>';
                details.appendChild(line);
              });
            });
        });
      }

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
        if (system.controller_user_id === member.id) option.selected = true;
        select.appendChild(option);
      });

      row.appendChild(select);

      var status = document.createElement('div');
      status.className = 'faction-control-status';
      if (system.pending) {
        status.textContent = 'Новая планета — назначь управляющего';
      }
      row.appendChild(status);

      select.addEventListener('change', function() {
        var newControllerId = select.value || null;
        var previous = system.controller_user_id;

        // Смена управляющего у обжитой планеты — решение серьёзное:
        // прежний хозяин потеряет доступ к своим же постройкам
        if (previous && previous !== newControllerId && !system.pending) {
          var who = members.filter(function(m) { return m.id === previous; })[0];
          var ok = confirm('Передать ' + system.name + '?\n\n' +
            (who ? who.nickname : 'Прежний управляющий') +
            ' потеряет право строить и нанимать на этой планете. ' +
            'Постройки останутся, войска и заказы производства — тоже за ним.');
          if (!ok) {
            select.value = previous || '';
            return;
          }
        }

        status.textContent = 'Сохраняем...';

        var hasExisting = system.controller_user_id !== null
                       && system.controller_user_id !== undefined;

        var query = hasExisting
          ? supabase.from('system_control')
              .update({ controller_user_id: newControllerId }).eq('system_id', system.system_id)
          : supabase.from('system_control')
              .insert({ system_id: system.system_id, controller_user_id: newControllerId });

        query.then(function(res) {
          if (res.error) {
            status.textContent = 'Ошибка: ' + res.error.message;
            return;
          }
          system.controller_user_id = newControllerId;
          row.classList.remove('pending');
          status.textContent = 'Сохранено';
          setTimeout(function() { status.textContent = ''; }, 2000);
        });
      });

      listEl.appendChild(row);
    });
  });
}

function closeFactionControlScreen() {
  document.getElementById('faction-control-screen').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  var closeBtn = document.getElementById('faction-control-close');
  if (closeBtn) closeBtn.addEventListener('click', closeFactionControlScreen);
});
