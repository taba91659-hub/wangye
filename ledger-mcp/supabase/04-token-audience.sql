-- 创建后还需在 Authentication > Auth Hooks 选中本函数。
-- 若已有 Custom Access Token Hook，先合并逻辑，不能覆盖原Hook。
-- 只给绑定的 OAuth 客户端增加 MCP audience，普通网页登录 claims 原样返回。
begin;
create or replace function public.ledger_mcp_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  claims jsonb := event->'claims';
  oauth_client text := coalesce(event->>'client_id', event->'claims'->>'client_id');
  bound boolean;
  resource text := 'https://joyqlelzapraawudhuxn.supabase.co/functions/v1/ledger-mcp';
  audiences jsonb;
begin
  if oauth_client is null then return event; end if;
  select exists(select 1 from ledger_mcp_private.connection c
    where c.enabled and c.client_id=oauth_client and c.user_id::text=coalesce(event->>'user_id',claims->>'sub')) into bound;
  if not bound then return event; end if;
  audiences := case jsonb_typeof(claims->'aud')
    when 'array' then claims->'aud'
    when 'string' then jsonb_build_array(claims->>'aud')
    else '[]'::jsonb end;
  if not audiences @> jsonb_build_array(resource) then audiences := audiences || jsonb_build_array(resource); end if;
  claims := jsonb_set(claims,'{aud}',audiences);
  claims := jsonb_set(claims,'{client_id}',to_jsonb(oauth_client));
  return jsonb_set(event,'{claims}',claims);
end $$;
revoke all on function public.ledger_mcp_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.ledger_mcp_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
commit;
