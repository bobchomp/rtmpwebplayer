(function () {
  var dashboardView = document.getElementById('dashboard-view');
  var logoutBtn = document.getElementById('logout-btn');

  var listView = document.getElementById('channel-list-view');
  var detailView = document.getElementById('channel-detail-view');
  var statsView = document.getElementById('stats-view');
  var recordingsView = document.getElementById('recordings-view');
  var howItWorksView = document.getElementById('how-it-works-view');

  var createForm = document.getElementById('create-form');
  var createChannelBtn = document.getElementById('create-channel-btn');
  var createChannelModalBackdrop = document.getElementById('create-channel-modal-backdrop');
  var createChannelCancelBtn = document.getElementById('create-channel-cancel-btn');
  var channelsList = document.getElementById('channels-list');
  var emptyState = document.getElementById('empty-state');
  var channelRowTemplate = document.getElementById('channel-row-template');
  var outputRowTemplate = document.getElementById('output-row-template');

  var config = { publicHost: window.location.hostname, rtmpHost: window.location.hostname, rtmpPort: 1935 };
  var listRefreshTimer = null;
  var detailPollTimer = null;
  var currentChannelId = null;
  var currentChannelMetadata = { title: '', description: '' };
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
    if (hash === '#/stats') return { view: 'stats' };
    if (hash === '#/recordings') return { view: 'recordings' };
    if (hash === '#/how-it-works') return { view: 'how-it-works' };
    return { view: 'list' };
  }

  function route() {
    if (listRefreshTimer) { clearInterval(listRefreshTimer); listRefreshTimer = null; }
    if (detailPollTimer) { clearInterval(detailPollTimer); detailPollTimer = null; }

    var r = parseRoute();
    listView.classList.add('hidden');
    detailView.classList.add('hidden');
    statsView.classList.add('hidden');
    recordingsView.classList.add('hidden');
    howItWorksView.classList.add('hidden');

    if (r.view === 'detail') {
      detailView.classList.remove('hidden');
      loadChannelDetail(r.channelId);
      detailPollTimer = setInterval(pollLiveStatus, 5000);
    } else if (r.view === 'stats') {
      document.title = 'Stats - RTMP Web Player';
      statsView.classList.remove('hidden');
      loadStats();
    } else if (r.view === 'recordings') {
      document.title = 'Recordings - RTMP Web Player';
      recordingsView.classList.remove('hidden');
      loadRecordingsPage();
    } else if (r.view === 'how-it-works') {
      document.title = 'How It Works - RTMP Web Player';
      howItWorksView.classList.remove('hidden');
    } else {
      document.title = 'Channels - RTMP Web Player';
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
        var thumbFile = channel.activeLiveThumbnail || channel.activeCoverImage;
        if (thumbFile) {
          node.querySelector('.channel-row-thumb').style.backgroundImage = 'url(/uploads/' + thumbFile + ')';
        }
        channelsList.appendChild(node);
      });
    });
  }

  function closeCreateChannelModal() {
    createChannelModalBackdrop.classList.add('hidden');
    createForm.reset();
  }

  createChannelBtn.addEventListener('click', function () {
    createChannelModalBackdrop.classList.remove('hidden');
    document.getElementById('new-channel-name').focus();
  });
  createChannelCancelBtn.addEventListener('click', closeCreateChannelModal);
  createChannelModalBackdrop.addEventListener('click', function (e) {
    if (e.target === createChannelModalBackdrop) closeCreateChannelModal();
  });

  createForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('new-channel-name');
    var name = input.value.trim();
    if (!name) return;
    api('/api/channels', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function (channel) {
        closeCreateChannelModal();
        window.location.hash = '#/channel/' + encodeURIComponent(channel.id);
      })
      .catch(function (err) { alert(err.message); });
  });

  // ===================== Stats view =====================

  var statsChannelFilter = document.getElementById('stats-channel-filter');
  var statsFromFilter = document.getElementById('stats-from-filter');
  var statsToFilter = document.getElementById('stats-to-filter');
  var statsExportBtn = document.getElementById('stats-export-btn');
  var statsTableBody = document.getElementById('stats-table-body');
  var statsEmpty = document.getElementById('stats-empty');
  var statsRowTemplate = document.getElementById('stats-row-template');
  var statsSelectAllCheckbox = document.getElementById('stats-select-all');
  var statsDeleteSelectedBtn = document.getElementById('stats-delete-selected-btn');
  var statsSelectedCount = document.getElementById('stats-selected-count');
  var statsListenersWired = false;
  // Row ids currently checked - cleared on every reload (filter change,
  // delete, etc.) rather than persisted across them, since the underlying
  // row set can change out from under a stale selection.
  var statsSelectedIds = {};
  var statsCurrentPlayIds = [];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function formatPlayDate(iso) {
    var d = new Date(iso);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function statsQuery() {
    var params = new URLSearchParams();
    if (statsChannelFilter.value) params.set('channelId', statsChannelFilter.value);
    if (statsFromFilter.value) params.set('from', statsFromFilter.value);
    if (statsToFilter.value) params.set('to', statsToFilter.value + 'T23:59:59.999');
    return params.toString();
  }

  function loadStats() {
    var query = statsQuery();
    statsExportBtn.href = '/api/stats/export.csv' + (query ? '?' + query : '');

    return api('/api/stats' + (query ? '?' + query : '')).then(function (data) {
      var selected = statsChannelFilter.value;
      statsChannelFilter.innerHTML = '';
      var allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'All channels';
      statsChannelFilter.appendChild(allOption);
      data.channels.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        statsChannelFilter.appendChild(opt);
      });
      statsChannelFilter.value = selected;

      statsTableBody.innerHTML = '';
      statsEmpty.classList.toggle('hidden', data.plays.length > 0);
      statsSelectedIds = {};
      statsCurrentPlayIds = data.plays.map(function (p) { return p.id; });
      data.plays.forEach(function (p) {
        var row = statsRowTemplate.content.firstElementChild.cloneNode(true);
        var checkbox = row.querySelector('.stats-row-checkbox');
        checkbox.addEventListener('change', function () {
          if (checkbox.checked) {
            statsSelectedIds[p.id] = true;
          } else {
            delete statsSelectedIds[p.id];
          }
          updateStatsSelectionUi();
        });
        row.querySelector('.stats-col-latest').textContent = formatPlayDate(p.latestPlayAt);
        row.querySelector('.stats-col-channel').textContent = p.channelName;
        row.querySelector('.stats-col-title').textContent = p.title;
        row.querySelector('.stats-col-description').textContent = p.description || '';
        row.querySelector('.stats-col-type').textContent = p.type;
        row.querySelector('.stats-col-ip').textContent = p.ip;
        row.querySelector('.stats-col-country').textContent = p.country || '';
        row.querySelector('.stats-col-region').textContent = p.region || '';
        row.querySelector('.stats-col-city').textContent = p.city || '';
        row.querySelector('.stats-col-first').textContent = formatPlayDate(p.firstPlayAt);
        statsTableBody.appendChild(row);
      });
      updateStatsSelectionUi();
    });
  }

  function updateStatsSelectionUi() {
    var selectedCount = Object.keys(statsSelectedIds).length;
    statsDeleteSelectedBtn.classList.toggle('hidden', selectedCount === 0);
    statsSelectedCount.textContent = String(selectedCount);
    statsSelectAllCheckbox.checked = statsCurrentPlayIds.length > 0 && selectedCount === statsCurrentPlayIds.length;
    statsSelectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < statsCurrentPlayIds.length;
  }

  function wireStatsEventListeners() {
    if (statsListenersWired) return;
    statsListenersWired = true;
    statsChannelFilter.addEventListener('change', loadStats);
    statsFromFilter.addEventListener('change', loadStats);
    statsToFilter.addEventListener('change', loadStats);
    statsSelectAllCheckbox.addEventListener('change', function () {
      var checked = statsSelectAllCheckbox.checked;
      statsSelectedIds = {};
      if (checked) {
        statsCurrentPlayIds.forEach(function (id) { statsSelectedIds[id] = true; });
      }
      var rowCheckboxes = statsTableBody.querySelectorAll('.stats-row-checkbox');
      for (var i = 0; i < rowCheckboxes.length; i++) rowCheckboxes[i].checked = checked;
      updateStatsSelectionUi();
    });
    statsDeleteSelectedBtn.addEventListener('click', function () {
      var ids = Object.keys(statsSelectedIds);
      if (!ids.length) return;
      if (!confirm('Delete ' + ids.length + ' selected play record' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
      api('/api/stats', { method: 'DELETE', body: JSON.stringify({ ids: ids }) })
        .then(loadStats)
        .catch(function (err) { alert(err.message); });
    });
  }
  wireStatsEventListeners();

  // ===================== Channel detail view =====================

  var detailName = document.getElementById('detail-name');
  var detailNameInput = document.getElementById('detail-name-input');
  var detailRenameBtn = document.getElementById('detail-rename-btn');
  var detailSaveNameBtn = document.getElementById('detail-save-name-btn');
  var detailCancelNameBtn = document.getElementById('detail-cancel-name-btn');
  var detailDeleteBtn = document.getElementById('detail-delete-btn');

  var detailOfflineBadge = document.getElementById('detail-offline-badge');
  var detailViewerBadge = document.getElementById('detail-viewer-badge');
  var detailOfflineInfo = document.getElementById('detail-offline-info');
  var detailStartupNotice = document.getElementById('detail-startup-notice');
  var detailPreviewIframe = document.getElementById('detail-preview-iframe');
  var detailRtmpUrl = document.getElementById('detail-rtmp-url');
  var detailStreamKey = document.getElementById('detail-stream-key');
  var detailRevealBtn = document.getElementById('detail-reveal-btn');
  var detailRegenBtn = document.getElementById('detail-regen-btn');
  var detailEmbedCode = document.getElementById('detail-embed-code');

  var detailWebsiteHint = document.getElementById('detail-website-hint');
  var detailWebsiteToggle = document.getElementById('detail-website-toggle');

  var editMetadataBtn = document.getElementById('edit-metadata-btn');
  var metadataModalBackdrop = document.getElementById('metadata-modal-backdrop');
  var metadataTitleInput = document.getElementById('metadata-title-input');
  var metadataDescriptionInput = document.getElementById('metadata-description-input');
  var metadataSaveBtn = document.getElementById('metadata-save-btn');
  var metadataCancelBtn = document.getElementById('metadata-cancel-btn');

  var detailOutputsList = document.getElementById('detail-outputs-list');
  var detailOutputsEmpty = document.getElementById('detail-outputs-empty');

  var addOutputBtn = document.getElementById('add-output-btn');
  var addOutputModalBackdrop = document.getElementById('add-output-modal-backdrop');
  var addOutputTypeRow = document.getElementById('add-output-type-row');
  var addOutputTypeYoutubeBtn = document.getElementById('add-output-type-youtube');
  var addOutputTypeRtmpBtn = document.getElementById('add-output-type-rtmp');
  var addOutputTypePublicLinkBtn = document.getElementById('add-output-type-public-link');
  var addOutputRtmpForm = document.getElementById('add-output-rtmp-form');
  var addOutputCancelBtn = document.getElementById('add-output-cancel-btn');
  var newOutputName = document.getElementById('new-output-name');
  var newOutputRtmpUrl = document.getElementById('new-output-rtmp-url');
  var newOutputStreamKey = document.getElementById('new-output-stream-key');

  var editOutputModalBackdrop = document.getElementById('edit-output-modal-backdrop');
  var editOutputForm = document.getElementById('edit-output-form');
  var editOutputCancelBtn = document.getElementById('edit-output-cancel-btn');
  var editOutputName = document.getElementById('edit-output-name');
  var editOutputRtmpUrl = document.getElementById('edit-output-rtmp-url');
  var editOutputStreamKey = document.getElementById('edit-output-stream-key');
  var editingOutputId = null;

  var detailCoverGallery = document.getElementById('detail-cover-gallery');
  var detailCoverUploadInput = document.getElementById('detail-cover-upload-input');
  var detailThumbGallery = document.getElementById('detail-thumb-gallery');
  var detailThumbUploadInput = document.getElementById('detail-thumb-upload-input');

  var detailRecordingToggle = document.getElementById('detail-recording-toggle');
  var recordingRowTemplate = document.getElementById('recording-row-template');

  var recordingContinueBanner = document.getElementById('recording-continue-banner');
  var recordingContinueBtn = document.getElementById('recording-continue-btn');
  var recordingStopBtn = document.getElementById('recording-stop-btn');

  function loadChannelDetail(channelId) {
    currentChannelId = channelId;
    wireDetailEventListeners();
    return refreshChannelDetail();
  }

  function refreshChannelDetail() {
    return api('/api/channels/' + currentChannelId)
      .then(renderChannelDetail)
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
    detailStartupNotice.classList.toggle('hidden', isLive);
    detailPreviewIframe.classList.toggle('hidden', !isLive);

    if (isLive) {
      var expectedSrc = embedOrigin() + '/embed/' + channelId;
      if (detailPreviewIframe.getAttribute('src') !== expectedSrc) {
        detailPreviewIframe.src = expectedSrc;
      }
    } else if (detailPreviewIframe.getAttribute('src')) {
      detailPreviewIframe.removeAttribute('src');
      detailViewerBadge.classList.add('hidden');
    }
  }

  // Admin-only, dashboard-only - polled while a recording is in progress so
  // the "still recording - keep going?" prompt shows up without needing a
  // page refresh, and disappears again the moment an answer is given.
  function pollRecordingSession() {
    fetch('/api/channels/' + currentChannelId + '/recording-session', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (session) {
        if (!currentChannelId) return;
        recordingContinueBanner.classList.toggle('hidden', !(session && session.awaitingConfirmation));
      })
      .catch(function () {});
  }

  function answerRecordingPrompt(shouldContinue) {
    recordingContinueBanner.classList.add('hidden');
    api('/api/channels/' + currentChannelId + '/recording-session/decision', {
      method: 'POST',
      body: JSON.stringify({ continue: shouldContinue }),
    }).catch(function (err) { alert(err.message); });
  }

  // Admin-only, dashboard-only - fetched from a separate authenticated route
  // (never folded into the public /status endpoint above) so a viewer count
  // can never end up reachable from anything public.
  function pollViewerCount() {
    fetch('/api/channels/' + currentChannelId + '/viewers', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !currentChannelId) return;
        detailViewerBadge.textContent = data.count + ' watching';
        detailViewerBadge.classList.remove('hidden');
      })
      .catch(function () {});
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
        if (data.isLive) {
          pollViewerCount();
          pollRecordingSession();
        } else {
          recordingContinueBanner.classList.add('hidden');
        }
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
    document.title = channel.name + ' - RTMP Web Player';

    var rtmpUrl = 'rtmp://' + config.rtmpHost + ':' + config.rtmpPort + '/live';
    detailRtmpUrl.value = rtmpUrl;
    detailStreamKey.value = channel.streamKey;

    detailEmbedCode.value =
      '<iframe src="' + embedOrigin() + '/embed/' + channel.id + '" ' +
      'style="width:100%;aspect-ratio:16/9;border:0;" ' +
      'allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>';

    updatePreviewState(channel.isLive, channel.id);

    currentChannelMetadata = { title: channel.title || '', description: channel.description || '' };

    detailWebsiteToggle.checked = channel.websiteEnabled !== false;
    detailWebsiteHint.textContent = channel.websiteEnabled !== false
      ? 'This is the embed player itself'
      : 'Off - the embed and your website are not showing this stream';

    detailRecordingToggle.checked = !!channel.recordingEnabled;
    recordingContinueBanner.classList.add('hidden'); // reset on nav - pollLiveStatus re-shows it if still warranted

    var outputs = channel.outputs || [];
    detailOutputsList.innerHTML = '';
    detailOutputsEmpty.classList.toggle('hidden', outputs.length > 0);
    addOutputTypePublicLinkBtn.disabled = outputs.some(function (o) { return o.type === 'public-link'; });
    outputs.forEach(function (output) {
      var isYoutube = output.type === 'youtube';
      var isPublicLink = output.type === 'public-link';
      // Never rendered as visible text (screen shares, screenshots) - the
      // token in this URL is a real access-control secret now, same trust
      // level as a stream key, so it only ever leaves via the Copy button.
      var publicLinkUrl = embedOrigin() + '/watch/' + channel.id + '/' + output.token;
      var node = outputRowTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector('.output-name').textContent = isYoutube ? 'YouTube' : isPublicLink ? 'Public Link' : output.name;
      node.querySelector('.output-url').textContent = isYoutube
        ? 'Connected as ' + output.channelTitle
        : isPublicLink ? 'Anyone with the link can watch - click Copy link to share it' : output.rtmpUrl;

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

      var editBtn = node.querySelector('.output-edit-btn');
      if (!isYoutube && !isPublicLink) {
        editBtn.classList.remove('hidden');
        editBtn.addEventListener('click', function () {
          editingOutputId = output.id;
          editOutputName.value = output.name;
          editOutputRtmpUrl.value = output.rtmpUrl;
          editOutputStreamKey.value = output.streamKey;
          editOutputModalBackdrop.classList.remove('hidden');
        });
      }

      var copyBtn = node.querySelector('.output-copy-btn');
      if (isPublicLink) {
        copyBtn.classList.remove('hidden');
        copyBtn.addEventListener('click', function () {
          navigator.clipboard.writeText(publicLinkUrl).then(function () {
            var original = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            setTimeout(function () {
              copyBtn.textContent = original;
              copyBtn.classList.remove('copied');
            }, 1500);
          });
        });
      }

      node.querySelector('.output-delete-btn').addEventListener('click', function () {
        var message = isYoutube
          ? 'Disconnect YouTube account "' + output.channelTitle + '"?'
          : isPublicLink ? 'Remove the public link? The current link will stop working.'
          : 'Remove output "' + output.name + '"?';
        if (!confirm(message)) return;
        api('/api/channels/' + channel.id + '/outputs/' + output.id, { method: 'DELETE' })
          .then(refreshChannelDetail)
          .catch(function (err) { alert(err.message); });
      });

      detailOutputsList.appendChild(node);
    });

    renderGallery(detailCoverGallery, channel, 'coverImages', 'activeCoverImage', 'covers');
    renderGallery(detailThumbGallery, channel, 'liveThumbnails', 'activeLiveThumbnail', 'live-thumbnails');
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    var mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    if (mb >= 1) return Math.round(mb) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function formatDuration(totalSeconds) {
    if (!totalSeconds) return '';
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    var mm = h > 0 && m < 10 ? '0' + m : String(m);
    var ss = s < 10 ? '0' + s : String(s);
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  // ===================== Recordings page =====================

  var recordingPlayerModalBackdrop = document.getElementById('recording-player-modal-backdrop');
  var recordingPlayerVideo = document.getElementById('recording-player-video');
  var recordingPlayerTitle = document.getElementById('recording-player-title');
  var recordingPlayerCloseBtn = document.getElementById('recording-player-close-btn');

  function closeRecordingPlayer() {
    recordingPlayerModalBackdrop.classList.add('hidden');
    recordingPlayerVideo.pause();
    recordingPlayerVideo.removeAttribute('src');
    recordingPlayerVideo.load(); // actually stops the in-flight download, removeAttribute alone doesn't
  }
  recordingPlayerCloseBtn.addEventListener('click', closeRecordingPlayer);
  recordingPlayerModalBackdrop.addEventListener('click', function (e) {
    if (e.target === recordingPlayerModalBackdrop) closeRecordingPlayer();
  });

  var recordingsChannelSelect = document.getElementById('recordings-channel-select');
  var recordingsPageList = document.getElementById('recordings-page-list');
  var recordingsPageEmpty = document.getElementById('recordings-page-empty');
  var recordingsListenersWired = false;

  function renderRecordingRows(channelId, rows) {
    recordingsPageList.innerHTML = '';
    recordingsPageEmpty.classList.toggle('hidden', rows.length > 0);
    if (rows.length === 0) {
      recordingsPageEmpty.textContent = channelId ? 'No recordings yet for this channel.' : 'No recordings yet.';
    }

    rows.forEach(function (recording) {
      var recordingChannelId = recording.channelId || channelId;
      var node = recordingRowTemplate.content.firstElementChild.cloneNode(true);
      var when = new Date(recording.startedAt);
      node.querySelector('.recording-date').textContent = when.toLocaleString();
      var metaParts = [];
      if (!channelId && recording.channelName) metaParts.push(recording.channelName);
      if (recording.durationSeconds) metaParts.push(formatDuration(recording.durationSeconds));
      metaParts.push(formatBytes(recording.sizeBytes));
      node.querySelector('.recording-meta').textContent = metaParts.join(' · ');

      node.querySelector('.recording-play-btn').addEventListener('click', function () {
        api('/api/channels/' + recordingChannelId + '/recordings/' + recording.id + '/url')
          .then(function (data) {
            recordingPlayerTitle.textContent = when.toLocaleString() + (recording.channelName ? ' - ' + recording.channelName : '');
            recordingPlayerVideo.src = data.url;
            recordingPlayerModalBackdrop.classList.remove('hidden');
            recordingPlayerVideo.play().catch(function () {}); // autoplay can be blocked - controls are still there either way
          })
          .catch(function (err) { alert(err.message); });
      });

      node.querySelector('.recording-download-btn').addEventListener('click', function () {
        api('/api/channels/' + recordingChannelId + '/recordings/' + recording.id + '/url?download=1')
          .then(function (data) { window.open(data.url, '_blank'); })
          .catch(function (err) { alert(err.message); });
      });

      node.querySelector('.recording-delete-btn').addEventListener('click', function () {
        if (!confirm('Delete this recording? This cannot be undone.')) return;
        api('/api/channels/' + recordingChannelId + '/recordings/' + recording.id, { method: 'DELETE' })
          .then(function () { loadRecordingsForChannel(channelId); })
          .catch(function (err) { alert(err.message); });
      });

      recordingsPageList.appendChild(node);
    });
  }

  function loadRecordingsForChannel(channelId) {
    var url = channelId ? '/api/channels/' + channelId + '/recordings' : '/api/channels/recordings/all';
    return api(url).then(function (rows) {
      renderRecordingRows(channelId, rows);
    });
  }

  function loadRecordingsPage() {
    return api('/api/channels').then(function (channels) {
      var selected = recordingsChannelSelect.value;
      recordingsChannelSelect.innerHTML = '';
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'All channels';
      recordingsChannelSelect.appendChild(placeholder);
      channels.forEach(function (channel) {
        var opt = document.createElement('option');
        opt.value = channel.id;
        opt.textContent = channel.name;
        recordingsChannelSelect.appendChild(opt);
      });
      recordingsChannelSelect.value = selected;

      wireRecordingsEventListeners();
      return loadRecordingsForChannel(recordingsChannelSelect.value);
    });
  }

  function wireRecordingsEventListeners() {
    if (recordingsListenersWired) return;
    recordingsListenersWired = true;
    recordingsChannelSelect.addEventListener('change', function () {
      loadRecordingsForChannel(recordingsChannelSelect.value);
    });
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

    detailRecordingToggle.addEventListener('change', function () {
      api('/api/channels/' + currentChannelId + '/website-settings', {
        method: 'PATCH',
        body: JSON.stringify({ recordingEnabled: detailRecordingToggle.checked }),
      })
        .then(refreshChannelDetail)
        .catch(function (err) {
          alert(err.message);
          detailRecordingToggle.checked = !detailRecordingToggle.checked;
        });
    });

    recordingContinueBtn.addEventListener('click', function () { answerRecordingPrompt(true); });
    recordingStopBtn.addEventListener('click', function () { answerRecordingPrompt(false); });

    editMetadataBtn.addEventListener('click', function () {
      metadataTitleInput.value = currentChannelMetadata.title;
      metadataDescriptionInput.value = currentChannelMetadata.description;
      metadataModalBackdrop.classList.remove('hidden');
    });
    metadataCancelBtn.addEventListener('click', function () {
      metadataModalBackdrop.classList.add('hidden');
    });
    metadataModalBackdrop.addEventListener('click', function (e) {
      if (e.target === metadataModalBackdrop) metadataModalBackdrop.classList.add('hidden');
    });

    function closeEditOutputModal() {
      editOutputModalBackdrop.classList.add('hidden');
      editOutputForm.reset();
      editingOutputId = null;
    }
    editOutputCancelBtn.addEventListener('click', closeEditOutputModal);
    editOutputModalBackdrop.addEventListener('click', function (e) {
      if (e.target === editOutputModalBackdrop) closeEditOutputModal();
    });
    editOutputForm.addEventListener('submit', function (e) {
      e.preventDefault();
      api('/api/channels/' + currentChannelId + '/outputs/' + editingOutputId, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editOutputName.value,
          rtmpUrl: editOutputRtmpUrl.value,
          streamKey: editOutputStreamKey.value,
        }),
      })
        .then(function () {
          closeEditOutputModal();
          return refreshChannelDetail();
        })
        .catch(function (err) { alert(err.message); });
    });
    metadataSaveBtn.addEventListener('click', function () {
      api('/api/channels/' + currentChannelId + '/metadata', {
        method: 'PATCH',
        body: JSON.stringify({
          title: metadataTitleInput.value,
          description: metadataDescriptionInput.value,
        }),
      })
        .then(function () {
          metadataModalBackdrop.classList.add('hidden');
          return refreshChannelDetail();
        })
        .catch(function (err) { alert(err.message); });
    });

    function closeAddOutputModal() {
      addOutputModalBackdrop.classList.add('hidden');
      addOutputRtmpForm.reset();
      addOutputRtmpForm.classList.add('hidden');
      addOutputTypeRow.classList.remove('hidden');
    }

    addOutputBtn.addEventListener('click', function () {
      addOutputModalBackdrop.classList.remove('hidden');
    });
    addOutputCancelBtn.addEventListener('click', closeAddOutputModal);
    addOutputModalBackdrop.addEventListener('click', function (e) {
      if (e.target === addOutputModalBackdrop) closeAddOutputModal();
    });
    // Absent from the DOM entirely on production (see stripYoutubeOnProduction
    // in devBanner.js) - this is a dev-site-only feature there.
    if (addOutputTypeYoutubeBtn) {
      addOutputTypeYoutubeBtn.addEventListener('click', function () {
        window.location.href = '/api/youtube/connect?channelId=' + encodeURIComponent(currentChannelId);
      });
    }
    addOutputTypeRtmpBtn.addEventListener('click', function () {
      addOutputTypeRow.classList.add('hidden');
      addOutputRtmpForm.classList.remove('hidden');
    });
    addOutputTypePublicLinkBtn.addEventListener('click', function () {
      api('/api/channels/' + currentChannelId + '/outputs', {
        method: 'POST',
        body: JSON.stringify({ type: 'public-link' }),
      })
        .then(function () {
          closeAddOutputModal();
          return refreshChannelDetail();
        })
        .catch(function (err) { alert(err.message); });
    });
    addOutputRtmpForm.addEventListener('submit', function (e) {
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
          closeAddOutputModal();
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
    dashboardView.classList.remove('hidden');
    api('/api/config').then(function (cfg) {
      config = cfg;
      // Both absent from the DOM entirely on production - only present (and
      // possibly still hidden pending real credentials) on the dev site.
      if (addOutputTypeYoutubeBtn) addOutputTypeYoutubeBtn.classList.toggle('hidden', !cfg.youtubeEnabled);
      var youtubePrivacyNotice = document.getElementById('add-output-youtube-privacy-notice');
      if (youtubePrivacyNotice) youtubePrivacyNotice.classList.toggle('hidden', !cfg.youtubeEnabled);
      route();
    });
  }

  logoutBtn.addEventListener('click', function () {
    api('/api/logout', { method: 'POST' }).then(function () {
      if (listRefreshTimer) clearInterval(listRefreshTimer);
      if (detailPollTimer) clearInterval(detailPollTimer);
      window.location.href = '/login';
    });
  });

  api('/api/me').then(function (data) {
    if (data.authenticated) {
      enterDashboard();
    } else {
      window.location.href = '/login';
    }
  });
})();
