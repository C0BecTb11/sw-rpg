// Логика страницы галактической карты.
// Зависит от window.supabase (см. js/supabase-client.js).

function initGalaxyPage() {
  var userEmailEl = document.getElementById('user-email');

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) {
      // не авторизован — отправляем на вход
      window.location.href = '../auth.html';
      return;
    }
    userEmailEl.textContent = res.data.session.user.email;
  });
}

document.addEventListener('DOMContentLoaded', initGalaxyPage);
