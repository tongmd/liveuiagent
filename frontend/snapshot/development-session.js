(function () {
  'use strict';
  const storageKey = 'liveui.development.sessions.v1';
  let sessions = Object.create(null), sequence = Date.now(), latestTurn = 0, adapter;
  const watching = new Map(), restored = new Set();
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
    latestTurn = ++sequence;
    return { key, requestId, sequence: latestTurn, request, prompt, hostEdit: Boolean(request.developmentConversationId || isHostEdit(prompt)), conversationId: request.developmentConversationId, jobId: null };
  }
  function isHostEdit(prompt) { return typeof prompt === 'string' && /live\s*ui/i.test(prompt) && /(?:修改|修复|改进|调整|更新|重新设计|重做|要改|改一下|fix|modify|edit|debug|update)/i.test(prompt); }
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
    restored.add(data.jobId);
    if (!turn.key || (sessions[turn.key]?.sequence || 0) > turn.sequence) return;
    sessions[turn.key] = { ...sessions[turn.key], conversationId: turn.conversationId, jobId: turn.jobId, requestId: turn.requestId, sequence: turn.sequence, prompt: turn.prompt, active: true, tracking: !data.type };
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
  function deploymentOf(result) { return result?.deployment || result?.development?.deployment; }
  function deployed(deployment, result) { return result?.deployed === true && deployment?.status === 'deployed' && deployment.receipt?.status === 'deployed' && typeof deployment.receipt.transactionId === 'string' && Boolean(deployment.receipt.transactionId.trim()); }
  function statusLabel(deployment, result) {
    if (deployed(deployment, result)) return '已上线';
    return ({ queued: '代码修改已保存，等待自动检查', checking: '正在检查代码与测试', validating: '正在检查代码与测试', reviewing: '正在独立审查', waiting: '等待空闲部署', blocked: '自动部署受阻，尚未上线', rolled_back: '部署检查失败，已回滚', unknown: '部署结果待核查' })[deployment?.status] || '部署结果待核查';
  }
  function resultLabel(result) {
    if (!result?.developmentConversationId) return 'Answered.';
    const deployment = deploymentOf(result);
    if (deployment) return statusLabel(deployment, result.development);
    const validation = result.development?.validation;
    return (validation === 'passed' ? '代码修改已验证' : validation === 'failed' ? '代码测试未通过' : '开发结果已保存') + '，尚未部署。可输入“继续”。';
  }
  function canPresent(turn) { return Boolean(turn && turn.sequence >= latestTurn && (!turn.key || selection() === turn.key)); }
  function remember(turn, values) {
    if (turn.key && sessions[turn.key]?.jobId === turn.jobId && sessions[turn.key].sequence <= turn.sequence) {
      Object.assign(sessions[turn.key], values); save();
    }
  }
  function show(turn, result, label, terminal) {
    if (!canPresent(turn)) return;
    adapter?.present(turn, result, label, terminal);
  }
  function fromJob(turn, job, original) {
    if (job.id !== turn.jobId || job.conversationId !== turn.conversationId) throw Error('开发任务标识不匹配');
    if (job.presentation) return job.presentation;
    const result = { type: 'answered', jobId: job.id, developmentConversationId: job.conversationId, development: job.result || {}, answer: original?.answer || '' };
    if (!result.answer) result.answer = [job.prompt || turn.prompt || 'liveUI 开发任务', job.result?.diff ? '实际修改：\n' + job.result.diff : ''].filter(Boolean).join('\n\n');
    return result;
  }
  function follow(turn, original) {
    if (!adapter || !turn?.jobId || !turn?.conversationId || watching.has(turn.jobId)) return;
    const initial = deploymentOf(original);
    if (original && !initial) { remember(turn, { tracking: false }); return; }
    if (initial && (deployed(initial, original.development) || ['blocked','rolled_back','unknown'].includes(initial.status))) { remember(turn, { tracking: false }); return; }
    const token = {}; watching.set(turn.jobId, token); remember(turn, { tracking: true });
    const deadline = Date.now() + 30 * 60 * 1000;
    let failures = 0, lastLabel = '', lastResult = original;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
      try {
        while (Date.now() < deadline && watching.get(turn.jobId) === token) {
          try {
            const job = await adapter.read(turn.jobId);
            failures = 0;
            const result = fromJob(turn, job, original); lastResult = result;
            const deployment = job.result?.deployment || deploymentOf(result);
            const pending = job.status === 'running';
            const label = pending ? (job.stage || '正在修改代码') : deployment ? statusLabel(deployment, job.result) : job.status === 'done' ? resultLabel(result) : '开发任务未完成，原会话已保留';
            const terminal = !pending && (!deployment || deployed(deployment, job.result) || ['blocked','rolled_back','unknown'].includes(deployment.status));
            if (label !== lastLabel || terminal) { show(turn, result, label, terminal); lastLabel = label; }
            remember(turn, { tracking: !terminal });
            if (terminal) return;
            await wait(2000);
          } catch (error) {
            failures++;
            // Authentication, ownership and business failures are not reconnects.
            if ((error.status && ![502,503,504].includes(error.status)) || failures >= 6) throw error;
            if (failures === 1) show(turn, lastResult, '正在重新连接原开发任务', false);
            await wait(Math.min(1000 * 2 ** (failures - 1), 8000));
          }
        }
        throw Error('本页跟踪已达到时限');
      } catch (_) {
        // Keep the original identity for a refresh or explicit continuation.
        // An interrupted observation says nothing about deployment success.
        show(turn, lastResult, '部署结果待核查，原任务已保留，刷新可继续查看', true);
        remember(turn, { tracking: true });
      } finally { if (watching.get(turn.jobId) === token) watching.delete(turn.jobId); adapter?.removeProgress?.(turn.jobId); }
    })();
  }
  async function recover(turn, error) {
    if (!adapter || !turn || (!turn.hostEdit && !turn.jobId) || error?.code) throw error;
    // Fetch failures and a disconnected SSE have no application error code.
    // The original request may have been accepted: only GET its identity.
    let failures = 0;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        const job = turn.jobId ? await adapter.read(turn.jobId) : await adapter.readRequest(turn.requestId);
        if (!validId(job.id) || !validId(job.conversationId)) throw Object.assign(Error('原任务尚未确认'), { status: 404 });
        observe(turn, { jobId: job.id, developmentConversationId: job.conversationId });
        failures = 0;
        const result = fromJob(turn, job);
        if (job.status === 'done') return result;
        if (job.status !== 'running') throw Object.assign(Error(job.error || '开发任务未完成'), { code: job.code || 'development_failed', jobId: job.id, developmentConversationId: job.conversationId });
        show(turn, result, job.stage || '正在恢复原开发任务', false);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (failure) {
        failures++;
        if (failure.code || (failure.status && ![502,503,504].includes(failure.status)) || failures >= 6) throw failure;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (failures - 1), 8000)));
      }
    }
    throw Object.assign(Error('原开发任务状态待核查，未重复提交'), { jobId: turn.jobId, developmentConversationId: turn.conversationId });
  }
  function attach(nextAdapter) {
    adapter = nextAdapter;
    const key = selection(), previous = key && sessions[key];
    if (!previous?.tracking || previous.active === false || restored.has(previous.jobId) || watching.has(previous.jobId)) return;
    restored.add(previous.jobId);
    const turn = { ...previous, key };
    // Called while React renders; all state updates are deferred.
    setTimeout(() => follow(turn), 0);
  }
  window.LiveUIDevelopment = { begin, observe, stopped, resultLabel, canPresent, follow, attach, recover, isHostEdit };
})();
