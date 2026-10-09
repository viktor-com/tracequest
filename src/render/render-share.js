import { secretRulesJson } from "../share/secret-rules.js";
import { buildScannerRedactorSrc } from "../share/share-bundle.js";
import { OVERLAY_FOCUS_SRC } from "../browser/overlay-focus.js";

const SCANNER_REDACTOR_SRC = buildScannerRedactorSrc();

export const SHARE_JS = `
  ${OVERLAY_FOCUS_SRC}

  const SECRET_RULES = ${secretRulesJson()};

  ${SCANNER_REDACTOR_SRC}

  const GH_LS_KEY = 'tracequest-gh-token';
  const HF_LS_KEY = 'tracequest-hf-token';
  const HF_REPO_LS_KEY = 'tracequest-hf-repo';
  const HF_PREUPLOAD_THRESHOLD = 1048576;

  function sanitizePathSegment(seg) {
    var s = String(seg || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
    return s || 'unknown';
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function isAllowedApexHost(hostname, apex) {
    if (hostname === apex) return true;
    var suffix = '.' + apex;
    if (hostname.slice(-suffix.length) !== suffix) return false;
    var sub = hostname.slice(0, -suffix.length);
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(sub);
  }

  function buildGistHostPreviewUrl(gistId, filename) {
    if (!gistId) return null;
    var base = 'https://gisthost.github.io/?' + gistId;
    if (filename && filename !== 'index.html') return base + '/' + filename;
    return base;
  }

  function isAllowedShareUrl(url) {
    try {
      var u = new URL(url);
      return u.protocol === 'https:' && (
        u.hostname === 'gisthost.github.io' ||
        isAllowedApexHost(u.hostname, 'gist.github.com') ||
        isAllowedApexHost(u.hostname, 'huggingface.co')
      );
    } catch (e) { return false; }
  }

  function showShareSuccess(statusEl, url, secondaryUrl) {
    if (!url || typeof url !== 'string') {
      statusEl.className = 'hf-modal-status hf-error';
      statusEl.textContent = 'Share succeeded but no preview URL was returned';
      return;
    }
    statusEl.className = 'hf-modal-status hf-success';
    statusEl.textContent = '';
    statusEl.appendChild(document.createTextNode('Shared! '));
    if (isAllowedShareUrl(url)) {
      var link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url;
      statusEl.appendChild(link);
    } else {
      statusEl.appendChild(document.createTextNode(url));
    }
    if (secondaryUrl && isAllowedShareUrl(secondaryUrl)) {
      statusEl.appendChild(document.createTextNode(' ('));
      var secondaryLink = document.createElement('a');
      secondaryLink.href = secondaryUrl;
      secondaryLink.target = '_blank';
      secondaryLink.rel = 'noopener noreferrer';
      secondaryLink.textContent = 'raw gist';
      statusEl.appendChild(secondaryLink);
      statusEl.appendChild(document.createTextNode(')'));
    }
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'hf-modal-cancel';
    copyBtn.style.marginLeft = '8px';
    copyBtn.textContent = 'Copy URL';
    copyBtn.addEventListener('click', function() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function() {
          copyBtn.textContent = 'Copied!';
        }).catch(function() {});
      }
    });
    statusEl.appendChild(copyBtn);
  }

  function shareGist(html, meta, token, isPrivate) {
    var sessionId = meta.sessionHash || meta.sessionId || 'session';
    var source = meta.source || 'claude';
    var filename = 'tracequest-' + sanitizePathSegment(source) + '-' + sanitizePathSegment(sessionId.slice(0, 8)) + '.html';
    var description = source + ' session — ' + (meta.firstPrompt || '(no prompt)') + ' (' + (meta.model || 'unknown') + ', ' + (meta.durationFormatted || '—') + ')';
    return fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        description: description,
        public: !isPrivate,
        files: { [filename]: { content: html } },
      }),
    }).then(function(res) {
      if (!res.ok) return res.text().then(function(t) { throw new Error('Gist upload failed (' + res.status + '): ' + t); });
      return res.json();
    }).then(function(data) {
      if (!data || !data.id) throw new Error('Gist upload succeeded but response missing id');
      // gistUrl matches Node adapter url field (raw GitHub gist, not gisthost preview).
      return {
        previewUrl: buildGistHostPreviewUrl(data.id, filename),
        gistUrl: data.html_url,
      };
    });
  }

  function hfPreuploadFile(namespace, repoName, path, content, token) {
    var size = new Blob([content]).size;
    var sample = content.slice(0, 512);
    return fetch('https://huggingface.co/api/datasets/' + namespace + '/' + repoName + '/preupload/main', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: path, size: size, sample: sample }] }),
    }).then(function(res) {
      if (!res.ok) return res.text().then(function(t) { throw new Error('HF preupload failed: ' + t); });
      return res.json();
    }).then(function(data) {
      var info = data.files && data.files[0];
      if (!info || !info.uploadUrl) throw new Error('HF preupload missing uploadUrl');
      return fetch(info.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content,
      }).then(function(putRes) {
        if (!putRes.ok) throw new Error('HF preupload PUT failed');
        return { operation: 'addOrUpdate', path: path, oid: info.oid };
      });
    });
  }

  function hfFileOp(namespace, repoName, path, content, token) {
    var size = new Blob([content]).size;
    if (size >= HF_PREUPLOAD_THRESHOLD) {
      return hfPreuploadFile(namespace, repoName, path, content, token);
    }
    return Promise.resolve({ operation: 'addOrUpdate', path: path, content: content });
  }

  function resolveHfRepo(token, repoInput) {
    if (repoInput && repoInput.trim()) return Promise.resolve(repoInput.trim());
    return fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: 'Bearer ' + token },
    }).then(function(res) {
      if (!res.ok) throw new Error('HF whoami failed');
      return res.json();
    }).then(function(data) {
      var name = data.name || data.fullname;
      if (!name) throw new Error('Could not resolve HF username');
      return name + '/tracequest-sessions';
    });
  }

  function shareHf(html, sidecar, token, repo, isPrivate) {
    return resolveHfRepo(token, repo).then(function(targetRepo) {
      var parts = targetRepo.split('/').filter(Boolean);
      if (parts.length !== 2) throw new Error('HF repo must be namespace/repo');
      var namespace = parts[0];
      var repoName = parts[1];
      var source = sanitizePathSegment(sidecar.source || 'claude');
      var sessionId = sanitizePathSegment(sidecar.sessionHash || sidecar.sessionId || 'session');
      var htmlPath = 'sessions/' + source + '/' + sessionId + '.html';
      var jsonPath = 'sessions/' + source + '/' + sessionId + '.json';
      var readme = '---\\nlicense: mit\\ntags:\\n- agent-traces\\n- tracequest\\ntask_categories:\\n- text-generation\\n---\\n\\n# tracequest sessions\\n';

      function commit(ops) {
        return fetch('https://huggingface.co/api/datasets/' + namespace + '/' + repoName + '/commit/main', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: ops }),
        });
      }

      var username = namespace;
      return fetch('https://huggingface.co/api/whoami-v2', {
        headers: { Authorization: 'Bearer ' + token },
      }).then(function(w) { return w.ok ? w.json() : {}; }).then(function(who) {
        username = who.name || who.fullname || namespace;
        return fetch('https://huggingface.co/api/datasets/' + namespace + '/' + repoName, {
          headers: { Authorization: 'Bearer ' + token },
        });
      }).then(function(res) {
        var isNew = !res.ok;
        var chain = Promise.resolve();
        if (isNew) {
          var createBody = { name: repoName, type: 'dataset', private: !!isPrivate };
          if (namespace !== username) createBody.organization = namespace;
          chain = fetch('https://huggingface.co/api/repos/create', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(createBody),
          }).then(function(r) {
            if (!r.ok) return r.text().then(function(t) { throw new Error('HF repo create failed: ' + t); });
          });
        }
        return chain.then(function() {
          return Promise.all([
            hfFileOp(namespace, repoName, htmlPath, html, token),
            hfFileOp(namespace, repoName, jsonPath, JSON.stringify(sidecar, null, 2), token),
          ]).then(function(ops) {
            if (isNew) ops.push({ operation: 'addOrUpdate', path: 'README.md', content: readme });
            return commit(ops);
          });
        }).then(function(r) {
          if (!r.ok) return r.text().then(function(t) { throw new Error('HF commit failed: ' + t); });
          return 'https://huggingface.co/datasets/' + namespace + '/' + repoName + '/blob/main/' + htmlPath;
        });
      });
    });
  }

  function buildShareSidecar(sess) {
    var chapters = typeof buildSessionChapters === 'function' ? buildSessionChapters(sess) : [];
    var filePaths = [];
    if (typeof chapterFileKeys === 'function') {
      for (var i = 0; i < chapters.length; i++) {
        var keys = chapterFileKeys(chapters[i]);
        for (var j = 0; j < keys.length; j++) {
          if (filePaths.indexOf(keys[j]) < 0) filePaths.push(keys[j]);
        }
      }
    }
    var stats = sess.stats || {};
    var firstPrompt = '';
    for (var k = 0; k < (sess.events || []).length; k++) {
      if (sess.events[k].type === 'user' && sess.events[k].text) {
        firstPrompt = typeof safeSlice === 'function' ? safeSlice(sess.events[k].text, FIRST_PROMPT_MAX_LEN) : sess.events[k].text.slice(0, 200);
        break;
      }
    }
    return {
      sessionId: sess.sessionId,
      sessionHash: sess.sessionHash,
      source: sess.source || 'claude',
      model: sess.model || '',
      project: sess.cwd || '',
      firstPrompt: firstPrompt,
      eventCount: sess.eventCount || (sess.events ? sess.events.length : 0),
      errorCount: stats.errors || 0,
      tools: Object.keys(stats.toolCounts || {}),
      filePaths: filePaths,
      gitBranch: sess.gitBranch || null,
      costEstimate: typeof estimateParsedStatsCost === 'function' ? estimateParsedStatsCost(sess.model, stats) : 0,
      chapterCount: chapters.length,
    };
  }

  function clientRenderHTML(redactedSession) {
    var cssEl = document.querySelector('style');
    var css = cssEl ? cssEl.textContent : '';
    var scripts = document.getElementsByTagName('script');
    var renderJs = '';
    for (var i = 0; i < scripts.length; i++) {
      var txt = scripts[i].textContent || '';
      var marker = 'const SESSION = ';
      var idx = txt.indexOf(marker);
      if (idx >= 0) {
        var after = txt.indexOf(';', idx);
        if (after >= 0) renderJs = txt.slice(after + 1);
        break;
      }
    }
    var sid = escHtml(redactedSession.sessionHash || (redactedSession.sessionId || 'session').slice(0, 8));
    var data = JSON.stringify(redactedSession).replace(/<\\//g, '<\\\\/');
    return '<!DOCTYPE html>\\n<html lang="en">\\n<head>\\n<meta charset="utf-8">\\n<meta name="viewport" content="width=device-width, initial-scale=1">\\n<title>tracequest — ' + sid + '</title>\\n<style>\\n' + css + '\\n</style>\\n</head>\\n<body>\\n<div id="app"></div>\\n<script>\\nconst SESSION = ' + data + ';\\n' + renderJs + '\\n</scr' + 'ipt>\\n</body>\\n</html>';
  }

  var shareModalEl = null;
  var sharePrevFocus = null;
  var shareKeyHandler = null;

  function closeShareModal() {
    if (shareKeyHandler) {
      document.removeEventListener('keydown', shareKeyHandler, true);
      shareKeyHandler = null;
    }
    if (!shareModalEl) return;
    var dying = shareModalEl;
    dying.hidden = true;
    popOverlay(dying);
    if (dying.parentNode) dying.parentNode.removeChild(dying);
    shareModalEl = null;
    restoreOverlayFocus(sharePrevFocus, dying);
    sharePrevFocus = null;
  }

  function openShareModal() {
    var prev = overlayPrevFocus(shareModalEl);
    if (!prev) prev = document.activeElement;
    closeShareModal();
    sharePrevFocus = prev;
    var target = 'gist';
    var overlay = h('div', { className: 'hf-modal-overlay', id: 'hfModalOverlay', tabindex: '-1' });
    shareModalEl = overlay;

    var modal = h('div', { className: 'hf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hfModalTitle' });
    modal.appendChild(h('div', { className: 'hf-modal-title', id: 'hfModalTitle' }, 'Share session'));

    var targetRow = h('div', { style: 'display:flex;gap:12px;margin-bottom:8px;' });
    var gistRadio = h('input', { type: 'radio', name: 'share-target' });
    gistRadio.value = 'gist';
    gistRadio.checked = true;
    var hfRadio = h('input', { type: 'radio', name: 'share-target' });
    hfRadio.value = 'hf';
    targetRow.appendChild(h('label', null, gistRadio, ' Gist'));
    targetRow.appendChild(h('label', null, hfRadio, ' HF'));
    modal.appendChild(targetRow);

    modal.appendChild(h('label', { className: 'hf-modal-label' }, 'Access token'));
    var tokenInput = h('input', { className: 'hf-modal-input', type: 'password', placeholder: 'GitHub or Hugging Face token' });
    tokenInput.value = localStorage.getItem(GH_LS_KEY) || '';
    modal.appendChild(tokenInput);
    modal.appendChild(h('div', { className: 'hf-modal-hint' }, 'Saved locally in your browser'));

    modal.appendChild(h('label', { className: 'hf-modal-label' }, 'HF dataset repo (namespace/repo)'));
    var repoInput = h('input', { className: 'hf-modal-input', type: 'text', placeholder: 'username/tracequest-sessions (optional — defaults via whoami)' });
    repoInput.value = localStorage.getItem(HF_REPO_LS_KEY) || '';
    repoInput.style.display = 'none';
    modal.appendChild(repoInput);

    var privateRow = h('label', { style: 'display:flex;align-items:center;gap:6px;margin-top:12px;font-size:12px;color:var(--text-2);' });
    var privateChk = h('input', { type: 'checkbox' });
    privateRow.appendChild(privateChk);
    privateRow.appendChild(document.createTextNode('Private (secret gist / private HF repo)'));
    modal.appendChild(privateRow);
    var privateHint = h('div', { className: 'hf-modal-hint', style: 'display:none;margin-top:4px;' }, 'Secret gists: gisthost previews require GitHub sign-in; use the raw gist link if needed.');
    modal.appendChild(privateHint);

    var findingsPanel = h('div', { className: 'hf-modal-status', style: 'color:var(--warn);' });
    findingsPanel.style.display = 'none';
    modal.appendChild(findingsPanel);

    var confirmRow = h('label', { style: 'display:none;align-items:center;gap:6px;margin-top:8px;font-size:12px;color:var(--text-2);' });
    var confirmChk = h('input', { type: 'checkbox' });
    confirmRow.appendChild(confirmChk);
    confirmRow.appendChild(document.createTextNode('I understand — share anyway'));
    modal.appendChild(confirmRow);

    var statusEl = h('div', { className: 'hf-modal-status' });
    modal.appendChild(statusEl);

    var spinnerEl = h('span', { className: 'hf-modal-hint', style: 'display:none;margin-left:6px;' }, '⏳');
    statusEl.appendChild(spinnerEl);

    var actions = h('div', { className: 'hf-modal-actions' });
    var cancelBtn = h('button', { className: 'hf-modal-cancel', type: 'button' }, 'Cancel');
    var shareBtn = h('button', { className: 'hf-modal-share', type: 'button' }, 'Share');
    actions.appendChild(cancelBtn);
    actions.appendChild(shareBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    function updatePrivateHint() {
      privateHint.style.display = privateChk.checked && gistRadio.checked ? 'block' : 'none';
    }

    function updateTarget() {
      target = gistRadio.checked ? 'gist' : 'hf';
      repoInput.style.display = target === 'hf' ? 'block' : 'none';
      tokenInput.value = localStorage.getItem(target === 'gist' ? GH_LS_KEY : HF_LS_KEY) || '';
      updatePrivateHint();
      scanPreview();
    }

    function scanPreview() {
      var findings = scanSessionForSecrets(session, SECRET_RULES);
      if (findings.length === 0) {
        findingsPanel.style.display = 'none';
        confirmRow.style.display = 'none';
        shareBtn.disabled = false;
        return;
      }
      findingsPanel.style.display = 'block';
      confirmRow.style.display = 'flex';
      findingsPanel.textContent = findings.length + ' potential secret(s) detected. Confirm to enable Share.';
      shareBtn.disabled = !confirmChk.checked;
    }

    gistRadio.addEventListener('change', updateTarget);
    hfRadio.addEventListener('change', updateTarget);
    privateChk.addEventListener('change', updatePrivateHint);
    confirmChk.addEventListener('change', function() { shareBtn.disabled = !confirmChk.checked; });
    tokenInput.addEventListener('input', function() {
      localStorage.setItem(target === 'gist' ? GH_LS_KEY : HF_LS_KEY, tokenInput.value);
    });
    repoInput.addEventListener('input', function() {
      localStorage.setItem(HF_REPO_LS_KEY, repoInput.value);
    });

    cancelBtn.addEventListener('click', closeShareModal);
    overlay.addEventListener('click', function(ev) { if (ev.target === overlay) closeShareModal(); });

    shareBtn.addEventListener('click', function() {
      var token = tokenInput.value.trim();
      if (!token) {
        statusEl.className = 'hf-modal-status hf-error';
        statusEl.textContent = 'Token required';
        return;
      }
      localStorage.setItem(target === 'gist' ? GH_LS_KEY : HF_LS_KEY, token);
      if (target === 'hf' && repoInput.value.trim()) {
        localStorage.setItem(HF_REPO_LS_KEY, repoInput.value.trim());
      }

      var findings = scanSessionForSecrets(session, SECRET_RULES);
      if (findings.length && !confirmChk.checked) {
        statusEl.className = 'hf-modal-status hf-error';
        statusEl.textContent = 'Confirm sharing with detected secrets';
        return;
      }

      shareBtn.disabled = true;
      statusEl.className = 'hf-modal-status';
      statusEl.textContent = 'Uploading…';
      spinnerEl.style.display = 'inline';

      var redacted = redactSession(session, findings);
      var html = clientRenderHTML(redacted);
      var sidecar = buildShareSidecar(redacted);
      sidecar.firstPrompt = sidecar.firstPrompt || '';
      var meta = {
        sessionId: redacted.sessionId,
        sessionHash: redacted.sessionHash,
        source: redacted.source,
        model: redacted.model,
        firstPrompt: sidecar.firstPrompt,
        durationFormatted: redacted.durationMs > 0 && typeof formatDuration === 'function' ? formatDuration(redacted.durationMs) : '—',
      };

      var upload = target === 'gist'
        ? shareGist(html, meta, token, privateChk.checked)
        : shareHf(html, sidecar, token, repoInput.value.trim(), privateChk.checked);

      upload.then(function(result) {
        spinnerEl.style.display = 'none';
        var previewUrl = typeof result === 'string' ? result : (result && result.previewUrl) || null;
        var gistUrl = result && result.gistUrl ? result.gistUrl : null;
        showShareSuccess(statusEl, previewUrl, gistUrl);
        shareBtn.disabled = false;
        shareBtn.textContent = 'Share';
      }).catch(function(err) {
        spinnerEl.style.display = 'none';
        statusEl.className = 'hf-modal-status hf-error';
        statusEl.textContent = err && err.message ? err.message : String(err);
        shareBtn.disabled = false;
      });
    });

    document.body.appendChild(overlay);
    pushOverlay(overlay);
    focusOverlay(overlay, tokenInput);
    shareKeyHandler = function(e) {
      if (!isTopOverlay(overlay)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        closeShareModal();
        return;
      }
      if (e.key === 'Tab') trapOverlayTab(e, overlay);
    };
    document.addEventListener('keydown', shareKeyHandler, true);
    updateTarget();
  }
`;
