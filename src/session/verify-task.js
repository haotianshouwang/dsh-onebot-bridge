// 任务验证器：把「计划步骤是否有真实工具记录」「指定工具的状态/输出」「回读字段」变成可复用判定。
//
// 边界：只读，不改变任务状态；TaskRunner 或管理员拿到 {ok,note} 后再写 verification。
// 旧任务的步骤没有 planIndex/state，按 step.index 与 outcome 子串兼容。
export function createVerifyTask({actions, permissions, store, getBot, getMemory}) {
  return async function verifyTask({task}) {
    const method = task?.verificationMethod || 'manual';
    const spec = task?.verificationSpec || {};
    const steps = Array.isArray(task?.steps) ? task.steps : [];

    if (method === 'manual') return {ok: false, note: '需要人工验证'};

    if (method === 'steps') {
      const missing = (task.plan || []).filter((_, index) => {
        const planned = index + 1;
        return !steps.some(step => {
          if (step.status !== 'done' || !String(step.tool || '').trim()) return false;
          const position = Number(step.planIndex) > 0 ? Number(step.planIndex) : Number(step.index);
          if (position !== planned) return false;
          // 新步骤必须真正 confirmed；submitted/accepted 只证明已提交，不能自动完成任务。
          if (step.state) return step.state === 'confirmed' && step.verified === true;
          // 旧任务没有 state/verified，保守兼容明确的 confirmed outcome。
          return /(^|,)confirmed(,|$)/.test(String(step.outcome || ''));
        });
      });
      return missing.length
        ? {ok: false, note: '计划步骤缺少已确认的工具记录：' + missing.length}
        : {ok: true, note: '所有计划步骤均有已确认的工具记录'};
    }

    if (method === 'tool') {
      const capability = String(spec.capability || '');
      const expected = String(spec.outcome || '');
      const wantState = String(spec.state || '');
      const rows = steps.filter(step => step.status === 'done' && String(step.tool || '').split(',').includes(capability));
      if (!rows.length) return {ok: false, note: '没有找到指定工具的成功记录'};
      if (wantState && !rows.some(step => step.state === wantState)) {
        return {ok: false, note: '工具状态不符合期望：' + (rows.map(step => step.state || 'unknown').join(','))};
      }
      if (expected && !rows.some(step => String(step.outcome || '').includes(expected))) {
        return {ok: false, note: '工具结果不符合期望'};
      }
      return {ok: true, note: '指定工具记录满足条件'};
    }

    if (method === 'memory') {
      const id = String(spec.memoryId || '');
      const row = getMemory?.()?.get(id);
      if (!row) return {ok: false, note: '验证记忆不存在'};
      if (!row.source_url) return {ok: false, note: '记忆没有来源网址'};
      if (Number(row.expires_at) > 0 && Number(row.expires_at) <= Date.now()) return {ok: false, note: '记忆已经过期'};
      if (spec.minConfidence !== undefined && Number(row.confidence) < Number(spec.minConfidence)) return {ok: false, note: '记忆可信度低于要求'};
      return {ok: true, note: '记忆存在且来源/时效满足要求'};
    }

    if (method === 'readback') {
      const capability = String(spec.capability || '');
      const owner = store.data.framework.ownerQQ;
      const botId = getBot?.()?.status?.bot;
      if (!owner || !botId) return {ok: false, note: '无法建立回读上下文'};
      const cap = actions.definitions.get(capability);
      if (!cap) return {ok: false, note: '回读动作不存在'};
      let args = {};
      if (spec.args) {
        try {
          args = typeof spec.args === 'string' ? JSON.parse(spec.args) : spec.args;
        } catch {
          return {ok: false, note: '回读参数不是合法 JSON'};
        }
      }
      const msg = {
        type: 'message', bot: botId, kind: 'private', peer: owner, key: botId + ':private:' + owner,
        user: owner, id: 'verify-' + Date.now(), time: Date.now() / 1000, text: '任务回读验证',
        mentions: [], sender: '自己', parts: []
      };
      const context = permissions.issue(msg, 'autonomy');
      try {
        const reason = permissions.decision(cap, context);
        if (reason) return {ok: false, note: '回读权限不足：' + reason};
        const result = await actions.invoke(capability, args, context);
        const value = String(spec.path || '').split('.').filter(Boolean).reduce((current, key) => current == null ? undefined : current[key], result);
        const expected = String(spec.equals ?? '');
        return {ok: String(value ?? '') === expected, note: '回读 ' + capability + '=' + String(value ?? '').slice(0, 120)};
      } catch (error) {
        return {ok: false, note: '回读失败：' + String(error?.message || error).slice(0, 160)};
      } finally {
        permissions.close(context);
      }
    }

    return {ok: false, note: '未知验证方式'};
  };
}
