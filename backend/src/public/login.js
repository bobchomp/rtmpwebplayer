(function () {
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');

  function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          throw new Error(body.error || ('Request failed: ' + res.status));
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loginError.classList.add('hidden');
    var username = document.getElementById('login-username').value;
    var password = document.getElementById('login-password').value;
    api('/api/login', { method: 'POST', body: JSON.stringify({ username: username, password: password }) })
      .then(function () { window.location.href = '/dashboard'; })
      .catch(function (err) {
        loginError.textContent = err.message;
        loginError.classList.remove('hidden');
      });
  });

  // If already logged in (e.g. a bookmarked /login visited with a live
  // session), skip straight to the dashboard instead of showing the form.
  api('/api/me').then(function (data) {
    if (data.authenticated) {
      window.location.href = '/dashboard';
    } else {
      loginForm.classList.remove('hidden');
      loginForm.classList.add('reveal');
    }
  });
})();
