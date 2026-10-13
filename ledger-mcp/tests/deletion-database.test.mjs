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
async function asUser(uid, cid, fn, persist=false) {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,...(cid?{client_id:cid}:{})})]);
    return await fn();
  } finally { await db.exec(persist?'commit':'rollback'); }
}
await db.exec(await readFile(new URL('../supabase/08-confirmed-deletions.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../supabase/08-confirmed-deletions.sql',import.meta.url),'utf8'));
const own=(await db.query("select id from expenses where name='one'")).rows[0].id;
const other=(await db.query("select id from expenses where name='private'")).rows[0].id;
const rid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const prepare=(r=rid,id=own)=>db.query('select ledger_mcp_prepare_deletion($1,$2) as result',[r,id]);
const get=id=>db.query('select ledger_mcp_get_deletion($1) as result',[id]);
const confirm=id=>db.query('select ledger_mcp_confirm_deletion($1) as result',[id]);
let draft;
test('Deletion: default disabled and preparation permission boundaries',async()=>{
 await assert.rejects(asUser(alice,client,()=>prepare()),/disabled/);
 await db.exec('update ledger_mcp_private.connection set deletions_enabled=true');
 for(const [u,c] of [[bob,client],[alice,'wrong'],[alice,null]])await assert.rejects(asUser(u,c,()=>prepare()),/disabled/);
 await assert.rejects(asUser(alice,client,()=>prepare(rid,other)),/unavailable/);
 draft=(await asUser(alice,client,()=>prepare(),true)).rows[0].result.draft_id;
 assert.equal((await asUser(alice,client,()=>prepare())).rows[0].result.draft_id,draft);
 assert.equal((await db.query('select * from expenses where id=$1',[own])).rows.length,1);
 await assert.rejects(asUser(alice,client,()=>prepare(rid,other)),/conflict/);
});
test('Deletion: only owner ordinary login can confirm; private requests remain private',async()=>{
 await assert.rejects(asUser(alice,client,()=>confirm(draft)),/Website/);
 await assert.rejects(asUser(bob,null,()=>confirm(draft)),/disabled/);
 await assert.rejects(asUser(bob,client,()=>get(draft)),/unavailable/);
 await assert.rejects(asUser(alice,'wrong',()=>get(draft)),/unavailable/);
 await assert.rejects(asUser(alice,client,()=>db.query('select * from ledger_mcp_private.deletion_drafts')),/permission/);
});
test('Deletion: changed, missing and expired rows cannot be deleted',async()=>{
 await db.query('update expenses set amount=2 where id=$1',[own]);
 assert.equal((await asUser(alice,null,()=>get(draft))).rows[0].result.status,'changed');
 await assert.rejects(asUser(alice,null,()=>confirm(draft)),/changed/);
 await db.query('update expenses set amount=0.10 where id=$1',[own]);
 await db.query("update ledger_mcp_private.deletion_drafts set expires_at=now()-interval '1 minute' where id=$1",[draft]);
 await assert.rejects(asUser(alice,null,()=>confirm(draft)),/expired/);
 await db.query("update ledger_mcp_private.deletion_drafts set expires_at=now()+interval '15 minutes' where id=$1",[draft]);
 await asUser(alice,null,async()=>{
 await db.query('delete from expenses where id=$1',[own]);
 assert.equal((await get(draft)).rows[0].result.status,'missing');
 });
});
test('Deletion: exact row removed once, repeat succeeds without affecting others; disable blocks',async()=>{
 await db.exec('update ledger_mcp_private.connection set deletions_enabled=false');
 await assert.rejects(asUser(alice,null,()=>confirm(draft)),/disabled/);
 await db.exec('update ledger_mcp_private.connection set deletions_enabled=true');
 const first=(await asUser(alice,null,()=>confirm(draft),true)).rows[0].result;
 assert.equal(first.status,'deleted');assert.equal(first.expense_id,own);
 assert.deepEqual((await asUser(alice,null,()=>confirm(draft))).rows[0].result,first);
 assert.equal((await db.query('select * from expenses')).rows.length,3);
 assert.equal((await asUser(alice,client,()=>get(draft))).rows[0].result.status,'deleted');
});
after(()=>db.close());
