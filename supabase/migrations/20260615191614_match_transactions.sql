create or replace function public.match_transactions(
    query_embedding extensions.vector(384),
    query_amount numeric,
    match_count int default 20
)
returns table (
    id uuid,
    transaction_date date,
    payee text,
    notes text,
    category text,
    amount numeric,
    similarity float,
    embedding_similarity float,
    amount_similarity float
)
language sql
stable
as $$
    select
        transactions.id,
        transactions.transaction_date,
        transactions.payee,
        transactions.notes,
        transactions.category,
        transactions.amount,
        (
            0.8 * (1 - (transactions.embedding <=> query_embedding)) +
            0.2 * (1 / (1 + abs(abs(transactions.amount) - abs(query_amount)) / 25.0))
        )::float as similarity,
        (1 - (transactions.embedding <=> query_embedding))::float as embedding_similarity,
        (1 / (1 + abs(abs(transactions.amount) - abs(query_amount)) / 25.0))::float as amount_similarity
    from public.transactions
    order by similarity desc
    limit match_count;
$$;

grant execute on function public.match_transactions(extensions.vector, numeric, int) to anon;
