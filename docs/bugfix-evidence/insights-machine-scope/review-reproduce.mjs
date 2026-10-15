import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, copyFileSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const repo='/home/everlier/code/tq-wt/tq-fix-08';
const evidence='/tmp/tq-fix-08-review';
const require=createRequire(join(repo,'package.json'));
const {chromium}=require('playwright');
const home=mkdtempSync(join(tmpdir(),'tq-insights-review-'));
const source='/tmp/tq-fix-08-evidence/home/.local/share/tracequest/hosts/fedora/.codex/sessions/rollout-2026-10-03T08-48-06-01a10085-1c21-7f92-9f76-ca3eceff9178.jsonl';
const originalStats=statSync(source);
const env={...process.env,HOME:home,TRACEQUEST_HOSTS_DIR:join(home,'.local/share/tracequest/hosts'),TRACEQUEST_CACHE_DIR:join(home,'.cache/tracequest'),TRACEQUEST_LIVE_SESSIONS_HOME:home,TRACEQUEST_NO_SIDECAR:'1',TRACEQUEST_SKIP_LR_WATCH:'1',TRACEQUEST_TMUX_BIN:'/nonexistent-tq-independent-review-tmux',TRACEQUEST_TMUX_SOCKET:`tq-independent-review-${process.pid}`,TRACEQUEST_TMUX_SESSION:`tq-independent-review-${process.pid}`};
let server,browser;
const output=[];
try {
  for(const host of ['fedora','mac','local']) {
    const root=host==='local'?home:join(env.TRACEQUEST_HOSTS_DIR,host);
    const dest=join(root,'.codex/sessions','rollout-real-review.jsonl');
    mkdirSync(join(root,'.codex/sessions'),{recursive:true});
    copyFileSync(source,dest);
    // Date range uses discovery mtime. Only disposable copies receive a recent mtime.
    const mtime=host==='local'?originalStats.mtime:new Date();
    utimesSync(dest,mtime,mtime);
  }
  const refresh=spawnSync(process.execPath,[join(repo,'bin/tracequest.js'),'insights','--refresh'],{cwd:repo,env,encoding:'utf8',timeout:60000});
  assert.equal(refresh.status,0,'isolated real recording refresh failed');
  const reservation=createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
  const {port}=reservation.address(); await new Promise(r=>reservation.close(r));
  const base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,[join(repo,'bin/tracequest.js'),'serve','--port',String(port)],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  server.stdout.resume(); server.stderr.resume();
  let ready=false;
  for(let i=0;i<200;i++){assert.equal(server.exitCode,null);try{if((await fetch(base+'/insights')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'isolated server ready');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const machine=host=>page.locator(`[data-insight="machines"] [data-host="${host}"] a`);
  const click=async link=>Promise.all([page.waitForEvent('load'),link.click()]);
  const check=async(label,expr,days,host,count)=>{
    const url=new URL(page.url());
    assert.equal(url.searchParams.get('expr')||'',expr);
    assert.equal(url.searchParams.get('days')||'0',String(days));
    assert.equal(url.searchParams.get('host')||'',host);
    assert.equal(await page.getByRole('textbox',{name:'Filter sessions'}).inputValue(),expr);
    assert.equal(await page.getByRole('navigation',{name:'Time range'}).locator('[aria-current="true"]').textContent(),days?`last ${days} days`:'all time');
    const data=await(await page.request.get(`${base}/api/insights?${url.searchParams}`)).json();
    assert.equal(data.totals.sessions,count);assert.equal(data.totals.analyzed,count);
    const result={label,path:url.pathname+url.search,sessions:data.totals.sessions,analyzed:data.totals.analyzed};output.push(result);
  };
  await page.goto(base+'/insights');
  await page.getByRole('textbox',{name:'Filter sessions'}).fill('source:codex');
  await click(page.getByRole('button',{name:'Apply',exact:true}));
  await click(page.getByRole('link',{name:'last 7 days',exact:true}));
  await check('source + last7 before machine','source:codex',7,'',2);
  await click(machine('fedora'));await check('select Fedora','source:codex',7,'fedora',1);
  await page.reload();await check('reload Fedora','source:codex',7,'fedora',1);
  await click(machine('mac'));await check('switch Mac','source:codex',7,'mac',1);
  await click(machine('local'));await check('switch local empty scope','source:codex',7,'local',0);
  await click(page.getByRole('link',{name:'machine: local ×',exact:true}));await check('clear machine','source:codex',7,'',2);
  await click(page.getByRole('link',{name:'all time',exact:true}));await click(machine('fedora'));await check('all time select Fedora','source:codex',0,'fedora',1);
  await page.goto(base+'/insights?days=7');await click(machine('fedora'));await check('range only','',7,'fedora',1);
  await page.goto(base+'/insights');await click(machine('fedora'));await check('unscoped select Fedora','',0,'fedora',1);
  for(const scheme of ['light','dark']){
    await page.emulateMedia({colorScheme:scheme}); await page.setViewportSize({width:390,height:844});
    await page.goto(base+'/insights?expr=source%3Acodex&days=7');await click(machine('fedora'));await check(`mobile ${scheme} Fedora`,'source:codex',7,'fedora',1);
  }
  await page.setViewportSize({width:1440,height:900});
  const complex='source:codex project:"scope & <review>"';
  await page.goto(`${base}/insights?${new URLSearchParams({expr:complex,days:'30'})}`);
  await click(machine('fedora'));await check('encoded expression with spaces quotes ampersand angle brackets',complex,30,'fedora',0);
  assert.deepEqual(errors,[]);
  assert.equal(statSync(source).mtimeMs,originalStats.mtimeMs);
  writeFileSync(join(evidence,'real-browser-results.json'),JSON.stringify({verdict:'PASS',isolatedHomeRemovedOnExit:true,base,recording:'supplied Fedora Codex recording copy; raw contents not saved in evidence',mtime:'original-copy mtime preserved; only review Fedora/Mac copies set recent for nonempty last7 scope; local copy retains old mtime',checks:output,pageErrors:errors},null,2));
  console.log(JSON.stringify({verdict:'PASS',checks:output.length,pageErrors:errors.length,base}));
} finally {
  await browser?.close();
  if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGKILL');await stopped;}
  rmSync(home,{recursive:true,force:true});
}
