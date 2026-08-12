// Окно фракции: название, список планет, лидер. Кнопка "Панель управления"
// видна только если текущий игрок реально является лидером (сверено с БД,
// а не просто спрятана в интерфейсе — сама панель управления тоже защищена
// RLS-политиками на бэкенде, так что даже если кто-то откроет кнопку через
// консоль, писать в system_control ему всё равно не дадут).

var FACTION_NAMES_PANEL = {
  republic: 'Республика',
  cis: 'КНС'
};

var currentPlayerFaction = null;
var currentPlayerIsLeader = false;

function openFactionScreen() {
  var screen = document.getElementById('faction-screen');
  var nameEl = document.getElementById('faction-screen-name');
  var planetsEl = document.getElementById('faction-screen-planets');
  var leaderEl = document.getElementById('faction-screen-leader');
  var controlBtn = document.getElementById('faction-control-open-btn');

  nameEl.textContent = '...';
  planetsEl.textContent = '...';
  leaderEl.textContent = '...';
  controlBtn.style.display = 'none';
  screen.style.display = 'flex';

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    var userId = res.data.session.user.id;

    supabase.from('profiles').select('faction').eq('id', userId).maybeSingle().then(function(profileRes) {
      if (profileRes.error || !profileRes.data || !profileRes.data.faction) {
        nameEl.textContent = 'Фракция ещё не назначена';
        planetsEl.textContent = '';
        leaderEl.textContent = '';
        return;
      }

      var faction = profileRes.data.faction;
      currentPlayerFaction = faction;
      nameEl.textContent = FACTION_NAMES_PANEL[faction] || faction;

      Promise.all([
        supabase.from('systems').select('name').eq('faction', faction),
        supabase.from('faction_leadership').select('leader_user_id').eq('faction', faction).maybeSingle()
      ]).then(function(results) {
        var systemsRes = results[0];
        var leadershipRes = results[1];

        if (!systemsRes.error && systemsRes.data) {
          planetsEl.textContent = systemsRes.data.map(function(s) { return s.name; }).join(', ') || 'пока нет планет';
        }

        var leaderId = (!leadershipRes.error && leadershipRes.data) ? leadershipRes.data.leader_user_id : null;

        if (!leaderId) {
          leaderEl.textContent = 'не назначен';
          currentPlayerIsLeader = false;
          return;
        }

        currentPlayerIsLeader = (leaderId === userId);
        if (currentPlayerIsLeader) {
          controlBtn.style.display = 'block';
        }

        supabase.from('profiles').select('nickname').eq('id', leaderId).maybeSingle().then(function(leaderProfileRes) {
          leaderEl.textContent = (leaderProfileRes.data && leaderProfileRes.data.nickname) || 'неизвестно';
        });
      });
    });
  });
}

function closeFactionScreen() {
  document.getElementById('faction-screen').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  var factionButton = document.getElementById('panel-item-faction');
  var closeBtn = document.getElementById('faction-screen-close');
  var controlBtn = document.getElementById('faction-control-open-btn');

  if (factionButton) factionButton.addEventListener('click', openFactionScreen);
  if (closeBtn) closeBtn.addEventListener('click', closeFactionScreen);
  if (controlBtn) {
    controlBtn.addEventListener('click', function() {
      if (typeof openFactionControlScreen === 'function') {
        openFactionControlScreen();
      }
    });
  }
});
