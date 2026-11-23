(function () {
  var dashboardView = document.getElementById('dashboard-view');
  var logoutBtn = document.getElementById('logout-btn');

  var listView = document.getElementById('channel-list-view');
  var detailView = document.getElementById('channel-detail-view');
  var headerChannelActions = document.getElementById('header-channel-actions');
  var statsView = document.getElementById('stats-view');
  var recordingsView = document.getElementById('recordings-view');
  var howItWorksView = document.getElementById('how-it-works-view');
  var howToUseView = document.getElementById('how-to-use-view');
  var streamTestView = document.getElementById('stream-test-view');

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
  var recordingsPollTimer = null;
  var currentChannelId = null;
  var currentChannelMetadata = { title: '', description: '' };
  var detailListenersWired = false;

  function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(url, opts).then(function (res) {
      // Session ended (expired, logged out elsewhere) - go back to login
      // rather than letting every action fail with "Unauthorized".
      if (res.status === 401) {
        window.location.href = '/login';
        return new Promise(function () {});
      }
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
    if (hash === '#/how-to-use') return { view: 'how-to-use' };
    if (hash === '#/stream-test') return { view: 'stream-test' };
    return { view: 'list' };
  }

  function route() {
    if (listRefreshTimer) { clearInterval(listRefreshTimer); listRefreshTimer = null; }
    if (detailPollTimer) { clearInterval(detailPollTimer); detailPollTimer = null; }
    if (recordingsPollTimer) { clearInterval(recordingsPollTimer); recordingsPollTimer = null; }

    var r = parseRoute();
    listView.classList.add('hidden');
    detailView.classList.add('hidden');
    headerChannelActions.classList.add('hidden');
    statsView.classList.add('hidden');
    recordingsView.classList.add('hidden');
    howItWorksView.classList.add('hidden');
    howToUseView.classList.add('hidden');
    streamTestView.classList.add('hidden');

    if (r.view === 'detail') {
      detailView.classList.remove('hidden');
      headerChannelActions.classList.remove('hidden');
      loadChannelDetail(r.channelId);
      detailPollTimer = setInterval(pollLiveStatus, 5000);
    } else if (r.view === 'stats') {
      document.title = 'Stats - RTMP Web Player';
      statsView.classList.remove('hidden');
      loadStats();
    } else if (r.view === 'recordings') {
      document.title = 'Recordings - RTMP Web Player';
      recordingsView.classList.remove('hidden');
      if (config.recordingsEnabled) {
        recordingsDisabledNotice.classList.add('hidden');
        recordingsNormalContent.classList.remove('hidden');
        loadRecordingsPage();
        loadProcessingRecordings();
        recordingsPollTimer = setInterval(loadProcessingRecordings, 3000);
      } else {
        recordingsNormalContent.classList.add('hidden');
        recordingsDisabledNotice.classList.remove('hidden');
      }
    } else if (r.view === 'how-it-works') {
      document.title = 'How it works - RTMP Web Player';
      howItWorksView.classList.remove('hidden');
    } else if (r.view === 'how-to-use') {
      document.title = 'How to use - RTMP Web Player';
      howToUseView.classList.remove('hidden');
    } else if (r.view === 'stream-test') {
      document.title = 'Stream test - RTMP Web Player';
      streamTestView.classList.remove('hidden');
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
  var statsTodayBtn = document.getElementById('stats-today-btn');
  var statsExportBtn = document.getElementById('stats-export-btn');
  var statsExportXlsxBtn = document.getElementById('stats-export-xlsx-btn');
  var statsExportPdfBtn = document.getElementById('stats-export-pdf-btn');
  var statsExportTemplateBtn = document.getElementById('stats-export-template-btn');
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
  var statsChannelsCache = [];

  var statsPlatformsStatusText = document.getElementById('stats-platforms-status-text');
  var statsPlatformsRefreshBtn = document.getElementById('stats-platforms-refresh-btn');
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
    statsExportXlsxBtn.href = '/api/stats/export.xlsx' + (query ? '?' + query : '');
    statsExportPdfBtn.href = '/api/stats/export.pdf' + (query ? '?' + query : '');
    // Only makes sense for one channel's own services - "All channels" would
    // mix different channels' streams into the same date+AM/PM buckets.
    // Always the trailing 6 months server-side, so From/To aren't included
    // here - they wouldn't do anything.
    statsExportTemplateBtn.href = '/api/stats/export-template.xlsx'
      + (statsChannelFilter.value ? '?channelId=' + encodeURIComponent(statsChannelFilter.value) : '');
    statsExportTemplateBtn.classList.toggle('disabled', !statsChannelFilter.value);
    statsExportTemplateBtn.title = statsChannelFilter.value
      ? 'Exports this channel\'s last 6 months, whatever the From and To dates are set to'
      : 'Choose a channel above to export in the template';

    return api('/api/stats' + (query ? '?' + query : '')).then(function (data) {
      statsChannelsCache = data.channels;
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
        row.querySelector('.stats-col-platform').textContent = p.platformLabel || '';
        row.querySelector('.stats-col-views').textContent = p.views != null ? p.views : '';
        row.querySelector('.stats-col-peak').textContent = p.peakLiveViewers != null ? p.peakLiveViewers : '';
        row.querySelector('.stats-col-avg').textContent = p.avgLiveViewers != null ? p.avgLiveViewers : '';
        row.querySelector('.stats-col-type').textContent = p.type || '';
        row.querySelector('.stats-col-ip').textContent = p.ip || '';
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
    statsTodayBtn.addEventListener('click', function () {
      var d = new Date();
      var today = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      statsFromFilter.value = today;
      statsToFilter.value = today;
      loadStats();
    });
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
      if (!confirm('Delete ' + ids.length + ' selected row' + (ids.length === 1 ? '' : 's') + '? This can\'t be undone.')) return;
      api('/api/stats', { method: 'DELETE', body: JSON.stringify({ ids: ids }) })
        .then(loadStats)
        .catch(function (err) { alert(err.message); });
    });

    statsPlatformsRefreshBtn.addEventListener('click', function () {
      statsPlatformsRefreshBtn.disabled = true;
      statsPlatformsStatusText.classList.remove('error');
      statsPlatformsStatusText.textContent = 'Asking YouTube and Facebook for the latest views...';
      api('/api/stats/platforms/refresh', { method: 'POST' })
        .then(function (result) {
          var when = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          if (result.problems && result.problems.length) {
            statsPlatformsStatusText.classList.add('error');
            statsPlatformsStatusText.textContent = 'Updated at ' + when + ', but some failed: ' + result.problems.join(' ');
          } else {
            statsPlatformsStatusText.textContent = result.refreshed
              ? 'Updated ' + result.refreshed + ' stream' + (result.refreshed === 1 ? '' : 's') + ' at ' + when + '.'
              : 'No YouTube or Facebook streams in the last five weeks to update.';
          }
          return loadStats();
        })
        .catch(function (err) {
          statsPlatformsStatusText.classList.add('error');
          statsPlatformsStatusText.textContent = 'Couldn\'t update the views: ' + err.message;
        })
        .then(function () { statsPlatformsRefreshBtn.disabled = false; });
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
  var detailWebsiteViewers = document.getElementById('detail-website-viewers');
  // Latest counts from /viewers, kept so rows re-rendered between polls
  // get their pills straight back. Null while the channel is offline.
  var lastViewerCounts = null;
  var detailOfflineInfo = document.getElementById('detail-offline-info');
  var detailPreviewIframe = document.getElementById('detail-preview-iframe');
  var detailRtmpUrl = document.getElementById('detail-rtmp-url');
  var detailStreamKey = document.getElementById('detail-stream-key');
  var detailRevealBtn = document.getElementById('detail-reveal-btn');
  var detailRegenBtn = document.getElementById('detail-regen-btn');
  var detailEmbedCode = document.getElementById('detail-embed-code');

  var detailWebsiteToggle = document.getElementById('detail-website-toggle');
  var detailWebsiteHint = document.getElementById('detail-website-hint');
  var websiteHtmlBtn = document.getElementById('website-html-btn');
  var websiteHtmlModalBackdrop = document.getElementById('website-html-modal-backdrop');
  var websiteHtmlCloseBtn = document.getElementById('website-html-close-btn');

  var editMetadataBtn = document.getElementById('edit-metadata-btn');
  var metadataModalBackdrop = document.getElementById('metadata-modal-backdrop');
  var metadataTitleInput = document.getElementById('metadata-title-input');
  var metadataDescriptionInput = document.getElementById('metadata-description-input');
  var metadataSaveBtn = document.getElementById('metadata-save-btn');
  var metadataCancelBtn = document.getElementById('metadata-cancel-btn');

  var detailOutputsList = document.getElementById('detail-outputs-list');
  var websiteOutputRow = document.getElementById('website-output-row');
  var allOutputsRow = document.getElementById('all-outputs-row');
  var allOutputsToggle = document.getElementById('all-outputs-toggle');
  var draggingOutput = null;
  var detailOutputsEmpty = document.getElementById('detail-outputs-empty');

  var addOutputBtn = document.getElementById('add-output-btn');
  var addOutputModalBackdrop = document.getElementById('add-output-modal-backdrop');
  var addOutputTypeRow = document.getElementById('add-output-type-row');
  var addOutputTypeRtmpBtn = document.getElementById('add-output-type-rtmp');
  var addOutputTypePublicLinkBtn = document.getElementById('add-output-type-public-link');
  var addOutputTypeYoutubeBtn = document.getElementById('add-output-type-youtube');
  var addOutputTypeFacebookBtn = document.getElementById('add-output-type-facebook');
  var facebookPageModalBackdrop = document.getElementById('facebook-page-modal-backdrop');
  var facebookPageList = document.getElementById('facebook-page-list');
  var facebookPageCancelBtn = document.getElementById('facebook-page-cancel-btn');
  var youtubeOutputRowTemplate = document.getElementById('youtube-output-row-template');
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

  var imageRenameModalBackdrop = document.getElementById('image-rename-modal-backdrop');
  var imageRenameInput = document.getElementById('image-rename-input');
  var imageRenameSaveBtn = document.getElementById('image-rename-save-btn');
  var imageRenameCancelBtn = document.getElementById('image-rename-cancel-btn');
  var imageRenameTarget = null; // { routeSegment, filename }

  var thumbPickerModalBackdrop = document.getElementById('thumb-picker-modal-backdrop');
  var thumbPickerGallery = document.getElementById('thumb-picker-gallery');
  var thumbPickerSkipBtn = document.getElementById('thumb-picker-skip-btn');
  var thumbPickerUploadInput = document.getElementById('thumb-picker-upload-input');
  var THUMB_POPUP_REMEMBER_MS = 2 * 60 * 60 * 1000;

  var detailRecordingToggle = document.getElementById('detail-recording-toggle');
  var recordingRowTemplate = document.getElementById('recording-row-template');

  var recordingContinueBanner = document.getElementById('recording-continue-banner');
  var recordingContinueBtn = document.getElementById('recording-continue-btn');
  var recordingStopBtn = document.getElementById('recording-stop-btn');

  function loadChannelDetail(channelId) {
    currentChannelId = channelId;
    wireDetailEventListeners();
    return refreshChannelDetail().then(function (channel) {
      if (channel) maybeShowThumbPopup(channel);
      // Back from Facebook's sign-in with several Pages to choose from.
      if (/\/facebook-page$/.test(window.location.hash)) showFacebookPagePicker();
    });
  }

  function showFacebookPagePicker() {
    history.replaceState(null, '', '#/channel/' + encodeURIComponent(currentChannelId));
    api('/api/facebook/pending').then(function (data) {
      if (!data.pages || !data.pages.length) return;
      facebookPageList.innerHTML = '';
      data.pages.forEach(function (page) {
        var btn = document.createElement('button');
        btn.className = 'secondary';
        btn.textContent = page.name;
        btn.addEventListener('click', function () {
          api('/api/facebook/pick', { method: 'POST', body: JSON.stringify({ pageId: page.id }) })
            .then(function () {
              facebookPageModalBackdrop.classList.add('hidden');
              return refreshChannelDetail();
            })
            .catch(function (err) { alert(err.message); });
        });
        facebookPageList.appendChild(btn);
      });
      facebookPageModalBackdrop.classList.remove('hidden');
    }).catch(function () {});
  }

  function refreshChannelDetail() {
    return api('/api/channels/' + currentChannelId)
      .then(function (channel) {
        renderChannelDetail(channel);
        return channel;
      })
      .catch(function (err) {
        alert(err.message);
        window.location.hash = '#/';
      });
  }

  // Prompts the admin to pick a live thumbnail the moment a channel's page
  // is opened, but only when there's an actual choice to make (2+ uploaded)
  // and only once per channel per browser every couple hours - re-asking on
  // every visit would just be noise once someone's already decided.
  function thumbPopupStorageKey(channelId) {
    return 'liveThumbPopupUntil:' + channelId;
  }

  function renderThumbPickerGallery(channel) {
    thumbPickerGallery.innerHTML = '';
    var names = channel.liveThumbnailNames || {};
    (channel.liveThumbnails || []).forEach(function (filename) {
      var item = document.createElement('div');
      item.className = 'gallery-item' + (filename === channel.activeLiveThumbnail ? ' active' : '');

      var visual = document.createElement('div');
      visual.className = 'gallery-item-visual';

      var img = document.createElement('img');
      img.src = '/uploads/' + filename;
      img.alt = '';
      img.title = 'Use this thumbnail';
      img.addEventListener('click', function () {
        api('/api/channels/' + channel.id + '/live-thumbnails/' + encodeURIComponent(filename) + '/activate', { method: 'POST' })
          .then(function () {
            dismissThumbPopup(channel.id);
            return refreshChannelDetail();
          })
          .catch(function (err) { alert(err.message); });
      });
      visual.appendChild(img);

      if (filename === channel.activeLiveThumbnail) {
        var badge = document.createElement('span');
        badge.className = 'gallery-active-badge';
        badge.textContent = 'ACTIVE';
        visual.appendChild(badge);
      }

      item.appendChild(visual);

      var name = document.createElement('div');
      name.className = 'gallery-item-name';
      name.textContent = names[filename] || 'Untitled';
      item.appendChild(name);

      thumbPickerGallery.appendChild(item);
    });
  }

  function maybeShowThumbPopup(channel) {
    if ((channel.liveThumbnails || []).length < 2) return;
    var dismissedUntil = Number(localStorage.getItem(thumbPopupStorageKey(channel.id)));
    if (dismissedUntil && Date.now() < dismissedUntil) return;

    renderThumbPickerGallery(channel);
    thumbPickerModalBackdrop.classList.remove('hidden');
  }

  function dismissThumbPopup(channelId) {
    localStorage.setItem(thumbPopupStorageKey(channelId), String(Date.now() + THUMB_POPUP_REMEMBER_MS));
    thumbPickerModalBackdrop.classList.add('hidden');
  }

  // Lets an admin add a new candidate thumbnail without leaving the popup -
  // re-renders just the popup's gallery with the new option added, rather
  // than closing it, since the whole point of being here is still deciding.
  function uploadThumbFromPopup(file) {
    if (!file) return;
    var formData = new FormData();
    formData.append('image', file);
    fetch('/api/channels/' + currentChannelId + '/live-thumbnails', { method: 'POST', body: formData })
      .then(function (res) {
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
      })
      .then(function (channel) {
        thumbPickerUploadInput.value = '';
        renderThumbPickerGallery(channel);
        return refreshChannelDetail();
      })
      .catch(function (err) { alert(err.message); });
  }

  function updatePreviewState(isLive, channelId) {
    // No separate "live" badge here - the preview iframe (embed.html) shows
    // its own live/behind-live status internally, so a duplicate at the
    // dashboard level would just visually collide with it.
    detailOfflineBadge.classList.toggle('hidden', isLive);
    detailOfflineInfo.classList.toggle('hidden', isLive);
    detailPreviewIframe.classList.toggle('hidden', !isLive);

    if (isLive) {
      // Muted to start with - see ?muted=1 in embed.html.
      var expectedSrc = embedOrigin() + '/embed/' + channelId + '?muted=1';
      if (detailPreviewIframe.getAttribute('src') !== expectedSrc) {
        detailPreviewIframe.src = expectedSrc;
      }
    } else if (detailPreviewIframe.getAttribute('src')) {
      detailPreviewIframe.removeAttribute('src');
    }
    if (!isLive) {
      lastViewerCounts = null;
      applyViewerPills();
    }
    renderBottomPanels(isLive);
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
        data.channelId = currentChannelId;
        lastViewerCounts = data;
        applyViewerPills();
      })
      .catch(function () {});
  }

  function setViewerPill(pill, count) {
    var show = count != null;
    pill.classList.toggle('hidden', !show);
    if (show) pill.textContent = count + ' watching';
  }

  // One pill per output that can be counted. Custom RTMP outputs can't, so
  // they never get one.
  function applyViewerPills() {
    var counts = lastViewerCounts && lastViewerCounts.channelId === currentChannelId ? lastViewerCounts : null;
    setViewerPill(detailWebsiteViewers, counts && counts.website);
    var outputs = (counts && counts.outputs) || {};
    // All sources: everyone on every source that has a count.
    var total = null;
    if (counts) {
      total = counts.website || 0;
      Object.keys(outputs).forEach(function (id) { if (outputs[id] != null) total += outputs[id]; });
    }
    setViewerPill(document.getElementById('all-sources-viewers'), total);
    detailOutputsList.querySelectorAll('[data-viewer-output-id]').forEach(function (row) {
      setViewerPill(row.querySelector('.viewer-pill'), outputs[row.dataset.viewerOutputId]);
    });
  }

  // Polled on an interval - only touches live/offline state, never the rest
  // of the form, so it can't clobber in-progress typing (e.g. a title or a
  // half-filled "add output" form) while the user is editing.
  function pollLiveStatus() {
    if (!currentChannelId) return;
    fetch('/api/channels/' + currentChannelId + '/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        updatePreviewState(data.isLive, currentChannelId);
        pollBottomPanels(data.isLive);
        refreshPlatformOutputs();
        if (data.isLive) {
          pollViewerCount();
          pollRecordingSession();
        } else {
          recordingContinueBanner.classList.add('hidden');
        }
      })
      .catch(function () {});
  }

  // Stretch the cover/thumbnail panel so its bottom lines up with the
  // bottom of the player, and grow the images to fill the space: the
  // biggest 16:9 size at which each gallery still fits. Only side by side;
  // when the columns stack the panel keeps its natural size.
  var detailPreviewPanel = document.getElementById('detail-preview-panel');
  var detailExtrasPanel = document.getElementById('detail-extras-panel');
  var GALLERY_GAP = 22;
  var MIN_THUMB_W = 72;
  var MAX_THUMB_W = 300;

  function largestThumbWidth(count, width, height) {
    for (var w = MAX_THUMB_W; w > MIN_THUMB_W; w -= 2) {
      var perRow = Math.max(1, Math.floor((width + GALLERY_GAP) / (w + GALLERY_GAP)));
      if (perRow === 1 && w > width) continue;
      var rows = Math.ceil(count / perRow);
      if (rows * (w * 9 / 16) + (rows - 1) * GALLERY_GAP <= height) return w;
    }
    return MIN_THUMB_W;
  }

  function fitDetailExtras() {
    var galleries = [detailCoverGallery, detailThumbGallery];
    detailExtrasPanel.style.minHeight = '';
    galleries.forEach(function (g) { g.style.removeProperty('--thumb-w'); g.classList.remove('gallery-big'); });
    if (detailView.classList.contains('hidden')) return;

    var sideBySide = detailPreviewPanel.getBoundingClientRect().right <= detailExtrasPanel.getBoundingClientRect().left;
    if (!sideBySide) return;
    var target = detailPreviewPanel.getBoundingClientRect().bottom;
    var panelBox = detailExtrasPanel.getBoundingClientRect();
    if (panelBox.bottom >= target) return;

    var padBottom = parseFloat(getComputedStyle(detailExtrasPanel).paddingBottom) || 0;
    // Measure both galleries before growing either: growing one makes the
    // panel taller, which would hide the other's spare room.
    var sizes = galleries.map(function (g) {
      var count = g.querySelectorAll('.gallery-item').length;
      var slack = (target - padBottom) - g.parentNode.getBoundingClientRect().bottom;
      return count && slack > 0 ? largestThumbWidth(count, g.clientWidth, g.clientHeight + slack) : null;
    });
    // Both galleries use the same size, so they match side by side.
    var fits = sizes.filter(function (s) { return s; });
    var size = fits.length ? Math.min.apply(null, fits) : null;
    galleries.forEach(function (g, i) {
      if (!size || !sizes[i]) return;
      g.style.setProperty('--thumb-w', size + 'px');
      g.classList.toggle('gallery-big', size >= 140);
    });
    detailExtrasPanel.style.minHeight = Math.max(0, Math.round(target - detailExtrasPanel.getBoundingClientRect().top)) + 'px';
  }

  if (window.ResizeObserver) {
    // Not the extras panel itself, which this resizes.
    var extrasObserver = new ResizeObserver(function () { fitDetailExtras(); });
    extrasObserver.observe(detailPreviewPanel);
    extrasObserver.observe(document.querySelector('.outputs-panel'));
  } else {
    window.addEventListener('resize', fitDetailExtras);
  }

  function renderGallery(galleryEl, channel, listField, activeField, routeSegment, namesField) {
    var list = channel[listField] || [];
    var names = channel[namesField] || {};
    galleryEl.innerHTML = '';
    if (list.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'gallery-empty hint';
      empty.textContent = 'No images yet';
      galleryEl.appendChild(empty);
      return;
    }

    list.forEach(function (filename) {
      var item = document.createElement('div');
      item.className = 'gallery-item' + (filename === channel[activeField] ? ' active' : '');
      item.dataset.filename = filename;

      var img = document.createElement('img');
      img.draggable = false;
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

      var editBtn = document.createElement('button');
      editBtn.className = 'gallery-edit';
      editBtn.textContent = '✎';
      editBtn.title = 'Name this image';
      editBtn.addEventListener('click', function () {
        openImageRenameModal(routeSegment, filename, names[filename]);
      });
      item.appendChild(editBtn);

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

  function openImageRenameModal(routeSegment, filename, currentName) {
    imageRenameTarget = { routeSegment: routeSegment, filename: filename };
    imageRenameInput.value = currentName || '';
    document.getElementById('image-rename-preview').src = '/uploads/' + filename;
    imageRenameModalBackdrop.classList.remove('hidden');
    imageRenameInput.focus();
  }

  function closeImageRenameModal() {
    imageRenameModalBackdrop.classList.add('hidden');
    imageRenameTarget = null;
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

  // Direct YouTube/Facebook outputs share one row layout: what's connected,
  // the privacy new YouTube broadcasts get, the switch, and the status line.
  var PLATFORM_OUTPUTS = {
    youtube: { name: 'YouTube', connectedTo: function (o) { return o.youtubeChannelTitle; }, privacy: true },
    facebook: { name: 'Facebook', connectedTo: function (o) { return o.facebookPageName; }, privacy: false },
  };

  // ===================== Reordering outputs =====================
  // Drag the grip (mouse or touch), or focus it and use the arrow keys.

  function outputOrder() {
    return Array.prototype.map.call(detailOutputsList.querySelectorAll(':scope > [data-sort-id]'), function (el) {
      return el.dataset.sortId;
    });
  }

  function saveOutputOrder() {
    api('/api/channels/' + currentChannelId + '/output-order', { method: 'PATCH', body: JSON.stringify({ order: outputOrder() }) })
      .catch(function (err) { alert(err.message); refreshChannelDetail(); });
  }

  function wireOutputReordering() {
    var startOrder = null;

    detailOutputsList.addEventListener('pointerdown', function (e) {
      var handle = e.target.closest('.drag-handle');
      if (!handle || e.button > 0) return;
      e.preventDefault();
      draggingOutput = handle.closest('[data-sort-id]');
      startOrder = outputOrder().join();
      draggingOutput.classList.add('dragging');
      document.body.classList.add('is-dragging-output');
      handle.setPointerCapture(e.pointerId);
    });

    detailOutputsList.addEventListener('pointermove', function (e) {
      if (!draggingOutput) return;
      var others = Array.prototype.filter.call(detailOutputsList.querySelectorAll(':scope > [data-sort-id]'), function (el) {
        return el !== draggingOutput;
      });
      var before = null;
      for (var i = 0; i < others.length; i++) {
        var box = others[i].getBoundingClientRect();
        if (e.clientY < box.top + box.height / 2) { before = others[i]; break; }
      }
      if (draggingOutput.nextElementSibling !== before || (before === null && detailOutputsList.lastElementChild !== draggingOutput)) {
        detailOutputsList.insertBefore(draggingOutput, before);
      }
    });

    function endDrag() {
      if (!draggingOutput) return;
      draggingOutput.classList.remove('dragging');
      document.body.classList.remove('is-dragging-output');
      draggingOutput = null;
      if (outputOrder().join() !== startOrder) saveOutputOrder();
    }
    detailOutputsList.addEventListener('pointerup', endDrag);
    detailOutputsList.addEventListener('pointercancel', endDrag);

    detailOutputsList.addEventListener('keydown', function (e) {
      var handle = e.target.closest('.drag-handle');
      if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      var item = handle.closest('[data-sort-id]');
      var sibling = e.key === 'ArrowUp' ? item.previousElementSibling : item.nextElementSibling;
      if (!sibling) return;
      detailOutputsList.insertBefore(item, e.key === 'ArrowUp' ? sibling : sibling.nextElementSibling);
      handle.focus();
      saveOutputOrder();
    });
  }

  // "All sources" is on only when every switch in the list is on.
  function syncAllOutputsToggle() {
    var switches = detailOutputsList.querySelectorAll('input[type="checkbox"]');
    allOutputsToggle.checked = switches.length > 0 && Array.prototype.every.call(switches, function (s) { return s.checked; });
  }

  // Drag images in a gallery to reorder them. A press that moves less than
  // a few pixels is still a click (which picks the image).
  function wireGalleryReordering(galleryEl, routeSegment) {
    var drag = null;
    galleryEl.classList.add('gallery-sortable');

    galleryEl.addEventListener('pointerdown', function (e) {
      var item = e.target.closest('.gallery-item');
      if (!item || e.target.closest('button') || e.button > 0) return;
      drag = { item: item, x: e.clientX, y: e.clientY, moved: false, start: galleryOrder(galleryEl).join('|') };
    });

    galleryEl.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
        drag.moved = true;
        drag.item.classList.add('dragging');
        document.body.classList.add('is-dragging-output');
        galleryEl.setPointerCapture(e.pointerId);
      }
      var items = Array.prototype.slice.call(galleryEl.querySelectorAll('.gallery-item'));
      for (var i = 0; i < items.length; i++) {
        if (items[i] === drag.item) continue;
        var box = items[i].getBoundingClientRect();
        if (e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom) {
          var after = e.clientX > box.left + box.width / 2;
          galleryEl.insertBefore(drag.item, after ? items[i].nextSibling : items[i]);
          break;
        }
      }
    });

    function end() {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (!d.moved) return;
      d.item.classList.remove('dragging');
      document.body.classList.remove('is-dragging-output');
      // Swallow the click that follows the drop, so it doesn't pick the image.
      galleryEl.addEventListener('click', function (ev) { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
      setTimeout(function () { galleryEl.dispatchEvent(new Event('click')); }, 0);
      var order = galleryOrder(galleryEl);
      if (order.join('|') === d.start) return;
      api('/api/channels/' + currentChannelId + '/' + routeSegment + '/order', { method: 'PATCH', body: JSON.stringify({ order: order }) })
        .catch(function (err) { alert(err.message); refreshChannelDetail(); });
    }
    galleryEl.addEventListener('pointerup', end);
    galleryEl.addEventListener('pointercancel', end);
  }

  function galleryOrder(galleryEl) {
    return Array.prototype.map.call(galleryEl.querySelectorAll('.gallery-item'), function (el) { return el.dataset.filename; });
  }

  // ===================== Stream health, Viewers, Last stream =====================
  // Under the player and outputs. While live: Stream health (what the server
  // is receiving from the encoder) and a Viewers graph. While offline: a
  // summary of the last stream. See streamHealth.js and streamSessions.js.

  var detailBottom = document.getElementById('detail-bottom');
  var streamHealthPanel = document.getElementById('stream-health-panel');
  var viewerGraphPanel = document.getElementById('viewer-graph-panel');
  var lastStreamPanel = document.getElementById('last-stream-panel');
  var healthChip = document.getElementById('health-chip');
  var healthMessage = document.getElementById('health-message');
  var healthStats = document.getElementById('health-stats');
  var healthSpark = document.getElementById('health-spark');
  var healthSparkRange = document.getElementById('health-spark-range');
  var viewerGraph = document.getElementById('viewer-graph');
  var viewerGraphLegend = document.getElementById('viewer-graph-legend');
  var lastStreamWhen = document.getElementById('last-stream-when');
  var lastStreamFigures = document.getElementById('last-stream-figures');
  var lastStreamGraph = document.getElementById('last-stream-graph');
  var lastStreamLegend = document.getElementById('last-stream-legend');
  var lastStreamEmpty = document.getElementById('last-stream-empty');
  var lastStreamBody = lastStreamPanel.querySelector('.last-stream-body');

  var bottomState = null; // 'live' or 'offline', with the channel it's for
  var bitrateHistory = [];
  var lastSession = null;
  var bottomPollCount = 0;
  var BITRATE_WINDOW_MS = 5 * 60 * 1000;
  var SERIES_COLOURS = { 'Your website': '--series-website', 'Public Link': '--series-public-link', YouTube: '--series-youtube', Facebook: '--series-facebook' };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function formatSpan(ms) {
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return Math.max(0, Math.round(ms / 1000)) + 's';
    var h = Math.floor(mins / 60);
    return h ? h + 'h ' + String(mins % 60).padStart(2, '0') + 'm' : mins + 'm';
  }

  function formatClock(date) {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function formatNumber(n) {
    return Number(n).toLocaleString('en-GB');
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function fillFigures(dl, figures) {
    dl.innerHTML = '';
    figures.forEach(function (f) {
      var div = document.createElement('div');
      var dt = document.createElement('dt');
      dt.textContent = f.label;
      var dd = document.createElement('dd');
      if (f.id) dd.id = f.id;
      dd.textContent = f.value;
      if (f.note) {
        var small = document.createElement('small');
        small.textContent = f.note;
        dd.appendChild(small);
      }
      div.appendChild(dt);
      div.appendChild(dd);
      dl.appendChild(div);
    });
  }

  // Called whenever the channel's live state is known (page load and every
  // 5s poll). Switches between the live and offline boxes, and loads fresh
  // data when it changes.
  function renderBottomPanels(isLive) {
    var state = (isLive ? 'live:' : 'offline:') + currentChannelId;
    detailBottom.classList.remove('hidden');
    streamHealthPanel.classList.toggle('hidden', !isLive);
    viewerGraphPanel.classList.toggle('hidden', !isLive);
    lastStreamPanel.classList.toggle('hidden', isLive);
    if (state === bottomState) return;
    bottomState = state;
    bottomPollCount = 0;
    bitrateHistory = [];
    lastSession = null;
    viewerGraph.innerHTML = '';
    viewerGraphLegend.innerHTML = '';
    if (isLive) {
      healthChip.textContent = '';
      healthChip.className = 'health-chip';
      healthStats.innerHTML = '';
      healthMessage.classList.add('hidden');
      healthSpark.innerHTML = '';
      healthSparkRange.textContent = '';
      pollStreamHealth();
    }
    loadStreamSession();
  }

  // From pollLiveStatus, every 5s: health each time, the session (graph or
  // summary) every 15s while live and every minute while offline.
  function pollBottomPanels(isLive) {
    bottomPollCount += 1;
    if (isLive) {
      pollStreamHealth();
      if (bottomPollCount % 3 === 0) loadStreamSession();
    } else if (bottomPollCount % 12 === 0) {
      loadStreamSession();
    }
  }

  function pollStreamHealth() {
    var channelId = currentChannelId;
    fetch('/api/channels/' + channelId + '/health', { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (res) {
        if (channelId !== currentChannelId) return;
        renderStreamHealth(res.ok ? res.body : { error: res.body.error });
      })
      .catch(function () { if (channelId === currentChannelId) renderStreamHealth({ error: 'Couldn\'t reach the server.' }); });
  }

  function setHealth(level, chipText, message) {
    healthChip.className = 'health-chip ' + level;
    healthChip.textContent = chipText;
    healthMessage.classList.toggle('hidden', !message);
    healthMessage.classList.toggle('bad', level === 'bad');
    healthMessage.textContent = message || '';
  }

  function renderStreamHealth(h) {
    if (h.error) {
      setHealth('warn', 'Unknown', h.error);
      return;
    }
    if (!h.connected) {
      liveStartedAt = null;
      setHealth('bad', 'No signal', 'The server isn\'t receiving anything from your encoder right now.');
      healthStats.innerHTML = '';
      return;
    }

    var now = Date.now();
    // "Live for" counts up every second between the 5-second checks. Small
    // differences between checks are ignored so it never ticks backwards;
    // a reconnect (a big jump) resets it.
    var started = h.uptimeMs != null ? now - h.uptimeMs : null;
    if (started == null || liveStartedAt == null || Math.abs(started - liveStartedAt) > 3000) liveStartedAt = started;
    bitrateHistory.push({ t: now, kbps: h.bitrateKbps || 0 });
    bitrateHistory = bitrateHistory.filter(function (p) { return now - p.t <= BITRATE_WINDOW_MS; });

    // Compared with its own recent average, since a "good" bitrate depends
    // on the OBS settings.
    var earlier = bitrateHistory.slice(0, -1);
    var average = earlier.length ? earlier.reduce(function (s, p) { return s + p.kbps; }, 0) / earlier.length : 0;
    if (!h.bitrateKbps) {
      setHealth('bad', 'No data', 'Nothing is arriving from your encoder. Check OBS is still streaming and its internet connection is working.');
    } else if (earlier.length >= 6 && h.bitrateKbps < average * 0.6) {
      setHealth('warn', 'Dropping', 'The bitrate has fallen well below its usual level. Check the internet connection where you\'re streaming from.');
    } else {
      setHealth('good', 'Good', '');
    }

    var figures = [
      { label: 'Bitrate', value: formatNumber(h.bitrateKbps || 0) + ' kbps',
        note: h.videoKbps != null ? 'Video ' + formatNumber(h.videoKbps) + ', audio ' + formatNumber(h.audioKbps || 0) : '' },
      { label: 'Live for', value: h.uptimeMs != null ? formatUptime(h.uptimeMs) : '-', id: 'health-uptime' },
    ];
    if (h.width && h.height) {
      figures.push({ label: 'Resolution', value: h.width + ' × ' + h.height,
        note: [h.videoCodec, h.videoProfile].filter(Boolean).join(' ') });
    }
    if (h.fps) figures.push({ label: 'Frame rate', value: Math.round(h.fps) + ' fps' });
    if (h.audioCodec) {
      var audioNote = [];
      if (h.sampleRate) audioNote.push(Math.round(h.sampleRate / 100) / 10 + ' kHz');
      if (h.audioChannels) audioNote.push(h.audioChannels === 1 ? 'mono' : h.audioChannels === 2 ? 'stereo' : h.audioChannels + ' channels');
      figures.push({ label: 'Audio', value: h.audioCodec, note: audioNote.join(', ') });
    }
    fillFigures(healthStats, figures);
    drawBitrateSpark();
  }

  // Like formatSpan, but with seconds: 42s, 10m 05s, 1h 02m 05s.
  function formatUptime(ms) {
    var secs = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = String(secs % 60).padStart(2, '0');
    if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm ' + s + 's';
    if (m) return m + 'm ' + s + 's';
    return (secs % 60) + 's';
  }

  var liveStartedAt = null;
  setInterval(function () {
    var el = document.getElementById('health-uptime');
    if (!el || liveStartedAt == null || streamHealthPanel.classList.contains('hidden')) return;
    el.textContent = formatUptime(Date.now() - liveStartedAt);
  }, 1000);

  function drawBitrateSpark() {
    healthSpark.innerHTML = '';
    if (bitrateHistory.length < 2) {
      healthSparkRange.textContent = 'Filling in…';
      return;
    }
    var values = bitrateHistory.map(function (p) { return p.kbps; });
    var max = Math.max.apply(null, values) || 1;
    var min = Math.min.apply(null, values);
    var t0 = bitrateHistory[0].t;
    var span = Math.max(1, bitrateHistory[bitrateHistory.length - 1].t - t0);
    healthSpark.setAttribute('viewBox', '0 0 100 48');
    var pts = bitrateHistory.map(function (p) {
      return [((p.t - t0) / span) * 100, 46 - (p.kbps / max) * 42];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2); }).join(' ');
    healthSpark.appendChild(svgEl('path', { class: 'area', d: line + ' L100 48 L0 48 Z' }));
    healthSpark.appendChild(svgEl('path', { class: 'line', d: line }));
    healthSparkRange.textContent = formatNumber(min) + ' to ' + formatNumber(max) + ' kbps';
  }

  function loadStreamSession() {
    var channelId = currentChannelId;
    fetch('/api/channels/' + channelId + '/stream-session', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || channelId !== currentChannelId) return;
        lastSession = data.session;
        if (bottomState === 'live:' + channelId) renderLiveGraph();
        else renderLastStream();
      })
      .catch(function () {});
  }

  function renderLiveGraph() {
    drawViewerGraph(viewerGraph, viewerGraphLegend, lastSession, true);
  }

  // The summary of the most recent stream (or an empty state before the
  // first one).
  function renderLastStream() {
    var s = lastSession;
    lastStreamEmpty.classList.toggle('hidden', !!s);
    lastStreamBody.classList.toggle('hidden', !s);
    lastStreamWhen.classList.toggle('hidden', !s);
    if (!s) return;

    var start = new Date(s.startedAt);
    var end = s.endedAt ? new Date(s.endedAt) : new Date();
    lastStreamWhen.textContent = start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
      + ', ' + formatClock(start) + ' to ' + formatClock(end)
      + (s.title ? ' · “' + s.title + '”' : '');

    // Most watching at once, across every source together.
    var peakTotal = 0;
    s.samples.forEach(function (sample) {
      var total = Object.keys(sample.c).reduce(function (sum, id) { return sum + (sample.c[id] || 0); }, 0);
      peakTotal = Math.max(peakTotal, total);
    });

    var figures = [
      { label: 'Length', value: formatSpan(s.durationMs) },
      { label: 'Most watching at once', value: formatNumber(peakTotal), note: 'All sources together' },
      { label: 'Website views', value: formatNumber(s.websiteViews), note: 'Your website and Public Link' },
    ];
    s.platforms.forEach(function (p) {
      figures.push({
        label: p.name + ' views',
        value: p.views != null ? formatNumber(p.views) : 'Counting…',
        note: p.views != null ? 'Keeps updating for 5 weeks' : 'Arrives about 10 minutes after the stream ends',
      });
    });
    fillFigures(lastStreamFigures, figures);
    drawViewerGraph(lastStreamGraph, lastStreamLegend, s, false);
  }

  // One line per source over the course of the stream. Live, the legend
  // shows how many are watching now; afterwards, each source's peak.
  function drawViewerGraph(container, legend, session, live) {
    container.innerHTML = '';
    legend.innerHTML = '';
    if (!session) return;

    var samples = session.samples || [];
    var series = session.sources.map(function (src) {
      var points = [];
      samples.forEach(function (sample) {
        if (sample.c[src.id] != null) points.push({ t: new Date(sample.t).getTime(), v: sample.c[src.id] });
      });
      return { id: src.id, name: src.name, peak: src.peak, points: points, colour: cssVar(SERIES_COLOURS[src.name] || '--slate') };
    }).filter(function (s) { return s.points.length; });

    series.forEach(function (s) {
      var item = document.createElement('span');
      var swatch = document.createElement('i');
      swatch.style.background = s.colour;
      var value = document.createElement('b');
      value.textContent = live ? s.points[s.points.length - 1].v : (s.peak != null ? s.peak : 0);
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(s.name + (live ? ' now ' : ' peak ')));
      item.appendChild(value);
      legend.appendChild(item);
    });

    if (samples.length < 2) {
      var empty = document.createElement('div');
      empty.className = 'viewer-graph-empty';
      empty.textContent = live ? 'The graph fills in as the stream goes on. It updates every minute.' : 'This stream was too short for a graph.';
      container.appendChild(empty);
      return;
    }

    var W = container.clientWidth;
    var H = container.clientHeight;
    if (!W || !H) return;
    var pad = { left: 34, right: 10, top: 8, bottom: 22 };
    var t0 = new Date(session.startedAt).getTime();
    var t1 = live ? Date.now() : (session.endedAt ? new Date(session.endedAt).getTime() : new Date(samples[samples.length - 1].t).getTime());
    t1 = Math.max(t1, t0 + 5 * 60 * 1000);

    var maxV = 0;
    series.forEach(function (s) { s.points.forEach(function (p) { maxV = Math.max(maxV, p.v); }); });
    var step = maxV <= 4 ? 1 : Math.ceil(maxV / 4 / (maxV > 40 ? 10 : maxV > 20 ? 5 : 1)) * (maxV > 40 ? 10 : maxV > 20 ? 5 : 1);
    var yMax = Math.max(4, Math.ceil(maxV / step) * step);

    var x = function (t) { return pad.left + ((t - t0) / (t1 - t0)) * (W - pad.left - pad.right); };
    var y = function (v) { return pad.top + (1 - v / yMax) * (H - pad.top - pad.bottom); };

    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Viewers over the stream, by source' });
    for (var v = 0; v <= yMax; v += step) {
      svg.appendChild(svgEl('line', { class: 'grid', x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v) }));
      var label = svgEl('text', { class: 'axis', x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
      label.textContent = v;
      svg.appendChild(label);
    }

    // Time labels at a round interval, about one per 110px.
    var spanMin = (t1 - t0) / 60000;
    var intervals = [5, 10, 15, 30, 60, 120, 240];
    var wanted = Math.max(1, Math.floor((W - pad.left - pad.right) / 110));
    var every = intervals.find(function (m) { return spanMin / m <= wanted; }) || 480;
    var firstTick = Math.ceil(t0 / (every * 60000)) * every * 60000;
    for (var t = firstTick; t <= t1; t += every * 60000) {
      var tick = svgEl('text', { class: 'axis', x: x(t), y: H - 4, 'text-anchor': 'middle' });
      tick.textContent = formatClock(new Date(t));
      svg.appendChild(tick);
    }

    series.forEach(function (s) {
      var d = s.points.map(function (p, i) { return (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
      svg.appendChild(svgEl('path', { class: 'series', d: d, stroke: s.colour }));
      var last = s.points[s.points.length - 1];
      svg.appendChild(svgEl('circle', { class: 'end-dot', cx: x(last.t), cy: y(last.v), r: 4, fill: s.colour }));
    });
    container.appendChild(svg);
  }

  if (window.ResizeObserver) {
    var graphObserver = new ResizeObserver(function () {
      if (!lastSession) return;
      if (!viewerGraphPanel.classList.contains('hidden')) renderLiveGraph();
      if (!lastStreamPanel.classList.contains('hidden')) drawViewerGraph(lastStreamGraph, lastStreamLegend, lastSession, false);
    });
    graphObserver.observe(viewerGraph);
    graphObserver.observe(lastStreamGraph);
  }

  function viewerPillEl() {
    var pill = document.createElement('span');
    pill.className = 'viewer-pill hidden';
    return pill;
  }

  // Replaces a <select>'s browser dropdown with one styled like the rest of
  // the app. The <select> stays (hidden) as the source of truth: picking an
  // option sets its value and fires 'change' as usual.
  function enhanceSelect(select) {
    var wrap = document.createElement('div');
    wrap.className = 'app-select';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('app-select-native');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary app-select-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (select.getAttribute('aria-label')) btn.setAttribute('aria-label', select.getAttribute('aria-label'));
    var label = document.createElement('span');
    var caret = document.createElement('span');
    caret.className = 'help-menu-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '\u25BE';
    btn.appendChild(label);
    btn.appendChild(caret);
    wrap.appendChild(btn);

    var panel = document.createElement('div');
    panel.className = 'help-menu-panel app-select-panel hidden';
    panel.setAttribute('role', 'listbox');
    wrap.appendChild(panel);

    function syncLabel() {
      var opt = select.options[select.selectedIndex];
      label.textContent = opt ? opt.textContent : '';
    }
    function close(focusBtn) {
      panel.classList.add('hidden');
      wrap.classList.remove('app-select-open');
      btn.setAttribute('aria-expanded', 'false');
      if (focusBtn) btn.focus();
    }
    function open() {
      panel.innerHTML = '';
      Array.prototype.forEach.call(select.options, function (opt) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'app-select-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(opt.value === select.value));
        item.innerHTML = '<span class="app-select-tick" aria-hidden="true">\u2713</span>';
        item.appendChild(document.createTextNode(opt.textContent));
        item.addEventListener('click', function () {
          var changed = select.value !== opt.value;
          select.value = opt.value;
          syncLabel();
          close(true);
          if (changed) select.dispatchEvent(new Event('change'));
        });
        panel.appendChild(item);
      });
      panel.classList.remove('hidden');
      wrap.classList.add('app-select-open');
      btn.setAttribute('aria-expanded', 'true');
      (panel.querySelector('[aria-selected="true"]') || panel.firstChild).focus();
    }

    btn.addEventListener('click', function () {
      if (panel.classList.contains('hidden')) open(); else close(false);
    });
    wrap.addEventListener('keydown', function (e) {
      if (panel.classList.contains('hidden')) {
        if (e.target === btn && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); open(); }
        return;
      }
      var items = Array.prototype.slice.call(panel.children);
      var i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'Tab') close(false);
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target) && !panel.classList.contains('hidden')) close(false);
    });
    select.addEventListener('change', syncLabel);
    syncLabel();
    return wrap;
  }

  function renderPlatformOutput(channel, output) {
    var platform = PLATFORM_OUTPUTS[output.type];
    var node = youtubeOutputRowTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.platformOutputId = output.id;
    node.dataset.viewerOutputId = output.id;
    node.dataset.sortId = output.id;
    node.querySelector('.output-name').textContent = platform.name;
    node.querySelector('.output-name').appendChild(viewerPillEl());
    node.querySelector('.youtube-output-channel').textContent = platform.connectedTo(output) || 'Connected';

    function save(body, onError) {
      return api('/api/channels/' + channel.id + '/outputs/' + output.id, { method: 'PATCH', body: JSON.stringify(body) })
        .then(refreshChannelDetail)
        .catch(function (err) { alert(err.message); onError(); });
    }

    var privacy = node.querySelector('.youtube-privacy-select');
    if (!platform.privacy) privacy.remove();
    privacy.value = output.privacyStatus || 'public';
    privacy.addEventListener('change', function () {
      save({ privacyStatus: privacy.value }, function () {
        privacy.value = output.privacyStatus || 'public';
        privacy.dispatchEvent(new Event('change'));
      });
    });
    if (platform.privacy) enhanceSelect(privacy);

    var toggle = node.querySelector('.output-toggle');
    toggle.checked = !!output.enabled;
    toggle.addEventListener('change', function () {
      save({ enabled: toggle.checked }, function () { toggle.checked = !toggle.checked; });
    });

    // Only two things are shown: the watch link while live, and errors.
    var status = node.querySelector('.youtube-output-status');
    var lastStatus = output.lastStatus;
    var liveUrl = lastStatus && lastStatus.url && output.session ? lastStatus.url : null;
    if (lastStatus && (!lastStatus.ok || liveUrl)) {
      status.classList.remove('hidden');
      status.classList.toggle('error', !lastStatus.ok);
      status.classList.toggle('hint', lastStatus.ok);
      if (lastStatus.ok) {
        status.textContent = 'Live on ' + platform.name;
      } else {
        var when = new Date(lastStatus.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        status.textContent = lastStatus.message + ' (' + when + ')';
      }
      if (liveUrl) {
        var link = document.createElement('a');
        link.href = liveUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Watch on ' + platform.name;
        status.appendChild(document.createTextNode(' - '));
        status.appendChild(link);
      }
    }

    node.querySelector('.output-delete-btn').addEventListener('click', function () {
      if (!confirm('Remove the ' + platform.name + ' output? ' + (platform.connectedTo(output) || platform.name) + ' will be disconnected from this channel.')) return;
      api('/api/channels/' + channel.id + '/outputs/' + output.id, { method: 'DELETE' })
        .then(refreshChannelDetail)
        .catch(function (err) { alert(err.message); });
    });
    return node;
  }

  // YouTube/Facebook statuses change by themselves while going live, so the
  // 5s poll re-renders just those rows (unless one is being interacted with).
  function refreshPlatformOutputs() {
    if (draggingOutput || !detailOutputsList.querySelector('[data-platform-output-id]')) return;
    var channelId = currentChannelId;
    api('/api/channels/' + channelId).then(function (channel) {
      if (channelId !== currentChannelId) return;
      (channel.outputs || []).forEach(function (output) {
        if (!PLATFORM_OUTPUTS[output.type]) return;
        var existing = detailOutputsList.querySelector('[data-platform-output-id="' + output.id + '"]');
        if (!existing || existing.contains(document.activeElement)) return;
        existing.replaceWith(renderPlatformOutput(channel, output));
      });
      applyViewerPills();
    }).catch(function () {});
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

    detailWebsiteToggle.checked = channel.embedEnabled !== false;
    detailWebsiteHint.textContent = channel.embedEnabled !== false
      ? 'Click Website HTML for the code to paste into your website.'
      : 'Off. The player on your website shows as offline, even while you\'re streaming. You can still watch here.';

    detailRecordingToggle.checked = !!channel.recordingEnabled;
    recordingContinueBanner.classList.add('hidden'); // reset on nav - pollLiveStatus re-shows it if still warranted

    var outputs = channel.outputs || [];
    if (websiteOutputRow.parentNode) websiteOutputRow.parentNode.removeChild(websiteOutputRow);
    detailOutputsList.innerHTML = '';
    detailOutputsEmpty.classList.toggle('hidden', outputs.length > 0);
    addOutputTypePublicLinkBtn.disabled = outputs.some(function (o) { return o.type === 'public-link'; });
    addOutputTypeYoutubeBtn.classList.toggle('hidden', !config.youtubeEnabled);
    addOutputTypeFacebookBtn.classList.toggle('hidden', !config.facebookEnabled);
    // Saved order first (see /output-order); anything not in it yet, such
    // as a newly added output, goes at the end. Your website starts on top.
    var savedOrder = channel.outputOrder || [];
    var items = [{ id: 'website' }].concat(outputs);
    function rank(item) {
      var i = savedOrder.indexOf(item.id);
      return i === -1 ? savedOrder.length + items.indexOf(item) : i;
    }
    items.sort(function (x, y) { return rank(x) - rank(y); });
    items.forEach(function (output) {
      if (output.id === 'website') {
        detailOutputsList.appendChild(websiteOutputRow);
        return;
      }
      if (PLATFORM_OUTPUTS[output.type]) {
        detailOutputsList.appendChild(renderPlatformOutput(channel, output));
        return;
      }
      var isPublicLink = output.type === 'public-link';
      // Never rendered as visible text (screen shares, screenshots) - the
      // token in this URL is a real access-control secret now, same trust
      // level as a stream key, so it only ever leaves via the Copy button.
      var publicLinkUrl = embedOrigin() + '/watch/' + channel.id + '/' + output.token;
      var node = outputRowTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.sortId = output.id;
      node.querySelector('.output-name').textContent = isPublicLink ? 'Public Link' : output.name;
      if (isPublicLink) {
        node.dataset.viewerOutputId = output.id;
        node.querySelector('.output-name').appendChild(viewerPillEl());
      }
      // The code font is for RTMP addresses; Public Link's line is a sentence.
      node.querySelector('.output-url').classList.toggle('output-url-text', isPublicLink);
      node.querySelector('.output-url').textContent = isPublicLink
        ? 'Anyone with the link can watch. Click Copy link to share it.'
        : output.rtmpUrl;

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
      if (!isPublicLink) {
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
        var message = isPublicLink
          ? 'Remove the public link? The current link will stop working.'
          : 'Remove output "' + output.name + '"?';
        if (!confirm(message)) return;
        api('/api/channels/' + channel.id + '/outputs/' + output.id, { method: 'DELETE' })
          .then(refreshChannelDetail)
          .catch(function (err) { alert(err.message); });
      });

      detailOutputsList.appendChild(node);
    });
    applyViewerPills();
    allOutputsRow.classList.toggle('hidden', outputs.length < 1);
    syncAllOutputsToggle();

    renderGallery(detailCoverGallery, channel, 'coverImages', 'activeCoverImage', 'covers', 'coverImageNames');
    renderGallery(detailThumbGallery, channel, 'liveThumbnails', 'activeLiveThumbnail', 'live-thumbnails', 'liveThumbnailNames');
    fitDetailExtras();
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

  var recordingsChannelSelect = document.getElementById('recordings-channel-select');
  var recordingsPageList = document.getElementById('recordings-page-list');
  var recordingsPageEmpty = document.getElementById('recordings-page-empty');
  var recordingsListenersWired = false;
  var recordingsNormalContent = document.getElementById('recordings-normal-content');
  var recordingsDisabledNotice = document.getElementById('recordings-disabled-notice');

  var recordingsProcessingPanel = document.getElementById('recordings-processing-panel');
  var recordingsProcessingList = document.getElementById('recordings-processing-list');
  var recordingProcessingRowTemplate = document.getElementById('recording-processing-row-template');

  // Polled independently of the finished-recordings list/filter below -
  // this always shows every channel's in-flight jobs regardless of which
  // channel is selected there, since "what's happening right now" matters
  // site-wide, not just for whichever channel you happen to be filtered to.
  function loadProcessingRecordings() {
    return api('/api/channels/recordings/processing')
      .then(function (jobs) {
        recordingsProcessingList.innerHTML = '';
        recordingsProcessingPanel.classList.toggle('hidden', jobs.length === 0);
        jobs.forEach(function (job) {
          var node = recordingProcessingRowTemplate.content.firstElementChild.cloneNode(true);
          node.querySelector('.recording-processing-channel').textContent = job.channelName;
          var stageLabel = node.querySelector('.recording-processing-stage');
          var fill = node.querySelector('.recording-processing-bar-fill');
          if (job.stage === 'failed') {
            var when = job.recordingStartedAt ? 'Recorded ' + formatPlayDate(job.recordingStartedAt) + ': ' : '';
            stageLabel.textContent = when + "couldn't be saved after " + job.attempts + ' attempts' +
              (job.error ? ' (' + job.error + ')' : '') + '. The raw file is still on the server.';
            node.querySelector('.recording-processing-bar-track').classList.add('hidden');
          } else if (job.stage === 'uploading' && typeof job.progressPercent === 'number') {
            stageLabel.textContent = 'Uploading: ' + job.progressPercent + '%';
            fill.style.width = job.progressPercent + '%';
          } else {
            stageLabel.textContent = 'Converting recording…';
            fill.classList.add('indeterminate');
          }
          recordingsProcessingList.appendChild(node);
        });
      })
      .catch(function () {}); // background status poll - a blip here isn't worth interrupting anyone over
  }

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
      var titleText = recording.title || recording.channelName || 'Recording';
      if (recording.description) titleText += ' - ' + recording.description;
      node.querySelector('.recording-title').textContent = titleText;
      var metaParts = [when.toLocaleString()];
      if (!channelId && recording.channelName) metaParts.push(recording.channelName);
      if (recording.durationSeconds) metaParts.push(formatDuration(recording.durationSeconds));
      metaParts.push(formatBytes(recording.sizeBytes));
      node.querySelector('.recording-meta').textContent = metaParts.join(' · ');

      node.querySelector('.recording-download-btn').addEventListener('click', function () {
        api('/api/channels/' + recordingChannelId + '/recordings/' + recording.id + '/url?download=1')
          .then(function (data) { window.open(data.url, '_blank'); })
          .catch(function (err) { alert(err.message); });
      });

      node.querySelector('.recording-delete-btn').addEventListener('click', function () {
        if (!confirm('Delete this recording? This can\'t be undone.')) return;
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

    wireOutputReordering();
    wireGalleryReordering(detailThumbGallery, 'live-thumbnails');

    detailOutputsList.addEventListener('change', function (e) {
      if (e.target.type === 'checkbox') syncAllOutputsToggle();
    });
    allOutputsToggle.addEventListener('change', function () {
      var enabled = allOutputsToggle.checked;
      detailOutputsList.querySelectorAll('input[type="checkbox"]').forEach(function (s) { s.checked = enabled; });
      api('/api/channels/' + currentChannelId + '/all-outputs', { method: 'PATCH', body: JSON.stringify({ enabled: enabled }) })
        .then(refreshChannelDetail)
        .catch(function (err) { alert(err.message); refreshChannelDetail(); });
    });

    websiteHtmlBtn.addEventListener('click', function () {
      websiteHtmlModalBackdrop.classList.remove('hidden');
    });
    websiteHtmlCloseBtn.addEventListener('click', function () {
      websiteHtmlModalBackdrop.classList.add('hidden');
    });
    websiteHtmlModalBackdrop.addEventListener('click', function (e) {
      if (e.target === websiteHtmlModalBackdrop) websiteHtmlModalBackdrop.classList.add('hidden');
    });
    wireCopyButtons(websiteHtmlModalBackdrop);

    thumbPickerSkipBtn.addEventListener('click', function () {
      dismissThumbPopup(currentChannelId);
    });

    thumbPickerUploadInput.addEventListener('change', function (e) {
      uploadThumbFromPopup(e.target.files[0]);
    });

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
      if (!confirm('Delete the channel "' + detailName.textContent + '"? This can\'t be undone.')) return;
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
      if (!confirm('Make a new stream key? Anything streaming with the old key right now will be cut off.')) return;
      api('/api/channels/' + currentChannelId + '/regenerate-key', { method: 'POST' })
        .then(refreshChannelDetail)
        .catch(function (err) { alert(err.message); });
    });

    detailWebsiteToggle.addEventListener('change', function () {
      if (!detailWebsiteToggle.checked
        && !confirm('Switch off the player on your website? Visitors will see it as offline, even while you\'re streaming, until you switch it back on.')) {
        detailWebsiteToggle.checked = true;
        return;
      }
      api('/api/channels/' + currentChannelId + '/website-settings', {
        method: 'PATCH',
        body: JSON.stringify({ embedEnabled: detailWebsiteToggle.checked }),
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

    imageRenameCancelBtn.addEventListener('click', closeImageRenameModal);
    imageRenameModalBackdrop.addEventListener('click', function (e) {
      if (e.target === imageRenameModalBackdrop) closeImageRenameModal();
    });
    imageRenameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') imageRenameSaveBtn.click();
      if (e.key === 'Escape') closeImageRenameModal();
    });
    imageRenameSaveBtn.addEventListener('click', function () {
      if (!imageRenameTarget) return;
      var routeSegment = imageRenameTarget.routeSegment;
      var filename = imageRenameTarget.filename;
      api('/api/channels/' + currentChannelId + '/' + routeSegment + '/' + encodeURIComponent(filename) + '/name', {
        method: 'POST',
        body: JSON.stringify({ name: imageRenameInput.value }),
      })
        .then(function () {
          closeImageRenameModal();
          return refreshChannelDetail();
        })
        .catch(function (err) { alert(err.message); });
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

    var addOutputBackBtn = document.getElementById('add-output-back-btn');

    // Back to the list of output types (from the Custom RTMP form).
    function showAddOutputTypes() {
      addOutputRtmpForm.reset();
      addOutputRtmpForm.classList.add('hidden');
      addOutputBackBtn.classList.add('hidden');
      addOutputTypeRow.classList.remove('hidden');
    }

    function closeAddOutputModal() {
      addOutputModalBackdrop.classList.add('hidden');
      showAddOutputTypes();
    }
    addOutputBackBtn.addEventListener('click', showAddOutputTypes);

    addOutputBtn.addEventListener('click', function () {
      addOutputModalBackdrop.classList.remove('hidden');
    });
    addOutputCancelBtn.addEventListener('click', closeAddOutputModal);
    addOutputModalBackdrop.addEventListener('click', function (e) {
      if (e.target === addOutputModalBackdrop) closeAddOutputModal();
    });
    addOutputTypeRtmpBtn.addEventListener('click', function () {
      addOutputTypeRow.classList.add('hidden');
      addOutputRtmpForm.classList.remove('hidden');
      addOutputBackBtn.classList.remove('hidden');
      document.getElementById('new-output-name').focus();
    });
    addOutputTypeFacebookBtn.addEventListener('click', function () {
      // Off to Facebook's sign-in; it comes back to this channel page.
      window.location.href = '/api/facebook/connect?channelId=' + encodeURIComponent(currentChannelId);
    });
    facebookPageCancelBtn.addEventListener('click', function () {
      facebookPageModalBackdrop.classList.add('hidden');
    });
    addOutputTypeYoutubeBtn.addEventListener('click', function () {
      // Off to Google's sign-in; it comes back to this channel page.
      window.location.href = '/api/youtube/connect?channelId=' + encodeURIComponent(currentChannelId);
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

    // Upload buttons open their hidden file picker.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-file-input]');
      if (btn) document.getElementById(btn.dataset.fileInput).click();
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
      // The page itself still works via a direct link/bookmark (showing the
      // same disabled notice as always - see route()'s 'recordings' branch) -
      // just no point advertising it in the nav when there's nothing to see.
      document.getElementById('recordings-btn').classList.toggle('hidden', !cfg.recordingsEnabled);
      // Same for the channel page's "Record streams" switch: hidden rather
      // than shown and refused when recording is off (RECORDINGS_ENABLED=false
      // or R2 not configured).
      document.getElementById('recording-toggle-panel').classList.toggle('hidden', !cfg.recordingsEnabled);
      route();
    });
  }

  // ===================== Help dropdown =====================
  var helpMenuBtn = document.getElementById('help-menu-btn');
  var helpMenuPanel = document.getElementById('help-menu-panel');

  function closeHelpMenu() {
    helpMenuPanel.classList.add('hidden');
    helpMenuBtn.classList.remove('help-menu-btn-open');
    helpMenuBtn.setAttribute('aria-expanded', 'false');
  }
  function openHelpMenu() {
    helpMenuPanel.classList.remove('hidden');
    helpMenuBtn.classList.add('help-menu-btn-open');
    helpMenuBtn.setAttribute('aria-expanded', 'true');
  }
  helpMenuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (helpMenuPanel.classList.contains('hidden')) openHelpMenu();
    else closeHelpMenu();
  });
  // Any click elsewhere on the page (including a route change triggered by
  // one of this menu's own links) closes it - without this it'd stay open
  // hovering over whatever view you just navigated to.
  document.addEventListener('click', closeHelpMenu);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeHelpMenu();
  });

  logoutBtn.addEventListener('click', function () {
    // A real navigation, not a fetch - /auth/logout destroys the local
    // session then redirects through Auth0's own logout endpoint (clearing
    // Auth0's SSO session too, so logging back in actually re-prompts
    // instead of silently reusing it), which only works as a browser
    // redirect, not an XHR/fetch call.
    window.location.href = '/auth/logout';
  });

  api('/api/me').then(function (data) {
    if (data.authenticated) {
      document.getElementById('footer-account').textContent = '\u00b7 Signed in as ' + data.email;
      enterDashboard();
    } else {
      window.location.href = '/login';
    }
  });
})();
