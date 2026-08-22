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
var STATION_SIZE = 8;      // слот станции, размер приходит из БД

// Арт станции по фракции. Своей таблицы типов у станций нет — вариант
// ровно один на фракцию, поэтому держим соответствие здесь, как сделано
// с цветами фракций в planets.js и bottom-panel.js.
var STATION_IMAGES = {
  republic: 'assets/stations/station-republic.png',
  cis: 'assets/stations/station-cis.png'
};
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

// Позиция слота станции приходит из БД: там же её проверяет сервер,
// когда расставляет построенные корабли вокруг станции.
function loadStationSlot() {
  return supabase.from('station_slots').select('*').eq('system_id', systemId).maybeSingle()
    .then(function(res) {
      if (res.error) {
        console.error('Не удалось загрузить слот станции:', res.error);
      } else if (!res.data) {
        console.error('Для этой системы нет записи в station_slots — выполни sql/ships.sql');
      }
      stationSlot = (res.error || !res.data) ? null : res.data;
      if (stationSlot && stationSlot.size) STATION_SIZE = stationSlot.size;
    });
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
    var art = STATION_IMAGES[stationRecord.faction];
    if (art) {
      // Станция — постройка, а не корабль: разворачивать её не нужно,
      // рендер уже сверху. Вписываем в квадрат слота по ширине.
      var im = document.createElement('img');
      im.src = '../' + art;
      im.alt = '';
      im.style.width = '100%';
      im.style.height = '100%';
      im.style.objectFit = 'contain';
      im.style.pointerEvents = 'none';
      im.style.filter = 'drop-shadow(0 0 ' + (CELL_PX * 0.4) + 'px rgba(0,0,0,0.8))';
      // Если файл не подхватился, откатываемся на прежний значок
      im.addEventListener('error', function() {
        if (im.parentNode) im.parentNode.removeChild(im);
        el.style.border = '2px solid #d9a940';
        el.style.color = '#d9a940';
        el.style.fontSize = (STATION_SIZE * CELL_PX * 0.35) + 'px';
        el.textContent = '⬢';
      });
      el.appendChild(im);
    } else {
      el.style.background = 'rgba(217,169,64,0.25)';
      el.style.border = '2px solid #d9a940';
      el.style.color = '#d9a940';
      el.style.fontSize = (STATION_SIZE * CELL_PX * 0.35) + 'px';
      el.textContent = '⬢';
    }
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

  var shipyardBtn = document.getElementById('station-shipyard-btn');

  if (stationRecord) {
    titleEl.textContent = stationRecord.name || 'Космическая станция';
    textEl.textContent = 'Верфь готова к постройке кораблей';
    buildBtn.style.display = 'none';
    demolishBtn.style.display = isController ? 'block' : 'none';
    // Верфь доступна владельцу станции: заказы проверяет сервер
    if (shipyardBtn) shipyardBtn.style.display =
      (stationRecord.owner_user_id === currentUserId) ? 'block' : 'none';
  } else {
    titleEl.textContent = 'Слот космической станции';
    textEl.textContent = isController ? 'Здесь можно построить станцию' : 'У тебя нет прав на строительство здесь';
    buildBtn.style.display = isController ? 'block' : 'none';
    demolishBtn.style.display = 'none';
    if (shipyardBtn) shipyardBtn.style.display = 'none';
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

// Полоса гиперпространства. Своя видна целиком, чужой на карте просто
// нет — её и не должно быть видно, за это же отвечает RLS в базе.
var ZONE_HEIGHT = 14;
var myZoneSide = null;

function loadHyperspaceZone() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;

    return Promise.all([
      supabase.from('profiles').select('faction').eq('id', res.data.session.user.id).maybeSingle(),
      supabase.from('systems').select('faction').eq('id', systemId).maybeSingle(),
      supabase.from('game_settings').select('key, value')
    ]).then(function(r) {
      var myFaction = (r[0].data && r[0].data.faction) || null;
      var sysFaction = (r[1].data && r[1].data.faction) || null;

      (r[2].data || []).forEach(function(row) {
        if (row.key === 'hyperspace_zone_height') ZONE_HEIGHT = parseInt(row.value, 10) || 14;
      });

      if (!myFaction) return;

      // Та же логика, что в hyperspace_side на сервере: хозяин системы
      // обороняется сверху, пришедший заходит снизу. У ничейной системы
      // стороны закреплены за фракциями, иначе враги делили бы одну полосу.
      if (!sysFaction) {
        myZoneSide = (myFaction === 'republic') ? 'top' : 'bottom';
      } else {
        myZoneSide = (sysFaction === myFaction) ? 'top' : 'bottom';
      }

      renderHyperspaceZone();
      loadOrbitalDropZones();
    });
  });
}

// Площадки сброса десанта. Показываем только нападающему — обороняющийся
// не должен видеть, что там стоит, иначе он просто караулил бы обе.
function loadOrbitalDropZones() {
  // Рисуем площадки обеим сторонам: их расположение фиксировано и секретом
  // не является, а переброска десанта теперь идёт через них у всех.
  // Скрытым остаётся содержимое — за это отвечает can_see_space в базе,
  // и обороняющийся по-прежнему не увидит, чьи корабли там стоят.
  if (!myZoneSide) return;

  supabase.rpc('orbital_drop_zones').then(function(res) {
    if (res.error || !res.data) return;

    res.data.forEach(function(z) {
      var el = document.createElement('div');
      el.className = 'orbital-drop-zone';
      el.style.left = (z.x * CELL_PX) + 'px';
      el.style.top = (z.y * CELL_PX) + 'px';
      el.style.width = (z.size * CELL_PX) + 'px';
      el.style.height = (z.size * CELL_PX) + 'px';

      var label = document.createElement('span');
      label.textContent = 'СБРОС ' + z.idx;
      el.appendChild(label);

      grid.insertBefore(el, grid.firstChild);
    });
  });
}

function renderHyperspaceZone() {
  var old = grid.querySelector('.hyperspace-zone');
  if (old) old.parentNode.removeChild(old);
  if (!myZoneSide) return;

  var band = document.createElement('div');
  band.className = 'hyperspace-zone ' + myZoneSide;
  band.style.left = '0px';
  band.style.width = (GRID_CELLS * CELL_PX) + 'px';
  band.style.height = (ZONE_HEIGHT * CELL_PX) + 'px';
  band.style.top = (myZoneSide === 'top'
    ? 0
    : (GRID_CELLS - ZONE_HEIGHT) * CELL_PX) + 'px';

  var label = document.createElement('span');
  label.className = 'hyperspace-zone-label';
  label.textContent = 'Зона гиперпространства';
  band.appendChild(label);

  // Полоса должна лежать под кораблями, иначе перехватит тапы по ним
  grid.insertBefore(band, grid.firstChild);
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
// Сколько места внизу занимает HUD корабля. Без этого выбранный корабль
// и клетки под панелью оказывались недосягаемы: ходить некуда, потому что
// половина вариантов спрятана под самой панелью управления.
var uiBottomInset = 0;

function setBottomInset(px) {
  var delta = px - uiBottomInset;
  uiBottomInset = px;
  panY -= delta;
  clampPan();
  applyTransform();
}

// Доводит карту до клетки, центрируя её над панелью управления
function focusCell(cx, cy) {
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight - uiBottomInset;
  panX = vw / 2 - (cx + 0.5) * CELL_PX * scale;
  panY = vh / 2 - (cy + 0.5) * CELL_PX * scale;
  clampPan();
  applyTransform();
}

function clampPan() {
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight - uiBottomInset;
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ships', filter: 'system_id=eq.' + systemId }, function() {
      loadShips();
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

  var shipyardOpen = document.getElementById('station-shipyard-btn');
  if (shipyardOpen) shipyardOpen.addEventListener('click', function() {
    closeStationPanel();
    openShipyard();
  });

  var shipyardClose = document.getElementById('shipyard-close');
  if (shipyardClose) shipyardClose.addEventListener('click', closeShipyard);

  var shipInfoClose = document.getElementById('ship-info-close');
  if (shipInfoClose) shipInfoClose.addEventListener('click', closeShipInfo);

  setInterval(loadShipOrders, 5000);

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) {
      window.location.href = '../auth.html';
      return;
    }
    if (!systemId) return;

    Promise.all([loadStationSlot(), checkStationRights(), loadHyperspaceZone()]).then(function() {
      loadStation();
      loadShips();
      centerGridInitially();
      initPanAndZoom();
      initBuildSwitcher();
      initBuildToggle(true);
      subscribeToSpaceChanges();
    });
  });
}

document.addEventListener('DOMContentLoaded', initSpaceBattle);

// ===== Корабли =====

var shipsInSystem = [];
var shipTypeById = {};
var shipImages = {};

function getShipImage(path) {
  if (!path) return null;
  if (shipImages[path]) return shipImages[path];
  var img = new Image();
  img.src = '../' + path;
  img.onload = function() { renderShips(); };
  img.onerror = function() { img.failed = true; };
  shipImages[path] = img;
  return img;
}

function loadShips() {
  Promise.all([
    // Корабли в гиперпространстве на карте не показываем: они уже
    // покинули систему и физически здесь их нет
    supabase.from('ships').select('*').eq('system_id', systemId).eq('in_transit', false),
    supabase.from('ship_types').select('*')
  ]).then(function(r) {
    shipsInSystem = (r[0].error || !r[0].data) ? [] : r[0].data;
    shipTypeById = {};
    (r[1].data || []).forEach(function(t) { shipTypeById[t.id] = t; });
    renderShips();
    loadShipOrders();
    if (typeof onShipsReloaded === 'function') onShipsReloaded();
  });
}

// Габариты корабля в клетках с учётом разворота. Формула повторяет
// ship_box_w / ship_box_h на сервере — расхождение здесь означало бы,
// что игрок видит одно, а база считает другое.
function shipBoxCells(type, facing) {
  var w = type.width_cells, h = type.height_cells;
  if (facing === 0 || facing === 180) return { w: w, h: h };
  if (facing === 90 || facing === 270) return { w: h, h: w };
  var d = Math.ceil((w + h) / Math.SQRT2);
  return { w: d, h: d };
}

// Корабли рисуем элементами поверх сетки: спрайт занимает ровно тот
// прямоугольник клеток, который прописан у типа в БД.
function renderShips() {
  var old = grid.querySelectorAll('.ship-sprite');
  for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);

  shipsInSystem.forEach(function(ship) {
    var type = shipTypeById[ship.ship_type];
    if (!type) return;

    var facing = ship.facing || 0;
    var box = shipBoxCells(type, facing);

    // Внешний элемент — занятые клетки (габарит с учётом разворота),
    // внутри него спрайт в исходных размерах, повёрнутый вокруг центра.
    var el = document.createElement('div');
    el.className = 'ship-sprite';
    el.style.position = 'absolute';
    el.style.left = (ship.x * CELL_PX) + 'px';
    el.style.top = (ship.y * CELL_PX) + 'px';
    el.style.width = (box.w * CELL_PX) + 'px';
    el.style.height = (box.h * CELL_PX) + 'px';
    el.style.cursor = 'pointer';

    var mine = ship.owner_user_id === currentUserId;
    el.style.outline = '2px solid ' + (mine ? 'rgba(95,217,104,0.8)' : 'rgba(217,74,74,0.8)');

    var img = getShipImage(type.image);
    if (img && img.complete && !img.failed) {
      var inner = document.createElement('div');
      inner.style.position = 'absolute';
      inner.style.left = '50%';
      inner.style.top = '50%';
      inner.style.width = (type.width_cells * CELL_PX) + 'px';
      inner.style.height = (type.height_cells * CELL_PX) + 'px';
      // Спрайты нарисованы носом вверх, поэтому facing совпадает с углом
      inner.style.transform = 'translate(-50%, -50%) rotate(' + facing + 'deg)';
      inner.style.transformOrigin = '50% 50%';

      var im = document.createElement('img');
      im.src = img.src;
      im.style.width = '100%';
      im.style.height = '100%';
      im.style.display = 'block';
      inner.appendChild(im);
      el.appendChild(inner);
    }

    el.addEventListener('click', function(e) {
      e.stopPropagation();
      // Своими кораблями управляем через HUD, чужие — только карточка
      if (mine && typeof onOwnShipTapped === 'function') {
        onOwnShipTapped(ship, type);
      } else {
        openShipInfo(ship, type);
      }
    });

    grid.appendChild(el);
  });
}

function openShipInfo(ship, type) {
  var panel = document.getElementById('ship-info');
  document.getElementById('ship-info-name').textContent = type.name;
  fillShipCommanders(ship);
  document.getElementById('ship-info-stats').innerHTML =
    '<div><span>Прочность</span><b>' + ship.hp + ' / ' + type.max_hp + '</b></div>' +
    '<div><span>Урон</span><b>' + type.damage + '</b></div>' +
    '<div><span>Обзор</span><b>' + type.vision_range + ' кл.</b></div>' +
    '<div><span>Ход</span><b>' + type.move_range + ' кл.</b></div>' +
    '<div><span>Трюм</span><b>' + type.capacity + ' слотов</b></div>' +
    '<div><span>Размер</span><b>' + type.width_cells + '×' + type.height_cells + '</b></div>';
  panel.style.display = 'flex';
}

// Передача корабля командиру: в списке только свои командиры, которые
// стоят в этой же системе и не в пути — остальных сервер всё равно отклонит.
function fillShipCommanders(ship) {
  var box = document.getElementById('ship-info-commander');
  if (!box) return;

  if (ship.owner_user_id !== currentUserId) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = '<div class="ship-assign-title">Командир флота</div>' +
    '<div class="ship-assign-note">Корабль сам никуда не летит. Прикрепи его ' +
    'к своему командиру в этой системе — тогда он пойдёт за ним на другую планету.</div>';

  supabase.from('commanders').select('*')
    .eq('user_id', currentUserId).eq('unlocked', true)
    .then(function(res) {
      var here = (res.data || []).filter(function(c) {
        return !c.moving_to && c.current_system === ship.system_id;
      });

      var select = document.createElement('select');
      select.className = 'ship-assign-select';

      var none = document.createElement('option');
      none.value = '';
      none.textContent = '— без командира —';
      select.appendChild(none);

      here.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (ship.commander_id === c.id) opt.selected = true;
        select.appendChild(opt);
      });

      select.addEventListener('change', function() {
        supabase.rpc('assign_ship', {
          p_ship_id: ship.id,
          p_commander_id: select.value || null
        }).then(function(r) {
          if (r.error) { alert(r.error.message); return; }
          ship.commander_id = select.value || null;
          loadShips();
        });
      });

      box.appendChild(select);

      if (here.length === 0) {
        var hint = document.createElement('div');
        hint.className = 'ship-assign-hint';
        hint.textContent = 'В этой системе нет твоих свободных командиров';
        box.appendChild(hint);
      }
    });
}

function closeShipInfo() {
  document.getElementById('ship-info').style.display = 'none';
}

// ===== Верфь: заказ кораблей на станции =====

function openShipyard() {
  var panel = document.getElementById('shipyard-panel');
  var list = document.getElementById('shipyard-list');
  list.innerHTML = '<div class="shipyard-empty">Загрузка...</div>';
  panel.style.display = 'flex';

  supabase.rpc('get_my_profile').then(function(pr) {
    var faction = (!pr.error && pr.data && pr.data.length) ? pr.data[0].faction : null;

    supabase.from('ship_types').select('*').eq('faction', faction).then(function(res) {
      if (res.error || !res.data || res.data.length === 0) {
        list.innerHTML = '<div class="shipyard-empty">Нет доступных кораблей</div>';
        return;
      }
      list.innerHTML = '';
      res.data.forEach(function(type) {
        list.appendChild(makeShipCard(type));
      });
    });
  });
}

function closeShipyard() {
  document.getElementById('shipyard-panel').style.display = 'none';
}

function makeShipCard(type) {
  var card = document.createElement('div');
  card.className = 'ship-card';

  var media = document.createElement('div');
  media.className = 'ship-card-media';
  if (type.image) {
    var im = document.createElement('img');
    im.src = '../' + type.image;
    media.appendChild(im);
  }
  card.appendChild(media);

  var body = document.createElement('div');
  body.className = 'ship-card-body';

  var name = document.createElement('div');
  name.className = 'ship-card-name';
  name.textContent = type.name;
  body.appendChild(name);

  if (type.description) {
    var d = document.createElement('div');
    d.className = 'ship-card-desc';
    d.textContent = type.description;
    body.appendChild(d);
  }

  var stats = document.createElement('div');
  stats.className = 'ship-card-stats';
  stats.innerHTML =
    '<div><span>Прочность</span><b>' + type.max_hp + '</b></div>' +
    '<div><span>Урон</span><b>' + type.damage + '</b></div>' +
    '<div><span>Обзор</span><b>' + type.vision_range + ' кл.</b></div>' +
    '<div><span>Трюм</span><b>' + type.capacity + '</b></div>';
  body.appendChild(stats);

  var btn = document.createElement('button');
  btn.className = 'ship-order-btn';
  btn.textContent = 'Построить · ' + type.cost;
  btn.addEventListener('click', function() {
    btn.disabled = true;
    supabase.rpc('order_ship', { p_system_id: systemId, p_ship_type: type.id })
      .then(function(res) {
        btn.disabled = false;
        if (res.error) {
          alert(res.error.message);
          return;
        }
        closeShipyard();
        loadShipOrders();
      });
  });
  body.appendChild(btn);

  card.appendChild(body);
  return card;
}

function loadShipOrders() {
  supabase.from('ship_orders').select('*, ship_types(name)')
    .eq('system_id', systemId).eq('delivered', false)
    .then(function(res) {
      var bar = document.getElementById('ship-queue');
      if (!bar) return;
      if (res.error || !res.data || res.data.length === 0) {
        bar.style.display = 'none';
        return;
      }
      bar.innerHTML = '';
      bar.style.display = 'flex';
      res.data.forEach(function(o) {
        var left = Math.max(0, Math.ceil((new Date(o.completes_at).getTime() - Date.now()) / 1000));
        var chip = document.createElement('div');
        chip.className = 'order-chip';
        chip.textContent = (o.ship_types ? o.ship_types.name : o.ship_type) + ' · ' + left + 'с';
        bar.appendChild(chip);
      });
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
