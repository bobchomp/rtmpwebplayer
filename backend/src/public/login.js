(function () {
  var loginBox = document.getElementById('login-box');
  var loginError = document.getElementById('login-error');

  function showBox() {
    loginBox.classList.remove('hidden');
    loginBox.classList.add('reveal');
  }

  // The Auth0 callback redirects failures back here as ?error=... (expired
  // login attempt, an account that isn't the allowed one, etc.). Show it and
  // stop - auto-redirecting straight back into Auth0 here would fire before
  // anyone could ever read why it failed.
  var params = new URLSearchParams(window.location.search);
  var error = params.get('error');
  if (error) {
    loginError.textContent = error;
    loginError.classList.remove('hidden');
    // Drop it from the URL so refreshing/bookmarking doesn't keep re-showing
    // a stale error.
    window.history.replaceState({}, '', window.location.pathname);
    showBox();
    return;
  }

  // Otherwise skip the button entirely - straight to the dashboard if
  // there's already a live session, straight to Auth0 if not. The button
  // stays in the markup purely as the error-case fallback above.
  fetch('/api/me').then(function (res) { return res.json(); }).then(function (data) {
    if (data.authenticated) {
      window.location.href = '/dashboard';
    } else {
      window.location.href = '/auth/login';
    }
  });
})();
