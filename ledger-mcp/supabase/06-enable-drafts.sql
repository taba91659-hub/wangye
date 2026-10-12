-- 确认页和新版接口发布完后再执行。仅启用当前绑定账号的草稿流程。
update ledger_mcp_private.connection set drafts_enabled=true where singleton and enabled;
select enabled,drafts_enabled from ledger_mcp_private.connection where singleton;
