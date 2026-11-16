// codex app-server 连接层。只做三件事：起进程、握手、收发 JSON-RPC。
//
// 协议要点（实测 codex-cli 0.166.0）：
// - 逐行 JSON，不是 Content-Length 帧。
// - initialize 响应后必须发 initialized 通知，否则后续请求不返回。
// - 服务端反向请求（审批弹窗）必须应答，否则 turn 会一直等。
// - thread 同时只允许一个 writer：已存在的连接不退出，新连接 resume 会被拒
//   （-32600 already has an active writer）。所以续跑前必须确保旧连接已断开。
import { spawn } from 'node:child_process';

const READY_TIMEOUT_MS = 30_000;
const REQ_TIMEOUT_MS = 60_000;

export class AppServer {
  constructor({ entry, env = process.env, onEvent = null }) {
    this.entry = entry;
    this.env = env;
    this.onEvent = onEvent;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderrTail = [];
    this.dead = null; // 断开原因，一旦设置就不可恢复
  }

  /** 起进程并完成握手。重复调用无副作用。 */
  async start() {
    if (this.child && !this.dead) return;
    this.spawnChild();
    await this.request('initialize', {
      clientInfo: { name: 'codex-dispatch', version: '3.0.0' },
      capabilities: {},
    }, READY_TIMEOUT_MS);
    this.notify('initialized', {});
  }

  spawnChild() {
    // .js 入口用当前 node 起；.cmd/.bat 走 cmd /c；其余直接起
    const e = String(this.entry || '');
    let cmd = e;
    let args = ['app-server'];
    if (/\.(js|mjs|cjs)$/i.test(e)) { cmd = process.execPath; args = [e, 'app-server']; }
    else if (/\.(cmd|bat)$/i.test(e) && process.platform === 'win32') {
      cmd = this.env.ComSpec || 'cmd.exe'; args = ['/c', e, 'app-server'];
    }

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false, // 与 MCP 进程同生共死，不留孤儿
      env: this.env,
    });
    this.child = child;
    this.dead = null;
    this.buf = '';

    child.stdout.on('data', (d) => this.onData(d));
    child.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (!t || /stale arg0|failed to clean up/i.test(t)) return;
      this.stderrTail.push(t.slice(0, 300));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    // 管道断裂会抛 EPIPE，不接会把整个宿主进程带走
    for (const s of [child.stdin, child.stdout, child.stderr]) {
      s.on('error', (e) => { this.dead = `管道错误：${e && e.message}`; });
    }
    child.on('error', (e) => { this.dead = `启动失败：${e && e.message}`; });
    child.on('exit', (code) => this.failAll(`app-server 退出 code=${code}`));
  }

  onData(d) {
    this.buf += d.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    // 有 method 是请求或通知；没有 method 且带 id 才是响应。
    // 顺序反了会把服务端反向请求当响应吃掉。
    if (typeof msg.method !== 'string') {
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }

    // 服务端反向请求：只对会阻塞执行的几类做自动应答，其余明确拒绝。
    if (msg.id !== undefined) {
      this.answerServerRequest(msg);
      return;
    }

    if (this.onEvent) {
      try { this.onEvent(msg.method, msg.params || {}); } catch { /* 订阅者异常不影响连接 */ }
    }
  }

  send(obj) {
    if (!this.child || this.dead) throw new Error(this.dead || 'app-server 未启动');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = REQ_TIMEOUT_MS) {
    if (!this.child || this.dead) {
      return Promise.reject(new Error(this.dead || 'app-server 未启动'));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  /** 反向请求应答：沙箱/审批一律放行或拒绝，绝不让任务卡在无人处理的弹窗上。 */
  answerServerRequest(msg) {
    const m = String(msg.method || '');
    let result = null;
    if (/Approval$/i.test(m) || /RequestApproval/i.test(m) || /requestUserInput/i.test(m)) {
      // 默认拒绝交互式审批：任务全在沙箱内跑，不该有需要人工点确认的操作
      this.send({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32601, message: 'codex-dispatch 不支持交互式审批，请用沙箱策略规避' },
      });
      return;
    }
    try { this.send({ jsonrpc: '2.0', id: msg.id, result }); } catch { /* 连接已断 */ }
  }

  failAll(reason) {
    this.dead = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.reject(new Error(reason)); } catch { /* 忽略 */ }
    }
    this.pending.clear();
  }

  /** 关闭连接。续跑前必须调用，否则新连接会撞 active writer。 */
async close() {
    const c = this.child;
    this.child = null;
    this.failAll('连接已关闭');
    if (!c) return;
    try { c.stdin.end(); } catch { /* 忽略 */ }
    try { c.kill(); } catch { /* 忽略 */ }
    // 等进程真的退出，否则马上 resume 仍会撞 writer。
    // 上限 2 秒：任务结束/服务退出时不该被这个等待拖住。
    await new Promise((resolve) => {
      if (c.exitCode !== null || c.signalCode) { resolve(); return; }
      const t = setTimeout(resolve, 2000);
      c.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}