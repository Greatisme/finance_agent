import { createInterface } from 'node:readline';
import { openAssistant, prepareAssistant, runLogin, saveThread } from './assistant-runtime.js';

async function chat(startNew) {
  const { session, thread, storage } = await openAssistant({ startNew, onTool: name => console.error('[软件工具] ' + name) });
  try {
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
          await saveThread(thread.id, storage);
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
  await prepareAssistant();
  if (args[0] === '--login') await runLogin();
  else await chat(args[0] === '--new');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
