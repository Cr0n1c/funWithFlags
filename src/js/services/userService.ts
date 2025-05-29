import { Database } from 'sqlite';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

interface User {
  id: number;
  username: string;
  email: string;
  created_at: string;
  updated_at: string;
  last_login: string | null;
  is_active: boolean;
  role: string;
}

class UserService {
  private db: Database | null = null;

  async initialize(): Promise<void> {
    this.db = await open({
      filename: 'src/db/database.sqlite',
      driver: sqlite3.Database,
    });
  }

  async createOrUpdateUser(email: string, username: string): Promise<User> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Check if user exists
    const existingUser = await this.db.get<User>(
      'SELECT * FROM users WHERE email = ?',
      [email],
    );

    if (existingUser) {
      // Update last login and username if changed
      await this.db.run(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP, username = ? WHERE email = ?',
        [username, email],
      );
      const updatedUser = await this.db.get<User>('SELECT * FROM users WHERE email = ?', [email]);
      if (!updatedUser) {
        throw new Error('Failed to retrieve updated user');
      }
      return updatedUser;
    }

    // Create new user
    await this.db.run(
      'INSERT INTO users (email, username, password_hash, role) VALUES (?, ?, ?, ?)',
      [email, username, 'okta_auth', 'user'],
    );

    const newUser = await this.db.get<User>('SELECT * FROM users WHERE email = ?', [email]);
    if (!newUser) {
      throw new Error('Failed to retrieve created user');
    }
    return newUser;
  }

  async logAuditEvent(userId: number, eventType: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    await this.db.run(
      'INSERT INTO audit_log (user_id, event_type) VALUES (?, ?)',
      [userId, eventType],
    );
  }
}

export const userService = new UserService(); 