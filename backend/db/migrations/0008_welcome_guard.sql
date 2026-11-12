create table welcome_grants (
    provider text not null check (provider in ('telegram', 'whatsapp', 'email', 'google')),
    provider_user_id text not null,
    account_id uuid not null references accounts (id),
    created_at timestamptz not null default now(),
    primary key (provider, provider_user_id)
);

alter table welcome_grants enable row level security;
