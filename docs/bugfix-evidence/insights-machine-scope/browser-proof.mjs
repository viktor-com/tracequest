import { chromium } from '/home/everlier/code/tq-wt/tq-fix-08/node_modules/playwright/index.mjs';
import { writeFileSync } from 'node:fs';
const phase = process.argv[2];
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];
 page.on('pageerror', e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:18088/insights');
 await page.getByRole('textbox',{name:'Filter sessions'}).fill('source:codex');
 await Promise.all([page.waitForURL(/expr=source/),page.getByRole('button',{name:'Apply'}).click()]);
 await Promise.all([page.waitForURL(/days=7/),page.getByRole('link',{name:'last 7 days',exact:true}).click()]);
 const state=async()=>({url:page.url(),expression:await page.getByRole('textbox',{name:'Filter sessions'}).inputValue(),range:await page.locator('.ins-range [aria-current="true"]').allTextContents(),activeChips:await page.locator('a.ins-chip[aria-current="true"]').allTextContents(),fedoraHref:await page.locator('[data-insight="machines"] [data-host="fedora"] a').getAttribute('href'),totals:await page.locator('.ins-tile').allTextContents()});
 const before=await state();
 await page.screenshot({path:`/tmp/tq-fix-08-evidence/${phase}-before.png`,fullPage:true});
 await Promise.all([page.waitForURL(/host=fedora/),page.locator('[data-insight="machines"] [data-host="fedora"] a').click()]);
 const after=await state();
 await page.screenshot({path:`/tmp/tq-fix-08-evidence/${phase}-after.png`,fullPage:true});
 const result={phase,before,after,errors};
 writeFileSync(`/tmp/tq-fix-08-evidence/${phase}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
