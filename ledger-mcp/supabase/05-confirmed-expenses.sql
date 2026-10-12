-- 第二阶段：OAuth 只能创建草稿；普通网页登录后才能确认保存。
-- 不修改原表的 RLS，不允许 OAuth 直接新增/更新/删除账单。
begin;
alter table ledger_mcp_private.connection add column if not exists drafts_enabled boolean not null default false;
create table if not exists ledger_mcp_private.expense_drafts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id), client_id text not null,
 request_id uuid not null, name text not null, amount numeric(11,2) not null,
 category text not null, expense_date date not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '15 minutes',
 expense_id uuid, unique(user_id,client_id,request_id),
 check (amount > 0 and amount <= 999999999),
 check (char_length(name) between 1 and 60),
 check (category in ('餐饮','购物','交通','娱乐','其他'))
);
alter table ledger_mcp_private.expense_drafts enable row level security;
revoke all on ledger_mcp_private.expense_drafts from public,anon,authenticated;

create or replace function public.ledger_mcp_prepare_expense(
 p_request_id uuid,p_name text,p_amount text,p_category text,p_date date
) returns jsonb language plpgsql security definer set search_path='' as $$
declare d ledger_mcp_private.expense_drafts; v_amount numeric; v_name text;
begin
 -- Serialize preparations for the bound account, including request-id retries.
 perform 1 from ledger_mcp_private.connection c where c.enabled and c.drafts_enabled
   and c.user_id=auth.uid() and c.client_id=auth.jwt()->>'client_id' for update;
 if not found then raise exception 'Draft creation not enabled for this account' using errcode='42501'; end if;
 v_name:=btrim(p_name);
 if p_request_id is null or v_name is null or char_length(v_name) not between 1 and 60
 or v_name ~ '[[:cntrl:]]' or p_amount is null or p_amount !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$'
 or p_category is null or p_category not in ('餐饮','购物','交通','娱乐','其他')
 or p_date is null or p_date < date '2000-01-01'
 or p_date > (now() at time zone 'Asia/Shanghai')::date then
   raise exception 'Invalid expense: check name, amount, category and date' using errcode='22023';
 end if;
 v_amount:=p_amount::numeric;
 if v_amount<=0 or v_amount>999999999 then raise exception 'Invalid amount' using errcode='22023'; end if;
 select * into d from ledger_mcp_private.expense_drafts where user_id=auth.uid()
 and client_id=auth.jwt()->>'client_id' and request_id=p_request_id;
 if found then
   if d.name<>v_name or d.amount<>v_amount or d.category<>p_category or d.expense_date<>p_date then
     raise exception 'Request ID already used for different expense' using errcode='22023';
   end if;
 else
   if (select count(*) from ledger_mcp_private.expense_drafts where user_id=auth.uid()
      and expense_id is null and expires_at>now())>=30 then
     raise exception 'Too many pending drafts; confirm or wait for expiry' using errcode='22023';
   end if;
   insert into ledger_mcp_private.expense_drafts(user_id,client_id,request_id,name,amount,category,expense_date)
   values(auth.uid(),auth.jwt()->>'client_id',p_request_id,v_name,v_amount,p_category,p_date) returning * into d;
 end if;
 return jsonb_build_object('draft_id',d.id,'name',d.name,'amount_yuan',d.amount::text,
 'category',d.category,'date',d.expense_date,'timezone','Asia/Shanghai','expires_at',d.expires_at,
 'status',case when d.expense_id is not null then 'saved' when d.expires_at<=now() then 'expired' else 'awaiting_user_confirmation' end,
 'expense_id',d.expense_id);
end $$;

create or replace function public.ledger_mcp_get_draft(p_draft_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d ledger_mcp_private.expense_drafts;
begin
 select x.* into d from ledger_mcp_private.expense_drafts x
 join ledger_mcp_private.connection c on c.user_id=x.user_id and c.client_id=x.client_id
 where x.id=p_draft_id and x.user_id=auth.uid() and c.enabled and c.drafts_enabled
 and ((auth.jwt()->>'client_id') is null or (auth.jwt()->>'client_id')=x.client_id);
 if not found then raise exception 'Draft unavailable for this account' using errcode='42501'; end if;
 return jsonb_build_object('draft_id',d.id,'name',d.name,'amount_yuan',d.amount::text,
 'category',d.category,'date',d.expense_date,'timezone','Asia/Shanghai','expires_at',d.expires_at,
 'status',case when d.expense_id is not null then 'saved' when d.expires_at<=now() then 'expired' else 'awaiting_user_confirmation' end,
 'expense_id',d.expense_id);
end $$;

create or replace function public.ledger_mcp_confirm_expense(p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d ledger_mcp_private.expense_drafts; saved_id uuid;
begin
 -- An OAuth token (including ChatGPT's) cannot execute this action.
 if auth.uid() is null or (auth.jwt()->>'client_id') is not null then
   raise exception 'Confirm on the website with your bookkeeping login' using errcode='42501';
 end if;
 perform 1 from ledger_mcp_private.connection where user_id=auth.uid() and enabled and drafts_enabled for update;
 if not found then raise exception 'Draft confirmation disabled' using errcode='42501'; end if;
 select x.* into d from ledger_mcp_private.expense_drafts x
 join ledger_mcp_private.connection c on c.user_id=x.user_id and c.client_id=x.client_id
 where x.id=p_draft_id and x.user_id=auth.uid() for update of x;
 if not found then raise exception 'Draft unavailable for this account' using errcode='42501'; end if;
 if d.expense_id is not null then
   return jsonb_build_object('status','saved','expense_id',d.expense_id,'already_saved',true);
 end if;
 if d.expires_at<=now() then raise exception 'Draft expired; request a new draft' using errcode='22023'; end if;
 -- Immutable draft is the sole source of fields. No caller-supplied amount or user ID.
 saved_id:=gen_random_uuid();
 insert into public.expenses(id,user_id,name,amount,category,date)
 values(saved_id,d.user_id,d.name,d.amount,d.category,d.expense_date::timestamp at time zone 'Asia/Shanghai');
 update ledger_mcp_private.expense_drafts set expense_id=saved_id where id=d.id;
 return jsonb_build_object('status','saved','expense_id',saved_id,'already_saved',false);
end $$;
revoke all on function public.ledger_mcp_prepare_expense(uuid,text,text,text,date) from public,anon;
revoke all on function public.ledger_mcp_get_draft(uuid) from public,anon;
revoke all on function public.ledger_mcp_confirm_expense(uuid) from public,anon;
grant execute on function public.ledger_mcp_prepare_expense(uuid,text,text,text,date),public.ledger_mcp_get_draft(uuid),public.ledger_mcp_confirm_expense(uuid) to authenticated;
commit;
