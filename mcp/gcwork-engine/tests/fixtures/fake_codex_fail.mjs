#!/usr/bin/env node
// 测试用假 Codex CLI：始终失败（turn.failed + quota 文案），不写 -o 文件。
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

// 失败：输出 turn.failed，不带 -o
process.stdout.write(JSON.stringify({
  type: 'turn.failed',
  error: { message: 'quota exceeded your limit, resets in 2 hours' },
}) + '\n');
process.exit(0);
