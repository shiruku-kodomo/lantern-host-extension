import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelClient} from '../src/provider.js';
import {normalizeSettings} from '../src/core.js';
test('model turns and compression wait without a local deadline, ignore legacy timeout settings and still allow explicit cancellation',async()=>{
 const realTimer=globalThis.setTimeout,timers=[];globalThis.setTimeout=(callback,delay)=>{timers.push({callback,delay});return 0;};
 try{
   for(const method of ['turn','chat']){
     let release,signal;const external=new AbortController();const client=new ModelClient({headers:()=>({})},(url,options)=>{signal=options.signal;return new Promise((resolve,reject)=>{release=()=>resolve(new Response(JSON.stringify({choices:[{message:{content:'实际返回结果'},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}}));options.signal?.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});});client.resolve=async()=>({baseUrl:'https://example.test/v1'});
     const pending=client[method]({protocol:'openai',model:'qa',baseUrl:'https://example.test/v1',timeoutSeconds:1},[],{signal:external.signal});await new Promise(setImmediate);
     assert.equal(timers.length,0);assert.equal(signal,external.signal);assert.equal(signal.aborted,false);release();const result=await pending;assert.equal(method==='turn'?result.text:result,'实际返回结果');
     const stopped=client[method]({model:'qa',baseUrl:'https://example.test/v1'},[],{signal:external.signal});await new Promise(setImmediate);external.abort(new Error('玩家停止'));await assert.rejects(stopped,/玩家停止/);
   }
 }finally{globalThis.setTimeout=realTimer;}
});
test('legacy connection timeout configuration is removed while all other profile values remain',()=>{
 const settings=normalizeSettings({profiles:[{id:'p',model:'qa',baseUrl:'https://example.test/v1',timeoutSeconds:90,apiKey:'fixture-only',stepMaxTokens:8192}]});assert.equal('timeoutSeconds' in settings.profiles[0],false);assert.equal(settings.profiles[0].stepMaxTokens,8192);assert.equal(settings.profiles[0].apiKey,'fixture-only');
});
