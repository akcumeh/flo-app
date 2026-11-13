alter table guest_sessions add column visitor_hash text;

create index guest_sessions_visitor_idx on guest_sessions (visitor_hash) where visitor_hash is not null;
