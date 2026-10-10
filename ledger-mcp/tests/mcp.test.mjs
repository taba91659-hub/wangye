import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const PROJECT='https://joyqlelzapraawudhuxn.supabase.co';
const RESOURCE=PROJECT+'/functions/v1/ledger-mcp';
const {privateKey,publicKey}=await generateKeyPair('ES256');
const jwk=await exportJWK(publicKey); jwk.kid='local-test'; jwk.alg='ES256';
const env={SUPABASE_URL:PROJECT,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_local_test_only',SUPABASE_JWKS:JSON.stringify({keys:[jwk]})};
let handler, allow=true, rpcCalls=[];
const originalFetch=globalThis.fetch;
const originalDeno=globalThis.Deno;
globalThis.Deno={env:{get:key=>env[key]},serve:fn=>{handler=fn}};
globalThis.fetch=async(input,init)=>{
  const url=String(input instanceof Request ? input.url : input);
  assert.ok(url.startsWith(PROJECT+'/rest/v1/rpc/'),'No real network call permitted: '+url);
  rpcCalls.push({url,body:JSON.parse(init.body),authorization:new Headers(init.headers).get('Authorization')});
  if(url.endsWith('/ledger_mcp_access_allowed')) return Response.json(allow);
  return Response.json({total_yuan:'0.30',count:'2',timezone:'Asia/Shanghai'});
};
const ts=await readFile(new URL('../supabase/functions/ledger-mcp/index.ts',import.meta.url),'utf8');
const js=stripTypeScriptTypes(ts.replace(/'npm:([^']+)@[^@']+'/g,"'$1'"));
await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
await writeFile(new URL('../test-results/mcp-runtime.mjs',import.meta.url),js);
await import('../test-results/mcp-runtime.mjs');
async function token(overrides={}) {
  return new SignJWT({role:'authenticated',client_id:'local-client',...overrides})
    .setProtectedHeader({alg:'ES256',kid:'local-test'}).setSubject('11111111-1111-4111-8111-111111111111')
    .setIssuer(overrides.iss || PROJECT+'/auth/v1').setAudience(overrides.aud || RESOURCE)
    .setIssuedAt().setExpirationTime(overrides.exp || '5m').sign(privateKey);
}
async function request(method,params={},jwt) {
  return handler(new Request(RESOURCE,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',
    ...(jwt?{Authorization:'Bearer '+jwt}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}));
}
async function rpcBody(response) {
  const value=await response.text();
  if(response.headers.get('content-type')?.includes('text/event-stream')) {
    const line=value.split('\n').find(line=>line.startsWith('data:'));
    return JSON.parse(line.slice(5));
  }
  return JSON.parse(value);
}
test('MCP discovery is public and canonical',async()=>{
  const res=await handler(new Request(RESOURCE+'/oauth-protected-resource'));
  assert.equal(res.status,200); const data=await res.json();
  assert.equal(data.resource,RESOURCE);assert.deepEqual(data.authorization_servers,[PROJECT+'/auth/v1']);
});
test('MCP unauthenticated requests receive OAuth challenge',async()=>{
  const res=await request('tools/list');assert.equal(res.status,401);
  assert.ok(res.headers.get('WWW-Authenticate').includes(RESOURCE+'/oauth-protected-resource'));
});
test('MCP rejects forged, expired, wrong issuer and wrong audience tokens',async()=>{
  for(const jwt of ['invalid',await token({exp:1}),await token({iss:'https://other.example/auth'}),await token({aud:'authenticated'})])
    assert.equal((await request('tools/list',{},jwt)).status,401);
});
test('MCP initializes and exposes exactly two read-only tools',async()=>{
  const jwt=await token();
  const init=await rpcBody(await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}},jwt));
  assert.ok(init.result?.serverInfo,JSON.stringify(init));
  const result=await rpcBody(await request('tools/list',{},jwt));
  assert.deepEqual(result.result.tools.map(t=>t.name).sort(),['list_expenses','summarize_expenses']);
  for(const tool of result.result.tools) assert.equal(tool.annotations.readOnlyHint,true);
});
test('MCP validates dates and rejects user_id injection before database query',async()=>{
  const jwt=await token();
  for(const args of [{start:'2026-02-30',end:'2026-03-10'},{start:'2026-10-01',end:'2026-11-01',user_id:'other'},{start:'2026-11-01',end:'2026-10-01'}]) {
    rpcCalls=[];
    const result=await rpcBody(await request('tools/call',{name:'summarize_expenses',arguments:args},jwt));
    assert.ok(result.error || result.result?.isError,JSON.stringify(result));assert.equal(rpcCalls.length,0);
  }
});
test('MCP passes caller token to fixed RPC and returns summary',async()=>{
  const jwt=await token(); rpcCalls=[];
  const result=await rpcBody(await request('tools/call',{name:'summarize_expenses',arguments:{start:'2026-10-01',end:'2026-11-01'}},jwt));
  assert.equal(result.result?.isError,undefined,JSON.stringify(result));
  assert.equal(JSON.parse(result.result.content[0].text).total_yuan,'0.30');
  assert.equal(rpcCalls.length,2);assert.equal(rpcCalls[1].authorization,'Bearer '+jwt);
  assert.equal(rpcCalls[1].body.p_mode,'summary');assert.equal('user_id' in rpcCalls[1].body,false);
});
test('MCP revoked connection blocks query RPC',async()=>{
  allow=false;rpcCalls=[];
  const result=await rpcBody(await request('tools/call',{name:'list_expenses',arguments:{start:'2026-10-01',end:'2026-11-01'}},await token()));
  assert.equal(result.result.isError,true);assert.equal(rpcCalls.length,1);
});
after(()=>{globalThis.fetch=originalFetch;globalThis.Deno=originalDeno;});
