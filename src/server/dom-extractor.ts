import type { CdpClient } from './cdp-client.js';
import type {
  CursorState,
  ChatElement,
  ChatTab,
  ModeInfo,
  ModelInfo,
  SelectorConfig,
} from './types.js';

const EVALUATE_TIMEOUT_MS = 5000;

/** Canonical tab title cleaning - matches extractionFunction's cleanTabTitle for consistent lookups. */
export function cleanTabTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  t = t.replace(/(@[\w./]+)+\s*$/, '');
  return t.trim().substring(0, 120);
}

/**
 * Runs inside Cursor's renderer process via Runtime.evaluate.
 * Must be completely self-contained (no Node.js imports).
 *
 * Uses Cursor's data attributes (data-flat-index, data-message-role,
 * data-message-kind, data-tool-status) for reliable extraction.
 */
export function extractionFunction(
  containerSelectors: string[],
  approveSelectors: string[],
  approveTextMatch: string[],
  rejectSelectors: string[],
  rejectTextMatch: string[],
  inputSelectors: string[],
  statusSelectors: string[],
  chatTabSelectors: string[],
  modeSelectors: string[],
  modelSelectors: string[],
  windowTitle?: string
): CursorState | null {
  function projectNameFromTitle(title: string): string {
    const idx = title.indexOf(' [');
    return (idx >= 0 ? title.substring(0, idx) : title).trim();
  }
  function findFirst(selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch { /* skip */ }
    }
    return null;
  }

  function buildSelectorPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        seg += `#${cur.id.replace(/([.:])/g, '\\$1')}`;
        parts.unshift(seg);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === cur!.tagName);
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  try {
    const container = findFirst(containerSelectors);
    if (!container) return null;

    const flatIndexEls = container.querySelectorAll('[data-flat-index]');
    let containerComposerId =
      container.getAttribute('data-composer-id') ||
      container.closest('[data-composer-id]')?.getAttribute('data-composer-id') ||
      '';
    if (!containerComposerId && flatIndexEls.length > 0) {
      const firstMsg = flatIndexEls[0];
      containerComposerId = firstMsg.closest('[data-composer-id]')?.getAttribute('data-composer-id') || '';
    }

    const elements: ChatElement[] = [];

    for (const wrapper of Array.from(flatIndexEls)) {
      const flatIndex = parseInt(wrapper.getAttribute('data-flat-index') || '0', 10);

      const msgEl = wrapper.querySelector('[data-message-role]') || wrapper;
      const role = msgEl.getAttribute('data-message-role');
      const kind = msgEl.getAttribute('data-message-kind');
      const messageId = msgEl.getAttribute('data-message-id') || `fi-${flatIndex}`;

      // --- Loading indicator ---
      if (wrapper.querySelector('.loading-indicator-v3')) {
        elements.push({
          type: 'loading' as const,
          id: `loading-${flatIndex}`,
          flatIndex,
        });
        continue;
      }

      // --- Step-group header (Thought, Explored, Searched, Read, etc.) ---
      const thoughtEl = wrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      if (thoughtEl && !role) {
        const headerSpans = thoughtEl.querySelectorAll('.ui-collapsible-header > span');
        let action = '';
        let detail = '';
        let duration = '';
        for (const s of Array.from(headerSpans)) {
          if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
          const t = (s.textContent || '').trim();
          if (!t) continue;
          if (!action) { action = t; continue; }
          if (t.startsWith('for ')) { duration = t.replace('for ', ''); detail = t; }
          else { detail = t; }
        }
        elements.push({
          type: 'thought' as const,
          id: `thought-${flatIndex}`,
          flatIndex,
          duration,
          action: action || undefined,
          detail: detail || undefined,
        });
        continue;
      }

      // --- Human message ---
      if (role === 'human' && kind === 'human') {
        // Check for plan block
        const planContent = wrapper.querySelector('.plan-execution-message-content');
        if (planContent) {
          const label = (planContent.querySelector('.plan-execution-label')?.textContent || '').trim();
          const title = (planContent.querySelector('.plan-execution-title')?.textContent || '').trim();
          const todoSummary = wrapper.querySelector('.todo-summary-content');
          let todosCompleted = 0;
          let todosTotal = 0;
          if (todoSummary) {
            const summaryText = todoSummary.textContent || '';
            const ofMatch = summaryText.match(/(\d+)\s+of\s+(\d+)/);
            const slashMatch = summaryText.match(/(\d+)\s*\/\s*(\d+)/);
            const countMatch = ofMatch || slashMatch;
            if (countMatch) {
              todosCompleted = parseInt(countMatch[1], 10);
              todosTotal = parseInt(countMatch[2], 10);
            }
          }

          const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
          const summaryItems = wrapper.querySelectorAll('.todo-summary-item');
          for (const item of Array.from(summaryItems)) {
            const contentEl = item.querySelector('.todo-summary-item-content');
            const text = (contentEl?.textContent || '').trim();
            if (!text) continue;
            const contentCls = contentEl?.className || '';
            let status: 'pending' | 'completed' | 'in_progress' = 'pending';
            if (contentCls.includes('todo-completed')) { status = 'completed'; }
            else if (contentCls.includes('todo-in-progress') || item.querySelector('.todo-summary-in-progress-circle')) { status = 'in_progress'; }
            todos.push({ text, status });
          }

          // Collapsed: items not rendered yet. Click to expand; they'll appear next poll cycle.
          if (todos.length === 0 && todosTotal > 0) {
            const clickable = wrapper.querySelector('.todo-summary-content-clickable') as HTMLElement | null;
            if (clickable) clickable.click();
          }

          if (todos.length > 0 && todosTotal === 0) {
            todosTotal = todos.length;
            todosCompleted = todos.filter(function(t) { return t.status === 'completed'; }).length;
          }

          elements.push({
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
          });
          continue;
        }

        // Regular human message
        const inputEl = wrapper.querySelector('.aislash-editor-input-readonly');
        const text = (inputEl?.textContent || wrapper.textContent || '').trim();
        const mentionEls = wrapper.querySelectorAll('.mention');
        const mentions = Array.from(mentionEls).map(m => ({
          name: m.getAttribute('data-mention-name') || (m.textContent || '').trim(),
          mentionType: m.getAttribute('data-typeahead-type') || 'unknown',
        }));

        elements.push({
          type: 'human' as const,
          id: messageId,
          flatIndex,
          text,
          mentions,
        });
        continue;
      }

      // --- AI assistant message ---
      if (role === 'ai' && kind === 'assistant') {
        const markdownRoot = wrapper.querySelector('.markdown-root');
        const text = (markdownRoot?.textContent || wrapper.textContent || '').trim();
        const html = markdownRoot?.innerHTML || '';

        const codeBlockEls = wrapper.querySelectorAll('.composer-message-codeblock');
        const codeBlocks = Array.from(codeBlockEls).map(cb => {
          const headerEl = cb.querySelector('.ui-code-block-header');
          const filenameEl = cb.querySelector('.ui-code-block-filename');
          const codeContent = cb.querySelector('.ui-default-code__content');
          const lines = codeContent
            ? Array.from(codeContent.querySelectorAll('.ui-default-code__line-content'))
                .map(l => l.textContent || '')
                .join('\n')
            : (cb.textContent || '').trim();
          return {
            language: headerEl?.getAttribute('data-language') || undefined,
            filename: filenameEl?.textContent?.trim() || undefined,
            code: lines,
          };
        });

        elements.push({
          type: 'assistant' as const,
          id: messageId,
          flatIndex,
          text,
          html,
          codeBlocks,
        });
        continue;
      }

      // --- Tool call ---
      if (role === 'ai' && kind === 'tool') {
        // Tool call ID and status can be on msgEl or on a nested element
        const toolEl = wrapper.querySelector('[data-tool-call-id]') || msgEl;
        const toolCallId = toolEl.getAttribute('data-tool-call-id') || `tool-${flatIndex}`;
        const toolStatus = (toolEl.getAttribute('data-tool-status') || msgEl.getAttribute('data-tool-status') || 'completed') as 'loading' | 'completed';

        // --- Plan widget (must check before compact summary) ---
        const planContainer = wrapper.querySelector('.composer-create-plan-container');
        if (planContainer) {
          const label = (planContainer.querySelector('.composer-create-plan-label')?.textContent || '').trim();
          const title = (planContainer.querySelector('.composer-create-plan-title')?.textContent || '').trim();
          const descRoot = planContainer.querySelector('.composer-create-plan-text .markdown-root');
          const description = descRoot ? (descRoot.textContent || '').trim() : undefined;

          const todoItems = planContainer.querySelectorAll('.composer-create-plan-todo-item');
          const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
          let todosCompleted = 0;
          let todosTotal = 0;
          for (const item of Array.from(todoItems)) {
            const contentEl = item.querySelector('.composer-create-plan-todo-content');
            if (!contentEl) continue;
            const text = (contentEl.textContent || '').trim();
            if (!text) continue;
            const indicator = item.querySelector('.composer-plan-todo-indicator');
            let status: 'pending' | 'completed' | 'in_progress' = 'pending';
            if (indicator) {
              const cls = indicator.className || '';
              if (cls.includes('completed')) { status = 'completed'; todosCompleted++; }
              else if (cls.includes('in_progress') || cls.includes('in-progress')) status = 'in_progress';
            }
            todosTotal++;
            todos.push({ text, status });
          }

          const todosHeader = (planContainer.querySelector('.composer-create-plan-todos-header')?.textContent || '').trim();
          const headerMatch = todosHeader.match(/(\d+)/);
          if (headerMatch && todosTotal === 0) {
            todosTotal = parseInt(headerMatch[0], 10);
          }

          const actions: { label: string; type: 'view_plan' | 'build'; selectorPath: string }[] = [];
          const viewPlanBtn = planContainer.querySelector('.composer-create-plan-view-plan-button');
          if (viewPlanBtn) {
            actions.push({ label: 'View Plan', type: 'view_plan' as const, selectorPath: buildSelectorPath(viewPlanBtn) });
          }
          const buildBtn = planContainer.querySelector('.composer-create-plan-build-button');
          if (buildBtn) {
            actions.push({ label: 'Build', type: 'build' as const, selectorPath: buildSelectorPath(buildBtn) });
          }

          const modelEl = planContainer.querySelector('.composer-unified-dropdown-model');
          let model: string | undefined;
          if (modelEl) {
            const spans = modelEl.querySelectorAll('span');
            for (const s of Array.from(spans)) {
              const t = (s.textContent || '').trim();
              if (t && !t.includes('chevron') && t.length > 1) { model = t; break; }
            }
          }

          elements.push({
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            description,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
            model,
            actions: actions.length > 0 ? actions : undefined,
          });
          continue;
        }

        // --- Run command widget (must check before compact summary) ---
        const runContainer = wrapper.querySelector('.composer-terminal-tool-call-block-container') ||
          wrapper.querySelector('.composer-tool-call-container.composer-terminal-compact-mode');
        if (runContainer) {
          const descEl = runContainer.querySelector('.composer-terminal-top-header-description');
          const candidatesEl = runContainer.querySelector('.composer-terminal-top-header-candidates');
          const commandEl = runContainer.querySelector('.composer-terminal-command-expanded-text');
          const description = (descEl?.textContent || '').trim();
          const candidates = (candidatesEl?.textContent || '').trim();

          // Dedent command text: .textContent includes HTML source indentation
          let command = '';
          if (commandEl) {
            const rawCmd = commandEl.textContent || '';
            const cmdLines = rawCmd.split('\n');
            const nonEmpty = cmdLines.filter(function(l: string) { return l.trim().length > 0; });
            let minIndent = 0;
            if (nonEmpty.length > 0) {
              minIndent = Infinity;
              for (let li = 0; li < nonEmpty.length; li++) {
                const m = nonEmpty[li].match(/^(\s*)/);
                const len = m ? m[1].length : 0;
                if (len < minIndent) minIndent = len;
              }
            }
            command = cmdLines.map(function(l: string) { return l.length >= minIndent ? l.substring(minIndent) : l; }).join('\n').trim();
          }

          // Collect buttons: distinguish Run from Allowlist (both use .composer-run-button)
          const runActions: { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] = [];
          const skipBtn = runContainer.querySelector('.composer-skip-button');
          if (skipBtn) {
            runActions.push({ label: 'Skip', type: 'skip' as const, selectorPath: buildSelectorPath(skipBtn) });
          }
          const seenPaths = new Set<string>();
          if (skipBtn) seenPaths.add(buildSelectorPath(skipBtn));
          const runBtns = runContainer.querySelectorAll('.composer-run-button');
          for (const btn of Array.from(runBtns)) {
            const path = buildSelectorPath(btn);
            if (seenPaths.has(path)) continue;
            seenPaths.add(path);
            const btnText = (btn.textContent || '').replace(/[⏎⌘⇧]/g, '').trim();
            const isAllowlist = btn.classList.contains('anysphere-secondary-button')
              || btnText.toLowerCase().includes('allow');
            if (isAllowlist) {
              runActions.push({ label: btnText, type: 'allow' as const, selectorPath: path });
            } else {
              runActions.push({ label: 'Run', type: 'run' as const, selectorPath: path });
            }
          }

          elements.push({
            type: 'run_command' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            description,
            candidates,
            command,
            actions: runActions,
          });
          continue;
        }

        // --- Edit file review widget (external file approval) ---
        const editReviewEl = wrapper.querySelector('.composer-edit-file-review-wrapper');
        if (editReviewEl) {
          const filenameEl = editReviewEl.querySelector('.composer-code-block-filename');
          const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;

          const statusSpans = editReviewEl.querySelectorAll('.composer-code-block-status span');
          let additions: number | undefined;
          let deletions: number | undefined;
          for (const s of Array.from(statusSpans)) {
            const t = (s.textContent || '').trim();
            const addM = t.match(/^\+(\d+)$/);
            const delM = t.match(/^-(\d+)$/);
            if (addM) additions = parseInt(addM[1], 10);
            if (delM) deletions = parseInt(delM[1], 10);
          }

          const blockedPill = editReviewEl.querySelector('.block-attribution-pill');
          const blocked = blockedPill
            ? (blockedPill.getAttribute('aria-label') || blockedPill.textContent || '').trim()
            : undefined;

          const statusRow = editReviewEl.querySelector('.composer-tool-call-status-row');
          const editActions: { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] = [];
          if (statusRow) {
            const skipBtn = statusRow.querySelector('.composer-skip-button');
            if (skipBtn) {
              editActions.push({ label: 'Skip', type: 'skip' as const, selectorPath: buildSelectorPath(skipBtn) });
            }
            const seenPaths = new Set<string>();
            if (skipBtn) seenPaths.add(buildSelectorPath(skipBtn));
            const runBtns = statusRow.querySelectorAll('.composer-run-button, .anysphere-secondary-button');
            for (const btn of Array.from(runBtns)) {
              const path = buildSelectorPath(btn);
              if (seenPaths.has(path)) continue;
              seenPaths.add(path);
              const btnText = (btn.textContent || '').replace(/[⏎⌘⇧]/g, '').trim();
              const isAllow = btn.classList.contains('anysphere-secondary-button')
                || btnText.toLowerCase().includes('allow');
              if (isAllow) {
                editActions.push({ label: btnText, type: 'allow' as const, selectorPath: path });
              } else {
                editActions.push({ label: btnText || 'Accept', type: 'run' as const, selectorPath: path });
              }
            }
          }

          elements.push({
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: 'Edit',
            details: '',
            filename,
            additions,
            deletions,
            blocked: blocked || undefined,
            actions: editActions.length > 0 ? editActions : undefined,
          });
          continue;
        }

        // --- Standalone todo list widget ---
        const todoListContainer = wrapper.querySelector('.todo-list-container');
        if (todoListContainer) {
          const headerEl = todoListContainer.querySelector('.todo-list-header-left-title');
          const title = (headerEl?.textContent || 'To-dos').replace(/\d+\s*$/, '').trim();
          const todoItems = todoListContainer.querySelectorAll('.ui-todo-item');
          const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
          let todosCompleted = 0;
          for (const item of Array.from(todoItems)) {
            const contentEl = item.querySelector('.ui-todo-item__content');
            const text = (contentEl?.textContent || '').trim();
            if (!text) continue;
            const cls = item.className || '';
            let status: 'pending' | 'completed' | 'in_progress' = 'pending';
            if (cls.includes('completed')) { status = 'completed'; todosCompleted++; }
            else if (cls.includes('dimmed') || (contentEl && contentEl.className.includes('in-progress'))) { status = 'in_progress'; }
            todos.push({ text, status });
          }
          elements.push({
            type: 'todo_list' as const,
            id: messageId,
            flatIndex,
            title,
            todosCompleted,
            todosTotal: todos.length,
            todos,
          });
          continue;
        }

        // Compact tool summary (collapsed tool messages)
        const compactEl = wrapper.querySelector('.composer-tool-former-message');
        if (compactEl) {
          const spans = compactEl.querySelectorAll('span');
          let actionPart = '';
          let descPart = '';
          for (const s of Array.from(spans)) {
            const txt = (s.textContent || '').trim();
            if (!txt) continue;
            // Skip icon spans (codicon, cursor-icon)
            if (s.classList.toString().includes('codicon') || s.classList.toString().includes('cursor-icon')) continue;
            if (s.classList.contains('truncate-one-line') || s.classList.toString().includes('truncate')) {
              descPart = txt;
            } else if (!actionPart) {
              actionPart = txt;
            }
          }
          const summaryText = (compactEl.textContent || '').trim();
          elements.push({
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: actionPart || '',
            details: descPart || '',
            summaryText: !actionPart && !descPart ? summaryText : undefined,
          });
          continue;
        }

        // Tool call line (e.g. Read terminal, Edit file, etc.)
        const actionEl = wrapper.querySelector('.ui-tool-call-line-action');
        const detailsEl = wrapper.querySelector('.ui-tool-call-line-details');
        let action = (actionEl?.textContent || '').trim();
        let details = (detailsEl?.textContent || '').trim();

        // Edit tool card: filename and change stats
        const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename');
        const additionsEl = wrapper.querySelector('.ui-edit-tool-call__additions');
        const deletionsEl = wrapper.querySelector('.ui-edit-tool-call__deletions');
        const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
        const addMatch = additionsEl ? (additionsEl.textContent || '').match(/\d+/) : null;
        const delMatch = deletionsEl ? (deletionsEl.textContent || '').match(/\d+/) : null;
        const additions = addMatch ? parseInt(addMatch[0], 10) : undefined;
        const deletions = delMatch ? parseInt(delMatch[0], 10) : undefined;

        // Shell tool: command text
        const shellCmd = wrapper.querySelector('.ui-shell-tool-call__command');
        if (shellCmd && !details) details = (shellCmd.textContent || '').trim();

        // Tool card header fallback (for expanded cards without line action)
        if (!action) {
          const cardHeader = wrapper.querySelector('.ui-tool-call-card__header');
          if (cardHeader) action = (cardHeader.textContent || '').trim().split('\n')[0].trim();
        }

        // If still no action, try to get it from the full text content
        if (!action) {
          const fullText = (wrapper.textContent || '').trim();
          if (fullText.length > 0 && fullText.length < 200) {
            action = fullText.substring(0, 60);
          }
        }

        elements.push({
          type: 'tool' as const,
          id: messageId,
          flatIndex,
          toolCallId,
          status: toolStatus,
          action: action || 'Tool',
          details,
          filename: filename || (action === 'Edit' || action === 'Write' ? details : undefined),
          additions,
          deletions,
        });
        continue;
      }

      // --- Fallback: step-group inside a message-group wrapper ---
      if (!role && wrapper.querySelector('.composer-message-group')) {
        const collapseEl = wrapper.querySelector('.ui-collapsible-header');
        if (collapseEl) {
          const spans = collapseEl.querySelectorAll(':scope > span');
          let action = '';
          let detail = '';
          let duration = '';
          for (const s of Array.from(spans)) {
            if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
            const t = (s.textContent || '').trim();
            if (!t) continue;
            if (!action) { action = t; continue; }
            if (t.startsWith('for ')) { duration = t.replace('for ', ''); detail = t; }
            else { detail = t; }
          }
          elements.push({
            type: 'thought' as const,
            id: `thought-${flatIndex}`,
            flatIndex,
            duration,
            action: action || undefined,
            detail: detail || undefined,
          });
        }
      }
    }

    // --- Approval buttons ---
    const pendingApprovals: CursorState['pendingApprovals'] = [];
    const approveButtons: { label: string; selector: string }[] = [];
    const rejectButtons: { label: string; selector: string }[] = [];

    for (const sel of approveSelectors) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const btn of Array.from(btns)) {
          const label = btn.textContent?.trim() || btn.getAttribute('aria-label') || '';
          if (label) approveButtons.push({ label, selector: buildSelectorPath(btn) });
        }
      } catch { /* skip */ }
    }
    if (approveButtons.length === 0 && approveTextMatch.length > 0) {
      for (const btn of Array.from(document.querySelectorAll('button'))) {
        const text = `${btn.textContent?.trim() || ''} ${btn.getAttribute('aria-label') || ''}`.toLowerCase();
        for (const pat of approveTextMatch) {
          if (text.includes(pat.toLowerCase())) {
            approveButtons.push({ label: btn.textContent?.trim() || pat, selector: buildSelectorPath(btn) });
            break;
          }
        }
      }
    }

    for (const sel of rejectSelectors) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const btn of Array.from(btns)) {
          const label = btn.textContent?.trim() || btn.getAttribute('aria-label') || '';
          if (label) rejectButtons.push({ label, selector: buildSelectorPath(btn) });
        }
      } catch { /* skip */ }
    }
    if (rejectButtons.length === 0 && rejectTextMatch.length > 0) {
      for (const btn of Array.from(document.querySelectorAll('button'))) {
        const text = `${btn.textContent?.trim() || ''} ${btn.getAttribute('aria-label') || ''}`.toLowerCase();
        for (const pat of rejectTextMatch) {
          if (text.includes(pat.toLowerCase())) {
            rejectButtons.push({ label: btn.textContent?.trim() || pat, selector: buildSelectorPath(btn) });
            break;
          }
        }
      }
    }

    if (approveButtons.length > 0 || rejectButtons.length > 0) {
      const actions: CursorState['pendingApprovals'][0]['actions'] = [];
      for (const btn of approveButtons) {
        actions.push({
          label: btn.label,
          type: btn.label.toLowerCase().includes('all') ? 'approve_all' : 'approve',
          selectorPath: btn.selector,
        });
      }
      for (const btn of rejectButtons) {
        actions.push({ label: btn.label, type: 'reject', selectorPath: btn.selector });
      }
      pendingApprovals.push({
        id: 'approval-' + Date.now(),
        description: approveButtons[0]?.label || 'Pending approval',
        actions,
      });
    }

    // --- Agent status ---
    const statusEl = findFirst(statusSelectors);
    let agentStatus: CursorState['agentStatus'] = 'idle';
    if (statusEl) {
      const combined = `${(statusEl.textContent || '').toLowerCase()} ${statusEl.classList.toString().toLowerCase()}`;
      if (combined.includes('think')) agentStatus = 'thinking';
      else if (combined.includes('generat')) agentStatus = 'generating';
      else if (combined.includes('running') || combined.includes('execut')) agentStatus = 'running_tool';
      else if (combined.includes('approv') || combined.includes('wait')) agentStatus = 'waiting_approval';
      else if (combined.includes('error') || combined.includes('fail')) agentStatus = 'error';
    }
    if (pendingApprovals.length > 0) agentStatus = 'waiting_approval';

    // Check for loading tools as running_tool status
    if (agentStatus === 'idle' && elements.some(e => e.type === 'loading' || (e.type === 'tool' && e.status === 'loading') || e.type === 'run_command')) {
      agentStatus = 'running_tool';
    }

    const inputEl = findFirst(inputSelectors);

    // --- Chat tabs from agent sidebar/history cells ---
    const chatTabs: ChatTab[] = [];

    function cleanTabTitle(raw: string): string {
      let t = raw.trim().replace(/\s+/g, ' ');
      t = t.replace(/(@[\w./]+)+\s*$/, '');
      return t.trim().substring(0, 120);
    }

    try {
      const seenTitles = new Set<string>();
      let scopeRoot: Element | null = null;
      if (containerComposerId) {
        const allCells = document.querySelectorAll('.agent-sidebar-cell');
        for (const cell of Array.from(allCells)) {
          const cid = cell.getAttribute('data-composer-id') || cell.closest('[data-composer-id]')?.getAttribute('data-composer-id');
          if (cid === containerComposerId) {
            scopeRoot = cell.closest('.agent-sidebar-project-cell') || document.body;
            break;
          }
        }
      }
      if (!scopeRoot && windowTitle) {
        const projectName = projectNameFromTitle(windowTitle).toLowerCase();
        if (projectName) {
          const projectCells = document.querySelectorAll('.agent-sidebar-project-cell');
          for (const cell of Array.from(projectCells)) {
            const labelEl = cell.querySelector('.agent-sidebar-section-title-text') || cell.querySelector('.agent-sidebar-workspace-name') || cell;
            const label = (labelEl.textContent || '').trim().toLowerCase();
            const firstWord = (label.split(/[\s\[\]\-]/)[0] || '').toLowerCase();
            if (label.includes(projectName) || projectName.includes(firstWord) || firstWord === projectName) {
              scopeRoot = cell;
              break;
            }
          }
        }
      }
      for (const sel of chatTabSelectors) {
        let tabItems: NodeListOf<Element>;
        try {
          const root: Element | Document = scopeRoot || document;
          tabItems = root.querySelectorAll(sel);
        } catch {
          continue;
        }
        if (tabItems.length === 0) continue;
        for (const tab of Array.from(tabItems)) {
          if (scopeRoot && !scopeRoot.contains(tab)) continue;
          const titleEl = tab.querySelector('.agent-sidebar-cell-text');
          const rawTitle = titleEl
            ? (titleEl.textContent || '').trim()
            : (tab.getAttribute('aria-label') || tab.textContent || '').trim();
          const title = cleanTabTitle(rawTitle);
          if (!title || seenTitles.has(title)) continue;
          seenTitles.add(title);

          const composerId = tab.getAttribute('data-composer-id')
            || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || `tab-${chatTabs.length}`;
          const selectedAttr = tab.getAttribute('data-selected');
          const highlightedAttr = tab.getAttribute('data-highlighted');
          const isActive = selectedAttr === 'true'
            || highlightedAttr === 'true'
            || tab.classList.contains('selected')
            || tab.classList.contains('active');

          chatTabs.push({
            composerId,
            title,
            isActive,
            status: isActive ? 'active' : 'idle',
            selectorPath: buildSelectorPath(tab),
          });
        }
        if (chatTabs.length > 0) {
          if (containerComposerId) {
            let matched = false;
            for (const t of chatTabs) {
              const match = t.composerId === containerComposerId;
              if (match) {
                matched = true;
                t.isActive = true;
                t.status = 'active';
              }
            }
            if (matched) {
              // composerId match found — mark non-matching tabs inactive
              for (const t of chatTabs) {
                if (t.composerId !== containerComposerId) {
                  t.isActive = false;
                  t.status = 'idle';
                }
              }
            }
            // If composerId matching failed, keep original isActive from DOM attributes
            // (data-selected, data-highlighted, .selected, .active)
          }
          break;
        }
      }
    } catch { /* skip */ }

    // --- Mode extraction ---
    const modeEl = findFirst(modeSelectors);
    let currentMode = 'agent';
    if (modeEl) {
      currentMode = modeEl.getAttribute('data-mode') || 'agent';
    }
    const mode: ModeInfo = {
      current: currentMode,
      available: [
        { id: 'agent', label: 'Agent', icon: 'infinity' },
        { id: 'plan', label: 'Plan', icon: 'todos' },
        { id: 'debug', label: 'Debug', icon: 'bug' },
        { id: 'chat', label: 'Ask', icon: 'chat' },
      ],
    };

    // --- Model extraction ---
    const modelEl = findFirst(modelSelectors);
    let modelName = '';
    let modelId = '';
    if (modelEl) {
      const spans = modelEl.querySelectorAll('span');
      for (const s of Array.from(spans)) {
        const t = (s.textContent || '').trim();
        if (t && !t.includes('chevron') && t.length > 1) {
          modelName = t;
          break;
        }
      }
      modelId = modelEl.getAttribute('id') || '';
    }
    const model: ModelInfo = {
      current: modelName || 'Auto',
      currentId: modelId,
    };

    return {
      connected: true,
      agentStatus,
      messages: elements,
      pendingApprovals,
      inputAvailable: inputEl !== null,
      chatTabs,
      mode,
      model,
      windows: [],
      activeWindowId: '',
    };
  } catch {
    return null;
  }
}

export class DOMExtractor {
  private selectors: SelectorConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private client: CdpClient | null = null;
  private onExtract: (state: CursorState | null) => void;
  private getWindowTitle: () => string;
  private loggedFirstExtraction = false;

  constructor(
    selectors: SelectorConfig,
    onExtract: (state: CursorState | null) => void,
    getWindowTitle: () => string = () => ''
  ) {
    this.selectors = selectors;
    this.onExtract = onExtract;
    this.getWindowTitle = getWindowTitle;
  }

  start(client: CdpClient, intervalMs: number): void {
    this.client = client;
    this.stop();
    console.log(`[dom-extractor] Starting polling every ${intervalMs}ms`);
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
    this.poll();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  private async poll(): Promise<void> {
    if (!this.client || !this.client.isConnected()) {
      this.onExtract(null);
      return;
    }

    try {
      const state = await Promise.race([
        this.client.callFunction(
          extractionFunction as (...args: never[]) => unknown,
          this.selectors.chatContainer.strategies,
          this.selectors.approveButton.strategies,
          this.selectors.approveButton.textMatch ?? [],
          this.selectors.rejectButton.strategies,
          this.selectors.rejectButton.textMatch ?? [],
          this.selectors.chatInput.strategies,
          this.selectors.agentStatus.strategies,
          this.selectors.chatTabList?.strategies ?? [],
          this.selectors.modeDropdown?.strategies ?? [],
          this.selectors.modelDropdown?.strategies ?? [],
          this.getWindowTitle()
        ),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('evaluate timeout')), EVALUATE_TIMEOUT_MS)
        ),
      ]) as CursorState | null;

      if (state && !this.loggedFirstExtraction) {
        this.loggedFirstExtraction = true;
        console.log(`[dom-extractor] First successful extraction:`);
        console.log(`  status: ${state.agentStatus}`);
        console.log(`  messages: ${state.messages.length}`);
        console.log(`  approvals: ${state.pendingApprovals.length}`);
        console.log(`  inputAvailable: ${state.inputAvailable}`);
        console.log(`  chatTabs: ${state.chatTabs.length}`);
        console.log(`  mode: ${state.mode.current}, model: ${state.model.current}`);
        if (state.messages.length > 0) {
          const last = state.messages[state.messages.length - 1];
          const preview = last.type === 'human' ? last.text
            : last.type === 'assistant' ? last.text
            : last.type === 'tool' ? `${last.action} ${last.details}`
            : last.type === 'thought' ? `thought ${last.duration}`
            : last.type === 'plan' ? `${last.label}: ${last.title}`
            : last.type === 'run_command' ? `run: ${last.command.substring(0, 60)}`
            : last.type === 'todo_list' ? `todos: ${last.todosCompleted}/${last.todosTotal}`
            : 'loading';
          console.log(`  last element (${last.type}): "${preview.substring(0, 80)}..."`);
        }
      }

      this.onExtract(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('WebSocket closed') && !message.includes('Intentional disconnect')) {
        console.warn(`[dom-extractor] Extraction failed: ${message}`);
      }
      this.onExtract(null);
    }
  }
}
