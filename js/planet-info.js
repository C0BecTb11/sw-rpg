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
      supabase.rpc('get_my_profile'),
      supabase.rpc('get_system_resources', { p_system_id: systemId })
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
      var sysResources = r[5].error ? [] : (r[5].data || []);

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

      // Сводка своей фракции. У чужой планеты эти строки не показываем:
      // разведка должна быть действием, а не строчкой в карточке. Хочешь
      // знать, что там понастроено, — зайди в земное пространство
      // и посмотри сам.
      var sameFaction = myFaction && sys.faction === myFaction;
      var stats = document.getElementById('pi-stats');
      stats.innerHTML = '';

      // Что залегает на планете — знание общедоступное и показывается
      // по любой системе: без него карта не читается стратегически.
      // Сам запас при этом виден только владельцу планеты.
      if (sysResources.length) {
        var resRow = document.createElement('div');
        resRow.className = 'pi-stat pi-res-row';
        resRow.innerHTML = '<span>Сырьё</span>';

        var chips = document.createElement('div');
        chips.className = 'pi-chips';

        sysResources.forEach(function(res) {
          // Плашка в цвете ресурса: попутное приглушено, чтобы основное
          // читалось первым и без вчитывания в подписи
          var chip = document.createElement('b');
          chip.className = 'pi-chip' + (res.role === 'secondary' ? ' weak' : '');
          chip.style.borderColor = res.color || '#2a3644';
          chip.style.color = res.color || '#cfd8dc';
          chip.textContent = res.name;
          chip.title = res.role === 'primary' ? 'Основное сырьё' : 'Попутное сырьё';
          chips.appendChild(chip);
        });

        resRow.appendChild(chips);
        stats.appendChild(resRow);
      } else {
        stats.appendChild(makePiStat('Сырьё', 'нет залежей'));
      }

      if (sameFaction) {
        stats.appendChild(makePiStat('Постройки', buildings.length + ' / 7'));
        stats.appendChild(makePiStat('Орбитальная станция', station ? 'есть' : 'нет'));
      }

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
//
// Кто именно летит, игрок выбирает сам в отдельном окне: командиров у него
// может быть несколько на одной планете, и у каждого свой приписанный флот.
// Раньше отправлялся первый попавшийся — и вместе с ним улетало не то.
var moveTargetId = null;
var moveTargetName = '';
var moveCandidates = [];
var moveChosen = null;

function updateMoveButton(viewerId, targetSystemId) {
  var moveBtn = document.getElementById('pi-move-btn');
  if (!moveBtn || !viewerId) return;

  moveBtn.style.display = 'none';
  moveBtn.disabled = false;
  moveBtn.textContent = 'Отправить командира';

  supabase.rpc('get_move_candidates', { p_target: targetSystemId }).then(function(res) {
    // Карточка могла смениться, пока шёл запрос
    if (currentPlanetInfoSystemId !== targetSystemId) return;
    if (res.error || !res.data || !res.data.length) return;

    moveBtn.style.display = 'block';
    moveBtn.onclick = function() {
      var nameEl = document.getElementById('pi-name');
      openMovePanel(targetSystemId, nameEl ? nameEl.textContent : '');
    };
  });
}

function openMovePanel(targetId, targetName) {
  moveTargetId = targetId;
  moveTargetName = targetName;
  moveChosen = null;

  document.getElementById('move-panel').style.display = 'flex';
  document.getElementById('move-subtitle').textContent = 'Цель: ' + targetName;
  document.getElementById('move-list').innerHTML = '<div class="feed-empty">Загрузка...</div>';
  paintMoveSend();

  supabase.rpc('get_move_candidates', { p_target: targetId }).then(function(res) {
    if (moveTargetId !== targetId) return;
    var list = document.getElementById('move-list');
    if (res.error) {
      list.innerHTML = '<div class="feed-empty">Не удалось получить командиров</div>';
      return;
    }

    moveCandidates = res.data || [];
    list.innerHTML = '';

    if (!moveCandidates.length) {
      list.innerHTML = '<div class="feed-empty">Рядом нет свободных командиров</div>';
      return;
    }

    // Один командир — выбор очевиден, но состав всё равно показываем:
    // игрок должен видеть, что улетит, до нажатия кнопки
    if (moveCandidates.length === 1) moveChosen = moveCandidates[0].commander_id;

    moveCandidates.forEach(function(c) { list.appendChild(makeMoveCard(c)); });
    paintMoveSend();
  });
}

function closeMovePanel() {
  document.getElementById('move-panel').style.display = 'none';
}

function makeMoveCard(c) {
  var card = document.createElement('div');
  card.className = 'mv-card';
  card.setAttribute('role', 'button');
  card.setAttribute('data-id', c.commander_id);

  var notReady = c.ships - c.ready;

  var head =
    '<div class="mv-head">' +
      '<span class="mv-pawn">♟</span>' +
      '<span class="mv-who"><b>' + escapeMove(c.name) + '</b>' +
        '<i>стоит: ' + escapeMove(c.from_name) + '</i></span>' +
      (notReady > 0
        ? '<span class="mv-state warn">' + notReady + ' вне зоны прыжка</span>'
        : '<span class="mv-state ok">готов</span>') +
    '</div>';

  var fleet = '<div class="mv-label">Приписанный флот</div>';
  if (!c.fleet.length) {
    fleet += '<div class="mv-none">кораблей нет — командир летит один</div>';
  } else {
    fleet += '<div class="mv-chips">' + c.fleet.map(function(f) {
      return moveChip(f, 'ship');
    }).join('') + '</div>';
  }

  var cargo = '';
  if (c.cargo.length || c.resources > 0) {
    cargo = '<div class="mv-label">На борту</div><div class="mv-chips">' +
      c.cargo.map(function(x) { return moveChip(x, x.kind); }).join('') +
      (c.resources > 0
        ? '<span class="mv-chip mv-res"><b>' + c.resources + '</b><em>ед. сырья</em></span>'
        : '') +
      '</div>';
  }

  // Непривязанные корабли не летят — лучше сказать об этом заранее,
  // чем игрок потом будет искать их на новой планете
  var one = c.left_behind % 10 === 1 && c.left_behind % 100 !== 11;
  var left = c.left_behind > 0
    ? '<div class="mv-note">' + c.left_behind + ' ' + shipWord(c.left_behind) +
      ' без командира ' + (one ? 'остаётся на месте и не полетит' : 'остаются на месте и не полетят') +
      '</div>'
    : '';

  var warn = notReady > 0
    ? '<div class="mv-note warn">Выведи флот в зону гиперпрыжка — иначе прыжок не начнётся</div>'
    : '';

  card.innerHTML = head + fleet + cargo + left + warn;

  card.addEventListener('click', function() {
    moveChosen = c.commander_id;
    paintMoveSend();
  });

  return card;
}

function moveChip(item, kind) {
  var thumbClass = kind === 'ship' || kind === 'fighter' ? 'mv-thumb ship' : 'mv-thumb';
  var img = item.image
    ? '<img src="../' + item.image + '" alt="" onerror="this.style.display=\'none\'">'
    : '';
  var tag = kind === 'hero' ? '<u class="mv-tag hero">герой</u>'
          : kind === 'vehicle' ? '<u class="mv-tag">техника</u>'
          : kind === 'fighter' ? '<u class="mv-tag">ангар</u>'
          : '';

  return '<span class="mv-chip">' +
      '<span class="' + thumbClass + '">' + img + '</span>' +
      '<span class="mv-chip-text"><em>' + escapeMove(item.name) + '</em>' + tag + '</span>' +
      '<b>×' + item.count + '</b>' +
    '</span>';
}

function paintMoveSend() {
  var cards = document.querySelectorAll('#move-list .mv-card');
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.toggle('chosen', cards[i].getAttribute('data-id') === moveChosen);
  }

  var btn = document.getElementById('move-send');
  var c = null;
  moveCandidates.forEach(function(x) { if (x.commander_id === moveChosen) c = x; });

  btn.disabled = !c || c.ready < c.ships;
  btn.textContent = !c ? 'Выбери командира'
    : (c.ready < c.ships ? 'Флот не в зоне прыжка' : 'Отправить на ' + moveTargetName);
}

function sendChosenCommander() {
  var btn = document.getElementById('move-send');
  if (!moveChosen || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = 'Отправляем...';

  supabase.rpc('start_commander_move', {
    p_commander_id: moveChosen,
    p_target_system: moveTargetId
  }).then(function(res) {
    if (res.error) {
      alert('Не удалось отправить: ' + res.error.message);
      paintMoveSend();
      return;
    }
    closeMovePanel();
    closePlanetInfo();
  });
}

function shipWord(n) {
  var d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return 'корабль';
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'корабля';
  return 'кораблей';
}

function escapeMove(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  var mvClose = document.getElementById('move-close');
  var mvPanel = document.getElementById('move-panel');
  var mvSend = document.getElementById('move-send');
  if (mvClose) mvClose.addEventListener('click', closeMovePanel);
  if (mvSend) mvSend.addEventListener('click', sendChosenCommander);
  if (mvPanel) mvPanel.addEventListener('click', function(e) {
    if (e.target === mvPanel) closeMovePanel();
  });

  var space = document.getElementById('pi-space-btn');
  if (space) space.addEventListener('click', function() {
    if (!currentPlanetInfoSystemId) return;
    window.location.href = 'space-battle.html?system=' + currentPlanetInfoSystemId;
  });
});
