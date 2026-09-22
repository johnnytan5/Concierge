-- The room is a property of the CALL, known before anyone speaks: a hotel
-- PBX maps the extension a guest dialled from to their room, so reception
-- sees it on the display as it rings. It is not something the assistant
-- should have to ask for, and it is not something to reconstruct afterwards
-- from whatever room happened to be passed to a tool.
--
-- Nullable: a call placed without one (the plain `python -m orchestrator.agent`
-- path, with no PBX in front of it) still works, and the dashboard falls back
-- to deriving the room from tool arguments for those.
alter table voice_sessions add column room text;
