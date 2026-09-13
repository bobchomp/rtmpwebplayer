(function () {
  var loginBox = document.getElementById('login-box');
  var loginError = document.getElementById('login-error');
  var loginBtn = document.getElementById('login-btn');

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

    // Auth0 keeps its own login session on its own domain, separate from
    // this app's - so a plain "log in again" link would just silently reuse
    // whatever account just got rejected and fail the same way every time.
    // Routing the retry through /auth/logout clears Auth0's session too
    // (this app has no session to clear here anyway), landing back on this
    // same page - which then auto-redirects into a genuinely fresh Auth0
    // login, actually prompting for an account this time.
    loginBtn.textContent = 'Log out and try again';
    loginBtn.href = '/auth/logout';

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
