// Карточка планеты: сводка по системе и переходы на её карты.
// Строительство отсюда убрано — оно включается кнопкой на самой карте,
// чтобы осмотр, стройка и наём не путались в одном месте.

var FACTION_NAMES_INFO = {
  republic: 'Республика',
  cis: 'КНС'
};

var FACTION_COLORS_INFO = {
  republic: '#4a90d9',
  cis: '#d94a4a'
};

var FACTION_EMBLEMS_INFO = {
  republic: 'assets/ui/faction-republic.png',
  cis: 'assets/ui/faction-cis.png'
};

var currentPlanetInfoSystemId = null;

function openPlanetInfo(systemId) {
  currentPlanetInfoSystemId = systemId;

  var overlay = document.getElementById('planet-info-overlay');
  overlay.style.display = 'flex';

  document.getElementById('pi-name').textContent = '...';
  document.getElementById('pi-faction').textContent = '';
  document.getElementById('pi-controller').textContent = '';
  document.getElementById('pi-stats').innerHTML = '';
  document.getElementById('pi-move-btn').style.display = 'none';

  supabase.auth.getSession().then(function(sessionRes) {
    var viewerId = sessionRes.data.session ? sessionRes.data.session.user.id : null;

    Promise.all([
      supabase.from('systems').select('name, faction').eq('id', systemId).single(),
      supabase.from('system_control').select('controller_user_id').eq('system_id', systemId).maybeSingle(),
      supabase.rpc('get_system_buildings', { p_system_id: systemId }),
      supabase.from('space_stations').select('id').eq('system_id', systemId).maybeSingle(),
      supabase.rpc('get_my_profile')
    ]).then(function(r) {
      var sys = r[0].data;
      if (r[0].error || !sys) {
        document.getElementById('pi-name').textContent = 'Не удалось загрузить';
        return;
      }

      var control = r[1].error ? null : r[1].data;
      var buildings = r[2].error ? [] : (r[2].data || []);
      var station = r[3].error ? null : r[3].data;
      var myFaction = (!r[4].error && r[4].data && r[4].data.length) ? r[4].data[0].faction : null;

      var accent = FACTION_COLORS_INFO[sys.faction] || '#8fa8c4';

      // Перед названием — эмблема той фракции, которая держит планету.
      // У нейтральной системы эмблемы нет, остаётся только название.
      var nameEl = document.getElementById('pi-name');
      nameEl.textContent = '';

      var art = FACTION_EMBLEMS_INFO[sys.faction];
      if (art) {
        var em = document.createElement('img');
        em.src = '../' + art;
        em.alt = '';
        em.className = 'pi-name-emblem';
        // Если файла нет, название всё равно останется на месте
        em.addEventListener('error', function() {
          if (em.parentNode) em.parentNode.removeChild(em);
        });
        nameEl.appendChild(em);
      }

      nameEl.appendChild(document.createTextNode(sys.name));

      var facEl = document.getElementById('pi-faction');
      facEl.textContent = FACTION_NAMES_INFO[sys.faction] || '—';
      facEl.style.color = accent;
      facEl.style.borderColor = accent;

      document.getElementById('pi-planet-strip').style.background = accent;

      // Контролёр закрыт от чужой фракции политикой в БД: для врага
      // ответ пустой и выглядит так же, как «не назначен».
      var controllerId = control ? control.controller_user_id : null;
      var ctrlEl = document.getElementById('pi-controller');

      if (controllerId) {
        supabase.from('profiles').select('nickname').eq('id', controllerId).maybeSingle()
          .then(function(pr) {
            ctrlEl.textContent = (pr.data && pr.data.nickname) || 'неизвестно';
          });
      } else {
        ctrlEl.textContent = 'не назначен';
      }

      // Сводка. Постройки и станция публичны — они и так видны на картах.
      var stats = document.getElementById('pi-stats');
      stats.innerHTML = '';
      stats.appendChild(makePiStat('Постройки', buildings.length + ' / 7'));
      stats.appendChild(makePiStat('Орбитальная станция', station ? 'есть' : 'нет'));

      // Свои войска показываем только своей фракции. Считаем и тех, кто
      // стоит на земле, и тех, кто сидит в трюмах твоих кораблей в этой
      // системе — иначе загруженная армия выглядела бы как ноль.
      if (myFaction && myFaction === sys.faction && viewerId) {
        Promise.all([
          supabase.from('unit_positions').select('id', { count: 'exact', head: true })
            .eq('system_id', systemId).eq('owner_user_id', viewerId),
          supabase.from('ships').select('id').eq('system_id', systemId).eq('owner_user_id', viewerId)
        ]).then(function(res) {
          var onGround = res[0].count || 0;
          var shipIds = (res[1].data || []).map(function(sh) { return sh.id; });

          if (shipIds.length === 0) {
            stats.appendChild(makePiStat('Твои войска', onGround + ' ед.'));
            return;
          }

          supabase.from('ship_cargo').select('quantity').in('ship_id', shipIds)
            .then(function(cr) {
              var inHold = (cr.data || []).reduce(function(a, c) { return a + c.quantity; }, 0);
              var total = onGround + inHold;
              var label = inHold > 0
                ? (total + ' ед. · в трюмах ' + inHold)
                : (total + ' ед.');
              stats.appendChild(makePiStat('Твои войска', label));
            });
        });
      }

      updateMoveButton(viewerId, systemId);
    });
  });
}

function makePiStat(label, value) {
  var row = document.createElement('div');
  row.className = 'pi-stat';
  row.innerHTML = '<span>' + label + '</span><b>' + value + '</b>';
  return row;
}

// Кнопка отправки командира появляется, только если есть свободный командир
// в системе, напрямую связанной нитью с этой. Один прыжок за раз — поэтому
// пролететь «насквозь» через непокорённую вражескую систему нельзя.
function updateMoveButton(viewerId, targetSystemId) {
  var moveBtn = document.getElementById('pi-move-btn');
  if (!moveBtn || !viewerId) return;

  moveBtn.style.display = 'none';
  moveBtn.disabled = false;
  moveBtn.textContent = 'Отправить командира';

  Promise.all([
    supabase.from('commanders').select('*').eq('user_id', viewerId).eq('unlocked', true),
    supabase.from('hyperlanes').select('*')
  ]).then(function(results) {
    if (results[0].error || !results[0].data) return;
    var lanes = results[1].error ? [] : results[1].data;

    function connected(a, b) {
      return lanes.some(function(l) {
        return (l.system_a === a && l.system_b === b) || (l.system_b === a && l.system_a === b);
      });
    }

    var candidate = results[0].data.filter(function(c) {
      if (c.moving_to) return false;
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
  var closeBtn = document.getElementById('pi-close');
  var overlay = document.getElementById('planet-info-overlay');

  if (closeBtn) closeBtn.addEventListener('click', closePlanetInfo);
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closePlanetInfo();
    });
  }

  var ground = document.getElementById('pi-ground-btn');
  if (ground) ground.addEventListener('click', function() {
    if (!currentPlanetInfoSystemId) return;
    window.location.href = 'ground-battle.html?system=' + currentPlanetInfoSystemId;
  });

  var space = document.getElementById('pi-space-btn');
  if (space) space.addEventListener('click', function() {
    if (!currentPlanetInfoSystemId) return;
    window.location.href = 'space-battle.html?system=' + currentPlanetInfoSystemId;
  });
});
