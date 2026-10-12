-- 只停用新增草稿和确认保存；现有查询继续可用。
update ledger_mcp_private.connection set drafts_enabled=false where singleton;
