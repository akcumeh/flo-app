create table auth_challenges (
    id uuid primary key default gen_random_uuid(),
    secret_hash text not null unique,
    code text not null,
    channel text not null check (channel in ('telegram', 'whatsapp')),
    intent text not null check (intent in ('signin', 'link')),
    account_id uuid references accounts (id),
    status text not null default 'pending' check (status in ('pending', 'verified', 'redeemed', 'expired')),
    claimed_provider_user_id text,
    claimed_profile jsonb,
    ip_hash text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    verified_at timestamptz,
    redeemed_at timestamptz,
    check (intent = 'signin' or account_id is not null)
);

create unique index auth_challenges_pending_code_idx on auth_challenges (channel, code)
    where status = 'pending';
create index auth_challenges_expires_idx on auth_challenges (expires_at);

create table merge_tokens (
    id uuid primary key default gen_random_uuid(),
    token_hash text not null unique,
    account_id uuid not null references accounts (id),
    other_account_id uuid not null references accounts (id),
    provider text not null,
    provider_user_id text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz,
    check (account_id <> other_account_id)
);

create table student_verifications (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    school_email_canonical text not null unique,
    school_id uuid not null references schools (id),
    method text not null check (method in ('email_code', 'google_hd')),
    verified_at timestamptz not null default now(),
    expires_at timestamptz not null,
    bonus_granted_at timestamptz
);

create index student_verifications_account_idx on student_verifications (account_id);

alter table auth_challenges enable row level security;
alter table merge_tokens enable row level security;
alter table student_verifications enable row level security;
