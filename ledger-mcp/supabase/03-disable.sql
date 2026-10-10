-- 撤销服务器读取权限。不会删除账单，也不会放开 OAuth 写入保护。
update ledger_mcp_private.connection set enabled=false where singleton=true;
