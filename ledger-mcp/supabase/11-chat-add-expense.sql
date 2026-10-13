-- ChatGPT native tool approval is the human confirmation boundary.
-- The database verifies identity and idempotency, not a browser-click receipt.
begin;
alter table ledger_mcp_private.connection add column if not exists chat_add_enabled boolean not null default false;
create or replace function public.ledger_mcp_chat_add_expense(
 p_request_id uuid,p_name text,p_amount text,p_category text,p_date date
) returns jsonb language plpgsql security definer set search_path='' as $$
declare prepared jsonb; d ledger_mcp_private.expense_drafts; saved_id uuid; reused boolean;
begin
 perform 1 from ledger_mcp_private.connection c where c.enabled and c.drafts_enabled and c.chat_add_enabled
 and c.user_id=auth.uid() and c.client_id=auth.jwt()->>'client_id' for update;
 if not found then raise exception 'Chat add disabled or unauthorized' using errcode='42501'; end if;
 -- Reuse strict validation and the existing per-intent idempotency record.
 prepared:=public.ledger_mcp_prepare_expense(p_request_id,p_name,p_amount,p_category,p_date);
 select * into strict d from ledger_mcp_private.expense_drafts where id=(prepared->>'draft_id')::uuid for update;
 reused:=d.expense_id is not null;
 if reused then saved_id:=d.expense_id;
 else
   if d.expires_at<=now() then raise exception 'Request expired; do not retry with a new ID without confirmation' using errcode='22023'; end if;
   saved_id:=gen_random_uuid();
   insert into public.expenses(id,user_id,name,amount,category,date)
   values(saved_id,d.user_id,d.name,d.amount,d.category,d.expense_date::timestamp at time zone 'Asia/Shanghai');
   update ledger_mcp_private.expense_drafts set expense_id=saved_id where id=d.id;
 end if;
 return jsonb_build_object('status','saved','expense_id',saved_id,'draft_id',d.id,'already_saved',reused,
 'currently_exists',exists(select 1 from public.expenses where id=saved_id and user_id=d.user_id),
 'name',d.name,'amount_yuan',d.amount::text,'category',d.category,'date',d.expense_date,'timezone','Asia/Shanghai');
end $$;
revoke all on function public.ledger_mcp_chat_add_expense(uuid,text,text,text,date) from public,anon;
grant execute on function public.ledger_mcp_chat_add_expense(uuid,text,text,text,date) to authenticated;
commit;
