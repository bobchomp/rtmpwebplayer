(function () {
  var loginBox = document.getElementById('login-box');
  var loginError = document.getElementById('login-error');

  // The Auth0 callback redirects failures back here as ?error=... (expired
  // login attempt, an account that isn't the allowed one, etc.) rather than
  // showing them on some intermediate page.
  var params = new URLSearchParams(window.location.search);
  var error = params.get('error');
  if (error) {
    loginError.textContent = error;
    loginError.classList.remove('hidden');
    // Drop it from the URL so refreshing/bookmarking doesn't keep re-showing
    // a stale error.
    window.history.replaceState({}, '', window.location.pathname);
  }

  // If already logged in (e.g. a bookmarked /login visited with a live
  // session), skip straight to the dashboard instead of showing the button.
  fetch('/api/me').then(function (res) { return res.json(); }).then(function (data) {
    if (data.authenticated) {
      window.location.href = '/dashboard';
    } else {
      loginBox.classList.remove('hidden');
      loginBox.classList.add('reveal');
    }
  });
})();
