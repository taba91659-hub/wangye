update ledger_mcp_private.connection set chat_add_enabled=true where singleton and enabled and drafts_enabled;
select enabled,drafts_enabled,chat_add_enabled from ledger_mcp_private.connection where singleton;
