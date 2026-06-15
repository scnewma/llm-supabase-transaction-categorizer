create extension if not exists vector with schema extensions;

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_date date not null,
  payee text not null,
  notes text not null default '',
  category text not null,
  amount numeric(12, 2) not null,
  embedding extensions.vector(384) not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint transactions_amount_not_zero check (amount <> 0)
);

create index if not exists transactions_embedding_hnsw_idx
  on public.transactions
  using hnsw (embedding extensions.vector_cosine_ops);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_transactions_updated_at
  before update on public.transactions
  for each row
  execute function public.set_updated_at();

alter table public.transactions enable row level security;

-- HACK: for an example we are just opening things up

grant usage on schema public to anon;
grant select, insert, update, delete on table public.transactions to anon;

create policy "Allow anonymous transaction inserts"
    on public.transactions for insert
    to anon with check (true);
create policy "Allow anonymous transaction selects"
    on public.transactions for select
    to anon using (true);
create policy "Allow anonymous transaction updates"
    on public.transactions for update
    to anon using (true) with check (true);
create policy "Allow anonymous transaction deletes"
    on public.transactions for delete
    to anon using (true);
