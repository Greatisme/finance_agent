import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { CodexSession, codexExecutable } from './codex-session.js';
import { callFinanceTool, dynamicTools } from './assistant-tools.js';

const dataDirectory = path.resolve('data/assistant');
const workspace = path.join(dataDirectory, 'workspace');
const stateFile = path.join(dataDirectory, 'conversation.json');
const env = { ...process.env, CODEX_HOME: path.join(dataDirectory, 'codex-home') };
const instructions = '你是 Finance Agent 软件内置研究助手。使用 finance_read 查询真实数据和实验结果，使用 finance_run 执行用户要求的采集、审计或实验。工具失败或数据缺失时明确说明。不要把历史预测当作实时预测，不要编造行情、得分或投资结论。';

export async function savedThread() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')).threadId; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function saveThread(threadId) {
  const tmp = path.join(dataDirectory, randomUUID() + '.tmp');
  await writeFile(tmp, JSON.stringify({ threadId }) + '\n');
  await rename(tmp, stateFile);
}

export async function openAssistant({ startNew = false, onTool = () => {} } = {}) {
  await prepareAssistant();
  const session = new CodexSession({ cwd: workspace, env, toolHandler: async (name, input) => {
    onTool(name);
    return callFinanceTool(name, input);
  } });
  try {
    await session.initialize();
    const { account, requiresOpenaiAuth } = await session.request('account/read', { refreshToken: false });
    if (!account && requiresOpenaiAuth) {
      const error = new Error('请先在仓库目录运行 node src/assistant.js --login，然后重试。');
      error.code = 'LOGIN_REQUIRED';
      throw error;
    }
    const existing = startNew ? undefined : await savedThread();
    const config = { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never', dynamicTools, developerInstructions: instructions };
    const { thread } = existing
      ? await session.request('thread/resume', { ...config, threadId: existing, excludeTurns: true })
      : await session.request('thread/start', config);
    return { session, thread };
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function prepareAssistant() {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(env.CODEX_HOME, { recursive: true })]);
}
export function runLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn(codexExecutable(), ['login'], { cwd: workspace, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('助手工作空间的 Codex 登录未完成')));
  });
}
