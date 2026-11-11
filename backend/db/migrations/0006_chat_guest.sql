create table requests (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    idempotency_key text not null,
    kind text not null check (kind in ('chat', 'prep', 'create')),
    status text not null default 'in_flight' check (status in ('in_flight', 'completed', 'failed', 'cancelled')),
    charged integer not null default 0 check (charged >= 0),
    created_at timestamptz not null default now(),
    finished_at timestamptz,
    unique (account_id, idempotency_key)
);

create table conversations (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    title text,
    mode text not null default 'ask' check (mode in ('ask', 'prep')),
    created_at timestamptz not null default now(),
    last_message_at timestamptz,
    archived_at timestamptz,
    deleted_at timestamptz
);

create index conversations_account_idx on conversations (account_id, last_message_at desc nulls last)
    where deleted_at is null;

alter table study_sessions add constraint study_sessions_conversation_fk
    foreign key (conversation_id) references conversations (id) on delete set null;

create table messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations (id) on delete cascade,
    role text not null check (role in ('user', 'assistant')),
    content jsonb not null,
    citations jsonb not null default '[]'::jsonb,
    grounded boolean not null default true,
    request_id uuid references requests (id),
    charged integer not null default 0 check (charged >= 0),
    created_at timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at);

create table saved_answers (
    account_id uuid not null references accounts (id),
    message_id uuid not null references messages (id) on delete cascade,
    saved_at timestamptz not null default now(),
    primary key (account_id, message_id)
);

create table guest_sessions (
    token_hash text primary key,
    device_hash text not null,
    ip_hash text not null,
    questions_used integer not null default 0 check (questions_used between 0 and 3),
    claimed_by uuid references accounts (id),
    claimed_at timestamptz,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);

create index guest_sessions_device_idx on guest_sessions (device_hash);
create index guest_sessions_ip_idx on guest_sessions (ip_hash, created_at desc);

create table guest_messages (
    id uuid primary key default gen_random_uuid(),
    guest_token_hash text not null references guest_sessions (token_hash) on delete cascade,
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    created_at timestamptz not null default now()
);

create index guest_messages_session_idx on guest_messages (guest_token_hash, created_at);

alter table requests enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table saved_answers enable row level security;
alter table guest_sessions enable row level security;
alter table guest_messages enable row level security;
