update ledger_mcp_private.connection set deletions_enabled=true where singleton and enabled;
select enabled,deletions_enabled from ledger_mcp_private.connection where singleton;
