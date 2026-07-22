-- Move access from the anonymous role to authenticated users.
-- Single-user app: any authenticated user may read/write all transactions.

drop policy if exists "Allow anonymous transaction inserts" on public.transactions;
drop policy if exists "Allow anonymous transaction selects" on public.transactions;
drop policy if exists "Allow anonymous transaction updates" on public.transactions;
drop policy if exists "Allow anonymous transaction deletes" on public.transactions;

revoke all on table public.transactions from anon;
revoke execute on function public.match_transactions(extensions.vector, numeric, int) from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.transactions to authenticated;
grant execute on function public.match_transactions(extensions.vector, numeric, int) to authenticated;

create policy "Allow authenticated transaction inserts"
    on public.transactions for insert
    to authenticated with check (true);
create policy "Allow authenticated transaction selects"
    on public.transactions for select
    to authenticated using (true);
create policy "Allow authenticated transaction updates"
    on public.transactions for update
    to authenticated using (true) with check (true);
create policy "Allow authenticated transaction deletes"
    on public.transactions for delete
    to authenticated using (true);
