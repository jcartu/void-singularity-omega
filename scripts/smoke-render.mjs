import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const ROOT = new URL('../dist/', import.meta.url).pathname;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.map':'application/json'};
const srv=createServer(async(req,res)=>{try{let p=normalize(decodeURIComponent(req.url.split('?')[0]));if(p==='/'||p.endsWith('/'))p='/index.html';const b=await readFile(join(ROOT,p));res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp'});res.end(b);}catch{res.writeHead(404);res.end('404');}});
await new Promise(r=>srv.listen(0,r));const url=`http://localhost:${srv.address().port}/`;
const b=await chromium.launch({args:['--enable-unsafe-webgpu','--use-gl=angle','--ignore-gpu-blocklist','--use-angle=vulkan']});
let fails=0;const F=m=>{fails++;console.log('FAIL',m);};const P=m=>console.log('PASS',m);
try{const pg=await(await b.newContext({viewport:{width:1280,height:720}})).newPage();const errs=[];
pg.on('console',m=>m.type()==='error'&&errs.push(m.text()));pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(url,{waitUntil:'networkidle',timeout:30000});
(await pg.evaluate(()=>document.getElementById('fatal')?.classList.contains('show')))?F('boot hit FATAL'):P('no fatal');
const hook=await pg.waitForFunction(()=>!!window.__OMEGA__,null,{timeout:20000}).then(()=>1).catch(()=>0);
hook?P('__OMEGA__ present'):F('engine hook missing');
if(hook){const cap=await pg.evaluate(()=>window.__OMEGA__.cap);(cap?.webgpu||cap?.webgl2)?P('backend '+JSON.stringify(cap)):F('no GPU backend');
await pg.waitForTimeout(2500);
const blank=await pg.evaluate(()=>{const c=document.getElementById('stage');const t=document.createElement('canvas');t.width=32;t.height=32;t.getContext('2d').drawImage(c,0,0,32,32);const d=t.getContext('2d').getImageData(0,0,32,32).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]>12||d[i+1]>16||d[i+2]>24)n++;return n<8;});
blank?F('canvas BLANK (clear-color only)'):P('canvas has content');}
errs.length?F('console errors: '+errs.slice(0,5).join(' | ')):P('no console errors');
await pg.screenshot({path:'artifacts/smoke-render.png'});
}catch(e){F('harness threw '+e);}finally{await b.close();srv.close();}
console.log(fails?`\nRENDER SMOKE: FAIL (${fails})`:'\nRENDER SMOKE: PASS');process.exit(fails?1:0);
