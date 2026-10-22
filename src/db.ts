import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { env } from './env.js';
import * as schema from './schema.js';

export const db = drizzle({ client: neon(env.DATABASE_URL), schema });
