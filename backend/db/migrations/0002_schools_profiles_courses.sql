alter table token_ledger drop constraint token_ledger_reason_check;
alter table token_ledger add constraint token_ledger_reason_check check (reason in (
    'welcome_grant', 'student_bonus', 'streak_reward', 'purchase',
    'chat_charge', 'prep_charge', 'create_charge', 'refund', 'referral_reward',
    'merge_in', 'merge_out', 'legacy_import', 'admin_adjust'
));

alter table accounts add column avatar_url text;

create table schools (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    short_name text,
    kind text not null check (kind in ('university', 'polytechnic', 'college_of_education', 'other')),
    ownership text check (ownership in ('federal', 'state', 'private')),
    state text,
    country text not null default 'NG',
    website text,
    created_at timestamptz not null default now(),
    unique (country, name)
);

create index schools_name_idx on schools (lower(name) text_pattern_ops);
create index schools_short_name_idx on schools (lower(short_name) text_pattern_ops);

create table school_domains (
    domain text primary key check (domain = lower(domain)),
    school_id uuid not null references schools (id),
    reviewed boolean not null default false,
    created_at timestamptz not null default now()
);

create index school_domains_school_idx on school_domains (school_id);

create table domain_reviews (
    domain text primary key check (domain = lower(domain)),
    requests integer not null default 1,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create table departments (
    id uuid primary key default gen_random_uuid(),
    school_id uuid not null references schools (id),
    name text not null,
    created_at timestamptz not null default now(),
    unique (school_id, name)
);

create table courses (
    id uuid primary key default gen_random_uuid(),
    school_id uuid not null references schools (id),
    code_normalised text not null check (code_normalised <> '' and code_normalised = upper(code_normalised)),
    code_display text not null,
    title text,
    created_by uuid references accounts (id),
    created_at timestamptz not null default now(),
    unique (school_id, code_normalised)
);

create table enrolments (
    account_id uuid not null references accounts (id),
    course_id uuid not null references courses (id),
    exam_date date,
    created_at timestamptz not null default now(),
    primary key (account_id, course_id)
);

create index enrolments_course_idx on enrolments (course_id);

create table profiles (
    account_id uuid primary key references accounts (id),
    school_id uuid references schools (id),
    department_id uuid references departments (id),
    level integer check (level between 100 and 700),
    exam_date date,
    onboarding_complete boolean not null default false,
    updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on profiles
    for each row execute function set_updated_at();

create table facts (
    id uuid primary key default gen_random_uuid(),
    day date not null unique,
    text text not null,
    topic text,
    source text,
    created_at timestamptz not null default now()
);

alter table schools enable row level security;
alter table school_domains enable row level security;
alter table domain_reviews enable row level security;
alter table departments enable row level security;
alter table courses enable row level security;
alter table enrolments enable row level security;
alter table profiles enable row level security;
alter table facts enable row level security;
