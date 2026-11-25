alter table study_sessions drop constraint if exists study_sessions_cost_check;
alter table study_sessions add constraint study_sessions_cost_check check (cost >= 1);
alter table session_results drop constraint if exists session_results_charged_check;
alter table session_results add constraint session_results_charged_check check (charged >= 0);
