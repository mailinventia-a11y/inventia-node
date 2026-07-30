import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { phase5OpenApi } from '../src/platform/openapi.js';

const root = process.cwd();
const sourceRoots = ['server.js', 'routes', 'src', 'public/app.js'];
const files = [];

for (const source of sourceRoots) {
  const target = path.join(root, source);
  if (!fs.existsSync(target)) continue;
  if (fs.statSync(target).isDirectory()) walk(target);
  else files.push(target);
}

const failures = [];
for (const file of files.filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}\n${result.stderr}`);
}

if (phase5OpenApi.openapi !== '3.1.0' || !phase5OpenApi.paths['/auth/login']) {
  failures.push('OpenAPI document is missing its required version or login path.');
}

const browserCode = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const forbiddenProductionFallbacks = [
  /proceeding with simulated payment/i,
  /Offline Demo/i,
  /using offline fallback/i,
  /Bearer mock/i,
  /mock-token/i
];
for (const pattern of forbiddenProductionFallbacks) {
  if (pattern.test(browserCode)) failures.push(`Browser code contains forbidden simulated production behavior: ${pattern}`);
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(`Phase 5 checks passed for ${files.length} source files and the OpenAPI document.`);

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else files.push(target);
  }
}
