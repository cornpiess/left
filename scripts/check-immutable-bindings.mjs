import { readdir, readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { parseSync, traverse } = require('@babel/core');
const root = resolve(import.meta.dirname, '..');
const paths = ['App.js', 'index.js', ...(await readdir(resolve(root, 'src'), { recursive: true }))
  .filter(path => /\.(mjs|js)$/.test(path)).map(path => 'src/' + path)];
let violations = 0;
const pending = [];

// Metro resolves an extensionless relative import to the sibling `.mjs` when
// one exists, silently hijacking the intended `.js` module. Such imports must
// carry an explicit extension. (Build 54/56 startup failure root cause.)
async function mjsSiblingHijacks(file, spec) {
  try {
    await access(resolve(root, dirname(file), spec + '.mjs'));
    return true;
  } catch {
    return false;
  }
}

for (const file of paths) {
  const code = await readFile(resolve(root, file), 'utf8');
  const ast = parseSync(code, {
    filename: file, configFile: false, babelrc: false, sourceType: 'module', parserOpts: { plugins: ['jsx'] },
  });
  traverse(ast, {
    Scope(path) {
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (binding.kind !== 'const' && binding.kind !== 'module') continue;
        for (const assignment of binding.constantViolations) {
          console.error(`${file}:${assignment.node.loc.start.line}: cannot reassign ${binding.kind} ${name}`);
          violations++;
        }
      }
    },
    ImportDeclaration(path) {
      const spec = path.node.source.value;
      if (!spec.startsWith('.') || /\.(mjs|js|json)$/.test(spec)) return;
      pending.push(mjsSiblingHijacks(file, spec).then(hijacked => {
        if (hijacked) {
          console.error(`${file}:${path.node.loc.start.line}: extensionless import "${spec}" resolves to its .mjs sibling under Metro; write it as "${spec}.js" or "${spec}.mjs" explicitly`);
          violations++;
        }
      }));
    },
  });
}
await Promise.all(pending);
if (violations) process.exitCode = 1;
else console.log(`Immutable binding check passed (${paths.length} source files).`);
