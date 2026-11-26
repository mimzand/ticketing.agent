/**
 * `yarn eval [suite.json ...]`: runs the golden suite (and any extra suite files) through
 * the real host with a fake, in-process Ollama. Exits 1 when any case fails.
 *
 * `yarn workspace @ticket/eval run feedback <export.json> [--out <dir>]`: turns an
 * override export (GET /v1/tickets:override-feedback) into override cases and few-shot
 * candidates. Writes files only; nothing is sent anywhere and no catalogue changes.
 */
import { DecisionFeedbackSchema, OverrideFeedbackSchema } from '@ticket/shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { categoryFewShotCandidates, decisionFeedbackSuite } from './decision-feedback.js';
import { fewShotCandidates, overrideSuiteFromFeedback } from './feedback.js';
import { GOLDEN_DIR, goldenSuitePaths, loadSuiteFile } from './load.js';
import { comparisonLines, recordCase, RecordInputSchema } from './record.js';
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

/** Reads `<file> [--out <dir>]`. */
function inputAndOut(args: readonly string[]): { input: string | undefined; outDir: string | null } {
  let input: string | undefined;
  let out = 'eval-out';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--out') {
      index += 1;
      out = args[index] ?? '';
    } else input ??= args[index];
  }
  return { input, outDir: out ? resolve(callerDir, out) : null };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(callerDir, path), 'utf8')) as unknown;
  } catch {
    throw new Error(`${basename(path)} could not be read as JSON.`);
  }
}

/** Category/priority feedback export → feedback cases and category few-shot candidates. */
function decisionFeedback(args: readonly string[]): number {
  const { input, outDir } = inputAndOut(args);
  if (!input || !outDir) {
    console.error('Usage: decision-feedback <decision-feedback.json> [--out <dir>]');
    return 2;
  }
  const parsed = DecisionFeedbackSchema.safeParse(readJson(input));
  if (!parsed.success) {
    console.error(`${basename(input)} is not a decision feedback export.`);
    return 1;
  }
  const cases = decisionFeedbackSuite(parsed.data);
  const fewShot = categoryFewShotCandidates(parsed.data);
  mkdirSync(outDir, { recursive: true });
  const casesPath = join(outDir, 'decision-feedback-cases.json');
  const fewShotPath = join(outDir, 'category-few-shot-candidates.json');
  if (cases.file) writeFileSync(casesPath, `${JSON.stringify(cases.file, null, 2)}\n`);
  writeFileSync(fewShotPath, `${JSON.stringify(fewShot.candidates, null, 2)}\n`);
  console.info(`Reviewed decisions read: ${parsed.data.items.length} (taxonomy v${parsed.data.taxonomyVersion})`);
  console.info(
    `Feedback cases: ${cases.file?.cases.length ?? 0}${cases.file ? ` → ${shown(casesPath)}` : ' (no file written)'} (skipped ${cases.skipped.length})`,
  );
  console.info(
    `Category few-shot candidates: ${fewShot.candidates.candidates.length} → ${shown(fewShotPath)} (skipped ${fewShot.skipped.length})`,
  );
  for (const reason of new Set([...cases.skipped, ...fewShot.skipped].map((s) => s.reason))) {
    console.info(`  skipped: ${reason}`);
  }
  return 0;
}

/** True when `path` is the golden folder or inside it. */
function insideGolden(path: string): boolean {
  const rel = relative(GOLDEN_DIR, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Records one live Ollama answer for a synthetic ticket into a new draft suite file.
 * Needs --synthetic. Never writes into packages/eval/golden and never overwrites a file.
 */
async function record(args: readonly string[]): Promise<number> {
  if (!args.includes('--synthetic')) {
    console.error(
      'Refusing to record: pass --synthetic to confirm the input ticket is synthetic or privacy-reviewed. ' +
        'The ticket text is sent to the Ollama server and written to the draft file.',
    );
    return 2;
  }
  const [inputPath, outputPath] = args.filter((arg) => arg !== '--synthetic');
  if (!inputPath || !outputPath) {
    console.error('Usage: record <input.json> <output.json> --synthetic');
    return 2;
  }
  const output = resolve(callerDir, outputPath);
  if (insideGolden(output)) {
    console.error('Refusing to write into packages/eval/golden: review the draft, then move it there yourself.');
    return 2;
  }
  const parsed = RecordInputSchema.safeParse(readJson(inputPath));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    console.error(`${basename(inputPath)} is not a record input: ${issue?.path.map(String).join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`);
    return 2;
  }
  const result = await recordCase(parsed.data, { env: process.env });
  console.info(`Recorded case ${parsed.data.caseId} (suite ${parsed.data.suite}).`);
  for (const line of comparisonLines(parsed.data.expect, result.actual)) console.info(`  ${line}`);
  if (!result.file) {
    console.error('The model gave no answer (the decision is failed). Nothing was written.');
    return 1;
  }
  try {
    writeFileSync(output, `${JSON.stringify(result.file, null, 2)}\n`, { flag: 'wx' });
  } catch {
    console.error(`${shown(output)} already exists or cannot be written. Nothing was overwritten.`);
    return 1;
  }
  console.info(`Draft written: ${shown(output)}`);
  if (result.problems.length > 0) {
    console.error(`The live answer does not meet the expectation: ${result.problems.join('; ')}.`);
    console.error('The expected value was not changed. Review the draft before using it.');
    return 1;
  }
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'run') process.exitCode = await run(rest);
  else if (command === 'feedback') process.exitCode = feedback(rest);
  else if (command === 'decision-feedback') process.exitCode = decisionFeedback(rest);
  else if (command === 'record') process.exitCode = await record(rest);
  else {
    console.error(
      'Usage: cli.ts run [suite.json ...] | feedback <override-feedback.json> [--out <dir>] | ' +
        'decision-feedback <decision-feedback.json> [--out <dir>] | record <input.json> <output.json> --synthetic',
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The eval failed.');
  process.exitCode = 1;
}
