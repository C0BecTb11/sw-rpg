// Лента событий в галактическом худе.
//
// База писала события с самого начала, но показать их было негде: игрок
// узнавал о перехваченном флоте, только не найдя его на месте. Здесь
// четыре вкладки по смыслу — бой, хозяйство, фракция, доходы — и кнопка
// переноса карты к месту события.
//
// Разбором на категории и человеческими заголовками занимается база
// (таблица event_types), клиент только рисует. Так новый тип события
// появляется одной строкой в каталоге, без правки этого файла.

var feedTab = 'combat';
var feedCounts = {};
var feedTimer = null;

var FEED_TABS = [
  { id: 'combat',  name: 'Бой' },
  { id: 'build',   name: 'Хозяйство' },
  { id: 'faction', name: 'Фракция' },
  { id: 'income',  name: 'Доходы' }
];

function initEventsFeed() {
  var bell = document.getElementById('feed-bell');
  if (!bell) return;

  bell.addEventListener('click', openEventsFeed);

  var close = document.getElementById('feed-close');
  if (close) close.addEventListener('click', closeEventsFeed);

  var tabs = document.getElementById('feed-tabs');
  FEED_TABS.forEach(function(t) {
    var b = document.createElement('button');
    b.className = 'feed-tab';
    b.setAttribute('data-tab', t.id);
    b.innerHTML = '<span>' + t.name + '</span><i class="feed-badge"></i>';
    b.addEventListener('click', function() { setFeedTab(t.id); });
    tabs.appendChild(b);
  });

  refreshFeedCounts();
  // Пока вкладка спрятана, счётчики не опрашиваем; вернулся — сразу свежие
  feedTimer = setInterval(function() { if (!document.hidden) refreshFeedCounts(); }, 30000);
  document.addEventListener('visibilitychange', function() { if (!document.hidden) refreshFeedCounts(); });
}

// Счётчики непрочитанного тикают в фоне: значок должен загораться
// сам, а не после того как игрок откроет панель
function refreshFeedCounts() {
  supabase.rpc('get_event_counts').then(function(res) {
    if (res.error) return;

    feedCounts = {};
    var total = 0;
    (res.data || []).forEach(function(row) {
      feedCounts[row.category] = row.unseen;
      total += row.unseen;
    });

    var bell = document.getElementById('feed-bell');
    var mark = document.getElementById('feed-bell-count');
    if (!bell || !mark) return;

    mark.textContent = total > 99 ? '99+' : total;
    bell.classList.toggle('has-unseen', total > 0);

    paintFeedBadges();
  });
}

function paintFeedBadges() {
  var tabs = document.querySelectorAll('.feed-tab');
  for (var i = 0; i < tabs.length; i++) {
    var id = tabs[i].getAttribute('data-tab');
    var badge = tabs[i].querySelector('.feed-badge');
    // Доходы это состояние, а не поток новостей: считать там нечего
    var n = id === 'income' ? 0 : (feedCounts[id] || 0);
    badge.textContent = n > 99 ? '99+' : n;
    badge.style.display = n > 0 ? 'inline-block' : 'none';
    tabs[i].classList.toggle('active', id === feedTab);
  }
}

function openEventsFeed() {
  document.getElementById('feed-panel').style.display = 'flex';
  setFeedTab(feedTab);
  if (typeof questSeen === 'function') questSeen('feed');
}

function closeEventsFeed() {
  document.getElementById('feed-panel').style.display = 'none';
  refreshFeedCounts();
}

function setFeedTab(tab) {
  feedTab = tab;
  paintFeedBadges();

  var body = document.getElementById('feed-body');
  body.innerHTML = '<div class="feed-empty">Загрузка...</div>';

  if (tab === 'income') { renderIncomePanel(body); return; }

  supabase.rpc('get_event_feed', { p_category: tab, p_limit: 60 })
    .then(function(res) {
      if (res.error) {
        body.innerHTML = '<div class="feed-empty">Не удалось прочитать ленту</div>';
        return;
      }

      var rows = res.data || [];
      body.innerHTML = '';

      if (!rows.length) {
        body.innerHTML = '<div class="feed-empty">Здесь пока тихо</div>';
        return;
      }

      rows.forEach(function(e) { body.appendChild(makeFeedRow(e)); });

      // Прочитано ровно то, что игрок увидел на этой вкладке
      supabase.rpc('mark_events_seen', { p_category: tab }).then(refreshFeedCounts);
    });
}

function makeFeedRow(e) {
  var row = document.createElement('div');
  row.className = 'feed-row tone-' + e.tone + (e.seen ? '' : ' fresh');

  var line = e.subject ? e.subject : '';

  // У «на подходе» число — это секунды до прибытия, а не количество
  var isEta = e.type === 'enemy_approaching' || e.type === 'trade_approaching';
  var fmt = FEED_AMOUNT[e.type];
  if (isEta && e.amount > 0) {
    line += (line ? ' · ' : '') + 'прибудет через ' + feedEta(e.amount);
  } else if (fmt && e.amount > 0 && !(e.meta && e.meta.digest)) {
    // Число с подписью: урон, лечение или кредиты — голая цифра непонятна
    line += (line ? ' · ' : '') +
      (fmt === 'dmg' ? '−' + e.amount : fmt === 'heal' ? '+' + e.amount : e.amount + ' кр.');
  } else if (e.amount && e.amount > 1 && !(e.meta && e.meta.digest)) {
    line += (line ? ' · ' : '') + e.amount;
  }

  // Стройка: когда закончится — по серверному времени
  if (e.meta && e.meta.until && typeof svDayWord === 'function') {
    var until = new Date(e.meta.until).getTime();
    if (until > (typeof svNow === 'function' ? svNow() : Date.now())) {
      line += (line ? ' · ' : '') + 'готово ' + svDayWord(until) + 'в ' + svFormatTime(until) + ' ' + svClock.label;
    }
  }

  // Аренда производства: кто, что, на сколько и почём — своей строкой
  if (e.type && e.type.indexOf('lease_') === 0 && typeof plFeedLine === 'function') {
    line = plFeedLine(e);
  }

  // Кто привёз: получатель должен видеть отправителя, а не только груз
  if (e.meta && e.meta.from_player) {
    line = e.meta.from_player + ' доставил: ' + line;
  }

  // Откуда идёт флот — сервер уже перевёл код планеты в название
  if (e.meta && e.meta.from_name) {
    line += (line ? ' · ' : '') + 'из ' + e.meta.from_name;
  }

  var where = e.system_name
    ? (e.is_deep_space ? e.system_name : 'планета ' + e.system_name)
    : '';

  row.innerHTML =
    '<div class="feed-info">' +
      '<div class="feed-title">' + e.title + '</div>' +
      (line ? '<div class="feed-line">' + escapeFeed(line) + '</div>' : '') +
      feedDigestLines(e) +
      '<div class="feed-meta">' + feedWhen(e.created_at) +
        (where ? ' · ' + where : '') + '</div>' +
    '</div>';

  // «Показать» ведёт туда, где событие произошло: к бойцу на земле,
  // к кораблю на орбите, к зданию или поселению. Что относится к планете
  // целиком (выдача планеты, конвои, рынок) — по-прежнему на галактику.
  var target = e.jumpable && e.system_id ? feedTarget(e) : null;
  if (target || (e.jumpable && e.system_id && !e.is_deep_space)) {
    var go = document.createElement('button');
    go.className = 'feed-go';
    go.textContent = 'Показать';
    go.addEventListener('click', function() {
      closeEventsFeed();

      if (target) { window.location.href = target; return; }

      var ok = (typeof focusGalaxySystem === 'function')
        && focusGalaxySystem(e.system_id);

      if (!ok && typeof openPlanetInfo === 'function') openPlanetInfo(e.system_id);
    });
    row.appendChild(go);
  }

  // Передача войск: карты тут нет, зато есть меню, где её подтверждают
  if (e.meta && e.meta.transfer_id && typeof openTransferPanel === 'function') {
    var open = document.createElement('button');
    open.className = 'feed-go';
    open.textContent = 'Открыть';
    var inbound = e.type === 'transfer_offer' || e.type === 'transfer_received'
               || e.type === 'transfer_cancelled';
    open.addEventListener('click', function() {
      closeEventsFeed();
      openTransferPanel(inbound ? 'inbox' : 'out');
    });
    row.appendChild(open);
  }

  // Аренда производства: ответить или посмотреть — в шторке аренды
  if (e.meta && e.meta.lease_id && typeof openLeasePanel === 'function') {
    var lease = document.createElement('button');
    lease.className = 'feed-go';
    lease.textContent = e.type === 'lease_offered' ? 'Ответить' : 'Открыть';
    lease.addEventListener('click', function() {
      closeEventsFeed();
      openLeasePanel();
    });
    row.appendChild(lease);
  }

  // Вводный курс: из события прямо к наставнику
  if (e.type === 'tutorial_done' && typeof openQuest === 'function') {
    var qb = document.createElement('button');
    qb.className = 'feed-go';
    qb.textContent = 'Открыть';
    qb.addEventListener('click', function() {
      closeEventsFeed();
      openQuest();
    });
    row.appendChild(qb);
  }

  // Запрос планеты: лидер сразу попадает к списку запросов
  if (e.type === 'planet_request' && typeof openPlanetRequests === 'function') {
    var review = document.createElement('button');
    review.className = 'feed-go';
    review.textContent = 'Рассмотреть';
    review.addEventListener('click', function() {
      closeEventsFeed();
      openPlanetRequests();
    });
    row.appendChild(review);
  }

  return row;
}

// ---------- Куда ведёт «Показать» ----------

// Число в событии: урон, лечение, кредиты
var FEED_AMOUNT = {
  unit_hit: 'dmg', unit_damaged: 'dmg', artillery_hit: 'dmg', ship_hit: 'dmg',
  return_fire: 'dmg', npc_return_fire: 'dmg', unit_healed: 'heal',
  settlement_festival: 'cr', settlement_donation: 'cr'
};

function feedSet(list) {
  var o = {};
  list.forEach(function(k) { o[k] = true; });
  return o;
}

// Орбита: корабли, станция, флот в системе
var FEED_SPACE = feedSet(['ship_built', 'ship_lost', 'ship_destroyed', 'ship_hit', 'ship_missed',
  'tractor_locked', 'station_built', 'station_started', 'station_demolished', 'refit_done',
  'hangar_restocked', 'fleet_arrived', 'fleet_pushed_out', 'fleet_stranded', 'cargo_delivered',
  'cargo_lost']);
var FEED_STATION = feedSet(['station_built', 'station_started']);

// Поселение: открываем его панель
var FEED_SETTLEMENT = feedSet(['district_built', 'district_started', 'settlement_upgrade',
  'settlement_level_up', 'settlement_hungry', 'settlement_failed', 'settlement_gift',
  'settlement_donation', 'settlement_festival', 'settlement_income', 'capture_started',
  'planet_captured', 'marauder_raid', 'marauder_loot',
  // Дневной налёт: разведка, подход, итог — к строке задачи в панели поселения
  // (marauder_raid несёт x/y вожака и ведёт прямо к банде)
  'marauder_scouted', 'marauder_approach', 'marauder_defeated', 'marauder_left']);

// Земля без точного места — просто карта планеты
var FEED_GROUND = feedSet(['unit_deployed', 'unit_loaded', 'unit_killed', 'unit_damaged',
  'unit_missed', 'unit_hit', 'unit_healed', 'hero_died', 'hero_hired', 'hero_trained',
  'hero_training', 'artillery_strike', 'artillery_hit', 'return_fire', 'npc_return_fire', 'turret_report',
  'structure_built', 'structure_started', 'structure_lost', 'structure_destroyed',
  'scout_arrived', 'scout_jammed', 'building_built', 'building_started', 'building_demolished',
  'research_done', 'production_idle', 'mind_released', 'troops_pushed_out', 'militia_raised', 'ability_used', 'enemy_spotted',
  'repair_done']);

// Поселение: события налёта и условий — сразу на вкладку «Условия»
var FEED_STL_TASKS = feedSet(['marauder_scouted', 'marauder_approach', 'marauder_defeated',
  'marauder_left', 'settlement_failed', 'settlement_hungry']);

// Здание: по готовности сразу открываем его занятие (наём, исследования)
var FEED_OPEN_SLOT = feedSet(['building_built', 'research_done', 'production_idle']);

function feedTarget(e) {
  var m = e.meta || {};
  var sys = 'system=' + encodeURIComponent(e.system_id);
  var has = function(v) { return v !== null && v !== undefined; };
  var xy = has(m.x) && has(m.y) ? '&x=' + m.x + '&y=' + m.y : '';

  // Сводка по нескольким планетам — одной карты у неё нет, остаётся галактика
  if (m.digest && m.lines && m.lines.length > 1) return null;

  var space = m.layer === 'space' || (!m.layer && FEED_SPACE[e.type]);
  if (space) {
    if (m.ship_id) return 'space-battle.html?' + sys + '&ship=' + encodeURIComponent(m.ship_id) + xy;
    if (FEED_STATION[e.type]) return 'space-battle.html?' + sys + '&open=station';
    return 'space-battle.html?' + sys + xy;
  }

  // В пустоте земли нет
  if (e.is_deep_space) return null;

  if (m.unit_id) return 'ground-battle.html?' + sys + '&unit=' + encodeURIComponent(m.unit_id) + xy;
  if (xy) return 'ground-battle.html?' + sys + xy;
  // Квартал тоже несёт slot, но это участок поселения, а не базы —
  // поэтому поселение проверяем раньше построек
  if (FEED_SETTLEMENT[e.type]) {
    return 'ground-battle.html?' + sys + '&open=settlement' + (FEED_STL_TASKS[e.type] ? '&tab=tasks' : '');
  }
  if (has(m.slot)) {
    return 'ground-battle.html?' + sys + '&slot=' + m.slot +
      (FEED_OPEN_SLOT[e.type] ? '&open=slot' : '') +
      (m.building_id ? '&bid=' + encodeURIComponent(m.building_id) : '');
  }
  if (FEED_GROUND[e.type]) return 'ground-battle.html?' + sys;
  return null;
}

// Сводное событие: по строке на планету. Сервер складывает сюда всё
// однотипное, пока игрок не прочитал, — вместо десятка одинаковых записей
function feedDigestLines(e) {
  var lines = e.meta && e.meta.digest && e.meta.lines;
  if (!lines || !lines.length) return '';
  return '<div class="feed-lines">' + lines.map(function(l) {
    var bad = /провал|не хватает|полон/.test(l.txt || '');
    return '<i' + (bad ? ' class="warn"' : '') + '>' + escapeFeed(l.txt) + '</i>';
  }).join('') + '</div>';
}

// Доходы вынесены в свою вкладку: это не поток событий, а состояние
function renderIncomePanel(body) {
  supabase.rpc('get_income_summary').then(function(res) {
    if (res.error) {
      body.innerHTML = '<div class="feed-empty">Не удалось прочитать сводку</div>';
      return;
    }

    var rows = res.data || [];
    body.innerHTML = '';

    if (!rows.length) {
      body.innerHTML = '<div class="feed-empty">Планет под управлением нет</div>';
      return;
    }

    var sum = 0;
    rows.forEach(function(r) { sum += r.last_income || 0; });

    var head = document.createElement('div');
    head.className = 'feed-income-head';
    head.innerHTML = '<b>' + sum + '</b><span>кредитов в сутки со всех владений</span>';
    body.appendChild(head);

    rows.forEach(function(r) {
      var row = document.createElement('div');
      row.className = 'feed-row' + (r.tasks_failed ? ' tone-warn' : '');

      row.innerHTML =
        '<div class="feed-info">' +
          '<div class="feed-title">' + r.system_name + '</div>' +
          '<div class="feed-line">Довольство ' + r.satisfaction +
            ' · за сутки получено ' + (r.paid_today || 0) + '</div>' +
          (r.tasks_failed
            ? '<div class="feed-meta warn">Не выполнено условий: ' + r.tasks_failed + '</div>'
            : '<div class="feed-meta">Условия выполняются</div>') +
        '</div>' +
        '<div class="feed-income">' + (r.last_income || 0) +
          '<span>в сутки</span></div>';

      body.appendChild(row);
    });
  });
}

function feedEta(sec) {
  if (sec >= 60) return Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' с';
  return sec + ' с';
}

function feedWhen(iso) {
  var sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'только что';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин назад';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ч назад';
  return Math.floor(sec / 86400) + ' дн назад';
}

function escapeFeed(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', initEventsFeed);
