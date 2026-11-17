import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { CodexSession, codexExecutable } from './codex-session.js';
import { callFinanceTool, dynamicTools } from './assistant-tools.js';

const dataDirectory = path.resolve('data/assistant');
const workspace = path.join(dataDirectory, 'workspace');
const stateFile = path.join(dataDirectory, 'conversation.json');
const legacyEnv = { ...process.env, CODEX_HOME: path.join(dataDirectory, 'codex-home') };
const instructions = '你是 Finance Agent 软件内置研究助手。使用 finance_read 查询真实数据和实验结果，使用 finance_run 执行用户要求的采集、审计或实验。工具失败或数据缺失时明确说明。不要把历史预测当作实时预测，不要编造行情、得分或投资结论。';

async function savedConversation() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function savedThread() {
  return (await savedConversation())?.threadId;
}

export async function saveThread(threadId, storage) {
  const tmp = path.join(dataDirectory, randomUUID() + '.tmp');
  await writeFile(tmp, JSON.stringify({ threadId, storage }) + '\n');
  await rename(tmp, stateFile);
}

export async function openAssistant({ startNew = false, onTool = () => {} } = {}) {
  await prepareAssistant();
  const existing = startNew ? undefined : await savedConversation();
  const storage = existing && existing.storage !== 'default' ? 'legacy' : 'default';
  const env = storage === 'legacy' ? legacyEnv : process.env;
  const session = new CodexSession({ cwd: workspace, env, toolHandler: async (name, input) => {
    onTool(name);
    return callFinanceTool(name, input);
  } });
  try {
    await session.initialize();
    const { account, requiresOpenaiAuth } = await session.request('account/read', { refreshToken: false });
    if (!account && requiresOpenaiAuth) {
      const error = new Error(storage === 'legacy'
        ? '旧会话对应的独立 Codex 登录已失效。运行 node src/assistant.js --login 可续接，或用 --new 开始使用默认账号的新会话。'
        : '本机 Codex 尚未登录。运行 node src/assistant.js --login 后重试。');
      error.code = 'LOGIN_REQUIRED';
      throw error;
    }
    const config = { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never', dynamicTools, developerInstructions: instructions };
    const { thread } = existing
      ? await session.request('thread/resume', { ...config, threadId: existing.threadId, excludeTurns: true })
      : await session.request('thread/start', config);
    return { session, thread, storage };
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function prepareAssistant() {
  await mkdir(workspace, { recursive: true });
}
export async function runLogin() {
  const existing = await savedConversation();
  const env = existing && existing.storage !== 'default' ? legacyEnv : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(codexExecutable(), ['login'], { cwd: workspace, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('助手工作空间的 Codex 登录未完成')));
  });
}
