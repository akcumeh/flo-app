create table phone_codes (
    id uuid primary key default gen_random_uuid(),
    phone text not null,
    code_hash text not null,
    ip_hash text,
    attempts integer not null default 0,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
);

create index phone_codes_phone_idx on phone_codes (phone, created_at desc);
create index phone_codes_ip_idx on phone_codes (ip_hash, created_at desc);

alter table phone_codes enable row level security;
