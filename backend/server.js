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
// PERROS (modo básico: registro anónimo para buscar paseador)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/dogs — registra un perro
app.post('/api/dogs', async (req, res) => {
  const { name, breed_id, age, is_hyperactive, special_needs } = req.body;

  if (!name || !breed_id || age === undefined)
    return res.status(400).json({ error: 'name, breed_id y age son requeridos' });

  try {
    const result = await pool.query(
      `INSERT INTO dogs (name, breed_id, age, is_hyperactive, special_needs)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, breed_id, age, toBool(is_hyperactive), special_needs?.trim() || null]
    );
    res.status(201).json(result.rows[0]);
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

// POST /api/walkers — registra un paseador con sus capacidades
app.post('/api/walkers', async (req, res) => {
  const {
    name, experience_years, bio, max_dogs_per_walk,
    max_size, max_energy_level, handles_hyperactive, handles_special_needs
  } = req.body;

  if (!name || !max_size || !max_energy_level)
    return res.status(400).json({ error: 'name, max_size y max_energy_level son requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walkerResult = await client.query(
      `INSERT INTO walkers (name, experience_years, bio, max_dogs_per_walk, available)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
      [name, experience_years || 0, bio || null, max_dogs_per_walk || 1]
    );
    const walker = walkerResult.rows[0];

    await client.query(
      `INSERT INTO walker_capabilities 
         (walker_id, max_size, max_energy_level, handles_hyperactive, handles_special_needs)
       VALUES ($1, $2, $3, $4, $5)`,
      [walker.id, max_size, max_energy_level, toBool(handles_hyperactive), toBool(handles_special_needs)]
    );

    await client.query('COMMIT');
    res.status(201).json({ ...walker, max_size, max_energy_level, handles_hyperactive, handles_special_needs });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
