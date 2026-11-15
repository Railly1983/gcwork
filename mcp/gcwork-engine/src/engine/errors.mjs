// 错误分类 + quota 恢复时间解析（从 2.0.2 移植并精简）。

/**
 * 从 CLI 输出文本推断错误类别。优先识别真实错误，别被无害 WARNING 抢占。
 */
export function classifyError(text) {
  const t = String(text || '');
  if (/model.{0,30}(not found|unavailable|does not exist)|unknown model/i.test(t)) return 'MODEL_UNAVAILABLE';
  if (/hit your usage limit|usage limit|quota|insufficient|exceeded your|out of credits|余额|额度/i.test(t)) return 'QUOTA';
  if (/unauthorized|401|invalid api key|not logged in|authentication|please log ?in|credential/i.test(t)) return 'AUTH';
  if (/no such file|not recognized as an internal|command not found/i.test(t)) return 'NOT_FOUND';
  return 'FAILED';
}

/**
 * 从 quota 报错里尽量解析「何时恢复」，原样透传给专家/用户，不静默重试。
 * @returns {string|null} 形如 "2026-11-15T08:00:00Z" 或自然语言描述。
 */
export function parseResumeAfter(text) {
  const t = String(text || '');
  // ISO 时间
  const iso = t.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
  if (iso) return iso[0];
  // 相对时间：N hours / N 小时 / N minutes
  const rel = t.match(/resets?\s+in\s+(\d+)\s*(hour|minute|小时|分钟)/i)
    || t.match(/(\d+)\s*(hour|minute|小时|分钟)\s*(?:to\s+reset|until\s+reset)/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = /hour|小时/.test(unit) ? n * 3600_000 : n * 60_000;
    return new Date(Date.now() + ms).toISOString();
  }
  // 自然语言兜底
  const phrase = t.match(/(resets?\s+at\s+[^\r\n.]+|恢复时间[：:]\s*[^\r\n]+)/i);
  if (phrase) return phrase[1].trim();
  return null;
}
