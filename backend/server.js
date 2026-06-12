require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

app.use(cors());
app.use(express.json());
app.use(express.static(FRONTEND_DIR));

// ── Conexión a Neon ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('❌ Error en el pool de PostgreSQL:', err.message);
});

pool.connect()
  .then((client) => {
    console.log('✅ Conectado a Neon PostgreSQL');
    client.release();
  })
  .catch(err => console.error('❌ Error de conexión:', err.message));

function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function timeToMinutes(t) {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function jsDayToIso(day) {
  return day === 0 ? 7 : day;
}

function generateSlots(startTime, endTime, bookedTimes) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  const booked = new Set(bookedTimes.map(t => String(t).slice(0, 5)));
  const slots = [];
  for (let m = startMin; m < endMin; m += 60) {
    const slot = minutesToTime(m);
    if (!booked.has(slot)) slots.push(slot);
  }
  return slots;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAZAS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/breeds — todas las razas
app.get('/api/breeds', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM breeds ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/breeds — registra una raza personalizada
app.post('/api/breeds', async (req, res) => {
  const { name, size, energy_level } = req.body;
  const validSizes = ['small', 'medium', 'large', 'giant'];

  if (!name || !name.trim())
    return res.status(400).json({ error: 'El nombre de la raza es requerido' });
  if (!validSizes.includes(size))
    return res.status(400).json({ error: 'Tamaño inválido' });
  if (!energy_level || energy_level < 1 || energy_level > 5)
    return res.status(400).json({ error: 'El nivel de energía debe ser entre 1 y 5' });

  try {
    const existing = await pool.query(
      'SELECT * FROM breeds WHERE LOWER(name) = LOWER($1)',
      [name.trim()]
    );
    if (existing.rows.length > 0)
      return res.json(existing.rows[0]);

    const result = await pool.query(
      `INSERT INTO breeds (name, size, energy_level)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), size, parseInt(energy_level, 10)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MATCHING — núcleo del sistema
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/match — encuentra paseadores compatibles con el perro
app.post('/api/match', async (req, res) => {
  const { breed_id, age, is_hyperactive, special_needs } = req.body;

  if (!breed_id) return res.status(400).json({ error: 'breed_id requerido' });

  try {
    // Obtenemos los datos de la raza para conocer size y energy_level
    const breedResult = await pool.query('SELECT * FROM breeds WHERE id = $1', [breed_id]);
    if (breedResult.rows.length === 0)
      return res.status(404).json({ error: 'Raza no encontrada' });

    const breed = breedResult.rows[0];
    const hasSpecialNeeds = Boolean(special_needs && String(special_needs).trim().length > 0);

    // Matching: el paseador debe poder manejar el tamaño, nivel de energía y condiciones
    const sizeOrder = ['small', 'medium', 'large', 'giant'];
    const dogSizeIndex = sizeOrder.indexOf(breed.size);

    const query = `
      SELECT 
        w.id, w.name, w.experience_years, w.bio, w.rating,
        w.max_dogs_per_walk, w.available,
        wc.max_size, wc.max_energy_level,
        wc.handles_hyperactive, wc.handles_special_needs,
        -- Score de compatibilidad (mayor = mejor match)
        (
          CASE WHEN w.experience_years >= 3 THEN 20 ELSE w.experience_years * 5 END +
          CASE WHEN wc.max_energy_level >= $1 THEN (wc.max_energy_level - $1 + 1) * 10 ELSE 0 END +
          CASE WHEN w.rating IS NOT NULL THEN (w.rating * 5)::INTEGER ELSE 0 END
        ) AS match_score
      FROM walkers w
      JOIN walker_capabilities wc ON wc.walker_id = w.id
      WHERE 
        w.available = TRUE
        AND wc.max_energy_level >= $1
        AND (
          CASE wc.max_size
            WHEN 'small'  THEN 0
            WHEN 'medium' THEN 1
            WHEN 'large'  THEN 2
            WHEN 'giant'  THEN 3
          END
        ) >= $2
        AND ($3 = FALSE OR wc.handles_hyperactive = TRUE)
        AND ($4 = FALSE OR wc.handles_special_needs = TRUE)
      ORDER BY match_score DESC, w.rating DESC
    `;

    const values = [
      breed.energy_level,
      dogSizeIndex,
      toBool(is_hyperactive),
      hasSpecialNeeds
    ];

    const walkers = await pool.query(query, values);

    res.json({
      breed,
      dog: { breed_id, age, is_hyperactive, special_needs },
      walkers: walkers.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PASEADORES (modo experto: registro)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/walkers — todos los paseadores
app.get('/api/walkers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, wc.max_size, wc.max_energy_level,
             wc.handles_hyperactive, wc.handles_special_needs
      FROM walkers w
      LEFT JOIN walker_capabilities wc ON wc.walker_id = w.id
      ORDER BY w.rating DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/walkers/login — inicio de sesión simple por nombre
app.post('/api/walkers/login', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim())
    return res.status(400).json({ error: 'Nombre requerido' });

  try {
    const result = await pool.query(`
      SELECT w.*, wc.max_size, wc.max_energy_level,
             wc.handles_hyperactive, wc.handles_special_needs
      FROM walkers w
      LEFT JOIN walker_capabilities wc ON wc.walker_id = w.id
      WHERE LOWER(TRIM(w.name)) = LOWER(TRIM($1))
      ORDER BY w.id DESC
      LIMIT 1
    `, [name.trim()]);

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'No encontramos un paseador con ese nombre' });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/walkers/:id/availability?date=YYYY-MM-DD
app.get('/api/walkers/:id/availability', async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Fecha inválida (YYYY-MM-DD)' });

  try {
    const walkerResult = await pool.query(
      'SELECT id, name, work_start_time, work_end_time, work_days FROM walkers WHERE id = $1',
      [id]
    );
    if (walkerResult.rows.length === 0)
      return res.status(404).json({ error: 'Paseador no encontrado' });

    const walker = walkerResult.rows[0];
    const dateObj = new Date(date + 'T12:00:00');
    const isoDay = jsDayToIso(dateObj.getDay());

    if (!walker.work_days.includes(isoDay)) {
      return res.json({ date, available: false, reason: 'El paseador no trabaja ese día', slots: [] });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dateObj < today)
      return res.json({ date, available: false, reason: 'No puedes agendar en fechas pasadas', slots: [] });

    const booked = await pool.query(
      `SELECT appointment_time FROM appointments
       WHERE walker_id = $1 AND appointment_date = $2 AND status = 'scheduled'`,
      [id, date]
    );

    const slots = generateSlots(
      walker.work_start_time,
      walker.work_end_time,
      booked.rows.map(r => r.appointment_time)
    );

    res.json({
      date,
      available: slots.length > 0,
      work_start: String(walker.work_start_time).slice(0, 5),
      work_end: String(walker.work_end_time).slice(0, 5),
      slots
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/walkers/:id/appointments?year=2025&month=6
app.get('/api/walkers/:id/appointments', async (req, res) => {
  const { id } = req.params;
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);

  if (!year || !month || month < 1 || month > 12)
    return res.status(400).json({ error: 'year y month son requeridos' });

  try {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

    const result = await pool.query(`
      SELECT a.*, b.name AS breed_name
      FROM appointments a
      LEFT JOIN breeds b ON b.id = a.breed_id
      WHERE a.walker_id = $1
        AND a.appointment_date >= $2::date
        AND a.appointment_date < $3::date
        AND a.status = 'scheduled'
      ORDER BY a.appointment_date, a.appointment_time
    `, [id, start, end]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/walkers — registra un paseador con sus capacidades
app.post('/api/walkers', async (req, res) => {
  const {
    name, experience_years, bio, max_dogs_per_walk,
    max_size, max_energy_level, handles_hyperactive, handles_special_needs,
    work_start_time, work_end_time, work_days
  } = req.body;

  if (!name || !max_size || !max_energy_level)
    return res.status(400).json({ error: 'name, max_size y max_energy_level son requeridos' });
  if (!work_start_time || !work_end_time)
    return res.status(400).json({ error: 'work_start_time y work_end_time son requeridos' });
  if (!Array.isArray(work_days) || work_days.length === 0)
    return res.status(400).json({ error: 'Selecciona al menos un día de trabajo' });
  if (timeToMinutes(work_start_time) >= timeToMinutes(work_end_time))
    return res.status(400).json({ error: 'La hora de inicio debe ser anterior a la de fin' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walkerResult = await client.query(
      `INSERT INTO walkers (name, experience_years, bio, max_dogs_per_walk, available,
                            work_start_time, work_end_time, work_days)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7) RETURNING *`,
      [name, experience_years || 0, bio || null, max_dogs_per_walk || 1,
       work_start_time, work_end_time, work_days]
    );
    const walker = walkerResult.rows[0];

    await client.query(
      `INSERT INTO walker_capabilities 
         (walker_id, max_size, max_energy_level, handles_hyperactive, handles_special_needs)
       VALUES ($1, $2, $3, $4, $5)`,
      [walker.id, max_size, max_energy_level, toBool(handles_hyperactive), toBool(handles_special_needs)]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ...walker, max_size, max_energy_level,
      handles_hyperactive, handles_special_needs
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CITAS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/appointments — agenda una cita
app.post('/api/appointments', async (req, res) => {
  const {
    walker_id, dog_name, breed_id, dog_age, is_hyperactive,
    special_needs, owner_name, appointment_date, appointment_time
  } = req.body;

  if (!walker_id || !dog_name || !appointment_date || !appointment_time)
    return res.status(400).json({ error: 'walker_id, dog_name, appointment_date y appointment_time son requeridos' });

  try {
    const walkerResult = await pool.query(
      'SELECT work_start_time, work_end_time, work_days FROM walkers WHERE id = $1',
      [walker_id]
    );
    if (walkerResult.rows.length === 0)
      return res.status(404).json({ error: 'Paseador no encontrado' });

    const walker = walkerResult.rows[0];
    const dateObj = new Date(appointment_date + 'T12:00:00');
    const isoDay = jsDayToIso(dateObj.getDay());

    if (!walker.work_days.includes(isoDay))
      return res.status(400).json({ error: 'El paseador no trabaja ese día' });

    const slotMin = timeToMinutes(appointment_time);
    const startMin = timeToMinutes(walker.work_start_time);
    const endMin = timeToMinutes(walker.work_end_time);
    if (slotMin < startMin || slotMin >= endMin)
      return res.status(400).json({ error: 'La hora está fuera del horario del paseador' });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dateObj < today)
      return res.status(400).json({ error: 'No puedes agendar en fechas pasadas' });

    const result = await pool.query(
      `INSERT INTO appointments
         (walker_id, dog_name, breed_id, dog_age, is_hyperactive, special_needs,
          owner_name, appointment_date, appointment_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        walker_id, dog_name.trim(), breed_id || null, dog_age ?? null,
        toBool(is_hyperactive), special_needs?.trim() || null,
        owner_name?.trim() || null, appointment_date, appointment_time
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Ese horario ya está ocupado' });
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback SPA ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`🐾 PawMatch corriendo en http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ El puerto ${PORT} ya está en uso. Cierra el otro proceso o cambia PORT en .env`);
    process.exit(1);
  }
  throw err;
});
