// MCP 工具声明：契约即 schema。模型调前可读，无需额外文档。
export const TOOLS = [
  {
    name: 'dispatch',
    description: '派发一单任务给本机 Codex 或 Claude CLI。参数含 task_id/prompt/workdir 必填；executor 可选 auto|claude|codex；role 可选 planner|implementer|reviewer；其余为可选微调。返回统一契约（status/artifacts/partialOutput/changedFiles）。',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'prompt', 'workdir'],
      properties: {
        task_id: { type: 'string', description: '任务标识，续跑时复用同一 id' },
        prompt: { type: 'string', description: '任务简报/指令全文' },
        workdir: { type: 'string', description: '工作目录绝对路径' },
        executor: { type: 'string', enum: ['auto', 'claude', 'codex'], description: '指定执行器；auto 由引擎路由' },
        role: { type: 'string', enum: ['planner', 'implementer', 'reviewer'], description: '角色画像，决定默认强度/沙箱' },
        model: { type: 'string', description: '精确模型名（astra/sol/terra/luna/fable/opus/sonnet/haiku），优先级高于 role' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], description: '执行沙箱；read-only 禁止改文件' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        timeout_sec: { type: 'integer', description: '超时秒数，默认 1800，上限 14400' },
        env: { type: 'string', enum: ['inherit', 'clean'], description: 'clean 模式剥离计费相关环境变量' },
        force: { type: 'boolean', description: '强制获取写锁（只清理确认已死的锁，不会抢活着的任务）' },
      },
    },
  },
  {
    name: 'status',
    description: '按 job_id 或 task_id 查询任务状态。若进程已结束会自动收尾。',
    inputSchema: {
      type: 'object',
      required: ['ref'],
      properties: { ref: { type: 'string', description: 'job_id 或 task_id' } },
    },
  },
  {
    name: 'resume',
    description: '半自动续跑：对最近一次同 task_id 的失败任务，追加「续跑上下文」后开新 job 重派。quota 耗尽时会在结果里给出 resumeAfter。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        timeout_sec: { type: 'integer' },
        env: { type: 'string', enum: ['inherit', 'clean'] },
        force: { type: 'boolean' },
      },
    },
  },
  {
    name: 'verify',
    description: '独立验收：只看产物（git 改动范围、敏感文件、测试结果），不采信 CLI 自报完成。返回 accepted/rejected/needsHuman。',
    inputSchema: {
      type: 'object',
      required: ['ref'],
      properties: { ref: { type: 'string', description: 'job_id 或 task_id' } },
    },
  },
  {
    name: 'health',
    description: '健康自检：Codex/Claude 是否安装并登录、各角色默认模型解析、计费风险。',
    inputSchema: { type: 'object', properties: { env: { type: 'string', enum: ['inherit', 'clean'] } } },
  },
  {
    name: 'list_jobs',
    description: '列出最近的派发记录（按时间倒序）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '最多条数，默认 20' } },
    },
  },
];

export function toolByName(name) {
  return TOOLS.find((t) => t.name === name) || null;
}
