// Экран «Процессы»: всё, что сейчас происходит во владениях игрока.
// Только свои планеты — союзные не показываем, иначе список превратится
// в ленту всей фракции и потеряет смысл.
//
// Простаивающие линии выводятся наравне с работающими: пустой слот это
// тоже процесс, просто остановленный, и заметить его важнее всего.

var processesTimer = null;
var processesData = [];

function openProcessesScreen() {
  var screen = document.getElementById('processes-screen');
  var list = document.getElementById('processes-list');

  screen.style.display = 'block';
  list.innerHTML = '<div class="army-empty">Загрузка...</div>';

  loadProcesses();

  // Таймеры тикают локально, к базе ходим раз в полминуты
  if (processesTimer) clearInterval(processesTimer);
  processesTimer = setInterval(function() {
    tickProcesses();
  }, 1000);
}

function closeProcessesScreen() {
  document.getElementById('processes-screen').style.display = 'none';
  if (processesTimer) { clearInterval(processesTimer); processesTimer = null; }
}

function loadProcesses() {
  return supabase.rpc('get_my_processes').then(function(res) {
    if (res.error) {
      document.getElementById('processes-list').innerHTML =
        '<div class="army-empty">Не удалось загрузить</div>';
      return;
    }
    processesData = res.data || [];
    renderProcesses();
  });
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
  idle:         { label: 'простой',      cls: 'idle' }
};

function renderProcesses() {
  var list = document.getElementById('processes-list');

  if (!processesData.length) {
    list.innerHTML = '<div class="army-empty">Под твоим управлением ничего не происходит</div>';
    return;
  }

  // Группируем по планетам: игрок мыслит владениями, а не списком задач
  var bySystem = {};
  var order = [];
  processesData.forEach(function(p) {
    if (!bySystem[p.system_id]) { bySystem[p.system_id] = []; order.push(p.system_id); }
    bySystem[p.system_id].push(p);
  });

  list.innerHTML = '';

  order.forEach(function(sysId) {
    var rows = bySystem[sysId];

    var head = document.createElement('div');
    head.className = 'process-planet';
    head.innerHTML = rows[0].system_name +
      '<span class="process-count">' +
        rows.filter(function(r) { return r.kind !== 'idle'; }).length + '</span>';
    list.appendChild(head);

    rows.forEach(function(p, i) {
      var kind = PROCESS_KINDS[p.kind] || PROCESS_KINDS.unit;

      var row = document.createElement('div');
      row.className = 'process-row ' + kind.cls;
      row.dataset.key = sysId + ':' + i;

      var main = p.kind === 'idle'
        ? '<span class="process-idle">слот для производства свободен</span>'
        : p.subject + (p.quantity > 1 ? ' ×' + p.quantity : '');

      row.innerHTML =
        '<div class="process-line">' +
          '<span class="process-place">' + p.place + '</span>' +
          '<span class="process-kind">' + kind.label + '</span>' +
        '</div>' +
        '<div class="process-main">' + main + '</div>' +
        (p.kind === 'idle' ? '' :
          '<div class="process-track"><i style="width:' + processPct(p) + '%"></i></div>' +
          '<div class="process-left">' + formatProcessLeft(p.seconds_left) + '</div>');

      list.appendChild(row);
    });
  });
}

function processPct(p) {
  var total = Math.max(1, p.total_seconds || 1);
  var done = total - Math.max(0, p.seconds_left);
  return Math.max(0, Math.min(100, (done / total) * 100));
}

// Секунды отсчитываем локально, чтобы полосы шли плавно и без запросов
function tickProcesses() {
  var changed = false;

  processesData.forEach(function(p) {
    if (p.kind === 'idle') return;
    if (p.seconds_left > 0) { p.seconds_left -= 1; changed = true; }
  });

  if (!changed) return;

  // Что-то завершилось — перечитываем: там уже другой состав
  if (processesData.some(function(p) { return p.kind !== 'idle' && p.seconds_left <= 0; })) {
    loadProcesses();
    return;
  }

  renderProcesses();
}

document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('panel-item-processes');
  if (btn) btn.addEventListener('click', openProcessesScreen);

  var closeBtn = document.getElementById('processes-close');
  if (closeBtn) closeBtn.addEventListener('click', closeProcessesScreen);
});
