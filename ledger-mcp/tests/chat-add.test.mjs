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
await db.exec(await readFile(new URL('../supabase/05-confirmed-expenses.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../supabase/08-confirmed-deletions.sql',import.meta.url),'utf8'));
const migration11=await readFile(new URL('../supabase/11-chat-add-expense.sql',import.meta.url),'utf8');
await db.exec(migration11);await db.exec(migration11);
const rid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const add=(id=rid,name='午餐',amount='35.20',category='餐饮',date='2026-01-01')=>db.query('select ledger_mcp_chat_add_expense($1,$2,$3,$4,$5) as result',[id,name,amount,category,date]);
let saved;
test('Chat add: default disabled, exact user and client required',async()=>{
 await assert.rejects(asUser(alice,client,()=>add()),/disabled/);
 await db.exec('update ledger_mcp_private.connection set drafts_enabled=true,chat_add_enabled=true');
 for(const [u,c] of [[bob,client],[alice,'wrong'],[alice,null]])await assert.rejects(asUser(u,c,()=>add()),/unauthorized/);
});
test('Chat add: rejects bad amount, name, category, future date and null request',async()=>{
 for(const args of [[rid,'午餐','0'],[rid,'午餐','1.001'],[rid,'午餐','1000000000'],[rid,''],[rid,'午餐','1','bad'],[rid,'午餐','1','餐饮','2099-01-01'],[null]])await assert.rejects(asUser(alice,client,()=>add(...args)));
 assert.equal((await db.query('select * from expenses')).rows.length,4);
});
test('Chat add: fixed intent saves once; conflicting replay rejected',async()=>{
 saved=(await asUser(alice,client,()=>add(),true)).rows[0].result;
 assert.equal(saved.status,'saved');assert.equal(saved.currently_exists,true);assert.equal(saved.already_saved,false);
 const retry=(await asUser(alice,client,()=>add(),true)).rows[0].result;
 assert.equal(retry.expense_id,saved.expense_id);assert.equal(retry.already_saved,true);
 await assert.rejects(asUser(alice,client,()=>add(rid,'晚餐')),/different/);
 const rows=(await db.query('select amount::text,date from expenses where id=$1',[saved.expense_id])).rows;
 assert.equal(rows[0].amount,'35.20');assert.equal(new Date(rows[0].date).toISOString(),'2025-12-31T16:00:00.000Z');
 assert.equal((await db.query('select * from expenses')).rows.length,5);
});
test('Chat add: web replay shares idempotency; deleted row is never resurrected',async()=>{
 const web=(await asUser(alice,null,()=>db.query('select ledger_mcp_confirm_expense($1) as result',[saved.draft_id]),true)).rows[0].result;
 assert.equal(web.expense_id,saved.expense_id);assert.equal(web.already_saved,true);
 await asUser(alice,null,()=>db.query('delete from expenses where id=$1',[saved.expense_id]),true);
 const retry=(await asUser(alice,client,()=>add(),true)).rows[0].result;
 assert.equal(retry.currently_exists,false);assert.equal(retry.already_saved,true);
 assert.equal((await db.query('select * from expenses')).rows.length,4);
});
test('Chat add: expired unsaved draft rejected, rollback and direct OAuth restrictions intact',async()=>{
 const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const d=(await asUser(alice,client,()=>db.query("select ledger_mcp_prepare_expense($1,'午餐','35.20','餐饮','2026-01-01') as result",[id]),true)).rows[0].result;
 await db.query("update ledger_mcp_private.expense_drafts set expires_at=now()-interval '1 minute' where id=$1",[d.draft_id]);
 await assert.rejects(asUser(alice,client,()=>add(id)),/expired/);
 await assert.rejects(asUser(alice,client,()=>db.query('insert into expenses(user_id,amount) values($1,1)',[alice])),/row-level security/);
 assert.equal((await asUser(alice,client,()=>db.query('delete from expenses returning id'))).rows.length,0);
 await assert.rejects(asUser(alice,client,()=>db.query('select ledger_mcp_confirm_deletion($1)',[d.draft_id])),/Website/);
 await db.exec('update ledger_mcp_private.connection set chat_add_enabled=false');
 await assert.rejects(asUser(alice,client,()=>add()),/disabled/);
 const original=(await asUser(alice,client,()=>db.query('select ledger_mcp_get_draft($1) as result',[saved.draft_id]))).rows[0].result;
 assert.equal(original.status,'saved');
});
after(()=>db.close());
