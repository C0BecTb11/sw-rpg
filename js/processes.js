// Экран «Процессы»: всё, что сейчас происходит во владениях игрока.
// Только свои планеты — союзные не показываем, иначе список превратится
// в ленту всей фракции и потеряет смысл.
//
// Простаивающие линии выводятся наравне с работающими: пустой слот это
// тоже процесс, просто остановленный, и заметить его важнее всего.

var processesTimer = null;
var processesData = [];
var processesLoading = false;  // запрос уже в пути — второй не шлём
var processesTicks = 0;

function openProcessesScreen() {
  var screen = document.getElementById('processes-screen');
  var list = document.getElementById('processes-list');

  screen.style.display = 'block';
  list.innerHTML = '<div class="army-empty">Загрузка...</div>';

  loadProcesses();

  // Таймеры тикают локально, к базе ходим раз в полминуты
  if (processesTimer) clearInterval(processesTimer);
  processesTicks = 0;
  processesTimer = setInterval(function() {
    processesTicks++;
    if (processesTicks % 30 === 0) { loadProcesses(); return; }
    tickProcesses();
  }, 1000);
}

function closeProcessesScreen() {
  document.getElementById('processes-screen').style.display = 'none';
  if (processesTimer) { clearInterval(processesTimer); processesTimer = null; }
}

function loadProcesses() {
  if (processesLoading) return;
  processesLoading = true;
  // v2 знает, где на карте здание: из списка можно сразу туда перейти
  return supabase.rpc('get_my_processes_v2').then(function(res) {
    if (res.error) return supabase.rpc('get_my_processes');
    return res;
  }).then(function(res) {
    processesLoading = false;
    // Экран уже закрыли — рисовать некуда
    if (!processesTimer) return;
    if (res.error) {
      document.getElementById('processes-list').innerHTML =
        '<div class="army-empty">Не удалось загрузить</div>';
      return;
    }
    processesData = res.data || [];
    renderProcesses();
  }, function() { processesLoading = false; });
}

function formatProcessLeft(sec) {
  if (sec <= 0) return 'готово';
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  if (h > 0) return h + ' ч ' + m + ' мин';
  if (m > 0) return m + ' мин ' + s + ' с';
  return s + ' с';
}

var PROCESS_KINDS = {
  unit:         { label: 'производство', cls: 'unit' },
  ship:         { label: 'верфь',        cls: 'ship' },
  construction: { label: 'стройка',      cls: 'construction' },
  research:     { label: 'наука',        cls: 'research' },
  idle:         { label: 'простой',      cls: 'idle' }
};

// Что делать с простаивающей линией: подпись и кнопка
var PROCESS_IDLE = {
  hire:     { text: 'Цех свободен — закажи бойцов',          go: 'Нанять' },
  research: { text: 'Лаборатория свободна — начни изучение', go: 'Изучить' },
  shipyard: { text: 'Верфь свободна — заложи корабль',       go: 'На верфь' }
};

// Куда ведёт строка: земля (участок базы) или орбита (верфь, станция)
function processUrl(p) {
  if (!p.layer) return null;
  var sys = 'system=' + encodeURIComponent(p.system_id);
  if (p.layer === 'space') {
    return 'space-battle.html?' + sys + '&open=' + (p.target === 'station' ? 'station' : 'shipyard');
  }
  if (p.slot_index === null || p.slot_index === undefined) return 'ground-battle.html?' + sys;
  return 'ground-battle.html?' + sys + '&slot=' + p.slot_index + (p.target === 'open' ? '&open=slot' : '');
}

function renderProcesses() {
  var list = document.getElementById('processes-list');

  if (!processesData.length) {
    list.innerHTML = '<div class="army-empty">Под твоим управлением ничего не происходит</div>';
    return;
  }

  // Группируем по планетам: игрок мыслит владениями, а не списком задач.
  // Простой — наверх: на него и надо реагировать.
  var bySystem = {};
  var order = [];
  var idleTotal = 0, busyTotal = 0;
  processesData.forEach(function(p) {
    if (!bySystem[p.system_id]) { bySystem[p.system_id] = []; order.push(p.system_id); }
    bySystem[p.system_id].push(p);
    if (p.kind === 'idle') idleTotal++; else busyTotal++;
  });

  list.innerHTML = '';

  // Сводка сверху: сколько стоит без дела
  var sum = document.createElement('div');
  sum.className = 'process-summary' + (idleTotal ? ' has-idle' : '');
  sum.innerHTML =
    '<div class="process-sum-cell busy"><b>' + busyTotal + '</b><span>в работе</span></div>' +
    '<div class="process-sum-cell idle"><b>' + idleTotal + '</b><span>простаивает</span></div>' +
    (idleTotal ? '<div class="process-sum-hint">Нажми на простой — откроется нужное здание</div>' : '');
  list.appendChild(sum);

  order.forEach(function(sysId) {
    var rows = bySystem[sysId].slice().sort(function(a, b) {
      return (a.kind === 'idle' ? 0 : 1) - (b.kind === 'idle' ? 0 : 1);
    });
    var idle = rows.filter(function(r) { return r.kind === 'idle'; }).length;

    var head = document.createElement('div');
    head.className = 'process-planet';
    head.innerHTML = escapeProcess(rows[0].system_name) +
      '<span class="process-count">' + (rows.length - idle) + '</span>' +
      (idle ? '<span class="process-count idle">' + idle + ' без дела</span>' : '');
    list.appendChild(head);

    rows.forEach(function(p) {
      var kind = PROCESS_KINDS[p.kind] || PROCESS_KINDS.unit;
      var url = processUrl(p);
      var idleInfo = p.kind === 'idle'
        ? (PROCESS_IDLE[p.subject] || { text: 'Здание без дела', go: 'Открыть' })
        : null;

      var row = document.createElement(url ? 'button' : 'div');
      row.className = 'process-row ' + kind.cls + (url ? ' go' : '');
      row.setAttribute('data-idx', processesData.indexOf(p));
      if (url) row.type = 'button';

      var main = idleInfo
        ? '<span class="process-idle">' + idleInfo.text + '</span>'
        : escapeProcess(p.subject) + (p.quantity > 1 ? ' ×' + p.quantity : '');

      row.innerHTML =
        '<div class="process-body">' +
          '<div class="process-line">' +
            '<span class="process-place">' + escapeProcess(p.place) + '</span>' +
            '<span class="process-kind">' + kind.label + '</span>' +
          '</div>' +
          '<div class="process-main">' + main + '</div>' +
          (p.kind === 'idle' ? '' :
            '<div class="process-track"><i style="width:' + processPct(p) + '%"></i></div>' +
            '<div class="process-left">' + formatProcessLeft(p.seconds_left) + '</div>') +
        '</div>' +
        (url ? (idleInfo
          ? '<span class="process-go">' + idleInfo.go + ' ›</span>'
          : '<span class="process-chev">›</span>') : '');

      if (url) {
        row.addEventListener('click', function() {
          closeProcessesScreen();
          window.location.href = url;
        });
      }

      list.appendChild(row);
    });
  });
}

function escapeProcess(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function processPct(p) {
  var total = Math.max(1, p.total_seconds || 1);
  var done = total - Math.max(0, p.seconds_left);
  return Math.max(0, Math.min(100, (done / total) * 100));
}

// Секунды отсчитываем локально, чтобы полосы шли плавно и без запросов
function tickProcesses() {
  var changed = false;
  var justDone = false;

  processesData.forEach(function(p) {
    if (p.kind === 'idle') return;
    if (p.seconds_left > 0) {
      p.seconds_left -= 1;
      changed = true;
      if (p.seconds_left <= 0) justDone = true;
    }
  });

  if (!changed) return;

  // Что-то завершилось именно сейчас — просим сервер выдать готовое сразу,
  // а не на своём тике раз в 30 секунд, и перечитываем: там уже другой состав
  if (justDone) {
    supabase.rpc('claim_ready_now').then(loadProcesses, loadProcesses);
    return;
  }

  // Каждую секунду двигаем только полосы и цифры: если пересоздавать
  // строки, тап, начатый между кадрами, теряется
  var rows = document.querySelectorAll('#processes-list .process-row[data-idx]');
  for (var i = 0; i < rows.length; i++) {
    var p = processesData[parseInt(rows[i].getAttribute('data-idx'), 10)];
    if (!p || p.kind === 'idle') continue;
    var bar = rows[i].querySelector('.process-track i');
    var left = rows[i].querySelector('.process-left');
    if (bar) bar.style.width = processPct(p) + '%';
    if (left) left.textContent = formatProcessLeft(p.seconds_left);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('panel-item-processes');
  if (btn) btn.addEventListener('click', openProcessesScreen);

  var closeBtn = document.getElementById('processes-close');
  if (closeBtn) closeBtn.addEventListener('click', closeProcessesScreen);
});
