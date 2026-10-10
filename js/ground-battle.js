// Наземное поле конкретной планеты (system=id в URL).
// Ландшафт генерируется процедурно на основе id планеты как seed —
// у каждой планеты свой уникальный, но воспроизводимый рельеф
// (трава/лес/маленькие озёра, без рек и больших водоёмов).
// В верхней части поля — 7 слотов под постройки (2x2 клетки каждый),
// расположены вразброс, но в относительной близости друг к другу.
// Строить может только игрок, назначенный контролёром системы
// (system_control) — проверка реально идёт на уровне RLS в БД при записи.

// 120 игрового поля плюс приросшие снизу 4 ряда полосы вторжения
var GRID_SIZE = 144;   // 140 игрового поля плюс 4 ряда полосы вторжения
var CELL_PX = 32;     // размер клетки в px на канвасе (уменьшен под возросший размер поля)
var SLOT_COUNT = 7;
var SLOT_SIZE = 6;    // 6x6 клеток на слот

var systemId = null;
var buildMode = false;   // пустые слоты показываем только в режиме стройки
var scale = 1;
var panX = 0;
var panY = 0;

var viewport, canvas, ctx;
var buildSlots = [];       // [{x,y}] верхний левый угол каждого слота
var deployZones = [];      // две зоны высадки 6x6 у верхнего края карты
var DEPLOY_SIZE = 6;
var ATTACK_ZONE_H = 4;   // высота полосы вторжения, приходит из game_settings
var iAmAttacker = null;  // null — ещё не выяснено
var myFaction = null;
var sysFaction = null;

// Геометрию поселения берём из базы: расхождение значило бы, что игрок
// видит одну зону, а захват считается по другой
var settlement = null;
var settlementZone = null;
var captureState = null;
var captureGoal = 60;

function loadSettlement() {
  return Promise.all([
    supabase.rpc('settlement_box'),
    supabase.rpc('settlement_zone_box'),
    supabase.from('game_settings').select('value').eq('key', 'capture_seconds').maybeSingle()
  ]).then(function(r) {
    if (!r[0].error && r[0].data && r[0].data.length) settlement = r[0].data[0];
    if (!r[1].error && r[1].data && r[1].data.length) settlementZone = r[1].data[0];
    if (!r[2].error && r[2].data) captureGoal = parseInt(r[2].data.value, 10) || 60;
    redrawScene();
    if (window.sceneLoader) sceneLoader.mark('settlement');
  });
}

function loadCaptureState() {
  return supabase.rpc('get_capture_state', { p_system_id: systemId }).then(function(res) {
    captureState = (res.error || !res.data || !res.data.length) ? null : res.data[0];
    if (captureState) captureGoal = captureState.goal || captureGoal;
    renderCaptureBar();
    redrawScene();
  });
}

// Прогресс выводим из скорости и точки отсчёта, а не спрашиваем каждую
// секунду. При суточном захвате опрос был бы бессмысленной нагрузкой:
// база всё равно не меняется, пока в зоне не сменился расклад сил.
function captureProgressNow() {
  if (!captureState) return 0;
  var elapsed = (gbServerNow() - new Date(captureState.updated_at).getTime()) / 1000;
  var p = Number(captureState.progress) + captureState.rate * elapsed;
  return Math.max(0, Math.min(captureGoal, p));
}

function formatCaptureLeft(sec) {
  sec = Math.max(0, Math.round(sec));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' ч ' + m + ' мин';
  if (m > 0) return m + ' мин ' + (sec % 60) + ' с';
  return sec + ' с';
}

// ===== Разведсводка =====
// Единственный способ узнать о вражеском командире: свой разведчик
// на планете. Полоса появляется только когда есть что сообщить.
function loadScoutReport() {
  supabase.rpc('get_scouted_commanders', { p_system_id: systemId }).then(function(res) {
    var bar = document.getElementById('scout-bar');
    if (!bar) return;

    var list = (!res.error && res.data) ? res.data : [];

    if (!list.length) { bar.style.display = 'none'; return; }

    // Раньше сводка висела полосой во всю ширину посреди карты и закрывала
    // обзор. Теперь это компактная плашка в углу: число и тревожный цвет,
    // если кто-то на подходе. Подробности — по нажатию.
    var here = list.filter(function(c) { return !c.arriving; }).length;
    var soon = list.length - here;

    var lines = list.map(function(c) {
      var who = escHtml(c.commander_name) + (c.player_name ? ' · ' + escHtml(c.player_name) : '');
      return c.arriving
        ? '<i class="scout-soon">' + who + ' — прибудет через ' +
          formatLeft(c.seconds_left) + '</i>'
        : '<i>' + who + ' — здесь</i>';
    });

    bar.classList.toggle('alert', soon > 0);
    bar.innerHTML =
      '<div class="scout-chip">' +
        '<b>Разведка</b>' +
        '<span>' + (here ? here + ' здесь' : '') +
          (here && soon ? ' · ' : '') + (soon ? soon + ' на подходе' : '') + '</span>' +
      '</div>' +
      '<div class="scout-list">' + lines.join('') + '</div>';
    bar.style.display = 'block';

    if (!bar.dataset.bound) {
      bar.dataset.bound = '1';
      bar.addEventListener('click', function() { bar.classList.toggle('open'); });
    }
  });
}

function renderCaptureBar() {
  var bar = document.getElementById('capture-bar');
  if (!bar) return;
  if (!captureState) { bar.style.display = 'none'; return; }

  var mine = captureState.faction === myFaction;
  var progress = captureProgressNow();
  var pct = Math.max(0, Math.min(100, progress / captureGoal * 100));
  var label;

  if (captureState.status === 'distribution') {
    label = mine ? 'Планета взята — ждёт распределения' : 'Планета потеряна';
  } else if (captureState.status === 'capturing') {
    label = mine ? 'Захват идёт' : 'Планету захватывают';
  } else if (captureState.status === 'reverting') {
    label = mine ? 'Нас выбивают, прогресс падает' : 'Отбиваем поселение';
  } else if (captureState.status === 'contested') {
    label = 'Схватка в поселении, силы равны';
  } else {
    label = 'Захват замер, в зоне никого';
  }

  // Сколько осталось до развязки — при суточном захвате процент один
  // ничего не говорит
  var eta = '';
  if (captureState.rate > 0) {
    eta = ' · до захвата ' + formatCaptureLeft(captureGoal - progress);
  } else if (captureState.rate < 0) {
    eta = ' · до сброса ' + formatCaptureLeft(progress);
  }

  bar.className = mine ? 'mine' : 'theirs';
  bar.innerHTML = '<div class="capture-label">' + label + ' · ' +
      Math.round(pct) + '%' + eta + '</div>' +
    '<div class="capture-track"><i style="width:' + pct + '%"></i></div>';
  bar.style.display = 'block';
}

// ===== Панель поселения =====
// Довольство, доход и суточные задачи. Данные отдаёт сервер только своей
// фракции: по задачам видно, где слабая охрана и где нет флота, — это
// разведданные, а не украшение.

var SETTLEMENT_TASKS = {
  guard:     { title: 'Охрана поселения', hint: 'пехоты в зоне' },
  patrol:    { title: 'Патруль', hint: 'техники в зоне' },
  orbit:     { title: 'Прикрытие с орбиты', hint: 'корабль в площадке сброса' },
  // Дневной налёт: строку рисует stlMarauderState по этапу из payload;
  // sub — запасной текст для старых задач без времени налёта
  marauder:  { title: 'Налёт мародёров', hint: '', sub: function(n) {
    return n > 1 ? 'Уничтожить налётчиков: ' + n : 'Уничтожить налётчика';
  } },
  donation:  { title: 'Пожертвование', hint: 'кредитов' },
  festival:  { title: 'Праздник', hint: 'кредитов' },
  factories: { title: 'Слишком много заводов', hint: 'оставить не больше' },
  // Здание у сторон своё: у Республики «Центр медицины», у КНС «Ремонтный
  // цех». Раньше задача звала его «лечебницей», и игроки искали в стройке
  // то, чего там нет. Имя берём из справочника построек, как в панели стройки.
  medical:   { title: function() { return 'Нужен ' + stlMedicalName(); },
               hint: '', sub: function() { return 'Здание из панели стройки · квартал «Госпиталь» не в счёт'; } }
};

function stlMedicalName() {
  var code = myFaction === 'cis' ? 'cis_repair' : 'rep_medical';
  var bt = (buildingTypes || []).filter(function(b) { return b.code === code; })[0];
  return bt ? '«' + bt.name + '»' : (myFaction === 'cis' ? '«Ремонтный цех»' : '«Центр медицины»');
}

var settlementTimer = null;

// ===== Развитие поселения =====
// Уровень, кварталы, провизия и ополчение. Сводку считает сервер
// (get_settlement_dev), клиент только показывает её и ведёт обратные
// отсчёты локально — раз в секунду база не нужна.
var settlementDev = null;        // последняя сводка: и для панели, и для плашки на карте
var settlementDevAt = 0;         // когда пришла последняя сводка (для карты; панель хранит своё время в stlLast.at)
var settlementDevTimer = null;   // опрос для карты раз в минуту
var settlementDevKicked = false; // первый запрос уже ушёл
var stlTab = 'dev';              // открытая вкладка переживает автообновление и повторное открытие
var stlPicker = null;            // номер участка, для которого открыт выбор квартала
var stlLevels = null;            // settlement_levels — справочник, читаем один раз
var stlDistrictTypes = null;     // district_types — тоже справочник
var stlLast = null;              // последние данные панели: вкладки перерисовываются без запроса
var stlTickTimer = null;
var stlLoadSeq = 0;              // номер запроса панели: опоздавший ответ не затирает свежий
var stlDevSeq = 0;               // то же для сводки: панель и опрос карты спрашивают её независимо
var stlDevApplied = 0;
var stlBusy = false;             // действие в пути — второй тап не проходит
var stlExpiredEnds = {};         // отсчёты, по окончании которых уже просили свежие данные
var stlMapDrawnAt = 0;           // когда карта последний раз перерисовывалась ради отсчёта
var stlImgFailed = {};           // картинки кварталов, которых нет: больше не просим
var stlImgOk = {};               // уже загружались: при перерисовке символ под ними не мигает
var STL_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

function openSettlementPanel() {
  var panel = document.getElementById('settlement-panel');
  if (!panel) return;

  panel.style.display = 'flex';
  stlPicker = null;
  document.getElementById('settlement-body').innerHTML =
    '<div class="stl-empty">Загрузка…</div>';

  loadSettlementPanel();

  if (settlementTimer) clearInterval(settlementTimer);
  settlementTimer = setInterval(loadSettlementPanel, 15000);

  // Обратные отсчёты (расширение, стройка кварталов, сбор ополчения)
  // тикают локально, между запросами
  if (stlTickTimer) clearInterval(stlTickTimer);
  stlTickTimer = setInterval(stlTick, 1000);
}

function closeSettlementPanel() {
  var panel = document.getElementById('settlement-panel');
  if (panel) panel.style.display = 'none';
  if (settlementTimer) { clearInterval(settlementTimer); settlementTimer = null; }
  if (stlTickTimer) { clearInterval(stlTickTimer); stlTickTimer = null; }
  stlPicker = null;
}

function formatSettlementLeft(sec) {
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' ч ' + m + ' мин';
  if (m > 0) return m + ' мин';
  return sec + ' с';
}

// Длительность без «0 мин»: 4 ч, 1 ч 30 мин, 45 мин
function stlDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  if (m > 0) return m + ' мин';
  return sec + ' с';
}

// Тикающий отсчёт: 1:12:05 / 12:05 — цифры не прыгают по ширине
function formatSettlementClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var mm = (m < 10 ? '0' : '') + m;
  var ss = (s < 10 ? '0' : '') + s;
  return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss;
}

// Любой запрос превращаем в {data, error}: упавшая сеть или отсутствующая
// функция на сервере не должны ронять всю панель
function stlSafe(p) {
  return Promise.resolve(p).then(function(r) {
    return r || { data: null, error: null };
  }, function(e) {
    return { data: null, error: { message: (e && e.message) || 'нет связи с сервером' } };
  });
}

// jsonb приходит объектом, но на всякий случай разворачиваем и массив
function stlNormDev(data) {
  if (Array.isArray(data)) data = data.length ? data[0] : null;
  return (data && typeof data === 'object' && data.level) ? data : null;
}

// Функции на сервере нет — дёргать её раз в минуту бессмысленно
function stlRpcMissing(err) {
  if (!err) return false;
  return err.code === 'PGRST202' || err.code === '42883' ||
    /could not find the function|does not exist/i.test(err.message || '');
}

// Сводку для плашки на карте держим свежей раз в минуту. Первый запрос
// делает сама отрисовка поселения, так что отдельный вызов при загрузке
// не обязателен, но и не мешает — повторный старт опроса не создаёт.
function loadSettlementDev() {
  settlementDevKicked = true;
  if (!systemId) return Promise.resolve(null);
  if (!settlementDevTimer) settlementDevTimer = setInterval(loadSettlementDev, 60000);

  var devSeq = ++stlDevSeq;
  return stlSafe(supabase.rpc('get_settlement_dev', { p_system_id: systemId })).then(function(res) {
    if (res.error) {
      if (stlRpcMissing(res.error) && settlementDevTimer) {
        clearInterval(settlementDevTimer);
        settlementDevTimer = null;
      }
      return null;
    }
    applySettlementDev(stlNormDev(res.data), devSeq);
    return settlementDev;
  });
}

// Запоминаем сводку и перерисовываем карту, только если плашке есть что
// менять: полная перерисовка поля недешёвая
function applySettlementDev(dev, seq) {
  if (seq) {
    if (seq < stlDevApplied) return;
    stlDevApplied = seq;
  }
  var sig = function(d) {
    return d ? [d.level, d.level_name, d.upgrade_until, d.upgrade_to].join('|') : '';
  };
  var changed = sig(dev) !== sig(settlementDev);
  // Поселение выросло — открылись новые участки под здания
  var grew = settlementDev && dev && dev.level !== settlementDev.level;
  var now = Date.now();
  settlementDev = dev;
  if (grew && typeof loadBuildings === 'function') loadBuildings();
  settlementDevAt = now;
  // Во время расширения отсчёт на карте идёт по минутам — чаще
  // перерисовывать поле незачем, даже если панель обновляется каждые 15 с
  if (changed || (dev && dev.upgrade_until && now - stlMapDrawnAt > 55000)) {
    stlMapDrawnAt = now;
    scheduleRedraw();
  }
}

// Серверное время в часы клиента: сдвиг сверяется при загрузке
function stlLocalMs(iso) {
  var off = (typeof gbTimeOffset === 'number') ? gbTimeOffset : 0;
  return new Date(iso).getTime() - off;
}

function stlLevelRow(n) {
  if (!stlLevels) return null;
  for (var i = 0; i < stlLevels.length; i++) {
    if (stlLevels[i].level === n) return stlLevels[i];
  }
  return null;
}

// На каком уровне открывается участок: первый, где district_slots до него
// дотягивается. Без справочника — уровень равен номеру участка, как в базе.
function stlSlotLevel(slot) {
  if (stlLevels && stlLevels.length) {
    var rows = stlLevels.slice().sort(function(a, b) { return a.level - b.level; });
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].district_slots || 0) >= slot) return rows[i];
    }
  }
  return { level: slot, name: '' };
}

function stlDistrictType(id) {
  if (!stlDistrictTypes) return null;
  for (var i = 0; i < stlDistrictTypes.length; i++) {
    if (stlDistrictTypes[i].id === id) return stlDistrictTypes[i];
  }
  return null;
}

function stlSigned(v) {
  v = Number(v) || 0;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
}

function stlMult(v) {
  var n = Math.round((Number(v) || 1) * 100) / 100;
  return '×' + String(n).replace('.', ',');
}

function stlPips(level, max, upTo) {
  var html = '<span class="stl-pips">';
  for (var i = 1; i <= max; i++) {
    html += '<i class="' + (i <= level ? 'on' : (upTo && i === upTo ? 'up' : '')) + '"></i>';
  }
  return html + '</span>';
}

// Картинка квартала поверх символа: пока файла нет или он грузится,
// виден символ в плитке, а не значок битой картинки
function stlArtHtml(id, icon, image, cls, overlay) {
  var path = image || ('assets/districts/' + id + '.png');
  var img = stlImgFailed[path] ? '' :
    '<img src="../' + escHtml(path) + '" alt="" data-stl-img="' + escHtml(path) + '"' +
    ' onload="stlImgLoad(this)" onerror="stlImgError(this)">';
  if (img && stlImgOk[path]) cls += ' has-img';
  return '<div class="' + cls + '"><span class="stl-glyph">' + escHtml(icon || '◇') + '</span>' + img +
    (overlay || '') + '</div>';
}

// Та же картинка квартала, что на плитке; не нашлась там — не тянем и в окно
function stlArtSrc(id, image) {
  var path = image || ('assets/districts/' + id + '.png');
  return stlImgFailed[path] ? null : '../' + path;
}

function stlImgLoad(img) {
  stlImgOk[img.getAttribute('data-stl-img')] = true;
  if (img.parentNode) img.parentNode.classList.add('has-img');
}

function stlImgError(img) {
  stlImgFailed[img.getAttribute('data-stl-img')] = true;
  if (img.parentNode) img.parentNode.removeChild(img);
}

// Цена со склада: нехватка красным и сколько есть — как в каталоге построек
function stlResCost(resources, stock) {
  var parts = [];
  var short = false;
  for (var key in (resources || {})) {
    if (!Object.prototype.hasOwnProperty.call(resources, key)) continue;
    var need = Number(resources[key]) || 0;
    if (!need) continue;
    var have = stock ? (Number(stock[key]) || 0) : null;
    var lack = have !== null && have < need;
    if (lack) short = true;
    parts.push('<span class="' + (lack ? 'short' : '') + '">' + escHtml(resourceName(key)) + ' ' + need +
      (lack ? ' <em>(есть ' + have + ')</em>' : '') + '</span>');
  }
  return { html: parts.join(' · '), short: short };
}

function loadSettlementPanel() {
  var seq = ++stlLoadSeq;
  var devSeq = ++stlDevSeq;
  var jobs = [
    stlSafe(supabase.rpc('get_settlement_state', { p_system_id: systemId })),
    stlSafe(supabase.rpc('get_settlement_tasks', { p_system_id: systemId })),
    stlSafe(supabase.rpc('get_settlement_dev', { p_system_id: systemId })),
    stlLevels ? null : stlSafe(supabase.from('settlement_levels').select('*').order('level')),
    stlDistrictTypes ? null : stlSafe(supabase.from('district_types').select('*').order('sort_order')),
    // Названия сырья для требований и цен: справочник грузится один раз
    new Promise(function(done) {
      if (typeof loadResourceNames === 'function') loadResourceNames(done); else done();
    })
  ];

  Promise.all(jobs).then(function(r) {
    // Пока шёл запрос, ушёл более новый (по таймеру, после действия или
    // по окончании отсчёта) — этот ответ уже устарел
    if (seq !== stlLoadSeq) return;
    var panel = document.getElementById('settlement-panel');
    var body = document.getElementById('settlement-body');
    if (!body || !panel || panel.style.display === 'none') return;

    if (r[3] && !r[3].error && r[3].data) stlLevels = r[3].data;
    if (r[4] && !r[4].error && r[4].data) stlDistrictTypes = r[4].data;

    var st = (!r[0].error && r[0].data && r[0].data.length) ? r[0].data[0] : null;

    // Чужая планета — сервер ничего не отдаёт, и это правильно
    if (!st) {
      body.innerHTML = '<div class="stl-empty">Поселение не делится сведениями ' +
        'с чужой фракцией</div>';
      return;
    }

    // Вводный курс: управляющий осмотрел своё поселение
    if (st.is_controller && typeof questSeen === 'function') questSeen('settlement', systemId);

    var tasks = (!r[1].error && r[1].data) ? r[1].data : [];

    var dev = null;
    var devErr = r[2].error || null;
    if (!devErr) {
      dev = stlNormDev(r[2].data);
      applySettlementDev(dev, devSeq);
    }

    // Время получения храним вместе с данными: от него считаются концы
    // отсчётов, и опрос карты его не сдвигает
    stlLast = { st: st, tasks: tasks, dev: dev, devErr: devErr, at: Date.now() };
    renderSettlementPanel();
  });
}

// Каркас с вкладками строится один раз, дальше меняется только
// содержимое вкладок: прокрутка и выбранная вкладка не сбрасываются
function stlEnsureFrame(body) {
  if (body.querySelector('.stl-tabs')) return;

  body.innerHTML =
    '<div class="stl-tabs">' +
      '<button class="stl-tab" data-act="tab" data-tab="dev">Развитие<i></i></button>' +
      '<button class="stl-tab" data-act="tab" data-tab="districts">Кварталы<i></i></button>' +
      '<button class="stl-tab" data-act="tab" data-tab="tasks">Условия<i></i></button>' +
    '</div>' +
    '<div class="stl-pane" data-pane="dev"></div>' +
    '<div class="stl-pane" data-pane="districts"></div>' +
    '<div class="stl-pane" data-pane="tasks"></div>';

  // Один обработчик на всю панель: содержимое перерисовывается,
  // а привязки не теряются
  if (!body.getAttribute('data-stl-bound')) {
    body.setAttribute('data-stl-bound', '1');
    body.addEventListener('click', stlOnClick);
  }
}

function renderSettlementPanel() {
  var body = document.getElementById('settlement-body');
  if (!body || !stlLast) return;

  var box = document.getElementById('settlement-box');
  var scroll = box ? box.scrollTop : 0;

  stlEnsureFrame(body);

  var d = stlLast.dev;
  var st = stlLast.st;
  var tasks = stlLast.tasks;
  var doneCount = tasks.filter(function(t) { return t.done_now; }).length;

  // Счётчики на вкладках: что требует внимания, видно не открывая
  var tabs = body.querySelectorAll('.stl-tab');
  for (var i = 0; i < tabs.length; i++) {
    var key = tabs[i].getAttribute('data-tab');
    var mark = tabs[i].querySelector('i');
    var txt = '';
    var cls = '';
    if (key === 'dev' && d) {
      txt = STL_ROMAN[d.level] || d.level;
      if (d.can_upgrade) cls = 'go';
      else if (d.upgrade_until) cls = 'busy';
    } else if (key === 'districts' && d) {
      var built = (d.districts || []).length;
      txt = built + '/' + (d.slots || 0);
      if (d.is_controller && built < (d.slots || 0)) cls = 'go';
    } else if (key === 'tasks' && tasks.length) {
      txt = doneCount + '/' + tasks.length;
      cls = doneCount === tasks.length ? 'ok' : stlOnlyRaidLeft(tasks) ? 'go' : 'bad';
    }
    mark.textContent = txt;
    mark.className = cls;
    tabs[i].classList.toggle('active', key === stlTab);
  }

  var panes = body.querySelectorAll('.stl-pane');
  for (var j = 0; j < panes.length; j++) {
    panes[j].style.display = panes[j].getAttribute('data-pane') === stlTab ? 'block' : 'none';
  }

  body.querySelector('[data-pane="dev"]').innerHTML = stlDevHtml(stlLast);
  body.querySelector('[data-pane="districts"]').innerHTML = stlDistrictsHtml(stlLast);
  renderSettlementTasks(body.querySelector('[data-pane="tasks"]'), st, tasks, !!d);

  if (box) box.scrollTop = scroll;
  stlTick();
}

// Сервер не ответил на сводку развития: говорим прямо, остальное работает
function stlDevErrorHtml(err) {
  var missing = stlRpcMissing(err);
  return '<div class="stl-alert">' +
    '<b>' + (missing ? 'Развитие поселений ещё не включено' : 'Сводка развития недоступна') + '</b>' +
    '<span>' + (missing
      ? 'Сервер пока не знает об уровнях и кварталах. Условия и выплаты работают как прежде.'
      : 'Не удалось получить данные. Панель повторит запрос сама.') + '</span>' +
    (err && err.message ? '<code>' + escHtml(err.message) + '</code>' : '') +
  '</div>';
}

// Прежний верх панели: довольство, доход, выплачено. Показываем, когда
// сводки развития нет, — сведения не должны пропадать
function stlLegacyTopHtml(st) {
  return '<div class="stl-top">' +
      '<div class="stl-mood">' +
        '<div class="stl-mood-value">' + st.satisfaction + '</div>' +
        '<div class="stl-mood-label">довольство</div>' +
      '</div>' +
      '<div class="stl-money">' +
        '<div class="stl-money-row"><span>Доход за сутки</span><b>' + st.income + '</b></div>' +
        '<div class="stl-money-row"><span>Станет при росте</span><em>' + st.next_income + '</em></div>' +
        '<div class="stl-money-row"><span>Всего выплачено</span><em>' + st.total_paid + '</em></div>' +
        (st.structure_bonus > 0
          ? '<div class="stl-money-row"><span>Кантина · довольство</span><b>+' + st.structure_bonus + '</b></div>'
          : '') +
      '</div>' +
    '</div>' +
    '<div class="stl-track"><i style="width:' + st.satisfaction + '%"></i></div>';
}

function stlDevHtml(L) {
  var d = L.dev;
  var st = L.st;
  if (!d) {
    return (L.devErr ? stlDevErrorHtml(L.devErr)
      : '<div class="stl-alert"><b>Сводка развития недоступна</b></div>') + stlLegacyTopHtml(st);
  }

  var max = d.max_level || 4;
  var isMax = !d.next && !d.upgrade_until;
  var upTo = d.upgrade_until ? (d.upgrade_to || d.level + 1) : null;
  var html = '';

  // Уровень: герб с римской цифрой, название, шкала ступеней
  html += '<div class="stl-lvl' + (isMax ? ' max' : '') + '">' +
    '<div class="stl-lvl-emb">' + (STL_ROMAN[d.level] || d.level) + '</div>' +
    '<div class="stl-lvl-info">' +
      '<div class="stl-lvl-name">' + escHtml(d.level_name) + '</div>' +
      '<div class="stl-lvl-sub">уровень ' + d.level + ' из ' + max + ' · ' +
        (d.slots || 0) + ' ' + stlPlural(d.slots || 0, 'участок', 'участка', 'участков') +
        (d.build_slots ? ' · зданий ' + (d.build_used || 0) + '/' + d.build_slots : '') + '</div>' +
    '</div>' +
    stlPips(d.level, max, upTo) +
  '</div>';

  // Довольство: итог крупно, из чего сложилось — рядом
  var factors = d.factors || [];
  var fl = factors.map(function(f, i) {
    var v = Number(f.value) || 0;
    var cls = i === 0 ? 'base' : (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    return '<div class="stl-factor"><span>' + escHtml(f.label) + '</span>' +
      '<b class="' + cls + '">' + (i === 0 ? v : stlSigned(v)) + '</b></div>';
  }).join('');
  var eff = Math.max(0, Math.min(100, Number(d.effective) || 0));
  // Порог нужен, пока расширение впереди: во время стройки он уже пройден
  var need = (d.next && !d.upgrade_until) ? d.next.min_satisfaction : null;
  var moodCls = need !== null && need !== undefined ? (eff >= need ? ' ok' : ' low') : '';

  html += '<div class="stl-top stl-top-dev">' +
    '<div class="stl-mood' + moodCls + '">' +
      '<div class="stl-mood-value">' + eff + '</div>' +
      '<div class="stl-mood-label">довольство</div>' +
    '</div>' +
    '<div class="stl-factors">' + (fl || '<div class="stl-factor"><span>Без надбавок</span></div>') + '</div>' +
  '</div>';

  html += '<div class="stl-track stl-mood-track"><i style="width:' + eff + '%"></i>' +
    (need ? '<s style="left:' + need + '%"></s>' : '') + '</div>';
  if (need) {
    html += '<div class="stl-track-cap"><span>0</span>' +
      '<em style="left:' + need + '%">порог ' + need + '</em><span>100</span></div>';
  }

  // Доход: множитель уровня и рынок — чтобы было понятно, откуда цифра
  var market = (d.districts || []).some(function(x) { return x.id === 'market' && !x.building; });
  html += '<div class="stl-income">' +
    '<div class="stl-income-row"><span>Доход за сутки</span>' +
      '<b>' + d.income + ' кр.</b></div>' +
    '<div class="stl-income-row sub"><span>Уровень ' + stlMult(d.income_mult) +
      (market ? ' · рынок ×1,25' : '') + '</span><em>выплачено всего ' + (st.total_paid || 0) + '</em></div>' +
  '</div>';

  // Следующая ступень, идущее расширение или предел
  if (d.upgrade_until) html += stlUpgradeHtml(d);
  else if (isMax) html += stlMaxHtml(d);
  else if (d.next) html += stlNextHtml(d);

  html += stlFoodHtml(d);
  html += stlMilitiaHtml(d, L.at);

  return html;
}

function stlPlural(n, one, few, many) {
  n = Math.abs(n) % 100;
  var n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function stlNextHtml(d) {
  var nx = d.next;
  var html = '<div class="stl-sec"><span>Расширение</span>' +
    '<em>' + (STL_ROMAN[nx.level] || nx.level) + ' · ' + escHtml(nx.name) + '</em></div>';

  // Очки развития — по делению на очко: видно, сколько осталось
  var needPts = nx.dev_need || d.dev_need || 0;
  var pts = Math.min(d.dev_points || 0, needPts);
  if (needPts > 0) {
    html += '<div class="stl-devbar">';
    for (var i = 0; i < needPts; i++) html += '<i class="' + (i < pts ? 'on' : '') + '"></i>';
    html += '</div>';
  }

  // Требования по строкам: что уже есть, чего нет
  var reqs = [];
  reqs.push({ ok: (d.dev_points || 0) >= needPts, label: 'Очки развития',
    val: (d.dev_points || 0) + ' / ' + needPts });
  reqs.push({ ok: (Number(d.effective) || 0) >= nx.min_satisfaction,
    label: 'Довольство ≥ ' + nx.min_satisfaction, val: 'сейчас ' + (d.effective || 0) });
  if (nx.credits) reqs.push({ ok: null, label: 'Кредиты', val: nx.credits + ' кр.' });

  var res = nx.resources || {};
  for (var key in res) {
    if (!Object.prototype.hasOwnProperty.call(res, key)) continue;
    var needR = Number(res[key]) || 0;
    if (!needR) continue;
    var have = Number((d.stock || {})[key]) || 0;
    reqs.push({ ok: have >= needR, label: resourceName(key), val: have + ' / ' + needR });
  }

  html += '<div class="stl-reqs">' + reqs.map(function(q) {
    var cls = q.ok === null ? 'info' : q.ok ? 'ok' : 'bad';
    var mark = q.ok === null ? '◈' : q.ok ? '✓' : '✗';
    return '<div class="stl-req ' + cls + '"><i>' + mark + '</i><span>' + escHtml(q.label) + '</span>' +
      '<b>' + q.val + '</b></div>';
  }).join('') + '</div>';

  // Что даст новая ступень
  var lvl = stlLevelRow(nx.level);
  var gains = [];
  if (nx.slots) gains.push([nx.slots, stlPlural(nx.slots, 'участок', 'участка', 'участков')]);
  // Новые места под здания — главная выгода роста для производства
  if (nx.build_slots) gains.push(['+' + nx.build_slots, 'под здания']);
  if (nx.income_mult) gains.push([stlMult(nx.income_mult), 'доход']);
  if (lvl && lvl.militia_base) gains.push([lvl.militia_base, 'ополчение']);
  if (nx.food_per_day) gains.push([nx.food_per_day, 'провизии/сут']);
  if (gains.length) {
    html += '<div class="stl-gains-cap">' + escHtml(nx.name) + ' даст</div>' +
      '<div class="stl-gains" style="grid-template-columns:repeat(' + (gains.length > 4 ? 3 : gains.length) + ',minmax(0,1fr))">' +
      gains.map(function(g) {
        return '<div><b>' + g[0] + '</b><span>' + g[1] + '</span></div>';
      }).join('') + '</div>';
  }

  if (!d.is_controller) {
    html += '<div class="stl-note">Расширение начинает управляющий поселением</div>';
  } else {
    if (!d.can_upgrade && d.upgrade_block) {
      html += '<div class="stl-note warn">' + escHtml(d.upgrade_block) + '</div>';
    }
    html += '<button class="stl-go" data-act="upgrade"' + (d.can_upgrade ? '' : ' disabled') + '>' +
      'Расширить до «' + escHtml(nx.name) + '»' +
      (nx.seconds ? '<em>' + stlDur(nx.seconds) + '</em>' : '') + '</button>';
  }

  return html;
}

function stlUpgradeHtml(d) {
  var to = d.upgrade_to || (d.next && d.next.level) || d.level + 1;
  var row = stlLevelRow(to);
  var name = (d.next && d.next.level === to && d.next.name) || (row && row.name) || '';
  var total = (d.next && d.next.level === to && d.next.seconds) ||
    (row && row.build_seconds) || (d.next && d.next.seconds) || 0;
  var end = stlLocalMs(d.upgrade_until);

  return '<div class="stl-sec"><span>Расширение</span><em>' +
      (STL_ROMAN[d.level] || d.level) + ' → ' + (STL_ROMAN[to] || to) + '</em></div>' +
    '<div class="stl-upg">' +
      '<div class="stl-upg-head"><span>Идёт стройка</span><b>' + escHtml(name) + '</b></div>' +
      '<div class="stl-upg-bar"><i data-stl-end="' + end + '" data-stl-total="' + total + '"></i></div>' +
      '<div class="stl-upg-foot"><span>до завершения</span>' +
        '<b data-stl-end="' + end + '">—</b></div>' +
    '</div>';
}

function stlMaxHtml(d) {
  return '<div class="stl-max">' +
    '<div class="stl-max-title">Высший уровень</div>' +
    '<div class="stl-max-text">' + escHtml(d.level_name) +
      ' — предел развития. Держите довольство и кварталы: доход идёт по полной.</div>' +
  '</div>';
}

// Провизия: сколько ест поселение, чем сыто и надолго ли хватит
function stlFoodHtml(d) {
  var f = d.food || {};
  var state, chip;
  // «Не нужна» — только когда поселение не ест вовсе. После расширения
  // fed ещё пуст: первое кормление в конце суток, это не голод
  if (!f.per_day) {
    state = 'idle'; chip = 'не нужна';
  } else if (f.fed === null || f.fed === undefined) {
    state = 'wait'; chip = 'ждёт';
  } else if (f.fed) {
    state = 'ok'; chip = 'сыто';
  } else {
    state = 'bad'; chip = 'голод';
  }

  var html = '<div class="stl-card ' + state + '">' +
    '<div class="stl-card-head"><span>Провизия</span><em>' + chip + '</em></div>';

  if (state === 'idle') {
    html += '<div class="stl-card-text">' + escHtml(d.level_name) +
      ' кормится сам. Провизия понадобится после расширения.' +
      (f.have ? ' На складе: ' + f.have + '.' : '') + '</div>';
  } else {
    var days = f.days_left === null || f.days_left === undefined ? '—' : f.days_left;
    html += '<div class="stl-stats">' +
      '<div><b>' + f.per_day + '</b><span>в сутки</span></div>' +
      '<div><b>' + (f.have || 0) + '</b><span>на складе</span></div>' +
      '<div class="' + (state === 'bad' || days === 0 ? 'bad' : days <= 1 ? 'warn' : '') + '"><b>' + days + '</b>' +
        '<span>' + (typeof days === 'number' ? stlPlural(days, 'сутки', 'суток', 'суток') : 'суток') + ' хватит</span></div>' +
    '</div>';
    if (state === 'wait') {
      html += '<div class="stl-card-text">Первое кормление — в конце суток.</div>';
    } else if (state === 'bad') {
      html += '<div class="stl-card-text bad">Жители голодают: −15 к довольству, пока на складе ' +
        'меньше суточной нормы. Подвезите провизию или постройте угодья.</div>';
    }
  }
  return html + '</div>';
}

// Ополчение: сколько встанет на защиту и когда соберётся
function stlMilitiaHtml(d, at) {
  var m = d.militia || {};
  var none = !(m.count > 0);
  var ready = !none && (!!m.ready || !(m.ready_in > 0));
  var end = (at || Date.now()) + (m.ready_in || 0) * 1000;
  var state = none ? 'warn' : ready ? 'ok' : 'wait';

  var third;
  if (none) third = '<div class="warn"><b>—</b><span>сбора нет</span></div>';
  else if (ready) third = '<div class="ok"><b>✓</b><span>сбор готов</span></div>';
  else third = '<div class="wait"><b data-stl-end="' + end + '">' + formatSettlementClock(m.ready_in) + '</b>' +
    '<span>до сбора</span></div>';

  return '<div class="stl-card militia ' + state + '">' +
    '<div class="stl-card-head"><span>Ополчение</span>' +
      '<em>' + (none ? 'не соберётся' : ready ? 'готово' : 'сбор') + '</em></div>' +
    '<div class="stl-stats">' +
      '<div><b>' + (m.count || 0) + '</b><span>поднимется</span></div>' +
      '<div><b>' + (m.alive || 0) + '</b><span>в строю</span></div>' +
      third +
    '</div>' +
    (none ? '<div class="stl-card-text warn">Не соберётся — довольство ниже 25.</div>' : '') +
  '</div>';
}

function stlDistrictsHtml(L) {
  var d = L.dev;
  if (!d) {
    return L.devErr ? stlDevErrorHtml(L.devErr)
      : '<div class="stl-empty">Сведений о кварталах нет</div>';
  }

  var bySlot = {};
  (d.districts || []).forEach(function(x) { bySlot[x.slot] = x; });

  // Выбор квартала открыт, но участок уже занят или прав нет — закрываем
  if (stlPicker && (bySlot[stlPicker] || !d.is_controller || stlPicker > (d.slots || 0))) stlPicker = null;
  if (stlPicker) return stlPickerHtml(d, bySlot);

  var slots = d.slots || 0;
  var built = (d.districts || []).length;
  var total = Math.max(4, slots);
  var html = '<div class="stl-sec"><span>Участки</span><em>занято ' + built + ' из ' + slots + '</em></div>';

  if (!d.is_controller) {
    html += '<div class="stl-note">Кварталы строит и сносит управляющий' +
      (L.st && L.st.controller ? ' — ' + escHtml(L.st.controller) : '') + '</div>';
  }

  html += '<div class="stl-slots">';
  for (var s = 1; s <= total; s++) {
    var x = bySlot[s];
    var no = '<span class="stl-slot-no">' + (s < 10 ? '0' : '') + s + '</span>';

    if (x) {
      var t = stlDistrictType(x.id) || {};
      var building = x.building && x.seconds_left > 0;
      var end = (L.at || Date.now()) + (x.seconds_left || 0) * 1000;
      html += '<div class="stl-slot ' + (building ? 'building' : 'built') + '">' + no +
        '<span class="stl-slot-tag">' + (building ? 'стройка' : 'действует') + '</span>' +
        stlArtHtml(x.id, x.icon || t.icon, t.image, 'stl-slot-art', building
          ? '<div class="stl-slot-prog"><em data-stl-end="' + end + '">' +
              formatSettlementClock(x.seconds_left) + '</em>' +
              '<div><i data-stl-end="' + end + '" data-stl-total="' + (t.build_seconds || 0) + '"></i></div></div>'
          : '') +
        '<div class="stl-slot-name">' + escHtml(x.name || t.name || x.id) + '</div>' +
        '<div class="stl-slot-eff">' + escHtml(x.effect || t.effect || '') + '</div>' +
        (d.is_controller
          ? '<button class="stl-slot-act demolish" data-act="demolish" data-slot="' + s + '">Снести</button>'
          : '') +
      '</div>';
    } else if (s <= slots) {
      html += '<div class="stl-slot empty' + (d.is_controller ? '' : ' ro') + '"' +
          (d.is_controller ? ' data-act="pick" data-slot="' + s + '"' : '') + '>' + no +
        '<div class="stl-slot-art"><span class="stl-glyph">+</span></div>' +
        '<div class="stl-slot-name">Свободный участок</div>' +
        '<div class="stl-slot-eff">' + (d.is_controller ? 'Можно заложить квартал' : 'Квартал не заложен') + '</div>' +
        (d.is_controller
          ? '<button class="stl-slot-act pick" data-act="pick" data-slot="' + s + '">Выбрать квартал</button>'
          : '') +
      '</div>';
    } else {
      var lv = stlSlotLevel(s);
      html += '<div class="stl-slot locked">' + no +
        '<div class="stl-slot-art"><span class="stl-glyph">' + (STL_ROMAN[lv.level] || lv.level) + '</span></div>' +
        '<div class="stl-slot-name">Закрыт</div>' +
        '<div class="stl-slot-eff">откроется на уровне ' + lv.level +
          (lv.name ? ' · ' + escHtml(lv.name) : '') + '</div>' +
      '</div>';
    }
  }
  html += '</div>';

  html += '<div class="stl-hint">Квартал строится за кредиты и сырьё со склада планеты. ' +
    'Снос возвращает половину кредитов и сырья.</div>';
  return html;
}

function stlPickerHtml(d, bySlot) {
  var taken = {};
  (d.districts || []).forEach(function(x) { taken[x.id] = true; });

  var html = '<div class="stl-pick-head">' +
    '<button class="stl-back" data-act="back">← Участки</button>' +
    '<span>Квартал на участок ' + (stlPicker < 10 ? '0' : '') + stlPicker + '</span>' +
  '</div>';

  if (!stlDistrictTypes) {
    return html + '<div class="stl-alert"><b>Справочник кварталов не загрузился</b>' +
      '<span>Панель повторит запрос при следующем обновлении.</span></div>';
  }

  var list = stlDistrictTypes.filter(function(t) { return !taken[t.id]; });
  if (!list.length) return html + '<div class="stl-empty">Все кварталы уже построены</div>';

  html += '<div class="stl-pick-list">';
  list.forEach(function(t) {
    var cost = stlResCost(t.cost_resources, d.stock);
    // Сырья не хватает — сервер всё равно откажет, честнее сказать сразу
    html += '<button class="stl-dist' + (cost.short ? ' short' : '') + '" data-act="build" data-id="' + escHtml(t.id) + '"' +
        (cost.short ? ' disabled' : '') + '>' +
      stlArtHtml(t.id, t.icon, t.image, 'stl-dist-art') +
      '<div class="stl-dist-info">' +
        '<div class="stl-dist-name"><span>' + escHtml(t.name) + '</span>' +
          (t.build_seconds ? '<em>' + stlDur(t.build_seconds) + '</em>' : '') + '</div>' +
        '<div class="stl-dist-eff">' + escHtml(t.effect || '') + '</div>' +
        (t.description ? '<div class="stl-dist-desc">' + escHtml(t.description) + '</div>' : '') +
        '<div class="stl-dist-cost"><b>' + (t.cost_credits || 0) + ' кр.</b>' +
          (cost.html ? ' · ' + cost.html : '') + '</div>' +
        (cost.short ? '<div class="stl-dist-why">На складе не хватает сырья</div>' : '') +
      '</div>' +
    '</button>';
  });
  html += '</div>';
  return html;
}

// Задача «Налёт мародёров»: утром разведка называет время, днём банда
// приходит на marauder_raid_hours и уходит с добычей, если её не перебить.
// Сервер кладёт этап в payload (stage, raid_at, raid_ends, alive/total).
// Старые задачи без времени налёта — null, строка рисуется как раньше.
function stlMarauderState(t) {
  var p = t.payload || {};
  var stage = p.stage;
  if (!stage) return null;

  var now = svNow();
  var at = p.raid_at ? new Date(p.raid_at).getTime() : 0;
  var end = p.raid_ends ? new Date(p.raid_ends).getTime() : 0;
  var clock = function(ms) {
    return svDayWord(ms) + 'в ' + svFormatTime(ms) + ' ' + svClock.label;
  };
  var line = function(cls, main, note) {
    return '<div class="stl-task-sub stl-raid ' + cls + '"><b>' + main + '</b>' +
      (note ? '<span>' + note + '</span>' : '') + '</div>';
  };

  if ((stage === 'scouted' || stage === 'warned') && at) {
    if (now < at) {
      return { cls: 'wait', mark: '◷',
        html: line('wait', 'Налёт ожидается ' + clock(at) + ' · через ' + svLeftText((at - now) / 1000),
                   'Пробудет до ' + svFormatTime(end) + ' — перебить всю банду') };
    }
    return { cls: 'raid', mark: '!', html: line('raid', 'Банда вот-вот появится у поселения', '') };
  }

  if (stage === 'raid') {
    var total = p.total || t.target || 0;
    var alive = typeof p.alive === 'number' ? p.alive : total;
    // Всех перебили, а сервер ещё не перевёл этап (тик раз в 15 с) — уже отбит
    if (alive === 0 && total > 0) {
      return { cls: 'ok', html: line('ok', 'Налёт отбит', 'Банда разбита — условие выполнено') };
    }
    var span = Math.max(1, Math.round((end - at) / 1000));
    return { cls: 'raid', mark: '!',
      html: line('raid', 'Налёт идёт · банда уйдёт ' + clock(end) +
                 ' · осталось ' + alive + ' из ' + total, '') +
        '<div class="stl-raid-bar"><i data-stl-end="' + stlLocalMs(p.raid_ends) +
          '" data-stl-total="' + span + '" style="width:' +
          Math.max(0, Math.min(100, (now - at) / (end - at) * 100)).toFixed(2) + '%"></i></div>' };
  }

  if (stage === 'defeated') return { cls: 'ok', html: line('ok', 'Налёт отбит', 'Банда разбита — условие выполнено') };
  if (stage === 'escaped') {
    return { cls: 'fail', mark: '✕',
      html: line('fail', 'Банда ушла с добычей', 'Ушло: ' + (p.left || 0) + ' · условие провалено') };
  }
  if (stage === 'cancelled') return { cls: 'ok', html: line('ok', 'Налёт отменён', 'Условие засчитано') };
  if (stage === 'calm') return { cls: 'ok', html: line('ok', 'Налёта не было', 'Условие засчитано') };
  return null;
}

// Не выполнен только налёт, который ещё впереди или идёт: это не провал, а дело на день
function stlOnlyRaidLeft(tasks) {
  var open = tasks.filter(function(t) { return !t.done_now; });
  return open.length > 0 && open.every(function(t) {
    var ms = t.kind === 'marauder' ? stlMarauderState(t) : null;
    return !!ms && (ms.cls === 'wait' || ms.cls === 'raid');
  });
}

// Вкладка «Условия» — прежний список суточных задач с кнопками оплаты
function renderSettlementTasks(pane, st, tasks, hasDev) {
  var doneCount = tasks.filter(function(t) { return t.done_now; }).length;
  var allDone = tasks.length > 0 && doneCount === tasks.length;

  var html = '';

  // Со сводкой развития итоговое довольство и доход живут на первой
  // вкладке; здесь — та часть, что растёт от выполненных условий
  if (hasDev) {
    html += '<div class="stl-base"><span>Довольство от условий</span><b>' + st.satisfaction + '</b></div>' +
      '<div class="stl-track"><i style="width:' + st.satisfaction + '%"></i></div>';
  } else {
    html += stlLegacyTopHtml(st);
  }

  html += '<div class="stl-meta">' +
    'Управляет: ' + escHtml(st.controller || 'не назначен') +
    ' · до итогов ' + formatSettlementLeft(st.seconds_left) +
    '</div>';

  // Итог дня заранее: понятно, растёт довольство или упадёт.
  // Налёт, который ещё впереди, — не провал, а дело на вечер
  var onlyRaid = !allDone && stlOnlyRaidLeft(tasks);
  html += '<div class="stl-verdict ' + (allDone ? 'good' : onlyRaid ? 'wait' : 'bad') + '">' +
    (tasks.length === 0 ? 'Задач на эти сутки нет'
      : allDone ? 'Все требования выполнены — довольство вырастет'
      : onlyRaid ? 'Выполнено ' + doneCount + ' из ' + tasks.length +
                   ' — осталось отбить налёт мародёров'
                : 'Выполнено ' + doneCount + ' из ' + tasks.length +
                  ' — при таком раскладе довольство упадёт') +
    '</div>';

  pane.innerHTML = html;

  tasks.forEach(function(t) {
    var meta = SETTLEMENT_TASKS[t.kind] || { title: t.kind, hint: '' };

    var row = document.createElement('div');
    // Налёт мародёров: этап (ждём / идёт / отбит / ушли) решает вид строки
    var ms = t.kind === 'marauder' ? stlMarauderState(t) : null;
    row.className = 'stl-task' + (t.done_now ? ' done' : '') + (ms ? ' mar-' + ms.cls : '');

    var payable = (t.kind === 'donation' || t.kind === 'festival');

    row.innerHTML =
      '<div class="stl-task-head">' +
        '<span class="stl-task-title">' +
          (typeof meta.title === 'function' ? meta.title() : meta.title) + '</span>' +
        '<span class="stl-task-mark">' + (ms && ms.mark ? ms.mark : t.done_now ? '✓' : '·') + '</span>' +
      '</div>' +
      (ms ? ms.html
          : '<div class="stl-task-sub">' + (meta.sub ? meta.sub(t.target) : t.target + ' ' + meta.hint) + '</div>');

    // Платные задачи закрываются кнопкой, остальные — делом
    if (payable && !t.done_now && st.is_controller) {
      var btn = document.createElement('button');
      btn.className = 'stl-pay';
      btn.textContent = 'Заплатить ' + t.target;
      btn.addEventListener('click', function() {
        btn.disabled = true;
        supabase.rpc('settlement_pay_task', { p_task_id: t.id }).then(function(res) {
          if (res.error) { alert(res.error.message); btn.disabled = false; return; }
          loadSettlementPanel();
        });
      });
      row.appendChild(btn);
    }

    pane.appendChild(row);
  });
}

function stlOnClick(e) {
  var el = e.target;
  while (el && el !== e.currentTarget && !el.getAttribute('data-act')) el = el.parentNode;
  if (!el || el === e.currentTarget) return;

  var act = el.getAttribute('data-act');
  var d = stlLast && stlLast.dev;
  var box = document.getElementById('settlement-box');

  if (act === 'tab') {
    var tab = el.getAttribute('data-tab');
    if (tab === stlTab) return;
    stlTab = tab;
    stlPicker = null;
    renderSettlementPanel();
    if (box) box.scrollTop = 0;
    return;
  }

  if (!d || !d.is_controller) return;

  if (act === 'pick') {
    stlPicker = parseInt(el.getAttribute('data-slot'), 10) || null;
    renderSettlementPanel();
    if (box) box.scrollTop = 0;
    return;
  }

  if (act === 'back') {
    stlPicker = null;
    renderSettlementPanel();
    if (box) box.scrollTop = 0;
    return;
  }

  if (act === 'upgrade') {
    if (!d.can_upgrade || !d.next) return;
    var nx = d.next;
    stlAsk({
      tone: 'build',
      kicker: 'Подтверди расширение',
      title: 'Поселение → «' + nx.name + '»',
      sub: 'Уровень ' + (STL_ROMAN[nx.level] || nx.level) +
           (nx.seconds ? ' · стройка ' + stlDur(nx.seconds) : ''),
      rows: [{ label: 'Спишется', items: stlCostItems(nx.credits, nx.resources, d.stock) }],
      note: 'Пока идёт расширение, кварталы работают как обычно.',
      ok: 'Расширить'
    }, function() {
      stlAction(el, 'start_settlement_upgrade', { p_system_id: systemId });
    }, 'Расширить поселение до «' + nx.name + '»?\n\nСтройка займёт ' + stlDur(nx.seconds || 0) + '.');
    return;
  }

  if (act === 'build') {
    var t = stlDistrictType(el.getAttribute('data-id'));
    if (!t || !stlPicker) return;
    var pickSlot = stlPicker;
    stlAsk({
      tone: 'build',
      kicker: 'Подтверди стройку',
      title: t.name,
      image: stlArtSrc(t.id, t.image),
      sub: 'Участок ' + (pickSlot < 10 ? '0' : '') + pickSlot +
           (t.build_seconds ? ' · стройка ' + stlDur(t.build_seconds) : ''),
      rows: [{ label: 'Спишется', items: stlCostItems(t.cost_credits, t.cost_resources, d.stock) }],
      note: 'Если потом снести — вернётся половина кредитов и сырья.',
      ok: 'Заложить'
    }, function() {
      stlAction(el, 'build_district', { p_system_id: systemId, p_slot: pickSlot, p_district: t.id });
    }, 'Заложить «' + t.name + '» на участке ' + pickSlot + '?');
    return;
  }

  if (act === 'demolish') {
    var slot = parseInt(el.getAttribute('data-slot'), 10);
    var x = (d.districts || []).filter(function(q) { return q.slot === slot; })[0];
    if (!x) return;
    var xt = stlDistrictType(x.id) || {};
    var doDemolish = function() {
      stlAction(el, 'demolish_district', { p_system_id: systemId, p_slot: slot });
    };
    if (!gcReady()) {
      if (confirm('Снести «' + (x.name || xt.name) + '» на участке ' + slot + '?')) doDemolish();
      return;
    }
    loadPlanetStock(function() {
      // Панель закрыли, пока грузился склад — окно не всплывает само по себе
      var sp = document.getElementById('settlement-panel');
      if (!sp || sp.style.display === 'none') return;
      // Снесённые склады перестают расширять предел ещё до возврата сырья
      var drop = (x.id === 'warehouses' && !(x.building && x.seconds_left > 0))
        ? Number(xt.effect_value) || 0 : 0;
      var r = gcRefund(Math.floor((xt.cost_credits || 0) / 2), xt.cost_resources, 1, 2, drop);
      gameConfirm({
        tone: 'danger',
        kicker: 'Подтверди снос',
        title: x.name || xt.name || 'Квартал',
        image: stlArtSrc(x.id, xt.image),
        sub: 'Участок ' + (slot < 10 ? '0' : '') + slot,
        rows: [{ label: 'Вернётся', dir: 'in', items: r.items }],
        warn: gcJoin(gcCapWarn(drop), gcLostWarn(r)),
        note: 'Квартал исчезнет сразу вместе со своим эффектом — отменить снос нельзя.',
        ok: 'Снести'
      }, doDemolish);
    });
  }
}

// Цена квартала или расширения: склад поселения приходит вместе с панелью
function stlCostItems(credits, res, stock) {
  var items = [];
  if (credits) items.push({ kind: 'credits', text: credits + ' кр.' });
  for (var k in (res || {})) {
    if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
    var need = Number(res[k]) || 0;
    if (!need) continue;
    items.push({
      text: resourceName(k) + ' ' + need,
      color: gcResColor(k),
      bad: !!stock && (Number(stock[k]) || 0) < need
    });
  }
  return items;
}

// Окно подтверждения, а без него — прежний системный вопрос
function stlAsk(o, go, plain) {
  if (gcReady()) { gameConfirm(o, go); return; }
  if (confirm(plain)) go();
}

function stlAction(btn, fn, args) {
  if (stlBusy) return;
  stlBusy = true;
  btn.disabled = true;
  btn.classList.add('busy');

  stlSafe(supabase.rpc(fn, args)).then(function(res) {
    stlBusy = false;
    if (res.error) {
      btn.disabled = false;
      btn.classList.remove('busy');
      alert(res.error.message);
      return;
    }
    stlPicker = null;
    loadSettlementPanel();
  });
}

// Раз в секунду: отсчёты и полосы прогресса без запросов к базе.
// Отсчёт дошёл до нуля — один раз просим свежие данные, не дожидаясь
// планового обновления.
function stlTick() {
  var body = document.getElementById('settlement-body');
  if (!body) return;
  var now = Date.now();
  var expired = false;

  var els = body.querySelectorAll('[data-stl-end]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var end = Number(el.getAttribute('data-stl-end')) || 0;
    var left = Math.max(0, (end - now) / 1000);
    if (left <= 0 && end && !stlExpiredEnds[end]) { stlExpiredEnds[end] = true; expired = true; }

    if (el.hasAttribute('data-stl-total')) {
      var total = Number(el.getAttribute('data-stl-total')) || 0;
      var pct = total > 0 ? Math.max(0, Math.min(100, (1 - left / total) * 100)) : 0;
      el.style.width = pct.toFixed(2) + '%';
    } else {
      el.textContent = formatSettlementClock(left);
    }
  }

  if (expired) loadSettlementPanel();
}

function drawSettlement() {
  if (!settlement) return;

  // Сводку развития для плашки запрашиваем при первой отрисовке
  // поселения и дальше раз в минуту
  if (!settlementDevKicked) {
    settlementDevKicked = true;
    setTimeout(loadSettlementDev, 0);
  }

  var px = settlement.x * CELL_PX;
  var py = settlement.y * CELL_PX;
  var sz = settlement.size * CELL_PX;

  var img = getBuildingImage('assets/buildings/settlement.png');
  if (img && img.complete && !img.failed && img.naturalWidth > 0) {
    gbDrawImage(img, px, py, sz, sz);
  } else {
    ctx.fillStyle = '#6b5a3e';
    ctx.fillRect(px, py, sz, sz);
  }

  if (settlementZone) {
    var zx = settlementZone.x * CELL_PX;
    var zy = settlementZone.y * CELL_PX;
    var zs = settlementZone.size * CELL_PX;
    ctx.strokeStyle = captureState ? 'rgba(217,169,64,0.95)' : 'rgba(217,169,64,0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(zx, zy, zs, zs);
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = 'rgba(217,169,64,0.8)';
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, sz, sz);

  drawSettlementUpgrade(px, py, sz);
  drawSettlementBadge(px, py, sz);
}

function stlRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Плашка уровня на верхней кромке поселения: римская цифра, название
// и ступени. Крупный шрифт — чтобы читалось и на отдалении.
function drawSettlementBadge(px, py, sz) {
  var d = settlementDev;
  if (!d || !d.level) return;

  var max = d.max_level || 4;
  var up = !!d.upgrade_until;
  var upTo = up ? (d.upgrade_to || d.level + 1) : null;
  var line = (STL_ROMAN[d.level] || d.level) + ' · ' + String(d.level_name || '').toUpperCase();

  ctx.save();
  // Длинное название («Столица округа») ужимаем, чтобы плашка
  // не вылезала за поселение
  var fs = 17;
  ctx.font = 'bold ' + fs + 'px "Courier New", monospace';
  while (fs > 12 && ctx.measureText(line).width > sz - 40) {
    fs--;
    ctx.font = 'bold ' + fs + 'px "Courier New", monospace';
  }
  var w = Math.max(ctx.measureText(line).width + 30, 120);
  var h = 44;
  var x = Math.round(px + sz / 2 - w / 2);
  var y = Math.round(py - h / 2);

  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  // Тень холст не масштабирует трансформацией — умножаем сами, иначе
  // на отдалении она расползалась бы, а вблизи пропадала
  ctx.shadowBlur = 8 * gbScaleK();
  ctx.fillStyle = 'rgba(10,13,20,0.94)';
  stlRoundRect(x, y, w, h, 6);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = up ? '#4a90d9' : '#d9a940';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#d9a940';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(line, x + w / 2, y + 16);

  // Ступени — ромбы; строящаяся ступень синяя
  var step = 16;
  var cx0 = x + w / 2 - (max - 1) * step / 2;
  var cy = y + 33;
  for (var i = 1; i <= max; i++) {
    var cx = cx0 + (i - 1) * step;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx + 5, cy);
    ctx.lineTo(cx, cy + 5);
    ctx.lineTo(cx - 5, cy);
    ctx.closePath();
    if (i <= d.level) {
      ctx.fillStyle = '#d9a940';
      ctx.fill();
    } else if (upTo && i === upTo) {
      ctx.fillStyle = '#4a90d9';
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(217,169,64,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Расширение на карте: синие «леса» по периметру, полоса и отсчёт —
// как у строящегося здания. Отсчёт по минутам: карта перерисовывается
// раз в минуту вместе с опросом сводки.
function drawSettlementUpgrade(px, py, sz) {
  var d = settlementDev;
  if (!d || !d.upgrade_until) return;

  var now = Date.now();
  var end = stlLocalMs(d.upgrade_until);
  var to0 = d.upgrade_to || d.level + 1;
  var row = stlLevelRow(to0);
  var total = ((d.next && d.next.level === to0 && d.next.seconds) ||
    (row && row.build_seconds) || (d.next && d.next.seconds) || 0) * 1000;
  var progress = total > 0 ? 1 - (end - now) / total : 0;
  progress = Math.max(0, Math.min(1, progress));
  var left = Math.max(0, Math.ceil((end - now) / 1000));

  ctx.save();

  // Вуаль и двойной пунктир — леса вокруг расширяющегося поселения
  ctx.fillStyle = 'rgba(10,22,40,0.28)';
  ctx.fillRect(px, py, sz, sz);
  ctx.strokeStyle = 'rgba(74,144,217,0.95)';
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 7]);
  ctx.strokeRect(px + 6, py + 6, sz - 12, sz - 12);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 5]);
  ctx.strokeRect(px + 13, py + 13, sz - 26, sz - 26);
  ctx.setLineDash([]);

  // Раскосы по углам
  ctx.strokeStyle = 'rgba(74,144,217,0.8)';
  ctx.lineWidth = 2;
  var c = 14;
  [[px + 6, py + 6, 1, 1], [px + sz - 6, py + 6, -1, 1],
   [px + 6, py + sz - 6, 1, -1], [px + sz - 6, py + sz - 6, -1, -1]].forEach(function(k) {
    ctx.beginPath();
    ctx.moveTo(k[0], k[1] + k[3] * c);
    ctx.lineTo(k[0] + k[2] * c, k[1]);
    ctx.moveTo(k[0], k[1]);
    ctx.lineTo(k[0] + k[2] * c, k[1] + k[3] * c);
    ctx.stroke();
  });

  // Полоса и отсчёт внизу, на тёмной подложке, выше угловых раскосов
  var to = to0;
  var label = left > 0
    ? '→ ' + (STL_ROMAN[to] || to) + ' · ' + stlDur(left <= 60 ? 60 : left)
    : 'ЗАВЕРШЕНИЕ…';
  var bw = sz - 48;
  var bx = px + 24;
  var lfs = 15;
  ctx.font = 'bold ' + lfs + 'px "Courier New", monospace';
  while (lfs > 11 && ctx.measureText(label).width > bw - 4) {
    lfs--;
    ctx.font = 'bold ' + lfs + 'px "Courier New", monospace';
  }
  var plateH = 40;
  var plateY = py + sz - plateH - 24;

  ctx.fillStyle = 'rgba(10,13,20,0.9)';
  stlRoundRect(bx - 6, plateY, bw + 12, plateH, 5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,144,217,0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#cfd8dc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px + sz / 2, plateY + 14);

  ctx.fillStyle = 'rgba(5,6,10,0.9)';
  ctx.fillRect(bx, plateY + 27, bw, 6);
  ctx.fillStyle = '#4a90d9';
  ctx.fillRect(bx, plateY + 27, bw * progress, 6);

  ctx.restore();
}

// Сколько экрана занято панелями снизу: карта должна уметь подняться
// над ними, иначе нижние ряды остаются недосягаемыми
var uiBottomInset = 0;

// ===== Время и очки действий =====
// Очки считаем на клиенте: ap и ap_updated_at приходят вместе с юнитом,
// а часы сверяем с сервером один раз при загрузке. Никаких запросов
// раз в секунду — иначе набегали бы тысячи обращений в час.
var gbTimeOffset = 0;
var gbApCd = 30;
var gbApMax = 2;

function gbServerNow() {
  return Date.now() + gbTimeOffset;
}

function syncGroundTime() {
  return supabase.rpc('get_server_time').then(function(res) {
    if (!res.error && res.data) {
      gbTimeOffset = new Date(res.data).getTime() - Date.now();
    }
  });
}

function unitApState(unit) {
  if (!unit || unit.ap === undefined || unit.ap === null) return null;

  var elapsed = Math.floor((gbServerNow() - new Date(unit.ap_updated_at).getTime()) / 1000);
  if (elapsed < 0) elapsed = 0;

  // Тип может задавать своё время восстановления (артиллерия — дольше)
  var t = unitTypeById[unit.unit_type];
  var cd = (t && t.action_seconds) ? t.action_seconds : gbApCd;

  var ap = Math.min(gbApMax, unit.ap + Math.floor(elapsed / cd));
  return {
    ap: ap,
    ap_max: gbApMax,
    next_in: ap >= gbApMax ? 0 : cd - (elapsed % cd)
  };
}

// Обновляем только точки и подпись, панель целиком не перерисовываем:
// иначе каждую секунду сбрасывался бы выбор вкладки и способности
var apTicker = null;

function startApTicker(unit) {
  if (apTicker) clearInterval(apTicker);

  apTicker = setInterval(function() {
    if (!selectedUnit || selectedUnit.id !== unit.id) {
      clearInterval(apTicker);
      apTicker = null;
      return;
    }

    // Строку бойца берём свежую: после хода, урона или шага автохода
    // в unitsOnMap лежит новая копия, а снимок панели устаревает
    var st = unitApState(guLiveUnit(unit));
    if (!st) return;

    guPaintAp(st, null);
    guRefreshTiles(st.ap);
  }, 1000);
}

// Свежая строка бойца с карты, а не снимок на момент открытия панели
function guLiveUnit(unit) {
  if (!unit) return unit;
  for (var i = 0; i < unitsOnMap.length; i++) {
    if (unitsOnMap[i].id === unit.id) return unitsOnMap[i];
  }
  return unit;
}

// Сколько действий у бойца прямо сейчас. Пока строка без очков (старые
// данные), верим ответу сервера, полученному при открытии панели.
function guApNow(unit, fallback) {
  var st = unitApState(guLiveUnit(unit));
  if (st) return st.ap;
  return fallback ? fallback.ap : 0;
}

// Плитки сами снимают и ставят «заглушку»: по очкам действий и по откату.
// Раньше доступность вычислялась один раз при открытии панели — действие
// восстанавливалось, плитка светлела, а кнопка внутри оставалась
// выключенной, пока панель не открыть заново.
function guRefreshTiles(apNow) {
  var now = Date.now();
  var tiles = document.querySelectorAll('.gu-tile');
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    var need = parseInt(t.getAttribute('data-need') || '1', 10);
    var at = parseInt(t.getAttribute('data-ready-at') || '0', 10);
    var ok = apNow >= need && now >= at;
    var was = !t.classList.contains('locked');
    t.classList.toggle('locked', !ok);
    // Открытое описание перерисовываем, когда доступность сменилась,
    // а у отката — каждую секунду, чтобы шёл счёт
    if (t.classList.contains('active') && typeof t._guPick === 'function' &&
        (was !== ok || (at && now < at + 1000))) {
      t._guPick();
    }
  }
}

// Сколько осталось до готовности способности, по сохранённой отметке
function guLeftSec(readyAt) {
  return Math.max(0, Math.ceil((readyAt - Date.now()) / 1000));
}

function setBottomInset(px) {
  var delta = px - uiBottomInset;
  uiBottomInset = px;
  panY -= delta;
  clampPan();
  applyTransform();
  cbPlaceToast();
}

function insetFor(el) {
  if (!el) return 0;
  var r = el.getBoundingClientRect();
  if (!r.height) return 0;
  return Math.max(0, window.innerHeight - r.top + 8);
}

function focusCell(cx, cy) {
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight - uiBottomInset;
  panX = vw / 2 - (cx + 0.5) * CELL_PX * scale;
  panY = vh / 2 - (cy + 0.5) * CELL_PX * scale;
  clampPan();
  applyTransform();
}
var showDeployZones = false;  // зоны видны только своей фракции
var systemFaction = null;
var lastTouchEndMs = 0;
var buildingsBySlot = {};  // slot_index(1..N) -> запись из buildings (с подставленным building_type)
var buildingTypes = [];    // справочник типов построек
var currentUserFaction = null;
var buildingImages = {};   // путь -> Image, чтобы не грузить одну картинку дважды
var terrainCache = null;   // рельеф считаем один раз, а не на каждую перерисовку
var redrawTimer = null;    // пока идёт стройка, обновляем таймер раз в секунду

// Картинки зданий грузим один раз и переиспользуем. Пока не загрузилась —
// рисуем заглушку, а после загрузки перерисовываем сцену.
function getBuildingImage(path) {
  if (!path) return null;
  if (buildingImages[path]) return buildingImages[path];

  var img = new Image();
  img.src = '../' + path;
  img.onload = function() { scheduleRedraw(); };
  img.onerror = function() { img.failed = true; };
  buildingImages[path] = img;
  return img;
}
var currentUserId = null;
var isController = false;  // может ли текущий игрок строить на этой планете

function getSystemIdFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('system');
}

function isBuildMode() {
  var params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'build';
}

// Переключатель между наземной и орбитальной картой — нужен только
// в режиме стройки, чтобы не бегать через меню планеты ради каждого здания.
function initBuildSwitcher() {
  if (!buildMode) return;

  var bar = document.createElement('div');
  bar.id = 'build-switcher';
  bar.innerHTML =
    '<button class="build-switch-btn active" data-go="ground">Земля</button>' +
    '<button class="build-switch-btn" data-go="space">Космос</button>' +
    '<button class="build-switch-btn" data-go="galaxy">Галактика</button>';
  document.body.appendChild(bar);

  bar.addEventListener('click', function(e) {
    var target = e.target.getAttribute('data-go');
    if (!target) return;
    if (target === 'space') {
      window.location.href = 'space-battle.html?system=' + systemId + '&mode=build';
    } else if (target === 'galaxy') {
      window.location.href = 'galaxy-map.html';
    }
  });
}

// Простой детерминированный хэш строки -> число, для сида генератора
function hashStringToSeed(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// Малберри32 — маленький быстрый seeded PRNG
function mulberry32(seed) {
  var a = seed;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Генерирует сетку клеток с типами местности: 'grass_a' / 'grass_b' / 'forest' / 'lake'
function generateTerrain(seed) {
  var rand = mulberry32(seed);
  var grid = [];
  for (var y = 0; y < GRID_SIZE; y++) {
    var row = [];
    for (var x = 0; x < GRID_SIZE; x++) {
      row.push(rand() < 0.5 ? 'grass_a' : 'grass_b');
    }
    grid.push(row);
  }

  function growBlob(cx, cy, maxCells, type) {
    var placed = 0;
    var frontier = [{ x: cx, y: cy }];
    grid[cy][cx] = type;
    placed++;

    while (placed < maxCells && frontier.length > 0) {
      var idx = Math.floor(rand() * frontier.length);
      var cell = frontier[idx];
      var dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      var dir = dirs[Math.floor(rand() * dirs.length)];
      var nx = cell.x + dir[0];
      var ny = cell.y + dir[1];

      if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && grid[ny][nx] !== type) {
        grid[ny][nx] = type;
        frontier.push({ x: nx, y: ny });
        placed++;
      }

      if (rand() < 0.3) frontier.splice(idx, 1);
    }
  }

  var forestCount = 4 + Math.floor(rand() * 5);
  for (var i = 0; i < forestCount; i++) {
    var fx = Math.floor(rand() * GRID_SIZE);
    var fy = Math.floor(rand() * GRID_SIZE);
    var forestSize = 60 + Math.floor(rand() * 120);
    growBlob(fx, fy, forestSize, 'forest');
  }

  var lakeCount = 2 + Math.floor(rand() * 3);
  for (var j = 0; j < lakeCount; j++) {
    var lx = Math.floor(rand() * GRID_SIZE);
    var ly = Math.floor(rand() * GRID_SIZE);
    var lakeSize = 6 + Math.floor(rand() * 12);
    growBlob(lx, ly, lakeSize, 'lake');
  }

  return grid;
}

// Генерирует позиции 7 слотов построек в верхней части карты, вразброс,
// но не слишком далеко друг от друга (минимальная и максимальная дистанция
// от "центра кластера" одновременно). Отдельный сид от рельефа, чтобы
// не зависеть от того, сколько случайных чисел потратил генератор рельефа.
function generateBuildSlots(seed) {
  var rand = mulberry32(seed ^ 0x9E3779B9);
  var slots = [];

  // Начинаем ниже верхнего края: там теперь стоят зоны высадки.
  var bandTop = 13;
  var bandBottom = Math.floor(GRID_SIZE * 0.34) - SLOT_SIZE;
  var minDist = 9;   // минимальная дистанция между слотами (с запасом на размер 6x6)
  var maxDist = 34;  // максимальная дистанция от первого слота (кластер, не в разброс по всей карте)

  var firstX = Math.min(GRID_SIZE - SLOT_SIZE - 2, Math.floor(GRID_SIZE * 0.3 + rand() * GRID_SIZE * 0.4));
  var firstY = bandTop + Math.floor(rand() * (bandBottom - bandTop));
  slots.push({ x: firstX, y: firstY });

  var attempts = 0;
  while (slots.length < SLOT_COUNT && attempts < 500) {
    attempts++;
    var x = Math.max(2, Math.min(GRID_SIZE - SLOT_SIZE - 2, Math.floor(rand() * GRID_SIZE)));
    var y = bandTop + Math.floor(rand() * (bandBottom - bandTop));

    var okDistance = true;
    for (var i = 0; i < slots.length; i++) {
      var dx = slots[i].x - x;
      var dy = slots[i].y - y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) { okDistance = false; break; }
    }

    var dxFirst = firstX - x;
    var dyFirst = firstY - y;
    var distFromFirst = Math.sqrt(dxFirst * dxFirst + dyFirst * dyFirst);

    if (okDistance && distFromFirst <= maxDist) {
      slots.push({ x: x, y: y });
    }
  }

  // если за 500 попыток не набрали 7 (маловероятно) — дозаполняем без строгой проверки дистанции
  while (slots.length < SLOT_COUNT) {
    var fx2 = Math.max(2, Math.min(GRID_SIZE - SLOT_SIZE - 2, Math.floor(rand() * GRID_SIZE)));
    var fy2 = bandTop + Math.floor(rand() * (bandBottom - bandTop));
    slots.push({ x: fx2, y: fy2 });
  }

  return slots;
}

// Зона высадки живёт в нижней части карты, а слоты построек — в верхней,
// поэтому пересечься они не могут в принципе, отдельная проверка не нужна.
// Зоны приходят из БД — там же их проверяет сервер при размещении войск,
// поэтому клиент их не выдумывает, а только рисует.
function loadDeployZones() {
  return supabase.from('deploy_zones').select('*').eq('system_id', systemId).then(function(res) {
    deployZones = (res.error || !res.data) ? [] : res.data;
    showDeployZones = deployZones.length > 0;
  });
}

// Настройки тянем отдельным запросом и ничего им не блокируем: до ответа
// работает значение по умолчанию, полоса просто перерисуется, если в базе
// стоит другая высота.
// Обороняющемуся полосу вторжения не показываем: иначе он увидит,
// где выстроен десант, и будет ждать на месте высадки
function loadGroundSides() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    return Promise.all([
      supabase.from('profiles').select('faction').eq('id', res.data.session.user.id).maybeSingle(),
      supabase.from('systems').select('faction').eq('id', systemId).maybeSingle()
    ]).then(function(r) {
      // Обе фракции читаем до первого использования: раньше sysFaction
      // присваивался выше объявления sys и из-за подъёма переменной
      // всегда получал undefined — трофейные постройки не распознавались.
      var mine = r[0].data && r[0].data.faction;
      var sys = r[1].data && r[1].data.faction;

      myFaction = mine || null;
      sysFaction = sys || null;
      renderCaptureBar();

      if (!mine) return;
      iAmAttacker = (sys !== mine);

      // Сторона приходит отдельным запросом и может опоздать за грузом,
      // поэтому состояние кнопки пересчитываем и здесь
      updateDropBtn();
      redrawScene();
    });
  });
}

function loadGroundSettings() {
  return supabase.from('game_settings').select('key, value').then(function(res) {
    if (res.error || !res.data) return;
    var was = ATTACK_ZONE_H;
    res.data.forEach(function(row) {
      if (row.key === 'ground_attack_zone_height') {
        ATTACK_ZONE_H = parseInt(row.value, 10) || 4;
      }
      // Те же ключи, по которым считает сервер в unit_ap_state
      // и spend_unit_action. Раньше здесь стояли зашитые 30 и 2,
      // и после правки баланса панель показывала бы неправду.
      if (row.key === 'ship_action_cooldown_seconds') {
        gbApCd = parseInt(row.value, 10) || 30;
      }
      if (row.key === 'ship_action_max') {
        gbApMax = parseInt(row.value, 10) || 2;
      }
    });
    // Перерисовываем, только если значение реально отличается от того,
    // с которым уже нарисовано. Полная отрисовка тут дорогая.
    if (was !== ATTACK_ZONE_H) redrawScene();
  });
}

// Полоса вторжения у нижнего края. В отличие от площадок сброса
// в космосе, она видна всем: обороняющийся должен понимать, где
// встречать десант, иначе защищаться было бы невозможно.
function drawAttackZone() {
  if (!iAmAttacker) return;

  var py = (GRID_SIZE - ATTACK_ZONE_H) * CELL_PX;
  var w = GRID_SIZE * CELL_PX;
  var h = ATTACK_ZONE_H * CELL_PX;

  ctx.fillStyle = 'rgba(217,74,74,0.10)';
  ctx.fillRect(0, py, w, h);

  ctx.strokeStyle = 'rgba(217,74,74,0.65)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(0, py);
  ctx.lineTo(w, py);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(217,74,74,0.85)';
  ctx.font = Math.round(h * 0.32) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ПОЛОСА ВТОРЖЕНИЯ', w / 2, py + h / 2);
}

var TERRAIN_COLORS = {
  grass_a: '#3a5a2e',
  grass_b: '#456834',
  forest:  '#233a1c',
  lake:    '#2a5a78'
};

// ===== Камера =====
// Раньше поле рисовалось на одном холсте 4608×4608 (около 81 МБ), а
// сдвиг и зум делал CSS. Такой холст больше предела текстуры многих
// телефонов: отсюда чёрный экран, рваная карта и подёргивания — каждая
// перерисовка гнала в видеопамять весь буфер. Теперь холст размером с
// экран (с учётом плотности пикселей), а сдвиг и масштаб применяются при
// рисовании. Все функции отрисовки по-прежнему работают в координатах
// поля (клетка × CELL_PX) — камеру им подставляет setTransform.
// Плотность выше 2 на глаз неотличима, а заливку удорожает вдвое.
var GB_MAX_DPR = 2;
var gbDpr = 1;
var gbCssW = 0, gbCssH = 0;
var terrainBitmap = null;   // рельеф: одна точка на клетку, растягивается без сглаживания

function gbSizeCanvas() {
  var w = viewport.clientWidth, h = viewport.clientHeight;
  var dpr = Math.min(window.devicePixelRatio || 1, GB_MAX_DPR);
  var bw = Math.max(1, Math.round(w * dpr));
  var bh = Math.max(1, Math.round(h * dpr));
  // Присвоение width заново выделяет буфер — только когда размер сменился
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  if (w !== gbCssW || h !== gbCssH) {
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    gbCssW = w; gbCssH = h;
  }
  gbDpr = w ? bw / w : dpr;
}

// Сколько пикселей экрана (физических) приходится на пиксель поля
function gbScaleK() {
  return scale * gbDpr;
}

function gbHexRgb(hex) {
  var v = parseInt(String(hex).slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Рельеф — сплошные цвета по клеткам, поэтому храним его картинкой
// 144×144 и растягиваем без сглаживания: одна операция на кадр вместо
// двадцати тысяч заливок, клетки остаются с чёткими краями
function gbTerrainBitmap(grid) {
  if (terrainBitmap && terrainBitmap.grid === grid) return terrainBitmap;
  var c = document.createElement('canvas');
  c.width = GRID_SIZE;
  c.height = GRID_SIZE;
  var g = c.getContext('2d');
  var data = g.createImageData(GRID_SIZE, GRID_SIZE);
  var rgb = {};
  Object.keys(TERRAIN_COLORS).forEach(function(k) { rgb[k] = gbHexRgb(TERRAIN_COLORS[k]); });
  var fallback = gbHexRgb(TERRAIN_COLORS.grass_a);
  for (var y = 0; y < GRID_SIZE; y++) {
    for (var x = 0; x < GRID_SIZE; x++) {
      var col = rgb[grid[y][x]] || fallback;
      var i = (y * GRID_SIZE + x) * 4;
      data.data[i] = col[0];
      data.data[i + 1] = col[1];
      data.data[i + 2] = col[2];
      data.data[i + 3] = 255;
    }
  }
  g.putImageData(data, 0, 0);
  c.grid = grid;
  terrainBitmap = c;
  return c;
}

// Клетки, попавшие на экран (с запасом в одну), — для сетки
function gbVisibleCells() {
  var cell = CELL_PX * scale;
  var x0 = Math.max(0, Math.floor(-panX / cell) - 1);
  var y0 = Math.max(0, Math.floor(-panY / cell) - 1);
  var x1 = Math.min(GRID_SIZE, Math.ceil((gbCssW - panX) / cell) + 1);
  var y1 = Math.min(GRID_SIZE, Math.ceil((gbCssH - panY) / cell) + 1);
  return { x0: x0, y0: y0, x1: x1, y1: y1 };
}

// ===== Чёткие картинки на любом масштабе =====
// Исходники крупные (512–1024 px), а на экране боец занимает от десятка
// до пары сотен точек. Ужимать большой файл в каждом кадре дорого и даёт
// «зубчики» на отдалении. Держим уменьшенные копии ступенями 32…512 (каждая
// получена из вдвое большей — так уменьшение остаётся гладким) и рисуем
// ближайшую не меньше нужного. На приближении берётся сам исходник.
var gbMipCache = {};
// Выше 256 точек копии не держим: столько боец занимает на экране только
// на самом крупном зуме, а там лучше рисовать прямо из исходника
var GB_MIP_STEPS = [32, 64, 128, 256];

function gbMip(img, sx, sy, sw, sh, step, key) {
  var set = gbMipCache[key] || (gbMipCache[key] = {});
  if (set[step]) return set[step];
  var srcMax = Math.max(sw, sh);
  var r = step / srcMax;
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * r));
  c.height = Math.max(1, Math.round(sh * r));
  var g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
  // Из вдвое большей копии уменьшение глаже, но ради неё не строим всю
  // лестницу: нет готовой — берём исходник (качество «high» его вытянет)
  var big = set[step * 2];
  if (big) {
    g.drawImage(big, 0, 0, big.width, big.height, 0, 0, c.width, c.height);
  } else {
    g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  }
  set[step] = c;
  return c;
}

function gbDrawSprite(img, sx, sy, sw, sh, dx, dy, dw, dh) {
  var need = Math.max(dw, dh) * gbScaleK();
  var srcMax = Math.max(sw, sh);
  var step = 0;
  for (var i = 0; i < GB_MIP_STEPS.length; i++) {
    if (GB_MIP_STEPS[i] >= need) { step = GB_MIP_STEPS[i]; break; }
  }
  if (!step || step * 1.5 >= srcMax) {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  var c = gbMip(img, sx, sy, sw, sh, step, img.src + '|' + sx + ',' + sy + ',' + sw + ',' + sh);
  ctx.drawImage(c, 0, 0, c.width, c.height, dx, dy, dw, dh);
}

// Вся картинка целиком — частный случай
function gbDrawImage(img, dx, dy, dw, dh) {
  gbDrawSprite(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
}

function drawScene(grid) {
  gbSizeCanvas();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  var k = gbScaleK();
  ctx.setTransform(k, 0, 0, k, panX * gbDpr, panY * gbDpr);

  // Рельеф одним растяжением
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(gbTerrainBitmap(grid), 0, 0, GRID_SIZE, GRID_SIZE,
                0, 0, GRID_SIZE * CELL_PX, GRID_SIZE * CELL_PX);
  ctx.imageSmoothingEnabled = true;

  // Сетка — одним контуром и только в видимой части (на любом масштабе:
  // даже на самом дальнем она даёт полю привычную фактуру)
  {
    var v = gbVisibleCells();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = v.x0; gx <= v.x1; gx++) {
      ctx.moveTo(gx * CELL_PX, v.y0 * CELL_PX);
      ctx.lineTo(gx * CELL_PX, v.y1 * CELL_PX);
    }
    for (var gy = v.y0; gy <= v.y1; gy++) {
      ctx.moveTo(v.x0 * CELL_PX, gy * CELL_PX);
      ctx.lineTo(v.x1 * CELL_PX, gy * CELL_PX);
    }
    ctx.stroke();
  }

  drawSettlement();
  drawBuildSlots();
  drawStructures();
  drawDeployZone();
  drawFog();
  drawPlacementCells();
  drawDropCells();
  drawDisembarkCells();
  drawBlockedSites();
  drawMoveCells();
  drawTargetCells();
  drawAttackZone();
  drawUnits();
  drawStructureOverlay();
  drawDragOverlay();
}

// ===== Туман войны =====
// Что игрок видит, считает сервер (get_my_vision — те же правила, что и
// фильтр врагов в базе): обзор своих бойцов и союзников с ретранслятором,
// радары, узел связи, полоса вторжения. Всё остальное затемняем — иначе
// туман был невидим и казалось, что он не работает. Маска — картинка
// клетка-в-точку; при растяжении сглаживание само даёт мягкий край.
var gbVision = null;
var gbFogCanvas = null;
var gbFogDirty = true;
var GB_FOG_COLOR = 'rgba(4,7,12,0.62)';

function loadVision() {
  if (!systemId || buildMode) return;
  supabase.rpc('get_my_vision', { p_system_id: systemId, p_layer: 'ground' }).then(function(res) {
    if (res.error || !res.data) return;
    gbVision = res.data;
    gbFogDirty = true;
    redrawScene();
  });
}

function gbFogMask() {
  if (gbFogCanvas && !gbFogDirty) return gbFogCanvas;
  var c = gbFogCanvas || document.createElement('canvas');
  c.width = GRID_SIZE;
  c.height = GRID_SIZE;
  var g = c.getContext('2d');
  g.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
  g.fillStyle = GB_FOG_COLOR;
  g.fillRect(0, 0, GRID_SIZE, GRID_SIZE);
  gbVision.forEach(function(r) {
    if (r.kind === 'see') g.clearRect(r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
  });
  // Закрытое поверх открытого: полосу вторжения обороне не видно никогда
  gbVision.forEach(function(r) {
    if (r.kind === 'hide') {
      g.clearRect(r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
      g.fillRect(r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
    }
  });
  gbFogCanvas = c;
  gbFogDirty = false;
  return c;
}

function drawFog() {
  if (!gbVision || buildMode) return;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(gbFogMask(), 0, 0, GRID_SIZE, GRID_SIZE, 0, 0, GRID_SIZE * CELL_PX, GRID_SIZE * CELL_PX);
}

// Зоны высадки — тактическая информация, поэтому видны только своей фракции.
function drawDeployZone() {
  if (!showDeployZones) return;

  deployZones.forEach(function(zone) {
    var px = zone.x * CELL_PX;
    var py = zone.y * CELL_PX;
    var size = (zone.size || DEPLOY_SIZE) * CELL_PX;

    ctx.fillStyle = 'rgba(95,217,104,0.10)';
    ctx.fillRect(px, py, size, size);
    ctx.strokeStyle = 'rgba(95,217,104,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(px, py, size, size);
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(95,217,104,0.9)';
    ctx.font = Math.round(size * 0.11) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('ЗОНА ВЫСАДКИ', px + size / 2, py + 6);
  });
}

function drawBuildSlots() {
  var now = Date.now();

  for (var i = 0; i < buildSlots.length; i++) {
    var slot = buildSlots[i];
    var slotIndex = i + 1;
    var px = slot.x * CELL_PX;
    var py = slot.y * CELL_PX;
    var size = SLOT_SIZE * CELL_PX;

    var building = buildingsBySlot[slotIndex];

    if (!building) {
      // Вне режима стройки пустые слоты не показываем — на обычной карте
      // должны быть видны только реально существующие здания.
      if (!buildMode) continue;

      // Участок ещё закрыт: его откроет рост поселения. Рисуем приглушённо,
      // с номером нужного уровня — видно, ради чего расширять поселение.
      if (slot.locked) {
        drawLockedSlot(slot, px, py, size);
        continue;
      }

      ctx.fillStyle = 'rgba(120,170,220,0.15)';
      ctx.fillRect(px, py, size, size);
      ctx.strokeStyle = 'rgba(120,170,220,0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(px, py, size, size);
      ctx.setLineDash([]);
      continue;
    }

    var type = building.building_types || {};
    var img = getBuildingImage(type.image);
    var ready = !building.completes_at || new Date(building.completes_at).getTime() <= now;

    if (img && img.complete && !img.failed && img.naturalWidth > 0) {
      ctx.save();
      if (!ready) ctx.globalAlpha = 0.45; // недостроенное здание бледнее
      gbDrawImage(img, px, py, size, size);
      ctx.restore();
    } else {
      // картинки нет или ещё грузится — заглушка с символом
      ctx.fillStyle = 'rgba(217,169,64,0.35)';
      ctx.fillRect(px, py, size, size);
      ctx.fillStyle = '#0a0d14';
      ctx.font = (size * 0.4) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(type.icon || '■', px + size / 2, py + size / 2);
    }

    ctx.strokeStyle = ready ? '#d9a940' : 'rgba(120,170,220,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, size, size);

    if (!ready) {
      drawConstructionProgress(building, px, py, size, now);
    }
  }
}

function drawLockedSlot(slot, px, py, size) {
  ctx.fillStyle = 'rgba(10,13,20,0.42)';
  ctx.fillRect(px, py, size, size);
  ctx.strokeStyle = 'rgba(143,168,196,0.38)';
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 6]);
  ctx.strokeRect(px, py, size, size);
  ctx.setLineDash([]);

  // Замок: дужка и корпус, без шрифтовых значков — они на телефонах разные
  var cx = px + size / 2, cy = py + size * 0.42, u = size * 0.07;
  ctx.strokeStyle = 'rgba(217,169,64,0.75)';
  ctx.lineWidth = Math.max(2, u * 0.55);
  ctx.beginPath();
  ctx.arc(cx, cy - u * 0.4, u * 1.15, Math.PI, 0);
  ctx.stroke();
  ctx.fillStyle = 'rgba(217,169,64,0.75)';
  ctx.fillRect(cx - u * 1.7, cy - u * 0.4, u * 3.4, u * 2.6);

  ctx.fillStyle = 'rgba(207,216,220,0.8)';
  ctx.font = Math.round(size * 0.13) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('уровень ' + (STL_ROMAN[slot.need_level] || slot.need_level || '?'), cx, py + size * 0.68);
}

// Полоса прогресса и обратный отсчёт на строящемся здании.
function drawConstructionProgress(building, px, py, size, now) {
  var endMs = new Date(building.completes_at).getTime();
  var startMs = new Date(building.built_at).getTime();
  var total = endMs - startMs;
  var progress = total > 0 ? (now - startMs) / total : 1;
  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;

  var barH = Math.max(4, size * 0.06);
  var barY = py + size - barH - 4;

  ctx.fillStyle = 'rgba(5,6,10,0.75)';
  ctx.fillRect(px + 4, barY, size - 8, barH);
  ctx.fillStyle = '#4a90d9';
  ctx.fillRect(px + 4, barY, (size - 8) * progress, barH);

  var left = Math.max(0, Math.ceil((endMs - now) / 1000));
  var mm = Math.floor(left / 60);
  var ss = left % 60;
  var label = mm > 0 ? (mm + ':' + (ss < 10 ? '0' : '') + ss) : (ss + 'с');

  ctx.fillStyle = '#cfd8dc';
  ctx.font = Math.round(size * 0.16) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, px + size / 2, barY - 4);
}

// Сдвиг и зум теперь не двигают холст, а перерисовывают видимую часть.
// Слой подписей сдвигаем сразу: автоход меряет свои ярлыки сразу после
// focusCell. На экран оба изменения попадают в одном кадре — стиль
// применяется к отрисовке, перед которой и срабатывает кадровый колбэк.
function applyTransform() {
  cbSyncFxLayer();
  redrawScene();
}

function clampPan() {
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight - uiBottomInset;
  var fieldPx = GRID_SIZE * CELL_PX;
  var scaledSize = fieldPx * scale;

  if (scaledSize <= vw) {
    panX = (vw - scaledSize) / 2;
  } else {
    var minPanX = vw - scaledSize;
    panX = Math.min(0, Math.max(minPanX, panX));
  }

  if (scaledSize <= vh) {
    panY = (vh - scaledSize) / 2;
  } else {
    var minPanY = vh - scaledSize;
    panY = Math.min(0, Math.max(minPanY, panY));
  }
}

function centerGridInitially() {
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight;
  var fieldPx = GRID_SIZE * CELL_PX;
  scale = 0.35;
  panX = vw / 2 - (fieldPx * scale) / 2;
  panY = vh / 2 - (fieldPx * scale) / 2;
  clampPan();
  applyTransform();
}

// Поворот телефона, клавиатура, смена окна: холст подгоняется под экран
function gbOnViewportResize() {
  clampPan();
  applyTransform();
}

function initPanAndZoom() {
  if (window.ResizeObserver) {
    new ResizeObserver(gbOnViewportResize).observe(viewport);
  } else {
    window.addEventListener('resize', gbOnViewportResize);
  }

  var isDragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var panStartX = 0;
  var panStartY = 0;
  var movedDuringDrag = false;

  var pinchStartDist = 0;
  var pinchStartScale = 1;
  var anchorGridX = 0;
  var anchorGridY = 0;

  function distance(t1, t2) {
    var dx = t1.clientX - t2.clientX;
    var dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function midpoint(t1, t2) {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2
    };
  }

  viewport.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      isDragging = true;
      movedDuringDrag = false;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      panStartX = panX;
      panStartY = panY;
      // Палец на своём бойце: удержит — боец поднимется под палец
      gbDragArm(dragStartX, dragStartY);
    } else if (e.touches.length === 2) {
      // Второй палец — это щипок, а не приказ: поднятого бойца отпускаем
      gbDragCancel();
      isDragging = false;
      pinchStartDist = distance(e.touches[0], e.touches[1]);
      pinchStartScale = scale;

      var mid = midpoint(e.touches[0], e.touches[1]);
      var rect = viewport.getBoundingClientRect();
      var midInViewport = { x: mid.x - rect.left, y: mid.y - rect.top };

      anchorGridX = (midInViewport.x - panX) / scale;
      anchorGridY = (midInViewport.y - panY) / scale;
    }
  }, { passive: true });

  viewport.addEventListener('touchmove', function(e) {
    if (gbDragActive()) {
      if (e.touches.length === 1) gbDragMove(e.touches[0].clientX, e.touches[0].clientY);
      return;
    }
    if (e.touches.length === 1) gbDragArmMoved(e.touches[0].clientX, e.touches[0].clientY);
    if (e.touches.length === 1 && isDragging) {
      var dx = e.touches[0].clientX - dragStartX;
      var dy = e.touches[0].clientY - dragStartY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) movedDuringDrag = true;
      panX = panStartX + dx;
      panY = panStartY + dy;
      clampPan();
      applyTransform();
    } else if (e.touches.length === 2) {
      var newDist = distance(e.touches[0], e.touches[1]);
      var ratio = newDist / pinchStartDist;
      scale = Math.min(3, Math.max(0.1, pinchStartScale * ratio));

      var mid = midpoint(e.touches[0], e.touches[1]);
      var rect = viewport.getBoundingClientRect();
      var midInViewport = { x: mid.x - rect.left, y: mid.y - rect.top };

      panX = midInViewport.x - anchorGridX * scale;
      panY = midInViewport.y - anchorGridY * scale;

      clampPan();
      applyTransform();
    }
  }, { passive: true });

  viewport.addEventListener('touchcancel', function() {
    gbDragCancel();
    isDragging = false;
  });

  // Долгое нажатие не должно открывать меню браузера поверх карты
  viewport.addEventListener('contextmenu', function(e) { e.preventDefault(); });

  viewport.addEventListener('touchend', function(e) {
    gbDragDisarm();
    if (gbDragActive()) {
      if (e.touches.length === 0) {
        if (e.cancelable) e.preventDefault();
        lastTouchEndMs = Date.now();
        gbDragEnd();
        isDragging = false;
      }
      return;
    }
    if (e.touches.length === 0) {
      if (isDragging && !movedDuringDrag) {
        // Браузер после касания дублирует событие мышью. Оно попадает уже
        // в открывшуюся панель и нажимает карточку под пальцем — из-за этого
        // здание ставилось мгновенно. Гасим дубль и блокируем мышь на момент.
        if (e.cancelable) e.preventDefault();
        lastTouchEndMs = Date.now();
        handleTap(dragStartX, dragStartY);
      }
      isDragging = false;
    } else if (e.touches.length === 1) {
      isDragging = true;
      movedDuringDrag = false;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      panStartX = panX;
      panStartY = panY;
    }
  });

  var mouseDragging = false;
  var mouseMoved = false;
  viewport.addEventListener('mousedown', function(e) {
    if (Date.now() - lastTouchEndMs < 700) return; // это эхо касания, не мышь
    if (e.button !== undefined && e.button !== 0) return;
    mouseDragging = true;
    mouseMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    gbDragArm(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', function(e) {
    if (gbDragActive()) { gbDragMove(e.clientX, e.clientY); return; }
    if (!mouseDragging) return;
    gbDragArmMoved(e.clientX, e.clientY);
    var dx = e.clientX - dragStartX;
    var dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) mouseMoved = true;
    panX = panStartX + dx;
    panY = panStartY + dy;
    clampPan();
    applyTransform();
  });
  window.addEventListener('mouseup', function(e) {
    if (Date.now() - lastTouchEndMs < 700) { mouseDragging = false; return; }
    gbDragDisarm();
    if (gbDragActive()) { mouseDragging = false; gbDragEnd(); return; }
    if (mouseDragging && !mouseMoved) {
      handleTap(e.clientX, e.clientY);
    }
    mouseDragging = false;
  });

  viewport.addEventListener('wheel', function(e) {
    e.preventDefault();
    var rect = viewport.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    var gridX = (mx - panX) / scale;
    var gridY = (my - panY) / scale;

    var delta = e.deltaY < 0 ? 1.1 : 0.9;
    scale = Math.min(3, Math.max(0.1, scale * delta));

    panX = mx - gridX * scale;
    panY = my - gridY * scale;
    clampPan();
    applyTransform();
  }, { passive: false });
}

// Определяет, попал ли тап в один из слотов построек, и открывает нужную панель.
function handleTap(clientX, clientY) {
  var rect = viewport.getBoundingClientRect();
  var vx = clientX - rect.left;
  var vy = clientY - rect.top;

  var gridPxX = (vx - panX) / scale;
  var gridPxY = (vy - panY) / scale;
  var cellX = Math.floor(gridPxX / CELL_PX);
  var cellY = Math.floor(gridPxY / CELL_PX);

  if (placingStructure) {
    handleStructurePlacementTap(cellX, cellY);
    return;
  }

  if (landingFighter) {
    handleFighterLandingTap(cellX, cellY);
    return;
  }

  if (droppingVehicle) {
    handleVehicleDropTap(cellX, cellY);
    return;
  }

  if (disembarking) {
    handleDisembarkTap(cellX, cellY);
    return;
  }

  if (heroAbility) {
    handleHeroAbilityTap(cellX, cellY);
    return;
  }

  if (upgradeAbility) {
    handleUpgradeAbilityTap(cellX, cellY);
    return;
  }

  if (artilleryUnit) {
    handleArtilleryTap(cellX, cellY);
    return;
  }

  if (attackingUnit || abilityUnit) {
    handleTargetTap(cellX, cellY);
    return;
  }

  if (movingUnit) {
    handleGroundMoveTap(cellX, cellY);
    return;
  }

  if (droppingUnit) {
    handleDropTap(cellX, cellY);
    return;
  }

  if (placingOrder) {
    handlePlacementTap(cellX, cellY);
    return;
  }

  // Выбор точки автохода: уступает всем режимам выше, но раньше
  // обычного выбора бойца — тапы по своим собирают отряд
  if (typeof amPick !== 'undefined' && amPick) {
    amHandleTap(cellX, cellY);
    return;
  }

  // Тап по своему юниту показывает его радиус обзора
  // По всему корпусу: тап по любой из четырёх клеток выбирает машину
  // Поселение проверяем раньше юнитов: оно занимает 6x6 и на нём никто
  // не стоит, а вот охрана вокруг него — вполне
  if (settlement
      && cellX >= settlement.x && cellX < settlement.x + settlement.size
      && cellY >= settlement.y && cellY < settlement.y + settlement.size) {
    if (selectedStructure) { selectedStructure = null; hidePickup(); redrawScene(); }
    openSettlementPanel();
    return;
  }

  var tappedUnit = unitsOnMap.filter(function(u) {
    if (u.x === null || u.x === undefined) return false;
    var size = unitBox(u);
    return cellX >= u.x && cellX < u.x + size.w
        && cellY >= u.y && cellY < u.y + size.h;
  })[0];
  if (tappedUnit) {
    selectedStructure = null;
    selectedUnit = (selectedUnit && selectedUnit.id === tappedUnit.id) ? null : tappedUnit;
    redrawScene();
    if (selectedUnit) {
      offerPickup(selectedUnit);
    } else {
      hidePickup();
    }
    return;
  }
  if (selectedUnit) { selectedUnit = null; hidePickup(); redrawScene(); }

  // Полевая постройка: окоп, турель, кантина. Бойцы в окопе и бункере
  // стоят поверх неё и выбираются раньше — постройку открывает тап
  // по её свободной клетке
  var tappedStruct = structAt(cellX, cellY);
  if (tappedStruct) {
    if (selectedStructure && selectedStructure.id === tappedStruct.id) {
      selectedStructure = null; hidePickup(); redrawScene();
    } else {
      openStructurePanel(tappedStruct);
    }
    return;
  }
  if (selectedStructure) { selectedStructure = null; hidePickup(); redrawScene(); }

  for (var i = 0; i < buildSlots.length; i++) {
    var slot = buildSlots[i];
    if (cellX >= slot.x && cellX < slot.x + SLOT_SIZE &&
        cellY >= slot.y && cellY < slot.y + SLOT_SIZE) {
      // Пустой слот вне режима стройки не должен реагировать: он и не
      // нарисован, а тап по невидимому месту открывал панель выбора,
      // в которой всё равно ничего нельзя построить
      if (!buildingsBySlot[i + 1] && !buildMode) return;
      onSlotTapped(i + 1);
      return;
    }
  }
}

function onSlotTapped(slotIndex) {
  var existing = buildingsBySlot[slotIndex];
  if (existing) {
    var ready = !existing.completes_at || new Date(existing.completes_at).getTime() <= Date.now();
    var mine = existing.owner_user_id === currentUserId;

    var code = (existing.building_types || {}).code;

    // Арендатор: тап по сданному ему зданию сразу открывает найм.
    // Кэш мог устареть — карточка постройки перечитает аренду сама.
    if (!buildMode && ready && !mine && typeof plIsTenant === 'function' &&
        plIsTenant(plLeaseOf(gbLeaseMap, existing.id))) {
      openUnitPanel(existing);
      return;
    }
    var isLab = code === 'rep_research' || code === 'cis_lab';
    var isHub = code === 'rep_logistics' || code === 'cis_logistics';
    var isTrade = code === 'rep_trade' || code === 'cis_trade';
    var isEconomy = isEconomyBuilding(code);

    // В обычном режиме тап по своему готовому зданию открывает его занятие:
    // у казармы это наём, у научного центра — исследования. Карточка
    // со сносом остаётся в режиме стройки.
    if (!buildMode && mine && ready) {
      if (isLab) openResearchPanel(existing);
      // Хаб — вход в общий экран «Снабжение» (рейсы, склады, рынок) от
      // этой планеты; старая панель узла — только если экран не подключён
      else if (isHub && typeof openSupplyScreen === 'function') openSupplyScreen('routes', { hub: existing.system_id || systemId });
      else if (isHub) openLogisticsPanel(existing);
      else if (isTrade) openTradePanel(existing);
      else if (isEconomy) openEconomyPanel(existing);
      else openUnitPanel(existing);
    } else {
      openBuildingInfo(existing);
    }
    return;
  }

  if (!isController) {
    alert('У тебя нет прав на строительство на этой планете');
    return;
  }

  var slot = buildSlots[slotIndex - 1];
  if (slot && slot.locked) {
    alert('Участок откроется, когда поселение станет «' + (slot.need_name || 'больше') + '»' +
          ' (уровень ' + (STL_ROMAN[slot.need_level] || slot.need_level) + ').\n\n' +
          'Расширяет поселение управляющий — в окне поселения.');
    return;
  }

  openBuildPanel(slotIndex);
}

// Карточка существующей постройки: название и снос за половину стоимости
// (возврат считается на сервере функцией demolish_building, клиент не может
// подменить сумму возврата).
var buildingInfoSeq = 0;        // какая карточка открыта: поздние ответы к чужой не липнут
var buildingDemolishBusy = false;

function buildingInfoShown() {
  var p = document.getElementById('building-info-panel');
  return !!p && p.style.display !== 'none';
}

function openBuildingInfo(building) {
  var seq = ++buildingInfoSeq;
  var panel = document.getElementById('building-info-panel');
  var nameEl = document.getElementById('building-info-name');
  var refundEl = document.getElementById('building-info-refund');
  var demolishBtn = document.getElementById('building-info-demolish');

  var type = building.building_types || {};
  nameEl.textContent = type.name || 'Постройка';

  // Трофейная постройка: её фракция разошлась с фракцией планеты
  var captured = sysFaction && building.faction && building.faction !== sysFaction;
  var half = Math.floor((type.cost || 0) / 2);

  if (captured && isController) {
    refundEl.textContent = 'Трофейная постройка. Снос обойдётся в ' + half;
    refundEl.style.display = 'block';
  } else if (isController) {
    var fullType = buildingTypeByCode(type.code);
    var hasRes = fullType && fullType.cost_resources && Object.keys(fullType.cost_resources).length > 0;
    refundEl.textContent = 'При сносе вернётся: ' + half + ' кр.' + (hasRes ? ' и половина сырья' : '');
    refundEl.style.display = 'block';
  } else {
    refundEl.textContent = '';
    refundEl.style.display = 'none';
  }

  // Научный центр открывает исследования: это его единственное занятие,
  // поэтому кнопка ведёт прямо в каталог
  var researchBtn = document.getElementById('building-info-research');
  var isLab = type.code === 'rep_research' || type.code === 'cis_lab';

  if (researchBtn) {
    researchBtn.style.display = (isLab && isController && !captured) ? 'block' : 'none';
    researchBtn.onclick = function() {
      closeBuildingInfo();
      openResearchPanel(building);
    };
  }

  demolishBtn.style.display = isController ? 'block' : 'none';
  demolishBtn.disabled = buildingDemolishBusy;

  gbPaintBuildingLease(building, seq, captured);
  demolishBtn.onclick = function() {
    if (demolishBtn.disabled || buildingDemolishBusy) return;
    askDemolishBuilding(building, captured && isController, function() {
      if (buildingDemolishBusy) return;
      buildingDemolishBusy = true;
      demolishBtn.disabled = true;
      var finish = function() {
        buildingDemolishBusy = false;
        demolishBtn.disabled = false;
        // Закрываем только свою карточку, а не ту, что открыли следом
        if (seq === buildingInfoSeq) closeBuildingInfo();
      };
      supabase.rpc('demolish_building', { p_building_id: building.id }).then(function(res) {
        finish();
        if (res.error) {
          alert('Не удалось снести: ' + res.error.message);
          return;
        }
        loadBuildings();
        // Возвращённое сырьё сразу видно в полосе запаса при следующей стройке
        loadPlanetStock();
      }, function(e) {
        finish();
        alert('Не удалось снести: ' + ((e && e.message) || 'нет связи с сервером'));
      });
    });
  };

  panel.style.display = 'flex';
}

// ===== Исследования =====
// Каталог личный: изученное принадлежит игроку, а не фракции. Ступени
// идут по порядку, вторая без первой не берётся.

var researchBuilding = null;
var researchTimer = null;
var researchShip = null;        // по какому кораблю смотрим ветку
var researchShipNames = {};

function openResearchPanel(building) {
  researchBuilding = building;

  var panel = document.getElementById('research-panel');
  if (!panel) return;

  panel.style.display = 'flex';
  document.getElementById('research-list').innerHTML =
    '<div class="rs-empty">Загрузка…</div>';

  researchActiveId = null;
  researchActiveKey = null;
  loadResearchPanel();

  if (researchTimer) clearInterval(researchTimer);
  researchTimer = setInterval(loadResearchPanel, 5000);
  if (researchTickTimer) clearInterval(researchTickTimer);
  researchTickTimer = setInterval(researchTick, 1000);
}

function closeResearchPanel() {
  var panel = document.getElementById('research-panel');
  if (panel) panel.style.display = 'none';
  if (researchTimer) { clearInterval(researchTimer); researchTimer = null; }
  if (researchTickTimer) { clearInterval(researchTickTimer); researchTickTimer = null; }
}

// Готовое по времени сервер выдаёт на тике раз в 30 секунд. Чтобы таймер
// не стоял на нуле всё это время, клиент сам просит выдать своё готовое.
// Один запрос за раз и не чаще раза в три секунды. Промис отдаёт true,
// если запрос действительно ушёл: только тогда есть смысл перечитывать —
// иначе застрявший заказ (нет места в зоне высадки) крутил бы перечитку
// без остановки.
var claimInFlight = null;
var claimLastAt = 0;

function claimReadyNow() {
  if (claimInFlight) return claimInFlight;
  if (Date.now() - claimLastAt < 3000) return Promise.resolve(false);
  claimLastAt = Date.now();
  claimInFlight = supabase.rpc('claim_ready_now').then(
    function() { claimInFlight = null; return true; },
    function() { claimInFlight = null; return true; });
  return claimInFlight;
}

// Секунды идут локально между опросами: раньше цифра менялась раз
// в 5 секунд, а на нуле стояла до выдачи на сервере
var researchTickTimer = null;
var researchActiveId = null;    // открытое описание
var researchActiveKey = null;   // его состояние: перерисовываем только при смене

function researchTick() {
  var now = Date.now();
  var due = false;

  var tiles = document.querySelectorAll('#research-list .rs-tile[data-until]');
  for (var i = 0; i < tiles.length; i++) {
    var left = Math.max(0, Math.ceil((parseInt(tiles[i].getAttribute('data-until'), 10) - now) / 1000));
    var note = tiles[i].querySelector('.rs-note');
    if (note) note.textContent = left > 0 ? formatResearchLeft(left) : 'готово';
    if (left <= 0) due = true;
  }

  var infoLeft = document.getElementById('rs-info-left');
  if (infoLeft && infoLeft.getAttribute('data-until')) {
    var l2 = Math.max(0, Math.ceil((parseInt(infoLeft.getAttribute('data-until'), 10) - now) / 1000));
    infoLeft.textContent = l2 > 0 ? 'Изучается: ' + formatResearchLeft(l2) : 'Готово, записываем…';
  }

  if (due) claimReadyNow().then(function(sent) { if (sent) loadResearchPanel(); });
}

function formatResearchLeft(sec) {
  if (sec >= 60) return Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' с';
  return sec + ' с';
}

// Названия техники для веток каталога не меняются — берём один раз,
// а не каждые 5 секунд вместе со списком исследований
var researchNamesLoaded = false;

function loadResearchPanel() {
  Promise.all([
    supabase.rpc('get_researches'),
    researchNamesLoaded ? Promise.resolve({ data: [] }) : supabase.from('ship_types').select('id, name').eq('is_fighter', false),
    researchNamesLoaded ? Promise.resolve({ data: [] }) : supabase.from('unit_types').select('id, name')
  ]).then(function(r) {
    if (!r[1].error && !r[2].error && (r[1].data || []).length && (r[2].data || []).length) researchNamesLoaded = true;
    var res = r[0];
    var list = document.getElementById('research-list');
    if (!list) return;

    if (res.error) {
      list.innerHTML = '<div class="rs-empty">Ошибка: ' + res.error.message + '</div>';
      return;
    }

    (r[1].data || []).forEach(function(t) { researchShipNames[t.id] = t.name; });
    (r[2].data || []).forEach(function(t) { researchShipNames[t.id] = t.name; });

    var all = res.data || [];

    // Ветки принадлежат конкретной технике — кораблю или бойцу. Показывать
    // их одним списком нельзя: каталог превратится в свалку, где половина
    // строк не относится к тому, что игрок собирается строить.
    var ships = [];
    all.forEach(function(x) {
      (x.applies_to || []).concat(x.applies_units || []).forEach(function(sid) {
        if (ships.indexOf(sid) === -1) ships.push(sid);
      });
    });

    if (!researchShip || ships.indexOf(researchShip) === -1) researchShip = ships[0] || null;

    var rows = all.filter(function(x) {
      return (x.applies_to || []).indexOf(researchShip) !== -1
          || (x.applies_units || []).indexOf(researchShip) !== -1;
    });

    list.innerHTML = '';

    if (ships.length > 1) {
      var picker = document.createElement('div');
      picker.className = 'rs-ships';

      ships.forEach(function(sid) {
        var b = document.createElement('button');
        b.className = 'rs-ship' + (sid === researchShip ? ' active' : '');
        b.textContent = researchShipNames[sid] || sid;
        b.addEventListener('click', function() {
          researchShip = sid;
          loadResearchPanel();
        });
        picker.appendChild(b);
      });

      list.appendChild(picker);
    }

    // Группируем по разделам, как в исходном списке
    var order = [];
    var byCat = {};
    rows.forEach(function(r) {
      if (!byCat[r.category]) { byCat[r.category] = []; order.push(r.category); }
      byCat[r.category].push(r);
    });

    // Строим цепочки: у каждой ветки корень и то, что из него растёт.
    // Так видно путь целиком, а не набор разрозненных плиток.
    var byId = {};
    rows.forEach(function(r) { byId[r.id] = r; });

    var childOf = {};
    rows.forEach(function(r) {
      var parent = null;
      // Предшественник известен по названию: сверяем с каталогом
      rows.forEach(function(o) { if (o.name === r.requires_name) parent = o.id; });
      if (parent) {
        if (!childOf[parent]) childOf[parent] = [];
        childOf[parent].push(r);
      }
      r._parent = parent;
    });

    order.forEach(function(cat) {
      var head = document.createElement('div');
      head.className = 'rs-cat';
      head.textContent = cat;
      list.appendChild(head);

      byCat[cat].filter(function(r) { return !r._parent; }).forEach(function(root) {
        var chain = document.createElement('div');
        chain.className = 'rs-chain';

        var addTile = function(r, last) {
          chain.appendChild(makeResearchTile(r));
          if (!last) {
            var arrow = document.createElement('span');
            arrow.className = 'rs-arrow';
            arrow.textContent = '›';
            chain.appendChild(arrow);
          }
        };

        var line = [root];
        var cur = root;
        while (childOf[cur.id] && childOf[cur.id].length) {
          cur = childOf[cur.id][0];
          line.push(cur);
        }

        line.forEach(function(r, i) { addTile(r, i === line.length - 1); });
        list.appendChild(chain);

        // Ветки, отходящие вбок, ставим отдельной строкой под цепочкой
        line.forEach(function(r) {
          var kids = (childOf[r.id] || []).slice(1);
          kids.forEach(function(k) {
            var branch = document.createElement('div');
            branch.className = 'rs-chain branch';
            var from = document.createElement('span');
            from.className = 'rs-arrow';
            from.textContent = '↳';
            branch.appendChild(from);
            branch.appendChild(makeResearchTile(k));
            list.appendChild(branch);
          });
        });
      });
    });

    // Открытое описание живёт дальше: подсветку возвращаем, а текст
    // меняем, только если исследование сменило состояние — иначе опрос
    // раз в 5 секунд выбивал бы кнопку «Изучить» из-под пальца
    if (researchActiveId) {
      var cur = byId[researchActiveId];
      var tile = list.querySelector('.rs-tile[data-id="' + researchActiveId + '"]');
      if (cur && tile) {
        tile.classList.add('active');
        if (researchStateKey(cur) !== researchActiveKey) showResearchInfo(cur, tile);
      }
    }
  });
}

function researchStateKey(r) {
  return (r.done ? 'd' : '') + (r.in_progress ? 'p' : '') + (r.available ? 'a' : '');
}

function makeResearchTile(r) {
  var tile = document.createElement('button');
  tile.className = 'rs-tile' +
    (r.done ? ' done' : '') +
    (r.in_progress ? ' busy' : '') +
    (!r.available && !r.done ? ' locked' : '');
  tile.setAttribute('data-id', r.id);
  if (r.in_progress) tile.setAttribute('data-until', String(Date.now() + (r.seconds_left || 0) * 1000));

  tile.innerHTML =
    '<img class="rs-icon" src="../' + r.icon_image + '" alt="">' +
    '<span class="rs-name">' + r.name + '</span>' +
    '<span class="rs-note">' +
      (r.done ? 'изучено'
       : r.in_progress ? (r.seconds_left > 0 ? formatResearchLeft(r.seconds_left) : 'готово')
       : !r.available ? 'закрыто'
       : r.cost + ' кр') +
    '</span>';

  tile.addEventListener('click', function() { showResearchInfo(r, tile); });
  return tile;
}

function showResearchInfo(r, tile) {
  var info = document.getElementById('research-info');
  if (!info) return;

  var all = document.querySelectorAll('.rs-tile');
  for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
  tile.classList.add('active');
  researchActiveId = r.id;
  researchActiveKey = researchStateKey(r);

  info.innerHTML =
    '<div class="rs-info-name">' + r.name + '</div>' +
    '<div class="rs-info-text">' + r.description + '</div>' +
    '<div class="rs-info-meta">' + researchEffectText(r) + '</div>';

  if (r.done) {
    info.innerHTML += '<div class="rs-info-meta ok">' +
      (r.effect_kind === 'unlock_structure' ? 'Изучено — инженер может строить'
       : r.scope === 'unit' ? 'Изучено — можно брать при найме'
       : 'Изучено — можно ставить на новые корабли') + '</div>';
    return;
  }

  if (r.in_progress) {
    info.innerHTML += '<div class="rs-info-meta warn" id="rs-info-left" data-until="' +
      (Date.now() + (r.seconds_left || 0) * 1000) + '">' +
      (r.seconds_left > 0 ? 'Изучается: ' + formatResearchLeft(r.seconds_left) : 'Готово, записываем…') +
      '</div>';
    return;
  }

  if (!r.available) {
    info.innerHTML += '<div class="rs-info-meta warn">Сначала: ' + (r.requires_name || '') + '</div>';
    return;
  }

  var go = document.createElement('button');
  go.className = 'rs-go';
  go.textContent = 'Изучить · ' + r.cost;
  go.addEventListener('click', function() {
    go.disabled = true;
    supabase.rpc('start_research', {
      p_building_id: researchBuilding.id, p_research_id: r.id
    }).then(function(res) {
      if (res.error) { alert(res.error.message); go.disabled = false; return; }
      loadResearchPanel();
      info.innerHTML = '<div class="rs-info-meta ok">Исследование запущено</div>';
    });
  });
  info.appendChild(go);
}

// Человеческое описание эффекта: из вида и величины
function researchEffectText(r) {
  var v = r.effect_value;
  var d = r.ability_damage;

  switch (r.effect_kind) {
    case 'hp':           return '+' + v + ' к прочности';
    case 'hp_slow':      return '+' + v + ' к прочности, −1 к дальности хода';
    case 'move':         return '+' + v + ' к дальности хода';
    case 'weapon_range': return '+' + v + ' к дальности атаки';

    case 'ability_grenade':
      return 'урон ' + d + ' по области ' + v + '×' + v;
    case 'ability_he':
      return 'урон ' + d + ' по области ' + v + '×' + v + ', только по пехоте';
    case 'ability_suppression':
      return 'урон ' + d + ' по области ' + v + '×' + v + ' и залегание: цель не ходит и не стреляет';
    case 'ability_stun':
      return v >= 100 ? 'оглушает цель наверняка' : 'шанс ' + v + '% оглушить цель';
    case 'ability_ap':   return 'двойной урон по технике';
    case 'ability_headshot': return 'уничтожает выбранную цель';
    case 'ability_twin':
      return 'бьёт первую цель, вторую рядом с шансом ' + v + '%';
    case 'ability_lunge':
      return 'рывок к врагу до ' + v + ' клеток и удар клинком · урон ' + d + ', укрытие не спасает';
    case 'unlock_structure':
      return structUnlockText(r);
  }

  switch (r.effect_kind) {
    case 'hull':        return '+' + v + ' к прочности';
    case 'shield':      return '+' + v + ' к щитам всех секторов';
    case 'fore_shield': return '+' + v + ' к носовому щиту';
    case 'damage':      return '+' + v + ' к урону';
    case 'vision':      return '+' + v + ' к дальности обзора';
    case 'move':        return '+' + v + ' к дальности хода';
    case 'hangar':      return '+' + v + ' к местам в ангаре';
    case 'capacity':    return '+' + v + ' к вместимости трюма';
    case 'tractor':     return 'способность: удержание вражеского судна';
    default:            return '';
  }
}

function closeBuildingInfo() {
  document.getElementById('building-info-panel').style.display = 'none';
  var lease = document.getElementById('building-info-lease');
  if (lease && typeof plStopTick === 'function') plStopTick(lease);
}

// ===== Аренда производства =====
// Управляющий сдаёт казарму, завод техники или храм союзнику на срок.
// Пока аренда идёт, нанимает только арендатор. Кто кому что сдал —
// карта «здание → аренда» по этой планете (js/production-lease.js).

var gbLeaseMap = {};
var unitLeaseSeq = 0;

function gbLoadLeases() {
  if (typeof plSystemLeases !== 'function') return Promise.resolve(gbLeaseMap);
  return plSystemLeases(systemId).then(function(map) {
    gbLeaseMap = map || {};
    return gbLeaseMap;
  });
}

// Блок аренды в карточке постройки: сдать, отозвать, сколько осталось,
// а арендатору — вход в найм
function gbPaintBuildingLease(building, seq, captured) {
  var host = document.getElementById('building-info-lease');
  if (!host) return;
  var type = building.building_types || {};
  if (typeof plRenderBlock !== 'function' || !plLeasable(type.code)) {
    if (typeof plStopTick === 'function') plStopTick(host);
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }

  var ready = !building.completes_at || new Date(building.completes_at).getTime() <= Date.now();
  var demolishBtn = document.getElementById('building-info-demolish');

  var paint = function(row) {
    plRenderBlock(host, {
      systemId: systemId,
      buildingId: building.id,
      name: type.name || 'Постройка',
      image: type.image || null,
      planetName: plPlanetName(),
      lease: row,
      canOffer: isController && ready && !captured,
      onOpen: function() { closeBuildingInfo(); openUnitPanel(building); },
      onChanged: function() {
        gbLoadLeases().then(function() {
          if (seq === buildingInfoSeq && buildingInfoShown()) openBuildingInfo(building);
        });
      }
    });
    // Сданное или предложенное не сносится — сервер откажет, кнопку гасим заранее
    if (demolishBtn && isController) {
      var held = !!row && row.role === 'lessor';
      demolishBtn.disabled = held || buildingDemolishBusy;
      demolishBtn.title = held ? 'Сначала дождись конца аренды или отзови предложение' : '';
    }
  };

  // Сразу — по кэшу, затем свежий ответ сервера
  paint(plLeaseOf(gbLeaseMap, building.id));
  gbLoadLeases().then(function(map) {
    if (seq !== buildingInfoSeq || !buildingInfoShown()) return;
    paint(plLeaseOf(map, building.id));
  });
}

// Плашка аренды в окне найма и замок на кнопках у хозяина сданного
function gbPaintUnitLease(building) {
  var my = ++unitLeaseSeq;
  var panel = document.getElementById('unit-panel');
  var host = document.getElementById('unit-panel-lease');
  if (!host) {
    host = document.createElement('div');
    host.id = 'unit-panel-lease';
    var slot = document.getElementById('unit-panel-slot');
    if (slot && slot.parentNode) slot.parentNode.insertBefore(host, slot);
  }

  var type = building.building_types || {};
  var leasable = typeof plLeasable === 'function' && plLeasable(type.code);
  var ready = !building.completes_at || new Date(building.completes_at).getTime() <= Date.now();
  var captured = sysFaction && building.faction && building.faction !== sysFaction;

  var apply = function(row) {
    if (!leasable) row = null;
    unitPanelLeaseBlock = !!row && plIsLockedOwner(row);
    if (panel) panel.classList.toggle('pl-locked', unitPanelLeaseBlock);
    setUnitButtonsEnabled(unitSlotOn);

    var again = function() {
      if (my === unitLeaseSeq && unitPanelBuilding && unitPanelBuilding.id === building.id) {
        gbPaintUnitLease(building);
        if (typeof unitPanelMax !== 'undefined') renderProductionSlot(building, unitPanelMax);
      }
    };
    // Хозяин видит здесь и вход в аренду — в карточку постройки он попадает
    // только в режиме стройки
    plRenderBanner(host, row, {
      kind: 'building',
      canOffer: leasable && isController && ready && !captured,
      offer: { systemId: systemId, buildingId: building.id, name: type.name || 'Постройка',
               image: type.image || null, planetName: plPlanetName() },
      // Срок вышел: перечитываем, кто теперь хозяин линии
      onEnd: again,
      onChanged: again
    });
  };

  if (typeof plSystemLeases !== 'function') {
    unitPanelLeaseBlock = false;
    if (panel) panel.classList.remove('pl-locked');
    host.style.display = 'none';
    return;
  }

  apply(plLeaseOf(gbLeaseMap, building.id));
  gbLoadLeases().then(function(map) {
    if (my !== unitLeaseSeq) return;
    apply(plLeaseOf(map, building.id));
  });
}

function openBuildPanel(slotIndex) {
  var panel = document.getElementById('build-panel');
  var list = document.getElementById('build-panel-list');
  list.innerHTML = '';
  panel.classList.remove('struct-mode');
  var head = panel.querySelector('.build-panel-title');
  if (head) head.textContent = 'Выбери постройку';

  // Карточки решают по справочнику и по запасу планеты, можно ли здесь
  // строить. Оба приходят с сервера асинхронно, и раньше карточки
  // рисовались до их прихода: полоса запаса показывала правду, а под ней
  // добыча помечалась «нет такого сырья». Поэтому ждём оба ответа и только
  // потом рисуем. Запас обновляем при каждом открытии — решение, что
  // строить, принимается здесь, и цифры должны быть свежими.
  var namesReady = Object.keys(resourceNames).length > 0;
  var pending = namesReady ? 1 : 2;

  function ready() {
    pending--;
    if (pending > 0) return;
    renderStockStrip(slotIndex);
    renderBuildCards(slotIndex, panel, list);
  }

  if (!namesReady) loadResourceNames(ready);
  loadPlanetStock(ready);
}

function renderBuildCards(slotIndex, panel, list) {

  // Показываем только постройки своей фракции и только наземные —
  // космическая станция ставится на орбитальной карте.
  var available = buildingTypes.filter(function(t) {
    return t.faction === currentUserFaction && !t.is_space;
  });

  if (available.length === 0) {
    list.innerHTML = '<div class="build-panel-empty">Нет доступных построек</div>';
    panel.style.display = 'flex';
    return;
  }

  available.forEach(function(type) {
    var item = document.createElement('button');
    item.className = 'build-panel-item';
    item.setAttribute('data-code', type.code);

    var thumb = document.createElement('div');
    thumb.className = 'build-panel-thumb';
    if (type.image) {
      var im = document.createElement('img');
      im.src = '../' + type.image;
      im.alt = '';
      im.onerror = function() { thumb.textContent = type.icon || '■'; im.remove(); };
      thumb.appendChild(im);
    } else {
      thumb.textContent = type.icon || '■';
    }
    item.appendChild(thumb);

    var info = document.createElement('div');
    info.className = 'build-panel-info';

    var nameEl = document.createElement('div');
    nameEl.className = 'build-panel-name';
    nameEl.textContent = type.name;
    info.appendChild(nameEl);

    if (type.description) {
      var descEl = document.createElement('div');
      descEl.className = 'build-panel-desc';
      descEl.textContent = type.description;
      info.appendChild(descEl);
    }

    var costEl = document.createElement('div');
    costEl.className = 'build-panel-cost';
    costEl.textContent = type.cost + ' кр.';

    // Что постройка даёт планете
    if (type.produces_resource) {
      var rate = stockRateFor(type);
      var eats = consumesText(type.consumes);
      costEl.textContent += eats
        ? ' · ' + eats + ' → ' + resourceName(type.produces_resource) + ' ' + rate
        : ' · ' + resourceName(type.produces_resource) + ' ' + rate + ' в сутки';
    } else if (type.storage_bonus > 0) {
      costEl.textContent += ' · запас +' + type.storage_bonus;
    }
    info.appendChild(costEl);

    // Цена в ресурсах отдельной строкой: её платит склад планеты,
    // а не кошелёк, и нехватка видна сразу по красному
    var resCost = consumesText(type.cost_resources);
    if (resCost) {
      var rc = document.createElement('div');
      rc.className = 'build-panel-rescost' +
                     (canAffordResources(type.cost_resources) ? '' : ' short');
      rc.textContent = 'Со склада: ' + resCost;
      info.appendChild(rc);
    }

    item.appendChild(info);

    // Добывающую нельзя ставить там, где сырья нет. Сервер это отобьёт,
    // но честнее сказать заранее, чем после нажатия.
    var blocked = type.needs_local_resource && !planetHasResource(type.produces_resource);

    if (blocked) {
      item.classList.add('blocked');
      var why = document.createElement('div');
      why.className = 'build-panel-why';
      why.textContent = 'На этой планете нет такого сырья';
      info.appendChild(why);
    }

    item.addEventListener('click', function() {
      if (blocked) {
        alert('На этой планете нет такого сырья');
        return;
      }
      askConstructBuilding(slotIndex, type);
    });
    list.appendChild(item);
  });

  panel.style.display = 'flex';
}

function closeBuildPanel() {
  var panel = document.getElementById('build-panel');
  panel.style.display = 'none';
  panel.classList.remove('struct-mode');
}

// Строительство идёт через защищённую серверную функцию: она сама проверяет
// права контролёра, берёт цену из БД и списывает кредиты одной транзакцией —
// клиент не может подменить ни цену, ни права.
var constructBusy = false;   // запрос ушёл: второй тап по карточке не шлём

function constructBuilding(slotIndex, buildingTypeId) {
  if (constructBusy) return;
  constructBusy = true;
  supabase.rpc('construct_building', {
    p_system_id: systemId,
    p_slot_index: slotIndex,
    p_building_type_id: buildingTypeId
  }).then(function(res) {
    constructBusy = false;
    closeBuildPanel();
    if (res.error) {
      alert('Не удалось построить: ' + res.error.message);
      return;
    }
    loadBuildings();
  }, function(e) {
    constructBusy = false;
    alert('Не удалось построить: ' + ((e && e.message) || 'нет связи с сервером'));
  });
}

// ===== Подтверждение стройки и сноса =====
// Окно «Точно?» (js/game-confirm.js) показывает цену и возврат по тем же
// правилам, что на сервере: снос своего возвращает половину кредитов и
// половину сырья (укрепление — урезанную по прочности), а сырьё сверх
// вместимости склада пропадает. Окна нет (старая страница без скрипта) —
// действие идёт сразу, как раньше.

function gcReady() {
  return typeof gameConfirm === 'function';
}

function gcResColor(key) {
  var row = stockRow(key);
  return resourceColors[key] || (row && row.color) || null;
}

// «Спишется»: кредиты и сырьё со склада, нехватку подсвечиваем красным
function gcCostItems(credits, res) {
  var items = [];
  if (credits) items.push({ kind: 'credits', text: credits + ' кр.' });
  for (var k in (res || {})) {
    if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
    var need = Number(res[k]) || 0;
    if (!need) continue;
    var row = stockRow(k);
    items.push({
      text: resourceName(k) + ' ' + need,
      color: gcResColor(k),
      bad: planetStock.length > 0 && (!row || row.amount < need)
    });
  }
  return items;
}

// «Вернётся»: часть сырья, которая влезет на склад; остальное — зачёркнутым.
// Доля — дробью num/den и целочисленно, как на сервере (половина — 1/2,
// укрепление — hp / (2 * max_hp)). capDrop — на сколько упадёт предел
// склада после сноса (склады, хранилище): сервер кладёт сырьё уже после.
function gcRefund(credits, res, num, den, capDrop) {
  var out = { items: [], lost: [], unknown: false };
  if (credits) out.items.push({ kind: 'credits', text: '+' + credits + ' кр.' });
  // Склад видит только управляющий: без сведений не обещаем, что влезет
  var known = planetStock.length > 0;
  var cap0 = known ? Number(planetStock[0].cap) || 0 : 0;
  den = Math.max(1, den || 1);
  for (var k in (res || {})) {
    if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
    var amt = Math.floor((Number(res[k]) || 0) * (num || 0) / den);
    if (amt <= 0) continue;
    if (!known) {
      out.unknown = true;
      out.items.push({ text: resourceName(k) + ' до +' + amt, color: gcResColor(k) });
      continue;
    }
    var row = stockRow(k);
    var cap = Math.max(0, (row ? Number(row.cap) || cap0 : cap0) - (capDrop || 0));
    var fit = Math.max(0, Math.min(amt, cap - (row ? Number(row.amount) || 0 : 0)));
    if (fit > 0) out.items.push({ text: resourceName(k) + ' +' + fit, color: gcResColor(k) });
    if (fit < amt) {
      out.items.push({ text: resourceName(k) + ' ' + (amt - fit), lost: true });
      out.lost.push(resourceName(k).toLowerCase() + ' ' + (amt - fit));
    }
  }
  return out;
}

function gcLostWarn(r) {
  if (r.lost.length) return 'Склад полон: ' + r.lost.join(', ') + ' не поместится и пропадёт.';
  if (r.unknown) return 'Сырьё ляжет на склад планеты — что не поместится в предел, пропадёт.';
  return '';
}

// Достроенное здание или квартал, которые прибавляют к пределу склада
function gcCapWarn(drop) {
  return drop > 0 ? 'Предел склада планеты упадёт на ' + drop + '.' : '';
}

function gcJoin(a, b) {
  return a && b ? a + ' ' + b : (a || b || '');
}

function buildingTypeByCode(code) {
  for (var i = 0; i < buildingTypes.length; i++) {
    if (buildingTypes[i].code === code) return buildingTypes[i];
  }
  return null;
}

function askConstructBuilding(slotIndex, type) {
  if (!gcReady()) { constructBuilding(slotIndex, type.id); return; }
  if (constructBusy) return;
  var res = type.cost_resources || {};
  gameConfirm({
    tone: 'build',
    tag: type.code,
    kicker: 'Подтверди стройку',
    title: type.name,
    image: type.image ? '../' + type.image : null,
    sub: 'Участок ' + slotIndex,
    rows: [{ label: 'Спишется', items: gcCostItems(type.cost, res) }],
    note: 'Если потом снести — вернётся половина кредитов' +
          (Object.keys(res).length ? ' и сырья.' : '.'),
    ok: 'Построить'
  }, function() { constructBuilding(slotIndex, type.id); });
}

// Снос здания: склад перечитываем, чтобы честно сказать, что не влезет
function askDemolishBuilding(building, captured, go) {
  if (!gcReady()) { go(); return; }
  var bt = building.building_types || {};
  var full = buildingTypeByCode(bt.code) || {};
  var half = Math.floor((bt.cost || full.cost || 0) / 2);

  if (captured) {
    gameConfirm({
      tone: 'danger',
      kicker: 'Подтверди снос',
      title: bt.name || 'Постройка',
      image: bt.image ? '../' + bt.image : null,
      sub: 'Трофейная постройка · участок ' + building.slot_index,
      rows: [{ label: 'Спишется', items: [{ kind: 'credits', text: half + ' кр.' }] }],
      note: 'Расчистка чужой постройки платная. Вернуть её будет нельзя.',
      ok: 'Снести'
    }, go);
    return;
  }

  var seq = buildingInfoSeq;
  loadPlanetStock(function() {
    // Пока склад грузился, карточку закрыли или открыли другую — молчим
    if (seq !== buildingInfoSeq || !buildingInfoShown()) return;
    var done = !building.completes_at || new Date(building.completes_at).getTime() <= Date.now();
    var drop = done ? Number(full.storage_bonus) || 0 : 0;
    var r = gcRefund(half, full.cost_resources, 1, 2, drop);
    gameConfirm({
      tone: 'danger',
      kicker: 'Подтверди снос',
      title: bt.name || 'Постройка',
      image: bt.image ? '../' + bt.image : null,
      sub: 'Участок ' + building.slot_index,
      rows: [{ label: 'Вернётся', dir: 'in', items: r.items }],
      warn: gcJoin(gcCapWarn(drop), gcLostWarn(r)),
      note: 'Постройка исчезнет сразу — отменить снос нельзя.',
      ok: 'Снести'
    }, go);
  });
}

var buildingsLoaded = false;   // первый ответ пришёл: переход из ленты ждёт здания

// На чужой планете здания видны только в обзоре своих бойцов. Обзор
// меняется, когда бойцы ходят, — тогда и переспрашиваем, не чаще раза
// в 4 секунды. Своим это не нужно: им здания видны всегда.
var enemyBldAt = 0;
var enemyBldTimer = null;

function refreshEnemyBuildingsInSight() {
  if (!myFaction || !sysFaction || myFaction === sysFaction) return;
  if (enemyBldTimer) return;
  var wait = Math.max(0, 4000 - (Date.now() - enemyBldAt));
  enemyBldTimer = setTimeout(function() {
    enemyBldTimer = null;
    enemyBldAt = Date.now();
    loadBuildings();
  }, wait);
}

// Участки приходят из базы: их там проверяет сервер, а число открытых
// растёт с уровнем поселения (7 + 1 / 2 / 4 / 7). Пока ответа нет,
// карта рисует первые семь по старому генератору — они совпадают с базой.
function applyBuildSlots(rows) {
  if (!rows || !rows.length) return;
  var list = [];
  rows.forEach(function(r) {
    list[r.slot_index - 1] = {
      x: r.x, y: r.y, index: r.slot_index,
      need_level: r.need_level, need_name: r.need_name,
      locked: r.unlocked === false
    };
  });
  // Дыр в нумерации быть не должно, но на всякий случай берём только подряд
  var out = [];
  for (var i = 0; i < list.length && list[i]; i++) out.push(list[i]);
  buildSlots = out;
}

function loadBuildings() {
  // Участки и здания одним заходом: здание на участке 8–14 без координат
  // участка не нарисовать, а переход из ленты ждёт обоих.
  // Здания — через функцию, а не прямым запросом: чужим она отдаёт
  // completes_at пустым, и враг видит только то, что в обзоре его бойцов.
  Promise.all([
    supabase.rpc('get_building_slots', { p_system_id: systemId }),
    supabase.rpc('get_system_buildings', { p_system_id: systemId })
  ]).then(function(r) {
    if (!r[0].error && r[0].data) applyBuildSlots(r[0].data);
    var res = r[1];
    buildingsBySlot = {};
    if (!res.error && res.data) {
      res.data.forEach(function(b) {
        b.building_types = {
          name: b.type_name, code: b.type_code, icon: b.type_icon,
          image: b.type_image, cost: b.type_cost
        };
        buildingsBySlot[b.slot_index] = b;
      });
    }
    buildingsLoaded = true;
    redrawScene();
    updateRedrawTimer();
    if (window.sceneLoader) sceneLoader.mark('buildings');
  });
}

// Рельеф генерируется один раз и кэшируется: пересчитывать его на каждую
// перерисовку таймера — лишняя работа на 120x120 клеток.
// Рисуем синхронно. Через requestAnimationFrame нельзя: в предпросмотре
// SPCK панель создаётся скрытой, кадровые колбэки в ней не выполняются,
// и отрисовка не наступает вовсе — страница остаётся чёрной.
// Отложенная перерисовка для картинок. Каждое здание и юнит просят
// перерисовать карту, когда их файл догрузился: на чужой застроенной
// планете это семь-восемь полных отрисовок подряд. Собираем их в одну.
// Через setTimeout, а не requestAnimationFrame: кадровые колбэки не
// работают в скрытых панелях предпросмотра.
// Теперь кадр рисуется к ближайшему обновлению экрана: при сдвиге пальцем
// приходят десятки событий, а рисуем по одному разу на кадр. В скрытой
// панели предпросмотра кадровые колбэки не идут — там срабатывает таймер.
var redrawQueued = false;

function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  var done = false;
  var run = function() {
    if (done) return;
    done = true;
    redrawQueued = false;
    redrawSceneNow();
  };
  if (window.requestAnimationFrame) window.requestAnimationFrame(run);
  setTimeout(run, 50);
}

// Все просьбы перерисовать карту за один проход кода сливаются в одну
// (тем же setTimeout, что и для картинок). При входе на планету их
// приходит десяток подряд — рельеф, поселение, здания, укрепления,
// войска, захват, — и каждая заново красила всё поле 144×144. На
// телефоне эти серии и давали чёрные вспышки.
function redrawScene() {
  if (!ctx) return;
  scheduleRedraw();
}

function redrawSceneNow() {
  if (!ctx) return;
  if (!terrainCache) {
    terrainCache = generateTerrain(hashStringToSeed(systemId));
  }
  cbSyncFxLayer();
  drawScene(terrainCache);
  if (window.sceneLoader) sceneLoader.mark('terrain');
  if (typeof amOnRedraw === 'function') amOnRedraw();
}

// Пока на карте есть недостроенное здание, обновляем картинку раз в секунду,
// чтобы шёл обратный отсчёт. Достроилось всё — таймер выключаем.
function updateRedrawTimer() {
  var now = Date.now();
  var hasPending = Object.keys(buildingsBySlot).some(function(k) {
    var b = buildingsBySlot[k];
    return b.completes_at && new Date(b.completes_at).getTime() > now;
  });

  if (hasPending && !redrawTimer) {
    redrawTimer = setInterval(function() {
      redrawScene();
      var stillPending = Object.keys(buildingsBySlot).some(function(k) {
        var b = buildingsBySlot[k];
        return b.completes_at && new Date(b.completes_at).getTime() > Date.now();
      });
      if (!stillPending) {
        clearInterval(redrawTimer);
        redrawTimer = null;
        loadBuildings();
      }
    }, 1000);
  }
}

function checkBuildRights() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    currentUserId = res.data.session.user.id;

    return Promise.all([
      supabase.from('system_control').select('controller_user_id').eq('system_id', systemId).maybeSingle().then(function(controlRes) {
        isController = !controlRes.error && controlRes.data && controlRes.data.controller_user_id === currentUserId;
      }),
      supabase.rpc('get_my_profile').then(function(profRes) {
        if (!profRes.error && profRes.data && profRes.data.length > 0) {
          currentUserFaction = profRes.data[0].faction;
          // Цвет своей стороны для каталога исследований и кнопок науки
          document.body.classList.toggle('fac-cis', currentUserFaction === 'cis');
        }
      }),
      supabase.from('systems').select('faction').eq('id', systemId).maybeSingle().then(function(sysRes) {
        if (!sysRes.error && sysRes.data) systemFaction = sysRes.data.faction;
      })
    ]);
  });
}

// Пачка событий — одна перезагрузка. Автоход, залп или высадка двигают
// десяток бойцов одной транзакцией, и раньше каждое событие тянуло все
// войска планеты заново и перерисовывало карту. Теперь события за
// короткое окно сливаются в один запрос.
var gbSoonTimers = {};
function gbSoon(key, fn, ms) {
  if (gbSoonTimers[key]) return;
  gbSoonTimers[key] = setTimeout(function() {
    gbSoonTimers[key] = null;
    fn();
  }, ms);
}

// Realtime: любое изменение построек на этой планете — перерисовываем слоты у всех.
function subscribeToGroundChanges() {
  if (!systemId) return;
  supabase
    .channel('ground-' + systemId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'buildings', filter: 'system_id=eq.' + systemId }, function() {
      gbSoon('buildings', loadBuildings, 250);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'unit_positions', filter: 'system_id=eq.' + systemId }, function() {
      gbSoon('units', loadUnits, 150);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'field_structures', filter: 'system_id=eq.' + systemId }, function() {
      gbSoon('structures', loadStructures, 250);
    })
    .subscribe();
}

// На телефоне консоли нет, и любая ошибка выглядит одинаково — чёрный
// экран. Показываем её прямо на странице, чтобы было с чем работать.
function showFatal(text) {
  var box = document.getElementById('fatal-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fatal-box';
    box.style.cssText = 'position:fixed;left:8px;right:8px;top:60px;z-index:9999;' +
      'padding:12px;background:#2a1015;border:1px solid #d94a4a;border-radius:8px;' +
      'color:#ffb3b3;font-family:monospace;font-size:11px;line-height:1.5;' +
      'white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;';
    document.body.appendChild(box);
  }
  box.textContent = text;
}

window.addEventListener('error', function(e) {
  showFatal('Ошибка: ' + e.message + '\n' +
            (e.filename || '') + ':' + (e.lineno || '?'));
});

window.addEventListener('unhandledrejection', function(e) {
  showFatal('Запрос не прошёл: ' + ((e.reason && e.reason.message) || e.reason));
});

function initGroundBattle() {
  systemId = getSystemIdFromUrl();
  buildMode = isBuildMode();

  viewport = document.getElementById('ground-viewport');
  canvas = document.getElementById('ground-canvas');
  ctx = canvas ? canvas.getContext('2d') : null;

  if (!canvas) showFatal('В разметке нет <canvas id="ground-canvas">');

  // Клиент Supabase создаётся в supabase-client.js поверх библиотеки с CDN.
  // Если что-то из этого не загрузилось, в глобальной переменной остаётся
  // библиотека без .auth — и падает всё, что ходит в базу.
  if (typeof supabase === 'undefined' || !supabase.auth) {
    showFatal('Клиент Supabase не создан.\n\n' +
      'Не загрузилась библиотека с CDN или js/supabase-client.js. ' +
      'Проверь интернет в предпросмотре и перезапусти его.');
    return;
  }

  var backBtn = document.getElementById('ground-back-btn');
  backBtn.addEventListener('click', function() {
    window.location.href = 'galaxy-map.html';
  });

  var buildPanelClose = document.getElementById('build-panel-close');
  if (buildPanelClose) buildPanelClose.addEventListener('click', closeBuildPanel);

  var buildingInfoClose = document.getElementById('building-info-close');
  if (buildingInfoClose) buildingInfoClose.addEventListener('click', closeBuildingInfo);

  var unitPanelClose = document.getElementById('unit-panel-close');
  if (unitPanelClose) unitPanelClose.addEventListener('click', closeUnitPanel);

  // Вход проверяем с повтором: краткий сбой не выкидывает из игры
  sbSessionGate().then(function(res) {

    if (!systemId) {
      // Карта строится от сида системы: без ?system= в адресе строить
      // нечего. Раньше код молча выходил и оставлял чёрный экран.
      if (window.sceneLoader) sceneLoader.hide();
      showFatal('В адресе нет ?system=\n\n' +
        'Эту страницу открывают тапом по планете с карты галактики, ' +
        'а не напрямую. Сейчас адрес: ' + window.location.search);
      return;
    }

    if (window.sceneLoader) {
      sceneLoader.expect([['terrain', 'Местность'], ['settlement', 'Поселение'], ['buildings', 'Постройки'],
                          ['structures', 'Укрепления'], ['units', 'Войска']]);
    }

    var slotSeed = hashStringToSeed(systemId);
    buildSlots = generateBuildSlots(slotSeed);

    Promise.all([
      supabase.from('building_types').select('*').then(function(res2) {
        buildingTypes = res2.error ? [] : res2.data;
      }),
      checkBuildRights()
    ]).then(function() {
      // Одна отрисовка на загрузку, как было изначально: на 120x120
      // клетках каждая лишняя перерисовка ощутимо блокирует поток,
      // и карта начинает дёргаться под пальцем.
      loadDeployZones().then(function() {
        loadUnits();
      });
      loadStructureTypes().then(loadStructures);
      loadGroundSettings();
      loadGroundSides();
      loadScoutReport();
      // Опросы — только пока вкладка на экране; вернулся — сразу свежие
      setInterval(function() { if (!document.hidden) loadScoutReport(); }, 20000);
      syncGroundTime();
      loadSettlement();
      loadCaptureState();
      // Базу спрашиваем редко: строка меняется только при смене расклада.
      // Полосу перерисовываем локально раз в секунду.
      setInterval(function() { if (!document.hidden) loadCaptureState(); }, 60000);
      setInterval(function() { if (captureState) renderCaptureBar(); }, 1000);
      loadDropCargo();
      gbLoadLeases();
      gbDeepLink();

      var dropBtn = document.getElementById('drop-btn');
      if (dropBtn) dropBtn.addEventListener('click', openDropPanel);
      var rsClose = document.getElementById('research-close');
      if (rsClose) rsClose.addEventListener('click', closeResearchPanel);

      var stlClose = document.getElementById('settlement-close');
      if (stlClose) stlClose.addEventListener('click', closeSettlementPanel);

      var dropClose = document.getElementById('drop-panel-close');
      if (dropClose) dropClose.addEventListener('click', closeDropPanel);

      var logiClose = document.getElementById('logi-close');
      if (logiClose) logiClose.addEventListener('click', closeLogisticsPanel);

      var logiTabs = document.querySelectorAll('.logi-tab');
      for (var li = 0; li < logiTabs.length; li++) {
        (function(btn) {
          btn.addEventListener('click', function() {
            setLogiTab(btn.getAttribute('data-tab'));
          });
        })(logiTabs[li]);
      }

      initTreeGestures();
      loadBuildings();
      loadUnitOrders();
      setInterval(function() { if (!document.hidden) loadUnitOrders(); }, 5000);
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) return;
        loadUnitOrders();
        loadScoutReport();
        loadCaptureState();
        // Пока вкладка спала, реалтайм мог пропустить события
        gbSoon('units', loadUnits, 50);
        gbSoon('buildings', loadBuildings, 50);
        gbSoon('structures', loadStructures, 50);
      });
      centerGridInitially();
      initPanAndZoom();
      initBuildSwitcher();
      initBuildToggle(false);
      subscribeToGroundChanges();
      if (typeof amInit === 'function') amInit();
    });
  });
}

document.addEventListener('DOMContentLoaded', initGroundBattle);

// ===== Наём войск =====
// Характеристики берутся из справочника в БД и показываются как есть.
// Сервер при заказе всё равно перечитывает их сам, поэтому подменить
// цену или урон через клиент невозможно.

var unitPanelBuilding = null;
var unitPanelMax = 5;
var unitPanelTypes = [];

// Состояние производственной линии в окне найма: что делается, сколько
// осталось и можно ли ставить новый заказ. Раньше игрок узнавал о занятой
// линии только из отказа после нажатия.
var unitPanelTimer = null;

// Номер отрисовки: ответ, пришедший после более нового вызова, ничего
// не трогает — иначе таймер старой отрисовки мог потерять свой id и
// дёргать базу без конца
var unitPanelSeq = 0;
// Готовые заказы, которые уже просили выдать: застрявший (нет места в зоне
// высадки) дожидается тика сервера, а не повторных просьб
var claimedOrderKeys = {};

function renderProductionSlot(building, maxPerOrder) {
  var box = document.getElementById('unit-panel-slot');
  if (!box) return;

  var seq = ++unitPanelSeq;
  if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }

  supabase.rpc('get_building_queue', { p_building_id: building.id }).then(function(res) {
    if (seq !== unitPanelSeq) return;
    var q = (!res.error && res.data && res.data.length) ? res.data[0] : null;

    if (!q) {
      box.className = 'prod-slot free';
      box.innerHTML = '<div class="prod-slot-title">Линия свободна</div>' +
        '<div class="prod-slot-sub">За раз можно заказать до ' + maxPerOrder + '</div>';
      setUnitButtonsEnabled(true);
      if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }
      return;
    }

    box.className = 'prod-slot busy';
    setUnitButtonsEnabled(false);

    var draw = function(left) {
      var total = Math.max(1, q.seconds_left || 1);
      if (!draw.total) draw.total = total;
      var pct = Math.max(0, Math.min(100, (1 - left / draw.total) * 100));

      box.innerHTML =
        '<div class="prod-slot-title">' + escHtml(q.unit_name || 'Производство') +
          ' ×' + q.quantity + (q.mine ? '' : ' <em>чужой заказ</em>') + '</div>' +
        '<div class="prod-slot-track"><i style="width:' + pct + '%"></i></div>' +
        '<div class="prod-slot-sub">Готово через ' + formatLeft(left) + '</div>';
    };

    var left = q.seconds_left;
    if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }

    // Время вышло, а заказ ещё не выдан: просим выдать сразу и смотрим
    // снова через пару секунд. Раньше здесь висело «Готово через 0 с»
    // до тика сервера, а клиент дёргал базу каждую секунду.
    if (left <= 0) {
      draw(0);
      var sub = box.querySelector('.prod-slot-sub');
      if (sub) sub.textContent = q.mine ? 'Готово, выводим на поле…' : 'Готово, ждёт выдачи';
      var key = building.id + '|' + q.completes_at;
      var first = q.mine && !claimedOrderKeys[key];
      var again = function() {
        if (seq !== unitPanelSeq) return;
        if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }
        unitPanelTimer = setTimeout(function() {
          unitPanelTimer = null;
          var up = document.getElementById('unit-panel');
          if (seq === unitPanelSeq && up && up.style.display !== 'none' &&
              unitPanelBuilding && unitPanelBuilding.id === building.id) {
            renderProductionSlot(building, maxPerOrder);
          }
        }, first ? 2500 : 5000);
      };
      if (first) { claimedOrderKeys[key] = true; claimReadyNow().then(again); }
      else again();
      return;
    }

    draw(left);
    var tick = setInterval(function() {
      // Свой id держим при себе: общий unitPanelTimer мог уже смениться
      if (seq !== unitPanelSeq) { clearInterval(tick); return; }
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        if (unitPanelTimer === tick) unitPanelTimer = null;
        renderProductionSlot(building, maxPerOrder);
        return;
      }
      draw(left);
    }, 1000);
    unitPanelTimer = tick;
  });
}

function formatLeft(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec >= 3600) {
    var h = Math.floor(sec / 3600);
    var mm = Math.floor((sec % 3600) / 60);
    return h + ' ч' + (mm ? ' ' + mm + ' мин' : '');
  }
  if (sec >= 60) {
    var m = Math.floor(sec / 60);
    return m + ' мин ' + (sec % 60) + ' с';
  }
  return sec + ' с';
}

// Линия свободна (последний ответ очереди) и закрыт ли найм арендой
var unitSlotOn = true;
var unitPanelLeaseBlock = false;

function setUnitButtonsEnabled(on) {
  unitSlotOn = !!on;
  var panel = document.getElementById('unit-panel');
  if (!panel) return;
  var btns = panel.querySelectorAll('.unit-card-order, .unit-order-btn');
  for (var i = 0; i < btns.length; i++) {
    // Кнопку одарённого держит закрытой своя проверка, пока не ответит «можно»
    var gated = btns[i].getAttribute('data-gate');
    btns[i].disabled = !on || unitPanelLeaseBlock || (!!gated && gated !== 'ok');
  }
}

// Что изучено для пехоты: показываем только подходящее этому бойцу
var unitUpgradesDone = [];

function loadUnitUpgrades() {
  return supabase.rpc('get_researches').then(function(res) {
    if (!res.error && res.data) {
      unitUpgradesDone = res.data.filter(function(r) {
        return r.done && r.scope === 'unit';
      });
    }
  });
}

function openUnitPanel(building) {
  // Запас нужен для подсветки нехватки, справочник — для названий
  loadPlanetStock();
  loadResourceNames();
  unitPanelBuilding = building;
  var panel = document.getElementById('unit-panel');
  var list = document.getElementById('unit-panel-list');
  var title = document.getElementById('unit-panel-title');

  title.textContent = (building.building_types && building.building_types.name) || 'Производство';
  list.innerHTML = '<div class="unit-panel-empty">Загрузка...</div>';
  panel.style.display = 'flex';

  // Аренда: плашка над линией и замок на найме у хозяина сданного
  gbPaintUnitLease(building);

  var code = building.building_types && building.building_types.code;

  // Показываем занятость зон высадки: сервер всё равно откажет при нехватке,
  // но лучше предупредить заранее, чем ловить ошибку после нажатия.
  updateDeployCounter();

  // Предел партии задан типом постройки: казарма делает пятёрками,
  // завод техники — по одной машине
  loadUnitUpgrades();

  Promise.all([
    supabase.from('unit_types').select('*').eq('produced_by', code),
    supabase.from('building_types').select('max_per_order').eq('code', code).maybeSingle()
  ]).then(function(r) {
    var res = r[0];
    var maxPerOrder = (!r[1].error && r[1].data) ? (r[1].data.max_per_order || 5) : 5;
    unitPanelMax = maxPerOrder;

    renderProductionSlot(building, maxPerOrder);

    if (res.error || !res.data || res.data.length === 0) {
      // Здание без найма: линия производства ему не нужна вовсе
      closeUnitPanel();
      openEconomyPanel(building);
      return;
    }
    unitPanelTypes = res.data;
    list.innerHTML = '';

    // Если постройка готовит одарённых, над карточкой найма встаёт список
    // уже нанятых — живые с их счётом и павшие, которых храм помнит.
    var hasHero = res.data.some(function(u) { return u.is_hero; });
    if (hasHero) {
      var roster = document.createElement('div');
      roster.className = 'hero-roster';
      roster.innerHTML = '<div class="hero-roster-empty">Загрузка...</div>';
      list.appendChild(roster);
      loadHeroRoster(building, roster);
    }

    // Штаб не заменяет наём, а дополняет его: сводка разведки встаёт
    // над карточками офицеров и разведдроидов, ничего не вытесняя.
    if (code === 'rep_hq' || code === 'cis_control') {
      var intelBox = document.createElement('div');
      intelBox.className = 'intel-box';
      intelBox.innerHTML = '<div class="intel-head">Разведка</div>' +
                           '<div class="intel-empty">Загрузка...</div>';
      list.appendChild(intelBox);
      loadIntel(building, intelBox);
    }

    // Медцентр и ремцех штопают пехоту, заводы техники — машины.
    // Ремонт делит производственную линию с наймом, поэтому блок стоит
    // рядом с карточками, а не в отдельном окне.
    if (REPAIR_BUILDINGS[code]) {
      var repairBox = document.createElement('div');
      repairBox.className = 'rp-box';
      repairBox.innerHTML = '<div class="rp-empty">Загрузка...</div>';
      list.appendChild(repairBox);
      loadRepairList(building, repairBox);
    }

    res.data.forEach(function(unit) {
      list.appendChild(buildUnitCard(unit));
    });
  });
}

// Постройки, у которых есть ремонтное место, и что именно они чинят.
// Тот же список продублирован на сервере в repair_building_kind —
// клиент только рисует, решение принимает база.
var REPAIR_BUILDINGS = {
  rep_medical: 'infantry',
  cis_repair: 'infantry',
  rep_vehicle: 'vehicle',
  cis_vehicle: 'vehicle'
};

function loadRepairList(building, box) {
  var kind = REPAIR_BUILDINGS[(building.building_types || {}).code];
  var title = kind === 'vehicle' ? 'Ремонтный док' : 'Лазарет';

  supabase.rpc('get_repairable_units', { p_building_id: building.id }).then(function(res) {
    if (res.error) {
      box.innerHTML = '<div class="rp-empty">Не удалось прочитать список</div>';
      return;
    }

    var rows = res.data || [];
    box.innerHTML = '<div class="rp-head">' + title + '</div>';

    if (!rows.length) {
      var hint = document.createElement('div');
      hint.className = 'rp-empty';
      hint.textContent = kind === 'vehicle'
        ? 'Побитой техники в зонах высадки нет'
        : 'Раненых в зонах высадки нет';
      box.appendChild(hint);
      return;
    }

    rows.forEach(function(u) {
      var pct = u.full_hp ? Math.max(0, Math.min(100, u.hp / u.full_hp * 100)) : 100;

      var row = document.createElement('div');
      row.className = 'rp-row';
      row.innerHTML =
        '<div class="rp-face">' +
          ((u.portrait || u.image) ? '<img src="../' + (u.portrait || u.image) + '" alt="">' : '') +
        '</div>' +
        '<div class="rp-info">' +
          '<div class="rp-name">' + escHtml(u.hero_name || u.name) + '</div>' +
          '<div class="rp-hp">' +
            '<span>' + u.hp + ' / ' + u.full_hp + '</span>' +
            '<div class="rp-track"><i style="width:' + pct + '%"></i></div>' +
          '</div>' +
          '<div class="rp-sub">' + u.x + ':' + u.y + ' · ' + formatLeft(u.seconds) + '</div>' +
        '</div>';

      var btn = document.createElement('button');
      btn.className = 'rp-go';
      btn.innerHTML = 'Чинить<span>' + u.cost + '</span>';
      btn.addEventListener('click', function() {
        if (unitPanelLeaseBlock) return;
        btn.disabled = true;
        supabase.rpc('start_repair', {
          p_building_id: building.id,
          p_unit_id: u.unit_id
        }).then(function(r2) {
          btn.disabled = false;
          if (r2.error) { alert('Не вышло: ' + r2.error.message); return; }
          renderProductionSlot(building, unitPanelMax);
          loadRepairList(building, box);
          updateDeployCounter();
        });
      });

      row.appendChild(btn);
      box.appendChild(row);
    });
  });
}

// Список одарённых игрока. Он общий, а не привязан к планете: герой,
// нанятый на одной планете, виден в любом храме своей фракции.
function loadHeroRoster(building, box) {
  supabase.rpc('get_hero_roster', { p_building_id: building.id }).then(function(res) {
    if (res.error) {
      box.innerHTML = '<div class="hero-roster-empty">Не удалось прочитать список</div>';
      return;
    }

    var rows = res.data || [];
    if (!rows.length) {
      box.innerHTML = '<div class="hero-roster-empty">Одарённых пока нет</div>';
      return;
    }

    var live = rows.filter(function(h) { return !h.died_at; });
    var fallen = rows.filter(function(h) { return h.died_at; });

    box.innerHTML = '<div class="hero-roster-head">Одарённые · ' + live.length +
                    (fallen.length ? ' · павших ' + fallen.length : '') + '</div>';

    rows.forEach(function(h) {
      var row = document.createElement('div');
      row.className = 'hero-row' + (h.died_at ? ' fallen' : '');

      var where = h.died_at ? 'Пал на планете ' + (h.died_system_id || '—')
                : h.training_name ? 'Обучение: ' + h.training_name +
                                    ' · ' + formatLeft(h.training_left || 0)
                : (h.on_map ? 'В бою · ' + (h.system_id || '') : 'В пути');

      row.innerHTML =
        '<div class="hero-face"><img src="../' + h.portrait + '" alt=""></div>' +
        '<div class="hero-info">' +
          '<div class="hero-nick">' + escHtml(h.name) + '</div>' +
          '<div class="hero-where">' + where + '</div>' +
        '</div>' +
        '<div class="hero-kills">' + h.kills + '<span>убито</span></div>';

      // Переименовать можно только живого: павшего храм помнит под тем
      // именем, под которым он погиб.
      if (!h.died_at) {
        var rename = document.createElement('button');
        rename.className = 'hero-rename';
        rename.textContent = '✎';
        rename.title = 'Сменить кличку';
        rename.addEventListener('click', function() {
          var next = prompt('Новая кличка для ' + h.name, h.name);
          if (next === null) return;
          rename.disabled = true;
          supabase.rpc('rename_hero', { p_hero_id: h.hero_id, p_name: next.trim() })
            .then(function(r2) {
              rename.disabled = false;
              if (r2.error) { alert('Не вышло: ' + r2.error.message); return; }
              loadHeroRoster(building, box);
              loadUnits();
            });
        });
        row.appendChild(rename);
      }

      box.appendChild(row);
    });
  });
}

function buildUnitCard(unit) {
  var card = document.createElement('div');
  card.className = 'unit-card';
  card.setAttribute('data-unit', unit.id);

  var media = document.createElement('div');
  media.className = 'unit-card-media';
  // Пехота снята в полный рост (1:2) и встаёт в высокую рамку. Технику
  // снимали квадратом: в той же рамке она висела крошкой между чёрными
  // полосами. Для неё карточка раскладывается иначе — снимок широкой
  // полосой сверху. Решает настоящая пропорция файла, а не тип юнита:
  // артиллерия, например, снята как пехота, в рост.
  if (unit.is_vehicle && unit.image) card.classList.add('wide');
  if (unit.image) {
    // Широкий снимок показываем целиком, а пустые края полосы
    // закрывает размытая копия того же кадра
    var bg = document.createElement('img');
    bg.className = 'bg';
    bg.alt = '';
    bg.src = '../' + unit.image;
    media.appendChild(bg);

    var img = document.createElement('img');
    img.className = 'fg';
    img.alt = '';
    img.addEventListener('load', function() {
      if (!img.naturalHeight) return;
      card.classList.toggle('wide', img.naturalWidth / img.naturalHeight > 0.8);
    });
    img.src = '../' + unit.image;
    media.appendChild(img);
  }
  card.appendChild(media);

  var body = document.createElement('div');
  body.className = 'unit-card-body';

  var name = document.createElement('div');
  name.className = 'unit-card-name';
  name.textContent = unit.name;
  body.appendChild(name);

  if (unit.description) {
    var desc = document.createElement('div');
    desc.className = 'unit-card-desc';
    desc.textContent = unit.description;
    body.appendChild(desc);
  }

  var stats = document.createElement('div');
  stats.className = 'unit-card-stats';
  stats.appendChild(makeStat('❤', 'Прочность', unit.max_hp));
  stats.appendChild(makeStat('⚔', 'Урон', unit.damage));
  stats.appendChild(makeStat('➔', 'Манёвр', unit.move_range + ' кл.'));
  stats.appendChild(makeStat('◉', 'Обзор', unit.vision_range + ' кл.'));
  body.appendChild(stats);

  if (unit.splash_size > 0) {
    var arty = document.createElement('div');
    arty.className = 'unit-card-relay unit-card-arty';
    arty.textContent = '✹ Залп ' + unit.splash_size + '×' + unit.splash_size +
      ' через всю карту · ' + (unit.shot_ap || 2) + ' действия · откат ' +
      (unit.action_seconds || 30) + ' с';
    body.appendChild(arty);
  }

  if (unit.is_relay) {
    var relay = document.createElement('div');
    relay.className = 'unit-card-relay';
    relay.textContent = '⌖ Держит связь: делится обзором с союзниками';
    body.appendChild(relay);
  }

  // Ресурсы со склада планеты — отдельной строкой перед кнопкой найма
  var unitRes = consumesText(unit.cost_resources);
  if (unitRes) {
    var urc = document.createElement('div');
    urc.className = 'build-panel-rescost' +
                    (canAffordResources(unit.cost_resources) ? '' : ' short');
    urc.textContent = 'Со склада: ' + unitRes;
    body.appendChild(urc);
  }

  var footer = document.createElement('div');
  footer.className = 'unit-card-footer';

  // Одарённый нанимается поштучно и под собственной кличкой, поэтому
  // вместо счётчика количества у него поле имени. Кличку сервер проверит
  // ещё раз: длину и занятость среди живых героев игрока.
  var heroInput = null;
  var heroGate = null;
  var nameBox = null;

  if (unit.is_hero) {
    // Сначала спрашиваем сервер, можно ли вообще начать обряд (кредиты,
    // сырьё, занятая постройка, место в зоне высадки), и только потом
    // даём придумывать кличку — а не после ввода имени и выбора клетки.
    heroGate = document.createElement('div');
    heroGate.className = 'hero-gate wait';
    heroGate.textContent = 'Проверяем, можно ли начать обряд…';
    body.appendChild(heroGate);

    nameBox = document.createElement('div');
    nameBox.className = 'hero-name-box';
    nameBox.style.display = 'none';
    heroInput = document.createElement('input');
    heroInput.className = 'hero-name-input';
    heroInput.type = 'text';
    heroInput.maxLength = 24;
    heroInput.placeholder = 'Кличка';
    nameBox.appendChild(heroInput);
    var look = document.createElement('div');
    look.className = 'hero-name-note';
    look.textContent = 'Облик одарённому выпадет при обряде';
    nameBox.appendChild(look);
    body.appendChild(nameBox);
  }

  var qty = document.createElement('div');
  qty.className = 'unit-qty';
  var minus = document.createElement('button');
  minus.className = 'unit-qty-btn';
  minus.textContent = '−';
  var val = document.createElement('span');
  val.className = 'unit-qty-value';
  val.textContent = '1';
  var plus = document.createElement('button');
  plus.className = 'unit-qty-btn';
  plus.textContent = '+';
  minus.addEventListener('click', function() {
    var n = Math.max(1, parseInt(val.textContent, 10) - 1);
    val.textContent = n;
    updatePrice();
  });
  plus.addEventListener('click', function() {
    // Потолок задаёт постройка: 99 из воздуха сервер всё равно отвергнет
    var n = Math.min(unitPanelMax, parseInt(val.textContent, 10) + 1);
    val.textContent = n;
    updatePrice();
  });
  qty.appendChild(minus); qty.appendChild(val); qty.appendChild(plus);
  if (!unit.is_hero) footer.appendChild(qty);

  var order = document.createElement('button');
  order.className = 'unit-order-btn';
  if (unitPanelLeaseBlock) order.disabled = true;
  footer.appendChild(order);

  // Дополнения ставятся на каждого бойца и оплачиваются за каждого:
  // изучение даёт право, а не скидку на всю армию
  var chosen = {};

  var mine = unitUpgradesDone.filter(function(r) {
    return (r.applies_units || []).indexOf(unit.id) !== -1;
  });

  if (mine.length) {
    var box = document.createElement('div');
    box.className = 'unit-up';

    var head = document.createElement('div');
    head.className = 'unit-up-head';
    head.textContent = 'Дополнения · доступно ' + mine.length;
    box.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'unit-up-grid';

    mine.forEach(function(r) {
      var t = document.createElement('button');
      t.className = 'unit-up-tile';
      t.innerHTML = '<img src="../' + r.icon_image + '" alt="">';
      t.title = r.name + ' — ' + r.description;
      t.addEventListener('click', function() {
        if (chosen[r.id]) delete chosen[r.id]; else chosen[r.id] = r;
        t.classList.toggle('active', !!chosen[r.id]);
        updatePrice();
      });
      grid.appendChild(t);
    });

    box.appendChild(grid);

    var sub = document.createElement('div');
    sub.className = 'unit-up-sub';
    box.appendChild(sub);

    body.appendChild(box);
    var subEl = sub;
  }

  function upgradeCost() {
    var sum = 0;
    for (var k in chosen) sum += Math.floor(chosen[k].cost / 4);
    return sum;
  }

  function updatePrice() {
    var n = parseInt(val.textContent, 10);
    if (order.getAttribute('data-gate') !== 'bad') {
      order.textContent = 'Нанять · ' + ((unit.cost + upgradeCost()) * n);
    }

    var sub = body.querySelector('.unit-up-sub');
    if (sub) {
      var names = [];
      for (var k in chosen) names.push(chosen[k].name);
      sub.textContent = names.length
        ? names.join(', ') + ' · +' + upgradeCost() + ' на бойца'
        : 'Дополнения не выбраны';
    }
  }
  updatePrice();

  // Ответ проверки: можно — открываем поле клички, нельзя — пишем почему
  function applyHeroGate(reason) {
    if (!heroGate) return;
    if (reason) {
      heroGate.className = 'hero-gate bad';
      heroGate.style.display = '';
      heroGate.textContent = reason;
      nameBox.style.display = 'none';
      order.setAttribute('data-gate', 'bad');
      order.disabled = true;
      order.textContent = 'Обряд недоступен';
    } else {
      heroGate.className = 'hero-gate';
      heroGate.style.display = 'none';
      nameBox.style.display = '';
      order.setAttribute('data-gate', 'ok');
      // Храм сдан в аренду — у хозяина кнопка остаётся закрытой
      order.disabled = unitPanelLeaseBlock;
      updatePrice();
    }
  }

  function checkHeroGate(done) {
    var bld = unitPanelBuilding;
    stlSafe(supabase.rpc('hero_hire_check', { p_building_id: bld && bld.id })).then(function(r) {
      // Панель уже закрыли или открыли другую постройку — ответ не наш
      if (unitPanelBuilding !== bld || !document.body.contains(card)) return;
      // Старая база без проверки — ведём себя как раньше: поле сразу
      if (r.error && stlRpcMissing(r.error)) { applyHeroGate(null); if (done) done(null); return; }
      var reason = r.error ? ('Не удалось проверить: ' + r.error.message) : (r.data || null);
      applyHeroGate(reason);
      if (done) done(reason);
    });
  }

  if (unit.is_hero) {
    order.setAttribute('data-gate', 'wait');
    order.disabled = true;
    checkHeroGate();
  }

  order.addEventListener('click', function() {
    var n = parseInt(val.textContent, 10);

    if (unit.is_hero) {
      var nick = (heroInput.value || '').trim();
      if (nick.length < 2) {
        alert('Придумай кличку — хотя бы два символа');
        heroInput.focus();
        return;
      }
      // Пока придумывали кличку, могло что-то измениться — сверяемся ещё раз,
      // и только потом выбираем место на карте; заказ уходит после клетки.
      order.disabled = true;
      order.setAttribute('data-gate', 'wait');
      checkHeroGate(function(reason) {
        if (!reason) startPlacement(unit.id, 1, [], nick);
      });
      return;
    }

    startPlacement(unit.id, n, Object.keys(chosen));
  });

  body.appendChild(footer);
  card.appendChild(body);
  return card;
}

function makeStat(icon, label, value) {
  var el = document.createElement('div');
  el.className = 'unit-stat';
  el.innerHTML = '<span class="unit-stat-icon">' + icon + '</span>' +
                 '<span class="unit-stat-label">' + label + '</span>' +
                 '<span class="unit-stat-value">' + value + '</span>';
  return el;
}

function updateDeployCounter() {
  var el = document.getElementById('unit-panel-capacity');
  if (!el || !currentUserId) return;

  // Считаем реальные свободные клетки зон высадки за вычетом ещё не
  // прибывших заказов — по тому же правилу сервер решает, примет ли заказ.
  // Бойцы, ушедшие из зоны вперёд или сидящие в трюмах, место не занимают.
  supabase.rpc('get_deploy_space', { p_system_id: systemId }).then(function(res) {
    var row = (!res.error && res.data && res.data.length) ? res.data[0] : null;
    if (!row) { el.textContent = ''; return; }

    el.textContent = 'Свободно в зонах высадки: ' + row.free + ' из ' + row.total +
      (row.queued > 0 ? ' · ещё ' + row.queued + ' в заказах' : '');
    el.className = row.free === 0 ? 'unit-panel-capacity full' : 'unit-panel-capacity';
  });
}

function closeUnitPanel() {
  document.getElementById('unit-panel').style.display = 'none';
  unitLeaseSeq++;
  var leaseHost = document.getElementById('unit-panel-lease');
  if (leaseHost && typeof plStopTick === 'function') plStopTick(leaseHost);
  // Отсчёт линии нужен только открытому окну: при следующем открытии
  // renderProductionSlot запустит его заново
  unitPanelSeq++;
  if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }
}

// Полоса текущих заказов внизу экрана — своя очередь видна только владельцу,
// политика в БД чужим её не отдаёт.
function loadUnitOrders() {
  supabase.from('unit_orders').select('*, unit_types(name)')
    .eq('system_id', systemId).eq('delivered', false)
    .then(function(res) {
      var bar = document.getElementById('order-queue');
      if (!bar) return;
      if (res.error || !res.data || res.data.length === 0) {
        bar.style.display = 'none';
        return;
      }
      bar.innerHTML = '';
      bar.style.display = 'flex';
      var due = false;
      res.data.forEach(function(o) {
        var left = Math.max(0, Math.ceil((new Date(o.completes_at).getTime() - Date.now()) / 1000));
        // Просим выдать один раз на заказ: если он застрял, ждёт тика
        if (left <= 0 && !claimedOrderKeys['o|' + o.id]) {
          claimedOrderKeys['o|' + o.id] = true;
          due = true;
        }
        var item = document.createElement('div');
        item.className = 'order-chip';
        item.textContent = (o.unit_types ? o.unit_types.name : o.unit_type) +
                           ' ×' + o.quantity + ' · ' + (left > 0 ? left + 'с' : 'готово');
        bar.appendChild(item);
      });
      // Срок вышел — просим выдать сразу, не дожидаясь тика сервера
      if (due) claimReadyNow().then(function(sent) { if (sent) { loadUnitOrders(); loadUnits(); } });
    });
}

// ===== Юниты на карте и выбор места при заказе =====

var unitsOnMap = [];
var unitTypeById = {};
var unitImages = {};   // путь -> Image

function getUnitImage(path) {
  if (!path) return null;
  if (unitImages[path]) return unitImages[path];
  var img = new Image();
  img.src = '../' + path;
  img.onload = function() { scheduleRedraw(); };
  img.onerror = function() { img.failed = true; };
  unitImages[path] = img;
  return img;
}
var placingOrder = null;   // {unitId, quantity} — ждём выбор клетки

// Ответы приходят не по порядку: реалтайм и ручная перезагрузка часто
// летят одновременно. Старый ответ поверх нового откатил бы карту назад
// и показал бы ложное «лечение» в сводке.
var loadUnitsSeq = 0;
var loadUnitsApplied = 0;
// Справочник типов не меняется по ходу боя: раньше он целиком приходил
// заново на каждое движение любого бойца. Берём один раз и перечитываем,
// только если на карте появился неизвестный тип.
var unitTypesFresh = false;

function loadUnits() {
  var seq = ++loadUnitsSeq;
  var requestedAt = Date.now();
  Promise.all([
    supabase.from('unit_positions').select('*').eq('system_id', systemId).eq('layer', 'ground'),
    unitTypesFresh ? Promise.resolve(null) : supabase.from('unit_types').select('*')
  ]).then(function(r) {
    // Применяем только ответ свежее уже показанного. Ждать именно
    // последний нельзя: при частых обновлениях карта не обновилась бы вовсе.
    if (seq <= loadUnitsApplied) return;
    // Неудачный запрос не стирает карту: иначе следующая загрузка
    // показала бы прочность всех бойцов как «новую»
    if (r[0].error || !r[0].data) return;
    loadUnitsApplied = seq;
    var prevUnits = unitsOnMap;
    unitsOnMap = r[0].data;

    var inside = {};
    unitsOnMap.forEach(function(u) {
      if (u.carrier_unit_id) inside[u.carrier_unit_id] = (inside[u.carrier_unit_id] || 0) + 1;
    });
    unitsOnMap.forEach(function(u) { u.passengers = inside[u.id] || 0; });
    if (r[1] && !r[1].error && r[1].data && r[1].data.length) {
      unitTypeById = {};
      r[1].data.forEach(function(t) { unitTypeById[t.id] = t; });
      unitTypesFresh = true;
    }
    if (unitsOnMap.some(function(u) { return !unitTypeById[u.unit_type]; })) unitTypesFresh = false;
    // Сначала карточка разведки берёт свежий экземпляр бойца, потом
    // рисуем: иначе рамки дальности отстают на одно обновление
    cbRefreshIntel();
    redrawScene();
    refreshEnemyBuildingsInSight();
    // Бойцы сдвинулись — обзор поменялся
    gbSoon('vision', loadVision, 120);
    if (window.sceneLoader) sceneLoader.mark('units');
    cbDiffUnits(prevUnits, unitsOnMap, requestedAt);
    gbOverwatchShots(prevUnits, unitsOnMap);
    gbOverwatchRefresh(prevUnits);
    cbReconcileHp(requestedAt);
    if (typeof amAfterUnits === 'function') amAfterUnits();
  });
}

// Юнит занимает одну клетку. Свои — зелёные, союзные — синие,
// вражеские — красные: туман войны в БД пропускает только тех, кого видно.
// Габариты юнита в клетках: пехота 1x1, AT-TE и канонерка 2x2
function unitBox(u) {
  var t = unitTypeById[u.unit_type];
  return { w: (t && t.width_cells) || 1, h: (t && t.height_cells) || 1 };
}

// Дальность хода с улучшениями — так же, как unit_stats на сервере
function unitMoveRange(u) {
  var t = unitTypeById[u.unit_type] || {};
  return Math.max(1, (t.move_range || 0) + (u.bonus_move || 0));
}

// Кличку одарённого придумывает игрок, а видят её и союзники, и враги.
// Всё, что от игрока, перед вставкой в разметку обязано пройти здесь,
// иначе чужое имя со скобками выполнится в чужом браузере.
function escHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Карта занятых клеток с учётом корпуса: техника 2x2 закрывает четыре
// клетки, а не одну. Считать по одной верхней левой клетке нельзя —
// сервер в is_ground_box_free проверяет пересечение прямоугольников,
// и подсветка обещала бы место, которого нет.
function buildOccupancy(ignoreUnitId) {
  var map = {};
  unitsOnMap.forEach(function(u) {
    if (u.x === null || u.x === undefined) return;
    if (ignoreUnitId && u.id === ignoreUnitId) return;
    var b = unitBox(u);
    for (var dx = 0; dx < b.w; dx++) {
      for (var dy = 0; dy < b.h; dy++) {
        map[(u.x + dx) + ':' + (u.y + dy)] = true;
      }
    }
  });
  return map;
}

// Влезает ли прямоугольник w×h в клетку x,y: и по краям карты, и по соседям
function isBoxFree(occupied, x, y, w, h) {
  if (x < 0 || y < 0 || x + w > GRID_SIZE || y + h > GRID_SIZE) return false;
  for (var dx = 0; dx < w; dx++) {
    for (var dy = 0; dy < h; dy++) {
      if (occupied[(x + dx) + ':' + (y + dy)]) return false;
    }
  }
  return true;
}

function drawUnits() {
  unitsOnMap.forEach(function(u) {
    // Перевозимые на карте не стоят — они внутри транспорта или в трюме
    if (u.x === null || u.x === undefined) return;

    var size = unitBox(u);
    var px = u.x * CELL_PX;
    var py = u.y * CELL_PX;
    var mine = u.owner_user_id === currentUserId;
    // Свои зелёные, союзники синие, враги красные: сквозь туман враг
    // приходит только в обзоре, и спутать его с союзником нельзя
    var color = mine ? '#5fd968'
      : (!myFaction || u.faction === myFaction) ? '#4a90d9' : '#d94a4a';
    var type = unitTypeById[u.unit_type];
    // У одарённого своё лицо, закреплённое при найме. У остальных — картинка типа.
    var img = type ? getUnitImage(u.portrait || type.image) : null;

    var inset = 2;
    var boxW = CELL_PX * size.w - inset * 2;
    var boxH = CELL_PX * size.h - inset * 2;

    ctx.fillStyle = 'rgba(5,6,10,0.85)';
    ctx.fillRect(px + inset, py + inset, boxW, boxH);

    if (img && img.complete && !img.failed && img.naturalWidth > 0) {
      // Кадр вырезается самим источником — обрезка холстом не нужна
      var cr = gbUnitCrop(img, type);
      gbDrawSprite(img, cr[0], cr[1], cr[2], cr[3], px + inset, py + inset, boxW, boxH);
    } else {
      ctx.fillStyle = color;
      ctx.font = Math.round(CELL_PX * 0.5) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⛊', px + boxW / 2 + inset, py + boxH / 2 + inset);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + inset, py + inset, boxW, boxH);

    // Боец в окопе или бункере: сама постройка скрыта под ним, поэтому
    // укрытие отмечаем щитком в углу, а маскировку — пунктиром внутри
    var shelter = fieldStructures.length ? unitShelter(u) : null;
    if (shelter) drawShelterMark(shelter, px + inset, py + inset, boxW, boxH);

    // На чеку (свои и союзники): оранжевый значок в углу
    if (u.overwatch && (mine || (myFaction && u.faction === myFaction))) {
      drawOverwatchMark(px + inset, py + inset, boxW);
    }

    // Подчинённый чужой воле: рамка обведена вторым контуром,
    // чтобы своих временных бойцов было видно с одного взгляда
    if (u.control_until) {
      ctx.strokeStyle = '#a34ad9';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(px + inset - 3, py + inset - 3, boxW + 6, boxH + 6);
      ctx.setLineDash([]);
    }

    // Сколько десанта в транспорте — цифрой прямо на карте
    if (mine && type && type.carry_slots > 0 && u.passengers) {
      ctx.fillStyle = '#d9a940';
      ctx.font = 'bold ' + Math.round(CELL_PX * 0.42) + 'px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(u.passengers, px + boxW, py + boxH + inset);
    }
  });

  // Радиус обзора выбранного юнита показываем кругом — так видно,
  // сколько клеток он реально просматривает.
  // Карта клеточная, поэтому дальности считаем в клетках: зона —
  // квадрат вокруг юнита, а не круг. Обзор зелёным, ход синим.
  if (selectedUnit) {
    var t = unitTypeById[selectedUnit.unit_type];
    if (t && selectedUnit.owner_user_id === currentUserId) {
      // На чеку: сначала залитая зона огня, поверх — обычные рамки
      var owLive = guLiveUnit(selectedUnit);
      if (owLive.overwatch && typeof owReachUnit === 'function') {
        drawOverwatchZone(owLive, owReachUnit(owLive, t));
      }
      drawCellRange(selectedUnit, t.vision_range, 'rgba(95,217,104,0.55)');
      drawCellRange(selectedUnit, unitMoveRange(selectedUnit), 'rgba(74,144,217,0.55)');
    } else if (t) {
      // Чужой: куда достаёт его ствол и что он видит. Паспортные значения,
      // без улучшений — их мы знать не должны.
      if (t.weapon_range && t.weapon_range < GRID_SIZE) {
        drawCellRange(selectedUnit, t.weapon_range,
          cbUnitSide(selectedUnit) === 'enemy' ? 'rgba(217,74,74,0.7)' : 'rgba(74,144,217,0.6)');
      }
      drawCellRange(selectedUnit, t.vision_range, 'rgba(217,169,64,0.45)');
    }
  }
}

// ===== На чеку (js/overwatch.js) =====

// Значок в левом верхнем углу бойца: кружок с прицелом
function drawOverwatchMark(x, y, boxW) {
  var r = Math.max(5, Math.min(9, boxW * 0.16));
  var cx = x + r + 1, cy = y + r + 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,13,20,0.92)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#e8923a';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = '#e8923a';
  ctx.fill();
}

// Зона огня: клетки, до которых боец и видит, и достаёт (как box_gap
// на сервере — от краёв корпуса, а не от угла)
function drawOverwatchZone(unit, reach) {
  if (!reach) return;
  var b = unitBox(unit);
  var x0 = (unit.x - reach) * CELL_PX;
  var y0 = (unit.y - reach) * CELL_PX;
  var w = (b.w + reach * 2) * CELL_PX;
  var h = (b.h + reach * 2) * CELL_PX;
  ctx.fillStyle = 'rgba(232,146,58,0.08)';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = 'rgba(232,146,58,0.85)';
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 5]);
  ctx.strokeRect(x0, y0, w, h);
  ctx.setLineDash([]);
}

function gbSetOverwatch(unit, on) {
  if (!unit || typeof owSet !== 'function') return;
  owSet('ground', [unit.id], on, function(err) {
    if (err) { alert('Не вышло: ' + err); return; }
    // Сразу показываем новое состояние, не дожидаясь перезагрузки карты
    unitsOnMap.forEach(function(x) { if (x.id === unit.id) x.overwatch = !!on; });
    unit.overwatch = !!on;
    cbFloatOnUnit(guLiveUnit(unit), on ? 'на чеку' : 'отбой', on ? 'ow' : 'miss');
    // Включение сняло автоход — отметки автохода перечитываем
    if (on && typeof amLoadSoon === 'function') amLoadSoon(200);
    guPickedAbility = null;
    if (selectedUnit && selectedUnit.id === unit.id) {
      selectedUnit = guLiveUnit(unit);
      offerPickup(selectedUnit);
    }
    redrawScene();
    loadUnits();
  });
}

// Строка «На чеку» под очками действий открытой панели своего бойца
function gbOverwatchStrip(bar, unit) {
  if (!bar) return;
  var old = document.getElementById('ow-strip');
  var type = unitTypeById[unit.unit_type];
  if (!unit.overwatch || typeof owStripHtml !== 'function' || !type) {
    if (old) old.parentNode.removeChild(old);
    return;
  }
  var strip = old;
  if (!strip) {
    var apRow = bar.querySelector('.gu-ap-row');
    if (!apRow) return;
    strip = document.createElement('div');
    strip.id = 'ow-strip';
    strip.className = 'ow-strip';
    apRow.parentNode.insertBefore(strip, apRow.nextSibling);
  }
  strip.innerHTML = owStripHtml(owReachUnit(unit, type));
  var off = strip.querySelector('[data-ow="off"]');
  if (off) off.addEventListener('click', function() {
    off.disabled = true;
    gbSetOverwatch(guLiveUnit(unit), false);
  });
}

// Свежая карта: у кого сменилась отметка выстрела на чеку — рисуем трассер
function gbOverwatchShots(prev, next) {
  if (!prev || !prev.length || typeof owNewShot !== 'function') return;
  var before = {};
  prev.forEach(function(u) { before[u.id] = u; });
  var layer = null;
  next.forEach(function(u) {
    var p = before[u.id];
    if (!p || !owNewShot(p, u) || u.x === null || u.x === undefined) return;
    var t = null;
    for (var i = 0; i < next.length && !t; i++) if (next[i].id === u.ow_target) t = next[i];
    if (!t) t = before[u.ow_target];     // цель могла погибнуть этим выстрелом
    if (!t || t.x === null || t.x === undefined) return;
    if (!layer) layer = cbEnsureFxLayer();
    var a = unitBox(u), b = unitBox(t);
    owTracer(layer, (u.x + a.w / 2) * CELL_PX, (u.y + a.h / 2) * CELL_PX,
             (t.x + b.w / 2) * CELL_PX, (t.y + b.h / 2) * CELL_PX, !!u.ow_hit);
    if (!u.ow_hit) cbFloatOnUnit(t, 'мимо', 'miss', 250);
  });
}

// Режим снялся или включился на сервере (ручной приказ, другой экран) —
// открытая панель бойца должна это показать
function gbOverwatchRefresh(prev) {
  if (!selectedUnit || selectedUnit.owner_user_id !== currentUserId) return;
  var bar = document.getElementById('pickup-bar');
  if (!bar || bar.style.visibility === 'hidden' || !bar.querySelector('#gu-dots')) return;
  if (bar.getAttribute('data-intel') || bar.getAttribute('data-struct')) return;
  var fresh = guLiveUnit(selectedUnit);
  var old = null;
  (prev || []).forEach(function(u) { if (u.id === fresh.id) old = u; });
  if (old && !!old.overwatch === !!fresh.overwatch) return;
  // Выбранный боец — свежий экземпляр: зона огня рисуется по нему
  selectedUnit = fresh;
  redrawScene();
  var had = !!document.getElementById('ow-strip');
  gbOverwatchStrip(bar, fresh);
  var tile = bar.querySelector('.gu-tile[data-key="watch"]');
  if (tile) tile.classList.toggle('ow-on', !!fresh.overwatch);
  if (tile && tile.classList.contains('active') && typeof tile._guPick === 'function') tile._guPick();
  if (had !== !!document.getElementById('ow-strip')) setBottomInset(insetFor(bar));
}

// Какой кусок картинки бойца показывать на клетке: [sx, sy, sw, sh].
// Исходник вытянутый 1:2, а клетка квадратная. Берём из кадра квадратный
// кусок с головой и торсом — так юнит узнаётся даже на иконке в 32 пикселя,
// и фигура не сплющивается. У техники кадр квадратный и весь по делу.
function gbUnitCrop(img, type) {
  if (type && type.is_vehicle && img.naturalHeight > img.naturalWidth * 1.2) {
    // Высокая машина (артиллерия) снята в полный рост, как пехота:
    // файл не режем, а на клетке показываем квадрат по корпусу
    var w = img.naturalWidth;
    return [0, Math.max(0, Math.min(img.naturalHeight - w, img.naturalHeight * 0.55 - w / 2)), w, w];
  }
  if (type && type.is_vehicle) return [0, 0, img.naturalWidth, img.naturalHeight];
  var sw = img.naturalWidth * 0.70;
  return [(img.naturalWidth - sw) / 2, img.naturalHeight * 0.07, sw, sw];
}

function drawCellRange(unit, range, color) {
  if (!range) return;
  var x0 = (unit.x - range) * CELL_PX;
  var y0 = (unit.y - range) * CELL_PX;
  var side = (range * 2 + 1) * CELL_PX;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(x0, y0, side, side);
  ctx.setLineDash([]);
}

var selectedUnit = null;

// ===== Высадка десанта =====
// Отдельный режим от placingOrder: тот ставит только что нанятых юнитов
// в свои зоны, а этот выгружает из трюма в полосу вторжения.
var droppingUnit = null;   // {shipId, unitType, name}
var dropCargo = [];        // ответ get_drop_ready_cargo

// ===== Погрузка обратно на борт =====
// Какие корабли могут принять этого юнита, решает сервер: он проверяет
// и площадку сброса, и полосу вторжения, и свободное место в трюме.
// Клиент только показывает результат.
function offerPickup(unit) {
  if (unit.owner_user_id !== currentUserId) { showUnitIntel(unit); return; }

  var type = unitTypeById[unit.unit_type] || {};

  Promise.all([
    supabase.rpc('get_pickup_ready_ships', { p_unit_id: unit.id }),
    type.is_vehicle ? Promise.resolve({ data: [] })
                    : supabase.rpc('get_carriers_nearby', { p_unit_id: unit.id }),
    type.carry_slots > 0
      ? supabase.rpc('get_carried_units', { p_carrier_unit_id: unit.id, p_ship_id: null })
      : Promise.resolve({ data: [] }),
    // Игрок обычно тапает транспорт, а не бойца. Показываем и обратный
    // список: кого можно посадить в эту канонерку.
    type.carry_slots > 0
      ? supabase.rpc('get_boardable_units', { p_carrier_id: unit.id })
      : Promise.resolve({ data: [] }),
    supabase.rpc('unit_ap_state', { p_unit_id: unit.id }),
    // Носители со свободным ангаром — только для истребителей,
    // остальным вернётся пустой список
    supabase.rpc('get_lift_carriers', { p_unit_id: unit.id })
  ]).then(function(r) {
    if (!selectedUnit || selectedUnit.id !== unit.id) return;

    var ships = (!r[0].error && r[0].data) ? r[0].data : [];
    var carriers = (!r[1].error && r[1].data) ? r[1].data : [];
    var inside = (!r[2].error && r[2].data) ? r[2].data : [];
    var boardable = (!r[3].error && r[3].data) ? r[3].data : [];
    var ap = (!r[4].error && r[4].data && r[4].data.length) ? r[4].data[0] : null;
    var lifts = (!r[5].error && r[5].data) ? r[5].data : [];

    showPickup(unit, ships, carriers, inside, boardable, ap, lifts);
  });
}

// HUD наземного юнита. Устроен как панель корабля: шапка с названием
// и состоянием, полосы прочности, точки очков действий и кнопки внизу.
// Разворота нет — у наземных нет носа и щитовых секторов.
// HUD наземного юнита. Слева портрет с характеристиками, справа вкладки:
// снаряжение, способности, описание. Разделы взаимоисключающие — иначе
// панель разрастается и закрывает карту, на которую надо тыкать.

var guTab = 'abilities';      // какая вкладка открыта
var guAbilities = [];
var guPickedAbility = null;

function showPickup(unit, ships, carriers, inside, boardable, ap, liftCarriers) {
  liftCarriers = liftCarriers || [];
  var bar = document.getElementById('pickup-bar');
  if (!bar) return;
  bar.removeAttribute('data-struct');
  bar.removeAttribute('data-side');
  bar.removeAttribute('data-intel');

  ships = ships || [];
  carriers = carriers || [];
  inside = inside || [];
  boardable = boardable || [];

  var type = unitTypeById[unit.unit_type] || {};
  var hpMax = (type.max_hp || unit.hp) + (unit.bonus_hp || 0);
  var hpPct = hpMax ? Math.max(0, Math.min(100, unit.hp / hpMax * 100)) : 100;

  // Одарённый: в шапке стоит его кличка, а название типа уходит в строку роли.
  // Вкладка убитых есть только у него, поэтому при переходе на обычного бойца
  // её надо снять, иначе останется пустая панель без единой активной вкладки.
  var isHero = !!unit.hero_id;
  if (guTab === 'kills' && !isHero) guTab = 'abilities';

  var portrait = unit.portrait || type.image;
  var title = isHero ? (unit.hero_name || type.name) : (type.name || unit.unit_type);

  var role = type.is_vehicle
    ? (type.carry_slots > 0 ? 'Техника / Транспорт' : 'Техника')
    : (type.carry_slots > 0 ? 'Пехота / Поддержка' : 'Пехота');

  if (isHero) role = type.name || 'Одарённый';

  // Укрытие и маскировка видны прямо в строке роли
  var shelter = shelterText(unitShelter(unit));
  if (shelter) role += ' · ' + shelter;

  // Временно наш: показываем, сколько осталось до возврата хозяину
  if (unit.control_until) {
    var left = Math.max(0, Math.round(
      (new Date(unit.control_until).getTime() - Date.now()) / 1000));
    role = 'Подчинён · ' + formatLeft(left);
  }

  bar.innerHTML =
    '<div class="gu-top">' +
      '<div class="gu-portrait' + (isHero ? ' hero' : '') + (type.is_vehicle ? ' veh' : '') + '">' +
        (portrait ? '<img src="../' + portrait + '" alt="">' : '') +
      '</div>' +
      '<div class="gu-stats">' +
        '<div class="gu-name">' + escHtml(title) + '</div>' +
        '<div class="gu-role">' + role + ' · ' + unit.x + ':' + unit.y + '</div>' +
        '<div class="gu-hp">' +
          '<span class="gu-hp-num">' + unit.hp + ' / ' + hpMax + '</span>' +
          '<div class="gu-hp-track"><i style="width:' + hpPct + '%"></i></div>' +
        '</div>' +
        '<div class="gu-props">' +
          '<span title="урон">◎ ' + (type.damage || 0) + '</span>' +
          '<span title="дальность">➶ ' + (type.weapon_range >= GRID_SIZE ? 'вся карта' : (type.weapon_range || 0)) + '</span>' +
          '<span title="ход">⇢ ' + (type.move_range || 0) + '</span>' +
          '<span title="обзор">◈ ' + (type.vision_range || 0) + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="gu-close" id="gu-close">✕</button>' +
    '</div>' +

    '<div class="gu-ap-row">' +
      '<div class="gu-dots" id="gu-dots"></div>' +
      '<div class="gu-ap-text" id="gu-ap-text"></div>' +
    '</div>' +

    '<div class="gu-tabs">' +
      '<button class="gu-tab" data-tab="gear">Снаряжение</button>' +
      '<button class="gu-tab" data-tab="abilities">Способности</button>' +
      (isHero ? '<button class="gu-tab" data-tab="kills">Убитые</button>' : '') +
      '<button class="gu-tab" data-tab="info">Описание</button>' +
    '</div>' +
    '<div class="gu-panel" id="gu-panel"></div>';

  // Очки действий рисуем сразу и дальше обновляем тикером
  guPaintAp(ap, type);

  var tabs = bar.querySelectorAll('.gu-tab');
  for (var i = 0; i < tabs.length; i++) {
    (function(btn) {
      btn.classList.toggle('active', btn.dataset.tab === guTab);
      btn.addEventListener('click', function() {
        guTab = btn.dataset.tab;
        guPickedAbility = null;
        showPickup(unit, ships, carriers, inside, boardable, ap, liftCarriers);
      });
    })(tabs[i]);
  }

  var panel = document.getElementById('gu-panel');

  if (guTab === 'gear') {
    panel.innerHTML = '<div class="gu-empty">Снаряжение появится позже</div>';
  } else if (guTab === 'kills') {
    guRenderKills(panel, unit);
  } else if (guTab === 'info') {
    panel.innerHTML = '<div class="gu-desc">' +
      (type.description || 'Описание пока не заполнено') + '</div>';
  } else {
    guRenderAbilities(panel, unit, type, ap, ships, carriers, inside, boardable, liftCarriers);
  }

  var closeBtn = document.getElementById('gu-close');
  if (closeBtn) closeBtn.addEventListener('click', function() {
    selectedUnit = null; hidePickup(); redrawScene();
  });

  // Идёт автоход — строка состояния и «Стоп» под очками действий
  if (typeof amPanelStrip === 'function') amPanelStrip(bar, unit);
  // На чеку — своя строка с кнопкой «Снять»
  gbOverwatchStrip(bar, unit);

  bar.style.visibility = 'visible';
  setBottomInset(insetFor(bar));
  focusCell(unit.x, unit.y);

  startApTicker(unit);
}

function guPaintAp(ap, type) {
  var dots = document.getElementById('gu-dots');
  var text = document.getElementById('gu-ap-text');
  if (!dots || !text || !ap) return;

  var html = '';
  for (var i = 0; i < ap.ap_max; i++) {
    html += '<i class="gu-dot' + (i < ap.ap ? ' on' : '') + '"></i>';
  }
  dots.innerHTML = html;
  text.textContent = ap.ap >= ap.ap_max ? 'действия готовы' : '+1 через ' + ap.next_in + ' с';
}

// Кого именно убил этот одарённый. Список нужен не для похвальбы:
// на нём позже будет строиться прокачка способностей в храме.
function guRenderKills(panel, unit) {
  panel.innerHTML = '<div class="gu-empty">Загрузка...</div>';

  supabase.rpc('get_hero_kills', { p_hero_id: unit.hero_id }).then(function(res) {
    if (!selectedUnit || selectedUnit.id !== unit.id) return;

    if (res.error) {
      panel.innerHTML = '<div class="gu-empty">Не удалось прочитать список</div>';
      return;
    }

    var rows = res.data || [];
    if (!rows.length) {
      panel.innerHTML = '<div class="gu-empty">Счёт пока не открыт</div>';
      return;
    }

    var total = 0;
    rows.forEach(function(k) { total += k.kills; });

    var html = '<div class="hk-total">Всего убито: ' + total + '</div><div class="hk-list">';

    rows.forEach(function(k) {
      html += '<div class="hk-row">' +
        '<div class="hk-face">' +
          (k.victim_image ? '<img src="../' + k.victim_image + '" alt="">' : '') +
        '</div>' +
        '<div class="hk-name">' + k.victim_name + '</div>' +
        '<div class="hk-count">×' + k.kills + '</div>' +
      '</div>';
    });

    panel.innerHTML = html + '</div>';
  });
}

// Плитки способностей: слева сетка, справа описание выбранной — как
// в пошаговых тактиках, где важно понять действие до того, как жать
function guRenderAbilities(panel, unit, type, ap, ships, carriers, inside, boardable, lifts) {
  panel.innerHTML = '<div class="gu-abils"><div class="gu-tiles" id="gu-tiles"></div>' +
    '<div class="gu-abil-info" id="gu-abil-info"></div></div>' +
    '<div class="gu-rows" id="gu-rows"></div>';

  // У одарённого сверху своя кнопка: древо развития открывается
  // отдельным полотном, в тесной панели его не разглядеть.
  if (unit.hero_id) {
    var tree = document.createElement('button');
    tree.className = 'gu-tree-btn';
    tree.textContent = 'Древо развития';
    tree.addEventListener('click', function() { openHeroTree(unit); });
    panel.insertBefore(tree, panel.firstChild);
  }

  var tiles = document.getElementById('gu-tiles');
  var info = document.getElementById('gu-abil-info');
  // Доступность считаем в момент нажатия, а не при открытии панели
  var canAct = function(need) { return guApNow(unit, ap) >= (need || 1); };

  // readyAt — отметка конца отката (мс); тикер по ней сам снимет заглушку
  var addTile = function(key, icon, label, ready, onPick, image, readyAt) {
    var b = document.createElement('button');
    b.className = 'gu-tile' + (guPickedAbility === key ? ' active' : '') +
                  (ready ? '' : ' locked');
    b.setAttribute('data-key', key);
    if (readyAt) b.setAttribute('data-ready-at', String(readyAt));
    // У веток есть своя картинка, у базовых действий — знак
    b.innerHTML = (image
        ? '<img class="gu-tile-img" src="../' + image + '" alt="">'
        : '<span class="gu-tile-icon">' + icon + '</span>') +
      '<span class="gu-tile-label">' + label + '</span>';
    b._guPick = function() {
      if (!selectedUnit || selectedUnit.id !== unit.id) return;
      guPickedAbility = key;
      onPick();
    };
    b.addEventListener('click', function() {
      var all = tiles.querySelectorAll('.gu-tile');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === b);
      b._guPick();
    });
    tiles.appendChild(b);
    return b;
  };

  // Ход и атака — базовые действия, они есть у всех
  addTile('move', '⇢', 'Идти', canAct(), function() {
    info.innerHTML = '<div class="gu-abil-name">Перемещение</div>' +
      '<div class="gu-abil-text">До ' + unitMoveRange(unit) + ' клеток за одно действие.</div>' +
      '<div class="gu-abil-meta">быстрее: зажми бойца на карте и веди — отпусти на клетке или на враге</div>';
    guAbilityAction(info, 'Идти', canAct(), function() { startGroundMove(guLiveUnit(unit)); });
  });

  // Разведчик уходит на соседнюю планету сам, без командира
  if (type.is_scout) {
    addTile('scout', '➶', 'Разведка', canAct(), function() {
      info.innerHTML =
        '<div class="gu-abil-name">Перелёт на соседнюю планету</div>' +
        '<div class="gu-abil-text">Уходит по нити на связанную планету. ' +
        'К своим прибывает в зону высадки, к чужим — в полосу вторжения. ' +
        'Отправлять можно только со стороны десанта.</div>';
      guScoutDestinations(info, unit);
    });
  }

  // Инженер: полевые постройки. Каталог открывается отдельным окном —
  // в тесной панели десять карточек с ценами не разглядеть
  if (type.can_build) {
    addTile('build', '⚒', 'Строить', canAct(), function() {
      var ownPlanet = sysFaction && myFaction && sysFaction === myFaction;
      info.innerHTML = '<div class="gu-abil-name">Полевые постройки</div>' +
        '<div class="gu-abil-text">Окопы, бункеры, турели, радары, глушилки, добыча и кантина. ' +
        'Ставит в ' + structBuildRange + ' клетках от себя, стоит одно действие. ' +
        'Всё, кроме окопа, сначала изучают в ' +
        (myFaction === 'cis' ? 'лаборатории' : 'научном центре') + '.</div>' +
        (ownPlanet ? '' : '<div class="gu-abil-meta warn">строить можно только на планетах своей фракции</div>');
      guAbilityAction(info, 'Выбрать постройку', canAct() && ownPlanet, function() { openStructureBuildPanel(guLiveUnit(unit)); });
    });
  }

  if (type.splash_size > 0) {
    // Артиллерия: только залп по площади, и на него уходят все действия
    var need = type.shot_ap || 2;
    var salvo = addTile('salvo', '✹', 'Залп', canAct(need), function() {
      var canFire = canAct(need);
      info.innerHTML = '<div class="gu-abil-name">Залп</div>' +
        '<div class="gu-abil-text">Бьёт по площади ' + type.splash_size + '×' + type.splash_size +
        ' в любую точку карты, которую видят твои войска. Снаряд не разбирает своих и чужих, ' +
        'авиацию не достаёт.</div>' +
        '<div class="gu-abil-meta">стоит ' + need + ' действия · действие восстанавливается ' +
        (type.action_seconds || gbApCd) + ' с</div>' +
        (canFire ? '' : '<div class="gu-abil-meta warn">нужно ' + need + ' действия</div>');
      guAbilityAction(info, 'Выбрать точку', canFire, function() { startArtilleryStrike(guLiveUnit(unit)); });
    });
    salvo.setAttribute('data-need', need);
  } else {
    // Атака — это сразу выбор цели: нажал плитку, ткнул во врага.
    // Промежуточная кнопка «Выбрать цель» остаётся только когда бить
    // пока нечем — чтобы объяснить, почему.
    var attackTile = addTile('attack', '◎', 'Атака', canAct(), function() {
      info.innerHTML = '<div class="gu-abil-name">Атака</div>' +
        '<div class="gu-abil-text">Урон зависит от класса цели: ' +
        'пехота плохо берёт броню, техника плохо достаёт авиацию.</div>' +
        (canAct() ? '' : '<div class="gu-abil-meta warn">нет действий — подожди восстановления</div>');
      guAbilityAction(info, 'Выбрать цель', canAct(), function() { startGroundAttack(guLiveUnit(unit)); });
    });
    attackTile.addEventListener('click', function() {
      if (!canAct()) return;
      // Подсветку снимаем: тикер не должен вернуть «Атаку» выбранной
      guPickedAbility = null;
      attackTile.classList.remove('active');
      startGroundAttack(guLiveUnit(unit));
    });
  }

  // На чеку: сам стреляет по ближайшему врагу, как только готово действие.
  // Артиллерии и безоружным плитки нет — им стрелять прицельно нечем
  if (typeof owInfoHtml === 'function' && !owArmedReason(type, false)) {
    var owTile = addTile('watch', '◉', 'На чеку', true, function() {
      var live = guLiveUnit(unit);
      var on = !!live.overwatch;
      info.innerHTML = owInfoHtml(on, owReachUnit(live, type), null, 'gu');
      guAbilityAction(info, on ? 'Снять с чеку' : 'Встать на чеку', true, function() {
        gbSetOverwatch(guLiveUnit(unit), !on);
      });
      var owGo = info.querySelector('.gu-abil-go');
      if (owGo) { owGo.classList.add('ow-go'); owGo.classList.toggle('off', on); }
    });
    // Действия режиму не нужны — тикер очков не должен его гасить
    owTile.setAttribute('data-need', '0');
    owTile.classList.toggle('ow-on', !!unit.overwatch);
  }

  // Автоход: сам идёт к дальней точке, шагая по мере очков действий
  if (typeof amAddTile === 'function') amAddTile(addTile, info, unit, type);

  // Способности из дополнений: приходят с сервера вместе с откатом
  supabase.rpc('get_unit_upgrade_abilities', { p_unit_id: unit.id }).then(function(res) {
    if (!selectedUnit || selectedUnit.id !== unit.id || guTab !== 'abilities') return;

    (res.error ? [] : (res.data || [])).forEach(function(a) {
      var readyAt = a.ready ? 0 : Date.now() + (a.seconds_left || 0) * 1000;
      addTile(a.research_id, null, a.name, a.ready && canAct(), function() {
        var left = readyAt ? guLeftSec(readyAt) : 0;
        info.innerHTML =
          '<div class="gu-abil-name">' + a.name + '</div>' +
          '<div class="gu-abil-text">' + (a.description || '') + '</div>' +
          '<div class="gu-abil-meta">' + upgradeAbilityHint(a) + '</div>' +
          (left > 0 ?
            '<div class="gu-abil-meta warn">не готова: ' + formatLeft(left) + '</div>' : '');

        guAbilityAction(info, isAreaAbility(a.kind) ? 'Выбрать клетку' : 'Выбрать цель',
                        left <= 0 && canAct(), function() {
          startUpgradeAbility(guLiveUnit(unit), a);
        });
      }, a.icon_image, readyAt);
    });
    guRefreshTiles(guApNow(unit, ap));
  });

  // Собственные способности приходят с сервера вместе с откатом
  supabase.rpc('get_unit_abilities', { p_unit_id: unit.id }).then(function(res) {
    if (!selectedUnit || selectedUnit.id !== unit.id || guTab !== 'abilities') return;

    guAbilities = (!res.error && res.data) ? res.data : [];

    guAbilities.forEach(function(a) {
      var readyAt = a.ready ? 0 : Date.now() + (a.seconds_left || 0) * 1000;
      addTile(a.ability_id, a.icon, a.name, a.ready && canAct(), function() {
        var left = readyAt ? guLeftSec(readyAt) : 0;
        info.innerHTML =
          '<div class="gu-abil-name">' + a.name + '</div>' +
          '<div class="gu-abil-text">' + (a.description || '') + '</div>' +
          '<div class="gu-abil-meta">◷ откат ' + Math.round(a.cooldown_seconds / 60) + ' мин</div>' +
          (left > 0 ?
            '<div class="gu-abil-meta warn">не готова: ' + formatLeft(left) + '</div>' : '');

        guAbilityAction(info, 'Выбрать цель', left <= 0 && canAct(), function() {
          startAbilityTargeting(guLiveUnit(unit), a);
        });
      }, null, readyAt);
    });
    guRefreshTiles(guApNow(unit, ap));
  });

  // Боевые способности из древа: приходят с сервера вместе с откатом
  if (unit.hero_id) {
    supabase.rpc('get_hero_ability_list', { p_unit_id: unit.id }).then(function(res) {
      if (!selectedUnit || selectedUnit.id !== unit.id || guTab !== 'abilities') return;

      (res.error ? [] : (res.data || [])).forEach(function(a) {
        var readyAt = a.ready ? 0 : Date.now() + (a.seconds_left || 0) * 1000;

        var heroTile = addTile(a.ability_id, null, a.name, a.implemented && a.ready && canAct(), function() {
          var left = readyAt ? guLeftSec(readyAt) : 0;
          var usable = a.implemented && left <= 0 && canAct();
          info.innerHTML =
            '<div class="gu-abil-name">' + a.name + '</div>' +
            '<div class="gu-abil-text">' + (a.description || '') + '</div>' +
            '<div class="gu-abil-meta">' +
              (a.target_mode === 'ally' ? 'на своего'
               : a.target_mode === 'self' ? 'вокруг себя'
               : a.target_mode === 'area' ? 'по площади' : 'на врага') +
              ' · до ' + a.range_cells + ' кл · откат ' +
              Math.round(a.cooldown_seconds / 60) + ' мин</div>' +
            (a.implemented ? '' :
              '<div class="gu-abil-meta warn">пока не действует в бою</div>') +
            (left <= 0 || !a.implemented ? '' :
              '<div class="gu-abil-meta warn">не готова: ' + formatLeft(left) + '</div>');

          guAbilityAction(info,
            a.target_mode === 'self' ? 'Применить'
            : a.target_mode === 'area' ? 'Выбрать клетку' : 'Выбрать цель',
            usable, function() { startHeroAbility(guLiveUnit(unit), a); });
        }, a.icon, readyAt);
        // Ещё не действует в бою — заглушку не снимаем никогда
        if (!a.implemented) heroTile.setAttribute('data-need', '99');
      });
      guRefreshTiles(guApNow(unit, ap));
    });
  }

  // Погрузка и посадка остаются списком снизу: это не способности,
  // а перемещение между техникой и кораблями
  var rows = document.getElementById('gu-rows');

  var addRow = function(text, note, cls, onClick) {
    var b = document.createElement('button');
    b.className = 'gu-row' + (cls ? ' ' + cls : '');
    b.innerHTML = '<span>' + text + '</span><em>' + note + '</em>';
    if (onClick) b.addEventListener('click', function() { onClick(b); });
    else b.disabled = true;
    rows.appendChild(b);
  };

  if (type.is_vehicle && lifts.length) {
    lifts.forEach(function(c) {
      addRow('В ангар ' + c.carrier_name, 'мест ' + c.free_slots, 'ship', function(btn) {
        btn.disabled = true;
        supabase.rpc('lift_fighter', { p_unit_id: unit.id, p_carrier_id: c.carrier_id })
          .then(function(r) {
            if (r.error) { alert('Не удалось поднять: ' + r.error.message); btn.disabled = false; return; }
            selectedUnit = null; hidePickup(); loadUnits(); loadDropCargo();
          });
      });
    });
  }

  boardable.forEach(function(b) {
    addRow('Посадить ' + b.unit_name + ' <b>' + b.x + ':' + b.y + '</b>',
           'мест ' + b.slots, 'board', function(btn) {
      btn.disabled = true;
      supabase.rpc('board_carrier', { p_unit_id: b.unit_id, p_carrier_id: unit.id })
        .then(function(r) {
          if (r.error) { alert('Не удалось посадить: ' + r.error.message); btn.disabled = false; return; }
          loadUnits(); offerPickup(unit);
        });
    });
  });

  inside.forEach(function(p) {
    addRow(p.unit_name, 'высадить', 'inside', function() { startDisembark(unit, p); });
  });

  carriers.forEach(function(c) {
    addRow('В ' + c.carrier_name + ' <b>' + c.x + ':' + c.y + '</b>',
           'мест ' + c.free_slots, 'board', function(btn) {
      btn.disabled = true;
      supabase.rpc('board_carrier', { p_unit_id: unit.id, p_carrier_id: c.carrier_id })
        .then(function(r) {
          if (r.error) { alert('Не удалось посадить: ' + r.error.message); btn.disabled = false; return; }
          selectedUnit = null; hidePickup(); loadUnits();
        });
    });
  });

  ships.forEach(function(sh) {
    addRow('На ' + sh.ship_name + ' <b>' + sh.x + ':' + sh.y + '</b>',
           'свободно ' + sh.free_slots, 'ship', function(btn) {
      btn.disabled = true;
      var rpc = type.is_vehicle ? 'load_vehicle_to_ship' : 'load_unit_from_ground';
      supabase.rpc(rpc, { p_unit_id: unit.id, p_ship_id: sh.ship_id }).then(function(r) {
        if (r.error) { alert('Не удалось: ' + r.error.message); btn.disabled = false; return; }
        selectedUnit = null; hidePickup(); loadUnits(); loadDropCargo();
      });
    });
  });
}

// Куда можно улететь: список считает сервер по нитям
function guScoutDestinations(info, unit) {
  var loading = document.createElement('div');
  loading.className = 'gu-abil-meta';
  loading.textContent = 'Ищем маршруты…';
  info.appendChild(loading);

  supabase.rpc('get_scout_destinations', { p_unit_id: unit.id }).then(function(res) {
    if (!selectedUnit || selectedUnit.id !== unit.id) return;

    loading.remove();

    if (res.error) {
      var err = document.createElement('div');
      err.className = 'gu-abil-meta warn';
      err.textContent = res.error.message;
      info.appendChild(err);
      return;
    }

    var list = res.data || [];

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'gu-abil-meta';
      empty.textContent = 'Связанных планет нет';
      info.appendChild(empty);
      return;
    }

    list.forEach(function(d) {
      var b = document.createElement('button');
      b.className = 'gu-row ' + (d.friendly ? 'board' : 'ship');
      b.innerHTML = '<span>' + d.name + '</span><em>' +
        (d.friendly ? 'своя' : 'чужая') + ' · ' + d.seconds + ' с</em>';

      b.addEventListener('click', function() {
        b.disabled = true;
        supabase.rpc('start_scout_move', {
          p_unit_id: unit.id, p_target_system: d.system_id
        }).then(function(r) {
          if (r.error) { alert(r.error.message); b.disabled = false; return; }
          alert('Разведчик в пути: ' + r.data + ' с');
          selectedUnit = null;
          hidePickup();
          loadUnits();
        });
      });

      info.appendChild(b);
    });
  });
}

function guAbilityAction(info, label, enabled, onGo) {
  var go = document.createElement('button');
  go.className = 'gu-abil-go';
  go.textContent = label;
  go.disabled = !enabled;
  go.addEventListener('click', onGo);
  info.appendChild(go);
}

// ===== Атака и способности с выбором цели на карте =====
// Цель выбирается пальцем: в свалке одинаковых юнитов список бесполезен.

var upgradeAbility = null;      // выбранная способность из ветки
var attackingUnit = null;
var abilityUnit = null;
var abilityDef = null;
var groundTargets = [];

function startGroundAttack(unit) {
  attackingUnit = unit;
  abilityUnit = null;
  hidePickup();

  Promise.all([
    supabase.rpc('get_ground_targets', { p_unit_id: unit.id }),
    supabase.rpc('get_structure_targets', { p_unit_id: unit.id })
  ]).then(function(r) {
    var res = r[0];
    groundTargets = (!res.error && res.data) ? res.data : [];
    groundStructTargets = (!r[1].error && r[1].data) ? r[1].data : [];
    var n = groundTargets.length + groundStructTargets.length;
    showTargetHint('Ткни в цель', n ? n + ' в радиусе' : 'в радиусе никого', cancelTargeting);
    redrawScene();
  });
}

// Площадные бьют по клетке, прицельные по бойцу — от этого зависит,
// что подсвечивать и что отправлять на сервер
function isAreaAbility(kind) {
  return kind === 'ability_grenade' || kind === 'ability_he'
      || kind === 'ability_suppression';
}

// ===== Артиллерийский залп =====
// Наводится как граната, в два касания: первое ставит прицел, второе —
// «Огонь». Центр прицела — точка касания, область видна до выстрела.
var artilleryUnit = null;

function startArtilleryStrike(unit) {
  cancelTargeting();
  artilleryUnit = unit;
  hidePickup();
  showTargetHint('Залп', 'ткни в точку, которую видят твои войска', cancelTargeting);
  redrawScene();
}

function handleArtilleryTap(cellX, cellY) {
  var type = unitTypeById[artilleryUnit.unit_type] || {};
  var size = type.splash_size || 3;
  var half = Math.floor(size / 2);
  areaPreview = { x: cellX - half, y: cellY - half, size: size, cx: cellX, cy: cellY };

  var hit = countInBox(areaPreview, artilleryUnit);
  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>Залп · ' + size + '×' + size + ' · врагов ' + hit.enemy +
                   (hit.own ? ' · <b class="warn-own">своих ' + hit.own + '</b>' : '') +
                   (hit.air ? ' · авиация ' + hit.air + ' не заденет' : '') +
                   '</span>' +
                   '<button id="area-go">Огонь</button>' +
                   '<button id="area-cancel">Отмена</button>';
  hint.style.display = 'flex';

  document.getElementById('area-cancel').addEventListener('click', cancelTargeting);
  document.getElementById('area-go').addEventListener('click', function() {
    var go = document.getElementById('area-go');
    go.disabled = true;
    var gun = artilleryUnit;
    cbLastOwnAction = Date.now();
    supabase.rpc('artillery_strike', {
      p_unit_id: gun.id, p_x: areaPreview.cx, p_y: areaPreview.cy
    }).then(function(r) {
      if (r.error) { go.disabled = false; alert(r.error.message); return; }
      var res = (r.data && r.data.length) ? r.data[0] : null;
      if (res) cbReportArea('Залп артиллерии', gun, res);
      cancelTargeting();
      selectedUnit = null;
      loadUnits();
    });
  });

  setBottomInset(insetFor(hint));
  redrawScene();
}

// Кого накроет залп: юнит попадает, если хоть одной клеткой в области.
// Авиацию считаем отдельно — снаряд её не берёт.
function countInBox(area, self) {
  var res = { enemy: 0, own: 0, air: 0 };
  if (!area) return res;

  unitsOnMap.forEach(function(u) {
    if (u.x === null || u.x === undefined) return;
    if (self && u.id === self.id) return;
    var t = unitTypeById[u.unit_type] || {};
    var w = t.width_cells || 1, h = t.height_cells || 1;
    if (u.x < area.x + area.size && u.x + w > area.x &&
        u.y < area.y + area.size && u.y + h > area.y) {
      if (t.hull_class === 'air') res.air++;
      else if (u.faction === myFaction) res.own++;
      else res.enemy++;
    }
  });
  return res;
}

function upgradeAbilityHint(a) {
  switch (a.kind) {
    case 'ability_grenade':     return 'область ' + a.power + '×' + a.power;
    case 'ability_he':          return 'область ' + a.power + '×' + a.power + ', только пехота';
    case 'ability_suppression': return 'область ' + a.power + '×' + a.power + ' и залегание';
    case 'ability_stun':        return a.power >= 100 ? 'оглушает наверняка'
                                                      : 'шанс оглушить ' + a.power + '%';
    case 'ability_ap':          return 'двойной урон по технике';
    case 'ability_headshot':    return 'уничтожает цель';
    case 'ability_twin':        return 'вторая цель с шансом ' + a.power + '%';
    case 'ability_lunge':       return 'рывок до ' + a.power + ' кл. · урон ' + (a.ability_damage || '');
    default:                    return '';
  }
}

var areaPreview = null;      // намеченная область до подтверждения
var twinFirst = null;        // первая цель спаренного выстрела

// Область показываем до броска: игрок должен видеть, кого зацепит
function showAreaConfirm(a) {
  var hint = document.getElementById('placement-hint');
  var hit = countInArea(areaPreview, upgradeAbility.unit);

  hint.innerHTML = '<span>' + a.name + ' · ' + a.power + '×' + a.power +
                   ' · врагов ' + hit.enemy +
                   (hit.own ? ' · <b class="warn-own">своих ' + hit.own + '</b>' : '') +
                   '</span>' +
                   '<button id="area-go">Применить</button>' +
                   '<button id="area-cancel">Отмена</button>';
  hint.style.display = 'flex';

  document.getElementById('area-cancel').addEventListener('click', cancelTargeting);
  document.getElementById('area-go').addEventListener('click', function() {
    var u = upgradeAbility.unit;
    cbLastOwnAction = Date.now();
    supabase.rpc('use_unit_ability', {
      p_unit_id: u.id, p_research_id: a.research_id,
      p_x: areaPreview.x, p_y: areaPreview.y
    }).then(function(r) {
      if (r.error) { alert(r.error.message); return; }
      var res = (r.data && r.data.length) ? r.data[0] : null;
      if (res) cbReportArea(a.name, u, res);
      cancelTargeting();
      selectedUnit = null;
      loadUnits();
    });
  });

  setBottomInset(insetFor(hint));
}

// Кто попадёт под удар: взрыв не разбирает своих и чужих, поэтому
// считаем обе стороны отдельно — игрок должен видеть цену броска
function countInArea(area, self) {
  var res = { enemy: 0, own: 0 };
  if (!area) return res;

  unitsOnMap.forEach(function(u) {
    if (u.x === null || u.x === undefined) return;
    if (self && u.id === self.id) return;
    if (u.x >= area.x && u.x < area.x + area.size &&
        u.y >= area.y && u.y < area.y + area.size) {
      if (u.faction === myFaction) res.own++; else res.enemy++;
    }
  });
  return res;
}

function startUpgradeAbility(unit, a) {
  areaPreview = null;
  twinFirst = null;
  upgradeAbility = { unit: unit, ability: a };
  attackingUnit = null;
  abilityUnit = null;
  hidePickup();

  if (isAreaAbility(a.kind)) {
    groundTargets = [];
    showTargetHint(a.name, 'ткни в клетку — область ' + a.power + '×' + a.power,
                   cancelTargeting);
    redrawScene();
    return;
  }

  supabase.rpc('get_ground_targets', { p_unit_id: unit.id }).then(function(res) {
    groundTargets = (!res.error && res.data) ? res.data : [];
    // Рывок бьёт на свою дистанцию, а не на дальность стрельбы
    if (a.kind === 'ability_lunge') {
      groundTargets = groundTargets.filter(function(t) { return t.gap === undefined || t.gap <= a.power; });
      showTargetHint(a.name, groundTargets.length
        ? 'рывок до ' + a.power + ' кл. · целей: ' + groundTargets.length
        : 'в ' + a.power + ' клетках врагов нет', cancelTargeting);
      redrawScene();
      return;
    }
    showTargetHint(a.name, groundTargets.length
      ? 'целей рядом: ' + groundTargets.length
      : 'целей нет', cancelTargeting);
    redrawScene();
  });
}

function handleUpgradeAbilityTap(cellX, cellY) {
  var a = upgradeAbility.ability;
  var unit = upgradeAbility.unit;

  // Площадные наводятся в два касания: первое намечает область, второе
  // подтверждает. Иначе на телефоне не видно, куда именно ляжет удар.
  if (isAreaAbility(a.kind)) {
    areaPreview = { x: cellX, y: cellY, size: a.power };
    showAreaConfirm(a);
    redrawScene();
    return;
  }

  var args = { p_unit_id: unit.id, p_research_id: a.research_id };

  {
    var pick = null;
    for (var i = 0; i < groundTargets.length; i++) {
      var t = groundTargets[i];
      var tu = unitsOnMap.filter(function(u) { return u.id === t.target_id; })[0];
      var b = unitTypeById[t.unit_type || (tu && tu.unit_type)] || {};
      var w = b.width_cells || 1, h = b.height_cells || 1;
      if (cellX >= t.x && cellX < t.x + w && cellY >= t.y && cellY < t.y + h) { pick = t; break; }
    }
    if (!pick) { alert('Эта цель недоступна'); return; }

    // Спаренный: первая цель выбрана, теперь предлагаем вторую рядом с ней
    if (a.kind === 'ability_twin' && !twinFirst) {
      twinFirst = pick;
      startTwinSecond(unit, a, pick);
      return;
    }

    args.p_target_id = twinFirst ? twinFirst.target_id : pick.target_id;
    if (twinFirst) args.p_second_id = pick.target_id;
  }

  var mainPick = twinFirst || pick;
  var twoTargets = !!twinFirst;
  var mainBefore = cbHpNow(mainPick);
  var lungeFrom = a.kind === 'ability_lunge' ? { x: unit.x, y: unit.y } : null;
  cbLastOwnAction = Date.now();
  supabase.rpc('use_unit_ability', args).then(function(r) {
    if (r.error) { alert(r.error.message); return; }
    var res = (r.data && r.data.length) ? r.data[0] : null;
    if (lungeFrom) gbLungeFx(lungeFrom, unitBox(unit), mainPick);
    // Две цели: убитым может оказаться любая, поэтому итог — общей сводкой
    if (res && twoTargets) cbReportArea(a.name, unit, res);
    else if (res) cbReportAbility(a.name, unit, mainPick, res, mainBefore);
    cancelTargeting();
    selectedUnit = null;
    loadUnits();
  });
}

// Вторая цель спаренного выстрела: только те, кто рядом с первой
function startTwinSecond(unit, a, first) {
  supabase.rpc('get_twin_candidates', {
    p_unit_id: unit.id, p_first_id: first.target_id
  }).then(function(res) {
    var list = (!res.error && res.data) ? res.data : [];

    // Приводим к тому же виду, что обычные цели, чтобы тап работал так же
    groundTargets = list.map(function(c) {
      return { target_id: c.target_id, name: c.name, x: c.x, y: c.y,
               hp: c.hp, gap: c.gap, unit_type: null };
    });

    var hint = document.getElementById('placement-hint');
    hint.innerHTML = '<span>Вторая цель · шанс ' + a.power + '% · рядом: ' +
                     groundTargets.length + '</span>' +
                     '<button id="twin-skip">Только первая</button>' +
                     '<button id="twin-cancel">Отмена</button>';
    hint.style.display = 'flex';

    document.getElementById('twin-cancel').addEventListener('click', cancelTargeting);
    document.getElementById('twin-skip').addEventListener('click', function() {
      var firstBefore = cbHpNow(first);
      cbLastOwnAction = Date.now();
      supabase.rpc('use_unit_ability', {
        p_unit_id: unit.id, p_research_id: a.research_id,
        p_target_id: first.target_id
      }).then(function(r) {
        if (r.error) { alert(r.error.message); return; }
        var res = (r.data && r.data.length) ? r.data[0] : null;
        if (res) cbReportAbility(a.name, unit, first, res, firstBefore);
        cancelTargeting();
        selectedUnit = null;
        loadUnits();
      });
    });

    setBottomInset(insetFor(hint));
    redrawScene();
  });
}

function startAbilityTargeting(unit, ability) {
  abilityUnit = unit;
  abilityDef = ability;
  attackingUnit = null;
  hidePickup();

  supabase.rpc('get_ability_targets', {
    p_unit_id: unit.id, p_ability_id: ability.ability_id
  }).then(function(res) {
    groundTargets = (!res.error && res.data) ? res.data : [];
    showTargetHint(ability.name, groundTargets.length
      ? 'подходящих рядом: ' + groundTargets.length
      : 'рядом некого', cancelTargeting);
    redrawScene();
  });
}

function showTargetHint(title, note, onCancel) {
  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>' + title + ' · ' + note + '</span>' +
                   '<button id="target-cancel">Отмена</button>';
  hint.style.display = 'flex';
  document.getElementById('target-cancel').addEventListener('click', onCancel);
  setBottomInset(insetFor(hint));
}

function cancelTargeting() {
  artilleryUnit = null;
  heroAbility = null;
  upgradeAbility = null;
  areaPreview = null;
  twinFirst = null;
  attackingUnit = null;
  abilityUnit = null;
  abilityDef = null;
  groundTargets = [];
  groundStructTargets = [];
  document.getElementById('placement-hint').style.display = 'none';
  setBottomInset(0);
  redrawScene();
}

// Подсветка достижимых целей
function drawTargetCells() {
  // Намеченная область: видно, куда ляжет удар и кого зацепит
  if (areaPreview) {
    // Красная заливка, если под ударом окажутся свои
    var inArea = artilleryUnit
      ? countInBox(areaPreview, artilleryUnit)
      : countInArea(areaPreview, upgradeAbility && upgradeAbility.unit);
    ctx.fillStyle = inArea.own
      ? 'rgba(217,74,74,0.30)'
      : 'rgba(217,169,64,0.28)';
    ctx.fillRect(areaPreview.x * CELL_PX, areaPreview.y * CELL_PX,
                 areaPreview.size * CELL_PX, areaPreview.size * CELL_PX);
    ctx.strokeStyle = inArea.own ? 'rgba(217,74,74,0.95)' : 'rgba(217,169,64,0.95)';
    ctx.lineWidth = 3;
    ctx.strokeRect(areaPreview.x * CELL_PX, areaPreview.y * CELL_PX,
                   areaPreview.size * CELL_PX, areaPreview.size * CELL_PX);
  }

  // Площадная способность: подсвечиваем радиус броска, а не цели
  if (upgradeAbility && isAreaAbility(upgradeAbility.ability.kind)) {
    var u = upgradeAbility.unit;
    var type = unitTypeById[u.unit_type] || {};
    var r = (type.weapon_range || 3) + (u.bonus_range || 0);

    ctx.strokeStyle = 'rgba(217,169,64,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect((u.x - r) * CELL_PX, (u.y - r) * CELL_PX,
                   (r * 2 + 1) * CELL_PX, (r * 2 + 1) * CELL_PX);
    ctx.setLineDash([]);
    return;
  }

  if (attackingUnit) drawStructTargets();

  if (!groundTargets.length) return;

  groundTargets.forEach(function(t) {
    ctx.strokeStyle = attackingUnit ? 'rgba(217,74,74,0.95)' : 'rgba(95,217,104,0.95)';
    ctx.lineWidth = 3;
    ctx.strokeRect(t.x * CELL_PX + 2, t.y * CELL_PX + 2, CELL_PX - 4, CELL_PX - 4);
  });
}

function handleTargetTap(cellX, cellY) {
  var pick = null;
  for (var i = 0; i < groundTargets.length; i++) {
    var t = groundTargets[i];
    // В списке целей нет типа юнита: габарит берём с карты, иначе
    // технику 2×2 можно было выбрать только по верхней левой клетке
    var tu = unitsOnMap.filter(function(u) { return u.id === t.target_id; })[0];
    var b = unitTypeById[t.unit_type || (tu && tu.unit_type)] || {};
    var w = b.width_cells || 1, h = b.height_cells || 1;
    if (cellX >= t.x && cellX < t.x + w && cellY >= t.y && cellY < t.y + h) { pick = t; break; }
  }

  // Постройку бьёт только обычный выстрел, способности — по бойцам
  if (!pick && attackingUnit) {
    var sPick = structTargetAt(cellX, cellY);
    if (sPick) { attackStructureTarget(sPick); return; }
  }

  if (!pick) { alert('Эта цель недоступна'); return; }

  if (attackingUnit) {
    var shooter = attackingUnit;
    cbLastOwnAction = Date.now();
    supabase.rpc('attack_unit', {
      p_attacker_id: shooter.id, p_target_id: pick.target_id
    }).then(function(r) {
      if (r.error) { alert(r.error.message); return; }
      var res = (r.data && r.data.length) ? r.data[0] : null;
      if (res) cbReportShot(shooter, pick, res);
      cancelTargeting();
      selectedUnit = null;
      loadUnits();
    });
    return;
  }

  var helper = abilityUnit, helpDef = abilityDef;
  var healBefore = cbHpNow(pick);
  cbLastOwnAction = Date.now();
  supabase.rpc('use_ability', {
    p_unit_id: helper.id, p_ability_id: helpDef.ability_id,
    p_target_id: pick.target_id
  }).then(function(r) {
    if (r.error) { alert(r.error.message); return; }
    cbLastOwnAction = Date.now();
    var tu = cbTargetUnit(pick);
    var gain = Number(r.data) || 0;
    var max = cbTargetMaxHp(pick);
    var serial = cbReport({
      kind: 'heal', title: helpDef.name,
      attacker: cbUnitPic(helper, 'mine'),
      target: cbTargetPic(pick, tu),
      heal: gain,
      hpLeft: Math.min(max || Infinity, healBefore + gain),
      hpMax: max
    });
    cbExpectHp(serial, pick.target_id, healBefore, max, 'heal');
    cancelTargeting();
    selectedUnit = null;
    loadUnits();
  });
}

// Высадка пассажира из канонерки: тап по клетке рядом с ней.
// Отдельный режим от десанта с корабля — тот про полосу вторжения,
// а этот про клетки вплотную к транспорту.
var disembarking = null;

function startDisembark(carrier, passenger) {
  disembarking = { carrier: carrier, passenger: passenger };
  hidePickup();

  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>Куда высадить: ' + passenger.unit_name + '</span>' +
                   '<button id="disembark-cancel">Отмена</button>';
  hint.style.display = 'flex';
  document.getElementById('disembark-cancel').addEventListener('click', cancelDisembark);

  setBottomInset(insetFor(hint));
  focusCell(carrier.x, carrier.y);
  redrawScene();
}

function cancelDisembark() {
  disembarking = null;
  document.getElementById('placement-hint').style.display = 'none';
  setBottomInset(0);
  redrawScene();
}

function drawDisembarkCells() {
  if (!disembarking) return;

  var c = disembarking.carrier;
  var size = unitBox(c);
  var occupied = buildOccupancy();

  for (var y = c.y - 1; y <= c.y + size.h; y++) {
    for (var x = c.x - 1; x <= c.x + size.w; x++) {
      if (!isBoxFree(occupied, x, y, 1, 1)) continue;
      ctx.fillStyle = 'rgba(95,217,104,0.25)';
      ctx.fillRect(x * CELL_PX + 3, y * CELL_PX + 3, CELL_PX - 6, CELL_PX - 6);
    }
  }
}

function handleDisembarkTap(cellX, cellY) {
  supabase.rpc('disembark_carrier', {
    p_unit_id: disembarking.passenger.unit_id, p_x: cellX, p_y: cellY
  }).then(function(r) {
    if (r.error) { alert('Не удалось высадить: ' + r.error.message); return; }
    cancelDisembark();
    loadUnits();
  });
}

// Передвижение наземного юнита. Разворота нет — только выбор клетки.
var movingUnit = null;

function startGroundMove(unit) {
  movingUnit = unit;
  hidePickup();

  var type = unitTypeById[unit.unit_type] || {};
  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>Куда идёт ' + (type.name || 'юнит') + '</span>' +
                   '<button id="move-cancel">Отмена</button>';
  hint.style.display = 'flex';
  document.getElementById('move-cancel').addEventListener('click', cancelGroundMove);

  setBottomInset(insetFor(hint));
  focusCell(unit.x, unit.y);
  redrawScene();
}

function cancelGroundMove() {
  movingUnit = null;
  document.getElementById('placement-hint').style.display = 'none';
  setBottomInset(0);
  redrawScene();
}

// Пока боец выбирает, куда идти (ход или автоход), показываем, куда нельзя:
// пустые участки под застройку и само поселение. На обычной карте пустые
// участки скрыты — без подсказки отказ «участок под застройку» был бы загадкой.
function drawBlockedSites() {
  var picking = movingUnit || (typeof amPick !== 'undefined' && amPick);
  if (!picking) return;
  var size = SLOT_SIZE * CELL_PX;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  for (var i = 0; i < buildSlots.length; i++) {
    if (buildingsBySlot[i + 1]) continue;   // здание и так видно
    var sl = buildSlots[i];
    ctx.fillStyle = 'rgba(217,74,74,0.09)';
    ctx.fillRect(sl.x * CELL_PX, sl.y * CELL_PX, size, size);
    ctx.strokeStyle = 'rgba(217,74,74,0.5)';
    ctx.strokeRect(sl.x * CELL_PX + 1, sl.y * CELL_PX + 1, size - 2, size - 2);
  }
  if (settlement) {
    ctx.strokeStyle = 'rgba(217,74,74,0.55)';
    ctx.strokeRect(settlement.x * CELL_PX - 2, settlement.y * CELL_PX - 2,
                   settlement.size * CELL_PX + 4, settlement.size * CELL_PX + 4);
  }
  ctx.restore();
}

// Зона хода: квадрат по дистанции Чебышёва, как у кораблей
function drawMoveCells() {
  if (!movingUnit) return;

  var r = unitMoveRange(movingUnit);
  var box = unitBox(movingUnit);

  var x0 = (movingUnit.x - r) * CELL_PX;
  var y0 = (movingUnit.y - r) * CELL_PX;
  var w = (r * 2 + box.w) * CELL_PX;
  var h = (r * 2 + box.h) * CELL_PX;

  ctx.fillStyle = 'rgba(95,217,104,0.10)';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = 'rgba(95,217,104,0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(x0, y0, w, h);
  ctx.setLineDash([]);
}

function handleGroundMoveTap(cellX, cellY) {
  // Тап по своей же клетке — это «передумал», а не приказ: сервер ответил
  // бы «Юнит уже здесь», и действие всё равно не потратилось бы
  if (cellX === movingUnit.x && cellY === movingUnit.y) { cancelGroundMove(); return; }
  supabase.rpc('move_ground_unit', {
    p_unit_id: movingUnit.id, p_x: cellX, p_y: cellY
  }).then(function(r) {
    if (r.error) { alert('Не получилось: ' + r.error.message); return; }
    cancelGroundMove();
    selectedUnit = null;
    loadUnits();
  });
}

// ===== Жест «зажал и тянешь» (js/drag-command.js) =====
// Палец держат на своём бойце — он «поднимается», дальше палец ведёт его
// призрак. Отпустил на пустой клетке — ход, на враге — выстрел, на самом
// бойце — отмена. Что будет, видно заранее: призрак зелёный или красный,
// над пальцем подсказка. Цели и дальность берём у сервера (get_ground_targets
// с туманом войны), ход проверяем теми же правилами, что move_ground_unit,
// а сам приказ всё равно проверяет база. Жест ничего не добавляет к
// возможностям бойца — только быстрее отдаёт обычный приказ.

var gbDrag = null;       // поднятый боец: { unit, type, box, gx, gy, cx, cy, hx, hy, ... }
var gbDragArmed = null;  // палец лёг на своего бойца, ждём, удержит ли
var gbDragInFlight = {}; // id бойца -> приказ ушёл, ответа ещё нет

// Жест работает только в обычном режиме карты: в любом наведении
// (ход по кнопке, атака, способность, высадка, стройка) палец занят им
function gbDragModeBusy() {
  return !!(buildMode || placingStructure || landingFighter || droppingVehicle ||
            disembarking || heroAbility || upgradeAbility || artilleryUnit ||
            attackingUnit || abilityUnit || movingUnit || droppingUnit || placingOrder ||
            (typeof amPick !== 'undefined' && amPick) ||
            (typeof gameConfirmOpen === 'function' && gameConfirmOpen()));
}

function gbClientCell(cx, cy) {
  var rect = viewport.getBoundingClientRect();
  return {
    x: Math.floor(((cx - rect.left - panX) / scale) / CELL_PX),
    y: Math.floor(((cy - rect.top - panY) / scale) / CELL_PX)
  };
}

function gbUnitAtCell(x, y, skipId) {
  for (var i = unitsOnMap.length - 1; i >= 0; i--) {
    var u = unitsOnMap[i];
    if (u.x === null || u.x === undefined || u.id === skipId) continue;
    var b = unitBox(u);
    if (x >= u.x && x < u.x + b.w && y >= u.y && y < u.y + b.h) return u;
  }
  return null;
}

// Своего бойца можно поднять, если он стоит на карте и в строю
function gbDragCanLift(u) {
  if (!u || u.owner_user_id !== currentUserId) return false;
  if (u.x === null || u.x === undefined) return false;
  if (u.hp !== undefined && u.hp !== null && u.hp <= 0) return false;
  if (u.transit_to) return false;
  if (u.training_until && new Date(u.training_until).getTime() > gbServerNow()) return false;
  return true;
}

// Палец лёг на карту. Если под ним свой боец — заводим таймер удержания.
function gbDragArm(cx, cy) {
  gbDragDisarm();
  if (gbDrag || gbDragModeBusy()) return;
  var c = gbClientCell(cx, cy);
  var u = gbUnitAtCell(c.x, c.y);
  if (!gbDragCanLift(u)) return;
  gbDragArmed = {
    unit: u, cx: cx, cy: cy, cell: c,
    timer: setTimeout(function() { gbDragLift(); }, DC_HOLD_MS)
  };
}

function gbDragDisarm() {
  if (gbDragArmed && gbDragArmed.timer) clearTimeout(gbDragArmed.timer);
  gbDragArmed = null;
}

// Палец сдвинулся до срабатывания таймера — это прокрутка карты
function gbDragArmMoved(cx, cy) {
  if (!gbDragArmed) return;
  if (Math.abs(cx - gbDragArmed.cx) > DC_SLOP || Math.abs(cy - gbDragArmed.cy) > DC_SLOP) { gbDragDisarm(); return; }
  // Пока держат, карта могла чуть сдвинуться — подъём считаем от того,
  // где палец сейчас, а не где он лёг
  gbDragArmed.lx = cx; gbDragArmed.ly = cy;
}

function gbDragActive() { return !!gbDrag; }

// Удержали — боец «поднят»
function gbDragLift() {
  var a = gbDragArmed;
  gbDragArmed = null;
  if (!a || gbDragModeBusy()) return;
  var u = guLiveUnit(a.unit);
  if (!gbDragCanLift(u)) return;
  var px = a.lx !== undefined ? a.lx : a.cx, py = a.ly !== undefined ? a.ly : a.cy;
  var cell = gbClientCell(px, py);
  // Под пальцем уже не этот боец (карта уехала) — не поднимаем
  var bx0 = unitBox(u);
  if (cell.x < u.x || cell.x >= u.x + bx0.w || cell.y < u.y || cell.y >= u.y + bx0.h) return;

  // Поднять нельзя — подсказка, а отпускание останется обычным тапом
  var type = unitTypeById[u.unit_type] || {};
  if (gbDragInFlight[u.id]) {
    dcFlash(px, py, 'Приказ уже отдан', 'ждём ответ сервера', 'wait', 1500);
    return;
  }
  var st = unitApState(u);
  if (st && st.ap < 1) {
    dcBuzz(8);
    dcFlash(px, py, 'Нет действий', 'восстановится через ' + st.next_in + ' с', 'bad', 1800);
    return;
  }

  var d = {
    unit: u, type: type, box: bx0,
    gx: cell.x - u.x, gy: cell.y - u.y,     // за какую клетку корпуса взяли
    cx: px, cy: py, hx: cell.x, hy: cell.y,
    lx: px, ly: py, left: false,            // откуда подняли; уводили ли палец
    range: unitMoveRange(u),
    artillery: (type.splash_size || 0) > 0,
    targets: [], structTargets: [], loaded: false, loadP: null,
    intent: null, raf: 0
  };
  gbDrag = d;

  // Цели — у сервера: он знает дальность с улучшениями и туман войны
  if (!d.artillery) {
    d.loadP = Promise.all([
      supabase.rpc('get_ground_targets', { p_unit_id: u.id }),
      supabase.rpc('get_structure_targets', { p_unit_id: u.id })
    ]).then(function(r) {
      d.targets = (!r[0].error && r[0].data) ? r[0].data : [];
      d.structTargets = (!r[1].error && r[1].data) ? r[1].data : [];
      d.loaded = true;
      if (gbDrag === d) gbDragUpdate();
    }, function() {
      d.loaded = true;
      if (gbDrag === d) gbDragUpdate();
    });
  } else {
    d.loaded = true;
    d.loadP = Promise.resolve();
  }

  dcBuzz(14);
  gbDragUpdate();
  d.raf = requestAnimationFrame(gbDragEdgeTick);
}

// Палец ведёт призрака
function gbDragMove(cx, cy) {
  var d = gbDrag;
  if (!d) return;
  d.cx = cx; d.cy = cy;
  gbDragUpdate();
}

// У края карты она сама едет за пальцем — иначе дальний ход на крупном
// масштабе не дотянуть, не отпуская бойца
function gbDragEdgeTick() {
  var d = gbDrag;
  if (!d) return;
  // Пока палец стоит, где подняли, карту не двигаем: иначе удержание
  // у края само увезло бы клетку под пальцем и отдало ход
  if (!d.left) { d.raf = requestAnimationFrame(gbDragEdgeTick); return; }
  var r = viewport.getBoundingClientRect();
  var box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom - uiBottomInset };
  var v = dcEdgeVelocity(box, d.cx, d.cy);
  if (v.x || v.y) {
    var px = panX, py = panY;
    panX += v.x; panY += v.y;
    clampPan();
    if (panX !== px || panY !== py) { applyTransform(); gbDragUpdate(); }
  }
  d.raf = requestAnimationFrame(gbDragEdgeTick);
}

function gbDragUpdate() {
  var d = gbDrag;
  if (!d) return;
  var c = gbClientCell(d.cx, d.cy);
  d.hx = c.x; d.hy = c.y;
  if (!d.left && (Math.abs(d.cx - d.lx) > DC_SLOP || Math.abs(d.cy - d.ly) > DC_SLOP)) d.left = true;
  d.intent = gbDragEval(d);
  var it = d.intent;
  dcChip(d.cx, d.cy, it.title, it.sub, it.tone);
  redrawScene();
}

// Что значит отпустить палец здесь
function gbDragEval(d) {
  var u = guLiveUnit(d.unit), b = d.box, hx = d.hx, hy = d.hy;

  // Отмена — когда призрак вернулся точно на место. Не «палец над бойцом»:
  // технику 2×2 взяли за угол и сдвинули на клетку — палец ещё на ней,
  // но это уже ход.
  if (hx - d.gx === u.x && hy - d.gy === u.y) {
    return { kind: 'home', tone: 'wait', title: 'Отмена', sub: 'веди на клетку или на врага' };
  }

  // Под пальцем кто-то стоит: враг — выстрел, свой или союзник — занято
  var other = gbUnitAtCell(hx, hy, u.id);
  if (other) {
    var side = cbUnitSide(other);
    var oName = (unitTypeById[other.unit_type] || {}).name || 'боец';
    if (side !== 'enemy') {
      return { kind: 'bad', tone: 'bad', title: 'Место занято', sub: (side === 'mine' ? 'твой ' : 'союзный ') + oName };
    }
    if (d.artillery) {
      return { kind: 'bad', tone: 'bad', title: 'Только залпом', sub: 'артиллерия бьёт по площади — кнопка «Залп»' };
    }
    if (!d.loaded) {
      return { kind: 'wait', tone: 'wait', title: 'Цель: ' + oName, sub: 'проверяем дальность…', target: other };
    }
    var t = null;
    for (var i = 0; i < d.targets.length; i++) {
      if (d.targets[i].target_id === other.id) { t = d.targets[i]; break; }
    }
    if (!t) {
      return { kind: 'bad', tone: 'bad', title: 'Не достать', sub: oName + ' вне дальности стрельбы', target: other };
    }
    return {
      kind: 'attack', tone: 'attack', title: 'Огонь: ' + (t.name || oName),
      sub: 'попадание ' + t.chance + '% · урон ' + t.damage, target: other, pick: t
    };
  }

  // Вражеская полевая постройка
  var sAt = structAt(hx, hy);
  if (sAt && structSide(sAt) === 'enemy') {
    var sName = (structTypeById[sAt.type_id] || {}).name || 'постройка';
    if (d.artillery) return { kind: 'bad', tone: 'bad', title: 'Только залпом', sub: 'артиллерия бьёт по площади — кнопка «Залп»' };
    if (!d.loaded) return { kind: 'wait', tone: 'wait', title: 'Цель: ' + sName, sub: 'проверяем дальность…' };
    var sp = null;
    for (var j = 0; j < d.structTargets.length; j++) {
      if (d.structTargets[j].structure_id === sAt.id) { sp = d.structTargets[j]; break; }
    }
    if (!sp) return { kind: 'bad', tone: 'bad', title: 'Не достать', sub: sName + ' вне дальности стрельбы' };
    return {
      kind: 'attack-struct', tone: 'attack', title: 'Огонь: ' + (sp.name || sName),
      sub: 'попадание ' + sp.chance + '% · урон ' + sp.damage, spick: sp
    };
  }

  // Пустая клетка — ход. Корпус встаёт так, как его взяли пальцем.
  var ax = hx - d.gx, ay = hy - d.gy;
  var out = { ax: ax, ay: ay };
  var dist = dcCheb(u.x, u.y, ax, ay);
  if (ax < 0 || ay < 0 || ax + b.w > GRID_SIZE || ay + b.h > GRID_SIZE) {
    out.kind = 'bad'; out.tone = 'bad'; out.title = 'Край карты'; out.sub = 'сюда корпус не влезет';
    return out;
  }
  if (dist > d.range) {
    out.kind = 'bad'; out.tone = 'bad'; out.title = 'Слишком далеко';
    out.sub = 'дальность хода ' + d.range + ' кл., а тут ' + dist + ' кл.';
    return out;
  }
  var why = gbDragMoveProblem(u, ax, ay);
  if (why) { out.kind = 'bad'; out.tone = 'bad'; out.title = why[0]; out.sub = why[1]; return out; }
  out.kind = 'move'; out.tone = 'move';
  out.title = 'Идти · ' + dcCellsWord(dist);
  out.sub = 'отпусти — встанет здесь';
  return out;
}

// Почему сюда нельзя: те же правила, что у move_ground_unit, по тому,
// что видно на карте. Невидимых в тумане врагов отсекает сервер.
function gbDragMoveProblem(u, x, y) {
  var b = unitBox(u);
  var t = unitTypeById[u.unit_type] || {};
  if (settlement && boxOverlap(x, y, b.w, b.h, settlement.x, settlement.y, settlement.size, settlement.size)) {
    return ['В поселение не войти', 'встань в кольце вокруг него'];
  }
  for (var k = 0; k < buildSlots.length; k++) {
    if (boxOverlap(x, y, b.w, b.h, buildSlots[k].x, buildSlots[k].y, SLOT_SIZE, SLOT_SIZE)) {
      return buildingsBySlot[k + 1] ? ['Здесь здание', 'обойди его'] : ['Участок под застройку', 'обойди его'];
    }
  }
  for (var i = 0; i < unitsOnMap.length; i++) {
    var o = unitsOnMap[i];
    if (o.id === u.id || o.x === null || o.x === undefined) continue;
    var ob = unitBox(o);
    if (boxOverlap(x, y, b.w, b.h, o.x, o.y, ob.w, ob.h)) return ['Место занято', 'тут уже кто-то стоит'];
  }
  for (var j = 0; j < fieldStructures.length; j++) {
    var s = fieldStructures[j];
    var st = structTypeById[s.type_id] || {};
    if (!boxOverlap(x, y, b.w, b.h, s.x, s.y, s.w || 1, s.h || 1)) continue;
    if (st.enterable && s.faction === u.faction && st.infantry_only && t.is_vehicle) {
      return ['Технике не въехать', (st.name || 'укрытие') + ' — только для пехоты'];
    }
    if (!st.enterable || s.faction !== u.faction) return ['Сюда не встать', st.name || 'постройка'];
  }
  return null;
}

// Отпустили палец
function gbDragEnd() {
  var d = gbDrag;
  if (!d) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  var c = gbClientCell(d.cx, d.cy);
  d.hx = c.x; d.hy = c.y;
  var it = gbDragEval(d);
  gbDrag = null;

  // Подержал и отпустил на месте — это обычный тап: открываем бойца
  if (it.kind === 'home' && !d.left) {
    dcHideChip();
    redrawScene();
    handleTap(d.cx, d.cy);
    return;
  }

  // Цель ещё проверяется: дожидаемся ответа и решаем по нему. Стрелять
  // будем только в того, на кого отпустили: за это время он мог уйти,
  // а на его клетку — встать другой.
  if (it.kind === 'wait' && d.loadP) {
    var want = it.target ? it.target.id : null;
    dcChip(d.cx, d.cy, it.title, 'проверяем дальность…', 'wait');
    gbDragInFlight[d.unit.id] = true;
    d.loadP.then(function() {
      delete gbDragInFlight[d.unit.id];
      var again = gbDragEval(d);
      var same = again.kind === 'attack' && again.target && again.target.id === want;
      if (!same && (again.kind === 'attack' || again.kind === 'attack-struct' || again.kind === 'move' || again.kind === 'wait')) {
        again = { kind: 'bad', title: 'Цель ушла', sub: 'приказ не отдан — веди заново' };
      }
      gbDragCommit(d, again);
    });
    redrawScene();
    return;
  }
  gbDragCommit(d, it);
  redrawScene();
}

function gbDragCancel() {
  var d = gbDrag;
  gbDragDisarm();
  if (!d) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  gbDrag = null;
  dcHideChip();
  redrawScene();
}

function gbDragCommit(d, it) {
  var u = d.unit;
  if (it.kind === 'home') { dcHideChip(); return; }
  if (it.kind === 'bad' || it.kind === 'wait') {
    dcFlash(d.cx, d.cy, it.title, it.sub, 'bad', 1800);
    return;
  }
  dcHideChip();
  gbDragInFlight[u.id] = true;
  var done = function() { delete gbDragInFlight[u.id]; };
  var fail = function(msg) {
    done();
    dcFlash(d.cx, d.cy, 'Не вышло', msg || 'нет связи с сервером', 'bad', 2600);
  };
  var after = function() {
    if (selectedUnit && selectedUnit.id === u.id) { selectedUnit = null; hidePickup(); }
  };

  if (it.kind === 'move') {
    // Боец сразу встаёт на новое место; откажет сервер — вернётся назад
    var live = guLiveUnit(u);
    var fromX = live.x, fromY = live.y;
    live.x = it.ax; live.y = it.ay;
    redrawScene();
    supabase.rpc('move_ground_unit', { p_unit_id: u.id, p_x: it.ax, p_y: it.ay }).then(function(r) {
      if (r.error) {
        var now = guLiveUnit(u);
        if (now.x === it.ax && now.y === it.ay) { now.x = fromX; now.y = fromY; }
        redrawScene();
        fail(r.error.message);
        return;
      }
      done(); after(); loadUnits();
    }, function(e) {
      var now = guLiveUnit(u);
      if (now.x === it.ax && now.y === it.ay) { now.x = fromX; now.y = fromY; }
      redrawScene();
      fail(e && e.message);
    });
    return;
  }

  if (it.kind === 'attack') {
    var pick = it.pick;
    cbLastOwnAction = Date.now();
    supabase.rpc('attack_unit', { p_attacker_id: u.id, p_target_id: pick.target_id }).then(function(r) {
      if (r.error) { fail(r.error.message); return; }
      done();
      var res = (r.data && r.data.length) ? r.data[0] : null;
      if (res) cbReportShot(u, pick, res);
      after(); loadUnits();
    }, function(e) { fail(e && e.message); });
    return;
  }

  if (it.kind === 'attack-struct') {
    var sp = it.spick;
    cbLastOwnAction = Date.now();
    supabase.rpc('attack_structure', { p_attacker_id: u.id, p_structure_id: sp.structure_id }).then(function(r) {
      if (r.error) { fail(r.error.message); return; }
      done();
      var res = (r.data && r.data.length) ? r.data[0] : null;
      if (res) cbReportStructShot(u, sp, res);
      after(); loadStructures(); loadUnits();
    }, function(e) { fail(e && e.message); });
  }
}

// Отрисовка жеста: зона хода, цели, «поднятый» боец, нить и призрак
function drawDragOverlay() {
  var d = gbDrag;
  if (!d) return;
  var u = guLiveUnit(d.unit), b = d.box, C = CELL_PX;
  var it = d.intent || {};

  // Зона хода — как в обычном «Идти»
  var r = d.range;
  ctx.fillStyle = 'rgba(95,217,104,0.08)';
  ctx.fillRect((u.x - r) * C, (u.y - r) * C, (r * 2 + b.w) * C, (r * 2 + b.h) * C);
  ctx.strokeStyle = 'rgba(95,217,104,0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect((u.x - r) * C, (u.y - r) * C, (r * 2 + b.w) * C, (r * 2 + b.h) * C);
  ctx.setLineDash([]);

  // Кого можно достать отсюда
  ctx.lineWidth = 2;
  d.targets.forEach(function(t) {
    var tu = gbUnitById(t.target_id);
    var tb = tu ? unitBox(tu) : { w: 1, h: 1 };
    ctx.strokeStyle = 'rgba(217,74,74,0.75)';
    ctx.strokeRect(t.x * C + 2, t.y * C + 2, tb.w * C - 4, tb.h * C - 4);
  });
  ctx.setLineDash([6, 4]);
  d.structTargets.forEach(function(t) {
    ctx.strokeStyle = 'rgba(217,74,74,0.7)';
    ctx.strokeRect(t.x * C + 2, t.y * C + 2, t.w * C - 4, t.h * C - 4);
  });
  ctx.setLineDash([]);

  // Боец «поднят» с места: само место приглушаем
  ctx.fillStyle = 'rgba(5,6,10,0.55)';
  ctx.fillRect(u.x * C + 2, u.y * C + 2, b.w * C - 4, b.h * C - 4);

  var ok = it.kind === 'move' || it.kind === 'attack' || it.kind === 'attack-struct';
  var col = it.kind === 'attack' || it.kind === 'attack-struct' ? '#ff6b6b'
          : ok ? '#5fd968' : it.kind === 'wait' || it.kind === 'home' ? '#d9a940' : '#9aa6b2';

  // Куда смотрит нить: середина будущего места или цели
  var ex, ey, tbx = null;
  if (it.kind === 'attack' || it.kind === 'wait' || (it.kind === 'bad' && it.target)) {
    var tg = it.target;
    if (tg) {
      var tgb = unitBox(tg);
      tbx = { x: tg.x, y: tg.y, w: tgb.w, h: tgb.h };
    }
  } else if (it.kind === 'attack-struct' && it.spick) {
    tbx = { x: it.spick.x, y: it.spick.y, w: it.spick.w, h: it.spick.h };
  }
  if (tbx) { ex = (tbx.x + tbx.w / 2) * C; ey = (tbx.y + tbx.h / 2) * C; }
  else if (it.ax !== undefined) { ex = (it.ax + b.w / 2) * C; ey = (it.ay + b.h / 2) * C; }
  else { ex = (d.hx + 0.5) * C; ey = (d.hy + 0.5) * C; }

  if (it.kind !== 'home') {
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 7]);
    ctx.beginPath();
    ctx.moveTo((u.x + b.w / 2) * C, (u.y + b.h / 2) * C);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Прицел на цели: угловые скобки
  if (tbx) {
    var x0 = tbx.x * C - 4, y0 = tbx.y * C - 4, w = tbx.w * C + 8, h = tbx.h * C + 8;
    var k = Math.min(w, h) * 0.32;
    ctx.strokeStyle = col;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + k); ctx.lineTo(x0, y0); ctx.lineTo(x0 + k, y0);
    ctx.moveTo(x0 + w - k, y0); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w, y0 + k);
    ctx.moveTo(x0 + w, y0 + h - k); ctx.lineTo(x0 + w, y0 + h); ctx.lineTo(x0 + w - k, y0 + h);
    ctx.moveTo(x0 + k, y0 + h); ctx.lineTo(x0, y0 + h); ctx.lineTo(x0, y0 + h - k);
    ctx.stroke();
    return;
  }

  // Призрак бойца на будущем месте
  if (it.ax === undefined) return;
  var gx = it.ax * C + 2, gy = it.ay * C + 2, gw = b.w * C - 4, gh = b.h * C - 4;
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = 'rgba(5,6,10,0.85)';
  ctx.fillRect(gx, gy, gw, gh);
  var img = d.type ? getUnitImage(u.portrait || d.type.image) : null;
  if (img && img.complete && !img.failed && img.naturalWidth > 0) {
    var cr = gbUnitCrop(img, d.type);
    gbDrawSprite(img, cr[0], cr[1], cr[2], cr[3], gx, gy, gw, gh);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = col;
  ctx.lineWidth = 3;
  ctx.strokeRect(gx, gy, gw, gh);
  if (!ok) {
    // Крест поверх: сюда не пойдёт
    ctx.beginPath();
    ctx.moveTo(gx + gw * 0.25, gy + gh * 0.25); ctx.lineTo(gx + gw * 0.75, gy + gh * 0.75);
    ctx.moveTo(gx + gw * 0.75, gy + gh * 0.25); ctx.lineTo(gx + gw * 0.25, gy + gh * 0.75);
    ctx.stroke();
  }
}

function gbUnitById(id) {
  for (var i = 0; i < unitsOnMap.length; i++) if (unitsOnMap[i].id === id) return unitsOnMap[i];
  return null;
}

function hidePickup() {
  var bar = document.getElementById('pickup-bar');
  if (!bar || bar.style.visibility === 'hidden') return;
  bar.removeAttribute('data-struct');
  bar.removeAttribute('data-side');
  bar.removeAttribute('data-intel');
  bar.style.visibility = 'hidden';
  setBottomInset(0);
}

var dropVehicles = [];
var dropFighters = [];

function loadDropCargo() {
  return Promise.all([
    supabase.rpc('get_drop_ready_cargo', { p_system_id: systemId }),
    supabase.rpc('get_drop_ready_vehicles', { p_system_id: systemId }),
    supabase.rpc('get_landable_fighters', { p_system_id: systemId })
  ]).then(function(r) {
      var res = r[0];
      dropCargo = (res.error || !res.data) ? [] : res.data;
      dropVehicles = (r[1].error || !r[1].data) ? [] : r[1].data;
      dropFighters = (r[2].error || !r[2].data) ? [] : r[2].data;

      updateDropBtn();
    });
}

// Кнопка высадки (красная) — только для вторжения на чужую планету.
// Показываем через visibility, а не display: элемент остаётся в раскладке,
// и его появление не заставляет браузер заново растрировать холст.
// На своей планете кнопки нет: войска высаживают пачкой из трюма в космосе,
// а истребитель садится по «На грунт» из ангара — оттуда сразу открывается
// режим посадки (ссылка &land=), список ему не нужен.
function dropListFor() {
  var invading = iAmAttacker === true;
  return {
    fighters: dropFighters,
    vehicles: invading ? dropVehicles : [],
    cargo: invading ? dropCargo : []
  };
}

function updateDropBtn() {
  var btn = document.getElementById('drop-btn');
  if (!btn) return;
  var busy = droppingUnit || droppingVehicle || landingFighter;
  var l = dropListFor();
  var show = !busy && iAmAttacker === true &&
             (l.fighters.length + l.vehicles.length + l.cargo.length) > 0;
  btn.style.visibility = show ? 'visible' : 'hidden';
}

// Куда можно сесть: при вторжении — полоса вторжения, на своей планете —
// зоны высадки. Ровно те же правила проверяет land_fighter на сервере.
function fighterLandCellAllowed(cx, cy) {
  if (cx < 0 || cy < 0 || cx >= GRID_SIZE || cy >= GRID_SIZE) return false;
  if (iAmAttacker) return cy >= GRID_SIZE - ATTACK_ZONE_H;
  return deployZones.some(function(z) {
    var size = z.size || DEPLOY_SIZE;
    return cx >= z.x && cx < z.x + size && cy >= z.y && cy < z.y + size;
  });
}

function openDropPanel() {
  var panel = document.getElementById('drop-panel');
  var list = document.getElementById('drop-panel-list');
  list.innerHTML = '';

  var l = dropListFor();

  // Истребители первыми: их положение важнее всего, они самые манёвренные
  l.fighters.forEach(function(f) {
    var ready = f.zone !== null && f.zone !== undefined;
    var item = document.createElement('button');
    item.className = 'drop-item' + (ready ? '' : ' not-ready');
    item.innerHTML =
      '<div class="drop-item-main">' +
        '<div class="drop-item-name">' + f.name +
          ' <span class="drop-size">' + f.hp + '/' + f.max_hp + '</span></div>' +
        '<div class="drop-item-sub">' + f.carrier_name +
          (ready ? ' · площадка ' + f.zone : ' · носитель не в площадке сброса') + '</div>' +
      '</div>';
    if (ready) { item.addEventListener('click', function() { startFighterLanding(f); }); }
    else { item.disabled = true; }
    list.appendChild(item);
  });

  if (!l.cargo.length && !l.vehicles.length && !l.fighters.length) {
    list.innerHTML = '<div class="drop-empty">В трюмах пусто</div>';
  }

  // Техника идёт первой: она занимает несколько клеток, и её положение
  // важнее, чем то, куда встанет отдельный пехотинец
  l.vehicles.forEach(function(v) {
    var ready = v.zone !== null && v.zone !== undefined;
    var item = document.createElement('button');
    item.className = 'drop-item' + (ready ? '' : ' not-ready');
    item.innerHTML =
      '<div class="drop-item-main">' +
        '<div class="drop-item-name">' + v.unit_name +
          ' <span class="drop-size">' + v.width_cells + '×' + v.height_cells + '</span>' +
          (v.passengers ? ' <span class="drop-pax">+' + v.passengers + '</span>' : '') +
        '</div>' +
        '<div class="drop-item-sub">' + v.ship_name +
          (ready ? ' · площадка ' + v.zone : ' · не в площадке сброса') + '</div>' +
      '</div>';
    if (ready) { item.addEventListener('click', function() { startVehicleDrop(v); }); }
    else { item.disabled = true; }
    list.appendChild(item);
  });

  l.cargo.forEach(function(row) {
    var ready = row.zone !== null && row.zone !== undefined;

    var item = document.createElement('button');
    item.className = 'drop-item' + (ready ? '' : ' not-ready');
    item.innerHTML =
      '<div class="drop-item-main">' +
        '<div class="drop-item-name">' + row.unit_name + ' ×' + row.quantity + '</div>' +
        '<div class="drop-item-sub">' + row.ship_name + ' ' + row.x + ':' + row.y +
          (ready ? ' · площадка ' + row.zone : ' · не в площадке сброса') + '</div>' +
      '</div>';

    if (ready) {
      item.addEventListener('click', function() {
        startDrop(row.ship_id, row.unit_type, row.unit_name);
      });
    } else {
      item.disabled = true;
    }

    list.appendChild(item);
  });

  panel.style.display = 'flex';
}

function closeDropPanel() {
  document.getElementById('drop-panel').style.display = 'none';
}

var droppingVehicle = null;
var landingFighter = null;

function startFighterLanding(f) {
  landingFighter = f;
  droppingUnit = null;
  droppingVehicle = null;
  closeDropPanel();

  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>Куда сажать: ' + f.name + '</span>' +
                   '<button id="drop-cancel">Готово</button>';
  hint.style.display = 'flex';
  document.getElementById('drop-cancel').addEventListener('click', cancelDrop);

  var btn = document.getElementById('drop-btn');
  if (btn) btn.style.visibility = 'hidden';

  setBottomInset(insetFor(hint));
  var midX = (viewport.clientWidth / 2 - panX) / scale / CELL_PX;
  focusCell(midX, iAmAttacker
    ? GRID_SIZE - ATTACK_ZONE_H + ATTACK_ZONE_H / 2
    : (deployZones.length ? deployZones[0].y : 10));
  redrawScene();
}

var landingBusy = false;
var dropHintTimer = null;

// Короткое пояснение прямо в строке подсказки режима: отдельное окно
// здесь лишнее, а молчаливый тап выглядел как поломка
function gbToast(text) {
  var span = document.querySelector('#placement-hint span');
  if (!span) return;
  if (!span.dataset.base) span.dataset.base = span.textContent;
  span.textContent = text;
  clearTimeout(dropHintTimer);
  dropHintTimer = setTimeout(function() {
    if (span.dataset.base) span.textContent = span.dataset.base;
    delete span.dataset.base;
  }, 2200);
}

function handleFighterLandingTap(cellX, cellY) {
  // Тап мимо разрешённой зоны не молчит: подсказываем, куда садиться
  if (!fighterLandCellAllowed(cellX, cellY)) {
    gbToast(iAmAttacker ? 'Садиться можно только в полосе вторжения'
                        : 'Садиться можно только в зону высадки');
    return;
  }
  if (!isBoxFree(buildOccupancy(), cellX, cellY, 1, 1)) {
    gbToast('Клетка занята');
    return;
  }
  if (landingBusy) return;
  landingBusy = true;

  var f = landingFighter;
  supabase.rpc('land_fighter', {
    p_fighter_id: f.fighter_id, p_x: cellX, p_y: cellY
  }).then(function(r) {
    landingBusy = false;
    if (r.error) { alert('Не удалось посадить: ' + r.error.message); return; }
    cancelDrop();
    loadUnits();
    loadDropCargo();
  }, function() { landingBusy = false; });
}

function startVehicleDrop(v) {
  droppingVehicle = v;
  droppingUnit = null;
  closeDropPanel();

  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>Куда высадить: ' + v.unit_name +
                   ' (' + v.width_cells + '×' + v.height_cells + ')</span>' +
                   '<button id="drop-cancel">Готово</button>';
  hint.style.display = 'flex';
  document.getElementById('drop-cancel').addEventListener('click', cancelDrop);

  var btn = document.getElementById('drop-btn');
  if (btn) btn.style.visibility = 'hidden';

  setBottomInset(insetFor(hint));
  var midX = (viewport.clientWidth / 2 - panX) / scale / CELL_PX;
  focusCell(midX, GRID_SIZE - ATTACK_ZONE_H + ATTACK_ZONE_H / 2);
  redrawScene();
}

function handleVehicleDropTap(cellX, cellY) {
  supabase.rpc('unload_vehicle_at', {
    p_unit_id: droppingVehicle.unit_id, p_x: cellX, p_y: cellY
  }).then(function(r) {
    if (r.error) { alert('Не удалось высадить: ' + r.error.message); return; }
    cancelDrop();
    loadUnits();
    loadDropCargo();
  });
}

function startDrop(shipId, unitType, name) {
  droppingUnit = { shipId: shipId, unitType: unitType, name: name };
  closeDropPanel();

  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>Куда высадить: ' + name + '</span>' +
                   '<button id="drop-cancel">Готово</button>';
  hint.style.display = 'flex';
  document.getElementById('drop-cancel').addEventListener('click', cancelDrop);

  var btn = document.getElementById('drop-btn');
  if (btn) btn.style.visibility = 'hidden';

  setBottomInset(insetFor(hint));
  var midX = (viewport.clientWidth / 2 - panX) / scale / CELL_PX;
  focusCell(midX, GRID_SIZE - ATTACK_ZONE_H + ATTACK_ZONE_H / 2);
  redrawScene();
}

function cancelDrop() {
  droppingUnit = null;
  droppingVehicle = null;
  landingFighter = null;
  document.getElementById('placement-hint').style.display = 'none';

  updateDropBtn();

  setBottomInset(0);
  redrawScene();
}

// Подсветка свободных клеток полосы вторжения
function drawDropCells() {
  if (!droppingUnit && !droppingVehicle && !landingFighter) return;

  var vw = droppingVehicle ? droppingVehicle.width_cells : 1;
  var vh = droppingVehicle ? droppingVehicle.height_cells : 1;

  var occupied = buildOccupancy();

  // Посадка истребителя на своей планете идёт в зоны высадки: красим
  // их свободные клетки тем же зелёным, что и при найме
  if (landingFighter && !iAmAttacker) {
    deployZones.forEach(function(zone) {
      var size = zone.size || DEPLOY_SIZE;
      for (var dx = 0; dx < size; dx++) {
        for (var dy = 0; dy < size; dy++) {
          var zx = zone.x + dx, zy = zone.y + dy;
          if (!isBoxFree(occupied, zx, zy, 1, 1)) continue;
          ctx.fillStyle = 'rgba(95,217,104,0.25)';
          ctx.fillRect(zx * CELL_PX + 3, zy * CELL_PX + 3, CELL_PX - 6, CELL_PX - 6);
        }
      }
    });
    return;
  }

  var y0 = GRID_SIZE - ATTACK_ZONE_H;
  for (var cy = y0; cy < GRID_SIZE; cy++) {
    for (var cx = 0; cx < GRID_SIZE; cx++) {
      if (!isBoxFree(occupied, cx, cy, vw, vh)) continue;
      ctx.fillStyle = 'rgba(217,74,74,0.22)';
      ctx.fillRect(cx * CELL_PX + 3, cy * CELL_PX + 3,
                   CELL_PX * vw - 6, CELL_PX * vh - 6);
    }
  }
}

// Тап в режиме высадки. Клетку проверяет и сервер, но локальная проверка
// экономит запрос и даёт мгновенный отклик.
function handleDropTap(cellX, cellY) {
  if (cellY < GRID_SIZE - ATTACK_ZONE_H || cellY >= GRID_SIZE) return;
  if (cellX < 0 || cellX >= GRID_SIZE) return;

  // Клетка под корпусом техники тоже занята, хотя её угол стоит в другой
  if (!isBoxFree(buildOccupancy(), cellX, cellY, 1, 1)) {
    alert('Клетка занята');
    return;
  }

  var drop = droppingUnit;

  supabase.rpc('unload_unit_at', {
    p_ship_id: drop.shipId,
    p_unit_type: drop.unitType,
    p_x: cellX,
    p_y: cellY
  }).then(function(res) {
    if (res.error) {
      alert('Не удалось высадить: ' + res.error.message);
      return;
    }

    // Высаживаем по одному, режим не сбрасываем: обычно ставят
    // несколько бойцов подряд, и каждый раз лезть в панель неудобно
    loadUnits();
    loadDropCargo().then(function() {
      var left = dropCargo.filter(function(r) {
        return r.ship_id === drop.shipId && r.unit_type === drop.unitType;
      })[0];
      if (!left) cancelDrop();
    });
  });
}

// Режим выбора клетки: подсвечиваем свободные места в зонах.
function startPlacement(unitTypeId, quantity, upgrades, heroName) {
  placingOrder = { unitType: unitTypeId, quantity: quantity,
                   upgrades: upgrades || [], heroName: heroName || null };
  closeUnitPanel();

  var hint = document.getElementById('placement-hint');
  var t = unitTypeById[unitTypeId];
  hint.innerHTML = '<span>Выбери клетку в зоне высадки для: ' +
                   (heroName ? escHtml(heroName) : ((t && t.name) || 'юнита') + ' ×' + quantity) + '</span>' +
                   '<button id="placement-cancel">Отмена</button>';
  hint.style.display = 'flex';
  document.getElementById('placement-cancel').addEventListener('click', cancelPlacement);

  redrawScene();
}

function cancelPlacement() {
  placingOrder = null;
  document.getElementById('placement-hint').style.display = 'none';
  redrawScene();
}

function drawPlacementCells() {
  if (!placingOrder) return;

  var occupied = buildOccupancy();

  deployZones.forEach(function(zone) {
    var size = zone.size || DEPLOY_SIZE;
    for (var dx = 0; dx < size; dx++) {
      for (var dy = 0; dy < size; dy++) {
        var cx = zone.x + dx, cy = zone.y + dy;
        if (occupied[cx + ':' + cy]) continue;
        ctx.fillStyle = 'rgba(95,217,104,0.25)';
        ctx.fillRect(cx * CELL_PX + 3, cy * CELL_PX + 3, CELL_PX - 6, CELL_PX - 6);
      }
    }
  });
}

// Тап в режиме размещения: отправляем заказ с выбранной точкой.
function handlePlacementTap(cellX, cellY) {
  var inZone = deployZones.some(function(z) {
    var size = z.size || DEPLOY_SIZE;
    return cellX >= z.x && cellX < z.x + size && cellY >= z.y && cellY < z.y + size;
  });

  if (!inZone) return;

  var taken = !!buildOccupancy()[cellX + ':' + cellY];
  if (taken) {
    alert('Клетка занята');
    return;
  }

  var order = placingOrder;
  cancelPlacement();

  // Одарённого нанимает отдельная функция: у неё своя проверка клички
  // и своё время подготовки, взятое из типа, а не из общей настройки.
  if (order.heroName) {
    supabase.rpc('hire_hero', {
      p_building_id: unitPanelBuilding.id,
      p_name: order.heroName,
      p_target_x: cellX,
      p_target_y: cellY
    }).then(function(res) {
      if (res.error) {
        alert('Не удалось нанять: ' + res.error.message);
        return;
      }
      loadUnitOrders();
    });
    return;
  }

  supabase.rpc('order_unit', {
    p_building_id: unitPanelBuilding.id,
    p_unit_type: order.unitType,
    p_quantity: order.quantity,
    p_target_x: cellX,
    p_target_y: cellY,
    p_upgrades: order.upgrades || []
  }).then(function(res) {
    if (res.error) {
      alert('Не удалось нанять: ' + res.error.message);
      return;
    }
    loadUnitOrders();
  });
}

// Переключатель режима стройки прямо на карте: осмотр и наём войск —
// в обычном режиме, а слоты и постройка зданий — по этой кнопке.
function initBuildToggle(isSpace) {
  if (!isController) return;

  var btn = document.createElement('button');
  btn.id = 'build-toggle';
  btn.textContent = buildMode ? 'Выйти из стройки' : 'Строительство';
  if (buildMode) btn.classList.add('active');
  document.body.appendChild(btn);

  btn.addEventListener('click', function() {
    var page = isSpace ? 'space-battle.html' : 'ground-battle.html';
    window.location.href = page + '?system=' + systemId + (buildMode ? '' : '&mode=build');
  });
}

// ===== Древо развития одарённого =====
// Полотно листается и масштабируется как галактическая карта: узлов
// двенадцать у джедая и тринадцать у ситха, списком это не читается.

var TREE_STEP_X = 150;      // расстояние между ветками
var TREE_STEP_Y = 165;      // расстояние между ступенями
var TREE_NODE = 96;         // сторона узла
var TREE_PAD = 70;          // поля вокруг полотна

var treeUnit = null;
var treeNodes = [];
var treeSelected = null;
var treePan = { x: 0, y: 0, scale: 1 };

function openHeroTree(unit) {
  treeUnit = unit;
  treeSelected = null;

  var panel = document.getElementById('tree-panel');
  var title = document.getElementById('tree-title');
  var info = document.getElementById('tree-info');

  title.textContent = 'Развитие · ' + escHtml(unit.hero_name || 'одарённый');
  info.innerHTML = '<div class="tree-hint">Загрузка...</div>';
  panel.style.display = 'flex';

  supabase.rpc('get_hero_tree', { p_hero_id: unit.hero_id }).then(function(res) {
    if (res.error) {
      info.innerHTML = '<div class="tree-hint">Не удалось прочитать древо</div>';
      return;
    }
    treeNodes = res.data || [];
    buildHeroTree();
  });
}

function closeHeroTree() {
  document.getElementById('tree-panel').style.display = 'none';
  treeUnit = null;
  treeNodes = [];
  treeSelected = null;
}

function buildHeroTree() {
  var world = document.getElementById('tree-world');
  var nodesBox = document.getElementById('tree-nodes');
  var svg = document.getElementById('tree-links');

  var maxCol = 0, maxRow = 0;
  treeNodes.forEach(function(n) {
    maxCol = Math.max(maxCol, parseFloat(n.tree_col));
    maxRow = Math.max(maxRow, parseFloat(n.tree_row));
  });

  var w = TREE_PAD * 2 + maxCol * TREE_STEP_X + TREE_NODE;
  var h = TREE_PAD * 2 + maxRow * TREE_STEP_Y + TREE_NODE;

  world.style.width = w + 'px';
  world.style.height = h + 'px';
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);

  var pos = {};
  treeNodes.forEach(function(n) {
    pos[n.ability_id] = {
      x: TREE_PAD + parseFloat(n.tree_col) * TREE_STEP_X,
      y: TREE_PAD + parseFloat(n.tree_row) * TREE_STEP_Y
    };
  });

  // Связи рисуем первыми, чтобы узлы легли поверх
  var links = '';
  treeNodes.forEach(function(n) {
    (n.requires || []).forEach(function(req) {
      var a = pos[req], b = pos[n.ability_id];
      if (!a || !b) return;
      var x1 = a.x + TREE_NODE / 2, y1 = a.y + TREE_NODE;
      var x2 = b.x + TREE_NODE / 2, y2 = b.y;
      var mid = (y1 + y2) / 2;
      var done = n.learned || n.unlocked;
      links += '<path d="M' + x1 + ' ' + y1 +
               ' C' + x1 + ' ' + mid + ' ' + x2 + ' ' + mid + ' ' + x2 + ' ' + y2 + '" ' +
               'class="tree-link' + (done ? ' open' : '') + '"/>';
    });
  });
  svg.innerHTML = links;

  nodesBox.innerHTML = '';
  treeNodes.forEach(function(n) {
    var p = pos[n.ability_id];
    var el = document.createElement('button');

    var state = n.learned ? 'learned'
              : n.in_training ? 'training'
              : n.unlocked ? 'open' : 'locked';

    el.className = 'tree-node ' + state;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.innerHTML = '<img src="../' + n.icon + '" alt="">' +
                   '<span class="tree-node-name">' + n.name + '</span>' +
                   (n.kind === 'passive' ? '<i class="tree-node-kind">пассив</i>' : '');

    el.addEventListener('click', function(e) {
      e.stopPropagation();
      selectTreeNode(n.ability_id);
    });

    nodesBox.appendChild(el);
  });

  // Ставим полотно так, чтобы первый доступный узел был на виду
  var vp = document.getElementById('tree-viewport');
  treePan.scale = 1;
  treePan.x = (vp.clientWidth - w) / 2;
  treePan.y = 20;
  clampTreePan();
  applyTreePan();

  var first = null;
  for (var i = 0; i < treeNodes.length; i++) {
    if (!treeNodes[i].learned && treeNodes[i].unlocked) { first = treeNodes[i]; break; }
  }
  selectTreeNode(first ? first.ability_id : (treeNodes[0] || {}).ability_id);
}

function selectTreeNode(id) {
  treeSelected = id;

  var nodes = document.querySelectorAll('.tree-node');
  var idx = 0;
  treeNodes.forEach(function(n) {
    if (nodes[idx]) nodes[idx].classList.toggle('active', n.ability_id === id);
    idx++;
  });

  var n = null;
  treeNodes.forEach(function(x) { if (x.ability_id === id) n = x; });

  var info = document.getElementById('tree-info');
  if (!n) { info.innerHTML = ''; return; }

  var lack = [];
  if (!n.unlocked) lack.push('нужна предыдущая ступень');
  if (n.kills_have < n.kills_required) {
    lack.push('убитых ' + n.kills_have + ' из ' + n.kills_required);
  }

  var head = '<div class="tree-info-head">' +
      '<span class="tree-info-name">' + n.name + '</span>' +
      '<span class="tree-info-branch">' + n.branch + ' · ступень ' + n.tier + '</span>' +
    '</div>' +
    '<div class="tree-info-desc">' + n.description + '</div>';

  var meta = '<div class="tree-info-meta">' +
      '<span>' + n.cost_credits + ' кр</span>' +
      '<span>' + n.kills_required + ' убитых</span>' +
      '<span>' + formatLeft(n.train_seconds) + '</span>' +
    '</div>';

  info.innerHTML = head + meta;

  if (n.learned) {
    info.innerHTML += '<div class="tree-hint done">Освоено</div>';
    return;
  }
  if (n.in_training) {
    info.innerHTML += '<div class="tree-hint">Обучение идёт</div>';
    return;
  }
  if (lack.length) {
    info.innerHTML += '<div class="tree-hint">Не хватает: ' + lack.join(', ') + '</div>';
    return;
  }

  var go = document.createElement('button');
  go.className = 'tree-go';
  go.textContent = 'Начать обучение · ' + n.cost_credits;
  go.addEventListener('click', function() {
    go.disabled = true;
    supabase.rpc('start_hero_training', {
      p_unit_id: treeUnit.id,
      p_ability_id: n.ability_id
    }).then(function(r) {
      go.disabled = false;
      if (r.error) { alert('Не вышло: ' + r.error.message); return; }
      closeHeroTree();
      selectedUnit = null;
      hidePickup();
      loadUnits();
    });
  });
  info.appendChild(go);
}

// ===== панорамирование и масштаб полотна =====

function clampTreePan() {
  var vp = document.getElementById('tree-viewport');
  var world = document.getElementById('tree-world');
  var w = world.offsetWidth * treePan.scale;
  var h = world.offsetHeight * treePan.scale;

  // Если полотно уже влезает — держим по центру, иначе не даём уехать за край
  if (w <= vp.clientWidth) treePan.x = (vp.clientWidth - w) / 2;
  else treePan.x = Math.min(0, Math.max(vp.clientWidth - w, treePan.x));

  if (h <= vp.clientHeight) treePan.y = (vp.clientHeight - h) / 2;
  else treePan.y = Math.min(0, Math.max(vp.clientHeight - h, treePan.y));
}

function applyTreePan() {
  var world = document.getElementById('tree-world');
  world.style.transform = 'translate(' + treePan.x + 'px,' + treePan.y + 'px) ' +
                          'scale(' + treePan.scale + ')';
}

function initTreeGestures() {
  var vp = document.getElementById('tree-viewport');
  var drag = null, pinch = null, moved = 0;

  var dist = function(t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };
  var mid = function(t) {
    return { x: (t[0].clientX + t[1].clientX) / 2,
             y: (t[0].clientY + t[1].clientY) / 2 };
  };

  vp.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      var m = mid(e.touches), r = vp.getBoundingClientRect();
      pinch = { d: dist(e.touches), scale: treePan.scale,
                ax: m.x - r.left, ay: m.y - r.top,
                wx: (m.x - r.left - treePan.x) / treePan.scale,
                wy: (m.y - r.top - treePan.y) / treePan.scale };
      drag = null;
    } else if (e.touches.length === 1) {
      drag = { x: e.touches[0].clientX - treePan.x,
               y: e.touches[0].clientY - treePan.y };
      pinch = null;
      moved = 0;
    }
  }, { passive: true });

  vp.addEventListener('touchmove', function(e) {
    if (pinch && e.touches.length === 2) {
      var k = dist(e.touches) / (pinch.d || 1);
      treePan.scale = Math.max(0.45, Math.min(1.6, pinch.scale * k));
      // Тянем к пальцам: точка под пинчем остаётся на месте
      treePan.x = pinch.ax - pinch.wx * treePan.scale;
      treePan.y = pinch.ay - pinch.wy * treePan.scale;
      clampTreePan();
      applyTreePan();
      e.preventDefault();
    } else if (drag && e.touches.length === 1) {
      var nx = e.touches[0].clientX - drag.x;
      var ny = e.touches[0].clientY - drag.y;
      moved += Math.abs(nx - treePan.x) + Math.abs(ny - treePan.y);
      treePan.x = nx; treePan.y = ny;
      clampTreePan();
      applyTreePan();
      if (moved > 8) e.preventDefault();
    }
  }, { passive: false });

  vp.addEventListener('touchend', function(e) {
    if (e.touches.length === 0) { drag = null; pinch = null; }
  }, { passive: true });

  document.getElementById('tree-close')
    .addEventListener('click', closeHeroTree);
}

// ===== Боевые способности одарённого =====
// Наведение устроено как у остальных способностей: подсвеченные цели
// плюс подсказка снизу. Разница в том, что цель бывает и своя —
// лечение наводится на союзника, поэтому список целей собираем сами.

var heroAbility = null;

function startHeroAbility(unit, a) {
  heroAbility = { unit: unit, ability: a };
  upgradeAbility = null;
  attackingUnit = null;
  abilityUnit = null;
  areaPreview = null;
  hidePickup();

  // Купол накрывает своих вокруг героя — целиться некуда
  if (a.target_mode === 'self') {
    heroAbility = null;
    cbLastOwnAction = Date.now();
    supabase.rpc('use_hero_ability', {
      p_unit_id: unit.id, p_ability_id: a.ability_id
    }).then(function(r) {
      if (r.error) { alert(r.error.message); return; }
      var res = (r.data && r.data.length) ? r.data[0] : null;
      if (res) cbReportArea(a.name, unit, res);
      cancelTargeting();
      selectedUnit = null;
      loadUnits();
    });
    return;
  }

  // Площадная: бьём по клетке, а не по юниту
  if (a.target_mode === 'area') {
    groundTargets = [];
    showTargetHint(a.name, 'ткни в клетку — накроет радиус ' +
                   (a.range_cells) + ' от тебя', cancelTargeting);
    redrawScene();
    return;
  }

  if (a.target_mode === 'ally') {
    // Свои раненые в радиусе. Сервер всё равно перепроверит,
    // здесь только подсветка, чтобы не тыкать вслепую.
    groundTargets = [];
    unitsOnMap.forEach(function(u) {
      if (u.id === unit.id) return;
      if (u.x === null || u.x === undefined) return;
      if (u.owner_user_id !== currentUserId) return;

      var t = unitTypeById[u.unit_type] || {};
      if (u.hp >= (t.max_hp || 0) + (u.bonus_hp || 0)) return;
      if (heroGapTo(unit, u) > a.range_cells) return;

      groundTargets.push({ target_id: u.id, name: t.name, x: u.x, y: u.y,
                           hp: u.hp, unit_type: u.unit_type });
    });

    showTargetHint(a.name, groundTargets.length
      ? 'раненых рядом: ' + groundTargets.length
      : 'рядом все целы', cancelTargeting);
    redrawScene();
    return;
  }

  supabase.rpc('get_ground_targets', { p_unit_id: unit.id }).then(function(res) {
    var all = (!res.error && res.data) ? res.data : [];

    // Обычная атака бьёт на дальность оружия, а у способности своя
    groundTargets = all.filter(function(t) {
      return t.gap === null || t.gap === undefined || t.gap <= a.range_cells;
    });

    showTargetHint(a.name, groundTargets.length
      ? 'целей в радиусе: ' + groundTargets.length
      : 'целей в радиусе нет', cancelTargeting);
    redrawScene();
  });
}

// Зазор между корпусами двух юнитов — то же правило, что на сервере
function heroGapTo(a, b) {
  var ba = unitBox(a), bb = unitBox(b);
  var gx = Math.max(b.x - (a.x + ba.w - 1), a.x - (b.x + bb.w - 1), 0);
  var gy = Math.max(b.y - (a.y + ba.h - 1), a.y - (b.y + bb.h - 1), 0);
  return Math.max(gx, gy);
}

function handleHeroAbilityTap(cellX, cellY) {
  var a = heroAbility.ability;
  var unit = heroAbility.unit;

  if (a.target_mode === 'area') {
    cbLastOwnAction = Date.now();
    supabase.rpc('use_hero_ability', {
      p_unit_id: unit.id, p_ability_id: a.ability_id,
      p_x: cellX, p_y: cellY
    }).then(function(r) {
      if (r.error) { alert(r.error.message); return; }
      var res = (r.data && r.data.length) ? r.data[0] : null;
      if (res) cbReportArea(a.name, unit, res);
      cancelTargeting();
      selectedUnit = null;
      loadUnits();
    });
    return;
  }

  var pick = null;
  for (var i = 0; i < groundTargets.length; i++) {
    var t = groundTargets[i];
    // В списке целей нет типа юнита: габарит берём с карты, иначе
    // технику 2×2 можно было выбрать только по верхней левой клетке
    var tu = unitsOnMap.filter(function(u) { return u.id === t.target_id; })[0];
    var b = unitTypeById[t.unit_type || (tu && tu.unit_type)] || {};
    var w = b.width_cells || 1, h = b.height_cells || 1;
    if (cellX >= t.x && cellX < t.x + w && cellY >= t.y && cellY < t.y + h) {
      pick = t; break;
    }
  }

  if (!pick) { alert('Эта цель недоступна'); return; }

  var pickBefore = cbHpNow(pick);
  cbLastOwnAction = Date.now();
  supabase.rpc('use_hero_ability', {
    p_unit_id: unit.id,
    p_ability_id: a.ability_id,
    p_target_id: pick.target_id
  }).then(function(r) {
    if (r.error) { alert(r.error.message); return; }

    var res = (r.data && r.data.length) ? r.data[0] : null;
    if (res && a.target_mode === 'ally') {
      // Помощь своему: лечение, щит. Урона нет, есть итог в заметке.
      cbLastOwnAction = Date.now();
      cbReport({
        kind: 'heal', title: a.name,
        attacker: cbUnitPic(unit, 'mine'),
        target: cbTargetPic(pick, cbTargetUnit(pick)),
        lines: res.note ? [{ text: res.note, cls: 'muted' }] : []
      });
    } else if (res) {
      cbReportAbility(a.name, unit, pick, res, pickBefore);
    }

    cancelTargeting();
    selectedUnit = null;
    loadUnits();
  });
}

// ===== Запас планеты =====
// Ресурсы лежат на планете, а не в кошельке, поэтому показываем их там,
// где принимается решение — прямо в панели строительства.

var planetStock = [];

// Справочник ресурсов держим отдельно от запаса планеты. Запас приходит
// только по своим планетам и позже, чем рисуются карточки, поэтому
// названия из него не успевали подставиться и в панели светились коды.
var resourceNames = {};
var resourceColors = {};

function loadResourceNames(done) {
  if (Object.keys(resourceNames).length) { if (done) done(); return; }

  supabase.from('resources').select('id, name, color').then(function(res) {
    (res.error ? [] : (res.data || [])).forEach(function(r) {
      resourceNames[r.id] = r.name;
      resourceColors[r.id] = r.color;
    });
    if (done) done();
  });
}

function loadPlanetStock(done) {
  supabase.rpc('get_planet_stock', { p_system_id: systemId }).then(function(res) {
    planetStock = (res.error || !res.data) ? [] : res.data;
    if (done) done();
  });
}

function stockRow(resourceId) {
  for (var i = 0; i < planetStock.length; i++) {
    if (planetStock[i].resource === resourceId) return planetStock[i];
  }
  return null;
}

// Пока справочник не пришёл (или запрос сорвался), код ресурса не должен
// всплывать латиницей — держим русские названия под рукой
var RESOURCE_NAMES_RU = {
  ore: 'Руда', gas: 'Тибанна', crystals: 'Кристаллы', food: 'Продовольствие',
  durasteel: 'Дюрасталь', electronics: 'Электроника', cells: 'Топливные ячейки'
};

function resourceName(resourceId) {
  if (resourceNames[resourceId]) return resourceNames[resourceId];
  var r = stockRow(resourceId);
  return r ? r.name : (RESOURCE_NAMES_RU[resourceId] || resourceId);
}

// Есть ли на планете это сырьё — основное или попутное
function planetHasResource(resourceId) {
  var r = stockRow(resourceId);
  return !!r && (r.is_primary || r.is_secondary);
}

// Что цех потребляет за сутки: {"ore":60} превращается в «60 руды»
function consumesText(consumes) {
  if (!consumes) return '';
  var parts = [];
  for (var key in consumes) {
    if (!Object.prototype.hasOwnProperty.call(consumes, key)) continue;
    parts.push(consumes[key] + ' ' + resourceName(key).toLowerCase());
  }
  return parts.join(' + ');
}

// Попутное сырьё добывается вдвое медленнее — то же правило, что на сервере
function canAffordResources(cost) {
  if (!cost) return true;
  for (var key in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, key)) continue;
    var row = stockRow(key);
    if (!row || row.amount < cost[key]) return false;
  }
  return true;
}

function stockRateFor(type) {
  var r = stockRow(type.produces_resource);
  if (r && r.is_secondary && !r.is_primary) return Math.floor(type.produces_per_day / 2);
  return type.produces_per_day;
}

function renderStockStrip(slotIndex) {
  var box = document.getElementById('build-panel-box');
  var old = document.getElementById('stock-strip');
  if (old) old.remove();

  if (!planetStock.length) return;

  var strip = document.createElement('div');
  strip.id = 'stock-strip';

  var cap = planetStock[0].cap;
  strip.innerHTML = '<div class="stock-head">Запас планеты · предел ' + cap + '</div>';

  var row = document.createElement('div');
  row.className = 'stock-row';

  planetStock.forEach(function(r) {
    // Чего на планете нет и не производится — не засоряем строку
    if (!r.amount && !r.per_day && !r.is_primary && !r.is_secondary) return;

    var cell = document.createElement('div');
    cell.className = 'stock-cell';

    if (r.is_primary) cell.classList.add('primary');
    else if (r.is_secondary) cell.classList.add('secondary');

    // Цвет ресурса кромкой слева — тот же, что на плашках в карточке планеты
    if (r.color) cell.style.borderLeft = '3px solid ' + r.color;

    if (r.cap && r.amount >= r.cap) cell.classList.add('full');

    cell.innerHTML =
      '<span class="stock-name">' + r.name + '</span>' +
      '<span class="stock-val">' + r.amount + '</span>' +
      '<span class="stock-rate">' +
        (r.per_day ? '+' + r.per_day + ' в сутки'
         : r.is_primary ? 'нужна добыча'
         : r.is_secondary ? 'попутное' : '') +
      '</span>';

    row.appendChild(cell);
  });

  strip.appendChild(row);

  var title = box.querySelector('.build-panel-title');
  box.insertBefore(strip, title ? title.nextSibling : box.firstChild);
}

// ===== Логистический узел: конвои и общий рынок =====
// Три вкладки в одном окне: отправка своим, чужие лоты, свои лоты и брони.
// Всё, что касается денег и остатков, считает сервер — клиент только рисует.

var logiBuilding = null;
var logiTab = 'send';

function openLogisticsPanel(building) {
  logiBuilding = building;
  logiTab = 'send';
  document.getElementById('logi-panel').style.display = 'flex';
  document.getElementById('logi-title').textContent =
    (building.building_types || {}).name || 'Логистический узел';
  setLogiTab('send');
}

function closeLogisticsPanel() {
  document.getElementById('logi-panel').style.display = 'none';
  document.getElementById('logi-tabs').style.display = '';
  logiBuilding = null;
}

function setLogiTab(tab) {
  logiTab = tab;
  var tabs = document.querySelectorAll('.logi-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
  }

  var body = document.getElementById('logi-body');
  body.innerHTML = '<div class="logi-empty">Загрузка...</div>';

  if (tab === 'send') renderLogiSend(body);
  else if (tab === 'market') renderLogiMarket(body);
  else renderLogiMine(body);
}

function logiSection(title) {
  var d = document.createElement('div');
  d.className = 'logi-section';
  d.textContent = title;
  return d;
}

// Счётчик с крупным шагом: ресурсы считают десятками
function logiAmount(max) {
  var box = document.createElement('div');
  box.className = 'logi-qty';

  var minus = document.createElement('button');
  minus.className = 'logi-qty-btn'; minus.textContent = '−';
  var val = document.createElement('span');
  val.className = 'logi-qty-value'; val.textContent = Math.min(10, max);
  var plus = document.createElement('button');
  plus.className = 'logi-qty-btn'; plus.textContent = '+';
  var all = document.createElement('button');
  all.className = 'logi-qty-btn'; all.textContent = 'всё';

  minus.addEventListener('click', function() {
    val.textContent = Math.max(1, parseInt(val.textContent, 10) - 10);
  });
  plus.addEventListener('click', function() {
    val.textContent = Math.min(max, parseInt(val.textContent, 10) + 10);
  });
  all.addEventListener('click', function() { val.textContent = max; });

  box.appendChild(minus); box.appendChild(val); box.appendChild(plus); box.appendChild(all);
  box.valueEl = val;
  return box;
}

// ---------- вкладка «Отправка» ----------
// Конвой это командир с приписанными кораблями: груз ложится в их трюмы,
// флот прыгает по гиперпути и разгружается по прибытии. Поэтому сначала
// выбирается командир — от него зависит, сколько вообще можно увезти.
function renderLogiSend(body) {
  var sysId = logiBuilding.system_id;

  Promise.all([
    supabase.rpc('get_planet_stock', { p_system_id: sysId }),
    supabase.rpc('get_convoy_destinations', { p_from: sysId }),
    supabase.rpc('get_convoy_commanders', { p_system_id: sysId }),
    supabase.rpc('get_my_convoys')
  ]).then(function(r) {
    var stock = (r[0].error ? [] : (r[0].data || [])).filter(function(x) { return x.amount > 0; });
    var dests = r[1].error ? [] : (r[1].data || []);
    var cmds = (r[2].error ? [] : (r[2].data || [])).filter(function(c) { return !c.busy; });
    var convoys = r[3].error ? [] : (r[3].data || []);

    body.innerHTML = '';
    body.appendChild(logiSection('Отправить конвой'));

    var why = null;
    if (!cmds.length) why = 'На планете нет свободных командиров';
    else if (!stock.length) why = 'На складе планеты пусто';
    else if (!dests.length) why = 'Рядом нет планет своей стороны — конвой ходит к соседям по гиперпути';

    if (why) {
      var e = document.createElement('div');
      e.className = 'logi-empty';
      e.textContent = why;
      body.appendChild(e);
    } else {
      body.appendChild(buildConvoyForm(sysId, stock, dests, cmds));
    }

    body.appendChild(logiSection('Конвои в пути'));

    if (!convoys.length) {
      var e3 = document.createElement('div');
      e3.className = 'logi-empty';
      e3.textContent = 'Конвоев нет';
      body.appendChild(e3);
      return;
    }

    var STAGE = {
      to_pickup: 'летит к продавцу',
      to_dest:   'везёт груз',
      returning: 'возвращается'
    };

    convoys.forEach(function(c) {
      var row = document.createElement('div');
      row.className = 'logi-row';

      var state = c.status === 'in_flight'
                    ? (STAGE[c.stage] || 'в пути') + ' · ' + formatLeft(c.seconds_left)
                : c.status === 'delivered' ? 'выполнен'
                : c.status === 'stalled' ? 'встал' : c.status;

      var path = c.kind === 'market' && c.pickup_name
        ? c.pickup_name + ' → ' + c.to_name
        : c.from_name + ' → ' + c.to_name;

      row.innerHTML =
        '<div class="logi-info">' +
          '<div class="logi-name">' + (c.cargo_text || 'груз') + '</div>' +
          '<div class="logi-sub">' + path + (c.return_home ? ' · и обратно' : '') + '</div>' +
        '</div>' +
        '<div class="logi-state' + (c.status === 'stalled' ? ' bad' : '') + '">' +
          state + '</div>';
      body.appendChild(row);
    });
  });
}

function buildConvoyForm(sysId, stock, dests, cmds) {
  var form = document.createElement('div');
  form.className = 'logi-form';

  // --- командир ---
  var cmdSel = document.createElement('select');
  cmdSel.className = 'logi-select';
  cmds.forEach(function(c) {
    var o = document.createElement('option');
    o.value = c.commander_id;
    o.textContent = (c.name || 'Без имени') + ' · кораблей ' + c.ships +
                    ' · влезет ' + c.free_units + ' ед.';
    cmdSel.appendChild(o);
  });

  // --- куда ---
  var dstSel = document.createElement('select');
  dstSel.className = 'logi-select';
  dests.forEach(function(d) {
    var o = document.createElement('option');
    o.value = d.system_id;
    o.textContent = d.name + ' · ' +
                    (d.hops > 1 ? d.hops + ' прыжка · ' : '') +
                    formatLeft(d.seconds) +
                    (d.controlled ? '' : ' · союзник');
    dstSel.appendChild(o);
  });

  var readyNote = document.createElement('div');
  readyNote.className = 'logi-note';

  var capLine = document.createElement('div');
  capLine.className = 'logi-cap';

  form.appendChild(cmdSel);
  form.appendChild(readyNote);
  form.appendChild(dstSel);

  // --- груз: по строке на каждый ресурс склада ---
  var picks = {};
  var rows = document.createElement('div');
  rows.className = 'logi-cargo';

  function currentCmd() {
    var found = null;
    cmds.forEach(function(c) { if (c.commander_id === cmdSel.value) found = c; });
    return found;
  }

  function total() {
    var t = 0;
    for (var k in picks) if (Object.prototype.hasOwnProperty.call(picks, k)) t += picks[k];
    return t;
  }

  function refresh() {
    var c = currentCmd();
    var free = c ? c.free_units : 0;
    var t = total();

    capLine.textContent = 'Груз ' + t + ' из ' + free + ' ед.';
    capLine.classList.toggle('over', t > free);

    // Не весь флот в полосе — прыжок не состоится, говорим заранее
    if (c && c.ready < c.ships) {
      readyNote.textContent = 'В зоне прыжка ' + c.ready + ' из ' + c.ships +
                              ' кораблей — сначала выведи весь флот в полосу';
      readyNote.classList.add('warn');
    } else {
      readyNote.textContent = '';
      readyNote.classList.remove('warn');
    }

    go.disabled = t < 1 || t > free || !c || c.ready < c.ships;
  }

  stock.forEach(function(x) {
    picks[x.resource] = 0;

    var line = document.createElement('div');
    line.className = 'logi-cargo-row';
    if (x.color) line.style.borderLeft = '3px solid ' + x.color;

    var label = document.createElement('div');
    label.className = 'logi-cargo-name';
    label.innerHTML = x.name + '<span>на складе ' + x.amount + '</span>';

    var qty = document.createElement('div');
    qty.className = 'logi-qty';

    var minus = document.createElement('button');
    minus.className = 'logi-qty-btn'; minus.textContent = '−';
    var val = document.createElement('span');
    val.className = 'logi-qty-value'; val.textContent = '0';
    var plus = document.createElement('button');
    plus.className = 'logi-qty-btn'; plus.textContent = '+';
    var fill = document.createElement('button');
    fill.className = 'logi-qty-btn'; fill.textContent = 'макс';

    function set(n) {
      picks[x.resource] = Math.max(0, Math.min(x.amount, n));
      val.textContent = picks[x.resource];
      refresh();
    }

    minus.addEventListener('click', function() { set(picks[x.resource] - 10); });
    plus.addEventListener('click', function() { set(picks[x.resource] + 10); });
    // «макс» — сколько этого ресурса ещё поместится во флот
    fill.addEventListener('click', function() {
      var c = currentCmd();
      var room = (c ? c.free_units : 0) - (total() - picks[x.resource]);
      set(Math.min(x.amount, Math.max(0, room)));
    });

    qty.appendChild(minus); qty.appendChild(val); qty.appendChild(plus); qty.appendChild(fill);
    line.appendChild(label);
    line.appendChild(qty);
    rows.appendChild(line);
  });

  form.appendChild(rows);
  form.appendChild(capLine);

  var back = makeReturnToggle();
  form.appendChild(back.el);

  var go = document.createElement('button');
  go.className = 'logi-go';
  go.textContent = 'Отправить конвой';
  go.addEventListener('click', function() {
    var cargo = {};
    for (var k in picks) {
      if (Object.prototype.hasOwnProperty.call(picks, k) && picks[k] > 0) cargo[k] = picks[k];
    }

    go.disabled = true;
    supabase.rpc('dispatch_convoy', {
      p_commander_id: cmdSel.value,
      p_to_system: dstSel.value,
      p_cargo: cargo,
      p_return_home: back.value()
    }).then(function(res) {
      if (res.error) { alert(res.error.message); refresh(); return; }
      setLogiTab('send');
    });
  });

  cmdSel.addEventListener('change', refresh);
  form.appendChild(go);
  refresh();

  return form;
}

// ---------- вкладка «Рынок» ----------
function renderLogiMarket(body) {
  Promise.all([
    supabase.rpc('get_market_lots', { p_resource: null }),
    supabase.rpc('get_my_market_orders')
  ]).then(function(r) {
    var lots = (r[0].error ? [] : (r[0].data || [])).filter(function(l) { return !l.mine; });
    var orders = r[1].error ? [] : (r[1].data || []);

    body.innerHTML = '';

    if (orders.length) {
      body.appendChild(logiSection('Оплачено, ждёт вывоза'));
      orders.forEach(function(o) {
        var wrap = document.createElement('div');
        wrap.className = 'logi-order';

        var row = document.createElement('div');
        row.className = 'logi-row';
        row.innerHTML =
          '<div class="logi-info">' +
            '<div class="logi-name">' + o.resource_name + ' · ' + o.amount_left + '</div>' +
            '<div class="logi-sub">У продавца на планете ' + o.system_name +
              ' · бронь ещё ' + formatLeft(o.seconds_left) + '</div>' +
          '</div>';

        if (o.fleet_sent) {
          var sent = document.createElement('div');
          sent.className = 'logi-state';
          sent.textContent = 'флот в пути';
          row.appendChild(sent);
          wrap.appendChild(row);
        } else {
          var fetch = document.createElement('button');
          fetch.className = 'logi-go small';
          fetch.textContent = 'Вывезти флотом';
          row.appendChild(fetch);
          wrap.appendChild(row);

          var formBox = document.createElement('div');
          wrap.appendChild(formBox);

          fetch.addEventListener('click', function() {
            if (formBox.firstChild) { formBox.innerHTML = ''; return; }
            buildPickupForm(o, formBox);
          });
        }

        body.appendChild(wrap);
      });

      var hint = document.createElement('div');
      hint.className = 'logi-note';
      hint.textContent = 'Флот сам долетит до продавца по своим мирам, заберёт покупку ' +
                         'и отвезёт на выбранную планету. Деньги продавец получит при погрузке.';
      body.appendChild(hint);
    }

    body.appendChild(logiSection('Лоты галактики'));

    if (!lots.length) {
      var e = document.createElement('div');
      e.className = 'logi-empty';
      e.textContent = 'Сейчас никто ничего не продаёт';
      body.appendChild(e);
      return;
    }

    lots.forEach(function(l) {
      var row = document.createElement('div');
      row.className = 'logi-row lot' + (l.foreign_side ? ' foreign' : '');

      var info = document.createElement('div');
      info.className = 'logi-info';
      info.innerHTML =
        '<div class="logi-name">' + l.resource_name + ' · ' + l.price_per_unit + ' кр за ед.</div>' +
        '<div class="logi-sub">' + escHtml(l.seller_name) + ' · ' + l.system_name +
          ' · в наличии ' + l.amount_left +
          (l.foreign_side ? ' · противник' : '') + '</div>';
      row.appendChild(info);

      var qty = logiAmount(l.amount_left);
      row.appendChild(qty);

      var buy = document.createElement('button');
      buy.className = 'logi-go small';
      buy.textContent = 'Купить';
      buy.addEventListener('click', function() {
        var n = parseInt(qty.valueEl.textContent, 10);
        if (!confirm('Купить ' + n + ' за ' + (n * l.price_per_unit) +
                     ' кр? Забирать придётся своим кораблём с планеты ' +
                     l.system_name + '.')) return;
        buy.disabled = true;
        supabase.rpc('buy_market_lot', { p_lot_id: l.lot_id, p_amount: n })
          .then(function(res) {
            buy.disabled = false;
            if (res.error) { alert(res.error.message); return; }
            setLogiTab('market');
          });
      });
      row.appendChild(buy);

      body.appendChild(row);
    });
  });
}

// ---------- вкладка «Мои лоты» ----------
function renderLogiMine(body) {
  var sysId = logiBuilding.system_id;

  Promise.all([
    supabase.rpc('get_planet_stock', { p_system_id: sysId }),
    supabase.rpc('get_my_market_lots')
  ]).then(function(r) {
    var stock = (r[0].error ? [] : (r[0].data || [])).filter(function(x) { return x.amount > 0; });
    var lots = r[1].error ? [] : (r[1].data || []);

    body.innerHTML = '';
    body.appendChild(logiSection('Выставить лот'));

    if (!stock.length) {
      var e = document.createElement('div');
      e.className = 'logi-empty';
      e.textContent = 'На складе планеты пусто';
      body.appendChild(e);
    } else {
      var form = document.createElement('div');
      form.className = 'logi-form';

      var resSel = document.createElement('select');
      resSel.className = 'logi-select';
      stock.forEach(function(x) {
        var o = document.createElement('option');
        o.value = x.resource;
        o.textContent = x.name + ' · ' + x.amount;
        resSel.appendChild(o);
      });

      var openSel = document.createElement('select');
      openSel.className = 'logi-select';
      var o1 = document.createElement('option');
      o1.value = 'faction'; o1.textContent = 'Только своим';
      var o2 = document.createElement('option');
      o2.value = 'all'; o2.textContent = 'Всем, включая противника';
      openSel.appendChild(o1); openSel.appendChild(o2);

      var price = document.createElement('input');
      price.className = 'logi-input';
      price.type = 'number';
      price.min = '1';
      price.value = '20';
      price.placeholder = 'Цена за единицу';

      var qty = logiAmount(stock[0].amount);
      resSel.addEventListener('change', function() {
        var pick = null;
        stock.forEach(function(x) { if (x.resource === resSel.value) pick = x; });
        qty.valueEl.textContent = Math.min(10, pick ? pick.amount : 1);
      });

      var go = document.createElement('button');
      go.className = 'logi-go';
      go.textContent = 'Выставить';
      go.addEventListener('click', function() {
        go.disabled = true;
        supabase.rpc('create_market_lot', {
          p_system_id: sysId,
          p_resource: resSel.value,
          p_amount: parseInt(qty.valueEl.textContent, 10),
          p_price: parseInt(price.value, 10) || 1,
          p_open_to: openSel.value
        }).then(function(res) {
          go.disabled = false;
          if (res.error) { alert(res.error.message); return; }
          setLogiTab('mine');
        });
      });

      form.appendChild(resSel);
      form.appendChild(price);
      form.appendChild(openSel);
      form.appendChild(qty);
      form.appendChild(go);
      body.appendChild(form);
    }

    body.appendChild(logiSection('Мои лоты'));

    if (!lots.length) {
      var e2 = document.createElement('div');
      e2.className = 'logi-empty';
      e2.textContent = 'Ты ничего не продаёшь';
      body.appendChild(e2);
      return;
    }

    lots.forEach(function(l) {
      var row = document.createElement('div');
      row.className = 'logi-row';

      var info = document.createElement('div');
      info.className = 'logi-info';
      info.innerHTML =
        '<div class="logi-name">' + l.resource_name + ' · ' + l.price_per_unit + ' кр за ед.</div>' +
        '<div class="logi-sub">' + l.system_name + ' · осталось ' + l.amount_left +
          (l.reserved ? ' · забронировано ' + l.reserved : '') +
          ' · ' + (l.open_to === 'all' ? 'открыт всем' : 'только своим') + '</div>';
      row.appendChild(info);

      var off = document.createElement('button');
      off.className = 'logi-go small danger';
      off.textContent = 'Снять';
      off.addEventListener('click', function() {
        off.disabled = true;
        supabase.rpc('cancel_market_lot', { p_lot_id: l.lot_id }).then(function(res) {
          off.disabled = false;
          if (res.error) { alert(res.error.message); return; }
          setLogiTab('mine');
        });
      });
      row.appendChild(off);

      body.appendChild(row);
    });
  });
}

// ===== Торговый пост =====
// Клапан для забитых складов: сбыть излишки сразу в кредиты, без поиска
// покупателя и без перевозки. Платит меньше рынка — в этом и смысл.
// Окно переиспользует панель узла, только без вкладок.

function openTradePanel(building) {
  logiBuilding = building;
  document.getElementById('logi-panel').style.display = 'flex';
  document.getElementById('logi-tabs').style.display = 'none';
  document.getElementById('logi-title').textContent =
    (building.building_types || {}).name || 'Торговый пост';
  renderTradePanel();
}

function renderTradePanel() {
  var body = document.getElementById('logi-body');
  body.innerHTML = '<div class="logi-empty">Загрузка...</div>';

  supabase.rpc('get_trade_prices', { p_system_id: logiBuilding.system_id })
    .then(function(res) {
      if (res.error) {
        body.innerHTML = '<div class="logi-empty">' + res.error.message + '</div>';
        return;
      }

      var rows = (res.data || []).filter(function(r) { return r.amount > 0; });

      body.innerHTML = '';
      body.appendChild(logiSection('Скупка излишков'));

      if (!rows.length) {
        var e = document.createElement('div');
        e.className = 'logi-empty';
        e.textContent = 'На складе планеты пусто';
        body.appendChild(e);
        return;
      }

      rows.forEach(function(r) {
        var row = document.createElement('div');
        row.className = 'logi-row';
        if (r.color) row.style.borderLeft = '3px solid ' + r.color;
        row.style.paddingLeft = r.color ? '8px' : '';

        var info = document.createElement('div');
        info.className = 'logi-info';
        info.innerHTML =
          '<div class="logi-name">' + r.name + ' · ' + r.price + ' кр за ед.</div>' +
          '<div class="logi-sub">На складе ' + r.amount +
            ' · за всё ' + r.total + ' кр</div>';
        row.appendChild(info);

        var qty = logiAmount(r.amount);
        row.appendChild(qty);

        var sell = document.createElement('button');
        sell.className = 'logi-go small';
        sell.textContent = 'Продать';
        sell.addEventListener('click', function() {
          var n = parseInt(qty.valueEl.textContent, 10);
          sell.disabled = true;
          supabase.rpc('sell_to_trade_post', {
            p_system_id: logiBuilding.system_id,
            p_resource: r.resource,
            p_amount: n
          }).then(function(r2) {
            sell.disabled = false;
            if (r2.error) { alert(r2.error.message); return; }
            // Счётчик кредитов обновится сам: он слушает profiles по realtime
            renderTradePanel();
          });
        });
        row.appendChild(sell);

        body.appendChild(row);
      });

      var note = document.createElement('div');
      note.className = 'logi-note';
      note.textContent = 'Пост платит меньше, чем можно выручить на рынке. ' +
                         'Зато сразу и без перевозки.';
      body.appendChild(note);
    });
}

// ===== Разведка: чужие флоты на ближних гиперпутях =====
// Перехватить можно только то, о чём знаешь. Штаб показывает, кто идёт
// рядом, с чем и сколько ему осталось лететь.

function loadIntel(building, box) {
  supabase.rpc('get_enemy_transits', { p_system_id: building.system_id })
    .then(function(res) {
      if (res.error) {
        box.innerHTML = '<div class="intel-head">Разведка</div>' +
                        '<div class="intel-empty">Не удалось получить сводку</div>';
        return;
      }

      var rows = res.data || [];
      box.innerHTML = '<div class="intel-head">Разведка · чужие перелёты рядом</div>';

      if (!rows.length) {
        var e = document.createElement('div');
        e.className = 'intel-empty';
        e.textContent = 'Движения не замечено';
        box.appendChild(e);
        return;
      }

      rows.forEach(function(t) {
        var row = document.createElement('div');
        row.className = 'intel-row' + (t.cargo ? ' loaded' : '');

        row.innerHTML =
          '<div class="intel-info">' +
            '<div class="intel-route">' + t.from_name + ' → ' + t.to_name + '</div>' +
            '<div class="intel-sub">' + escHtml(t.owner_name) +
              ' · ' + escHtml(t.commander_name || 'без имени') +
              ' · кораблей ' + t.ships + '</div>' +
            (t.cargo
              ? '<div class="intel-cargo">Везут: ' + t.cargo + '</div>'
              : '<div class="intel-sub dim">Трюмы пусты</div>') +
          '</div>' +
          '<div class="intel-eta">' + formatLeft(t.seconds_left) + '</div>';

        box.appendChild(row);

        // Выйти наперехват можно только с конца того же пути: прыжок идёт
        // по прямой, из другого угла карты не дотянуться
        var reachable = t.lane_system &&
          (t.from_system === building.system_id || t.to_system === building.system_id);

        if (reachable) {
          var go = document.createElement('button');
          go.className = 'intel-go';
          go.textContent = 'Выйти на перехват';
          go.addEventListener('click', function() {
            go.disabled = true;
            showInterceptChoice(building, t, box, go);
          });
          box.appendChild(go);
        }
      });

      var note = document.createElement('div');
      note.className = 'intel-note';
      note.textContent = 'Сводка охватывает пути через эту систему и соседние.';
      box.appendChild(note);
    });
}

// Выбор командира для перехвата. Отдельным списком под строкой сводки:
// важно видеть, сколько кораблей у каждого уже стоит в зоне прыжка.
function showInterceptChoice(building, transit, box, btn) {
  var old = document.getElementById('intercept-choice');
  if (old) old.remove();

  supabase.rpc('get_my_commanders_at', { p_system_id: building.system_id })
    .then(function(res) {
      btn.disabled = false;

      var wrap = document.createElement('div');
      wrap.id = 'intercept-choice';
      wrap.className = 'intel-choice';

      var free = (res.error ? [] : (res.data || [])).filter(function(c) {
        return !c.busy && c.ships > 0;
      });

      if (!free.length) {
        wrap.innerHTML = '<div class="intel-empty">Свободных командиров с флотом ' +
                         'на этой планете нет</div>';
        box.insertBefore(wrap, btn.nextSibling);
        return;
      }

      wrap.innerHTML = '<div class="intel-choice-head">Кого отправить</div>';

      free.forEach(function(c) {
        var row = document.createElement('div');
        row.className = 'intel-cmd';

        var ok = c.ready === c.ships;
        row.innerHTML =
          '<div class="intel-info">' +
            '<div class="intel-route">' + escHtml(c.name || 'Без имени') + '</div>' +
            '<div class="intel-sub' + (ok ? '' : ' warn') + '">' +
              'в зоне прыжка ' + c.ready + ' из ' + c.ships + '</div>' +
          '</div>';

        var send = document.createElement('button');
        send.className = 'intel-go small';
        send.textContent = 'Вперёд';
        send.addEventListener('click', function() {
          send.disabled = true;
          supabase.rpc('start_interception', {
            p_commander_id: c.commander_id,
            p_target_commander: transit.commander_id
          }).then(function(r2) {
            send.disabled = false;
            if (r2.error) { alert(r2.error.message); return; }
            alert('Флот вышел на перехват. Встреча в пустоте на пути ' +
                  transit.from_name + ' — ' + transit.to_name + '.');
            wrap.remove();
            loadIntel(building, box);
          });
        });

        row.appendChild(send);
        wrap.appendChild(row);
      });

      box.insertBefore(wrap, btn.nextSibling);
    });
}

// ===== Экономические постройки =====
// Добыча, передел и склады не нанимают юнитов и не изучают, поэтому
// линия производства им ни к чему. Вместо неё — что постройка делает
// и что лежит на складе планеты. Окно открывается только владельцу:
// чужой видит нейтральную карточку, а сервер и сам не отдаёт состояние
// производства и запас никому, кроме хозяина планеты.

function isEconomyBuilding(code) {
  if (!code || !buildingTypes) return false;
  var t = null;
  for (var i = 0; i < buildingTypes.length; i++) {
    if (buildingTypes[i].code === code) { t = buildingTypes[i]; break; }
  }
  return !!t && (!!t.produces_resource || (t.storage_bonus || 0) > 0);
}

var ECONOMY_STATUS = {
  working:    { text: 'Работает',                          cls: 'ok' },
  building:   { text: 'Ещё строится',                      cls: 'dim' },
  no_deposit: { text: 'На планете нет залежи',             cls: 'bad' },
  no_input:   { text: 'Простаивает: не хватает сырья',     cls: 'warn' },
  no_room:    { text: 'Простаивает: склад переполнен',     cls: 'warn' },
  passive:    { text: 'Работает постоянно',                cls: 'ok' }
};

function openEconomyPanel(building) {
  logiBuilding = building;
  document.getElementById('logi-panel').style.display = 'flex';
  document.getElementById('logi-tabs').style.display = 'none';
  document.getElementById('logi-title').textContent =
    (building.building_types || {}).name || 'Постройка';

  var body = document.getElementById('logi-body');
  body.innerHTML = '<div class="logi-empty">Загрузка...</div>';

  var done = 0, status = null;
  function step() {
    done++;
    if (done < 3) return;
    renderEconomyPanel(body, status);
  }

  supabase.rpc('get_building_status', { p_building_id: building.id }).then(function(res) {
    status = (!res.error && res.data && res.data.length) ? res.data[0] : null;
    step();
  });
  loadPlanetStock(step);
  loadResourceNames(step);
}

function renderEconomyPanel(body, st) {
  body.innerHTML = '';

  // --- что постройка делает ---
  if (st) {
    body.appendChild(logiSection(st.produces_resource ? 'Производство' : 'Назначение'));

    var card = document.createElement('div');
    card.className = 'eco-card';
    if (st.produces_color) card.style.borderLeftColor = st.produces_color;

    var what = '';
    var eats = consumesText(st.consumes);

    if (st.produces_resource && eats) {
      what = 'Перерабатывает ' + eats + ' → ' + st.produces_name + ' ' + st.per_day + ' в сутки';
    } else if (st.produces_resource) {
      what = 'Добывает ' + st.produces_name + ' · ' + st.per_day + ' в сутки';
    } else if (st.storage_bonus > 0) {
      what = 'Поднимает предел запаса планеты на ' + st.storage_bonus +
             ' по каждому ресурсу';
    } else {
      for (var bi = 0; bi < buildingTypes.length; bi++) {
        if (buildingTypes[bi].code === st.code) {
          what = buildingTypes[bi].description || '';
          break;
        }
      }
    }

    var stat = ECONOMY_STATUS[st.status] || ECONOMY_STATUS.working;
    var next = '';
    if (st.next_at && (st.status === 'working')) {
      var left = Math.max(0, Math.round((new Date(st.next_at).getTime() - Date.now()) / 1000));
      next = left > 0 ? ' · следующая выдача через ' + formatLeft(left) : ' · выдача вот-вот';
    }

    card.innerHTML =
      '<div class="eco-what">' + what + '</div>' +
      '<div class="eco-status ' + stat.cls + '">' + stat.text + next + '</div>';
    body.appendChild(card);
  }

  // --- склад планеты ---
  var cap = planetStock.length ? planetStock[0].cap : 0;
  body.appendChild(logiSection('Склад планеты · предел ' + cap));

  var rows = planetStock.filter(function(r) {
    return r.amount > 0 || r.per_day > 0 || r.is_primary || r.is_secondary;
  });

  if (!rows.length) {
    var e = document.createElement('div');
    e.className = 'logi-empty';
    e.textContent = 'Склад пуст';
    body.appendChild(e);
    return;
  }

  rows.forEach(function(r) {
    var row = document.createElement('div');
    row.className = 'eco-stock';
    var color = r.color || '#2a3644';
    row.style.borderLeftColor = color;

    var pct = cap ? Math.min(100, Math.round(r.amount / cap * 100)) : 0;
    var note = r.per_day ? '+' + r.per_day + ' в сутки'
             : r.is_primary ? 'основное, нужна добыча'
             : r.is_secondary ? 'попутное' : '';

    row.innerHTML =
      '<div class="eco-stock-top">' +
        '<span class="eco-stock-name">' + r.name + '</span>' +
        '<span class="eco-stock-val' + (r.amount >= cap ? ' full' : '') + '">' +
          r.amount + '</span>' +
      '</div>' +
      '<div class="eco-bar"><i style="width:' + pct + '%;background:' + color + '"></i></div>' +
      (note ? '<div class="eco-stock-note">' + note + '</div>' : '');

    body.appendChild(row);
  });
}

// Переключатель «вернуться домой»: бывает, что флот нужен именно там,
// куда он доставил, поэтому решает игрок каждый раз заново.
function makeReturnToggle() {
  var on = false;
  var el = document.createElement('button');
  el.type = 'button';
  el.className = 'logi-toggle';

  function paint() {
    el.classList.toggle('on', on);
    el.innerHTML = '<i></i><span>' +
      (on ? 'После доставки вернуться на эту планету'
          : 'После доставки остаться там') + '</span>';
  }

  el.addEventListener('click', function() { on = !on; paint(); });
  paint();

  return { el: el, value: function() { return on; } };
}

// Вывоз покупки флотом: командир на этой планете, куда выгрузить,
// возвращаться ли. Путь к продавцу и к получателю сервер проложит сам.
function buildPickupForm(order, box) {
  box.innerHTML = '<div class="logi-empty">Загрузка...</div>';
  var sysId = logiBuilding.system_id;

  Promise.all([
    supabase.rpc('get_convoy_commanders', { p_system_id: sysId }),
    supabase.rpc('get_convoy_destinations', { p_from: sysId })
  ]).then(function(r) {
    var cmds = (r[0].error ? [] : (r[0].data || [])).filter(function(c) { return !c.busy; });
    var dests = r[1].error ? [] : (r[1].data || []);

    box.innerHTML = '';
    var form = document.createElement('div');
    form.className = 'logi-form logi-pickup';

    if (!cmds.length) {
      form.innerHTML = '<div class="logi-empty">На этой планете нет свободных командиров</div>';
      box.appendChild(form);
      return;
    }

    var cmdSel = document.createElement('select');
    cmdSel.className = 'logi-select';
    cmds.forEach(function(c) {
      var o = document.createElement('option');
      o.value = c.commander_id;
      o.textContent = (c.name || 'Без имени') + ' · влезет ' + c.free_units + ' ед.';
      cmdSel.appendChild(o);
    });

    // Куда выгрузить: сюда же или на любую свою планету
    var dstSel = document.createElement('select');
    dstSel.className = 'logi-select';
    var here = document.createElement('option');
    here.value = sysId;
    here.textContent = 'Сюда, на эту планету';
    dstSel.appendChild(here);
    dests.forEach(function(d) {
      var o = document.createElement('option');
      o.value = d.system_id;
      o.textContent = d.name + (d.controlled ? '' : ' · союзник');
      dstSel.appendChild(o);
    });

    var fit = document.createElement('div');
    fit.className = 'logi-cap';

    var back = makeReturnToggle();

    var go = document.createElement('button');
    go.className = 'logi-go';
    go.textContent = 'Отправить за покупкой';

    function refresh() {
      var c = null;
      cmds.forEach(function(x) { if (x.commander_id === cmdSel.value) c = x; });
      var free = c ? c.free_units : 0;
      fit.textContent = 'Покупка ' + order.amount_left + ' из ' + free + ' ед. свободного места';
      fit.classList.toggle('over', order.amount_left > free);

      var notReady = c && c.ready < c.ships;
      go.disabled = !c || order.amount_left > free || notReady;
      go.textContent = notReady ? 'Сначала выведи весь флот в полосу прыжка'
                                : 'Отправить за покупкой';
    }

    // «Сюда» — и возвращаться уже некуда: скрываем переключатель
    dstSel.addEventListener('change', function() {
      back.el.style.display = dstSel.value === sysId ? 'none' : '';
    });
    back.el.style.display = 'none';

    cmdSel.addEventListener('change', refresh);

    go.addEventListener('click', function() {
      go.disabled = true;
      supabase.rpc('dispatch_market_pickup', {
        p_commander_id: cmdSel.value,
        p_order_id: order.order_id,
        p_to_system: dstSel.value,
        p_return_home: dstSel.value === sysId ? false : back.value()
      }).then(function(res) {
        if (res.error) { alert(res.error.message); refresh(); return; }
        setLogiTab('market');
      });
    });

    form.appendChild(cmdSel);
    form.appendChild(dstSel);
    form.appendChild(back.el);
    form.appendChild(fit);
    form.appendChild(go);
    box.appendChild(form);
    refresh();
  });
}

// ===== Инженер и полевые постройки =====
// Окопы, бункеры, турели и прочее ставит инженер рядом с собой. Всё
// решает сервер: где можно строить, хватает ли денег и склада, кто кого
// видит. Клиент заранее подсвечивает подходящие клетки и рисует то, что
// пропустил туман войны: свои постройки фракция видит всегда, чужие —
// только в обзоре войск, а маскировочную сеть — лишь подойдя вплотную.

var fieldStructures = [];
var structTypeById = {};
var structResearchDone = {};
var structDaySeconds = 86400;
var structBuildRange = 2;
var structTimer = null;
var selectedStructure = null;
var placingStructure = null;      // { unit, type, preview }
var groundStructTargets = [];

var STRUCT_KIND_ROLE = {
  trench: 'Укрытие', bunker: 'Укрытие', camo: 'Маскировка', turret: 'Оборона',
  jammer: 'Радиоэлектроника', radar: 'Разведка', extractor: 'Добыча', cantina: 'Заработок'
};

function loadStructureTypes() {
  return Promise.all([
    supabase.from('structure_types').select('*').order('sort_order'),
    supabase.from('game_settings').select('key, value')
      .in('key', ['settlement_day_seconds', 'engineer_build_range'])
  ]).then(function(r) {
    structTypeById = {};
    (r[0].error ? [] : (r[0].data || [])).forEach(function(t) { structTypeById[t.id] = t; });
    (r[1].error ? [] : (r[1].data || [])).forEach(function(s) {
      if (s.key === 'settlement_day_seconds') structDaySeconds = parseInt(s.value, 10) || 86400;
      if (s.key === 'engineer_build_range') structBuildRange = parseInt(s.value, 10) || 2;
    });
  });
}

function loadStructures() {
  if (!systemId) return Promise.resolve();
  return supabase.from('field_structures').select('*').eq('system_id', systemId).then(function(res) {
    fieldStructures = (res.error || !res.data) ? [] : res.data;

    // Выбранная постройка могла исчезнуть или смениться прочность
    if (selectedStructure) {
      var fresh = fieldStructures.filter(function(s) { return s.id === selectedStructure.id; })[0];
      if (!fresh) { selectedStructure = null; hidePickup(); }
      else { selectedStructure = fresh; if (structPanelOpen()) openStructurePanel(fresh, true); }
    }

    updateStructTimer();
    redrawScene();
    // Радар достроили или снесли — обзор поменялся
    gbSoon('vision', loadVision, 120);
    if (window.sceneLoader) sceneLoader.mark('structures');
  });
}

function structReady(s) {
  return !s.completes_at || new Date(s.completes_at).getTime() <= gbServerNow();
}

// Пока что-то строится, раз в секунду перерисовываем отсчёт
function updateStructTimer() {
  var pending = fieldStructures.some(function(s) { return !structReady(s); });
  if (pending && !structTimer) {
    structTimer = setInterval(function() {
      var still = fieldStructures.some(function(s) { return !structReady(s); });
      redrawScene();
      if (selectedStructure && structPanelOpen()) paintStructStatus(selectedStructure);
      if (!still) {
        clearInterval(structTimer);
        structTimer = null;
        loadStructures();
      }
    }, 1000);
  }
}

function structSide(s) {
  if (s.owner_user_id === currentUserId) return 'mine';
  if (myFaction && s.faction === myFaction) return 'ally';
  return 'enemy';
}

var STRUCT_SIDE_COLOR = { mine: '#5fd968', ally: '#4a90d9', enemy: '#d94a4a' };

function structAt(cellX, cellY) {
  for (var i = fieldStructures.length - 1; i >= 0; i--) {
    var s = fieldStructures[i];
    if (cellX >= s.x && cellX < s.x + s.w && cellY >= s.y && cellY < s.y + s.h) return s;
  }
  return null;
}

// Под какими своими укреплениями стоит юнит: для строки в его панели
function unitShelter(unit) {
  if (!unit || unit.x === null || unit.x === undefined) return null;
  var ut = unitTypeById[unit.unit_type] || {};
  var box = unitBox(unit);
  var res = { cover: 0, mult: 1, camo: false, name: null };

  fieldStructures.forEach(function(s) {
    if (s.faction !== unit.faction || !structReady(s)) return;
    var st = structTypeById[s.type_id] || {};
    if (st.kind === 'camo') {
      var r = st.radius || 0;
      if (unit.x < s.x + s.w + r && unit.x + box.w > s.x - r &&
          unit.y < s.y + s.h + r && unit.y + box.h > s.y - r) res.camo = true;
      return;
    }
    if (!(unit.x < s.x + s.w && unit.x + box.w > s.x && unit.y < s.y + s.h && unit.y + box.h > s.y)) return;
    if (st.infantry_only && ut.is_vehicle) return;
    if ((st.cover_pct || 0) > res.cover) { res.cover = st.cover_pct; res.name = st.kind; }
    if (Number(st.damage_mult) > res.mult) res.mult = Number(st.damage_mult);
  });

  if (!res.cover && !res.camo) return null;
  return res;
}

function shelterText(sh) {
  if (!sh) return '';
  var parts = [];
  if (sh.cover) {
    parts.push((sh.name === 'bunker' ? 'в бункере' : 'в окопе') + ' −' + sh.cover + '%' +
               (sh.mult > 1 ? ', урон ×' + sh.mult : ''));
  }
  if (sh.camo) parts.push('под маскировкой');
  return parts.join(' · ');
}

// ---------- Отрисовка ----------

function drawStructures() {
  if (!fieldStructures.length) return;
  var now = gbServerNow();

  // Зоны своей маскировки — чтобы было видно, кого она укрывает
  fieldStructures.forEach(function(s) {
    var st = structTypeById[s.type_id];
    if (!st || st.kind !== 'camo' || structSide(s) === 'enemy' || !structReady(s)) return;
    var r = st.radius || 0;
    var zx = (s.x - r) * CELL_PX, zy = (s.y - r) * CELL_PX;
    var zw = (s.w + r * 2) * CELL_PX, zh = (s.h + r * 2) * CELL_PX;
    ctx.fillStyle = 'rgba(95,217,190,0.10)';
    ctx.fillRect(zx, zy, zw, zh);
    ctx.strokeStyle = 'rgba(95,217,190,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(zx + 1, zy + 1, zw - 2, zh - 2);
    ctx.setLineDash([]);
  });

  fieldStructures.forEach(function(s) {
    var st = structTypeById[s.type_id] || {};
    var px = s.x * CELL_PX, py = s.y * CELL_PX;
    var w = s.w * CELL_PX, h = s.h * CELL_PX;
    var ready = !s.completes_at || new Date(s.completes_at).getTime() <= now;
    var color = STRUCT_SIDE_COLOR[structSide(s)];

    // Тень под постройкой: картинка вырезана, без неё она «висит» над травой
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(px + w / 2, py + h * 0.78, w * 0.46, h * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var img = getBuildingImage(st.image);
    ctx.save();
    if (!ready) ctx.globalAlpha = 0.5;
    if (img && img.complete && !img.failed && img.naturalWidth > 0) {
      gbDrawImage(img, px + 1, py + 1, w - 2, h - 2);
    } else {
      ctx.fillStyle = 'rgba(217,169,64,0.30)';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);
    }
    ctx.restore();

    // Уголки цвета стороны: своё, союзное, вражеское — видно сразу
    var len = Math.max(6, Math.min(w, h) * 0.26);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + 1, py + 1 + len); ctx.lineTo(px + 1, py + 1); ctx.lineTo(px + 1 + len, py + 1);
    ctx.moveTo(px + w - 1 - len, py + 1); ctx.lineTo(px + w - 1, py + 1); ctx.lineTo(px + w - 1, py + 1 + len);
    ctx.moveTo(px + w - 1, py + h - 1 - len); ctx.lineTo(px + w - 1, py + h - 1); ctx.lineTo(px + w - 1 - len, py + h - 1);
    ctx.moveTo(px + 1 + len, py + h - 1); ctx.lineTo(px + 1, py + h - 1); ctx.lineTo(px + 1, py + h - 1 - len);
    ctx.stroke();

    if (!ready) {
      drawStructProgress(s, px, py, w, h, now);
    } else if (st.max_hp && s.hp < st.max_hp) {
      var pct = Math.max(0, s.hp / st.max_hp);
      ctx.fillStyle = 'rgba(5,6,10,0.8)';
      ctx.fillRect(px + 3, py + 3, w - 6, 4);
      ctx.fillStyle = pct > 0.6 ? '#5fd968' : pct > 0.3 ? '#d9a940' : '#d94a4a';
      ctx.fillRect(px + 3, py + 3, (w - 6) * pct, 4);
    }

    if (selectedStructure && selectedStructure.id === s.id) {
      ctx.strokeStyle = '#d9a940';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(px - 2, py - 2, w + 4, h + 4);
      ctx.setLineDash([]);
    }
  });
}

function drawStructProgress(s, px, py, w, h, now) {
  var st = structTypeById[s.type_id] || {};
  var endMs = new Date(s.completes_at).getTime();
  var total = (st.build_seconds || 60) * 1000;
  var progress = 1 - (endMs - now) / total;
  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;

  var barH = Math.max(3, h * 0.08);
  var barY = py + h - barH - 3;
  ctx.fillStyle = 'rgba(5,6,10,0.8)';
  ctx.fillRect(px + 3, barY, w - 6, barH);
  ctx.fillStyle = '#4a90d9';
  ctx.fillRect(px + 3, barY, (w - 6) * progress, barH);

  var left = Math.max(0, Math.ceil((endMs - now) / 1000));
  var mm = Math.floor(left / 60), ss = left % 60;
  var label = mm > 0 ? (mm + ':' + (ss < 10 ? '0' : '') + ss) : (ss + 'с');

  ctx.font = 'bold ' + Math.max(9, Math.round(Math.min(w, 64) * 0.26)) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(5,6,10,0.9)';
  ctx.strokeText(label, px + w / 2, barY - 2);
  ctx.fillStyle = '#cfd8dc';
  ctx.fillText(label, px + w / 2, barY - 2);
}

// Поверх юнитов: радиус выбранной постройки и режим постановки
function drawStructureOverlay() {
  if (selectedStructure && !placingStructure) {
    var st = structTypeById[selectedStructure.type_id] || {};
    var zone = structZone(selectedStructure, st);
    if (zone) {
      ctx.fillStyle = zone.fill;
      ctx.fillRect(zone.x * CELL_PX, zone.y * CELL_PX, zone.w * CELL_PX, zone.h * CELL_PX);
      ctx.strokeStyle = zone.stroke;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.strokeRect(zone.x * CELL_PX, zone.y * CELL_PX, zone.w * CELL_PX, zone.h * CELL_PX);
      ctx.setLineDash([]);
    }
  }

  if (placingStructure) drawStructPlacement();
}

// Зона действия: у турели дальность от корпуса, у глушилки квадрат вокруг центра
function structZone(s, st) {
  if (st.kind === 'turret' && st.radius) {
    return { x: s.x - st.radius, y: s.y - st.radius, w: s.w + st.radius * 2, h: s.h + st.radius * 2,
             fill: 'rgba(217,74,74,0.11)', stroke: 'rgba(217,74,74,0.75)' };
  }
  // Радар и глушилка, как турель, действуют на radius клеток от своих краёв
  if (st.kind === 'radar' && st.radius) {
    return { x: s.x - st.radius, y: s.y - st.radius, w: s.w + st.radius * 2, h: s.h + st.radius * 2,
             fill: 'rgba(74,217,160,0.08)', stroke: 'rgba(74,217,160,0.8)' };
  }
  if (st.kind === 'jammer' && st.radius) {
    return { x: s.x - st.radius, y: s.y - st.radius, w: s.w + st.radius * 2, h: s.h + st.radius * 2,
             fill: 'rgba(163,74,217,0.08)', stroke: 'rgba(163,74,217,0.75)' };
  }
  if (st.kind === 'camo' && st.radius) {
    return { x: s.x - st.radius, y: s.y - st.radius, w: s.w + st.radius * 2, h: s.h + st.radius * 2,
             fill: 'rgba(95,217,190,0.10)', stroke: 'rgba(95,217,190,0.8)' };
  }
  return null;
}

// ---------- Где можно поставить ----------
// Те же правила, что у сервера в build_structure. Сервер всё равно
// перепроверит, но подсветка должна обещать только реальные места.

function boxOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function boxGap(ax, ay, aw, ah, bx, by, bw, bh) {
  return Math.max(Math.max(bx - (ax + aw - 1), ax - (bx + bw - 1), 0),
                  Math.max(by - (ay + ah - 1), ay - (by + bh - 1), 0));
}

function structPlaceProblem(unit, st, x, y) {
  var w = st.width_cells || 1, h = st.height_cells || 1;
  var ub = unitBox(unit);

  if (x < 0 || y < 0 || x + w > GRID_SIZE || y + h > GRID_SIZE) return 'за краем карты';
  if (y + h > GRID_SIZE - ATTACK_ZONE_H) return 'в полосе вторжения не строят';
  if (boxGap(unit.x, unit.y, ub.w, ub.h, x, y, w, h) > structBuildRange) {
    return 'далеко: инженер строит в ' + structBuildRange + ' клетках от себя';
  }

  for (var i = 0; i < deployZones.length; i++) {
    var z = deployZones[i];
    if (boxOverlap(x, y, w, h, z.x, z.y, z.size || DEPLOY_SIZE, z.size || DEPLOY_SIZE)) {
      return 'зона высадки должна оставаться свободной';
    }
  }
  // Кольцо захвата вокруг поселения всегда свободно — как и на сервере
  var sz = settlementZone || settlement;
  if (sz && boxOverlap(x, y, w, h, sz.x, sz.y, sz.size, sz.size)) {
    return 'у поселения не строят: кольцо захвата должно быть свободным';
  }
  for (var k = 0; k < buildSlots.length; k++) {
    if (boxOverlap(x, y, w, h, buildSlots[k].x, buildSlots[k].y, SLOT_SIZE, SLOT_SIZE)) {
      return 'здесь участок под здание';
    }
  }
  for (var j = 0; j < fieldStructures.length; j++) {
    var s = fieldStructures[j];
    if (boxOverlap(x, y, w, h, s.x, s.y, s.w, s.h)) return 'место занято укреплением';
  }
  for (var n = 0; n < unitsOnMap.length; n++) {
    var u = unitsOnMap[n];
    if (u.x === null || u.x === undefined) continue;
    var b = unitBox(u);
    if (!boxOverlap(x, y, w, h, u.x, u.y, b.w, b.h)) continue;
    var ut = unitTypeById[u.unit_type] || {};
    if (!st.enterable) return 'место занято';
    if (u.faction !== myFaction) return 'место занято';
    if (st.infantry_only && ut.is_vehicle) return 'здесь стоит техника — окоп, бункер и сеть только для пехоты';
  }
  return null;
}

// Тап по клетке: у больших построек палец попадает в середину, а не в угол
function structAnchor(st, cellX, cellY) {
  return {
    x: cellX - Math.floor(((st.width_cells || 1) - 1) / 2),
    y: cellY - Math.floor(((st.height_cells || 1) - 1) / 2)
  };
}

function drawStructPlacement() {
  var p = placingStructure;
  var u = p.unit, st = p.type;
  var ub = unitBox(u);
  var w = st.width_cells || 1, h = st.height_cells || 1;
  var r = structBuildRange;
  var ox = Math.floor((w - 1) / 2), oy = Math.floor((h - 1) / 2);

  // Досягаемость инженера
  var rx = (u.x - r - w + 1), ry = (u.y - r - h + 1);
  var rw = ub.w + (r + w - 1) * 2, rh = ub.h + (r + h - 1) * 2;
  ctx.strokeStyle = 'rgba(217,169,64,0.75)';
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(rx * CELL_PX, ry * CELL_PX, rw * CELL_PX, rh * CELL_PX);
  ctx.setLineDash([]);

  // Клетки, тап по которым даст годное место
  for (var ax = rx; ax < rx + rw; ax++) {
    for (var ay = ry; ay < ry + rh; ay++) {
      if (structPlaceProblem(u, st, ax, ay)) continue;
      ctx.fillStyle = 'rgba(95,217,104,0.22)';
      ctx.fillRect((ax + ox) * CELL_PX + 3, (ay + oy) * CELL_PX + 3, CELL_PX - 6, CELL_PX - 6);
    }
  }

  if (!p.preview) return;

  var pv = p.preview;
  var px = pv.x * CELL_PX, py = pv.y * CELL_PX;
  var img = getBuildingImage(st.image);
  ctx.save();
  ctx.globalAlpha = 0.72;
  if (img && img.complete && !img.failed && img.naturalWidth > 0) {
    gbDrawImage(img, px + 1, py + 1, w * CELL_PX - 2, h * CELL_PX - 2);
  }
  ctx.restore();
  ctx.fillStyle = pv.problem ? 'rgba(217,74,74,0.25)' : 'rgba(95,217,104,0.18)';
  ctx.fillRect(px, py, w * CELL_PX, h * CELL_PX);
  ctx.strokeStyle = pv.problem ? '#d94a4a' : '#5fd968';
  ctx.lineWidth = 3;
  ctx.strokeRect(px + 1, py + 1, w * CELL_PX - 2, h * CELL_PX - 2);
}

// ---------- Каталог построек инженера ----------

function structTypesForMe() {
  return Object.keys(structTypeById).map(function(k) { return structTypeById[k]; })
    .filter(function(t) { return t.faction === myFaction; })
    .sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
}

function structCountHere(typeId) {
  return fieldStructures.filter(function(s) { return s.type_id === typeId; }).length;
}

function structEffectLine(st) {
  switch (st.kind) {
    case 'trench':    return 'урон по бойцу −' + st.cover_pct + '% · ответный огонь';
    case 'bunker':    return 'урон по пехоте −' + st.cover_pct + '% · её урон ×' + Number(st.damage_mult);
    case 'camo':      return 'прячет своих в ' + (st.width_cells + st.radius * 2) + '×' +
                             (st.height_cells + st.radius * 2) + ' клетках';
    case 'turret':    return 'урон ' + st.damage + ' · радиус ' + st.radius + ' · раз в ' +
                             Math.round(st.cooldown_seconds / 60) + ' мин';
    case 'jammer':    return 'сжигает разведчиков в ' + st.radius + ' клетках вокруг';
    case 'radar':     return 'видит всех врагов в ' + st.radius + ' клетках вокруг, даже под маскировкой';
    case 'extractor': return '+' + st.produces_per_day + ' ' +
                             resourceName(st.produces_resource).toLowerCase() + ' в сутки';
    case 'cantina':   return '+' + st.credits_per_day + ' кр. в сутки · довольство +' + st.satisfaction_bonus;
    default:          return '';
  }
}

function formatBuildTime(sec) {
  if (sec >= 60) return Math.floor(sec / 60) + ' мин' + (sec % 60 ? ' ' + (sec % 60) + ' с' : '');
  return sec + ' с';
}

function openStructureBuildPanel(unit) {
  var panel = document.getElementById('build-panel');
  var list = document.getElementById('build-panel-list');
  var box = document.getElementById('build-panel-box');
  var title = box.querySelector('.build-panel-title');
  var utype = unitTypeById[unit.unit_type] || {};

  title.textContent = 'Полевые постройки · ' + (utype.name || 'инженер');
  list.innerHTML = '<div class="build-panel-empty">Загрузка…</div>';
  var oldStrip = document.getElementById('stock-strip');
  if (oldStrip) oldStrip.remove();
  panel.classList.add('struct-mode');
  panel.style.display = 'flex';

  Promise.all([
    supabase.rpc('get_researches'),
    new Promise(function(done) { loadResourceNames(done); }),
    new Promise(function(done) { loadPlanetStock(done); })
  ]).then(function(r) {
    // Окно успели закрыть или открыть под здание — чужой список не рисуем
    if (panel.style.display === 'none' || !panel.classList.contains('struct-mode')) return;
    structResearchDone = {};
    (r[0].error ? [] : (r[0].data || [])).forEach(function(x) {
      structResearchNames[x.id] = x.name;
      if (x.done) structResearchDone[x.id] = true;
    });
    renderStockStrip(0);
    renderStructureCards(unit, list);
  });
}

function renderStructureCards(unit, list) {
  list.innerHTML = '';

  var types = structTypesForMe();
  var own = sysFaction && myFaction && sysFaction === myFaction;

  var note = document.createElement('div');
  note.className = 'struct-note' + (own ? '' : ' warn');
  note.textContent = own
    ? 'Строит в ' + structBuildRange + ' клетках от себя за одно действие. ' +
      'Нельзя: зоны высадки, участки зданий, поселение с кольцом захвата и полоса вторжения.'
    : 'Строить можно только на планетах своей фракции.';
  list.appendChild(note);

  if (!types.length) {
    list.insertAdjacentHTML('beforeend', '<div class="build-panel-empty">Постройки пока не завезли</div>');
    return;
  }

  var labName = myFaction === 'cis' ? 'лаборатории' : 'научном центре';

  types.forEach(function(st) {
    var item = document.createElement('button');
    item.className = 'build-panel-item struct-card';
    item.setAttribute('data-code', st.id);

    var learned = !st.research_id || structResearchDone[st.research_id];
    var count = structCountHere(st.id);
    var capped = st.max_per_planet && count >= st.max_per_planet;
    var enough = canAffordResources(st.cost_resources);

    item.innerHTML =
      '<div class="build-panel-thumb struct-thumb">' +
        (st.image ? '<img src="../' + st.image + '" alt="">' : '■') +
        '<span class="struct-size">' + st.width_cells + '×' + st.height_cells + '</span>' +
      '</div>' +
      '<div class="build-panel-info">' +
        '<div class="build-panel-name">' + escHtml(st.name) +
          (!st.research_id ? ' <i class="struct-tag">базовая</i>' : '') + '</div>' +
        '<div class="struct-effect">' + escHtml(structEffectLine(st)) + '</div>' +
        '<div class="build-panel-cost">' + st.cost + ' кр. · ' + formatBuildTime(st.build_seconds) + '</div>' +
        (consumesText(st.cost_resources)
          ? '<div class="build-panel-rescost' + (enough ? '' : ' short') + '">Со склада: ' +
            escHtml(consumesText(st.cost_resources)) + '</div>' : '') +
        '<div class="struct-limit">прочность ' + st.max_hp + ' · на планете ' + count + ' из ' + st.max_per_planet + '</div>' +
      '</div>';

    var why = null;
    if (!own) why = 'чужая планета';
    else if (!learned) why = 'Изучить в ' + labName + ': ' +
      ((st.research_id && researchNameById(st.research_id)) || 'исследование');
    else if (capped) why = 'Предел на этой планете';
    else if (!enough) why = 'На складе не хватает сырья';

    if (why) {
      item.classList.add('blocked');
      if (!learned) item.classList.add('struct-locked');
      var w = document.createElement('div');
      w.className = 'build-panel-why';
      w.textContent = why;
      item.querySelector('.build-panel-info').appendChild(w);
    }

    item.addEventListener('click', function() {
      if (why) return;
      closeBuildPanel();
      startStructurePlacement(unit, st);
    });

    list.appendChild(item);
  });
}

var structResearchNames = {};
function researchNameById(id) { return structResearchNames[id] || null; }

// ---------- Постановка на карту ----------

function startStructurePlacement(unit, st) {
  cancelTargeting();
  if (movingUnit) cancelGroundMove();
  selectedStructure = null;
  selectedUnit = null;
  placingStructure = { unit: unit, type: st, preview: null };
  hidePickup();
  showStructPlacementHint();
  focusCell(unit.x, unit.y);
  redrawScene();
}

function showStructPlacementHint() {
  var p = placingStructure;
  if (!p) return;
  var st = p.type;
  var hint = document.getElementById('placement-hint');
  var head = escHtml(st.name) + ' ' + st.width_cells + '×' + st.height_cells;

  if (!p.preview) {
    hint.innerHTML = '<span>' + head + ' · ткни подсвеченную клетку</span>' +
                     '<button id="struct-cancel">Отмена</button>';
  } else if (p.preview.problem) {
    hint.innerHTML = '<span>' + head + ' · <b class="warn-own">' + escHtml(p.preview.problem) + '</b></span>' +
                     '<button id="struct-cancel">Отмена</button>';
  } else {
    hint.innerHTML = '<span>' + head + ' · ' + st.cost + ' кр. · ' + formatBuildTime(st.build_seconds) + '</span>' +
                     '<button id="area-go">Строить</button>' +
                     '<button id="struct-cancel">Отмена</button>';
  }
  hint.style.display = 'flex';

  document.getElementById('struct-cancel').addEventListener('click', cancelStructurePlacement);
  var go = document.getElementById('area-go');
  if (go) go.addEventListener('click', confirmStructurePlacement);
  setBottomInset(insetFor(hint));
}

function cancelStructurePlacement() {
  placingStructure = null;
  document.getElementById('placement-hint').style.display = 'none';
  setBottomInset(0);
  redrawScene();
}

function handleStructurePlacementTap(cellX, cellY) {
  var p = placingStructure;
  var a = structAnchor(p.type, cellX, cellY);
  p.preview = { x: a.x, y: a.y, problem: structPlaceProblem(p.unit, p.type, a.x, a.y) };
  showStructPlacementHint();
  redrawScene();
}

function confirmStructurePlacement() {
  var p = placingStructure;
  if (!p || !p.preview || p.preview.problem) return;
  if (!gcReady()) { sendStructurePlacement(); return; }
  var st = p.type;
  gameConfirm({
    tone: 'build',
    kicker: 'Подтверди стройку',
    title: st.name,
    image: st.image ? '../' + st.image : null,
    sub: st.width_cells + '×' + st.height_cells + ' · клетка ' + p.preview.x + ':' + p.preview.y +
         (st.build_seconds ? ' · ' + formatBuildTime(st.build_seconds) : ''),
    rows: [{ label: 'Спишется', items: gcCostItems(st.cost, st.cost_resources) }],
    note: 'Инженер потратит действие. Разобрать можно потом — вернётся половина, ' +
          'если укрепление цело.',
    ok: 'Построить'
  }, function() {
    // Пока окно было открыто, постановку могли отменить или сдвинуть
    if (placingStructure === p && p.preview && !p.preview.problem) sendStructurePlacement();
  });
}

function sendStructurePlacement() {
  var p = placingStructure;
  if (!p || !p.preview || p.preview.problem) return;
  var go = document.getElementById('area-go');
  if (go) go.disabled = true;

  supabase.rpc('build_structure', {
    p_unit_id: p.unit.id, p_type: p.type.id, p_x: p.preview.x, p_y: p.preview.y
  }).then(function(r) {
    if (r.error) {
      if (go) go.disabled = false;
      alert('Не удалось построить: ' + r.error.message);
      return;
    }
    cancelStructurePlacement();
    selectedUnit = null;
    loadStructures();
    loadUnits();
  });
}

// ---------- Панель постройки ----------

function structPanelOpen() {
  var bar = document.getElementById('pickup-bar');
  return !!(bar && bar.style.visibility === 'visible' && bar.getAttribute('data-struct'));
}

function openStructurePanel(s, keepView) {
  var bar = document.getElementById('pickup-bar');
  if (!bar) return;

  selectedStructure = s;
  selectedUnit = null;

  var st = structTypeById[s.type_id] || {};
  var side = structSide(s);
  var hpPct = st.max_hp ? Math.max(0, Math.min(100, s.hp / st.max_hp * 100)) : 100;
  var sideText = side === 'mine' ? 'Твоя' : side === 'ally' ? 'Союзная' : 'Вражеская';

  var props = [];
  if (st.cover_pct) props.push('<span title="укрытие">⛨ −' + st.cover_pct + '%</span>');
  if (Number(st.damage_mult) > 1) props.push('<span title="урон стрелка">◎ ×' + Number(st.damage_mult) + '</span>');
  if (st.kind === 'turret') {
    props.push('<span title="урон">◎ ' + st.damage + '</span>');
    props.push('<span title="радиус">➶ ' + st.radius + '</span>');
    props.push('<span title="перезарядка">◷ ' + Math.round(st.cooldown_seconds / 60) + ' мин</span>');
  }
  if (st.kind === 'jammer') props.push('<span title="поле помех">◈ ' + st.radius + ' кл.</span>');
  if (st.kind === 'radar') props.push('<span title="зона обнаружения">◉ ' + st.radius + ' кл.</span>');
  if (st.kind === 'camo') props.push('<span title="укрывает">◌ ' + (s.w + st.radius * 2) + '×' + (s.h + st.radius * 2) + '</span>');
  if (st.produces_per_day) props.push('<span title="в сутки">⛏ +' + st.produces_per_day + ' ' +
                                      escHtml(resourceName(st.produces_resource).toLowerCase()) + '</span>');
  if (st.credits_per_day) props.push('<span title="в сутки">◈ +' + st.credits_per_day + '</span>');
  if (st.satisfaction_bonus) props.push('<span title="довольство поселения">☺ +' + st.satisfaction_bonus + '</span>');

  bar.removeAttribute('data-intel');
  bar.setAttribute('data-struct', s.id);
  bar.setAttribute('data-side', side);
  bar.innerHTML =
    '<div class="gu-top">' +
      '<div class="gu-portrait struct side-' + side + '">' +
        (st.image ? '<img src="../' + st.image + '" alt="">' : '') +
      '</div>' +
      '<div class="gu-stats">' +
        '<div class="gu-name">' + escHtml(st.name || 'Постройка') + '</div>' +
        '<div class="gu-role"><b class="struct-side side-' + side + '">' + sideText + '</b> · ' +
          (STRUCT_KIND_ROLE[st.kind] || 'Постройка') + ' · ' + s.w + '×' + s.h + ' · ' + s.x + ':' + s.y + '</div>' +
        '<div class="gu-hp">' +
          '<span class="gu-hp-num">' + s.hp + ' / ' + (st.max_hp || s.hp) + '</span>' +
          '<div class="gu-hp-track"><i style="width:' + hpPct + '%"></i></div>' +
        '</div>' +
        '<div class="gu-props">' + props.join('') + '</div>' +
      '</div>' +
      '<button class="gu-close" id="gu-close">✕</button>' +
    '</div>' +
    '<div class="gu-ap-row struct-status" id="struct-status"></div>' +
    '<div class="gu-panel struct-panel">' +
      '<div class="gu-desc">' + escHtml(st.description || '') + '</div>' +
      '<div id="struct-actions"></div>' +
    '</div>';

  paintStructStatus(s);

  if (side === 'mine') {
    // Как на сервере: половина цены, урезанная по целости постройки
    // Целочисленно: cost * hp / (2 * max_hp), остаток отбрасывается
    var maxHp = Math.max(1, st.max_hp || s.hp || 1);
    var hpNow = Math.max(0, Math.min(s.hp || 0, maxHp));
    var whole = hpNow / maxHp;
    var back = Math.floor((st.cost || 0) * hpNow / (2 * maxHp));
    var btn = document.createElement('button');
    btn.className = 'gu-abil-go struct-demolish';
    btn.textContent = 'Разобрать · вернётся ' + back + ' кр.';
    btn.addEventListener('click', function() {
      if (btn.disabled) return;
      var go = function() {
        btn.disabled = true;
        supabase.rpc('demolish_structure', { p_id: s.id }).then(function(res) {
          if (res.error) { btn.disabled = false; alert(res.error.message); return; }
          selectedStructure = null;
          hidePickup();
          loadStructures();
          loadPlanetStock();
        }, function(e) {
          btn.disabled = false;
          alert((e && e.message) || 'нет связи с сервером');
        });
      };
      if (!gcReady()) {
        if (confirm('Разобрать «' + st.name + '»? Вернётся ' + back + ' кр.')) go();
        return;
      }
      // Сырьё возвращается на склад только своей планеты — как на сервере
      var ownPlanet = !!myFaction && sysFaction === myFaction;
      loadPlanetStock(function() {
        // Пока склад грузился, выбрали другое или закрыли панель
        if (!selectedStructure || selectedStructure.id !== s.id) return;
        var r = gcRefund(back, ownPlanet ? st.cost_resources : null, hpNow, 2 * maxHp, 0);
        gameConfirm({
          tone: 'danger',
          kicker: 'Подтверди разбор',
          title: st.name || 'Укрепление',
          image: st.image ? '../' + st.image : null,
          sub: s.w + '×' + s.h + ' · клетка ' + s.x + ':' + s.y + ' · прочность ' + s.hp + ' / ' + (st.max_hp || s.hp),
          rows: [{ label: 'Вернётся', dir: 'in', items: r.items.length ? r.items : [{ text: 'ничего', lost: true }] }],
          warn: gcJoin(whole < 1
            ? 'Укрепление повреждено — возврат урезан по прочности (' + Math.floor(whole * 100) + '%).'
            : '', gcLostWarn(r)),
          note: 'Укрепление исчезнет сразу — отменить разбор нельзя.',
          ok: 'Разобрать'
        }, go);
      });
    });
    document.getElementById('struct-actions').appendChild(btn);
  }

  document.getElementById('gu-close').addEventListener('click', function() {
    selectedStructure = null;
    hidePickup();
    redrawScene();
  });

  bar.style.visibility = 'visible';
  setBottomInset(insetFor(bar));
  if (!keepView) focusCell(s.x + Math.floor(s.w / 2), s.y + Math.floor(s.h / 2));
  redrawScene();
}

// Строка состояния: стройка, ближайшая выдача или готовность турели
var structPayTimer = null;

function paintStructStatus(s) {
  var box = document.getElementById('struct-status');
  if (!box) return;
  var st = structTypeById[s.type_id] || {};
  var now = gbServerNow();

  if (!structReady(s)) {
    var end = new Date(s.completes_at).getTime();
    var total = (st.build_seconds || 60) * 1000;
    var pct = Math.max(0, Math.min(100, (1 - (end - now) / total) * 100));
    box.innerHTML = '<span class="struct-st-label">Строится</span>' +
      '<div class="struct-st-track"><i style="width:' + pct + '%"></i></div>' +
      '<span class="struct-st-time">' + formatLeft(Math.max(0, Math.ceil((end - now) / 1000))) + '</span>';
    return;
  }

  var text = 'В строю';
  if ((st.produces_per_day || st.credits_per_day) && structSide(s) !== 'enemy') {
    // Выдача у всех одна — в 04:00 по серверу. Заложенное в окне перед
    // выдачей получает первую долю только через сутки.
    if (systemFaction && s.faction && s.faction !== systemFaction) {
      // Сервер платит только на планете своей фракции
      text = 'Планета под чужим флагом — выдачи нет';
    } else if (typeof svFirstPayoutFor === 'function' && svClock.ready) {
      var started = s.created_at ? new Date(s.created_at).getTime() : 0;
      var done = s.completes_at ? new Date(s.completes_at).getTime() : 0;
      var next = svFirstPayoutFor(started, done);
      text = 'Выдача ' + svDayWord(next) + 'в ' + svFormatTime(next) + ' ' + svClock.label +
             ' · через ' + svLeftText((next - svNow()) / 1000);
      // Отсчёт поминутный: обновляем строку, пока панель этой постройки открыта
      clearTimeout(structPayTimer);
      structPayTimer = setTimeout(function() {
        if (selectedStructure === s && structPanelOpen()) paintStructStatus(s);
      }, 30000);
    } else {
      text = 'Выдача — в 04:00 по серверу';
    }
  } else if (st.kind === 'turret' && structSide(s) !== 'enemy') {
    text = s.spotted_at ? 'Цель в прицеле — огонь раз в ' + Math.round(st.cooldown_seconds / 60) + ' мин'
                        : 'Врагов в радиусе нет';
  }
  box.innerHTML = '<span class="struct-st-label ok">' + text + '</span>';
}

// ---------- Атака по постройкам ----------

function drawStructTargets() {
  groundStructTargets.forEach(function(t) {
    ctx.strokeStyle = 'rgba(217,74,74,0.95)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(t.x * CELL_PX + 2, t.y * CELL_PX + 2, t.w * CELL_PX - 4, t.h * CELL_PX - 4);
    ctx.setLineDash([]);
  });
}

function structTargetAt(cellX, cellY) {
  for (var i = 0; i < groundStructTargets.length; i++) {
    var t = groundStructTargets[i];
    if (cellX >= t.x && cellX < t.x + t.w && cellY >= t.y && cellY < t.y + t.h) return t;
  }
  return null;
}

function attackStructureTarget(pick) {
  var shooter = attackingUnit;
  cbLastOwnAction = Date.now();
  supabase.rpc('attack_structure', {
    p_attacker_id: shooter.id, p_structure_id: pick.structure_id
  }).then(function(r) {
    if (r.error) { alert(r.error.message); return; }
    var res = (r.data && r.data.length) ? r.data[0] : null;
    if (res) cbReportStructShot(shooter, pick, res);
    cancelTargeting();
    selectedUnit = null;
    loadStructures();
    loadUnits();
  });
}

// ---------- Тексты исследований ----------

function structUnlockText(r) {
  var names = Object.keys(structTypeById).map(function(k) { return structTypeById[k]; })
    .filter(function(t) { return t.research_id === r.id; })
    .map(function(t) { return t.name + ' ' + t.width_cells + '×' + t.height_cells; });
  return names.length ? 'инженер сможет строить: ' + names.join(', ')
                      : 'открывает постройку для инженера';
}

// Щиток укрытия и пунктир маскировки поверх бойца
function drawShelterMark(sh, x, y, w, h) {
  if (sh.camo) {
    ctx.strokeStyle = 'rgba(95,217,190,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
    ctx.setLineDash([]);
  }
  if (!sh.cover) return;

  var s = Math.max(9, Math.round(CELL_PX * 0.36));
  var bx = x + 2, by = y + h - s - 2;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + s, by);
  ctx.lineTo(bx + s, by + s * 0.55);
  ctx.quadraticCurveTo(bx + s, by + s * 0.9, bx + s / 2, by + s);
  ctx.quadraticCurveTo(bx, by + s * 0.9, bx, by + s * 0.55);
  ctx.closePath();
  ctx.fillStyle = sh.name === 'bunker' ? '#cfd8dc' : '#c9a45c';
  ctx.fill();
  ctx.strokeStyle = 'rgba(5,6,10,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ===== Боевые сводки и разведданные =====
// Итог выстрела больше не прячется в системное окно: над целью всплывает
// урон или «промах», а внизу на несколько секунд встаёт карточка сводки
// с портретами, уроном и остатком прочности. Тап по чужому бойцу
// открывает разведданные: только то, что видно в бинокль, — тип, портрет,
// прочность и паспортные характеристики. Способности, снаряжение и
// улучшения противника не показываются.

var cbToastEl = null;          // карточка сводки
var cbToastTimer = null;
var cbFxLayer = null;          // слой всплывающих цифр поверх холста
var cbLastOwnAction = 0;       // когда игрок сам стрелял: свой залп не считаем «нас атакуют»
var cbOwnerNames = {};         // ник командира чужого бойца: id -> имя
var cbOwnerAsked = {};

// ---------- Всплывающие цифры над картой ----------

// Слой живёт рядом с холстом и двигается вместе с ним. Подписи внутри
// масштабируются обратно, поэтому на любом зуме читаются одинаково.
function cbEnsureFxLayer() {
  if (cbFxLayer && cbFxLayer.parentNode) return cbFxLayer;
  var vp = document.getElementById('ground-viewport');
  if (!vp) return null;
  cbFxLayer = document.createElement('div');
  cbFxLayer.id = 'gb-fx';
  vp.appendChild(cbFxLayer);
  cbSyncFxLayer();
  return cbFxLayer;
}

// --fx-inv пересчитывает стили всего слоя, поэтому трогаем его только
// при смене масштаба, а не на каждый сдвиг пальцем
var cbFxInv = null;
function cbSyncFxLayer() {
  if (!cbFxLayer) return;
  cbFxLayer.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
  var inv = (1 / (scale || 1)).toFixed(4);
  if (inv !== cbFxInv || !cbFxLayer.style.getPropertyValue('--fx-inv')) {
    cbFxInv = inv;
    cbFxLayer.style.setProperty('--fx-inv', inv);
  }
}

// kind: dmg | heal | miss | kill. Точка — верхний центр корпуса.
function cbFloat(cellX, cellY, w, text, kind, delay) {
  if (cellX === null || cellX === undefined) return;
  var layer = cbEnsureFxLayer();
  if (!layer) return;

  var pos = document.createElement('div');
  pos.className = 'fx-pos';
  pos.style.left = ((cellX + (w || 1) / 2) * CELL_PX) + 'px';
  pos.style.top = (cellY * CELL_PX) + 'px';

  var txt = document.createElement('div');
  txt.className = 'fx-txt fx-' + kind;
  txt.textContent = text;
  if (delay) txt.style.animationDelay = delay + 'ms';
  pos.appendChild(txt);
  layer.appendChild(pos);

  setTimeout(function() {
    if (pos.parentNode) pos.parentNode.removeChild(pos);
  }, 1700 + (delay || 0));
}

function cbFloatOnUnit(u, text, kind, delay) {
  if (!u) return;
  var b = unitBox(u);
  cbFloat(u.x, u.y, b.w, text, kind, delay);
}

// ---------- Разница прочности между двумя загрузками ----------

// Сравниваем, что было на карте, с тем, что пришло: у кого убыло —
// красная цифра, у кого прибыло — зелёная. Так видно и свой урон,
// и чужие попадания по нашим, и лечение госпиталем. Пропавших не
// трогаем: ушёл в туман, сел в транспорт или погиб — по карте не понять.
function cbDiffUnits(prev, next, requestedAt) {
  if (!prev || !prev.length) return;
  var before = {};
  prev.forEach(function(u) {
    if (u.x !== null && u.x !== undefined) before[u.id] = u;
  });

  var hurt = [];
  next.forEach(function(u) {
    var p = before[u.id];
    if (!p || u.x === null || u.x === undefined) return;
    var d = (u.hp || 0) - (p.hp || 0);
    if (!d) return;
    cbFloatOnUnit(u, d < 0 ? '−' + (-d) : '+' + d, d < 0 ? 'dmg' : 'heal');
    if (d < 0 && u.owner_user_id === currentUserId) hurt.push({ u: u, d: -d });
  });

  // Нас обстреляли, а игрок мог смотреть в другую сторону. Свой залп
  // по своим (артиллерия, граната) сюда не попадает: сводку о нём
  // игрок только что видел.
  // Отсчёт от момента запроса карты: на медленной связи ответ идёт долго,
  // и ответный огонь по собственному выстрелу не должен выглядеть атакой
  var from = requestedAt || Date.now();
  if (hurt.length && from - cbLastOwnAction > 3000) cbReportIncoming(hurt);
}

// ---------- Карточка сводки ----------

function cbEnsureToast() {
  if (cbToastEl && cbToastEl.parentNode) return cbToastEl;
  cbToastEl = document.createElement('div');
  cbToastEl.id = 'cb-toast';
  // Карточка пропускает касания к карте под ней, закрывает её крестик
  cbToastEl.addEventListener('click', function(e) {
    if (e.target && e.target.className === 'cb-x') cbHideToast();
  });
  document.body.appendChild(cbToastEl);
  return cbToastEl;
}

// Карточка встаёт над нижней панелью, а не поверх неё
function cbPlaceToast() {
  if (!cbToastEl) return;
  var inset = uiBottomInset;
  // Подсказка расстановки бывает открыта без отступа снизу
  var hint = document.getElementById('placement-hint');
  if (hint && hint.style.display !== 'none') inset = Math.max(inset, insetFor(hint));
  cbToastEl.style.bottom = inset > 0 ? (inset + 4) + 'px' : '';
}

function cbHideToast() {
  if (cbToastTimer) { clearTimeout(cbToastTimer); cbToastTimer = null; }
  if (cbToastEl) cbToastEl.classList.remove('show');
}

function cbPic(p) {
  if (!p) return '';
  var cls = 'cb-pic' + (p.veh ? ' veh' : '') + (p.struct ? ' struct' : '') + (p.side ? ' side-' + p.side : '');
  return '<div class="' + cls + '">' + (p.img ? '<img src="../' + escHtml(p.img) + '" alt="">' : '') + '</div>';
}

// Портрет и подпись юнита для сводки
function cbUnitPic(u, side) {
  if (!u) return null;
  var t = unitTypeById[u.unit_type] || {};
  return { img: u.portrait || t.image, veh: !!t.is_vehicle, side: side,
           name: u.hero_id && u.hero_name ? u.hero_name : (t.name || 'Боец') };
}

// opts: kind (hit|miss|kill|heal|area|incoming), title, chance,
// attacker, target ({img,name,veh,struct,side}), damage, hpLeft, hpMax,
// heal, chips [{text, cls}], lines [{text, cls}]
var cbToastSerial = 0;
var cbPendingHp = null;   // сводка ждёт точную прочность цели со свежей карты

function cbHpNow(pick) {
  var u = cbTargetUnit(pick);
  return u ? u.hp : (pick && pick.hp) || 0;
}

function cbExpectHp(serial, id, before, max, kind) {
  cbPendingHp = { serial: serial, id: id, before: before, max: max, kind: kind, at: Date.now() };
}

// Свежая карта пришла: правим цифры в сводке, если она ещё та же.
// Карта, запрошенная раньше действия, не годится — в ней старая прочность.
function cbReconcileHp(requestedAt) {
  var p = cbPendingHp;
  if (!p || requestedAt < p.at) return;
  cbPendingHp = null;
  if (p.serial !== cbToastSerial || !cbToastEl || !cbToastEl.classList.contains('show')) return;

  var u = unitsOnMap.filter(function(x) { return x.id === p.id; })[0];
  if (!u || !p.max) return;

  var left = Math.max(0, Math.min(p.max, u.hp));
  var change = p.kind === 'heal' ? Math.max(0, left - p.before) : Math.max(0, p.before - left);
  var lost = p.kind === 'heal' ? 0 : change;
  var lPct = left / p.max * 100, xPct = lost / p.max * 100;

  var num = cbToastEl.querySelector('.cb-num');
  var bar = cbToastEl.querySelector('.cb-track i.left');
  var gone = cbToastEl.querySelector('.cb-track i.lost');
  var txt = cbToastEl.querySelector('.cb-left');
  if (num) num.textContent = (p.kind === 'heal' ? '+' : '−') + change;
  if (bar) bar.style.width = lPct.toFixed(1) + '%';
  if (gone) { gone.style.left = lPct.toFixed(1) + '%'; gone.style.width = xPct.toFixed(1) + '%'; }
  if (txt) txt.textContent = left + ' / ' + p.max;
}

function cbReport(opts) {
  var el = cbEnsureToast();
  cbToastSerial++;
  cbPendingHp = null;
  var kind = opts.kind || 'hit';

  var titles = { hit: 'Попадание', miss: 'Промах', kill: 'Цель уничтожена', heal: 'Помощь',
                 area: 'Удар по площади', incoming: 'Под огнём', info: 'Сводка' };
  var title = opts.title || titles[kind] || 'Сводка';

  var pics = '';
  if (opts.attacker || opts.target) {
    pics = '<div class="cb-pics">' + cbPic(opts.attacker) +
      (opts.attacker && opts.target ? '<span class="cb-arrow">➜</span>' : '') +
      cbPic(opts.target) + '</div>';
  }

  var who = '';
  if (opts.attacker && opts.target) {
    who = escHtml(opts.attacker.name) + ' <i>→</i> ' + escHtml(opts.target.name);
  } else if (opts.target) {
    who = escHtml(opts.target.name);
  } else if (opts.attacker) {
    who = escHtml(opts.attacker.name);
  }

  // Полоса прочности: остаток плюс только что снятый кусок
  var hp = '';
  if (opts.hpMax) {
    var left = Math.max(0, Math.min(opts.hpMax, opts.hpLeft || 0));
    var lost = Math.max(0, Math.min(opts.hpMax - left, opts.damage || 0));
    var lPct = left / opts.hpMax * 100, xPct = lost / opts.hpMax * 100;
    var num = kind === 'heal' ? '+' + (opts.heal || 0)
            : kind === 'miss' ? '—'
            : '−' + (opts.damage || 0);
    hp = '<div class="cb-hp">' +
           '<span class="cb-num">' + num + '</span>' +
           '<div class="cb-track"><i class="left" style="width:' + lPct.toFixed(1) + '%"></i>' +
             (xPct > 0 ? '<i class="lost" style="left:' + lPct.toFixed(1) + '%;width:' + xPct.toFixed(1) + '%"></i>' : '') +
           '</div>' +
           '<span class="cb-left">' + left + ' / ' + opts.hpMax + '</span>' +
         '</div>';
  } else if (opts.damage && kind !== 'miss') {
    hp = '<div class="cb-hp solo"><span class="cb-num">−' + opts.damage + '</span></div>';
  } else if (kind === 'heal' && opts.heal) {
    hp = '<div class="cb-hp solo"><span class="cb-num">+' + opts.heal + '</span></div>';
  }

  var chips = (opts.chips || []).filter(Boolean).map(function(c) {
    return '<span class="cb-chip' + (c.cls ? ' ' + c.cls : '') + '">' + escHtml(c.text) + '</span>';
  }).join('');

  var lines = (opts.lines || []).filter(Boolean).map(function(l) {
    return '<div class="cb-line' + (l.cls ? ' ' + l.cls : '') + '">' + escHtml(l.text) + '</div>';
  }).join('');

  el.className = 'cb-' + kind;
  el.innerHTML =
    '<button class="cb-x" aria-label="Закрыть">✕</button>' +
    pics +
    '<div class="cb-body">' +
      '<div class="cb-head"><b>' + escHtml(title) + '</b>' +
        (opts.chance !== null && opts.chance !== undefined
          ? '<span class="cb-chance">шанс ' + opts.chance + '%</span>' : '') +
      '</div>' +
      (who ? '<div class="cb-who">' + who + '</div>' : '') +
      hp +
      (chips ? '<div class="cb-chips">' + chips + '</div>' : '') +
      lines +
    '</div>';

  cbPlaceToast();
  // Перезапуск появления, если сводка сменила сводку
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');

  if (cbToastTimer) clearTimeout(cbToastTimer);
  cbToastTimer = setTimeout(cbHideToast, kind === 'miss' ? 3200 : 4800);
  return cbToastSerial;
}

function cbReportIncoming(hurt) {
  var total = hurt.reduce(function(s, h) { return s + h.d; }, 0);
  if (hurt.length === 1) {
    var u = hurt[0].u, t = unitTypeById[u.unit_type] || {};
    cbReport({
      kind: 'incoming',
      target: cbUnitPic(u, 'mine'),
      damage: hurt[0].d, hpLeft: u.hp, hpMax: (t.max_hp || u.hp) + (u.bonus_hp || 0),
      lines: [{ text: 'Позиция ' + u.x + ':' + u.y }]
    });
    return;
  }
  cbReport({
    kind: 'incoming',
    title: 'Под огнём · ' + hurt.length + ' ' + stlPlural(hurt.length, 'боец', 'бойца', 'бойцов'),
    damage: total,
    chips: hurt.slice(0, 4).map(function(h) {
      var t = unitTypeById[h.u.unit_type] || {};
      return { text: (h.u.hero_id && h.u.hero_name ? h.u.hero_name : (t.name || 'боец')) + ' −' + h.d, cls: 'bad' };
    })
  });
}

// ---------- Сводки по видам атак ----------

function cbTargetMaxHp(pick) {
  if (!pick) return 0;
  if (pick.max_hp) return pick.max_hp;
  var u = unitsOnMap.filter(function(x) { return x.id === pick.target_id; })[0];
  var t = u ? (unitTypeById[u.unit_type] || {}) : {};
  return u ? (t.max_hp || u.hp) + (u.bonus_hp || 0) : 0;
}

function cbTargetUnit(pick) {
  return pick ? unitsOnMap.filter(function(x) { return x.id === pick.target_id; })[0] : null;
}

function cbTargetPic(pick, u) {
  var t = u ? (unitTypeById[u.unit_type] || {}) : {};
  return {
    img: (u && (u.portrait || t.image)) || pick.image,
    veh: !!t.is_vehicle,
    side: u && u.faction === myFaction ? 'ally' : 'enemy',
    name: (u && u.hero_id && u.hero_name) ? u.hero_name : (pick.name || t.name || 'Цель')
  };
}

// Обычный выстрел по бойцу
function cbReportShot(attacker, pick, res) {
  cbLastOwnAction = Date.now();
  var u = cbTargetUnit(pick);
  var max = cbTargetMaxHp(pick);
  var lines = [];

  // Цель сидела в окопе и ответила: игрок должен узнать сразу
  if (res.counter_damage !== null && res.counter_damage !== undefined) {
    var at = unitTypeById[attacker.unit_type] || {};
    var amax = (at.max_hp || attacker.hp) + (attacker.bonus_hp || 0);
    lines.push(res.counter_damage > 0
      ? { text: '↩ Ответный огонь: −' + res.counter_damage +
          (res.attacker_hp > 0 ? ' · у тебя ' + res.attacker_hp + ' / ' + amax : ' · твой боец погиб'),
          cls: 'bad' }
      : { text: '↩ Ответный огонь — мимо', cls: 'muted' });
    if (res.counter_damage <= 0) cbFloatOnUnit(attacker, 'мимо', 'miss', 250);
  }

  if (!res.hit) {
    cbFloatOnUnit(u || pick, 'ПРОМАХ', 'miss');
  } else if (res.destroyed) {
    cbFloatOnUnit(u || pick, '−' + res.damage, 'dmg');
    cbFloatOnUnit(u || pick, 'УНИЧТОЖЕН', 'kill', 220);
  }

  cbReport({
    kind: !res.hit ? 'miss' : res.destroyed ? 'kill' : 'hit',
    chance: pick.chance,
    attacker: cbUnitPic(attacker, 'mine'),
    target: cbTargetPic(pick, u),
    damage: res.hit ? res.damage : 0,
    hpLeft: res.destroyed ? 0 : (res.target_hp !== null && res.target_hp !== undefined ? res.target_hp : (pick.hp || 0)),
    hpMax: max,
    lines: lines
  });
}

// Выстрел по постройке: постройки в разнице прочности не участвуют,
// поэтому цифру над ней ставим сами
function cbReportStructShot(attacker, pick, res) {
  cbLastOwnAction = Date.now();
  var box = { x: pick.x, y: pick.y, w: pick.w || 1 };
  if (!res.hit) cbFloat(box.x, box.y, box.w, 'ПРОМАХ', 'miss');
  else {
    cbFloat(box.x, box.y, box.w, '−' + res.damage, 'dmg');
    if (res.destroyed) cbFloat(box.x, box.y, box.w, 'РАЗРУШЕН', 'kill', 220);
  }

  cbReport({
    kind: !res.hit ? 'miss' : res.destroyed ? 'kill' : 'hit',
    title: res.destroyed ? 'Постройка разрушена' : null,
    chance: pick.chance,
    attacker: cbUnitPic(attacker, 'mine'),
    target: { img: pick.image, struct: true, side: 'enemy', name: pick.name || 'Постройка' },
    damage: res.hit ? res.damage : 0,
    hpLeft: res.destroyed ? 0 : res.target_hp,
    hpMax: pick.max_hp || 0
  });
}

// Способность по одной цели (улучшение бойца или дар героя).
// Сервер возвращает урон и признак убийства, остаток считаем от того,
// что было у цели перед ударом.
function cbReportAbility(name, attacker, pick, res, before) {
  cbLastOwnAction = Date.now();
  var u = cbTargetUnit(pick);
  var max = cbTargetMaxHp(pick);
  var killed = !!(res.killed && res.killed !== 0);
  // Промахом считаем только явный отказ сервера. Подчинение, усмирение,
  // толчок урона не наносят, но сработали — это не промах.
  var hit = res.hit !== false;
  if (before === null || before === undefined) before = u ? u.hp : (pick.hp || 0);

  if (!hit) cbFloatOnUnit(u || pick, 'ПРОМАХ', 'miss');
  else if (killed && u) {
    cbFloatOnUnit(u, '−' + (res.damage || before), 'dmg');
    cbFloatOnUnit(u, 'УНИЧТОЖЕН', 'kill', 220);
  }

  var serial = cbReport({
    kind: !hit ? 'miss' : killed ? 'kill' : (res.damage ? 'hit' : 'info'),
    title: name + (!hit ? ' · промах' : killed ? ' · цель уничтожена' : ''),
    attacker: attacker ? cbUnitPic(attacker, 'mine') : null,
    target: cbTargetPic(pick, u),
    damage: res.damage || 0,
    hpLeft: killed ? 0 : Math.max(0, before - (res.damage || 0)),
    hpMax: res.damage || killed ? max : 0,
    lines: res.note ? [{ text: res.note, cls: 'muted' }] : []
  });
  // Урон способности сервер называет до укрытия: точный остаток
  // подставим, когда придёт свежая карта
  if (hit && !killed && res.damage) cbExpectHp(serial, pick.target_id, before, max, 'dmg');
}

// Удар по площади: залп артиллерии, граната, дар героя по клетке
function cbReportArea(name, attacker, res) {
  cbLastOwnAction = Date.now();
  var chips = [];
  if (res.hits !== undefined && res.hits !== null) chips.push({ text: 'попаданий ' + res.hits, cls: res.hits ? 'good' : '' });
  if (res.misses) chips.push({ text: 'мимо ' + res.misses });
  // Число убитых приходит не всегда: дар героя отвечает только «да/нет»
  if (typeof res.killed === 'number' && res.killed > 0) chips.push({ text: 'уничтожено ' + res.killed, cls: 'good' });
  else if (res.killed === true) chips.push({ text: 'есть убитые', cls: 'good' });
  if (res.own_losses) chips.push({ text: 'свои потери ' + res.own_losses, cls: 'bad' });
  if (res.damage) chips.push({ text: 'урон ' + res.damage });

  cbReport({
    kind: 'area',
    title: name,
    attacker: attacker ? cbUnitPic(attacker, 'mine') : null,
    chips: chips,
    lines: res.note ? [{ text: res.note, cls: 'muted' }] : []
  });
}

// ---------- Разведданные о чужом бойце ----------

function cbUnitSide(u) {
  if (u.owner_user_id && u.owner_user_id === currentUserId) return 'mine';
  if (myFaction && u.faction === myFaction) return 'ally';
  return 'enemy';
}

function cbHullText(t) {
  if (t.hull_class === 'air') return 'Авиация';
  if (t.hull_class === 'artillery') return 'Артиллерия';
  if (t.is_vehicle) return t.carry_slots > 0 ? 'Техника · транспорт' : 'Техника';
  return 'Пехота';
}

function cbLoadOwnerName(id, done) {
  if (!id) return;
  if (cbOwnerNames[id] !== undefined) return;
  if (cbOwnerAsked[id]) return;
  cbOwnerAsked[id] = true;
  supabase.from('profiles').select('id, nickname').eq('id', id).maybeSingle().then(function(r) {
    cbOwnerNames[id] = (!r.error && r.data && r.data.nickname) ? r.data.nickname : null;
    if (done) done();
  });
}

function showUnitIntel(unit, keepView) {
  var bar = document.getElementById('pickup-bar');
  if (!bar) return;

  var t = unitTypeById[unit.unit_type] || {};
  var side = cbUnitSide(unit);
  var isNpc = !unit.owner_user_id;
  var isHero = !!unit.hero_id;
  var max = (t.max_hp || unit.hp) + (unit.bonus_hp || 0);
  var hpPct = max ? Math.max(0, Math.min(100, unit.hp / max * 100)) : 100;
  var title = isHero && unit.hero_name ? unit.hero_name : (t.name || 'Неизвестный боец');

  var sideText = side === 'ally' ? 'Союзник' : 'Противник';
  if (isNpc) sideText = unit.faction === 'marauder' ? 'Банда мародёров' : (side === 'ally' ? 'Ополчение · союзник' : 'Ополчение противника');

  var role = isHero ? (t.name || 'Одарённый') : cbHullText(t);
  if ((t.width_cells || 1) > 1 || (t.height_cells || 1) > 1) role += ' · ' + (t.width_cells || 1) + '×' + (t.height_cells || 1);

  // Что видно со стороны: укрытие, маскировка, чужая воля, раскрытая позиция
  var now = gbServerNow();
  var marks = [];
  var sh = unitShelter(unit);
  if (sh && sh.cover) marks.push({ text: (sh.name === 'bunker' ? 'В бункере' : 'В окопе') + ' · урон по нему −' + sh.cover + '%', cls: 'cover' });
  if (sh && sh.camo) marks.push({ text: 'Под маскировкой', cls: 'camo' });
  if (unit.control_until && new Date(unit.control_until).getTime() > now) {
    marks.push({ text: 'Подчинён чужой воле · ещё ' +
      formatLeft(Math.max(0, Math.round((new Date(unit.control_until).getTime() - now) / 1000))), cls: 'mind' });
  }
  if (unit.revealed_until && new Date(unit.revealed_until).getTime() > now) {
    marks.push({ text: 'Выдал позицию выстрелом', cls: 'reveal' });
  }
  if (unit.hp < max * 0.35) marks.push({ text: 'Тяжело ранен', cls: 'wound' });

  var range = t.weapon_range >= GRID_SIZE ? 'вся карта' : (t.weapon_range || 0);
  var stats = [
    ['Урон', t.damage || 0, '◎'],
    ['Дальность', range, '➶'],
    ['Обзор', t.vision_range || 0, '◈'],
    ['Ход', t.move_range || 0, '⇢'],
    ['Точность', (t.accuracy || 0) + '%', '⌖'],
    ['Уклонение', (t.evasion || 0) + '%', '↯']
  ];

  // Ник командира показываем, когда он известен; пока грузится — строки нет
  var owner = '';
  var nick = isNpc ? null : cbOwnerNames[unit.owner_user_id];
  if (nick) owner = '<div class="ui-owner">Командир: <b>' + escHtml(nick) + '</b></div>';

  bar.removeAttribute('data-struct');
  bar.setAttribute('data-side', side);
  bar.setAttribute('data-intel', unit.id);
  bar.innerHTML =
    '<div class="gu-top">' +
      '<div class="gu-portrait ui-portrait side-' + side + (isHero ? ' hero' : '') + (t.is_vehicle ? ' veh' : '') + '">' +
        ((unit.portrait || t.image) ? '<img src="../' + escHtml(unit.portrait || t.image) + '" alt="">' : '') +
        '<span class="ui-tag">' + (side === 'ally' ? 'СВОЙ' : 'ВРАГ') + '</span>' +
      '</div>' +
      '<div class="gu-stats">' +
        '<div class="gu-name">' + escHtml(title) + '</div>' +
        '<div class="gu-role"><b class="struct-side side-' + side + '">' + sideText + '</b> · ' +
          escHtml(role) + ' · ' + unit.x + ':' + unit.y + '</div>' +
        '<div class="gu-hp ui-hp">' +
          '<span class="gu-hp-num">' + unit.hp + ' / ' + max + '</span>' +
          '<div class="gu-hp-track"><i style="width:' + hpPct.toFixed(1) + '%"></i></div>' +
        '</div>' +
        owner +
      '</div>' +
      '<button class="gu-close" id="gu-close">✕</button>' +
    '</div>' +
    (marks.length
      ? '<div class="ui-marks">' + marks.map(function(m) {
          return '<span class="ui-mark ' + m.cls + '">' + escHtml(m.text) + '</span>';
        }).join('') + '</div>'
      : '') +
    '<div class="gu-panel ui-panel">' +
      '<div class="ui-label">Паспорт бойца</div>' +
      '<div class="ui-grid">' + stats.map(function(s) {
        return '<div class="ui-stat"><i>' + s[2] + '</i><b>' + s[1] + '</b><span>' + s[0] + '</span></div>';
      }).join('') + '</div>' +
      (t.description ? '<div class="gu-desc ui-desc">' + escHtml(t.description) + '</div>' : '') +
      '<div class="ui-hidden">' +
        '<span class="ui-lock">⛒</span>' +
        '<span>' + (side === 'ally'
          ? 'Снаряжение и способности союзника видит только его командир'
          : 'Способности, снаряжение и улучшения противника неизвестны. Характеристики — заводские.') +
        '</span>' +
      '</div>' +
    '</div>';

  document.getElementById('gu-close').addEventListener('click', function() {
    selectedUnit = null;
    hidePickup();
    redrawScene();
  });

  bar.style.visibility = 'visible';
  setBottomInset(insetFor(bar));
  if (!keepView) focusCell(unit.x, unit.y);

  // Ник командира подтягиваем один раз и дорисовываем, если карточка ещё открыта
  if (!isNpc && cbOwnerNames[unit.owner_user_id] === undefined) {
    cbLoadOwnerName(unit.owner_user_id, function() {
      if (selectedUnit && selectedUnit.id === unit.id &&
          bar.getAttribute('data-intel') === unit.id) showUnitIntel(selectedUnit, true);
    });
  }
}

// Чужой боец сменил прочность или ушёл — карточка не должна врать
function cbRefreshIntel() {
  var bar = document.getElementById('pickup-bar');
  if (!bar || !selectedUnit || bar.style.visibility === 'hidden') return;
  var id = bar.getAttribute('data-intel');
  if (!id || id !== selectedUnit.id) return;

  var fresh = unitsOnMap.filter(function(u) { return u.id === id; })[0];
  if (!fresh || fresh.x === null || fresh.x === undefined) {
    // Пропал из обзора, погиб или сел в транспорт
    selectedUnit = null;
    hidePickup();
    redrawScene();
    return;
  }
  selectedUnit = fresh;
  // Подчинение кончилось — боец снова наш, разведка ему не нужна
  if (fresh.owner_user_id && fresh.owner_user_id === currentUserId) {
    offerPickup(fresh);
    return;
  }
  showUnitIntel(fresh, true);
}


// ===== Переход по ссылке из ленты и процессов =====
// ?system=…&x=…&y=…  — показать клетку
// &unit=…            — выбрать бойца (свой — панель управления, чужой — разведка)
// &slot=N&open=slot  — участок базы; open=slot открывает занятие здания
// &open=settlement   — поселение и его панель
// Параметры убираются из адреса, чтобы перезагрузка страницы не уводила
// карту обратно к старому событию.

function gbDeepLink() {
  var q = new URLSearchParams(window.location.search);
  var link = {
    x: q.get('x') !== null ? parseInt(q.get('x'), 10) : null,
    y: q.get('y') !== null ? parseInt(q.get('y'), 10) : null,
    unit: q.get('unit'),
    slot: q.get('slot') !== null ? parseInt(q.get('slot'), 10) : null,
    bid: q.get('bid'),
    open: q.get('open'),
    tab: q.get('tab'),
    land: q.get('land')
  };
  if (link.x === null && !link.unit && link.slot === null && !link.open && !link.land) return;

  try {
    var keep = '?system=' + encodeURIComponent(systemId) + (isBuildMode() ? '&mode=build' : '');
    window.history.replaceState(null, '', window.location.pathname + keep);
  } catch (e) {}

  // Ждём, пока карта получит войска, здания и поселение
  var tries = 0;
  var wait = setInterval(function() {
    tries++;
    var unitsReady = loadUnitsApplied > 0;
    var slotsReady = (link.slot === null && link.open !== 'lease') || buildingsLoaded;
    var stlReady = link.open !== 'settlement' || !!settlement;
    // Посадке нужна сторона: от неё зависит, куда можно садиться
    var sideReady = !link.land || iAmAttacker !== null;
    if (!(unitsReady && slotsReady && stlReady && sideReady) && tries < 50) return;
    clearInterval(wait);
    gbApplyLink(link);
  }, 200);
}

function gbApplyLink(link) {

  // «На грунт» из ангара: сразу открываем посадку этого истребителя.
  // Список посадочных берём свежим — сторона и груз могли прийти позже.
  if (link.land) {
    loadDropCargo().then(function() {
      var f = dropFighters.filter(function(x) { return x.fighter_id === link.land; })[0];
      if (!f) { alert('Истребителя уже нет в ангаре над этой планетой'); return; }
      if (f.zone === null || f.zone === undefined) {
        alert('Носитель должен целиком стоять в площадке сброса');
        return;
      }
      startFighterLanding(f);
    });
    return;
  }

  if (link.unit) {
    var u = unitsOnMap.filter(function(x) { return x.id === link.unit; })[0];
    if (u && u.x !== null && u.x !== undefined) {
      var b = unitBox(u);
      selectedStructure = null;
      selectedUnit = u;
      gbLinkZoom(); focusCell(u.x + b.w / 2 - 0.5, u.y + b.h / 2 - 0.5);
      offerPickup(u);
      gbPing(u.x, u.y, b.w, b.h);
      redrawScene();
      return;
    }
    // Боец ушёл, погиб или скрылся в тумане — показываем место события
  }

  if (link.open === 'settlement' && settlement) {
    gbLinkZoom(); focusCell(settlement.x + settlement.size / 2 - 0.5, settlement.y + settlement.size / 2 - 0.5);
    gbPing(settlement.x, settlement.y, settlement.size, settlement.size);
    // События налёта и условий открывают сразу вкладку «Условия»
    if (link.tab === 'tasks' || link.tab === 'districts' || link.tab === 'dev') stlTab = link.tab;
    openSettlementPanel();
    return;
  }

  // Из шторки аренды: здание по id — показать и открыть его занятие
  if (link.open === 'lease' && link.bid) {
    var leaseSlot = null;
    Object.keys(buildingsBySlot).forEach(function(k) {
      if (buildingsBySlot[k] && buildingsBySlot[k].id === link.bid) leaseSlot = parseInt(k, 10);
    });
    var ls = leaseSlot !== null ? buildSlots[leaseSlot - 1] : null;
    // Постройки так и не загрузились — молчим, а не пугаем «её нет»
    if (!buildingsLoaded) return;
    if (!ls) { alert('Этой постройки на планете уже нет'); return; }
    gbLinkZoom(); focusCell(ls.x + SLOT_SIZE / 2 - 0.5, ls.y + SLOT_SIZE / 2 - 0.5);
    gbPing(ls.x, ls.y, SLOT_SIZE, SLOT_SIZE);
    redrawScene();
    gbLoadLeases().then(function() {
      setTimeout(function() { onSlotTapped(leaseSlot); }, 350);
    });
    return;
  }

  if (link.slot !== null && buildSlots[link.slot - 1]) {
    var sl = buildSlots[link.slot - 1];
    gbLinkZoom(); focusCell(sl.x + SLOT_SIZE / 2 - 0.5, sl.y + SLOT_SIZE / 2 - 0.5);
    gbPing(sl.x, sl.y, SLOT_SIZE, SLOT_SIZE);
    // На месте снесённого здания могло встать другое — его не открываем
    var bld = buildingsBySlot[link.slot];
    if (link.open === 'slot' && bld && (!link.bid || bld.id === link.bid)) {
      setTimeout(function() { onSlotTapped(link.slot); }, 350);
    }
    redrawScene();
    return;
  }

  if (link.x !== null && link.y !== null && !isNaN(link.x) && !isNaN(link.y)) {
    gbLinkZoom(); focusCell(link.x, link.y);
    gbPing(link.x, link.y, 1, 1);
    redrawScene();
  }
}

// С обзора всей планеты переходим на рабочий масштаб — только когда
// действительно есть что показать
function gbLinkZoom() { if (scale < 0.9) scale = 1; }

// Метка «здесь»: расходящиеся кольца поверх карты на несколько секунд
function gbPing(x, y, w, h) {
  var layer = cbEnsureFxLayer();
  if (!layer) return;
  var el = document.createElement('div');
  el.className = 'fx-ping';
  el.style.left = (x * CELL_PX) + 'px';
  el.style.top = (y * CELL_PX) + 'px';
  el.style.width = ((w || 1) * CELL_PX) + 'px';
  el.style.height = ((h || 1) * CELL_PX) + 'px';
  el.innerHTML = '<i></i><i></i>';
  layer.appendChild(el);
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 4200);
}


// ===== Рывок BX-коммандос =====
// Красный росчерк от места старта к цели: игрок видит, что дроид
// сорвался с места и ударил, ещё до того, как карта перечитает позиции
function gbLungeFx(from, box, target) {
  var layer = cbEnsureFxLayer();
  if (!layer || !target) return;
  var tb = unitTypeById[target.unit_type] || {};
  var x1 = (from.x + (box.w || 1) / 2) * CELL_PX, y1 = (from.y + (box.h || 1) / 2) * CELL_PX;
  var x2 = (target.x + (tb.width_cells || 1) / 2) * CELL_PX, y2 = (target.y + (tb.height_cells || 1) / 2) * CELL_PX;
  var len = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
  var ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;

  var trail = document.createElement('div');
  trail.className = 'fx-lunge';
  trail.style.left = x1 + 'px';
  trail.style.top = y1 + 'px';
  trail.style.width = Math.max(8, len) + 'px';
  trail.style.transform = 'rotate(' + ang + 'deg)';
  layer.appendChild(trail);

  var slash = document.createElement('div');
  slash.className = 'fx-slash';
  slash.style.left = x2 + 'px';
  slash.style.top = y2 + 'px';
  layer.appendChild(slash);

  setTimeout(function() {
    if (trail.parentNode) trail.parentNode.removeChild(trail);
    if (slash.parentNode) slash.parentNode.removeChild(slash);
  }, 900);
}
