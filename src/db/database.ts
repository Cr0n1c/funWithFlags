/* eslint-disable import/no-extraneous-dependencies */
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Migration file convention: use <number>_name.up.sql for applying, <number>_name.down.sql for rollback
// Example: 001_create_users.up.sql and 001_create_users.down.sql

export class DatabaseManager {
  private db: Database | null = null;

  private readonly dbPath: string;

  private readonly migrationsPath: string;

  constructor(dbPath: string = 'src/db/database.sqlite', migrationsPath: string = path.join(__dirname, 'migrations')) {
    this.dbPath = dbPath;
    this.migrationsPath = migrationsPath;
  }

  private calculateChecksum(filePath: string): string {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(fileContent).digest('hex');
  }

  async initialize(): Promise<void> {
    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database,
    });

    // eslint-disable-next-line no-console
    console.log('Connected to the SQLite database.');
  }

  async runMigrations(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Get all .up.sql migration files
    const migrationFiles = fs.readdirSync(this.migrationsPath)
      .filter(file => file.endsWith('.up.sql'))
      .sort();

    // Check if migrations table exists
    const tableExists = await this.db.get(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='migrations'
    `);

    // If migrations table doesn't exist, we'll run all migrations
    let executedMigrationMap = new Map();
    if (tableExists) {
      // Get executed migrations
      const executedMigrations = await this.db.all('SELECT name, checksum FROM migrations WHERE status = ?', ['success']);
      executedMigrationMap = new Map(executedMigrations.map(m => [m.name, m.checksum]));
    }

    // Run pending migrations
    for (const migrationFile of migrationFiles) {
      if (!executedMigrationMap.has(migrationFile)) {
        const migrationPath = path.join(this.migrationsPath, migrationFile);
        const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
        const checksum = this.calculateChecksum(migrationPath);
        const startTime = Date.now();

        await this.db.exec('BEGIN TRANSACTION');
        try {
          // Execute migration first
          await this.db.exec(migrationSQL);
          
          // Then record it in migrations table if it exists
          if (tableExists) {
            // Mark migration as pending
            await this.db.run(
              'INSERT INTO migrations (name, status, checksum) VALUES (?, ?, ?)',
              [migrationFile, 'pending', checksum],
            );

            // Update migration status to success
            const executionTime = Date.now() - startTime;
            await this.db.run(
              'UPDATE migrations SET status = ?, execution_time = ? WHERE name = ?',
              ['success', executionTime, migrationFile],
            );
          }

          await this.db.exec('COMMIT');
          // eslint-disable-next-line no-console
          console.log(`Executed migration: ${migrationFile} (${Date.now() - startTime}ms)`);
        } catch (error) {
          if (tableExists) {
            await this.db.run(
              'UPDATE migrations SET status = ?, error_message = ? WHERE name = ?',
              [
                'failed',
                error instanceof Error ? error.message : String(error),
                migrationFile,
              ],
            );
          }
          await this.db.exec('ROLLBACK');
          throw error;
        }
      } else {
        // Verify checksum of executed migration
        const storedChecksum = executedMigrationMap.get(migrationFile);
        const currentChecksum = this.calculateChecksum(
          path.join(this.migrationsPath, migrationFile),
        );
        
        if (storedChecksum !== currentChecksum) {
          throw new Error(
            `Migration ${migrationFile} has been modified since it was executed`,
          );
        }
      }
    }
  }

  async rollbackLastMigration(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Get the most recently executed migration
    const lastMigration = await this.db.get(
      'SELECT name FROM migrations WHERE status = ? ORDER BY executed_at DESC LIMIT 1',
      ['success'],
    );

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

    await this.db.exec('BEGIN TRANSACTION');
    try {
      await this.db.exec(downSQL);
      await this.db.run('DELETE FROM migrations WHERE name = ?', upFile);
      await this.db.exec('COMMIT');
      const executionTime = Date.now() - startTime;
      // eslint-disable-next-line no-console
      console.log(`Rolled back migration: ${upFile} (${executionTime}ms)`);
    } catch (error) {
      await this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
} 