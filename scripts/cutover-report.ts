import { readFileSync } from 'node:fs';
import { evaluateCutoverEvidence } from '../src/cutover/evidence';

const limitations = ['observed-idle is not deployment or rollback authorization'];
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input' || !args[1] || /^[a-z][a-z\d+.-]*:/i.test(args[1])) {
    throw new Error('invalid evidence');
  }
  const report = evaluateCutoverEvidence(JSON.parse(readFileSync(args[1], 'utf8')));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'observed-idle' ? 0 : 2;
} catch {
  process.stdout.write(`${JSON.stringify({ error: 'invalid evidence', limitations })}\n`);
  process.exitCode = 1;
}
