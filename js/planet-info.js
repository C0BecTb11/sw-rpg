// Меню планеты: название, принадлежность фракции (видна всем — это не секрет,
// цвет подписи на карте её и так выдаёт), и кто из игроков контролирует систему —
// это поле реально скрыто от вражеской фракции на уровне RLS в БД (см.
// sql/system_control_create.sql), а не просто спрятано в интерфейсе.

var FACTION_NAMES_INFO = {
  republic: 'Республика',
  cis: 'КНС'
};

function openPlanetInfo(systemId) {
  var overlay = document.getElementById('planet-info-overlay');
  var nameEl = document.getElementById('planet-info-name');
  var factionEl = document.getElementById('planet-info-faction');
  var controllerEl = document.getElementById('planet-info-controller');

  nameEl.textContent = '...';
  factionEl.textContent = '';
  controllerEl.textContent = '';
  overlay.style.display = 'flex';

  Promise.all([
    supabase.from('systems').select('name, faction').eq('id', systemId).single(),
    supabase.from('system_control').select('controller_user_id').eq('system_id', systemId).maybeSingle()
  ]).then(function(results) {
    var systemRes = results[0];
    var controlRes = results[1];

    if (systemRes.error || !systemRes.data) {
      nameEl.textContent = 'Не удалось загрузить';
      return;
    }

    nameEl.textContent = systemRes.data.name;
    factionEl.textContent = 'Фракция: ' + (FACTION_NAMES_INFO[systemRes.data.faction] || '—');

    // Если RLS не дала доступа (чужая фракция) — controlRes.data будет пустым,
    // и это выглядит для игрока точно так же, как "контролёр не назначен":
    // нет способа отличить "скрыто" от "пусто" через интерфейс, что и требуется.
    if (!controlRes.error && controlRes.data && controlRes.data.controller_user_id) {
      supabase.from('profiles').select('nickname').eq('id', controlRes.data.controller_user_id).maybeSingle().then(function(profileRes) {
        var nickname = (profileRes.data && profileRes.data.nickname) || 'неизвестно';
        controllerEl.textContent = 'Управляет: ' + nickname;
      });
    } else {
      controllerEl.textContent = 'Управляет: не назначен';
    }
  });
}

function closePlanetInfo() {
  document.getElementById('planet-info-overlay').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  var closeBtn = document.getElementById('planet-info-close');
  var overlay = document.getElementById('planet-info-overlay');

  if (closeBtn) closeBtn.addEventListener('click', closePlanetInfo);
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closePlanetInfo();
    });
  }
});
