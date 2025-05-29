/* eslint-disable import/no-extraneous-dependencies */
import sqlite3 from 'sqlite3';
import { Database } from 'sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);

// Migration file convention: use <number>_name.up.sql for applying, <number>_name.down.sql for rollback
// Example: 001_create_users.up.sql and 001_create_users.down.sql

export class DatabaseManager {
  private static instance: DatabaseManager;

  private db: Database | null = null;

  private readonly dbPath: string;

  private readonly migrationsPath: string;

  private constructor(dbPath: string = path.resolve(currentDirname, '../../db/database.sqlite'), migrationsPath: string = path.join(currentDirname, 'migrations')) {
    this.dbPath = dbPath;
    this.migrationsPath = migrationsPath;
  }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  private calculateChecksum(filePath: string): string {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(fileContent).digest('hex');
  }

  public async initialize(): Promise<Database> {
    if (!this.db) {
      this.db = new sqlite3.Database(this.dbPath);
    }
    return this.db;
  }

  public async getDb(): Promise<Database> {
    if (!this.db) {
      return this.initialize();
    }
    return this.db;
  }

  public async runMigrations(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Create migrations table if it doesn't exist
    await new Promise<void>((resolve, reject) => {
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status TEXT,
          error_message TEXT,
          execution_time INTEGER
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Get all migration files
    const files = fs.readdirSync(this.migrationsPath)
      .filter(f => f.endsWith('.up.sql'))
      .sort();

    // Get applied migrations
    const appliedMigrations = await new Promise<Array<{ name: string }>>((resolve, reject) => {
      this.db!.all<{ name: string }>('SELECT name FROM migrations', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    // Run new migrations
    for (const file of files) {
      if (!appliedMigrations.some((m) => m.name === file)) {
        // eslint-disable-next-line no-console
        console.log(`Running migration: ${file}`);
        const sql = fs.readFileSync(path.join(this.migrationsPath, file), 'utf8');
        await new Promise<void>((resolve, reject) => {
          this.db!.exec(sql, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        await new Promise<void>((resolve, reject) => {
          this.db!.run('INSERT INTO migrations (name, checksum) VALUES (?, ?)', [file, ''], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        // eslint-disable-next-line no-console
        console.log(`Completed migration: ${file}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log('All migrations completed successfully');
  }

  public async rollbackLastMigration(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Get the most recently executed migration
    const lastMigration = await new Promise<{ name: string } | undefined>((resolve, reject) => {
      this.db!.get<{ name: string }>(
        'SELECT name FROM migrations WHERE status = ? ORDER BY executed_at DESC LIMIT 1',
        ['success'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        },
      );
    });

    if (!lastMigration) {
      // eslint-disable-next-line no-console
      console.log('No migrations to rollback.');
      return;
    }

    const upFile = lastMigration.name;
    const downFile = upFile.replace('.up.sql', '.down.sql');
    const downPath = path.join(this.migrationsPath, downFile);

    if (!fs.existsSync(downPath)) {
      throw new Error(`No down migration found for ${upFile}`);
    }

    const downSQL = fs.readFileSync(downPath, 'utf8');
    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      this.db!.exec('BEGIN TRANSACTION', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.db!.exec(downSQL, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        this.db!.run('DELETE FROM migrations WHERE name = ?', [upFile], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        this.db!.exec('COMMIT', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const executionTime = Date.now() - startTime;
      // eslint-disable-next-line no-console
      console.log(`Rolled back migration: ${upFile} (${executionTime}ms)`);
    } catch (error) {
      await new Promise<void>((resolve, reject) => {
        this.db!.exec('ROLLBACK', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.db) {
      await new Promise<void>((resolve, reject) => {
        this.db!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.db = null;
    }
  }
}

export default DatabaseManager.getInstance(); 