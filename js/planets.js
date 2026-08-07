// Модуль отрисовки маленьких вращающихся планет на галакарте + маркеров командиров.
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

var OWN_COMMANDER_COLOR = '#5fd968';  // зелёный — свой командир
var ALLY_COMMANDER_COLOR = '#4a90d9'; // синий — союзный командир

var currentUserId = null;
var currentUserFaction = null;

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

// Ссылки на DOM-элементы уже отрисованных планет (id -> {labelEl, wrapperEl, markerBoxEl}),
// чтобы Realtime-подписки могли точечно обновлять карту, не перерисовывая всё заново.
var planetElements = {};

function initPlanets() {
  var layer = document.getElementById('galaxy-layer');
  if (!layer) return;

  supabase.auth.getSession().then(function(sessionRes) {
    currentUserId = sessionRes.data.session ? sessionRes.data.session.user.id : null;

    var factionQuery = currentUserId
      ? supabase.from('profiles').select('faction').eq('id', currentUserId).maybeSingle()
      : Promise.resolve({ data: null, error: null });

    factionQuery.then(function(profileRes) {
      currentUserFaction = profileRes.data ? profileRes.data.faction : null;

      Promise.all([
        supabase.from('systems').select('*'),
        supabase.from('hyperlanes').select('*'),
        currentUserFaction
          ? supabase.from('commanders').select('*').eq('unlocked', true).eq('faction', currentUserFaction)
          : Promise.resolve({ data: [], error: null })
      ]).then(function(results) {
      var systemsRes = results[0];
      var lanesRes = results[1];
      var commandersRes = results[2];

      if (systemsRes.error) {
        console.error('Не удалось загрузить системы:', systemsRes.error);
        return;
      }

      var systems = systemsRes.data;
      var lanes = lanesRes.error ? [] : lanesRes.data;
      var commanders = commandersRes.error ? [] : commandersRes.data;

      // словарь id -> позиция, чтобы рисовать линии между планетами
      var positions = {};
      systems.forEach(function(s) {
        positions[s.id] = { left: s.left_pct, top: s.top_pct };
      });

      drawHyperlanes(layer, lanes, positions);

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
        wrapper.style.cursor = 'pointer';
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

        // Контейнер для маркеров командиров — позиционируется в углу планеты.
        // wrapper сам position:absolute, поэтому это работает как система координат
        // для дочерних position:absolute элементов.
        var markerBox = document.createElement('div');
        markerBox.className = 'commander-marker-box';
        markerBox.style.position = 'absolute';
        markerBox.style.top = '-6px';
        markerBox.style.right = '-8px';
        markerBox.style.display = 'flex';
        markerBox.style.gap = '2px';
        markerBox.style.pointerEvents = 'none';
        wrapper.appendChild(markerBox);

        planetElements[planet.id] = { labelEl: label, wrapperEl: wrapper, markerBoxEl: markerBox };

        wrapper.addEventListener('click', function() {
          if (typeof openPlanetInfo === 'function') {
            openPlanetInfo(planet.id);
          }
        });

        var tex = new Image();
        // texture в БД хранится от корня сайта, а страница галакарты — в подпапке game/,
        // поэтому добавляем ../ при подстановке пути
        tex.src = '../' + planet.texture;
        renderRotatingPlanet(canvas, tex, planet.radius, planet.speed);
      });

      renderCommanderMarkers(commanders);
      subscribeToSystemChanges();
      subscribeToCommanderChanges();
      }); // конец Promise.all
    }); // конец factionQuery.then
  });
}

// Рисует линии гиперпространственных маршрутов между связанными системами.
// SVG вставляется первым в galaxy-layer, поэтому оказывается визуально
// позади планет (которые добавляются следом как div'ы).
function drawHyperlanes(layer, lanes, positions) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.position = 'absolute';
  svg.style.inset = '0';
  svg.style.pointerEvents = 'none';

  lanes.forEach(function(lane) {
    var a = positions[lane.system_a];
    var b = positions[lane.system_b];
    if (!a || !b) return;

    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.left + '%');
    line.setAttribute('y1', a.top + '%');
    line.setAttribute('x2', b.left + '%');
    line.setAttribute('y2', b.top + '%');
    line.setAttribute('stroke', 'rgba(120,170,200,0.35)');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(line);
  });

  layer.appendChild(svg);
}

// Отрисовывает маркеры командиров у планет: зелёный кружок с "♟" — свои
// командиры (с числом, если больше одного), синий — союзные (той же фракции,
// но другого игрока). Полностью перерисовывает все markerBox разом —
// проще и надёжнее, чем точечно диффать при небольшом масштабе игры.
function renderCommanderMarkers(commanders) {
  // сначала очищаем все существующие маркеры
  Object.keys(planetElements).forEach(function(systemId) {
    planetElements[systemId].markerBoxEl.innerHTML = '';
  });

  // группируем по системе: { systemId: { own: count, allyCount: count } }
  var bySystem = {};
  commanders.forEach(function(c) {
    if (!c.current_system) return;
    if (!bySystem[c.current_system]) {
      bySystem[c.current_system] = { own: 0, ally: 0 };
    }
    if (c.user_id === currentUserId) {
      bySystem[c.current_system].own += 1;
    } else {
      bySystem[c.current_system].ally += 1;
    }
  });

  Object.keys(bySystem).forEach(function(systemId) {
    var els = planetElements[systemId];
    if (!els) return;

    var counts = bySystem[systemId];

    if (counts.own > 0) {
      els.markerBoxEl.appendChild(makeCommanderMarker(counts.own, OWN_COMMANDER_COLOR));
    }
    if (counts.ally > 0) {
      els.markerBoxEl.appendChild(makeCommanderMarker(counts.ally, ALLY_COMMANDER_COLOR));
    }
  });
}

function makeCommanderMarker(count, color) {
  var marker = document.createElement('div');
  marker.style.display = 'flex';
  marker.style.alignItems = 'center';
  marker.style.gap = '1px';
  marker.style.background = 'rgba(5,6,10,0.85)';
  marker.style.border = '1px solid ' + color;
  marker.style.borderRadius = '8px';
  marker.style.padding = '1px 4px';
  marker.style.fontSize = '9px';
  marker.style.fontFamily = "'Courier New', monospace";
  marker.style.color = color;
  marker.style.lineHeight = '1';

  var icon = document.createElement('span');
  icon.textContent = '♟';
  marker.appendChild(icon);

  if (count > 1) {
    var countEl = document.createElement('span');
    countEl.textContent = 'x' + count;
    marker.appendChild(countEl);
  }

  return marker;
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

// Realtime-подписка на командиров: при появлении/перемещении/разблокировке
// командира любым игроком — карта у всех перерисовывает маркеры заново.
function subscribeToCommanderChanges() {
  supabase
    .channel('commanders-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'commanders' }, function() {
      if (!currentUserFaction) return;
      supabase.from('commanders').select('*').eq('unlocked', true).eq('faction', currentUserFaction).then(function(res) {
        if (res.error) return;
        renderCommanderMarkers(res.data);
      });
    })
    .subscribe();
}

document.addEventListener('DOMContentLoaded', initPlanets);
