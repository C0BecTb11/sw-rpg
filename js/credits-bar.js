// Панель кредитов в правом верхнем углу. Подключается на любой экран,
// где нужна — достаточно добавить этот файл, разметку она создаёт сама.
//
// Баланс приходит из get_my_profile (столбец credits закрыт от прямого
// чтения другими игроками), и обновляется по realtime — потратил на стройку
// и цифра поменялась сразу, без перезагрузки страницы.

var creditsBarUserId = null;

function renderCreditsBar(value) {
  var el = document.getElementById('credits-value');
  if (el) el.textContent = value;
}

function initCreditsBar() {
  if (document.getElementById('credits-bar')) return;

  var bar = document.createElement('div');
  bar.id = 'credits-bar';
  bar.innerHTML = '<span id="credits-icon">◈</span><span id="credits-value">—</span>';
  document.body.appendChild(bar);

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    creditsBarUserId = res.data.session.user.id;

    supabase.rpc('get_my_profile').then(function(profRes) {
      if (!profRes.error && profRes.data && profRes.data.length > 0) {
        renderCreditsBar(profRes.data[0].credits);
      }
    });

    supabase
      .channel('credits-' + creditsBarUserId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: 'id=eq.' + creditsBarUserId
      }, function(payload) {
        if (payload.new && typeof payload.new.credits !== 'undefined') {
          renderCreditsBar(payload.new.credits);
        }
      })
      .subscribe();
  });
}

document.addEventListener('DOMContentLoaded', initCreditsBar);
