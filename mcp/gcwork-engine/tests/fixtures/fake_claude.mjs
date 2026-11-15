#!/usr/bin/env node
// 测试用假 Claude CLI：完整 --help；运行即成功（输出 --output-format json）。
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  process.stdout.write(
    'claude 1.0.0\n'
    + 'Usage: claude [options]\n'
    + '  -p, --print <prompt>     prompt\n'
    + '  --output-format <f>      json\n'
    + '  --permission-mode <m>    plan|dontAsk\n'
    + '  --no-session-persistence\n'
    + '  --model <m>\n  --effort <e>\n  --add-dir <d>\n  --resume <id>\n',
  );
  process.exit(0);
}

let prompt = '';
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-p') { prompt = argv[i + 1]; break; }
}

const isResume = prompt.includes('[续跑上下文]');
const result = isResume ? 'claude done: RESUME now' : `claude done: ${(prompt.split('\n')[0]) || ''}`;
try { writeFileSync('gcw_fixture_out.txt', 'ok\n'); } catch { /* 忽略 */ }
process.stdout.write(JSON.stringify({ result, is_error: false }) + '\n');
process.exit(0);
