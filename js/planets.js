// Модуль отрисовки маленьких вращающихся планет на галакарте.
// Каждая планета — canvas с текстурой, сферическое сжатие по краям (через asin),
// затемнение тёмной стороны, лёгкая тень.

// Конфиг планет: позиции в процентах от контейнера карты (left/top),
// подобраны по относительному расположению на канонической карте галактики
// (Корусант — Ядро/центр, Набу и Утапау — Внутреннее Кольцо восточнее, Утапау дальше).
var PLANETS_CONFIG = [
  { id: 'coruscant', texture: 'assets/planets/coruscant.png', left: 38, top: 60, radius: 16, speed: 0.0006 },
  { id: 'naboo',      texture: 'assets/planets/naboo.png',      left: 68, top: 40, radius: 14, speed: 0.0012 },
  { id: 'utapau',     texture: 'assets/planets/utapau.png',     left: 88, top: 35, radius: 14, speed: 0.0009 }
];

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

function initPlanets() {
  var layer = document.getElementById('galaxy-layer');
  if (!layer) return;

  PLANETS_CONFIG.forEach(function(planet) {
    var canvas = document.createElement('canvas');
    canvas.className = 'planet-icon';
    canvas.style.position = 'absolute';
    canvas.style.left = planet.left + '%';
    canvas.style.top = planet.top + '%';
    canvas.style.transform = 'translate(-50%, -50%)';
    canvas.style.cursor = 'pointer';
    canvas.setAttribute('data-planet-id', planet.id);
    layer.appendChild(canvas);

    var tex = new Image();
    tex.src = planet.texture;
    renderRotatingPlanet(canvas, tex, planet.radius, planet.speed);
  });
}

document.addEventListener('DOMContentLoaded', initPlanets);
