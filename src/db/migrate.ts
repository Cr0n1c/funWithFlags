import { DatabaseManager } from './database';

async function main() {
  const dbManager = new DatabaseManager();
  try {
    await dbManager.initialize();
    await dbManager.runMigrations();
    // eslint-disable-next-line no-console
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error);
    process.exit(1);
  } finally {
    await dbManager.close();
  }
}

main(); 