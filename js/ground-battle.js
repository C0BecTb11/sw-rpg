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

function drawSettlement() {
  if (!settlement) return;

  var px = settlement.x * CELL_PX;
  var py = settlement.y * CELL_PX;
  var sz = settlement.size * CELL_PX;

  var img = getBuildingImage('assets/buildings/settlement.png');
  if (img && img.complete && !img.failed && img.naturalWidth > 0) {
    ctx.drawImage(img, px, py, sz, sz);
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
}

// Сколько экрана занято панелями снизу: карта должна уметь подняться
// над ними, иначе нижние ряды остаются недосягаемыми
var uiBottomInset = 0;

function setBottomInset(px) {
  var delta = px - uiBottomInset;
  uiBottomInset = px;
  panY -= delta;
  clampPan();
  applyTransform();
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
      var mine = r[0].data && r[0].data.faction;
      myFaction = mine || null;
      sysFaction = sys || null;
      renderCaptureBar();
      var sys = r[1].data && r[1].data.faction;
      if (!mine) return;
      iAmAttacker = (sys !== mine);

      // Сторона приходит отдельным запросом и может опоздать за грузом,
      // поэтому состояние кнопки пересчитываем и здесь
      var btn = document.getElementById('drop-btn');
      if (btn) {
        btn.style.visibility =
          (iAmAttacker && dropCargo.length > 0) ? 'visible' : 'hidden';
      }
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

function drawScene(grid) {
  // Присвоение canvas.width заново выделяет буфер: при 3840x3840 это
  // около 60 МБ на каждую отрисовку. Отсюда и было мигание с кусками —
  // телефон не успевал. Размер ставим один раз.
  var need = GRID_SIZE * CELL_PX;
  if (canvas.width !== need || canvas.height !== need) {
    canvas.width = need;
    canvas.height = need;
  }

  for (var y = 0; y < GRID_SIZE; y++) {
    for (var x = 0; x < GRID_SIZE; x++) {
      ctx.fillStyle = TERRAIN_COLORS[grid[y][x]];
      ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
    }
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  for (var i = 0; i <= GRID_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * CELL_PX);
    ctx.lineTo(GRID_SIZE * CELL_PX, i * CELL_PX);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * CELL_PX, 0);
    ctx.lineTo(i * CELL_PX, GRID_SIZE * CELL_PX);
    ctx.stroke();
  }

  drawSettlement();
  drawBuildSlots();
  drawDeployZone();
  drawPlacementCells();
  drawDropCells();
  drawDisembarkCells();
  drawMoveCells();
  drawDisembarkCells();
  drawAttackZone();
  drawUnits();
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
      ctx.drawImage(img, px, py, size, size);
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

function applyTransform() {
  canvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
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

function initPanAndZoom() {
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
    } else if (e.touches.length === 2) {
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

  viewport.addEventListener('touchend', function(e) {
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
    mouseDragging = true;
    mouseMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
  });
  window.addEventListener('mousemove', function(e) {
    if (!mouseDragging) return;
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

  if (droppingVehicle) {
    handleVehicleDropTap(cellX, cellY);
    return;
  }

  if (disembarking) {
    handleDisembarkTap(cellX, cellY);
    return;
  }

  if (movingUnit) {
    handleGroundMoveTap(cellX, cellY);
    return;
  }

  if (disembarking) {
    handleDisembarkTap(cellX, cellY);
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

  // Тап по своему юниту показывает его радиус обзора
  // По всему корпусу: тап по любой из четырёх клеток выбирает машину
  var tappedUnit = unitsOnMap.filter(function(u) {
    if (u.x === null || u.x === undefined) return false;
    var size = unitBox(u);
    return cellX >= u.x && cellX < u.x + size.w
        && cellY >= u.y && cellY < u.y + size.h;
  })[0];
  if (tappedUnit) {
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

    // В обычном режиме тап по своему готовому зданию открывает наём войск,
    // а карточка со сносом остаётся в режиме стройки.
    if (!buildMode && mine && ready) {
      openUnitPanel(existing);
    } else {
      openBuildingInfo(existing);
    }
    return;
  }

  if (!isController) {
    alert('У тебя нет прав на строительство на этой планете');
    return;
  }

  openBuildPanel(slotIndex);
}

// Карточка существующей постройки: название и снос за половину стоимости
// (возврат считается на сервере функцией demolish_building, клиент не может
// подменить сумму возврата).
function openBuildingInfo(building) {
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
    refundEl.textContent = 'При сносе вернётся: ' + half;
    refundEl.style.display = 'block';
  } else {
    refundEl.textContent = '';
    refundEl.style.display = 'none';
  }

  demolishBtn.style.display = isController ? 'block' : 'none';
  demolishBtn.onclick = function() {
    demolishBtn.disabled = true;
    supabase.rpc('demolish_building', { p_building_id: building.id }).then(function(res) {
      demolishBtn.disabled = false;
      closeBuildingInfo();
      if (res.error) {
        alert('Не удалось снести: ' + res.error.message);
        return;
      }
      loadBuildings();
    });
  };

  panel.style.display = 'flex';
}

function closeBuildingInfo() {
  document.getElementById('building-info-panel').style.display = 'none';
}

function openBuildPanel(slotIndex) {
  var panel = document.getElementById('build-panel');
  var list = document.getElementById('build-panel-list');
  list.innerHTML = '';

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
    info.appendChild(costEl);

    item.appendChild(info);

    item.addEventListener('click', function() {
      constructBuilding(slotIndex, type.id);
    });
    list.appendChild(item);
  });

  panel.style.display = 'flex';
}

function closeBuildPanel() {
  document.getElementById('build-panel').style.display = 'none';
}

// Строительство идёт через защищённую серверную функцию: она сама проверяет
// права контролёра, берёт цену из БД и списывает кредиты одной транзакцией —
// клиент не может подменить ни цену, ни права.
function constructBuilding(slotIndex, buildingTypeId) {
  supabase.rpc('construct_building', {
    p_system_id: systemId,
    p_slot_index: slotIndex,
    p_building_type_id: buildingTypeId
  }).then(function(res) {
    closeBuildPanel();
    if (res.error) {
      alert('Не удалось построить: ' + res.error.message);
      return;
    }
    loadBuildings();
  });
}

function loadBuildings() {
  // Через функцию, а не прямым запросом: чужим она отдаёт completes_at пустым,
  // поэтому враг не видит, что и когда у тебя достраивается.
  supabase.rpc('get_system_buildings', { p_system_id: systemId }).then(function(res) {
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
    redrawScene();
    updateRedrawTimer();
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
var redrawQueued = false;

function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  setTimeout(function() {
    redrawQueued = false;
    redrawScene();
  }, 0);
}

function redrawScene() {
  if (!ctx) return;
  if (!terrainCache) {
    terrainCache = generateTerrain(hashStringToSeed(systemId));
  }
  drawScene(terrainCache);
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
        }
      }),
      supabase.from('systems').select('faction').eq('id', systemId).maybeSingle().then(function(sysRes) {
        if (!sysRes.error && sysRes.data) systemFaction = sysRes.data.faction;
      })
    ]);
  });
}

// Realtime: любое изменение построек на этой планете — перерисовываем слоты у всех.
function subscribeToGroundChanges() {
  if (!systemId) return;
  supabase
    .channel('ground-' + systemId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'buildings', filter: 'system_id=eq.' + systemId }, function() {
      loadBuildings();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'unit_positions', filter: 'system_id=eq.' + systemId }, function() {
      loadUnits();
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

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) {
      window.location.href = '../auth.html';
      return;
    }

    if (!systemId) {
      // Карта строится от сида системы: без ?system= в адресе строить
      // нечего. Раньше код молча выходил и оставлял чёрный экран.
      showFatal('В адресе нет ?system=\n\n' +
        'Эту страницу открывают тапом по планете с карты галактики, ' +
        'а не напрямую. Сейчас адрес: ' + window.location.search);
      return;
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
      loadGroundSettings();
      loadGroundSides();
      loadSettlement();
      loadCaptureState();
      // Базу спрашиваем редко: строка меняется только при смене расклада.
      // Полосу перерисовываем локально раз в секунду.
      setInterval(loadCaptureState, 60000);
      setInterval(function() { if (captureState) renderCaptureBar(); }, 1000);
      loadDropCargo();

      var dropBtn = document.getElementById('drop-btn');
      if (dropBtn) dropBtn.addEventListener('click', openDropPanel);
      var dropClose = document.getElementById('drop-panel-close');
      if (dropClose) dropClose.addEventListener('click', closeDropPanel);
      loadBuildings();
      loadUnitOrders();
      setInterval(loadUnitOrders, 5000);
      centerGridInitially();
      initPanAndZoom();
      initBuildSwitcher();
      initBuildToggle(false);
      subscribeToGroundChanges();
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

function renderProductionSlot(building, maxPerOrder) {
  var box = document.getElementById('unit-panel-slot');
  if (!box) return;

  supabase.rpc('get_building_queue', { p_building_id: building.id }).then(function(res) {
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
        '<div class="prod-slot-title">' + (q.unit_name || 'Производство') +
          ' ×' + q.quantity + (q.mine ? '' : ' <em>чужой заказ</em>') + '</div>' +
        '<div class="prod-slot-track"><i style="width:' + pct + '%"></i></div>' +
        '<div class="prod-slot-sub">Готово через ' + formatLeft(left) + '</div>';
    };

    var left = q.seconds_left;
    draw(left);

    if (unitPanelTimer) clearInterval(unitPanelTimer);
    unitPanelTimer = setInterval(function() {
      left -= 1;
      if (left <= 0) {
        clearInterval(unitPanelTimer);
        unitPanelTimer = null;
        renderProductionSlot(building, maxPerOrder);
        return;
      }
      draw(left);
    }, 1000);
  });
}

function formatLeft(sec) {
  if (sec >= 60) {
    var m = Math.floor(sec / 60);
    return m + ' мин ' + (sec % 60) + ' с';
  }
  return sec + ' с';
}

function setUnitButtonsEnabled(on) {
  var panel = document.getElementById('unit-panel');
  if (!panel) return;
  var btns = panel.querySelectorAll('.unit-card-order, .unit-order-btn');
  for (var i = 0; i < btns.length; i++) btns[i].disabled = !on;
}

function openUnitPanel(building) {
  unitPanelBuilding = building;
  var panel = document.getElementById('unit-panel');
  var list = document.getElementById('unit-panel-list');
  var title = document.getElementById('unit-panel-title');

  title.textContent = (building.building_types && building.building_types.name) || 'Производство';
  list.innerHTML = '<div class="unit-panel-empty">Загрузка...</div>';
  panel.style.display = 'flex';

  var code = building.building_types && building.building_types.code;

  // Показываем занятость зон высадки: сервер всё равно откажет при нехватке,
  // но лучше предупредить заранее, чем ловить ошибку после нажатия.
  updateDeployCounter();

  // Предел партии задан типом постройки: казарма делает пятёрками,
  // завод техники — по одной машине
  Promise.all([
    supabase.from('unit_types').select('*').eq('produced_by', code),
    supabase.from('building_types').select('max_per_order').eq('code', code).maybeSingle()
  ]).then(function(r) {
    var res = r[0];
    var maxPerOrder = (!r[1].error && r[1].data) ? (r[1].data.max_per_order || 5) : 5;
    unitPanelMax = maxPerOrder;

    renderProductionSlot(building, maxPerOrder);

    if (res.error || !res.data || res.data.length === 0) {
      list.innerHTML = '<div class="unit-panel-empty">Это здание пока ничего не производит</div>';
      return;
    }
    unitPanelTypes = res.data;
    list.innerHTML = '';
    res.data.forEach(function(unit) {
      list.appendChild(buildUnitCard(unit));
    });
  });
}

function buildUnitCard(unit) {
  var card = document.createElement('div');
  card.className = 'unit-card';

  var media = document.createElement('div');
  media.className = 'unit-card-media';
  if (unit.image) {
    var img = document.createElement('img');
    img.src = '../' + unit.image;
    img.alt = '';
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

  if (unit.is_relay) {
    var relay = document.createElement('div');
    relay.className = 'unit-card-relay';
    relay.textContent = '⌖ Держит связь: делится обзором с союзниками';
    body.appendChild(relay);
  }

  var footer = document.createElement('div');
  footer.className = 'unit-card-footer';

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
  footer.appendChild(qty);

  var order = document.createElement('button');
  order.className = 'unit-order-btn';
  footer.appendChild(order);

  function updatePrice() {
    var n = parseInt(val.textContent, 10);
    order.textContent = 'Нанять · ' + (unit.cost * n);
  }
  updatePrice();

  order.addEventListener('click', function() {
    var n = parseInt(val.textContent, 10);
    // Сначала выбираем место на карте, заказ уходит после выбора клетки.
    startPlacement(unit.id, n);
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

  Promise.all([
    supabase.rpc('deploy_used', { p_system_id: systemId }),
    supabase.from('game_settings').select('value').eq('key', 'deploy_capacity').maybeSingle()
  ]).then(function(r) {
    var used = (!r[0].error && typeof r[0].data === 'number') ? r[0].data : 0;
    var cap = (!r[1].error && r[1].data) ? parseInt(r[1].data.value, 10) : 72;
    var free = Math.max(0, cap - used);
    el.textContent = 'Мест в зонах высадки: ' + free + ' из ' + cap;
    el.className = free === 0 ? 'unit-panel-capacity full' : 'unit-panel-capacity';
  });
}

function closeUnitPanel() {
  document.getElementById('unit-panel').style.display = 'none';
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
      res.data.forEach(function(o) {
        var left = Math.max(0, Math.ceil((new Date(o.completes_at).getTime() - Date.now()) / 1000));
        var item = document.createElement('div');
        item.className = 'order-chip';
        item.textContent = (o.unit_types ? o.unit_types.name : o.unit_type) +
                           ' ×' + o.quantity + ' · ' + left + 'с';
        bar.appendChild(item);
      });
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

function loadUnits() {
  Promise.all([
    supabase.from('unit_positions').select('*').eq('system_id', systemId).eq('layer', 'ground'),
    supabase.from('unit_types').select('*')
  ]).then(function(r) {
    unitsOnMap = (r[0].error || !r[0].data) ? [] : r[0].data;

    var inside = {};
    unitsOnMap.forEach(function(u) {
      if (u.carrier_unit_id) inside[u.carrier_unit_id] = (inside[u.carrier_unit_id] || 0) + 1;
    });
    unitsOnMap.forEach(function(u) { u.passengers = inside[u.id] || 0; });
    unitTypeById = {};
    (r[1].data || []).forEach(function(t) { unitTypeById[t.id] = t; });
    redrawScene();
  });
}

// Юнит занимает одну клетку. Свои — зелёные, союзные — синие,
// вражеские сюда просто не приходят: их отсекает туман войны в БД.
// Габариты юнита в клетках: пехота 1x1, AT-TE и канонерка 2x2
function unitBox(u) {
  var t = unitTypeById[u.unit_type];
  return { w: (t && t.width_cells) || 1, h: (t && t.height_cells) || 1 };
}

function drawUnits() {
  unitsOnMap.forEach(function(u) {
    // Перевозимые на карте не стоят — они внутри транспорта или в трюме
    if (u.x === null || u.x === undefined) return;

    var size = unitBox(u);
    var px = u.x * CELL_PX;
    var py = u.y * CELL_PX;
    var mine = u.owner_user_id === currentUserId;
    var color = mine ? '#5fd968' : '#4a90d9';
    var type = unitTypeById[u.unit_type];
    var img = type ? getUnitImage(type.image) : null;

    var inset = 2;
    var boxW = CELL_PX * size.w - inset * 2;
    var boxH = CELL_PX * size.h - inset * 2;

    ctx.fillStyle = 'rgba(5,6,10,0.85)';
    ctx.fillRect(px + inset, py + inset, boxW, boxH);

    if (img && img.complete && !img.failed && img.naturalWidth > 0) {
      // Исходник вытянутый 1:2, а клетка квадратная. Берём из кадра
      // квадратный кусок с головой и торсом — так юнит узнаётся даже
      // на иконке в 32 пикселя, и фигура не сплющивается.
      // У техники кадр квадратный и весь по делу, у пехоты берём
      // квадрат с головой и торсом
      var sw, sx, sy, sh;
      if (type && type.is_vehicle) {
        sw = img.naturalWidth; sh = img.naturalHeight; sx = 0; sy = 0;
      } else {
        sw = img.naturalWidth * 0.70;
        sx = (img.naturalWidth - sw) / 2;
        sy = img.naturalHeight * 0.07;
        sh = sw;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(px + inset, py + inset, boxW, boxH);
      ctx.clip();
      ctx.drawImage(img, sx, sy, sw, sh, px + inset, py + inset, boxW, boxH);
      ctx.restore();
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
    if (t) {
      drawCellRange(selectedUnit, t.vision_range, 'rgba(95,217,104,0.55)');
      drawCellRange(selectedUnit, t.move_range, 'rgba(74,144,217,0.55)');
    }
  }
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
  if (unit.owner_user_id !== currentUserId) { hidePickup(); return; }

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
    supabase.rpc('unit_ap_state', { p_unit_id: unit.id })
  ]).then(function(r) {
    if (!selectedUnit || selectedUnit.id !== unit.id) return;

    var ships = (!r[0].error && r[0].data) ? r[0].data : [];
    var carriers = (!r[1].error && r[1].data) ? r[1].data : [];
    var inside = (!r[2].error && r[2].data) ? r[2].data : [];
    var boardable = (!r[3].error && r[3].data) ? r[3].data : [];
    var ap = (!r[4].error && r[4].data && r[4].data.length) ? r[4].data[0] : null;

    showPickup(unit, ships, carriers, inside, boardable, ap);
  });
}

// HUD наземного юнита. Устроен как панель корабля: шапка с названием
// и состоянием, полосы прочности, точки очков действий и кнопки внизу.
// Разворота нет — у наземных нет носа и щитовых секторов.
function showPickup(unit, ships, carriers, inside, boardable, ap) {
  var bar = document.getElementById('pickup-bar');
  if (!bar) return;

  ships = ships || [];
  carriers = carriers || [];
  inside = inside || [];
  boardable = boardable || [];

  var type = unitTypeById[unit.unit_type] || {};
  var hpPct = type.max_hp ? Math.max(0, Math.min(100, unit.hp / type.max_hp * 100)) : 100;

  var html = '';

  // Шапка
  html += '<div class="gu-head">' +
    '<div class="gu-media">' +
      (type.image ? '<img src="../' + type.image + '" alt="">' : '') +
    '</div>' +
    '<div class="gu-info">' +
      '<div class="gu-name">' + (type.name || unit.unit_type) + '</div>' +
      '<div class="gu-sub">' + unit.x + ':' + unit.y +
        ' · ход до ' + (type.move_range || 4) + ' кл.' +
        (type.width_cells > 1 ? ' · ' + type.width_cells + '×' + type.height_cells : '') +
      '</div>' +
    '</div>' +
    '<button class="gu-close" id="gu-close">✕</button>' +
  '</div>';

  // Прочность
  html += '<div class="gu-bar">' +
    '<span>Прочность</span>' +
    '<div class="gu-track"><i style="width:' + hpPct + '%"></i></div>' +
    '<b>' + unit.hp + '</b>' +
  '</div>';

  // Десант внутри транспорта — своей полосой, чтобы было видно загрузку
  if (type.carry_slots > 0) {
    var used = inside.reduce(function(a, p) { return a + (p.slots || 1); }, 0);
    var pct = Math.min(100, used / type.carry_slots * 100);
    html += '<div class="gu-bar">' +
      '<span>Десант</span>' +
      '<div class="gu-track gu-track-cargo"><i style="width:' + pct + '%"></i></div>' +
      '<b>' + used + '/' + type.carry_slots + '</b>' +
    '</div>';
  }

  // Очки действий — точками, как у кораблей
  html += '<div class="gu-ap"><div class="gu-dots">';
  if (ap) {
    for (var i = 0; i < ap.ap_max; i++) {
      html += '<i class="gu-dot' + (i < ap.ap ? ' on' : '') + '"></i>';
    }
  }
  html += '</div><div class="gu-ap-text">' +
    (ap ? (ap.ap >= ap.ap_max ? 'действия готовы' : '+1 через ' + ap.next_in + ' с') : '') +
    '</div></div>';

  bar.innerHTML = html;

  // Кнопки
  var actions = document.createElement('div');
  actions.className = 'gu-actions';

  var moveBtn = document.createElement('button');
  moveBtn.className = 'gu-btn gu-btn-go';
  moveBtn.textContent = 'Идти';
  moveBtn.disabled = !ap || ap.ap < 1;
  moveBtn.addEventListener('click', function() { startGroundMove(unit); });
  actions.appendChild(moveBtn);

  bar.appendChild(actions);

  // Списки: посадка, высадка, погрузка на корабль
  var addRow = function(text, note, cls, onClick) {
    var b = document.createElement('button');
    b.className = 'gu-row' + (cls ? ' ' + cls : '');
    b.innerHTML = '<span>' + text + '</span><em>' + note + '</em>';
    if (onClick) b.addEventListener('click', function() { onClick(b); });
    else b.disabled = true;
    bar.appendChild(b);
  };

  boardable.forEach(function(b) {
    addRow('Посадить ' + b.unit_name + ' <b>' + b.x + ':' + b.y + '</b>',
           'мест ' + b.slots, 'board', function(btn) {
      btn.disabled = true;
      supabase.rpc('board_carrier', { p_unit_id: b.unit_id, p_carrier_id: unit.id })
        .then(function(r) {
          if (r.error) { alert('Не удалось посадить: ' + r.error.message); btn.disabled = false; return; }
          loadUnits();
          offerPickup(unit);
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

  var closeBtn = document.getElementById('gu-close');
  if (closeBtn) closeBtn.addEventListener('click', function() {
    selectedUnit = null; hidePickup(); redrawScene();
  });

  bar.style.visibility = 'visible';
  setBottomInset(insetFor(bar));
  focusCell(unit.x, unit.y);
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
  var occupied = {};
  unitsOnMap.forEach(function(u) {
    if (u.x === null || u.x === undefined) return;
    var b = unitBox(u);
    for (var dx = 0; dx < b.w; dx++)
      for (var dy = 0; dy < b.h; dy++)
        occupied[(u.x + dx) + ':' + (u.y + dy)] = true;
  });

  for (var y = c.y - 1; y <= c.y + size.h; y++) {
    for (var x = c.x - 1; x <= c.x + size.w; x++) {
      if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) continue;
      if (occupied[x + ':' + y]) continue;
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

// Зона хода: квадрат по дистанции Чебышёва, как у кораблей
function drawMoveCells() {
  if (!movingUnit) return;

  var type = unitTypeById[movingUnit.unit_type] || {};
  var r = type.move_range || 4;
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
  supabase.rpc('move_ground_unit', {
    p_unit_id: movingUnit.id, p_x: cellX, p_y: cellY
  }).then(function(r) {
    if (r.error) { alert('Не получилось: ' + r.error.message); return; }
    cancelGroundMove();
    selectedUnit = null;
    loadUnits();
  });
}

function hidePickup() {
  var bar = document.getElementById('pickup-bar');
  if (!bar || bar.style.visibility === 'hidden') return;
  bar.style.visibility = 'hidden';
  setBottomInset(0);
}

var dropVehicles = [];

function loadDropCargo() {
  return Promise.all([
    supabase.rpc('get_drop_ready_cargo', { p_system_id: systemId }),
    supabase.rpc('get_drop_ready_vehicles', { p_system_id: systemId })
  ]).then(function(r) {
      var res = r[0];
      dropCargo = (res.error || !res.data) ? [] : res.data;
      dropVehicles = (r[1].error || !r[1].data) ? [] : r[1].data;

      // Показываем через visibility, а не display: элемент остаётся
      // в раскладке, и его появление не заставляет браузер заново
      // растрировать лежащий под ним холст.
      // Только на чужой планете: на своей высадка идёт пачкой через
      // панель трюма, поштучная расстановка нужна при вторжении
      var btn = document.getElementById('drop-btn');
      var show = iAmAttacker === true && (dropCargo.length > 0 || dropVehicles.length > 0);
      if (btn) btn.style.visibility = show ? 'visible' : 'hidden';
    });
}

function openDropPanel() {
  var panel = document.getElementById('drop-panel');
  var list = document.getElementById('drop-panel-list');
  list.innerHTML = '';

  if (!dropCargo.length && !dropVehicles.length) {
    list.innerHTML = '<div class="drop-empty">В трюмах пусто</div>';
  }

  // Техника идёт первой: она занимает несколько клеток, и её положение
  // важнее, чем то, куда встанет отдельный пехотинец
  dropVehicles.forEach(function(v) {
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

  dropCargo.forEach(function(row) {
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
  document.getElementById('placement-hint').style.display = 'none';

  var btn = document.getElementById('drop-btn');
  if (btn && iAmAttacker && dropCargo.length) btn.style.visibility = 'visible';

  setBottomInset(0);
  redrawScene();
}

// Подсветка свободных клеток полосы вторжения
function drawDropCells() {
  if (!droppingUnit && !droppingVehicle) return;

  var vw = droppingVehicle ? droppingVehicle.width_cells : 1;
  var vh = droppingVehicle ? droppingVehicle.height_cells : 1;

  var occupied = {};
  unitsOnMap.forEach(function(u) {
    if (u.x === null || u.x === undefined) return;
    var b = unitBox(u);
    for (var dx = 0; dx < b.w; dx++)
      for (var dy = 0; dy < b.h; dy++)
        occupied[(u.x + dx) + ':' + (u.y + dy)] = true;
  });

  var boxFree = function(x, y) {
    if (y + vh > GRID_SIZE || x + vw > GRID_SIZE) return false;
    for (var dx = 0; dx < vw; dx++)
      for (var dy = 0; dy < vh; dy++)
        if (occupied[(x + dx) + ':' + (y + dy)]) return false;
    return true;
  };

  var y0 = GRID_SIZE - ATTACK_ZONE_H;
  for (var cy = y0; cy < GRID_SIZE; cy++) {
    for (var cx = 0; cx < GRID_SIZE; cx++) {
      if (!boxFree(cx, cy)) continue;
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

  if (unitsOnMap.some(function(u) { return u.x === cellX && u.y === cellY; })) {
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
function startPlacement(unitTypeId, quantity) {
  placingOrder = { unitType: unitTypeId, quantity: quantity };
  closeUnitPanel();

  var hint = document.getElementById('placement-hint');
  var t = unitTypeById[unitTypeId];
  hint.innerHTML = '<span>Выбери клетку в зоне высадки для: ' +
                   ((t && t.name) || 'юнита') + ' ×' + quantity + '</span>' +
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

  var occupied = {};
  unitsOnMap.forEach(function(u) { occupied[u.x + ':' + u.y] = true; });

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

  var taken = unitsOnMap.some(function(u) { return u.x === cellX && u.y === cellY; });
  if (taken) {
    alert('Клетка занята');
    return;
  }

  var order = placingOrder;
  cancelPlacement();

  supabase.rpc('order_unit', {
    p_building_id: unitPanelBuilding.id,
    p_unit_type: order.unitType,
    p_quantity: order.quantity,
    p_target_x: cellX,
    p_target_y: cellY
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
