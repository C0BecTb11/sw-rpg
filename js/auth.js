// Логика страницы входа/регистрации.
// Зависит от window.supabase (см. js/supabase-client.js) — подключай его раньше этого файла.

var mode = 'login'; // 'login' или 'signup'

var tabLogin, tabSignup, submitBtn, messageEl, emailInput, passwordInput;
var authBox, sessionBox, userEmailEl, logoutBtn;

function setMode(newMode) {
  mode = newMode;
  if (mode === 'login') {
    tabLogin.className = 'tab active';
    tabSignup.className = 'tab';
    submitBtn.textContent = 'Войти';
  } else {
    tabLogin.className = 'tab';
    tabSignup.className = 'tab active';
    submitBtn.textContent = 'Создать аккаунт';
  }
  messageEl.textContent = '';
  messageEl.className = '';
}

function showMessage(text, isError) {
  messageEl.textContent = text;
  messageEl.className = isError ? 'error' : 'success';
}

function showSession(user) {
  authBox.style.display = 'none';
  sessionBox.style.display = 'block';
  userEmailEl.textContent = user.email;
}

function showAuthForm() {
  authBox.style.display = 'block';
  sessionBox.style.display = 'none';
}

function handleSubmit() {
  var email = emailInput.value.trim();
  var password = passwordInput.value;

  if (!email || !password) {
    showMessage('Заполни email и пароль', true);
    return;
  }
  if (password.length < 6) {
    showMessage('Пароль минимум 6 символов', true);
    return;
  }

  submitBtn.disabled = true;
  showMessage('Подождите...', false);

  if (mode === 'signup') {
    supabase.auth.signUp({ email: email, password: password }).then(function(res) {
      submitBtn.disabled = false;
      if (res.error) {
        showMessage(res.error.message, true);
        return;
      }
      // Supabase не всегда возвращает явную ошибку на повторную регистрацию —
      // если identities пустой массив, значит аккаунт с этим email уже существует
      var identities = res.data.user && res.data.user.identities;
      if (identities && identities.length === 0) {
        showMessage('Этот email уже зарегистрирован. Попробуй войти.', true);
        return;
      }
      showMessage('Аккаунт создан! Входим...', false);
      if (res.data.session) {
        window.location.href = 'game/galaxy-map.html';
      }
    });
  } else {
    supabase.auth.signInWithPassword({ email: email, password: password }).then(function(res) {
      submitBtn.disabled = false;
      if (res.error) {
        showMessage(res.error.message, true);
        return;
      }
      window.location.href = 'game/galaxy-map.html';
    });
  }
}

function handleLogout() {
  supabase.auth.signOut().then(function() {
    showAuthForm();
    emailInput.value = '';
    passwordInput.value = '';
  });
}

function initAuthPage() {
  tabLogin = document.getElementById('tab-login');
  tabSignup = document.getElementById('tab-signup');
  submitBtn = document.getElementById('submit-btn');
  messageEl = document.getElementById('message');
  emailInput = document.getElementById('email');
  passwordInput = document.getElementById('password');
  authBox = document.getElementById('auth-box');
  sessionBox = document.getElementById('session-box');
  userEmailEl = document.getElementById('user-email');
  logoutBtn = document.getElementById('logout-btn');

  tabLogin.addEventListener('click', function() { setMode('login'); });
  tabSignup.addEventListener('click', function() { setMode('signup'); });
  submitBtn.addEventListener('click', handleSubmit);
  logoutBtn.addEventListener('click', handleLogout);

  // проверка активной сессии при загрузке
  supabase.auth.getSession().then(function(res) {
    if (res.data.session) {
      showSession(res.data.session.user);
    }
  });
}

document.addEventListener('DOMContentLoaded', initAuthPage);
