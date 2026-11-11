create table purchases (
    reference text primary key,
    account_id uuid not null references accounts (id),
    bundle_id text not null,
    amount_kobo integer not null check (amount_kobo > 0),
    tokens integer not null check (tokens > 0),
    status text not null default 'pending'
        check (status in ('pending', 'awaiting_transfer', 'success', 'failed', 'expired')),
    channel text,
    created_at timestamptz not null default now(),
    completed_at timestamptz
);

create index purchases_account_idx on purchases (account_id, created_at desc);

create table push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    user_agent text,
    created_at timestamptz not null default now(),
    last_success_at timestamptz,
    failure_count integer not null default 0
);

create index push_subscriptions_account_idx on push_subscriptions (account_id);

create table notification_preferences (
    account_id uuid primary key references accounts (id),
    channel text not null default 'web_push' check (channel in ('web_push', 'telegram', 'whatsapp', 'none')),
    daily_reminder boolean not null default true,
    reminder_local_time time not null default '20:00'
        check (reminder_local_time between '06:00' and '22:00'),
    streak_nudges boolean not null default true,
    leaderboard_updates boolean not null default false,
    weekly_results boolean not null default false,
    last_reminded_day date,
    updated_at timestamptz not null default now()
);

create trigger notification_preferences_set_updated_at before update on notification_preferences
    for each row execute function set_updated_at();

create table referral_codes (
    account_id uuid primary key references accounts (id),
    code text not null unique,
    created_at timestamptz not null default now()
);

create table referrals (
    invitee_account_id uuid primary key references accounts (id),
    inviter_account_id uuid not null references accounts (id),
    redeemed_at timestamptz not null default now(),
    rewarded_at timestamptz,
    check (invitee_account_id <> inviter_account_id)
);

create index referrals_inviter_idx on referrals (inviter_account_id);

create table data_exports (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    status text not null default 'queued' check (status in ('queued', 'ready', 'failed', 'expired')),
    storage_path text,
    requested_at timestamptz not null default now(),
    ready_at timestamptz,
    expires_at timestamptz
);

create table account_deletions (
    account_id uuid primary key references accounts (id),
    requested_at timestamptz not null default now(),
    deletes_at timestamptz not null,
    cancelled_at timestamptz,
    completed_at timestamptz
);

alter table purchases enable row level security;
alter table push_subscriptions enable row level security;
alter table notification_preferences enable row level security;
alter table referral_codes enable row level security;
alter table referrals enable row level security;
alter table data_exports enable row level security;
alter table account_deletions enable row level security;
