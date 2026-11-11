create table study_sessions (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    conversation_id uuid,
    mode text not null check (mode in ('quiz', 'flashcards', 'fill_blank', 'mock_exam')),
    status text not null default 'generating'
        check (status in ('generating', 'active', 'completed', 'failed', 'expired')),
    file_ids uuid[] not null,
    topic_ids uuid[] not null default '{}',
    requested_count integer not null check (requested_count between 2 and 30),
    round integer not null default 1 check (round >= 1),
    current_index integer not null default 0 check (current_index >= 0),
    cost integer not null default 1 check (cost = 1),
    refunded_at timestamptz,
    retry_of uuid references study_sessions (id),
    time_limit_seconds integer check (time_limit_seconds > 0),
    error text,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    expires_at timestamptz not null
);

create index study_sessions_account_idx on study_sessions (account_id, created_at desc);
create unique index study_sessions_one_open_idx on study_sessions (account_id)
    where status in ('generating', 'active');

create table session_items (
    session_id uuid not null references study_sessions (id) on delete cascade,
    round integer not null default 1,
    idx integer not null check (idx >= 0),
    type text not null check (type in ('mcq', 'true_false', 'fill_gap', 'short', 'theory', 'calculation', 'flashcard')),
    prompt text not null,
    options jsonb,
    back text,
    answer_key jsonb not null,
    marks integer not null default 1 check (marks >= 1),
    difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
    topic text not null,
    source_label text not null,
    chunk_id uuid references file_chunks (id) on delete set null,
    primary key (session_id, round, idx)
);

create table session_answers (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references study_sessions (id) on delete cascade,
    account_id uuid not null references accounts (id),
    round integer not null default 1,
    item_idx integer not null,
    answer text,
    outcome text check (outcome in ('know', 'missed')),
    dont_know boolean not null default false,
    result text not null check (result in ('right', 'not_quite', 'partly', 'skipped')),
    awarded_marks integer not null default 0 check (awarded_marks >= 0),
    verdict jsonb not null,
    idempotency_key text not null,
    answered_at timestamptz not null,
    received_at timestamptz not null default now(),
    unique (session_id, idempotency_key),
    unique (session_id, round, item_idx)
);

create index session_answers_account_idx on session_answers (account_id, answered_at desc);

create table session_results (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    session_id uuid not null unique references study_sessions (id) on delete cascade,
    mode text not null,
    score integer not null check (score >= 0),
    total integer not null check (total >= 0),
    failed_topics text[] not null default '{}',
    source_docs text[] not null default '{}',
    charged integer not null check (charged between 0 and 1),
    created_at timestamptz not null default now()
);

create table study_events (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    kind text not null check (kind in ('prep_answer', 'flashcard_rating', 'ask_question', 'session_finished')),
    source text not null check (source in ('app', 'telegram', 'whatsapp')),
    event_id uuid unique,
    session_id uuid,
    topic_id uuid,
    question_count integer,
    answered_count integer,
    day date not null,
    occurred_at timestamptz not null,
    received_at timestamptz not null default now(),
    check (source = 'app' or event_id is not null)
);

create index study_events_account_day_idx on study_events (account_id, day);

create table study_days (
    account_id uuid not null references accounts (id),
    day date not null,
    reason text not null check (reason in ('session', 'three_items', 'imported')),
    first_counted_at timestamptz not null default now(),
    primary key (account_id, day)
);

create table streaks (
    account_id uuid primary key references accounts (id),
    current integer not null default 0 check (current >= 0),
    longest integer not null default 0 check (longest >= current),
    run_days integer not null default 0 check (run_days between 0 and 5),
    freeze_held boolean not null default false,
    last_study_day date,
    last_closed_day date,
    updated_at timestamptz not null default now()
);

create trigger streaks_set_updated_at before update on streaks
    for each row execute function set_updated_at();

create table streak_freezes (
    account_id uuid not null references accounts (id),
    day date not null,
    used_at timestamptz not null default now(),
    primary key (account_id, day)
);

create table streak_imports (
    account_id uuid primary key references accounts (id),
    legacy_streak integer not null check (legacy_streak >= 0),
    legacy_last_active date,
    imported_at timestamptz not null default now()
);

create table leaderboard_optins (
    account_id uuid primary key references accounts (id),
    opted_in boolean not null default false,
    display_name text check (char_length(display_name) between 2 and 20),
    updated_at timestamptz not null default now()
);

create trigger leaderboard_optins_set_updated_at before update on leaderboard_optins
    for each row execute function set_updated_at();

create table weekly_scores (
    account_id uuid not null references accounts (id),
    week_start date not null,
    study_days integer not null default 0 check (study_days between 0 and 7),
    reached_at timestamptz,
    primary key (account_id, week_start)
);

create table wrapped_cache (
    account_id uuid not null references accounts (id),
    period text not null check (period ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$'),
    status text not null check (status in ('ready', 'not_ready')),
    stats jsonb,
    generated_at timestamptz not null default now(),
    primary key (account_id, period)
);

alter table study_sessions enable row level security;
alter table session_items enable row level security;
alter table session_answers enable row level security;
alter table session_results enable row level security;
alter table study_events enable row level security;
alter table study_days enable row level security;
alter table streaks enable row level security;
alter table streak_freezes enable row level security;
alter table streak_imports enable row level security;
alter table leaderboard_optins enable row level security;
alter table weekly_scores enable row level security;
alter table wrapped_cache enable row level security;
