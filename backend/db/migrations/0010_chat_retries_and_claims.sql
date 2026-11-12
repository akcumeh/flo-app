alter table requests add column attempts integer not null default 1 check (attempts >= 1);
alter table guest_sessions add column claimed_conversation_id uuid references conversations (id) on delete set null;
create index file_chunks_file_idx on file_chunks (file_id, ord);
