// Вводный курс: наставник фракции ведёт новичка через все механики.
//
// Сервер держит шаги, проверяет выполнение и выдаёт награды (get_tutorial,
// tutorial_ui, claim_tutorial). Здесь — три вещи:
//   1) трекер под панелью кредитов: какое сейчас задание и готово ли оно;
//   2) окно наставника: речь, задача, награда, список всех глав;
//   3) подсветка: кольцо вокруг того, что нужно нажать прямо сейчас.
//      Цепочка целей идёт от самой «глубокой» к самой общей — открыл
//      корабль, и кольцо само переезжает на нужную вкладку, потом на кнопку.
//
// Файл один на все три экрана (галактика, космос, поверхность) и ничего
// не знает об их устройстве, кроме пары общих имён: focusCell,
// focusGalaxySystem, buildMode и т. п. Всё своё — внутри замыкания.

(function() {
  var QPAGE = /ground-battle/.test(location.pathname) ? 'ground'
            : /space-battle/.test(location.pathname) ? 'space' : 'galaxy';
  var qParams = new URLSearchParams(location.search);
  var QSYS = qParams.get('system');
  var QBUILD = qParams.get('mode') === 'build';
  var qArrived = qParams.get('quest') === '1';

  var qData = null;          // ответ get_tutorial
  var qBusy = false;
  var qPollTimer = null;
  var qTickTimer = null;
  var qLastKey = '';         // ord+done: чтобы заметить смену шага
  var qSheetOpen = false;
  var qListOpen = false;
  var qJustFinished = false;
  var qHintsOff = false;

  try { qHintsOff = localStorage.getItem('quest_hints_off') === '1'; } catch (e) {}

  var Q_ACCENT = { republic: '#4a90d9', cis: '#d94a4a' };

  // ===== Данные =====

  function qLoad() {
    return supabase.rpc('get_tutorial').then(function(res) {
      if (res.error || !res.data) return;
      var prev = qData;
      qData = res.data;

      if (qData.status !== 'active') {
        qStopPoll();
        if (qJustFinished) { qRenderFinished(); } else { qHideAll(); }
        return;
      }

      var key = qData.step_ord + ':' + (qData.step_done ? 1 : 0);
      var changed = key !== qLastKey;

      // Шаг засчитался сам, пока игрок был занят делом
      if (prev && prev.status === 'active' && changed &&
          prev.step_ord === qData.step_ord && !prev.step_done && qData.step_done) {
        qToast('Задание выполнено', qData.current.title + ' — забери награду у наставника', true);
      }
      qLastKey = key;

      qRenderTracker();
      if (qSheetOpen) qRenderSheet();
      qSchedulePoll();
      qLoop();
      if (changed) qAutoFocus();
    });
  }

  // Пока задание ждёт действия в мире, спрашиваем сервер. Осмотры (ui)
  // закрываются сразу по нажатию — для них опрос не нужен.
  function qSchedulePoll() {
    qStopPoll();
    if (!qData || qData.status !== 'active' || qData.step_done) return;
    if (qData.current.kind === 'ui') return;
    // Ответ лидера может ждать часами — там спрашиваем реже, остальное
    // игрок делает руками, и отклик должен быть быстрым: иначе кольцо ещё
    // долго зовёт повторить уже сделанное
    var slow = qData.current.id === 'planet';
    qPollTimer = setTimeout(function() {
      if (document.hidden) { qSchedulePoll(); return; }
      qLoad();
    }, slow ? 20000 : 5000);
  }

  function qStopPoll() {
    if (qPollTimer) { clearTimeout(qPollTimer); qPollTimer = null; }
  }

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && qData && qData.status === 'active') qLoad();
  });

  // Осмотр: карточка планеты, лента, армия, поселение. Сервер сам сверит,
  // то ли открыто (столица, своя планета), клиент только не шлёт лишнего.
  window.questSeen = function(what, systemId) {
    if (!qData || qData.status !== 'active' || qData.step_done || !qData.current) return;
    var key = qData.current.key;
    var send = null;

    if (what === 'planet' && (key === 'capital' || key === 'my_planet')) send = key;
    else if (what === key) send = key;
    if (!send) return;

    supabase.rpc('tutorial_ui', { p_key: send, p_system: systemId || null }).then(function(res) {
      if (res.error || res.data !== true) return;
      qToast('Задание выполнено', qData.current.title + ' — забери награду', true);
      qLoad();
    });
  };

  window.openQuest = function() { qOpenSheet(); };

  function qClaim() {
    if (qBusy) return;
    qBusy = true;
    qRenderSheet();

    var cur = qData.current;
    var pre = (cur.kind === 'ui' && (cur.key === 'hello' || cur.key === 'final'))
      ? supabase.rpc('tutorial_ui', { p_key: cur.key, p_system: null })
      : Promise.resolve({ data: true });

    pre.then(function() {
      return supabase.rpc('claim_tutorial');
    }).then(function(res) {
      qBusy = false;
      if (res.error) {
        qToast('Не получилось', res.error.message, false, true);
        qRenderSheet();
        return;
      }
      var r = res.data || {};
      qToast('+' + (r.credits || 0) + ' ◈', r.extra || 'Награда получена', true);
      if (r.finished) qJustFinished = true;
      qLoad();
    });
  }

  // ===== Трекер =====

  function qEnsureTracker() {
    var el = document.getElementById('quest-tracker');
    if (el) return el;
    el = document.createElement('button');
    el.id = 'quest-tracker';
    // На картах боя место наверху занято кораблями и зонами высадки:
    // там трекер — только портрет с номером задания
    if (QPAGE !== 'galaxy') el.className = 'compact';
    el.innerHTML =
      '<span class="qt-face"><img alt=""><i class="qt-num"></i></span>' +
      '<span class="qt-text">' +
        '<span class="qt-label"></span>' +
        '<span class="qt-goal"></span>' +
      '</span>';
    el.addEventListener('click', qOpenSheet);
    document.body.appendChild(el);
    qBindPortrait(el.querySelector('.qt-face img'));
    return el;
  }

  function qBindPortrait(img) {
    if (!img || !qData) return;
    var m = qData.mentor;
    if (img.getAttribute('data-src') === m.image) return;
    img.setAttribute('data-src', m.image);
    img.onerror = function() {
      img.onerror = null;
      img.src = '../' + m.fallback;
    };
    img.src = '../' + m.image;
  }

  function qRenderTracker() {
    if (!qData || qData.status !== 'active') return;
    var el = qEnsureTracker();
    var cur = qData.current;
    el.style.setProperty('--qa', Q_ACCENT[qData.faction] || '#8fa8c4');
    qBindPortrait(el.querySelector('.qt-face img'));

    el.classList.toggle('done', !!qData.step_done);
    el.querySelector('.qt-num').textContent = qData.step_done ? '✓' : qData.step_ord;
    el.title = qData.step_done ? 'Задание выполнено — забери награду' : cur.goal;
    el.querySelector('.qt-label').textContent = qData.step_done
      ? 'Выполнено · награда'
      : 'Задание ' + qData.step_ord + ' из ' + qData.total;
    el.querySelector('.qt-goal').textContent = qData.step_done ? cur.title : qTrackerLine();
    el.style.display = 'flex';
  }

  // Строка трекера: цель, а на перелёте — обратный отсчёт
  function qTrackerLine() {
    var cur = qData.current;
    var f = qData.focus || {};
    if (cur.id === 'arrive' && f.commander && f.commander.arrives_at) {
      var left = Math.round((new Date(f.commander.arrives_at).getTime() - Date.now()) / 1000);
      if (left > 0) return 'Флот прибудет через ' + qClock(left);
      return 'Флот выходит из прыжка…';
    }
    return cur.goal;
  }

  function qClock(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ===== Окно наставника =====

  function qEnsureSheet() {
    var el = document.getElementById('quest-sheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'quest-sheet';
    el.innerHTML = '<div class="qs-box" id="qs-box"></div>';
    el.addEventListener('click', function(e) { if (e.target === el) qCloseSheet(); });
    document.body.appendChild(el);
    return el;
  }

  function qOpenSheet() {
    if (!qData || (qData.status !== 'active' && !qJustFinished)) return;
    qSheetOpen = true;
    var el = qEnsureSheet();
    el.style.display = 'flex';
    if (qData.status === 'active') qRenderSheet(); else qRenderFinished();
  }

  function qCloseSheet() {
    qSheetOpen = false;
    var el = document.getElementById('quest-sheet');
    if (el) el.style.display = 'none';
  }

  function qEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function qRenderSheet() {
    if (!qData || qData.status !== 'active') return;
    var box = document.getElementById('qs-box');
    if (!box) return;
    var cur = qData.current;
    var m = qData.mentor;
    var accent = Q_ACCENT[qData.faction] || '#8fa8c4';
    var pct = Math.round((qData.step_ord - 1 + (qData.step_done ? 1 : 0)) / qData.total * 100);
    var plan = qPlan();

    box.style.setProperty('--qa', accent);

    var html =
      '<div class="qs-grip"></div>' +
      '<div class="qs-head">' +
        '<div class="qs-portrait"><img alt=""></div>' +
        '<div class="qs-who">' +
          '<b>' + qEsc(m.name) + '</b>' +
          '<span>' + qEsc(m.role) + '</span>' +
          '<div class="qs-chapter">Глава ' + cur.chapter + ' · ' + qEsc(cur.chapter_title) + '</div>' +
        '</div>' +
        '<button class="qs-close" id="qs-close">✕</button>' +
      '</div>' +
      '<div class="qs-progress"><div class="qs-track"><i style="width:' + pct + '%"></i></div>' +
        '<em>' + qData.step_ord + ' / ' + qData.total + '</em></div>' +
      '<div class="qs-speech">' + qEsc(cur.text) + '</div>' +
      '<div class="qs-task' + (qData.step_done ? ' done' : '') + '">' +
        '<div class="qs-task-top"><span>' + (qData.step_done ? 'Выполнено' : 'Задача') + '</span>' +
          '<b>' + qEsc(cur.title) + '</b></div>' +
        '<div class="qs-goal">' + qEsc(cur.goal) + '</div>' +
        (qData.step_done ? '' : '<div class="qs-hint">' + qEsc(cur.hint) + '</div>') +
        (qData.step_done ? '' : qStatusLine()) +
      '</div>' +
      '<div class="qs-reward">' +
        '<span class="qs-reward-k">Награда</span>' +
        '<b>+' + cur.reward_credits + ' ◈</b>' +
        (cur.reward_label ? '<em>' + qEsc(cur.reward_label) + '</em>' : '') +
      '</div>' +
      '<div class="qs-actions" id="qs-actions"></div>' +
      '<button class="qs-more" id="qs-more">' + (qListOpen ? '▾' : '▸') + ' Все задания курса</button>' +
      '<div class="qs-list" id="qs-list" style="display:' + (qListOpen ? 'block' : 'none') + '"></div>';

    box.innerHTML = html;
    qBindPortrait(box.querySelector('.qs-portrait img'));
    document.getElementById('qs-close').addEventListener('click', qCloseSheet);
    document.getElementById('qs-more').addEventListener('click', function() {
      qListOpen = !qListOpen;
      qRenderSheet();
    });

    var acts = document.getElementById('qs-actions');
    var addBtn = function(label, cls, fn, disabled) {
      var b = document.createElement('button');
      b.className = 'qs-btn ' + (cls || '');
      b.textContent = label;
      if (disabled) b.disabled = true;
      b.addEventListener('click', fn);
      acts.appendChild(b);
      return b;
    };

    if (qData.step_done) {
      addBtn(qBusy ? 'Получаем…' : 'Забрать награду', 'gold', qClaim, qBusy);
    } else if (cur.key === 'hello') {
      addBtn(qBusy ? '…' : 'Готов служить', 'gold', qClaim, qBusy);
    } else if (cur.key === 'final') {
      addBtn(qBusy ? '…' : 'Доложить', 'gold', qClaim, qBusy);
    } else if (plan && plan.page && plan.page !== QPAGE ||
               plan && plan.page === QPAGE && plan.system && plan.system !== QSYS) {
      addBtn(plan.goLabel || 'Перейти', 'primary', function() { qGo(plan); });
    } else if (plan) {
      addBtn('Показать', 'primary', function() {
        qCloseSheet();
        qAutoFocus(true);
        if (qHintsOff) qSetHints(true);
      });
    }

    // Пока лидер думает, можно попросить ещё землю
    if (cur.key === 'planet_owned' && QPAGE === 'galaxy' && typeof openFactionScreen === 'function') {
      // Через экран фракции: там кнопка сама знает, можно ли сейчас просить
      addBtn('Запросить ещё планету', '', function() {
        qCloseSheet();
        openFactionScreen();
      });
    }

    if (!qData.step_done && cur.key !== 'hello' && cur.key !== 'final') {
      var tog = document.createElement('label');
      tog.className = 'qs-toggle';
      tog.innerHTML = '<input type="checkbox"' + (qHintsOff ? '' : ' checked') + '>' +
        '<span>Подсвечивать, куда нажимать</span>';
      tog.querySelector('input').addEventListener('change', function(e) {
        qSetHints(e.target.checked);
      });
      acts.appendChild(tog);
    }

    if (qListOpen) qRenderList();
  }

  // Что происходит прямо сейчас — одной строкой под подсказкой
  function qStatusLine() {
    var cur = qData.current;
    var f = qData.focus || {};
    var t = '';
    if (cur.id === 'arrive') t = qTrackerLine();
    if (cur.id === 'jump' && f.ship && !f.ship.in_transit && !f.ship.in_jump_zone) {
      t = 'Корабль не в зоне прыжка — выведи его к краю орбиты';
    }
    if (cur.id === 'drop' && f.ship && f.ship.in_drop) t = 'Корабль в площадке сброса — можно высаживать';
    if (cur.id === 'recruit') t = 'Если заказ уже сделан — дождись подготовки';
    return t ? '<div class="qs-status">' + qEsc(t) + '</div>' : '';
  }

  function qRenderList() {
    var list = document.getElementById('qs-list');
    if (!list) return;
    var html = '';
    var chapter = null;
    qData.steps.forEach(function(s) {
      if (s.chapter !== chapter) {
        chapter = s.chapter;
        html += '<div class="qs-list-ch">Глава ' + s.chapter + ' · ' + qEsc(s.chapter_title) + '</div>';
      }
      html += '<div class="qs-list-row ' + s.state + '">' +
        '<i>' + (s.state === 'done' ? '✓' : s.state === 'current' ? '●' : '·') + '</i>' +
        '<span>' + qEsc(s.title) + '</span>' +
        '<em>+' + s.reward_credits + '</em>' +
      '</div>';
    });
    list.innerHTML = html;
  }

  function qRenderFinished() {
    qHideSpot();
    var tr = document.getElementById('quest-tracker');
    if (tr) tr.style.display = 'none';
    if (!qJustFinished) return;

    qSheetOpen = true;
    var el = qEnsureSheet();
    el.style.display = 'flex';
    var box = document.getElementById('qs-box');
    var m = qData.mentor || {};
    box.style.setProperty('--qa', Q_ACCENT[qData.faction] || '#8fa8c4');
    box.innerHTML =
      '<div class="qs-grip"></div>' +
      '<div class="qs-final">' +
        '<div class="qs-portrait big"><img alt=""></div>' +
        '<div class="qs-final-title">Курс пройден</div>' +
        '<div class="qs-final-sub">' + qEsc(m.name || '') + ' больше не ведёт тебя за руку</div>' +
        '<div class="qs-final-prize"><span>♟</span><b>Второй командир</b><em>ждёт в столице — открой «Армию»</em></div>' +
      '</div>' +
      '<div class="qs-actions"><button class="qs-btn gold" id="qs-final-ok">К делу</button></div>';
    qBindPortrait(box.querySelector('.qs-portrait img'));
    document.getElementById('qs-final-ok').addEventListener('click', function() {
      qJustFinished = false;
      qCloseSheet();
    });
  }

  function qHideAll() {
    qHideSpot();
    var tr = document.getElementById('quest-tracker');
    if (tr) tr.style.display = 'none';
    qCloseSheet();
  }

  function qSetHints(on) {
    qHintsOff = !on;
    try { localStorage.setItem('quest_hints_off', qHintsOff ? '1' : '0'); } catch (e) {}
    if (qHintsOff) qHideSpot();
  }

  // ===== Уведомление =====

  function qToast(title, text, good, bad) {
    var el = document.getElementById('quest-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'quest-toast';
      document.body.appendChild(el);
      el.addEventListener('click', function() { el.className = ''; qOpenSheet(); });
    }
    el.innerHTML = '<b>' + qEsc(title) + '</b><span>' + qEsc(text) + '</span>';
    el.className = 'show' + (good ? ' good' : '') + (bad ? ' bad' : '');
    clearTimeout(qToast.t);
    qToast.t = setTimeout(function() { el.className = ''; }, 4200);
  }

  // ===== План шага: где делать и что подсвечивать =====
  //
  // page/system — где выполняется шаг. targets — цепочка целей: первая
  // видимая получает кольцо. marks — вспомогательные рамки на карте.

  function qPlan() {
    if (!qData || !qData.current) return null;
    var id = qData.current.id;
    var f = qData.focus || {};
    var cap = f.capital;
    var shipSel = f.ship ? '[data-ship-id="' + f.ship.id + '"]' : null;
    // Панель корабля показывает выбранный корабль — подсказки в ней
    // имеют смысл, только если выбран именно курсовой
    var ourHud = function() {
      return !!(f.ship && window.scShip && window.scShip.id === f.ship.id);
    };

    var galaxy = function(targets, extra) {
      var p = { page: 'galaxy', goLabel: 'Перейти на карту галактики', targets: targets };
      for (var k in (extra || {})) p[k] = extra[k];
      return p;
    };

    switch (id) {
      case 'hello':
      case 'final':
        return null;

      case 'capital':
        return galaxy([{ sel: '.planet-wrapper[data-planet-id="' + cap + '"]', tip: 'Нажми на ' + f.capital_name }],
                      { galaxyFocus: cap });

      case 'request':
        return galaxy([
          { sel: '#pr-send:not([disabled])', tip: 'Отправить запрос' },
          { sel: '#pr-body .pr-planet:not(.locked)', tip: 'Выбери планету' },
          { sel: '#pr-open-btn', tip: 'Запросить планету' },
          { sel: '#panel-item-faction', tip: 'Фракция' },
          { sel: '#bottom-panel-toggle', tip: 'Открой панель' }
        ]);

      case 'feed':
        return galaxy([{ sel: '#feed-bell', tip: 'Уведомления' }]);

      case 'army':
        return galaxy([
          { sel: '#panel-item-army', tip: 'Армия' },
          { sel: '#bottom-panel-toggle', tip: 'Открой панель' }
        ]);

      case 'assign':
        if (!f.ship) return null;
        return {
          page: 'space', system: f.ship.system, goLabel: 'Перейти в космос ' + (f.capital_name || ''),
          targets: [
            { sel: '.sc-cmd-select', when: ourHud, tip: 'Выбери себя' },
            { sel: '.sc-cmd-head', when: ourHud, tip: 'Раскрой «Командир»' },
            { sel: '.sc-tab[data-tab="info"]', when: ourHud, tip: 'Вкладка «Описание»' },
            { sel: '.ship-sprite' + shipSel, tip: 'Твой корабль' }
          ],
          shipFocus: f.ship
        };

      case 'cargo':
        if (!f.ship) return null;
        return galaxy([
          { sel: '#shipcargo-list > .cargo-row:first-child .cargo-action',
            when: function() { return !!document.querySelector('#shipcargo-tab-load.active'); },
            tip: 'Погрузить' },
          { sel: '.ship-block' + shipSel + ' .ship-manage-btn', tip: 'Заполнить трюм' },
          { sel: '.ship-block' + shipSel + ' .ship-header', tip: 'Раскрой корабль' },
          { sel: '#panel-item-army', tip: 'Армия' },
          { sel: '#bottom-panel-toggle', tip: 'Открой панель' }
        ]);

      case 'jump':
        if (f.ship && !f.ship.in_transit && !f.ship.in_jump_zone && !qShipInZone('.hyperspace-zone')) {
          return {
            page: 'space', system: f.ship.system, goLabel: 'Перейти в космос',
            targets: [
              { sel: '#sc-go', when: ourHud, tip: 'Подтверди ход' },
              { sel: '.sc-tile[data-key="move"]', when: ourHud, tip: 'Ход' },
              { sel: '.ship-sprite' + shipSel, tip: 'Веди корабль в зону прыжка' }
            ],
            marks: [{ sel: '.hyperspace-zone', label: 'Зона прыжка' }],
            shipFocus: f.ship
          };
        }
        return galaxy([
          { sel: '#move-send:not([disabled])', tip: 'Отправить' },
          { sel: '#move-list .mv-card', tip: 'Выбери командира' },
          { sel: '#pi-move-btn', tip: 'Отправить командира' },
          { sel: '.planet-wrapper[data-planet-id="' + f.neighbor + '"]', tip: 'Лети на ' + (f.neighbor_name || 'соседнюю планету') }
        ], { galaxyFocus: f.neighbor });

      case 'arrive':
        return galaxy([], { galaxyFocus: (f.commander && f.commander.moving_to) || f.neighbor });

      case 'drop':
        if (!f.ship || f.ship.in_transit) return null;
        var inDrop = f.ship.in_drop || qShipInZone('.orbital-drop-zone');
        return {
          page: 'space', system: f.ship.system, goLabel: 'Перейти в космос',
          targets: inDrop ? [
            { sel: '#sc-tab-cargo .sc-hangar-btn', when: ourHud, tip: 'Высадить' },
            { sel: '.sc-tab[data-tab="cargo"]', when: ourHud, tip: 'Вкладка «Трюм»' },
            { sel: '.ship-sprite' + shipSel, tip: 'Нажми на корабль' }
          ] : [
            { sel: '#sc-go', when: ourHud, tip: 'Подтверди ход' },
            { sel: '.sc-tile[data-key="move"]', when: ourHud, tip: 'Ход' },
            { sel: '.ship-sprite' + shipSel, tip: 'Веди в площадку сброса' }
          ],
          marks: inDrop ? [] : [{ sel: '.orbital-drop-zone', label: 'Площадка сброса', all: true }],
          shipFocus: f.ship
        };

      case 'target':
        if (!f.target) return null;
        return {
          page: 'ground', system: f.target.system, goLabel: 'На поверхность',
          targets: [
            { cell: qTargetCell, when: function() { return !!window.attackingUnit; }, tip: 'Бей сюда' },
            { sel: '.gu-tile[data-key="attack"]', tip: 'Атака' },
            { cell: qNearestOwnUnit, tip: 'Выбери бойца' }
          ],
          marks: [{ cell: qTargetCell, label: 'Мародёр' }],
          cellFocus: { x: f.target.x, y: f.target.y }
        };

      case 'planet':
        return galaxy([
          { sel: '#faction-screen #pr-open-btn:not([disabled])', tip: 'Запросить ещё' },
          { sel: '#feed-bell', tip: 'Ответ лидера придёт сюда' }
        ]);

      case 'my_planet':
        if (!f.planet) return null;
        return galaxy([{ sel: '.planet-wrapper[data-planet-id="' + f.planet + '"]', tip: 'Нажми на ' + f.planet_name }],
                      { galaxyFocus: f.planet });

      case 'settlement':
        if (!f.planet) return null;
        return {
          page: 'ground', system: f.planet, goLabel: 'На поверхность: ' + f.planet_name,
          targets: [{ cell: qSettlementCell, tip: 'Нажми на поселение' }],
          cellFocus: { x: 70, y: 70 }
        };

      case 'barracks':
      case 'economy':
        if (!f.planet) return null;
        var codes = id === 'barracks' ? qBarracksCodes() : qEconomyCodes(f);
        // Постройка уже заложена: шаг засчитается, когда стройка закончится.
        // Без этого кольцо уводило бы на соседний слот строить вторую.
        var laid = QPAGE === 'ground' && QSYS === f.planet ? qLaidCell(codes) : null;
        if (laid) {
          return {
            page: 'ground', system: f.planet, goLabel: 'На поверхность: ' + f.planet_name,
            targets: [{ cell: function() { return laid; }, tip: 'Стройка идёт — дождись' }]
          };
        }
        var chain = [];
        codes.forEach(function(c) {
          chain.push({ sel: '#build-panel .build-panel-item[data-code="' + c + '"]', tip: 'Строй', scroll: true });
        });
        chain.push({ sel: '#build-toggle:not(.active)', tip: 'Строительство' });
        chain.push({ cell: qFreeSlotCell, when: function() { return QBUILD; }, tip: 'Свободный слот' });
        return {
          page: 'ground', system: f.planet, goLabel: 'На поверхность: ' + f.planet_name,
          targets: chain
        };

      case 'recruit':
        if (!f.planet) return null;
        return {
          page: 'ground', system: f.planet, goLabel: 'На поверхность: ' + f.planet_name,
          targets: [
            { sel: '#build-toggle.active', tip: 'Выйди из стройки' },
            { sel: '#unit-panel .unit-order-btn:not([disabled])', tip: 'Нанять', scroll: true },
            { cell: qBarracksCell, tip: 'Нажми на постройку' }
          ]
        };

      case 'guard':
        if (!f.planet) return null;
        return {
          page: 'ground', system: f.planet, goLabel: 'На поверхность: ' + f.planet_name,
          targets: [
            { cell: qGuardCell, when: function() { return !!window.movingUnit; }, tip: 'Ближе к рамке' },
            { sel: '.gu-tile[data-key="move"]', tip: 'Идти' },
            { cell: qNearestInfantry, tip: 'Выбери бойца' }
          ],
          marks: [{ cell: qSettlementZoneCell, label: 'Зона охраны' }],
          cellFocus: f.infantry ? { x: f.infantry.x, y: f.infantry.y } : { x: 70, y: 70 }
        };
    }
    return null;
  }

  function qBarracksCodes() {
    return qData.faction === 'republic' ? ['rep_barracks'] : ['cis_droid'];
  }

  // Добыча под залежи планеты; без залежей — переработка
  function qEconomyCodes(f) {
    var types = window.buildingTypes || [];
    var res = (f.planet_resources || []).filter(function(r) { return !!r; });
    var codes = [];
    types.forEach(function(t) {
      if (t.faction !== qData.faction || !t.produces_resource) return;
      if (t.needs_local_resource && res.indexOf(t.produces_resource) >= 0) codes.push(t.code);
    });
    if (!codes.length) {
      types.forEach(function(t) {
        if (t.faction === qData.faction && t.produces_resource && !t.needs_local_resource) codes.push(t.code);
      });
    }
    return codes;
  }

  // ===== Клетки карты поверхности =====

  function qTargetCell() {
    var t = qData.focus && qData.focus.target;
    return t ? { x: t.x, y: t.y, w: 1, h: 1 } : null;
  }

  function qSettlementCell() {
    var s = window.settlement;
    return s ? { x: s.x, y: s.y, w: s.size, h: s.size } : { x: 67, y: 67, w: 6, h: 6 };
  }

  function qSettlementZoneCell() {
    var z = window.settlementZone;
    return z ? { x: z.x, y: z.y, w: z.size, h: z.size } : { x: 65, y: 65, w: 10, h: 10 };
  }

  // Во время хода подсвечиваем ближайший к бойцу край зоны охраны
  function qGuardCell() {
    var z = qSettlementZoneCell();
    return z;
  }

  function qOwnUnits(filter) {
    var me = window.currentUserId;
    return (window.unitsOnMap || []).filter(function(u) {
      return u.owner_user_id === me && u.x !== null && u.x !== undefined && u.hp > 0 &&
             (!filter || filter(u));
    });
  }

  function qNearest(list, x, y) {
    var best = null, bd = 1e9;
    list.forEach(function(u) {
      var d = Math.max(Math.abs(u.x - x), Math.abs(u.y - y));
      if (d < bd) { bd = d; best = u; }
    });
    return best;
  }

  function qNearestOwnUnit() {
    var t = qTargetCell();
    if (!t) return null;
    var u = qNearest(qOwnUnits(), t.x, t.y);
    return u ? { x: u.x, y: u.y, w: 1, h: 1 } : null;
  }

  function qNearestInfantry() {
    var types = window.unitTypeById || {};
    var u = qNearest(qOwnUnits(function(u) {
      var t = types[u.unit_type];
      return !t || !t.is_vehicle;
    }), 70, 70);
    return u ? { x: u.x, y: u.y, w: 1, h: 1 } : null;
  }

  function qFreeSlotCell() {
    var slots = window.buildSlots || [];
    var busy = window.buildingsBySlot || {};
    var size = window.SLOT_SIZE || 6;
    for (var i = 0; i < slots.length; i++) {
      if (!busy[i + 1]) return { x: slots[i].x, y: slots[i].y, w: size, h: size };
    }
    return null;
  }

  // Уже заложенная (или готовая) постройка из списка кодов
  function qLaidCell(codes) {
    var slots = window.buildSlots || [];
    var busy = window.buildingsBySlot || {};
    var size = window.SLOT_SIZE || 6;
    for (var k in busy) {
      var code = (busy[k].building_types || {}).code;
      if (codes.indexOf(code) >= 0 && slots[k - 1]) {
        return { x: slots[k - 1].x, y: slots[k - 1].y, w: size, h: size };
      }
    }
    return null;
  }

  function qBarracksCell() {
    var slots = window.buildSlots || [];
    var busy = window.buildingsBySlot || {};
    var size = window.SLOT_SIZE || 6;
    var codes = qBarracksCodes();
    for (var k in busy) {
      var b = busy[k];
      var code = (b.building_types || {}).code;
      if (codes.indexOf(code) >= 0 && slots[k - 1]) {
        return { x: slots[k - 1].x, y: slots[k - 1].y, w: size, h: size };
      }
    }
    return null;
  }

  // Корабль целиком внутри зоны — сверяем по экрану, это быстрее опроса
  function qShipInZone(zoneSel) {
    if (QPAGE !== 'space' || !qData || !qData.focus || !qData.focus.ship) return false;
    var ship = document.querySelector('.ship-sprite[data-ship-id="' + qData.focus.ship.id + '"]');
    if (!ship) return false;
    var s = ship.getBoundingClientRect();
    var zones = document.querySelectorAll(zoneSel);
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i].getBoundingClientRect();
      if (s.left >= z.left - 1 && s.right <= z.right + 1 && s.top >= z.top - 1 && s.bottom <= z.bottom + 1) {
        return true;
      }
    }
    return false;
  }

  // Клетки поверхности в экранные координаты: канвас уже сдвинут и
  // отмасштабирован трансформацией, берём его прямоугольник как есть
  function qCellRect(c) {
    var cv = document.getElementById('ground-canvas');
    if (!cv || !c) return null;
    var r = cv.getBoundingClientRect();
    var grid = (window.GRID_SIZE || 144);
    var k = r.width / grid;
    if (!k) return null;
    return {
      left: r.left + c.x * k, top: r.top + c.y * k,
      width: c.w * k, height: c.h * k
    };
  }

  // ===== Переходы и наведение камеры =====

  function qGo(plan) {
    var url;
    if (plan.page === 'galaxy') url = 'galaxy-map.html?quest=1';
    else url = (plan.page === 'space' ? 'space-battle.html' : 'ground-battle.html') +
               '?system=' + encodeURIComponent(plan.system) + '&quest=1';
    location.href = url;
  }

  function qAutoFocus(force) {
    if (!qData || qData.status !== 'active' || qData.step_done) return;
    var plan = qPlan();
    if (!plan) return;
    if (plan.page !== QPAGE) return;
    if (plan.system && plan.system !== QSYS) return;
    // Сама камера дёргается только когда игрок пришёл по кнопке курса
    // или нажал «Показать»: иначе она уводила бы карту из-под пальца
    if (!force && !qArrived) return;
    qArrived = false;

    // Карта грузится асинхронно: ждём, пока появится то, на что смотреть
    var tries = 0;
    var go = function() {
      tries++;
      var ok = qFocusNow(plan);
      if (!ok && tries < 40) setTimeout(go, 250);
    };
    go();
  }

  function qFocusNow(plan) {
    if (plan.galaxyFocus) {
      return typeof focusGalaxySystem === 'function' && focusGalaxySystem(plan.galaxyFocus);
    }
    if (plan.shipFocus && QPAGE === 'space') {
      var f = plan.shipFocus;
      var el = document.querySelector('.ship-sprite[data-ship-id="' + f.id + '"]');
      if (!el || typeof focusCell !== 'function') return false;
      // Координаты берём у страницы: корабль мог уже сдвинуться
      var live = (window.shipsInSystem || []).filter(function(sh) { return sh.id === f.id; })[0];
      var x = live ? live.x : f.x, y = live ? live.y : f.y;
      focusCell(x + (f.w || 1) / 2, y + (f.h || 1) / 2);
      return true;
    }
    if (plan.cellFocus && QPAGE === 'ground') {
      if (!window.terrainCache || typeof focusCell !== 'function') return false;
      // С обзорного масштаба боец — точка в пару пикселей: приближаем
      // до читаемого, но не отдаляем, если игрок уже приблизил сам
      if (typeof window.scale === 'number' && window.scale < 0.7) window.scale = 0.7;
      focusCell(plan.cellFocus.x, plan.cellFocus.y);
      return true;
    }
    return true;
  }

  // ===== Подсветка =====

  var qSpot = null, qTip = null, qMarks = [], qEdges = [];
  var qSpotTarget = null;      // {el} или {cell}
  var qScrolled = null;

  function qEnsureSpot() {
    if (qSpot) return;
    qSpot = document.createElement('div');
    qSpot.id = 'quest-spot';
    qTip = document.createElement('div');
    qTip.id = 'quest-tip';
    document.body.appendChild(qSpot);
    document.body.appendChild(qTip);
  }

  function qHideSpot() {
    if (qSpot) { qSpot.style.display = 'none'; qTip.style.display = 'none'; }
    qMarks.forEach(function(m) { m.style.display = 'none'; });
    qEdges.forEach(function(m) { m.style.display = 'none'; });
    qSpotTarget = null;
  }

  function qVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return false;

    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;

    // Внутри прокручиваемого списка кнопка может быть за его краем
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      var ov = window.getComputedStyle(p).overflowY;
      if (ov === 'auto' || ov === 'scroll' || ov === 'hidden') {
        var pr = p.getBoundingClientRect();
        if (cy < pr.top || cy > pr.bottom || cx < pr.left || cx > pr.right) return false;
      }
    }

    // И не закрыта ли она сверху другим окном
    var top = document.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) return false;
    return true;
  }

  // Раз в четверть секунды решаем, что подсвечивать; позицию кольца
  // обновляем каждый кадр — карта под пальцем двигается постоянно
  function qPickTarget() {
    qSpotTarget = null;
    if (qHintsOff || qSheetOpen || !qData || qData.status !== 'active' || qData.step_done) return;
    var plan = qPlan();
    if (!plan || plan.page !== QPAGE) return;
    if (plan.system && plan.system !== QSYS) return;

    var list = plan.targets || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.when && !t.when()) continue;
      if (t.sel) {
        var els = document.querySelectorAll(t.sel);
        for (var j = 0; j < els.length; j++) {
          if (!qVisible(els[j])) {
            // Кнопка в прокручиваемом списке: докручиваем один раз
            if (t.scroll && els[j].offsetParent && qScrolled !== els[j]) {
              qScrolled = els[j];
              try { els[j].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
            }
            continue;
          }
          qSpotTarget = { el: els[j], tip: t.tip };
          break;
        }
        if (qSpotTarget) break;
      } else if (t.cell && QPAGE === 'ground') {
        var c = t.cell();
        if (!c) continue;
        var rr = qCellRect(c);
        if (!rr) continue;
        qSpotTarget = { cell: t.cell, tip: t.tip };
        break;
      }
    }

    qSpotTarget && (qSpotTarget.marks = plan.marks || []);
    if (!qSpotTarget && plan.marks && plan.marks.length) qSpotTarget = { marks: plan.marks };
  }

  function qRectOf(target) {
    if (target.el) return target.el.getBoundingClientRect();
    if (target.cell) return qCellRect(target.cell());
    return null;
  }

  function qPlace() {
    if (!qSpotTarget) { qHideSpot(); return; }
    qEnsureSpot();

    var r = (qSpotTarget.el || qSpotTarget.cell) ? qRectOf(qSpotTarget) : null;
    var edges = [];
    if (r && r.width > 0 && qSpotTarget.cell && qOffscreen(r)) {
      // Цель за краем экрана: вместо кольца — стрелка у края
      edges.push({ r: r, label: qSpotTarget.tip || 'Сюда', main: true });
      r = null;
    }
    if (r && r.width > 0) {
      var pad = 5;
      var w = Math.max(r.width + pad * 2, 30), h = Math.max(r.height + pad * 2, 30);
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      qSpot.style.display = 'block';
      qSpot.style.left = (cx - w / 2) + 'px';
      qSpot.style.top = (cy - h / 2) + 'px';
      qSpot.style.width = w + 'px';
      qSpot.style.height = h + 'px';

      qTip.textContent = qSpotTarget.tip || 'Сюда';
      qTip.style.display = 'block';
      var tw = qTip.offsetWidth, th = qTip.offsetHeight;
      var above = cy - h / 2 - th - 10 > 8;
      var tx = Math.max(8, Math.min(window.innerWidth - tw - 8, cx - tw / 2));
      var ty = above ? cy - h / 2 - th - 10 : cy + h / 2 + 10;
      if (ty + th > window.innerHeight - 8) ty = Math.max(8, cy - th / 2);
      qTip.style.left = tx + 'px';
      qTip.style.top = ty + 'px';
      qTip.className = above ? 'above' : 'below';
      qTip.style.setProperty('--ax', Math.max(10, Math.min(tw - 10, cx - tx)) + 'px');
    } else {
      qSpot.style.display = 'none';
      qTip.style.display = 'none';
    }

    // Вспомогательные рамки: зона прыжка, площадки сброса, зона охраны
    var boxes = [];
    (qSpotTarget.marks || []).forEach(function(m) {
      if (m.sel) {
        var els = document.querySelectorAll(m.sel);
        for (var i = 0; i < els.length; i++) {
          if (!m.all && i > 0) break;
          var er = els[i].getBoundingClientRect();
          if (er.width > 0) boxes.push({ r: er, label: m.label });
        }
      } else if (m.cell && QPAGE === 'ground') {
        var cr = qCellRect(m.cell());
        if (cr) boxes.push({ r: cr, label: m.label });
      }
    });

    boxes = boxes.filter(function(b) {
      if (!qOffscreen(b.r)) return true;
      edges.push({ r: b.r, label: b.label });
      return false;
    });

    while (qMarks.length < boxes.length) {
      var mk = document.createElement('div');
      mk.className = 'quest-mark';
      mk.innerHTML = '<span></span>';
      document.body.appendChild(mk);
      qMarks.push(mk);
    }
    qMarks.forEach(function(mk, i) {
      var b = boxes[i];
      if (!b) { mk.style.display = 'none'; return; }
      mk.style.display = 'block';
      mk.style.left = b.r.left + 'px';
      mk.style.top = b.r.top + 'px';
      mk.style.width = b.r.width + 'px';
      mk.style.height = b.r.height + 'px';
      mk.firstChild.textContent = b.label || '';
    });

    while (qEdges.length < edges.length) {
      var eg = document.createElement('div');
      eg.className = 'quest-edge';
      eg.innerHTML = '<i></i><span></span>';
      document.body.appendChild(eg);
      qEdges.push(eg);
    }
    qEdges.forEach(function(eg, i) {
      var e = edges[i];
      if (!e) { eg.style.display = 'none'; return; }
      var W = window.innerWidth, H = window.innerHeight;
      var tx = e.r.left + e.r.width / 2, ty = e.r.top + e.r.height / 2;
      var ang = Math.atan2(ty - H / 2, tx - W / 2);
      var arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
      var k = Math.round(ang / (Math.PI / 4));
      eg.firstChild.textContent = arrows[(k + 8) % 8];
      eg.lastChild.textContent = e.label || '';
      eg.classList.toggle('main', !!e.main);
      eg.style.display = 'flex';
      var ew = eg.offsetWidth, eh = eg.offsetHeight;
      var x = Math.max(10, Math.min(W - ew - 10, tx - ew / 2));
      // Снизу не залезаем под панель юнита или корабля
      var bottomPad = Math.max(96, (window.uiBottomInset || 0) + 10);
      var y = Math.max(108, Math.min(H - eh - bottomPad, ty - eh / 2));
      eg.style.left = x + 'px';
      eg.style.top = y + 'px';
    });
  }

  function qOffscreen(r) {
    return r.bottom < 96 || r.top > window.innerHeight - 20 ||
           r.right < 0 || r.left > window.innerWidth;
  }

  var qLastPick = 0;
  var qLooping = false;
  function qFrame(ts) {
    // Курс пройден и итог закрыт — кадры больше не нужны
    if (!qData || (qData.status !== 'active' && !qJustFinished)) {
      qHideSpot();
      qLooping = false;
      return;
    }
    if (ts - qLastPick > 250) { qLastPick = ts; qPickTarget(); }
    qPlace();
    // Перелёт: трекер тикает раз в кадр, а обновляется текст раз в секунду
    if (qData && qData.status === 'active' && qData.current && qData.current.id === 'arrive' &&
        !qData.step_done && ts - (qFrame.t || 0) > 1000) {
      qFrame.t = ts;
      var g = document.querySelector('#quest-tracker .qt-goal');
      if (g) g.textContent = qTrackerLine();
    }
    requestAnimationFrame(qFrame);
  }

  // ===== Старт =====

  function qStart() {
    if (typeof supabase === 'undefined') return;
    supabase.auth.getSession().then(function(res) {
      if (!res.data || !res.data.session) return;
      qLoad().then(function() {
        if (!qData || qData.status !== 'active') return;
        // Первое знакомство: наставник выходит сам
        if (QPAGE === 'galaxy' && qData.step_ord === 1 && !qData.step_done) {
          setTimeout(qOpenSheet, 600);
        }
      });
    });
  }

  function qLoop() {
    if (qLooping) return;
    qLooping = true;
    requestAnimationFrame(qFrame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(qStart, 300); });
  } else {
    setTimeout(qStart, 300);
  }
})();
