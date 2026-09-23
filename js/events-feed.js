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
  feedTimer = setInterval(refreshFeedCounts, 30000);
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
  if (isEta && e.amount > 0) {
    line += (line ? ' · ' : '') + 'прибудет через ' + feedEta(e.amount);
  } else if (e.amount && e.amount > 1) {
    line += (line ? ' · ' : '') + e.amount;
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
      '<div class="feed-meta">' + feedWhen(e.created_at) +
        (where ? ' · ' + where : '') + '</div>' +
    '</div>';

  // Переносить карту есть смысл только туда, где есть что показать
  if (e.jumpable && e.system_id && !e.is_deep_space) {
    var go = document.createElement('button');
    go.className = 'feed-go';
    go.textContent = 'Показать';
    go.addEventListener('click', function() {
      closeEventsFeed();

      var ok = (typeof focusGalaxySystem === 'function')
        && focusGalaxySystem(e.system_id);

      if (!ok && typeof openPlanetInfo === 'function') openPlanetInfo(e.system_id);
    });
    row.appendChild(go);
  }

  return row;
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
