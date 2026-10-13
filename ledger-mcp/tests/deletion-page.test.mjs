import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const code=await readFile(new URL('../web/expense-delete.js',import.meta.url),'utf8');
async function page(options={}){
  const elements={};const calls=[];let saved=false;
  const node=id=>elements[id]??=({textContent:'',value:'',hidden:true,disabled:false,dataset:{},events:{},addEventListener(k,fn){this.events[k]=fn;}});
  const client={auth:{getUser:async()=>({data:{user:{email:'test@example.invalid'}}}),signInWithPassword:async()=>({}),signOut:async()=>({})},rpc:async(name,args)=>{
    calls.push({name,args});
    if(name==='ledger_mcp_confirm_deletion'){
      if(options.commitError)return {error:{}};
      saved=true;return {data:{status:'deleted',expense_id:'test'}};
    }
    return options.readError?{error:{}}:{data:{name:'<img src=x onerror=alert(1)>',amount_yuan:'12.30',category:'餐饮',date:'2026-10-01',status:saved?'deleted':options.status??'awaiting_user_confirmation'}};
  }};
  vm.runInNewContext(code,{document:{getElementById:node},location:{hash:options.hash??'#draft=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},URLSearchParams,window:{supabase:{createClient:()=>client}}});
  await new Promise(r=>setImmediate(r));return {node,calls,client};
}
test('Confirmation: opening/loading only reads; explicit click saves immutable draft ID once',async()=>{
  const p=await page();assert.equal(p.calls.length,1);assert.equal(p.calls[0].name,'ledger_mcp_get_deletion');
  assert.equal(p.node('name').textContent,'<img src=x onerror=alert(1)>');assert.equal(p.node('confirm').disabled,false);
  await p.node('confirm').events.click();await p.node('confirm').events.click();
  assert.equal(p.calls.filter(c=>c.name==='ledger_mcp_confirm_deletion').length,1);
  assert.deepEqual(Object.keys(p.calls[1].args),['p_draft_id']);assert.equal(p.node('confirm').disabled,true);
});
test('Confirmation: expired, saved and unavailable drafts cannot save',async()=>{
  for(const options of [{status:'changed'},{status:'missing'},{status:'expired'},{status:'deleted'},{readError:true}]){
    const p=await page(options);await p.node('confirm').events.click();
    assert.equal(p.calls.filter(c=>c.name==='ledger_mcp_confirm_deletion').length,0);
  }
});
test('Confirmation: uncertain network result never claims success',async()=>{
  const p=await page({commitError:true});await p.node('confirm').events.click();
  assert.match(p.node('status').textContent,/未确认删除结果/);assert.equal(p.node('status').dataset.error,'true');
});
test('Confirmation: signout clears ability to save',async()=>{
  const p=await page();await p.node('signout').events.click();await p.node('confirm').events.click();
  assert.equal(p.calls.filter(c=>c.name==='ledger_mcp_confirm_deletion').length,0);
});
