import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const modules=['pricing.js','config.js','diagnostics.js','inventory.js','recipe.js',
  'money.js','transport.js','multibuy.js','kit-orders.js','database-settings.js',
  'weapons.js','controls.js','controller.js','bootstrap.js'];
export async function bundle({bootstrap=true}={}) {
  const contents=await Promise.all(modules.filter(n=>bootstrap || n!=='bootstrap.js').map(async n=>
    '// Source: src/'+n+'\n'+(await readFile(path.join(root,'src',n),'utf8')).replace(/^export /gm,'')));
  return await readFile(path.join(root,'src/header.txt'),'utf8')+'\n(function () {\n    \'use strict\';\n'+contents.join('\n')+'\n})();\n';
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const built=await bundle();
  for(const file of ['TF2_Fabricator_Smart_Buyer.user.js','TF2_Fabricator_Smart_Buyer.txt']) {
    if(process.argv.includes('--check')) {
      if(await readFile(path.join(root,file),'utf8')!==built) throw Error(file+' is out of date; run npm run build');
    } else await writeFile(path.join(root,file),built);
  }
  console.log(process.argv.includes('--check')?'Release files match source.':'Built identical .user.js and .txt releases.');
}
