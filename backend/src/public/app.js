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
      checkRestreamStatus();
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

  var statsRestreamStatusText = document.getElementById('stats-restream-status-text');
  var statsPlatformsStatusText = document.getElementById('stats-platforms-status-text');
  var statsPlatformsRefreshBtn = document.getElementById('stats-platforms-refresh-btn');
  var statsRestreamConnectBtn = document.getElementById('stats-restream-connect-btn');
  var statsRestreamImportBtn = document.getElementById('stats-restream-import-btn');
  var statsRestreamDisconnectBtn = document.getElementById('stats-restream-disconnect-btn');

  var restreamImportModalBackdrop = document.getElementById('restream-import-modal-backdrop');
  var restreamImportFrom = document.getElementById('restream-import-from');
  var restreamImportTo = document.getElementById('restream-import-to');
  var restreamImportTodayBtn = document.getElementById('restream-import-today-btn');
  var restreamImportPreviewBtn = document.getElementById('restream-import-preview-btn');
  var restreamImportEmpty = document.getElementById('restream-import-empty');
  var restreamImportPreviewWrap = document.getElementById('restream-import-preview-wrap');
  var restreamImportPreviewBody = document.getElementById('restream-import-preview-body');
  var restreamImportPreviewRowTemplate = document.getElementById('restream-import-preview-row-template');
  var restreamImportSelectAllCheckbox = document.getElementById('restream-import-select-all');
  var restreamImportCancelBtn = document.getElementById('restream-import-cancel-btn');
  var restreamImportCommitBtn = document.getElementById('restream-import-commit-btn');
  // The preview's own working copy - each item's channelId can be edited
  // in place (via a row's channel <select>, for anything the automatic
  // match missed) before commit sends this same array back.
  var restreamPreviewItems = [];
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

  function checkRestreamStatus() {
    return api('/api/restream/status').then(function (data) {
      statsRestreamConnectBtn.classList.toggle('hidden', data.connected);
      statsRestreamImportBtn.classList.toggle('hidden', !data.connected);
      statsRestreamDisconnectBtn.classList.toggle('hidden', !data.connected);
      statsRestreamStatusText.textContent = data.connected
        ? 'Restream connected'
        : 'Restream isn\'t connected. Connect it to import YouTube and Facebook view counts.';
    }).catch(function () {
      statsRestreamStatusText.textContent = 'Couldn\'t check whether Restream is connected.';
    });
  }

  function openRestreamImportModal() {
    restreamImportFrom.value = '';
    restreamImportTo.value = '';
    restreamImportEmpty.classList.add('hidden');
    restreamImportPreviewWrap.classList.add('hidden');
    restreamImportCommitBtn.classList.add('hidden');
    restreamImportPreviewBody.innerHTML = '';
    restreamPreviewItems = [];
    restreamImportModalBackdrop.classList.remove('hidden');
  }

  function closeRestreamImportModal() {
    restreamImportModalBackdrop.classList.add('hidden');
  }

  function formatPreviewDate(iso) {
    return iso ? new Date(iso).toLocaleString() : '';
  }

  // Keeps the header checkbox in sync with the individual row checkboxes -
  // checked when every row is included, indeterminate when some but not
  // all are, unchecked when none are (or there are no rows at all).
  function updateRestreamSelectAllUi() {
    var includedCount = restreamPreviewItems.filter(function (item) { return item.included !== false; }).length;
    restreamImportSelectAllCheckbox.checked = restreamPreviewItems.length > 0 && includedCount === restreamPreviewItems.length;
    restreamImportSelectAllCheckbox.indeterminate = includedCount > 0 && includedCount < restreamPreviewItems.length;
  }

  function renderRestreamPreview() {
    restreamImportPreviewBody.innerHTML = '';
    restreamImportEmpty.classList.toggle('hidden', restreamPreviewItems.length > 0);
    restreamImportPreviewWrap.classList.toggle('hidden', restreamPreviewItems.length === 0);
    restreamImportCommitBtn.classList.toggle('hidden', restreamPreviewItems.length === 0);
    updateRestreamSelectAllUi();

    restreamPreviewItems.forEach(function (item, index) {
      var row = restreamImportPreviewRowTemplate.content.firstElementChild.cloneNode(true);
      var includeCheckbox = row.querySelector('.restream-preview-include');
      includeCheckbox.checked = item.included !== false;
      includeCheckbox.addEventListener('change', function () {
        restreamPreviewItems[index].included = includeCheckbox.checked;
        updateRestreamSelectAllUi();
      });
      row.querySelector('.restream-preview-date').textContent = formatPreviewDate(item.startedAt);
      row.querySelector('.restream-preview-title').textContent = item.restreamTitle || '';
      row.querySelector('.restream-preview-youtube').textContent = item.youtubeViews || 0;
      row.querySelector('.restream-preview-facebook').textContent = item.facebookViews || 0;

      var label = row.querySelector('.restream-preview-channel-label');
      var select = row.querySelector('.restream-preview-channel-select');
      if (item.channelId) {
        label.textContent = item.channelName || '';
      } else {
        label.classList.add('hidden');
        select.classList.remove('hidden');
        select.classList.add('needs-pick');
        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Pick a channel…';
        select.appendChild(placeholder);
        statsChannelsCache.forEach(function (c) {
          var opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = c.name;
          select.appendChild(opt);
        });
        select.addEventListener('change', function () {
          restreamPreviewItems[index].channelId = select.value || null;
          select.classList.toggle('needs-pick', !select.value);
        });
      }

      restreamImportPreviewBody.appendChild(row);
    });
  }

  function previewRestreamImport() {
    if (!restreamImportFrom.value || !restreamImportTo.value) {
      alert('Choose a From date and a To date first.');
      return;
    }
    restreamImportPreviewBtn.disabled = true;
    api('/api/stats/restream/preview', {
      method: 'POST',
      body: JSON.stringify({
        from: restreamImportFrom.value,
        to: restreamImportTo.value + 'T23:59:59.999',
      }),
    }).then(function (data) {
      restreamPreviewItems = data.items;
      renderRestreamPreview();
    }).catch(function (err) {
      alert(err.message);
    }).then(function () {
      restreamImportPreviewBtn.disabled = false;
    });
  }

  function commitRestreamImport() {
    var itemsToImport = restreamPreviewItems.filter(function (item) { return item.included !== false; });
    if (!itemsToImport.length) {
      alert('Tick at least one stream to import.');
      return;
    }
    restreamImportCommitBtn.disabled = true;
    api('/api/stats/restream/import', {
      method: 'POST',
      body: JSON.stringify({ items: itemsToImport }),
    }).then(function (result) {
      closeRestreamImportModal();
      return loadStats().then(function () {
        var msg = 'Imported ' + result.importedCount + ' row' + (result.importedCount === 1 ? '' : 's') + ' from ' + result.itemCount + ' stream' + (result.itemCount === 1 ? '' : 's') + '.';
        var skipped = result.skippedNoChannel + result.skippedNoViews;
        if (skipped) {
          msg += ' Skipped ' + skipped + ': ' + result.skippedNoChannel + ' didn\'t match a channel and ' + result.skippedNoViews + ' had no views.';
        }
        alert(msg);
      });
    }).catch(function (err) {
      alert(err.message);
    }).then(function () {
      restreamImportCommitBtn.disabled = false;
    });
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

    statsRestreamDisconnectBtn.addEventListener('click', function () {
      if (!confirm('Disconnect Restream? You can connect it again at any time, and rows you\'ve already imported stay.')) return;
      api('/api/restream/disconnect', { method: 'POST' })
        .then(checkRestreamStatus)
        .catch(function (err) { alert(err.message); });
    });
    statsRestreamImportBtn.addEventListener('click', openRestreamImportModal);
    restreamImportCancelBtn.addEventListener('click', closeRestreamImportModal);
    restreamImportModalBackdrop.addEventListener('click', function (e) {
      if (e.target === restreamImportModalBackdrop) closeRestreamImportModal();
    });
    restreamImportTodayBtn.addEventListener('click', function () {
      var d = new Date();
      var today = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      restreamImportFrom.value = today;
      restreamImportTo.value = today;
    });
    restreamImportPreviewBtn.addEventListener('click', previewRestreamImport);
    restreamImportCommitBtn.addEventListener('click', commitRestreamImport);
    restreamImportSelectAllCheckbox.addEventListener('change', function () {
      var checked = restreamImportSelectAllCheckbox.checked;
      restreamPreviewItems.forEach(function (item) { item.included = checked; });
      var rowCheckboxes = restreamImportPreviewBody.querySelectorAll('.restream-preview-include');
      for (var i = 0; i < rowCheckboxes.length; i++) rowCheckboxes[i].checked = checked;
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

  function viewerPillEl() {
    var pill = document.createElement('span');
    pill.className = 'viewer-pill hidden';
    return pill;
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
      save({ privacyStatus: privacy.value }, function () { privacy.value = output.privacyStatus || 'public'; });
    });

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
    addOutputTypeRtmpBtn.addEventListener('click', function () {
      addOutputTypeRow.classList.add('hidden');
      addOutputRtmpForm.classList.remove('hidden');
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
