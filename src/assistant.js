import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CodexSession, codexExecutable } from './codex-session.js';
import { callFinanceTool, dynamicTools } from './assistant-tools.js';

const dataDirectory = path.resolve('data/assistant');
const workspace = path.join(dataDirectory, 'workspace');
const stateFile = path.join(dataDirectory, 'conversation.json');
const env = { ...process.env, CODEX_HOME: path.join(dataDirectory, 'codex-home') };
const instructions = '你是 Finance Agent 软件内置研究助手。使用 finance_read 查询真实数据和实验结果，使用 finance_run 执行用户要求的采集、审计或实验。工具失败或数据缺失时明确说明。不要把历史预测当作实时预测，不要编造行情、得分或投资结论。';

async function savedThread() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')).threadId; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function saveThread(threadId) {
  const tmp = path.join(dataDirectory, randomUUID() + '.tmp');
  await writeFile(tmp, JSON.stringify({ threadId }) + '\n');
  await rename(tmp, stateFile);
}

function runLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn(codexExecutable(), ['login'], { cwd: workspace, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('助手工作空间的 Codex 登录未完成')));
  });
}

async function chat(startNew) {
  const session = new CodexSession({ cwd: workspace, env, toolHandler: async (name, input) => {
    console.error('[软件工具] ' + name);
    return callFinanceTool(name, input);
  } });
  try {
    await session.initialize();
    const { account, requiresOpenaiAuth } = await session.request('account/read', { refreshToken: false });
    if (!account && requiresOpenaiAuth) throw new Error('请先运行 node src/assistant.js --login 登录此工作空间。');
    const existing = startNew ? undefined : await savedThread();
    const config = { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never', dynamicTools, developerInstructions: instructions };
    const { thread } = existing
      ? await session.request('thread/resume', { ...config, threadId: existing, excludeTurns: true })
      : await session.request('thread/start', config);
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    console.error('Finance Agent · ' + thread.id + ' · /exit 退出');
    try {
      if (process.stdin.isTTY) {
        input.setPrompt('你 > ');
        input.prompt();
      }
      for await (const line of input) {
        const message = line.trim();
        if (message === '/exit') break;
        if (message) {
          await session.turn(thread.id, message, delta => process.stdout.write(delta));
          await saveThread(thread.id);
          process.stdout.write('\n');
        }
        if (process.stdin.isTTY) input.prompt();
      }
    } finally { input.close(); }
  } finally { await session.close(); }
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--login', '--new'].includes(args[0]))) {
    throw new Error('用法：node src/assistant.js [--login | --new]');
  }
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(env.CODEX_HOME, { recursive: true })]);
  if (args[0] === '--login') await runLogin();
  else await chat(args[0] === '--new');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
