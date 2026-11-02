// Fake CLI for JobManager tests. Modes via argv[2]: (none) | flood
import readline from 'node:readline';

console.log('READY');
console.log('CWD:' + process.cwd());

if (process.argv[2] === 'flood') {
  const line = 'x'.repeat(98) + '\n';
  for (let i = 0; i < 21000; i++) process.stdout.write(line); // ~2 MB
  process.stdout.write('LAST-MARKER\n', () => setTimeout(() => process.exit(0), 300));
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'quit') process.exit(3);
    console.log('ECHO:' + line);
  });
}
