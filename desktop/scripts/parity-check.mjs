/**
 * 跨实现一致性校验：TypeScript 路由内核 vs Python 路由内核。
 *
 * 为什么需要它：桌面端为了不依赖 Python 运行时，把路由算法移植成了 TypeScript。
 * 移植一旦与 Python 版漂移，评测跑出来的 99% 准确率就不再代表产品行为。
 * 这个脚本用同一份 234 条用例逐条比对两边的路由结论，把漂移变成可发现的失败。
 *
 * 用法::
 *
 *     # 先生成基准（Python 侧）
 *     python -m ai_router.evaluator --dump-fixture desktop/tests/fixtures/routing-parity.json
 *
 *     # 再校验（Node 侧，会自动用 esbuild 打包 TS）
 *     cd desktop && node scripts/parity-check.mjs
 */

import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const fixturePath = path.join(desktopRoot, 'tests', 'fixtures', 'routing-parity.json');

async function main() {
  if (!existsSync(fixturePath)) {
    console.error(`缺少基准文件：${fixturePath}`);
    console.error('请先运行：python -m ai_router.evaluator --dump-fixture desktop/tests/fixtures/routing-parity.json');
    process.exit(2);
  }

  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const workDir = await mkdtemp(path.join(tmpdir(), 'ai-router-parity-'));

  // 用 esbuild 把 TS 路由内核打成一个临时 ESM 模块，Node 直接跑。
  const entryPath = path.join(workDir, 'entry.ts');
  const outPath = path.join(workDir, 'entry.mjs');

  await writeFile(
    entryPath,
    `import { decide } from ${JSON.stringify(path.join(desktopRoot, 'src/main/router/analyze.ts'))};\n` +
      `export function run(prompt, localModel) {\n` +
      `  const decision = decide(prompt, { localModel, installedModels: [localModel], enablePruning: true });\n` +
      `  return {\n` +
      `    route: decision.route,\n` +
      `    score: decision.analysis.signalScore,\n` +
      `    strategy: decision.strategy,\n` +
      `    signals: decision.analysis.signals.map((s) => \`\${s.name}(\${s.weight})\`),\n` +
      `  };\n` +
      `}\n`,
    'utf8',
  );

  await build({
    entryPoints: [entryPath],
    outfile: outPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
  });

  const mod = await import(pathToFileURL(outPath).href);

  let routeMismatch = 0;
  let scoreMismatch = 0;
  const examples = [];
  const scoreExamples = [];

  for (const item of fixture.cases) {
    const result = mod.run(item.prompt, fixture.localModel);

    if (result.route !== item.route) {
      routeMismatch += 1;
      if (examples.length < 12) {
        examples.push({
          prompt: item.prompt,
          pythonRoute: item.route,
          tsRoute: result.route,
          pythonScore: item.score,
          tsScore: result.score,
        });
      }
      continue;
    }

    if (Math.abs(result.score - item.score) > 0.001) {
      scoreMismatch += 1;
      if (scoreExamples.length < 10) {
        scoreExamples.push({
          prompt: item.prompt,
          pythonScore: item.score,
          tsScore: result.score,
          tsSignals: result.signals.join(' '),
        });
      }
    }
  }

  await rm(workDir, { recursive: true, force: true });

  const total = fixture.cases.length;
  const agree = total - routeMismatch;

  console.log('='.repeat(72));
  console.log('TS / Python 路由一致性校验');
  console.log('='.repeat(72));
  console.log(`基准来源：${path.relative(repoRoot, fixturePath)}`);
  console.log(`基准模型：${fixture.localModel}`);
  console.log(`用例总数：${total}`);
  console.log(`路由一致：${agree}（${((agree / total) * 100).toFixed(2)}%）`);
  console.log(`路由不一致：${routeMismatch}`);
  console.log(`分数不一致：${scoreMismatch}`);

  if (examples.length) {
    console.log();
    console.log('路由差异样例：');
    for (const example of examples) {
      const prompt = example.prompt.length > 44 ? `${example.prompt.slice(0, 41)}...` : example.prompt;
      console.log(
        `  py=${example.pythonRoute}(${example.pythonScore}) ts=${example.tsRoute}(${example.tsScore}) ` +
          `${example.note ?? ''} ${prompt}`,
      );
    }
  }

  if (scoreExamples.length) {
    console.log();
    console.log('分数差异样例（结论一致，仅累加值不同）：');
    for (const example of scoreExamples) {
      const prompt = example.prompt.length > 40 ? `${example.prompt.slice(0, 37)}...` : example.prompt;
      console.log(`  py=${example.pythonScore} ts=${example.tsScore}  ${prompt}`);
      console.log(`      ts signals: ${example.tsSignals}`);
    }
  }

  // 分数差异不直接判失败（可能只是本机模型不同导致的剪枝差异），
  // 但差异超过 20% 的用例数会给出来，便于发现真实漂移。
  const drift = scoreExamples.filter(
    (example) => Math.abs(example.tsScore - example.pythonScore) > Math.max(2, Math.abs(example.pythonScore) * 0.2),
  ).length;

  if (routeMismatch > 0) {
    console.log();
    console.error(`一致性校验失败：${routeMismatch} 条路由结论不同。`);
    process.exit(1);
  }

  console.log();
  if (drift > 0) {
    console.log(`通过（路由一致）。注意：有 ${drift} 条分数差异较大，建议检查对应检测器。`);
  } else {
    console.log('通过：两个实现的路由结论完全一致。');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
