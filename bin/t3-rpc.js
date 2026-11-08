import { dispatchT3Commands } from "../src/ws-rpc.js";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}
const request = JSON.parse(input);

try {
  const results = await dispatchT3Commands({
    cli: request.cli,
    baseDir: request.baseDir,
    url: request.url,
    commands: request.commands,
  });
  process.stdout.write(`${JSON.stringify(results)}\n`);
} catch (err) {
  process.stderr.write(`${err.message || err}\n`);
  process.exit(1);
}
