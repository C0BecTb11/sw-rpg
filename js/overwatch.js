// Режим «На чеку» — общий для земли и орбиты.
//
// Включённый юнит сам стреляет по ближайшему врагу, которого видит и
// достаёт оружием, — каждый раз, когда у него готово действие. Стреляет
// сервер (overwatch_tick раз в несколько секунд) обычным выстрелом от
// имени хозяина: те же обзор, дальность, шанс и урон. Любой ручной
// приказ — ход, выстрел, способность, автоход — режим снимает.
//
// Здесь только общее: зона огня, тексты, переключение и трассер выстрела.
// Плитки и отметки на карте — в ground-battle.js и ship-control.js.

var OW_COLOR = '#e8923a';
var owBusy = false;

// Зона огня: столько клеток, сколько юнит и видит, и достаёт оружием
function owReachUnit(u, type) {
  if (!u || !type) return 0;
  var vis = (type.vision_range || 0) + (u.bonus_vision || 0);
  var rng = (type.weapon_range || 0) + (u.bonus_range || 0);
  return Math.max(0, Math.min(vis, rng));
}

function owReachShip(s, type) {
  if (!s || !type) return 0;
  var vis = (type.vision_range || 0) + (s.bonus_vision || 0);
  return Math.max(0, Math.min(vis, type.weapon_range || 0));
}

// Может ли тип вообще стоять на чеку: вооружён и бьёт прицельно, не залпом
function owArmedReason(type, isShip) {
  if (!type) return 'нет данных о юните';
  if (!isShip && (type.splash_size || 0) > 0) return 'артиллерия бьёт только залпом по площади';
  if (!(type.damage > 0) || !(type.weapon_range > 0)) return 'не вооружён — стрелять нечем';
  return null;
}

function owCellsWord(n) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return n + ' клеток';
  if (b === 1) return n + ' клетка';
  if (b >= 2 && b <= 4) return n + ' клетки';
  return n + ' клеток';
}

// Описание для правой части панели способностей
function owInfoHtml(on, reach, why, cls) {
  var p = cls || 'gu';
  return '<div class="' + p + '-abil-name">На чеку</div>' +
    '<div class="' + p + '-abil-text">Держит позицию и сам стреляет по ближайшему врагу, ' +
    'которого видит и достаёт оружием, — как только готово действие. ' +
    'Нет действий — ждёт.</div>' +
    (why ? '<div class="' + p + '-abil-meta warn">' + why + '</div>'
         : '<div class="' + p + '-abil-meta">зона огня ' + owCellsWord(reach) +
           ' · ход, выстрел или способность снимут режим</div>') +
    (on ? '<div class="' + p + '-abil-meta ow-on-note">◉ сейчас на чеку</div>' : '');
}

// Полоса состояния под очками действий
function owStripHtml(reach) {
  return '<span class="ow-strip-ico">◉</span>' +
    '<span class="ow-strip-txt"><b>На чеку</b>' +
      '<span>огонь по врагам в ' + owCellsWord(reach) + '</span></span>' +
    '<button type="button" class="ow-strip-btn" data-ow="off">Снять</button>';
}

// Переключение на сервере. done(err) — err строкой или null
function owSet(layer, ids, on, done) {
  if (owBusy) return;
  owBusy = true;
  Promise.resolve(supabase.rpc('set_overwatch', { p_layer: layer, p_ids: ids, p_on: !!on }))
    .then(function(r) {
      owBusy = false;
      var err = r && r.error ? (r.error.message || 'не удалось') : null;
      if (err && /could not find the function|does not exist/i.test(err)) {
        err = 'Режим «на чеку» пока не включён на сервере';
      }
      done(err);
    }, function(e) {
      owBusy = false;
      done((e && e.message) || 'нет связи с сервером');
    });
}

// Новый выстрел на чеку с прошлой загрузки: отметка времени сменилась
// и свежая (старые после перезахода не показываем)
function owNewShot(prev, next) {
  if (!next || !next.ow_shot_at) return false;
  if (prev && prev.ow_shot_at === next.ow_shot_at) return false;
  var at = new Date(next.ow_shot_at).getTime();
  // Часы сервера, если они уже сверены; иначе — свои
  var now = typeof scServerNow === 'function' ? scServerNow()
          : (typeof svNow === 'function' ? svNow() : NaN);
  if (!isFinite(now)) now = Date.now();
  return !isNaN(at) && now - at < 15000;
}

// Трассер: оранжевая черта от стрелка к цели в координатах поля (px).
// Промах — черта уходит мимо и гаснет без вспышки.
function owTracer(layer, x1, y1, x2, y2, hit) {
  if (!layer) return;
  var dx = x2 - x1, dy = y2 - y1;
  if (!hit) {
    // Мимо: чуть отводим конец в сторону и продлеваем
    var len0 = Math.sqrt(dx * dx + dy * dy) || 1;
    var ox = -dy / len0 * 10, oy = dx / len0 * 10;
    x2 += ox + dx / len0 * 14;
    y2 += oy + dy / len0 * 14;
    dx = x2 - x1; dy = y2 - y1;
  }
  var len = Math.sqrt(dx * dx + dy * dy);
  var ang = Math.atan2(dy, dx) * 180 / Math.PI;

  var line = document.createElement('div');
  line.className = 'ow-tracer' + (hit ? '' : ' miss');
  line.style.left = x1 + 'px';
  line.style.top = y1 + 'px';
  line.style.width = Math.max(6, len) + 'px';
  line.style.transform = 'rotate(' + ang + 'deg)';
  layer.appendChild(line);

  var flash = null;
  if (hit) {
    flash = document.createElement('div');
    flash.className = 'ow-flash';
    flash.style.left = x2 + 'px';
    flash.style.top = y2 + 'px';
    layer.appendChild(flash);
  }

  setTimeout(function() {
    if (line.parentNode) line.parentNode.removeChild(line);
    if (flash && flash.parentNode) flash.parentNode.removeChild(flash);
  }, 1000);
}
