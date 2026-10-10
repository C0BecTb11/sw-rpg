// Логика страницы галактической карты — защита от доступа без авторизации.
// Отображение профиля (никнейм/аватар) вынесено в js/profile.js.
// Зависит от window.supabase (см. js/supabase-client.js).

function initGalaxyPage() {
  // Не авторизован — на вход (с повтором: краткий сбой сессии не выкидывает
  // из игры, а после входа игрок вернётся сюда же)
  sbSessionGate();
}

document.addEventListener('DOMContentLoaded', initGalaxyPage);
