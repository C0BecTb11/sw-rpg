// Наземное поле конкретной планеты (system=id в URL).
// Ландшафт генерируется процедурно на основе id планеты как seed —
// у каждой планеты свой уникальный, но воспроизводимый рельеф
// (трава/лес/маленькие озёра, без рек и больших водоёмов).
// В верхней части поля — 7 слотов под постройки (2x2 клетки каждый),
// расположены вразброс, но в относительной близости друг к другу.
// Строить может только игрок, назначенный контролёром системы
// (system_control) — проверка реально идёт на уровне RLS в БД при записи.

var GRID_SIZE = 120;  // клеток по стороне
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
  img.onload = function() { redrawScene(); };
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
// Две зоны у самого верхнего края — выше полосы построек, поэтому наложиться
// на здания они не могут. По углам не ставим: сдвинуты к центру от краёв.
function generateDeployZones(seed) {
  var rand = mulberry32(seed ^ 0x27D4EB2F);
  var y = 2 + Math.floor(rand() * 2);

  var leftMin = Math.floor(GRID_SIZE * 0.15);
  var leftMax = Math.floor(GRID_SIZE * 0.32);
  var rightMin = Math.floor(GRID_SIZE * 0.60);
  var rightMax = Math.floor(GRID_SIZE * 0.78);

  return [
    { x: leftMin + Math.floor(rand() * (leftMax - leftMin)), y: y },
    { x: rightMin + Math.floor(rand() * (rightMax - rightMin)), y: y }
  ];
}

var TERRAIN_COLORS = {
  grass_a: '#3a5a2e',
  grass_b: '#456834',
  forest:  '#233a1c',
  lake:    '#2a5a78'
};

function drawScene(grid) {
  canvas.width = GRID_SIZE * CELL_PX;
  canvas.height = GRID_SIZE * CELL_PX;

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

  drawBuildSlots();
  drawDeployZone();
}

// Зоны высадки — тактическая информация, поэтому видны только своей фракции.
function drawDeployZone() {
  if (!showDeployZones) return;

  deployZones.forEach(function(zone) {
    var px = zone.x * CELL_PX;
    var py = zone.y * CELL_PX;
    var size = DEPLOY_SIZE * CELL_PX;

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
  var vh = viewport.clientHeight;
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

  for (var i = 0; i < buildSlots.length; i++) {
    var slot = buildSlots[i];
    if (cellX >= slot.x && cellX < slot.x + SLOT_SIZE &&
        cellY >= slot.y && cellY < slot.y + SLOT_SIZE) {
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

  var refund = Math.floor((type.cost || 0) / 2);
  refundEl.textContent = 'При сносе вернётся: ' + refund;

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
function redrawScene() {
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
    .subscribe();
}

function initGroundBattle() {
  systemId = getSystemIdFromUrl();
  buildMode = isBuildMode();

  viewport = document.getElementById('ground-viewport');
  canvas = document.getElementById('ground-canvas');
  ctx = canvas.getContext('2d');

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

    if (!systemId) return;

    var slotSeed = hashStringToSeed(systemId);
    buildSlots = generateBuildSlots(slotSeed);
    deployZones = generateDeployZones(slotSeed);

    Promise.all([
      supabase.from('building_types').select('*').then(function(res2) {
        buildingTypes = res2.error ? [] : res2.data;
      }),
      checkBuildRights()
    ]).then(function() {
      showDeployZones = (currentUserFaction && systemFaction === currentUserFaction);
      loadBuildings();
      loadUnitOrders();
      setInterval(loadUnitOrders, 5000);
      centerGridInitially();
      initPanAndZoom();
      initBuildSwitcher();
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
var unitPanelTypes = [];

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

  supabase.from('unit_types').select('*').eq('produced_by', code).then(function(res) {
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
  stats.appendChild(makeStat('➔', 'Манёвр', unit.move_range));
  stats.appendChild(makeStat('◉', 'Обзор', unit.vision_range));
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
    var n = Math.min(99, parseInt(val.textContent, 10) + 1);
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
    order.disabled = true;
    order.textContent = 'Заказываем...';
    supabase.rpc('order_unit', {
      p_building_id: unitPanelBuilding.id,
      p_unit_type: unit.id,
      p_quantity: n
    }).then(function(res) {
      order.disabled = false;
      updatePrice();
      if (res.error) {
        alert('Не удалось нанять: ' + res.error.message);
        updateDeployCounter();
        return;
      }
      closeUnitPanel();
      loadUnitOrders();
    });
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
    supabase.rpc('deploy_used', { p_system_id: systemId, p_user_id: currentUserId }),
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
