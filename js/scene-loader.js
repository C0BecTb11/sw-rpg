// Экран загрузки при переходе на поверхность и на орбиту.
// Разметка уже стоит в HTML страницы и видна с первого кадра: игрок не
// видит, как карта собирается по кускам — сначала рельеф, потом здания,
// войска, картинки, — каждый кусок перерисовывает всё поле, и слабый
// телефон в эти секунды мигает чёрным. Страница отмечает готовые части
// (sceneLoader.mark), экран уходит, когда собрано всё и карта успела
// успокоиться. Таймеры — только setTimeout: в скрытой панели
// предпросмотра кадровые колбэки не выполняются.
(function() {
  var el = document.getElementById('scene-loader');
  if (!el) return;

  var MIN_MS = 700;      // меньше — экран мелькает и сам раздражает
  var SETTLE_MS = 450;   // догрузка картинок и последние перерисовки
  var MAX_MS = 9000;     // что бы ни случилось, игру не держим

  var started = Date.now();
  var need = [];
  var got = {};
  var finished = false;
  var settleTimer = null;
  var labels = {};

  var bar = el.querySelector('.sl-bar i');
  var stepEl = el.querySelector('.sl-step');

  function paint() {
    var total = need.length || 1;
    var done = need.filter(function(k) { return got[k]; }).length;
    // Не дотягиваем до конца, пока экран не ушёл: полоса не «зависает» на 100%
    var pct = Math.round(8 + 84 * done / total);
    if (bar) bar.style.width = pct + '%';
    var next = need.filter(function(k) { return !got[k]; })[0];
    if (stepEl) stepEl.textContent = next ? (labels[next] || '') : 'Готово';
  }

  function hide() {
    if (finished) return;
    finished = true;
    if (bar) bar.style.width = '100%';
    el.classList.add('sl-out');
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 380);
  }

  function tryFinish() {
    if (finished) return;
    if (need.some(function(k) { return !got[k]; })) return;
    if (settleTimer) clearTimeout(settleTimer);
    var wait = Math.max(SETTLE_MS, MIN_MS - (Date.now() - started));
    settleTimer = setTimeout(hide, wait);
  }

  window.sceneLoader = {
    // steps: [['terrain', 'Местность'], ...] — что должно быть готово
    expect: function(steps) {
      steps.forEach(function(s) {
        if (need.indexOf(s[0]) < 0) need.push(s[0]);
        labels[s[0]] = s[1];
      });
      paint();
    },
    mark: function(key) {
      if (finished || got[key]) return;
      got[key] = true;
      paint();
      tryFinish();
    },
    hide: hide,
    isOpen: function() { return !finished; }
  };

  // Название и вид планеты — отдельным лёгким запросом
  var sys = null;
  try { sys = new URLSearchParams(window.location.search).get('system'); } catch (e) {}
  var nameEl = el.querySelector('.sl-name');
  var globe = el.querySelector('.sl-globe');
  if (sys && typeof supabase !== 'undefined' && supabase.from) {
    supabase.from('systems').select('name, texture, faction').eq('id', sys).maybeSingle().then(function(res) {
      var s = res && res.data;
      if (!s) return;
      if (nameEl && s.name) nameEl.textContent = s.name;
      if (globe && s.texture) {
        var img = new Image();
        img.onload = function() {
          globe.style.backgroundImage = 'url(../' + s.texture + ')';
          globe.classList.add('sl-has-tex');
        };
        img.src = '../' + s.texture;
      }
      if (s.faction === 'cis' || s.faction === 'republic') el.classList.add('sl-' + s.faction);
    });
  }

  // Ошибка страницы видна поверх экрана: прячем его, чтобы не мешал читать
  window.addEventListener('error', function() { setTimeout(hide, 0); });

  setTimeout(hide, MAX_MS);
})();
