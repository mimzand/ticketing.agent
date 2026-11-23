/**
 * `yarn eval [suite.json ...]`: runs the golden suite (and any extra suite files) through
 * the real host with a fake, in-process Ollama. Exits 1 when any case fails.
 *
 * `yarn workspace @ticket/eval run feedback <export.json> [--out <dir>]`: turns an
 * override export (GET /v1/tickets:override-feedback) into override cases and few-shot
 * candidates. Writes files only; nothing is sent anywhere and no catalogue changes.
 */
import { OverrideFeedbackSchema } from '@ticket/shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fewShotCandidates, overrideSuiteFromFeedback } from './feedback.js';
import { goldenSuitePaths, loadSuiteFile } from './load.js';
import { buildReport, formatReport } from './metrics.js';
import { runSuite } from './run.js';

/**
 * Relative paths are resolved from the repository root (yarn sets PROJECT_CWD), since
 * yarn runs the script inside the package folder.
 */
const callerDir = process.env['PROJECT_CWD'] ?? process.cwd();
const shown = (path: string) => relative(callerDir, path) || basename(path);

async function run(extra: readonly string[]): Promise<number> {
  const paths = [...goldenSuitePaths(), ...extra.map((path) => resolve(callerDir, path))];
  const runs = [];
  for (const path of paths) runs.push(await runSuite(loadSuiteFile(path)));
  const report = buildReport(runs);
  console.info(formatReport(report));
  return report.failed === 0 && report.total > 0 ? 0 : 1;
}

function feedback(args: readonly string[]): number {
  let input: string | undefined;
  let out = 'eval-out';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--out') {
      index += 1;
      out = args[index] ?? '';
    } else input ??= args[index];
  }
  if (!input || !out) {
    console.error('Usage: feedback <override-feedback.json> [--out <dir>]');
    return 2;
  }
  const outDir = resolve(callerDir, out);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(callerDir, input), 'utf8'));
  } catch {
    console.error(`${basename(input)} could not be read as JSON.`);
    return 1;
  }
  const parsed = OverrideFeedbackSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`${basename(input)} is not an override feedback export.`);
    return 1;
  }
  const cases = overrideSuiteFromFeedback(parsed.data);
  const fewShot = fewShotCandidates(parsed.data);
  mkdirSync(outDir, { recursive: true });
  const casesPath = join(outDir, 'override-cases.json');
  const fewShotPath = join(outDir, 'few-shot-candidates.json');
  writeFileSync(casesPath, `${JSON.stringify(cases.file, null, 2)}\n`);
  writeFileSync(fewShotPath, `${JSON.stringify(fewShot.candidates, null, 2)}\n`);
  console.info(`Overrides read: ${parsed.data.items.length} (taxonomy v${parsed.data.taxonomyVersion})`);
  console.info(`Override cases: ${cases.file.cases.length} → ${shown(casesPath)} (skipped ${cases.skipped.length})`);
  console.info(
    `Few-shot candidates: ${fewShot.candidates.candidates.length} → ${shown(fewShotPath)} (skipped ${fewShot.skipped.length})`,
  );
  for (const reason of new Set([...cases.skipped, ...fewShot.skipped].map((s) => s.reason))) {
    console.info(`  skipped: ${reason}`);
  }
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'run') process.exitCode = await run(rest);
  else if (command === 'feedback') process.exitCode = feedback(rest);
  else {
    console.error('Usage: cli.ts run [suite.json ...] | feedback <override-feedback.json> [--out <dir>]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The eval failed.');
  process.exitCode = 1;
}
