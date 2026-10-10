import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../web/oauth-consent.js',import.meta.url),'utf8');
const callback='https://chatgpt.com/connector_platform_oauth_redirect';
async function page(options={}) {
  const nodes={};let approved=0,denied=0,redirect=null,configuration;
  const node=id=>nodes[id]??=( {hidden:true,disabled:false,value:'',textContent:'',dataset:{},events:{},addEventListener(name,fn){this.events[name]=fn;}} );
  const db={rpc:async()=>({data:options.allowed!==false}),auth:{
    getUser:async()=>({data:{user:{email:'test@example.invalid'}}}),
    signInWithPassword:async()=>({error:options.loginError}),
    signOut:async()=>{},oauth:{
      getAuthorizationDetails:async()=>({data:{authorization_id:'test-request',client:{id:'test-client',name:'Test'},redirect_uri:options.callback??callback,scope:''}}),
      approveAuthorization:async()=>{approved++;return{data:{redirect_url:callback+'?code=test'}};},
      denyAuthorization:async()=>{denied++;return{data:{redirect_url:callback+'?error=access_denied'}};},
    }
  }};
  vm.runInNewContext(source,{document:{getElementById:node},window:{supabase:{createClient:(url,key,config)=>{configuration=config;return db;}}},location:{search:options.search??'?authorization_id=test-request',assign:url=>redirect=url},URL,URLSearchParams});
  await new Promise(resolve=>setImmediate(resolve));
  return {node,db,get approved(){return approved;},get denied(){return denied;},get redirect(){return redirect;},get configuration(){return configuration;}};
}
test('Consent: displays account and requires explicit approval, uses temporary session',async()=>{
  const p=await page();assert.equal(p.node('consent').hidden,false);assert.equal(p.approved,0);assert.equal(p.redirect,null);
  assert.equal(p.configuration.auth.persistSession,false);assert.equal(p.configuration.auth.detectSessionInUrl,false);
  await p.node('approve').events.click();assert.equal(p.approved,1);assert.match(p.redirect,/chatgpt.com/);
});
test('Consent: unknown account/client and invalid callback cannot approve',async()=>{
  for(const options of [{allowed:false},{callback:'https://evil.example/connector_platform_oauth_redirect'},{callback:'https://chatgpt.com.evil.example/connector/oauth/abc'}]){
    const p=await page(options);assert.equal(p.node('consent').hidden,true);await p.node('approve').events.click();assert.equal(p.approved,0);
  }
});
test('Consent: permission is checked again when approving',async()=>{
  const p=await page();p.db.rpc=async()=>({data:false});await p.node('approve').events.click();assert.equal(p.approved,0);assert.equal(p.redirect,null);
});
test('Consent: denial returns access_denied without approving',async()=>{
  const p=await page();await p.node('deny').events.click();assert.equal(p.approved,0);assert.equal(p.denied,1);assert.match(p.redirect,/access_denied/);
});
test('Consent: rejected login clears password field',async()=>{
  const p=await page({loginError:{message:'invalid'}});p.node('password').value='test-only';await p.node('login').events.submit({preventDefault(){}});assert.equal(p.node('password').value,'');assert.equal(p.approved,0);
});
test('Consent: duplicate or absent authorization IDs fail closed',async()=>{
  for(const search of ['', '?authorization_id=test-request&authorization_id=another-request']) {
    const p=await page({search});assert.equal(p.configuration,undefined);assert.equal(p.redirect,null);
  }
});
