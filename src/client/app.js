/* global io */

(function () {
  'use strict';

  const AUTH_TOKEN_KEY = 'cursor-remote-token';

  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  }

  function getAuthHeaders() {
    const token = getAuthToken();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  async function checkAuth() {
    try {
      const res = await fetch('/health', {
        credentials: 'same-origin',
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authRequired) {
          if (data.sessionValid === true) return true;
          if (data.sessionValid === false) {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            window.location.href = '/login';
            return false;
          }
          // Older relay without sessionValid: fall back to presence of stored token
          if (getAuthToken()) return true;
          window.location.href = '/login';
          return false;
        }
      }
    } catch { /* network error, proceed anyway */ }
    return true;
  }

  async function init() {
    if (!await checkAuth()) return;
    bootstrap();
  }

  function bootstrap() {

  let state = {
    connected: false,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
  };

  let userScrolledUp = false;
  let notificationPermission = 'default';

  const $messages = document.getElementById('messages');
  const $emptyState = document.getElementById('empty-state');
  const $emptyPrimary = document.getElementById('empty-state-primary');
  const $emptyHint = document.getElementById('empty-state-hint');
  const $connDot = document.getElementById('connection-dot');
  const $connText = document.getElementById('connection-text');
  const $statusIcon = document.getElementById('agent-status-icon');
  const $statusText = document.getElementById('agent-status-text');
  const $headerRight = document.querySelector('#header .header-right');
  const $approvalBar = document.getElementById('approval-bar');
  const $approvalDesc = document.getElementById('approval-desc');
  const $btnApprove = document.getElementById('btn-approve');
  const $btnReject = document.getElementById('btn-reject');
  const $input = document.getElementById('message-input');
  const $btnSend = document.getElementById('btn-send');
  const $toastContainer = document.getElementById('toast-container');

  const $windowBar = document.getElementById('window-bar');
  const $windowList = document.getElementById('window-list');
  const $tabBar = document.getElementById('tab-bar');
  const $tabList = document.getElementById('tab-list');
  const $btnNewChat = document.getElementById('btn-new-chat');
  const $pillMode = document.getElementById('pill-mode');
  const $pillModeIcon = document.getElementById('pill-mode-icon');
  const $pillModeText = document.getElementById('pill-mode-text');
  const $pillModel = document.getElementById('pill-model');
  const $pillModelText = document.getElementById('pill-model-text');
  const $sheetOverlay = document.getElementById('sheet-overlay');
  const $sheetMode = document.getElementById('sheet-mode');
  const $sheetModeList = document.getElementById('sheet-mode-list');
  const $sheetModel = document.getElementById('sheet-model');
  const $sheetModelList = document.getElementById('sheet-model-list');

  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    withCredentials: true,
    auth: (cb) => {
      try {
        cb({ token: getAuthToken() || '' });
      } catch {
        cb({ token: '' });
      }
    },
  });

  socket.on('connect', () => updateConnectionUI('reconnecting'));
  socket.on('disconnect', () => updateConnectionUI('disconnected'));

  let connectFailCount = 0;
  socket.on('connect_error', (err) => {
    connectFailCount++;
    if (err.message === 'Unauthorized' || connectFailCount >= 5) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      window.location.href = '/login';
    }
  });

  socket.on('state:full', (newState) => {
    state = newState;
    renderAll();
  });

  socket.on('state:patch', (patch) => {
    Object.assign(state, patch);
    renderAll();
  });

  socket.on('connection:status', (data) => {
    state.connected = data.connected;
    renderConnectionStatus();
  });

  socket.on('command:result', (result) => {
    if (!result.ok) showToast(result.error || 'Command failed', 'error');
  });

  $messages.addEventListener('scroll', () => {
    const threshold = 80;
    userScrolledUp = $messages.scrollTop + $messages.clientHeight < $messages.scrollHeight - threshold;
  });

  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
    $btnSend.disabled = !$input.value.trim();
  });

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  $btnSend.addEventListener('click', sendMessage);

  $btnApprove.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
    if (!action) return;
    socket.emit('command:approve', {
      commandId: crypto.randomUUID(),
      approvalId: approval.id,
      selectorPath: action.selectorPath,
    });
    showToast('Approve sent', 'success');
  });

  $btnReject.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'reject');
    if (!action) return;
    socket.emit('command:reject', {
      commandId: crypto.randomUUID(),
      approvalId: approval.id,
      selectorPath: action.selectorPath,
    });
    showToast('Reject sent', 'success');
  });

  $btnNewChat.addEventListener('click', () => {
    socket.emit('command:new_chat', { commandId: crypto.randomUUID() });
    showToast('Creating new chat...', 'success');
  });

  $pillMode.addEventListener('click', () => openSheet('mode'));
  $pillModel.addEventListener('click', () => openSheet('model'));
  $sheetOverlay.addEventListener('click', closeSheet);

  function sendMessage() {
    const text = $input.value.trim();
    if (!text) return;
    socket.emit('command:send_message', { commandId: crypto.randomUUID(), text });
    $input.value = '';
    $input.style.height = 'auto';
    $btnSend.disabled = true;
    showToast('Message sent', 'success');
  }

  function renderAll() {
    renderConnectionStatus();
    renderAgentStatus();
    renderComposerQueue();
    renderWindows();
    renderMessages();
    renderApprovals();
    renderInputState();
    renderTabs();
    renderModeModel();
  }

  function renderConnectionStatus() {
    if (state.connected) updateConnectionUI('connected');
    else if (socket.connected) updateConnectionUI('reconnecting');
    else updateConnectionUI('disconnected');
  }

  function updateConnectionUI(status) {
    $connDot.className = 'dot ' + status;
    const labels = { connected: 'Connected', disconnected: 'Disconnected', reconnecting: 'Connecting...' };
    $connText.textContent = labels[status] || status;
  }

  function renderAgentStatus() {
    const icons = {
      idle: '',
      thinking: '',
      generating: '',
      running_tool: '',
      waiting_approval: '!',
      error: '\u2715',
    };
    const labels = {
      idle: 'Idle', thinking: 'Thinking...', generating: 'Generating...',
      running_tool: 'Running tool...', waiting_approval: 'Needs approval', error: 'Error',
    };
    $statusIcon.textContent = icons[state.agentStatus] || '';
    const activity = (state.agentActivityText || '').trim();
    const activityLive = !!state.agentActivityLive;
    const baseLabel = labels[state.agentStatus] || state.agentStatus;
    if ($headerRight) {
      if (state.agentStatus !== 'idle') $headerRight.classList.remove('header-right-hidden');
      else $headerRight.classList.add('header-right-hidden');
    }
    if (activityLive && activity && state.agentStatus !== 'idle') {
      const max = 56;
      $statusText.textContent = activity.length > max ? activity.slice(0, max - 1) + '…' : activity;
      $statusText.classList.add('agent-status-shimmer');
    } else {
      $statusText.textContent = baseLabel;
      $statusText.classList.remove('agent-status-shimmer');
    }

    if (state.agentStatus === 'waiting_approval') $statusText.style.color = 'var(--accent-yellow)';
    else if (state.agentStatus === 'error') $statusText.style.color = 'var(--accent-red)';
    else $statusText.style.color = '';
  }

  function renderComposerQueue() {
    const bar = document.getElementById('composer-queue-bar');
    const labelEl = document.getElementById('composer-queue-label');
    const itemsEl = document.getElementById('composer-queue-items');
    if (!bar || !labelEl || !itemsEl) return;
    const q = state.composerQueue && Array.isArray(state.composerQueue.items)
      ? state.composerQueue
      : { items: [] };
    if (q.items.length === 0) {
      bar.classList.add('hidden');
      itemsEl.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    labelEl.textContent = q.queueLabel || `${q.items.length} queued`;
    itemsEl.innerHTML = '';
    q.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'composer-queue-row';
      const dot = document.createElement('span');
      dot.className = 'composer-queue-dot';
      const tx = document.createElement('span');
      tx.className = 'composer-queue-text';
      tx.textContent = it.text || '';
      row.appendChild(dot);
      row.appendChild(tx);
      itemsEl.appendChild(row);
    });
  }

  // --- Message rendering ---

  function renderMessages() {
    if (state.messages.length === 0) {
      $emptyState.style.display = '';
      $messages.querySelectorAll('.chat-el').forEach(el => el.remove());
      if (state.connected) {
        $emptyPrimary.textContent = 'No messages in this chat yet.';
        $emptyHint.innerHTML = 'Send a message below or switch chat tab / window in Cursor.';
      } else if (socket.connected) {
        $emptyPrimary.textContent = 'Connecting to Cursor IDE...';
        $emptyHint.innerHTML = 'Make sure Cursor is running with<br><code>--remote-debugging-port=9222</code>';
      } else {
        $emptyPrimary.textContent = 'Waiting for relay connection...';
        $emptyHint.innerHTML = 'Check that this page can reach the CursorRemote server.';
      }
      return;
    }

    $emptyState.style.display = 'none';

    const existingEls = $messages.querySelectorAll('.chat-el');
    const existingIds = new Map();
    existingEls.forEach(el => existingIds.set(el.dataset.id, el));

    const newIds = new Set(state.messages.map(m => m.id));

    existingEls.forEach(el => {
      if (!newIds.has(el.dataset.id)) el.remove();
    });

    state.messages.forEach((msg, index) => {
      let el = existingIds.get(msg.id);

      if (!el) {
        el = createElement(msg);
        const allEls = $messages.querySelectorAll('.chat-el');
        if (index < allEls.length) {
          $messages.insertBefore(el, allEls[index]);
        } else {
          $messages.appendChild(el);
        }
      } else {
        updateElement(el, msg);
      }
    });

    if (!userScrolledUp) {
      requestAnimationFrame(() => { $messages.scrollTop = $messages.scrollHeight; });
    }
  }

  function createElement(msg) {
    switch (msg.type) {
      case 'human': return createHumanEl(msg);
      case 'assistant': return createAssistantEl(msg);
      case 'tool': return createToolEl(msg);
      case 'thought': return createThoughtEl(msg);
      case 'plan': return createPlanEl(msg);
      case 'todo_list': return createTodoListEl(msg);
      case 'run_command': return createRunCommandEl(msg);
      case 'loading': return createLoadingEl(msg);
      default: return createFallbackEl(msg);
    }
  }

  function updateElement(el, msg) {
    switch (msg.type) {
      case 'human': updateHumanEl(el, msg); break;
      case 'assistant': updateAssistantEl(el, msg); break;
      case 'tool': updateToolEl(el, msg); break;
      case 'thought': updateThoughtEl(el, msg); break;
      case 'plan': updatePlanEl(el, msg); break;
      case 'todo_list': updateTodoListEl(el, msg); break;
      case 'run_command': updateRunCommandEl(el, msg); break;
      case 'loading': break;
    }
  }

  // --- Human message ---

  function createQuotedWidget(text) {
    const wrap = document.createElement('div');
    wrap.className = 'quoted-widget';
    const lab = document.createElement('div');
    lab.className = 'quoted-label';
    lab.textContent = 'Quoted';
    const body = document.createElement('div');
    body.className = 'quoted-text';
    body.textContent = text;
    wrap.appendChild(lab);
    wrap.appendChild(body);
    return wrap;
  }

  function createHumanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-human';
    el.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'human-bubble';

    if (msg.quoted && msg.quoted.text) {
      bubble.appendChild(createQuotedWidget(msg.quoted.text));
    }

    if (msg.mentions && msg.mentions.length > 0) {
      const mentionsRow = document.createElement('div');
      mentionsRow.className = 'mentions-row';
      msg.mentions.forEach(m => {
        const badge = document.createElement('span');
        badge.className = 'mention-badge';
        badge.textContent = m.name;
        mentionsRow.appendChild(badge);
      });
      bubble.appendChild(mentionsRow);
    }

    const text = document.createElement('div');
    text.className = 'human-text';
    text.textContent = msg.text;
    bubble.appendChild(text);
    el.appendChild(bubble);
    return el;
  }

  function updateHumanEl(el, msg) {
    const bubble = el.querySelector('.human-bubble');
    let qw = el.querySelector('.quoted-widget');
    if (msg.quoted && msg.quoted.text) {
      if (!qw && bubble) {
        qw = createQuotedWidget(msg.quoted.text);
        bubble.insertBefore(qw, bubble.firstChild);
      } else if (qw) {
        const body = qw.querySelector('.quoted-text');
        if (body) body.textContent = msg.quoted.text;
      }
    } else if (qw) {
      qw.remove();
    }
    const text = el.querySelector('.human-text');
    if (text) text.textContent = msg.text;
  }

  // --- Assistant message ---

  let codeBlockFsOverlay = null;

  function closeCodeBlockFullscreen() {
    if (!codeBlockFsOverlay) return;
    codeBlockFsOverlay.remove();
    codeBlockFsOverlay = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onCodeBlockFsKeydown);
  }

  function onCodeBlockFsKeydown(e) {
    if (e.key === 'Escape') closeCodeBlockFullscreen();
  }

  /** Full-screen overlay for long code/diff (mobile-friendly scroll + safe areas). */
  function openCodeBlockFullscreen(wrapper) {
    closeCodeBlockFullscreen();
    const viewport = wrapper.querySelector('.code-block-viewport');
    const headerEl = wrapper.querySelector('.code-block-header');
    const title = (headerEl && headerEl.textContent.trim()) || 'Code';

    const overlay = document.createElement('div');
    overlay.className = 'code-block-fs-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    const backdrop = document.createElement('div');
    backdrop.className = 'code-block-fs-backdrop';
    backdrop.addEventListener('click', closeCodeBlockFullscreen);

    const panel = document.createElement('div');
    panel.className = 'code-block-fs-panel';

    const panelHead = document.createElement('div');
    panelHead.className = 'code-block-fs-panel-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'code-block-fs-title';
    titleSpan.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'code-block-fs-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCodeBlockFullscreen();
    });
    panelHead.appendChild(titleSpan);
    panelHead.appendChild(closeBtn);

    const scroll = document.createElement('div');
    scroll.className = 'code-block-fs-scroll';
    if (viewport && viewport.firstElementChild) {
      scroll.appendChild(viewport.firstElementChild.cloneNode(true));
    }

    panel.appendChild(panelHead);
    panel.appendChild(scroll);
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    codeBlockFsOverlay = overlay;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onCodeBlockFsKeydown);
    closeBtn.focus();
  }

  /** Native code/diff from server `CodeBlockItem` (no mirrored Monaco HTML). */
  function createNativeBlockFromItem(item, filenameFallback) {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block native-code-block';

    const title = (item.filename || item.language || filenameFallback || '').trim();
    const toolbar = document.createElement('div');
    toolbar.className =
      'code-block-toolbar' + (title ? '' : ' code-block-toolbar--actions-only');
    if (title) {
      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.textContent = title;
      toolbar.appendChild(header);
    }

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'code-block-fullscreen-btn';
    expandBtn.setAttribute('aria-label', 'View full screen');
    expandBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCodeBlockFullscreen(wrapper);
    });
    toolbar.appendChild(expandBtn);
    wrapper.appendChild(toolbar);

    const viewport = document.createElement('div');
    viewport.className = 'code-block-viewport';

    const body = document.createElement('div');
    body.className = 'code-block-diff-plain';
    if (item.blockKind === 'diff' && item.diffLines && item.diffLines.length > 0) {
      for (const line of item.diffLines) {
        const row = document.createElement('div');
        const k = ['add', 'rem', 'ctx', 'meta', 'hunk'].includes(line.kind) ? line.kind : 'ctx';
        row.className = 'code-block-diff-line code-block-diff-line--' + k;
        row.textContent = line.text;
        body.appendChild(row);
      }
    } else {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = item.code || '';
      pre.appendChild(code);
      body.appendChild(pre);
      body.classList.add('code-block-diff-plain--raw');
    }
    viewport.appendChild(body);
    wrapper.appendChild(viewport);
    return wrapper;
  }

  function appendAssistantNativeBlocks(bubble, msg) {
    if (!bubble) return;
    bubble.querySelectorAll(':scope > .native-code-block').forEach((n) => n.remove());
    if (!msg.codeBlocks?.length) return;
    for (const item of msg.codeBlocks) {
      if (!item || (!item.code?.trim() && !(item.diffLines && item.diffLines.length))) continue;
      bubble.appendChild(createNativeBlockFromItem(item));
    }
  }

  function createAssistantEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-assistant';
    el.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble';

    if (msg.html) {
      const content = document.createElement('div');
      content.className = 'assistant-content markdown-body';
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      bubble.appendChild(content);
    } else {
      const content = document.createElement('div');
      content.className = 'assistant-content';
      content.textContent = msg.text;
      bubble.appendChild(content);
    }

    appendAssistantNativeBlocks(bubble, msg);

    el.appendChild(bubble);
    return el;
  }

  function updateAssistantEl(el, msg) {
    const bubble = el.querySelector('.assistant-bubble');
    const content = el.querySelector('.assistant-content');
    if (!content) return;
    if (msg.html) {
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      content.classList.add('markdown-body');
    } else {
      content.textContent = msg.text;
      content.classList.remove('markdown-body');
    }
    appendAssistantNativeBlocks(bubble, msg);
  }

  // --- Tool call ---

  function createToolEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-tool';
    el.dataset.id = msg.id;

    const line = document.createElement('div');
    line.className = 'tool-line ' + msg.status;

    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = msg.status === 'completed' ? '\u2713' : '\u2022';
    line.appendChild(icon);

    if (msg.summaryText) {
      const summary = document.createElement('span');
      summary.className = 'tool-summary';
      summary.textContent = msg.summaryText;
      line.appendChild(summary);
    } else {
      if (msg.action) {
        const action = document.createElement('span');
        action.className = 'tool-action';
        action.textContent = msg.action;
        line.appendChild(action);
      }
      if (msg.details) {
        const details = document.createElement('span');
        details.className = 'tool-details';
        details.textContent = msg.details;
        line.appendChild(details);
      }
    }

    if (msg.filename || msg.additions != null || msg.deletions != null) {
      const fileInfo = document.createElement('span');
      fileInfo.className = 'tool-file-info';

      if (msg.filename) {
        const fn = document.createElement('span');
        fn.className = 'tool-filename';
        fn.textContent = msg.filename;
        fileInfo.appendChild(fn);
      }
      if (msg.additions != null) {
        const add = document.createElement('span');
        add.className = 'tool-additions';
        add.textContent = '+' + msg.additions;
        fileInfo.appendChild(add);
      }
      if (msg.deletions != null) {
        const del = document.createElement('span');
        del.className = 'tool-deletions';
        del.textContent = '-' + msg.deletions;
        fileInfo.appendChild(del);
      }

      line.appendChild(fileInfo);
    }

    el.appendChild(line);
    syncToolDiffHost(el, msg);
    return el;
  }

  /** Tool edit diff: native block from `diffBlock` (structured lines). */
  function syncToolDiffHost(el, msg) {
    const db = msg.diffBlock;
    const hasBody =
      db &&
      ((db.diffLines && db.diffLines.length > 0) || (db.code && String(db.code).trim().length > 0));
    let host = el.querySelector('.tool-diff-host');

    if (!hasBody) {
      if (host) {
        delete host._nativeDiffKey;
        host.remove();
      }
      return;
    }

    const key = JSON.stringify({
      bk: db.blockKind,
      c: db.code,
      d: db.diffLines,
      f: db.filename || msg.filename,
    });
    if (!host) {
      host = document.createElement('div');
      host.className = 'tool-diff-host';
      el.appendChild(host);
    }
    if (host._nativeDiffKey === key) return;
    host._nativeDiffKey = key;
    host.innerHTML = '';
    host.appendChild(createNativeBlockFromItem(db, msg.filename));
  }

  function updateToolEl(el, msg) {
    const icon = el.querySelector('.tool-icon');
    if (icon) icon.textContent = msg.status === 'completed' ? '\u2713' : '\u23F3';
    const line = el.querySelector('.tool-line');
    if (line) line.className = 'tool-line ' + msg.status;
    syncToolDiffHost(el, msg);
  }

  // --- Thought block ---

  function formatThoughtLine(msg) {
    const dur = (msg.duration || '').trim();
    const detail = (msg.detail || '').trim();
    if (msg.thoughtKind === 'step_summary') {
      const a = (msg.action || '').trim();
      return detail ? `${a || 'Steps'} — ${detail}` : (a || 'Steps');
    }
    if (msg.thoughtKind === 'thinking_step') {
      const a = (msg.action || '').trim();
      if (dur) return `${a || 'Step'} · ${dur}`;
      if (a) {
        if (/^thought$/i.test(a)) return 'Thought';
        if (/ing$/i.test(a)) return `${a.replace(/\.\.\.?$/, '')}…`;
        return a;
      }
      return 'Thinking…';
    }
    if (dur) return `Thought for ${dur}`;
    const action = (msg.action || '').trim();
    if (action) {
      if (/^thought$/i.test(action)) return 'Thought';
      if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, '')}…`;
      return action;
    }
    return 'Thinking…';
  }

  function syncThoughtLineClasses(inner, msg) {
    inner.classList.remove('thought-line-summary', 'thought-line-step');
    if (msg.thoughtKind === 'step_summary') inner.classList.add('thought-line-summary');
    else if (msg.thoughtKind === 'thinking_step') inner.classList.add('thought-line-step');
  }

  function createThoughtEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-thought';
    el.dataset.id = msg.id;

    const inner = document.createElement('div');
    inner.className = 'thought-line';
    syncThoughtLineClasses(inner, msg);
    inner.textContent = formatThoughtLine(msg);
    el.appendChild(inner);
    return el;
  }

  function updateThoughtEl(el, msg) {
    const inner = el.querySelector('.thought-line');
    if (inner) {
      syncThoughtLineClasses(inner, msg);
      inner.textContent = formatThoughtLine(msg);
    }
  }

  // --- Plan block ---

  function emitClickAction(selectorPath) {
    socket.emit('command:click_action', {
      commandId: crypto.randomUUID(),
      selectorPath,
    });
  }

  function buildPlanCard(msg) {
    const card = document.createElement('div');
    card.className = 'plan-card plan-card-widget';

    if (msg.label) {
      const header = document.createElement('div');
      header.className = 'plan-widget-header';
      const icon = document.createElement('span');
      icon.className = 'plan-widget-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\u2712';
      const fn = document.createElement('span');
      fn.className = 'plan-widget-filename';
      fn.textContent = msg.label;
      header.appendChild(icon);
      header.appendChild(fn);
      card.appendChild(header);
    }

    const title = document.createElement('div');
    title.className = 'plan-title';
    title.textContent = msg.title;
    card.appendChild(title);

    if (msg.descriptionHtml) {
      const desc = document.createElement('div');
      desc.className = 'plan-description markdown-body';
      desc.innerHTML = sanitizeHtml(msg.descriptionHtml);
      normalizeMarkdownCodeBlocks(desc);
      card.appendChild(desc);
    } else if (msg.description) {
      const desc = document.createElement('div');
      desc.className = 'plan-description';
      desc.textContent = msg.description;
      card.appendChild(desc);
    }

    if (msg.todos && msg.todos.length > 0) {
      const todoList = document.createElement('div');
      todoList.className = 'plan-todo-list';
      msg.todos.forEach((todo) => {
        const item = document.createElement('div');
        item.className = 'plan-todo-item';
        const dot = document.createElement('span');
        dot.className = 'plan-todo-dot plan-todo-' + todo.status;
        item.appendChild(dot);
        const text = document.createElement('span');
        text.className = 'plan-todo-text';
        text.textContent = todo.text;
        item.appendChild(text);
        todoList.appendChild(item);
      });
      card.appendChild(todoList);
    }

    if (msg.todosMoreCount && msg.todosMoreCount > 0) {
      const more = document.createElement('div');
      more.className = 'plan-todos-more';
      more.textContent = `${msg.todosMoreCount} more`;
      card.appendChild(more);
    }

    if (msg.todosTotal > 0) {
      const progress = document.createElement('div');
      progress.className = 'plan-progress';
      const track = document.createElement('div');
      track.className = 'plan-progress-track';
      const bar = document.createElement('div');
      bar.className = 'plan-progress-bar';
      const pct = Math.round((msg.todosCompleted / msg.todosTotal) * 100);
      bar.style.width = pct + '%';
      track.appendChild(bar);
      progress.appendChild(track);
      const progressText = document.createElement('span');
      progressText.className = 'plan-progress-text';
      progressText.textContent = msg.todosCompleted + '/' + msg.todosTotal;
      progress.appendChild(progressText);
      card.appendChild(progress);
    }

    const hasActions = (msg.actions && msg.actions.length > 0) || msg.modelDropdownSelectorPath || msg.model;
    if (hasActions) {
      const toolbar = document.createElement('div');
      toolbar.className = 'plan-actions-toolbar';

      const left = document.createElement('div');
      left.className = 'plan-actions-left';
      if (msg.actions) {
        const viewAct = msg.actions.find((a) => a.type === 'view_plan');
        if (viewAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-view';
          btn.textContent = viewAct.label || 'View Plan';
          btn.addEventListener('click', () => emitClickAction(viewAct.selectorPath));
          left.appendChild(btn);
        }
      }
      toolbar.appendChild(left);

      const center = document.createElement('div');
      center.className = 'plan-actions-center';
      if (msg.modelDropdownSelectorPath) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'plan-model-pill';
        const lab = document.createElement('span');
        lab.className = 'plan-model-pill-text';
        lab.textContent = msg.model || 'Model';
        const chev = document.createElement('span');
        chev.className = 'plan-model-pill-chev';
        chev.textContent = '\u25BE';
        pill.appendChild(lab);
        pill.appendChild(chev);
        pill.addEventListener('click', () => emitClickAction(msg.modelDropdownSelectorPath));
        center.appendChild(pill);
      } else if (msg.model) {
        const badge = document.createElement('span');
        badge.className = 'plan-model-badge-inline';
        badge.textContent = msg.model;
        center.appendChild(badge);
      }
      toolbar.appendChild(center);

      const right = document.createElement('div');
      right.className = 'plan-actions-right';
      if (msg.actions) {
        const buildAct = msg.actions.find((a) => a.type === 'build');
        if (buildAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-build';
          btn.textContent = buildAct.label || 'Build';
          btn.addEventListener('click', () => emitClickAction(buildAct.selectorPath));
          right.appendChild(btn);
        }
      }
      toolbar.appendChild(right);
      card.appendChild(toolbar);
    }

    return card;
  }

  function createPlanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-plan';
    el.dataset.id = msg.id;
    el.appendChild(buildPlanCard(msg));
    return el;
  }

  function updatePlanEl(el, msg) {
    const oldCard = el.querySelector('.plan-card');
    if (oldCard) el.replaceChild(buildPlanCard(msg), oldCard);
  }

  // --- Standalone todo list (matches Telegram §3.9) ---

  function createTodoListEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-todo-list';
    el.dataset.id = msg.id;
    const card = document.createElement('div');
    card.className = 'todo-list-card';
    const head = document.createElement('div');
    head.className = 'todo-list-card-title';
    head.textContent = `${msg.title} (${msg.todosCompleted}/${msg.todosTotal})`;
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'todo-list-card-items';
    msg.todos.forEach((todo) => {
      const row = document.createElement('div');
      row.className = 'todo-list-card-row';
      const icon = document.createElement('span');
      icon.className = 'todo-list-card-icon';
      icon.textContent = todo.status === 'completed' ? '✅'
        : todo.status === 'in_progress' ? '🔵' : '⚪';
      const tx = document.createElement('span');
      tx.className = 'todo-list-card-text';
      tx.textContent = todo.text;
      row.appendChild(icon);
      row.appendChild(tx);
      list.appendChild(row);
    });
    card.appendChild(list);
    el.appendChild(card);
    return el;
  }

  function updateTodoListEl(el, msg) {
    const fresh = createTodoListEl(msg);
    const newCard = fresh.querySelector('.todo-list-card');
    const oldCard = el.querySelector('.todo-list-card');
    if (newCard && oldCard) el.replaceChild(newCard, oldCard);
  }

  // --- Run command ---

  function createRunCommandEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-run-command';
    el.dataset.id = msg.id;

    const card = document.createElement('div');
    card.className = 'run-card';

    const header = document.createElement('div');
    header.className = 'run-header';
    const desc = document.createElement('span');
    desc.className = 'run-description';
    desc.textContent = msg.description;
    header.appendChild(desc);
    if (msg.candidates) {
      const cand = document.createElement('span');
      cand.className = 'run-candidates';
      cand.textContent = ' ' + msg.candidates;
      header.appendChild(cand);
    }
    card.appendChild(header);

    const cmdBlock = document.createElement('div');
    cmdBlock.className = 'run-command-block';
    const prompt = document.createElement('span');
    prompt.className = 'run-prompt';
    prompt.textContent = '$ ';
    cmdBlock.appendChild(prompt);
    const cmdText = document.createElement('span');
    cmdText.className = 'run-command-text';
    cmdText.textContent = msg.command;
    cmdBlock.appendChild(cmdText);
    card.appendChild(cmdBlock);

    if (msg.actions && msg.actions.length > 0) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'run-actions-row';
      msg.actions.forEach(function (action) {
        const btn = document.createElement('button');
        btn.className = action.type === 'run' ? 'run-btn run-btn-run'
          : action.type === 'allow' ? 'run-btn run-btn-allow'
          : 'run-btn run-btn-skip';
        btn.textContent = action.label;
        btn.addEventListener('click', function () {
          socket.emit('command:click_action', {
            commandId: crypto.randomUUID(),
            selectorPath: action.selectorPath,
          });
        });
        actionsRow.appendChild(btn);
      });
      card.appendChild(actionsRow);
    }

    el.appendChild(card);
    return el;
  }

  function updateRunCommandEl(el, msg) {
    const cmdText = el.querySelector('.run-command-text');
    if (cmdText) cmdText.textContent = msg.command;
  }

  // --- Loading indicator ---

  function createLoadingEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-loading';
    el.dataset.id = msg.id;

    const dots = document.createElement('div');
    dots.className = 'loading-dots';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot-anim';
      dots.appendChild(dot);
    }
    el.appendChild(dots);
    return el;
  }

  // --- Fallback ---

  function createFallbackEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-fallback';
    el.dataset.id = msg.id;
    el.textContent = msg.text || msg.type || '...';
    return el;
  }

  // --- Sanitize HTML (strip scripts, event handlers) ---

  function sanitizeHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script, iframe, object, embed, form').forEach(el => el.remove());
    tmp
      .querySelectorAll('.composer-message-codeblock, .composer-code-block-container, .ui-code-block')
      .forEach((el) => el.remove());
    tmp.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('on') || attr.name === 'srcdoc') {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return tmp.innerHTML;
  }

  function normalizeMarkdownCodeBlocks(root) {
    if (!root) return;
    function extractStructuredCodeText(el) {
      let out = '';
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          out += node.textContent || '';
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'br') {
          out += '\n';
          return;
        }
        const before = out.length;
        node.childNodes.forEach(walk);
        const isLineLike =
          tag === 'div' ||
          tag === 'p' ||
          tag === 'li' ||
          node.matches?.('[data-line], .line');
        if (isLineLike && out.length > before && !out.endsWith('\n')) {
          out += '\n';
        }
      }
      walk(el);
      return out.replace(/\n{3,}/g, '\n\n').replace(/\s+\n/g, '\n').trimEnd();
    }

    root.querySelectorAll('code').forEach((codeEl) => {
      if (codeEl.closest('pre')) return;
      if (
        codeEl.className.includes('md-inline-') ||
        codeEl.closest('p, li, a, h1, h2, h3, h4, h5, h6')
      ) {
        return;
      }

      const text = extractStructuredCodeText(codeEl);
      const looksBlockLike =
        text.includes('\n') ||
        !!codeEl.querySelector('br,[data-line],.line,div,p') ||
        /(?:^|\s)(?:language-|shiki)/.test(codeEl.className);
      if (!looksBlockLike) return;

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = codeEl.className || '';
      code.textContent = text;
      pre.appendChild(code);
      codeEl.replaceWith(pre);
    });
  }

  // --- Approvals ---

  function renderApprovals() {
    if (state.pendingApprovals.length > 0) {
      $approvalBar.classList.remove('hidden');
      const approval = state.pendingApprovals[0];
      $approvalDesc.textContent = approval.description || 'Action needs approval';

      const approveAction = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
      const rejectAction = approval.actions.find(a => a.type === 'reject');

      $btnApprove.disabled = !approveAction;
      $btnReject.disabled = !rejectAction;
      if (approveAction) $btnApprove.textContent = approveAction.label || 'Accept';
      if (rejectAction) $btnReject.textContent = rejectAction.label || 'Reject';

      fireNotification(approval.description || 'Agent needs approval');
    } else {
      $approvalBar.classList.add('hidden');
    }
  }

  function renderInputState() {
    $input.disabled = !state.inputAvailable && !state.connected;
    $btnSend.disabled = !$input.value.trim() || $input.disabled;
  }

  function fireNotification(text) {
    if (document.hasFocus()) return;
    if (notificationPermission === 'default') {
      Notification.requestPermission().then(perm => {
        notificationPermission = perm;
        if (perm === 'granted') new Notification('Cursor Agent', { body: text, tag: 'cursor-approval' });
      });
    } else if (notificationPermission === 'granted') {
      new Notification('Cursor Agent', { body: text, tag: 'cursor-approval' });
    }
  }

  // --- Window rendering ---

  function renderWindows() {
    const windows = state.windows || [];
    if (windows.length <= 1) {
      $windowBar.classList.add('hidden');
      return;
    }
    $windowBar.classList.remove('hidden');

    const existingBtns = $windowList.querySelectorAll('.window-item');
    const existingMap = new Map();
    existingBtns.forEach(b => existingMap.set(b.dataset.id, b));

    const newIds = new Set(windows.map(w => w.id));
    existingBtns.forEach(b => {
      if (!newIds.has(b.dataset.id)) b.remove();
    });

    windows.forEach((win) => {
      let btn = existingMap.get(win.id);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'window-item';
        btn.dataset.id = win.id;
        btn.addEventListener('click', () => {
          socket.emit('command:switch_window', {
            commandId: crypto.randomUUID(),
            windowId: win.id,
          });
          showToast('Switching window...', 'success');
        });
        $windowList.appendChild(btn);
      }

      const isActive = win.id === state.activeWindowId;
      btn.className = 'window-item' + (isActive ? ' active' : '');
      btn.textContent = win.title || 'Cursor';
    });
  }

  // --- Tab rendering ---

  function renderTabs() {
    const tabs = state.chatTabs || [];
    if (tabs.length <= 1) {
      $tabBar.classList.add('hidden');
      return;
    }
    $tabBar.classList.remove('hidden');

    const existingBtns = $tabList.querySelectorAll('.tab-item');
    const existingMap = new Map();
    existingBtns.forEach(b => existingMap.set(b.dataset.title, b));

    const newTitles = new Set(tabs.map(t => t.title));
    existingBtns.forEach(b => {
      if (!newTitles.has(b.dataset.title)) b.remove();
    });

    tabs.forEach((tab, i) => {
      let btn = existingMap.get(tab.title);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'tab-item';
        btn.dataset.title = tab.title;
        btn.addEventListener('click', () => {
          socket.emit('command:switch_tab', {
            commandId: crypto.randomUUID(),
            tabTitle: tab.title,
            selectorPath: tab.selectorPath,
          });
        });
        $tabList.appendChild(btn);
      }

      btn.className = 'tab-item' + (tab.isActive ? ' active' : '');
      btn.textContent = tab.title || `Chat ${i + 1}`;
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Mode / Model rendering ---

  const MODE_ICONS = {
    agent: '\u221E',
    plan: '\u2611',
    debug: '\uD83D\uDC1B',
    chat: '\uD83D\uDCAC',
  };

  const MODE_LABELS = {
    agent: 'Agent',
    plan: 'Plan',
    debug: 'Debug',
    chat: 'Ask',
  };

  function renderModeModel() {
    const mode = state.mode || { current: 'agent', available: [] };
    const model = state.model || { current: 'Auto', currentId: '' };

    $pillModeIcon.textContent = MODE_ICONS[mode.current] || '';
    $pillModeText.textContent = MODE_LABELS[mode.current] || mode.current;
    $pillModelText.textContent = model.current || 'Auto';
  }

  // --- Bottom sheet logic ---

  let activeSheet = null;

  function openSheet(type) {
    closeSheet();
    activeSheet = type;
    $sheetOverlay.classList.remove('hidden');

    if (type === 'mode') {
      $sheetMode.classList.remove('hidden');
      renderModeSheet();
    } else if (type === 'model') {
      $sheetModel.classList.remove('hidden');
      renderModelSheet();
    }
  }

  function closeSheet() {
    $sheetOverlay.classList.add('hidden');
    $sheetMode.classList.add('hidden');
    $sheetModel.classList.add('hidden');
    activeSheet = null;
  }

  function renderModeSheet() {
    $sheetModeList.innerHTML = '';
    const modes = [
      { id: 'agent', label: 'Agent', icon: '\u221E' },
      { id: 'plan', label: 'Plan', icon: '\u2611' },
      { id: 'debug', label: 'Debug', icon: '\uD83D\uDC1B' },
      { id: 'chat', label: 'Ask', icon: '\uD83D\uDCAC' },
    ];
    const current = (state.mode || {}).current || 'agent';

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (m.id === current ? ' selected' : '');
      btn.innerHTML =
        `<span class="sheet-item-icon">${m.icon}</span>` +
        `<span>${escapeHtml(m.label)}</span>` +
        (m.id === current ? '<span class="sheet-item-check">\u2713</span>' : '');
      btn.addEventListener('click', () => {
        socket.emit('command:set_mode', { commandId: crypto.randomUUID(), modeId: m.id });
        closeSheet();
        showToast(`Mode: ${m.label}`, 'success');
      });
      $sheetModeList.appendChild(btn);
    });
  }

  const MODEL_SECTIONS = [
    {
      items: [
        { id: 'max-models', label: 'MAX Mode', toggle: true },
      ],
    },
    { divider: true },
    {
      items: [
        { id: 'default', label: 'Auto', tag: 'Efficiency' },
        { id: 'premium', label: 'Premium', tag: 'Intelligence' },
      ],
    },
    { divider: true },
    {
      items: [
        { id: 'composer-1_5', label: 'Composer 1.5', thinking: true },
        { id: 'gpt-5_3-codex', label: 'GPT-5.3 Codex', thinking: true },
        { id: 'gpt-5_4-medium', label: 'GPT-5.4', thinking: true },
        { id: 'claude-4_6-sonnet-medium-thinking', label: 'Sonnet 4.6', thinking: true },
        { id: 'claude-4_6-opus-high-thinking', label: 'Opus 4.6', thinking: true },
        { id: 'gemini-3_1-pro', label: 'Gemini 3.1 Pro', thinking: true },
      ],
    },
  ];

  let maxModeOn = false;

  function renderModelSheet() {
    $sheetModelList.innerHTML = '';
    const currentName = ((state.model || {}).current || '').toLowerCase();

    MODEL_SECTIONS.forEach(section => {
      if (section.divider) {
        const div = document.createElement('div');
        div.className = 'sheet-divider';
        $sheetModelList.appendChild(div);
        return;
      }
      (section.items || []).forEach(m => {
        if (m.toggle) {
          const row = document.createElement('div');
          row.className = 'sheet-toggle';
          const label = document.createElement('span');
          label.textContent = m.label;
          row.appendChild(label);
          const sw = document.createElement('button');
          sw.className = 'toggle-switch' + (maxModeOn ? ' on' : '');
          sw.innerHTML = '<span class="toggle-knob"></span>';
          sw.addEventListener('click', () => {
            maxModeOn = !maxModeOn;
            socket.emit('command:set_model', { commandId: crypto.randomUUID(), modelId: m.id });
            renderModelSheet();
          });
          row.appendChild(sw);
          $sheetModelList.appendChild(row);
          return;
        }

        const isSelected = currentName === m.label.toLowerCase();
        const btn = document.createElement('button');
        btn.className = 'sheet-item' + (isSelected ? ' selected' : '');

        let inner = '<span class="sheet-item-label">' + escapeHtml(m.label);
        if (m.tag) inner += '<span class="sheet-item-tag">' + escapeHtml(m.tag) + '</span>';
        inner += '</span>';

        const right = [];
        if (m.thinking) right.push('<span class="sheet-item-badge" title="Thinking">\uD83E\uDDE0</span>');
        if (isSelected) right.push('<span class="sheet-item-check">\u2713</span>');
        inner += '<span class="sheet-item-right">' + right.join('') + '</span>';

        btn.innerHTML = inner;
        btn.addEventListener('click', () => {
          socket.emit('command:set_model', { commandId: crypto.randomUUID(), modelId: m.id });
          closeSheet();
          showToast(`Model: ${m.label}`, 'success');
        });
        $sheetModelList.appendChild(btn);
      });
    });
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    $toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  } // end bootstrap

  init();
})();
