// Меню планеты: название, принадлежность фракции (видна всем — это не секрет,
// цвет подписи на карте её и так выдаёт), и кто из игроков контролирует систему —
// это поле реально скрыто от вражеской фракции на уровне RLS в БД (см.
// sql/system_control_create.sql), а не просто спрятано в интерфейсе.

var FACTION_NAMES_INFO = {
  republic: 'Республика',
  cis: 'КНС'
};

var currentPlanetInfoSystemId = null;

function openPlanetInfo(systemId) {
  currentPlanetInfoSystemId = systemId;

  var overlay = document.getElementById('planet-info-overlay');
  var nameEl = document.getElementById('planet-info-name');
  var factionEl = document.getElementById('planet-info-faction');
  var controllerEl = document.getElementById('planet-info-controller');
  var buildBtn = document.getElementById('planet-info-build-btn');

  nameEl.textContent = '...';
  factionEl.textContent = '';
  controllerEl.textContent = '';
  buildBtn.style.display = 'none';
  overlay.style.display = 'flex';

  supabase.auth.getSession().then(function(sessionRes) {
    var viewerId = sessionRes.data.session ? sessionRes.data.session.user.id : null;

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
      var controllerId = (!controlRes.error && controlRes.data) ? controlRes.data.controller_user_id : null;

      if (controllerId) {
        supabase.from('profiles').select('nickname').eq('id', controllerId).maybeSingle().then(function(profileRes) {
          var nickname = (profileRes.data && profileRes.data.nickname) || 'неизвестно';
          controllerEl.textContent = 'Управляет: ' + nickname;
        });
      } else {
        controllerEl.textContent = 'Управляет: не назначен';
      }

      // Кнопка "Строительство" видна только если текущий игрок и есть
      // назначенный контролёр именно этой планеты
      if (viewerId && controllerId === viewerId) {
        buildBtn.style.display = 'block';
      }
    });
  });
}

function closePlanetInfo() {
  document.getElementById('planet-info-overlay').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  var closeBtn = document.getElementById('planet-info-close');
  var overlay = document.getElementById('planet-info-overlay');
  var spaceBtn = document.getElementById('planet-info-space-btn');
  var groundBtn = document.getElementById('planet-info-ground-btn');
  var buildBtn = document.getElementById('planet-info-build-btn');

  if (closeBtn) closeBtn.addEventListener('click', closePlanetInfo);
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closePlanetInfo();
    });
  }
  if (spaceBtn) {
    spaceBtn.addEventListener('click', function() {
      if (!currentPlanetInfoSystemId) return;
      window.location.href = 'space-battle.html?system=' + currentPlanetInfoSystemId;
    });
  }
  if (groundBtn) {
    groundBtn.addEventListener('click', function() {
      if (!currentPlanetInfoSystemId) return;
      window.location.href = 'ground-battle.html?system=' + currentPlanetInfoSystemId;
    });
  }
  if (buildBtn) {
    buildBtn.addEventListener('click', function() {
      if (!currentPlanetInfoSystemId) return;
      window.location.href = 'ground-battle.html?system=' + currentPlanetInfoSystemId;
    });
  }
});
