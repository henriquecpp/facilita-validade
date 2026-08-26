import { readdir, readFile } from 'node:fs/promises';
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) => (e.isDirectory() ? walk(`${path}/${e.name}`) : `${path}/${e.name}`)),
    )
  ).flat();
}
const files = await walk('backend/src');
const errors = [];
for (const file of files.filter((f) => f.includes('/domain/') && f.endsWith('.ts'))) {
  const code = await readFile(file, 'utf8');
  if (/from\s+['"](?:@nestjs|pg|drizzle|node:|.*adapters|.*infrastructure)/.test(code))
    errors.push(file);
}
if (errors.length) throw new Error(`Domínio depende de infraestrutura: ${errors.join(', ')}`);
console.log('Fronteiras do domínio verificadas.');
