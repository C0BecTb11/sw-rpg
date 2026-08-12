// Космическое пространство конкретной планеты (system=id в URL).
// Сейчас поле полностью пустое — задел под будущее размещение кораблей
// и космическую оборону. Realtime-канал подписывается уже сейчас,
// чтобы инфраструктура была готова, когда появится сама механика
// (таблица space_units и т.п. добавится вместе с той механикой).

var systemId = null;
var scale = 1;
var panX = 0;
var panY = 0;

var viewport, grid;

function getSystemIdFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('system');
}

function applyTransform() {
  grid.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
}

// Не даёт утащить поле за пределы экрана: если поле крупнее вьюпорта —
// панорамирование ограничено его краями, если мельче — центрируется.
function clampPan() {
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight;
  var fieldPx = 4000;
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
  // грубое центрирование поля 4000x4000 по центру экрана при старте
  var vw = viewport.clientWidth;
  var vh = viewport.clientHeight;
  scale = 0.5;
  panX = vw / 2 - (4000 * scale) / 2;
  panY = vh / 2 - (4000 * scale) / 2;
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
    .subscribe();
}

function initSpaceBattle() {
  systemId = getSystemIdFromUrl();

  viewport = document.getElementById('space-viewport');
  grid = document.getElementById('space-grid');

  var backBtn = document.getElementById('space-back-btn');
  backBtn.addEventListener('click', function() {
    window.location.href = 'galaxy-map.html';
  });

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) {
      window.location.href = '../auth.html';
      return;
    }
    centerGridInitially();
    initPanAndZoom();
    subscribeToSpaceChanges();
  });
}

document.addEventListener('DOMContentLoaded', initSpaceBattle);
