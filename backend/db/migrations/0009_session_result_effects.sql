alter table session_results add column study_day jsonb;
alter table session_results add column streak_reward integer check (streak_reward > 0);
