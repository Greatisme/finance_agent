import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

export function codexExecutable() {
  if (process.env.FINANCE_CODEX_BIN) return process.env.FINANCE_CODEX_BIN;
  if (process.platform !== 'win32') return 'codex';
  const packageName = `@openai/codex-win32-${process.arch}`;
  const target = `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`;
  const roots = [process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const root of roots.filter(Boolean)) {
    const npmRoot = path.join(root, 'node_modules', '@openai', 'codex');
    let platformRoot;
    try { platformRoot = path.dirname(require.resolve(`${packageName}/package.json`, { paths: [npmRoot] })); }
    catch { continue; }
    const executable = path.join(platformRoot, 'vendor', target, 'bin', 'codex.exe');
    if (existsSync(executable)) return executable;
  }
  return 'codex.exe';
}

export class CodexSession {
  #child;
  #cwd;
  #closed;
  #nextId = 1;
  #pending = new Map();
  #active;
  #ended;

  constructor({ cwd, env, toolHandler }) {
    this.#cwd = cwd;
    this.#child = spawn(codexExecutable(), ['app-server', '--listen', 'stdio://'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    const child = this.#child;
    this.#closed = new Promise(resolve => child.once('close', resolve));
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    child.once('error', error => this.#end(new Error(`无法启动 Codex：${error.message}`)));
    child.stdin.on('error', error => this.#end(error));
    child.once('close', code => this.#end(new Error(`Codex 已退出（${code}）`)));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.#end(new Error('Codex 返回了无效的 JSON 消息')); this.close(); return; }
      if (message.method && message.id !== undefined) {
        void this.#serverRequest(message, toolHandler);
      } else if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.params?.threadId === this.#active?.threadId && this.#active) {
        const turn = this.#active;
        if (message.method === 'item/agentMessage/delta') turn.onDelta(message.params.delta);
        if (message.method === 'turn/completed') turn.finish(message.params.turn);
      }
    });
  }

  #end(error) {
    if (this.#ended) return;
    this.#ended = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#active?.fail(error);
  }

  #write(message) {
    if (this.#ended) throw this.#ended;
    this.#child.stdin.write(JSON.stringify(message) + '\n');
  }

  async #serverRequest(message, toolHandler) {
    let response;
    if (message.method === 'item/tool/call') {
      const active = this.#active;
      try {
        if (!active || message.params.threadId !== active.threadId) throw new Error('工具调用不属于当前会话');
        const result = await toolHandler(message.params.tool, message.params.arguments);
        response = { result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } };
      } catch (error) {
        response = { result: { success: false, contentItems: [{ type: 'inputText', text: error.message }] } };
      }
    } else {
      response = { error: { code: -32601, message: 'Finance Agent supports application tools only' } };
    }
    if (!this.#ended) this.#write({ id: message.id, ...response });
  }

  request(method, params) {
    if (this.#ended) return Promise.reject(this.#ended);
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'finance_agent', title: 'Finance Agent', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    this.#write({ method: 'initialized' });
  }

  async turn(threadId, text, onDelta) {
    if (this.#active) throw new Error('当前会话已有任务在运行');
    let timer;
    const completion = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Codex 对话等待超时')), 16 * 60_000);
      this.#active = { threadId, onDelta, finish: resolve, fail: reject };
    });
    try {
      const [, turn] = await Promise.all([
        this.request('turn/start', {
          threadId, cwd: this.#cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
          input: [{ type: 'text', text, text_elements: [] }]
        }),
        completion
      ]);
      if (turn.status !== 'completed') throw new Error(turn.error?.message ?? `Codex 对话状态：${turn.status}`);
    } finally {
      clearTimeout(timer);
      this.#active = undefined;
    }
  }

  async close() {
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 3000);
    try { await this.#closed; }
    finally { clearTimeout(timer); }
  }
}
