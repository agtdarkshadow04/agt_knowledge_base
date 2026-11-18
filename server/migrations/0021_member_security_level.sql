-- #70: a member's security level (AGT scale 0-5) decides which articles they
-- read and may assign; the role keeps only the moderation powers. Existing
-- members keep the access their role gave them: Editors read up to 1 (Public,
-- Internal, Private), Moderators everything (5). The server writes the level
-- of every new member itself; the default only fills existing rows here.
ALTER TABLE local_users
  ADD COLUMN security_level integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT local_users_security_level_check CHECK (security_level BETWEEN 0 AND 5);

UPDATE local_users SET security_level = CASE role WHEN 'Moderator' THEN 5 ELSE 1 END;

ALTER TABLE local_users ALTER COLUMN security_level DROP DEFAULT;
