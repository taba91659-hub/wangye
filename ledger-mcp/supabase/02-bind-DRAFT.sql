-- 等创建好 OAuth 客户端后填写；只绑定你自己的一个账号。
-- UID与Client ID是标识符，不是密码；此处不需要任何secret。
begin;
do $$
declare
  account_uid uuid := '00000000-0000-0000-0000-000000000000';
  oauth_client_id text := 'REPLACE_WITH_OAUTH_CLIENT_ID';
begin
  if account_uid='00000000-0000-0000-0000-000000000000'::uuid
     or oauth_client_id='REPLACE_WITH_OAUTH_CLIENT_ID' then
    raise exception '请先填写自己的用户 UID 和已注册的 OAuth Client ID';
  end if;
  if not exists(select 1 from auth.users where id=account_uid) then raise exception '用户不存在'; end if;
  insert into ledger_mcp_private.connection(singleton,user_id,client_id,enabled)
  values(true,account_uid,oauth_client_id,true)
  on conflict(singleton) do update set user_id=excluded.user_id,client_id=excluded.client_id,enabled=true;
end $$;
commit;
