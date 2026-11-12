alter table purchases add column idempotency_key text;
alter table purchases add column meta jsonb;
create unique index purchases_idem_idx on purchases (account_id, idempotency_key) where idempotency_key is not null;

create table bot_events (
    event_id uuid primary key,
    account_id uuid not null references accounts (id),
    provider text not null check (provider in ('telegram', 'whatsapp')),
    type text not null check (type in ('ask_question', 'prep_answer', 'prep_session_finished')),
    occurred_at timestamptz not null,
    received_at timestamptz not null default now()
);

create index bot_events_account_idx on bot_events (account_id, occurred_at desc);

alter table bot_events enable row level security;
