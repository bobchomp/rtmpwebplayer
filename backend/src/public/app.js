(function () {
  var loginView = document.getElementById('login-view');
  var dashboardView = document.getElementById('dashboard-view');
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');
  var logoutBtn = document.getElementById('logout-btn');
  var createForm = document.getElementById('create-form');
  var channelsList = document.getElementById('channels-list');
  var emptyState = document.getElementById('empty-state');
  var cardTemplate = document.getElementById('channel-card-template');

  var config = { publicHost: window.location.hostname, rtmpHost: window.location.hostname, rtmpPort: 1935 };
  var refreshTimer = null;

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

  function show(view) {
    loginView.classList.toggle('hidden', view !== 'login');
    dashboardView.classList.toggle('hidden', view !== 'dashboard');
  }

  function embedOrigin() {
    return window.location.origin;
  }

  function renderChannel(channel) {
    var node = cardTemplate.content.firstElementChild.cloneNode(true);

    var nameSpan = node.querySelector('.channel-name');
    var nameInput = node.querySelector('.channel-name-input');
    var renameBtn = node.querySelector('.rename-btn');
    var saveNameBtn = node.querySelector('.save-name-btn');
    var cancelNameBtn = node.querySelector('.cancel-name-btn');
    var deleteBtn = node.querySelector('.delete-btn');

    nameSpan.textContent = channel.name;
    node.querySelector('.live-badge').classList.toggle('hidden', !channel.isLive);

    function enterEditMode() {
      nameInput.value = channel.name;
      nameSpan.classList.add('hidden');
      renameBtn.classList.add('hidden');
      deleteBtn.classList.add('hidden');
      nameInput.classList.remove('hidden');
      saveNameBtn.classList.remove('hidden');
      cancelNameBtn.classList.remove('hidden');
      nameInput.focus();
      nameInput.select();
    }

    function exitEditMode() {
      nameSpan.classList.remove('hidden');
      renameBtn.classList.remove('hidden');
      deleteBtn.classList.remove('hidden');
      nameInput.classList.add('hidden');
      saveNameBtn.classList.add('hidden');
      cancelNameBtn.classList.add('hidden');
    }

    function saveName() {
      var newName = nameInput.value.trim();
      if (!newName) return;
      api('/api/channels/' + channel.id, { method: 'PATCH', body: JSON.stringify({ name: newName }) })
        .then(loadChannels)
        .catch(function (err) { alert(err.message); });
    }

    renameBtn.addEventListener('click', enterEditMode);
    cancelNameBtn.addEventListener('click', exitEditMode);
    saveNameBtn.addEventListener('click', saveName);
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveName();
      if (e.key === 'Escape') exitEditMode();
    });

    var rtmpUrl = 'rtmp://' + config.rtmpHost + ':' + config.rtmpPort + '/live';
    node.querySelector('.rtmp-url').value = rtmpUrl;

    var keyInput = node.querySelector('.stream-key');
    keyInput.value = channel.streamKey;

    var revealBtn = node.querySelector('.reveal-btn');
    revealBtn.addEventListener('click', function () {
      var revealed = keyInput.type === 'text';
      keyInput.type = revealed ? 'password' : 'text';
      revealBtn.textContent = revealed ? 'Show' : 'Hide';
    });

    var embedCode =
      '<iframe src="' + embedOrigin() + '/embed/' + channel.id + '" ' +
      'style="width:100%;aspect-ratio:16/9;border:0;" ' +
      'allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>';
    node.querySelector('.embed-code').value = embedCode;

    node.querySelectorAll('.copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var targetClass = btn.getAttribute('data-target');
        var input = node.querySelector('.' + targetClass);
        navigator.clipboard.writeText(input.value).then(function () {
          var original = btn.textContent;
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = original;
            btn.classList.remove('copied');
          }, 1500);
        });
      });
    });

    node.querySelector('.regen-btn').addEventListener('click', function () {
      if (!confirm('Regenerate the stream key? Any encoder currently publishing with the old key will be disconnected.')) return;
      api('/api/channels/' + channel.id + '/regenerate-key', { method: 'POST' }).then(loadChannels);
    });

    node.querySelector('.delete-btn').addEventListener('click', function () {
      if (!confirm('Delete channel "' + channel.name + '"? This cannot be undone.')) return;
      api('/api/channels/' + channel.id, { method: 'DELETE' }).then(loadChannels);
    });

    function wireImageField(prefix, routeSegment, dbField) {
      var preview = node.querySelector('.' + prefix + '-preview');
      var none = node.querySelector('.' + prefix + '-none');
      var removeBtn = node.querySelector('.remove-' + prefix + '-btn');

      if (channel[dbField]) {
        preview.src = '/uploads/' + channel[dbField] + '?t=' + Date.now();
        preview.classList.remove('hidden');
        none.classList.add('hidden');
        removeBtn.classList.remove('hidden');
      }

      node.querySelector('.' + prefix + '-input').addEventListener('change', function (e) {
        var file = e.target.files[0];
        if (!file) return;
        var formData = new FormData();
        formData.append('image', file);
        fetch('/api/channels/' + channel.id + '/' + routeSegment, { method: 'POST', body: formData })
          .then(function (res) {
            if (!res.ok) throw new Error('Upload failed');
            return res.json();
          })
          .then(loadChannels)
          .catch(function (err) { alert(err.message); });
      });

      removeBtn.addEventListener('click', function () {
        api('/api/channels/' + channel.id + '/' + routeSegment, { method: 'DELETE' }).then(loadChannels);
      });
    }

    wireImageField('cover', 'cover', 'coverImage');
    wireImageField('thumb', 'live-thumbnail', 'liveThumbnail');

    return node;
  }

  function loadChannels() {
    return api('/api/channels').then(function (channels) {
      channelsList.innerHTML = '';
      emptyState.classList.toggle('hidden', channels.length > 0);
      channels.forEach(function (channel) {
        channelsList.appendChild(renderChannel(channel));
      });
    });
  }

  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadChannels, 10000);
  }

  function enterDashboard() {
    show('dashboard');
    api('/api/config').then(function (cfg) {
      config = cfg;
      return loadChannels();
    });
    startAutoRefresh();
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loginError.classList.add('hidden');
    var username = document.getElementById('login-username').value;
    var password = document.getElementById('login-password').value;
    api('/api/login', { method: 'POST', body: JSON.stringify({ username: username, password: password }) })
      .then(enterDashboard)
      .catch(function (err) {
        loginError.textContent = err.message;
        loginError.classList.remove('hidden');
      });
  });

  logoutBtn.addEventListener('click', function () {
    api('/api/logout', { method: 'POST' }).then(function () {
      if (refreshTimer) clearInterval(refreshTimer);
      show('login');
    });
  });

  createForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('new-channel-name');
    var name = input.value.trim();
    if (!name) return;
    api('/api/channels', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function () {
        input.value = '';
        return loadChannels();
      })
      .catch(function (err) { alert(err.message); });
  });

  api('/api/me').then(function (data) {
    if (data.authenticated) {
      enterDashboard();
    } else {
      show('login');
    }
  });
})();
