// Подключение к Supabase. Ключи тут одни на весь проект —
// меняешь один раз в этом файле, если понадобится (например при смене проекта).

var SUPABASE_URL = 'https://zqqaxhhajhgspaiwlyhy.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxcWF4aGhhamhnc3BhaXdseWh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NDMyNjIsImV4cCI6MjEwMTAxOTI2Mn0.oauDY1aq02uU1dHsoj_H50fi4owBDypn_hMHDalHOSw';

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Игровые страницы без входа. Их открывают не только игроки: «Прочитать
// вслух» Google и роботы загружают страницу без сессии. Все игровые функции
// закрыты для гостя, поэтому каждый такой вызов давал 401 и строку ERROR в
// журнале базы. Пока сессии нет, отвечаем сами, без запроса к серверу, а
// galaxy.js / ground-battle.js / space-battle.js уводят на вход.
(function() {
  if (location.pathname.indexOf('/game/') < 0) return;
  var tokenKey = 'sb-' + SUPABASE_URL.split('//')[1].split('.')[0] + '-auth-token';
  var realRpc = supabase.rpc.bind(supabase);
  supabase.rpc = function() {
    var signedIn = true;
    try { signedIn = !!window.localStorage.getItem(tokenKey); } catch (e) {}
    if (!signedIn) {
      return Promise.resolve({ data: null, error: { message: 'Нет входа в игру', code: 'no_session' }, count: null, status: 401, statusText: 'no session' });
    }
    return realRpc.apply(null, arguments);
  };
})();
