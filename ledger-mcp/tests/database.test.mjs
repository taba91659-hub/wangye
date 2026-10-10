import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const alice='11111111-1111-4111-8111-111111111111';
const bob='22222222-2222-4222-8222-222222222222';
const client='33333333-3333-4333-8333-333333333333';
await db.exec(`
create role anon; create role authenticated; create role supabase_auth_admin;
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
insert into auth.users values('${alice}'),('${bob}');
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
grant usage on schema auth,public,storage to authenticated;
grant execute on function auth.uid(),auth.jwt() to authenticated;
create table public.expenses(id uuid primary key default gen_random_uuid(),user_id uuid,amount numeric,name text,category text,date timestamptz);
create table public.monthly_budgets(user_id uuid,month text,amount numeric,created_at timestamptz default now());
create table storage.objects(id uuid default gen_random_uuid(),name text);
alter table public.expenses enable row level security;
alter table public.monthly_budgets enable row level security;
alter table storage.objects enable row level security;
grant select,insert,update,delete on public.expenses,public.monthly_budgets,storage.objects to authenticated;
create policy original_expenses on public.expenses for all to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy original_budgets on public.monthly_budgets for all to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy test_storage on storage.objects for all to authenticated using(true) with check(true);
insert into expenses(user_id,amount,name,category,date) values
('${alice}',0.10,'one','餐饮','2026-10-01T00:00:00+08:00'),
('${alice}',0.20,'two','餐饮','2026-10-31T23:59:59+08:00'),
('${alice}',999,'outside','餐饮','2026-11-01T00:00:00+08:00'),
('${bob}',500,'private','购物','2026-10-15T12:00:00+08:00');
insert into monthly_budgets(user_id,month,amount) values('${alice}','2026-10',100);
insert into storage.objects(name) values('private-file');
`);
const migration = await readFile(new URL('../supabase/01-readonly.sql',import.meta.url),'utf8');
await db.exec(migration);
await db.exec(migration); // repeated application preserves original policies and data
await db.query('insert into ledger_mcp_private.connection values(true,$1,$2,true)',[alice,client]);
await db.exec(await readFile(new URL('../supabase/04-token-audience.sql',import.meta.url),'utf8'));
async function asUser(uid, cid, fn) {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,...(cid?{client_id:cid}:{})})]);
    return await fn();
  } finally { await db.exec('rollback'); }
}
const query = (mode='summary',start='2026-10-01',end='2026-11-01',category=null,limit=30,offset=0) =>
  db.query('select public.ledger_mcp_query($1,$2,$3,$4,$5,$6) as result',[mode,start,end,category,limit,offset]);

test('SQL: numeric totals, China date boundaries, and user isolation',async()=>{
  const {rows} = await asUser(alice,client,()=>query());
  assert.equal(rows[0].result.total_yuan,'0.30'); assert.equal(rows[0].result.count,'2');
  assert.deepEqual(rows[0].result.categories,[{category:'餐饮',count:'2',total_yuan:'0.30'}]);
});
test('SQL: pagination reports another page and exact decimal strings',async()=>{
  const {rows}=await asUser(alice,client,()=>query('list',undefined,undefined,null,1,0));
  assert.equal(rows[0].result.expenses.length,1);assert.equal(rows[0].result.has_more,true);
  assert.equal(rows[0].result.next_offset,1);assert.equal(rows[0].result.expenses[0].amount_yuan,'0.20');
});
test('SQL: unregistered client, other user, and direct web token cannot call RPC',async()=>{
  for(const [uid,cid] of [[alice,'wrong'],[bob,client],[alice,null]])
    await assert.rejects(asUser(uid,cid,()=>query()),/Access denied/);
});
test('SQL: OAuth direct table reads stay isolated; budget and storage blocked',async()=>{
  await asUser(alice,client,async()=>{
    assert.equal((await db.query('select * from expenses')).rows.length,3);
    assert.equal((await db.query('select * from monthly_budgets')).rows.length,0);
    assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  });
  await asUser(bob,client,async()=>assert.equal((await db.query('select * from expenses')).rows.length,0));
});
test('SQL: OAuth insert fails and update/delete change zero rows',async()=>{
  await assert.rejects(asUser(alice,client,()=>db.query('insert into expenses(user_id,amount) values($1,1)',[alice])),/row-level security/);
  await asUser(alice,client,async()=>{
    assert.equal((await db.query('update expenses set amount=1 returning id')).rows.length,0);
    assert.equal((await db.query('delete from expenses returning id')).rows.length,0);
  });
});
test('SQL: original website still reads/writes its own expenses and budgets',async()=>{
  await asUser(alice,null,async()=>{
    assert.equal((await db.query('select * from expenses')).rows.length,3);
    await db.query('insert into expenses(user_id,amount) values($1,1)',[alice]);
    assert.equal((await db.query('update monthly_budgets set amount=200 returning amount')).rows.length,1);
    assert.equal((await db.query('delete from expenses where amount=1 returning id')).rows.length,1);
  });
});
test('SQL: invalid range and unsupported category rejected',async()=>{
  for(const args of [['summary','2026-10-01','2026-10-01'],['summary','2020-01-01','2026-01-01'],['summary','2026-10-01','2026-11-01','invalid']])
    await assert.rejects(asUser(alice,client,()=>query(...args)),/Invalid query/);
});
test('SQL: authorization page checks exact user and client without exposing config',async()=>{
  const result=await asUser(alice,null,()=>db.query('select ledger_mcp_consent_allowed($1) as allowed',[client]));
  assert.equal(result.rows[0].allowed,true);
  const other=await asUser(bob,null,()=>db.query('select ledger_mcp_consent_allowed($1) as allowed',[client]));
  assert.equal(other.rows[0].allowed,false);
  await assert.rejects(asUser(alice,null,()=>db.query('select * from ledger_mcp_private.connection')),/permission denied/);
});
test('SQL: audience hook preserves web and unrelated client tokens, binds exact account',async()=>{
  const run=async event=>(await db.query('select ledger_mcp_token_hook($1) as result',[event])).rows[0].result;
  const web={user_id:alice,claims:{sub:alice,aud:'authenticated'}};
  assert.deepEqual(await run(web),web);
  for(const [uid,cid] of [[bob,client],[alice,'other']]) {
    const event={user_id:uid,client_id:cid,claims:{sub:uid,aud:'authenticated'}};
    assert.deepEqual(await run(event),event);
  }
  const event={user_id:alice,client_id:client,claims:{sub:alice,aud:'authenticated'}};
  const result=await run(event);
  assert.deepEqual(result.claims.aud,['authenticated','https://joyqlelzapraawudhuxn.supabase.co/functions/v1/ledger-mcp']);
  assert.equal(result.claims.client_id,client);
  assert.deepEqual(await run(result),result);
  await assert.rejects(asUser(alice,null,()=>db.query('select ledger_mcp_token_hook($1)',[event])),/permission denied/);
});
test('SQL: disabling connection immediately denies further reads',async()=>{
  await db.exec('update ledger_mcp_private.connection set enabled=false');
  await assert.rejects(asUser(alice,client,()=>query()),/Access denied/);
});
after(()=>db.close());
