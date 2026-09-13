-- The Fleet tab's "Recall this robot" button had no path to the engine:
-- robot_commands only carried the two human-confirmation commands, so an
-- admin-initiated recall could not cross the process boundary at all.
-- The engine's FSM already supports recall (task_engine/engine.py _handle,
-- kind == "recall"); this is the missing transport, not new behaviour.
alter table robot_commands drop constraint robot_commands_cmd_check;
alter table robot_commands add constraint robot_commands_cmd_check
  check (cmd in ('complete_loading', 'complete_collection', 'recall'));

-- Recall carries an operator-supplied reason; the two confirmation
-- commands leave it null.
alter table robot_commands add column reason text;
