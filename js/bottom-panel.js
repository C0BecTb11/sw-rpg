// Нижняя панель интерфейса: сворачивание/разворачивание кнопкой,
// плюс подстановка эмблемы и названия фракции текущего игрока.

var FACTION_NAMES = {
  republic: 'Республика',
  cis: 'КНС'
};

// Тот же цвет, что и в planets.js (FACTION_COLORS) — держим в одном стиле,
// но не завязываемся на порядок загрузки файлов, поэтому продублировано.
var PANEL_FACTION_COLORS = {
  republic: '#4a90d9',
  cis: '#d94a4a'
};

// Эмблемы уже перекрашены в цвет фракции, так что подставлять их
// можно как есть — без CSS-фильтров и второго набора файлов.
var PANEL_FACTION_EMBLEMS = {
  republic: 'assets/ui/faction-republic.png',
  cis: 'assets/ui/faction-cis.png'
};

function initBottomPanelToggle() {
  var panel = document.getElementById('bottom-panel');
  var toggle = document.getElementById('bottom-panel-toggle');
  if (!panel || !toggle) return;

  toggle.addEventListener('click', function() {
    panel.classList.toggle('collapsed');
  });
}

function initFactionBadge() {
  var emblemEl = document.getElementById('faction-emblem');
  var labelEl = document.getElementById('faction-label');
  if (!emblemEl || !labelEl) return;

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;

    supabase.from('profiles').select('faction').eq('id', res.data.session.user.id).maybeSingle().then(function(profileRes) {
      if (profileRes.error || !profileRes.data || !profileRes.data.faction) return;

      var faction = profileRes.data.faction;
      labelEl.textContent = FACTION_NAMES[faction] || 'Фракция';
      emblemEl.style.borderColor = PANEL_FACTION_COLORS[faction] || '#2a3644';
      emblemEl.style.color = PANEL_FACTION_COLORS[faction] || '#cfd8dc';

      var art = PANEL_FACTION_EMBLEMS[faction];
      if (!art) return;

      var im = document.createElement('img');
      im.src = '../' + art;
      im.alt = '';
      im.className = 'faction-emblem-img';
      // Пока картинка не загрузилась, в кружке остаётся прежний символ;
      // подменяем его только после успешной загрузки
      im.addEventListener('load', function() {
        emblemEl.textContent = '';
        emblemEl.appendChild(im);
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', function() {
  initBottomPanelToggle();
  initFactionBadge();
});
