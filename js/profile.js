// Загружает профиль текущего игрока (никнейм, код доступа, фракция).
// Если профиля нет вообще — просит создать ник (старые аккаунты).
// Если профиль есть, но фракция ещё не назначена администратором —
// показывает экран ожидания с личным кодом доступа и подписывается
// на Realtime, чтобы разблокироваться само, как только фракция появится.

var currentUserId = null;

function showNicknamePrompt() {
  var prompt = document.getElementById('nickname-prompt');
  var input = document.getElementById('nickname-prompt-input');
  var saveBtn = document.getElementById('nickname-prompt-save');
  var messageEl = document.getElementById('nickname-prompt-message');

  prompt.style.display = 'flex';

  saveBtn.addEventListener('click', function() {
    var nickname = input.value.trim();
    if (!nickname) {
      messageEl.textContent = 'Введи ник';
      return;
    }

    saveBtn.disabled = true;
    messageEl.textContent = '';

    // .select() здесь не используем: часть столбцов профиля закрыта от
    // прямого чтения, поэтому после вставки перечитываем свой профиль
    // через защищённую функцию.
    supabase.from('profiles').insert({ id: currentUserId, nickname: nickname }).then(function(res) {
      saveBtn.disabled = false;
      if (res.error) {
        messageEl.textContent = res.error.message;
        return;
      }
      prompt.style.display = 'none';
      document.getElementById('profile-nickname').textContent = nickname;

      supabase.rpc('get_my_profile').then(function(rpcRes) {
        if (rpcRes.error || !rpcRes.data || rpcRes.data.length === 0) return;
        handleFactionState(rpcRes.data[0]);
      });
    });
  });
}

function showWaitingScreen(accessCode) {
  var waiting = document.getElementById('faction-waiting');
  var codeEl = document.getElementById('access-code-value');
  var mapScroll = document.getElementById('map-scroll');

  codeEl.textContent = accessCode;
  waiting.style.display = 'flex';
  if (mapScroll) mapScroll.style.display = 'none';
}

function hideWaitingScreen() {
  var waiting = document.getElementById('faction-waiting');
  var mapScroll = document.getElementById('map-scroll');

  waiting.style.display = 'none';
  if (mapScroll) mapScroll.style.display = 'block';
}

// Реагирует на текущее состояние профиля: если фракции нет — показывает
// экран ожидания и слушает изменения; если есть — открывает карту как обычно.
function handleFactionState(profile) {
  if (!profile.faction) {
    showWaitingScreen(profile.access_code);
    subscribeToOwnProfile();
  } else {
    hideWaitingScreen();
  }
}

function subscribeToOwnProfile() {
  supabase
    .channel('own-profile-changes')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'profiles',
      filter: 'id=eq.' + currentUserId
    }, function(payload) {
      var updated = payload.new;
      if (updated.faction) {
        hideWaitingScreen();
      }
    })
    .subscribe();
}

function initProfileBadge() {
  var nicknameEl = document.getElementById('profile-nickname');
  if (!nicknameEl) return;

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return; // galaxy.js уже сделает редирект на auth.html

    currentUserId = res.data.session.user.id;

    // Ник — публичный столбец, читаем его отдельным простым запросом.
    // Так значок в углу не зависит от остальных данных профиля: даже если
    // что-то пойдёт не так с фракцией или кодом доступа, имя всё равно будет.
    supabase.from('profiles').select('nickname').eq('id', currentUserId).maybeSingle()
      .then(function(nickRes) {
        if (nickRes.error) {
          console.error('Не удалось прочитать ник:', nickRes.error);
          nicknameEl.textContent = 'Игрок';
          return;
        }
        if (!nickRes.data) {
          nicknameEl.textContent = 'Игрок';
          showNicknamePrompt();
          return;
        }
        nicknameEl.textContent = nickRes.data.nickname;
      });

    // Фракция и код доступа закрыты от чужого чтения, поэтому идут
    // через защищённую функцию — она отдаёт только твои данные.
    supabase.rpc('get_my_profile').then(function(rpcRes) {
      if (rpcRes.error) {
        console.error('Не удалось прочитать профиль:', rpcRes.error);
        return;
      }
      var profile = (rpcRes.data && rpcRes.data.length > 0) ? rpcRes.data[0] : null;
      if (profile) handleFactionState(profile);
    });
  });
}

document.addEventListener('DOMContentLoaded', initProfileBadge);
