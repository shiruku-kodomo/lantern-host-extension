import {readFile} from 'node:fs/promises';
export async function serveSource(page){
 const root=new URL('../',import.meta.url),prefix='/scripts/extensions/third-party/lantern-host-extension/';
 await page.route('**'+prefix+'**',async route=>{
   const relative=decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length));
   if(relative.split('/').includes('..'))return route.abort();
   try{const body=await readFile(new URL(relative,root));await route.fulfill({body,contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'application/json'});}catch{await route.fulfill({status:404,body:'QA source not found'});}
 });
}
