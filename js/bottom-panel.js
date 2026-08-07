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
    });
  });
}

document.addEventListener('DOMContentLoaded', function() {
  initBottomPanelToggle();
  initFactionBadge();
});
