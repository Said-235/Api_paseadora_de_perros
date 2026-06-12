-- Elimina la tabla dogs (ya no se usa; el matching solo consulta breeds + walkers).
-- Ejecutar en el SQL Editor de Neon o con: psql $DATABASE_URL -f scripts/drop-dogs-table.sql

DROP TABLE IF EXISTS dogs;
