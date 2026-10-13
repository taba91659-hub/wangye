-- 单笔删除：OAuth 只能准备请求；本人网页登录确认后才删除。
begin;
alter table ledger_mcp_private.connection add column if not exists deletions_enabled boolean not null default false;
create table if not exists ledger_mcp_private.deletion_drafts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 client_id text not null, request_id uuid not null, expense_id uuid not null,
 snapshot jsonb not null, expires_at timestamptz not null default now()+interval '15 minutes',
 deleted_at timestamptz, unique(user_id,client_id,request_id)
);
alter table ledger_mcp_private.deletion_drafts enable row level security;
revoke all on ledger_mcp_private.deletion_drafts from public,anon,authenticated;

create or replace function public.ledger_mcp_get_deletion(p_draft_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d ledger_mcp_private.deletion_drafts; current_row jsonb; state text;
begin
 select x.* into d from ledger_mcp_private.deletion_drafts x
 join ledger_mcp_private.connection c on c.user_id=x.user_id and c.client_id=x.client_id
 where x.id=p_draft_id and x.user_id=auth.uid() and c.enabled and c.deletions_enabled
 and ((auth.jwt()->>'client_id') is null or auth.jwt()->>'client_id'=x.client_id);
 if not found then raise exception 'Deletion unavailable' using errcode='42501'; end if;
 select to_jsonb(e) into current_row from public.expenses e where e.id=d.expense_id and e.user_id=d.user_id;
 state:=case when d.deleted_at is not null then 'deleted' when current_row is null then 'missing'
 when current_row is distinct from d.snapshot then 'changed' when d.expires_at<=now() then 'expired'
 else 'awaiting_user_confirmation' end;
 return jsonb_build_object('draft_id',d.id,'expense_id',d.expense_id,'name',d.snapshot->>'name',
 'amount_yuan',d.snapshot->>'amount','category',d.snapshot->>'category',
 'date',((d.snapshot->>'date')::timestamptz at time zone 'Asia/Shanghai')::date,
 'timezone','Asia/Shanghai','expires_at',d.expires_at,'status',state);
end $$;

create or replace function public.ledger_mcp_prepare_deletion(p_request_id uuid,p_expense_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d ledger_mcp_private.deletion_drafts; original jsonb;
begin
 perform 1 from ledger_mcp_private.connection c where c.enabled and c.deletions_enabled
 and c.user_id=auth.uid() and c.client_id=auth.jwt()->>'client_id' for update;
 if not found then raise exception 'Deletion disabled' using errcode='42501'; end if;
 if p_request_id is null or p_expense_id is null then raise exception 'Invalid IDs' using errcode='22023'; end if;
 select * into d from ledger_mcp_private.deletion_drafts where user_id=auth.uid()
 and client_id=auth.jwt()->>'client_id' and request_id=p_request_id;
 if found then
   if d.expense_id<>p_expense_id then raise exception 'Request ID conflict' using errcode='22023'; end if;
 else
   select to_jsonb(e) into original from public.expenses e where e.id=p_expense_id and e.user_id=auth.uid();
   if not found then raise exception 'Expense unavailable' using errcode='42501'; end if;
   if (select count(*) from ledger_mcp_private.deletion_drafts where user_id=auth.uid() and deleted_at is null and expires_at>now())>=30
   then raise exception 'Too many pending requests' using errcode='22023'; end if;
   insert into ledger_mcp_private.deletion_drafts(user_id,client_id,request_id,expense_id,snapshot)
   values(auth.uid(),auth.jwt()->>'client_id',p_request_id,p_expense_id,original) returning * into d;
 end if;
 return public.ledger_mcp_get_deletion(d.id);
end $$;

create or replace function public.ledger_mcp_confirm_deletion(p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d ledger_mcp_private.deletion_drafts; original jsonb;
begin
 if auth.uid() is null or auth.jwt()->>'client_id' is not null then
 raise exception 'Website login required' using errcode='42501'; end if;
 perform 1 from ledger_mcp_private.connection where user_id=auth.uid() and enabled and deletions_enabled for update;
 if not found then raise exception 'Deletion disabled' using errcode='42501'; end if;
 select x.* into d from ledger_mcp_private.deletion_drafts x
 join ledger_mcp_private.connection c on c.user_id=x.user_id and c.client_id=x.client_id
 where x.id=p_draft_id and x.user_id=auth.uid() for update of x;
 if not found then raise exception 'Deletion unavailable' using errcode='42501'; end if;
 if d.deleted_at is not null then return jsonb_build_object('status','deleted','expense_id',d.expense_id); end if;
 if d.expires_at<=now() then raise exception 'Deletion expired' using errcode='22023'; end if;
 select to_jsonb(e) into original from public.expenses e where e.id=d.expense_id and e.user_id=d.user_id for update;
 if original is null or original is distinct from d.snapshot then
 raise exception 'Expense missing or changed; prepare again' using errcode='22023'; end if;
 delete from public.expenses where id=d.expense_id and user_id=d.user_id;
 update ledger_mcp_private.deletion_drafts set deleted_at=now() where id=d.id;
 return jsonb_build_object('status','deleted','expense_id',d.expense_id);
end $$;
revoke all on function public.ledger_mcp_prepare_deletion(uuid,uuid), public.ledger_mcp_get_deletion(uuid), public.ledger_mcp_confirm_deletion(uuid) from public,anon;
grant execute on function public.ledger_mcp_prepare_deletion(uuid,uuid), public.ledger_mcp_get_deletion(uuid), public.ledger_mcp_confirm_deletion(uuid) to authenticated;
commit;
