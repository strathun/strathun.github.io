// Runs every subs/dev/checks-*.cjs against one local server and prints a summary.
// Usage (from the repo root): node subs/dev/run.cjs
// Exit code is 1 if any check fails.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./harness.cjs');

(async () => {
  const server = await startServer(Number(process.env.PORT) || 0);
  const env = { ...process.env, BASE_URL: server.url };
  const files = fs.readdirSync(__dirname).filter((f) => /^checks-.*\.cjs$/.test(f)).sort();

  const failed = [];
  for (const file of files) {
    console.log(`\n── ${file}`);
    // Async spawn: the server runs in this process, so it must keep serving meanwhile.
    const code = await new Promise((resolve) => {
      spawn(process.execPath, [path.join(__dirname, file)], { env, stdio: 'inherit' }).on('exit', resolve);
    });
    if (code !== 0) failed.push(file);
  }

  await server.close();
  console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : `\nall ${files.length} check files passed`);
  process.exitCode = failed.length ? 1 : 0;
})();
