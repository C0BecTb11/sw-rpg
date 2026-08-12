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
var SLOT_SIZE = 2;    // 2x2 клетки на слот

var systemId = null;
var scale = 1;
var panX = 0;
var panY = 0;

var viewport, canvas, ctx;
var buildSlots = [];       // [{x,y}] верхний левый угол каждого слота
var buildingsBySlot = {};  // slot_index(1..N) -> запись из buildings (с подставленным building_type)
var buildingTypes = [];    // справочник типов построек
var currentUserId = null;
var isController = false;  // может ли текущий игрок строить на этой планете

function getSystemIdFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('system');
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

  var bandTop = 4;
  var bandBottom = Math.floor(GRID_SIZE * 0.26);
  var minDist = 8;   // минимальная дистанция между слотами
  var maxDist = 22;  // максимальная дистанция от первого слота (кластер, не в разброс по всей карте)

  var firstX = Math.floor(GRID_SIZE * 0.3 + rand() * GRID_SIZE * 0.4);
  var firstY = bandTop + Math.floor(rand() * (bandBottom - bandTop));
  slots.push({ x: firstX, y: firstY });

  var attempts = 0;
  while (slots.length < SLOT_COUNT && attempts < 500) {
    attempts++;
    var x = Math.max(2, Math.min(GRID_SIZE - 4, Math.floor(rand() * GRID_SIZE)));
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
    var fx2 = Math.max(2, Math.min(GRID_SIZE - 4, Math.floor(rand() * GRID_SIZE)));
    var fy2 = bandTop + Math.floor(rand() * (bandBottom - bandTop));
    slots.push({ x: fx2, y: fy2 });
  }

  return slots;
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
}

function drawBuildSlots() {
  for (var i = 0; i < buildSlots.length; i++) {
    var slot = buildSlots[i];
    var slotIndex = i + 1;
    var px = slot.x * CELL_PX;
    var py = slot.y * CELL_PX;
    var size = SLOT_SIZE * CELL_PX;

    var building = buildingsBySlot[slotIndex];

    if (building) {
      ctx.fillStyle = 'rgba(217,169,64,0.35)';
      ctx.fillRect(px, py, size, size);
      ctx.strokeStyle = '#d9a940';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, size, size);

      ctx.fillStyle = '#0a0d14';
      ctx.font = (size * 0.5) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var icon = (building.building_types && building.building_types.icon) || '■';
      ctx.fillText(icon, px + size / 2, py + size / 2);
    } else {
      ctx.fillStyle = 'rgba(120,170,220,0.15)';
      ctx.fillRect(px, py, size, size);
      ctx.strokeStyle = 'rgba(120,170,220,0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(px, py, size, size);
      ctx.setLineDash([]);
    }
  }
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
    var name = (existing.building_types && existing.building_types.name) || 'Постройка';
    alert(name); // простое информирование, полноценную карточку постройки сделаем позже
    return;
  }

  if (!isController) {
    alert('У тебя нет прав на строительство на этой планете');
    return;
  }

  openBuildPanel(slotIndex);
}

function openBuildPanel(slotIndex) {
  var panel = document.getElementById('build-panel');
  var list = document.getElementById('build-panel-list');
  list.innerHTML = '';

  buildingTypes.forEach(function(type) {
    var item = document.createElement('button');
    item.className = 'build-panel-item';
    item.innerHTML = '<span class="build-panel-icon">' + (type.icon || '■') + '</span>' +
                      '<span class="build-panel-name">' + type.name + '</span>' +
                      '<span class="build-panel-cost">' + type.cost + '</span>';
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

function constructBuilding(slotIndex, buildingTypeId) {
  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    var userId = res.data.session.user.id;

    supabase.from('profiles').select('faction').eq('id', userId).maybeSingle().then(function(profileRes) {
      var faction = profileRes.data ? profileRes.data.faction : null;

      supabase.from('buildings').insert({
        system_id: systemId,
        slot_index: slotIndex,
        building_type_id: buildingTypeId,
        owner_user_id: userId,
        faction: faction
      }).then(function(insertRes) {
        closeBuildPanel();
        if (insertRes.error) {
          alert('Не удалось построить: ' + insertRes.error.message);
          return;
        }
        loadBuildings();
      });
    });
  });
}

function loadBuildings() {
  supabase.from('buildings').select('*, building_types(*)').eq('system_id', systemId).then(function(res) {
    buildingsBySlot = {};
    if (!res.error && res.data) {
      res.data.forEach(function(b) {
        buildingsBySlot[b.slot_index] = b;
      });
    }
    var seed = hashStringToSeed(systemId);
    var terrain = generateTerrain(seed);
    drawScene(terrain);
  });
}

function checkBuildRights() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    currentUserId = res.data.session.user.id;

    return supabase.from('system_control').select('controller_user_id').eq('system_id', systemId).maybeSingle().then(function(controlRes) {
      isController = !controlRes.error && controlRes.data && controlRes.data.controller_user_id === currentUserId;
    });
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

  viewport = document.getElementById('ground-viewport');
  canvas = document.getElementById('ground-canvas');
  ctx = canvas.getContext('2d');

  var backBtn = document.getElementById('ground-back-btn');
  backBtn.addEventListener('click', function() {
    window.location.href = 'galaxy-map.html';
  });

  var buildPanelClose = document.getElementById('build-panel-close');
  if (buildPanelClose) buildPanelClose.addEventListener('click', closeBuildPanel);

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) {
      window.location.href = '../auth.html';
      return;
    }

    if (!systemId) return;

    var slotSeed = hashStringToSeed(systemId);
    buildSlots = generateBuildSlots(slotSeed);

    Promise.all([
      supabase.from('building_types').select('*').then(function(res2) {
        buildingTypes = res2.error ? [] : res2.data;
      }),
      checkBuildRights()
    ]).then(function() {
      loadBuildings();
      centerGridInitially();
      initPanAndZoom();
      subscribeToGroundChanges();
    });
  });
}

document.addEventListener('DOMContentLoaded', initGroundBattle);
