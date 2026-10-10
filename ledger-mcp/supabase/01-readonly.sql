-- 新版 OAuth/MCP 方案。不要使用旧 chatgpt-bridge/02-setup-DRAFT.sql。
-- 新增私有配置、只读查询函数及限制性策略；不修改现有 permissive 策略或账单数据。
-- 默认没有获准用户/客户端，部署后仍不能读取账单，直到单独绑定。
begin;

-- 发现未知公开表/特权函数就中止，避免 OAuth token 通过别的接口获得额外权限。
do $$
begin
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','f')
    and c.relname not in ('expenses','monthly_budgets')) then
    raise exception '发现额外 public 表/视图，先检查权限；本次事务未作改动';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef
    and p.proname not in ('ledger_mcp_access_allowed','ledger_mcp_consent_allowed','ledger_mcp_token_hook')) then
    raise exception '发现其他 public SECURITY DEFINER 函数，先检查；本次事务未作改动';
  end if;
  if (select count(*) from pg_class where oid in ('public.expenses'::regclass,'public.monthly_budgets'::regclass) and relrowsecurity) <> 2 then
    raise exception '两张表必须已开启 RLS';
  end if;
end $$;

create schema if not exists ledger_mcp_private;
revoke all on schema ledger_mcp_private from public, anon, authenticated;
create table if not exists ledger_mcp_private.connection (
  singleton boolean primary key default true check(singleton),
  user_id uuid not null references auth.users(id),
  client_id text not null check(length(client_id)>0),
  enabled boolean not null default false
);
alter table ledger_mcp_private.connection enable row level security;
revoke all on ledger_mcp_private.connection from public, anon, authenticated;

create or replace function public.ledger_mcp_access_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from ledger_mcp_private.connection c
    where c.enabled and c.user_id=auth.uid()
      and c.client_id=(auth.jwt()->>'client_id'));
$$;
revoke all on function public.ledger_mcp_access_allowed() from public, anon;
grant execute on function public.ledger_mcp_access_allowed() to authenticated;

-- 授权页用普通登录会话核对请求的 client_id；不泄露配置表或其他用户信息。
create or replace function public.ledger_mcp_consent_allowed(p_client_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select (auth.jwt()->>'client_id') is null and exists(
    select 1 from ledger_mcp_private.connection c where c.enabled
      and c.user_id=auth.uid() and c.client_id=p_client_id);
$$;
revoke all on function public.ledger_mcp_consent_allowed(text) from public, anon;
grant execute on function public.ledger_mcp_consent_allowed(text) to authenticated;

-- OAuth 客户端只能在已绑定账号/客户端匹配时读账单；普通网页会话仍走原规则。
drop policy if exists ledger_mcp_select_gate on public.expenses;
create policy ledger_mcp_select_gate on public.expenses as restrictive for select to authenticated
using ((auth.jwt()->>'client_id') is null or (select public.ledger_mcp_access_allowed()));

-- 写入限制是 restrictive，与已有允许规则取 AND，不能被已有规则绕开。
drop policy if exists ledger_mcp_no_insert on public.expenses;
create policy ledger_mcp_no_insert on public.expenses as restrictive for insert to authenticated
with check ((auth.jwt()->>'client_id') is null);
drop policy if exists ledger_mcp_no_update on public.expenses;
create policy ledger_mcp_no_update on public.expenses as restrictive for update to authenticated
using ((auth.jwt()->>'client_id') is null) with check ((auth.jwt()->>'client_id') is null);
drop policy if exists ledger_mcp_no_delete on public.expenses;
create policy ledger_mcp_no_delete on public.expenses as restrictive for delete to authenticated
using ((auth.jwt()->>'client_id') is null);

-- 本期不开放预算或存储。网页密码登录没有 client_id，不受这些附加限制影响。
drop policy if exists ledger_mcp_no_oauth on public.monthly_budgets;
create policy ledger_mcp_no_oauth on public.monthly_budgets as restrictive for all to authenticated
using ((auth.jwt()->>'client_id') is null) with check ((auth.jwt()->>'client_id') is null);
drop policy if exists ledger_mcp_no_oauth on storage.objects;
create policy ledger_mcp_no_oauth on storage.objects as restrictive for all to authenticated
using ((auth.jwt()->>'client_id') is null) with check ((auth.jwt()->>'client_id') is null);

create or replace function public.ledger_mcp_query(
  p_mode text, p_start date, p_end date, p_category text default null,
  p_limit integer default 30, p_offset integer default 0
) returns jsonb language plpgsql stable security invoker
set search_path = '' set statement_timeout = '8s' as $$
declare result jsonb; from_time timestamptz; to_time timestamptz;
begin
  if not public.ledger_mcp_access_allowed() then raise exception 'Access denied' using errcode='42501'; end if;
  if p_mode is null or p_mode not in ('list','summary') or p_start is null or p_end is null
     or p_end <= p_start or p_end-p_start > 366 or p_limit is null or p_limit not between 1 and 100
     or p_offset is null or p_offset not between 0 and 100000
     or (p_category is not null and p_category not in ('餐饮','购物','交通','娱乐','其他')) then
    raise exception 'Invalid query parameters' using errcode='22023';
  end if;
  from_time := p_start::timestamp at time zone 'Asia/Shanghai';
  to_time := p_end::timestamp at time zone 'Asia/Shanghai';
  if p_mode='summary' then
    with selected as materialized (
      select amount, category from public.expenses
      where user_id=auth.uid() and date>=from_time and date<to_time
        and (p_category is null or category=p_category)
    ), groups as (
      select category, count(*)::text as count, coalesce(sum(amount),0)::text as total_yuan
      from selected group by category
    )
    select jsonb_build_object('count',count(*)::text,'total_yuan',coalesce(sum(amount),0)::text,
      'categories',(select coalesce(jsonb_agg(to_jsonb(g) order by g.category),'[]'::jsonb) from groups g))
    into result from selected;
  else
    with selected as materialized (
      select id, amount::text as amount_yuan, name, category, date from public.expenses
      where user_id=auth.uid() and date>=from_time and date<to_time
        and (p_category is null or category=p_category)
      order by date desc,id desc limit p_limit+1 offset p_offset
    ), page as (select * from selected order by date desc,id desc limit p_limit)
    select jsonb_build_object('expenses',coalesce(jsonb_agg(to_jsonb(p) order by p.date desc,p.id desc),'[]'::jsonb),
      'has_more',(select count(*)>p_limit from selected),
      'next_offset',case when (select count(*)>p_limit from selected) then p_offset+p_limit else null end)
    into result from page p;
  end if;
  return result || jsonb_build_object('currency','CNY','timezone','Asia/Shanghai',
    'start_inclusive',p_start,'end_exclusive',p_end);
end $$;
revoke all on function public.ledger_mcp_query(text,date,date,text,integer,integer) from public, anon;
grant execute on function public.ledger_mcp_query(text,date,date,text,integer,integer) to authenticated;
commit;
