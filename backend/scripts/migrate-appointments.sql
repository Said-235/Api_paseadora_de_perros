-- Horario de trabajo en paseadores + citas agendadas

ALTER TABLE walkers
  ADD COLUMN IF NOT EXISTS work_start_time TIME NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS work_end_time TIME NOT NULL DEFAULT '18:00',
  ADD COLUMN IF NOT EXISTS work_days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5];

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  walker_id INTEGER NOT NULL REFERENCES walkers(id) ON DELETE CASCADE,
  dog_name VARCHAR(100) NOT NULL,
  breed_id INTEGER REFERENCES breeds(id),
  dog_age INTEGER,
  is_hyperactive BOOLEAN DEFAULT FALSE,
  special_needs TEXT,
  owner_name VARCHAR(100),
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  status VARCHAR(20) DEFAULT 'scheduled',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (walker_id, appointment_date, appointment_time)
);

CREATE INDEX IF NOT EXISTS idx_appointments_walker_date
  ON appointments (walker_id, appointment_date);
