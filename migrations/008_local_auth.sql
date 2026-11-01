CREATE TABLE local_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(64) NOT NULL UNIQUE
    CHECK (username = lower(username) AND username ~ '^[a-z0-9_.-]{3,64}$'),
  password_hash text NOT NULL,
  display_name varchar(120) NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  email varchar(254) UNIQUE CHECK (email IS NULL OR email = lower(email)),
  role varchar(16) NOT NULL CHECK (role IN ('Admin', 'Standard')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
