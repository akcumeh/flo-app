create table accounts (
    id uuid primary key default gen_random_uuid(),
    display_name text not null,
    username text unique,
    timezone text,
    token_balance integer not null default 0 check (token_balance >= 0),
    app_bonus_granted_at timestamptz,
    merged_into uuid references accounts (id),
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table identities (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    provider text not null check (provider in ('telegram', 'whatsapp', 'email', 'google')),
    provider_user_id text not null,
    display text,
    legacy_user_id text unique,
    verified_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (provider, provider_user_id)
);

create index identities_account_idx on identities (account_id);

create table email_codes (
    id uuid primary key default gen_random_uuid(),
    email_canonical text not null,
    purpose text not null check (purpose in ('signin', 'link', 'student')),
    code_hash text not null,
    ip_hash text,
    attempts integer not null default 0,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
);

create index email_codes_email_idx on email_codes (email_canonical, created_at desc);
create index email_codes_ip_idx on email_codes (ip_hash, created_at desc);

create table auth_sessions (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    family_id uuid not null,
    token_hash text not null unique,
    user_agent text,
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    expires_at timestamptz not null,
    rotated_at timestamptz,
    revoked_at timestamptz
);

create index auth_sessions_family_idx on auth_sessions (family_id);

create table token_ledger (
    id bigserial primary key,
    account_id uuid not null references accounts (id),
    delta integer not null,
    reason text not null check (reason in (
        'welcome_grant', 'student_bonus', 'streak_reward', 'purchase',
        'chat_charge', 'prep_charge', 'create_charge', 'refund',
        'merge_in', 'merge_out', 'legacy_import', 'admin_adjust'
    )),
    ref_type text,
    ref_id text,
    idempotency_key text,
    balance_after integer not null check (balance_after >= 0),
    created_at timestamptz not null default now()
);

create unique index token_ledger_idem_idx on token_ledger (account_id, idempotency_key)
    where idempotency_key is not null;
create unique index token_ledger_one_refund_idx on token_ledger (ref_type, ref_id)
    where reason = 'refund';
create index token_ledger_account_idx on token_ledger (account_id, id desc);

create or replace function set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger accounts_set_updated_at before update on accounts
    for each row execute function set_updated_at();

alter table accounts enable row level security;
alter table identities enable row level security;
alter table email_codes enable row level security;
alter table auth_sessions enable row level security;
alter table token_ledger enable row level security;
