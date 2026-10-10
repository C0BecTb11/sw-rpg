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
var SB_TOKEN_KEY = 'sb-' + SUPABASE_URL.split('//')[1].split('.')[0] + '-auth-token';

function sbHasStoredToken() {
  try { return !!window.localStorage.getItem(SB_TOKEN_KEY); } catch (e) { return true; }
}

// Уход на страницу входа с адресом возврата: после входа игрок попадает
// туда же, где был, а не на пустую страницу с одной кнопкой «Выйти»
function sbGoToAuth() {
  var tail = location.pathname.split('/game/')[1] || '';
  var next = tail ? 'game/' + tail + location.search + location.hash : '';
  location.href = '../auth.html' + (next ? '?next=' + encodeURIComponent(next) : '');
}

// Проверка входа на игровых страницах. getSession может на миг вернуть
// пустую сессию: токен обновляется, сеть моргнула, несколько вкладок игры
// делят одну блокировку. Раньше это сразу выкидывало на вход, а там игрок
// видел «Ты вошёл как …» и не мог вернуться. Теперь, если токен в браузере
// есть, спрашиваем ещё два раза и только потом уводим. Промис исполняется
// только при живой сессии и отдаёт тот же {data: {session}}, что getSession.
function sbSessionGate() {
  return new Promise(function(resolve) {
    var tries = 0;
    function attempt() {
      supabase.auth.getSession().then(function(res) {
        var s = res && res.data && res.data.session;
        if (s) { resolve({ data: { session: s }, error: null }); return; }
        retry();
      }, retry);
    }
    function retry() {
      if (tries < 2 && sbHasStoredToken()) {
        tries++;
        setTimeout(attempt, 800 * tries);
        return;
      }
      sbGoToAuth();
    }
    attempt();
  });
}

(function() {
  if (location.pathname.indexOf('/game/') < 0) return;
  var tokenKey = SB_TOKEN_KEY;
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
