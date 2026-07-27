(function () {
  var loginView = document.getElementById('login-view');
  var dashboardView = document.getElementById('dashboard-view');
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');
  var logoutBtn = document.getElementById('logout-btn');

  var listView = document.getElementById('channel-list-view');
  var detailView = document.getElementById('channel-detail-view');

  var createForm = document.getElementById('create-form');
  var channelsList = document.getElementById('channels-list');
  var emptyState = document.getElementById('empty-state');
  var channelRowTemplate = document.getElementById('channel-row-template');
  var customOutputTemplate = document.getElementById('custom-output-template');

  var config = { publicHost: window.location.hostname, rtmpHost: window.location.hostname, rtmpPort: 1935 };
  var listRefreshTimer = null;
  var detailPollTimer = null;
  var currentChannelId = null;
  var youtubeConnected = false;
  var detailListenersWired = false;

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

  function wireCopyButtons(root) {
    root.querySelectorAll('.copy-btn').forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', function () {
        var targetId = btn.getAttribute('data-target');
        var input = document.getElementById(targetId);
        if (!input) return;
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
  }

  // ===================== Routing =====================

  function parseRoute() {
    var hash = window.location.hash || '#/';
    var match = hash.match(/^#\/channel\/([^/]+)/);
    if (match) return { view: 'detail', channelId: decodeURIComponent(match[1]) };
    return { view: 'list' };
  }

  function route() {
    if (listRefreshTimer) { clearInterval(listRefreshTimer); listRefreshTimer = null; }
    if (detailPollTimer) { clearInterval(detailPollTimer); detailPollTimer = null; }

    var r = parseRoute();
    if (r.view === 'detail') {
      listView.classList.add('hidden');
      detailView.classList.remove('hidden');
      loadChannelDetail(r.channelId);
      detailPollTimer = setInterval(pollLiveStatus, 5000);
    } else {
      detailView.classList.add('hidden');
      listView.classList.remove('hidden');
      loadChannelList();
      listRefreshTimer = setInterval(loadChannelList, 10000);
    }
  }

  window.addEventListener('hashchange', route);

  // ===================== Channel list view =====================

  function loadChannelList() {
    return api('/api/channels').then(function (channels) {
      channelsList.innerHTML = '';
      emptyState.classList.toggle('hidden', channels.length > 0);
      channels.forEach(function (channel) {
        var node = channelRowTemplate.content.firstElementChild.cloneNode(true);
        node.href = '#/channel/' + encodeURIComponent(channel.id);
        node.querySelector('.channel-row-name').textContent = channel.name;
        node.querySelector('.live-badge').classList.toggle('hidden', !channel.isLive);
        channelsList.appendChild(node);
      });
    });
  }

  createForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('new-channel-name');
    var name = input.value.trim();
    if (!name) return;
    api('/api/channels', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function (channel) {
        input.value = '';
        window.location.hash = '#/channel/' + encodeURIComponent(channel.id);
      })
      .catch(function (err) { alert(err.message); });
  });

  function loadYoutubeGlobalPanel() {
    return api('/api/youtube/status').then(function (data) {
      document.getElementById('youtube-not-connected').classList.toggle('hidden', data.connected);
      document.getElementById('youtube-connected').classList.toggle('hidden', !data.connected);
      document.getElementById('youtube-connect-btn').classList.toggle('hidden', data.connected);
      document.getElementById('youtube-disconnect-btn').classList.toggle('hidden', !data.connected);
      if (data.connected) {
        document.getElementById('youtube-channel-name').textContent = data.channelTitle;
      }
    });
  }

  document.getElementById('youtube-connect-btn').addEventListener('click', function () {
    window.location.href = '/api/youtube/connect';
  });

  document.getElementById('youtube-disconnect-btn').addEventListener('click', function () {
    if (!confirm('Disconnect YouTube? Channels with "Send to YouTube" enabled will stop relaying until you reconnect.')) return;
    api('/api/youtube/disconnect', { method: 'POST' }).then(loadYoutubeGlobalPanel);
  });

  // ===================== Channel detail view =====================

  var detailName = document.getElementById('detail-name');
  var detailNameInput = document.getElementById('detail-name-input');
  var detailRenameBtn = document.getElementById('detail-rename-btn');
  var detailSaveNameBtn = document.getElementById('detail-save-name-btn');
  var detailCancelNameBtn = document.getElementById('detail-cancel-name-btn');
  var detailDeleteBtn = document.getElementById('detail-delete-btn');

  var detailOfflineBadge = document.getElementById('detail-offline-badge');
  var detailOfflineInfo = document.getElementById('detail-offline-info');
  var detailPreviewIframe = document.getElementById('detail-preview-iframe');
  var detailRtmpUrl = document.getElementById('detail-rtmp-url');
  var detailStreamKey = document.getElementById('detail-stream-key');
  var detailRevealBtn = document.getElementById('detail-reveal-btn');
  var detailRegenBtn = document.getElementById('detail-regen-btn');
  var detailEmbedCode = document.getElementById('detail-embed-code');

  var detailWebsiteHint = document.getElementById('detail-website-hint');
  var detailWebsiteToggle = document.getElementById('detail-website-toggle');
  var detailWebsiteTitle = document.getElementById('detail-website-title');
  var detailWebsiteDescription = document.getElementById('detail-website-description');
  var detailWebsiteMetaSaveBtn = document.getElementById('detail-website-meta-save-btn');

  var detailYoutubeHint = document.getElementById('detail-youtube-hint');
  var detailYoutubeToggle = document.getElementById('detail-youtube-toggle');
  var detailYoutubeTitle = document.getElementById('detail-youtube-title');
  var detailYoutubeSaveBtn = document.getElementById('detail-youtube-save-btn');

  var detailCustomOutputsList = document.getElementById('detail-custom-outputs-list');
  var detailAddOutputBtn = document.getElementById('detail-add-output-btn');
  var detailAddOutputForm = document.getElementById('detail-add-output-form');
  var cancelAddOutputBtn = document.getElementById('cancel-add-output-btn');
  var newOutputName = document.getElementById('new-output-name');
  var newOutputRtmpUrl = document.getElementById('new-output-rtmp-url');
  var newOutputStreamKey = document.getElementById('new-output-stream-key');

  var detailCoverGallery = document.getElementById('detail-cover-gallery');
  var detailCoverUploadInput = document.getElementById('detail-cover-upload-input');
  var detailThumbGallery = document.getElementById('detail-thumb-gallery');
  var detailThumbUploadInput = document.getElementById('detail-thumb-upload-input');

  function loadChannelDetail(channelId) {
    currentChannelId = channelId;
    wireDetailEventListeners();
    return refreshChannelDetail();
  }

  function refreshChannelDetail() {
    return Promise.all([
      api('/api/channels/' + currentChannelId),
      api('/api/youtube/status'),
    ])
      .then(function (results) {
        youtubeConnected = results[1].connected;
        renderChannelDetail(results[0]);
      })
      .catch(function (err) {
        alert(err.message);
        window.location.hash = '#/';
      });
  }

  function updatePreviewState(isLive, channelId) {
    // No separate "live" badge here - the preview iframe (embed.html) shows
    // its own live/behind-live status internally, so a duplicate at the
    // dashboard level would just visually collide with it.
    detailOfflineBadge.classList.toggle('hidden', isLive);
    detailOfflineInfo.classList.toggle('hidden', isLive);
    detailPreviewIframe.classList.toggle('hidden', !isLive);

    if (isLive) {
      var expectedSrc = embedOrigin() + '/embed/' + channelId;
      if (detailPreviewIframe.getAttribute('src') !== expectedSrc) {
        detailPreviewIframe.src = expectedSrc;
      }
    } else if (detailPreviewIframe.getAttribute('src')) {
      detailPreviewIframe.removeAttribute('src');
    }
  }

  // Polled on an interval - only touches live/offline state, never the rest
  // of the form, so it can't clobber in-progress typing (e.g. a YouTube
  // title or a half-filled "add output" form) while the user is editing.
  function pollLiveStatus() {
    if (!currentChannelId) return;
    fetch('/api/channels/' + currentChannelId + '/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        updatePreviewState(data.isLive, currentChannelId);
      })
      .catch(function () {});
  }

  function renderGallery(galleryEl, channel, listField, activeField, routeSegment) {
    var list = channel[listField] || [];
    galleryEl.innerHTML = '';
    if (list.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'gallery-empty hint';
      empty.textContent = 'No images uploaded yet';
      galleryEl.appendChild(empty);
      return;
    }

    list.forEach(function (filename) {
      var item = document.createElement('div');
      item.className = 'gallery-item' + (filename === channel[activeField] ? ' active' : '');

      var img = document.createElement('img');
      img.src = '/uploads/' + filename;
      img.alt = '';
      img.title = 'Click to use this image';
      img.addEventListener('click', function () {
        api('/api/channels/' + channel.id + '/' + routeSegment + '/' + encodeURIComponent(filename) + '/activate', { method: 'POST' })
          .then(refreshChannelDetail)
          .catch(function (err) { alert(err.message); });
      });
      item.appendChild(img);

      if (filename === channel[activeField]) {
        var badge = document.createElement('span');
        badge.className = 'gallery-active-badge';
        badge.textContent = 'ACTIVE';
        item.appendChild(badge);
      }

      var removeBtn = document.createElement('button');
      removeBtn.className = 'gallery-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Delete this image';
      removeBtn.addEventListener('click', function () {
        api('/api/channels/' + channel.id + '/' + routeSegment + '/' + encodeURIComponent(filename), { method: 'DELETE' })
          .then(refreshChannelDetail)
          .catch(function (err) { alert(err.message); });
      });
      item.appendChild(removeBtn);

      galleryEl.appendChild(item);
    });
  }

  function uploadGalleryImage(routeSegment, file, inputEl) {
    if (!file) return;
    var formData = new FormData();
    formData.append('image', file);
    fetch('/api/channels/' + currentChannelId + '/' + routeSegment, { method: 'POST', body: formData })
      .then(function (res) {
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
      })
      .then(function () {
        inputEl.value = '';
        return refreshChannelDetail();
      })
      .catch(function (err) { alert(err.message); });
  }

  function renderChannelDetail(channel) {
    var isEditingName = detailNameInput.classList.contains('hidden') === false;
    if (!isEditingName) detailName.textContent = channel.name;

    var rtmpUrl = 'rtmp://' + config.rtmpHost + ':' + config.rtmpPort + '/live';
    detailRtmpUrl.value = rtmpUrl;
    detailStreamKey.value = channel.streamKey;

    detailEmbedCode.value =
      '<iframe src="' + embedOrigin() + '/embed/' + channel.id + '" ' +
      'style="width:100%;aspect-ratio:16/9;border:0;" ' +
      'allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>';

    updatePreviewState(channel.isLive, channel.id);

    detailWebsiteToggle.checked = channel.websiteEnabled !== false;
    detailWebsiteHint.textContent = channel.websiteEnabled !== false
      ? 'This is the embed player itself'
      : 'Off - the embed and your website are not showing this stream';
    detailWebsiteTitle.value = channel.websiteTitle || '';
    detailWebsiteDescription.value = channel.websiteDescription || '';

    detailYoutubeToggle.checked = !!channel.youtubeEnabled;
    detailYoutubeTitle.value = channel.youtubeTitle || '';
    if (!youtubeConnected) {
      detailYoutubeHint.textContent = 'Connect a YouTube account first (see the channel list page)';
    } else if (channel.youtubeEnabled) {
      detailYoutubeHint.textContent = 'Relaying automatically while live';
    } else {
      detailYoutubeHint.textContent = 'Off';
    }

    detailCustomOutputsList.innerHTML = '';
    (channel.customOutputs || []).forEach(function (output) {
      var node = customOutputTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector('.output-name').textContent = output.name;
      node.querySelector('.output-url').textContent = output.rtmpUrl;

      var toggle = node.querySelector('.output-toggle');
      toggle.checked = !!output.enabled;
      toggle.addEventListener('change', function () {
        api('/api/channels/' + channel.id + '/outputs/' + output.id, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: toggle.checked }),
        })
          .then(refreshChannelDetail)
          .catch(function (err) {
            alert(err.message);
            toggle.checked = !toggle.checked;
          });
      });

      node.querySelector('.output-delete-btn').addEventListener('click', function () {
        if (!confirm('Remove output "' + output.name + '"?')) return;
        api('/api/channels/' + channel.id + '/outputs/' + output.id, { method: 'DELETE' })
          .then(refreshChannelDetail)
          .catch(function (err) { alert(err.message); });
      });

      detailCustomOutputsList.appendChild(node);
    });

    renderGallery(detailCoverGallery, channel, 'coverImages', 'activeCoverImage', 'covers');
    renderGallery(detailThumbGallery, channel, 'liveThumbnails', 'activeLiveThumbnail', 'live-thumbnails');
  }

  function wireDetailEventListeners() {
    if (detailListenersWired) return;
    detailListenersWired = true;

    wireCopyButtons(detailView);

    detailRenameBtn.addEventListener('click', function () {
      detailNameInput.value = detailName.textContent;
      detailName.classList.add('hidden');
      detailRenameBtn.classList.add('hidden');
      detailDeleteBtn.classList.add('hidden');
      detailNameInput.classList.remove('hidden');
      detailSaveNameBtn.classList.remove('hidden');
      detailCancelNameBtn.classList.remove('hidden');
      detailNameInput.focus();
      detailNameInput.select();
    });

    function exitNameEdit() {
      detailName.classList.remove('hidden');
      detailRenameBtn.classList.remove('hidden');
      detailDeleteBtn.classList.remove('hidden');
      detailNameInput.classList.add('hidden');
      detailSaveNameBtn.classList.add('hidden');
      detailCancelNameBtn.classList.add('hidden');
    }
    detailCancelNameBtn.addEventListener('click', exitNameEdit);

    function saveName() {
      var newName = detailNameInput.value.trim();
      if (!newName) return;
      api('/api/channels/' + currentChannelId, { method: 'PATCH', body: JSON.stringify({ name: newName }) })
        .then(function () {
          exitNameEdit();
          return refreshChannelDetail();
        })
        .catch(function (err) { alert(err.message); });
    }
    detailSaveNameBtn.addEventListener('click', saveName);
    detailNameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveName();
      if (e.key === 'Escape') exitNameEdit();
    });

    detailDeleteBtn.addEventListener('click', function () {
      if (!confirm('Delete channel "' + detailName.textContent + '"? This cannot be undone.')) return;
      api('/api/channels/' + currentChannelId, { method: 'DELETE' })
        .then(function () { window.location.hash = '#/'; })
        .catch(function (err) { alert(err.message); });
    });

    detailRevealBtn.addEventListener('click', function () {
      var revealed = detailStreamKey.type === 'text';
      detailStreamKey.type = revealed ? 'password' : 'text';
      detailRevealBtn.textContent = revealed ? 'Show' : 'Hide';
    });

    detailRegenBtn.addEventListener('click', function () {
      if (!confirm('Regenerate the stream key? Any encoder currently publishing with the old key will be disconnected.')) return;
      api('/api/channels/' + currentChannelId + '/regenerate-key', { method: 'POST' })
        .then(refreshChannelDetail)
        .catch(function (err) { alert(err.message); });
    });

    detailWebsiteToggle.addEventListener('change', function () {
      api('/api/channels/' + currentChannelId + '/website-settings', {
        method: 'PATCH',
        body: JSON.stringify({ websiteEnabled: detailWebsiteToggle.checked }),
      })
        .then(refreshChannelDetail)
        .catch(function (err) {
          alert(err.message);
          detailWebsiteToggle.checked = !detailWebsiteToggle.checked;
        });
    });

    detailWebsiteMetaSaveBtn.addEventListener('click', function () {
      api('/api/channels/' + currentChannelId + '/website-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          websiteTitle: detailWebsiteTitle.value,
          websiteDescription: detailWebsiteDescription.value,
        }),
      })
        .then(refreshChannelDetail)
        .catch(function (err) { alert(err.message); });
    });

    detailYoutubeToggle.addEventListener('change', function () {
      api('/api/channels/' + currentChannelId + '/youtube-settings', {
        method: 'PATCH',
        body: JSON.stringify({ youtubeEnabled: detailYoutubeToggle.checked }),
      })
        .then(refreshChannelDetail)
        .catch(function (err) {
          alert(err.message);
          detailYoutubeToggle.checked = !detailYoutubeToggle.checked;
        });
    });

    detailYoutubeSaveBtn.addEventListener('click', function () {
      api('/api/channels/' + currentChannelId + '/youtube-settings', {
        method: 'PATCH',
        body: JSON.stringify({ youtubeTitle: detailYoutubeTitle.value }),
      })
        .then(refreshChannelDetail)
        .catch(function (err) { alert(err.message); });
    });

    detailAddOutputBtn.addEventListener('click', function () {
      detailAddOutputForm.classList.remove('hidden');
      detailAddOutputBtn.classList.add('hidden');
    });
    cancelAddOutputBtn.addEventListener('click', function () {
      detailAddOutputForm.reset();
      detailAddOutputForm.classList.add('hidden');
      detailAddOutputBtn.classList.remove('hidden');
    });
    detailAddOutputForm.addEventListener('submit', function (e) {
      e.preventDefault();
      api('/api/channels/' + currentChannelId + '/outputs', {
        method: 'POST',
        body: JSON.stringify({
          name: newOutputName.value,
          rtmpUrl: newOutputRtmpUrl.value,
          streamKey: newOutputStreamKey.value,
        }),
      })
        .then(function () {
          detailAddOutputForm.reset();
          detailAddOutputForm.classList.add('hidden');
          detailAddOutputBtn.classList.remove('hidden');
          return refreshChannelDetail();
        })
        .catch(function (err) { alert(err.message); });
    });

    detailCoverUploadInput.addEventListener('change', function (e) {
      uploadGalleryImage('covers', e.target.files[0], detailCoverUploadInput);
    });
    detailThumbUploadInput.addEventListener('change', function (e) {
      uploadGalleryImage('live-thumbnails', e.target.files[0], detailThumbUploadInput);
    });
  }

  // ===================== Auth =====================

  function enterDashboard() {
    show('dashboard');
    loadYoutubeGlobalPanel();
    api('/api/config').then(function (cfg) {
      config = cfg;
      route();
    });
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
      if (listRefreshTimer) clearInterval(listRefreshTimer);
      if (detailPollTimer) clearInterval(detailPollTimer);
      show('login');
    });
  });

  api('/api/me').then(function (data) {
    if (data.authenticated) {
      enterDashboard();
    } else {
      show('login');
    }
  });
})();
