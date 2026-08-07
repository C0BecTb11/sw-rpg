// Логика страницы галактической карты — защита от доступа без авторизации.
// Отображение профиля (никнейм/аватар) вынесено в js/profile.js.
// Зависит от window.supabase (см. js/supabase-client.js).

function initGalaxyPage() {
  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) {
      // не авторизован — отправляем на вход
      window.location.href = '../auth.html';
    }
  });
}

document.addEventListener('DOMContentLoaded', initGalaxyPage);
