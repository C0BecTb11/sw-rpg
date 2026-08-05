// Модуль отрисовки маленьких вращающихся планет на галакарте.
// Каждая планета — canvas с текстурой, сферическое сжатие по краям (через asin),
// затемнение тёмной стороны, лёгкая тень.
//
// Данные о планетах (позиция, фракция, текстура) берутся из таблицы systems
// в Supabase, а не хранятся статически в коде — так владение фракцией можно
// менять в БД после захвата планеты в бою, и все игроки увидят актуальную
// карту без необходимости обновлять код на GitHub Pages.

var FACTION_COLORS = {
  republic: '#4a90d9', // синий
  cis:      '#d94a4a'  // красный
};

function renderRotatingPlanet(canvas, tex, radius, speed) {
  var ctx = canvas.getContext('2d');
  var size = radius * 2 + 8;
  canvas.width = size;
  canvas.height = size;

  var offsetFrac = Math.random(); // случайный старт, чтобы планеты не крутились синхронно

  function draw() {
    var cx = size / 2;
    var cy = size / 2;
    var r = radius;

    ctx.clearRect(0, 0, size, size);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    var texH = r * 2;
    var sliceDestW = 1;

    for (var dx = 0; dx < r * 2; dx += sliceDestW) {
      var nx = (dx - r) / r;
      if (nx < -0.999) nx = -0.999;
      if (nx > 0.999) nx = 0.999;
      var phi = Math.asin(nx);
      var uFrac = phi / (2 * Math.PI);

      var srcUFrac = offsetFrac + 0.5 + uFrac;
      srcUFrac = srcUFrac - Math.floor(srcUFrac);

      var srcX = srcUFrac * tex.width;
      var srcSliceW = 3;

      ctx.drawImage(
        tex,
        srcX, 0, srcSliceW, tex.height,
        cx - r + dx, cy - r, sliceDestW, texH
      );
    }

    var shadeGrad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
    shadeGrad.addColorStop(0, 'rgba(0,0,0,0.6)');
    shadeGrad.addColorStop(0.45, 'rgba(0,0,0,0)');
    shadeGrad.addColorStop(1, 'rgba(0,0,0,0.08)');
    ctx.fillStyle = shadeGrad;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    var edgeGrad = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r);
    edgeGrad.addColorStop(0, 'rgba(0,0,0,0)');
    edgeGrad.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = edgeGrad;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    ctx.restore();

    offsetFrac += speed;
    if (offsetFrac > 1) offsetFrac -= 1;

    requestAnimationFrame(draw);
  }

  tex.onload = function() { draw(); };
  if (tex.complete && tex.naturalWidth > 0) { draw(); }
}

// Ссылки на DOM-элементы уже отрисованных планет (id -> {labelEl}),
// чтобы Realtime-подписка могла точечно обновить цвет при смене владельца,
// не перерисовывая всю карту заново.
var planetElements = {};

function initPlanets() {
  var layer = document.getElementById('galaxy-layer');
  if (!layer) return;

  supabase.from('systems').select('*').then(function(res) {
    if (res.error) {
      console.error('Не удалось загрузить системы:', res.error);
      return;
    }

    var systems = res.data;

    systems.forEach(function(planet) {
      var wrapper = document.createElement('div');
      wrapper.className = 'planet-wrapper';
      wrapper.style.position = 'absolute';
      wrapper.style.left = planet.left_pct + '%';
      wrapper.style.top = planet.top_pct + '%';
      wrapper.style.transform = 'translate(-50%, -50%)';
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.alignItems = 'center';
      wrapper.setAttribute('data-planet-id', planet.id);
      layer.appendChild(wrapper);

      var canvas = document.createElement('canvas');
      canvas.className = 'planet-icon';
      canvas.style.cursor = 'pointer';
      wrapper.appendChild(canvas);

      var label = document.createElement('div');
      label.className = 'planet-label';
      label.textContent = planet.name;
      label.style.color = FACTION_COLORS[planet.faction] || '#8fa8c4';
      label.style.fontSize = '9px';
      label.style.fontFamily = "'Courier New', monospace";
      label.style.marginTop = '2px';
      label.style.whiteSpace = 'nowrap';
      label.style.textShadow = '0 1px 3px rgba(0,0,0,0.9)';
      label.style.pointerEvents = 'none';
      label.style.transition = 'color 0.6s ease';
      wrapper.appendChild(label);

      planetElements[planet.id] = { labelEl: label, wrapperEl: wrapper };

      var tex = new Image();
      // texture в БД хранится от корня сайта, а страница галакарты — в подпапке game/,
      // поэтому добавляем ../ при подстановке пути
      tex.src = '../' + planet.texture;
      renderRotatingPlanet(canvas, tex, planet.radius, planet.speed);
    });

    subscribeToSystemChanges();
  });
}

// Realtime-подписка: когда faction планеты меняется в БД (захват в бою),
// подпись у всех открытых карт перекрашивается сама, без перезагрузки страницы.
// Требует, чтобы таблица systems была добавлена в публикацию supabase_realtime
// (см. sql/enable_realtime.sql).
function subscribeToSystemChanges() {
  supabase
    .channel('systems-changes')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'systems' }, function(payload) {
      var updated = payload.new;
      var els = planetElements[updated.id];
      if (!els) return;

      var newColor = FACTION_COLORS[updated.faction] || '#8fa8c4';
      els.labelEl.style.color = newColor;

      // краткая вспышка, чтобы смена владельца была заметна визуально
      els.wrapperEl.style.filter = 'brightness(1.8)';
      setTimeout(function() {
        els.wrapperEl.style.transition = 'filter 1.2s ease';
        els.wrapperEl.style.filter = 'brightness(1)';
      }, 50);
    })
    .subscribe();
}

document.addEventListener('DOMContentLoaded', initPlanets);
