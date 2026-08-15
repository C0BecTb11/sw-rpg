// Космическое пространство конкретной планеты (system=id в URL).
// Сейчас поле полностью пустое — задел под будущее размещение кораблей
// и космическую оборону. Realtime-канал подписывается уже сейчас,
// чтобы инфраструктура была готова, когда появится сама механика
// (таблица space_units и т.п. добавится вместе с той механикой).

var systemId = null;
var buildMode = false;   // пустой слот станции показываем только в режиме стройки
var scale = 1;
var panX = 0;
var panY = 0;

var viewport, grid;

var CELL_PX = 40;
var GRID_CELLS = 130;      // размер космической карты в клетках (было 100)
var STATION_SIZE = 8;      // слот станции 8x8 клеток
var stationSlot = null;    // {x, y} — позиция слота в клетках
var stationRecord = null;  // запись из space_stations, если станция построена
var currentUserId = null;
var isController = false;  // может ли текущий игрок строить в этой системе

// Тот же принцип, что и на наземной карте: позиция слота выводится из id
// системы, поэтому у каждой планеты она своя, но всегда одна и та же.
function hashStringToSeed(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  var a = seed;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateStationSlot(seed) {
  var rand = mulberry32(seed ^ 0x85EBCA6B);
  var marginX = 14;

  // Станция стоит в верхней части карты, но не вплотную к краю:
  // полоса от 10 до 28 клеток сверху — есть место и над станцией, и под ней.
  var bandTop = 10;
  var bandBottom = 28;

  var x = marginX + Math.floor(rand() * (GRID_CELLS - STATION_SIZE - marginX * 2));
  var y = bandTop + Math.floor(rand() * (bandBottom - bandTop));
  return { x: x, y: y };
}

// Слот станции рисуется отдельным элементом поверх сетки —
// пунктирный, если пусто, сплошной с иконкой, если станция построена.
function renderStationSlot() {
  var existing = document.getElementById('station-slot');
  if (existing) existing.parentNode.removeChild(existing);
  if (!stationSlot) return;
  // Вне режима стройки пустой слот не рисуем — видна только готовая станция.
  if (!stationRecord && !buildMode) return;

  var el = document.createElement('div');
  el.id = 'station-slot';
  el.style.position = 'absolute';
  el.style.left = (stationSlot.x * CELL_PX) + 'px';
  el.style.top = (stationSlot.y * CELL_PX) + 'px';
  el.style.width = (STATION_SIZE * CELL_PX) + 'px';
  el.style.height = (STATION_SIZE * CELL_PX) + 'px';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.cursor = 'pointer';
  el.style.fontFamily = "'Courier New', monospace";
  el.style.boxSizing = 'border-box';

  if (stationRecord) {
    el.style.background = 'rgba(217,169,64,0.25)';
    el.style.border = '2px solid #d9a940';
    el.style.color = '#d9a940';
    el.style.fontSize = (STATION_SIZE * CELL_PX * 0.35) + 'px';
    el.textContent = '⬢';
  } else {
    el.style.background = 'rgba(120,170,220,0.12)';
    el.style.border = '2px dashed rgba(120,170,220,0.6)';
    el.style.color = 'rgba(120,170,220,0.8)';
    el.style.fontSize = (STATION_SIZE * CELL_PX * 0.14) + 'px';
    el.textContent = 'СЛОТ СТАНЦИИ';
  }

  el.addEventListener('click', function(e) {
    e.stopPropagation();
    onStationSlotTapped();
  });

  grid.appendChild(el);
}

function onStationSlotTapped() {
  var panel = document.getElementById('station-panel');
  var titleEl = document.getElementById('station-panel-title');
  var textEl = document.getElementById('station-panel-text');
  var buildBtn = document.getElementById('station-build-btn');
  var demolishBtn = document.getElementById('station-demolish-btn');

  if (stationRecord) {
    titleEl.textContent = stationRecord.name || 'Космическая станция';
    textEl.textContent = 'При сносе вернётся: 150';
    buildBtn.style.display = 'none';
    demolishBtn.style.display = isController ? 'block' : 'none';
  } else {
    titleEl.textContent = 'Слот космической станции';
    textEl.textContent = isController ? 'Стоимость: 300' : 'У тебя нет прав на строительство здесь';
    buildBtn.style.display = isController ? 'block' : 'none';
    demolishBtn.style.display = 'none';
  }

  panel.style.display = 'flex';
}

function closeStationPanel() {
  document.getElementById('station-panel').style.display = 'none';
}

function buildStation() {
  var btn = document.getElementById('station-build-btn');
  btn.disabled = true;
  supabase.rpc('construct_space_station', { p_system_id: systemId }).then(function(res) {
    btn.disabled = false;
    closeStationPanel();
    if (res.error) {
      alert('Не удалось построить: ' + res.error.message);
      return;
    }
    loadStation();
  });
}

function demolishStation() {
  var btn = document.getElementById('station-demolish-btn');
  btn.disabled = true;
  supabase.rpc('demolish_space_station', { p_system_id: systemId }).then(function(res) {
    btn.disabled = false;
    closeStationPanel();
    if (res.error) {
      alert('Не удалось снести: ' + res.error.message);
      return;
    }
    loadStation();
  });
}

function loadStation() {
  supabase.from('space_stations').select('*').eq('system_id', systemId).maybeSingle().then(function(res) {
    stationRecord = (!res.error && res.data) ? res.data : null;
    renderStationSlot();
  });
}

function checkStationRights() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    currentUserId = res.data.session.user.id;
    return supabase.from('system_control').select('controller_user_id').eq('system_id', systemId).maybeSingle().then(function(controlRes) {
      isController = !controlRes.error && controlRes.data && controlRes.data.controller_user_id === currentUserId;
    });
  });
}

function getSystemIdFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('system');
}

function isBuildMode() {
  var params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'build';
}

function initBuildSwitcher() {
  if (!buildMode) return;

  var bar = document.createElement('div');
  bar.id = 'build-switcher';
  bar.innerHTML =
    '<button class="build-switch-btn" data-go="ground">Земля</button>' +
    '<button class="build-switch-btn active" data-go="space">Космос</button>' +
    '<button class="build-switch-btn" data-go="galaxy">Галактика</button>';
  document.body.appendChild(bar);

  bar.addEventListener('click', function(e) {
    var target = e.target.getAttribute('data-go');
    if (!target) return;
    if (target === 'ground') {
      window.location.href = 'ground-battle.html?system=' + systemId + '&mode=build';
    } else if (target === 'galaxy') {
      window.location.href = 'galaxy-map.html';
    }
  });
}

function applyTransform() {
  grid.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
}

// Не даёт утащить поле за пределы экрана: если поле крупнее вьюпорта —
// панорамирование ограничено его краями, если мельче — центрируется.
function clampPan() {
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight;
  var fieldPx = GRID_CELLS * CELL_PX;
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
  // центрирование поля по центру экрана при старте
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight;
  var fieldPx = GRID_CELLS * CELL_PX;
  scale = 0.4;
  panX = vw / 2 - (fieldPx * scale) / 2;
  panY = vh / 2 - (fieldPx * scale) / 2;
  clampPan();
  applyTransform();
}

function initPanAndZoom() {
  var isDragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var panStartX = 0;
  var panStartY = 0;

  // при пинче запоминаем, какая именно точка сетки была "под пальцами"
  // в момент начала жеста — и держим её там же по мере зума
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
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      panStartX = panX;
      panStartY = panY;
    } else if (e.touches.length === 2) {
      isDragging = false;
      pinchStartDist = distance(e.touches[0], e.touches[1]);
      pinchStartScale = scale;

      var mid = midpoint(e.touches[0], e.touches[1]);
      var rect = viewport.getBoundingClientRect();
      var midInViewport = { x: mid.x - rect.left, y: mid.y - rect.top };

      // точка сетки (в координатах самого поля), которая сейчас под пальцами
      anchorGridX = (midInViewport.x - panX) / scale;
      anchorGridY = (midInViewport.y - panY) / scale;
    }
  }, { passive: true });

  viewport.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1 && isDragging) {
      panX = panStartX + (e.touches[0].clientX - dragStartX);
      panY = panStartY + (e.touches[0].clientY - dragStartY);
      clampPan();
      applyTransform();
    } else if (e.touches.length === 2) {
      var newDist = distance(e.touches[0], e.touches[1]);
      var ratio = newDist / pinchStartDist;
      scale = Math.min(3, Math.max(0.2, pinchStartScale * ratio));

      var mid = midpoint(e.touches[0], e.touches[1]);
      var rect = viewport.getBoundingClientRect();
      var midInViewport = { x: mid.x - rect.left, y: mid.y - rect.top };

      // пересчитываем pan так, чтобы точка anchorGridX/Y осталась под пальцами
      panX = midInViewport.x - anchorGridX * scale;
      panY = midInViewport.y - anchorGridY * scale;

      clampPan();
      applyTransform();
    }
  }, { passive: true });

  viewport.addEventListener('touchend', function(e) {
    if (e.touches.length === 0) {
      isDragging = false;
    } else if (e.touches.length === 1) {
      // если убрали один палец из двух — начинаем перетаскивание заново с оставшимся
      isDragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      panStartX = panX;
      panStartY = panY;
    }
  });

  // на всякий случай — поддержка мыши для отладки на компьютере
  var mouseDragging = false;
  viewport.addEventListener('mousedown', function(e) {
    mouseDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
  });
  window.addEventListener('mousemove', function(e) {
    if (!mouseDragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    clampPan();
    applyTransform();
  });
  window.addEventListener('mouseup', function() {
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
    scale = Math.min(3, Math.max(0.2, scale * delta));

    panX = mx - gridX * scale;
    panY = my - gridY * scale;
    clampPan();
    applyTransform();
  }, { passive: false });
}

// Заготовка realtime-канала под конкретную планету — пока без данных,
// но подписка уже поднята, чтобы не переделывать структуру, когда
// появится сама механика размещения кораблей.
function subscribeToSpaceChanges() {
  if (!systemId) return;
  supabase
    .channel('space-' + systemId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'space_stations', filter: 'system_id=eq.' + systemId }, function() {
      loadStation();
    })
    .subscribe();
}

function initSpaceBattle() {
  systemId = getSystemIdFromUrl();
  buildMode = isBuildMode();

  viewport = document.getElementById('space-viewport');
  grid = document.getElementById('space-grid');

  var backBtn = document.getElementById('space-back-btn');
  backBtn.addEventListener('click', function() {
    window.location.href = 'galaxy-map.html';
  });

  var stationPanelClose = document.getElementById('station-panel-close');
  if (stationPanelClose) stationPanelClose.addEventListener('click', closeStationPanel);

  var stationBuildBtn = document.getElementById('station-build-btn');
  if (stationBuildBtn) stationBuildBtn.addEventListener('click', buildStation);

  var stationDemolishBtn = document.getElementById('station-demolish-btn');
  if (stationDemolishBtn) stationDemolishBtn.addEventListener('click', demolishStation);

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) {
      window.location.href = '../auth.html';
      return;
    }
    if (!systemId) return;

    stationSlot = generateStationSlot(hashStringToSeed(systemId));

    checkStationRights().then(function() {
      loadStation();
      centerGridInitially();
      initPanAndZoom();
      initBuildSwitcher();
      subscribeToSpaceChanges();
    });
  });
}

document.addEventListener('DOMContentLoaded', initSpaceBattle);
