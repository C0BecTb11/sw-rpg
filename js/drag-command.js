// Жест «зажал и тянешь»: общие кусочки для земли и космоса.
// Палец держат на своём бойце или корабле — через мгновение он «поднимается»,
// и дальше палец ведёт его призрак. Отпустил на пустой клетке — ход,
// на враге — выстрел. Что получится, видно заранее в подсказке над пальцем.
// Правила те же, что у обычных кнопок, и проверяет их сервер: жест только
// быстрее отдаёт приказ, но не даёт ни дальности, ни лишних действий.

var DC_HOLD_MS = 320;      // столько держать палец, чтобы боец «поднялся»
var DC_SLOP = 8;           // сдвиг пальца, после которого это уже прокрутка карты
var DC_EDGE = 44;          // у края экрана карта сама едет за пальцем
var DC_EDGE_SPEED = 14;    // пикселей за кадр у самого края

var dcChipEl = null;
var dcChipTimer = null;

function dcEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Подсказка над пальцем: что произойдёт, если отпустить здесь.
// tone: 'move' — ход, 'attack' — выстрел, 'bad' — нельзя, 'wait' — ждём сервер
function dcChip(x, y, title, sub, tone) {
  if (!dcChipEl) {
    dcChipEl = document.createElement('div');
    dcChipEl.id = 'dc-chip';
    dcChipEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(dcChipEl);
  }
  if (dcChipTimer) { clearTimeout(dcChipTimer); dcChipTimer = null; }
  var html = '<b>' + dcEsc(title) + '</b>' + (sub ? '<span>' + dcEsc(sub) + '</span>' : '');
  if (dcChipEl._html !== html) { dcChipEl.innerHTML = html; dcChipEl._html = html; }
  dcChipEl.className = 'show tone-' + (tone || 'move');

  // Над пальцем, а у верхнего края — под ним; по ширине не вылезаем за экран
  var w = dcChipEl.offsetWidth || 160;
  var h = dcChipEl.offsetHeight || 40;
  var vw = window.innerWidth;
  var left = Math.max(8, Math.min(vw - w - 8, x - w / 2));
  var top = y - h - 58;
  var below = top < 8;
  if (below) top = y + 46;
  dcChipEl.style.left = Math.round(left) + 'px';
  dcChipEl.style.top = Math.round(top) + 'px';
  dcChipEl.style.setProperty('--dc-ax', Math.round(Math.max(12, Math.min(w - 12, x - left))) + 'px');
  dcChipEl.classList.toggle('below', below);
}

function dcHideChip() {
  if (dcChipTimer) { clearTimeout(dcChipTimer); dcChipTimer = null; }
  if (dcChipEl) dcChipEl.className = '';
}

// Короткая подсказка после отпускания: «далеко», «место занято», ошибка сервера
function dcFlash(x, y, title, sub, tone, ms) {
  dcChip(x, y, title, sub, tone || 'bad');
  dcChipTimer = setTimeout(dcHideChip, ms || 2200);
}

// Лёгкий отклик под пальцем, где телефон это умеет
function dcBuzz(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) {}
}

// Скорость самопрокрутки карты, когда палец у края области карты
function dcEdgeVelocity(rect, x, y) {
  var v = { x: 0, y: 0 };
  var k = function(d) { return d < DC_EDGE ? (DC_EDGE - Math.max(0, d)) / DC_EDGE * DC_EDGE_SPEED : 0; };
  v.x = k(x - rect.left) - k(rect.right - x);
  v.y = k(y - rect.top) - k(rect.bottom - y);
  return v;
}

// Дистанция по Чебышёву — так считают и ход, и дальность на сервере
function dcCheb(x0, y0, x1, y1) {
  return Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
}

function dcCellsWord(n) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return n + ' клеток';
  if (b === 1) return n + ' клетка';
  if (b >= 2 && b <= 4) return n + ' клетки';
  return n + ' клеток';
}
