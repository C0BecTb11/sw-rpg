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

      updateMoveButton(viewerId, systemId);
    });
  });
}

// Кнопка отправки командира появляется, только если у игрока есть свободный
// командир в системе, напрямую связанной нитью с этой. Один прыжок за раз —
// поэтому пролететь «насквозь» через непокорённую вражескую систему нельзя.
function updateMoveButton(viewerId, targetSystemId) {
  var moveBtn = document.getElementById('planet-info-move-btn');
  if (!moveBtn || !viewerId) return;

  moveBtn.style.display = 'none';
  moveBtn.disabled = false;
  moveBtn.textContent = 'Отправить командира';

  Promise.all([
    supabase.from('commanders').select('*').eq('user_id', viewerId).eq('unlocked', true),
    supabase.from('hyperlanes').select('*')
  ]).then(function(results) {
    var commandersRes = results[0];
    var lanesRes = results[1];
    if (commandersRes.error || !commandersRes.data) return;

    var lanes = lanesRes.error ? [] : lanesRes.data;

    function connected(a, b) {
      return lanes.some(function(l) {
        return (l.system_a === a && l.system_b === b) || (l.system_b === a && l.system_a === b);
      });
    }

    var candidate = commandersRes.data.filter(function(c) {
      if (c.moving_to) return false;               // уже в пути
      if (!c.current_system) return false;
      if (c.current_system === targetSystemId) return false;
      return connected(c.current_system, targetSystemId);
    })[0];

    if (!candidate) return;

    moveBtn.style.display = 'block';
    moveBtn.onclick = function() {
      moveBtn.disabled = true;
      moveBtn.textContent = 'Отправляем...';
      supabase.rpc('start_commander_move', {
        p_commander_id: candidate.id,
        p_target_system: targetSystemId
      }).then(function(res) {
        if (res.error) {
          moveBtn.disabled = false;
          moveBtn.textContent = 'Отправить командира';
          alert('Не удалось отправить: ' + res.error.message);
          return;
        }
        closePlanetInfo();
      });
    };
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
      // mode=build включает показ пустых слотов и переключатель карт
      window.location.href = 'ground-battle.html?system=' + currentPlanetInfoSystemId + '&mode=build';
    });
  }
});
