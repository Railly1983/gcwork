#!/usr/bin/env node
// 测试用假 Codex CLI：首次失败（quota），带续跑上下文后成功。用于半自动续跑 e2e。
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  process.stdout.write(
    'codex-cli 0.1.0\n'
    + 'Usage: codex exec [options]\n'
    + '  -s, --sandbox <s>\n  -m, --model <m>\n  -c, --config <c>\n  -o, --output <o>\n'
    + '  --skip-git-repo-check\n  --json\n  --ephemeral\n  --color <c>\n',
  );
  process.exit(0);
}

let outPath = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-o') { outPath = argv[i + 1]; break; }
}

let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  if (data.includes('[续跑上下文]')) {
    if (outPath) writeFileSync(outPath, 'codex done: RESUME now\n', 'utf8');
    try { writeFileSync('gcw_fixture_out.txt', 'resume ok\n'); } catch { /* 忽略 */ }
  } else {
    process.stdout.write(JSON.stringify({
      type: 'turn.failed',
      error: { message: 'quota exceeded your limit, resets in 2 hours' },
    }) + '\n');
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
