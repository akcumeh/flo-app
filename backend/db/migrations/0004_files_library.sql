create table stored_files (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id),
    name text not null,
    mime_type text not null,
    size_bytes bigint not null check (size_bytes between 0 and 20971520),
    kind text not null check (kind in ('image', 'document', 'audio')),
    origin text not null default 'app' check (origin in ('chat', 'prep', 'create', 'drive', 'app')),
    status text not null default 'uploading' check (status in ('uploading', 'reading', 'ready', 'failed')),
    error text,
    page_count integer check (page_count >= 1),
    course_id uuid references courses (id),
    storage_path text,
    content_sha256 text,
    tg_file_id text,
    wa_media_id text,
    anthropic_file_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);

create unique index stored_files_dedupe_idx on stored_files (account_id, content_sha256)
    where content_sha256 is not null and deleted_at is null;
create index stored_files_account_idx on stored_files (account_id, created_at desc) where deleted_at is null;
create index stored_files_course_idx on stored_files (course_id) where course_id is not null;

create trigger stored_files_set_updated_at before update on stored_files
    for each row execute function set_updated_at();

create table file_parts (
    file_id uuid not null references stored_files (id) on delete cascade,
    part integer not null check (part >= 1),
    storage_path text not null,
    mime_type text not null,
    size_bytes bigint not null check (size_bytes >= 0),
    primary key (file_id, part)
);

create table file_chunks (
    id uuid primary key default gen_random_uuid(),
    file_id uuid not null references stored_files (id) on delete cascade,
    account_id uuid not null references accounts (id),
    page integer check (page >= 1),
    ord integer not null,
    text text not null,
    tsv tsvector generated always as (to_tsvector('english', text)) stored,
    unique (file_id, ord)
);

create index file_chunks_tsv_idx on file_chunks using gin (tsv);
create index file_chunks_account_idx on file_chunks (account_id);

create table file_topics (
    id uuid primary key default gen_random_uuid(),
    file_id uuid not null references stored_files (id) on delete cascade,
    name text not null,
    pages text,
    unique (file_id, name)
);

create table jobs (
    id bigserial primary key,
    kind text not null,
    payload jsonb not null default '{}'::jsonb,
    status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
    attempts integer not null default 0,
    run_after timestamptz not null default now(),
    locked_at timestamptz,
    error text,
    created_at timestamptz not null default now(),
    finished_at timestamptz
);

create index jobs_ready_idx on jobs (run_after) where status = 'queued';

alter table stored_files enable row level security;
alter table file_parts enable row level security;
alter table file_chunks enable row level security;
alter table file_topics enable row level security;
alter table jobs enable row level security;
