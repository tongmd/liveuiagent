(function () {
  'use strict';
  const storageKey = 'liveui.development.sessions.v1';
  let sessions = Object.create(null), sequence = Date.now();
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value);
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
    for (const [key, value] of Object.entries(stored)) {
      if (validId(value?.conversationId) && validId(value?.jobId) && Number.isFinite(value?.sequence)) {
        sessions[key] = value;
        sequence = Math.max(sequence, value.sequence);
      }
    }
  } catch (_) { /* A storage failure must not block the composer. */ }
  function save() { try { sessionStorage.setItem(storageKey, JSON.stringify(sessions)); } catch (_) {} }
  function selection() {
    const harness = document.querySelector('[aria-label="New app harness"]')?.value;
    const model = document.querySelector('[aria-label="Current model"]')?.value;
    return harness && model ? JSON.stringify([harness, model]) : null;
  }
  function isContinuation(prompt) {
    return /^(?:请\s*)?(?:继续(?:修改|修复|改进|调整|调试)?|接着改|continue)(?:[。.!！\s]*|[，,:：]\s*[\s\S]+)$/i.test(prompt.trim());
  }
  function begin(prompt, requestId) {
    const key = selection(), previous = key && sessions[key];
    const request = previous && previous.active !== false && isContinuation(prompt) ? { developmentConversationId: previous.conversationId } : {};
    return { key, requestId, sequence: ++sequence, request, conversationId: request.developmentConversationId, jobId: null };
  }
  function observe(turn, data) {
    if (!turn || !data) return;
    if (!validId(data.developmentConversationId) || !validId(data.jobId)) {
      // An ordinary completed App/chat request changes the conversation focus.
      // Do not hijack its next “continue” with an older development session.
      if (data.type && turn.key && sessions[turn.key] && sessions[turn.key].sequence <= turn.sequence) {
        sessions[turn.key] = { ...sessions[turn.key], active: false, sequence: turn.sequence };
        save();
      }
      return;
    }
    turn.conversationId = data.developmentConversationId;
    turn.jobId = data.jobId;
    if (!turn.key || (sessions[turn.key]?.sequence || 0) > turn.sequence) return;
    sessions[turn.key] = { conversationId: turn.conversationId, jobId: turn.jobId, requestId: turn.requestId, sequence: turn.sequence, active: true };
    save();
  }
  function stopped(turn, error) {
    observe(turn, error);
    if (!turn?.conversationId) return;
    error.developmentConversationId = turn.conversationId;
    error.jobId = turn.jobId || error.jobId;
    error.clientRequestId = turn.requestId;
    // A disconnected SSE stream may leave the original job running. Continuing
    // preserves that conversation; the server's busy guard prevents a replay.
    error.message += '\n开发会话已保留，可在当前 Harness 和模型下输入“继续”。' + (error.jobId ? '\n任务：' + error.jobId : '');
  }
  function resultLabel(result) {
    if (!result?.developmentConversationId) return 'Answered.';
    const validation = result.development?.validation;
    return (validation === 'passed' ? '代码修改已验证' : validation === 'failed' ? '代码测试未通过' : '开发结果已保存') + '，尚未部署。可输入“继续”。';
  }
  window.LiveUIDevelopment = { begin, observe, stopped, resultLabel };
})();
