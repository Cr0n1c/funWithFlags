import { DatabaseManager } from './database';

async function main() {
  const dbManager = new DatabaseManager();
  try {
    await dbManager.initialize();
    await dbManager.rollbackLastMigration();
    // eslint-disable-next-line no-console
    console.log('Rollback completed successfully');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error rolling back migration:', error);
    process.exit(1);
  } finally {
    await dbManager.close();
  }
}

main(); 